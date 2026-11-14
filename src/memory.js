// 跨项目记忆：task_report done 自动沉淀，协调者可用 history_search / memory_note 读写。
// 存储是台账同库的 memories 表；检索用关键词（CJK 二元组 + ASCII 词）+ 项目过滤，
// 不依赖平台 sessionQuery，sessionQuery 只作为 history_search 的补充来源。
import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

export const GLOBAL_PROJECT = 'global'
export const MAX_MEMORY_TEXT = 2000
export const MAX_MEMORY_BLOCK = 1200
const MAX_MEMORIES_PER_PROJECT = 300
const MAX_TOKENS = 12
const STOP_TOKENS = new Set(['任务', '完成', '用户', 'the', 'and', 'for', 'with'])

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
  const clean = String(text ?? '').trim()
  if (clean === '') return undefined
  const clipped = clean.length > MAX_MEMORY_TEXT ? clean.slice(0, MAX_MEMORY_TEXT) : clean
  const key = normalizeKey(projectKey)
  const normalizedKind = clip(kind, 40) || 'note'
  const id = `m-${randomUUID().slice(0, 8)}`
  const hash = hashOf(`${key}|${normalizedKind}|${clipped}`)
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
 * 结果按关键词命中数、kind 权重、时间排序，并更新 last_used/use_count。
 */
export function searchMemories(db, { projectKey = GLOBAL_PROJECT, query = '', limit = 5 } = {}) {
  const key = normalizeKey(projectKey)
  const cap = Number.isFinite(limit) ? Math.min(10, Math.max(1, Math.floor(limit))) : 5
  const terms = memoryTokens(query)
  let rows
  if (terms.length === 0) {
    rows = db.prepare(`SELECT * FROM memories
      WHERE project_key IN (?, ?) ORDER BY created_at DESC LIMIT ?`)
      .all(key, GLOBAL_PROJECT, cap * 4)
  } else {
    const where = terms.map(() => "lower(text) LIKE ? ESCAPE '\\'").join(' OR ')
    rows = db.prepare(`SELECT * FROM memories
      WHERE project_key IN (?, ?) AND (${where}) ORDER BY created_at DESC LIMIT ?`)
      .all(key, GLOBAL_PROJECT, ...terms.map(term => `%${escapeLike(term)}%`), cap * 4)
  }
  const scored = rows.map(row => {
    const text = row.text.toLowerCase()
    let score = terms.reduce((sum, term) => sum + countOf(text, term), 0)
    if (row.kind === 'decision') score += 2
    if (row.kind === 'preference') score += 1
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

/** brief 注入用的紧凑块；没有命中返回空串。 */
export function buildMemoryBlock(db, { projectKey = GLOBAL_PROJECT, query = '', limit = 3, maxChars = MAX_MEMORY_BLOCK } = {}) {
  let rows
  try {
    rows = searchMemories(db, { projectKey, query, limit })
  } catch {
    return ''
  }
  if (rows.length === 0) return ''
  const lines = rows.map(row => {
    const date = new Date(row.createdAt)
    const day = Number.isNaN(date.getTime()) ? '' : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} `
    return `- ${day}${clip(row.text, 300)}`
  })
  let block = `【历史经验】\n${lines.join('\n')}`
  if (block.length > maxChars) block = `${block.slice(0, maxChars - 1)}…`
  return block
}

/** 显式记一条（memory_note 工具）；kind 只做自由字符串截断。 */
export function remember(db, { text, projectKey = GLOBAL_PROJECT, kind = 'note', sourceTaskId = null, sourceSessionId = null } = {}) {
  return addMemory(db, { text, projectKey, kind, sourceTaskId, sourceSessionId })
}
