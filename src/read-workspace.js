// 协调者读产物（受控读）：边界 = **主会话工作区包含性 OR 已登记产物**。
//
// 为什么必须自建：平台的文件工具没有读路径白名单——`dsh-fs-sandbox` 只给写操作加栅栏
// （"Reads pass through untouched: every mode permits reading."），`LocalFileSystem` 的 cwd
// 只是相对路径基准、不是包含性边界（"a resolution default, NOT a containment boundary"），
// `glob` 更是直接 spawn ripgrep 用 `--no-ignore --hidden` 全树枚举。所以给协调者开放原生
// read/glob 等于给主会话一个全盘可读可枚举的宿主进程读者（含 `~/.dsh/.credentials.yaml`）。
// 本模块把「读」收窄成一条：调用方只能给路径，边界由插件算。
//
// 为什么边界有第二个判据（审计 §2.1 方案 C）：子会话的产物**按契约写在 target 目录内**
// （`task-detail.js` 的 WRITE_HINT），而 target 通常不在主会话工作区里——真实台账 78.7% 的产物
// 因此读不到。把「已登记产物」（台账 `tasks.artifacts_json`）作为第二个判据，读取面仍然只有
// 「工作区 + 已登记集合」，比「放开所有 target」小得多，且 `present` 与 `read_workspace` 从此同源。
// 登记表的构造与语义在 `src/artifact-location.js`（本模块只消费它）。
//
// 职责切分：本模块只做纯路径判定 + 一次有界读（不写、不删、不列全盘）；
// 主会话身份校验、日志、文案在 src/tools.js。
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { formatBytes } from './last-message.js'
import { isInside, isRegisteredPath, registeredMatch } from './artifact-location.js'

// 包含性判定只有一份（artifact-location.js）：本模块历史上自己实现过一遍，
// 与登记表判据放在同一个模块里才能保证「工作区 OR 已登记」用的是同一套包含性语义。
export { isInside }

/** 单次返回正文上限（字符）：再长就截断并给续读 offset，避免一次把上下文烧光。 */
export const MAX_READ_CHARS = 64 * 1024

/** 整体读入上限：超过直接拒绝（不整块读进内存），提示让子会话把摘要写进产物。 */
export const MAX_FILE_BYTES = 4 * 1024 * 1024

/** 默认/最大返回行数。 */
export const DEFAULT_LINES = 400
export const MAX_LINES = 2000

/** 目录列表最多列多少条。 */
export const MAX_ENTRIES = 200

const text = value => typeof value === 'string' ? value.trim() : ''

/**
 * 把调用方给的路径解析成可读的**真实路径**。
 *
 * 边界（审计 §2.1 方案 C）：工作区包含性 **OR** 已登记产物。
 *
 * 判定顺序（每一道都要能说清拒绝原因，别把安全边界说成普通错误）：
 * 1. 形状：空、NUL、`~` 一律拒绝（不做家目录展开，避免「看起来在工作区里」的错觉）；
 * 2. `realpathSync` 解析整条链——挡**符号链接逃逸**（含中间目录是链接），并吃掉「工作区根自己
 *    就在符号链接下」的差异（macOS 的 `/var` → `/private/var`）；
 * 3. 真实路径在工作区内 → 允许（原行为，一个字节都没放宽）；
 * 4. 否则查**已登记产物**：命中（文件本身，或已登记目录的子树）→ 允许；
 * 5. 两者都不命中 → 拒绝，并区分「越界（未登记）」「符号链接指向未登记位置」「不存在」。
 *
 * @param {string} root 主会话工作区
 * @param {string} input 调用方给的路径（相对工作区或绝对）
 * @param {{registered?: object}} [options] `registered` 是 `artifact-location.registeredArtifacts()` 的结果
 * @returns {{ok: true, root: string, path: string, via?: 'workspace'|'registered', artifact?: object}
 *   | {ok: false, error: string}}
 */
export function resolveWorkspaceTarget(root, input, { registered } = {}) {
  const raw = text(input)
  if (raw === '') return { ok: false, error: '缺少 path：给主会话工作区内的相对路径（如 reports/xxx.md）或已登记产物的绝对路径。' }
  if (raw.includes('\0')) return { ok: false, error: '路径含 NUL 字节，拒绝。' }
  if (raw.startsWith('~')) return { ok: false, error: '不支持 ~ 展开：请给主会话工作区内的相对路径或绝对路径。' }
  const base0 = text(root)
  if (base0 === '') return { ok: false, error: '没有主会话工作区可用（主会话尚未打开）。' }
  let base
  try {
    base = realpathSync(resolve(base0))
  } catch (error) {
    return { ok: false, error: `主会话工作区不可用：${base0}（${error?.message ?? error}）` }
  }
  const target = isAbsolute(raw) ? resolve(raw) : resolve(base, raw)
  let real
  try {
    real = realpathSync(target)
  } catch (error) {
    // 真实路径解析失败：先看它是不是**登记过**（登记产物被删/断链 → 「不存在」，别报成越界），
    // 再判是不是越界（词法），最后才落到普通读取错误。
    if (isRegisteredPath(target, registered)) {
      return { ok: false, error: `读不到：${target}（${error?.code === 'ENOENT' ? '不存在（该产物已登记，但文件已被删除或移动）' : (error?.message ?? error)}）` }
    }
    if (!isInside(base, target)) return { ok: false, error: outOfScope(target, base) }
    return { ok: false, error: `读不到：${target}（${error?.code === 'ENOENT' ? '不存在' : (error?.message ?? error)}）` }
  }
  if (isInside(base, real)) return { ok: true, root: base, path: real, via: 'workspace' }
  // 第二个判据：已登记产物（文件本身或已登记目录的子树）。命中时读取面 = 登记表，不扩到 target。
  const hit = registeredMatch(real, registered)
  if (hit !== undefined) return { ok: true, root: base, path: real, via: 'registered', artifact: hit }
  // 词法在内、真实路径在外 = 符号链接逃逸；两者都在外 = 普通越界。分开说，方便排障。
  return isInside(base, target)
    ? { ok: false, error: `越界被拒绝：${target} 经符号链接指向工作区外、且不是已登记产物（${real}）。` }
    : { ok: false, error: outOfScope(target, base) }
}

/** 越界文案：同时说清两个判据，别让模型以为「工作区外的产物一律读不到」。 */
const outOfScope = (target, base) =>
  `越界被拒绝：${target} 不在主会话工作区（${base}）内，也不是本插件已登记的产物。`
  + '只能读工作区里的文件，或任务回报过 artifacts 的产物（登记表在台账 tasks.artifacts_json）。'

/**
 * 行号/行数归一：先 `Number()` 再判有限，越界夹紧。
 *
 * 调用方可能给字符串（`offset: '401'`，模型常见写法）：`Number.isFinite('401')` 是 false，
 * 直接判会把字符串**静默**当成没给——调用方以为在续读，实际又从第 1 行读了一遍。
 */
const toFinite = value => {
  const numeric = typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')
  const parsed = numeric ? Number(value) : NaN
  return Number.isFinite(parsed) ? parsed : undefined
}

const lineWindow = ({ offset, limit } = {}) => {
  const rawStart = toFinite(offset)
  const rawCount = toFinite(limit)
  const start = rawStart === undefined ? 1 : Math.max(1, Math.floor(rawStart))
  const count = rawCount === undefined ? DEFAULT_LINES : Math.max(1, Math.min(MAX_LINES, Math.floor(rawCount)))
  return { start, count }
}

/**
 * 按行窗口切正文，同时守住字符上限。
 *
 * 单行超上限时截断该行（不会返回空内容），但 `nextOffset` 仍指向**下一行**——续读是按行的，
 * 截断的是这一行，不是「读不下去了」。调用方靠 `truncatedLine` 知道这一行不全，靠 `nextOffset`
 * 知道从哪接着读，两个信号不冲突（返回 null 会让人误以为文件到头或读取失败）。
 */
function sliceLines(lines, start, count) {
  const from = start - 1
  const wanted = lines.slice(from, from + count)
  const kept = []
  let chars = 0
  for (const line of wanted) {
    const cost = kept.length === 0 ? line.length : line.length + 1
    if (chars + cost > MAX_READ_CHARS) {
      if (kept.length === 0) {
        // 首行本身就超上限：截断这一行，续读跳到下一行（同一行再读还是同一行，offset 不原地打转）。
        const nextOffset = from + 2
        return {
          lines: [line.slice(0, MAX_READ_CHARS)],
          nextOffset,
          more: nextOffset <= lines.length,
          byteCapped: true,
          truncatedLine: true,
        }
      }
      return { lines: kept, nextOffset: from + kept.length + 1, more: true, byteCapped: true, truncatedLine: false }
    }
    kept.push(line)
    chars += cost
  }
  const more = from + wanted.length < lines.length
  return { lines: kept, nextOffset: from + kept.length + 1, more, byteCapped: false, truncatedLine: false }
}

/** 目录条目：只列名字/类型/体积，不递归（递归枚举留给子任务）。 */
function listDirectory(entry, registered) {
  let dirents
  try {
    dirents = readdirSync(entry.path, { withFileTypes: true })
  } catch (error) {
    return { ok: false, error: `读不到目录：${entry.path}（${error?.message ?? error}）` }
  }
  const items = []
  for (const dirent of dirents.slice(0, MAX_ENTRIES)) {
    const full = resolve(entry.path, dirent.name)
    let size = null
    let kind = dirent.isDirectory() ? 'dir' : (dirent.isSymbolicLink() ? 'link' : 'file')
    // 链接先按真实路径判一次：指向「工作区外且未登记」的，标 readable:false——列出来不等于读得到，
    // 否则调用方会顺着条目再读一次，拿一个「越界被拒绝」的错误。
    // 判据与 resolveWorkspaceTarget 同源（工作区 OR 已登记产物），否则标记与真实判定会打架。
    let readable = true
    try {
      const stats = statSync(full)
      if (kind === 'link') kind = stats.isDirectory() ? 'dir' : 'file'
      size = stats.isFile() ? stats.size : null
      if (dirent.isSymbolicLink()) {
        const real = realpathSync(full)
        readable = isInside(entry.root, real) || registeredMatch(real, registered) !== undefined
      }
      // 不可读就不报体积：标了「读不到」还给出工作区外文件的字节数，是自相矛盾的信息泄漏。
      if (!readable) size = null
    } catch { /* 断链/无权限：仍列名字，体积未知；读不到就标不可读 */ readable = false; size = null }
    items.push({ name: dirent.name, kind, size, readable })
  }
  return {
    ok: true,
    kind: 'directory',
    path: entry.path,
    total: dirents.length,
    omitted: Math.max(0, dirents.length - items.length),
    items,
  }
}

/**
 * 读一个路径：文件按行窗口返回正文，目录返回条目清单，二进制只报类型。
 *
 * @param {{root?: string, path?: string, offset?: number, limit?: number, registered?: object}} [options]
 *   `registered` 是已登记产物索引（`artifact-location.registeredArtifacts`）：工作区外的产物靠它放行。
 * @returns {{ok: true, kind: 'text'|'binary'|'directory', ...} | {ok: false, error: string}}
 */
export function readWorkspaceFile({ root, path, offset, limit, registered } = {}) {
  const target = resolveWorkspaceTarget(root, path, { registered })
  if (target.ok !== true) return target
  let stats
  try {
    stats = statSync(target.path)
  } catch (error) {
    return { ok: false, error: `读不到：${target.path}（${error?.message ?? error}）` }
  }
  if (stats.isDirectory()) return { ...listDirectory(target, registered), via: target.via, artifact: target.artifact }
  if (!stats.isFile()) return { ok: false, error: `不是普通文件：${target.path}（只支持文件与目录）` }
  if (stats.size > MAX_FILE_BYTES) {
    return {
      ok: false,
      error: `文件过大：${target.path}（${formatBytes(stats.size)}，上限 ${formatBytes(MAX_FILE_BYTES)}）。`
        + '不整块读入；让子会话把摘要/结论写进产物文件，或改用更小的产物。',
    }
  }
  let buffer
  try {
    buffer = readFileSync(target.path)
  } catch (error) {
    return { ok: false, error: `读不到：${target.path}（${error?.message ?? error}）` }
  }
  if (buffer.includes(0)) {
    return { ok: true, kind: 'binary', path: target.path, size: stats.size, text: '', via: target.via, artifact: target.artifact }
  }
  const lines = buffer.toString('utf8').split('\n')
  const { start, count } = lineWindow({ offset, limit })
  if (start > lines.length) {
    return { ok: false, error: `offset=${start} 超出文件行数（共 ${lines.length} 行）：${target.path}` }
  }
  const window = sliceLines(lines, start, count)
  return {
    ok: true,
    kind: 'text',
    path: target.path,
    size: stats.size,
    totalLines: lines.length,
    start,
    end: start + window.lines.length - 1,
    more: window.more,
    byteCapped: window.byteCapped,
    truncatedLine: window.truncatedLine,
    nextOffset: window.nextOffset,
    text: window.lines.join('\n'),
    via: target.via,
    artifact: target.artifact,
  }
}

/** 头行标签：工作区里的文件与「已登记产物」分开说，调用方一眼能看出这条路径凭什么可读。 */
const kindLabel = result => (result?.via === 'registered' ? '已登记产物' : '工作区')

/** 已登记产物的归属后缀（哪条任务登记的），没有就空串。 */
const ownerSuffix = result => {
  const owner = result?.artifact
  if (owner === null || owner === undefined) return ''
  const taskId = typeof owner.taskId === 'string' ? owner.taskId.trim() : ''
  if (taskId === '') return ''
  return `｜任务 ${taskId} 登记${owner.viaDir === undefined ? '' : '（目录产物）'}`
}

/** 工具结果文案：头行给路径/体积/行范围，正文原样给，截断与越界都说清怎么继续。 */
export function renderWorkspaceRead(result) {
  if (result?.ok !== true) return `读取失败：${result?.error ?? '未知原因'}`
  if (result.kind === 'directory') {
    const lines = [`【${kindLabel(result)}目录】${result.path}（${result.total} 项${result.omitted > 0 ? `，只列前 ${result.items.length} 项` : ''}${ownerSuffix(result)}）`]
    for (const item of result.items) {
      const suffix = item.kind === 'dir' ? '/' : ''
      const size = item.size === null ? '' : `  ${formatBytes(item.size)}`
      lines.push(`- ${item.name}${suffix}${size}${item.readable === false ? '  （不可读：符号链接指向工作区外且未登记、已断链或无权限）' : ''}`)
    }
    return lines.join('\n')
  }
  if (result.kind === 'binary') {
    return `【${kindLabel(result)}文件】${result.path}（二进制，${formatBytes(result.size)}${ownerSuffix(result)}）——不返回内容。`
  }
  const range = result.end >= result.start ? `第 ${result.start}–${result.end} 行` : '空'
  const lines = [`【${kindLabel(result)}文件】${result.path}（${formatBytes(result.size)}｜共 ${result.totalLines} 行｜返回${range}${ownerSuffix(result)}）`]
  if (result.truncatedLine) {
    // 截断的是「这一行」，不是「读不下去了」：续读 offset 照给，两个信号分开说，别互相打架。
    lines.push(result.more
      ? `（本行已截断：单行超过 ${MAX_READ_CHARS} 字符，只返回前 ${MAX_READ_CHARS} 字符；用 offset=${result.nextOffset} 接着读后面的行）`
      : `（本行已截断：单行超过 ${MAX_READ_CHARS} 字符，只返回前 ${MAX_READ_CHARS} 字符，且文件已到末尾）`)
  } else if (result.more) {
    lines.push(result.byteCapped
      ? `（已达单次读取上限 ${MAX_READ_CHARS} 字符：用 offset=${result.nextOffset} 接着读）`
      : `（还有未返回的行：用 offset=${result.nextOffset} 接着读）`)
  }
  lines.push(result.text === '' ? '（空）' : result.text)
  return lines.join('\n')
}
