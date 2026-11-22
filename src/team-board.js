// P2-4（D6）：官方 Team 任务板**只读**互通 + 确认交付时的可选反写（CAS）。
//
// 边界（计划 §6 已拍板：D6 优先、**不做 workspace 第二后端**）：
//   1) 只读：只调 `agentTeams.isEnabled` / `listTasks`（面板/详情/任务状态用），**不接管**官方 Team 的
//      派发、认领、生命周期；官方板上的任务在本插件里没有可操作按钮，也不新增 root 会话派发路径；
//   2) 反写只有一种动作：插件任务被确认交付（`closeDelivered` 成功）时，把它**显式关联**的官方任务
//      `updateTask({ action:'complete' })` 掉，且必须带 `expectedRevision`（CAS）——没关联就什么都不做；
//   3) 全程 fail-soft：服务缺失 / Team 未开启 / 冲突都只降级 + 记日志，**绝不抛给调用方**、绝不回滚本地交付；
//   4) 冲突不重试轰炸：`TEAM_TASK_STALE_REVISION` 只重读一次、再试一次，仍冲突就停手并记 `team.board.stale`。
//
// 为什么单独一个模块：只读投影、关联校验、CAS 反写三件事必须同源。`host-route` 的 snapshot、
// `panel-actions` 的抽屉、`task_status` 与 `delivered.closeDelivered` 全部吃这里的函数，不各写一套字段。
//
// 宿主契约（rc.5 `@deepseek-ai/dsh-agent-team`，2026-11-19 静态核实）：
//   - `isEnabled(caller)` → boolean（Team 模式是否开在 caller 的 subagent 树根上）；
//   - `listTasks(caller)` → `TeamTaskView[]`（`{ id, revision, subject, status, ownerId?, ownerName?, blockedBy, writeScopes, ready, writeScopeWarnings }`）；
//   - `updateTask(caller, { taskId, expectedRevision, action }, signal)` → 新视图；revision 不符抛 `TEAM_TASK_STALE_REVISION`。
// 这些是 rc 级私有契约：全部走 `host-capabilities` 惰性访问，形状变了就整段降级，不「模拟成功」。

/** 只读快照一次最多下发多少行（官方板本身有 maxTasks=256；面板一屏用不完，别把快照撑大）。 */
export const TEAM_BOARD_MAX_ROWS = 100

/** 反写结果里「不算错误、也不需要打扰用户」的降级码（只记日志）。 */
export const TEAM_BOARD_UNAVAILABLE = 'TEAM_BOARD_UNAVAILABLE'
export const TEAM_BOARD_DISABLED = 'TEAM_BOARD_DISABLED'
/** 官方 CAS 冲突码（宿主 `TeamError.code`）：只重读一次，仍冲突就记 `team.board.stale` 后停手。 */
export const TEAM_BOARD_STALE = 'TEAM_TASK_STALE_REVISION'
export const TEAM_BOARD_NOT_FOUND = 'TEAM_TASK_NOT_FOUND'
export const TEAM_BOARD_INVALID_STATE = 'TEAM_TASK_INVALID_TRANSITION'
export const TEAM_BOARD_UNLINKED = 'TEAM_BOARD_UNLINKED'

/** 官方任务状态 → 中文（只用于显示；插件不改官方状态）。 */
export const BOARD_STATUS_LABEL = Object.freeze({
  pending: '待认领',
  in_progress: '进行中',
  completed: '已完成',
  deleted: '已删除',
})

export const boardStatusLabel = status =>
  typeof status === 'string' && Object.hasOwn(BOARD_STATUS_LABEL, status) ? BOARD_STATUS_LABEL[status] : (typeof status === 'string' && status !== '' ? status : '未知')

const messageOf = error => {
  if (error === null || error === undefined) return '未知错误'
  const message = typeof error.message === 'string' && error.message !== '' ? error.message : String(error)
  return message.length > 300 ? `${message.slice(0, 300)}…` : message
}

const errorCodeOf = error => typeof error?.code === 'string' && error.code !== '' ? error.code : undefined

/** 台账列 revision 归一：只认非负整数；旧库/手工改库的怪值按「不知道」处理（宁可拒绝 CAS，也不猜）。 */
export const normalizeRevision = value => Number.isSafeInteger(value) && value >= 0 ? value : null

/** 只读可用性：只要有 `isEnabled` + `listTasks` 就算可读（反写另外要求 `updateTask`）。 */
export function teamBoardAvailable(service) {
  return service !== null && service !== undefined
    && typeof service.isEnabled === 'function'
    && typeof service.listTasks === 'function'
}

const unavailableOf = service => {
  if (service === null || service === undefined) {
    return { code: TEAM_BOARD_UNAVAILABLE, message: '宿主没有 agentTeams 服务（未安装 Agent Teams）' }
  }
  if (!teamBoardAvailable(service)) {
    return { code: TEAM_BOARD_UNAVAILABLE, message: 'agentTeams 服务缺少 isEnabled/listTasks（宿主形状可能已变）' }
  }
  return undefined
}

/** 一行只读投影（**不含 description**：官方允许 16 KiB 正文，快照每帧都下发会把它撑大）。 */
export function boardRowOf(task = {}) {
  const owner = typeof task.ownerName === 'string' && task.ownerName !== ''
    ? task.ownerName
    : (typeof task.ownerId === 'string' && task.ownerId !== '' ? task.ownerId : null)
  const status = typeof task.status === 'string' && task.status !== '' ? task.status : 'pending'
  return {
    id: typeof task.id === 'string' ? task.id : '',
    revision: Number.isSafeInteger(task.revision) ? task.revision : 0,
    subject: typeof task.subject === 'string' ? task.subject : '',
    status,
    statusLabel: boardStatusLabel(status),
    owner,
    blockedBy: Array.isArray(task.blockedBy) ? task.blockedBy.filter(id => typeof id === 'string' && id !== '') : [],
    writeScopes: Array.isArray(task.writeScopes) ? task.writeScopes.filter(scope => typeof scope === 'string' && scope !== '') : [],
    ready: task.ready === true,
  }
}

/**
 * 只读快照。**永不抛**：服务缺失 / isEnabled 抛错 / listTasks 抛错都降级成
 * `{ enabled:false, rows:[], degraded:{code,message} }`；Team 未开启时 `degraded:null`（那是正常状态，不是故障）。
 *
 * 关键约定：`enabled !== true` 时**不调用** `listTasks`（官方在未开启时会抛 TEAM_DISABLED，我们不必去撞）。
 *
 * @param {{agentTeams?: object, agent?: object, limit?: number}} [options]
 * @returns {{enabled: boolean, rows: object[], degraded: null | {code: string, message: string}}}
 */
export function readTeamBoard({ agentTeams, agent, limit = TEAM_BOARD_MAX_ROWS } = {}) {
  const unavailable = unavailableOf(agentTeams)
  if (unavailable !== undefined) return { enabled: false, rows: [], degraded: unavailable }
  if (agent === null || agent === undefined) {
    return { enabled: false, rows: [], degraded: { code: TEAM_BOARD_UNAVAILABLE, message: '协调者会话未加载，读不到官方 Team 板' } }
  }
  let enabled
  try {
    enabled = agentTeams.isEnabled(agent) === true
  } catch (error) {
    return { enabled: false, rows: [], degraded: { code: TEAM_BOARD_UNAVAILABLE, message: `读官方 Team 状态失败：${messageOf(error)}` } }
  }
  if (!enabled) return { enabled: false, rows: [], degraded: null }
  let tasks
  try {
    tasks = agentTeams.listTasks(agent)
  } catch (error) {
    return { enabled: true, rows: [], degraded: { code: 'TEAM_BOARD_READ_FAILED', message: `读官方 Team 板失败：${messageOf(error)}` } }
  }
  const max = Number.isSafeInteger(limit) ? Math.max(1, Math.min(500, limit)) : TEAM_BOARD_MAX_ROWS
  const rows = (Array.isArray(tasks) ? tasks : []).slice(0, max).map(boardRowOf).filter(row => row.id !== '')
  return { enabled: true, rows, degraded: null }
}

/**
 * `task_create.teamTaskId` 的校验（只读）：官方板能读、Team 已开启、任务存在且还没完成。
 * 返回 `{ ok:true, task:{ id, revision, status, subject }, note }` 或 `{ ok:false, code, reason }`。
 *
 * 注意：这里**只读**——关联只写进我们自己的台账（`team_task_id` / `team_task_revision`），
 * 不去 claim / 改官方任务；官方任务仍由官方 Team 的成员按它自己的节奏推进。
 */
export function linkBoardTask({ agentTeams, agent, teamTaskId } = {}) {
  const id = typeof teamTaskId === 'string' ? teamTaskId.trim() : ''
  if (id === '') return { ok: false, code: 'TEAM_TASK_ID_REQUIRED', reason: 'teamTaskId 不能为空' }
  // 关联校验要能在「一大堆积压任务」里找到目标：官方板上限 256，直接按 500 读全，别用快照的 100 行截断。
  const board = readTeamBoard({ agentTeams, agent, limit: 500 })
  if (board.degraded !== null) return { ok: false, code: board.degraded.code, reason: board.degraded.message }
  if (board.enabled !== true) {
    return { ok: false, code: TEAM_BOARD_DISABLED, reason: '官方 Team 模式未开启（Team 板不可用）' }
  }
  const row = board.rows.find(item => item.id === id)
  if (row === undefined) {
    const known = board.rows.slice(0, 10).map(item => item.id).join('、')
    return {
      ok: false,
      code: TEAM_BOARD_NOT_FOUND,
      reason: `官方板上没有任务「${id}」${known === '' ? '（板是空的）' : `；现有：${known}`}`,
    }
  }
  if (row.status === 'completed') {
    return {
      ok: false,
      code: TEAM_BOARD_INVALID_STATE,
      reason: `官方任务「${id}」已经是「${boardStatusLabel(row.status)}」，不需要再关联确认反写；换一个进行中的任务`,
    }
  }
  return {
    ok: true,
    task: { id: row.id, revision: row.revision, status: row.status, subject: row.subject },
    // 官方语义：只有 in_progress 能被 complete；pending 先关联也行，但确认时会失败——提前说清，别让人以为一定成功。
    note: row.status === 'in_progress' ? '' : '该官方任务当前不是「进行中」，确认交付时反写会被官方拒绝（需要先由官方成员认领）。',
  }
}

const rereadBoardRow = (agentTeams, agent, taskId) => {
  try {
    const tasks = agentTeams.listTasks(agent)
    return (Array.isArray(tasks) ? tasks : []).find(item => item?.id === taskId) ?? null
  } catch {
    return null
  }
}

/**
 * 确认反写（CAS）：把关联的官方任务标 `complete`，`expectedRevision` 必须是创建时读到的 revision。
 *
 * 冲突处理（**不重试轰炸**）：
 *   1) `TEAM_TASK_STALE_REVISION` → 只重读一次（`listTasks`），拿到新 revision 再试**一次**；
 *   2) 仍冲突 / 重读不到 / 仍是同一个 revision → 放弃，返回 `{ ok:false, code:'TEAM_TASK_STALE_REVISION' }`，
 *      调用方记 `team.board.stale` 并如实告诉用户「官方板没改成」。
 *
 * 未关联、服务缺失、Team 未开启都返回 `skipped:true`（旁路不打扰用户）；其它官方错误（比如没在 in_progress）
 * 返回 `ok:false` + `warn:true`，由调用方 warn 一次。
 *
 * @returns {Promise<{ok: boolean, skipped?: boolean, warn?: boolean, code: string, reason?: string, taskId?: string, revision?: number|null}>}
 */
export async function confirmOnBoard({ agentTeams, agent, task } = {}) {
  const taskId = typeof task?.team_task_id === 'string' ? task.team_task_id : ''
  if (taskId === '') {
    return { ok: false, skipped: true, code: TEAM_BOARD_UNLINKED, reason: '任务没有关联官方 Team 板任务' }
  }
  const unavailable = unavailableOf(agentTeams)
  if (unavailable !== undefined) {
    return { ok: false, skipped: true, code: unavailable.code, reason: unavailable.message }
  }
  if (typeof agentTeams.updateTask !== 'function') {
    return { ok: false, skipped: true, code: TEAM_BOARD_UNAVAILABLE, reason: 'agentTeams 服务缺少 updateTask（宿主形状可能已变）' }
  }
  if (agent === null || agent === undefined) {
    return { ok: false, skipped: true, code: TEAM_BOARD_UNAVAILABLE, reason: '协调者会话未加载，无法反写官方 Team 板' }
  }
  let enabled
  try {
    enabled = agentTeams.isEnabled(agent) === true
  } catch (error) {
    return { ok: false, skipped: true, code: TEAM_BOARD_UNAVAILABLE, reason: `读官方 Team 状态失败：${messageOf(error)}` }
  }
  if (!enabled) return { ok: false, skipped: true, code: TEAM_BOARD_DISABLED, reason: '官方 Team 模式已关闭，未反写' }
  const expected = normalizeRevision(task.team_task_revision)
  if (expected === null) {
    return { ok: false, warn: true, code: 'TEAM_TASK_REVISION_UNKNOWN', reason: `台账没有记录官方任务「${taskId}」的 revision，无法做 CAS（重新关联后再试）` }
  }
  const complete = revision => agentTeams.updateTask(agent, { taskId, expectedRevision: revision, action: 'complete' })
  try {
    const next = await complete(expected)
    return { ok: true, taskId, revision: normalizeRevision(next?.revision) ?? expected + 1, fromRevision: expected, reRead: false }
  } catch (error) {
    if (errorCodeOf(error) !== TEAM_BOARD_STALE) {
      return { ok: false, warn: true, code: errorCodeOf(error) ?? 'TEAM_BOARD_UPDATE_FAILED', reason: `反写官方任务「${taskId}」失败：${messageOf(error)}` }
    }
  }
  // 冲突：只重读一次、只再试一次。
  const row = rereadBoardRow(agentTeams, agent, taskId)
  const latest = row === null ? null : normalizeRevision(row.revision)
  if (latest === null) {
    return { ok: false, warn: true, code: TEAM_BOARD_STALE, reason: `官方任务「${taskId}」revision 已变化（台账 ${expected}），重读不到新值；已放弃反写` }
  }
  if (latest === expected) {
    return { ok: false, warn: true, code: TEAM_BOARD_STALE, reason: `官方任务「${taskId}」CAS 冲突但重读仍是 revision ${expected}（可能有并发写入）；已放弃反写` }
  }
  try {
    const next = await complete(latest)
    return { ok: true, taskId, revision: normalizeRevision(next?.revision) ?? latest + 1, fromRevision: latest, reRead: true }
  } catch (error) {
    return {
      ok: false,
      warn: true,
      stale: errorCodeOf(error) === TEAM_BOARD_STALE,
      code: errorCodeOf(error) ?? 'TEAM_BOARD_UPDATE_FAILED',
      reason: `官方任务「${taskId}」重读后仍未能反写：${messageOf(error)}；已停手，不会继续重试`,
    }
  }
}

/**
 * 面板抽屉 / 详情用的关联视图：本地台账记的关联 + 官方板**当前**行（读不到就只给台账那一半）。
 * 没关联返回 null（面板据此不渲染这一块）。
 */
export function teamLinkView({ agentTeams, agent, task } = {}) {
  const id = typeof task?.team_task_id === 'string' ? task.team_task_id : ''
  if (id === '') return null
  const board = readTeamBoard({ agentTeams, agent, limit: 500 })
  return {
    id,
    revision: normalizeRevision(task.team_task_revision),
    enabled: board.enabled,
    row: board.rows.find(item => item.id === id) ?? null,
    degraded: board.degraded,
  }
}

/** `task_status` 的一行（没关联返回空字符串）：让人不用开面板就知道确认时会反写谁。 */
export function teamLinkStatusLine(task) {
  const id = typeof task?.team_task_id === 'string' ? task.team_task_id : ''
  if (id === '') return ''
  const revision = normalizeRevision(task.team_task_revision)
  return `官方 Team 任务：${id}（创建时 revision ${revision ?? '未知'}；确认交付时按 CAS 反写完成，冲突只提示）`
}

/**
 * 哪些确认人**不**反写官方板（用户 2026-11-23 拍板）：
 *   - `timeout`（超时自动完成）；
 *   - `chain`（链式自动放行：`task_create.chain:'auto'` 交付时仍有下游在等 → 插件代确认）。
 * 两者都不是「人的确认」，官方板上不该被这类自动动作改状态；只记一条 `team.board.skipped` 留痕。
 * 这是纯函数：index.js 的 sink 与测试都调它，避免在装配层再写一份 `if`。
 */
const CONFIRM_SKIP_BY = Object.freeze(['timeout', 'chain'])

export function shouldReverseConfirm(acceptedBy) {
  return !CONFIRM_SKIP_BY.includes(typeof acceptedBy === 'string' ? acceptedBy : '')
}

// 进程级 sink：与 `ledger.setTransitionObserver` / `handoff.setHandoffSink` 同一套做法——
// `closeDelivered` 有三个调用方（工具 / 面板 / 超时），在这里接一次就全覆盖，不会漏掉超时那条。
// 没接（测试 / 未装配）时是静默 no-op：反写是旁路，绝不能反过来影响交付。
let sink = null

/** 接上反写上报器（index.js 启动时调一次）。返回解绑函数（测试/卸载用）。
 *  sink 签名 `(task, context)`：`context.acceptedBy` = coordinator / panel / timeout / chain——
 *  不是「人的确认」的那两种（超时 / 链式自动放行）由 sink 按 `shouldReverseConfirm` 跳过、只记 skipped。 */
export function setTeamBoardSink(next) {
  const normalized = typeof next === 'function' ? next : null
  const previous = sink
  sink = normalized
  return () => { if (sink === normalized) sink = previous }
}

/** 任务被确认完成 → 尝试反写官方板。同步返回 sink 的返回值（通常是 Promise），**吞掉拒绝**：旁路不允许炸。 */
export const emitTeamBoardConfirm = (task, context = {}) => {
  if (sink === null) return null
  try {
    const result = sink(task, context)
    if (result !== null && result !== undefined && typeof result.then === 'function') result.then(undefined, () => {})
    return result ?? null
  } catch {
    return null
  }
}
