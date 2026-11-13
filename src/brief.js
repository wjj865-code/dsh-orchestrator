// brief 是内部结构化数据；发给子会话的永远是 renderBrief 渲染出的文字。
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

export function renderBrief(brief = {}) {
  const lines = [`【任务】${single(brief.title)}`, `【目标】${single(brief.goal)}`]
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
