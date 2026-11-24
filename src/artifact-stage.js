// 一个阶段一次保存：工作文件候选 != 用户显式交付文档；Git 不复制代码。
import { constants, closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { runGit } from './worktree.js'
import { collectWorkspaceArtifacts, changedEventsOf } from './artifact-collect.js'
import { ensureArtifactDirectory, secureDirectory } from './artifact-store.js'
import { isInside } from './artifact-location.js'
import { getTask, MAX_TASK_ARTIFACTS, setTaskArtifactStage } from './ledger.js'

export async function inspectGit(cwd, run = runGit) {
  const repo = await run(['rev-parse', '--show-toplevel'], { cwd })
  if (!repo.ok) return { mode: !repo.spawnError && /not a git repository/i.test(repo.stderr ?? '') ? 'non-git' : 'unknown', unarchived: true }
  const root = repo.stdout.trim()
  const head = await run(['rev-parse', 'HEAD'], { cwd })
  const branch = await run(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd })
  // 不要 `--ignored`：manifest 只记人写的代码，`node_modules/`、`.pnpm/`、`dist/` 这类被 ignore 的
  // 路径既不该进 `changes`，也不该把「只有 ignore 文件在工作」的仓库标成未归档。
  const status = await run(['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd })
  return {
    mode: 'git', root, head: head.ok ? head.stdout.trim() : null,
    branch: branch.ok ? branch.stdout.trim() : null,
    checked: status.ok && head.ok,
    unarchived: !status.ok || !head.ok || status.stdout.length > 0,
    changes: status.ok ? status.stdout.split('\0').filter(Boolean) : [],
  }
}

// 一次问一批候选；批量上限只是防命令行过长，50 条远低于任何平台的 argv 上限。
const LIST_BATCH = 50

/**
 * 批量问 git「这些路径里哪些是 Git 视野内的」——即 tracked 或「未跟踪且未被 ignore」。
 *
 * 为什么不用 `git status --ignored`：那会把整个 ignore 树都吐出来（正是本次要修的问题）。
 * 为什么不用 `git check-ignore`：它要 `-z`（安全解析特殊字符）就必须 `--stdin`，而 `runGit`
 * 没有 stdin 面；`ls-files --cached --others --exclude-standard` 一次就能给出精确 keep 集合，
 * `-z` 直接可用，而且用 `:(literal)` 关掉 pathspec 的通配语义。
 *
 * @returns {Promise<{listed: Set<string>, verified: boolean}>} 值为 repo 根相对、`/` 分隔的路径
 */
async function keptPaths({ root, rels, run }) {
  const listed = new Set()
  let verified = true
  for (let index = 0; index < rels.length; index += LIST_BATCH) {
    const result = await run(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--',
      ...rels.slice(index, index + LIST_BATCH).map(rel => `:(literal)${rel}`)], { cwd: root })
    if (!result.ok) {
      // 核验不了就如实标出来（见 excludedGitCandidates）：不假装过滤过。
      verified = false
      continue
    }
    for (const path of String(result.stdout ?? '').split('\0')) if (path !== '') listed.add(path)
  }
  return { listed, verified }
}

/**
 * Git 模式的候选过滤：`files[]` 只留 tracked 与「未跟踪且未被 ignore」的路径。
 * `.git` 内、repo 外、被 ignore 的候选一律排除，原因（`inside-git-dir` / `outside-repo` /
 * `ignored` / `missing-or-deleted`）随 `stage.excluded` 落盘——能看出为什么没进清单，
 * 也不把噪声塞进 `files[]`。
 *
 * 非 Git / unknown 分支不调用这里，行为保持原样。
 */
async function excludedGitCandidates({ git, candidates, run }) {
  const excluded = new Map()
  if (git.root === '') return excluded
  const repoRoot = resolve(git.root)
  const relById = new Map()
  for (const source of candidates.keys()) {
    const absolute = resolve(source)
    if (!isInside(repoRoot, absolute)) { excluded.set(absolute, 'outside-repo'); continue }
    const rel = relative(repoRoot, absolute).split(sep).join('/')
    if (rel === '.git' || rel.startsWith('.git/')) { excluded.set(absolute, 'inside-git-dir'); continue }
    relById.set(absolute, rel)
  }
  if (relById.size === 0) return excluded
  const { listed, verified } = await keptPaths({ root: repoRoot, rels: [...new Set(relById.values())], run })
  if (!verified) {
    git.ignoreProbe = 'failed'
    return excluded
  }
  const list = [...listed]
  for (const [absolute, rel] of relById) {
    // 目录候选：git 列的是它下面的文件，前缀命中同样算「在 Git 视野里」。
    if (listed.has(rel) || list.some(path => path.startsWith(`${rel}/`))) continue
    // 不在 Git 视野里：文件还在就是被 ignore（tracked 不会走到这里），否则已经不在工作区。
    excluded.set(absolute, existsSync(absolute) ? 'ignored' : 'missing-or-deleted')
  }
  return excluded
}

function copyOrdinaryFile(cwd, source, destination, storeRoot) {
  const rawRoot = resolve(cwd)
  if (!isInside(rawRoot, source)) throw new Error('outside-workspace')
  // 检查父路径及文件本身，不借软链接扩大宿主读取面。
  for (let cursor = source; cursor !== rawRoot; cursor = dirname(cursor)) {
    if (lstatSync(cursor).isSymbolicLink()) throw new Error('symlink')
  }
  if (!isInside(realpathSync(rawRoot), realpathSync(source))) throw new Error('outside-workspace')
  const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = fstatSync(fd)
    if (!before.isFile()) throw new Error('not-file')
    secureDirectory(storeRoot, dirname(destination))
    const output = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try {
      // 流式复制，文件大小不受内存上限影响。
      const buffer = Buffer.alloc(64 * 1024)
      let read
      // 同步 I/O 保持每个文件复制期间本插件不会让出给另一任务。
      while ((read = readFileChunk(fd, buffer)) > 0) writeFileSync(output, buffer.subarray(0, read))
    } finally { closeSync(output) }
    const after = fstatSync(fd)
    const current = lstatSync(source)
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== current.ino || before.mtimeMs !== current.mtimeMs) return 'unstable'
    return 'saved'
  } finally { closeSync(fd) }
}

const readFileChunk = (fd, buffer) => readSync(fd, buffer, 0, buffer.length, null)

export async function collectArtifactStage({
  db, task, cwd, mainDir, session, workspaceChanges, changedFiles = [], artifacts = [],
  key, eventSeq, artifactsOmitted = 0, interrupted = false, run = runGit,
} = {}) {
  const root = ensureArtifactDirectory(db, task, mainDir)
  const id = createHash('sha256').update(String(key ?? `${task.attempts ?? 0}:${Date.now()}`)).digest('hex').slice(0, 24)
  const snapshots = secureDirectory(root, join(root, 'snapshots'))
  const finalDir = join(snapshots, id)
  const manifestPath = join(finalDir, 'manifest.json')
  const register = stage => {
    const current = getTask(db, task.id).artifacts
    // 始终保留本阶段清单，超过面板容量的文件仍在清单里完整可追溯。
    const incoming = [{ path: stage.path, label: stage.complete ? '阶段快照' : '阶段快照（不完整）', exists: true }, ...stage.artifacts]
    const byPath = new Map([...incoming, ...current].map(a => [a.path, a]))
    db.prepare('UPDATE tasks SET artifacts_json = ? WHERE id = ?').run(JSON.stringify([...byPath.values()].slice(0, MAX_TASK_ARTIFACTS)), task.id)
    setTaskArtifactStage(db, task.id, stage)
    return stage
  }
  if (existsSync(manifestPath)) {
    secureDirectory(root, finalDir)
    if (lstatSync(manifestPath).isSymbolicLink()) throw new Error('unsafe-manifest')
    return register(JSON.parse(readFileSync(manifestPath, 'utf8')))
  }
  const temp = secureDirectory(root, join(snapshots, `${id}.${Date.now()}.pending`))
  const auto = collectWorkspaceArtifacts({ session, workspaceChanges, fallbackCwd: cwd })
  const events = changedEventsOf(session)
  const required = Number.isFinite(eventSeq) ? eventSeq : events.at(-1)?.seq
  const missingSummarySeqs = []
  for (const seq of new Set([...events.map(event => event.seq), ...(Number.isFinite(required) ? [required] : [])])) {
    try {
      if (!workspaceChanges?.summary?.(session?.id, seq)) missingSummarySeqs.push(seq)
    } catch { missingSummarySeqs.push(seq) }
  }
  const available = Number.isFinite(required) && auto.turns > 0 && missingSummarySeqs.length === 0
  const git = await inspectGit(cwd, run)
  if (task.status === 'running' && getTask(db, task.id)?.status !== 'running') interrupted = true
  const stage = {
    taskId: task.id, title: task.title, attempt: task.attempts ?? 0, key, cwd,
    createdAt: Date.now(), mode: git.mode, git, interrupted,
    protection: task.access === 'full' ? 'unprotected-full-access' : 'private-store',
    complete: !interrupted && git.mode !== 'unknown' && (git.mode !== 'git' || git.checked === true), coverage: available ? 'host-captured' : 'explicit-only',
    omitted: auto.omitted, documentsOmitted: artifactsOmitted, eventSeq: required ?? null,
    missingSummarySeqs, files: [], artifacts: [], path: manifestPath,
  }
  if ((git.mode !== 'git' && !available) || auto.omitted > 0 || artifactsOmitted > 0) stage.complete = false
  const candidates = new Map()
  for (const a of auto.artifacts) candidates.set(resolve(a.path), 'host')
  for (const path of changedFiles) if (typeof path === 'string' && path.trim()) candidates.set(resolve(cwd, path), 'explicit')
  // 产物库里的文件不是工作文件候选：先剔掉，再只为真正的工作文件问一次 ignore。
  const workCandidates = [...candidates].filter(([source]) =>
    !isInside(root, source) && !(task.artifact_dir && isInside(task.artifact_dir, source)))
  const excluded = git.mode === 'git' && workCandidates.length > 0
    ? await excludedGitCandidates({ git, candidates: new Map(workCandidates), run })
    : new Map()
  for (const [source, origin] of workCandidates) {
    const reason = excluded.get(source)
    if (reason !== undefined) {
      stage.excluded ??= []
      stage.excluded.push({ source, origin, reason })
      continue
    }
    const record = { source, origin, path: null, status: 'git-reference' }
    stage.files.push(record)
    if (git.mode === 'git') continue
    if (git.mode === 'unknown') { record.status = 'unknown'; continue }
    try {
      const rel = relative(resolve(cwd), source)
      if (!isInside(resolve(cwd), source)) throw new Error('outside-workspace')
      const target = join(temp, 'files', rel)
      record.status = copyOrdinaryFile(cwd, source, target, root)
      record.path = join(finalDir, relative(temp, target))
      if (record.status === 'saved') stage.artifacts.push({ path: record.path, label: basename(source), exists: true })
      else stage.complete = false
    } catch (error) {
      record.status = error.code === 'ENOENT' ? 'missing-or-deleted' : 'rejected'
      record.reason = error.code ?? error.message
      stage.complete = false
    }
  }
  for (const artifact of artifacts) {
    const source = resolve(cwd, artifact.path)
    try {
      if (isInside(root, source)) {
        if (!isInside(join(root, 'docs'), source)) throw new Error('not-document')
        copyValidation(root, source)
        stage.artifacts.push({ ...artifact, path: source, exists: true })
        continue
      }
      if (task.artifact_dir && isInside(task.artifact_dir, source)) {
        copyValidation(task.artifact_dir, source)
        const imported = secureDirectory(root, join(root, 'docs', id))
        const dest = join(imported, `${stage.artifacts.length}-${basename(source)}`)
        if (copyOrdinaryFile(task.artifact_dir, source, dest, root) !== 'saved') throw new Error('unstable')
        stage.artifacts.push({ ...artifact, path: dest, exists: true })
        continue
      }
      const imported = secureDirectory(root, join(root, 'docs', id))
      const dest = join(imported, `${stage.artifacts.length}-${basename(source)}`)
      const status = copyOrdinaryFile(cwd, source, dest, root)
      if (status !== 'saved') throw new Error('unstable')
      stage.artifacts.push({ ...artifact, path: dest, exists: true })
    } catch (error) {
      stage.files.push({ source, origin: 'document', status: 'rejected', reason: error.code ?? error.message, path: null })
      stage.complete = false
    }
  }
  writeFileSync(join(temp, 'manifest.json'), JSON.stringify(stage, null, 2), { flag: 'wx', mode: 0o600 })
  renameSync(temp, finalDir)
  return register(stage)
}

function copyValidation(root, path) {
  for (let cursor = path; cursor !== root; cursor = dirname(cursor)) {
    if (lstatSync(cursor).isSymbolicLink()) throw new Error('symlink')
  }
  if (!lstatSync(path).isFile()) throw new Error('not-file')
}
