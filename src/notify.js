// 通知分级：progress 静默，done 批量合并，blocked/needs_auth 立即打断。
const LEVEL = { progress: 'silent', done: 'notify', blocked: 'interrupt', needs_auth: 'interrupt' }

export function levelOf(status) {
  return LEVEL[status] ?? 'silent'
}

const line = item => `- ${item.title}：${item.summary}`

export function createNotifier({ send, record = () => {}, mergeWindowMs = 5000, onWarn = () => {} }) {
  let buffer = []
  let timer = null

  const recordOne = (item, status, mergedInto = null) => {
    try {
      return record({
        taskId: item.taskId,
        level: levelOf(item.status),
        status,
        deliveredAt: status === 'delivered' ? Date.now() : null,
        mergedInto,
      })
    } catch (error) {
      onWarn(`通知记录失败：${error?.message ?? error}`)
      return undefined
    }
  }

  const deliver = async (text, items) => {
    try {
      await send(text, items)
      let firstId
      for (const item of items) {
        const id = recordOne(item, 'delivered', firstId ?? null)
        if (firstId === undefined) firstId = id
      }
    } catch (error) {
      for (const item of items) recordOne(item, 'failed')
      onWarn(`通知投递失败：${error?.message ?? error}`)
    }
  }

  const flush = async () => {
    timer = null
    const batch = buffer
    buffer = []
    if (batch.length === 0) return
    const text = batch.length === 1
      ? `任务「${batch[0].title}」完成：${batch[0].summary}`
      : `${batch.length} 个任务完成：\n${batch.map(line).join('\n')}`
    await deliver(text, batch)
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
  }
}
