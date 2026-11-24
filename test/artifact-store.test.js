import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir, sampleBrief, linkDirectory, DIRECTORY_LINK_SKIP_REASON } from './helpers.js'
import { openLedger, createTask, getTask } from '../src/ledger.js'
import { ensureArtifactDirectory, saveArtifactDocument } from '../src/artifact-store.js'

test('任务文档保留版本，调用重放幂等，任务产物目录独立于工作目录', async () => {
  const main = tempDir()
  const db = await openLedger(tempDir())
  const task = createTask(db, { brief: sampleBrief(), targetDir: tempDir(), artifactRoot: main })
  const first = saveArtifactDocument({ db, task, name: '报告', content: '第一版', callId: 'a' })
  const replay = saveArtifactDocument({ db, task, name: '报告', content: '第一版', callId: 'a' })
  const second = saveArtifactDocument({ db, task, name: '报告', content: '第二版', callId: 'b' })
  assert.equal(first.path, replay.path)
  assert.notEqual(first.path, second.path)
  assert.equal(readFileSync(first.path, 'utf8'), '第一版')
  assert.equal(getTask(db, task.id).artifact_dir, join(realpathSync(main), 'artifacts', task.id))
  assert.equal(getTask(db, task.id).artifacts.length, 2)
  assert.throws(() => saveArtifactDocument({ db, task, name: '../escape', content: 'x' }))
  const fixed = getTask(db, task.id).artifact_dir
  ensureArtifactDirectory(db, task, tempDir())
  assert.equal(getTask(db, task.id).artifact_dir, fixed)
  db.close()
})

test('保存后登记前中断可补登记，同调用内容变化及产物目录软链接被拒', async t => {
  const db = await openLedger(tempDir())
  const task = createTask(db, { brief: sampleBrief(), artifactRoot: tempDir() })
  const args = { db, task, name: '报告', content: '原文', callId: 'call' }
  const saved = saveArtifactDocument(args)
  db.prepare('UPDATE tasks SET artifacts_json = ? WHERE id = ?').run('[]', task.id)
  assert.equal(saveArtifactDocument(args).path, saved.path)
  assert.equal(getTask(db, task.id).artifacts.length, 1)
  assert.throws(() => saveArtifactDocument({ ...args, content: '新内容' }))
  const docs = join(getTask(db, task.id).artifact_store_dir, 'docs')
  rmSync(docs, { recursive: true })
  // docs 换成指向库外的目录链接：真符号链接优先，没权限时退 Windows junction（`secureDirectory`
  // 用 lstat 判「不是普通目录」，两种链接都该被拒）。都没有链接能力时才跳过这半条。
  const kind = linkDirectory(tempDir(), docs)
  if (kind === undefined) {
    db.close()
    return t.skip(DIRECTORY_LINK_SKIP_REASON)
  }
  assert.throws(() => saveArtifactDocument({ ...args, callId: 'new' }))
  db.close()
})

test('初始化失败不留下可派发任务', async () => {
  const root = tempDir()
  writeFileSync(join(root, 'artifacts'), 'not a directory')
  const db = await openLedger(tempDir())
  assert.throws(() => createTask(db, { brief: sampleBrief(), artifactRoot: root }))
  assert.equal(db.prepare('SELECT count(*) AS n FROM tasks').get().n, 0)
  db.close()
})
