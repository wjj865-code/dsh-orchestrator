// Minimal Anthropic-Messages-compatible mock used to drive a throwaway DSH Web instance.
// Records every request body (tools/system/messages) so the test can assert the running
// agent's tool table, and answers with scripted text / tool_use blocks.
import { createServer } from 'node:http'
import { appendFileSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const PORT = Number(process.env.MOCK_PORT ?? 47123)
const OUT = process.env.MOCK_OUT ?? 'C:/Users/72489/AppData/Local/Temp/orch-e2e-artifacts/mock'
const REQUESTS = join(OUT, 'requests.jsonl')
const SUMMARY = join(OUT, 'summary.jsonl')

const lastText = blocks => {
  if (!Array.isArray(blocks)) return ''
  return blocks.filter(b => b && b.type === 'text').map(b => String(b.text ?? '')).join('\n')
}
const requestOf = body => {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const last = messages[messages.length - 1]
  const content = Array.isArray(last?.content) ? last.content : [{ type: 'text', text: String(last?.content ?? '') }]
  return {
    role: last?.role,
    text: lastText(content),
    toolResult: content.some(b => b && b.type === 'tool_result'),
    toolNames: (Array.isArray(body?.tools) ? body.tools : []).map(t => t?.name).filter(Boolean),
  }
}

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

const TARGET = process.env.MOCK_TARGET ?? 'C:/Users/72489/AppData/Local/Temp/orch-e2e-artifacts/task-target'

const schemaProps = (body, name) => {
  const tool = (Array.isArray(body?.tools) ? body.tools : []).find(t => t?.name === name)
  return Object.keys(tool?.input_schema?.properties ?? tool?.inputSchema?.properties ?? {})
}
const writeInput = body => {
  const props = schemaProps(body, 'write')
  const pathKey = props.find(p => /path|file/i.test(p)) ?? 'path'
  const contentKey = props.find(p => /content|text/i.test(p)) ?? 'content'
  return { [pathKey]: `${TARGET}/e2e-child.txt`, [contentKey]: 'written-by-e2e-child\n' }
}
const taskIdOf = body => {
  const match = /t-[0-9a-f]{8}/.exec(JSON.stringify(body))
  return match?.[0]
}
const reportInput = body => ({
  ...(taskIdOf(body) === undefined ? {} : { task_id: taskIdOf(body) }),
  status: 'done',
  summary: 'E2E mock：文件已写入（workspace-write 生效）。',
})

const alreadyReported = body => {
  const msgs = Array.isArray(body?.messages) ? body.messages : []
  return msgs.some(m => Array.isArray(m?.content) && m.content.some(b => b && b.type === 'tool_use' && b.name === 'task_report'))
}
const alreadyWrote = body => {
  const msgs = Array.isArray(body?.messages) ? body.messages : []
  return msgs.some(m => Array.isArray(m?.content) && m.content.some(b => b && b.type === 'tool_use' && b.name === 'write'))
}

function decide(body) {
  const info = requestOf(body)
  const tools = info.toolNames
  // The coordinator preset keeps schedule_* + ask_user_question; the worker preset keeps the
  // file/shell tools + task_report and drops the schedule surface.
  const hasCoordinator = tools.includes('schedule_create') && tools.includes('task_create')
  const hasWorker = !hasCoordinator && tools.includes('write') && tools.includes('task_report')
  if (info.toolResult) {
    // A tool result came back. For the worker, finish; for the coordinator, acknowledge.
    if (hasWorker) {
      if (alreadyReported(body)) return { kind: 'text', text: 'DONE: 文件已写入，任务已回报。' }
      return { kind: 'tool', name: 'task_report', input: reportInput(body) }
    }
    return { kind: 'text', text: 'NOTED' }
  }
  if (hasWorker) {
    if (alreadyWrote(body)) return { kind: 'text', text: 'DONE: 文件已写入。' }
    // Turn 1 of a worker: ask it to write a file under its target directory.
    return { kind: 'tool', name: tools.includes('write') ? 'write' : 'apply_patch', input: writeInput(body) }
  }
  if (hasCoordinator && /DISPATCH_NOW/.test(info.text)) {
    const nonce = process.hrtime.bigint().toString().slice(-6)
    return {
      kind: 'tool',
      name: 'task_create',
      input: {
        title: `E2E 子会话写文件 ${nonce}`,
        goal: `在 target 目录写一个文件（${nonce}），证明 workspace-write 生效`,
        acceptance: ['e2e-child.txt 存在且内容为 written-by-e2e-child'],
        target: TARGET,
        user_verbatim: 'E2E mock 派发',
      },
    }
  }
  return { kind: 'text', text: 'READY' }
}

const server = createServer((req, res) => {
  const chunks = []
  req.on('data', c => chunks.push(c))
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    let body
    try { body = JSON.parse(raw) } catch { body = undefined }
    if (req.method === 'POST' && body !== undefined) {
      const info = requestOf(body)
      const record = { at: new Date().toISOString(), path: req.url, role: info.role, toolResult: info.toolResult, toolNames: info.toolNames, text: info.text.slice(0, 400) }
      try { appendFileSync(REQUESTS, JSON.stringify({ ...record, body }) + '\n') } catch {}
      try { appendFileSync(SUMMARY, JSON.stringify(record) + '\n') } catch {}
      const decision = decide(body)
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
