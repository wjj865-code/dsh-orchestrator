// 可执行验收（P2-1 / A1）：task_create.checks 的规范化、执行与文案。
//
// 安全边界（定死，别再放宽）：
// 1) 命令只来自协调者的 `task_create`（写进 brief 快照）；`task_report` 没有任何命令参数，
//    子会话无法注入或覆盖要执行的命令。
// 2) argv 数组 + `shell: false`：不经 cmd.exe / sh 拼串，参数里的 `&` / `|` / `;` / 引号
//    都只是普通字符，没有 shell 注入面。
// 3) cwd 固定为任务自己的目录（worktree 检出优先，否则 target），不继承主会话目录。
// 4) 每条有超时上限（默认 120s、最多 600s），stdout/stderr 各只留最后 4 KiB。
// 5) 检查跑在**插件宿主进程**里（宿主权限），不是子会话沙箱——这一点文档里必须如实写明，
//    不假装它是沙箱隔离。
import { spawn as spawnProcess } from 'node:child_process'
import { statSync } from 'node:fs'

/** 单任务最多几条检查（再多就该拆任务了，也避免交付时长时间阻塞）。 */
export const MAX_CHECKS = 5
/** argv 最多几个元素（含命令本身）。 */
export const MAX_ARGV_ITEMS = 16
/** 单个 argv 元素字符上限。 */
export const MAX_ARG_CHARS = 2000
/** 整条命令（argv 拼起来）的字符上限。 */
export const MAX_COMMAND_CHARS = 4000
export const DEFAULT_TIMEOUT_MS = 120_000
export const MIN_TIMEOUT_MS = 1_000
export const MAX_TIMEOUT_MS = 600_000
/** stdout / stderr 各留最后这么多字符（口径按字节近似，够排查即可）。 */
export const MAX_OUTPUT_BYTES = 4096
/** 超时先 SIGTERM，这么久还没退出再 SIGKILL。 */
export const KILL_GRACE_MS = 5_000
/** 失败文案里给最后几行输出。 */
export const FAILURE_OUTPUT_LINES = 10
const MAX_NAME_CHARS = 80
const CHECK_FIELDS = new Set(['name', 'command', 'timeoutMs', 'skipIfMissing'])

const text = value => typeof value === 'string' ? value.trim() : ''
const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

// argv 里的普通参数直接展示；含空白或 shell 元字符的用 JSON 引号包起来，和终端里看到的接近。
const quoteArg = arg => /^[A-Za-z0-9_@%+=:,./\\-]+$/.test(arg) ? arg : JSON.stringify(arg)

/** argv → 可读命令（只用于展示，永远不要拿它去 shell 执行）。 */
export function commandText(argv) {
  return (Array.isArray(argv) ? argv : []).map(arg => quoteArg(String(arg))).join(' ')
}

/**
 * 规范化并校验 checks（纯函数）。
 *
 * 接受 `[{ name?, command: string[], timeoutMs?, skipIfMissing? }]`；缺省 name 按 check-1.. 命名。
 * 返回 `{ ok: true, checks }` 或 `{ ok: false, error }`。空数组 / undefined 视为「没有检查」。
 */
export function normalizeChecks(input) {
  if (input === undefined || input === null) return { ok: true, checks: [] }
  if (!Array.isArray(input)) return { ok: false, error: `checks 必须是数组；收到的是 ${input === null ? 'null' : typeof input}` }
  if (input.length === 0) return { ok: true, checks: [] }
  if (input.length > MAX_CHECKS) return { ok: false, error: `checks 最多 ${MAX_CHECKS} 条（收到 ${input.length} 条）` }
  const checks = []
  const names = new Set()
  for (const [index, raw] of input.entries()) {
    if (!isPlainObject(raw)) return { ok: false, error: `checks[${index}] 必须是对象` }
    const unknown = Object.keys(raw).filter(key => !CHECK_FIELDS.has(key))
    if (unknown.length > 0) {
      return { ok: false, error: `checks[${index}] 有不认识的字段 ${unknown.join('、')}（只接受 name / command / timeoutMs / skipIfMissing）` }
    }
    if (raw.name !== undefined && raw.name !== null && typeof raw.name !== 'string') {
      return { ok: false, error: `checks[${index}].name 必须是字符串` }
    }
    const name = text(raw.name) === '' ? `check-${index + 1}` : text(raw.name)
    if (name.length > MAX_NAME_CHARS) {
      return { ok: false, error: `checks[${index}].name 太长（${name.length} 字，上限 ${MAX_NAME_CHARS}）` }
    }
    if (names.has(name)) {
      return { ok: false, error: `checks 里 name 重复：${name}（台账按 name 记结果，必须唯一）` }
    }
    names.add(name)
    if (!Array.isArray(raw.command)) {
      return {
        ok: false,
        error: `checks[${index}].command 必须是 argv 数组（如 ["node","--test"]）；不接受 shell 字符串——`
          + '命令在插件进程里按参数直接执行，不经过 cmd/sh，没有拼串注入面',
      }
    }
    if (raw.command.length === 0) return { ok: false, error: `checks[${index}].command 不能是空数组` }
    if (raw.command.length > MAX_ARGV_ITEMS) {
      return { ok: false, error: `checks[${index}].command 最多 ${MAX_ARGV_ITEMS} 个参数（收到 ${raw.command.length} 个）` }
    }
    const argv = []
    let totalChars = 0
    for (const [position, arg] of raw.command.entries()) {
      if (typeof arg !== 'string') return { ok: false, error: `checks[${index}].command[${position}] 必须是字符串` }
      if (text(arg) === '') return { ok: false, error: `checks[${index}].command[${position}] 不能为空` }
      if (arg.includes('\u0000')) return { ok: false, error: `checks[${index}].command[${position}] 含 NUL 字符` }
      if (arg.length > MAX_ARG_CHARS) {
        return { ok: false, error: `checks[${index}].command[${position}] 太长（${arg.length} 字，单项上限 ${MAX_ARG_CHARS}）` }
      }
      totalChars += arg.length
      argv.push(arg)
    }
    if (totalChars > MAX_COMMAND_CHARS) {
      return { ok: false, error: `checks[${index}].command 太长（${totalChars} 字，总长上限 ${MAX_COMMAND_CHARS}）` }
    }
    let timeoutMs = DEFAULT_TIMEOUT_MS
    if (raw.timeoutMs !== undefined && raw.timeoutMs !== null) {
      if (typeof raw.timeoutMs !== 'number' || !Number.isFinite(raw.timeoutMs)) {
        return { ok: false, error: `checks[${index}].timeoutMs 必须是数字（毫秒）` }
      }
      if (!Number.isInteger(raw.timeoutMs) || raw.timeoutMs < MIN_TIMEOUT_MS || raw.timeoutMs > MAX_TIMEOUT_MS) {
        return { ok: false, error: `checks[${index}].timeoutMs 必须在 ${MIN_TIMEOUT_MS}..${MAX_TIMEOUT_MS} 之间（收到 ${raw.timeoutMs}）` }
      }
      timeoutMs = raw.timeoutMs
    }
    let skipIfMissing = false
    if (raw.skipIfMissing !== undefined && raw.skipIfMissing !== null) {
      if (typeof raw.skipIfMissing !== 'boolean') {
        return { ok: false, error: `checks[${index}].skipIfMissing 必须是布尔值` }
      }
      skipIfMissing = raw.skipIfMissing
    }
    checks.push({ name, argv, timeoutMs, skipIfMissing })
  }
  return { ok: true, checks }
}

/** 任务里的检查清单（brief 是创建时快照，验收记录里的 spec 是兜底）。坏数据当没有。 */
export function checksOf(task) {
  const normalized = normalizeChecks(task?.brief?.checks ?? task?.acceptance?.spec)
  return normalized.ok === true ? normalized.checks : []
}

/**
 * 内部规范形状 → 台账/面板里的公开 spec（`command` 仍是 argv 数组，与 task_create 入参一致）。
 * 只在这里转换：入参形状、brief 快照、验收记录三处永远是同一种写法，不会一边 argv 一边 command。
 */
export function specOf(checks) {
  return (Array.isArray(checks) ? checks : []).map(check => ({
    name: check.name,
    command: [...check.argv],
    timeoutMs: check.timeoutMs,
    skipIfMissing: check.skipIfMissing,
  }))
}

/** 执行目录：隔离任务用检出目录，普通任务用 target 目录；不继承主会话目录。 */
export function executionDirOf(task) {
  const worktree = text(task?.worktree_path)
  if (worktree !== '') return worktree
  return text(task?.target_dir)
}

// 只留尾部：输出可能很大（构建日志），全存会把台账撑爆。
const tail = (value, maxChars) => {
  const input = String(value ?? '')
  return input.length <= maxChars ? input : input.slice(-maxChars)
}

const failureBase = check => ({
  name: check.name,
  command: commandText(check.argv),
  argv: check.argv,
  exitCode: null,
  signal: null,
  timedOut: false,
  skipped: false,
  missing: false,
  truncated: false,
  durationMs: 0,
  outputTail: '',
  error: null,
})

/**
 * 跑一条检查。永远 resolve（不抛）：交付流程不能因为子进程怪异行为整段崩掉。
 * spawnImpl 可注入（测试用），签名与 node:child_process.spawn 相同。
 */
function runOne(check, { cwd, spawnImpl, killGraceMs, maxOutputBytes, now }) {
  return new Promise(resolve => {
    const startedAt = now()
    const base = failureBase(check)
    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false
    let settled = false
    let timeoutTimer
    let graceTimer
    let hardTimer
    let child

    const collect = (stream, chunk) => {
      const next = (stream === 'stdout' ? stdout : stderr) + chunk.toString('utf8')
      if (next.length > maxOutputBytes) truncated = true
      if (stream === 'stdout') stdout = tail(next, maxOutputBytes)
      else stderr = tail(next, maxOutputBytes)
    }
    const finish = (patch = {}) => {
      if (settled === true) return
      settled = true
      clearTimeout(timeoutTimer)
      clearTimeout(graceTimer)
      clearTimeout(hardTimer)
      // 子进程还活着（超时兜底 / 父进程放弃）→ 尽量收尸，别留孤儿。
      if (child !== undefined && child.exitCode === null && child.killed !== true) {
        try { child.kill('SIGKILL') } catch { /* 已经没了 */ }
      }
      const outputTail = [stdout, stderr === '' ? '' : `[stderr]\n${stderr}`].filter(part => part !== '').join('\n')
      const exitCode = Number.isInteger(patch.exitCode) ? patch.exitCode : null
      resolve({
        ...base,
        exitCode,
        signal: patch.signal ?? null,
        timedOut,
        skipped: patch.skipped === true,
        missing: patch.missing === true,
        truncated,
        durationMs: Math.max(0, now() - startedAt),
        outputTail,
        error: patch.error ?? null,
        ok: patch.skipped !== true && timedOut !== true && patch.error === undefined && exitCode === 0,
      })
    }

    try {
      child = spawnImpl(check.argv[0], check.argv.slice(1), {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      const code = error?.code ?? 'SPAWN_FAILED'
      finish({ error: code, missing: code === 'ENOENT', skipped: code === 'ENOENT' && check.skipIfMissing === true })
      return
    }
    // 子进程可能在 'error' / 'close' 之前就给出管道对象；缺管道时按空输出处理。
    child.stdout?.on('data', chunk => collect('stdout', chunk))
    child.stderr?.on('data', chunk => collect('stderr', chunk))
    child.on('error', error => {
      const code = error?.code ?? 'SPAWN_FAILED'
      // ENOENT = 命令不存在：skipIfMissing 时跳过（防「机器上没装 pnpm」把任务卡死）。
      finish({ error: code, missing: code === 'ENOENT', skipped: code === 'ENOENT' && check.skipIfMissing === true })
    })
    child.on('close', (code, signal) => finish({ exitCode: code, signal }))
    timeoutTimer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGTERM') } catch { /* 已经退出 */ }
      graceTimer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* 已经退出 */ }
      }, killGraceMs)
      // 硬兜底：close 事件没来也必须有结果（Windows 上杀进程偶尔不触发 close）。
      hardTimer = setTimeout(() => finish({ error: 'KILL_TIMEOUT' }), killGraceMs + 1_000)
    }, check.timeoutMs)
  })
}

/**
 * 按顺序执行 checks（串行：并发跑构建/测试会互相抢资源，也让耗时归因变糊）。
 *
 * @param {{
 *   checks?: Array<{name: string, argv: string[], timeoutMs: number, skipIfMissing: boolean}>,
 *   cwd?: string,
 *   spawnImpl?: Function,
 *   now?: () => number,
 *   killGraceMs?: number,
 *   maxOutputBytes?: number,
 * }} options
 * @returns {Promise<{ok: boolean, ranAt: number, cwd: string|null, total: number, passed: number,
 *   skipped: number, failed: number, results: Array<object>}>}
 */
export async function runChecks({
  checks, cwd, spawnImpl = spawnProcess, now = Date.now,
  killGraceMs = KILL_GRACE_MS, maxOutputBytes = MAX_OUTPUT_BYTES,
} = {}) {
  const list = Array.isArray(checks) ? checks : []
  const dir = text(cwd)
  const ranAt = now()
  const results = []
  let dirError
  if (dir === '') dirError = '任务没有目标目录：验收命令只在任务自己的 target / worktree 目录里执行'
  else {
    try {
      if (statSync(dir).isDirectory() !== true) dirError = `任务目标目录不是目录：${dir}`
    } catch {
      dirError = `任务目标目录不存在：${dir}`
    }
  }
  if (dirError !== undefined) {
    for (const check of list) {
      results.push({
        ...failureBase(check),
        error: 'CWD_MISSING',
        outputTail: `[未执行] ${dirError}`,
      })
    }
    return summarize({ ranAt, cwd: dir === '' ? null : dir, results })
  }
  for (const check of list) {
    results.push(await runOne(check, { cwd: dir, spawnImpl, killGraceMs, maxOutputBytes, now }))
  }
  return summarize({ ranAt, cwd: dir, results })
}

function summarize({ ranAt, cwd, results }) {
  const passed = results.filter(item => item.ok === true).length
  const skipped = results.filter(item => item.skipped === true).length
  const failed = results.filter(item => item.ok !== true && item.skipped !== true).length
  return { ok: failed === 0, ranAt, cwd, total: results.length, passed, skipped, failed, results }
}

/** 「验收：2/2 通过」；失败时点名未通过的检查（回执 / 通知 / 面板小标共用）。 */
export function acceptanceCountText(result) {
  const total = Number.isFinite(result?.total) ? result.total : 0
  if (total === 0) return '验收：未配置可执行检查'
  const passed = Number.isFinite(result?.passed) ? result.passed : 0
  const skipped = Number.isFinite(result?.skipped) ? result.skipped : 0
  const suffix = skipped > 0 ? `（跳过 ${skipped} 条）` : ''
  const failedNames = (Array.isArray(result?.results) ? result.results : [])
    .filter(item => item?.ok !== true && item?.skipped !== true)
    .map(item => item?.name ?? '?')
  if (result?.ok === true) return `验收：${passed}/${total} 通过${suffix}`
  return `验收：${passed}/${total} 通过（未通过 ${failedNames.length === 0 ? '?' : failedNames.join('、')}）${suffix}`
}

const lastLines = (value, count) => {
  const lines = String(value ?? '').split(/\r?\n/).filter((line, index, all) => !(index === all.length - 1 && line === ''))
  return lines.slice(-count)
}

/** 失败回执正文：失败清单 + 输出尾部 + 怎么继续。任务状态不变，所以必须说清楚。 */
export function acceptanceFailureText(result) {
  const lines = [
    `验收未通过：${acceptanceCountText(result)}`,
    '交付被拒绝：任务未进入待确认（状态不变，仍在进行中），产物未登记。',
  ]
  if (typeof result?.cwd === 'string' && result.cwd !== '') lines.push(`执行目录：${result.cwd}`)
  const failed = (Array.isArray(result?.results) ? result.results : [])
    .filter(item => item?.ok !== true && item?.skipped !== true)
  for (const item of failed) {
    const bits = []
    if (item.error === 'CWD_MISSING') bits.push('未执行（目录问题）')
    else if (item.error === 'ENOENT') bits.push('命令不存在（ENOENT）')
    else if (item.timedOut === true) bits.push('超时被杀')
    else if (item.exitCode === null) bits.push('未拿到退出码')
    else bits.push(`退出码 ${item.exitCode}`)
    bits.push(`耗时 ${item.durationMs}ms`)
    if (item.truncated === true) bits.push('输出已截断')
    lines.push(`- ${item.name}「${item.command}」：${bits.join('｜')}`)
    const tailLines = lastLines(item.outputTail, FAILURE_OUTPUT_LINES)
    if (tailLines.length > 0) {
      lines.push(`  输出尾部（最后 ${FAILURE_OUTPUT_LINES} 行）：`)
      for (const line of tailLines) lines.push(`  ${line}`)
    }
  }
  const skipped = (Array.isArray(result?.results) ? result.results : [])
    .filter(item => item?.skipped === true)
    .map(item => `${item.name}（${item.error ?? 'missing'}）`)
  if (skipped.length > 0) lines.push(`已跳过（skipIfMissing）：${skipped.join('、')}`)
  lines.push('如何继续：修完问题后重新 task_report({status:"done"})；需要用户拍板就 task_report({status:"blocked"})。')
  return lines.join('\n')
}

/** 通过回执（写进 kind:'acceptance' 消息 / 交付回执的一行）。 */
export function acceptancePassText(result) {
  const lines = [`验收通过：${acceptanceCountText(result)}`]
  if (typeof result?.cwd === 'string' && result.cwd !== '') lines.push(`执行目录：${result.cwd}`)
  const skipped = (Array.isArray(result?.results) ? result.results : []).filter(item => item?.skipped === true)
  if (skipped.length > 0) lines.push(`已跳过（skipIfMissing）：${skipped.map(item => item.name).join('、')}`)
  return lines.join('｜')
}

/** task_detail 的检查清单（子会话提前知道自己要过什么）。 */
export function acceptanceDetailBlock(checks) {
  const list = Array.isArray(checks) ? checks : []
  if (list.length === 0) return ''
  const lines = ['【可执行检查】交付前由插件在任务目录里自动执行（argv 直接执行、不经 shell）；未通过则拒绝交付，任务保持进行中：']
  for (const check of list) {
    const extras = [`超时 ${Math.round(check.timeoutMs / 1000)}s`]
    if (check.skipIfMissing === true) extras.push('命令缺失时跳过')
    lines.push(`- ${check.name}：${commandText(check.argv)}（${extras.join('；')}）`)
  }
  return lines.join('\n')
}

/** task_status 的验收段：一眼看到「过没过、谁没过、何时跑的」。 */
export function acceptanceStatusLines(record) {
  if (record === null || typeof record !== 'object') return []
  const at = Number.isFinite(record.ranAt) ? new Date(record.ranAt).toISOString() : '未知时间'
  const lines = [`${acceptanceCountText(record)}｜${at}${record.cwd ? `｜目录 ${record.cwd}` : ''}`]
  for (const item of Array.isArray(record.results) ? record.results : []) {
    const state = item.ok === true
      ? '通过'
      : (item.skipped === true
        ? '已跳过'
        : (item.timedOut === true ? '超时' : `失败(${item.exitCode ?? item.error ?? '?'})`))
    lines.push(`- ${item.name}（${item.command}）：${state}｜${item.durationMs}ms${item.truncated === true ? '｜输出已截断' : ''}`)
  }
  return lines
}
