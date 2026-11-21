// 交互三闸门（0.26.0）：开工前确认（T0–T3）→ 执行期少打扰（B1–B4）→ 变更先评估（R0–R2）。
//
// 这组用例锁的是**结构与口径**，不是逐字措辞：段在 L1 且排在 worktree/写域之前、四级判级表齐全、
// 堵塞项四类与 brief 同源、R0–R2 三档与「先评估 → 再确认 → 才通知」的顺序闸门都在。
// 为什么单独一个文件：三闸门是协调者每回合都要读的行为规则，删掉一段或把顺序调换都不会报错，
// 只会让「该问没问 / 不该问又问」在真机上悄悄回来。
import test from 'node:test'
import assert from 'node:assert/strict'
import { renderCoordinatorPolicy, renderInteractionPolicy } from '../index.js'
import { renderBrief } from '../src/brief.js'
import { BLOCKER_RULE, CHANGE_REVIEW_FIELDS } from '../src/copy.js'
import { createTools } from '../src/tools.js'
import { loadConfig } from '../src/config.js'

const policy = () => renderCoordinatorPolicy({})
const section = () => renderInteractionPolicy()

test('交互闸门是 L1 的独立一段：排硬规则之后、worktree 与写域之前', () => {
  const text = policy()
  const gate = text.indexOf('## 交互三闸门')
  assert.ok(text.includes('## 交互三闸门（开工前确认 → 执行期少打扰 → 变更先评估）'), 'L1 缺少交互三闸门段落')
  // 硬规则在最前（判级是硬规则的补充，不改写既有口径）。
  assert.ok(text.indexOf('你是 dsh-orchestrator 的协调者。硬性规则') < gate)
  // 交互判级决定「要不要派单、怎么派」，逻辑上先于隔离与写域判定。
  assert.ok(gate < text.indexOf('## worktree 隔离'), '交互闸门必须在 worktree 段之前')
  assert.ok(gate < text.indexOf('## 同写域并发防护'), '交互闸门必须在写域段之前')
})

test('判级表齐全：T0 直答 / T1 直接做 / T2 先确认 / T3 先计划', () => {
  for (const level of ['T0 直答', 'T1 直接做', 'T2 先确认', 'T3 先计划']) {
    assert.ok(section().includes(`| ${level} |`), `判级表缺少 ${level} 行`)
  }
  assert.match(section(), /\| 级别 \| 判据（任一命中） \| 动作 \|/)
  // 判级只做一次，后续轮次沿用（不重复打扰）。
  assert.match(section(), /同一需求后续轮次沿用已判级别，不重复确认/)
})

test('堵塞项四类与 brief 同源：L1 与 L2 都逐字引用 copy.js 的 BLOCKER_RULE', () => {
  assert.ok(section().includes(BLOCKER_RULE), 'L1 的堵塞项必须逐字引用 BLOCKER_RULE')
  assert.ok(renderBrief({ taskId: 't-1a2b3c4d' }).includes(BLOCKER_RULE), 'brief 的 BLOCKED_HINT 必须逐字引用 BLOCKER_RULE')
  // 四类本身：验收/范围不可达、要新授权、子会话 blocked 且选项要用户定、工具面外查不到。
  for (const fragment of ['已确认的验收/范围/方案不可达', '需要新授权', '子会话报 blocked 且选项要用户定', '事实在你的工具面外查不到']) {
    assert.equal(BLOCKER_RULE.includes(fragment), true, `BLOCKER_RULE 缺少：${fragment}`)
  }
})

test('「不算堵塞项」清单在段内：进度、能否关闭、可给默认值的细节都不打扰', () => {
  const text = section()
  assert.match(text, /不算堵塞项/)
  for (const item of ['进度与交付汇报', '任务能否关闭', '命名/文案/顺序', '自己查得清的事实', '能回退的取舍']) {
    assert.ok(text.includes(item), `「不算堵塞项」清单缺少：${item}`)
  }
})

test('追加调整按影响分三档：R0 直接转 / R1 先评估再确认 / R2 必须拍板', () => {
  const text = section()
  assert.match(text, /R0 只补细节、不动验收与已交付结论/)
  assert.match(text, /直接 task_message 转给原会话/)
  assert.match(text, /R1 动到验收\/范围\/方案/)
  assert.match(text, /先给评估 \+ ask_user_question 拿确认/)
  assert.match(text, /R2 不可逆、权限、推翻已交付结论/)
  assert.match(text, /必须拍板/)
  // 评估三行与 task_message 描述同源（影响面 → 风险 → 建议）。
  assert.ok(text.includes(CHANGE_REVIEW_FIELDS), '评估要素必须逐字引用 CHANGE_REVIEW_FIELDS')
  const taskMessage = createTools({ db: {}, config: loadConfig({}) }).find(tool => tool.name === 'task_message')
  assert.ok(taskMessage.parameters.properties.message.description.includes(CHANGE_REVIEW_FIELDS), 'task_message 描述与 L1 评估要素不同源')
})

test('顺序闸门：先评估、再确认、最后才通知子任务（顺序不能换）', () => {
  const text = section()
  assert.match(text, /先评估、再确认、最后才通知子任务，顺序不能换/)
  // 陷阱写清：计划中的任务收到追加消息即视为批准，所以评估必须早于 task_message。
  assert.match(text, /确认后才通知子任务/)
  assert.match(text, /计划中的任务收到追加消息即视为批准/)
})

test('T1 不是免确认挡箭牌：不可逆最低 T2，且必须拍板', () => {
  const text = section()
  assert.match(text, /T1 不是「不问就干」/)
  assert.match(text, /不可逆动作永远不算 T1（最低 T2）/)
  assert.match(text, /不可逆仍必须拍板/)
  // 「你看着办」最多降一档，不能降掉不可逆的拍板。
  assert.match(text, /至多把 T2 降一档/)
})

test('与既有三原则互引不冲突：能直接回答就不派任务 / 少打扰只在执行期', () => {
  const text = policy()
  // 硬规则里的三条既有口径都还在，且都指向同一段交互闸门。
  assert.match(text, /能直接回答就不派任务/)
  assert.match(text, /「少打扰」是执行期口径，不是开工前不问/)
  assert.match(text, /开工前的意图确认（T2\/T3）/)
  assert.ok((text.match(/见下「## 交互三闸门」/g) ?? []).length >= 2, '硬规则应至少两处把判级指回交互闸门')
  // 反向：不许出现「不确认就执行 / 免审查」这类把闸门关掉的授权句式。
  for (const pattern of [/不问用户[^\n]{0,12}执行/, /无需(?:询问|确认)[^\n]{0,12}(?:执行|发布|推送)/, /自行决定[^\n]{0,8}不可逆/]) {
    assert.doesNotMatch(text, pattern, `policy 出现「不问用户直接干」的授权口径：${pattern}`)
  }
})
