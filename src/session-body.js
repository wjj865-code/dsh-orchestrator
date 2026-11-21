// 正文来源（P1 去重）：台账只存「指针 + 摘要」，完整正文按需从**宿主会话日志**冷读。
//
// 背景（docs/ARCHITECTURE.md「台账正文去重」）：宿主 0.2.2-rc.5 的会话日志是真源
// （`~/.dsh/sessions` 的 jsonl），dsh-context 的「编队/Fleet」也是读它；插件台账再存一份
// brief/report/last_message 正文就是双份。本模块是**唯一**的正文字面读入口：
//   1) live 会话：`sessions.get(id).snapshotEvents(0)`（进程内，最快）；
//   2) 冷会话（重启后/已结算）：`sessionPersistence.open(id, 'read')` 读全量事件再 close；
//   3) 两条都读不到 → 返回 undefined，调用方降级为摘要 + `unavailable`，**不抛错、不伪造**。
//
// 抽取器（`assistantText` / `userTexts` / `reportEntries`）是纯函数：宿主事件形状变了只影响这里，
// 单测直接喂假事件即可，不需要真机宿主。
//
// 事件形状依据（asar 实读 @deepseek-ai/dsh-session/src/types.ts）：
//   'user/message'      = UserMessage（{id, role, content, source?}）
//   'assistant/message' = {turn, step, message: AssistantMessage, stream, usage?, interrupted?}
//   'tool/call'         = {turn, step, callId, name, arguments: <原始 JSON 字符串>}

import { createHash } from 'node:crypto'

/** 宿主日志读不到（会话被删/归档/迁移待办/服务缺失）时的降级码。 */
export const HOST_LOG_MISSING = 'host-log-missing'
/** 宿主有日志但找不到对应正文（例如摘要来自更早的一次投递）。 */
export const HOST_BODY_NO_MATCH = 'host-body-no-match'

/** 正文摘要口径：台账里最多留这么多字符（单行）。 */
export const BODY_SUMMARY_CHARS = 240

// 与 last-message.js 同口径（sha256 前 16 位），跨模块比对时必须是同一个算法。
export const bodyDigest = text => createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 16)

/** 单行摘要：压空白 + 截断；台账/通知/预览共用同一口径。 */
export function bodySummary(text, max = BODY_SUMMARY_CHARS) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (flat === '') return ''
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** 内容块 → 纯文本（与 last-message.js 的 messageText 同口径，这里独立一份便于纯函数测试）。 */
export function textOfContent(content) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
}

/** 一条 `assistant/message` 事件的正文。 */
export function assistantText(event) {
  if (event?.type !== 'assistant/message') return ''
  return textOfContent(event.data?.message?.content)
}

/** 一条 `user/message` 事件的正文。 */
export function userText(event) {
  if (event?.type !== 'user/message') return ''
  return textOfContent(event.data?.content)
}

/** 全部用户消息（按 seq 升序）：简报/追问/续跑正文的冷读来源。 */
export function userTexts(events) {
  const out = []
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== 'user/message') continue
    const text = userText(event)
    if (text === '') continue
    out.push({ seq: event.seq, time: event.time, text, digest: bodyDigest(text) })
  }
  return out
}

/** 最后一条 assistant 消息的正文（子会话「最后说了什么」）。 */
export function lastAssistantText(events) {
  const list = Array.isArray(events) ? events : []
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const text = assistantText(list[index])
    if (text !== '') return text
  }
  return ''
}

// task_report 的工具名与渲染口径必须与 tools.js / settlement.js 一致：
// 台账里 report 行的 rendered 就是 `[${status}] ${summary}`（旧行原样保存）。
export const REPORT_TOOL = 'task_report'

/** 把一次 task_report 调用渲染成台账里的同一句（冷读与写入两侧共用）。 */
export function renderReportText(status, summary) {
  const head = `[${String(status ?? '').trim() || 'done'}]`
  const body = String(summary ?? '').trim()
  return body === '' ? head : `${head} ${body}`
}

/** 子会话日志里所有 task_report 调用（按 seq 升序）：回报正文的冷读来源。 */
export function reportEntries(events) {
  const out = []
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== 'tool/call' || event.data?.name !== REPORT_TOOL) continue
    let args
    try { args = JSON.parse(event.data.arguments ?? '') } catch { continue }
    const status = typeof args?.status === 'string' ? args.status : 'done'
    const summary = typeof args?.summary === 'string' ? args.summary : ''
    const text = renderReportText(status, summary)
    out.push({ seq: event.seq, time: event.time, status, summary, text, digest: bodyDigest(text) })
  }
  return out
}

/**
 * 正文读取器（惰性、带短缓存）。
 *
 * 为什么缓存：一次面板刷新会对同一会话连读多行（last_message + 最新 report），
 * 每次都冷读 jsonl 太重。缓存只按 sessionId 短路，TTL 很短（默认 5s），
 * 读到失败不缓存（下次仍然重试），会话在跑时也不会长期看过期正文。
 *
 * @param {{ sessions?: () => any, sessionPersistence?: () => any, logger?: { warn?: Function }, ttlMs?: number, now?: () => number, maxEntries?: number }} deps
 */
export function createBodySource({
  sessions,
  sessionPersistence,
  logger,
  ttlMs = 5_000,
  now = () => Date.now(),
  maxEntries = 32,
} = {}) {
  const cache = new Map()
  const serviceOf = value => {
    try {
      return typeof value === 'function' ? value() : value
    } catch {
      return undefined
    }
  }
  const warnOnce = (() => {
    const seen = new Set()
    return key => {
      if (seen.has(key)) return
      seen.add(key)
      try { logger?.warn?.(`dsh-orchestrator: ${key}`) } catch { /* 日志失败不影响读正文 */ }
    }
  })()

  /** live 会话的进程内事件快照；拿不到返回 undefined。 */
  const liveEvents = sessionId => {
    const live = serviceOf(sessions)?.get?.(sessionId)
    if (live === undefined || live === null || typeof live.snapshotEvents !== 'function') return undefined
    try {
      const events = live.snapshotEvents(0)
      return Array.isArray(events) ? events : undefined
    } catch {
      return undefined
    }
  }

  /** 冷读：宿主持久化里的全量事件（只读句柄，读完立刻 close）。 */
  const coldEvents = async sessionId => {
    const persistence = serviceOf(sessionPersistence)
    if (typeof persistence?.open !== 'function') return undefined
    let handle
    try {
      handle = await persistence.open(sessionId, 'read')
      const result = await handle.read(0)
      return Array.isArray(result?.events) ? result.events : undefined
    } catch (error) {
      // 不存在/迁移待办/权限都按「读不到」处理：降级为摘要，绝不把异常抛给面板或工具回执。
      warnOnce(`会话正文冷读失败（${sessionId}）：${error?.message ?? error}`)
      return undefined
    } finally {
      try { await handle?.close?.() } catch { /* 关失败不影响已读到的正文 */ }
    }
  }

  const remember = (sessionId, events) => {
    cache.set(sessionId, { at: now(), events })
    if (cache.size <= maxEntries) return
    // 简单清理：删最旧的一半（面板一次只看一个任务，不需要精确 LRU）。
    const drop = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, Math.ceil(cache.size / 2))
    for (const [key] of drop) cache.delete(key)
  }

  /**
   * 读一个会话的全部事件：live 优先（最新），其次冷读，都失败返回 undefined。
   * @param {string} sessionId
   * @returns {Promise<readonly any[] | undefined>}
   */
  const readEvents = async sessionId => {
    const id = typeof sessionId === 'string' ? sessionId.trim() : ''
    if (id === '') return undefined
    const hit = cache.get(id)
    if (hit !== undefined && now() - hit.at <= ttlMs) return hit.events
    const live = liveEvents(id)
    if (live !== undefined) {
      remember(id, live)
      return live
    }
    const cold = await coldEvents(id)
    if (cold !== undefined) remember(id, cold)
    return cold
  }

  return {
    readEvents,
    /** 子会话「最后一条 assistant 正文」；读不到返回 undefined。 */
    async lastAssistant(sessionId) {
      const events = await readEvents(sessionId)
      if (events === undefined) return undefined
      const text = lastAssistantText(events)
      return text === '' ? undefined : text
    },
    /** 按 digest 精确找回一条用户消息（简报/追问/续跑）。 */
    async userTextByDigest(sessionId, digest) {
      if (typeof digest !== 'string' || digest === '') return undefined
      const events = await readEvents(sessionId)
      if (events === undefined) return undefined
      return userTexts(events).find(item => item.digest === digest)?.text
    },
    /** 按 digest 找回一次 task_report 的完整正文；没有 digest 时退最后一条。 */
    async reportByDigest(sessionId, digest) {
      const events = await readEvents(sessionId)
      if (events === undefined) return undefined
      const entries = reportEntries(events)
      if (entries.length === 0) return undefined
      if (typeof digest === 'string' && digest !== '') {
        return entries.find(item => item.digest === digest)?.text
      }
      return entries[entries.length - 1].text
    },
    /** 测试/诊断用：清缓存。 */
    clear() { cache.clear() },
  }
}
