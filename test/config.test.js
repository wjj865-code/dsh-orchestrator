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
  assert.equal(config.memoryInject, true)
  assert.equal(config.memoryLimit, 3)
  assert.equal(config.snapshotRetentionDays, 7)
})

test('记忆/快照配置合法覆盖，非法值回落', () => {
  const config = loadConfig({ memoryInject: false, memoryLimit: 7, snapshotRetentionDays: 3 })
  assert.equal(config.memoryInject, false)
  assert.equal(config.memoryLimit, 7)
  assert.equal(config.snapshotRetentionDays, 3)
  const bad = loadConfig({ memoryLimit: 0, snapshotRetentionDays: Number.NaN })
  assert.equal(bad.memoryLimit, 3)
  assert.equal(bad.snapshotRetentionDays, 7)
  assert.equal(loadConfig({ memoryInject: 'no' }).memoryInject, true)
  assert.equal(loadConfig({ memoryInject: true }).memoryInject, true)
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
  assert.match(source, /@wjj865-code\/dsh-orchestrator\/preset-tools/)
  for (const tool of ['task_retry', 'history_search', 'project_context', 'memory_note']) {
    assert.match(source, new RegExp(`- ${tool}`), `协调者 allow 名单应包含 ${tool}`)
  }
  assert.match(source, /'@deepseek-ai\/dsh-tool-present'/)
  assert.doesNotMatch(source, /dsh-present/)
  assert.match(source, /isolate:\s*\n\s+compaction: true/)
  assert.equal((source.match(/compaction: true/g) ?? []).length, 2)
  assert.equal((source.match(/id: tool-result-pruner/g) ?? []).length, 2)
  assert.match(source, /tool-jobs/)
  assert.match(source, /prefix:/)
  assert.doesNotMatch(source, /createRequire\(baseUrl\)/, 'bundle 在磁盘求值会 MODULE_NOT_FOUND')
})

test('package.json 导出 preset-tools', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.name, '@wjj865-code/dsh-orchestrator')
  assert.equal(pkg.private, undefined)
  assert.equal(pkg.publishConfig.access, 'public')
  assert.equal(pkg.exports['./preset-tools'], './preset-tools.js')
  assert.ok(pkg.files.includes('preset-tools.js'))
})
