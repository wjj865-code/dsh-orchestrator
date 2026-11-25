// 续跑（resume）：收尾任务的原会话冷恢复。
//
// **判定、阈值、投递文案**必须同源——工具层（task_message action:'resume'）、面板（第二批）、提示词（L1
// 「复用优先」）都从这里取，避免「工具让续跑、面板不让」的分叉（0.19.x 的 followupGate 就分叉过）。
// 与 retry 分工：resume = 同 task_id + 同子会话冷恢复（失败/重启/额度中断的默认出口）；retry = 新任务 +
// 新子会话（污染、换检出/权限、不可达时用）。平台依据：本地子级 durable，sendMessage 可冷恢复
// （docs/probes/subagent-probe.md §3），可写根/沙箱由 dispatch.send 幂等补。
import { CLOSE_REASONS } from './delivered.js'
import { canTransition, hasCap } from './status-facts.js'
import { statusLabel } from './state.js'

/**
 * 历史消息阈值：超过它**建议** retry（新会话），但不拦截。冷恢复要重放整段会话历史，长会话比新开更贵；
 * 实测 287 条任务里 99% 总消息数 < 20，> 60 基本是长跑任务。为什么软阈值：硬拦会把「额度中断的长任务」
 * 正好挡在最需要续跑的那一类之外，反而逼出新派。
 */
export const RESUME_HISTORY_THRESHOLD = 60

/** 能不能续跑（纯函数，不碰台账）：状态能力 + done 行级白名单 + 会话/检出可用性 + 阈值提示。 */
export function resumeGate(task, { history = 0 } = {}) {
  if (task === undefined || task === null) return { ok: false, reason: 'not_found' }
  if (task.delivery_pending) return { ok: false, reason: 'collecting' }
  const status = String(task.status ?? '')
  // 状态级判据一律查能力表（failed / orphaned / done），别在这里再写一份状态集合。
  if (hasCap(status, 'resume') !== true || canTransition(status, 'running') !== true) return { ok: false, reason: 'state' }
  // done 的行级白名单：只有「没有经过人确认就被自动收走」的交付能续跑；
  // - `timeout`：交付超时自动完成；
  // - `chain`：链式自动放行（`chain:'auto'` 交付时仍有下游在等 → 自动确认完成）——同样没人确认过内容。
  // 确认过的完成（coordinator / panel）与取消不改写。写域由 `write-gate.decideRegrant` 兜底：
  // 自动放行后下游可能已经在跑，此时续跑会被判「目录被占」而拒绝。
  if (status === 'done' && ![CLOSE_REASONS.timeout, CLOSE_REASONS.chain].includes(task.close_reason)) return { ok: false, reason: 'closed' }
  if (task.target === null || task.target === undefined || task.target === '') return { ok: false, reason: 'no_session' }
  // 检出已清理：原会话的 cwd 目录没了，冷恢复也写不进去（retry 会按原基线重建）。
  if (task.worktree_state === 'cleaned') return { ok: false, reason: 'checkout_cleaned' }
  const count = Number.isFinite(history) ? history : 0
  return { ok: true, reason: null, history: count, warn: count > RESUME_HISTORY_THRESHOLD ? 'history_too_long' : null }
}

/**
 * 续跑投递文案（L2 brief 层第二批收口，这里先由工具层直接发）：只讲「接着做什么、别重做、跑偏就上报」，
 * 不复述任务详情（详情在 task_detail，原文在会话历史里）。
 */
export function resumePrompt(task, { history = 0, message = '' } = {}) {
  // 版本 B：续跑文案里写**任务引用**（tk-），不写台账内部编号（模型会把它抄进给用户的回复）。
  const ref = typeof task?.ref === 'string' && task.ref !== '' ? `（${task.ref}）` : ''
  const lines = [
    `【续跑】任务「${task?.title ?? ''}」${ref}。上一轮以「${statusLabel(task?.status)}」收尾，`
      + '这个子会话已冷恢复，接着这条任务继续——**不要重做已经完成的部分**。',
    task?.last_stop_reason == null ? null : `- 上次结束原因：${task.last_stop_reason}`,
    '- 先核对现状再动手：产物/改动还在不在（git status、目标文件）、上次做到哪一步（必要时调 task_detail）。',
    `- 已有 ${Number.isFinite(history) ? history : 0} 条历史消息；如果上下文已跑偏、或结论已被推翻，不要在旧结论上硬续：`
      + '直接 task_report blocked 说明「需要新会话重派」。',
    '- 完成后照旧 task_report（done / blocked / needs_auth），summary 写清这一轮做了什么。',
  ]
  const note = String(message ?? '').trim()
  if (note !== '') lines.push(`- 本次指示：${note}`)
  return lines.filter(line => line !== null).join('\n')
}
