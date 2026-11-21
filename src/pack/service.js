// 能力包服务（P3 的「大脑」）：把 store / 预设注册 / 安装器 / 健康检查 / 会话创建收在一处。
//
// 为什么要有 service 而不是让工具和 HTTP 路由各调一套：
//   1. **同源**：工具返回的安装确认卡、面板显示的 argv/体积、实际执行的 argv 必须逐字一致；
//   2. **闸门唯一**：create/update/delete/install 的 confirm、dryRun、幂等键只在这里判一次；
//   3. **回滚集中**：update 失败把旧目录从 .trash 搬回来、create 失败不留半截包，都在这里收口；
//   4. **可测试**：宿主服务、spawn、时钟、env 全部注入，单测不需要真宿主、不联网、不装包。
//
// 边界（计划 §6.6）：
//   - 只改 `$DSH_HOME/state/orchestrator/capability-packs` 与运行时预设；不碰 profile、不写 PATH；
//   - 不读凭据值（env 只查布尔存在性）；setx 执行只回 `{ok, code}`；
//   - 内置包只读：update/delete 一律拒绝；
//   - 能力包会话是普通根会话：open 只调 `sessionController.create`，不写台账、不进队列。

import { join } from 'node:path'
import { buildPackFromDraft, renderDryRun } from './generate.js'
import { buildPresetDefinition } from './preset-template.js'
import { capabilityPacksUsable } from './platform.js'
import { envCommand, envSummary, executeSetx } from './env.js'
import { checkPackHealth, healthLine } from './health.js'
import { MEASURED_INSTALL } from './install.js'

const text = value => (typeof value === 'string' ? value.trim() : '')
const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)

/** 把任意 payload 归一成稳定字符串（幂等键比对用；不参与落盘）。 */
const stableStringify = value => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

/**
 * @param {object} options
 * @param {object} options.store - createPackStore()
 * @param {object} options.presets - createPresetRegistry()
 * @param {object} [options.installer] - createInstaller()
 * @param {object} [options.config] - loadConfig()
 * @param {{ desktop: boolean, profileName?: string }} [options.hostInfo]
 * @param {Array<{id: string, packRoot: string, manifest: object, definition?: object, mode?: string}>} [options.builtin]
 * @param {() => any} [options.sessionController]
 * @param {() => (string | undefined)} [options.workspaceDir]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {() => number} [options.now]
 * @param {(event: string, fields?: object) => void} [options.log]
 * @param {(message: string) => void} [options.onWarn]
 */
export function createPackService({
  store,
  presets,
  installer,
  config = {},
  hostInfo = { desktop: false },
  builtin = [],
  sessionController = () => undefined,
  workspaceDir = () => undefined,
  env = process.env,
  now = Date.now,
  log = () => {},
  onWarn = () => {},
  setx = executeSetx,
} = {}) {
  if (store === undefined) throw new Error('createPackService 需要 store')
  if (presets === undefined) throw new Error('createPackService 需要 presets')
  const idempotent = new Map()
  const stateDir = store.paths.root.replace(/[\\/]capability-packs$/, '')

  const usable = () => capabilityPacksUsable(config, hostInfo)

  const requireUsable = () => {
    const check = usable()
    return check.ok === true ? undefined : { ok: false, code: check.code, error: check.message }
  }

  /** 幂等执行：同 clientRequestId + 同 payload 只执行一次，重复调用回 cached 结果。 */
  const idempotentRun = async (key, payload, run) => {
    if (text(key) === '') return await run()
    const hash = stableStringify(payload)
    const hit = idempotent.get(key)
    if (hit !== undefined) {
      if (hit.hash === hash) return { ...hit.result, duplicate: true }
      return { ok: false, code: 'IDEMPOTENCY_CONFLICT', error: '同一个 clientRequestId 被用于不同请求：换一个新 id 再试' }
    }
    const result = await run()
    if (result?.ok === true) idempotent.set(key, { hash, result })
    return result
  }

  // ── 包目录/条目 ──────────────────────────────────────────────
  const builtinEntries = () => builtin
    .filter(item => item?.manifest !== undefined)
    .map(item => ({ kind: 'builtin', id: item.id ?? item.manifest.id, packRoot: item.packRoot, manifest: item.manifest, definition: item.definition, mode: item.mode ?? 'runtime' }))

  const userEntries = () => {
    const { registry } = store.readRegistry()
    return store.listLocalPacks().map(item => ({
      kind: 'factory',
      id: item.id,
      packRoot: item.dir,
      manifest: item.manifest,
      error: item.error,
      registryEntry: registry.packages[item.id],
    }))
  }

  const findEntry = id => {
    const value = text(id)
    if (value === '') return undefined
    return [...builtinEntries(), ...userEntries()].find(item => item.id === value)
  }

  const definitionOf = entry => entry.definition ?? buildPresetDefinition({
    manifest: entry.manifest,
    packRoot: entry.packRoot,
    installStatePath: store.installStatePath(entry.id),
    stateDir,
    workspaceDir: workspaceDir() ?? '',
  })

  const healthOf = (entry, { persist = true } = {}) => {
    const health = checkPackHealth({
      manifest: entry.manifest,
      packRoot: entry.packRoot,
      id: entry.id,
      installer,
      env,
      now,
    })
    if (persist === true && entry.kind === 'factory') {
      try { store.writeHealth(entry.id, health) } catch { /* 状态写失败不影响展示 */ }
    }
    return health
  }

  const viewOf = (entry, { detailed = false, persist = true } = {}) => {
    const manifest = entry.manifest
    const presetId = manifest.preset.id
    const installStatus = manifest.cli.map(cli => {
      const status = installer === undefined ? { status: 'unknown' } : installer.statusOf(manifest, cli.id)
      return {
        id: cli.id,
        package: cli.install.package,
        version: cli.install.version,
        purpose: cli.purpose,
        license: cli.install.license,
        ...status,
        // 确认卡与面板同源：列表面板点「安装」时直接用它渲染，不必再请求一次。
        ...(installer === undefined ? {} : { plan: installer.plan(manifest, cli.id) }),
      }
    })
    const health = healthOf(entry, { persist })
    return {
      id: entry.id,
      kind: entry.kind,
      name: manifest.name,
      description: manifest.description,
      version: manifest.version,
      publisher: manifest.publisher,
      presetId,
      presetRegistered: presets.isRegistered(presetId),
      skills: manifest.skills,
      cli: installStatus,
      env: envSummary(manifest, env),
      health,
      healthLine: healthLine(health),
      dir: entry.packRoot,
      deletable: entry.kind === 'factory',
      updatable: entry.kind === 'factory',
      lastOpenedAt: entry.registryEntry?.lastOpenedAt ?? null,
      ...(entry.error === undefined ? {} : { error: entry.error }),
      ...(entry.mode === undefined ? {} : { presetMode: entry.mode }),
    }
  }

  /** 面板/工具列表：可用性 + 全部包视图（内置在前）。`persist:false` = 严格只读投影（不写 health/不清理 trash）。 */
  const list = ({ persist = true } = {}) => {
    const check = usable()
    if (check.ok !== true) return { ok: false, code: check.code, error: check.message, usable: false, packs: [] }
    if (persist === true) {
      try { store.purgeTrash() } catch { /* 清理失败不影响列表 */ }
    }
    const packs = [...builtinEntries(), ...userEntries()]
      .map(entry => (entry.manifest === undefined ? { id: entry.id, kind: entry.kind, dir: entry.packRoot, error: entry.error } : viewOf(entry, { persist })))
    return { ok: true, usable: true, packs }
  }

  const describe = id => {
    const denied = requireUsable()
    if (denied !== undefined) return denied
    const entry = findEntry(id)
    if (entry === undefined) return { ok: false, code: 'PACK_NOT_FOUND', error: `没有能力包 ${JSON.stringify(id)}` }
    if (entry.manifest === undefined) return { ok: false, code: 'PACK_BROKEN', error: entry.error ?? '包的 pack.json 不可读' }
    const view = viewOf(entry, { detailed: true })
    const definition = definitionOf(entry)
    return {
      ok: true,
      pack: view,
      manifest: entry.manifest,
      preset: {
        id: definition.id,
        registered: presets.isRegistered(definition.id),
        runtimeAvailable: presets.runtimeAvailable(),
        staticYaml: presets.staticFallback(definition),
      },
      installPlans: entry.manifest.cli.map(cli => installer === undefined ? { ok: false, error: '安装器不可用' } : installer.plan(entry.manifest, cli.id)),
      measured: { ...MEASURED_INSTALL },
    }
  }

  // ── create / update / delete ─────────────────────────────────
  const create = async (draft, { dryRun = false, confirm = false, clientRequestId } = {}) => {
    const denied = requireUsable()
    if (denied !== undefined) return denied
    return await idempotentRun(clientRequestId, { action: 'create', draft, dryRun, confirm }, async () => {
      const built = buildPackFromDraft(draft, { now })
      if (built.ok !== true) return { ok: false, code: 'DRAFT_INVALID', error: built.errors.join('；'), errors: built.errors }
      const existing = store.readManifest(built.manifest.id)
      if (existing.ok === true) {
        return { ok: false, code: 'PACK_EXISTS', error: `能力包 ${built.manifest.id} 已存在；要改内容请用 action:'update'` }
      }
      const plan = {
        files: Object.keys(built.files).sort().map(path => ({ path, chars: built.files[path].length })),
        manifest: built.manifest,
        text: renderDryRun(built),
        cliPlans: installer === undefined ? [] : built.manifest.cli.map(cli => installer.plan(built.manifest, cli.id)),
        env: built.manifest.env,
      }
      if (dryRun === true || confirm !== true) {
        return { ok: true, dryRun: true, id: built.manifest.id, plan, error: undefined }
      }
      return await writeAndRegister({ manifest: built.manifest, files: built.files, action: 'create' })
    })
  }

  const writeAndRegister = async ({ manifest, files, action, previous }) => {
    const written = store.writePack(manifest, files)
    if (written.ok !== true) return { ok: false, code: 'WRITE_FAILED', error: written.errors.join('；'), errors: written.errors }
    const packRoot = store.packDir(manifest.id)
    const definition = buildPresetDefinition({
      manifest,
      packRoot,
      installStatePath: store.installStatePath(manifest.id),
      stateDir,
      workspaceDir: workspaceDir() ?? '',
    })
    const registered = await presets.register(definition)
    if (registered.ok !== true) {
      // 运行时注册失败：**保留包**（技能/文件可用），返回静态兜底；更新时把旧目录搬回来更危险，
      // 因为用户的新内容已经写好了——所以这里只提示，不回滚内容。
      onWarn(`dsh-orchestrator: 能力包 ${manifest.id} 的预设未运行时注册：${registered.error}`)
    }
    const health = healthOf({ kind: 'factory', id: manifest.id, packRoot, manifest })
    try {
      store.recordPack(manifest, { previous })
    } catch (error) {
      onWarn(`dsh-orchestrator: 能力包 ${manifest.id} 写入 registry 失败（包本身可用）：${error?.message ?? error}`)
    }
    log('pack.action', { detail: { action, id: manifest.id, presetMode: registered.mode, healthOk: health.ok } })
    return {
      ok: true,
      id: manifest.id,
      dryRun: false,
      presetId: definition.id,
      mode: registered.mode,
      ...(registered.ok === true ? {} : { warning: registered.error, staticYaml: presets.staticFallback(definition) }),
      health,
      healthLine: healthLine(health),
      files: Object.keys(files).sort(),
      ...(written.replaced === true ? { previousTrash: written.previousTrash } : {}),
    }
  }

  const update = async (id, draft, { dryRun = false, confirm = false, clientRequestId } = {}) => {
    const denied = requireUsable()
    if (denied !== undefined) return denied
    const entry = findEntry(id)
    if (entry === undefined) return { ok: false, code: 'PACK_NOT_FOUND', error: `没有能力包 ${JSON.stringify(id)}` }
    if (entry.kind !== 'factory') return { ok: false, code: 'BUILTIN_READONLY', error: '内置包只读，随插件版本升级；不能在这里改' }
    return await idempotentRun(clientRequestId, { action: 'update', id, draft, dryRun, confirm }, async () => {
      const merged = { ...draft, id, publisher: 'factory' }
      const built = buildPackFromDraft(merged, { now })
      if (built.ok !== true) return { ok: false, code: 'DRAFT_INVALID', error: built.errors.join('；'), errors: built.errors }
      const plan = {
        files: Object.keys(built.files).sort().map(path => ({ path, chars: built.files[path].length })),
        manifest: built.manifest,
        text: renderDryRun(built),
        cliPlans: installer === undefined ? [] : built.manifest.cli.map(cli => installer.plan(built.manifest, cli.id)),
        env: built.manifest.env,
      }
      if (dryRun === true || confirm !== true) return { ok: true, dryRun: true, id, plan }
      const previous = entry.registryEntry
      const result = await writeAndRegister({ manifest: built.manifest, files: built.files, action: 'update', previous })
      if (result.ok !== true) return result
      return result
    })
  }

  const remove = async (id, { confirm = false, clientRequestId } = {}) => {
    const denied = requireUsable()
    if (denied !== undefined) return denied
    const entry = findEntry(id)
    if (entry === undefined) return { ok: false, code: 'PACK_NOT_FOUND', error: `没有能力包 ${JSON.stringify(id)}` }
    if (entry.kind !== 'factory') return { ok: false, code: 'BUILTIN_READONLY', error: '内置包不可删除（随插件版本升级）' }
    if (confirm !== true) {
      return {
        ok: false,
        code: 'CONFIRM_REQUIRED',
        error: `删除「${entry.manifest.name}」需要确认：会撤销预设、把包目录移进 .trash（保留 24h）、删除 tools/${id}。确认后再调 confirm:true`,
      }
    }
    return await idempotentRun(clientRequestId, { action: 'delete', id, confirm }, async () => {
      await presets.unregister(entry.manifest.preset.id)
      const removed = store.removePack(id)
      if (removed.ok !== true) return { ok: false, code: 'DELETE_FAILED', error: removed.error }
      log('pack.action', { detail: { action: 'delete', id } })
      return { ok: true, id, deleted: true, trashPath: removed.trashPath ?? null, presetUnregistered: true }
    })
  }

  // ── install / uninstall ──────────────────────────────────────
  const install = async (id, cliId, { confirm = false, expectedPlanHash } = {}) => {
    const denied = requireUsable()
    if (denied !== undefined) return denied
    const entry = findEntry(id)
    if (entry === undefined) return { ok: false, code: 'PACK_NOT_FOUND', error: `没有能力包 ${JSON.stringify(id)}` }
    if (entry.manifest === undefined) return { ok: false, code: 'PACK_BROKEN', error: entry.error ?? '包不可读' }
    if (installer === undefined) return { ok: false, code: 'INSTALLER_UNAVAILABLE', error: '安装器不可用（宿主侧未装配）' }
    const result = await installer.install({ manifest: entry.manifest, cliId, confirm, expectedPlanHash })
    const health = healthOf(entry)
    log('pack.install.result', { detail: { id, cliId, ok: result.ok, code: result.code ?? null, reused: result.reused === true } })
    return { ...result, health, healthLine: healthLine(health) }
  }

  const uninstall = (id, cliId) => {
    const denied = requireUsable()
    if (denied !== undefined) return denied
    const entry = findEntry(id)
    if (entry === undefined) return { ok: false, code: 'PACK_NOT_FOUND', error: `没有能力包 ${JSON.stringify(id)}` }
    if (installer === undefined) return { ok: false, code: 'INSTALLER_UNAVAILABLE', error: '安装器不可用' }
    const result = installer.uninstall(id)
    if (result.ok !== true) return { ok: false, code: 'UNINSTALL_FAILED', error: result.error }
    const health = healthOf(entry)
    return { ok: true, id, cliId, health, healthLine: healthLine(health) }
  }

  const health = id => {
    const denied = requireUsable()
    if (denied !== undefined) return denied
    const entry = findEntry(id)
    if (entry === undefined) return { ok: false, code: 'PACK_NOT_FOUND', error: `没有能力包 ${JSON.stringify(id)}` }
    if (entry.manifest === undefined) return { ok: false, code: 'PACK_BROKEN', error: entry.error ?? '包不可读' }
    const result = healthOf(entry)
    return { ok: true, id, health: result, healthLine: healthLine(result) }
  }

  // ── 开包会话 ────────────────────────────────────────────────
  const open = async (id, { cwd } = {}) => {
    const denied = requireUsable()
    if (denied !== undefined) return denied
    const entry = findEntry(id)
    if (entry === undefined) return { ok: false, code: 'PACK_NOT_FOUND', error: `没有能力包 ${JSON.stringify(id)}` }
    if (entry.manifest === undefined) return { ok: false, code: 'PACK_BROKEN', error: entry.error ?? '包不可读' }
    const definition = definitionOf(entry)
    const registered = presets.isRegistered(definition.id)
    if (!registered) {
      return {
        ok: false,
        code: 'PRESET_NOT_REGISTERED',
        error: `预设 ${definition.id} 未运行时注册（静态兜底模式下需改 profile 并彻底重启 DSH）：${presets.runtimeAvailable() ? '注册失败，见日志' : '宿主缺 agentPresets 服务'}`,
        staticYaml: presets.staticFallback(definition),
      }
    }
    const controller = sessionController()
    if (controller === undefined || typeof controller.create !== 'function') {
      return { ok: false, code: 'SESSION_UNAVAILABLE', error: '宿主未提供 sessionController，无法开包会话' }
    }
    const target = text(cwd) !== '' ? cwd : workspaceDir()
    if (text(target) === '') return { ok: false, code: 'CWD_REQUIRED', error: '缺少 cwd：请给包会话工作目录（默认取主会话目录）' }
    try {
      const created = await controller.create({ cwd: target, agentPreset: definition.id })
      const sessionId = created?.sessionId
      if (typeof sessionId !== 'string' || sessionId === '') {
        return { ok: false, code: 'SESSION_CREATE_FAILED', error: 'sessionController.create 未返回 sessionId' }
      }
      try { store.touchPack(entry.id) } catch { /* 打开时间写失败不影响会话 */ }
      log('pack.open', { detail: { id, sessionId } })
      return { ok: true, sessionId, presetId: definition.id, cwd: target }
    } catch (error) {
      return { ok: false, code: 'SESSION_CREATE_FAILED', error: `开包会话失败：${error?.message ?? error}` }
    }
  }

  // ── 静态兜底 ────────────────────────────────────────────────
  const exportStatic = id => {
    const entry = findEntry(id)
    if (entry === undefined) return { ok: false, code: 'PACK_NOT_FOUND', error: `没有能力包 ${JSON.stringify(id)}` }
    if (entry.manifest === undefined) return { ok: false, code: 'PACK_BROKEN', error: entry.error ?? '包不可读' }
    const definition = definitionOf(entry)
    return {
      ok: true,
      id,
      presetId: definition.id,
      yaml: presets.staticFallback(definition),
      hint: '把 yaml 粘进当前 profile 的 cordis.patch.yml 顶层，然后彻底退出 DSH 再启动；静态预设不热加载。',
    }
  }

  // ── 环境变量 ────────────────────────────────────────────────
  const envList = id => {
    const entry = findEntry(id)
    if (entry === undefined) return { ok: false, code: 'PACK_NOT_FOUND', error: `没有能力包 ${JSON.stringify(id)}` }
    if (entry.manifest === undefined) return { ok: false, code: 'PACK_BROKEN', error: entry.error ?? '包不可读' }
    return { ok: true, id, env: envSummary(entry.manifest, env), platform: process.platform }
  }

  const envCopy = (id, ref) => {
    const entry = findEntry(id)
    if (entry === undefined) return { ok: false, code: 'PACK_NOT_FOUND', error: `没有能力包 ${JSON.stringify(id)}` }
    const declared = entry.manifest?.env?.find(item => item.ref === ref)
    if (declared === undefined) return { ok: false, code: 'ENV_NOT_DECLARED', error: `包没有声明环境变量 ${JSON.stringify(ref)}` }
    const command = envCommand(ref, { platform: process.platform })
    if (command.ok !== true) return command
    log('pack.env.copy', { detail: { id, ref } })
    return { ok: true, id, ref, ...command }
  }

  const envSet = async (id, ref, value, { confirm = false } = {}) => {
    const entry = findEntry(id)
    if (entry === undefined) return { ok: false, code: 'PACK_NOT_FOUND', error: `没有能力包 ${JSON.stringify(id)}` }
    const allowed = (entry.manifest?.env ?? []).map(item => item.ref)
    const result = await setx({ ref, value, confirm, allowedRefs: allowed })
    // 审计只记 ref/mode/result——**绝不**记 value。
    log('pack.env.set', { detail: { id, ref, mode: 'setx', result: result.ok === true ? 'ok' : result.code } })
    return { ...result, id, ref, restartRequired: result.ok === true }
  }

  return {
    usable,
    list,
    describe,
    create,
    update,
    delete: remove,
    install,
    uninstall,
    health,
    open,
    exportStatic,
    envList,
    envCopy,
    envSet,
    findEntry,
    viewOf,
  }
}
