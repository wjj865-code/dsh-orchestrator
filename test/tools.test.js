import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import{ join } from 'node:path'
import { openLedger, createTask, getTask, listTasks, recentMessages, transition, setTaskLastMessage } from '../src/ledger.js'
import { createTools } from '../src/tools.js'
import { createQueue } from '../src/queue.js'
import { captureLastMessage } from '../src/last-message.js'
import { tempDir, sampleBrief } from './helpers.js'

function fakeDispatcher({ failSpawn = false, failSend = false, limit = Infinity } = {}) {
  let counter = 0
  let spawned = 0
  const calls = []
  const grantReleases = []
  return {
    calls,
    grantReleases,
    get spawned() { return spawned },
    release(count = 1) { spawned = Math.max(0, spawned - count) },
    releaseWritableRoots(target) { grantReleases.push(target) },
    slug(title) { counter += 1; return `task-${counter}` },
    async spawn({ name, prompt, signal, cwd, readOnly }) {
      calls.push(['spawn', name, prompt, signal, cwd, readOnly])
      if (failSpawn) throw new Error('子会话创建失败')
      if (spawned >= limit) {
        const error = new Error('subagent limit reached (active child limit)')
        error.code = 'ACTIVATION_LIMIT_REACHED'
        throw error
      }
      spawned += 1
      counter += 1
      return { id: `s-${counter}`, name: name ?? `w-${counter}`, sessionId: `s-${counter}`, target: `s-${counter}` }
    },
    async send(target, message) { calls.push(['send', target, message]) },
    async sendReliable(target, message, signal, targetDir, taskId, readOnly) {
      calls.push(['sendReliable', target, message, signal, targetDir, taskId, readOnly])
      if (failSend) throw new Error('投递超时')
      return { messageId: 'm-1' }
    },
    async stop(target) { calls.push(['stop', target]) },
  }
}

function fakeNotifier() {
  const pushed = []
  return { pushed, push(item) { pushed.push(item) } }
}

async function setup(options = {}) {
  const db = await openLedger(tempDir())
  const dispatcher = fakeDispatcher(options)
  const notifier = fakeNotifier()
  const config = { staleMinutes: 30, maxQueue: 50, coordinatorSession: 's-1', ...(options.config ?? {}) }
  const queue = createQueue({ db, dispatcher, config })
  const tools = Object.fromEntries(createTools({
    db,
    dispatcher,
    queue,
    notifier,
    config,
    coordinatorStatus: () => ({ id: 's-1', live: true }),
    workspaces: options.workspaces,
    defaultCwd: options.defaultCwd,
    sessionQuery: options.sessionQuery,
    sessions: options.sessions,
    workspaceChanges: options.workspaceChanges,
    logger: options.logger,
    goalBridge: options.goalBridge,
    stateDir: options.stateDir,
  }).map(tool => [tool.name, tool]))
  return { db, dispatcher, queue, notifier, tools }
}

// 主会话工具默认以主会话身份调用；task_report 归子会话，保持调用方身份。
const MAIN_TOOLS = new Set([
  'task_create', 'task_list', 'task_status', 'task_message', 'task_stop', 'task_close', 'task_retry', 'task_inbox',
  'history_search', 'project_context', 'memory_note',
])
const call = (tools, name, args, exec) => {
  const resolved = MAIN_TOOLS.has(name) ? { agent: { id: 's-1' }, ...(exec ?? {}) } : exec
  return tools[name].execute(args, resolved)
}

test('注册 14 个工具，schema 对象根、无 minimum/maximum、有 output.schema/render', async () => {
  const { db, tools } = await setup()
  assert.deepEqual(Object.keys(tools).sort(),
    ['history_search', 'memory_note', 'plan_save', 'project_context', 'task_close', 'task_create', 'task_detail', 'task_inbox', 'task_list',
      'task_message', 'task_report', 'task_retry', 'task_status', 'task_stop'])
  const walk = (value, path) => {
    if (value === null || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      assert.notEqual(key, 'minimum', `${path}.${key} 不应出现`)
      assert.notEqual(key, 'maximum', `${path}.${key} 不应出现`)
      walk(child, `${path}.${key}`)
    }
  }
  for (const tool of Object.values(tools)) {
    assert.equal(tool.parameters.type, 'object', `${tool.name} 根 schema 必须是 object`)
    assert.equal(typeof tool.output?.schema, 'object')
    assert.equal(typeof tool.output?.render, 'function')
    const rendered = tool.output.render({}, '结果')
    assert.deepEqual(rendered, [{ type: 'text', text: '结果' }])
    walk(tool.parameters, tool.name)
  }
  db.close()
})

test('模型 JSON Schema 不出现 required: true（provider 只认数组，布尔值会 400）', async () => {
  const { db, tools } = await setup()
  const bad = []
  const walk = (value, path) => {
    if (value === null || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      if (key === 'required' && typeof child === 'boolean') bad.push(`${path}.${key}=${child}`)
      walk(child, `${path}.${key}`)
    }
  }
  for (const tool of Object.values(tools)) {
    walk(tool.parameters, tool.name)
    // 序列化后同样不能出现 "required":true（数组形式 "required":["path"] 允许）
    assert.doesNotMatch(JSON.stringify(tool.parameters), /"required":\s*true/, `${tool.name} 的模型 schema 含布尔 required`)
  }
  assert.deepEqual(bad, [])
  // artifacts 的必填由运行时 normalizeArtifacts 兜底，schema 层不带 required。
  assert.equal('required' in tools.task_report.parameters.properties.artifacts.items.properties.path, false)
  db.close()
})

test('task_create：正常创建、子会话 spawn、台账 running，prompt 是纯指引 brief', async () => {
  const { db, dispatcher, tools } = await setup()
  const signal = new AbortController().signal
  const text = await call(tools, 'task_create', sampleBrief({ title: 'A', goal: '目标A', user_verbatim: '原话' }), { signal })
  assert.match(text, /已派发/)
  const [task] = listTasks(db, { active: true })
  assert.equal(task.status, 'running')
  assert.equal(task.title, 'A')
  assert.ok(task.session_id)
  assert.ok(task.target)
  const spawn = dispatcher.calls.find(call => call[0] === 'spawn')
  assert.equal(spawn[1], 'task-1')
  // 派发是异步队列，用的是插件自有 signal，不能复用这次工具调用的 signal（回合结束会被 abort）。
  assert.ok(spawn[3] instanceof AbortSignal)
  assert.equal(spawn[3].aborted, false)
  // T1：提示词只有任务编号 + task_detail 指引，目标/验收/原话都不再内联。
  assert.match(spawn[2], new RegExp(`【任务编号】${task.id}`))
  assert.match(spawn[2], /task_detail/)
  assert.equal(spawn[2].includes('目标A'), false)
  // 指引里会提到「用户原话」这个字段名，但不会带正文（引用块才是内联正文）。
  assert.equal(spawn[2].includes('> 原话'), false)
  assert.equal(spawn[2].includes('【用户原话】'), false)
  assert.equal(spawn[2].includes('【目标】'), false)
  assert.equal(spawn[2].includes('"title"'), false)
  // 详情确实能从台账读到（子会话按指引现取）。
  const detail = await call(tools, 'task_detail', { task_id: task.id }, { agent: { id: task.session_id } })
  assert.match(detail, /目标：目标A/)
  assert.match(detail, /【用户原话】\n> 原话/)
  db.close()
})

test('task_create：缺 acceptance 返回可读提示且不建任务、不 spawn', async () => {
  const { db, dispatcher, tools } = await setup()
  const text = await call(tools, 'task_create', { title: 'A', goal: 'g' })
  assert.match(text, /acceptance/)
  assert.equal(listTasks(db).length, 0)
  assert.equal(dispatcher.calls.length, 0)
  db.close()
})

function seedTask(db, title, status) {
  const task = createTask(db, { brief: sampleBrief({ title }), coordinatorSession: 's-1' })
  if (status !== 'pending') transition(db, task.id, 'running')
  if (status !== 'pending' && status !== 'running') transition(db, task.id, status)
  return task
}

test('额度只算 pending/running：8 个 waiting_user 不阻塞第 9 个 task_create', async () => {
  const { db, dispatcher, tools } = await setup()
  for (let i = 0; i < 8; i += 1) seedTask(db, `等待${i}`, 'waiting_user')
  const text = await call(tools, 'task_create', sampleBrief({ title: '新任务' }))
  assert.match(text, /已派发/)
  assert.equal(listTasks(db).length, 9)
  assert.ok(dispatcher.calls.some(call => call[0] === 'spawn'))
  const listed = await call(tools, 'task_list', {})
  assert.match(listed, /等待0/)
  db.close()
})

test('排队：容量满时任务进队列不报错，结算后自动补位', async () => {
  const { db, dispatcher, queue, tools } = await setup({ limit: 1 })
  const first = await call(tools, 'task_create', sampleBrief({ title: 'A' }))
  assert.match(first, /已派发/)
  const second = await call(tools, 'task_create', sampleBrief({ title: 'B' }))
  assert.match(second, /排队/)
  const tasks = Object.fromEntries(listTasks(db).map(task => [task.title, task]))
  assert.equal(tasks.A.status, 'running')
  assert.equal(tasks.B.status, 'pending')
  assert.notEqual(tasks.B.queued_at, null)

  // A 完成释放并发槽位后，队列补位派发 B
  dispatcher.release()
  transition(db, tasks.A.id, 'done')
  await queue.pump()
  const resumed = getTask(db, tasks.B.id)
  assert.equal(resumed.status, 'running')
  assert.equal(resumed.queued_at, null)
  db.close()
})

test('排队：task_stop 移出队列，不再派发', async () => {
  const { db, dispatcher, queue, tools } = await setup({ limit: 1 })
  await call(tools, 'task_create', sampleBrief({ title: 'A' }))
  await call(tools, 'task_create', sampleBrief({ title: 'B' }))
  const queued = listTasks(db).find(task => task.title === 'B')
  const text = await call(tools, 'task_stop', { task_id: queued.id })
  assert.match(text, /排队/)
  assert.equal(getTask(db, queued.id).status, 'cancelled')
  assert.equal(queue.size(), 0)
  db.close()
})

test('排队：task_message 给排队提示，不写 messages、不改状态', async () => {
  const { db, tools } = await setup({ limit: 0 })
  await call(tools, 'task_create', sampleBrief({ title: 'A' }))
  const task = listTasks(db)[0]
  const before = db.prepare('SELECT count(*) AS n FROM messages').get().n
  const text = await call(tools, 'task_message', { task_id: task.id, message: '继续' })
  assert.match(text, /排队/)
  assert.equal(db.prepare('SELECT count(*) AS n FROM messages').get().n, before)
  assert.equal(getTask(db, task.id).status, 'pending')
  db.close()
})

test('并发 12 个 task_create：全部落库，各 spawn 一次', async () => {
  const { db, dispatcher, tools } = await setup()
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) =>
    call(tools, 'task_create', sampleBrief({ title: `并发${i}` }))))
  assert.equal(results.filter(text => /已派发/.test(text)).length, 12)
  assert.equal(listTasks(db).length, 12)
  assert.equal(dispatcher.calls.filter(call => call[0] === 'spawn').length, 12)
  assert.equal(db.prepare('SELECT count(*) AS n FROM tasks WHERE session_id IS NULL').get().n, 0)
  db.close()
})

test('task_create：同 title+goal 的活跃任务视为重复，返回已有任务', async () => {
  const { db, dispatcher, tools } = await setup()
  await call(tools, 'task_create', sampleBrief({ title: '甲', goal: '同一个活' }))
  const text = await call(tools, 'task_create', sampleBrief({ title: '甲', goal: '同一个活' }))
  assert.match(text, /已存在任务「.*（t-[0-9a-f]+）/)
  assert.match(text, /未重复创建/)
  assert.equal(listTasks(db).length, 1)
  assert.equal(dispatcher.calls.filter(call => call[0] === 'spawn').length, 1)
  db.close()
})

test('task_create：等待态也参与去重', async () => {
  const { db, tools } = await setup()
  await call(tools, 'task_create', sampleBrief({ title: '甲', goal: '等用户' }))
  const task = listTasks(db)[0]
  transition(db, task.id, 'waiting_user')
  const text = await call(tools, 'task_create', sampleBrief({ title: '甲', goal: '等用户' }))
  assert.match(text, /已存在任务/)
  assert.match(text, /等你确认/)
  assert.equal(listTasks(db).length, 1)
  db.close()
})

test('task_create：done 后同 title+goal 允许重新创建', async () => {
  const { db, dispatcher, tools } = await setup()
  await call(tools, 'task_create', sampleBrief({ title: '甲', goal: '再跑一遍' }))
  const task = listTasks(db)[0]
  transition(db, task.id, 'done')
  const text = await call(tools, 'task_create', sampleBrief({ title: '甲', goal: '再跑一遍' }))
  assert.match(text, /已派发/)
  assert.equal(listTasks(db).length, 2)
  assert.equal(dispatcher.calls.filter(call => call[0] === 'spawn').length, 2)
  db.close()
})

test('task_create：并发同目标只建一条', async () => {
  const { db, dispatcher, tools } = await setup()
  const results = await Promise.all(Array.from({ length: 12 }, () =>
    call(tools, 'task_create', sampleBrief({ title: '同一个活', goal: '并发' }))))
  assert.equal(results.filter(text => /已派发/.test(text)).length, 1)
  assert.equal(results.filter(text => /已存在任务/.test(text)).length, 11)
  assert.equal(listTasks(db).length, 1)
  assert.equal(dispatcher.calls.filter(call => call[0] === 'spawn').length, 1)
  db.close()
})

test('maxQueue 满时拒绝创建且不落库', async () => {
  const { db, tools } = await setup({ limit: 0, config: { maxQueue: 2 } })
  await call(tools, 'task_create', sampleBrief({ title: 'A' }))
  await call(tools, 'task_create', sampleBrief({ title: 'B' }))
  const text = await call(tools, 'task_create', sampleBrief({ title: 'C' }))
  assert.match(text, /队列已满/)
  assert.equal(listTasks(db).length, 2)
  db.close()
})

test('spawn 非容量失败标 failed，不留 pending 幽灵', async () => {
  const { db, tools } = await setup({ failSpawn: true })
  const text = await call(tools, 'task_create', sampleBrief({ title: 'A' }))
  assert.match(text, /任务协调失败：子会话创建失败/)
  const [task] = listTasks(db)
  assert.equal(task.status, 'failed')
  assert.match(task.error, /子会话创建失败/)
  assert.equal(listTasks(db, { active: true }).length, 0)
  db.close()
})

test('task_list：默认只列活跃、空表文案、全量与行格式', async () => {
  const { db, tools } = await setup()
  assert.equal(await call(tools, 'task_list', {}), '没有活跃任务。')
  assert.equal(await call(tools, 'task_list', { active: false }), '台账里还没有任何任务。')
  await call(tools, 'task_create', sampleBrief({ title: '甲', goal: '做甲' }))
  const b = await call(tools, 'task_create', sampleBrief({ title: '乙', goal: '做乙' }))
  const idB = listTasks(db).find(task => task.title === '乙').id
  await call(tools, 'task_stop', { task_id: idB })
  const activeText = await call(tools, 'task_list', {})
  assert.match(activeText, /甲/)
  assert.equal(activeText.includes('乙'), false)
  const allText = await call(tools, 'task_list', { active: false })
  assert.match(allText, /乙/)
  assert.match(allText, /进行中/)
  assert.match(allText, /已取消/)
  assert.match(allText, /子会话/)
  assert.match(b, /已派发/)
  db.close()
})

test('task_list：31 分钟无动静带 stale 标记，29 分钟不带', async () => {
  const { db, tools } = await setup()
  await call(tools, 'task_create', sampleBrief({ title: '旧' }))
  const task = listTasks(db).find(t => t.title === '旧')
  const now = Date.now()
  db.prepare('UPDATE tasks SET last_event_at = ? WHERE id = ?').run(now - 31 * 60_000, task.id)
  assert.match(await call(tools, 'task_list', {}), /⚠ 已 31 分钟无动静/)
  db.prepare('UPDATE tasks SET last_event_at = ? WHERE id = ?').run(now - 29 * 60_000, task.id)
  assert.equal((await call(tools, 'task_list', {})).includes('⚠'), false)
  db.close()
})

test('task_status：详情、最近 3 条、不存在提示', async () => {
  const { db, tools } = await setup()
  const missing = await call(tools, 'task_status', { task_id: 't-nope' })
  assert.match(missing, /没有任务 t-nope/)
  await call(tools, 'task_create', sampleBrief({ title: '甲' }))
  const task = listTasks(db)[0]
  const text = await call(tools, 'task_status', { task_id: task.id })
  assert.match(text, /任务「.*（t-[0-9a-f]+）/)
  assert.match(text, /进行中/)
  assert.match(text, /最近消息/)
  assert.match(text, /\[brief\]/)
  assert.doesNotMatch(text, /最近返回/, '还没有结算返回消息时不显示该区块')
  db.close()
})

// B1：结算落下的最新返回消息，主会话用 task_status 读；长消息给路径 + 摘要，include=full 才读全文。
test('task_status：返回子会话最新返回消息，长消息给路径+摘要，include=full 读全文', async () => {
  const { db, tools } = await setup()
  await call(tools, 'task_create', sampleBrief({ title: '带回执' }))
  const task = listTasks(db)[0]
  const reportsDir = tempDir()

  const short = captureLastMessage({ text: '改完了：npm test 540/540 全绿。', taskId: task.id, reportsDir, stopReason: 'completed' })
  setTaskLastMessage(db, task.id, short)
  const shortText = await call(tools, 'task_status', { task_id: task.id })
  assert.match(shortText, /最近返回（结算 completed｜/)
  assert.match(shortText, /内联存台账/)
  assert.match(shortText, /改完了：npm test 540\/540 全绿。/)

  // 内联但偏长：默认只给预览，include=full 给全文
  const medium = '细'.repeat(2000)
  setTaskLastMessage(db, task.id, captureLastMessage({ text: medium, taskId: task.id, reportsDir }))
  const preview = await call(tools, 'task_status', { task_id: task.id })
  assert.match(preview, /已截断，共 2000 字；全文用 include=full/)
  assert.ok(!preview.includes(medium))
  const full = await call(tools, 'task_status', { task_id: task.id, include: 'full' })
  assert.ok(full.includes(medium))

  // 超 64KB：默认给 reports 路径 + 摘要，include=full 从文件读全文
  const huge = `结尾一行\n${'细'.repeat(25_000)}`
  const record = captureLastMessage({ text: huge, taskId: task.id, reportsDir, stopReason: 'max-tokens' })
  setTaskLastMessage(db, task.id, record)
  assert.equal(record.stored, 'file')
  const fileStatus = await call(tools, 'task_status', { task_id: task.id })
  assert.match(fileStatus, /全文存 reports 文件/)
  assert.match(fileStatus, /结算 max-tokens/)
  assert.ok(fileStatus.includes(record.path))
  assert.match(fileStatus, /摘要：/)
  assert.match(fileStatus, /看全文：task_status 带 include=full/)
  const fromFile = await call(tools, 'task_status', { task_id: task.id, include: 'full' })
  assert.ok(fromFile.includes(huge))
  db.close()
})

test('task_status include=full：报告文件被删时降级为摘要 + 读取失败原因', async () => {
  const { db, tools } = await setup()
  await call(tools, 'task_create', sampleBrief({ title: '缺文件' }))
  const task = listTasks(db)[0]
  const reportsDir = tempDir()
  const record = captureLastMessage({ text: '细'.repeat(25_000), taskId: task.id, reportsDir })
  setTaskLastMessage(db, task.id, { ...record, path: join(reportsDir, 'gone.md') })
  const text = await call(tools, 'task_status', { task_id: task.id, include: 'full' })
  assert.match(text, /全文读取失败/)
  assert.match(text, /gone\.md/)
  db.close()
})

// P6 / T6.2：task_status 产物区块 —— 错过通知时的兜底回流路径。口径必须与通知一致（风险 R17）：
// 只列 present 能接住的普通文件，目录 / 符号链接 / 已不存在只计数；带交付指令与条数。
test('task_status 产物区块：列可交付绝对路径 + 条数，目录/不存在只计数', async () => {
  const target = tempDir()
  const report = join(target, 'report.md')
  writeFileSync(report, '# ok', 'utf8')
  mkdirSync(join(target, 'dist'))
  const { db, tools } = await setup()
  await call(tools, 'task_create', { ...sampleBrief({ title: '带产物' }), target })
  const task = listTasks(db)[0]
  await call(tools, 'task_report', {
    task_id: task.id,
    status: 'done',
    summary: '完成',
    artifacts: [{ path: 'report.md', label: '报告' }, { path: 'dist' }, { path: 'missing.txt' }],
  }, { agent: { id: task.session_id } })

  const text = await call(tools, 'task_status', { task_id: task.id })
  assert.match(text, /产物：共 3 条（可交付 1 条）/)
  assert.ok(text.includes(`- ${report} — 报告`))
  assert.match(text, /另有 2 条产物不能交付（目录 1、不存在 1）/)
  // 交付指令与通知同一句：插件已 stat 校验过，别让模型另找路径。
  assert.match(text, /交付：在你自己的回合里调用 present/)
  assert.match(text, /插件已 stat 校验存在且是普通文件，不要另找路径/)
  // 目录与不存在的路径不进交付清单（混进去会让整次 present 失败）。
  assert.equal(text.includes(`- ${join(target, 'dist')}`), false)
  assert.equal(text.includes(`- ${join(target, 'missing.txt')}`), false)
  db.close()
})

test('task_status 无产物不显示产物区块；产物被删后按现状重新判定', async () => {
  const target = tempDir()
  const report = join(target, 'a.md')
  writeFileSync(report, 'x', 'utf8')
  const { db, tools } = await setup()
  await call(tools, 'task_create', { ...sampleBrief({ title: '产物变化' }), target })
  const task = listTasks(db)[0]
  assert.doesNotMatch(await call(tools, 'task_status', { task_id: task.id }), /产物：/)

  await call(tools, 'task_report', {
    task_id: task.id, status: 'done', summary: '完成', artifacts: [{ path: 'a.md', label: '甲' }],
  }, { agent: { id: task.session_id } })
  assert.match(await call(tools, 'task_status', { task_id: task.id }), /产物：共 1 条（可交付 1 条）/)

  // 台账里记着 exists:true，但交付判据是「现在还在不在」，所以删掉后按不存在计数、不给交付指令。
  unlinkSync(report)
  const after = await call(tools, 'task_status', { task_id: task.id })
  assert.match(after, /产物：共 1 条，没有可直接交付的普通文件/)
  assert.match(after, /另有 1 条产物不能交付（不存在 1）/)
  assert.doesNotMatch(after, /调用 present/)
  db.close()
})

test('task_message：正常写 followup 并投递，attempts +1', async () => {
  const { db, dispatcher, tools } = await setup()
  await call(tools, 'task_create', sampleBrief({ title: '甲' }))
  const task = listTasks(db)[0]
  const signal = new AbortController().signal
  const text = await call(tools, 'task_message', { task_id: task.id, message: '继续' }, { signal })
  assert.match(text, /已把消息追加/)
  const call2 = dispatcher.calls.find(call => call[0] === 'sendReliable')
  assert.equal(call2[2], '继续')
  assert.equal(call2[3], signal)
  assert.equal(getTask(db, task.id).attempts, 1)
  const kinds = db.prepare('SELECT kind FROM messages WHERE task_id = ? ORDER BY seq').all(task.id).map(row => row.kind)
  assert.deepEqual(kinds, ['brief', 'followup'])
  const meta = JSON.parse(db.prepare("SELECT meta_json FROM messages WHERE task_id = ? AND kind = 'followup'").get(task.id).meta_json)
  assert.equal(meta.delivery, 'delivered', '投递成功后 followup 标 delivered（详情抽屉显示已投递）')
  db.close()
})

test('对外文案：task_create/list/status 带 id，续派/停止/回报回执零 id；重名通知带短后缀', async () => {
  const { db, dispatcher, notifier, tools } = await setup()
  const created = await call(tools, 'task_create', sampleBrief({ title: '同名', goal: '第一个' }))
  const idA = created.match(/（(t-[0-9a-f]+)）/)[1]
  // 创建回执保留 id（模型要马上续派/停止）
  assert.match(created, /任务「同名（t-[0-9a-f]+）」已派发/)
  // 同名不同 goal：允许再建，通知显示名要带短后缀
  await call(tools, 'task_create', sampleBrief({ title: '同名', goal: '第二个' }))
  assert.equal(dispatcher.calls.filter(call => call[0] === 'spawn').length, 2)
  const list = await call(tools, 'task_list', {})
  assert.match(list, /同名（t-[0-9a-f]+）/)
  const status = await call(tools, 'task_status', { task_id: idA })
  assert.match(status, /任务「同名（t-[0-9a-f]+）」/)
  const sent = await call(tools, 'task_message', { task_id: idA, message: '继续' })
  assert.doesNotMatch(sent, /t-[0-9a-f]{8}/, '续派回执不裸露 id')
  const stoppedTask = listTasks(db).find(task => task.id !== idA)
  const stopped = await call(tools, 'task_stop', { task_id: stoppedTask.id })
  assert.doesNotMatch(stopped, /t-[0-9a-f]{8}/, '停止回执不裸露 id')
  // 回报通知：displayName 由 tools 用全量任务算好，带短后缀
  const report = await call(tools, 'task_report', { task_id: idA, status: 'done', summary: '完成' }, { agent: { id: (listTasks(db).find(task => task.id === idA)).session_id } })
  assert.doesNotMatch(report, /t-[0-9a-f]{8}/, '回报回执不裸露 id')
  const shown = notifier.pushed.at(-1)
  assert.match(shown.displayName, /^同名（[0-9a-f]{4}）$/)
  db.close()
})

test('task_create 只产生一条 task.create.created 事件（带 readOnly）', async () => {
  const events = []
  const logger = { log: (event, fields) => events.push([event, fields]) }
  const { db, tools } = await setup({ logger })
  await call(tools, 'task_create', sampleBrief({ title: '单条事件' }))
  const created = events.filter(([event]) => event === 'task.create.created')
  assert.equal(created.length, 1)
  assert.equal(created[0][1].detail.readOnly, false)
  db.close()
})

test('task_create readOnly：显式 true 落库并进 brief；字符串/默认都不算只读', async () => {
  const { db, dispatcher, notifier, tools } = await setup()
  const normal = await call(tools, 'task_create', sampleBrief({ title: '普通任务' }))
  assert.match(normal, /已派发/)
  const plain = listTasks(db).find(task => task.title === '普通任务')
  assert.equal(plain.read_only, false)
  assert.equal(plain.brief.readOnly, undefined)

  const readOnly = await call(tools, 'task_create', { ...sampleBrief({ title: '只读任务' }), readOnly: true })
  assert.match(readOnly, /已派发/)
  const ro = listTasks(db).find(task => task.title === '只读任务')
  assert.equal(ro.read_only, true)
  assert.equal(ro.brief.readOnly, true)
  const spawns = dispatcher.calls.filter(item => item[0] === 'spawn')
  assert.equal(spawns.filter(item => item[5] === true).length, 1, '只有只读任务派发时 readOnly:true')
  // 续派：readOnly 也要透传给 sendReliable（让 dispatch 补设只读、不注册可写根）。
  await call(tools, 'task_message', { task_id: ro.id, message: '继续' })
  const sent = dispatcher.calls.filter(item => item[0] === 'sendReliable').at(-1)
  assert.equal(sent[6], true, '续派把 readOnly 传给 sendReliable')
  // 通知携带 readOnly 标记，渲染层据此加「（只读）」。
  await call(tools, 'task_report', { task_id: ro.id, status: 'done', summary: '完成' }, { agent: { id: ro.session_id } })
  assert.equal(notifier.pushed.at(-1).readOnly, true)

  const sneaky = await call(tools, 'task_create', { ...sampleBrief({ title: '字符串真值' }), readOnly: 'true' })
  assert.match(sneaky, /已派发/)
  assert.equal(listTasks(db).find(task => task.title === '字符串真值').read_only, false)

  const list = await call(tools, 'task_list', { active: false })
  assert.match(list, /只读任务.*只读/)
  assert.doesNotMatch(list, /普通任务.*只读/)
  const status = await call(tools, 'task_status', { task_id: ro.id })
  assert.match(status, /权限：只读/)
  const plainStatus = await call(tools, 'task_status', { task_id: plain.id })
  assert.doesNotMatch(plainStatus, /只读/)
  db.close()
})

test('task_message：续派把 target_dir 传给 sendReliable（续派前补注册可写根用）', async () => {
  const { db, dispatcher, tools } = await setup()
  const target = tempDir()
  await call(tools, 'task_create', sampleBrief({ title: '带目录', target }))
  const task = listTasks(db)[0]
  await call(tools, 'task_message', { task_id: task.id, message: '继续' })
  const call2 = dispatcher.calls.find(item => item[0] === 'sendReliable')
  assert.equal(call2[4], target)
  assert.equal(call2[5], task.id)
  db.close()
})

test('task_message：无子会话与不存在 id 给可读提示', async () => {
  const { db, dispatcher, tools } = await setup()
  const missing = await call(tools, 'task_message', { task_id: 't-nope', message: 'x' })
  assert.match(missing, /没有任务/)
  const created = await call(tools, 'task_create', sampleBrief({ title: '甲' }))
  assert.match(created, /已派发/)
  const task = listTasks(db)[0]
  db.prepare('UPDATE tasks SET target = NULL WHERE id = ?').run(task.id)
  const text = await call(tools, 'task_message', { task_id: task.id, message: 'x' })
  assert.match(text, /还没有子会话/)
  assert.equal(dispatcher.calls.filter(call => call[0] === 'sendReliable').length, 0)
  db.close()
})

test('task_message：终态任务拒绝续派', async () => {
  const { db, tools } = await setup()
  await call(tools, 'task_create', sampleBrief({ title: '甲' }))
  const task = listTasks(db)[0]
  transition(db, task.id, 'done')
  const text = await call(tools, 'task_message', { task_id: task.id, message: 'x' })
  assert.match(text, /已结束/)
  db.close()
})

// 面板优化：门控与面板按钮同源（panel-gates.followupGate）——失败任务改用 task_retry，不再续派。
test('task_message：失败任务拒绝续派，提示改用 task_retry', async () => {
  const { db, dispatcher, tools } = await setup()
  await call(tools, 'task_create', sampleBrief({ title: '失败任务' }))
  const task = listTasks(db)[0]
  transition(db, task.id, 'failed', { error: 'boom' })
  const before = db.prepare('SELECT count(*) AS n FROM messages').get().n
  const text = await call(tools, 'task_message', { task_id: task.id, message: '继续' })
  assert.match(text, /不能续派/)
  assert.match(text, /task_retry/)
  assert.equal(db.prepare('SELECT count(*) AS n FROM messages').get().n, before)
  assert.equal(dispatcher.calls.filter(call => call[0] === 'sendReliable').length, 0)
  db.close()
})

test('task_message：重试 3 次仍失败 → waiting_user + error + 失败消息行', async () => {
  const { db, tools } = await setup({ failSend: true })
  await call(tools, 'task_create', sampleBrief({ title: '甲' }))
  const task = listTasks(db)[0]
  const text = await call(tools, 'task_message', { task_id: task.id, message: '继续' })
  assert.match(text, /续派失败/)
  assert.match(text, /等你确认/)
  const after = getTask(db, task.id)
  assert.equal(after.status, 'waiting_user')
  assert.match(after.error, /投递超时/)
  const kinds = db.prepare('SELECT kind, rendered, meta_json FROM messages WHERE task_id = ? ORDER BY seq').all(task.id)
  assert.ok(kinds.some(row => row.kind === 'delivery_failed'))
  const followup = kinds.find(row => row.kind === 'followup')
  assert.equal(JSON.parse(followup.meta_json).delivery, 'failed', '投递失败后 followup 标 failed（详情抽屉显示投递失败）')
  db.close()
})

test('未打开主会话时 task_message/task_stop 给提示且不半执行', async () => {
  const db = await openLedger(tempDir())
  const dispatcher = fakeDispatcher()
  const tools = Object.fromEntries(createTools({
    db,
    dispatcher,
    notifier: fakeNotifier(),
    config: {},
    coordinatorStatus: () => ({ id: undefined, live: false }),
  }).map(tool => [tool.name, tool]))
  const task = createTask(db, { brief: sampleBrief({ title: '甲' }), coordinatorSession: 's-1' })
  transition(db, task.id, 'running', { sessionId: 'm-1', target: 'w-1' })

  const message = await call(tools, 'task_message', { task_id: task.id, message: '继续' })
  assert.match(message, /尚未打开主会话/)
  assert.equal(db.prepare('SELECT count(*) AS n FROM messages WHERE task_id = ?').get(task.id).n, 0)

  const stop = await call(tools, 'task_stop', { task_id: task.id })
  assert.match(stop, /尚未打开主会话/)
  assert.equal(getTask(db, task.id).status, 'running')
  assert.equal(dispatcher.calls.length, 0)
  db.close()
})

test('task_stop：cancelled + interrupt；已结束不再 interrupt', async () => {
  const { db, dispatcher, tools } = await setup()
  await call(tools, 'task_create', sampleBrief({ title: '甲' }))
  const task = listTasks(db)[0]
  const text = await call(tools, 'task_stop', { task_id: task.id })
  assert.match(text, /已停止/)
  assert.equal(getTask(db, task.id).status, 'cancelled')
  assert.ok(dispatcher.calls.some(call => call[0] === 'stop'))
  const again = await call(tools, 'task_stop', { task_id: task.id })
  assert.match(again, /已结束/)
  assert.equal(dispatcher.calls.filter(call => call[0] === 'stop').length, 1)
  db.close()
})

test('可写根生命周期：done（确认后）与 cancelled 释放；delivered / blocked 保留以便续派', async () => {
  // done：交付回报先落 delivered（不释放），task_close 确认后才释放。
  const done = await setup()
  await call(done.tools, 'task_create', sampleBrief({ title: '甲' }))
  const doneTask = listTasks(done.db)[0]
  await call(done.tools, 'task_report', { task_id: doneTask.id, status: 'done', summary: '完成' }, { agent: { id: doneTask.session_id } })
  assert.equal(getTask(done.db, doneTask.id).status, 'delivered')
  assert.deepEqual(done.dispatcher.grantReleases, [])
  const closed = await call(done.tools, 'task_close', { task_id: doneTask.id })
  assert.match(closed, /已确认完成/)
  assert.equal(getTask(done.db, doneTask.id).status, 'done')
  assert.deepEqual(done.dispatcher.grantReleases, [doneTask.session_id])
  done.db.close()

  // blocked → waiting_user：不释放（续派还要写 target）
  const blocked = await setup()
  await call(blocked.tools, 'task_create', sampleBrief({ title: '乙' }))
  const blockedTask = listTasks(blocked.db)[0]
  await call(blocked.tools, 'task_report', { task_id: blockedTask.id, status: 'blocked', summary: '等用户' }, { agent: { id: blockedTask.session_id } })
  assert.deepEqual(blocked.dispatcher.grantReleases, [])
  blocked.db.close()

  // task_stop → cancelled：释放
  const stopped = await setup()
  await call(stopped.tools, 'task_create', sampleBrief({ title: '丙' }))
  const stoppedTask = listTasks(stopped.db)[0]
  await call(stopped.tools, 'task_stop', { task_id: stoppedTask.id })
  assert.deepEqual(stopped.dispatcher.grantReleases, [stoppedTask.session_id])
  stopped.db.close()
})

test('waiting_user 续派：target_dir 透传、可写根不释放（第二轮仍能写）', async () => {
  const { db, dispatcher, tools } = await setup()
  const target = tempDir()
  await call(tools, 'task_create', sampleBrief({ title: '续派', target }))
  const task = listTasks(db)[0]
  // 首轮 blocked → waiting_user：settle 之后可写根必须保留。
  await call(tools, 'task_report', { task_id: task.id, status: 'blocked', summary: '等用户' }, { agent: { id: task.session_id } })
  assert.equal(getTask(db, task.id).status, 'waiting_user')
  assert.deepEqual(dispatcher.grantReleases, [])
  // 续派：把 target_dir 传给 sendReliable，让 dispatch 投递前补注册；仍不释放。
  await call(tools, 'task_message', { task_id: task.id, message: '再写一个' })
  const sent = dispatcher.calls.find(item => item[0] === 'sendReliable')
  assert.equal(sent[4], target)
  assert.deepEqual(dispatcher.grantReleases, [])
  assert.equal(getTask(db, task.id).status, 'running')
  db.close()
})

test('task_report：progress 只 touch 不改状态', async () => {
  const { db, notifier, tools } = await setup()
  await call(tools, 'task_create', sampleBrief({ title: '甲' }))
  const task = listTasks(db)[0]
  const before = getTask(db, task.id)
  await new Promise(resolve => setTimeout(resolve, 2))
  const text = await call(tools, 'task_report', { task_id: task.id, status: 'progress', summary: '在跑' })
  assert.match(text, /已记录/)
  assert.equal(getTask(db, task.id).status, 'running')
  assert.ok(getTask(db, task.id).last_event_at > before.last_event_at)
  assert.equal(notifier.pushed.length, 1)
  db.close()
})

test('task_report：done→待确认/blocked/needs_auth 迁移并通知，sender 透传', async () => {
  for (const [status, expected, pushed] of [['done', 'delivered', 'delivered'], ['blocked', 'waiting_user', 'blocked'], ['needs_auth', 'waiting_auth', 'needs_auth']]) {
    const { db, notifier, tools } = await setup()
    await call(tools, 'task_create', sampleBrief({ title: '甲' }))
    const task = listTasks(db)[0]
    const sender = { id: task.session_id }
    const signal = new AbortController().signal
    await call(tools, 'task_report', { task_id: task.id, status, summary: '说明' }, { agent: sender, signal })
    assert.equal(getTask(db, task.id).status, expected)
    assert.equal(notifier.pushed.length, 1)
    assert.equal(notifier.pushed[0].status, pushed)
    assert.equal(notifier.pushed[0].sender, sender)
    assert.equal(notifier.pushed[0].signal, signal)
    db.close()
  }
})

test('task_report：非本任务子会话回报被拒绝，不落库、不通知', async () => {
  const { db, notifier, tools } = await setup()
  await call(tools, 'task_create', sampleBrief({ title: '甲' }))
  await call(tools, 'task_create', sampleBrief({ title: '乙' }))
  const task = listTasks(db).find(item => item.title === '甲')
  const beforeMessages = db.prepare('SELECT count(*) AS n FROM messages WHERE task_id = ?').get(task.id).n
  const text = await call(tools, 'task_report', { task_id: task.id, status: 'done', summary: '冒名' }, { agent: { id: 'someone-else' } })
  assert.match(text, /回报被拒绝/)
  assert.match(text, /不是它/)
  assert.equal(getTask(db, task.id).status, 'running')
  assert.equal(db.prepare('SELECT count(*) AS n FROM messages WHERE task_id = ?').get(task.id).n, beforeMessages)
  assert.equal(notifier.pushed.length, 0)
  db.close()
})

test('task_report：非法 status 不写消息不改状态', async () => {
  const { db, notifier, tools } = await setup()
  await call(tools, 'task_create', sampleBrief({ title: '甲' }))
  const task = listTasks(db)[0]
  const before = db.prepare('SELECT count(*) AS n FROM messages WHERE task_id = ?').get(task.id).n
  const text = await call(tools, 'task_report', { task_id: task.id, status: 'weird', summary: 'x' })
  assert.match(text, /progress \/ done \/ blocked \/ needs_auth/)
  assert.equal(getTask(db, task.id).status, 'running')
  assert.equal(db.prepare('SELECT count(*) AS n FROM messages WHERE task_id = ?').get(task.id).n, before)
  assert.equal(notifier.pushed.length, 0)
  db.close()
})

test('task_report：不存在 id 提示且不写消息', async () => {
  const { db, tools } = await setup()
  const text = await call(tools, 'task_report', { task_id: 't-nope', status: 'progress', summary: 'x' })
  assert.match(text, /没有任务 t-nope/)
  assert.equal(db.prepare('SELECT count(*) AS n FROM messages').get().n, 0)
  db.close()
})

test('task_report：重复 done 幂等，不迁移、不产生第二条通知', async () => {
  const { db, notifier, tools } = await setup()
  await call(tools, 'task_create', sampleBrief({ title: '甲' }))
  const task = listTasks(db)[0]
  await call(tools, 'task_report', { task_id: task.id, status: 'done', summary: '完成' })
  assert.equal(getTask(db, task.id).status, 'delivered')
  const text = await call(tools, 'task_report', { task_id: task.id, status: 'done', summary: '再次完成' })
  assert.match(text, /重复 done 回报/)
  assert.equal(getTask(db, task.id).status, 'delivered')
  assert.equal(notifier.pushed.length, 1)
  db.close()
})

test('task_report：缺 summary 不崩', async () => {
  const { db, tools } = await setup()
  await call(tools, 'task_create', sampleBrief({ title: '甲' }))
  const task = listTasks(db)[0]
  const text = await call(tools, 'task_report', { task_id: task.id, status: 'progress' })
  assert.match(text, /已记录/)
  db.close()
})

test('blocked → 续派 → 交付 → 确认闭环', async () => {
  const { db, tools } = await setup()
  await call(tools, 'task_create', sampleBrief({ title: '甲' }))
  const task = listTasks(db)[0]
  await call(tools, 'task_report', { task_id: task.id, status: 'blocked', summary: '等用户拍板' })
  assert.equal(getTask(db, task.id).status, 'waiting_user')
  const resumed = await call(tools, 'task_message', { task_id: task.id, message: '用户选 A' })
  assert.match(resumed, /已把消息追加/)
  assert.equal(getTask(db, task.id).status, 'running')
  await call(tools, 'task_report', { task_id: task.id, status: 'done', summary: '做完了' })
  assert.equal(getTask(db, task.id).status, 'delivered')
  await call(tools, 'task_close', { task_id: task.id })
  assert.equal(getTask(db, task.id).status, 'done')
  db.close()
})

test('needs_auth → 续派 → 交付 → 确认闭环', async () => {
  const { db, tools } = await setup()
  await call(tools, 'task_create', sampleBrief({ title: '甲' }))
  const task = listTasks(db)[0]
  await call(tools, 'task_report', { task_id: task.id, status: 'needs_auth', summary: '要授权' })
  assert.equal(getTask(db, task.id).status, 'waiting_auth')
  await call(tools, 'task_message', { task_id: task.id, message: '授权已给' })
  assert.equal(getTask(db, task.id).status, 'running')
  await call(tools, 'task_report', { task_id: task.id, status: 'done', summary: '完成' })
  assert.equal(getTask(db, task.id).status, 'delivered')
  await call(tools, 'task_close', { task_id: task.id })
  assert.equal(getTask(db, task.id).status, 'done')
  db.close()
})

test('waiting_user 直接收到 done 回报：先回 running 再落待确认', async () => {
  const { db, tools } = await setup()
  await call(tools, 'task_create', sampleBrief({ title: '甲' }))
  const task = listTasks(db)[0]
  await call(tools, 'task_report', { task_id: task.id, status: 'blocked', summary: '卡住' })
  await call(tools, 'task_report', { task_id: task.id, status: 'done', summary: '已自行完成' })
  assert.equal(getTask(db, task.id).status, 'delivered')
  await call(tools, 'task_close', { task_id: task.id })
  assert.equal(getTask(db, task.id).status, 'done')
  db.close()
})

test('并发 8 个子任务：target/status 各归各，通知不丢', async () => {
  const { db, notifier, tools } = await setup()
  const exec = { agent: { id: 's-1' } }
  await Promise.all(Array.from({ length: 8 }, (_, i) =>
    call(tools, 'task_create', sampleBrief({ title: `T${i}` }), exec)))
  const tasks = listTasks(db, { active: true })
  assert.equal(tasks.length, 8)
  assert.equal(new Set(tasks.map(task => task.target)).size, 8)
  assert.ok(tasks.every(task => task.status === 'running'))
  await Promise.all(tasks.map(task =>
    call(tools, 'task_report', { task_id: task.id, status: 'done', summary: task.title }, { agent: { id: task.session_id } })))
  // 交付后仍算活跃（待确认），确认后才退出活跃集。
  assert.ok(listTasks(db, { active: true }).every(task => task.status === 'delivered'))
  assert.equal(notifier.pushed.length, 8)
  assert.deepEqual(new Set(notifier.pushed.map(item => item.taskId)), new Set(tasks.map(task => task.id)))
  await Promise.all(tasks.map(task => call(tools, 'task_close', { task_id: task.id })))
  assert.equal(listTasks(db, { active: true }).length, 0)
  db.close()
})

test('非主会话调用 task_* 被拒，且不产生副作用', async () => {
  const { db, dispatcher, tools } = await setup()
  const other = { agent: { id: 'other-1' } }
  const create = await call(tools, 'task_create', sampleBrief({ title: '甲' }), other)
  assert.match(create, /主会话/)
  const list = await call(tools, 'task_list', {}, other)
  assert.match(list, /主会话/)
  const status = await call(tools, 'task_status', { task_id: 't-x' }, other)
  assert.match(status, /主会话/)
  assert.equal(listTasks(db).length, 0)
  assert.equal(dispatcher.calls.length, 0)
  db.close()
})

test('task_create 校验 target 并落 target_dir；brief 是纯指引，工作目录在 task_detail 里', async () => {
  const { db, tools } = await setup()
  const bad = await call(tools, 'task_create', { ...sampleBrief({ title: 'b' }), target: 'relative/dir' })
  assert.match(bad, /绝对路径/)
  assert.equal((bad.match(/绝对路径/g) ?? []).length, 1, '文案不应重复')
  const target = tempDir()
  const ok = await call(tools, 'task_create', { ...sampleBrief({ title: '带目录' }), target })
  assert.match(ok, /已派发/)
  const row = db.prepare("SELECT target_dir FROM tasks WHERE title = '带目录'").get()
  assert.equal(row.target_dir, target)
  const task = listTasks(db).find(item => item.title === '带目录')
  const brief = db.prepare("SELECT rendered FROM messages WHERE kind = 'brief' ORDER BY rowid DESC LIMIT 1").get()
  assert.match(brief.rendered, new RegExp(`【任务编号】${task.id}`))
  assert.equal(brief.rendered.includes('【工作目录】'), false)
  const detail = await call(tools, 'task_detail', { task_id: task.id }, { agent: { id: task.session_id } })
  assert.match(detail, /工作目录：/)
  assert.equal(detail.includes(target), true)
  db.close()
})

test('task_create 拒绝不存在的绝对目录', async () => {
  const { db, tools } = await setup()
  const missing = join(tempDir(), 'nope')
  const result = await call(tools, 'task_create', { ...sampleBrief({ title: 'x' }), target: missing })
  assert.match(result, /不存在或不是目录/)
  assert.equal(listTasks(db).length, 0)
  db.close()
})


test('不传 target：唯一命中工作区 → target_dir 落工作区目录，详情里能看到工作目录', async () => {
  const target = tempDir()
  const workspaces = { list: () => [{ id: 'w1', title: '公众号文章', path: target }] }
  const { db, dispatcher, tools } = await setup({ workspaces })
  const result = await call(tools, 'task_create', { title: '公众号文章选题整理', goal: '给下一篇做准备', acceptance: ['a'] })
  assert.match(result, /已派发/)
  assert.match(result, /目标目录按工作区推断/)
  const task = listTasks(db)[0]
  assert.equal(task.target_dir, target)
  assert.equal(task.brief.target, target)
  const brief = db.prepare("SELECT rendered FROM messages WHERE kind = 'brief' ORDER BY rowid DESC LIMIT 1").get()
  assert.match(brief.rendered, /task_detail/)
  assert.equal(brief.rendered.includes('【工作目录】'), false)
  const detail = await call(tools, 'task_detail', { task_id: task.id }, { agent: { id: task.session_id } })
  assert.equal(detail.includes(`工作目录：${target}`), true)
  assert.equal(dispatcher.calls.length, 1)
  db.close()
})

test('不传 target：多命中工作区 → 列候选、不建任务、不派发', async () => {
  const workspaces = {
    list: () => [
      { id: 'a', title: '项目甲', path: tempDir() },
      { id: 'b', title: '项目乙', path: tempDir() },
    ],
  }
  const { db, dispatcher, tools } = await setup({ workspaces })
  const result = await call(tools, 'task_create', { title: '项目甲和项目乙的对比', goal: 'g', acceptance: ['a'] })
  assert.match(result, /匹配到多个工作区/)
  assert.match(result, /项目甲/)
  assert.match(result, /项目乙/)
  assert.equal(listTasks(db).length, 0)
  assert.equal(dispatcher.calls.length, 0)
  db.close()
})

test('不传 target：无命中 → 不写 target_dir，行为与旧版一致', async () => {
  const workspaces = { list: () => [{ id: 'w1', title: '公众号文章', path: tempDir() }] }
  const { db, dispatcher, tools } = await setup({ workspaces })
  const result = await call(tools, 'task_create', { title: '评审 Rust 文章', goal: '找错', acceptance: ['a'] })
  assert.match(result, /已派发/)
  assert.doesNotMatch(result, /按工作区推断/)
  assert.equal(listTasks(db)[0].target_dir, null)
  assert.equal(dispatcher.calls[0][4], undefined)
  db.close()
})

test('target 为空串/全空白与不传等价：走推断、不写空串', async () => {
  const inferredDir = tempDir()
  const workspaces = { list: () => [{ id: 'w1', title: '公众号文章', path: inferredDir }] }
  const { db, dispatcher, tools } = await setup({ workspaces })
  const first = await call(tools, 'task_create', { title: '公众号文章选题', goal: 'g', acceptance: ['a'], target: '' })
  assert.match(first, /已派发/)
  assert.equal(listTasks(db)[0].target_dir, inferredDir)
  const second = await call(tools, 'task_create', { title: '无关任务', goal: 'g', acceptance: ['a'], target: '   ' })
  assert.match(second, /已派发/)
  const other = listTasks(db).find(task => task.title === '无关任务')
  assert.equal(other.target_dir, null)
  // 空串/全空白都不能把 '' 传给 spawn 的 cwd。
  assert.equal(dispatcher.calls[0][4], inferredDir)
  assert.equal(dispatcher.calls[1][4], undefined)
  db.close()
})

test('显式 target 优先于工作区推断，且不受标题命中影响', async () => {
  const explicit = tempDir()
  const workspaces = { list: () => [{ id: 'w1', title: '公众号文章', path: tempDir() }] }
  const { db, tools } = await setup({ workspaces })
  const result = await call(tools, 'task_create', { title: '公众号文章选题', goal: 'g', acceptance: ['a'], target: explicit })
  assert.match(result, /已派发/)
  assert.doesNotMatch(result, /按工作区推断/)
  assert.equal(listTasks(db)[0].target_dir, explicit)
  db.close()
})

test('workspaces 服务缺失时按无工作区降级，不崩', async () => {
  const { db, tools } = await setup()
  const result = await call(tools, 'task_create', { title: '公众号文章选题', goal: 'g', acceptance: ['a'] })
  assert.match(result, /已派发/)
  assert.equal(listTasks(db)[0].target_dir, null)
  db.close()
})


test('task_report artifacts：相对路径按任务 target_dir 解析、存在性标注、通知带产物', async () => {
  const { writeFileSync: write } = await import('node:fs')
  const target = tempDir()
  const file = join(target, 'report.md')
  write(file, '# ok', 'utf8')
  const { db, notifier, tools } = await setup()
  await call(tools, 'task_create', { ...sampleBrief({ title: '产物任务' }), target })
  const task = listTasks(db)[0]
  const text = await call(tools, 'task_report', {
    task_id: task.id, status: 'done', summary: '完成',
    artifacts: [{ path: 'report.md', label: '报告' }, { path: 'missing.txt' }, { path: '' }, { bad: 1 }],
  }, { agent: { id: task.session_id } })
  assert.match(text, /已记录/)
  const saved = getTask(db, task.id).artifacts
  assert.deepEqual(saved.map(item => item.path), [file, join(target, 'missing.txt')])
  assert.deepEqual(saved.map(item => item.exists), [true, false])
  assert.equal(saved[0].label, '报告')
  const pushed = notifier.pushed.at(-1)
  assert.equal(pushed.artifacts[0].path, file)
})

test('task_report 不传 artifacts：完全兼容旧行为，任务照常交付待确认', async () => {
  const { db, tools } = await setup()
  await call(tools, 'task_create', sampleBrief({ title: '旧调用' }))
  const task = listTasks(db)[0]
  await call(tools, 'task_report', { task_id: task.id, status: 'done', summary: '完成' }, { agent: { id: task.session_id } })
  assert.equal(getTask(db, task.id).status, 'delivered')
  assert.deepEqual(getTask(db, task.id).artifacts, [])
})

test('task_report done 自动收集：未显式产物时用 workspaceChanges.summary 收集本会话全部改动', async () => {
  const { writeFileSync: write, mkdirSync } = await import('node:fs')
  const target = tempDir()
  mkdirSync(join(target, 'sub'))
  const first = join(target, 'a.md')
  const second = join(target, 'sub', 'b.txt')
  write(first, 'a', 'utf8')
  write(second, 'b', 'utf8')
  const changeEvents = [{ type: 'workspace/changes', seq: 7, data: { turn: 1 } }, { type: 'workspace/changes', seq: 11, data: { turn: 2 } }]
  const summaries = {
    7: { cwd: target, files: [{ path: 'a.md', added: 2, deleted: 0 }] },
    11: { cwd: target, files: [{ path: 'a.md', added: 4, deleted: 1 }, { path: 'sub/b.txt', added: 1, deleted: 0 }] },
  }
  const session = { id: 'c-auto', ownEvents: () => changeEvents }
  const { db, notifier, tools } = await setup({ workspaceChanges: { summary: (_id, seq) => summaries[seq] } })
  await call(tools, 'task_create', { ...sampleBrief({ title: '自动收集' }), target })
  const task = listTasks(db)[0]
  await call(tools, 'task_report', { task_id: task.id, status: 'done', summary: '完成' }, { agent: { id: task.session_id, session } })
  const saved = getTask(db, task.id).artifacts
  assert.deepEqual(saved.map(item => item.path), [first, second])
  assert.deepEqual(saved.map(item => item.label), ['+4/-1', '+1/-0'])
  assert.deepEqual(saved.map(item => item.exists), [true, true])
  assert.equal(notifier.pushed.at(-1).artifacts.length, 2)
})

test('task_report done 自动收集：没有改动事件时保持空产物，不伪造', async () => {
  const { db, tools } = await setup({ workspaceChanges: { summary: () => ({ cwd: tempDir(), files: [] }) } })
  await call(tools, 'task_create', sampleBrief({ title: '无改动' }))
  const task = listTasks(db)[0]
  const session = { id: 'c-empty', ownEvents: () => [] }
  const text = await call(tools, 'task_report', { task_id: task.id, status: 'done', summary: '完成' }, { agent: { id: task.session_id, session } })
  assert.match(text, /已记录/)
  assert.equal(getTask(db, task.id).status, 'delivered')
  assert.deepEqual(getTask(db, task.id).artifacts, [])
})

test('task_report done 自动收集：显式产物与自动收集按路径合并去重，显式标签优先', async () => {
  const { writeFileSync: write } = await import('node:fs')
  const target = tempDir()
  const shared = join(target, 'a.md')
  const autoOnly = join(target, 'b.txt')
  write(shared, 'a', 'utf8')
  write(autoOnly, 'b', 'utf8')
  const session = { id: 'c-merge', ownEvents: () => [{ type: 'workspace/changes', seq: 3, data: { turn: 1 } }] }
  const { db, tools } = await setup({
    workspaceChanges: {
      summary: () => ({ cwd: target, files: [{ path: 'a.md', added: 1, deleted: 0 }, { path: 'b.txt', added: 2, deleted: 0 }] }),
    },
  })
  await call(tools, 'task_create', { ...sampleBrief({ title: '合并去重' }), target })
  const task = listTasks(db)[0]
  await call(tools, 'task_report', {
    task_id: task.id, status: 'done', summary: '完成',
    artifacts: [{ path: 'a.md', label: '显式说明' }, { path: 'c.md', label: '手工补的' }],
  }, { agent: { id: task.session_id, session } })
  const saved = getTask(db, task.id).artifacts
  assert.deepEqual(saved.map(item => item.path), [shared, autoOnly, join(target, 'c.md')])
  assert.equal(saved.find(item => item.path === shared).label, '显式说明')
  assert.equal(saved.find(item => item.path === autoOnly).label, '+2/-0')
})


test('artifacts 最多保留 20 条，说明超长截断，通知标注未列出数量', async () => {
  const { db, notifier, tools } = await setup()
  await call(tools, 'task_create', sampleBrief({ title: '多产物' }))
  const task = listTasks(db)[0]
  const artifacts = Array.from({ length: 25 }, (_, index) => ({ path: `file-${index}.txt`, label: '说'.repeat(200) }))
  await call(tools, 'task_report', { task_id: task.id, status: 'done', summary: '完成', artifacts }, { agent: { id: task.session_id } })
  const saved = getTask(db, task.id).artifacts
  assert.equal(saved.length, 20)
  assert.equal(saved[0].path.endsWith('file-0.txt'), true)
  assert.equal(saved[0].label.length, 161)
  assert.equal(saved[0].label.endsWith('…'), true)
  assert.equal(notifier.pushed.at(-1).artifactsTruncated, 5)
  assert.equal(notifier.pushed.at(-1).artifacts.length, 20)
})

test('产物是目录时也算存在（只 stat，不读文件）', async () => {
  const { mkdirSync } = await import('node:fs')
  const target = tempDir()
  mkdirSync(join(target, 'dist'))
  const { db, tools } = await setup()
  await call(tools, 'task_create', { ...sampleBrief({ title: '目录产物' }), target })
  const task = listTasks(db)[0]
  await call(tools, 'task_report', { task_id: task.id, status: 'done', summary: '完成', artifacts: [{ path: 'dist' }] }, { agent: { id: task.session_id } })
  const saved = getTask(db, task.id).artifacts
  assert.equal(saved[0].path, join(target, 'dist'))
  assert.equal(saved[0].exists, true)
})

test('无 target 时相对产物按 defaultCwd（主会话目录）解析，而不是进程 cwd', async () => {
  const base = tempDir()
  const { db, tools } = await setup({ defaultCwd: base })
  await call(tools, 'task_create', sampleBrief({ title: '无目标产物' }))
  const task = listTasks(db)[0]
  assert.equal(task.target_dir, null)
  await call(tools, 'task_report', {
    task_id: task.id, status: 'done', summary: '完成', artifacts: [{ path: 'out/report.md' }],
  }, { agent: { id: task.session_id } })
  assert.equal(getTask(db, task.id).artifacts[0].path, join(base, 'out', 'report.md'))
})

test('多次回报的产物累积合并，不互相覆盖；同路径后报覆盖前报', async () => {
  const target = tempDir()
  const { db, tools } = await setup()
  await call(tools, 'task_create', { ...sampleBrief({ title: '累积产物' }), target })
  const task = listTasks(db)[0]
  await call(tools, 'task_report', {
    task_id: task.id, status: 'progress', summary: '第一步', artifacts: [{ path: 'a.md', label: 'A' }],
  }, { agent: { id: task.session_id } })
  await call(tools, 'task_report', {
    task_id: task.id, status: 'done', summary: '完成', artifacts: [{ path: 'b.md', label: 'B' }, { path: 'a.md', label: 'A2' }],
  }, { agent: { id: task.session_id } })
  const saved = getTask(db, task.id).artifacts
  assert.deepEqual(saved.map(item => item.path), [join(target, 'a.md'), join(target, 'b.md')])
  assert.equal(saved.find(item => item.path === join(target, 'a.md')).label, 'A2')
})

test('task_retry：failed 任务用原 brief 新建一次尝试，旧任务保留审计', async () => {
  const { db, tools } = await setup()
  const old = createTask(db, { brief: sampleBrief({ title: '要重试的任务', goal: '修好' }), coordinatorSession: 's-1' })
  transition(db, old.id, 'failed', { error: '子会话创建失败' })
  const text = await call(tools, 'task_retry', { task_id: old.id })
  assert.match(text, /已重派/)
  const retried = listTasks(db).find(task => task.retry_of === old.id)
  assert.ok(retried, '新任务要记录 retry_of')
  assert.equal(retried.status, 'running')
  assert.equal(getTask(db, old.id).status, 'failed')
  const spawned = listTasks(db).find(task => task.id === retried.id)
  assert.equal(spawned.title, '要重试的任务')
})

test('task_retry 只接受 failed/orphaned；其他状态不新建', async () => {
  const { db, tools } = await setup()
  const running = createTask(db, { brief: sampleBrief({ title: '在跑' }), coordinatorSession: 's-1' })
  transition(db, running.id, 'running', { sessionId: 'c-1', target: 'c-1' })
  const before = listTasks(db).length
  const text = await call(tools, 'task_retry', { task_id: running.id })
  assert.match(text, /不能重派|只有失败/)
  assert.equal(listTasks(db).length, before)
})

test('memory_note 写入并可按关键词检索；done 回报自动沉淀', async () => {
  const { db, tools } = await setup()
  const noted = await call(tools, 'memory_note', { text: '用户偏好用 pnpm，不要 npm install', kind: 'preference' })
  assert.match(noted, /已记住/)
  const found = await call(tools, 'history_search', { query: 'pnpm' })
  assert.match(found, /用户偏好用 pnpm/)
  // 重复写入幂等
  const again = await call(tools, 'memory_note', { text: '用户偏好用 pnpm，不要 npm install', kind: 'preference' })
  assert.match(again, /已经记过/)

  await call(tools, 'task_create', sampleBrief({ title: '登录修复', goal: '修复登录' }))
  const task = listTasks(db).find(item => item.title === '登录修复')
  await call(tools, 'task_report', { task_id: task.id, status: 'done', summary: '改用 session cookie' }, { agent: { id: task.session_id } })
  const done = await call(tools, 'history_search', { query: 'session cookie' })
  assert.match(done, /登录修复/)
})

// ---- T1 brief 纯指引化：详情全走 task_detail ----

const longGoal = '把 brief 精简成指引加指针'.repeat(20)

test('T1 brief 纯指引：目标与经验都不进提示词，详情在 task_detail 里现取', async () => {
  const stateDir = tempDir()
  const target = tempDir()
  const { db, dispatcher, tools } = await setup({ stateDir })
  await call(tools, 'memory_note', { text: '登录模块统一走 session cookie', kind: 'decision' })
  await call(tools, 'task_create', { ...sampleBrief({ title: '修复登录模块', goal: longGoal }), target })
  const task = listTasks(db).find(item => item.title === '修复登录模块')
  const prompt = dispatcher.calls.find(callRow => callRow[0] === 'spawn')[2]
  // 提示词只有两行：任务编号 + task_detail 指引。
  const promptLines = prompt.split('\n')
  assert.equal(promptLines.length, 2)
  assert.equal(promptLines[0], `【任务编号】${task.id}`)
  assert.match(prompt, /task_detail/)
  assert.equal(prompt.includes(longGoal.slice(0, 20)), false)
  assert.equal(prompt.includes('session cookie'), false)
  for (const section of ['【目标】', '【目标兜底】', '【历史经验】', '【验收标准】', 'get_goal']) {
    assert.equal(prompt.includes(section), false, `brief 不应内联 ${section}`)
  }
  // 详情：目标全文 + 经验文件指针（完整内容在文件里，可 read）。
  const detail = await call(tools, 'task_detail', { task_id: task.id }, { agent: { id: task.session_id } })
  assert.equal(detail.includes(longGoal), true)
  assert.match(detail, /【验收标准】/)
  const pointerLine = detail.split('\n').find(line => line.startsWith('【经验文件】'))
  assert.ok(pointerLine !== undefined, detail)
  assert.match(pointerLine, /（1 条）｜可 read 全文/)
  const path = pointerLine.slice('【经验文件】'.length).split('（1 条）')[0]
  assert.equal(path.startsWith(join(stateDir, 'lessons')), true)
  assert.equal(existsSync(path), true)
  assert.equal(readFileSync(path, 'utf8').includes('session cookie'), true)
  // 指针模式不在详情里重复正文（避免详情又变长）。
  assert.equal(detail.includes('【历史经验】'), false)
  db.close()
})

test('T1 经验降级：stateDir 缺失时经验只进 task_detail（内联块），brief 仍是纯指引', async () => {
  const { db, dispatcher, tools } = await setup()
  await call(tools, 'memory_note', { text: '登录模块统一走 session cookie', kind: 'decision' })
  await call(tools, 'task_create', sampleBrief({ title: '修复登录模块', goal: '登录异常' }))
  const task = listTasks(db).find(item => item.title === '修复登录模块')
  const prompt = dispatcher.calls.find(callRow => callRow[0] === 'spawn')[2]
  assert.equal(prompt.includes('session cookie'), false)
  assert.equal(prompt.includes('【历史经验】'), false)
  const detail = await call(tools, 'task_detail', { task_id: task.id }, { agent: { id: task.session_id } })
  assert.match(detail, /【历史经验】\n/)
  assert.match(detail, /session cookie/)
  assert.equal(detail.includes('【经验文件】'), false)
  db.close()
})

test('T1 不相关经验：task_create 不为无关任务建经验指针，详情里没有经验小节', async () => {
  const stateDir = tempDir()
  const { db, dispatcher, tools } = await setup({ stateDir })
  await call(tools, 'memory_note', { text: '登录模块统一走 session cookie', kind: 'decision' })
  await call(tools, 'task_create', sampleBrief({ title: '写周报', goal: '整理本周进度' }))
  const task = listTasks(db).find(item => item.title === '写周报')
  assert.equal(task.brief.experience, undefined)
  const detail = await call(tools, 'task_detail', { task_id: task.id }, { agent: { id: task.session_id } })
  assert.equal(detail.includes('【经验文件】'), false)
  assert.equal(detail.includes('【历史经验】'), false)
  assert.equal(dispatcher.calls.length, 1)
  db.close()
})

test('T1 重派：task_retry 重渲染的 brief 与 task_create 同口径（任务编号 + 指引）', async () => {
  const { db, dispatcher, tools } = await setup()
  const created = createTask(db, { brief: { ...sampleBrief({ title: '重派目标' }), goal: longGoal }, coordinatorSession: 's-1' })
  transition(db, created.id, 'failed', { error: '子会话创建失败' })
  const text = await call(tools, 'task_retry', { task_id: created.id })
  assert.match(text, /已重派/)
  const retried = listTasks(db).find(task => task.retry_of === created.id)
  const rendered = recentMessages(db, retried.id, 1)[0].rendered
  assert.equal(rendered.split('\n')[0], `【任务编号】${retried.id}`)
  assert.match(rendered, /task_detail/)
  assert.equal(rendered.includes(longGoal), false)
  assert.equal(dispatcher.calls.some(callRow => callRow[0] === 'spawn'), true)
  // 重派的新任务自己的子会话能读到原目标全文。
  const detail = await call(tools, 'task_detail', { task_id: retried.id }, { agent: { id: retried.session_id } })
  assert.equal(detail.includes(longGoal), true)
  db.close()
})

test('history_search 合并 memories、历史任务与 sessionQuery 结果', async () => {
  const sessionQuery = {
    async searchSessions(request) {
      assert.equal(request.query, '登录')
      return { items: [{ header: { id: 's-old', cwd: undefined }, bestMatch: { snippet: '旧会话里讨论过登录' } }] }
    },
  }
  const { db, tools } = await setup({ sessionQuery })
  const done = createTask(db, { brief: sampleBrief({ title: '登录旧任务', goal: '修登录' }), coordinatorSession: 's-1' })
  transition(db, done.id, 'running', { sessionId: 'c-1', target: 'c-1' })
  transition(db, done.id, 'done')
  await call(tools, 'memory_note', { text: '登录用 cookie' })
  const text = await call(tools, 'history_search', { query: '登录', limit: 5 })
  assert.match(text, /【记忆】/)
  assert.match(text, /【历史任务】/)
  assert.match(text, /【历史会话】/)
  assert.match(text, /s-old/)
})

test('project_context 读取白名单文件与顶层结构，不读 .env，不输出任意文件', async () => {
  const { writeFileSync, mkdirSync } = await import('node:fs')
  const project = tempDir()
  writeFileSync(join(project, 'README.md'), '# 示例项目\n这是说明。', 'utf8')
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'node --test' }, dependencies: { react: '^19' } }), 'utf8')
  writeFileSync(join(project, '.env'), 'SECRET=should-not-appear', 'utf8')
  mkdirSync(join(project, 'src'))
  const { tools } = await setup()
  const text = await call(tools, 'project_context', { target: project })
  assert.match(text, /【项目】/)
  assert.match(text, /示例项目/)
  assert.match(text, /demo/)
  assert.match(text, /src\//)
  assert.doesNotMatch(text, /should-not-appear/)
  assert.doesNotMatch(text, /SECRET=/)
})

test('依赖：前置未完成时建 waiting_dep、不派发；前置 done 后自动晋升，前置摘要/产物在 task_detail 里', async () => {
  const { writeFileSync } = await import('node:fs')
  const target = tempDir()
  const depFile = join(target, 'dep.md')
  writeFileSync(depFile, '# dep', 'utf8')
  const { db, dispatcher, tools } = await setup()
  const first = await call(tools, 'task_create', { ...sampleBrief({ title: '前置' }), target })
  assert.match(first, /已派发/)
  const depTask = listTasks(db).find(task => task.title === '前置')
  await call(tools, 'task_report', {
    task_id: depTask.id, status: 'done', summary: '前置已完成', artifacts: [{ path: 'dep.md', label: '前置产物' }],
  }, { agent: { id: depTask.session_id } })
  // 两段式终态：交付≠done，依赖就绪只认 done，所以这里要先确认。
  await call(tools, 'task_close', { task_id: depTask.id })

  const second = await call(tools, 'task_create', {
    ...sampleBrief({ title: '下游' }), target, dependsOn: [depTask.id], group: '发布', priority: 5,
  })
  assert.match(second, /已派发/)
  const downstream = listTasks(db).find(task => task.title === '下游')
  assert.equal(downstream.depends_on[0], depTask.id)
  assert.equal(downstream.group_id, '发布')
  assert.equal(downstream.priority, 5)
  const prompt = dispatcher.calls.filter(callRow => callRow[0] === 'spawn').at(-1)[2]
  // T1：派发提示词不拼前置摘要（避免快照过期），改为子会话 task_detail 现读。
  assert.equal(prompt.includes('【前置任务】'), false)
  assert.match(prompt, /task_detail/)
  const detail = await call(tools, 'task_detail', { task_id: downstream.id }, { agent: { id: downstream.session_id } })
  assert.match(detail, /【前置任务】/)
  assert.match(detail, /前置已完成/)
  assert.match(detail, /dep\.md/)
})

test('依赖：前置运行中时下游 waiting_dep，前置交付并确认后晋升；前置失败时下游自动失败', async () => {
  const { db, dispatcher, tools } = await setup()
  const first = await call(tools, 'task_create', sampleBrief({ title: '前置A' }))
  assert.match(first, /已派发/)
  const dep = listTasks(db).find(task => task.title === '前置A')
  const second = await call(tools, 'task_create', { ...sampleBrief({ title: '下游B' }), dependsOn: [dep.id] })
  assert.match(second, /等待前置任务/)
  const waiting = listTasks(db).find(task => task.title === '下游B')
  assert.equal(waiting.status, 'waiting_dep')
  assert.equal(dispatcher.calls.filter(callRow => callRow[0] === 'spawn').length, 1)

  await call(tools, 'task_report', { task_id: dep.id, status: 'done', summary: 'A 完成' }, { agent: { id: dep.session_id } })
  await new Promise(resolve => setTimeout(resolve, 10))
  // 交付但未确认：下游仍在等（依赖就绪只认 done）。
  assert.equal(listTasks(db).find(task => task.title === '下游B').status, 'waiting_dep')
  await call(tools, 'task_close', { task_id: dep.id })
  await new Promise(resolve => setTimeout(resolve, 10))
  const promoted = listTasks(db).find(task => task.title === '下游B')
  assert.equal(promoted.status, 'running')
  assert.equal(dispatcher.calls.filter(callRow => callRow[0] === 'spawn').length, 2)

  const third = await call(tools, 'task_create', sampleBrief({ title: '前置C' }))
  assert.match(third, /已派发/)
  const depC = listTasks(db).find(task => task.title === '前置C')
  const fourth = await call(tools, 'task_create', { ...sampleBrief({ title: '下游D' }), dependsOn: [depC.id] })
  assert.match(fourth, /等待前置任务/)
  const failedDown = listTasks(db).find(task => task.title === '下游D')
  await call(tools, 'task_stop', { task_id: depC.id })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(getTask(db, failedDown.id).status, 'failed')
  assert.match(getTask(db, failedDown.id).error, /前置任务未完成/)
})

test('优先级：高优先级任务先派发', async () => {
  const { db, dispatcher, tools, queue } = await setup({ limit: 1 })
  const low = await call(tools, 'task_create', { ...sampleBrief({ title: '低优先级' }), priority: 1 })
  assert.match(low, /已派发/)
  const high = await call(tools, 'task_create', { ...sampleBrief({ title: '高优先级' }), priority: 9 })
  assert.match(high, /排队/)
  dispatcher.release()
  await queue.pump()
  const prompts = dispatcher.calls.filter(callRow => callRow[0] === 'spawn').map(callRow => callRow[2])
  assert.ok(prompts.length >= 2)
  const highTask = listTasks(db).find(task => task.title === '高优先级')
  // brief 是纯指引：用【任务编号】确认派发的是高优先级那条，而不是靠标题。
  assert.match(prompts.at(-1), new RegExp(`【任务编号】${highTask.id}`))
})

test('写域冲突只提示不阻断；同组任务可按 group 过滤看进度', async () => {
  const { db, tools } = await setup()
  await call(tools, 'task_create', { ...sampleBrief({ title: '写域A' }), writeScopes: ['src/api'], group: 'G' })
  const second = await call(tools, 'task_create', { ...sampleBrief({ title: '写域B' }), writeScopes: ['src'], group: 'G' })
  assert.match(second, /已派发/)
  assert.match(second, /写域与活跃任务冲突/)
  const list = await call(tools, 'task_list', { group: 'G', active: true })
  assert.match(list, /组「G」/)
  assert.match(list, /写域A/)
  assert.match(list, /写域B/)
  assert.equal(listTasks(db).filter(task => task.group_id === 'G').length, 2)
})

test('依赖校验：不存在或已失败的前置任务不能作为依赖', async () => {
  const { db, tools } = await setup()
  const missing = await call(tools, 'task_create', { ...sampleBrief({ title: '缺前置' }), dependsOn: ['t-nope'] })
  assert.match(missing, /前置任务不存在/)
  const failed = createTask(db, { brief: sampleBrief({ title: '失败前置' }), coordinatorSession: 's-1' })
  transition(db, failed.id, 'failed', { error: 'boom' })
  const rejected = await call(tools, 'task_create', { ...sampleBrief({ title: '依赖失败前置' }), dependsOn: [failed.id] })
  assert.match(rejected, /不能作为依赖/)
})

test('task_retry 保留依赖/分组/写域/优先级', async () => {
  const { db, tools } = await setup()
  const dep = createTask(db, { brief: sampleBrief({ title: '已完成前置' }), coordinatorSession: 's-1' })
  transition(db, dep.id, 'running', { sessionId: 'c-dep', target: 'c-dep' })
  transition(db, dep.id, 'done')
  const old = createTask(db, {
    brief: sampleBrief({ title: '待重派' }), coordinatorSession: 's-1',
    dependsOn: [dep.id], groupId: 'G', writeScopes: ['src'], priority: 3, status: 'pending',
  })
  transition(db, old.id, 'failed', { error: 'boom' })
  const text = await call(tools, 'task_retry', { task_id: old.id })
  assert.match(text, /已重派/)
  const retried = listTasks(db).find(task => task.retry_of === old.id)
  assert.deepEqual(retried.depends_on, [dep.id])
  assert.equal(retried.group_id, 'G')
  assert.deepEqual(retried.write_scopes, ['src'])
  assert.equal(retried.priority, 3)
})

test('task_inbox 汇总待你决定，并带出 blocked 的问题/选项', async () => {
  const { db, tools } = await setup()
  await call(tools, 'task_create', sampleBrief({ title: '要拍板' }))
  const task = listTasks(db).find(item => item.title === '要拍板')
  await call(tools, 'task_report', {
    task_id: task.id, status: 'blocked', summary: '两个方案都行',
    question: '选哪个方案？', options: ['方案A', '方案B'],
  }, { agent: { id: task.session_id } })
  const saved = getTask(db, task.id)
  assert.equal(saved.question, '选哪个方案？')
  assert.deepEqual(saved.options, ['方案A', '方案B'])
  const inbox = await call(tools, 'task_inbox', {})
  assert.match(inbox, /【待你决定】1/)
  assert.match(inbox, /选哪个方案/)
  assert.match(inbox, /方案A \/ 方案B/)
  const status = await call(tools, 'task_status', { task_id: task.id })
  assert.match(status, /问题：选哪个方案/)
})

test('连续 progress 达到 stallRounds 时推一条「可能卡住」通知，不重复刷', async () => {
  const { db, notifier, tools } = await setup()
  await call(tools, 'task_create', sampleBrief({ title: '卡住任务' }))
  const task = listTasks(db).find(item => item.title === '卡住任务')
  for (let index = 0; index < 4; index += 1) {
    await call(tools, 'task_report', { task_id: task.id, status: 'progress', summary: `第 ${index + 1} 次` }, { agent: { id: task.session_id } })
  }
  const stalled = notifier.pushed.filter(item => item.status === 'stalled')
  assert.equal(stalled.length, 1)
  assert.match(stalled[0].summary, /连续 3 次/)
  assert.equal(getTask(db, task.id).progress_count, 4)
})

test('M1 分层：done 只沉淀 task-log（一行、无产物清单），不注入下个 brief，history_search 仍能查到', async () => {
  const { db, dispatcher, tools } = await setup()
  await call(tools, 'task_create', sampleBrief({ title: '登录修复', goal: '修复登录' }))
  const task = listTasks(db).find(item => item.title === '登录修复')
  // 真实回报常见形态：一句结论 + 一串产物路径 + 一段贴回来的代码。
  const summary = [
    '替换了登录校验逻辑。',
    'C:\\work\\a\\src\\login.js',
    'C:\\work\\a\\src\\session.js',
    'C:\\work\\a\\test\\login.test.js',
    '```js',
    'console.log("debug dump")',
    '```',
  ].join('\n')
  await call(tools, 'task_report', { task_id: task.id, status: 'done', summary }, { agent: { id: task.session_id } })

  const rows = db.prepare('SELECT kind, text FROM memories').all()
  const logs = rows.filter(row => row.kind === 'task-log')
  assert.equal(logs.length, 1)
  assert.ok(logs[0].text.length <= 180)
  assert.equal(rows.some(row => row.kind === 'task-done'), false) // 新写入不再是旧 kind
  assert.match(logs[0].text, /登录修复/)
  assert.equal(logs[0].text.includes('login.js'), false) // 不落产物路径清单
  assert.equal(logs[0].text.includes('console.log'), false) // 不落 verbatim 代码
  assert.equal(rows.some(row => row.kind === 'lesson'), false) // 没有经验标记就不造 lesson

  // 下个同类任务：日志层不进详情（brief 本身已不含经验，详情里也只有事实层）。
  await call(tools, 'task_create', sampleBrief({ title: '再修登录', goal: '修复登录' }))
  const next = listTasks(db).find(item => item.title === '再修登录')
  const prompts = dispatcher.calls.filter(callRow => callRow[0] === 'spawn').map(callRow => callRow[2])
  assert.equal(prompts.length, 2)
  assert.doesNotMatch(prompts[1], /【历史经验】/)
  const detail = await call(tools, 'task_detail', { task_id: next.id }, { agent: { id: next.session_id } })
  assert.doesNotMatch(detail, /【历史经验】/)
  assert.doesNotMatch(detail, /替换了登录校验逻辑/)

  // 显式查历史时日志层可见，并标出层
  const found = await call(tools, 'history_search', { query: '登录校验' })
  assert.match(found, /【记忆】/)
  assert.match(found, /\[日志\]/)
  assert.match(found, /登录修复/)
})

test('M1 分层：done 摘要里的经验分句蒸馏成 lesson 原子事实并进后续任务详情；verbatim/命令不注入', async () => {
  const { db, dispatcher, tools } = await setup()
  await call(tools, 'task_create', sampleBrief({ title: '登录修复', goal: '修复登录' }))
  const task = listTasks(db).find(item => item.title === '登录修复')
  const summary = [
    '结论：登录模块先查半成品再动手。',
    '经验：小步提交避免一次改太多。',
    '> 用户原话：把完整日志贴给我。',
    '$ npm test -- --watch',
  ].join('\n')
  await call(tools, 'task_report', { task_id: task.id, status: 'done', summary }, { agent: { id: task.session_id } })

  const lessons = db.prepare("SELECT text FROM memories WHERE kind = 'lesson'").all().map(row => row.text)
  assert.equal(lessons.length, 2)
  assert.ok(lessons.every(text => text.length <= 160))
  assert.equal(lessons.some(text => text.includes('先查半成品')), true)

  await call(tools, 'task_create', sampleBrief({ title: '再修登录', goal: '登录异常' }))
  const next = listTasks(db).find(item => item.title === '再修登录')
  const prompt = dispatcher.calls.filter(callRow => callRow[0] === 'spawn')[1][2]
  // T1：经验不进 brief 提示词，只进 task_detail（stateDir 缺失时是内联块降级）。
  assert.doesNotMatch(prompt, /【历史经验】/)
  assert.doesNotMatch(prompt, /先查半成品/)
  const detail = await call(tools, 'task_detail', { task_id: next.id }, { agent: { id: next.session_id } })
  assert.match(detail, /【历史经验】/)
  assert.match(detail, /先查半成品/)
  assert.match(detail, /\[经验\]/)
  assert.doesNotMatch(detail, /任务「登录修复」完成/) // 日志层不注入
  assert.doesNotMatch(detail, /用户原话：把完整日志贴给我/)
  assert.doesNotMatch(detail, /npm test -- --watch/)
})

test('M1 写入即蒸馏：memory_note 去代码块与命令日志，长文本截断为原子事实', async () => {
  const { db, tools } = await setup()
  const raw = '登录统一走 session cookie。\n```js\nconsole.log(1)\n```\n补充：' + '很长的背景'.repeat(60)
  const noted = await call(tools, 'memory_note', { text: raw, kind: 'lesson' })
  assert.match(noted, /已记住/)
  const row = db.prepare('SELECT kind, text FROM memories').all()[0]
  assert.equal(row.kind, 'lesson')
  assert.ok(row.text.length <= 160)
  assert.equal(row.text.includes('console.log'), false)
  assert.match(row.text, /session cookie/)
  // 幂等：蒸馏后的同一条不会重复写
  const again = await call(tools, 'memory_note', { text: raw, kind: 'lesson' })
  assert.match(again, /已经记过/)
})
