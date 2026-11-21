import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { loadConfig } from '../src/config.js'

test('loadConfig 填默认值', () => {
  const config = loadConfig({})
  assert.equal(config.staleMinutes, 30)
  assert.equal(config.maxActive, undefined)
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
  const config = loadConfig({ staleMinutes: 10, memoryLimit: 0 })
  assert.equal(config.staleMinutes, 10)
  assert.equal(config.memoryLimit, 3)
})

test('loadConfig 无参调用返回默认值', () => {
  const config = loadConfig()
  assert.equal(config.staleMinutes, 30)
  assert.equal(config.memoryLimit, 3)
})

test('loadConfig 对 NaN / Infinity / null / 字符串 / 零一律回落', () => {
  const config = loadConfig({
    staleMinutes: Number.NaN,
    memoryLimit: Infinity,
    snapshotRetentionDays: '30',
  })
  assert.equal(config.staleMinutes, 30)
  assert.equal(config.memoryLimit, 3)
  assert.equal(config.snapshotRetentionDays, 7)
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

test('配置面总数 25（0.25.0：轮换 8 键删除、提醒阈值 1 键新增；0.32.0：能力包 3 键）：loadConfig 不泄漏未声明的键', () => {
  const config = loadConfig({})
  assert.equal(Object.keys(config).length, 25, `实际 ${Object.keys(config).length} 个键：${Object.keys(config).join(',')}`)
  assert.equal('backend' in config, false, 'backend 键已删除（team 后端先于它删除）')
  for (const key of [
    'rotateAfterTasks', 'rotateAfterSessions', 'rotateAfterContextTokens', 'rotateAfterDiskMiB',
    'mainRotation', 'rotateAfterMainLogMiB', 'rotateAfterDays', 'rotateCooldownHours',
    'rotateMinAgeHours', 'rotateIdleMinutes', 'rotateCheckIntervalHours', 'rotateArchiveOld',
  ]) {
    assert.equal(key in config, false, `${key} 已删除（轮换整套下线）`)
  }
  assert.equal(config.contextPressureThreshold, 0.4, '压力提醒阈值默认 0.4')
  // P2-2：自建续跑器删除 + 三个阈值固定成常量后，这 7 个键不再出现在配置面上。
  for (const key of ['keepAlive', 'keepAliveMode', 'keepAliveMaxRounds', 'keepAlivePrompt']) {
    assert.equal(key in config, false, `${key} 已删除（续跑改 task_create.goalRounds）`)
  }
  for (const key of ['mergeWindowMs', 'stallRounds', 'preferencesMaxItems']) {
    assert.equal(key in config, false, `${key} 已固定成常量`)
  }
})

test('上下文压力提醒阈值：默认 0.4、合法覆盖生效、越界夹边界、非数字回落', () => {
  assert.equal(loadConfig({}).contextPressureThreshold, 0.4)
  assert.equal(loadConfig({ contextPressureThreshold: 0.75 }).contextPressureThreshold, 0.75)
  // 越界夹到 0.1–0.95（它只是提醒阈值，和宿主压缩阈值无关）。
  assert.equal(loadConfig({ contextPressureThreshold: 2 }).contextPressureThreshold, 0.95)
  assert.equal(loadConfig({ contextPressureThreshold: 0.01 }).contextPressureThreshold, 0.1)
  for (const bad of ['0.5', 0, -1, Number.NaN, undefined, null, {}]) {
    assert.equal(loadConfig({ contextPressureThreshold: bad }).contextPressureThreshold, 0.4, JSON.stringify(bad))
  }
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
  const coordinator = presetPlugins(source, 'dsh-orchestrator-coordinator')
  // 0.26.0：协调者改为遮挡式（deny + keep），7 个全局任务工具在 keep 里正向声明「出生即可用」。
  for (const tool of ['task_create', 'task_list', 'task_status', 'task_message', 'context', 'memory_note', 'read_workspace']) {
    assert.match(coordinator.text, new RegExp(`^\\s+- ${tool}\\s*$`, 'm'), `协调者 keep 名单应包含 ${tool}`)
  }
  // P1-B：被合并掉的 6 个旧名必须从名单里消失（模型面 12 → 7）。
  for (const removed of ['task_stop', 'task_retry', 'task_close', 'task_inbox', 'history_search', 'project_context']) {
    assert.doesNotMatch(coordinator.text, new RegExp(`^\\s+- ${removed}\\s*$`, 'm'), `协调者名单不应再列 ${removed}`)
  }
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

test('worker 预设不再遮 memory_note（keep-only）：context/task_detail/task_report/memory_note 出生即可用', () => {
  const source = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const worker = presetPlugins(source, 'dsh-orchestrator-worker')
  // 挂载链：index.js 的 createTools(...).map(tool => ctx.tools.register(tool)) 把 task_detail 注册成
  // host plane 的**全局**工具，子会话继承它们；worker 预设的 preset-tools 用 deny（点名遮挡）而不是 allow 补集——
  // allow 补集要把平台所有全局工具名抄全，漏一个就把 task_report/task_detail 一起遮掉。
  const rows = worker.rows.filter(row => row.id === 'preset-tools')
  assert.equal(rows.length, 1, 'worker 预设应恰好挂一行 preset-tools（遮挡式）')
  const rowText = rows[0].lines.join('\n')
  assert.match(rowText, /name:\s*'@wjj865-code\/dsh-orchestrator\/preset-tools'/)
  // 0.29.x（2026-11-21 用户方向）：子会话也能写项目记忆 → 不再遮 memory_note。
  // 0.32.0：能力包工厂只属于协调者 → worker 只点名遮 capability_pack（其余仍全开，仍是遮挡式）。
  assert.match(rowText, /^\s+deny:\s*$/m, 'worker 预设用遮挡式 deny 点掉 capability_pack')
  assert.doesNotMatch(rowText, /- memory_note\s*\n\s+keep:/, 'deny 名单里不应出现 memory_note')
  assert.match(rowText, /- capability_pack\s*$/m, 'worker 预设应遮住 capability_pack')
  assert.doesNotMatch(rowText, /^\s+allow:/m, 'worker 预设不能用 allow 补集（会把全局工具全遮掉）')
  // 正向声明：这些全局工具必须对子会话出生即可用（preset-tools 挂载后校验并写 preset.keep 审计）。
  for (const tool of ['context', 'task_detail', 'task_report', 'memory_note']) {
    assert.match(rowText, new RegExp(`- ${tool}\\s*$`, 'm'), `worker 预设 keep 应声明 ${tool}`)
  }
  assert.match(worker.text, /task_report \/ task_detail \/ plan_save \/ context/, 'worker 预设应保留全局工具挂载链的说明')
  // 协调者那一侧同形：keep 里仍保留 memory_note（写记忆仍在主会话）。
  const coordinator = presetPlugins(source, 'dsh-orchestrator-coordinator')
  const coordinatorTools = coordinator.rows.find(row => row.id === 'preset-tools')
  assert.match(coordinatorTools.lines.join('\n'), /^\s+- memory_note\s*$/m)
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(index, /createTools\(\{[\s\S]{0,1200}?\.map\(tool => ctx\.tools\.register\(tool\)\)/,
    'task_detail 与其它 task_* 一样走全局注册')
  // 归属解析复用 W1 的同一份（首回合台账 session_id 还没回写也能认出子会话的任务）。
  assert.match(index, /taskOfAgent:\s*workerTaskOf/, 'memory_note 的归属解析要复用 workerTaskOf')
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
  // present 是预设自有（own）工具，遮挡式 deny 遮不到它，所以不写进任何名单。
  assert.doesNotMatch(coordinator.text, /^\s+- present\s*$/m, 'present 是 own 工具，不需进 keep/deny 名单')
  // 协调者与 worker 各一行：整份补丁恰好 2 行。
  assert.equal((source.match(/id: present/g) ?? []).length, 2, '整份补丁应有协调者、worker 两行 present')
})

test('协调者只读工具面：只开 read，不挂 tool-fs-search（glob/grep 已移除），写工具不挂', () => {
  const source = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const coordinator = presetPlugins(source, 'dsh-orchestrator-coordinator')
  const worker = presetPlugins(source, 'dsh-orchestrator-worker')
  // tool-fs：只开 read，write/edit/apply_patch/read_image 全关 —— 协调者工具表里没有写工具。
  const fsRows = coordinator.rows.filter(row => row.id === 'tool-fs')
  assert.equal(fsRows.length, 1, '协调者预设应恰好一行 tool-fs')
  const fsText = fsRows[0].lines.join('\n')
  assert.match(fsText, /name:\s*'@deepseek-ai\/dsh-tool-fs'/)
  for (const [key, value] of [['read', 'true'], ['write', 'false'], ['edit', 'false'], ['applyPatch', 'false'], ['readImage', 'false']]) {
    assert.match(fsText, new RegExp(`^\\s+${key}: ${value}\\s*$`, 'm'), `tool-fs.${key} 应为 ${value}`)
  }
  // t-4f7ce108：tool-fs-search 整行移除。该包没有「只关 grep、保留 glob」的开关（Config 只有
  // sampleOverCapGlobResults 与各 max* 上限，apply() 无条件注册两个工具），而 preset-tools 的 deny
  // 只作用于已注册的全局工具、遮不到预设自有行 —— 所以协调者拿不到 glob/grep，检索类工作派任务。
  assert.equal(coordinator.rows.some(row => row.id === 'tool-fs-search'), false,
    '协调者预设不得挂 tool-fs-search（glob/grep 会让主会话自行搜索、绕过派发）')
  assert.equal(/name:\s*'@deepseek-ai\/dsh-tool-fs-search'/.test(coordinator.text), false,
    '协调者预设不许再注册 tool-fs-search（注释里的移除原因不算）')
  // 写/执行类工具**不挂行**：bash/pwsh 只有 worker 挂，协调者只在只读层收口。
  for (const rowId of ['tool-bash', 'tool-pwsh']) {
    assert.equal(coordinator.rows.some(row => row.id === rowId), false, `协调者预设不应挂 ${rowId}`)
  }
  assert.equal(worker.rows.some(row => row.id === 'tool-fs'), true, 'worker 仍挂 tool-fs（可写）')
  assert.equal(worker.rows.some(row => row.id === 'tool-fs-search'), true, 'worker 仍挂 tool-fs-search（子会话要能检索）')
  // 预设描述与 persona 也不许再写「协调者能 glob/grep」（注释行可以有，那是移除原因的说明）。
  const coordinatorText = coordinator.text
  for (const line of coordinatorText.split('\n')) {
    if (!/^\s*(description|prefix):/.test(line)) continue
    assert.doesNotMatch(line, /glob|grep/, `协调者预设文案不许再暗示能搜索：${line.trim()}`)
  }
})

test('协调者挂 grill-me 技能：注册模块 + tool-skill 各一行，worker 看不到', () => {
  const source = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const coordinator = presetPlugins(source, 'dsh-orchestrator-coordinator')
  const worker = presetPlugins(source, 'dsh-orchestrator-worker')
  const register = coordinator.rows.filter(row => row.id === 'skill-grill-me')
  assert.equal(register.length, 1, '协调者预设应恰好一行 skill-grill-me')
  assert.match(register[0].lines.join('\n'), /name:\s*'@wjj865-code\/dsh-orchestrator\/skill-grill-me'/)
  const skillTool = coordinator.rows.filter(row => row.id === 'tool-skill')
  assert.equal(skillTool.length, 1, '协调者预设应恰好一行 tool-skill（模型面 skill 工具 + 技能目录）')
  assert.match(skillTool[0].lines.join('\n'), /name:\s*'@deepseek-ai\/dsh-tool-skill'/)
  // 技能只对协调者可见：worker 预设不挂注册模块（工具行 skill-filesystem / tool-skill 它本来就有）。
  assert.equal(worker.rows.some(row => row.id === 'skill-grill-me'), false, 'worker 预设不得挂 grill-me 注册模块')
  assert.equal((source.match(/skill-grill-me/g) ?? []).length >= 1, true)
  assert.equal((source.match(/id: skill-grill-me/g) ?? []).length, 1, '整份补丁只挂一行 skill-grill-me')
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
  // 四个 schedule 工具是预设自有行注册的（own），不写在 keep/deny 名单里，也不该被遮。
  for (const name of ['schedule_create', 'schedule_list', 'schedule_view', 'schedule_edit']) {
    assert.doesNotMatch(coordinator.text, new RegExp(`^\\s+- ${name}\\s*$`, 'm'))
    assert.doesNotMatch(worker.text, new RegExp(`^\\s+- ${name}\\s*$`, 'm'))
  }
})

test('协调者 preset-tools：遮挡式 deny 只列编排正确性 + 角色专属工具，keep 声明 7 个任务工具', () => {
  const source = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const coordinator = presetPlugins(source, 'dsh-orchestrator-coordinator')
  const rows = coordinator.rows.filter(row => row.id === 'preset-tools')
  assert.equal(rows.length, 1, '协调者预设应恰好一行 preset-tools')
  const text = rows[0].lines.join('\n')
  assert.doesNotMatch(text, /^\s+allow:/m, '协调者改用遮挡式 deny，不再用 allow 补集')
  // 编排正确性：派队友 / 团队板 / 插件 / 密钥 / IM 一律遮掉（执行层 COORDINATOR_DENY 同一份口径）。
  for (const name of [
    'wait_agent', 'spawn_teammate', 'send_message', 'list_agents', 'interrupt_agent',
    'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
    'plugin_manager', 'request_secret', 'request_connector',
    'list_bots', 'message_bot', 'post_to_group', 'create_bot', 'create_group', 'delete_group', 'update_group', 'update_bot',
  ]) {
    assert.match(text, new RegExp(`^\\s+- ${name}\\s*$`, 'm'), `协调者 deny 缺少 ${name}`)
  }
  // 角色专属：三个子会话工具遮在预设层，协调者工具表里才不会冒出它们。
  for (const name of ['task_report', 'task_detail', 'plan_save']) {
    assert.match(text, new RegExp(`^\\s+- ${name}\\s*$`, 'm'), `协调者 deny 应遮住角色专属工具 ${name}`)
  }
  // 宿主导航工具：0.26.0 发版前真机复验发现它漏在协调者工具表里（改 cwd = 改指挥锚）。
  assert.match(text, /^\s+- working_directory\s*$/m, '协调者 deny 应遮住宿主全局 working_directory（会改会话 cwd）')
  // 只读工具与技能不靠名单：它们是预设自有行（own），restrict 指不到，也不该出现在名单里。
  for (const name of ['read', 'glob', 'grep', 'skill', 'present', 'ask_user_question']) {
    assert.doesNotMatch(text, new RegExp(`^\\s+- ${name}\\s*$`, 'm'), `${name} 是预设自有工具，不应进 deny/keep 名单`)
  }
  // keep：7 个全局任务工具正向声明「出生即可用」（挂载后校验并写 preset.keep 审计）。
  const keepBlock = text.split(/^\s+keep:\s*$/m)[1] ?? ''
  for (const name of ['task_create', 'task_list', 'task_status', 'task_message', 'context', 'memory_note', 'read_workspace']) {
    assert.match(keepBlock, new RegExp(`^\\s+- ${name}\\s*$`, 'm'), `协调者 keep 缺少 ${name}`)
  }
  assert.doesNotMatch(keepBlock, /^\s+- working_directory\s*$/m, 'working_directory 不能进 keep（deny 与 keep 冲突会被 preset-tools 直接抛错）')
})

test('package.json 导出 preset-tools', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.name, '@wjj865-code/dsh-orchestrator')
  assert.equal(pkg.private, undefined)
  assert.equal(pkg.publishConfig.access, 'public')
  assert.equal(pkg.exports['./preset-tools'], './preset-tools.js')
  assert.ok(pkg.files.includes('preset-tools.js'))
  // A（0.26.0）：grill-me 技能随包发——注册模块有子路径导出，技能文件在 files 白名单里。
  assert.equal(pkg.exports['./skill-grill-me'], './skill-grill-me.js')
  assert.ok(pkg.files.includes('skill-grill-me.js'))
  assert.ok(pkg.files.includes('skills/'), 'files 白名单要带 skills/，否则技能文件不发货')
  assert.equal(existsSync(new URL('../skills/grill-me/SKILL.md', import.meta.url)), true, 'skills/grill-me/SKILL.md 必须在')
  assert.equal(existsSync(new URL('../skill-grill-me.js', import.meta.url)), true)
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
  for (const file of ['icon.svg', 'locale/zh.json', 'locale/en.json', 'docs/testing.md', 'docs/ARCHITECTURE.md', 'docs/LIMITATIONS.md']) {
    assert.equal(existsSync(new URL(`../${file}`, import.meta.url)), true, file)
  }
  assert.ok(pkg.files.includes('locale/*.json'))
  assert.ok(pkg.files.includes('docs/testing.md'))
  assert.ok(pkg.files.includes('docs/ARCHITECTURE.md'))
  assert.ok(pkg.files.includes('docs/LIMITATIONS.md'))
  assert.ok(pkg.files.includes('icon.svg'))
  const zh = JSON.parse(readFileSync(new URL('../locale/zh.json', import.meta.url), 'utf8'))
  assert.equal(typeof zh.meta.title, 'string')
  assert.equal(typeof zh.meta.description, 'string')
  assert.equal(zh.meta.detail, 'README.md')
})
