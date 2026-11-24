import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { openLedger, createTask, getTask } from '../src/ledger.js'
import { collectArtifactStage, inspectGit } from '../src/artifact-stage.js'
import { tempDir, sampleBrief } from './helpers.js'

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

test('显式文件超过面板容量仍全部保存到清单，软链接和目录不递归复制', async () => {
  const cwd = tempDir()
  const db = await openLedger(tempDir())
  const task = createTask(db, { brief: sampleBrief(), artifactRoot: tempDir(), targetDir: cwd })
  const files = Array.from({ length: 60 }, (_, n) => `${n}.txt`)
  for (const file of files) writeFileSync(join(cwd, file), file)
  const outside = tempDir()
  writeFileSync(join(outside, 'secret'), 'secret')
  symlinkSync(outside, join(cwd, 'link'))
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
  const git = async args => ({ ok: true, stdout: args[0] === 'status' ? '?? code.js\0' : args.includes('--show-toplevel') ? cwd : 'head', spawnError: null })
  const stage = await collectArtifactStage({ db, task, cwd, changedFiles: ['code.js'], artifacts: [{ path: join(cwd, 'report.md'), label: '报告' }], key: 'git', run: git })
  assert.equal(stage.mode, 'git')
  assert.equal(stage.files.find(f => f.source.endsWith('code.js')).path, null)
  assert.equal(stage.git.unarchived, true)
  assert.equal(stage.artifacts.some(a => a.path.includes('/docs/')), true)
  const unknown = await collectArtifactStage({ db, task, cwd, key: 'unknown', run: async () => ({ ok: false, spawnError: 'ENOENT' }) })
  assert.equal(unknown.mode, 'unknown')
  assert.equal(unknown.complete, false)
  db.close()
})
