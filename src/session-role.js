// 任务入口可见性判定（宿主侧）：会话头「☰ 任务」只在协调者会话显示。
//
// 信号是**协调者名单**：`settings.main_session_ids`（配置 `coordinatorSession` 覆盖成单元素），
// 由 index.js 的 `coordinatorStatus()` 读出，和 `task_*` 工具、通知投递用的是同一个信号，
// 不额外引入「标题」「预设名」这类可漂移的判据。
//
// 0.36.0（多协调者）：判定从「当前会话 === 台账主会话」改成「当前会话 ∈ 名单」——名单首位仍是
// 主协调者（决定「打开主会话」、日报、通知兜底），但**每个成员都是协调者**：一个「任务」入口、
// 同一份 `task_*` 权限、同样钉 read-only。
//
// 降级（fail-closed）：任一侧不是非空字符串 / 名单为空 / 不是成员（含宿主状态暂不可用）都返回
// false —— 入口默认隐藏。侧栏「◈ 主会话」跳转入口不经过本判定，始终可见，避免
// 「主会话没建 → 入口也没了」的引导死锁。
export const isCoordinator = (sessionId, coordinatorIds) => {
  if (typeof sessionId !== 'string' || sessionId === '') return false
  if (!Array.isArray(coordinatorIds) || coordinatorIds.length === 0) return false
  return coordinatorIds.some(id => typeof id === 'string' && id !== '' && id === sessionId)
}

/**
 * 单值兼容别名（0.25.0 的旧口径：只有一个主会话）。
 * 新代码请用 `isCoordinator`；保留它只为旧调用方/旧测试不炸，语义等价于「名单只有这一个成员」。
 */
export const isMainSession = (sessionId, mainSessionId) => (
  typeof sessionId === 'string' && sessionId !== ''
  && typeof mainSessionId === 'string' && mainSessionId !== ''
  && sessionId === mainSessionId
)
