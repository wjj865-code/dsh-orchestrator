// 面板 message 的请求级幂等：同一个 (taskId, clientRequestId) 只真正执行一次。
// - 成功结果在进程内缓存（LRU，默认 200 条），客户端没收到响应而重发时直接返回原结果。
// - 并发同 key 合并到同一个 promise，避免网络重试/双击同时投递两条。
// - 失败结果不缓存：投递失败后允许用同一个 clientRequestId 重试。
//
// 已知限制：缓存只在进程内，插件重启（或换进程）后失效；跨重启的严格去重需要把
// clientRequestId 落台账（当前 messages 表没有该列，A2 不扩表）。
export function createRequestDedupe({ max = 200 } = {}) {
  const done = new Map()
  const inflight = new Map()
  const keyOf = (taskId, requestId) => `${String(taskId ?? '')}\u0000${String(requestId ?? '')}`

  const remember = (key, result) => {
    // 覆盖也算一次写入：先删再插，保持 Map 插入序近似 LRU。
    done.delete(key)
    done.set(key, result)
    while (done.size > Math.max(1, max)) {
      const oldest = done.keys().next().value
      done.delete(oldest)
    }
  }

  return {
    /** 返回 { result, duplicate }；duplicate=true 表示命中了缓存或在途请求。 */
    async run(taskId, requestId, execute) {
      const key = keyOf(taskId, requestId)
      if (done.has(key)) return { result: done.get(key), duplicate: true }
      if (inflight.has(key)) return { result: await inflight.get(key), duplicate: true }
      const promise = Promise.resolve().then(execute)
      inflight.set(key, promise)
      try {
        const result = await promise
        if (result?.ok === true) remember(key, result)
        return { result, duplicate: false }
      } finally {
        inflight.delete(key)
      }
    },
    size: () => done.size,
    inflightSize: () => inflight.size,
  }
}
