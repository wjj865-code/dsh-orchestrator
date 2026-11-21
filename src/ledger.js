// 任务台账。SQLite，WAL，单写者串行化；所有状态迁移都过状态机。
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { ACTIVE_STATUSES, nextStatus } from './state.js'
import { statusesWith } from './status-facts.js'
// 从叶子模块取（worktree-facts 不 import 任何东西）：避免 ledger → worktree-request → worktree → ledger 的环。
import { nextWorktreeState } from './worktree-facts.js'
import { migrateLegacyTaskDone } from './memory.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, goal TEXT NOT NULL, brief_json TEXT NOT NULL,
  status TEXT NOT NULL, session_id TEXT, target TEXT, target_dir TEXT, artifacts_json TEXT, coordinator_session TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  last_event_at INTEGER NOT NULL, error TEXT, queued_at INTEGER, read_only INTEGER NOT NULL DEFAULT 0,
  retry_of TEXT, depends_json TEXT, group_id TEXT, write_scopes_json TEXT, priority INTEGER NOT NULL DEFAULT 0,
  question TEXT, question_options_json TEXT, progress_count INTEGER NOT NULL DEFAULT 0, stall_notified_at INTEGER,
  report_expected_at INTEGER,
  goal_state_json TEXT, last_message_json TEXT, keep_alive_rounds INTEGER NOT NULL DEFAULT 0,
  goal_rounds INTEGER NOT NULL DEFAULT 0,
  plan_first INTEGER NOT NULL DEFAULT 0, plan_state TEXT,
  access TEXT,
  worktree_path TEXT, worktree_branch TEXT, repo_root TEXT, worktree_base TEXT,
  worktree_mode TEXT, worktree_source TEXT, worktree_state TEXT,
  delivered_at INTEGER, close_reason TEXT, acceptance_json TEXT,
  accepted_by TEXT, accepted_at INTEGER,
  resume_count INTEGER NOT NULL DEFAULT 0, last_stop_reason TEXT,
  team_task_id TEXT, team_task_revision INTEGER
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
  source_task_id TEXT, source_session_id TEXT, source TEXT, hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL, last_used_at INTEGER, use_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_key, created_at DESC);
-- 工作台 v1（P11）：组元数据。id 就是 tasks.group_id 字符串且**不可变**（改名只改 name）：
-- worktree 复用（src/worktree-request.js 的 findReusableCheckout）与 task_list({group}) 都按这个字符串判定，
-- 改键会让历史结论静默漂移；要改键只能走显式的批量迁移动作（事务 + 审计）。
CREATE TABLE IF NOT EXISTS groups_v1 (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, goal TEXT, color TEXT,
  archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_groups_archived ON groups_v1(archived);
-- 工作台 v1：原生自动化的**镜像 + 授权审计**（真身在宿主 ctx.schedule）。
-- 本表只回答「这条自动化是谁在什么时候授权建的、绑在哪个组、最近一次投递如何」；
-- 触发/暂停/删除一律以宿主 schedule 服务为准（README「主会话原生自动化」）。
CREATE TABLE IF NOT EXISTS automations (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, ref_id TEXT, title TEXT NOT NULL, prompt TEXT NOT NULL,
  timing_json TEXT NOT NULL, schedule_id TEXT, target_session TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  authorized_by TEXT NOT NULL DEFAULT 'user', authorized_at INTEGER,
  expected_updated_at TEXT,
  last_fired_at INTEGER, last_result TEXT,
  deleted_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_automations_ref ON automations(kind, ref_id);`

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
    // 记忆来源（2026-11-21）：子会话也能写项目记忆后，行上要能区分「谁写的」（worker + taskId/sessionId）。
    // 旧库/存量行 NULL = 协调者或早期版本写入。
    const memoryColumns = db.prepare('PRAGMA table_info(memories)').all().map(row => row.name)
    if (!memoryColumns.includes('source')) db.exec('ALTER TABLE memories ADD COLUMN source TEXT')
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
    // 追问必达（t-99d4a98c）：追问/续跑投递成功后置位、任何回报到达后清空。旧库/存量行 NULL = 没在等回报。
    if (!taskColumns.includes('report_expected_at')) db.exec('ALTER TABLE tasks ADD COLUMN report_expected_at INTEGER')
    if (!taskColumns.includes('goal_state_json')) db.exec('ALTER TABLE tasks ADD COLUMN goal_state_json TEXT')
    if (!taskColumns.includes('last_message_json')) db.exec('ALTER TABLE tasks ADD COLUMN last_message_json TEXT')
    // K2 的轮数列：P2-2 删掉自建续跑器后**停写**，列保留只为旧库/历史导出一致
    // （新库照建，旧库照补，读出来恒为 0；轮次真源改由平台 goal 的 roundsStarted/maxGoalRounds 提供）。
    if (!taskColumns.includes('keep_alive_rounds')) db.exec('ALTER TABLE tasks ADD COLUMN keep_alive_rounds INTEGER NOT NULL DEFAULT 0')
    // P2-2 续跑预算：goalRounds（1–50，默认 0 = 不续跑）。派发时传给平台 goal 的 maxGoalRounds。
    if (!taskColumns.includes('goal_rounds')) db.exec('ALTER TABLE tasks ADD COLUMN goal_rounds INTEGER NOT NULL DEFAULT 0')
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
    // P2-1 A1 机器可判定验收：spec + 每次交付前的结果 JSON（旧库/存量行 NULL = 没跑过验收）。
    if (!taskColumns.includes('acceptance_json')) db.exec('ALTER TABLE tasks ADD COLUMN acceptance_json TEXT')
    // P2-3 交接契约 v1：谁确认（coordinator / panel / timeout）、何时确认（毫秒）。
    // 旧库/存量行都是 NULL：读出来是「没确认记录」，面板与 task_status 按「未确认」显示，存量行一律不动。
    if (!taskColumns.includes('accepted_by')) db.exec('ALTER TABLE tasks ADD COLUMN accepted_by TEXT')
    if (!taskColumns.includes('accepted_at')) db.exec('ALTER TABLE tasks ADD COLUMN accepted_at INTEGER')
    // P2-4（D6）：可选关联官方 Team 板任务 —— id 与「创建时读到的 revision」（确认反写时的 CAS 基线）。
    // 旧库/存量行都是 NULL = 没关联官方任务，确认时不做任何反写。
    if (!taskColumns.includes('team_task_id')) db.exec('ALTER TABLE tasks ADD COLUMN team_task_id TEXT')
    if (!taskColumns.includes('team_task_revision')) db.exec('ALTER TABLE tasks ADD COLUMN team_task_revision INTEGER')
    // v0.24 resume：resume_count 数「收尾后被冷恢复」的次数（与 activation 轮数 attempts 分开，度量里要
    // 能单独算复用率）；last_stop_reason 记最近一次结算的 stopReason（旧库存量行都是 NULL）。
    if (!taskColumns.includes('resume_count')) db.exec('ALTER TABLE tasks ADD COLUMN resume_count INTEGER NOT NULL DEFAULT 0')
    if (!taskColumns.includes('last_stop_reason')) db.exec('ALTER TABLE tasks ADD COLUMN last_stop_reason TEXT')
    // 工作台 v1（P11）L1：计划日（人工排期，纯展示）。旧库/存量行 NULL = 未排期。
    // 与 L2（automations + 宿主 schedule 的到点触发）**互不推导**：日历上排一天不等于授权定时派单。
    if (!taskColumns.includes('planned_at')) db.exec('ALTER TABLE tasks ADD COLUMN planned_at INTEGER')
    // 索引必须建在补列之后（旧库上 SCHEMA 里建会因列不存在直接抛）。
    db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_planned ON tasks(planned_at)')
    // 组 backfill：存量 group_id 落一行元数据（name 默认等于 id），幂等、只补缺的。
    backfillGroups(db)
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

// 验收记录（P2-1）：坏 JSON 当没有，读取方（面板 / task_status）按「没跑过验收」显示。
const parseAcceptance = value => {
  if (value === null || value === undefined) return null
  try {
    const parsed = JSON.parse(value)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return Array.isArray(parsed.results) ? parsed : null
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
  // 追问必达（t-99d4a98c）：追问/续跑投递成功后置位，下一条回报按「必达」投递；旧行 NULL = 没在等回报。
  report_expected_at: Number.isFinite(row.report_expected_at) ? row.report_expected_at : null,
  goal_state: parseGoalState(row.goal_state_json),
  last_message: parseLastMessage(row.last_message_json),
  // K2 的轮数列：P2-2 起插件不再写（停写），只为旧库/历史导出保留读取。
  keep_alive_rounds: Number.isFinite(row.keep_alive_rounds) ? row.keep_alive_rounds : 0,
  // P2-2：续跑预算（task_create.goalRounds，0 = 不续跑）；派发时作为平台 goal 的 maxGoalRounds。
  goal_rounds: Number.isFinite(row.goal_rounds) ? row.goal_rounds : 0,
  // delivered 两段式：交付时间（毫秒）与关闭原因（coordinator / timeout）；旧行都是 NULL。
  delivered_at: Number.isFinite(row.delivered_at) ? row.delivered_at : null,
  close_reason: typeof row.close_reason === 'string' && row.close_reason !== '' ? row.close_reason : null,
  // P2-1：最近一次交付前验收的结果（spec + 每条 check 的退出码/耗时/输出尾部）；没跑过是 null。
  acceptance: parseAcceptance(row.acceptance_json),
  // P2-3 交接契约：确认人（coordinator / panel / timeout）与确认时间；未确认（含存量行）都是 null。
  accepted_by: typeof row.accepted_by === 'string' && row.accepted_by !== '' ? row.accepted_by : null,
  accepted_at: Number.isFinite(row.accepted_at) ? row.accepted_at : null,
  // P2-4（D6）：官方 Team 板关联（可选）。id 为空/旧库 → null = 没关联，确认时不反写。
  team_task_id: typeof row.team_task_id === 'string' && row.team_task_id !== '' ? row.team_task_id : null,
  team_task_revision: Number.isSafeInteger(row.team_task_revision) && row.team_task_revision >= 0 ? row.team_task_revision : null,
  // v0.24 resume：续跑次数（收尾后被冷恢复的次数）与最近一次结算原因（failed/orphaned 的 stopReason）。
  resume_count: Number.isFinite(row.resume_count) ? row.resume_count : 0,
  last_stop_reason: typeof row.last_stop_reason === 'string' && row.last_stop_reason !== '' ? row.last_stop_reason : null,
  // 工作台 v1（P11）L1：计划日（毫秒）。旧行/旧库 NULL = 未排期；0/负数当未排期。
  planned_at: Number.isFinite(row.planned_at) && row.planned_at > 0 ? row.planned_at : null,
})

export function createTask(db, {
  brief,
  coordinatorSession,
  targetDir,
  readOnly = false,
  planFirst = false,
  planState,
  // P2-2：续跑轮次预算（1–50，默认 0 = 不续跑）。派发时作为平台 goal 的 maxGoalRounds。
  goalRounds = 0,
  // per-task 访问级别：null（默认）= 沿用会话策略；'full' = 子会话 danger-full-access。
  access = null,
  // P9：隔离请求/结果快照（path/branch/repoRoot/base/mode/source/state）。
  worktree = null,
  // P2-4（D6）：可选关联官方 Team 板任务 `{ id, revision }`（revision = 创建时读到的 CAS 基线）。
  teamTask = null,
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
  const team = teamTask !== null && typeof teamTask === 'object' && typeof teamTask.id === 'string' && teamTask.id !== ''
    ? { id: teamTask.id, revision: Number.isSafeInteger(teamTask.revision) && teamTask.revision >= 0 ? teamTask.revision : null }
    : null
  db.prepare(`INSERT INTO tasks
    (id, title, goal, brief_json, status, coordinator_session, target_dir, read_only, retry_of,
     depends_json, group_id, write_scopes_json, priority, plan_first, plan_state, access,
     worktree_path, worktree_branch, repo_root, worktree_base, worktree_mode, worktree_source, worktree_state,
     goal_rounds, team_task_id, team_task_revision, created_at, updated_at, last_event_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      id, String(brief.title), String(brief.goal), JSON.stringify(brief), status,
      String(coordinatorSession ?? ''), targetDir ?? null, readOnly === true ? 1 : 0, retryOf ?? null,
      JSON.stringify(Array.isArray(dependsOn) ? dependsOn : []), groupId ?? null,
      JSON.stringify(Array.isArray(writeScopes) ? writeScopes : []),
      Number.isFinite(priority) ? Math.trunc(priority) : 0,
      plan ? 1 : 0, initialPlanState, access === 'full' ? 'full' : null,
      wt.path ?? null, wt.branch ?? null, wt.repoRoot ?? null, wt.base ?? null,
      wt.mode ?? null, wt.source ?? null, wt.state ?? null,
      Number.isFinite(goalRounds) && goalRounds > 0 ? Math.trunc(goalRounds) : 0,
      team?.id ?? null, team?.revision ?? null,
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

// 活跃状态写进 SQL 时由常量生成，不再手抄字面量（0.19.x 这里有两处硬编码，新增状态必漏）。
// 值是冻结常量（STATUS_CAPS 的 key 派生），不含用户输入，没有注入面。
const ACTIVE_SQL = ACTIVE_STATUSES.map(status => `'${status}'`).join(',')

export function listTasks(db, { active = false } = {}) {
  const sql = active
    ? `SELECT * FROM tasks WHERE status IN (${ACTIVE_SQL}) ORDER BY created_at DESC, rowid DESC`
    : 'SELECT * FROM tasks ORDER BY created_at DESC, rowid DESC'
  return db.prepare(sql).all().map(taskOf)
}

/** 终态历史：按创建时间倒序取最多 limit 条（面板快照用，避免把活跃任务挤掉）。 */
export function listHistoryTasks(db, limit = 200) {
  return db.prepare(`SELECT * FROM tasks
    WHERE status NOT IN (${ACTIVE_SQL})
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

/**
 * 旧行的简报正文（派发时的兜底读法）。
 *
 * P1（0.30.1）起不再作为派发来源：台账 messages 里的 brief 只有借条（摘要），
 * 派发一律用 `renderBriefForTask(task)` 现渲染（确定性输出）。此函数只为读**旧库**里
 * 仍有全文的 brief 行 / 历史导出保留。
 */
export function briefText(db, id) {
  const row = db.prepare("SELECT rendered FROM messages WHERE task_id = ? AND kind = 'brief' ORDER BY seq ASC LIMIT 1").get(id)
  return row?.rendered
}

// 计划收口口径来自 status-facts 的 `planSettled` 能力（done/failed/cancelled/orphaned/delivered）。
const TERMINAL_PLAN_STATUSES = new Set(statusesWith('planSettled'))

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

// 状态迁移的审计观察者：`transition` 是**全部**状态变化的唯一入口（19 个调用点），
// 在这里挂一次观察者就能覆盖全部迁移，不必让每个调用方自己记得写日志
// （0.19.x 的 19 个调用点里只有 6 个有对应日志，审计 §4.5 把「状态为什么变」列为最大可观测性缺口）。
// 用模块级 sink 而不是给 `transition` 加参数：调用签名不动，19 个调用点零改动。
// P2-3 起观察者在 **UPDATE 落库之后** 触发：订阅方（交接事件）要能读到迁移后的任务行
// （`delivered_at` 就是这次 UPDATE 写的），否则会拿到迁移前的快照。
let transitionObserver = null

/** 注册迁移观察者（index.js 启动时接 logger；测试不注册即静默）。返回解绑函数。 */
export function setTransitionObserver(observer) {
  transitionObserver = typeof observer === 'function' ? observer : null
  return () => { if (transitionObserver === observer) transitionObserver = null }
}

export function transition(db, id, to, patch = {}) {
  const task = getTask(db, id)
  if (task === undefined) throw new Error(`任务不存在：${id}`)
  nextStatus(task.status, to)
  const now = Date.now()
  const sets = ['status = ?', 'updated_at = ?', 'last_event_at = ?', 'progress_count = 0', 'stall_notified_at = NULL']
  const values = [to, now, now]
  // delivered 超时计时从「本次交付」起算：追问后再交付会重写时间，不会被旧交付时间提前收掉。
  if (to === 'delivered') { sets.push('delivered_at = ?'); values.push(now) }
  const planNext = nextPlanStateOnTransition(task, to)
  if (planNext !== undefined) { sets.push('plan_state = ?'); values.push(planNext) }
  if (Object.hasOwn(patch, 'sessionId')) { sets.push('session_id = ?'); values.push(patch.sessionId) }
  if (Object.hasOwn(patch, 'target')) { sets.push('target = ?'); values.push(patch.target) }
  if (Object.hasOwn(patch, 'error')) { sets.push('error = ?'); values.push(patch.error) }
  if (Object.hasOwn(patch, 'closeReason')) { sets.push('close_reason = ?'); values.push(patch.closeReason ?? null) }
  // v0.24：结算落最近一次 stopReason（resume 判定与面板文案要用）；不传则不动这一列。
  if (Object.hasOwn(patch, 'lastStopReason')) { sets.push('last_stop_reason = ?'); values.push(patch.lastStopReason ?? null) }
  values.push(id)
  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  // 观察者失败绝不能影响迁移本身（日志/事件是旁路）；放在落库之后，订阅方能读到新行。
  if (transitionObserver !== null) {
    try {
      transitionObserver({
        taskId: id,
        from: task.status,
        to,
        sessionId: task.session_id ?? null,
        reason: typeof patch.error === 'string' ? patch.error : null,
        closeReason: patch.closeReason ?? null,
      })
    } catch { /* 日志旁路 */ }
  }
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

/**
 * 记录交付前验收结果（P2-1 A1）：只写镜像列，不改状态机。
 * 失败时状态必须保持 running（由调用方保证），这里只负责把 spec + 每条 check 的证据落库。
 */
export function setTaskAcceptance(db, id, record) {
  const now = Date.now()
  db.prepare('UPDATE tasks SET acceptance_json = ?, updated_at = ?, last_event_at = ? WHERE id = ?')
    .run(record === null || record === undefined ? null : JSON.stringify(record), now, now, id)
  return getTask(db, id)
}

/**
 * 记录交接确认（P2-3 交接契约 v1）：谁确认的（coordinator / panel / timeout）与确认时间。
 * 只写列 + 时间戳，不改状态机——状态迁移由 `closeDelivered` 调 `transition` 完成。
 * 幂等由调用方保证（`closeDelivered` 的 `already` 分支直接返回，不重复写）。
 */
export function setTaskAccepted(db, id, { acceptedBy = null, acceptedAt = Date.now() } = {}) {
  const at = Number.isFinite(acceptedAt) ? acceptedAt : Date.now()
  db.prepare('UPDATE tasks SET accepted_by = ?, accepted_at = ?, updated_at = ?, last_event_at = ? WHERE id = ?')
    .run(typeof acceptedBy === 'string' && acceptedBy !== '' ? acceptedBy : null, at, at, at, id)
  return getTask(db, id)
}

/** 追问次数（交接契约 `rounds.followups`）：台账里 kind='followup' 的消息条数。
 *  一次追问一条（投递失败会另写 kind='delivery_failed'，不重复计数同一行的续发）。 */
export function countFollowups(db, taskId) {
  const row = db.prepare("SELECT count(*) AS n FROM messages WHERE task_id = ? AND kind = 'followup'").get(String(taskId))
  return Number.isFinite(row?.n) ? row.n : 0
}

/** 窗口内的消息条数（工作台复盘页用：只数台账既有 messages，不新增埋点、不加索引以外的 schema）。
 *  时间口径取 `messages.at`（写入时间），窗口由调用方按 [from, to] 闭区间给。 */
export function countMessagesBetween(db, { from = 0, to = Number.MAX_SAFE_INTEGER } = {}) {
  const start = Number.isFinite(from) ? from : 0
  const end = Number.isFinite(to) ? to : Number.MAX_SAFE_INTEGER
  const row = db.prepare('SELECT count(*) AS n FROM messages WHERE at >= ? AND at <= ?').get(start, end)
  return Number.isFinite(row?.n) ? row.n : 0
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
  // 转移合法性校验（审计 §2.4）：0.19.x 这里可以写任意值，8 个状态没有任何守卫。
  // 与 `tasks.status` 的 `transition` 同一种做法：非法转移抛错，而不是静默写进去。
  // 只校验「状态」这一项；路径/分支/基线是快照字段，任何时候都可以补写。
  if (Object.hasOwn(patch, 'state') && patch.state !== null && patch.state !== undefined) {
    const current = getTask(db, id)
    if (current !== undefined) nextWorktreeState(current.worktree_state ?? 'none', patch.state)
  }
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

/**
 * 追问/续跑投递成功：标记「这条任务的下一条回报必达」（notify 的追问必达判据）。
 *
 * 为什么落台账、而不是在 notify 里靠「最近一条 followup」猜：追问可能发生在很久以前，中间还夹着
 * 结算、状态迁移、插件重启；台账一行是唯一能跨回合活下来的事实，也让「谁在等回报」可审计。
 */
export function markReportExpected(db, id, now = Date.now()) {
  db.prepare('UPDATE tasks SET report_expected_at = ? WHERE id = ?').run(now, id)
  return getTask(db, id)
}

/** 回报到达（progress / done / blocked / needs_auth）：清标记——追问已得到回答，下一条回归正常节奏。 */
export function clearReportExpected(db, id) {
  db.prepare('UPDATE tasks SET report_expected_at = NULL WHERE id = ?').run(id)
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

/** v0.24：续跑次数（收尾后冷恢复原会话）。与 attempts 分工：续跑时两者都 +1，追问只 +1 attempts。 */
export function incrementResumeCount(db, id) {
  db.prepare('UPDATE tasks SET resume_count = resume_count + 1 WHERE id = ?').run(id)
  return getTask(db, id)
}

/** 任务的消息条数（brief / report / settle / followup / resume 全算）：resume 的历史长度阈值用。 */
export function countTaskMessages(db, taskId) {
  const row = db.prepare('SELECT count(*) AS n FROM messages WHERE task_id = ?').get(String(taskId))
  return Number.isFinite(row?.n) ? row.n : 0
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

/** 删除 settings 键（轮换 marker 收尾等一次性状态用）：键不存在也算成功。 */
export function deleteSetting(db, key) {
  db.prepare('DELETE FROM settings WHERE key = ?').run(String(key))
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

// ---------------------------------------------------------------------------
// 工作台 v1（P11）：组元数据 / 计划日 / 自动化镜像
//
// 三条边界（设计稿 §4，实施时不得放宽）：
// 1. 组表只是**元数据**：`groups_v1.id` 就是 `tasks.group_id`，不可变；改名只改 `name`。
//    （表名带 `_v1` 是因为 `GROUPS` 是 SQLite 的窗口帧关键字，不加引号会撞语法。）
// 2. `planned_at`（L1）与 `automations`（L2）互不推导：排一天不会自动派任务，也不会创建自动化。
// 3. 自动化的真身是宿主 `ctx.schedule`；本表只存镜像 + 授权审计，读不到宿主时如实降级。
// ---------------------------------------------------------------------------

/** 组 backfill 只跑一次（幂等标记）；之后新建的组由列表读时并集补上，不靠写时维护。 */
export const GROUPS_BACKFILLED_KEY = 'groups_backfilled_at'

const groupOf = row => row === undefined ? undefined : ({
  id: row.id,
  name: typeof row.name === 'string' && row.name !== '' ? row.name : row.id,
  goal: row.goal ?? null,
  color: row.color ?? null,
  archived: row.archived === 1 || row.archived === true,
  created_at: Number.isFinite(row.created_at) ? row.created_at : 0,
  updated_at: Number.isFinite(row.updated_at) ? row.updated_at : 0,
})

/**
 * 把存量 `tasks.group_id` 补成组元数据行（`name` 默认等于 id）。
 * 幂等：`INSERT OR IGNORE` + 一次性 settings 标记；重复调用不会覆盖用户改过的名字。
 * @returns {{created: number}}
 */
export function backfillGroups(db, now = Date.now()) {
  if (typeof getSetting(db, GROUPS_BACKFILLED_KEY) === 'string' && getSetting(db, GROUPS_BACKFILLED_KEY) !== '') {
    return { created: 0 }
  }
  const rows = db.prepare("SELECT DISTINCT group_id FROM tasks WHERE group_id IS NOT NULL AND group_id <> ''").all()
  // 没有任何组时不写标记：保持「仅仅打开台账不写 settings」这条既有不变量（test/index.test.js 锁着）。
  if (rows.length === 0) return { created: 0 }
  const insert = db.prepare('INSERT OR IGNORE INTO groups_v1 (id, name, goal, color, archived, created_at, updated_at) VALUES (?, ?, NULL, NULL, 0, ?, ?)')
  let created = 0
  for (const row of rows) {
    const result = insert.run(String(row.group_id), String(row.group_id), now, now)
    created += Number(result.changes) > 0 ? 1 : 0
  }
  setSetting(db, GROUPS_BACKFILLED_KEY, String(now))
  return { created }
}

export function listGroupMeta(db) {
  return db.prepare('SELECT * FROM groups_v1 ORDER BY archived ASC, updated_at DESC, id ASC').all().map(groupOf)
}

export function getGroupMeta(db, id) {
  return groupOf(db.prepare('SELECT * FROM groups_v1 WHERE id = ?').get(String(id)))
}

/** 已有的组键（含没有元数据行的「虚拟组」）：组列表与校验都用它，避免两套口径。 */
export function listGroupKeys(db) {
  const rows = db.prepare("SELECT DISTINCT group_id FROM tasks WHERE group_id IS NOT NULL AND group_id <> ''").all()
  return rows.map(row => String(row.group_id))
}

/** 组内按状态计数：`Map<groupId, {active, delivered, done, failed, cancelled, orphaned, missing, total}>`。 */
export function groupStatusCounts(db) {
  const rows = db.prepare('SELECT group_id, status, COUNT(*) AS n FROM tasks WHERE group_id IS NOT NULL AND group_id <> \'\' GROUP BY group_id, status').all()
  const out = new Map()
  for (const row of rows) {
    const key = String(row.group_id)
    const entry = out.get(key) ?? { total: 0 }
    const n = Number(row.n) || 0
    entry[String(row.status)] = n
    entry.total += n
    out.set(key, entry)
  }
  return out
}

/** 组元数据 upsert（新建虚拟组的元数据 / 改名 / 改目标或颜色）。 */
export function upsertGroupMeta(db, { id, name, goal = null, color = null, now = Date.now() } = {}) {
  db.prepare(`INSERT INTO groups_v1 (id, name, goal, color, archived, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, goal = excluded.goal, color = excluded.color, updated_at = excluded.updated_at`)
    .run(String(id), String(name), goal ?? null, color ?? null, now, now)
  return getGroupMeta(db, id)
}

export function setGroupArchived(db, id, archived, now = Date.now()) {
  const result = db.prepare('UPDATE groups_v1 SET archived = ?, updated_at = ? WHERE id = ?')
    .run(archived === true ? 1 : 0, now, String(id))
  return Number(result.changes) > 0 ? getGroupMeta(db, id) : undefined
}

/** L1 计划日。不动状态机、不唤醒队列：排期是「人看的计划」，不是派发信号。 */
export function setTaskPlannedAt(db, id, plannedAt, now = Date.now()) {
  const value = Number.isFinite(plannedAt) && plannedAt > 0 ? Math.trunc(plannedAt) : null
  const result = db.prepare('UPDATE tasks SET planned_at = ?, updated_at = ? WHERE id = ?').run(value, now, String(id))
  return Number(result.changes) > 0 ? getTask(db, id) : undefined
}

const parseTiming = value => {
  if (value === null || value === undefined) return null
  try {
    const parsed = JSON.parse(value)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

const automationOf = row => row === undefined ? undefined : ({
  id: row.id,
  kind: row.kind,
  ref_id: row.ref_id ?? null,
  title: row.title,
  prompt: row.prompt,
  timing: parseTiming(row.timing_json),
  schedule_id: row.schedule_id ?? null,
  target_session: row.target_session ?? null,
  active: row.active === 1 || row.active === true,
  authorized_by: typeof row.authorized_by === 'string' && row.authorized_by !== '' ? row.authorized_by : 'user',
  authorized_at: Number.isFinite(row.authorized_at) ? row.authorized_at : null,
  expected_updated_at: row.expected_updated_at ?? null,
  last_fired_at: Number.isFinite(row.last_fired_at) ? row.last_fired_at : null,
  last_result: row.last_result ?? null,
  deleted_at: Number.isFinite(row.deleted_at) ? row.deleted_at : null,
  created_at: row.created_at,
  updated_at: row.updated_at,
})

export function listAutomations(db, { includeDeleted = false } = {}) {
  const sql = includeDeleted
    ? 'SELECT * FROM automations ORDER BY created_at DESC, id DESC'
    : 'SELECT * FROM automations WHERE deleted_at IS NULL ORDER BY created_at DESC, id DESC'
  return db.prepare(sql).all().map(automationOf)
}

export function getAutomation(db, id) {
  return automationOf(db.prepare('SELECT * FROM automations WHERE id = ?').get(String(id)))
}

export function insertAutomation(db, {
  id, kind, refId = null, title, prompt, timing, scheduleId = null, targetSession = null,
  authorizedBy = 'user', expectedUpdatedAt = null, now = Date.now(),
} = {}) {
  db.prepare(`INSERT INTO automations
    (id, kind, ref_id, title, prompt, timing_json, schedule_id, target_session, active,
     authorized_by, authorized_at, expected_updated_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`)
    .run(String(id), String(kind), refId ?? null, String(title), String(prompt), JSON.stringify(timing ?? null),
      scheduleId ?? null, targetSession ?? null, String(authorizedBy), now, expectedUpdatedAt ?? null, now, now)
  return getAutomation(db, id)
}

/** 镜像更新：只允许白名单字段（真身的暂停/删除由宿主 schedule 负责）。 */
export function updateAutomationRow(db, id, patch = {}, now = Date.now()) {
  const sets = []
  const values = []
  const push = (column, value) => { sets.push(`${column} = ?`); values.push(value) }
  if (typeof patch.title === 'string') push('title', patch.title)
  if (typeof patch.prompt === 'string') push('prompt', patch.prompt)
  if (patch.timing !== undefined) push('timing_json', JSON.stringify(patch.timing))
  if (patch.scheduleId !== undefined) push('schedule_id', patch.scheduleId ?? null)
  if (patch.targetSession !== undefined) push('target_session', patch.targetSession ?? null)
  if (patch.active !== undefined) push('active', patch.active === true ? 1 : 0)
  if (patch.expectedUpdatedAt !== undefined) push('expected_updated_at', patch.expectedUpdatedAt ?? null)
  if (patch.lastFiredAt !== undefined) push('last_fired_at', patch.lastFiredAt ?? null)
  if (patch.lastResult !== undefined) push('last_result', patch.lastResult ?? null)
  if (patch.deletedAt !== undefined) push('deleted_at', patch.deletedAt ?? null)
  if (sets.length === 0) return getAutomation(db, id)
  push('updated_at', now)
  values.push(String(id))
  db.prepare(`UPDATE automations SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  return getAutomation(db, id)
}
