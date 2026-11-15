import test from 'node:test'
import assert from 'node:assert/strict'
import { isMainSession } from '../src/session-role.js'

// 任务入口只认「当前会话 === 台账主会话」；其余一切（含信号缺失）都必须 false（fail-closed）。
test('isMainSession：当前会话等于主会话才为 true', () => {
  assert.equal(isMainSession('s-main', 's-main'), true)
  assert.equal(isMainSession('s-main', 's-other'), false)
  assert.equal(isMainSession('s-other', 's-main'), false)
})

test('isMainSession：任一侧缺失/空串/非字符串都按 false 降级（入口默认隐藏）', () => {
  assert.equal(isMainSession(undefined, 's-main'), false)
  assert.equal(isMainSession('s-main', undefined), false)
  assert.equal(isMainSession(undefined, undefined), false)
  assert.equal(isMainSession('', ''), false)
  assert.equal(isMainSession('', 's-main'), false)
  assert.equal(isMainSession('s-main', ''), false)
  assert.equal(isMainSession(null, null), false)
  assert.equal(isMainSession(123, 123), false)
  assert.equal(isMainSession({ id: 's-main' }, 's-main'), false)
  // 不做 trim / 大小写归一：id 来自台账，必须逐字相等。
  assert.equal(isMainSession(' s-main', 's-main'), false)
  assert.equal(isMainSession('S-MAIN', 's-main'), false)
})
