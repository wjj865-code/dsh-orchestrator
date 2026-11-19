// 派发队列：平台不排队（满了抛 ACTIVATION_LIMIT_REACHED），插件自己排。
// 单锁串行：同一时刻只有一个 pump 在跑；spawn 成功 / 子会话结算 / 任务终态都会唤醒。
import {
  briefText, clearQueued, countPending, getTask, listPendingQueue, listTasks, markQueued, transition,
} from './ledger.js'
import { promoteDependents } from './deps.js'
import { renderBriefForTask } from './brief.js'
import { taskLabel } from './task-label.js'
import { WORKTREE_DISPATCH_STATES, prepareTaskWorktree } from './worktree.js'

export function createQueue({ db, dispatcher, config = {}, logger, notifier, worktree, cleanupWorktree, retryDelaysMs = [2000, 5000, 10000, 30000] }) {  const log = (event, fields) => {
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
    if (ids.includes(id)) return
    ids.push(id)
    // 优先级高的先派；同优先级按创建时间 FIFO（JS sort 稳定，等值时保留入队顺序）。
    ids.sort((left, right) => {
      const a = getTask(db, left)
      const b = getTask(db, right)
      const priorityDelta = (b?.priority ?? 0) - (a?.priority ?? 0)
      if (priorityDelta !== 0) return priorityDelta
      return (a?.created_at ?? 0) - (b?.created_at ?? 0)
    })
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
    // 先把依赖已完成的 waiting_dep 晋升为 pending；晋升动作只会发生在等待中的任务上。
    try { promoteDependents(db, { enqueue, log }) } catch (error) {
      log('task.dep.promote-failed', { detail: { error: error?.message ?? String(error) } })
    }
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
        // T1：派发提示词就是 brief 本身（任务编号 + task_detail 指引）；详情由子会话读台账，
        // 前置任务/产物也走 task_detail 现读，不再在派发时拼一段快照。
        const rendered = briefText(db, id) ?? renderBriefForTask(task)
        // P9：worktree 任务在派发前建检出，子会话 cwd = 检出目录 + 原 target 偏移；普通任务一次 git 都不调。
        let dispatchCwd = task.target_dir ?? undefined
        if (worktree !== undefined && WORKTREE_DISPATCH_STATES.includes(task.worktree_state)) {
          const prepared = await prepareTaskWorktree({ db, task, service: worktree, log })
          if (prepared.ok !== true) {
            // 用户显式要的隔离没做成 → 标 failed 并写明原因，不静默降级（产物落回工作树才是灾难）。
            remove(id)
            const failure = prepared.failure ?? {}
            const message = `隔离创建失败（${failure.code ?? 'FAILED'}）：${failure.message ?? '未知原因'}`
            log('task.spawn.failed', { taskId: id, detail: { error: message, code: failure.code ?? null } })
            try {
              transition(db, id, 'failed', { error: message })
            } catch (error) {
              log('task.spawn.transition-failed', { taskId: id, detail: { error: error?.message ?? String(error) } })
            }
            try {
              dispatcher.releaseWritableRoots?.(task.session_id ?? task.target)
            } catch { /* 释放失败不影响失败通知 */ }
            notifier?.push({
              taskId: id,
              title: task.title,
              displayName: taskLabel(task, { all: listTasks(db) }),
              readOnly: task.read_only === true,
              access: task.access === 'full' ? 'full' : null,
              status: 'failed',
              summary: message,
              worktree: {
                state: 'failed',
                branch: task.worktree_branch ?? null,
                path: task.worktree_path ?? null,
                error: failure.message ?? null,
              },
              system: true,
            })
            try { promoteDependents(db, { enqueue, log }) } catch { /* 传播失败只影响下游，不打断队列 */ }
            continue
          }
          dispatchCwd = prepared.cwd ?? dispatchCwd
        }
        let member
        try {
          member = await dispatcher.spawn({
            name: dispatcher.slug?.(task.title) ?? task.title,
            label: task.title,
            prompt: rendered,
            signal: abort.signal,
            taskId: id,
            cwd: dispatchCwd,
            readOnly: task.read_only === true,
            // per-task 访问级别：只把显式的 'full' 往派发层传；其余（含 undefined）一律沿用会话策略。
            access: task.access === 'full' ? 'full' : undefined,
            // P8：计划任务在派发时就进只读沙箱 + plan mode（见 dispatch.spawn）。
            planFirst: task.plan_first === true,
            goal: task.goal,
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
          // P9：派发失败也可能已经建了检出 → 按 worktreeCleanup 档位清理（默认 off = 保留）。
          try { cleanupWorktree?.(getTask(db, id)) } catch { /* 清理失败只影响磁盘，不影响失败通知 */ }
          // 失败必须让主会话看见（不能静默 failed）；sender 缺失时由 index 用主会话自身投递。
          notifier?.push({
            taskId: id,
            title: task.title,
            displayName: taskLabel(task, { all: listTasks(db) }),
            readOnly: task.read_only === true,
            access: task.access === 'full' ? 'full' : null,
            status: 'failed',
            summary: message,
            system: true,
          })
          // 失败沿依赖链传播：下游 waiting_dep 立即失败，不再假装在等。
          try { promoteDependents(db, { enqueue, log }) } catch { /* 传播失败只影响下游，不打断队列 */ }
          continue
        }

        // spawn 在途时任务可能已被 stop（task_message action:stop）/取消：把刚起的子会话收掉，别让它白占一个并发位，
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
