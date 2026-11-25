// 提示词分层（prompt-layers）：层职责边界、消除的重叠、修掉的矛盾。
//
// 这一组不锁具体措辞，锁**归层**：同一条口径只许出现在一个层，跨层共享的必须逐字同源。
// 判据表在 `src/prompt-layers.js` 的 `PROMPT_LAYERS`；探针在 `layerViolations`。
//
// t-4f7ce108：新增 W1（任务执行者 per-turn policy）。brief 与 worker persona 里的静态提示全部迁进 W1，
// 这一组同时锁住「brief 只剩一次性参数」「persona 只剩身份」「W1 的句子逐字来自 copy.js」。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  DELIVERY_NOT_FINAL, LAYER_NAME, PRESENT_LIMIT_TEXT, PRESENT_MAX_FILES, PROMPT_LAYERS, WORKER_CONTEXT_HINT,
  WORKER_MEMORY_HINT, layerViolations, renderAdvanceLoopPolicy, renderTaskChainPolicy, renderWorkerPolicy,
} from '../src/prompt-layers.js'
import {
  ADVANCE_LOOP_LINES, ADVANCE_NOTICE_HINT, TASK_CHAIN_CRITERIA, TASK_CHAIN_LINES, WORKER_PERMISSION_HINT,
  WORKER_POLICY_HEADING, WORKER_POLICY_LINES,
} from '../src/copy.js'
import { renderCoordinatorPolicy } from '../index.js'
import { BLOCKED_HINT, CONFIRM_HINT, SUMMARY_FIELDS, renderBrief } from '../src/brief.js'
import { renderTaskDetail } from '../src/task-detail.js'
import { ONBOARDING_PROMPT } from '../src/onboarding.js'
import { DELIVERED_HINT, PRESENT_HINT } from '../src/notify.js'
import { PRESET_PREFERENCES, renderPreferenceBlock } from '../src/preferences.js'

const sampleDetail = () => renderTaskDetail({
  id: 't-1',
  title: '示例',
  status: 'running',
  brief: { title: '示例', goal: '目标', acceptance: ['验收'], constraints: ['约束'] },
})

test('六层清单完整：L1/W1/L2/L3/L4/NOTIFY 各有载体、受众与独占职责', () => {
  assert.deepEqual(PROMPT_LAYERS.map(layer => layer.id), ['L1', 'W1', 'L2', 'L3', 'L4', 'NOTIFY'])
  for (const layer of PROMPT_LAYERS) {
    assert.ok(layer.name !== '', `${layer.id} 缺名称`)
    assert.ok(layer.carrier !== '', `${layer.id} 缺载体说明`)
    assert.ok(['coordinator', 'worker'].includes(layer.audience), `${layer.id} 受众不合法`)
    assert.ok(layer.owns.length > 0, `${layer.id} 没有独占职责`)
    assert.ok(Array.isArray(layer.forbids), `${layer.id} 缺 forbids`)
  }
  assert.equal(LAYER_NAME.L1, '协调者 policy')
  assert.equal(LAYER_NAME.W1, '任务执行者 policy')
  assert.equal(LAYER_NAME.L4, 'onboarding')
})

test('L1 承担全部协调者规则（每回合重渲染的那一层）', () => {
  const policy = renderCoordinatorPolicy({})
  for (const fragment of ['wait_agent', 'task_close', 'task_message', 'present', 'read_workspace', 'ask_user_question', 'schedule_create', 'grill-me']) {
    assert.ok(policy.includes(fragment), `L1 缺 ${fragment}`)
  }
  // 0.26.0：grill-me 的调用形状在 L1。
  assert.match(policy, /skill\(\{ name: 'grill-me' \}\)/, 'L1 应给出加载 grill-me 的调用形状')
  // t-4f7ce108：协调者的原生只读工具只剩 read —— glob/grep 从预设移除，检索类工作派任务。
  assert.match(policy, /看文件用原生 read/, 'L1 应说明只读工具面只有 read')
  assert.doesNotMatch(policy, /看文件用原生 read \/ glob/, 'L1 不许再暗示协调者能搜索')
  assert.doesNotMatch(policy, /read \/ glob \/ grep/, 'L1 不许再暗示协调者能搜索')
  // 策略段也在 L1（结构化配置渲染）。
  assert.match(policy, /## worktree 隔离/)
  assert.match(policy, /## 同写域并发防护/)
  // 0.26.0：交互三闸门是 L1 的独立一段（判级 / 堵塞项 / 追加评估）。
  assert.match(policy, /## 交互三闸门/)
  assert.match(policy, /T0 直答/)
  assert.match(policy, /R0 只补细节/)
  // owns 要登记这些条，否则「谁该说什么」的分层表与实现脱节。
  const l1 = PROMPT_LAYERS.find(layer => layer.id === 'L1')
  assert.ok(l1.owns.some(item => item.includes('交互三闸门')), 'L1 owns 应登记交互三闸门')
  assert.ok(l1.owns.some(item => item.includes('BLOCKER_RULE')), 'L1 owns 应登记堵塞项口径的措辞源')
  assert.ok(l1.owns.some(item => item.includes('grill-me')), 'L1 owns 应登记 grill-me 技能的触发口径')
  assert.equal(layerViolations('L1', policy).length, 0)
})

test('推进循环归 L1：句子逐字来自 copy.js，通知尾部动作指令与它同源', () => {
  const policy = renderCoordinatorPolicy({})
  const block = renderAdvanceLoopPolicy()
  // 每一句都逐字来自 copy.js 的 ADVANCE_LOOP_LINES（改一处两处一起变，不许各写一套）。
  for (const [key, line] of Object.entries(ADVANCE_LOOP_LINES)) {
    assert.ok(block.includes(line), `推进循环段落缺少 ${key}`)
    assert.ok(policy.includes(line), `L1 policy 缺少 ${key}`)
  }
  // 归层：L1 独占；W1/L2/L3 不许出现（子会话只回报，不判断下一步该推进还是提问）。
  const l1 = PROMPT_LAYERS.find(layer => layer.id === 'L1')
  assert.ok(l1.owns.some(item => item.includes('推进循环')), 'L1 owns 应登记推进循环')
  assert.ok(l1.owns.some(item => item.includes('ADVANCE_LOOP_LINES')), 'L1 owns 应写明措辞源')
  assert.deepEqual(layerViolations('L1', policy), [])
  for (const leaked of ['推进循环：收到回报必须推进', '用 ask_user_question 问「还有新任务吗」']) {
    assert.notDeepEqual(layerViolations('W1', leaked), [], `W1 不该复述：${leaked}`)
    assert.notDeepEqual(layerViolations('L2', leaked), [], `L2 不该复述：${leaked}`)
    assert.notDeepEqual(layerViolations('L3', leaked), [], `L3 不该复述：${leaked}`)
  }
  // 通知层只贴动作指令：指向 L1 同一段，不重复解释能力边界。
  assert.ok(ADVANCE_NOTICE_HINT.includes(ADVANCE_LOOP_LINES.heading), '通知指令要指向 L1 的同一段')
  assert.deepEqual(layerViolations('NOTIFY', ADVANCE_NOTICE_HINT), [])
  const notify = PROMPT_LAYERS.find(layer => layer.id === 'NOTIFY')
  assert.ok(notify.owns.some(item => item.includes('ADVANCE_NOTICE_HINT')), 'NOTIFY owns 应登记动作指令')
})

test('任务链归 L1：判据句逐字来自 copy.js + 技能指针，W1/L2/L3 不许复述', () => {
  const policy = renderCoordinatorPolicy({})
  const block = renderTaskChainPolicy()
  // 改判据版（C2-3b）：L1 只渲染「标题 + 一句判据」。原断言「TASK_CHAIN_LINES 每条逐字出现」改为
  // 「判据句逐字出现」——细则句下沉到 skills/orch-task-chain，判据句仍单源在 copy.js（不各写一套）。
  assert.ok(block.includes(TASK_CHAIN_CRITERIA), '任务链段落缺少判据句')
  assert.ok(policy.includes(TASK_CHAIN_CRITERIA), 'L1 policy 缺少判据句')
  for (const [key, line] of Object.entries(TASK_CHAIN_LINES)) {
    if (key === 'heading') continue
    assert.equal(block.includes(line), false, `任务链段落不该再摊开细则 ${key}`)
  }
  // 判据 + 技能指针：缺指针，模型只知道「是一条链」却拿不到建链时机/失败传播的细节。
  assert.match(block, /详见 skill\(\{ name: 'orch-task-chain' \}\)/)
  // 归层：L1 独占（子会话只读前置事实，不建链、不判断时机）。
  const l1 = PROMPT_LAYERS.find(layer => layer.id === 'L1')
  assert.ok(l1.owns.some(item => item.includes('任务链')), 'L1 owns 应登记任务链')
  assert.ok(l1.owns.some(item => item.includes('TASK_CHAIN_CRITERIA')), 'L1 owns 应写明措辞源（判据常量）')
  assert.deepEqual(layerViolations('L1', policy), [])
  for (const leaked of ['任务链：B 的输入是 A 的产物', 'dependsOn 不是阻塞等待：先落 waiting_dep']) {
    assert.notDeepEqual(layerViolations('W1', leaked), [], `W1 不该复述：${leaked}`)
    assert.notDeepEqual(layerViolations('L2', leaked), [], `L2 不该复述：${leaked}`)
    assert.notDeepEqual(layerViolations('L3', leaked), [], `L3 不该复述：${leaked}`)
  }
})

// ---- W1：任务执行者 per-turn policy（t-4f7ce108） ---------------------------------

test('W1 段落固定六句 + 条件一句：句子逐字来自 copy.js', () => {
  const plain = renderWorkerPolicy()
  assert.match(plain, new RegExp(`^## ${WORKER_POLICY_HEADING}`))
  for (const [key, line] of Object.entries(WORKER_POLICY_LINES)) {
    if (key === 'worktree') {
      assert.equal(plain.includes(line), false, '非隔离任务不给装依赖授权')
      continue
    }
    assert.ok(plain.includes(line), `W1 缺少 ${key} 的句子`)
  }
  // 「收尾沉淀项目经验」这一句的边界逐字在 W1 里（写自己任务的项目记忆、不写 preference/全局/日志）。
  assert.ok(plain.includes(WORKER_MEMORY_HINT), 'W1 应有项目经验沉淀引导')
  assert.match(WORKER_MEMORY_HINT, /有值得复用的项目经验就用 memory_note 写一条 note\/lesson\/decision/)
  assert.match(WORKER_MEMORY_HINT, /project 只能是你自己任务的 target_dir/)
  assert.match(WORKER_MEMORY_HINT, /单任务最多 3 条/)
  assert.match(WORKER_MEMORY_HINT, /不写 preference、不写全局\/跨项目记忆，也不写日志/)
  // 2026-11-23（用户原话「权限/环境失败必须写进回报」）：「先自纠一次、仍失败就写进 summary」这一句在 W1。
  assert.ok(plain.includes(WORKER_PERMISSION_HINT), 'W1 应有权限/环境失败的回报要求')
  assert.equal(WORKER_POLICY_LINES.permission, WORKER_PERMISSION_HINT)
  assert.match(WORKER_PERMISSION_HINT, /权限\/沙箱\/审批拒绝或环境失败/)
  assert.match(WORKER_PERMISSION_HINT, /sandbox_permissions \+ justification 重试一次/)
  assert.match(WORKER_PERMISSION_HINT, /task_report 的 summary/)
  assert.match(WORKER_PERMISSION_HINT, /交付 done 时同样必须写/)
  // 条件句只在真隔离（requested / created / reused）出现。
  for (const worktreeState of ['requested', 'created', 'reused']) {
    assert.ok(renderWorkerPolicy({ worktreeState }).includes(WORKER_POLICY_LINES.worktree), `${worktreeState} 应给装依赖授权`)
  }
  for (const worktreeState of [undefined, 'none', 'degraded', 'rejected', 'failed', 'cleaned']) {
    assert.equal(renderWorkerPolicy({ worktreeState }).includes(WORKER_POLICY_LINES.worktree), false, String(worktreeState))
  }
})

test('W1 拥有执行中上报 / 权限·环境失败回报 / 交付回报 / 装依赖 / 主动读 context / 沉淀项目经验（brief 与 persona 不再各写一份）', () => {
  const w1 = PROMPT_LAYERS.find(layer => layer.id === 'W1')
  assert.equal(w1.audience, 'worker')
  for (const marker of ['BLOCKED_HINT', 'CONFIRM_HINT', 'WORKTREE_INSTALL_HINT', 'WORKER_CONTEXT_HINT', 'WORKER_DETAIL_HINT', 'WORKER_MEMORY_HINT', 'WORKER_PERMISSION_HINT']) {
    assert.ok(w1.owns.some(item => item.includes(marker)), `W1 owns 应登记 ${marker}`)
  }
  // 归层自检：W1 段落本身干净（不讲协调者口径），L2 不许把它抄回去。
  const policy = renderWorkerPolicy({ worktreeState: 'created' })
  assert.deepEqual(layerViolations('W1', policy), [])
  for (const leaked of [
    `执行中只把**堵塞项**交给用户拍板：${BLOCKED_HINT}`,
    `完成后用 task_report 回报（progress / done / blocked / needs_auth）`,
    `本任务在独立检出里跑，检出目录没有依赖`,
    `需要历史经验/项目背景时主动调 context`,
    `有值得复用的项目经验时用 memory_note 写一条 note/lesson/decision，不写 preference/全局`,
    `能自己用窄一级的 sandbox_permissions + justification 重试一次就重试一次`,
  ]) {
    assert.notDeepEqual(layerViolations('L2', leaked), [], `L2 不该复述 W1 的口径：${leaked.slice(0, 24)}…`)
  }
})

test('W1 与 brief / persona / task_detail 的句子不重复（同一句只在一层）', () => {
  const brief = renderBrief({ taskRef: 'tk-1a2b3c', access: 'full' })
  const detail = sampleDetail()
  const policy = renderWorkerPolicy({ worktreeState: 'created' })
  for (const line of Object.values(WORKER_POLICY_LINES)) {
    assert.equal(brief.includes(line), false, 'brief 不许内联 W1 的句子')
    assert.equal(detail.includes(line), false, 'task_detail 不许内联 W1 的句子')
  }
  // 反向：brief 的指针也不许出现在 W1（两层各说一句，不互相抄）。
  assert.equal(policy.includes('【任务详情】'), false)
  // persona 只剩身份：静态引导已迁到 W1。
  const yml = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const workerPrefix = yml.split('id: dsh-orchestrator-worker')[1] ?? ''
  assert.equal(workerPrefix.includes(WORKER_CONTEXT_HINT), false, 'worker persona 不再内联上下文引导（归 W1）')
  assert.match(workerPrefix, /你是 dsh-orchestrator 的任务执行者/, 'persona 只留身份一句')
  assert.match(WORKER_CONTEXT_HINT, /主动调 context/)
  assert.match(WORKER_CONTEXT_HINT, /不要等协调者注入/)
})

test('L4 onboarding 瘦身：不再复述 L1 的 6 条能力边界（审计 §2.7）', () => {
  const violations = layerViolations('L4', ONBOARDING_PROMPT)
  assert.deepEqual(violations, [], `onboarding 仍在复述 L1 口径：\n${violations.join('\n')}`)
  // 它该保留的两件事：自我介绍 + 派索引任务。
  assert.match(ONBOARDING_PROMPT, /先向用户简短介绍/)
  assert.match(ONBOARDING_PROMPT, /readOnly:true,worktree:false/)
  // 瘦身后长度明显下降（0.19.x 是 708 字；这里只断言「不再背整段能力边界」）。
  assert.ok(ONBOARDING_PROMPT.length < 620, `onboarding 应瘦身到 620 字以内，实际 ${ONBOARDING_PROMPT.length}`)
  // 它必须明确把规则指向 L1，而不是自己重写一遍。
  assert.match(ONBOARDING_PROMPT, /系统提示词/)
})

test('L2 brief 只指路：不定义交付/关闭口径，不讲协调者工具，也不内联静态提示', () => {
  const brief = renderBrief({ taskRef: 'tk-1a2b3c', access: 'full' })
  assert.deepEqual(layerViolations('L2', brief), [])
  assert.match(brief, /【任务引用】tk-1a2b3c/)
  assert.match(brief, /task_detail/)
  // 协调者口径与 W1 静态口径一律不出现。
  assert.doesNotMatch(brief, /task_close|present|read_workspace|已交付待确认/)
  assert.doesNotMatch(brief, /task_report|worktree 检出|主动调 context/)
})

test('L2 只报送商品：堵塞项口径的渲染归 W1，brief 不复述 L1 的分级与评估', () => {
  const w1 = PROMPT_LAYERS.find(layer => layer.id === 'W1')
  assert.ok(w1.owns.some(item => item.includes('BLOCKER_RULE')), 'W1 owns 应写明堵塞项口径引用 BLOCKER_RULE')
  const brief = renderBrief({ taskRef: 'tk-1a2b3c', access: 'full' })
  assert.deepEqual(layerViolations('L2', brief), [])
  // 探针：把分级/评估抄进 brief 或 task_detail 就红（这是 L1 的判断，不是子会话的规则）。
  for (const leaked of ['T0 / T1 判级：简单任务不提问', 'R0 / R1 先评估再确认', '见「三闸门」的分级表']) {
    assert.notDeepEqual(layerViolations('L2', leaked), [], `L2 不该复述：${leaked}`)
    assert.notDeepEqual(layerViolations('L3', leaked), [], `L3 不该复述：${leaked}`)
  }
})

test('L2 行数：2 行基准，有任务名 +1、full +1；worktree 状态不再进 brief', () => {
  const plain = renderBrief({ taskRef: 'tk-test1' }).split('\n')
  const full = renderBrief({ taskRef: 'tk-test1', access: 'full' }).split('\n')
  assert.equal(plain.length, 2)
  assert.equal(full.length, 3)
  assert.match(full[1], /^【访问级别】/)
  assert.match(plain[1], /^【任务详情】/)
  // R2：任务名是可选项——给了才多一行，仍不内联目标/验收/静态提示。
  const named = renderBrief({ taskRef: 'tk-test1', taskName: '修发版' }).split('\n')
  assert.equal(named.length, 3)
  assert.match(named[1], /^【任务名】修发版$/)
  assert.equal(renderBrief({ taskRef: 'tk-test1', taskName: '修发版', access: 'full' }).split('\n').length, 4)
})

test('L3 task_detail 只给任务详情：不重复 brief 的指路，不讲协调者口径，不重复 W1 的回报口径', () => {
  const detail = sampleDetail()
  assert.deepEqual(layerViolations('L3', detail), [])
  assert.match(detail, /【验收标准】/)
  assert.match(detail, /【约束】/)
  assert.doesNotMatch(detail, /先调 task_detail/)
  // 完成动作归 W1：task_detail 不再写 summary 三问 / 四状态。
  assert.doesNotMatch(detail, new RegExp(SUMMARY_FIELDS))
  assert.doesNotMatch(detail, /progress \/ done \/ blocked \/ needs_auth/)
})

test('通知只讲动作：交付指令与 present 上限不重复解释能力边界', () => {
  assert.deepEqual(layerViolations('NOTIFY', `${PRESENT_HINT}\n${DELIVERED_HINT}`), [])
  assert.match(PRESENT_HINT, new RegExp(PRESENT_LIMIT_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(PRESENT_HINT, /已登记的产物/)
  assert.match(DELIVERED_HINT, /默认保持待确认/)
})

// R0（用户追加）：协调者不干活，但知道有哪些技能才能更好派活——L1 要给出**通用**许可，
// 不只 grill-me 那一条。边界同样是硬要求：只读不执行、按需少而准。
test('L1 允许协调者按需加载技能来判断派活（只读不执行、一次 1–2 个）', () => {
  const policy = renderCoordinatorPolicy({})
  assert.match(policy, /可以按需加载技能，只为判断怎么派活/)
  assert.match(policy, /技能目录＝名称＋摘要，由宿主注入上下文/)
  assert.match(policy, /\*\*只读不执行\*\*：加载技能 ≠ 按技能步骤干活/)
  assert.match(policy, /一次 1–2 个/)
  assert.match(policy, /能直接回答的不加载/)
  assert.match(policy, /task_create 的 goal \/ constraints/)
  // 它仍然不是执行者：许可段落里不许出现写/命令工具的旁路。
  assert.doesNotMatch(policy, /skill\s*\([^)]*\)[^。\n]*写文件/)
  // 这条许可只属于 L1：brief（L2）与 task_detail（L3）都不许抄。
  assert.deepEqual(layerViolations('L2', renderBrief({ taskRef: 'tk-test1' })), [])
  assert.equal(renderBrief({ taskRef: 'tk-test1' }).includes('按需加载技能'), false)
  assert.equal(sampleDetail().includes('按需加载技能'), false)
})

test('矛盾 2 已修：交付口径只有 W1 一份（summary 三问 + done 清空 question/options）', () => {
  const policy = renderWorkerPolicy()
  assert.ok(CONFIRM_HINT.includes(SUMMARY_FIELDS))
  assert.ok(policy.includes(SUMMARY_FIELDS))
  // 且都不许再出现「选项进 question+options」这种教用户用不存在能力的措辞。
  for (const text of [CONFIRM_HINT, policy, renderCoordinatorPolicy({}), ONBOARDING_PROMPT, DELIVERED_HINT]) {
    assert.doesNotMatch(text, /选项进\s*question\+options/)
  }
  // done 不支持 question/options 这条平台事实必须在 W1 写明。
  assert.match(CONFIRM_HINT, /done 会清空 question\/options/)
})

test('矛盾 1 已修：文档不再教「交付时选项进 question+options」', () => {
  for (const file of ['docs/LIMITATIONS.md', 'docs/testing.md', 'docs/ARCHITECTURE.md', 'README.md']) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    assert.doesNotMatch(text, /选项进\s*question\+options/, `${file} 仍在教不存在的能力`)
  }
  // 而「done 不支持」这件事要在 LIMITATIONS 里如实写出来。
  const limits = readFileSync(new URL('../docs/LIMITATIONS.md', import.meta.url), 'utf8')
  assert.match(limits, /done\*\*?不支持|不支持 `question`\/`options`|会把它们清空/)
})

test('矛盾 3 已修：文档的 brief 行数描述与实现一致（2–4 行）', () => {
  const doc = readFileSync(new URL('../docs/testing.md', import.meta.url), 'utf8')
  // R2 起：引用 2 行基准，任务名 +1、access:'full' +1 → 2–4 行。
  assert.match(doc, /2–4 行/)
  // 实现侧核对：只有引用就是 2 行，加了名字/完整访问各多一行。
  assert.equal(renderBrief({ taskRef: 'tk-test1' }).split('\n').length, 2)
  assert.equal(renderBrief({ taskRef: 'tk-test1', taskName: 'x' }).split('\n').length, 3)
  assert.equal(renderBrief({ taskRef: 'tk-test1', taskName: 'x', access: 'full' }).split('\n').length, 4)
})

test('跨层共享口径只有一个来源：present 上限、交付不是结束', () => {
  assert.equal(PRESENT_MAX_FILES, 4)
  assert.match(PRESENT_LIMIT_TEXT, /1-4 个最关键的/)
  // policy 与通知都用同一个常量拼，改了常量两边一起变。
  assert.ok(renderCoordinatorPolicy({}).includes(PRESENT_LIMIT_TEXT))
  assert.ok(PRESENT_HINT.includes(PRESENT_LIMIT_TEXT))
  // 「done 不是终态」这条口径的各层都必须与共享常量同义（不许出现「done 即结束」）。
  assert.match(DELIVERY_NOT_FINAL, /不是终态/)
  for (const [name, text] of [
    ['L1', renderCoordinatorPolicy({})],
    ['W1', renderWorkerPolicy()],
    ['NOTIFY', DELIVERED_HINT],
  ]) {
    assert.doesNotMatch(text, /done\s*即(?:任务)?(?:结束|终态|完成)/, `${name} 出现「done 即结束」`)
  }
})

test('偏好段归 L1 末尾：优先级低于硬规则，且可单独开关', () => {
  // 用出厂种子验证渲染（真实 loadPreferences 的行为在 test/preferences.test.js 里覆盖）。
  const block = renderPreferenceBlock(PRESET_PREFERENCES, { maxItems: 12, maxChars: 1200 })
  assert.match(block, /^## 偏好/)
  // 优先级声明必须写明「不覆盖硬规则」——这是偏好不能变成权限通道的结构性保证。
  assert.match(block, /不覆盖/)
  assert.match(block, /硬性规则/)
  // 段内每条都带分类标签，便于用户辨认来源。
  assert.match(block, /- \[派发\]/)
})
