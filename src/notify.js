// 通知分级：progress 静默，done 批量合并，blocked/needs_auth 立即打断。
// cancelled/orphaned 来自结算自动上报（S1）：异常收场，按 notify 合并窗口提醒。
//
// 产物 → 交付（P6）：通知里只列「present 能接住」的绝对路径，并明确要求协调者在自己回合里交付。
// 判据与平台一致（reports/t0.1-probes.md §3.3 + D6/D7）：present 用 lstat 判 type，目录 / 符号链接 /
// 不存在一律被拒；平台单次硬上限 8，本插件按「1-2 个最关键的、最多 4 个」收敛成产品上限。
import { lstatSync } from 'node:fs'
import { isAbsolute } from 'node:path'

const LEVEL = {
  progress: 'silent', done: 'notify', delivered: 'notify', blocked: 'interrupt', needs_auth: 'interrupt',
  failed: 'notify', stalled: 'notify', cancelled: 'notify', orphaned: 'notify',
}

const DONE_LABEL = {
  failed: '失败', stalled: '可能卡住', cancelled: '已取消', orphaned: '会话已结束但没有终态回报',
  done: '完成', delivered: '已交付待确认',
}

export function levelOf(status) {
  return LEVEL[status] ?? 'silent'
}

/** present 单次调用的产品上限（平台硬上限 8：reports/t0.1-probes.md D6）。 */
const PRESENT_MAX_FILES = 4

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
const classifyPath = path => {
  if (typeof path !== 'string' || path.trim() === '') return 'other'
  if (!isAbsolute(path)) return 'relative'
  let stats
  try {
    stats = lstatSync(path)
  } catch (error) {
    return error?.code === 'ENOENT' ? 'missing' : 'other'
  }
  if (stats.isFile()) return 'file'
  if (stats.isSymbolicLink()) return 'symlink'
  if (stats.isDirectory()) return 'directory'
  return 'other'
}

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
const PRESENT_HINT = '交付：在你自己的回合里调用 present，files 里每项 path 填上面这些绝对路径（1-2 个最关键的，最多 4 个）；插件已 stat 校验存在且是普通文件，不要另找路径。'

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

const questionBlock = item => {
  const question = typeof item.question === 'string' && item.question.trim() !== '' ? item.question.trim() : ''
  const options = Array.isArray(item.options) ? item.options.filter(Boolean) : []
  if (question === '' && options.length === 0) return ''
  const parts = []
  if (question !== '') parts.push(`\n  问题：${question}`)
  if (options.length > 0) parts.push(`\n  选项：${options.join(' / ')}`)
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
// 合并通知里每条任务只列产物；交付指令在整条消息末尾写一次（避免 N 条任务刷 N 遍指令）。
const line = item => `- ${nameOf(item)}：${item.summary}${questionBlock(item)}${worktreeBlock(item)}${artifactBlock(item, { hint: false })}`
const batchHint = batch => (batch.some(hasDeliverable) ? `\n  ${PRESENT_HINT}` : '')

// 两段式终态（delivered）：交付通知必须带动作指令，否则协调者只会转述「完成了」，
// 既不会 task_close 确认、也不会想到 task_message 追问能复用原会话（用户随后只能新派任务）。
const DELIVERED_HINT = '确认：task_close <任务编号>；要改：task_message 追问原会话（不新建任务）；不确认则按超时自动完成。'
const deliveredBlock = item => item?.status === 'delivered'
  ? `\n  交付确认：${DELIVERED_HINT.replace('<任务编号>', String(item.taskId ?? ''))}`
  : ''
const deliveredBatchHint = batch => (batch.some(item => item.status === 'delivered')
  ? `\n  ${DELIVERED_HINT}`
  : '')

export function createNotifier({ send, record = () => {}, mergeWindowMs = 5000, onWarn = () => {}, onEvent = () => {} }) {
  let buffer = []
  let timer = null

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

  const flush = () => {
    timer = null
    const batch = buffer
    buffer = []
    if (batch.length === 0) return undefined
    const label = status => DONE_LABEL[status] ?? '完成'
    const allDone = batch.every(item => item.status === 'done')
    const allSettled = batch.every(item => item.status === 'done' || item.status === 'delivered')
    const text = batch.length === 1
      ? `任务「${nameOf(batch[0])}」${label(batch[0].status)}：${batch[0].summary}${questionBlock(batch[0])}${worktreeBlock(batch[0])}${artifactBlock(batch[0])}${deliveredBlock(batch[0])}`
      : `${batch.length} 个任务${allDone ? '完成' : (allSettled ? '已交付待确认' : '状态更新')}：\n${batch.map(line).join('\n')}${batchHint(batch)}${deliveredBatchHint(batch)}`
    return deliver(text, batch)
  }

  return {
    push(item) {
      const level = levelOf(item.status)
      if (level === 'silent') return
      if (level === 'interrupt') {
        void deliver(`任务「${nameOf(item)}」需要你：${item.summary}${questionBlock(item)}${worktreeBlock(item)}${artifactBlock(item)}`, [item])
        return
      }
      buffer.push(item)
      if (timer === null) timer = setTimeout(() => { void flush() }, mergeWindowMs)
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
      await flush()
    },
    /** 卸载用：同步 flush；sync send 时通知与落库都在本调用内完成。 */
    flushNow() {
      if (timer !== null) clearTimeout(timer)
      return flush()
    },
  }
}
