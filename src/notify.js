// 通知分级：progress **默认送达**（同任务合并 + 水位节流；追问后的第一条必达），done 批量合并，
// blocked/needs_auth 立即打断。cancelled/orphaned 来自结算自动上报（S1）：异常收场，按 notify 合并窗口提醒。
//
// progress 为什么不再 silent（0.25.x）：它是「任务还在跑」的协调信号——协调者据此决定 task_message
// 追问同一子会话 / resume，而不是重派新任务。静默时「追问 → 子会话先报部分结论 → 继续跑」这条
// 最需要被看见的路径对主会话永久不可见（t-1f70bedb：追问后子会话回了 [progress]，主会话 0 消息，
// 15 分钟后只有看门狗）。一条都不送会刷屏，所以按「合并窗口 + 同任务水位 + 尾沿补投」送达：
// 见 levelOf('progress') 与 createNotifier 的 pushCoalesced。
//
// 产物 → 交付（P6）：通知里只列「present 能接住」的绝对路径，并明确要求协调者在自己回合里交付。
// 判据与平台一致（reports/t0.1-probes.md §3.3 + D6/D7）：present 用 lstat 判 type，目录 / 符号链接 /
// 不存在一律被拒；平台单次硬上限 8，本插件按「1-4 个最关键的、最多 4 个」收敛成产品上限。
import { deliverableOf as artifactKindOf } from './artifact-location.js'
// P1-C 文案单源：交付指令与 task_detail / 文档 / 协调者 policy 共用 src/copy.js 的句子。
import { ADVANCE_NOTICE_HINT, DELIVERED_HINT, DELIVERY_LINES, PENDING_DECISION_NOTICE, PROGRESS_NOTICE_HINT } from './copy.js'

export { DELIVERED_HINT, ADVANCE_NOTICE_HINT }

const LEVEL = {
  // coalesce：默认送达 + 同任务合并/节流（progress）。与 notify 的区别只是「有水位、可被后续同类合并」。
  progress: 'coalesce', done: 'notify', delivered: 'notify', blocked: 'interrupt', needs_auth: 'interrupt',
  failed: 'notify', stalled: 'notify', cancelled: 'notify', orphaned: 'notify',
}

const DONE_LABEL = {
  failed: '失败', stalled: '可能卡住', cancelled: '已取消', orphaned: '会话已结束但没有终态回报',
  done: '完成', delivered: DELIVERY_LINES.state, progress: '有新进展',
}

export function levelOf(status) {
  return LEVEL[status] ?? 'silent'
}

/** present 单次调用的产品上限（平台硬上限 8：reports/t0.1-probes.md D6）。 */
const PRESENT_MAX_FILES = 4

/**
 * 完成通知的合并窗口（毫秒）。P2-2 起**固定**：配置键 `mergeWindowMs` 已删除——
 * 5 秒是 UX 阈值（同批任务合并成一条消息），不是需要现场调参的策略。
 */
export const NOTIFY_MERGE_WINDOW_MS = 5000

/**
 * 合并窗口的生效值：生产恒为 {@link NOTIFY_MERGE_WINDOW_MS}。
 *
 * 唯一的旁路是环境变量 `DSH_ORCH_NOTIFY_MERGE_MS`（单测/冒烟用）：观察「合并后的一条消息」
 * 不必真等 5 秒。它**只调窗口、不改语义**，也不进插件配置面（配置键已删，不再有用户可调项）。
 */
export function notifyMergeWindowMs(env = process.env) {
  const raw = Number(env?.DSH_ORCH_NOTIFY_MERGE_MS)
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : NOTIFY_MERGE_WINDOW_MS
}

/**
 * 同任务 progress 的**水位**（毫秒）：窗口内同一任务最多单独送一条，被压住的只留最新一条，
 * 到水位线再补投（trailing edge）——既不会把长任务的每条心跳都变成一次唤醒，也不会漏掉
 * 「任务最后到哪了」。60 秒的依据：一次真实追问的往返通常以分钟计；比它更密的 progress
 * 对协调者没有新信息（同一回合内的多条 progress 本来就在 5 秒合并窗口里并成一条）。
 *
 * 与 `NOTIFY_MERGE_WINDOW_MS` 一样**固定**、不进插件配置面（不是需要现场调参的策略）；
 * 单测/冒烟用环境变量 `DSH_ORCH_PROGRESS_MS` 只调窗口、不改语义。
 */
export const NOTIFY_PROGRESS_WATERMARK_MS = 60_000

/** 水位生效值：生产恒为 {@link NOTIFY_PROGRESS_WATERMARK_MS}，只有测试环境变量旁路。 */
export function notifyProgressWatermarkMs(env = process.env) {
  const raw = Number(env?.DSH_ORCH_PROGRESS_MS)
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : NOTIFY_PROGRESS_WATERMARK_MS
}

/**
 * coalesce（progress）被合并/节流的审计原因。每一条 progress 都会在 `notifications` 里留下**一行**
 * （delivered 或 skipped + 原因）：排查「主会话为什么没收到这条」时不必再靠猜（旧口径 silent 连行都不写）。
 */
const COALESCE_REASON = {
  /** 同任务水位内压住，尾沿补投最新一条。 */
  watermark: 'progress_watermark',
  /** 5 秒合并窗口内同一任务的第二条 progress 覆盖了前一条（同一件事的重复汇报）。 */
  merge: 'progress_merged',
  /** 同任务的 done/blocked 等已在队列里：旧 progress 被取代（同一批里既列「有新进展」又列「完成」是噪音）。 */
  superseded: 'progress_superseded',
}

/** 非交付项的分类文案：告诉模型「为什么这条没进交付候选」。 */
const SKIP_LABEL = {
  directory: '目录',
  symlink: '符号链接',
  missing: '不存在',
  relative: '非绝对路径',
  other: '不是普通文件',
}

// present 先 lstat 判 type、再 stat 判存在（dsh-tool-present/src/index.ts:88-93）：
// 只有「存在的普通文件」能交付；目录、符号链接、缺失的路径都会让整次 present 失败。
// 判定在 src/artifact-location.js 的 deliverableOf：与 read_workspace 的产物判定同一模块，
// 否则「能不能交付」和「能不能读」会各写一份类型表（审计 §2.5 指出的三套口径）。
const classifyPath = artifactKindOf

/**
 * 把 item.artifacts 拆成「可交付的普通文件」与「跳过原因计数」。
 * 按路径去重（同一文件被显式回报和自动收集各报一次时只列一条）。
 */
const deliverableOf = item => {
  const artifacts = Array.isArray(item.artifacts) ? item.artifacts : []
  const files = []
  const seen = new Set()
  const skipped = new Map()
  for (const entry of artifacts) {
    if (entry === null || entry === undefined || typeof entry !== 'object') continue
    const path = typeof entry.path === 'string' ? entry.path.trim() : ''
    const kind = classifyPath(path)
    if (kind !== 'file') {
      skipped.set(kind, (skipped.get(kind) ?? 0) + 1)
      continue
    }
    if (seen.has(path)) continue
    seen.add(path)
    files.push({ path, label: typeof entry.label === 'string' ? entry.label.trim() : '' })
  }
  return { files, skipped }
}

const artifactRow = entry => `- ${entry.path}${entry.label ? ` — ${entry.label}` : ''}`

const skipLine = skipped => {
  const entries = [...skipped.entries()]
  if (entries.length === 0) return ''
  const total = entries.reduce((sum, [, count]) => sum + count, 0)
  const parts = entries.map(([kind, count]) => `${SKIP_LABEL[kind] ?? kind} ${count}`)
  return `另有 ${total} 条产物不能交付（${parts.join('、')}）`
}

// 指令写进通知文案（不是系统提示）：插件不代调 present（它要求 open turn，见 T0.1 探针 ③），
// 只负责把「已 stat 校验过存在、是普通文件」的绝对路径交到协调者手上并说清怎么交付。
export const PRESENT_HINT = '交付：在你自己的回合里调用 present，files 里每项 path 填上面这些绝对路径（它们都是**已登记的产物**；1-4 个最关键的，最多 4 个）；插件已 stat 校验存在且是普通文件，不要另找路径，也不要临时拼别的路径。'

/**
 * 产物区块的行（通知与 task_status 共用同一份渲染，避免两处清单口径漂移：风险 R17）。
 * 返回不带缩进的行；`[]` 表示没有产物（调用方不要渲染区块）。
 * @param {object} item 含 artifacts / artifactsTruncated 的条目（台账行也满足）
 * @param {{hint?: boolean, counts?: boolean}} options
 *   hint=false：多任务合并通知里交付指令只在整条消息末尾写一次；
 *   counts=true：首行带总条数 / 可交付条数（task_status 用，通知里保持短语）。
 */
export function artifactLines(item, { hint = true, counts = false } = {}) {
  const artifacts = Array.isArray(item.artifacts) ? item.artifacts : []
  if (artifacts.length === 0) return []
  const { files, skipped } = deliverableOf(item)
  const shown = files.slice(0, PRESENT_MAX_FILES)
  const truncated = typeof item.artifactsTruncated === 'number' && Number.isFinite(item.artifactsTruncated)
    ? Math.max(0, Math.trunc(item.artifactsTruncated))
    : 0
  // 折叠数 = 超上限的候选 + 台账层截断（artifactsTruncated 是根本没进 item.artifacts 的条数）。
  const hidden = files.length - shown.length + truncated
  const lines = []
  if (shown.length > 0) {
    lines.push(counts ? `产物：共 ${artifacts.length} 条（可交付 ${files.length} 条）` : '产物：')
    lines.push(...shown.map(artifactRow))
  } else {
    lines.push(counts ? `产物：共 ${artifacts.length} 条，没有可直接交付的普通文件` : '产物：没有可直接交付的普通文件')
  }
  if (hidden > 0) lines.push(`另有 ${hidden} 条产物未列出`)
  const skippedText = skipLine(skipped)
  if (skippedText !== '') lines.push(skippedText)
  if (shown.length > 0 && hint) lines.push(PRESENT_HINT)
  return lines
}

/**
 * 产物区块（通知用）：两空格缩进挂在任务行下面。
 * @param {object} item 通知条目（artifacts / artifactsTruncated）
 * @param {{hint?: boolean}} options hint=false 用于多条任务合并的通知：只在整条消息末尾写一次交付指令。
 */
const artifactBlock = (item, { hint = true } = {}) => {
  const lines = artifactLines(item, { hint })
  return lines.length === 0 ? '' : `\n  ${lines.join('\n  ')}`
}

const hasDeliverable = item => deliverableOf(item).files.length > 0

/**
 * blocked 的 question 里点一下待拍板项数（子会话按 W1 的指引以「待拍板：」开头逐条列）。
 *
 * 这是通知文案的**粗算**，不是文档解析、也不是格式校验：没有「待拍板」标记就返回 0，
 * 普通 blocked 不会被误标；有标记但没有 `- ` 条目也不硬凑数字。
 */
const pendingCountOf = question => {
  const index = question.indexOf('待拍板')
  if (index === -1) return 0
  return (question.slice(index).match(/^\s*[-*+]\s+\S/gm) ?? []).length
}

const questionBlock = item => {
  const question = typeof item.question === 'string' && item.question.trim() !== '' ? item.question.trim() : ''
  const options = Array.isArray(item.options) ? item.options.filter(Boolean) : []
  if (question === '' && options.length === 0) return ''
  const parts = []
  if (question !== '') parts.push(`\n  问题：${question}`)
  if (options.length > 0) parts.push(`\n  选项：${options.join(' / ')}`)
  // 拍板流程（版本 A，只改文案）：通知里盯住提问方式，避免协调者把多项合成一个总批准。
  const pending = pendingCountOf(question)
  if (pending > 0) parts.push(`\n  ${PENDING_DECISION_NOTICE(pending)}`)
  return parts.join('')
}

// P9：隔离任务的通知必须写明「产物在检出目录里，合并由你决定」——
// 否则用户会以为文件已经落在自己的工作树（这是本阶段最大的产品级风险，R9/R10）。
const worktreeBlock = item => {
  const worktree = item?.worktree
  if (worktree === null || worktree === undefined) return ''
  const state = worktree.state
  if (state === 'created' || state === 'reused' || state === 'cleaned') {
    const branch = typeof worktree.branch === 'string' && worktree.branch !== '' ? worktree.branch : '未知'
    const path = typeof worktree.path === 'string' && worktree.path !== '' ? worktree.path : '未知'
    return `\n  隔离：产物在分支 ${branch} 的检出目录 ${path}，合并到你当前分支由你决定`
  }
  if (state === 'degraded') return '\n  隔离：未隔离（目标不是 git 仓库，已降级）；产物落在当前工作树'
  if (state === 'failed') return `\n  隔离：创建失败（${worktree.error ?? '未知原因'}）`
  return ''
}

// 显示名由 tools 算好放进 item.displayName（重名短后缀也在那里算）；没有就回落 title。
// 权限在通知标题里明确标出来：只读（不会写文件）/ 完整访问（沙箱不拦写，破坏了可能更大）。
const nameOf = item => {
  const base = item.displayName ?? item.title
  if (item.readOnly === true) return `${base}（只读）`
  if (item.access === 'full') return `${base}（完整访问）`
  return base
}
// progress 是一档独立语义：没有产物、没有交付确认、也没有「等你决定」的问题，只有「还在跑 + 到哪了」。
// 追问后的第一条额外标「回答你的追问」——否则协调者会把它当成又一次心跳，追问等于没问。
const PROGRESS_LABEL = '有新进展'
const PROGRESS_ANSWERED_LABEL = `${PROGRESS_LABEL}（回答你的追问）`
const progressLabel = item => (item.answeredFollowup === true ? PROGRESS_ANSWERED_LABEL : PROGRESS_LABEL)
const isProgress = item => item.status === 'progress'
// 合并通知里每条任务只列产物；交付指令在整条消息末尾写一次（避免 N 条任务刷 N 遍指令）。
const line = item => (isProgress(item)
  ? `- ${nameOf(item)}（${progressLabel(item)}）：${item.summary}`
  : `- ${nameOf(item)}：${item.summary}${questionBlock(item)}${worktreeBlock(item)}${artifactBlock(item, { hint: false })}`)
const batchHint = batch => (batch.some(hasDeliverable) ? `\n  ${PRESENT_HINT}` : '')
// progress 的动作指令：告诉协调者这是信号、出口是追问同一子会话（文案本体在 src/copy.js）。
const progressHint = batch => (batch.some(isProgress) ? `\n  ${PROGRESS_NOTICE_HINT}` : '')

// 两段式终态（delivered）：交付通知必须带动作指令，否则协调者只会转述「完成了」，
// 也会忘了 task_message 追问能复用原会话（用户随后只能新派任务）。
// 默认口径是「保持待确认、别急着关」（0.14.x 起）：关闭要用户明确确认，或等超时。
// 文案本体在 src/copy.js（DELIVERED_HINT），本文件只负责把它贴进通知。
// 交付确认的动作指令：`task_id` 换成**任务的引用**（tk-xxxxxx），不把裸编号喂给协调者
// （否则它会原样抄进给用户的回复——版本 B《ID 出口网关》的根因）。
const deliveredBlock = item => item?.status === 'delivered'
  ? `\n  交付确认：${DELIVERED_HINT.replace('<任务引用>', String(item.ref ?? ''))}`
  : ''
const deliveredBatchHint = batch => (batch.some(item => item.status === 'delivered')
  ? `\n  ${DELIVERED_HINT}`
  : '')

// 推进循环（用户反馈「报告后只汇报、不推进」）：done/delivered/blocked/needs_auth 的通知末尾
// 各贴一次动作指令，避免只讲状态、不讲下一步。progress 有自己的追问指令（PROGRESS_NOTICE_HINT），
// 不重复贴；结算异常（failed/cancelled/orphaned）由 L1 推进循环约束，通知只报事实。
// 文案本体在 src/copy.js（ADVANCE_NOTICE_HINT），与 L1 的「推进循环」段逐字同源。
const ADVANCE_STATUSES = new Set(['done', 'delivered', 'blocked', 'needs_auth'])
const advanceHint = batch => (batch.some(item => ADVANCE_STATUSES.has(item.status))
  ? `\n  ${ADVANCE_NOTICE_HINT}`
  : '')

export function createNotifier({
  send,
  record = () => {},
  mergeWindowMs = notifyMergeWindowMs(),
  progressWatermarkMs = notifyProgressWatermarkMs(),
  onWarn = () => {},
  onEvent = () => {},
}) {
  let buffer = []
  let timer = null
  // 同任务 progress 水位（进程内）：taskId → 最近一次尝试投递的时刻。
  // 不落库是有意的——进程重启后第一条 progress 会立刻送，正是重启后最需要的那条状态。
  const progressWatermark = new Map()
  // 水位内被压住的 progress：taskId → { item, deadline }；只留最新一条，到点补投。
  const progressPending = new Map()
  let progressTimer = null

  const emit = (event, item, detail = {}) => {
    try {
      onEvent(event, {
        taskId: item.taskId,
        sessionId: item.sender?.id,
        detail: { level: levelOf(item.status), ...detail },
      })
    } catch { /* 日志事件不能打断通知 */ }
  }

  const recordOne = (item, status, mergedInto = null, reason = null) => {
    try {
      return record({
        taskId: item.taskId,
        level: levelOf(item.status),
        status,
        deliveredAt: status === 'delivered' ? Date.now() : null,
        mergedInto,
        reason,
      })
    } catch (error) {
      onWarn(`通知记录失败：${error?.message ?? error}`)
      return undefined
    }
  }

  const recordDelivered = items => {
    let firstId
    for (const item of items) {
      const id = recordOne(item, 'delivered', firstId ?? null)
      emit('notify.delivered', item, { mergedInto: firstId ?? null, notificationId: id })
      if (firstId === undefined) firstId = id
    }
  }
  const recordSkipped = (items, reason = null) => {
    for (const item of items) {
      recordOne(item, 'skipped', null, reason)
      emit('notify.skipped', item, { reason })
    }
  }
  // coalesce 的审计：压住/覆盖也是**一次明确的决定**，必须留一行（旧口径 silent 连行都不写，
  // 「主会话为什么没收到」只能靠猜）。status 用 skipped + reason 区分原因。
  const recordCoalesced = (item, reason) => {
    recordOne(item, 'skipped', null, reason)
    emit('notify.coalesced', item, { reason })
  }
  const recordFailed = (items, error) => {
    const reason = error?.message ?? String(error)
    for (const item of items) {
      recordOne(item, 'failed', null, reason)
      emit('notify.failed', item, { reason })
    }
    onWarn(`通知投递失败：${reason}`)
  }

  // send 可以是同步注入（index.js 直接 steer 协调者），也可以是异步通道（测试/其他实现）。
  // 返回投递结果（同步 send 同步返回，异步 send 返回 Promise），汇总上报靠它决定要不要保留待发。
  const deliver = (text, items) => {
    let result
    try {
      result = send(text, items)
    } catch (error) {
      const reason = error?.message ?? String(error)
      recordFailed(items, error)
      return { delivered: false, reason }
    }
    if (result !== null && typeof result?.then === 'function') {
      // 回调里的落库/告警也可能抛错；这里兜底，避免 `void deliver(...)` 变成未处理拒绝。
      return result.then(
        value => {
          if (value === false) { recordSkipped(items); return { delivered: false, reason: null } }
          if (value?.skipped === true) {
            recordSkipped(items, value.reason ?? null)
            return { delivered: false, reason: value.reason ?? null }
          }
          recordDelivered(items)
          return { delivered: true }
        },
        error => {
          recordFailed(items, error)
          return { delivered: false, reason: error?.message ?? String(error) }
        },
      ).catch(error => {
        try { onWarn(`通知收尾失败：${error?.message ?? error}`) } catch { /* 告警失败也不能外溢 */ }
        return { delivered: false, reason: error?.message ?? String(error) }
      })
    }
    if (result === false) { recordSkipped(items); return { delivered: false, reason: null } }
    if (result?.skipped === true) {
      recordSkipped(items, result.reason ?? null)
      return { delivered: false, reason: result.reason ?? null }
    }
    recordDelivered(items)
    return { delivered: true }
  }

  // —— coalesce（progress）的小状态机：buffer（5 秒合并窗口） + progressPending（水位尾沿） ——

  /** 进合并窗口；同任务窗口内的第二条 progress 覆盖前一条（只留最新摘要），被覆盖的留审计行。 */
  const bufferize = item => {
    if (!isProgress(item)) {
      // 终态/等待类回报到了，同一任务积压的 progress 已过时：别再尾沿补投一条旧状态；
      // 已在合并窗口里的旧 progress 也撤掉，避免同一条消息里同任务既「有新进展」又「完成」。
      progressPending.delete(item.taskId)
      for (let index = buffer.length - 1; index >= 0; index -= 1) {
        if (buffer[index].taskId === item.taskId && isProgress(buffer[index])) {
          recordCoalesced(buffer[index], COALESCE_REASON.superseded)
          buffer.splice(index, 1)
        }
      }
    }
    const existing = isProgress(item)
      ? buffer.findIndex(entry => entry.taskId === item.taskId && isProgress(entry))
      : -1
    if (existing === -1) {
      buffer.push(item)
    } else {
      recordCoalesced(buffer[existing], COALESCE_REASON.merge)
      buffer[existing] = item
    }
    if (timer === null) timer = setTimeout(() => { void flush() }, mergeWindowMs)
  }

  const nextProgressDeadline = () => {
    let min = Infinity
    for (const entry of progressPending.values()) min = Math.min(min, entry.deadline)
    return min
  }

  const scheduleProgressRelease = () => {
    if (progressTimer !== null) { clearTimeout(progressTimer); progressTimer = null }
    const deadline = nextProgressDeadline()
    if (!Number.isFinite(deadline)) return
    progressTimer = setTimeout(() => {
      progressTimer = null
      if (releasePendingProgress() > 0) void flush()
      scheduleProgressRelease()
    }, Math.max(0, deadline - Date.now()) + 1)
    // 不 unref 的话，一条等 60 秒的 progress 水位会把进程（以及测试进程）挂住：
    // 水位只是节流手段，不是「有活儿没干完」的信号——进程该退出时就退出，积压由 drain/flushNow 兜。
    progressTimer.unref?.()
  }

  /** 把到点的（或 `force` 时全部）待发 progress 放进合并窗口；返回释放条数。 */
  const releasePendingProgress = ({ force = false } = {}) => {
    const now = Date.now()
    let released = 0
    for (const [taskId, entry] of [...progressPending]) {
      if (!force && entry.deadline > now) continue
      progressPending.delete(taskId)
      bufferize(entry.item)
      released += 1
    }
    return released
  }

  /**
   * progress 的三条出路（顺序即优先级）：
   * 1. 追问必达：台账 `report_expected_at` 置位后的第一条回报（协调者刚追问/续跑过）→ 立刻送，
   *    不看水位、不等合并窗口。这一条是「追问石沉大海」的正面解答。
   * 2. 首条 / 已过水位 → 进 5 秒合并窗口（同批任务的 progress 并成一条）。
   * 3. 水位内 → 只留最新一条，到水位线补投；被压住的这一条写 `skipped + progress_watermark`。
   */
  const pushCoalesced = item => {
    if (item.answeredFollowup === true) {
      // 追问的答案比水位重要：它已经把积压的旧 progress 覆盖掉，还应该立刻送。
      progressPending.delete(item.taskId)
      bufferize(item)
      if (timer !== null) { clearTimeout(timer); timer = null }
      void flush()
      return
    }
    const now = Date.now()
    const last = progressWatermark.get(item.taskId)
    if (last === undefined || now - last >= progressWatermarkMs) {
      bufferize(item)
      return
    }
    progressPending.set(item.taskId, { item, deadline: last + progressWatermarkMs })
    recordCoalesced(item, COALESCE_REASON.watermark)
    scheduleProgressRelease()
  }

  const flush = () => {
    // 尾沿补投/卸载路径会先 bufferize 再立刻 flush：这里把刚排上的合并定时器收掉，不留悬空定时器。
    if (timer !== null) clearTimeout(timer)
    timer = null
    const batch = buffer
    buffer = []
    if (batch.length === 0) return undefined
    const label = status => DONE_LABEL[status] ?? '完成'
    const labelOfItem = item => (isProgress(item) ? progressLabel(item) : label(item.status))
    // progress 没有产物交付/隔离/问题语义，只报「还在跑 + 到哪了」，别把中间文件写成交付候选。
    const detailOf = item => (isProgress(item)
      ? ''
      : `${questionBlock(item)}${worktreeBlock(item)}${artifactBlock(item)}${deliveredBlock(item)}`)
    const allDone = batch.every(item => item.status === 'done')
    const allProgress = batch.every(isProgress)
    const allSettled = batch.every(item => item.status === 'done' || item.status === 'delivered')
    const text = batch.length === 1
      ? `任务「${nameOf(batch[0])}」${labelOfItem(batch[0])}：${batch[0].summary}${detailOf(batch[0])}${progressHint(batch)}${advanceHint(batch)}`
      : `${batch.length} 个任务${allDone ? '完成' : (allProgress ? PROGRESS_LABEL : (allSettled ? DELIVERY_LINES.state : '状态更新'))}：\n${batch.map(line).join('\n')}${batchHint(batch)}${deliveredBatchHint(batch)}${progressHint(batch)}${advanceHint(batch)}`
    // 水位按「尝试投递时刻」先记：异步 send 期间到达的同任务 progress 不该再单独送一条。
    // 投递没成功（skipped/failed）就撤回——否则一次「主会话没打开」会把接下来的 progress 也压住。
    const startedAt = Date.now()
    const progressItems = batch.filter(isProgress)
    if (progressItems.length > 0) {
      for (const item of progressItems) progressWatermark.set(item.taskId, startedAt)
    }
    const settleWatermark = outcome => {
      if (outcome?.delivered === true) return outcome
      for (const item of progressItems) {
        if (progressWatermark.get(item.taskId) === startedAt) progressWatermark.delete(item.taskId)
      }
      return outcome
    }
    const result = deliver(text, batch)
    if (result !== null && typeof result?.then === 'function') return result.then(settleWatermark)
    return settleWatermark(result)
  }

  return {
    push(item) {
      const level = levelOf(item.status)
      if (level === 'silent') return
      if (level === 'interrupt') {
        // 打断级（blocked / needs_auth）：问题必须当场回答 → 文案末尾直接带推进循环的动作指令。
        void deliver(`任务「${nameOf(item)}」需要你：${item.summary}${questionBlock(item)}${worktreeBlock(item)}${artifactBlock(item)}${advanceHint([item])}`, [item])
        return
      }
      if (level === 'coalesce') {
        pushCoalesced(item)
        return
      }
      bufferize(item)
    },
    /**
     * 汇总通知（启动对账等）：多条任务共用一条文案、只投递一次，notifications 仍按任务逐条落库。
     * 返回 { delivered, reason }（异步通道返回 Promise）；调用方据此决定是否保留待发。
     */
    summary(items, text) {
      const list = (Array.isArray(items) ? items : []).filter(item => item !== null && typeof item === 'object')
      const body = typeof text === 'string' ? text : ''
      if (list.length === 0 || body.trim() === '') return { delivered: false, reason: 'empty' }
      return deliver(body, list)
    },
    async drain() {
      if (timer !== null) clearTimeout(timer)
      if (progressTimer !== null) { clearTimeout(progressTimer); progressTimer = null }
      // 卸载/测试收尾时把水位里压着的 progress 一并送掉：进程都要走了，节流没有意义。
      releasePendingProgress({ force: true })
      await flush()
    },
    /** 卸载用：同步 flush；sync send 时通知与落库都在本调用内完成。 */
    flushNow() {
      if (timer !== null) clearTimeout(timer)
      if (progressTimer !== null) { clearTimeout(progressTimer); progressTimer = null }
      releasePendingProgress({ force: true })
      return flush()
    },
  }
}
