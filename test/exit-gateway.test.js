// 版本 B《ID 出口网关》§8：**用户面零裸编号**。
//
// 这一组是「出口断言」而不是「函数单测」：逐条走真实工具调用，断言标「必须零」的出口里
// `t-xxxx`（`/\bt-[0-9a-z]{4,}\b/`）零命中，只有 `tk-`；同时反向断言台账/日志/handoff 仍保留裸编号
// （白名单，防「清洗过头把审计真源也改了」）。
//
// 明确不在覆盖范围（版本 C，未做）：**回复正文**（协调者模型输出）不在这里断言——它没有确定性出口，
// 只能靠「不喂 id」降概率 + 人工统计，见交付说明的「未验项」。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openLedger, createTask, getTask, listTasks } from '../src/ledger.js'
import { createTools } from '../src/tools.js'
import { createQueue } from '../src/queue.js'
import { createNotifier } from '../src/notify.js'
import { reconcileSummary } from '../src/reconcile.js'
import { idleSummary } from '../src/watchdog.js'
import { sanitizeUserFacing } from '../src/user-facing.js'
import { taskRefOf } from '../src/task-ref.js'
import { taskLabel, taskLabelWithRef } from '../src/task-label.js'
import { sampleBrief, tempDir, endReportedTurn } from './helpers.js'

/** 裸编号形态（`t-` + 至少 4 位小写字母/数字）：用户面出现即判定泄漏。 */
const BARE_ID = /(?<!artifacts\/)(?<!artifact-store\/)\bt-[0-9a-z]{4,}\b/
const REF = /tk-[0-9a-z]{6}/

function fakeDispatcher() {
  let counter = 0
  return {
    calls: [],
    async spawn(input) { counter += 1; this.calls.push(['spawn', input]); return { id: `c-${counter}`, name: input.name, sessionId: `c-${counter}`, target: `c-${counter}` } },
    async sendReliable(target, message) { this.calls.push(['sendReliable', target, message]); return { messageId: 'm-1' } },
    async stop(target) { this.calls.push(['stop', target]) },
    releaseWritableRoots() {},
    slug() { counter += 1; return `task-${counter}` },
  }
}

async function setup({ mainDir } = {}) {
  const fallback = tempDir()
  const db = await openLedger(tempDir())
  const dispatcher = fakeDispatcher()
  const pushed = []
  const notifier = { pushed, push(item) { pushed.push(item) } }
  const config = { staleMinutes: 30, maxQueue: 50, coordinatorSession: 's-1' }
  const queue = createQueue({ db, dispatcher, config })
  const tools = Object.fromEntries(createTools({
    db, dispatcher, queue, notifier, config,
    coordinatorStatus: () => ({ id: 's-1', live: true }),
    defaultCwd: () => mainDir ?? fallback,
  }).map(tool => [tool.name, tool]))
  const report = tools.task_report.execute
  tools.task_report.execute = async (args, exec) => {
    const response = await report(args, exec)
    const task = listTasks(db).find(t => t.id === args.task_id || t.ref === args.task_id)
    if (task?.delivery_pending) await endReportedTurn(db, { taskId: task.id, notifier, dispatcher, queue })
    return response
  }
  return { db, dispatcher, notifier, pushed, tools }
}

const asMain = (tools, name, args) => tools[name].execute(args, { agent: { id: 's-1' } })

test('出口：task_create / task_list / task_status 回执只有 tk-，没有裸编号', async () => {
  const { db, tools } = await setup()
  const created = await asMain(tools, 'task_create', sampleBrief({ title: '网关任务', goal: '验证出口' }))
  assert.doesNotMatch(created, BARE_ID, created)
  assert.match(created, REF)
  const list = await asMain(tools, 'task_list', {})
  assert.doesNotMatch(list, BARE_ID, list)
  const task = listTasks(db)[0]
  const status = await asMain(tools, 'task_status', { task_id: task.ref })
  assert.doesNotMatch(status, BARE_ID, status)
  // 回执「子会话」按用户拍板保留会话 id（不是任务编号，别误清洗）。
  assert.match(status, /子会话：c-2/)
  db.close()
})

test('出口：计划任务链路的依赖/重派文案不出现裸编号', async () => {
  const { db, tools } = await setup()
  const first = await asMain(tools, 'task_create', sampleBrief({ title: '前置', goal: 'a' }))
  const refA = first.match(REF)[0]
  const chained = await asMain(tools, 'task_create', { ...sampleBrief({ title: '下游', goal: 'b' }), dependsOn: [refA] })
  // 依赖可以用**引用**声明（回执给的就是它），回执里也不出现编号。
  assert.match(chained, /已派发|等待前置/)
  assert.doesNotMatch(chained, BARE_ID, chained)
  const waiting = listTasks(db).find(task => task.title === '下游')
  assert.equal(waiting.depends_on.length, 1, 'dependsOn 归一成台账 id 落库')
  // 等待前置的 task_status 也只写名称 + 引用。
  const status = await asMain(tools, 'task_status', { task_id: waiting.ref })
  assert.doesNotMatch(status, BARE_ID, status)
  db.close()
})

test('出口：task_report 回执 / 问题 / 选项 / 产物 label 全部清洗（写入前）', async () => {
  const { db, tools, pushed } = await setup()
  const created = await asMain(tools, 'task_create', sampleBrief({ title: '回报', goal: 'g' }))
  const ref = created.match(REF)[0]
  const task = listTasks(db)[0]
  // 子会话把台账编号抄进了 summary / question / options / 产物 label（真实泄漏形态）。
  const dir = tempDir()
  mkdirSync(join(dir, 'out'), { recursive: true })
  const artifact = join(dir, 'out', 'report.md')
  writeFileSync(artifact, 'x', 'utf8')
  const receipt = await tools.task_report.execute({
    task_id: ref,
    status: 'blocked',
    summary: `卡在 ${task.id} 这条任务的验收上`,
    question: `任务 ${task.id} 要不要先停？`,
    options: [`保留 ${task.id}`, '停掉重派'],
    artifacts: [{ path: artifact, label: `产出（${task.id}）` }],
  }, { agent: { id: task.session_id } })
  assert.equal(receipt.includes(task.id), false, receipt)
  assert.doesNotMatch(receipt, BARE_ID, receipt)
  const saved = getTask(db, task.id)
  assert.equal(saved.question.includes(task.id), false, saved.question)
  assert.equal(saved.options.join(' ').includes(task.id), false, saved.options.join(' '))
  assert.equal(saved.artifacts[0].label.includes(task.id), false, saved.artifacts[0].label)
  // 产物 **path** 不清洗：那是真实文件路径，改了就读不到。
  assert.match(saved.artifacts[0].path, /manifest\.json$/)
  assert.equal(saved.artifact_stage.complete, false)
  // 通知正文同源（notify 用 tools 给的 summary/question）。
  const pushedItem = pushed.at(-1)
  assert.equal(String(pushedItem.summary).includes(task.id), false)
  assert.equal(String(pushedItem.question).includes(task.id), false)
  db.close()
})

test('出口：通知正文（含交付动作指令）只有任务名 + tk- 引用', async () => {
  const { db, tools, pushed } = await setup()
  const db2 = db
  const created = await asMain(tools, 'task_create', sampleBrief({ title: '通知', goal: 'g' }))
  const ref = created.match(REF)[0]
  const task = listTasks(db2)[0]
  await tools.task_report.execute({ task_id: ref, status: 'done', summary: '完成' }, { agent: { id: task.session_id } })
  const item = pushed.at(-1)
  // notify 的渲染入口：直接用 createNotifier 跑一遍（同一份 item）。
  const sent = []
  const notifier = createNotifier({ send: async text => sent.push(text), mergeWindowMs: 5 })
  notifier.push(item)
  await new Promise(resolve => setTimeout(resolve, 30))
  const text = sent.join('\n')
  assert.match(text, REF)
  assert.doesNotMatch(text, BARE_ID, text)
  assert.equal(text.replace(/(?:artifacts|artifact-store)\/t-[0-9a-z]{8}/g, 'artifacts/task').includes(task.id), false, text)
  db.close()
})

test('出口：错误文案（工具层）零裸编号、零内部结构', async () => {
  const { db, tools } = await setup()
  const created = await asMain(tools, 'task_create', sampleBrief({ title: '错误', goal: 'g' }))
  const ref = created.match(REF)[0]
  const task = listTasks(db)[0]
  const cases = [
    await asMain(tools, 'task_status', { task_id: 't-deadbeef' }),
    await asMain(tools, 'task_status', { task_id: '' }),
    await asMain(tools, 'task_message', { task_id: 'not-a-ref', message: 'x' }),
    await asMain(tools, 'task_detail', { task_id: task.id }), // 主会话越权（文案里含子会话 id，不含任务编号）
    await asMain(tools, 'task_create', { ...sampleBrief({ title: '缺前置', goal: 'g' }), dependsOn: [task.id, 'tk-000000'] }),
  ]
  for (const text of cases) {
    assert.doesNotMatch(text, BARE_ID, text)
    assert.doesNotMatch(text, /task_refs|\bSELECT\b|retired_at|token/i, text)
  }
  assert.match(ref, REF)
  db.close()
})

test('出口：计划文档（文件名 + 头部 + 回执）零裸编号', async () => {
  const mainDir = join(tempDir(), 'main')
  const { db, tools } = await setup({ mainDir })
  const created = await asMain(tools, 'task_create', sampleBrief({ title: '计划出口', goal: 'g', planFirst: true }))
  assert.doesNotMatch(created, BARE_ID, created)
  const ref = created.match(REF)[0]
  const task = listTasks(db)[0]
  const saved = await tools.plan_save.execute({ task_id: ref, content: `正文（任务 ${task.id} 的计划）` }, { agent: { id: task.session_id } })
  assert.doesNotMatch(saved, BARE_ID, saved)
  assert.match(saved, /计划已落盘/)
  const path = getTask(db, task.id).plan_path
  assert.equal(path.endsWith('计划出口-1.md'), true, path)
  const body = readFileSync(path, 'utf8')
  assert.doesNotMatch(body, BARE_ID, body)
  // 正文里的编号被换成引用（写入前清洗），而不是原样落盘。
  assert.match(body, /正文（任务 tk-[0-9a-z]{6} 的计划）/)
  db.close()
})

test('出口：brief / task_detail / resume 里没有 t-xxxx，只有 tk-', async () => {
  const { db, tools, dispatcher } = await setup()
  const created = await asMain(tools, 'task_create', sampleBrief({ title: '派发', goal: 'g' }))
  const ref = created.match(REF)[0]
  const task = listTasks(db)[0]
  const spawn = dispatcher.calls.find(call => call[0] === 'spawn')
  const briefText = String(spawn?.[1]?.prompt?.[0]?.text ?? spawn?.[1]?.prompt ?? '')
  assert.match(briefText, new RegExp(`【任务引用】${ref}`))
  assert.doesNotMatch(briefText, BARE_ID, briefText)
  const detail = await tools.task_detail.execute({ task_id: ref }, { agent: { id: task.session_id } })
  assert.doesNotMatch(detail, BARE_ID, detail)
  assert.match(detail, new RegExp(`任务引用：${ref}`))
  // 续跑文案同样只写引用。
  const { resumePrompt } = await import('../src/resume.js')
  const prompt = resumePrompt(task)
  assert.doesNotMatch(prompt, BARE_ID, prompt)
  assert.match(prompt, new RegExp(`（${ref}）`))
  db.close()
})

test('出口：对账 / 看门狗摘要只写名称 + 引用', async () => {
  const { db, tools } = await setup()
  await asMain(tools, 'task_create', sampleBrief({ title: '孤儿甲', goal: 'g' }))
  await asMain(tools, 'task_create', sampleBrief({ title: '空闲乙', goal: 'g' }))
  const tasks = listTasks(db)
  const orphan = reconcileSummary(tasks, { labelFor: task => taskLabel(task, { all: tasks }) })
  assert.doesNotMatch(orphan, BARE_ID, orphan)
  const idle = idleSummary(tasks.map(task => ({ task, idleMs: 90 * 60 * 1000 })), { labelFor: task => taskLabel(task, { all: tasks }) })
  assert.doesNotMatch(idle, BARE_ID, idle)
  assert.match(idle, /tk-[0-9a-z]{6}/)
  db.close()
})

test('出口：面板快照带 ref（抽屉/工作台显示引用，id 只作动作键）', async () => {
  const { db, tools } = await setup()
  await asMain(tools, 'task_create', sampleBrief({ title: '面板', goal: 'g' }))
  const task = listTasks(db)[0]
  // 面板/抽屉的显示名：重名后缀与引用都来自 task.label 函数，不含裸编号。
  assert.doesNotMatch(taskLabelWithRef(task), BARE_ID)
  assert.equal(taskLabelWithRef(task), `面板（${task.ref}）`)
  assert.equal(task.ref, taskRefOf(db, task.id))
  // 快照字段：ref 存在、id 仍在（动作键）；客户端渲染只用 ref（见 client/src/{views,workbench,logic}.js）。
  const source = readFileSync(new URL('../src/host-route.js', import.meta.url), 'utf8')
  assert.match(source, /ref: task\.ref \?\? null/)
  const views = readFileSync(new URL('../client/src/views.js', import.meta.url), 'utf8')
  assert.match(views, /\['引用', task\.ref \|\| '（未生成）'\]/)
  assert.doesNotMatch(views, /\['编号', task\.id\]/)
  const wb = readFileSync(new URL('../client/src/workbench.js', import.meta.url), 'utf8')
  assert.doesNotMatch(wb, /编号 \$\{task\.id\}/)
  const logic = readFileSync(new URL('../client/src/logic.js', import.meta.url), 'utf8')
  assert.doesNotMatch(logic, /任务 \$\{task\.id\}/)
  db.close()
})

test('反向白名单：台账 messages / notifications 仍保留裸编号（审计真源不清洗）', async () => {
  const { db, tools } = await setup()
  const created = await asMain(tools, 'task_create', sampleBrief({ title: '审计', goal: 'g' }))
  const ref = created.match(REF)[0]
  const task = listTasks(db)[0]
  await tools.task_report.execute({ task_id: ref, status: 'progress', summary: '在跑' }, { agent: { id: task.session_id } })
  // messages 行是按 task_id 索引的（借条），task_id 列必须还是裸编号。
  const rows = db.prepare('SELECT task_id FROM messages WHERE task_id = ?').all(task.id)
  assert.ok(rows.length > 0, '台账 messages 仍按裸编号索引')
  // notifications 只在投递链路上落行（这里直接写一条，验列口径仍按裸编号索引）。
  db.prepare('INSERT INTO notifications (task_id, level, status, created_at) VALUES (?, ?, ?, ?)')
    .run(task.id, 'report', 'skipped', Date.now())
  const notifications = db.prepare('SELECT task_id FROM notifications WHERE task_id = ?').all(task.id)
  assert.ok(notifications.length > 0, '台账 notifications 仍按裸编号索引')
  db.close()
})

test('清洗器只替换台账已知编号（不做泛化正则，不误伤真实内容）', async () => {
  const { db } = await setup()
  const db2 = db
  const task = createTask(db2, { brief: sampleBrief({ title: '已知' }), coordinatorSession: 's-1' })
  const sanitize = text => sanitizeUserFacing(text, { refOf: id => taskRefOf(db2, id) })
  assert.equal(sanitize(`前缀 ${task.id} 后缀`), `前缀 ${task.ref} 后缀`)
  // 台账里没有的「像编号」的东西原样保留（可能是用户文件路径/变量名）。
  assert.equal(sanitize('变量 t-abcdefgh 不是任务'), '变量 t-abcdefgh 不是任务')
  // 引用本身不被二次清洗。
  assert.equal(sanitize(`已换成 ${task.ref}`), `已换成 ${task.ref}`)
  // 未命中不记日志、命中才记。
  const hits = []
  sanitizeUserFacing(`x ${task.id}`, { refOf: id => taskRefOf(db2, id), onHit: (id, ref) => hits.push([id, ref]) })
  assert.deepEqual(hits, [[task.id, task.ref]])
  db.close()
})
