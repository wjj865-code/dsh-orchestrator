import test from 'node:test'
import assert from 'node:assert/strict'
import { openLedger, createTask, transition, markQueued, setTaskArtifacts } from '../src/ledger.js'
import { createHostRoute, HOST_ROUTE, HOST_ROUTE_OPTIONS } from '../src/host-route.js'
import { createWorkbench } from '../src/workbench.js'
import { tempDir, sampleBrief, markDone } from './helpers.js'

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
  assert.deepEqual(body.mainSession, { id: 's-1', live: true, context: null }, '主会话状态（0.25.0 增加只读 context 观测槽）')
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
  // P2-3 交接契约 v1（精简版）：交付未确认时 acceptedAt/acceptedBy 都是 null，契约版本可判定。
  assert.deepEqual(row.handoff, {
    contract: 1,
    deliveredAt: row.deliveredAt,
    acceptedAt: null,
    acceptedBy: null,
    acceptedByLabel: null,
    acceptanceOk: null,
  })
  // 没交付过的任务没有交接（null，而不是空壳对象）。
  assert.equal(body.tasks.find(item => item.id === waiting.id).handoff, null)
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

test('snapshot 带官方 Team 板只读快照（P2-4）：默认降级、可注入只读行、读抛错也不 500', async () => {
  const db = await openLedger(tempDir())
  // 1) 未装配：稳定降级形状（面板据此隐藏该分区，不假装「没有官方板」）。
  const plain = createHostRoute({ db, coordinatorStatus: () => ({ id: 's-1', live: true }) })
  const plainBody = await (await plain(request({ endpoint: 'snapshot' }))).json()
  assert.equal(plainBody.teamBoard.enabled, false)
  assert.deepEqual(plainBody.teamBoard.rows, [])
  assert.equal(plainBody.teamBoard.degraded.code, 'TEAM_BOARD_UNAVAILABLE')

  // 2) 装配只读视图：行原样下发（只读分区不改台账）。
  const rows = [{
    id: 'task-3', revision: 2, subject: '官方任务', status: 'in_progress', statusLabel: '进行中',
    owner: 'w-1', blockedBy: [], writeScopes: ['src/'], ready: false,
  }]
  const before = counts(db)
  const wired = createHostRoute({
    db,
    coordinatorStatus: () => ({ id: 's-1', live: true }),
    teamBoard: () => ({ enabled: true, rows, degraded: null }),
  })
  const body = await (await wired(request({ endpoint: 'snapshot' }))).json()
  assert.deepEqual(body.teamBoard, { enabled: true, rows, degraded: null })
  assert.deepEqual(counts(db), before, 'snapshot 不应写库')

  // 3) 读板抛错：降级而不是 500（快照是面板轮询入口，不能因为一块只读分区挂掉）。
  const broken = createHostRoute({
    db,
    coordinatorStatus: () => ({ id: 's-1', live: true }),
    teamBoard: () => { throw new Error('boom') },
  })
  const response = await broken(request({ endpoint: 'snapshot' }))
  assert.equal(response.status, 200)
  assert.equal((await response.json()).teamBoard.degraded.code, 'TEAM_BOARD_READ_FAILED')
  db.close()
})

test('snapshot 任务行带官方 Team 关联（teamTask）：没关联是 null，有关联带创建时 revision', async () => {
  const db = await openLedger(tempDir())
  const handler = createHostRoute({ db, coordinatorStatus: () => ({ id: 's-1', live: true }) })
  const plain = createTask(db, { brief: sampleBrief({ title: '没关联' }), coordinatorSession: 's-1' })
  const linked = createTask(db, {
    brief: sampleBrief({ title: '有关联' }),
    coordinatorSession: 's-1',
    teamTask: { id: 'task-3', revision: 2 },
  })
  const body = await (await handler(request({ endpoint: 'snapshot' }))).json()
  assert.equal(body.tasks.find(item => item.id === plain.id).teamTask, null)
  assert.deepEqual(body.tasks.find(item => item.id === linked.id).teamTask, { id: 'task-3', revision: 2 })
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

// t-a79e12d8：客户端只能通过轮询拿到「要不要跳到新主会话」这条待办（服务端不假装能导航）。
test('main-nav / main-nav-ack：读待办、ack 要 id 匹配、未装配时降级为 null/false 且不写台账', async () => {
  const db = await openLedger(tempDir())
  const pending = new Map()
  const acks = []
  const mainNav = {
    read: () => (pending.size === 0 ? null : [...pending.values()][0]),
    ack: ({ id, ok, error }) => {
      acks.push({ id, ok, error })
      if (!pending.has(id)) return { cleared: false }
      pending.delete(id)
      return { cleared: true }
    },
  }
  const handler = createHostRoute({ db, mainNav, coordinatorStatus: () => ({ id: 's-main', live: true }) })
  const before = counts(db)

  assert.deepEqual(await (await handler(request({ endpoint: 'main-nav' }))).json(), { ok: true, nav: null })
  pending.set('nav-1', { id: 'nav-1', kind: 'navigate', sessionId: 's-new', at: 1 })
  const read = await handler(request({ endpoint: 'main-nav' }))
  assert.equal(read.status, 200)
  assert.deepEqual(await read.json(), { ok: true, nav: { id: 'nav-1', kind: 'navigate', sessionId: 's-new', at: 1 } })

  // id 不匹配：不清（多客户端时先到先得）。
  assert.deepEqual(await (await handler(request({ endpoint: 'main-nav-ack', id: 'nav-9', ok: true }))).json(),
    { ok: true, cleared: false })
  assert.deepEqual(acks.at(-1), { id: 'nav-9', ok: true, error: '' })
  assert.deepEqual(await (await handler(request({ endpoint: 'main-nav-ack', id: 'nav-1', ok: false, error: 'unknown session' }))).json(),
    { ok: true, cleared: true })
  assert.deepEqual(acks.at(-1), { id: 'nav-1', ok: false, error: 'unknown session' })
  assert.deepEqual(await (await handler(request({ endpoint: 'main-nav' }))).json(), { ok: true, nav: null })
  assert.deepEqual(counts(db), before, 'main-nav / main-nav-ack 不写台账')

  // 未装配 mainNav（老装配/测试）：读 null、ack 视为已清，不 500。
  const bare = createHostRoute({ db })
  assert.deepEqual(await (await bare(request({ endpoint: 'main-nav' }))).json(), { ok: true, nav: null })
  assert.deepEqual(await (await bare(request({ endpoint: 'main-nav-ack', id: 'nav-1', ok: true }))).json(),
    { ok: true, cleared: false })
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
    markDone(db, done.id)
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
  assert.deepEqual(snapshot.mainSession, { id: 's', live: true, context: null })
  assert.equal(snapshot.tasks[0].targetDir, 'C:/work')
  assert.deepEqual(counts(db), before, 'snapshot 不应写库')
  const opened = await handler(request({ endpoint: 'open-main' }))
  const body = await opened.json()
  assert.equal(opened.status, 200)
  assert.equal(body.sessionId, 'session-main')
  assert.equal(body.created, false)
  assert.deepEqual(calls, ['open'])
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
  markDone(db, done.id)
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
  markDone(db, upstream.id)
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

// ---------------------------------------------------------------------------
// 工作台 v1（P11）：只读投影 / 窄写口 / 幂等 / 反例端点在路由层不存在
// ---------------------------------------------------------------------------

const workbenchSetup = async ({ schedule } = {}) => {
  const db = await openLedger(tempDir())
  const workbench = createWorkbench({
    db,
    schedule: () => schedule,
    mainSessionId: () => 's-main',
    now: () => Date.parse('2026-11-21T10:00:00+08:00'),
  })
  const handler = createHostRoute({ db, coordinatorStatus: () => ({ id: 's-main', live: true }), workbench })
  return { db, handler, workbench }
}

test('工作台只读端点：groups / group / calendar / automations 都可读，且不需要 panel', async () => {
  const { db, handler } = await workbenchSetup()
  createTask(db, { brief: sampleBrief({ title: '甲' }), coordinatorSession: 's-main', groupId: 'gzh', status: 'pending' })
  const groups = await handler(request({ endpoint: 'groups' }))
  assert.equal(groups.status, 200)
  const groupBody = await groups.json()
  assert.equal(groupBody.ok, true)
  assert.equal(groupBody.groups[0].id, 'gzh')
  const detail = await (await handler(request({ endpoint: 'group', groupId: 'gzh' }))).json()
  assert.equal(detail.ok, true)
  assert.equal(detail.tasks.length, 1)
  const missing = await handler(request({ endpoint: 'group', groupId: 'nope' }))
  assert.equal(missing.status, 404)
  assert.equal((await missing.json()).code, 'GROUP_NOT_FOUND')
  const calendar = await (await handler(request({ endpoint: 'calendar', from: '2026-11-01T00:00:00.000Z', to: '2026-11-30T00:00:00.000Z' }))).json()
  assert.equal(calendar.ok, true)
  const automations = await (await handler(request({ endpoint: 'automations' }))).json()
  assert.equal(automations.ok, true)
  assert.equal(automations.available, false, '没有 schedule 服务时如实降级')
  db.close()
})

test('stats 端点：复盘页只读统计（days 缺省 7、上限 62、非法回落 7），不需要 panel', async () => {
  const { db, handler } = await workbenchSetup()
  const task = createTask(db, { brief: sampleBrief({ title: '复盘' }), coordinatorSession: 's-main', groupId: 'gzh' })
  transition(db, task.id, 'running', { sessionId: 'c-1', target: 'c-1' })
  transition(db, task.id, 'delivered')
  // 台账时间戳对齐 workbenchSetup 的固定 now（2026-11-21T10:00+08:00）→ 落在 30/7 天窗口内。
  const at = Date.parse('2026-11-21T10:00:00+08:00')
  db.prepare('UPDATE tasks SET created_at = ?, delivered_at = ?, updated_at = ? WHERE id = ?')
    .run(at - 2 * 24 * 60 * 60 * 1000, at - 24 * 60 * 60 * 1000, at - 60 * 60 * 1000, task.id)
  const response = await handler(request({ endpoint: 'stats', days: 30 }))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.days, 30)
  assert.ok(Number.isFinite(body.from) && Number.isFinite(body.to) && body.to > body.from)
  for (const key of ['delivered', 'accepted', 'failed', 'messages']) assert.equal(typeof body[key], 'number', key)
  for (const key of ['failures', 'artifacts', 'groups']) assert.ok(Array.isArray(body[key]), key)
  assert.equal(body.groups[0].id, 'gzh')
  // 缺省 7 天；超上限夹到 62；非法值回落 7。
  assert.equal((await (await handler(request({ endpoint: 'stats' }))).json()).days, 7)
  assert.equal((await (await handler(request({ endpoint: 'stats', days: 999 }))).json()).days, 62)
  assert.equal((await (await handler(request({ endpoint: 'stats', days: 'x' }))).json()).days, 7)
  // 只读：任务状态没被统计读改写。
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(task.id).status, 'delivered')
  db.close()
})

test('工作台端点未装配时返回 500，未知端点仍 400；反例端点不存在', async () => {  const db = await openLedger(tempDir())
  const handler = createHostRoute({ db })
  const unavailable = await handler(request({ endpoint: 'groups' }))
  assert.equal(unavailable.status, 500)
  assert.equal((await unavailable.json()).code, 'PANEL_ACTIONS_UNAVAILABLE')
  // 设计稿 §5.3 的反例清单：这些端点一个都不许存在（派发/批准/批量确认/通用 patch）。
  for (const endpoint of ['task-create', 'plan-approve', 'close-all', 'patch-task', 'message-all']) {
    const response = await handler(request({ endpoint }))
    assert.equal(response.status, 400, endpoint)
    assert.equal((await response.json()).code, 'UNKNOWN_ENDPOINT', endpoint)
  }
  db.close()
})

test('plan-set：写 planned_at → snapshot 下发 plannedAt/canPlan；终态 409；clientRequestId 幂等', async () => {
  const { db, handler } = await workbenchSetup()
  const task = createTask(db, { brief: sampleBrief({ title: '排期' }), coordinatorSession: 's-main', groupId: 'gzh' })
  transition(db, task.id, 'running', { sessionId: 'c-1', target: 'c-1' })
  const when = '2026-11-22T20:00:00+08:00'
  const first = await handler(request({ endpoint: 'plan-set', taskId: task.id, plannedAt: when, clientRequestId: 'r-1' }))
  assert.equal(first.status, 200)
  assert.equal((await first.json()).plannedAt, Date.parse(when))
  const snapshot = await (await handler(request({ endpoint: 'snapshot' }))).json()
  const row = snapshot.tasks.find(item => item.id === task.id)
  assert.equal(row.plannedAt, Date.parse(when))
  assert.equal(row.canPlan, true)
  // 同一个 clientRequestId 重发：命中缓存，回 already + duplicate，只写一次。
  const repeat = await handler(request({ endpoint: 'plan-set', taskId: task.id, plannedAt: when, clientRequestId: 'r-1' }))
  const repeatBody = await repeat.json()
  assert.equal(repeat.status, 200)
  assert.equal(repeatBody.already, true)
  assert.equal(repeatBody.duplicate, true)
  // 终态任务不能排期。
  const done = createTask(db, { brief: sampleBrief({ title: '完了' }), coordinatorSession: 's-main' })
  transition(db, done.id, 'running', { sessionId: 'c-2', target: 'c-2' })
  transition(db, done.id, 'delivered')
  transition(db, done.id, 'done')
  const ended = await handler(request({ endpoint: 'plan-set', taskId: done.id, plannedAt: when }))
  assert.equal(ended.status, 409)
  assert.equal((await ended.json()).code, 'PLAN_TASK_ENDED')
  const badTime = await handler(request({ endpoint: 'plan-set', taskId: task.id, plannedAt: 'nope' }))
  assert.equal(badTime.status, 400)
  assert.equal((await badTime.json()).code, 'PLAN_TIME_INVALID')
  db.close()
})

test('group-save / group-archive：危险动作要 confirm，归档后不能改名，组键不变', async () => {
  const { db, handler } = await workbenchSetup()
  const task = createTask(db, { brief: sampleBrief({ title: '甲' }), coordinatorSession: 's-main', groupId: 'gzh' })
  const saved = await handler(request({ endpoint: 'group-save', id: 'gzh', name: '公众号文章组' }))
  assert.equal(saved.status, 200)
  assert.equal((await saved.json()).group.name, '公众号文章组')
  assert.equal(db.prepare('SELECT group_id FROM tasks WHERE id = ?').get(task.id).group_id, 'gzh')
  const noConfirm = await handler(request({ endpoint: 'group-archive', id: 'gzh', archived: true }))
  assert.equal(noConfirm.status, 409)
  assert.equal((await noConfirm.json()).code, 'GROUP_NOT_CONFIRMED')
  const archived = await handler(request({ endpoint: 'group-archive', id: 'gzh', archived: true, confirm: true, clientRequestId: 'g-1' }))
  assert.equal((await archived.json()).group.archived, true)
  const rename = await handler(request({ endpoint: 'group-save', id: 'gzh', name: '改不了' }))
  assert.equal(rename.status, 409)
  assert.equal((await rename.json()).code, 'GROUP_ARCHIVED')
  db.close()
})

test('automation-save / toggle / delete：confirm 门控、目标强制主会话、全链路成功', async () => {
  const calls = []
  const rows = new Map()
  let seq = 0
  const schedule = {
    async create(request) {
      calls.push(['create', request])
      const id = `schedule-${++seq}`
      const row = { id, ...request, status: 'active', scheduledAt: '2026-11-22T01:00:00.000Z', updatedAt: `u${seq}` }
      rows.set(id, row)
      return row
    },
    async view({ id }) { return rows.get(id) ?? { id, code: 'schedule_not_found' } },
    async edit(req) {
      calls.push(['edit', req])
      const row = rows.get(req.id)
      if (row === undefined) return { id: req.id, code: 'schedule_not_found' }
      if (req.action === 'delete') { rows.delete(req.id); return { id: req.id, deleted: true } }
      const next = { ...row, ...req.patch, updatedAt: `${row.updatedAt}+` }
      rows.set(req.id, next)
      return next
    },
  }
  const { db, handler } = await workbenchSetup({ schedule })
  createTask(db, { brief: sampleBrief({ title: '甲' }), coordinatorSession: 's-main', groupId: 'gzh' })
  const missingConfirm = await handler(request({ endpoint: 'automation-save', kind: 'group', refId: 'gzh', timing: { kind: 'daily', time: '09:00' } }))
  assert.equal(missingConfirm.status, 409)
  assert.equal((await missingConfirm.json()).code, 'AUTOMATION_NOT_CONFIRMED')
  const created = await handler(request({
    endpoint: 'automation-save', kind: 'group', refId: 'gzh', timing: { kind: 'daily', time: '09:00' }, confirm: true, clientRequestId: 'a-1',
  }))
  assert.equal(created.status, 200)
  const createdBody = await created.json()
  assert.equal(createdBody.automation.kind, 'group')
  assert.deepEqual(calls[0][1].target, { kind: 'session', sessionId: 's-main' })
  const list = await (await handler(request({ endpoint: 'automations' }))).json()
  assert.equal(list.available, true)
  assert.equal(list.rows.length, 1)
  const toggled = await handler(request({ endpoint: 'automation-toggle', id: createdBody.automation.id, active: false, confirm: true }))
  assert.equal(toggled.status, 200)
  const removed = await handler(request({ endpoint: 'automation-delete', id: createdBody.automation.id, confirm: true }))
  assert.equal(removed.status, 200)
  assert.equal((await removed.json()).deleted, true)
  db.close()
})

test('工作台写动作在宿主没有 schedule 时返回 502（可读降级，不是 500）', async () => {
  const { db, handler } = await workbenchSetup()
  createTask(db, { brief: sampleBrief({ title: '甲' }), coordinatorSession: 's-main', groupId: 'gzh' })
  const response = await handler(request({
    endpoint: 'automation-save', kind: 'group', refId: 'gzh', timing: { kind: 'daily', time: '09:00' }, confirm: true,
  }))
  assert.equal(response.status, 502)
  assert.equal((await response.json()).code, 'AUTOMATION_UNAVAILABLE')
  db.close()
})
