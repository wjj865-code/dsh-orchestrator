import test from 'node:test'
import assert from 'node:assert/strict'
import { openLedger, createTask, transition, markQueued } from '../src/ledger.js'
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
  assert.deepEqual(body.mainSession, { id: 's-1', live: true })
  assert.equal(body.tasks.length, 1)
  const row = body.tasks[0]
  assert.equal(row.id, task.id)
  assert.equal(row.title, '甲')
  assert.equal(row.status, 'running')
  assert.equal(row.label, '进行中')
  assert.equal(row.tone, 'info')
  assert.equal(row.childSessionId, 'c-1')
  assert.equal(row.queued, false)
  assert.equal(typeof row.lastEventAt, 'number')
  assert.equal('goal' in row, false)
  assert.equal('user_verbatim' in row, false)
  db.close()
})

test('未知端点返回 400，不泄漏内部错误', async () => {
  const { db, handler } = await setup()
  const response = await handler(request({ endpoint: 'delete-everything' }))
  assert.equal(response.status, 400)
  const body = await response.json()
  assert.deepEqual(body, { ok: false, error: 'unknown-endpoint' })
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
  assert.deepEqual(snapshot.mainSession, { id: 's', live: true })
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
