// worktree 状态的事实源（worktree-facts）：状态全集 + 能力表 + 转移表。
//
// 为什么单独一个叶子模块（不 import 任何东西）：`worktree.js`（宿主侧 git）与
// `worktree-request.js`（结构化映射）本来就互相引用（后者要 `branchNameLooksValid`），
// 能力表若放在其中一边，另一边在模块求值期调用派生函数会撞 TDZ。放在无依赖的叶子里两边都能安全 import。
//
// 语义差异是**有意**的（审计 §2.4 的 7 份列表），字段各自回答一个具体问题，别再合并成一份。

/** 台账 / 工具返回里的隔离状态（`requested` 是派发前的待建状态）。 */
export const WORKTREE_STATES = Object.freeze([
  'none', 'requested', 'created', 'reused', 'degraded', 'rejected', 'failed', 'cleaned',
])

/**
 * worktree 状态 → 能力（唯一事实源，审计 §2.4）。
 *
 * 为什么需要：8 个状态散落在 7 份独立列表里（`write-guard` 的隔离判定、`worktree.js` 的派发建树、
 * `hasCheckout`、列表小标、详情行、通知、重派快照、清理前置），**语义差异是合理的**——
 * 「要不要建树」≠「有没有检出」≠「占不占目录」≠「要不要显示小标」——但没有任何一处文档解释这些差异，
 * 且每次新增状态（degraded/rejected/failed/cleaned 分两批加）都要改 7 个地方。
 * 17.0 的 P1（`requested` 被误当占用目录）就是这种结构问题的第一次爆发（CHANGELOG 0.17.0、b4f0f45）。
 *
 * 字段各自回答一个具体问题：
 *   occupiesTarget —— 占着原 target 目录吗？（同写域并发判定用；`requested` 注定在检出里跑，不占）
 *   needsCreate    —— 派发前要真建检出吗？（`reused` 只需换算 target，`created` 已建好）
 *   hasCheckout    —— 有没有可用的检出目录（有路径、能交付、能清理）？
 *   showsBadge     —— 面板/列表/详情要不要标「隔离」？
 *   retryable      —— 重派时要不要沿用/重建检出？
 *   notifyIsolated —— 通知里要说「产物在检出目录，合并由你决定」吗？
 */
export const WORKTREE_STATE_CAPS = Object.freeze({
  // 不隔离：目标不是 git 仓库或用户/配置没要隔离，仍在原工作树里跑。
  none: Object.freeze({
    occupiesTarget: true, needsCreate: false, hasCheckout: false,
    showsBadge: false, retryable: false, notifyIsolated: false,
  }),
  // 待建检出：派发时才建。此时 target_dir 还没换算成检出目录，但任务**注定**在检出里跑，不占原目录。
  requested: Object.freeze({
    occupiesTarget: false, needsCreate: true, hasCheckout: false,
    showsBadge: false, retryable: false, notifyIsolated: false,
  }),
  // 已隔离：检出已建好，任务在检出里跑。
  created: Object.freeze({
    occupiesTarget: false, needsCreate: false, hasCheckout: true,
    showsBadge: true, retryable: true, notifyIsolated: true,
  }),
  // 复用已有检出：只需换算 target_dir，不调任何 git。
  reused: Object.freeze({
    occupiesTarget: false, needsCreate: false, hasCheckout: true,
    showsBadge: true, retryable: true, notifyIsolated: true,
  }),
  // 降级（目标不是 git 仓库）：**仍在原工作树里写**，所以继续占目录、也不给装依赖提示。
  degraded: Object.freeze({
    occupiesTarget: true, needsCreate: false, hasCheckout: false,
    showsBadge: false, retryable: false, notifyIsolated: false,
  }),
  // 创建期拒绝：没有隔离、也没有检出；派发照常按普通任务跑（调用方决定是否拒绝创建）。
  rejected: Object.freeze({
    occupiesTarget: true, needsCreate: false, hasCheckout: false,
    showsBadge: false, retryable: false, notifyIsolated: false,
  }),
  // 建树失败：任务被标 failed；重派时按原基线重建（检出可能不存在）。
  failed: Object.freeze({
    occupiesTarget: true, needsCreate: false, hasCheckout: false,
    showsBadge: false, retryable: true, notifyIsolated: false,
  }),
  // 检出已清理：路径还在台账里（历史可查），但目录没了；重派时重建。
  cleaned: Object.freeze({
    occupiesTarget: true, needsCreate: false, hasCheckout: true,
    showsBadge: true, retryable: true, notifyIsolated: true,
  }),
})

/** 能力字段清单（派生列表与测试都按它遍历）。 */
export const WORKTREE_CAP_KEYS = Object.freeze([
  'occupiesTarget', 'needsCreate', 'hasCheckout', 'showsBadge', 'retryable', 'notifyIsolated',
])

const trim = value => (typeof value === 'string' ? value.trim() : '')

const worktreeCapsOf = state => WORKTREE_STATE_CAPS[state]

/** 某 worktree 状态是否具备某项能力；未知/缺省状态按 `none` 处理（最保守：占目录、不隔离）。 */
export function worktreeHasCap(state, cap) {
  const key = trim(state) === '' ? 'none' : trim(state)
  const caps = worktreeCapsOf(key)
  return caps === undefined ? WORKTREE_STATE_CAPS.none[cap] === true : caps[cap] === true
}

/** 按能力反查状态列表（顺序与 WORKTREE_STATES 一致）。 */
export const worktreeStatesWith = cap => WORKTREE_STATES.filter(state => worktreeHasCap(state, cap))

/** 按「不具备某能力」反查状态列表（`occupiesTarget:false` = 已隔离）。 */
export const worktreeStatesWithout = cap => WORKTREE_STATES.filter(state => !worktreeHasCap(state, cap))

/**
 * 合法转移（0.19.x **没有任何地方校验** worktree 转移，`setTaskWorktree` 可以写任意值）。
 *
 * 与 `tasks.status` 的 `TRANSITIONS` 同一种做法：非法转移抛错，而不是静默写进去。
 * 语义：`none` 是起点（不隔离）；`requested` 是「已决定隔离、还没建」；`created`/`reused` 是建好了；
 * `degraded`/`rejected` 是「决定隔离但没做成」的两种降级；`failed` 是建树失败；`cleaned` 是收尾。
 */
export const WORKTREE_TRANSITIONS = Object.freeze({
  none: Object.freeze(['requested', 'degraded', 'rejected']),
  requested: Object.freeze(['created', 'reused', 'degraded', 'rejected', 'failed']),
  created: Object.freeze(['cleaned', 'reused', 'failed']),
  reused: Object.freeze(['cleaned', 'created', 'failed']),
  // 降级/拒绝后重派可以重新尝试隔离；也可以直接落失败。
  degraded: Object.freeze(['requested', 'rejected', 'failed']),
  rejected: Object.freeze(['requested', 'degraded', 'failed']),
  failed: Object.freeze(['requested', 'cleaned']),
  cleaned: Object.freeze(['requested']),
})

export function canWorktreeTransition(from, to) {
  const key = trim(from) === '' ? 'none' : trim(from)
  if (!WORKTREE_STATES.includes(key) || !WORKTREE_STATES.includes(to)) return false
  // 同状态重复写入是幂等的（`setTaskWorktree` 多处会重复写同一状态），不算非法转移。
  if (key === to) return true
  return WORKTREE_TRANSITIONS[key].includes(to)
}

export function nextWorktreeState(from, to) {
  if (!canWorktreeTransition(from, to)) throw new Error(`不允许的 worktree 状态迁移：${from ?? '(空)'} → ${to}`)
  return to
}

