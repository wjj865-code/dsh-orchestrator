// /api/orchestrator 只读路由的 handler。
// 平台只保证 401/403 + owner-only（connection.admit），不保证只读：
// 这里只 import 查询函数、只认白名单端点，不写台账、不触发绑定、不 spawn。
import { listTasks } from './ledger.js'
import { taskCard } from './card.js'

const ENDPOINTS = new Set(['snapshot'])
const ACTIVE = new Set(['pending', 'running', 'waiting_user', 'waiting_auth'])

const json = (value, status) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json' },
})

export function createHostRoute({ db, coordinatorStatus, staleMinutes = 30, limit = 200, now = Date.now }) {
  const snapshot = () => {
    const status = coordinatorStatus?.() ?? {}
    const at = now()
    return {
      ok: true,
      at,
      coordinator: { id: status.id ?? null, live: status.live === true },
      // 台账可能很长，面板只要活跃 + 最近的历史；按 listTasks 的倒序截断。
      tasks: listTasks(db).slice(0, limit).map(task => {
        const card = taskCard(task)
        return {
          id: task.id,
          title: task.title,
          status: task.status,
          label: card.label,
          tone: card.tone,
          childSessionId: task.session_id ?? null,
          queued: task.status === 'pending' && task.queued_at !== null && task.queued_at !== undefined,
          stale: ACTIVE.has(task.status) && at - task.last_event_at > staleMinutes * 60_000,
          updatedAt: task.updated_at,
          lastEventAt: task.last_event_at,
          error: task.error ?? null,
        }
      }),
    }
  }

  return async function fetch(request) {
    let body
    try { body = await request.json() } catch { body = {} }
    const endpoint = String(body?.endpoint ?? '')
    if (!ENDPOINTS.has(endpoint)) return json({ ok: false, error: 'unknown-endpoint' }, 400)
    return json(snapshot(), 200)
  }
}

export const HOST_ROUTE = '/api/orchestrator'
export const HOST_ROUTE_OPTIONS = { path: HOST_ROUTE, methods: ['POST'], requestBody: 'buffered' }
