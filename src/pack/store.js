// 能力包存储：唯一写入根 `$DSH_HOME/state/orchestrator/capability-packs`（计划 §2.2）。
//
// 三条硬约束：
//   1. **原子写**：所有 JSON 先写 `.tmp-*` 再 rename；包目录先写 `.tmp-<id>-*` 再整体 rename。
//      半截文件比「没写」更坏——registry 读坏一次，面板会把所有包当成丢失。
//   2. **路径不越界**：包 id / 相对路径都先校验，`packs/<id>` 必须落在 packsDir 内；
//      删除与移动前再 resolve 一次做前缀检查（测试锁住 `../` 与盘符）。
//   3. **删除可回退**：包目录进 `.trash/<id>.<epoch>/` 保留 24h，tools 目录直接删（可重装）；
//      内置包只读，store 不提供写内置包的入口。
//
// 本模块不注册预设、不跑安装器、不碰网络：那些是 preset-registry / install 的职责。
// registry 的写入时机由调用方控制（create 是「包落盘 → 预设注册 → 健康 → registry」，
// 所以 writePack 只写目录，registry 单独写），避免两步之间失败留下「registry 说有、磁盘没有」。

import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { PACK_ID, normalizeRelativePath, relativePathProblem, validateManifest, validateSkillMarkdown } from './manifest.js'
import { emptyRegistry, normalizeRegistry, touchOpened, upsertEntry } from './registry.js'

/** 包状态目录布局（append-only：只加字段，不改已有字段含义）。 */
export function packPaths(stateDir) {
  const root = join(stateDir, 'capability-packs')
  return {
    root,
    packsDir: join(root, 'packs'),
    toolsDir: join(root, 'tools'),
    trashDir: join(root, '.trash'),
    registryPath: join(root, 'registry.json'),
  }
}

/** 校验「目标确实在 base 之内」，防 ../ 造成的越界（返回绝对路径）。 */
export function assertInside(base, target) {
  const root = resolve(base)
  const full = resolve(target)
  const rel = relative(root, full)
  if (rel === '') return full
  if (rel.startsWith('..') || rel.includes(`..${sep}`) || resolve(root, rel) !== full) {
    throw new Error(`路径越界：${full} 不在 ${root} 内`)
  }
  return full
}

/** 原子写文本：同目录 `.tmp-*` → rename。rename 失败时清掉临时文件并抛原错。 */
export function atomicWriteFile(file, content) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid.toString(36)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  writeFileSync(tmp, content, 'utf8')
  try {
    renameSync(tmp, file)
  } catch (error) {
    try { rmSync(tmp, { force: true }) } catch { /* 清理失败不掩盖原错 */ }
    throw error
  }
}

/** 原子写 JSON（格式化 + 末尾换行；人类可读，方便用户手改/排障）。 */
export function atomicWriteJson(file, value) {
  atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = value => (typeof value === 'string' ? value.trim() : '')

/** 同步小睡（Windows 上杀毒/索引器会短暂占用刚写完的目录，rename 会 transient EPERM）。 */
const sleepSync = ms => {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch { /* 不支持 SAB 时直接不睡 */ }
}

/**
 * rename 重试：Windows 上「刚写完/刚删」的目录可能被索引器或技能 watcher 短暂占用（EPERM/EBUSY）。
 * 这不是逻辑错误；退避重试最多约 10 秒（20 × 50ms 递增）仍失败才交给调用方回滚。
 */
function renameWithRetry(from, to, { attempts = 20, delayMs = 50 } = {}) {
  let lastError
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      renameSync(from, to)
      return
    } catch (error) {
      lastError = error
      const transient = error?.code === 'EPERM' || error?.code === 'EBUSY' || error?.code === 'EACCES'
      if (!transient || attempt === attempts - 1) break
      sleepSync(delayMs * (attempt + 1))
    }
  }
  throw lastError
}

/**
 * 造一个包存储。
 * @param {object} options
 * @param {string} options.stateDir - 插件唯一写入根（`$DSH_HOME/state/orchestrator`）
 * @param {() => number} [options.now]
 * @param {(event: string, fields?: object) => void} [options.log] - 审计日志（不记凭据值）
 */
export function createPackStore({ stateDir, now = Date.now, log = () => {} } = {}) {
  if (text(stateDir) === '') throw new Error('createPackStore 需要 stateDir')
  const paths = packPaths(stateDir)

  const ensureRoot = () => {
    mkdirSync(paths.packsDir, { recursive: true })
    mkdirSync(paths.toolsDir, { recursive: true })
    mkdirSync(paths.trashDir, { recursive: true })
    return paths
  }

  const idDir = id => {
    const value = text(id)
    if (!PACK_ID.test(value)) throw new Error(`包 id 不合法：${JSON.stringify(id ?? null)}`)
    return assertInside(paths.packsDir, join(paths.packsDir, value))
  }

  // tools 目录与包目录同一道 id 校验：delete 时 `tools/<id>` 会被 rmSync，绝不允许 `../`。
  const toolsDir = id => {
    const value = text(id)
    if (!PACK_ID.test(value)) throw new Error(`包 id 不合法：${JSON.stringify(id ?? null)}`)
    return assertInside(paths.toolsDir, join(paths.toolsDir, value))
  }

  // ── registry ────────────────────────────────────────────────
  const readRegistry = () => {
    let raw
    try {
      raw = readFileSync(paths.registryPath, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return { registry: emptyRegistry(), error: undefined }
      return { registry: emptyRegistry(), error: `registry 读取失败：${error?.message ?? error}` }
    }
    try {
      return { registry: normalizeRegistry(JSON.parse(raw)), error: undefined }
    } catch (error) {
      return { registry: emptyRegistry(), error: `registry 不是合法 JSON（按空表处理，下一次写入会覆盖）：${error?.message ?? error}` }
    }
  }

  const writeRegistry = registry => {
    ensureRoot()
    const normalized = normalizeRegistry(registry)
    atomicWriteJson(paths.registryPath, normalized)
    return normalized
  }

  const recordPack = (manifest, { previous } = {}) => {
    const { registry } = readRegistry()
    const entry = {
      id: manifest.id,
      name: manifest.name,
      publisher: manifest.publisher,
      version: manifest.version,
      presetId: manifest.preset.id,
      dir: idDir(manifest.id),
      createdAt: Number.isFinite(previous?.createdAt) ? previous.createdAt : now(),
      updatedAt: now(),
      lastOpenedAt: Number.isFinite(previous?.lastOpenedAt) ? previous.lastOpenedAt : null,
    }
    return writeRegistry(upsertEntry(registry, entry))
  }

  const forgetPack = id => {
    const { registry } = readRegistry()
    if (registry.packages[id] === undefined) return registry
    const packages = { ...registry.packages }
    delete packages[id]
    return writeRegistry({ ...registry, packages })
  }

  /** 记一次「打开包会话」的时间（面板排序/提示用；不凭空造条目）。 */
  const touchPack = id => {
    const { registry } = readRegistry()
    const next = touchOpened(registry, id, now())
    return next === undefined ? undefined : writeRegistry(next)
  }

  /** 更新失败回滚：把 `.trash` 里的旧目录搬回来（先删当前失败版本）。 */
  const restoreTrash = (id, trashPath) => {
    const target = idDir(id)
    if (!existsSync(trashPath)) return { ok: false, error: `trash 里找不到旧版本：${trashPath}` }
    try {
      if (existsSync(target)) rmSync(target, { recursive: true, force: true })
      renameWithRetry(trashPath, target)
      log('pack.restore', { detail: { id } })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: `回滚旧版本失败：${error?.message ?? error}` }
    }
  }

  // ── manifest ────────────────────────────────────────────────
  const readManifest = id => {
    let dir
    try { dir = idDir(id) } catch (error) { return { ok: false, dir: undefined, errors: [error.message] } }
    let raw
    try {
      raw = readFileSync(join(dir, 'pack.json'), 'utf8')
    } catch (error) {
      return { ok: false, dir, errors: [`读不到 pack.json：${error?.message ?? error}`] }
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      return { ok: false, dir, errors: [`pack.json 不是合法 JSON：${error?.message ?? error}`] }
    }
    const result = validateManifest(parsed)
    return { ...result, dir, raw: parsed }
  }

  const listLocalPacks = () => {
    ensureRoot()
    const out = []
    for (const name of readdirSync(paths.packsDir)) {
      if (name.startsWith('.')) continue
      let isDir = false
      try { isDir = statSync(join(paths.packsDir, name)).isDirectory() } catch { isDir = false }
      if (!isDir) continue
      const read = readManifest(name)
      out.push(read.ok ? { id: name, dir: read.dir, manifest: read.manifest } : { id: name, dir: read.dir, error: read.errors.join('；') })
    }
    return out.sort((left, right) => left.id.localeCompare(right.id))
  }

  // ── 写包（原子目录替换） ──────────────────────────────────────
  /**
   * 写一个包目录。`pack.json` 由归一化 manifest 统一生成（调用方给的会被忽略）。
   * @param {object} manifest - 已归一化的 manifest（这里再做一次防御性校验）
   * @param {Record<string, string>} files - 相对包根路径 → 文本内容
   * @returns {{ ok: boolean, dir?: string, errors?: string[], replaced?: boolean, previousTrash?: string }}
   */
  const writePack = (manifest, files) => {
    const check = validateManifest(manifest)
    if (check.ok !== true) return { ok: false, errors: check.errors }
    const normalized = check.manifest
    if (!isObject(files)) return { ok: false, errors: ['files 必须是「相对路径 → 文本」的对象'] }

    // 1) 文件清单：路径安全 + 技能正文校验（工厂生成与内置包共用同一道闸）。
    const entries = []
    for (const [rawPath, content] of Object.entries(files)) {
      const problem = relativePathProblem(rawPath)
      if (problem !== undefined) return { ok: false, errors: [`文件 ${rawPath}：${problem}`] }
      if (typeof content !== 'string') return { ok: false, errors: [`文件 ${rawPath} 的内容必须是字符串`] }
      const rel = normalizeRelativePath(rawPath)
      // `pack.json` 由 store 统一从归一化 manifest 生成：不允许调用方塞一份与 manifest 不一致的。
      if (rel === 'pack.json') continue
      entries.push([rel, content])
    }
    // manifest 是唯一真源：落盘的 pack.json 永远是归一化结果（手改/生成器漏字段都不会漂移）。
    entries.push(['pack.json', `${JSON.stringify(normalized, null, 2)}\n`])
    const present = new Set(entries.map(([path]) => path))
    for (const skill of normalized.skills) {
      const rel = `${normalized.skillsDir}/${skill.name}/SKILL.md`
      if (!present.has(rel)) return { ok: false, errors: [`缺少技能文件：${rel}`] }
      const markdown = entries.find(([path]) => path === rel)[1]
      const skillCheck = validateSkillMarkdown(markdown, { file: rel, expectedName: skill.name })
      if (skillCheck.ok !== true) return { ok: false, errors: skillCheck.errors }
    }

    // 2) 先写临时目录，再整体 rename；失败删临时目录（不留半截包）。
    ensureRoot()
    const target = idDir(normalized.id)
    const tmp = join(paths.packsDir, `.tmp-${normalized.id}-${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
    mkdirSync(tmp, { recursive: false })
    try {
      for (const [rel, content] of entries) {
        const file = assertInside(tmp, join(tmp, rel))
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, content, 'utf8')
      }
      // 3) 旧版本进 .trash（保留 24h，删除/升级都可回退）。
      let trashPath
      if (existsSync(target)) {
        trashPath = join(paths.trashDir, `${normalized.id}.${now()}`)
        mkdirSync(paths.trashDir, { recursive: true })
        renameWithRetry(target, trashPath)
      }
      try {
        renameWithRetry(tmp, target)
      } catch (error) {
        // rename 失败：把旧版本搬回来（能恢复多少恢复多少），临时目录清掉。
        if (trashPath !== undefined && !existsSync(target)) {
          try { renameWithRetry(trashPath, target) } catch { /* 恢复失败：保留 trash 供人工恢复 */ }
        }
        throw error
      }
      log('pack.write', { detail: { id: normalized.id, files: entries.length, replaced: trashPath !== undefined } })
      return { ok: true, dir: target, replaced: trashPath !== undefined, previousTrash: trashPath }
    } catch (error) {
      try { rmSync(tmp, { recursive: true, force: true }) } catch { /* 清理失败不掩盖原错 */ }
      return { ok: false, errors: [`写包失败：${error?.message ?? error}`] }
    }
  }

  // ── 删除（包目录进 trash、tools 删除） ────────────────────────
  /**
   * 删除包目录。
   * Windows 上**运行中的包会话**的 skill-filesystem watcher 可能一直占着 `skills/` 目录，
   * 导致整目录 rename 恒 EPERM（不是瞬时占用，重试无效）。这时不能假装删掉，也不能硬删
   * （硬删会让还开着的会话中途丢技能）：改为「撤预设 + 删 registry + 删 tools + 目录延后清理」，
   * 返回 `deferred:true`；下次启动 `purgeUnregistered()` 在没人持有 watcher 时把目录搬进 .trash。
   */
  const removePack = id => {
    const target = idDir(id)
    ensureRoot()
    const trashPath = join(paths.trashDir, `${id}.${now()}`)
    let deferred = false
    try {
      if (existsSync(target)) {
        try {
          renameWithRetry(target, trashPath)
        } catch (error) {
          const transient = error?.code === 'EPERM' || error?.code === 'EBUSY' || error?.code === 'EACCES'
          if (!transient) throw error
          deferred = true
          log('pack.remove.deferred', { detail: { id, reason: error.code } })
        }
      }
      const tools = toolsDir(id)
      rmSync(tools, { recursive: true, force: true })
      forgetPack(id)
      log('pack.remove', { detail: { id, trash: existsSync(trashPath), deferred } })
      return { ok: true, deferred, trashPath: deferred || !existsSync(trashPath) ? undefined : trashPath }
    } catch (error) {
      return { ok: false, error: `删除包失败：${error?.message ?? error}` }
    }
  }

  /**
   * 清理「目录还在、registry 里已经没有」的包（启动时调用；删包被 watcher 挡住时的兜底）。
   * 只动 `packs/` 下非 `.tmp-*` 的目录；能搬进 `.trash` 就搬，失败就留着下次再试（不硬删）。
   */
  const purgeUnregistered = () => {
    ensureRoot()
    const { registry } = readRegistry()
    const known = new Set(Object.keys(registry.packages))
    const moved = []
    const deferred = []
    for (const name of readdirSync(paths.packsDir)) {
      if (name.startsWith('.')) continue
      if (known.has(name)) continue
      const full = join(paths.packsDir, name)
      let isDir = false
      try { isDir = statSync(full).isDirectory() } catch { isDir = false }
      if (!isDir) continue
      const trashPath = join(paths.trashDir, `${name}.${now()}`)
      try {
        renameWithRetry(full, trashPath)
        moved.push(name)
      } catch {
        deferred.push(name)
      }
    }
    if (moved.length > 0 || deferred.length > 0) {
      log('pack.purge-unregistered', { detail: { moved: moved.length, deferred: deferred.length } })
    }
    return { moved, deferred }
  }

  /** 清理超过 24h 的 trash（启动/面板刷新时顺手调用；失败只记日志）。 */
  const purgeTrash = ({ olderThanMs = 24 * 60 * 60 * 1000 } = {}) => {
    const removed = []
    if (!existsSync(paths.trashDir)) return removed
    const cutoff = now() - olderThanMs
    for (const name of readdirSync(paths.trashDir)) {
      const full = join(paths.trashDir, name)
      let mtime = 0
      try { mtime = statSync(full).mtimeMs } catch { continue }
      if (mtime >= cutoff) continue
      try {
        rmSync(full, { recursive: true, force: true })
        removed.push(name)
      } catch { /* 单个删不掉不影响其余 */ }
    }
    if (removed.length > 0) log('pack.trash.purge', { detail: { removed: removed.length } })
    return removed
  }

  // ── 包内运行期状态（install / health） ────────────────────────
  // 用户包：`packs/<id>/.state/`（随包目录一起进 trash/删除）。
  // 内置包：插件安装目录只读，状态落到 `capability-packs/.state/<id>/`（同 id 一份，删插件即失效）。
  const stateDirOf = id => {
    const packDir = idDir(id)
    return existsSync(packDir) ? join(packDir, '.state') : join(paths.root, '.state', id)
  }

  const stateFile = (id, name) => {
    if (name !== 'install.json' && name !== 'health.json') throw new Error(`未知状态文件：${name}`)
    return join(stateDirOf(id), name)
  }

  const readState = (id, name) => {
    try {
      return { value: JSON.parse(readFileSync(stateFile(id, name), 'utf8')) }
    } catch (error) {
      if (error?.code === 'ENOENT') return { value: undefined }
      return { value: undefined, error: `读取 ${name} 失败：${error?.message ?? error}` }
    }
  }

  const writeState = (id, name, value) => {
    ensureRoot()
    atomicWriteJson(stateFile(id, name), value)
    return value
  }

  return {
    paths,
    ensureRoot,
    readRegistry,
    writeRegistry,
    recordPack,
    forgetPack,
    readManifest,
    listLocalPacks,
    writePack,
    removePack,
    purgeUnregistered,
    restoreTrash,
    touchPack,
    purgeTrash,
    packDir: idDir,
    toolsDir,
    readInstall: id => readState(id, 'install.json').value,
    writeInstall: (id, value) => writeState(id, 'install.json', value),
    readHealth: id => readState(id, 'health.json').value,
    writeHealth: (id, value) => writeState(id, 'health.json', value),
    installStatePath: id => stateFile(id, 'install.json'),
    healthStatePath: id => stateFile(id, 'health.json'),
    stateDirOf,
  }
}
