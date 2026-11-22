// 版本 B《ID 出口网关》§6.6：**输出契约不变**（只把引用值换成 tk-）。
//
// 为什么需要它：版本 B 放宽了 `task_id` 的**可接受值**（新增 tk-），但工具接口本身一字不能改——
// 参数名、参数个数、类型、枚举、必填形态，以及回执的**行结构与字段顺序**都必须冻结。
// 没有这层锁，下一次「顺手加个参数」或「顺手调一行顺序」就会静默破坏调用方（协调者提示词、
// 面板、外部脚本）而不自知。
//
// 断言分三块：
//   1. schema 快照：五个 task_* + plan_save 的入参结构逐字冻结；
//   2. 回执行结构：task_status / task_list / task_create 的行前缀与顺序冻结（值允许是 tk-）；
//   3. 任务行结构：`ref` 是**新增**字段，`id` 等原有字段一个不少（台账读取面不被改写）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { openLedger, createTask, getTask, listTasks } from '../src/ledger.js'
import { createTools } from '../src/tools.js'
import { createQueue } from '../src/queue.js'
import { sampleBrief, tempDir } from './helpers.js'

function fakeDispatcher() {
  let counter = 0
  return {
    async spawn(input) { counter += 1; return { id: `c-${counter}`, name: input.name, sessionId: `c-${counter}`, target: `c-${counter}` } },
    async sendReliable() { return { messageId: 'm-1' } },
    async stop() {},
    releaseWritableRoots() {},
    slug() { counter += 1; return `task-${counter}` },
  }
}

async function setup() {
  const db = await openLedger(tempDir())
  const dispatcher = fakeDispatcher()
  const notifier = { pushed: [], push(item) { this.pushed.push(item) } }
  const config = { staleMinutes: 30, maxQueue: 50, coordinatorSession: 's-1' }
  const queue = createQueue({ db, dispatcher, config })
  const tools = Object.fromEntries(createTools({
    db, dispatcher, queue, notifier, config,
    coordinatorStatus: () => ({ id: 's-1', live: true }),
    defaultCwd: () => tempDir(),
  }).map(tool => [tool.name, tool]))
  return { db, tools }
}

const asMain = (tools, name, args) => tools[name].execute(args, { agent: { id: 's-1' } })

/** 入参的「结构指纹」：参数名 + 类型 + 枚举 + 数组元素类型（description 不算契约，允许随文案更新）。 */
const schemaFingerprint = parameters => {
  const props = parameters?.properties ?? {}
  const out = {}
  for (const key of Object.keys(props).sort()) {
    const spec = props[key] ?? {}
    out[key] = {
      type: spec.type ?? null,
      ...(Array.isArray(spec.enum) ? { enum: [...spec.enum] } : {}),
      ...(spec.type === 'array' ? { items: spec.items?.type ?? null } : {}),
    }
  }
  return out
}

test('schema 快照：五个 task_* + plan_save 的入参结构冻结（仍是 task_id 一个标识参数）', async () => {
  const { db, tools } = await setup()
  // 冻结值：改这里 = 改工具接口，必须同步协调者提示词、README 与 docs/TOOLS.md。
  const expected = {
    task_create: {
      title: { type: 'string' }, goal: { type: 'string' }, constraints: { type: 'array', items: 'string' },
      acceptance: { type: 'array', items: 'string' }, checks: { type: 'array', items: 'object' },
      refs: { type: 'array', items: 'string' }, user_verbatim: { type: 'string' }, teamTaskId: { type: 'string' },
      target: { type: 'string' }, readOnly: { type: 'boolean' }, planFirst: { type: 'boolean' },
      access: { type: 'string', enum: ['full'] }, dependsOn: { type: 'array', items: 'string' },
      group: { type: 'string' }, goalRounds: { type: 'number' }, writeScopes: { type: 'array', items: 'string' },
      priority: { type: 'number' }, allowConcurrent: { type: 'boolean' }, worktree: { type: 'boolean' },
      worktreeBase: { type: 'string' }, worktreeBranch: { type: 'string' }, worktreeMode: { type: 'string' },
      worktreeCleanup: { type: 'string' },
    },
    task_list: {
      view: { type: 'string', enum: ['list', 'inbox'] }, active: { type: 'boolean' },
      group: { type: 'string' }, limit: { type: 'number' },
    },
    task_status: { task_id: { type: 'string' }, include: { type: 'string' } },
    task_message: {
      task_id: { type: 'string' },
      action: { type: 'string', enum: ['message', 'resume', 'stop', 'retry', 'close'] },
      message: { type: 'string' },
    },
    task_detail: { task_id: { type: 'string' } },
    task_report: {
      task_id: { type: 'string' },
      status: { type: 'string', enum: ['progress', 'done', 'blocked', 'needs_auth'] },
      summary: { type: 'string' },
      workspace_index: { type: 'string' },
      question: { type: 'string' },
      options: { type: 'array', items: 'string' },
      artifacts: { type: 'array', items: 'object' },
    },
    plan_save: { task_id: { type: 'string' }, content: { type: 'string' } },
  }
  for (const [name, schema] of Object.entries(expected)) {
    assert.ok(tools[name], `工具应存在：${name}`)
    assert.deepEqual(schemaFingerprint(tools[name].parameters), schema, `${name} 入参结构变了`)
  }
  // 五个 task_* 的标识参数仍叫 task_id，且**没有**新增任何「引用专用」参数（值层面放宽，schema 零变化）。
  for (const name of ['task_status', 'task_message', 'task_detail', 'task_report', 'plan_save']) {
    const keys = Object.keys(tools[name].parameters.properties)
    assert.ok(keys.includes('task_id'), `${name} 应有 task_id`)
    assert.equal(keys.some(key => /ref|token|name/.test(key)), false, `${name} 不该新增标识参数`)
  }
  db.close()
})

test('回执行结构冻结：task_status 的行前缀与顺序不变（值可以是 tk-）', async () => {
  const { db, tools } = await setup()
  const created = await asMain(tools, 'task_create', sampleBrief({ title: '结构', goal: '目标', acceptance: ['a'] }))
  const ref = created.match(/（(tk-[0-9a-z]{6})）/)[1]
  const status = await asMain(tools, 'task_status', { task_id: ref })
  const lines = status.split('\n')
  // 行结构（前缀 + 顺序）是契约：只允许「引用值」不同。
  assert.match(lines[0], /^任务「结构（tk-[0-9a-z]{6}）」$/)
  assert.equal(lines[1], '状态：进行中')
  assert.match(lines[2], /^子会话：c-\d+$/)
  assert.equal(lines[3], '目标：目标')
  assert.equal(lines[4], '打开方式：协调者会话的子代理目录（subagent catalog），按上面的子会话 id 打开；它不在普通会话列表里。')
  assert.equal(lines[5], '最近消息：')
  assert.match(lines[6], /^- \[brief\] /)
  db.close()
})

test('回执行结构冻结：task_list 每行前缀「- 」+ 名字（引用）+ 状态标签', async () => {
  const { db, tools } = await setup()
  await asMain(tools, 'task_create', sampleBrief({ title: '列表', goal: 'g' }))
  const list = await asMain(tools, 'task_list', {})
  const lines = list.split('\n')
  assert.equal(lines.length, 1)
  // 例：- 列表（tk-abc123）｜进行中｜目标摘要…
  assert.match(lines[0], /^- 列表（tk-[0-9a-z]{6}）｜进行中/)
  db.close()
})

test('回执行结构冻结：task_create 回执句式不变（只把编号换成引用）', async () => {
  const { db, tools } = await setup()
  const created = await asMain(tools, 'task_create', sampleBrief({ title: '句式', goal: 'g' }))
  assert.match(created, /^任务「句式（tk-[0-9a-z]{6}）」已派发，子会话 c-\d+。/)
  db.close()
})

test('任务行结构：ref 是新增字段，原有字段一个不少（台账读取面不被改写）', async () => {
  const db = await openLedger(tempDir())
  const task = createTask(db, { brief: sampleBrief({ title: '行结构' }), coordinatorSession: 's-1' })
  // 版本 B 之前的字段集合（抽样：面板/回执/面板路由真正读的那些）+ 新增 ref / plan_path。
  for (const field of [
    'id', 'title', 'goal', 'brief', 'status', 'session_id', 'target', 'target_dir', 'artifacts',
    'coordinator_session', 'attempts', 'created_at', 'updated_at', 'last_event_at', 'error',
    'read_only', 'depends_on', 'group_id', 'write_scopes', 'priority', 'question', 'options',
    'plan_first', 'plan_state', 'access', 'worktree_state', 'delivered_at', 'close_reason',
    'acceptance', 'accepted_by', 'accepted_at', 'resume_count', 'team_task_id', 'team_task_revision',
    'planned_at', 'goal_rounds', 'goal_state', 'last_message',
  ]) {
    assert.equal(Object.hasOwn(task, field), true, `任务行缺字段：${field}`)
  }
  // 新增两列（版本 B）：ref（出口引用）与 plan_path（计划文档路径，幂等依据）。
  assert.match(task.ref, /^tk-[0-9a-z]{6}$/)
  assert.equal(task.plan_path, null)
  // 主键仍是台账编号：不改主键、不改派发/依赖语义。
  assert.match(task.id, /^t-[0-9a-f]{8}$/)
  assert.equal(getTask(db, task.id).id, task.id)
  assert.equal(listTasks(db).length, 1)
  db.close()
})

test('task_id 可接受值放宽（两种都行），但接口形态零变化', async () => {
  const { db, tools } = await setup()
  const created = await asMain(tools, 'task_create', sampleBrief({ title: '两种入参', goal: 'g' }))
  const ref = created.match(/（(tk-[0-9a-z]{6})）/)[1]
  const task = listTasks(db)[0]
  // 同一个任务：t-xxxx 与 tk- 调用结果**逐字相等**（§10 验收第一条）。
  const byId = await asMain(tools, 'task_status', { task_id: task.id })
  const byRef = await asMain(tools, 'task_status', { task_id: ref })
  assert.equal(byId, byRef)
  db.close()
})
