import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openLedger, getMainSessionId, setMainSessionId } from '../src/ledger.js'
import { createMainSession, PRESET_ID } from '../src/main-session.js'

const fake = ({ live = new Set() } = {}) => {
  const created = []
  const renamed = []
  const workspacesCreated = []
  const set = new Set(live)
  return {
    created,
    renamed,
    workspacesCreated,
    agents: { get: id => set.has(id) ? { id, session: { id } } : undefined },
    sessionController: {
      create: async request => { created.push(request); return { sessionId: 'session-main-new' } },
      rename: async request => { renamed.push(request) },
    },
    // 工作区 API 是位置参数：resolveByPath(path) 查、create(path, title?) 建。
    workspaces: {
      resolveByPath: () => undefined,
      create: async (path, title) => { workspacesCreated.push([path, title]); return { id: 'ws-new' } },
    },
  }
}

const ledger = () => openLedger(mkdtempSync(join(tmpdir(), 'orch-main-')))

test('无主会话时创建（工作区 + 预设）并写台账', async () => {
  const db = await ledger()
  const f = fake()
  const main = createMainSession({
    db, config: {}, agents: f.agents, sessionController: f.sessionController,
    workspaces: f.workspaces, workspacePath: 'C:/ws', workspaceName: '指挥舱',
  })
  const result = await main.open()
  assert.deepEqual(result, { ok: true, sessionId: 'session-main-new', created: true })
  assert.equal(getMainSessionId(db), 'session-main-new')
  assert.equal(f.created[0].agentPreset, PRESET_ID)
  assert.equal('title' in f.created[0], false)
  assert.deepEqual(f.workspacesCreated, [['C:/ws', '指挥舱']])
  assert.deepEqual(f.renamed, [{ sessionId: 'session-main-new', title: '主会话' }])
  db.close()
})

test('已有指挥舱工作区时复用，不重复建', async () => {
  const db = await ledger()
  const f = fake()
  f.workspaces.resolveByPath = path => path === 'C:/ws' ? { id: 'ws-1', path } : undefined
  const main = createMainSession({ db, config: {}, agents: f.agents, sessionController: f.sessionController, workspaces: f.workspaces, workspacePath: 'C:/ws' })
  const result = await main.open()
  assert.equal(result.created, true)
  assert.equal(f.created[0].workspaceId, 'ws-1')
  assert.deepEqual(f.workspacesCreated, [])
  db.close()
})

test('spawnProvider 不是 spawn 时拒绝创建并给可读原因', async () => {
  const db = await ledger()
  const f = fake()
  const main = createMainSession({ db, config: { spawnProvider: 'fork' }, agents: f.agents, sessionController: f.sessionController, workspaces: f.workspaces, workspacePath: 'C:/ws' })
  const result = await main.open()
  assert.equal(result.ok, false)
  assert.match(result.error, /spawn/)
  assert.equal(f.created.length, 0)
  assert.equal(getMainSessionId(db), undefined)
  db.close()
})

test('主会话 live 时直接返回，不重复创建', async () => {
  const db = await ledger()
  const f = fake({ live: new Set(['session-main-old']) })
  f.agents.get = id => id === 'session-main-old' ? { id } : undefined
  setMainSessionId(db, 'session-main-old')
  const main = createMainSession({ db, config: {}, agents: f.agents, sessionController: f.sessionController, workspacePath: 'C:/ws' })
  const result = await main.open()
  assert.equal(result.created, false)
  assert.equal(result.sessionId, 'session-main-old')
  assert.equal(f.created.length, 0)
  db.close()
})

test('主会话失效时重建；创建失败不写台账', async () => {
  const db = await ledger()
  const f = fake()
  f.sessionController.create = async () => { throw new Error('boom') }
  const main = createMainSession({ db, config: {}, agents: f.agents, sessionController: f.sessionController, workspacePath: 'C:/ws' })
  const result = await main.open()
  assert.equal(result.ok, false)
  assert.match(result.error, /boom/)
  assert.equal(getMainSessionId(db), undefined)
  db.close()
})

test('配置覆盖优先，失效时返回错误不创建', async () => {
  const db = await ledger()
  const f = fake()
  const main = createMainSession({ db, config: { coordinatorSession: 'session-override' }, agents: f.agents, sessionController: f.sessionController, workspacePath: 'C:/ws' })
  const result = await main.open()
  assert.equal(result.ok, false)
  assert.match(result.error, /session-override/)
  assert.equal(f.created.length, 0)
  db.close()
})

test('rename 失败不影响主会话创建（只记日志）', async () => {
  const db = await ledger()
  const f = fake()
  const logs = []
  f.sessionController.rename = async () => { throw new Error('no session-title service') }
  const main = createMainSession({ db, config: {}, agents: f.agents, sessionController: f.sessionController, workspaces: f.workspaces, workspacePath: 'C:/ws', log: (event, detail) => logs.push([event, detail]) })
  const result = await main.open()
  assert.equal(result.ok, true)
  assert.equal(getMainSessionId(db), 'session-main-new')
  assert.deepEqual(logs.map(item => item[0]), ['main.session.rename.failed', 'main.session.created'])
  db.close()
})

test('没有 workspaceRegistry（undefined）时也能创建主会话', async () => {
  const db = await ledger()
  const f = fake()
  const main = createMainSession({ db, config: {}, agents: f.agents, sessionController: f.sessionController, workspacePath: 'C:/ws' })
  const result = await main.open()
  assert.equal(result.ok, true)
  assert.equal('workspaceId' in f.created[0], true)
  assert.equal(f.created[0].workspaceId, undefined)
  db.close()
})
