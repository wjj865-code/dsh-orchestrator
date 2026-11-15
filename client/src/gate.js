/**
 * 任务入口闸门（P7 / T7.2 迁入）：fail-closed 判定「当前会话是不是主会话」。
 *
 * 只有宿主明确回答 isMain === true 才显示「☰ 任务」；拿不到会话 / 请求失败 / 响应不 ok
 * 一律隐藏，失败不缓存，靠会话切换订阅 + 5 秒兜底轮询重试。
 */
import { MAIN_VIEW_POLL_MS } from './constants.js'

// 任务入口闸门（fail-closed）：只有宿主明确回答「当前会话就是主会话」才显示「☰ 任务」。
// 当前会话信号：uiSession.adapter.current（优先）→ sessions.list 的 retainedBy.mainView（兜底）；
// 身份判定：POST session-role，宿主用台账 main_session_id 比较（与 task_* 工具同一信号）。
// 降级：拿不到当前会话 / 请求失败 / 响应不是 ok:true → 一律隐藏；失败不缓存，靠会话切换或
// 5 秒兜底轮询重试。侧栏「◈ 主会话」跳转入口不受这个闸门影响（始终可见）。
export const createMainViewGate = ({
  readSessionId, subscribeSession, fetchRole, timer, pollMs = MAIN_VIEW_POLL_MS, now = () => Date.now(),
}) => {
  let visible = false
  let epoch = 0
  let lastId = null
  let lastVisible = false
  let lastOk = false
  let lastAt = 0
  const listeners = new Set()
  const setVisible = next => {
    const value = next === true
    if (value === visible) return
    visible = value
    for (const listener of [...listeners]) {
      try { listener() } catch { /* 单个入口订阅失败不影响其他入口 */ }
    }
  }
  const evaluate = async (force = false) => {
    let sessionId
    try { sessionId = readSessionId() } catch { sessionId = undefined }
    if (typeof sessionId !== 'string' || sessionId === '') {
      lastId = null
      lastOk = false
      lastAt = now()
      setVisible(false)
      return false
    }
    // 同一个会话已经拿到明确答案就直接复用；换会话（id 变了）立即重判，不等节流。
    if (!force && lastOk && lastId === sessionId) {
      setVisible(lastVisible)
      return lastVisible
    }
    if (!force && lastId === sessionId && now() - lastAt < (lastOk ? 1000 : pollMs)) return visible
    const turn = ++epoch
    lastAt = now()
    let next = false
    let ok = false
    try {
      next = (await fetchRole(sessionId)) === true
      ok = true
    } catch { ok = false }
    if (turn !== epoch) return visible
    lastId = sessionId
    lastOk = ok
    lastVisible = ok && next
    setVisible(lastVisible)
    return lastVisible
  }
  return {
    getSnapshot: () => visible,
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    refresh: () => evaluate(true),
    start: () => {
      const disposers = []
      // uiSession / sessions 可能比本插件晚就绪：订阅失败不阻塞，兜底轮询每次补订一次。
      let sessionBound = false
      const bindSession = () => {
        if (sessionBound || typeof subscribeSession !== 'function') return
        const off = subscribeSession(() => { void evaluate() })
        if (typeof off === 'function') {
          sessionBound = true
          disposers.push(off)
        }
      }
      bindSession()
      if (typeof timer === 'function') {
        const off = timer(() => {
          bindSession()
          void evaluate()
        }, pollMs)
        if (typeof off === 'function') disposers.push(off)
      }
      void evaluate(true)
      return () => {
        for (const off of disposers) {
          try { off() } catch { /* 卸载期清理失败不阻断 */ }
        }
      }
    },
  }
}
