// 子任务计划模式（P8）：planFirst 任务「只读沙箱 + plan-mode 提示」起步，批准后切回可写。
//
// 职责切分（与 docs/ARCHITECTURE.md「计划阶段」一致）：
// - 进入/退出运行期状态（sandbox/mode、planMode.set、exit_plan_mode guard）在 src/dispatch.js；
// - 台账只存编排视图：plan_first（是否计划任务）+ plan_state（none/planning/approved/rejected）；
// - 本模块只放纯映射与一次「批准后恢复执行」的编排函数，tools.js / panel-actions.js 共用，避免两处口径。
import { setPlanState } from './ledger.js'
// P1-C 文案单源：计划阶段的原子句在 src/copy.js，这里只做本域的映射与一次「批准后恢复执行」。
import { EXIT_PLAN_MODE_DENIAL, PLAN_FIRST_DETAIL, PLAN_PHASE_LINES, PLAN_STATUS_LINES } from './copy.js'

export { EXIT_PLAN_MODE_DENIAL, PLAN_FIRST_DETAIL, PLAN_PHASE_LINES, PLAN_STATUS_LINES }

/** 台账 plan_state 的合法值（与 docs/ARCHITECTURE.md 的表一致）。 */
export const PLAN_STATES = Object.freeze(['none', 'planning', 'approved', 'rejected'])

/** 面板 / `task_status` 用的计划状态文案。 */
export const PLAN_STATE_LABEL = {
  none: '无计划状态',
  planning: '计划中（等批准）',
  approved: '已批准执行',
  rejected: '计划未通过',
}

/** 列表行「计划中」小标（只在真的等批准时出现；已批准/已结束不加）。 */
export const PLAN_LIST_MARKER = '计划中'

/** 是否计划任务（台账列优先，兼容旧 brief 快照）。 */
export const isPlanTask = task => task?.plan_first === true || task?.brief?.planFirst === true

/** 台账 plan_state 归一：坏值/旧行按 none。 */
export const planStateOf = task => {
  const state = task?.plan_state
  return PLAN_STATES.includes(state) ? state : 'none'
}

/** `task_list` 行尾标记：只有 `planning` 加「·计划中」，其它状态不加字样。 */
export function planListMarker(task) {
  return isPlanTask(task) && planStateOf(task) === 'planning' ? `·${PLAN_LIST_MARKER}` : ''
}

/** `task_status` 的计划状态行；非计划任务返回 undefined（调用方不追加）。 */
export function planStatusLine(task) {
  if (!isPlanTask(task)) return undefined
  return PLAN_STATUS_LINES[planStateOf(task)] ?? PLAN_STATUS_LINES.none
}

/**
 * 用户批准后恢复执行：投递成功且任务回到 `running` 之后调用。
 *
 * 顺序：先让派发层切沙箱（workspace-write）+ 关 plan mode（可能服务缺失 → 只降级，不抛），
 * 再把台账 `plan_state` 落 `approved`。台账更新不依赖运行期成功与否——「用户批准了」是事实，
 * 运行期失败通过返回值让调用方在工具结果里如实说明。
 *
 * @returns {Promise<{ok: boolean, reason?: string, planMode?: string|null, sandbox?: string}>}
 */
export async function approvePlan({ db, dispatcher, task, log = () => {} } = {}) {
  if (task === undefined || task === null) return { ok: false, reason: 'no-task' }
  if (!isPlanTask(task)) return { ok: false, reason: 'not-plan' }
  const target = task.target ?? task.session_id
  let result = { ok: false, reason: 'unsupported' }
  try {
    if (typeof dispatcher?.approvePlan === 'function') {
      result = await dispatcher.approvePlan(target, task.target_dir) ?? { ok: false, reason: 'no-result' }
    }
  } catch (error) {
    result = { ok: false, reason: error?.message ?? String(error) }
  }
  try {
    setPlanState(db, task.id, 'approved')
  } catch (error) {
    log('task.plan.state-failed', { taskId: task.id, detail: { error: error?.message ?? String(error) } })
  }
  log('task.plan.approved', {
    taskId: task.id,
    sessionId: target ?? null,
    detail: {
      ok: result?.ok === true,
      reason: result?.reason ?? null,
      planMode: result?.planMode ?? null,
      sandbox: result?.sandbox ?? null,
    },
  })
  return result
}

/** 工具结果里补一句「批准已生效 / 退出失败」，不让协调者以为切回可写一定成功。 */
export function approvalNote(result) {
  if (result?.ok === true) return `计划已批准：${result.sandbox === 'workspace-write' ? '沙箱已切回可写' : '已请求切回可写'}，子会话按计划继续执行。`
  const reason = result?.reason ?? '未知原因'
  return `计划已标记批准，但运行期切换失败：${reason}。子会话可能仍是只读；必要时 task_message({ action: 'stop' }) 后重派。`
}
