import test from 'node:test'
import assert from 'node:assert/strict'
import { openLedger, createTask, transition } from '../src/ledger.js'
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
  assert.deepEqual(body.coordinator, { id: 's-1', live: true })
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

test('未绑定协调者：coordinator.id 为 null (JSON null)', async () => {
  const db = await openLedger(tempDir())
  const handler = createHostRoute({ db, coordinatorStatus: () => ({ id: undefined, live: false }) })
  const body = await (await handler(request({ endpoint: 'snapshot' }))).json()
  assert.equal(body.coordinator.id, null)
  assert.equal(body.coordinator.live, false)
  db.close()
})

test('queued / stale 标记', async () => {
  const db = await openLedger(tempDir())
  const handler = createHostRoute({
    db,
    coordinatorStatus: () => ({ id: 's-1', live: true }),
    staleMinutes: 30,
    now: () => Date.now() + 60 * 60_000,
  })
  const task = createTask(db, { brief: sampleBrief({ title: '排队' }), coordinatorSession: 's-1' })
  const body = await (await handler(request({ endpoint: 'snapshot' }))).json()
  const row = body.tasks.find(item => item.id === task.id)
  assert.equal(row.queued, true)
  assert.equal(row.stale, true)
  db.close()
})
