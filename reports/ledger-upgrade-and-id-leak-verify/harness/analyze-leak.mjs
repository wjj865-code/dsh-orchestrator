// Leakage accounting: from mock request logs + isolated ledger + browser-visible text,
// count bare `t-xxxx` occurrences in user-visible text.
//
// 口径（写进报告）：
//   主口径（用户可见）＝ 三类会被用户直接看到的文本单元：
//     U1 协调者主会话回复正文（assistant text blocks，GUI 会话里逐条可见）
//     U2 注入给协调者的任务通知正文（任务「…」…：交付/进展/阻塞），GUI 里显示为用户消息
//     U3 台账 messages.rendered（面板「消息」/task_detail 读的渲染文本）
//     U4 台账任务字段（title / question / options / last_message.summary / 产物 label）
//   参考口径（更宽）＝ 再加两类「不是聊天内容但会进模型上下文」的文本：
//     R1 用户手打提示（含 LEAK_ 关键字）
//     R2 平台/插件注入的 system-reminder 与策略正文（含模板字样 t-xxxx）
//     R3 浏览器整页 innerText 去重后的行（真实屏幕可见文本）
//   编号形态分两层：真实台账编号 = `t-` + 8 位十六进制（createTask 生成）；
//     其它匹配（如策略里的模板 `t-xxxx`）= 模板字样，不算泄漏，单列。
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const OUT = process.env.E2E_OUT ?? 'C:/Users/72489/AppData/Local/Temp/orch-leak-verify/artifacts'
const HOME = process.env.E2E_HOME ?? 'C:/Users/72489/AppData/Local/Temp/orch-leak-verify/home'
const REPORT = process.env.REPORT_OUT ?? 'C:/Users/72489/Documents/dsh-orchestrator/reports/ledger-upgrade-and-id-leak-verify'
const LEDGER = join(HOME, 'state/orchestrator/tasks.sqlite')

const JSONL = path => existsSync(path)
  ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  : []
const requests = JSONL(join(OUT, 'mock/requests.jsonl'))
const decisions = JSONL(join(OUT, 'mock/decisions.jsonl'))
const drive = JSON.parse(readFileSync(join(OUT, 'drive-results.json'), 'utf8'))

// mock writes the full request body as `requestBody`; older logs used `body`.
const bodyOf = request => request.requestBody ?? request.body
const ANY_ID = /\bt-[0-9a-z]{4,32}\b/g
const REAL_ID = /\bt-[0-9a-f]{8}\b/g
const idsAny = text => [...String(text ?? '').matchAll(ANY_ID)].map(match => match[0])
const idsReal = text => [...String(text ?? '').matchAll(REAL_ID)].map(match => match[0])

const blocksOf = body => (Array.isArray(body?.messages) ? body.messages : [])
  .flatMap(message => ({ role: message?.role, blocks: Array.isArray(message?.content) ? message.content : [] }))
const textsOfBlocks = blocks => blocks.filter(block => block?.type === 'text').map(block => String(block.text ?? ''))
const toolResultTexts = body => blocksOf(body)
  .flatMap(({ blocks }) => blocks.filter(block => block?.type === 'tool_result'))
  .map(block => Array.isArray(block.content) ? block.content.map(item => item?.text ?? '').join('\n') : String(block.content ?? ''))
const toolUseInputs = body => blocksOf(body)
  .flatMap(({ blocks }) => blocks.filter(block => block?.type === 'tool_use'))
  .map(block => ({ name: block.name, input: block.input ?? {} }))

const classifyUserText = text => {
  if (/^LEAK_[A-D]/.test(text)) return 'typed-prompt'
  if (text.includes('<system-reminder>')) return 'system-reminder'
  if (text.includes('任务「')) return 'task-notification'
  if (text.includes('【任务引用】')) return 'worker-brief'
  if (/向用户汇报任务时|协调者|你是/.test(text)) return 'policy'
  return 'other'
}

// U1/U2 (+R1/R2): de-duplicated session message units, ordered by first appearance.
const coordinatorRequests = requests.filter(request => request.kind === 'coordinator')
const assistantTexts = new Map()
const userTexts = new Map()
for (const request of coordinatorRequests) {
  for (const { role, blocks } of blocksOf(bodyOf(request))) {
    const texts = textsOfBlocks(blocks)
    for (const text of texts) {
      if (!text.trim()) continue
      if (role === 'assistant') {
        if (!assistantTexts.has(text)) assistantTexts.set(text, { at: request.at, text, flow: request.flow })
      } else if (role === 'user') {
        if (!userTexts.has(text)) userTexts.set(text, { at: request.at, text, cls: classifyUserText(text) })
      }
    }
  }
}

// U3 / U4: isolated ledger.
const db = new DatabaseSync(LEDGER, { readOnly: true })
const taskRows = db.prepare(`SELECT t.id, t.title, t.status, t.question, t.question_options_json, t.last_message_json,
  t.artifacts_json, r.token AS ref FROM tasks t LEFT JOIN task_refs r ON r.task_id = t.id ORDER BY t.created_at`).all()
const messageRows = db.prepare('SELECT task_id, seq, kind, rendered FROM messages ORDER BY task_id, seq').all()
const notificationRows = db.prepare('SELECT task_id, level, status, reason FROM notifications ORDER BY rowid').all()
db.close()

const taskFieldTexts = []
for (const row of taskRows) {
  taskFieldTexts.push({ unit: 'title', task: String(row.id), text: String(row.title ?? '') })
  if (row.question !== null && row.question !== undefined) taskFieldTexts.push({ unit: 'question', task: String(row.id), text: String(row.question) })
  if (row.question_options_json) taskFieldTexts.push({ unit: 'question_options', task: String(row.id), text: String(row.question_options_json) })
  if (row.last_message_json) {
    let summary = ''
    try { summary = String(JSON.parse(row.last_message_json)?.summary ?? '') } catch { summary = String(row.last_message_json) }
    taskFieldTexts.push({ unit: 'last_message.summary', task: String(row.id), text: summary })
  }
  if (row.artifacts_json) {
    let labels = []
    try {
      const parsed = JSON.parse(row.artifacts_json)
      labels = Array.isArray(parsed) ? parsed.map(item => String(item?.label ?? item?.path ?? '')) : []
    } catch { labels = [] }
    for (const label of labels) taskFieldTexts.push({ unit: 'artifact.label', task: String(row.id), text: label })
  }
}
const renderedTexts = messageRows.map(row => ({ unit: `messages.${row.kind}`, task: String(row.task_id), seq: Number(row.seq), text: String(row.rendered ?? '') }))

// R3: browser-visible text, de-duplicated per trimmed line.
const pageTexts = []
for (const flow of drive.flows ?? []) pageTexts.push({ unit: `pageText:${flow.key}`, text: String(flow.pageText ?? '') })
if (typeof drive.panelText === 'string') pageTexts.push({ unit: 'panelText', text: drive.panelText })
const browserLines = new Map()
for (const item of pageTexts) {
  for (const line of item.text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (!browserLines.has(trimmed)) browserLines.set(trimmed, [])
    if (!browserLines.get(trimmed).includes(item.unit)) browserLines.get(trimmed).push(item.unit)
  }
}

const summarize = units => {
  const real = []
  const template = []
  for (const item of units) {
    const realIds = idsReal(item.text)
    if (realIds.length > 0) real.push({ unit: item.unit, task: item.task ?? null, cls: item.cls ?? null, count: realIds.length, ids: [...new Set(realIds)], snippet: String(item.text).slice(0, 400) })
    const anyIds = idsAny(item.text)
    const nonReal = anyIds.filter(id => !realIds.includes(id))
    if (nonReal.length > 0) template.push({ unit: item.unit, task: item.task ?? null, cls: item.cls ?? null, ids: [...new Set(nonReal)], snippet: String(item.text).slice(0, 300) })
  }
  return {
    units: units.length,
    realHits: real.reduce((sum, item) => sum + item.count, 0),
    realHitUnits: real.length,
    templateHits: template.reduce((sum, item) => sum + item.ids.length, 0),
    templateHitUnits: template.length,
    samples: real.slice(0, 12),
    templateSamples: template.slice(0, 8),
  }
}

const replyUnits = (() => {
  // U1 = mock 的每次 text 决策（= 主会话里逐条显示的回复）。请求体只能看到「被后续请求带上」的历史，
  // 最后一轮回复不会出现在任何请求里，所以以 decisions 为准，与请求体取并集去重。
  const ordered = []
  const seen = new Set()
  for (const item of decisions) {
    if (item.kind !== 'coordinator') continue
    const text = item.decision?.text
    if (typeof text !== 'string' || text.trim() === '') continue
    if (seen.has(text)) continue
    seen.add(text)
    ordered.push({ unit: 'coordinator.reply', at: item.at, text })
  }
  for (const item of assistantTexts.values()) {
    if (seen.has(item.text)) continue
    seen.add(item.text)
    ordered.push({ unit: 'coordinator.reply', at: item.at, text: item.text })
  }
  return ordered
})()
const userUnits = [...userTexts.values()].map(item => ({ unit: `session.user.${item.cls}`, ...item }))
const notificationUnits = userUnits.filter(item => item.cls === 'task-notification')
const promptUnits = userUnits.filter(item => item.cls === 'typed-prompt')
const instructionUnits = userUnits.filter(item => ['system-reminder', 'policy', 'other'].includes(item.cls))
const browserUnits = [...browserLines.entries()].map(([text, units]) => ({ unit: `browser:${units.join(',')}`, text }))

const visibleUnits = [...replyUnits, ...notificationUnits, ...renderedTexts, ...taskFieldTexts]
const referenceUnits = [...visibleUnits, ...promptUnits, ...instructionUnits, ...browserUnits]

const visible = summarize(visibleUnits)
const reference = summarize(referenceUnits)
const detail = {
  coordinatorReplies: summarize(replyUnits),
  notifications: summarize(notificationUnits),
  ledgerRendered: summarize(renderedTexts),
  ledgerTaskFields: summarize(taskFieldTexts),
  typedPrompts: summarize(promptUnits),
  systemInstructionTexts: summarize(instructionUnits),
  browserText: summarize(browserUnits),
}

// Root-cause surface: bare ids inside the model context (tool results / user-side text).
const contextScan = []
for (const request of requests) {
  const body = bodyOf(request)
  const texts = [
    ...toolResultTexts(body).map(text => ({ source: 'tool_result', text })),
    ...textsOfBlocks(blocksOf(body).flatMap(item => (item.role === 'user' ? item.blocks : []))).map(text => ({ source: 'user_text', text })),
  ]
  for (const item of texts) {
    const realIds = idsReal(item.text)
    if (realIds.length === 0) continue
    contextScan.push({ kind: request.kind, source: item.source, ids: [...new Set(realIds)], snippet: item.text.slice(0, 300) })
  }
}
const bareTemplateScan = []
for (const request of requests) {
  const body = bodyOf(request)
  for (const text of textsOfBlocks(blocksOf(body).flatMap(item => (item.role === 'user' ? item.blocks : [])))) {
    const found = idsAny(text).filter(id => !/^t-[0-9a-f]{8}$/.test(id))
    if (found.length > 0) bareTemplateScan.push({ kind: request.kind, ids: [...new Set(found)], snippet: text.slice(0, 200) })
  }
}

const taskIdArgs = requests.flatMap(request => toolUseInputs(bodyOf(request))
  .filter(use => ['task_create', 'task_message', 'task_status', 'task_detail', 'plan_save', 'task_list'].includes(use.name))
  .map(use => ({ kind: request.kind, tool: use.name, value: typeof use.input?.task_id === 'string' ? use.input.task_id : null })))
const taskIdForms = taskIdArgs.filter(item => item.value !== null).reduce((acc, item) => {
  const form = item.value.startsWith('tk-') ? 'tk-' : (item.value.startsWith('t-') ? 't-' : 'other')
  acc[form] = (acc[form] ?? 0) + 1
  return acc
}, {})

const deliveredHints = coordinatorRequests.flatMap(request => blocksOf(bodyOf(request))
  .filter(item => item.role === 'user')
  .flatMap(item => textsOfBlocks(item.blocks))
  .filter(text => text.includes('交付确认')))
const deliveredHintSamples = [...new Set(deliveredHints)].map(text => ({
  hasTaskRef: /\btk-[0-9a-z]{6}\b/.test(text),
  line: (text.match(/交付确认：[^\n]*/) ?? [''])[0].slice(0, 220),
}))

const evidence = {
  generatedAt: new Date().toISOString(),
  environment: { artifacts: OUT, home: HOME, url: drive.url },
  flows: (drive.flows ?? []).map(flow => ({
    key: flow.key,
    title: flow.title,
    finalReplyVisible: flow.steps?.find(step => step.name === 'final-reply-visible')?.ok === true,
    task: flow.task === null ? null : { id: flow.task.id, status: flow.task.status, ref: flow.task.ref, messages: flow.task.messages?.length, question: flow.task.question },
    taskDone: flow.taskDone === true,
    pageTextRealIds: [...new Set(idsReal(flow.pageText))],
    pageTextAnyIds: [...new Set(idsAny(flow.pageText))],
  })),
  ledger: {
    tasks: taskRows.map(row => ({ id: String(row.id), title: String(row.title), status: String(row.status), ref: row.ref ?? null })),
    messages: messageRows.length,
    notifications: notificationRows.length,
    taskRefsPresent: taskRows.every(row => typeof row.ref === 'string' && row.ref.startsWith('tk-')),
  },
  leakage: { visible, reference, detail },
  contextScan: { realIdOccurrences: contextScan.length, samples: contextScan.slice(0, 10), templateOccurrences: bareTemplateScan.length, templateIds: [...new Set(bareTemplateScan.flatMap(item => item.ids))], templateSamples: bareTemplateScan.slice(0, 3) },
  taskIdArgForms: taskIdForms,
  deliveredHints: { total: deliveredHints.length, unique: deliveredHintSamples.length, samples: deliveredHintSamples.slice(0, 8), withoutRef: deliveredHintSamples.filter(item => !item.hasTaskRef).length },
  replies: replyUnits.map(item => ({ at: item.at ?? null, text: item.text })),
  notifications: notificationUnits.map(item => ({ text: item.text })),
  decisions: decisions.map(item => ({ kind: item.kind, decision: item.decision })),
}
mkdirSync(join(REPORT, 'evidence'), { recursive: true })
writeFileSync(join(REPORT, 'evidence/id-leakage.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')

console.log(JSON.stringify({
  flows: evidence.flows,
  visibleLeakage: { units: visible.units, realHits: visible.realHits, realHitUnits: visible.realHitUnits, templateHits: visible.templateHits, templateSamples: visible.templateSamples },
  referenceLeakage: { units: reference.units, realHits: reference.realHits, templateHits: reference.templateHits, templateSamples: reference.templateSamples },
  detail,
  contextScan: evidence.contextScan,
  taskIdArgForms: taskIdForms,
  deliveredHints: { total: deliveredHints.length, unique: deliveredHintSamples.length, withoutRef: evidence.deliveredHints.withoutRef },
  taskRefsPresent: evidence.ledger.taskRefsPresent,
}, null, 2))
