/**
 * 主会话导航待办轮询器（t-a79e12d8）。
 *
 * 服务端在「压力提醒 → 新建协调者会话」成功后只建会话 + 切指针，**跳转只能客户端做**
 * （宿主公开能力 `uiWorkspace.openSession` 在浏览器插件里）。这里每 5s 轮询 `main-nav`：
 * 拿到 `navigate` 就跳过去；拿到 `notice` 就把服务端已判定的可读原因（切指针失败 / 建会话失败）
 * 交给面板顶部提示。
 *
 * 失败降级（不假装成功、不留「既不是主会话又没跳」的坑）：
 *   - 宿主没有 `openSession`（老宿主 / 裁剪 profile）→ 不崩，给可读提示；
 *   - `openSession` 抛错（`sessions.retain: unknown session …`：新建会话刚广播、会话表还没到）→
 *     同一条待办最多试 `MAIN_NAV_MAX_ATTEMPTS` 次，仍失败就 ack 失败 + 「请从左侧会话列表打开
 *     『主会话』」——指针由服务端切好了，用户手点也能到；
 *   - 轮询请求失败静默（不打扰正在对话的用户）。
 */
export const MAIN_NAV_POLL_MS = 5000
export const MAIN_NAV_MAX_ATTEMPTS = 3

/** 跳转失败的可读提示（面板顶部显示；末尾告诉用户手动入口在哪）。 */
export const navJumpFailedText = reason => `新主会话已建好，但自动跳转失败：${reason}。请从左侧会话列表打开「主会话」。`

/**
 * @param {object} opts
 * @param {() => Promise<object>} opts.readNav 轮询 `main-nav`（返回 `{ ok, nav }`）
 * @param {(ack:{id:string, ok:boolean, error?:string}) => Promise<object>} opts.ackNav 处理完 ack
 * @param {(sessionId:string) => unknown} opts.openSession 宿主 `uiWorkspace.openSession`
 * @param {(text:string) => void} [opts.onNotice] 可读提示出口（面板）
 * @param {(text:string) => void} [opts.warn] 控制台/诊断
 * @param {(run:Function, ms:number) => (()=>void)|undefined} [opts.timer] 自排程定时器
 */
export const createMainNavPoller = ({
  readNav, ackNav, openSession, onNotice, warn, timer,
  pollMs = MAIN_NAV_POLL_MS, attempts = MAIN_NAV_MAX_ATTEMPTS,
} = {}) => {
  let busy = false
  let done = null
  const failures = new Map()
  const notify = text => {
    if (typeof text !== 'string' || text === '') return
    try { if (typeof warn === 'function') warn(`dsh-orchestrator: ${text}`) } catch { /* 日志失败不阻断 */ }
    try { if (typeof onNotice === 'function') onNotice(text) } catch { /* 提示失败不阻断 */ }
  }
  const run = async () => {
    if (busy) return
    busy = true
    try {
      const body = await readNav()
      const nav = body === null || body === undefined ? null : body.nav
      if (nav === null || nav === undefined || typeof nav.id !== 'string' || nav.id === done) return
      if (nav.kind === 'notice') {
        done = nav.id
        notify(typeof nav.text === 'string' ? nav.text : '')
        await ackNav({ id: nav.id, ok: true })
        return
      }
      if (nav.kind !== 'navigate' || typeof nav.sessionId !== 'string' || nav.sessionId === '') return
      try {
        if (typeof openSession !== 'function') throw new Error('宿主没有 uiWorkspace.openSession（旧宿主或裁剪 profile）')
        await openSession(nav.sessionId)
        done = nav.id
        await ackNav({ id: nav.id, ok: true })
      } catch (error) {
        const count = (failures.get(nav.id) ?? 0) + 1
        failures.set(nav.id, count)
        if (count < attempts) return
        done = nav.id
        const reason = `${error?.message ?? error}`
        await ackNav({ id: nav.id, ok: false, error: reason })
        notify(navJumpFailedText(reason))
      }
    } catch { /* 轮询失败静默 */ } finally {
      busy = false
    }
  }
  return {
    run,
    start: () => {
      const stop = typeof timer === 'function' ? timer(() => { void run() }, pollMs) : undefined
      void run()
      return stop
    },
  }
}

/**
 * 面板顶部可读提示的小邮箱：面板已挂载就即时推给它；没挂载就留一条给下次挂载取走
 * （与 `createFocusRequest` 的「取走即清空」同口径，不残留到很久以后）。
 */
export const createNavNotice = () => {
  let pending = null
  const listeners = new Set()
  return {
    set: text => {
      const value = typeof text === 'string' ? text.trim() : ''
      if (value === '') return
      if (listeners.size === 0) { pending = value; return }
      pending = null
      for (const listener of [...listeners]) {
        try { listener(value) } catch { /* 单个监听失败不影响其他 */ }
      }
    },
    take: () => {
      const value = pending
      pending = null
      return value
    },
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
