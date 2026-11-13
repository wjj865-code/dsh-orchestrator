import test from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../src/config.js'

test('loadConfig 填默认值', () => {
  const config = loadConfig({})
  assert.equal(config.staleMinutes, 30)
  assert.equal(config.stallRounds, 3)
  assert.equal(config.maxActive, 8)
  assert.equal(config.mergeWindowMs, 5000)
  assert.equal(config.coordinatorSession, undefined)
})

test('loadConfig 覆盖合法值、忽略非法值', () => {
  const config = loadConfig({ staleMinutes: 10, stallRounds: -1, maxActive: 'x', mergeWindowMs: 0 })
  assert.equal(config.staleMinutes, 10)
  assert.equal(config.stallRounds, 3)
  assert.equal(config.maxActive, 8)
  assert.equal(config.mergeWindowMs, 5000)
})

test('loadConfig 无参调用返回默认值', () => {
  const config = loadConfig()
  assert.equal(config.staleMinutes, 30)
  assert.equal(config.stallRounds, 3)
  assert.equal(config.maxActive, 8)
  assert.equal(config.mergeWindowMs, 5000)
})

test('loadConfig 对 NaN / Infinity / null / 字符串 / 零一律回落', () => {
  const config = loadConfig({
    staleMinutes: Number.NaN,
    stallRounds: Infinity,
    maxActive: null,
    mergeWindowMs: '30',
  })
  assert.equal(config.staleMinutes, 30)
  assert.equal(config.stallRounds, 3)
  assert.equal(config.maxActive, 8)
  assert.equal(config.mergeWindowMs, 5000)
})

test('coordinatorSession 只接受非空字符串', () => {
  assert.equal(loadConfig({ coordinatorSession: 's-1' }).coordinatorSession, 's-1')
  assert.equal(loadConfig({ coordinatorSession: '' }).coordinatorSession, undefined)
  assert.equal(loadConfig({ coordinatorSession: 42 }).coordinatorSession, undefined)
})

test('不泄漏未声明的原始键', () => {
  const config = loadConfig({ foo: 1, coordinatorSession: 's-1' })
  assert.equal('foo' in config, false)
})
