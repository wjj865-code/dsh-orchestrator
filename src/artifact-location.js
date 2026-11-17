// 产物位置与可读性的唯一判据（artifact-location）。
//
// 背景（审计 §2.1 / §2.5 / §4.3.2）：产物这件事曾有 4 条各自为政的判据——
//   `present` 只要求「绝对路径 + 存在的普通文件」；`read_workspace` 只认主会话工作区包含性；
//   `preview` 与右侧栏只认台账已登记产物。真实台账 78.7% 的产物落在工作区外（target 目录），
//   于是同一条产物「present 能交付、read_workspace 读不了」——两条规则各自自洽，拼在一起才断裂。
//
// 本模块把**已登记产物**（`tasks.artifacts_json`，`setTaskArtifacts` 早就在写）提升为产物的
// 唯一合法性判据，四条路径从此同源：
//   - `read_workspace`：工作区包含性 **OR** 已登记产物（`registeredMatch` + `isInside`）；
//   - `preview` / 右侧栏：本来就是登记表（保持现状，不再另写一套）；
//   - `present`：可交付性用 `deliverableOf`（与通知里「能不能交付」同一个类型判定）。
//
// 三条边界（安全语义，改动前先读）：
//   1. 登记表**不扩大**读取面：只有被任务显式/自动登记过的路径才可读，未登记的同目录文件仍被拒；
//   2. 登记表**不借符号链接**：已登记的路径本身是符号链接时，只登记它的词法路径，不放行真实路径
//      （否则「登记一个指向 ~/.ssh 的链接」就等于登记了任意文件）；普通文件/目录用 `realpathSync`
//      的规范路径登记，这样 `/var` → `/private/var` 这类系统级链接不会误伤真实产物；
//   3. 已登记的**目录**放开它的子树（产物可以是目录，见 `normalizeArtifacts`），已登记的文件只放开它自己。
//
// 不碰台账结构、不改工具入参：登记表就是台账里已有的那一列。
import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

const text = value => typeof value === 'string' ? value.trim() : ''

/** 包含性判定：`path` 等于 `root` 或在 `root` 之下（两边都应是真实路径）。 */
export function isInside(root, path) {
  const rel = relative(root, path)
  if (rel === '') return true
  if (isAbsolute(rel)) return false
  return rel !== '..' && !rel.startsWith(`..${sep}`)
}

const realPathOf = value => {
  try {
    return realpathSync(value)
  } catch {
    return undefined
  }
}

/**
 * 可交付性分类（present 口径）：平台 `present` 用 lstat 判 type，只有「存在的普通文件」能交付。
 *
 * 与 `src/notify.js` 原来那份 `classifyPath` 是同一口径，搬到这里的唯一目的是让「能不能交付」
 * 与「能不能读」共用一套类型判定，而不是各写一份。
 *
 * @returns {'file'|'directory'|'symlink'|'missing'|'relative'|'other'}
 */
export function deliverableOf(path) {
  const raw = text(path)
  if (raw === '') return 'other'
  if (!isAbsolute(raw)) return 'relative'
  let stats
  try {
    stats = lstatSync(raw)
  } catch (error) {
    return error?.code === 'ENOENT' ? 'missing' : 'other'
  }
  if (stats.isFile()) return 'file'
  if (stats.isSymbolicLink()) return 'symlink'
  if (stats.isDirectory()) return 'directory'
  return 'other'
}

/**
 * 台账 → 已登记产物索引。
 *
 * @param {Array<object>} tasks 台账任务行（用它们的 `artifacts`）
 * @returns {{files: Set<string>, dirs: string[], owners: Map<string, {taskId: string, label: string}>, missing: Set<string>}}
 *   `files`：已登记产物的真实路径（文件与目录都在内）；
 *   `dirs`：已登记目录的真实路径，用来放开子树；
 *   `owners`：真实路径 → 登记它的任务（拒绝文案与渲染头用，方便说清「这是哪条任务的产物」）；
 *   `missing`：登记过但已不在的路径（只用于把错误从「越界」纠正成「不存在」）。
 */
export function registeredArtifacts(tasks = []) {
  const files = new Set()
  const dirs = []
  const owners = new Map()
  // 登记过但文件已不在的路径：**不可读**（不进 files），但保留下来是为了给准确的错误——
  // 「已登记产物被删了」应报「不存在」，而不是「越界（未登记）」那种误导性文案。
  const missing = new Set()
  for (const task of Array.isArray(tasks) ? tasks : []) {
    for (const item of Array.isArray(task?.artifacts) ? task.artifacts : []) {
      const raw = text(item?.path)
      if (raw === '' || !isAbsolute(raw)) continue
      let stats
      try {
        stats = lstatSync(raw)
      } catch {
        missing.add(resolve(raw))
        continue
      }
      // 登记表不借符号链接放行（见文件头边界 2）：链接本身只留词法路径，真实路径不登记。
      const real = stats.isSymbolicLink() ? undefined : realPathOf(raw)
      if (real === undefined) continue
      if (!files.has(real)) {
        files.add(real)
        owners.set(real, { taskId: String(task?.id ?? ''), label: text(item?.label) })
      }
      if (stats.isDirectory() && !dirs.includes(real)) dirs.push(real)
    }
  }
  return { files, dirs, owners, missing }
}

/** 这条路径是否**登记过**（含已缺失的登记项）；只用于区分错误文案，不构成可读授权。 */
export const isRegisteredPath = (realPath, registered) => {
  const raw = text(realPath)
  if (raw === '' || registered === null || registered === undefined) return false
  if (isRegisteredArtifact(raw, registered)) return true
  const missing = registered.missing
  return missing instanceof Set && missing.has(resolve(raw))
}

/**
 * 真实路径是否命中登记表。
 *
 * @param {string} realPath 已 `realpathSync` 的路径
 * @param {{files: Set<string>, dirs: string[], owners: Map}} registered `registeredArtifacts` 的产物
 * @returns {{taskId: string, label: string, viaDir?: string} | undefined} 命中返回登记信息
 */
export function registeredMatch(realPath, registered) {
  const raw = text(realPath)
  if (raw === '' || registered === null || registered === undefined) return undefined
  const files = registered.files
  if (!(files instanceof Set) || files.size === 0) return undefined
  // 输入按真实路径归一：调用方可能给词法路径（`/var/…`），登记表里是真实路径（`/private/var/…`）。
  // 真实路径解析失败（已删除）时退回词法路径——它在登记表里本来就不该命中。
  const absolute = realPathOf(raw) ?? resolve(raw)
  if (files.has(absolute)) return registered.owners.get(absolute) ?? { taskId: '', label: '' }
  for (const dir of Array.isArray(registered.dirs) ? registered.dirs : []) {
    if (isInside(dir, absolute)) {
      const owner = registered.owners.get(dir) ?? { taskId: '', label: '' }
      return { ...owner, viaDir: dir }
    }
  }
  return undefined
}

/** 是否是可读的已登记产物（`registeredMatch` 的布尔版）。 */
export const isRegisteredArtifact = (realPath, registered) => registeredMatch(realPath, registered) !== undefined
