// 通知分级：progress 静默，done 批量合并，blocked/needs_auth 立即打断。
const LEVEL = { progress: 'silent', done: 'notify', blocked: 'interrupt', needs_auth: 'interrupt' }

export function levelOf(status) {
  return LEVEL[status] ?? 'silent'
}

const line = item => `- ${item.title}：${item.summary}`

export function createNotifier({ send, record = () => {}, mergeWindowMs = 5000, onWarn = () => {} }) {
  let buffer = []
  let timer = null

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
      if (firstId === undefined) firstId = id
    }
  }
  const recordSkipped = items => { for (const item of items) recordOne(item, 'skipped') }
  const recordFailed = (items, error) => {
    const reason = error?.message ?? String(error)
    for (const item of items) recordOne(item, 'failed', null, reason)
    onWarn(`通知投递失败：${reason}`)
  }

  // send 可以是同步注入（index.js 直接 steer 协调者），也可以是异步通道（测试/其他实现）。
  const deliver = (text, items) => {
    let result
    try {
      result = send(text, items)
    } catch (error) {
      recordFailed(items, error)
      return undefined
    }
    if (result !== null && typeof result?.then === 'function') {
      return result.then(
        value => { if (value === false) recordSkipped(items); else recordDelivered(items) },
        error => recordFailed(items, error),
      )
    }
    if (result === false) { recordSkipped(items); return undefined }
    recordDelivered(items)
    return undefined
  }

  const flush = () => {
    timer = null
    const batch = buffer
    buffer = []
    if (batch.length === 0) return undefined
    const text = batch.length === 1
      ? `任务「${batch[0].title}」完成：${batch[0].summary}`
      : `${batch.length} 个任务完成：\n${batch.map(line).join('\n')}`
    return deliver(text, batch)
  }

  return {
    push(item) {
      const level = levelOf(item.status)
      if (level === 'silent') return
      if (level === 'interrupt') {
        void deliver(`任务「${item.title}」需要你：${item.summary}`, [item])
        return
      }
      buffer.push(item)
      if (timer === null) timer = setTimeout(() => { void flush() }, mergeWindowMs)
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
