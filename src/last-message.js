// 子会话「最新返回消息」（结算时的完整 lastAssistantMessage）。
// 目的：子会话结束后，主会话还能看到它最后说了什么（report 正文、被中断前的残值），
// 不必去翻子会话历史或日志。
// 存储策略：短消息直接进台账（tasks.last_message_json）；超过 MAX_INLINE_BYTES 写
//   <state>/reports/<taskId>.md，台账只留「路径 + 摘要 + 长度」，避免 SQLite 单行膨胀。
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const MAX_INLINE_BYTES = 64 * 1024
export const SUMMARY_CHARS = 240
// task_status 默认展示的预览长度：再长的正文要用户显式 include=full 才给。
export const PREVIEW_CHARS = 1200

/** ContentBlock[] / 裸文本 → 完整可读文本（不截断；多个 text 块用换行分隔）。 */
export function messageText(output) {
  if (typeof output === 'string') return output.trim()
  const blocks = Array.isArray(output) ? output : []
  return blocks
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
}

/** 单行摘要：压空白 + 截断（台账/通知/预览共用同一口径）。 */
export function summarizeText(text, max = SUMMARY_CHARS) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (flat === '') return ''
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** 人类可读体积（KB/MB），只用于展示。 */
export function formatBytes(bytes) {
  const value = Number.isFinite(bytes) ? bytes : 0
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

const digestOf = text => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)

// 文件名只用任务编号：同一任务重写覆盖，目录不会随结算次数增长。
const safeName = taskId => {
  const text = String(taskId ?? '').replace(/[^A-Za-z0-9._-]/g, '_')
  return text === '' ? 'unknown' : text
}

/**
 * 把一次结算的返回消息落成台账记录（纯函数 + 一次文件写）。
 * @returns {null | {at:number, stopReason:string|null, source:string, bytes:number, chars:number,
 *   digest:string, summary:string, stored:'inline'|'file', text?:string, path?:string}}
 * 空消息返回 null（不回写台账，避免把上一次的返回覆盖成空）。
 */
export function captureLastMessage({
  text,
  taskId,
  reportsDir,
  stopReason = null,
  source = 'unknown',
  now = Date.now(),
} = {}) {
  const body = messageText(text)
  if (body === '') return null
  const bytes = Buffer.byteLength(body, 'utf8')
  const record = {
    at: now,
    stopReason: stopReason ?? null,
    source,
    bytes,
    chars: body.length,
    digest: digestOf(body),
    summary: summarizeText(body),
  }
  const useFile = bytes > MAX_INLINE_BYTES && typeof reportsDir === 'string' && reportsDir !== ''
  if (!useFile) return { ...record, stored: 'inline', text: body }
  const path = join(reportsDir, `${safeName(taskId)}.md`)
  try {
    mkdirSync(reportsDir, { recursive: true })
    writeFileSync(path, body, 'utf8')
    return { ...record, stored: 'file', path }
  } catch {
    // 写不进文件就退回内联：宁可撑大一行台账，也不能丢掉模型最后说的话。
    return { ...record, stored: 'inline', text: body }
  }
}

/** include=full 用：内联直接给文本，文件读盘；读失败降级为摘要 + 原因。 */
export function readLastMessage(record) {
  if (record === null || record === undefined) return ''
  if (typeof record.text === 'string') return record.text
  if (typeof record.path !== 'string' || record.path === '') return record.summary ?? ''
  try {
    return readFileSync(record.path, 'utf8')
  } catch (error) {
    return `${record.summary ?? ''}\n（全文读取失败：${record.path}：${error?.message ?? error}）`
  }
}
