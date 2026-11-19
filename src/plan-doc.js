// 计划落盘（P8 计划交付）：只读子会话在计划阶段**唯一**被允许的写入口。
//
// 为什么需要它：计划阶段是只读沙箱（硬拦），子会话没有任何写文件的手段；计划只能塞进
// `task_report blocked` 的 `question`（限 500 字），长计划会被截断、也没法给用户一个好读的文件。
// 所以计划文档由**插件在宿主进程**写（不受子会话沙箱限制），路径固定、只认任务编号，
// 写完登记成任务产物——子会话只上报「摘要 + 路径 + 待拍板清单」。
//
// 职责切分：
// - 本模块只做纯函数：路径推导 + 逃逸校验 + 文档渲染 + 一次 mkdir/writeFile；
// - 越权（不是任务自己的子会话 / 不是计划任务）、正文大小、日志、产物登记都在 src/tools.js。
import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
// 计划文案单源（P1-C）：落盘后的「下一步」与 task_detail / 工具回执用同一句。
import { planSavedNextStep } from './copy.js'

/** 计划文档目录（相对主会话工作区）。 */
export const PLAN_SUBDIR = join('reports', 'plans')

/** 计划文档扩展名。 */
export const PLAN_EXT = '.md'

/** 计划正文上限（字符）。超过就拒绝，不静默截断——截断的计划比没有更危险。 */
export const MAX_PLAN_CHARS = 200_000

/**
 * 合法任务编号形状（台账 `createTask` 生成 `t-` + 8 位十六进制）。
 *
 * 路径是由编号拼出来的，所以这里先做**白名单形状**校验：只允许 `t-` + 小写字母/数字，
 * 从根上不给 `..`、`/`、`\`、盘符、NUL 任何拼接机会（逃逸校验是第二道闸，见 planDocPath）。
 */
export const PLAN_TASK_ID = /^t-[0-9a-z]{4,32}$/

const text = value => typeof value === 'string' ? value.trim() : ''

/** 任务编号形状是否可用于拼路径。 */
export function isSafePlanTaskId(taskId) {
  return PLAN_TASK_ID.test(text(taskId))
}

/** 逃逸判定用的相对路径检查：空、以 `..` 开头、绝对路径、跨目录，全算逃逸。 */
export function escapesDir(dir, path) {
  const rel = relative(dir, path)
  if (rel === '' || rel === '.') return true
  if (isAbsolute(rel)) return true
  if (rel.startsWith(`..${sep}`) || rel === '..') return true
  return rel.includes(sep) || rel.includes('/')
}

/**
 * 推导计划文档的绝对路径：**固定** `<主会话工作区>/reports/plans/<taskId>.md`。
 *
 * 没有 `path` 参数可传：调用方只能给任务编号，路径由插件算。两道闸：
 * 1. 编号形状白名单（`PLAN_TASK_ID`）；
 * 2. `relative()` 包含性校验（防主会话目录本身是符号链接/相对路径/带 `..` 时的意外逃逸）。
 *
 * @returns {{ok: true, path: string, dir: string} | {ok: false, error: string}}
 */
export function planDocPath(mainDir, taskId) {
  const root = text(mainDir)
  if (root === '') return { ok: false, error: '没有主会话工作区可用（主会话目录为空）' }
  const id = text(taskId)
  if (id === '') return { ok: false, error: '缺少任务编号' }
  if (!isSafePlanTaskId(id)) {
    return { ok: false, error: `任务编号不合法（只允许 t-<小写字母/数字>）：${id}` }
  }
  const base = resolve(root)
  const dir = resolve(base, PLAN_SUBDIR)
  const path = resolve(dir, `${id}${PLAN_EXT}`)
  // 目录本身必须是主会话工作区的子目录；文件必须直接在 plans/ 下（不能多一层、不能跳出去）。
  if (isAbsolute(relative(base, dir)) || relative(base, dir).startsWith(`..${sep}`) || relative(base, dir) === '..') {
    return { ok: false, error: `计划路径逃逸被拒绝：${path}` }
  }
  if (escapesDir(dir, path)) return { ok: false, error: `计划路径逃逸被拒绝：${path}` }
  return { ok: true, path, dir }
}

/** 文档头：让用户单独打开这个 md 也知道「这是哪个任务的计划、什么时候落的」。 */
export function renderPlanDocument({ task = {}, content = '', savedAt = Date.now() } = {}) {
  const title = text(task.title) || '未命名任务'
  const goal = text(task.goal).split('\n')[0]
  const when = new Date(Number.isFinite(savedAt) ? savedAt : Date.now()).toISOString()
  const lines = [
    `# 计划：${title}`,
    '',
    `- 任务编号：${text(task.id) || '-'}`,
  ]
  if (goal !== '') lines.push(`- 目标：${goal}`)
  lines.push(`- 落盘时间：${when}`, '', '---', '')
  const body = text(content)
  lines.push(body === '' ? '（正文为空）' : body)
  return `${lines.join('\n')}\n`
}

/**
 * 落盘：校验路径 → mkdir → 写 UTF-8。
 *
 * 重复调用覆盖同一份文件（计划只有一个版本，没有版本对比/审批流）；失败把原因如实返回，
 * 不抛栈、不半写完就报成功。
 *
 * @returns {{ok: true, path: string, chars: number, bytes: number} | {ok: false, error: string}}
 */
export async function writePlanDocument({ mainDir, task, content = '', savedAt = Date.now() } = {}) {
  const target = planDocPath(mainDir, task?.id)
  if (target.ok !== true) return target
  const body = renderPlanDocument({ task, content, savedAt })
  try {
    await mkdir(target.dir, { recursive: true })
    await writeFile(target.path, body, 'utf8')
  } catch (error) {
    return { ok: false, path: target.path, error: `写计划文件失败：${error?.message ?? error}` }
  }
  return {
    ok: true,
    path: target.path,
    chars: text(content).length,
    bytes: Buffer.byteLength(body, 'utf8'),
  }
}

/** 工具结果文案：落盘成功后下一步该做什么（摘要上报，不搬正文）。 */
export function planSavedNote({ path, chars, bytes }) {
  return `计划已落盘：${path}（正文 ${chars} 字 / 文件 ${bytes} 字节）｜已登记为任务产物（通知与面板可交付）。\n`
    + planSavedNextStep
}
