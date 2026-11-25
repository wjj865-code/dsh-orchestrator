// 工作台 v1（P11）的服务端实现：组一等的只读投影 + 三个窄写口 + 原生自动化的桥。
//
// 边界（设计稿 §5，实施时不得放宽）：
// - 只读投影 `groups` / `group` / `calendar` / `automations` 不写台账、不 spawn、不改任务状态；
// - 写动作只有 `group-save` / `group-archive` / `plan-set` / `automation-*`，全部 owner-only + clientRequestId
//   幂等（路由层做）+ confirm（危险动作）+ 审计日志；
// - **不提供** task-create / plan-approve / message / close-all / patch-task（设计稿 §5.3 反例清单）：
//   派发必须过协调者，计划批准与交付确认必须过既有闸门。
// - 自动化的真身是宿主 `ctx.schedule`（服务层形状：create/list/view/edit + timing kind：
//   after/at/every/daily/weekly/cron/rrule，证据见本次探针）。本模块只做镜像、授权审计与降级。
import {
  getTask, listTasks, listAutomations, getAutomation, insertAutomation, updateAutomationRow,
  listGroupMeta, getGroupMeta, listGroupKeys, groupStatusCounts, upsertGroupMeta, setGroupArchived,
  setTaskPlannedAt, getMainSessionId, countMessagesBetween,
} from './ledger.js'
import { panelFailure } from './action-errors.js'
import {
  planSetGate, groupSaveGate, groupArchiveGate, automationGate,
} from './panel-gates.js'
import { statusLabel } from './state.js'
import { statusesWith } from './status-facts.js'
import { taskLabel, taskLabelWithRef } from './task-label.js'
import { taskRefTokenOfAny } from './task-ref.js'
import { STATUS_TONE } from './status-tone.js'

/** 工作台投影的硬上限（防止一个大组/一个长窗口把面板拖死）。 */
export const WORKBENCH_LIMITS = Object.freeze({
  groups: 200,
  groupTasks: 300,
  groupArtifacts: 200,
  calendarWindowDays: 62,
  calendarNext: 5,
  // 复盘页（P11 阶段 3）：窗口上限与三个投影的条数上限（面板只画数字卡 + 条 + 排行表）。
  reviewWindowDays: 62,
  reviewGroups: 10,
  reviewReasons: 5,
  reviewArtifacts: 8,
})

/** 组名 / 自动化标题 / 话术的长度上限（标题跟宿主 `title ≤ 120` 对齐）。 */
export const GROUP_NAME_MAX = 40
export const AUTOMATION_TITLE_MAX = 120
export const AUTOMATION_PROMPT_MAX = 2000

const ACTIVE_FOR_GROUP = statusesWith('active')
const DAY_MS = 24 * 60 * 60 * 1000
const PLAN_WINDOW_MS = 366 * DAY_MS * 2

const text = value => (typeof value === 'string' ? value.trim() : '')
const pad = value => String(value).padStart(2, '0')

/** 本地时区名（宿主没有 zone 服务；与日报 `digest.js` 同口径，取系统时区）。 */
export function localZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** 本地日键 `YYYY-MM-DD`（日历格与「今日」判定都用它，跨时区不漂）。 */
export function dayKeyOf(ms) {
  const date = new Date(Number.isFinite(ms) ? ms : Date.now())
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** `HH:MM` / `HH:MM:SS` → 宿主要求的 `HH:MM:SS.SSS`；非法返回 null。 */
export function normalizeTime(value) {
  const match = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/.exec(text(value))
  if (match === null) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  const second = match[3] === undefined ? 0 : Number(match[3])
  if (!(hour <= 23 && minute <= 59 && second <= 59)) return null
  return `${pad(hour)}:${pad(minute)}:${pad(second)}.000`
}

const CRON_FIELD = /^[0-9*/,LW#-]+$/i

/**
 * 把面板发来的时间选择器归一成宿主 `ScheduleTiming`（**只允许**白名单三种 + rrule 直通）。
 * @returns {{ok: true, timing: object} | {ok: false, reason: string}}
 */
export function normalizeTiming(input, { zone } = {}) {
  const timeZone = text(input?.time_zone) || text(zone) || localZone()
  const kind = text(input?.kind)
  if (kind === 'daily') {
    const time = normalizeTime(input?.time)
    if (time === null) return { ok: false, reason: '每天触发需要一个 HH:MM 时间' }
    return { ok: true, timing: { kind: 'daily', daily: { time, time_zone: timeZone } } }
  }
  if (kind === 'weekly') {
    const time = normalizeTime(input?.time)
    if (time === null) return { ok: false, reason: '每周触发需要一个 HH:MM 时间' }
    const weekdays = Array.isArray(input?.weekdays)
      ? [...new Set(input.weekdays.map(Number))].filter(day => Number.isSafeInteger(day) && day >= 1 && day <= 7).sort((a, b) => a - b)
      : []
    if (weekdays.length === 0) return { ok: false, reason: '每周触发至少要选一天（周一到周日）' }
    return { ok: true, timing: { kind: 'weekly', weekly: { time, time_zone: timeZone, weekdays } } }
  }
  if (kind === 'cron') {
    const expression = text(input?.expression).split(/\s+/).filter(Boolean)
    if (expression.length !== 5 || expression.some(field => !CRON_FIELD.test(field))) {
      return { ok: false, reason: 'cron 需要 5 段（分 时 日 月 周），例如 0 9 * * 1-5' }
    }
    return { ok: true, timing: { kind: 'cron', cron: { expression: expression.join(' '), time_zone: timeZone } } }
  }
  if (kind === 'rrule') {
    const rrule = text(input?.rrule).replace(/\s+/g, ' ')
    if (!/^FREQ=/i.test(rrule)) return { ok: false, reason: 'rrule 需要以 FREQ= 开头，例如 FREQ=DAILY' }
    return { ok: true, timing: { kind: 'rrule', rrule } }
  }
  return { ok: false, reason: '支持的触发方式：每天 / 每周 / cron / rrule' }
}

const WEEKDAY_TEXT = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

/** 人类可读的触发规则（面板与工具返回共用；不从宿主读，避免两处文案漂移）。 */
export function timingText(timing) {
  if (timing === null || typeof timing !== 'object') return '（未知节奏）'
  if (timing.kind === 'daily' && timing.daily) {
    const time = String(timing.daily.time ?? '').slice(0, 5)
    return `每天 ${time || '--:--'}`
  }
  if (timing.kind === 'weekly' && timing.weekly) {
    const time = String(timing.weekly.time ?? '').slice(0, 5)
    const days = Array.isArray(timing.weekly.weekdays)
      ? timing.weekly.weekdays.map(day => WEEKDAY_TEXT[Number(day) - 1] ?? `周${day}`).join('、')
      : ''
    return `每${days} ${time || '--:--'}`
  }
  if (timing.kind === 'cron' && timing.cron) return `cron ${String(timing.cron.expression ?? '')}`
  if (timing.kind === 'rrule') return `rrule ${String(timing.rrule ?? '')}`
  return '（未知节奏）'
}

/** 到期发给协调者的话术：只描述意图（交给协调者自己 task_list 核对后 task_create）。 */
export function defaultPrompt({ kind, refId, what = '' } = {}) {
  const ask = text(what) === '' ? '推进这里还没完成的事' : text(what)
  if (kind === 'group') {
    const group = text(refId).replace(/[\r\n]+/g, ' ')
    return [
      `到点了：请处理任务组「${group}」——${ask}。`,
      `先 task_list({ group: '${group}' }) 看组内现状，只补需要推进的任务（task_create({ group: '${group}', ... })），已存在或已完成的不重复派；没有要做的就只回一句「无需派单」。`,
    ].join('\n')
  }
  if (kind === 'task') {
    return `到点了：请跟进任务 ${text(refId)}——${ask}。先 task_status 看进展，需要续派用 task_message，不要新建重复任务；不需要动作就只回一句「无需派单」。`
  }
  return `到点了：${ask}。先 task_list({ view: 'inbox' }) 与 task_list 看现状，只补需要推进的任务（task_create），已存在的不重复派；没有要做的就只回一句「无需派单」。`
}

/**
 * 组卡投影（纯函数）：把「组键并集 + 元数据 + 状态计数 + 任务 + 自动化」压成面板要的行。
 * @returns {Array<object>} 每行字段见函数体；顺序：未归档在前、最近活跃在前。
 */
export function groupRollups({ keys = [], meta = [], counts = new Map(), tasks = [], automations = [], now = Date.now() } = {}) {
  const metaById = new Map(meta.map(row => [row.id, row]))
  const taskByGroup = new Map()
  for (const task of tasks) {
    const id = task.group_id
    if (typeof id !== 'string' || id === '') continue
    const list = taskByGroup.get(id) ?? []
    list.push(task)
    taskByGroup.set(id, list)
  }
  const automationByGroup = new Map()
  for (const row of automations) {
    if (row.kind !== 'group' || row.deleted_at !== null) continue
    const list = automationByGroup.get(row.ref_id) ?? []
    list.push(row)
    automationByGroup.set(row.ref_id, list)
  }
  const rows = []
  for (const id of keys) {
    const row = metaById.get(id) ?? null
    const stat = counts.get(id) ?? { total: 0 }
    const groupTasks = taskByGroup.get(id) ?? []
    // 台账的 `active` 能力含 delivered（待确认也算活跃）；组卡把「待确认」单列，所以这里减掉它。
    const active = ACTIVE_FOR_GROUP.reduce((sum, status) => sum + (stat[status] ?? 0), 0) - (stat.delivered ?? 0)
    const failed = (stat.failed ?? 0) + (stat.orphaned ?? 0)
    let artifactCount = 0
    let lastEventAt = 0
    let nextPlannedAt = null
    for (const task of groupTasks) {
      artifactCount += Array.isArray(task.artifacts) ? task.artifacts.length : 0
      if (Number.isFinite(task.last_event_at)) lastEventAt = Math.max(lastEventAt, task.last_event_at)
      if (Number.isFinite(task.planned_at) && task.planned_at > now) {
        nextPlannedAt = nextPlannedAt === null ? task.planned_at : Math.min(nextPlannedAt, task.planned_at)
      }
    }
    const automationsOfGroup = automationByGroup.get(id) ?? []
    rows.push({
      id,
      name: row === null ? id : row.name,
      goal: row === null ? null : row.goal,
      color: row === null ? null : row.color,
      archived: row === null ? false : row.archived === true,
      // virtual = 只有 tasks.group_id、还没有元数据行（工作台第一次改名时会补上元数据）
      virtual: row === null,
      updatedAt: row === null ? null : row.updated_at,
      counts: {
        total: stat.total ?? 0,
        active,
        delivered: stat.delivered ?? 0,
        done: stat.done ?? 0,
        failed,
      },
      artifactCount,
      lastEventAt: lastEventAt === 0 ? null : lastEventAt,
      nextPlannedAt,
      automationCount: automationsOfGroup.length,
      automationActiveCount: automationsOfGroup.filter(item => item.active === true).length,
      // 与动作同源：归档组不能改名，未归档组都能归档（软删）。
      canRename: row === null ? true : row.archived !== true,
      canArchive: true,
    })
  }
  rows.sort((left, right) => {
    if (left.archived !== right.archived) return left.archived ? 1 : -1
    const leftAt = left.lastEventAt ?? 0
    const rightAt = right.lastEventAt ?? 0
    if (leftAt !== rightAt) return rightAt - leftAt
    return left.id.localeCompare(right.id)
  })
  return rows
}

/**
 * 日历投影（纯函数）：只取 [from, to] 窗口内「有排期任务」或「有自动化触发」的日子。
 * @returns {{from: number, to: number, days: Array<{date: string, tasks: object[], automations: object[]}>}}
 */
export function calendarWindow({ tasks = [], automations = [], from, to } = {}) {
  const days = new Map()
  const bucket = date => {
    const found = days.get(date) ?? { date, tasks: [], automations: [] }
    days.set(date, found)
    return found
  }
  for (const task of tasks) {
    if (!Number.isFinite(task.planned_at) || task.planned_at < from || task.planned_at > to) continue
    bucket(dayKeyOf(task.planned_at)).tasks.push({
      id: task.id,
      ref: task.ref ?? null,
      title: task.title,
      status: task.status,
      tone: STATUS_TONE[task.status] ?? 'muted',
      groupId: task.group_id ?? null,
      plannedAt: task.planned_at,
      artifactCount: Array.isArray(task.artifacts) ? task.artifacts.length : 0,
    })
  }
  for (const row of automations) {
    if (!Number.isFinite(row.nextFireAt) || row.nextFireAt < from || row.nextFireAt > to) continue
    bucket(dayKeyOf(row.nextFireAt)).automations.push({
      id: row.id,
      title: row.title,
      kind: row.kind,
      refId: row.ref_id ?? null,
      timingText: timingText(row.timing),
      nextFireAt: row.nextFireAt,
      active: row.active === true,
    })
  }
  const sorted = [...days.values()].sort((left, right) => left.date.localeCompare(right.date))
  for (const day of sorted) {
    day.tasks.sort((left, right) => left.plannedAt - right.plannedAt)
    day.automations.sort((left, right) => left.nextFireAt - right.nextFireAt)
  }
  return { from, to, days: sorted }
}

/** 下一个要做的排期（组卡/总览/排期右栏共用同一口径）。 */
export function nextPlanned(tasks = [], now = Date.now()) {
  let best = null
  for (const task of tasks) {
    if (!Number.isFinite(task.planned_at) || task.planned_at < now) continue
    if (best === null || task.planned_at < best.planned_at) best = task
  }
  return best
}

const parseStamp = value => {
  if (typeof value !== 'string' || value === '') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/** 未分组任务在组排行里的固定键（不落库，与组页的「未分组」虚拟卡同口径）。 */
export const UNGROUPED_KEY = '__ungrouped__'

/** 失败归因：取 `tasks.error` 首行（截 60 字）；没有错误信息时回落状态名，不猜原因。 */
export function failureReasonOf(task) {
  const line = String(task?.error ?? '').split('\n')[0].trim()
  if (line !== '') return line.slice(0, 60)
  return task?.status === 'orphaned' ? '会话丢失（没有错误信息）' : '失败（没有错误信息）'
}

/** 产物类型：只按路径扩展名归类，**不读文件内容**。 */
export function artifactKindOf(path) {
  const name = String(path ?? '').split(/[\\/]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return '无扩展名'
  const ext = name.slice(dot + 1).toLowerCase()
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : '其他'
}

/**
 * 复盘页的纯投影（设计稿 §3.6）：**只用台账既有时间戳**（created_at / delivered_at / accepted_at /
 * updated_at）、`tasks.error` 首行、产物路径与 messages 条数。不新增埋点、不读产物文件内容。
 * 口径：交付/确认 = 落在窗口内的 delivered_at / accepted_at；平均时长只统计窗口内交付且有 created_at 的行；
 * 失败 = 窗口内 updated_at 且状态 failed/orphaned；组排行 = 窗口内有创建/交付/失败的任务。
 */
export function reviewStats({ tasks = [], groups = [], messages = 0, days = 7, now = Date.now() } = {}) {
  const windowDays = Math.min(WORKBENCH_LIMITS.reviewWindowDays, Math.max(1, Math.trunc(Number(days)) || 7))
  const to = now
  const from = to - windowDays * DAY_MS
  const inWindow = ms => Number.isFinite(ms) && ms >= from && ms <= to
  const delivered = tasks.filter(task => inWindow(task.delivered_at))
  const accepted = tasks.filter(task => inWindow(task.accepted_at)).length
  const spans = delivered
    .map(task => task.delivered_at - task.created_at)
    .filter(ms => Number.isFinite(ms) && ms >= 0)
  const avgDeliverMs = spans.length === 0 ? null : Math.round(spans.reduce((sum, ms) => sum + ms, 0) / spans.length)
  const failed = tasks.filter(task => (task.status === 'failed' || task.status === 'orphaned') && inWindow(task.updated_at))
  const failedIds = new Set(failed.map(task => task.id))
  const reasons = new Map()
  for (const task of failed) {
    const reason = failureReasonOf(task)
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1)
  }
  const failures = [...reasons.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason))
    .slice(0, WORKBENCH_LIMITS.reviewReasons)
  // 产物：窗口内「创建或交付」的任务的产物，按扩展名计数，同一路径只算一次（不读文件内容）。
  const kinds = new Map()
  const paths = new Set()
  for (const task of tasks) {
    if (!inWindow(task.created_at) && !inWindow(task.delivered_at)) continue
    for (const artifact of Array.isArray(task.artifacts) ? task.artifacts : []) {
      const path = text(artifact?.path)
      if (path === '' || paths.has(path)) continue
      paths.add(path)
      const kind = artifactKindOf(path)
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1)
    }
  }
  const artifacts = [...kinds.entries()]
    .map(([ext, count]) => ({ ext, count }))
    .sort((left, right) => right.count - left.count || left.ext.localeCompare(right.ext))
    .slice(0, WORKBENCH_LIMITS.reviewArtifacts)
  const names = new Map(groups.map(row => [row.id, row.name]))
  const rank = new Map()
  const bump = (key, field) => {
    if (!rank.has(key)) {
      rank.set(key, {
        id: key === UNGROUPED_KEY ? '' : key,
        name: key === UNGROUPED_KEY ? '未分组' : (text(names.get(key)) || key),
        delivered: 0, failed: 0, total: 0,
      })
    }
    rank.get(key)[field] += 1
  }
  for (const task of tasks) {
    const active = inWindow(task.created_at) || inWindow(task.delivered_at) || failedIds.has(task.id)
    if (!active) continue
    const key = text(task.group_id) === '' ? UNGROUPED_KEY : text(task.group_id)
    bump(key, 'total')
    if (inWindow(task.delivered_at)) bump(key, 'delivered')
    if (failedIds.has(task.id)) bump(key, 'failed')
  }
  const rows = [...rank.entries()]
    .sort((left, right) => right[1].delivered - left[1].delivered
      || right[1].failed - left[1].failed
      || right[1].total - left[1].total
      || left[1].name.localeCompare(right[1].name))
    .slice(0, WORKBENCH_LIMITS.reviewGroups)
    .map(([, row]) => row)
  return {
    ok: true,
    at: to,
    days: windowDays,
    from,
    to,
    delivered: delivered.length,
    accepted,
    avgDeliverMs,
    failed: failed.length,
    messages: Number.isFinite(messages) ? messages : 0,
    failures,
    artifacts,
    groups: rows,
  }
}

/**
 * 工作台动作/投影工厂。
 * @param {object} deps
 * @param {object} deps.db 台账
 * @param {() => object|undefined} [deps.schedule] 宿主 ctx.schedule 服务（没有时自动化整页降级）
 * @param {() => string|undefined} [deps.mainSessionId] 唯一主会话 id（自动化强制投递目标）
 * @param {(event: string, fields?: object) => void} [deps.log] 审计日志（只记 id 与结果，不记话术全文）
 * @param {() => number} [deps.now]
 */
export function createWorkbench({ db, schedule, mainSessionId, log = () => {}, now = Date.now } = {}) {
  // 自动化下次触发时间的进程内缓存（`schedule_id -> ms`）：`calendar` 是同步投影，不 await 宿主；
  // 由 `automations()` 每次读宿主时刷新（打开自动化页或排期页时各拉一次）。
  const cachedFireAt = new Map()
  const scheduleService = () => {
    try {
      const service = typeof schedule === 'function' ? schedule() : schedule
      return service !== null && typeof service === 'object' ? service : undefined
    } catch {
      return undefined
    }
  }
  const mainIdOf = () => {
    try {
      const value = typeof mainSessionId === 'function' ? mainSessionId() : mainSessionId
      if (typeof value === 'string' && value !== '') return value
      return getMainSessionId(db) ?? undefined
    } catch {
      return getMainSessionId(db) ?? undefined
    }
  }
  const isAvailable = () => {
    const service = scheduleService()
    return service !== undefined
      && typeof service.create === 'function'
      && typeof service.view === 'function'
      && typeof service.edit === 'function'
  }

  /** 宿主侧读一条 schedule（失败/缺失都当「读不到」，不 500）。 */
  const hostView = async id => {
    if (!isAvailable() || typeof id !== 'string' || id === '') return null
    try {
      const result = await scheduleService().view({ id })
      if (result === null || typeof result !== 'object') return null
      if (typeof result.code === 'string') return { missing: true, code: result.code }
      return result
    } catch {
      return null
    }
  }

  const automationRow = (row, host) => {
    const nextFireAt = host !== null && !host.missing && typeof host.scheduledAt === 'string'
      ? parseStamp(host.scheduledAt)
      : null
    // R1：绑定「单条任务」的自动化，绑的其实是台账编号（`ref_id`）。面板显示一律用**任务名 + 引用**
    // （`taskLabelWithRef`），不再把 `t-xxxx` 当标签贴出来；任务已删除时才回落到它的墓碑引用。
    const boundTask = row.kind === 'task' && typeof row.ref_id === 'string' && row.ref_id !== ''
      ? getTask(db, row.ref_id)
      : undefined
    const boundRef = boundTask === undefined
      ? (typeof row.ref_id === 'string' && row.ref_id !== '' ? taskRefTokenOfAny(db, row.ref_id) : null)
      : (boundTask.ref ?? null)
    return {
      id: row.id,
      kind: row.kind,
      refId: row.ref_id,
      // refLabel = 面板上那一句「任务 X（tk-xxxxxx）」；ref 单独给引用，前端做 chip 用。
      refLabel: boundTask !== undefined
        ? taskLabelWithRef(boundTask)
        : (boundRef ?? row.ref_id),
      ref: boundRef,
      title: row.title,
      prompt: row.prompt,
      timing: row.timing,
      timingText: timingText(row.timing),
      active: row.active === true,
      scheduleId: row.schedule_id,
      targetSession: row.target_session,
      authorizedAt: row.authorized_at,
      lastFiredAt: row.last_fired_at,
      lastResult: row.last_result,
      nextFireAt,
      hostStatus: host !== null && !host.missing && typeof host.status === 'string' ? host.status : null,
      hostMissing: host !== null && host.missing === true,
      lastDeliveryAt: host !== null && host.lastDelivery !== undefined && typeof host.lastDelivery?.deliveredAt === 'string'
        ? parseStamp(host.lastDelivery.deliveredAt)
        : null,
      updatedAt: row.updated_at,
    }
  }

  const groupExists = id => {
    if (getGroupMeta(db, id) !== undefined) return true
    return listGroupKeys(db).includes(id)
  }

  const allTasks = () => listTasks(db, { active: false })

  return {
    /** 只读：组清单 + 每组滚动统计。 */
    groups() {
      const at = now()
      const tasks = allTasks()
      const keys = new Set(listGroupKeys(db))
      for (const row of listGroupMeta(db)) keys.add(row.id)
      const rows = groupRollups({
        keys: [...keys].slice(0, WORKBENCH_LIMITS.groups),
        meta: listGroupMeta(db),
        counts: groupStatusCounts(db),
        tasks,
        automations: listAutomations(db),
        now: at,
      })
      const ungrouped = tasks.filter(task => typeof task.group_id !== 'string' || task.group_id === '')
      return {
        ok: true,
        at,
        total: rows.length,
        groups: rows,
        // 未分组不是一个组：单独给计数，面板用一张固定的虚拟卡承载（不落库、不可改名）。
        ungrouped: {
          total: ungrouped.length,
          active: ungrouped.filter(task => ACTIVE_FOR_GROUP.includes(task.status) && task.status !== 'delivered').length,
          delivered: ungrouped.filter(task => task.status === 'delivered').length,
          failed: ungrouped.filter(task => task.status === 'failed' || task.status === 'orphaned').length,
        },
      }
    },

    /** 只读：单组详情（任务行取精简字段，完整卡片仍以 snapshot 为准，避免两份投影漂移）。 */
    group(groupId) {
      const id = text(groupId)
      if (id === '') return panelFailure('GROUP_NOT_FOUND', { groupId })
      if (!groupExists(id)) return panelFailure('GROUP_NOT_FOUND', { groupId: id })
      const at = now()
      const tasks = allTasks().filter(task => task.group_id === id)
      const meta = getGroupMeta(db, id)
      const rollup = groupRollups({
        keys: [id],
        meta: meta === undefined ? [] : [meta],
        counts: groupStatusCounts(db),
        tasks,
        automations: listAutomations(db),
        now: at,
      })[0]
      const artifacts = []
      for (const task of tasks) {
        for (const artifact of Array.isArray(task.artifacts) ? task.artifacts : []) {
          if (artifacts.length >= WORKBENCH_LIMITS.groupArtifacts) break
          artifacts.push({
            taskId: task.id,
            taskTitle: task.title,
            path: artifact.path,
            label: artifact.label ?? null,
          })
        }
      }
      return {
        ok: true,
        at,
        group: rollup,
        tasks: tasks.slice(0, WORKBENCH_LIMITS.groupTasks).map(task => ({
          id: task.id,
          ref: task.ref ?? null,
          title: task.title,
          status: task.status,
          tone: STATUS_TONE[task.status] ?? 'muted',
          statusLabel: statusLabel(task.status),
          priority: task.priority,
          plannedAt: task.planned_at,
          deliveredAt: task.delivered_at,
          updatedAt: task.updated_at,
          artifactCount: Array.isArray(task.artifacts) ? task.artifacts.length : 0,
          dependencies: Array.isArray(task.depends_on) ? task.depends_on.length : 0,
          question: task.question,
          options: task.options,
          canPlan: planSetGate(task).ok,
        })),
        artifacts,
        automations: listAutomations(db)
          .filter(row => row.kind === 'group' && row.ref_id === id && row.deleted_at === null)
          .map(row => ({
            id: row.id,
            title: row.title,
            timingText: timingText(row.timing),
            active: row.active === true,
            scheduleId: row.schedule_id,
          })),
        planned: {
          next: rollup.nextPlannedAt,
          count: tasks.filter(task => Number.isFinite(task.planned_at)).length,
        },
        canRename: rollup.canRename,
        canArchive: rollup.canArchive,
      }
    },

    /** 只读：排期窗口（超过 62 天自动收窄，读端点不做错误路径）。 */
    calendar({ from, to } = {}) {
      const at = now()
      let start = Number.isFinite(Number(from)) ? Number(from) : (at - 7 * DAY_MS)
      let end = Number.isFinite(Number(to)) ? Number(to) : (at + 30 * DAY_MS)
      if (Number.isFinite(Date.parse(String(from)))) start = Date.parse(String(from))
      if (Number.isFinite(Date.parse(String(to)))) end = Date.parse(String(to))
      if (!(end > start)) end = start + DAY_MS
      const span = WORKBENCH_LIMITS.calendarWindowDays * DAY_MS
      if (end - start > span) end = start + span
      const tasks = allTasks()
      const automationRows = []
      for (const row of listAutomations(db)) {
        if (row.deleted_at !== null) continue
        automationRows.push({ ...row, nextFireAt: cachedFireAt.get(row.schedule_id) ?? null })
      }
      const window = calendarWindow({ tasks, automations: automationRows, from: start, to: end })
      const upcoming = tasks
        .filter(task => Number.isFinite(task.planned_at) && task.planned_at >= at)
        .sort((left, right) => left.planned_at - right.planned_at)
        .slice(0, WORKBENCH_LIMITS.calendarNext)
        .map(task => ({ id: task.id, title: task.title, plannedAt: task.planned_at, groupId: task.group_id ?? null }))
      return { ok: true, at, from: start, to: end, days: window.days, upcoming }
    },

    /** 只读：复盘页统计（窗口内交付/确认/平均创建→交付时长/失败归因/产物类型/组排行/消息数）。 */
    stats({ days } = {}) {
      const at = now()
      const requested = Math.trunc(Number(days))
      const windowDays = Number.isFinite(requested) && requested > 0 ? requested : 7
      return reviewStats({
        tasks: allTasks(),
        groups: listGroupMeta(db),
        messages: countMessagesBetween(db, { from: at - Math.min(windowDays, WORKBENCH_LIMITS.reviewWindowDays) * DAY_MS, to: at }),
        days: windowDays,
        now: at,
      })
    },

    /** 只读：自动化清单（宿主不可用时 available=false，整页降级为只读镜像）。 */
    async automations() {
      const available = isAvailable()
      const rows = []
      for (const row of listAutomations(db)) {
        if (row.deleted_at !== null) continue
        const host = available ? await hostView(row.schedule_id) : null
        if (host !== null && !host.missing && typeof host.scheduledAt === 'string') {
          const fireAt = parseStamp(host.scheduledAt)
          if (fireAt !== null) cachedFireAt.set(row.schedule_id, fireAt)
          // 宿主侧真实状态与镜像漂移时以宿主为准同步镜像（只写 active 与 updatedAt，不改授权信息）。
          const hostActive = host.status === 'active'
          if (typeof host.status === 'string' && hostActive !== (row.active === true)) {
            updateAutomationRow(db, row.id, { active: hostActive, expectedUpdatedAt: typeof host.updatedAt === 'string' ? host.updatedAt : undefined })
          }
        }
        rows.push(automationRow(row, host))
      }
      return {
        ok: true,
        at: now(),
        available,
        target: mainIdOf() ?? null,
        rows,
        canCreate: available && (mainIdOf() ?? '') !== '',
      }
    },

    /** 写：组元数据 upsert（改名 / 目标 / 颜色）。组键不可变。 */
    async saveGroup(body = {}) {
      const id = text(body.id) ?? ''
      if (id === '') return panelFailure('GROUP_NOT_FOUND', { groupId: id })
      if (!groupExists(id)) return panelFailure('GROUP_NOT_FOUND', { groupId: id })
      const existing = getGroupMeta(db, id)
      const name = text(body.name)
      const gate = groupSaveGate(existing, { name, exists: true })
      if (!gate.ok) {
        if (gate.reason === 'archived') return panelFailure('GROUP_ARCHIVED', { groupId: id })
        return panelFailure('GROUP_NAME_INVALID', { reason: '需要 1–40 个字' })
      }
      const expected = Number(body.expectedUpdatedAt)
      if (existing !== undefined && Number.isFinite(expected) && expected > 0 && existing.updated_at !== expected) {
        return panelFailure('GROUP_CONFLICT')
      }
      const taken = listGroupMeta(db).find(row => row.id !== id && row.name.trim().toLowerCase() === name.toLowerCase())
      if (taken !== undefined) return panelFailure('GROUP_NAME_TAKEN', { name })
      const goal = body.goal === null || body.goal === undefined ? null : String(body.goal).trim().slice(0, 400)
      const color = body.color === null || body.color === undefined ? null : String(body.color).trim().slice(0, 20)
      const same = existing !== undefined && existing.name === name
        && (existing.goal ?? null) === goal && (existing.color ?? null) === color
      if (same) return { ok: true, already: true, group: existing }
      const saved = upsertGroupMeta(db, { id, name, goal, color, now: now() })
      log('ui.group.saved', { detail: { groupId: id, renamed: existing === undefined ? true : existing.name !== name } })
      return { ok: true, group: saved }
    },

    /** 写：归档 / 取消归档（软删；任务与产物一律不动）。 */
    async archiveGroup(body = {}) {
      const id = text(body.id)
      const archived = body.archived === true
      const existing = getGroupMeta(db, id)
      const group = existing ?? (groupExists(id) ? { id, name: id, archived: false } : undefined)
      const gate = groupArchiveGate(group, { confirm: archived ? body.confirm === true : true })
      if (!gate.ok) {
        if (gate.reason === 'not_found') return panelFailure('GROUP_NOT_FOUND', { groupId: id })
        return panelFailure('GROUP_NOT_CONFIRMED')
      }
      // 归档虚拟组时先补一行元数据（否则归档状态无处安放）。
      if (existing === undefined) upsertGroupMeta(db, { id, name: id, now: now() })
      const current = getGroupMeta(db, id)
      if (current !== undefined && current.archived === archived) {
        return { ok: true, already: true, group: current }
      }
      const saved = setGroupArchived(db, id, archived, now())
      log('ui.group.archived', { detail: { groupId: id, archived } })
      return { ok: true, group: saved }
    },

    /** 写：L1 排期日（只写 planned_at；不动状态、不入队、不创建自动化）。 */
    async setPlan(body = {}) {
      const taskId = text(body.taskId)
      const task = taskId === '' ? undefined : getTask(db, taskId)
      let plannedAt = null
      if (body.plannedAt !== null && body.plannedAt !== undefined) {
        const stamp = typeof body.plannedAt === 'number' ? body.plannedAt : Date.parse(String(body.plannedAt))
        if (!Number.isFinite(stamp)) return panelFailure('PLAN_TIME_INVALID', { reason: '时间无法解析' })
        plannedAt = Math.trunc(stamp)
      }
      const gate = planSetGate(task, { plannedAt })
      if (!gate.ok) {
        if (gate.reason === 'not_found') return panelFailure('PLAN_TASK_NOT_FOUND', { taskId })
        if (gate.reason === 'ended') {
          return panelFailure('PLAN_TASK_ENDED', { label: taskLabel(task), statusLabel: statusLabel(task.status) })
        }
        return panelFailure('PLAN_TIME_INVALID')
      }
      const at = now()
      if (plannedAt !== null && Math.abs(plannedAt - at) > PLAN_WINDOW_MS) {
        return panelFailure('PLAN_TIME_INVALID', { reason: '只能排在前后两年内' })
      }
      if ((task.planned_at ?? null) === plannedAt) {
        return { ok: true, already: true, taskId: task.id, plannedAt }
      }
      const saved = setTaskPlannedAt(db, task.id, plannedAt, at)
      log('ui.plan.set', { detail: { taskId: task.id, plannedAt } })
      return { ok: true, taskId: task.id, plannedAt: saved.planned_at }
    },

    /** 写：创建/编辑自动化（宿主 schedule + 镜像 + 授权审计）。 */
    async saveAutomation(body = {}) {
      const available = isAvailable()
      const confirmed = body.confirm === true
      const editing = typeof body.id === 'string' && body.id !== ''
      const existing = editing ? getAutomation(db, body.id) : undefined
      if (editing && existing === undefined) return panelFailure('AUTOMATION_NOT_FOUND', { id: body.id })
      const gate = automationGate({ available, confirmed, exists: !editing || existing !== undefined })
      if (!gate.ok) {
        if (gate.reason === 'unavailable') return panelFailure('AUTOMATION_UNAVAILABLE')
        if (gate.reason === 'not_found') return panelFailure('AUTOMATION_NOT_FOUND', { id: body.id })
        return panelFailure('AUTOMATION_NOT_CONFIRMED')
      }
      const mainId = mainIdOf()
      if (typeof mainId !== 'string' || mainId === '') return panelFailure('AUTOMATION_TARGET_INVALID')
      const kind = ['group', 'task', 'global'].includes(body.kind) ? body.kind : 'global'
      const refId = kind === 'global' ? null : text(body.refId)
      if (kind === 'group') {
        if (refId === '' || !groupExists(refId)) return panelFailure('GROUP_NOT_FOUND', { groupId: refId ?? '' })
        const meta = getGroupMeta(db, refId)
        if (meta !== undefined && meta.archived === true) return panelFailure('GROUP_ARCHIVED', { groupId: refId })
      }
      if (kind === 'task') {
        const task = refId === '' ? undefined : getTask(db, refId)
        if (task === undefined) return panelFailure('PLAN_TASK_NOT_FOUND', { taskId: refId ?? '' })
      }
      const normalized = normalizeTiming(body.timing ?? {}, {})
      if (!normalized.ok) return panelFailure('AUTOMATION_TIMING_INVALID', { reason: normalized.reason })
      const defaults = {
        group: refId ? `组「${refId}」自动派单` : '自动派单',
        task: refId ? `任务 ${refId} 跟进` : '跟进',
        global: '任务台自动巡检',
      }
      const title = (text(body.title) || defaults[kind]).slice(0, AUTOMATION_TITLE_MAX)
      const prompt = (text(body.prompt) || defaultPrompt({ kind, refId, what: body.what })).slice(0, AUTOMATION_PROMPT_MAX)
      const service = scheduleService()
      if (editing && existing !== undefined) {
        const patch = { title, prompt, timing: normalized.timing }
        try {
          const result = await service.edit({
            id: existing.schedule_id,
            action: 'update',
            patch,
            ...(typeof existing.expected_updated_at === 'string' && existing.expected_updated_at !== ''
              ? { expectedUpdatedAt: existing.expected_updated_at }
              : {}),
          })
          if (result !== null && typeof result === 'object' && result.code === 'schedule_conflict') {
            return panelFailure('AUTOMATION_CONFLICT')
          }
          if (result !== null && typeof result === 'object' && result.code === 'schedule_not_found') {
            // 宿主侧已不存在：允许用新 id 重建（不静默假装成功）。
            return panelFailure('AUTOMATION_FAILED', { reason: '宿主侧已找不到这条自动化，请删除后重建' })
          }
          const saved = updateAutomationRow(db, existing.id, {
            title,
            prompt,
            timing: normalized.timing,
            expectedUpdatedAt: typeof result?.updatedAt === 'string' ? result.updatedAt : undefined,
            now: now(),
          })
          log('ui.automation.saved', { detail: { id: saved.id, edited: true, kind, refId } })
          return { ok: true, automation: automationRow(saved, result) }
        } catch (error) {
          return panelFailure('AUTOMATION_FAILED', { reason: error?.message ?? String(error) })
        }
      }
      try {
        const created = await service.create({
          title,
          prompt,
          timing: normalized.timing,
          // 硬约束：只投递唯一主会话（this_session 语义），不做 new / new_once。
          target: { kind: 'session', sessionId: mainId },
        })
        const id = `a-${Math.random().toString(36).slice(2, 10)}`
        const row = insertAutomation(db, {
          id,
          kind,
          refId,
          title,
          prompt,
          timing: normalized.timing,
          scheduleId: typeof created?.id === 'string' ? created.id : null,
          targetSession: mainId,
          authorizedBy: 'user',
          expectedUpdatedAt: typeof created?.updatedAt === 'string' ? created.updatedAt : null,
          now: now(),
        })
        log('ui.automation.created', { detail: { id: row.id, kind, refId, scheduleId: row.schedule_id } })
        return { ok: true, automation: automationRow(row, created) }
      } catch (error) {
        return panelFailure('AUTOMATION_FAILED', { reason: error?.message ?? String(error) })
      }
    },

    /** 写：暂停 / 恢复（改宿主 active，再同步镜像）。 */
    async toggleAutomation(body = {}) {
      const available = isAvailable()
      const row = getAutomation(db, body.id)
      const gate = automationGate({ available, confirmed: body.confirm === true, exists: row !== undefined })
      if (!gate.ok) {
        if (gate.reason === 'unavailable') return panelFailure('AUTOMATION_UNAVAILABLE')
        if (gate.reason === 'not_found') return panelFailure('AUTOMATION_NOT_FOUND', { id: body.id })
        return panelFailure('AUTOMATION_NOT_CONFIRMED')
      }
      const active = body.active === true
      if (row.active === active) return { ok: true, already: true, id: row.id, active }
      try {
        const result = await scheduleService().edit({
          id: row.schedule_id,
          action: 'update',
          patch: { active },
          ...(typeof row.expected_updated_at === 'string' && row.expected_updated_at !== ''
            ? { expectedUpdatedAt: row.expected_updated_at }
            : {}),
        })
        if (result !== null && typeof result === 'object' && result.code === 'schedule_conflict') {
          return panelFailure('AUTOMATION_CONFLICT')
        }
        const saved = updateAutomationRow(db, row.id, {
          active,
          expectedUpdatedAt: typeof result?.updatedAt === 'string' ? result.updatedAt : undefined,
          now: now(),
        })
        log('ui.automation.toggled', { detail: { id: row.id, active } })
        return { ok: true, automation: automationRow(saved, result) }
      } catch (error) {
        return panelFailure('AUTOMATION_FAILED', { reason: error?.message ?? String(error) })
      }
    },

    /** 写：删除（宿主侧删 + 镜像标记；**不撤回已排队消息**，如实写进返回）。 */
    async deleteAutomation(body = {}) {
      const available = isAvailable()
      const row = getAutomation(db, body.id)
      const gate = automationGate({ available, confirmed: body.confirm === true, exists: row !== undefined })
      if (!gate.ok) {
        if (gate.reason === 'unavailable') return panelFailure('AUTOMATION_UNAVAILABLE')
        if (gate.reason === 'not_found') return panelFailure('AUTOMATION_NOT_FOUND', { id: body.id })
        return panelFailure('AUTOMATION_NOT_CONFIRMED')
      }
      if (row.deleted_at !== null) return { ok: true, already: true, id: row.id }
      try {
        if (typeof row.schedule_id === 'string' && row.schedule_id !== '') {
          const result = await scheduleService().edit({
            id: row.schedule_id,
            action: 'delete',
            ...(typeof row.expected_updated_at === 'string' && row.expected_updated_at !== ''
              ? { expectedUpdatedAt: row.expected_updated_at }
              : {}),
          })
          if (result !== null && typeof result === 'object' && result.code === 'schedule_conflict') {
            return panelFailure('AUTOMATION_CONFLICT')
          }
        }
      } catch (error) {
        return panelFailure('AUTOMATION_FAILED', { reason: error?.message ?? String(error) })
      }
      updateAutomationRow(db, row.id, { deletedAt: now(), active: false, now: now() })
      log('ui.automation.deleted', { detail: { id: row.id } })
      return {
        ok: true,
        id: row.id,
        deleted: true,
        note: '已在宿主侧删除；已排队的投递不会被撤回（平台不承诺 exactly-once）。',
      }
    },
  }
}
