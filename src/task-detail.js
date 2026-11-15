// task_detail（T1）：子会话读任务创建详情。
//
// 只读：字段全部来自台账任务行（brief JSON 是创建时快照 + 台账列），这里不写库、不改消息、
// 不碰任务状态；经验文件只 stat 存在性，不读正文（子会话自己有 read 工具，读全文由它决定）。
import { statSync } from 'node:fs'
import { statusLabel } from './state.js'
import { PLAN_FIRST_DETAIL, isPlanTask, planStateOf, PLAN_STATE_LABEL } from './plan-mode.js'
import { worktreeDetailLines } from './worktree-request.js'

const text = value => typeof value === 'string' ? value.trim() : ''
const single = value => text(value).replace(/[\r\n]+/g, ' ')
const list = value => Array.isArray(value) ? value.map(text).filter(Boolean) : []

const WRITE_HINT = '所有产出只写到该目录内，不要写到父会话目录或其他绝对路径；完成后汇报时把文件路径落到该目录下。'
const READ_ONLY_HINT = '只读任务：读与回报正常，但不要写文件、不要执行写操作的 shell；产物把路径写进回报正文（或给绝对路径），不要尝试创建文件。'
// 完整访问（access:'full'）：沙箱不再限制写入，但任务边界还在——风险文案必须写清楚，别让它以为「哪都能改」。
const FULL_ACCESS_HINT = '完整访问任务：文件沙箱是 danger-full-access，写文件、跑 bash/pwsh 都不会被沙箱拦。仍按任务边界只改这个目录/仓库里的东西，别碰无关路径与用户数据（这条是纪律，不是沙箱拦）。'
const ACCESS_FULL_LABEL = '完整（danger-full-access：文件沙箱不限制写入，bash/pwsh 也不再被沙箱拦）'
const FINISH_HINT = '完成后用 task_report 回报（progress / done / blocked / needs_auth），正文写：改了什么、改了哪些文件、怎么验证的。'

const fileExists = value => {
  if (typeof value !== 'string' || value.trim() === '') return false
  try {
    return statSync(value).isFile()
  } catch {
    return false
  }
}

// 产物可以是目录（产物收集允许目录条目），存在性判定与台账 normalizeArtifacts 同口径。
const artifactExists = value => {
  if (typeof value !== 'string' || value.trim() === '') return false
  try {
    const stats = statSync(value)
    return stats.isFile() || stats.isDirectory()
  } catch {
    return false
  }
}

const artifactLine = item => {
  const path = text(item?.path)
  if (path === '') return ''
  const label = text(item?.label)
  return `- ${path}${label === '' ? '' : `（${label}）`}${artifactExists(path) ? '' : '（已缺失）'}`
}

const experienceText = experience => {
  if (experience === null || typeof experience !== 'object') return ''
  const path = text(experience.path)
  if (path !== '') {
    const count = Number.isFinite(experience.count) ? `（${experience.count} 条）` : ''
    // 指针模式：完整经验在记忆文件里，子会话按需 read；文件被清理时明确说出来，别让它以为没经验。
    return `【经验文件】${path}${count}｜${fileExists(path) ? '可 read 全文' : '文件已丢失'}`
  }
  // 降级模式：记忆文件写不出来时 brief 里存的是内联块，这里原样给出（不丢经验，也不进提示词）。
  const inline = text(experience.inline)
  return inline
}

/**
 * 渲染 task_detail 的只读文本。
 *
 * @param {object} task 台账任务行（含 `brief` JSON、`artifacts`、`depends_on` 等列）
 * @param {{
 *   dependencies?: string,
 *   experience?: { path?: string, count?: number, inline?: string },
 *   artifacts?: Array<{ path?: string, label?: string }>,
 * }} [options]
 *   dependencies 直接传 `deps.upstreamBrief` 的渲染结果：前置状态/摘要按**当前**台账现读，
 *   而不是创建时快照（依赖可能在创建后才完成）。经验/产物用创建时台账里的快照。
 */
export function renderTaskDetail(task = {}, { dependencies = '', experience, artifacts = [] } = {}) {
  const brief = task.brief ?? {}
  // P9：隔离任务的「工作目录」是检出目录（派发时 target_dir 已换算成「检出 + 原 target 偏移」），
  // brief.target 仍是用户原始目录，所以这里优先用 target_dir，否则子会话会去写用户工作树。
  const checkoutTarget = ['created', 'reused'].includes(task.worktree_state) ? text(task.target_dir) : ''
  const target = checkoutTarget !== '' ? checkoutTarget : text(brief.target ?? task.target_dir)
  const readOnly = brief.readOnly === true || task.read_only === true
  const planTask = isPlanTask(task)
  const planState = planStateOf(task)
  // 计划阶段（还没批准）运行期就是只读：权限文案必须如实，否则子会话会以为自己能写。
  const planning = planTask && planState === 'planning'
  const effectiveReadOnly = readOnly || planning
  // per-task 完整访问：只读/计划阶段永远压过它（运行期事实优先），台账与 brief 任一处标了 full 都算。
  const fullAccess = !effectiveReadOnly && (brief.access === 'full' || task.access === 'full')
  const lines = [
    `任务编号：${task.id ?? '-'}`,
    `任务：${single(brief.title ?? task.title)}`,
    `状态：${statusLabel(task.status)}${effectiveReadOnly ? '｜只读' : (fullAccess ? '｜完整访问' : '')}`,
    `目标：${text(brief.goal ?? task.goal)}`,
  ]
  // 工作目录最多出现一个：就是 target_dir；写提示紧跟其后（与旧 brief 同口径）。
  if (target !== '') {
    lines.push(`工作目录：${target}`)
    lines.push(`权限：${effectiveReadOnly ? '只读' : '可写'}`)
    if (fullAccess) lines.push(`访问级别：${ACCESS_FULL_LABEL}`)
    lines.push(effectiveReadOnly ? READ_ONLY_HINT : (fullAccess ? FULL_ACCESS_HINT : WRITE_HINT))
  } else if (effectiveReadOnly) {
    lines.push('权限：只读')
    lines.push(READ_ONLY_HINT)
  } else if (fullAccess) {
    lines.push(`访问级别：${ACCESS_FULL_LABEL}`)
    lines.push(FULL_ACCESS_HINT)
  }
  // P8：计划任务在详情里说明「只读是预期、出口是 task_report blocked」，并给出当前编排视图。
  if (planTask) {
    lines.push(`计划状态：${PLAN_STATE_LABEL[planState] ?? planState}`)
    lines.push(PLAN_FIRST_DETAIL)
  }
  // P9：隔离任务说明「在哪个检出/分支、产物不在用户工作树、合并由用户决定」。
  const worktreeLines = worktreeDetailLines(task)
  if (worktreeLines.length > 0) lines.push(...worktreeLines)
  const acceptance = list(brief.acceptance)
  if (acceptance.length > 0) lines.push(`【验收标准】\n${acceptance.map(item => `- ${single(item)}`).join('\n')}`)
  const constraints = list(brief.constraints)
  if (constraints.length > 0) lines.push(`【约束】${constraints.map(item => `- ${single(item)}`).join('；')}`)
  const refs = list(brief.refs)
  if (refs.length > 0) lines.push(`【背景资料】${refs.map(item => `- ${single(item)}`).join('；')}`)
  const verbatim = text(brief.user_verbatim)
  if (verbatim !== '') lines.push(`【用户原话】\n${verbatim.split(/\r?\n/).map(line => `> ${line.trim()}`).join('\n')}`)
  // 编排字段只在非默认时出现，避免每份详情都是噪音。
  const placement = [
    task.group_id ? `分组 ${task.group_id}` : '',
    Number.isFinite(task.priority) && task.priority !== 0 ? `优先级 ${task.priority}` : '',
    Array.isArray(task.write_scopes) && task.write_scopes.length > 0 ? `写域 ${task.write_scopes.join('、')}` : '',
  ].filter(Boolean)
  if (placement.length > 0) lines.push(`编排：${placement.join('｜')}`)
  if (text(dependencies) !== '') lines.push(dependencies)
  const experienceBlock = experienceText(experience)
  if (experienceBlock !== '') lines.push(experienceBlock)
  const artifactLines = (Array.isArray(artifacts) ? artifacts : []).map(artifactLine).filter(Boolean)
  if (artifactLines.length > 0) lines.push(`【已有产物】\n${artifactLines.join('\n')}`)
  lines.push(FINISH_HINT)
  return lines.join('\n')
}
