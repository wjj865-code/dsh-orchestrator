// 动作错误唯一口径：面板动作（stop/retry/message）与工具层（task_message 的 action: stop/retry/close）
// 共用同一套 code、门控语义和文案函数，避免两个通道各说一套。
//
// - 面板：失败结果 { ok:false, code, error }；HTTP 状态由 code 映射（host-route）。
// - 工具层：保持历史「返回可读字符串」的契约，文本也从这里渲染。
// - 新增错误码时同时补 panel/tool 文案（按通道使用的可只写一个），并在
//   test/action-errors.test.js 断言 code 唯一、状态合法、两个通道取词不抛错。
const define = ({ http = 400, panel, tool }) => Object.freeze({ http, panel, tool })

export const ACTION_ERRORS = Object.freeze({
  // 台账 / 任务
  TASK_NOT_FOUND: define({
    http: 404,
    panel: ({ taskId }) => `没有任务 ${taskId ?? ''}`,
    tool: ({ taskId, hint = '' }) => `没有任务 ${taskId ?? ''}。${hint}`,
  }),
  STOP_TASK_ENDED: define({
    http: 409,
    panel: ({ label, statusLabel }) => `任务「${label}」已结束（${statusLabel}），无需停止。`,
    tool: ({ label, statusLabel }) => `任务「${label}」已结束（${statusLabel}），无需停止。`,
  }),
  STOP_FAILED: define({
    http: 500,
    panel: ({ reason }) => `停止失败：${reason}`,
  }),
  // retry
  RETRY_NOT_ALLOWED: define({
    http: 409,
    panel: ({ label, statusLabel }) => `任务「${label}」当前是${statusLabel}，只有失败或会话丢失的任务能重派；在跑的任务用 task_message，排队中的用 task_message({ action: 'stop' }) 取消后重建。`,
    tool: ({ label, statusLabel }) => `任务「${label}」当前是${statusLabel}，只有失败或会话丢失的任务能重派；在跑的任务用 task_message，排队中的用 task_message({ action: 'stop' }) 取消后重建。`,
  }),
  RETRY_DUPLICATE_ACTIVE: define({
    http: 409,
    panel: ({ label, statusLabel }) => `已存在活跃任务「${label}」（${statusLabel}），未重复重派。`,
    tool: ({ label, statusLabel }) => `已存在活跃任务「${label}」（${statusLabel}），未重复重派。`,
  }),
  RETRY_DEPENDS_INVALID: define({
    http: 409,
    panel: ({ reason }) => `不能重派：${reason}。`,
    tool: ({ reason }) => `不能重派：${reason}。`,
  }),
  MAIN_SESSION_UNAVAILABLE: define({
    http: 409,
    panel: () => '主会话已失效，请从面板「打开主会话」重建。',
    tool: () => '主会话已失效，请从面板「打开主会话」重建。',
  }),
  RETRY_FAILED: define({
    http: 500,
    panel: ({ reason }) => String(reason ?? '') || '子会话创建失败',
    tool: ({ reason }) => String(reason ?? '') || '子会话创建失败',
  }),
  // message
  MESSAGE_EMPTY: define({
    http: 400,
    panel: () => '消息不能为空',
  }),
  MESSAGE_TASK_ENDED: define({
    http: 409,
    panel: ({ label, statusLabel }) => `任务「${label}」已结束（${statusLabel}），不能续派；需要新工作请 task_create。`,
    tool: ({ label, statusLabel }) => `任务「${label}」已结束（${statusLabel}），不能续派；需要新工作请 task_create。`,
  }),
  MESSAGE_WAITING_DEP: define({
    http: 409,
    panel: ({ label, depends }) => `任务「${label}」还在等待前置任务（${depends}），依赖完成后会派发，暂不能续派；要取消用 task_message({ action: 'stop' })。`,
    tool: ({ label, depends }) => `任务「${label}」还在等待前置任务（${depends}），依赖完成后会派发，暂不能续派；要取消用 task_message({ action: 'stop' })。`,
  }),
  MESSAGE_QUEUED: define({
    http: 409,
    tool: ({ label, ahead }) => `任务「${label}」正在排队（前面还有 ${ahead} 个），轮到时自动派发，暂不能续派。`,
  }),
  MESSAGE_NO_SESSION: define({
    http: 409,
    panel: ({ label }) => `任务「${label}」还没有子会话，先停止再重建。`,
    tool: ({ label }) => `任务「${label}」还没有子会话，先停止再重建。`,
  }),
  // 失败任务：能重派，但不再续派（旧面板既能「追加」又能「重派」，语义重复且容易把消息投进死会话）。
  MESSAGE_NOT_FOLLOWABLE: define({
    http: 409,
    panel: ({ label, statusLabel }) => `任务「${label}」当前是${statusLabel}，不能续派；失败任务用「重派」按原 brief 新起一条，要新工作请 task_create。`,
    tool: ({ label, statusLabel }) => `任务「${label}」当前是${statusLabel}，不能续派；失败任务用 task_message({ action: 'retry' }) 按原 brief 新起一条，要新工作请 task_create。`,
  }),
  MESSAGE_DELIVERY_FAILED: define({
    http: 502,
    panel: ({ reason }) => `续派失败：${reason}`,
    tool: ({ label, reason }) => `续派失败：任务「${label}」已转为「等你确认」（已重试 3 次）。原因：${reason}`,
  }),
  MESSAGE_UNREACHABLE: define({
    http: 502,
    tool: ({ label, reason }) => `续派失败：任务「${label}」的子会话已不可达，已标「会话丢失」，可重建。原因：${reason}`,
  }),
  // close（两段式终态的确认）：只有 delivered（已交付待确认）能收成 done。
  CLOSE_TASK_ENDED: define({
    http: 409,
    panel: ({ label, statusLabel }) => `任务「${label}」已结束（${statusLabel}），无需确认。`,
    tool: ({ label, statusLabel }) => `任务「${label}」已结束（${statusLabel}），无需确认。`,
  }),
  CLOSE_NOT_DELIVERED: define({
    http: 409,
    panel: ({ label, statusLabel }) => `任务「${label}」当前是${statusLabel}，只有「待确认」的任务能确认完成；在跑的先等它交付，卡住的用「追加」续派或「停止」取消。`,
    tool: ({ label, statusLabel }) => `任务「${label}」当前是${statusLabel}，只有「待确认」的任务能确认完成；在跑的先等它交付，卡住的用 task_message 续派或 task_message({ action: 'stop' }) 取消。`,
  }),
  // delete：只允许删终态任务；活跃的还有子会话/队列占位，先停止。
  DELETE_TASK_ACTIVE: define({
    http: 409,
    panel: ({ label, statusLabel }) => `任务「${label}」还在${statusLabel}，不能删除；先「停止」再删。`,
    tool: ({ label, statusLabel }) => `任务「${label}」还在${statusLabel}，不能删除；先 task_message({ action: 'stop' }) 再删。`,
  }),
  DELETE_HAS_ACTIVE_DEPENDENTS: define({
    http: 409,
    panel: ({ label, links }) => `还有活跃任务依赖「${label}」（${links}），删了会让它们变成缺前置；先处理下游再删。`,
    tool: ({ label, links }) => `还有活跃任务依赖「${label}」（${links}），删了会让它们变成缺前置；先处理下游再删。`,
  }),
  // artifacts 预览
  ARTIFACT_NOT_FOUND: define({
    http: 404,
    panel: ({ path }) => `这条任务的产物里没有 ${path ?? ''}`,
  }),
  ARTIFACT_MISSING: define({
    http: 404,
    panel: ({ path }) => `产物文件不存在：${path ?? ''}`,
  }),
  ARTIFACT_NOT_FILE: define({
    http: 400,
    panel: ({ path }) => `只能预览普通文件：${path ?? ''}`,
  }),
  ARTIFACT_READ_FAILED: define({
    http: 500,
    panel: ({ reason }) => `读取产物失败：${reason ?? ''}`,
  }),
  // host-route（路由层兜底，不是 panel/工具动作本身）
  PANEL_ACTIONS_UNAVAILABLE: define({ http: 500, panel: () => 'panel-actions-unavailable' }),
  ACTION_FAILED: define({ http: 500, panel: ({ reason }) => `动作失败：${reason}` }),
  OPEN_MAIN_UNAVAILABLE: define({ http: 500, panel: () => 'open-main-unavailable' }),
  OPEN_MAIN_FAILED: define({ http: 500, panel: ({ reason }) => `打开主会话失败：${reason}` }),
  UNKNOWN_ENDPOINT: define({ http: 400, panel: () => 'unknown-endpoint' }),
  // 非阻断警告：stop 已成功，但收子会话/队列/写权限释放失败（只在面板 warnings 里出现）
  STOP_DISPATCH_FAILED: define({ http: 200, panel: ({ reason }) => `停止子会话失败：${reason}` }),
  STOP_QUEUE_FAILED: define({ http: 200, panel: ({ reason }) => `停止时更新队列失败：${reason}` }),
  STOP_RELEASE_FAILED: define({ http: 200, panel: ({ reason }) => `释放写权限失败：${reason}` }),
})

/** 按通道渲染错误文案。code 或通道未定义属于编程错误，直接抛，避免静默成 400。 */
export function actionErrorText(channel, code, params = {}) {
  const found = ACTION_ERRORS[code]
  if (found === undefined) throw new Error(`未定义的动作错误码：${code}`)
  const render = found[channel]
  if (typeof render !== 'function') throw new Error(`动作错误码 ${code} 没有 ${channel} 文案`)
  return render(params)
}

/** 面板统一失败结果。 */
export function panelFailure(code, params = {}, extra = {}) {
  return { ok: false, code, error: actionErrorText('panel', code, params), ...extra }
}

/** 工具层保持字符串返回，文案同样来自上表。 */
export function toolFailure(code, params = {}) {
  return actionErrorText('tool', code, params)
}

/** 面板动作结果 → HTTP 状态：成功 200；已知 code 用映射；旧格式（无 code）保持 400。 */
export function panelHttpStatus(result) {
  if (result?.ok === true) return 200
  return ACTION_ERRORS[result?.code]?.http ?? 400
}
