// 同写域并发防护（0.16）：纯函数 + task_create 集成回归。
//
// 事故：协调者在同一个 target 目录并发派了两个未隔离任务，两个子会话同时写同一份工作树。
// 这里锁住四件事：默认拒绝、三条出路（task_close / worktree / allowConcurrent）、
// 降级配置（warn / off）、以及既有合法场景不受影响。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { openLedger, createTask, getTask, listTasks, transition } from '../src/ledger.js'
import { createTools } from '../src/tools.js'
import { createQueue } from '../src/queue.js'
import {
  DEFAULT_SAME_DIR_GUARD, SAME_DIR_GUARD_MODES, decideWriteGuard, guardModeOf, normalizePath, pathsOverlap,
  sameDirRejection, scopeRejection, scopesOverlap, serializedIdsOf, taskTargetDir, occupiesTarget,
} from '../src/write-guard.js'
import { loadConfig } from '../src/config.js'
import { renderCoordinatorPolicy } from '../index.js'
import { tempDir, sampleBrief } from './helpers.js'

// —— 一、纯函数 ——

test('路径归一与包含判定：相等/父子目录算重叠，兄弟目录不算；Windows 大小写不敏感', () => {
  assert.equal(normalizePath('/a/b/'), '/a/b')
  assert.equal(pathsOverlap('/a/b', '/a/b'), true)
  assert.equal(pathsOverlap('/a/b', '/a/b/c'), true)
  assert.equal(pathsOverlap('/a/b/c', '/a/b'), true)
  assert.equal(pathsOverlap('/a/bc', '/a/b'), false)
  assert.equal(pathsOverlap('', '/a/b'), false)
  assert.equal(pathsOverlap(undefined, '/a/b'), false)
})

test('写域重叠：相等或父子目录；空值与不相关路径不算', () => {
  assert.equal(scopesOverlap('src/api', 'src/api'), true)
  assert.equal(scopesOverlap('src/api', 'src'), true)
  assert.equal(scopesOverlap('src', 'src/api'), true)
  assert.equal(scopesOverlap('src/api', 'src/app'), false)
  assert.equal(scopesOverlap('', 'src'), false)
  assert.equal(scopesOverlap('src\\api\\', 'src/api'), true)
})

test('占用判定：只读任务与隔离任务不占写域；计划任务照常占（批准后会转可写）', () => {
  assert.equal(occupiesTarget({ read_only: false, worktree_state: 'none' }), true)
  assert.equal(occupiesTarget({ read_only: true, worktree_state: 'none' }), false)
  assert.equal(occupiesTarget({ read_only: false, worktree_state: 'created' }), false)
  assert.equal(occupiesTarget({ read_only: false, worktree_state: 'reused' }), false)
  assert.equal(occupiesTarget({ read_only: false, plan_first: true, worktree_state: 'none' }), true)
})

test('target 取值：优先 target_dir（隔离任务已换算成检出目录），退回 brief.target', () => {
  assert.equal(taskTargetDir({ target_dir: '/a', brief: { target: '/b' } }), '/a')
  assert.equal(taskTargetDir({ target_dir: null, brief: { target: '/b' } }), '/b')
  assert.equal(taskTargetDir({ target_dir: '  ', brief: {} }), '')
})

test('dependsOn 祖先集合：含间接前置，不存在的 id 也记账但不炸', () => {
  const tasks = [
    { id: 't-a', depends_on: [] },
    { id: 't-b', depends_on: ['t-a'] },
  ]
  const ids = serializedIdsOf(tasks, ['t-b', 't-missing'])
  assert.deepEqual([...ids].sort(), ['t-a', 't-b', 't-missing'])
})

test('判定：require 档冲突即拒绝；allowConcurrent 放行并带风险标注', () => {
  const tasks = [{ id: 't-old', title: '旧任务', status: 'running', target_dir: '/repo', write_scopes: [] }]
  const rejected = decideWriteGuard({ tasks, target: '/repo' })
  assert.equal(rejected.action, 'reject')
  assert.equal(rejected.mode, 'require')
  assert.match(rejected.text, /未创建任务/)
  assert.match(rejected.text, /task_close/)
  assert.match(rejected.text, /worktree:true/)
  assert.match(rejected.text, /allowConcurrent:true/)
  assert.match(rejected.text, /旧任务/)

  const allowed = decideWriteGuard({ tasks, target: '/repo', allowConcurrent: true })
  assert.equal(allowed.action, 'pass')
  assert.match(allowed.note, /并发风险/)
  assert.match(allowed.note, /allowConcurrent:true/)
})

test('判定：warn 档照常创建但留强警告；off 档完全不判', () => {
  const tasks = [{ id: 't-old', title: '旧任务', status: 'running', target_dir: '/repo' }]
  const warn = decideWriteGuard({ tasks, target: '/repo', mode: 'warn' })
  assert.equal(warn.action, 'pass')
  assert.match(warn.note, /sameDirGuard="warn"/)
  assert.match(warn.note, /本应拒绝/)
  const off = decideWriteGuard({ tasks, target: '/repo', mode: 'off' })
  assert.equal(off.action, 'pass')
  assert.equal(off.note, '')
  assert.deepEqual(off.targetConflicts, [])
})

test('判定：只读/隔离任务不算冲突方；dependsOn 链上的前置也不算', () => {
  const tasks = [
    { id: 't-ro', title: '只读', status: 'running', target_dir: '/repo', read_only: true },
    { id: 't-wt', title: '隔离', status: 'running', target_dir: '/repo', worktree_state: 'created' },
  ]
  assert.equal(decideWriteGuard({ tasks, target: '/repo' }).action, 'pass')

  const chain = [{ id: 't-dep', title: '前置', status: 'running', target_dir: '/repo', depends_on: [] }]
  assert.equal(decideWriteGuard({ tasks: chain, target: '/repo', dependsOn: ['t-dep'] }).action, 'pass')
})

test('判定：写域重叠（不同目录）也拦，文案列出重叠路径与冲突任务名', () => {
  const tasks = [{
    id: 't-a', title: '写域A', status: 'running', target_dir: '/repo-a', write_scopes: ['src/api'],
  }]
  const result = decideWriteGuard({ tasks, target: '/repo-b', scopes: ['src'] })
  assert.equal(result.action, 'reject')
  assert.match(result.text, /写域/)
  assert.match(result.text, /src\/api/)
  assert.match(result.text, /写域A/)
  // 同 target 的冲突优先用目录文案（更贴近事故形态）。
  assert.match(sameDirRejection({ target: '/repo', conflicts: [{ task: tasks[0], target: '/repo' }] }), /目标目录/)
  assert.match(scopeRejection({ scopes: ['src'], conflicts: [{ task: tasks[0], scope: 'src', other: 'src/api' }] }), /src\/api/)
})

test('配置归一：默认 require；warn/off 认；拼错回落 require（默认必须安全）', () => {
  assert.deepEqual([...SAME_DIR_GUARD_MODES], ['require', 'warn', 'off'])
  assert.equal(DEFAULT_SAME_DIR_GUARD, 'require')
  assert.equal(loadConfig({}).sameDirGuard, 'require')
  assert.equal(loadConfig({ sameDirGuard: 'warn' }).sameDirGuard, 'warn')
  assert.equal(loadConfig({ sameDirGuard: 'off' }).sameDirGuard, 'off')
  for (const bad of ['reject', 'WARN', 'false', '', 0, null, {}]) {
    assert.equal(loadConfig({ sameDirGuard: bad }).sameDirGuard, 'require', `${JSON.stringify(bad)} 应回落 require`)
  }
  assert.equal(guardModeOf('warn'), 'warn')
  assert.equal(guardModeOf('nope'), 'require')
})

// —— 二、task_create 集成 ——

function fakeDispatcher() {
  let counter = 0
  return {
    calls: [],
    slug() { counter += 1; return `task-${counter}` },
    async spawn(input) {
      this.calls.push(['spawn', input])
      counter += 1
      return { id: `c-${counter}`, name: input.name, sessionId: `c-${counter}`, target: `c-${counter}` }
    },
    async sendReliable(target, message) {
      this.calls.push(['sendReliable', target, message])
      return { messageId: 'm-1' }
    },
    async stop(target) { this.calls.push(['stop', target]) },
    releaseWritableRoots(target) { this.calls.push(['release', target]) },
  }
}

async function setup({ config: overrides = {}, worktree } = {}) {
  const db = await openLedger(tempDir())
  const dispatcher = fakeDispatcher()
  const notifier = { pushed: [], push(item) { this.pushed.push(item) } }
  const config = { staleMinutes: 30, maxQueue: 50, coordinatorSession: 's-1', sameDirGuard: 'require', ...overrides }
  const queue = createQueue({ db, dispatcher, config, notifier, worktree })
  const tools = Object.fromEntries(createTools({
    db, dispatcher, queue, notifier, config,
    worktree,
    coordinatorStatus: () => ({ id: 's-1', live: true }),
  }).map(tool => [tool.name, tool]))
  const call = (name, args, exec) => tools[name].execute(args, exec ?? { agent: { id: 's-1' } })
  return { db, dispatcher, queue, tools, call }
}

test('同 target 且无 worktree：默认拒绝，不建任务、不派发，错误给出三条出路', async () => {
  const { db, dispatcher, call } = await setup()
  const target = tempDir()
  const first = await call('task_create', { ...sampleBrief({ title: '旧任务', goal: 'g1' }), target })
  assert.match(first, /已派发/)

  const second = await call('task_create', { ...sampleBrief({ title: '新任务', goal: 'g2' }), target })
  assert.match(second, /未创建任务/)
  assert.match(second, /目标目录/)
  assert.match(second, /旧任务/)
  assert.match(second, /task_close/)
  assert.match(second, /worktree:true/)
  assert.match(second, /allowConcurrent:true/)
  assert.equal(listTasks(db, { active: true }).length, 1)
  assert.equal(dispatcher.calls.filter(item => item[0] === 'spawn').length, 1)
  db.close()
})

test('互相包含也拦：子目录 target 与父目录活跃任务算同写域', async () => {
  const { db, call } = await setup()
  const root = tempDir()
  mkdirSync(join(root, 'pkg'))
  await call('task_create', { ...sampleBrief({ title: '父目录', goal: 'g1' }), target: root })
  const child = await call('task_create', { ...sampleBrief({ title: '子目录', goal: 'g2' }), target: join(root, 'pkg') })
  assert.match(child, /未创建任务/)
  assert.equal(listTasks(db, { active: true }).length, 1)
  db.close()
})

test('allowConcurrent:true 显式放行，并在返回里标注并发风险', async () => {
  const { db, call } = await setup()
  const target = tempDir()
  await call('task_create', { ...sampleBrief({ title: '旧任务', goal: 'g1' }), target })
  const second = await call('task_create', {
    ...sampleBrief({ title: '并发任务', goal: 'g2' }), target, allowConcurrent: true,
  })
  assert.match(second, /已派发/)
  assert.match(second, /并发风险/)
  assert.match(second, /allowConcurrent:true/)
  assert.equal(listTasks(db, { active: true }).length, 2)
  db.close()
})

test('旧任务关闭（done/cancelled）后可正常创建；不同 target 一直不受影响', async () => {
  const { db, call } = await setup()
  const target = tempDir()
  const other = tempDir()
  const first = await call('task_create', { ...sampleBrief({ title: '旧任务', goal: 'g1' }), target })
  assert.match(first, /已派发/)
  const old = listTasks(db, { active: true })[0]
  await call('task_stop', { task_id: old.id })
  assert.equal(getTask(db, old.id).status, 'cancelled')

  const again = await call('task_create', { ...sampleBrief({ title: '接续任务', goal: 'g2' }), target })
  assert.match(again, /已派发/)

  const elsewhere = await call('task_create', { ...sampleBrief({ title: '别的目录', goal: 'g3' }), target: other })
  assert.match(elsewhere, /已派发/)
  // 旧任务已 cancelled（不算活跃），只剩「接续任务」与「别的目录」。
  assert.equal(listTasks(db, { active: true }).length, 2)
  assert.equal(listTasks(db).length, 3)
  db.close()
})

test('已完成任务不占目录：done 之后同 target 可再派', async () => {
  const { db, call } = await setup()
  const target = tempDir()
  await call('task_create', { ...sampleBrief({ title: '前一轮', goal: 'g1' }), target })
  const first = listTasks(db, { active: true })[0]
  await call('task_report', { task_id: first.id, status: 'done', summary: '完成' }, { agent: { id: first.session_id } })
  await call('task_close', { task_id: first.id })
  assert.equal(getTask(db, first.id).status, 'done')

  const second = await call('task_create', { ...sampleBrief({ title: '下一轮', goal: 'g2' }), target })
  assert.match(second, /已派发/)
  db.close()
})

test('delivered（待确认）算活跃：拒绝文案额外提示 task_message 追问而不是新建', async () => {
  const { db, call } = await setup()
  const target = tempDir()
  await call('task_create', { ...sampleBrief({ title: '待确认任务', goal: 'g1' }), target })
  const task = listTasks(db, { active: true })[0]
  await call('task_report', { task_id: task.id, status: 'done', summary: '完成' }, { agent: { id: task.session_id } })
  assert.equal(getTask(db, task.id).status, 'delivered')

  const blocked = await call('task_create', { ...sampleBrief({ title: '同目录新任务', goal: 'g2' }), target })
  assert.match(blocked, /未创建任务/)
  assert.match(blocked, /待确认/)
  assert.match(blocked, /task_message/)
  db.close()
})

test('worktree 隔离任务放行：新任务隔离、或旧任务已在检出里跑', async () => {
  // 新任务要隔离（worktree 决定权在协调者；这里只验证防护不误拦）。
  const service = {
    async probeRepo() {
      return { isRepo: true, repoRoot: '/repo', defaultBranch: 'main', head: 'abc', n: 1, recentBranches: [{ name: 'main' }], suggestedBase: 'main', needsBranchChoice: false }
    },
    async refExists() { return true },
    async branchExists() { return false },
    async create(args) { return { ok: true, path: args.path, branch: args.branch, base: args.base } },
    async ensureExcluded() { return { ok: true, added: true } },
    async remove() { return { ok: true } },
  }
  const { db, call } = await setup({ worktree: service })
  const target = tempDir()
  const first = await call('task_create', { ...sampleBrief({ title: '普通任务', goal: 'g1' }), target })
  assert.match(first, /已派发/)
  const isolated = await call('task_create', {
    ...sampleBrief({ title: '隔离任务', goal: 'g2' }), target, worktree: true, worktreeBase: 'main',
  })
  assert.match(isolated, /已派发/)
  assert.match(isolated, /隔离：/)
  db.close()

  // 旧任务本身在隔离检出里跑：不占原 target。
  const second = await setup()
  const dir = tempDir()
  createTask(second.db, {
    brief: sampleBrief({ title: '已有隔离任务', goal: 'g' }),
    coordinatorSession: 's-1',
    targetDir: join(dir, '.agents', 'worktrees', 't-x'),
    worktree: { state: 'created', source: 'task', repoRoot: dir, path: join(dir, '.agents', 'worktrees', 't-x'), branch: 'orch/t-x', base: 'main', mode: 'new' },
  })
  const plain = await second.call('task_create', { ...sampleBrief({ title: '普通任务2', goal: 'g2' }), target: dir })
  assert.match(plain, /已派发/)
  second.db.close()
})

test('计划任务照常参与：计划阶段只读，但批准后会转可写，不能把冲突推迟到那一刻', async () => {
  const { db, call } = await setup()
  const target = tempDir()
  await call('task_create', { ...sampleBrief({ title: '在跑任务', goal: 'g1' }), target })
  const planned = await call('task_create', { ...sampleBrief({ title: '计划任务', goal: 'g2' }), target, planFirst: true })
  assert.match(planned, /未创建任务/)
  // 显式放行仍可用（协调者按用户要求并发时）。
  const allowed = await call('task_create', {
    ...sampleBrief({ title: '计划任务', goal: 'g3' }), target, planFirst: true, allowConcurrent: true,
  })
  assert.match(allowed, /已派发|等待前置|排队|已创建/)
  assert.match(allowed, /并发风险/)
  db.close()
})

test('只读任务既不占目录也不被拦', async () => {
  const { db, call } = await setup()
  const target = tempDir()
  await call('task_create', { ...sampleBrief({ title: '只读任务', goal: 'g1' }), target, readOnly: true })
  assert.equal(getTask(db, listTasks(db, { active: true })[0].id).read_only, true)
  const writable = await call('task_create', { ...sampleBrief({ title: '可写任务', goal: 'g2' }), target })
  assert.match(writable, /已派发/)

  // 反过来：已有可写任务时，只读任务不被拦。
  const readonly = await call('task_create', { ...sampleBrief({ title: '只读任务2', goal: 'g3' }), target, readOnly: true })
  assert.match(readonly, /已派发/)
  db.close()
})

test('dependsOn 串行的同目录任务不被拦（前置完成才派发，不会同时写）', async () => {
  const { db, call } = await setup()
  const target = tempDir()
  await call('task_create', { ...sampleBrief({ title: '前置', goal: 'g1' }), target })
  const dep = listTasks(db, { active: true })[0]
  const downstream = await call('task_create', {
    ...sampleBrief({ title: '下游', goal: 'g2' }), target, dependsOn: [dep.id],
  })
  assert.match(downstream, /等待前置任务完成/)
  assert.equal(listTasks(db, { active: true }).length, 2)
  db.close()
})

test('写域重叠被拒：不同目录但写域撞了，文案列出重叠路径与冲突任务', async () => {
  const { db, call } = await setup()
  const a = tempDir()
  const b = tempDir()
  await call('task_create', { ...sampleBrief({ title: '写域A', goal: 'g1' }), target: a, writeScopes: ['src/api'] })
  const blocked = await call('task_create', { ...sampleBrief({ title: '写域B', goal: 'g2' }), target: b, writeScopes: ['src'] })
  assert.match(blocked, /未创建任务/)
  assert.match(blocked, /写域/)
  assert.match(blocked, /src\/api/)
  assert.match(blocked, /写域A/)
  assert.equal(listTasks(db, { active: true }).length, 1)
  db.close()
})

test('sameDirGuard=warn：照常创建，但返回里带强警告', async () => {
  const { db, call } = await setup({ config: { sameDirGuard: 'warn' } })
  const target = tempDir()
  await call('task_create', { ...sampleBrief({ title: '旧任务', goal: 'g1' }), target })
  const second = await call('task_create', { ...sampleBrief({ title: '新任务', goal: 'g2' }), target })
  assert.match(second, /已派发/)
  assert.match(second, /并发风险/)
  assert.match(second, /sameDirGuard="warn"/)
  assert.equal(listTasks(db, { active: true }).length, 2)
  db.close()
})

test('sameDirGuard=off：不判 target，写域也退回旧 advisory 文案', async () => {
  const { db, call } = await setup({ config: { sameDirGuard: 'off' } })
  const target = tempDir()
  const other = tempDir()
  await call('task_create', { ...sampleBrief({ title: '旧任务', goal: 'g1' }), target, writeScopes: ['src/api'] })
  const same = await call('task_create', { ...sampleBrief({ title: '同目录', goal: 'g2' }), target })
  assert.match(same, /已派发/)
  assert.doesNotMatch(same, /并发风险/)
  const scoped = await call('task_create', { ...sampleBrief({ title: '写域重叠', goal: 'g3' }), target: other, writeScopes: ['src'] })
  assert.match(scoped, /已派发/)
  assert.match(scoped, /写域与活跃任务冲突/)
  db.close()
})

test('拒绝走日志：task.create.rejected 带 same-dir/write-scope 与冲突任务 id', async () => {
  const events = []
  const logger = { log: (event, fields) => events.push([event, fields]) }
  const db = await openLedger(tempDir())
  const dispatcher = fakeDispatcher()
  const notifier = { pushed: [], push() {} }
  const config = { staleMinutes: 30, maxQueue: 50, coordinatorSession: 's-1', sameDirGuard: 'require' }
  const queue = createQueue({ db, dispatcher, config, notifier })
  const tools = Object.fromEntries(createTools({
    db, dispatcher, queue, notifier, config, logger, coordinatorStatus: () => ({ id: 's-1', live: true }),
  }).map(tool => [tool.name, tool]))
  const call = (name, args, exec) => tools[name].execute(args, exec ?? { agent: { id: 's-1' } })
  const target = tempDir()
  await call('task_create', { ...sampleBrief({ title: '旧任务', goal: 'g1' }), target })
  const old = listTasks(db, { active: true })[0]
  await call('task_create', { ...sampleBrief({ title: '新任务', goal: 'g2' }), target })
  const rejected = events.filter(([event]) => event === 'task.create.rejected')
  assert.equal(rejected.length, 1)
  assert.equal(rejected[0][1].detail.reason, 'same-dir')
  assert.equal(rejected[0][1].detail.mode, 'require')
  assert.deepEqual(rejected[0][1].detail.conflicts, [old.id])
  db.close()
})

test('放行走日志：task.create.concurrent-write 记 mode/allowed/冲突任务', async () => {
  const events = []
  const logger = { log: (event, fields) => events.push([event, fields]) }
  const db = await openLedger(tempDir())
  const dispatcher = fakeDispatcher()
  const notifier = { pushed: [], push() {} }
  const config = { staleMinutes: 30, maxQueue: 50, coordinatorSession: 's-1', sameDirGuard: 'require' }
  const queue = createQueue({ db, dispatcher, config, notifier })
  const tools = Object.fromEntries(createTools({
    db, dispatcher, queue, notifier, config, logger, coordinatorStatus: () => ({ id: 's-1', live: true }),
  }).map(tool => [tool.name, tool]))
  const call = (name, args, exec) => tools[name].execute(args, exec ?? { agent: { id: 's-1' } })
  const target = tempDir()
  await call('task_create', { ...sampleBrief({ title: '旧任务', goal: 'g1' }), target })
  await call('task_create', { ...sampleBrief({ title: '并发任务', goal: 'g2' }), target, allowConcurrent: true })
  const logged = events.filter(([event]) => event === 'task.create.concurrent-write')
  assert.equal(logged.length, 1)
  assert.equal(logged[0][1].detail.allowed, true)
  assert.equal(logged[0][1].detail.mode, 'require')
  db.close()
})

test('schema 暴露 allowConcurrent，且 writeScopes 描述不再自称 advisory', async () => {
  const { db, tools } = await setup()
  const schema = tools.task_create.parameters.properties
  assert.equal(schema.allowConcurrent.type, 'boolean')
  assert.match(schema.allowConcurrent.description, /allowConcurrent|并发/)
  assert.doesNotMatch(schema.writeScopes.description, /advisory/)
  assert.match(schema.writeScopes.description, /sameDirGuard/)
  db.close()
})

test('重派（task_retry）不受影响：失败任务腾出目录后按原 target 重派', async () => {
  const { db, call } = await setup()
  const target = tempDir()
  await call('task_create', { ...sampleBrief({ title: '会失败', goal: 'g1' }), target })
  const task = listTasks(db, { active: true })[0]
  transition(db, task.id, 'failed', { error: 'boom' })
  const retried = await call('task_retry', { task_id: task.id })
  assert.match(retried, /已重派/)
  assert.equal(listTasks(db, { active: true }).length, 1)
  db.close()
})

// —— 三、协调者 policy 与文档同口径 ——

test('协调者 policy 渲染同写域防护：档位、三条出路、delivered 追问口径', () => {
  const policy = renderCoordinatorPolicy({})
  assert.match(policy, /## 同写域并发防护/)
  assert.match(policy, /sameDirGuard=require/)
  assert.match(policy, /task_close/)
  assert.match(policy, /worktree:true/)
  assert.match(policy, /allowConcurrent:true/)
  assert.match(policy, /delivered/)
  // 降级档位要如实渲染，不能一律写「拒绝」。
  assert.match(renderCoordinatorPolicy({ sameDirGuard: 'warn' }), /sameDirGuard=warn/)
  assert.match(renderCoordinatorPolicy({ sameDirGuard: 'warn' }), /只警告/)
  assert.match(renderCoordinatorPolicy({ sameDirGuard: 'off' }), /已关闭/)
})

test('README / docs 写明行为变更、配置字段与默认值、三条出路', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  assert.match(readme, /### 同写域并发防护/)
  assert.match(readme, /行为变更/)
  assert.match(readme, /sameDirGuard/)
  assert.match(readme, /`require`/)
  assert.match(readme, /allowConcurrent/)
  assert.match(readme, /task_close/)
  assert.match(readme, /worktree:true/)
  for (const file of ['docs/ARCHITECTURE.md', 'docs/LIMITATIONS.md', 'docs/DETAIL.md']) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
    assert.match(text, /sameDirGuard|同写域/, `${file} 缺防护说明`)
  }
  const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
  assert.match(changelog, /同写域并发防护/)
  assert.match(changelog, /行为变更/)
})
