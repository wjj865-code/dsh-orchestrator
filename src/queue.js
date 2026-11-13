// 派发队列：平台不排队（满了抛 ACTIVATION_LIMIT_REACHED），插件自己排。
// 单锁串行：同一时刻只有一个 pump 在跑；spawn 成功 / 子会话结算 / 任务终态都会唤醒。
import {
  briefText, clearQueued, countPending, getTask, listPendingQueue, markQueued, transition,
} from './ledger.js'

export function createQueue({ db, dispatcher, config = {}, logger, retryDelaysMs = [2000, 5000, 10000, 30000] }) {
  const log = (event, fields) => {
    try { logger?.log?.(event, fields) } catch { /* 日志不能打断派发 */ }
  }
  const ids = []
  let pumpPromise = null
  let stopped = false
  let attempt = 0
  let timer = null
  // pump 是异步派发，不能复用 task_create 那次工具调用的 signal（回合结束会被 abort）。
  const abort = new AbortController()

  const position = id => {
    const index = ids.indexOf(id)
    return index === -1 ? 0 : index + 1
  }
  const enqueue = id => {
    if (!ids.includes(id)) ids.push(id)
  }
  const remove = id => {
    const index = ids.indexOf(id)
    if (index !== -1) ids.splice(index, 1)
  }
  const schedule = delay => {
    if (stopped) return
    clearTimeout(timer)
    timer = setTimeout(() => { timer = null; pump() }, delay)
    timer.unref?.()
  }
  // 容量满了 / 协调者还没加载：都算可重试，任务留在队列里，别标 failed。
  const retryable = error => error?.code === 'ACTIVATION_LIMIT_REACHED'
    || /未找到协调者会话/.test(error?.message ?? '')

  async function pump() {
    if (stopped) return
    // 单锁：已有 pump 在跑时，新调用等同一个 promise，避免并发 create 各自提前返回导致漏派。
    if (pumpPromise !== null) return pumpPromise
    pumpPromise = runPump().finally(() => { pumpPromise = null })
    return pumpPromise
  }

  async function runPump() {
    let dispatched = 0
    try {
      while (ids.length > 0 && !stopped) {
        const id = ids[0]
        const task = getTask(db, id)
        if (task === undefined || task.status !== 'pending' || task.session_id !== null) {
          ids.shift()
          continue
        }
        const rendered = briefText(db, id) ?? `【任务】${task.title}\n目标：${task.goal}`
        try {
          const member = await dispatcher.spawn({
            name: dispatcher.slug?.(task.title) ?? task.title,
            label: task.title,
            prompt: rendered,
            signal: abort.signal,
            taskId: id,
          })
          const sessionId = member.sessionId ?? member.id
          const target = member.target ?? member.name
          clearQueued(db, id)
          transition(db, id, 'running', { sessionId, target })
          log('task.spawn.ok', { taskId: id, sessionId, detail: { target } })
          ids.shift()
          dispatched += 1
          attempt = 0
        } catch (error) {
          if (retryable(error)) {
            markQueued(db, id)
            log('task.spawn.blocked', {
              taskId: id,
              detail: { reason: error?.message ?? String(error), queued: ids.length },
            })
            const delay = retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)]
            attempt += 1
            schedule(delay)
            return
          }
          ids.shift()
          const reason = error?.message ?? String(error)
          const message = /^未找到协调者会话/.test(reason) ? reason : `子会话创建失败：${reason}`
          log('task.spawn.failed', { taskId: id, detail: { error: reason } })
          transition(db, id, 'failed', { error: message })
        }
      }
      if (dispatched > 0) log('task.queue.drained', { detail: { dispatched } })
    } catch (error) {
      // runPump 自身异常（台账写失败等）不能把插件带崩，也不能卡住队列。
      log('task.queue.error', { detail: { error: error?.message ?? String(error) } })
    }
  }

  async function enqueueAndPump(id) {
    enqueue(id)
    await pump()
    return { task: getTask(db, id), position: position(id) }
  }

  /** 启动恢复：把 pending 且没有子会话的任务放进内存队列（是否立刻 pump 由调用方决定）。 */
  function load() {
    for (const task of listPendingQueue(db)) enqueue(task.id)
  }

  function stop() {
    stopped = true
    clearTimeout(timer)
    ids.length = 0
    try { abort.abort() } catch { /* 卸载期 abort 失败不阻断 */ }
  }

  return {
    enqueue,
    enqueueAndPump,
    remove,
    position,
    pump,
    load,
    stop,
    size: () => ids.length,
    pendingCount: () => countPending(db),
  }
}
