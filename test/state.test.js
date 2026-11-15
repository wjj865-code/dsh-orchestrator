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
  // 两段式终态：交付 → 待确认 → 确认/追问/停止。
  assert.equal(canTransition('running', 'delivered'), true)
  assert.equal(canTransition('delivered', 'running'), true)
  assert.equal(canTransition('delivered', 'done'), true)
  assert.equal(canTransition('delivered', 'cancelled'), true)
  assert.equal(canTransition('delivered', 'orphaned'), true)
})

test('非法迁移', () => {
  assert.equal(canTransition('done', 'running'), false)
  assert.equal(canTransition('cancelled', 'pending'), false)
  assert.equal(canTransition('pending', 'done'), false)
  assert.equal(canTransition('running', 'pending'), false)
  // delivered 没有「回待派发/回失败」的边：交付结果还在，只能确认、追问、停止或标丢失。
  assert.equal(canTransition('delivered', 'pending'), false)
  assert.equal(canTransition('delivered', 'waiting_user'), false)
  assert.equal(canTransition('delivered', 'failed'), false)
  assert.equal(canTransition('delivered', 'delivered'), false)
})

test('nextStatus 返回新状态或抛错', () => {
  assert.equal(nextStatus('running', 'done'), 'done')
  assert.equal(nextStatus('running', 'delivered'), 'delivered')
  assert.throws(() => nextStatus('done', 'running'), /不允许/)
})

test('状态集合完整', () => {
  assert.deepEqual([...STATUSES].sort(), [
    'cancelled', 'delivered', 'done', 'failed', 'orphaned', 'pending', 'running', 'waiting_auth', 'waiting_dep', 'waiting_user',
  ])
})

test('10×10 全迁移矩阵只放行设计允许的边', () => {
  const allowed = new Set([
    'waiting_dep→pending', 'waiting_dep→failed', 'waiting_dep→cancelled',
    'pending→running', 'pending→failed', 'pending→cancelled',
    'running→waiting_user', 'running→waiting_auth', 'running→delivered', 'running→done',
    'running→failed', 'running→cancelled', 'running→orphaned',
    'waiting_user→running', 'waiting_user→cancelled', 'waiting_user→failed', 'waiting_user→orphaned',
    'waiting_auth→running', 'waiting_auth→cancelled', 'waiting_auth→failed', 'waiting_auth→orphaned',
    'delivered→running', 'delivered→done', 'delivered→cancelled', 'delivered→orphaned',
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
