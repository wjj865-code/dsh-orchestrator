import test from 'node:test'
import assert from 'node:assert/strict'
import { artifactProtection } from '../src/artifact-protection.js'
import { createDispatcher } from '../src/dispatch.js'
import { openLedger, createTask, getTask } from '../src/ledger.js'
import { saveArtifactDocument } from '../src/artifact-store.js'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir, sampleBrief, linkDirectory, DIRECTORY_LINK_SKIP_REASON } from './helpers.js'

test('私有库覆盖检查包含默认写根、显式根、临时目录和目标；未知策略拒绝', () => {
  const policy = { mode: 'workspace-write', workspaceRoot: '/private/workspace' }
  const store = '/private/orchestrator/artifact-store/t-test'
  assert.equal(artifactProtection({ store, policy, temporaryRoots: [] }).protected, true)
  assert.equal(artifactProtection({ store, policy: { ...policy, workspaceRoot: '/private' }, temporaryRoots: [] }).ok, false)
  assert.equal(artifactProtection({ store, policy: { ...policy, additionalWritableRoots: ['/private/orchestrator'] }, temporaryRoots: [] }).ok, false)
  assert.equal(artifactProtection({ store, policy, target: store, temporaryRoots: [] }).ok, false)
  assert.equal(artifactProtection({ store, policy, temporaryRoots: ['/private'] }).ok, false)
  assert.equal(artifactProtection({ store }).ok, false)
  assert.equal(artifactProtection({ store, policy: { mode: 'read-only' } }).protected, true)
  assert.equal(artifactProtection({ store, policy: { mode: 'danger-full-access' } }).protected, false)
})

test('展示引用改写不影响保存真源，文档登记只引用私有版本', async () => {
  const db = await openLedger(tempDir())
  const main = tempDir()
  const task = createTask(db, { artifactRoot: main, brief: sampleBrief() })
  const latest = getTask(db, task.id)
  assert.notEqual(latest.artifact_store_dir, latest.artifact_dir)
  const first = saveArtifactDocument({ db, task, mainDir: main, name: '报告', content: 'first', callId: 'first' })
  writeFileSync(join(latest.artifact_dir, 'storage.json'), '{"store":"/wrong"}')
  const next = saveArtifactDocument({ db, task, mainDir: main, name: '报告', content: 'next', callId: 'next' })
  assert.equal(readFileSync(first.path, 'utf8'), 'first')
  assert.ok(next.path.startsWith(latest.artifact_store_dir))
  assert.ok(getTask(db, task.id).artifacts.every(a => a.path.startsWith(latest.artifact_store_dir)))
  db.close()
})

test('符号链接写根按真实路径核验，不借路径别名逃过保护检查', t => {
  const base = tempDir()
  const alias = join(tempDir(), 'alias')
  // 目录链接即可覆盖这条不变量：真符号链接（Linux/CI、开了开发者模式的 Windows）优先，
  // 没权限时退 Windows junction——两者 realpath 都解析到 base，判据完全一样。
  const kind = linkDirectory(base, alias)
  if (kind === undefined) return t.skip(DIRECTORY_LINK_SKIP_REASON)
  assert.equal(artifactProtection({
    store: join(base, 'artifact-store'),
    policy: { mode: 'workspace-write', workspaceRoot: alias }, temporaryRoots: [],
  }).ok, false)
})

test('保护检查拒绝时不启动会话、不发送追问', async () => {
  let calls = 0
  const dispatcher = createDispatcher({
    agent: { id: 'main', session: { header: { cwd: '/private/main' } } },
    subagents: { startActivation: async () => { calls++ }, sendMessage: async () => { calls++ } },
    artifactProtectionJudge: () => ({ ok: false, reason: '私有库被覆盖' }),
  })
  await assert.rejects(dispatcher.spawn({ taskId: 'task', prompt: 'work', cwd: '/private/main' }), /私有库/)
  await assert.rejects(dispatcher.send('child', 'work', undefined, '/private/main', 'task', false), /私有库/)
  assert.equal(calls, 0)
})
