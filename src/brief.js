// brief 是内部结构化数据；发给子会话的永远是 renderBrief 渲染出的文字。
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'

const text = value => typeof value === 'string' ? value.trim() : ''
const single = value => text(value).replace(/[\r\n]+/g, ' ')
const list = value => Array.isArray(value) ? value.map(text).filter(Boolean) : []

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

export function renderBrief(brief = {}) {
  const lines = [`【任务】${single(brief.title)}`, `【目标】${single(brief.goal)}`]
  const target = text(brief.target)
  // brief 里最多只出现一个目录：就是 target_dir；不要把指挥舱/父会话目录也写进来，否则模型容易被带偏。
  if (target !== '') {
    lines.splice(2, 0, `【工作目录】${single(target)}`)
    // 正向提示（不是硬约束）：worker 不强制 chdir，danger-full-access 下越界绝对路径写得出去。
    lines.splice(3, 0, '所有产出只写到该目录内，不要写到父会话目录或其他绝对路径；完成后汇报时把文件路径落到该目录下。')
  }
  const constraints = list(brief.constraints)
  if (constraints.length > 0) lines.push(`【约束】${constraints.map(item => `- ${single(item)}`).join('；')}`)
  lines.push(`【验收标准】\n${list(brief.acceptance).map(item => `- ${single(item)}`).join('\n')}`)
  const refs = list(brief.refs)
  if (refs.length > 0) lines.push(`【背景资料】${refs.map(item => `- ${single(item)}`).join('；')}`)
  const verbatim = text(brief.user_verbatim)
  if (verbatim !== '') {
    const quoted = verbatim.split(/\r?\n/).map(line => `> ${line.trim()}`).join('\n')
    lines.push(`【用户原话】\n${quoted}`)
  }
  lines.push('完成后请汇报：改了什么、改了哪些文件、怎么验证的。')
  return lines.join('\n')
}
