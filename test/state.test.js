// 状态机：转移表、能力表、以及「别再锁死死代码」的矩阵。
//
// 0.19.x 的版本里这张 10×10 矩阵把三条**从未可达**的边写成 `allowed`
// （`orphaned→pending`、`failed→running`、`running→done`），任何人删掉死边都会让测试变红——
// 测试在保护死代码（审计 §2.3.3）。现在矩阵从 `status-facts.js` 的 `TRANSITIONS` 派生，
// 另加一条「不可达边必须被拒」的正向断言，删边不会再被测试拦回来。
//
// v0.24 反过来把两条边**接回来**了：`failed → running`、`orphaned → running`（resume 续跑原会话），
// 外加行级限定的 `done → running`（只认 close_reason='timeout'）。调用点是 `task_message({ action:'resume' })`。
import test from 'node:test'
import assert from 'node:assert/strict'
import { canTransition, nextStatus, STATUSES } from '../src/state.js'
import { CAP_KEYS, STATUS_CAPS, TRANSITIONS, sourcesOf, statusesWith } from '../src/status-facts.js'

test('合法迁移', () => {
  assert.equal(canTransition('pending', 'running'), true)
  assert.equal(canTransition('running', 'waiting_auth'), true)
  assert.equal(canTransition('waiting_auth', 'running'), true)
  assert.equal(canTransition('running', 'failed'), true)
  assert.equal(canTransition('pending', 'cancelled'), true)
  // 两段式终态：交付 → 待确认 → 确认/追问/停止。
  assert.equal(canTransition('running', 'delivered'), true)
  assert.equal(canTransition('delivered', 'running'), true)
  assert.equal(canTransition('delivered', 'done'), true)
  assert.equal(canTransition('delivered', 'cancelled'), true)
  assert.equal(canTransition('delivered', 'orphaned'), true)
})

test('非法迁移', () => {
  // v0.24：done → running 只给 resume（且仅 close_reason='timeout'）用，行级白名单在 resumeGate；
  // 用户主动取消的任务不复活。
  assert.equal(canTransition('cancelled', 'running'), false)
  assert.equal(canTransition('cancelled', 'pending'), false)
  assert.equal(canTransition('pending', 'done'), false)
  assert.equal(canTransition('running', 'pending'), false)
  // delivered 没有「回待派发/回失败」的边：交付结果还在，只能确认、追问、停止或标丢失。
  assert.equal(canTransition('delivered', 'pending'), false)
  assert.equal(canTransition('delivered', 'waiting_user'), false)
  assert.equal(canTransition('delivered', 'failed'), false)
  assert.equal(canTransition('delivered', 'delivered'), false)
})

test('不可达边仍是死的：删边不会被测试拦回来（审计 §2.3.3）', () => {
  // running→done：交付主路径已改成 running→delivered，留着等于允许「跳过确认直接收终态」。
  assert.equal(canTransition('running', 'done'), false)
  // orphaned→pending：deps.js 只从 waiting_dep 晋升 → 死边。
  assert.equal(canTransition('orphaned', 'pending'), false)
  // failed→running 在 v0.24 反向接回（resume 续跑）；「重派仍是新任务」，所以同时留 retryable 与取消出口。
  assert.equal(canTransition('failed', 'running'), true)
  assert.equal(canTransition('failed', 'cancelled'), true)
  assert.equal(STATUS_CAPS.failed.retryable, true)
  assert.equal(STATUS_CAPS.failed.resume, true)
})

test('nextStatus 返回新状态或抛错', () => {
  assert.equal(nextStatus('delivered', 'done'), 'done')
  assert.equal(nextStatus('running', 'delivered'), 'delivered')
  // v0.24：done → running 只给 resume（且仅 close_reason='timeout'）用，行级白名单在 resumeGate；
  // 转移表本身表达不了行级条件，所以这里只断言「这条边存在、其他收尾态不能乱走」。
  assert.equal(nextStatus('done', 'running'), 'running')
  assert.throws(() => nextStatus('cancelled', 'running'), /不允许的状态迁移/)
  // 死边删掉后 nextStatus 也拒绝，且错误信息可读。
  assert.throws(() => nextStatus('running', 'done'), /不允许的状态迁移：running → done/)
})

test('状态集合完整', () => {
  assert.deepEqual([...STATUSES].sort(), [
    'cancelled', 'delivered', 'done', 'failed', 'orphaned', 'pending', 'running', 'waiting_auth', 'waiting_dep', 'waiting_user',
  ])
  // 能力表与转移表必须覆盖同一批状态，不能有「有状态没能力」的漏洞。
  assert.deepEqual(Object.keys(STATUS_CAPS).sort(), [...STATUSES].sort())
  assert.deepEqual(Object.keys(TRANSITIONS).sort(), [...STATUSES].sort())
})

test('10×10 全迁移矩阵从 TRANSITIONS 派生：只放行表里写明的边', () => {
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      const expected = TRANSITIONS[from].includes(to)
      assert.equal(canTransition(from, to), expected, `${from} → ${to}`)
    }
  }
  // 反向核对：转移表里不许出现未知状态（写错名字会静默失效）。
  for (const [from, targets] of Object.entries(TRANSITIONS)) {
    for (const to of targets) assert.ok(STATUSES.includes(to), `${from} → ${to} 的目标不是合法状态`)
  }
})

test('每条边都有能力表依据：除 resume 外，流程终态不能回到活跃态', () => {
  // 「流程终态」= 用户视角已经结束。它唯一的合法出边是「取消」这种收尾（orphaned → cancelled），
  // 绝不能回到任何活跃态——**唯一例外是 resume 能力为真的收尾态**（v0.24）：
  // failed / orphaned / timeout 收尾的 done 可以冷恢复原会话回 running，那是「续跑」不是「复活」。
  for (const from of STATUSES) {
    if (STATUS_CAPS[from].terminal && STATUS_CAPS[from].resume !== true) {
      for (const to of TRANSITIONS[from]) {
        assert.equal(STATUS_CAPS[to].active, false, `${from}（终态）不该能迁到活跃态 ${to}`)
      }
    }
  }
  for (const from of STATUSES) {
    if (STATUS_CAPS[from].terminal) assert.equal(STATUS_CAPS[from].followup, false, `${from} 是终态，不该能续派`)
  }
  // done 只有 resume 出口（且行级限定时超时收尾）；cancelled 无出口；failed/orphaned 还能取消。
  assert.deepEqual([...TRANSITIONS.done], ['running'])
  assert.deepEqual([...TRANSITIONS.cancelled], [])
  assert.deepEqual([...TRANSITIONS.failed], ['cancelled', 'running'])
  assert.deepEqual([...TRANSITIONS.orphaned], ['cancelled', 'running'])
})

test('每个状态都有入边（没有无法到达的状态）', () => {
  for (const status of STATUSES) {
    if (status === 'waiting_dep') continue // 创建入口：新建任务直接落在 waiting_dep/pending
    assert.ok(sourcesOf(status).length > 0, `${status} 没有任何入边`)
  }
  assert.deepEqual(sourcesOf('delivered'), ['running'])
  assert.deepEqual(sourcesOf('done'), ['delivered'])
})

test('能力表：每个字段都是布尔，且派生集合与集合语义一致', () => {
  for (const status of STATUSES) {
    for (const key of CAP_KEYS) {
      assert.equal(typeof STATUS_CAPS[status][key], 'boolean', `${status}.${key} 必须是布尔`)
    }
  }
  // 活跃 ∪ 非活跃 = 全集，且互不重叠。
  assert.deepEqual([...statusesWith('active')].sort(), ['delivered', 'pending', 'running', 'waiting_auth', 'waiting_dep', 'waiting_user'])
  // 流程终态（用户视角「结束了」）与「已收尾」（要释放资源）不是同一批：failed 只在后者里。
  assert.deepEqual(statusesWith('terminal'), ['done', 'cancelled', 'orphaned'])
  assert.deepEqual(statusesWith('releases'), ['done', 'failed', 'cancelled', 'orphaned'])
  assert.deepEqual(statusesWith('retryable'), ['failed', 'orphaned'])
  assert.deepEqual(statusesWith('followup'), ['running', 'waiting_user', 'waiting_auth', 'delivered'])
  assert.deepEqual(statusesWith('resumable'), ['waiting_user', 'waiting_auth', 'delivered'])
  assert.deepEqual(statusesWith('waiting'), ['waiting_user', 'waiting_auth'])
  assert.deepEqual(statusesWith('deletable'), ['done', 'failed', 'cancelled', 'orphaned'])
})

test('能力表：轮换/对账/看门狗的窄口径（delivered 刻意不算「在跑」）', () => {
  // main-rotation：delivered 只等确认，不该阻断换主会话（LIMITATIONS 明写这是有意的）。
  assert.deepEqual(statusesWith('rotationActive'), ['waiting_dep', 'pending', 'running', 'waiting_user', 'waiting_auth'])
  // reconcile：活跃性对账只认 running；catalog 查得到 running + 故意停下的 waiting_*。
  assert.deepEqual(statusesWith('liveness'), ['running'])
  assert.deepEqual(statusesWith('catalog'), ['running', 'waiting_user', 'waiting_auth'])
  // watchdog：只看 running（waiting_* 是故意停下的，终态不在巡检范围）。
  assert.deepEqual(statusesWith('watchdog'), ['running'])
  // 计划任务进这些状态时收口 plan_state（含 delivered：计划阶段已结束）。
  assert.deepEqual(statusesWith('planSettled'), ['delivered', 'done', 'failed', 'cancelled', 'orphaned'])
})

test('未知状态返回 false 不抛错', () => {
  assert.equal(canTransition('x', 'running'), false)
  assert.equal(canTransition('running', 'x'), false)
  assert.equal(canTransition(undefined, 'running'), false)
})
