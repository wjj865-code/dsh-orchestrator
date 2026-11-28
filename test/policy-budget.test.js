// C3：协调者 policy 的**字符预算回归门**。
//
// 为什么要有这个文件：C2 把四段压成判据句以后，L1 的体量靠「这次压了多少」这种一次性结论是守不住的——
// 下一次谁再往 policy 里加两句，没有任何东西会红。这里把「预算」变成断言：
//   ① 默认配置下总量有上限；② minimal 档更小；③ 预算被压到极小时**三个不可逆探针仍在**
//   （硬规则段与拍板流程段永不降级）；④ 八段逐段各有上限，防「总量没超但某一段偷偷膨胀」。
//
// 口径说明：计长一律按**码点**（`[...text].length`），与 renderCoordinatorPolicy 的 policyMaxChars 一致；
// 不用 `.length`（UTF-16 会把中文算 1、emoji 算 2，与用户直觉和配置口径都不符）。
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  COORDINATOR_POLICY, renderCoordinatorPolicy, renderInteractionPolicy, renderWorktreePolicy,
  renderWriteGuardPolicy, resetPolicyDropWarnings,
} from '../index.js'
import { PLAN_APPROVAL_OPTIONS_TEXT } from '../src/copy.js'
import {
  POLICY_DROP_ORDER, POLICY_MINIMAL_SEGMENTS, renderAdvanceLoopPolicy, renderDecisionPolicy,
  renderParallelPolicy, renderTaskChainPolicy, renderWorkerPolicy,
} from '../src/prompt-layers.js'

/** 码点计长（与 policyMaxChars 同口径）。 */
const chars = text => [...text].length

/** ① 默认配置下的总量上限（结构收敛后的新基线，留少量回涨余量）。 */
const TOTAL_MAX = 5400
/** ② minimal 档上限。 */
const MINIMAL_MAX = 2520
/** ⑤ W1 每次注入体量上限。 */
const WORKER_MAX = 1350

/**
 * ④ 八段逐段上限（C3 落地时的实测值 + 少量余量，只防回涨、不逼着继续压）。
 *
 * 为什么逐段也要管：总量是一条线，一条线挡不住「这段加 200、那段减 200」的腾挪——
 * 真正要守的是「每一段都别再长回去」。
 */
const SEGMENT_CAPS = Object.freeze({
  hard: 1600,
  gates: 1400,
  decision: 950,
  advance: 790,
  chain: 150,
  parallel: 150,
  worktree: 250,
  writeGuard: 230,
})

/** 八段逐段文本（顺序与 renderCoordinatorPolicy 的拼接顺序一致）。 */
const segmentsOf = (config = {}) => ({
  hard: COORDINATOR_POLICY,
  gates: renderInteractionPolicy(),
  decision: renderDecisionPolicy(),
  advance: renderAdvanceLoopPolicy(),
  chain: renderTaskChainPolicy(),
  parallel: renderParallelPolicy(),
  worktree: renderWorktreePolicy(config),
  writeGuard: renderWriteGuardPolicy(config),
})

test('① 默认配置：协调者 policy 总量不超预算上限', () => {
  resetPolicyDropWarnings()
  const policy = renderCoordinatorPolicy({})
  assert.ok(chars(policy) <= TOTAL_MAX, `L1 policy 实测 ${chars(policy)} 字符，超出上限 ${TOTAL_MAX}`)
})

test('①b 硬规则段只放工具边界与派发/交付，不再承载分级与拍板细则', () => {
  assert.match(COORDINATOR_POLICY, /### 工具边界/)
  assert.match(COORDINATOR_POLICY, /### 派发与交付/)
  // 工具数量/旧工具迁移表属于工具面文档，不再常驻每回合提示词。
  assert.doesNotMatch(COORDINATOR_POLICY, /12 个工具|旧 task_/)
  // 判级表与计划批准细则各有唯一所有者，硬规则段只留短指针。
  assert.equal(COORDINATOR_POLICY.includes('| T0 直答 |'), false)
  assert.equal(COORDINATOR_POLICY.includes('options 固定四项'), false)
  assert.equal(COORDINATOR_POLICY.includes('renderDecisionSummary'), false)
})

test('② minimal 档：只留硬规则 + 拍板流程，且体量显著更小', () => {
  resetPolicyDropWarnings()
  const minimal = renderCoordinatorPolicy({ promptProfile: 'minimal' })
  assert.ok(chars(minimal) <= MINIMAL_MAX, `minimal 档实测 ${chars(minimal)} 字符，超出上限 ${MINIMAL_MAX}`)
  // 结构口径：只保留 POLICY_MINIMAL_SEGMENTS 这两段，其余六段的标题一个都不许出现。
  const kept = segmentsOf()
  for (const [id, text] of Object.entries(kept)) {
    const heading = text.split('\n')[0]
    const present = minimal.includes(heading)
    assert.equal(present, POLICY_MINIMAL_SEGMENTS.includes(id), `minimal 档里「${id}」段的出现与否不符合预期`)
  }
})

test('③ 预算压到 3000：三个不可逆探针仍在（硬规则段与拍板流程段永不降级）', () => {
  resetPolicyDropWarnings()
  const squeezed = renderCoordinatorPolicy({ policyMaxChars: 3000 })
  // 探针 1：wait_agent 禁令（硬规则段）。
  assert.match(squeezed, /禁止使用 wait_agent/, 'wait_agent 禁用句被降级丢掉了')
  // 探针 2：access:'full' 的边界说明（硬规则段）。
  assert.match(squeezed, /access:'full'/, "access:'full' 说明被降级丢掉了")
  // 探针 3：计划批准四选一的选项文本（拍板流程段）。
  assert.ok(squeezed.includes(PLAN_APPROVAL_OPTIONS_TEXT), '四选一批准选项被降级丢掉了')
  // 预算再小也不许降到「两段不可逆闸门」以下——超预算是可接受的，丢闸门不是。
  const floor = renderCoordinatorPolicy({ promptProfile: 'minimal', policyMaxChars: 3000 })
  assert.equal(squeezed, floor, 'full 档压到 3000 后的结果应与 minimal 档一致（只剩两段不可逆闸门）')
})

test('④ 八段逐段不超上限（防「总量没超但某段偷偷膨胀」）', () => {
  const segments = segmentsOf()
  for (const [id, text] of Object.entries(segments)) {
    const cap = SEGMENT_CAPS[id]
    assert.ok(cap !== undefined, `段 ${id} 没有上限口径`)
    assert.ok(chars(text) <= cap, `段「${id}」实测 ${chars(text)} 字符，超出逐段上限 ${cap}`)
  }
  // 段表必须覆盖 POLICY_DROP_ORDER 里的每个可降级段，否则降级顺序会指向不存在的段。
  for (const id of POLICY_DROP_ORDER) {
    assert.ok(segments[id] !== undefined, `降级顺序里的「${id}」不是八段之一`)
    assert.equal(POLICY_MINIMAL_SEGMENTS.includes(id), false, `不可降级段「${id}」不得出现在降级顺序里`)
  }
})

test('⑤ W1 每次注入不超上限', () => {
  const worker = renderWorkerPolicy()
  assert.ok(chars(worker) <= WORKER_MAX, `W1 实测 ${chars(worker)} 字符，超出上限 ${WORKER_MAX}`)
})

test('降级顺序：超预算时按固定顺序丢段，且每次只 warn 一次', () => {
  resetPolicyDropWarnings()
  const warnings = []
  const original = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    // 预算刚好卡在「丢前两段够、丢第三段不够」的位置之外：用 2000 逼它把可降级段丢到底。
    renderCoordinatorPolicy({ policyMaxChars: 2000 })
    renderCoordinatorPolicy({ policyMaxChars: 2000 })
  } finally {
    console.warn = original
  }
  // 第二次渲染不再重复 warn（进程级去重）。
  const dropped = warnings.filter(line => line.includes('已丢弃'))
  assert.ok(dropped.length > 0, '超预算应至少 warn 一次')
  assert.equal(new Set(dropped).size, dropped.length, `同一次降级被重复 warn：${dropped.length} 条`)
  // 顺序口径：并行最先、三闸门最后（硬规则与拍板流程不在表里）。
  assert.deepEqual([...POLICY_DROP_ORDER], ['parallel', 'chain', 'worktree', 'writeGuard', 'advance', 'gates'])
})

test('预算内不降级：八段全渲染，不产生任何降级 warn', () => {
  resetPolicyDropWarnings()
  const warnings = []
  const original = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  let policy
  try {
    policy = renderCoordinatorPolicy({ policyMaxChars: 20000 })
  } finally {
    console.warn = original
  }
  assert.deepEqual(warnings, [], `预算充足时不该 warn：${warnings.join(' | ')}`)
  for (const text of Object.values(segmentsOf())) assert.ok(policy.includes(text), '预算内应八段全渲染')
})
