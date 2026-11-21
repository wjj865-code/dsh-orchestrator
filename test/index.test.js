import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject, name, COORDINATOR_DENY } from '../index.js'
import { resetDeprecatedKeyWarnings } from '../src/config.js'
import { openLedger, listTasks } from '../src/ledger.js'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

// P2-2：完成通知的合并窗口成了固定常量（配置键 mergeWindowMs 已删）。单测用环境变量把它压到
// 毫秒级——否则每个通知用例都要真等 5 秒；它只调窗口，不改「同批任务合并成一条」的语义。
// （个别用例要「窗口没到」时再自己临时改大，用完还原。）
process.env.DSH_ORCH_NOTIFY_MERGE_MS = '5'

// 0.26.0：协调者的 deny 名单只剩「编排正确性」项（read/skill 等预设自有工具都不在名单里；
// t-4f7ce108 起 glob/grep 随 tool-fs-search 行一起从预设移除），
// 所以替身默认带上这些项，否则 restrict 会算成空集合（= 不装白名单），断言就失去意义。
const DENY_FIXTURE = [...COORDINATOR_DENY, 'read', 'write', 'bash', 'skill', 'task_report', 'task_detail', 'plan_save', 'ask_user', 'show_view']

function makeAgent(id, { knownTools = DENY_FIXTURE, restrictableTools = knownTools } = {}) {
  const restrictions = []
  const injected = []
  return {
    id,
    // 真实 agent 一定带 session；dispatch 的就绪检查依赖它。
    session: { id, header: { agentPreset: 'dsh-orchestrator-coordinator' } },
    restrictions,
    injected,
    steer(message) { injected.push(message) },
    ctx: {
      tools: {
        view: () => ({ knownNames: new Set(knownTools), restrictableNames: new Set(restrictableTools) }),
        restrict(filter) { restrictions.push(filter); return () => {} },
      },
    },
  }
}

function fakeGoalService() {
  const calls = []
  const state = { view: undefined }
  return {
    calls,
    state,
    get(agent) { calls.push(['get', agent.id]); return state.view },
    create(agent, request) {
      // P2-2：goalRounds>0 时桥会带 maxGoalRounds；记录它，测试据此断言「续跑交给宿主 driver」。
      calls.push(['create', agent.id, request.objective, request.maxGoalRounds ?? null])
      state.view = {
        id: 'goal-1', revision: 1, objective: request.objective, phase: 'active', activation: 'armed',
        roundsStarted: 0, maxGoalRounds: request.maxGoalRounds ?? 256, createdAt: 1, updatedAt: 1,
      }
      return state.view
    },
    disarm(agent) {
      calls.push(['disarm', agent.id])
      state.view = { ...state.view, activation: 'disarmed' }
      return state.view
    },
    edit(agent, ref, request) {
      calls.push(['edit', agent.id, ref, request.objective])
      if (request.objective !== undefined) state.view = { ...state.view, objective: request.objective }
      if (request.maxGoalRounds !== undefined) state.view = { ...state.view, maxGoalRounds: request.maxGoalRounds }
      return state.view
    },
    complete(agent, ref) { calls.push(['complete', agent.id, ref]); return state.view },
    clear(agent, ref) { calls.push(['clear', agent.id, ref]); return { id: ref.id, revision: ref.revision + 1 } },
  }
}

function fakeCtx({ agent = makeAgent('s-1'), agents, spawnResult = { member: { id: 'm-1', name: 'w-1' } }, subagents: subagentsOverride, withInject = false, withAgentTeams = true, agentTeams: agentTeamsOverride, connection, sessionController, workspaces, goals, sessions, workspaceChanges } = {}) {
  const live = new Map((agents ?? [agent]).map(item => [item.id, item]))
  const registered = []
  const routes = []
  const injections = []
  const routeService = connection ?? { fetch: { register(spec) { routes.push(spec); return () => {} } } }
  const warnings = []
  const infos = []
  const listeners = new Map()
  const handlerMap = new Map()
  const on = (event, handler) => {
    if (!handlerMap.has(event)) {
      handlerMap.set(event, [])
      listeners.set(event, payload => { for (const item of handlerMap.get(event)) item(payload) })
    }
    handlerMap.get(event).push(handler)
    return () => {}
  }
  const sent = []
  const disposers = []
  const guards = []
  const promptContexts = []
  // 官方 Team 服务**只经 `ctx.get` 暴露**：真 cordis 里 `agentTeams` 不在本插件 inject 中，
  // 读 `ctx.agentTeams` 会抛 `cannot get property "agentTeams" without inject`（P2-4 修复后
  // src/host-capabilities.js 的 agentTeams() 只走 ctx.get，这里也照同一形状装配）。
  const agentTeamsService = withAgentTeams
    ? (agentTeamsOverride ?? {
      async spawnTeammate() { return spawnResult },
      async sendMessage(sender, input) { sent.push([sender, input]) },
      async interrupt() {},
      listMembers() { return [] },
    })
    : undefined
  // 真 cordis 的 `ctx.get('subagents')` 对 inject 里声明的服务同样返回实例；host-capabilities 现在
  // 统一经 service()（= ctx.get）取 agents/subagents，所以替身也得两条路都给（属性读仍保留，兼容老测试）。
  const subagentsService = subagentsOverride ?? {
    async startActivation(spec) {
      const childId = spawnResult?.member?.id ?? 'm-1'
      return {
        childId,
        messageId: 'msg-1',
        result: Promise.resolve({ output: [], stopReason: 'completed' }),
        dispose: async () => {},
      }
    },
    async sendMessage(sender, target, content, options) { sent.push([sender, { target, content, options }]) },
    async interruptByParent() {},
    async listChildren() { return [{ id: spawnResult?.member?.id ?? 'm-1', mode: 'continuable', label: 'x', activity: 'inactive' }] },
  }
  const ctx = {
    logger: {
      warn(message) { warnings.push(message) },
      info(message) { infos.push(message) },
    },
    tools: {
      register(tool) { registered.push(tool); return () => {} },
      guard(guard) { guards.push(guard); return () => {} },
    },
    systemPrompt: {
      getContextOrder: () => 125,
      context(entry) { promptContexts.push(entry); return () => {} },
    },
    get(name) {
      if (name === 'agents') return { get: id => live.get(id) }
      if (name === 'connection') return routeService
      if (name === 'sessionController') return sessionController
      if (name === 'workspaceRegistry') return workspaces
      if (name === 'sessions') return sessions
      if (name === 'workspaceChanges') return workspaceChanges
      if (name === 'goals') return goals
      if (name === 'agentTeams') return agentTeamsService
      if (name === 'subagents') return subagentsService
      return undefined
    },
    ...(withInject
      ? { inject(services, callback) { injections.push({ services, callback }); return () => {} } }
      : {}),
    on(event, handler) { return on(event, handler) },
    effect(callback) { disposers.push(callback()); return () => {} },
    subagents: subagentsService,
  }
  return { ctx, registered, routes, injections, warnings, infos, listeners, sent, disposers, agent, live, guards, promptContexts }
}

function withHome(fn) {
  return async () => {
    const home = mkdtempSync(join(tmpdir(), 'orch-home-'))
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      await fn(home)
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  }
}

test('inject 不再硬依赖 agentTeams（缺服务也要能激活）', () => {
  assert.equal(name, 'dsh-orchestrator')
  assert.deepEqual(new Set(inject), new Set(['tools', 'agents', 'systemPrompt', 'subagents']))
  assert.equal(inject.includes('agentTeams'), false)
})

test('profile 没有 agentTeams 也能 apply：工具/路由照常注册，subagent 可用', withHome(async () => {
  const f = fakeCtx({ withAgentTeams: false })
  await apply(f.ctx, {})
  assert.equal(f.registered.length, 10)
  assert.equal(f.routes.length, 1)
  assert.equal(f.warnings.some(message => /agentTeams|waiting for service/.test(message)), false)
}))

test('旧配置键（backend）仍能加载：warn 一次、工具照常注册、按默认值运行', withHome(async () => {
  // P1-A：backend 键已删除（team 后端在 P0-1 删除）。旧 profile 不改也能跑，但必须看到弃用提示。
  resetDeprecatedKeyWarnings()
  const f = fakeCtx({ withAgentTeams: false })
  await assert.doesNotReject(() => apply(f.ctx, { backend: 'team' }))
  assert.equal(f.registered.length, 10)
  assert.ok(f.warnings.some(message => /配置键 backend 已删除/.test(message)), f.warnings.join(' | '))
}))

test('缺 systemPrompt 时 warn，guard 仍然安装', withHome(async () => {
  const { ctx, warnings, guards } = fakeCtx()
  delete ctx.systemPrompt
  await apply(ctx, {})
  assert.ok(warnings.some(message => /systemPrompt/.test(message)))
  assert.equal(guards.length, 1)
}))

test('apply 注册 10 个工具（P1-B 15 → 10），只写 $DSH_HOME/state/orchestrator', withHome(async home => {
  const { ctx, registered } = fakeCtx()
  await apply(ctx, { coordinatorSession: 's-1' })
  assert.equal(registered.length, 10)
  assert.deepEqual(registered.map(tool => tool.name).sort(),
    ['context', 'memory_note', 'plan_save', 'read_workspace', 'task_create', 'task_detail', 'task_list', 'task_message', 'task_report', 'task_status'])
  assert.deepEqual(readdirSync(home), ['state'])
  assert.deepEqual(readdirSync(join(home, 'state', 'orchestrator')).filter(file => !file.startsWith('tasks.sqlite')), ['logs', 'snapshots'])
}))

// 挂载链证据：task_detail 由 index 的 createTools(...).map(ctx.tools.register) 注册成 host plane 全局工具，
// worker 预设的 preset-tools 只做遮挡式 deny（当前仅 memory_note，见 test/config.test.js），所以子会话工具表里直接就有它。
test('task_detail 走全局注册：主会话越权被拒，任务自己的子会话可读', withHome(async () => {
  const coordinator = makeAgent('s-1')
  const { ctx, registered } = fakeCtx({ agent: coordinator })
  await apply(ctx, { coordinatorSession: 's-1' })
  const byName = Object.fromEntries(registered.map(tool => [tool.name, tool]))
  assert.ok(byName.task_detail, 'task_detail 应注册在 host plane（子会话继承全局工具）')
  const created = await byName.task_create.execute({ title: '详情', goal: '完整目标', acceptance: ['a'] }, { agent: coordinator })
  const taskId = created.match(/（(t-[0-9a-f]+)）/)[1]
  const denied = await byName.task_detail.execute({ task_id: taskId }, { agent: coordinator })
  assert.match(denied, /读取被拒绝/)
  assert.match(denied, /主会话查任务用 task_status/)
  // 派发出去的会话 id 就是 m-1（fakeCtx 的 spawn 结果），它以「任务自己的子会话」身份读到详情。
  const detail = await byName.task_detail.execute({ task_id: taskId }, { agent: { id: 'm-1' } })
  assert.match(detail, /目标：完整目标/)
  assert.match(detail, /【验收标准】/)
}))

// P2-3 交接契约 v1 的端到端接线：交付事件由 `transition` 观察者写、确认事件由 `closeDelivered` 写，
// 都落 `$DSH_HOME/state/orchestrator/handoff/`（不进仓库、不改台账 messages 的语义）。
test('P2-3 交接事件：交付写 task.handoff.delivered、确认写 task.handoff.confirmed', withHome(async home => {
  const coordinator = makeAgent('s-1')
  const { ctx, registered } = fakeCtx({ agent: coordinator })
  await apply(ctx, { coordinatorSession: 's-1' })
  const byName = Object.fromEntries(registered.map(tool => [tool.name, tool]))
  const created = await byName.task_create.execute({ title: '交接', goal: '目标', acceptance: ['a'] }, { agent: coordinator })
  const taskId = created.match(/（(t-[0-9a-f]+)）/)[1]
  const readEvents = () => {
    const dir = join(home, 'state', 'orchestrator', 'handoff')
    const files = readdirSync(dir).filter(name => name.endsWith('.jsonl'))
    return files.flatMap(name => readFileSync(join(dir, name), 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line)))
  }

  const receipt = await byName.task_report.execute({ task_id: taskId, status: 'done', summary: '结论：完成' }, { agent: { id: 'm-1' } })
  assert.match(receipt, /待确认/)
  const delivered = readEvents()
  assert.deepEqual(delivered.map(line => line.event), ['task.handoff.delivered'])
  assert.equal(delivered[0].taskId, taskId)
  assert.equal(delivered[0].detail.contract, 1)
  assert.equal(delivered[0].detail.handoff.acceptedBy, null)
  assert.equal(delivered[0].detail.handoff.status, 'delivered')

  const closed = await byName.task_message.execute({ task_id: taskId, action: 'close' }, { agent: coordinator })
  assert.match(closed, /已确认完成/)
  const events = readEvents()
  assert.deepEqual(events.map(line => line.event), ['task.handoff.delivered', 'task.handoff.confirmed'])
  assert.equal(events[1].detail.handoff.acceptedBy, 'coordinator')
  assert.equal(events[1].detail.handoff.status, 'done')
  assert.ok(Number.isFinite(events[1].detail.handoff.acceptedAt))
  // 重复确认不再写第二条事件（幂等）。
  await byName.task_message.execute({ task_id: taskId, action: 'close' }, { agent: coordinator })
  assert.equal(readEvents().length, 2)
}))

test('apply 给 createTools 传 defaultCwd：无 target 时相对产物按主会话目录（指挥舱）解析', withHome(async home => {
  const s1 = makeAgent('s-1')
  const { ctx, registered } = fakeCtx({ agents: [s1] })
  await apply(ctx, { coordinatorSession: 's-1' })
  const byName = Object.fromEntries(registered.map(tool => [tool.name, tool]))
  await byName.task_create.execute({ title: '默认目录', goal: 'g', acceptance: ['a'] }, { agent: s1 })
  const { DatabaseSync } = await import('node:sqlite')
  const dbPath = join(home, 'state', 'orchestrator', 'tasks.sqlite')
  const db = new DatabaseSync(dbPath)
  const task = db.prepare('SELECT id, session_id FROM tasks').get()
  db.close()
  await byName.task_report.execute({
    task_id: task.id, status: 'done', summary: 'ok', artifacts: [{ path: 'out.txt' }],
  }, { agent: { id: task.session_id } })
  const after = new DatabaseSync(dbPath)
  const saved = JSON.parse(after.prepare('SELECT artifacts_json FROM tasks WHERE id = ?').get(task.id).artifacts_json)
  after.close()
  assert.equal(saved[0].path, join(home, 'state', 'orchestrator', 'workspace', 'out.txt'))
}))

test('无 coordinatorSession：warn 但工具注册；派活给「先打开主会话」提示', withHome(async () => {
  const { ctx, registered, warnings } = fakeCtx()
  await apply(ctx, {})
  assert.equal(registered.length, 10)
  assert.ok(warnings.some(message => /尚未打开主会话/.test(message)))
  const create = registered.find(tool => tool.name === 'task_create')
  const text = await create.execute({ title: 't', goal: 'g', acceptance: ['a'] })
  assert.match(text, /尚未打开主会话/)
}))

test('无主会话时 task_create 提示先从面板打开，且不写 settings', withHome(async home => {
  const { ctx, registered } = fakeCtx()
  await apply(ctx, {})
  const create = registered.find(tool => tool.name === 'task_create')
  const result = await create.execute({ title: '甲', goal: 'g', acceptance: ['a'] }, { agent: { id: 's-1' } })
  assert.match(result, /尚未打开主会话/)
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(home, 'state', 'orchestrator', 'tasks.sqlite'))
  assert.equal(db.prepare('SELECT count(*) AS n FROM settings').get().n, 0)
  assert.equal(db.prepare('SELECT count(*) AS n FROM tasks').get().n, 0)
  db.close()
}))

test('open-main 动作端点创建主会话并写 settings', withHome(async home => {
  const created = []
  const sessionController = {
    async create(request) { created.push(request); return { sessionId: 'session-main' } },
    async rename() {},
  }
  const workspaces = {
    resolveByPath: () => undefined,
    async create(path, title) { return { id: 'ws-1', path, title } },
  }
  const { ctx, routes } = fakeCtx({ agents: [makeAgent('session-main')], sessionController, workspaces })
  await apply(ctx, {})
  const route = routes[0].fetch
  const response = await route(new Request('http://x/api/orchestrator', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: 'open-main' }),
  }))
  const body = await response.json()
  assert.equal(response.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.sessionId, 'session-main')
  assert.equal(created[0].agentPreset, 'dsh-orchestrator-coordinator')
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(home, 'state', 'orchestrator', 'tasks.sqlite'))
  assert.equal(db.prepare('SELECT value FROM settings WHERE key = ?').get('main_session_id').value, 'session-main')
  db.close()
}))

test('open-main 创建失败返回 500 与可读原因', withHome(async () => {
  const sessionController = { async create() { throw new Error('boom') }, async rename() {} }
  const { ctx, routes } = fakeCtx({ sessionController })
  await apply(ctx, {})
  const response = await routes[0].fetch(new Request('http://x/api/orchestrator', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: 'open-main' }),
  }))
  const body = await response.json()
  assert.equal(response.status, 500)
  assert.equal(body.ok, false)
  assert.match(body.error, /boom/)
}))

test('主会话 live 时 task_create 正常派发，只给主会话装白名单', withHome(async () => {
  const s1 = makeAgent('s-1')
  const s2 = makeAgent('s-2')
  const { ctx, registered } = fakeCtx({ agents: [s1, s2] })
  await apply(ctx, { coordinatorSession: 's-1' })
  const byName = Object.fromEntries(registered.map(tool => [tool.name, tool]))
  const created = await byName.task_create.execute({ title: '甲', goal: 'g', acceptance: ['a'] }, { agent: s1 })
  assert.match(created, /已派发/)
  assert.equal(s1.restrictions.length, 1)
  assert.equal(s2.restrictions.length, 0)
}))

test('非主会话（子会话）调用 task_create 被拒，不建任务', withHome(async () => {
  const sub = makeAgent('sub-1')
  const { ctx, registered } = fakeCtx({ agent: sub })
  await apply(ctx, { coordinatorSession: 's-1' })
  const create = registered.find(tool => tool.name === 'task_create')
  const result = await create.execute({ title: '甲', goal: 'g', acceptance: ['a'] }, { agent: sub })
  assert.match(result, /主会话/)
}))


test('配置覆盖：白名单只装配置的会话，不写 settings', withHome(async home => {
  const s1 = makeAgent('s-1')
  const s2 = makeAgent('s-2')
  const { ctx, registered } = fakeCtx({ agents: [s1, s2] })
  await apply(ctx, { coordinatorSession: 's-1' })
  const byName = Object.fromEntries(registered.map(tool => [tool.name, tool]))
  await byName.task_create.execute({ title: '甲', goal: 'g', acceptance: ['a'] }, { agent: s1 })
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(home, 'state', 'orchestrator', 'tasks.sqlite'))
  assert.equal(db.prepare('SELECT count(*) AS n FROM settings').get().n, 0)
  assert.equal(db.prepare('SELECT coordinator_session FROM tasks').get().coordinator_session, 's-1')
  db.close()
  assert.equal(s1.restrictions.length, 1)
  assert.equal(s2.restrictions.length, 0)
}))

test('配置的协调者失效：task_create 结果带失效提示，任务标 failed', withHome(async home => {
  const s2 = makeAgent('s-2')
  const { ctx, registered } = fakeCtx({ agents: [s2] })
  await apply(ctx, { coordinatorSession: 's-1' })
  const byName = Object.fromEntries(registered.map(tool => [tool.name, tool]))
  // 调用方声明自己是配置的主会话，但该会话当前未加载：应给出失效提示并拒绝。
  const result = await byName.task_create.execute({ title: '甲', goal: 'g', acceptance: ['a'] }, { agent: { id: 's-1' } })
  assert.match(result, /任务协调失败/)
  assert.match(result, /主会话已失效/)
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(home, 'state', 'orchestrator', 'tasks.sqlite'))
  const task = db.prepare('SELECT status, error FROM tasks').get()
  assert.equal(task.status, 'failed')
  assert.match(task.error, /主会话已失效/)
  db.close()
}))

test('主会话失效：通知记 skipped 并在结果里提示', withHome(async home => {
  const s1 = makeAgent('s-1')
  const { ctx, registered, live } = fakeCtx({ agents: [s1] })
  await apply(ctx, { coordinatorSession: 's-1' })
  const byName = Object.fromEntries(registered.map(tool => [tool.name, tool]))
  await byName.task_create.execute({ title: '甲', goal: 'g', acceptance: ['a'] }, { agent: s1 })
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(home, 'state', 'orchestrator', 'tasks.sqlite'))
  const taskId = db.prepare('SELECT id FROM tasks').get().id
  db.close()
  live.delete('s-1')
  const reported = await byName.task_report.execute({ task_id: taskId, status: 'done', summary: '完成' }, { agent: { id: 'm-1' } })
  assert.match(reported, /主会话已失效/)
  await wait(30)
  const check = new DatabaseSync(join(home, 'state', 'orchestrator', 'tasks.sqlite'))
  const row = check.prepare('SELECT status, delivered_at, reason FROM notifications').get()
  assert.equal(row.status, 'skipped')
  assert.equal(row.delivered_at, null)
  assert.match(row.reason, /主会话已失效/)
  check.close()
}))

test('重启后从 settings.main_session_id 恢复主会话并补装白名单', withHome(async () => {
  const s1 = makeAgent('s-1')
  const sessionController = {
    async create() { return { sessionId: 's-1' } },
    async rename() {},
  }
  const first = fakeCtx({ agents: [s1], sessionController })
  await apply(first.ctx, {})
  const open = await first.routes[0].fetch(new Request('http://x/api/orchestrator', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: 'open-main' }),
  }))
  assert.equal((await open.json()).sessionId, 's-1')
  await first.disposers[0]()

  const s1b = makeAgent('s-1')
  const second = fakeCtx({ agents: [s1b] })
  await apply(second.ctx, {})
  assert.equal(s1b.restrictions.length, 1)
  await second.disposers[0]()
}))

test('协调者工具面：只读工具与 skill 不再被遮，名单只剩编排正确性项', withHome(async () => {
  const agent = makeAgent('s-1')
  const { ctx } = fakeCtx({ agent })
  await apply(ctx, { coordinatorSession: 's-1' })
  assert.equal(agent.restrictions.length, 1)
  const deny = agent.restrictions[0].deny
  // 0.26.0（t-48e8ce06）：read 已挂给协调者、skill 用来加载 grill-me，都不再遮。
  // t-4f7ce108：glob/grep 已从预设移除，它们本来也不在执行层名单里（工具表里就没有它们）。
  for (const name of ['read', 'skill', 'write', 'bash']) {
    assert.equal(deny.includes(name), false, `${name} 不再进协调者 deny 名单`)
  }
  // 编排正确性项保留：派队友/团队板/插件/密钥/IM 执行层一律拒绝。
  for (const name of ['wait_agent', 'spawn_teammate', 'team_task_create', 'plugin_manager', 'request_secret']) {
    assert.ok(deny.includes(name), `${name} 仍应被遮`)
  }
  // 宿主导航工具：会改协调者会话 cwd（指挥锚：子会话继承目录 / 记忆项目键 / 写域判定都以它为准）。
  // 真机复验（0.26.0）发现它漏在协调者工具表里，预设 deny + 执行层名单两处都遮。
  assert.ok(deny.includes('working_directory'), 'working_directory 应被协调者执行层名单遮住')
  // 角色专属工具改由预设层遮（cordis.patch.yml），不在执行层名单里。
  for (const name of ['task_report', 'task_detail', 'plan_save']) {
    assert.equal(deny.includes(name), false, `${name} 移到预设层遮挡`)
  }
  assert.equal(deny.includes('ask_user'), false)
  assert.equal(deny.includes('show_view'), false)
  assert.equal(deny.includes('present'), false)
}))

test('主会话保留四个原生自动化工具，团队工具仍被 guard 硬拦', withHome(async () => {
  const schedule = ['schedule_create', 'schedule_list', 'schedule_view', 'schedule_edit']
  const blocked = ['wait_agent', 'spawn_teammate', 'send_message', 'list_agents', 'interrupt_agent', 'team_task_create', 'plugin_manager', 'request_secret', 'list_bots']
  const main = makeAgent('s-1', { knownTools: [...schedule, ...blocked] })
  const otherRoot = makeAgent('scheduled-new-root')
  const f = fakeCtx({ agents: [main, otherRoot] })
  await apply(f.ctx, { coordinatorSession: 's-1' })
  assert.deepEqual(main.restrictions[0].deny, COORDINATOR_DENY.filter(name => blocked.includes(name)))
  for (const name of schedule) {
    assert.equal(COORDINATOR_DENY.includes(name), false)
    assert.equal(f.guards[0]({ name, agent: main }), undefined)
  }
  for (const name of blocked) {
    assert.equal(typeof f.guards[0]({ name, agent: main }), 'string')
    assert.equal(f.guards[0]({ name, agent: otherRoot }), undefined)
  }
  // 只读工具与子会话专属工具不再是执行层硬拦项：读工具放行，专属工具由各自执行层校验归属。
  for (const name of ['read', 'skill', 'task_report', 'task_detail', 'plan_save']) {
    assert.equal(f.guards[0]({ name, agent: main }), undefined, `${name} 不应被协调者 guard 拦`)
  }
  const create = f.registered.find(tool => tool.name === 'task_create')
  assert.match(await create.execute({ title: 'new/new_once', goal: 'g', acceptance: ['a'] }, { agent: otherRoot }), /主会话/)
  assert.equal(f.registered.length, 10, '不在 host plane 注册自动化包装')
}))

test('自动化诊断在边界重查、warning 去重、恢复可见且不污染其他会话', withHome(async () => {
  const names = new Set(['schedule_create', 'schedule_list', 'schedule_view', 'schedule_edit'])
  const main = makeAgent('s-1')
  const other = makeAgent('s-2')
  let schedule
  let lookups = 0
  main.ctx.tools.get = (name, agent) => {
    assert.equal(agent, main)
    lookups += 1
    return names.has(name) ? { name } : undefined
  }
  const f = fakeCtx({ agents: [main, other] })
  const get = f.ctx.get
  f.ctx.get = name => name === 'schedule' ? schedule : get(name)
  await apply(f.ctx, { coordinatorSession: 's-1' })
  const prompt = f.promptContexts[0].text
  const diagnosticWarnings = () => f.warnings.filter(message => /当前缺失自动化能力/.test(message))
  assert.match(prompt({ agent: main }), /当前缺失自动化能力：schedule 服务/)
  assert.equal(diagnosticWarnings().length, 1)
  const before = lookups
  f.listeners.get('agent/status')({ agent: other, status: 'idle' })
  assert.equal(prompt({ agent: other }), '')
  assert.equal(lookups, before)
  schedule = {}
  names.delete('schedule_view')
  f.listeners.get('agent/status')({ agent: main, status: 'idle' })
  assert.match(prompt({ agent: main }), /当前缺失自动化能力：schedule_view/)
  assert.equal(diagnosticWarnings().length, 2)
  names.add('schedule_view')
  f.listeners.get('agent/status')({ agent: main, status: 'idle' })
  assert.doesNotMatch(prompt({ agent: main }), /当前缺失自动化能力：/)
  assert.equal(main.restrictions.length, 1, '检查不更改工具表')
  names.delete('schedule_view')
  assert.match(prompt({ agent: main }), /当前缺失自动化能力：schedule_view/)
  assert.equal(diagnosticWarnings().length, 3, '恢复后再次缺失可以告警')
  main.ctx.tools.get = () => { throw new Error('late loader') }
  assert.doesNotThrow(() => prompt({ agent: main }))
  assert.match(prompt({ agent: main }), /能力检查失败/)
}))

test('自定义主会话缺原生定义时不崩；running 初始化延到 idle，打开也检查', withHome(async () => {
  const main = makeAgent('s-1')
  main.status = 'running'
  const sessionController = { async rename() {} }
  const f = fakeCtx({ agent: main, sessionController })
  await apply(f.ctx, { coordinatorSession: 's-1' })
  assert.equal(f.warnings.some(message => /当前缺失自动化能力/.test(message)), false)
  f.listeners.get('agent/status')({ agent: main, status: 'idle' })
  main.status = 'idle'
  assert.match(f.promptContexts[0].text({ agent: main }), /当前缺失自动化能力：schedule 服务、schedule_create、schedule_list、schedule_view、schedule_edit/)
  const response = await f.routes[0].fetch(new Request('http://x/api/orchestrator', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: 'open-main' }),
  }))
  assert.equal((await response.json()).ok, true)
  assert.equal(f.warnings.filter(message => /当前缺失自动化能力/.test(message)).length, 1)
}))

test('首次打开启动欢迎模型轮次，正常task_create只读索引回报可持久化', withHome(async home => {
  const main = makeAgent('s-1')
  const entries = [{ id: 'ws-1', title: '项目别名', path: home }]
  const f = fakeCtx({ agent: main, sessionController: { async create() { return { sessionId: 's-1' } }, async rename() {} }, workspaces: { list: () => entries } })
  await apply(f.ctx, {})
  const open = () => f.routes[0].fetch(new Request('http://x/api/orchestrator', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: 'open-main' }) }))
  await Promise.all([open(), open()])
  await open()
  assert.equal(main.injected.length, 1)
  assert.match(main.injected[0].content[0].text, /介绍后立即调用 task_create/)
  const byName = Object.fromEntries(f.registered.map(tool => [tool.name, tool]))
  const created = await byName.task_create.execute({ title: '工作区与仓库索引', goal: '索引', readOnly: true, worktree: false, acceptance: ['完整JSON'] }, { agent: main })
  const id = created.match(/（(t-[0-9a-f]+)）/)[1]
  const detail = await byName.task_detail.execute({ task_id: id }, { agent: { id: 'm-1' } })
  assert.match(detail, /项目别名/)
  assert.match(detail, /workspace-index.mjs/)
  const payload = JSON.stringify({ entries: [{ ...entries[0], status: 'not_git', sampledAt: new Date().toISOString() }] })
  assert.match(await byName.task_report.execute({ task_id: id, status: 'done', workspace_index: payload }, { agent: main }), /被拒绝/)
  assert.match(await byName.task_report.execute({ task_id: id, status: 'done' }, { agent: { id: 'm-1' } }), /必须用 workspace_index/)
  await byName.task_report.execute({ task_id: id, status: 'done', workspace_index: payload, summary: '索引已扫描' }, { agent: { id: 'm-1' } })
  const context = await byName.context.execute({ mode: 'workspaces' }, { agent: main })
  assert.match(context, /项目别名/)
  assert.match(context, /采样快照（非实时/)
  assert.match(context, /not_git/)
}))

test('首次介绍投递失败可见，重开重试而老主会话不补初始化', withHome(async () => {
  const main = makeAgent('s-1')
  const steer = main.steer
  main.steer = () => { throw new Error('not ready') }
  const f = fakeCtx({ agent: main, sessionController: { async create() { return { sessionId: 's-1' } }, async rename() {} } })
  await apply(f.ctx, {})
  const open = () => f.routes[0].fetch(new Request('http://x/api/orchestrator', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: 'open-main' }) }))
  const failed = await open()
  assert.equal(failed.status, 503)
  assert.match(JSON.stringify(await failed.json()), /首次介绍投递失败/)
  main.steer = steer
  assert.equal((await open()).status, 200)
  assert.equal(main.injected.length, 1)
}))

test('新主会话为default且缺preset选择服务时拒绝欢迎，不误报恢复成功', withHome(async () => {
  const main = makeAgent('s-1')
  main.session.header.agentPreset = 'standard'
  const f = fakeCtx({ agent: main, sessionController: { async create() { return { sessionId: 's-1' } }, async rename() {} } })
  await apply(f.ctx, {})
  const response = await f.routes[0].fetch(new Request('http://x/api/orchestrator', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: 'open-main' }) }))
  assert.equal(response.status, 503)
  assert.equal(main.injected.length, 0)
  assert.match(JSON.stringify(await response.json()), /预设恢复未成功/)
}))

test('协调者可用 present 交付产物：不在 COORDINATOR_DENY，执行层 guard 放行', withHome(async () => {
  // present 由协调者预设的 tool-present 行注册；执行层若还留在黑名单会把它硬拦掉。
  assert.equal(COORDINATOR_DENY.includes('present'), false)
  const main = makeAgent('s-1')
  const { ctx, guards } = fakeCtx({ agents: [main] })
  await apply(ctx, { coordinatorSession: 's-1' })
  assert.equal(guards.length, 1)
  assert.equal(guards[0]({ name: 'present', agent: main }), undefined)
}))

test('白名单只取 restrictableNames，不把 scope 内工具当全局工具', withHome(async () => {
  const agent = makeAgent('s-1', {
    knownTools: ['send_message', 'ask_user'],
    restrictableTools: ['send_message', 'ask_user'],
  })
  const { ctx } = fakeCtx({ agent })
  await apply(ctx, { coordinatorSession: 's-1' })
  assert.equal(agent.restrictions.length, 1)
  assert.deepEqual(agent.restrictions[0].deny, ['send_message'])
}))

test('wait_agent 是 scope 注册，不在 restrictableNames 时 deny 不包含它', withHome(async () => {
  const agent = makeAgent('s-1', {
    knownTools: ['send_message', 'wait_agent', 'spawn_teammate', 'ask_user'],
    restrictableTools: ['send_message', 'ask_user'],
  })
  const { ctx } = fakeCtx({ agent })
  await apply(ctx, { coordinatorSession: 's-1' })
  const deny = agent.restrictions[0].deny
  assert.ok(deny.includes('send_message'))
  assert.equal(deny.includes('wait_agent'), false)
  assert.equal(deny.includes('spawn_teammate'), false)
}))

test('绑定发生在回合中时，白名单延到 idle 后才装（当前回合工具表不变）', withHome(async () => {
  const s1 = makeAgent('s-1')
  s1.status = 'running'
  const other = makeAgent('s-2')
  const { ctx, listeners } = fakeCtx({ agents: [s1, other] })
  await apply(ctx, { coordinatorSession: 's-1' })
  assert.equal(s1.restrictions.length, 0)
  listeners.get('agent/status')({ agent: s1, status: 'idle' })
  assert.equal(s1.restrictions.length, 1)
  listeners.get('agent/status')({ agent: s1, status: 'idle' })
  assert.equal(s1.restrictions.length, 1)
  listeners.get('agent/status')({ agent: other, status: 'idle' })
  assert.equal(other.restrictions.length, 0)
}))

test('缺 tools.guard 时 warn 不崩，10 工具照常注册', withHome(async () => {
  const { ctx, warnings, registered } = fakeCtx()
  delete ctx.tools.guard
  await apply(ctx, {})
  assert.ok(warnings.some(message => /tools\.guard/.test(message)))
  assert.equal(registered.length, 10)
}))

test('系统提示只渲染给已绑定协调者，绑定后下一步生效', withHome(async () => {
  const s1 = makeAgent('s-1')
  const other = makeAgent('s-2')
  const { ctx, promptContexts } = fakeCtx({ agents: [s1, other] })
  await apply(ctx, { coordinatorSession: 's-1' })
  // 两条 context：协调者 policy（L1）+ 任务执行者 policy（W1，t-4f7ce108）；各自按 agent id 判定。
  assert.equal(promptContexts.length, 2)
  const entry = promptContexts.find(item => item.name === 'orchestrator:coordinator-policy')
  const worker = promptContexts.find(item => item.name === 'orchestrator:worker-policy')
  assert.ok(entry !== undefined && worker !== undefined)
  assert.equal(entry.order, 130)
  assert.equal(entry.interpolate, false)
  // W1 与 L1 分开注册、顺序不同，互不覆盖（两份都在时各说各的）。
  assert.equal(worker.order, 131)
  assert.equal(worker.interpolate, false)
  assert.equal(entry.text({ agent: other }), '')
  assert.match(entry.text({ agent: s1 }), /禁止使用 wait_agent/)
  assert.match(entry.text({ agent: s1 }), /task_list \/ task_status/)
  assert.match(entry.text({ agent: s1 }), /优先于平台默认的 Team Lead 等待要求/)
  assert.match(entry.text({ agent: s1 }), /The Lead must wait for required teammates/)
  assert.match(entry.text({ agent: s1 }), /禁止调用 spawn_teammate/)
  assert.match(entry.text({ agent: s1 }), /team_task_create/)
  assert.match(entry.text({ agent: s1 }), /预设层删不掉/)
  assert.equal(entry.text({ agent: other }), '')
  // 协调者与无关会话都拿不到 W1（只命中任务子会话）。
  assert.equal(worker.text({ agent: s1 }), '')
  assert.equal(worker.text({ agent: other }), '')
  assert.equal(worker.text({}), '')
}))

// W1（t-4f7ce108）：按 tasks.session_id 注入任务子会话的 per-turn policy。
test('任务子会话拿到 worker policy；协调者/无关会话/孙会话拿不到', withHome(async () => {
  const coordinator = makeAgent('s-1')
  const { ctx, registered, promptContexts } = fakeCtx({ agent: coordinator })
  await apply(ctx, { coordinatorSession: 's-1' })
  const worker = promptContexts.find(item => item.name === 'orchestrator:worker-policy')
  assert.ok(worker !== undefined, '应注册 orchestrator:worker-policy')
  const byName = Object.fromEntries(registered.map(tool => [tool.name, tool]))
  // 派发前：子会话 id 还没进台账（fakeCtx 的 spawn 返回 m-1）→ 不注入。
  assert.equal(worker.text({ agent: { id: 'm-1' } }), '')
  const created = await byName.task_create.execute({ title: '甲', goal: 'g', acceptance: ['a'] }, { agent: coordinator })
  const taskId = created.match(/（(t-[0-9a-f]+)）/)[1]
  // 派发被接受时 index.js 记下 id 映射：首回合即可注入（不必等台账 session_id 回写）。
  const policy = worker.text({ agent: { id: 'm-1' } })
  assert.match(policy, /## 回报与确认/)
  assert.match(policy, /task_report 回报（progress \/ done \/ blocked \/ needs_auth）/)
  assert.match(policy, /主动调 context/)
  // 协调者自己永远不拿 W1；无关会话与孙会话（不在 tasks.session_id 里）也不拿。
  assert.equal(worker.text({ agent: coordinator }), '')
  assert.equal(worker.text({ agent: { id: 'grandchild-1' } }), '')
  // 普通任务没有装依赖授权；隔离任务才有（W1 按台账 worktree_state 条件渲染）。
  assert.equal(/pnpm install/.test(policy), false)
  // 台账真值兜底：即使没有派发映射，tasks.session_id 命中也能注入。
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(process.env.DSH_HOME, 'state', 'orchestrator', 'tasks.sqlite'))
  db.prepare('UPDATE tasks SET session_id = ?, worktree_state = ? WHERE id = ?').run('m-2', 'created', taskId)
  db.close()
  const isolated = worker.text({ agent: { id: 'm-2' } })
  assert.match(isolated, /pnpm install/, '隔离任务（台账 worktree_state=created）应给装依赖授权')
  assert.match(isolated, /只安装不升级/)
}))


test('guard 拒绝协调者的 wait_agent，子任务不受影响', withHome(async () => {
  const s1 = makeAgent('s-1')
  const other = makeAgent('s-2')
  const { ctx, guards } = fakeCtx({ agents: [s1, other] })
  await apply(ctx, { coordinatorSession: 's-1' })
  assert.equal(guards.length, 1)
  const guard = guards[0]
  assert.match(guard({ name: 'wait_agent', agent: s1 }), /禁止阻塞等待/)
  assert.equal(guard({ name: 'wait_agent', agent: other }), undefined)
  assert.equal(guard({ name: 'task_list', agent: s1 }), undefined)
}))

test('协调者后加载：agent/created 时补装白名单', withHome(async () => {
  const agent = makeAgent('late-1')
  const { ctx, listeners } = fakeCtx({ agent })
  ctx.get = () => ({ get: () => undefined })
  await apply(ctx, { coordinatorSession: 'late-1' })
  assert.equal(agent.restrictions.length, 0)
  listeners.get('agent/created')({ agent })
  assert.equal(agent.restrictions.length, 1)
}))

test('回报通知由子任务 agent 发出，目标 lead，并落库', withHome(async () => {
  const coordinator = makeAgent('s-1')
  const teammate = { id: 'm-1' }
  const { ctx, registered, sent } = fakeCtx({ agent: coordinator })
  await apply(ctx, { coordinatorSession: 's-1' })
  const byName = Object.fromEntries(registered.map(tool => [tool.name, tool]))
  const created = await byName.task_create.execute(
    { title: '甲', goal: 'g', acceptance: ['a'] },
    { agent: coordinator },
  )
  assert.match(created, /已派发/)
  const signal = new AbortController().signal
  await byName.task_report.execute(
    { task_id: created.match(/（(t-[0-9a-f]+)）/)[1], status: 'done', summary: '完成' },
    { agent: teammate, signal },
  )
  await wait(30)
  assert.equal(sent.length, 0)
  assert.equal(coordinator.injected.length, 1)
  // 两段式终态：交付通知写「已交付待确认」并带 action:close / task_message 动作指令。
  assert.match(coordinator.injected[0].content[0].text, /任务「甲」已交付待确认/)
  assert.match(coordinator.injected[0].content[0].text, /action: "close"/)
  assert.deepEqual(coordinator.injected[0].source, { kind: 'agent-message', form: 'relay', senderSessionId: teammate.id })
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(process.env.DSH_HOME, 'state', 'orchestrator', 'tasks.sqlite'))
  const row = db.prepare('SELECT status, level FROM notifications').get()
  assert.equal(row.status, 'delivered')
  assert.equal(row.level, 'notify')
  db.close()
}))

test('无 coordinatorSession 时不投递通知', withHome(async home => {
  const { ctx, registered, sent } = fakeCtx()
  await apply(ctx, {})
  const { openLedger, createTask, transition } = await import('../src/ledger.js')
  const ledger = await openLedger(join(home, 'state', 'orchestrator'))
  const task = createTask(ledger, { brief: { title: 't', goal: 'g', acceptance: ['a'] }, coordinatorSession: 's-1' })
  transition(ledger, task.id, 'running')
  ledger.close()
  const report = registered.find(tool => tool.name === 'task_report')
  await report.execute({ task_id: task.id, status: 'done', summary: 'x' }, { agent: { id: 'm-1' } })
  await wait(30)
  assert.equal(sent.length, 0)
}))

test('回报缺少 sender：不投递，通知行记 skipped', withHome(async home => {
  const { ctx, registered, sent } = fakeCtx()
  await apply(ctx, { coordinatorSession: 's-1' })
  const create = registered.find(tool => tool.name === 'task_create')
  const created = await create.execute({ title: '甲', goal: 'g', acceptance: ['a'] }, { agent: { id: 's-1' } })
  const taskId = created.match(/（(t-[0-9a-f]+)）/)[1]
  const report = registered.find(tool => tool.name === 'task_report')
  await report.execute({ task_id: taskId, status: 'done', summary: '完成' })
  await wait(30)
  assert.equal(sent.length, 0)
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(home, 'state', 'orchestrator', 'tasks.sqlite'))
  const row = db.prepare('SELECT status, delivered_at FROM notifications').get()
  assert.equal(row.status, 'skipped')
  assert.equal(row.delivered_at, null)
  db.close()
}))

test('卸载时窗口内的 done 通知不丢行', withHome(async home => {
  const coordinator = makeAgent('s-1')
  const teammate = { id: 'm-1' }
  const { ctx, registered, disposers } = fakeCtx({ agent: coordinator })
  // 合并窗口是固定常量（P2-2 删了配置键）：这里用测试旁路把它拉到 10 分钟，
  // 断言「窗口没到 → 一条都没发」，再靠卸载时的 flushNow 把行补上（不丢通知）。
  const previousWindow = process.env.DSH_ORCH_NOTIFY_MERGE_MS
  process.env.DSH_ORCH_NOTIFY_MERGE_MS = '600000'
  try {
    await apply(ctx, { coordinatorSession: 's-1' })
    const byName = Object.fromEntries(registered.map(tool => [tool.name, tool]))
    const created = await byName.task_create.execute({ title: '甲', goal: 'g', acceptance: ['a'] }, { agent: coordinator })
    const taskId = created.match(/（(t-[0-9a-f]+)）/)[1]
    await byName.task_report.execute({ task_id: taskId, status: 'done', summary: '完成' }, { agent: teammate })
    assert.equal(coordinator.injected.length, 0)
    await disposers[0]()
    assert.equal(coordinator.injected.length, 1)
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(home, 'state', 'orchestrator', 'tasks.sqlite'))
    const row = db.prepare('SELECT status, delivered_at FROM notifications').get()
    assert.equal(row.status, 'delivered')
    assert.ok(row.delivered_at > 0)
    db.close()
  } finally {
    if (previousWindow === undefined) delete process.env.DSH_ORCH_NOTIFY_MERGE_MS
    else process.env.DSH_ORCH_NOTIFY_MERGE_MS = previousWindow
  }
}))

test('注入失败记 failed + reason，不是 skipped', withHome(async home => {
  const coordinator = makeAgent('s-1')
  coordinator.steer = () => { throw new Error('steer 失败') }
  const teammate = { id: 'm-1' }
  const { ctx, registered } = fakeCtx({ agent: coordinator })
  await apply(ctx, { coordinatorSession: 's-1' })
  const byName = Object.fromEntries(registered.map(tool => [tool.name, tool]))
  const created = await byName.task_create.execute({ title: '甲', goal: 'g', acceptance: ['a'] }, { agent: coordinator })
  const taskId = created.match(/（(t-[0-9a-f]+)）/)[1]
  await byName.task_report.execute({ task_id: taskId, status: 'done', summary: '完成' }, { agent: teammate })
  await wait(30)
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(home, 'state', 'orchestrator', 'tasks.sqlite'))
  const row = db.prepare('SELECT status, delivered_at, reason FROM notifications').get()
  assert.equal(row.status, 'failed')
  assert.equal(row.delivered_at, null)
  assert.match(row.reason, /steer 失败/)
  db.close()
}))

test('启动恢复：pending 且无子会话的任务自动入队并派发', withHome(async home => {
  const { openLedger, createTask } = await import('../src/ledger.js')
  const ledger = await openLedger(join(home, 'state', 'orchestrator'))
  const task = createTask(ledger, { brief: { title: '恢复', goal: 'g', acceptance: ['a'] }, coordinatorSession: 's-1' })
  ledger.close()

  const s1 = makeAgent('s-1')
  const { ctx, disposers } = fakeCtx({ agents: [s1] })
  await apply(ctx, { coordinatorSession: 's-1' })
  await wait(20)
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(home, 'state', 'orchestrator', 'tasks.sqlite'))
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(task.id).status, 'running')
  db.close()
  await disposers[0]()
}))

test('autoResumeQueue=false：只恢复队列不自动派发', withHome(async home => {
  const { openLedger, createTask } = await import('../src/ledger.js')
  const ledger = await openLedger(join(home, 'state', 'orchestrator'))
  const task = createTask(ledger, { brief: { title: '暂停', goal: 'g', acceptance: ['a'] }, coordinatorSession: 's-1' })
  ledger.close()

  const s1 = makeAgent('s-1')
  const { ctx, disposers } = fakeCtx({ agents: [s1] })
  await apply(ctx, { autoResumeQueue: false })
  await wait(20)
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(home, 'state', 'orchestrator', 'tasks.sqlite'))
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(task.id).status, 'pending')
  db.close()
  await disposers[0]()
}))

test('结算唤醒：容量 1 时第二个任务排队，第一个 settle 后自动补位且不双派', withHome(async () => {
  const s1 = makeAgent('s-1')
  let alive = 0
  const spawned = []
  let settleFirst
  const subagents = {
    async startActivation(spec) {
      if (alive >= 1) {
        const error = new Error('subagent limit reached')
        error.code = 'ACTIVATION_LIMIT_REACHED'
        throw error
      }
      alive += 1
      spawned.push(spec)
      const result = new Promise(resolve => {
        if (settleFirst === undefined) settleFirst = () => { alive = 0; resolve({ output: [], stopReason: 'completed' }) }
      })
      return { childId: spec.childId, messageId: 'msg-1', result, dispose: async () => {} }
    },
    async sendMessage() {},
    async interruptByParent() {},
    async listChildren() {
      return spawned.map(spec => ({ id: spec.childId, mode: 'continuable', label: 'x', activity: 'inactive' }))
    },
  }
  const { ctx, registered } = fakeCtx({ agents: [s1], subagents })
  await apply(ctx, { coordinatorSession: 's-1' })
  const byName = Object.fromEntries(registered.map(tool => [tool.name, tool]))
  await byName.task_create.execute({ title: 'A', goal: 'g', acceptance: ['a'] }, { agent: s1 })
  const second = await byName.task_create.execute({ title: 'B', goal: 'g', acceptance: ['a'] }, { agent: s1 })
  assert.match(second, /排队/)
  assert.equal(spawned.length, 1)

  settleFirst()
  await wait(30)
  assert.equal(spawned.length, 2)
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(process.env.DSH_HOME, 'state', 'orchestrator', 'tasks.sqlite'))
  const rows = db.prepare('SELECT status, session_id FROM tasks').all()
  // S1 之后第一个任务的 settle 会把它推到「已交付待确认」：只剩第二个在跑，且两个会话 id 不同（没双派）。
  assert.equal(rows.filter(row => row.status === 'running').length, 1)
  assert.equal(rows.filter(row => row.status === 'delivered').length, 1)
  assert.equal(rows.filter(row => row.status === 'done').length, 0)
  assert.equal(new Set(rows.map(row => row.session_id)).size, 2)
  db.close()
}))

test('重启对账：running 子会话不 live 标 orphaned；waiting 不 live 保持', withHome(async home => {
  const { openLedger, createTask, transition } = await import('../src/ledger.js')
  const ledger = await openLedger(join(home, 'state', 'orchestrator'))
  const runningTask = createTask(ledger, { brief: { title: '跑着', goal: 'g', acceptance: ['a'] }, coordinatorSession: 's-1' })
  transition(ledger, runningTask.id, 'running', { sessionId: 'c-run', target: 'c-run' })
  const waitingTask = createTask(ledger, { brief: { title: '等授权', goal: 'g', acceptance: ['a'] }, coordinatorSession: 's-1' })
  transition(ledger, waitingTask.id, 'running', { sessionId: 'c-wait', target: 'c-wait' })
  transition(ledger, waitingTask.id, 'waiting_auth')
  ledger.close()

  const s1 = makeAgent('s-1')
  const subagents = {
    async startActivation() { throw new Error('不应派发') },
    async sendMessage() {},
    async interruptByParent() {},
    async listChildren() {
      return [{ id: 'c-run', mode: 'continuable' }, { id: 'c-wait', mode: 'continuable' }]
    },
  }
  const { ctx, disposers } = fakeCtx({ agents: [s1], subagents })
  await apply(ctx, { coordinatorSession: 's-1' })
  await wait(20)
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(home, 'state', 'orchestrator', 'tasks.sqlite'))
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(runningTask.id).status, 'orphaned')
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(waitingTask.id).status, 'waiting_auth')
  db.close()
  await disposers[0]()
}))

test('S2 启动对账：running 无活跃子会话 → orphaned + 一条汇总通知；重复启动幂等', withHome(async home => {
  const { openLedger, createTask, transition } = await import('../src/ledger.js')
  const ledger = await openLedger(join(home, 'state', 'orchestrator'))
  const ghost = createTask(ledger, { brief: { title: '幽灵任务', goal: 'g', acceptance: ['a'] }, coordinatorSession: 's-1' })
  transition(ledger, ghost.id, 'running', { sessionId: 'c-run', target: 'c-run' })
  const waiting = createTask(ledger, { brief: { title: '等授权', goal: 'g', acceptance: ['a'] }, coordinatorSession: 's-1' })
  transition(ledger, waiting.id, 'running', { sessionId: 'c-wait', target: 'c-wait' })
  transition(ledger, waiting.id, 'waiting_auth')
  const dep = createTask(ledger, {
    brief: { title: '等前置', goal: 'g', acceptance: ['a'] },
    coordinatorSession: 's-1',
    dependsOn: [waiting.id],
    status: 'waiting_dep',
  })
  ledger.close()

  const subagents = {
    async startActivation() { throw new Error('不应派发') },
    async sendMessage() {},
    async interruptByParent() {},
    // catalog 里只有 waiting 会话；running 的那条已经没了。
    async listChildren() { return [{ id: 'c-wait', mode: 'continuable', label: 'x', activity: 'inactive' }] },
  }
  const s1 = makeAgent('s-1')
  const first = fakeCtx({ agents: [s1], subagents })
  await apply(first.ctx, { coordinatorSession: 's-1' })
  await wait(30)

  const { DatabaseSync } = await import('node:sqlite')
  const dbPath = join(home, 'state', 'orchestrator', 'tasks.sqlite')
  const db = new DatabaseSync(dbPath)
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(ghost.id).status, 'orphaned')
  assert.match(db.prepare('SELECT error FROM tasks WHERE id = ?').get(ghost.id).error, /没有在运行的回合/)
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(waiting.id).status, 'waiting_auth')
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(dep.id).status, 'waiting_dep')
  const notification = db.prepare('SELECT task_id, level, status FROM notifications').all()
  assert.equal(notification.length, 1)
  assert.equal(notification[0].task_id, ghost.id)
  assert.equal(notification[0].level, 'notify')
  assert.equal(notification[0].status, 'delivered')
  db.close()

  // 一条汇总消息（不是每个任务一条），列出任务名与重派提示。
  assert.equal(s1.injected.length, 1)
  const text = s1.injected[0].content[0].text
  assert.match(text, /启动对账：1 个任务/)
  assert.match(text, /幽灵任务/)
  assert.match(text, /action: 'retry'/)
  await first.disposers.at(-1)?.()

  // 模拟再次启动：已 orphaned 的任务不再重复标记，也不再发汇总。
  const s1b = makeAgent('s-1')
  const second = fakeCtx({ agents: [s1b], subagents })
  await apply(second.ctx, { coordinatorSession: 's-1' })
  await wait(30)
  assert.equal(s1b.injected.length, 0)
  const after = new DatabaseSync(dbPath)
  assert.equal(after.prepare('SELECT status FROM tasks WHERE id = ?').get(ghost.id).status, 'orphaned')
  assert.equal(after.prepare('SELECT count(*) AS n FROM notifications').get().n, 1)
  after.close()
  await second.disposers.at(-1)?.()
}))

test('S2 启动时协调者未加载：汇总保留待发，agent/created 后补发一次', withHome(async home => {
  const { openLedger, createTask, transition } = await import('../src/ledger.js')
  const ledger = await openLedger(join(home, 'state', 'orchestrator'))
  const ghost = createTask(ledger, { brief: { title: '幽灵任务', goal: 'g', acceptance: ['a'] }, coordinatorSession: 's-1' })
  transition(ledger, ghost.id, 'running', { sessionId: 'c-run', target: 'c-run' })
  ledger.close()

  const s1 = makeAgent('s-1')
  const subagents = {
    async startActivation() { throw new Error('不应派发') },
    async sendMessage() {},
    async interruptByParent() {},
    async listChildren() { return [] },
  }
  // 启动时协调者会话还没加载：catalog 读不到，但 running 的 liveness 判死照做。
  const { ctx, live, listeners, disposers } = fakeCtx({ agents: [], subagents })
  await apply(ctx, { coordinatorSession: 's-1' })
  await wait(30)
  const { DatabaseSync } = await import('node:sqlite')
  const dbPath = join(home, 'state', 'orchestrator', 'tasks.sqlite')
  const db = new DatabaseSync(dbPath)
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(ghost.id).status, 'orphaned')
  assert.equal(db.prepare('SELECT status FROM notifications').get().status, 'skipped')
  db.close()
  assert.equal(s1.injected.length, 0)

  // 协调者加载：补对账 + 补发启动时没送出去的汇总。
  live.set('s-1', s1)
  listeners.get('agent/created')({ agent: s1 })
  await wait(30)
  assert.equal(s1.injected.length, 1)
  assert.match(s1.injected[0].content[0].text, /启动对账：1 个任务/)
  assert.match(s1.injected[0].content[0].text, /幽灵任务/)

  // 再触发一次 agent/created：已汇总过，不重复打扰。
  listeners.get('agent/created')({ agent: s1 })
  await wait(30)
  assert.equal(s1.injected.length, 1)

  const sent = new DatabaseSync(dbPath)
  const statuses = sent.prepare('SELECT status FROM notifications ORDER BY rowid').all().map(row => row.status)
  assert.deepEqual(statuses, ['skipped', 'delivered'])
  sent.close()
  await disposers.at(-1)?.()
}))

test('S1：派发侧 settle completed 落「已交付待确认」，写结算消息 + 通知，task_message action:close 收成 done', withHome(async home => {
  const s1 = makeAgent('s-1')
  let settle
  const subagents = {
    async startActivation(spec) {
      return {
        childId: spec.childId,
        messageId: 'msg-1',
        result: new Promise(resolve => { settle = () => resolve({ output: [{ type: 'text', text: '改完了，测试全绿' }], stopReason: 'completed' }) }),
        dispose: async () => {},
      }
    },
    async sendMessage() {},
    async interruptByParent() {},
    async listChildren() { return [] },
  }
  const { ctx, registered, disposers } = fakeCtx({ agents: [s1], subagents })
  await apply(ctx, { coordinatorSession: 's-1' })
  const byName = Object.fromEntries(registered.map(tool => [tool.name, tool]))
  await byName.task_create.execute({ title: '甲', goal: 'g', acceptance: ['a'] }, { agent: s1 })
  const { DatabaseSync } = await import('node:sqlite')
  const dbPath = join(home, 'state', 'orchestrator', 'tasks.sqlite')
  const before = new DatabaseSync(dbPath)
  assert.equal(before.prepare('SELECT status FROM tasks').get().status, 'running')
  before.close()

  settle()
  await wait(50)
  const after = new DatabaseSync(dbPath)
  const row = after.prepare('SELECT id, status, error, last_message_json FROM tasks').get()
  // 两段式终态：自然结束先落 delivered，确认后才 done。
  assert.equal(row.status, 'delivered')
  assert.equal(row.error, null)
  assert.equal(JSON.parse(row.last_message_json).text, '改完了，测试全绿')
  const message = after.prepare("SELECT rendered FROM messages WHERE task_id = ? AND kind = 'settle'").get(row.id)
  assert.match(message.rendered, /结算.*待确认/)
  assert.equal(after.prepare("SELECT level, status FROM notifications WHERE task_id = ?").get(row.id).level, 'notify')
  after.close()
  // 协调者确认 → done；确认不再发第二条通知。
  const closed = await byName.task_message.execute({ action: 'close', task_id: row.id }, { agent: s1 })
  assert.match(closed, /已确认完成/)
  const final = new DatabaseSync(dbPath)
  assert.equal(final.prepare('SELECT status FROM tasks WHERE id = ?').get(row.id).status, 'done')
  assert.equal(final.prepare('SELECT count(*) AS n FROM notifications WHERE task_id = ?').get(row.id).n, 1)
  final.close()
  await disposers.at(-1)?.()
}))

// D5：结算自动判 done 是「子会话自然结束」这条最常见收场路径。产物必须在通知发出**之前**补齐，
// 否则通知里没有产物、也就没有 present 交付指令（T6.1 报告 §5 的偏差）。
test('D5：结算自动 done 的通知在发送前补齐产物，注入文案带清单与交付指令', withHome(async home => {
  const s1 = makeAgent('s-1')
  let childId
  let settle
  const subagents = {
    async startActivation(spec) {
      childId = spec.childId
      return {
        childId: spec.childId,
        messageId: 'msg-1',
        result: new Promise(resolve => { settle = () => resolve({ output: [{ type: 'text', text: '改完了，测试全绿' }], stopReason: 'completed' }) }),
        dispose: async () => {},
      }
    },
    async sendMessage() {},
    async interruptByParent() {},
    async listChildren() { return [] },
  }
  const target = join(home, 'work')
  mkdirSync(target)
  const report = join(target, 'report.md')
  writeFileSync(report, '# ok', 'utf8')
  // 子会话只通过 sessions 服务可达（agents 目录里只有协调者），覆盖 index 的两条查会话回退。
  const childSession = { id: undefined, ownEvents: () => [{ type: 'workspace/changes', seq: 3, data: { turn: 1 } }] }
  const { ctx, registered, disposers } = fakeCtx({
    agents: [s1],
    subagents,
    sessions: { get: id => (id === childSession.id ? childSession : undefined) },
    workspaceChanges: { summary: () => ({ cwd: target, files: [{ path: 'report.md', added: 3, deleted: 0 }] }) },
  })
  await apply(ctx, { coordinatorSession: 's-1' })
  const byName = Object.fromEntries(registered.map(tool => [tool.name, tool]))
  await byName.task_create.execute({ title: '甲', goal: 'g', acceptance: ['a'], target }, { agent: s1 })
  childSession.id = childId
  settle()
  await wait(50)

  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(home, 'state', 'orchestrator', 'tasks.sqlite'))
  const row = db.prepare('SELECT id, status, artifacts_json FROM tasks').get()
  db.close()
  assert.equal(row.status, 'delivered')
  assert.deepEqual(JSON.parse(row.artifacts_json).map(item => item.path), [report])
  // 协调者收到的通知里就是这份清单（不是空产物），并带 present 交付指令。
  assert.equal(s1.injected.length, 1)
  const text = s1.injected[0].content[0].text
  assert.match(text, /产物：/)
  assert.ok(text.includes(`- ${report} — +3/-0`))
  assert.match(text, /交付：在你自己的回合里调用 present/)
  // 同一份清单也能从 task_status 取回（错过通知的兜底路径）。
  const status = await byName.task_status.execute({ task_id: row.id }, { agent: s1 })
  assert.ok(status.includes(`- ${report} — +3/-0`))
  await disposers.at(-1)?.()
}))

test('S1：平台 subagent/end（续派/冷恢复）也能把 running 推到 cancelled 并通知', withHome(async home => {  const s1 = makeAgent('s-1')
  let childId
  const subagents = {
    async startActivation(spec) {
      childId = spec.childId
      // 首次 activation 永不结算：这里只验证平台生命周期事件这条独立通路。
      return { childId: spec.childId, messageId: 'msg-1', result: new Promise(() => {}), dispose: async () => {} }
    },
    async sendMessage() {},
    async interruptByParent() {},
    async listChildren() { return [{ id: childId ?? '', mode: 'continuable' }] },
  }
  const { ctx, registered, listeners, disposers } = fakeCtx({ agents: [s1], subagents })
  await apply(ctx, { coordinatorSession: 's-1' })
  const byName = Object.fromEntries(registered.map(tool => [tool.name, tool]))
  await byName.task_create.execute({ title: '乙', goal: 'g', acceptance: ['a'] }, { agent: s1 })
  assert.ok(listeners.has('subagent/end'), '未订阅平台生命周期事件')
  listeners.get('subagent/end')({ id: childId, local: true, stopReason: 'aborted', lastAssistantMessage: [{ type: 'text', text: '被中断了' }] })
  await wait(50)
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(home, 'state', 'orchestrator', 'tasks.sqlite'))
  const row = db.prepare('SELECT id, status, error, last_message_json FROM tasks').get()
  assert.equal(row.status, 'cancelled')
  assert.match(row.error, /stopReason=aborted/)
  // B1：结算把完整返回消息落进台账，主会话用 task_status 就读得到。
  const stored = JSON.parse(row.last_message_json)
  assert.equal(stored.stored, 'inline')
  assert.equal(stored.text, '被中断了')
  const message = db.prepare("SELECT meta_json FROM messages WHERE kind = 'settle'").get()
  assert.equal(JSON.parse(message.meta_json).source, 'lifecycle')
  assert.equal(db.prepare('SELECT count(*) AS n FROM notifications').get().n, 1)
  db.close()
  const status = await byName.task_status.execute({ task_id: row.id, include: 'full' }, { agent: s1 })
  assert.match(status, /最近返回（结算 aborted/)
  assert.match(status, /被中断了/)
  await disposers.at(-1)?.()
}))

test('B1：超 64KB 的 lastAssistantMessage 落 reports 文件，task_status 默认给路径+摘要、include=full 给全文', withHome(async home => {
  const s1 = makeAgent('s-1')
  let childId
  const subagents = {
    async startActivation(spec) {
      childId = spec.childId
      return { childId: spec.childId, messageId: 'msg-1', result: new Promise(() => {}), dispose: async () => {} }
    },
    async sendMessage() {},
    async interruptByParent() {},
    async listChildren() { return [{ id: childId ?? '', mode: 'continuable' }] },
  }
  const { ctx, registered, listeners, disposers } = fakeCtx({ agents: [s1], subagents })
  await apply(ctx, { coordinatorSession: 's-1' })
  const byName = Object.fromEntries(registered.map(tool => [tool.name, tool]))
  await byName.task_create.execute({ title: '长回执', goal: 'g', acceptance: ['a'] }, { agent: s1 })
  const big = `最后一行\n${'细'.repeat(25_000)}`
  listeners.get('subagent/end')({ id: childId, local: true, stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: big }] })
  await wait(50)
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(home, 'state', 'orchestrator', 'tasks.sqlite'))
  const row = db.prepare('SELECT id, last_message_json FROM tasks').get()
  const record = JSON.parse(row.last_message_json)
  db.close()
  assert.equal(record.stored, 'file')
  assert.ok(record.path.startsWith(join(home, 'state', 'orchestrator', 'reports')))
  assert.equal(readFileSync(record.path, 'utf8'), big)
  const preview = await byName.task_status.execute({ task_id: row.id }, { agent: s1 })
  assert.ok(preview.includes(record.path))
  assert.match(preview, /摘要：/)
  assert.ok(!preview.includes(big))
  const full = await byName.task_status.execute({ task_id: row.id, include: 'full' }, { agent: s1 })
  assert.ok(full.includes(big))
  await disposers.at(-1)?.()
}))

test('S1：waiting_user 任务收到 settle 不改状态（子任务自己报了 blocked）', withHome(async home => {
  const s1 = makeAgent('s-1')
  let childId
  const subagents = {
    async startActivation(spec) {
      childId = spec.childId
      return { childId: spec.childId, messageId: 'msg-1', result: new Promise(() => {}), dispose: async () => {} }
    },
    async sendMessage() {},
    async interruptByParent() {},
    async listChildren() { return [{ id: childId ?? '', mode: 'continuable' }] },
  }
  const { ctx, registered, listeners, disposers } = fakeCtx({ agents: [s1], subagents })
  await apply(ctx, { coordinatorSession: 's-1' })
  const byName = Object.fromEntries(registered.map(tool => [tool.name, tool]))
  await byName.task_create.execute({ title: '丙', goal: 'g', acceptance: ['a'] }, { agent: s1 })
  const { DatabaseSync } = await import('node:sqlite')
  const dbPath = join(home, 'state', 'orchestrator', 'tasks.sqlite')
  const { openLedger, transition } = await import('../src/ledger.js')
  const ledger = await openLedger(join(home, 'state', 'orchestrator'))
  const row = ledger.prepare('SELECT id FROM tasks').get()
  transition(ledger, row.id, 'waiting_user')
  ledger.close()
  listeners.get('subagent/end')({ id: childId, local: true, stopReason: 'completed' })
  await wait(20)
  const db = new DatabaseSync(dbPath)
  assert.equal(db.prepare('SELECT status FROM tasks').get().status, 'waiting_user')
  assert.equal(db.prepare("SELECT count(*) AS n FROM messages WHERE kind = 'settle'").get().n, 0)
  db.close()
  await disposers.at(-1)?.()
}))

test('P2-2 续跑委托宿主 goals：goalRounds=0（默认）create 后立刻 disarm，不订阅 turn-stopping', withHome(async home => {
  const s1 = makeAgent('s-1')
  const goals = fakeGoalService()
  const f = fakeCtx({ agents: [s1], goals })
  await apply(f.ctx, { coordinatorSession: 's-1', autoResumeQueue: false })
  const byName = Object.fromEntries(f.registered.map(tool => [tool.name, tool]))
  await byName.task_create.execute({ title: '不续跑', goal: 'g', acceptance: ['a'] }, { agent: s1 })
  const child = { id: 'm-1', session: { id: 'm-1', header: {} } }
  f.live.set('m-1', child)
  f.listeners.get('agent/created')({ agent: child })
  await wait(20)
  // 默认 0 = 与 P2-2 之前完全一致：create 后**立刻** disarm，create 也不带 maxGoalRounds。
  assert.deepEqual(goals.calls.map(call => call[0]), ['get', 'create', 'disarm'])
  assert.equal(goals.calls[1][3], null, 'goalRounds=0 时不该传 maxGoalRounds')
  assert.equal(goals.state.view.activation, 'disarmed')
  // 自建续跑器已删除：插件不再订阅 agent/turn-stopping，也没有 keepalive 审计消息。
  assert.equal(f.listeners.has('agent/turn-stopping'), false, 'P2-2 后不应再订阅 agent/turn-stopping')
  const check = await openLedger(join(home, 'state', 'orchestrator'))
  const task = listTasks(check).find(item => item.title === '不续跑')
  assert.equal(task.goal_rounds, 0)
  assert.equal(task.keep_alive_rounds, 0, '旧列停写，恒为 0')
  assert.equal(check.prepare("SELECT count(*) AS n FROM messages WHERE kind = 'keepalive'").get().n, 0)
  check.close()
  await f.disposers.at(-1)?.()
}))

test('P2-2 续跑委托宿主 goals：goalRounds=3 时 create 带 maxGoalRounds 且保持 armed', withHome(async home => {
  const s1 = makeAgent('s-1')
  const goals = fakeGoalService()
  const f = fakeCtx({ agents: [s1], goals })
  await apply(f.ctx, { coordinatorSession: 's-1', autoResumeQueue: false })
  const byName = Object.fromEntries(f.registered.map(tool => [tool.name, tool]))
  const created = await byName.task_create.execute(
    { title: '续跑', goal: 'g', acceptance: ['a'], goalRounds: 3 },
    { agent: s1 },
  )
  assert.match(created, /续跑：goalRounds=3/)
  const child = { id: 'm-1', session: { id: 'm-1', header: {} } }
  f.live.set('m-1', child)
  f.listeners.get('agent/created')({ agent: child })
  await wait(20)
  // >0：create 带 maxGoalRounds 且**不** disarm —— 轮次交给宿主 dsh-goal-round-driver。
  assert.deepEqual(goals.calls.map(call => call[0]), ['get', 'create'])
  assert.equal(goals.calls[1][3], 3, 'create 应带 maxGoalRounds=3')
  assert.equal(goals.state.view.activation, 'armed')
  assert.equal(goals.state.view.maxGoalRounds, 3)
  const check = await openLedger(join(home, 'state', 'orchestrator'))
  const task = listTasks(check).find(item => item.title === '续跑')
  assert.equal(task.goal_rounds, 3)
  assert.equal(task.goal_state.activation, 'armed')
  // task_status 显示平台 goal 的轮次（真源是 goal，不是插件自建预算）。
  const status = await byName.task_status.execute({ task_id: task.id }, { agent: s1 })
  assert.match(status, /目标状态：进行中｜自动续轮（宿主 goal 轮次驱动）/)
  assert.match(status, /目标轮次：0\/3（续跑中）/)
  check.close()
  await f.disposers.at(-1)?.()
}))

test('S1 结算：只写一条 settle；重复 subagent/end 只补消息不重复结算', withHome(async home => {
  const s1 = makeAgent('s-1')
  const spawned = { id: undefined }
  const subagents = {
    async startActivation(spec) {
      spawned.id = spec.childId
      return { childId: spec.childId, messageId: 'msg-1', result: new Promise(() => {}), dispose: async () => {} }
    },
    async sendMessage() {},
    async interruptByParent() {},
    async listChildren() { return [{ id: spawned.id ?? '', mode: 'continuable' }] },
  }
  const f = fakeCtx({ agents: [s1], subagents })
  await apply(f.ctx, { coordinatorSession: 's-1' })
  const byName = Object.fromEntries(f.registered.map(tool => [tool.name, tool]))
  await byName.task_create.execute({ title: '结算', goal: 'g', acceptance: ['a'] }, { agent: s1 })
  const child = { id: spawned.id, session: { id: spawned.id, header: {} }, status: 'running' }
  f.live.set(spawned.id, child)
  const ledger = await openLedger(join(home, 'state', 'orchestrator'))
  const taskId = ledger.prepare('SELECT id FROM tasks').get().id

  f.listeners.get('subagent/end')({ id: spawned.id, local: true, stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: '做完了' }] })
  await wait(50)
  const { getTask } = await import('../src/ledger.js')
  assert.equal(getTask(ledger, taskId).status, 'delivered')
  assert.equal(getTask(ledger, taskId).last_message.text, '做完了')
  assert.equal(ledger.prepare("SELECT count(*) AS n FROM messages WHERE kind = 'settle' AND task_id = ?").get(taskId).n, 1)
  // 重复的 subagent/end（派发侧 + 生命周期双到达）：只补消息，不再迁移/不再写 settle。
  f.listeners.get('subagent/end')({ id: spawned.id, local: true, stopReason: 'completed' })
  await wait(20)
  assert.equal(ledger.prepare("SELECT count(*) AS n FROM messages WHERE kind = 'settle' AND task_id = ?").get(taskId).n, 1)
  ledger.close()
  await f.disposers.at(-1)?.()
}))

test('注册 /api/orchestrator 只读路由：POST + buffered + snapshot', withHome(async () => {
  const s1 = makeAgent('s-1')
  const { ctx, routes } = fakeCtx({ agents: [s1] })
  await apply(ctx, { coordinatorSession: 's-1' })
  const route = routes.find(spec => spec.path === '/api/orchestrator')
  assert.ok(route !== undefined, '未注册只读路由')
  assert.deepEqual(route.methods, ['POST'])
  assert.equal(route.requestBody, 'buffered')
  const response = await route.fetch(new Request('http://localhost/api/orchestrator', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: 'snapshot' }),
  }))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.deepEqual(body.mainSession, { id: 's-1', live: true, context: null })
  // P2-4（D6）：没装 agentTeams 板 API 时快照里是稳定降级形状（面板隐藏该分区，不影响现有流程）。
  assert.equal(body.teamBoard.enabled, false)
  assert.deepEqual(body.teamBoard.rows, [])
  assert.equal(body.teamBoard.degraded.code, 'TEAM_BOARD_UNAVAILABLE')
}))

// —— P2-4（D6）：官方 Team 板只读快照 + 确认交付反写（CAS） ——

/** 与 rc.5 同形状的 fake：只读行 + CAS 更新；记录每次调用，用于断言「没有派发、没有越权写」。 */
function fakeBoardService(overrides = {}) {
  const calls = []
  const tasks = [{
    id: 'task-3', revision: 2, subject: '官方任务', description: '16 KiB 正文不进快照',
    status: 'in_progress', blockedBy: [], writeScopes: [], ready: false, writeScopeWarnings: [],
  }]
  return {
    calls,
    isEnabled(agent) { calls.push(['isEnabled', agent?.id ?? null]); return overrides.enabled ?? true },
    listTasks() { calls.push(['listTasks']); return tasks.map(task => ({ ...task })) },
    async updateTask(agent, request) {
      calls.push(['updateTask', request])
      if (overrides.failUpdate !== undefined) throw overrides.failUpdate
      return { ...tasks[0], revision: request.expectedRevision + 1, status: 'completed' }
    },
  }
}

/** 本进程写过的全部运行日志（按天分文件；测试只关心事件名与字段在不在）。 */
const logsOf = home => {
  const dir = join(home, 'state', 'orchestrator', 'logs')
  return readdirSync(dir)
    .filter(name => name.endsWith('.jsonl'))
    .map(name => readFileSync(join(dir, name), 'utf8'))
    .join('\n')
}

test('P2-4 快照：装了官方板就下发只读行，且读板不创建任务、不调 updateTask', withHome(async () => {
  const s1 = makeAgent('s-1')
  const agentTeams = fakeBoardService()
  const f = fakeCtx({ agents: [s1], agentTeams })
  await apply(f.ctx, { coordinatorSession: 's-1' })
  const route = f.routes.find(spec => spec.path === '/api/orchestrator')
  const body = await (await route.fetch(new Request('http://localhost/api/orchestrator', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: 'snapshot' }),
  }))).json()
  assert.equal(body.teamBoard.enabled, true)
  assert.deepEqual(body.teamBoard.rows.map(row => row.id), ['task-3'])
  assert.equal('description' in body.teamBoard.rows[0], false)
  // 只读：快照只调 isEnabled/listTasks，绝不写官方板。
  assert.deepEqual(agentTeams.calls.filter(([kind]) => kind === 'updateTask'), [])
  assert.equal(f.registered.length, 10, '没有新增工具面')
  await f.disposers.at(-1)?.()
}))

test('P2-4 反写：task_create(teamTaskId) → 确认交付 → updateTask({action:"complete", expectedRevision})', withHome(async home => {
  const s1 = makeAgent('s-1')
  const agentTeams = fakeBoardService()
  const f = fakeCtx({ agents: [s1], agentTeams })
  const { getTask: readTask, transition: move } = await import('../src/ledger.js')
  await apply(f.ctx, { coordinatorSession: 's-1' })
  const byName = Object.fromEntries(f.registered.map(tool => [tool.name, tool]))
  const created = await byName.task_create.execute(
    { title: '反写任务', goal: '把结果写回官方板', acceptance: ['a'], teamTaskId: 'task-3' },
    { agent: s1 },
  )
  assert.match(created, /官方板：已关联「task-3」/)
  const ledger = await openLedger(join(home, 'state', 'orchestrator'))
  const task = ledger.prepare('SELECT * FROM tasks').get()
  assert.equal(task.team_task_id, 'task-3')
  assert.equal(task.team_task_revision, 2)
  // 推到「已交付待确认」（task_report done 要子会话身份；反写只挂在 closeDelivered 上，路径无关）。
  if (readTask(ledger, task.id).status !== 'running') move(ledger, task.id, 'running', { sessionId: 'c-1', target: 'c-1' })
  move(ledger, task.id, 'delivered')
  const closed = await byName.task_message.execute({ action: 'close', task_id: task.id }, { agent: s1 })
  assert.match(closed, /已确认完成/)
  await wait(20)
  const updates = agentTeams.calls.filter(([kind]) => kind === 'updateTask').map(([, request]) => request)
  assert.deepEqual(updates, [{ taskId: 'task-3', expectedRevision: 2, action: 'complete' }])
  assert.equal(readTask(ledger, task.id).status, 'done')
  // 反写没有变成第二条派发路径：全程只有 task_create 那一次 spawn。
  assert.equal(f.sent.length, 0, '反写不往会话里注入消息')
  ledger.close()
  await f.disposers.at(-1)?.()
}))

test('P2-4 反写失败只 warn：官方板报错时本地任务照常 done，日志记 confirm-failed', withHome(async home => {
  const s1 = makeAgent('s-1')
  const agentTeams = fakeBoardService({ failUpdate: Object.assign(new Error('only an in-progress task can complete'), { code: 'TEAM_TASK_INVALID_TRANSITION' }) })
  const f = fakeCtx({ agents: [s1], agentTeams })
  const { getTask: readTask, transition: move } = await import('../src/ledger.js')
  await apply(f.ctx, { coordinatorSession: 's-1' })
  const byName = Object.fromEntries(f.registered.map(tool => [tool.name, tool]))
  await byName.task_create.execute({ title: '反写失败', goal: 'g', acceptance: ['a'], teamTaskId: 'task-3' }, { agent: s1 })
  const ledger = await openLedger(join(home, 'state', 'orchestrator'))
  const task = ledger.prepare('SELECT * FROM tasks').get()
  if (readTask(ledger, task.id).status !== 'running') move(ledger, task.id, 'running', { sessionId: 'c-2', target: 'c-2' })
  move(ledger, task.id, 'delivered')
  const closed = await byName.task_message.execute({ action: 'close', task_id: task.id }, { agent: s1 })
  assert.match(closed, /已确认完成/, '本地交付不受反写失败影响')
  await wait(20)
  assert.equal(readTask(ledger, task.id).status, 'done')
  assert.ok(f.warnings.some(message => /官方 Team 板未反写成功/.test(message)), f.warnings.join(' | '))
  assert.match(logsOf(home), /team\.board\.confirm-failed/)
  ledger.close()
  await f.disposers.at(-1)?.()
}))

test('P2-4 反写：超时自动完成不反写官方板（本地 done，日志 team.board.skipped 原因 timeout）', withHome(async home => {
  const s1 = makeAgent('s-1')
  const agentTeams = fakeBoardService()
  const f = fakeCtx({ agents: [s1], agentTeams })
  const { closeDelivered, CLOSE_REASONS } = await import('../src/delivered.js')
  const { getTask: readTask, transition: move } = await import('../src/ledger.js')
  await apply(f.ctx, { coordinatorSession: 's-1' })
  const byName = Object.fromEntries(f.registered.map(tool => [tool.name, tool]))
  await byName.task_create.execute({ title: '超时不反写', goal: 'g', acceptance: ['a'], teamTaskId: 'task-3' }, { agent: s1 })
  const ledger = await openLedger(join(home, 'state', 'orchestrator'))
  const task = ledger.prepare('SELECT * FROM tasks').get()
  if (readTask(ledger, task.id).status !== 'running') move(ledger, task.id, 'running', { sessionId: 'c-3', target: 'c-3' })
  move(ledger, task.id, 'delivered')
  // 模拟 delivered sweeper：它调的就是 closeDelivered({ reason:'timeout', by:'timeout' })。
  const outcome = closeDelivered({
    db: ledger,
    taskId: task.id,
    reason: CLOSE_REASONS.timeout,
    by: 'timeout',
    releaseSession: () => {},
    completeGoal: () => {},
    cleanupWorktree: () => {},
    pump: () => {},
  })
  assert.equal(outcome.ok, true)
  await wait(20)
  assert.equal(readTask(ledger, task.id).status, 'done', '超时照常收成本地 done')
  assert.deepEqual(
    agentTeams.calls.filter(([kind]) => kind === 'updateTask'),
    [],
    '超时不是人的确认：官方板一次都不写',
  )
  assert.equal(f.warnings.some(message => /官方 Team 板未反写成功/.test(message)), false, '超时跳过是正常降级，不该 warn')
  const log = logsOf(home)
  assert.match(log, /team\.board\.skipped/)
  assert.match(log, /"reason":"timeout"/)
  assert.doesNotMatch(log, /team\.board\.confirmed/, '没有任何成功反写事件')
  ledger.close()
  await f.disposers.at(-1)?.()
}))

test('connection 晚于插件加载：ctx.inject 就绪后仍注册只读路由', withHome(async () => {
  const s1 = makeAgent('s-1')
  const { ctx, routes, injections } = fakeCtx({ agents: [s1], withInject: true })
  await apply(ctx, { coordinatorSession: 's-1' })
  assert.equal(routes.length, 0, 'apply 时不应假装注册成功')
  assert.equal(injections.length, 1)
  assert.deepEqual(injections[0].services, ['connection'])

  // 模拟 cordis：connection 服务就绪后回调 scope
  const connection = { fetch: { register(spec) { routes.push(spec); return () => {} } } }
  injections[0].callback({ connection, effect: fn => { fn(); return () => {} } })
  assert.equal(routes.length, 1)
  assert.equal(routes[0].path, '/api/orchestrator')
  assert.deepEqual(routes[0].methods, ['POST'])
}))

test('cordis.patch.yml 指向 scoped 包名', () => {
  const yaml = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(yaml, /insert:/)
  assert.match(yaml, /id: orchestrator/)
  assert.match(yaml, /name: '@wjj865-code\/dsh-orchestrator'/)
})


test('settings.main_session_id 的主会话调用 wait_agent 也被 guard 拒绝（不依赖预设）', withHome(async () => {
  const s1 = makeAgent('s-1')
  const other = makeAgent('s-2')
  const sessionController = { async create() { return { sessionId: 's-1' } }, async rename() {} }
  const { ctx, guards, routes } = fakeCtx({ agents: [s1, other], sessionController })
  await apply(ctx, {})
  const route = routes.find(spec => spec.path === '/api/orchestrator')
  const opened = await route.fetch(new Request('http://x/api/orchestrator', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: 'open-main' }),
  }))
  assert.equal((await opened.json()).ok, true)
  assert.equal(guards.length, 1)
  const guard = guards[0]
  assert.match(guard({ name: 'wait_agent', agent: s1 }), /禁止阻塞等待/)
  assert.match(guard({ name: 'wait_agent', agent: s1 }), /task_list \/ task_status/)
  assert.equal(guard({ name: 'wait_agent', agent: other }), undefined)
  assert.equal(guard({ name: 'task_list', agent: s1 }), undefined)
}))


test('guard 覆盖整个 COORDINATOR_DENY 名单：主会话全拒、子会话同名放行、同步返回不阻塞', withHome(async () => {
  const main = makeAgent('s-1')
  const sub = makeAgent('m-1')
  const { ctx, guards } = fakeCtx({ agents: [main, sub] })
  await apply(ctx, { coordinatorSession: 's-1' })
  assert.equal(guards.length, 1)
  const guard = guards[0]
  assert.ok(COORDINATOR_DENY.length > 10)
  for (const toolName of COORDINATOR_DENY) {
    const denied = guard({ name: toolName, agent: main })
    assert.equal(typeof denied, 'string', `${toolName} 应被主会话 guard 拒绝`)
    assert.match(denied, toolName === 'wait_agent' ? /禁止阻塞等待/ : /协调者禁止的工具/)
    assert.equal(guard({ name: toolName, agent: sub }), undefined, `${toolName} 不应影响子会话`)
  }
  for (const allowed of ['task_create', 'task_list', 'task_status', 'task_message', 'context', 'memory_note', 'read_workspace', 'present', 'ask_user_question', 'read', 'skill', 'task_report', 'task_detail', 'plan_save']) {
    assert.equal(guard({ name: allowed, agent: main }), undefined, `${allowed} 应放行`)
  }
  // P1-B：旧工具名已删除，调用时执行层给「改成什么」，不是静默失败（映射表单源 src/tool-migrations.js）。
  for (const [legacy, hint] of [['task_stop', /action: 'stop'/], ['task_retry', /action: 'retry'/], ['task_close', /action: 'close'/], ['task_inbox', /view: 'inbox'/], ['history_search', /mode: 'history'/], ['project_context', /mode: 'project'/]]) {
    const text = guard({ name: legacy, agent: main })
    assert.equal(typeof text, 'string', `${legacy} 应返回迁移提示`)
    assert.match(text, /已删除/)
    assert.match(text, hint)
    assert.match(guard({ name: legacy, agent: sub }), /已删除/, `${legacy} 的迁移提示不挑 agent`)
  }
}))


test('派发失败给主会话发一条带原因的通知（无 sender 也能投递）', withHome(async () => {
  const s1 = makeAgent('s-1')
  const subagents = {
    async startActivation() { throw new Error('spawn boom') },
    async sendMessage() {},
    async interruptByParent() {},
    async listChildren() { return [] },
  }
  const { ctx, registered } = fakeCtx({ agents: [s1], subagents })
  await apply(ctx, { coordinatorSession: 's-1' })
  const create = registered.find(tool => tool.name === 'task_create')
  const result = await create.execute({ title: '失败任务', goal: 'g', acceptance: ['a'] }, { agent: s1 })
  assert.match(result, /任务协调失败/)
  await wait(30)
  assert.equal(s1.injected.length, 1)
  assert.match(s1.injected[0].content[0].text, /失败/)
  assert.match(s1.injected[0].content[0].text, /spawn boom/)
}))

test('index 装配主会话预设守护（selectPreset/guardPreset）', () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(source, /selectPreset:/)
  assert.match(source, /guardPreset/)
})

/** D1 透传用夹具：记下每个 startActivation 的入参，activation 永不结算（只为读 spec）。 */
function recordingSubagents(spawned) {
  return {
    async startActivation(spec) {
      spawned.push(spec)
      return { childId: spec.childId, messageId: 'msg-1', result: new Promise(() => {}), dispose: async () => {} }
    },
    async sendMessage() {},
    async interruptByParent() {},
    async listChildren() { return [] },
  }
}

test('D1：config.workerPreset 透传到子会话 startActivation 的 agentPreset', withHome(async () => {
  const s1 = makeAgent('s-1')
  const spawned = []
  const { ctx, registered, disposers } = fakeCtx({ agents: [s1], subagents: recordingSubagents(spawned) })
  await apply(ctx, { coordinatorSession: 's-1', workerPreset: 'orch-debug' })
  const create = registered.find(tool => tool.name === 'task_create')
  await create.execute({ title: '调试子任务', goal: 'g', acceptance: ['a'] }, { agent: s1 })
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0].agentPreset, 'orch-debug')
  assert.equal(spawned[0].provider, 'spawn')
  await disposers.at(-1)?.()
}))

test('D1：不配 workerPreset 时子会话仍用默认 worker 预设（行为不变）', withHome(async () => {
  const s1 = makeAgent('s-1')
  const spawned = []
  const { ctx, registered, disposers } = fakeCtx({ agents: [s1], subagents: recordingSubagents(spawned) })
  await apply(ctx, { coordinatorSession: 's-1' })
  const create = registered.find(tool => tool.name === 'task_create')
  await create.execute({ title: '普通任务', goal: 'g', acceptance: ['a'] }, { agent: s1 })
  assert.equal(spawned[0].agentPreset, 'dsh-orchestrator-worker')
  await disposers.at(-1)?.()
}))

test('D1：workerPreset 写成非法 id 时回落默认并 warn', withHome(async () => {
  const s1 = makeAgent('s-1')
  const spawned = []
  const { ctx, registered, warnings, disposers } = fakeCtx({ agents: [s1], subagents: recordingSubagents(spawned) })
  await apply(ctx, { coordinatorSession: 's-1', workerPreset: 'Orch Debug' })
  assert.ok(warnings.some(message => /workerPreset/.test(message)), warnings.join(' | '))
  const create = registered.find(tool => tool.name === 'task_create')
  await create.execute({ title: '非法预设', goal: 'g', acceptance: ['a'] }, { agent: s1 })
  assert.equal(spawned[0].agentPreset, 'dsh-orchestrator-worker')
  await disposers.at(-1)?.()
}))

test('W1 空闲看门狗接入：启动即巡检空闲 running 任务、只告警不改状态，卸载时停掉', withHome(async home => {
  // 预置一条 40 分钟无动静的 running 任务；子会话 live 且在 catalog 里，启动对账不会先标 orphaned。
  const { openLedger, createTask, transition, getTask } = await import('../src/ledger.js')
  const ledger = await openLedger(join(home, 'state', 'orchestrator'))
  const task = createTask(ledger, {
    brief: { title: '看门狗任务', goal: 'g', constraints: [], acceptance: ['a'], refs: [] },
    coordinatorSession: 's-1',
  })
  transition(ledger, task.id, 'running', { sessionId: 'c-1', target: 'c-1' })
  const aged = Date.now() - 40 * 60_000
  ledger.prepare('UPDATE tasks SET created_at = ?, updated_at = ?, last_event_at = ? WHERE id = ?')
    .run(aged, aged, aged, task.id)
  ledger.close()

  const s1 = makeAgent('s-1')
  const child = makeAgent('c-1')
  const subagents = {
    async startActivation() { throw new Error('看门狗不应派发任务') },
    async sendMessage() {},
    async interruptByParent() {},
    async listChildren() { return [{ id: 'c-1', mode: 'continuable', label: 'x', activity: 'inactive' }] },
  }
  const f = fakeCtx({ agents: [s1, child], subagents })
  await apply(f.ctx, { coordinatorSession: 's-1', mergeWindowMs: 5, watchdogIdleMinutes: 15 })

  // 启动即巡检一次：汇总通知直接注入协调者（system 通知，不依赖子会话 sender）。
  assert.equal(s1.injected.length, 1)
  const text = s1.injected[0].content[0].text
  assert.match(text, /空闲看门狗/)
  assert.match(text, /看门狗任务/)
  assert.match(text, /只告警、不改任务状态/)

  const check = await openLedger(join(home, 'state', 'orchestrator'))
  assert.equal(getTask(check, task.id).status, 'running', '看门狗不能改任务状态')
  const notification = check.prepare('SELECT level, status FROM notifications WHERE task_id = ?').get(task.id)
  assert.equal(notification.level, 'notify')
  assert.equal(notification.status, 'delivered')
  check.close()

  // 卸载清理：看门狗随 effect 停掉，不阻塞卸载。
  await f.disposers[0]()
}))

test('G1：apply 接入 goals：派发后 create+disarm，台账写只读镜像', withHome(async home => {
  const goals = fakeGoalService()
  const s1 = makeAgent('s-1')
  const f = fakeCtx({ agents: [s1], goals })
  await apply(f.ctx, { coordinatorSession: 's-1', autoResumeQueue: false })
  const create = f.registered.find(tool => tool.name === 'task_create')
  const text = await create.execute({ title: 'G1 目标', goal: '实现目标', acceptance: ['a'] }, { agent: s1 })
  assert.match(text, /已派发/)
  // 子 agent 晚于派发进注册表：agent/created 到达后桥再 create+disarm。
  const child = { id: 'm-1', session: { id: 'm-1', header: {} } }
  f.live.set('m-1', child)
  f.listeners.get('agent/created')({ agent: child })
  await wait(20)
  assert.deepEqual(goals.calls.map(call => call[0]), ['get', 'create', 'disarm'])
  assert.equal(goals.state.view.activation, 'disarmed')
  const check = await openLedger(join(home, 'state', 'orchestrator'))
  const task = listTasks(check).find(item => item.title === 'G1 目标')
  assert.equal(task.goal_state.phase, 'active')
  assert.equal(task.goal_state.activation, 'disarmed')
  assert.equal(task.goal_state.objective, '实现目标')
  check.close()
  await f.disposers.at(-1)?.()
}))

test('G1：没有 goals 服务时 apply 与派发静默降级（不 warn、不写镜像）', withHome(async home => {
  const s1 = makeAgent('s-1')
  const f = fakeCtx({ agents: [s1] })
  await apply(f.ctx, { coordinatorSession: 's-1', autoResumeQueue: false })
  assert.equal(f.warnings.some(message => /goal/i.test(message)), false)
  const create = f.registered.find(tool => tool.name === 'task_create')
  await create.execute({ title: '无 goals', goal: 'g', acceptance: ['a'] }, { agent: s1 })
  const child = { id: 'm-1', session: { id: 'm-1', header: {} } }
  f.live.set('m-1', child)
  f.listeners.get('agent/created')({ agent: child })
  await wait(10)
  const check = await openLedger(join(home, 'state', 'orchestrator'))
  const task = listTasks(check).find(item => item.title === '无 goals')
  assert.equal(task.goal_state, null)
  check.close()
  await f.disposers.at(-1)?.()
}))

test('0.25.0：启动把老 profile 残留的轮换 settings 键一次性清掉（含崩溃 marker）', withHome(async home => {
  const { openLedger, setSetting } = await import('../src/ledger.js')
  const ledger = await openLedger(join(home, 'state', 'orchestrator'))
  const at = Date.now() - 60_000
  setSetting(ledger, 'main_session_id', 'session-new')
  // 老版本写过的 5 个键：main_session_created_at / main_rotation_at / main_rotation_last /
  // main_rotation_pending（崩溃锚点）/ main_rotation_checked_at。marker 必须清——
  // 留着的话回滚旧版本会按它「补完轮换」去归档一个毫不相干的会话。
  for (const key of ['main_session_created_at', 'main_rotation_at', 'main_rotation_last', 'main_rotation_checked_at']) {
    setSetting(ledger, key, String(at))
  }
  setSetting(ledger, 'main_rotation_pending', JSON.stringify({ newId: 'session-new', oldId: 'session-old', at, reasons: ['age'] }))
  ledger.close()

  const created = []
  const f = fakeCtx({
    agents: [makeAgent('session-new')],
    sessionController: {
      async create(request) { created.push(request); return { sessionId: 'session-should-not-exist' } },
    },
  })
  await apply(f.ctx, {})

  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(home, 'state', 'orchestrator', 'tasks.sqlite'))
  const read = key => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value
  assert.equal(read('main_session_id'), 'session-new', '指针不动')
  for (const key of ['main_session_created_at', 'main_rotation_at', 'main_rotation_last', 'main_rotation_pending', 'main_rotation_checked_at']) {
    assert.equal(read(key), undefined, `${key} 应被一次性清掉`)
  }
  assert.equal(created.length, 0, '启动不建会话（没有轮换动作了）')
  db.close()
  await f.disposers.at(-1)?.()
}))


