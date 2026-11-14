import test from 'node:test'
import assert from 'node:assert/strict'
import { openLedger, createTask, getTask, listTasks, transition, addMessage, setTaskArtifacts } from '../src/ledger.js'
import { createPanelActions } from '../src/panel-actions.js'
import { tempDir, sampleBrief } from './helpers.js'

function setup() {
  const calls = { stop: [], send: [], release: [] }
  const queue = {
    removed: [],
    pumped: 0,
    remove(id) { this.removed.push(id) },
    pump() { this.pumped += 1 },
    async enqueueAndPump(id) {
      this.pumped += 1
      return { task: getTask(db, id), position: 1 }
    },
  }
  const dispatcher = {
    async stop(target) { calls.stop.push(target) },
    releaseWritableRoots(target) { calls.release.push(target) },
    async sendReliable(target, message, signal, targetDir, taskId, readOnly) {
      calls.send.push({ target, message, targetDir, taskId, readOnly })
      return { messageId: 'm-1' }
    },
  }
  let db
  const actions = () => createPanelActions({
    db,
    dispatcher,
    queue,
    config: {},
    coordinatorStatus: () => ({ id: 's-1', live: true }),
    logger: { log() {} },
  })
  return {
    async init() {
      db = await openLedger(tempDir())
      return { db, actions: actions(), queue, calls, dispatcher }
    },
  }
}

test('detail 返回 brief/消息/产物/依赖', async () => {
  const env = setup()
  const { db, actions } = await env.init()
  const dep = createTask(db, { brief: sampleBrief({ title: '前置' }), coordinatorSession: 's-1' })
  transition(db, dep.id, 'running', { sessionId: 'c-1', target: 'c-1' })
  transition(db, dep.id, 'done')
  const task = createTask(db, {
    brief: sampleBrief({ title: '详情任务', goal: '看详情' }), coordinatorSession: 's-1',
    dependsOn: [dep.id], groupId: 'G',
  })
  transition(db, task.id, 'running', { sessionId: 'c-2', target: 'c-2' })
  addMessage(db, task.id, { kind: 'followup', rendered: '继续' })
  setTaskArtifacts(db, task.id, [{ path: 'C:/out.md', label: '结果', exists: true }])
  const detail = actions.detail(task.id)
  assert.equal(detail.ok, true)
  assert.equal(detail.task.title, '详情任务')
  assert.equal(detail.task.group, 'G')
  assert.equal(detail.task.artifacts.length, 1)
  assert.equal(detail.dependencies[0].status, 'done')
  assert.equal(detail.messages.some(row => row.text === '继续'), true)
  db.close()
})

test('stop 中断子会话并标 cancelled', async () => {
  const env = setup()
  const { db, actions, queue, calls } = await env.init()
  const task = createTask(db, { brief: sampleBrief({ title: '停止任务' }), coordinatorSession: 's-1' })
  transition(db, task.id, 'running', { sessionId: 'c-1', target: 'c-1' })
  const result = await actions.stop(task.id)
  assert.equal(result.ok, true)
  assert.equal(getTask(db, task.id).status, 'cancelled')
  assert.deepEqual(calls.stop, ['c-1'])
  assert.deepEqual(calls.release, ['c-1'])
  assert.equal(queue.removed.includes(task.id), true)
  db.close()
})

test('retry 用原 brief 新建任务并保留编排字段', async () => {
  const env = setup()
  const { db, actions } = await env.init()
  const dep = createTask(db, { brief: sampleBrief({ title: '完成前置' }), coordinatorSession: 's-1' })
  transition(db, dep.id, 'running', { sessionId: 'c-dep', target: 'c-dep' })
  transition(db, dep.id, 'done')
  const old = createTask(db, {
    brief: sampleBrief({ title: '失败任务' }), coordinatorSession: 's-1',
    dependsOn: [dep.id], groupId: 'G', writeScopes: ['src'], priority: 4,
  })
  transition(db, old.id, 'failed', { error: 'boom' })
  const result = await actions.retry(old.id)
  assert.equal(result.ok, true)
  const next = getTask(db, result.taskId)
  assert.equal(next.retry_of, old.id)
  assert.deepEqual(next.depends_on, [dep.id])
  assert.equal(next.group_id, 'G')
  assert.deepEqual(next.write_scopes, ['src'])
  assert.equal(next.priority, 4)
  db.close()
})

test('message 投递续派并记录 attempts/清问题', async () => {
  const env = setup()
  const { db, actions, calls } = await env.init()
  const task = createTask(db, { brief: sampleBrief({ title: '续派任务' }), coordinatorSession: 's-1' })
  transition(db, task.id, 'running', { sessionId: 'c-1', target: 'c-1' })
  db.prepare('UPDATE tasks SET question = ?, question_options_json = ? WHERE id = ?').run('继续吗？', '[]', task.id)
  const result = await actions.message(task.id, '继续修')
  assert.equal(result.ok, true)
  assert.equal(calls.send[0].message, '继续修')
  const next = getTask(db, task.id)
  assert.equal(next.attempts, 1)
  assert.equal(next.question, null)
  db.close()
})

test('artifacts 汇总所有任务的产物', async () => {
  const env = setup()
  const { db, actions } = await env.init()
  const task = createTask(db, { brief: sampleBrief({ title: '产物任务' }), coordinatorSession: 's-1' })
  setTaskArtifacts(db, task.id, [{ path: 'C:/a.md', label: 'A', exists: true }])
  const result = actions.artifacts(10)
  assert.equal(result.ok, true)
  assert.equal(result.items[0].path, 'C:/a.md')
  assert.equal(result.items[0].taskId, task.id)
  db.close()
})
