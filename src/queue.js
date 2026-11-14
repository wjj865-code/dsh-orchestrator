// 派发队列：平台不排队（满了抛 ACTIVATION_LIMIT_REACHED），插件自己排。
// 单锁串行：同一时刻只有一个 pump 在跑；spawn 成功 / 子会话结算 / 任务终态都会唤醒。
import {
  briefText, clearQueued, countPending, getTask, listPendingQueue, listTasks, markQueued, transition,
} from './ledger.js'
import { taskLabel } from './task-label.js'

export function createQueue({ db, dispatcher, config = {}, logger, notifier, retryDelaysMs = [2000, 5000, 10000, 30000] }) {
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
    || /未找到协调者会话|尚未就绪/.test(error?.message ?? '')

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
        let member
        try {
          member = await dispatcher.spawn({
            name: dispatcher.slug?.(task.title) ?? task.title,
            label: task.title,
            prompt: rendered,
            signal: abort.signal,
            taskId: id,
            cwd: task.target_dir ?? undefined,
            readOnly: task.read_only === true,
          })
        } catch (error) {
          if (retryable(error)) {
            // 容量满：整条队列都算「排队中」，不能只标队首，否则重启时后面的任务会被当派发中断误杀。
            for (const queuedId of [...ids]) {
              const queuedTask = getTask(db, queuedId)
              if (queuedTask !== undefined && queuedTask.status === 'pending') markQueued(db, queuedId)
            }
            log('task.spawn.blocked', {
              taskId: id,
              detail: { reason: error?.message ?? String(error), queued: ids.length },
            })
            const delay = retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)]
            attempt += 1
            schedule(delay)
            return
          }
          remove(id)
          const reason = error?.message ?? String(error)
          const message = /^未找到协调者会话|^协调者会话尚未就绪/.test(reason) ? reason : `子会话创建失败：${reason}`
          const stack = typeof error?.stack === 'string' ? error.stack.split('\n').slice(0, 3).join(' | ') : null
          log('task.spawn.failed', { taskId: id, detail: { error: reason, ...(stack === null ? {} : { stack }) } })
          try {
            transition(db, id, 'failed', { error: message })
          } catch (failure) {
            log('task.spawn.transition-failed', {
              taskId: id,
              detail: { error: failure?.message ?? String(failure) },
            })
          }
          // 终态释放 target 可写根（异常路径也不能留授权）。
          try {
            dispatcher.releaseWritableRoots?.(task.session_id ?? task.target)
          } catch { /* 释放失败不影响失败通知 */ }
          // 失败必须让主会话看见（不能静默 failed）；sender 缺失时由 index 用主会话自身投递。
          notifier?.push({
            taskId: id,
            title: task.title,
            displayName: taskLabel(task, { all: listTasks(db) }),
            readOnly: task.read_only === true,
            status: 'failed',
            summary: message,
            system: true,
          })
          continue
        }

        // spawn 在途时任务可能已被 task_stop/取消：把刚起的子会话收掉，别让它白占一个并发位，
        // 也不能把队列里后面的任务一起 shift 掉（审查 probe-queue-race）。
        const sessionId = member.sessionId ?? member.id
        const target = member.target ?? member.name
        const current = getTask(db, id)
        if (current === undefined || current.status !== 'pending') {
          remove(id)
          try {
            await dispatcher.stop(target)
          } catch (error) {
            log('task.spawn.discarded', { taskId: id, detail: { target, disposeError: error?.message ?? String(error) } })
            continue
          }
          log('task.spawn.discarded', {
            taskId: id,
            sessionId,
            detail: { target, status: current?.status ?? 'missing' },
          })
          continue
        }
        try {
          clearQueued(db, id)
          transition(db, id, 'running', { sessionId, target })
          remove(id)
          log('task.spawn.ok', { taskId: id, sessionId, detail: { target } })
          dispatched += 1
          attempt = 0
        } catch (error) {
          // 状态迁移失败：子会话已经起出来了，best-effort 收掉，别白占并发位。
          // 这时任务 session_id 还是空的，孤儿对账筛不到它，所以这里必须自己收。
          remove(id)
          try {
            await dispatcher.stop(target)
          } catch (stopError) {
            log('task.spawn.stop-failed', {
              taskId: id,
              sessionId,
              detail: { target, error: stopError?.message ?? String(stopError) },
            })
          }
          log('task.spawn.transition-failed', {
            taskId: id,
            sessionId,
            detail: { target, error: error?.message ?? String(error) },
          })
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
