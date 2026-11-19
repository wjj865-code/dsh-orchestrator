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

test('配置面总数 35（P1-A 收缩后）：loadConfig 不泄漏未声明的键', () => {
  const config = loadConfig({})
  assert.equal(Object.keys(config).length, 35, `实际 ${Object.keys(config).length} 个键：${Object.keys(config).join(',')}`)
  assert.equal('backend' in config, false, 'backend 键已删除（team 后端先于它删除）')
  for (const key of ['rotateAfterTasks', 'rotateAfterSessions', 'rotateAfterContextTokens', 'rotateAfterDiskMiB', 'rotateCheckIntervalHours']) {
    assert.equal(key in config, false, `${key} 已删除`)
  }
})

test('主会话轮换：7 个键默认值（P1-A：总开关默认 off + 两个因子 + 三个保护 + 归档）', () => {
  const config = loadConfig({})
  // 默认 off：升级后不再自动换主会话（要换必须显式配 auto）。
  assert.equal(config.mainRotation, 'off')
  assert.equal(config.rotateAfterMainLogMiB, 6)
  assert.equal(config.rotateAfterDays, 10)
  assert.equal(config.rotateCooldownHours, 48)
  assert.equal(config.rotateMinAgeHours, 12)
  assert.equal(config.rotateIdleMinutes, 10)
  assert.equal(config.rotateArchiveOld, true)
})

test('主会话轮换：合法覆盖生效，总开关只认 auto/off', () => {
  const config = loadConfig({
    mainRotation: 'auto',
    rotateAfterMainLogMiB: 3,
    rotateAfterDays: 7,
    rotateCooldownHours: 24,
    rotateMinAgeHours: 6,
    rotateIdleMinutes: 5,
    rotateArchiveOld: false,
  })
  assert.equal(config.mainRotation, 'auto')
  assert.equal(config.rotateAfterMainLogMiB, 3)
  assert.equal(config.rotateAfterDays, 7)
  assert.equal(config.rotateCooldownHours, 24)
  assert.equal(config.rotateMinAgeHours, 6)
  assert.equal(config.rotateIdleMinutes, 5)
  assert.equal(config.rotateArchiveOld, false)
  // 拼错/其它值回落 off：默认必须安全，不能因为写错就自动换掉协调者。
  for (const bad of ['OFF', 'manual', 'on', 0, true, null]) {
    assert.equal(loadConfig({ mainRotation: bad }).mainRotation, 'off', String(bad))
  }
  // 归档开关与其它布尔项同口径：只有显式 false 才关。
  assert.equal(loadConfig({ rotateArchiveOld: 'no' }).rotateArchiveOld, true)
  assert.equal(loadConfig({ rotateArchiveOld: 0 }).rotateArchiveOld, true)
})

test('主会话轮换：越界夹到边界，非数字/非正数回落默认', () => {
  const clamped = loadConfig({
    rotateAfterMainLogMiB: 1e9,
    rotateAfterDays: 999,
    rotateCooldownHours: 0.5,
    rotateMinAgeHours: 1e6,
    rotateIdleMinutes: 99999,
  })
  assert.equal(clamped.rotateAfterMainLogMiB, 4096)
  assert.equal(clamped.rotateAfterDays, 365)
  assert.equal(clamped.rotateCooldownHours, 1)
  assert.equal(clamped.rotateMinAgeHours, 720)
  assert.equal(clamped.rotateIdleMinutes, 1440)

  const bad = loadConfig({
    rotateAfterMainLogMiB: '6',
    rotateAfterDays: -10,
    rotateCooldownHours: undefined,
    rotateMinAgeHours: 0.5,
    rotateIdleMinutes: 1e9,
  })
  // 非正数/非数字一律回落默认（0.5 是正数，会夹到区间下界而不是回落）。
  assert.equal(bad.rotateAfterMainLogMiB, 6)
  assert.equal(bad.rotateAfterDays, 10)
  assert.equal(bad.rotateCooldownHours, 48)
  assert.equal(bad.rotateMinAgeHours, 1)
  assert.equal(bad.rotateIdleMinutes, 1440)
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
  for (const tool of ['task_retry', 'task_inbox', 'history_search', 'project_context', 'memory_note', 'read_workspace']) {
    assert.match(source, new RegExp(`- ${tool}`), `协调者 allow 名单应包含 ${tool}`)
  }
  // 受控读只能走 read_workspace：原生 read/glob 不挂行、也不进 allow（它们没有读路径白名单）。
  assert.doesNotMatch(source, /^\s+- read\s*$/m, '协调者 allow 不得包含原生 read')
  assert.doesNotMatch(source, /^\s+- glob\s*$/m, '协调者 allow 不得包含原生 glob')
  assert.match(source, /'@deepseek-ai\/dsh-tool-present'/)
  assert.equal((source.match(/'@deepseek-ai\/dsh-tool-present'/g) ?? []).length, 2, '协调者与 worker 预设各挂一行 present')
  assert.doesNotMatch(source, /dsh-present/)
  assert.match(source, /isolate:\s*\n\s+compaction: true/)
  assert.equal((source.match(/compaction: true/g) ?? []).length, 2)
  assert.equal((source.match(/id: tool-result-pruner/g) ?? []).length, 2)
  assert.match(source, /tool-jobs/)
  assert.match(source, /prefix:/)
  assert.doesNotMatch(source, /createRequire\(baseUrl\)/, 'bundle 在磁盘求值会 MODULE_NOT_FOUND')
})

/** 从补丁文本里抠出某个预设（按 config.id）的 plugins 块，返回行对象与原文。 */
function presetPlugins(source, presetId) {
  const lines = source.split(/\r?\n/)
  const idRe = new RegExp(`^(\\s*)id:\\s*${presetId}\\s*$`)
  const start = lines.findIndex(line => idRe.test(line))
  assert.ok(start >= 0, `cordis.patch.yml 里应有 config.id: ${presetId}`)
  const configIndent = /^(\s*)/.exec(lines[start])[1].length
  const keyRe = new RegExp(`^${' '.repeat(configIndent)}plugins:\\s*$`)
  const keyIndex = lines.findIndex((line, index) => index > start && keyRe.test(line))
  assert.ok(keyIndex >= 0, `${presetId} 应有 plugins: 键`)
  const body = []
  for (let index = keyIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() !== '' && line.length - line.trimStart().length <= configIndent) break
    body.push(line)
  }
  // 只认 `- id:` 开头的行；组内子行（含 `- id:` 的子分组）随父行的缩进保留。
  const rowIndent = Math.min(...body.filter(line => line.trim() !== '').map(line => line.length - line.trimStart().length))
  const rows = []
  for (const line of body) {
    const rowMatch = new RegExp(`^${' '.repeat(rowIndent)}- id:\\s*(\\S+)\\s*$`).exec(line)
    if (rowMatch !== null) rows.push({ id: rowMatch[1], lines: [line] })
    else if (rows.length > 0) rows[rows.length - 1].lines.push(line)
  }
  return { rows, text: body.join('\n') }
}

test('worker 预设挂 tool-goal：子会话才有 get_goal 可读自己的任务目标', () => {
  const source = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const worker = presetPlugins(source, 'dsh-orchestrator-worker')
  const goalRows = worker.rows.filter(row => row.id === 'tool-goal')
  assert.equal(goalRows.length, 1, 'worker 预设应恰好有一行 tool-goal（host plane 的 tool-goal 被 web-app 关掉了）')
  const rowText = goalRows[0].lines.join('\n')
  assert.match(rowText, /name:\s*'@deepseek-ai\/dsh-tool-goal'/)
  // 纯行：goal 工具没有配置项，也不按平台条件禁用（read-only 任务是沙箱层面的事）。
  assert.doesNotMatch(rowText, /^\s+(config|disabled):/m)
  // 只挂一次：同一个预设里重复行会让 loader 报重复 id。
  assert.equal((source.match(/id: tool-goal/g) ?? []).length, 1, '整份补丁只应出现一行 tool-goal')
  // 协调者只做协调（preset-tools 白名单），不给自己挂 goal 工具。
  const coordinator = presetPlugins(source, 'dsh-orchestrator-coordinator')
  assert.equal(coordinator.rows.some(row => row.id === 'tool-goal'), false)
})

test('worker 预设不做工具收窄：orchestrator 的全局工具（task_report/task_detail）子会话直接可见', () => {
  const source = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const worker = presetPlugins(source, 'dsh-orchestrator-worker')
  // 挂载链：index.js 的 createTools(...).map(tool => ctx.tools.register(tool)) 把 task_detail 注册成
  // host plane 的**全局**工具；worker 预设不挂 preset-tools，所以不做 allow/deny 收窄，子会话直接继承。
  assert.equal(worker.rows.some(row => row.id === 'preset-tools'), false,
    'worker 预设挂 preset-tools 会把 task_report/task_detail 一起遮掉')
  assert.match(worker.text, /task_report \/ task_detail/, 'worker 预设应保留全局工具挂载链的说明')
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(index, /createTools\(\{[\s\S]{0,800}?\.map\(tool => ctx\.tools\.register\(tool\)\)/,
    'task_detail 与其它 task_* 一样走全局注册')
})

test('协调者预设挂 present 交付工具：主会话可交付子会话产物', () => {
  const source = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const coordinator = presetPlugins(source, 'dsh-orchestrator-coordinator')
  const presentRows = coordinator.rows.filter(row => row.id === 'present')
  assert.equal(presentRows.length, 1, '协调者预设应恰好有一行 present（避免 loader 重复 id）')
  const rowText = presentRows[0].lines.join('\n')
  assert.match(rowText, /name:\s*'@deepseek-ai\/dsh-tool-present'/, '要用标准包名 @deepseek-ai/dsh-tool-present')
  // 纯行：present 默认 maxFiles=8，不需要配置项，也不按平台禁用。
  assert.doesNotMatch(rowText, /^\s+(config|disabled):/m)
  // present 在 web/desktop 是预设自有工具（own），allow 里列一份作为跨 profile 保底：
  // allow 只用于过滤 deny，不交给 restrict，所以写 own 名字不会 unknown global tool。
  assert.match(coordinator.text, /^\s+- present\s*$/m, '协调者 allow 名单应包含 present 保底')
  // 协调者与 worker 各一行：整份补丁恰好 2 行。
  assert.equal((source.match(/id: present/g) ?? []).length, 2, '整份补丁应有协调者、worker 两行 present')
})

test('原生自动化只挂协调者预设，四工具显式保留', () => {
  const source = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const coordinator = presetPlugins(source, 'dsh-orchestrator-coordinator')
  const worker = presetPlugins(source, 'dsh-orchestrator-worker')
  const rows = coordinator.rows.filter(row => row.id === 'tool-schedule')
  assert.equal(rows.length, 1)
  assert.match(rows[0].lines.join('\n'), /name:\s*'@deepseek-ai\/dsh-tool-schedule'/)
  assert.doesNotMatch(rows[0].lines.join('\n'), /^\s+(config|disabled):/m)
  assert.equal(worker.rows.some(row => row.id === 'tool-schedule'), false)
  assert.equal((source.match(/name: '@deepseek-ai\/dsh-tool-schedule'/g) ?? []).length, 1)
  for (const name of ['schedule_create', 'schedule_list', 'schedule_view', 'schedule_edit']) {
    assert.match(coordinator.text, new RegExp(`^\\s+- ${name}\\s*$`, 'm'))
    assert.doesNotMatch(worker.text, new RegExp(`^\\s+- ${name}\\s*$`, 'm'))
  }
})

test('package.json 导出 preset-tools', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.name, '@wjj865-code/dsh-orchestrator')
  assert.equal(pkg.private, undefined)
  assert.equal(pkg.publishConfig.access, 'public')
  assert.equal(pkg.exports['./preset-tools'], './preset-tools.js')
  assert.ok(pkg.files.includes('preset-tools.js'))
  // P1-E：调试预设生成器已外移到开发仓库 tools/debug-preset/，不随 npm 包发货。
  assert.ok(pkg.files.includes('scripts/'))
  assert.equal(pkg.files.includes('docs/DEBUG-PRESET.md'), false)
  assert.equal(pkg.scripts['preset:debug'], undefined)
  assert.equal(pkg.scripts['preset:debug:check'], undefined)
  assert.equal(pkg.files.some(entry => entry.startsWith('tools/')), false, 'files 白名单不能把 tools/ 带进包')
  for (const file of [
    'tools/debug-preset/cli.mjs',
    'tools/debug-preset/src/debug-preset.js',
    'tools/debug-preset/README.md',
    'tools/debug-preset/package.json',
    'tools/debug-preset/test/debug-preset.test.js',
  ]) {
    assert.equal(existsSync(new URL(`../${file}`, import.meta.url)), true, `外移工具缺文件：${file}`)
  }
  const toolsPkg = JSON.parse(readFileSync(new URL('../tools/debug-preset/package.json', import.meta.url), 'utf8'))
  assert.equal(toolsPkg.private, true)
  assert.equal(toolsPkg.scripts.generate, 'node cli.mjs')
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  assert.match(readme, /`workerPreset`/)
  assert.match(readme, /tools\/debug-preset\/README\.md/, 'README 必须给出调试预设的新位置')
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
