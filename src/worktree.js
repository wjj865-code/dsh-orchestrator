// 子任务 worktree 隔离（P9）：宿主侧 git 能力 + 检出目录生命周期。
//
// 职责切分（docs/ARCHITECTURE.md「worktree 隔离」）：
// - 判定「要不要建 / 基线 / 分支名」在协调者，声明只有结构化两处（config.worktreePolicy + task_create.worktree*）；
// - 本模块只做「校验 + 执行」：探测仓库事实、建/删检出、写 `.git/info/exclude`、把 target 换算到检出目录；
// - 插件不读 AGENTS.md、不解析自然语言（v2：DSH 注入指引 → 协调者判断 → 插件执行）。
//
// 全部 git 调用走 execFile（参数数组、不经 shell），失败按 7 类落 `code`，让协调者能读懂原因。
import { execFile } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { setTaskWorktree } from './ledger.js'
import { WORKTREE_STATES, worktreeHasCap, worktreeStatesWith } from './worktree-facts.js'

/** 单条 git 命令的超时（宿主侧，探测/建树都在派发前，不能拖住派发）。 */
export const GIT_TIMEOUT_MS = 5000

/** 检出目录位置：`<repoRoot>/.agents/worktrees/<taskId>`（与平台默认一致，且在 target 之内）。 */
export const WORKTREES_DIR = join('.agents', 'worktrees')

/** 写进 `.git/info/exclude` 的条目：不污染用户被跟踪的 `.gitignore`。 */
export const EXCLUDE_ENTRY = '.agents/'

/**
 * 一行 exclude 内容是否等价于「忽略 `.agents/`」。
 *
 * 为什么不做 `content.includes('.agents/')`：用户仓库里常有 `.agents-notes/`、`.agentscache`
 * 这类近似名字，宽泛子串会把它们当成「已经忽略过」而漏写真正的那一行。这里只认**整行**等价写法
 * （`.agents`、`.agents/`、`/.agents/`、`.agents/**`），并容忍行尾空白、CRLF 与首行 BOM
 * （Windows 编辑器/复制粘贴常见）——但 `!.agents`（排除语法反例）不算已忽略。
 */
export function isAgentsExcludeLine(line) {
  const value = String(line ?? '').replace(/^\uFEFF/, '').trim()
  if (value === '' || value.startsWith('#') || value.startsWith('!')) return false
  const normalized = value.replace(/^\/+/, '').replace(/\/+$/, '')
  return normalized === '.agents' || normalized === '.agents/**'
}

/** 追加行沿用文件既有行尾（CRLF 文件继续 CRLF；空文件/纯 LF 用 LF），不混入另一种换行。 */
export function newlineOf(text) {
  if (text.includes('\r\n')) return '\r\n'
  if (text.includes('\n')) return '\n'
  if (text.includes('\r')) return '\r'
  return '\n'
}

const EXCLUDE_LINE_SPLIT = /\r\n|\r|\n/
const ENDS_WITH_NEWLINE = /(?:\r\n|\r|\n)$/

/** 失败分类（与 master-plan §4.5 一致）：协调者据此给用户可读解释。 */
export const WORKTREE_FAILURE_TEXT = Object.freeze({
  NOT_A_REPO: '目标目录不是 git 仓库',
  BASE_NOT_FOUND: '基线分支/提交不存在',
  BRANCH_INVALID: '分支名不合法（git check-ref-format 不通过）',
  BRANCH_EXISTS: '分支已存在（不自动改名）',
  PATH_EXISTS: '检出目录已存在',
  GIT_MISSING: '宿主没有可用的 git（不在 PATH 或不可执行）',
  FAILED: 'git 命令失败',
})

export const failureText = code => WORKTREE_FAILURE_TEXT[code] ?? WORKTREE_FAILURE_TEXT.FAILED

const failure = (code, message, extra = {}) => ({
  ok: false,
  code,
  message: message ?? failureText(code),
  ...extra,
})

const trim = value => (typeof value === 'string' ? value.trim() : '')

/**
 * 跑一条 git 命令，永不抛：把「git 缺失 / 超时 / 非零退出」都归一成同一形状。
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string, exitCode: number|null, spawnError: string|null, killed: boolean}>}
 */
export function runGit(args, { cwd, signal, timeout = GIT_TIMEOUT_MS } = {}) {
  return new Promise(done => {
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      done(value)
    }
    const base = { stdout: '', stderr: '', exitCode: null, spawnError: null, killed: false }
    try {
      execFile('git', args, { cwd, signal, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
        const output = { ...base, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }
        if (error === null || error === undefined) {
          finish({ ...output, ok: true, exitCode: 0 })
          return
        }
        finish({
          ...output,
          ok: false,
          exitCode: typeof error.code === 'number' ? error.code : null,
          // ENOENT/EACCES 这类「根本没跑起来」的 spawn 错误是字符串 code；退出码是数字。
          spawnError: typeof error.code === 'string' ? error.code : null,
          killed: error.killed === true,
        })
      })
    } catch (error) {
      finish({ ok: false, ...base, spawnError: error?.code ?? 'EPERM' })
    }
  })
}

/**
 * 把一次 git 失败映射成 7 类里的一个。顺序重要：分支已存在 / 路径已存在都以 ``already exists``
 * 出现，先判分支再判路径，否则 BRANCH_EXISTS 会被误报成 PATH_EXISTS。
 */
export function classifyGitFailure(result) {
  if (result?.spawnError === 'ENOENT') return failure('GIT_MISSING', '宿主没装 git（或不在 PATH）')
  if (result?.spawnError !== null && result?.spawnError !== undefined) {
    return failure('FAILED', `git 无法启动：${result.spawnError}`)
  }
  if (result?.killed === true) return failure('FAILED', `git 超时（${GIT_TIMEOUT_MS}ms）`)
  const text = `${result?.stderr ?? ''}\n${result?.stdout ?? ''}`
  if (/not a git repository/i.test(text)) return failure('NOT_A_REPO')
  if (/a branch named .* already exists|branch named .* already exists/i.test(text)) {
    return failure('BRANCH_EXISTS', '分支已存在（不静默改名：换名或改用 worktreeMode="continue" 复用）')
  }
  if (/is already checked out at/i.test(text)) {
    return failure('FAILED', '基线分支已在别的工作树检出（应以 -b 新分支为基线）')
  }
  if (/already exists and is not an empty directory|already exists/i.test(text)) return failure('PATH_EXISTS')
  if (/invalid reference|unknown revision|not a valid object name|ambiguous argument|Needed a single revision|bad revision/i.test(text)) {
    return failure('BASE_NOT_FOUND')
  }
  if (/invalid branch name|not a valid branch name|not a valid ref name/i.test(text)) return failure('BRANCH_INVALID')
  const detail = trim(result?.stderr) || trim(result?.stdout)
  return failure('FAILED', detail === '' ? failureText('FAILED') : detail.slice(0, 300))
}

/** 校验分支名（本地同步版，纯词法；最终仍以 git check-ref-format 为准）。 */
export function branchNameLooksValid(name) {
  if (typeof name !== 'string') return false
  const value = name.trim()
  if (value === '' || value !== name) return false
  if (/[\s~^:?*[\\]/.test(value)) return false
  if (value.startsWith('-') || value.startsWith('/') || value.endsWith('/') || value.endsWith('.')) return false
  if (value.includes('..') || value.includes('//') || value.includes('@{')) return false
  if (value.endsWith('.lock')) return false
  if (value === '@') return false
  return true
}

/** 检出目录绝对路径（只用 taskId，分支名不进路径：不受盘符/长路径影响）。 */
export const checkoutPathFor = (repoRoot, taskId) => join(String(repoRoot), WORKTREES_DIR, String(taskId))

/**
 * 把「用户 target 相对仓库根的偏移」算出来：worktree 任务的子会话 cwd = 检出目录 + 同偏移。
 * target 在仓库外（或没有 target）时返回 ''（子会话直接在检出目录里跑）。
 */
export function targetOffset(repoRoot, target) {
  const from = trim(repoRoot)
  const to = trim(target)
  if (from === '' || to === '') return ''
  const rel = relative(resolve(from), resolve(to))
  if (rel === '') return ''
  if (rel.startsWith('..') || isAbsolute(rel)) return ''
  return rel
}

/** 检出目录 + 偏移 → 子会话目标目录（偏移为空就是检出目录本身）。 */
export function targetInCheckout(checkout, offset) {
  const base = trim(checkout)
  if (base === '') return ''
  const tail = trim(offset)
  return tail === '' ? base : join(base, tail)
}

const exists = path => {
  try {
    return statSync(path) !== undefined
  } catch {
    return false
  }
}

/**
 * git 能力服务。`exec` 可注入（测试用 fake，不碰真 git）。
 * 所有方法都返回普通对象，不抛。
 */
export function createWorktreeService({ exec = runGit, now = Date.now, recentDays = 7, log = () => {} } = {}) {
  const run = (args, options) => exec(args, options)

  const resolveDefaultBranch = async (repoRoot, signal) => {
    const symbolic = await run(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: repoRoot, signal })
    if (symbolic.ok) {
      const value = trim(symbolic.stdout)
      if (value !== '') return value.replace(/^origin\//, '')
    }
    const current = await run(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoRoot, signal })
    const value = current.ok ? trim(current.stdout) : ''
    return value !== '' && value !== 'HEAD' ? value : 'main'
  }

  /** 近 N 天 tip commit 的本地分支（按 committerdate 倒序）；n 是全量计数，返回最多 5 条。 */
  const recentBranches = async (repoRoot, { signal, days = recentDays } = {}) => {
    const out = await run(['for-each-ref', '--sort=-committerdate',
      '--format=%(refname:short)%00%(committerdate:unix)%00%(subject)', 'refs/heads'], { cwd: repoRoot, signal })
    if (!out.ok) return { ok: false, code: classifyGitFailure(out).code, branches: [], n: 0 }
    const since = Math.floor(now() / 1000) - Math.max(1, days) * 86400
    const branches = []
    for (const line of out.stdout.split('\n')) {
      if (line.trim() === '') continue
      const [name, seconds, subject] = line.split('\0')
      const committed = Number.parseInt(seconds, 10)
      if (!Number.isFinite(committed) || committed < since) continue
      branches.push({ name: trim(name), committerdate: committed, subject: trim(subject).slice(0, 120) })
    }
    return { ok: true, branches, n: branches.length }
  }

  /**
   * 仓库事实（只在 worktree:true / worktreeMode:'continue' 时探测；普通任务一次 git 都不调）。
   * @returns {Promise<object>} isRepo=false 时只有 {isRepo, reason, message}
   */
  const probeRepo = async (dir, { signal } = {}) => {
    const start = trim(dir)
    if (start === '') return { isRepo: false, reason: 'NOT_A_REPO', message: '没有可探测的目标目录' }
    const top = await run(['rev-parse', '--show-toplevel'], { cwd: start, signal })
    if (!top.ok) {
      const classified = classifyGitFailure(top)
      return { isRepo: false, reason: classified.code, message: classified.message }
    }
    const repoRoot = trim(top.stdout)
    if (repoRoot === '') return { isRepo: false, reason: 'NOT_A_REPO', message: failureText('NOT_A_REPO') }
    const head = await run(['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, signal })
    const defaultBranch = await resolveDefaultBranch(repoRoot, signal)
    const recent = await recentBranches(repoRoot, { signal })
    const n = recent.n ?? 0
    const candidates = (recent.branches ?? []).slice(0, 5)
    return {
      isRepo: true,
      repoRoot,
      head: head.ok ? trim(head.stdout) : null,
      defaultBranch,
      n,
      recentBranches: candidates,
      // n=0 → 用默认分支；n=1 → 直接用那条；n≥2 → 交给协调者 ask_user_question（不落库）。
      suggestedBase: n === 1 ? candidates[0]?.name : (n === 0 ? defaultBranch : undefined),
      needsBranchChoice: n >= 2,
    }
  }

  const checkBranchName = async (repoRoot, name) => {
    const out = await run(['check-ref-format', '--branch', String(name)], { cwd: repoRoot })
    return out.ok ? { ok: true } : classifyGitFailure(out)
  }

  const branchExists = async (repoRoot, name) => {
    const out = await run(['show-ref', '--verify', '--quiet', `refs/heads/${String(name)}`], { cwd: repoRoot })
    return out.ok
  }

  const refExists = async (repoRoot, ref) => {
    if (typeof ref !== 'string' || ref.trim() === '') return false
    const out = await run(['rev-parse', '--verify', '--quiet', `${ref.trim()}^{commit}`], { cwd: repoRoot })
    return out.ok
  }

  /**
   * 建检出：`git worktree add -b <branch> <path> <base>`。
   * 「以某分支为基线」必须配 -b 新分支——直接检出已检出的基线会被 git 拒绝（§4.4.3）。
   */
  const create = async ({ repoRoot, path, branch, base = 'default', signal } = {}) => {
    const root = trim(repoRoot)
    const checkout = trim(path)
    const name = trim(branch)
    if (root === '') return failure('NOT_A_REPO', '缺少源仓库根')
    if (checkout === '') return failure('FAILED', '缺少检出目录')
    if (name === '') return failure('BRANCH_INVALID', '缺少分支名')
    if (exists(checkout)) return failure('PATH_EXISTS', `检出目录已存在：${checkout}`)
    const nameCheck = await checkBranchName(root, name)
    if (!nameCheck.ok) {
      return nameCheck.code === 'BRANCH_INVALID' ? { ...nameCheck, message: `分支名不合法：${name}` } : nameCheck
    }
    if (await branchExists(root, name)) {
      return failure('BRANCH_EXISTS', `分支已存在：${name}（不自动改名：换名或改用 worktreeMode="continue"）`)
    }
    const baseRef = trim(base) === '' || base === 'default' ? await resolveDefaultBranch(root, signal) : String(base).trim()
    if (!(await refExists(root, baseRef))) {
      return failure('BASE_NOT_FOUND', `基线不存在：${baseRef}`)
    }
    try {
      mkdirSync(dirname(checkout), { recursive: true })
    } catch (error) {
      return failure('FAILED', `创建检出父目录失败：${error?.message ?? error}`)
    }
    const added = await run(['worktree', 'add', '-b', name, checkout, baseRef], { cwd: root, signal })
    if (!added.ok) return classifyGitFailure(added)
    log('worktree.created', { repoRoot: root, detail: { path: checkout, branch: name, base: baseRef } })
    const commit = await run(['rev-parse', '--short', `${baseRef}^{commit}`], { cwd: root, signal })
    return { ok: true, path: checkout, branch: name, base: baseRef, baseCommit: commit.ok ? trim(commit.stdout) : null }
  }

  /** 分支上有多少提交没进默认分支（`full` 档要提醒用户别丢未合并提交）。 */
  const unmergedCount = async (repoRoot, branch, { signal } = {}) => {
    const defaultBranch = await resolveDefaultBranch(repoRoot, signal)
    const out = await run(['rev-list', '--count', `${defaultBranch}..${branch}`], { cwd: repoRoot, signal })
    const count = Number.parseInt(trim(out.ok ? out.stdout : ''), 10)
    return Number.isFinite(count) ? count : 0
  }

  /**
   * 清理三档：`checkout-only` 只删检出（分支保留，推荐）；`full` 连分支一起删。
   * `full` 遇到未合并提交且没有显式确认时**保留分支**并返回提示（不静默丢提交）。
   */
  const remove = async ({ repoRoot, path, branch, mode = 'checkout-only', confirm = false, signal } = {}) => {
    if (mode === 'off') return { ok: true, skipped: true }
    const root = trim(repoRoot)
    const checkout = trim(path)
    const name = trim(branch)
    if (root === '') return failure('NOT_A_REPO', '缺少源仓库根（台账 repo_root 为空）')
    if (checkout === '') return { ok: true, skipped: true, reason: 'no-checkout' }
    if (exists(checkout)) {
      const dirty = await run(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored'], { cwd: checkout, signal })
      if (!dirty.ok || dirty.stdout.trim() !== '') return failure('UNARCHIVED', '检出存在未归档内容或无法核验，已保留检出')
    }
    if (mode === 'full' && name !== '') {
      const base = await resolveDefaultBranch(root, signal)
      const merged = await run(['merge-base', '--is-ancestor', name, base], { cwd: root, signal })
      if (!merged.ok) return failure('UNARCHIVED', '分支尚未合并或无法核验，已保留检出和分支')
    }
    const removed = await run(['worktree', 'remove', '--force', checkout], { cwd: root, signal })
    await run(['worktree', 'prune'], { cwd: root, signal })
    if (!removed.ok) {
      const classified = classifyGitFailure(removed)
      // 目录本来就不在了：按已清理处理（幂等），不把它当失败。
      if (!exists(checkout)) return { ok: true, checkout: true, branch: false, alreadyGone: true }
      return classified
    }
    if (mode !== 'full' || name === '') return { ok: true, checkout: true, branch: false }
    const unmerged = await unmergedCount(root, name, { signal })
    if (unmerged > 0 && confirm !== true) {
      return {
        ok: true,
        checkout: true,
        branch: false,
        unmerged,
        hint: `分支 ${name} 有 ${unmerged} 个未合并提交，按未确认处理：只删检出，分支保留。`,
      }
    }
    const deleted = await run(['branch', '-D', name], { cwd: root, signal })
    if (!deleted.ok) {
      return { ok: true, checkout: true, branch: false, unmerged, hint: `检出已删，分支 ${name} 删除失败：${classifyGitFailure(deleted).message}` }
    }
    log('worktree.removed', { repoRoot: root, detail: { path: checkout, branch: name, mode, unmerged } })
    return { ok: true, checkout: true, branch: true, unmerged }
  }

  /**
   * 幂等确保 `.git/info/exclude` 含一行 `.agents/`（方案 A：插件使用者的新克隆也不再看到
   * `.agents/worktrees` 这些未跟踪文件）。
   *
   * 口径（都是硬约束）：
   * - **只检查 + 必要追加**，绝不重写整个文件：原有条目逐行保留，行尾风格跟着文件走（CRLF 保持 CRLF）；
   * - 末行没有换行时先补一个换行再追加，避免把两行粘成一行；
   * - 已有等效行（见 `isAgentsExcludeLine`）就什么都不写，连跑 N 次只有一行；
   * - `git rev-parse --git-path` 拿到的路径可能是相对 cwd 的（`.git/info/exclude`），也可能是
   *   链接检出/子模块下的绝对路径，统一 `resolve(root, …)`；
   * - **失败不抛**：只读仓库、权限不足、文件被占用、路径是目录……都归一成 `{ok:false, reason}`，
   *   由调用方降级成告警（写不了 exclude 绝不能挡住建树）。
   *
   * @returns {Promise<{ok: boolean, added?: boolean, path?: string, reason?: string, message?: string}>}
   */
  const ensureExcluded = async (repoRoot, { signal } = {}) => {
    const root = trim(repoRoot)
    if (root === '') return { ok: false, reason: 'NOT_A_REPO' }
    const gitPath = await run(['rev-parse', '--git-path', 'info/exclude'], { cwd: root, signal })
    if (!gitPath.ok) return { ok: false, reason: classifyGitFailure(gitPath).code }
    const relativePath = trim(gitPath.stdout)
    if (relativePath === '') return { ok: false, reason: 'EXCLUDE_UNWRITABLE', message: 'git 没给出 info/exclude 路径' }
    const file = resolve(root, relativePath)
    let current = ''
    try {
      current = readFileSync(file, 'utf8')
    } catch (error) {
      // 文件不存在是正常情况（有些仓库没有 info/exclude），按空文件处理；其余（EACCES/EISDIR/EPERM…）是降级信号。
      if (error?.code !== 'ENOENT') return { ok: false, reason: 'EXCLUDE_UNWRITABLE', message: error?.message ?? String(error) }
    }
    if (current.split(EXCLUDE_LINE_SPLIT).some(isAgentsExcludeLine)) return { ok: true, added: false, path: file }
    const eol = newlineOf(current)
    const leading = current === '' || ENDS_WITH_NEWLINE.test(current) ? '' : eol
    try {
      mkdirSync(dirname(file), { recursive: true })
      appendFileSync(file, `${leading}${EXCLUDE_ENTRY}${eol}`)
    } catch (error) {
      return { ok: false, reason: 'EXCLUDE_UNWRITABLE', message: error?.message ?? String(error) }
    }
    return { ok: true, added: true, path: file }
  }

  return {
    run,
    probeRepo,
    recentBranches,
    resolveDefaultBranch,
    checkBranchName,
    branchExists,
    refExists,
    create,
    remove,
    unmergedCount,
    ensureExcluded,
    checkoutPathFor,
    targetOffset,
    targetInCheckout,
  }
}

/** 默认（真实）服务：宿主 execFile。 */
export const defaultWorktreeService = createWorktreeService()

/** 台账里「要不要走派发前准备」的状态：`requested`（真建检出）+ `reused`（只换算 target_dir）。
 *  与 write-guard 的隔离判定同源（worktree-request.js 的 WORKTREE_STATE_CAPS）：
 *  `needsCreate` 给出 requested，`reused` 单独加——它不需要建树，但需要把 cwd 换算进检出目录。
 *  `created` 不在这里：派发期它已经是建好的状态，再走一遍会重复建树。 */
export const WORKTREE_DISPATCH_STATES = Object.freeze([
  ...worktreeStatesWith('needsCreate'),
  ...WORKTREE_STATES.filter(state => state === 'reused'),
])

/**
 * 重派时的隔离快照（§4.7）：原台账有检出且目录还在 → 复用（不新建）；
 * 检出被清理/目录不见了 → 按原基线重建（派发时建）。普通任务返回 null（零变化）。
 */
export function retryWorktreeOf(task) {
  if (!worktreeHasCap(task?.worktree_state, 'retryable')) return null
  const checkout = trim(task.worktree_path)
  const root = trim(task.repo_root)
  if (checkout === '' && root === '') return null
  if (checkout !== '' && task.worktree_state !== 'cleaned' && exists(checkout)) {
    return {
      path: checkout,
      branch: task.worktree_branch ?? null,
      repoRoot: root === '' ? null : root,
      base: task.worktree_base ?? null,
      mode: 'new',
      source: task.worktree_source ?? 'task',
      state: 'reused',
    }
  }
  return {
    path: null,
    // 沿用台账原分支名重建：名字由协调者按 <type>/<slug> 取过，重派不再由插件另起一个名字
    // （分支还在时派发期会 BRANCH_EXISTS，换名或改 worktreeMode:'continue' 由协调者决定）。
    branch: task.worktree_branch ?? null,
    repoRoot: root === '' ? null : root,
    base: task.worktree_base ?? null,
    mode: 'new',
    source: task.worktree_source ?? 'task',
    state: 'requested',
  }
}

/**
 * 派发前准备（queue.pump 在 spawn 之前调用）：
 * - `requested` → **先幂等写 exclude**（`.agents/` → `.git/info/exclude`，写不动只 warn），再真建检出
 *   （分支 + `<repo>/.agents/worktrees/<taskId>`），把 target_dir 换成
 *   「检出目录 + 原 target 相对 repoRoot 的偏移」，返回的 cwd 就是子会话的工作目录；
 * - `reused` → 只换算 target_dir，不调任何 git；
 * - 失败不静默降级：状态落 `failed`，调用方把任务标失败并写明原因。
 *
 * @returns {Promise<{ok: boolean, cwd?: string, state?: string, failure?: object}>}
 */
export async function prepareTaskWorktree({ db, task, service, log = () => {} } = {}) {
  const state = task?.worktree_state
  if (!WORKTREE_DISPATCH_STATES.includes(state)) {
    return { ok: true, cwd: task?.target_dir ?? undefined, state: state ?? 'none' }
  }
  const root = trim(task.repo_root)
  const offset = targetOffset(root, task.brief?.target ?? task.target_dir)
  if (state === 'reused') {
    const cwd = targetInCheckout(task.worktree_path, offset)
    if (cwd !== '' && cwd !== task.target_dir) setTaskWorktree(db, task.id, { targetDir: cwd })
    log('worktree.reused', { taskId: task.id, detail: { path: task.worktree_path ?? null, branch: task.worktree_branch ?? null } })
    return { ok: true, cwd: cwd === '' ? (task.target_dir ?? undefined) : cwd, state: 'reused', branch: task.worktree_branch, path: task.worktree_path }
  }
  const checkout = trim(task.worktree_path) || checkoutPathFor(root, task.id)
  // legacy 兜底：只服务 0.34 及更早台账里 branch 为空的行（新任务创建期已强制 <type>/<slug>）。
  const branch = trim(task.worktree_branch) || `orch/${task.id}`
  // 方案 A：**建树之前**就幂等确保 `<repo>/.git/info/exclude` 里有 `.agents/`。
  // 为什么放在前面：`create()` 会先建出 `.agents/worktrees` 父目录，再跑 `git worktree add`；
  // 建树失败（分支已存在/基线不存在/检出已存在）时父目录已经留在仓库里——先把 exclude 写好，
  // 插件使用者（没有本机全局 ignore 的人）才不会在 `git status` 里看到这堆未跟踪目录。
  // 写失败只降级成告警（只读仓库/权限不足/文件被占用），绝不阻断建树。
  let excluded = { ok: true, added: false }
  if (root !== '') {
    try {
      excluded = await service.ensureExcluded(root)
    } catch (error) {
      excluded = { ok: false, reason: 'EXCLUDE_UNWRITABLE', message: error?.message ?? String(error) }
    }
    if (excluded.ok !== true) {
      log('worktree.exclude-failed', { taskId: task.id, detail: { reason: excluded.reason ?? null, message: excluded.message ?? null } })
    }
  }
  const created = await service.create({
    repoRoot: root,
    path: checkout,
    branch,
    base: trim(task.worktree_base) || 'default',
  })
  if (created.ok !== true) {
    setTaskWorktree(db, task.id, { state: 'failed' })
    log('worktree.failed', { taskId: task.id, detail: { code: created.code ?? 'FAILED', message: created.message ?? null } })
    return { ok: false, state: 'failed', failure: created }
  }
  const cwd = targetInCheckout(created.path, offset) || created.path
  try {
    if (cwd !== created.path) mkdirSync(cwd, { recursive: true })
  } catch { /* 偏移目录建不出来就用检出根，不让它挡派发 */ }
  setTaskWorktree(db, task.id, {
    state: 'created',
    path: created.path,
    branch: created.branch,
    base: created.base,
    targetDir: cwd,
  })
  log('worktree.prepared', {
    taskId: task.id,
    detail: { path: created.path, branch: created.branch, base: created.base, baseCommit: created.baseCommit ?? null, cwd, excluded: excluded.ok === true ? excluded.added === true : false },
  })
  return { ok: true, cwd, state: 'created', branch: created.branch, path: created.path, base: created.base }
}

/**
 * 终态清理（三档，默认 off 什么都不做）。只清台账里有记录的那份检出；失败只记日志，不影响任务终态。
 * `full` 档传 confirm=true：`worktreeCleanup:'full'` 本身就是协调者/用户的显式选择。
 */
export async function cleanupTaskWorktree({ db, task, service, log = () => {} } = {}) {
  if (task?.delivery_pending || task?.artifact_stage?.complete === false) {
    log('worktree.cleanup-deferred', { taskId: task.id, detail: { reason: 'artifacts-pending-or-incomplete' } })
    return { ok: false, code: 'ARTIFACTS_INCOMPLETE' }
  }
  const mode = task?.brief?.worktreeCleanup
  if (mode !== 'checkout-only' && mode !== 'full') return { ok: true, skipped: true }
  // 清理前置：只有「有检出」的状态才谈得上清（created/reused；cleaned 已经清过了，幂等跳过）。
  if (!worktreeHasCap(task.worktree_state, 'hasCheckout') || task.worktree_state === 'cleaned'
    || trim(task.worktree_path) === '') {
    return { ok: true, skipped: true }
  }
  let result
  try {
    result = await service.remove({
      repoRoot: task.repo_root,
      path: task.worktree_path,
      branch: mode === 'full' ? task.worktree_branch : undefined,
      mode,
      confirm: mode === 'full',
    })
  } catch (error) {
    result = { ok: false, code: 'FAILED', message: error?.message ?? String(error) }
  }
  if (result?.ok === true) {
    setTaskWorktree(db, task.id, { state: 'cleaned' })
    log('worktree.cleaned', {
      taskId: task.id,
      detail: { path: task.worktree_path, branch: task.worktree_branch ?? null, mode, branchDeleted: result.branch === true, unmerged: result.unmerged ?? 0, hint: result.hint ?? null },
    })
  } else {
    log('worktree.cleanup-failed', {
      taskId: task.id,
      detail: { path: task.worktree_path, mode, reason: result?.code ?? null, message: result?.message ?? null },
    })
  }
  return result ?? { ok: false }
}
