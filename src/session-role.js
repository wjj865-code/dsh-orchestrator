// 任务入口可见性判定（宿主侧）：会话头「☰ 任务」只在协调者/主会话显示。
//
// 信号是**主会话台账 id**：`settings.main_session_id`（配置 `coordinatorSession` 覆盖），
// 由 index.js 的 `coordinatorStatus()` 读出，和 `task_*` 工具、通知投递用的是同一个信号，
// 不额外引入「标题」「预设名」这类可漂移的判据。
//
// 降级（fail-closed）：任一侧不是非空字符串（尚未打开主会话、客户端没带 sessionId、
// 宿主状态暂不可用）都返回 false —— 入口默认隐藏。侧栏「◈ 主会话」跳转入口不经过本判定，
// 始终可见，避免「主会话没建 → 入口也没了」的引导死锁。
export const isMainSession = (sessionId, mainSessionId) => (
  typeof sessionId === 'string' && sessionId !== ''
  && typeof mainSessionId === 'string' && mainSessionId !== ''
  && sessionId === mainSessionId
)
