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
import { DELIVERY_NOT_FINAL } from '../src/prompt-layers.js'
import {
  EXIT_PLAN_MODE_DENIAL, PLAN_FIRST_DETAIL, PLAN_PHASE_LINES, PLAN_STATE_LABEL, PLAN_STATUS_LINES,
} from '../src/plan-mode.js'
import * as planMode from '../src/plan-mode.js'
import {
  ACCESS_FULL, BLOCKER_RULE, CHANGE_REVIEW_FIELDS, DELIVERY_LINES, DELIVERY_NOT_FINAL as DELIVERY_NOT_FINAL_COPY, PROGRESS_NOTICE_HINT,
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

test('协调者 policy：收到 progress 通知按「信号不是终态」处理，与通知提示同源', () => {
  const policy = renderCoordinatorPolicy({})
  // progress 送达后，协调者的动作只有一个：要结论就追问同一子会话（复用上下文），别重派。
  assert.ok(policy.includes(PROGRESS_NOTICE_HINT), 'L1 与通知必须逐字引用同一句 PROGRESS_NOTICE_HINT')
  assert.match(policy, /收到 progress 通知/)
  assert.match(policy, /task_message 追问同一子会话/)
  assert.match(policy, /别为此重派任务/)
  assertNoConflicts('COORDINATOR_POLICY', policy)
})

test('协调者 policy：不主动问「任务能否关闭」，交付后保持待确认等超时', () => {
  const policy = renderCoordinatorPolicy({})
  assert.match(policy, /ask_user_question/)
  // 0.22.1：从「必须主动问用户」改成「不主动问关闭」——催关闭比超时自动完成更打扰。
  assert.match(policy, /不要问「任务能不能关闭」/)
  assert.match(policy, /不要\*\*用 ask_user_question 追问「确认 \/ 要改？」/)
  assert.match(policy, /等超时自动完成/)
  // 提问不是禁用，而是收窄到真需要拍板的场合。
  assert.match(policy, /只在真正需要拍板时提问/)
  assert.match(policy, /不可逆操作/)
  assert.match(policy, /远端写授权/)
  // 多个待拍板点合并成一条清单，不逐任务连问。
  assert.match(policy, /合成一条清单问完/)
  // 不再要求「收到交付通知的同一回合里就用 ask_user_question 问」。
  assert.doesNotMatch(policy, /待确认要主动问用户/)
  assert.doesNotMatch(policy, /同一回合里就用 ask_user_question 问/)
})

test('协调者 policy：需要拍板必须用 ask_user_question 结构化提问，不得用纯文字问句', () => {
  const policy = renderCoordinatorPolicy({})
  // 「少打扰」只覆盖不用拍板的进展汇报：不能拿它当作跳过决策的借口。
  assert.match(policy, /少打扰只针对「不用拍板的进展汇报」/)
  // 决策走结构化提问：问题 + 选项，纯文字问句不算（容易被忽略、也没东西可点）。
  assert.match(policy, /必须用 ask_user_question 结构化提问/)
  assert.match(policy, /不得用纯文字问句代替/)
  assert.match(policy, /question \+ 2–4 个 options/)
  // 与既有两原则并列，且写明不矛盾。
  assert.match(policy, /不催关闭/)
  assert.match(policy, /能直接回答就不派任务/)
  assert.match(policy, /不矛盾/)
  // 反向口径：不允许「不问用户就直接执行不可逆操作」这类授权句式。
  for (const pattern of [/不问用户[^\n]{0,12}执行/, /无需(?:询问|确认)[^\n]{0,12}(?:执行|发布|推送)/, /自行决定[^\n]{0,8}不可逆/]) {
    assert.doesNotMatch(policy, pattern, `policy 出现「不问用户直接干」的授权口径：${pattern}`)
  }
  assertNoConflicts('COORDINATOR_POLICY', policy)
})

test('协调者 policy：交互三闸门与 brief 同源，T1 不免确认、追加调整先评估', () => {
  const policy = renderCoordinatorPolicy({})
  assert.ok(policy.includes('## 交互三闸门'), 'L1 缺少交互三闸门段落')
  // 四类堵塞项与评估要素都只从 copy.js 取（brief / task_message 描述共用同一句）。
  assert.ok(policy.includes(BLOCKER_RULE))
  assert.ok(policy.includes(CHANGE_REVIEW_FIELDS))
  assert.ok(renderBrief({ taskId: 't-1a2b3c4d' }).includes(BLOCKER_RULE), 'brief 的【执行中待确认】与 L1 的堵塞项不同源')
  // 判级不是免确认：T1 不提问，但不可逆最低 T2、必须拍板（正向断言保留，别被反向断言挤掉）。
  assert.match(policy, /T1 不是「不问就干」/)
  assert.match(policy, /不可逆仍必须拍板/)
  assert.match(policy, /你看着办/)
  // 追加调整：R0 直接转给原会话（不打扰），R1/R2 必须取得确认。
  assert.match(policy, /R0 只补细节、不动验收与已交付结论/)
  assert.match(policy, /R1 动到验收\/范围\/方案/)
  assert.match(policy, /R2 不可逆、权限/)
  assertNoConflicts('COORDINATOR_POLICY', policy)
})

test('协调者 policy：计划批准必须用户拍板，禁止协调者自行批准（含直接续派实现）', () => {
  const policy = renderCoordinatorPolicy({})
  // 硬规则：blocked 计划必须先转交摘要 + 路径，再必须结构化提问请用户批准。
  assert.match(policy, /计划批准必须由用户拍板/)
  assert.match(policy, /必须用 ask_user_question 结构化提问/)
  // 0.25.0：问用户之前要先回复摘要 + present 计划文档，且选项必须有「先看计划文档」这一项。
  assert.match(policy, /批准执行 \/ 先看计划文档 \/ 调整计划/)
  assert.match(policy, /先交付/)
  assert.match(policy, /绝对路径/)
  assert.match(policy, /present 声明该计划文档/)
  assert.match(policy, /不续派、不催/)
  assert.match(policy, /回到第 2 步/)
  // 禁止代批：不得自行批准，也不得把沉默/含糊回应当默认批准。
  assert.match(policy, /协调者不得自行批准/)
  assert.match(policy, /禁止代批/)
  assert.match(policy, /不得推断/)
  // 三个分支都写清：批准才可续派 / 调整转回重出计划 / 未回答保持 blocked。
  assert.match(policy, /用户答「批准」/)
  assert.match(policy, /用户答「调整」/)
  assert.match(policy, /用户没回答/)
  assert.match(policy, /保持 blocked/)
  assert.match(policy, /只修订计划、不要开始实现/)
  // 反向口径：不允许「计划默认批准 / 不问用户就续派实现」这类授权句式。
  for (const pattern of [/默认视为批准/, /自动批准计划/, /计划无需(?:用户)?批准/]) {
    assert.doesNotMatch(policy, pattern, `policy 出现「协调者代批计划」的授权口径：${pattern}`)
  }
  assertNoConflicts('COORDINATOR_POLICY', policy)
})

test('README / ARCHITECTURE 与预设同口径：计划批准是人工闸门', () => {
  const docs = [['README.md', readFileSync(new URL('../README.md', import.meta.url), 'utf8')],
    ['docs/ARCHITECTURE.md', readFileSync(new URL('../docs/ARCHITECTURE.md', import.meta.url), 'utf8')]]
  for (const [file, text] of docs) {
    assert.match(text, /计划批准必须由用户拍板/, `${file} 没写「计划批准必须由用户拍板」`)
    assert.match(text, /协调者不得自行批准/, `${file} 没写「协调者不得自行批准」`)
    assert.match(text, /ask_user_question/, `${file} 没写用 ask_user_question 请用户批准`)
    assert.match(text, /批准执行/, `${file} 没写清「批准执行」分支`)
  }
  // 计划模式的技术小节要把「调整也得重新拍板」讲明，避免把第一次批准当成修订版授权。
  assert.match(docs[1][1], /只修订计划、不要开始实现/)
})

test('协调者 policy：能直接回答就不派任务（只有新鲜取证/写文件/跨仓库才委派）', () => {
  const policy = renderCoordinatorPolicy({})
  assert.match(policy, /能直接回答就不派任务/)
  assert.match(policy, /直接回复用户/)
  assert.match(policy, /新鲜取证/)
  assert.match(policy, /写文件/)
  assert.match(policy, /跨仓库证据/)
})

test('协调者 policy：主动提问与「默认保持待确认、不主动关闭」不矛盾', () => {
  const policy = renderCoordinatorPolicy({})
  // 提问不再是交付后的固定动作，但「不替用户默认确认、等超时」的口径必须还在。
  assert.match(policy, /不要替用户默认确认|等超时自动完成/)
  assert.match(policy, /问完任务依旧是待确认|任务保持待确认/)
  // 两段口径必须能同时读到：保持待确认那条还在。
  assert.match(policy, /默认\*\*保持待确认、不要主动 task_message\(\{ action: 'close' \}\)\*\*/)
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

test('交互闸门的跨层措辞只有一处真源：堵塞项四类 / 评估要素只在 src/copy.js 定义', () => {
  // L1 与 brief / task_message 描述都靠插值引用这两句；任何一处再抄一份完整句子，这里就会红。
  for (const marker of ['已确认的验收/范围/方案不可达', '影响面（哪些任务/产物/已交付结论会变）']) {
    assert.deepEqual(filesWith(marker), ['copy.js'], `「${marker}」在其它模块又写了一份（应引用 src/copy.js）`)
  }
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
