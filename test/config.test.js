import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadConfig } from '../src/config.js'

test('loadConfig 填默认值', () => {
  const config = loadConfig({})
  assert.equal(config.staleMinutes, 30)
  assert.equal(config.stallRounds, 3)
  assert.equal(config.maxActive, undefined)
  assert.equal(config.mergeWindowMs, 5000)
  assert.equal(config.spawnProvider, 'spawn')
  assert.equal(config.coordinatorSession, undefined)
})

test('loadConfig 覆盖合法值、忽略非法值', () => {
  const config = loadConfig({ staleMinutes: 10, stallRounds: -1, mergeWindowMs: 0 })
  assert.equal(config.staleMinutes, 10)
  assert.equal(config.stallRounds, 3)
  assert.equal(config.mergeWindowMs, 5000)
})

test('loadConfig 无参调用返回默认值', () => {
  const config = loadConfig()
  assert.equal(config.staleMinutes, 30)
  assert.equal(config.stallRounds, 3)
  assert.equal(config.mergeWindowMs, 5000)
})

test('loadConfig 对 NaN / Infinity / null / 字符串 / 零一律回落', () => {
  const config = loadConfig({
    staleMinutes: Number.NaN,
    stallRounds: Infinity,
    mergeWindowMs: '30',
  })
  assert.equal(config.staleMinutes, 30)
  assert.equal(config.stallRounds, 3)
  assert.equal(config.mergeWindowMs, 5000)
})

test('coordinatorSession 只接受非空字符串', () => {
  assert.equal(loadConfig({ coordinatorSession: 's-1' }).coordinatorSession, 's-1')
  assert.equal(loadConfig({ coordinatorSession: '' }).coordinatorSession, undefined)
  assert.equal(loadConfig({ coordinatorSession: 42 }).coordinatorSession, undefined)
})

test('spawnProvider 可覆盖，空值/非字符串回落 spawn', () => {
  assert.equal(loadConfig({ spawnProvider: 'fork' }).spawnProvider, 'fork')
  assert.equal(loadConfig({ spawnProvider: '' }).spawnProvider, 'spawn')
  assert.equal(loadConfig({ spawnProvider: 42 }).spawnProvider, 'spawn')
})

test('backend 默认 subagent，仅 team 是合法回退', () => {
  assert.equal(loadConfig({}).backend, 'subagent')
  assert.equal(loadConfig({ backend: 'team' }).backend, 'team')
  assert.equal(loadConfig({ backend: 'nope' }).backend, 'subagent')
})

test('maxQueue 默认 50，非法回落；autoResumeQueue 默认开', () => {
  assert.equal(loadConfig({}).maxQueue, 50)
  assert.equal(loadConfig({ maxQueue: 3 }).maxQueue, 3)
  assert.equal(loadConfig({ maxQueue: 0 }).maxQueue, 50)
  assert.equal(loadConfig({ maxQueue: 'x' }).maxQueue, 50)
  assert.equal(loadConfig({}).autoResumeQueue, true)
  assert.equal(loadConfig({ autoResumeQueue: false }).autoResumeQueue, false)
})

test('不泄漏未声明的原始键', () => {
  const config = loadConfig({ foo: 1, coordinatorSession: 's-1' })
  assert.equal('foo' in config, false)
})


test('cordis.patch.yml 注册协调者与 worker 两个预设行', () => {
  const source = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(source, /dsh-orchestrator-coordinator/)
  assert.match(source, /dsh-orchestrator-worker/)
  assert.match(source, /dsh-orchestrator\/preset-tools/)
  assert.match(source, /'@deepseek-ai\/dsh-tool-present'/)
  assert.doesNotMatch(source, /dsh-present/)
  assert.match(source, /isolate:\s*\n\s+compaction: true/)
  assert.equal((source.match(/compaction: true/g) ?? []).length, 2)
  assert.equal((source.match(/id: tool-result-pruner/g) ?? []).length, 2)
  assert.match(source, /tool-jobs/)
  assert.match(source, /prefix:/)
})

test('package.json 导出 preset-tools', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.exports['./preset-tools'], './preset-tools.js')
  assert.ok(pkg.files.includes('preset-tools.js'))
})
