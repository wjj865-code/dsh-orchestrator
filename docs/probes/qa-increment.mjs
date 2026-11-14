#!/usr/bin/env node
// QA：阶段 3 增量独立复核 —— 工作区推断三路径 + artifacts 落库/通知/面板形状
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const here = dirname(fileURLToPath(import.meta.url))
const src = (name) => import(new URL(`../../src/${name}`, import.meta.url))
const { inferWorkspaceTarget, pathTail } = await src('workspace-match.js')
const ledger = await src('ledger.js')
const { createTools } = await src('tools.js')
const { createNotifier } = await src('notify.js')
const { createHostRoute } = await src('host-route.js')
const { taskCard } = await src('card.js')

let failures = 0
const check = (name, cond, detail = '') => {
  if (cond) console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`)
  else { failures += 1; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`) }
}
const tmp = (prefix) => mkdtempSync(join(tmpdir(), prefix))
const clean = (dir) => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* ok */ } }

// ======================= 1. inferWorkspaceTarget 纯函数 =======================
console.log('\n== 1. 工作区匹配 ==')
{
  const gomoku = { id: 'w-gomoku', title: 'Gomoku AI', path: 'C:/work/Gomoku-AI' }
  check('pathTail 跨平台', pathTail('C:\\a\\b') === 'b' && pathTail('/a/b/') === 'b')
  const exact = inferWorkspaceTarget({ title: 'Gomoku AI', goal: '修复' }, [gomoku])
  check('精确 title（大小写不敏感）唯一命中', exact.ok === true && exact.workspace?.id === 'w-gomoku')
  const tail = inferWorkspaceTarget({ title: '修复 gomoku-ai 的 bug', goal: '' }, [gomoku])
  check('路径末段子串唯一命中', tail.ok === true && tail.workspace?.id === 'w-gomoku')
  const dedupe = inferWorkspaceTarget({ title: 'gomoku ai', goal: '' }, [{ ...gomoku, title: 'Gomoku AI' }])
  check('title 与末段同时命中按 id 去重（唯一）', dedupe.ok === true && dedupe.workspace?.id === 'w-gomoku')
  const shortKey = inferWorkspaceTarget({ title: 'AI 优化', goal: '' }, [{ id: 'w-ai', title: 'AI', path: 'C:/x/AI' }])
  check('ASCII 短键(<3) 不参与子串匹配', shortKey.ok === true && shortKey.workspace === undefined)
  const shortExact = inferWorkspaceTarget({ title: 'AI', goal: '' }, [{ id: 'w-ai', title: 'AI', path: 'C:/x/AI' }])
  check('ASCII 短键仍可精确全等命中（12c7f45 修正）', shortExact.ok === true && shortExact.workspace?.id === 'w-ai')
  const cjk = inferWorkspaceTarget({ title: '看看报告', goal: '' }, [{ id: 'w-cn', title: '报告', path: 'C:/x/报告' }])
  check('CJK 2 字键可匹配', cjk.ok === true && cjk.workspace?.id === 'w-cn')
  const exactFirst = inferWorkspaceTarget({ title: '报告', goal: '' }, [
    { id: 'w-a', title: '报告', path: 'C:/x/报告A' },
    { id: 'w-b', title: '报告生成器', path: 'C:/x/报告B' },
  ])
  check('精确层优先，不被子串混入', exactFirst.ok === true && exactFirst.workspace?.id === 'w-a')
  const multi = inferWorkspaceTarget({ title: '同时涉及 project-alpha 和 project-beta', goal: '' }, [
    { id: 'w-1', title: 'project-alpha', path: 'C:/p/a' },
    { id: 'w-2', title: 'project-beta', path: 'C:/p/b' },
  ])
  check('多命中返回候选不选择', multi.ok === false && multi.candidates.length === 2
    && multi.candidates.every((c) => typeof c.path === 'string' && typeof c.title === 'string'), JSON.stringify(multi).slice(0, 120))
  const none = inferWorkspaceTarget({ title: '完全无关', goal: '没有关键字' }, [gomoku])
  check('无命中返回 workspace undefined', none.ok === true && none.workspace === undefined)
  check('脏输入不崩', inferWorkspaceTarget({}, [null, 1, {}]).ok === true)
}

// ======================= 2. task_create 推断三路径 =======================
console.log('\n== 2. task_create 推断 ==')
const home = tmp('qa-inc-')
const db = await ledger.openLedger(join(home, 'state', 'orchestrator'))
const mainDir = join(home, '指挥舱')
mkdirSync(mainDir, { recursive: true })
const workA = join(home, 'Gomoku-AI')
const workB = join(home, 'project-alpha')
const workC = join(home, 'project-beta')
for (const dir of [workA, workB, workC]) mkdirSync(dir, { recursive: true })
const pushed = []
const makeTools = (workspaces, status = () => ({ id: 'main-1', live: true })) => createTools({
  db,
  dispatcher: { spawn: async () => ({ sessionId: 'c', target: 'c' }), sendReliable: async () => {}, stop: async () => {} },
  queue: {
    pendingCount: () => 0,
    pump: () => {},
    remove: () => {},
    enqueueAndPump: async (id) => {
      ledger.transition(db, id, 'running', { sessionId: 'child-1', target: 'child-1' })
      return { task: ledger.getTask(db, id), position: 1 }
    },
  },
  notifier: { push: (item) => pushed.push(item) },
  config: {},
  coordinatorStatus: status,
  workspaces: () => ({ list: () => workspaces }),
  defaultCwd: mainDir,
})
const tools = makeTools([
  { id: 'w-gomoku', title: 'Gomoku AI', path: workA },
  { id: 'w-pa', title: 'project-alpha', path: workB },
  { id: 'w-pb', title: 'project-beta', path: workC },
])
const tool = (name) => tools.find((item) => item.name === name)
const mainExec = { agent: { id: 'main-1' } }

const unique = await tool('task_create').execute({ title: 'Gomoku AI 修复', goal: '修 bug', acceptance: ['a'] }, mainExec)
const uniqueRow = db.prepare("SELECT * FROM tasks WHERE title LIKE 'Gomoku AI%'").get()
check('唯一命中落 target_dir = 工作区 path', uniqueRow?.target_dir === workA, `${String(unique).slice(0, 40)} / ${uniqueRow?.target_dir}`)
check('唯一命中仍正常派发', /已派发/.test(String(unique)))

const beforeMulti = db.prepare('SELECT count(*) AS n FROM tasks').get().n
const multi = await tool('task_create').execute({ title: '同时涉及 project-alpha 和 project-beta', goal: 'g', acceptance: ['a'] }, mainExec)
const afterMulti = db.prepare('SELECT count(*) AS n FROM tasks').get().n
check('多命中不建任务', afterMulti === beforeMulti, `tasks ${beforeMulti} -> ${afterMulti}`)
check('多命中文案列候选', /多个工作区|候选/.test(String(multi)) && String(multi).includes(workA) === false && String(multi).includes(workB), String(multi).slice(0, 80))

const plain = await tool('task_create').execute({ title: '完全无关的任务', goal: '随便', acceptance: ['a'] }, mainExec)
const plainRow = db.prepare("SELECT * FROM tasks WHERE title = '完全无关的任务'").get()
check('无命中不写 target_dir（回指挥舱）', plainRow?.target_dir === null, `${String(plain).slice(0, 30)} / ${plainRow?.target_dir}`)

const rel = await tool('task_create').execute({ title: '相对 target', goal: 'g', acceptance: ['a'], target: 'relative/x' }, mainExec)
check('显式相对 target 仍拒', /绝对路径/.test(String(rel)), String(rel))
const missing = await tool('task_create').execute({ title: '不存在 target', goal: 'g', acceptance: ['a'], target: join(home, 'nope') }, mainExec)
check('显式不存在 target 仍拒', /不存在或不是目录/.test(String(missing)), String(missing))
const explicit = await tool('task_create').execute({ title: '显式 target', goal: 'g', acceptance: ['a'], target: workB }, mainExec)
check('显式合法 target 契约不变', /已派发/.test(String(explicit)) && db.prepare("SELECT target_dir FROM tasks WHERE title = '显式 target'").get().target_dir === workB)

// ======================= 3. artifacts 落库 / 通知 / 面板 =======================
console.log('\n== 3. artifacts ==')
const tdir = join(home, 'taskdir')
mkdirSync(tdir, { recursive: true })
writeFileSync(join(tdir, 'out.txt'), 'ok')
const task = ledger.createTask(db, { brief: { title: '产物任务', goal: 'g', acceptance: ['a'] }, coordinatorSession: 'main-1', targetDir: tdir })
ledger.transition(db, task.id, 'running', { sessionId: 'child-1', target: 'child-1' })
const report = await tool('task_report').execute({
  task_id: task.id,
  status: 'done',
  summary: '做完了',
  artifacts: [
    { path: 'out.txt', label: '结果文件' },
    { path: 'missing.txt', label: '缺失' },
    { path: '' },
    null,
    { path: 42 },
  ],
}, { agent: { id: 'child-1' } })
const stored = ledger.getTask(db, task.id)
check('artifacts 落库（非法条目丢弃）', stored.artifacts.length === 2, JSON.stringify(stored.artifacts))
check('相对路径按 target_dir 解析成绝对', stored.artifacts[0]?.path === join(tdir, 'out.txt') && isAbsolute(stored.artifacts[0].path))
check('存在性 only stat：存在 true / 缺失 false', stored.artifacts[0]?.exists === true && stored.artifacts[1]?.exists === false)
check('report 不因缺失产物失败', /已记录/.test(String(report)) && stored.status === 'done', String(report).slice(0, 40))
const noteDone = pushed[pushed.length - 1]
check('notifier 收到 artifacts', noteDone?.artifacts?.length === 2 && noteDone.status === 'done')

// 通知文本：单条 + 合并聚合
const texts = []
const notifier = createNotifier({ send: (text) => { texts.push(text) }, record: () => {}, mergeWindowMs: 1000 })
notifier.push({ taskId: 't1', title: '任务一', status: 'done', summary: '完成1', artifacts: [{ path: 'C:/a/1.txt', label: '一', exists: true }] })
notifier.push({ taskId: 't2', title: '任务二', status: 'done', summary: '完成2', artifacts: [{ path: 'C:/b/2.txt', exists: false }] })
await notifier.drain()
const merged = texts[texts.length - 1] ?? ''
check('合并通知聚合两条产物', merged.includes('C:/a/1.txt') && merged.includes('C:/b/2.txt'), merged.slice(0, 120))
check('缺失产物标「未找到」', merged.includes('未找到'))
const single = createNotifier({ send: (text) => texts.push(text), record: () => {}, mergeWindowMs: 1000 })
single.push({ taskId: 't3', title: '任务三', status: 'blocked', summary: '要确认', artifacts: [{ path: 'C:/c/3.txt', label: '三', exists: true }] })
await single.drain()
check('blocked 立即通知且带产物', (texts[texts.length - 1] ?? '').includes('产物') && (texts[texts.length - 1] ?? '').includes('C:/c/3.txt'), (texts[texts.length - 1] ?? '').slice(0, 100))

// 旧行为兼容：不传 artifacts，文本无「产物」
const legacyTexts = []
const legacy = createNotifier({ send: (text) => legacyTexts.push(text), record: () => {}, mergeWindowMs: 1000 })
legacy.push({ taskId: 't4', title: '旧任务', status: 'done', summary: '老样子' })
await legacy.drain()
const legacyText = legacyTexts[legacyTexts.length - 1] ?? ''
check('不传 artifacts 时文本保持旧格式', legacyText.includes('任务「旧任务」完成：老样子') && !legacyText.includes('产物'), legacyText)

// 快照与卡片形状
const route = createHostRoute({ db, coordinatorStatus: () => ({ id: 'main-1', live: true }) })
const snap = await (await route({ json: async () => ({ endpoint: 'snapshot' }) })).json()
const snapTask = snap.tasks.find((item) => item.id === task.id)
check('snapshot.tasks[].artifacts 形状', Array.isArray(snapTask?.artifacts) && snapTask.artifacts.length === 2
  && typeof snapTask.artifacts[0].path === 'string' && typeof snapTask.artifacts[0].exists === 'boolean', JSON.stringify(snapTask?.artifacts?.length))
check('card artifactCount', taskCard(stored).artifactCount === 2, String(taskCard(stored).artifactCount))

// 旧库迁移：没有 artifacts_json 的库
const oldHome = tmp('qa-inc-old-')
mkdirSync(join(oldHome, 'state', 'orchestrator'), { recursive: true })
const oldDb = new DatabaseSync(join(oldHome, 'state', 'orchestrator', 'tasks.sqlite'))
oldDb.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, goal TEXT NOT NULL, brief_json TEXT NOT NULL,
  status TEXT NOT NULL, session_id TEXT, target TEXT, target_dir TEXT, coordinator_session TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_event_at INTEGER NOT NULL,
  error TEXT, queued_at INTEGER)`)
oldDb.prepare("INSERT INTO tasks (id,title,goal,brief_json,status,coordinator_session,created_at,updated_at,last_event_at) VALUES ('t-old','old','g','{}','done','s',1,1,1)").run()
oldDb.close()
const migrated = await ledger.openLedger(join(oldHome, 'state', 'orchestrator'))
const cols = migrated.prepare('PRAGMA table_info(tasks)').all().map((row) => row.name)
const oldRow = migrated.prepare("SELECT * FROM tasks WHERE id = 't-old'").get()
const oldTask = ledger.getTask(migrated, 't-old')
check('旧库自动补 artifacts_json', cols.includes('artifacts_json'))
check('旧任务 artifacts 按空数组', Array.isArray(oldTask.artifacts) && oldTask.artifacts.length === 0, JSON.stringify(oldTask.artifacts))
migrated.close()

db.close()
clean(home)
clean(oldHome)
console.log(failures === 0 ? '\nRESULT: PASS' : `\nRESULT: FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
