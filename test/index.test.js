import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject, name } from '../index.js'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

function makeAgent(id, { knownTools = ['read', 'write', 'bash', 'task_report', 'ask_user', 'show_view'] } = {}) {
  const restrictions = []
  return {
    id,
    restrictions,
    ctx: {
      tools: {
        view: () => ({ knownNames: new Set(knownTools) }),
        restrict(filter) { restrictions.push(filter); return () => {} },
      },
    },
  }
}

function fakeCtx({ agent = makeAgent('s-1'), spawnResult = { member: { id: 'm-1', name: 'w-1' } } } = {}) {
  const registered = []
  const warnings = []
  const listeners = new Map()
  const sent = []
  const disposers = []
  const ctx = {
    logger: { warn(message) { warnings.push(message) } },
    tools: { register(tool) { registered.push(tool); return () => {} } },
    get: () => ({ get: id => (id === agent.id ? agent : undefined) }),
    on(event, handler) { listeners.set(event, handler); return () => {} },
    effect(callback) { disposers.push(callback()); return () => {} },
    agentTeams: {
      async spawnTeammate() { return spawnResult },
      async sendMessage(sender, input) { sent.push([sender, input]) },
      async interrupt() {},
      listMembers() { return [] },
    },
  }
  return { ctx, registered, warnings, listeners, sent, disposers, agent }
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

test('inject 声明包含 tools、agentTeams、agents', () => {
  assert.equal(name, 'dsh-orchestrator')
  assert.deepEqual(new Set(inject), new Set(['tools', 'agentTeams', 'agents']))
})

test('apply 注册 6 个工具，只写 $DSH_HOME/state/orchestrator', withHome(async home => {
  const { ctx, registered } = fakeCtx()
  await apply(ctx, { coordinatorSession: 's-1' })
  assert.deepEqual(registered.map(tool => tool.name).sort(),
    ['task_create', 'task_list', 'task_message', 'task_report', 'task_status', 'task_stop'])
  assert.deepEqual(readdirSync(home), ['state'])
  assert.deepEqual(readdirSync(join(home, 'state', 'orchestrator')).filter(file => !file.startsWith('tasks.sqlite')), [])
}))

test('无 coordinatorSession：warn 但工具注册；派活返回可读错误', withHome(async () => {
  const { ctx, registered, warnings } = fakeCtx()
  await apply(ctx, {})
  assert.equal(registered.length, 6)
  assert.ok(warnings.some(message => /coordinatorSession/.test(message)))
  const create = registered.find(tool => tool.name === 'task_create')
  const text = await create.execute({ title: 't', goal: 'g', acceptance: ['a'] })
  assert.match(text, /任务协调失败：未找到协调者会话/)
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
  await byName.task_report.execute(
    { task_id: created.match(/任务 (t-[0-9a-f]+)/)[1], status: 'done', summary: '完成' },
    { agent: teammate },
  )
  await wait(30)
  assert.equal(sent.length, 1)
  assert.equal(sent[0][0], teammate)
  assert.equal(sent[0][1].target, 'lead')
  assert.match(sent[0][1].content[0].text, /任务「甲」完成/)
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(process.env.DSH_HOME, 'state', 'orchestrator', 'tasks.sqlite'))
  const row = db.prepare('SELECT status, level FROM notifications').get()
  assert.equal(row.status, 'delivered')
  assert.equal(row.level, 'notify')
  db.close()
}))

test('cordis.patch.yml 指向 dsh-orchestrator', () => {
  const yaml = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(yaml, /insert:/)
  assert.match(yaml, /id: orchestrator/)
  assert.match(yaml, /name: dsh-orchestrator/)
})
