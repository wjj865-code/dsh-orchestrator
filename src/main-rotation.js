// 主会话轮换（G1）判定内核 + 指标采集层：只回答「该不该换」，不建会话、不改指针、不加定时器。
//
// 为什么判定要单独一个纯函数：
//   轮换的副作用不可逆（旧主会话会改名，并被平台归档，而平台没有 unarchive API），
//   所以判据必须能脱离台账/磁盘/tokenMeter 单独单测：同一份「台账快照 + 配置 + 时间」
//   必须得到同一个结论；事后也能靠 main.rotation.decided 日志复盘「这次为什么换 / 为什么没换」。
//
// 本文件范围：
//   - S1：11 个配置键的默认值、合法区间与归一化（config.js 的 loadConfig 直接复用 normalizeRotationConfig）；
//     evaluateRotation()：M1–M6 六个触发因子 + P1–P10 十条保护 + 冷却/最小龄 + 原因文案
//   - S2：指标采集层（collectRotationMetrics：台账/persistence/tokenMeter/stat，每项 try/catch，
//     拿不到就是「未知」而不是 0）、settings 键读写（readRotationState / writeRotationDue）、
//     evaluateAndMarkRotation()（采集 + 纯判定 + 写 main_rotation_due 标记）、
//     rotationStatus()（snapshot 只读可见性）、inspectRotationPending()（崩溃恢复 marker 的只读判定）
// 仍不建会话、不改指针：真正轮换（S3）与启动/加载接线（S4）在读这些结果的基础上做。
import { stat } from 'node:fs/promises'
import { deleteSetting, getSetting, listTasks, setSetting } from './ledger.js'
import { onboardingKey } from './onboarding.js'

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
const MIB = 1024 * 1024

/**
 * 11 个配置键的默认值（计划 §3.3）。
 * `mainRotation` 是总开关：auto = 判定并（S3 起）动作；off = 只检测、不动作。
 * `rotateArchiveOld` = 轮换后是否把旧主会话交给平台归档（不可逆，S3 才用）。
 */
export const ROTATION_DEFAULTS = Object.freeze({
  mainRotation: 'auto',
  rotateAfterTasks: 120,
  rotateAfterSessions: 80,
  rotateAfterMainLogMiB: 6,
  rotateAfterContextTokens: 150_000,
  rotateAfterDays: 10,
  rotateAfterDiskMiB: 512,
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
  rotateAfterTasks: Object.freeze([1, 10_000, true]),
  rotateAfterSessions: Object.freeze([1, 10_000, true]),
  rotateAfterMainLogMiB: Object.freeze([0.5, 4096, false]),
  rotateAfterContextTokens: Object.freeze([1_000, 2_000_000, true]),
  rotateAfterDays: Object.freeze([1, 365, true]),
  rotateAfterDiskMiB: Object.freeze([16, 1_048_576, true]),
  rotateCooldownHours: Object.freeze([1, 720, true]),
  rotateMinAgeHours: Object.freeze([1, 720, true]),
  rotateIdleMinutes: Object.freeze([1, 1440, true]),
})

/** 总开关合法取值；拼错/其它值一律回落 auto（默认必须安全：不能因为配置写错就永久不换）。 */
export const MAIN_ROTATION_MODES = Object.freeze(['auto', 'off'])

/**
 * settings 键名（与台账 settings 表共用）。
 * S1 只声明；S2 负责读写与 mainSession.rotation 只读可见性，S3 负责真正切指针/收口。
 */
export const MAIN_SESSION_CREATED_AT_KEY = 'main_session_created_at'
export const MAIN_ROTATION_AT_KEY = 'main_rotation_at'
export const MAIN_ROTATION_DUE_KEY = 'main_rotation_due'
export const MAIN_ROTATION_LAST_KEY = 'main_rotation_last'
export const MAIN_ROTATION_PENDING_KEY = 'main_rotation_pending'

/**
 * 触发因子的固定顺序（M1→M6，与计划 §3.1 一致）。
 * reasons 按这个顺序输出，同一因子最多出现一次；顺序稳定才能做日志 diff 与单测断言。
 */
export const ROTATION_TRIGGERS = Object.freeze(['tasks', 'sessions', 'main-log', 'context-tokens', 'age', 'disk'])

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

/** 活跃任务口径（P1）：delivered 单独由 P2/P5 处理，不算「在跑」。 */
export const ROTATION_ACTIVE_STATUSES = Object.freeze(['waiting_dep', 'pending', 'running', 'waiting_user', 'waiting_auth'])

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
 * 把（可能是手写的、可能是 loadConfig 产物的）配置归一化成 11 个键。
 * 幂等：loadConfig 里再调一次也不会改变结果。
 */
export function normalizeRotationConfig(raw = {}) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const config = {
    mainRotation: source.mainRotation === 'off' ? 'off' : 'auto',
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
  tasks: (value, threshold) => `自上次轮换以来新增子任务 ${fmt(value)} 个（阈值 ${threshold}）`,
  sessions: (value, threshold) => `自上次轮换以来新增子会话 ${fmt(value)} 个（阈值 ${threshold}）`,
  'main-log': (value, threshold) => `主会话日志 ${fmt(value)} MiB（阈值 ${fmt(threshold)} MiB）`,
  'context-tokens': (value, threshold) => `当前上下文 ${fmt(value)} token（阈值 ${fmt(threshold)}）`,
  age: (value, threshold) => `主会话已运行 ${fmt(value)} 小时（阈值 ${fmt(threshold)} 小时）`,
  disk: (value, threshold) => `会话日志占用 ${fmt(value)} MiB（阈值 ${fmt(threshold)} MiB）`,
}

/**
 * 判定主会话是否该轮换。纯函数：不读库、不读盘、不看时钟（`now` 由调用方给），
 * 不改任何入参，同一输入永远同一输出。
 *
 * @param {object} input
 * @param {number} [input.now] 判定时刻（ms）；缺省 Date.now()
 * @param {object} [input.config] loadConfig 结果或手写配置（内部按 11 个键归一化，非法值回落）
 * @param {number} [input.since] 当前主会话起点（ms，来自 main_session_created_at，退 header.createdAt）
 * @param {number} [input.lastRotatedAt] 上次轮换时刻（ms，来自 main_rotation_at）；从未轮换传 undefined
 * @param {object} [input.metrics] 采集结果：tasksSince/sessionsSince/mainLogMiB/contextTokens/diskMiB
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

  // ---- 触发因子（M1–M6）----
  // 拿不到数值 = 该因子缺席（降级），不是 0：不能因为 tokenMeter 没挂就以为上下文很干净。
  const factorValue = {
    tasks: startedAt !== undefined && Number.isFinite(metrics?.tasksSince) ? metrics.tasksSince : undefined,
    sessions: startedAt !== undefined && Number.isFinite(metrics?.sessionsSince) ? metrics.sessionsSince : undefined,
    'main-log': Number.isFinite(metrics?.mainLogMiB) ? metrics.mainLogMiB : undefined,
    'context-tokens': Number.isFinite(metrics?.contextTokens) ? metrics.contextTokens : undefined,
    age: ageHours,
    disk: Number.isFinite(metrics?.diskMiB) ? metrics.diskMiB : undefined,
  }
  const threshold = {
    tasks: cfg.rotateAfterTasks,
    sessions: cfg.rotateAfterSessions,
    'main-log': cfg.rotateAfterMainLogMiB,
    'context-tokens': cfg.rotateAfterContextTokens,
    age: cfg.rotateAfterDays * 24,
    disk: cfg.rotateAfterDiskMiB,
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
  // 缺席因子按 M1→M6 排在前面，调用方补充的采集失败码跟在后面（去重，顺序稳定）。
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
      tasksSince: factorValue.tasks ?? null,
      sessionsSince: factorValue.sessions ?? null,
      mainLogMiB: factorValue['main-log'] ?? null,
      contextTokens: factorValue['context-tokens'] ?? null,
      ageHours: ageHours ?? null,
      diskMiB: factorValue.disk ?? null,
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
// S2：指标采集 + settings 键读写 + 只读可见性
//
// 三条硬约束（计划 §13 S2 / §3.1）：
//   1. 采集只读：不写台账、不写 settings、不建会话、不动指针（写 due 标记是 evaluateAndMarkRotation 的事）；
//   2. 失败降级为「未知」：任一服务缺失/抛错只记 degraded，不填 0——0 会被当成「很干净」而漏判；
//   3. 面板 2s 轮询路径不得触发采集：snapshot 只调 rotationStatus（读 settings），不 stat 磁盘、不 listSnapshots。
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

/** 路径比较口径：统一分隔符、去尾斜杠；不做大小写折叠（不同平台的路径语义不在这里猜）。 */
const pathKey = value => (typeof value === 'string' ? value.replace(/\\/g, '/').replace(/\/+$/, '') : '')

const errorText = error => `${error?.message ?? error}`

const defaultStatFile = async path => {
  const info = await stat(path)
  return { size: info.size, mtimeMs: info.mtimeMs }
}

/**
 * 读五个 settings 键（只读）。缺键/坏值一律为 null，由调用方按「未知」处理。
 * @returns {{createdAt:number|null, rotatedAt:number|null, due:object|null, last:object|null, pending:object|null}}
 */
export function readRotationState(db) {
  return {
    createdAt: millisOf(getSetting(db, MAIN_SESSION_CREATED_AT_KEY)),
    rotatedAt: millisOf(getSetting(db, MAIN_ROTATION_AT_KEY)),
    due: objectOf(getSetting(db, MAIN_ROTATION_DUE_KEY)),
    last: objectOf(getSetting(db, MAIN_ROTATION_LAST_KEY)),
    pending: objectOf(getSetting(db, MAIN_ROTATION_PENDING_KEY)),
  }
}

/** 五个键的一一对应（写入口共用；读侧按值类型分别解码）。 */
const ROTATION_SETTING_KEYS = Object.freeze({
  createdAt: MAIN_SESSION_CREATED_AT_KEY,
  rotatedAt: MAIN_ROTATION_AT_KEY,
  due: MAIN_ROTATION_DUE_KEY,
  last: MAIN_ROTATION_LAST_KEY,
  pending: MAIN_ROTATION_PENDING_KEY,
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
 * 把本次判定结果写进 `main_rotation_due`（面板 banner 与事后复盘的唯一入口）。
 * 只写这一个键：指针、冷却、审计、marker 都留给 S3 的轮换动作。
 * @returns {object} 实际落库的记录（字段顺序固定，便于日志/单测对比）
 */
export function writeRotationDue(db, decision, { source = 'manual', mainSessionId = null, since = null } = {}) {
  if (decision === null || typeof decision !== 'object') return null
  const record = {
    due: decision.due === true,
    mode: decision.mode ?? 'auto',
    triggers: Array.isArray(decision.triggers) ? decision.triggers : [],
    reasons: Array.isArray(decision.reasons) ? decision.reasons : [],
    blockedBy: Array.isArray(decision.blockedBy) ? decision.blockedBy : [],
    metrics: decision.metrics !== null && typeof decision.metrics === 'object' ? decision.metrics : {},
    degraded: Array.isArray(decision.degraded) ? decision.degraded : [],
    evaluatedAt: millisOf(decision.evaluatedAt),
    lastRotatedAt: millisOf(decision.lastRotatedAt),
    since: millisOf(since),
    mainSessionId: typeof mainSessionId === 'string' && mainSessionId !== '' ? mainSessionId : null,
    source,
  }
  writeRotationState(db, { due: record })
  return record
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
 * 采集 M1–M6 六项指标。每项独立 try/catch：失败记 degraded，值给 null（未知，不是 0）。
 * 只读：不写台账/settings/磁盘；调用方负责决定是否把结果写进 due 标记。
 *
 * @param {object} opts
 * @param {object} opts.db 台账
 * @param {object} [opts.persistence] 平台 sessionPersistence（listSnapshots/locate）；缺失则 M2/M3/M6 降级
 * @param {object} [opts.tokenMeter] 平台 tokenMeter（measure(session).totalTokens）；缺失或无 live 会话则 M4 降级
 * @param {string} [opts.mainSessionId] 当前主会话 id
 * @param {object} [opts.mainSession] live session（agent.session），启动时通常没有
 * @param {string} [opts.workspaceCwd] 指挥舱目录（header.cwd 缺失时兜底做 M2/M6 过滤）
 * @param {number} [opts.now] 采集时刻（ms）
 * @param {Function} [opts.statFile] stat 注入（单测用）；默认 fs/promises.stat
 * @param {Function} [opts.log] 结构化日志
 * @returns {Promise<{since:number|null, sinceSource:string|null, logMtimeAt:number|null,
 *   metrics:{tasksSince:number|null, sessionsSince:number|null, mainLogMiB:number|null,
 *     contextTokens:number|null, diskMiB:number|null}, degraded:string[], scanned:number}>}
 */
export async function collectRotationMetrics({
  db,
  persistence,
  tokenMeter,
  mainSessionId,
  mainSession,
  workspaceCwd,
  now = Date.now(),
  statFile = defaultStatFile,
  log = () => {},
} = {}) {
  const degraded = new Set()
  const metrics = {
    tasksSince: null,
    sessionsSince: null,
    mainLogMiB: null,
    contextTokens: null,
    diskMiB: null,
  }
  const degrade = (factor, error) => {
    degraded.add(factor)
    log('main.rotation.metrics.degraded', { detail: { factor, error: errorText(error) } })
  }

  // ---- 一次 listSnapshots 供 M2（自轮换以来新增会话）与 M6（会话日志总占用）共用 ----
  let snapshots = null
  const canListSnapshots = persistence !== null && typeof persistence === 'object' && typeof persistence.listSnapshots === 'function'
  if (canListSnapshots) {
    try {
      const listed = await persistence.listSnapshots()
      if (Array.isArray(listed)) snapshots = listed
      else degrade('sessions', new Error('listSnapshots 返回的不是数组'))
    } catch (error) {
      degrade('sessions', error)
      degrade('disk', error)
    }
  } else {
    const missing = new Error('缺少 sessionPersistence 服务（listSnapshots）')
    degrade('sessions', missing)
    degrade('disk', missing)
  }

  // ---- 主会话 header：live 优先，其次从快照里按指针找回（M3 定位、since 回退、cwd 过滤都要用）----
  let header = mainSession?.header !== null && typeof mainSession?.header === 'object' ? mainSession.header : undefined
  if (snapshots !== null && typeof mainSessionId === 'string' && mainSessionId !== '') {
    const found = snapshots.find(entry => entry?.header?.id === mainSessionId)?.header
    if (found !== null && typeof found === 'object') header = { ...found, ...(header ?? {}) }
  }

  // ---- since（M1/M2/M5 的起点）：settings 优先，退 header.createdAt；都拿不到就整组降级 ----
  let since = null
  let sinceSource = null
  try {
    const stored = millisOf(getSetting(db, MAIN_SESSION_CREATED_AT_KEY))
    if (stored !== null) {
      since = stored
      sinceSource = 'settings'
    }
  } catch (error) {
    degrade('tasks', error)
  }
  if (since === null && header !== undefined) {
    const headerAt = millisOf(header.createdAt)
    if (headerAt !== null) {
      since = headerAt
      sinceSource = 'header'
    }
  }
  if (since === null) {
    // 起点未知 = M1/M2/M5 都不可信；不是 0 个任务/0 个会话。
    for (const factor of ['tasks', 'sessions', 'age']) degraded.add(factor)
  }

  const cwdKey = pathKey(typeof header?.cwd === 'string' && header.cwd !== '' ? header.cwd : workspaceCwd)

  // ---- M1：自轮换以来的子任务数（台账 created_at >= since）----
  if (since !== null) {
    try {
      const tasks = listTasks(db)
      metrics.tasksSince = tasks.filter(task => {
        const createdAt = millisOf(task?.created_at)
        return createdAt !== null && createdAt >= since
      }).length
    } catch (error) {
      degrade('tasks', error)
    }
  }

  // ---- M2：自轮换以来的子会话数（header.createdAt >= since 且 cwd 是指挥舱）----
  if (snapshots !== null && since !== null && cwdKey !== '') {
    try {
      metrics.sessionsSince = snapshots.filter(entry => {
        const sessionHeader = entry?.header
        const createdAt = millisOf(sessionHeader?.createdAt)
        return createdAt !== null && createdAt >= since && pathKey(sessionHeader?.cwd) === cwdKey
      }).length
    } catch (error) {
      degrade('sessions', error)
    }
  } else if (snapshots !== null && cwdKey === '') {
    degrade('sessions', new Error('不知道指挥舱目录，无法按 cwd 过滤会话'))
  }

  // ---- M3：主会话日志体积（locate → stat，压缩后大小）；顺带拿 mtime 给 P4 ----
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

  // ---- M4：当前上下文 token（仅 live 会话）----
  const canMeasure = tokenMeter !== null && typeof tokenMeter === 'object' && typeof tokenMeter.measure === 'function'
  if (canMeasure && mainSession !== undefined && mainSession !== null) {
    try {
      const measurement = await tokenMeter.measure(mainSession)
      const total = measurement?.totalTokens
      if (!Number.isFinite(total)) throw new Error('measure 没有返回 totalTokens')
      metrics.contextTokens = total
    } catch (error) {
      degrade('context-tokens', error)
    }
  } else {
    degrade('context-tokens', new Error(canMeasure ? '主会话未加载，无法测量上下文' : '缺少 tokenMeter 服务'))
  }

  // ---- M6：插件会话日志总占用（cwd=指挥舱的全部会话逐个 stat）----
  if (snapshots !== null && cwdKey !== '' && canLocate) {
    let total = 0
    let matched = 0
    let failed = 0
    for (const entry of snapshots) {
      const sessionHeader = entry?.header
      if (pathKey(sessionHeader?.cwd) !== cwdKey) continue
      matched += 1
      try {
        const located = persistence.locate({ id: sessionHeader.id, cwd: sessionHeader.cwd })
        const info = await statFile(located?.path)
        if (!Number.isFinite(info?.size)) throw new Error('stat 没有返回 size')
        total += info.size
      } catch {
        // 单个日志读不到（并发删除/权限）不炸整次采集；有失败就标 degraded，数值只是下界。
        failed += 1
      }
    }
    if (matched > 0 && failed < matched) metrics.diskMiB = total / MIB
    if (failed > 0) {
      degraded.add('disk')
      log('main.rotation.metrics.degraded', { detail: { factor: 'disk', error: `${failed} 个会话日志 stat 失败（数值为下界）` } })
    }
    if (matched === 0) degrade('disk', new Error('没有 cwd=指挥舱的会话日志，占用无法统计'))
  } else if (snapshots !== null && cwdKey !== '') {
    // canLocate 为 false
    degrade('disk', new Error('缺少 sessionPersistence 服务（locate）'))
  }

  return {
    since,
    sinceSource,
    logMtimeAt,
    metrics,
    degraded: [...degraded],
    scanned: snapshots?.length ?? 0,
  }
}

/**
 * 采集 + 纯判定 + 写 `main_rotation_due`。**不建会话、不切指针**（那是 S3）。
 * 永不 reject：采集/判定整体异常 → fail-closed（不轮换）+ warn，绝不阻断插件加载或主会话打开。
 *
 * @param {object} opts
 * @param {object} opts.db 台账
 * @param {object} [opts.config] loadConfig 结果
 * @param {object} [opts.persistence] sessionPersistence 服务
 * @param {object} [opts.tokenMeter] tokenMeter 服务
 * @param {string} [opts.mainSessionId] 指针主会话
 * @param {object} [opts.liveAgent] 指针主会话的 live agent（有就量 token / 判 P3）
 * @param {object|Function} [opts.catalog] 子会话目录（dispatcher.catalog()）；函数形式会被 await
 * @param {string} [opts.workspaceCwd] 指挥舱目录
 * @param {string} [opts.source] 'startup' | 'agent-created' | 'manual'（写进 due 标记便于复盘）
 * @param {number} [opts.now] 判定时刻
 * @param {Function} [opts.statFile] stat 注入（单测用）
 * @param {Function} [opts.log] 结构化日志
 * @param {Function} [opts.onWarn] 告警（插件 logger.warn 口径）
 * @returns {Promise<{ok:boolean, skipped?:string, decision?:object, collected?:object, record?:object, pending?:object}>}
 */
export async function evaluateAndMarkRotation({
  db,
  config = {},
  persistence,
  tokenMeter,
  mainSessionId,
  liveAgent,
  catalog,
  workspaceCwd,
  source = 'manual',
  now = Date.now(),
  statFile = defaultStatFile,
  log = () => {},
  onWarn,
} = {}) {
  const warn = typeof onWarn === 'function' ? onWarn : () => {}
  try {
    // P6：配置覆盖的会话不具备轮换语义（解析顺序会直接无视指针）→ 连检测都不做、不写 due。
    if (config?.coordinatorSession !== undefined) return { ok: true, skipped: 'coordinator-override' }
    if (typeof mainSessionId !== 'string' || mainSessionId === '') return { ok: true, skipped: 'no-main-session' }
    const state = readRotationState(db)
    const collected = await collectRotationMetrics({
      db,
      persistence,
      tokenMeter,
      mainSessionId,
      mainSession: liveAgent?.session,
      workspaceCwd,
      now,
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
    const pending = inspectRotationPending(state, mainSessionId)
    const decision = evaluateRotation({
      now,
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
    const record = writeRotationDue(db, decision, { source, mainSessionId, since: collected.since })
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
        scanned: collected.scanned,
        pending: pending.state,
      },
    })
    if (pending.state === 'abandoned' || pending.state === 'complete' || pending.state === 'invalid') {
      // S2 只记录，不处置：恢复动作（归档空白残留/补归档旧会话）在 S3 的 recoverPending。
      log('main.rotation.pending.detected', { detail: { state: pending.state, newId: pending.marker?.newId ?? null } })
    }
    return { ok: true, decision, collected, record, pending }
  } catch (error) {
    warn(`dsh-orchestrator: 主会话轮换检测失败（本次不轮换）：${errorText(error)}`)
    log('main.rotation.failed', { detail: { source, error: errorText(error) } })
    return { ok: false, decision: null }
  }
}

/**
 * snapshot 的只读字段 `mainSession.rotation`：只读 settings（5 次点查），不采集、不写库。
 * 所以放进 2s 面板轮询是安全的（计划 §3.1「采集不进轮询」）。
 *
 * 形状契约（S5 面板直接消费）：{due, reasons, metrics, evaluatedAt, lastRotatedAt}
 * 还没判定过 / 读不到 → due/metrics 为 null（未知，不是 false/0），reasons 为空数组。
 */
export function rotationStatus(db) {
  let state
  try {
    state = readRotationState(db)
  } catch {
    return null
  }
  const record = state.due
  const metrics = record?.metrics
  return {
    due: typeof record?.due === 'boolean' ? record.due : null,
    reasons: Array.isArray(record?.reasons) ? record.reasons : [],
    metrics: metrics !== null && typeof metrics === 'object' ? metrics : null,
    evaluatedAt: millisOf(record?.evaluatedAt),
    lastRotatedAt: state.rotatedAt ?? millisOf(record?.lastRotatedAt),
  }
}

// ---------------------------------------------------------------------------
// S3：轮换动作（marker / 指针时间戳 / 审计 / 旧会话处置 / 崩溃恢复）
//
// 五条顺序原则（计划 §5.1 / §6，改顺序前先读这里）：
//   1. create 失败 = **零处置**：不写 marker、不动指针、不碰旧会话（回调方负责，本文件不猜）；
//   2. marker 是指针切换前唯一的崩溃锚点：**先 marker、后切指针**；
//   3. **先切指针、后处置旧会话**：rename/archive 失败最多留下「旧会话还在列表里」，
//      不会出现「新指针不可用、旧指针已退役」的悬空态；
//   4. 审计（main_rotation_last）+ 清 marker + 清 due 放在最后：崩溃在这之前，下次启动按 marker 补完；
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
 *   main_session_created_at = 新会话起点（M1/M2/M5 的 since）
 *   main_rotation_at        = 冷却期起点
 * 会抛（台账异常交调用方决定是否降级）；抛出不回滚指针——轮换已成立，只是少了防抖时间戳。
 */
export function markRotationTimes(db, at) {
  const value = Number.isFinite(at) ? at : Date.now()
  return writeRotationState(db, { createdAt: value, rotatedAt: value })
}

/**
 * 收尾：写审计 `main_rotation_last`（事后排查唯一入口），并**清掉** marker 与 due 标记。
 *   - 清 due：触发这次轮换的那份判定已经兑现，面板 banner 不该继续挂着「建议轮换」；
 *   - 写不进去会抛，marker 保留 → 下次启动 recoverPendingRotation 幂等补完（rename 覆盖标题、archive 幂等）。
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
  // 三个键各一条 UPSERT/DELETE：任一失败都会抛，marker 没清掉就还能下次补。
  writeRotationState(db, { last: record, pending: null, due: null })
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
 * 分工（计划 §5.1）：
 *   - main-session.openOnce() 调 evaluate → due 时自己 create，再依次 begin / commitTimes / disposeOld / finish；
 *   - index 启动时调 recoverPending（补完上次崩溃）；
 *   - 平台服务（persistence/tokenMeter/rename/archive）一律**惰性**取：cordis 并发加载时 apply 早期可能还没有。
 *
 * 所有方法都不做判定（判定在纯函数里），也不建会话（create 归 main-session，权限与错误文案都留在那儿）。
 */
export function createRotationService({
  db,
  config = {},
  persistence,
  tokenMeter,
  catalog,
  workspaceCwd,
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
   * 采集 + 判定 + 写 due（S2 的 evaluateAndMarkRotation），返回 decision；任何异常 → null（调用方视为不轮换）。
   *
   * S4：try/catch 是契约的一部分，不是保险丝。平台服务是**惰性 getter**（`ctx.get` 在 cordis 并发加载期
   * 可能抛或返回奇怪东西），那一步发生在 evaluateAndMarkRotation 之外；漏在这里抛，就会让「打开主会话」
   * 或启动对账后的检测变成一个用户可见的失败。判定失败的语义只有一个：本次不轮换，主流程照常。
   */
  const evaluate = async ({ mainSessionId, liveAgent, source = 'open' } = {}) => {
    try {
      const result = await evaluateAndMarkRotation({
        db,
        config,
        persistence: resolve(persistence),
        tokenMeter: resolve(tokenMeter),
        mainSessionId,
        liveAgent,
        catalog,
        workspaceCwd: resolve(workspaceCwd),
        source,
        now: now(),
        statFile,
        log,
        onWarn: warn,
      })
      return result?.decision ?? null
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
