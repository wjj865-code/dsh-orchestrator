// 已登记工作区的只读索引：worker 扫描，task_report 持久化到既有 settings；不改用户记忆。
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { runGit } from './worktree.js'
import { getSetting, setSetting } from './ledger.js'

export const WORKSPACE_INDEX_KEY = 'workspace_repo_index'
export const INDEX_TITLE = '工作区与仓库索引'
export const workspaceIndexSavedKey = taskId => `workspace_index_saved:${taskId}`

// remote 只留定位部分：移除 userinfo、query、fragment；不回传 git stderr（可能带凭证）。
export function redactRemote(value) {
  const text = String(value ?? '').trim()
  if (text.includes('://')) {
    try {
      const url = new URL(text)
      url.username = ''; url.password = ''; url.search = ''; url.hash = ''
      return url.toString()
    } catch { return '[remote 已隐藏]' }
  }
  if (/^[^/@\s]+@[^:\s]+:/.test(text)) return text.replace(/^[^@]+@/, '').split(/[?#]/)[0]
  // 仅保留普通路径或 scp host:path；含凭证式 @ 的未知格式不猜。
  return text.includes('@') ? '[remote 已隐藏]' : text.split(/[?#]/)[0]
}

export function registeredWorkspaces(service) {
  const list = service?.list?.()
  if (!Array.isArray(list)) throw new Error('workspaceRegistry.list 不可用，请稍后重试')
  return list.filter(item => typeof item?.id === 'string' && typeof item?.path === 'string' && isAbsolute(item.path))
    .map(({ id, title, path }) => ({ id, title: typeof title === 'string' ? title : '', path }))
}

export async function scanWorkspaces(workspaces, { git = runGit, isDirectory = path => statSync(path).isDirectory() } = {}) {
  const entries = []
  for (const workspace of workspaces) {
    const entry = { ...workspace, sampledAt: new Date().toISOString(), status: 'unavailable' }
    entries.push(entry)
    try {
      if (!isDirectory(workspace.path)) continue
      const root = await git(['rev-parse', '--show-toplevel'], { cwd: workspace.path })
      if (!root.ok) {
        entry.status = /not a git repository/i.test(root.stderr ?? '') ? 'not_git' : 'unavailable'
        continue
      }
      entry.status = 'git'
      entry.repoRoot = root.stdout.trim()
      for (const [field, args] of [
        ['branch', ['branch', '--show-current']],
        ['head', ['rev-parse', '--verify', 'HEAD']],
        ['origin', ['config', '--get', 'remote.origin.url']],
        ['commonDir', ['rev-parse', '--path-format=absolute', '--git-common-dir']],
      ]) {
        const result = await git(args, { cwd: workspace.path })
        entry[field] = result.ok ? (field === 'origin' ? redactRemote(result.stdout) : result.stdout.trim()) : null
      }
    } catch { entry.status = 'unavailable' }
  }
  return { entries }
}

export function loadWorkspaceIndex(db) {
  try { return JSON.parse(getSetting(db, WORKSPACE_INDEX_KEY) ?? 'null') } catch { return null }
}

// 只接收该索引任务创建时名单中的每一项，title/path 使用名单真值，不采信 worker 的别名。
export function saveWorkspaceIndex(db, task, value) {
  const expected = task.brief?.workspaceIndexEntries
  if (!task.read_only || !Array.isArray(expected)) throw new Error('只有只读工作区索引任务可回报索引')
  if (typeof value !== 'string' || value.length > 500_000) throw new Error('workspace_index 必须是至多 500000 字的 JSON')
  const parsed = JSON.parse(value)
  if (!Array.isArray(parsed?.entries) || parsed.entries.length !== expected.length) throw new Error('索引必须逐项覆盖创建时工作区名单')
  const entries = expected.map(workspace => {
    const matches = parsed.entries.filter(entry => entry?.id === workspace.id && entry?.path === workspace.path)
    if (matches.length !== 1) throw new Error('索引工作区不匹配或重复')
    const result = matches[0]
    if (!['git', 'not_git', 'unavailable'].includes(result.status)) throw new Error('索引状态不合法')
    if (!Number.isFinite(Date.parse(result.sampledAt))) throw new Error('索引缺少采样时间')
    const entry = { ...workspace, sampledAt: result.sampledAt, status: result.status }
    if (result.status === 'git') {
      if (typeof result.repoRoot !== 'string' || !isAbsolute(result.repoRoot)) throw new Error('仓库根必须为绝对路径')
      entry.repoRoot = result.repoRoot
      for (const field of ['branch', 'head', 'origin', 'commonDir']) {
        entry[field] = typeof result[field] === 'string' ? result[field].slice(0, 4096) : null
      }
      entry.origin = entry.origin === null ? null : redactRemote(entry.origin)
    }
    return entry
  })
  const snapshot = { recordedAt: new Date().toISOString(), sourceTaskId: task.id, entries }
  // 结果与本任务成功标记同事务，其他索引覆盖全局快照不抹掉本任务的完成证据。
  db.exec('SAVEPOINT workspace_index_save')
  try {
    setSetting(db, WORKSPACE_INDEX_KEY, JSON.stringify(snapshot))
    setSetting(db, workspaceIndexSavedKey(task.id), snapshot.recordedAt)
    db.exec('RELEASE workspace_index_save')
  } catch (error) {
    db.exec('ROLLBACK TO workspace_index_save')
    db.exec('RELEASE workspace_index_save')
    throw error
  }
  return snapshot
}

export function workspaceIndexText(snapshot, path) {
  if (!snapshot) return ''
  const entries = path === undefined ? snapshot.entries : snapshot.entries.filter(entry => entry.path === path)
  return `【工作区与仓库索引】采样快照（非实时，使用前核对；歧义列候选）\n${entries.map(entry => JSON.stringify(entry)).join('\n')}`
}
