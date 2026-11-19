import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openLedger, createTask, getSetting, getMainSessionId, setMainSessionId, getMainSessionPreset, setMainSessionPreset, setSetting } from '../src/ledger.js'
import { createMainSession, PRESET_ID } from '../src/main-session.js'
import { createRotationService, readRotationState } from '../src/main-rotation.js'
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
// G1 S3：轮换动作（create → marker → 切指针 → 跳过 onboarding → 旧会话改名+归档 → 审计）
//
// 用**真** createRotationService（只注入假的平台动作）：判定/采集仍是真实现，所以「due」由
// 「主会话龄 ≥ 默认 10 天」命中 age 因子构造——main-log 因没挂 persistence 降级，
// 而 degraded 不会让 age 因子失效（P10 只在「两个因子都拿不到」时 fail-closed）。
// ---------------------------------------------------------------------------
const DAY = 24 * 3_600_000
const RETIRED_TITLE = /^主会话（已退役 \d{4}-\d{2}-\d{2} \d{2}:\d{2}）$/

/** 造一个「该轮换」的台账：指针 session-old 已运行 30 天，没有任何任务（Q1/Q4 保护都不命中）。 */
const agedMain = async db => {
  setMainSessionId(db, 'session-old')
  setSetting(db, 'main_session_created_at', String(Date.now() - 30 * DAY))
}

/** 真轮换服务 + 假平台动作（归档/改名都记进数组，便于断言「谁被处置了」）。 */
const rotationFor = (db, f, { archived = [], config = {}, log = () => {}, onWarn } = {}) => createRotationService({
  db,
  config: { mainRotation: 'auto', spawnProvider: 'spawn', ...config },
  rename: async (sessionId, title) => f.sessionController.rename({ sessionId, title }),
  archive: async sessionId => archived.push(sessionId),
  log,
  onWarn,
})

test('S3 轮换：命中 due 时 create → 切指针 → 跳过 onboarding → 旧会话改名+归档 → 审计', async () => {
  const db = await ledger()
  await agedMain(db)
  const f = fake({ live: new Set(['session-old']) })
  const archived = []
  const logs = []
  const rotation = rotationFor(db, f, { archived, log: (event, detail) => logs.push([event, detail]) })
  const main = createMainSession({
    db, config: {}, agents: f.agents, sessionController: f.sessionController,
    workspaces: f.workspaces, rotation, workspacePath: 'C:/ws',
    log: (event, detail) => logs.push([event, detail]),
  })
  const result = await main.open()
  assert.equal(result.ok, true)
  assert.equal(result.rotated, true)
  assert.equal(result.replaced, 'session-old')
  assert.equal(result.sessionId, 'session-main-new')
  assert.equal(result.created, true)
  assert.equal(result.rotation.at > 0, true)
  assert.deepEqual(result.rotation.reasons.map(reason => reason.code), ['age'])
  assert.equal(f.created.length, 1, '一次轮换只建一个会话')
  assert.equal(f.created[0].agentPreset, PRESET_ID)
  assert.equal(getMainSessionId(db), 'session-main-new')
  assert.equal(getMainSessionPreset(db), PRESET_ID)
  // 新会话先拿回「主会话」标题，旧会话再改成「已退役 …」（rename 是覆盖标题，重复执行幂等）。
  assert.deepEqual(f.renamed[0], { sessionId: 'session-main-new', title: '主会话' })
  assert.equal(f.renamed[1].sessionId, 'session-old')
  assert.match(f.renamed[1].title, RETIRED_TITLE)
  assert.deepEqual(archived, ['session-old'])
  // 跳过首次介绍 + 工作区索引任务：落 sent，而不是 create 分支的 pending。
  assert.equal(getSetting(db, onboardingKey('session-main-new')), 'sent')
  assert.equal(getSetting(db, onboardingKey('session-old')), undefined)
  // 时间戳 / 审计 / marker 收口
  const state = readRotationState(db)
  assert.ok(state.createdAt > Date.now() - 10_000, 'main_session_created_at 指向新会话起点')
  assert.ok(state.rotatedAt > Date.now() - 10_000, 'main_rotation_at 用于冷却期')
  assert.equal(state.pending, null, 'marker 已清')
  assert.equal(state.last.old, 'session-old')
  assert.equal(state.last.new, 'session-main-new')
  assert.equal(state.last.renamed, true)
  assert.equal(state.last.archived, true)
  assert.equal(state.last.recovered, false)
  assert.deepEqual(state.last.triggers, ['age'])
  const rotatedLog = logs.find(([event]) => event === 'main.session.rotated')
  assert.ok(rotatedLog, '应写 main.session.rotated 审计日志')
  assert.equal(rotatedLog[1].archived, true)
  assert.equal(rotatedLog[1].marker, true, 'marker 在切指针前落过盘')
  db.close()
})

test('S3 未命中 due：健康主会话直接复用，不 create、不改名、不归档', async () => {
  const db = await ledger()
  setMainSessionId(db, 'session-old')
  setMainSessionPreset(db, PRESET_ID)
  setSetting(db, 'main_session_created_at', String(Date.now() - 3_600_000))
  const f = fake({ live: new Set(['session-old']) })
  const archived = []
  const rotation = rotationFor(db, f, { archived })
  const main = createMainSession({ db, config: {}, agents: f.agents, sessionController: f.sessionController, workspaces: f.workspaces, rotation, workspacePath: 'C:/ws' })
  const result = await main.open()
  assert.equal(result.ok, true)
  assert.equal(result.created, false)
  assert.equal(result.rotated, undefined)
  assert.equal(result.sessionId, 'session-old')
  assert.equal(f.created.length, 0)
  assert.deepEqual(f.renamed, [])
  assert.deepEqual(archived, [])
  // 判定只在打开时算一次、且只读：不留审计、不留 marker。
  assert.equal(readRotationState(db).last, null)
  assert.equal(readRotationState(db).pending, null)
  db.close()
})

test('S7 检查节流（open 路径）：同一天内第二次打开只读一个 settings 键就跳过，不采集不判定', async () => {
  const db = await ledger()
  setMainSessionId(db, 'session-old')
  setMainSessionPreset(db, PRESET_ID)
  setSetting(db, 'main_session_created_at', String(Date.now() - 3_600_000))
  const f = fake({ live: new Set(['session-old']) })
  // 给 live agent 一个带 id/cwd 的 header，采集才会真的走 locate + stat（否则 main-log 直接降级）。
  f.agents.get = id => id === 'session-old'
    ? { id, status: 'idle', session: { id, header: { id, cwd: 'C:/ws', createdAt: Date.now() - 3_600_000 } } }
    : undefined
  const logs = []
  let locates = 0
  const rotation = createRotationService({
    db,
    config: { mainRotation: 'auto', spawnProvider: 'spawn' },
    persistence: {
      locate: () => {
        locates += 1
        return { kind: 'jsonl', path: 'C:/sessions/session-old.jsonl' }
      },
    },
    statFile: async () => ({ size: 1024, mtimeMs: Date.now() - 30 * 60_000 }),
    log: (event, detail) => logs.push([event, detail]),
  })
  const main = createMainSession({ db, config: {}, agents: f.agents, sessionController: f.sessionController, workspaces: f.workspaces, rotation, workspacePath: 'C:/ws' })
  const first = await main.open()
  assert.equal(first.created, false)
  assert.equal(locates, 1, '第一次打开真的采集')
  assert.equal(logs.filter(([event]) => event === 'main.rotation.decided').length, 1)
  assert.equal(getSetting(db, 'main_rotation_checked_at') !== undefined, true, 'not-due 时写检查时间戳')
  // 同一天再点一次「打开主会话」：节流直接跳过，采集/判定都不发生。
  const second = await main.open()
  assert.equal(second.ok, true)
  assert.equal(second.sessionId, 'session-old')
  assert.equal(locates, 1, '第二次打开零采集')
  assert.equal(logs.filter(([event]) => event === 'main.rotation.decided').length, 1, '第二次打开不判定')
  assert.equal(logs.filter(([event]) => event === 'main.rotation.check.skipped').length, 1, '跳过留一条日志')
  db.close()
})

test('S3 保护沿用 S1：龄命中但有活跃任务时不轮换，照旧复用', async () => {
  const db = await ledger()
  await agedMain(db)
  setMainSessionPreset(db, PRESET_ID)
  // 默认新建任务就是 waiting_dep（P1 的活跃口径），这一条由 S1 判定挡住，不需要 open() 另加闸门。
  createTask(db, { brief: { title: '活跃任务', goal: 'g', acceptance: ['a'] }, coordinatorSession: 'session-old' })
  const f = fake({ live: new Set(['session-old']) })
  const archived = []
  const logs = []
  const rotation = rotationFor(db, f, { archived, log: (event, detail) => logs.push([event, detail]) })
  const main = createMainSession({ db, config: {}, agents: f.agents, sessionController: f.sessionController, workspaces: f.workspaces, rotation, workspacePath: 'C:/ws' })
  const result = await main.open()
  assert.equal(result.ok, true)
  assert.equal(result.created, false)
  assert.equal(result.sessionId, 'session-old')
  assert.equal(f.created.length, 0)
  assert.deepEqual(f.renamed, [])
  assert.deepEqual(archived, [])
  // 判定结果看得见「为什么没换」：活跃任务（main.rotation.decided 审计日志）。
  const decided = logs.find(([event]) => event === 'main.rotation.decided')
  assert.deepEqual(decided[1].detail.blockedBy, ['active-tasks'])
  assert.equal(decided[1].detail.due, false)
  db.close()
})

test('S3 create 失败零处置：指针不动、marker/审计不写、旧会话不改名不归档', async () => {
  const db = await ledger()
  await agedMain(db)
  const since = getSetting(db, 'main_session_created_at')
  const f = fake({ live: new Set(['session-old']) })
  f.sessionController.create = async () => { throw new Error('boom') }
  const archived = []
  const logs = []
  const rotation = rotationFor(db, f, { archived, log: (event, detail) => logs.push([event, detail]) })
  const main = createMainSession({
    db, config: {}, agents: f.agents, sessionController: f.sessionController, workspaces: f.workspaces, rotation,
    workspacePath: 'C:/ws', log: (event, detail) => logs.push([event, detail]),
  })
  const result = await main.open()
  assert.equal(result.ok, false)
  assert.match(result.error, /boom/)
  assert.equal(getMainSessionId(db), 'session-old', '指针必须还是旧会话')
  assert.equal(getSetting(db, 'main_session_created_at'), since, '起点不能被改')
  assert.deepEqual(f.renamed, [])
  assert.deepEqual(archived, [])
  const state = readRotationState(db)
  assert.equal(state.pending, null, 'create 失败不该留下 marker')
  assert.equal(state.last, null, 'create 失败不该写审计')
  assert.equal(state.rotatedAt, null)
  assert.ok(logs.some(([event, detail]) => event === 'main.rotation.failed' && detail.stage === 'create'))
  db.close()
})

/** 只让「写主会话指针」这一条 UPSERT 失败的台账代理（其余读写照旧）。 */
const failingPointerDb = db => ({
  prepare(sql) {
    const statement = db.prepare(sql)
    if (!sql.includes('INSERT INTO settings')) return statement
    return {
      run(...args) {
        if (args[0] === 'main_session_id') throw new Error('database is locked')
        return statement.run(...args)
      },
      get: (...args) => statement.get(...args),
      all: (...args) => statement.all(...args),
    }
  },
})

test('S3 指针写失败（F3）：旧主会话仍可用，空白新会话尽力归档，marker 清掉', async () => {
  const db = await ledger()
  await agedMain(db)
  const f = fake({ live: new Set(['session-old']) })
  const archived = []
  const logs = []
  const proxy = failingPointerDb(db)
  const rotation = rotationFor(proxy, f, { archived, log: (event, detail) => logs.push([event, detail]) })
  const main = createMainSession({
    db: proxy, config: {}, agents: f.agents, sessionController: f.sessionController, workspaces: f.workspaces, rotation,
    workspacePath: 'C:/ws', log: (event, detail) => logs.push([event, detail]),
  })
  const result = await main.open()
  assert.equal(result.ok, false)
  assert.match(result.error, /轮换失败，旧主会话仍可用/)
  assert.equal(result.rotated, false)
  assert.equal(getMainSessionId(db), 'session-old', '真台账里指针没动')
  assert.deepEqual(archived, ['session-main-new'], '空白新会话被归档隐藏（失败归档也不影响旧指针）')
  assert.deepEqual(f.renamed, [], '旧会话不该改名（轮换没发生）')
  const state = readRotationState(db)
  assert.equal(state.pending, null)
  assert.equal(state.last, null)
  assert.equal(state.rotatedAt, null)
  assert.ok(logs.some(([event, detail]) => event === 'main.rotation.pointer-failed' && detail.discarded === true))
  db.close()
})

test('S3 归档失败降级：只改名，轮换仍成立', async () => {
  const db = await ledger()
  await agedMain(db)
  const f = fake({ live: new Set(['session-old']) })
  const warnings = []
  const rotation = createRotationService({
    db,
    config: { mainRotation: 'auto', spawnProvider: 'spawn' },
    rename: async (sessionId, title) => f.sessionController.rename({ sessionId, title }),
    archive: async () => { throw new Error('workspace/unknown-session') },
    onWarn: message => warnings.push(message),
  })
  const main = createMainSession({ db, config: {}, agents: f.agents, sessionController: f.sessionController, workspaces: f.workspaces, rotation, workspacePath: 'C:/ws' })
  const result = await main.open()
  assert.equal(result.ok, true)
  assert.equal(result.rotated, true)
  assert.equal(getMainSessionId(db), 'session-main-new')
  assert.equal(f.renamed[1].sessionId, 'session-old')
  assert.match(f.renamed[1].title, RETIRED_TITLE)
  const state = readRotationState(db)
  assert.equal(state.last.renamed, true)
  assert.equal(state.last.archived, false, '归档失败降级为只改名')
  assert.ok(warnings.some(message => /归档会话 session-old 失败/.test(message)))
  db.close()
})

test('S3 并发单飞：两个 open() 同时命中 due 也只建一次、只处置一次旧会话', async () => {
  const db = await ledger()
  await agedMain(db)
  const f = fake({ live: new Set(['session-old']) })
  let release
  const gate = new Promise(resolve => { release = resolve })
  f.sessionController.create = async request => {
    f.created.push(request)
    await gate
    return { sessionId: 'session-main-new' }
  }
  const archived = []
  const rotation = rotationFor(db, f, { archived })
  const main = createMainSession({ db, config: {}, agents: f.agents, sessionController: f.sessionController, workspaces: f.workspaces, rotation, workspacePath: 'C:/ws' })
  const first = main.open()
  const second = main.open()
  release()
  const [a, b] = await Promise.all([first, second])
  assert.deepEqual(a, b)
  assert.equal(f.created.length, 1)
  assert.equal(a.rotated, true)
  assert.deepEqual(archived, ['session-old'])
  assert.equal(getMainSessionId(db), 'session-main-new')
  db.close()
})

test('S3 rotateArchiveOld=false：只改名退役、不归档（保留可回看入口）', async () => {
  const db = await ledger()
  await agedMain(db)
  const f = fake({ live: new Set(['session-old']) })
  const archived = []
  const rotation = rotationFor(db, f, { archived, config: { rotateArchiveOld: false } })
  const main = createMainSession({ db, config: {}, agents: f.agents, sessionController: f.sessionController, workspaces: f.workspaces, rotation, workspacePath: 'C:/ws' })
  const result = await main.open()
  assert.equal(result.ok, true)
  assert.equal(result.rotated, true)
  assert.deepEqual(archived, [], '归档关闭时一次也不调 archiveSession')
  assert.match(f.renamed[1].title, RETIRED_TITLE)
  const state = readRotationState(db)
  assert.equal(state.last.renamed, true)
  assert.equal(state.last.archived, false)
  db.close()
})

test('S3 轮换后新会话尚未 live：窗口内再 open 不重复建（不给「不 live 就新建」留双建）', async () => {
  const db = await ledger()
  await agedMain(db)
  const f = fake({ live: new Set(['session-old']) })
  let clock = Date.now()
  let release
  const gate = new Promise(resolve => { release = resolve })
  f.sessionController.create = async request => {
    f.created.push(request)
    await gate
    return { sessionId: 'session-main-new' }
  }
  const archived = []
  const rotation = rotationFor(db, f, { archived })
  const main = createMainSession({
    db, config: {}, agents: f.agents, sessionController: f.sessionController,
    workspaces: f.workspaces, rotation, workspacePath: 'C:/ws', now: () => clock,
  })
  const rotated = main.open()
  release()
  const first = await rotated
  assert.equal(first.rotated, true)
  // 平台还没把新会话拉起来（fake 里 live 不含新 id）：再点一次不能又建一个。
  const second = await main.open()
  assert.equal(second.ok, true)
  assert.equal(second.sessionId, 'session-main-new')
  assert.equal(second.loading, true)
  assert.equal(f.created.length, 1)
  assert.deepEqual(archived, ['session-old'])
  // 窗口过期后回到既有行为（不 live 就重建），这里只断言窗口内的保护。
  clock += 61_000
  db.close()
})

