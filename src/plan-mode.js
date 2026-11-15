// 子任务计划模式（P8）：planFirst 任务「只读沙箱 + plan-mode 提示」起步，批准后切回可写。
//
// 职责切分（与 docs/ARCHITECTURE.md「计划阶段」一致）：
// - 进入/退出运行期状态（sandbox/mode、planMode.set、exit_plan_mode guard）在 src/dispatch.js；
// - 台账只存编排视图：plan_first（是否计划任务）+ plan_state（none/planning/approved/rejected）；
// - 本模块只放纯映射与一次「批准后恢复执行」的编排函数，tools.js / panel-actions.js 共用，避免两处口径。
import { setPlanState } from './ledger.js'

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

/**
 * 子会话在 task_detail 里看到的计划阶段说明。
 *
 * 计划模式在平台侧是**软引导**（只注入一段提示），真正拦写入的是只读沙箱；这段文案必须把
 * 「写被拒是预期行为」「计划唯一写入口是 plan_save」「出口是 task_report blocked，不是
 * exit_plan_mode」写清楚，否则模型会在计划阶段反复被沙箱拒绝、或把长计划硬塞进 500 字的
 * question 里被截断。
 */
export const PLAN_FIRST_DETAIL = [
  '【计划阶段】本任务以计划模式起步：沙箱 read-only（只读）——写文件/写 shell 会被拒绝，这是预期行为，不是权限故障。',
  '- 只读探索：读代码/文档、跑只读命令、验证假设；不要创建或修改文件。',
  '- 探索完先落盘计划：调 plan_save({ task_id, content }) 把计划正文（Markdown）写入主会话工作区的 reports/plans/<taskId>.md，插件自动登记为任务产物。'
    + '这是计划阶段**唯一**允许的写入口：路径固定、不接受自定义路径，也不要用 write/edit/pwsh 硬写。',
  '- 再用 task_report 报 blocked 上报：summary 只写 3–8 行摘要（做什么、改哪些文件、怎么验证）；'
    + 'question 写「计划文档绝对路径 + 待拍板问题清单」，不要把计划正文贴进 question（上限 500 字，会截断）。',
  '- options 可给「批准执行 / 调整计划」。',
  '- 不要调用 exit_plan_mode：编排子会话没有直接人类，批准会悬空（调用会被插件拒绝）。',
  '- 用户批准后协调者会 task_message 续派，插件把沙箱切回可写，再按计划执行。',
].join('\n')

/** 子会话被拒 `exit_plan_mode` 时的文案：给出正确出口（先落盘、再报摘要），不改任何状态。 */
export const EXIT_PLAN_MODE_DENIAL = 'exit_plan_mode 在编排子任务里不可用：子会话没有直接人类，批准会悬空。'
  + '计划阶段的出口是先在 plan_save 里把计划写进主会话工作区的 reports/plans/<taskId>.md，'
  + '再用 task_report({ status: "blocked", summary: "<3–8 行摘要>", question: "<计划文档绝对路径 + 待拍板问题清单>" }) 上报，'
  + '由协调者转交用户批准；批准后协调者用 task_message 续派，插件会把沙箱切回可写再执行。'

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
  const state = planStateOf(task)
  if (state === 'planning') return '计划：计划中｜子会话只读探索，计划用 plan_save 落盘到主会话工作区的 reports/plans/；用 task_message（或面板「追加」）批准后自动切回可写执行'
  if (state === 'approved') return '计划：已批准｜沙箱已切回可写，子会话按计划执行'
  if (state === 'rejected') return '计划：未批准｜计划阶段已结束（停止或结算时未获批准）'
  return '计划：无进行中的计划'
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
  return `计划已标记批准，但运行期切换失败：${reason}。子会话可能仍是只读；必要时 task_stop 后重派。`
}
