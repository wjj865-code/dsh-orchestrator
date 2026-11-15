// P8 计划交付：plan_save 把计划落盘到主会话工作区 reports/plans/<taskId>.md，
// 路径固定（只认任务编号）、禁止逃逸、越权拒绝，并自动登记为任务产物。
// 这里既断工具层（正常落盘 / 逃逸 / 无权限 / 空正文 / 超大正文），也断交付链路文案
// （计划说明、task_detail、task_create 提示、协调者 policy 用任务名汇报）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { openLedger, createTask, getTask, listTasks, transition } from '../src/ledger.js'
import { createTools } from '../src/tools.js'
import { createQueue } from '../src/queue.js'
import {
  MAX_PLAN_CHARS, PLAN_SUBDIR, escapesDir, isSafePlanTaskId, planDocPath, renderPlanDocument,
} from '../src/plan-doc.js'
import { PLAN_FIRST_DETAIL } from '../src/plan-mode.js'
import { renderTaskDetail } from '../src/task-detail.js'
import { COORDINATOR_DENY, renderCoordinatorPolicy } from '../index.js'
import { tempDir, sampleBrief } from './helpers.js'

function fakeDispatcher() {
  const calls = []
  let counter = 0
  return {
    calls,
    async spawn(input) {
      calls.push(['spawn', input])
      counter += 1
      return { id: `c-${counter}`, name: input.name, sessionId: `c-${counter}`, target: `c-${counter}` }
    },
    async sendReliable(target, message, signal, targetDir, taskId, readOnly) {
      calls.push(['sendReliable', target, message, readOnly])
      return { messageId: 'm-1' }
    },
    async stop(target) { calls.push(['stop', target]) },
    releaseWritableRoots(target) { calls.push(['release', target]) },
    slug() { counter += 1; return `task-${counter}` },
  }
}

async function setupTools({ mainDir } = {}) {
  const db = await openLedger(tempDir())
  const dispatcher = fakeDispatcher()
  const notifier = { pushed: [], push(item) { this.pushed.push(item) } }
  const config = { staleMinutes: 30, maxQueue: 50, coordinatorSession: 's-1' }
  const queue = createQueue({ db, dispatcher, config })
  const tools = Object.fromEntries(createTools({
    db, dispatcher, queue, notifier, config,
    coordinatorStatus: () => ({ id: 's-1', live: true }),
    defaultCwd: () => mainDir,
  }).map(tool => [tool.name, tool]))
  return { db, dispatcher, queue, notifier, tools }
}

/** 建一个已经在跑的计划任务（子会话 c-1）。 */
async function planTask(db) {
  const task = createTask(db, { brief: sampleBrief({ title: '落盘计划', goal: '目标' }), coordinatorSession: 's-1', planFirst: true })
  transition(db, task.id, 'running', { sessionId: 'c-1', target: 'c-1' })
  return getTask(db, task.id)
}

const asSub = (tools, name, args, agentId = 'c-1') => tools[name].execute(args, { agent: { id: agentId } })

test('P8 plan_save：计划写入主会话工作区 reports/plans/<taskId>.md 并登记为产物', async () => {
  const mainDir = join(tempDir(), 'main')
  const { db, tools } = await setupTools({ mainDir })
  const task = await planTask(db)
  const content = '# 目标\n- 改 src/a.js\n\n# 步骤\n1. 先读现状\n2. 再改'
  const text = await asSub(tools, 'plan_save', { task_id: task.id, content })

  const path = join(mainDir, 'reports', 'plans', `${task.id}.md`)
  assert.match(text, /计划已落盘/)
  assert.ok(text.includes(path), `工具结果应给出绝对路径：${text}`)
  assert.match(text, /3–8 行摘要/)
  assert.match(text, /待拍板问题清单/)
  assert.equal(existsSync(path), true)
  const body = readFileSync(path, 'utf8')
  // 文档头带任务名/编号/目标，正文原样保留。
  assert.match(body, /# 计划：落盘计划/)
  assert.match(body, new RegExp(`- 任务编号：${task.id}`))
  assert.match(body, /- 目标：目标/)
  assert.ok(body.includes('改 src/a.js'))
  assert.ok(body.includes('1. 先读现状'))

  // 登记产物：台账一条，路径 = 固定路径，存在性 true。
  const saved = getTask(db, task.id)
  assert.equal(saved.artifacts.length, 1)
  assert.equal(saved.artifacts[0].path, path)
  assert.equal(saved.artifacts[0].exists, true)
  assert.match(saved.artifacts[0].label, /计划文档/)
  // 计划状态不动：落盘不是批准。
  assert.equal(saved.plan_state, 'planning')
  assert.equal(saved.status, 'running')

  // 产物在协调者视角（task_status）和子会话视角（task_detail）都可见。
  const status = await tools.task_status.execute({ task_id: task.id }, { agent: { id: 's-1' } })
  assert.ok(status.includes(path), `task_status 应列出计划文档：${status}`)
  const detail = await tools.task_detail.execute({ task_id: task.id }, { agent: { id: task.session_id } })
  assert.match(detail, /【已有产物】/)
  assert.ok(detail.includes(path))
  db.close()
})

test('P8 plan_save：重复落盘覆盖同一份文件（只留一版），产物按路径去重', async () => {
  const mainDir = join(tempDir(), 'main')
  const { db, tools } = await setupTools({ mainDir })
  const task = await planTask(db)
  await asSub(tools, 'plan_save', { task_id: task.id, content: '第一版计划' })
  await asSub(tools, 'plan_save', { task_id: task.id, content: '第二版计划' })
  const path = join(mainDir, 'reports', 'plans', `${task.id}.md`)
  const body = readFileSync(path, 'utf8')
  assert.ok(body.includes('第二版计划'))
  assert.equal(body.includes('第一版计划'), false)
  assert.equal(getTask(db, task.id).artifacts.length, 1)
  db.close()
})

test('P8 plan_save：路径逃逸一律拒绝（编号形状白名单 + 目录包含性校验）', async () => {
  const mainDir = join(tempDir(), 'main')
  const { db, tools } = await setupTools({ mainDir })
  const task = await planTask(db)
  const bad = [
    '../escape', '..\\..\\evil', '../../etc/passwd', '/abs/evil',
    'C:\\Windows\\evil', `${task.id}/../../evil`, `${task.id}\n../evil`, 't-1234/evil', 'not-a-task-id',
  ]
  for (const taskId of bad) {
    const text = await asSub(tools, 'plan_save', { task_id: taskId, content: 'x' }, task.session_id)
    assert.match(text, /不合法|逃逸/, `应拒绝 ${JSON.stringify(taskId)}：${text}`)
  }
  // 没有 mkdir、没有写出任何文件（拒绝发生在写之前）。
  assert.equal(existsSync(join(mainDir, 'reports')), false)
  assert.equal(getTask(db, task.id).artifacts.length, 0)

  // 纯函数层：合法编号固定落在 plans/ 下；明显越界的相对路径被包含性校验挡住。
  assert.equal(isSafePlanTaskId(task.id), true)
  assert.equal(isSafePlanTaskId('../t-1234'), false)
  assert.deepEqual(planDocPath(mainDir, task.id), {
    ok: true,
    path: join(resolve(mainDir), PLAN_SUBDIR, `${task.id}.md`),
    dir: join(resolve(mainDir), PLAN_SUBDIR),
  })
  assert.equal(planDocPath('', task.id).ok, false)
  assert.equal(planDocPath(mainDir, '').ok, false)
  assert.equal(escapesDir(resolve(mainDir, PLAN_SUBDIR), resolve(mainDir, PLAN_SUBDIR, 'x', 'y.md')), true)
  assert.equal(escapesDir(resolve(mainDir, PLAN_SUBDIR), resolve(mainDir, 'plans-other', 'y.md')), true)
  db.close()
})

test('P8 plan_save：无权限/不适用场景全部拒绝——别的子会话、普通任务、任务不存在、没有主会话工作区', async () => {
  const mainDir = join(tempDir(), 'main')
  const { db, tools } = await setupTools({ mainDir })
  const task = await planTask(db)

  // 1) 不是任务自己的子会话（越权）。
  const foreign = await asSub(tools, 'plan_save', { task_id: task.id, content: 'x' }, 'c-9')
  assert.match(foreign, /计划被拒绝/)
  assert.match(foreign, /属于子会话/)

  // 2) 普通任务（非 planFirst）：直接写自己目录，不走计划落盘。
  const plain = createTask(db, { brief: sampleBrief({ title: '普通' }), coordinatorSession: 's-1' })
  transition(db, plain.id, 'running', { sessionId: 'c-2', target: 'c-2' })
  const notPlan = await asSub(tools, 'plan_save', { task_id: plain.id, content: 'x' }, 'c-2')
  assert.match(notPlan, /只有计划模式/)

  // 3) 任务不存在。
  const missing = await asSub(tools, 'plan_save', { task_id: 't-deadbeef', content: 'x' })
  assert.match(missing, /没有任务/)

  // 都没写出文件、也没登记产物。
  assert.equal(existsSync(join(mainDir, 'reports')), false)
  assert.deepEqual(getTask(db, task.id).artifacts, [])
  db.close()

  // 4) 没有主会话工作区（主会话没打开）：给可读原因，不写、不崩。
  const orphan = await setupTools({ mainDir: undefined })
  const orphanTask = await planTask(orphan.db)
  const noDir = await asSub(orphan.tools, 'plan_save', { task_id: orphanTask.id, content: 'x' }, 'c-1')
  assert.match(noDir, /找不到主会话工作区/)
  assert.deepEqual(getTask(orphan.db, orphanTask.id).artifacts, [])
  orphan.db.close()
})

test('P8 plan_save：空正文与超大正文拒绝（不静默截断）', async () => {
  const mainDir = join(tempDir(), 'main')
  const { db, tools } = await setupTools({ mainDir })
  const task = await planTask(db)
  for (const content of ['', '   \n\t ', undefined]) {
    const text = await asSub(tools, 'plan_save', { task_id: task.id, content })
    assert.match(text, /不能为空/)
  }
  const huge = 'x'.repeat(MAX_PLAN_CHARS + 1)
  const tooLong = await asSub(tools, 'plan_save', { task_id: task.id, content: huge })
  assert.match(tooLong, /太长/)
  assert.match(tooLong, new RegExp(String(MAX_PLAN_CHARS)))
  assert.equal(existsSync(join(mainDir, 'reports')), false)
  db.close()
})

test('P8 plan_save：计划文档写在主会话工作区内（不是子会话目标目录），目录已存在也能落盘', async () => {
  const mainDir = join(tempDir(), 'main')
  mkdirSync(join(mainDir, 'reports', 'plans'), { recursive: true })
  // 已有同名文件（旧计划）时覆盖，不追加。
  writeFileSync(join(mainDir, 'reports', 'plans', 't-11112222.md'), '旧内容', 'utf8')
  const { db, tools } = await setupTools({ mainDir })
  const task = await planTask(db)
  const text = await asSub(tools, 'plan_save', { task_id: task.id, content: '新计划' })
  assert.match(text, /计划已落盘/)
  const path = join(mainDir, 'reports', 'plans', `${task.id}.md`)
  assert.ok(readFileSync(path, 'utf8').includes('新计划'))
  // 别的任务的旧计划不受影响。
  assert.equal(readFileSync(join(mainDir, 'reports', 'plans', 't-11112222.md'), 'utf8'), '旧内容')
  // 子会话目标目录里没有计划文件。
  assert.equal(listTasks(db).length, 1)
  db.close()
})

test('P8 计划交付链路：详情/创建提示/协调者 policy 都写明落盘与任务名汇报', async () => {
  const mainDir = join(tempDir(), 'main')
  const { db, tools } = await setupTools({ mainDir })

  // 计划阶段说明：先 plan_save 落盘，再只报摘要 + 路径 + 待拍板清单。
  assert.match(PLAN_FIRST_DETAIL, /plan_save\(\{ task_id, content \}\)/)
  assert.match(PLAN_FIRST_DETAIL, /reports\/plans\/<taskId>\.md/)
  assert.match(PLAN_FIRST_DETAIL, /3–8 行摘要/)
  assert.match(PLAN_FIRST_DETAIL, /待拍板问题清单/)

  const detail = renderTaskDetail({
    id: 't-1', title: '计划', status: 'running', plan_first: true, plan_state: 'planning',
    brief: { title: '计划', goal: 'g', acceptance: ['a'] },
  })
  assert.match(detail, /plan_save/)

  // task_create 返回给协调者的提示：写清落盘路径 + 摘要上报。
  const created = await tools.task_create.execute(
    sampleBrief({ title: '计划B', goal: '目标B', planFirst: true }),
    { agent: { id: 's-1' } },
  )
  assert.match(created, /plan_save/)
  assert.match(created, /reports\/plans\//)
  assert.match(created, /3–8 行摘要/)

  // 协调者 policy：汇报用任务名；plan_save 是子会话工具，协调者硬拦。
  const policy = renderCoordinatorPolicy({})
  assert.match(policy, /用\*\*任务名\*\*/)
  assert.match(policy, /不要只甩 t-xxxx 编号/)
  assert.match(policy, /plan_save/)
  assert.ok(COORDINATOR_DENY.includes('plan_save'))
  db.close()
})

test('P8 计划文档渲染：头部 + 正文，空正文也有占位（纯函数）', () => {
  const body = renderPlanDocument({ task: { id: 't-1', title: '标题', goal: '第一行\n第二行' }, content: '正文', savedAt: 0 })
  assert.match(body, /^# 计划：标题/)
  assert.match(body, /- 任务编号：t-1/)
  assert.match(body, /- 目标：第一行/)
  assert.equal(body.includes('第二行'), false)
  assert.match(body, /- 落盘时间：1970-01-01T00:00:00\.000Z/)
  assert.ok(body.trimEnd().endsWith('正文'))
  assert.match(renderPlanDocument({ task: { id: 't-1', title: '' }, content: '' }), /# 计划：未命名任务/)
  assert.match(renderPlanDocument({ task: { id: 't-1', title: '' }, content: '' }), /（正文为空）/)
})
