// 能力包 registry：`$DSH_HOME/state/orchestrator/capability-packs/registry.json` 的纯模型。
//
// 为什么 registry 不直接扫目录：目录是「文件事实」，registry 是「插件承诺」——预设注册过、
// 版本是多少、上次打开时间。两者分开，是因为「目录在但预设没挂上」（进程崩溃在两步之间）
// 与「目录没了但 registry 有条目」（手工删目录）都必须能被发现并修复，而不是互相掩盖。
//
// 这里只有纯函数（不碰磁盘），落盘由 src/pack/store.js 负责：同一份归一化逻辑给
// 「读旧文件」「写新文件」「测试」三方复用，不会写出两种形状。

export const REGISTRY_SCHEMA_VERSION = 1

const isObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = value => (typeof value === 'string' ? value.trim() : '')

/** 空 registry（新装/文件缺失时的唯一形态）。 */
export function emptyRegistry() {
  return { schemaVersion: REGISTRY_SCHEMA_VERSION, packages: {} }
}

/**
 * 归一化任意输入：坏形状一律回落空 registry，单条坏记录只丢那一条。
 * 读文件失败/JSON 坏掉时由 store 决定是否告警，这里不抛。
 */
export function normalizeRegistry(raw) {
  if (!isObject(raw) || !isObject(raw.packages)) return emptyRegistry()
  const packages = {}
  for (const [id, entry] of Object.entries(raw.packages)) {
    if (!isObject(entry) || text(entry.id) !== id) continue
    packages[id] = {
      id,
      name: text(entry.name),
      publisher: entry.publisher === 'builtin' ? 'builtin' : 'factory',
      version: text(entry.version),
      presetId: text(entry.presetId),
      dir: text(entry.dir),
      createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : null,
      updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : null,
      lastOpenedAt: Number.isFinite(entry.lastOpenedAt) ? entry.lastOpenedAt : null,
    }
  }
  return { schemaVersion: REGISTRY_SCHEMA_VERSION, packages }
}

/** 从 manifest 生成 registry 条目（dir 是包根绝对路径）。 */
export function entryFromManifest(manifest, { dir, now = Date.now, previous } = {}) {
  return {
    id: manifest.id,
    name: manifest.name,
    publisher: manifest.publisher,
    version: manifest.version,
    presetId: manifest.preset.id,
    dir,
    createdAt: Number.isFinite(previous?.createdAt) ? previous.createdAt : now,
    updatedAt: now,
    lastOpenedAt: Number.isFinite(previous?.lastOpenedAt) ? previous.lastOpenedAt : null,
  }
}

/** upsert：返回**新** registry（不原地改，方便调用方拿前后两份做 diff/回滚）。 */
export function upsertEntry(registry, entry) {
  const base = normalizeRegistry(registry)
  return { ...base, packages: { ...base.packages, [entry.id]: entry } }
}

/** 删除条目：返回新 registry；不存在时原样返回等价新对象。 */
export function removeEntry(registry, id) {
  const base = normalizeRegistry(registry)
  if (base.packages[id] === undefined) return base
  const packages = { ...base.packages }
  delete packages[id]
  return { ...base, packages }
}

/** 只更新「上次打开时间」；条目不存在返回 undefined（不凭空造条目）。 */
export function touchOpened(registry, id, now = Date.now) {
  const base = normalizeRegistry(registry)
  const entry = base.packages[id]
  if (entry === undefined) return undefined
  return { ...base, packages: { ...base.packages, [id]: { ...entry, lastOpenedAt: now } } }
}

/** 列表视图（按名称排序，面板直接吃）。 */
export function listEntries(registry) {
  const base = normalizeRegistry(registry)
  return Object.values(base.packages).sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN'))
}
