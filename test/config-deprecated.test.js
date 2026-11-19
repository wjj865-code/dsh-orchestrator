// 已删除配置键的弃用机制（P1-A 起）：读到旧键就 warn 一次、值不回填、拼错的键不误报。
//
// 为什么需要它：配置面 41 → 35（P1-A）→ 28（P2-2），删掉的键还留在老用户的 profile 里。
// 静默忽略会让用户以为「我配的阈值还在生效」；这里明确告诉用户哪个键失效了、该改什么。
// 去重是进程级的（`pnpm test` 用 --experimental-test-isolation=none，所有用例共享模块状态），
// 所以每个用例开始先 reset。
import test from 'node:test'
import assert from 'node:assert/strict'
import { DEPRECATED_KEYS, loadConfig, resetDeprecatedKeyWarnings } from '../src/config.js'

const collect = raw => {
  const warnings = []
  const config = loadConfig(raw, { onWarn: message => warnings.push(message) })
  return { config, warnings }
}

test('弃用键清单：P1-A 的 6 个 + P2-2 的 7 个，每个都有迁移提示', () => {
  assert.deepEqual(Object.keys(DEPRECATED_KEYS).sort(), [
    'backend',
    'keepAlive', 'keepAliveMaxRounds', 'keepAliveMode', 'keepAlivePrompt',
    'mergeWindowMs',
    'preferencesMaxItems',
    'rotateAfterContextTokens', 'rotateAfterDiskMiB', 'rotateAfterSessions',
    'rotateAfterTasks', 'rotateCheckIntervalHours',
    'stallRounds',
  ])
  for (const [key, note] of Object.entries(DEPRECATED_KEYS)) {
    assert.equal(typeof note, 'string')
    assert.ok(note.length > 0, `${key} 要有迁移提示`)
  }
})

test('P2-2 旧键：续跑四键的提示指向 task_create.goalRounds（不是「再打开某个开关」）', () => {
  resetDeprecatedKeyWarnings()
  const { config, warnings } = collect({ keepAlive: true, keepAliveMaxRounds: 8 })
  assert.equal(warnings.length, 2)
  assert.match(warnings[0], /配置键 keepAlive 已删除/)
  assert.match(warnings[0], /goalRounds/)
  assert.match(warnings[1], /配置键 keepAliveMaxRounds 已删除/)
  assert.match(warnings[1], /goalRounds/)
  // 值不回填：旧值不会变出新的续跑行为（默认 0 = 不续跑）。
  assert.equal('keepAlive' in config, false)
  assert.equal('goalRounds' in config, false, 'goalRounds 是 task_create 参数，不是配置键')
})

test('命中旧键：各 warn 一次，文案带键名与提示；值不回填', () => {
  resetDeprecatedKeyWarnings()
  const { config, warnings } = collect({ backend: 'team', rotateAfterTasks: 60 })
  assert.equal(warnings.length, 2)
  assert.match(warnings[0], /配置键 backend 已删除/)
  assert.match(warnings[1], /配置键 rotateAfterTasks 已删除/)
  for (const warning of warnings) assert.match(warning, /按默认值运行/)
  // 值不回填：旧键不出现在归一化结果里，也不会改变轮换本来会用的默认值。
  assert.equal('backend' in config, false)
  assert.equal('rotateAfterTasks' in config, false)
  assert.equal(config.mainRotation, 'off')
})

test('同一键只 warn 一次（进程级去重）；换键仍会 warn', () => {
  resetDeprecatedKeyWarnings()
  const first = collect({ backend: 'team' })
  const second = collect({ backend: 'team' })
  assert.equal(first.warnings.length, 1)
  assert.deepEqual(second.warnings, [], '同键第二次不再重复告警')
  const other = collect({ rotateCheckIntervalHours: 4 })
  assert.equal(other.warnings.length, 1, '不同键各 warn 一次')
  assert.match(other.warnings[0], /配置键 rotateCheckIntervalHours 已删除/)
})

test('没有旧键就一条也不 warn；显式 undefined 也算命中（用户 profile 里可能写着 key: undefined）', () => {
  resetDeprecatedKeyWarnings()
  assert.deepEqual(collect({ staleMinutes: 10 }).warnings, [])
  assert.deepEqual(collect().warnings, [])
  const withUndefined = collect({ backend: undefined })
  assert.equal(withUndefined.warnings.length, 1, 'own property 存在就提示（值是什么不重要）')
})

test('没有 onWarn 时静默（纯函数场景不抛、不写日志）', () => {
  resetDeprecatedKeyWarnings()
  assert.doesNotThrow(() => loadConfig({ backend: 'team' }))
  // 静默调用不该「消耗」去重名额的前提是没 onWarn 就不记；这里只断言结果仍是 28 键的默认值。
  assert.equal(Object.keys(loadConfig({ backend: 'team' })).length, 28)
})
