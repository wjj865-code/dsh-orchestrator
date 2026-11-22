// 计划落盘（P8 计划交付）：只读子会话在计划阶段**唯一**被允许的写入口。
//
// 为什么需要它：计划阶段是只读沙箱（硬拦），子会话没有任何写文件的手段；计划只能塞进
// `task_report blocked` 的 `question`（限 500 字），长计划会被截断、也没法给用户一个好读的文件。
// 所以计划文档由**插件在宿主进程**写（不受子会话沙箱限制），路径由插件算，
// 写完登记成任务产物——子会话只上报「摘要 + 路径 + 待拍板清单」。
//
// 职责切分：
// - 本模块只做纯函数：文件名安全化（§7.1 流水线）+ 路径推导/逃逸校验 + 去重/幂等 + 文档渲染 +
//   一次 mkdir/writeFile；
// - 越权（不是任务自己的子会话 / 不是计划任务）、正文大小、日志、产物登记都在 src/tools.js。
//
// 版本 B（用户拍板）：**文件名 = 任务名**（不是 token、不是 t-xxxx）。理由：present 卡片与
// reports/plans/ 目录是用户直接看的地方，任务名比任何编号都好读；编号/token 只用于调用工具。
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
// 计划文案单源（P1-C）：落盘后的「下一步」与 task_detail / 工具回执用同一句。
import { planSavedNextStep } from './copy.js'

/** 计划文档目录（相对主会话工作区）。 */
export const PLAN_SUBDIR = join('reports', 'plans')

/** 计划文档扩展名。 */
export const PLAN_EXT = '.md'

/** 计划正文上限（字符）。超过就拒绝，不静默截断——截断的计划比没有更危险。 */
export const MAX_PLAN_CHARS = 200_000

/** 文件名主干长度上限（UTF-16 code unit，留足路径预算给目录与后缀）。 */
export const PLAN_STEM_MAX = 60

/** 绝对路径长度上限（Windows 惯例 260 留余量；超了按差额继续截断 stem）。 */
export const PLAN_PATH_MAX = 240

/** 重名后缀上限：`<stem>-2.md` … `<stem>-20.md`，超出回落「未命名任务-<n>」。 */
export const PLAN_SUFFIX_MAX = 20

/** 清洗后为空时的兜底名。 */
export const PLAN_FALLBACK_NAME = '未命名任务'

/** Windows 保留名（大小写不敏感，含 `con.md` 这类带扩展名的形态）。 */
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i

/** 控制字符（含 Unicode 行/段分隔符）；**不含 Tab**——Tab 归第 4 步折成 `-`（`任务\t网关` → `任务-网关`）。 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000A-\u001F\u007F\u2028\u2029]/g

/** ASCII 非法文件名字符（Windows 全平台拒；换成 `-` 而不是删掉，保留可读性）。 */
const ILLEGAL_CHARS = /[\\/:*?"<>|]/g

/**
 * 文件名安全化流水线（§7.1，11 步）：NFC → trim → 删控制符 → 非法字符换 `-` → 空白换 `-` →
 * 折叠/去首尾 `-_.` → 去前导 `.` → 空名兜底 → 保留名前缀 → 截断 stem ≤ 60 → 补 `.md`。
 *
 * 纯函数（不碰文件系统）：**只看标题，不看目录里有什么**——重名去重是 `planFileName` 的事。
 *
 * @param {string} title 任务标题
 * @returns {string} 形如 `任务名.md`
 */
export function sanitizePlanStem(title) {
  let text = typeof title === 'string' ? title : ''
  // 1. Unicode NFC + 首尾 trim（组合字符与全角空格在跨平台文件名里最容易出岔子）。
  text = text.normalize('NFC').trim()
  // 2. 删控制字符（换行/制表/行分隔符）：文件名里不能有，砸成 `-` 会把标题读断，直接删。
  text = text.replace(CONTROL_CHARS, '')
  // 3. ASCII 非法集 → `-`（`..\..\etc\x` 这一步就变成 `..-..-etc-x`，逃逸闸是第二道）。
  text = text.replace(ILLEGAL_CHARS, '-')
  // 4. 空白（半角/全角空格 U+3000/Tab）→ `-`。
  text = text.replace(/[\s\u3000]+/g, '-')
  // 5. 连续 `-` 折叠；首尾 `-`、`_`、`.`、空格去掉。
  text = text.replace(/-{2,}/g, '-').replace(/^[-_.\s]+/, '').replace(/[-_.\s]+$/, '')
  // 6. 前导 `.` 去掉（`normalize` 之后可能又出现，如 `.-A`）。
  text = text.replace(/^\.+/, '')
  // 7. 清洗后为空 / 只剩符号 → 兜底名（不拒绝落盘：文件名失败而丢掉计划的代价更大）。
  if (text === '' || /^-+$/.test(text)) text = PLAN_FALLBACK_NAME
  // 8. Windows 保留名加前缀（`CON`/`con.md`/`NUL`… 直接写会失败）。
  if (RESERVED_NAME.test(text)) text = `任务-${text}`
  // 9. 截断 stem（不留在代理对中间：`slice` 后若末尾是孤立高代理就再退一位）。
  if (text.length > PLAN_STEM_MAX) {
    text = text.slice(0, PLAN_STEM_MAX)
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1)
    text = text.replace(/[-_.\s]+$/, '')
  }
  if (text === '') text = PLAN_FALLBACK_NAME
  // 10. 补扩展名：标题自己以 `.md` 结尾时不重复拼（`con.md` 只能是 `任务-con.md`，不是 `…\\-con.md.md`）。
  text = text.replace(/\.md$/i, '')
  if (text === '') text = PLAN_FALLBACK_NAME
  return `${text}${PLAN_EXT}`
}

/**
 * 生成计划文档文件名（安全化 + 重名去重），大小写不敏感。
 *
 * @param {string} title 任务标题
 * @param {{taken?: Iterable<string>, maxSuffix?: number}} [options]
 *   taken = 已被占用的文件名（**小写**即可，调用方负责把「磁盘上的文件」与「别的任务的 plan_path」
 *   都并进来）；maxSuffix 超限后回落 `未命名任务-<n>.md`。
 * @returns {string}
 */
export function planFileName(title, { taken = [], maxSuffix = PLAN_SUFFIX_MAX } = {}) {
  const first = sanitizePlanStem(title)
  const used = new Set()
  for (const name of taken) {
    if (typeof name === 'string' && name !== '') used.add(name.toLowerCase())
  }
  if (!used.has(first.toLowerCase())) return first
  const limit = Number.isFinite(maxSuffix) && maxSuffix > 0 ? Math.floor(maxSuffix) : PLAN_SUFFIX_MAX
  const stem = first.slice(0, -PLAN_EXT.length)
  for (let n = 2; n <= limit; n += 1) {
    const candidate = `${stem}-${n}${PLAN_EXT}`
    if (!used.has(candidate.toLowerCase())) return candidate
  }
  // 极端情况：同名任务超过上限。回落兜底名继续找空位，仍找不到就用时间戳后缀（永不与已有文件同名）。
  const fallback = PLAN_FALLBACK_NAME
  for (let n = 2; n <= limit; n += 1) {
    const candidate = `${fallback}-${n}${PLAN_EXT}`
    if (!used.has(candidate.toLowerCase())) return candidate
  }
  return `${fallback}-${Date.now()}${PLAN_EXT}`
}

const text = value => (typeof value === 'string' ? value.trim() : '')

/** 逃逸判定用的相对路径检查：空、以 `..` 开头、绝对路径、跨目录，全算逃逸。 */
export function escapesDir(dir, path) {
  const rel = relative(dir, path)
  if (rel === '' || rel === '.') return true
  if (isAbsolute(rel)) return true
  if (rel.startsWith(`..${sep}`) || rel === '..') return true
  return rel.includes(sep) || rel.includes('/')
}

/** 文件名是否可用于拼路径：非空、无分隔符、无控制符、不是 `.`/`..`、不是绝对路径。 */
export function isSafePlanFileName(name) {
  const value = text(name)
  if (value === '' || value === '.' || value === '..') return false
  if (value !== basename(value)) return false
  if (/[\\/:*?"<>|\u0000-\u001F\u007F]/.test(value)) return false
  return value.endsWith(PLAN_EXT)
}

/**
 * 推导计划文档的绝对路径：`<主会话工作区>/reports/plans/<任务名>.md`。
 *
 * 没有 `path` 参数可传：调用方只能给文件名（由 `planFileName` 生成），路径由插件算。三道闸：
 * 1. 文件名白名单（`isSafePlanFileName`：不含 `/`、`\`、控制符，不是 `.`/`..`）；
 * 2. 路径预算：绝对路径 > 240 字符时继续截断 stem（不加省略号，保留 `-n` 后缀与扩展名）；
 * 3. `relative()` 包含性校验（防主会话目录本身是符号链接/相对路径/带 `..` 时的意外逃逸）。
 *
 * @returns {{ok: true, path: string, dir: string, name: string} | {ok: false, error: string}}
 */
export function planDocPath(mainDir, fileName) {
  const root = text(mainDir)
  if (root === '') return { ok: false, error: '没有主会话工作区可用（主会话目录为空）' }
  const name = text(fileName)
  if (name === '') return { ok: false, error: '缺少计划文档文件名' }
  if (!isSafePlanFileName(name)) {
    return { ok: false, error: `计划文档文件名不合法（不能含路径分隔符/控制符）：${name}` }
  }
  const base = resolve(root)
  const dir = resolve(base, PLAN_SUBDIR)
  // 目录本身必须是主会话工作区的子目录。
  const relDir = relative(base, dir)
  if (isAbsolute(relDir) || relDir === '..' || relDir.startsWith(`..${sep}`)) {
    return { ok: false, error: `计划路径逃逸被拒绝：${dir}` }
  }
  const path = resolve(dir, fitFileName(dir, name))
  if (escapesDir(dir, path)) return { ok: false, error: `计划路径逃逸被拒绝：${path}` }
  return { ok: true, path, dir, name: basename(path) }
}

/**
 * 路径预算：绝对路径超过 `PLAN_PATH_MAX` 时继续截断 stem（后缀 `-2` 与 `.md` 保留）。
 * 目录本身就很深时 stem 会截到空——那时只剩兜底名，仍按预算尽力，绝不拼出越界路径。
 */
function fitFileName(dir, name, limit = PLAN_PATH_MAX) {
  const stem = name.endsWith(PLAN_EXT) ? name.slice(0, -PLAN_EXT.length) : name
  const suffixAt = stem.search(/-\d+$/)
  const core = suffixAt > 0 ? stem.slice(0, suffixAt) : stem
  const suffix = suffixAt > 0 ? stem.slice(suffixAt) : ''
  let cut = core
  for (let guard = 0; guard < 200; guard += 1) {
    const candidate = `${cut}${suffix}${PLAN_EXT}`
    if (join(dir, candidate).length <= limit) return candidate
    if (cut.length <= 1) return `${PLAN_FALLBACK_NAME}${suffix || ''}${PLAN_EXT}`
    cut = cut.slice(0, -1)
    if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1)
  }
  return `${PLAN_FALLBACK_NAME}${PLAN_EXT}`
}

/**
 * 已占用的计划文件名（小写）：磁盘上真实存在的文件 + 别的任务已登记的 `plan_path`。
 *
 * 两路都要看：磁盘上有可能是历史 `t-xxxx.md` 或用户手工放的文件（不能覆盖），台账上有可能是
 * 文件还没写出来但路径已被认领（并发/重试）。两者都按**大小写不敏感**比较（Windows 语义）。
 */
async function takenPlanNames(db, dir, ownTaskId) {
  const taken = new Set()
  try {
    for (const name of await readdir(dir)) taken.add(String(name).toLowerCase())
  } catch { /* 目录还不存在：没有磁盘占用 */ }
  if (db !== null && db !== undefined && typeof db.prepare === 'function') {
    try {
      const rows = db.prepare('SELECT id, plan_path FROM tasks WHERE plan_path IS NOT NULL').all()
      for (const row of Array.isArray(rows) ? rows : []) {
        // 自己的路径不算占用：那是「二次落盘覆写原文件」的正常路径。
        if (String(row.id) === String(ownTaskId)) continue
        taken.add(basename(String(row.plan_path)).toLowerCase())
      }
    } catch { /* 老库没有 plan_path 列（未迁移）：只按磁盘判重 */ }
  }
  return taken
}

/** 文档头：让用户单独打开这个 md 也知道「这是哪个任务的计划、什么时候落的」。 */
export function renderPlanDocument({ task = {}, content = '', savedAt = Date.now() } = {}) {
  const title = text(task.title) || PLAN_FALLBACK_NAME
  const goal = text(task.goal).split('\n')[0]
  const when = new Date(Number.isFinite(savedAt) ? savedAt : Date.now()).toISOString()
  const lines = [
    `# 计划：${title}`,
    '',
    // 用户面口径：标题行只写任务名；引用写 tk-（不写台账内部编号，见版本 B《ID 出口网关》）。
    `- 任务引用：${text(task.ref) || '（未生成）'}`,
  ]
  if (goal !== '') lines.push(`- 目标：${goal}`)
  lines.push(`- 落盘时间：${when}`, '', '---', '')
  const body = text(content)
  lines.push(body === '' ? '（正文为空）' : body)
  return `${lines.join('\n')}\n`
}

/**
 * 落盘：定文件名（幂等优先）→ 校验路径 → mkdir → 写 UTF-8。
 *
 * 幂等（§7.2）：任务已有 `plan_path` 就**原路径覆写**，重复调用不产生 `-2`；第一次落盘才生成
 * 文件名（重名按 `-2`、`-3`… 递增，大小写不敏感）。改名不迁移（旧文件保留、新名另存）。
 * `plan_path` 由调用方（src/tools.js）在成功后写回台账——本模块不 import ledger。
 *
 * 失败把原因如实返回，不抛栈、不半写完就报成功。
 *
 * @returns {{ok: true, path: string, chars: number, bytes: number, reused: boolean}
 *   | {ok: false, error: string, path?: string}}
 */
export async function writePlanDocument({ db, mainDir, task, content = '', savedAt = Date.now() } = {}) {
  const root = text(mainDir)
  if (root === '') return { ok: false, error: '没有主会话工作区可用（主会话目录为空）' }
  const dir = resolve(resolve(root), PLAN_SUBDIR)
  // 幂等优先：已登记过路径 → 原路径覆写（仍过安全化：basename + 逃逸校验，历史脏值也不会越界）。
  const existing = text(task?.plan_path)
  const wanted = existing === '' ? undefined : basename(existing)
  let target
  if (wanted !== undefined && isSafePlanFileName(wanted)) {
    target = planDocPath(root, wanted)
    if (target.ok !== true) target = undefined
  }
  if (target === undefined) {
    await mkdir(dir, { recursive: true })
    const taken = await takenPlanNames(db, dir, task?.id)
    target = planDocPath(root, planFileName(task?.title, { taken }))
  }
  if (target.ok !== true) return { ok: false, error: target.error }
  const body = renderPlanDocument({ task, content, savedAt })
  try {
    await mkdir(target.dir, { recursive: true })
    await writeFile(target.path, body, 'utf8')
  } catch (error) {
    return { ok: false, path: target.path, error: `写计划文件失败：${error?.message ?? error}` }
  }
  return {
    ok: true,
    path: target.path,
    chars: text(content).length,
    bytes: Buffer.byteLength(body, 'utf8'),
    reused: existing !== '',
  }
}

/** 工具结果文案：落盘成功后下一步该做什么（摘要上报，不搬正文）。 */
export function planSavedNote({ path, chars, bytes }) {
  return `计划已落盘：${path}（正文 ${chars} 字 / 文件 ${bytes} 字节）｜已登记为任务产物（通知与面板可交付）。\n`
    + planSavedNextStep
}
