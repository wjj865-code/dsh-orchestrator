// 主会话上下文观测 + 压力提醒（0.25.0「宿主自压 + 插件只提醒 + 手动 adopt」）：**不代压**。
//
// 分工（改动前先读）：
//   - **压缩**完全归宿主 compaction-basic（`agent/pre-step` 压力 / `agent/request-error` 溢出恢复，
//     阈值 thresholdRatio 默认 0.8，挂在每个 agent 预设的 isolate 组里）。插件**不调用 compactNow、
//     不写宿主阈值、不重试**。
//   - **插件只做两件事**：①观测（压力 / 日志体积 / 压缩次数）②压力达到**插件自己的提醒阈值**
//     （配置键 `contextPressureThreshold`，默认 0.4）时**弹一张问题卡**问用户「要不要换新协调者会话」。
//   - 用户的答案只有三个出口：去新建（插件代建并 adopt）、继续当前会话（抬 band）、稍后再说（静默）。
//     三个出口都**不改宿主压缩行为**，也不碰子会话。
//
// 数据来源（都可按任意会话取，不绑死主会话）：
//   1. 压力：`tokenMeter.contextPressure(session)` → { pressureTokens, contextWindow }；
//   2. 日志体积：`sessionPersistence.locate({ id, cwd })` + `stat`；
//   3. 压缩次数/最近一次：`sessionQuery.observeSession(sessionId).events` 里的 `compaction/*` 事件
//      （`data.turn === null` = 手动 /compact，数字 = 宿主自动）。
//
// 去重与节流（避免每回合刷屏）：
//   - 只在「打开主会话」时算一次压力（open 后异步、不阻塞），结果进内存缓存；
//   - settings `main_context_alert = { at, ratio, band, state }`：同一 band（0.1 步长）只问一次；
//     压力回落到 `阈值 − 0.05` 以下才清 alert，允许下一段再问；
//   - 提问/代建进行中不重复弹（进程内 busy 标志）。
import { stat } from 'node:fs/promises'
import { deleteSetting, getSetting, setSetting } from './ledger.js'

const MIB = 1024 * 1024

/** 日志软阈值（MiB）：超过它给一次「该换新会话了」的提示（提示过就记标记，不重复弹）。 */
export const MAIN_LOG_HINT_MIB = 16

/** 「16 MiB 提示已弹过」的 settings 键。 */
export const MAIN_LOG_HINT_KEY = 'main_log_hint_shown'

/** 压力提醒的去重状态（只存这一条事实，不存判定结论）。 */
export const MAIN_CONTEXT_ALERT_KEY = 'main_context_alert'

/** 提醒阈值默认值 / 区间（与 src/config-fields.js 的字段规格同源，由单测守）。 */
export const CONTEXT_PRESSURE_THRESHOLD_DEFAULT = 0.4
export const CONTEXT_PRESSURE_THRESHOLD_MIN = 0.1
export const CONTEXT_PRESSURE_THRESHOLD_MAX = 0.95

/** band 步长与滞回：0.4 → 0.5 → 0.6 各问一次；回落到 阈值−0.05 才重新武装。 */
export const ALERT_BAND_STEP = 0.1
export const ALERT_HYSTERESIS = 0.05

/** 问题卡三个选项（label 就是答案值，改文案时同步 src/copy.js 与文档）。 */
export const ALERT_OPTION_CREATE = '新建协调者会话'
export const ALERT_OPTION_CONTINUE = '继续当前会话'
export const ALERT_OPTION_LATER = '稍后再说'

/** 宿主 compaction-basic 的默认压力比（读不到宿主实际配置时的兜底；只用于展示，不参与任何判定）。 */
export const HOST_DEFAULT_THRESHOLD_RATIO = 0.8

/**
 * 0.25.0 之前「主会话轮换」写过的 settings 键（只清理、不再读）。
 * `main_rotation_pending` 是崩溃锚点，**必须**清掉：留着的话，将来回滚到旧版本会按它「补完轮换」
 * 去归档一个毫不相干的会话。
 */
export const LEGACY_ROTATION_KEYS = Object.freeze([
  'main_session_created_at',
  'main_rotation_at',
  'main_rotation_last',
  'main_rotation_pending',
  'main_rotation_checked_at',
])

const errorText = error => `${error?.message ?? error}`

const millisOf = value => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string' || value.trim() === '') return null
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

const positive = value => (Number.isFinite(value) && value > 0 ? value : null)

const pct = value => (Number.isFinite(value) ? Math.round(value * 100) : null)

/**
 * 读一次上下文压力。**参数是 session 对象**（任意存活会话都能传，不绑死主会话）：
 * 以后要把观测范围扩到「所有存活会话」，只需要遍历 `ctx.sessions.list()` 逐个调用它。
 * @param {object} opts
 * @param {object} [opts.session] 存活会话（`agent.session` / `ctx.sessions.get(id)`）
 * @param {object} [opts.tokenMeter] 平台 tokenMeter 服务
 * @returns {{pressureTokens:number|null, contextWindow:number|null, ratio:number|null, degraded:string[]}}
 */
export function readContextPressure({ session, tokenMeter } = {}) {
  const degraded = []
  const result = { pressureTokens: null, contextWindow: null, ratio: null, degraded }
  if (session === undefined || session === null) {
    degraded.push('session-missing')
    return result
  }
  if (tokenMeter === undefined || tokenMeter === null || typeof tokenMeter.contextPressure !== 'function') {
    degraded.push('token-meter-missing')
    return result
  }
  try {
    const pressure = tokenMeter.contextPressure(session)
    result.pressureTokens = Number.isFinite(pressure?.pressureTokens) ? pressure.pressureTokens : null
    result.contextWindow = positive(pressure?.contextWindow)
    if (result.pressureTokens === null || result.contextWindow === null) degraded.push('pressure-unknown')
  } catch (error) {
    degraded.push('pressure-failed')
    result.error = errorText(error)
    return result
  }
  if (result.pressureTokens !== null && result.contextWindow !== null) {
    result.ratio = result.pressureTokens / result.contextWindow
  }
  return result
}

const defaultStatFile = async path => {
  const info = await stat(path)
  return { size: info.size, mtimeMs: info.mtimeMs }
}

/**
 * 读主会话日志体积（压缩后大小，MiB）。失败 = 未知（null），不按 0 算。
 * @returns {Promise<{logMiB:number|null, logPath:string|null, degraded:string|null}>}
 */
export async function readLogSize({ session, persistence, statFile = defaultStatFile } = {}) {
  const header = session?.header
  if (persistence === undefined || persistence === null || typeof persistence.locate !== 'function') {
    return { logMiB: null, logPath: null, degraded: 'persistence-missing' }
  }
  if (typeof header?.id !== 'string' || typeof header?.cwd !== 'string') {
    return { logMiB: null, logPath: null, degraded: 'header-missing' }
  }
  try {
    const located = persistence.locate({ id: header.id, cwd: header.cwd })
    const path = located?.path
    if (typeof path !== 'string' || path === '') throw new Error('locate 没有返回日志路径')
    const info = await statFile(path)
    if (!Number.isFinite(info?.size)) throw new Error('stat 没有返回 size')
    return { logMiB: info.size / MIB, logPath: path, degraded: null }
  } catch (error) {
    return { logMiB: null, logPath: null, degraded: errorText(error) }
  }
}

/**
 * 从会话事件里数压缩次数（`compaction/start` 的 `data.turn`：null = 手动、数字 = 宿主自动）。
 * 数据来自宿主 `sessionQuery.observeSession()`（live 优先，非存活会话也能读，代价是一次日志装载）。
 * 失败只降级为「未知」，绝不影响面板其它分区。
 */
export async function readCompactionStats({ sessionId, sessionQuery, log = () => {} } = {}) {
  const empty = { manual: null, auto: null, lastAt: null, lastKind: null, lastShadowedTokens: null, degraded: null }
  if (typeof sessionId !== 'string' || sessionId === '') return { ...empty, degraded: 'no-session' }
  if (sessionQuery === undefined || sessionQuery === null || typeof sessionQuery.observeSession !== 'function') {
    return { ...empty, degraded: 'session-query-missing' }
  }
  let observation
  try {
    observation = await sessionQuery.observeSession(sessionId, { projectionMode: 'none' })
    const events = Array.isArray(observation?.events) ? observation.events : []
    let manual = 0
    let auto = 0
    let lastAt = null
    let lastKind = null
    let lastShadowedTokens = null
    for (const event of events) {
      if (event?.type === 'compaction/start') {
        if (event.data?.turn === null || event.data?.turn === undefined) manual += 1
        else auto += 1
        lastAt = Number.isFinite(event.time) ? event.time : lastAt
        lastKind = event.data?.turn === null || event.data?.turn === undefined ? 'manual' : 'auto'
        lastShadowedTokens = null
      } else if (event?.type === 'compaction/summary') {
        if (Number.isFinite(event.data?.shadowedTokenCount)) lastShadowedTokens = event.data.shadowedTokenCount
      }
    }
    return { manual, auto, lastAt, lastKind, lastShadowedTokens, degraded: null }
  } catch (error) {
    log('main.context.compaction-stats.failed', { detail: { sessionId, error: errorText(error) } })
    return { ...empty, degraded: errorText(error) }
  } finally {
    try { observation?.[Symbol.dispose]?.() } catch { /* 释放失败不阻断 */ }
  }
}

/**
 * 只读探测压缩能力（**不触发任何动作**）：`serviceFor(agent,'compaction')` 是否取到实例、
 * `compactNow` 是否存在、能否读到宿主自己的 `thresholdRatio` / `auto`。
 *
 * 事实依据（rc.5）：`BasicCompactionEngine` 有 public `readonly config: ResolvedConfig`
 * （dsh-compaction-basic/src/index.ts:129-130，含 thresholdRatio/auto，见 src/types.ts:59-73）；
 * cordis 的 Service 不加 invoke 时注册的就是原对象（cordis/src/service.ts:45-58）——
 * **真机未验证**，读不到就退回默认值并注明来源。
 */
export function probeCompaction({ agent, agentPresets, tokenMeter } = {}) {
  const result = {
    available: false,
    compactNow: false,
    thresholdRatio: HOST_DEFAULT_THRESHOLD_RATIO,
    thresholdSource: 'assumed-default',
    auto: null,
    reason: null,
  }
  if (agent === undefined || agent === null) return { ...result, reason: 'no-agent' }
  if (agentPresets === undefined || agentPresets === null || typeof agentPresets.serviceFor !== 'function') {
    return { ...result, reason: 'agent-presets-missing' }
  }
  let engine
  try {
    engine = agentPresets.serviceFor(agent, 'compaction')
  } catch (error) {
    return { ...result, reason: `service-for-failed: ${errorText(error)}` }
  }
  if (engine === undefined || engine === null) return { ...result, reason: 'compaction-not-mounted' }
  result.available = true
  result.compactNow = typeof engine.compactNow === 'function'
  try {
    const hostConfig = engine.config
    if (Number.isFinite(hostConfig?.thresholdRatio) && hostConfig.thresholdRatio > 0) {
      result.thresholdRatio = hostConfig.thresholdRatio
      result.thresholdSource = 'host'
    } else {
      result.thresholdSource = 'assumed-default(host-field-missing)'
    }
    if (typeof hostConfig?.auto === 'boolean') result.auto = hostConfig.auto
  } catch (error) {
    result.thresholdSource = `assumed-default(read-failed: ${errorText(error)})`
  }
  if (tokenMeter === undefined || tokenMeter === null || typeof tokenMeter.contextPressure !== 'function') {
    result.reason = 'token-meter-missing'
  }
  return result
}

/** 清掉 0.25.0 之前轮换留下的 settings 键（一次性）。单个失败不影响其它；有删除才写一条审计。 */
export function cleanupLegacyRotation({ db, log = () => {} } = {}) {
  const removed = []
  for (const key of LEGACY_ROTATION_KEYS) {
    try {
      if (getSetting(db, key) === undefined) continue
      deleteSetting(db, key)
      removed.push(key)
    } catch { /* 单个键失败：其余继续，下次启动再试 */ }
  }
  if (removed.length > 0) log('main.rotation.legacy-cleaned', { detail: { keys: removed } })
  return removed
}

// ---------------------------------------------------------------------------
// 压力提醒：状态读写 + 判定（纯函数）
// ---------------------------------------------------------------------------

const objectOf = value => {
  if (typeof value !== 'string' || value.trim() === '') return null
  try {
    const parsed = JSON.parse(value)
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/** 读提醒去重状态（缺键/坏值一律 null，按「没提过」处理）。 */
export function readAlertState(db) {
  const record = objectOf(getSetting(db, MAIN_CONTEXT_ALERT_KEY))
  if (record === null) return null
  const band = Number.isFinite(record.band) ? record.band : null
  const state = typeof record.state === 'string' ? record.state : 'asked'
  return {
    at: millisOf(record.at),
    ratio: Number.isFinite(record.ratio) ? record.ratio : null,
    band,
    state,
  }
}

/** 写提醒状态；传 null 删除（压力回落/已处理时清）。 */
export function writeAlertState(db, value) {
  if (value === null || value === undefined) {
    deleteSetting(db, MAIN_CONTEXT_ALERT_KEY)
    return null
  }
  const record = {
    at: Number.isFinite(value.at) ? value.at : Date.now(),
    ratio: Number.isFinite(value.ratio) ? value.ratio : null,
    band: Number.isFinite(value.band) ? value.band : null,
    state: typeof value.state === 'string' ? value.state : 'asked',
  }
  setSetting(db, MAIN_CONTEXT_ALERT_KEY, JSON.stringify(record))
  return record
}

/**
 * 判定这次要不要弹问题卡（纯函数）。
 *
 * - 压力未知 / 低于阈值 → 不弹；低于 `阈值 − 滞回` 且此前有 alert → 清 alert（重新武装）；
 * - 同一 band 只问一次；`declined`（继续当前会话）在本 band 内不再问，下一 band 会再问；
 * - `snoozed`（稍后再说）在本段压力内不再问，直到压力回落后重新武装；
 * - `failed`（代建/切指针失败）把 band 降到上一档记录，下一次打开允许重试。
 */
export function decideAlert({ ratio, threshold, previous, now } = {}) {
  const limit = Number.isFinite(threshold) ? threshold : CONTEXT_PRESSURE_THRESHOLD_DEFAULT
  const at = Number.isFinite(now) ? now : Date.now()
  if (!Number.isFinite(ratio)) return { action: 'skip', reason: 'pressure-unknown', band: null, threshold: limit }
  if (ratio < limit - ALERT_HYSTERESIS) {
    return previous === null
      ? { action: 'skip', reason: 'below-threshold', band: null, threshold: limit }
      : { action: 'clear', reason: 'pressure-dropped', band: null, threshold: limit }
  }
  if (ratio < limit) return { action: 'skip', reason: 'below-threshold', band: null, threshold: limit }
  const band = Math.floor(ratio / ALERT_BAND_STEP)
  if (previous === null) return { action: 'ask', reason: 'raised', band, threshold: limit, at }
  if (previous.state === 'snoozed') return { action: 'skip', reason: 'snoozed', band, threshold: limit }
  if (previous.band === null || band > previous.band) return { action: 'ask', reason: 'next-band', band, threshold: limit, at }
  return { action: 'skip', reason: 'already-asked', band, threshold: limit }
}

/**
 * 观测 + 提醒面：给 main-session / index / host-route 用。
 *
 * - `observe()`：打开主会话时跑一次（异步、不阻塞），结果缓存给 snapshot 端点；
 * - `remind()`：根据观测结果决定要不要弹问题卡（唯一提醒出口），**不自动做任何切换**；
 * - `pressure({ sessionId })`：按会话取压力（任意存活会话）；
 * - `requestNewCoordinator`：由 index 注入 —— 用户明确选了「新建协调者会话」后才调用（插件代建 + adopt）。
 */
export function createContextObserver({
  db,
  config = {},
  tokenMeter,
  persistence,
  sessionQuery,
  agentPresets,
  sessions,
  userQuestions,
  requestNewCoordinator,
  now = () => Date.now(),
  statFile = defaultStatFile,
  log = () => {},
  onWarn,
} = {}) {
  const resolve = value => (typeof value === 'function' ? value() : value)
  const warn = message => { if (typeof onWarn === 'function') onWarn(message) }
  const warned = new Set()
  const warnOnce = (key, message) => {
    if (warned.has(key)) return false
    warned.add(key)
    warn(message)
    return true
  }
  const threshold = () => {
    const raw = resolve(config)?.contextPressureThreshold
    if (!Number.isFinite(raw)) return CONTEXT_PRESSURE_THRESHOLD_DEFAULT
    return Math.min(CONTEXT_PRESSURE_THRESHOLD_MAX, Math.max(CONTEXT_PRESSURE_THRESHOLD_MIN, raw))
  }
  let latest = null
  let reminding = false
  // 最近一次观测到的**存活**协调者 agent（提醒要用它做作用域路由，见 remind() 的注释）。
  // 带 sessionId 一起存：新建主会话时那条观测还没有 agent，不能把旧主会话的 agent 拿来用。
  let latestLive = null

  /** 按 sessionId 取压力（存活会话；未加载返回未知）。任意会话都能用，不绑主会话。 */
  const pressure = ({ sessionId, session } = {}) => {
    let target = session
    if (target === undefined && typeof sessionId === 'string' && sessionId !== '') {
      try {
        const store = resolve(sessions)
        target = store?.get?.(sessionId)
      } catch { target = undefined }
    }
    return readContextPressure({ session: target, tokenMeter: resolve(tokenMeter) })
  }

  /** 一次性提示：日志超过软阈值时给一次，写标记后不再弹。 */
  const hintOf = logMiB => {
    if (!Number.isFinite(logMiB) || logMiB < MAIN_LOG_HINT_MIB) return { visible: false, text: '' }
    let shown = false
    try { shown = millisOf(getSetting(db, MAIN_LOG_HINT_KEY)) !== null } catch { shown = false }
    if (shown) return { visible: false, text: '' }
    try { setSetting(db, MAIN_LOG_HINT_KEY, String(now())) } catch { /* 写不进就只本次显示 */ }
    log('main.context.log-hint', { detail: { logMiB, thresholdMiB: MAIN_LOG_HINT_MIB } })
    return {
      visible: true,
      text: `主会话日志已 ${Math.round(logMiB)} MiB（≥ ${MAIN_LOG_HINT_MIB} MiB）：压缩只减请求、不减日志。`
        + '需要更轻的会话就在指挥舱新建会话、选「协调者」预设，再点会话头的「设为协调者」；旧会话可自行归档。',
    }
  }

  /** 观测一次主会话（异步、只读、永不抛）。结果写进内存缓存供 snapshot 端点读取。 */
  const observe = async ({ mainSessionId, liveAgent, source = 'open' } = {}) => {
    if (typeof mainSessionId !== 'string' || mainSessionId === '') return null
    try {
      const at = now()
      const session = liveAgent?.session
      const press = readContextPressure({ session, tokenMeter: resolve(tokenMeter) })
      const size = await readLogSize({ session, persistence: resolve(persistence), statFile })
      const compactions = await readCompactionStats({ sessionId: mainSessionId, sessionQuery: resolve(sessionQuery), log })
      const probe = probeCompaction({
        agent: liveAgent,
        agentPresets: resolve(agentPresets),
        tokenMeter: resolve(tokenMeter),
      })
      const hint = hintOf(size.logMiB)
      const limit = threshold()
      const alert = readAlertState(db)
      const decision = decideAlert({ ratio: press.ratio, threshold: limit, previous: alert, now: at })
      const live = liveAgent !== undefined && liveAgent !== null
      if (live) latestLive = { sessionId: mainSessionId, agent: liveAgent }
      latest = {
        at,
        source,
        sessionId: mainSessionId,
        live,
        pressure: {
          pressureTokens: press.pressureTokens,
          contextWindow: press.contextWindow,
          ratio: press.ratio,
          threshold: limit,
          degraded: press.degraded,
        },
        logMiB: size.logMiB,
        logPath: size.logPath,
        compactions,
        probe,
        hint,
        alert: {
          active: alert !== null,
          state: alert?.state ?? null,
          band: alert?.band ?? null,
          ratio: alert?.ratio ?? null,
          decision: decision.action,
          reason: decision.reason,
        },
      }
      log('main.context.observed', {
        detail: {
          source,
          sessionId: mainSessionId,
          live: latest.live,
          ratio: press.ratio,
          threshold: limit,
          pressureTokens: press.pressureTokens,
          contextWindow: press.contextWindow,
          logMiB: size.logMiB,
          manualCompactions: compactions.manual,
          autoCompactions: compactions.auto,
          hostAutoCompactionThreshold: probe.thresholdRatio,
          hostAutoCompactionDisabled: probe.auto === false,
          alertDecision: decision.action,
          alertReason: decision.reason,
        },
      })
      return latest
    } catch (error) {
      warn(`dsh-orchestrator: 主会话上下文观测失败（不影响打开主会话）：${errorText(error)}`)
      log('main.context.observe-failed', { detail: { source, error: errorText(error) } })
      return latest
    }
  }

  /** 观测结果 + 提醒（open 主会话后调用；fire-and-forget）。 */
  const observeAndRemind = async ({ mainSessionId, liveAgent, source = 'open' } = {}) => {
    const observation = await observe({ mainSessionId, liveAgent, source })
    if (observation !== null) await remind({ observation, mainSessionId })
    return observation
  }

  /**
   * 压力提醒的唯一出口：`ctx.userQuestions.ask()` 弹一张问题卡。
   * 三个选项：去新建（插件代建 + adopt）/ 继续当前会话（抬 band）/ 稍后再说（静默）。
   * 任何失败都只 warn + 记审计，不影响打开主会话、不自动动作。
   *
   * **作用域（0.25.0 真机验证修的第二处）**：`ask()` 必须带上主会话的 live agent。
   * 宿主 `UserQuestionService.ask()` 在 `agent === undefined` 时走**全局** waterfall
   * `ctx.waterfall('user-questions/request', ...)`；而浏览器端 answerer 是
   * `ctx.remote.$on('user-questions/request', ...)` 注册的，它第一件事是
   * `ctx.sessions.scopeOf(owner)` —— 全局派发时没有会话作用域，直接 `next()` 放行，
   * 宿主拿到 noAnswerer → `NO_PROVIDER`，卡片永远不弹（0.25.0 真机实测：日志
   * `main.context.alert.asked` 后紧接 `main.context.alert.no-provider`）。
   * 带 agent 后走 `scopeTarget(agent, agent)`，请求才会落到该会话的 answerer 上。
   * 拿不到 live agent（刚建出来还没起 agent）时退回全局 ask，并 warn 一次说明卡片可能不出现。
   */
  const remind = async ({ observation, mainSessionId } = {}) => {
    try {
      const ratio = observation?.pressure?.ratio
      const limit = observation?.pressure?.threshold ?? threshold()
      const previous = readAlertState(db)
      const decision = decideAlert({ ratio, threshold: limit, previous, now: now() })
      if (decision.action === 'clear') {
        writeAlertState(db, null)
        log('main.context.alert.cleared', { detail: { reason: decision.reason, ratio } })
        if (latest !== null) latest.alert = { active: false, state: null, band: null, ratio: null, decision: 'clear', reason: decision.reason }
        return { action: 'clear' }
      }
      if (decision.action !== 'ask') return { action: 'skip', reason: decision.reason }
      const service = resolve(userQuestions)
      if (service === undefined || service === null || typeof service.ask !== 'function') {
        warnOnce('user-questions-missing',
          'dsh-orchestrator: 上下文压力已到提醒阈值，但宿主没有 userQuestions 服务，无法弹问题卡（本次不提醒；可手动在指挥舱新建协调者会话）')
        writeAlertState(db, { at: now(), ratio, band: decision.band, state: 'unavailable' })
        return { action: 'skip', reason: 'user-questions-missing' }
      }
      if (reminding) return { action: 'skip', reason: 'busy' }
      reminding = true
      // 作用域：只认「同一个主会话」的存活 agent，避免拿上一个主会话的 agent 去路由。
      const agent = latestLive !== null && latestLive.sessionId === mainSessionId ? latestLive.agent : undefined
      const agentId = agent === undefined
        ? null
        : (typeof agent?.session?.id === 'string' ? agent.session.id : (typeof agent?.id === 'string' ? agent.id : null))
      if (agent === undefined) {
        warnOnce('ask-without-agent',
          'dsh-orchestrator: 压力提醒拿不到主会话的存活 agent（会话刚建、agent 还没起）：问题卡可能不会出现在任何客户端；'
          + '本次仍按全局作用域提问，可手动在指挥舱新建协调者会话')
      }
      // 先记 band 再提问：防止同一段压力弹两次（用户关掉卡片也不会重复弹）。
      writeAlertState(db, { at: now(), ratio, band: decision.band, state: 'asked' })
      log('main.context.alert.asked', {
        detail: { ratio, threshold: limit, band: decision.band, sessionId: mainSessionId, agentId, hasAgent: agent !== undefined },
      })
      const question = {
        id: 'main-context-pressure',
        header: '主会话上下文压力',
        question: `主会话上下文压力已达 ${pct(ratio)}%（插件提醒阈值 ${pct(limit)}%）。要换一个新的协调者会话吗？`,
        detail: '换会话只切换「谁是协调者」：旧会话保留可回看，台账/任务/记忆/偏好都不搬。'
          + '宿主仍会按自己的阈值（默认 0.8）自动压缩当前会话。',
        options: [
          { label: ALERT_OPTION_CREATE, description: '新建一个空白协调者会话并立刻切换过去（旧会话保留）' },
          { label: ALERT_OPTION_CONTINUE, description: '留在当前会话继续；压力再高一档才会再问' },
          { label: ALERT_OPTION_LATER, description: '这次不问；压力回落后才会重新提醒' },
        ],
      }
      let answer
      try {
        answer = await service.ask({ questions: [question], ...(agent === undefined ? {} : { agent }) })
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : ''
        if (code === 'NO_PROVIDER') {
          warnOnce('user-questions-no-provider',
            'dsh-orchestrator: 上下文压力已到提醒阈值，但当前没有在线客户端可以回答问题卡（本次不提醒；可手动在指挥舱新建协调者会话）')
          writeAlertState(db, { at: now(), ratio, band: decision.band, state: 'unavailable' })
          log('main.context.alert.no-provider', { detail: { ratio, band: decision.band, agentId, hasAgent: agent !== undefined } })
          return { action: 'skip', reason: 'no-provider' }
        }
        warn(`dsh-orchestrator: 压力提醒问题卡失败（不影响使用）：${errorText(error)}`)
        log('main.context.alert.ask-failed', { detail: { ratio, band: decision.band, error: errorText(error), agentId, hasAgent: agent !== undefined } })
        writeAlertState(db, { at: now(), ratio, band: decision.band - 1, state: 'failed' })
        return { action: 'skip', reason: 'ask-failed' }
      }
      const chosen = answer?.answers?.find(item => item.id === question.id)?.selected?.[0] ?? ''
      if (chosen === ALERT_OPTION_CREATE) {
        if (typeof requestNewCoordinator !== 'function') {
          warn('dsh-orchestrator: 缺少「新建协调者会话」的实现（插件装配不完整），本次不新建')
          writeAlertState(db, { at: now(), ratio, band: decision.band - 1, state: 'failed' })
          return { action: 'create', ok: false, reason: 'not-wired' }
        }
        const outcome = await requestNewCoordinator({ ratio, sessionId: mainSessionId })
        if (outcome?.ok === true) {
          writeAlertState(db, null)
          log('main.context.alert.resolved', {
            detail: { action: 'created', newId: outcome.sessionId ?? null, oldId: mainSessionId, ratio },
          })
          if (latest !== null) latest.alert = { active: false, state: null, band: null, ratio: null, decision: 'resolved-created', reason: 'created' }
          return { action: 'create', ok: true, sessionId: outcome.sessionId ?? null }
        }
        // 失败不清 alert：把 band 降一档，下次打开还能再问/再试（用户可重试）。
        warn(`dsh-orchestrator: 新建协调者会话失败（保持原协调者）：${outcome?.error ?? outcome?.code ?? '未知原因'}`)
        log('main.context.alert.create-failed', {
          detail: { oldId: mainSessionId, code: outcome?.code ?? null, error: outcome?.error ?? null, ratio },
        })
        writeAlertState(db, { at: now(), ratio, band: decision.band - 1, state: 'failed' })
        return { action: 'create', ok: false, code: outcome?.code ?? null }
      }
      if (chosen === ALERT_OPTION_LATER) {
        writeAlertState(db, { at: now(), ratio, band: decision.band, state: 'snoozed' })
        log('main.context.alert.snoozed', { detail: { ratio, band: decision.band } })
        return { action: 'later' }
      }
      // 默认「继续当前会话」（含用户关闭卡片没选）：抬 band，本档内不再问。
      writeAlertState(db, { at: now(), ratio, band: decision.band, state: 'declined' })
      log('main.context.alert.declined', { detail: { ratio, band: decision.band } })
      return { action: 'continue' }
    } catch (error) {
      warn(`dsh-orchestrator: 压力提醒失败（不影响使用）：${errorText(error)}`)
      log('main.context.alert.failed', { detail: { error: errorText(error) } })
      return { action: 'skip', reason: 'failed' }
    } finally {
      reminding = false
    }
  }

  /** 最近一次观测结果（同步；没观测过返回 null）。 */
  const snapshot = () => latest

  /** adopt 成功后清提醒（手动「设为协调者」也算用户处理过）。 */
  const clearAlert = ({ reason = 'adopted' } = {}) => {
    try {
      writeAlertState(db, null)
      log('main.context.alert.cleared', { detail: { reason } })
      if (latest !== null) latest.alert = { active: false, state: null, band: null, ratio: null, decision: 'clear', reason }
    } catch { /* 清失败不影响 adopt 结果 */ }
  }

  return { observe, observeAndRemind, remind, snapshot, pressure, probe: probeCompaction, clearAlert }
}
