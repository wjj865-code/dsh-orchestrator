// 任务台账。SQLite，WAL，单写者串行化；所有状态迁移都过状态机。
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { nextStatus } from './state.js'
import { migrateLegacyTaskDone } from './memory.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, goal TEXT NOT NULL, brief_json TEXT NOT NULL,
  status TEXT NOT NULL, session_id TEXT, target TEXT, target_dir TEXT, artifacts_json TEXT, coordinator_session TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  last_event_at INTEGER NOT NULL, error TEXT, queued_at INTEGER, read_only INTEGER NOT NULL DEFAULT 0,
  retry_of TEXT, depends_json TEXT, group_id TEXT, write_scopes_json TEXT, priority INTEGER NOT NULL DEFAULT 0,
  question TEXT, question_options_json TEXT, progress_count INTEGER NOT NULL DEFAULT 0, stall_notified_at INTEGER,
  goal_state_json TEXT, last_message_json TEXT, keep_alive_rounds INTEGER NOT NULL DEFAULT 0,
  plan_first INTEGER NOT NULL DEFAULT 0, plan_state TEXT,
  access TEXT,
  worktree_path TEXT, worktree_branch TEXT, repo_root TEXT, worktree_base TEXT,
  worktree_mode TEXT, worktree_source TEXT, worktree_state TEXT,
  delivered_at INTEGER, close_reason TEXT
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
);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY, project_key TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
  source_task_id TEXT, source_session_id TEXT, hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL, last_used_at INTEGER, use_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_key, created_at DESC);`

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
    if (!taskColumns.includes('retry_of')) db.exec('ALTER TABLE tasks ADD COLUMN retry_of TEXT')
    if (!taskColumns.includes('depends_json')) db.exec('ALTER TABLE tasks ADD COLUMN depends_json TEXT')
    if (!taskColumns.includes('group_id')) db.exec('ALTER TABLE tasks ADD COLUMN group_id TEXT')
    if (!taskColumns.includes('write_scopes_json')) db.exec('ALTER TABLE tasks ADD COLUMN write_scopes_json TEXT')
    if (!taskColumns.includes('priority')) db.exec('ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0')
    if (!taskColumns.includes('question')) db.exec('ALTER TABLE tasks ADD COLUMN question TEXT')
    if (!taskColumns.includes('question_options_json')) db.exec('ALTER TABLE tasks ADD COLUMN question_options_json TEXT')
    if (!taskColumns.includes('progress_count')) db.exec('ALTER TABLE tasks ADD COLUMN progress_count INTEGER NOT NULL DEFAULT 0')
    if (!taskColumns.includes('stall_notified_at')) db.exec('ALTER TABLE tasks ADD COLUMN stall_notified_at INTEGER')
    if (!taskColumns.includes('goal_state_json')) db.exec('ALTER TABLE tasks ADD COLUMN goal_state_json TEXT')
    if (!taskColumns.includes('last_message_json')) db.exec('ALTER TABLE tasks ADD COLUMN last_message_json TEXT')
    // K2 keep-alive 预算：旧库补列，历史行按 0 轮（不阻止人工续派/重派）。
    if (!taskColumns.includes('keep_alive_rounds')) db.exec('ALTER TABLE tasks ADD COLUMN keep_alive_rounds INTEGER NOT NULL DEFAULT 0')
    // P8 计划模式：旧库补两列；历史行 plan_first=0 → taskOf 归一成 false / plan_state='none'。
    if (!taskColumns.includes('plan_first')) db.exec('ALTER TABLE tasks ADD COLUMN plan_first INTEGER NOT NULL DEFAULT 0')
    if (!taskColumns.includes('plan_state')) db.exec('ALTER TABLE tasks ADD COLUMN plan_state TEXT')
    // per-task 访问级别：NULL = 沿用会话策略（默认，老库/老行都是这条），'full' = 子会话 danger-full-access。
    if (!taskColumns.includes('access')) db.exec('ALTER TABLE tasks ADD COLUMN access TEXT')
    // P9 worktree 隔离：七列（哪份检出 / 哪个分支 / 源仓库 / 基线 / 请求档位 / 谁决定的 / 当前状态）。
    // `worktree_source` 取 task/config/default（v2：不再有 agents-md 这类来源枚举）。
    if (!taskColumns.includes('worktree_path')) db.exec('ALTER TABLE tasks ADD COLUMN worktree_path TEXT')
    if (!taskColumns.includes('worktree_branch')) db.exec('ALTER TABLE tasks ADD COLUMN worktree_branch TEXT')
    if (!taskColumns.includes('repo_root')) db.exec('ALTER TABLE tasks ADD COLUMN repo_root TEXT')
    if (!taskColumns.includes('worktree_base')) db.exec('ALTER TABLE tasks ADD COLUMN worktree_base TEXT')
    if (!taskColumns.includes('worktree_mode')) db.exec('ALTER TABLE tasks ADD COLUMN worktree_mode TEXT')
    if (!taskColumns.includes('worktree_source')) db.exec('ALTER TABLE tasks ADD COLUMN worktree_source TEXT')
    if (!taskColumns.includes('worktree_state')) db.exec('ALTER TABLE tasks ADD COLUMN worktree_state TEXT')
    // delivered 两段式终态：交付时间（超时自动 done 的判据）与关闭原因（coordinator / timeout，审计用）。
    // 旧库/存量行都是 NULL：面板与 task_status 按「没有交付/关闭记录」显示，存量 done 一律不动。
    if (!taskColumns.includes('delivered_at')) db.exec('ALTER TABLE tasks ADD COLUMN delivered_at INTEGER')
    if (!taskColumns.includes('close_reason')) db.exec('ALTER TABLE tasks ADD COLUMN close_reason TEXT')
    // M1 记忆分层：旧版 done 沉淀是 kind='task-done'，迁到日志层 task-log（迁移本身幂等）。
    migrateLegacyTaskDone(db)
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

const parseStringArray = value => {
  if (value === null || value === undefined) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string' && item !== '') : []
  } catch {
    return []
  }
}

// goal 只读镜像：坏 JSON 当没有（旧库/手工改库都不该让面板/任务读崩）。
const parseGoalState = value => {
  if (value === null || value === undefined) return null
  try {
    const parsed = JSON.parse(value)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

// 最新返回消息只读镜像（B1）：坏 JSON 当没有，读取方（task_status）降级为「没有返回消息」。
const parseLastMessage = value => {
  if (value === null || value === undefined) return null
  try {
    const parsed = JSON.parse(value)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

const taskOf = row => row === undefined ? undefined : ({
  ...row,
  read_only: row.read_only === 1 || row.read_only === true,
  // P8：计划模式两列 —— 旧行没有 plan_state（NULL）按 none；plan_first 归一成布尔。
  plan_first: row.plan_first === 1 || row.plan_first === true,
  plan_state: typeof row.plan_state === 'string' && row.plan_state !== '' ? row.plan_state : 'none',
  // per-task 访问级别：只有 'full' 是有效值，其余（NULL/旧库/手改坏值）一律归一成 null = 沿用会话策略。
  access: row.access === 'full' ? 'full' : null,
  // P9：worktree 七列 —— 旧行没有状态按 none；来源按 default（面板要能回答「谁决定的」）。
  worktree_path: row.worktree_path ?? null,
  worktree_branch: row.worktree_branch ?? null,
  repo_root: row.repo_root ?? null,
  worktree_base: row.worktree_base ?? null,
  worktree_mode: row.worktree_mode ?? null,
  worktree_source: typeof row.worktree_source === 'string' && row.worktree_source !== '' ? row.worktree_source : 'default',
  worktree_state: typeof row.worktree_state === 'string' && row.worktree_state !== '' ? row.worktree_state : 'none',
  brief: JSON.parse(row.brief_json),
  artifacts: parseArtifacts(row.artifacts_json),
  depends_on: parseStringArray(row.depends_json),
  write_scopes: parseStringArray(row.write_scopes_json),
  priority: Number.isFinite(row.priority) ? row.priority : 0,
  question: row.question ?? null,
  options: parseStringArray(row.question_options_json),
  progress_count: Number.isFinite(row.progress_count) ? row.progress_count : 0,
  goal_state: parseGoalState(row.goal_state_json),
  last_message: parseLastMessage(row.last_message_json),
  // K2：本段 activation 已用的 keep-alive 轮数（进 running 时归零）。
  keep_alive_rounds: Number.isFinite(row.keep_alive_rounds) ? row.keep_alive_rounds : 0,
  // delivered 两段式：交付时间（毫秒）与关闭原因（coordinator / timeout）；旧行都是 NULL。
  delivered_at: Number.isFinite(row.delivered_at) ? row.delivered_at : null,
  close_reason: typeof row.close_reason === 'string' && row.close_reason !== '' ? row.close_reason : null,
})

export function createTask(db, {
  brief,
  coordinatorSession,
  targetDir,
  readOnly = false,
  planFirst = false,
  planState,
  // per-task 访问级别：null（默认）= 沿用会话策略；'full' = 子会话 danger-full-access。
  access = null,
  // P9：隔离请求/结果快照（path/branch/repoRoot/base/mode/source/state）。
  worktree = null,
  retryOf = null,
  dependsOn = [],
  groupId = null,
  writeScopes = [],
  priority = 0,
  status = 'pending',
} = {}) {
  const now = Date.now()
  const id = `t-${randomUUID().slice(0, 8)}`
  const plan = planFirst === true
  const initialPlanState = typeof planState === 'string' && planState !== ''
    ? planState
    : (plan ? 'planning' : 'none')
  const wt = worktree !== null && typeof worktree === 'object' ? worktree : {}
  db.prepare(`INSERT INTO tasks
    (id, title, goal, brief_json, status, coordinator_session, target_dir, read_only, retry_of,
     depends_json, group_id, write_scopes_json, priority, plan_first, plan_state, access,
     worktree_path, worktree_branch, repo_root, worktree_base, worktree_mode, worktree_source, worktree_state,
     created_at, updated_at, last_event_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      id, String(brief.title), String(brief.goal), JSON.stringify(brief), status,
      String(coordinatorSession ?? ''), targetDir ?? null, readOnly === true ? 1 : 0, retryOf ?? null,
      JSON.stringify(Array.isArray(dependsOn) ? dependsOn : []), groupId ?? null,
      JSON.stringify(Array.isArray(writeScopes) ? writeScopes : []),
      Number.isFinite(priority) ? Math.trunc(priority) : 0,
      plan ? 1 : 0, initialPlanState, access === 'full' ? 'full' : null,
      wt.path ?? null, wt.branch ?? null, wt.repoRoot ?? null, wt.base ?? null,
      wt.mode ?? null, wt.source ?? null, wt.state ?? null,
      now, now, now,
    )
  return getTask(db, id)
}

export function getTask(db, id) {
  return taskOf(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id))
}

/** 按子会话反查任务（回合结束后的自动产物收集用）；同一会话只可能属于一条任务。 */
export function findTaskBySession(db, sessionId, { status } = {}) {
  if (sessionId === null || sessionId === undefined || sessionId === '') return undefined
  const row = status === undefined
    ? db.prepare('SELECT * FROM tasks WHERE session_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1').get(String(sessionId))
    : db.prepare('SELECT * FROM tasks WHERE session_id = ? AND status = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1').get(String(sessionId), status)
  return taskOf(row)
}

export function listTasks(db, { active = false } = {}) {
  const sql = active
    ? "SELECT * FROM tasks WHERE status IN ('waiting_dep','pending','running','waiting_user','waiting_auth','delivered') ORDER BY created_at DESC, rowid DESC"
    : 'SELECT * FROM tasks ORDER BY created_at DESC, rowid DESC'
  return db.prepare(sql).all().map(taskOf)
}

/** 终态历史：按创建时间倒序取最多 limit 条（面板快照用，避免把活跃任务挤掉）。 */
export function listHistoryTasks(db, limit = 200) {
  return db.prepare(`SELECT * FROM tasks
    WHERE status NOT IN ('waiting_dep','pending','running','waiting_user','waiting_auth','delivered')
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

/** 待派发队列：pending 且还没有子会话，按优先级降序、创建顺序升序。 */
export function listPendingQueue(db) {
  return db.prepare(`SELECT * FROM tasks
    WHERE status = 'pending' AND session_id IS NULL
    ORDER BY priority DESC, created_at ASC, rowid ASC`)
    .all().map(taskOf)
}

/** 队列安全阀口径：等待依赖的任务也算占位，避免等待中的图无限膨胀。 */
export function countPending(db) {
  return db.prepare("SELECT count(*) AS n FROM tasks WHERE status IN ('pending','waiting_dep')").get().n
}

/** 任务的渲染文本（派发时用），取第一条 brief 消息。 */
export function briefText(db, id) {
  const row = db.prepare("SELECT rendered FROM messages WHERE task_id = ? AND kind = 'brief' ORDER BY seq ASC LIMIT 1").get(id)
  return row?.rendered
}

const TERMINAL_PLAN_STATUSES = new Set(['done', 'failed', 'cancelled', 'orphaned', 'delivered'])

/**
 * 计划任务进终态时收口 `plan_state`：还在「等批准」（planning）就结束的，按「未批准」记；
 * 已 approved 的不改——历史里要看得出「用户批准过，并且执行到终态」。
 * 非终态迁移（如 waiting_user → running 之外的路径）不动 plan_state。
 * delivered（已交付待确认）也在这里收口：计划阶段已经结束，追问时不该再走一次「批准」。
 */
const nextPlanStateOnTransition = (task, to) => {
  if (task.plan_first !== true) return undefined
  if (!TERMINAL_PLAN_STATUSES.has(to)) return undefined
  if (task.plan_state !== 'planning') return undefined
  return 'rejected'
}

export function transition(db, id, to, patch = {}) {
  const task = getTask(db, id)
  if (task === undefined) throw new Error(`任务不存在：${id}`)
  nextStatus(task.status, to)
  const now = Date.now()
  const sets = ['status = ?', 'updated_at = ?', 'last_event_at = ?', 'progress_count = 0', 'stall_notified_at = NULL']
  // K2：每次进入 running 都是新的一段 activation，keep-alive 预算重新开始
  // （重派/续派/冷恢复都走 transition；running → running 本来不允许，所以不会误清）。
  if (to === 'running') sets.push('keep_alive_rounds = 0')
  const values = [to, now, now]
  // delivered 超时计时从「本次交付」起算：追问后再交付会重写时间，不会被旧交付时间提前收掉。
  if (to === 'delivered') { sets.push('delivered_at = ?'); values.push(now) }
  const planNext = nextPlanStateOnTransition(task, to)
  if (planNext !== undefined) { sets.push('plan_state = ?'); values.push(planNext) }
  if (Object.hasOwn(patch, 'sessionId')) { sets.push('session_id = ?'); values.push(patch.sessionId) }
  if (Object.hasOwn(patch, 'target')) { sets.push('target = ?'); values.push(patch.target) }
  if (Object.hasOwn(patch, 'error')) { sets.push('error = ?'); values.push(patch.error) }
  if (Object.hasOwn(patch, 'closeReason')) { sets.push('close_reason = ?'); values.push(patch.closeReason ?? null) }
  values.push(id)
  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  return getTask(db, id)
}

/** 记录子会话显式上报的交付产物（数组，元素 {path,label,exists}）；不改任务状态。
 *  同一任务多次回报按 path 合并：不同路径保留，同路径后报覆盖；总数上限 50，避免无限增长。 */
export const MAX_TASK_ARTIFACTS = 50

export function mergeArtifacts(current, incoming, max = MAX_TASK_ARTIFACTS) {
  const order = []
  const byPath = new Map()
  for (const item of Array.isArray(current) ? current : []) {
    if (item === null || typeof item !== 'object' || typeof item.path !== 'string' || item.path === '') continue
    if (!byPath.has(item.path)) order.push(item.path)
    byPath.set(item.path, item)
  }
  for (const item of Array.isArray(incoming) ? incoming : []) {
    if (item === null || typeof item !== 'object' || typeof item.path !== 'string' || item.path === '') continue
    if (!byPath.has(item.path)) order.push(item.path)
    byPath.set(item.path, item)
  }
  return order.slice(0, Math.max(0, Math.floor(max))).map(path => byPath.get(path))
}

export function setTaskArtifacts(db, id, artifacts) {
  const now = Date.now()
  const current = getTask(db, id)?.artifacts ?? []
  const merged = mergeArtifacts(current, artifacts)
  db.prepare('UPDATE tasks SET artifacts_json = ?, updated_at = ?, last_event_at = ? WHERE id = ?')
    .run(JSON.stringify(merged), now, now, id)
  return getTask(db, id)
}

/** 记录平台 goal 的只读镜像（G1）：不参与状态机，不改任务状态；null 表示清掉镜像。 */
export function setTaskGoalState(db, id, state) {
  const now = Date.now()
  db.prepare('UPDATE tasks SET goal_state_json = ?, updated_at = ? WHERE id = ?')
    .run(state === null || state === undefined ? null : JSON.stringify(state), now, id)
  return getTask(db, id)
}

/** 记录子会话最后一次返回消息（B1）：只写镜像，不改状态。
 *  同一段正文（digest 相同）重复落库是幂等的：不重写行、不动 updated_at，
 *  所以派发侧与生命周期事件重复送达、或手动重试，都不会把内容写两遍。 */
export function setTaskLastMessage(db, id, record) {
  if (record === null || record === undefined) return getTask(db, id)
  const task = getTask(db, id)
  if (task === undefined) return undefined
  const current = task.last_message
  if (current !== null && typeof current?.digest === 'string' && current.digest === record.digest) return task
  const now = Date.now()
  db.prepare('UPDATE tasks SET last_message_json = ?, updated_at = ?, last_event_at = ? WHERE id = ?')
    .run(JSON.stringify(record), now, now, id)
  return getTask(db, id)
}

/**
 * K2 keep-alive 预算：原子地给「仍在 running」的任务 +1 轮，返回新的轮数；
 * 已到上限（或任务已不在 running）返回 null，调用方据此停止注入。
 * 用条件 UPDATE 而不是「先读后写」，重复/并发的 turn-stopping 事件也不会超发。
 */
export function bumpKeepAliveRound(db, id, max) {
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 0
  const now = Date.now()
  const row = db.prepare(`UPDATE tasks SET keep_alive_rounds = keep_alive_rounds + 1, updated_at = ?, last_event_at = ?
    WHERE id = ? AND status = 'running' AND keep_alive_rounds < ?
    RETURNING keep_alive_rounds`).get(now, now, id, limit)
  return Number.isFinite(row?.keep_alive_rounds) ? row.keep_alive_rounds : null
}

/** 只更新时间戳，不改状态（progress 回报用）。 */
export function touchTask(db, id) {
  const now = Date.now()
  db.prepare('UPDATE tasks SET updated_at = ?, last_event_at = ? WHERE id = ?').run(now, now, id)
  return getTask(db, id)
}

/** P8：计划阶段的编排视图（none/planning/approved/rejected）；运行期真相在平台会话日志。 */
export function setPlanState(db, id, planState) {
  const now = Date.now()
  db.prepare('UPDATE tasks SET plan_state = ?, updated_at = ? WHERE id = ?')
    .run(String(planState), now, id)
  return getTask(db, id)
}

// P9：worktree 列 → 入参字段名（只允许这几个键，避免调用方拼错列名）。
const WORKTREE_FIELDS = {
  path: 'worktree_path',
  branch: 'worktree_branch',
  repoRoot: 'repo_root',
  base: 'worktree_base',
  mode: 'worktree_mode',
  source: 'worktree_source',
  state: 'worktree_state',
}

/**
 * P9：更新隔离快照（创建期写请求、派发期写检出、终态写清理）。
 * `targetDir` 一并可写：派发时 target_dir 换成「检出目录 + 原 target 偏移」。
 */
export function setTaskWorktree(db, id, patch = {}) {
  const sets = []
  const values = []
  for (const [key, column] of Object.entries(WORKTREE_FIELDS)) {
    if (!Object.hasOwn(patch, key)) continue
    sets.push(`${column} = ?`)
    values.push(patch[key] ?? null)
  }
  if (Object.hasOwn(patch, 'targetDir')) {
    sets.push('target_dir = ?')
    values.push(patch.targetDir ?? null)
  }
  if (sets.length === 0) return getTask(db, id)
  const now = Date.now()
  sets.push('updated_at = ?')
  values.push(now)
  values.push(id)
  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  return getTask(db, id)
}

/** 只换 target_dir（worktree 派发时把 cwd 指到检出目录里）。 */
export function setTaskTargetDir(db, id, targetDir) {
  db.prepare('UPDATE tasks SET target_dir = ?, updated_at = ? WHERE id = ?').run(targetDir ?? null, Date.now(), id)
  return getTask(db, id)
}

export function setTaskError(db, id, error) {
  const now = Date.now()
  db.prepare('UPDATE tasks SET error = ?, updated_at = ?, last_event_at = ? WHERE id = ?')
    .run(error, now, now, id)
  return getTask(db, id)
}

/** 子任务 blocked/needs_auth 时记录问题与选项；完成/继续后清空。 */
export function setTaskQuestion(db, id, { question = null, options = [] } = {}) {
  const now = Date.now()
  const text = typeof question === 'string' && question.trim() !== '' ? question.trim().slice(0, 500) : null
  const list = Array.isArray(options)
    ? options.filter(item => typeof item === 'string' && item.trim() !== '').map(item => item.trim().slice(0, 120)).slice(0, 10)
    : []
  db.prepare('UPDATE tasks SET question = ?, question_options_json = ?, updated_at = ?, last_event_at = ? WHERE id = ?')
    .run(text, JSON.stringify(list), now, now, id)
  return getTask(db, id)
}

export function clearTaskQuestion(db, id) {
  const now = Date.now()
  db.prepare('UPDATE tasks SET question = NULL, question_options_json = NULL, updated_at = ?, last_event_at = ? WHERE id = ?')
    .run(now, now, id)
  return getTask(db, id)
}

/** progress 回报计数；达到阈值且距上次提醒超过 staleMinutes 才返回 shouldNotify。 */
export function recordProgress(db, id, { stallRounds = 3, staleMinutes = 30, now = Date.now() } = {}) {
  const task = getTask(db, id)
  if (task === undefined) return undefined
  const count = (task.progress_count ?? 0) + 1
  const threshold = Number.isFinite(stallRounds) && stallRounds > 0 ? Math.floor(stallRounds) : 3
  const gap = (Number.isFinite(staleMinutes) ? staleMinutes : 30) * 60_000
  const shouldNotify = count >= threshold
    && (task.stall_notified_at === null || task.stall_notified_at === undefined || now - task.stall_notified_at >= gap)
  db.prepare(`UPDATE tasks SET progress_count = ?, stall_notified_at = ?, updated_at = ?, last_event_at = ? WHERE id = ?`)
    .run(count, shouldNotify ? now : (task.stall_notified_at ?? null), now, now, id)
  return { task: getTask(db, id), count, shouldNotify }
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

const parseMessageMeta = value => {
  if (value === null || value === undefined) return null
  try {
    const parsed = JSON.parse(value)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** 消息投递状态：followup 写入时是 pending（待发），投递成功后 delivered，失败后 failed。
 *  只改 meta_json，不新增消息行，也不动 seq/at。 */
const MESSAGE_DELIVERIES = new Set(['pending', 'delivered', 'failed'])

export function setMessageDelivery(db, taskId, seq, delivery, extra = {}) {
  if (!MESSAGE_DELIVERIES.has(delivery)) throw new Error(`未知投递状态：${delivery}`)
  const row = db.prepare('SELECT meta_json FROM messages WHERE task_id = ? AND seq = ?').get(taskId, seq)
  if (row === undefined) return false
  const meta = { ...(parseMessageMeta(row.meta_json) ?? {}), ...extra, delivery }
  db.prepare('UPDATE messages SET meta_json = ? WHERE task_id = ? AND seq = ?')
    .run(JSON.stringify(meta), taskId, seq)
  return true
}

export function recentMessages(db, taskId, limit = 3) {
  return db.prepare('SELECT seq, kind, rendered, meta_json, at FROM messages WHERE task_id = ? ORDER BY seq DESC LIMIT ?')
    .all(taskId, limit)
    .map(row => ({ seq: row.seq, kind: row.kind, rendered: row.rendered, at: row.at, meta: parseMessageMeta(row.meta_json) }))
}

/** 窗口内是否存在「已成功投递」的同文 followup（面板 message 幂等去重）。
 *  之后的 delivery_failed 行说明这次没送到，不算成功，允许立刻重发。 */
export function findRecentDeliveredFollowup(db, taskId, rendered, since) {
  return db.prepare(`SELECT f.seq, f.at FROM messages f
    WHERE f.task_id = ? AND f.kind = 'followup' AND f.rendered = ? AND f.at >= ?
      AND NOT EXISTS (
        SELECT 1 FROM messages d
        WHERE d.task_id = f.task_id AND d.kind = 'delivery_failed' AND d.seq > f.seq
      )
    ORDER BY f.seq DESC LIMIT 1`).get(taskId, String(rendered), since)
}

export function addNotification(db, { taskId, level, status = 'delivered', deliveredAt = Date.now(), mergedInto = null, reason = null }) {
  const result = db.prepare('INSERT INTO notifications (task_id, level, status, created_at, delivered_at, merged_into, reason) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(String(taskId), String(level), String(status), Date.now(), deliveredAt, mergedInto, reason)
  return Number(result.lastInsertRowid)
}

/**
 * 删除一条任务（面板「删除」/终态收尾）：任务行 + 它的 messages / notifications 一起清掉。
 * 只做台账级联：产物文件、reports 正文文件、记忆（memories）不动——把它们当用户数据/知识，
 * 删台账不该顺手删盘；平台侧的子会话历史也没有删除 API（见 docs/LIMITATIONS.md）。
 * 调用方（panel-actions）负责门控：只允许终态、且不能有活跃下游依赖。
 * @returns {undefined | {task: object, deleted: {messages: number, notifications: number}}}
 */
export function deleteTask(db, id) {
  const task = getTask(db, id)
  if (task === undefined) return undefined
  const messages = Number(db.prepare('DELETE FROM messages WHERE task_id = ?').run(id).changes)
  const notifications = Number(db.prepare('DELETE FROM notifications WHERE task_id = ?').run(id).changes)
  db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
  return { task, deleted: { messages, notifications } }
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
