// 拍板流程优化（版本 A，2026-11-22 用户最终拍板：**只改提示词/文案**）。
//
// 口径（最终，务必保留）：
// - **不做工具层改造**：`plan_save` 仍只有 task_id / content 两个参数；不解析正文、不渲染段、
//   不存待拍板元数据，计划文档原样落盘。
// - 待拍板清单由模型自己生成，经 `ask_user_question` 逐项提问（平台工具本身已结构化）；
//   插件只负责 policy/文案：五条规则、批准四选一、决策汇总、blocked 通知措辞。
// - 本文件锁「文案与提示词」：决策汇总顺序、blocked 通知措辞、plan_save 参数面未变、
//   回执「子会话」保留会话 id。结构化/文档 lint 的旧用例已删除（用户明确不做）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { openLedger, createTask, getTask, transition } from '../src/ledger.js'
import { createTools } from '../src/tools.js'
import { createQueue } from '../src/queue.js'
import { createNotifier } from '../src/notify.js'
import { loadConfig } from '../src/config.js'
import { PENDING_DECISION_NOTICE, renderDecisionSummary } from '../src/copy.js'
import { tempDir, sampleBrief } from './helpers.js'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

const ITEMS = [
  { question: '发布窗口选哪个：本周五下午还是下周一上午？', chosen: '本周五下午' },
  { question: '历史数据要不要一起迁移？', chosen: '先迁最近 30 天' },
  { question: '失败重试用固定间隔还是指数退避？', chosen: '指数退避' },
]

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
    async sendReliable(target, message) {
      calls.push(['sendReliable', target, message])
      return { messageId: 'm-1' }
    },
    async stop(target) { calls.push(['stop', target]) },
    releaseWritableRoots(target) { calls.push(['release', target]) },
    slug() { counter += 1; return `task-${counter}` },
  }
}

async function setupTools() {
  const db = await openLedger(tempDir())
  const dispatcher = fakeDispatcher()
  const notifier = { pushed: [], push(item) { this.pushed.push(item) } }
  const config = { staleMinutes: 30, maxQueue: 50, coordinatorSession: 's-1' }
  const queue = createQueue({ db, dispatcher, config })
  const tools = Object.fromEntries(createTools({
    db, dispatcher, queue, notifier, config,
    coordinatorStatus: () => ({ id: 's-1', live: true }),
  }).map(tool => [tool.name, tool]))
  return { db, dispatcher, notifier, tools }
}

test('决策汇总：按提问顺序输出「问句原文 → 选择」，3 项样例逐条对上', () => {
  const summary = renderDecisionSummary(ITEMS)
  const lines = summary.split('\n')
  assert.equal(lines[0], '决策汇总：')
  assert.equal(lines.length, 4)
  assert.equal(lines[1], `${ITEMS[0].question} → 本周五下午`)
  assert.equal(lines[2], `${ITEMS[1].question} → 先迁最近 30 天`)
  assert.equal(lines[3], `${ITEMS[2].question} → 指数退避`)
  // 没回答的项只留问句（不编造选择）；空输入有明确占位。
  assert.equal(renderDecisionSummary([{ question: '只问不答？' }]), '决策汇总：\n只问不答？')
  assert.equal(renderDecisionSummary([]), '决策汇总：（无待拍板项）')
})

test('blocked 通知：question 里列 3 项待拍板 →「待拍板 3 项，逐项提问，不要合并成一个总批准」', async () => {
  const delivered = []
  const notifier = createNotifier({ send: async text => delivered.push(text), mergeWindowMs: 5 })
  notifier.push({
    taskId: 't-df',
    title: '拍板样例',
    status: 'blocked',
    summary: '计划待拍板',
    question: '计划已落盘。\n待拍板：\n- 发布窗口选哪个？\n- 历史数据要不要一起迁移？\n- 失败重试用固定间隔还是指数退避？',
  })
  await wait(20)
  assert.equal(delivered.length, 1)
  assert.match(delivered[0], /待拍板 3 项，逐项提问，不要合并成一个总批准/)
  assert.ok(delivered[0].includes(PENDING_DECISION_NOTICE(3)), '通知文案必须来自 copy.js 的单点常量')
  // 没有「待拍板」标记的普通 blocked 不硬加这句（不误标、不硬凑数字）。
  notifier.push({ taskId: 't-df2', title: '普通阻塞', status: 'blocked', summary: '要授权', question: '选一个方案' })
  await wait(20)
  assert.equal(delivered[1].includes('待拍板'), false)
})

test('工具层未改造：plan_save 仍只有 task_id / content 两个参数', () => {
  const planSave = createTools({ db: {}, config: loadConfig({}) }).find(tool => tool.name === 'plan_save')
  assert.ok(planSave !== undefined, 'plan_save 必须仍注册')
  assert.deepEqual(Object.keys(planSave.parameters.properties).sort(), ['content', 'task_id'])
  // 工具描述仍指向「写正文 + 登记产物」，不再提结构化参数。
  assert.equal(planSave.description.includes('pendingItems'), false)
  assert.equal(planSave.description.includes('noPendingReason'), false)
})

test('回执「子会话」字段保留会话 id（用户拍板，不改「面板可打开」）', async () => {
  const { db, tools } = await setupTools()
  const task = createTask(db, { brief: sampleBrief({ title: '拍板样例', goal: '目标' }), coordinatorSession: 's-1', planFirst: true })
  transition(db, task.id, 'running', { sessionId: 'c-1', target: 'c-1' })
  const status = await tools.task_status.execute({ task_id: getTask(db, task.id).id }, { agent: { id: 's-1' } })
  assert.match(status, /子会话：c-1/, '子会话行必须保留会话标识（排障要用）')
  db.close()
})
