// P8 子任务计划模式：纯映射、台账两列、task_create/task_message 契约、派发进入/退出、
// 面板与 task_status 视图。运行期真相在会话日志（plan/mode），台账只存编排视图
// （plan_first / plan_state），所以这里既断运行期调用，也断台账视图。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openLedger, createTask, getTask, listTasks, transition, setPlanState } from '../src/ledger.js'
import { createTools } from '../src/tools.js'
import { createQueue } from '../src/queue.js'
import { createSubagentDispatcher, createTeamDispatcher } from '../src/dispatch.js'
import { createHostRoute } from '../src/host-route.js'
import { createPanelActions } from '../src/panel-actions.js'
import { renderTaskDetail } from '../src/task-detail.js'
import {
  PLAN_STATE_LABEL, PLAN_FIRST_DETAIL, EXIT_PLAN_MODE_DENIAL, planListMarker, planStatusLine,
} from '../src/plan-mode.js'
import { keepAliveSkipReason } from '../src/keepalive.js'
import { tempDir, sampleBrief, markDone } from './helpers.js'

const tick = () => new Promise(resolve => setImmediate(resolve))

const planTaskRow = (db, { status = 'running' } = {}) => {
  const task = createTask(db, { brief: sampleBrief({ title: '计划任务', goal: 'g' }), coordinatorSession: 's-1', planFirst: true })
  if (status !== 'pending') transition(db, task.id, 'running', { sessionId: 'c-1', target: 'c-1' })
  if (status === 'waiting_user') transition(db, task.id, 'waiting_user')
  if (status === 'cancelled') transition(db, task.id, 'cancelled')
  return getTask(db, task.id)
}

// —— 一、纯映射：文案/标记只从这里来，避免工具与面板各写一套 ——

test('P8 计划状态映射：列表只标 planning，status 行区分 planning/approved/rejected', () => {
  assert.deepEqual(Object.keys(PLAN_STATE_LABEL), ['none', 'planning', 'approved', 'rejected'])
  const task = { id: 't-1', plan_first: true, plan_state: 'planning' }
  assert.equal(planListMarker(task), '·计划中')
  assert.match(planStatusLine(task), /计划中/)
  assert.match(planStatusLine(task), /task_message/)
  assert.equal(planListMarker({ id: 't-1', plan_first: true, plan_state: 'approved' }), '')
  assert.match(planStatusLine({ id: 't-1', plan_first: true, plan_state: 'approved' }), /已批准/)
  assert.match(planStatusLine({ id: 't-1', plan_first: true, plan_state: 'rejected' }), /未批准/)
  // 非计划任务不加任何字样。
  assert.equal(planListMarker({ id: 't-1', plan_first: false, plan_state: 'none' }), '')
  assert.equal(planStatusLine({ id: 't-1', plan_first: false, plan_state: 'none' }), undefined)
})

test('P8 exit_plan_mode 拒绝文案指向 task_report blocked（不是 exit_plan_mode）', () => {
  assert.match(EXIT_PLAN_MODE_DENIAL, /task_report/)
  assert.match(EXIT_PLAN_MODE_DENIAL, /blocked/)
  assert.match(EXIT_PLAN_MODE_DENIAL, /exit_plan_mode 在编排子任务里不可用/)
  // 计划阶段说明必须写明「写被拒是预期」、唯一写入口是 plan_save、不动 exit_plan_mode。
  assert.match(PLAN_FIRST_DETAIL, /这是预期行为/)
  assert.match(PLAN_FIRST_DETAIL, /task_report 报 blocked/)
  assert.match(PLAN_FIRST_DETAIL, /不要调用 exit_plan_mode/)
  // 计划交付流程：先落盘（plan_save → reports/plans/<taskId>.md），再只报 3–8 行摘要 + 绝对路径 + 待拍板清单。
  assert.match(PLAN_FIRST_DETAIL, /plan_save/)
  assert.match(PLAN_FIRST_DETAIL, /reports\/plans\/<taskId>\.md/)
  assert.match(PLAN_FIRST_DETAIL, /3–8 行摘要/)
  assert.match(PLAN_FIRST_DETAIL, /待拍板问题清单/)
  assert.match(PLAN_FIRST_DETAIL, /唯一.*写入口/)
  assert.match(EXIT_PLAN_MODE_DENIAL, /plan_save/)
  assert.match(EXIT_PLAN_MODE_DENIAL, /reports\/plans\/<taskId>\.md/)
})

test('P8 keep-alive：等批准的计划任务（waiting_user）不会被当成可续跑', async () => {
  const db = await openLedger(tempDir())
  const task = planTaskRow(db, { status: 'waiting_user' })
  assert.equal(task.status, 'waiting_user')
  assert.equal(keepAliveSkipReason({
    enabled: true,
    agentStatus: 'running',
    task,
    goalState: { phase: 'active' },
    rounds: 0,
    maxRounds: 8,
  }), 'task-not-running')
  db.close()
})

// —— 二、台账：两列 + 旧库补列 + 终态收口 ——

test('P8 台账：默认 false/none；planFirst 落库 planning', async () => {
  const db = await openLedger(tempDir())
  const normal = createTask(db, { brief: sampleBrief(), coordinatorSession: 's-1' })
  assert.equal(normal.plan_first, false)
  assert.equal(normal.plan_state, 'none')
  const plan = createTask(db, { brief: sampleBrief(), coordinatorSession: 's-1', planFirst: true })
  assert.equal(plan.plan_first, true)
  assert.equal(plan.plan_state, 'planning')
  assert.equal(getTask(db, plan.id).plan_first, true)
  // setPlanState 只改视图，不动 status。
  const approved = setPlanState(db, plan.id, 'approved')
  assert.equal(approved.plan_state, 'approved')
  assert.equal(approved.status, 'pending')
  db.close()
})

test('P8 台账：旧库自动补 plan_first/plan_state，旧行读成 false/none', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-plan-legacy-'))
  const { DatabaseSync } = await import('node:sqlite')
  const legacy = new DatabaseSync(join(dir, 'tasks.sqlite'))
  legacy.exec(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, goal TEXT NOT NULL, brief_json TEXT NOT NULL,
    status TEXT NOT NULL, session_id TEXT, target TEXT, coordinator_session TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    last_event_at INTEGER NOT NULL, error TEXT, queued_at INTEGER)`)
  legacy.prepare(`INSERT INTO tasks (id, title, goal, brief_json, status, coordinator_session, created_at, updated_at, last_event_at)
    VALUES ('t-old', '旧任务', 'g', '{}', 'done', 's-1', 1, 1, 1)`).run()
  legacy.close()
  const db = await openLedger(dir)
  const cols = db.prepare('PRAGMA table_info(tasks)').all().map(row => row.name)
  assert.ok(cols.includes('plan_first'))
  assert.ok(cols.includes('plan_state'))
  const row = getTask(db, 't-old')
  assert.equal(row.plan_first, false)
  assert.equal(row.plan_state, 'none')
  db.close()
})

test('P8 台账：计划任务在「等批准」时进终态按 rejected 收口；已批准保持 approved', async () => {
  const db = await openLedger(tempDir())
  const stopped = planTaskRow(db, { status: 'waiting_user' })
  transition(db, stopped.id, 'cancelled')
  assert.equal(getTask(db, stopped.id).plan_state, 'rejected')

  const approved = planTaskRow(db)
  setPlanState(db, approved.id, 'approved')
  markDone(db, approved.id)
  assert.equal(getTask(db, approved.id).plan_state, 'approved')

  // 普通任务不受影响（即使 plan_state 被写成 planning 的脏数据，也不在终态改非计划任务之外的行为）。
  const plain = createTask(db, { brief: sampleBrief({ title: '普通' }), coordinatorSession: 's-1' })
  transition(db, plain.id, 'running', { sessionId: 'c-9', target: 'c-9' })
  transition(db, plain.id, 'cancelled')
  assert.equal(getTask(db, plain.id).plan_state, 'none')
  db.close()
})

// —— 三、工具层：planFirst 契约 + 批准链路 ——

function fakeDispatcher({ failSend = false } = {}) {
  const calls = []
  let counter = 0
  return {
    calls,
    async spawn(input) {
      calls.push(['spawn', input])
      counter += 1
      return { id: `c-${counter}`, name: input.name, sessionId: `c-${counter}`, target: `c-${counter}` }
    },
    async sendReliable(target, message, signal, targetDir, taskId, readOnly) {
      calls.push(['sendReliable', target, message, readOnly])
      if (failSend) throw new Error('投递超时')
      return { messageId: 'm-1' }
    },
    async approvePlan(target, targetDir) {
      calls.push(['approvePlan', target, targetDir])
      return { ok: true, sandbox: 'workspace-write', planMode: 'committed' }
    },
    async stop(target) { calls.push(['stop', target]) },
    releaseWritableRoots(target) { calls.push(['release', target]) },
    slug(title) { counter += 1; return `task-${counter}` },
  }
}

async function setupTools(options = {}) {
  const db = await openLedger(tempDir())
  const dispatcher = fakeDispatcher(options)
  const notifier = { pushed: [], push(item) { this.pushed.push(item) } }
  const config = { staleMinutes: 30, maxQueue: 50, coordinatorSession: 's-1', ...(options.config ?? {}) }
  const queue = createQueue({ db, dispatcher, config })
  const tools = Object.fromEntries(createTools({
    db, dispatcher, queue, notifier, config,
    coordinatorStatus: () => ({ id: 's-1', live: true }),
  }).map(tool => [tool.name, tool]))
  return { db, dispatcher, queue, notifier, tools }
}

const mainCall = (tools, name, args, exec) => tools[name].execute(args, { agent: { id: 's-1' }, ...(exec ?? {}) })

test('P8 task_create：planFirst 落库 + 派发透传 + 工具结果带批准指引', async () => {
  const { db, dispatcher, tools } = await setupTools()
  const text = await mainCall(tools, 'task_create', sampleBrief({ title: '计划A', goal: '目标A', planFirst: true }), {})
  assert.match(text, /已派发/)
  assert.match(text, /计划模式/)
  const [task] = listTasks(db, { active: true })
  assert.equal(task.plan_first, true)
  assert.equal(task.plan_state, 'planning')
  const spawn = dispatcher.calls.find(item => item[0] === 'spawn')
  assert.equal(spawn[1].planFirst, true)
  assert.equal(spawn[1].readOnly, false)
  // prompt 仍是纯指引（计划说明在 task_detail 里，不内联进提示词）。
  assert.equal(spawn[1].prompt.includes('计划阶段'), false)

  const detail = await tools.task_detail.execute({ task_id: task.id }, { agent: { id: task.session_id } })
  assert.match(detail, /计划状态：计划中（等批准）/)
  assert.match(detail, /【计划阶段】/)
  assert.match(detail, /权限：只读/)
  assert.match(detail, /task_report 报 blocked/)
  db.close()
})

test('P8 task_create：字符串 "true" 不生效（只认显式布尔）', async () => {
  const { db, tools } = await setupTools()
  await mainCall(tools, 'task_create', sampleBrief({ title: '字符串', planFirst: 'true' }), {})
  const [task] = listTasks(db, { active: true })
  assert.equal(task.plan_first, false)
  assert.equal(task.plan_state, 'none')
  db.close()
})

test('P8 task_create：planFirst 与 readOnly 互斥，创建期拒绝且不建任务', async () => {
  const { db, dispatcher, tools } = await setupTools()
  const text = await mainCall(tools, 'task_create', sampleBrief({ title: '冲突', planFirst: true, readOnly: true }), {})
  assert.match(text, /互斥/)
  assert.match(text, /二选一/)
  assert.equal(listTasks(db).length, 0)
  assert.equal(dispatcher.calls.length, 0)
  db.close()
})

test('P8 task_list/task_status：计划中标记只给等待批准的任务', async () => {
  const { db, tools } = await setupTools()
  planTaskRow(db, { status: 'waiting_user' })
  const approved = planTaskRow(db)
  setPlanState(db, approved.id, 'approved')
  const plain = createTask(db, { brief: sampleBrief({ title: '普通' }), coordinatorSession: 's-1' })
  transition(db, plain.id, 'running', { sessionId: 'c-8', target: 'c-8' })

  const list = await mainCall(tools, 'task_list', {})
  assert.match(list, /计划中/)
  const status = await mainCall(tools, 'task_status', { task_id: planTaskRow(db, { status: 'waiting_user' }).id })
  assert.match(status, /计划：计划中/)
  assert.match(status, /task_message/)
  const approvedStatus = await mainCall(tools, 'task_status', { task_id: approved.id })
  assert.match(approvedStatus, /计划：已批准/)
  const plainStatus = await mainCall(tools, 'task_status', { task_id: plain.id })
  assert.equal(plainStatus.includes('计划：'), false)
  assert.equal(plainStatus.includes('计划中'), false)
  db.close()
})

test('P8 task_message：等批准的任务续派成功 = 批准（切沙箱 + plan_state=approved）', async () => {
  const { db, dispatcher, tools } = await setupTools()
  const task = planTaskRow(db, { status: 'waiting_user' })
  const text = await mainCall(tools, 'task_message', { task_id: task.id, message: '批准执行' })
  assert.match(text, /计划已批准/)
  assert.equal(getTask(db, task.id).plan_state, 'approved')
  assert.equal(getTask(db, task.id).status, 'running')
  assert.ok(dispatcher.calls.some(item => item[0] === 'approvePlan'))
  db.close()
})

// 用户现场（t-2aa984e5）：计划子会话 task_report blocked 后，批准要回到 running 并在**原子会话**里继续，
// 不能新建 activation/新会话。这条同时锁住「谁负责状态迁移」（task_message 投递成功 → transition）与
// 「续派复用 sessionId」（dispatcher.sendReliable(target=task.target)，不是 spawn）。
test('P8 生命周期：blocked → 批准续派 → 回 running 且复用原会话（不新建）', async () => {
  const { db, dispatcher, tools } = await setupTools()
  const task = planTaskRow(db)
  await tools.task_report.execute(
    { task_id: task.id, status: 'blocked', summary: '计划已就绪', question: '批准执行？', options: ['批准执行', '调整计划'] },
    { agent: { id: task.session_id } },
  )
  const blocked = getTask(db, task.id)
  assert.equal(blocked.status, 'waiting_user')
  assert.equal(blocked.question, '批准执行？')
  const text = await mainCall(tools, 'task_message', { task_id: task.id, message: '批准执行' })
  assert.match(text, /计划已批准/)
  const resumed = getTask(db, task.id)
  assert.equal(resumed.status, 'running')
  assert.equal(resumed.question, null)
  assert.equal(resumed.target, task.target)
  const send = dispatcher.calls.filter(item => item[0] === 'sendReliable').at(-1)
  assert.equal(send[1], task.target)
  assert.equal(dispatcher.calls.some(item => item[0] === 'spawn'), false)
  db.close()
})

test('P8 task_message：投递失败不改计划状态（仍在等你确认）', async () => {
  const { db, dispatcher, tools } = await setupTools({ failSend: true })
  const task = planTaskRow(db, { status: 'waiting_user' })
  const text = await mainCall(tools, 'task_message', { task_id: task.id, message: '批准执行' })
  assert.match(text, /投递/)
  assert.equal(getTask(db, task.id).plan_state, 'planning')
  assert.equal(getTask(db, task.id).status, 'waiting_user')
  assert.equal(dispatcher.calls.some(item => item[0] === 'approvePlan'), false)
  db.close()
})

test('P8 task_message：running 中的计划任务收到普通消息不算批准', async () => {
  const { db, dispatcher, tools } = await setupTools()
  const task = planTaskRow(db, { status: 'running' })
  await mainCall(tools, 'task_message', { task_id: task.id, message: '再补充一点' })
  assert.equal(getTask(db, task.id).plan_state, 'planning')
  assert.equal(dispatcher.calls.some(item => item[0] === 'approvePlan'), false)
  db.close()
})

test('P8 task_stop：停止计划任务 → rejected，并释放子会话', async () => {
  const { db, dispatcher, tools } = await setupTools()
  const task = planTaskRow(db, { status: 'waiting_user' })
  const text = await mainCall(tools, 'task_stop', { task_id: task.id })
  assert.match(text, /已停止/)
  const stopped = getTask(db, task.id)
  assert.equal(stopped.status, 'cancelled')
  assert.equal(stopped.plan_state, 'rejected')
  assert.ok(dispatcher.calls.some(item => item[0] === 'stop'))
  db.close()
})

test('P8 task_retry：计划任务重派后重新进入计划阶段', async () => {
  const { db, dispatcher, tools } = await setupTools()
  const task = planTaskRow(db, { status: 'running' })
  transition(db, task.id, 'failed', { error: '炸了' })
  const text = await mainCall(tools, 'task_retry', { task_id: task.id })
  assert.match(text, /已重派/)
  const retried = listTasks(db, { active: true }).find(item => item.retry_of === task.id)
  assert.equal(retried.plan_first, true)
  assert.equal(retried.plan_state, 'planning')
  const spawn = dispatcher.calls.filter(item => item[0] === 'spawn').at(-1)
  assert.equal(spawn[1].planFirst, true)
  db.close()
})

test('P8 task_detail 纯渲染：计划任务权限显示只读、批准后显示可写', () => {
  const base = {
    id: 't-1', title: '计划', goal: 'g', status: 'running', plan_first: true, plan_state: 'planning',
    brief: { title: '计划', goal: 'g', acceptance: ['a'], target: 'C:/work' },
  }
  const planning = renderTaskDetail(base)
  assert.match(planning, /权限：只读/)
  assert.match(planning, /计划状态：计划中（等批准）/)
  assert.match(planning, /【计划阶段】/)
  const approved = renderTaskDetail({ ...base, plan_state: 'approved' })
  assert.match(approved, /权限：可写/)
  assert.match(approved, /计划状态：已批准执行/)
  // 非计划任务的详情不出现计划字样。
  const plain = renderTaskDetail({ ...base, plan_first: false, plan_state: 'none' })
  assert.equal(plain.includes('计划阶段'), false)
  assert.equal(plain.includes('计划状态'), false)
})

// —— 四、派发层：进入（只读 + plan mode + guard）、退出（切可写 + plan off + 释放 guard）——

const coordinator = { id: 's-1', session: { id: 's-1', header: { cwd: 'C:/parent' } } }

function planEnv({ service = true, hookOnStart = false, ctxStyle = 'plain', presetService = false } = {}) {
  const sandboxEvents = []
  const modes = new Map()
  const planEvents = []
  const warnings = []
  const guards = []
  const guardRecords = []
  const registrations = []
  const agentsById = new Map()
  const sessionsById = new Map()
  const hooks = []
  const planMode = service
    ? {
      set(agent, active) { planEvents.push([agent.id, active]); return 'committed' },
      get() { return { active: false } },
    }
    : undefined
  // 宿主 cordis 的 ctx 是 Proxy：读「fiber 链上拿不到、又没声明 inject」的服务属性会直接抛
  // `cannot get property "x" without inject`（cordis src/reflect.ts 的 get trap）。
  // 真机 planFirst 创建失败就是踩到这条；测试替身必须能复现同样的语义，否则会漏掉回归。
  const cordisLikeCtx = services => new Proxy({ get: name => services[name], ...services }, {
    get(target, prop) {
      if (Reflect.has(target, prop)) return Reflect.get(target, prop)
      const error = new Error(`cannot get property "${String(prop)}" without inject`)
      throw error
    },
  })
  const registerAgent = id => {
    const toolService = {
      guard(fn) {
        guards.push(fn)
        const record = { fn, disposed: false }
        guardRecords.push(record)
        return () => { record.disposed = true }
      },
    }
    const services = { tools: toolService }
    if (planMode !== undefined) services.planMode = planMode
    if (presetService) {
      // 宿主公开 API：读 agent 预设 isolate 组里的服务（plan-mode 实际装在 preset 的隔离域）。
      services.agentPresets = {
        serviceFor(agent, name) { return name === 'planMode' ? planMode : undefined },
      }
    }
    const ctx = ctxStyle === 'cordis'
      ? cordisLikeCtx(services)
      : { get: name => (name === 'planMode' ? services.planMode : undefined), planMode: services.planMode, tools: toolService }
    const agent = {
      id,
      session: sessionsById.get(id),
      ctx,
    }
    agentsById.set(id, agent)
    return agent
  }
  const subagents = {
    async startActivation(spec) {
      const session = {
        id: spec.childId,
        header: { cwd: 'C:\\work' },
        append(event, payload) {
          sandboxEvents.push({ id: spec.childId, event, payload })
          if (event === 'sandbox/mode') modes.set(spec.childId, payload.mode)
        },
      }
      sessionsById.set(spec.childId, session)
      const agent = registerAgent(spec.childId)
      if (hookOnStart) {
        await tick()
        for (const hook of hooks) hook(agent)
      }
      return { childId: spec.childId, messageId: 'm1', result: new Promise(() => {}), dispose: async () => {} }
    },
    async sendMessage() { return 'm' },
    async interruptByParent() {},
    async listChildren() { return [] },
  }
  const sandboxPolicy = {
    overrideOf: session => modes.get(session.id),
    registerWritableRoot(session, dir) {
      registrations.push([session.id, dir])
      return () => {}
    },
  }
  const dispatcher = createSubagentDispatcher({
    subagents,
    agent: coordinator,
    agents: () => ({ get: id => agentsById.get(id) }),
    sessions: () => ({ get: id => sessionsById.get(id) }),
    sandboxPolicy: () => sandboxPolicy,
    onAgentCreated: handler => { hooks.push(handler) },
    onWarn: message => { warnings.push(message) },
    onEvent: () => {},
    sessionWaitMs: 0,
  })
  return {
    dispatcher, sandboxEvents, modes, planEvents, warnings, guards, guardRecords, registrations,
    agentsById, sessionsById,
  }
}

const sandboxModeEvents = env => env.sandboxEvents.filter(item => item.event === 'sandbox/mode')

test('P8 派发：计划任务设只读沙箱 + planMode.set(true) + agent 作用域 exit guard', async () => {
  const env = planEnv()
  const member = await env.dispatcher.spawn({ prompt: 'p', cwd: 'C:/target', planFirst: true })
  assert.equal(sandboxModeEvents(env).length, 1)
  assert.deepEqual(sandboxModeEvents(env)[0].payload, { mode: 'read-only' })
  assert.deepEqual(env.planEvents, [[member.id, true]])
  assert.equal(env.guards.length, 1)
  const childAgent = env.agentsById.get(member.id)
  assert.equal(env.guards[0]({ name: 'exit_plan_mode', agent: childAgent }), EXIT_PLAN_MODE_DENIAL)
  // 别的会话（协调者）与别的工具都不受影响。
  assert.equal(env.guards[0]({ name: 'exit_plan_mode', agent: { id: 's-1' } }), undefined)
  assert.equal(env.guards[0]({ name: 'task_list', agent: childAgent }), undefined)
  // 计划阶段不注册 target 可写根（批准后由 send/approvePlan 补）。
  assert.deepEqual(env.registrations, [])
})

test('P8 派发：agent/created 先生效（首回合窗口），激活后不重复设置', async () => {
  const env = planEnv({ hookOnStart: true })
  await env.dispatcher.spawn({ prompt: 'p', cwd: 'C:/target', planFirst: true })
  await tick()
  assert.equal(sandboxModeEvents(env).length, 1)
  assert.equal(env.planEvents.length, 1)
  assert.equal(env.planEvents[0][1], true)
  assert.equal(env.guards.length, 1)
})

test('P8 派发：普通任务一次 plan mode / guard / 只读都不碰（可写根照旧）', async () => {
  const env = planEnv({ hookOnStart: true })
  await env.dispatcher.spawn({ prompt: 'p', cwd: 'C:/target' })
  await tick()
  assert.deepEqual(env.planEvents, [])
  assert.deepEqual(env.guards, [])
  assert.deepEqual(sandboxModeEvents(env), [])
  assert.equal(env.registrations.length, 1)
})

test('P8 派发：planMode 服务缺失只 warn 降级，只读沙箱仍生效', async () => {
  const env = planEnv({ service: false })
  const member = await env.dispatcher.spawn({ prompt: 'p', planFirst: true })
  assert.equal(sandboxModeEvents(env).length, 1)
  assert.match(env.warnings.join('\n'), /planMode 服务不可用/)
  assert.equal(env.planEvents.length, 0)
  // agent 作用域 guard 仍装上（不依赖 planMode 服务）。
  assert.equal(env.guards.length, 1)
  assert.ok(member.id)
})

// 回归（真机 t-e36f85f3）：planFirst 创建时报 `cannot get property "planMode" without inject`。
// 原因是宿主 cordis 代理在服务不可见时读属性会抛，插件把「读不到 = 降级」写成了裸属性访问。
test('P8 派发：cordis 代理读 ctx.planMode 会抛 —— 服务不可见时必须降级而不是让创建失败', async () => {
  const env = planEnv({ service: false, ctxStyle: 'cordis' })
  const member = await env.dispatcher.spawn({ prompt: 'p', planFirst: true })
  assert.ok(member.id)
  assert.equal(sandboxModeEvents(env).length, 1)
  assert.deepEqual(sandboxModeEvents(env)[0].payload, { mode: 'read-only' })
  assert.equal(env.planEvents.length, 0)
  assert.match(env.warnings.join('\n'), /planMode 服务不可用/)
  // exit guard 仍装上（读 ctx.tools 是已有服务，不触发代理抛错）。
  assert.equal(env.guards.length, 1)
})

test('P8 派发：planMode 装在预设隔离域时走 agentPresets.serviceFor，不碰会抛的属性读', async () => {
  const env = planEnv({ ctxStyle: 'cordis', presetService: true })
  const member = await env.dispatcher.spawn({ prompt: 'p', cwd: 'C:/target', planFirst: true })
  assert.deepEqual(env.planEvents, [[member.id, true]])
  assert.equal(env.warnings.length, 0)
})

test('P8 生命周期：只读任务 blocked 续派 → 回 running 但明说仍是只读（不伪装可写）', async () => {
  const { db, dispatcher, tools } = await setupTools()
  const task = createTask(db, { brief: sampleBrief({ title: '只读核查' }), coordinatorSession: 's-1', readOnly: true })
  transition(db, task.id, 'running', { sessionId: 'c-2', target: 'c-2' })
  transition(db, task.id, 'waiting_user')
  const text = await mainCall(tools, 'task_message', { task_id: task.id, message: '按这个计划做' })
  // 真机 t-2aa984e5：协调者以为「续派 = 可以继续落地」，实际仍是只读，最后新开任务/新会话。
  assert.match(text, /只读任务/)
  assert.match(text, /仍是 read-only 沙箱/)
  assert.match(text, /新派一个可写任务/)
  assert.equal(getTask(db, task.id).status, 'running')
  assert.equal(dispatcher.calls.some(item => item[0] === 'approvePlan'), false)
  const send = dispatcher.calls.filter(item => item[0] === 'sendReliable').at(-1)
  assert.equal(send[1], 'c-2')
  assert.equal(send[3], true)
  db.close()
})

test('P8 批准：planMode 服务缺失时仍把沙箱切回可写（阻塞→批准→原会话继续）', async () => {
  const env = planEnv({ service: false, ctxStyle: 'cordis' })
  const member = await env.dispatcher.spawn({ prompt: 'p', cwd: 'C:/target', planFirst: true })
  const result = await env.dispatcher.approvePlan(member.id, 'C:/target')
  assert.equal(result.ok, true)
  assert.equal(result.sandbox, 'workspace-write')
  assert.deepEqual(sandboxModeEvents(env).map(item => item.payload.mode), ['read-only', 'workspace-write'])
  // 服务缺失不产生 plan off 调用，但批准本身不能失败。
  assert.deepEqual(env.planEvents, [])
  assert.equal(env.guardRecords[0].disposed, true)
})

test('P8 批准后恢复执行：沙箱切 workspace-write、plan off、释放 guard 并补可写根', async () => {
  const env = planEnv()
  const member = await env.dispatcher.spawn({ prompt: 'p', cwd: 'C:/target', planFirst: true })
  const result = await env.dispatcher.approvePlan(member.id, 'C:/target')
  assert.equal(result.ok, true)
  assert.equal(result.sandbox, 'workspace-write')
  const modes = sandboxModeEvents(env).map(item => item.payload.mode)
  assert.deepEqual(modes, ['read-only', 'workspace-write'])
  assert.deepEqual(env.planEvents, [[member.id, true], [member.id, false]])
  assert.equal(env.guardRecords[0].disposed, true)
  assert.deepEqual(env.registrations, [[member.id, 'C:/target']])
})

test('P8 批准失败：拿不到子会话时返回 ok:false（不静默假装切好了）', async () => {
  const env = planEnv()
  const result = await env.dispatcher.approvePlan('missing-session', 'C:/target')
  assert.equal(result.ok, false)
  assert.match(result.reason, /未拿到子会话/)
})

test('P8 team 后端：明确拒绝计划模式（没有会话级沙箱/planMode）', async () => {
  const agentTeams = {
    async spawnTeammate() { return { member: { id: 'm1', name: 'w' } } },
    async sendMessage() {},
    async interrupt() {},
    listMembers() { return [] },
  }
  const dispatcher = createTeamDispatcher({ agentTeams, agent: coordinator })
  await assert.rejects(dispatcher.spawn({ prompt: 'p', planFirst: true }), /不支持计划模式/)
})

// —— 五、面板与快照：字段下发 + 面板追加消息同样批准 ——

test('P8 snapshot/detail：下发 planFirst/planState，非计划任务固定 false/none', async () => {
  const db = await openLedger(tempDir())
  const plan = planTaskRow(db, { status: 'waiting_user' })
  const plain = createTask(db, { brief: sampleBrief({ title: '普通' }), coordinatorSession: 's-1' })
  transition(db, plain.id, 'running', { sessionId: 'c-8', target: 'c-8' })
  const panel = createPanelActions({ db, dispatcher: fakeDispatcher(), queue: createQueue({ db, dispatcher: fakeDispatcher(), config: {} }), config: {}, coordinatorStatus: () => ({ id: 's-1', live: true }) })
  const handler = createHostRoute({ db, coordinatorStatus: () => ({ id: 's-1', live: true }), panel })
  const response = await handler(new Request('http://localhost/api/orchestrator', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: 'snapshot' }),
  }))
  const body = await response.json()
  const planRow = body.tasks.find(item => item.id === plan.id)
  const plainRow = body.tasks.find(item => item.id === plain.id)
  assert.equal(planRow.planFirst, true)
  assert.equal(planRow.planState, 'planning')
  assert.equal(plainRow.planFirst, false)
  assert.equal(plainRow.planState, 'none')
  const detail = panel.detail(plan.id)
  assert.equal(detail.task.planFirst, true)
  assert.equal(detail.task.planState, 'planning')
  db.close()
})

test('P8 面板「追加」：等批准的计划任务同样走批准链路', async () => {
  const db = await openLedger(tempDir())
  const dispatcher = fakeDispatcher()
  const queue = createQueue({ db, dispatcher, config: {} })
  const panel = createPanelActions({ db, dispatcher, queue, config: {}, coordinatorStatus: () => ({ id: 's-1', live: true }) })
  const task = planTaskRow(db, { status: 'waiting_user' })
  const result = await panel.message(task.id, '批准，按计划执行')
  assert.equal(result.ok, true)
  assert.equal(result.plan.approved, true)
  assert.match(result.plan.note, /计划已批准/)
  assert.equal(getTask(db, task.id).plan_state, 'approved')
  assert.ok(dispatcher.calls.some(item => item[0] === 'approvePlan'))
  db.close()
})

// —— 六、客户端：计划小标/计划状态确实进了源码与产物 ——

test('P8 客户端：源码与 dist 产物都带计划状态文案与小标', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../client/src/views.js', import.meta.url), 'utf8')
  const constants = readFileSync(new URL('../client/src/constants.js', import.meta.url), 'utf8')
  const dist = readFileSync(new URL('../dist/client.js', import.meta.url), 'utf8')
  assert.match(source, /计划中/)
  for (const text of [constants, dist]) {
    assert.match(text, /计划中/)
    assert.match(text, /已批准执行/)
  }
  assert.match(source, /planState === 'planning'/)
  assert.match(source, /planFirst === true/)
})
