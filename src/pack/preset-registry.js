// 预设注册：运行时 `agentPresets.register()` 为主（P0 门禁 GO），静态 `cordis.patch.yml` 兜底。
//
// 为什么要有这一层而不是在 index.js 里直接调：
//   1. **服务可缺失**：`agentPresets` 是宿主 plane 的可选服务，老版本/裁剪版没有。缺了就返回
//      `{ ok:false, mode:'static' }` + 可粘贴的 YAML，绝不让插件加载失败（面板/工具照常）。
//   2. **重复注册**：同一预设 id 再注册 = 替换。先 unregister 再 register，避免「旧行还在、
//      新行没生效」的幽灵条目。
//   3. **撤回**：删包/升级必须真正 unregister；已开会话按平台语义保旧 revision（我们不做额外处理）。
//   4. **可观测**：注册结果写审计日志（id/mode/错误），面板与排障都从这里读。
//
// 运行时注册成功也不代表宿主 UI 立即刷新（P0 未验项）；所以静态导出始终保留，不是死代码。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { validateManifest, validateSkillMarkdown } from './manifest.js'
import { exportStaticPreset } from './preset-template.js'

/** 内置包目录：随插件包发（package.json files 里有 `packs/`）。 */
export function builtinPacksDir() {
  return fileURLToPath(new URL('../../packs/', import.meta.url))
}

/**
 * 读取并校验内置包（只读；不复制、不写 state）。
 * @param {string} [root] - 包根目录（默认随插件的 `packs/`）
 * @returns {Array<{ id: string, packRoot: string, manifest?: object, errors: string[] }>}
 */
export function loadBuiltinPacks(root = builtinPacksDir()) {
  const out = []
  if (!existsSync(root)) return out
  for (const name of readdirSync(root)) {
    const packRoot = join(root, name)
    try {
      if (!statSync(packRoot).isDirectory()) continue
    } catch { continue }
    let parsed
    try {
      parsed = JSON.parse(readFileSync(join(packRoot, 'pack.json'), 'utf8'))
    } catch (error) {
      out.push({ id: name, packRoot, errors: [`读不到/解析不了内置包 pack.json：${error?.message ?? error}`] })
      continue
    }
    const result = validateManifest(parsed)
    if (result.ok !== true) {
      out.push({ id: name, packRoot, errors: result.errors })
      continue
    }
    const errors = []
    for (const skill of result.manifest.skills) {
      const file = join(packRoot, result.manifest.skillsDir, skill.name, 'SKILL.md')
      let text
      try {
        text = readFileSync(file, 'utf8')
      } catch (error) {
        errors.push(`内置包技能缺失：${file}（${error?.message ?? error}）`)
        continue
      }
      const check = validateSkillMarkdown(text, { file, expectedName: skill.name })
      if (check.ok !== true) errors.push(...check.errors)
    }
    out.push({ id: result.manifest.id, packRoot, manifest: result.manifest, errors })
  }
  return out.sort((left, right) => left.id.localeCompare(right.id))
}

/**
 * 造预设注册表。
 * @param {object} options
 * @param {() => any} [options.agentPresets] - 惰性取宿主服务（`ctx.get('agentPresets')` 口径）
 * @param {(message: string) => void} [options.onWarn]
 * @param {(event: string, fields?: object) => void} [options.log]
 */
export function createPresetRegistry({ agentPresets = () => undefined, onWarn = () => {}, log = () => {} } = {}) {
  const registered = new Map()

  const service = () => {
    try {
      return agentPresets()
    } catch {
      return undefined
    }
  }

  const runtimeAvailable = () => {
    const value = service()
    return value !== undefined && value !== null && typeof value.register === 'function'
  }

  /** 注册（替换语义）。失败不抛：返回 static 兜底 + 可读原因。 */
  const register = async definition => {
    const id = definition?.id
    if (typeof id !== 'string' || id === '') return { ok: false, mode: 'static', error: '预设定义缺少 id' }
    if (!runtimeAvailable()) {
      log('pack.preset.unavailable', { detail: { id } })
      return { ok: false, mode: 'static', error: '宿主未提供 agentPresets 服务（运行时预设不可用）', id }
    }
    if (registered.has(id)) await unregister(id)
    try {
      const disposer = await service().register(definition)
      if (typeof disposer !== 'function') throw new Error('agentPresets.register() 未返回 unregister 函数')
      registered.set(id, { disposer, definition })
      log('pack.preset.register', { detail: { id, mode: 'runtime' } })
      return { ok: true, mode: 'runtime', id }
    } catch (error) {
      const reason = error?.message ?? String(error)
      log('pack.preset.register-failed', { detail: { id, error: reason } })
      onWarn(`dsh-orchestrator: 能力包预设「${id}」运行时注册失败（已给静态兜底）：${reason}`)
      return { ok: false, mode: 'static', error: reason, id }
    }
  }

  /** 撤销（幂等）：返回是否真的撤了一条。 */
  const unregister = async id => {
    const entry = registered.get(id)
    if (entry === undefined) {
      // 不是本进程注册的：仍尝试调宿主 unregister（可能是上一轮 apply 的残留），失败就算了。
      const value = service()
      if (typeof value?.unregister !== 'function') return false
      try {
        await value.unregister(id)
        return true
      } catch {
        return false
      }
    }
    registered.delete(id)
    try {
      await entry.disposer()
      log('pack.preset.unregister', { detail: { id } })
      return true
    } catch (error) {
      log('pack.preset.unregister-failed', { detail: { id, error: error?.message ?? String(error) } })
      return false
    }
  }

  const isRegistered = id => registered.has(id)

  /** 宿主侧可见的预设 id 列表（诊断用；失败返回 undefined）。 */
  const hostIds = () => {
    const value = service()
    if (typeof value?.list !== 'function') return undefined
    try {
      const rows = value.list()
      if (!Array.isArray(rows)) return undefined
      return rows.map(row => row?.id).filter(id => typeof id === 'string')
    } catch {
      return undefined
    }
  }

  const staticFallback = definition => exportStaticPreset(definition)

  return { register, unregister, isRegistered, hostIds, runtimeAvailable, staticFallback }
}

/**
 * 能力包预设的静态兜底提示（面板/工具/文档共用一句）。
 * @param {object} definition
 */
export function staticFallbackHint(definition) {
  return [
    `运行时注册不可用：把下面这段粘进当前 profile 的 cordis.patch.yml（顶层，与既有 insert 并列），然后彻底退出 DSH 再启动。`,
    staticFallbackText(definition),
  ].join('\n')
}

const staticFallbackText = definition => exportStaticPreset(definition)
