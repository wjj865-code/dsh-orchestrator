// 从 DSH 的 workspaceChanges 摘要里收集任务改动文件。
//
// 平台在每回合 stopping 时追加一条 `workspace/changes` 事件，摘要服务
// `workspaceChanges.summary(sessionId, seq)` 只对仍然存活的会话可读。这里不猜
// 文件名：遍历子会话自己的事件，逐条取摘要，按绝对路径去重合并。
import { statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

/** 产物库单任务上限（与 ledger.MAX_TASK_ARTIFACTS 对齐；本模块不反向依赖 ledger）。 */
export const MAX_AUTO_ARTIFACTS = 50

const existsAt = path => {
  try {
    const stats = statSync(path)
    return stats.isFile() || stats.isDirectory()
  } catch {
    return false
  }
}

const labelOf = file => {
  if (file?.binary === true) return '二进制文件'
  if (file?.oversized === true) return '大文件'
  const added = Number.isFinite(file?.added) ? file.added : 0
  const deleted = Number.isFinite(file?.deleted) ? file.deleted : 0
  return added === 0 && deleted === 0 ? '有改动' : `+${added}/-${deleted}`
}

/** 子会话自己的 `workspace/changes` 事件；兼容 ownEvents / snapshotEvents / events 三种形状。 */
export function changedEventsOf(session) {
  if (session === null || session === undefined) return []
  let events
  try {
    if (typeof session.ownEvents === 'function') events = session.ownEvents()
    else if (typeof session.snapshotEvents === 'function') events = session.snapshotEvents()
    else if (Array.isArray(session.events)) events = session.events
  } catch {
    events = undefined
  }
  if (!Array.isArray(events)) return []
  return events.filter(event => event?.type === 'workspace/changes' && Number.isFinite(event.seq))
}

/**
 * 汇总一个子会话所有回合的改动文件。
 *
 * - `path` 用摘要里的 cwd 解析成绝对路径（摘要在 cwd 内给相对路径，cwd 外给绝对路径）；
 * - 同一文件在多个回合出现时按路径去重，保留最后一次的计数标签；
 * - 服务缺失、会话不存在、摘要已随会话释放都只返回空结果，不让回报失败。
 *
 * @returns {{ artifacts: Array<{path: string, label: string, exists: boolean}>, turns: number, omitted: number }}
 */
export function collectWorkspaceArtifacts({ session, workspaceChanges, fallbackCwd, max = MAX_AUTO_ARTIFACTS } = {}) {
  const empty = { artifacts: [], turns: 0, omitted: 0 }
  if (workspaceChanges === null || workspaceChanges === undefined || typeof workspaceChanges.summary !== 'function') return empty
  const sessionId = session?.id
  if (sessionId === undefined || sessionId === null) return empty
  const byPath = new Map()
  let turns = 0
  for (const event of changedEventsOf(session)) {
    let summary
    try {
      summary = workspaceChanges.summary(sessionId, event.seq)
    } catch {
      summary = undefined
    }
    if (summary === null || summary === undefined) continue
    turns += 1
    const cwd = typeof summary.cwd === 'string' && summary.cwd !== '' ? summary.cwd : fallbackCwd
    for (const file of Array.isArray(summary.files) ? summary.files : []) {
      const raw = typeof file?.path === 'string' ? file.path.trim() : ''
      if (raw === '') continue
      let absolute
      if (isAbsolute(raw)) absolute = raw
      else if (typeof cwd === 'string' && cwd !== '') absolute = resolve(cwd, raw)
      else continue
      byPath.set(absolute, { path: absolute, label: labelOf(file), exists: existsAt(absolute) })
    }
  }
  const all = [...byPath.values()]
  const limit = Math.max(1, Math.floor(Number.isFinite(max) ? max : MAX_AUTO_ARTIFACTS))
  return {
    artifacts: all.slice(0, limit),
    turns,
    omitted: Math.max(0, all.length - limit),
  }
}

/** 只把当前产物里没有的路径追加进去（保留显式产物的标签，不覆盖）。 */
export function appendMissingArtifacts(current, incoming) {
  const existing = new Set((Array.isArray(current) ? current : [])
    .map(item => item?.path)
    .filter(path => typeof path === 'string' && path !== ''))
  return (Array.isArray(incoming) ? incoming : [])
    .filter(item => typeof item?.path === 'string' && item.path !== '' && !existing.has(item.path))
}
