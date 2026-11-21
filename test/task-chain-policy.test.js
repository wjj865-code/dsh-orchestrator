// 任务链（0.28.0）：把 dependsOn 从「一句话」补成协调者 L1 的五条规则。
//
// 为什么单独一个文件：`dependsOn` 的机制早就在执行层（waiting_dep + `promoteDependents` 自动晋升），
// 但提示词里只有「有先后关系时用 dependsOn」一句——模型不知道**什么时候**建链、也不知道建完不用等，
// 于是「等 A 完成再派 B」把一条自动链走成两次人工往返。这组用例锁三件事：
//   1. 句子单源在 `src/copy.js` 的 `TASK_CHAIN_LINES`，L1 段与 `task_create.dependsOn` 描述逐字同源；
//   2. 五条规则与执行层现状一一对应（不是新语义）：用 `src/deps.js` 的纯函数证明 delivered 不算 done、
//      done 后自动晋升、失败向下游传播；
//   3. 归层：任务链属 L1（协调者的派单判断），L2 brief / L3 task_detail 不许复述。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { createTask, getTask, openLedger } from '../src/ledger.js'
import { dependencyState, promoteDependents } from '../src/deps.js'
import {
  TASK_CHAIN_LINES, TASK_CHAIN_TOOL_DESC, TASK_CHAIN_WAITING_NOTE,
} from '../src/copy.js'
import { layerViolations, renderTaskChainPolicy } from '../src/prompt-layers.js'
import { renderCoordinatorPolicy } from '../index.js'
import { createTools } from '../src/tools.js'
import { loadConfig } from '../src/config.js'
import { renderBrief } from '../src/brief.js'
import { renderTaskDetail } from '../src/task-detail.js'
import { sampleBrief, tempDir } from './helpers.js'

const policy = () => renderCoordinatorPolicy({})
const chainSection = () => renderTaskChainPolicy()

/** 五条规则的句子（渲染与工具描述都必须逐字包含）。 */
const RULES = [
  TASK_CHAIN_LINES.criteria,
  TASK_CHAIN_LINES.buildNow,
  TASK_CHAIN_LINES.notBlocking,
  TASK_CHAIN_LINES.upstreamFailed,
  TASK_CHAIN_LINES.deliveredNotDone,
  TASK_CHAIN_LINES.worktreeSerial,
]

test('任务链段是 L1 的独立一段：排在推进循环之后、worktree 与写域之前', () => {
  const text = policy()
  const chain = text.indexOf('## 任务链（dependsOn：依赖完成自动开始，不占你的回合）')
  assert.ok(chain > 0, 'L1 缺少任务链段')
  // 建链属于「推进」那一类动作：先讲回报之后做什么，再讲有先后关系怎么派。
  assert.ok(chain > text.indexOf('## 推进循环'), '任务链应在推进循环之后')
  // 同一检出串行的规则要先读到，再读 worktree 隔离/写域判定。
  assert.ok(chain < text.indexOf('## worktree 隔离'), '任务链应在 worktree 段之前')
  assert.ok(chain < text.indexOf('## 同写域并发防护'), '任务链应在写域段之前')
})

test('五条规则齐全：判据与建链时机 / 不是阻塞等待 / 失败传播 / delivered≠done / 同检出串行', () => {
  const block = chainSection()
  // 每句都逐字来自 copy.js（改一处两处一起变，不许各写一套）。
  for (const line of RULES) assert.ok(block.includes(line), `任务链段缺少句子：${line.slice(0, 24)}…`)
  for (const line of RULES) assert.ok(policy().includes(line), `L1 policy 缺少句子：${line.slice(0, 24)}…`)
  // 五组判据本身就是规则本体：缺任何一条，模型就会退回「等 A 完成再派 B」。
  assert.match(block, /判据（什么时候该建链）：B 的输入是 A 的产物/)
  assert.match(block, /建链时机：派 A 之后\*\*同一回合\*\*就把 B 建出来/)
  assert.match(block, /不要等 A 完成再来建 B/)
  assert.match(block, /不是阻塞等待：.*插件队列自动晋升.*不占你的回合/)
  assert.match(block, /不用你 wait_agent/)
  assert.match(block, /前置失败 → 下游自动 failed/)
  assert.match(block, /前置「已交付待确认」（delivered）不算 done/)
  assert.match(block, /同一 worktree 检出必须用 dependsOn 串行/)
  // 如实标注「机制是硬的、建不建链是判断」，不改写「禁止轮询」的既有硬规则。
  assert.match(block, /建不建链是你的判断（提示词约束）/)
})

test('task_create 的 dependsOn 描述与 L1 逐字同源（工具表里手边就有这五条）', () => {
  const { parameters } = createTools({ db: {}, config: loadConfig({}) }).find(tool => tool.name === 'task_create')
  const description = parameters.properties.dependsOn.description
  assert.equal(description, TASK_CHAIN_TOOL_DESC, 'dependsOn 描述应直接引用 copy.js 的 TASK_CHAIN_TOOL_DESC')
  for (const line of RULES) assert.ok(description.includes(line), `dependsOn 描述缺少规则句：${line.slice(0, 24)}…`)
  // 只写「依赖完成才派发」会让人以为要自己等——所以这两句必须在 schema 里。
  assert.match(description, /自动晋升/)
  assert.match(description, /不占你的回合/)
  assert.match(description, /不算 done/)
})

test('waiting_dep 创建回执写明「自动晋升、不占回合」', () => {
  assert.ok(TASK_CHAIN_WAITING_NOTE.includes(TASK_CHAIN_LINES.notBlocking), '回执补充句与 L1 同源')
  assert.match(TASK_CHAIN_WAITING_NOTE, /自动晋升/)
  // 静态断言：回执真的用上了这句（不是只在 copy.js 里躺着）。
  const toolsSource = readFileSync(new URL('../src/tools.js', import.meta.url), 'utf8')
  assert.match(toolsSource, /TASK_CHAIN_WAITING_NOTE/)
})

test('机制与文案一致：delivered 不算 done、done 后自动晋升、失败向下游传播', async () => {
  const db = await openLedger(tempDir())
  try {
    // 前置停在「已交付待确认」：下游不能晋升（就绪只认 done）。
    const delivered = createTask(db, { brief: sampleBrief({ title: '前置交付' }), coordinatorSession: 's-1', status: 'delivered' })
    const waiter = createTask(db, {
      brief: sampleBrief({ title: '下游等确认' }), coordinatorSession: 's-1', dependsOn: [delivered.id], status: 'waiting_dep',
    })
    assert.equal(dependencyState(db, waiter).ready, false, 'delivered 不该让下游就绪')
    const enqueued = []
    promoteDependents(db, { enqueue: id => enqueued.push(id) })
    assert.equal(dependencyState(db, waiter).ready, false)
    assert.deepEqual(enqueued, [], 'delivered 不晋升')
    assert.equal(waiter.status, 'waiting_dep')

    // 前置 done：下游自动晋升 pending 并入队（不占协调者回合）。
    const finished = createTask(db, { brief: sampleBrief({ title: '前置完成' }), coordinatorSession: 's-1', status: 'done' })
    const next = createTask(db, {
      brief: sampleBrief({ title: '下游开始' }), coordinatorSession: 's-1', dependsOn: [finished.id], status: 'waiting_dep',
    })
    const promoted = promoteDependents(db, { enqueue: id => enqueued.push(id) })
    assert.deepEqual(promoted.promoted, [next.id])
    assert.equal(getTask(db, next.id).status, 'pending')
    assert.deepEqual(enqueued, [next.id])

    // 前置 failed：下游直接失败的，原因写明「前置任务未完成」。
    const broken = createTask(db, { brief: sampleBrief({ title: '前置失败' }), coordinatorSession: 's-1', status: 'failed' })
    const downstream = createTask(db, {
      brief: sampleBrief({ title: '下游连坐' }), coordinatorSession: 's-1', dependsOn: [broken.id], status: 'waiting_dep',
    })
    const propagated = promoteDependents(db, { enqueue: id => enqueued.push(id) })
    assert.deepEqual(propagated.failed, [downstream.id])
    const failedRow = getTask(db, downstream.id)
    assert.equal(failedRow.status, 'failed')
    assert.match(failedRow.error, /前置任务未完成/)
  } finally {
    db.close()
  }
})

test('归层：任务链属 L1，brief / task_detail 不复述协调者的建链判断', () => {
  assert.deepEqual(layerViolations('L1', policy()), [])
  for (const leaked of ['任务链：B 的输入是 A 的产物', 'dependsOn 不是阻塞等待：先落 waiting_dep']) {
    assert.notDeepEqual(layerViolations('L2', leaked), [], `L2 不该复述：${leaked}`)
    assert.notDeepEqual(layerViolations('L3', leaked), [], `L3 不该复述：${leaked}`)
  }
  const brief = renderBrief({ taskId: 't-1a2b3c4d' })
  assert.equal(brief.includes('任务链'), false, 'brief 只指路，不建链')
  const detail = renderTaskDetail(
    { id: 't-1', title: '示例', status: 'running', brief: { title: '示例', goal: '目标', acceptance: ['验收'] } },
    { dependencies: '【前置任务】\n- 任务「上游」已完成：结论' },
  )
  assert.equal(detail.includes('任务链'), false, 'task_detail 只给前置事实，不讲建链规则')
  // 但前置事实本身还在（L3 的职责没被这条规则吃掉）。
  assert.match(detail, /【前置任务】/)
})

test('与既有口径兼容：不轮询 / 能直接回答就不派任务 / 推进循环 / 交付两段式都还在', () => {
  const text = policy()
  assert.match(text, /禁止使用 wait_agent/)
  assert.match(text, /不要 sleep/)
  assert.match(text, /能直接回答就不派任务/)
  assert.match(text, /## 推进循环/)
  assert.match(text, /不是终态/)
  // 任务链段自己声明与它们的关系（不推翻、也不假装是硬门禁）。
  assert.match(text, /不推翻「禁止阻塞等待\/不轮询」「能直接回答就不派任务」「推进循环」「交付两段式」/)
  assert.match(text, /建链属于「推进」那一类动作/)
  // 反例：不允许出现「等 A 完成再派 B」这类把自动链走成人工等待的授权句式。
  for (const pattern of [/先等前置任务完成再派/, /等 A 结束后再建 B/, /为等前置可以 sleep/]) {
    assert.doesNotMatch(text, pattern, `policy 出现人工等待口径：${pattern}`)
  }
})

test('文案单源：任务链的规则句只在 src/copy.js 定义一次', () => {
  const dir = new URL('../src/', import.meta.url)
  const files = readdirSync(dir).filter(file => file.endsWith('.js'))
    .map(file => [file, readFileSync(new URL(file, dir), 'utf8')])
  files.push(['index.js', readFileSync(new URL('../index.js', import.meta.url), 'utf8')])
  const filesWith = marker => files.filter(([, text]) => text.includes(marker)).map(([file]) => file)
  for (const marker of ['依赖完成自动开始', '不要等 A 完成再来建 B', '插件队列自动晋升']) {
    assert.deepEqual(filesWith(marker), ['copy.js'], `「${marker}」在其它模块又写了一份（应引用 src/copy.js）`)
  }
})

test('文档同口径：README 依赖节与协作节奏、ARCHITECTURE 依赖节都写了任务链', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  const arch = readFileSync(new URL('../docs/ARCHITECTURE.md', import.meta.url), 'utf8')
  for (const [name, text] of [['README.md', readme], ['docs/ARCHITECTURE.md', arch]]) {
    assert.match(text, /任务链/, `${name} 没写任务链`)
    assert.match(text, /不占[^，。；\n]{0,6}回合/, `${name} 没写「不占回合」`)
    assert.match(text, /已交付待确认|delivered/, `${name} 没写前置交付不算 done`)
    assert.match(text, /串行/, `${name} 没写同一检出串行`)
  }
  // 协作节奏一节也要提一句（用户看的是「什么时候派、派完要不要等」）。
  const rhythm = readme.slice(readme.indexOf('### 6. 协作节奏'))
  assert.match(rhythm.slice(0, rhythm.indexOf('\n## ')), /任务链/)
  assert.match(arch, /renderTaskChainPolicy/)
})
