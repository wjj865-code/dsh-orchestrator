// src/main-context.js 的单测：观测 + 压力提醒（0.25.0 唯一的提醒出口）。
//
// 重点守两条真机踩过的坑：
//   1. `ask()` 必须带**主会话自己的 live agent**——不带就落到宿主全局 waterfall，
//      浏览器 answerer 拿不到会话作用域直接 next()，宿主回 NO_PROVIDER，卡片永远不弹；
//   2. agent 缺失 / 属于别的主会话时**不能瞎用**（退回全局 + warn 一次），以免把卡片
//      路由到旧会话的作用域上。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openLedger, getSetting } from '../src/ledger.js'
import {
  ALERT_OPTION_CONTINUE, ALERT_OPTION_CREATE, ALERT_OPTION_LATER, DEFERRED_TASK_STATUSES, MAIN_CONTEXT_ALERT_KEY,
  createContextObserver, decideAlert, readAlertState, readContextPressure,
} from '../src/main-context.js'

const ledger = () => openLedger(mkdtempSync(join(tmpdir(), 'orch-context-')))

/** 造一个存活会话 + agent（宿主真实形状：agent.session.header.id）。 */
const liveSession = (id, { pressureTokens = 8000, contextWindow = 16000 } = {}) => {
  const session = { id, header: { id, cwd: 'C:/ws' } }
  return {
    agent: { id: `agent-${id}`, session },
    session,
    tokenMeter: { contextPressure: () => ({ pressureTokens, contextWindow }) },
  }
}

const baseDeps = ({ db, agent, session, tokenMeter, ask, log, onWarn, requestNewCoordinator, activeTasks }) => ({
  db,
  config: { contextPressureThreshold: 0.4 },
  tokenMeter,
  persistence: { locate: () => ({ path: 'C:/log/session.jsonl.zstd' }) },
  statFile: async () => ({ size: 1024, mtimeMs: 0 }),
  sessionQuery: { observeSession: async () => ({ events: [], [Symbol.dispose]: () => {} }) },
  agentPresets: { serviceFor: () => undefined },
  sessions: { get: () => session },
  userQuestions: { ask },
  requestNewCoordinator,
  activeTasks,
  log: log ?? (() => {}),
  onWarn,
})

const answerWith = (label, askLog) => async request => {
  askLog.push(request)
  return { answers: [{ id: 'main-context-pressure', selected: [label] }] }
}

test('readContextPressure：压力 = prompt token / 窗口，缺服务时降级不抛', () => {
  const { session, tokenMeter } = liveSession('s-1')
  assert.deepEqual(readContextPressure({ session, tokenMeter }), {
    pressureTokens: 8000, contextWindow: 16000, ratio: 0.5, degraded: [],
  })
  const missing = readContextPressure({ session })
  assert.equal(missing.ratio, null)
  assert.deepEqual(missing.degraded, ['token-meter-missing'])
})

test('decideAlert：低于阈值不问、同 band 只问一次、下一档再问、回落到阈值−0.05 才重新武装', () => {
  assert.equal(decideAlert({ ratio: 0.3, threshold: 0.4, previous: null }).action, 'skip')
  assert.equal(decideAlert({ ratio: 0.42, threshold: 0.4, previous: null }).action, 'ask')
  const asked = { at: 1, ratio: 0.42, band: 4, state: 'asked' }
  assert.equal(decideAlert({ ratio: 0.42, threshold: 0.4, previous: asked }).action, 'skip')
  const nextBand = decideAlert({ ratio: 0.52, threshold: 0.4, previous: asked })
  assert.equal(nextBand.action, 'ask')
  assert.equal(nextBand.band, 5)
  assert.equal(decideAlert({ ratio: 0.2, threshold: 0.4, previous: asked }).action, 'clear')
})

test('提醒带 agent：ask 收到主会话的 live agent（真机 NO_PROVIDER 的根因修复）', async () => {
  const db = await ledger()
  const { agent, session, tokenMeter } = liveSession('s-main')
  const asks = []
  const events = []
  const observer = createContextObserver(baseDeps({
    db, agent, session, tokenMeter,
    ask: answerWith(ALERT_OPTION_CONTINUE, asks),
    log: (event, fields) => events.push({ event, fields }),
  }))
  await observer.observeAndRemind({ mainSessionId: 's-main', liveAgent: agent })

  assert.equal(asks.length, 1, '到阈值应提问一次')
  assert.equal(asks[0].agent, agent, 'ask 必须带主会话的 live agent（否则宿主走全局 waterfall → NO_PROVIDER）')
  assert.equal(asks[0].questions.length, 1)
  assert.deepEqual(asks[0].questions[0].options.map(option => option.label),
    [ALERT_OPTION_CREATE, ALERT_OPTION_CONTINUE, ALERT_OPTION_LATER])

  const asked = events.find(item => item.event === 'main.context.alert.asked')
  assert.equal(asked.fields.detail.hasAgent, true, '审计里要能看出这次是否带上了 agent')
  assert.equal(asked.fields.detail.agentId, 's-main', 'agentId 取 agent 所属会话 id（排查时能对上会话）')
  assert.equal(readAlertState(db).state, 'declined', '选「继续当前会话」= 本 band 不再问')
  db.close()
})

test('提醒降级：拿不到 live agent 时退回全局 ask + warn 一次，不拿旧主会话的 agent 串台', async () => {
  const dbOld = await ledger()
  const first = liveSession('s-old')
  const warnings = []
  const asks = []
  const observerOld = createContextObserver(baseDeps({
    db: dbOld,
    agent: first.agent,
    session: first.session,
    tokenMeter: first.tokenMeter,
    ask: answerWith(ALERT_OPTION_LATER, asks),
    onWarn: message => warnings.push(message),
  }))
  await observerOld.observeAndRemind({ mainSessionId: 's-old', liveAgent: first.agent })
  assert.equal(asks.length, 1)
  assert.equal(asks[0].agent, first.agent)
  dbOld.close()

  // 降级路径：调用方拿着「已知压力」的观测来提醒，但这个 observer 从没见过 live agent
  // （真实场景：新建主会话时 agent 还没起；压力来自上一段观测缓存 / 未来的其它调用方）。
  const dbNew = await ledger()
  const fresh = liveSession('s-new')
  const events = []
  const observerNew = createContextObserver(baseDeps({
    db: dbNew,
    agent: undefined,
    session: undefined,
    tokenMeter: fresh.tokenMeter,
    ask: answerWith(ALERT_OPTION_CONTINUE, asks),
    log: (event, fields) => events.push({ event, fields }),
    onWarn: message => warnings.push(message),
  }))
  const synthetic = { sessionId: 's-new', pressure: { pressureTokens: 8000, contextWindow: 16000, ratio: 0.5, threshold: 0.4 } }
  await observerNew.remind({ observation: synthetic, mainSessionId: 's-new' })

  const last = asks[asks.length - 1]
  assert.equal(Object.hasOwn(last, 'agent'), false, '拿不到 agent 时不能带 agent（宁可全局，也不串到别的会话）')
  assert.equal(warnings.some(message => message.includes('拿不到主会话的存活 agent')), true, '要 warn 一次说明卡片可能不出现')

  // 同一段压力只 warn 一次
  const before = warnings.length
  await observerNew.remind({ observation: synthetic, mainSessionId: 's-new' })
  assert.equal(warnings.length, before)

  const askedEvents = events.filter(item => item.event === 'main.context.alert.asked')
  assert.equal(askedEvents.length, 1, '只问一次')
  assert.equal(askedEvents[0].fields.detail.hasAgent, false)
  assert.equal(askedEvents[0].fields.detail.agentId, null)
  dbNew.close()
})

test('NO_PROVIDER：记审计 + 状态置 unavailable，不影响后续（不抛）', async () => {
  const db = await ledger()
  const { agent, session, tokenMeter } = liveSession('s-main')
  const events = []
  const observer = createContextObserver(baseDeps({
    db, agent, session, tokenMeter,
    ask: async () => { const error = new Error('no user-questions answerer accepted the request'); error.code = 'NO_PROVIDER'; throw error },
    log: (event, fields) => events.push({ event, fields }),
  }))
  const observation = await observer.observeAndRemind({ mainSessionId: 's-main', liveAgent: agent })
  assert.equal(observation.sessionId, 's-main')
  const noProvider = events.find(item => item.event === 'main.context.alert.no-provider')
  assert.ok(noProvider !== undefined, '要留 NO_PROVIDER 审计（真机排查靠它）')
  assert.equal(noProvider.fields.detail.hasAgent, true)
  assert.equal(readAlertState(db).state, 'unavailable')
  assert.equal((getSetting(db, MAIN_CONTEXT_ALERT_KEY) ?? '').includes('unavailable'), true)
  db.close()
})

test('提醒出口：选「新建协调者会话」才代建并清 alert；「稍后再说」置 snoozed', async () => {
  const db = await ledger()
  const { agent, session, tokenMeter } = liveSession('s-main')
  const created = []
  const asks = []
  const observer = createContextObserver(baseDeps({
    db, agent, session, tokenMeter,
    ask: answerWith(ALERT_OPTION_CREATE, asks),
    requestNewCoordinator: async payload => { created.push(payload); return { ok: true, sessionId: 's-new-main' } },
  }))
  await observer.observeAndRemind({ mainSessionId: 's-main', liveAgent: agent })
  assert.deepEqual(created.map(item => item.sessionId), ['s-main'], '代建要告诉实现是哪个旧会话触发的')
  assert.equal(readAlertState(db), null, '代建成功要清 alert（否则同一段压力不再问）')
  db.close()

  const db2 = await ledger()
  const second = liveSession('s-main-2')
  const asks2 = []
  const observer2 = createContextObserver(baseDeps({
    db: db2, agent: second.agent, session: second.session, tokenMeter: second.tokenMeter,
    ask: answerWith(ALERT_OPTION_LATER, asks2),
  }))
  await observer2.observeAndRemind({ mainSessionId: 's-main-2', liveAgent: second.agent })
  assert.equal(readAlertState(db2).state, 'snoozed')
  db2.close()
})

// t-a79e12d8：有非终态任务时不弹「切换主会话」问题卡（用户原话：有运行中任务时依然会询问）。
test('decideAlert：有非终态任务 → defer（不占 band）；delivered 不算运行中', () => {
  assert.deepEqual(DEFERRED_TASK_STATUSES, ['waiting_dep', 'pending', 'running', 'waiting_user', 'waiting_auth'],
    'delivered（已交付待确认）不算运行中：子会话已结束，换主会话不会丢回报')
  const deferred = decideAlert({ ratio: 0.42, threshold: 0.4, previous: null, activeTasks: [{ id: 't-run', status: 'running' }] })
  assert.equal(deferred.action, 'defer')
  assert.equal(deferred.reason, 'tasks-active')
  assert.equal(deferred.band, 4)
  assert.deepEqual(deferred.taskIds, ['t-run'])
  // 也接受裸 id（方便调用方只查 id）；delivered 行不触发延后。
  assert.equal(decideAlert({ ratio: 0.42, threshold: 0.4, previous: null, activeTasks: ['t-1'] }).action, 'defer')
  assert.equal(decideAlert({ ratio: 0.42, threshold: 0.4, previous: null, activeTasks: [{ id: 't-d', status: 'delivered' }] }).action, 'ask')
  // 压力没到阈值 / 已问过同 band 时，有任务也不会变成 defer（不打断既有语义）。
  assert.equal(decideAlert({ ratio: 0.3, threshold: 0.4, previous: null, activeTasks: ['t-1'] }).action, 'skip')
  assert.equal(decideAlert({
    ratio: 0.42, threshold: 0.4, previous: { band: 4, state: 'asked' }, activeTasks: ['t-1'],
  }).action, 'skip')
})

test('提醒延后：有运行中任务时不弹卡、不写 asked/不占 band，收尾后同一 band 再问', async () => {
  const db = await ledger()
  const { agent, session, tokenMeter } = liveSession('s-main')
  const asks = []
  const events = []
  let activeTasks = [{ id: 't-running', status: 'running' }]
  const observer = createContextObserver(baseDeps({
    db, agent, session, tokenMeter,
    ask: answerWith(ALERT_OPTION_CONTINUE, asks),
    activeTasks: () => activeTasks,
    log: (event, fields) => events.push({ event, fields }),
  }))
  const deferredEvents = () => events.filter(item => item.event === 'main.context.alert.deferred')

  await observer.observeAndRemind({ mainSessionId: 's-main', liveAgent: agent })
  assert.equal(asks.length, 0, '有任务在跑就不该弹问题卡')
  assert.equal(deferredEvents().length, 1, '要留 main.context.alert.deferred 审计')
  assert.equal(deferredEvents()[0].fields.detail.reason, 'tasks-active')
  assert.deepEqual(deferredEvents()[0].fields.detail.taskIds, ['t-running'])
  assert.equal(deferredEvents()[0].fields.detail.band, 5, '压力 0.5 → band 5（只用于审计，不写进 settings）')
  assert.equal(getSetting(db, MAIN_CONTEXT_ALERT_KEY), undefined, '不写 asked、不占 band（否则收尾后不会再问）')
  assert.equal(observer.snapshot().alert.decision, 'defer', 'snapshot 如实给出 defer 判定')

  // 同一批任务、同一段压力再打开：不重复记审计（也不弹）。
  await observer.observeAndRemind({ mainSessionId: 's-main', liveAgent: agent })
  assert.equal(asks.length, 0)
  assert.equal(deferredEvents().length, 1, '同一 band + 同一批任务只记一条 deferred')

  // 任务收尾 → 下一次打开主会话，同一 band 也会再问（这就是不占 band 的意义）。
  activeTasks = []
  await observer.observeAndRemind({ mainSessionId: 's-main', liveAgent: agent })
  assert.equal(asks.length, 1)
  assert.equal(readAlertState(db).state, 'declined')
  db.close()
})

test('提醒延后：只有 delivered（已交付待确认）时照常问', async () => {
  const db = await ledger()
  const { agent, session, tokenMeter } = liveSession('s-main')
  const asks = []
  const observer = createContextObserver(baseDeps({
    db, agent, session, tokenMeter,
    ask: answerWith(ALERT_OPTION_CONTINUE, asks),
    activeTasks: () => [{ id: 't-delivered', status: 'delivered' }],
  }))
  await observer.observeAndRemind({ mainSessionId: 's-main', liveAgent: agent })
  assert.equal(asks.length, 1, 'delivered 不算运行中：照常问')
  db.close()
})

