// 预设层工具收窄的语义实验：从 app.asar 解出 cordis/dsh-tools/dsh-scope（不启动 app），
// 用真实 ToolsService 验证「预设 scope 里 restrict 的实际效果」，供
// preset-tools.js 的注释与 test/preset-tools.test.js 引用。
// 覆盖两种形态：保留式（allow 补集，协调者）与遮挡式（deny 点名 + keep 声明，子会话）。
// 用法：node docs/probes/preset-scope-restrict.mjs [app.asar 路径]
import { readFileSync, mkdirSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const ASAR = process.argv[2] ?? 'C:/Users/72489/AppData/Local/Programs/DeepSeek Harness/resources/app.asar'
const OUT = join(tmpdir(), 'dsh-preset-scope-restrict')
const bytes = readFileSync(ASAR)

const headerSize = bytes.readUInt32LE(12)
// 数据区起点按 4 字节对齐：rc.3 的 headerSize 让 16+hs ≡ 1 mod 4，不补齐会整体错位 3 字节。
const dataStart = Math.ceil((16 + headerSize) / 4) * 4
const header = JSON.parse(bytes.slice(16, 16 + headerSize).toString('utf8'))
const entries = new Map()
const collect = (node, prefix) => {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const path = prefix === '' ? name : `${prefix}/${name}`
    if (entry.files !== undefined) collect(entry, path)
    else entries.set(path, { offset: Number(entry.offset), size: Number(entry.size) })
  }
}
collect(header, '')

const raw = path => {
  const entry = entries.get(path)
  if (entry === undefined) throw new Error(`asar 里没有 ${path}`)
  return bytes.subarray(dataStart + entry.offset, dataStart + entry.offset + entry.size)
}

// 解出 dsh-tools 的依赖闭包（cordis/dsh-scope/schemastery/dsh-llm/dsh-util-values…）。
rmSync(OUT, { recursive: true, force: true })
const extracted = new Set()
const pending = ['@deepseek-ai/cordis', '@deepseek-ai/schemastery', '@deepseek-ai/dsh-scope', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-util-values']
while (pending.length > 0) {
  const pkg = pending.pop()
  if (extracted.has(pkg)) continue
  extracted.add(pkg)
  const prefix = `dsh/node_modules/${pkg}/`
  const files = [...entries.keys()].filter(path => path.startsWith(prefix))
  if (files.length === 0) throw new Error(`asar 里没有包 ${pkg}`)
  for (const path of files) {
    const dest = join(OUT, 'node_modules', ...pkg.split('/'), ...path.slice(prefix.length).split('/'))
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, raw(path))
  }
  for (const path of files.filter(item => item.endsWith('.js'))) {
    const text = raw(path).toString('utf8')
    for (const match of text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      const spec = match[1]
      if (spec.startsWith('.') || spec.startsWith('node:')) continue
      const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
      if (!extracted.has(name)) pending.push(name)
    }
  }
}
console.log(`实验依赖已解出：${[...extracted].sort().join(', ')}\n`)

const load = spec => import(pathToFileURL(join(OUT, 'node_modules', ...spec.split('/'), 'lib/index.js')).href)
const { Context, Service } = await load('@deepseek-ai/cordis')
const { ToolsService, defineTool } = await load('@deepseek-ai/dsh-tools')
const { createScope } = await load('@deepseek-ai/dsh-scope')
const presetTools = await import(new URL('../../preset-tools.js', import.meta.url).href)

class SystemPrompt extends Service {
  constructor(ctx) { super(ctx, 'systemPrompt') }
  tools(cb) { this.section = cb; return () => {} }
}

const mk = name => defineTool({
  name,
  description: name,
  parameters: { text: { type: 'string', required: true, description: '占位参数' } },
  output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } }, additionalProperties: false }, render: () => ({}) },
  execute: async () => ({ ok: true }),
})

const results = []
const check = async (label, fn) => {
  try {
    await fn()
    results.push({ label, hit: true })
    console.log(`PASS ${label}`)
  } catch (error) {
    results.push({ label, hit: false })
    console.log(`FAIL ${label}：${error.message}`)
  }
}
const assert = (condition, message) => { if (!condition) throw new Error(message) }
const visible = (tools, key) => [...tools.view(key).visible.keys()].sort()

// 工具名证据：tool-ask-user 注册的是 ask_user_question，不是 ask_user。
const askUserSource = raw('dsh/node_modules/@deepseek-ai/dsh-tool-ask-user/lib/index.js').toString('utf8')
await check('ask_user 工具名是 ask_user_question', () => {
  assert(askUserSource.includes('name: "ask_user_question"'), '源码里没有 name: "ask_user_question"')
  assert(!askUserSource.includes('name: "ask_user"'), '源码里出现了 name: "ask_user"')
})

const app = new Context()
new SystemPrompt(app)
const tools = new ToolsService(app)
tools.register(mk('read'))
tools.register(mk('task_create'))
// 子会话「主动读上下文」那套要用到的全局工具（遮挡式实验）：memory_note（要遮）、context / task_report（要留）。
tools.register(mk('memory_note'))
tools.register(mk('context'))
tools.register(mk('task_report'))

// 对照组：预设 scope 里 restrict({allow})。
const badKey = {}
const badPreset = createScope(app, badKey)
badPreset.ctx.tools.register(mk('ask_user_question'))
try { badPreset.ctx.tools.restrict({ allow: ['task_create'] }) } catch (error) { console.log('  对照组 restrict 抛错：', error.message) }
const badAgent = {}
createScope(app, badAgent, { parent: badKey })

await check('restrict({allow}) 会把预设自己挂的 ask_user_question 一起遮掉', () => {
  const names = visible(tools, badAgent)
  assert(names.includes('task_create'), `agent 视图缺 task_create：${names.join(',')}`)
  assert(!names.includes('ask_user_question'), `agent 视图仍有 ask_user_question：${names.join(',')}`)
})

await check('allow 里写预设自有工具会抛 unknown global tool', () => {
  const key = {}
  const preset = createScope(app, key)
  preset.ctx.tools.register(mk('ask_user_question'))
  let message = ''
  try { preset.ctx.tools.restrict({ allow: ['task_create', 'ask_user_question'] }) } catch (error) { message = error.message }
  assert(message.includes('unknown global tool'), `没有抛 unknown global tool：${message}`)
})

// 实验组：preset-tools 的 deny 补集。
const key = {}
const preset = createScope(app, key)
preset.ctx.tools.register(mk('ask_user_question'))
presetTools.apply(preset.ctx, { allow: ['task_create'] })
const agent = {}
createScope(app, agent, { parent: key })

await check('deny 补集：agent 保留 task_create + ask_user_question，deny 掉 read', () => {
  const names = visible(tools, agent)
  assert(names.includes('task_create'), `缺 task_create：${names.join(',')}`)
  assert(names.includes('ask_user_question'), `缺 ask_user_question：${names.join(',')}`)
  assert(!names.includes('read'), `read 没有被 deny：${names.join(',')}`)
})

await check('预设自己的视图不受影响（ask_user_question 可见）', () => {
  const names = visible(tools, key)
  assert(names.includes('ask_user_question'), `预设视图缺 ask_user_question：${names.join(',')}`)
})

await check('后注册的全局工具被 tools/change 自动补 deny', () => {
  tools.register(mk('show_view'))
  const names = visible(tools, agent)
  assert(!names.includes('show_view'), `show_view 没有被 deny：${names.join(',')}`)
})

await check('preset-tools 空 allow 抛可读错误', () => {
  let message = ''
  try { presetTools.apply(createScope(app, {}).ctx, {}) } catch (error) { message = error.message }
  assert(message.includes('allow'), `错误信息里没有 allow：${message}`)
})

// 实验组 2（0.24.0）：**遮挡式**（deny 名单）——子会话工具面只去写记忆，其余全局工具与预设自有工具都保留。
// 协调者用 allow 补集，子会话用它会把 task_report/task_detail 一起遮掉（见上面 allow 的坑），所以子会话走点名遮挡。
const denyKey = {}
const denyPreset = createScope(app, denyKey)
denyPreset.ctx.tools.register(mk('bash'))
const denyLogs = join(OUT, 'deny-state')
const denyApply = () => presetTools.apply(denyPreset.ctx, {
  deny: ['memory_note'],
  keep: ['context', 'task_detail', 'task_report'],
  stateDir: denyLogs,
})
denyApply()
const denyAgent = {}
createScope(app, denyAgent, { parent: denyKey })

await check('遮挡式 deny：只遮 memory_note，context/task_report 与预设自有 bash 都保留', () => {
  const names = visible(tools, denyAgent)
  assert(!names.includes('memory_note'), `memory_note 没有被遮：${names.join(',')}`)
  for (const kept of ['context', 'task_report', 'bash']) {
    assert(names.includes(kept), `${kept} 被误遮：${names.join(',')}`)
  }
})

await check('遮挡式 keep：已注册的 keep 目标确认可见并写 preset.keep 审计（未注册的 task_detail 不误报）', () => {
  const dir = join(denyLogs, 'logs')
  const text = readdirSync(dir).filter(file => file.endsWith('.jsonl'))
    .map(file => readFileSync(join(dir, file), 'utf8')).join('')
  const keepEvent = text.split('\n').filter(line => line.includes('"event":"preset.keep"'))
  assert(keepEvent.length === 1, `preset.keep 应只写一条：${keepEvent.join('|')}`)
  assert(keepEvent[0].includes('context') && keepEvent[0].includes('task_report'), `keep 审计内容不对：${keepEvent[0]}`)
  assert(!keepEvent[0].includes('task_detail'), `未注册的 task_detail 不该被确认：${keepEvent[0]}`)
})

await check('遮挡式：晚注册的 keep 目标（task_detail）经 tools/change 补确认，且不被误遮', () => {
  tools.register(mk('task_detail'))
  const names = visible(tools, denyAgent)
  assert(names.includes('task_detail'), `task_detail 应可见：${names.join(',')}`)
  const dir = join(denyLogs, 'logs')
  const keeps = readdirSync(dir).filter(file => file.endsWith('.jsonl'))
    .map(file => readFileSync(join(dir, file), 'utf8')).join('')
    .split('\n').filter(line => line.includes('"event":"preset.keep"'))
  assert(keeps.length === 2, `preset.keep 应再写一条（实际 ${keeps.length}）`)
  assert(keeps[1].includes('task_detail'), `第二条 keep 应是 task_detail：${keeps[1]}`)
})

const failed = results.filter(item => !item.hit)
console.log(`\n结果：${results.length - failed.length}/${results.length} PASS`)
if (failed.length > 0) process.exit(1)
rmSync(OUT, { recursive: true, force: true })
