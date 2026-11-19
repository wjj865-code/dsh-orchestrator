// 配置归一化：非法值一律回落默认，不让坏配置把插件带崩。
import { DEFAULT_WATCHDOG_IDLE_MINUTES, DEFAULT_WATCHDOG_INTERVAL_MINUTES } from './watchdog.js'
import { DEFAULT_BRANCH_PREFIX, WORKTREE_POLICIES } from './worktree-request.js'
import { guardModeOf } from './write-guard.js'
import { DELIVERED_TIMEOUT_MINUTES } from './delivered.js'
import { normalizeRotationConfig } from './main-rotation.js'
import { DEFAULT_MAX_CHARS as DEFAULT_PREFERENCE_MAX_CHARS } from './preferences.js'

/**
 * 已删除的配置键（P1-A 41 → 35、P2-2 35 → 28）→ 迁移提示。
 * 读到就 warn 一次（进程级按 key 去重），**值一律不回填**：旧配置不会「看起来还在」，
 * 而是明确告诉用户该改什么/哪个键已经不起作用。迁移说明见 CHANGELOG「0.23.0」段。
 */
export const DEPRECATED_KEYS = Object.freeze({
  backend: '派发后端只剩 subagent；team 后端在 P0-1 已随平台 API 删除',
  rotateAfterTasks: '轮换只剩「主日志体积 / 运行天数」两个触发因子',
  rotateAfterSessions: '轮换只剩「主日志体积 / 运行天数」两个触发因子',
  rotateAfterContextTokens: '轮换只剩「主日志体积 / 运行天数」两个触发因子',
  rotateAfterDiskMiB: '轮换只剩「主日志体积 / 运行天数」两个触发因子',
  rotateCheckIntervalHours: '检查节流已删除：每次打开主会话都会现算（没有「一天最多查一次」了）',
  // P2-2：自建 keep-alive 续跑器删除，续跑改为委托宿主 goal 轮次驱动（task_create.goalRounds）。
  keepAlive: '续跑改由宿主 goal 轮次驱动：删掉本键，要续跑请用 task_create({ goalRounds: N })（默认 0 = 不续跑）',
  keepAliveMode: '续跑不再由插件注入消息：宿主 goal driver 的回合形态不归插件管',
  keepAliveMaxRounds: '轮数预算改由 task_create({ goalRounds: N })（1–50，默认 0 = 不续跑）按任务声明',
  keepAlivePrompt: '插件不再生成续跑提示：目标正文与「最新指示」都在平台 goal 里，由宿主 driver 续轮',
  // P2-2：三个纯阈值/安全阀固定成常量（现场没有调参需求，留着只会变成「同一事实两处配置」）。
  mergeWindowMs: '完成通知的合并窗口固定 5000 ms（通知仍按任务合并，只是不再可调）',
  stallRounds: '「连续 N 次 progress 无变化」的提醒口径固定为 3 次',
  preferencesMaxItems: '偏好段条数上限固定 12 条（字数主约束 preferencesMaxChars 仍可配）',
})

const warnedDeprecated = new Set()

/** 测试用：清空「已 warn 过」的去重表（去重是进程级的，会跨用例生效）。 */
export function resetDeprecatedKeyWarnings() {
  warnedDeprecated.clear()
}

/** 命中旧键就各键 warn 一次；没有 onWarn（纯函数场景/单测）就静默。 */
function warnDeprecatedKeys(raw, onWarn) {
  if (typeof onWarn !== 'function') return
  if (raw === null || typeof raw !== 'object') return
  for (const [key, note] of Object.entries(DEPRECATED_KEYS)) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue
    if (warnedDeprecated.has(key)) continue
    warnedDeprecated.add(key)
    onWarn(`dsh-orchestrator: 配置键 ${key} 已删除（${note}）；本次按默认值运行，请从 profile 里删掉它`)
  }
}

const DEFAULTS = {
  staleMinutes: 30,
  memoryLimit: 3,
  snapshotRetentionDays: 7,
  watchdogIntervalMinutes: DEFAULT_WATCHDOG_INTERVAL_MINUTES,
  watchdogIdleMinutes: DEFAULT_WATCHDOG_IDLE_MINUTES,
}

// 子会话默认用插件自带的 worker 预设；调试时可换成副本（如 orch-debug）。
// 平台对 preset id 的要求是小写字母/数字/连字符，非法值一律回落默认，避免派发时才报组合失败。
export const DEFAULT_WORKER_PRESET = 'dsh-orchestrator-worker'
const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/

const nonEmpty = (value, fallback) =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback

const positive = (value, fallback) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback

// 分钟数：只认正整数，1–1440（一天）；超界夹到边界，其余回落默认。
const minutes = (value, fallback) => {
  const valid = positive(value, undefined)
  return valid === undefined ? fallback : Math.min(1440, Math.max(1, Math.floor(valid)))
}

export function loadConfig(raw = {}, { onWarn } = {}) {
  warnDeprecatedKeys(raw, onWarn)
  const config = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS)) {
    config[key] = positive(raw?.[key], DEFAULTS[key])
  }
  config.spawnProvider = nonEmpty(raw?.spawnProvider, 'spawn')
  // workerPreset 透传给子会话启动（dispatch 的 agentPreset 通道）；只认合法 preset id。
  const workerPreset = nonEmpty(raw?.workerPreset, DEFAULT_WORKER_PRESET)
  config.workerPreset = PRESET_ID.test(workerPreset) ? workerPreset : DEFAULT_WORKER_PRESET
  config.maxQueue = Number.isFinite(raw?.maxQueue) && raw.maxQueue >= 1 ? Math.floor(raw.maxQueue) : 50
  config.autoResumeQueue = raw?.autoResumeQueue !== false
  config.coordinatorSession = nonEmpty(raw?.coordinatorSession, undefined)
  // 记忆注入默认开，只有显式 false 才关；条数限制在 1-10，快照保留 1-30 天。
  config.memoryInject = raw?.memoryInject !== false
  config.memoryLimit = Number.isFinite(raw?.memoryLimit) && raw.memoryLimit >= 1
    ? Math.min(10, Math.floor(raw.memoryLimit))
    : DEFAULTS.memoryLimit
  config.snapshotRetentionDays = Number.isFinite(raw?.snapshotRetentionDays) && raw.snapshotRetentionDays >= 1
    ? Math.min(30, Math.floor(raw.snapshotRetentionDays))
    : DEFAULTS.snapshotRetentionDays
  // 每日日报默认关闭；配置 HH:MM 才启用（例如 "09:00"）。
  config.digestAt = typeof raw?.digestAt === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(raw.digestAt.trim())
    ? raw.digestAt.trim()
    : ''
  config.digestTimeZone = nonEmpty(raw?.digestTimeZone, '')
  // 空闲看门狗（W1）：默认开；巡检默认 5 分钟、running 空闲超过 15 分钟告警一次，两个值都按分钟配。
  config.idleWatchdog = raw?.idleWatchdog !== false
  config.watchdogIntervalMinutes = minutes(raw?.watchdogIntervalMinutes, DEFAULTS.watchdogIntervalMinutes)
  config.watchdogIdleMinutes = minutes(raw?.watchdogIdleMinutes, DEFAULTS.watchdogIdleMinutes)
  // 两段式终态（D1）：交付后等确认的超时（分钟，1–1440）；超时自动收成 done。
  // 设成 1 分钟约等于退回「交付即完成」的旧行为，作为现场降级旋钮。
  config.deliveredTimeoutMinutes = minutes(raw?.deliveredTimeoutMinutes, DELIVERED_TIMEOUT_MINUTES)
  // 回合间续跑（P2-2）：不再有 keepAlive* 配置——续跑交给宿主 goal 轮次驱动，
  // 按任务用 task_create({ goalRounds }) 声明（默认 0 = 不续跑，与旧默认完全一致）。
  // 同写域并发防护：同一 target 目录 / 同一写域上再派一个**未隔离**的可写任务时怎么处理。
  // require（默认）= 拒绝并给可操作错误（三条出路：task_message({action:'close'}) / worktree:true / allowConcurrent:true）；
  // warn = 只给强警告照常创建；off = 关闭（writeScopes 退回旧的 advisory 提示）。
  // 非法值（含拼错）一律回落 require —— 默认必须安全，不能因为配置写错就放开。
  config.sameDirGuard = guardModeOf(raw?.sameDirGuard)
  // P9 worktree 隔离：用户级**结构化**默认（渲染进协调者 policy，并在 task_create 没传 worktree 时兜底）。
  // required = 每个需求都隔离；auto = 默认不隔离、满足三条件才建议；off = 一律不隔离。
  config.worktreePolicy = WORKTREE_POLICIES.includes(raw?.worktreePolicy) ? raw.worktreePolicy : 'auto'
  config.worktreeBranchPrefix = nonEmpty(raw?.worktreeBranchPrefix, DEFAULT_BRANCH_PREFIX)
  // 「近期活跃分支」窗口（天）：1–90，越界夹到边界，非法回落 7。
  config.worktreeRecentDays = Number.isFinite(raw?.worktreeRecentDays)
    ? Math.min(90, Math.max(1, Math.floor(raw.worktreeRecentDays)))
    : 7
  // 偏好（审计 §5.3 待定项 3）：**字数为主约束、条数为安全阀**。
  // 纯条数防不住「一条 2000 字」，纯字数防不住「100 条各 10 字」的碎片化。
  // 条数上限 P2-2 起固定为 preferences.js 的 DEFAULT_MAX_ITEMS（12），只留字数可配。
  // preferencesInject:false 让整段消失（默认开：出厂种子就是给协调者用的）。
  config.preferencesInject = raw?.preferencesInject !== false
  config.preferencesMaxChars = Number.isFinite(raw?.preferencesMaxChars)
    ? Math.min(4000, Math.max(200, Math.floor(raw.preferencesMaxChars)))
    : DEFAULT_PREFERENCE_MAX_CHARS
  // 主会话轮换（G1 S1，P1-A 收缩到 7 个键）：总开关 + 两个触发阈值（主日志体积 / 运行天数）
  // + 保护（冷却/最小龄/闲置）+ 归档开关。默认值、合法区间与非法回落都在 src/main-rotation.js 的
  // normalizeRotationConfig 里，这里只负责挂到 config 上。
  Object.assign(config, normalizeRotationConfig(raw))
  return config
}
