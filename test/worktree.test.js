// P9 worktree 宿主侧能力 + 派发接线：git 调用全部用 fake exec（不碰真 git），台账用临时库。
// 覆盖：失败 7 分类、exclude 幂等、分支事实、建/删/清、target 偏移、task_create 契约、派发 cwd。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { openLedger, createTask, getTask, listTasks, recentMessages, setTaskWorktree, transition } from '../src/ledger.js'
import { createTools } from '../src/tools.js'
import { createQueue } from '../src/queue.js'
import { createNotifier } from '../src/notify.js'
import {
  checkoutPathFor, classifyGitFailure, cleanupTaskWorktree, createWorktreeService, prepareTaskWorktree,
  retryWorktreeOf, targetInCheckout, targetOffset,
} from '../src/worktree.js'
import { tempDir, sampleBrief } from './helpers.js'

const NOW = 1_700_000_000_000
const NOW_SECONDS = Math.floor(NOW / 1000)
const DAY = 86400

const ok = (stdout = '') => ({ ok: true, stdout, stderr: '', exitCode: 0, spawnError: null, killed: false })
const bad = (stderr = '', exitCode = 128) => ({ ok: false, stdout: '', stderr, exitCode, spawnError: null, killed: false })

/**
 * fake git：只认本模块会发的那几条命令。`config` 描述「仓库长什么样」。
 * 返回的 exec 记录每次调用，用来断言「普通任务一次 git 都不调」「建树用了 -b 新分支」。
 */
function fakeExec(config = {}) {
  const calls = []
  const settings = {
    repoRoot: 'C:/repo', defaultBranch: 'main', head: 'abc1234',
    branches: [{ name: 'main', committerdate: NOW_SECONDS - DAY, subject: 'init' }],
    existingBranches: [], knownRefs: [], missing: false, notRepo: false,
    failWorktreeAdd: null, unmerged: 0, gitPath: '.git/info/exclude',
    ...config,
  }
  const exec = async (args, options = {}) => {
    const line = args.join(' ')
    calls.push({ line, cwd: options.cwd })
    if (settings.missing) return { ...bad(''), spawnError: 'ENOENT', exitCode: null }
    if (settings.notRepo) {
      return bad('fatal: not a git repository (or any of the parent directories): .git')
    }
    if (line === 'rev-parse --show-toplevel') return ok(settings.repoRoot)
    if (line === 'rev-parse --short HEAD') return ok(settings.head)
    if (line === 'symbolic-ref --short refs/remotes/origin/HEAD') return bad('fatal: ref refs/remotes/origin/HEAD is not a symbolic ref')
    if (line === 'rev-parse --abbrev-ref HEAD') return ok(settings.defaultBranch)
    if (args[0] === 'for-each-ref') {
      return ok(settings.branches.map(branch => `${branch.name}\0${branch.committerdate}\0${branch.subject}`).join('\n'))
    }
    if (args[0] === 'check-ref-format') {
      const name = args[args.length - 1]
      return /^[A-Za-z0-9._/-]+$/.test(name) && !name.endsWith('/') ? ok('') : bad(`fatal: '${name}' is not a valid branch name`)
    }
    if (args[0] === 'show-ref') {
      const branch = String(args[args.length - 1]).replace('refs/heads/', '')
      return settings.existingBranches.includes(branch) ? ok('') : bad('', 1)
    }
    if (line.startsWith('rev-parse --verify --quiet')) {
      const ref = String(args[args.length - 1]).replace('^{commit}', '')
      return ref === settings.defaultBranch || settings.knownRefs.includes(ref) ? ok('sha') : bad('', 1)
    }
    if (args[0] === 'rev-parse' && args[1] === '--git-path') return ok(settings.gitPath)
    if (args[0] === 'worktree' && args[1] === 'add') {
      if (settings.failWorktreeAdd !== null) return bad(settings.failWorktreeAdd)
      return ok('Preparing worktree')
    }
    if (args[0] === 'rev-parse' && args[1] === '--short') return ok('deadbee')
    if (args[0] === 'rev-list' && args[1] === '--count') return ok(String(settings.unmerged))
    if (args[0] === 'worktree' && args[1] === 'remove') return ok('')
    if (args[0] === 'worktree' && args[1] === 'prune') return ok('')
    if (args[0] === 'branch' && args[1] === '-D') return ok('Deleted')
    return bad(`unexpected git command: ${line}`)
  }
  return { exec, calls, settings }
}

// —— 一、探测：失败分类 + 分支事实 ——

test('P9 probeRepo：非仓库 / 没装 git 都给可读分类', async () => {
  const notRepo = fakeExec({ notRepo: true })
  const service = createWorktreeService({ exec: notRepo.exec, now: () => NOW })
  const facts = await service.probeRepo('C:/plain')
  assert.equal(facts.isRepo, false)
  assert.equal(facts.reason, 'NOT_A_REPO')

  const missing = fakeExec({ missing: true })
  const factsMissing = await createWorktreeService({ exec: missing.exec, now: () => NOW }).probeRepo('C:/plain')
  assert.equal(factsMissing.isRepo, false)
  assert.equal(factsMissing.reason, 'GIT_MISSING')
  assert.match(factsMissing.message, /git/)
})

test('P9 probeRepo：近 N 天分支统计、suggestedBase、多分支 needsBranchChoice', async () => {
  const one = fakeExec({
    branches: [
      { name: 'main', committerdate: NOW_SECONDS - DAY, subject: 'it' },
      { name: 'old', committerdate: NOW_SECONDS - 30 * DAY, subject: 'stale' },
    ],
  })
  const facts = await createWorktreeService({ exec: one.exec, now: () => NOW, recentDays: 7 }).probeRepo('C:/repo')
  assert.equal(facts.isRepo, true)
  assert.equal(facts.repoRoot, 'C:/repo')
  assert.equal(facts.defaultBranch, 'main')
  assert.equal(facts.n, 1)
  assert.equal(facts.suggestedBase, 'main')
  assert.equal(facts.needsBranchChoice, false)

  const many = fakeExec({
    branches: [
      { name: 'feat/a', committerdate: NOW_SECONDS - DAY, subject: 'a' },
      { name: 'feat/b', committerdate: NOW_SECONDS - 2 * DAY, subject: 'b' },
      { name: 'main', committerdate: NOW_SECONDS - 3 * DAY, subject: 'm' },
    ],
  })
  const factsMany = await createWorktreeService({ exec: many.exec, now: () => NOW }).probeRepo('C:/repo')
  assert.equal(factsMany.n, 3)
  assert.equal(factsMany.needsBranchChoice, true)
  assert.equal(factsMany.suggestedBase, undefined)
  assert.deepEqual(factsMany.recentBranches.map(item => item.name), ['feat/a', 'feat/b', 'main'])
})

// —— 二、建树：永远 -b 新分支，7 类失败可读 ——

test('P9 createWorktree：新分支 + 检出目录 + 基线（-b 而不是直接检出基线）', async () => {
  const dir = tempDir()
  const fake = fakeExec({ repoRoot: dir })
  const service = createWorktreeService({ exec: fake.exec, now: () => NOW })
  const checkout = checkoutPathFor(dir, 't-abc')
  const created = await service.create({ repoRoot: dir, path: checkout, branch: 'orch/t-abc', base: 'default' })
  assert.equal(created.ok, true)
  assert.equal(created.branch, 'orch/t-abc')
  assert.equal(created.base, 'main')
  const add = fake.calls.find(call => call.line.startsWith('worktree add'))
  assert.ok(add)
  assert.match(add.line, /^worktree add -b orch\/t-abc /)
  assert.ok(add.line.includes('main'))
})

test('P9 createWorktree：分支已存在 / 路径已存在 / 基线不存在 / 分支非法 / 没 git 都有分类', async () => {
  const dir = tempDir()
  const checkout = checkoutPathFor(dir, 't-1')

  const branch = fakeExec({ repoRoot: dir, existingBranches: ['orch/t-1'] })
  const branchResult = await createWorktreeService({ exec: branch.exec }).create({ repoRoot: dir, path: checkout, branch: 'orch/t-1' })
  assert.equal(branchResult.code, 'BRANCH_EXISTS')
  assert.match(branchResult.message, /continue/)

  mkdirSync(checkout, { recursive: true })
  const pathFake = fakeExec({ repoRoot: dir })
  const pathResult = await createWorktreeService({ exec: pathFake.exec }).create({ repoRoot: dir, path: checkout, branch: 'orch/t-2' })
  assert.equal(pathResult.code, 'PATH_EXISTS')

  const baseFake = fakeExec({ repoRoot: dir })
  const baseResult = await createWorktreeService({ exec: baseFake.exec }).create({ repoRoot: dir, path: join(dir, 'w2'), branch: 'orch/t-3', base: 'nope' })
  assert.equal(baseResult.code, 'BASE_NOT_FOUND')

  const invalidFake = fakeExec({ repoRoot: dir })
  const invalidResult = await createWorktreeService({ exec: invalidFake.exec }).create({ repoRoot: dir, path: join(dir, 'w3'), branch: 'bad name' })
  assert.equal(invalidResult.code, 'BRANCH_INVALID')

  const missingFake = fakeExec({ repoRoot: dir, missing: true })
  const missingResult = await createWorktreeService({ exec: missingFake.exec }).create({ repoRoot: dir, path: join(dir, 'w4'), branch: 'orch/t-4' })
  assert.equal(missingResult.code, 'GIT_MISSING')
})

test('P9 classifyGitFailure：already exists 先判分支再判路径；git 缺失/超时/未知', () => {
  assert.equal(classifyGitFailure({ stderr: "fatal: a branch named 'orch/t-1' already exists" }).code, 'BRANCH_EXISTS')
  assert.equal(classifyGitFailure({ stderr: "fatal: 'C:/w' already exists" }).code, 'PATH_EXISTS')
  assert.equal(classifyGitFailure({ stderr: 'fatal: invalid reference: nope' }).code, 'BASE_NOT_FOUND')
  assert.equal(classifyGitFailure({ stderr: '', spawnError: 'ENOENT' }).code, 'GIT_MISSING')
  assert.equal(classifyGitFailure({ stderr: '', killed: true }).code, 'FAILED')
  assert.equal(classifyGitFailure({ stderr: 'some weird error' }).code, 'FAILED')
})

// —— 三、exclude / 清理 / target 偏移 ——

test('P9 ensureExcluded：幂等写入 .git/info/exclude，不动 .gitignore', async () => {
  const dir = tempDir()
  mkdirSync(join(dir, '.git', 'info'), { recursive: true })
  const exclude = join(dir, '.git', 'info', 'exclude')
  writeFileSync(exclude, '# git exclude\n', 'utf8')
  const fake = fakeExec({ repoRoot: dir })
  const service = createWorktreeService({ exec: fake.exec })
  const first = await service.ensureExcluded(dir)
  assert.equal(first.ok, true)
  assert.equal(first.added, true)
  assert.match(readFileSync(exclude, 'utf8'), /\.agents\//)
  const second = await service.ensureExcluded(dir)
  assert.equal(second.added, false)
  // 只写 exclude，不碰 .gitignore（用户被跟踪的文件）。
  assert.equal(fake.calls.some(call => call.line.includes('.gitignore')), false)
})

test('P9 remove：checkout-only 保分支；full 有未合并提交要确认', async () => {
  const fake = fakeExec({ unmerged: 3 })
  const service = createWorktreeService({ exec: fake.exec })
  const checkoutOnly = await service.remove({ repoRoot: 'C:/repo', path: 'C:/repo/.agents/worktrees/t-1', branch: 'orch/t-1', mode: 'checkout-only' })
  assert.equal(checkoutOnly.ok, true)
  assert.equal(checkoutOnly.branch, false)
  assert.equal(fake.calls.some(call => call.line.startsWith('branch -D')), false)

  fake.calls.length = 0
  const full = await service.remove({ repoRoot: 'C:/repo', path: 'C:/repo/.agents/worktrees/t-1', branch: 'orch/t-1', mode: 'full', confirm: true })
  assert.equal(full.ok, true)
  assert.equal(full.branch, true)
  assert.ok(fake.calls.some(call => call.line.startsWith('branch -D orch/t-1')))

  fake.calls.length = 0
  const unconfirmed = await service.remove({ repoRoot: 'C:/repo', path: 'C:/repo/.agents/worktrees/t-1', branch: 'orch/t-1', mode: 'full' })
  assert.equal(unconfirmed.branch, false)
  assert.match(unconfirmed.hint, /未合并/)
  assert.equal(fake.calls.some(call => call.line.startsWith('branch -D')), false)

  fake.calls.length = 0
  const off = await service.remove({ repoRoot: 'C:/repo', path: 'C:/repo/.agents/worktrees/t-1', mode: 'off' })
  assert.equal(off.skipped, true)
  assert.equal(fake.calls.length, 0)
})

test('P9 target 偏移：仓库内的子目录跟着检出走，仓库外不跟', () => {
  const repo = join('C:', 'repo')
  assert.equal(targetOffset(repo, repo), '')
  assert.equal(targetOffset(repo, join(repo, 'packages', 'app')), join('packages', 'app'))
  assert.equal(targetOffset(repo, join('C:', 'elsewhere')), '')
  assert.equal(targetInCheckout(join(repo, '.agents', 'worktrees', 't-1'), join('packages', 'app')),
    join(repo, '.agents', 'worktrees', 't-1', 'packages', 'app'))
})

// —— 四、台账七列 + 迁移 ——

test('P9 台账：七列默认值、落库、旧库自动补列', async () => {
  const db = await openLedger(tempDir())
  const plain = createTask(db, { brief: sampleBrief(), coordinatorSession: 's-1' })
  assert.equal(plain.worktree_state, 'none')
  assert.equal(plain.worktree_path, null)
  assert.equal(plain.worktree_source, 'default')
  const wt = createTask(db, {
    brief: sampleBrief({ title: '隔离' }),
    coordinatorSession: 's-1',
    worktree: { state: 'requested', source: 'task', repoRoot: 'C:/repo', base: 'main', mode: 'new' },
  })
  assert.equal(wt.worktree_state, 'requested')
  assert.equal(wt.repo_root, 'C:/repo')
  const updated = setTaskWorktree(db, wt.id, { state: 'created', path: 'C:/repo/.agents/worktrees/x', branch: 'orch/x', targetDir: 'C:/repo/.agents/worktrees/x' })
  assert.equal(updated.worktree_state, 'created')
  assert.equal(updated.worktree_branch, 'orch/x')
  assert.equal(updated.target_dir, 'C:/repo/.agents/worktrees/x')
  db.close()
})

test('P9 台账：旧 schema 库打开后补七列，旧行读 none/default', async () => {
  const dir = tempDir()
  const { DatabaseSync } = await import('node:sqlite')
  const legacy = new DatabaseSync(join(dir, 'tasks.sqlite'))
  legacy.exec(`CREATE TABLE tasks (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, goal TEXT NOT NULL, brief_json TEXT NOT NULL,
    status TEXT NOT NULL, session_id TEXT, target TEXT, coordinator_session TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    last_event_at INTEGER NOT NULL, error TEXT, queued_at INTEGER)`)
  legacy.prepare(`INSERT INTO tasks (id, title, goal, brief_json, status, coordinator_session, created_at, updated_at, last_event_at)
    VALUES ('t-old', '旧任务', 'g', '{}', 'done', 's-1', 1, 1, 1)`).run()
  legacy.close()
  const db = await openLedger(dir)
  const cols = db.prepare('PRAGMA table_info(tasks)').all().map(row => row.name)
  for (const column of ['worktree_path', 'worktree_branch', 'repo_root', 'worktree_base', 'worktree_mode', 'worktree_source', 'worktree_state']) {
    assert.ok(cols.includes(column), `缺列 ${column}`)
  }
  const row = getTask(db, 't-old')
  assert.equal(row.worktree_state, 'none')
  assert.equal(row.worktree_source, 'default')
  db.close()
})

// —— 五、派发前建树 / 复用 / 失败 / 清理 ——

const fakeService = (overrides = {}) => {
  const calls = { create: [], ensureExcluded: [], remove: [] }
  return {
    calls,
    async create(args) {
      calls.create.push(args)
      return overrides.create === undefined ? { ok: true, path: args.path, branch: args.branch, base: args.base, baseCommit: 'sha' } : overrides.create(args)
    },
    async ensureExcluded(root) {
      calls.ensureExcluded.push(root)
      return { ok: true, added: true }
    },
    async remove(args) {
      calls.remove.push(args)
      return { ok: true, checkout: true, branch: args.mode === 'full', unmerged: 0 }
    },
  }
}

test('P9 prepareTaskWorktree：建树后 target = 检出目录 + 原 target 偏移，并写 exclude', async () => {
  const db = await openLedger(tempDir())
  const repoRoot = tempDir()
  const task = createTask(db, {
    brief: sampleBrief({ title: '隔离任务', target: join(repoRoot, 'packages', 'app') }),
    coordinatorSession: 's-1',
    targetDir: join(repoRoot, 'packages', 'app'),
    worktree: { state: 'requested', source: 'task', repoRoot, base: 'main', mode: 'new' },
  })
  setTaskWorktree(db, task.id, { path: checkoutPathFor(repoRoot, task.id), branch: `orch/${task.id}` })
  const service = fakeService()
  const prepared = await prepareTaskWorktree({ db, task: getTask(db, task.id), service })
  assert.equal(prepared.ok, true)
  assert.equal(prepared.state, 'created')
  assert.equal(prepared.cwd, join(checkoutPathFor(repoRoot, task.id), 'packages', 'app'))
  const stored = getTask(db, task.id)
  assert.equal(stored.worktree_state, 'created')
  assert.equal(stored.target_dir, prepared.cwd)
  assert.equal(stored.worktree_branch, `orch/${task.id}`)
  assert.equal(service.calls.ensureExcluded[0], repoRoot)
  db.close()
})

test('P9 prepareTaskWorktree：建树失败落 failed（不静默降级）；reuse 不调 create', async () => {
  const db = await openLedger(tempDir())
  const repoRoot = tempDir()
  const failing = createTask(db, {
    brief: sampleBrief({ title: '失败任务', target: repoRoot }),
    coordinatorSession: 's-1',
    targetDir: repoRoot,
    worktree: { state: 'requested', source: 'task', repoRoot, base: 'main', mode: 'new' },
  })
  const failure = await prepareTaskWorktree({
    db,
    task: getTask(db, failing.id),
    service: fakeService({ create: () => ({ ok: false, code: 'GIT_MISSING', message: '没装 git' }) }),
  })
  assert.equal(failure.ok, false)
  assert.equal(failure.failure.code, 'GIT_MISSING')
  assert.equal(getTask(db, failing.id).worktree_state, 'failed')

  const reuse = createTask(db, {
    brief: sampleBrief({ title: '复用任务', target: repoRoot }),
    coordinatorSession: 's-1',
    targetDir: repoRoot,
    worktree: { state: 'reused', source: 'task', repoRoot, path: join(repoRoot, 'w', 't-x'), branch: 'orch/t-x', mode: 'continue' },
  })
  const service = fakeService()
  const reused = await prepareTaskWorktree({ db, task: getTask(db, reuse.id), service })
  assert.equal(reused.ok, true)
  assert.equal(reused.state, 'reused')
  assert.equal(reused.cwd, join(repoRoot, 'w', 't-x'))
  assert.equal(service.calls.create.length, 0)
  db.close()
})

test('P9 清理：默认 off 不清理；checkout-only 清检出并落 cleaned；失败不影响终态', async () => {
  const db = await openLedger(tempDir())
  const make = (cleanup, state = 'created') => createTask(db, {
    brief: sampleBrief({ title: `清理-${cleanup}-${Math.random()}`, worktreeCleanup: cleanup }),
    coordinatorSession: 's-1',
    targetDir: 'C:/repo',
    worktree: { state, source: 'task', repoRoot: 'C:/repo', path: 'C:/repo/.agents/worktrees/t-1', branch: 'orch/t-1', mode: 'new' },
  })
  const off = make(undefined)
  assert.equal((await cleanupTaskWorktree({ db, task: off, service: fakeService() })).skipped, true)

  const checkoutOnly = make('checkout-only')
  const service = fakeService()
  const result = await cleanupTaskWorktree({ db, task: checkoutOnly, service })
  assert.equal(result.ok, true)
  assert.equal(service.calls.remove[0].mode, 'checkout-only')
  assert.equal(getTask(db, checkoutOnly.id).worktree_state, 'cleaned')

  const failing = make('full')
  const failed = await cleanupTaskWorktree({
    db,
    task: failing,
    service: { create: async () => ({ ok: false }), ensureExcluded: async () => ({ ok: true }), remove: async () => ({ ok: false, code: 'FAILED', message: '锁住了' }) },
  })
  assert.equal(failed.ok, false)
  assert.equal(getTask(db, failing.id).worktree_state, 'created', '清理失败不改终态之外的隔离状态')
  db.close()
})

test('P9 重派：检出还在就复用，被清理/不见了按原基线重建', () => {
  const repoRoot = tempDir()
  const checkout = checkoutPathFor(repoRoot, 't-1')
  mkdirSync(checkout, { recursive: true })
  const reused = retryWorktreeOf({
    id: 't-1', worktree_state: 'created', worktree_path: checkout, repo_root: repoRoot,
    worktree_branch: 'orch/t-1', worktree_base: 'main', worktree_source: 'task',
  })
  assert.equal(reused.state, 'reused')
  assert.equal(reused.path, checkout)
  const rebuild = retryWorktreeOf({
    id: 't-2', worktree_state: 'cleaned', worktree_path: join(repoRoot, 'gone'), repo_root: repoRoot,
    worktree_branch: 'orch/t-2', worktree_base: 'main', worktree_source: 'config',
  })
  assert.equal(rebuild.state, 'requested')
  assert.equal(rebuild.base, 'main')
  assert.equal(retryWorktreeOf({ worktree_state: 'none' }), null)
})

// —— 六、task_create 契约 + 派发接线（工具层，fake git） ——

function fakeDispatcher() {
  const calls = []
  let counter = 0
  return {
    calls,
    async spawn(input) {
      calls.push(['spawn', input])
      counter += 1
      return { id: `c-${counter}`, name: input.name, sessionId: `c-${counter}`, target: `c-${counter}` }
    },
    async sendReliable(target, message, signal, targetDir) {
      calls.push(['sendReliable', target, message, targetDir])
      return { messageId: 'm-1' }
    },
    async stop(target) { calls.push(['stop', target]) },
    releaseWritableRoots(target) { calls.push(['release', target]) },
    slug(title) { counter += 1; return `task-${counter}` },
  }
}

async function setupTools({ worktree, config: overrides = {}, defaultCwd } = {}) {
  const db = await openLedger(tempDir())
  const dispatcher = fakeDispatcher()
  const notifier = { pushed: [], push(item) { this.pushed.push(item) } }
  const config = {
    staleMinutes: 30, maxQueue: 50, coordinatorSession: 's-1',
    worktreePolicy: 'auto', worktreeBranchPrefix: 'orch/', worktreeRecentDays: 7, ...overrides,
  }
  const service = worktree ?? fakeService()
  const queue = createQueue({ db, dispatcher, config, notifier, worktree: service })
  const tools = Object.fromEntries(createTools({
    db, dispatcher, queue, notifier, config,
    worktree: service,
    defaultCwd,
    coordinatorStatus: () => ({ id: 's-1', live: true }),
  }).map(tool => [tool.name, tool]))
  return { db, dispatcher, queue, notifier, tools, worktree: service }
}

const call = (tools, name, args, exec) => tools[name].execute(args, { agent: { id: 's-1' }, ...(exec ?? {}) })

test('P9 task_create：worktree:true 建分支 + 检出，spawn cwd 是检出目录', async () => {
  const repoRoot = tempDir()
  const { db, dispatcher, tools } = await setupTools({
    worktree: fakeServiceWithFacts({ repoRoot, n: 1, suggestedBase: 'main' }),
  })
  const text = await call(tools, 'task_create', sampleBrief({ title: '隔离A', goal: 'g', target: repoRoot, worktree: true }), {})
  assert.match(text, /已派发/)
  assert.match(text, /隔离：新分支/)
  assert.match(text, /合并到你的工作树由你\/用户决定/)
  const [task] = listTasks(db, { active: true })
  assert.equal(task.worktree_state, 'created')
  assert.equal(task.worktree_source, 'task')
  assert.equal(task.worktree_base, 'main')
  assert.equal(task.worktree_branch, `orch/${task.id}`)
  const spawn = dispatcher.calls.find(item => item[0] === 'spawn')
  assert.equal(spawn[1].cwd, checkoutPathFor(repoRoot, task.id))
  db.close()
})

test('P9 brief：隔离任务的 brief 带「可装依赖、只装不升」提示，普通任务不带', async () => {
  const repoRoot = tempDir()
  const { db, tools } = await setupTools({ worktree: fakeServiceWithFacts({ repoRoot, n: 1, suggestedBase: 'main' }) })
  const briefOf = taskId => recentMessages(db, taskId, 1)[0].rendered

  // 隔离任务（worktree_state=created）→ 有装依赖提示。
  await call(tools, 'task_create', sampleBrief({ title: '隔离装依赖', goal: 'g', target: repoRoot, worktree: true }), {})
  const isolated = listTasks(db, { active: true }).find(task => task.title === '隔离装依赖')
  assert.equal(isolated.worktree_state, 'created')
  const isolatedBrief = briefOf(isolated.id)
  assert.match(isolatedBrief, /【worktree 依赖】/)
  assert.match(isolatedBrief, /pnpm install/)
  assert.match(isolatedBrief, /只安装不升级/)
  // 确认方式提示对所有任务都在（交付待确认场景）。
  assert.match(isolatedBrief, /【确认方式】/)

  // 普通任务（worktree_state=none）→ 没有装依赖提示。
  await call(tools, 'task_create', sampleBrief({ title: '普通任务', goal: 'g', target: repoRoot }), {})
  const plain = listTasks(db, { active: true }).find(task => task.title === '普通任务')
  assert.equal(plain.worktree_state, 'none')
  assert.equal(briefOf(plain.id).includes('【worktree 依赖】'), false)
  assert.match(briefOf(plain.id), /【确认方式】/)
  db.close()
})

test('P9 brief：隔离降级（不是 git 仓库）不给装依赖提示——仍在原工作树里跑', async () => {
  const target = tempDir()
  const { db, tools } = await setupTools({ worktree: fakeServiceWithFacts({ isRepo: false, reason: 'NOT_A_REPO' }) })
  await call(tools, 'task_create', sampleBrief({ title: '降级任务', goal: 'g', target, worktree: true }), {})
  const [task] = listTasks(db, { active: true })
  assert.equal(task.worktree_state, 'degraded')
  assert.equal(recentMessages(db, task.id, 1)[0].rendered.includes('【worktree 依赖】'), false)
  db.close()
})

test('P9 brief：重派隔离任务时重渲染的 brief 也带装依赖提示（复用检出）', async () => {
  const repoRoot = tempDir()
  const checkout = checkoutPathFor(repoRoot, 't-old')
  const { db, tools } = await setupTools({ worktree: fakeServiceWithFacts({ repoRoot }) })
  const old = createTask(db, {
    brief: sampleBrief({ title: '旧隔离任务', target: repoRoot }),
    coordinatorSession: 's-1',
    targetDir: checkout,
    worktree: { state: 'created', source: 'task', repoRoot, path: checkout, branch: 'orch/t-old', base: 'main', mode: 'new' },
  })
  transition(db, old.id, 'failed', { error: 'boom' })
  await call(tools, 'task_message', { action: 'retry', task_id: old.id })
  const retried = listTasks(db).find(task => task.retry_of === old.id)
  // 检出目录已不在 → 按原基线重建（requested → 派发后 created），仍是隔离任务。
  assert.ok(['requested', 'created', 'reused'].includes(retried.worktree_state), retried.worktree_state)
  const rendered = recentMessages(db, retried.id, 1)[0].rendered
  assert.match(rendered, /【worktree 依赖】/)
  assert.match(rendered, /【确认方式】/)
  db.close()
})

test('P9 task_create：非 git 目录 → 降级普通模式（不报错），cwd 仍是原 target', async () => {
  const target = tempDir()
  const { db, dispatcher, tools } = await setupTools({
    worktree: fakeServiceWithFacts({ isRepo: false, reason: 'NOT_A_REPO' }),
  })
  const text = await call(tools, 'task_create', sampleBrief({ title: '降级', goal: 'g', target, worktree: true }), {})
  assert.match(text, /已派发/)
  assert.match(text, /降级为普通模式/)
  const [task] = listTasks(db, { active: true })
  assert.equal(task.worktree_state, 'degraded')
  const spawn = dispatcher.calls.find(item => item[0] === 'spawn')
  assert.equal(spawn[1].cwd, target)
  db.close()
})

test('P9 task_create：与 readOnly / planFirst 互斥，创建期拒绝且不建任务', async () => {
  const target = tempDir()
  const { db, dispatcher, tools } = await setupTools()
  const readOnly = await call(tools, 'task_create', sampleBrief({ title: '只读冲突', target, worktree: true, readOnly: true }), {})
  assert.match(readOnly, /互斥|readOnly/)
  const planned = await call(tools, 'task_create', sampleBrief({ title: '计划冲突', target, worktree: true, planFirst: true }), {})
  assert.match(planned, /计划阶段不建隔离/)
  assert.equal(listTasks(db).length, 0)
  assert.equal(dispatcher.calls.length, 0)
  db.close()
})

test('P9 task_create：多分支且没给基线 → needsBranchChoice，不落库、不占并发位', async () => {
  const repoRoot = tempDir()
  const service = fakeServiceWithFacts({
    repoRoot, n: 2, needsBranchChoice: true,
    recentBranches: [{ name: 'feat/a' }, { name: 'feat/b' }],
    knownRefs: ['feat/a', 'feat/b'],
  })
  const { db, dispatcher, tools } = await setupTools({ worktree: service })
  const text = await call(tools, 'task_create', sampleBrief({ title: '多分支', goal: 'g', target: repoRoot, worktree: true }), {})
  assert.match(text, /基线需要你定/)
  assert.match(text, /feat\/a/)
  assert.match(text, /未创建任务/)
  assert.equal(listTasks(db).length, 0)
  assert.equal(dispatcher.calls.length, 0)
  // 带 worktreeBase 重调 → 正常建。
  const retried = await call(tools, 'task_create', sampleBrief({ title: '多分支2', goal: 'g', target: repoRoot, worktree: true, worktreeBase: 'feat/a' }), {})
  assert.match(retried, /已派发/)
  assert.equal(listTasks(db, { active: true })[0].worktree_base, 'feat/a')
  db.close()
})

test('P9 task_create：基线不存在 / 分支已存在都在创建期拒绝', async () => {
  const repoRoot = tempDir()
  const service = fakeServiceWithFacts({ repoRoot, n: 1, suggestedBase: 'main', knownRefs: [], existingBranches: ['feat/x'] })
  const { db, tools } = await setupTools({ worktree: service })
  const missingBase = await call(tools, 'task_create', sampleBrief({ title: '基线缺失', target: repoRoot, worktree: true, worktreeBase: 'release/nope' }), {})
  assert.match(missingBase, /worktreeBase 不存在/)
  const existingBranch = await call(tools, 'task_create', sampleBrief({ title: '分支重名', target: repoRoot, worktree: true, worktreeBranch: 'feat/x' }), {})
  assert.match(existingBranch, /已存在/)
  assert.match(existingBranch, /continue/)
  assert.equal(listTasks(db).length, 0)
  db.close()
})

test('P9 task_create：worktreePolicy=required 时漏传也兜底建（来源 config）；显式 false 只给 hint', async () => {
  const repoRoot = tempDir()
  const service = fakeServiceWithFacts({ repoRoot, n: 1, suggestedBase: 'main' })
  const { db, tools } = await setupTools({ worktree: service, config: { worktreePolicy: 'required' } })
  const fallback = await call(tools, 'task_create', sampleBrief({ title: '兜底建', target: repoRoot }), {})
  assert.match(fallback, /已派发/)
  assert.match(fallback, /按配置 worktreePolicy=required 建了隔离（协调者未传参数）/)
  const created = listTasks(db, { active: true })[0]
  assert.equal(created.worktree_state, 'created')
  assert.equal(created.worktree_source, 'config')

  const skip = await call(tools, 'task_create', sampleBrief({ title: '显式不建', target: repoRoot, worktree: false }), {})
  assert.match(skip, /配置声明 required，但本次未隔离/)
  const skipped = listTasks(db, { active: true }).find(task => task.title === '显式不建')
  assert.equal(skipped.worktree_state, 'none')
  db.close()
})

test('P9 task_create：没传 target 时探测协调者默认目录（函数 getter 也要解开）', async () => {
  const cwd = tempDir()
  const service = fakeServiceWithFacts({ repoRoot: cwd })
  const { db, tools } = await setupTools({ worktree: service, defaultCwd: () => cwd })
  await call(tools, 'task_create', sampleBrief({ title: '无 target 隔离', goal: 'g', worktree: true }), {})
  assert.equal(service.probeCalls[0], cwd)
  const [task] = listTasks(db, { active: true })
  assert.equal(task.worktree_state, 'created')
  db.close()
})

test('P9 task_create：普通任务一次 git 都不调（零 probe / 零 create）', async () => {
  const repoRoot = tempDir()
  const service = fakeServiceWithFacts({ repoRoot })
  const { db, dispatcher, tools } = await setupTools({ worktree: service })
  await call(tools, 'task_create', sampleBrief({ title: '普通任务', goal: 'g', target: repoRoot }), {})
  assert.equal(service.probeCalls.length, 0)
  assert.equal(service.calls.create.length, 0)
  const [task] = listTasks(db, { active: true })
  assert.equal(task.worktree_state, 'none')
  assert.equal(dispatcher.calls.find(item => item[0] === 'spawn')[1].cwd, repoRoot)
  db.close()
})

test('P9 task_create：worktreeMode=continue 复用已有检出（不新建、cwd 指过去）', async () => {
  const repoRoot = tempDir()
  const checkout = checkoutPathFor(repoRoot, 't-prev')
  const { db, dispatcher, tools, worktree } = await setupTools({ worktree: fakeServiceWithFacts({ repoRoot }) })
  createTask(db, {
    brief: sampleBrief({ title: '前一单', target: repoRoot }),
    coordinatorSession: 's-1',
    targetDir: checkout,
    groupId: 'g-1',
    worktree: { state: 'created', source: 'task', repoRoot, path: checkout, branch: 'orch/t-prev', base: 'main', mode: 'new' },
  })
  const text = await call(tools, 'task_create', sampleBrief({ title: '续写', goal: 'g', target: repoRoot, worktreeMode: 'continue', group: 'g-1' }), {})
  assert.match(text, /复用已有检出/)
  const continued = listTasks(db, { active: true }).find(task => task.title === '续写')
  assert.equal(continued.worktree_state, 'reused')
  assert.equal(worktree.calls.create.length, 0)
  const spawn = dispatcher.calls.filter(item => item[0] === 'spawn').at(-1)
  assert.equal(spawn[1].cwd, checkout)
  db.close()
})

test('P9 task_create：continue 但没检出 → 拒绝并指路', async () => {
  const { db, tools } = await setupTools()
  const text = await call(tools, 'task_create', sampleBrief({ title: '无检出', target: tempDir(), worktreeMode: 'continue' }), {})
  assert.match(text, /没有可复用的检出/)
  assert.match(text, /worktreeMode="new"/)
  assert.equal(listTasks(db).length, 0)
  db.close()
})

test('P9 派发失败：建树失败标 failed 并写原因（不静默降级）', async () => {
  const repoRoot = tempDir()
  const service = fakeServiceWithFacts({ repoRoot })
  service.create = async () => ({ ok: false, code: 'BRANCH_EXISTS', message: '分支已存在：orch/x' })
  const { db, notifier, tools } = await setupTools({ worktree: service })
  // 工具层把异常转成可读结果（wrap），所以断言返回文案而不是抛错。
  const text = await call(tools, 'task_create', sampleBrief({ title: '建树失败', target: repoRoot, worktree: true }), {})
  assert.match(text, /隔离创建失败/)
  assert.match(text, /BRANCH_EXISTS/)
  const [task] = listTasks(db)
  assert.equal(task.status, 'failed')
  assert.equal(task.worktree_state, 'failed')
  assert.match(notifier.pushed.at(-1)?.summary ?? '', /隔离创建失败/)
  db.close()
})

test('P9 视图接线：task_status 隔离行、task_list「·隔离」、通知带「合并由你决定」', async () => {
  const repoRoot = tempDir()
  const { db, tools } = await setupTools({ worktree: fakeServiceWithFacts({ repoRoot }) })
  await call(tools, 'task_create', sampleBrief({ title: '视图任务', target: repoRoot, worktree: true }), {})
  const [task] = listTasks(db, { active: true })
  const status = await call(tools, 'task_status', { task_id: task.id })
  assert.match(status, /隔离：已隔离/)
  assert.match(status, /合并由你决定/)
  const list = await call(tools, 'task_list', {})
  assert.match(list, /·隔离/)

  // 普通任务零隔离字样。
  await call(tools, 'task_create', sampleBrief({ title: '普通视图', target: repoRoot }), {})
  const plain = listTasks(db, { active: true }).find(item => item.title === '普通视图')
  const plainStatus = await call(tools, 'task_status', { task_id: plain.id })
  assert.equal(plainStatus.includes('隔离：'), false)

  // 通知：隔离任务带「产物在分支 X 的检出目录 Y，合并由你决定」。
  const texts = []
  const notifier = createNotifier({ mergeWindowMs: 0, send: text => { texts.push(text); return true } })
  notifier.push({
    taskId: task.id, title: '视图任务', status: 'done', summary: '完成',
    worktree: { state: 'created', branch: 'orch/t-1', path: 'C:/repo/.agents/worktrees/t-1' },
  })
  await notifier.drain()
  assert.match(texts.join('\n'), /合并到你当前分支由你决定/)
  db.close()
})

/** fake 服务 + 仓库事实（task_create 会先 probe）。 */
function fakeServiceWithFacts(facts = {}) {
  const base = fakeService()
  const probeCalls = []
  const existingBranches = facts.existingBranches ?? []
  return {
    ...base,
    probeCalls,
    async probeRepo(dir) {
      probeCalls.push(dir)
      if (facts.isRepo === false) return { isRepo: false, reason: facts.reason ?? 'NOT_A_REPO', message: '不是仓库' }
      return {
        isRepo: true,
        repoRoot: facts.repoRoot,
        defaultBranch: facts.defaultBranch ?? 'main',
        head: 'abc1234',
        n: facts.n ?? 0,
        recentBranches: facts.recentBranches ?? [{ name: facts.suggestedBase ?? 'main' }],
        suggestedBase: facts.suggestedBase ?? (facts.n === 0 ? 'main' : undefined),
        needsBranchChoice: facts.needsBranchChoice === true,
      }
    },
    async refExists(root, ref) {
      if (ref === 'main') return true
      return (facts.knownRefs ?? []).includes(ref)
    },
    async branchExists(root, name) {
      return existingBranches.includes(name)
    },
  }
}
