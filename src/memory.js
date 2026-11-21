// 跨项目记忆：task_report done 自动沉淀，协调者可用 context({ mode: 'history' }) / memory_note 读写。
// 存储是台账同库的 memories 表；检索用关键词（CJK 二元组 + ASCII 词）+ 项目过滤，
// 不依赖平台 sessionQuery，sessionQuery 只作为 context({ mode: 'history' }) 的补充来源。
//
// M1 记忆分层（2026-11-15）：
// - 日志层 task-log（旧版本写成 task-done）：任务完成记录，只归档，**永不注入 brief**；
// - 事实层 lesson / decision / preference / note：蒸馏后的原子事实，才允许注入 brief。
// 未知 kind 一律按日志层处理（白名单），避免新 kind 意外把长文本带进 brief。
//
// M2 记忆优化（2026-11-21，审计 §7 最小落地包）：
// - 检索质量门槛：多词查询要求命中 ≥2 个词或 score ≥2，通用词进停用词（不再「永远 3 条、20% 相关」）；
// - 分层配额：decision/preference 一次最多 2 条，其余槽位给 lesson/note；
// - 淘汰分层：只有日志层参与淘汰（单项目 task-log 留最新 200 条），事实层永不删；
// - 多键检索：normalizeProjectKeys 支持单键 / 多键数组 / 'all'（context history 的 project 参数）。
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const GLOBAL_PROJECT = 'global'
export const MAX_MEMORY_BLOCK = 1200
export const MAX_FACT_CHARS = 160
export const MAX_LOG_CHARS = 180
// L1 brief 精简：brief 只留短摘要，完整经验落在 $DSH_HOME/state/orchestrator/lessons/ 下的记忆文件。
export const MAX_LESSON_SUMMARY_CHARS = 64
export const LESSONS_DIRNAME = 'lessons'
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
// 淘汰分层（M2，2026-11-21，审计 §2.5 缺陷 1）：配额只作用于**日志层** task-log，事实层永不淘汰。
// 旧口径「单项目 300 条」把 fact 与 log 混在一起算；日志写入量是事实的 2–3 倍（实测 fact 9–29/天、
// log 21–58/天），项目一活跃就开始按 created_at 删 11-14 手记的 decision/note。
// 现在：fact（lesson/decision/preference/note）不参与淘汰；task-log 单项目 200 条（比旧的 300 更紧）。
// 旧的 300 因此不再保留：它和 200 的日志上限叠加时永远先被 200 触发，留着只会让「口径到底几条」继续含糊。
export const MAX_TASK_LOG_PER_PROJECT = 200
const MAX_TOKENS = 12
// 通用词停用：这些词在几乎任何记忆里都出现，命中它们不构成「相关」（审计 §3.1：首条命中 token
// 重合度均值 20%，多数只共「任务/插件」这类词）。只加**不携带项目语义**的词，别把领域词误杀。
const STOP_TOKENS = new Set([
  '任务', '完成', '用户', '插件', '测试', '实现', '代码', '文件', '项目', '问题', '需要', '可以', '这个', '那个',
  'the', 'and', 'for', 'with', 'this', 'that', 'code', 'file', 'test', 'task', 'user', 'plugin', 'project',
])
// 最低命中（质量门槛，审计 §7 第 2 条）：查询词 ≥2 个时，一条记忆必须命中 ≥2 个词或分数 ≥2
// （分数 ≥2 = 带 kind 权重的 decision，或 2 次词频），把「永远 3 条、20% 相关」改成「少而准」。
// 单词查询沿用「命中即相关」（min = 1）：否则「查一个关键词什么也查不到」比现在还糟。
const MIN_QUERY_HITS = 2
// 分层配额：一个结果集里 decision/preference 最多占 2 条，剩余槽位优先给 lesson/note
// （避免「3 条决策、0 条经验」）。没有其它层可补时按分数补回——不为配额返回更少结果。
const DECISIONISH_QUOTA = 2
const DECISIONISH_KINDS = new Set(['decision', 'preference'])

/** 分层判定：只有事实层白名单注入 brief；task-log / task-done / 未知 kind 都是日志层。 */
export function memoryLayerOf(kind) {
  return FACT_KIND_SET.has(String(kind ?? '')) ? MEMORY_LAYERS.fact : MEMORY_LAYERS.log
}

export const isInjectableKind = kind => memoryLayerOf(kind) === MEMORY_LAYERS.fact

/** 展示用短标签：注入块和 context 检索结果都标出来源层。 */
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
  // 淘汰分层：只有日志层（task-log / 旧 task-done / 未知 kind）参与淘汰，单项目留最新的 200 条；
  // 事实层一条都不删——手记的 decision/note 比自动日志珍贵，不能因为写日志多就被挤掉。
  if (memoryLayerOf(normalizedKind) === MEMORY_LAYERS.log) {
    try {
      db.prepare(`DELETE FROM memories WHERE id IN (
        SELECT id FROM memories WHERE project_key = ?
          AND kind NOT IN (${MEMORY_FACT_KINDS.map(() => '?').join(', ')})
        ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?
      )`).run(key, ...MEMORY_FACT_KINDS, MAX_TASK_LOG_PER_PROJECT)
    } catch { /* 清理失败不影响写入 */ }
  }
  return { id, projectKey: key, kind: normalizedKind, text: clipped, createdAt: now }
}

/**
 * 项目键归一（P0-b）：`'all'`（或数组里含 'all'）→ `null`，表示「不按项目过滤」；
 * 字符串/数组 → 去重后的键列表（自动补 `global`，与旧行为一致：项目检索总能召回跨项目记忆）。
 */
export function normalizeProjectKeys(value) {
  const raw = Array.isArray(value) ? value : [value]
  const keys = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const text = item.trim()
    if (text === '') continue
    if (text.toLowerCase() === 'all') return null
    const key = normalizeKey(text)
    if (!keys.includes(key)) keys.push(key)
  }
  if (keys.length === 0) return [GLOBAL_PROJECT]
  if (!keys.includes(GLOBAL_PROJECT)) keys.push(GLOBAL_PROJECT)
  return keys
}

/**
 * 分层配额：decision/preference 优先占满 `decisionQuota` 个槽位，其余槽位按分数留给 lesson/note。
 * 所有候选都是 decision/preference 时按分数补回（不为多样性少返回结果）。
 */
function pickLayered(scored, cap, { decisionQuota = DECISIONISH_QUOTA } = {}) {
  const picked = []
  const deferred = []
  let decisionish = 0
  for (const item of scored) {
    if (picked.length >= cap) break
    if (DECISIONISH_KINDS.has(item.row.kind)) {
      if (decisionish >= decisionQuota) {
        deferred.push(item)
        continue
      }
      decisionish += 1
    }
    picked.push(item)
  }
  for (const item of deferred) {
    if (picked.length >= cap) break
    picked.push(item)
  }
  return picked
}

/**
 * 按项目 + 关键词检索；无关键词时返回最近记忆。
 * kinds 可限定分层（brief 注入只取事实层）；不传则各层都查（context 检索要能翻日志）。
 * projectKey / projectKeys 支持单键、多键数组与 `'all'`（P0-b：多键合并后统一按分数截 limit）。
 * 结果过质量门槛（最低命中 / 停用词）与分层配额后，按分数、时间排序，并更新 last_used/use_count。
 */
export function searchMemories(db, { projectKey = GLOBAL_PROJECT, projectKeys, query = '', limit = 5, kinds } = {}) {
  // 注意别用 `projectKeys ?? projectKey`：`'all'` 归一成 null（不过滤），null 会被 ?? 吃掉又变回单键。
  const keys = projectKeys === undefined ? normalizeProjectKeys(projectKey) : normalizeProjectKeys(projectKeys)
  const cap = Number.isFinite(limit) ? Math.min(10, Math.max(1, Math.floor(limit))) : 5
  const terms = memoryTokens(query)
  const kindList = Array.isArray(kinds) ? kinds.filter(item => typeof item === 'string' && item !== '') : []
  const kindSql = kindList.length > 0 ? ` AND kind IN (${kindList.map(() => '?').join(', ')})` : ''
  const kindArgs = kindList
  // keys === null（'all'）时不加项目过滤：跨项目检索，用来回答「哪个项目记过这件事」。
  const keySql = keys === null ? '' : ` AND project_key IN (${keys.map(() => '?').join(', ')})`
  const keyArgs = keys ?? []
  // 多键合并时行数会成倍增加：取回窗口按键数放大，避免「按时间截断」把某个键的命中整个切掉。
  const window = cap * 6
  let rows
  if (terms.length === 0) {
    rows = db.prepare(`SELECT * FROM memories
      WHERE 1 = 1${keySql}${kindSql} ORDER BY created_at DESC LIMIT ?`)
      .all(...keyArgs, ...kindArgs, window)
  } else {
    const where = terms.map(() => "lower(text) LIKE ? ESCAPE '\\'").join(' OR ')
    rows = db.prepare(`SELECT * FROM memories
      WHERE 1 = 1${keySql} AND (${where})${kindSql} ORDER BY created_at DESC LIMIT ?`)
      .all(...keyArgs, ...terms.map(term => `%${escapeLike(term)}%`), ...kindArgs, window)
  }
  const scored = []
  for (const row of rows) {
    const text = row.text.toLowerCase()
    let score = 0
    let hits = 0
    for (const term of terms) {
      const count = countOf(text, term)
      if (count > 0) hits += 1
      score += count
    }
    if (row.kind === 'decision') score += 2
    if (row.kind === 'preference' || row.kind === LESSON_KIND) score += 1
    // 质量门槛：多词查询要命中 ≥2 个词（或分数 ≥2）；单词查询命中即算（min = 1）。
    if (terms.length > 0 && hits < Math.min(MIN_QUERY_HITS, terms.length) && score < 2) continue
    scored.push({ row, score })
  }
  scored.sort((left, right) => right.score - left.score || right.row.created_at - left.row.created_at)
  const picked = pickLayered(scored, cap).map(item => item.row)
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

const dayOf = createdAt => {
  const date = new Date(createdAt)
  return Number.isNaN(date.getTime())
    ? ''
    : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} `
}
const inlineMemoryLine = row => `- ${dayOf(row.createdAt)}[${memoryKindLabel(row.kind)}] ${clip(row.text, 300)}`

/** 内联记忆块（context 的项目背景 / 降级路径用）：每条一行，总长受 maxChars 约束。 */
export function memoryBlockFromRows(rows, { maxChars = MAX_MEMORY_BLOCK } = {}) {
  const list = Array.isArray(rows) ? rows : []
  if (list.length === 0) return ''
  let block = `【历史经验】\n${list.map(inlineMemoryLine).join('\n')}`
  if (block.length > maxChars) block = `${block.slice(0, maxChars - 1)}…`
  return block
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
  return memoryBlockFromRows(rows, { maxChars })
}

// ---- 经验文件（L1 brief 精简） -------------------------------------------------
// brief 里只放「短摘要 + 文件指针」，完整经验写进 $DSH_HOME/state/orchestrator/lessons/，
// 子会话用 worker 预设自带的 read 就能读全文，brief 不再背整块记忆。

/** 项目目录名（可读）+ 项目键短 hash（唯一），例如 dsh-orchestrator-1a2b3c4d.md。 */
const projectSlug = projectKey => {
  const key = normalizeKey(projectKey)
  if (key === GLOBAL_PROJECT) return 'global'
  const base = key.split(/[\\/]+/).filter(Boolean).pop() ?? ''
  const ascii = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return ascii === '' ? 'project' : ascii.slice(0, 32)
}

/** 记忆文件路径：同一项目始终落到同一个文件（每次派发覆盖为最新快照）。 */
export function lessonFilePath(stateDir, projectKey = GLOBAL_PROJECT) {
  const key = normalizeKey(projectKey)
  return join(resolve(String(stateDir)), LESSONS_DIRNAME, `${projectSlug(key)}-${hashOf(key).slice(0, 8)}.md`)
}

/** 记忆文件正文：markdown，含完整事实文本与来源，便于子会话直接 read。 */
export function renderLessonFile({ projectKey = GLOBAL_PROJECT, rows = [], now = Date.now() } = {}) {
  const key = normalizeKey(projectKey)
  const generated = new Date(now)
  const stamp = Number.isNaN(generated.getTime()) ? '' : generated.toISOString()
  const head = [
    `# 项目经验：${key === GLOBAL_PROJECT ? '全局（跨项目）' : key}`,
    '',
    '> 由 dsh-orchestrator 自动生成（台账 memories 事实层）。brief 里只给摘要和本文件路径，',
    '> 这里才是完整内容；要改记忆请用 memory_note / context({ mode: \'history\' })，手改会在下次派发时被覆盖。',
    ...(stamp === '' ? [] : [`> 生成时间：${stamp}`]),
    '',
  ]
  const list = Array.isArray(rows) ? rows : []
  const body = list.map((row, index) => {
    const meta = [
      `id：${row.id ?? '-'}`,
      row.sourceTaskId === null || row.sourceTaskId === undefined ? '' : `来源任务：${row.sourceTaskId}`,
      row.sourceSessionId === null || row.sourceSessionId === undefined ? '' : `来源会话：${row.sourceSessionId}`,
    ].filter(Boolean).join('｜')
    return [
      `## ${index + 1}. [${memoryKindLabel(row.kind)}]${dayOf(row.createdAt).trim() === '' ? '' : ` ${dayOf(row.createdAt).trim()}`}`,
      '',
      String(row.text ?? ''),
      '',
      `- ${meta}`,
      '',
    ].join('\n')
  })
  return [...head, ...body].join('\n')
}

/** 写记忆文件；stateDir 缺失或写失败返回 undefined（调用方退回内联块）。 */
export function writeLessonFile({ stateDir, projectKey = GLOBAL_PROJECT, rows = [], now = Date.now() } = {}) {
  if (typeof stateDir !== 'string' || stateDir.trim() === '') return undefined
  if (!Array.isArray(rows) || rows.length === 0) return undefined
  try {
    mkdirSync(resolve(String(stateDir), LESSONS_DIRNAME), { recursive: true })
    const path = lessonFilePath(stateDir, projectKey)
    writeFileSync(path, renderLessonFile({ projectKey, rows, now }), 'utf8')
    return path
  } catch {
    return undefined
  }
}

/** brief 里的指针块：条数 + 每条一句短摘要 + 文件路径。路径行永不截断。 */
export function lessonPointerBlock(rows, path, { maxChars = MAX_MEMORY_BLOCK } = {}) {
  const list = Array.isArray(rows) ? rows : []
  if (list.length === 0 || typeof path !== 'string' || path.trim() === '') return ''
  const header = `【历史经验】${list.length} 条｜完整内容见经验文件（可 read 全文）`
  const pathLine = `完整经验：${path.trim()}`
  let lines = list.map(row => `- ${dayOf(row.createdAt)}[${memoryKindLabel(row.kind)}] ${clip(row.text, MAX_LESSON_SUMMARY_CHARS)}`)
  const render = () => [header, ...lines, pathLine].join('\n')
  let block = render()
  // 超上限先丢摘要行，路径保留：拿不到摘要还能去文件里看，丢了路径就什么都看不到了。
  while (block.length > maxChars && lines.length > 0) {
    lines = lines.slice(0, -1)
    block = render()
  }
  return block
}

/**
 * brief 用的记忆块（L1）：完整经验写记忆文件，brief 只给短摘要 + 指针。
 * 降级（mode='inline'）：stateDir 缺失 / 写文件失败 / 无命中时退回旧的内联块或无块。
 * @returns {{ block: string, path?: string, count: number, mode: 'pointer'|'inline' }}
 */
export function buildLessonBlock(db, {
  stateDir,
  projectKey = GLOBAL_PROJECT,
  query = '',
  limit = 3,
  maxChars = MAX_MEMORY_BLOCK,
  kinds = MEMORY_FACT_KINDS,
  now = Date.now(),
} = {}) {
  const injectable = (Array.isArray(kinds) ? kinds : MEMORY_FACT_KINDS).filter(isInjectableKind)
  if (injectable.length === 0) return { block: '', count: 0, mode: 'inline' }
  let rows
  try {
    rows = searchMemories(db, { projectKey, query, limit, kinds: injectable })
  } catch {
    rows = []
  }
  if (rows.length === 0) return { block: '', count: 0, mode: 'inline' }
  const path = writeLessonFile({ stateDir, projectKey, rows, now })
  if (path === undefined) {
    return { block: memoryBlockFromRows(rows, { maxChars }), count: rows.length, mode: 'inline' }
  }
  return { block: lessonPointerBlock(rows, path, { maxChars }), path, count: rows.length, mode: 'pointer' }
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
