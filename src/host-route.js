// /api/orchestrator 路由的 handler。
// 平台只保证 401/403 + owner-only（connection.admit），不保证只读：
// snapshot 只 import 查询函数、不写台账、不 spawn；open-main 是唯一动作端点，只建/打开主会话。
import { listTasks, listHistoryTasks } from './ledger.js'
import { taskCard } from './card.js'
import { panelFailure, panelHttpStatus } from './action-errors.js'
import { createRequestDedupe } from './request-dedupe.js'
import { isMainSession } from './session-role.js'
import { ACTIVE_STATUSES, canClose, canDelete, canFollowup } from './panel-gates.js'

const ENDPOINTS = new Set(['snapshot', 'session-role'])
const ACTIONS = new Set(['detail', 'artifacts', 'preview', 'stop', 'retry', 'message', 'close', 'delete'])
const ACTIVE = new Set(ACTIVE_STATUSES)

const json = (value, status) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json' },
})

export function createHostRoute({ db, coordinatorStatus, openMain, panel, staleMinutes = 30, limit = 200, now = Date.now }) {
  // message 请求级幂等：按 (taskId, clientRequestId) 去重，只在进程内（重启失效，见 request-dedupe.js）。
  const dedupe = createRequestDedupe({ max: 200 })
  const snapshot = () => {
    const status = coordinatorStatus?.() ?? {}
    const at = now()
    // 活跃任务始终全量；历史只取最近 limit 条。不能先全量再 slice，否则老 running 会被截掉。
    const activeTasks = listTasks(db, { active: true })
    // 活跃下游计数：终态任务若有活跃任务依赖它，删了会让下游变「缺前置」，面板据此隐藏删除。
    const dependentCounts = new Map()
    for (const item of activeTasks) {
      for (const id of Array.isArray(item.depends_on) ? item.depends_on : []) {
        dependentCounts.set(id, (dependentCounts.get(id) ?? 0) + 1)
      }
    }
    const tasks = [...activeTasks, ...listHistoryTasks(db, limit)]
    return {
      ok: true,
      at,
      mainSession: { id: status.id ?? null, live: status.live === true },
      // 「待你决定」计数：等你确认/要授权/已交付待确认——三种都需要人（或协调者）拍板。
      inboxCount: tasks.filter(task => task.status === 'waiting_user' || task.status === 'waiting_auth' || task.status === 'delivered').length,
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
          // P8：计划模式（列表小标 / 抽屉概览）；非计划任务固定 false + 'none'。
          planFirst: task.plan_first === true,
          planState: typeof task.plan_state === 'string' && task.plan_state !== '' ? task.plan_state : 'none',
          // P9：worktree 隔离（列表小标 / 抽屉概览 / 决定者）。普通任务固定 'none'。
          worktreeState: typeof task.worktree_state === 'string' && task.worktree_state !== '' ? task.worktree_state : 'none',
          worktreeBranch: task.worktree_branch ?? null,
          worktreePath: task.worktree_path ?? null,
          worktreeBase: task.worktree_base ?? null,
          worktreeSource: task.worktree_source ?? 'default',
          retryOf: task.retry_of ?? null,
          groupId: task.group_id ?? null,
          dependsOn: Array.isArray(task.depends_on) ? task.depends_on : [],
          writeScopes: Array.isArray(task.write_scopes) ? task.write_scopes : [],
          priority: task.priority ?? 0,
          question: task.question ?? null,
          options: Array.isArray(task.options) ? task.options : [],
          artifacts: Array.isArray(task.artifacts) ? task.artifacts : [],
          // delivered 两段式：交付时间 / 关闭原因（供面板显示「待确认」「协调者确认/超时」）。
          deliveredAt: task.delivered_at ?? null,
          closeReason: task.close_reason ?? null,
          // 面板按钮可见性与后端门控同源（src/panel-gates.js）：前端只读这三个布尔值。
          canFollowup: canFollowup(task),
          canClose: canClose(task),
          canDelete: canDelete(task, { activeDependents: dependentCounts.get(task.id) ?? 0 }),
          queued: task.status === 'pending' && task.queued_at !== null && task.queued_at !== undefined,
          stale: ACTIVE.has(task.status) && at - task.last_event_at > staleMinutes * 60_000,
          updatedAt: task.updated_at,
          lastEventAt: task.last_event_at,
          error: task.error ?? null,
          // 平台 goal 只读状态（G1）：snapshot 只给生命周期字段，不下发 objective/brief 原文。
          goalState: task.goal_state === null || task.goal_state === undefined
            ? null
            : {
              phase: task.goal_state.phase ?? null,
              activation: task.goal_state.activation ?? null,
              revision: task.goal_state.revision ?? null,
              roundsStarted: task.goal_state.roundsStarted ?? 0,
              updatedAt: task.goal_state.updatedAt ?? null,
            },
        }
      }),
    }
  }

  return async function fetch(request) {
    let body
    try { body = await request.json() } catch { body = {} }
    const endpoint = String(body?.endpoint ?? '')
    if (endpoint === 'open-main') {
      if (openMain === undefined) return json(panelFailure('OPEN_MAIN_UNAVAILABLE'), 500)
      let result
      try {
        result = await openMain()
      } catch (error) {
        // 不让 handler 抛给 host-webserver（那里只会 warn + 400 空体，客户端看不到原因）。
        return json(panelFailure('OPEN_MAIN_FAILED', { reason: error?.message ?? error }), 500)
      }
      if (result?.ok === true && result.onboardingError) {
        return json(panelFailure('OPEN_MAIN_FAILED', { reason: result.onboardingError }), 503)
      }
      if (result?.ok === true) return json({ ok: true, sessionId: result.sessionId, created: result.created === true }, 200)
      return json(panelFailure('OPEN_MAIN_FAILED', { reason: result?.error ?? '创建主会话失败' }), 500)
    }
    if (endpoint === 'session-role') {
      // 客户端面板闸门：只回答「这个会话是不是主会话」，不写台账、不建会话。
      // 信号与 task_* 工具同源（coordinatorStatus → settings.main_session_id）；
      // 任何一侧缺失都按 false 回答，客户端据此默认隐藏任务入口（见 src/session-role.js）。
      const status = coordinatorStatus?.() ?? {}
      const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
      return json({ ok: true, isMain: isMainSession(sessionId, status.id) }, 200)
    }
    if (ACTIONS.has(endpoint)) {
      if (panel === undefined) return json(panelFailure('PANEL_ACTIONS_UNAVAILABLE'), 500)
      try {
        let result
        if (endpoint === 'detail') result = panel.detail(body?.taskId)
        else if (endpoint === 'artifacts') result = panel.artifacts(body?.limit)
        else if (endpoint === 'preview') result = panel.preview(body?.taskId, body?.path)
        else if (endpoint === 'stop') result = await panel.stop(body?.taskId)
        else if (endpoint === 'retry') result = await panel.retry(body?.taskId)
        else if (endpoint === 'close') result = await panel.close(body?.taskId)
        else if (endpoint === 'delete') result = await panel.delete(body?.taskId)
        else if (endpoint === 'message') {
          const taskId = body?.taskId
          const requestId = typeof body?.clientRequestId === 'string'
            ? body.clientRequestId.trim().slice(0, 128)
            : ''
          // 没有 clientRequestId（旧客户端/脚本）时退回 panel 的短窗口同文去重。
          if (requestId === '' || typeof taskId !== 'string' || taskId === '') {
            result = await panel.message(taskId, body?.message)
          } else {
            const outcome = await dedupe.run(taskId, requestId, () => panel.message(taskId, body?.message))
            result = outcome.duplicate && outcome.result?.ok === true
              ? { ...outcome.result, already: true, duplicate: true }
              : outcome.result
          }
        }
        return json(result, panelHttpStatus(result))
      } catch (error) {
        return json(panelFailure('ACTION_FAILED', { reason: error?.message ?? error }), 500)
      }
    }
    if (!ENDPOINTS.has(endpoint)) return json(panelFailure('UNKNOWN_ENDPOINT'), 400)
    return json(snapshot(), 200)
  }
}

export const HOST_ROUTE = '/api/orchestrator'
export const HOST_ROUTE_OPTIONS = { path: HOST_ROUTE, methods: ['POST'], requestBody: 'buffered' }
