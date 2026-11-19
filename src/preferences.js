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
import { getSetting, setSetting } from './ledger.js'

/** settings 键（单键 JSON，与 workspace_repo_index 同一种存法）。 */
export const PREFERENCES_KEY = 'orchestrator_preferences'

/** 渲染预算：字数为主约束（防「一条 2000 字」），条数为安全阀（防「100 条各 10 字」）。
 *  P2-2：条数上限固定成常量（配置键 preferencesMaxItems 已删），只有字数仍可配。 */
export const DEFAULT_MAX_CHARS = 1200
export const DEFAULT_MAX_ITEMS = 12
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

/** `memory_note` 的返回文案：说清这条偏好去了哪儿、会不会生效，别让人以为「记了就生效」。 */
export const preferenceSavedHint = title => `已保存为协调者偏好（${title ?? '全局'}）：`
  + '每回合注入协调者提示词，改完下一回合生效；它不进 memories（context 检索查不到，避免两份真相）。'
  + '要停用请把对应条目 enabled 设为 false。'

/** 项目偏好的返回文案：走 memories + task_detail，不进协调者提示词。 */
export const projectPreferenceSavedHint = title => `已保存为项目偏好（${title ?? '本项目'}）：`
  + '随 task_detail 注入子会话，不进协调者提示词（协调者没有单一项目上下文）。'

/** 偏好条数/字数的生效预算摘要（返回给协调者，让「超限被截」可见）。 */
export function preferenceBudgetLine(items, { maxItems = DEFAULT_MAX_ITEMS, maxChars = DEFAULT_MAX_CHARS } = {}) {
  const injectable = injectableOf(normalizePreferences(items))
  return `当前 ${injectable.length} 条可注入偏好（上限 ${maxItems} 条 / ${maxChars} 字）`
}
