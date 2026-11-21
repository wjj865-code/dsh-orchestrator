// 提示词分层（prompt-layers）：五层职责边界、消除的 6 处重叠、修掉的 3 处矛盾。
//
// 这一组不锁具体措辞，锁**归层**：同一条口径只许出现在一个层，跨层共享的必须逐字同源。
// 判据表在 `src/prompt-layers.js` 的 `PROMPT_LAYERS`；探针在 `layerViolations`。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  DELIVERY_NOT_FINAL, LAYER_NAME, PRESENT_LIMIT_TEXT, PRESENT_MAX_FILES, PROMPT_LAYERS, WORKER_CONTEXT_HINT,
  layerViolations,
} from '../src/prompt-layers.js'
import { renderCoordinatorPolicy } from '../index.js'
import { CONFIRM_HINT, SUMMARY_FIELDS, renderBrief } from '../src/brief.js'
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

test('五层清单完整：L1/L2/L3/L4/NOTIFY 各有载体、受众与独占职责', () => {
  assert.deepEqual(PROMPT_LAYERS.map(layer => layer.id), ['L1', 'L2', 'L3', 'L4', 'NOTIFY'])
  for (const layer of PROMPT_LAYERS) {
    assert.ok(layer.name !== '', `${layer.id} 缺名称`)
    assert.ok(layer.carrier !== '', `${layer.id} 缺载体说明`)
    assert.ok(['coordinator', 'worker'].includes(layer.audience), `${layer.id} 受众不合法`)
    assert.ok(layer.owns.length > 0, `${layer.id} 没有独占职责`)
    assert.ok(Array.isArray(layer.forbids), `${layer.id} 缺 forbids`)
  }
  assert.equal(LAYER_NAME.L1, '协调者 policy')
  assert.equal(LAYER_NAME.L4, 'onboarding')
})

test('L1 承担全部协调者规则（每回合重渲染的那一层）', () => {
  const policy = renderCoordinatorPolicy({})
  for (const fragment of ['wait_agent', 'task_close', 'task_message', 'present', 'read_workspace', 'ask_user_question', 'schedule_create', 'grill-me']) {
    assert.ok(policy.includes(fragment), `L1 缺 ${fragment}`)
  }
  // 0.26.0：只读工具与 grill-me 的用法都在 L1（每回合都在，不会被 compaction 吃掉）。
  assert.match(policy, /skill\(\{ name: 'grill-me' \}\)/, 'L1 应给出加载 grill-me 的调用形状')
  assert.match(policy, /read \/ glob \/ grep（只读/, 'L1 应说明只读工具面')
  // 策略段也在 L1（结构化配置渲染）。
  assert.match(policy, /## worktree 隔离/)
  assert.match(policy, /## 同写域并发防护/)
  // 0.26.0：交互三闸门是 L1 的独立一段（判级 / 堵塞项 / 追加评估）。
  assert.match(policy, /## 交互三闸门/)
  assert.match(policy, /T0 直答/)
  assert.match(policy, /R0 只补细节/)
  // owns 要登记这两条，否则「谁该说什么」的分层表与实现脱节。
  const l1 = PROMPT_LAYERS.find(layer => layer.id === 'L1')
  assert.ok(l1.owns.some(item => item.includes('交互三闸门')), 'L1 owns 应登记交互三闸门')
  assert.ok(l1.owns.some(item => item.includes('BLOCKER_RULE')), 'L1 owns 应登记堵塞项口径的措辞源')
  assert.ok(l1.owns.some(item => item.includes('grill-me')), 'L1 owns 应登记 grill-me 技能的触发口径')
  assert.equal(layerViolations('L1', policy).length, 0)
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

test('L2 brief 只指路：不定义交付/关闭口径，不讲协调者工具', () => {
  const brief = renderBrief({ taskId: 't-1a2b3c4d', access: 'full', worktreeState: 'created' })
  assert.deepEqual(layerViolations('L2', brief), [])
  assert.match(brief, /【任务编号】t-1a2b3c4d/)
  assert.match(brief, /task_detail/)
  // 协调者口径一律不出现。
  assert.doesNotMatch(brief, /task_close|present|read_workspace|已交付待确认/)
})

test('L2 只报送商品：堵塞项口径引用 copy.js，不复述 L1 的分级与评估', () => {
  const l2 = PROMPT_LAYERS.find(layer => layer.id === 'L2')
  assert.ok(l2.owns.some(item => item.includes('BLOCKER_RULE')), 'L2 owns 应写明堵塞项口径引用 BLOCKER_RULE')
  const brief = renderBrief({ taskId: 't-1a2b3c4d', access: 'full', worktreeState: 'created' })
  assert.deepEqual(layerViolations('L2', brief), [])
  // 探针：把分级/评估抄进 brief 或 task_detail 就红（这是 L1 的判断，不是子会话的规则）。
  for (const leaked of ['T0 / T1 判级：简单任务不提问', 'R0 / R1 先评估再确认', '见「三闸门」的分级表']) {
    assert.notDeepEqual(layerViolations('L2', leaked), [], `L2 不该复述：${leaked}`)
    assert.notDeepEqual(layerViolations('L3', leaked), [], `L3 不该复述：${leaked}`)
  }
})

test('L2 行数：4 行基准，full 与隔离各加一行（修「四件事」漂移）', () => {
  const plain = renderBrief({ taskId: 't-1' }).split('\n')
  const full = renderBrief({ taskId: 't-1', access: 'full' }).split('\n')
  const isolated = renderBrief({ taskId: 't-1', worktreeState: 'created' }).split('\n')
  const both = renderBrief({ taskId: 't-1', access: 'full', worktreeState: 'created' }).split('\n')
  assert.equal(plain.length, 4)
  assert.equal(full.length, 5)
  assert.equal(isolated.length, 5)
  assert.equal(both.length, 6)
  assert.match(full[1], /^【访问级别】/)
  assert.match(isolated[1], /^【worktree 依赖】/)
})

test('L2 的第二个载体（worker 预设 persona）：主动读 context 的引导逐字同源，brief 不重复它', () => {
  const yml = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  // 措辞只在 src/prompt-layers.js 定义一次；cordis.patch.yml 的 worker persona prefix 必须逐字包含。
  assert.ok(yml.includes(WORKER_CONTEXT_HINT), `worker persona 未逐字包含 WORKER_CONTEXT_HINT：\n${WORKER_CONTEXT_HINT}`)
  assert.match(WORKER_CONTEXT_HINT, /主动调 context/)
  assert.match(WORKER_CONTEXT_HINT, /不要等协调者注入/)
  // 归层：这条引导属 L2（发给子会话的指引），且是「出生即带」的静态前缀，不是每条 brief 的临时注入。
  const l2 = PROMPT_LAYERS.find(layer => layer.id === 'L2')
  assert.match(l2.carrier, /persona/)
  assert.ok(l2.owns.some(item => item.includes('WORKER_CONTEXT_HINT')), 'L2 owns 应登记这条引导的措辞源')
  const brief = renderBrief({ taskId: 't-1a2b3c4d' })
  assert.equal(brief.includes(WORKER_CONTEXT_HINT), false, 'brief 只留任务信息，不重复 persona 的引导')
})

test('L3 task_detail 只给任务详情与完成动作：不重复 brief 的指路，不讲协调者口径', () => {
  const detail = sampleDetail()
  assert.deepEqual(layerViolations('L3', detail), [])
  assert.match(detail, /【验收标准】/)
  assert.match(detail, /【约束】/)
  assert.match(detail, /task_report/)
  assert.doesNotMatch(detail, /先调 task_detail/)
})

test('通知只讲动作：交付指令与 present 上限不重复解释能力边界', () => {
  assert.deepEqual(layerViolations('NOTIFY', `${PRESENT_HINT}\n${DELIVERED_HINT}`), [])
  assert.match(PRESENT_HINT, new RegExp(PRESENT_LIMIT_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(PRESENT_HINT, /已登记的产物/)
  assert.match(DELIVERED_HINT, /默认保持待确认/)
})

test('矛盾 2 已修：brief 与 task_detail 的交付口径同源（都从 SUMMARY_FIELDS 拼）', () => {
  // 两处必须逐字包含同一组要素，子会话才不会一个写「要点」一个写「三问」。
  assert.ok(CONFIRM_HINT.includes(SUMMARY_FIELDS))
  assert.ok(sampleDetail().includes(SUMMARY_FIELDS))
  // 且都不许再出现「选项进 question+options」这种教用户用不存在能力的措辞。
  for (const text of [CONFIRM_HINT, sampleDetail(), renderCoordinatorPolicy({}), ONBOARDING_PROMPT, DELIVERED_HINT]) {
    assert.doesNotMatch(text, /选项进\s*question\+options/)
  }
  // done 不支持 question/options 这条平台事实必须在 brief 里写明。
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

test('矛盾 3 已修：文档的 brief 行数描述与实现一致（4–6 行）', () => {
  const doc = readFileSync(new URL('../docs/testing.md', import.meta.url), 'utf8')
  assert.match(doc, /4 行/)
  assert.match(doc, /4–6 行/)
  // 实现侧核对：不隔离不 full 就是 4 行。
  assert.equal(renderBrief({ taskId: 't-1' }).split('\n').length, 4)
})

test('跨层共享口径只有一个来源：present 上限、交付不是结束', () => {
  assert.equal(PRESENT_MAX_FILES, 4)
  assert.match(PRESENT_LIMIT_TEXT, /1-4 个最关键的/)
  // policy 与通知都用同一个常量拼，改了常量两边一起变。
  assert.ok(renderCoordinatorPolicy({}).includes(PRESENT_LIMIT_TEXT))
  assert.ok(PRESENT_HINT.includes(PRESENT_LIMIT_TEXT))
  // 「done 不是终态」这条口径的三层都必须与共享常量同义（不许出现「done 即结束」）。
  assert.match(DELIVERY_NOT_FINAL, /不是终态/)
  for (const [name, text] of [
    ['L1', renderCoordinatorPolicy({})],
    ['L3', sampleDetail()],
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
