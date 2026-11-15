import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { loadConfig } from '../src/config.js'

test('loadConfig 填默认值', () => {
  const config = loadConfig({})
  assert.equal(config.staleMinutes, 30)
  assert.equal(config.stallRounds, 3)
  assert.equal(config.maxActive, undefined)
  assert.equal(config.mergeWindowMs, 5000)
  assert.equal(config.spawnProvider, 'spawn')
  assert.equal(config.workerPreset, 'dsh-orchestrator-worker')
  assert.equal(config.coordinatorSession, undefined)
  assert.equal(config.memoryInject, true)
  assert.equal(config.memoryLimit, 3)
  assert.equal(config.snapshotRetentionDays, 7)
  assert.equal(config.digestAt, '')
  assert.equal(config.digestTimeZone, '')
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

test('digestAt 只接受 HH:MM，非法值关闭；时区可空', () => {
  assert.equal(loadConfig({ digestAt: '09:30' }).digestAt, '09:30')
  assert.equal(loadConfig({ digestAt: '24:00' }).digestAt, '')
  assert.equal(loadConfig({ digestAt: '9:30' }).digestAt, '')
  assert.equal(loadConfig({ digestAt: 930 }).digestAt, '')
  assert.equal(loadConfig({ digestAt: '09:30', digestTimeZone: 'Asia/Shanghai' }).digestTimeZone, 'Asia/Shanghai')
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

test('workerPreset 默认 worker 预设；合法覆盖去空格；非法 id 回落', () => {
  assert.equal(loadConfig({}).workerPreset, 'dsh-orchestrator-worker')
  assert.equal(loadConfig({ workerPreset: 'orch-debug' }).workerPreset, 'orch-debug')
  assert.equal(loadConfig({ workerPreset: '  orch-debug  ' }).workerPreset, 'orch-debug')
  assert.equal(loadConfig({ workerPreset: '' }).workerPreset, 'dsh-orchestrator-worker')
  assert.equal(loadConfig({ workerPreset: 42 }).workerPreset, 'dsh-orchestrator-worker')
  // 平台要求 preset id 是小写字母/数字/连字符：大写、空格、下划线、前缀连字符都不接受。
  assert.equal(loadConfig({ workerPreset: 'Orch-Debug' }).workerPreset, 'dsh-orchestrator-worker')
  assert.equal(loadConfig({ workerPreset: 'orch debug' }).workerPreset, 'dsh-orchestrator-worker')
  assert.equal(loadConfig({ workerPreset: 'orch_debug' }).workerPreset, 'dsh-orchestrator-worker')
  assert.equal(loadConfig({ workerPreset: '-orch' }).workerPreset, 'dsh-orchestrator-worker')
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

test('空闲看门狗：默认开启、巡检 5 分钟、空闲阈值 15 分钟，均可配', () => {
  const config = loadConfig({})
  assert.equal(config.idleWatchdog, true)
  assert.equal(config.watchdogIntervalMinutes, 5)
  assert.equal(config.watchdogIdleMinutes, 15)
  const custom = loadConfig({ idleWatchdog: false, watchdogIntervalMinutes: 2, watchdogIdleMinutes: 45 })
  assert.equal(custom.idleWatchdog, false)
  assert.equal(custom.watchdogIntervalMinutes, 2)
  assert.equal(custom.watchdogIdleMinutes, 45)
  // 只有显式 false 才关；不传/其它值保持开。
  assert.equal(loadConfig({ idleWatchdog: 'no' }).idleWatchdog, true)
  assert.equal(loadConfig({ idleWatchdog: true }).idleWatchdog, true)
})

test('空闲看门狗：非法分钟数回落默认，超界夹到 1–1440', () => {
  const bad = loadConfig({ watchdogIntervalMinutes: 0, watchdogIdleMinutes: Number.NaN })
  assert.equal(bad.watchdogIntervalMinutes, 5)
  assert.equal(bad.watchdogIdleMinutes, 15)
  assert.equal(loadConfig({ watchdogIntervalMinutes: '5' }).watchdogIntervalMinutes, 5)
  const clamped = loadConfig({ watchdogIntervalMinutes: 99999, watchdogIdleMinutes: 0.5 })
  assert.equal(clamped.watchdogIntervalMinutes, 1440)
  assert.equal(clamped.watchdogIdleMinutes, 1)
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
  for (const tool of ['task_retry', 'task_inbox', 'history_search', 'project_context', 'memory_note']) {
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
  // D1：调试预设生成脚本与文档随包发布。
  assert.ok(pkg.files.includes('scripts/'))
  assert.ok(pkg.files.includes('docs/DEBUG-PRESET.md'))
  assert.equal(pkg.scripts['preset:debug'], 'node scripts/orch-debug-preset.mjs')
  assert.match(readFileSync(new URL('../README.md', import.meta.url), 'utf8'), /`workerPreset`/)
})

test('插件展示元数据：locale/icon/docs 都在文件与 exports 里', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.exports['./icon'], './icon.svg')
  assert.equal(pkg.exports['./locale/*.json'], './locale/*.json')
  for (const file of ['icon.svg', 'locale/zh.json', 'locale/en.json', 'docs/DETAIL.md', 'docs/ARCHITECTURE.md', 'docs/LIMITATIONS.md']) {
    assert.equal(existsSync(new URL(`../${file}`, import.meta.url)), true, file)
  }
  assert.ok(pkg.files.includes('locale/*.json'))
  assert.ok(pkg.files.includes('docs/DETAIL.md'))
  assert.ok(pkg.files.includes('docs/ARCHITECTURE.md'))
  assert.ok(pkg.files.includes('docs/LIMITATIONS.md'))
  assert.ok(pkg.files.includes('icon.svg'))
  const zh = JSON.parse(readFileSync(new URL('../locale/zh.json', import.meta.url), 'utf8'))
  assert.equal(typeof zh.meta.title, 'string')
  assert.equal(typeof zh.meta.description, 'string')
  assert.equal(zh.meta.detail, 'docs/DETAIL.md')
})
