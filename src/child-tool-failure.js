// 子会话工具失败监听：观察宿主 `tools/result`，挑出「权限 / 沙箱 / 审批」与「环境」类失败，
// 按任务归属写日志，并把 denied 类按 10 分钟窗口去重后合并成一条通知给协调者。
//
// 为什么是 `tools/result`（而不是 session/event 或 tools/post-execute）：
//   - `session/event` 只有渲染后的正文（`[stderr]` 段混在 content 里），拿不到 `sandbox.denied` / `exitCode`；
//   - `tools/post-execute` 是 waterfall，可以改写/阻断结果——我们只想观察，不该介入子会话的自我纠错；
//   - `tools/result` 是 emit（监听器异常被吞并 warn，`dsh-tools/src/pipeline.ts:406-426`），给到 `exec.name` /
//     `exec.arguments` / `exec.agent.id` 与物化后的 `result.value`（pwsh：`exitCode` / `stderr.text` / `sandbox`）。
//   - 作用域：`scopeTarget` 只拦「打了别的 scope 标签」的监听器，未打标签一律放行
//     （`dsh-scope/src/index.ts:170-185`），本插件是根平面插件，所以能收到全部子会话的调用。
//
// 判定顺序（**不许**要求 `exitCode !== 0`：真实样本 `git add` 的 `.git/index.lock: Permission denied`
// 退出码就是 0——pwsh 渲染器只在 signal 非空或 exitCode !== 0 时才追加标记，
// 见 `dsh-tool-pwsh/src/render.ts:77-81`）：
//   1. `result.isError === true`：结构化 `error.info.code` 优先（denied → env → 中断/无关丢弃）；
//      没有 `error.info`（预设 guard 以字符串拒绝，`dsh-tools/src/index.ts:393-400`）才用 content 文本兜底。
//   2. 成功形状：中断先行（timedOut / aborted / stopped / signal）→ `value.sandbox.denied` →
//      `value.sandbox.runnerFailed` → 仅 pwsh/bash 读 `value.stderr.text`，命中权限词即 denied。
//   3. 其余（包括「非零退出但没有任何权限/环境语义」：grep 无匹配、测试红）一律不算失败。
//
// 归属：`exec.agent.id` 就是子会话 id（`dsh-agent/src/types.ts:16-18`），交给 index 注入的
// `workerTaskOf`（派发映射 + 台账 session_id 兜底）归到任务；协调者自己的调用、包会话/普通 root 会话一律丢弃。
//
// 三档告警（与计划一致）：① 日志总是写（env 类只到这一档）；② 只有 denied 且任务还在 `followup` 状态集合
// 才走 notifier（10 分钟 `(taskId, tool, code)` 去重，被压住的留 `suppressed` 审计行）；③ 台账字段**不做**。
// 盲区：外部子会话（codex/claude code/ACP/DSH SDK）的工具事件不在本进程，见 docs/LIMITATIONS.md。
import { statusesWith } from './status-facts.js'
import { toolFailureNotice } from './copy.js'

/** 去重窗口（固定常量，不进配置面：它是降噪阈值，不是需要现场调参的策略）。 */
export const TOOL_FAILURE_DEDUPE_MS = 10 * 60_000

/** 去重窗口的生效值：生产恒为 {@link TOOL_FAILURE_DEDUPE_MS}，只有测试环境变量旁路（只调窗口、不改语义）。 */
export function toolFailureDedupeMs(env = process.env) {
  const raw = Number(env?.DSH_ORCH_TOOL_FAILURE_MS)
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : TOOL_FAILURE_DEDUPE_MS
}

/** 误报证据链要短：head 只留 240 字（日志与通知共用）。 */
export const TOOL_FAILURE_HEAD_MAX = 240

/** 文本通道只扫前 2000 字：命令失败的 stderr 前缀足够定位，再往后是堆栈噪声。 */
export const TOOL_FAILURE_TEXT_SCAN_MAX = 2000

/** 去重表的软上限：超过就顺手清过期项，避免长跑进程无界增长。 */
export const TOOL_FAILURE_SEEN_MAX = 500

// 权限 / 审批被拒：结构化 code 命中即 denied（通知档）。
export const DENIED_CODES = new Set([
  'FS_SANDBOX_DENIED',          // fs 写/改被沙箱拒（dsh-fs-sandbox/src/index.ts:161、:175）
  'APPROVAL_REJECTED',          // 用户拒绝审批（dsh-tools/src/error-codes.ts:12）
  'APPROVAL_UNAVAILABLE',       // 无人可审批（同上 :18）
  'SANDBOX_ESCALATION_REJECTED',   // 沙箱升级被拒（dsh-sandbox/src/escalation.ts:250）
  'SANDBOX_ESCALATION_UNAVAILABLE', // 沙箱升级没有审批通道（同上 :259）
])

// 环境类：命令根本没跑起来（沙箱后端/宿主准备失败、工具缺上下文）——只写日志，不打扰协调者。
export const ENV_CODES = new Set([
  'SANDBOX_UNAVAILABLE',            // 没有可用沙箱后端，拒绝无隔离执行（dsh-sandbox/src/index.ts:141-158）
  'SANDBOX_PREPARATION_FAILED',     // 宿主准备失败（同上 :170）
  'SANDBOX_INVALID_TEMP_ROOT',      // 临时目录落在工作区内（同上 :170）
  'SANDBOX_INVALID_ROOT',           // 根路径非法（dsh-sandbox/src/roots.ts:30）
  'TOOL_CONTEXT_UNAVAILABLE',       // 工具缺上下文（agent/session/服务）（dsh-tools/src/error-codes.ts:24）
])

// 中断不是权限拒绝：调用被取消/中止时既不该告警、也不该算失败（dedupe 键里也不出现）。
export const INTERRUPT_CODES = new Set(['APPROVAL_CANCELLED', 'SANDBOX_ESCALATION_CANCELLED', 'ABORTED'])

/** 只有命令行工具才有「渲染正文里的 stderr」；文本通道限定在它们上面，避免 read/grep 的正文误命中。 */
export const SHELL_TOOLS = new Set(['pwsh', 'bash'])

/** 权限词只收强特征；**不含** `index.lock` / `File exists`（那是 git 并发冲突，不是权限）。 */
const PERMISSION_TEXT = /permission denied|access is denied|operation not permitted|\bEACCES\b|\bEPERM\b|拒绝访问|无权限|权限不足/i

/** 环境词：命令/依赖/路径不存在（中文 Windows 的「找不到路径」也在此列）。 */
const ENV_TEXT = /command not found|is not recognized as an internal or external command|\bENOENT\b|no such file or directory|找不到路径|无法识别/i

/** 家目录脱敏：`C:\Users\<名>` / `C:/Users/<名>` / `/Users/<名>` / `/home/<名>` → `~`（通知会进协调者上下文）。 */
const HOME_PATH = /(?:[A-Za-z]:[\\/]Users[\\/]|\/Users\/|\/home\/)[^\\/\s"'`]+/gi

export function redactHomePath(text) {
  return typeof text === 'string' ? text.replace(HOME_PATH, '~') : ''
}

const textBlocksOf = content => {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

const firstMatchingLine = (text, pattern) => {
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed !== '' && pattern.test(trimmed)) return trimmed
  }
  return undefined
}

const firstNonEmptyLine = text => {
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed !== '') return trimmed
  }
  return ''
}

/** 证据首行：命中正则的那一行 → 否则首个非空行；折叠空白、脱敏、截 {@link TOOL_FAILURE_HEAD_MAX}。 */
export function failureHead(text, pattern) {
  const line = firstMatchingLine(text, pattern) ?? firstNonEmptyLine(text)
  return redactHomePath(line.replace(/\s+/g, ' ').trim()).slice(0, TOOL_FAILURE_HEAD_MAX)
}

const exitCodeOf = value => (typeof value?.exitCode === 'number' ? value.exitCode : undefined)
const sandboxModeOf = value => (typeof value?.sandbox?.mode === 'string' ? value.sandbox.mode : undefined)

/**
 * 判定一次工具调用是否属于「权限 / 环境」失败。
 *
 * @returns `{ kind:'denied'|'env', code, tool, exitCode?, sandboxMode?, head }`，或 `undefined`（不是本功能范围）
 */
export function classifyToolFailure(exec, result) {
  const tool = typeof exec?.name === 'string' ? exec.name : ''
  if (tool === '') return undefined

  if (result?.isError === true) {
    const code = typeof result?.error?.info?.code === 'string' ? result.error.info.code : undefined
    if (code !== undefined) {
      if (INTERRUPT_CODES.has(code)) return undefined
      if (DENIED_CODES.has(code)) {
        const text = textBlocksOf(result.content).slice(0, TOOL_FAILURE_TEXT_SCAN_MAX)
        return { kind: 'denied', code, tool, head: failureHead(text, PERMISSION_TEXT) }
      }
      if (ENV_CODES.has(code)) {
        const text = textBlocksOf(result.content).slice(0, TOOL_FAILURE_TEXT_SCAN_MAX)
        return { kind: 'env', code, tool, head: failureHead(text, ENV_TEXT) }
      }
      // FS_NOT_FOUND / SEARCH_FAILED / FS_NOT_TEXT / WEB_* …：工具自身失败，不是权限/环境问题。
      return undefined
    }
    // 没有结构化身份（guard 以字符串拒绝等）：只能看正文。
    const text = textBlocksOf(result.content).slice(0, TOOL_FAILURE_TEXT_SCAN_MAX)
    if (PERMISSION_TEXT.test(text)) return { kind: 'denied', code: 'GUARD_TEXT_DENIED', tool, head: failureHead(text, PERMISSION_TEXT) }
    if (ENV_TEXT.test(text)) return { kind: 'env', code: 'TOOL_TEXT_ENV', tool, head: failureHead(text, ENV_TEXT) }
    return undefined
  }

  // 成功形状（isError 假值）：命令跑了、可能非零退出——样本 A / B 都在这里。
  const value = result?.value
  if (value === null || typeof value !== 'object') return undefined
  // 被取消 / 超时 / 被外部停止：Windows 强杀也落 exit 1（dsh-tool-pwsh/src/index.ts:130），不算失败。
  if (value.timedOut === true || value.aborted === true) return undefined
  if (value.stopped !== undefined) return undefined
  if (value.signal !== null && value.signal !== undefined) return undefined

  const stderr = typeof value?.stderr?.text === 'string' ? value.stderr.text.slice(0, TOOL_FAILURE_TEXT_SCAN_MAX) : ''

  // 宿主自己认账的 denied（样本 A）——比文本更可信。
  if (value.sandbox?.denied === true) {
    return {
      kind: 'denied',
      code: 'SANDBOX_DENIED',
      tool,
      exitCode: exitCodeOf(value),
      sandboxMode: sandboxModeOf(value),
      head: failureHead(stderr, PERMISSION_TEXT),
    }
  }
  // runner 起不来 = 命令没跑，是沙箱问题（env 档，只写日志）。
  if (value.sandbox?.runnerFailed === true) {
    return { kind: 'env', code: 'SANDBOX_RUNNER_FAILED', tool, exitCode: exitCodeOf(value), sandboxMode: sandboxModeOf(value), head: failureHead(stderr, ENV_TEXT) }
  }
  if (!SHELL_TOOLS.has(tool) || stderr === '') return undefined
  // 文本兜底（样本 B：无沙箱标记、退出码 0，只有 stderr 认得出来）。**不看退出码。**
  if (PERMISSION_TEXT.test(stderr)) {
    return { kind: 'denied', code: 'COMMAND_PERMISSION_DENIED', tool, exitCode: exitCodeOf(value), sandboxMode: sandboxModeOf(value), head: failureHead(stderr, PERMISSION_TEXT) }
  }
  if (ENV_TEXT.test(stderr)) {
    return { kind: 'env', code: 'COMMAND_ENV_FAILED', tool, exitCode: exitCodeOf(value), sandboxMode: sandboxModeOf(value), head: failureHead(stderr, ENV_TEXT) }
  }
  return undefined
}

const isThenable = value => value !== null && typeof value?.then === 'function'

/** 只有这些状态的任务才值得打断协调者（终态任务的迟到事件只写日志）。 */
const FOLLOWUP_STATUSES = new Set(statusesWith('followup'))

/**
 * @param {object} options
 * @param {object} [options.logger] 结构化日志（`src/log.js`）
 * @param {object} [options.notifier] 通知器（用 `summary` 合并上报，与看门狗同一调用形状）
 * @param {(agentId:string)=>object|undefined} [options.taskOfAgent] 子会话 id → 任务（index 注入 `workerTaskOf`）
 * @param {()=>string|undefined} [options.coordinatorId] 兼容旧装配：单个协调者会话 id（排除它自身的调用）
 * @param {()=>string[]} [options.coordinatorIds] 0.36.0 多协调者：协调者名单（排除其中**每个**成员的调用）
 * @param {(task:object)=>string} [options.labelFor] 任务显示名
 * @param {()=>number} [options.now] 时钟（测试注入）
 * @param {number} [options.dedupeMs] 去重窗口（默认 {@link toolFailureDedupeMs}）
 * @param {number} [options.maxSeen] 去重表软上限
 * @param {(message:string)=>void} [options.onWarn] 告警出口
 */
export function createChildToolFailureWatcher({
  logger,
  notifier,
  taskOfAgent,
  coordinatorId,
  coordinatorIds,
  labelFor,
  now = Date.now,
  dedupeMs = toolFailureDedupeMs(),
  maxSeen = TOOL_FAILURE_SEEN_MAX,
  onWarn = () => {},
} = {}) {
  // 协调者名单（任一口径给到都算）：名单里的会话是**协调者**，它们自己的工具失败不进编排面。
  const coordinatorSet = () => {
    const out = new Set()
    if (typeof coordinatorIds === 'function') {
      try {
        for (const id of coordinatorIds() ?? []) if (typeof id === 'string' && id !== '') out.add(id)
      } catch { /* 读不到按空名单 */ }
    }
    if (typeof coordinatorId === 'function') {
      try {
        const single = coordinatorId()
        if (typeof single === 'string' && single !== '') out.add(single)
      } catch { /* 同上 */ }
    }
    return out
  }
  // 去重表：`taskId\0tool\0code` → { at, suppressed }。只在内存（进程重启后允许再报一次，与看门狗同口径）。
  const seen = new Map()

  const log = (event, fields) => {
    try { logger?.log?.(event, fields) } catch { /* 日志失败不影响监听 */ }
  }

  const prune = at => {
    if (seen.size <= maxSeen) return
    for (const [key, entry] of seen) {
      if (at - entry.at >= dedupeMs) seen.delete(key)
    }
  }

  const notify = (task, hit) => {
    if (notifier === undefined || typeof notifier.summary !== 'function') return
    const label = typeof labelFor === 'function' ? labelFor(task) : String(task.title ?? '任务')
    const text = toolFailureNotice({
      label,
      ref: typeof task.ref === 'string' ? task.ref : '',
      tool: hit.tool,
      code: hit.code,
      mode: hit.sandboxMode,
      head: hit.head,
    })
    // system:true 让 index 的 send 接受「没有子会话 sender」的系统通知（与看门狗/启动对账一致）。
    const item = {
      taskId: task.id,
      title: task.title,
      displayName: label,
      readOnly: task.read_only === true,
      access: task.access === 'full' ? 'full' : null,
      status: 'failed',
      system: true,
    }
    try {
      const outcome = notifier.summary([item], text)
      const report = value => {
        if (value?.delivered === true) return
        log('subagent.tool.failure.notify.skipped', {
          taskId: task.id,
          detail: { tool: hit.tool, code: hit.code, reason: value?.reason ?? null },
        })
      }
      if (isThenable(outcome)) {
        void outcome.then(report, error => report({ delivered: false, reason: error?.message ?? String(error) }))
      } else {
        report(outcome)
      }
    } catch (error) {
      onWarn(`dsh-orchestrator: 子会话工具失败通知失败：${error?.message ?? error}`)
    }
  }

  /**
   * 处理一条 `tools/result`。返回判定结果（空 = 不在范围内），供测试与排障用。
   * 任何内部异常都只 warn 一次并吞掉：观察者绝不能反过来打断工具链路。
   */
  const handle = (exec, result) => {
    try {
      const agentId = exec?.agent?.id
      if (typeof agentId !== 'string' || agentId === '') return undefined
      if (coordinatorSet().has(agentId)) return undefined
      const task = typeof taskOfAgent === 'function' ? taskOfAgent(agentId) : undefined
      if (task === undefined || task === null) return undefined
      const hit = classifyToolFailure(exec, result)
      if (hit === undefined) return undefined

      log('subagent.tool.failure', {
        taskId: task.id,
        sessionId: agentId,
        detail: {
          tool: hit.tool,
          kind: hit.kind,
          code: hit.code,
          exitCode: hit.exitCode ?? null,
          sandboxMode: hit.sandboxMode ?? null,
          taskStatus: task.status ?? null,
          head: hit.head,
        },
      })
      // 档 2 只给 denied，且只给还在等人/还在跑的任务：env 类与终态迟到事件都停在档 1。
      if (hit.kind !== 'denied') return hit
      if (!FOLLOWUP_STATUSES.has(task.status)) return hit
      const at = now()
      const key = `${task.id}\u0000${hit.tool}\u0000${hit.code}`
      const previous = seen.get(key)
      if (previous !== undefined && at - previous.at < dedupeMs) {
        previous.suppressed += 1
        log('subagent.tool.failure.suppressed', {
          taskId: task.id,
          sessionId: agentId,
          detail: { tool: hit.tool, code: hit.code, repeat: previous.suppressed },
        })
        return hit
      }
      seen.set(key, { at, suppressed: 0 })
      prune(at)
      notify(task, hit)
      return hit
    } catch (error) {
      try { onWarn(`dsh-orchestrator: 子会话工具失败判定出错（已跳过）：${error?.message ?? error}`) } catch { /* 告警失败也不能外溢 */ }
      return undefined
    }
  }

  return {
    handle,
    /** 去重表大小（测试/排障用）。 */
    size: () => seen.size,
    reset: () => seen.clear(),
    settings: { dedupeMs, maxSeen },
  }
}
