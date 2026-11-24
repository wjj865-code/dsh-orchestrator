/**
 * 关联任务 chip 的共享数据源（订阅式、单实例）。
 *
 * 为什么不让每个 chip 各拉一次：chip 挂在会话流里，一条历史里有 N 个 turn-tail 组件，
 * 各拉各的就是 N 份 /api/orchestrator。这里做成一个 feed：
 * - **只在有订阅者时轮询**（本仓库只有「最新一轮回复」那一行会订阅），最后一个订阅者退订立刻停表；
 * - **快照身份稳定**：轮询每 3s 回来一次，内容没变就复用上一份对象，React 不会因为「同内容新对象」
 *   白白重渲染（selector/状态比较都靠它）；
 * - **节奏自适应**：有活跃任务 3s，全是终态 15s，失败退避 30s（与面板同口径）；
 * - 失败保留上一份快照（chip 不闪没），成功一次即恢复。
 *
 * 所有时钟与网络都从参数注入，单测用假 timer / 假 fetch 直接跑。
 */
import { CHIP_ACTIVE_STATUSES, CHIP_IDLE_MS, CHIP_POLL_MS, CHIP_RECENT_MS, POLL_BACKOFF_MS } from './constants.js'

const CHIP_ACTIVE = new Set(CHIP_ACTIVE_STATUSES)

// 只保留下游要用的字段：快照里那些产物/依赖/选项对 chip 没用，剪掉能让身份比较更便宜。
// childSessionId 要留：chip 点击靠它跳子会话（logic.js 的 chipOpenTargetOf），剪了就只能降级详情。
// ref 也要留（R3）：chip 的 tooltip 要写「名称（tk-xxxxxx）」，用户才能跟 task_list 里的那条对上。
const slimTask = task => ({
  id: typeof task.id === 'string' ? task.id : '',
  ref: typeof task.ref === 'string' ? task.ref : '',
  title: typeof task.title === 'string' ? task.title : '',
  status: typeof task.status === 'string' ? task.status : '',
  coordinatorSession: typeof task.coordinatorSession === 'string' ? task.coordinatorSession : null,
  childSessionId: typeof task.childSessionId === 'string' && task.childSessionId !== '' ? task.childSessionId : null,
  lastEventAt: typeof task.lastEventAt === 'number' ? task.lastEventAt : null,
  updatedAt: typeof task.updatedAt === 'number' ? task.updatedAt : null,
})

// 终态任务只在「最近 30 分钟」内出现在 chip 上（R3）。所以签名里带一位 `recent`：
// 任务跨过 30 分钟线时签名变化 → 发一次通知 → chip 自己消失，不必等台账再动一下。
// 活跃任务恒为 `active`（不看时钟），避免活跃任务每分钟都被当成变化。
const recencyOf = (task, at) => {
  if (CHIP_ACTIVE.has(task.status)) return 'active'
  if (typeof task.lastEventAt !== 'number') return 'stale'
  return at - task.lastEventAt <= CHIP_RECENT_MS ? 'recent' : 'stale'
}

const signatureOf = (tasks, at) => {
  let text = ''
  for (const task of tasks) {
    text += `${task.id}\u0001${task.ref}\u0001${task.status}\u0001${task.title}\u0001${task.coordinatorSession ?? ''}\u0001${task.childSessionId ?? ''}\u0001${task.lastEventAt ?? ''}\u0001${task.updatedAt ?? ''}\u0001${recencyOf(task, at)}\u0002`
  }
  return text
}

/**
 * 把 host 的 snapshot 响应裁成 feed 快照。
 * @param body - readSnapshot 的返回（{ ok, tasks, mainSession }）。
 * @param at - 判定「最近」的时钟（默认 Date.now；测试注入）。
 * @returns {{tasks: object[], signature: string}|null} 响应不完整时 null（调用方保留上一份）。
 */
export const normalizeFeedSnapshot = (body, at = Date.now()) => {
  if (body === null || typeof body !== 'object' || body.ok !== true) return null
  const tasks = (Array.isArray(body.tasks) ? body.tasks : [])
    .filter(task => task !== null && typeof task === 'object')
    .map(slimTask)
  return { tasks, signature: signatureOf(tasks, at) }
}

const hasActive = snapshot => snapshot !== null
  && snapshot.tasks.some(task => CHIP_ACTIVE.has(task.status))

/**
 * 创建共享 feed。
 * @param readSnapshot - 只读拉取函数（api.js 的 readSnapshot，返回 { ok, tasks }）。
 * @param options.now/setTimer/clearTimer - 注入点（测试用假实现）。
 * @returns {{getSnapshot, subscribe, poll, stop}} 稳定的 { getSnapshot, subscribe } 可直接交给 slot hooks。
 */
export const createTaskFeed = ({
  readSnapshot,
  now = () => Date.now(),
  setTimer = (run, ms) => setTimeout(run, ms),
  clearTimer = handle => clearTimeout(handle),
  activeMs = CHIP_POLL_MS,
  idleMs = CHIP_IDLE_MS,
  backoffMs = POLL_BACKOFF_MS,
}) => {
  let snapshot = null
  let handle = null
  let stopped = true
  let running = false
  const listeners = new Set()

  const emit = () => {
    for (const listener of [...listeners]) {
      try { listener() } catch { /* 单个订阅者失败不影响其它 */ }
    }
  }
  const stop = () => {
    stopped = true
    if (handle !== null) {
      clearTimer(handle)
      handle = null
    }
  }
  const schedule = ms => {
    if (stopped) return
    if (handle !== null) {
      clearTimer(handle)
      handle = null
    }
    handle = setTimer(() => {
      handle = null
      return step()
    }, ms)
  }
  // 拉一次并落地：内容变了才发通知（身份稳定是这里的核心契约）。
  const poll = async () => {
    if (running) return false
    running = true
    let next = null
    let ok = false
    const at = now()
    try {
      next = normalizeFeedSnapshot(await readSnapshot(), at)
      ok = next !== null
    } catch { ok = false }
    running = false
    if (ok && (snapshot === null || next.signature !== snapshot.signature)) {
      snapshot = { tasks: next.tasks, signature: next.signature, at }
      emit()
    }
    return ok
  }
  const step = async () => {
    if (stopped || running) return
    const ok = await poll()
    if (stopped) return
    schedule(ok ? (hasActive(snapshot) ? activeMs : idleMs) : backoffMs)
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: listener => {
      listeners.add(listener)
      if (stopped) {
        stopped = false
        schedule(0)
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) stop()
      }
    },
    poll,
    stop,
  }
}
