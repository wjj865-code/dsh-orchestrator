import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openLedger, createTask, getSetting, getMainSessionId, setMainSessionId, getMainSessionPreset, setMainSessionPreset, setSetting, getCoordinatorIds, setCoordinatorIds } from '../src/ledger.js'
import { createMainSession, PRESET_ID } from '../src/main-session.js'
import { onboardingKey } from '../src/onboarding.js'

const fake = ({ live = new Set() } = {}) => {
  const created = []
  const renamed = []
  const workspacesCreated = []
  const set = new Set(live)
  return {
    created,
    renamed,
    workspacesCreated,
    live: set,
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

test('0.36.0：首位（主协调者）失效时原位替换，其余名单成员原样保留、名单长度不变', async () => {
  const db = await ledger()
  setCoordinatorIds(db, ['session-dead', 'session-b', 'session-c'])
  const f = fake({ live: ['session-b'] })
  const main = createMainSession({ db, config: {}, agents: f.agents, sessionController: f.sessionController, workspacePath: 'C:/ws' })
  const result = await main.open()
  assert.equal(result.ok, true)
  assert.equal(result.sessionId, 'session-main-new')
  assert.deepEqual(getCoordinatorIds(db), ['session-main-new', 'session-b', 'session-c'], '原位替换首位，不增长名单')
  assert.equal(getMainSessionId(db), 'session-main-new')
  assert.equal(f.created.length, 1)
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

// onOpened 的契约是 0.25.0 真机验证里踩到的坑：消费方（index 的压力观测）只认 `result.ok === true`，
// 而调用点回传的是轻量描述（没有 ok），于是「打开主会话 → 观测 → 压力提醒」整条链在真机上从不触发。
// 这里把契约钉死：新建与复用两条路都必须给 onOpened 一个与 open() 同形的 result（ok:true + sessionId）。
test('onOpened 契约：新建/复用都给 ok:true + sessionId（压力观测依赖它）', async () => {
  const created = await ledger()
  const f = fake()
  const onCreated = []
  const mainCreated = createMainSession({
    db: created, config: {}, agents: f.agents, sessionController: f.sessionController,
    workspaces: f.workspaces, workspacePath: 'C:/ws',
    onOpened: args => { onCreated.push(args) },
  })
  await mainCreated.open()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(onCreated.length, 1)
  assert.deepEqual(
    { ok: onCreated[0].result.ok, sessionId: onCreated[0].result.sessionId, created: onCreated[0].result.created, agent: onCreated[0].agent },
    { ok: true, sessionId: 'session-main-new', created: true, agent: undefined },
  )
  created.close()

  const reused = await ledger()
  const g = fake({ live: new Set(['session-main-old']) })
  g.presetFor = () => PRESET_ID
  setMainSessionId(reused, 'session-main-old')
  setMainSessionPreset(reused, PRESET_ID)
  const onReused = []
  const mainReused = createMainSession({
    db: reused, config: {}, agents: g.agents, sessionController: g.sessionController,
    presetFor: g.presetFor, workspacePath: 'C:/ws',
    onOpened: args => { onReused.push(args) },
  })
  await mainReused.open()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(onReused.length, 1)
  assert.equal(onReused[0].result.ok, true)
  assert.equal(onReused[0].result.sessionId, 'session-main-old')
  assert.equal(onReused[0].agent?.id, 'session-main-old')
  reused.close()
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

test('live 主会话预设就是协调者时复用，不重建，并记台账标记', async () => {
  const db = await ledger()
  const f = fake({ live: new Set(['session-old']) })
  setMainSessionId(db, 'session-old')
  const main = createMainSession({ db, config: {}, agents: f.agents, sessionController: f.sessionController, workspaces: f.workspaces, presetFor: f.presetFor, workspacePath: 'C:/ws' })
  const result = await main.open()
  assert.equal(result.ok, true)
  assert.equal(result.created, false)
  assert.equal(result.sessionId, 'session-old')
  assert.equal(result.agentPreset, PRESET_ID)
  assert.equal(getMainSessionPreset(db), PRESET_ID)
  assert.equal(f.created.length, 0)
  db.close()
})

test('台账标记是协调者时：读回 standard 也不重建，并 select 拉回预设', async () => {
  const db = await ledger()
  const f = fake({ live: new Set(['session-old']) })
  f.presetFor = () => 'standard'
  const selected = []
  f.agents.get = id => id === 'session-old' ? { id, session: { id } } : undefined
  setMainSessionId(db, 'session-old')
  setMainSessionPreset(db, PRESET_ID)
  const main = createMainSession({
    db, config: {}, agents: f.agents, sessionController: f.sessionController, workspaces: f.workspaces,
    presetFor: f.presetFor,
    selectPreset: (agent, presetId) => { selected.push([agent.id, presetId]); return Promise.resolve(presetId) },
    workspacePath: 'C:/ws',
  })
  const result = await main.open()
  assert.equal(result.ok, true)
  assert.equal(result.created, false)
  assert.equal(result.sessionId, 'session-old')
  assert.equal(result.presetMismatch, true)
  assert.deepEqual(selected, [['session-old', PRESET_ID]])
  assert.equal(f.created.length, 0)
  db.close()
})

test('非空白会话 select 抛 locked：吞掉并复用，不重建', async () => {
  const db = await ledger()
  const f = fake({ live: new Set(['session-old']) })
  f.presetFor = () => 'standard'
  const logs = []
  setMainSessionId(db, 'session-old')
  setMainSessionPreset(db, PRESET_ID)
  const main = createMainSession({
    db, config: {}, agents: f.agents, sessionController: f.sessionController, workspaces: f.workspaces,
    presetFor: f.presetFor,
    selectPreset: () => Promise.reject(new Error('agent-preset/locked: this session has already started')),
    workspacePath: 'C:/ws',
    log: (event, detail) => logs.push([event, detail]),
  })
  const result = await main.open()
  assert.equal(result.ok, true)
  assert.equal(result.created, false)
  assert.equal(result.sessionId, 'session-old')
  assert.ok(logs.some(([event]) => event === 'main.session.preset-locked'))
  db.close()
})

test('连续两次 open：第二次复用同一 id，不再 create', async () => {
  const db = await ledger()
  const f = fake()
  const main = createMainSession({ db, config: {}, agents: f.agents, sessionController: f.sessionController, workspaces: f.workspaces, presetFor: f.presetFor, workspacePath: 'C:/ws' })
  const first = await main.open()
  assert.equal(first.created, true)
  const newId = first.sessionId
  f.live.add(newId)
  const second = await main.open()
  assert.equal(second.ok, true)
  assert.equal(second.created, false)
  assert.equal(second.sessionId, newId)
  assert.equal(f.created.length, 1)
  assert.equal(getMainSessionPreset(db), PRESET_ID)
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

// ---------------------------------------------------------------------------
// 0.25.0：adopt（把已有会话设为协调者）/ 代建（压力提醒里的「新建协调者会话」）
//
// 语义：只切指针。旧会话不改名、不归档、不退役（用户随时能回去看）。
// ---------------------------------------------------------------------------
const COCKPIT = 'C:/orch/workspace'

/** adopt 用的替身：sessions 里带 header（cwd + agentPreset），agents 只对 live 集合可见。 */
const adoptFake = ({ live = [], cwd = COCKPIT, preset = PRESET_ID, select } = {}) => {
  const created = []
  const renamed = []
  const selected = []
  const set = new Set(live)
  const sessions = new Map([...set].map(id => [id, { id, header: { id, cwd, agentPreset: preset } }]))
  return {
    created,
    renamed,
    selected,
    sessions,
    agents: { get: id => set.has(id) ? { id, session: sessions.get(id) } : undefined },
    presetFor: () => preset,
    sessionController: {
      create: async request => { created.push(request); return { sessionId: 'session-new' } },
      rename: async request => { renamed.push(request) },
    },
    workspaces: {
      resolveByPath: async () => ({ id: 'ws-1' }),
      create: async (path, title) => ({ id: 'ws-new', path, title }),
    },
    sessionsService: { get: id => sessions.get(id) },
    selectPreset: select ?? (async (agent, id) => { selected.push([agent.id, id]); return id }),
  }
}

const adoptMain = (db, f, extras = {}) => createMainSession({
  db,
  config: {},
  agents: f.agents,
  sessionController: f.sessionController,
  workspaces: f.workspaces,
  sessions: f.sessionsService,
  presetFor: f.presetFor,
  selectPreset: f.selectPreset,
  workspacePath: COCKPIT,
  ...extras,
})

test('adopt：加入名单并提升为主（旧会话留在名单）+ 记审计 + 台账 preset 标记', async () => {
  const db = await ledger()
  const f = adoptFake({ live: ['session-old', 'session-new-target'] })
  setMainSessionId(db, 'session-old')
  setMainSessionPreset(db, 'stale-marker')
  const logs = []
  const main = adoptMain(db, f, { log: (event, detail) => logs.push([event, detail]) })
  const result = await main.adoptSession({ sessionId: 'session-new-target' })
  assert.deepEqual(result, {
    ok: true,
    sessionId: 'session-new-target',
    previous: 'session-old',
    ids: ['session-new-target', 'session-old'],
    primary: 'session-new-target',
    added: true,
    promoted: false,
  })
  assert.equal(getMainSessionId(db), 'session-new-target')
  assert.deepEqual(getCoordinatorIds(db), ['session-new-target', 'session-old'], '旧协调者留在名单里')
  assert.equal(getMainSessionPreset(db), PRESET_ID)
  assert.deepEqual(f.renamed, [], '旧会话不改名')
  assert.deepEqual(f.created, [], 'adopt 不建会话')
  const adopted = logs.find(([event]) => event === 'main.session.adopted')
  assert.ok(adopted, '要写 main.session.adopted 审计')
  assert.equal(adopted[1].previous, 'session-old')
  assert.equal(adopted[1].sessionId, 'session-new-target')
  db.close()
})

test('adopt：已在名单里的会话再设一次只提升为主，不重复占名额', async () => {
  const db = await ledger()
  const f = adoptFake({ live: ['s-a', 's-b'] })
  setCoordinatorIds(db, ['s-a', 's-b'])
  const main = adoptMain(db, f)
  const result = await main.adoptSession({ sessionId: 's-b' })
  assert.equal(result.ok, true)
  assert.equal(result.added, false)
  assert.equal(result.promoted, true)
  assert.deepEqual(result.ids, ['s-b', 's-a'])
  assert.equal(getMainSessionId(db), 's-b')
  db.close()
})

test('adopt：名单已满 4 个 → ADOPT_LIMIT，名单与指针都不动', async () => {
  const db = await ledger()
  setCoordinatorIds(db, ['s-1', 's-2', 's-3', 's-4'])
  const f = adoptFake({ live: ['s-1', 's-9'] })
  const main = adoptMain(db, f)
  const result = await main.adoptSession({ sessionId: 's-9' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'ADOPT_LIMIT')
  assert.equal(result.params.max, 4)
  assert.deepEqual(getCoordinatorIds(db), ['s-1', 's-2', 's-3', 's-4'])
  assert.equal(getMainSessionId(db), 's-1')
  db.close()
})

test('dropSession：删次位不动主；删首位下一位升主；删不存在给 DROP_NOT_FOUND；删光清两个键', async () => {
  const db = await ledger()
  const f = adoptFake({ live: ['s-a', 's-b'] })
  const logs = []
  const main = adoptMain(db, f, { log: (event, detail) => logs.push([event, detail]) })

  setCoordinatorIds(db, ['s-a', 's-b'])
  const secondary = await main.dropSession({ sessionId: 's-b' })
  assert.equal(secondary.ok, true)
  assert.deepEqual(secondary.ids, ['s-a'])
  assert.equal(secondary.primaryChanged, false)
  assert.equal(getMainSessionId(db), 's-a')

  setCoordinatorIds(db, ['s-a', 's-b'])
  const primary = await main.dropSession({ sessionId: 's-a' })
  assert.equal(primary.ok, true)
  assert.deepEqual(primary.ids, ['s-b'])
  assert.equal(primary.primary, 's-b')
  assert.equal(primary.primaryChanged, true)
  assert.equal(getMainSessionId(db), 's-b', '下一位升主（main_session_id 同步）')

  const missing = await main.dropSession({ sessionId: 's-zz' })
  assert.deepEqual([missing.ok, missing.code], [false, 'DROP_NOT_FOUND'])

  const empty = await main.dropSession({ sessionId: 's-b' })
  assert.deepEqual(empty.ids, [])
  assert.equal(empty.primary, null)
  assert.equal(getMainSessionId(db), undefined, '删光等价「尚未打开主会话」')
  const droppedLogs = logs.filter(([event]) => event === 'main.session.dropped')
  assert.equal(droppedLogs.length, 3)
  db.close()
})

test('adopt：同一会话幂等（unchanged，不重写台账）', async () => {
  const db = await ledger()
  const f = adoptFake({ live: ['session-old'] })
  setMainSessionId(db, 'session-old')
  const main = adoptMain(db, f)
  const result = await main.adoptSession({ sessionId: 'session-old' })
  assert.equal(result.ok, true)
  assert.equal(result.unchanged, true)
  db.close()
})

test('adopt：非「指挥舱」工作区的会话拒绝（ADOPT_NOT_COCKPIT）', async () => {
  const db = await ledger()
  const f = adoptFake({ live: ['session-other'], cwd: 'C:/somewhere/else' })
  setMainSessionId(db, 'session-old')
  const main = adoptMain(db, f)
  const result = await main.adoptSession({ sessionId: 'session-other' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'ADOPT_NOT_COCKPIT')
  assert.equal(result.params.workspace, COCKPIT)
  assert.equal(getMainSessionId(db), 'session-old', '失败不改指针')
  db.close()
})

test('adopt：agent 还没加载拒绝（ADOPT_NOT_LIVE）', async () => {
  const db = await ledger()
  const f = adoptFake({ live: [] })
  // 会话记录在 sessions 里（cwd 合法），但 agents.get 拿不到 → not live。
  f.sessions.set('session-cold', { id: 'session-cold', header: { id: 'session-cold', cwd: COCKPIT, agentPreset: PRESET_ID } })
  setMainSessionId(db, 'session-old')
  const main = adoptMain(db, f)
  const result = await main.adoptSession({ sessionId: 'session-cold' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'ADOPT_NOT_LIVE')
  db.close()
})

test('adopt：会话不存在拒绝（ADOPT_NO_SESSION）', async () => {
  const db = await ledger()
  const f = adoptFake({ live: [] })
  const main = adoptMain(db, f)
  const result = await main.adoptSession({ sessionId: 'session-missing' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'ADOPT_NO_SESSION')
  db.close()
})

test('adopt：已用其他预设开始（select 抛 locked）拒绝（ADOPT_PRESET_LOCKED）', async () => {
  const db = await ledger()
  const f = adoptFake({
    live: ['session-started'],
    preset: 'standard',
    select: async () => { throw new Error('agent-preset/locked: this session has already started') },
  })
  setMainSessionId(db, 'session-old')
  const main = adoptMain(db, f)
  const result = await main.adoptSession({ sessionId: 'session-started' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'ADOPT_PRESET_LOCKED')
  assert.equal(result.params.preset, 'standard')
  assert.equal(getMainSessionId(db), 'session-old')
  db.close()
})

test('adopt：空白会话被拉回协调者预设后才接受', async () => {
  const db = await ledger()
  const f = adoptFake({ live: ['session-blank'], preset: 'standard' })
  setMainSessionId(db, 'session-old')
  const main = adoptMain(db, f)
  const result = await main.adoptSession({ sessionId: 'session-blank' })
  assert.equal(result.ok, true)
  assert.deepEqual(f.selected, [['session-blank', PRESET_ID]])
  assert.equal(getMainSessionId(db), 'session-blank')
  db.close()
})

test('adopt：已有切换在进行时返回 ADOPT_BUSY（同一时刻只允许一次）', async () => {
  const db = await ledger()
  let release
  const gate = new Promise(resolve => { release = resolve })
  const f = adoptFake({
    live: ['session-a', 'session-b'],
    preset: 'standard',
    select: async () => { await gate; return PRESET_ID },
  })
  setMainSessionId(db, 'session-old')
  const main = adoptMain(db, f)
  const first = main.adoptSession({ sessionId: 'session-a' })
  const second = await main.adoptSession({ sessionId: 'session-b' })
  assert.equal(second.ok, false)
  assert.equal(second.code, 'ADOPT_BUSY')
  release()
  assert.equal((await first).ok, true)
  db.close()
})

test('代建：create → 切指针 → onboarding=sent → 改名 → 审计，旧会话零处置', async () => {
  const db = await ledger()
  const f = adoptFake({ live: ['session-old'] })
  setMainSessionId(db, 'session-old')
  const logs = []
  const main = adoptMain(db, f, { log: (event, detail) => logs.push([event, detail]) })
  const result = await main.createCoordinatorSession({ source: 'pressure-reminder' })
  assert.equal(result.ok, true)
  assert.equal(result.sessionId, 'session-new')
  assert.equal(result.previous, 'session-old')
  assert.equal(result.created, true)
  assert.equal(f.created.length, 1)
  assert.equal(f.created[0].agentPreset, PRESET_ID)
  assert.equal(getMainSessionId(db), 'session-new')
  assert.equal(getMainSessionPreset(db), PRESET_ID)
  assert.equal(getSetting(db, onboardingKey('session-new')), 'sent', '跳过首次介绍/索引任务')
  assert.deepEqual(f.renamed, [{ sessionId: 'session-new', title: '主会话' }], '只改新会话标题')
  assert.ok(logs.some(([event]) => event === 'main.adopt.created'))
  db.close()
})

test('代建：名单已满 4 个 → 淘汰最早成员腾位，新会话仍成为主协调者', async () => {
  const db = await ledger()
  const f = adoptFake({ live: ['s-1'] })
  setCoordinatorIds(db, ['s-1', 's-2', 's-3', 's-4'])
  const logs = []
  const main = adoptMain(db, f, { log: (event, detail) => logs.push([event, detail]) })
  const result = await main.createCoordinatorSession({ source: 'pressure-reminder' })
  assert.equal(result.ok, true, '压力换新不能被 ADOPT_LIMIT 卡住')
  assert.equal(result.sessionId, 'session-new')
  assert.equal(result.evicted, 's-4')
  assert.deepEqual(getCoordinatorIds(db), ['session-new', 's-1', 's-2', 's-3'],
    '新会话前插，最早的成员退出名单，其余成员保留')
  assert.equal(getMainSessionId(db), 'session-new')
  assert.equal(f.created.length, 1)
  assert.deepEqual(f.renamed, [{ sessionId: 'session-new', title: '主会话' }])
  const created = logs.find(([event]) => event === 'main.adopt.created')
  assert.equal(created?.[1]?.evicted, 's-4', '审计要写明腾位淘汰了谁')
  db.close()
})

test('代建：create 失败 → 零处置（不写指针、不建第二个）', async () => {
  const db = await ledger()
  const f = adoptFake({ live: ['session-old'] })
  f.sessionController.create = async () => { throw new Error('boom') }
  setMainSessionId(db, 'session-old')
  const main = adoptMain(db, f)
  const result = await main.createCoordinatorSession()
  assert.equal(result.ok, false)
  assert.equal(result.code, 'ADOPT_CREATE_FAILED')
  assert.equal(getMainSessionId(db), 'session-old')
  db.close()
})

test('代建：切指针失败 → ADOPT_FAILED，新会话留着待重用（不归档），旧协调者不变', async () => {
  const f = adoptFake({ live: ['session-old'] })
  const db = {
    prepare(sql) {
      if (sql.includes('SELECT value FROM settings')) return { get: () => undefined }
      if (sql.includes('INSERT INTO settings')) return { run: () => { throw new Error('disk full') } }
      throw new Error('unexpected SQL: ' + sql)
    },
  }
  const logs = []
  const main = adoptMain(db, f, { log: (event, detail) => logs.push([event, detail]) })
  const result = await main.createCoordinatorSession()
  assert.equal(result.ok, false)
  assert.equal(result.code, 'ADOPT_FAILED')
  assert.equal(result.params.sessionId, 'session-new', '把新建的会话 id 交回，提示用户可以直接用它')
  assert.equal(f.created.length, 1, '只建一个')
  assert.deepEqual(f.renamed, [], '指针没切成功就不改名')
  assert.ok(logs.some(([event]) => event === 'main.adopt.pointer-failed'))
})

test('打开主会话成功后触发 onOpened 旁路（观测/提醒），且不影响返回结果', async () => {
  const db = await ledger()
  const f = fake()
  const opened = []
  const main = createMainSession({
    db, config: {}, agents: f.agents, sessionController: f.sessionController, workspaces: f.workspaces,
    workspacePath: 'C:/ws',
    onOpened: async payload => { opened.push(payload) },
  })
  const result = await main.open()
  assert.equal(result.ok, true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(opened.length, 1)
  assert.equal(opened[0].result.sessionId, 'session-main-new')
  db.close()
})

// ---------------------------------------------------------------------------
// C：主会话权限徽标一致性 —— 协调者会话的 permission preset 钉成 read-only。
//
// 协调者预设没有 read/write/bash，宿主默认给新会话 pin 的却是 workspace-write → 徽标说能写、
// 实际写不了。这里钉住宿主公开写路径 `permissionPresets.set(session,'read-only')`：
// 新建（open / 代建）、adopt、复用已有主会话时把漂移拉回。子会话不受影响（dispatch 钉 workspace-write）。
// ---------------------------------------------------------------------------

/** permissionPresets 替身：记 current/set 调用，assume 初始 workspace-write（宿主默认）。 */
const permissionFake = ({ initial = 'workspace-write' } = {}) => {
  const calls = []
  const state = new Map()
  return {
    calls,
    current: session => state.get(session?.id) ?? initial,
    set: (session, name) => {
      calls.push([session?.id, name])
      state.set(session?.id, name)
    },
  }
}

test('C：新建主会话时把 permission preset 钉成 read-only，并记审计', async () => {
  const db = await ledger()
  const f = fake()
  const permissions = permissionFake()
  const logs = []
  const session = { id: 'session-main-new' }
  const main = createMainSession({
    db, config: {}, agents: f.agents, sessionController: f.sessionController, workspaces: f.workspaces,
    sessions: () => ({ get: id => (id === session.id ? session : undefined) }),
    permissionPresets: () => permissions,
    workspacePath: 'C:/ws',
    log: (event, detail) => logs.push([event, detail]),
  })
  const result = await main.open()
  assert.equal(result.ok, true)
  assert.deepEqual(permissions.calls, [['session-main-new', 'read-only']])
  const pinned = logs.find(([event]) => event === 'main.session.permission-pinned')
  assert.ok(pinned, '钉成功要留审计')
  assert.equal(pinned[1].from, 'workspace-write')
  assert.equal(logs.find(([event]) => event === 'main.session.created')[1].permission, 'pinned')
  db.close()
})

test('C：已经是 read-only 时不重复 set（幂等，不留审计噪音）', async () => {
  const db = await ledger()
  const f = fake()
  const permissions = permissionFake({ initial: 'read-only' })
  const logs = []
  const session = { id: 'session-main-new' }
  const main = createMainSession({
    db, config: {}, agents: f.agents, sessionController: f.sessionController, workspaces: f.workspaces,
    sessions: () => ({ get: () => session }),
    permissionPresets: () => permissions,
    workspacePath: 'C:/ws',
    log: (event, detail) => logs.push([event, detail]),
  })
  await main.open()
  assert.deepEqual(permissions.calls, [])
  assert.equal(logs.some(([event]) => event === 'main.session.permission-pinned'), false)
  db.close()
})

test('C：权限钉不住（宿主预设表没有 read-only / set 抛错）不影响打开主会话', async () => {
  const db = await ledger()
  const f = fake()
  const logs = []
  const session = { id: 'session-main-new' }
  const main = createMainSession({
    db, config: {}, agents: f.agents, sessionController: f.sessionController, workspaces: f.workspaces,
    sessions: () => ({ get: () => session }),
    permissionPresets: () => ({ current: () => 'workspace-write', set: () => { throw new Error('permission: unknown preset "read-only"') } }),
    workspacePath: 'C:/ws',
    log: (event, detail) => logs.push([event, detail]),
  })
  const result = await main.open()
  assert.equal(result.ok, true, '权限是旁路，不能挡打开')
  assert.equal(getMainSessionId(db), 'session-main-new')
  const failed = logs.find(([event]) => event === 'main.session.permission-pin-failed')
  assert.ok(failed, '失败要如实记日志')
  assert.match(failed[1].error, /unknown preset/)
  db.close()
})

test('C：复用已有主会话时把用户切走的权限拉回 read-only（返回 permissionRestored）', async () => {
  const db = await ledger()
  const f = fake({ live: new Set(['session-main-old']) })
  const permissions = permissionFake({ initial: 'danger-full-access' })
  const logs = []
  setMainSessionId(db, 'session-main-old')
  setMainSessionPreset(db, PRESET_ID)
  const main = createMainSession({
    db, config: {}, agents: f.agents, sessionController: f.sessionController, workspaces: f.workspaces,
    presetFor: f.presetFor, permissionPresets: () => permissions, workspacePath: 'C:/ws',
    log: (event, detail) => logs.push([event, detail]),
  })
  const result = await main.open()
  assert.equal(result.ok, true)
  assert.equal(result.created, false)
  assert.equal(result.permissionRestored, true)
  assert.deepEqual(permissions.calls, [['session-main-old', 'read-only']])
  assert.ok(logs.some(([event]) => event === 'main.session.permission-pinned'))
  db.close()
})

test('C：adopt 进来的会话同样钉 read-only，审计里带 permission', async () => {
  const db = await ledger()
  const f = adoptFake({ live: ['session-old', 'session-target'] })
  const permissions = permissionFake()
  const logs = []
  setMainSessionId(db, 'session-old')
  const main = adoptMain(db, f, { permissionPresets: () => permissions, log: (event, detail) => logs.push([event, detail]) })
  const result = await main.adoptSession({ sessionId: 'session-target' })
  assert.equal(result.ok, true)
  assert.deepEqual(permissions.calls, [['session-target', 'read-only']])
  assert.equal(logs.find(([event]) => event === 'main.session.adopted')[1].permission, 'pinned')
  db.close()
})

test('C：代建（createCoordinatorSession）的新会话也钉 read-only', async () => {
  const db = await ledger()
  const f = adoptFake({ live: ['session-old'] })
  const permissions = permissionFake()
  const created = { id: 'session-new' }
  f.sessionsService.get = id => (id === created.id ? created : f.sessions.get(id))
  const logs = []
  setMainSessionId(db, 'session-old')
  const main = adoptMain(db, f, { permissionPresets: () => permissions, log: (event, detail) => logs.push([event, detail]) })
  const result = await main.createCoordinatorSession()
  assert.equal(result.ok, true)
  assert.deepEqual(permissions.calls, [['session-new', 'read-only']])
  assert.equal(logs.find(([event]) => event === 'main.adopt.created')[1].permission, 'pinned')
  db.close()
})

test('C：宿主没有 permissionPresets 服务时整段降级（不抛、不写权限、打开照旧成功）', async () => {
  const db = await ledger()
  const f = fake()
  const logs = []
  const main = createMainSession({
    db, config: {}, agents: f.agents, sessionController: f.sessionController, workspaces: f.workspaces,
    workspacePath: 'C:/ws', log: (event, detail) => logs.push([event, detail]),
  })
  const result = await main.open()
  assert.equal(result.ok, true)
  assert.equal(logs.some(([event]) => event.startsWith('main.session.permission-')), false, '缺服务不是错误，不刷日志')
  db.close()
})
