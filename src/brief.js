// brief 是内部结构化数据；发给子会话的永远是 renderBrief 渲染出的文字。
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'

const text = value => typeof value === 'string' ? value.trim() : ''
const single = value => text(value).replace(/[\r\n]+/g, ' ')
const list = value => Array.isArray(value) ? value.map(text).filter(Boolean) : []

// T1 brief 纯指引化：任务创建详情（目标全文/验收/约束/背景/经验/依赖/产物）全在台账里，
// 由子会话用 task_detail 现取；brief 只留任务编号 + 一句指引，不再内联目标正文、经验摘要或
// 「get_goal 不可用」的兜底文本——这样提示词长度不随目标/记忆增长，详情也永远是最新台账。
export const DETAIL_POINTER_TEXT = '先调 task_detail（参数 task_id 填上面的任务编号）读取完整任务详情：'
  + '目标全文、验收标准、约束、背景资料、用户原话、工作目录与权限、前置任务、经验文件、已有产物。'
  + '本行只是指引，不要凭它猜任务内容。'

/** 返回错误列表；空数组表示合法。 */
export function validateBrief(brief = {}) {
  const errors = []
  if (text(brief.title) === '') errors.push('title 必填')
  if (text(brief.goal) === '') errors.push('goal 必填')
  if (list(brief.acceptance).length === 0) errors.push('acceptance 至少一条')
  return errors
}

/** 目标目录：可选；给了就必须是存在的绝对目录。返回可读错误或 undefined。 */
export function validateTargetDir(target, { isDirectory = value => statSync(value).isDirectory() } = {}) {
  const value = text(target)
  if (value === '') return undefined
  if (!isAbsolute(value)) return 'target 必须是绝对路径'
  let ok = false
  try { ok = isDirectory(value) } catch { ok = false }
  return ok ? undefined : 'target 目录不存在或不是目录'
}

/**
 * 渲染派发给子会话的 brief（T1：纯指引）。
 *
 * 只输出【任务编号】+【任务详情】两行：brief 正文不再携带任何创建详情（目标/验收/经验/兜底都不进），
 * 子会话拿到任务编号后调 task_detail 读台账里的完整快照。
 *
 * @param {{ taskId?: string }} [options] taskId 是台账任务编号（如 t-1a2b3c4d），也是 task_detail 的参数。
 */
export function renderBrief({ taskId } = {}) {
  const id = single(taskId)
  const lines = []
  if (id !== '') lines.push(`【任务编号】${id}`)
  lines.push(`【任务详情】${DETAIL_POINTER_TEXT}`)
  return lines.join('\n')
}
