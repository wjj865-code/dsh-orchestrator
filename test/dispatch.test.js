import test from 'node:test'
import assert from 'node:assert/strict'
import { createDispatcher, createSubagentDispatcher, createTeamDispatcher } from '../src/dispatch.js'

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
const tick = () => new Promise(resolve => setImmediate(resolve))

// rc.3 可写根：agents.get(childId).session 返回的对象必须和传给 registerWritableRoot 的是同一引用。
function grantEnv() {
  const registrations = []
  const releases = []
  const sessionsById = new Map()
  const calls = []
  const subagents = {
    async startActivation(spec) {
      calls.push(['start', spec])
      const session = { id: spec.childId, header: { cwd: 'C:\\work' } }
      sessionsById.set(spec.childId, session)
      return {
        childId: spec.childId,
        messageId: 'm1',
        result: Promise.resolve({ stopReason: 'completed' }),
        dispose: async () => { calls.push(['dispose', spec.childId]) },
      }
    },
    async sendMessage() { return 'msg' },
    async interruptByParent() {},
    async listChildren() { return [] },
  }
  const agentsService = { get: id => sessionsById.has(id) ? { id, session: sessionsById.get(id) } : undefined }
  const sandboxPolicy = {
    registerWritableRoot(session, dir) {
      registrations.push([session, dir])
      return () => releases.push([session, dir])
    },
  }
  return {
    registrations,
    releases,
    sessionsById,
    calls,
    subagents,
    services: {
      agents: () => agentsService,
      sessions: () => ({ get: id => sessionsById.get(id) }),
      sandboxPolicy: () => sandboxPolicy,
    },
  }
}

test('rc.3 可写根：注册传 agent.session 同一对象，settle 后不释放', async () => {
  const env = grantEnv()
  const events = []
  const dispatcher = createSubagentDispatcher({
    subagents: env.subagents,
    agent,
    ...env.services,
    onEvent: (event, fields) => events.push([event, fields]),
    sessionWaitMs: 0,
  })
  const member = await dispatcher.spawn({ prompt: 'p', cwd: 'C:/target' })
  await tick()
  assert.equal(env.registrations.length, 1)
  const [session, dir] = env.registrations[0]
  assert.strictEqual(session, env.sessionsById.get(member.id))
  assert.equal(dir, 'C:/target')
  // 审计事件带 sessionId + directory，便于和投递时间对齐。
  const grantEvent = events.find(([event]) => event === 'subagent.writable-root')
  assert.equal(grantEvent[1].sessionId, member.id)
  assert.equal(grantEvent[1].detail.directory, 'C:/target')
  // settle 只是这一轮结束（continuable 会话会续派），不能释放。
  await tick()
  assert.deepEqual(env.releases, [])
})

test('rc.3 可写根：同 session+目录重复投递只注册一次', async () => {
  const env = grantEnv()
  const dispatcher = createSubagentDispatcher({ subagents: env.subagents, agent, ...env.services, sessionWaitMs: 0 })
  const member = await dispatcher.spawn({ prompt: 'p', cwd: 'C:/target' })
  await tick()
  await dispatcher.send(member.id, '继续', undefined, 'C:/target')
  await dispatcher.sendReliable(member.id, '再继续', undefined, 'C:/target')
  assert.equal(env.registrations.length, 1)
})

test('rc.3 可写根：resume 后 session 对象换了，续派前按新对象重新注册', async () => {
  const env = grantEnv()
  const dispatcher = createSubagentDispatcher({ subagents: env.subagents, agent, ...env.services, sessionWaitMs: 0 })
  const member = await dispatcher.spawn({ prompt: 'p', cwd: 'C:/target' })
  await tick()
  const resumed = { id: member.id, header: { cwd: 'C:\\work' } }
  env.sessionsById.set(member.id, resumed)
  await dispatcher.send(member.id, '续派', undefined, 'C:/target')
  assert.equal(env.registrations.length, 2)
  assert.strictEqual(env.registrations[1][0], resumed)
})

test('rc.3 可写根：stop 与终态清理释放同一会话的全部授权', async () => {
  const env = grantEnv()
  const dispatcher = createSubagentDispatcher({ subagents: env.subagents, agent, ...env.services, sessionWaitMs: 0 })
  const member = await dispatcher.spawn({ prompt: 'p', cwd: 'C:/target' })
  await tick()
  await dispatcher.stop(member.id)
  assert.equal(env.releases.length, 1)
  // 终态清理可以重复调用，不炸也不重复释放。
  dispatcher.releaseWritableRoots(member.id)
  assert.equal(env.releases.length, 1)
})

test('rc.3 可写根：续派的 Session 在 sendMessage 之后才恢复，也要按新对象注册', async () => {
  // 真机形态：send 前 agents.get/sessions.get 都取不到子会话（settle/冷恢复），
  // sendMessage 才把会话 resume 成新的 Session 对象；只靠发送前注册会漏，第二轮 write 被拒。
  const order = []
  const registrations = []
  const events = []
  const sessionsById = new Map()
  const warnings = []
  let resumed
  let childId
  const subagents = {
    async startActivation(spec) {
      childId = spec.childId
      return {
        childId: spec.childId,
        messageId: 'm1',
        result: Promise.resolve({ stopReason: 'completed' }),
        dispose: async () => {},
      }
    },
    async sendMessage() {
      order.push('send')
      if (resumed !== undefined) sessionsById.set(childId, resumed)
      return 'msg'
    },
    async interruptByParent() {},
    async listChildren() { return [] },
  }
  const sandboxPolicy = {
    registerWritableRoot(session, dir) {
      order.push('register')
      registrations.push([session, dir])
      return () => {}
    },
  }
  const dispatcher = createSubagentDispatcher({
    subagents,
    agent,
    agents: () => ({ get: id => sessionsById.has(id) ? { id, session: sessionsById.get(id) } : undefined }),
    sandboxPolicy: () => sandboxPolicy,
    onWarn: message => warnings.push(message),
    onEvent: (event, fields) => events.push([event, fields]),
    sessionWaitMs: 0,
  })
  const member = await dispatcher.spawn({ prompt: 'p', cwd: 'C:/target' })
  await tick()
  assert.equal(registrations.length, 0)
  // 派发阶段子会话没进表会 warn 属正常；续派前的 Expected miss 不告警。
  warnings.length = 0
  resumed = { id: member.id, header: { cwd: 'C:\\work' } }
  await dispatcher.send(member.id, '续派', undefined, 'C:/target', 't-1')
  assert.deepEqual(warnings, [])
  assert.deepEqual(order, ['send', 'register'])
  assert.equal(registrations.length, 1)
  assert.strictEqual(registrations[0][0], resumed)
  assert.equal(registrations[0][1], 'C:/target')
  // 审计事件：投递成功先记 task.message.sent，再记 writable-root，时间序可自证「注册在投递之后」。
  const sentEvent = events.find(([event]) => event === 'task.message.sent')
  assert.equal(sentEvent[1].taskId, 't-1')
  assert.equal(sentEvent[1].sessionId, member.id)
  assert.equal(sentEvent[1].detail.targetDir, 'C:/target')
  assert.deepEqual(
    events.map(([event]) => event).filter(event => event === 'task.message.sent' || event === 'subagent.writable-root'),
    ['task.message.sent', 'subagent.writable-root'],
  )
  // 第二次投递（sendReliable 路径同样走发送后补注册）：同一对象+目录不重复注册。
  await dispatcher.sendReliable(member.id, '再一次', undefined, 'C:/target', 't-1')
  assert.deepEqual(order, ['send', 'register', 'send'])
  assert.equal(registrations.length, 1)
})

test('rc.3 可写根：投递失败不补注册（不给没收到消息的会话留授权）', async () => {
  const registrations = []
  const sessionsById = new Map()
  let childId
  const subagents = {
    async startActivation(spec) {
      childId = spec.childId
      return { childId: spec.childId, result: Promise.resolve({}), dispose: async () => {} }
    },
    async sendMessage() { throw new Error('投递超时') },
    async interruptByParent() {},
    async listChildren() { return [] },
  }
  const sandboxPolicy = { registerWritableRoot: (session, dir) => { registrations.push([session, dir]); return () => {} } }
  const dispatcher = createSubagentDispatcher({
    subagents,
    agent,
    agents: () => ({ get: id => sessionsById.has(id) ? { id, session: sessionsById.get(id) } : undefined }),
    sandboxPolicy: () => sandboxPolicy,
    onWarn: () => {},
    retryDelaysMs: [0],
  })
  const member = await dispatcher.spawn({ prompt: 'p', cwd: 'C:/target' })
  await tick()
  assert.equal(registrations.length, 0)
  sessionsById.set(childId, { id: member.id, header: { cwd: 'C:\\work' } })
  await assert.rejects(() => dispatcher.sendReliable(member.id, 'x', undefined, 'C:/target'), /投递超时/)
  assert.equal(registrations.length, 0)
})

test('rc.3 可写根：终态释放新旧两个 Session 对象的 disposer', async () => {
  const env = grantEnv()
  const dispatcher = createSubagentDispatcher({ subagents: env.subagents, agent, ...env.services, sessionWaitMs: 0 })
  const member = await dispatcher.spawn({ prompt: 'p', cwd: 'C:/target' })
  await tick()
  assert.equal(env.registrations.length, 1)
  // resume 出新对象 → 续派后按新对象再注册一份（只追加，不替换旧条目）。
  const resumed = { id: member.id, header: { cwd: 'C:\\work' } }
  env.sessionsById.set(member.id, resumed)
  await dispatcher.send(member.id, '续派', undefined, 'C:/target')
  assert.equal(env.registrations.length, 2)
  assert.strictEqual(env.registrations[1][0], resumed)
  // 终态按 targetId 全量释放：新旧两个 disposer 都要调掉。
  dispatcher.releaseWritableRoots(member.id)
  assert.equal(env.releases.length, 2)
  assert.strictEqual(env.releases[0][0], env.registrations[0][0])
  assert.strictEqual(env.releases[1][0], resumed)
})

test('rc.3 可写根：服务缺失 / 没给 target 都只跳过，不影响派发与投递', async () => {
  const env = grantEnv()
  const bare = createSubagentDispatcher({ subagents: env.subagents, agent, sessionWaitMs: 0 })
  const member = await bare.spawn({ prompt: 'p', cwd: 'C:/target' })
  await tick()
  await bare.send(member.id, 'x', undefined, 'C:/target')
  assert.deepEqual(env.registrations, [])
  // 没有 cwd（沿用父会话目录）时一次都不注册。
  const env2 = grantEnv()
  const dispatcher = createSubagentDispatcher({ subagents: env2.subagents, agent, ...env2.services, sessionWaitMs: 0 })
  await dispatcher.spawn({ prompt: 'p' })
  await tick()
  assert.deepEqual(env2.registrations, [])
})

test('rc.3 可写根：服务缺失/register 不存在也不报错', async () => {
  const env = grantEnv()
  const dispatcher = createSubagentDispatcher({
    subagents: env.subagents,
    agent,
    agents: () => ({ get: () => undefined }),
    sessions: () => ({ get: () => undefined }),
    sandboxPolicy: () => ({}),
    sessionWaitMs: 0,
  })
  await assert.doesNotReject(() => dispatcher.spawn({ prompt: 'p', cwd: 'C:/target' }))
})

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
  assert.equal(spec.parent, agent)
  assert.equal(spec.cwd, 'C:\\work')
  assert.deepEqual(spec.prompt, [{ type: 'text', text: '【任务】x' }])
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

test('team：rc.3 缺成员 API 时构造即抛可读错误，文案不含 is not a function', () => {
  // rc.3 的 agentTeams 只剩 state/transact 与团队任务板，成员 API 整体移除。
  const rc3Teams = { state() {}, transact() {} }
  let message = ''
  try {
    createTeamDispatcher({ agentTeams: rc3Teams, agent })
  } catch (error) {
    message = error.message
  }
  assert.match(message, /backend 改回 subagent/)
  assert.match(message, /agentTeams\.spawnTeammate/)
  assert.doesNotMatch(message, /is not a function/)
})

test('team：backend:team 且平台缺能力时插件不炸，派发返回同一条可读错误', async () => {
  const warnings = []
  const dispatcher = createDispatcher({
    backend: 'team',
    agentTeams: { state() {}, transact() {} },
    agent,
    onWarn: message => warnings.push(message),
  })
  await assert.rejects(() => dispatcher.spawn({ prompt: 'p' }), /backend 改回 subagent/)
  await assert.rejects(() => dispatcher.send('m1', 'x'), /backend 改回 subagent/)
  // members 没人用，降级为空即可；catalog 必须抛错，否则对账会把 running 全误标 orphaned。
  assert.deepEqual(await dispatcher.members(), [])
  await assert.rejects(() => dispatcher.catalog(), /backend 改回 subagent/)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /backend 改回 subagent/)
})

test('team：agentTeams 整个缺失时也是可读错误（不是读 property 崩）', async () => {
  const dispatcher = createDispatcher({ backend: 'team', agentTeams: undefined, agent })
  await assert.rejects(() => dispatcher.spawn({ prompt: 'p' }), /agentTeams\.spawnTeammate/)
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

test('spawn 透传 cwd；默认用父会话 cwd；显式带 worker preset', async () => {
  const calls = []
  const subagents = {
    startActivation: spec => {
      calls.push(spec)
      return Promise.resolve({ childId: spec.childId, result: Promise.resolve({}), dispose: async () => {} })
    },
    sendMessage: async () => {},
    interruptByParent: async () => {},
    listChildren: async () => [],
  }
  const parent = { id: 's-1', session: { header: { cwd: 'C:/parent' } } }
  const dispatcher = createSubagentDispatcher({ subagents, agent: parent, workerPreset: 'dsh-orchestrator-worker' })
  await dispatcher.spawn({ prompt: 'hi', cwd: 'C:/target' })
  assert.equal(calls[0].cwd, 'C:/target')
  assert.equal(calls[0].agentPreset, 'dsh-orchestrator-worker')
  await dispatcher.spawn({ prompt: 'hi' })
  assert.equal(calls[1].cwd, 'C:/parent')
  assert.equal(calls[1].agentPreset, 'dsh-orchestrator-worker')
})

test('未传 workerPreset 时默认仍用 dsh-orchestrator-worker', async () => {
  const service = fakeSubagents()
  const dispatcher = createSubagentDispatcher({ subagents: service, agent })
  await dispatcher.spawn({ prompt: 'p' })
  assert.equal(service.calls[0][1].agentPreset, 'dsh-orchestrator-worker')
})

test('fork provider 不注入 agentPreset（平台不支持，避免 UNSUPPORTED_CAPABILITY）', async () => {
  const service = fakeSubagents()
  const dispatcher = createSubagentDispatcher({ subagents: service, agent, provider: 'fork' })
  await dispatcher.spawn({ prompt: 'p' })
  const request = service.calls[0][1]
  assert.equal('agentPreset' in request, false)
  assert.equal(service.calls[0][1].provider, 'fork')
})


test('协调者 agent.session 尚未就绪：spawn 给可读错误（可重试）', async () => {
  const dispatcher = createSubagentDispatcher({ subagents: { async startActivation() { throw new Error('不该走到这里') } }, agent: { id: 's-1' } })
  await assert.rejects(() => dispatcher.spawn({ prompt: 'hi' }), /尚未就绪/)
})

test('协调者 agent 缺 id：spawn 给可读错误', async () => {
  const dispatcher = createSubagentDispatcher({ subagents: { async startActivation() { throw new Error('不该走到这里') } }, agent: { session: { id: 's-1' } } })
  await assert.rejects(() => dispatcher.spawn({ prompt: 'hi' }), /缺少 id/)
})


test('rc.3 扁平 spec：spawn 提供 spec.parent/prompt/agentPreset，同时保留 rc.1 request 包装', async () => {
  const calls = []
  const subagents = {
    startActivation: spec => {
      calls.push(spec)
      return Promise.resolve({ childId: spec.childId, result: Promise.resolve({}), dispose: async () => {} })
    },
    sendMessage: async () => {},
    interruptByParent: async () => {},
    listChildren: async () => [],
  }
  const agent = { id: 's-1', session: { id: 's-1', header: { cwd: 'C:/parent' } } }
  const dispatcher = createSubagentDispatcher({ subagents, agent })
  await dispatcher.spawn({ prompt: 'hi', cwd: 'C:/target' })
  const spec = calls[0]
  // 当前桌面（rc.3）读扁平字段
  assert.equal(spec.parent, agent)
  assert.deepEqual(spec.prompt, [{ type: 'text', text: 'hi' }])
  assert.equal(spec.agentPreset, 'dsh-orchestrator-worker')
  assert.equal(spec.cwd, 'C:/target')
  // rc.3 只发扁平形状；旧包装只在形状错误时回退。
  assert.equal('request' in spec, false)
})

test('rc.3 扁平 spec 下 fork provider 不出现 agentPreset', async () => {
  const service = fakeSubagents()
  const dispatcher = createSubagentDispatcher({ subagents: service, agent, provider: 'fork' })
  await dispatcher.spawn({ prompt: 'p' })
  const spec = service.calls[0][1]
  assert.equal('agentPreset' in spec, false)
  assert.equal('request' in spec, false)
})

test('rc.1 旧形状：扁平调用形状错误时回退 request 包装', async () => {
  const calls = []
  const subagents = {
    async startActivation(spec) {
      calls.push(spec)
      if (spec.request === undefined) throw new TypeError("Cannot read properties of undefined (reading 'parent')")
      return { childId: spec.childId, result: Promise.resolve({}), dispose: async () => {} }
    },
    async sendMessage() {},
    async interruptByParent() {},
    async listChildren() { return [] },
  }
  const dispatcher = createSubagentDispatcher({ subagents, agent })
  await dispatcher.spawn({ prompt: 'hi', cwd: 'C:/target' })
  assert.equal(calls.length, 2)
  assert.equal('request' in calls[0], false)
  assert.equal(calls[1].request.parent, agent)
  assert.equal(calls[1].request.cwd, 'C:/target')
  assert.equal(calls[1].request.agentPreset, 'dsh-orchestrator-worker')
})

test('非形状错误不回退：只调用一次并原样抛出', async () => {
  const calls = []
  const subagents = {
    async startActivation(spec) { calls.push(spec); throw new Error('spawn boom') },
    async sendMessage() {},
    async interruptByParent() {},
    async listChildren() { return [] },
  }
  const dispatcher = createSubagentDispatcher({ subagents, agent })
  await assert.rejects(() => dispatcher.spawn({ prompt: 'hi' }), /spawn boom/)
  assert.equal(calls.length, 1)
})


test('rc.3：stop 无本地 activation 时走 interrupt(target, { kind: "user" })', async () => {
  const calls = []
  const subagents = {
    async startActivation() {},
    async sendMessage() {},
    async interrupt(target, authority) { calls.push([target, authority]) },
    async listDescendants() { return [] },
  }
  const dispatcher = createSubagentDispatcher({ subagents, agent })
  await dispatcher.stop('c-9')
  // 平台只认 { kind: 'ancestor' | 'user' }；task_stop 是用户动作，不传裸 agent。
  assert.deepEqual(calls, [['c-9', { kind: 'user' }]])
  assert.notStrictEqual(calls[0][1], agent)
})

test('rc.3：catalog/members 走 listDescendants 而不是 listChildren', async () => {
  const calls = []
  const subagents = {
    async startActivation() {},
    async sendMessage() {},
    async interrupt() {},
    async listDescendants(parentId) { calls.push(['listDescendants', parentId]); return [{ id: 'c1', mode: 'continuable' }] },
  }
  const dispatcher = createSubagentDispatcher({ subagents, agent })
  assert.deepEqual(await dispatcher.catalog(), [{ id: 'c1', mode: 'continuable' }])
  assert.deepEqual(calls, [['listDescendants', 's1']])
})
