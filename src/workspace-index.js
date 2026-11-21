// Registered-workspace read-only index: worker scan, task_report persists to settings; no user memory writes.
// When the git child process cannot start (spawnError EPERM/EACCES/ENOENT, e.g. a restricted shell),
// fall back to plain fs reads of .git metadata instead of silently marking every entry unavailable.
// Status semantics and persistence logic are otherwise unchanged.
import { statSync, readFileSync, existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { runGit } from './worktree.js'
import { getSetting, setSetting } from './ledger.js'

export const WORKSPACE_INDEX_KEY = 'workspace_repo_index'
export const INDEX_TITLE = '工作区与仓库索引'
export const workspaceIndexSavedKey = taskId => `workspace_index_saved:${taskId}`

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
  return text.includes('@') ? '[remote 已隐藏]' : text.split(/[?#]/)[0]
}

export function registeredWorkspaces(service) {
  const list = service?.list?.()
  if (!Array.isArray(list)) throw new Error('workspaceRegistry.list 不可用，请稍后重试')
  return list.filter(item => typeof item?.id === 'string' && typeof item?.path === 'string' && isAbsolute(item.path))
    .map(({ id, title, path }) => ({ id, title: typeof title === 'string' ? title : '', path }))
}

// ---------- FS_FALLBACK_PATCH_v1 起始 ----------
const fsTrim = v => (typeof v === 'string' ? v.trim() : '')
const fsIsDir = p => { try { return statSync(p).isDirectory() } catch { return false } }
const fsRead = p => { try { return readFileSync(p, 'utf8') } catch { return null } }

function gitDirOf(dir) {
  let cur = resolve(dir)
  for (;;) {
    const dotgit = resolve(cur, '.git')
    if (existsSync(dotgit)) {
      if (fsIsDir(dotgit)) return { gitdir: dotgit, worktree: false }
      const m = fsTrim(fsRead(dotgit) ?? '').match(/^gitdir:\s*(.+)$/m)
      if (m) return { gitdir: resolve(cur, m[1]), worktree: true }
    }
    const parent = resolve(cur, '..')
    if (parent === cur) return null
    cur = parent
  }
}

// 严格：.git 内必须有 HEAD 与 config，排除 C:\.git 空目录伪影。
function isRealRepo(gitdir) {
  return existsSync(resolve(gitdir, 'HEAD')) && existsSync(resolve(gitdir, 'config'))
}

function headOf(gitdir) {
  const head = fsTrim(fsRead(resolve(gitdir, 'HEAD')) ?? '')
  if (head === '') return {}
  if (head.startsWith('ref:')) {
    const ref = fsTrim(head.slice(4))
    const branch = ref.replace(/^refs\/heads\//, '')
    let sha = fsTrim(fsRead(resolve(gitdir, ...ref.split('/'))) ?? '')
    if (sha === '') {
      const packed = fsTrim(fsRead(resolve(gitdir, 'packed-refs')) ?? '')
      const line = packed.split(/\r?\n/).find(l => l && !l.startsWith('#') && !l.startsWith('^') && l.endsWith(` ${ref}`))
      sha = line ? line.split(' ')[0] : ''
    }
    return { branch, headSha: sha || null }
  }
  return { branch: 'HEAD', headSha: head.slice(0, 40) }
}

function originOf(gitdir) {
  const config = fsRead(resolve(gitdir, 'config')) ?? ''
  let inOrigin = false
  for (const line of config.split(/\r?\n/)) {
    const t = line.trim()
    if (/^\[remote\s+["'][^"']+["']\]$/.test(t)) { inOrigin = /["']origin["']/.test(t); continue }
    if (/^\[/.test(t)) { inOrigin = false; continue }
    if (inOrigin) { const m = t.match(/^url\s*=\s*(.+)$/); if (m) return redactRemote(m[1]) }
  }
  return null
}

function commonDirOf(gitdir) {
  const cd = fsTrim(fsRead(resolve(gitdir, 'commondir')) ?? '')
  return cd === '' ? gitdir : resolve(gitdir, cd)
}

/** 纯 fs 读一个工作区；返回与 git 路径同形的字段集，status 只可能是 git/not_git/unavailable。 */
function fromFs(workspace) {
  const found = gitDirOf(workspace.path)
  if (!found || !isRealRepo(found.gitdir)) return { status: 'not_git' }
  const { branch, headSha } = headOf(found.gitdir)
  return {
    status: 'git',
    repoRoot: resolve(found.gitdir, '..'),
    branch: branch ?? null,
    head: headSha,
    origin: originOf(found.gitdir),
    commonDir: commonDirOf(found.gitdir),
  }
}

/** 判定是否是「子进程根本起不来」的 spawn 错误（沙箱 EPERM / 缺 git 等）。 */
function isSpawnBlocked(result) {
  const code = result?.spawnError
  return code === 'EPERM' || code === 'EACCES' || code === 'ENOENT'
}
// ---------- FS_FALLBACK_PATCH_v1 结束 ----------

export async function scanWorkspaces(workspaces, { git = runGit, isDirectory = path => statSync(path).isDirectory() } = {}) {
  const entries = []
  for (const workspace of workspaces) {
    const entry = { ...workspace, sampledAt: new Date().toISOString(), status: 'unavailable' }
    entries.push(entry)
    try {
      if (!isDirectory(workspace.path)) continue
      const root = await git(['rev-parse', '--show-toplevel'], { cwd: workspace.path })
      if (!root.ok) {
        // FS_FALLBACK_PATCH_v1：子进程被沙箱拒绝时改走纯 fs，不再静默 unavailable。
        if (isSpawnBlocked(root)) {
          Object.assign(entry, fromFs(workspace))
          continue
        }
        entry.status = /not a git repository/i.test(root.stderr ?? '') ? 'not_git' : 'unavailable'
        continue
      }
      entry.status = 'git'
      entry.repoRoot = root.stdout.trim()
      // FS_FALLBACK_PATCH_v1：后续四查若 spawn 被拒，整体改用 fs 重算，避免半截数据。
      let blocked = false
      for (const [field, args] of [
        ['branch', ['branch', '--show-current']],
        ['head', ['rev-parse', '--verify', 'HEAD']],
        ['origin', ['config', '--get', 'remote.origin.url']],
        ['commonDir', ['rev-parse', '--path-format=absolute', '--git-common-dir']],
      ]) {
        const result = await git(args, { cwd: workspace.path })
        if (isSpawnBlocked(result)) { blocked = true; break }
        entry[field] = result.ok ? (field === 'origin' ? redactRemote(result.stdout) : result.stdout.trim()) : null
      }
      if (blocked) Object.assign(entry, fromFs(workspace))
    } catch { entry.status = 'unavailable' }
  }
  return { entries }
}

export function loadWorkspaceIndex(db) {
  try { return JSON.parse(getSetting(db, WORKSPACE_INDEX_KEY) ?? 'null') } catch { return null }
}

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
