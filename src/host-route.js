// /api/orchestrator 路由的 handler。
// 平台只保证 401/403 + owner-only（connection.admit），不保证只读：
// snapshot 只 import 查询函数、不写台账、不 spawn；open-main 是唯一动作端点，只建/打开主会话。
import { listTasks, listHistoryTasks } from './ledger.js'
import { taskCard } from './card.js'
import { panelFailure, panelHttpStatus } from './action-errors.js'
import { createRequestDedupe } from './request-dedupe.js'
import { isMainSession } from './session-role.js'
import { ACTIVE_STATUSES, canClose, canDelete, canFollowup, canSetPlan } from './panel-gates.js'
import { statusesWith } from './status-facts.js'
// P2-3 交接契约 v1：snapshot 只下发精简版（谁/何时确认 + 验收是否通过），完整证据在 detail 端点。
import { handoffSnapshot } from './handoff.js'
// P2-4（D6）：官方 Team 板**只读**快照。服务缺失/未开启/读失败都只降级，绝不让快照 500。
import { TEAM_BOARD_UNAVAILABLE } from './team-board.js'

const ENDPOINTS = new Set(['snapshot', 'session-role'])
const ACTIONS = new Set(['detail', 'artifacts', 'preview', 'stop', 'retry', 'message', 'close', 'delete'])
// 工作台 v1（P11）：只读投影与窄写口。**注意这里刻意没有** task-create / plan-approve / message /
// close-all / patch-task（设计稿 §5.3 的反例清单）：派发、计划批准、交付确认都必须走既有闸门。
const WORKBENCH_READS = new Set(['groups', 'group', 'calendar', 'automations', 'stats'])
const WORKBENCH_WRITES = new Set([
  'group-save', 'group-archive', 'plan-set',
  'automation-save', 'automation-toggle', 'automation-delete',
])
const ACTIVE = new Set(ACTIVE_STATUSES)
// 「待拍板」口径：等人（waiting_user/waiting_auth）+ 已交付待确认（delivered）——`waiting` 能力
// 不含 delivered（它不 waiting 于某个问题，而是等确认），所以这里用两份能力拼，不再写内联三态判断。
const INBOX_STATUSES = new Set([...statusesWith('waiting'), 'delivered'])

const json = (value, status) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json' },
})

export function createHostRoute({ db, coordinatorStatus, openMain, adoptSession, contextSnapshot, panel, workbench, teamBoard, staleMinutes = 30, limit = 200, now = Date.now }) {
  // message 请求级幂等：按 (taskId, clientRequestId) 去重，只在进程内（重启失效，见 request-dedupe.js）。
  const dedupe = createRequestDedupe({ max: 200 })
  // 工作台写动作的请求级幂等（同一个 endpoint + 目标 id + clientRequestId 只执行一次）。
  const workbenchDedupe = createRequestDedupe({ max: 200 })
  // 官方 Team 板：读失败也只降级（快照是面板的轮询入口，不能因为一块只读分区 500）。
  const boardSnapshot = () => {
    if (typeof teamBoard !== 'function') {
      return { enabled: false, rows: [], degraded: { code: TEAM_BOARD_UNAVAILABLE, message: '未装配官方 Team 板读取（宿主缺 agentTeams 服务）' } }
    }
    try {
      const view = teamBoard()
      if (view !== null && typeof view === 'object') return view
      return { enabled: false, rows: [], degraded: { code: TEAM_BOARD_UNAVAILABLE, message: '官方 Team 板读取返回空' } }
    } catch (error) {
      return { enabled: false, rows: [], degraded: { code: 'TEAM_BOARD_READ_FAILED', message: error?.message ?? String(error) } }
    }
  }
  const snapshot = () => {
    const status = coordinatorStatus?.() ?? {}
    const at = now()
    // 上下文观测（0.25.0，只读诊断）：打开主会话时算过一次，这里只读内存缓存。
    // 注意：**面板不常驻渲染压力/阈值**（用户明确要求），这些字段只给诊断与未来 UI 用。
    let context = null
    try {
      const observed = typeof contextSnapshot === 'function' ? contextSnapshot() : null
      if (observed !== null && observed !== undefined) {
        context = {
          at: observed.at ?? null,
          sessionId: observed.sessionId ?? null,
          pressure: observed.pressure ?? null,
          alert: observed.alert ?? null,
          logMiB: Number.isFinite(observed.logMiB) ? observed.logMiB : null,
          hint: observed.hint ?? { visible: false, text: '' },
          compactions: observed.compactions ?? null,
          probe: observed.probe ?? null,
        }
      }
    } catch { context = null }
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
      mainSession: {
        id: status.id ?? null,
        live: status.live === true,
        // 观测字段（诊断用；客户端不渲染成常驻元素）。
        context,
      },
      // 「待你决定」计数：等你确认/要授权/已交付待确认——三种都需要人（或协调者）拍板。
      inboxCount: tasks.filter(task => INBOX_STATUSES.has(task.status)).length,
      // P2-4（D6）：官方 Team 板只读快照（`enabled !== true` 时面板**整区隐藏**，含服务缺失/Team 未开启；
      // `enabled:true` 且 `degraded` 有值表示「Team 开着但这次 listTasks 没读成」，面板显示只读提示而不是装作没有）。
      teamBoard: boardSnapshot(),
      tasks: tasks.map(task => {
        const card = taskCard(task)
        return {
          id: task.id,
          title: task.title,
          status: task.status,
          label: card.label,
          tone: card.tone,
          childSessionId: task.session_id ?? null,
          // 会话归属：客户端「回复底部 chip」按这个字段判断任务是不是当前会话派出的。
          // 只下发 id（不是敏感数据），与 mainSession.id 同源（settings.main_session_id）。
          coordinatorSession: task.coordinator_session ?? null,
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
          // 工作台 v1（P11）L1：人工排期日（可空）。与自动化（L2）互不推导。
          plannedAt: task.planned_at ?? null,
          // 排期按钮可见性与 plan-set 动作同源（planSetGate）：终态任务不可排期。
          canPlan: canSetPlan(task),
          dependsOn: Array.isArray(task.depends_on) ? task.depends_on : [],
          writeScopes: Array.isArray(task.write_scopes) ? task.write_scopes : [],
          priority: task.priority ?? 0,
          question: task.question ?? null,
          options: Array.isArray(task.options) ? task.options : [],
          artifacts: Array.isArray(task.artifacts) ? task.artifacts : [],
          // delivered 两段式：交付时间 / 关闭原因（供面板显示「待确认」「协调者确认/超时」）。
          deliveredAt: task.delivered_at ?? null,
          closeReason: task.close_reason ?? null,
          // P2-3 交接契约 v1（精简）：契约版本 + 交付/确认时间 + 确认方式 + 验收结论；没交接是 null。
          handoff: handoffSnapshot(task),
          // P2-4（D6）：官方 Team 板关联（创建时读到的 CAS 基线）；没关联是 null。
          teamTask: task.team_task_id === null
            ? null
            : { id: task.team_task_id, revision: task.team_task_revision ?? null },
          // P2-1 A1：验收摘要（列表/卡片小标用；完整证据在面板 detail 端点）。
          acceptance: task.acceptance === null || task.acceptance === undefined
            ? null
            : {
              ok: task.acceptance.ok === true,
              total: Number.isFinite(task.acceptance.total) ? task.acceptance.total : 0,
              passed: Number.isFinite(task.acceptance.passed) ? task.acceptance.passed : 0,
              skipped: Number.isFinite(task.acceptance.skipped) ? task.acceptance.skipped : 0,
              failed: Number.isFinite(task.acceptance.failed) ? task.acceptance.failed : 0,
              ranAt: Number.isFinite(task.acceptance.ranAt) ? task.acceptance.ranAt : null,
            },
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
    if (endpoint === 'adopt-session') {
      // 0.25.0：把已有会话设为协调者（只切指针；不改名、不归档、不退役旧会话）。
      if (typeof adoptSession !== 'function') return json(panelFailure('ADOPT_UNAVAILABLE'), 500)
      const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
      if (sessionId === '') return json(panelFailure('ADOPT_NO_SESSION'), 409)
      let result
      try {
        result = await adoptSession({ sessionId })
      } catch (error) {
        return json(panelFailure('ADOPT_FAILED', { reason: error?.message ?? error }), 500)
      }
      if (result?.ok === true) {
        return json({ ok: true, sessionId: result.sessionId, previous: result.previous ?? null, unchanged: result.unchanged === true }, 200)
      }
      return json(panelFailure(result?.code ?? 'ADOPT_FAILED', result?.params ?? {}), panelHttpStatus({ code: result?.code ?? 'ADOPT_FAILED' }))
    }
    if (endpoint === 'session-role') {
      // 客户端面板闸门：只回答「这个会话是不是主会话」，不写台账、不建会话。
      // 信号与 task_* 工具同源（coordinatorStatus → settings.main_session_id）；
      // 任何一侧缺失都按 false 回答，客户端据此默认隐藏任务入口（见 src/session-role.js）。
      const status = coordinatorStatus?.() ?? {}
      const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
      return json({ ok: true, isMain: isMainSession(sessionId, status.id) }, 200)
    }
    if (WORKBENCH_READS.has(endpoint)) {
      // 只读投影：不写台账、不 spawn；组/排期/自动化各自独立失败（面板可分区降级）。
      if (workbench === undefined) return json(panelFailure('PANEL_ACTIONS_UNAVAILABLE'), 500)
      try {
        const result = endpoint === 'groups'
          ? workbench.groups()
          : endpoint === 'group'
            ? workbench.group(body?.groupId)
            : endpoint === 'calendar'
              ? workbench.calendar({ from: body?.from, to: body?.to })
              : endpoint === 'stats'
                ? workbench.stats({ days: body?.days })
                : await workbench.automations()
        return json(result, panelHttpStatus(result))
      } catch (error) {
        return json(panelFailure('ACTION_FAILED', { reason: error?.message ?? error }), 500)
      }
    }
    if (WORKBENCH_WRITES.has(endpoint)) {
      // 窄写口：owner-only（connection 统一鉴权）+ clientRequestId 幂等 + 危险动作 confirm（见 src/workbench.js）。
      if (workbench === undefined) return json(panelFailure('PANEL_ACTIONS_UNAVAILABLE'), 500)
      const targetKey = String(body?.id ?? body?.taskId ?? body?.groupId ?? '')
      const requestId = typeof body?.clientRequestId === 'string'
        ? body.clientRequestId.trim().slice(0, 128)
        : ''
      const execute = async () => {
        try {
          if (endpoint === 'group-save') return await workbench.saveGroup(body)
          if (endpoint === 'group-archive') return await workbench.archiveGroup(body)
          if (endpoint === 'plan-set') return await workbench.setPlan(body)
          if (endpoint === 'automation-save') return await workbench.saveAutomation(body)
          if (endpoint === 'automation-toggle') return await workbench.toggleAutomation(body)
          return await workbench.deleteAutomation(body)
        } catch (error) {
          return panelFailure('ACTION_FAILED', { reason: error?.message ?? error })
        }
      }
      if (requestId === '') {
        const result = await execute()
        return json(result, panelHttpStatus(result))
      }
      const outcome = await workbenchDedupe.run(`${endpoint}|${targetKey}`, requestId, execute)
      const result = outcome.duplicate && outcome.result?.ok === true
        ? { ...outcome.result, already: true, duplicate: true }
        : outcome.result
      return json(result, panelHttpStatus(result))
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
