// 配置归一化：非法值一律回落默认，不让坏配置把插件带崩。
const DEFAULTS = {
  staleMinutes: 30,
  stallRounds: 3,
  maxActive: 8,
  mergeWindowMs: 5000,
}

const positive = (value, fallback) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback

export function loadConfig(raw = {}) {
  const config = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS)) {
    config[key] = positive(raw?.[key], DEFAULTS[key])
  }
  config.coordinatorSession = typeof raw?.coordinatorSession === 'string' && raw.coordinatorSession !== ''
    ? raw.coordinatorSession
    : undefined
  return config
}
