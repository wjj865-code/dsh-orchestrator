// 偏好机制（preferences）：归一化、预算截断、L1 第 4 段渲染、不双写路由。
//
// 审计 §5.3 的四个待定项在这里各有一条正向用例：
//   1. 位置 → policy 末尾独立段（`renderPreferenceBlock` 自带优先级声明）；
//   2. 不双写 → 全局偏好只写 settings，`history_search` 查不到；
//   3. 上限 → 字数为主（1200）+ 条数为安全阀（12），超限**显式告知**；
//   4. v1 不带脚本 → 只有 `memory_note` 一条写入路径（本文件不测脚本）。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_MAX_CHARS, DEFAULT_MAX_ITEMS, MAX_RULE_CHARS, PREFERENCES_KEY, PREFERENCES_MIGRATED_KEY,
  PRESET_PREFERENCES, loadPreferences, migrateLegacyPreferences, normalizePreferences, preferenceBudgetLine,
  renderPreferenceBlock, savePreferences, setPreferenceEnabled, upsertPreference,
} from '../src/preferences.js'
import { getSetting, openLedger, setSetting } from '../src/ledger.js'
import { addMemory, GLOBAL_PROJECT } from '../src/memory.js'
import { loadConfig } from '../src/config.js'
import { tempDir } from './helpers.js'

const item = (overrides = {}) => ({
  id: 'test-item', category: 'delegation', rule: '派发任务时优先用 worktree 隔离', ...overrides,
})

test('normalizePreferences：坏 id / 空 rule / 未知 category 逐条丢弃，不抛', () => {
  const normalized = normalizePreferences([
    item({ id: 'ok-1' }),
    item({ id: 'Bad_ID' }),        // 大写 + 下划线：不匹配 /^[a-z0-9][a-z0-9-]{0,39}$/
    item({ id: '-leading' }),      // 不能以连字符开头
    item({ id: 'ok-2', rule: '   ' }), // 空规则
    item({ id: 'ok-3', rule: null }),
    null,
    'not-an-object',
    item({ id: 'ok-4', category: 'weird' }), // 未知 category 回落 general，不丢
  ])
  assert.deepEqual(normalized.map(entry => entry.id), ['ok-1', 'ok-4'])
  assert.equal(normalized[1].category, 'general')
  // 非法输入整体不抛。
  assert.deepEqual(normalizePreferences(undefined), [])
  assert.deepEqual(normalizePreferences('nope'), [])
})

test('normalizePreferences：默认值、夹取与超长规则截断', () => {
  const [entry] = normalizePreferences([item({ id: 'defaults' })])
  assert.equal(entry.scope, 'global')
  assert.equal(entry.appliesTo, 'coordinator')
  assert.equal(entry.priority, 50)
  assert.equal(entry.enabled, true)
  assert.equal(entry.source, 'user')
  // priority 夹到 0..1000。
  assert.equal(normalizePreferences([item({ id: 'p-hi', priority: 99999 })])[0].priority, 1000)
  assert.equal(normalizePreferences([item({ id: 'p-lo', priority: -5 })])[0].priority, 0)
  // 超长规则截断（保留结尾省略号，不切半句语义）。
  const long = normalizePreferences([item({ id: 'long', rule: 'x'.repeat(500) })])[0]
  assert.equal(long.rule.length, MAX_RULE_CHARS)
  assert.match(long.rule, /…$/)
})

test('normalizePreferences：同 id 后者整体覆盖前者（不是字段级合并）', () => {
  const normalized = normalizePreferences([
    item({ id: 'dup', rule: '旧规则', priority: 10 }),
    item({ id: 'dup', rule: '新规则', priority: 99 }),
  ])
  assert.equal(normalized.length, 1)
  assert.equal(normalized[0].rule, '新规则')
  assert.equal(normalized[0].priority, 99)
})

test('loadPreferences：出厂种子 + 用户条目，同 id 用户覆盖种子', async () => {
  const db = await openLedger(tempDir())
  // 空库：只有出厂种子。
  const seeded = loadPreferences(db)
  assert.equal(seeded.length, PRESET_PREFERENCES.length)
  assert.ok(seeded.some(entry => entry.id === 'cli-access-full' && entry.source === 'preset'))

  // 用户覆盖同 id：整体覆盖（规则变了、source 变 user）。
  upsertPreference(db, { ...PRESET_PREFERENCES[0], rule: '我自己的 full 规则', source: 'user' })
  const merged = loadPreferences(db)
  const overridden = merged.find(entry => entry.id === 'cli-access-full')
  assert.equal(overridden.rule, '我自己的 full 规则')
  assert.equal(overridden.source, 'user')
  assert.equal(merged.length, PRESET_PREFERENCES.length, '同 id 覆盖不新增条目')

  // 坏 JSON 当没有（不能把协调者提示词搞崩）。
  setSetting(db, PREFERENCES_KEY, '{oops')
  assert.equal(loadPreferences(db).length, PRESET_PREFERENCES.length)
  db.close()
})

test('savePreferences 覆盖式；setPreferenceEnabled 可停用内置种子', async () => {
  const db = await openLedger(tempDir())
  savePreferences(db, [item({ id: 'only-one' })])
  const saved = loadPreferences(db)
  // 出厂种子仍在（savePreferences 只写用户层，种子是代码里的）。
  assert.ok(saved.some(entry => entry.id === 'cli-access-full'))
  assert.ok(saved.some(entry => entry.id === 'only-one'))

  const disabled = setPreferenceEnabled(db, 'cli-access-full', false)
  assert.equal(disabled.ok, true)
  assert.equal(loadPreferences(db).find(entry => entry.id === 'cli-access-full').enabled, false)
  // 停用后不注入。
  assert.equal(renderPreferenceBlock(loadPreferences(db)).includes('包管理器'), false)
  // 不存在的 id 给可读结果，不抛。
  assert.equal(setPreferenceEnabled(db, 'nope', true).ok, false)
  db.close()
})

test('renderPreferenceBlock：空数组返回空串（整段消失，不留空标题）', () => {
  assert.equal(renderPreferenceBlock([]), '')
  assert.equal(renderPreferenceBlock([item({ enabled: false })]), '')
  // 非全局范围不注入协调者（项目偏好走 brief / project_context）。
  assert.equal(renderPreferenceBlock([item({ scope: '/repo/a' })]), '')
  // 只给 worker 的条目也不注入。
  assert.equal(renderPreferenceBlock([item({ appliesTo: 'worker' })]), '')
  assert.equal(renderPreferenceBlock([item({ appliesTo: 'both' })]).includes('worktree 隔离'), true)
})

test('renderPreferenceBlock：段首声明「不覆盖硬规则」——偏好不是权限通道', () => {
  const block = renderPreferenceBlock(PRESET_PREFERENCES)
  assert.match(block, /^## 偏好/)
  assert.match(block, /优先级低于上面的硬规则/)
  assert.match(block, /不覆盖/)
  assert.match(block, /硬性规则/)
  assert.match(block, /沙箱与审批门禁/)
  assert.match(block, /AGENTS\.md/)
  // 每条带分类标签。
  assert.match(block, /- \[派发\]/)
})

test('renderPreferenceBlock：按 priority 排序；超条数截断并显式告知', () => {
  const items = [
    item({ id: 'low', rule: '低优先级规则', priority: 10 }),
    item({ id: 'high', rule: '高优先级规则', priority: 900 }),
    item({ id: 'mid', rule: '中优先级规则', priority: 100 }),
  ]
  const block = renderPreferenceBlock(items, { maxItems: 2, maxChars: 10000 })
  assert.match(block, /高优先级规则/)
  assert.match(block, /中优先级规则/)
  assert.equal(block.includes('低优先级规则'), false)
  // 被截掉的条数必须写出来——静默丢弃会让用户以为偏好生效了。
  assert.match(block, /另有 1 条偏好因超限未展示/)
})

test('renderPreferenceBlock：超字数时保留完整条目、不切半句', () => {
  const longRule = `这条规则很长${'很'.repeat(60)}`
  const items = [
    item({ id: 'a', rule: '短规则', priority: 100 }),
    item({ id: 'b', rule: longRule, priority: 90 }),
  ]
  const block = renderPreferenceBlock(items, { maxItems: 10, maxChars: 200 })
  // 第一条一定保留（否则整段可能空）。
  assert.match(block, /短规则/)
  // 被保留的规则必须是完整的一条，不能是前半截。
  for (const line of block.split('\n').filter(row => row.startsWith('- ['))) {
    const rule = line.replace(/^- \[[^\]]+\] /, '')
    assert.ok(!rule.endsWith('很') || rule.length < 60, `规则被切半句：${rule}`)
  }
  assert.match(block, /因超限未展示/)
})

test('偏好预算默认值：字数为主（1200）+ 条数为安全阀（12）', () => {
  assert.equal(DEFAULT_MAX_CHARS, 1200)
  assert.equal(DEFAULT_MAX_ITEMS, 12)
  const line = preferenceBudgetLine(PRESET_PREFERENCES)
  assert.match(line, /当前 \d+ 条可注入偏好/)
  assert.match(line, /上限 12 条 \/ 1200 字/)
})

test('config：偏好只留 inject 开关与字数上限（条数上限 P2-2 固定成常量）', () => {
  const defaults = loadConfig({})
  assert.equal(defaults.preferencesInject, true)
  assert.equal(defaults.preferencesMaxChars, DEFAULT_MAX_CHARS)
  // P2-2：preferencesMaxItems 已删（固定 12 条安全阀），配置面不该再有这个键。
  assert.equal('preferencesMaxItems' in defaults, false)
  // 只有显式 false 才关。
  assert.equal(loadConfig({ preferencesInject: false }).preferencesInject, false)
  assert.equal(loadConfig({ preferencesInject: 'no' }).preferencesInject, true)
  // 越界夹到边界。
  assert.equal(loadConfig({ preferencesMaxChars: 99999 }).preferencesMaxChars, 4000)
  assert.equal(loadConfig({ preferencesMaxChars: 1 }).preferencesMaxChars, 200)
  // 非法值回落默认。
  assert.equal(loadConfig({ preferencesMaxChars: 'x' }).preferencesMaxChars, DEFAULT_MAX_CHARS)
})

test('偏好存 settings 单键（不新建表、不需要迁移）', async () => {
  const db = await openLedger(tempDir())
  savePreferences(db, [item({ id: 'stored' })])
  const raw = getSetting(db, PREFERENCES_KEY)
  assert.equal(typeof raw, 'string')
  assert.match(raw, /stored/)
  // 旧库兼容：键不存在时 loadPreferences 返回种子（行为等价出厂默认）。
  const fresh = await openLedger(tempDir())
  assert.equal(getSetting(fresh, PREFERENCES_KEY), undefined)
  assert.equal(loadPreferences(fresh).length, PRESET_PREFERENCES.length)
  db.close()
  fresh.close()
})

test('出厂种子只放「触发条件明确、不放宽安全边界」的规则', () => {
  for (const seed of PRESET_PREFERENCES) {
    // 不许出现「一律/全都/所有任务都传 full」这类泛化授权。
    assert.doesNotMatch(seed.rule, /一律传|全都传|所有任务都/, `${seed.id} 出现泛化授权`)
    // 必须写成前提从句（含「时」或「要…」），不要写成无条件规则。
    assert.match(seed.rule, /时|要/, `${seed.id} 没写成前提从句`)
    assert.equal(seed.source, 'preset')
  }
})

// ---- P0 旧偏好迁移（t-3e27f4b4）：memories 的 global preference 搬进 settings ----

test('P0 旧偏好迁移：global preference 进 settings、取更正版、不双写、幂等', async () => {
  const db = await openLedger(tempDir())
  // 真实形态（11-15 写的 3 条死数据）：present 展示数量先 1–2、后一条明确「更正上一条」为 1–4。
  addMemory(db, { kind: 'preference', text: '任务产生可交付文件后，协调者默认用 present 展示 1–2 个最关键产物（最多 4 个，只展示定稿且真实存在的文件）。' })
  addMemory(db, { kind: 'preference', text: '更正上一条 present 偏好：默认展示数量应为 1–4 个最关键产物（最多 4 个，只展示真实存在的定稿文件，绝对路径），不再用 1–2。' })
  addMemory(db, { kind: 'preference', text: '向用户汇报任务时用任务名（可附编号），不要只甩任务 id；协调者预设里应写明这条汇报习惯。' })

  const result = migrateLegacyPreferences({ db, now: Date.UTC(2026, 10, 21) })
  assert.equal(result.migrated, 2)
  const rules = loadPreferences(db).filter(entry => entry.source === 'user').map(entry => entry.rule)
  assert.equal(rules.length, 2)
  // 取更正后的 1–4 版本，旧条目（present 默认 1–2）不再保留（也不再留在 memories 里当「事实」）。
  assert.equal(rules.some(rule => rule.startsWith('任务产生可交付文件后')), false)
  assert.equal(rules.some(rule => rule.includes('应为 1–4')), true)
  assert.equal(rules.some(rule => rule.includes('任务名')), true)
  // 不双写：旧 global preference 行已从 memories 搬走。
  assert.equal(db.prepare("SELECT count(*) AS n FROM memories WHERE project_key = ? AND kind = 'preference'").get(GLOBAL_PROJECT).n, 0)
  // 幂等标记与二次调用。
  assert.equal(typeof getSetting(db, PREFERENCES_MIGRATED_KEY), 'string')
  const again = migrateLegacyPreferences({ db })
  assert.equal(again.skipped, true)
  assert.equal(again.reason, 'already-migrated')
  assert.equal(loadPreferences(db).filter(entry => entry.source === 'user').length, 2)
  db.close()
})

test('P0 旧偏好迁移：没有旧数据时不写 settings（连标记也不写），重复调用仍是无副作用', async () => {
  const db = await openLedger(tempDir())
  const first = migrateLegacyPreferences({ db })
  assert.equal(first.migrated, 0)
  assert.equal(first.reason, 'no-legacy')
  // 加载插件不该为了「扫了一遍」去动 settings：没有旧行就没有标记。
  assert.equal(getSetting(db, PREFERENCES_MIGRATED_KEY), undefined)
  assert.equal(migrateLegacyPreferences({ db }).reason, 'no-legacy')
  assert.equal(getSetting(db, PREFERENCES_MIGRATED_KEY), undefined)
  db.close()
})
