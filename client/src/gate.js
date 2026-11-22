/**
 * 任务入口闸门（P7 / T7.2 迁入）：判定会话头该渲染哪一种入口。
 *
 * 快照是**角色**而不是布尔：
 *   - `main`   → 当前会话就是主会话（宿主按台账 main_session_id 回答），渲染「任务」入口；
 *   - `adopt`  → 普通根会话（官方新建会话、能力包会话、schedule 新建会话…），渲染「设为协调者」；
 *   - `hidden` → 子智能体会话（`origin === 'subagent'`）或判定不出来，**两个入口都不渲染**。
 *
 * 为什么子智能体要按“未渲染”处理：子会话是协调者派出去干活的，既不该被当成协调者候选，
 * 也不该给它任务台入口（它没有 task_* 权限）。判定信号取客户端会话行的 `origin`（宿主会话头
 * `header.origin === 'subagent'` 的透出，见 dsh-api-session-controller 的 SessionSummary）。
 *
 * 降级（fail-closed）：拿不到会话 / 请求失败 / 响应不是 boolean / 判定过程抛错，一律 `hidden`，
 * 失败不缓存，靠会话切换订阅 + 5 秒兜底轮询重试。
 */
import { MAIN_VIEW_POLL_MS } from './constants.js'

// 任务入口闸门（fail-closed）：只有宿主明确回答「当前会话就是主会话」才给 main 角色；
// 非主会话再看客户端会话行的 origin：subagent → hidden，其余 → adopt。
// 当前会话信号：uiSession.adapter.current（优先）→ sessions.list 的 retainedBy.mainView（兜底）；
// 身份判定：POST session-role，宿主用台账 main_session_id 比较（与 task_* 工具同一信号）。
// 降级：拿不到当前会话 / 请求失败 / 响应不是 boolean → 一律 hidden；失败不缓存，靠会话切换或
// 5 秒兜底轮询重试。侧栏「◈ 主会话」跳转入口不受这个闸门影响（始终可见）。
export const createMainViewGate = ({
  readSessionId, subscribeSession, fetchRole, isSubagent = () => false,
  timer, pollMs = MAIN_VIEW_POLL_MS, now = () => Date.now(),
}) => {
  let role = 'hidden'
  let epoch = 0
  let lastId = null
  let lastRole = 'hidden'
  let lastOk = false
  let lastAt = 0
  const listeners = new Set()
  const setRole = next => {
    if (next === role) return
    role = next
    for (const listener of [...listeners]) {
      try { listener() } catch { /* 单个入口订阅失败不影响其他入口 */ }
    }
  }
  // 子智能体判定只在「宿主已明确回答不是主会话」之后才问：主会话永远优先（main_session_id 是硬信号）。
  const nonMainRole = sessionId => {
    try {
      return isSubagent(sessionId) === true ? 'hidden' : 'adopt'
    } catch {
      return 'hidden'
    }
  }
  const evaluate = async (force = false) => {
    let sessionId
    try { sessionId = readSessionId() } catch { sessionId = undefined }
    if (typeof sessionId !== 'string' || sessionId === '') {
      lastId = null
      lastOk = false
      lastAt = now()
      setRole('hidden')
      return 'hidden'
    }
    // 同一个会话已经拿到明确答案就直接复用；换会话（id 变了）立即重判，不等节流。
    if (!force && lastOk && lastId === sessionId) {
      setRole(lastRole)
      return lastRole
    }
    if (!force && lastId === sessionId && now() - lastAt < (lastOk ? 1000 : pollMs)) return role
    const turn = ++epoch
    lastAt = now()
    let next = 'hidden'
    let ok = false
    try {
      const answer = await fetchRole(sessionId)
      ok = true
      // 只认 true/false 两种明确回答：undefined/别的一律当判定不出来（fail-closed）。
      if (answer === true) next = 'main'
      else if (answer === false) next = nonMainRole(sessionId)
    } catch { ok = false }
    if (turn !== epoch) return role
    lastId = sessionId
    lastOk = ok
    lastRole = next
    setRole(next)
    return next
  }
  return {
    getSnapshot: () => role,
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
