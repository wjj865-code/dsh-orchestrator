// 配置归一化：非法值一律回落默认，不让坏配置把插件带崩。
const DEFAULTS = {
  staleMinutes: 30,
  stallRounds: 3,
  mergeWindowMs: 5000,
  memoryLimit: 3,
  snapshotRetentionDays: 7,
}

// 子会话默认用插件自带的 worker 预设；调试时可换成副本（如 orch-debug）。
// 平台对 preset id 的要求是小写字母/数字/连字符，非法值一律回落默认，避免派发时才报组合失败。
export const DEFAULT_WORKER_PRESET = 'dsh-orchestrator-worker'
const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/

const nonEmpty = (value, fallback) =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback

const positive = (value, fallback) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback

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
  return config
}
