import test from 'node:test'
import assert from 'node:assert/strict'
import { canTransition, nextStatus, STATUSES } from '../src/state.js'

test('合法迁移', () => {
  assert.equal(canTransition('pending', 'running'), true)
  assert.equal(canTransition('running', 'waiting_auth'), true)
  assert.equal(canTransition('waiting_auth', 'running'), true)
  assert.equal(canTransition('running', 'done'), true)
  assert.equal(canTransition('running', 'failed'), true)
  assert.equal(canTransition('pending', 'cancelled'), true)
})

test('非法迁移', () => {
  assert.equal(canTransition('done', 'running'), false)
  assert.equal(canTransition('cancelled', 'pending'), false)
  assert.equal(canTransition('pending', 'done'), false)
  assert.equal(canTransition('running', 'pending'), false)
})

test('nextStatus 返回新状态或抛错', () => {
  assert.equal(nextStatus('running', 'done'), 'done')
  assert.throws(() => nextStatus('done', 'running'), /不允许/)
})

test('状态集合完整', () => {
  assert.deepEqual([...STATUSES].sort(), ['cancelled', 'done', 'failed', 'orphaned', 'pending', 'running', 'waiting_auth', 'waiting_dep', 'waiting_user'])
})

test('9×9 全迁移矩阵只放行设计允许的边', () => {
  const allowed = new Set([
    'waiting_dep→pending', 'waiting_dep→failed', 'waiting_dep→cancelled',
    'pending→running', 'pending→failed', 'pending→cancelled',
    'running→waiting_user', 'running→waiting_auth', 'running→done', 'running→failed', 'running→cancelled', 'running→orphaned',
    'waiting_user→running', 'waiting_user→cancelled', 'waiting_user→failed', 'waiting_user→orphaned',
    'waiting_auth→running', 'waiting_auth→cancelled', 'waiting_auth→failed', 'waiting_auth→orphaned',
    'failed→running', 'failed→cancelled',
    'orphaned→pending', 'orphaned→cancelled',
  ])
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      assert.equal(canTransition(from, to), allowed.has(`${from}→${to}`), `${from} → ${to}`)
    }
  }
})

test('未知状态返回 false 不抛错', () => {
  assert.equal(canTransition('x', 'running'), false)
  assert.equal(canTransition('running', 'x'), false)
  assert.equal(canTransition(undefined, 'running'), false)
})

test('终态没有出边', () => {
  for (const to of STATUSES) {
    assert.equal(canTransition('done', to), false)
    assert.equal(canTransition('cancelled', to), false)
  }
})
