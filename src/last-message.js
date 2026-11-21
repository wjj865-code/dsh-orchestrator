// 子会话「最新返回消息」（结算时的完整 lastAssistantMessage）。
// 目的：子会话结束后，主会话还能看到它最后说了什么（report 正文、被中断前的残值），
// 不必去翻子会话历史或日志。
//
// P1 去重（0.30.1，见 docs/ARCHITECTURE.md「台账正文去重」）：
//   台账里**不再存正文**，只存 `{at, stopReason, source, bytes, chars, digest, summary, stored:'host'}`。
//   正文真源是宿主会话日志（同一条 assistant/message），读的时候由 src/session-body.js 冷读：
//     - 读得到 → `{text, source:'host'}`
//     - 读不到 → `{text: 摘要, source:'summary', unavailable:'host-log-missing'}`（不抛错、不伪造）
//   旧行（`text` / `path` 还在）照常可读：`source:'inline'` / `'file'`，不需要任何迁移。
//
// 为什么不写 reports 文件了：落盘文件曾是「台账塞不下大文本」的旁路，但正文宿主已经有了，
// 再写一份就是第二份副本（且清理策略要自己维护）。超过 MAX_INLINE_BYTES 的旧记录仍能读。
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { BODY_SUMMARY_CHARS, HOST_LOG_MISSING, bodySummary } from './session-body.js'

/** 历史常量：旧行曾经按这个阈值决定「内联 / 落 reports 文件」，现在只用于读旧行与文档口径。 */
export const MAX_INLINE_BYTES = 64 * 1024
export const SUMMARY_CHARS = BODY_SUMMARY_CHARS
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
  return bodySummary(text, max)
}

/** 人类可读体积（KB/MB），只用于展示。 */
export function formatBytes(bytes) {
  const value = Number.isFinite(bytes) ? bytes : 0
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

const digestOf = text => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)

/**
 * 把一次结算的返回消息压成台账记录（纯函数，不写盘）。
 *
 * @returns {null | {at:number, stopReason:string|null, source:string, bytes:number, chars:number,
 *   digest:string, summary:string, stored:'host'}} 空消息返回 null（不回写台账，避免把上一次的返回覆盖成空）。
 */
export function captureLastMessage({
  text,
  taskId,
  stopReason = null,
  source = 'unknown',
  now = () => Date.now(),
} = {}) {
  const body = messageText(text)
  if (body === '') return null
  return {
    at: now(),
    stopReason: stopReason ?? null,
    source,
    bytes: Buffer.byteLength(body, 'utf8'),
    chars: body.length,
    digest: digestOf(body),
    summary: summarizeText(body),
    // 正文住在宿主会话日志里（P1）：台账只留这张借条。
    stored: 'host',
  }
}

/**
 * 同步读旧行（inline / file）：只给「记录里自己带正文」的历史行用。
 * 新行的 `stored === 'host'` 没有正文可读，这里退回摘要——需要全文请用 `resolveLastMessage`。
 */
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

/**
 * 按记录形态取正文（同步部分）：旧行自带正文 / 新行只有借条。
 * @returns {{text:string, source:'inline'|'file'|'summary', unavailable?:string}|null}
 */
function localBody(record) {
  if (record === null || record === undefined) return null
  if (typeof record.text === 'string' && record.text !== '') {
    return { text: record.text, source: 'inline' }
  }
  if (typeof record.path === 'string' && record.path !== '') {
    try {
      return { text: readFileSync(record.path, 'utf8'), source: 'file' }
    } catch {
      return { text: record.summary ?? '', source: 'summary', unavailable: HOST_LOG_MISSING }
    }
  }
  return null
}

/**
 * 解析「最近返回」的正文（P1 读侧）：自带正文的老行直接给，新行去宿主会话日志冷读。
 *
 * @param {object|null} record 台账 `last_message`
 * @param {{ body?: { lastAssistant?: (sessionId:string) => Promise<string|undefined> }, sessionId?: string }} [options]
 * @returns {Promise<{text:string, source:'inline'|'file'|'host'|'summary', unavailable?:string}|null>}
 */
export async function resolveLastMessage(record, { body, sessionId } = {}) {
  const local = localBody(record)
  if (local !== null) return local
  if (record === null || record === undefined) return null
  const summary = typeof record.summary === 'string' ? record.summary : ''
  const id = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (id !== '' && typeof body?.lastAssistant === 'function') {
    try {
      const text = await body.lastAssistant(id)
      if (typeof text === 'string' && text.trim() !== '') return { text: text.trim(), source: 'host' }
    } catch {
      // 冷读实现内部已吞错；这里再兜一层，绝不让面板/回执因为读正文失败而报错。
    }
  }
  return { text: summary, source: 'summary', unavailable: HOST_LOG_MISSING }
}
