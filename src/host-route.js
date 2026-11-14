// /api/orchestrator 路由的 handler。
// 平台只保证 401/403 + owner-only（connection.admit），不保证只读：
// snapshot 只 import 查询函数、不写台账、不 spawn；open-main 是唯一动作端点，只建/打开主会话。
import { listTasks, listHistoryTasks } from './ledger.js'
import { taskCard } from './card.js'

const ENDPOINTS = new Set(['snapshot'])
const ACTIONS = new Set(['detail', 'artifacts', 'stop', 'retry', 'message'])
const ACTIVE = new Set(['waiting_dep', 'pending', 'running', 'waiting_user', 'waiting_auth'])

const json = (value, status) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json' },
})

export function createHostRoute({ db, coordinatorStatus, openMain, panel, staleMinutes = 30, limit = 200, now = Date.now }) {
  const snapshot = () => {
    const status = coordinatorStatus?.() ?? {}
    const at = now()
    // 活跃任务始终全量；历史只取最近 limit 条。不能先全量再 slice，否则老 running 会被截掉。
    const tasks = [...listTasks(db, { active: true }), ...listHistoryTasks(db, limit)]
    return {
      ok: true,
      at,
      mainSession: { id: status.id ?? null, live: status.live === true },
      inboxCount: tasks.filter(task => task.status === 'waiting_user' || task.status === 'waiting_auth').length,
      tasks: tasks.map(task => {
        const card = taskCard(task)
        return {
          id: task.id,
          title: task.title,
          status: task.status,
          label: card.label,
          tone: card.tone,
          childSessionId: task.session_id ?? null,
          targetDir: task.target_dir ?? null,
          readOnly: task.read_only === true,
          retryOf: task.retry_of ?? null,
          groupId: task.group_id ?? null,
          dependsOn: Array.isArray(task.depends_on) ? task.depends_on : [],
          writeScopes: Array.isArray(task.write_scopes) ? task.write_scopes : [],
          priority: task.priority ?? 0,
          question: task.question ?? null,
          options: Array.isArray(task.options) ? task.options : [],
          artifacts: Array.isArray(task.artifacts) ? task.artifacts : [],
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
    if (endpoint === 'open-main') {
      if (openMain === undefined) return json({ ok: false, error: 'open-main-unavailable' }, 500)
      let result
      try {
        result = await openMain()
      } catch (error) {
        // 不让 handler 抛给 host-webserver（那里只会 warn + 400 空体，客户端看不到原因）。
        return json({ ok: false, error: `打开主会话失败：${error?.message ?? error}` }, 500)
      }
      return json(result?.ok === true
        ? { ok: true, sessionId: result.sessionId, created: result.created === true }
        : { ok: false, error: result?.error ?? '创建主会话失败' }, result?.ok === true ? 200 : 500)
    }
    if (ACTIONS.has(endpoint)) {
      if (panel === undefined) return json({ ok: false, error: 'panel-actions-unavailable' }, 500)
      try {
        let result
        if (endpoint === 'detail') result = panel.detail(body?.taskId)
        else if (endpoint === 'artifacts') result = panel.artifacts(body?.limit)
        else if (endpoint === 'stop') result = await panel.stop(body?.taskId)
        else if (endpoint === 'retry') result = await panel.retry(body?.taskId)
        else if (endpoint === 'message') result = await panel.message(body?.taskId, body?.message)
        return json(result, result?.ok === true ? 200 : 400)
      } catch (error) {
        return json({ ok: false, error: `动作失败：${error?.message ?? error}` }, 500)
      }
    }
    if (!ENDPOINTS.has(endpoint)) return json({ ok: false, error: 'unknown-endpoint' }, 400)
    return json(snapshot(), 200)
  }
}

export const HOST_ROUTE = '/api/orchestrator'
export const HOST_ROUTE_OPTIONS = { path: HOST_ROUTE, methods: ['POST'], requestBody: 'buffered' }
