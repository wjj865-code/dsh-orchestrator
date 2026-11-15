// 跨项目记忆：task_report done 自动沉淀，协调者可用 history_search / memory_note 读写。
// 存储是台账同库的 memories 表；检索用关键词（CJK 二元组 + ASCII 词）+ 项目过滤，
// 不依赖平台 sessionQuery，sessionQuery 只作为 history_search 的补充来源。
//
// M1 记忆分层（2026-11-15）：
// - 日志层 task-log（旧版本写成 task-done）：任务完成记录，只归档，**永不注入 brief**；
// - 事实层 lesson / decision / preference / note：蒸馏后的原子事实，才允许注入 brief。
// 未知 kind 一律按日志层处理（白名单），避免新 kind 意外把长文本带进 brief。
import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

export const GLOBAL_PROJECT = 'global'
export const MAX_MEMORY_BLOCK = 1200
export const MAX_FACT_CHARS = 160
export const MAX_LOG_CHARS = 180
export const TASK_LOG_KIND = 'task-log'
export const LESSON_KIND = 'lesson'
export const MEMORY_LAYERS = Object.freeze({ fact: 'fact', log: 'log' })
export const MEMORY_FACT_KINDS = Object.freeze([LESSON_KIND, 'decision', 'preference', 'note'])
const FACT_KIND_SET = new Set(MEMORY_FACT_KINDS)
const KIND_LABELS = {
  [LESSON_KIND]: '经验',
  decision: '决策',
  preference: '偏好',
  note: '笔记',
  [TASK_LOG_KIND]: '日志',
}
const MAX_MEMORIES_PER_PROJECT = 300
const MAX_TOKENS = 12
const STOP_TOKENS = new Set(['任务', '完成', '用户', 'the', 'and', 'for', 'with'])

/** 分层判定：只有事实层白名单注入 brief；task-log / task-done / 未知 kind 都是日志层。 */
export function memoryLayerOf(kind) {
  return FACT_KIND_SET.has(String(kind ?? '')) ? MEMORY_LAYERS.fact : MEMORY_LAYERS.log
}

export const isInjectableKind = kind => memoryLayerOf(kind) === MEMORY_LAYERS.fact

/** 展示用短标签：注入块和 history_search 都标出来源层。 */
export function memoryKindLabel(kind) {
  const key = String(kind ?? '')
  return KIND_LABELS[key] ?? (memoryLayerOf(key) === MEMORY_LAYERS.log ? '日志' : '记忆')
}

/** 项目键：规范化绝对路径；没有 target 时归 global。Windows 大小写不敏感。 */
export function projectKeyOf(value) {
  if (typeof value !== 'string' || value.trim() === '') return GLOBAL_PROJECT
  try {
    const path = resolve(value)
    return process.platform === 'win32' ? path.toLowerCase() : path
  } catch {
    return GLOBAL_PROJECT
  }
}

const hashOf = value => createHash('sha256').update(String(value)).digest('hex')
// 调用方可能已经传了 global 常量，不能把它当相对目录解析成 `.../global`。
const normalizeKey = value => value === GLOBAL_PROJECT ? GLOBAL_PROJECT : projectKeyOf(value)
const clip = (value, max) => {
  const text = String(value ?? '').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 去重用的 hash；迁移旧行时要按同一公式重算。 */
export function memoryHash(projectKey, kind, text) {
  return hashOf(`${normalizeKey(projectKey)}|${clip(kind, 40) || 'note'}|${String(text ?? '').trim()}`)
}

// ---- 写入即蒸馏 -------------------------------------------------------------
// 日志/verbatim 特征行：shell 提示符、引用原话、测试框架输出、时间戳、堆栈行、diff 头。
const NOISE_LINE = /^(?:[$>]|PS [A-Z]:|\[exit code|\[\d{4}-\d{2}-\d{2}|(?:✓|✔|PASS\b|FAIL\b|not ok \d+|ok \d+)|at [\w.$/\\-]+:\d+|\+\+\+ |--- |@@ )/
// 双字节 bullet / 序号前缀，蒸馏时剥掉，保留事实本体。
const BULLET = /^\s*(?:[-*•]|\d+[.)、]|[（(]\d+[)）])\s*/
const PATHISH = /^(?:[A-Za-z]:[\\/]|\\\\|~[\\/]|\/|\.{1,2}[\\/])/
const looksLikePathDump = piece => {
  if (PATHISH.test(piece)) return true
  if (/[\u4e00-\u9fff]/.test(piece)) return false
  // 纯 ASCII 且只是路径/文件名列表：不是事实，是产物清单。
  return /[\\/]/.test(piece) && /^[\w.\-\\/:~]+$/.test(piece)
}
// 经验/教训类标记：只有带这些词的分句才沉淀成可注入的 lesson。
const LESSON_MARKER = /(经验|教训|注意|避免|以后|今后|下次|结论|踩坑|坑|建议|原则|必须|不要|改用|改为|优先|推荐|根因|原因|定位|偏好|prefer|avoid|must|should|never|always)/i

/** 整块丢掉代码围栏（含围栏内内容），避免「围栏去掉、碎片留下」。 */
function stripFences(source) {
  const kept = []
  let inFence = false
  for (const line of source.split('\n')) {
    const fences = (line.match(/```/g) ?? []).length
    if (fences > 0) {
      if (fences % 2 === 1) inFence = !inFence
      continue
    }
    if (!inFence) kept.push(line)
  }
  return kept.join('\n')
}

/** 超长文本按句读边界截断，避免留下半句。 */
function clipAtBoundary(text, maxChars) {
  if (text.length <= maxChars) return text
  const head = text.slice(0, maxChars)
  const cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('；'), head.lastIndexOf(';'), head.lastIndexOf('，'), head.lastIndexOf(', '))
  return cut >= Math.floor(maxChars * 0.6) ? head.slice(0, cut) : head
}

/**
 * 清洗一段要写入的文本：去代码块、命令/日志行、引用原话，折叠空白，按层上限截断。
 * 保证存进 memories 的不是长日志或 verbatim。
 */
export function distillText(value, maxChars = MAX_FACT_CHARS) {
  const source = stripFences(String(value ?? '').replace(/\r\n?/g, '\n'))
  const kept = source.split('\n')
    .map(line => line.trim().replace(BULLET, ''))
    .filter(line => line !== '' && !NOISE_LINE.test(line) && !looksLikePathDump(line))
  const text = kept.join(' ').replace(/\s+/g, ' ').trim()
  return clipAtBoundary(text, maxChars)
}

/**
 * 把一段回报文本蒸馏成原子事实：按句读/换行拆句，丢掉日志、verbatim、路径清单和超长分句，
 * 去重后最多返回 max 条。返回的每条都是可直接注入 brief 的短句。
 */
export function distillFacts(value, { max = 3, maxChars = MAX_FACT_CHARS } = {}) {
  const source = stripFences(String(value ?? '').replace(/\r\n?/g, '\n'))
  const facts = []
  const seen = new Set()
  for (const piece of source.split(/[。；;！!？?\n]+/)) {
    const fact = piece.replace(BULLET, '').replace(/\s+/g, ' ').trim().replace(/^[，,、：:\s]+|[，,、：:\s]+$/g, '')
    if (fact === '' || NOISE_LINE.test(fact)) continue
    if (fact.length < 4 || fact.length > maxChars) continue // 超长分句 = 长日志/verbatim，整条丢弃
    if (fact.startsWith('任务「') || fact.startsWith('完成：')) continue // 完成任务记录属于日志层，不是经验
    if (looksLikePathDump(fact)) continue
    const key = fact.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    facts.push(fact)
    if (facts.length >= max) break
  }
  return facts
}

/** 从 done 摘要里抽可注入的经验：只保留带经验/教训标记的原子事实。 */
export function distillLessons(value, { max = 2 } = {}) {
  return distillFacts(value, { max: max * 2 })
    .filter(fact => LESSON_MARKER.test(fact))
    .slice(0, max)
}

/** task-log 行：一行完成任务记录，不拼产物清单、不贴 verbatim；总长受 MAX_LOG_CHARS 约束。 */
export function taskLogText(title, summary) {
  const label = `任务「${String(title ?? '').trim()}」完成`
  const clean = distillText(summary, Math.max(40, MAX_LOG_CHARS - label.length - 1))
  if (clean === '') return label
  return clean.startsWith('任务「') ? clean : `${label}：${clean}`
}
const escapeLike = value => String(value).replace(/[\\%_]/g, match => `\\${match}`)
const countOf = (text, term) => {
  if (term === '') return 0
  let count = 0
  let index = text.indexOf(term)
  while (index !== -1) {
    count += 1
    index = text.indexOf(term, index + term.length)
  }
  return count
}

/** 查询词切分：CJK 用二元组提高召回，ASCII 用长度 >=2 的词。 */
export function memoryTokens(query) {
  const raw = String(query ?? '').toLowerCase()
  const tokens = []
  for (const run of raw.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length <= 2) tokens.push(run)
    else for (let index = 0; index < run.length - 1; index += 1) tokens.push(run.slice(index, index + 2))
  }
  for (const word of raw.match(/[a-z0-9][a-z0-9_-]*/g) ?? []) {
    if (word.length >= 2) tokens.push(word)
  }
  return [...new Set(tokens)]
    .filter(token => token !== '' && !STOP_TOKENS.has(token))
    .slice(0, MAX_TOKENS)
}

/**
 * 写一条记忆；同 project+kind+text 的 hash 幂等，重复写返回 undefined。
 * @returns {object|undefined}
 */
export function addMemory(db, {
  projectKey = GLOBAL_PROJECT,
  kind = 'note',
  text,
  sourceTaskId = null,
  sourceSessionId = null,
} = {}) {
  const key = normalizeKey(projectKey)
  const normalizedKind = clip(kind, 40) || 'note'
  // 写入即蒸馏：按层给上限——日志层一行记录，事实层一条原子事实；两者都不收长日志/verbatim。
  const cap = memoryLayerOf(normalizedKind) === MEMORY_LAYERS.log ? MAX_LOG_CHARS : MAX_FACT_CHARS
  const clipped = distillText(text, cap)
  if (clipped === '') return undefined
  const id = `m-${randomUUID().slice(0, 8)}`
  const hash = memoryHash(key, normalizedKind, clipped)
  const now = Date.now()
  const result = db.prepare(`INSERT INTO memories
    (id, project_key, kind, text, source_task_id, source_session_id, hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(hash) DO NOTHING`)
    .run(id, key, normalizedKind, clipped, sourceTaskId ?? null, sourceSessionId ?? null, hash, now)
  if (Number(result.changes) === 0) return undefined
  // 单项目最多保留 300 条，避免自动沉淀无限增长；按创建时间留新的。
  try {
    db.prepare(`DELETE FROM memories WHERE id IN (
      SELECT id FROM memories WHERE project_key = ? ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?
    )`).run(key, MAX_MEMORIES_PER_PROJECT)
  } catch { /* 清理失败不影响写入 */ }
  return { id, projectKey: key, kind: normalizedKind, text: clipped, createdAt: now }
}

/**
 * 按项目 + 关键词检索；无关键词时返回最近记忆。
 * kinds 可限定分层（brief 注入只取事实层）；不传则各层都查（history_search 要能翻日志）。
 * 结果按关键词命中数、kind 权重、时间排序，并更新 last_used/use_count。
 */
export function searchMemories(db, { projectKey = GLOBAL_PROJECT, query = '', limit = 5, kinds } = {}) {
  const key = normalizeKey(projectKey)
  const cap = Number.isFinite(limit) ? Math.min(10, Math.max(1, Math.floor(limit))) : 5
  const terms = memoryTokens(query)
  const kindList = Array.isArray(kinds) ? kinds.filter(item => typeof item === 'string' && item !== '') : []
  const kindSql = kindList.length > 0 ? ` AND kind IN (${kindList.map(() => '?').join(', ')})` : ''
  const kindArgs = kindList
  let rows
  if (terms.length === 0) {
    rows = db.prepare(`SELECT * FROM memories
      WHERE project_key IN (?, ?)${kindSql} ORDER BY created_at DESC LIMIT ?`)
      .all(key, GLOBAL_PROJECT, ...kindArgs, cap * 4)
  } else {
    const where = terms.map(() => "lower(text) LIKE ? ESCAPE '\\'").join(' OR ')
    rows = db.prepare(`SELECT * FROM memories
      WHERE project_key IN (?, ?) AND (${where})${kindSql} ORDER BY created_at DESC LIMIT ?`)
      .all(key, GLOBAL_PROJECT, ...terms.map(term => `%${escapeLike(term)}%`), ...kindArgs, cap * 4)
  }
  const scored = rows.map(row => {
    const text = row.text.toLowerCase()
    let score = terms.reduce((sum, term) => sum + countOf(text, term), 0)
    if (row.kind === 'decision') score += 2
    if (row.kind === 'preference' || row.kind === LESSON_KIND) score += 1
    return { row, score }
  })
  scored.sort((left, right) => right.score - left.score || right.row.created_at - left.row.created_at)
  const picked = scored.slice(0, cap).map(item => item.row)
  const bump = db.prepare('UPDATE memories SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?')
  const now = Date.now()
  for (const row of picked) {
    try { bump.run(now, row.id) } catch { /* 检索不能因统计失败而失败 */ }
  }
  return picked.map(row => ({
    id: row.id,
    projectKey: row.project_key,
    kind: row.kind,
    text: row.text,
    sourceTaskId: row.source_task_id,
    sourceSessionId: row.source_session_id,
    createdAt: row.created_at,
    useCount: row.use_count,
  }))
}

/**
 * brief 注入用的紧凑块；没有命中返回空串。
 * 只取事实层（lesson/decision/preference/note）：任务日志 task-log 不注入，避免 brief 被完成记录灌水。
 */
export function buildMemoryBlock(db, {
  projectKey = GLOBAL_PROJECT,
  query = '',
  limit = 3,
  maxChars = MAX_MEMORY_BLOCK,
  kinds = MEMORY_FACT_KINDS,
} = {}) {
  const injectable = (Array.isArray(kinds) ? kinds : MEMORY_FACT_KINDS).filter(isInjectableKind)
  if (injectable.length === 0) return ''
  let rows
  try {
    rows = searchMemories(db, { projectKey, query, limit, kinds: injectable })
  } catch {
    return ''
  }
  if (rows.length === 0) return ''
  const lines = rows.map(row => {
    const date = new Date(row.createdAt)
    const day = Number.isNaN(date.getTime()) ? '' : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} `
    return `- ${day}[${memoryKindLabel(row.kind)}] ${clip(row.text, 300)}`
  })
  let block = `【历史经验】\n${lines.join('\n')}`
  if (block.length > maxChars) block = `${block.slice(0, maxChars - 1)}…`
  return block
}

/**
 * 迁移：早期版本把 done 摘要写成 kind='task-done'（属于日志层）。
 * 迁到 TASK_LOG_KIND 并按新公式重算 hash（hash 含 kind）；内容重复时删掉旧行，保证幂等。
 * @returns {number} 迁移条数
 */
export function migrateLegacyTaskDone(db) {
  const legacy = db.prepare("SELECT id, project_key, text FROM memories WHERE kind = 'task-done'").all()
  let migrated = 0
  for (const row of legacy) {
    try {
      db.prepare('UPDATE memories SET kind = ?, hash = ? WHERE id = ?')
        .run(TASK_LOG_KIND, memoryHash(row.project_key, TASK_LOG_KIND, row.text), row.id)
      migrated += 1
    } catch {
      // hash 冲突说明已有同内容 task-log：旧行是重复，直接删。
      try { db.prepare('DELETE FROM memories WHERE id = ?').run(row.id) } catch { /* 删不掉就保留旧行 */ }
    }
  }
  return migrated
}

/** 显式记一条（memory_note 工具）；kind 只做自由字符串截断。 */
export function remember(db, { text, projectKey = GLOBAL_PROJECT, kind = 'note', sourceTaskId = null, sourceSessionId = null } = {}) {
  return addMemory(db, { text, projectKey, kind, sourceTaskId, sourceSessionId })
}
