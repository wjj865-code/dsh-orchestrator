// 链式自动放行（`task_create({ chain: 'auto' })`，用户 2026-11-23 拍板的名字）。
//
// 语义只有一条：**带标记的任务交付（落 delivered）时，若台账里还有 waiting_dep 的下游依赖它，
// 就复用 closeDelivered 收成 done**（accepted_by='chain'、accepted_kind='delivery'、close_reason='chain'），
// 下游由 queue.pump 开头的 promoteDependents 自动晋升。没有下游 / 不带标记 → 一个字节都不变（仍等确认）。
//
// 这组用例锁五件事：
//   1. 参数面：只认显式 'auto'（非法值可读拒绝）、标记只进 brief 快照（不加 DB 列、不迁移）；
//   2. 门控：无标记 / 非 delivered / 无下游 / 下游非 waiting_dep 都不放行；
//   3. 两条交付路径（task_report 的 done 分支、settlement 的 completed 分支）都走同一个钩子；
//   4. 默认不变：不带标记的链、带标记但无下游的链都停在「已交付待确认」；
//   5. 幂等与互斥：重复 done / 迟到结算 / 面板确认都不重复 close，超时 sweeper 不会二次 close。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createTask, getTask, listTasks, openLedger, recentMessages, transition } from '../src/ledger.js'
import { createTools } from '../src/tools.js'
import { createQueue } from '../src/queue.js'
import { createSettlementReporter } from '../src/settlement.js'
import {
  CHAIN_AUTO, CLOSE_REASONS, autoCloseChainDelivered, chainAutoGate, closeDelivered, createDeliveredSweeper,
} from '../src/delivered.js'
import { listWaitingDependents, promoteDependents } from '../src/deps.js'
import { ACCEPTED_BY, acceptedByLabel, setHandoffSink } from '../src/handoff.js'
import { shouldReverseConfirm } from '../src/team-board.js'
import { CHAIN_AUTO_TOOL_DESC } from '../src/copy.js'
import { sampleBrief, tempDir, endReportedTurn } from './helpers.js'

function fakeDispatcher() {
  let counter = 0
  const calls = []
  return {
    freezeWork() { return { ok: true } },
    calls,
    slug: title => `task-${counter += 1}-${title}`,
    async spawn({ prompt }) {
      calls.push(['spawn', prompt])
      counter += 1
      const id = `s-${counter}`
      return { id, sessionId: id, target: id }
    },
    async send() {},
    async sendReliable() { return { messageId: 'm-1' } },
    async stop() {},
    releaseWritableRoots(target) { calls.push(['release', target]) },
  }
}

const setup = async () => {
  const db = await openLedger(tempDir())
  const dispatcher = fakeDispatcher()
  const pushed = []
  const logs = []
  const config = { staleMinutes: 30, maxQueue: 50, coordinatorSession: 's-1', sameDirGuard: 'off' }
  const queue = createQueue({ db, dispatcher, config })
  const tools = Object.fromEntries(createTools({
    db,
    dispatcher,
    queue,
    notifier: { push: item => pushed.push(item) },
    config,
    defaultCwd: tempDir(),
    coordinatorStatus: () => ({ id: 's-1', live: true }),
    logger: { log: (event, fields) => logs.push([event, fields]) },
  }).map(tool => [tool.name, tool]))
  const report = tools.task_report.execute
  tools.task_report.execute = async (args, exec) => {
    const response = await report(args, exec)
    const task = listTasks(db).find(t => t.id === args.task_id || t.ref === args.task_id)
    if (task?.delivery_pending) await endReportedTurn(db, { taskId: task.id, notifier: { push: item => pushed.push(item) }, dispatcher, queue })
    return response
  }
  return { db, dispatcher, queue, tools, pushed, logs }
}

const call = (tools, name, args, exec) =>
  tools[name].execute(args, name === 'task_report' ? exec : { agent: { id: 's-1' }, ...(exec ?? {}) })

const byTitle = (db, title) => listTasks(db).find(task => task.title === title)

/** 建一条「上游（带/不带 chain）+ 下游（waiting_dep）」的链。 */
const buildChain = async (env, { chain = CHAIN_AUTO, downstream = true } = {}) => {
  // chain:null 表示「这条链不带标记」（undefined 会落回默认值，别用它表达「不传」）。
  await call(env.tools, 'task_create', { ...sampleBrief({ title: '上游' }), ...(chain === null || chain === undefined ? {} : { chain }) })
  const upstream = byTitle(env.db, '上游')
  let downstreamTask
  if (downstream) {
    await call(env.tools, 'task_create', { ...sampleBrief({ title: '下游' }), dependsOn: [upstream.id] })
    downstreamTask = byTitle(env.db, '下游')
  }
  return { upstream: getTask(env.db, upstream.id), downstream: downstreamTask }
}

const reportDone = (env, task, summary = '做完了') =>
  call(env.tools, 'task_report', { task_id: task.id, status: 'done', summary }, { agent: { id: task.session_id } })

const wait = () => new Promise(resolve => setTimeout(resolve, 20))

// ---- 参数面 ------------------------------------------------------------------

test('task_create.chain：schema 只给 "auto"，描述与 copy.js 同源', async () => {
  const env = await setup()
  const spec = env.tools.task_create.parameters.properties.chain
  assert.equal(spec.type, 'string')
  assert.deepEqual(spec.enum, [CHAIN_AUTO])
  assert.equal(spec.description, CHAIN_AUTO_TOOL_DESC, 'chain 的描述应直接引用 copy.js 的 CHAIN_AUTO_TOOL_DESC')
})

test('task_create.chain：非法值可读拒绝、不建任务、不静默降级', async () => {
  const env = await setup()
  const before = listTasks(env.db).length
  const text = await call(env.tools, 'task_create', { ...sampleBrief({ title: '坏标记' }), chain: 'always' })
  assert.match(text, /chain 只接受 "auto"/)
  assert.equal(listTasks(env.db).length, before, '非法 chain 不应该建任务')
  const rejected = env.logs.filter(([event, fields]) => event === 'task.create.rejected'
    && fields?.detail?.reason === 'chain-invalid')
  assert.equal(rejected.length, 1, '拒绝要留审计（task.create.rejected / chain-invalid）')
})

test('task_create.chain：只进 brief 快照，不加 DB 列、不传与旧行为逐字一致', async () => {
  const env = await setup()
  await call(env.tools, 'task_create', { ...sampleBrief({ title: '带标记' }), chain: CHAIN_AUTO })
  await call(env.tools, 'task_create', sampleBrief({ title: '不带标记' }))
  const marked = byTitle(env.db, '带标记')
  const plain = byTitle(env.db, '不带标记')
  assert.equal(marked.brief.chain, 'auto')
  assert.equal('chain' in plain.brief, false, '不传 chain 时 brief 里不该出现这个键')
  const columns = env.db.prepare('PRAGMA table_info(tasks)').all().map(row => row.name)
  for (const forbidden of ['chain', 'chain_auto', 'chain_mode']) {
    assert.equal(columns.includes(forbidden), false, `不许为标记加列（${forbidden}）`)
  }
})

// ---- 门控 --------------------------------------------------------------------

test('chainAutoGate：无标记 / 非 delivered / 无下游 / 下游非 waiting_dep 都不放行', async () => {
  const db = await openLedger(tempDir())
  const make = (brief, extra = {}) => createTask(db, { brief, coordinatorSession: 's-1', ...extra })

  const plain = make(sampleBrief({ title: '无标记' }), { status: 'delivered' })
  assert.deepEqual(chainAutoGate(db, getTask(db, plain.id)), { ok: false, reason: 'no-chain', waiting: [] })

  const running = make(sampleBrief({ title: '带标记但没交付', chain: CHAIN_AUTO }), { status: 'running' })
  assert.equal(chainAutoGate(db, getTask(db, running.id)).reason, 'not-delivered')

  const lonely = make(sampleBrief({ title: '带标记无下游', chain: CHAIN_AUTO }), { status: 'delivered' })
  const lonelyGate = chainAutoGate(db, getTask(db, lonely.id))
  assert.equal(lonelyGate.ok, false)
  assert.equal(lonelyGate.reason, 'no-waiting-dependent')

  const upstream = make(sampleBrief({ title: '上游', chain: CHAIN_AUTO }), { status: 'delivered' })
  const waiter = make(sampleBrief({ title: '等着的下游' }), { dependsOn: [upstream.id], status: 'waiting_dep' })
  // 下游已就绪/已失败都不算「在等」。
  const doneDown = make(sampleBrief({ title: '已完成下游' }), { dependsOn: [upstream.id], status: 'done' })
  assert.deepEqual(listWaitingDependents(db, upstream.id), [waiter.id])
  assert.deepEqual(chainAutoGate(db, getTask(db, upstream.id)), { ok: true, waiting: [waiter.id] })
  transition(db, waiter.id, 'failed', { error: '手动失败' })
  assert.equal(chainAutoGate(db, getTask(db, upstream.id)).reason, 'no-waiting-dependent')
  assert.ok(doneDown.id !== waiter.id)
})

// ---- 交付路径 1：task_report done -------------------------------------------

test('task_report done + chain + 下游在等 → 交付即 done，下游晋升、通知/回执是「已完成」口径', async () => {
  const env = await setup()
  const { upstream, downstream } = await buildChain(env)
  assert.equal(upstream.status, 'running')
  assert.equal(downstream.status, 'waiting_dep')

  const text = await reportDone(env, upstream)
  await wait()

  assert.match(text, /交付请求已记录/, '先记录请求，回合结束才自动放行')
  assert.doesNotMatch(text, /已交付待确认：这是交付/)

  const closed = getTask(env.db, upstream.id)
  assert.equal(closed.status, 'done')
  assert.equal(closed.accepted_by, 'chain')
  assert.equal(closed.accepted_kind, 'delivery')
  assert.equal(closed.close_reason, 'chain')
  assert.equal(acceptedByLabel(closed.accepted_by), '链式自动放行')

  const closeRows = recentMessages(env.db, upstream.id, 10).filter(row => row.kind === 'close')
  assert.equal(closeRows.length, 1)
  assert.match(closeRows[0].rendered, /链式自动放行/)

  // 下游晋升并真的派发（queue.pump 的 promoteDependents 路径，没有另写一套晋升）。
  assert.equal(getTask(env.db, downstream.id).status, 'running')
  assert.equal(env.dispatcher.calls.filter(([kind]) => kind === 'spawn').length, 2)

  // 通知是「已完成」，不带交付确认指令。
  const notices = env.pushed.filter(item => item.taskId === upstream.id)
  assert.deepEqual(notices.map(item => item.status), ['done'])
  assert.match(notices[0].summary, /链式自动放行/)
})

test('task_report done + chain 但无下游 → 保持 delivered（不猜「将来会有下游」）', async () => {
  const env = await setup()
  const { upstream } = await buildChain(env, { downstream: false })
  const text = await reportDone(env, upstream)
  await wait()

  const kept = getTask(env.db, upstream.id)
  assert.equal(kept.status, 'delivered')
  assert.equal(kept.accepted_by, null)
  assert.equal(kept.close_reason, null)
  assert.match(text, /交付请求已记录/)
  assert.deepEqual(env.pushed.filter(item => item.taskId === upstream.id).map(item => item.status), ['delivered'])
})

test('task_report done + 不带 chain + 有下游 → 默认行为完全不变（仍等确认）', async () => {
  const env = await setup()
  const { upstream, downstream } = await buildChain(env, { chain: null })
  const text = await reportDone(env, upstream)
  await wait()

  assert.equal(getTask(env.db, upstream.id).status, 'delivered')
  assert.equal(getTask(env.db, downstream.id).status, 'waiting_dep', '不带标记的链仍然被 delivered 挡住')
  assert.equal(recentMessages(env.db, upstream.id, 10).filter(row => row.kind === 'close').length, 0)
  assert.match(text, /交付请求已记录/)
  assert.deepEqual(env.pushed.filter(item => item.taskId === upstream.id).map(item => item.status), ['delivered'])
})

// ---- 交付路径 2：settlement completed ---------------------------------------

test('结算 completed + chain + 下游在等 → done，通知 done、onTerminal 收到 done', async () => {
  const db = await openLedger(tempDir())
  const pushed = []
  const terminals = []
  let pumped = 0
  const upstream = createTask(db, { brief: sampleBrief({ title: '结算上游', chain: CHAIN_AUTO }), coordinatorSession: 's-1' })
  transition(db, upstream.id, 'running', { sessionId: 'child-9' })
  const downstream = createTask(db, {
    brief: sampleBrief({ title: '结算下游' }), coordinatorSession: 's-1', dependsOn: [upstream.id], status: 'waiting_dep',
  })
  const reporter = createSettlementReporter({
    db,
    notifier: { push: item => pushed.push(item) },
    labelFor: task => task.title,
    onTerminal: (_task, status) => terminals.push(status),
    pump: () => { pumped += 1; promoteDependents(db, { enqueue: () => {} }) },
  })

  const outcome = reporter.report({ taskId: upstream.id, stopReason: 'completed', source: 'dispatcher' })
  assert.equal(outcome.chainAuto, true)
  assert.equal(getTask(db, upstream.id).status, 'done')
  assert.equal(getTask(db, upstream.id).accepted_by, 'chain')
  assert.equal(getTask(db, downstream.id).status, 'pending', '下游由 promoteDependents 晋升')
  assert.deepEqual(pushed.map(item => item.status), ['done'])
  assert.match(pushed[0].summary, /链式自动放行/)
  assert.deepEqual(terminals, ['done'], '自动放行 = 真终态，goal 收口走 onTerminal(…, done)')
  assert.ok(pumped >= 1)
})

test('结算 completed + chain 但无下游 → 仍落 delivered（默认不变）', async () => {
  const db = await openLedger(tempDir())
  const pushed = []
  const task = createTask(db, { brief: sampleBrief({ title: '孤单上游', chain: CHAIN_AUTO }), coordinatorSession: 's-1' })
  transition(db, task.id, 'running', { sessionId: 'child-1' })
  const reporter = createSettlementReporter({ db, notifier: { push: item => pushed.push(item) }, labelFor: task => task.title })
  const outcome = reporter.report({ taskId: task.id, stopReason: 'completed' })
  assert.equal(outcome.to, 'delivered')
  assert.equal(outcome.chainAuto, false)
  assert.equal(getTask(db, task.id).status, 'delivered')
  assert.deepEqual(pushed.map(item => item.status), ['delivered'])
})

// ---- 幂等 / 互斥 / 面板 ------------------------------------------------------

test('幂等：自动放行后重复 done、迟到结算、面板确认都不重复 close', async () => {
  const env = await setup()
  const { upstream } = await buildChain(env)
  await reportDone(env, upstream)
  await wait()
  const closedOnce = getTask(env.db, upstream.id)
  assert.equal(closedOnce.status, 'done')

  // 1) 重复 done：只记消息，不迁移、不发第二条交付通知。
  const repeated = await reportDone(env, upstream, '又报一次')
  assert.match(repeated, /重复 done/)
  const afterRepeat = getTask(env.db, upstream.id)
  assert.equal(afterRepeat.status, 'done')
  assert.equal(afterRepeat.accepted_at, closedOnce.accepted_at)
  assert.equal(recentMessages(env.db, upstream.id, 10).filter(row => row.kind === 'close').length, 1)

  // 2) 迟到结算：只补最后一条消息，不再收口。
  const reporter = createSettlementReporter({ db: env.db, notifier: { push() {} }, labelFor: task => task.title })
  const late = reporter.report({ taskId: upstream.id, stopReason: 'completed', lastMessage: '迟到的最后一句' })
  assert.notEqual(late.action, 'updated')
  assert.equal(getTask(env.db, upstream.id).status, 'done')
  assert.equal(getTask(env.db, upstream.id).accepted_at, closedOnce.accepted_at)

  // 3) 面板「确认交付」走同一个 closeDelivered：already 幂等，不改 accepted_by。
  const panel = closeDelivered({ db: env.db, taskId: upstream.id, reason: CLOSE_REASONS.coordinator, by: 'panel' })
  assert.equal(panel.ok, true)
  assert.equal(panel.already, true)
  assert.equal(getTask(env.db, upstream.id).accepted_by, 'chain', '已自动放行的任务不把确认人改写成 panel')

  // 4) 交接事件只发一条 confirmed。
  const confirmed = []
  const dispose = setHandoffSink({
    delivered: () => null,
    confirmed: task => { confirmed.push(task.id); return null },
  })
  try {
    closeDelivered({ db: env.db, taskId: upstream.id, reason: CLOSE_REASONS.chain, by: 'chain' })
    closeDelivered({ db: env.db, taskId: upstream.id, reason: CLOSE_REASONS.coordinator, by: 'coordinator' })
  } finally {
    dispose()
  }
  assert.deepEqual(confirmed, [], 'done 上的重复确认走 already，不再发事件')
})

test('与超时 sweeper 互斥：先被超时收成 done(timeout) 后，自动放行不再 close', async () => {
  const db = await openLedger(tempDir())
  const upstream = createTask(db, {
    brief: sampleBrief({ title: '超时上游', chain: CHAIN_AUTO }), coordinatorSession: 's-1', status: 'delivered',
  })
  createTask(db, { brief: sampleBrief({ title: '还在等' }), coordinatorSession: 's-1', dependsOn: [upstream.id], status: 'waiting_dep' })
  // 把交付时间推到过去，让它落进 sweeper 的过期集合。
  db.prepare('UPDATE tasks SET delivered_at = ? WHERE id = ?').run(Date.now() - 10 * 60_000, upstream.id)
  const sweeper = createDeliveredSweeper({ db, config: { deliveredTimeoutMinutes: 1 } })
  const swept = sweeper.sweep()
  assert.deepEqual(swept.closed, [upstream.id])
  const timedOut = getTask(db, upstream.id)
  assert.equal(timedOut.status, 'done')
  assert.equal(timedOut.accepted_by, 'timeout')

  // 自动放行再来一次：状态已不是 delivered → 门控拒绝，不重复 close。
  const attempt = autoCloseChainDelivered({ db, taskId: upstream.id })
  assert.equal(attempt.closed, false)
  assert.equal(attempt.gate.reason, 'not-delivered')
  assert.equal(getTask(db, upstream.id).accepted_by, 'timeout')
  assert.equal(recentMessages(db, upstream.id, 10).filter(row => row.kind === 'close').length, 1)
})

// ---- 边界：只读 / 计划 / Team 板 --------------------------------------------

test('只读任务：chain 照常自动放行，read_only 与沙箱标记不变', async () => {
  const env = await setup()
  await call(env.tools, 'task_create', { ...sampleBrief({ title: '只读上游' }), chain: CHAIN_AUTO, readOnly: true })
  const upstream = byTitle(env.db, '只读上游')
  await call(env.tools, 'task_create', { ...sampleBrief({ title: '只读下游' }), dependsOn: [upstream.id] })
  assert.equal(getTask(env.db, upstream.id).read_only, true)
  await reportDone(env, getTask(env.db, upstream.id))
  await wait()
  const closed = getTask(env.db, upstream.id)
  assert.equal(closed.status, 'done')
  assert.equal(closed.read_only, true, '自动放行不改只读标记')
  assert.equal(closed.accepted_by, 'chain')
})

test('计划任务：chain 可创建，但不改计划批准路径（批准仍只认 action:approve）', async () => {
  const env = await setup()
  await call(env.tools, 'task_create', { ...sampleBrief({ title: '计划链上游' }), chain: CHAIN_AUTO, planFirst: true })
  const task = byTitle(env.db, '计划链上游')
  assert.equal(task.plan_first, true)
  assert.equal(task.brief.chain, 'auto')
  // 计划任务刚派发：plan_state 仍是 planning，自动放行没有参与任何计划态判定。
  assert.equal(task.plan_state, 'planning')
  assert.equal(task.status, 'running')
  assert.equal(task.accepted_kind, null)
})

test('官方 Team 板：acceptedBy=chain 不反写（与 timeout 同口径）', () => {
  assert.equal(shouldReverseConfirm(ACCEPTED_BY.chain), false)
  assert.equal(shouldReverseConfirm(ACCEPTED_BY.timeout), false)
  assert.equal(shouldReverseConfirm(ACCEPTED_BY.coordinator), true)
  assert.equal(shouldReverseConfirm(ACCEPTED_BY.panel), true)
})
