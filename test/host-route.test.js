import test from 'node:test'
import assert from 'node:assert/strict'
import { openLedger, createTask, transition, markQueued, setTaskArtifacts } from '../src/ledger.js'
import { createHostRoute, HOST_ROUTE, HOST_ROUTE_OPTIONS } from '../src/host-route.js'
import { tempDir, sampleBrief } from './helpers.js'

const request = body => new Request('http://localhost/api/orchestrator', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

const counts = db => ({
  tasks: db.prepare('SELECT count(*) AS n FROM tasks').get().n,
  messages: db.prepare('SELECT count(*) AS n FROM messages').get().n,
  settings: db.prepare('SELECT count(*) AS n FROM settings').get().n,
  notifications: db.prepare('SELECT count(*) AS n FROM notifications').get().n,
})

const setup = async () => {
  const db = await openLedger(tempDir())
  const handler = createHostRoute({ db, coordinatorStatus: () => ({ id: 's-1', live: true }), staleMinutes: 30 })
  return { db, handler }
}

test('路由声明：POST /api/orchestrator，buffered body', () => {
  assert.equal(HOST_ROUTE, '/api/orchestrator')
  assert.deepEqual(HOST_ROUTE_OPTIONS, { path: '/api/orchestrator', methods: ['POST'], requestBody: 'buffered' })
})

test('snapshot 返回任务安全字段与协调者状态', async () => {
  const { db, handler } = await setup()
  const task = createTask(db, { brief: sampleBrief({ title: '甲', goal: '目标', user_verbatim: '用户原话' }), coordinatorSession: 's-1' })
  transition(db, task.id, 'running', { sessionId: 'c-1', target: 'c-1' })
  const response = await handler(request({ endpoint: 'snapshot' }))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.deepEqual(body.mainSession, { id: 's-1', live: true, rotation: null })
  assert.equal(body.tasks.length, 1)
  const row = body.tasks[0]
  assert.equal(row.id, task.id)
  assert.equal(row.title, '甲')
  assert.equal(row.status, 'running')
  assert.equal(row.label, '进行中')
  assert.equal(row.tone, 'info')
  assert.equal(row.childSessionId, 'c-1')
  // 会话归属：客户端回复底部 chip 靠这个字段判断「任务是不是当前会话派出去的」。
  assert.equal(row.coordinatorSession, 's-1')
  assert.equal(row.queued, false)
  assert.equal(row.readOnly, false)
  const readOnlyTask = createTask(db, { brief: sampleBrief({ title: '只读', goal: 'g' }), coordinatorSession: 's-1', readOnly: true })
  const nextBody = await (await handler(request({ endpoint: 'snapshot' }))).json()
  assert.equal(nextBody.tasks.find(item => item.id === readOnlyTask.id).readOnly, true)
  assert.equal(typeof row.lastEventAt, 'number')
  assert.equal('goal' in row, false)
  assert.equal('user_verbatim' in row, false)
  db.close()
})

test('snapshot 返回待决计数（waiting_user / waiting_auth / delivered）', async () => {
  const { db, handler } = await setup()
  const waiting = createTask(db, { brief: sampleBrief({ title: '等你' }), coordinatorSession: 's-1' })
  transition(db, waiting.id, 'running', { sessionId: 'c-1', target: 'c-1' })
  transition(db, waiting.id, 'waiting_user')
  const auth = createTask(db, { brief: sampleBrief({ title: '要授权' }), coordinatorSession: 's-1' })
  transition(db, auth.id, 'running', { sessionId: 'c-2', target: 'c-2' })
  transition(db, auth.id, 'waiting_auth')
  const delivered = createTask(db, { brief: sampleBrief({ title: '待确认' }), coordinatorSession: 's-1' })
  transition(db, delivered.id, 'running', { sessionId: 'c-3', target: 'c-3' })
  transition(db, delivered.id, 'delivered')
  createTask(db, { brief: sampleBrief({ title: '在跑' }), coordinatorSession: 's-1' })
  const body = await (await handler(request({ endpoint: 'snapshot' }))).json()
  assert.equal(body.inboxCount, 3)
  const row = body.tasks.find(item => item.id === delivered.id)
  assert.equal(row.status, 'delivered')
  assert.equal(row.label, '待确认')
  assert.equal(row.tone, 'warn')
  assert.equal(row.canClose, true)
  assert.equal(row.canFollowup, true)
  assert.equal(row.canDelete, false)
  assert.ok(Number.isFinite(row.deliveredAt))
  assert.equal(row.closeReason, null)
  db.close()
})

test('snapshot 带 P1 字段：依赖/分组/写域/优先级', async () => {
  const { db, handler } = await setup()
  const task = createTask(db, {
    brief: sampleBrief({ title: 'P1 任务' }), coordinatorSession: 's-1',
    dependsOn: ['t-upstream'], groupId: '发布', writeScopes: ['src/api'], priority: 7,
    status: 'waiting_dep',
  })
  db.prepare('UPDATE tasks SET question = ?, question_options_json = ? WHERE id = ?').run('选哪个？', JSON.stringify(['A', 'B']), task.id)
  const body = await (await handler(request({ endpoint: 'snapshot' }))).json()
  const row = body.tasks.find(item => item.id === task.id)
  assert.deepEqual(row.dependsOn, ['t-upstream'])
  assert.equal(row.groupId, '发布')
  assert.deepEqual(row.writeScopes, ['src/api'])
  assert.equal(row.priority, 7)
  assert.equal(row.question, '选哪个？')
  assert.deepEqual(row.options, ['A', 'B'])
  db.close()
})

test('未知端点返回 400，不泄漏内部错误', async () => {
  const { db, handler } = await setup()
  const response = await handler(request({ endpoint: 'delete-everything' }))
  assert.equal(response.status, 400)
  const body = await response.json()
  assert.deepEqual(body, { ok: false, code: 'UNKNOWN_ENDPOINT', error: 'unknown-endpoint' })
  db.close()
})

test('面板动作端点：detail/artifacts/stop/retry/message/close 走 panel，失败返回 400', async () => {
  const db = await openLedger(tempDir())
  const calls = []
  const panel = {
    detail: taskId => ({ ok: true, taskId }),
    artifacts: limit => ({ ok: true, limit }),
    stop: async taskId => { calls.push(['stop', taskId]); return { ok: true, taskId } },
    retry: async taskId => { calls.push(['retry', taskId]); return { ok: true, taskId } },
    close: async taskId => { calls.push(['close', taskId]); return { ok: true, taskId, status: 'done' } },
    message: async (taskId, message) => {
      calls.push(['message', taskId, message])
      return message === '' ? { ok: false, error: '消息不能为空' } : { ok: true, taskId }
    },
  }
  const handler = createHostRoute({ db, panel, coordinatorStatus: () => ({ id: 's-1', live: true }) })
  const detail = await (await handler(request({ endpoint: 'detail', taskId: 't-1' }))).json()
  assert.equal(detail.taskId, 't-1')
  const artifacts = await (await handler(request({ endpoint: 'artifacts', limit: 5 }))).json()
  assert.equal(artifacts.limit, 5)
  await handler(request({ endpoint: 'stop', taskId: 't-1' }))
  await handler(request({ endpoint: 'retry', taskId: 't-1' }))
  await handler(request({ endpoint: 'close', taskId: 't-1' }))
  const bad = await handler(request({ endpoint: 'message', taskId: 't-1', message: '' }))
  assert.equal(bad.status, 400)
  assert.deepEqual(calls, [['stop', 't-1'], ['retry', 't-1'], ['close', 't-1'], ['message', 't-1', '']])
  db.close()
})

test('preview 端点把 taskId/path 透传给 panel.preview', async () => {
  const db = await openLedger(tempDir())
  const calls = []
  const panel = {
    detail: () => ({ ok: true }),
    artifacts: () => ({ ok: true, items: [] }),
    preview: (taskId, path) => { calls.push([taskId, path]); return { ok: true, kind: 'text', text: 'hi' } },
  }
  const handler = createHostRoute({ db, panel })
  const response = await handler(request({ endpoint: 'preview', taskId: 't-1', path: 'C:/w/a.md' }))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, kind: 'text', text: 'hi' })
  assert.deepEqual(calls, [['t-1', 'C:/w/a.md']])
  db.close()
})

test('坏 body / 空 body 也不会写台账', async () => {
  const { db, handler } = await setup()
  const before = counts(db)
  const bad = new Request('http://localhost/api/orchestrator', { method: 'POST', body: 'not-json' })
  const response = await handler(bad)
  assert.equal(response.status, 400)
  assert.deepEqual(counts(db), before)
  db.close()
})

test('调用所有端点后台账零写入', async () => {
  const { db, handler } = await setup()
  const task = createTask(db, { brief: sampleBrief({ title: '甲' }), coordinatorSession: 's-1' })
  transition(db, task.id, 'running', { sessionId: 'c-1', target: 'c-1' })
  const before = counts(db)
  await handler(request({ endpoint: 'snapshot' }))
  await handler(request({ endpoint: 'snapshot' }))
  await handler(request({ endpoint: 'session-role', sessionId: 's-1' }))
  await handler(request({ endpoint: 'session-role', sessionId: 'c-1' }))
  await handler(request({ endpoint: 'nope' }))
  assert.deepEqual(counts(db), before)
  db.close()
})

test('未打开主会话：mainSession.id 为 null (JSON null)', async () => {
  const db = await openLedger(tempDir())
  const handler = createHostRoute({ db, coordinatorStatus: () => ({ id: undefined, live: false }) })
  const body = await (await handler(request({ endpoint: 'snapshot' }))).json()
  assert.equal(body.mainSession.id, null)
  assert.equal(body.mainSession.live, false)
  db.close()
})

test('session-role：任务入口判定——只在当前会话就是主会话时 isMain=true', async () => {
  const db = await openLedger(tempDir())
  const handler = createHostRoute({ db, coordinatorStatus: () => ({ id: 's-main', live: true }) })
  const main = await handler(request({ endpoint: 'session-role', sessionId: 's-main' }))
  assert.equal(main.status, 200)
  assert.deepEqual(await main.json(), { ok: true, isMain: true })
  const child = await handler(request({ endpoint: 'session-role', sessionId: 'c-child' }))
  assert.deepEqual(await child.json(), { ok: true, isMain: false })
  // 语义：只要不是主会话（含子会话、空 body、空串）都隐藏任务入口。
  assert.equal((await (await handler(request({ endpoint: 'session-role' }))).json()).isMain, false)
  assert.equal((await (await handler(request({ endpoint: 'session-role', sessionId: '' }))).json()).isMain, false)
  assert.equal((await (await handler(request({ endpoint: 'session-role', sessionId: 42 }))).json()).isMain, false)
  db.close()
})

test('session-role：主会话未打开 / coordinatorStatus 缺失时降级为 false（默认隐藏）', async () => {
  const db = await openLedger(tempDir())
  const noMain = createHostRoute({ db, coordinatorStatus: () => ({ id: undefined, live: false }) })
  assert.deepEqual(
    await (await noMain(request({ endpoint: 'session-role', sessionId: 's-main' }))).json(),
    { ok: true, isMain: false },
  )
  const noStatus = createHostRoute({ db })
  assert.deepEqual(
    await (await noStatus(request({ endpoint: 'session-role', sessionId: 's-main' }))).json(),
    { ok: true, isMain: false },
  )
  db.close()
})

test('queued 按 queued_at 精确标记：新建未排队不算排队', async () => {
  const db = await openLedger(tempDir())
  const handler = createHostRoute({
    db,
    coordinatorStatus: () => ({ id: 's-1', live: true }),
    staleMinutes: 30,
    now: () => Date.now() + 60 * 60_000,
  })
  const fresh = createTask(db, { brief: sampleBrief({ title: '新建' }), coordinatorSession: 's-1' })
  const queued = createTask(db, { brief: sampleBrief({ title: '排队' }), coordinatorSession: 's-1' })
  markQueued(db, queued.id)
  const body = await (await handler(request({ endpoint: 'snapshot' }))).json()
  const byId = Object.fromEntries(body.tasks.map(row => [row.id, row]))
  assert.equal(byId[fresh.id].queued, false)
  assert.equal(byId[queued.id].queued, true)
  assert.equal(byId[queued.id].stale, true)
  db.close()
})

test('快照：活跃任务全量 + 历史最多 limit 条（老 running 不被截掉）', async () => {
  const db = await openLedger(tempDir())
  const running = createTask(db, { brief: sampleBrief({ title: '老的运行中' }), coordinatorSession: 's-1' })
  transition(db, running.id, 'running', { sessionId: 'c-1', target: 'c-1' })
  for (let i = 0; i < 3; i += 1) {
    const done = createTask(db, { brief: sampleBrief({ title: `新完成${i}` }), coordinatorSession: 's-1' })
    transition(db, done.id, 'running', { sessionId: `c-${i}`, target: `c-${i}` })
    transition(db, done.id, 'done')
  }
  const handler = createHostRoute({ db, coordinatorStatus: () => ({ id: 's-1', live: true }), limit: 2 })
  const body = await (await handler(request({ endpoint: 'snapshot' }))).json()
  const ids = body.tasks.map(row => row.id)
  assert.ok(ids.includes(running.id), '老 running 必须在快照里')
  assert.equal(body.tasks.filter(row => row.status === 'done').length, 2)
  assert.equal(body.tasks.length, 3)
  db.close()
})

test('snapshot 带 mainSession 与 targetDir；open-main 只建主会话', async () => {
  const db = await openLedger(tempDir())
  createTask(db, { brief: sampleBrief({ title: 't', goal: 'g', acceptance: ['a'] }), coordinatorSession: 's', targetDir: 'C:/work' })
  const calls = []
  const handler = createHostRoute({
    db,
    coordinatorStatus: () => ({ id: 's', live: true }),
    openMain: async () => { calls.push('open'); return { ok: true, sessionId: 'session-main' } },
  })
  const before = counts(db)
  const snapshot = await (await handler(request({ endpoint: 'snapshot' }))).json()
  assert.deepEqual(snapshot.mainSession, { id: 's', live: true, rotation: null })
  assert.equal(snapshot.tasks[0].targetDir, 'C:/work')
  assert.deepEqual(counts(db), before, 'snapshot 不应写库')
  const opened = await handler(request({ endpoint: 'open-main' }))
  const body = await opened.json()
  assert.equal(opened.status, 200)
  assert.equal(body.sessionId, 'session-main')
  assert.equal(body.created, false)
  // S4：形状固定的轮换字段（未轮换时 false/null，客户端不用判 undefined）。
  assert.equal(body.rotated, false)
  assert.equal(body.replaced, null)
  assert.deepEqual(calls, ['open'])
  db.close()
})

test('S4 open-main 透传 rotated/replaced：轮换时给出旧主会话 id，非字符串 replaced 归一为 null', async () => {
  const db = await openLedger(tempDir())
  const rotated = createHostRoute({
    db,
    openMain: async () => ({ ok: true, sessionId: 'session-new', created: true, rotated: true, replaced: 'session-old' }),
  })
  const body = await (await rotated(request({ endpoint: 'open-main' }))).json()
  assert.deepEqual(body, { ok: true, sessionId: 'session-new', created: true, rotated: true, replaced: 'session-old' })

  // 客户端契约：字段永远出现，未轮换/false 值不得变成 undefined 或旧 id 残留。
  const reused = createHostRoute({ db, openMain: async () => ({ ok: true, sessionId: 's', created: true, replaced: undefined }) })
  const reusedBody = await (await reused(request({ endpoint: 'open-main' }))).json()
  assert.deepEqual(reusedBody, { ok: true, sessionId: 's', created: true, rotated: false, replaced: null })
  db.close()
})

test('S2 snapshot 暴露 mainSession.rotation：只读注入、零采集、零写入', async () => {
  const db = await openLedger(tempDir())
  let calls = 0
  const rotation = {
    due: true,
    reasons: [{ code: 'tasks', text: '自上次轮换以来新增子任务 120 个（阈值 120）', value: 120, threshold: 120 }],
    metrics: {
      tasksSince: 120, sessionsSince: null, mainLogMiB: null,
      contextTokens: null, ageHours: 40, diskMiB: null, hoursSinceRotation: null, idleMinutes: null,
    },
    evaluatedAt: 1_760_000_000_000,
    lastRotatedAt: null,
  }
  const handler = createHostRoute({
    db,
    coordinatorStatus: () => ({ id: 's', live: true }),
    // 注入读取器：路由只允许调它（点查 settings），不允许在 2s 轮询路径上采集磁盘/token。
    rotationStatus: () => { calls += 1; return rotation },
  })
  const before = counts(db)
  const first = await (await handler(request({ endpoint: 'snapshot' }))).json()
  const second = await (await handler(request({ endpoint: 'snapshot' }))).json()
  assert.deepEqual(first.mainSession.rotation, rotation)
  assert.deepEqual(second.mainSession.rotation, rotation)
  assert.deepEqual(Object.keys(first.mainSession).sort(), ['id', 'live', 'rotation'])
  assert.equal(calls, 2, '每次快照只读一次，不触发采集')
  assert.deepEqual(counts(db), before, 'snapshot 仍零写入')
  db.close()
})

test('S2 rotationStatus 抛错/返回 undefined 时降级为 null，不拖垮 snapshot', async () => {
  const db = await openLedger(tempDir())
  const throwing = createHostRoute({
    db,
    coordinatorStatus: () => ({ id: 's', live: true }),
    rotationStatus: () => { throw new Error('settings boom') },
  })
  const body = await (await throwing(request({ endpoint: 'snapshot' }))).json()
  assert.equal(body.ok, true)
  assert.equal(body.mainSession.rotation, null)
  const empty = createHostRoute({
    db,
    coordinatorStatus: () => ({ id: 's', live: true }),
    rotationStatus: () => undefined,
  })
  assert.equal((await (await empty(request({ endpoint: 'snapshot' }))).json()).mainSession.rotation, null)
  db.close()
})

test('open-main 失败返回 500 与可读原因；无 openMain 时 500', async () => {
  const db = await openLedger(tempDir())
  const failing = createHostRoute({ db, openMain: async () => ({ ok: false, error: '指挥舱工作区不可用' }) })
  const failed = await failing(request({ endpoint: 'open-main' }))
  assert.equal(failed.status, 500)
  assert.match((await failed.json()).error, /指挥舱/)
  const unavailable = createHostRoute({ db })
  const missing = await unavailable(request({ endpoint: 'open-main' }))
  assert.equal(missing.status, 500)
  assert.equal((await missing.json()).error, 'open-main-unavailable')
  db.close()
})


test('open-main 抛异常时返回 500 可读错误，且不产生 unhandledRejection', async () => {
  const db = await openLedger(tempDir())
  let unhandled = 0
  const onUnhandled = () => { unhandled += 1 }
  process.on('unhandledRejection', onUnhandled)
  try {
    const handler = createHostRoute({ db, openMain: async () => { throw new Error('workspace boom') } })
    const response = await handler(request({ endpoint: 'open-main' }))
    const body = await response.json()
    assert.equal(response.status, 500)
    assert.equal(body.ok, false)
    assert.match(body.error, /workspace boom/)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(unhandled, 0)
  } finally {
    process.removeListener('unhandledRejection', onUnhandled)
    db.close()
  }
})


test('snapshot 任务行带 artifacts（path/label/exists），旧任务按空数组', async () => {
  const { db, handler } = await setup()
  const task = createTask(db, { brief: sampleBrief({ title: '有产物' }), coordinatorSession: 's-1' })
  transition(db, task.id, 'running', { sessionId: 'c-1', target: 'c-1' })
  setTaskArtifacts(db, task.id, [{ path: 'C:/w/a.md', label: '报告', exists: true }, { path: 'C:/w/b.txt', label: '', exists: false }])
  createTask(db, { brief: sampleBrief({ title: '旧任务' }), coordinatorSession: 's-1' })
  const body = await (await handler(request({ endpoint: 'snapshot' }))).json()
  const withArtifacts = body.tasks.find(row => row.title === '有产物')
  assert.deepEqual(withArtifacts.artifacts, [
    { path: 'C:/w/a.md', label: '报告', exists: true },
    { path: 'C:/w/b.txt', label: '', exists: false },
  ])
  const legacy = body.tasks.find(row => row.title === '旧任务')
  assert.deepEqual(legacy.artifacts, [])
  db.close()
})

test('面板失败按 code 映射 HTTP 状态（404/409/502/500）', async () => {
  const db = await openLedger(tempDir())
  const panel = {
    detail: () => ({ ok: false, code: 'TASK_NOT_FOUND', error: '没有任务 t-x' }),
    artifacts: () => ({ ok: true, items: [] }),
    stop: async () => ({ ok: false, code: 'STOP_FAILED', error: '停止失败：boom' }),
    retry: async () => ({ ok: false, code: 'RETRY_NOT_ALLOWED', error: '不能重派' }),
    message: async () => ({ ok: false, code: 'MESSAGE_DELIVERY_FAILED', error: '续派失败：offline' }),
  }
  const handler = createHostRoute({ db, panel })
  const detail = await handler(request({ endpoint: 'detail', taskId: 't-x' }))
  assert.equal(detail.status, 404)
  assert.equal((await detail.json()).code, 'TASK_NOT_FOUND')
  const stop = await handler(request({ endpoint: 'stop', taskId: 't-x' }))
  assert.equal(stop.status, 500)
  const retry = await handler(request({ endpoint: 'retry', taskId: 't-x' }))
  assert.equal(retry.status, 409)
  const message = await handler(request({ endpoint: 'message', taskId: 't-x', message: 'x' }))
  assert.equal(message.status, 502)
  db.close()
})

test('面板旧格式失败（无 code）仍 400；抛异常返回 ACTION_FAILED 500', async () => {
  const db = await openLedger(tempDir())
  const legacy = createHostRoute({
    db,
    panel: { message: async () => ({ ok: false, error: '消息不能为空' }), detail: () => ({ ok: true }), artifacts: () => ({ ok: true, items: [] }) },
  })
  const old = await legacy(request({ endpoint: 'message', taskId: 't-1', message: '' }))
  assert.equal(old.status, 400)
  assert.equal((await old.json()).code, undefined)
  const throwing = createHostRoute({
    db,
    panel: { stop: async () => { throw new Error('ledger boom') }, detail: () => ({ ok: true }), artifacts: () => ({ ok: true, items: [] }) },
  })
  const failed = await throwing(request({ endpoint: 'stop', taskId: 't-1' }))
  assert.equal(failed.status, 500)
  const body = await failed.json()
  assert.equal(body.code, 'ACTION_FAILED')
  assert.match(body.error, /ledger boom/)
  db.close()
})

test('未注入 panel 时返回 PANEL_ACTIONS_UNAVAILABLE', async () => {
  const db = await openLedger(tempDir())
  const handler = createHostRoute({ db })
  const response = await handler(request({ endpoint: 'stop', taskId: 't-1' }))
  assert.equal(response.status, 500)
  assert.deepEqual(await response.json(), {
    ok: false, code: 'PANEL_ACTIONS_UNAVAILABLE', error: 'panel-actions-unavailable',
  })
  db.close()
})

test('open-main 失败路径都带错误码', async () => {
  const db = await openLedger(tempDir())
  const unavailable = createHostRoute({ db })
  const missing = await unavailable(request({ endpoint: 'open-main' }))
  assert.equal(missing.status, 500)
  assert.deepEqual(await missing.json(), {
    ok: false, code: 'OPEN_MAIN_UNAVAILABLE', error: 'open-main-unavailable',
  })
  const failed = createHostRoute({ db, openMain: async () => ({ ok: false, error: '指挥舱工作区不可用' }) })
  const reason = await failed(request({ endpoint: 'open-main' }))
  assert.equal(reason.status, 500)
  const body = await reason.json()
  assert.equal(body.code, 'OPEN_MAIN_FAILED')
  assert.match(body.error, /指挥舱/)
  db.close()
})

test('message 请求级幂等：同 (taskId, clientRequestId) 只投递一次', async () => {
  const db = await openLedger(tempDir())
  const calls = []
  const panel = {
    detail: () => ({ ok: true }),
    artifacts: () => ({ ok: true, items: [] }),
    message: async (taskId, message) => {
      calls.push([taskId, message])
      return { ok: true, taskId }
    },
  }
  const handler = createHostRoute({ db, panel })
  const first = await (await handler(request({
    endpoint: 'message', taskId: 't-1', message: '继续', clientRequestId: 'req-1',
  }))).json()
  const second = await (await handler(request({
    endpoint: 'message', taskId: 't-1', message: '继续', clientRequestId: 'req-1',
  }))).json()
  assert.equal(first.ok, true)
  assert.equal(first.already, undefined)
  assert.equal(second.ok, true)
  assert.equal(second.already, true)
  assert.equal(second.duplicate, true)
  assert.deepEqual(calls, [['t-1', '继续']])
  const other = await (await handler(request({
    endpoint: 'message', taskId: 't-1', message: '继续', clientRequestId: 'req-2',
  }))).json()
  assert.equal(other.ok, true)
  assert.equal(calls.length, 2)
  db.close()
})

test('message 失败结果不缓存：同一个 clientRequestId 允许重试', async () => {
  const db = await openLedger(tempDir())
  let calls = 0
  const panel = {
    detail: () => ({ ok: true }),
    artifacts: () => ({ ok: true, items: [] }),
    message: async () => {
      calls += 1
      return { ok: false, code: 'MESSAGE_DELIVERY_FAILED', error: '续派失败：offline' }
    },
  }
  const handler = createHostRoute({ db, panel })
  const body = { endpoint: 'message', taskId: 't-1', message: '继续', clientRequestId: 'req-fail' }
  const first = await handler(request(body))
  const second = await handler(request(body))
  assert.equal(first.status, 502)
  assert.equal(second.status, 502)
  assert.equal(calls, 2)
  db.close()
})

test('message 并发同 clientRequestId 合并成一次投递', async () => {
  const db = await openLedger(tempDir())
  let calls = 0
  let release
  const gate = new Promise(resolve => { release = resolve })
  const panel = {
    detail: () => ({ ok: true }),
    artifacts: () => ({ ok: true, items: [] }),
    message: async (taskId) => {
      calls += 1
      await gate
      return { ok: true, taskId }
    },
  }
  const handler = createHostRoute({ db, panel })
  const body = { endpoint: 'message', taskId: 't-1', message: '继续', clientRequestId: 'req-concurrent' }
  const first = handler(request(body))
  const second = handler(request(body))
  await new Promise(resolve => setImmediate(resolve))
  release()
  const [a, b] = await Promise.all([first, second])
  assert.equal(a.status, 200)
  assert.equal(b.status, 200)
  assert.equal(calls, 1)
  assert.equal((await a.json()).already, undefined)
  assert.equal((await b.json()).already, true)
  db.close()
})

// 面板优化：快照下发按钮可见性，前端不自己重写状态表（前后端同源）。
test('snapshot 下发 canFollowup/canDelete：进行中不可删可续派，终态可删不可续派', async () => {
  const { db, handler } = await setup()
  const running = createTask(db, { brief: sampleBrief({ title: '在跑' }), coordinatorSession: 's-1' })
  transition(db, running.id, 'running', { sessionId: 'c-run', target: 'c-run' })
  const done = createTask(db, { brief: sampleBrief({ title: '完成' }), coordinatorSession: 's-1' })
  transition(db, done.id, 'running', { sessionId: 'c-done', target: 'c-done' })
  transition(db, done.id, 'done')
  const pending = createTask(db, { brief: sampleBrief({ title: '待派发' }), coordinatorSession: 's-1' })
  const body = await (await handler(request({ endpoint: 'snapshot' }))).json()
  const byId = Object.fromEntries(body.tasks.map(row => [row.id, row]))
  assert.equal(byId[running.id].canFollowup, true)
  assert.equal(byId[running.id].canDelete, false)
  assert.equal(byId[done.id].canFollowup, false)
  assert.equal(byId[done.id].canDelete, true)
  assert.equal(byId[pending.id].canFollowup, false)
  assert.equal(byId[pending.id].canDelete, false)
  db.close()
})

test('snapshot 的 canDelete 与活跃下游依赖同源：有活跃下游的终态任务不给删', async () => {
  const { db, handler } = await setup()
  const upstream = createTask(db, { brief: sampleBrief({ title: '已完成后置' }), coordinatorSession: 's-1' })
  transition(db, upstream.id, 'running', { sessionId: 'c-up', target: 'c-up' })
  transition(db, upstream.id, 'done')
  const downstream = createTask(db, {
    brief: sampleBrief({ title: '下游' }), coordinatorSession: 's-1', dependsOn: [upstream.id], status: 'waiting_dep',
  })
  const body = await (await handler(request({ endpoint: 'snapshot' }))).json()
  const byId = Object.fromEntries(body.tasks.map(row => [row.id, row]))
  assert.equal(byId[upstream.id].canDelete, false, '还有活跃下游时不能删')
  assert.equal(byId[downstream.id].canDelete, false, '下游本身还在活跃')
  transition(db, downstream.id, 'cancelled')
  const next = await (await handler(request({ endpoint: 'snapshot' }))).json()
  const nextById = Object.fromEntries(next.tasks.map(row => [row.id, row]))
  assert.equal(nextById[upstream.id].canDelete, true, '下游结束后可以删')
  db.close()
})

test('delete 端点透传 panel.delete；活跃任务的门控错误按 409 返回', async () => {
  const db = await openLedger(tempDir())
  const calls = []
  const panel = {
    detail: () => ({ ok: true }),
    artifacts: () => ({ ok: true, items: [] }),
    delete: async taskId => {
      calls.push(['delete', taskId])
      if (taskId === 't-active') {
        return { ok: false, code: 'DELETE_TASK_ACTIVE', error: '任务「跑着」还在进行中，不能删除；先「停止」再删。' }
      }
      return { ok: true, taskId, deleted: { messages: 2, notifications: 1 } }
    },
  }
  const handler = createHostRoute({ db, panel })
  const removed = await handler(request({ endpoint: 'delete', taskId: 't-done' }))
  assert.equal(removed.status, 200)
  assert.deepEqual(await removed.json(), { ok: true, taskId: 't-done', deleted: { messages: 2, notifications: 1 } })
  const blocked = await handler(request({ endpoint: 'delete', taskId: 't-active' }))
  assert.equal(blocked.status, 409)
  assert.equal((await blocked.json()).code, 'DELETE_TASK_ACTIVE')
  assert.deepEqual(calls, [['delete', 't-done'], ['delete', 't-active']])
  db.close()
})
