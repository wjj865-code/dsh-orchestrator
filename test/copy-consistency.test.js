// 文案一致性（0.14.1：两段式终态口径 + 预设默认 + present 口径）：brief / 协调者 policy / 通知 / task_detail / README
// 不得出现「done 即终态」「默认立刻关闭（旧 task_close）」这类互相打架的措辞。
//
// 为什么单独一个测试文件：这些文案分散在 5 个模块里，逐条断言容易被后续改动悄悄改回去；
// 这里只锁「口径」——默认保持待确认、追问复用原会话、present 1-4 个——不锁具体措辞细节。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { renderCoordinatorPolicy } from '../index.js'
import { renderBrief } from '../src/brief.js'
import { renderTaskDetail } from '../src/task-detail.js'
import { DELIVERED_HINT, PRESENT_HINT } from '../src/notify.js'
import { DEFAULT_KEEPALIVE_PROMPT } from '../src/keepalive.js'
import { DELIVERY_NOT_FINAL } from '../src/prompt-layers.js'
import {
  EXIT_PLAN_MODE_DENIAL, PLAN_FIRST_DETAIL, PLAN_PHASE_LINES, PLAN_STATE_LABEL, PLAN_STATUS_LINES,
} from '../src/plan-mode.js'
import * as planMode from '../src/plan-mode.js'
import {
  ACCESS_FULL, DELIVERY_LINES, DELIVERY_NOT_FINAL as DELIVERY_NOT_FINAL_COPY,
  PLAN_SAVE_TOOL_DESC, planCreateReceipt, planDocPathText,
} from '../src/copy.js'
import { planSavedNote } from '../src/plan-doc.js'
import { STATUS_LABEL } from '../src/state.js'

/** 与两段式终态冲突的旧口径：命中任何一条都说明文案在「done 即结束 / 默认自动关闭」。 */
const CONFLICTS = [
  /默认立刻\s*task_close/,
  /done\s*即(?:任务)?(?:结束|终态|完成)/,
  /报\s*done\s*即/,
  /自动关闭/,
  /1-2 个最关键/,
]

const assertNoConflicts = (name, text) => {
  for (const pattern of CONFLICTS) {
    assert.doesNotMatch(text, pattern, `${name} 出现与两段式终态冲突的旧口径：${pattern}`)
  }
}

test('brief 只引向 task_detail，不越权定义交付/关闭口径', () => {
  const brief = renderBrief({ taskId: 't-1a2b3c4d', access: 'full' })
  assert.match(brief, /【任务编号】t-1a2b3c4d/)
  assert.match(brief, /task_detail/)
  // 交付语义一律在 task_detail / 协调者 policy 里讲，brief 不该出现这些词。
  assert.doesNotMatch(brief, /task_close|delivered|已交付待确认|终态/)
  assertNoConflicts('brief', brief)
})

test('协调者 policy：done 后默认保持待确认，不主动 action:close', () => {
  const policy = renderCoordinatorPolicy({})
  assert.match(policy, /不是终态/)
  assert.match(policy, /默认\*\*保持待确认、不要主动 task_message\(\{ action: 'close' \}\)\*\*/)
  assert.match(policy, /task_message 追问（复用同一个子会话/)
  assert.match(policy, /超时/)
  assertNoConflicts('COORDINATOR_POLICY', policy)
})

test('协调者 policy：待确认要主动 ask_user_question 问用户（任务名 + 要点 + 确认 / 要改）', () => {
  const policy = renderCoordinatorPolicy({})
  assert.match(policy, /ask_user_question/)
  assert.match(policy, /待确认要主动问用户，不许只挂台账/)
  assert.match(policy, /任务名/)
  assert.match(policy, /一句结果要点/)
  assert.match(policy, /确认 \/ 要改？/)
  // 多个待确认合并成一条清单，而不是连发多条或只报数量。
  assert.match(policy, /合并成一条清单一次问/)
  // 不许等用户自己去翻面板 / 台账。
  assert.match(policy, /不要等用户自己去翻面板或 task_list/)
})

test('协调者 policy：主动提问与「默认保持待确认、不主动关闭」不矛盾', () => {
  const policy = renderCoordinatorPolicy({})
  assert.match(policy, /提问不等于关闭/)
  assert.match(policy, /问完任务依旧是待确认，默认不 task_message\(\{ action: 'close' \}\)/)
  // 两段口径必须能同时读到：保持待确认那条还在。
  assert.match(policy, /默认\*\*保持待确认、不要主动 task_message\(\{ action: 'close' \}\)\*\*/)
  // 提问不是替用户拍板：没回答就走超时，不做默认确认。
  assert.match(policy, /不要替用户默认确认/)
  assertNoConflicts('COORDINATOR_POLICY', policy)
})

test('task_detail 对子会话讲清：done 只是交付，不是任务结束', () => {
  const detail = renderTaskDetail({
    id: 't-1',
    title: '示例',
    status: 'running',
    brief: { title: '示例', goal: '目标', acceptance: ['验收'] },
  })
  assert.match(detail, /报 done 只是「交付」/)
  assert.match(detail, /已交付待确认/)
  assert.match(detail, /不要自行宣告任务结束/)
  assertNoConflicts('task_detail', detail)
})

test('交付通知口径：默认保持待确认、要改走追问；不再以「确认」开头催关闭', () => {
  assert.match(DELIVERED_HINT, /默认保持待确认/)
  assert.match(DELIVERED_HINT, /task_message 追问/)
  assert.match(DELIVERED_HINT, /task_message\(\{ action: "close"/)
  // 旧文案以「确认：task_close」开头，等于每条通知都在催关闭。
  assert.doesNotMatch(DELIVERED_HINT, /^确认：/)
  assertNoConflicts('DELIVERED_HINT', DELIVERED_HINT)
})

test('present 口径：通知里的交付指令与协调者 policy 一致（1-4 个）', () => {
  assert.match(PRESENT_HINT, /1-4 个最关键的/)
  assert.match(renderCoordinatorPolicy({}), /1-4 个最关键的产物/)
  assertNoConflicts('PRESENT_HINT', PRESENT_HINT)
})

test('keep-alive 提示不把 done 说成任务结束', () => {
  assert.match(DEFAULT_KEEPALIVE_PROMPT, /已交付待确认/)
  assertNoConflicts('keep-alive prompt', DEFAULT_KEEPALIVE_PROMPT)
})

test('README 与预设同口径：默认保持待确认、工具数 10、升级要重启', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  assert.match(readme, /默认保持待确认/)
  assert.match(readme, /10 个工具/) 
  // 迁移映射表在 README 里（旧名 → 新调用），旧名不能只删不说。
  assert.match(readme, /工具迁移映射/)
  for (const legacy of ['task_stop', 'task_retry', 'task_close', 'task_inbox', 'history_search', 'project_context']) assert.ok(readme.includes(legacy), `README 迁移表缺少 ${legacy}`)
  assert.match(readme, /刷新页面不会换版本/)
  assert.doesNotMatch(readme, /默认立刻 `?task_close/)
  assert.doesNotMatch(readme, /13 个工具/)
  assertNoConflicts('README', readme)
})

test('原生自动化 policy 与文档锁住真实工具、授权及会话边界', () => {
  const texts = [renderCoordinatorPolicy({}), ...['README.md', 'docs/ARCHITECTURE.md', 'docs/LIMITATIONS.md']
    .map(file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))]
  for (const text of texts) {
    for (const name of ['schedule_create', 'schedule_list', 'schedule_view', 'schedule_edit']) assert.ok(text.includes(name))
    assert.match(text, /Host-wide/)
    assert.match(text, /明确授权/)
    assert.match(text, /this_session/)
    assert.match(text, /new.*new_once/)
    assert.match(text, /非唯一主/)
    assert.match(text, /(?:默认|default) worker 不(?:开放|新增)/)
    assert.match(text, /full.*不增加工具/)
    assert.match(text, /expectedUpdatedAt/)
  }
})

test('文档工具数一致：docs 与 README 都说 10 个（审计 §3.1/§3.2 的漏检）', () => {
  // 0.19.x 的 copy-consistency 只断言 README 的「15 个」，不检查 docs/ARCHITECTURE.md 的「14」，
  // 于是这条漂移长期没被发现。现在把 docs 也纳入同一断言。
  const docs = ['README.md', 'docs/ARCHITECTURE.md', 'docs/testing.md']
    .map(file => [file, readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')])
  for (const [file, text] of docs) {
    // 任何「N 个工具」的说法都必须与实现一致（P1-B 起 10 个全局工具：7 协调者 + 3 子会话专属）。
    for (const match of text.matchAll(/(\d+)\s*个(?:全局)?工具/g)) {
      assert.equal(match[1], '10', `${file} 的工具数写成 ${match[1]}，实现是 10 个`)
    }
    assert.doesNotMatch(text, /仍为\s*14|工具数\s*14/, `${file} 还写着 14 个工具`)
  }
  // ARCHITECTURE 的「常用工具」清单必须含 read_workspace（审计 §3.2；原 DETAIL.md 已并进该节）。
  const arch = readFileSync(new URL('../docs/ARCHITECTURE.md', import.meta.url), 'utf8')
  assert.match(arch, /常用工具[\s\S]{0,200}?read_workspace/)
})

test('README 只服务使用者：维护者内容放 docs/，仅留链接', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  // 维护者章节（发布/CI/内部架构/开发命令）不该再回到 README。
  assert.doesNotMatch(readme, /^##\s*(版本与发布|架构与安全|开发)\s*$/m)
  assert.doesNotMatch(readme, /release\.yml|npm publish|npm version patch/)
  assert.doesNotMatch(readme, /npm test\s+#|npm run build\s+#/)
  // 指向文档的链接要在。
  for (const doc of ['docs/CONTRIBUTING.md', 'docs/ARCHITECTURE.md', 'docs/LIMITATIONS.md', 'docs/testing.md', 'CHANGELOG.md']) {
    assert.ok(readme.includes(doc), `README 缺少文档链接：${doc}`)
  }
})

// —— P1-C 文案单源：同一句话只许在 src/copy.js 定义一次，其余模块一律引用 ——

/** 服务端源码文本（src/ 全部模块 + index.js）：静态扫描「这句话是不是又被抄了一份」。 */
const serverSources = () => {
  const dir = new URL('../src/', import.meta.url)
  const files = readdirSync(dir).filter(file => file.endsWith('.js')).map(file => [file, readFileSync(new URL(file, dir), 'utf8')])
  files.push(['index.js', readFileSync(new URL('../index.js', import.meta.url), 'utf8')])
  return files
}

/** 出现某段文案的文件名（同一文件里写几遍只算一次）。 */
const filesWith = marker => serverSources().filter(([, text]) => text.includes(marker)).map(([file]) => file)

/** 一份计划任务 / 普通任务的渲染夹具（文案口径的端到端检查）。 */
const planDetail = () => renderTaskDetail({
  id: 't-1a2b3c4d', title: '计划', goal: 'g', status: 'running', plan_first: true, plan_state: 'planning',
  brief: { title: '计划', goal: 'g', acceptance: ['a'] },
})

test('文案单源：计划/交付/完整访问的原子句只在 src/copy.js 定义（其它模块只能引用）', () => {
  const markers = [
    '唯一允许的写入口',
    '3–8 行摘要',
    '计划文档绝对路径 + 待拍板问题清单',
    '不要自行宣告任务结束',
    'danger-full-access：文件沙箱不限制写入',
  ]
  for (const marker of markers) {
    assert.deepEqual(filesWith(marker), ['copy.js'], `「${marker}」在其它模块又写了一份（应引用 src/copy.js）`)
  }
  // plan-mode.js 是计划域门面：对外仍从这里拿同一份常量（对象引用相同，不是副本）。
  assert.equal(planMode.PLAN_PHASE_LINES, PLAN_PHASE_LINES)
  assert.equal(planMode.PLAN_FIRST_DETAIL, PLAN_FIRST_DETAIL)
  assert.equal(planMode.EXIT_PLAN_MODE_DENIAL, EXIT_PLAN_MODE_DENIAL)
})

test('计划文案只有一处真源：详情 / 创建回执 / 工具描述 / 落盘回执 / 拒绝文案逐字同源', () => {
  const id = 't-1a2b3c4d'
  // 详情（L3）：整段说明就是 copy.js 的那一份，包含全部动作要素。
  const detail = planDetail()
  assert.ok(detail.includes(PLAN_FIRST_DETAIL), 'task_detail 没有渲染 PLAN_FIRST_DETAIL 原文')
  for (const part of [
    PLAN_PHASE_LINES.saveCall, planDocPathText(), PLAN_PHASE_LINES.reportRule,
    PLAN_PHASE_LINES.reportQuestion, PLAN_PHASE_LINES.noExitPlanMode, PLAN_PHASE_LINES.resume,
  ]) assert.ok(PLAN_FIRST_DETAIL.includes(part), `计划说明缺少要素：${part}`)
  // 创建回执（L1 看到的动作指令）与详情同源，不是另一套说法。
  assert.ok(planCreateReceipt(id).includes(planDocPathText(id)))
  assert.ok(planCreateReceipt(id).includes(PLAN_PHASE_LINES.reportSummaryShort))
  assert.ok(planCreateReceipt(id).includes(PLAN_PHASE_LINES.reportQuestion))
  // plan_save 工具描述、落盘回执、exit_plan_mode 拒绝文案。
  assert.ok(PLAN_SAVE_TOOL_DESC.includes(planDocPathText()))
  assert.ok(PLAN_SAVE_TOOL_DESC.includes(PLAN_PHASE_LINES.saveEntry))
  assert.ok(planSavedNote({ path: 'p', chars: 1, bytes: 2 }).includes(PLAN_PHASE_LINES.reportRule))
  assert.ok(EXIT_PLAN_MODE_DENIAL.includes(PLAN_PHASE_LINES.reportCallFull))
  assert.ok(EXIT_PLAN_MODE_DENIAL.includes(planDocPathText()))
  // 计划状态行与 plan_save 的落盘目录同一口径。
  assert.ok(PLAN_STATUS_LINES.planning.includes('reports/plans/'))
  // 协调者 policy（L1）仍要提到同一批事实（口径对齐，不重复定义句子）。
  const policy = renderCoordinatorPolicy({})
  assert.ok(policy.includes(PLAN_PHASE_LINES.reportQuestion))
  assert.ok(policy.includes('plan_save'))
})

test('交付文案只有一处真源：brief / 详情 / 通知 / 分层常量引用同一批原子句', () => {
  const detail = renderTaskDetail({ id: 't-1', title: '示例', status: 'running', brief: { title: '示例', goal: '目标', acceptance: ['验收'] } })
  // 详情与通知的「交付不是结束」都从 copy.js 来（不是各写一句相似的）。
  assert.ok(detail.includes(DELIVERY_LINES.state))
  assert.ok(detail.includes(DELIVERY_LINES.timeout))
  assert.equal(DELIVERY_NOT_FINAL, DELIVERY_NOT_FINAL_COPY)
  assert.ok(DELIVERY_NOT_FINAL.includes(DELIVERY_LINES.notFinal))
  assert.ok(DELIVERED_HINT.includes(DELIVERY_LINES.followupRule))
  assert.ok(DELIVERED_HINT.includes(DELIVERY_LINES.closeCallWithTaskId))
  assert.ok(DELIVERED_HINT.includes(DELIVERY_LINES.timeout))
  // 文档/策略里的同一句事实：done 只是交付（两处必须是同一个词）。
  const policy = renderCoordinatorPolicy({})
  assert.ok(policy.includes(DELIVERY_LINES.state))
  assert.ok(policy.includes(DELIVERY_LINES.notFinal))
  assert.ok(DEFAULT_KEEPALIVE_PROMPT.includes(DELIVERY_LINES.state))
})

test('完整访问文案只有一处真源：brief 行 / 详情标签 / 详情纪律 / 创建回执同源', () => {
  const brief = renderBrief({ taskId: 't-1', access: 'full' })
  assert.ok(brief.includes(ACCESS_FULL.briefLine), 'brief 的访问级别行不是 copy.js 那一份')
  const detail = renderTaskDetail({
    id: 't-1', status: 'running', access: 'full', brief: { title: 'x', goal: 'g', acceptance: ['a'], target: 'C:/work' },
  })
  assert.ok(detail.includes(`访问级别：${ACCESS_FULL.label}`))
  assert.ok(detail.includes(ACCESS_FULL.workerHint))
  // 只读任务绝不带完整访问文案（两者互斥，随机组合由 status-property 覆盖）。
  const readOnly = renderTaskDetail({
    id: 't-1', status: 'running', read_only: true, access: 'full', brief: { title: 'x', goal: 'g', acceptance: ['a'], target: 'C:/work' },
  })
  assert.equal(readOnly.includes(ACCESS_FULL.label), false)
})

test('面板文案与服务端同值：STATUS_LABEL / PLAN_STATE_LABEL 不在客户端各写一套（漂移即失败）', () => {
  const read = file => readFileSync(new URL(`../client/src/${file}`, import.meta.url), 'utf8')
  const source = read('constants.js')
  const literalPairs = (name) => {
    const matched = new RegExp(`export const ${name} = \\{([\\s\\S]*?)\\n\\}`).exec(source)
    assert.ok(matched !== null, `client/src/constants.js 里找不到 ${name}`)
    return Object.fromEntries([...matched[1].matchAll(/(\w+):\s*'([^']*)'/g)].map(item => [item[1], item[2]]))
  }
  const clientPlan = literalPairs('PLAN_STATE_LABEL')
  assert.deepEqual(clientPlan, PLAN_STATE_LABEL, '面板计划状态文案与服务端漂移')
  // STATUS_LABEL：客户端多一个 missing（面板专有），其余必须逐字一致。
  const clientStatus = literalPairs('STATUS_LABEL')
  for (const [status, label] of Object.entries(STATUS_LABEL)) {
    assert.equal(clientStatus[status], label, `面板状态文案与服务端漂移：${status}`)
  }
  assert.equal(clientStatus.missing, '缺失')
})
