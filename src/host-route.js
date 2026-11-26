// /api/orchestrator 路由的 handler。
// 平台只保证 401/403 + owner-only（connection.admit），不保证只读：
// snapshot / session-role / main-nav 只查台账或读进程内待办、不写台账、不 spawn；
// open-main / adopt-session 建或切主会话；main-nav-ack 只清那条进程内待办（不写台账/settings）；
// 其余动作端点走 panel / workbench 的既有门控。
import { listTasks, listHistoryTasks } from './ledger.js'
import { taskCard } from './card.js'
import { panelFailure, panelHttpStatus } from './action-errors.js'
import { createRequestDedupe } from './request-dedupe.js'
import { isCoordinator } from './session-role.js'
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
// 0.32.0 能力包面板（P4）：一个只读快照 + 窄写口。
// 注意这里**没有** create/update（工厂只在协调者工具里）；面板只做「开包会话 / 装卸载 CLI /
// 环境变量 / 删除用户包」，每个写动作都要宿主侧 confirm（面板按钮不是授权）。
const PACK_READS = new Set(['pack-snapshot', 'pack-describe'])
const PACK_WRITES = new Set(['pack-open', 'pack-install', 'pack-uninstall', 'pack-delete', 'pack-env-copy', 'pack-env-set'])

/** 能力包动作的 HTTP 状态：确认缺失/计划过期用 409（客户端可据 code 给二次确认），其余 400/500。 */
const packHttpStatus = code => {
  if (code === 'CONFIRM_REQUIRED' || code === 'PLAN_STALE' || code === 'IDEMPOTENCY_CONFLICT') return 409
  if (code === 'PACK_NOT_FOUND' || code === 'CLI_UNKNOWN') return 404
  if (code === 'PLATFORM_UNSUPPORTED' || code === 'CAPABILITY_PACKS_DISABLED') return 400
  if (code === 'BUILTIN_READONLY' || code === 'PACK_EXISTS' || code === 'DRAFT_INVALID' || code === 'ENV_NOT_DECLARED') return 409
  return 500
}
const ACTIVE = new Set(ACTIVE_STATUSES)
// 「待拍板」口径：等人（waiting_user/waiting_auth）+ 已交付待确认（delivered）——`waiting` 能力
// 不含 delivered（它不 waiting 于某个问题，而是等确认），所以这里用两份能力拼，不再写内联三态判断。
const INBOX_STATUSES = new Set([...statusesWith('waiting'), 'delivered'])

const json = (value, status) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json' },
})

export function createHostRoute({ db, coordinatorStatus, openMain, adoptSession, dropCoordinator, mainNav, contextSnapshot, panel, workbench, teamBoard, packs, staleMinutes = 30, limit = 200, now = Date.now }) {
  // message 请求级幂等：按 (taskId, clientRequestId) 去重，只在进程内（重启失效，见 request-dedupe.js）。
  const dedupe = createRequestDedupe({ max: 200 })
  // 工作台写动作的请求级幂等（同一个 endpoint + 目标 id + clientRequestId 只执行一次）。
  const workbenchDedupe = createRequestDedupe({ max: 200 })
  // 能力包写动作（开包会话/安装/删除/环境变量）同样按 clientRequestId 去重：
  // 面板重复点击/网络重发不该装两次、开两个会话。env-set 的值不参与缓存键（键只含 endpoint+id+ref）。
  const packDedupe = createRequestDedupe({ max: 200 })
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
    // 0.36.0 多协调者：`mainSession.id` 仍是**主协调者**（面板「主会话在线/已失效」沿用它），
    // 另下发整份名单与每个成员的在线状态，供面板渲染「协调者 N」与「本会话退出」。
    const ids = Array.isArray(status.ids) ? status.ids : (status.id === undefined ? [] : [status.id])
    const coordinators = Array.isArray(status.coordinators)
      ? status.coordinators
      : ids.map((id, index) => ({ id, primary: index === 0, live: null }))
    return {
      ok: true,
      at,
      mainSession: {
        id: status.id ?? null,
        ids,
        live: status.live === true,
        anyLive: status.anyLive === true || status.live === true,
        coordinators,
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
          // 版本 B《ID 出口网关》：面板/抽屉显示的是**任务引用**（tk-）；`id` 只作为动作键
          // （stop/message/close/delete 仍按台账 id 调），客户端不得把 id 渲染到界面上。
          ref: task.ref ?? null,
          title: task.title,
          status: task.status,
          label: card.label,
          tone: card.tone,
          childSessionId: task.session_id ?? null,
          // 会话归属：客户端「回复底部 chip」按这个字段判断任务是不是当前会话派出的。
          // 只下发 id（不是敏感数据），与 mainSession.id 同源（settings.main_session_id）。
          coordinatorSession: task.coordinator_session ?? null,
          targetDir: task.target_dir ?? null,
          artifactDir: task.artifact_dir ?? null,
          artifactStoreDir: task.artifact_store_dir ?? null,
          artifactStage: task.artifact_stage ?? null,
          deliveryPending: task.delivery_pending !== null,
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
      // 0.36.0：把已有会话设为协调者 = **加入名单并提升为主**（旧协调者留在名单里，不改名、不归档）。
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
        return json({
          ok: true,
          sessionId: result.sessionId,
          previous: result.previous ?? null,
          unchanged: result.unchanged === true,
          added: result.added === true,
          promoted: result.promoted === true,
          ids: Array.isArray(result.ids) ? result.ids : [],
          primary: result.primary ?? null,
        }, 200)
      }
      return json(panelFailure(result?.code ?? 'ADOPT_FAILED', result?.params ?? {}), panelHttpStatus({ code: result?.code ?? 'ADOPT_FAILED' }))
    }
    if (endpoint === 'drop-coordinator') {
      // 0.36.0：面板「本会话退出协调者」→ 只改名单（删首位则下一位升主；删光等价「尚未打开主会话」）。
      if (typeof dropCoordinator !== 'function') return json(panelFailure('DROP_UNAVAILABLE'), 500)
      const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
      if (sessionId === '') return json(panelFailure('DROP_NO_SESSION'), 409)
      let result
      try {
        result = await dropCoordinator({ sessionId })
      } catch (error) {
        return json(panelFailure('DROP_FAILED', { reason: error?.message ?? error }), 500)
      }
      if (result?.ok === true) {
        return json({
          ok: true,
          sessionId: result.sessionId,
          ids: Array.isArray(result.ids) ? result.ids : [],
          primary: result.primary ?? null,
          primaryChanged: result.primaryChanged === true,
        }, 200)
      }
      return json(panelFailure(result?.code ?? 'DROP_FAILED', result?.params ?? {}), panelHttpStatus({ code: result?.code ?? 'DROP_FAILED' }))
    }
    if (endpoint === 'session-role') {
      // 客户端面板闸门：只回答「这个会话是不是协调者」，不写台账、不建会话。
      // 0.36.0：判定 = 会话 ∈ 协调者名单（主/副协调者一视同仁）；响应形状保持 `{ ok, isMain }`，
      // 客户端 gate.js 的三角色语义不变（因此客户端侧零改动就能让所有协调者看到「任务」入口）。
      const status = coordinatorStatus?.() ?? {}
      const ids = Array.isArray(status.ids) ? status.ids : (status.id === undefined ? [] : [status.id])
      const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
      return json({ ok: true, isMain: isCoordinator(sessionId, ids), coordinatorCount: ids.length }, 200)
    }
    if (endpoint === 'main-nav') {
      // t-a79e12d8：只读轮询「要不要跳到新主会话 / 有没有一条可读提示」。
      // 待办是进程内的短命事实（默认 5 分钟过期）：这里不清它，客户端处理完才用 main-nav-ack 清。
      const nav = typeof mainNav?.read === 'function' ? mainNav.read() : null
      return json({ ok: true, nav: nav ?? null }, 200)
    }
    if (endpoint === 'main-nav-ack') {
      // 客户端处理完待办后确认：id 匹配才清（多客户端时先到先得，后到的不再重复导航）。
      // 不写台账、不写 settings、不碰会话——失败只记审计（main.nav.navigate-failed）。
      if (typeof mainNav?.ack !== 'function') return json({ ok: true, cleared: false }, 200)
      const outcome = mainNav.ack({
        id: typeof body?.id === 'string' ? body.id : '',
        ok: body?.ok === true,
        error: typeof body?.error === 'string' ? body.error : '',
      })
      return json({ ok: true, cleared: outcome?.cleared === true }, 200)
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
    if (PACK_READS.has(endpoint)) {
      // 只读投影：snapshot 不写盘、不 spawn；describe 只补充安装卡与静态兜底。
      if (packs === undefined) return json({ ok: false, code: 'CAPABILITY_PACKS_UNAVAILABLE', error: '能力包未装配（宿主侧 pack service 缺失）' }, 500)
      try {
        const result = endpoint === 'pack-snapshot' ? packs.snapshot() : await packs.describe(String(body?.id ?? ''))
        return json(result, result?.ok === true ? 200 : packHttpStatus(result?.code))
      } catch (error) {
        return json({ ok: false, code: 'PACK_ACTION_FAILED', error: error?.message ?? String(error) }, 500)
      }
    }
    if (PACK_WRITES.has(endpoint)) {
      // 窄写口：owner-only（connection 统一鉴权）+ 请求级幂等 + 宿主侧 confirm/planHash。
      // env-set 的 `value` 只在本次请求体内存在：这里不读日志、不回显、不参与幂等键。
      if (packs === undefined) return json({ ok: false, code: 'CAPABILITY_PACKS_UNAVAILABLE', error: '能力包未装配（宿主侧 pack service 缺失）' }, 500)
      const id = typeof body?.id === 'string' ? body.id : ''
      const ref = typeof body?.ref === 'string' ? body.ref : ''
      const cliId = typeof body?.cliId === 'string' ? body.cliId : undefined
      const requestId = typeof body?.clientRequestId === 'string' ? body.clientRequestId.trim().slice(0, 128) : ''
      const execute = async () => {
        try {
          if (endpoint === 'pack-open') return await packs.open(id, body?.cwd)
          if (endpoint === 'pack-install') return await packs.install(id, cliId, { confirm: body?.confirm === true, planHash: body?.planHash })
          if (endpoint === 'pack-uninstall') return await packs.uninstall(id, cliId)
          if (endpoint === 'pack-delete') return await packs.remove(id, { confirm: body?.confirm === true })
          if (endpoint === 'pack-env-copy') return await packs.envCopy(id, ref)
          return await packs.envSet(id, ref, typeof body?.value === 'string' ? body.value : '', { confirm: body?.confirm === true })
        } catch (error) {
          return { ok: false, code: 'PACK_ACTION_FAILED', error: error?.message ?? String(error) }
        }
      }
      const key = `${endpoint}|${id}|${ref}|${cliId ?? ''}`
      const result = requestId === ''
        ? await execute()
        : (await packDedupe.run(key, requestId, execute)).result
      return json(result, result?.ok === true ? 200 : packHttpStatus(result?.code))
    }
    if (ACTIONS.has(endpoint)) {
      if (panel === undefined) return json(panelFailure('PANEL_ACTIONS_UNAVAILABLE'), 500)
      try {
        let result
        if (endpoint === 'detail') {
          // P1：详情默认给同步快照；有 detailBody 时再按需冷读宿主会话日志补「最新回复」正文。
          result = typeof panel.detailBody === 'function'
            ? await panel.detailBody(body?.taskId)
            : panel.detail(body?.taskId)
        }
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
