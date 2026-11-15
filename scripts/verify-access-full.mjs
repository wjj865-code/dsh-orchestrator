#!/usr/bin/env node
// 离线验证 per-task 完整访问（access:'full'）：不派真实子会话，只跑插件的真实代码路径，
// 把「台账 → brief → 派发参数 → 会话沙箱事件 → 通知」整条链打出来，便于人工核对。
//
// 为什么不是「真的派一个任务」：脚本跑在子会话里，没有 task_create 权限（requireMain 只放主会话），
// 而真实沙箱注入需要宿主进程里活着的 subagents 服务。这里用桩替代平台服务，
// 其余（createTools / createQueue / createDispatcher / ledger / brief）都是生产代码。
//
// 用法：node scripts/verify-access-full.mjs

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openLedger, createTask, getTask } from '../src/ledger.js'
import { renderBrief } from '../src/brief.js'
import { createTools } from '../src/tools.js'
import { createQueue } from '../src/queue.js'
import { createSubagentDispatcher } from '../src/dispatch.js'

const line = (title) => console.log(`\n=== ${title} ===`)

// 平台侧折折叠规则（见 @deepseek-ai/dsh-sandbox-policy/lib/types/session-mode.d.ts）：
// 每个会话自己的日志里最后一条 sandbox/mode 事件就是该会话的覆盖值，缺省回落部署默认。
const foldModes = appends => {
  const modes = new Map()
  for (const [childId, event, payload] of appends) {
    if (event === 'sandbox/mode') modes.set(childId, payload)
  }
  return modes
}

const sessionAppends = []
const sessionsById = new Map()
const parentAgent = { id: 'a-parent', session: { id: 's-parent', header: { cwd: process.cwd() } } }

// 只桩平台服务：startActivation 会给子会话建 session 对象并记下 append 事件。
const subagents = {
  async startActivation(spec) {
    const session = {
      id: spec.childId,
      header: { cwd: spec.cwd ?? process.cwd() },
      append(event, payload) { sessionAppends.push([spec.childId, event, payload]) },
    }
    sessionsById.set(spec.childId, session)
    return {
      childId: spec.childId,
      messageId: 'm1',
      result: Promise.resolve({ stopReason: 'completed' }),
      dispose: async () => {},
    }
  },
  async sendMessage() { return 'msg' },
  async interruptByParent() {},
  async listChildren() { return [] },
}

// sandboxPolicy 桩：overrideOf 读「本会话日志里最后一条 sandbox/mode」，与平台一致。
const sandboxPolicy = {
  overrideOf: session => foldModes(sessionAppends).get(session.id)?.mode,
  registerWritableRoot(session, dir) {
    console.log(`  [writable-root] ${session.id} → ${dir}`)
    return () => {}
  },
}

const dispatcher = createSubagentDispatcher({
  subagents,
  agent: parentAgent,
  agents: () => ({ get: id => (sessionsById.has(id) ? { id, session: sessionsById.get(id) } : undefined) }),
  sessions: () => ({ get: id => sessionsById.get(id) }),
  sandboxPolicy: () => sandboxPolicy,
})

const dir = mkdtempSync(join(tmpdir(), 'orch-access-full-'))
const db = await openLedger(dir)
const notifier = { pushed: [], push(item) { this.pushed.push(item) } }
const events = []
const config = { staleMinutes: 30, maxQueue: 50, coordinatorSession: 's-parent' }
const queue = createQueue({ db, dispatcher, config })
const tools = Object.fromEntries(createTools({
  db,
  dispatcher,
  queue,
  notifier,
  config,
  coordinatorStatus: () => ({ id: 's-parent', live: true }),
  logger: { log: (event, fields) => events.push([event, fields]) },
}).map(tool => [tool.name, tool]))

const asMain = (name, args) => tools[name].execute(args, { agent: { id: 's-parent' } })

line('1. 默认任务（不传 access）')
await asMain('task_create', { title: '普通任务', goal: 'g', acceptance: ['a'] })
const normal = db.prepare("SELECT * FROM tasks WHERE title = '普通任务'").get()

line("2. 完整访问任务（access:'full'）")
const reply = await asMain('task_create', {
  title: '构建发版', goal: '打一个包', acceptance: ['产物落盘'], access: 'full',
})
console.log(reply)
const full = db.prepare("SELECT * FROM tasks WHERE title = '构建发版'").get()

line('3. 台账（审计）')
console.log(`普通任务  access=${JSON.stringify(getTask(db, normal.id).access)}  session=${normal.session_id}`)
console.log(`构建发版  access=${JSON.stringify(getTask(db, full.id).access)}  session=${full.session_id}`)
console.log(`task.create.created: ${JSON.stringify(events.filter(([e]) => e === 'task.create.created').map(([, f]) => f.detail))}`)

line('4. 派发给子会话的 brief')
console.log(renderBrief({ taskId: full.id, access: 'full' }))

line('5. 会话沙箱事件 + 折叠后的有效模式（平台规则：本会话最后一条 sandbox/mode）')
const modes = foldModes(sessionAppends)
for (const task of [normal, full]) {
  const mode = modes.get(task.session_id)?.mode
  console.log(`  ${task.title}: append=${JSON.stringify(modes.get(task.session_id) ?? null)} → 有效模式=${mode ?? '(未覆盖，沿用会话策略)'}`)
}
const leaked = [...modes.keys()].filter(id => id !== full.session_id)
console.log(`  其他会话被注入的事件：${leaked.length} 条（应为 0，即不污染其他任务）`)

line('6. 通知文案')
await tools.task_report.execute(
  { task_id: full.id, status: 'done', summary: '包打好了' },
  { agent: { id: full.session_id } },
)
console.log(`  ${JSON.stringify(notifier.pushed.at(-1)?.access)} → 「${notifier.pushed.at(-1)?.title}（完整访问）」`)

line('7. 非法值 / 互斥（创建期拒绝）')
for (const args of [
  { title: '非法1', goal: 'g', acceptance: ['a'], access: 'workspace-write' },
  { title: '非法2', goal: 'g', acceptance: ['a'], access: true },
  { title: '互斥1', goal: 'g', acceptance: ['a'], access: 'full', readOnly: true },
  { title: '互斥2', goal: 'g', acceptance: ['a'], access: 'full', planFirst: true },
]) {
  console.log(`  ${JSON.stringify({ access: args.access, readOnly: args.readOnly, planFirst: args.planFirst })} → ${await asMain('task_create', args)}`)
}

db.close()
console.log(`\n台账目录（临时，可删）：${dir}`)
