import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openLedger, createTask, getTask, transition, addMessage, recentMessages, recordProgress, setTaskArtifacts } from '../src/ledger.js'
import { createSettlementReporter, mapSettle, outputSummary, PAUSED_REASON } from '../src/settlement.js'
import { MAX_INLINE_BYTES, SUMMARY_CHARS } from '../src/last-message.js'
import { saveWorkspaceIndex } from '../src/workspace-index.js'
import { tempDir, sampleBrief, markDone } from './helpers.js'

const setup = async ({ status = 'running', sessionId = 'child-1', progress = 0, beforeNotify, terminal } = {}) => {
  const dir = tempDir()
  const db = await openLedger(dir)
  const reportsDir = join(dir, 'reports')
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
  // 传了 terminal 数组就收集 onTerminal 收到的状态（只有真终态才会收到）。
  const terminals = terminal ?? []
  let pumped = 0
  const reporter = createSettlementReporter({
    db,
    notifier: { push: item => pushed.push(item) },
    logger: { log: (event, fields) => logs.push([event, fields]) },
    labelFor: item => item.title,
    reportsDir,
    releaseSession: target => released.push(target),
    onTerminal: (_task, status) => terminals.push(status),
    pump: () => { pumped += 1 },
    ...(beforeNotify === undefined ? {} : { beforeNotify }),
  })
  return {
    db, task, pushed, logs, released, reporter, dir, reportsDir, terminals,
    pumped: () => pumped,
    kinds: () => db.prepare('SELECT kind FROM messages WHERE task_id = ? ORDER BY seq').all(task.id).map(row => row.kind),
  }
}

test('索引缺完整持久化时自然completed落failed；成功证据按任务保留', async () => {
  const db = await openLedger(tempDir())
  const entries = [{ id: 'ws', title: 'alias', path: '/work/repo' }]
  const make = () => {
    const task = createTask(db, { brief: sampleBrief({ title: '工作区与仓库索引', workspaceIndexEntries: entries }), readOnly: true, coordinatorSession: 's-1' })
    return transition(db, task.id, 'running', { sessionId: task.id })
  }
  const incomplete = make()
  const saved = make()
  const latest = make()
  const payload = JSON.stringify({ entries: [{ ...entries[0], status: 'not_git', sampledAt: new Date().toISOString() }] })
  assert.throws(() => saveWorkspaceIndex(db, incomplete, '{broken'))
  saveWorkspaceIndex(db, saved, payload)
  saveWorkspaceIndex(db, latest, payload)
  const pushed = []
  const reporter = createSettlementReporter({ db, notifier: { push: item => pushed.push(item) } })
  assert.equal(reporter.report({ taskId: incomplete.id, stopReason: 'completed' }).to, 'failed')
  assert.match(getTask(db, incomplete.id).error, /task_message\(\{ action: "retry" \}\)/)
  assert.equal(reporter.report({ taskId: incomplete.id, stopReason: 'completed' }).action, 'skipped')
  assert.equal(reporter.report({ taskId: saved.id, stopReason: 'completed' }).to, 'delivered', '全局索引被其他任务覆盖不影响本任务成功标记')
  assert.deepEqual(pushed.map(item => item.status), ['failed', 'delivered'])
  db.close()
})

test('mapSettle：平台五个 stopReason 的映射与死因', () => {
  // 两段式终态：completed 先落「已交付待确认」，确认/超时才 done。
  assert.deepEqual(mapSettle('completed'), { status: 'delivered', reason: null, stopReason: 'completed' })
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

test('completed → delivered：写 settle 消息、清空 error、发通知、保留可写根并唤醒队列', async () => {
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
  assert.equal(outcome.to, 'delivered')
  const task = getTask(f.db, f.task.id)
  assert.equal(task.status, 'delivered')
  assert.equal(task.error, null)
  assert.ok(Number.isFinite(task.delivered_at), '进入 delivered 要记交付时间（超时判据）')
  assert.deepEqual(f.kinds(), ['settle'])
  const message = recentMessages(f.db, f.task.id, 1)[0]
  assert.match(message.rendered, /结算/)
  assert.match(message.rendered, /待确认/)
  assert.deepEqual(message.meta, { stopReason: 'completed', status: 'delivered', source: 'dispatcher' })
  assert.equal(f.pushed.length, 1)
  assert.equal(f.pushed[0].status, 'delivered')
  assert.equal(f.pushed[0].system, true)
  assert.match(f.pushed[0].summary, /改完了/)
  // D5：通知 payload 永远带 artifacts 字段（空也是 []），渲染层据此决定要不要写产物区块。
  assert.deepEqual(f.pushed[0].artifacts, [])
  // delivered 还要复用同一子会话追问：可写根不释放；队列照常补位。
  assert.deepEqual(f.released, [])
  assert.equal(f.pumped(), 1)
  assert.ok(f.logs.some(([event]) => event === 'task.settle'))
  f.db.close()
})

test('真终态（cancelled/failed/orphaned）才释放可写根并收口 goal', async () => {
  for (const [stopReason, expected] of [['aborted', 'cancelled'], ['error', 'failed'], [undefined, 'orphaned']]) {
    const f = await setup({ terminal: [] })
    const outcome = f.reporter.report({ taskId: f.task.id, stopReason, output: [] })
    assert.equal(outcome.to, expected, String(stopReason))
    assert.deepEqual(f.released, ['child-1'], `${expected} 应释放可写根`)
    assert.deepEqual(f.terminals, [expected], `${expected} 应收口 goal`)
    f.db.close()
  }
})

test('D5：结算通知带台账里已有的产物（不用等收集）', async () => {
  const f = await setup()
  const report = join(tempDir(), 'report.md')
  writeFileSync(report, '# ok', 'utf8')
  setTaskArtifacts(f.db, f.task.id, [{ path: report, label: '报告', exists: true }])
  f.reporter.report({ taskId: f.task.id, stopReason: 'completed', output: [{ type: 'text', text: '改完了' }] })
  assert.equal(f.pushed.length, 1)
  assert.deepEqual(f.pushed[0].artifacts.map(item => item.path), [report])
  assert.equal(f.pushed[0].artifacts[0].label, '报告')
  f.db.close()
})

test('D5：beforeNotify 在发通知之前跑，通知用的是补齐后的产物；返回 undefined 表示不改', async () => {
  const dir = tempDir()
  const report = join(dir, 'late.md')
  writeFileSync(report, '# ok', 'utf8')
  // 钩子只能在 setup 之后拿到 db，所以先声明再赋值。
  let f
  let seen = null
  f = await setup({
    beforeNotify: (task, status) => {
      seen = { status, sessionId: task.session_id, artifacts: task.artifacts.length }
      if (status !== 'delivered') return undefined
      setTaskArtifacts(f.db, task.id, [{ path: report, label: '补的', exists: true }])
      return getTask(f.db, task.id)
    },
  })
  const outcome = f.reporter.report({
    taskId: f.task.id,
    stopReason: 'completed',
    output: [{ type: 'text', text: '改完了，测试全绿' }],
  })
  // 钩子收到的是「刚进交付态、还没产物」的那一行。
  assert.deepEqual(seen, { status: 'delivered', sessionId: 'child-1', artifacts: 0 })
  // 通知里看到的是钩子补齐后的产物（顺序反了就会是空数组——D5 原缺陷）。
  assert.equal(f.pushed.length, 1)
  assert.deepEqual(f.pushed[0].artifacts.map(item => item.path), [report])
  // 返回值也带补齐后的台账行，调用方不必再查库。
  assert.equal(outcome.task.artifacts.length, 1)
  f.db.close()

  // 非 done 终态不触发产物收集语义（钩子自己返回 undefined，通知字段仍存在）。
  const cancelled = await setup({ beforeNotify: () => undefined })
  cancelled.reporter.report({ taskId: cancelled.task.id, stopReason: 'aborted' })
  assert.equal(cancelled.pushed[0].status, 'cancelled')
  assert.deepEqual(cancelled.pushed[0].artifacts, [])
  cancelled.db.close()
})

test('D5：beforeNotify 抛错不回滚终态，通知照发（产物退化为台账现值）', async () => {
  const f = await setup({
    beforeNotify: () => { throw new Error('收集炸了') },
  })
  const outcome = f.reporter.report({ taskId: f.task.id, stopReason: 'completed', output: [{ type: 'text', text: '改完了' }] })
  assert.equal(outcome.to, 'delivered')
  assert.equal(getTask(f.db, f.task.id).status, 'delivered')
  assert.equal(f.pushed.length, 1)
  assert.deepEqual(f.pushed[0].artifacts, [])
  assert.ok(f.logs.some(([event, fields]) => event === 'task.settle.before-notify-failed' && /收集炸了/.test(fields.detail.error)))
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
  assert.equal(getTask(f.db, f.task.id).status, 'delivered')
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
    onTerminal() { throw new Error('goal 炸了') },
    pump() { throw new Error('队列炸了') },
  })
  // 用 aborted（cancelled）走「释放 + goal 收口 + 补位」全部副作用。
  const outcome = reporter.report({ taskId: task.id, stopReason: 'aborted' })
  assert.equal(outcome.action, 'updated')
  assert.equal(getTask(db, task.id).status, 'cancelled')
  db.close()
})

test('交付后（delivered）再收到 aborted：保持 delivered，不再迁移', async () => {
  const f = await setup()
  f.reporter.report({ taskId: f.task.id, stopReason: 'completed' })
  const later = f.reporter.report({ taskId: f.task.id, stopReason: 'aborted' })
  assert.equal(later.reason, 'not-running')
  assert.equal(getTask(f.db, f.task.id).status, 'delivered')
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

// B1：结算把完整 lastAssistantMessage 落进台账，主会话可直接读（task_status）。
test('B1：completed 落完整 lastAssistantMessage（短消息内联，摘要仍只 240 字）', async () => {
  const f = await setup()
  const full = '第一段：改完了。\n第二段：npm test 540/540 全绿。'
  const outcome = f.reporter.report({
    taskId: f.task.id,
    sessionId: 'child-1',
    stopReason: 'completed',
    output: [{ type: 'text', text: full }],
    source: 'lifecycle',
  })
  const record = getTask(f.db, f.task.id).last_message
  assert.equal(record.stored, 'inline')
  assert.equal(record.text, full)
  assert.equal(record.chars, full.length)
  assert.equal(record.bytes, Buffer.byteLength(full))
  assert.equal(record.stopReason, 'completed')
  assert.equal(record.source, 'lifecycle')
  assert.match(record.digest, /^[0-9a-f]{16}$/)
  assert.equal(record.summary, '第一段：改完了。 第二段：npm test 540/540 全绿。')
  // 摘要给通知，正文只在台账里
  assert.equal(f.pushed[0].summary, '第一段：改完了。 第二段：npm test 540/540 全绿。')
  assert.equal(outcome.lastMessage.stored, 'inline')
  assert.equal(outcome.lastMessage.path, null)
  // 短消息不建 reports 目录
  assert.equal(existsSync(f.reportsDir), false)
  f.db.close()
})

test('B1：超 64KB 写 reports 文件，台账只留路径 + 摘要', async () => {
  const f = await setup()
  const full = Array.from({ length: 400 }, (_, index) => `第 ${index} 段：${'细'.repeat(100)}`).join('\n')
  assert.ok(Buffer.byteLength(full) > MAX_INLINE_BYTES)
  const outcome = f.reporter.report({ taskId: f.task.id, stopReason: 'completed', output: [{ type: 'text', text: full }] })
  const record = getTask(f.db, f.task.id).last_message
  assert.equal(record.stored, 'file')
  assert.equal(record.text, undefined)
  assert.equal(record.path, join(f.reportsDir, `${f.task.id}.md`))
  assert.equal(readFileSync(record.path, 'utf8'), full)
  assert.equal(record.bytes, Buffer.byteLength(full))
  assert.equal(record.summary.length, SUMMARY_CHARS + 1)
  assert.match(record.summary, /…$/)
  assert.equal(outcome.lastMessage.path, record.path)
  assert.deepEqual(readdirSync(f.reportsDir), [`${f.task.id}.md`])
  f.db.close()
})

test('B1：派发侧只给全文 lastMessage 也能落库（日志摘要不参与持久化）', async () => {
  const f = await setup()
  const full = '改完了，测试全绿。\n（这里比 240 字摘要更长的部分也要留下）'
  const outcome = f.reporter.report({
    taskId: f.task.id,
    stopReason: 'completed',
    lastMessage: full,
    output: [{ type: 'text', text: '改完了，测试全绿。' }],
    source: 'dispatcher',
  })
  const record = getTask(f.db, f.task.id).last_message
  assert.equal(record.text, full)
  assert.equal(record.source, 'dispatcher')
  assert.equal(outcome.summary, '改完了，测试全绿。 （这里比 240 字摘要更长的部分也要留下）')
  f.db.close()
})

test('B1：重复结算幂等——不改状态、同正文不重写返回消息、不多写文件', async () => {
  const f = await setup()
  const full = '长'.repeat(25_000)
  assert.ok(Buffer.byteLength(full) > MAX_INLINE_BYTES)
  const first = f.reporter.report({ taskId: f.task.id, stopReason: 'completed', output: [{ type: 'text', text: full }] })
  const path = getTask(f.db, f.task.id).last_message.path
  // 同一段正文的重复结算（派发侧 + 生命周期双到达）：只补消息通道，不重写、不落第二条 settle。
  const second = f.reporter.report({ taskId: f.task.id, stopReason: 'completed', output: [{ type: 'text', text: full }] })
  assert.equal(first.action, 'updated')
  assert.equal(second.action, 'captured')
  assert.equal(second.changed, false)
  const record = getTask(f.db, f.task.id).last_message
  assert.equal(record.digest, first.lastMessage.digest)
  assert.equal(readFileSync(path, 'utf8'), full)
  assert.deepEqual(readdirSync(f.reportsDir), [`${f.task.id}.md`])
  assert.deepEqual(f.kinds(), ['settle'])
  // 更晚的 activation（例如 task_report done 所在回合的收尾文本）可以覆盖：它才是「最后一段话」。
  const third = f.reporter.report({ taskId: f.task.id, stopReason: 'completed', output: [{ type: 'text', text: '第二次的不同内容' }] })
  assert.equal(third.action, 'captured')
  assert.equal(third.changed, true)
  assert.equal(getTask(f.db, f.task.id).last_message.text, '第二次的不同内容')
  assert.equal(getTask(f.db, f.task.id).status, 'delivered')
  f.db.close()
})

test('B1：空输出不覆盖已有返回消息（不回写空记录）', async () => {
  const f = await setup()
  f.reporter.report({ taskId: f.task.id, stopReason: 'completed', output: [{ type: 'text', text: '先有正文' }] })
  const done = getTask(f.db, f.task.id)
  assert.equal(done.last_message.text, '先有正文')
  // 已完成任务再收到空输出：跳过，返回消息保持不动
  const later = f.reporter.report({ taskId: f.task.id, stopReason: 'aborted', output: [] })
  assert.equal(later.action, 'skipped')
  assert.equal(getTask(f.db, f.task.id).last_message.text, '先有正文')
  f.db.close()
})

// B1 时序修复：task_report done 会把任务先落到终态，回合真正结束后到达的 settlement
// 之前被状态闸门整条丢掉，导致 done 任务的 last_message 永远为空（真实台账 104/104 全缺）。
test('B1 时序修复：done 之后到达的 settlement 只补写最后消息，不改状态/不通知/不写 settle 行', async () => {
  const f = await setup()
  // 模拟 task_report done 已经在回合中途把任务推到终态
  markDone(f.db, f.task.id)
  const outcome = f.reporter.report({
    taskId: f.task.id,
    sessionId: 'child-1',
    stopReason: 'completed',
    output: [{ type: 'text', text: '做完了，测试全绿。\n第二段也要留下。' }],
    source: 'lifecycle',
  })
  assert.equal(outcome.action, 'captured')
  assert.equal(outcome.from, 'done')
  assert.equal(outcome.changed, true)
  const task = getTask(f.db, f.task.id)
  assert.equal(task.status, 'done')
  assert.equal(task.last_message.text, '做完了，测试全绿。\n第二段也要留下。')
  // 只落消息：不写 settle 行、不发通知、不释放可写根、不唤醒队列
  assert.deepEqual(f.kinds(), [])
  assert.equal(f.pushed.length, 0)
  assert.deepEqual(f.released, [])
  assert.equal(f.pumped(), 0)
  assert.ok(f.logs.some(([event]) => event === 'task.settle.late-message'))

  // 幂等：同一段正文再来一次不重写（digest 去重）
  const again = f.reporter.report({
    taskId: f.task.id,
    stopReason: 'completed',
    output: [{ type: 'text', text: '做完了，测试全绿。\n第二段也要留下。' }],
  })
  assert.equal(again.action, 'captured')
  assert.equal(again.changed, false)
  f.db.close()
})

test('B1 时序修复：终态上收到空输出不写、不报 captured（维持跳过）', async () => {
  const f = await setup()
  markDone(f.db, f.task.id)
  const outcome = f.reporter.report({ taskId: f.task.id, stopReason: 'completed' })
  assert.equal(outcome.action, 'skipped')
  assert.equal(outcome.reason, 'not-running')
  assert.equal(getTask(f.db, f.task.id).last_message, null)
  assert.deepEqual(f.kinds(), [])
  f.db.close()
})
