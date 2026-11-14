import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequestDedupe } from '../src/request-dedupe.js'

test('成功结果缓存：同 key 第二次不再执行', async () => {
  const dedupe = createRequestDedupe()
  let calls = 0
  const execute = async () => { calls += 1; return { ok: true, taskId: 't-1' } }
  const first = await dedupe.run('t-1', 'req-1', execute)
  const second = await dedupe.run('t-1', 'req-1', execute)
  assert.equal(first.duplicate, false)
  assert.equal(second.duplicate, true)
  assert.deepEqual(second.result, { ok: true, taskId: 't-1' })
  assert.equal(calls, 1)
})

test('失败结果不缓存：同 key 允许重试', async () => {
  const dedupe = createRequestDedupe()
  let calls = 0
  const execute = async () => { calls += 1; return { ok: false, code: 'MESSAGE_DELIVERY_FAILED' } }
  await dedupe.run('t-1', 'req-1', execute)
  const second = await dedupe.run('t-1', 'req-1', execute)
  assert.equal(second.duplicate, false)
  assert.equal(calls, 2)
})

test('并发同 key 合并成一次执行', async () => {
  const dedupe = createRequestDedupe()
  let calls = 0
  let release
  const gate = new Promise(resolve => { release = resolve })
  const execute = async () => { calls += 1; await gate; return { ok: true, taskId: 't-1' } }
  const first = dedupe.run('t-1', 'req-1', execute)
  const second = dedupe.run('t-1', 'req-1', execute)
  release()
  const [a, b] = await Promise.all([first, second])
  assert.equal(calls, 1)
  assert.equal(a.duplicate, false)
  assert.equal(b.duplicate, true)
  assert.deepEqual(a.result, b.result)
})

test('执行抛错时不留下缓存/在途状态', async () => {
  const dedupe = createRequestDedupe()
  let calls = 0
  const execute = async () => { calls += 1; throw new Error('boom') }
  await assert.rejects(() => dedupe.run('t-1', 'req-1', execute), /boom/)
  assert.equal(dedupe.inflightSize(), 0)
  await assert.rejects(() => dedupe.run('t-1', 'req-1', execute), /boom/)
  assert.equal(calls, 2)
})

test('LRU 上限：超出 max 的最老结果被淘汰', async () => {
  const dedupe = createRequestDedupe({ max: 2 })
  let calls = 0
  const execute = async id => { calls += 1; return { ok: true, taskId: id } }
  await dedupe.run('t-1', 'a', () => execute('a'))
  await dedupe.run('t-1', 'b', () => execute('b'))
  await dedupe.run('t-1', 'c', () => execute('c'))
  assert.equal(dedupe.size(), 2)
  const again = await dedupe.run('t-1', 'a', () => execute('a'))
  assert.equal(again.duplicate, false)
  assert.equal(calls, 4)
})

test('key 隔离：taskId 或 requestId 不同都不算重复', async () => {
  const dedupe = createRequestDedupe()
  let calls = 0
  const execute = async () => { calls += 1; return { ok: true } }
  await dedupe.run('t-1', 'req-1', execute)
  await dedupe.run('t-2', 'req-1', execute)
  await dedupe.run('t-1', 'req-2', execute)
  assert.equal(calls, 3)
})
