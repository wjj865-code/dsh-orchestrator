#!/usr/bin/env node
/**
 * QA：主会话阶段 2 独立复核（Task 1–9 的跨模块行为）
 *
 * 用法: node docs/probes/qa-main-session.mjs
 * 退出码: 0 全 PASS；1 有 FAIL
 *
 * 不跑开发写的用例，只按计划 Task 1–9 的验收点自己构造输入：
 * 台账迁移 / target 校验 / cwd+preset 透传 / task_* 只允许主会话 / 主会话生命周期 / 装配与预设静态检查。
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const here = dirname(fileURLToPath(import.meta.url))
const src = (name) => import(new URL(`../../src/${name}`, import.meta.url))
const ledger = await src('ledger.js')
const { validateTargetDir, renderBrief } = await src('brief.js')
const { createSubagentDispatcher } = await src('dispatch.js')
const { createQueue } = await src('queue.js')
const { createTools } = await src('tools.js')
const { createMainSession, PRESET_ID } = await src('main-session.js')

let failures = 0
const check = (name, cond, detail = '') => {
  if (cond) console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`)
  else { failures += 1; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`) }
}
const tmp = (prefix) => mkdtempSync(join(tmpdir(), prefix))
const clean = (dir) => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ } }

// ================= Task 1: 台账 target_dir 与 main_session_id =================
console.log('\n== Task 1: 台账 ==')
{
  const dir = tmp('qa-ms-ledger-')
  const db = await ledger.openLedger(dir)
  const cols = db.prepare('PRAGMA table_info(tasks)').all().map((row) => row.name)
  check('新库 tasks 有 target_dir 列', cols.includes('target_dir'), cols.join(','))
  const withTarget = ledger.createTask(db, { brief: { title: 't', goal: 'g', acceptance: ['a'] }, coordinatorSession: 's', targetDir: 'C:/work' })
  check('createTask 落 target_dir', withTarget.target_dir === 'C:/work', String(withTarget.target_dir))
  const without = ledger.createTask(db, { brief: { title: 't2', goal: 'g', acceptance: ['a'] }, coordinatorSession: 's' })
  check('未给 target → null（不臆造）', without.target_dir === null, String(without.target_dir))
  check('main_session_id 初始 undefined', ledger.getMainSessionId(db) === undefined)
  ledger.setMainSessionId(db, 'session-main')
  check('main_session_id 读写', ledger.getMainSessionId(db) === 'session-main')
  db.close()
  clean(dir)

  // 旧 schema（无 target_dir）建库后再 openLedger，应自动补列且旧行不臆造
  const oldDir = tmp('qa-ms-old-')
  mkdirSync(oldDir, { recursive: true })
  const old = new DatabaseSync(join(oldDir, 'tasks.sqlite'))
  old.exec(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, goal TEXT NOT NULL, brief_json TEXT NOT NULL,
    status TEXT NOT NULL, session_id TEXT, target TEXT, coordinator_session TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    last_event_at INTEGER NOT NULL, error TEXT, queued_at INTEGER)`)
  old.prepare("INSERT INTO tasks (id,title,goal,brief_json,status,coordinator_session,created_at,updated_at,last_event_at) VALUES ('t-old','old','g','{}','pending','s',1,1,1)").run()
  old.close()
  const migrated = await ledger.openLedger(oldDir)
  const oldCols = migrated.prepare('PRAGMA table_info(tasks)').all().map((row) => row.name)
  check('旧库自动补 target_dir', oldCols.includes('target_dir'))
  const oldRow = migrated.prepare("SELECT target_dir FROM tasks WHERE id = 't-old'").get()
  check('旧行 target_dir 保持 null', oldRow.target_dir === null, String(oldRow.target_dir))
  migrated.close()
  clean(oldDir)
}

// ================= Task 2: brief 目标目录 =================
console.log('\n== Task 2: brief ==')
{
  check('相对路径拒绝', validateTargetDir('relative/dir') === 'target 必须是绝对路径')
  check('不存在的绝对路径拒绝', validateTargetDir('C:/qa-definitely-missing-xyz') === 'target 目录不存在或不是目录')
  const dir = tmp('qa-ms-brief-')
  check('真实目录通过', validateTargetDir(dir) === undefined)
  const filePath = join(dir, 'f.txt')
  writeFileSync(filePath, 'x')
  check('文件（非目录）拒绝', validateTargetDir(filePath) === 'target 目录不存在或不是目录')
  check('undefined 通过', validateTargetDir(undefined) === undefined)
  check('空串通过', validateTargetDir('') === undefined)
  clean(dir)

  const withTarget = renderBrief({ title: 't', goal: 'g', acceptance: ['a'], target: 'C:/work' })
  check('有 target 渲染【工作目录】', /【工作目录】C:\/work/.test(withTarget), withTarget.split('\n').slice(0, 3).join(' | '))
  check('【工作目录】在【目标】之后', withTarget.indexOf('【目标】') < withTarget.indexOf('【工作目录】'))
  const plain = renderBrief({ title: 't', goal: 'g', acceptance: ['a'] })
  check('无 target 不渲染【工作目录】', !/【工作目录】/.test(plain))
}

// ================= Task 3: 派发/队列 cwd 与 worker preset =================
console.log('\n== Task 3: cwd/preset ==')
{
  const calls = []
  const subagents = {
    startActivation: (spec) => {
      calls.push(spec)
      return Promise.resolve({ childId: spec.childId, result: Promise.resolve({}), dispose: async () => {} })
    },
    sendMessage: async () => {},
    interruptByParent: async () => {},
    listChildren: async () => [],
  }
  const parent = { id: 's-1', session: { header: { cwd: 'C:/parent' } } }
  const dispatcher = createSubagentDispatcher({ subagents, agent: parent })
  await dispatcher.spawn({ prompt: 'hi', cwd: 'C:/target' })
  check('cwd 优先 target', calls[0]?.request?.cwd === 'C:/target', String(calls[0]?.request?.cwd))
  check('默认 worker 预设', calls[0]?.request?.agentPreset === 'dsh-orchestrator-worker', String(calls[0]?.request?.agentPreset))
  await dispatcher.spawn({ prompt: 'hi' })
  check('缺省用父会话 cwd', calls[1]?.request?.cwd === 'C:/parent', String(calls[1]?.request?.cwd))
  const noCwdParent = { id: 's-2', session: { header: {} } }
  const dispatcher2 = createSubagentDispatcher({ subagents, agent: noCwdParent })
  await dispatcher2.spawn({ prompt: 'hi' })
  check('父子都无 cwd → 不带 cwd 键', !Object.hasOwn(calls[2]?.request ?? {}, 'cwd'), JSON.stringify(Object.keys(calls[2]?.request ?? {})))
  const custom = createSubagentDispatcher({ subagents, agent: parent, workerPreset: 'custom-worker' })
  await custom.spawn({ prompt: 'hi' })
  check('workerPreset 可覆盖', calls[3]?.request?.agentPreset === 'custom-worker', String(calls[3]?.request?.agentPreset))

  // queue 把 task.target_dir 透传成 cwd
  const dir = tmp('qa-ms-queue-')
  const db = await ledger.openLedger(dir)
  const targetTask = ledger.createTask(db, { brief: { title: 'qt', goal: 'g', acceptance: ['a'] }, coordinatorSession: 's', targetDir: 'C:/target2' })
  const plainTask = ledger.createTask(db, { brief: { title: 'qt2', goal: 'g', acceptance: ['a'] }, coordinatorSession: 's' })
  const spawnCalls = []
  const queue = createQueue({
    db,
    dispatcher: { spawn: async (spec) => { spawnCalls.push(spec); return { sessionId: `c-${spawnCalls.length}`, target: `c-${spawnCalls.length}` } }, stop: async () => {} },
    config: {},
    logger: { log() {} },
  })
  queue.enqueue(targetTask.id)
  await queue.pump()
  check('队列把 target_dir 传成 cwd', spawnCalls[0]?.cwd === 'C:/target2', String(spawnCalls[0]?.cwd))
  check('派发后任务转 running', ledger.getTask(db, targetTask.id).status === 'running', ledger.getTask(db, targetTask.id).status)
  queue.enqueue(plainTask.id)
  await queue.pump()
  check('无 target 的任务 cwd 为 undefined', spawnCalls[1]?.cwd === undefined, String(spawnCalls[1]?.cwd))
  db.close()
  clean(dir)
}

// ================= Task 4: task_* 只允许主会话 + target =================
console.log('\n== Task 4: 工具权限与 target ==')
{
  const dir = tmp('qa-ms-tools-')
  const db = await ledger.openLedger(dir)
  const makeTools = (status) => createTools({
    db,
    dispatcher: { spawn: async () => ({ sessionId: 'c', target: 'c' }), sendReliable: async () => {}, stop: async () => {} },
    queue: {
      pendingCount: () => 0,
      enqueueAndPump: async (id) => { ledger.transition(db, id, 'running', { sessionId: 'child-x', target: 'child-x' }); return { task: ledger.getTask(db, id), position: 1 } },
    },
    notifier: { notify: async () => {} },
    config: {},
    coordinatorStatus: status,
  })
  const tools = makeTools(() => ({ id: 'main-1', live: true }))
  const tool = (name) => tools.find((item) => item.name === name)
  for (const name of ['task_create', 'task_list', 'task_status', 'task_message', 'task_stop']) {
    const output = await tool(name).execute({ title: 't', goal: 'g', acceptance: ['a'], task_id: 't-x', message: 'm' }, { agent: { id: 'other-1' } })
    check(`${name} 非主会话被拒`, /主会话/.test(String(output)), String(output).slice(0, 40))
  }
  const report = await tool('task_report').execute({ status: 'progress', summary: 'x' }, { agent: { id: 'other-1' } })
  check('task_report 不要求主会话', !/请从主会话操作任务/.test(String(report)), String(report).slice(0, 40))

  const noMain = makeTools(() => ({ id: undefined, live: false }))
  const unbound = await noMain.find((item) => item.name === 'task_create').execute({ title: 't', goal: 'g', acceptance: ['a'] }, { agent: { id: 'any' } })
  check('无主会话 → 提示先打开主会话', /尚未打开主会话/.test(String(unbound)), String(unbound))

  const badTarget = await tool('task_create').execute({ title: 'tt', goal: 'g', acceptance: ['a'], target: 'relative' }, { agent: { id: 'main-1' } })
  check('相对 target 被拒', /绝对路径/.test(String(badTarget)), String(badTarget))
  check('被拒后不落库', db.prepare("SELECT count(*) AS n FROM tasks WHERE title = 'tt'").get().n === 0)
  const realTarget = tmp('qa-ms-target-')
  const created = await tool('task_create').execute({ title: 'tt2', goal: 'g', acceptance: ['a'], target: realTarget }, { agent: { id: 'main-1' } })
  check('合法 target 派发成功', /已派发/.test(String(created)), String(created).slice(0, 60))
  const row = db.prepare("SELECT target_dir, session_id FROM tasks WHERE title = 'tt2'").get()
  check('target_dir 落库', row.target_dir === realTarget, String(row.target_dir))
  check('派发后 session_id 落库', typeof row.session_id === 'string' && row.session_id !== '', String(row.session_id))
  clean(realTarget)
  db.close()
  clean(dir)
}

// ================= Task 5: 主会话生命周期 =================
console.log('\n== Task 5: 主会话生命周期 ==')
{
  const makeFake = ({ live = [] } = {}) => {
    const set = new Set(live)
    const state = { created: [], renamed: [], workspaces: [] }
    return {
      state,
      agents: { get: (id) => set.has(id) ? { id, session: { id } } : undefined },
      sessionController: {
        create: async (request) => { state.created.push(request); return { sessionId: 'session-main-new' } },
        rename: async (request) => { state.renamed.push(request) },
      },
      workspaces: {
        resolveByPath: () => undefined,
        create: async (path, title) => { state.workspaces.push([path, title]); return { id: 'ws-new' } },
      },
    }
  }
  const dir = tmp('qa-ms-main-')
  const workspacePath = join(dir, '指挥舱')

  {
    const db = await ledger.openLedger(tmp('qa-ms-main-db-'))
    const f = makeFake()
    const main = createMainSession({ db, config: {}, agents: f.agents, sessionController: f.sessionController, workspaces: f.workspaces, workspacePath, workspaceName: '指挥舱' })
    const result = await main.open()
    check('无主会话 → 创建并写台账', result.ok === true && result.created === true && ledger.getMainSessionId(db) === 'session-main-new', JSON.stringify(result))
    check('创建时带协调者预设', f.state.created[0]?.agentPreset === PRESET_ID, String(f.state.created[0]?.agentPreset))
    check('创建时不传 title（rename 承担）', !Object.hasOwn(f.state.created[0] ?? {}, 'title'))
    check('工作区先建好再建会话', f.state.workspaces[0]?.[0] === workspacePath && f.state.workspaces[0]?.[1] === '指挥舱', JSON.stringify(f.state.workspaces))
    check('标题 rename 成「主会话」', f.state.renamed[0]?.title === '主会话' && f.state.renamed[0]?.sessionId === 'session-main-new', JSON.stringify(f.state.renamed))
    db.close()
  }
  {
    const db = await ledger.openLedger(tmp('qa-ms-main-db-'))
    const f = makeFake()
    f.workspaces.resolveByPath = (path) => path === workspacePath ? { id: 'ws-1', path } : undefined
    const main = createMainSession({ db, config: {}, agents: f.agents, sessionController: f.sessionController, workspaces: f.workspaces, workspacePath })
    const result = await main.open()
    check('已有指挥舱工作区 → 复用不重建', result.created === true && f.state.workspaces.length === 0 && f.state.created[0]?.workspaceId === 'ws-1', JSON.stringify(f.state.created[0]))
    db.close()
  }
  {
    const db = await ledger.openLedger(tmp('qa-ms-main-db-'))
    ledger.setMainSessionId(db, 'session-main-old')
    const f = makeFake({ live: ['session-main-old'] })
    const main = createMainSession({ db, config: {}, agents: f.agents, sessionController: f.sessionController, workspaces: f.workspaces, workspacePath })
    const result = await main.open()
    check('主会话 live → 直接复用不重建', result.ok === true && result.created === false && result.sessionId === 'session-main-old' && f.state.created.length === 0, JSON.stringify(result))
    db.close()
  }
  {
    const db = await ledger.openLedger(tmp('qa-ms-main-db-'))
    const f = makeFake()
    const main = createMainSession({ db, config: { coordinatorSession: 'session-override' }, agents: f.agents, sessionController: f.sessionController, workspaces: f.workspaces, workspacePath })
    const result = await main.open()
    check('override 失效 → 报错不创建', result.ok === false && /未加载/.test(result.error) && f.state.created.length === 0, JSON.stringify(result))
    db.close()
  }
  {
    const db = await ledger.openLedger(tmp('qa-ms-main-db-'))
    const f = makeFake()
    const main = createMainSession({ db, config: { spawnProvider: 'fork' }, agents: f.agents, sessionController: f.sessionController, workspaces: f.workspaces, workspacePath })
    const result = await main.open()
    check('spawnProvider=fork → 拒绝且不写库', result.ok === false && /spawn/.test(result.error) && f.state.created.length === 0 && ledger.getMainSessionId(db) === undefined, JSON.stringify(result))
    db.close()
  }
  {
    const db = await ledger.openLedger(tmp('qa-ms-main-db-'))
    const f = makeFake()
    f.sessionController.create = async () => { throw new Error('boom') }
    const main = createMainSession({ db, config: {}, agents: f.agents, sessionController: f.sessionController, workspaces: f.workspaces, workspacePath })
    const result = await main.open()
    check('创建失败 → 不写台账', result.ok === false && /创建主会话失败/.test(result.error) && ledger.getMainSessionId(db) === undefined, JSON.stringify(result))
    db.close()
  }
  {
    const db = await ledger.openLedger(tmp('qa-ms-main-db-'))
    const f = makeFake()
    const logs = []
    f.sessionController.rename = async () => { throw new Error('rename-boom') }
    const main = createMainSession({ db, config: {}, agents: f.agents, sessionController: f.sessionController, workspaces: f.workspaces, workspacePath, log: (event) => logs.push(event) })
    const result = await main.open()
    check('rename 失败仍可用且记日志', result.ok === true && ledger.getMainSessionId(db) === 'session-main-new' && logs.includes('main.session.rename.failed'), JSON.stringify({ result, logs }))
    db.close()
  }
  clean(dir)
}

// ================= Task 6/7: 装配与路由静态检查 =================
console.log('\n== Task 6/7: 装配 ==')
{
  const indexSource = readFileSync(join(here, '..', '..', 'index.js'), 'utf8')
  check('不再调用自动绑定', !/\bbindSettingOnce\s*\(/.test(indexSource) && !/\brebindSetting\s*\(/.test(indexSource))
  check('不再写旧的 coordinator_session_id 键', !/COORDINATOR_KEY/.test(indexSource), (indexSource.match(/COORDINATOR_KEY/g) ?? []).length + ' 处')
  check('装配 createMainSession', /createMainSession/.test(indexSource))
  check('open-main 交给 mainSession.open', /openMain\s*:\s*[^,\n]*mainSession\.open|openMain\s*:\s*\(\)\s*=>\s*mainSession\.open/.test(indexSource))
  check('工具层收 coordinatorStatus', /coordinatorStatus/.test(indexSource))
  const routeSource = readFileSync(join(here, '..', '..', 'src', 'host-route.js'), 'utf8')
  check('route 只 import 查询函数与 taskCard', [/listTasks/.test(routeSource), /listHistoryTasks/.test(routeSource), /taskCard/.test(routeSource)].every(Boolean))
  check('route 不直接写台账', !/\b(createTask|transition|setSetting|setMainSessionId)\s*\(/.test(routeSource))
}

// ================= Task 9: 预设与打包清单 =================
console.log('\n== Task 9: 预设/打包 ==')
{
  const patch = readFileSync(join(here, '..', '..', 'cordis.patch.yml'), 'utf8')
  check('协调者预设存在', /id:\s*dsh-orchestrator-coordinator/.test(patch))
  check('worker 预设存在', /id:\s*dsh-orchestrator-worker/.test(patch))
  check('preset-tools 行在协调者预设里', /preset-tools/.test(patch))
  check('compaction 组在协调者预设里', /compaction-basic/.test(patch) && /tool-result-pruner/.test(patch))
  const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8'))
  check("exports['./preset-tools'] 存在", pkg.exports?.['./preset-tools'] === './preset-tools.js', JSON.stringify(pkg.exports))
  check('files 含 preset-tools.js', Array.isArray(pkg.files) && pkg.files.includes('preset-tools.js'), JSON.stringify(pkg.files))
  check('preset-tools.js 存在', (() => { try { readFileSync(join(here, '..', '..', 'preset-tools.js')); return true } catch { return false } })())
}

console.log(failures === 0 ? '\nRESULT: PASS' : `\nRESULT: FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
