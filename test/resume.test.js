// 续跑（resume）：同 task_id + 同子会话冷恢复，与 retry（新任务 / 新会话）分工。锁四件事：①状态事实
// （failed/orphaned/done 可续跑，cancelled 不复活）②门控（done 只认 close_reason='timeout'）③端到端
// （投同一个子会话 id、计数自增、不新建、重复幂等）④失败回退（只报错、不动状态、绝不静默新建）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { addMessage, countTaskMessages, createTask, getTask, incrementResumeCount, openLedger, transition } from '../src/ledger.js'
import { RESUME_HISTORY_THRESHOLD, resumeGate, resumePrompt } from '../src/resume.js'
import { STATUS_CAPS, canTransition, statusesWith } from '../src/status-facts.js'
import { reconcileOrphans } from '../src/reconcile.js'
import { createTools } from '../src/tools.js'
import { createQueue } from '../src/queue.js'
import { CLOSE_REASONS } from '../src/delivered.js'
import { sampleBrief, tempDir } from './helpers.js'

const toolsOf = (db, dispatcher) => Object.fromEntries(createTools({
  db, dispatcher, queue: createQueue({ db, dispatcher: {}, config: {} }), notifier: { push() {} },
  config: {}, coordinatorStatus: () => ({ id: 's-1', live: true }), logger: { log() {} },
}).map(tool => [tool.name, tool]))

const TASK_COUNT = db => db.prepare('SELECT count(*) AS n FROM tasks').get().n
const UNREACHABLE = { code: 'CONTINUATION_UNAVAILABLE', message: '子会话不可达：not a direct child' }

/**
 * 建库 + 一条已收尾任务 + 投递探针。`sent` 记录每次冷恢复投递（target 必须是原来那个子会话）；
 * `failWith` 模拟平台错误；`orphan:true` 走真实启动对账把 running 标 orphaned（顺带验证落死因）。
 */
async function setup({ stop = 'failed', reason = 'error', closeReason = null, failWith = null, orphan = false } = {}) {
  const dir = tempDir()
  const db = await openLedger(dir)
  const task = createTask(db, { brief: sampleBrief({ title: '续跑用例' }), coordinatorSession: 's-1' })
  transition(db, task.id, 'running', { sessionId: 'c-1', target: 'c-1' })
  if (orphan) {
    await reconcileOrphans({
      db, coordinatorSessionId: 's-1', isLive: () => false, logger: { log() {} }, onWarn() {},
      dispatcher: { async catalog() { return [{ id: 'c-1' }] }, releaseWritableRoots() {} },
    })
  } else if (closeReason === null) {
    transition(db, task.id, stop, { error: '子会话异常结束', lastStopReason: reason })
  } else {
    transition(db, task.id, 'delivered')
    transition(db, task.id, 'done', { closeReason, lastStopReason: 'completed' })
  }
  const sent = []
  const sendReliable = failWith === null
    ? async (target, message) => { sent.push({ target, message }) }
    : async () => { throw Object.assign(new Error(failWith.message), { code: failWith.code }) }
  const tools = toolsOf(db, { sendReliable })
  const call = (args, exec = { agent: { id: 's-1' } }) => tools.task_message.execute(args, exec)
  return { dir, db, task: getTask(db, task.id), sent, call }
}

const resume = (call, taskId) => call({ action: 'resume', task_id: taskId })

test('状态事实与门控：可续跑的状态、done 行级白名单、无会话 / 检出已清理 / 软阈值', () => {
  assert.deepEqual(statusesWith('resume'), ['done', 'failed', 'orphaned'])
  assert.equal(STATUS_CAPS.cancelled.resume, false, '用户主动停掉的任务不该被续跑复活')
  assert.equal(STATUS_CAPS.running.resume, false, '在跑的任务用 message，不走 resume')
  for (const status of ['failed', 'orphaned']) assert.equal(canTransition(status, 'running'), true, `${status} 要有回 running 的边`)
  assert.deepEqual([canTransition('done', 'running'), canTransition('cancelled', 'running')], [true, false])
  const base = { status: 'failed', target: 'c-1' }
  assert.deepEqual(resumeGate(base), { ok: true, reason: null, history: 0, warn: null })
  assert.deepEqual([
    resumeGate({ ...base, status: 'orphaned' }).ok,
    resumeGate({ ...base, status: 'running' }).reason,
    resumeGate({ ...base, target: null }).reason,
    resumeGate({ ...base, worktree_state: 'cleaned' }).reason,
    resumeGate(undefined).reason,
  ], [true, 'state', 'no_session', 'checkout_cleaned', 'not_found'])
  // done：超时自动完成的可以续跑；协调者/用户确认过的不改写。
  assert.deepEqual([
    resumeGate({ status: 'done', target: 'c-1', close_reason: CLOSE_REASONS.timeout }).ok,
    resumeGate({ status: 'done', target: 'c-1', close_reason: CLOSE_REASONS.coordinator }).reason,
  ], [true, 'closed'])
  // 软阈值：超过阈值仍放行，只给 warn（长任务正好是「最该续跑」的那类，硬拦会逼出新派）。
  assert.deepEqual([
    resumeGate(base, { history: RESUME_HISTORY_THRESHOLD }).warn,
    resumeGate(base, { history: RESUME_HISTORY_THRESHOLD + 1 }).warn,
  ], [null, 'history_too_long'])
  // 续跑文案：先核对现状、别重做，带上死因与本次指示；不复述目标/验收（详情在 task_detail 与会话历史里，
  // 重复一遍等于诱导重做）。
  const text = resumePrompt({ id: 't-1a2b3c4d', title: '标题', status: 'failed', last_stop_reason: 'error' }, { history: 12, message: '继续写报告' })
  for (const pattern of [/不要重做/, /上次结束原因：error/, /12 条历史消息/, /本次指示：继续写报告/, /blocked/]) assert.match(text, pattern)
  assert.equal(text.includes('【目标】'), false)
})

test('端到端：failed → resume 冷恢复同一个子会话，计数自增、不新建；重复 resume 幂等', async () => {
  const { dir, db, task, sent, call } = await setup()
  // 回归：failed 任务仍不能 message 续派（追问与续跑是两条不同的路）。
  assert.match(await call({ action: 'message', task_id: task.id, message: '继续' }), /不能续派/)
  assert.equal(getTask(db, task.id).status, 'failed')
  const text = await resume(call, task.id)
  const after = getTask(db, task.id)
  assert.deepEqual([after.status, after.resume_count, after.attempts, after.last_stop_reason], ['running', 1, 1, null])
  assert.deepEqual([sent.length, sent[0].target], [1, 'c-1'], '只投一次，且必须投给原会话')
  assert.match(sent[0].message, /【续跑】/)
  assert.match(text, /第 1 次续跑/)
  assert.equal(TASK_COUNT(db), 1, 'resume 不许新建任务')
  // 台账消息：一条 kind='resume'（投递成功 → delivered），不是 followup。
  const row = db.prepare("SELECT meta_json FROM messages WHERE task_id = ? AND kind = 'resume'").get(task.id)
  assert.equal(JSON.parse(row.meta_json).delivery, 'delivered')
  // 重复 resume：状态已回 running，第二次被状态挡住——不投递、不新建、计数不涨（幂等）。
  assert.match(await resume(call, task.id), /只有失败 \/ 会话丢失/)
  assert.deepEqual([sent.length, getTask(db, task.id).resume_count, TASK_COUNT(db)], [1, 1, 1])
  // 台账列：自增可读、消息条数可数；重开同一库值不丢（旧库 ALTER 补列且幂等）。
  incrementResumeCount(db, task.id)
  addMessage(db, task.id, { kind: 'resume', rendered: 'x' })
  assert.equal(countTaskMessages(db, task.id), 2, 'brief 在 brief 列，这里只数 messages 行')
  db.close()
  const reopened = await openLedger(dir)
  assert.equal(getTask(reopened, task.id).resume_count, 2)
  reopened.close()
})

test('端到端：orphaned（启动对账标的）→ resume；历史 > 60 条只建议 retry、不拦截', async () => {
  const orphan = await setup({ orphan: true })
  assert.equal(orphan.task.status, 'orphaned')
  assert.match(orphan.task.last_stop_reason, /进程重启后子会话没有在运行的回合/)
  assert.match(await resume(orphan.call, orphan.task.id), /已续跑/)
  assert.deepEqual([getTask(orphan.db, orphan.task.id).status, orphan.sent[0].target], ['running', 'c-1'])
  assert.match(orphan.sent[0].message, /上次结束原因：进程重启后/)
  orphan.db.close()
  const long = await setup()
  for (let index = 0; index < RESUME_HISTORY_THRESHOLD + 1; index += 1) addMessage(long.db, long.task.id, { kind: 'progress', rendered: `第 ${index} 轮` })
  const text = await resume(long.call, long.task.id)
  assert.equal(long.sent.length, 1, '软阈值不拦截，照样投递')
  assert.match(text, /建议改用 task_message\(\{ action: 'retry' \}\)/)
  long.db.close()
})

test('失败回退：不可达 / 投递失败都只报错、不动状态、不新建任务', async () => {
  for (const code of ['SUBAGENT_NOT_FOUND', 'CONTINUATION_UNAVAILABLE']) {
    const { db, task, call } = await setup({ failWith: { ...UNREACHABLE, code } })
    const text = await resume(call, task.id)
    const after = getTask(db, task.id)
    assert.deepEqual([after.status, after.resume_count, after.last_stop_reason, TASK_COUNT(db)], ['failed', 0, 'error', 1], code)
    for (const pattern of [/不可达（不能冷恢复）/, /没有自动新建任务/, /action: 'retry'/]) assert.match(text, pattern)
    db.close()
  }
  // 非不可达的投递错误（可重试）：不发「不可达」的口径，也不新建。
  const transient = await setup({ failWith: { code: 'E_SPAWN_FAILED', message: '派生失败：注入器未就绪' } })
  const text = await resume(transient.call, transient.task.id)
  assert.deepEqual([getTask(transient.db, transient.task.id).status, TASK_COUNT(transient.db)], ['failed', 1])
  assert.match(text, /续跑投递失败/)
  assert.match(text, /可再续跑一次/)
  assert.doesNotMatch(text, /不可达/)
  transient.db.close()
})

test('done 行级白名单：超时自动完成可续跑（清掉关闭原因），确认完成被拒且状态不变', async () => {
  const timeout = await setup({ closeReason: CLOSE_REASONS.timeout })
  const confirmed = await setup({ closeReason: CLOSE_REASONS.coordinator })
  assert.match(await resume(timeout.call, timeout.task.id), /已续跑/)
  const resumed = getTask(timeout.db, timeout.task.id)
  assert.deepEqual([resumed.status, resumed.close_reason], ['running', null], '续跑后不再是「已关闭」')
  assert.match(await resume(confirmed.call, confirmed.task.id), /不能续跑/)
  assert.equal(getTask(confirmed.db, confirmed.task.id).status, 'done')
  timeout.db.close()
  confirmed.db.close()
})
