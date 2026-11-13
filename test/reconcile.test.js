import test from 'node:test'
import assert from 'node:assert/strict'
import { openLedger, createTask, getTask, transition } from '../src/ledger.js'
import { reconcileOrphans } from '../src/reconcile.js'
import { tempDir, sampleBrief } from './helpers.js'

const setup = async () => {
  const db = await openLedger(tempDir())
  const running = (title, sessionId) => {
    const task = createTask(db, { brief: sampleBrief({ title }), coordinatorSession: 's-1' })
    transition(db, task.id, 'running', { sessionId, target: sessionId })
    return task
  }
  return { db, running }
}

test('catalog 里查不到 → orphaned；查得到 → 保持 running；waiting 同样对账', async () => {
  const { db, running } = await setup()
  const alive = running('活着', 'c-1')
  const gone = running('丢了', 'c-2')
  const waiting = running('等用户', 'c-3')
  transition(db, waiting.id, 'waiting_user')
  const dispatcher = { catalog: async () => [{ id: 'c-1', mode: 'continuable', label: 'x', activity: 'inactive' }] }
  const result = await reconcileOrphans({ db, dispatcher, coordinatorSessionId: 's-1' })
  assert.deepEqual(new Set(result.ids), new Set([gone.id, waiting.id]))
  assert.equal(getTask(db, alive.id).status, 'running')
  assert.equal(getTask(db, gone.id).status, 'orphaned')
  assert.equal(getTask(db, waiting.id).status, 'orphaned')
  db.close()
})

test('catalog 读取失败：只 warn，不把 running 判死', async () => {
  const { db, running } = await setup()
  const task = running('任务', 'c-1')
  const warnings = []
  const dispatcher = { catalog: async () => { throw new Error('catalog 挂了') } }
  const result = await reconcileOrphans({ db, dispatcher, coordinatorSessionId: 's-1', onWarn: message => warnings.push(message) })
  assert.equal(result.count, 0)
  assert.equal(result.skipped, 'no-catalog')
  assert.match(warnings[0], /目录读取失败/)
  assert.equal(getTask(db, task.id).status, 'running')
  db.close()
})

test('未绑定协调者：跳过对账', async () => {
  const { db, running } = await setup()
  const task = running('任务', 'c-1')
  const dispatcher = { catalog: async () => [] }
  const result = await reconcileOrphans({ db, dispatcher, coordinatorSessionId: undefined })
  assert.equal(result.skipped, 'no-coordinator')
  assert.equal(getTask(db, task.id).status, 'running')
  db.close()
})

test('没有活跃任务时不读 catalog', async () => {
  const { db } = await setup()
  let called = false
  const result = await reconcileOrphans({
    db,
    dispatcher: { catalog: async () => { called = true; return [] } },
    coordinatorSessionId: 's-1',
  })
  assert.equal(result.skipped, 'nothing-active')
  assert.equal(called, false)
  db.close()
})
