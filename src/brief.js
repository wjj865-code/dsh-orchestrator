// brief 是内部结构化数据；发给子会话的永远是 renderBrief 渲染出的文字。
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'

const text = value => typeof value === 'string' ? value.trim() : ''
const single = value => text(value).replace(/[\r\n]+/g, ' ')
const list = value => Array.isArray(value) ? value.map(text).filter(Boolean) : []

// L1 brief 精简：平台 goal 可用时，目标正文只写进平台 goal（子会话用 get_goal 读），
// brief 里留一句指引 + 一段截断兜底；goal 降级（没有 goals 服务）时仍然内联全文。
export const MAX_GOAL_FALLBACK_CHARS = 160
export const GOAL_POINTER_TEXT = `先调 get_goal 读取完整目标（含「最新指示」）；本行不是目标内容，别按它猜任务。`
export const GOAL_FALLBACK_TEXT = 'get_goal 不可用时按此执行：'

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

/** 【目标】小节：goal 可用时给「指引 + 截断兜底」，降级时内联全文。 */
export function goalLines(brief = {}, { goalAvailable = false } = {}) {
  const goal = single(brief.goal)
  if (goalAvailable !== true || goal === '') return [`【目标】${goal}`]
  const head = goal.length > MAX_GOAL_FALLBACK_CHARS
    ? `${goal.slice(0, MAX_GOAL_FALLBACK_CHARS)}…`
    : goal
  return [`【目标】${GOAL_POINTER_TEXT}`, `【目标兜底】${GOAL_FALLBACK_TEXT}${head}`]
}

/**
 * @param {object} brief
 * @param {{ goalAvailable?: boolean }} [options] goalAvailable=true 表示平台 goal 已可用（派发时会把目标
 *   写进子会话 goal，子会话能 get_goal 读到），此时 brief 只留指引 + 兜底；否则内联全文。
 */
export function renderBrief(brief = {}, { goalAvailable = false } = {}) {
  const lines = [`【任务】${single(brief.title)}`, ...goalLines(brief, { goalAvailable })]
  const target = text(brief.target)
  const readOnly = brief.readOnly === true
  // brief 里最多只出现一个目录：就是 target_dir；不要把指挥舱/父会话目录也写进来，否则模型容易被带偏。
  if (target !== '') {
    lines.push(`【工作目录】${single(target)}`)
    if (readOnly) {
      // 只读任务：写提示换成禁令，避免和沙箱行为冲突。
      lines.push('【权限】只读')
      lines.push('只读任务：读与回报正常，但不要写文件、不要执行写操作的 shell；产物把路径写进回报正文（或给绝对路径），不要尝试创建文件。')
    } else {
      // 正向提示（不是硬约束）：worker 不强制 chdir，danger-full-access 下越界绝对路径写得出去。
      lines.push('所有产出只写到该目录内，不要写到父会话目录或其他绝对路径；完成后汇报时把文件路径落到该目录下。')
    }
  } else if (readOnly) {
    lines.push('【权限】只读')
    lines.push('只读任务：读与回报正常，但不要写文件、不要执行写操作的 shell；产物把路径写进回报正文（或给绝对路径），不要尝试创建文件。')
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
