import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Config, unwrapVolatile, configSchemaAvailable } from '../src/config-schema.js'
import { loadConfig, DEPRECATED_KEYS } from '../src/config.js'
import { CONFIG_FIELDS, FIELD_KEYS, FIELD_BY_KEY, FIELDS_BY_GROUP, FIELD_GROUPS, EDITABLE_KEYS } from '../src/config-fields.js'
import { ROTATION_DEFAULTS, ROTATION_LIMITS, MAIN_ROTATION_MODES } from '../src/main-rotation.js'
import { SAME_DIR_GUARD_MODES } from '../src/write-guard.js'
import { WORKTREE_POLICIES } from '../src/worktree-request.js'

// 宿主侧配置 schema：只守「对外契约」，不测内部实现细节。
// 每条用例都对应一个真实会坏掉的东西；四个 P0 各自有反向验证（见报告）。

/** 从 schema 取「顶层字段名 → 是否 volatile」。 */
const volatileMapOf = schema => {
  const json = schema.toJSON()
  const refs = json.refs ?? {}
  const root = refs[String(json.uid)] ?? json
  return Object.fromEntries(Object.entries(root.dict ?? {}).map(([key, ref]) => {
    const node = typeof ref === 'number' ? refs[String(ref)] : ref
    return [key, node?.meta?.volatile === true]
  }))
}

// ── P0-1：非法配置不得拒载（Cordis 校验失败 = 插件起不来） ──────────

test('P0-1 非法配置不拒载：垃圾值/非有限数都不产生 issues', () => {
  // 四种字段类型 × 典型垃圾，外加 NaN/Infinity/负值/超界。
  // 反向验证：去掉 .loose() → 本条立刻红。
  const junk = {
    staleMinutes: 'not-a-number',
    maxQueue: Number.NaN,
    autoResumeQueue: 'yes-please',
    sameDirGuard: 'GARBAGE_MODE',
    digestAt: 12345,
    workerPreset: { nested: 'object' },
    watchdogIdleMinutes: Number.POSITIVE_INFINITY,
    memoryLimit: 999999,
  }
  const result = Config['~standard'].validate(junk)
  assert.equal(result.issues, undefined, `垃圾配置不得拒载：${JSON.stringify(result.issues)}`)

  // 合法值必须原样保留（.loose() 只兜底非法值，不能顺手抹掉用户配置）。
  const ok = unwrapVolatile(Config['~standard'].validate({ staleMinutes: 10, autoResumeQueue: true, sameDirGuard: 'warn' }).value)
  assert.deepEqual([ok.staleMinutes, ok.autoResumeQueue, ok.sameDirGuard], [10, true, 'warn'])
})

// ── P0-2：volatile 漏标 = 插件页上静默少一行 ──────────────────────

test('P0-2 volatile 双向比对：字段表与 schema 的 volatile 集合必须完全相同', () => {
  // 反向验证：去掉 .volatile() → 本条立刻红。
  const volatile = volatileMapOf(Config)
  const inSchema = new Set(Object.keys(volatile).filter(key => volatile[key] === true))
  const inTable = new Set(FIELD_KEYS)
  assert.deepEqual([...inTable].filter(key => !inSchema.has(key)), [],
    '这些字段没标 volatile，会在插件页上静默消失')
  assert.deepEqual([...inSchema].filter(key => !inTable.has(key)), [],
    '这些字段标了 volatile 但字段表里没有，页面画不出控件')
})

// ── 字段集 / 默认值 / 枚举 / 区间：与运行时单一事实源对齐 ──────────

test('字段表与 loadConfig 双向一致（字段集 / 默认值 / 枚举 / 区间）', () => {
  const defaults = loadConfig({})

  // 字段集双向：多一个 = 页面显示失效项，少一个 = 用户看不到可配项。
  const alive = new Set(Object.keys(defaults))
  const inTable = new Set(FIELD_KEYS)
  assert.deepEqual([...inTable].filter(key => !alive.has(key)), [], '字段表有但 loadConfig 已不产出')
  assert.deepEqual([...alive].filter(key => !inTable.has(key)), [], 'loadConfig 有但字段表漏了')

  // 默认值逐项对齐（coordinatorSession 在 loadConfig 里是 undefined，表单用 '' 展示）。
  for (const field of CONFIG_FIELDS) {
    const expected = field.key === 'coordinatorSession' ? undefined : field.default
    assert.deepEqual(defaults[field.key], expected, `${field.key} 默认值不一致`)
  }

  // 枚举与区间跟源码常量走，防常量改了字段表没跟。
  assert.deepEqual([...FIELD_BY_KEY.sameDirGuard.values], [...SAME_DIR_GUARD_MODES])
  assert.deepEqual([...FIELD_BY_KEY.worktreePolicy.values], [...WORKTREE_POLICIES])
  assert.deepEqual([...FIELD_BY_KEY.mainRotation.values], [...MAIN_ROTATION_MODES])
  for (const [key, [min, max, integer]] of Object.entries(ROTATION_LIMITS)) {
    assert.deepEqual([FIELD_BY_KEY[key].min, FIELD_BY_KEY[key].max, FIELD_BY_KEY[key].integer], [min, max, integer], `${key} 区间不一致`)
    assert.equal(FIELD_BY_KEY[key].default, ROTATION_DEFAULTS[key], `${key} 默认值不一致`)
  }

  // 结构自洽：分组存在、区间合法、只读字段不可编辑。
  const groupIds = new Set(FIELD_GROUPS.map(g => g.id))
  for (const field of CONFIG_FIELDS) {
    assert.ok(groupIds.has(field.group), `${field.key} 分组不存在`)
    if (field.kind === 'number') {
      assert.ok(field.min <= field.max && field.default >= field.min && field.default <= field.max, `${field.key} 区间或默认值非法`)
    }
    if (field.readonly === true) assert.ok(!EDITABLE_KEYS.includes(field.key), `${field.key} 只读却可编辑`)
    // 双向：可写标记与真实可写性必须一致（漏标 readonly = 用户以为不能改；标了却可写 = 只读是假的）。
    assert.equal(EDITABLE_KEYS.includes(field.key), field.readonly !== true, `${field.key} 可写标记与 EDITABLE_KEYS 不一致`)
  }
  assert.equal(FIELDS_BY_GROUP.flatMap(g => g.fields).length, CONFIG_FIELDS.length, '分组未覆盖全部字段')
})

test('废弃键不出现在 UI 字段表', () => {
  // 12 个键由 src/config.js 的 DEPRECATED_KEYS 给迁移提示（P1-A 的 6 个 + P2-2 的 7 个 − 恢复的 1 个）；UI 侧不暴露。
  assert.deepEqual(Object.keys(DEPRECATED_KEYS).sort(), [
    'backend', 'rotateAfterDiskMiB', 'rotateAfterContextTokens',
    'rotateAfterSessions', 'rotateAfterTasks',
    'keepAlive', 'keepAliveMode', 'keepAliveMaxRounds', 'keepAlivePrompt',
    'mergeWindowMs', 'stallRounds', 'preferencesMaxItems',
  ].sort())
  for (const key of Object.keys(DEPRECATED_KEYS)) {
    assert.equal(FIELD_BY_KEY[key], undefined, `废弃键 ${key} 不得出现在字段表`)
    assert.ok(!FIELD_KEYS.includes(key) && !EDITABLE_KEYS.includes(key), `废弃键 ${key} 不得可编辑`)
  }
})

test('语义对齐：字段表只投影 loadConfig({}) 实际产出的 29 个键', () => {
  // 反向验证：把已删的 7 键任意一个加回 config-fields.js → 本条立刻红。
  const deleted = ['keepAlive', 'keepAliveMode', 'keepAliveMaxRounds', 'keepAlivePrompt', 'mergeWindowMs', 'stallRounds', 'preferencesMaxItems']
  for (const key of deleted) {
    assert.equal(FIELD_KEYS.includes(key), false, `${key} 已删除，不得回到表单`)
  }
  assert.equal(FIELD_KEYS.length, 29, '字段表应与 loadConfig({}) 的 29 键同规模')
  // 续跑只剩「按任务声明」这一条路：不再有续跑分组，也没有任何 keepalive 分组。
  assert.deepEqual(FIELD_GROUPS.map(group => group.id).includes('keepalive'), false, '续跑分组应随四个续跑键一起删除')
})

test('mainRotation 默认 auto（开启）；只有显式 off 才关，拼错保持默认', () => {
  assert.equal(FIELD_BY_KEY.mainRotation.default, 'auto')
  assert.equal(ROTATION_DEFAULTS.mainRotation, 'auto')
  assert.equal(loadConfig({}).mainRotation, 'auto')
  assert.equal(loadConfig({ mainRotation: 'off' }).mainRotation, 'off')
  // 拼错不再「安全地关掉」，而是保持默认开启——关轮换只有一条路：显式写 off。
  for (const bad of ['GARBAGE', 'AUTO', 'on', false, 0]) {
    assert.equal(loadConfig({ mainRotation: bad }).mainRotation, 'auto', JSON.stringify(bad))
  }
})

test('轮换分组：8 个键在卡片上可编辑，coordinatorSession 只读（运维兜底通道）', () => {
  // 布局：轮换分组仍是 9 键（总开关 + 7 个 rotate* + 协调者覆盖）。
  const rotation = FIELDS_BY_GROUP.find(group => group.id === 'rotation')
  assert.equal(rotation.fields.length, 9, '轮换分组应恰好 9 个字段')
  assert.deepEqual(rotation.fields.map(field => field.key), [
    'coordinatorSession', 'mainRotation', 'rotateAfterMainLogMiB', 'rotateAfterDays',
    'rotateCooldownHours', 'rotateMinAgeHours', 'rotateIdleMinutes',
    'rotateCheckIntervalHours', 'rotateArchiveOld',
  ])
  // 只读只有一处，且理由明确：填错会让协调者指向不存在的会话（高危误操作）。
  assert.equal(FIELD_BY_KEY.coordinatorSession.readonly, true, 'coordinatorSession 应恢复只读')
  assert.equal(EDITABLE_KEYS.includes('coordinatorSession'), false, 'coordinatorSession 不得下发保存')
  for (const field of rotation.fields) {
    if (field.key === 'coordinatorSession') continue
    assert.notEqual(field.readonly, true, `${field.key} 不该只读`)
    assert.ok(EDITABLE_KEYS.includes(field.key), `${field.key} 必须可编辑（否则卡片上点不动）`)
  }
  assert.equal(EDITABLE_KEYS.length, CONFIG_FIELDS.length - 1, '29 键里只有 coordinatorSession 只读')
  assert.equal(FIELD_GROUPS.find(group => group.id === 'rotation').label, '主会话轮换', '分组标题不再标「只读」（只读逐行标）')

  // 检查节流：可写 int，默认 24、区间 1–168（与 loadConfig 的夹取口径一致）。
  assert.equal(FIELD_BY_KEY.rotateCheckIntervalHours.kind, 'number')
  assert.equal(FIELD_BY_KEY.rotateCheckIntervalHours.integer, true)
  assert.equal(FIELD_BY_KEY.rotateCheckIntervalHours.min, 1)
  assert.equal(FIELD_BY_KEY.rotateCheckIntervalHours.max, 168)
  assert.equal(FIELD_BY_KEY.rotateCheckIntervalHours.default, 24)
  assert.match(FIELD_BY_KEY.rotateCheckIntervalHours.hint, /检查节流 ≠ 轮换冷却/, '提示要写清与冷却的区别')

  // 卡片保存路径：8 个可编辑键经 loadConfig 归一化后真读到新值。
  const saved = loadConfig({
    mainRotation: 'off',
    rotateAfterMainLogMiB: 2.5,
    rotateAfterDays: 3,
    rotateCooldownHours: 6,
    rotateMinAgeHours: 2,
    rotateIdleMinutes: 30,
    rotateCheckIntervalHours: 6,
    rotateArchiveOld: false,
  })
  assert.equal(saved.mainRotation, 'off')
  assert.equal(saved.rotateAfterMainLogMiB, 2.5)
  assert.equal(saved.rotateAfterDays, 3)
  assert.equal(saved.rotateCooldownHours, 6)
  assert.equal(saved.rotateMinAgeHours, 2)
  assert.equal(saved.rotateIdleMinutes, 30)
  assert.equal(saved.rotateCheckIntervalHours, 6)
  assert.equal(saved.rotateArchiveOld, false)
  // coordinatorSession 走运维手改 YAML（不经卡片）：loadConfig 照旧认，空串/缺省 = 读台账指针。
  assert.equal(loadConfig({ coordinatorSession: 's-manual' }).coordinatorSession, 's-manual')
  assert.equal(loadConfig({ coordinatorSession: '' }).coordinatorSession, undefined)
  assert.equal(loadConfig({}).coordinatorSession, undefined)
})

// ── P0-3：volatile 到达 apply 是包装对象，不解包 = 用户配置被丢弃 ──

test('P0-3 volatile 必须解包：不解包时 loadConfig 丢弃配置，解包后生效', () => {
  const validated = Config['~standard'].validate({ staleMinutes: 10, maxQueue: 60 })
  // 对照：直接喂校验结果（包装对象）→ 类型判断失效 → 回落默认，用户的 10 被无声丢弃。
  assert.equal(loadConfig(validated.value).staleMinutes, 30, '前置事实：不解包会丢配置')
  // 正确路径：解包后生效。
  const flat = unwrapVolatile(validated.value)
  assert.equal(loadConfig(flat).staleMinutes, 10)
  assert.equal(loadConfig(flat).maxQueue, 60)
  // 解包器本身：非包装值原样、null/undefined 给空对象、不误判「带 get 的普通对象」。
  const lookalike = { get: () => 'x', other: 1 }
  assert.deepEqual(unwrapVolatile({ a: 1 }), { a: 1 })
  assert.deepEqual(unwrapVolatile(null), {})
  assert.equal(unwrapVolatile({ v: lookalike }).v, lookalike)
})

// ── P0-4：schemastery 解析失败不得拖垮整个插件 ────────────────────

test('P0-4 schemastery 缺失时降级而非崩溃（Config 可为 undefined）', () => {
  // 静态 import 解析失败 = 模块加载失败 = 任务面板与工具一起消失。
  // 契约：用 createRequire + try/catch 同步降级；宿主 resolveConfig 遇空 Config 跳过校验。
  const source = readFileSync(new URL('../src/config-schema.js', import.meta.url), 'utf8')
  assert.ok(!/^import\s+z\s+from\s+['"]@deepseek-ai\/schemastery['"]/m.test(source), '不许静态 import schemastery')
  assert.match(source, /createRequire/)
  assert.match(source, /try\s*\{/)
  // 本环境能解析到 → Config 可用；解析不到时 configSchemaAvailable 为 false 且 Config 为 undefined。
  assert.equal(typeof configSchemaAvailable, 'boolean')
  if (configSchemaAvailable) assert.equal(typeof Config, 'function')
  else assert.equal(Config, undefined)
})
