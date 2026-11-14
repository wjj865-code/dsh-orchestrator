// 配置归一化：非法值一律回落默认，不让坏配置把插件带崩。
const DEFAULTS = {
  staleMinutes: 30,
  stallRounds: 3,
  mergeWindowMs: 5000,
  memoryLimit: 3,
  snapshotRetentionDays: 7,
}

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
  return config
}
