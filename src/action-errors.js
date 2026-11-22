// 动作错误唯一口径：面板动作（stop/retry/message）与工具层（task_message 的 action: stop/retry/close）
// 共用同一套 code、门控语义和文案函数，避免两个通道各说一套。
//
// - 面板：失败结果 { ok:false, code, error }；HTTP 状态由 code 映射（host-route）。
// - 工具层：保持历史「返回可读字符串」的契约，文本也从这里渲染。
// - 新增错误码时同时补 panel/tool 文案（按通道使用的可只写一个），并在
//   test/action-errors.test.js 断言 code 唯一、状态合法、两个通道取词不抛错。
const define = ({ http = 400, panel, tool }) => Object.freeze({ http, panel, tool })

/**
 * 派发层拒绝码：写域判定不许授予时可写根**不注册**、消息**不外发**。
 * 三个入口共用（`dispatch.spawn` / `dispatch.send` / `queue.pump` preflight），
 * 由 `src/write-gate.js` 的 `decideDispatchGrant` 产出；不是面板/工具错误码，所以不进下表。
 */
export const WRITE_DOMAIN_DENIED = 'WRITE_DOMAIN_DENIED'

export const ACTION_ERRORS = Object.freeze({
  // 台账 / 任务
  // 版本 B《ID 出口网关》：错误文案**不回声入参**——面板 toast 与工具回执都是用户面出口，
  // 把入参里的 `t-xxxx` 拼回来等于自己泄漏（回显编号是 0.19.x 的老行为，这次一并去掉）。
  TASK_NOT_FOUND: define({
    http: 404,
    panel: () => '找不到这个任务（可能已被删除或面板数据过期），刷新面板再试。',
    tool: ({ hint = '' }) => `找不到这个任务引用。${hint}`,
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
  // P0-3：交付过的任务写根已释放，追问会让原会话重新开工；目录/写域正被别人占着就拒绝（工具/面板同源）。
  MESSAGE_WRITE_CONFLICT: define({
    http: 409,
    panel: ({ label, reason }) => `未把消息追给任务「${label}」：${reason}`,
    tool: ({ label, reason }) => `未把消息追给任务「${label}」：${reason}`,
  }),
  // P0-2：续跑 / 重派也走同一次写域判定（以前这两条各自绕过，两个子会话能同时写同一份工作树）。
  RESUME_WRITE_CONFLICT: define({
    http: 409,
    panel: ({ label, reason }) => `未续跑任务「${label}」：${reason}`,
    tool: ({ label, reason }) => `未续跑任务「${label}」（状态、死因、续跑次数都没变）：${reason}`,
  }),
  RETRY_WRITE_CONFLICT: define({
    http: 409,
    panel: ({ label, reason }) => `未重派任务「${label}」（没有新建任务）：${reason}`,
    tool: ({ label, reason }) => `未重派任务「${label}」——台账没有新增任务：${reason}`,
  }),
  // 计划批准后**下一次续派才切沙箱**（B 语义）：切不回来就不投递、不留消息行，任务仍是 approved 可重试。
  PLAN_APPROVE_WRITE_CONFLICT: define({
    http: 409,
    panel: ({ label, reason }) => `未续派任务「${label}」：计划已批准，但沙箱这次没切回可写（可重试）。${reason}`,
    tool: ({ label, reason }) => `未把消息追给任务「${label}」：计划已是「已批准执行」（可重试），但沙箱这次没切回可写——投递已取消、没有写入消息行。${reason}`,
  }),
  MESSAGE_UNREACHABLE: define({
    http: 502,
    tool: ({ label, reason }) => `续派失败：任务「${label}」的子会话已不可达，已标「会话丢失」，可重建。原因：${reason}`,
  }),
  // resume（v0.24：续跑原会话 —— 同一 task_id、同一子会话冷恢复，不是新任务）
  RESUME_NOT_ALLOWED: define({
    http: 409, panel: ({ label, statusLabel }) => `任务「${label}」当前是${statusLabel}，只有失败 / 会话丢失（或超时自动完成）的任务能续跑；在跑的用「追加」，跑偏了用「重派（新会话）」。`,
    tool: ({ label, statusLabel }) => `任务「${label}」当前是${statusLabel}，只有失败 / 会话丢失（或超时自动完成）的任务能续跑；在跑的用 task_message，跑偏了用 task_message({ action: 'retry' }) 新开一条。`,
  }),
  RESUME_CLOSED: define({
    http: 409, panel: ({ label, closeReason }) => `任务「${label}」是确认完成（${closeReason}），不能续跑；要接着改请重派新任务，并把上次产物路径带上。`,
    tool: ({ label, closeReason }) => `任务「${label}」是确认完成（${closeReason}），不能续跑；要接着改请 task_message({ action: 'retry' }) 重派，或在 brief 里带上上次产物路径。`,
  }),
  RESUME_NO_SESSION: define({
    http: 409, panel: ({ label }) => `任务「${label}」还没有子会话（派发前就失败了），没有可续跑的会话；请用「重派（新会话）」。`,
    tool: ({ label }) => `任务「${label}」还没有子会话（派发前就失败了），没有可续跑的会话；请用 task_message({ action: 'retry' })。`,
  }),
  RESUME_CHECKOUT_CLEANED: define({
    http: 409, panel: ({ label }) => `任务「${label}」的隔离检出已清理，原会话写不进去；请用「重派（新会话）」，插件会按原基线重建检出。`,
    tool: ({ label }) => `任务「${label}」的隔离检出已清理，原会话写不进去；请用 task_message({ action: 'retry' })（按原基线重建检出）。`,
  }),
  RESUME_UNREACHABLE: define({
    http: 502, panel: ({ reason }) => `续跑失败：子会话不可达（不能冷恢复），未新建任务。原因：${reason}`,
    tool: ({ label, reason }) => `续跑失败：任务「${label}」的子会话不可达（不能冷恢复）。**没有自动新建任务**——确认要重来请用 task_message({ action: 'retry' })。原因：${reason}`,
  }),
  RESUME_DELIVERY_FAILED: define({
    http: 502, panel: ({ reason }) => `续跑投递失败（已重试 3 次），任务状态未变、未新建任务。原因：${reason}`,
    tool: ({ label, reason }) => `续跑投递失败：任务「${label}」状态未变、**未新建任务**（已重试 3 次；可再续跑一次，或改用 task_message({ action: 'retry' })）。原因：${reason}`,
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
  // P0-4 显式计划批准（task_message action:'approve'）：只有工具通道（面板刻意没有批准入口）。
  // 拒绝时不动沙箱、不写审计；文案要能直接告诉协调者「下一步等什么 / 该换哪个动作」。
  PLAN_APPROVE_NOT_PLAN: define({
    http: 409,
    tool: ({ label }) => `任务「${label}」不是计划任务（planFirst），没有计划可批准；要推进直接 task_message 续派，要新活请 task_create。`,
  }),
  PLAN_APPROVE_NOT_WAITING: define({
    http: 409,
    tool: ({ label, detail }) => `任务「${label}」现在不能批准：${detail}。`,
  }),
  PLAN_APPROVE_NO_BLOCKED: define({
    http: 409,
    tool: ({ label }) => `任务「${label}」还没交回计划（plan_state=planning，子会话仍在只读探索）：等它 task_report blocked 上报摘要 + 计划文档路径后再批准。`,
  }),
  PLAN_APPROVE_NO_PLAN_PATH: define({
    http: 409,
    tool: ({ label }) => `任务「${label}」还没有落盘的计划文档（plan_path 为空）：让子会话先 plan_save 把计划写进 reports/plans/，再批准。`,
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
  // 工作台 v1（P11）：组元数据 / 计划日 / 自动化。全部只服务面板端点，不暴露成工具。
  GROUP_NOT_FOUND: define({
    http: 404,
    panel: ({ groupId }) => `没有组 ${groupId ?? ''}：组来自 task_create({ group })，工作台不直接造任务。`,
  }),
  GROUP_NAME_INVALID: define({
    http: 400,
    panel: ({ reason }) => `组名不可用：${reason ?? '需要 1–40 个字'}`,
  }),
  GROUP_NAME_TAKEN: define({
    http: 409,
    panel: ({ name }) => `已经有一个组叫「${name ?? ''}」，换个名字再试。`,
  }),
  GROUP_CONFLICT: define({
    http: 409,
    panel: () => '这个组刚被别处改过：刷新后再改一次（不会静默覆盖）。',
  }),
  GROUP_ARCHIVED: define({
    http: 409,
    panel: ({ groupId }) => `组 ${groupId ?? ''} 已归档：先取消归档再改。`,
  }),
  GROUP_NOT_CONFIRMED: define({
    http: 409,
    panel: () => '归档需要二次确认：请勾选确认后再提交。',
  }),
  PLAN_TASK_NOT_FOUND: define({
    http: 404,
    panel: ({ taskId }) => `没有任务 ${taskId ?? ''}，无法排期。`,
  }),
  PLAN_TASK_ENDED: define({
    http: 409,
    panel: ({ label, statusLabel }) => `任务「${label}」已经结束（${statusLabel}），排期只对活跃/待确认任务有意义。`,
  }),
  PLAN_TIME_INVALID: define({
    http: 400,
    panel: ({ reason }) => `排期时间不可用：${reason ?? '需要 ISO 时间或 null（清除排期）'}`,
  }),
  AUTOMATION_UNAVAILABLE: define({
    http: 502,
    panel: () => '宿主没有可用的自动化（schedule）服务：装好 @deepseek-ai/dsh-tool-schedule 并彻底重启 DSH 后再试；现有任务编排不受影响。',
  }),
  AUTOMATION_TARGET_INVALID: define({
    http: 409,
    panel: () => '自动化只能投递到唯一主会话（this_session）：先打开主会话再建。',
  }),
  AUTOMATION_TIMING_INVALID: define({
    http: 400,
    panel: ({ reason }) => `触发时间不可用：${reason ?? '支持 每天/每周/自定义 cron'}`,
  }),
  AUTOMATION_CONFLICT: define({
    http: 409,
    panel: () => '这条自动化刚被别处改过（或宿主侧已变更）：刷新后再改，不会强行覆盖。',
  }),
  AUTOMATION_NOT_FOUND: define({
    http: 404,
    panel: ({ id }) => `没有这条自动化 ${id ?? ''}。`,
  }),
  AUTOMATION_NOT_CONFIRMED: define({
    http: 409,
    panel: () => '创建/修改/删除自动化需要你明确授权：请勾选确认后再提交。',
  }),
  AUTOMATION_FAILED: define({
    http: 502,
    panel: ({ reason }) => `宿主拒绝了这次自动化操作：${reason ?? '未知原因'}`,
  }),
  // host-route（路由层兜底，不是 panel/工具动作本身）
  PANEL_ACTIONS_UNAVAILABLE: define({ http: 500, panel: () => 'panel-actions-unavailable' }),
  ACTION_FAILED: define({ http: 500, panel: ({ reason }) => `动作失败：${reason}` }),
  OPEN_MAIN_UNAVAILABLE: define({ http: 500, panel: () => 'open-main-unavailable' }),
  OPEN_MAIN_FAILED: define({ http: 500, panel: ({ reason }) => `打开主会话失败：${reason}` }),
  // adopt（0.25.0）：把已有会话设为协调者（会话头「设为协调者」按钮）。只切指针，不归档旧会话。
  ADOPT_UNAVAILABLE: define({ http: 500, panel: () => '缺少「设为协调者」实现（插件装配不完整）' }),
  ADOPT_NO_SESSION: define({ http: 409, panel: () => '会话不存在或还没加载：请先打开那个会话再试。' }),
  ADOPT_NOT_COCKPIT: define({
    http: 409,
    panel: ({ cwd, workspace }) => `只能把「指挥舱」工作区里的会话设为协调者（指挥舱：${workspace ?? '未知'}；该会话目录：${cwd ?? '未知'}）。`,
  }),
  ADOPT_NOT_LIVE: define({
    http: 409,
    panel: () => '该会话还没加载（agent 未起）：先在它里面发一条消息，然后再点「设为协调者」。',
  }),
  ADOPT_PRESET_LOCKED: define({
    http: 409,
    panel: ({ preset, reason }) => `该会话已经用其他预设开始（${preset ?? '未知'}），宿主不允许中途换预设：`
      + `请新建一个空白会话并选「协调者」预设，再设为协调者。${reason === undefined ? '' : `（${reason}）`}`,
  }),
  ADOPT_BUSY: define({ http: 409, panel: () => '另一次「设为协调者」正在进行，请稍后再试。' }),
  ADOPT_FAILED: define({ http: 500, panel: ({ reason }) => `切换协调者失败：${reason ?? '未知原因'}` }),
  ADOPT_CREATE_FAILED: define({
    http: 502,
    panel: ({ reason }) => `新建协调者会话失败（原协调者保持不变）：${reason ?? '未知原因'}`,
  }),
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
