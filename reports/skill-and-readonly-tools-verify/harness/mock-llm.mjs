// Minimal Anthropic-Messages-compatible mock used to drive a throwaway DSH Web instance for
// 0.26.0 verification (skills + read-only tool surface + progress notifications).
//
// It records every request body (tools / system / messages) so the harness can assert the running
// agent's tool table, system prompt and tool results, and answers with scripted text / tool_use blocks.
//
// Scenarios are keyed by the coordinator prompt text (CHECK_TOOLS / READ_TESTS / DISPATCH_RO / …) and
// by markers in the worker brief title (`SCN=…`). Everything is decided from the message history, so a
// notification queued mid-turn does not derail a scenario.
import { createServer } from 'node:http'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PORT = Number(process.env.MOCK_PORT ?? 47223)
const OUT = process.env.MOCK_OUT ?? 'C:/Users/72489/AppData/Local/Temp/orch-e2e-026/artifacts/mock'
const REQUESTS = join(OUT, 'requests.jsonl')
const SUMMARY = join(OUT, 'summary.jsonl')
const DECISIONS = join(OUT, 'decisions.jsonl')
mkdirSync(OUT, { recursive: true })

const SKILL_PATH = process.env.MOCK_SKILL_PATH ?? ''
const ARTIFACT_PATH = process.env.MOCK_ARTIFACT_PATH ?? ''
const TARGETS = {
  ro: process.env.MOCK_TARGET_RO ?? '',
  normal: process.env.MOCK_TARGET_NORMAL ?? '',
  progress: process.env.MOCK_TARGET_PROGRESS ?? '',
  done: process.env.MOCK_TARGET_DONE ?? '',
  blocked: process.env.MOCK_TARGET_BLOCKED ?? '',
  auth: process.env.MOCK_TARGET_AUTH ?? '',
  full: process.env.MOCK_TARGET_FULL ?? '',
}
const OUTSIDE_PATH = process.env.MOCK_OUTSIDE_PATH ?? ''

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const textOf = blocks => {
  if (!Array.isArray(blocks)) return ''
  return blocks.filter(b => b && b.type === 'text').map(b => String(b.text ?? '')).join('\n')
}
const messagesOf = body => Array.isArray(body?.messages) ? body.messages : []
const lastUserTextOf = body => {
  const messages = messagesOf(body)
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const content = messages[i]?.content
    if (!Array.isArray(content)) continue
    if (content.some(b => b && b.type === 'tool_result')) continue
    const text = textOf(content).trim()
    if (text !== '') return text
  }
  return ''
}
const toolUsesOf = body => {
  const out = []
  for (const message of messagesOf(body)) {
    const content = Array.isArray(message?.content) ? message.content : []
    for (const block of content) {
      if (block && block.type === 'tool_use') out.push({ name: block.name, input: block.input ?? {} })
    }
  }
  return out
}
const toolResultsOf = body => {
  const out = []
  for (const message of messagesOf(body)) {
    const content = Array.isArray(message?.content) ? message.content : []
    for (const block of content) {
      if (block && block.type === 'tool_result') {
        const text = Array.isArray(block.content)
          ? block.content.map(item => item?.text ?? '').join('\n')
          : String(block.content ?? '')
        out.push({ toolUseId: block.tool_use_id, text })
      }
    }
  }
  return out
}
const schemaProps = (body, name) => {
  const tools = Array.isArray(body?.tools) ? body.tools : []
  const tool = tools.find(item => item?.name === name)
  return Object.keys(tool?.input_schema?.properties ?? tool?.inputSchema?.properties ?? {})
}
const pickProp = (props, patterns, fallback) => patterns.map(p => props.find(k => p.test(k))).find(Boolean) ?? fallback
const readInputOf = (body, filePath) => {
  const props = schemaProps(body, 'read')
  const key = pickProp(props, [/^file_path$/, /path|file/i], 'file_path')
  return { [key]: filePath }
}
const skillInputOf = (body, name) => {
  const props = schemaProps(body, 'skill')
  const key = pickProp(props, [/^name$/, /name|skill/i], 'name')
  return { [key]: name }
}
const taskIdOf = body => {
  const text = JSON.stringify(messagesOf(body))
  const inBrief = /t-[0-9a-f]{8}/.exec(text)
  if (inBrief) return inBrief[0]
  const any = /t-[0-9a-f]{8}/.exec(JSON.stringify(body))
  return any?.[0]
}
const scenarioOf = body => {
  // The SCN marker lives in the brief (title), which may be past the first messages: scan all of them.
  const text = JSON.stringify(messagesOf(body))
  return /SCN=([a-z-]+)/.exec(text)?.[1]
}
const reportInput = (body, status, summary, extra = {}) => ({
  ...(taskIdOf(body) === undefined ? {} : { task_id: taskIdOf(body) }),
  status,
  summary,
  ...extra,
})
const writeInput = (body, target, name, content) => {
  const props = schemaProps(body, 'write')
  const pathKey = pickProp(props, [/^path$/, /path|file/i], 'path')
  const contentKey = pickProp(props, [/^content$/, /content|text/i], 'content')
  return { [pathKey]: `${target}/${name}`, [contentKey]: content }
}
const writeAbsInput = (body, absPath, content) => {
  const props = schemaProps(body, 'write')
  const pathKey = pickProp(props, [/^path$/, /path|file/i], 'path')
  const contentKey = pickProp(props, [/^content$/, /content|text/i], 'content')
  return { [pathKey]: absPath, [contentKey]: content }
}
// Keep a worker turn alive (a task that only reported progress and then ends its turn is settled as
// orphaned, so a follow-up would no longer reach a running task). todo_write is side-effect free.
const keepAlive = async (delayMs = 500) => {
  await sleep(delayMs)
  return { kind: 'tool', name: 'todo_write', input: { todos: [{ content: '等待协调者追问', status: 'in_progress' }] } }
}
const toolUseCount = (body, name, predicate = () => true) => toolUsesOf(body).filter(item => item.name === name && predicate(item.input)).length
const hasToolUse = (body, name, predicate = () => true) => toolUseCount(body, name, predicate) > 0

// —— coordinator ——
const COORDINATOR_KEYWORDS = ['CHECK_TOOLS', 'READ_TESTS', 'DISPATCH_RO', 'DISPATCH_NORMAL', 'DISPATCH_PROGRESS', 'DISPATCH_DONE', 'DISPATCH_BLOCKED', 'DISPATCH_NEEDS_AUTH', 'DISPATCH_FULL', 'FOLLOWUP', 'AFTER_SWITCH']

function coordinatorDecide(body) {
  const last = lastUserTextOf(body)
  const keyword = COORDINATOR_KEYWORDS.find(item => last.includes(item))
  if (keyword === 'CHECK_TOOLS') return { kind: 'text', text: 'READY-COORDINATOR' }
  if (keyword === 'READ_TESTS') {
    const readCalls = toolUsesOf(body).filter(item => item.name === 'read')
    if (!readCalls.some(item => Object.values(item.input ?? {}).some(v => String(v) === ARTIFACT_PATH))) {
      return { kind: 'tool', name: 'read', input: readInputOf(body, ARTIFACT_PATH) }
    }
    if (!readCalls.some(item => Object.values(item.input ?? {}).some(v => String(v) === SKILL_PATH))) {
      return { kind: 'tool', name: 'read', input: readInputOf(body, SKILL_PATH) }
    }
    if (!hasToolUse(body, 'skill')) return { kind: 'tool', name: 'skill', input: skillInputOf(body, 'grill-me') }
    return { kind: 'text', text: 'READ_OK' }
  }
  if (keyword === 'DISPATCH_RO' || keyword === 'DISPATCH_NORMAL' || keyword === 'DISPATCH_PROGRESS' || keyword === 'DISPATCH_DONE' || keyword === 'DISPATCH_BLOCKED' || keyword === 'DISPATCH_NEEDS_AUTH' || keyword === 'DISPATCH_FULL') {
    const scenario = {
      DISPATCH_RO: { scn: 'readonly-deny', target: TARGETS.ro, title: 'E2E 只读写拒绝', readOnly: true, goal: '在 target 写文件，预期被只读沙箱拒绝' },
      DISPATCH_NORMAL: { scn: 'normal-write', target: TARGETS.normal, title: 'E2E 普通写文件', readOnly: false, goal: '在 target 写一个普通文件，证明 workspace-write 生效' },
      DISPATCH_PROGRESS: { scn: 'progress', target: TARGETS.progress, title: 'E2E 进度通知', readOnly: false, goal: '连续 task_report(progress)，验证合并窗口/水位/追问必达' },
      DISPATCH_DONE: { scn: 'done', target: TARGETS.done, title: 'E2E done 分级', readOnly: false, goal: '报 done，验证 notify 分级 5 秒合并窗口' },
      DISPATCH_BLOCKED: { scn: 'blocked', target: TARGETS.blocked, title: 'E2E blocked 分级', readOnly: false, goal: '报 blocked，验证 interrupt 立即送达' },
      DISPATCH_NEEDS_AUTH: { scn: 'needs-auth', target: TARGETS.auth, title: 'E2E needs_auth 分级', readOnly: false, goal: '报 needs_auth，验证 interrupt 立即送达' },
      DISPATCH_FULL: { scn: 'full-write', target: TARGETS.full, title: 'E2E 完整访问写盘', readOnly: false, access: 'full', goal: '在 target 之外写文件，验证 danger-full-access 沙箱语义' },
    }[keyword]
    if (!hasToolUse(body, 'task_create', input => String(input?.title ?? '').includes(`SCN=${scenario.scn}`))) {
      return {
        kind: 'tool',
        name: 'task_create',
        input: {
          title: `${scenario.title} SCN=${scenario.scn}`,
          // The SCN marker also goes into the goal: the worker brief carries the goal text (the title
          // alone does not reach the child), and the mock keys worker behavior on it.
          goal: `${scenario.goal}｜SCN=${scenario.scn}`,
          acceptance: ['场景脚本按预期回报'],
          target: scenario.target,
          user_verbatim: 'E2E mock 派发',
          ...(scenario.readOnly ? { readOnly: true } : {}),
          ...(scenario.access === undefined ? {} : { access: scenario.access }),
        },
      }
    }
    return { kind: 'text', text: 'DISPATCHED' }
  }
  if (keyword === 'FOLLOWUP') {
    if (!hasToolUse(body, 'task_message')) {
      // The progress task id: scan task_create tool results for the one whose title contains SCN=progress.
      const created = []
      const messages = messagesOf(body)
      let pendingTitle = null
      for (const message of messages) {
        const content = Array.isArray(message?.content) ? message.content : []
        for (const block of content) {
          if (block?.type === 'tool_use' && block.name === 'task_create') pendingTitle = String(block.input?.title ?? '')
          if (block?.type === 'tool_result' && pendingTitle !== null) {
            const resultText = Array.isArray(block.content) ? block.content.map(item => item?.text ?? '').join('\n') : String(block.content ?? '')
            const id = /t-[0-9a-f]{8}/.exec(resultText)?.[0]
            if (id !== undefined) created.push({ title: pendingTitle, id })
            pendingTitle = null
          }
        }
      }
      const progressTask = created.find(item => item.title.includes('SCN=progress'))
      if (progressTask === undefined) return { kind: 'text', text: 'FOLLOWUP-NO-TASK' }
      return { kind: 'tool', name: 'task_message', input: { action: 'message', task_id: progressTask.id, message: '先给部分结论：现在卡在哪、已经完成了什么，再继续跑。' } }
    }
    return { kind: 'text', text: 'FOLLOWED_UP' }
  }
  if (keyword === 'AFTER_SWITCH') return { kind: 'text', text: 'AFTER-SWITCH-READY' }
  if (last.includes('任务「')) return { kind: 'text', text: 'NOTED-NOTIFICATION' }
  return { kind: 'text', text: 'READY' }
}

// —— worker ——
async function workerDecide(body) {
  // The brief is pointer-only (T1): it carries the task id, not the goal. A real worker starts by
  // calling task_detail; the mock does the same, and the detail text (which carries the SCN marker)
  // then keys the scripted scenario.
  const scenario = scenarioOf(body)
  if (scenario === undefined) {
    if (!hasToolUse(body, 'task_detail')) return { kind: 'tool', name: 'task_detail', input: { task_id: taskIdOf(body) } }
    return { kind: 'text', text: 'NO-SCENARIO' }
  }
  const last = lastUserTextOf(body)
  const done = hasToolUse(body, 'task_report')
  const reports = toolUseCount(body, 'task_report')
  if (scenario === 'normal-write') {
    if (!hasToolUse(body, 'write')) return { kind: 'tool', name: 'write', input: writeInput(body, TARGETS.normal, 'worker-ok.txt', 'written-by-worker\n') }
    if (!done) return { kind: 'tool', name: 'task_report', input: reportInput(body, 'done', '普通任务：worker-ok.txt 已写入（workspace-write 生效）。') }
    return { kind: 'text', text: 'DONE-NORMAL' }
  }
  if (scenario === 'readonly-deny') {
    if (!hasToolUse(body, 'skill')) return { kind: 'tool', name: 'skill', input: skillInputOf(body, 'grill-me') }
    if (!hasToolUse(body, 'write')) return { kind: 'tool', name: 'write', input: writeInput(body, TARGETS.ro, 'ro-blocked.txt', 'should-not-exist\n') }
    if (!done) return { kind: 'tool', name: 'task_report', input: reportInput(body, 'done', '只读任务：skill 与 write 均被拒（见前面工具结果）。') }
    return { kind: 'text', text: 'DONE-READONLY' }
  }
  if (scenario === 'full-write') {
    if (!hasToolUse(body, 'write')) return { kind: 'tool', name: 'write', input: writeAbsInput(body, OUTSIDE_PATH, 'written-by-full-access\n') }
    if (!done) return { kind: 'tool', name: 'task_report', input: reportInput(body, 'done', '完整访问任务：target 之外的文件已写入（danger-full-access）。') }
    return { kind: 'text', text: 'DONE-FULL' }
  }
  if (scenario === 'progress') {
    // The steer message is appended to the history, but later per-step system-reminder messages may be
    // the *last* user text — scan the whole history for the follow-up phrase instead of the last block.
    const followUp = JSON.stringify(messagesOf(body)).includes('先给部分结论')
    const answered = hasToolUse(body, 'task_report', input => String(input?.summary ?? '').includes('追问答复'))
    if (followUp && !answered) {
      return { kind: 'tool', name: 'task_report', input: reportInput(body, 'progress', '追问答复：已完成一半，剩下的是收尾（answeredFollowup 验证）。') }
    }
    if (followUp && answered) return keepAlive(3000)
    // 子会话不能自己结束回合：只报过 progress 就结束会被结算判 orphaned（tasks 会离开 running，
    // 追问就落不到「运行中任务」上）。用无副作用的 todo_write 把回合吊住，等 steer 追问插进来。
    if (reports === 0) return { kind: 'tool', name: 'task_report', input: reportInput(body, 'progress', '进度 1/2：环境已就绪') }
    if (reports === 1) {
      // 等过第一次 5 s 合并窗口（p1 已单独送达），再在（测试缩短到 3 s 的）水位窗口内报 p2：
      // 这一条会被 watermark 压住并到尾沿补投，正好验证「压住也留 audit 行 + 最终补投」。
      await sleep(Number(process.env.MOCK_P2_DELAY_MS ?? 6000))
      return { kind: 'tool', name: 'task_report', input: reportInput(body, 'progress', '进度 2/2：正在写代码（水位窗口内）') }
    }
    return keepAlive()
  }
  if (scenario === 'done') {
    if (!done) return { kind: 'tool', name: 'task_report', input: reportInput(body, 'done', 'done 分级验证：立即交付。') }
    return { kind: 'text', text: 'DONE-DONE' }
  }
  if (scenario === 'blocked') {
    if (!done) return { kind: 'tool', name: 'task_report', input: reportInput(body, 'blocked', 'blocked 分级验证：需要拍板。', { question: '选哪个方案？', options: ['方案A', '方案B'] }) }
    return { kind: 'text', text: 'DONE-BLOCKED' }
  }
  if (scenario === 'needs-auth') {
    if (!done) return { kind: 'tool', name: 'task_report', input: reportInput(body, 'needs_auth', 'needs_auth 分级验证：需要授权。', { question: '是否允许访问外部服务？', options: ['允许', '不允许'] }) }
    return { kind: 'text', text: 'DONE-AUTH' }
  }
  return { kind: 'text', text: 'NO-SCENARIO' }
}

// —— SSE ——
const sse = res => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
}
let seq = 0
const nextId = () => `msg_mock_${++seq}_${Date.now()}`

function sendText(res, text) {
  const id = nextId()
  sse(res)
  const write = (event, data) => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) }
  write('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'mock', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } })
  write('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  write('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
  write('content_block_stop', { type: 'content_block_stop', index: 0 })
  write('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: Math.max(1, text.length) } })
  write('message_stop', { type: 'message_stop' })
  res.end()
}

function sendToolUse(res, name, input) {
  const id = nextId()
  const toolId = `toolu_mock_${++seq}`
  const json = JSON.stringify(input)
  sse(res)
  const write = (event, data) => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) }
  write('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'mock', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } })
  write('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: toolId, name, input: {} } })
  write('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: json } })
  write('content_block_stop', { type: 'content_block_stop', index: 0 })
  write('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } })
  write('message_stop', { type: 'message_stop' })
  res.end()
}

const systemTextOf = body => {
  const system = body?.system
  if (typeof system === 'string') return system
  if (Array.isArray(system)) return system.map(b => typeof b === 'string' ? b : (b?.text ?? '')).join('\n')
  return ''
}
// The skill catalog is injected as a durable user message (system-reminder with <available_skills>),
// not as part of body.system — scan the message history for the latest catalog block.
const catalogSkillsOf = body => {
  let catalog = ''
  for (const message of messagesOf(body)) {
    const content = Array.isArray(message?.content) ? message.content : []
    for (const block of content) {
      const text = String(block?.text ?? '')
      if (text.includes('<available_skills>')) catalog = text
    }
  }
  const names = []
  for (const match of catalog.matchAll(/^- `([a-z0-9-]+)`:/gm)) names.push(match[1])
  return { catalog: catalog !== '', names }
}

const server = createServer((req, res) => {
  const chunks = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', async () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    let body
    try { body = JSON.parse(raw) } catch { body = undefined }
    if (req.method === 'POST' && body !== undefined) {
      const tools = (Array.isArray(body?.tools) ? body.tools : []).map(t => t?.name).filter(Boolean)
      const isCoordinator = tools.includes('schedule_create') && tools.includes('task_create')
      const isWorker = tools.includes('write') && tools.includes('task_report')
      const last = lastUserTextOf(body)
      const catalog = catalogSkillsOf(body)
      const record = {
        at: new Date().toISOString(),
        path: req.url,
        kind: isCoordinator ? 'coordinator' : (isWorker ? 'worker' : 'other'),
        scn: scenarioOf(body),
        toolResult: Array.isArray(body?.messages) && body.messages.some(m => Array.isArray(m?.content) && m.content.some(b => b?.type === 'tool_result')),
        toolNames: tools,
        trigger: last.slice(0, 300),
        catalogSkills: catalog.names,
        catalogHasGrillMe: catalog.names.includes('grill-me'),
        catalogRaw: catalog.catalog,
        systemLength: systemTextOf(body).length,
      }
      try { appendFileSync(REQUESTS, JSON.stringify({ ...record, body }) + '\n') } catch {}
      try { appendFileSync(SUMMARY, JSON.stringify(record) + '\n') } catch {}
      const plan = {
        kind: isCoordinator ? 'coordinator' : (isWorker ? 'worker' : 'other'),
        scn: scenarioOf(body),
        at: record.at,
        toolResult: record.toolResult,
      }
      let decision
      try {
        decision = isCoordinator ? coordinatorDecide(body) : (isWorker ? await workerDecide(body) : { kind: 'text', text: 'OTHER' })
      } catch (error) {
        decision = { kind: 'text', text: `MOCK-ERROR: ${error?.message ?? error}` }
      }
      try {
        appendFileSync(DECISIONS, JSON.stringify({
          ...plan,
          decision: decision.kind === 'tool'
            ? { name: decision.name, status: decision.input?.status ?? null, summary: decision.input?.summary ?? null, title: decision.input?.title ?? null, taskId: decision.input?.task_id ?? null }
            : { name: null, text: decision.text },
        }) + '\n')
      } catch {}
      if (decision.kind === 'tool') sendToolUse(res, decision.name, decision.input)
      else sendText(res, decision.text)
      return
    }
    if (req.method === 'GET' && /\/models/.test(req.url ?? '')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not found"}')
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock-llm listening on ${PORT}, out=${OUT}`)
})
