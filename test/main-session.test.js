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
    presetFor: () => PRESET_ID,
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
  assert.deepEqual(result, { ok: true, sessionId: 'session-main-new', created: true, agentPreset: undefined })
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
  const main = createMainSession({ db, config: {}, agents: f.agents, sessionController: f.sessionController, presetFor: f.presetFor, workspacePath: 'C:/ws' })
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

test('并发 open 只创建一次主会话，两个调用拿到同一个结果', async () => {
  const db = await ledger()
  const f = fake()
  let release
  const gate = new Promise(resolve => { release = resolve })
  f.sessionController.create = async request => {
    f.created.push(request)
    await gate
    return { sessionId: 'session-main-new' }
  }
  const main = createMainSession({ db, config: {}, agents: f.agents, sessionController: f.sessionController, workspaces: f.workspaces, workspacePath: 'C:/ws' })
  const first = main.open()
  const second = main.open()
  release()
  const [a, b] = await Promise.all([first, second])
  assert.equal(f.created.length, 1)
  assert.deepEqual(a, b)
  assert.equal(getMainSessionId(db), 'session-main-new')
  db.close()
})

test('创建失败后 in-flight 清掉，可以再点一次成功', async () => {
  const db = await ledger()
  const f = fake()
  let attempts = 0
  f.sessionController.create = async () => {
    attempts += 1
    if (attempts === 1) throw new Error('boom')
    return { sessionId: 'session-main-new' }
  }
  const main = createMainSession({ db, config: {}, agents: f.agents, sessionController: f.sessionController, workspaces: f.workspaces, workspacePath: 'C:/ws' })
  const failed = await main.open()
  assert.equal(failed.ok, false)
  const retried = await main.open()
  assert.equal(retried.ok, true)
  assert.equal(retried.sessionId, 'session-main-new')
  assert.equal(attempts, 2)
  db.close()
})


test('resolveByPath 异步 reject（指挥舱目录还不存在）时先 mkdir 再创建，不产生未处理拒绝', async () => {
  const db = await ledger()
  const f = fake()
  let unhandled = 0
  const onUnhandled = () => { unhandled += 1 }
  process.on('unhandledRejection', onUnhandled)
  try {
    // 平台 resolveByPath 是 async，目录不存在时 realpath reject ENOENT；同步 try/catch 接不住。
    f.workspaces.resolveByPath = () => Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    const workspacePath = join(mkdtempSync(join(tmpdir(), 'orch-ws-')), 'workspace')
    const main = createMainSession({ db, config: {}, agents: f.agents, sessionController: f.sessionController, workspaces: f.workspaces, workspacePath, workspaceName: '指挥舱' })
    const result = await main.open()
    assert.equal(result.ok, true)
    assert.deepEqual(f.workspacesCreated, [[workspacePath, '指挥舱']])
    assert.equal(f.created[0].workspaceId, 'ws-new')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(unhandled, 0, '不应产生 unhandledRejection（会打挂宿主）')
  } finally {
    process.removeListener('unhandledRejection', onUnhandled)
    db.close()
  }
})

test('resolveByPath 返回 Promise 但目录已存在时直接复用工作区', async () => {
  const db = await ledger()
  const f = fake()
  f.workspaces.resolveByPath = async () => ({ id: 'ws-1', path: 'C:/ws' })
  const main = createMainSession({ db, config: {}, agents: f.agents, sessionController: f.sessionController, workspaces: f.workspaces, workspacePath: 'C:/ws' })
  const result = await main.open()
  assert.equal(result.ok, true)
  assert.equal(f.created[0].workspaceId, 'ws-1')
  assert.deepEqual(f.workspacesCreated, [])
  db.close()
})


test('open() 对调用方永不 reject：台账写主会话失败时返回可读错误，且无 unhandledRejection', async () => {
  const f = fake()
  const db = {
    prepare(sql) {
      if (sql.includes('SELECT value FROM settings')) return { get: () => undefined }
      if (sql.includes('INSERT INTO settings')) return { run: () => { throw new Error('disk full') } }
      throw new Error('unexpected SQL: ' + sql)
    },
  }
  let unhandled = 0
  const onUnhandled = () => { unhandled += 1 }
  process.on('unhandledRejection', onUnhandled)
  try {
    const main = createMainSession({ db, config: {}, agents: f.agents, sessionController: f.sessionController, workspaces: f.workspaces, workspacePath: 'C:/ws' })
    const result = await main.open()
    assert.equal(result.ok, false)
    assert.match(result.error, /disk full/)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(unhandled, 0)
  } finally {
    process.removeListener('unhandledRejection', onUnhandled)
  }
})


test('live 主会话预设不是协调者时重建一次，不迁移旧会话', async () => {
  const db = await ledger()
  const f = fake({ live: new Set(['session-old']) })
  f.presetFor = () => 'standard'
  setMainSessionId(db, 'session-old')
  const logs = []
  const main = createMainSession({ db, config: {}, agents: f.agents, sessionController: f.sessionController, workspaces: f.workspaces, presetFor: f.presetFor, workspacePath: 'C:/ws', log: (event, detail) => logs.push([event, detail]) })
  const result = await main.open()
  assert.equal(result.ok, true)
  assert.equal(result.created, true)
  assert.equal(result.sessionId, 'session-main-new')
  assert.equal(getMainSessionId(db), 'session-main-new')
  assert.ok(logs.some(([event, detail]) => event === 'main.session.recreate' && detail.reason === 'preset-mismatch' && detail.preset === 'standard'))
  db.close()
})

test('live 主会话没有记录预设时也重建', async () => {
  const db = await ledger()
  const f = fake({ live: new Set(['session-old']) })
  f.presetFor = () => undefined
  setMainSessionId(db, 'session-old')
  const main = createMainSession({ db, config: {}, agents: f.agents, sessionController: f.sessionController, workspaces: f.workspaces, presetFor: f.presetFor, workspacePath: 'C:/ws' })
  const result = await main.open()
  assert.equal(result.created, true)
  db.close()
})

test('live 主会话预设就是协调者时复用，不重建', async () => {
  const db = await ledger()
  const f = fake({ live: new Set(['session-old']) })
  setMainSessionId(db, 'session-old')
  const main = createMainSession({ db, config: {}, agents: f.agents, sessionController: f.sessionController, workspaces: f.workspaces, presetFor: f.presetFor, workspacePath: 'C:/ws' })
  const result = await main.open()
  assert.equal(result.ok, true)
  assert.equal(result.created, false)
  assert.equal(result.sessionId, 'session-old')
  assert.equal(result.agentPreset, PRESET_ID)
  assert.equal(f.created.length, 0)
  db.close()
})

test('open() 回传平台返回的 agentPreset 并写进创建日志', async () => {
  const db = await ledger()
  const f = fake()
  const logs = []
  f.sessionController.create = async request => { f.created.push(request); return { sessionId: 'session-main-new', agentPreset: PRESET_ID } }
  const main = createMainSession({ db, config: {}, agents: f.agents, sessionController: f.sessionController, workspaces: f.workspaces, presetFor: f.presetFor, workspacePath: 'C:/ws', log: (event, detail) => logs.push([event, detail]) })
  const result = await main.open()
  assert.equal(result.agentPreset, PRESET_ID)
  assert.ok(logs.some(([event, detail]) => event === 'main.session.created' && detail.agentPreset === PRESET_ID))
  db.close()
})

test('presetFor 用 session.header.agentPreset 兜底', async () => {
  const db = await ledger()
  const f = fake({ live: new Set(['session-old']) })
  f.agents.get = id => id === 'session-old' ? { id, session: { id, header: { agentPreset: PRESET_ID } } } : undefined
  setMainSessionId(db, 'session-old')
  const main = createMainSession({ db, config: {}, agents: f.agents, sessionController: f.sessionController, workspaces: f.workspaces, workspacePath: 'C:/ws' })
  const result = await main.open()
  assert.equal(result.created, false)
  db.close()
})
