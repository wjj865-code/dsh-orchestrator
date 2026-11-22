// 任务引用（`tk-xxxxxx`）：用户面与工具面的可读引用，替代裸 `t-xxxx` 编号。
//
// 为什么需要它（版本 B《ID 出口网关》，用户拍板）：用户反馈协调者回复与计划文档会意外透出
// `t-xxxx` 内部编号。结构性修法只有一条——**不把 id 喂给模型**：回执/brief/详情写 `tk-`，
// 模型手里没有 id，也就抄不进回复。因此：
//   - `task_refs` 是一张独立映射表（token 主键、task_id 唯一、retired_at 墓碑）；
//   - 生成时机：`createTask` 同事务生成；打开台账时幂等回填；`getTask` 命中无 token 时懒补；
//   - 删除任务置墓碑（`retired_at`），**永不复用**——旧的 pk 引用必须失效，不能指向新任务。
//
// 边界（不得放宽）：
//   1. 不是安全边界：只求不撞号、不反推主键；真正的门禁是「谁能调工具」。
//   2. 工具接口不变：参数仍叫 `task_id`、仍接受 `t-xxxx`；本模块只放宽**可接受值**。
//   3. 不做空参绑定（不按会话猜任务）、不做 session id 别名、不模糊/前缀/标题匹配。
//   4. 错误文案里不出现表名 / SQL / 内部列名 / 裸编号（用户面零 id，见报告出口清单）。
//
// 依赖方向：本模块**只碰 task_refs 与 tasks 的存在性**，不 import `src/ledger.js`
// （ledger 反过来 import 本模块；单向依赖避免环，见 ledger.js 头部注释的同类纪律）。
const PREFIX = 'tk-'

/** 生成字母表：31 字符，去掉易混的 0/1/l/o/i（人工抄写/朗读不会看错）。 */
export const TASK_REF_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'

/** token 长度（不含前缀）。 */
export const TASK_REF_LENGTH = 6

/** token 形状（`tk-` + 6 位；校验用超集，生成才受字母表约束）。 */
export const TASK_REF_RE = new RegExp(`^${PREFIX}[0-9a-z]{${TASK_REF_LENGTH}}$`)

/** 台账内部编号形状（`createTask` 生成 `t-` + 8 位十六进制；这里按历史口径放宽到 4–32）。 */
export const TASK_ID_RE = /^t-[0-9a-z]{4,32}$/

/** 撞号/并发冲突时的重试上限（31⁶ ≈ 8.9×10⁸，上限只是兜底）。 */
export const TASK_REF_MAX_ATTEMPTS = 3

// ── 可读错误文案（统一格式：说清「下一步怎么做」，不泄内部结构） ──────────────────
export const TASK_REF_MISSING = '缺少任务引用：task_list 的回执里有「任务名称（tk-xxxxxx）」，把那个引用抄过来。'
export const TASK_REF_UNKNOWN = '找不到这个任务引用。用 task_list 看任务的名称与引用（形如 tk-7f3a2c）；'
  + '要按台账内部编号查就去台账/日志里取，别从记忆里拼。'
export const TASK_REF_RETIRED = '这个引用已失效（任务可能已被删除）。用 task_list 看现有任务的名称与引用。'

const messageOf = error => String(error?.message ?? error ?? '')
const tableMissing = error => /no such table/i.test(messageOf(error))
const uniqueViolation = error => /UNIQUE|PRIMARY KEY/i.test(messageOf(error))

/**
 * 生成一个 token。`nextInt(max)` 可注入（测试用固定序列复现撞号）。
 * @param {(max: number) => number} [nextInt]
 */
export function generateTaskRef(nextInt) {
  const pick = typeof nextInt === 'function' ? nextInt : max => Math.floor(Math.random() * max)
  let body = ''
  for (let index = 0; index < TASK_REF_LENGTH; index += 1) {
    const at = Math.min(TASK_REF_ALPHABET.length - 1, Math.max(0, Math.floor(pick(TASK_REF_ALPHABET.length))))
    body += TASK_REF_ALPHABET[at]
  }
  return `${PREFIX}${body}`
}

/**
 * 任务的引用（没有 / 已失效返回 null）。只读，不写库——`getTask` 用它填充行上的 `ref`。
 * @returns {string | null}
 */
export function taskRefOf(db, taskId) {
  if (db === null || db === undefined || typeof db.prepare !== 'function') return null
  const id = typeof taskId === 'string' ? taskId.trim() : ''
  if (id === '') return null
  try {
    const row = db.prepare('SELECT token, retired_at FROM task_refs WHERE task_id = ?').get(id)
    if (row === undefined || row.retired_at !== null) return null
    return String(row.token)
  } catch (error) {
    if (tableMissing(error)) return null
    throw error
  }
}

/**
 * 确保任务有引用：已有就返回，没有就生成写入（撞号重试 ≤3 次）。
 *
 * 返回值 null 只有两种情形：taskId 为空、或该任务**已被删除**（墓碑行占着 task_id 唯一键，
 * 不新建也不复用）。调用方（派发主链路）据此只 warn，不阻塞派单——懒补会兜底。
 *
 * @param {object} db 台账
 * @param {string} taskId
 * @param {{now?: number, nextInt?: (max: number) => number}} [options]
 * @returns {string | null}
 */
export function ensureTaskRef(db, taskId, { now = Date.now(), nextInt } = {}) {
  const id = typeof taskId === 'string' ? taskId.trim() : ''
  if (id === '') return null
  const existing = taskRefOf(db, id)
  if (existing !== null) return existing
  let insert
  try {
    insert = db.prepare('INSERT INTO task_refs (token, task_id, created_at, retired_at) VALUES (?, ?, ?, NULL)')
  } catch (error) {
    if (tableMissing(error)) return null
    throw error
  }
  for (let attempt = 0; attempt < TASK_REF_MAX_ATTEMPTS; attempt += 1) {
    try {
      insert.run(generateTaskRef(nextInt), id, now)
      return taskRefOf(db, id)
    } catch (error) {
      if (tableMissing(error)) return null
      if (!uniqueViolation(error)) throw error
      // 撞号 → 换一个重试；task_id 被占（并发写/墓碑）→ 读回现有的，读不到就放弃。
      const again = taskRefOf(db, id)
      if (again !== null) return again
    }
  }
  return null
}

/**
 * 迁移回填：给所有还没有引用的任务补一行（幂等，`LEFT JOIN ... IS NULL`）。
 * 打开台账时跑一次；已删除任务（墓碑行）不会被补。
 * @returns {{created: number}}
 */
export function backfillTaskRefs(db, { now = Date.now(), nextInt } = {}) {
  let rows
  try {
    rows = db.prepare(`SELECT t.id AS id FROM tasks t
      LEFT JOIN task_refs r ON r.task_id = t.id
      WHERE r.token IS NULL`).all()
  } catch (error) {
    if (tableMissing(error)) return { created: 0 }
    throw error
  }
  let created = 0
  for (const row of Array.isArray(rows) ? rows : []) {
    if (ensureTaskRef(db, String(row.id), { now, nextInt }) !== null) created += 1
  }
  return { created }
}

/**
 * 置墓碑（任务删除时调用）：`retired_at` 置位后永不复用，解析报「引用已失效」。
 * @returns {boolean} 本次是否真的置位（重复调用返回 false）
 */
export function retireTaskRef(db, taskId, now = Date.now()) {
  const id = typeof taskId === 'string' ? taskId.trim() : ''
  if (id === '') return false
  try {
    const result = db.prepare('UPDATE task_refs SET retired_at = ? WHERE task_id = ? AND retired_at IS NULL')
      .run(now, id)
    return Number(result.changes) > 0
  } catch (error) {
    if (tableMissing(error)) return false
    throw error
  }
}

/**
 * 统一解析入口（五个 `task_*` 工具共用）：先 `t-xxxx`，未命中再 `tk-`，两者都不接受就报错。
 *
 * 只解析到 **taskId**，任务对象由调用方用 `getTask` 取（本模块不 import ledger，见头部依赖方向）。
 * 空值/未知值/已失效都返回可读 `message`（不含表名/SQL/内部列名/裸编号）。
 *
 * @returns {{ok: true, taskId: string, via: 'id' | 'ref'}
 *   | {ok: false, reason: 'empty' | 'invalid' | 'not-found' | 'retired', message: string}}
 */
export function resolveTaskInput(db, raw) {
  const value = typeof raw === 'string' ? raw.trim() : (raw === null || raw === undefined ? '' : String(raw).trim())
  if (value === '') return { ok: false, reason: 'empty', message: TASK_REF_MISSING }
  if (TASK_ID_RE.test(value)) {
    // 台账内部编号优先（现状行为不变）：存在性由这里确认，调用方不必再分叉。
    const row = db.prepare('SELECT 1 AS ok FROM tasks WHERE id = ?').get(value)
    return row === undefined
      ? { ok: false, reason: 'not-found', message: TASK_REF_UNKNOWN }
      : { ok: true, taskId: value, via: 'id' }
  }
  if (TASK_REF_RE.test(value)) {
    const row = db.prepare('SELECT task_id, retired_at FROM task_refs WHERE token = ?').get(value)
    if (row === undefined) return { ok: false, reason: 'not-found', message: TASK_REF_UNKNOWN }
    if (row.retired_at !== null) return { ok: false, reason: 'retired', message: TASK_REF_RETIRED }
    return { ok: true, taskId: String(row.task_id), via: 'ref' }
  }
  // 其它任意串（session id、标题、前缀、空参以外的胡写）：不猜、不模糊匹配。
  return { ok: false, reason: 'invalid', message: TASK_REF_UNKNOWN }
}

/** token 是否形如 `tk-xxxxxx`（出口清洗/测试断言用，不查库）。 */
export const looksLikeTaskRef = value => typeof value === 'string' && TASK_REF_RE.test(value.trim())
