// 台账消息正文的去重口径（P1）：正文类消息（brief / followup / resume / report）只在台账里留
// 「借条」（`{body:'host', chars, digest, summary}`），正文真源是子会话在宿主里的会话日志。
//
// 为什么需要它单独一个模块：写侧（tools / panel-actions / settlement）与读侧（task_status /
// 面板 detail）必须用**同一个** digest 与摘要口径，否则按 digest 回查会对不上。
// 旧行（没有 `meta.body`）一律按「自带正文」处理，不迁移、不丢数据。
import { renderBriefForTask } from './brief.js'
import { HOST_BODY_NO_MATCH, HOST_LOG_MISSING, bodyDigest, bodySummary } from './session-body.js'

/** 正文类消息：只有这几类做了「只存借条」。其余（settle / acceptance / close / delivery_failed）保持原样。 */
export const BODY_KINDS = Object.freeze(['brief', 'followup', 'resume', 'report'])

const BODY_KIND_SET = new Set(BODY_KINDS)

/** 是否正文类消息（决定写入侧要不要瘦身）。 */
export const isBodyKind = kind => BODY_KIND_SET.has(kind)

/** 正文为空时 `rendered` 的兜底占位（列是 NOT NULL，也不能是空串：面板会显示成空白行）。 */
const EMPTY_RENDERED = Object.freeze({
  brief: '（简报正文见子会话）',
  followup: '（追加消息正文见子会话）',
  resume: '（续跑指令正文见子会话）',
  report: '（回报正文见子会话）',
})

/**
 * 正文 → 台账行（写侧唯一入口）。
 *
 * @param {string} kind 消息类型（只对 `isBodyKind` 生效；其他类型原样返回全文）
 * @param {string} text 完整正文
 * @returns {{rendered:string, meta:object|null}} `rendered` 是要落库的那一列（正文类只有摘要）
 */
export function compactMessage(kind, text) {
  const full = String(text ?? '')
  if (!isBodyKind(kind)) return { rendered: full, meta: null }
  const summary = bodySummary(full)
  return {
    rendered: summary === '' ? (EMPTY_RENDERED[kind] ?? '（正文见子会话）') : summary,
    meta: {
      body: 'host',
      chars: full.length,
      digest: bodyDigest(full),
      summary,
    },
  }
}

/**
 * 一行台账消息 → 完整正文（读侧唯一入口）：自带正文的旧行原样给，新行按 digest 去宿主日志找。
 *
 * @param {object} task 台账任务行（`session_id`）
 * @param {{seq:number, kind:string, rendered:string, meta?:object|null}} message 消息行
 * @param {{ userTextByDigest?: Function, reportByDigest?: Function, lastAssistant?: Function }} [body] 正文读取器
 * @returns {Promise<{text:string, source:'inline'|'derived'|'host'|'summary', unavailable?:string}>}
 */
export async function resolveMessageBody(task, message, body) {
  const row = message ?? {}
  const rendered = typeof row.rendered === 'string' ? row.rendered : ''
  const summary = typeof row.meta?.summary === 'string' ? row.meta.summary : bodySummary(rendered)
  // 旧行（`meta.body` 不是 host）就是全文，原样返回——这正是「旧行仍可读」的保证。
  if (row.meta?.body !== 'host') return { text: rendered, source: 'inline' }
  const sessionId = typeof task?.session_id === 'string' ? task.session_id : ''
  const digest = typeof row.meta?.digest === 'string' ? row.meta.digest : ''
  if (row.kind === 'brief') {
    // 简报是插件自己渲染的确定性文本：重渲染比冷读更快、也不依赖子会话还活着。
    return { text: renderBriefForTask(task), source: 'derived' }
  }
  const read = row.kind === 'report'
    ? body?.reportByDigest
    : body?.userTextByDigest
  if (sessionId !== '' && typeof read === 'function') {
    try {
      const text = await read.call(body, sessionId, digest)
      if (typeof text === 'string' && text.trim() !== '') return { text: text.trim(), source: 'host' }
    } catch {
      // 读正文失败只能降级，不能让 task_status / 面板 detail 报错。
    }
  }
  return {
    text: summary,
    source: 'summary',
    unavailable: sessionId === '' ? HOST_BODY_NO_MATCH : HOST_LOG_MISSING,
  }
}
