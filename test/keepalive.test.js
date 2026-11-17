import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  openLedger, createTask, getTask, setTaskGoalState, transition, bumpKeepAliveRound, recentMessages,
} from '../src/ledger.js'
import {
  createKeepAlive, keepAliveSkipReason, keepAliveText, hasPendingInput,
  KEEPALIVE_SOURCE, DEFAULT_KEEPALIVE_PROMPT,
} from '../src/keepalive.js'
import { loadConfig } from '../src/config.js'
import { createSettlementReporter } from '../src/settlement.js'
import { tempDir, sampleBrief, markDone } from './helpers.js'

const ACTIVE_GOAL = {
  id: 'goal-1', revision: 1, objective: '完成目标', phase: 'active', activation: 'disarmed',
  roundsStarted: 0, maxGoalRounds: 256, updatedAt: 1,
}

const runningTask = async (db, { goalState = ACTIVE_GOAL, rounds = 0, readOnly = false } = {}) => {
  const task = createTask(db, {
    brief: sampleBrief({ title: '目标任务', goal: '完成目标' }),
    coordinatorSession: 's-1',
    readOnly,
  })
  transition(db, task.id, 'running', { sessionId: 'c-1', target: 'c-1' })
  if (goalState !== null) setTaskGoalState(db, task.id, goalState)
  if (rounds > 0) db.prepare('UPDATE tasks SET keep_alive_rounds = ? WHERE id = ?').run(rounds, task.id)
  return getTask(db, task.id)
}

function setup({ rounds = 0, config = {}, agentStatus = 'running', inbox } = {}) {
  const dbP = openLedger(tempDir())
  return dbP.then(db => {
    const injected = []
    const agent = {
      id: 'c-1',
      session: { id: 'c-1' },
      status: agentStatus,
      inbox: inbox ?? { nextStep: [], nextTurn: [] },
      steer(message) { injected.push(['steer', message]) },
      followup(message) { injected.push(['followup', message]) },
    }
    const logs = []
    const events = []
    const ka = createKeepAlive({
      db,
      config: loadConfig(config),
      logger: { log: (event, fields) => { logs.push([event, fields]); events.push({ event, ...fields }) } },
      newId: () => 'msg-keepalive',
    })
    return { db, agent, injected, logs, events, ka }
  })
}

const event = (agent, overrides = {}) => ({ agent, turn: 1, signal: { aborted: false }, ...overrides })

test('K2 默认关闭：不开 keepAlive 时完全不碰台账、不注入', async () => {
  const config = loadConfig({})
  assert.equal(config.keepAlive, false)
  assert.equal(config.keepAliveMode, 'steer')
  assert.equal(config.keepAliveMaxRounds, 8)
  assert.equal(config.keepAlivePrompt, '')
  // 连 db 都不给也能安全 no-op：证明默认路径在查询前就返回了。
  const ka = createKeepAlive({ db: undefined, config, logger: { log() {} } })
  const agent = { id: 'c-1', status: 'running', session: { id: 'c-1' }, steer() {}, followup() {} }
  assert.equal(ka.handle(event(agent)), null)
  assert.equal(keepAliveSkipReason({ enabled: false }), 'disabled')
})

test('K2 开启后 steer 默认：注入一条 user 消息，轮数落台账，source 带 taskId/round', async () => {
  const { db, ka, agent, injected, events } = await setup({ config: { keepAlive: true } })
  const task = await runningTask(db)
  const round = ka.handle(event(agent))
  assert.equal(round, 1)
  assert.equal(injected.length, 1)
  const [mode, message] = injected[0]
  assert.equal(mode, 'steer')
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, KEEPALIVE_SOURCE)
  assert.equal(message.source.taskId, task.id)
  assert.equal(message.source.round, 1)
  assert.match(message.content[0].text, /第 1\/8 轮/)
  assert.match(message.content[0].text, /接着推进同一个目标/)
  assert.equal(getTask(db, task.id).keep_alive_rounds, 1)
  const injectedEvent = events.find(item => item.event === 'task.keepalive.injected')
  assert.equal(injectedEvent.detail.round, 1)
  assert.equal(injectedEvent.detail.mode, 'steer')
  // 审计消息用独立 kind：不写 kind='followup'，避免和面板「同文去重」互相误判。
  const kinds = recentMessages(db, task.id, 5).map(row => row.kind)
  assert.deepEqual(kinds, ['keepalive'])
  db.close()
})

test('K2 followup 模式：注入走 agent.followup，文本带轮次上限', async () => {
  const { db, ka, agent, injected } = await setup({ config: { keepAlive: true, keepAliveMode: 'followup', keepAliveMaxRounds: 2 } })
  await runningTask(db)
  assert.equal(ka.handle(event(agent)), 1)
  assert.equal(injected[0][0], 'followup')
  assert.match(injected[0][1].content[0].text, /第 1\/2 轮/)
  db.close()
})

test('K2 轮数上限：maxRounds=2 时只注入 2 次，第 3 次停止并只记一次 stopped 日志', async () => {
  const { db, ka, agent, injected, events } = await setup({ config: { keepAlive: true, keepAliveMaxRounds: 2 } })
  const task = await runningTask(db)
  assert.equal(ka.handle(event(agent)), 1)
  assert.equal(ka.handle(event(agent)), 2)
  assert.equal(ka.handle(event(agent)), null)
  assert.equal(ka.handle(event(agent)), null)
  assert.equal(injected.length, 2)
  assert.equal(getTask(db, task.id).keep_alive_rounds, 2)
  const stopped = events.filter(item => item.event === 'task.keepalive.stopped')
  assert.equal(stopped.length, 1)
  assert.equal(stopped[0].detail.reason, 'rounds-exhausted')
  db.close()
})

test('K2 goal 完成/缺失/非 running/只读/中断/inbox 有排队 都不注入', async () => {
  // goal 已收口（complete / cleared）
  for (const phase of ['complete', 'cleared']) {
    const s = await setup({ config: { keepAlive: true } })
    const task = await runningTask(s.db, { goalState: { ...ACTIVE_GOAL, phase } })
    assert.equal(s.ka.handle(event(s.agent)), null, `phase=${phase}`)
    assert.equal(s.injected.length, 0)
    assert.equal(getTask(s.db, task.id).keep_alive_rounds, 0)
    assert.ok(s.events.some(item => item.event === 'task.keepalive.stopped' && item.detail.reason === 'goal-finished'))
    s.db.close()
  }
  // 没有平台 goal：没人能判定「目标完成」，不续跑
  {
    const s = await setup({ goalState: null, config: { keepAlive: true } })
    await runningTask(s.db, { goalState: null })
    assert.equal(s.ka.handle(event(s.agent)), null)
    assert.ok(s.events.some(item => item.event === 'task.keepalive.stopped' && item.detail.reason === 'no-goal'))
    s.db.close()
  }
  // 任务已被 S1 推到终态：一律不再注入
  for (const status of ['done', 'orphaned', 'cancelled', 'waiting_user']) {
    const s = await setup({ config: { keepAlive: true } })
    const task = await runningTask(s.db)
    if (status === 'done') markDone(s.db, task.id)
    else transition(s.db, task.id, status)
    assert.equal(s.ka.handle(event(s.agent)), null, `status=${status}`)
    assert.equal(s.injected.length, 0)
    s.db.close()
  }
  // 只读任务
  {
    const s = await setup({ config: { keepAlive: true } })
    await runningTask(s.db, { readOnly: true })
    assert.equal(s.ka.handle(event(s.agent)), null)
    assert.equal(s.injected.length, 0)
    s.db.close()
  }
  // 回合已被中断（stop）：signal.aborted
  {
    const s = await setup({ config: { keepAlive: true } })
    await runningTask(s.db)
    assert.equal(s.ka.handle(event(s.agent, { signal: { aborted: true } })), null)
    assert.equal(s.injected.length, 0)
    s.db.close()
  }
  // agent 已不在 running（idle 由平台自己收尾）
  {
    const s = await setup({ config: { keepAlive: true }, agentStatus: 'idle' })
    await runningTask(s.db)
    assert.equal(s.ka.handle(event(s.agent)), null)
    assert.equal(s.injected.length, 0)
    s.db.close()
  }
  // inbox 里已经有人排了下一轮：不重复投递
  {
    for (const inbox of [{ nextStep: [{}], nextTurn: [] }, { nextStep: [], nextTurn: [{}] }, { hasPending: true }, [{}]]) {
      const s = await setup({ config: { keepAlive: true }, inbox })
      await runningTask(s.db)
      assert.equal(s.ka.handle(event(s.agent)), null, JSON.stringify(inbox))
      assert.equal(s.injected.length, 0)
      s.db.close()
    }
  }
})

test('K2 异常停止：注入抛错时监听器不抛、轮数已消耗、只记 failed 日志', async () => {
  const { db, ka, agent, events } = await setup({ config: { keepAlive: true } })
  const task = await runningTask(db)
  agent.steer = () => { throw new Error('inbox closed') }
  assert.doesNotThrow(() => ka.handle(event(agent)))
  assert.equal(ka.handle(event(agent)), null)
  const failed = events.filter(item => item.event === 'task.keepalive.failed')
  assert.equal(failed.length, 2)
  assert.equal(failed[0].detail.hook, 'inject')
  assert.match(failed[0].detail.error, /inbox closed/)
  // 预算先落库：注入失败也算掉一轮，不会变成无限重试。
  assert.equal(getTask(db, task.id).keep_alive_rounds, 2)
  db.close()
})

test('K2 台账查不到/读失败：静默跳过，不抛', async () => {
  const { db, ka, agent } = await setup({ config: { keepAlive: true } })
  assert.equal(ka.handle(event(agent)), null)
  const logs = []
  const broken = createKeepAlive({
    db: { prepare() { throw new Error('db closed') } },
    config: loadConfig({ keepAlive: true }),
    logger: { log: (name, fields) => logs.push([name, fields]) },
  })
  assert.doesNotThrow(() => broken.handle(event(agent)))
  assert.equal(broken.handle(event(agent)), null)
  assert.equal(logs.at(-1)[0], 'task.keepalive.failed')
  assert.equal(logs.at(-1)[1].detail.hook, 'lookup')
  db.close()
})

test('K2 start 订阅 agent/turn-stopping 并返回 disposer；监听器内部抛错也吞掉', async () => {
  const { db, ka, agent, injected } = await setup({ config: { keepAlive: true } })
  await runningTask(db)
  const handlers = []
  let disposed = 0
  const ctx = { on: (name, handler) => { handlers.push([name, handler]); return () => { disposed += 1 } } }
  const dispose = ka.start(ctx)
  assert.equal(handlers.length, 1)
  assert.equal(handlers[0][0], 'agent/turn-stopping')
  handlers[0][1](event(agent))
  assert.equal(injected.length, 1)
  // 事件里 agent 为 undefined：不抛。
  assert.doesNotThrow(() => handlers[0][1](undefined))
  dispose()
  assert.equal(disposed, 1)
  db.close()
  // 没有 ctx.on 时返回 no-op disposer（profile 裁剪也不炸）。
  const noCtx = createKeepAlive({ db, config: loadConfig({ keepAlive: true }) })
  const noop = noCtx.start({})
  assert.equal(typeof noop, 'function')
  assert.doesNotThrow(noop)
})

test('K2 纯函数：keepAliveSkipReason / hasPendingInput / keepAliveText', () => {
  const running = { id: 't-1', status: 'running', goal_state: ACTIVE_GOAL }
  const base = { enabled: true, agentStatus: 'running', task: running, goalState: ACTIVE_GOAL, rounds: 0, maxRounds: 8 }
  assert.equal(keepAliveSkipReason(base), null)
  assert.equal(keepAliveSkipReason({ ...base, signalAborted: true }), 'aborted')
  assert.equal(keepAliveSkipReason({ ...base, agentStatus: 'idle' }), 'agent-not-running')
  assert.equal(keepAliveSkipReason({ ...base, task: undefined }), 'no-task')
  assert.equal(keepAliveSkipReason({ ...base, task: { ...running, status: 'orphaned' } }), 'task-not-running')
  assert.equal(keepAliveSkipReason({ ...base, task: { ...running, read_only: true } }), 'read-only')
  assert.equal(keepAliveSkipReason({ ...base, inbox: { nextStep: [{}], nextTurn: [] } }), 'inbox-pending')
  assert.equal(keepAliveSkipReason({ ...base, goalState: null }), 'no-goal')
  assert.equal(keepAliveSkipReason({ ...base, goalState: { phase: 'complete' } }), 'goal-finished')
  assert.equal(keepAliveSkipReason({ ...base, rounds: 8 }), 'rounds-exhausted')
  assert.equal(keepAliveSkipReason({ ...base, rounds: 7 }), null)
  assert.equal(keepAliveSkipReason({ ...base, maxRounds: undefined }), 'rounds-exhausted')

  assert.equal(hasPendingInput(undefined), false)
  assert.equal(hasPendingInput({ nextStep: [], nextTurn: [] }), false)
  assert.equal(hasPendingInput({ nextStep: [{}], nextTurn: [] }), true)
  assert.equal(hasPendingInput({ nextStep: [], nextTurn: [{}] }), true)
  assert.equal(hasPendingInput({ hasPending: false }), false)
  assert.equal(hasPendingInput([{}]), true)

  assert.equal(keepAliveText({}, { round: 3, maxRounds: 8 }), `（keep-alive 第 3/8 轮）${DEFAULT_KEEPALIVE_PROMPT}`)
  assert.equal(keepAliveText({}, { round: 3, maxRounds: 8, prompt: '  继续  ' }), '（keep-alive 第 3/8 轮）继续')
})

test('K2 台账：bumpKeepAliveRound 原子加轮、超上限返回 null、进入 running 归零', async () => {
  const db = await openLedger(tempDir())
  const task = await runningTask(db)
  assert.equal(bumpKeepAliveRound(db, task.id, 2), 1)
  assert.equal(bumpKeepAliveRound(db, task.id, 2), 2)
  assert.equal(bumpKeepAliveRound(db, task.id, 2), null)
  assert.equal(getTask(db, task.id).keep_alive_rounds, 2)
  // 非 running 不消耗预算
  const other = createTask(db, { brief: sampleBrief({ title: '待派发', goal: 'g' }), coordinatorSession: 's-1' })
  assert.equal(bumpKeepAliveRound(db, other.id, 8), null)
  // 重新进入 running（续派/冷恢复）预算归零。
  // 走 waiting_user → running（合法的续派路径）：orphaned → pending 这条边已删（审计 §2.3.3，
  // 会话丢失的出口是重派新建任务，不是原任务复活）。
  transition(db, task.id, 'waiting_user')
  transition(db, task.id, 'running', { sessionId: 'c-1', target: 'c-1' })
  assert.equal(getTask(db, task.id).keep_alive_rounds, 0)
  db.close()
})

test('K2 旧库自动补 keep_alive_rounds 列，历史行按 0 轮', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-ledger-ka-'))
  const { DatabaseSync } = await import('node:sqlite')
  const legacy = new DatabaseSync(join(dir, 'tasks.sqlite'))
  legacy.exec(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, goal TEXT NOT NULL, brief_json TEXT NOT NULL,
    status TEXT NOT NULL, session_id TEXT, target TEXT, coordinator_session TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    last_event_at INTEGER NOT NULL, error TEXT, queued_at INTEGER)`)
  legacy.prepare(`INSERT INTO tasks (id, title, goal, brief_json, status, coordinator_session, created_at, updated_at, last_event_at)
    VALUES ('t-old', '旧任务', 'g', '{}', 'running', 's-1', 1, 1, 1)`).run()
  legacy.close()
  const db = await openLedger(dir)
  assert.ok(db.prepare('PRAGMA table_info(tasks)').all().map(row => row.name).includes('keep_alive_rounds'))
  assert.equal(getTask(db, 't-old').keep_alive_rounds, 0)
  assert.equal(bumpKeepAliveRound(db, 't-old', 8), 1)
  db.close()
})

test('K2 与 S1：keep-alive 不写终态，结算仍只走 S1 一次；结算后不再误续跑', async () => {
  const { db, ka, agent } = await setup({ config: { keepAlive: true } })
  const task = await runningTask(db)
  const reporter = createSettlementReporter({ db, notifier: { push() {} }, logger: { log() {} } })
  // 续一轮：台账状态/进度都不动，只有轮数与审计消息。
  assert.equal(ka.handle(event(agent)), 1)
  const afterInject = getTask(db, task.id)
  assert.equal(afterInject.status, 'running')
  assert.equal(afterInject.progress_count, 0)
  // 真正的子会话结束才由 S1 结算（completed + 没上报过 progress → 已交付待确认）。
  const outcome = reporter.report({ sessionId: 'c-1', stopReason: 'completed' })
  assert.equal(outcome.action, 'updated')
  assert.equal(outcome.to, 'delivered')
  assert.equal(getTask(db, task.id).status, 'delivered')
  // 重复到达的结算事件（派发侧 + 平台生命周期）只结算一次，消息也只有一条。
  const again = reporter.report({ sessionId: 'c-1', stopReason: 'completed', source: 'lifecycle' })
  assert.equal(again.action, 'skipped')
  assert.equal(again.reason, 'not-running')
  const settleMessages = recentMessages(db, task.id, 10).filter(row => row.kind === 'settle')
  assert.equal(settleMessages.length, 1)
  // S1 结算之后同一会话再来 turn-stopping：不注入（不把已结束任务重新拉起来）。
  assert.equal(ka.handle(event(agent)), null)
  assert.equal(getTask(db, task.id).keep_alive_rounds, 1)
  assert.equal(reporter.mapSettle('completed', { progressCount: 0 }).status, 'delivered')
  db.close()
})
