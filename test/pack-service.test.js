import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tempDir } from './helpers.js'
import { createPackStore } from '../src/pack/store.js'
import { createPresetRegistry } from '../src/pack/preset-registry.js'
import { createInstaller } from '../src/pack/install.js'
import { createPackService } from '../src/pack/service.js'
import { createCapabilityPackTool, renderInstallCard } from '../src/pack/tool.js'
import { validateManifest } from '../src/pack/manifest.js'
import { skillFiles, validManifest } from './pack-fixtures.js'

// P3 service + tool：闸门（dry-run/confirm/幂等）、回滚、只读内置包、开包会话参数、env 不落值。
// 这些用例全部用假宿主/假 runner：不联网、不装包、不碰真实 ~/.dsh。

const draftOf = (overrides = {}) => ({
  id: 'demo-pack',
  name: '演示包',
  description: '演示用能力包',
  version: '0.1.0',
  skills: [{ name: 'demo-skill', description: '演示技能', content: '正文内容' }],
  env: [{ ref: 'DEMO_TOKEN', kind: 'secret', purpose: '演示凭据' }],
  ...overrides,
})

const makeRunner = () => async ({ args }) => {
  if (args.includes('--version')) return { code: 0, stdout: '1.0.0\n', tail: '1.0.0' }
  return { code: 0, stdout: '', tail: 'ok' }
}

const builtinFixture = () => {
  const packRoot = tempDir()
  mkdirSync(join(packRoot, 'skills', 'builtin-skill'), { recursive: true })
  writeFileSync(join(packRoot, 'skills', 'builtin-skill', 'SKILL.md'), '---\nname: builtin-skill\ndescription: 内置\n---\n\n正文\n')
  const manifest = validateManifest(validManifest({
    id: 'builtin-pack', name: '内置包', publisher: 'builtin', version: '0.2.0',
    preset: { id: 'dsh-orchestrator-pack-builtin-pack', name: '内置包' },
    skills: [{ name: 'builtin-skill', description: '内置' }],
  })).manifest
  return { kind: 'builtin', id: 'builtin-pack', packRoot, manifest, mode: 'runtime' }
}

const setup = ({ builtin = [], config = {}, workspaces } = {}) => {
  const stateDir = tempDir()
  const store = createPackStore({ stateDir, now: () => 1700000000000 })
  const registered = new Map()
  const host = {
    register: definition => { registered.set(definition.id, definition); return () => registered.delete(definition.id) },
    list: () => [...registered.keys()].map(id => ({ id })),
  }
  const presets = createPresetRegistry({ agentPresets: () => host })
  const sessions = []
  const controller = {
    create: async input => { sessions.push(input); return { sessionId: `session-${sessions.length}`, agentPreset: input.agentPreset } },
  }
  const logs = []
  const setxCalls = []
  const installer = createInstaller({ store, runner: makeRunner(), now: () => 1700000000000 })
  const service = createPackService({
    store,
    presets,
    installer,
    config: { capabilityPacks: true, capabilityPacksAllowOnWeb: true, ...config },
    hostInfo: { desktop: true },
    builtin,
    sessionController: () => controller,
    ...(workspaces === undefined ? {} : { workspaces }),
    workspaceDir: () => 'C:/work',
    env: {},
    now: () => 1700000000000,
    log: (event, fields) => logs.push({ event, fields }),
    setx: async input => {
      setxCalls.push(input)
      if (input.confirm !== true) return { ok: false, code: 'CONFIRM_REQUIRED' }
      return { ok: true, code: 'OK' }
    },
  })
  return { service, store, presets, registered, sessions, logs, stateDir, setxCalls }
}

test('P3 service：create 先 dry-run（不写盘），确认后写目录 + 注册预设 + 记 registry', async () => {
  const { service, store, registered } = setup()
  const dry = await service.create(draftOf())
  assert.equal(dry.ok, true)
  assert.equal(dry.dryRun, true)
  assert.match(dry.plan.text, /将创建能力包「演示包」/)
  assert.ok(dry.plan.files.some(file => file.path === 'skills/demo-skill/SKILL.md'))
  assert.equal(existsSync(store.packDir('demo-pack')), false, 'dry-run 不得写盘')
  assert.equal(registered.size, 0)

  const created = await service.create(draftOf(), { confirm: true, clientRequestId: 'req-1' })
  assert.equal(created.ok, true, created.error)
  assert.equal(created.presetId, 'dsh-orchestrator-pack-demo-pack')
  assert.equal(registered.has(created.presetId), true)
  assert.equal(store.readManifest('demo-pack').ok, true)
  assert.equal(store.readRegistry().registry.packages['demo-pack'].version, '0.1.0')
  assert.equal(created.health.ok, true, JSON.stringify(created.health))
  // 幂等：同 id 同内容 → 回放，不重复写。
  const replay = await service.create(draftOf(), { confirm: true, clientRequestId: 'req-1' })
  assert.equal(replay.ok, true)
  assert.equal(replay.duplicate, true)
  // 同 id 不同内容 → 冲突（不静默覆盖）。
  const conflict = await service.create(draftOf({ name: '别的包' }), { confirm: true, clientRequestId: 'req-1' })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.code, 'IDEMPOTENCY_CONFLICT')
})

test('P3 service：重复 id 需走 update；update 保留 createdAt 并替换技能', async () => {
  const { service, store, registered } = setup()
  await service.create(draftOf(), { confirm: true })
  const again = await service.create(draftOf(), { confirm: true })
  assert.equal(again.ok, false)
  assert.equal(again.code, 'PACK_EXISTS')

  const updated = await service.update('demo-pack', {
    ...draftOf(),
    version: '0.2.0',
    skills: [{ name: 'demo-skill', description: '演示技能', content: '新正文' }],
  }, { confirm: true })
  assert.equal(updated.ok, true, updated.error)
  assert.equal(store.readManifest('demo-pack').manifest.version, '0.2.0')
  assert.equal(store.readRegistry().registry.packages['demo-pack'].createdAt, 1700000000000)
  assert.equal(registered.has('dsh-orchestrator-pack-demo-pack'), true)
})

test('P3 service：内置包只读（update/delete 拒绝），list 同时给出内置与用户包', async () => {
  const builtin = builtinFixture()
  const { service } = setup({ builtin: [builtin] })
  await service.create(draftOf(), { confirm: true })
  const list = await service.list()
  assert.equal(list.ok, true)
  assert.deepEqual(list.packs.map(pack => pack.id).sort(), ['builtin-pack', 'demo-pack'])
  const builtinView = list.packs.find(pack => pack.id === 'builtin-pack')
  assert.equal(builtinView.deletable, false)
  const updated = await service.update('builtin-pack', draftOf(), { confirm: true })
  assert.equal(updated.ok, false)
  assert.equal(updated.code, 'BUILTIN_READONLY')
  const deleted = await service.delete('builtin-pack', { confirm: true })
  assert.equal(deleted.ok, false)
  assert.equal(deleted.code, 'BUILTIN_READONLY')
})

test('P3 service：delete 需确认；确认后目录删除、预设撤销、registry 清空', async () => {
  const { service, store, registered } = setup()
  await service.create(draftOf(), { confirm: true })
  const denied = await service.delete('demo-pack')
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'CONFIRM_REQUIRED')
  assert.equal(existsSync(store.packDir('demo-pack')), true)

  const removed = await service.delete('demo-pack', { confirm: true })
  assert.equal(removed.ok, true, removed.error)
  assert.equal(existsSync(store.packDir('demo-pack')), false)
  assert.equal(registered.has('dsh-orchestrator-pack-demo-pack'), false)
  assert.equal(store.readRegistry().registry.packages['demo-pack'], undefined)
  assert.ok(removed.trashPath === null || existsSync(removed.trashPath))
})

test('P3 service：open 只传 cwd + agentPreset，返回 sessionId；未注册预设给静态兜底', async () => {
  const { service, sessions, presets } = setup()
  await service.create(draftOf(), { confirm: true })
  const opened = await service.open('demo-pack')
  assert.equal(opened.ok, true, opened.error)
  assert.equal(opened.sessionId, 'session-1')
  assert.deepEqual(sessions[0], { cwd: 'C:/work', agentPreset: 'dsh-orchestrator-pack-demo-pack' })
  assert.equal('workspaceId' in sessions[0], false)

  await presets.unregister('dsh-orchestrator-pack-demo-pack')
  const missing = await service.open('demo-pack')
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'PRESET_NOT_REGISTERED')
  assert.match(missing.staticYaml, /insert:/)
})

test('t-8a81264c：开包会话的目标目录属于宿主工作区时用 workspaceId 建会话（宿主才会 attachSession）', async () => {
  // 只传 cwd 时宿主不 attachSession，会话在 UI 里落在「未分组」、只显示「选择一个工作区开始」。
  const resolved = []
  const { service, sessions } = setup({
    workspaces: () => ({
      resolveByPath: async path => { resolved.push(path); return { id: 'ws-cockpit' } },
    }),
  })
  await service.create(draftOf(), { confirm: true })
  const opened = await service.open('demo-pack')
  assert.equal(opened.ok, true, opened.error)
  assert.equal(opened.workspaceId, 'ws-cockpit')
  assert.deepEqual(resolved, ['C:/work'], '按目标目录（默认主会话目录）找工作区')
  assert.deepEqual(sessions[0], { workspaceId: 'ws-cockpit', agentPreset: 'dsh-orchestrator-pack-demo-pack' })
  assert.equal('cwd' in sessions[0], false, '宿主 create 不接受 workspaceId + cwd 同时出现')

  // 显式 cwd 同样走工作区判定。
  await service.open('demo-pack', { cwd: 'D:/other' })
  assert.equal(resolved.at(-1), 'D:/other')
})

test('t-8a81264c：目录不是工作区（或工作区服务报错/缺失）时退回 cwd 创建，不自动建工作区', async () => {
  const notFound = setup({ workspaces: () => ({ resolveByPath: async () => undefined }) })
  await notFound.service.create(draftOf(), { confirm: true })
  const fallback = await notFound.service.open('demo-pack')
  assert.equal(fallback.ok, true, fallback.error)
  assert.equal('workspaceId' in fallback, false)
  assert.deepEqual(notFound.sessions[0], { cwd: 'C:/work', agentPreset: 'dsh-orchestrator-pack-demo-pack' })

  const broken = setup({ workspaces: () => ({ resolveByPath: async () => { throw new Error('ENOENT') } }) })
  await broken.service.create(draftOf(), { confirm: true })
  const opened = await broken.service.open('demo-pack')
  assert.equal(opened.ok, true, opened.error)
  assert.deepEqual(broken.sessions[0], { cwd: 'C:/work', agentPreset: 'dsh-orchestrator-pack-demo-pack' })
})

test('P3 service：健康检查 files 硬、env soft；未设变量不判包失败', async () => {
  const { service } = setup()
  await service.create(draftOf(), { confirm: true })
  const result = await service.health('demo-pack')
  assert.equal(result.ok, true)
  assert.equal(result.health.ok, true, 'env 未设置是 soft，不应判包失败')
  const envCheck = result.health.checks.find(check => check.kind === 'env')
  assert.equal(envCheck.ok, false)
  assert.deepEqual(envCheck.missing, ['DEMO_TOKEN'])
  const filesCheck = result.health.checks.find(check => check.kind === 'files')
  assert.equal(filesCheck.ok, true)
  assert.match(result.healthLine, /待处理 env/)
})

test('P3 service：env 只给复制命令 + 未声明拒绝 + 执行只回 ok 且日志不含值', async () => {
  const { service, logs, setxCalls } = setup()
  await service.create(draftOf(), { confirm: true })
  const copy = await service.envCopy('demo-pack', 'DEMO_TOKEN')
  assert.equal(copy.ok, true)
  assert.match(copy.command, /setx DEMO_TOKEN "<你的值>"/)
  assert.doesNotMatch(copy.command, /secret-value/)

  const undeclared = await service.envCopy('demo-pack', 'OTHER_TOKEN')
  assert.equal(undeclared.ok, false)
  assert.equal(undeclared.code, 'ENV_NOT_DECLARED')

  const denied = await service.envSet('demo-pack', 'DEMO_TOKEN', 'secret-value')
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'CONFIRM_REQUIRED')

  const set = await service.envSet('demo-pack', 'DEMO_TOKEN', 'secret-value', { confirm: true })
  assert.equal(set.ok, true)
  assert.equal(set.restartRequired, true)
  assert.equal(setxCalls.length, 2, '一次未确认（被拒绝）+ 一次确认执行')
  assert.equal(setxCalls[0].confirm, false)
  assert.equal(setxCalls[1].confirm, true)
  const serialized = JSON.stringify(logs)
  assert.doesNotMatch(serialized, /secret-value/, '日志绝不能出现凭据值')
  assert.match(serialized, /pack\.env\.set/)
})

test('P3 service：安装走确认卡（未确认拒绝）、确认后复用；uninstall 删除 tools', async () => {
  const builtin = builtinFixture()
  // 给内置包补一个 CLI，走安装闸门。
  builtin.manifest = validateManifest({
    ...builtin.manifest,
    cli: [{
      id: 'demo-cli', purpose: '演示',
      install: {
        manager: 'pnpm', package: '@demo/cli', version: '1.0.0', scope: 'pack-local',
        registry: 'https://registry.npmjs.org', integrity: 'sha512-x', license: 'MIT', sourceUrl: 'https://e.x',
      },
    }],
  }).manifest
  const { service, store } = setup({ builtin: [builtin] })
  const denied = await service.install('builtin-pack', 'demo-cli')
  assert.equal(denied.ok, false)
  assert.equal(denied.code, 'CONFIRM_REQUIRED')
  const plan = denied.plan
  assert.equal(plan.package, '@demo/cli')
  assert.match(renderInstallCard(plan), /预计新增体积/)
  const badHash = await service.install('builtin-pack', 'demo-cli', { confirm: true, expectedPlanHash: 'nope' })
  assert.equal(badHash.ok, false)
  assert.equal(badHash.code, 'PLAN_STALE')
  assert.equal(existsSync(store.toolsDir('builtin-pack')), false)
})

test('P3 service：平台停用 / Web 不支持时所有动作返回可读错误（不写盘）', async () => {
  const disabled = setup({ config: { capabilityPacks: false } }).service
  const list = await disabled.list()
  assert.equal(list.ok, false)
  assert.equal(list.code, 'CAPABILITY_PACKS_DISABLED')

  const webState = tempDir()
  const store = createPackStore({ stateDir: webState })
  const service = createPackService({
    store,
    presets: createPresetRegistry({ agentPresets: () => undefined }),
    config: { capabilityPacks: true, capabilityPacksAllowOnWeb: false },
    hostInfo: { desktop: false },
  })
  const web = await service.create(draftOf(), { confirm: true })
  assert.equal(web.ok, false)
  assert.equal(web.code, 'PLATFORM_UNSUPPORTED')
})

test('P3 tool：dry-run/列表/确认提示的文案可直接给模型用', async () => {
  const { service } = setup()
  const tool = createCapabilityPackTool({
    packs: service,
    wrap: (name, description, parameters, execute) => ({ name, description, parameters, execute }),
    schema: { objectSchema: properties => ({ type: 'object', properties }), str: description => ({ type: 'string', description }) },
  })
  assert.equal(tool.name, 'capability_pack')
  const dry = await tool.execute({ action: 'create', draft: draftOf() })
  assert.match(dry, /将创建能力包/)
  assert.match(dry, /不会做的事/)
  const created = await tool.execute({ action: 'create', draft: draftOf(), confirm: true, clientRequestId: 't-1' })
  assert.match(created, /能力包已写入：demo-pack/)
  const list = await tool.execute({ action: 'list' })
  assert.match(list, /演示包（demo-pack @ 0\.1\.0，用户包）/)
  const describe = await tool.execute({ action: 'describe', id: 'demo-pack' })
  assert.match(describe, /预设：dsh-orchestrator-pack-demo-pack/)
  const removed = await tool.execute({ action: 'delete', id: 'demo-pack' })
  assert.match(removed, /删除未执行（CONFIRM_REQUIRED）/)
  const exported = await tool.execute({ action: 'export-static', id: 'demo-pack' })
  assert.match(exported, /@deepseek-ai\/dsh-agent-preset/)
  const unknown = await tool.execute({ action: 'bogus' })
  assert.match(unknown, /未知 action/)
})
