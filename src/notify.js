// 通知分级：progress 静默，done 批量合并，blocked/needs_auth 立即打断。
// cancelled/orphaned 来自结算自动上报（S1）：异常收场，按 notify 合并窗口提醒。
const LEVEL = {
  progress: 'silent', done: 'notify', blocked: 'interrupt', needs_auth: 'interrupt',
  failed: 'notify', stalled: 'notify', cancelled: 'notify', orphaned: 'notify',
}

const DONE_LABEL = {
  failed: '失败', stalled: '可能卡住', cancelled: '已取消', orphaned: '会话已结束但没有终态回报', done: '完成',
}

export function levelOf(status) {
  return LEVEL[status] ?? 'silent'
}

const artifactBlock = item => {
  const artifacts = Array.isArray(item.artifacts) ? item.artifacts : []
  if (artifacts.length === 0) return ''
  const rows = artifacts.map(entry =>
    `  - ${entry.path}${entry.label ? ` — ${entry.label}` : ''}${entry.exists === false ? '（未找到）' : ''}`)
  const truncated = typeof item.artifactsTruncated === 'number' && item.artifactsTruncated > 0
    ? `\n  另有 ${item.artifactsTruncated} 条产物未列出`
    : ''
  return `\n  产物：\n${rows.join('\n')}${truncated}`
}

const questionBlock = item => {
  const question = typeof item.question === 'string' && item.question.trim() !== '' ? item.question.trim() : ''
  const options = Array.isArray(item.options) ? item.options.filter(Boolean) : []
  if (question === '' && options.length === 0) return ''
  const parts = []
  if (question !== '') parts.push(`\n  问题：${question}`)
  if (options.length > 0) parts.push(`\n  选项：${options.join(' / ')}`)
  return parts.join('')
}

// 显示名由 tools 算好放进 item.displayName（重名短后缀也在那里算）；没有就回落 title。
// 只读任务在通知标题里明确标「只读」，避免用户误以为它会写文件。
const nameOf = item => {
  const base = item.displayName ?? item.title
  return item.readOnly === true ? `${base}（只读）` : base
}
const line = item => `- ${nameOf(item)}：${item.summary}${questionBlock(item)}${artifactBlock(item)}`

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
    const text = batch.length === 1
      ? `任务「${nameOf(batch[0])}」${label(batch[0].status)}：${batch[0].summary}${questionBlock(batch[0])}${artifactBlock(batch[0])}`
      : `${batch.length} 个任务${batch.every(item => item.status === 'done') ? '完成' : '状态更新'}：\n${batch.map(line).join('\n')}`
    return deliver(text, batch)
  }

  return {
    push(item) {
      const level = levelOf(item.status)
      if (level === 'silent') return
      if (level === 'interrupt') {
        void deliver(`任务「${nameOf(item)}」需要你：${item.summary}${questionBlock(item)}${artifactBlock(item)}`, [item])
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
