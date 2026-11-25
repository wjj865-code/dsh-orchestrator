// 并行策略（t-c8adaeb1）：worktree / 写域 / 任务链三段各自都对，但缺一句「没依赖就别排队」。
//
// 用户原话：「协调者提示词现在有冲突就创建 worktree，尽量提高并行（如果不依赖、无需复用上下文的话）
// 的提示吗？没有就加上」。这组用例锁四件事：
//   1. 句子单源在 `src/copy.js` 的 `PARALLEL_LINES`，L1 段逐字渲染；
//   2. 规则本体：三条判断标准同时满足才并行、优先 worktree 而不是排 dependsOn 链、只有依赖或复用上下文才串行、
//      代价（合并/装依赖）与例外（只读与计划不必隔离、同一检出必须串行）；
//   3. 与既有三段（worktree 隔离 / 同写域并发防护 / 任务链）口径对齐，policy 里不再暗示「默认先串行」；
//   4. 归层：并行策略属 L1，brief / task_detail 不复述；派发、队列、写域判定等行为逻辑一行未动。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { renderCoordinatorPolicy, renderWorktreePolicy, renderWriteGuardPolicy } from '../index.js'
import { PARALLEL_LINES } from '../src/copy.js'
import { PROMPT_LAYERS, layerViolations, renderParallelPolicy } from '../src/prompt-layers.js'
import { renderBrief } from '../src/brief.js'
import { renderTaskDetail } from '../src/task-detail.js'

const policy = () => renderCoordinatorPolicy({})
const section = () => renderParallelPolicy()

/** 六句规则（渲染与 L1 policy 都必须逐字包含）。 */
const RULES = [
  PARALLEL_LINES.criteria,
  PARALLEL_LINES.prefer,
  PARALLEL_LINES.serial,
  PARALLEL_LINES.cost,
  PARALLEL_LINES.exceptions,
  PARALLEL_LINES.align,
]

test('并行策略是 L1 的独立一段：排在任务链之后、worktree 与写域之前', () => {
  const text = policy()
  const parallel = text.indexOf('## 并行策略')
  assert.ok(parallel > 0, 'L1 缺少并行策略段')
  // 有依赖才建链、无依赖就并行：这一对判断必须紧挨着（先读任务链，再读并行）。
  assert.ok(parallel > text.indexOf('## 任务链（dependsOn：依赖完成自动开始，不占你的回合）'), '并行策略应在任务链之后')
  // 什么时候并行先判完，再读怎么建检出/写域怎么判。
  assert.ok(parallel < text.indexOf('## worktree 隔离'), '并行策略应在 worktree 段之前')
  assert.ok(parallel < text.indexOf('## 同写域并发防护'), '并行策略应在写域段之前')
  assert.match(text, /## 并行策略（互不依赖、无需复用上下文时优先 worktree 隔离并行）/)
})

test('关键句齐全：worktree / 并行 / 互不依赖 / 无需复用上下文', () => {
  const block = section()
  // 验收要求的关键词都得在（不是同义词替换后的另一套说法）。
  for (const fragment of ['worktree: true', '并行', '互不依赖', '无需复用上下文', 'dependsOn']) {
    assert.ok(block.includes(fragment), `并行策略段缺少关键词：${fragment}`)
    assert.ok(policy().includes(fragment), `L1 policy 缺少关键词：${fragment}`)
  }
  // 六句逐字来自 copy.js（改一处两处一起变，不许各写一套）。
  for (const line of RULES) assert.ok(block.includes(line), `并行策略段缺少句子：${line.slice(0, 24)}…`)
  for (const line of RULES) assert.ok(policy().includes(line), `L1 policy 缺少句子：${line.slice(0, 24)}…`)
})

test('判断标准三条同时满足才并行：互不依赖 / 无需复用上下文 / 同写域撞车', () => {
  const text = section()
  assert.match(text, /三条同时满足才并行/)
  assert.match(text, /① \*\*互不依赖\*\*——B 的输入不是 A 的产物/)
  assert.match(text, /② \*\*不需要复用同一子会话上下文\*\*——不是追问、续写/)
  assert.match(text, /③ \*\*同一写域会撞车\*\*——target 相同\/互相包含，或 writeScopes 重叠/)
  // 不撞车就不必建检出（别为了并行而并行）。
  assert.match(text, /不撞车就直接并行，不用建检出/)
})

test('优先并行而不是排队：worktree 隔离并行 > 串成 dependsOn 链', () => {
  const text = section()
  assert.match(text, /优先并行：三条都满足时，新任务\*\*直接传 `worktree: true`\*\* 在独立检出里并行跑/)
  // 三条反向口径：不许把无依赖任务串成链、不许把「关旧任务重派」当默认、串行不是默认姿势。
  assert.match(text, /不要为了省事把两个互不依赖的任务串成 dependsOn 链/)
  assert.match(text, /也不要在同写域被拒时默认「先关旧任务、再重派」/)
  assert.match(text, /串行是\*\*有依赖\*\*时的解法，不是默认姿势/)
  // policy 里不再暗示「默认先串行」。
  for (const pattern of [/默认(?:先)?串行/, /默认排成(?:一条)?链/, /先串行再考虑并行/]) {
    assert.doesNotMatch(policy(), pattern, `policy 仍暗示默认串行：${pattern}`)
  }
})

test('串行只有两种情况：有依赖（dependsOn）或复用同一子会话上下文/同一检出', () => {
  const text = section()
  assert.match(text, /只有这两种情况才串行/)
  assert.match(text, /① \*\*有依赖\*\*（B 要用 A 的产物 → 建 dependsOn，见上「任务链」段）/)
  assert.match(text, /② \*\*要复用同一子会话上下文\*\*（续写\/追问同一份活 → `task_message` 追问原会话/)
  assert.match(text, /复用同一检出 → `worktreeMode: "continue"` 并串行/)
})

test('代价与例外写清：合并由用户决定 / 检出要先装依赖 / 只读与计划不必隔离 / 同一检出必须串行', () => {
  const text = section()
  // 代价两条：合并责任与检出装依赖（与 W1 的「只装不升」同口径）。
  assert.match(text, /产物在各自分支的检出里，\*\*合并由用户决定\*\*/)
  assert.match(text, /并行越多合并面越大/)
  assert.match(text, /每个检出都是空目录，子会话要先装依赖/)
  assert.match(text, /pnpm install/)
  assert.match(text, /只装不升/)
  assert.match(text, /并发 `git commit` 会争 `\.git` 锁/)
  // 例外：只读/计划（批准前）任务不必隔离；同一检出永远只能一个任务写（不推翻既有硬规则）。
  assert.match(text, /例外（不必隔离）：\*\*只读任务\*\*（`readOnly: true`）与\*\*计划阶段\*\*（`planFirst: true` 批准前）不改文件/)
  assert.match(text, /同目录并行也不冲突，直接派/)
  assert.match(text, /同一 worktree 检出永远只能一个任务在写/)
  assert.match(text, /必须 dependsOn 串行/)
})

test('与三段口径对齐：worktree 段推荐隔离并行、写域段并行优先、任务链段指向并行策略', () => {
  // ① worktree 隔离段：auto 档也要把「同写域 + 互不依赖 → 优先隔离并行」写进去。
  const worktree = renderWorktreePolicy({})
  assert.match(worktree, /同一写域要和另一个活跃任务并行/)
  assert.match(worktree, /优先传 worktree:true 隔离并行/)
  assert.match(worktree, /见上「并行策略」段/)
  // 「默认不隔离」是配置默认值，不等于「默认先串行」——两句话必须能同时成立。
  assert.match(worktree, /auto：默认不隔离/)
  assert.doesNotMatch(worktree, /默认(?:先)?串行/)

  // ② 同写域并发防护：被拒后先想到并行隔离，再才是关旧任务。
  const guard = renderWriteGuardPolicy({})
  const blocked = guard.indexOf('被拒时按顺序选一条')
  assert.ok(blocked > 0, '写域段缺少「被拒时按顺序选一条」')
  const parallelStep = guard.indexOf('两个任务互不依赖、也不需要复用同一子会话上下文', blocked)
  const serialStep = guard.indexOf('这个目录确实只该有一个任务在写', blocked)
  const forceStep = guard.indexOf('用户明确要求并发写同一目录', blocked)
  assert.ok(parallelStep > blocked, '写域段的出路缺少「优先隔离并行」一条')
  assert.ok(parallelStep < serialStep, '隔离并行必须排在「关旧任务重派」之前')
  assert.ok(serialStep < forceStep, 'allowConcurrent 仍是最后一条出路')
  assert.match(guard.slice(parallelStep, serialStep), /首选/)

  // ③ 任务链段：同一检出不并发仍然成立，但互不依赖时直指并行策略。
  const text = policy()
  assert.match(text, /同一 worktree 检出必须用 dependsOn 串行/)
  assert.match(text, /各建一个检出（worktree:true）\*\*并行\*\*（互不依赖、无需复用上下文时首选，见下「并行策略」段）/)

  // ④ 硬规则一条没变：计划批准 / 两段式交付 / 同写域判定 / 任务链失败传播。
  assert.match(text, /计划批准必须由用户拍板/)
  assert.match(text, /不是终态/)
  assert.match(text, /sameDirGuard=require/)
  assert.match(text, /前置失败 → 下游自动 failed/)
  // 硬规则 bullet 也带上并行指引（派单那一刻手边就看得到）。
  assert.match(text, /互不依赖、无需复用上下文时首选/)
})

test('归层：并行策略属 L1，brief / task_detail 不复述', () => {
  const text = policy()
  assert.deepEqual(layerViolations('L1', text), [])
  const l1 = PROMPT_LAYERS.find(layer => layer.id === 'L1')
  assert.ok(l1.owns.some(item => item.includes('并行策略')), 'L1 owns 应登记并行策略')
  assert.ok(l1.owns.some(item => item.includes('PARALLEL_LINES')), 'L1 owns 应写明措辞源')
  // L2/L3 只给一次性参数与任务详情：并行/串行的判断归协调者。
  const brief = renderBrief({ taskId: 't-1a2b3c4d' })
  assert.equal(brief.includes('并行策略'), false, 'brief 不该复述并行策略')
  const detail = renderTaskDetail(
    { id: 't-1', title: '示例', status: 'running', brief: { title: '示例', goal: '目标', acceptance: ['验收'] } },
    {},
  )
  assert.equal(detail.includes('并行策略'), false, 'task_detail 不该复述并行策略')
  assert.equal(detail.includes(PARALLEL_LINES.heading), false, 'task_detail 不许内联并行策略段')
})

test('文案单源：并行策略的规则句只在 src/copy.js 定义一次', () => {
  const dir = new URL('../src/', import.meta.url)
  const files = readdirSync(dir).filter(file => file.endsWith('.js'))
    .map(file => [file, readFileSync(new URL(file, dir), 'utf8')])
  files.push(['index.js', readFileSync(new URL('../index.js', import.meta.url), 'utf8')])
  const filesWith = marker => files.filter(([, text]) => text.includes(marker)).map(([file]) => file)
  for (const marker of ['判断标准（三条同时满足才并行）', '串行是**有依赖**时的解法', '并行越多合并面越大']) {
    assert.deepEqual(filesWith(marker), ['copy.js'], `「${marker}」在其它模块又写了一份（应引用 src/copy.js）`)
  }
})

test('文档同口径：README / ARCHITECTURE / testing 都写了并行策略', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  const arch = readFileSync(new URL('../docs/ARCHITECTURE.md', import.meta.url), 'utf8')
  const testing = readFileSync(new URL('../docs/testing.md', import.meta.url), 'utf8')
  // README 给用户看「什么时候并行、什么时候串行、代价是什么」。
  assert.match(readme, /### 并行：没依赖就隔离并行，有依赖才排队/)
  for (const fragment of ['互不依赖', '并行', 'dependsOn', '合并由你决定', '只读']) {
    assert.ok(readme.includes(fragment), `README 并行一节缺少：${fragment}`)
  }
  // ARCHITECTURE 记实现口径与措辞源。
  assert.match(arch, /renderParallelPolicy/)
  assert.match(arch, /PARALLEL_LINES/)
  assert.match(arch, /并行策略/)
  // testing 的验证索引登记这组用例。
  assert.match(testing, /并行策略（t-c8adaeb1）/)
  assert.match(testing, /test\/parallel-policy\.test\.js/)
})
