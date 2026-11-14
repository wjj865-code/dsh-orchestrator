// 任务台账。SQLite，WAL，单写者串行化；所有状态迁移都过状态机。
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { nextStatus } from './state.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, goal TEXT NOT NULL, brief_json TEXT NOT NULL,
  status TEXT NOT NULL, session_id TEXT, target TEXT, target_dir TEXT, artifacts_json TEXT, coordinator_session TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  last_event_at INTEGER NOT NULL, error TEXT, queued_at INTEGER, read_only INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  task_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL,
  rendered TEXT NOT NULL, meta_json TEXT, at INTEGER NOT NULL, PRIMARY KEY (task_id, seq)
);
CREATE TABLE IF NOT EXISTS notifications (
  task_id TEXT NOT NULL, level TEXT NOT NULL, status TEXT NOT NULL,
  created_at INTEGER NOT NULL, delivered_at INTEGER, merged_into INTEGER, reason TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL
);`

export async function openLedger(stateDir) {
  const dbPath = join(stateDir, 'tasks.sqlite')
  let db
  try {
    mkdirSync(stateDir, { recursive: true })
    db = new DatabaseSync(dbPath)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec(SCHEMA)
    // 旧库补列（阶段 1 早期版本没有）。
    const columns = db.prepare('PRAGMA table_info(notifications)').all().map(row => row.name)
    if (!columns.includes('reason')) db.exec('ALTER TABLE notifications ADD COLUMN reason TEXT')
    const taskColumns = db.prepare('PRAGMA table_info(tasks)').all().map(row => row.name)
    if (!taskColumns.includes('queued_at')) db.exec('ALTER TABLE tasks ADD COLUMN queued_at INTEGER')
    if (!taskColumns.includes('target_dir')) db.exec('ALTER TABLE tasks ADD COLUMN target_dir TEXT')
    if (!taskColumns.includes('artifacts_json')) db.exec('ALTER TABLE tasks ADD COLUMN artifacts_json TEXT')
    if (!taskColumns.includes('read_only')) db.exec('ALTER TABLE tasks ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0')
    return db
  } catch (error) {
    try { db?.close() } catch { /* 打不开的库不需要再抛关闭错误 */ }
    const reason = error?.message ?? String(error)
    const corrupt = error?.errcode === 11 || error?.errcode === 26
      || /not a database|malformed|corrupt/i.test(reason)
    if (corrupt) {
      throw new Error(`台账损坏：${dbPath}（可尝试从 snapshots 目录恢复）：${reason}`)
    }
    const busy = error?.errcode === 5 || error?.errcode === 6 || /database is locked|database table is locked/i.test(reason)
    if (busy) throw new Error(`台账暂时不可用（被占用）：${dbPath}：${reason}`)
    throw new Error(`台账不可用：${dbPath}：${reason}`)
  }
}

const parseArtifacts = value => {
  if (value === null || value === undefined) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

const taskOf = row => row === undefined ? undefined : ({
  ...row,
  read_only: row.read_only === 1 || row.read_only === true,
  brief: JSON.parse(row.brief_json),
  artifacts: parseArtifacts(row.artifacts_json),
})

export function createTask(db, { brief, coordinatorSession, targetDir, readOnly = false }) {
  const now = Date.now()
  const id = `t-${randomUUID().slice(0, 8)}`
  db.prepare(`INSERT INTO tasks (id, title, goal, brief_json, status, coordinator_session, target_dir, read_only, created_at, updated_at, last_event_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`)
    .run(id, String(brief.title), String(brief.goal), JSON.stringify(brief), String(coordinatorSession ?? ''), targetDir ?? null, readOnly === true ? 1 : 0, now, now, now)
  return getTask(db, id)
}

export function getTask(db, id) {
  return taskOf(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id))
}

export function listTasks(db, { active = false } = {}) {
  const sql = active
    ? "SELECT * FROM tasks WHERE status IN ('pending','running','waiting_user','waiting_auth') ORDER BY created_at DESC, rowid DESC"
    : 'SELECT * FROM tasks ORDER BY created_at DESC, rowid DESC'
  return db.prepare(sql).all().map(taskOf)
}

/** 终态历史：按创建时间倒序取最多 limit 条（面板快照用，避免把活跃任务挤掉）。 */
export function listHistoryTasks(db, limit = 200) {
  return db.prepare(`SELECT * FROM tasks
    WHERE status NOT IN ('pending','running','waiting_user','waiting_auth')
    ORDER BY created_at DESC, rowid DESC LIMIT ?`)
    .all(Math.max(0, Math.floor(limit))).map(taskOf)
}

/** 标记「在排队」：pending + queued_at 非空，与「创建后没派出去」区分。 */
export function markQueued(db, id, at = Date.now()) {
  db.prepare('UPDATE tasks SET queued_at = ?, updated_at = ? WHERE id = ?').run(at, at, id)
  return getTask(db, id)
}

export function clearQueued(db, id) {
  db.prepare('UPDATE tasks SET queued_at = NULL, updated_at = ? WHERE id = ?').run(Date.now(), id)
  return getTask(db, id)
}

/** 待派发队列：pending 且还没有子会话，按创建顺序。 */
export function listPendingQueue(db) {
  return db.prepare("SELECT * FROM tasks WHERE status = 'pending' AND session_id IS NULL ORDER BY created_at ASC, rowid ASC")
    .all().map(taskOf)
}

export function countPending(db) {
  return db.prepare("SELECT count(*) AS n FROM tasks WHERE status = 'pending'").get().n
}

/** 任务的渲染文本（派发时用），取第一条 brief 消息。 */
export function briefText(db, id) {
  const row = db.prepare("SELECT rendered FROM messages WHERE task_id = ? AND kind = 'brief' ORDER BY seq ASC LIMIT 1").get(id)
  return row?.rendered
}

export function transition(db, id, to, patch = {}) {
  const task = getTask(db, id)
  if (task === undefined) throw new Error(`任务不存在：${id}`)
  nextStatus(task.status, to)
  const now = Date.now()
  const sets = ['status = ?', 'updated_at = ?', 'last_event_at = ?']
  const values = [to, now, now]
  if (Object.hasOwn(patch, 'sessionId')) { sets.push('session_id = ?'); values.push(patch.sessionId) }
  if (Object.hasOwn(patch, 'target')) { sets.push('target = ?'); values.push(patch.target) }
  if (Object.hasOwn(patch, 'error')) { sets.push('error = ?'); values.push(patch.error) }
  values.push(id)
  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  return getTask(db, id)
}

/** 记录子会话显式上报的交付产物（数组，元素 {path,label,exists}）；不改任务状态。 */
export function setTaskArtifacts(db, id, artifacts) {
  const now = Date.now()
  db.prepare('UPDATE tasks SET artifacts_json = ?, updated_at = ?, last_event_at = ? WHERE id = ?')
    .run(JSON.stringify(Array.isArray(artifacts) ? artifacts : []), now, now, id)
  return getTask(db, id)
}

/** 只更新时间戳，不改状态（progress 回报用）。 */
export function touchTask(db, id) {
  const now = Date.now()
  db.prepare('UPDATE tasks SET updated_at = ?, last_event_at = ? WHERE id = ?').run(now, now, id)
  return getTask(db, id)
}

export function setTaskError(db, id, error) {
  const now = Date.now()
  db.prepare('UPDATE tasks SET error = ?, updated_at = ?, last_event_at = ? WHERE id = ?')
    .run(error, now, now, id)
  return getTask(db, id)
}

/** 启动清理：把超时仍未派发出子会话的 pending 标成 failed；排队中的（queued_at 非空）和 running 不动。 */
export function failStalePending(db, { staleMinutes = 30, now = Date.now() } = {}) {
  const cutoff = now - staleMinutes * 60_000
  const rows = db.prepare("SELECT id FROM tasks WHERE status = 'pending' AND session_id IS NULL AND queued_at IS NULL AND created_at < ?").all(cutoff)
  if (rows.length === 0) return { count: 0, ids: [] }
  const at = Date.now()
  const update = db.prepare("UPDATE tasks SET status = 'failed', error = ?, updated_at = ?, last_event_at = ? WHERE id = ? AND status = 'pending'")
  for (const row of rows) update.run('派发中断：创建后没有派发出子会话', at, at, row.id)
  return { count: rows.length, ids: rows.map(row => row.id) }
}

export function incrementAttempts(db, id) {
  db.prepare('UPDATE tasks SET attempts = attempts + 1 WHERE id = ?').run(id)
  return getTask(db, id)
}

export function addMessage(db, taskId, { kind, rendered, meta = null }) {
  const next = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages WHERE task_id = ?').get(taskId).seq
  db.prepare('INSERT INTO messages (task_id, seq, kind, rendered, meta_json, at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(taskId, next, kind, String(rendered), meta === null ? null : JSON.stringify(meta), Date.now())
  return next
}

export function recentMessages(db, taskId, limit = 3) {
  return db.prepare('SELECT kind, rendered, at FROM messages WHERE task_id = ? ORDER BY seq DESC LIMIT ?').all(taskId, limit)
}

export function addNotification(db, { taskId, level, status = 'delivered', deliveredAt = Date.now(), mergedInto = null, reason = null }) {
  const result = db.prepare('INSERT INTO notifications (task_id, level, status, created_at, delivered_at, merged_into, reason) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(String(taskId), String(level), String(status), Date.now(), deliveredAt, mergedInto, reason)
  return Number(result.lastInsertRowid)
}

export function getSetting(db, key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value
}

export function setSetting(db, key, value) {
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(String(key), String(value), Date.now())
  return value
}

/** 首次绑定：只在 key 不存在时写入，返回最终值（并发时先到先得）。 */
export function bindSettingOnce(db, key, value) {
  db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING')
    .run(String(key), String(value), Date.now())
  return getSetting(db, key)
}

/** 失效重绑：只有当前值仍是 expected 时才替换，返回是否抢到。 */
export function rebindSetting(db, key, expected, next) {
  const result = db.prepare('UPDATE settings SET value = ?, updated_at = ? WHERE key = ? AND value = ?')
    .run(String(next), Date.now(), String(key), String(expected))
  return Number(result.changes) > 0
}

/** 主会话 settings 键：唯一协调者会话，不再靠首次 task_create 自动绑定。 */
export const MAIN_SESSION_KEY = 'main_session_id'

export function getMainSessionId(db) {
  return getSetting(db, MAIN_SESSION_KEY)
}

export function setMainSessionId(db, sessionId) {
  return setSetting(db, MAIN_SESSION_KEY, sessionId)
}

/** 主会话创建时用的预设：复用判断以台账为准，不依赖平台读回（真机会漂移）。 */
export const MAIN_SESSION_PRESET_KEY = 'main_session_preset'

export function getMainSessionPreset(db) {
  return getSetting(db, MAIN_SESSION_PRESET_KEY)
}

export function setMainSessionPreset(db, presetId) {
  return setSetting(db, MAIN_SESSION_PRESET_KEY, presetId)
}
