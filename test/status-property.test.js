// 属性测试（P1-C）：固定种子随机走 12,000 步状态迁移 + 10,000 组任务字段渲染，
// 断言「任意随机序列都不越界、输出稳定、口径唯一」——不是再抄一遍 10×10 矩阵，而是用随机路径
// 覆盖组合空间（合法边/非法边/终态闭包/能力位/文案拼装），失败时报种子即可复现。
//
// 与 test/state.test.js 的分工：那边锁**静态**表（每条边写死），这边锁**动态**性质（走过任意路径后
// 的不变量仍成立）；与 test/status-facts.test.js 的分工：那边锁「谁都不许自己写状态集合」，
// 这边锁「随机组合下能力位与转移表不矛盾」。
import test from 'node:test'
import assert from 'node:assert/strict'
import { canTransition, nextStatus, STATUSES } from '../src/state.js'
import { CAP_KEYS, STATUS_CAPS, TRANSITIONS, statusesWith } from '../src/status-facts.js'
import { PLAN_STATES, PLAN_STATE_LABEL, PLAN_FIRST_DETAIL, PLAN_PHASE_LINES, UNAPPROVED_PLAN_STATES } from '../src/plan-mode.js'
import { ACCESS_FULL, DELIVERY_LINES, planDocPathText } from '../src/copy.js'
import { renderTaskDetail } from '../src/task-detail.js'
import { renderWorkerPolicy } from '../src/prompt-layers.js'

/** 固定种子（0x9e3779b9 = 黄金比例常数）：失败只报种子，任何人都能复现同一条路径。 */
const SEED = 0x9e3779b9
const STEPS = 12_000
const RENDER_CASES = 10_000

/** mulberry32：32 位、无依赖、同种子同序列（属性测试要可复现，不引第三方 PRNG）。 */
function prng(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), state | 1)
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = (random, list) => list[Math.floor(random() * list.length) % list.length]

/**
 * 随机到达某个状态时必须成立的不变量（与 status-facts.js 的设计说明一一对应）。
 *
 * 断言失败信息里带状态名，方便一眼看出是哪条语义被破坏。
 */
function assertStateInvariants(status) {
  const caps = STATUS_CAPS[status]
  assert.deepEqual(Object.keys(caps).sort(), [...CAP_KEYS].sort(), `${status} 的能力位不全`)
  for (const key of CAP_KEYS) assert.equal(typeof caps[key], 'boolean', `${status}.${key} 必须是布尔`)
  // 终态闭包：非活跃状态只能迁到非活跃状态。v0.24 例外：`resume` 能力为真的收尾态可以回 running
  // （那是「续跑原会话」，不新建任务；门控在 src/resume.js，done 还多一层 close_reason='timeout'）。
  if (caps.active === false && caps.resume !== true) {
    for (const to of TRANSITIONS[status]) {
      assert.equal(STATUS_CAPS[to].active, false, `${status} 已不活跃，却仍有边到活跃态 ${to}`)
    }
  }
  // 流程终态不能续派；要释放资源的状态不该还算活跃；等人/阻断轮换都必须先是活跃态。
  if (caps.terminal) assert.equal(caps.followup, false, `${status} 是流程终态却能续派`)
  if (caps.releases) assert.equal(caps.active, false, `${status} 要释放资源却还算活跃`)
  if (caps.waiting) assert.equal(caps.active, true, `${status} 是等人态却不算活跃`)
  // 能续派 ⇔ 有「回到 running」的落点（running 上续派不改状态，是唯一例外）。
  if (caps.followup) {
    assert.ok(status === 'running' || canTransition(status, 'running'), `${status} 能续派却没有回 running 的边`)
  }
  // resume 能力 ⇒ 有回 running 的边（反过来不成立：pending/waiting_* 晋升是正常推进）；
  // 收尾态里能回 running 的必须正好是 resume 能力为真者。
  if (caps.resume) assert.equal(canTransition(status, 'running'), true, `${status} 可续跑却没有回 running 的边`)
  if (caps.active === false && canTransition(status, 'running')) assert.equal(caps.resume, true, `${status} 收尾态能回 running 却不是 resume`)
  // 重派永远是新建一条：可重派的状态只能靠「边」续跑，不能把 retry 实现成原地复活。
  if (caps.retryable && caps.resume !== true) assert.equal(canTransition(status, 'running'), false, `${status} 可重派却能原地复活`)
  // 没有出边的状态必须是流程终态（failed/orphaned 都还有「取消」出口，别让任务卡死）。
  if (TRANSITIONS[status].length === 0) assert.equal(caps.terminal, true, `${status} 没有出边却不是终态`)
}

/** 有出边的状态（重启随机路径时候选；终态只作为「走到过」的证据，不再从它出发）。 */
const LIVE_STATUSES = STATUSES.filter(status => TRANSITIONS[status].length > 0)

/** 走一条随机路径：每步既校验「放行/拒绝」与转移表一致，也在到达时校验能力位不变量。 */
function walk(seed, steps) {
  const random = prng(seed)
  let current = 'waiting_dep'
  const visited = new Set([current])
  const trace = [current]
  let legal = 0
  let rejected = 0
  let restarts = 0
  for (let step = 0; step < steps; step += 1) {
    // 一半概率走随机合法边（推进路径），一半概率走随机目标（用非法边验证判定与表一致）。
    // 只走随机目标会大半步原地踏步，12k 步覆盖不到终态；只走合法边又测不到拒绝分支。
    const to = random() < 0.5 && TRANSITIONS[current].length > 0
      ? pick(random, TRANSITIONS[current])
      : pick(random, STATUSES)
    const allowed = TRANSITIONS[current].includes(to)
    // 判定必须与转移表逐位一致（随机组合下也不许有「表里没有却放行」或反之）。
    assert.equal(canTransition(current, to), allowed, `第 ${step} 步判定漂移：${current} → ${to}`)
    if (allowed) {
      assert.equal(nextStatus(current, to), to, `第 ${step} 步迁移失败：${current} → ${to}`)
      legal += 1
      current = to
      trace.push(`>${to}`)
      visited.add(current)
      assertStateInvariants(current)
      // 走到无出边的状态＝任务自然结束；当作「新任务创建」重启（只从有出边的状态起），
      // 保证 12k 步能覆盖全部状态而不是卡在 done/cancelled。
      if (TRANSITIONS[current].length === 0) {
        current = pick(random, LIVE_STATUSES)
        visited.add(current)
        trace.push(`|${current}`)
        restarts += 1
      }
    } else {
      rejected += 1
      assert.throws(() => nextStatus(current, to), /不允许的状态迁移/, `第 ${step} 步非法边被放行：${current} → ${to}`)
    }
  }
  return { visited, trace, legal, rejected, restarts }
}

test('属性：12,000 步随机迁移只走 TRANSITIONS 的边，覆盖全部状态且可复现', () => {
  const started = performance.now()
  const first = walk(SEED, STEPS)
  const elapsed = performance.now() - started
  assert.equal(first.legal + first.rejected, STEPS)
  assert.ok(first.legal > 0, '随机路径一步合法边都没走到：种子/概率有问题')
  assert.deepEqual([...first.visited].sort(), [...STATUSES].sort(), `12k 步没覆盖全部状态：${[...first.visited]}`)
  // 可复现：同种子跑第二遍，路径与计数逐条相同（不是「看起来随机」）。
  const second = walk(SEED, STEPS)
  assert.deepEqual(second.trace, first.trace, `同种子路径不一致（seed=${SEED}）`)
  assert.deepEqual(
    [second.legal, second.rejected, second.restarts],
    [first.legal, first.rejected, first.restarts],
  )
  // 不同种子必须走出不同路径（否则 PRNG 是常数）。
  const other = walk(SEED + 1, 200)
  assert.notDeepEqual(other.trace, walk(SEED, 200).trace, '不同种子走出同一路径：PRNG 退化')
  // 性能预算（计划 §C3：10k 步 < 2s；这里 12k 步留足机器差异余量）。
  assert.ok(elapsed < 2000, `12,000 步耗时 ${Math.round(elapsed)}ms，超出预算`)
  console.log(`属性测试：seed=${SEED} steps=${STEPS} 合法边=${first.legal} 拒绝=${first.rejected} 重启=${first.restarts} 耗时=${Math.round(elapsed)}ms`)
})

test('属性：能力位与转移表不矛盾（delivered 可追问不可轮换、终态不可复活）', () => {
  for (const status of STATUSES) assertStateInvariants(status)
  // 两条最容易写错的业务不变量，单独再钉一次。
  assert.ok(statusesWith('followup').includes('delivered'), 'delivered 是追问窗口')
  assert.deepEqual(statusesWith('rotationActive'), [], '0.25.0 起没有轮换能力位（轮换已删除）')
  assert.deepEqual(statusesWith('terminal').filter(status => STATUS_CAPS[status].followup), [])
  // failed/orphaned 可重派（新任务），也可 resume（同任务同会话续跑）——两者不是互斥关系：
  // retry 走新建、resume 走「回 running」的边，实现上各有一条独立路径（tools.js retryTask / resumeTask）。
  assert.deepEqual(statusesWith('resume'), ['done', 'failed', 'orphaned'])
  for (const status of statusesWith('resume')) {
    assert.equal(canTransition(status, 'running'), true, `${status} 可续跑却没有回 running 的边`)
  }
})

/** 随机造一份任务行：覆盖只读 / 完整访问 / 计划（六种 plan_state）/ 隔离 / 编排字段。 */
function randomTask(random) {
  const planFirst = random() < 0.4
  const planState = pick(random, PLAN_STATES)
  const readOnly = random() < 0.3
  const access = random() < 0.4 ? 'full' : undefined
  const status = pick(random, STATUSES)
  const brief = {
    title: '属性任务',
    goal: `目标 ${Math.floor(random() * 100)}`,
    acceptance: random() < 0.5 ? ['验收'] : [],
  }
  if (random() < 0.5) brief.target = 'C:/work/project'
  if (access === 'full') brief.access = 'full'
  const task = {
    id: 't-1a2b3c4d',
    status,
    title: '属性任务',
    brief,
    plan_first: planFirst,
    plan_state: planFirst ? planState : 'none',
    read_only: readOnly,
    access,
    group_id: random() < 0.3 ? 'g-1' : undefined,
    priority: random() < 0.3 ? 3 : 0,
    write_scopes: random() < 0.3 ? ['C:/work/project'] : [],
  }
  if (random() < 0.4) task.target_dir = 'C:/work/project'
  return { task, planFirst, planState, readOnly, access }
}

const count = (haystack, needle) => haystack.split(needle).length - 1

test('属性：10,000 组随机任务字段渲染稳定、口径唯一（计划/权限/交付不互相打架）', () => {
  const random = prng(SEED ^ 0x5bf03635)
  const seen = { plan: 0, readOnly: 0, full: 0, plain: 0 }
  for (let index = 0; index < RENDER_CASES; index += 1) {
    const { task, planFirst, planState, readOnly, access } = randomTask(random)
    const text = renderTaskDetail(task)
    // 输出稳定：同样输入渲染两次逐字相同（没有随机/时间依赖）。
    assert.equal(renderTaskDetail(task), text, `第 ${index} 组渲染不稳定`)
    const planning = planFirst && UNAPPROVED_PLAN_STATES.includes(planState)
    const effectiveReadOnly = readOnly || planning
    // 权限口径唯一：只读（含计划阶段）时不许出现完整访问标签，反之亦然。
    if (effectiveReadOnly) {
      assert.equal(text.includes(ACCESS_FULL.label), false, `第 ${index} 组：只读任务却写了完整访问`)
      assert.equal(text.includes(ACCESS_FULL.workerHint), false, `第 ${index} 组：只读任务给了可写提示`)
      seen.readOnly += 1
    } else if (access === 'full') {
      assert.equal(count(text, ACCESS_FULL.label), 1, `第 ${index} 组：完整访问标签应恰出现一次`)
      assert.equal(count(text, ACCESS_FULL.workerHint), 1, `第 ${index} 组：完整访问纪律应恰出现一次`)
      assert.equal(text.includes('权限：只读'), false, `第 ${index} 组：完整访问任务却标了只读`)
      seen.full += 1
    } else {
      seen.plain += 1
    }
    // 计划口径唯一：计划任务恰有一段计划说明（同一份真源），非计划任务一句都不提。
    if (planFirst) {
      assert.equal(count(text, PLAN_PHASE_LINES.heading), 1, `第 ${index} 组：计划说明重复或缺失`)
      assert.equal(count(text, PLAN_FIRST_DETAIL), 1, `第 ${index} 组：计划说明不是同一份真源`)
      assert.equal(count(text, `计划状态：${PLAN_STATE_LABEL[planState]}`), 1, `第 ${index} 组：计划状态行重复`)
      seen.plan += 1
    } else {
      assert.equal(text.includes(PLAN_PHASE_LINES.heading), false, `第 ${index} 组：普通任务混进了计划说明`)
      assert.equal(text.includes('计划状态：'), false, `第 ${index} 组：普通任务混进了计划状态`)
    }
    // 交付口径归 W1（t-4f7ce108）：task_detail 不再出现「已交付待确认」，W1 里恰出现一次。
    assert.equal(text.includes(DELIVERY_LINES.state), false, `第 ${index} 组：task_detail 不该重复交付口径（归 W1）`)
    if (index === 0) {
      const w1 = renderWorkerPolicy()
      assert.equal(count(w1, DELIVERY_LINES.state), 1, '第 0 组：W1 的交付口径重复/缺失')
      assert.equal(w1.includes('不要自行宣告任务结束'), true, '第 0 组：W1 缺少「交付不是结束」的提醒')
    }
  }
  // 覆盖度：随机空间确实走到了四条分支（否则断言等于没测）。
  assert.ok(seen.plan > 0 && seen.readOnly > 0 && seen.full > 0 && seen.plain > 0, `分支覆盖不足：${JSON.stringify(seen)}`)
})

test('属性：计划路径文案在每处拼装里都是同一个字符串', () => {
  // 版本 B：文件名 = 任务名（占位符是 <任务名>），不再按任务编号拼。
  for (const name of ['落盘计划', '任务 甲', undefined]) {
    const text = planDocPathText(name)
    assert.equal(text.startsWith('任务产物目录的 docs/'), true)
    assert.equal(text.endsWith(name === undefined ? '<任务名>-<版本>.md' : `${name}-<版本>.md`), true)
  }
  // task_detail 的计划说明与「落盘路径」用的是同一个路径口径。
  assert.ok(PLAN_FIRST_DETAIL.includes(planDocPathText()), '计划说明里的路径与 planDocPathText() 不同源')
})
