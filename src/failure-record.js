// 结构化失败记录：把 watcher 的判定与子会话自报的失败归一成同一份只读快照。
//
// 为什么不直接存 classifyToolFailure 的 hit：`exitCode` / `sandboxMode` 是 watcher 的内部形态，
// 落库与工具回执需要稳定、可版本化的字段；也不接受模型随手编的自由对象（只认明确信号）。
import { TOOL_FAILURE_HEAD_MAX, redactHomePath } from './child-tool-failure.js'

export const FAILURE_RECORD_VERSION = 1

/** 记录来源：watcher 判定为 denied/env，子会话在 task_report.failure 里自报为 reported。 */
export const FAILURE_KINDS = Object.freeze(['denied', 'env', 'reported'])

const FAILURE_ACTIONS = new Set([
  'escalate_sandbox',
  'request_approval',
  'inspect_acl_or_sandbox',
  'wait_for_git_writer',
  'fix_environment',
  'report_only',
])

const ACTION_TEXT = Object.freeze({
  escalate_sandbox: '升级沙箱后重试',
  request_approval: '请求审批',
  inspect_acl_or_sandbox: '检查 ACL/沙箱',
  wait_for_git_writer: '等 git 写者结束',
  fix_environment: '修环境',
  report_only: '仅上报',
})

const CATEGORY = /^[a-z][a-z0-9_]{0,63}$/

const text = value => (typeof value === 'string' ? value.trim() : '')

const identifier = (value, max = 64) => {
  const raw = text(value)
  return raw === '' ? '' : raw.replace(/[\u0000-\u001f\u007f\s]+/g, '').slice(0, max)
}

const firstFinite = (...values) => {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

const firstText = (...values) => {
  for (const value of values) {
    const raw = text(value)
    if (raw !== '') return raw
  }
  return ''
}

/**
 * 归一化一条失败记录。
 *
 * @param {object|null|undefined} input watcher hit 或 task_report.failure
 * @param {{ now?: number|null, kind?: string, observedAt?: number }} [options]
 * @returns {object|null} 至少有一个有效信号才返回记录；否则 null（调用方按「不能落库」处理）
 */
export function normalizeFailureRecord(input, { now = Date.now(), kind, observedAt } = {}) {
  if (input === null || input === undefined || typeof input !== 'object' || Array.isArray(input)) return null

  const rawKind = text(kind) || text(input.kind)
  const resolvedKind = FAILURE_KINDS.includes(rawKind) ? rawKind : 'reported'
  const tool = identifier(input.tool, 64)
  const code = identifier(input.code, 80)
  const rawCategory = identifier(input.category, 64)
  const category = CATEGORY.test(rawCategory) ? rawCategory : ''
  const action = FAILURE_ACTIONS.has(text(input.action)) ? text(input.action) : ''
  const rawExit = input.exit_code ?? input.exitCode
  const exitCode = typeof rawExit === 'number' && Number.isFinite(rawExit) ? Math.trunc(rawExit) : undefined
  const retryable = typeof input.retryable === 'boolean' ? input.retryable : undefined
  const head = redactHomePath(firstText(input.head, input.message, input.evidence).replace(/\s+/g, ' ').trim())
    .slice(0, TOOL_FAILURE_HEAD_MAX)
  const at = firstFinite(observedAt, input.observed_at, input.observedAt, Number.isFinite(now) ? now : undefined)
  const sandboxMode = identifier(input.sandbox_mode ?? input.sandboxMode, 48)

  // 只有 retryable / version 之类的元数据不算「一次失败」：至少要有工具、code、category、证据或退出码。
  if (tool === '' && code === '' && category === '' && action === '' && head === '' && exitCode === undefined) {
    return null
  }

  const record = { version: FAILURE_RECORD_VERSION, kind: resolvedKind }
  if (tool !== '') record.tool = tool
  if (code !== '') record.code = code
  if (category !== '') record.category = category
  if (retryable !== undefined) record.retryable = retryable
  if (action !== '') record.action = action
  if (head !== '') record.head = head
  if (at !== undefined && at > 0) record.observed_at = at
  if (exitCode !== undefined) record.exit_code = exitCode
  if (sandboxMode !== '') record.sandbox_mode = sandboxMode
  return record
}

/** 从台账列读回：坏 JSON / 空对象 / 不可用结构一律 null，读取方不必各自兜底。 */
export function parseFailureRecord(value) {
  if (value === null || value === undefined) return null
  try {
    const parsed = JSON.parse(value)
    return normalizeFailureRecord(parsed, {
      kind: parsed?.kind,
      observedAt: parsed?.observed_at,
      now: null,
    })
  } catch {
    return null
  }
}

/** 给 task_status / task_detail 的只读文本（一行结论 + 一行证据）。 */
export function failureRecordLines(record, { prefix } = {}) {
  if (record === null || record === undefined || typeof record !== 'object' || Array.isArray(record)) return []
  const tool = text(record.tool)
  const category = text(record.category)
  const code = text(record.code)
  const action = text(record.action)
  const label = category !== '' && code !== '' && code !== category ? `${category}（${code}）` : (category || code || 'unknown')
  const parts = []
  if (tool !== '') parts.push(tool)
  parts.push(label)
  if (typeof record.retryable === 'boolean') parts.push(record.retryable ? '可重试' : '不可重试')
  if (action !== '') parts.push(ACTION_TEXT[action] ?? action)

  const title = text(prefix) || (record.kind === 'env' ? '上次环境失败' : '上次工具失败')
  const lines = [`${title}：${parts.join('｜')}`]
  const head = text(record.head)
  if (head !== '') lines.push(`证据：${head}`)
  return lines
}
