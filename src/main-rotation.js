// 主会话轮换（G1）判定内核 + 指标采集层：只回答「该不该换」，不建会话、不改指针、不加定时器。
//
// 为什么判定要单独一个纯函数：
//   轮换的副作用不可逆（旧主会话会改名，并被平台归档，而平台没有 unarchive API），
//   所以判据必须能脱离台账/磁盘单独单测：同一份「台账快照 + 配置 + 时间」
//   必须得到同一个结论；事后也能靠 main.rotation.decided 日志复盘「这次为什么换 / 为什么没换」。
//
// 本文件范围（P1-A 收缩后：配置键 12 → 7、触发因子 6 → 2）：
//   - S1：7 个配置键的默认值、合法区间与归一化（config.js 的 loadConfig 直接复用 normalizeRotationConfig）；
//     evaluateRotation()：main-log / age 两个触发因子 + P1–P10 十二条保护 + 冷却/最小龄 + 原因文案
//   - S2：指标采集层（collectRotationMetrics：locate + stat，每项 try/catch，
//     拿不到就是「未知」而不是 0）、settings 键读写（readRotationState / writeRotationState）、
//     inspectRotationPending()（崩溃恢复 marker 的只读判定）
//   - S3：轮换动作面（createRotationService：采集 + 判定 + 动作 + 崩溃恢复，平台服务由调用方注入）
//   - S7（检查节流）已在 P1-A 删除：采集只剩一次 locate + stat，节流的收益小于解释成本。
//     settings.main_rotation_checked_at 仍被 readRotationState 读出来（旧库无害），但不再写、不再参与判定。
//
// 判定只在「打开主会话」时发生一次（main-session 的 openOnce → createRotationService.evaluate）：
// 不写 due 标记、不在启动/加载时后台检测、面板也不暴露判定结果——省掉一整套派生状态与展示链路。
// 判定本身不写任何 settings 键：结论只进 main.rotation.decided 日志（P1-A 起连检查时间戳也不写了）。
import { stat } from 'node:fs/promises'
import { deleteSetting, getSetting, listTasks, setSetting } from './ledger.js'
import { onboardingKey } from './onboarding.js'
import { statusesWith } from './status-facts.js'

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
const MIB = 1024 * 1024

/**
 * 7 个配置键的默认值（P1-A 收缩：12 → 7）。
 * `mainRotation` 是总开关：auto = 判定并动作；off = 只检测、不动作。
 * **默认 off**：升级后不再自动换主会话，要换必须显式配 `mainRotation: 'auto'`。
 * `rotateArchiveOld` = 轮换后是否把旧主会话交给平台归档（不可逆）。
 */
export const ROTATION_DEFAULTS = Object.freeze({
  mainRotation: 'off',
  rotateAfterMainLogMiB: 6,
  rotateAfterDays: 10,
  rotateCooldownHours: 48,
  rotateMinAgeHours: 12,
  rotateIdleMinutes: 10,
  rotateArchiveOld: true,
})

/**
 * 数值键的合法区间：`[min, max, 是否取整]`。
 * 归一化口径与其它配置一致：非数字/非正数回落默认，有限但越界的值夹到边界（不报错）。
 */
export const ROTATION_LIMITS = Object.freeze({
  rotateAfterMainLogMiB: Object.freeze([0.5, 4096, false]),
  rotateAfterDays: Object.freeze([1, 365, true]),
  rotateCooldownHours: Object.freeze([1, 720, true]),
  rotateMinAgeHours: Object.freeze([1, 720, true]),
  rotateIdleMinutes: Object.freeze([1, 1440, true]),
})

/** 总开关合法取值；拼错/其它值一律回落 off（默认必须安全：不能因为配置写错就自动换掉协调者）。 */
export const MAIN_ROTATION_MODES = Object.freeze(['auto', 'off'])

/**
 * settings 键名（与台账 settings 表共用）。
 * 只存「起点 / 冷却 / 审计 / 崩溃锚点」四个事实，不存任何判定结论（判定每次打开主会话时现算）。
 */
export const MAIN_SESSION_CREATED_AT_KEY = 'main_session_created_at'
export const MAIN_ROTATION_AT_KEY = 'main_rotation_at'
export const MAIN_ROTATION_LAST_KEY = 'main_rotation_last'
export const MAIN_ROTATION_PENDING_KEY = 'main_rotation_pending'
// 检查节流（S7）已随 P1-A 删除：这个键只在读侧保留（旧库里的值无害、也不清理），不再写、不再参与判定。
export const MAIN_ROTATION_CHECKED_AT_KEY = 'main_rotation_checked_at'

/**
 * 触发因子的固定顺序（P1-A 只剩两个：主日志体积、运行天数）。
 * reasons 按这个顺序输出，同一因子最多出现一次；顺序稳定才能做日志 diff 与单测断言。
 */
export const ROTATION_TRIGGERS = Object.freeze(['main-log', 'age'])

/**
 * 保护规则的展示/日志优先级：越靠前越「根本」，blockedBy[0] 即首要原因。
 * 只影响顺序，不影响判定——任一命中即不轮换（plan §3.2 `protections.length === 0`）。
 */
export const ROTATION_BLOCKS = Object.freeze([
  'mode-off',
  'coordinator-override',
  'spawn-provider',
  'active-tasks',
  'delivered-pending',
  'delivered-artifacts',
  'agent-running',
  'recent-activity',
  'active-children',
  'min-age',
  'cooldown',
  'metrics-degraded',
])

/** 活跃任务口径（P1）：delivered 单独由 P2/P5 处理，不算「在跑」——那是 `rotationActive` 能力，
 *  与通用的 `active` 不是一回事（delivered active 但不阻断轮换）。 */
export const ROTATION_ACTIVE_STATUSES = Object.freeze(statusesWith('rotationActive'))

const positive = value =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined

const nonEmpty = value =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

/** 展示用数字：整数不带小数点，小数最多一位；避免把 6.000000000001 写进面板/日志。 */
const fmt = value => {
  if (!Number.isFinite(value)) return String(value)
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10)
}

/**
 * 把（可能是手写的、可能是 loadConfig 产物的）配置归一化成 7 个键。
 * 幂等：loadConfig 里再调一次也不会改变结果。
 */
export function normalizeRotationConfig(raw = {}) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const config = {
    // 默认 off（P1-A）：只有显式 'auto' 才开；拼错保持「不开」，不能因为写错就自动换掉协调者。
    mainRotation: source.mainRotation === 'auto' ? 'auto' : 'off',
    // 与 memoryInject / idleWatchdog 同口径：只有显式 false 才关，拼错保持默认（这里默认开）。
    rotateArchiveOld: source.rotateArchiveOld !== false,
  }
  for (const [key, [min, max, integer]] of Object.entries(ROTATION_LIMITS)) {
    const valid = positive(source[key])
    if (valid === undefined) {
      config[key] = ROTATION_DEFAULTS[key]
      continue
    }
    const bounded = Math.min(max, Math.max(min, valid))
    config[key] = integer ? Math.floor(bounded) : bounded
  }
  return config
}

const TRIGGER_TEXT = {
  'main-log': (value, threshold) => `主会话日志 ${fmt(value)} MiB（阈值 ${fmt(threshold)} MiB）`,
  age: (value, threshold) => `主会话已运行 ${fmt(value)} 小时（阈值 ${fmt(threshold)} 小时）`,
}

/**
 * 判定主会话是否该轮换。纯函数：不读库、不读盘、不看时钟（`now` 由调用方给），
 * 不改任何入参，同一输入永远同一输出。
 *
 * @param {object} input
 * @param {number} [input.now] 判定时刻（ms）；缺省 Date.now()
 * @param {object} [input.config] loadConfig 结果或手写配置（内部按 7 个键归一化，非法值回落）
 * @param {number} [input.since] 当前主会话起点（ms，来自 main_session_created_at，退 header.createdAt）
 * @param {number} [input.lastRotatedAt] 上次轮换时刻（ms，来自 main_rotation_at）；从未轮换传 undefined
 * @param {object} [input.metrics] 采集结果：mainLogMiB（其余字段已随 P1-A 删除，传了也不看）
 * @param {object[]} [input.tasks] 台账任务全量（listTasks），用于 P1/P2/P5
 * @param {string} [input.agentStatus] 主会话 live agent 的 status（'running' 时 P3 阻塞）
 * @param {number} [input.logMtimeAt] 主会话日志 mtime（ms），用于 P4「刚有交互」
 * @param {object[]} [input.catalog] 子会话目录条目（dispatcher.catalog()），用于 P8
 * @param {string[]} [input.degraded] 调用方已知的采集失败因子 code
 * @returns {{due:boolean, mode:string, triggers:string[], reasons:{code:string,text:string,value:number,threshold:number}[],
 *   blockedBy:{code:string,text:string}[], metrics:object, degraded:string[], evaluatedAt:number,
 *   lastRotatedAt:number|null, blockCount:number}}
 */
export function evaluateRotation({
  now,
  config = {},
  since,
  lastRotatedAt,
  metrics = {},
  tasks = [],
  agentStatus,
  logMtimeAt,
  catalog,
  degraded = [],
} = {}) {
  const cfg = normalizeRotationConfig(config)
  const at = Number.isFinite(now) ? now : Date.now()
  const startedAt = Number.isFinite(since) ? since : undefined
  const rotatedAt = Number.isFinite(lastRotatedAt) ? lastRotatedAt : undefined
  const taskList = Array.isArray(tasks) ? tasks.filter(task => task !== null && typeof task === 'object') : []
  const spawnProvider = nonEmpty(config?.spawnProvider) ?? 'spawn'
  const override = nonEmpty(config?.coordinatorSession)

  // 龄/冷却/闲置一律从时间戳现算，不信任调用方传「小时数」：口径只有一处，单测也好构造边界。
  const ageHours = startedAt === undefined ? undefined : Math.max(0, (at - startedAt) / HOUR_MS)
  const idleMinutes = Number.isFinite(logMtimeAt) ? Math.max(0, (at - logMtimeAt) / MINUTE_MS) : undefined
  const hoursSinceRotation = rotatedAt === undefined ? undefined : Math.max(0, (at - rotatedAt) / HOUR_MS)

  // ---- 触发因子（main-log / age）----
  // 拿不到数值 = 该因子缺席（降级），不是 0：不能因为 locate 失败就以为日志很小。
  const factorValue = {
    'main-log': Number.isFinite(metrics?.mainLogMiB) ? metrics.mainLogMiB : undefined,
    age: ageHours,
  }
  const threshold = {
    'main-log': cfg.rotateAfterMainLogMiB,
    age: cfg.rotateAfterDays * 24,
  }
  const triggers = []
  const reasons = []
  for (const code of ROTATION_TRIGGERS) {
    const value = factorValue[code]
    if (value === undefined || value < threshold[code]) continue
    triggers.push(code)
    reasons.push({ code, text: TRIGGER_TEXT[code](value, threshold[code]), value, threshold: threshold[code] })
  }

  // ---- 保护规则（P1–P10）：任一命中即不轮换，全部记下来供面板/日志解释 ----
  const blocked = new Map()
  const block = (code, text) => {
    if (!blocked.has(code)) blocked.set(code, { code, text })
  }

  if (cfg.mainRotation === 'off') {
    block('mode-off', '主会话轮换已关闭（mainRotation=off）：只检测、不动作')
  }
  if (override !== undefined) {
    // P6：解析顺序是「config.coordinatorSession ?? 台账指针」，有覆盖时轮换会被直接无视。
    block('coordinator-override', `主会话由配置 coordinatorSession 覆盖（${override}）：不具备轮换语义`)
  }
  if (spawnProvider !== 'spawn') {
    // P7：新建主会话前提（与主会话现有的错误口径一致）。
    block('spawn-provider', `spawnProvider=${spawnProvider}：新建主会话需要 spawn provider`)
  }

  const activeTasks = taskList.filter(task => ROTATION_ACTIVE_STATUSES.includes(task.status))
  if (activeTasks.length > 0) {
    // P1：换协调者会让在跑任务的回报/追问落到新会话，等人答的任务更不该换。
    block('active-tasks', `还有 ${activeTasks.length} 个活跃任务（等前置/待派发/进行中/等待回复）：换主会话会切断回报与追问`)
  }
  const delivered = taskList.filter(task => task.status === 'delivered')
  if (delivered.length > 0) {
    // P2：待确认要协调者拍板，换会话会把确认/追问窗口切断，只剩超时自动完成。
    block('delivered-pending', `还有 ${delivered.length} 个任务处于「已交付待确认」：换主会话会切断确认与追问窗口`)
  }
  const deliveredWithArtifacts = delivered.filter(task => Array.isArray(task.artifacts) && task.artifacts.length > 0)
  if (deliveredWithArtifacts.length > 0) {
    // P5：P2 的子集，单独记一条，面板才能解释「用户还没看交付物」。
    block('delivered-artifacts', `还有 ${deliveredWithArtifacts.length} 个待确认任务带未读产物：先看完再换`)
  }
  if (agentStatus === 'running') {
    // P3：用户正在交互（正在跑回合），不能把人从正在进行的对话里拽走。
    block('agent-running', '主会话正在执行回合：不能把人从正在进行的对话里拽走')
  }
  if (idleMinutes !== undefined && idleMinutes < cfg.rotateIdleMinutes) {
    // P4：覆盖「刚聊完/正在输入」但没有回合在跑的窗口。
    block('recent-activity', `主会话 ${fmt(idleMinutes)} 分钟内有交互（阈值 ${cfg.rotateIdleMinutes} 分钟）`)
  }
  const activeChildren = Array.isArray(catalog)
    ? catalog.filter(entry => entry !== null && typeof entry === 'object' && entry.activity === 'active')
    : []
  if (activeChildren.length > 0) {
    // P8：台账已删行/外部派生的孤儿子会话还在跑（P1 的兜底）。
    block('active-children', `子会话目录里还有 ${activeChildren.length} 个活跃子代理`)
  }

  // P9：最小龄（防抖）+ 冷却期（防频繁）。从未轮换过 = 冷却条件天然满足。
  if (ageHours !== undefined && ageHours < cfg.rotateMinAgeHours) {
    block('min-age', `主会话只运行了 ${fmt(ageHours)} 小时（最小龄 ${cfg.rotateMinAgeHours} 小时）`)
  }
  if (hoursSinceRotation !== undefined && hoursSinceRotation < cfg.rotateCooldownHours) {
    block('cooldown', `距上次轮换 ${fmt(hoursSinceRotation)} 小时（冷却 ${cfg.rotateCooldownHours} 小时）`)
  }

  // P10：一个触发指标都拿不到 → fail-closed（宁可不动，也不在看不见的情况下换掉协调者）。
  const missing = ROTATION_TRIGGERS.filter(code => factorValue[code] === undefined)
  if (missing.length === ROTATION_TRIGGERS.length) {
    block('metrics-degraded', '所有触发指标都拿不到：保守不轮换（fail-closed）')
  }

  const blockedBy = ROTATION_BLOCKS.filter(code => blocked.has(code)).map(code => blocked.get(code))
  // 缺席因子按 ROTATION_TRIGGERS 顺序排在前面，调用方补充的采集失败码跟在后面（去重，顺序稳定）。
  const degradedOut = [...new Set([
    ...missing,
    ...(Array.isArray(degraded) ? degraded.filter(code => typeof code === 'string' && code !== '') : []),
  ])]

  return {
    due: cfg.mainRotation === 'auto' && triggers.length > 0 && blockedBy.length === 0,
    mode: cfg.mainRotation,
    triggers,
    reasons,
    blockedBy,
    blockCount: blockedBy.length,
    metrics: {
      mainLogMiB: factorValue['main-log'] ?? null,
      ageHours: ageHours ?? null,
      hoursSinceRotation: hoursSinceRotation ?? null,
      idleMinutes: idleMinutes ?? null,
    },
    degraded: degradedOut,
    evaluatedAt: at,
    lastRotatedAt: rotatedAt ?? null,
  }
}

/**
 * 一句话文案（面板 banner / 通知 / 日志摘要共用）：
 * due 时列出触发原因；被保护挡住时给首要原因；都没有就是「不需要换」。
 */
export function rotationHeadline(decision) {
  if (decision === null || typeof decision !== 'object') return '主会话轮换：尚未判定'
  if (decision.due === true) {
    const reasons = Array.isArray(decision.reasons) ? decision.reasons.map(reason => reason?.text).filter(Boolean) : []
    return reasons.length > 0 ? `建议轮换主会话：${reasons.join('；')}` : '建议轮换主会话'
  }
  if (Array.isArray(decision.blockedBy) && decision.blockedBy.length > 0) {
    return `暂不轮换主会话：${decision.blockedBy[0].text}`
  }
  return '主会话暂无轮换必要'
}

// ---------------------------------------------------------------------------
// S2：指标采集 + settings 键读写
//
// 三条硬约束（P1-A 收缩后仍然成立）：
//   1. 采集只读：不写台账、不写 settings、不建会话、不动指针（写 settings 是轮换动作的事）；
//   2. 失败降级为「未知」：服务缺失/抛错只记 degraded，不填 0——0 会被当成「很干净」而漏判；
//   3. 采集只在「打开主会话」那一次跑：不进面板 2s 轮询、不加定时器。
// ---------------------------------------------------------------------------

const millisOf = value => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string' || value.trim() === '') return null
  const numeric = Number(value)
  if (Number.isFinite(numeric)) return numeric
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

const objectOf = value => {
  if (typeof value !== 'string' || value.trim() === '') return null
  try {
    const parsed = JSON.parse(value)
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

const errorText = error => `${error?.message ?? error}`

const defaultStatFile = async path => {
  const info = await stat(path)
  return { size: info.size, mtimeMs: info.mtimeMs }
}

/**
 * 读五个 settings 键（只读）。缺键/坏值一律为 null，由调用方按「未知」处理。
 * `checkedAt` 只读不写：检查节流已随 P1-A 删除，旧库里的值留着无害。
 * @returns {{createdAt:number|null, rotatedAt:number|null, last:object|null, pending:object|null,
 *   checkedAt:number|null}}
 */
export function readRotationState(db) {
  return {
    createdAt: millisOf(getSetting(db, MAIN_SESSION_CREATED_AT_KEY)),
    rotatedAt: millisOf(getSetting(db, MAIN_ROTATION_AT_KEY)),
    last: objectOf(getSetting(db, MAIN_ROTATION_LAST_KEY)),
    pending: objectOf(getSetting(db, MAIN_ROTATION_PENDING_KEY)),
    checkedAt: millisOf(getSetting(db, MAIN_ROTATION_CHECKED_AT_KEY)),
  }
}

/** 五个键的一一对应（写入口共用；读侧按值类型分别解码）。 */
const ROTATION_SETTING_KEYS = Object.freeze({
  createdAt: MAIN_SESSION_CREATED_AT_KEY,
  rotatedAt: MAIN_ROTATION_AT_KEY,
  last: MAIN_ROTATION_LAST_KEY,
  pending: MAIN_ROTATION_PENDING_KEY,
  checkedAt: MAIN_ROTATION_CHECKED_AT_KEY,
})

/**
 * settings 写入层（S3 的轮换动作用它写时间戳/审计/marker）：
 *   undefined → 不动这个键；null → 删除这个键；number/string → 存字符串；object → JSON。
 * 只落键、不做判定、不做动作；返回实际写入的键值（删掉的记 null），便于日志与单测断言。
 */
export function writeRotationState(db, patch = {}) {
  const written = {}
  for (const [field, key] of Object.entries(ROTATION_SETTING_KEYS)) {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) continue
    const value = patch[field]
    if (value === undefined) continue
    if (value === null) {
      deleteSetting(db, key)
      written[field] = null
      continue
    }
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
    setSetting(db, key, text)
    written[field] = text
  }
  return written
}

/**
 * 崩溃恢复 marker 的**只读**判定（S2 只算不执行；S3 的 recoverPending 才归档/清理）：
 *   none      没有 marker
 *   invalid   marker 形状不对（宁可不动，交人工看日志）
 *   complete  marker.newId === 当前指针 → 上次轮换已切指针、只差旧会话处置
 *   abandoned marker.newId !== 当前指针 → 上次轮换死在切指针之前，新会话是空白残留
 *   unknown   没有指针可比对（启动早期）
 */
export function inspectRotationPending(state, pointer) {
  const marker = state?.pending
  if (marker === null || marker === undefined) return { state: 'none', marker: null }
  const newId = typeof marker.newId === 'string' ? marker.newId : ''
  if (newId === '') return { state: 'invalid', marker }
  if (typeof pointer !== 'string' || pointer === '') return { state: 'unknown', marker }
  return { state: newId === pointer ? 'complete' : 'abandoned', marker }
}

/**
 * 采集轮换需要的两项事实（P1-A 收缩后只剩两项）：
 *   - 主日志体积：`persistence.locate` → `stat`（压缩后大小）；顺带拿 mtime 给 P4「刚有交互」
 *   - 起点 `since`：age 因子的输入（settings 优先，退 header.createdAt）
 * 每项独立 try/catch：失败记 degraded，值给 null（未知，不是 0）。
 * 只读：不写台账/settings/磁盘；结果只交给判定函数，不落任何 settings 键。
 *
 * @param {object} opts
 * @param {object} opts.db 台账
 * @param {object} [opts.persistence] 平台 sessionPersistence（只用到 locate）；缺失则 main-log 降级
 * @param {object} [opts.mainSession] live session（agent.session），启动时通常没有
 * @param {Function} [opts.statFile] stat 注入（单测用）；默认 fs/promises.stat
 * @param {Function} [opts.log] 结构化日志
 * @returns {Promise<{since:number|null, sinceSource:string|null, logMtimeAt:number|null,
 *   metrics:{mainLogMiB:number|null}, degraded:string[]}>}
 */
export async function collectRotationMetrics({
  db,
  persistence,
  mainSession,
  statFile = defaultStatFile,
  log = () => {},
} = {}) {
  const degraded = new Set()
  const metrics = { mainLogMiB: null }
  const degrade = (factor, error) => {
    degraded.add(factor)
    log('main.rotation.metrics.degraded', { detail: { factor, error: errorText(error) } })
  }

  // ---- 主会话 header：只有 live 会话能给（采集只在「打开主会话」那一次跑）----
  const header = mainSession?.header !== null && typeof mainSession?.header === 'object' ? mainSession.header : undefined

  // ---- since（age 的起点）：settings 优先，退 header.createdAt；都拿不到就降级 ----
  let since = null
  let sinceSource = null
  try {
    const stored = millisOf(getSetting(db, MAIN_SESSION_CREATED_AT_KEY))
    if (stored !== null) {
      since = stored
      sinceSource = 'settings'
    }
  } catch (error) {
    degrade('age', error)
  }
  if (since === null && header !== undefined) {
    const headerAt = millisOf(header.createdAt)
    if (headerAt !== null) {
      since = headerAt
      sinceSource = 'header'
    }
  }
  if (since === null) {
    // 起点未知 = 龄不可信；不是「刚建的会话」。
    degraded.add('age')
  }

  // ---- 主日志体积（locate → stat，压缩后大小）；顺带拿 mtime 给 P4 ----
  let logMtimeAt = null
  const canLocate = persistence !== null && typeof persistence === 'object' && typeof persistence.locate === 'function'
  if (canLocate && header !== undefined && typeof header.id === 'string' && typeof header.cwd === 'string') {
    try {
      const located = persistence.locate({ id: header.id, cwd: header.cwd })
      const path = located?.path
      if (typeof path !== 'string' || path === '') throw new Error('locate 没有返回日志路径')
      const info = await statFile(path)
      if (!Number.isFinite(info?.size)) throw new Error('stat 没有返回 size')
      metrics.mainLogMiB = info.size / MIB
      logMtimeAt = millisOf(info?.mtimeMs)
    } catch (error) {
      degrade('main-log', error)
    }
  } else {
    degrade('main-log', new Error(canLocate ? '拿不到主会话 header（id/cwd）' : '缺少 sessionPersistence 服务（locate）'))
  }

  return { since, sinceSource, logMtimeAt, metrics, degraded: [...degraded] }
}

// ---------------------------------------------------------------------------
// S3：轮换动作（marker / 指针时间戳 / 审计 / 旧会话处置 / 崩溃恢复）
//
// 五条顺序原则（计划 §5.1 / §6，改顺序前先读这里）：
//   1. create 失败 = **零处置**：不写 marker、不动指针、不碰旧会话（回调方负责，本文件不猜）；
//   2. marker 是指针切换前唯一的崩溃锚点：**先 marker、后切指针**；
//   3. **先切指针、后处置旧会话**：rename/archive 失败最多留下「旧会话还在列表里」，
//      不会出现「新指针不可用、旧指针已退役」的悬空态；
//   4. 审计（main_rotation_last）+ 清 marker 放在最后：崩溃在这之前，下次启动按 marker 补完；
//   5. 旧会话处置**不可逆**（平台没有 unarchive，见 docs/LIMITATIONS.md）：默认改名 + 归档，
//      归档失败只降级为「只改名」——轮换本身仍然成立。
//
// 本文件只做「台账 + settings + 可注入的平台动作」，平台服务一律由调用方以函数注入
// （main-session 用它自己的惰性服务解析，index 在启动时注入恢复用的 rename/archive）。
// ---------------------------------------------------------------------------

/** 旧主会话退役标题：`主会话（已退役 2026-11-17 07:05）`（本地时区，人读优先）。 */
export function retiredMainSessionTitle(at) {
  const date = new Date(Number.isFinite(at) ? at : Date.now())
  const pad = value => String(value).padStart(2, '0')
  return `主会话（已退役 ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}）`
}

const codesOfReasons = reasons => (Array.isArray(reasons) ? reasons : [])
  .map(item => (typeof item === 'string' ? item : item?.code))
  .filter(code => typeof code === 'string' && code !== '')

/**
 * 写崩溃恢复锚点（计划 §5.1 第 7 步）。**必须在切指针之前调用**：
 * 崩溃后 recoverPendingRotation 靠它区分「新会话是空白残留（归档）」与「指针已切、只差旧会话处置（补完）」。
 *
 * 永不抛：marker 写不进去只代表「崩溃后无法自动恢复」，不该因此放弃一次已经 create 成功的轮换。
 * @returns {object|null} 落库的 marker（形状 {newId, oldId, at, reasons}），写失败返回 null
 */
export function beginRotationMarker({ db, oldId, newId, at, reasons, log = () => {} } = {}) {
  const marker = {
    newId,
    oldId: typeof oldId === 'string' && oldId !== '' ? oldId : null,
    at: Number.isFinite(at) ? at : Date.now(),
    // marker 只存因子 code（几百字节）：完整 reasons/metrics 进审计，避免 marker 自己也变成大对象。
    reasons: codesOfReasons(reasons),
  }
  try {
    writeRotationState(db, { pending: marker })
    return marker
  } catch (error) {
    log('main.rotation.marker.failed', { detail: { newId, oldId: marker.oldId, error: errorText(error) } })
    return null
  }
}

/**
 * 指针切换后写两个时间戳（计划 §5.1 第 8 步）：
 *   main_session_created_at = 新会话起点（age 因子的 since）
 *   main_rotation_at        = 冷却期起点
 * 会抛（台账异常交调用方决定是否降级）；抛出不回滚指针——轮换已成立，只是少了防抖时间戳。
 */
export function markRotationTimes(db, at) {
  const value = Number.isFinite(at) ? at : Date.now()
  return writeRotationState(db, { createdAt: value, rotatedAt: value })
}

/**
 * 收尾：写审计 `main_rotation_last`（事后排查唯一入口），并**清掉** marker。
 *   写不进去会抛，marker 保留 → 下次启动 recoverPendingRotation 幂等补完（rename 覆盖标题、archive 幂等）。
 * @returns {object} 审计记录
 */
export function recordRotation(db, { oldId, newId, at, decision, disposal, recovered = false } = {}) {
  const record = {
    old: typeof oldId === 'string' && oldId !== '' ? oldId : null,
    new: newId,
    at: Number.isFinite(at) ? at : Date.now(),
    triggers: codesOfReasons(decision?.triggers ?? decision?.reasons),
    reasons: Array.isArray(decision?.reasons) ? decision.reasons.filter(reason => reason !== null && typeof reason === 'object') : [],
    metrics: decision?.metrics !== null && typeof decision?.metrics === 'object' ? decision.metrics : {},
    renamed: disposal?.renamed === true,
    archived: disposal?.archived === true,
    recovered: recovered === true,
  }
  // 两个键各一条 UPSERT/DELETE：任一失败都会抛，marker 没清掉就还能下次补。
  writeRotationState(db, { last: record, pending: null })
  return record
}

/** 清 marker（没有就是 no-op）。指针已经可用、旧会话处置不了时用它止血，避免每次启动重复尝试。 */
export function clearRotationMarker(db) {
  return writeRotationState(db, { pending: null })
}

/** 归档一个会话：失败只记日志 + 告警，永不抛（归档是「隐藏入口」，不是轮换成立的前提）。 */
async function archiveSessionQuietly(sessionId, { archive, log, onWarn, event }) {
  if (typeof archive !== 'function') {
    onWarn?.(`dsh-orchestrator: 缺少工作区归档能力，会话 ${sessionId} 未归档（仍在会话列表里）`)
    log(event, { detail: { sessionId, archived: false, reason: 'missing-archive-service' } })
    return false
  }
  try {
    await archive(sessionId)
    log(event, { detail: { sessionId, archived: true } })
    return true
  } catch (error) {
    onWarn?.(`dsh-orchestrator: 归档会话 ${sessionId} 失败（旧会话仍可见）：${errorText(error)}`)
    log(event, { detail: { sessionId, archived: false, error: errorText(error) } })
    return false
  }
}

/**
 * 处置旧主会话（计划 §5.1 第 11–12 步）：先改名「已退役」，再归档。
 * 两步各自 try/catch：rename 失败不影响归档，archive 失败降级为「只改名」，两者都失败也只是「旧会话还在列表里」。
 * rename 是**覆盖**标题，所以重复调用幂等（恢复路径可能再跑一次）。
 * @returns {Promise<{renamed:boolean, archived:boolean}>}
 */
export async function disposeOldMainSession({ oldId, at, rename, archive, log = () => {}, onWarn } = {}) {
  const result = { renamed: false, archived: false }
  if (typeof oldId !== 'string' || oldId === '') return result
  const title = retiredMainSessionTitle(at)
  if (typeof rename === 'function') {
    try {
      await rename(oldId, title)
      result.renamed = true
      log('main.rotation.rename.ok', { detail: { sessionId: oldId, title } })
    } catch (error) {
      onWarn?.(`dsh-orchestrator: 旧主会话改名失败（轮换仍成立）：${errorText(error)}`)
      log('main.rotation.rename.failed', { detail: { sessionId: oldId, title, error: errorText(error) } })
    }
  } else {
    log('main.rotation.rename.failed', { detail: { sessionId: oldId, error: 'missing-rename-service' } })
  }
  result.archived = await archiveSessionQuietly(oldId, {
    archive,
    log,
    onWarn,
    event: 'main.rotation.archive',
  })
  return result
}

/**
 * 启动恢复（计划 §6 F6/F7）：把上次崩溃中断的轮换补完或回滚。**永不抛**，失败只 warn（下次启动重试）。
 *
 *   abandoned（marker.newId ≠ 指针）：死在切指针之前。旧指针一直有效，新会话是空白残留
 *     → 尽力归档该空白会话（从列表隐藏）+ 清 marker，**不回滚指针**（本来就没动过）。
 *   complete（marker.newId === 指针）：指针已切。补写缺失的时间戳、跳过 onboarding、
 *     对旧会话补「改名 + 归档」、写审计 + 清 marker（幂等）。
 *   invalid：marker 形状坏了（不知道谁是谁）→ 只告警 + 清 marker，绝不猜。
 *   none / unknown：无事可做（unknown = 启动早期还没有指针可比对，留给下次）。
 *
 * @param {object} opts
 * @param {object} opts.db 台账
 * @param {string} [opts.pointer] 当前台账主会话指针（resolvedCoordinatorId）
 * @param {Function} [opts.rename] async (sessionId, title) => void
 * @param {Function} [opts.archive] async sessionId => void
 * @param {Function} [opts.archiveOld] 旧主会话的归档动作（`rotateArchiveOld=false` 时为 undefined）
 * @param {number} [opts.now]
 * @param {Function} [opts.log] 结构化日志
 * @param {Function} [opts.onWarn] 告警
 * @returns {Promise<{ok:boolean, state:string, newId?:string, oldId?:string|null, archived?:boolean, renamed?:boolean, error?:string}>}
 */
export async function recoverPendingRotation({ db, pointer, rename, archive, archiveOld, now = Date.now(), log = () => {}, onWarn } = {}) {
  const warn = message => { if (typeof onWarn === 'function') onWarn(message) }
  try {
    const state = readRotationState(db)
    const pending = inspectRotationPending(state, pointer)
    if (pending.state === 'none' || pending.state === 'unknown') return { ok: true, state: pending.state }
    const marker = pending.marker
    const at = millisOf(marker.at) ?? now

    if (pending.state === 'invalid') {
      // 形状坏了就不知道该归档谁：宁可什么都不做，也不能拿一个猜出来的 id 去归档（不可逆）。
      clearRotationMarker(db)
      warn('dsh-orchestrator: 主会话轮换 marker 形状不合法，已清除（未做任何归档），请检查 logs 里的 main.rotation.pending.detected')
      log('main.rotation.recovered-invalid', { detail: { marker } })
      return { ok: true, state: 'invalid' }
    }

    if (pending.state === 'abandoned') {
      // F6：create 成功但指针没切 → 新会话是空白残留，归档它（隐藏），旧指针原样可用。
      const archived = await archiveSessionQuietly(marker.newId, {
        archive,
        log,
        onWarn: warn,
        event: 'main.rotation.recovered-abandoned',
      })
      clearRotationMarker(db)
      log('main.rotation.recovered-abandoned', {
        detail: { newId: marker.newId, oldId: marker.oldId ?? null, archived },
      })
      return { ok: true, state: 'abandoned', newId: marker.newId, oldId: marker.oldId ?? null, archived }
    }

    // F7：指针已切 → 只差「跳过 onboarding、处置旧会话、写审计」。
    // 时间戳缺失按 marker.at 补：不补的话冷却期失效，一次崩溃可能让下次打开立刻再轮换一次。
    try {
      const patch = {}
      if (state.createdAt === null) patch.createdAt = at
      if (state.rotatedAt === null) patch.rotatedAt = at
      if (Object.keys(patch).length > 0) writeRotationState(db, patch)
    } catch (error) {
      warn(`dsh-orchestrator: 主会话轮换恢复写时间戳失败（继续处置旧会话）：${errorText(error)}`)
    }
    try {
      // 崩溃可能落在跳过 onboarding 之前：这里补上，避免恢复后再派一次「工作区与仓库索引」。
      setSetting(db, onboardingKey(marker.newId), 'sent')
    } catch (error) {
      warn(`dsh-orchestrator: 主会话轮换恢复写 onboarding 标记失败：${errorText(error)}`)
    }
    const disposal = await disposeOldMainSession({ oldId: marker.oldId, at, rename, archive: archiveOld, log, onWarn: warn })
    let audit = null
    try {
      audit = recordRotation(db, {
        oldId: marker.oldId,
        newId: marker.newId,
        at,
        decision: { triggers: marker.reasons, reasons: [], metrics: {} },
        disposal,
        recovered: true,
      })
    } catch (error) {
      // 审计写不进 → marker 还在 → 下次启动再补（rename/archive 幂等）。
      warn(`dsh-orchestrator: 主会话轮换恢复写审计失败（下次启动重试）：${errorText(error)}`)
    }
    log('main.rotation.recovered-complete', {
      detail: { newId: marker.newId, oldId: marker.oldId ?? null, archived: disposal.archived, renamed: disposal.renamed },
    })
    return {
      ok: true,
      state: 'complete',
      newId: marker.newId,
      oldId: marker.oldId ?? null,
      archived: disposal.archived,
      renamed: disposal.renamed,
      audit,
    }
  } catch (error) {
    warn(`dsh-orchestrator: 主会话轮换恢复失败（下次启动重试）：${errorText(error)}`)
    log('main.rotation.recovered.failed', { detail: { error: errorText(error) } })
    return { ok: false, state: 'error', error: errorText(error) }
  }
}

/**
 * 轮换动作面（S3）：把「台账读写 + 可注入的平台动作」绑成一个服务给 main-session / index 用。
 *
 * 分工：
 *   - main-session.openOnce() 调 evaluate（采集 + 纯判定）→ due 时自己 create，再依次 begin / commitTimes / disposeOld / finish；
 *   - index 启动时调 recoverPending（补完上次崩溃）；
 *   - 平台服务（persistence/rename/archive）一律**惰性**取：cordis 并发加载时 apply 早期可能还没有。
 *
 * evaluate 只读（判定纯函数是 evaluateRotation），也不建会话（create 归 main-session，权限与错误文案都留在那儿）。
 * P1-A 删掉了检查节流（S7）：采集只剩一次 locate + stat，每次打开主会话都现算，不再写 main_rotation_checked_at。
 */
export function createRotationService({
  db,
  config = {},
  persistence,
  catalog,
  rename,
  archive,
  now = () => Date.now(),
  statFile = defaultStatFile,
  log = () => {},
  onWarn,
} = {}) {
  const resolve = value => (typeof value === 'function' ? value() : value)
  const warn = message => { if (typeof onWarn === 'function') onWarn(message) }

  /**
   * 采集 + 判定，返回 decision；任何异常 → null（调用方视为「本次不轮换」）。
   *
   * 这是**唯一**的判定入口（main-session.openOnce 在「打开主会话」时调一次）：
   *   1. 配置覆盖 / 没有主会话 id → null（连检测都不做）；
   *   2. 采集（locate + stat，拿不到就降级为「未知」）+ 纯判定；
   *   3. 判定结论只进审计日志，不落任何 settings 键（P1-A 起也不再有检查时间戳）。
   *
   * 不写判定结论、不建会话、不改指针、不留 due 标记；动作用下面的 begin/commitTimes/disposeOld/finish。
   * 平台服务是**惰性 getter**（cordis 并发加载期 `ctx.get` 可能抛），所以 try/catch 是契约的一部分，
   * 不是保险丝：判定失败只有一个语义——这次不换，打开主会话照常走复用分支，下次打开会重试。
   */
  const evaluate = async ({ mainSessionId, liveAgent, source = 'open' } = {}) => {
    try {
      // P6：配置覆盖的会话不具备轮换语义（解析顺序会直接无视指针）→ 连检测都不做。
      if (config?.coordinatorSession !== undefined) return null
      if (typeof mainSessionId !== 'string' || mainSessionId === '') return null
      const at = now()
      const state = readRotationState(db)
      const collected = await collectRotationMetrics({
        db,
        persistence: resolve(persistence),
        mainSession: liveAgent?.session,
        statFile,
        log,
      })
      let tasks = []
      try {
        tasks = listTasks(db)
      } catch (error) {
        warn(`dsh-orchestrator: 主会话轮换读取台账失败（按无任务处理）：${errorText(error)}`)
      }
      let catalogEntries
      if (typeof catalog === 'function') {
        try {
          catalogEntries = await catalog()
        } catch {
          // P8 读不到目录只代表「无法判断」，不能当成「有活跃子代理」也不能当成没有。
          catalogEntries = undefined
        }
      } else {
        catalogEntries = catalog
      }
      const decision = evaluateRotation({
        now: at,
        config,
        since: collected.since ?? undefined,
        lastRotatedAt: state.rotatedAt ?? undefined,
        metrics: collected.metrics,
        tasks,
        agentStatus: liveAgent?.status,
        logMtimeAt: collected.logMtimeAt ?? undefined,
        catalog: catalogEntries,
        degraded: collected.degraded,
      })
      // 判定结论只进审计日志（事后复盘「为什么换 / 为什么没换」），不落任何 settings 键。
      log('main.rotation.decided', {
        detail: {
          source,
          due: decision.due,
          triggers: decision.triggers,
          blockedBy: decision.blockedBy.map(item => item.code),
          degraded: decision.degraded,
          metrics: decision.metrics,
          since: collected.since,
          sinceSource: collected.sinceSource,
        },
      })
      return decision
    } catch (error) {
      warn(`dsh-orchestrator: 主会话轮换检测失败（本次不轮换）：${errorText(error)}`)
      log('main.rotation.failed', { detail: { source, error: errorText(error) } })
      return null
    }
  }

  const begin = ({ oldId, newId, at, decision } = {}) =>
    beginRotationMarker({ db, oldId, newId, at, reasons: decision?.reasons, log })

  const commitTimes = at => markRotationTimes(db, at)

  /** F3：指针没切成功时把空白新会话隐藏掉（归档失败也无所谓：它从来不是主会话）。 */
  const discard = async ({ sessionId } = {}) => {
    const archived = typeof sessionId === 'string' && sessionId !== ''
      ? await archiveSessionQuietly(sessionId, { archive, log, onWarn: warn, event: 'main.rotation.discard' })
      : false
    try {
      clearRotationMarker(db)
    } catch (error) {
      log('main.rotation.marker.clear.failed', { detail: { error: errorText(error) } })
    }
    return archived
  }

  const finish = ({ oldId, newId, at, decision, disposal } = {}) =>
    recordRotation(db, { oldId, newId, at, decision, disposal })

  // 注意：rename / archive 是**动作函数**，不是惰性 getter——直接传下去，不要 resolve()（那会当场调用它）。
  // `rotateArchiveOld=false` 时只改名不归档：归档不可逆（平台无 unarchive），留成用户可选的止血档位。
  const archiveOld = config?.rotateArchiveOld === false ? undefined : archive
  const disposeOld = ({ oldId, at } = {}) =>
    disposeOldMainSession({ oldId, at, rename, archive: archiveOld, log, onWarn: warn })

  const recoverPending = ({ pointer } = {}) =>
    recoverPendingRotation({ db, pointer, rename, archive, archiveOld, now: now(), log, onWarn: warn })

  return { evaluate, begin, commitTimes, discard, finish, disposeOld, recoverPending }
}
