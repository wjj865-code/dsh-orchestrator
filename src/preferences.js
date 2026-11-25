// 偏好（预制种子 + 用户保存）：L1 协调者 policy 的第 4 段。
//
// 定位（审计 §5.2 / §5.3，方案稿 reports/preference-mechanism-plan.md §4.3）：
//   - 偏好是**协调者的行为取向**（「派任务要传 access:full」是协调者的决定，不是子会话的），
//     所以归 L1 policy，不进 brief / task_detail / onboarding；
//   - L1 的 `systemPrompt.context` 回调**每回合重渲染**，所以改完偏好下一回合就生效，
//     不用重启、不用重开主会话；这也是它不能放 onboarding（一次性、轮换会被跳过）的原因；
//   - 偏好是 policy 的**最后一段**：阅读顺序即优先级顺序，末尾天然表达「低于硬规则」。
//
// 与 memories 的关系（审计 §5.3 待定项 2 的结论）：**不双写**。
//   `memory_note(kind:'preference')` 仍然只写 memories（供 context 检索），
//   渲染侧只读 `settings.orchestrator_preferences` 这一个键。理由：双写 = 两份真相，
//   而「渲染侧从不读 memories」只是让它们不打架、不是单一事实源。
//   代价是「记一条偏好 ≠ 偏好生效」，所以 `memory_note` 的返回文案必须说清这件事。
//
// 结构性保证：偏好**不是权限通道**。它只是提示词文本，落库在 settings，不进 config、
// 不改 dispatch、不碰 sandboxPolicy；内置种子里不放任何「放宽安全边界」的条目（维护约束）。
import { createHash } from 'node:crypto'
import { getSetting, setSetting } from './ledger.js'
import { GLOBAL_PROJECT } from './memory.js'

/** settings 键（单键 JSON，与 workspace_repo_index 同一种存法）。 */
export const PREFERENCES_KEY = 'orchestrator_preferences'

/** 渲染预算：字数为主约束（防「一条 2000 字」），条数为安全阀（防「100 条各 10 字」）。
 *  P2-2：条数上限固定成常量（配置键 preferencesMaxItems 已删），只有字数仍可配。
 *  C3：1200/12 → 2400/24。旧口径下「后半条偏好被静默截掉」是 bug（用户存了却不生效、界面上还显示已保存），
 *  2400 字按单条 ≤120 字算可容 24 条，正好和条数安全阀对齐。 */
export const DEFAULT_MAX_CHARS = 2400
export const DEFAULT_MAX_ITEMS = 24
/** 单条规则的字数上限（写入侧截断，渲染侧不再二次切半句）。 */
export const MAX_RULE_CHARS = 120

export const PREFERENCE_CATEGORIES = Object.freeze(['delegation', 'workflow', 'review', 'collab', 'style', 'general'])
const CATEGORY_LABEL = Object.freeze({
  delegation: '派发', workflow: '流程', review: '评审', collab: '协作', style: '风格', general: '通用',
})

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/

/**
 * 出厂种子：**随版本分发**的通用偏好。
 *
 * 维护约束（写在这里而不是文档里，改的人一定会看到）：
 * 1. 只放「触发条件明确、不放宽安全边界」的规则；
 * 2. 每条写成前提从句（「当…时」），不要写成「凡是…都…」；
 * 3. 同 id 的用户条目会**整体覆盖**这里，所以 id 一旦发布就不要改语义。
 */
export const PRESET_PREFERENCES = Object.freeze([
  Object.freeze({
    id: 'cli-access-full',
    category: 'delegation',
    priority: 100,
    source: 'preset',
    rule: '子会话要跑包管理器（pnpm/npm/uv/npx）、写仓库外的用户级缓存或做 --global 安装时，派任务传 access:\'full\'；纯改代码/分析/评审不要传。',
  }),
  Object.freeze({
    id: 'worktree-build-access-full',
    category: 'delegation',
    priority: 90,
    source: 'preset',
    rule: 'worktree 隔离任务的验收含「装依赖/跑测试/跑构建」时，派发就带 access:\'full\'：检出目录没有 node_modules，装依赖必须写 HOME 缓存。',
  }),
])

const text = value => typeof value === 'string' ? value.trim() : ''

/**
 * 归一化偏好条目：坏数据一律**丢弃单条**，不炸整体（与 config 归一化同一种取向）。
 *
 * @param {Array<object>} input 任意来源的条目（settings 里的、内置的、测试塞的）
 * @returns {Array<object>} 合法条目；同 id 后者覆盖前者
 */
export function normalizePreferences(input) {
  const byId = new Map()
  const order = []
  for (const raw of Array.isArray(input) ? input : []) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const id = text(raw.id)
    if (!ID_PATTERN.test(id)) continue
    const rule = text(raw.rule)
    if (rule === '') continue
    const category = PREFERENCE_CATEGORIES.includes(raw.category) ? raw.category : 'general'
    const scope = text(raw.scope) === '' ? 'global' : text(raw.scope)
    const appliesTo = ['coordinator', 'worker', 'both'].includes(raw.appliesTo) ? raw.appliesTo : 'coordinator'
    const priority = Number.isFinite(raw.priority) ? Math.min(1000, Math.max(0, Math.round(raw.priority))) : 50
    const source = ['preset', 'user', 'learned'].includes(raw.source) ? raw.source : 'user'
    const addedAt = Number.isFinite(raw.addedAt) ? raw.addedAt : 0
    const entry = {
      id,
      category,
      rule: rule.length > MAX_RULE_CHARS ? `${rule.slice(0, MAX_RULE_CHARS - 1)}…` : rule,
      scope,
      appliesTo,
      priority,
      enabled: raw.enabled !== false,
      source,
      addedAt,
    }
    if (!byId.has(id)) order.push(id)
    byId.set(id, entry)
  }
  return order.map(id => byId.get(id))
}

/** 读偏好：settings 里的用户条目**整体覆盖**同 id 的内置条目（不是字段级合并）。 */
export function loadPreferences(db) {
  let stored = []
  try {
    const raw = getSetting(db, PREFERENCES_KEY)
    if (typeof raw === 'string' && raw !== '') {
      const parsed = JSON.parse(raw)
      stored = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.items) ? parsed.items : [])
    }
  } catch {
    stored = [] // 坏 JSON 当没有：偏好不能把协调者提示词搞崩。
  }
  const normalized = normalizePreferences(stored)
  const overridden = new Set(normalized.map(item => item.id))
  const seeds = PRESET_PREFERENCES.filter(item => !overridden.has(item.id))
  return normalizePreferences([...seeds, ...normalized])
}

/** 写偏好（覆盖式，与 plan_save 一致：一版、无版本对比/审批流）。 */
export function savePreferences(db, items) {
  const normalized = normalizePreferences(items)
  setSetting(db, PREFERENCES_KEY, JSON.stringify(normalized))
  return normalized
}

/** upsert 单条（同 id 覆盖）；返回写入后的全量。 */
export function upsertPreference(db, item) {
  const current = loadPreferences(db).filter(entry => entry.id !== text(item?.id))
  return savePreferences(db, [...current, item])
}

/** 开关单条内置偏好（用户条目也可以，语义一致）。 */
export function setPreferenceEnabled(db, id, enabled) {
  const target = text(id)
  const current = loadPreferences(db)
  const found = current.find(entry => entry.id === target)
  if (found === undefined) return { ok: false, reason: 'not_found', items: current }
  return {
    ok: true,
    items: savePreferences(db, current.map(entry => (entry.id === target ? { ...entry, enabled: enabled === true } : entry))),
  }
}

/** 可注入的条目：全局 + 启用 + 适用于协调者（项目级偏好属于项目约定，走 brief / context 的项目背景）。 */
const injectableOf = items => (Array.isArray(items) ? items : [])
  .filter(entry => entry.enabled !== false)
  .filter(entry => text(entry.scope) === 'global')
  .filter(entry => entry.appliesTo === 'coordinator' || entry.appliesTo === 'both')

/**
 * 渲染偏好段（L1 第 4 段）。空则返回 `''`（整段消失，不留空标题）。
 *
 * 超限处理：按 priority 降序、同级按 addedAt 新的优先，**保留完整条目**（不切半句），
 * 并在段尾明确写出被截掉几条——「静默丢弃」会让用户以为偏好生效了。
 *
 * @param {Array<object>} items `loadPreferences` 的结果
 * @param {{maxItems?: number, maxChars?: number}} [options]
 */
export function renderPreferenceBlock(items, { maxItems = DEFAULT_MAX_ITEMS, maxChars = DEFAULT_MAX_CHARS } = {}) {
  // 先归一化：出厂种子只写必要字段（id/category/priority/source/rule），scope/appliesTo/enabled
  // 走默认值；不归一化就会因为「scope 缺失」把整段种子筛掉（静默空段最难排）。
  const candidates = injectableOf(normalizePreferences(items))
    .slice()
    .sort((left, right) => right.priority - left.priority || right.addedAt - left.addedAt)
  if (candidates.length === 0) return ''
  const itemCap = Math.max(1, Math.floor(Number.isFinite(maxItems) ? maxItems : DEFAULT_MAX_ITEMS))
  const charCap = Math.max(1, Math.floor(Number.isFinite(maxChars) ? maxChars : DEFAULT_MAX_CHARS))
  const head = [
    '## 偏好（预制 + 用户保存，优先级低于上面的硬规则）',
    '',
    '以下是出厂预制或用户保存的默认取向，用来省掉重复交代；它们**不覆盖**上面的硬性规则、平台沙箱与审批门禁、',
    '工具可用性，也不覆盖 AGENTS.md 或用户当场的明确要求——冲突时以更硬、更具体的那条为准，并在回复里说明你按哪条做。',
  ]
  const kept = []
  let chars = head.join('\n').length
  for (const entry of candidates) {
    if (kept.length >= itemCap) break
    const line = `- [${CATEGORY_LABEL[entry.category] ?? '通用'}] ${entry.rule}`
    if (kept.length > 0 && chars + line.length + 1 > charCap) break
    // 第一条无论多长都要留下（否则整段可能因为一条超长规则变成空段）。
    kept.push(line)
    chars += line.length + 1
  }
  const omitted = candidates.length - kept.length
  const lines = [...head, '', ...kept]
  if (omitted > 0) lines.push('', `（另有 ${omitted} 条偏好因超限未展示：提高 preferencesMaxChars 或停用部分条目）`)
  return lines.join('\n')
}

/**
 * 偏好写入的路由规则（审计 §5.3 待定项 2 的「不双写」落实方式）。
 *
 * 一条事实只落**一处**，落哪儿由 scope 决定，不存在两份真相：
 *   - **全局偏好**（`project` 缺省 / `global`）= 协调者的行为取向 → 只写 `settings.orchestrator_preferences`，
 *     每回合注入 L1 提示词。它**不写** memories（否则就是双写），所以 `context({ mode: 'history' })` 查不到它。
 *   - **项目偏好**（给了 `project`）= 项目约定 → 只写 memories，随 `task_detail` 注入子会话；
 *     它不进协调者提示词（协调者没有单一项目上下文，项目多了会撑爆 policy）。
 *
 * 为什么不是「双写 + 渲染侧只读 settings」：那只是让两份数据不打架，不是单一事实源；
 * 用户改了一处、另一处还是旧值，排障时无法回答「偏好到底以哪份为准」。
 */
export const PREFERENCE_SCOPE_GLOBAL = 'global'

/** `memory_note` 的返回文案：说清这条偏好去了哪儿、会不会生效、预算多少，别让人以为「记了就生效」。 */
export const preferenceSavedHint = title => `已保存为协调者偏好（${title ?? '全局'}）：`
  + '每回合注入协调者提示词，改完下一回合生效；它不进 memories（context 检索查不到，避免两份真相）。'
  + `注入预算：最多 ${DEFAULT_MAX_ITEMS} 条 / ${DEFAULT_MAX_CHARS} 字（超出部分不注入，界面上仍保留）；`
  + '要停用请把对应条目 enabled 设为 false。'

/** 项目偏好的返回文案：走 memories + task_detail，不进协调者提示词。 */
export const projectPreferenceSavedHint = title => `已保存为项目偏好（${title ?? '本项目'}）：`
  + '随 task_detail 注入子会话，不进协调者提示词（协调者没有单一项目上下文）。'

/** 偏好条数/字数的生效预算摘要（返回给协调者，让「超限被截」可见）。 */
export function preferenceBudgetLine(items, { maxItems = DEFAULT_MAX_ITEMS, maxChars = DEFAULT_MAX_CHARS } = {}) {
  const injectable = injectableOf(normalizePreferences(items))
  return `当前 ${injectable.length} 条可注入偏好（上限 ${maxItems} 条 / ${maxChars} 字）`
}

// ---- 旧全局偏好迁移（审计 §2.5 缺陷 3 + §7 第 7 条） --------------------------------
//
// 背景：0.19.0 之前 `memory_note(kind:'preference', 不传 project)` 写的是 memories 的 global 行，
// 渲染侧却只读 `settings.orchestrator_preferences` → 那 3 条「记了却永不生效」的死数据（实测 11-15 写的
// present 展示数量 / 汇报用任务名）。这里启动时一次性搬进 settings，并用幂等标记保证只跑一次。
//
// 两个细节（都是审计点名的）：
//   1. **取更正后的版本**：旧数据里 present 有两条（1–2 与后来的「更正上一条…1–4」）。迁移时把带更正
//      标记的那条视为旧条目的替代（共享关键 token ≥3 判同主题），设置里只留更正版。
//   2. **不双写**：写到 settings 成功后把这些 global preference 行从 memories 删掉（否则 context 检索
//      会同时看到 1–2 和 1–4 两条互相打架的「事实」）。删了什么写进日志，可回查。
export const PREFERENCES_MIGRATED_KEY = 'orchestrator_preferences_migrated'
/** 更正标记：出现这些词的那条视为对前面某条规则的修订。 */
const CORRECTION_MARKER = /(更正|修正|纠正|推翻|不再用)/

const normalizeRule = rule => String(rule ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
// 主题比较用的分词：与检索的 `memoryTokens` 不同——这里**不截断**（检索只取前 12 个词，
// 长规则里真正有辨识度的词（present、产物、展示数量）会被截在窗口外，主题相似度就算不出来）。
const topicTokens = value => {
  const raw = String(value ?? '').toLowerCase()
  const tokens = []
  for (const run of raw.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length <= 2) tokens.push(run)
    else for (let index = 0; index < run.length - 1; index += 1) tokens.push(run.slice(index, index + 2))
  }
  for (const word of raw.match(/[a-z0-9][a-z0-9_-]*/g) ?? []) {
    if (word.length >= 2) tokens.push(word)
  }
  return [...new Set(tokens)]
}
const sharedTokenCount = (left, right) => {
  const rightTokens = new Set(topicTokens(right))
  return topicTokens(left).filter(token => rightTokens.has(token)).length
}

/** 在已保留条目里找「最像被更正」的那条：共享关键词 ≥3 才认。 */
function bestCorrectionTarget(entries, rule) {
  let best = -1
  let bestShared = 0
  entries.forEach((entry, index) => {
    const shared = sharedTokenCount(rule, entry.rule)
    if (shared > bestShared) {
      bestShared = shared
      best = index
    }
  })
  return bestShared >= 3 ? best : -1
}

/**
 * 把 memories 里的 global preference 一次性迁进 settings（幂等：`settings.orchestrator_preferences_migrated`）。
 *
 * @param {{db: object, log?: Function, now?: number}} options
 * @returns {{ migrated: number, skipped: boolean, reason?: string, rules?: string[], deletedMemories?: number }}
 */
export function migrateLegacyPreferences({ db, log = () => {}, now = Date.now() } = {}) {
  let marker = ''
  try {
    marker = text(getSetting(db, PREFERENCES_MIGRATED_KEY))
  } catch {
    return { migrated: 0, skipped: true, reason: 'settings-unavailable' }
  }
  if (marker !== '') return { migrated: 0, skipped: true, reason: 'already-migrated' }
  let rows = []
  try {
    rows = db.prepare("SELECT id, text, created_at FROM memories WHERE project_key = ? AND kind = 'preference' ORDER BY created_at ASC, rowid ASC")
      .all(GLOBAL_PROJECT)
  } catch {
    rows = []
  }
  const candidates = rows
    .map(row => ({ id: row.id, rule: text(row.text), createdAt: Number(row.created_at) || 0 }))
    .filter(item => item.rule !== '')
  const stamp = new Date(now).toISOString()
  const finish = (result) => {
    try { setSetting(db, PREFERENCES_MIGRATED_KEY, stamp) } catch { /* 标记写不进去就下次再跑（迁移是幂等的） */ }
    return result
  }
  // 没有旧数据就**什么都不写**（连标记也不写）：加载插件不该为了「扫了一遍」去动 settings。
  // 没有旧行时再跑一次也只是同一条 SELECT，代价可忽略。
  if (candidates.length === 0) return { migrated: 0, skipped: false, reason: 'no-legacy', rules: [] }

  // 1) 去重 + 更正合并：同一文本只留最新一条；带更正标记的替换掉它指向的旧条目。
  const kept = []
  const superseded = []
  for (const item of candidates) {
    if (CORRECTION_MARKER.test(item.rule)) {
      const target = bestCorrectionTarget(kept, item.rule)
      if (target >= 0) superseded.push(kept.splice(target, 1)[0])
    }
    const duplicate = kept.findIndex(entry => entry.rule === item.rule || normalizeRule(entry.rule) === normalizeRule(item.rule))
    if (duplicate >= 0) {
      if (item.createdAt >= kept[duplicate].createdAt) kept[duplicate] = item
      continue
    }
    kept.push(item)
  }

  // 2) 写 settings（一条失败不拦其它条；有失败就不写标记、不删 memories，下次启动重试）。
  let migrated = 0
  for (const item of kept) {
    try {
      upsertPreference(db, {
        id: `p-${createHash('sha256').update(item.rule).digest('hex').slice(0, 8)}`,
        category: 'general',
        rule: item.rule,
        scope: 'global',
        appliesTo: 'coordinator',
        priority: 50,
        source: 'user',
        addedAt: item.createdAt || now,
      })
      migrated += 1
    } catch { /* 单条写失败：不写标记，下次重试 */ }
  }
  if (migrated !== kept.length) {
    return { migrated, skipped: false, reason: 'partial', rules: kept.map(item => item.rule) }
  }

  // 3) 搬走后的旧行从 memories 删掉（含被更正掉的旧版）：settings 是唯一事实源，不留两份真相。
  let deletedMemories = 0
  try {
    const remove = db.prepare('DELETE FROM memories WHERE id = ?')
    for (const item of candidates) deletedMemories += Number(remove.run(item.id).changes) || 0
  } catch { /* 删不掉就留着：settings 已生效，下次启动标记已在，不会再迁一次 */ }

  log('memory.preferences.migrated', {
    detail: {
      migrated,
      deletedMemories,
      rules: kept.map(item => item.rule),
      superseded: superseded.map(item => item.rule),
    },
  })
  return finish({
    migrated,
    skipped: false,
    rules: kept.map(item => item.rule),
    deletedMemories,
    superseded: superseded.map(item => item.rule),
  })
}
