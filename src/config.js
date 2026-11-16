// 配置归一化：非法值一律回落默认，不让坏配置把插件带崩。
import { DEFAULT_WATCHDOG_IDLE_MINUTES, DEFAULT_WATCHDOG_INTERVAL_MINUTES } from './watchdog.js'
import { DEFAULT_BRANCH_PREFIX, WORKTREE_POLICIES } from './worktree-request.js'
import { guardModeOf } from './write-guard.js'
import { DELIVERED_TIMEOUT_MINUTES } from './delivered.js'
import { normalizeRotationConfig } from './main-rotation.js'

const DEFAULTS = {
  staleMinutes: 30,
  stallRounds: 3,
  mergeWindowMs: 5000,
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

export function loadConfig(raw = {}) {
  const config = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS)) {
    config[key] = positive(raw?.[key], DEFAULTS[key])
  }
  config.spawnProvider = nonEmpty(raw?.spawnProvider, 'spawn')
  // workerPreset 透传给子会话启动（dispatch 的 agentPreset 通道）；只认合法 preset id。
  const workerPreset = nonEmpty(raw?.workerPreset, DEFAULT_WORKER_PRESET)
  config.workerPreset = PRESET_ID.test(workerPreset) ? workerPreset : DEFAULT_WORKER_PRESET
  config.backend = raw?.backend === 'team' ? 'team' : 'subagent'
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
  // 回合间 keep-alive（K2）：默认关闭——升级后行为不能突变，也不能替用户决定「自动续跑」。
  // 开启后只对「running + 平台 goal 未完成」的子任务在 turn-stopping 时注入下一轮，轮数上限 1–50。
  config.keepAlive = raw?.keepAlive === true  // 默认 steer（同 turn 再走一步，平台 turn-stopping 文档契约）；followup 是「新一轮」，会写 turn/end。
  config.keepAliveMode = raw?.keepAliveMode === 'followup' ? 'followup' : 'steer'
  config.keepAliveMaxRounds = Number.isFinite(raw?.keepAliveMaxRounds)
    ? Math.min(50, Math.max(1, Math.floor(raw.keepAliveMaxRounds)))
    : 8
  config.keepAlivePrompt = nonEmpty(raw?.keepAlivePrompt, '')
  // 同写域并发防护：同一 target 目录 / 同一写域上再派一个**未隔离**的可写任务时怎么处理。
  // require（默认）= 拒绝并给可操作错误（三条出路：task_close / worktree:true / allowConcurrent:true）；
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
  // 主会话轮换（G1 S1）：11 个键（总开关 + 六个因子阈值 + 冷却/最小龄/闲置 + 归档开关）
  // 的默认值、合法区间与非法回落都在 src/main-rotation.js 的 normalizeRotationConfig 里，
  // 这里只负责挂到 config 上；S1 不接任何调用点，因此行为零变化。
  Object.assign(config, normalizeRotationConfig(raw))
  return config
}
