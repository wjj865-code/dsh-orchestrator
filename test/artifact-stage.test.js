import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { openLedger, createTask, getTask } from '../src/ledger.js'
import { collectArtifactStage, inspectGit } from '../src/artifact-stage.js'
import { tempDir, sampleBrief, linkDirectory, canCreateDirectoryLink, DIRECTORY_LINK_SKIP_REASON } from './helpers.js'

test('历史摘要不能替代本轮摘要，显式交付截断记录为不完整', async () => {
  const cwd = tempDir()
  writeFileSync(join(cwd, 'old.txt'), 'old')
  const db = await openLedger(tempDir())
  const task = createTask(db, { brief: sampleBrief(), artifactRoot: tempDir(), targetDir: cwd })
  const input = {
    db, task, cwd, session: { id: 'child', events: [{ type: 'workspace/changes', seq: 1 }, { type: 'workspace/changes', seq: 2 }] },
    workspaceChanges: { summary: (_id, seq) => seq === 1 ? { cwd, files: [{ path: 'old.txt' }] } : undefined },
    run: async () => ({ ok: false, stderr: 'not a git repository' }),
  }
  const missing = await collectArtifactStage({ ...input, key: 'missing-current', eventSeq: 2 })
  assert.equal(missing.complete, false)
  assert.deepEqual(missing.missingSummarySeqs, [2])
  assert.equal(missing.files[0].status, 'saved')
  const truncated = await collectArtifactStage({
    ...input, key: 'truncated', eventSeq: 1, artifactsOmitted: 3,
    session: { id: 'child', events: [{ type: 'workspace/changes', seq: 1 }] },
  })
  assert.equal(truncated.complete, false)
  assert.equal(truncated.documentsOmitted, 3)
  db.close()
})

test('非 Git 快照保持相对路径、拒绝逃逸，源文件后续改变不影响副本', async () => {
  const cwd = tempDir()
  mkdirSync(join(cwd, 'nested'))
  writeFileSync(join(cwd, 'a.txt'), 'a')
  writeFileSync(join(cwd, 'nested/a.txt'), 'b')
  const db = await openLedger(tempDir())
  const task = createTask(db, { brief: sampleBrief(), targetDir: cwd, artifactRoot: tempDir() })
  const git = async () => ({ ok: false, stderr: 'not a git repository', spawnError: null })
  const stage = await collectArtifactStage({ db, task, cwd, changedFiles: ['a.txt', 'nested/a.txt', '../outside'], key: 'final-0', run: git })
  assert.equal(stage.mode, 'non-git')
  assert.equal(stage.complete, false)
  assert.equal(stage.files.filter(f => f.status === 'saved').length, 2)
  assert.equal(stage.files.find(f => f.source.endsWith('outside')).status, 'rejected')
  writeFileSync(join(cwd, 'a.txt'), 'next task')
  assert.equal(readFileSync(stage.files[0].path, 'utf8'), 'a')
  const replay = await collectArtifactStage({ db, task, cwd, changedFiles: [], key: 'final-0', run: git })
  assert.equal(replay.path, stage.path)
  assert.equal(getTask(db, task.id).artifacts.some(a => a.path === stage.path), true)
  db.close()
})

test('显式文件超过面板容量仍全部保存到清单，软链接和目录不递归复制', async t => {
  // 整条用例靠真链接才能验「不递归复制」：这里只需要一条**目录**链接，用真符号链接或 Windows junction
  // 都成立（junction 不需要特权）；两种链接都造不出来的环境才跳过，不判失败。
  if (!canCreateDirectoryLink()) return t.skip(DIRECTORY_LINK_SKIP_REASON)
  const cwd = tempDir()
  const db = await openLedger(tempDir())
  const task = createTask(db, { brief: sampleBrief(), artifactRoot: tempDir(), targetDir: cwd })
  const files = Array.from({ length: 60 }, (_, n) => `${n}.txt`)
  for (const file of files) writeFileSync(join(cwd, file), file)
  const outside = tempDir()
  writeFileSync(join(outside, 'secret'), 'secret')
  linkDirectory(outside, join(cwd, 'link'))
  mkdirSync(join(cwd, 'directory'))
  const stage = await collectArtifactStage({
    db, task, cwd, key: 'many', changedFiles: [...files, 'link/secret', 'directory'],
    run: async () => ({ ok: false, stderr: 'not a git repository' }),
  })
  assert.equal(stage.files.filter(f => f.status === 'saved').length, 60)
  assert.equal(stage.files.filter(f => f.status === 'rejected').length, 2)
  assert.equal(getTask(db, task.id).artifacts.length, 50)
  assert.equal(getTask(db, task.id).artifacts[0].path, stage.path)
  assert.equal(JSON.parse(readFileSync(stage.path, 'utf8')).files.length, 62)
  db.close()
})

test('Git 状态核验失败不能显示阶段收集完整', async () => {
  const cwd = tempDir()
  const db = await openLedger(tempDir())
  const task = createTask(db, { brief: sampleBrief(), artifactRoot: tempDir(), targetDir: cwd })
  const run = async args => args[0] === 'status'
    ? { ok: false, stderr: 'permission denied' }
    : { ok: true, stdout: args.includes('--show-toplevel') ? cwd : 'head' }
  assert.equal((await inspectGit(cwd, run)).unarchived, true)
  const stage = await collectArtifactStage({ db, task, cwd, key: 'failed-status', run })
  assert.equal(stage.mode, 'git')
  assert.equal(stage.complete, false)
  db.close()
})

test('Git 工作代码不复制，显式文档仍保存，探测失败不是非 Git', async () => {
  const cwd = tempDir()
  writeFileSync(join(cwd, 'code.js'), 'code')
  writeFileSync(join(cwd, 'report.md'), 'report')
  const db = await openLedger(tempDir())
  const task = createTask(db, { brief: sampleBrief(), targetDir: cwd, artifactRoot: tempDir() })
  const git = async args => ({
    ok: true,
    stdout: args[0] === 'status' ? '?? code.js\0' : args[0] === 'ls-files' ? 'code.js\0' : args.includes('--show-toplevel') ? cwd : 'head',
    spawnError: null,
  })
  const stage = await collectArtifactStage({ db, task, cwd, changedFiles: ['code.js'], artifacts: [{ path: join(cwd, 'report.md'), label: '报告' }], key: 'git', run: git })
  assert.equal(stage.mode, 'git')
  assert.equal(stage.files.find(f => f.source.endsWith('code.js')).path, null)
  assert.equal(stage.git.unarchived, true)
  assert.equal(stage.artifacts.some(a => a.path.split(sep).join('/').includes('/docs/')), true)
  const unknown = await collectArtifactStage({ db, task, cwd, key: 'unknown', run: async () => ({ ok: false, spawnError: 'ENOENT' }) })
  assert.equal(unknown.mode, 'unknown')
  assert.equal(unknown.complete, false)
  db.close()
})

test('Git 模式只记录 tracked 与未跟踪未忽略的路径，ignored/.git 内/repo 外候选写明原因', async () => {
  const cwd = tempDir()
  const outside = tempDir()
  writeFileSync(join(cwd, 'new-file.md'), 'new')
  mkdirSync(join(cwd, 'node_modules/dep'), { recursive: true })
  writeFileSync(join(cwd, 'node_modules/dep/index.js'), 'dep')
  const db = await openLedger(tempDir())
  const task = createTask(db, { brief: sampleBrief(), artifactRoot: tempDir(), targetDir: cwd })
  const calls = []
  const ok = stdout => ({ ok: true, stdout, stderr: '', exitCode: 0, spawnError: null })
  const run = async (args, options = {}) => {
    calls.push({ args, cwd: options.cwd })
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return ok(cwd)
    if (args[0] === 'rev-parse') return ok('head')
    if (args[0] === 'symbolic-ref') return ok('main')
    if (args[0] === 'status') return ok('?? new-file.md\0')
    // Git 视野：tracked 的 code.js + 未跟踪未忽略的 new-file.md；node_modules 不在其中。
    if (args[0] === 'ls-files') return ok('code.js\0new-file.md\0')
    return { ok: false, stdout: '', stderr: '', exitCode: 1, spawnError: null }
  }
  const ignored = join(cwd, 'node_modules/dep/index.js')
  const insideGit = join(cwd, '.git/config')
  const outsideFile = join(outside, 'x.txt')
  const stage = await collectArtifactStage({
    db, task, cwd, key: 'git-filter',
    changedFiles: ['new-file.md', 'node_modules/dep/index.js', '.git/config', outsideFile],
    run,
  })
  // `--ignored` 不再传给 git status：ignored 条目根本不会出现在 changes 里。
  const statusCall = calls.find(call => call.args[0] === 'status')
  assert.deepEqual(statusCall.args, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  assert.deepEqual(stage.git.changes, ['?? new-file.md'])
  // files[] 只剩未跟踪的新文件（status 仍是 git-reference），ignored 目录不进清单。
  assert.deepEqual(stage.files.map(file => file.source), [join(cwd, 'new-file.md')])
  assert.equal(stage.files[0].status, 'git-reference')
  assert.equal(stage.files[0].path, null)
  // 排除项带原因，能在记录里看出为什么没进清单。
  assert.deepEqual(stage.excluded.map(item => [item.source, item.reason]), [
    [ignored, 'ignored'],
    [insideGit, 'inside-git-dir'],
    [outsideFile, 'outside-repo'],
  ])
  const lsCall = calls.find(call => call.args[0] === 'ls-files')
  assert.equal(lsCall.cwd, cwd)
  assert.ok(lsCall.args.includes('--cached') && lsCall.args.includes('--others') && lsCall.args.includes('--exclude-standard'))
  assert.ok(lsCall.args.includes(':(literal)new-file.md'), '候选路径按 literal pathspec 传，避免通配误匹配')
  assert.equal(stage.complete, true)
  const manifest = JSON.parse(readFileSync(stage.path, 'utf8'))
  assert.equal(manifest.files.length, 1)
  assert.equal(JSON.stringify(manifest.files).includes('node_modules'), false)
  assert.equal(manifest.excluded.length, 3)
  assert.deepEqual(manifest.excluded.map(item => item.reason), ['ignored', 'inside-git-dir', 'outside-repo'])
  db.close()
})

test('非 Git 与 unknown 分支不调用 git 视野核验，也不写 excluded 字段', async () => {
  const cwd = tempDir()
  writeFileSync(join(cwd, 'a.txt'), 'a')
  const db = await openLedger(tempDir())
  const task = createTask(db, { brief: sampleBrief(), targetDir: cwd, artifactRoot: tempDir() })
  const nonGitCalls = []
  const nonGit = await collectArtifactStage({
    db, task, cwd, changedFiles: ['a.txt'], key: 'non-git-unchanged',
    run: async args => { nonGitCalls.push(args); return { ok: false, stderr: 'not a git repository', spawnError: null } },
  })
  assert.equal(nonGit.mode, 'non-git')
  assert.equal(nonGit.files[0].status, 'saved')
  assert.equal(nonGitCalls.some(args => args[0] === 'ls-files' || args.includes('--ignored')), false)
  assert.equal('excluded' in nonGit, false)
  assert.equal('ignoreProbe' in nonGit.git, false)
  const unknownCalls = []
  const unknown = await collectArtifactStage({
    db, task, cwd, changedFiles: ['a.txt'], key: 'unknown-unchanged',
    run: async args => { unknownCalls.push(args); return { ok: false, spawnError: 'ENOENT' } },
  })
  assert.equal(unknown.mode, 'unknown')
  assert.equal(unknown.files[0].status, 'unknown')
  assert.equal(unknownCalls.some(args => args[0] === 'ls-files'), false)
  assert.equal('excluded' in unknown, false)
  db.close()
})

test('真实仓库：.gitignore 掉的 node_modules 不进 manifest，未跟踪新文件与 tracked 文件仍记录', async () => {
  const repo = tempDir()
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' })
  git('init', '-q')
  git('config', 'user.email', 't@e.st')
  git('config', 'user.name', 't')
  git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n')
  writeFileSync(join(repo, 'package.json'), '{"name":"probe"}\n')
  mkdirSync(join(repo, 'node_modules/dep'), { recursive: true })
  writeFileSync(join(repo, 'node_modules/dep/index.js'), 'dep\n')
  git('add', '.')
  git('commit', '-q', '-m', 'init')
  writeFileSync(join(repo, 'new-file.md'), '# new\n')
  const db = await openLedger(tempDir())
  const task = createTask(db, { brief: sampleBrief(), artifactRoot: tempDir(), targetDir: repo })
  const stage = await collectArtifactStage({
    db, task, cwd: repo, key: 'real-git',
    changedFiles: ['node_modules/dep/index.js', 'new-file.md', 'package.json'],
  })
  assert.equal(stage.mode, 'git')
  assert.equal(stage.git.changes.some(entry => entry.includes('node_modules')), false)
  assert.equal(stage.git.changes.some(entry => entry.includes('!!')), false)
  assert.ok(stage.git.changes.includes('?? new-file.md'))
  assert.deepEqual(stage.files.map(file => relative(repo, file.source).split(sep).join('/')), ['new-file.md', 'package.json'])
  assert.deepEqual(stage.files.map(file => file.status), ['git-reference', 'git-reference'])
  assert.deepEqual(stage.excluded.map(item => [relative(repo, item.source).split(sep).join('/'), item.reason]), [
    ['node_modules/dep/index.js', 'ignored'],
  ])
  const manifest = JSON.parse(readFileSync(stage.path, 'utf8'))
  assert.equal(JSON.stringify(manifest.files).includes('node_modules'), false)
  assert.equal(JSON.stringify(manifest.git.changes).includes('node_modules'), false)
  assert.equal(manifest.excluded.length, 1)
  db.close()
})
