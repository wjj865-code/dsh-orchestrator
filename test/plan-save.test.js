// P8 计划交付（版本 B）：plan_save 把计划落盘到主会话工作区 reports/plans/**<任务名>.md**，
// 目录固定、文件名由安全化流水线生成、禁止逃逸、越权拒绝，并自动登记为任务产物 + 记 plan_path。
// 这里既断工具层（正常落盘 / 逃逸 / 无权限 / 空正文 / 超大正文），也断交付链路文案
// （计划说明、task_detail、task_create 提示、协调者 policy 用任务名汇报）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { openLedger, createTask, getTask, listTasks, transition } from '../src/ledger.js'
import { createTools } from '../src/tools.js'
import { createQueue } from '../src/queue.js'
import {
  MAX_PLAN_CHARS, PLAN_SUBDIR, escapesDir, isSafePlanFileName, planDocPath, renderPlanDocument,
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
async function planTask(db, title = '落盘计划') {
  const task = createTask(db, { brief: sampleBrief({ title, goal: '目标' }), coordinatorSession: 's-1', planFirst: true })
  transition(db, task.id, 'running', { sessionId: 'c-1', target: 'c-1' })
  return getTask(db, task.id)
}

const asSub = (tools, name, args, agentId = 'c-1') => tools[name].execute(args, { agent: { id: agentId } })

test('P8 plan_save：计划写入 reports/plans/<任务名>.md 并登记为产物（文件名=任务名）', async () => {
  const mainDir = join(tempDir(), 'main')
  const { db, tools } = await setupTools({ mainDir })
  const task = await planTask(db)
  const content = '# 目标\n- 改 src/a.js\n\n# 步骤\n1. 先读现状\n2. 再改'
  const text = await asSub(tools, 'plan_save', { task_id: task.id, content })

  // 版本 B：文件名 = 任务名（不是编号，也不是 token）。
  const path = getTask(db, task.id).plan_path
  assert.match(text, /计划已落盘/)
  assert.ok(text.includes(path), `工具结果应给出绝对路径：${text}`)
  assert.match(text, /3–8 行摘要/)
  assert.match(text, /待拍板问题清单/)
  assert.equal(existsSync(path), true)
  // 回执里零裸编号：路径与文案都不带 t-xxxx（路径分隔符按平台取，Windows 上是 `\`）。
  assert.match(path, /artifact-store[\\/]t-[0-9a-z]{8}[\\/]docs[\\/]落盘计划-1\.md$/)
  const body = readFileSync(path, 'utf8')
  // 文档头带任务名 + 任务引用 + 目标，正文原样保留。
  assert.ok(body.startsWith('# 目标'))
  assert.ok(body.includes('改 src/a.js'))
  assert.ok(body.includes('1. 先读现状'))
  assert.doesNotMatch(body.split('\n').slice(0, 6).join('\n'), /\bt-[0-9a-z]{8}\b/, '文档头不许出现裸编号')

  // 登记产物 + 记 plan_path（幂等依据）：路径 = 任务名文件，存在性 true。
  const saved = getTask(db, task.id)
  assert.equal(saved.artifacts.length, 1)
  assert.equal(saved.artifacts[0].path, path)
  assert.equal(saved.artifacts[0].exists, true)
  assert.match(saved.artifacts[0].label, /计划文档/)
  assert.equal(saved.plan_path, path)
  // 计划状态不动：落盘不是批准。
  assert.equal(saved.plan_state, 'planning')
  assert.equal(saved.status, 'running')

  // 产物在协调者视角（task_status）和子会话视角（task_detail）都可见。
  const status = await tools.task_status.execute({ task_id: task.ref }, { agent: { id: 's-1' } })
  assert.ok(status.includes(path), `task_status 应列出计划文档：${status}`)
  const detail = await tools.task_detail.execute({ task_id: task.ref }, { agent: { id: task.session_id } })
  assert.match(detail, /【已有产物】/)
  assert.ok(detail.includes(path))
  db.close()
})

test('plan_save：新版本保留旧正文，最新 plan_path 用于批准', async () => {
  const mainDir = join(tempDir(), 'main')
  const { db, tools } = await setupTools({ mainDir })
  const task = await planTask(db)
  await asSub(tools, 'plan_save', { task_id: task.ref, content: '第一版计划' })
  const first = getTask(db, task.id).plan_path
  await asSub(tools, 'plan_save', { task_id: task.ref, content: '第二版计划' })
  const path = getTask(db, task.id).plan_path
  const body = readFileSync(path, 'utf8')
  assert.ok(body.includes('第二版计划'))
  assert.equal(body.includes('第一版计划'), false)
  assert.equal(getTask(db, task.id).artifacts.length, 2)
  assert.equal(readFileSync(first, 'utf8'), '第一版计划')
  assert.notEqual(first, path)
  // 幂等：plan_path 不变，目录里只有一份文件（没有 -2）。
  assert.equal(getTask(db, task.id).plan_path, path)
  assert.equal(listPlanFiles(mainDir).length, 0)
  db.close()
})

/** 目录里的计划文件名（排序，便于断言「没有 -2」）。 */
function listPlanFiles(mainDir) {
  const dir = join(mainDir, 'reports', 'plans')
  if (!existsSync(dir)) return []
  return readdirSync(dir).sort()
}

test('P8 plan_save：引用无效一律拒绝（路径不再由入参拼），不 mkdir 不登记', async () => {
  const mainDir = join(tempDir(), 'main')
  const { db, tools } = await setupTools({ mainDir })
  const task = await planTask(db)
  const bad = [
    '../escape', '..\\..\\evil', '../../etc/passwd', '/abs/evil',
    'C:\\Windows\\evil', `${task.id}/../../evil`, `${task.id}\n../evil`, 'not-a-task-id', '', 'tk-000000',
  ]
  for (const taskId of bad) {
    const text = await asSub(tools, 'plan_save', { task_id: taskId, content: 'x' }, task.session_id)
    assert.match(text, /计划未落盘|不能为空/, `应拒绝 ${JSON.stringify(taskId)}：${text}`)
    assert.doesNotMatch(text, /\bt-[0-9a-z]{8}\b/, `拒绝文案不许回显编号：${text}`)
  }
  // 没有 mkdir、没有写出任何文件（拒绝发生在写之前）。
  assert.equal(existsSync(join(mainDir, 'reports')), false)
  assert.equal(getTask(db, task.id).artifacts.length, 0)

  // 纯函数层：合法文件名固定落在 plans/ 下；越界名/相对路径被白名单与包含性校验挡住。
  assert.equal(isSafePlanFileName('落盘计划.md'), true)
  assert.equal(isSafePlanFileName('../落盘计划.md'), false)
  assert.equal(isSafePlanFileName('a/b.md'), false)
  assert.equal(isSafePlanFileName('落盘计划'), false, '必须带 .md 扩展名')
  const resolved = planDocPath(mainDir, '落盘计划.md')
  assert.equal(resolved.ok, true)
  assert.equal(resolved.path, join(resolve(mainDir), PLAN_SUBDIR, '落盘计划.md'))
  assert.equal(resolved.dir, join(resolve(mainDir), PLAN_SUBDIR))
  assert.equal(planDocPath('', '落盘计划.md').ok, false)
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
  const foreign = await asSub(tools, 'plan_save', { task_id: task.ref, content: 'x' }, 'c-9')
  assert.match(foreign, /计划被拒绝/)
  assert.match(foreign, /属于子会话/)

  // 2) 普通任务（非 planFirst）：直接写自己目录，不走计划落盘。
  const plain = createTask(db, { brief: sampleBrief({ title: '普通' }), coordinatorSession: 's-1' })
  transition(db, plain.id, 'running', { sessionId: 'c-2', target: 'c-2' })
  const notPlan = await asSub(tools, 'plan_save', { task_id: plain.id, content: 'x' }, 'c-2')
  assert.match(notPlan, /只有计划模式/)

  // 3) 任务不存在 / 引用无效。
  const missing = await asSub(tools, 'plan_save', { task_id: 't-deadbeef', content: 'x' })
  assert.match(missing, /找不到这个任务引用/)
  assert.doesNotMatch(missing, /t-deadbeef/)

  // 都没写出文件、也没登记产物。
  assert.equal(existsSync(join(mainDir, 'reports')), false)
  assert.deepEqual(getTask(db, task.id).artifacts, [])
  db.close()

  // 4) 没有主会话工作区（主会话没打开）：给可读原因，不写、不崩。
  const orphan = await setupTools({ mainDir: undefined })
  const orphanTask = await planTask(orphan.db)
  const noDir = await asSub(orphan.tools, 'plan_save', { task_id: orphanTask.ref, content: 'x' }, 'c-1')
  assert.match(noDir, /找不到主会话工作区/)
  assert.deepEqual(getTask(orphan.db, orphanTask.id).artifacts, [])
  orphan.db.close()
})

test('P8 plan_save：空正文与超大正文拒绝（不静默截断）', async () => {
  const mainDir = join(tempDir(), 'main')
  const { db, tools } = await setupTools({ mainDir })
  const task = await planTask(db)
  for (const content of ['', '   \n\t ', undefined]) {
    const text = await asSub(tools, 'plan_save', { task_id: task.ref, content })
    assert.match(text, /不能为空/)
  }
  const huge = 'x'.repeat(MAX_PLAN_CHARS + 1)
  const tooLong = await asSub(tools, 'plan_save', { task_id: task.ref, content: huge })
  assert.match(tooLong, /太长/)
  assert.match(tooLong, new RegExp(String(MAX_PLAN_CHARS)))
  assert.equal(existsSync(join(mainDir, 'reports')), false)
  db.close()
})

test('P8 plan_save：文件名按任务名生成，同目录别的文件不覆盖', async () => {
  const mainDir = join(tempDir(), 'main')
  mkdirSync(join(mainDir, 'reports', 'plans'), { recursive: true })
  // 历史计划文件（文件名是编号）与本任务无关：不覆盖、不迁移。
  writeFileSync(join(mainDir, 'reports', 'plans', 't-11112222.md'), '旧内容', 'utf8')
  const { db, tools } = await setupTools({ mainDir })
  const task = await planTask(db)
  const text = await asSub(tools, 'plan_save', { task_id: task.ref, content: '新计划' })
  assert.match(text, /计划已落盘/)
  const path = getTask(db, task.id).plan_path
  assert.ok(readFileSync(path, 'utf8').includes('新计划'))
  // 别的任务的旧计划不受影响（历史文件一律不动）。
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
  assert.match(PLAN_FIRST_DETAIL, /docs\/<任务名>-<版本>\.md/)
  assert.match(PLAN_FIRST_DETAIL, /3–8 行摘要/)
  assert.match(PLAN_FIRST_DETAIL, /待拍板问题清单/)

  const detail = renderTaskDetail({
    id: 't-1', ref: 'tk-000001', title: '计划', status: 'running', plan_first: true, plan_state: 'planning',
    brief: { title: '计划', goal: 'g', acceptance: ['a'] },
  })
  assert.match(detail, /plan_save/)
  // 版本 B / R1：详情首行是「任务：名称（tk-xxx）」，不写台账内部编号。
  assert.match(detail, /任务：计划（tk-000001）/)
  assert.doesNotMatch(detail, /任务编号/)

  // task_create 返回给协调者的提示：写清落盘路径（任务名）+ 摘要上报。
  const created = await tools.task_create.execute(
    sampleBrief({ title: '计划B', goal: '目标B', planFirst: true }),
    { agent: { id: 's-1' } },
  )
  assert.match(created, /plan_save/)
  assert.match(created, /docs\/计划B-<版本>\.md/)
  assert.match(created, /3–8 行摘要/)
  assert.doesNotMatch(created, /\bt-[0-9a-z]{8}\b/)

  // 协调者 policy：汇报用任务名 + 引用；plan_save 是子会话工具，协调者调不到。
  const policy = renderCoordinatorPolicy({})
  assert.match(policy, /只用任务名 \+ 任务引用/)
  assert.match(policy, /不要出现 t-xxxx/)
  // R2：再提到同一个任务只写名称、不要只写 tk-xxxxxx（用户认不出是哪条）。
  assert.match(policy, /\*\*再次提到同一个任务只写名称\*\*/)
  assert.match(policy, /\*\*不要只写 tk-xxxxxx\*\*/)
  assert.match(policy, /plan_save/)
  // 0.26.0：角色专属工具改在预设层遮（执行层名单只留编排正确性项），工具表里仍然看不到 plan_save。
  assert.equal(COORDINATOR_DENY.includes('plan_save'), false, 'plan_save 不再进执行层名单')
  const preset = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(preset, /^\s+- plan_save\s*$/m, '协调者预设的 preset-tools deny 应遮住 plan_save')
  db.close()
})

test('P8 计划文档渲染：头部 + 正文，空正文也有占位（纯函数）', () => {
  const body = renderPlanDocument({ task: { id: 't-1', ref: 'tk-000001', title: '标题', goal: '第一行\n第二行' }, content: '正文', savedAt: 0 })
  assert.match(body, /^# 计划：标题/)
  // 版本 B：头里写引用，不写编号。
  assert.match(body, /- 任务引用：tk-000001/)
  assert.doesNotMatch(body, /任务编号/)
  assert.match(body, /- 目标：第一行/)
  assert.equal(body.includes('第二行'), false)
  assert.match(body, /- 落盘时间：1970-01-01T00:00:00\.000Z/)
  assert.ok(body.trimEnd().endsWith('正文'))
  assert.match(renderPlanDocument({ task: { id: 't-1', title: '' }, content: '' }), /# 计划：未命名任务/)
  assert.match(renderPlanDocument({ task: { id: 't-1', title: '' }, content: '' }), /（正文为空）/)
  // 没有 ref（极端情况）时写明「未生成」，不回退显示编号。
  assert.match(renderPlanDocument({ task: { id: 't-1', title: 'x' }, content: 'y' }), /- 任务引用：（未生成）/)
  assert.doesNotMatch(renderPlanDocument({ task: { id: 't-1', title: 'x' }, content: 'y' }), /t-1/)
})
