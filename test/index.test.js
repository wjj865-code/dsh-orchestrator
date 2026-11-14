import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject, name } from '../index.js'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

function makeAgent(id, { knownTools = ['read', 'write', 'bash', 'task_report', 'ask_user', 'show_view'], restrictableTools = knownTools } = {}) {
  const restrictions = []
  const injected = []
  return {
    id,
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

function fakeCtx({ agent = makeAgent('s-1'), agents, spawnResult = { member: { id: 'm-1', name: 'w-1' } }, subagents: subagentsOverride, withInject = false, connection, sessionController, workspaces } = {}) {
  const live = new Map((agents ?? [agent]).map(item => [item.id, item]))
  const registered = []
  const routes = []
  const injections = []
  const routeService = connection ?? { fetch: { register(spec) { routes.push(spec); return () => {} } } }
  const warnings = []
  const infos = []
  const listeners = new Map()
  const sent = []
  const disposers = []
  const guards = []
  const promptContexts = []
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
      return undefined
    },
    ...(withInject
      ? { inject(services, callback) { injections.push({ services, callback }); return () => {} } }
      : {}),
    on(event, handler) { listeners.set(event, handler); return () => {} },
    effect(callback) { disposers.push(callback()); return () => {} },
    agentTeams: {
      async spawnTeammate() { return spawnResult },
      async sendMessage(sender, input) { sent.push([sender, input]) },
      async interrupt() {},
      listMembers() { return [] },
    },
    subagents: subagentsOverride ?? {
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
    },
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

test('inject 声明包含 tools、agentTeams、agents、systemPrompt、subagents', () => {
  assert.equal(name, 'dsh-orchestrator')
  assert.deepEqual(new Set(inject), new Set(['tools', 'agentTeams', 'agents', 'systemPrompt', 'subagents']))
})

test('缺 systemPrompt 时 warn，guard 仍然安装', withHome(async () => {
  const { ctx, warnings, guards } = fakeCtx()
  delete ctx.systemPrompt
  await apply(ctx, {})
  assert.ok(warnings.some(message => /systemPrompt/.test(message)))
  assert.equal(guards.length, 1)
}))

test('apply 注册 6 个工具，只写 $DSH_HOME/state/orchestrator', withHome(async home => {
  const { ctx, registered } = fakeCtx()
  await apply(ctx, { coordinatorSession: 's-1' })
  assert.deepEqual(registered.map(tool => tool.name).sort(),
    ['task_create', 'task_list', 'task_message', 'task_report', 'task_status', 'task_stop'])
  assert.deepEqual(readdirSync(home), ['state'])
  assert.deepEqual(readdirSync(join(home, 'state', 'orchestrator')).filter(file => !file.startsWith('tasks.sqlite')), [])
}))

test('无 coordinatorSession：warn 但工具注册；派活给「先打开主会话」提示', withHome(async () => {
  const { ctx, registered, warnings } = fakeCtx()
  await apply(ctx, {})
  assert.equal(registered.length, 6)
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
  const { ctx, routes } = fakeCtx({ sessionController, workspaces })
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
  await apply(ctx, { coordinatorSession: 's-1', mergeWindowMs: 5 })
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

test('协调者白名单：只 deny 已知的危险工具，保留 ask_user/show_view', withHome(async () => {
  const agent = makeAgent('s-1')
  const { ctx } = fakeCtx({ agent })
  await apply(ctx, { coordinatorSession: 's-1' })
  assert.equal(agent.restrictions.length, 1)
  const deny = agent.restrictions[0].deny
  assert.ok(deny.includes('read'))
  assert.ok(deny.includes('write'))
  assert.ok(deny.includes('bash'))
  assert.ok(deny.includes('task_report'))
  assert.equal(deny.includes('ask_user'), false)
  assert.equal(deny.includes('show_view'), false)
}))

test('白名单只取 restrictableNames，不把 scope 内工具当全局工具', withHome(async () => {
  const agent = makeAgent('s-1', {
    knownTools: ['read', 'send_message', 'ask_user'],
    restrictableTools: ['read', 'ask_user'],
  })
  const { ctx } = fakeCtx({ agent })
  await apply(ctx, { coordinatorSession: 's-1' })
  assert.equal(agent.restrictions.length, 1)
  assert.deepEqual(agent.restrictions[0].deny, ['read'])
}))

test('wait_agent 是 scope 注册，不在 restrictableNames 时 deny 不包含它', withHome(async () => {
  const agent = makeAgent('s-1', {
    knownTools: ['read', 'wait_agent', 'spawn_teammate', 'ask_user'],
    restrictableTools: ['read', 'ask_user'],
  })
  const { ctx } = fakeCtx({ agent })
  await apply(ctx, { coordinatorSession: 's-1' })
  const deny = agent.restrictions[0].deny
  assert.ok(deny.includes('read'))
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

test('缺 tools.guard 时 warn 不崩，6 工具照常注册', withHome(async () => {
  const { ctx, warnings, registered } = fakeCtx()
  delete ctx.tools.guard
  await apply(ctx, {})
  assert.ok(warnings.some(message => /tools\.guard/.test(message)))
  assert.equal(registered.length, 6)
}))

test('系统提示只渲染给已绑定协调者，绑定后下一步生效', withHome(async () => {
  const s1 = makeAgent('s-1')
  const other = makeAgent('s-2')
  const { ctx, promptContexts } = fakeCtx({ agents: [s1, other] })
  await apply(ctx, { coordinatorSession: 's-1' })
  assert.equal(promptContexts.length, 1)
  const entry = promptContexts[0]
  assert.equal(entry.order, 130)
  assert.equal(entry.interpolate, false)
  assert.equal(entry.text({ agent: other }), '')
  assert.match(entry.text({ agent: s1 }), /禁止使用 wait_agent/)
  assert.match(entry.text({ agent: s1 }), /task_list \/ task_status/)
  assert.match(entry.text({ agent: s1 }), /优先于平台默认的 Team Lead 等待要求/)
  assert.match(entry.text({ agent: s1 }), /The Lead must wait for required teammates/)
  assert.equal(entry.text({ agent: other }), '')
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
  await apply(ctx, { coordinatorSession: 's-1', mergeWindowMs: 5 })
  const byName = Object.fromEntries(registered.map(tool => [tool.name, tool]))
  const created = await byName.task_create.execute(
    { title: '甲', goal: 'g', acceptance: ['a'] },
    { agent: coordinator },
  )
  assert.match(created, /已派发/)
  const signal = new AbortController().signal
  await byName.task_report.execute(
    { task_id: created.match(/任务 (t-[0-9a-f]+)/)[1], status: 'done', summary: '完成' },
    { agent: teammate, signal },
  )
  await wait(30)
  assert.equal(sent.length, 0)
  assert.equal(coordinator.injected.length, 1)
  assert.match(coordinator.injected[0].content[0].text, /任务「甲」完成/)
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
  await apply(ctx, { mergeWindowMs: 5 })
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
  await apply(ctx, { coordinatorSession: 's-1', mergeWindowMs: 5 })
  const create = registered.find(tool => tool.name === 'task_create')
  const created = await create.execute({ title: '甲', goal: 'g', acceptance: ['a'] }, { agent: { id: 's-1' } })
  const taskId = created.match(/任务 (t-[0-9a-f]+)/)[1]
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
  await apply(ctx, { coordinatorSession: 's-1', mergeWindowMs: 600000 })
  const byName = Object.fromEntries(registered.map(tool => [tool.name, tool]))
  const created = await byName.task_create.execute({ title: '甲', goal: 'g', acceptance: ['a'] }, { agent: coordinator })
  const taskId = created.match(/任务 (t-[0-9a-f]+)/)[1]
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
}))

test('注入失败记 failed + reason，不是 skipped', withHome(async home => {
  const coordinator = makeAgent('s-1')
  coordinator.steer = () => { throw new Error('steer 失败') }
  const teammate = { id: 'm-1' }
  const { ctx, registered } = fakeCtx({ agent: coordinator })
  await apply(ctx, { coordinatorSession: 's-1', mergeWindowMs: 5 })
  const byName = Object.fromEntries(registered.map(tool => [tool.name, tool]))
  const created = await byName.task_create.execute({ title: '甲', goal: 'g', acceptance: ['a'] }, { agent: coordinator })
  const taskId = created.match(/任务 (t-[0-9a-f]+)/)[1]
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
  assert.equal(rows.filter(row => row.status === 'running').length, 2)
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
  assert.deepEqual(body.mainSession, { id: 's-1', live: true })
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

test('cordis.patch.yml 指向 dsh-orchestrator', () => {
  const yaml = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(yaml, /insert:/)
  assert.match(yaml, /id: orchestrator/)
  assert.match(yaml, /name: dsh-orchestrator/)
})
