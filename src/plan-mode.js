// 子任务计划模式（P8）：planFirst 任务「只读沙箱 + plan-mode 提示」起步，**显式批准**后才切回可写。
//
// 职责切分（与 docs/ARCHITECTURE.md「计划阶段」一致）：
// - 进入/退出运行期状态（sandbox/mode、planMode.set、exit_plan_mode guard）在 src/dispatch.js；
// - 台账只存编排视图：plan_first（是否计划任务）+ plan_state（六值 = 四态 + none/rejected）；
// - 本模块放纯映射、批准前置判定与一次「批准后恢复执行」的编排函数，tools.js 复用，避免两处口径。
//
// P0-4（2026-11-23 用户拍板）：批准是**显式动作** `task_message({ action:'approve' })`。
// 普通 `message` 在计划任务上只记讨论/修订，不再触发这里的 approvePlan；前置三条见 planApproveGate。
import { setPlanState, setTaskAccepted } from './ledger.js'
// P1-C 文案单源：计划阶段的原子句在 src/copy.js，这里只做本域的映射与一次「批准后恢复执行」。
import { EXIT_PLAN_MODE_DENIAL, PLAN_FIRST_DETAIL, PLAN_PHASE_LINES, PLAN_STATUS_LINES } from './copy.js'

export { EXIT_PLAN_MODE_DENIAL, PLAN_FIRST_DETAIL, PLAN_PHASE_LINES, PLAN_STATUS_LINES }

/**
 * 台账 plan_state 的合法值（四态 + none/rejected，与 docs/ARCHITECTURE.md 的迁移表一致）。
 *
 * planning →（blocked）waiting_user →（调整）revising →（approve）approved；
 * 未批准就进终态 / delivered 的三个态统一收口成 rejected（见 ledger.nextPlanStateOnTransition）。
 */
export const PLAN_STATES = Object.freeze(['none', 'planning', 'waiting_user', 'revising', 'approved', 'rejected'])

/** 面板 / `task_status` / `task_detail` 用的计划状态文案（客户端 constants.js 必须同值）。 */
export const PLAN_STATE_LABEL = {
  none: '无计划状态',
  planning: '计划中（子会话只读探索）',
  waiting_user: '计划待拍板（已提交计划）',
  revising: '修订中（子会话只读改计划）',
  approved: '已批准执行',
  rejected: '计划未通过',
}

/** 列表行「计划中」小标（只在未批准的三态出现；已批准/已结束不加）。 */
export const PLAN_LIST_MARKER = '计划中'

/**
 * 批准前的三个态：运行期都还是只读（`task_detail` 权限、并行策略例外、消息回执都按它判断）。
 * 与 `PLAN_STATES` 分开导出：调用方要的是「还没批准」这个语义，不是状态全集。
 */
export const UNAPPROVED_PLAN_STATES = Object.freeze(['planning', 'waiting_user', 'revising'])

/** 每个未批准态在列表行尾的小标（`approved`/`rejected`/`none` 不加字样）。 */
const PLAN_LIST_MARKERS = Object.freeze({
  planning: `·${PLAN_LIST_MARKER}`,
  waiting_user: '·计划待批',
  revising: '·计划修订',
})

/** 是否计划任务（台账列优先，兼容旧 brief 快照）。 */
export const isPlanTask = task => task?.plan_first === true || task?.brief?.planFirst === true

/** 台账 plan_state 归一：坏值/旧行按 none。 */
export const planStateOf = task => {
  const state = task?.plan_state
  return PLAN_STATES.includes(state) ? state : 'none'
}

/** 计划是否还在「批准前」（planning / waiting_user / revising）：这几态的运行期沙箱都是只读。 */
export const planInPhase = task => isPlanTask(task) && UNAPPROVED_PLAN_STATES.includes(planStateOf(task))

/** `task_list` 行尾标记：只有未批准的三态加小标，其它状态不加字样。 */
export function planListMarker(task) {
  if (!isPlanTask(task)) return ''
  return PLAN_LIST_MARKERS[planStateOf(task)] ?? ''
}

/** `task_status` 的计划状态行；非计划任务返回 undefined（调用方不追加）。 */
export function planStatusLine(task) {
  if (!isPlanTask(task)) return undefined
  return PLAN_STATUS_LINES[planStateOf(task)] ?? PLAN_STATUS_LINES.none
}

/**
 * 显式批准的前置判定（纯函数，tools.js 与测试共用，拒绝时不动任何运行期/台账状态）。
 *
 * 三条前置（用户 2026-11-23 拍板；「存在 blocked 报告」用 `plan_state==='waiting_user'` 表达——
 * 这个值只由插件在收到 `task_report blocked` 时写入，是本插件自己的持久事实，不需要新增列）：
 *   1. `isPlanTask`；
 *   2. `plan_state === 'waiting_user'`（已完成探索、交回过计划，且此刻不在修订中）；
 *   3. `status === 'waiting_user'`（子会话空闲等你，避开「跑着的时候被批」）；
 *   4. `plan_path` 非空（计划文档已落盘）。
 * `plan_state === 'approved'` 走幂等成功（`already`），不重复写审计。
 *
 * @returns {{ok: boolean, already?: boolean, code?: string, planState?: string}}
 */
export function planApproveGate(task) {
  if (!isPlanTask(task)) return { ok: false, code: 'PLAN_APPROVE_NOT_PLAN' }
  const state = planStateOf(task)
  if (state === 'approved') return { ok: true, already: true, planState: state }
  if (state === 'planning') return { ok: false, code: 'PLAN_APPROVE_NO_BLOCKED', planState: state }
  if (state !== 'waiting_user') return { ok: false, code: 'PLAN_APPROVE_NOT_WAITING', planState: state }
  if (task?.status !== 'waiting_user') return { ok: false, code: 'PLAN_APPROVE_NOT_WAITING', planState: state }
  if (typeof task?.plan_path !== 'string' || task.plan_path === '') {
    return { ok: false, code: 'PLAN_APPROVE_NO_PLAN_PATH', planState: state }
  }
  return { ok: true, planState: state }
}

/**
 * 显式批准后恢复执行：切沙箱 + 关 plan mode + 台账 `plan_state='approved'` + 审批审计。
 *
 * 顺序：先让派发层切沙箱（workspace-write）+ 关 plan mode（可能服务缺失 → 只降级，不抛），
 * 再把台账 `plan_state` 落 `approved` 并写确认审计（复用 `accepted_by/accepted_at` + `accepted_kind='plan'`）。
 * 台账更新不依赖运行期成功与否——「用户批准了」是事实，运行期失败通过返回值让调用方如实说明。
 *
 * **不投递消息、不改 status**：批准 ≠ 续派；协调者下一步自己 `task_message` 让子会话按计划执行。
 *
 * @returns {Promise<{ok: boolean, already?: boolean, reason?: string, planMode?: string|null, sandbox?: string}>}
 */
export async function approvePlan({ db, dispatcher, task, log = () => {}, acceptedBy = 'coordinator', now = Date.now() } = {}) {
  if (task === undefined || task === null) return { ok: false, reason: 'no-task' }
  const gate = planApproveGate(task)
  if (gate.ok !== true) return { ok: false, reason: gate.code ?? 'not-approvable' }
  if (gate.already === true) return { ok: true, already: true, sandbox: null, planMode: null }
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
  try {
    // 审批审计：与交付确认共用 accepted_by/accepted_at，用 accepted_kind='plan' 区分。
    setTaskAccepted(db, task.id, { acceptedBy, kind: 'plan', acceptedAt: now })
  } catch (error) {
    log('task.plan.audit-failed', { taskId: task.id, detail: { error: error?.message ?? String(error) } })
  }
  log('task.plan.approved', {
    taskId: task.id,
    sessionId: target ?? null,
    detail: {
      ok: result?.ok === true,
      reason: result?.reason ?? null,
      planMode: result?.planMode ?? null,
      sandbox: result?.sandbox ?? null,
      // 审计三件套：谁批的、何时批的、批的是哪份计划（logs 是审批历史的真源）。
      acceptedBy,
      acceptedAt: now,
      planPath: task.plan_path ?? null,
    },
  })
  return result
}

/** 工具结果里补一句「批准已生效 / 退出失败 / 已经批过」，不让协调者以为切回可写一定成功。 */
export function approvalNote(result) {
  if (result?.already === true) {
    return '计划已经是「已批准执行」，无需重复批准；下一步用 task_message 续派实现。'
  }
  if (result?.ok === true) {
    return `计划已批准：${result.sandbox === 'workspace-write' ? '沙箱已切回可写' : '已请求切回可写'}；`
      + '下一步用 task_message 续派实现（子会话按计划继续执行）。'
  }
  const reason = result?.reason ?? '未知原因'
  return `计划未批准：${reason}。子会话仍是只读；先补前置（计划落盘 / blocked 报告），或 task_message({ action: 'stop' }) 后重派。`
}
