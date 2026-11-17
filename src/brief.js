// brief 是内部结构化数据；发给子会话的永远是 renderBrief 渲染出的文字。
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
// 「注定在独立检出里跑」的状态列表只有一份（write-guard 的 ISOLATED_WORKTREE_STATES：
// requested 待建检出 / created / reused）。brief 的装依赖提示必须与它同口径：
// degraded（目标不是 git 仓库）仍在原工作树里跑、依赖齐全，不该出现装依赖提示。
import { ISOLATED_WORKTREE_STATES } from './write-guard.js'

const text = value => typeof value === 'string' ? value.trim() : ''
const single = value => text(value).replace(/[\r\n]+/g, ' ')
const list = value => Array.isArray(value) ? value.map(text).filter(Boolean) : []

// T1 brief 纯指引化：任务创建详情（目标全文/验收/约束/背景/经验/依赖/产物）全在台账里，
// 由子会话用 task_detail 现取；brief 只留任务编号 + 一句指引，不再内联目标正文、经验摘要或
// 「get_goal 不可用」的兜底文本——这样提示词长度不随目标/记忆增长，详情也永远是最新台账。
export const DETAIL_POINTER_TEXT = '先调 task_detail（参数 task_id 填上面的任务编号）读取完整任务详情：'
  + '目标全文、验收标准、约束、背景资料、用户原话、工作目录与权限、前置任务、经验文件、已有产物。'
  + '本行只是指引，不要凭它猜任务内容。'

// 用户偏好（记忆 m-64458b11）：需要确认的事用**选项**方式问，不要只在正文里问或让用户自己回文字。
//
// 关键事实（平台约束，别写错）：`ask_user_question` 对 subagent 来源的会话直接拒绝——
// `assertLiveRoot` 见到 `session.header.origin === 'subagent'` 就抛 `DELEGATED_CALLER`
// （「human interaction is unavailable while the calling agent is owned by another live agent」）。
// 子会话是 `subagents.startActivation({ parent })` 起的 subagent，所以它**调不通**这个工具；
// brief 若写「你去调 ask_user_question」等于让每个子会话每轮撞一次墙。
//
// 所以「问用户」这件事始终由协调者做（带子会话给的同一批选项），子会话只负责**把问题与选项交回去**：
// - 执行中（提示三）：task_report blocked + question/options → 通知原样带给协调者 → 协调者问用户 → task_message 续派；
// - 交付时（提示一）：done 会清掉 question/options，待确认要点写进 summary，协调者据此带选项问。
export const BLOCKED_HINT = '执行中遇到需要用户拍板的事（业务取舍、范围变更、不可逆操作、方案歧义等）：'
  + '用 task_report 的 blocked 上报「问题 + 选项建议」，由协调者用 ask_user_question 向用户确认后经 task_message 续派再继续；'
  + '不要自行假设用户意图、不要阻塞等待、也不要等不到回复就跳过。blocked 只是上报，不等于已获授权。'

// 交付口径的**唯一措辞**（审计 §5.1.2 矛盾 2）：brief 与 task_detail 曾各写一套——
// 这里说「要点写进 summary」，task_detail 说「正文写：改了什么/改了哪些文件/怎么验证的」，
// 子会话不知道 summary 该写结论还是写三问。现在统一成「summary = 结论 + 三问要素」，
// task_detail 的 FINISH_HINT 直接引用本常量，不再各写一份。
export const SUMMARY_FIELDS = '改了什么、改了哪些文件、怎么验证的'
export const CONFIRM_HINT = `交付（报 done）时把 summary 写成「结论 + ${SUMMARY_FIELDS}」，并带上待确认要点；`
  + 'done 会清空 question/options，所以要点必须在 summary 里；'
  + '子会话直接调 ask_user_question 会被平台拒（DELEGATED_CALLER），由协调者带选项问用户「确认 / 要改？」。'

// worktree 任务的检出是全新目录，node_modules/虚拟环境这类依赖不在库里 → 子会话常因依赖缺失跑不了测试/构建。
// 只说「可以装、只装不升」：不授权改依赖版本，也不放宽任何推送前审查/人工确认门禁。
export const WORKTREE_INSTALL_HINT = 'worktree 检出目录里没有依赖：可执行安装命令（pnpm install / npm install / uv sync 等），'
  + '只安装不升级（不改依赖声明与版本）。'

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
 * 输出【任务编号】+【访问级别】（仅完整访问任务）+【worktree 依赖】（仅隔离任务）
 * +【任务详情】+【执行中待确认】（所有任务，执行期就要用）+【确认方式】（交付时用）：
 * brief 正文不携带任何创建详情（目标/验收/经验/兜底都不进），子会话拿到任务编号后调 task_detail 读台账快照。
 *
 * 三段提示的分工（每段的归属层见 src/prompt-layers.js 的 PROMPT_LAYERS）：
 * ③执行中遇阻 → blocked 上报（一开始就要看到，不能只写在交付环节）；
 * ①交付时 → summary 写「结论 + 三问 + 待确认要点」（`done` 不支持 question/options）；
 * ②隔离任务 → 可装依赖（只装不升）。
 *
 * @param {{ taskId?: string, access?: string, worktreeState?: string }} [options]
 *   taskId 是台账任务编号（如 t-1a2b3c4d），也是 task_detail 的参数；
 *   access='full' 时多一行访问级别，子会话一开始就知道自己不在沙箱里跑（不必试探写权限）；
 *   worktreeState 是台账 `tasks.worktree_state`：只有 requested/created/reused（真在独立检出里跑）
 *   才给装依赖提示；none/degraded 等仍在原工作树，依赖齐全，不给（否则等于无意义噪音）。
 */
export function renderBrief({ taskId, access, worktreeState } = {}) {
  const id = single(taskId)
  const lines = []
  if (id !== '') lines.push(`【任务编号】${id}`)
  if (access === 'full') lines.push(`【访问级别】完整（danger-full-access：文件沙箱不限制写入，bash/pwsh 也不再被沙箱拦；只对本任务生效）`)
  if (ISOLATED_WORKTREE_STATES.includes(worktreeState)) lines.push(`【worktree 依赖】${WORKTREE_INSTALL_HINT}`)
  lines.push(`【任务详情】${DETAIL_POINTER_TEXT}`)
  lines.push(`【执行中待确认】${BLOCKED_HINT}`)
  lines.push(`【确认方式】${CONFIRM_HINT}`)
  return lines.join('\n')
}

/**
 * 台账任务行 → 它自己的 brief（task_create / task_retry / 面板 retry / 队列兜底四个调用点共用）。
 *
 * 字段映射只写在这里：`tasks.access` / `tasks.worktree_state` 是唯一真相，
 * 四个入口各自拼一遍参数必然漂移（此前 access 就在四处各写了一份三元表达式）。
 *
 * @param {object} task 台账任务行（`id` / `access` / `worktree_state`）
 */
export function renderBriefForTask(task = {}) {
  return renderBrief({
    taskId: task?.id,
    access: task?.access === 'full' ? 'full' : undefined,
    worktreeState: task?.worktree_state,
  })
}
