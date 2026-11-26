import test from 'node:test'
import assert from 'node:assert/strict'
import { isCoordinator, isMainSession } from '../src/session-role.js'

// 0.36.0 多协调者：任务入口只认「当前会话 ∈ 协调者名单」；其余一切（含信号缺失）都必须 false（fail-closed）。
test('isCoordinator：名单成员为 true（主/副协调者一视同仁）', () => {
  assert.equal(isCoordinator('s-main', ['s-main']), true)
  assert.equal(isCoordinator('s-main', ['s-main', 's-two']), true)
  assert.equal(isCoordinator('s-two', ['s-main', 's-two']), true)
  assert.equal(isCoordinator('s-other', ['s-main', 's-two']), false)
  assert.equal(isCoordinator('s-main', ['s-two']), false)
})

test('isCoordinator：名单缺失/空/非数组、会话 id 缺失/空/非字符串 → 一律 false', () => {
  assert.equal(isCoordinator('s-main', []), false)
  assert.equal(isCoordinator('s-main', undefined), false)
  assert.equal(isCoordinator('s-main', null), false)
  assert.equal(isCoordinator('s-main', 's-main'), false, '字符串名单不算名单')
  assert.equal(isCoordinator(undefined, ['s-main']), false)
  assert.equal(isCoordinator('', ['s-main']), false)
  assert.equal(isCoordinator(null, ['s-main']), false)
  assert.equal(isCoordinator(42, [42]), false)
  assert.equal(isCoordinator({ id: 's-main' }, ['s-main']), false)
  // 名单里的脏项不参与比较，但也不能把整张名单判死
  assert.equal(isCoordinator('s-main', ['', null, 's-main']), true)
  assert.equal(isCoordinator('', ['', null]), false)
  // 不做 trim / 大小写归一：id 来自台账，必须逐字相等。
  assert.equal(isCoordinator(' s-main', ['s-main']), false)
  assert.equal(isCoordinator('S-MAIN', ['s-main']), false)
})

test('isMainSession：单值兼容别名行为不变（旧调用方不炸）', () => {
  assert.equal(isMainSession('s-main', 's-main'), true)
  assert.equal(isMainSession('s-main', 's-other'), false)
  assert.equal(isMainSession(undefined, 's-main'), false)
  assert.equal(isMainSession('', ''), false)
  assert.equal(isMainSession({ id: 's-main' }, 's-main'), false)
})
