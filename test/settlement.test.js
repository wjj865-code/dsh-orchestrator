import test from 'node:test'
import assert from 'node:assert/strict'
import { openLedger, createTask, getTask, transition, addMessage, recentMessages, recordProgress } from '../src/ledger.js'
import { createSettlementReporter, mapSettle, outputSummary, PAUSED_REASON } from '../src/settlement.js'
import { tempDir, sampleBrief } from './helpers.js'

const setup = async ({ status = 'running', sessionId = 'child-1', progress = 0 } = {}) => {
  const db = await openLedger(tempDir())
  const task = createTask(db, { brief: sampleBrief({ title: '甲' }), coordinatorSession: 's-1' })
  if (status === 'running') {
    transition(db, task.id, 'running', { sessionId })
    for (let i = 0; i < progress; i += 1) recordProgress(db, task.id, { stallRounds: 99, staleMinutes: 30 })
  } else if (status !== 'pending') {
    // pending 只能先派发成 running，再进 waiting_user 这类中间态。
    transition(db, task.id, 'running', { sessionId })
    if (status !== 'running') transition(db, task.id, status, status === 'waiting_user' ? {} : { error: '旧死因' })
  }
  const pushed = []
  const logs = []
  const released = []
  let pumped = 0
  const reporter = createSettlementReporter({
    db,
    notifier: { push: item => pushed.push(item) },
    logger: { log: (event, fields) => logs.push([event, fields]) },
    labelFor: item => item.title,
    releaseSession: target => released.push(target),
    pump: () => { pumped += 1 },
  })
  return {
    db, task, pushed, logs, released, reporter,
    pumped: () => pumped,
    kinds: () => db.prepare('SELECT kind FROM messages WHERE task_id = ? ORDER BY seq').all(task.id).map(row => row.kind),
  }
}

test('mapSettle：平台五个 stopReason 的映射与死因', () => {
  assert.deepEqual(mapSettle('completed'), { status: 'done', reason: null, stopReason: 'completed' })
  assert.equal(mapSettle('aborted').status, 'cancelled')
  assert.match(mapSettle('aborted').reason, /中断/)
  assert.equal(mapSettle('error').status, 'failed')
  assert.match(mapSettle('error').reason, /异常/)
  assert.equal(mapSettle('max-tokens').status, 'failed')
  assert.match(mapSettle('max-tokens').reason, /长度上限/)
  assert.equal(mapSettle('refusal').status, 'failed')
  assert.match(mapSettle('refusal').reason, /策略拒绝/)
})

test('mapSettle：只报过 progress 的 completed 落 orphaned，不假报完成', () => {
  const mapped = mapSettle('completed', { progressCount: 2 })
  assert.equal(mapped.status, 'orphaned')
  assert.equal(mapped.reason, PAUSED_REASON)
  assert.match(mapped.reason, /progress/)
})

test('mapSettle：未知/缺失 stopReason 按会话丢失处理（orphaned）', () => {
  assert.equal(mapSettle(undefined).status, 'orphaned')
  assert.match(mapSettle(undefined).reason, /stopReason=null/)
  assert.equal(mapSettle(null).status, 'orphaned')
  assert.equal(mapSettle('future-reason').status, 'orphaned')
  assert.match(mapSettle('future-reason').reason, /future-reason/)
  // 原型链上的键不能被当成合法取值。
  assert.equal(mapSettle('toString').status, 'orphaned')
})

test('outputSummary：只取 text 块、压空白、截断', () => {
  assert.equal(outputSummary([{ type: 'text', text: '  a\n b ' }, { type: 'image' }, { type: 'text', text: 'c' }]), 'a b c')
  assert.equal(outputSummary(undefined), '')
  assert.equal(outputSummary([{ type: 'toolCall' }]), '')
  assert.equal(outputSummary([{ type: 'text', text: 'x'.repeat(400) }]).length, 241)
})

test('completed → done：写 settle 消息、清空 error、发通知、释放可写根并唤醒队列', async () => {
  const f = await setup()
  const outcome = f.reporter.report({
    taskId: f.task.id,
    sessionId: 'child-1',
    stopReason: 'completed',
    output: [{ type: 'text', text: '改完了，测试全绿' }],
    source: 'dispatcher',
  })
  assert.equal(outcome.action, 'updated')
  assert.equal(outcome.from, 'running')
  assert.equal(outcome.to, 'done')
  const task = getTask(f.db, f.task.id)
  assert.equal(task.status, 'done')
  assert.equal(task.error, null)
  assert.deepEqual(f.kinds(), ['settle'])
  const message = recentMessages(f.db, f.task.id, 1)[0]
  assert.match(message.rendered, /结算/)
  assert.deepEqual(message.meta, { stopReason: 'completed', status: 'done', source: 'dispatcher' })
  assert.equal(f.pushed.length, 1)
  assert.equal(f.pushed[0].status, 'done')
  assert.equal(f.pushed[0].system, true)
  assert.match(f.pushed[0].summary, /改完了/)
  assert.deepEqual(f.released, ['child-1'])
  assert.equal(f.pumped(), 1)
  assert.ok(f.logs.some(([event]) => event === 'task.settle'))
  f.db.close()
})

test('aborted → cancelled：死因写进 error 列并通知', async () => {
  const f = await setup()
  const outcome = f.reporter.report({ taskId: f.task.id, stopReason: 'aborted', source: 'dispatcher' })
  assert.equal(outcome.to, 'cancelled')
  const task = getTask(f.db, f.task.id)
  assert.equal(task.status, 'cancelled')
  assert.match(task.error, /stopReason=aborted/)
  assert.equal(f.pushed[0].status, 'cancelled')
  f.db.close()
})

test('error / max-tokens / refusal → failed，死因可读', async () => {
  for (const [stopReason, pattern] of [['error', /异常结束/], ['max-tokens', /长度上限/], ['refusal', /策略拒绝/]]) {
    const f = await setup()
    const outcome = f.reporter.report({ taskId: f.task.id, stopReason, output: [], source: 'lifecycle' })
    assert.equal(outcome.to, 'failed', stopReason)
    const task = getTask(f.db, f.task.id)
    assert.equal(task.status, 'failed')
    assert.match(task.error, pattern)
    assert.equal(f.pushed[0].status, 'failed')
    f.db.close()
  }
})

test('settle 失败（activation.result 被拒）→ failed，死因带原始错误', async () => {
  const f = await setup()
  const outcome = f.reporter.fail({ taskId: f.task.id, error: 'teardown 炸了' })
  assert.equal(outcome.to, 'failed')
  assert.match(getTask(f.db, f.task.id).error, /teardown 炸了/)
  f.db.close()
})

test('未知 stopReason → orphaned（会话丢失口径）', async () => {
  const f = await setup()
  const outcome = f.reporter.report({ taskId: f.task.id, stopReason: undefined })
  assert.equal(outcome.to, 'orphaned')
  assert.match(getTask(f.db, f.task.id).error, /stopReason=null/)
  f.db.close()
})

test('只报过 progress 后回合结束 → orphaned，不误判完成', async () => {
  const f = await setup({ progress: 1 })
  const outcome = f.reporter.report({ taskId: f.task.id, stopReason: 'completed' })
  assert.equal(outcome.to, 'orphaned')
  assert.equal(getTask(f.db, f.task.id).status, 'orphaned')
  assert.match(getTask(f.db, f.task.id).error, /progress/)
  f.db.close()
})

test('按 sessionId 反查任务：会话没对上就跳过', async () => {
  const f = await setup({ sessionId: 'child-9' })
  const missing = f.reporter.report({ sessionId: 'child-unknown', stopReason: 'completed' })
  assert.equal(missing.action, 'skipped')
  assert.equal(missing.reason, 'no-task')
  const bySession = f.reporter.report({ sessionId: 'child-9', stopReason: 'completed' })
  assert.equal(bySession.action, 'updated')
  assert.equal(getTask(f.db, f.task.id).status, 'done')
  f.db.close()
})

test('waiting_user / pending 等非 running 状态：结算不改状态、不发通知', async () => {
  const waiting = await setup({ status: 'waiting_user' })
  const outcome = waiting.reporter.report({ taskId: waiting.task.id, stopReason: 'completed' })
  assert.equal(outcome.action, 'skipped')
  assert.equal(outcome.reason, 'not-running')
  assert.equal(getTask(waiting.db, waiting.task.id).status, 'waiting_user')
  assert.equal(waiting.pushed.length, 0)
  assert.deepEqual(waiting.kinds(), [])
  waiting.db.close()

  const pending = await setup({ status: 'pending' })
  assert.equal(pending.reporter.report({ taskId: pending.task.id, stopReason: 'error' }).reason, 'not-running')
  assert.equal(getTask(pending.db, pending.task.id).status, 'pending')
  pending.db.close()
})

test('重复结算幂等：派发侧与生命周期事件同时到达只落一次终态', async () => {
  const f = await setup()
  const first = f.reporter.report({ taskId: f.task.id, stopReason: 'completed', source: 'lifecycle' })
  const second = f.reporter.report({ taskId: f.task.id, stopReason: 'completed', source: 'dispatcher' })
  assert.equal(first.action, 'updated')
  assert.equal(second.action, 'skipped')
  assert.equal(second.reason, 'not-running')
  assert.equal(f.pushed.length, 1)
  assert.deepEqual(f.kinds(), ['settle'])
  f.db.close()
})

test('通知/释放/补位抛错都不能打断结算落库', async () => {
  const db = await openLedger(tempDir())
  const task = createTask(db, { brief: sampleBrief({ title: '乙' }), coordinatorSession: 's-1' })
  transition(db, task.id, 'running', { sessionId: 'child-2' })
  const reporter = createSettlementReporter({
    db,
    notifier: { push() { throw new Error('通知炸了') } },
    logger: { log() { throw new Error('日志炸了') } },
    releaseSession() { throw new Error('释放炸了') },
    pump() { throw new Error('队列炸了') },
  })
  const outcome = reporter.report({ taskId: task.id, stopReason: 'completed' })
  assert.equal(outcome.action, 'updated')
  assert.equal(getTask(db, task.id).status, 'done')
  db.close()
})

test('已有终态（done）再收到 aborted：保持 done', async () => {
  const f = await setup()
  f.reporter.report({ taskId: f.task.id, stopReason: 'completed' })
  const later = f.reporter.report({ taskId: f.task.id, stopReason: 'aborted' })
  assert.equal(later.reason, 'not-running')
  assert.equal(getTask(f.db, f.task.id).status, 'done')
  assert.deepEqual(f.kinds(), ['settle'])
  f.db.close()
})

test('结算消息不影响 task_report 的回报行顺序', async () => {
  const f = await setup()
  addMessage(f.db, f.task.id, { kind: 'report', rendered: '[progress] 做了一半' })
  f.reporter.report({ taskId: f.task.id, stopReason: 'aborted' })
  assert.deepEqual(f.kinds(), ['report', 'settle'])
  f.db.close()
})
