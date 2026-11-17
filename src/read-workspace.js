// 协调者读工作区产物（受控读）：只允许读**主会话工作区内**的路径。
//
// 为什么必须自建：平台的文件工具没有读路径白名单——`dsh-fs-sandbox` 只给写操作加栅栏
// （"Reads pass through untouched: every mode permits reading."），`LocalFileSystem` 的 cwd
// 只是相对路径基准、不是包含性边界（"a resolution default, NOT a containment boundary"），
// `glob` 更是直接 spawn ripgrep 用 `--no-ignore --hidden` 全树枚举。所以给协调者开放原生
// read/glob 等于给主会话一个全盘可读可枚举的宿主进程读者（含 `~/.dsh/.credentials.yaml`）。
// 本模块把「读」收窄成一条：调用方只能给路径，边界由插件算。
//
// 职责切分：本模块只做纯路径判定 + 一次有界读（不写、不删、不列全盘）；
// 主会话身份校验、日志、文案在 src/tools.js。
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { formatBytes } from './last-message.js'

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

/** 包含性判定：`path` 等于 `root` 或在 `root` 之下（都用真实路径）。 */
export function isInside(root, path) {
  const rel = relative(root, path)
  if (rel === '') return true
  if (isAbsolute(rel)) return false
  return rel !== '..' && !rel.startsWith(`..${sep}`)
}

/**
 * 把调用方给的路径解析成工作区内的**真实路径**。
 *
 * 三道闸，缺一不可：
 * 1. 形状：空、NUL、`~` 一律拒绝（不做家目录展开，避免「看起来在工作区里」的错觉）；
 * 2. 真实路径包含性：`realpathSync` 解析整条链后判定——挡**符号链接逃逸**（含中间目录是链接）；
 *    这一步同时吃掉「工作区根自己就在符号链接下」的差异（macOS 的 `/var` → `/private/var`、
 *    用户把工作区放在链接目录里），所以绝对路径与相对路径都按真实路径比较，不做词法比较；
 * 3. 不存在的路径退回词法包含性：能走到这一步说明真实路径解析失败，仍要区分「越界」与「不存在」，
 *    否则 `../../nope` 会被报成「不存在」，把安全边界说成了普通错误。
 *
 * @returns {{ok: true, root: string, path: string} | {ok: false, error: string}}
 */
export function resolveWorkspaceTarget(root, input) {
  const raw = text(input)
  if (raw === '') return { ok: false, error: '缺少 path：给主会话工作区内的相对路径（如 reports/xxx.md）或绝对路径。' }
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
    // 真实路径解析失败：先判是不是越界（词法），再报「不存在」。
    if (!isInside(base, target)) {
      return { ok: false, error: `越界被拒绝：${target} 不在主会话工作区（${base}）内。只能读工作区里的产物。` }
    }
    return { ok: false, error: `读不到：${target}（${error?.code === 'ENOENT' ? '不存在' : (error?.message ?? error)}）` }
  }
  if (!isInside(base, real)) {
    // 词法在内、真实路径在外 = 符号链接逃逸；两者都在外 = 普通越界。分开说，方便排障。
    return isInside(base, target)
      ? { ok: false, error: `越界被拒绝：${target} 经符号链接指向工作区外（${real}）。` }
      : { ok: false, error: `越界被拒绝：${target} 不在主会话工作区（${base}）内。只能读工作区里的产物。` }
  }
  return { ok: true, root: base, path: real }
}

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
function listDirectory(entry) {
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
    // 链接先按真实路径判一次：指到工作区外的，标 readable:false——列出来不等于读得到，
    // 否则调用方会顺着条目再读一次，拿一个「越界被拒绝」的错误。
    let readable = true
    try {
      const stats = statSync(full)
      if (kind === 'link') kind = stats.isDirectory() ? 'dir' : 'file'
      size = stats.isFile() ? stats.size : null
      if (dirent.isSymbolicLink()) readable = isInside(entry.root, realpathSync(full))
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
 * 读一个工作区路径：文件按行窗口返回正文，目录返回条目清单，二进制只报类型。
 *
 * @returns {{ok: true, kind: 'text'|'binary'|'directory', ...} | {ok: false, error: string}}
 */
export function readWorkspaceFile({ root, path, offset, limit } = {}) {
  const target = resolveWorkspaceTarget(root, path)
  if (target.ok !== true) return target
  let stats
  try {
    stats = statSync(target.path)
  } catch (error) {
    return { ok: false, error: `读不到：${target.path}（${error?.message ?? error}）` }
  }
  if (stats.isDirectory()) return listDirectory(target)
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
    return { ok: true, kind: 'binary', path: target.path, size: stats.size, text: '' }
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
  }
}

/** 工具结果文案：头行给路径/体积/行范围，正文原样给，截断与越界都说清怎么继续。 */
export function renderWorkspaceRead(result) {
  if (result?.ok !== true) return `读取失败：${result?.error ?? '未知原因'}`
  if (result.kind === 'directory') {
    const lines = [`【工作区目录】${result.path}（${result.total} 项${result.omitted > 0 ? `，只列前 ${result.items.length} 项` : ''}）`]
    for (const item of result.items) {
      const suffix = item.kind === 'dir' ? '/' : ''
      const size = item.size === null ? '' : `  ${formatBytes(item.size)}`
      lines.push(`- ${item.name}${suffix}${size}${item.readable === false ? '  （不可读：符号链接指向工作区外、已断链或无权限）' : ''}`)
    }
    return lines.join('\n')
  }
  if (result.kind === 'binary') {
    return `【工作区文件】${result.path}（二进制，${formatBytes(result.size)}）——不返回内容。`
  }
  const range = result.end >= result.start ? `第 ${result.start}–${result.end} 行` : '空'
  const lines = [`【工作区文件】${result.path}（${formatBytes(result.size)}｜共 ${result.totalLines} 行｜返回${range}）`]
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
