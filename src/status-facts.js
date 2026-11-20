// 任务状态的唯一事实源（status-facts）：状态 → 能力，以及唯一的状态转移表。
//
// 为什么要有这个模块（审计 §2.3）：`state.js` 早就有唯一转移表，但**状态集合**被复制到 9 个模块
// （`panel-gates` / `tools` / `panel-actions` / `settlement` / `reconcile` / `watchdog` /
// `ledger` 的 SQL / `host-route`），并且已经产生三处真实不一致：
//   1. `tools.js` 的 `RESUME_STATUS` 含 `failed`，而面板层不含——但 `followupGate` 一直拒绝 failed，
//      所以工具层那个 `failed` 是**死分支**，表达的是错误意图；
//   2. 「流程终态」（无 `failed`）与「要释放资源的终态」（有 `failed`）名字几乎一样、语义不同；
//   3. 面板 stop 用「不含 failed 的终态」做幂等判定 → 对失败任务点「停止」会走
//      `failed → cancelled`，把「失败」这个信息抹成「已取消」。
//
// 设计：一张 `STATUS_CAPS` 表 + 一组派生集合，别处一律从这里取，不再写本地 Set。
// 新增状态时只改这张表，13 处引用自动跟上（`test/status-facts.test.js` 有静态断言守着）。
//
// 命名口径（每个字段都回答一个**具体问题**，不要用 `active` 一把梭）：
//   active       —— 还算「没落终态」吗？（台账 listTasks(active)、面板筛「进行中」）
//   followup     —— 能给它续派/追问吗？（`task_message` 与面板「追加」同源）
//   resumable    —— 续派成功后要把它迁回 running 吗？（waiting_* 与 delivered：投递即恢复；
//                   running 上续派**不改状态**，所以它 followup:true 但 resumable:false）
//   deletable    —— 能删吗？（面板删除，活跃任务必须先停）
//   terminal     —— 是「流程终态」吗？（用户看到「已经结束了」；failed 不算——它还能重派）
//   releases     —— 进入这个状态要释放可写根与平台 goal 吗？（结算/停止的收尾动作）
//   retryable    —— 能重派吗？（工具 task_message action:retry 与面板「重派」）
//   waiting      —— 是「等人（用户/授权）」的停顿态吗？（回复消息 = 批准计划）
//   resume       —— 能「续跑原会话」吗？（failed / orphaned / timeout 收尾的 done；与 retry 分工）
//   liveness     —— 要做「子会话还活着吗」对账吗？（只有 running：其余是故意停下的）
//   catalog      —— 要查子会话目录里还在不在吗？（running + 故意停下的 waiting_*）
//   watchdog     —— 要巡检空闲告警吗？（只有 running）
//   planSettled  —— 计划任务进这个状态时是否收口 plan_state？（含 delivered：计划阶段已结束）
//
// 依赖方向：本模块不 import 任何模块（状态是叶子事实），`state.js` 反过来从这里派生并转发，
// 所以「文案表」仍在 `state.js`（`STATUS_LABEL` / `statusLabel`），「状态事实」只在这里。

/** 全部状态（顺序即 UI/文案里的展示顺序）。 */
export const STATUSES = Object.freeze([
  'waiting_dep', 'pending', 'running', 'waiting_user', 'waiting_auth', 'delivered',
  'done', 'failed', 'cancelled', 'orphaned',
])

/**
 * 状态 → 能力。**唯一判定点**：任何模块要问「某状态算不算 X」，都查这张表。
 *
 * 注意几个刻意的不对称（改动前先读理由，别当成笔误）：
 * - `failed`：`terminal:false`（还能重派，用户视角不是「流程走完」）但 `releases:true`（要释放资源）；
 *   它 `deletable:true` 且 `retryable:true`，但 `followup:false`——子会话已结束，追问没有投递对象；
 *   但 `resume:true`：**续跑**（冷恢复原会话）是另一条路，不靠追问，靠 task_message({ action:'resume' })。
 * - `delivered`：`active:true`（还在等人确认）且 `followup:true`（追问窗口），但不算终态。
 * - `orphaned`：`terminal:true` 且 `retryable:true`——会话丢了可以重派，流程上它已经结束；
 *   子会话 durable 时还能 resume 回来（这是重启后「别新开一条」的默认出口）。
 * - `waiting_dep` / `pending`：`active:true` 但 `followup:false`（还没有子会话可投递）。
 */
export const STATUS_CAPS = Object.freeze({
  waiting_dep: Object.freeze({
    active: true, followup: false, resumable: false, deletable: false, terminal: false, releases: false,
    retryable: false, resume: false, waiting: false, liveness: false, catalog: false,
    watchdog: false, planSettled: false,
  }),
  pending: Object.freeze({
    active: true, followup: false, resumable: false, deletable: false, terminal: false, releases: false,
    retryable: false, resume: false, waiting: false, liveness: false, catalog: false,
    watchdog: false, planSettled: false,
  }),
  running: Object.freeze({
    active: true, followup: true, resumable: false, deletable: false, terminal: false, releases: false,
    retryable: false, resume: false, waiting: false, liveness: true, catalog: true,
    watchdog: true, planSettled: false,
  }),
  waiting_user: Object.freeze({
    active: true, followup: true, resumable: true, deletable: false, terminal: false, releases: false,
    retryable: false, resume: false, waiting: true, liveness: false, catalog: true,
    watchdog: false, planSettled: false,
  }),
  waiting_auth: Object.freeze({
    active: true, followup: true, resumable: true, deletable: false, terminal: false, releases: false,
    retryable: false, resume: false, waiting: true, liveness: false, catalog: true,
    watchdog: false, planSettled: false,
  }),
  delivered: Object.freeze({
    active: true, followup: true, resumable: true, deletable: false, terminal: false, releases: false,
    retryable: false, resume: false, waiting: false, liveness: false, catalog: false,
    watchdog: false, planSettled: true,
  }),
  // done：`resume:true` 表达「存在续跑入口」，行级白名单只认 close_reason='timeout'（见 src/resume.js）。
  done: Object.freeze({
    active: false, followup: false, resumable: false, deletable: true, terminal: true, releases: true,
    retryable: false, resume: true, waiting: false, liveness: false, catalog: false,
    watchdog: false, planSettled: true,
  }),
  failed: Object.freeze({
    active: false, followup: false, resumable: false, deletable: true, terminal: false, releases: true,
    retryable: true, resume: true, waiting: false, liveness: false, catalog: false,
    watchdog: false, planSettled: true,
  }),
  cancelled: Object.freeze({
    active: false, followup: false, resumable: false, deletable: true, terminal: true, releases: true,
    retryable: false, resume: false, waiting: false, liveness: false, catalog: false,
    watchdog: false, planSettled: true,
  }),
  orphaned: Object.freeze({
    active: false, followup: false, resumable: false, deletable: true, terminal: true, releases: true,
    retryable: true, resume: true, waiting: false, liveness: false, catalog: false,
    watchdog: false, planSettled: true,
  }),
})

/** 能力字段清单（派生集合与测试都按它遍历，加字段时一处生效）。 */
export const CAP_KEYS = Object.freeze([
  'active', 'followup', 'resumable', 'deletable', 'terminal', 'releases',
  'retryable', 'resume', 'waiting', 'liveness', 'catalog', 'watchdog', 'planSettled',
])

const capsOf = status => STATUS_CAPS[status]

/** 某状态是否具备某项能力；未知状态一律 false（不抛错：状态可能来自旧台账/手写配置）。 */
export function hasCap(status, cap) {
  const caps = capsOf(String(status ?? ''))
  return caps === undefined ? false : caps[cap] === true
}

/** 按能力反查状态列表（顺序与 STATUSES 一致，便于快照/断言稳定）。 */
export const statusesWith = cap => STATUSES.filter(status => hasCap(status, cap))

/**
 * 唯一状态转移表。
 *
 * 与 0.19.x 的差异（审计 §2.3.3：删掉三条从未可达的边，别再让测试保护死代码）：
 * - `running → done`：0.14.0 引入 delivered 后交付主路径改成 `running → delivered`，此后
 *   **无调用点**（唯一 `transition(…,'done')` 在 `delivered.js`，前置 `status==='delivered'`）。
 *   保留它等于允许「跳过确认直接收终态」——与两段式终态的设计相反。删除只影响**未来的**迁移，
 *   不改任何存量行（台账里的历史 `running` 行不会因为删边而变化）；重放/核对历史数据时如需
 *   模拟「直接完成」，走 `running → delivered → done` 两步即可。
 * - `orphaned → pending`：`deps.js` 只从 `waiting_dep` 晋升；会话丢失的出口是续跑或重派（新任务）。
 *
 * v0.24（resume）重开三条边，**只给 `task_message({ action:'resume' })` 用**：`failed → running`、
 * `orphaned → running`（失败/重启收尾但子会话仍 durable，冷恢复接着跑）、`done → running`（仅限
 * `close_reason='timeout'`；行级白名单在 src/resume.js 的 resumeGate，转移表表达不了行级条件）。
 * 这不是「复活」：retry 才是新任务；resume 是同一 task_id 的同一子会话继续，`attempts`/`resume_count` 自增。
 */
export const TRANSITIONS = Object.freeze({
  waiting_dep: Object.freeze(['pending', 'failed', 'cancelled']),
  pending: Object.freeze(['running', 'failed', 'cancelled']),
  running: Object.freeze(['waiting_user', 'waiting_auth', 'delivered', 'failed', 'cancelled', 'orphaned']),
  waiting_user: Object.freeze(['running', 'cancelled', 'failed', 'orphaned']),
  waiting_auth: Object.freeze(['running', 'cancelled', 'failed', 'orphaned']),
  // delivered → done：协调者确认或超时；delivered → running：task_message 追问；其余是停止/会话丢失。
  delivered: Object.freeze(['running', 'done', 'cancelled', 'orphaned']),
  // failed → running 只给 resume（原会话续跑），failed → cancelled 是收尾；done → running 还多一道
  // close_reason='timeout' 的行级白名单（见文件头注释）。
  failed: Object.freeze(['cancelled', 'running']),
  done: Object.freeze(['running']),
  cancelled: Object.freeze([]),
  orphaned: Object.freeze(['cancelled', 'running']),
})

export function canTransition(from, to) {
  if (!STATUSES.includes(from) || !STATUSES.includes(to)) return false
  return TRANSITIONS[from].includes(to)
}

export function nextStatus(from, to) {
  if (!canTransition(from, to)) throw new Error(`不允许的状态迁移：${from} → ${to}`)
  return to
}

/** 目标状态的全部入边来源（测试与文档核对用：能查出「某状态还有没有入边」）。 */
export const sourcesOf = to => STATUSES.filter(from => canTransition(from, to))

