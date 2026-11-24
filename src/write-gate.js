// 写域门面（write-gate）：**动作层只调这里**，不再各自拼 `tasks` / `holds` / `config.sameDirGuard`。
//
// 为什么要有这一层（事故背景：判定散在 create / followup 两处，resume / retry / 追问 await 窗口全绕过）：
// - 判定本体在 `src/write-guard.js`（纯函数），占位原语在 `src/write-hold.js`（内存、不动状态机）；
// - 这里只做三件事：补活跃任务与 hold、补配置档位、把结果翻译成动作层能用的形状；
// - 于是「新增动作忘了拼 tasks/holds」这种漏判**不可能发生**——调用点只需 `decideCreate` / `decideRegrant`。
//
// `WRITE_GRANT_ACTIONS` 是静态断言的登记表（`test/write-gate.test.js`）：任何给任务写权限的动作都必须
// 在这里登记，且对应函数体里必须命中判定调用；新增动作不登记 → 测试红。
import { getTask, listTasks } from './ledger.js'
import {
  DEFAULT_SAME_DIR_GUARD, isolatedConflicts, isolatedTask, checkoutRejection, decideFollowupGuard, decideRegrantGuard,
  decideWriteGuard, downstreamSerializedIds, serializedIdsOf,
} from './write-guard.js'
import { activeWriteHolds, isWriteHeld } from './write-hold.js'
import { WRITE_DOMAIN_DENIED } from './action-errors.js'

export { WRITE_DOMAIN_DENIED, isWriteHeld }

/**
 * 给任务写权限的动作登记表（`file` + 函数名 + 该函数体内必须出现的调用）。
 *
 * - `calls`：函数体必须命中的门面/占位/沙箱调用（`test/write-gate.test.js` 静态断言）；
 * - `marker`：`task_create` 的实现在 `wrap('task_create', …)` 的内联回调里（没有函数名），
 *   所以用 marker 锚定回调起点、用 `calls` 断言它确实走了门面；
 * - **批准（approve）不登记**：批准只记账（`setPlanState` + 审计 + 清问题），不授予写权限；
 *   真正授予发生在下一次续派投递的 post-send（`dispatch.grantApprovedWrite`），那里由
 *   `dispatch.js` 的 `grantWritableRoot` chokepoint 再判一次写域。
 */
export const WRITE_GRANT_ACTIONS = Object.freeze([
  { file: 'src/tools.js', fn: 'messageTask', kind: 'followup', calls: ['decideFollowup', 'holdWriteDomain'] },
  { file: 'src/tools.js', fn: 'resumeTask', kind: 'resume', calls: ['decideRegrant', 'holdWriteDomain'] },
  { file: 'src/tools.js', fn: 'retryTask', kind: 'retry', calls: ['decideCreate'] },
  { file: 'src/tools.js', fn: 'task_create', kind: 'create', calls: ['decideCreate'], marker: "wrap('task_create'" },
  { file: 'src/panel-actions.js', fn: 'message', kind: 'followup', calls: ['decideFollowup', 'acquireWriteHold'] },
  { file: 'src/panel-actions.js', fn: 'retry', kind: 'retry', calls: ['decideCreate'] },
])

const activeTasks = db => listTasks(db, { active: true })

/**
 * 建任务判定（task_create / retry / 面板重派共用）：新任务 vs 活跃任务 + 内存 hold。
 * @returns 同 `decideWriteGuard`
 */
export function decideCreate({
  db,
  target,
  scopes = [],
  dependsOn = [],
  mode = DEFAULT_SAME_DIR_GUARD,
  allowConcurrent = false,
  skipChecks = false,
  holds = activeWriteHolds(),
} = {}) {
  return decideWriteGuard({
    tasks: activeTasks(db),
    target,
    scopes,
    dependsOn,
    mode,
    allowConcurrent,
    skipChecks,
    holds,
  })
}

/**
 * 「重新拿写根」判定（resume / retry 复用检出 / 派发 chokepoint 共用）。
 * `fallbackTarget`：任务自己没有 target 时的归一目录（动作层传 defaultCwd，派发层传会话 cwd）。
 * @returns 同 `decideRegrantGuard`
 */
export function decideRegrant({ db, task, kind = 'followup', mode = DEFAULT_SAME_DIR_GUARD, holds = activeWriteHolds(), fallbackTarget } = {}) {
  return decideRegrantGuard({ tasks: activeTasks(db), task, mode, kind, holds, fallbackTarget })
}

/**
 * 追问判定（delivered 特例，薄包装 `decideRegrantGuard`）：`task_message` / 面板「追加」共用。
 * @returns 同 `decideFollowupGuard`
 */
export function decideFollowup({ db, task, mode = DEFAULT_SAME_DIR_GUARD, holds = activeWriteHolds(), fallbackTarget } = {}) {
  return decideFollowupGuard({ tasks: activeTasks(db), task, mode, holds, fallbackTarget })
}

/**
 * 派发层 chokepoint 判定：`dispatch.spawn` / `dispatch.send` / `grantApprovedWrite` / `queue.pump` 注入用。
 *
 * 口径（与动作层同源同参数）：
 * - 任务不在台账（非编排会话）/ 只读 / 创建时显式 `allowConcurrent` → 放行（不重复拦）；
 * - **隔离任务**（requested/created/reused）：只看 `worktree_path`，不看 `directory`——它在检出里跑，
 *   原 target 不占；判定与动作层共用 `isolatedConflicts`（同一份检出 / 别人写进我的检出），
 *   dependsOn 上游与下游都靠 `serializedIds` 排除（串行不并发），不会误拒；
 * - 其余走 `decideRegrant`（`fallbackTarget = directory`：无 target 任务按派发 cwd 归一），拒绝就返回
 *   `{ok:false, code, text}`，调用方**不授予**。
 *
 * @param {object} options
 * @param {string} [options.directory] 本次派发/授予真正要写的目录（非 isolated / 无 target fallback 用）
 * @returns {{ok: true} | {ok: false, code: string, text: string}}
 */
export function decideDispatchGrant({ db, taskId, directory, mode = DEFAULT_SAME_DIR_GUARD, holds = activeWriteHolds() } = {}) {
  if (typeof taskId !== 'string' || taskId === '') return { ok: true }
  const task = getTask(db, taskId)
  if (task === undefined) return { ok: true }
  if (task.read_only === true) return { ok: true }
  // 创建时显式 allowConcurrent:true 的任务：允许并发是用户当刻的决定，派发环节不再翻案。
  if (task.brief?.allowConcurrent === true) return { ok: true }
  if (isolatedTask(task)) {
    const tasks = activeTasks(db)
    const serializedIds = new Set([
      ...serializedIdsOf(tasks, Array.isArray(task.depends_on) ? task.depends_on : []),
      ...downstreamSerializedIds(tasks, task.id),
    ])
    const { checkouts, targets } = isolatedConflicts(tasks, {
      checkout: task.worktree_path, excludeId: task.id, serializedIds, holds,
    })
    if (checkouts.length === 0 && targets.length === 0) return { ok: true }
    return {
      ok: false,
      code: WRITE_DOMAIN_DENIED,
      text: checkoutRejection({
        path: task.worktree_path,
        conflicts: [
          ...checkouts,
          ...targets.map(({ task: item, target }) => ({ task: item, path: target })),
        ],
      }),
    }
  }
  const verdict = decideRegrant({ db, task, kind: 'dispatch', mode, holds, fallbackTarget: directory })
  if (verdict.action !== 'reject') return { ok: true }
  return { ok: false, code: WRITE_DOMAIN_DENIED, text: verdict.text }
}
