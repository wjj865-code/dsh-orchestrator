// brief 是内部结构化数据；发给子会话的永远是 renderBrief 渲染出的文字。
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
// P1-C 文案单源：访问级别这一行与 task_detail / 工具回执 / 状态行是同一句（src/copy.js）。
import { ACCESS_FULL } from './copy.js'
// 兼容出口：这些常量曾经分别住在 brief.js / prompt-layers.js，外部按旧路径 import 仍然可用。
import { BLOCKED_HINT, CONFIRM_HINT, SUMMARY_FIELDS, WORKTREE_INSTALL_HINT } from './copy.js'

export { BLOCKED_HINT, CONFIRM_HINT, SUMMARY_FIELDS, WORKTREE_INSTALL_HINT }

// t-4f7ce108（用户原话：「将静态提示词内容都统一移入任务执行者的 policy，这样每次跑都会注入」）：
// brief 只剩**这一次派发才知道的参数**——任务编号（task_detail 的入参）、访问级别、一行详情指针。
// 三条静态提示（执行中怎么上报 / 交付怎么回报 / worktree 装依赖）已经全部迁到 W1：
// `src/copy.js` 定义句子 → `src/prompt-layers.js` 的 `renderWorkerPolicy` 渲染 →
// `index.js` 的 `systemPrompt.context` 按任务子会话每回合注入。同一句不许在两层各写一份
// （`test/prompt-layers.test.js` 的 `layerViolations('L2', ...)` 探针锁住）。
//
// 为什么 task_detail 指引还留一行指针：派发那一刻子会话必须知道「先读详情、参数是哪个编号」；
// 字段清单与「不要凭 brief 猜任务内容」属 W1（WORKER_DETAIL_HINT），这里不重复。

const text = value => typeof value === 'string' ? value.trim() : ''
const single = value => text(value).replace(/[\r\n]+/g, ' ')
const list = value => Array.isArray(value) ? value.map(text).filter(Boolean) : []

// 一行指针：任务编号就是 task_detail 的 task_id（一次性的派发参数），其余字段清单在 W1。
export const DETAIL_POINTER_TEXT = '先调 task_detail 读完整详情（task_id 就是上面的任务编号）。'

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
 * 渲染派发给子会话的 brief（只留一次性参数）。
 *
 * 输出【任务编号】+【访问级别】（仅完整访问任务）+【任务详情】指针：
 * 静态提示（上报/交付/worktree 装依赖/主动读 context）都在 W1 每回合注入，brief 不再内联。
 *
 * @param {{ taskId?: string, access?: string }} [options]
 *   taskId 是台账任务编号（如 t-1a2b3c4d），也是 task_detail 的参数；
 *   access='full' 时多一行访问级别，子会话一开始就知道自己不在沙箱里跑（不必试探写权限）。
 */
export function renderBrief({ taskId, access } = {}) {
  const id = single(taskId)
  const lines = []
  if (id !== '') lines.push(`【任务编号】${id}`)
  if (access === 'full') lines.push(ACCESS_FULL.briefLine)
  lines.push(`【任务详情】${DETAIL_POINTER_TEXT}`)
  return lines.join('\n')
}

/**
 * 台账任务行 → 它自己的 brief（task_create / 重派（task_message action:retry）/ 面板 retry / 队列兜底四个调用点共用）。
 *
 * 字段映射只写在这里：`tasks.access` 是唯一真相，四个入口各自拼一遍参数必然漂移
 * （此前 access 就在四处各写了一份三元表达式）。`worktree_state` 不进 brief：装依赖提示归 W1，
 * 按同一个台账字段在 policy 里条件渲染。
 *
 * @param {object} task 台账任务行（`id` / `access`）
 */
export function renderBriefForTask(task = {}) {
  return renderBrief({
    taskId: task?.id,
    access: task?.access === 'full' ? 'full' : undefined,
  })
}
