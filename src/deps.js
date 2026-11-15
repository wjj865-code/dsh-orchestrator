// 任务依赖：只允许依赖已存在的任务；创建时把未就绪的任务放进 waiting_dep，
// 依赖完成后再晋升为 pending 入队；依赖失败/丢失则向下游传播失败。
import { getTask, listTasks, recentMessages, transition } from './ledger.js'
import { taskLabelWithId } from './task-label.js'
import { statusLabel } from './state.js'

const FAILED_DEP = new Set(['failed', 'cancelled', 'orphaned'])
const MAX_DEPENDS = 20

const labelOf = statusLabel
const short = (value, max = 100) => {
  const text = String(value ?? '').split('\n')[0].trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * 校验 dependsOn：去重、最多 20 条、必须存在，且不能依赖已经失败/取消/丢失的任务。
 * @returns {{ok: true, ids: string[]} | {ok: false, error: string}}
 */
export function validateDepends(db, values) {
  if (values === undefined || values === null) return { ok: true, ids: [] }
  if (!Array.isArray(values)) return { ok: false, error: 'dependsOn 必须是任务编号数组' }
  const ids = []
  for (const value of values) {
    if (typeof value !== 'string') return { ok: false, error: 'dependsOn 里每一项都必须是任务编号字符串' }
    const id = value.trim()
    if (id === '' || ids.includes(id)) continue
    ids.push(id)
  }
  if (ids.length > MAX_DEPENDS) return { ok: false, error: `dependsOn 最多 ${MAX_DEPENDS} 个任务` }
  for (const id of ids) {
    const task = getTask(db, id)
    if (task === undefined) return { ok: false, error: `前置任务不存在：${id}` }
    if (FAILED_DEP.has(task.status)) {
      return { ok: false, error: `前置任务「${taskLabelWithId(task)}」当前是${labelOf(task.status)}，不能作为依赖；先 task_retry 或新建一个可用的前置任务` }
    }
  }
  return { ok: true, ids }
}

/** 依赖状态：missing（不存在）/ failed（终态失败）/ ready（全部 done）。 */
export function dependencyState(db, task) {
  const ids = Array.isArray(task?.depends_on) ? task.depends_on : []
  const deps = []
  const missing = []
  const failed = []
  for (const id of ids) {
    const dep = getTask(db, id)
    if (dep === undefined) {
      missing.push({ id })
      continue
    }
    deps.push(dep)
    if (FAILED_DEP.has(dep.status)) failed.push(dep)
  }
  return {
    deps,
    missing,
    failed,
    ready: ids.length === 0 || (missing.length === 0 && deps.every(dep => dep.status === 'done')),
  }
}

/**
 * 把 waiting_dep 任务推进到 pending（依赖全 done）或 failed（依赖失败/丢失）；
 * 循环到稳定，才能把失败沿依赖链传播下去。返回晋升/失败的任务 id。
 */
export function promoteDependents(db, { enqueue = () => {}, log = () => {} } = {}) {
  const promoted = []
  const failed = []
  for (let pass = 0; pass < 20; pass += 1) {
    const waiting = listTasks(db).filter(task => task.status === 'waiting_dep')
    if (waiting.length === 0) break
    let changed = false
    for (const task of waiting) {
      const state = dependencyState(db, task)
      if (state.missing.length > 0) {
        const reason = `前置任务不存在：${state.missing.map(item => item.id).join('、')}`
        transition(db, task.id, 'failed', { error: reason })
        failed.push(task.id)
        changed = true
        log('task.dep.failed', { taskId: task.id, detail: { reason } })
        continue
      }
      if (state.failed.length > 0) {
        const names = state.failed.map(dep => `「${taskLabelWithId(dep)}」（${labelOf(dep.status)}）`).join('、')
        const reason = `前置任务未完成：${names}`
        transition(db, task.id, 'failed', { error: reason })
        failed.push(task.id)
        changed = true
        log('task.dep.failed', { taskId: task.id, detail: { reason } })
        continue
      }
      if (!state.ready) continue
      transition(db, task.id, 'pending')
      enqueue(task.id)
      promoted.push(task.id)
      changed = true
      log('task.dep.ready', { taskId: task.id, detail: { dependsOn: task.depends_on } })
    }
    if (!changed) break
  }
  return { promoted, failed }
}

/** 前置任务摘要块：task_detail 现读时用（创建时依赖可能还没完成，所以按当前台账渲染）。 */
export function upstreamBrief(db, dependsOn) {
  const ids = Array.isArray(dependsOn) ? dependsOn : []
  if (ids.length === 0) return ''
  const lines = ['【前置任务】']
  for (const id of ids) {
    const dep = getTask(db, id)
    if (dep === undefined) {
      lines.push(`- ${id}：不存在`)
      continue
    }
    const report = recentMessages(db, id, 5).find(row => row.kind === 'report')
    const summary = report === undefined
      ? (dep.status === 'done' ? dep.goal : `（当前${labelOf(dep.status)}）`)
      : String(report.rendered).replace(/^\[[^\]]+\]\s*/, '')
    lines.push(`- 任务「${dep.title}」${dep.status === 'done' ? '已完成' : `当前${labelOf(dep.status)}`}：${short(summary)}`)
    const artifacts = Array.isArray(dep.artifacts) ? dep.artifacts : []
    if (artifacts.length > 0) {
      lines.push(`  产物：${artifacts.slice(0, 8).map(item => item.path).join('、')}`)
    }
  }
  let block = lines.join('\n')
  if (block.length > 1600) block = `${block.slice(0, 1599)}…`
  return block
}
