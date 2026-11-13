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

function fakeCtx({ agent = makeAgent('s-1'), agents, spawnResult = { member: { id: 'm-1', name: 'w-1' } } } = {}) {
  const live = new Map((agents ?? [agent]).map(item => [item.id, item]))
  const registered = []
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
    get: () => ({ get: id => live.get(id) }),
    on(event, handler) { listeners.set(event, handler); return () => {} },
    effect(callback) { disposers.push(callback()); return () => {} },
    agentTeams: {
      async spawnTeammate() { return spawnResult },
      async sendMessage(sender, input) { sent.push([sender, input]) },
      async interrupt() {},
      listMembers() { return [] },
    },
  }
  return { ctx, registered, warnings, infos, listeners, sent, disposers, agent, live, guards, promptContexts }
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

test('inject 声明包含 tools、agentTeams、agents、systemPrompt', () => {
  assert.equal(name, 'dsh-orchestrator')
  assert.deepEqual(new Set(inject), new Set(['tools', 'agentTeams', 'agents', 'systemPrompt']))
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

test('无 coordinatorSession：warn 但工具注册；无调用方 agent 时派活给可读错误', withHome(async () => {
  const { ctx, registered, warnings } = fakeCtx()
  await apply(ctx, {})
  assert.equal(registered.length, 6)
  assert.ok(warnings.some(message => /coordinatorSession/.test(message)))
  const create = registered.find(tool => tool.name === 'task_create')
  const text = await create.execute({ title: 't', goal: 'g', acceptance: ['a'] })
  assert.match(text, /任务协调失败：无法绑定协调者会话/)
}))

test('无配置首次 task_create 自动绑定调用方，已绑定不重绑', withHome(async home => {
  const s1 = makeAgent('s-1')
  const s2 = makeAgent('s-2')
  const { ctx, registered, infos } = fakeCtx({ agents: [s1, s2] })
  await apply(ctx, {})
  const byName = Object.fromEntries(registered.map(tool => [tool.name, tool]))
  const created = await byName.task_create.execute({ title: '甲', goal: 'g', acceptance: ['a'] }, { agent: s1 })
  assert.match(created, /已派发/)
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(home, 'state', 'orchestrator', 'tasks.sqlite'))
  assert.equal(db.prepare('SELECT value FROM settings WHERE key = ?').get('coordinator_session_id').value, 's-1')
  assert.equal(db.prepare('SELECT coordinator_session FROM tasks').get().coordinator_session, 's-1')
  assert.equal(s1.restrictions.length, 1)
  assert.equal(s2.restrictions.length, 0)
  assert.ok(infos.some(message => /已绑定/.test(message)))

  await byName.task_create.execute({ title: '乙', goal: 'g', acceptance: ['a'] }, { agent: s2 })
  assert.equal(db.prepare('SELECT value FROM settings WHERE key = ?').get('coordinator_session_id').value, 's-1')
  assert.equal(db.prepare('SELECT count(*) AS n FROM tasks').get().n, 2)
  assert.equal(s2.restrictions.length, 0)
  db.close()
}))

test('并发首次绑定先到先得，后到不覆盖', withHome(async home => {
  const s1 = makeAgent('s-1')
  const s2 = makeAgent('s-2')
  const { ctx, registered } = fakeCtx({ agents: [s1, s2] })
  await apply(ctx, {})
  const byName = Object.fromEntries(registered.map(tool => [tool.name, tool]))
  await Promise.all([
    byName.task_create.execute({ title: '甲', goal: 'g', acceptance: ['a'] }, { agent: s1 }),
    byName.task_create.execute({ title: '乙', goal: 'g', acceptance: ['a'] }, { agent: s2 }),
  ])
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(home, 'state', 'orchestrator', 'tasks.sqlite'))
  assert.equal(db.prepare('SELECT value FROM settings WHERE key = ?').get('coordinator_session_id').value, 's-1')
  assert.equal(db.prepare('SELECT count(*) AS n FROM tasks').get().n, 2)
  db.close()
  assert.equal(s1.restrictions.length, 1)
  assert.equal(s2.restrictions.length, 0)
}))

test('子会话不能首次绑定自己', withHome(async home => {
  const root = makeAgent('root-1')
  const sub = makeAgent('sub-1')
  sub.session = { header: { parentSession: 'root-1' } }
  const { ctx, registered } = fakeCtx({ agents: [root, sub] })
  await apply(ctx, {})
  const byName = Object.fromEntries(registered.map(tool => [tool.name, tool]))
  const result = await byName.task_create.execute({ title: '甲', goal: 'g', acceptance: ['a'] }, { agent: sub })
  assert.match(result, /只有协调者会话（Team Lead）/)
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(home, 'state', 'orchestrator', 'tasks.sqlite'))
  assert.equal(db.prepare('SELECT count(*) AS n FROM settings').get().n, 0)
  assert.equal(db.prepare('SELECT count(*) AS n FROM tasks').get().n, 0)
  db.close()
}))

test('失效重绑只允许 root/lead 调用方', withHome(async home => {
  const root = makeAgent('root-1')
  const sub = makeAgent('sub-1')
  sub.session = { header: { parentSession: 'root-1' } }
  const root2 = makeAgent('root-2')
  const { ctx, registered, live, infos } = fakeCtx({ agents: [root, sub, root2] })
  await apply(ctx, {})
  const byName = Object.fromEntries(registered.map(tool => [tool.name, tool]))
  await byName.task_create.execute({ title: '甲', goal: 'g', acceptance: ['a'] }, { agent: root })
  live.delete('root-1')

  const denied = await byName.task_create.execute({ title: '乙', goal: 'g', acceptance: ['a'] }, { agent: sub })
  assert.match(denied, /只有协调者会话（Team Lead）能重新绑定/)
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(home, 'state', 'orchestrator', 'tasks.sqlite'))
  assert.equal(db.prepare('SELECT value FROM settings WHERE key = ?').get('coordinator_session_id').value, 'root-1')

  const rebound = await byName.task_create.execute({ title: '丙', goal: 'g', acceptance: ['a'] }, { agent: root2 })
  assert.match(rebound, /已派发/)
  assert.match(rebound, /协调者会话已变更：root-1 → root-2/)
  assert.equal(db.prepare('SELECT value FROM settings WHERE key = ?').get('coordinator_session_id').value, 'root-2')
  db.close()
  assert.ok(infos.some(message => /协调者会话已变更/.test(message)))
}))

test('绑定后 agent/created 给恢复的协调者补装白名单', withHome(async () => {
  const root = makeAgent('root-1')
  const { ctx, registered, listeners } = fakeCtx({ agents: [root] })
  await apply(ctx, {})
  const byName = Object.fromEntries(registered.map(tool => [tool.name, tool]))
  await byName.task_create.execute({ title: '甲', goal: 'g', acceptance: ['a'] }, { agent: root })
  const resumed = makeAgent('root-1')
  listeners.get('agent/created')({ agent: resumed })
  assert.equal(resumed.restrictions.length, 1)
}))

test('只读工具不触发绑定', withHome(async home => {
  const s1 = makeAgent('s-1')
  const { ctx, registered } = fakeCtx({ agents: [s1] })
  await apply(ctx, {})
  const byName = Object.fromEntries(registered.map(tool => [tool.name, tool]))
  await byName.task_list.execute({}, { agent: s1 })
  await byName.task_status.execute({ task_id: 't-nope' }, { agent: s1 })
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(home, 'state', 'orchestrator', 'tasks.sqlite'))
  assert.equal(db.prepare('SELECT count(*) AS n FROM settings').get().n, 0)
  db.close()
}))

test('配置覆盖优先、不写台账、白名单只装配置的会话', withHome(async home => {
  const s1 = makeAgent('s-1')
  const s2 = makeAgent('s-2')
  const { ctx, registered } = fakeCtx({ agents: [s1, s2] })
  await apply(ctx, { coordinatorSession: 's-1' })
  const byName = Object.fromEntries(registered.map(tool => [tool.name, tool]))
  await byName.task_create.execute({ title: '甲', goal: 'g', acceptance: ['a'] }, { agent: s2 })
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(home, 'state', 'orchestrator', 'tasks.sqlite'))
  assert.equal(db.prepare('SELECT count(*) AS n FROM settings').get().n, 0)
  assert.equal(db.prepare('SELECT coordinator_session FROM tasks').get().coordinator_session, 's-1')
  db.close()
  assert.equal(s1.restrictions.length, 1)
  assert.equal(s2.restrictions.length, 0)
}))

test('协调者失效：通知记 skipped 并在结果里提示', withHome(async home => {
  const s1 = makeAgent('s-1')
  const { ctx, registered, live } = fakeCtx({ agents: [s1] })
  await apply(ctx, { mergeWindowMs: 5 })
  const byName = Object.fromEntries(registered.map(tool => [tool.name, tool]))
  await byName.task_create.execute({ title: '甲', goal: 'g', acceptance: ['a'] }, { agent: s1 })
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(home, 'state', 'orchestrator', 'tasks.sqlite'))
  const taskId = db.prepare('SELECT id FROM tasks').get().id
  db.close()
  live.delete('s-1')
  const reported = await byName.task_report.execute({ task_id: taskId, status: 'done', summary: '完成' }, { agent: { id: 'm-1' } })
  assert.match(reported, /协调者会话已失效/)
  await wait(30)
  const check = new DatabaseSync(join(home, 'state', 'orchestrator', 'tasks.sqlite'))
  const row = check.prepare('SELECT status, delivered_at, reason FROM notifications').get()
  assert.equal(row.status, 'skipped')
  assert.equal(row.delivered_at, null)
  assert.match(row.reason, /协调者会话已失效/)
  check.close()
}))

test('配置的协调者失效：task_create 结果带失效提示', withHome(async home => {
  const s2 = makeAgent('s-2')
  const { ctx, registered } = fakeCtx({ agents: [s2] })
  await apply(ctx, { coordinatorSession: 's-1' })
  const byName = Object.fromEntries(registered.map(tool => [tool.name, tool]))
  const result = await byName.task_create.execute({ title: '甲', goal: 'g', acceptance: ['a'] }, { agent: s2 })
  assert.match(result, /任务协调失败/)
  assert.match(result, /协调者会话已失效/)
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(home, 'state', 'orchestrator', 'tasks.sqlite'))
  assert.equal(db.prepare('SELECT count(*) AS n FROM settings').get().n, 0)
  const task = db.prepare('SELECT status, error FROM tasks').get()
  assert.equal(task.status, 'pending')
  assert.match(task.error, /协调者会话已失效/)
  db.close()
}))

test('重启后从 settings 恢复绑定并补装白名单', withHome(async () => {
  const s1 = makeAgent('s-1')
  const first = fakeCtx({ agents: [s1] })
  await apply(first.ctx, {})
  const firstTools = Object.fromEntries(first.registered.map(tool => [tool.name, tool]))
  await firstTools.task_create.execute({ title: '甲', goal: 'g', acceptance: ['a'] }, { agent: s1 })
  await first.disposers[0]()

  const s1b = makeAgent('s-1')
  const second = fakeCtx({ agents: [s1b] })
  await apply(second.ctx, {})
  assert.equal(s1b.restrictions.length, 1)
  await second.disposers[0]()
}))

test('已绑定的协调者失效后，新会话 task_create 可重绑', withHome(async home => {
  const s1 = makeAgent('s-1')
  const s2 = makeAgent('s-2')
  const { ctx, registered, live } = fakeCtx({ agents: [s1, s2] })
  await apply(ctx, {})
  const byName = Object.fromEntries(registered.map(tool => [tool.name, tool]))
  await byName.task_create.execute({ title: '甲', goal: 'g', acceptance: ['a'] }, { agent: s1 })
  live.delete('s-1')
  await byName.task_create.execute({ title: '乙', goal: 'g', acceptance: ['a'] }, { agent: s2 })
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(home, 'state', 'orchestrator', 'tasks.sqlite'))
  assert.equal(db.prepare('SELECT value FROM settings WHERE key = ?').get('coordinator_session_id').value, 's-2')
  db.close()
  assert.equal(s2.restrictions.length, 1)
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

test('系统提示只渲染给已绑定协调者，绑定后下一步生效', withHome(async () => {
  const s1 = makeAgent('s-1')
  const other = makeAgent('s-2')
  const { ctx, registered, promptContexts } = fakeCtx({ agents: [s1, other] })
  await apply(ctx, {})
  assert.equal(promptContexts.length, 1)
  const entry = promptContexts[0]
  assert.equal(entry.order, 130)
  assert.equal(entry.interpolate, false)
  assert.equal(entry.text({ agent: s1 }), '')
  const byName = Object.fromEntries(registered.map(tool => [tool.name, tool]))
  await byName.task_create.execute({ title: '甲', goal: 'g', acceptance: ['a'] }, { agent: s1 })
  assert.match(entry.text({ agent: s1 }), /禁止使用 wait_agent/)
  assert.match(entry.text({ agent: s1 }), /task_list \/ task_status/)
  assert.match(entry.text({ agent: s1 }), /优先于平台默认的 Team Lead 等待要求/)
  assert.match(entry.text({ agent: s1 }), /The Lead must wait for required teammates/)
  assert.equal(entry.text({ agent: other }), '')
}))

test('guard 拒绝协调者的 wait_agent，子任务不受影响', withHome(async () => {
  const s1 = makeAgent('s-1')
  const other = makeAgent('s-2')
  const { ctx, registered, guards } = fakeCtx({ agents: [s1, other] })
  await apply(ctx, {})
  const byName = Object.fromEntries(registered.map(tool => [tool.name, tool]))
  await byName.task_create.execute({ title: '甲', goal: 'g', acceptance: ['a'] }, { agent: s1 })
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
  const created = await create.execute({ title: '甲', goal: 'g', acceptance: ['a'] })
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

test('cordis.patch.yml 指向 dsh-orchestrator', () => {
  const yaml = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(yaml, /insert:/)
  assert.match(yaml, /id: orchestrator/)
  assert.match(yaml, /name: dsh-orchestrator/)
})
