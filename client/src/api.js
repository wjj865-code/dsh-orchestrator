/**
 * 面板与宿主的 HTTP 契约（P7 / T7.2 迁入）：全部走 POST ${ROUTE}，payload 带 endpoint。
 *
 * - 只读：snapshot / detail / artifacts / preview / session-role
 * - 写动作：stop / retry / message / delete（幂等键 clientRequestId）、open-main
 * 端点白名单与零写入约束由服务端 src/host-route.js 与 test/host-route.test.js 兜住。
 */
import { ROUTE } from './constants.js'

export const readSnapshot = async signal => {
  const response = await fetch(ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: 'snapshot' }),
    signal,
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const body = await response.json()
  if (body === null || typeof body !== 'object' || body.ok !== true) throw new Error((body && body.error) || 'bad-response')
  return body
}

// 固定入口：由插件创建/打开唯一主会话，创建后直接跳过去。
export const openMainSession = async () => {
  const response = await fetch(ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: 'open-main' }),
  })
  const body = await response.json()
  if (body && body.ok === true && typeof body.sessionId === 'string') return body
  throw new Error((body && body.error) || '打开主会话失败')
}

// 面板动作统一失败格式是 { ok:false, code, error }；code 稳定可编程，error 是给人看的中文。
// Error 上同时挂 code/status，runPanel 才能把错误码显示在面板里。
export const actionFailure = (body, status) => {
  const failure = new Error((body && body.error) || `HTTP ${status}`)
  if (body && typeof body.code === 'string' && body.code !== '') failure.code = body.code
  failure.status = status
  return failure
}

// 每次 message 点击生成一个请求 id：host-route 按 (taskId, clientRequestId) 去重，
// 网络重发/重复点击不会把同一条消息投递两次。
export const newRequestId = () => {
  const source = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined
  if (source && typeof source.randomUUID === 'function') return source.randomUUID()
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

// 面板动作：detail/artifacts 只读，stop/retry/message 是写动作。
export const readDetail = async taskId => {
  const response = await fetch(ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: 'detail', taskId }),
  })
  const body = await response.json()
  if (body && body.ok === true) return body
  throw actionFailure(body, response.status)
}

// 产物库：一次取最多 200 条，前端按项目/日期分组；预览端点只读文件前 64 KiB。
export const readArtifacts = async (limit = 200, signal) => {
  const response = await fetch(ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: 'artifacts', limit }),
    signal,
  })
  const body = await response.json()
  if (body && body.ok === true) return body
  throw actionFailure(body, response.status)
}

export const readPreview = async (taskId, path) => {
  const response = await fetch(ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: 'preview', taskId, path }),
  })
  const body = await response.json()
  if (body && body.ok === true) return body
  throw actionFailure(body, response.status)
}

export const panelAction = async (endpoint, taskId, extra = {}) => {
  const payload = { endpoint, taskId, ...extra }
  if (endpoint === 'message' && (typeof payload.clientRequestId !== 'string' || payload.clientRequestId === '')) {
    payload.clientRequestId = newRequestId()
  }
  const response = await fetch(ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = await response.json()
  if (body && body.ok === true) return body
  throw actionFailure(body, response.status)
}

// 面板按钮和侧栏启动器共用同一条 open-main；并发点击合并成一次（平台侧创建没有互斥）。
let openMainInFlight = null
export const openMainOnce = () => {
  if (openMainInFlight !== null) return openMainInFlight
  const run = openMainSession()
  openMainInFlight = run
  const clear = () => { if (openMainInFlight === run) openMainInFlight = null }
  run.then(clear, clear)
  return run
}
