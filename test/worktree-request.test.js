// P9 worktree 结构化声明：纯映射 + 文案（零自然语言解析）。
// 本文件只测纯函数：不跑 git、不碰文件系统（物理事实由 worktree.test.js 的 fake exec 覆盖）。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BRANCH_REQUIRED_HINT, BRANCH_TYPES, CLEANUP_HINT, DEGRADE_HINT, IMPLICIT_HINT, OFF_BUILD_HINT,
  REQUIRED_SKIP_HINT, WORKTREE_STATES, askBranchHint, branchChoiceText, branchNameProblem,
  decideWorktreeFacts, decideWorktreeIntent, findReusableCheckout, isWorktreeTask, notifyWorktreeOf,
  parseWorktreeRequest, requestOfTask, reusableCheckoutCandidates, worktreeDetailLines, worktreeListMarker,
  worktreeNoteLines, worktreeNotifyLine, worktreeStatusLine,
} from '../src/worktree-request.js'
import { loadConfig } from '../src/config.js'

// —— 一、结构化参数：只认布尔/合法枚举，绝不「理解」字符串 ——

test('P9 结构化请求：worktree 只认布尔值，字符串 true / auto 都拒绝', () => {
  assert.deepEqual(parseWorktreeRequest({ worktree: true }).request.worktree, true)
  assert.deepEqual(parseWorktreeRequest({ worktree: false }).request.worktree, false)
  assert.equal(parseWorktreeRequest({ worktree: undefined }).request.worktree, undefined)
  for (const bad of ['true', 'auto', 1, {}]) {
    const parsed = parseWorktreeRequest({ worktree: bad })
    assert.equal(parsed.ok, false, `${JSON.stringify(bad)} 应被拒绝`)
    assert.match(parsed.error, /布尔值/)
    assert.match(parsed.error, /auto/)
  }
})

test('P9 结构化请求：worktreeMode / worktreeCleanup 枚举校验，worktreeBranch 走约定式命名', () => {
  assert.equal(parseWorktreeRequest({ worktreeMode: 'group' }).ok, false)
  assert.equal(parseWorktreeRequest({ worktreeCleanup: 'always' }).ok, false)
  assert.equal(parseWorktreeRequest({ worktreeMode: 'continue' }).request.mode, 'continue')
  assert.equal(parseWorktreeRequest({ worktreeCleanup: 'checkout-only' }).request.cleanup, 'checkout-only')
  // 非法分支名在创建期就拒绝（插件不猜名字、不改名），错误里带白名单与正例。
  const bad = parseWorktreeRequest({ worktree: true, worktreeBranch: 'feat/bad name' })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /不合法/)
  assert.match(bad.error, /白名单/)
  assert.match(bad.error, /fix\/mirror-poll-cache/)
  assert.equal(parseWorktreeRequest({ worktree: true, worktreeBranch: 'feat/x' }).ok, true)
  // 旧默认 orch/<taskId> 不再接受（反例也写进错误文案）。
  const legacy = parseWorktreeRequest({ worktree: true, worktreeBranch: 'orch/t-1a2b3c4d' })
  assert.equal(legacy.ok, false)
  assert.match(legacy.error, /orch\/<taskId>/)
  // 非字符串明确拒绝。
  assert.equal(parseWorktreeRequest({ worktree: true, worktreeBranch: 42 }).ok, false)
})

test('P9 结构化请求：只给了 worktree 相关字段也算要隔离（防漏传吃掉意图）', () => {
  const parsed = parseWorktreeRequest({ worktreeBase: 'release/1.0' })
  assert.equal(parsed.request.implicit, true)
  // 只说了基线、没说名字 → 仍算「要隔离」，但名字必填：拒绝而不是悄悄用 orch/<taskId>。
  const missing = decideWorktreeIntent({ request: parsed.request, policy: 'auto' })
  assert.equal(missing.action, 'reject')
  assert.equal(missing.code, 'BRANCH_REQUIRED')
  const intent = decideWorktreeIntent({
    request: parseWorktreeRequest({ worktreeBase: 'release/1.0', worktreeBranch: 'docs/release-notes' }).request,
    policy: 'auto',
  })
  assert.equal(intent.action, 'resolve')
  assert.equal(intent.source, 'task')
  assert.equal(intent.hint, IMPLICIT_HINT)
})

// —— 二、机械映射（§4.5）：none / resolve / reuse / reject ——

test('P9 机械映射 #1：不传 + auto → 不隔离，来源 default，零提示', () => {
  const intent = decideWorktreeIntent({ request: parseWorktreeRequest({}).request, policy: 'auto' })
  assert.equal(intent.action, 'none')
  assert.equal(intent.source, 'default')
  assert.equal(intent.hint, '')
})

test('P9 机械映射 #2：不传 + required → 拒绝并要名字（配置只决定要不要隔离，不包办名字）', () => {
  const intent = decideWorktreeIntent({ request: parseWorktreeRequest({}).request, policy: 'required' })
  assert.equal(intent.action, 'reject')
  assert.equal(intent.code, 'BRANCH_REQUIRED')
  assert.equal(intent.source, 'config')
  assert.equal(intent.error, BRANCH_REQUIRED_HINT)
  assert.match(intent.error, /worktreeBranch 必填/)
  assert.match(intent.error, /feat \| fix \| docs/)
})

test('P9 机械映射 #3/#4：配置与协调者决定冲突只给 hint，不拦截', () => {
  const skip = decideWorktreeIntent({ request: parseWorktreeRequest({ worktree: false }).request, policy: 'required' })
  assert.equal(skip.action, 'none')
  assert.equal(skip.hint, REQUIRED_SKIP_HINT)
  const build = decideWorktreeIntent({ request: parseWorktreeRequest({ worktree: true, worktreeBranch: 'feat/x' }).request, policy: 'off' })
  assert.equal(build.action, 'resolve')
  assert.equal(build.hint, OFF_BUILD_HINT)
})

test('P9 机械映射 #6/#7：worktree 与 readOnly / planFirst 创建期互斥', () => {
  const readOnly = decideWorktreeIntent({ request: parseWorktreeRequest({ worktree: true }).request, policy: 'auto', readOnly: true })
  assert.equal(readOnly.action, 'reject')
  assert.equal(readOnly.code, 'READONLY_CONFLICT')
  assert.match(readOnly.error, /readOnly/)
  const planned = decideWorktreeIntent({ request: parseWorktreeRequest({ worktree: true }).request, policy: 'auto', planFirst: true })
  assert.equal(planned.action, 'reject')
  assert.equal(planned.code, 'PLAN_CONFLICT')
  assert.match(planned.error, /批准后/)
})

test('P9 机械映射 #8/#9：continue 有检出就复用，没有就拒绝并给出口', () => {
  const request = parseWorktreeRequest({ worktreeMode: 'continue' }).request
  const reuse = decideWorktreeIntent({
    request, policy: 'auto',
    existingCheckout: { taskId: 't-1', path: 'C:/repo/.agents/worktrees/t-1', branch: 'orch/t-1' },
  })
  assert.equal(reuse.action, 'reuse')
  assert.equal(reuse.path, 'C:/repo/.agents/worktrees/t-1')
  assert.match(reuse.hint, /复用已有检出/)
  // 必填只针对「新建」：continue 不传 worktreeBranch 照样复用（request 里就没带 branch）。
  assert.equal(request.worktreeBranch, undefined)
  const none = decideWorktreeIntent({ request, policy: 'auto' })
  assert.equal(none.action, 'reject')
  assert.equal(none.code, 'NO_CHECKOUT')
  assert.match(none.error, /worktreeMode="new"/)
})

test('P9 复用检出查找：同 group 或 dependsOn 链上已建好的检出', () => {
  const tasks = [
    { id: 't-1', group_id: 'g1', worktree_path: 'C:/w/t-1', worktree_branch: 'orch/t-1', worktree_state: 'created' },
    { id: 't-2', group_id: 'g1', worktree_path: 'C:/w/t-2', worktree_branch: 'orch/t-2', worktree_state: 'reused' },
    { id: 't-3', group_id: 'g2', worktree_path: 'C:/w/t-3', worktree_branch: 'orch/t-3', worktree_state: 'cleaned' },
    { id: 't-4', group_id: null, worktree_path: null, worktree_branch: null, worktree_state: 'none' },
  ]
  assert.equal(findReusableCheckout({ tasks, groupId: 'g9' }), undefined)
  assert.deepEqual(findReusableCheckout({ tasks, groupId: 'g1' })?.path, 'C:/w/t-1')
  assert.deepEqual(findReusableCheckout({ tasks, dependsOn: ['t-2'] })?.path, 'C:/w/t-2')
  // cleaned / none 的不能复用。
  assert.equal(findReusableCheckout({ tasks, groupId: 'g2' }), undefined)
})

test('P0-2 候选检出：dependsOn 链优先、同 group 次之、按 id 去重（拿全量候选去过滤占用）', () => {
  const tasks = [
    { id: 't-1', group_id: 'g1', worktree_path: 'C:/w/t-1', worktree_branch: 'orch/t-1', worktree_state: 'created' },
    { id: 't-2', group_id: 'g1', worktree_path: 'C:/w/t-2', worktree_branch: 'orch/t-2', worktree_state: 'reused' },
    { id: 't-3', group_id: 'g1', worktree_path: 'C:/w/t-3', worktree_branch: 'orch/t-3', worktree_state: 'cleaned' },
  ]
  // 既在 dependsOn 又在同 group：只出现一次，且排在前面。
  assert.deepEqual(
    reusableCheckoutCandidates({ tasks, groupId: 'g1', dependsOn: ['t-2'] }).map(task => task.id),
    ['t-2', 't-1'],
  )
  assert.deepEqual(reusableCheckoutCandidates({ tasks, groupId: 'g9' }), [])
  // 无 group / 无 dependsOn：没有候选（不会拿全台账任意检出乱复用）。
  assert.deepEqual(reusableCheckoutCandidates({ tasks }), [])
})

// —— 三、物理事实分档（n=0 / 1 / ≥2 / 基线不存在 / 非仓库） ——

const repoFacts = overrides => ({
  isRepo: true, repoRoot: 'C:/repo', defaultBranch: 'main',
  recentBranches: [], n: 0, suggestedBase: 'main', needsBranchChoice: false, ...overrides,
})

test('P9 事实分档：n=0 用默认分支，n=1 直接用那条，n≥2 返回 ask（任务不落库）', () => {
  const intent = decideWorktreeIntent({ request: parseWorktreeRequest({ worktree: true, worktreeBranch: 'feat/x' }).request, policy: 'auto' })
  const zero = decideWorktreeFacts({ intent, facts: repoFacts({}) })
  assert.equal(zero.action, 'create')
  assert.equal(zero.base, 'main')

  const one = decideWorktreeFacts({
    intent,
    facts: repoFacts({ n: 1, recentBranches: [{ name: 'feat/a' }], suggestedBase: 'feat/a' }),
  })
  assert.equal(one.action, 'create')
  assert.equal(one.base, 'feat/a')

  const many = decideWorktreeFacts({
    intent,
    facts: repoFacts({
      n: 3,
      recentBranches: [{ name: 'feat/a' }, { name: 'feat/b' }, { name: 'main' }],
      suggestedBase: undefined,
      needsBranchChoice: true,
    }),
    recentDays: 7,
  })
  assert.equal(many.action, 'ask')
  assert.deepEqual(many.candidates, ['feat/a', 'feat/b', 'main'])
  assert.equal(many.n, 3)
  assert.equal(many.hint, askBranchHint(7))
})

test('P9 事实分档：非 git 仓库降级、基线不存在拒绝、显式基线直接用', () => {
  const intent = decideWorktreeIntent({ request: parseWorktreeRequest({ worktree: true, worktreeBranch: 'feat/x' }).request, policy: 'auto' })
  const degraded = decideWorktreeFacts({ intent, facts: { isRepo: false, reason: 'NOT_A_REPO' } })
  assert.equal(degraded.action, 'degrade')
  assert.equal(degraded.hint, DEGRADE_HINT)

  const explicit = decideWorktreeIntent({ request: parseWorktreeRequest({ worktree: true, worktreeBranch: 'fix/x', worktreeBase: 'release' }).request, policy: 'auto' })
  const missing = decideWorktreeFacts({ intent: explicit, facts: repoFacts({ recentBranches: [{ name: 'main' }] }), baseExists: false })
  assert.equal(missing.action, 'reject')
  assert.equal(missing.code, 'BASE_NOT_FOUND')
  assert.match(missing.error, /release/)
  const ok = decideWorktreeFacts({ intent: explicit, facts: repoFacts({}), baseExists: true })
  assert.equal(ok.action, 'create')
  assert.equal(ok.base, 'release')
})

test('P9 分支名校验：<type>/<slug>，11 个 type 白名单 + kebab ASCII slug + 长度上限', () => {
  // 11 个类型各一个正例（白名单只有一个真源）。
  assert.equal(BRANCH_TYPES.length, 11)
  for (const type of BRANCH_TYPES) assert.equal(branchNameProblem(`${type}/x`), '', `${type}/x 应合法`)
  assert.equal(branchNameProblem('fix/mirror-poll-cache'), '')
  assert.equal(branchNameProblem('feat/login-retry-2'), '')
  // 反例：旧默认 / 大写 type / 非白名单 type / 空格 / 下划线 / 首尾与连续连字符 / 空 slug / 缺 type / 长度
  const cases = [
    ['orch/t-1a2b3c4d', /白名单/],
    ['Feat/x', /白名单/],
    ['feature/x', /白名单/],
    ['feat/Login Retry', /空格/],
    ['feat/x_y', /slug/],
    ['feat/-x', /slug/],
    ['feat/x-', /slug/],
    ['feat/x--y', /slug/],
    ['feat/', /不能以 \/ 或 \. 结尾/],
    ['feat', /type/],
    [`feat/${'a'.repeat(41)}`, /40/],
    ['feat/x.lock', /lock/],
    ['', /空/],
  ]
  for (const [name, pattern] of cases) assert.match(branchNameProblem(name), pattern, `${JSON.stringify(name)} 应被拒绝`)
  assert.equal(branchNameProblem('feat/' + 'a'.repeat(40)), '', 'slug 40 字符正好合法')
  assert.equal(branchNameProblem(42), '必须是字符串')
  // 缺名字不是「格式错」，而是「必填」：要留到 decideWorktreeIntent 统一拒绝（continue 复用不需要名字）。
  assert.equal(parseWorktreeRequest({ worktree: true }).request.worktreeBranch, undefined)
  const missing = decideWorktreeIntent({ request: parseWorktreeRequest({ worktree: true }).request, policy: 'auto' })
  assert.equal(missing.action, 'reject')
  assert.equal(missing.code, 'BRANCH_REQUIRED')
  assert.match(missing.error, /正例：worktreeBranch: "fix\/mirror-poll-cache"/)
})

// —— 四、视图 / 文案：普通任务零字样，隔离任务说清「产物不在你工作树」 ——

test('P9 视图：状态行区分 created/reused/degraded/failed/requested，普通任务没有隔离行', () => {
  assert.deepEqual(WORKTREE_STATES, ['none', 'requested', 'created', 'reused', 'degraded', 'rejected', 'failed', 'cleaned'])
  const created = worktreeStatusLine({
    worktree_state: 'created', worktree_branch: 'orch/t-1', worktree_path: 'C:/repo/.agents/worktrees/t-1',
    worktree_base: 'main', worktree_source: 'task',
  })
  assert.match(created, /隔离：已隔离/)
  assert.match(created, /分支 orch\/t-1/)
  assert.match(created, /检出 C:\/repo/)
  assert.match(created, /决定 协调者传字段/)
  assert.match(created, /合并由你决定/)
  assert.match(worktreeStatusLine({ worktree_state: 'degraded', worktree_source: 'task' }), /降级/)
  assert.match(worktreeStatusLine({ worktree_state: 'failed', worktree_source: 'config', error: 'GIT_MISSING' }), /GIT_MISSING/)
  assert.match(worktreeStatusLine({ worktree_state: 'requested', worktree_source: 'config', worktree_base: 'main' }), /待建检出/)
  assert.equal(worktreeStatusLine({ worktree_state: 'none' }), undefined)
  assert.equal(worktreeStatusLine({}), undefined)
})

test('P9 视图：任务卡小标只给真的隔离任务；普通任务没有 worktree 通知块', () => {
  assert.equal(worktreeListMarker({ worktree_state: 'created' }), '·隔离')
  assert.equal(worktreeListMarker({ worktree_state: 'none' }), '')
  assert.equal(worktreeListMarker({}), '')
  assert.equal(notifyWorktreeOf({ worktree_state: 'none' }), undefined)
  assert.deepEqual(notifyWorktreeOf({ worktree_state: 'created', worktree_branch: 'b', worktree_path: 'p' }), {
    state: 'created', branch: 'b', path: 'p', error: null,
  })
  assert.match(worktreeNotifyLine({ worktree: { state: 'created', branch: 'orch/t-1', path: 'C:/w' } }), /合并到你当前分支由你决定/)
  assert.match(worktreeNotifyLine({ worktree: { state: 'degraded' } }), /已降级/)
  assert.equal(worktreeNotifyLine({ worktree: { state: 'none' } }), '')
  assert.equal(worktreeNotifyLine({}), '')
})

test('P9 文案：task_create 说明、多分支询问、task_detail 都给正确的下一步', () => {
  assert.match(worktreeNoteLines({ state: 'created', branch: 'orch/t-1', path: 'C:/w', base: 'main' })[0], /合并到你的工作树由你\/用户决定/)
  assert.match(worktreeNoteLines({ state: 'degraded' })[0], /不会|降级/)
  assert.match(worktreeNoteLines({ state: 'failed', error: 'PATH_EXISTS' })[0], /PATH_EXISTS/)
  assert.deepEqual(worktreeNoteLines({ state: 'none' }), [])
  const ask = branchChoiceText({
    decision: { candidates: ['feat/a', 'feat/b'], defaultBranch: 'main', n: 2 },
    title: '需求 A',
    days: 7,
  })
  assert.match(ask, /feat\/a/)
  assert.match(ask, /默认分支 main/)
  assert.match(ask, /未创建任务/)
  assert.match(ask, /worktreeBase/)
  const detail = worktreeDetailLines({ worktree_state: 'created', worktree_path: 'C:/w', worktree_branch: 'orch/t-1', worktree_base: 'main' })
  assert.match(detail[0], /【worktree 隔离】/)
  assert.match(detail[1], /不要切分支/)
  assert.deepEqual(worktreeDetailLines({ worktree_state: 'none' }), [])
  assert.equal(isWorktreeTask({ worktree_state: 'degraded' }), true)
  assert.equal(isWorktreeTask({ worktree_state: 'none' }), false)
  assert.equal(isWorktreeTask({ worktree_state: 'rejected' }), false)
})

test('P9 文案：清理档位说明写清三档行为', () => {
  assert.match(CLEANUP_HINT, /off/)
  assert.match(CLEANUP_HINT, /checkout-only/)
  assert.match(CLEANUP_HINT, /full/)
})

test('P9 台账请求快照：重派能还原 mode/cleanup/base/branch', () => {
  const request = requestOfTask({
    worktree_state: 'created', worktree_base: 'main', worktree_branch: 'orch/t-9',
    worktree_mode: 'new', brief: { worktreeCleanup: 'checkout-only' },
  })
  assert.equal(request.worktree, true)
  assert.equal(request.worktreeBase, 'main')
  assert.equal(request.worktreeBranch, 'orch/t-9')
  assert.equal(request.cleanup, 'checkout-only')
})

// —— 五、配置：结构化默认值渲染进协调者 policy（不是解析用户文档） ——

test('P9 配置：worktreePolicy 默认 auto，非法值回落；分支前缀键已删除、窗口归一', () => {
  const config = loadConfig({})
  assert.equal(config.worktreePolicy, 'auto')
  assert.equal(config.worktreeRecentDays, 7)
  assert.equal(loadConfig({ worktreePolicy: 'required' }).worktreePolicy, 'required')
  assert.equal(loadConfig({ worktreePolicy: 'always' }).worktreePolicy, 'auto')
  // 0.35.0：worktreeBranchPrefix 删除（分支名归 task_create.worktreeBranch），旧值不回填。
  assert.equal('worktreeBranchPrefix' in config, false)
  assert.equal('worktreeBranchPrefix' in loadConfig({ worktreeBranchPrefix: 'feat/' }), false)
  assert.equal(loadConfig({ worktreeRecentDays: 0 }).worktreeRecentDays, 1)
  assert.equal(loadConfig({ worktreeRecentDays: 400 }).worktreeRecentDays, 90)
  assert.equal(loadConfig({ worktreeRecentDays: 'x' }).worktreeRecentDays, 7)
})

test('P9 协调者 policy：结构化渲染当前策略 + 判断流程 + 分支命名必填 + 合并责任', async () => {
  const { renderCoordinatorPolicy, renderWorktreePolicy } = await import('../index.js')
  const text = renderWorktreePolicy({ worktreePolicy: 'required', worktreeRecentDays: 14 })
  assert.match(text, /当前配置策略：required/)
  assert.match(text, /分支命名：<type>\/<slug>（必填，由你传）/)
  assert.match(text, /最近活跃窗口：14 天/)
  assert.match(text, /required：每个需求都用 task_create/)
  assert.match(text, /required 只决定「默认要隔离」，不包办分支名/)
  assert.match(text, /不传或不规范当场报错/)
  assert.match(text, /不再有默认 orch\/<taskId>/)
  assert.match(text, /feat \| fix \| docs \| refactor \| chore \| test \| perf \| build \| ci \| style \| revert/)
  assert.match(text, /auto：默认不隔离/)
  assert.match(text, /off：一律不隔离/)
  // 三条件引导 + 协调者判断 + 插件只执行。
  assert.match(text, /git 仓库 ∧ 同一需求有任务执行 ∧ 本次新需求/)
  assert.match(text, /ask_user_question/)
  assert.match(text, /needsBranchChoice/)
  assert.match(text, /合并由用户决定/)
  // 反向验证（v2 硬约束）：不解析 AGENTS.md、不跑 git。
  assert.match(text, /不要问「怎么解析文件」/)
  assert.match(text, /不要自己跑 git/)
  const full = renderCoordinatorPolicy({})
  assert.match(full, /你是 dsh-orchestrator 的协调者/)
  assert.match(full, /当前配置策略：auto/)
})
