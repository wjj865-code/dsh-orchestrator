import test from 'node:test'
import assert from 'node:assert/strict'
import { openLedger, createTask, getTask, listTasks, transition } from '../src/ledger.js'
import { createQueue } from '../src/queue.js'
import { tempDir, sampleBrief } from './helpers.js'

function fakeDispatcher({ limit = Infinity, fail = false, failTimes = 0 } = {}) {
  let alive = 0
  let failures = 0
  const calls = []
  return {
    calls,
    slug: title => `slug-${title}`,
    spawn({ name, label, prompt, signal, taskId }) {
      calls.push({ name, label, prompt, signal, taskId })
      if (fail || failures < failTimes) {
        failures += 1
        throw new Error('spawn 挂了')
      }
      if (alive >= limit) {
        const error = new Error('subagent limit reached')
        error.code = 'ACTIVATION_LIMIT_REACHED'
        throw error
      }
      alive += 1
      return { id: `child-${alive}`, sessionId: `child-${alive}`, target: `child-${alive}`, name: label }
    },
    release(count = 1) { alive = Math.max(0, alive - count) },
    get alive() { return alive },
  }
}

const setup = async ({ limit = Infinity, retryDelaysMs = [0] } = {}) => {
  const db = await openLedger(tempDir())
  const dispatcher = fakeDispatcher({ limit })
  const queue = createQueue({ db, dispatcher, retryDelaysMs })
  return { db, dispatcher, queue }
}

test('load 后按创建顺序派发 pending', async () => {
  const { db, dispatcher, queue } = await setup()
  const first = createTask(db, { brief: sampleBrief({ title: '甲' }), coordinatorSession: 's-1' })
  const second = createTask(db, { brief: sampleBrief({ title: '乙' }), coordinatorSession: 's-1' })
  queue.load()
  await queue.pump()
  assert.equal(getTask(db, first.id).status, 'running')
  assert.equal(getTask(db, second.id).status, 'running')
  assert.deepEqual(dispatcher.calls.map(call => call.label), ['甲', '乙'])
  assert.equal(dispatcher.calls[0].name, 'slug-甲')
  assert.equal(dispatcher.calls[0].prompt.includes('【任务】甲'), true)
  db.close()
})

test('容量满：任务留 pending + queued_at；释放后补位并清标记', async () => {
  const { db, dispatcher, queue } = await setup({ limit: 1 })
  const first = createTask(db, { brief: sampleBrief({ title: '甲' }), coordinatorSession: 's-1' })
  const second = createTask(db, { brief: sampleBrief({ title: '乙' }), coordinatorSession: 's-1' })
  await queue.enqueueAndPump(first.id)
  const outcome = await queue.enqueueAndPump(second.id)
  assert.equal(getTask(db, first.id).status, 'running')
  assert.equal(outcome.task.status, 'pending')
  assert.notEqual(outcome.task.queued_at, null)
  assert.equal(outcome.position, 1)

  dispatcher.release()
  await queue.pump()
  const resumed = getTask(db, second.id)
  assert.equal(resumed.status, 'running')
  assert.equal(resumed.queued_at, null)
  db.close()
})

test('非容量错误：标 failed 并继续下一个', async () => {
  const { db } = await setup()
  const first = createTask(db, { brief: sampleBrief({ title: '甲' }), coordinatorSession: 's-1' })
  const second = createTask(db, { brief: sampleBrief({ title: '乙' }), coordinatorSession: 's-1' })
  const failedQueue = createQueue({ db, dispatcher: fakeDispatcher({ fail: true }), retryDelaysMs: [0] })
  failedQueue.enqueue(first.id)
  failedQueue.enqueue(second.id)
  await failedQueue.pump()
  assert.equal(getTask(db, first.id).status, 'failed')
  assert.match(getTask(db, first.id).error, /子会话创建失败/)
  assert.equal(getTask(db, second.id).status, 'failed')
  db.close()
})

test('stop 后队列中的任务不再派发', async () => {
  const { db, dispatcher, queue } = await setup()
  const task = createTask(db, { brief: sampleBrief({ title: '甲' }), coordinatorSession: 's-1' })
  queue.enqueue(task.id)
  queue.stop()
  await queue.pump()
  assert.equal(getTask(db, task.id).status, 'pending')
  assert.equal(dispatcher.calls.length, 0)
  db.close()
})

test('已非 pending 的队首会被丢弃，不重复派发', async () => {
  const { db, dispatcher, queue } = await setup()
  const task = createTask(db, { brief: sampleBrief({ title: '甲' }), coordinatorSession: 's-1' })
  transition(db, task.id, 'cancelled')
  queue.enqueue(task.id)
  await queue.pump()
  assert.equal(dispatcher.calls.length, 0)
  assert.equal(queue.size(), 0)
  db.close()
})
