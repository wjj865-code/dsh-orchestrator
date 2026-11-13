import test from 'node:test'
import assert from 'node:assert/strict'
import { createDispatcher } from '../src/dispatch.js'

function fakeTeams({ failTimes = 0 } = {}) {
  const calls = []
  let failures = 0
  return {
    calls,
    async spawnTeammate(agent, input) {
      calls.push(['spawn', input])
      return { member: { id: 'm1', name: input.name } }
    },
    async sendMessage(agent, input) {
      calls.push(['send', input])
      if (failures < failTimes) {
        failures += 1
        throw new Error('网络抖动')
      }
      return { messageId: 'msg-1' }
    },
    async interrupt(agent, target) { calls.push(['interrupt', target]) },
    listMembers(agent) { calls.push(['members', agent]); return [{ id: 'm1', name: 'worker-1', status: 'inactive' }] },
  }
}

function fakeSubagents({ failStart = false, failTimes = 0, deferred = false } = {}) {
  const calls = []
  const events = []
  const resolvers = []
  let failures = 0
  return {
    calls,
    events,
    resolveAll() {
      for (const resolve of resolvers) resolve({ output: [], stopReason: 'completed' })
      resolvers.length = 0
    },
    async startActivation(spec) {
      calls.push(['start', spec])
      if (failStart) throw new Error('spawn 挂了')
      return {
        childId: spec.childId,
        messageId: 'msg-1',
        result: deferred
          ? new Promise(resolve => { resolvers.push(resolve) })
          : Promise.resolve({ output: [], stopReason: 'completed' }),
        dispose: async () => { calls.push(['dispose', spec.childId]) },
      }
    },
    async sendMessage(sender, target, content, options) {
      calls.push(['send', sender, target, content, options])
      if (failures < failTimes) {
        failures += 1
        throw new Error('网络抖动')
      }
      return 'msg-2'
    },
    async interruptByParent(childId, parentId, mode) { calls.push(['interruptByParent', childId, parentId, mode]) },
    async listChildren(parentId, signal) { calls.push(['listChildren', parentId, signal]); return [{ id: 'c1', mode: 'continuable', label: 'x', activity: 'inactive' }] },
  }
}

const agent = { id: 'a1', session: { id: 's1', header: { cwd: 'C:\\work' } } }
const team = options => createDispatcher({ backend: 'team', ...options })
const sub = options => createDispatcher({ backend: 'subagent', ...options })

test('team：spawn 透传合法名字、渲染文本 prompt、fresh provider 与 signal', async () => {
  const teams = fakeTeams()
  const dispatcher = team({ agentTeams: teams, agent })
  const signal = new AbortController().signal
  const member = await dispatcher.spawn({ name: 'worker-1', description: 'd', prompt: '【任务】x', signal })
  assert.equal(member.target, 'worker-1')
  assert.equal(member.sessionId, 'm1')
  const input = teams.calls[0][1]
  assert.deepEqual(input.prompt, [{ type: 'text', text: '【任务】x' }])
  assert.equal(input.description, 'd')
  assert.equal(input.context, 'fresh')
  assert.equal(input.provider, 'spawn')
  assert.equal(input.signal, signal)
})

test('team：spawn 未给名字时生成 kebab 名', async () => {
  const teams = fakeTeams()
  const dispatcher = team({ agentTeams: teams, agent })
  await dispatcher.spawn({ prompt: '【任务】😀' })
  assert.match(teams.calls[0][1].name, /^task-\d+-\d+$/)
})

test('team：显式 provider 覆盖默认 fresh provider', async () => {
  const teams = fakeTeams()
  const dispatcher = team({ agentTeams: teams, agent, provider: 'fork' })
  await dispatcher.spawn({ name: 'w-1', prompt: 'x' })
  assert.equal(teams.calls[0][1].provider, 'fork')
})

test('team：send 透传 target、content 与 signal；stop 走 interrupt', async () => {
  const teams = fakeTeams()
  const dispatcher = team({ agentTeams: teams, agent })
  const signal = new AbortController().signal
  await dispatcher.send('worker-1', '继续', signal)
  await dispatcher.stop('worker-1')
  assert.deepEqual(teams.calls.map(call => call[0]), ['send', 'interrupt'])
  assert.deepEqual(teams.calls[0][1], { target: 'worker-1', content: [{ type: 'text', text: '继续' }], signal })
  assert.equal(teams.calls[1][1], 'worker-1')
})

test('team：members 透传 listMembers', async () => {
  const teams = fakeTeams()
  const dispatcher = team({ agentTeams: teams, agent })
  const members = await dispatcher.members()
  assert.equal(members[0].name, 'worker-1')
  assert.deepEqual(teams.calls[0], ['members', agent])
})

test('slug 化：中文、空格、标点、emoji 只留 kebab；连续调用不重名', () => {
  const dispatcher = team({ agentTeams: fakeTeams(), agent })
  const a = dispatcher.slug('修复 空数据 文案！😀')
  const b = dispatcher.slug('修复 空数据 文案！😀')
  assert.match(a, /^[a-z0-9-]+$/)
  assert.notEqual(a, b)
  const c = dispatcher.slug('Fix the empty data message in report')
  assert.ok(c.length <= 32 + 1 + String(Number.MAX_SAFE_INTEGER).length)
})

test('team：sendReliable 失败重试 3 次后成功', async () => {
  const teams = fakeTeams({ failTimes: 3 })
  const dispatcher = team({ agentTeams: teams, agent, retryDelaysMs: [0, 0, 0] })
  const result = await dispatcher.sendReliable('worker-1', '继续')
  assert.deepEqual(result, { messageId: 'msg-1' })
  assert.equal(teams.calls.length, 4)
})

test('team：sendReliable 四次都失败后抛出可读错误', async () => {
  const teams = fakeTeams({ failTimes: 99 })
  const dispatcher = team({ agentTeams: teams, agent, retryDelaysMs: [0, 0, 0] })
  await assert.rejects(() => dispatcher.sendReliable('worker-1', '继续'), /网络抖动/)
  assert.equal(teams.calls.length, 4)
})

test('team：未配置协调者时派活给出可读错误', async () => {
  const teams = fakeTeams()
  const dispatcher = team({ agentTeams: teams, agent: undefined })
  await assert.rejects(() => dispatcher.spawn({ name: 'w', prompt: 'x' }), /协调者会话/)
  await assert.rejects(() => dispatcher.send('w', 'x'), /协调者会话/)
  assert.equal(teams.calls.length, 0)
})

test('team：协调者会话后加载，getAgent 惰性解析', async () => {
  const teams = fakeTeams()
  let live
  const dispatcher = team({ agentTeams: teams, getAgent: () => live })
  await assert.rejects(() => dispatcher.spawn({ name: 'w', prompt: 'x' }), /协调者会话/)
  live = agent
  const member = await dispatcher.spawn({ name: 'w', prompt: 'x' })
  assert.equal(member.target, 'w')
})

test('subagent：spawn 用自有 childId、caller delivery、cwd，返回 childId 作 target', async () => {
  const service = fakeSubagents()
  const dispatcher = sub({ subagents: service, agent })
  const signal = new AbortController().signal
  const member = await dispatcher.spawn({ name: 'n', label: '任务甲', prompt: '【任务】x', signal, taskId: 't-1' })
  const spec = service.calls[0][1]
  assert.equal(spec.provider, 'spawn')
  assert.equal(spec.delivery, 'caller')
  assert.equal(spec.label, '任务甲')
  assert.equal(spec.signal, signal)
  assert.match(spec.childId, /^[0-9a-f-]{36}$/)
  assert.equal(spec.request.parent, agent)
  assert.equal(spec.request.cwd, 'C:\\work')
  assert.deepEqual(spec.request.prompt, [{ type: 'text', text: '【任务】x' }])
  assert.equal(member.sessionId, member.id)
  assert.equal(member.target, member.id)
})

test('subagent：settle 后发出事件，dispose 走 activation', async () => {
  const service = fakeSubagents({ deferred: true })
  const events = []
  const dispatcher = sub({ subagents: service, agent, onEvent: (event, fields) => events.push([event, fields]) })
  const member = await dispatcher.spawn({ label: 'x', prompt: 'p' })
  assert.equal(dispatcher.has(member.id), true)
  service.resolveAll()
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(dispatcher.has(member.id), false)
  assert.ok(events.some(([event]) => event === 'subagent.settled'))
})

test('subagent：spawn 失败把错误原样抛出并记 requested 事件', async () => {
  const service = fakeSubagents({ failStart: true })
  const events = []
  const dispatcher = sub({ subagents: service, agent, onEvent: (event, fields) => events.push([event, fields]) })
  await assert.rejects(() => dispatcher.spawn({ label: 'x', prompt: 'p' }), /spawn 挂了/)
  assert.ok(events.some(([event]) => event === 'subagent.spawn.requested'))
})

test('subagent：send 走 sendMessage；stop 有 activation 用 dispose，无则 interruptByParent', async () => {
  const service = fakeSubagents({ deferred: true })
  const dispatcher = sub({ subagents: service, agent })
  await dispatcher.send('child-1', '继续')
  const sendCall = service.calls.find(call => call[0] === 'send')
  assert.equal(sendCall[2], 'child-1')
  assert.deepEqual(sendCall[3], [{ type: 'text', text: '继续' }])
  assert.ok(sendCall[4].signal instanceof AbortSignal)

  await dispatcher.stop('child-1')
  const interrupt = service.calls.find(call => call[0] === 'interruptByParent')
  assert.deepEqual(interrupt.slice(1), ['child-1', 's1', 'continuable'])

  const member = await dispatcher.spawn({ label: 'y', prompt: 'p' })
  await dispatcher.stop(member.id)
  assert.ok(service.calls.some(call => call[0] === 'dispose' && call[1] === member.id))
})

test('subagent：sendReliable 重试后成功 / 全失败抛可读错误', async () => {
  const service = fakeSubagents({ failTimes: 3 })
  const dispatcher = sub({ subagents: service, agent, retryDelaysMs: [0, 0, 0] })
  assert.equal(await dispatcher.sendReliable('c', 'x'), 'msg-2')
  assert.equal(service.calls.filter(call => call[0] === 'send').length, 4)

  const never = fakeSubagents({ failTimes: 99 })
  const failing = sub({ subagents: never, agent, retryDelaysMs: [0, 0, 0] })
  await assert.rejects(() => failing.sendReliable('c', 'x'), /网络抖动/)
})

test('subagent：catalog/members 用 listChildren，失败时 members 降级为空', async () => {
  const service = fakeSubagents()
  const dispatcher = sub({ subagents: service, agent })
  const rows = await dispatcher.catalog()
  assert.equal(rows[0].id, 'c1')
  assert.deepEqual(service.calls.find(call => call[0] === 'listChildren').slice(1), ['s1', undefined])

  const broken = sub({ subagents: { ...service, listChildren: async () => { throw new Error('catalog 挂了') } }, agent, onWarn: () => {} })
  assert.deepEqual(await broken.members(), [])
})

test('默认 backend 是 subagent', async () => {
  const service = fakeSubagents()
  const dispatcher = createDispatcher({ subagents: service, agent })
  await dispatcher.spawn({ label: 'x', prompt: 'p' })
  assert.equal(service.calls[0][0], 'start')
})
