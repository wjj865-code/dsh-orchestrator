import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openLedger, setSetting, getSetting } from '../src/ledger.js'
import { redactRemote, scanWorkspaces, saveWorkspaceIndex, loadWorkspaceIndex, registeredWorkspaces } from '../src/workspace-index.js'
import { createOnboarding, onboardingKey, ONBOARDING_PROMPT } from '../src/onboarding.js'

const entries = [{ id: 'ws-1', title: '项目别名', path: '/work/repo' }]
const result = () => ({ entries: [{ ...entries[0], status: 'git', sampledAt: new Date().toISOString(), repoRoot: '/work/repo', branch: 'main', head: 'abc', origin: 'https://user:token@host/repo?token=secret#secret', commonDir: '/work/repo/.git' }] })

test('remote 脱敏涵盖 URL、scp、未知格式', () => {
  assert.equal(redactRemote('https://user:password@host/repo?token=secret#key'), 'https://host/repo')
  assert.equal(redactRemote('git@host:team/repo.git'), 'host:team/repo.git')
  assert.equal(redactRemote('token@bad'), '[remote 已隐藏]')
  assert.equal(redactRemote('/local/repo.git'), '/local/repo.git')
})

test('只扫描登记名单，单项非仓库/不存在/无权限继续，git只读无网络', async () => {
  const calls = []
  const list = [...entries, { id: 'plain', path: '/plain' }, { id: 'missing', path: '/missing' }, { id: 'denied', path: '/denied' }]
  const snapshot = await scanWorkspaces(list, {
    isDirectory: path => { if (path === '/missing') throw new Error('ENOENT'); return true },
    git: async (args, options) => {
      calls.push([args, options.cwd])
      if (options.cwd === '/plain') return { ok: false, stderr: 'not a git repository' }
      if (options.cwd === '/denied') throw new Error('EACCES')
      return { ok: true, stdout: args.includes('remote.origin.url') ? 'https://token@host/repo?secret=x' : '/work/repo' }
    },
  })
  assert.deepEqual(snapshot.entries.map(entry => entry.status), ['git', 'not_git', 'unavailable', 'unavailable'])
  assert.equal(snapshot.entries[0].origin, 'https://host/repo')
  assert.ok(calls.every(([args]) => !args.some(arg => ['fetch', 'pull', 'status', 'add', 'commit'].includes(arg))))
})


test('spawn blocked (EPERM) falls back to fs and still reports real git state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-index-fs-'))
  const { execFileSync } = await import('node:child_process')
  const repo = join(root, 'repo')
  execFileSync('git', ['init', '-q', repo])
  execFileSync('git', ['-C', repo, 'config', 'user.email', 't@e.st'])
  execFileSync('git', ['-C', repo, 'config', 'user.name', 't'])
  execFileSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'init'])
  const plain = join(root, 'plain')
  mkdirSync(plain, { recursive: true })
  const list = [{ id: 'git', title: 'repo', path: repo }, { id: 'p', title: 'plain', path: plain }]
  const blocked = async () => ({ ok: false, spawnError: 'EPERM', stdout: '', stderr: '' })
  const snapshot = await scanWorkspaces(list, { git: blocked })
  assert.deepEqual(snapshot.entries.map(e => e.status), ['git', 'not_git'])
  assert.equal(snapshot.entries[0].repoRoot, repo)
  assert.ok(snapshot.entries[0].head && snapshot.entries[0].head.length >= 7)
})

test('名单持久化到settings保留别名和采样，验证覆盖/身份，手写记忆不变', async () => {
  const db = await openLedger(mkdtempSync(join(tmpdir(), 'orch-index-')))
  const task = { id: 't-index', read_only: true, brief: { workspaceIndexEntries: entries } }
  const snapshot = saveWorkspaceIndex(db, task, JSON.stringify(result()))
  assert.deepEqual(loadWorkspaceIndex(db), snapshot)
  assert.equal(snapshot.entries[0].title, '项目别名')
  assert.equal(snapshot.entries[0].origin, 'https://host/repo')
  assert.equal(db.prepare('SELECT count(*) AS n FROM memories').get().n, 0)
  assert.throws(() => saveWorkspaceIndex(db, task, '{bad'))
  assert.throws(() => saveWorkspaceIndex(db, task, JSON.stringify({ entries: [] })))
  assert.throws(() => saveWorkspaceIndex(db, { ...task, read_only: false }, JSON.stringify(result())))
  assert.throws(() => registeredWorkspaces(undefined))
  db.close()
})

test('索引快照与成功标记写入失败时原子回滚', async () => {
  const db = await openLedger(mkdtempSync(join(tmpdir(), 'orch-index-atomic-')))
  setSetting(db, 'workspace_repo_index', 'old')
  const task = { id: 't-atomic', read_only: true, brief: { workspaceIndexEntries: entries } }
  const failingDb = {
    exec: sql => db.exec(sql),
    prepare: sql => {
      const statement = db.prepare(sql)
      return { run(...args) {
        if (args[0] === 'workspace_index_saved:t-atomic') throw new Error('disk full')
        return statement.run(...args)
      } }
    },
  }
  assert.throws(() => saveWorkspaceIndex(failingDb, task, JSON.stringify(result())), /disk full/)
  assert.equal(getSetting(db, 'workspace_repo_index'), 'old')
  assert.equal(getSetting(db, 'workspace_index_saved:t-atomic'), undefined)
  db.close()
})

test('欢迎等待预设恢复信号；失败/缺选择服务不投递，并发只一次', async () => {
  const db = await openLedger(mkdtempSync(join(tmpdir(), 'orch-ready-')))
  let resolve
  const ready = new Promise(done => { resolve = done })
  let calls = 0
  const agent = { steer() { calls += 1 } }
  const onboarding = createOnboarding({ db, resolveAgent: () => agent, ensurePreset: () => ready })
  setSetting(db, onboardingKey('new'), 'pending')
  const a = onboarding.start('new')
  const b = onboarding.start('new')
  assert.equal(calls, 0, '不能以延迟假定预设已就绪')
  resolve(true)
  await Promise.all([a, b])
  assert.equal(calls, 1)
  setSetting(db, onboardingKey('failed'), 'pending')
  const failed = createOnboarding({ db, resolveAgent: () => agent, ensurePreset: async () => false })
  assert.equal((await failed.start('failed')).ok, false)
  assert.equal(calls, 1)
  assert.equal((await createOnboarding({ db, resolveAgent: () => agent }).start('failed')).ok, false)
  db.close()
})

test('首次启动一次，老会话重开不欢迎，失败可重试、不并发重复', async () => {
  const db = await openLedger(mkdtempSync(join(tmpdir(), 'orch-welcome-')))
  let count = 0
  let fail = true
  const agent = { steer(message) { if (fail) throw new Error('not ready'); count += 1; assert.match(message.content[0].text, /介绍后立即调用 task_create/)} }
  const onboarding = createOnboarding({ db, resolveAgent: () => agent, ensurePreset: async () => true })
  assert.equal((await onboarding.start('old')).skipped, true)
  setSetting(db, onboardingKey('new'), 'pending')
  assert.equal((await onboarding.start('new')).ok, false)
  fail = false
  assert.equal((await onboarding.start('new')).ok, true)
  assert.equal((await onboarding.start('new')).skipped, true)
  assert.equal(count, 1)
  assert.match(ONBOARDING_PROMPT, /readOnly:true,worktree:false/)
  assert.match(ONBOARDING_PROMPT, /先向用户简短介绍/)
  db.close()
})
