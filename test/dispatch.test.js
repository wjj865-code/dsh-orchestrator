import test from 'node:test'
import assert from 'node:assert/strict'
import { createDispatcher, createSubagentDispatcher } from '../src/dispatch.js'

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

// 只读沙箱环境：session.append 记录事件；overrideOf 读已设模式；可选择性在 startActivation 内触发 agent/created。
function readOnlyEnv({ callHookOnStart = false, modeOverride } = {}) {
  const appends = []
  const registrations = []
  const modes = new Map()
  const sessionsById = new Map()
  const hooks = []
  const subagents = {
    async startActivation(spec) {
      const session = {
        id: spec.childId,
        header: { cwd: 'C:\\work' },
        append(event, payload) {
          appends.push([spec.childId, event, payload])
          if (event === 'sandbox/mode') modes.set(spec.childId, payload.mode)
        },
      }
      sessionsById.set(spec.childId, session)
      if (callHookOnStart) {
        await tick()
        for (const hook of hooks) hook({ id: spec.childId, session })
      }
      return { childId: spec.childId, messageId: 'm1', result: Promise.resolve({}), dispose: async () => {} }
    },
    async sendMessage() { return 'msg' },
    async interruptByParent() {},
    async listChildren() { return [] },
  }
  const sandboxPolicy = {
    overrideOf: session => modeOverride !== undefined ? modeOverride : modes.get(session.id),
    registerWritableRoot(session, dir) {
      registrations.push([session, dir])
      return () => {}
    },
  }
  return {
    appends,
    registrations,
    modes,
    sessionsById,
    hooks,
    subagents,
    services: {
      agents: () => ({ get: id => sessionsById.has(id) ? { id, session: sessionsById.get(id) } : undefined }),
      sessions: () => ({ get: id => sessionsById.get(id) }),
      sandboxPolicy: () => sandboxPolicy,
      onAgentCreated: handler => { hooks.push(handler) },
    },
  }
}

test('readOnly：派发时 append sandbox/mode=read-only，且不注册 target 可写根', async () => {
  const env = readOnlyEnv()
  const dispatcher = createSubagentDispatcher({ subagents: env.subagents, agent, ...env.services, sessionWaitMs: 0 })
  const member = await dispatcher.spawn({ prompt: 'p', cwd: 'C:/target', readOnly: true })
  await tick()
  const modeEvents = env.appends.filter(([, event]) => event === 'sandbox/mode')
  assert.equal(modeEvents.length, 1)
  assert.deepEqual(modeEvents[0][2], { mode: 'read-only' })
  assert.equal(modeEvents[0][0], member.id)
  assert.deepEqual(env.registrations, [])
})

test('readOnly：agent/created 先设（首回合窗口），激活后幂等不重复', async () => {
  const env = readOnlyEnv({ callHookOnStart: true })
  const dispatcher = createSubagentDispatcher({ subagents: env.subagents, agent, ...env.services, sessionWaitMs: 0 })
  await dispatcher.spawn({ prompt: 'p', readOnly: true })
  await tick()
  assert.equal(env.appends.filter(([, event]) => event === 'sandbox/mode').length, 1)
})

test('readOnly：投影已是 read-only 时跳过 append；普通任务钉 workspace-write', async () => {
  const env = readOnlyEnv({ modeOverride: 'read-only' })
  const dispatcher = createSubagentDispatcher({ subagents: env.subagents, agent, ...env.services, sessionWaitMs: 0 })
  await dispatcher.spawn({ prompt: 'p', readOnly: true })
  await tick()
  assert.equal(env.appends.length, 0)

  // C：主会话被钉成 read-only 后，宿主会把父会话的 sandbox 覆盖种进子会话；普通任务必须显式写回可写。
  const normal = readOnlyEnv()
  const plain = createSubagentDispatcher({ subagents: normal.subagents, agent, ...normal.services, sessionWaitMs: 0 })
  await plain.spawn({ prompt: 'p', cwd: 'C:/target' })
  await tick()
  const modes = normal.appends.filter(([, event]) => event === 'sandbox/mode')
  assert.equal(modes.length, 1)
  assert.deepEqual(modes[0][2], { mode: 'workspace-write', source: 'delegation' })
  assert.equal(normal.registrations.length, 1, '非只读任务仍注册可写根')
})

test('readOnly：续派仍是只读（新 Session 对象按需补设；非只读不设）', async () => {
  const env = readOnlyEnv()
  const dispatcher = createSubagentDispatcher({ subagents: env.subagents, agent, ...env.services, sessionWaitMs: 0 })
  const member = await dispatcher.spawn({ prompt: 'p', readOnly: true })
  await tick()
  assert.equal(env.appends.filter(([, event]) => event === 'sandbox/mode').length, 1)
  await dispatcher.send(member.id, '继续', undefined, undefined, 't-1', true)
  assert.equal(env.appends.filter(([, event]) => event === 'sandbox/mode').length, 1, '同一会话已有只读不重复')

  // resume：新 Session 对象且投影暂未读回模式（如冷恢复早期）→ 续派时补设。
  env.modes.delete(member.id)
  const resumed = { id: member.id, header: { cwd: 'C:\\work' }, append(event, payload) { env.appends.push([member.id, event, payload]) } }
  env.sessionsById.set(member.id, resumed)
  await dispatcher.send(member.id, '再续', undefined, undefined, 't-1', true)
  assert.equal(env.appends.filter(([, event]) => event === 'sandbox/mode').length, 2)
})

test('readOnly：缺服务/append 失败不炸，不影响派发', async () => {
  const env = readOnlyEnv()
  const bare = createSubagentDispatcher({ subagents: env.subagents, agent, onWarn: () => {} })
  const member = await bare.spawn({ prompt: 'p', cwd: 'C:/target', readOnly: true })
  assert.ok(member.id)
})


test('createDispatcher 接线：onAgentCreated 被转发，只读任务经生产入口也能设沙箱', async () => {
  const env = readOnlyEnv()
  let seen = false
  const dispatcher = createDispatcher({
    subagents: env.subagents,
    agent,
    agents: env.services.agents,
    sessions: env.services.sessions,
    sandboxPolicy: env.services.sandboxPolicy,
    onAgentCreated: handler => { seen = true; env.hooks.push(handler) },
    sessionWaitMs: 0,
  })
  assert.equal(seen, true, 'createDispatcher 必须把 onAgentCreated 传给 subagent 派发器')
  await dispatcher.spawn({ prompt: 'p', readOnly: true })
  await tick()
  const modes = env.appends.filter(([, event]) => event === 'sandbox/mode')
  assert.equal(modes.length, 1)
  assert.deepEqual(modes[0][2], { mode: 'read-only' })
})

// ---- per-task 完整访问（access:'full'） ------------------------------------------
// 与只读同一条注入路径：只 append 目标子会话的 sandbox/mode，payload 里带 source:'delegation'。

test('access:full：派发时 append sandbox/mode=danger-full-access，且照旧注册 target 可写根', async () => {
  const env = readOnlyEnv()
  const dispatcher = createSubagentDispatcher({ subagents: env.subagents, agent, ...env.services, sessionWaitMs: 0 })
  const member = await dispatcher.spawn({ prompt: 'p', cwd: 'C:/target', access: 'full' })
  await tick()
  const modes = env.appends.filter(([, event]) => event === 'sandbox/mode')
  assert.equal(modes.length, 1)
  assert.deepEqual(modes[0][2], { mode: 'danger-full-access', source: 'delegation' })
  assert.equal(modes[0][0], member.id)
  assert.equal(env.registrations.length, 1, '完整访问仍登记 target 可写根：danger-full-access 下用不上，只当注入失败时的兜底')
})

test('access:full：agent/created 先设（压首回合窗口），激活后幂等不重复', async () => {
  const env = readOnlyEnv({ callHookOnStart: true })
  const dispatcher = createSubagentDispatcher({ subagents: env.subagents, agent, ...env.services, sessionWaitMs: 0 })
  await dispatcher.spawn({ prompt: 'p', access: 'full' })
  await tick()
  assert.equal(env.appends.filter(([, event]) => event === 'sandbox/mode').length, 1)
})

test('access:full：投影已是 danger-full-access 时跳过 append；不传 access 一次都不设', async () => {
  const env = readOnlyEnv({ modeOverride: 'danger-full-access' })
  const dispatcher = createSubagentDispatcher({ subagents: env.subagents, agent, ...env.services, sessionWaitMs: 0 })
  await dispatcher.spawn({ prompt: 'p', access: 'full' })
  await tick()
  assert.equal(env.appends.length, 0, '已有同模式不重复 append')

  // 默认子任务钉 workspace-write（C：父会话 read-only 覆盖会被宿主种进子会话）。
  for (const access of [undefined, 'readOnly', 'true', true]) {
    const plain = readOnlyEnv()
    const normal = createSubagentDispatcher({ subagents: plain.subagents, agent, ...plain.services, sessionWaitMs: 0 })
    await normal.spawn({ prompt: 'p', cwd: 'C:/target', ...(access === undefined ? {} : { access }) })
    await tick()
    const modes = plain.appends.filter(([, event]) => event === 'sandbox/mode')
    assert.equal(modes.length, 1, `access=${String(access)} 应只钉一次 workspace-write`)
    assert.deepEqual(modes[0][2], { mode: 'workspace-write', source: 'delegation' })
    assert.equal(plain.registrations.length, 1)
  }
})

test('access:full：只写自己的会话，同批次其他任务不受污染', async () => {
  const env = readOnlyEnv()
  const dispatcher = createSubagentDispatcher({ subagents: env.subagents, agent, ...env.services, sessionWaitMs: 0 })
  const full = await dispatcher.spawn({ prompt: 'p', cwd: 'C:/target', access: 'full' })
  const normal = await dispatcher.spawn({ prompt: 'p', cwd: 'C:/target' })
  await tick()
  const modes = env.appends.filter(([, event]) => event === 'sandbox/mode')
  assert.deepEqual(modes.map(([childId, , payload]) => [childId, payload.mode]), [
    [full.id, 'danger-full-access'],
    [normal.id, 'workspace-write'],
  ])
  assert.notEqual(full.id, normal.id)
  assert.equal(env.registrations.length, 2, '两个任务各自登记自己的可写根')
})

test('access:full：续派仍是完整访问（resume 出的新 Session 对象按需补设；非 full 不设）', async () => {
  const env = readOnlyEnv()
  const dispatcher = createSubagentDispatcher({ subagents: env.subagents, agent, ...env.services, sessionWaitMs: 0 })
  const member = await dispatcher.spawn({ prompt: 'p', access: 'full' })
  await tick()
  assert.equal(env.appends.filter(([, event]) => event === 'sandbox/mode').length, 1)
  // 同一会话投影已读回模式：续派幂等跳过。
  await dispatcher.send(member.id, '继续', undefined, undefined, 't-1', false, undefined, 'full')
  assert.equal(env.appends.filter(([, event]) => event === 'sandbox/mode').length, 1, '同一会话已有完整访问不重复')

  // 冷恢复：新 Session 对象且投影暂未读回模式 → 续派时补设。
  env.modes.delete(member.id)
  const resumed = { id: member.id, header: { cwd: 'C:\\work' }, append(event, payload) { env.appends.push([member.id, event, payload]) } }
  env.sessionsById.set(member.id, resumed)
  await dispatcher.send(member.id, '再续', undefined, undefined, 't-1', false, undefined, 'full')
  const modes = env.appends.filter(([, event]) => event === 'sandbox/mode')
  assert.equal(modes.length, 2)
  assert.deepEqual(modes[1][2], { mode: 'danger-full-access', source: 'delegation' })

  // 普通续派恢复 workspace-write（done 请求会临时冻结为只读）。
  await dispatcher.send(member.id, '再再续', undefined, undefined, 't-1', false)
  assert.equal(env.appends.filter(([, event]) => event === 'sandbox/mode').length, 3)
})

test('access:full：缺 sandboxPolicy 服务也不炸，不影响派发', async () => {
  const env = readOnlyEnv()
  const bare = createSubagentDispatcher({ subagents: env.subagents, agent, onWarn: () => {} })
  const member = await bare.spawn({ prompt: 'p', cwd: 'C:/target', access: 'full' })
  assert.ok(member.id)
})

const sub = options => createDispatcher({ ...options })
const agent = { id: 'a1', session: { id: 's1', header: { cwd: 'C:\\work' } } }
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

test('slug 化：中文、空格、标点、emoji 只留 kebab；连续调用不重名', () => {
  const dispatcher = createSubagentDispatcher({ subagents: fakeSubagents(), agent })
  const a = dispatcher.slug('修复 空数据 文案！😀')
  const b = dispatcher.slug('修复 空数据 文案！😀')
  assert.match(a, /^[a-z0-9-]+$/)
  assert.notEqual(a, b)
  const c = dispatcher.slug('Fix the empty data message in report')
  assert.ok(c.length <= 32 + 1 + String(Number.MAX_SAFE_INTEGER).length)
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
  const member = await dispatcher.spawn({ label: 'x', prompt: 'p', taskId: 't-9' })
  assert.equal(dispatcher.has(member.id), true)
  service.resolveAll()
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(dispatcher.has(member.id), false)
  const settled = events.find(([event]) => event === 'subagent.settled')
  assert.ok(settled !== undefined)
  // 结算事件要带 taskId + stopReason + 可读输出摘要：台账据此自动落终态、记死因。
  assert.equal(settled[1].taskId, 't-9')
  assert.equal(settled[1].sessionId, member.id)
  assert.equal(settled[1].detail.stopReason, 'completed')
  assert.equal(settled[1].detail.output, '')
})

test('subagent：结算事件带完整 lastMessage（detail.output 仍是 240 字摘要）', async () => {
  const full = `开头一行\n${'细'.repeat(400)}`
  const service = {
    async startActivation(spec) {
      return {
        childId: spec.childId,
        messageId: 'msg-1',
        result: Promise.resolve({ output: [{ type: 'text', text: full }], stopReason: 'completed' }),
        dispose: async () => {},
      }
    },
    async sendMessage() {},
    async interruptByParent() {},
    async listChildren() { return [] },
  }
  const events = []
  const dispatcher = sub({ subagents: service, agent, onEvent: (event, fields) => events.push([event, fields]) })
  await dispatcher.spawn({ label: 'x', prompt: 'p', taskId: 't-11' })
  await new Promise(resolve => setTimeout(resolve, 5))
  const settled = events.find(([event]) => event === 'subagent.settled')
  assert.ok(settled !== undefined)
  // 日志字段保持摘要（不把 64KB 正文写进 jsonl），完整正文走非日志字段给结算落库。
  assert.equal(settled[1].detail.output.length, 241)
  assert.ok(settled[1].detail.output.endsWith('…'))
  assert.equal(settled[1].lastMessage, full)
})

test('subagent：activation.result 被拒时发 subagent.failed（带 taskId 与错误）', async () => {
  const events = []
  const service = fakeSubagents()
  const original = service.startActivation
  service.startActivation = async spec => ({
    childId: spec.childId,
    messageId: 'msg-1',
    result: Promise.reject(new Error('teardown 炸了')),
    dispose: async () => {},
  })
  const dispatcher = sub({ subagents: service, agent, onEvent: (event, fields) => events.push([event, fields]) })
  await dispatcher.spawn({ label: 'x', prompt: 'p', taskId: 't-10' })
  await new Promise(resolve => setTimeout(resolve, 5))
  const failed = events.find(([event]) => event === 'subagent.failed')
  assert.ok(failed !== undefined)
  assert.equal(failed[1].taskId, 't-10')
  assert.match(failed[1].detail.error, /teardown 炸了/)
  assert.equal(typeof original, 'function')
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

test('createDispatcher 只剩 subagent 一条路：不传 backend 也能直接派发', async () => {
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

// G1：goal 桥的派发/续派/停止挂钩点。桥自身行为在 goal.test.js 单测，这里只验证 dispatch 的调用契约。
function goalSpy() {
  const calls = []
  return {
    calls,
    async attach(taskId, sessionId, objective) { calls.push(['attach', taskId, sessionId, objective]) },
    async update(taskId, sessionId, objective) { calls.push(['update', taskId, sessionId, objective]) },
    async clear(taskId, sessionId) { calls.push(['clear', taskId, sessionId]) },
    async complete(taskId, sessionId) { calls.push(['complete', taskId, sessionId]) },
  }
}

test('G1：spawn 后按 taskId + 子会话 + 任务目标 attach（不 await、不阻塞派发）', async () => {
  const env = grantEnv()
  const bridge = goalSpy()
  const dispatcher = createSubagentDispatcher({ subagents: env.subagents, agent, ...env.services, sessionWaitMs: 0, goalBridge: bridge })
  const member = await dispatcher.spawn({ prompt: 'p', taskId: 't-1', goal: '把登录修好' })
  await tick()
  assert.deepEqual(bridge.calls, [['attach', 't-1', member.id, '把登录修好']])
})

test('G1：spawn 没给 goal 时不创建目标（等待依赖/异常任务不产生空 goal）', async () => {
  const env = grantEnv()
  const bridge = goalSpy()
  const dispatcher = createSubagentDispatcher({ subagents: env.subagents, agent, ...env.services, sessionWaitMs: 0, goalBridge: bridge })
  await dispatcher.spawn({ prompt: 'p', taskId: 't-1', goal: '  ' })
  await tick()
  assert.deepEqual(bridge.calls, [])
})

test('G1：续派投递成功后用「原目标 + 最新指示」update，失败路径不 update', async () => {
  const env = grantEnv()
  const bridge = goalSpy()
  const dispatcher = createSubagentDispatcher({ subagents: env.subagents, agent, ...env.services, sessionWaitMs: 0, goalBridge: bridge })
  const member = await dispatcher.spawn({ prompt: 'p', taskId: 't-1' })
  await tick()
  await dispatcher.send(member.id, '换方向', undefined, 'C:/target', 't-1', false, '原目标\n\n最新指示：换方向')
  await tick()
  assert.deepEqual(bridge.calls, [['update', 't-1', member.id, '原目标\n\n最新指示：换方向']])
  const failing = createSubagentDispatcher({
    subagents: { ...env.subagents, async sendMessage() { throw new Error('投递失败') } },
    agent,
    ...env.services,
    retryDelaysMs: [],
    sessionWaitMs: 0,
    goalBridge: bridge,
  })
  bridge.calls.length = 0
  await assert.rejects(() => failing.send(member.id, '再换', undefined, 'C:/target', 't-1', false, '新目标'))
  assert.deepEqual(bridge.calls, [])
})

test('G1b：post-send 段抛错不影响已投递（send 仍 resolve、sendReliable 不重投）', async () => {
  // option ①（v6 §2.1）：sendMessage 成功后到 return 之间整段 try/catch——记账/授予失败只 warn。
  // 这里让 post-send 的会话查询抛错（sandboxPolicy 存在 → ensureWritableRoot 会去查 childSessionOf）。
  const warnings = []
  let sends = 0
  const subagents = {
    async sendMessage() { sends += 1; return 'm-post' },
    async interrupt() {},
    async listDescendants() { return [] },
  }
  const dispatcher = createSubagentDispatcher({
    subagents,
    agent,
    sandboxPolicy: () => ({ registerWritableRoot: () => () => {} }),
    agents: () => ({ get() { throw new Error('agents boom') } }),
    onWarn: message => { warnings.push(message) },
    sessionWaitMs: 0,
  })
  const sent = await dispatcher.sendReliable('c-9', 'x', undefined, 'C:/target', 't-9', false)
  assert.equal(sent, 'm-post')
  assert.equal(sends, 1, '已投递绝不重发')
  assert.match(warnings.join('\n'), /投递后记账\/授予失败/)
})

test('V6 M2：send 的 messageId / attemptKey 幂等重放——只重试授予，不二次 sendMessage', async () => {
  let sends = 0
  let grants = 0
  const session = { id: 'c-7', header: { cwd: 'C:\\work' }, append() {} }
  const dispatcher = createSubagentDispatcher({
    subagents: {
      async sendMessage() { sends += 1; return { messageId: 'm-7' } },
      async interrupt() {},
      async listDescendants() { return [] },
    },
    agent,
    sessions: () => ({ get: () => session }),
    agents: () => ({ get: id => id === 'c-7' ? { id, session } : undefined }),
    sandboxPolicy: () => ({ overrideOf: () => 'workspace-write', registerWritableRoot: () => { grants += 1; return () => {} } }),
    sessionWaitMs: 0,
  })
  const first = await dispatcher.send('c-7', 'x', undefined, 'C:/target', 't-7', false, undefined, undefined, { attemptKey: 'followup:t-7:1' })
  assert.equal(first, 'm-7')
  assert.equal(sends, 1)
  // 同 attemptKey 重放：直接返回缓存 id，只走 retryPlanGrant（不再投递）。
  const replay = await dispatcher.send('c-7', 'x', undefined, 'C:/target', 't-7', false, undefined, undefined, { attemptKey: 'followup:t-7:1' })
  assert.equal(replay, 'm-7')
  assert.equal(sends, 1)
  // 跨重启重放：调用方带 followup 行 meta.messageId。
  const replayed = await dispatcher.send('c-7', 'x', undefined, 'C:/target', 't-7', false, undefined, undefined, { messageId: 'm-7' })
  assert.equal(replayed, 'm-7')
  assert.equal(sends, 1)
  assert.equal(grants >= 1, true, '重放仍按当前 Session 幂等重试授予')
})

test('V6 M2：retryPlanGrant 不投递、按 live Session 切 ws；无 Session 停在 switching', async () => {
  let sends = 0
  const modes = new Map()
  const registrations = []
  const session = { id: 'c-8', header: { cwd: 'C:\\work' }, append(event, payload) { if (event === 'sandbox/mode') modes.set('c-8', payload.mode) } }
  const dispatcher = createSubagentDispatcher({
    subagents: {
      async sendMessage() { sends += 1; return 'm' },
      async interrupt() {},
      async listDescendants() { return [] },
    },
    agent,
    sessions: () => ({ get: id => id === 'c-8' ? session : undefined }),
    agents: () => ({ get: id => id === 'c-8' ? { id, session } : undefined }),
    sandboxPolicy: () => ({ overrideOf: s => modes.get(s.id), registerWritableRoot: (s, dir) => { registrations.push([s.id, dir]); return () => {} } }),
    sessionWaitMs: 0,
  })
  const granted = dispatcher.retryPlanGrant('c-8', { taskId: 't-8', targetDir: 'C:/target' })
  assert.equal(granted.state, 'granted')
  assert.equal(modes.get('c-8'), 'workspace-write')
  assert.deepEqual(registrations, [['c-8', 'C:/target']])
  assert.equal(sends, 0, 'retry grant 绝不投递')
  // 无 Session：诚实停在 switching（可再试），不抛错。
  const missing = dispatcher.retryPlanGrant('c-missing', { taskId: 't-8', targetDir: 'C:/target' })
  assert.equal(missing.state, 'switching')
  assert.equal(missing.reason, 'retry-no-session')
})

// —— 审计 2026-11-23 的 3 个 P0（每条一个能复现的最小用例）——

/** 已批准计划任务的授予环境：模式投影可读可写、注册可数、cwd 固定 C:\work。 */
function approvedWriteEnv(childId) {
  const modes = new Map()
  const registrations = []
  const sessionsById = new Map()
  const session = {
    id: childId,
    header: { cwd: 'C:\\work' },
    append(event, payload) { if (event === 'sandbox/mode') modes.set(childId, payload.mode) },
  }
  sessionsById.set(childId, session)
  const dispatcher = createSubagentDispatcher({
    subagents: {
      async sendMessage() { return 'm-approved' },
      async interrupt() {},
      async listDescendants() { return [] },
    },
    agent,
    sessions: () => ({ get: id => sessionsById.get(id) }),
    agents: () => ({ get: id => id === childId ? { id, session } : undefined }),
    sandboxPolicy: () => ({
      overrideOf: target => modes.get(target.id),
      registerWritableRoot: (target, dir) => { registrations.push([target.id, dir]); return () => {} },
    }),
    sessionWaitMs: 0,
  })
  return { dispatcher, modes, registrations, session }
}

test('P0-1 审计：approved 且 target == session.header.cwd → 沙箱仍要切 workspace-write（不能只跳过注册）', async () => {
  const env = approvedWriteEnv('c-same')
  env.modes.set('c-same', 'read-only') // 计划期的沙箱是真只读
  await env.dispatcher.send('c-same', '执行', undefined, 'C:\\work', 't-same', false, undefined, undefined, { planApproved: true })
  assert.equal(env.modes.get('c-same'), 'workspace-write', '同 cwd 只是「不用注册可写根」，沙箱必须切回可写')
  assert.deepEqual(env.registrations, [], '平台根就是 target：不重复注册')
  assert.equal(env.dispatcher.planWriteInfo('c-same').state, 'granted')
  assert.equal(env.dispatcher.planWriteInfo('c-same').reason, 'platform-root')
})

test('P0-1 审计：approved 但没有 target（继承父 cwd）→ 同样切可写，不再「granted 但写不了」', async () => {
  const env = approvedWriteEnv('c-notarget')
  env.modes.set('c-notarget', 'read-only')
  await env.dispatcher.send('c-notarget', '执行', undefined, undefined, 't-notarget', false, undefined, undefined, { planApproved: true })
  assert.equal(env.modes.get('c-notarget'), 'workspace-write')
  assert.equal(env.dispatcher.planWriteInfo('c-notarget').state, 'granted')
})

test('P0-3 审计：只读任务的 messageId/attemptKey 重放不 append workspace-write、不注册', async () => {
  const env = approvedWriteEnv('c-ro')
  env.modes.set('c-ro', 'read-only')
  const replayed = await env.dispatcher.send('c-ro', 'x', undefined, 'C:/target', 't-ro', true, undefined, undefined, { messageId: 'm-old' })
  assert.equal(replayed, 'm-old')
  assert.equal(env.modes.get('c-ro'), 'read-only', '只读任务重放不许被写成可写')
  assert.deepEqual(env.registrations, [], '只读任务重放不许注册可写根')
  // 也不许留一条幽灵 planWrite 行（旧实现无条件 retryPlanGrant 会写 switching）。
  assert.equal(env.dispatcher.planWriteInfo('c-ro').state, 'unknown')
})

test('P0-3 审计：attemptKey 命中的只读重放同样不授予（不二次投递）', async () => {
  let sends = 0
  const modes = new Map()
  const registrations = []
  const session = {
    id: 'c-ro2',
    header: { cwd: 'C:\\work' },
    append(event, payload) { if (event === 'sandbox/mode') modes.set('c-ro2', payload.mode) },
  }
  const dispatcher = createSubagentDispatcher({
    subagents: {
      async sendMessage() { sends += 1; return 'm-key' },
      async interrupt() {},
      async listDescendants() { return [] },
    },
    agent,
    sessions: () => ({ get: id => id === 'c-ro2' ? session : undefined }),
    agents: () => ({ get: id => id === 'c-ro2' ? { id, session } : undefined }),
    sandboxPolicy: () => ({ overrideOf: target => modes.get(target.id), registerWritableRoot: (target, dir) => { registrations.push([target.id, dir]); return () => {} } }),
    sessionWaitMs: 0,
  })
  const first = await dispatcher.send('c-ro2', 'x', undefined, 'C:/target', 't-ro2', true, undefined, undefined, { attemptKey: 'followup:t-ro2:1' })
  assert.equal(first, 'm-key')
  modes.set('c-ro2', 'read-only')
  const replay = await dispatcher.send('c-ro2', 'x', undefined, 'C:/target', 't-ro2', true, undefined, undefined, { attemptKey: 'followup:t-ro2:1' })
  assert.equal(replay, 'm-key')
  assert.equal(sends, 1, '重放不二次投递')
  assert.equal(modes.get('c-ro2'), 'read-only')
  assert.deepEqual(registrations, [], '只读任务首投也不注册可写根')
})

test('sendReliable：send 在投递成功之后抛错时不得重发（已投递标记真的生效）', async () => {
  let sends = 0
  const dispatcher = createSubagentDispatcher({
    subagents: {
      async sendMessage() { sends += 1; return 'm-done' },
      async interrupt() {},
      async listDescendants() { return [] },
    },
    agent,
    retryDelaysMs: [0, 0, 0],
    sessionWaitMs: 0,
  })
  const original = dispatcher.send.bind(dispatcher)
  // 模拟「未来有人往 send 里加了会抛的语句」：投递本身已完成。
  dispatcher.send = async (...args) => {
    await original(...args)
    throw new Error('post-deliver boom')
  }
  await assert.rejects(() => dispatcher.sendReliable('c-rel', 'x'), /post-deliver boom/)
  assert.equal(sends, 1, '已投递（onDelivered 已回调）就绝不再发一遍')
})

test('G1：stop 清目标；dispose 抛错也在 finally 里清', async () => {
  const cleared = []
  const bridge = {
    async attach() {},
    async update() {},
    async clear(taskId, sessionId) { cleared.push([taskId, sessionId]) },
    async complete() {},
  }
  const subagents = {
    async startActivation(spec) {
      return {
        childId: spec.childId,
        messageId: 'm1',
        result: new Promise(() => {}),
        dispose: async () => { throw new Error('dispose 失败') },
      }
    },
    async sendMessage() { return 'm' },
    async interrupt() {},
    async listDescendants() { return [] },
  }
  const dispatcher = createSubagentDispatcher({ subagents, agent, goalBridge: bridge })
  const member = await dispatcher.spawn({ prompt: 'p', taskId: 't-1' })
  await assert.rejects(() => dispatcher.stop(member.id, 't-1'), /dispose 失败/)
  assert.deepEqual(cleared, [['t-1', member.id]])
  // 没有本地 activation（重启后）：走 interrupt，同样清目标。
  await dispatcher.stop('c-old', 't-2')
  assert.deepEqual(cleared, [['t-1', member.id], ['t-2', 'c-old']])
})
