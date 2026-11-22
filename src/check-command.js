// checks 的命令解析与执行计划（Windows 边界，A1 修补）。
//
// 为什么需要它：Windows 上 `pnpm` / `npm` / `npx` / `yarn` 的真实入口是 `*.cmd`（npm 生成的 shim），
// 而 Node 的 `spawn(shell:false)` 不会按 PATHEXT 找 `.cmd`：裸 `pnpm` 直接 ENOENT，显式写 `pnpm.cmd`
// 又抛 EINVAL（CreateProcess 不能执行批处理）——于是 `skipIfMissing` 把「机器上装了 pnpm」静默记成
// 「跳过」，验收门禁形同虚设。这里补两件事：
// 1) 无扩展名命令按 PATH × PATHEXT 解析到真实入口。只认 `.com/.exe/.bat/.cmd`：同目录里的
//    `pnpm`（bash shim）不是 Windows 可执行文件，认它等于换个方式报 ENOENT；
// 2) `.cmd` / `.bat` 用 ComSpec `/d /s /c` 执行，命令行**从 argv 逐项转义重建**（不做整串拼接）。
//
// 安全边界（别再放宽）：
// - 仍然 `shell:false`：ComSpec 只是「Node 不能直接 CreateProcess 批处理」的替代入口，不是 shell 开关；
//   `windowsVerbatimArguments:true` 表示命令行由我们逐项转义好，Node 不再二次引号处理。
// - 逐项转义沿用 cross-spawn 的口径（算法见 qntm.org/cmd）：反斜杠加倍、整项双引号包裹、再给
//   cmd 元字符加 `^`——参数里的 `&` / `|` / `%` 都只是普通字符。
// - cmd.exe 没有「引号转义」语法：参数里出现双引号 / 控制字符时**直接拒绝执行**（fail-closed）。
//   实测 `a"b` 会让后面的 `& echo …` 真的当命令跑起来，这里宁可判失败也不拼下去。
import { statSync } from 'node:fs'
import { win32 } from 'node:path'

/** 我们能直接交给 CreateProcess 的扩展名（PATHEXT 里的 .vbs/.js/.ps1 一律不碰）。 */
export const RUNNABLE_EXTENSIONS = ['.COM', '.EXE', '.BAT', '.CMD']
/** PATHEXT 缺失或没有可用项时的兜底顺序（与 Windows 默认值一致）。 */
export const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD'
/** 必须经 ComSpec 才能执行的批处理扩展名（小写，比较前统一小写）。 */
export const BATCH_EXTENSIONS = ['.cmd', '.bat']
/** Windows 的 PATH 分隔符。 */
const PATH_DELIMITER = ';'
/** cmd.exe 无法安全传递的字符：双引号（无转义语法）+ 控制字符（会截断命令行）。 */
const UNSAFE_CMD_CHARS = /["\u0000-\u001f\u007f]/
/** cmd 元字符（与 cross-spawn 同一张表）：都要用 `^` 兜住。 */
const CMD_META_CHARS = /([()[\]%!^"`<>&|;, *?])/g

const envValue = (env, ...names) => {
  const source = env ?? {}
  for (const name of names) {
    const value = source[name]
    if (typeof value === 'string' && value !== '') return value
  }
  return ''
}

const defaultIsFile = target => {
  try {
    return statSync(target).isFile() === true
  } catch {
    return false
  }
}

/**
 * 按 PATHEXT 取「可执行扩展名」顺序：先照 PATHEXT 的原顺序，只留我们能跑的四种，
 * 再补上缺的（`.cmd` 永远有机会被找到——那正是这个模块存在的理由）。
 */
export function pathExtList(env = process.env) {
  const raw = envValue(env, 'PATHEXT')
  const ordered = []
  for (const part of raw.split(PATH_DELIMITER)) {
    const ext = part.trim().toUpperCase()
    if (ext === '' || ext.startsWith('.') !== true) continue
    if (RUNNABLE_EXTENSIONS.includes(ext) !== true) continue
    if (ordered.includes(ext) !== true) ordered.push(ext)
  }
  for (const ext of RUNNABLE_EXTENSIONS) {
    if (ordered.includes(ext) !== true) ordered.push(ext)
  }
  return ordered
}

/** 命令里已经带了路径（`C:\…`、`.\…`、`a/b`）就不再进 PATH 解析：那是用户点名的东西。 */
export function looksLikePath(command) {
  const value = String(command ?? '')
  return /[\\/]/.test(value) || /^[A-Za-z]:/.test(value)
}

/**
 * 在 PATH 里按 PATHEXT 找无扩展名命令的真实入口（纯函数，`isFile` 可注入以便跨平台测试）。
 *
 * @returns {{found: boolean, command: string|null, searched: string[]}} `searched` 是实际尝试过的
 *   候选路径（按顺序），解析失败时用它告诉用户「找过哪些名字/目录」。
 */
export function resolveWindowsCommand(command, { env = process.env, isFile = defaultIsFile } = {}) {
  const name = String(command ?? '')
  const searched = []
  if (name === '') return { found: false, command: null, searched }
  const dirs = envValue(env, 'PATH', 'Path', 'path')
    .split(PATH_DELIMITER)
    // PATH 项偶尔带引号（`"C:\Program Files\…"`），去掉后再拼。
    .map(dir => dir.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1'))
    .filter(dir => dir !== '')
  const extensions = pathExtList(env)
  for (const dir of dirs) {
    // 相对 PATH 项（Windows 上极罕见）会按宿主进程 cwd 解析，和目标任务的 cwd 不是一回事：不认。
    if (win32.isAbsolute(dir) !== true) continue
    for (const ext of extensions) {
      const candidate = win32.join(dir, `${name}${ext}`)
      searched.push(candidate)
      if (isFile(candidate) === true) return { found: true, command: candidate, searched }
    }
  }
  return { found: false, command: null, searched }
}

/**
 * 单个 argv 元素 → cmd.exe 命令行里的一个参数（cross-spawn 口径，见 qntm.org/cmd）。
 *
 * 步骤：反斜杠+双引号的组合按 CreateProcess 规则加倍 → 整项用双引号包住 → cmd 元字符加 `^`。
 * 目标是「原样到达 .cmd」，且 `&` / `|` / `%VAR%` 不会被 cmd 当成分隔符或变量展开。
 */
export function escapeCmdArgument(value) {
  let arg = String(value ?? '')
  // 反斜杠后面跟双引号：反斜杠加倍、引号转义（CreateProcess 的还原规则）。
  arg = arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"')
  // 结尾的反斜杠：加倍（否则会吃掉后面补的收尾引号）。
  arg = arg.replace(/(?=(\\+?)?)\1$/, '$1$1')
  arg = `"${arg}"`
  return arg.replace(CMD_META_CHARS, '^$1')
}

/** argv 里第一个 cmd.exe 无法安全传递的字符（返回下标，没有返回 -1）。 */
export function unsafeCmdIndex(argv) {
  const list = Array.isArray(argv) ? argv : []
  for (const [index, value] of list.entries()) {
    if (UNSAFE_CMD_CHARS.test(String(value ?? ''))) return index
  }
  return -1
}

/**
 * 构造经 ComSpec 执行 `.cmd/.bat` 的 spawn 参数：`cmd /d /s /c "…"`。
 *
 * `/d` 跳过 AutoRun、`/s` 让我们自己包的那层引号被原样保留、`/c` 执行后退出；
 * `windowsVerbatimArguments:true` 让 Node 不要碰这条已经转义好的命令行。
 */
export function comspecPlan(command, args = [], env = process.env) {
  const line = [command, ...(Array.isArray(args) ? args : [])].map(escapeCmdArgument).join(' ')
  const comspec = envValue(env, 'ComSpec', 'COMSPEC', 'comspec') === ''
    ? 'cmd.exe'
    : envValue(env, 'ComSpec', 'COMSPEC', 'comspec')
  return {
    command: comspec,
    args: ['/d', '/s', '/c', `"${line}"`],
    options: { windowsVerbatimArguments: true },
  }
}

/**
 * 把一条 check 的 argv 变成「怎么 spawn」的计划（纯函数，不碰进程）。
 *
 * @param {string[]} argv 规范化后的检查命令（第 1 项是命令）。
 * @param {{platform?: string, env?: object, isFile?: (path: string) => boolean}} [options]
 * @returns {{kind: 'spawn'|'missing'|'unsafe', command: string, args: string[], options: object,
 *   searched?: string[], unsafeIndex?: number}}
 *   - `spawn`：照计划执行；非 Windows 与带路径/带扩展名的命令原样交付 spawn（与旧行为一致）。
 *   - `missing`：Windows 上无扩展名命令在 PATH 里找不到（带 `searched` 供报错用）。
 *   - `unsafe`：`.cmd/.bat` 的参数含双引号/控制字符，无法安全传给 cmd.exe。
 */
export function planCheckSpawn(argv, { platform = process.platform, env = process.env, isFile = defaultIsFile } = {}) {
  const list = (Array.isArray(argv) ? argv : []).map(value => String(value ?? ''))
  const command = list[0] ?? ''
  const args = list.slice(1)
  // 非 Windows：保持原样，交给 spawn 自己按 PATH 解析（行为不变）。
  if (platform !== 'win32') return { kind: 'spawn', command, args, options: {} }
  let target = command
  if (win32.extname(command) === '' && looksLikePath(command) !== true) {
    const resolved = resolveWindowsCommand(command, { env, isFile })
    if (resolved.found !== true) {
      return { kind: 'missing', command, args, options: {}, searched: resolved.searched }
    }
    target = resolved.command
  }
  // 带路径 / 带扩展名的命令不再二次解析；只有批处理需要 ComSpec。
  if (BATCH_EXTENSIONS.includes(win32.extname(target).toLowerCase()) !== true) {
    return { kind: 'spawn', command: target, args, options: {} }
  }
  const unsafeIndex = unsafeCmdIndex([target, ...args])
  if (unsafeIndex !== -1) {
    return { kind: 'unsafe', command: target, args, options: {}, unsafeIndex }
  }
  return { kind: 'spawn', ...comspecPlan(target, args, env) }
}

/** 候选路径列表压成一行（报错用）：最多列 `limit` 个，多的只说总数。 */
export function searchedText(searched, limit = 8) {
  const list = (Array.isArray(searched) ? searched : []).filter(item => typeof item === 'string' && item !== '')
  if (list.length === 0) return ''
  if (list.length <= limit) return list.join('、')
  return `${list.slice(0, limit).join('、')} …（共 ${list.length} 个）`
}
