#!/usr/bin/env node
/**
 * QA：阶段 2 终审四条「必须改」的独立复核（审查 5bdca13 终审 + Chief 决定）
 *
 * 用法: node docs/probes/qa-main-session-fixes.mjs
 * 退出码: 0 全 PASS；1 有 FAIL
 *
 * 覆盖：
 * 1. worker 预设不出现 createRequire(baseUrl) / customSkillDirs（磁盘 bundle 求值会 MODULE_NOT_FOUND）
 * 2. dispatch 只在 provider === 'spawn' 时注入 agentPreset（fork + 覆盖会话仍可派发）
 * 3. open-main / mainSession.open 并发只建一次（in-flight 复用 Promise）
 * 4. index 惰性取 sessionController/workspaceRegistry；client「打开主会话」pending 防双击
 */
import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const src = (name) => import(new URL(`../../src/${name}`, import.meta.url))
const ledger = await src('ledger.js')
const { createSubagentDispatcher } = await src('dispatch.js')
const { createMainSession } = await src('main-session.js')

let failures = 0
const check = (name, cond, detail = '') => {
  if (cond) console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`)
  else { failures += 1; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`) }
}
const tmp = (prefix) => mkdtempSync(join(tmpdir(), prefix))
const clean = (dir) => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* ok */ } }

// ============ 1. worker 预设：不得在磁盘 bundle 里 resolve asar 内的包 ============
console.log('\n== 1. worker 预设（createRequire） ==')
{
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  check('patch 不出现 createRequire(baseUrl)', !/createRequire\s*\(\s*baseUrl\s*\)/.test(patch))
  const workerAt = patch.indexOf('id: dsh-orchestrator-worker')
  check('找到 worker 预设', workerAt >= 0)
  const worker = workerAt >= 0 ? patch.slice(workerAt) : ''
  check('worker 预设不再带 customSkillDirs 块', !/customSkillDirs/.test(worker))
  check('worker 预设不再引用 @deepseek-ai/dsh-agent-preset', !/@deepseek-ai\/dsh-agent-preset/.test(worker))
  // 不回退：协调者的 compaction / preset-tools 仍在
  check('协调者预设仍带 compaction 组', /compaction-basic/.test(patch) && /tool-result-pruner/.test(patch))
  check('协调者预设仍带 preset-tools', /preset-tools/.test(patch))
}

// ============ 2. dispatch：agentPreset 只在 spawn provider 注入 ============
console.log('\n== 2. provider 门控 ==')
{
  const calls = []
  const subagents = {
    startActivation: (spec) => { calls.push(spec); return Promise.resolve({ childId: spec.childId, result: Promise.resolve({}), dispose: async () => {} }) },
    sendMessage: async () => {},
    interruptByParent: async () => {},
    listChildren: async () => [],
  }
  const parent = { id: 's-1', session: { header: { cwd: 'C:/parent' } } }
  const fork = createSubagentDispatcher({ subagents, agent: parent, provider: 'fork' })
  check('fork provider 不再注入 agentPreset', await (async () => {
    await fork.spawn({ prompt: 'hi' })
    const spec = calls[calls.length - 1]
    return !Object.hasOwn(spec?.request ?? {}, 'agentPreset')
  })(), JSON.stringify(Object.keys(calls[calls.length - 1]?.request ?? {})))

  const spawn = createSubagentDispatcher({ subagents, agent: parent, provider: 'spawn' })
  await spawn.spawn({ prompt: 'hi' })
  check('spawn provider 仍注入 worker 预设', calls[calls.length - 1]?.request?.agentPreset === 'dsh-orchestrator-worker',
    String(calls[calls.length - 1]?.request?.agentPreset))
  const custom = createSubagentDispatcher({ subagents, agent: parent, provider: 'spawn', workerPreset: 'custom-worker' })
  await custom.spawn({ prompt: 'hi' })
  check('spawn provider 可用 workerPreset 覆盖', calls[calls.length - 1]?.request?.agentPreset === 'custom-worker',
    String(calls[calls.length - 1]?.request?.agentPreset))
  // fork 下 cwd 仍透传（阶段 1/2 能力不回退）
  const forkWithCwd = createSubagentDispatcher({ subagents, agent: parent, provider: 'fork' })
  await forkWithCwd.spawn({ prompt: 'hi', cwd: 'C:/target' })
  check('fork provider 仍透传 cwd', calls[calls.length - 1]?.request?.cwd === 'C:/target',
    String(calls[calls.length - 1]?.request?.cwd))

  // fork + 配置覆盖会话：平台会拒「不支持的 provider + agentPreset」，派发必须能过
  const strictSubagents = {
    startActivation: (spec) => {
      if (spec.request?.agentPreset !== undefined) {
        const error = new Error('provider does not support agentPreset')
        error.code = 'UNSUPPORTED_CAPABILITY'
        return Promise.reject(error)
      }
      return Promise.resolve({ childId: spec.childId, result: Promise.resolve({}), dispose: async () => {} })
    },
    sendMessage: async () => {},
    interruptByParent: async () => {},
    listChildren: async () => [],
  }
  const forkOverride = createSubagentDispatcher({
    subagents: strictSubagents,
    agent: { id: 'override-session', session: { header: { cwd: 'C:/parent' } } },
    provider: 'fork',
  })
  const forkSpawn = await forkOverride.spawn({ prompt: 'hi' })
  check('fork + 配置覆盖会话派发成功（不撞 UNSUPPORTED_CAPABILITY）', typeof forkSpawn.sessionId === 'string', JSON.stringify(forkSpawn))
}

// ============ 3. mainSession.open 并发互斥（并发只建一次） ============
console.log('\n== 3. open-main 并发互斥 ==')
{
  const dir = tmp('qa-fix-open-')
  const db = await ledger.openLedger(dir)
  const created = []
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const fake = {
    agents: { get: () => undefined },
    sessionController: {
      create: async (request) => { created.push(request); await gate; return { sessionId: 'session-main' } },
      rename: async () => {},
    },
    workspaces: { resolveByPath: () => undefined, create: async () => ({ id: 'ws-1' }) },
  }
  // 同时支持 getter 形式（第 4 条修法）：传函数时由 main-session 解析
  const main = createMainSession({
    db,
    config: {},
    agents: fake.agents,
    sessionController: fake.sessionController,
    workspaces: fake.workspaces,
    workspacePath: join(dir, 'ws'),
  })
  const first = main.open()
  const second = main.open()
  release()
  const [a, b] = await Promise.all([first, second])
  check('并发 open 只调一次 sessionController.create', created.length === 1, `实际 ${created.length}`)
  check('两次 open 返回同一主会话', a.ok === true && b.ok === true && a.sessionId === 'session-main' && b.sessionId === 'session-main',
    JSON.stringify({ a, b }))
  check('台账只写一次 main_session_id', ledger.getMainSessionId(db) === 'session-main')
  db.close()
  clean(dir)

  // 失败也要清 in-flight：失败后还能再点
  const dir2 = tmp('qa-fix-retry-')
  const db2 = await ledger.openLedger(dir2)
  let attempt = 0
  const flaky = {
    agents: { get: () => undefined },
    sessionController: {
      create: async () => {
        attempt += 1
        if (attempt === 1) throw new Error('boom')
        return { sessionId: 'session-retry' }
      },
      rename: async () => {},
    },
    workspaces: { resolveByPath: () => undefined, create: async () => ({ id: 'ws' }) },
  }
  const mainRetry = createMainSession({ db: db2, config: {}, agents: flaky.agents, sessionController: flaky.sessionController, workspaces: flaky.workspaces, workspacePath: join(dir2, 'ws') })
  const failed = await mainRetry.open()
  const afterFailure = ledger.getMainSessionId(db2)
  const retried = await mainRetry.open()
  check('首次失败返回可读错误不写库', failed.ok === false && /创建主会话失败/.test(failed.error) && afterFailure === undefined, JSON.stringify({ failed, afterFailure }))
  check('失败后 in-flight 已清，再点能成功', retried.ok === true && retried.sessionId === 'session-retry' && attempt === 2, JSON.stringify({ retried, attempt }))
  db2.close()
  clean(dir2)
}

// ============ 4. index 惰性取服务 + client pending ============
console.log('\n== 4. 惰性取服务 / 防双击 ==')
{
  const indexSource = readFileSync(join(root, 'index.js'), 'utf8')
  check('index 以 getter 传 sessionController', /sessionController:\s*(\(\)\s*=>|function|\w+\s*=>)/.test(indexSource),
    (indexSource.match(/sessionController:[^\n]*/) ?? ['无'])[0].trim())
  check('index 以 getter 传 workspaces', /workspaces:\s*(\(\)\s*=>|function|\w+\s*=>)/.test(indexSource),
    (indexSource.match(/workspaces:[^\n]*/) ?? ['无'])[0].trim())
  const mainSource = readFileSync(join(root, 'src', 'main-session.js'), 'utf8')
  check('main-session 能解析 getter 形式的服务', /typeof\s+sessionController\s*===\s*'function'|typeof\s+workspaces\s*===\s*'function'|resolveMaybe|defer/i.test(mainSource))

  // 动态验 getter：apply 时服务还没到、open 时才取到，也要能建
  const gdir = tmp('qa-fix-getter-')
  const gdb = await ledger.openLedger(gdir)
  const g = {
    agents: { get: () => undefined },
    sessionController: { create: async () => ({ sessionId: 's-getter' }), rename: async () => {} },
    workspaces: { resolveByPath: () => ({ id: 'ws' }), create: async () => ({ id: 'ws' }) },
  }
  const mainG = createMainSession({
    db: gdb,
    config: {},
    agents: g.agents,
    sessionController: () => g.sessionController,
    workspaces: () => g.workspaces,
    workspacePath: join(gdir, 'ws'),
  })
  const getterResult = await mainG.open()
  check('main-session 支持 getter 形式的 sessionController/workspaces', getterResult.ok === true && getterResult.sessionId === 's-getter', JSON.stringify(getterResult))
  gdb.close()
  clean(gdir)

  // getter 取不到服务时给可读错误，而不是 TypeError
  const ndir = tmp('qa-fix-noservice-')
  const ndb = await ledger.openLedger(ndir)
  const mainNone = createMainSession({
    db: ndb,
    config: {},
    agents: { get: () => undefined },
    sessionController: () => undefined,
    workspaces: () => undefined,
    workspacePath: join(ndir, 'ws'),
  })
  const noneResult = await mainNone.open()
  check('服务未就绪 → 可读错误（非 TypeError）', noneResult.ok === false && /sessionController/.test(String(noneResult.error)) && !/is not a function/.test(String(noneResult.error)), JSON.stringify(noneResult))
  ndb.close()
  clean(ndir)

  const clientSource = readFileSync(join(root, 'client.js'), 'utf8')
  check('client「打开主会话」有 pending 状态', /opening|openPending|openingMain/.test(clientSource),
    (clientSource.match(/opening[^\n]*/i) ?? ['无'])[0].trim())
  check('pending 时按钮 disabled', /disabled:\s*\w*[Oo]pening|disabled:\s*\w*[Pp]ending/.test(clientSource),
    (clientSource.match(/disabled:\s*[^\n]*/g) ?? []).join('；'))
}

console.log(failures === 0 ? '\nRESULT: PASS' : `\nRESULT: FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
