// Anthropic-Messages-compatible mock for the ID-leakage spot check (版本 B《ID 出口网关》).
//
// Drives one throwaway DSH Web instance (isolated DSH_HOME + `lkweb` profile + mock model) through
// 4 real task flows:
//   LEAK_A 普通任务 → 交付 → 追问（task_message）→ 二次交付 → close
//   LEAK_B 只读任务 → 读取 target → 交付 → close
//   LEAK_C blocked（带问题/选项）→ 协调者拍板续派 → 交付 → close
//   LEAK_D 连续 progress → 交付 → close
//
// 关键点（泄漏率口径的根因面）：mock 扮演的是一个「不老实」的模型——它会把**自己上下文里**看得到的
// 真实台账编号（`t-` + 8 位十六进制）原样抄进给用户的回复 / task_report 的 summary。所以：
//   - 用户可见文本里如果出现裸 t-xxxx，说明编号真的漏到了模型手里（gateway 失效）；
//   - 反之，说明模型全程只拿到 `tk-` 引用，抄不出内部编号。
// 记录每个请求的：kind（coordinator/worker）、flow、上下文里的真实编号、brief/回执文本、决策。
import { createServer } from 'node:http'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const PORT = Number(process.env.MOCK_PORT ?? 47331)
const OUT = process.env.MOCK_OUT ?? 'C:/Users/72489/AppData/Local/Temp/orch-leak/mock'
const TARGETS = {
  a: process.env.MOCK_TARGET_A ?? '',
  b: process.env.MOCK_TARGET_B ?? '',
  c: process.env.MOCK_TARGET_C ?? '',
  d: process.env.MOCK_TARGET_D ?? '',
}
const FLOWS = {
  LEAK_A: { scn: 'leak-a', marker: '泄漏抽查 A', title: '说明文件编写（泄漏抽查 A）', goal: '在 target 写一个说明文件并回报；完成后等待追问，再补一条说明并再次交付。SCN=leak-a', target: TARGETS.a, acceptance: ['说明文件写入 target', '追问后补充说明并再次交付'], user: 'LEAK_A 帮我派一个普通任务：在 target 写一个说明文件，完成后追问一句再收掉。' },
  LEAK_B: { scn: 'leak-b', marker: '泄漏抽查 B', title: '只读核对（泄漏抽查 B）', goal: '只读任务：读 target 里的 note-a.md 并回报，不要写文件。SCN=leak-b', target: TARGETS.b, acceptance: ['读到说明文件内容'], readOnly: true, user: 'LEAK_B 派一个只读任务：读 target 里的说明文件并回报。' },
  LEAK_C: { scn: 'leak-c', marker: '泄漏抽查 C', title: '方案选择（泄漏抽查 C）', goal: '先报 blocked 给出问题与选项，等协调者拍板后按方案A完成。SCN=leak-c', target: TARGETS.c, acceptance: ['blocked 汇报问题', '按方案A完成后交付'], user: 'LEAK_C 派一个任务，让它报 blocked 等我拍板；我选方案A，然后收掉。' },
  LEAK_D: { scn: 'leak-d', marker: '泄漏抽查 D', title: '分阶段推进（泄漏抽查 D）', goal: '连续报两次 progress，再报 done 交付。SCN=leak-d', target: TARGETS.d, acceptance: ['两次 progress', '最终交付'], user: 'LEAK_D 派一个任务，让它连续报两次进度再交付。' },
}

mkdirSync(OUT, { recursive: true })
const REQUESTS = join(OUT, 'requests.jsonl')
const DECISIONS = join(OUT, 'decisions.jsonl')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const messagesOf = body => Array.isArray(body?.messages) ? body.messages : []
const blocksOf = body => messagesOf(body).flatMap(message => Array.isArray(message?.content) ? message.content : [])
const textOf = blocks => Array.isArray(blocks)
  ? blocks.filter(b => b && b.type === 'text').map(b => String(b.text ?? '')).join('\n')
  : ''
const systemTextOf = body => {
  const system = body?.system
  if (typeof system === 'string') return system
  if (Array.isArray(system)) return system.map(block => typeof block === 'string' ? block : (block?.text ?? '')).join('\n')
  return ''
}
const allTextOf = body => `${systemTextOf(body)}\n${JSON.stringify(messagesOf(body))}`
const lastUserTextOf = body => {
  const messages = messagesOf(body)
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const content = messages[i]?.content
    if (!Array.isArray(content)) continue
    if (content.some(block => block && block.type === 'tool_result')) continue
    const text = textOf(content).trim()
    if (text !== '') return text
  }
  return ''
}
const userTextsOf = body => messagesOf(body)
  .filter(message => message?.role === 'user')
  .flatMap(message => Array.isArray(message?.content) ? message.content : [])
  .filter(block => block?.type === 'text')
  .map(block => String(block.text ?? '').trim())
  .filter(Boolean)
const toolUsesOf = body => blocksOf(body).filter(block => block?.type === 'tool_use')
  .map(block => ({ name: block.name, input: block.input ?? {} }))
const toolResultsOf = body => blocksOf(body)
  .filter(block => block?.type === 'tool_result')
  .map(block => ({
    id: block.tool_use_id,
    text: Array.isArray(block.content) ? block.content.map(item => item?.text ?? '').join('\n') : String(block.content ?? ''),
  }))
const schemaProps = (body, name) => {
  const tool = (Array.isArray(body?.tools) ? body.tools : []).find(item => item?.name === name)
  return Object.keys(tool?.input_schema?.properties ?? tool?.inputSchema?.properties ?? {})
}
const pickProp = (props, patterns, fallback) => patterns.map(pattern => props.find(key => pattern.test(key))).find(Boolean) ?? fallback

// 真实台账编号形状（createTask 生成 t- + 8 位十六进制）；模板里的 `t-xxxx` 不算。
const REAL_ID_RE = /\bt-[0-9a-f]{8}\b/g
const REF_RE = /\btk-[0-9a-z]{6}\b/
const realIdsOf = text => [...new Set(String(text ?? '').match(REAL_ID_RE) ?? [])]
const refOf = text => REF_RE.exec(String(text ?? ''))?.[0] ?? null

const flowOf = text => {
  const hit = /LEAK_([A-D])/.exec(String(text ?? ''))
  return hit === null ? null : `LEAK_${hit[1]}`
}
// 协调者每轮都要按「最近一次用户提示」判场景：历史里的 LEAK_A 不能把后来的 LEAK_B/C/D 吞掉。
const latestFlowOf = body => {
  const texts = userTextsOf(body)
  for (let i = texts.length - 1; i >= 0; i -= 1) {
    const flow = flowOf(texts[i])
    if (flow !== null) return flow
  }
  return null
}
const flowByScn = scn => Object.entries(FLOWS).find(([, flow]) => flow.scn === scn)?.[0] ?? null

// 协调者看到的「任务创建回执」：把 task_create 的 title 与随后 tool_result 里的引用对上。
const receiptsOf = body => {
  const out = []
  let pendingTitle = null
  for (const block of blocksOf(body)) {
    if (block?.type === 'tool_use' && block.name === 'task_create') {
      pendingTitle = String(block.input?.title ?? '')
      continue
    }
    if (block?.type === 'tool_result' && pendingTitle !== null) {
      const text = Array.isArray(block.content)
        ? block.content.map(item => item?.text ?? '').join('\n')
        : String(block.content ?? '')
      out.push({ title: pendingTitle, text, ref: refOf(text), bareId: realIdsOf(text)[0] ?? null })
      pendingTitle = null
    }
  }
  return out
}
const notificationTexts = body => userTextsOf(body).filter(text => text.includes('任务「'))

// —— worker ——
const workerRefOf = body => {
  // brief 里固定是「【任务引用】tk-xxxxxx」（版本 B：只有 tk-）；W1 文案里的 `tk-xxxxxx` 是模板示例，
  // 所以只认 brief 那一行。裸编号只作兜底（记录并会被 echo 抄进 summary，正是要测的泄漏面）。
  const text = allTextOf(body)
  const fromBrief = /【任务引用】\s*(tk-[0-9a-z]{6})/.exec(text)?.[1]
  if (fromBrief !== undefined) return fromBrief
  return realIdsOf(text)[0] ?? null
}

async function workerDecide(body) {
  const scn = /SCN=([a-z-]+)/.exec(allTextOf(body))?.[1]
  const taskId = workerRefOf(body)
  const echo = realIdsOf(allTextOf(body)).join('、')
  const echoTail = echo === '' ? '' : `（备注：上下文里看到 ${echo}）`
  const reports = toolUsesOf(body).filter(use => use.name === 'task_report').length
  const followUp = JSON.stringify(messagesOf(body)).includes('请补一句')
  const approved = JSON.stringify(messagesOf(body)).includes('按方案A继续')
  const report = (status, summary, extra = {}) => ({
    kind: 'tool', name: 'task_report', input: { task_id: taskId, status, summary: `${summary}${echoTail}`, ...extra },
  })
  // brief 只有指针：真实 worker 先 task_detail 拿详情（SCN 标记在详情里）。
  if (scn === undefined) {
    if (!toolUsesOf(body).some(use => use.name === 'task_detail')) {
      return { kind: 'tool', name: 'task_detail', input: { task_id: taskId } }
    }
    return { kind: 'text', text: 'NO-SCENARIO' }
  }
  if (scn === 'leak-a') {
    if (!toolUsesOf(body).some(use => use.name === 'write') && !followUp) {
      const props = schemaProps(body, 'write')
      const pathKey = pickProp(props, [/^path$/, /path|file/i], 'path')
      const contentKey = pickProp(props, [/^content$/, /content|text/i], 'content')
      return { kind: 'tool', name: 'write', input: { [pathKey]: `${TARGETS.a}\\note-a.md`, [contentKey]: '# 说明文件\n\n这是泄漏抽查 A 写入的说明文字。\n' } }
    }
    if (!followUp && reports === 0) return report('done', '说明文件已写入 target（note-a.md）。')
    if (followUp && reports < 3) {
      await sleep(300)
      return report(reports === 1 ? 'progress' : 'done', reports === 1 ? '追问答复：说明文件是一段普通说明文字，正在补充。' : '追问答复：已补充说明并再次交付。')
    }
    return { kind: 'text', text: 'DONE-A' }
  }
  if (scn === 'leak-b') {
    if (!toolUsesOf(body).some(use => use.name === 'read')) {
      const props = schemaProps(body, 'read')
      const pathKey = pickProp(props, [/^file_path$/, /path|file/i], 'file_path')
      return { kind: 'tool', name: 'read', input: { [pathKey]: `${TARGETS.a}\\note-a.md` } }
    }
    if (reports === 0) return report('done', '只读任务：已读取说明文件，未写任何文件。')
    return { kind: 'text', text: 'DONE-B' }
  }
  if (scn === 'leak-c') {
    if (reports === 0) return report('blocked', '需要拍板：选择实现方案。', { question: '两个方案选哪个？', options: ['方案A', '方案B'] })
    if (approved && reports < 2) {
      await sleep(300)
      return report('done', '按方案A继续：已完成。')
    }
    return { kind: 'text', text: 'WAITING-C' }
  }
  if (scn === 'leak-d') {
    if (reports === 0) return report('progress', '进度 1/2：环境已就绪。')
    if (reports === 1) {
      await sleep(6000)
      return report('progress', '进度 2/2：正在收尾。')
    }
    if (reports === 2) {
      await sleep(6000)
      return report('done', '两次进度后交付：已完成。')
    }
    return { kind: 'text', text: 'DONE-D' }
  }
  return { kind: 'text', text: 'NO-SCENARIO' }
}

// —— coordinator ——
function coordinatorDecide(body) {
  const prompt = userTextsOf(body).reverse().find(text => /LEAK_[A-D]/.test(text)) ?? ''
  const flowKey = flowOf(prompt)
  const flow = flowKey === null ? null : FLOWS[flowKey]
  if (flow === null) return { kind: 'text', text: 'READY-COORDINATOR' }
  const creates = toolUsesOf(body).filter(use => use.name === 'task_create' && String(use.input?.title ?? '').includes(flow.marker))
  if (creates.length === 0) {
    return {
      kind: 'tool',
      name: 'task_create',
      input: {
        title: flow.title,
        goal: flow.goal,
        acceptance: flow.acceptance,
        target: flow.target,
        user_verbatim: flow.user,
        ...(flow.readOnly === true ? { readOnly: true } : {}),
      },
    }
  }
  const receipt = receiptsOf(body).find(item => item.title.includes(flow.marker))
  const taskRef = receipt?.ref ?? (receipt?.bareId ?? null)
  const messages = toolUsesOf(body).filter(use => use.name === 'task_message'
    && (taskRef === null || String(use.input?.task_id ?? '') === taskRef))
  const notifications = notificationTexts(body).filter(text => text.includes(flow.marker))
  const delivered = notifications.filter(text => text.includes('交付确认'))
  const blocked = notifications.filter(text => text.includes('需要你'))
  const echo = realIdsOf(allTextOf(body)).join('、')
  const echoTail = echo === '' ? '' : `（备注：上下文里看到 ${echo}）`
  const refText = taskRef ?? ''
  const say = text => ({ kind: 'text', text: `${text}${echoTail}` })
  if (flowKey === 'LEAK_A') {
    if (messages.length === 0 && delivered.length >= 1) {
      return { kind: 'tool', name: 'task_message', input: { action: 'message', task_id: taskRef, message: '请补一句你写入了什么，然后再次交付。' } }
    }
    if (messages.length === 1 && delivered.length >= 2) {
      return { kind: 'tool', name: 'task_message', input: { action: 'close', task_id: taskRef } }
    }
    if (messages.length === 2) return say(`已收尾：${flow.title}（${refText}）已完成。`)
    if (delivered.length === 0) return say(`已派发：${flow.title}（${refText}），等它交付后我追问一句再收尾。`)
    return say(`追问已发出：${flow.title}（${refText}），等它再交付。`)
  }
  if (flowKey === 'LEAK_B') {
    if (delivered.length >= 1 && messages.length === 0) {
      return { kind: 'tool', name: 'task_message', input: { action: 'close', task_id: taskRef } }
    }
    if (messages.length >= 1) return say(`已确认收尾：${flow.title}（${refText}）。`)
    return say(`已派发只读任务：${flow.title}（${refText}），它不会写文件。`)
  }
  if (flowKey === 'LEAK_C') {
    if (blocked.length >= 1 && messages.length === 0) {
      return { kind: 'tool', name: 'task_message', input: { action: 'message', task_id: taskRef, message: '按方案A继续。' } }
    }
    if (delivered.length >= 1 && messages.length === 1) {
      return { kind: 'tool', name: 'task_message', input: { action: 'close', task_id: taskRef } }
    }
    if (messages.length >= 2) return say(`已收尾：${flow.title}（${refText}）。`)
    if (blocked.length === 0) return say(`已派发：${flow.title}（${refText}），等它报阻塞。`)
    return say(`已拍板方案A：${flow.title}（${refText}）。`)
  }
  if (flowKey === 'LEAK_D') {
    if (delivered.length >= 1 && messages.length === 0) {
      return { kind: 'tool', name: 'task_message', input: { action: 'close', task_id: taskRef } }
    }
    if (messages.length >= 1) return say(`已收尾：${flow.title}（${refText}）。`)
    return say(`已派发：${flow.title}（${refText}），进度我会盯着。`)
  }
  return say('READY')
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

const server = createServer((req, res) => {
  const chunks = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', async () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    let body
    try { body = JSON.parse(raw) } catch { body = undefined }
    if (req.method === 'POST' && body !== undefined) {
      const tools = (Array.isArray(body?.tools) ? body.tools : []).map(tool => tool?.name).filter(Boolean)
      const isCoordinator = tools.includes('schedule_create') && tools.includes('task_create')
      const isWorker = tools.includes('write') && tools.includes('task_report')
      const kind = isCoordinator ? 'coordinator' : (isWorker ? 'worker' : 'other')
      const scn = /SCN=([a-z-]+)/.exec(allTextOf(body))?.[1] ?? null
      const flow = isCoordinator ? flowOf(userTextsOf(body).join('\n')) : flowByScn(scn)
      const record = {
        at: new Date().toISOString(),
        kind,
        flow,
        scn,
        toolNames: tools,
        toolResults: toolResultsOf(body).map(item => item.text),
        brief: isWorker ? (toolResultsOf(body).find(item => item.text.includes('【任务引用】') || item.text.includes('【任务详情】'))?.text?.slice(0, 1200) ?? null) : null,
        lastUser: lastUserTextOf(body).slice(0, 400),
        refsInText: [...new Set(String(allTextOf(body)).match(/\btk-[0-9a-z]{6}\b/g) ?? [])],
        bareIdsInText: realIdsOf(allTextOf(body)),
        requestBody: body,
      }
      try { appendFileSync(REQUESTS, `${JSON.stringify(record)}\n`) } catch { /* 记录失败不影响驱动 */ }
      let decision
      try {
        decision = isCoordinator ? coordinatorDecide(body) : (isWorker ? await workerDecide(body) : { kind: 'text', text: 'OTHER' })
      } catch (error) {
        decision = { kind: 'text', text: `MOCK-ERROR: ${error?.message ?? error}` }
      }
      try {
        appendFileSync(DECISIONS, `${JSON.stringify({
          at: record.at,
          kind,
          flow,
          decision: decision.kind === 'tool'
            ? { name: decision.name, status: decision.input?.status ?? null, taskId: decision.input?.task_id ?? null, summary: decision.input?.summary ?? null, action: decision.input?.action ?? null, message: decision.input?.message ?? null }
            : { name: null, text: decision.text },
        })}\n`)
      } catch { /* 同上 */ }
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
