/**
 * 开包会话后「跳到新会话」的等待与降级（t-8a81264c）。
 *
 * 为什么需要：宿主 `sessions.retain()` 只接受**已出现在客户端会话目录**里的 id；新会话的目录行经
 * `api-session/added` 事件从 WebSocket 到达，而 `pack-open` 的结果走另一条 HTTP 通道——两者没有
 * 顺序保证。事件还没落地时宿主就同步抛 `sessions.retain: unknown session <id>`（main-nav 那条链
 * 早踩过同一个坑、已按重试处理，见 client/src/nav.js）。这里只对这类错误短退避重试；其它错误立即
 * 失败，不掩盖真故障。
 */

/**
 * @param {(sessionId: string) => unknown} openSession - 宿主 `uiWorkspace.openSession`
 * @param {string} sessionId - 刚创建的会话 id
 * @param {{attempts?: number, wait?: (ms: number) => Promise<unknown>}} [options]
 * @returns {Promise<{ok: true} | {ok: false, reason: string}>}
 */
export const openSessionWhenReady = async (
  openSession,
  sessionId,
  { attempts = 4, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {},
) => {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await openSession(sessionId)
      return { ok: true }
    } catch (error) {
      const reason = `${error?.message ?? error}`
      if (attempt >= attempts || !/unknown session/.test(reason)) return { ok: false, reason }
      await wait(120 * attempt)
    }
  }
  return { ok: false, reason: '' }
}
