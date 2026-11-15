// P9 worktree 结构化声明：纯映射 + 文案（零自然语言解析）。
// 本文件只测纯函数：不跑 git、不碰文件系统（物理事实由 worktree.test.js 的 fake exec 覆盖）。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CLEANUP_HINT, DEGRADE_HINT, IMPLICIT_HINT, OFF_BUILD_HINT, REQUIRED_FALLBACK_HINT, REQUIRED_SKIP_HINT,
  WORKTREE_STATES, askBranchHint, branchChoiceText, branchNameFor, decideWorktreeFacts, decideWorktreeIntent,
  findReusableCheckout, isWorktreeTask, notifyWorktreeOf, parseWorktreeRequest, requestOfTask,
  worktreeDetailLines, worktreeListMarker, worktreeNoteLines, worktreeNotifyLine, worktreeStatusLine,
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

test('P9 结构化请求：worktreeMode / worktreeCleanup 枚举校验，worktreeBranch 词法校验', () => {
  assert.equal(parseWorktreeRequest({ worktreeMode: 'group' }).ok, false)
  assert.equal(parseWorktreeRequest({ worktreeCleanup: 'always' }).ok, false)
  assert.equal(parseWorktreeRequest({ worktreeMode: 'continue' }).request.mode, 'continue')
  assert.equal(parseWorktreeRequest({ worktreeCleanup: 'checkout-only' }).request.cleanup, 'checkout-only')
  // 非法分支名在创建期就拒绝（插件不自动改名）。
  const bad = parseWorktreeRequest({ worktree: true, worktreeBranch: 'feat/bad name' })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /不合法/)
  assert.equal(parseWorktreeRequest({ worktree: true, worktreeBranch: 'feat/x' }).ok, true)
})

test('P9 结构化请求：只给了 worktree 相关字段也算要隔离（防漏传吃掉意图）', () => {
  const parsed = parseWorktreeRequest({ worktreeBase: 'release/1.0' })
  assert.equal(parsed.request.implicit, true)
  const intent = decideWorktreeIntent({ request: parsed.request, policy: 'auto' })
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

test('P9 机械映射 #2：不传 + required → 兜底建（来源 config + 明确提示）', () => {
  const intent = decideWorktreeIntent({ request: parseWorktreeRequest({}).request, policy: 'required' })
  assert.equal(intent.action, 'resolve')
  assert.equal(intent.source, 'config')
  assert.equal(intent.hint, REQUIRED_FALLBACK_HINT)
})

test('P9 机械映射 #3/#4：配置与协调者决定冲突只给 hint，不拦截', () => {
  const skip = decideWorktreeIntent({ request: parseWorktreeRequest({ worktree: false }).request, policy: 'required' })
  assert.equal(skip.action, 'none')
  assert.equal(skip.hint, REQUIRED_SKIP_HINT)
  const build = decideWorktreeIntent({ request: parseWorktreeRequest({ worktree: true }).request, policy: 'off' })
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

// —— 三、物理事实分档（n=0 / 1 / ≥2 / 基线不存在 / 非仓库） ——

const repoFacts = overrides => ({
  isRepo: true, repoRoot: 'C:/repo', defaultBranch: 'main',
  recentBranches: [], n: 0, suggestedBase: 'main', needsBranchChoice: false, ...overrides,
})

test('P9 事实分档：n=0 用默认分支，n=1 直接用那条，n≥2 返回 ask（任务不落库）', () => {
  const intent = decideWorktreeIntent({ request: parseWorktreeRequest({ worktree: true }).request, policy: 'auto' })
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
  const intent = decideWorktreeIntent({ request: parseWorktreeRequest({ worktree: true }).request, policy: 'auto' })
  const degraded = decideWorktreeFacts({ intent, facts: { isRepo: false, reason: 'NOT_A_REPO' } })
  assert.equal(degraded.action, 'degrade')
  assert.equal(degraded.hint, DEGRADE_HINT)

  const explicit = decideWorktreeIntent({ request: parseWorktreeRequest({ worktree: true, worktreeBase: 'release' }).request, policy: 'auto' })
  const missing = decideWorktreeFacts({ intent: explicit, facts: repoFacts({ recentBranches: [{ name: 'main' }] }), baseExists: false })
  assert.equal(missing.action, 'reject')
  assert.equal(missing.code, 'BASE_NOT_FOUND')
  assert.match(missing.error, /release/)
  const ok = decideWorktreeFacts({ intent: explicit, facts: repoFacts({}), baseExists: true })
  assert.equal(ok.action, 'create')
  assert.equal(ok.base, 'release')
})

test('P9 分支名：默认 <prefix><taskId>，协调者传了就用；坏前缀回落 orch/', () => {
  assert.equal(branchNameFor({}, 't-1a2b3c4d'), 'orch/t-1a2b3c4d')
  assert.equal(branchNameFor({}, 't-1', 'feat/'), 'feat/t-1')
  assert.equal(branchNameFor({ worktreeBranch: 'feat/x' }, 't-1'), 'feat/x')
  assert.equal(branchNameFor({}, 't-1', 'bad prefix/'), 'orch/t-1')
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

test('P9 配置：worktreePolicy 默认 auto，非法值回落；前缀与窗口归一', () => {
  const config = loadConfig({})
  assert.equal(config.worktreePolicy, 'auto')
  assert.equal(config.worktreeBranchPrefix, 'orch/')
  assert.equal(config.worktreeRecentDays, 7)
  assert.equal(loadConfig({ worktreePolicy: 'required' }).worktreePolicy, 'required')
  assert.equal(loadConfig({ worktreePolicy: 'always' }).worktreePolicy, 'auto')
  assert.equal(loadConfig({ worktreePolicy: 'auto', worktreeBranchPrefix: '  ' }).worktreeBranchPrefix, 'orch/')
  assert.equal(loadConfig({ worktreeRecentDays: 0 }).worktreeRecentDays, 1)
  assert.equal(loadConfig({ worktreeRecentDays: 400 }).worktreeRecentDays, 90)
  assert.equal(loadConfig({ worktreeRecentDays: 'x' }).worktreeRecentDays, 7)
})

test('P9 协调者 policy：结构化渲染当前策略 + 判断流程 + 分支询问 + 合并责任', async () => {
  const { renderCoordinatorPolicy, renderWorktreePolicy } = await import('../index.js')
  const text = renderWorktreePolicy({ worktreePolicy: 'required', worktreeBranchPrefix: 'feat/', worktreeRecentDays: 14 })
  assert.match(text, /当前配置策略：required/)
  assert.match(text, /分支前缀：feat\//)
  assert.match(text, /最近活跃窗口：14 天/)
  assert.match(text, /required：每个需求都用 task_create/)
  assert.match(text, /auto：默认不隔离/)
  assert.match(text, /off：一律不隔离/)
  // 三条件引导 + 协调者判断 + 插件只执行。
  assert.match(text, /A 目标是 git 仓库/)
  assert.match(text, /ask_user_question/)
  assert.match(text, /needsBranchChoice/)
  assert.match(text, /合并由你决定/)
  // 反向验证（v2 硬约束）：不解析 AGENTS.md、不跑 git。
  assert.match(text, /不要问「怎么解析文件」/)
  assert.match(text, /你不要跑 git/)
  const full = renderCoordinatorPolicy({})
  assert.match(full, /你是 dsh-orchestrator 的协调者/)
  assert.match(full, /当前配置策略：auto/)
})
