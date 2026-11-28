import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { addMessage, createTask, getTask, openLedger, setTaskArtifacts, setTaskLastFailure, transition } from '../src/ledger.js'
import { renderTaskDetail } from '../src/task-detail.js'
import { createTools } from '../src/tools.js'
import { tempDir, markDone } from './helpers.js'

const WRITE_HINT = '所有产出只写到该目录内，不要写到父会话目录或其他绝对路径；完成后汇报时把文件路径落到该目录下。'
const READ_ONLY_HINT = '只读任务：读与回报正常，但不要写文件、不要执行写操作的 shell；产物把路径写进回报正文（或给绝对路径），不要尝试创建文件。'

const briefOf = (overrides = {}) => ({
  title: '登录修复',
  goal: '让登录失败时给出明确提示\n第二行也要保留',
  constraints: ['只改 src/login.js'],
  acceptance: ['失败提示明确', 'npm test 全绿'],
  refs: ['src/login.js:66'],
  user_verbatim: '登录挂了\n日志在附件里',
  ...overrides,
})

async function setup() {
  const db = await openLedger(tempDir())
  const tools = Object.fromEntries(createTools({
    db,
    dispatcher: {},
    queue: { pendingCount: () => 0 },
    notifier: { push() {} },
    config: {},
    coordinatorStatus: () => ({ id: 'm-1', live: true }),
    logger: { log() {} },
  }).map(tool => [tool.name, tool]))
  return { db, tools }
}

function seed(db, { status = 'running', sessionId = 'c-1', brief = briefOf(), extra = {} } = {}) {
  const task = createTask(db, { brief, coordinatorSession: 'm-1', ...extra })
  if (status === 'running') transition(db, task.id, 'running', { sessionId, target: sessionId })
  else if (status !== 'pending') transition(db, task.id, status)
  return getTask(db, task.id)
}

// ---- 纯渲染：字段齐全 ----------------------------------------------------------

test('renderTaskDetail：目标全文/验收/约束/背景/用户原话/工作目录与写提示都在', () => {
  const task = {
    id: 't-1a2b3c4d',
    ref: 'tk-1a2b3c',
    status: 'running',
    brief: briefOf({ target: 'C:/work/login' }),
    artifacts: [],
    depends_on: [],
    group_id: null,
    priority: 0,
    write_scopes: [],
    read_only: false,
  }
  const text = renderTaskDetail(task)
  // R1：首行是「任务：名称（tk-xxx）」合一行（人类友好展示），不再单列任务引用行。
  assert.match(text, /^任务：登录修复（tk-1a2b3c）$/m)
  assert.match(text, /状态：进行中/)
  // 目标保留换行（全文，不压成一行）。
  assert.match(text, /目标：让登录失败时给出明确提示\n第二行也要保留/)
  assert.match(text, /工作目录：C:\/work\/login/)
  assert.match(text, /权限：可写/)
  assert.equal(text.includes(WRITE_HINT), true)
  assert.match(text, /【验收标准】\n- 失败提示明确\n- npm test 全绿/)
  assert.match(text, /【约束】- 只改 src\/login\.js/)
  assert.match(text, /【背景资料】- src\/login\.js:66/)
  assert.match(text, /【用户原话】\n> 登录挂了\n> 日志在附件里/)
  // 完成口径不再由详情给（t-4f7ce108：归 W1 per-turn policy，同一句只在一层出现）。
  assert.doesNotMatch(text, /完成后用 task_report 回报/)
  // 不是 JSON、不含 schema 字段名。
  assert.equal(text.includes('acceptance'), false)
  assert.throws(() => JSON.parse(text))
})

test('renderTaskDetail：只读任务给只读权限 + 禁写提示，且允许无工作目录', () => {
  const task = { id: 't-1', status: 'running', brief: briefOf({ readOnly: true }), read_only: true, artifacts: [], depends_on: [] }
  const text = renderTaskDetail(task)
  assert.match(text, /权限：只读/)
  assert.equal(text.includes(READ_ONLY_HINT), true)
  assert.equal(text.includes(WRITE_HINT), false)
  assert.equal(text.includes('工作目录：'), false)
})

test('renderTaskDetail：编排字段只在非默认值时出现', () => {
  const plain = renderTaskDetail({ id: 't-1', status: 'running', brief: briefOf(), artifacts: [], depends_on: [] })
  assert.equal(plain.includes('编排：'), false)
  const rich = renderTaskDetail({
    id: 't-1', status: 'running', brief: briefOf(), artifacts: [], depends_on: [],
    group_id: '发布', priority: 5, write_scopes: ['src/login.js'],
  })
  assert.match(rich, /编排：分组 发布｜优先级 5｜写域 src\/login\.js/)
})

test('renderTaskDetail：完整访问任务给「访问级别：完整」+ 任务边界纪律（不是禁写提示）', () => {
  const task = {
    id: 't-1', status: 'running', brief: briefOf({ access: 'full', target: 'C:/work/login' }),
    access: 'full', artifacts: [], depends_on: [],
  }
  const text = renderTaskDetail(task)
  assert.match(text, /状态：进行中｜完整访问/)
  assert.match(text, /权限：可写/)
  assert.match(text, /访问级别：完整（danger-full-access/)
  assert.match(text, /仍按任务边界只改这个目录/)
  assert.equal(text.includes(READ_ONLY_HINT), false)
  // 台账列（brief 丢了也能从 tasks.access 读出来）。
  const fromColumn = renderTaskDetail({ ...task, brief: briefOf(), access: 'full' })
  assert.match(fromColumn, /访问级别：完整/)
  // 没有访问级别标记的任务一字不提。
  assert.doesNotMatch(renderTaskDetail({ ...task, access: null, brief: briefOf() }), /访问级别/)
})

test('renderTaskDetail：只读/计划阶段压过 access:full（运行期事实优先）', () => {
  const readOnlyTask = {
    id: 't-1', status: 'running', brief: briefOf({ access: 'full', readOnly: true }),
    read_only: true, access: 'full', artifacts: [], depends_on: [],
  }
  const text = renderTaskDetail(readOnlyTask)
  assert.match(text, /权限：只读/)
  assert.equal(text.includes('访问级别：完整'), false)
})

test('结构化失败：task_status 与 task_detail 都展示最近一次工具失败（含建议动作）', async () => {
  const { db, tools } = await setup()
  const task = seed(db)
  setTaskLastFailure(db, task.id, {
    tool: 'pwsh',
    code: 'COMMAND_PERMISSION_DENIED',
    category: 'git_index_write_denied',
    retryable: false,
    action: 'inspect_acl_or_sandbox',
    head: "git : fatal: Unable to create 'C:/Users/72489/x/.git/index.lock': Permission denied",
    exitCode: 0,
  })
  const status = await tools.task_status.execute({ task_id: task.id }, { agent: { id: 'm-1' } })
  assert.match(status, /上次工具失败：pwsh｜git_index_write_denied（COMMAND_PERMISSION_DENIED）｜不可重试｜检查 ACL\/沙箱/)
  assert.match(status, /证据：git : fatal: Unable to create '~\/x\/\.git\/index\.lock': Permission denied/)
  assert.equal(status.includes('72489'), false)

  const detail = await tools.task_detail.execute({ task_id: task.id }, { agent: { id: task.session_id } })
  assert.match(detail, /上次工具失败：pwsh｜git_index_write_denied/)
  assert.match(detail, /不可重试｜检查 ACL\/沙箱/)
  db.close()
})

test('renderTaskDetail：前置任务块原样接入，经验文件区分「可读」与「已丢失」', () => {  const dir = tempDir()
  const lesson = join(dir, 'lesson.md')
  writeFileSync(lesson, '# 经验', 'utf8')
  const base = { id: 't-1', status: 'running', brief: briefOf(), artifacts: [], depends_on: ['t-0'] }
  const text = renderTaskDetail(base, {
    dependencies: '【前置任务】\n- 任务「前置」已完成：前置做完了',
    experience: { path: lesson, count: 2 },
  })
  assert.match(text, /【前置任务】\n- 任务「前置」已完成：前置做完了/)
  assert.match(text, new RegExp(`【经验文件】${lesson.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}（2 条）｜可 read 全文`))
  const missing = renderTaskDetail(base, { experience: { path: join(dir, 'gone.md'), count: 1 } })
  assert.match(missing, /｜文件已丢失/)
})

test('renderTaskDetail：降级经验（内联块）原样给出；产物标出存在性（目录也算存在）', () => {
  const dir = tempDir()
  const kept = join(dir, 'out.md')
  writeFileSync(kept, '# out', 'utf8')
  mkdirSync(join(dir, 'dist'))
  const text = renderTaskDetail(
    { id: 't-1', status: 'done', brief: briefOf(), depends_on: [], artifacts: [] },
    {
      experience: { inline: '【历史经验】1 条\n- [决策] 走 session cookie' },
      artifacts: [{ path: kept, label: '结果' }, { path: join(dir, 'dist') }, { path: join(dir, 'gone.md') }],
    },
  )
  assert.match(text, /【历史经验】1 条\n- \[决策\] 走 session cookie/)
  assert.match(text, new RegExp(`【已有产物】\\n- ${kept.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}（结果）`))
  // 目录产物不能误标「已缺失」。
  assert.match(text, new RegExp(`- ${join(dir, 'dist').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`))
  assert.match(text, /- .*gone\.md（已缺失）/)
})

// ---- 工具：owner-only / 只读 / 越权拒绝 -----------------------------------------

test('task_detail：任务自己的子会话能读到创建详情（含依赖与产物）', async () => {
  const { db, tools } = await setup()
  const task = seed(db, { brief: briefOf({ target: tempDir() }) })
  setTaskArtifacts(db, task.id, [{ path: join(tempDir(), 'out.md'), label: '产物' }])
  const text = await tools.task_detail.execute({ task_id: task.id }, { agent: { id: task.session_id } })
  assert.match(text, new RegExp(`任务：登录修复（${task.ref}）`))
  assert.match(text, /【验收标准】/)
  assert.match(text, /【已有产物】/)
  db.close()
})

test('task_detail：exec.agent.session.id 也认（不只 agent.id）', async () => {
  const { db, tools } = await setup()
  const task = seed(db)
  const text = await tools.task_detail.execute({ task_id: task.id }, { agent: { session: { id: task.session_id } } })
  assert.match(text, /任务：登录修复（tk-[0-9a-z]{6}）/)
  db.close()
})

test('task_detail：越权拒绝——主会话与别的子会话都读不到，且不落消息', async () => {
  const { db, tools } = await setup()
  const task = seed(db)
  const before = db.prepare('SELECT count(*) AS n FROM messages WHERE task_id = ?').get(task.id).n
  const byMain = await tools.task_detail.execute({ task_id: task.id }, { agent: { id: 'm-1' } })
  assert.match(byMain, /读取被拒绝/)
  assert.match(byMain, /主会话查任务用 task_status/)
  const byOther = await tools.task_detail.execute({ task_id: task.id }, { agent: { id: 'c-other' } })
  assert.match(byOther, /读取被拒绝/)
  assert.match(byOther, new RegExp(`属于子会话 ${task.session_id}`))
  const byNobody = await tools.task_detail.execute({ task_id: task.id })
  assert.match(byNobody, /读取被拒绝/)
  const after = db.prepare('SELECT count(*) AS n FROM messages WHERE task_id = ?').get(task.id).n
  assert.equal(after, before)
  assert.equal(getTask(db, task.id).status, 'running')
  db.close()
})

test('task_detail：还没派发的任务（没有 session_id）对任何调用方都拒绝', async () => {
  const { db, tools } = await setup()
  const task = seed(db, { status: 'pending' })
  const text = await tools.task_detail.execute({ task_id: task.id }, { agent: { id: 'c-1' } })
  assert.match(text, /读取被拒绝/)
  assert.match(text, /尚未派发/)
  db.close()
})

test('task_detail：缺 task_id / 抄错引用给可读提示（不回声、不泄内部）', async () => {
  const { db, tools } = await setup()
  const missing = await tools.task_detail.execute({}, { agent: { id: 'c-1' } })
  assert.match(missing, /缺少任务引用/)
  const unknown = await tools.task_detail.execute({ task_id: 't-nope' }, { agent: { id: 'c-1' } })
  assert.match(unknown, /找不到这个任务引用/)
  assert.doesNotMatch(unknown, /t-nope/)
  // 版本 B：接受 tk- 引用（task_list / 回执里给的就是它）。
  const seeded = seed(db)
  const byRef = await tools.task_detail.execute({ task_id: seeded.ref }, { agent: { id: seeded.session_id } })
  assert.match(byRef, new RegExp(`任务：登录修复（${seeded.ref}）`))
  db.close()
})

test('task_detail：只读——不写消息、不动任务行（状态/时间戳/进度都不变）', async () => {
  const { db, tools } = await setup()
  const task = seed(db)
  addMessage(db, task.id, { kind: 'report', rendered: '[progress] 在跑' })
  const snapshot = () => {
    const row = db.prepare('SELECT status, updated_at, last_event_at, progress_count, question FROM tasks WHERE id = ?').get(task.id)
    return {
      row,
      messages: db.prepare('SELECT count(*) AS n FROM messages WHERE task_id = ?').get(task.id).n,
    }
  }
  const before = snapshot()
  await tools.task_detail.execute({ task_id: task.id }, { agent: { id: task.session_id } })
  assert.deepEqual(snapshot(), before)
  db.close()
})

test('task_detail：前置任务按当前台账现读（创建时还没完成的依赖也能看到完成摘要）', async () => {
  const { db, tools } = await setup()
  const dep = seed(db, { brief: briefOf({ title: '前置', goal: '先把前置做完' }) })
  const downstream = seed(db, { sessionId: 'c-2', extra: { dependsOn: [dep.id] }, brief: briefOf({ title: '下游' }) })
  const before = await tools.task_detail.execute({ task_id: downstream.id }, { agent: { id: downstream.session_id } })
  assert.match(before, /【前置任务】/)
  assert.match(before, /当前进行中/)
  // 前置完成后同一个调用方再读：摘要变成已完成 + 最近回报。
  addMessage(db, dep.id, { kind: 'report', rendered: '[done] 前置做完' })
  markDone(db, dep.id)
  const after = await tools.task_detail.execute({ task_id: downstream.id }, { agent: { id: downstream.session_id } })
  assert.match(after, /已完成：前置做完/)
  db.close()
})

test('task_detail：关联了官方 Team 任务时如实说「只读关联、不要操作官方板」（P2-4）', async () => {
  const { db, tools } = await setup()
  const task = seed(db, { extra: { teamTask: { id: 'task-3', revision: 2 } } })
  const text = await tools.task_detail.execute({ task_id: task.id }, { agent: { id: task.session_id } })
  assert.match(text, /官方 Team 任务：task-3（只读关联；不要操作官方任务板/)
  assert.match(text, /确认交付时由协调者按 CAS 反写/)
  // 没关联的普通任务不出现这一行（旧输出逐字不变）。
  const plain = seed(db, { sessionId: 'c-9', brief: briefOf({ title: '普通任务' }) })
  const plainText = await tools.task_detail.execute({ task_id: plain.id }, { agent: { id: plain.session_id } })
  assert.doesNotMatch(plainText, /官方 Team 任务/)
  db.close()
})
