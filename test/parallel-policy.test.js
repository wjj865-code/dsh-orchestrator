// 并行策略（t-c8adaeb1）：worktree / 写域 / 任务链三段各自都对，但缺一句「没依赖就别排队」。
//
// 用户原话：「协调者提示词现在有冲突就创建 worktree，尽量提高并行（如果不依赖、无需复用上下文的话）
// 的提示吗？没有就加上」。C2-3b 起 L1 只渲染**一句判据**（`PARALLEL_CRITERIA`）+ 技能指针，
// 展开细则下沉到 `skills/orch-parallel/SKILL.md`。这组用例锁四件事：
//   1. L1 段 = 标题 + 判据一句 + `skill({ name: 'orch-parallel' })` 指针，判据单源在 copy.js；
//   2. 判据本体：三条同时满足（互不依赖 / 不复用上下文 / 同写域撞车）就直接 worktree:true 并行；
//   3. 展开细则（串行的两种例外、合并与装依赖代价、只读与计划例外、同检出串行）都在技能文件里，
//      既没丢，也不许再回涨到 L1；
//   4. 归层：并行策略属 L1，brief / task_detail 不复述；派发、队列、写域判定等行为逻辑一行未动。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { renderCoordinatorPolicy, renderWorktreePolicy, renderWriteGuardPolicy } from '../index.js'
import { PARALLEL_CRITERIA, PARALLEL_LINES } from '../src/copy.js'
import { PROMPT_LAYERS, layerViolations, renderParallelPolicy } from '../src/prompt-layers.js'
import { renderBrief } from '../src/brief.js'
import { renderTaskDetail } from '../src/task-detail.js'

const policy = () => renderCoordinatorPolicy({})
const section = () => renderParallelPolicy()

/** 完整展开版的六句：现在只在技能文件里逐字出现（L1 段已压成判据一句）。 */
const RULES = [
  PARALLEL_LINES.criteria,
  PARALLEL_LINES.prefer,
  PARALLEL_LINES.serial,
  PARALLEL_LINES.cost,
  PARALLEL_LINES.exceptions,
  PARALLEL_LINES.align,
]

/** 展开细则的落点：技能文件（L1 只留判据 + 指针，细节按需加载）。 */
const SKILL = readFileSync(new URL('../skills/orch-parallel/SKILL.md', import.meta.url), 'utf8')

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

test('判据一句齐全：三条满足就直接 worktree:true 并行 + 技能指针', () => {
  const block = section()
  // 改判据版（C2-3b）：段落 = 标题 + 一句判据（逐字来自 copy.js 的 PARALLEL_CRITERIA）。
  assert.ok(block.includes(PARALLEL_CRITERIA), '并行策略段缺少判据句')
  assert.ok(policy().includes(PARALLEL_CRITERIA), 'L1 policy 缺少判据句')
  assert.match(block, /^## 并行策略（互不依赖、无需复用上下文时优先 worktree 隔离并行）\n\n并行判据：/)
  // 验收要求的关键词都得在（不是同义词替换后的另一套说法）。
  for (const fragment of ['worktree:true', '并行', '互不依赖', '复用同一子会话上下文', '同写域']) {
    assert.ok(block.includes(fragment), `并行策略段缺少关键词：${fragment}`)
    assert.ok(policy().includes(fragment), `L1 policy 缺少关键词：${fragment}`)
  }
  // 技能指针：判据句自己带 skill({ name: 'orch-parallel' })，加载入口必须能对上真实技能目录。
  assert.match(block, /详见 skill\(\{ name: 'orch-parallel' \}\)/)
  assert.ok(readdirSync(new URL('../skills/', import.meta.url)).includes('orch-parallel'), '技能指针指向的技能目录必须存在')
  // 反回涨：展开版的六句细则不许再回到 L1（细则只在技能文件里）。
  for (const line of RULES) {
    assert.equal(block.includes(line), false, `L1 段不该再摊开细则句：${line.slice(0, 24)}…`)
  }
})

test('判断标准三条同时满足才并行：判据句一句话讲完三条（不再展开 ①②③）', () => {
  const text = section()
  assert.match(text, /三条同时满足/)
  assert.match(text, /互不依赖、不复用同一子会话上下文、同写域会撞车三条同时满足/)
  // 原断言锁 ①②③ 的展开文本；改判据版后这些展开细节归技能文件，L1 只留一句，
  // 这里改成「不许回涨」的反向断言 + 技能文件里仍有完整三条。
  assert.doesNotMatch(text, /① \*\*互不依赖\*\*/)
  assert.match(SKILL, /① \*\*互不依赖\*\*——B 的输入不是 A 的产物/)
  assert.match(SKILL, /② \*\*不需要复用同一子会话上下文\*\*——不是追问、续写/)
  assert.match(SKILL, /③ \*\*同一写域会撞车\*\*——target 相同\/互相包含，或 writeScopes 重叠/)
  // 不撞车就不必建检出（别为了并行而并行）。
  assert.match(SKILL, /不撞车就直接并行，不用建检出/)
})

test('优先并行而不是排队：判据直指 worktree:true 并行，展开理由在技能文件', () => {
  const text = section()
  assert.match(text, /就直接 worktree:true 并行/)
  assert.match(text, /详见 skill\(\{ name: 'orch-parallel' \}\)/)
  // 原断言锁「优先并行」与三条反向口径的正文；现在它们归技能文件（同一份措辞，不各写一套）。
  assert.match(SKILL, /优先并行：三条都满足时，新任务\*\*直接传 `worktree: true`\*\* 在独立检出里并行跑/)
  assert.match(SKILL, /不要为了省事把两个互不依赖的任务串成 dependsOn 链/)
  assert.match(SKILL, /也不要在同写域被拒时默认「先关旧任务、再重派」/)
  assert.match(SKILL, /串行是\*\*有依赖\*\*时的解法，不是默认姿势/)
  // policy 里不再暗示「默认先串行」。
  for (const pattern of [/默认(?:先)?串行/, /默认排成(?:一条)?链/, /先串行再考虑并行/]) {
    assert.doesNotMatch(policy(), pattern, `policy 仍暗示默认串行：${pattern}`)
  }
})

test('串行只有两种情况：细则在技能文件，L1 段不再摊开', () => {
  const text = section()
  assert.match(SKILL, /只有这两种情况才串行/)
  assert.match(SKILL, /① \*\*有依赖\*\*（B 要用 A 的产物 → 建 dependsOn，见 orch-task-chain 技能）/)
  assert.match(SKILL, /② \*\*要复用同一子会话上下文\*\*（续写\/追问同一份活 → `task_message` 追问原会话/)
  assert.match(SKILL, /复用同一检出 → `worktreeMode: "continue"` 并串行/)
  // 反回涨：串行的两种例外不进 L1（L1 只判「三条满足就并行」，例外按需加载技能）。
  assert.doesNotMatch(text, /只有这两种情况才串行/)
})

test('代价与例外写清：合并由用户决定 / 检出要先装依赖 / 只读与计划不必隔离 / 同一检出必须串行', () => {
  // 改判据版：这四类细则从 L1 段移到技能文件（原来逐条断言 section()，现在逐条断言 SKILL）。
  assert.match(SKILL, /产物在各自分支的检出里，\*\*合并由用户决定\*\*/)
  assert.match(SKILL, /并行越多合并面越大/)
  assert.match(SKILL, /每个检出都是空目录，子会话要先装依赖/)
  assert.match(SKILL, /pnpm install/)
  assert.match(SKILL, /只装不升/)
  assert.match(SKILL, /并发 `git commit` 会争 `\.git` 锁/)
  assert.match(SKILL, /例外（不必隔离）：\*\*只读任务\*\*（`readOnly: true`）与\*\*计划阶段\*\*（`planFirst: true` 批准前）不改文件/)
  assert.match(SKILL, /同目录并行也不冲突，直接派/)
  assert.match(SKILL, /同一 worktree 检出永远只能一个任务在写/)
  assert.match(SKILL, /必须 dependsOn 串行/)
  // 反回涨：代价/例外不进每回合都在的 L1（否则又变回六条 bullet）。
  assert.doesNotMatch(section(), /pnpm install/)
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

  // ③ 任务链段：L1 已压成判据一句，同检出不并发/各建检出并行的细则下沉到 orch-task-chain 技能，
  //    技能里仍指向 orch-parallel（两段口径互指，不互相推翻）。
  const text = policy()
  const chainSkill = readFileSync(new URL('../skills/orch-task-chain/SKILL.md', import.meta.url), 'utf8')
  assert.match(chainSkill, /同一 worktree 检出必须用 dependsOn 串行/)
  assert.match(chainSkill, /各建一个检出（worktree:true）\*\*并行\*\*（互不依赖、无需复用上下文时首选，见 orch-parallel 技能）/)
  assert.doesNotMatch(text, /同一 worktree 检出必须用 dependsOn 串行/, 'L1 任务链段不该再摊开同检出串行细则')

  // ④ 硬规则一条没变：计划批准 / 两段式交付 / 同写域判定。
  assert.match(text, /计划批准必须由用户拍板/)
  assert.match(text, /不是终态/)
  assert.match(text, /sameDirGuard=require/)
  // 任务链失败传播的执行层语义没动，但它的文案已随展开版下沉（L1 只留判据一句）：
  // 原来断言 L1 policy 里有这句，现在断言技能文件 + dependsOn 工具描述里仍有（口径没丢）。
  assert.equal(text.includes('前置失败 → 下游自动 failed'), false, 'L1 段不再摊开失败传播细则')
  assert.match(chainSkill, /前置失败 → 下游自动 failed/)
  // 硬规则 bullet 也带上并行指引（派单那一刻手边就看得到）。
  // C2-3b：原断言锁的是任务链展开句里的「互不依赖、无需复用上下文时首选」，该句已随展开版下沉；
  // 硬规则侧真正手边可见的并行指引在 worktree 决策 bullet 与写域出路里（index.js），这里改锁它们。
  assert.match(text, /并行优先/)
  assert.match(worktree, /优先传 worktree:true 隔离并行/)
})

test('归层：并行策略属 L1，brief / task_detail 不复述', () => {
  const text = policy()
  assert.deepEqual(layerViolations('L1', text), [])
  const l1 = PROMPT_LAYERS.find(layer => layer.id === 'L1')
  assert.ok(l1.owns.some(item => item.includes('并行策略')), 'L1 owns 应登记并行策略')
  assert.ok(l1.owns.some(item => item.includes('PARALLEL_CRITERIA')), 'L1 owns 应写明措辞源（判据常量）')
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
