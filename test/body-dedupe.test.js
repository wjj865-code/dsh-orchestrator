// P1 台账正文去重（0.30.1）：写侧只存借条、读侧按需冷读宿主会话日志。
//
// 这三个契约必须一起锁住，否则「台账瘦了但读不回来」会静默退化：
//   1) 写侧：brief / followup / resume / report 落库只有 {digest, chars, summary}，没有正文；
//   2) 读侧：新行按 digest 去宿主会话日志取回全文；旧行（自带 text / path）原样可读，不需要迁移；
//   3) 降级：宿主读不到时给摘要 + unavailable，**不抛错、不伪造**（task_status 与面板 detail 同口径）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { getTask, openLedger, listTasks, recentMessages, setTaskLastMessage, transition } from '../src/ledger.js'
import { createTools } from '../src/tools.js'
import { createPanelActions } from '../src/panel-actions.js'
import { createQueue } from '../src/queue.js'
import { resolveMessageBody } from '../src/message-body.js'
import { captureLastMessage, resolveLastMessage } from '../src/last-message.js'
import {
  HOST_LOG_MISSING, assistantText, createBodySource, lastAssistantText, reportEntries, userTexts,
} from '../src/session-body.js'
import { tempDir, sampleBrief } from './helpers.js'

const noopDispatcher = {
  async spawn() { return { id: 'child-1', sessionId: 'child-1', target: 'child-1' } },
  async send() {},
  async sendReliable() {},
  async stop() {},
  releaseWritableRoots() {},
  async catalog() { return [] },
}
const noopQueue = { pump() {}, remove() {}, async enqueueAndPump(id) { return { task: getTask(dbRef, id) } }, position() { return 0 } }
let dbRef

async function setup(options = {}) {
  const db = await openLedger(tempDir())
  dbRef = db
  const queue = createQueue({ db, dispatcher: noopDispatcher, config: {} })
  const tools = Object.fromEntries(createTools({
    db,
    dispatcher: noopDispatcher,
    queue,
    config: { coordinatorSession: 's-1', staleMinutes: 30 },
    coordinatorStatus: () => ({ id: 's-1', live: true }),
    bodySource: options.bodySource,
  }).map(tool => [tool.name, tool]))
  const panel = createPanelActions({
    db,
    dispatcher: noopDispatcher,
    queue,
    config: {},
    coordinatorStatus: () => ({ id: 's-1', live: true }),
    bodySource: options.bodySource,
  })
  return { db, tools, panel }
}

const callTool = (tools, name, args, exec = { agent: { id: 's-1' } }) => tools[name].execute(args, exec)

// 宿主 0.2.2-rc.5 的事件形状（asar 实读 @deepseek-ai/dsh-session/src/types.ts）。
const assistantEvent = (seq, text) => ({
  seq,
  time: seq,
  type: 'assistant/message',
  data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } },
})
const userEvent = (seq, text) => ({
  seq,
  time: seq,
  type: 'user/message',
  data: { id: `m-${seq}`, role: 'user', content: [{ type: 'text', text }] },
})
const reportEvent = (seq, status, summary) => ({
  seq,
  time: seq,
  type: 'tool/call',
  data: { turn: 1, step: 1, callId: `c-${seq}`, name: 'task_report', arguments: JSON.stringify({ status, summary }) },
})

test('写侧：brief / followup / report 只存借条（不含正文），C 档消息不受影响', async () => {
  const { db, tools } = await setup()
  const longGoal = '把登录模块的会话 cookie 统一收口。'.repeat(60)
  await callTool(tools, 'task_create', { ...sampleBrief({ title: '去重写侧', goal: longGoal }), target: tempDir() })
  const task = listTasks(db)[0]
  // task_create 已经派发成 running（假 dispatcher 的 spawn 立即成功），子会话 = child-1。
  assert.equal(task.status, 'running')
  // 用非周期文本：这样「正文中段是否漏进台账」的断言才有意义（周期文本会自匹配前缀）。
  const followupText = '请顺手把单测补上。'.concat(Array.from({ length: 200 }, (_, index) => `第${index}条`).join('｜'))
  const reportTextArgument = '改完了：'.concat(Array.from({ length: 200 }, (_, index) => `第${index}段细节`).join('｜'))
  await callTool(tools, 'task_message', { task_id: task.id, message: followupText })
  await callTool(tools, 'task_report', { task_id: task.id, status: 'done', summary: reportTextArgument }, { agent: { id: 'child-1' } })

  const rows = db.prepare('SELECT kind, rendered, meta_json FROM messages WHERE task_id = ? ORDER BY seq').all(task.id)
  const byKind = Object.fromEntries(rows.map(row => [row.kind, row]))
  for (const kind of ['brief', 'followup', 'report']) {
    const row = byKind[kind]
    assert.ok(row !== undefined, `缺少 ${kind} 行`)
    const meta = JSON.parse(row.meta_json)
    assert.equal(meta.body, 'host', `${kind} 应是借条行`)
    assert.match(meta.digest, /^[0-9a-f]{16}$/)
    assert.ok(meta.chars > 0, `${kind} 应记下正文字数`)
    // followup / report 的原文远超摘要上限；brief 本身就只有两行（证明借条不是「照抄正文」看它）。
    if (kind !== 'brief') assert.ok(meta.chars > 240, `${kind} 原文应超过摘要上限`)
    assert.ok(row.rendered.length <= 241, `${kind} rendered 应是摘要：${row.rendered.length}`)
    assert.equal(row.rendered.includes('\n'), false, `${kind} rendered 应是单行`)
  }
  assert.equal(byKind.brief.rendered.includes(longGoal.slice(0, 30)), false)
  // 摘要只留开头 240 字：正文中段绝不能出现在台账里（那是「只存借条」的核心）。
  assert.equal(byKind.followup.rendered.includes(followupText.slice(300, 340)), false)
  assert.equal(byKind.report.rendered.includes(reportTextArgument.slice(300, 340)), false)
  // C 档（settle/acceptance/close/delivery_failed）不瘦身：结算行仍是完整一句话。
  const settle = byKind.settle
  assert.ok(settle === undefined || JSON.parse(settle.meta_json).body === undefined)
  db.close()
})

test('读侧：旧行（自带正文）原样可读，新行按 digest 从宿主日志取回', async () => {
  const briefText = ''
  const followupText = '请补单测。'.repeat(50)
  const reportText = '[done] 改完了：'.concat('细节'.repeat(100))
  const events = [
    userEvent(0, briefText),
    userEvent(1, followupText),
    assistantEvent(2, '第一轮回复'),
    reportEvent(3, 'done', '改完了：'.concat('细节'.repeat(100))),
    assistantEvent(4, '最后一段话'),
  ]
  const bodySource = createBodySource({
    sessions: () => ({ get: id => (id === 'child-1' ? { snapshotEvents: () => events } : undefined) }),
    now: () => 0,
  })
  const { db, tools } = await setup({ bodySource })
  await callTool(tools, 'task_create', sampleBrief({ title: '读侧' }))
  const task = listTasks(db)[0]

  // 新行：followup / report 的正文都从宿主日志按 digest 找回（台账只有摘要）。
  await callTool(tools, 'task_message', { task_id: task.id, message: followupText })
  await callTool(tools, 'task_report', { task_id: task.id, status: 'done', summary: '改完了：'.concat('细节'.repeat(100)) }, { agent: { id: 'child-1' } })
  const rows = recentMessages(db, task.id, 50).reverse()
  const fresh = getTask(db, task.id)
  const followupRow = rows.filter(row => row.kind === 'followup').at(-1)
  const followupResolved = await resolveMessageBody(fresh, followupRow, bodySource)
  assert.equal(followupResolved.source, 'host')
  assert.equal(followupResolved.text, followupText)

  const reportRow = rows.filter(row => row.kind === 'report').at(-1)
  const reportResolved = await resolveMessageBody(fresh, reportRow, bodySource)
  assert.equal(reportResolved.source, 'host')
  assert.equal(reportResolved.text, reportText)

  // brief：确定性重渲染（不依赖宿主日志是否还有那条 user/message）。
  const briefRow = rows.find(row => row.kind === 'brief')
  const briefResolved = await resolveMessageBody(fresh, briefRow, bodySource)
  assert.equal(briefResolved.source, 'derived')
  assert.match(briefResolved.text, /^【任务引用】/)
  assert.match(briefResolved.text, /task_detail/)

  // 旧行（P1 之前的行）：没有 meta.body 标记 → 原样返回 stored rendered，不查宿主、不降级。
  const legacy = { seq: 99, kind: 'report', rendered: '[done] 旧行的完整回报正文', at: 1, meta: null }
  const legacyResolved = await resolveMessageBody(fresh, legacy, bodySource)
  assert.deepEqual(legacyResolved, { text: '[done] 旧行的完整回报正文', source: 'inline' })
  db.close()
})

test('读侧降级：宿主日志读不到 → 摘要 + unavailable，不抛错（task_status 与面板 detail 同口径）', async () => {
  // 没有 sessions / sessionPersistence：模拟宿主会话已被删或重启后不可达。
  const { db, tools, panel } = await setup()
  const goal = 'g'
  await callTool(tools, 'task_create', sampleBrief({ title: '降级', goal }))
  const task = listTasks(db)[0]
  // 让任务的子会话 id 指向一个宿主读不到的会话（会话已被删 / 重启后不可达）。
  db.prepare('UPDATE tasks SET session_id = ? WHERE id = ?').run('child-gone', task.id)
  const long = '正文'.repeat(500)
  setTaskLastMessage(db, task.id, captureLastMessage({ text: long, taskId: task.id, stopReason: 'completed' }))

  const status = await callTool(tools, 'task_status', { task_id: task.id, include: 'full' })
  assert.match(status, /正文不可读：host-log-missing/)
  assert.match(status, /以下只是摘要/)
  assert.ok(!status.includes(long))

  const detail = await panel.detailBody(task.id)
  assert.equal(detail.ok, true)
  assert.deepEqual(detail.body, { source: 'summary', unavailable: HOST_LOG_MISSING })
  // 客户端读的是 lastMessage.text：降级时它就是摘要（老客户端不需要改也能显示）。
  assert.equal(detail.task.lastMessage.text, detail.task.lastMessage.summary)
  assert.equal(detail.task.lastMessage.stored, 'host')

  // 同步 detail 沿用「只有借条」的形状（不 await、不抛错）：面板其余动作不受影响。
  const sync = panel.detail(task.id)
  assert.equal(sync.ok, true)
  assert.equal(sync.task.lastMessage.text, undefined)
  db.close()
})

test('读侧：宿主日志可读时面板 detail 给回全文，并标 source=host', async () => {
  const full = '最后一段话'.concat('细节'.repeat(400))
  const events = [assistantEvent(0, full)]
  const bodySource = createBodySource({
    sessions: () => ({ get: id => (id === 'child-1' ? { snapshotEvents: () => events } : undefined) }),
    now: () => 0,
  })
  const { db, tools, panel } = await setup({ bodySource })
  await callTool(tools, 'task_create', sampleBrief({ title: '可读' }))
  const task = listTasks(db)[0]
  setTaskLastMessage(db, task.id, captureLastMessage({ text: full, taskId: task.id, stopReason: 'completed' }))
  const detail = await panel.detailBody(task.id)
  assert.deepEqual(detail.body, { source: 'host' })
  assert.equal(detail.task.lastMessage.text, full)
  assert.equal(detail.task.lastMessage.summary.length, 241)
  db.close()
})

function digestOf(text) {
  // 与 session-body 的 bodyDigest 同算法（测试里独立算一遍，防止两边一起写错）。
  return createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, 16)
}

test('session-body：事件抽取器与冷读句柄（sessionPersistence.open read）', async () => {
  const events = [userEvent(0, '简报'), assistantEvent(1, '第一段'), reportEvent(2, 'progress', '做了一半'), assistantEvent(3, '第二段')]
  assert.equal(assistantText(events[1]), '第一段')
  assert.equal(lastAssistantText(events), '第二段')
  assert.deepEqual(userTexts(events).map(item => item.text), ['简报'])
  const reports = reportEntries(events)
  assert.equal(reports.length, 1)
  assert.equal(reports[0].text, '[progress] 做了一半')

  let closed = false
  const opened = []
  const persistence = {
    async open(id, access) {
      opened.push([id, access])
      return { id, access, read: async () => ({ eventState: 'detached', events }), close: async () => { closed = true } }
    },
  }
  const body = createBodySource({ sessionPersistence: () => persistence, sessions: () => undefined })
  assert.equal(await body.lastAssistant('session-x'), '第二段')
  assert.equal(await body.userTextByDigest('session-x', digestOf('简报')), '简报')
  assert.equal(await body.reportByDigest('session-x', digestOf('[progress] 做了一半')), '[progress] 做了一半')
  assert.deepEqual(opened[0], ['session-x', 'read'])
  assert.equal(closed, true)

  // 冷读抛错（会话不存在/迁移待办）→ undefined，绝不把异常抛给回执或面板。
  const broken = createBodySource({
    sessionPersistence: () => ({ async open() { throw new Error('not found') } }),
    sessions: () => undefined,
  })
  assert.equal(await broken.lastAssistant('session-gone'), undefined)
  const degraded = await resolveLastMessage({ stored: 'host', summary: '摘要', chars: 2, bytes: 6, digest: 'x', at: 1 }, {
    sessionId: 'session-gone',
    body: broken,
  })
  assert.deepEqual(degraded, { text: '摘要', source: 'summary', unavailable: HOST_LOG_MISSING })
})
