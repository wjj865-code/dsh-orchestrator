/**
 * 面板纯逻辑（P7 / T7.2 迁入）：显示名、筛选/计数、搜索、产物分组、时间文案。
 *
 * 全部是无副作用的纯函数，单测经 __test 直接断言（test/client.test.js 的「U2 纯函数」用例）。
 */
import {
  CHIP_ACTIVE_STATUSES, CHIP_MAX, CHIP_RECENT_MS, CHIP_STATE_OF, CHIP_STATE_VIEW, STATUS_LABEL,
} from './constants.js'
// 面板对外只用显示名：重名才附短 id 后缀（与工具层同口径，取 t-xxx 后 4 位）。
export const shortId = id => String(id || '').replace(/^t-/, '').slice(0, 4)
export const displayNameOf = (task, all) => {
  const title = String((task && task.title) || '').trim()
  if (title === '') return task && task.id ? `任务 ${task.id}` : '任务'
  const duplicate = all.some(other => other !== task && other.id !== task.id
    && String((other && other.title) || '').trim() === title)
  return duplicate ? `${title}（${shortId(task.id)}）` : title
}
export const textOf = value => typeof value === 'string' ? value.trim() : ''
export const listOf = value => (Array.isArray(value) ? value.map(item => textOf(item)).filter(Boolean) : [])

// 三段式里的纯逻辑：计数 / 筛选 / 搜索 / 产物分组都提到组件外，便于单测直接断言。
export const countTasks = tasks => {
  const counts = { all: 0, active: 0, waiting: 0, done: 0, failed: 0, closed: 0, artifacts: 0 }
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (task === null || typeof task !== 'object') continue
    counts.all += 1
    for (const filter of ['active', 'waiting', 'done', 'failed', 'closed']) {
      if (matchesFilter(task, filter)) counts[filter] += 1
    }
    if (matchesFilter(task, 'artifacts')) counts.artifacts += 1
  }
  return counts
}

export const matchesFilter = (task, filter) => {
  const status = task === null || task === undefined ? undefined : task.status
  if (filter === 'active') return status === 'waiting_dep' || status === 'pending' || status === 'running'
  // 「待你决定」含已交付待确认（delivered）：两者都需要人（或协调者）拍板，UI 不再多一个筛选项。
  if (filter === 'waiting') return status === 'waiting_user' || status === 'waiting_auth' || status === 'delivered'
  if (filter === 'done') return status === 'done'
  if (filter === 'failed') return status === 'failed'
  if (filter === 'closed') return status === 'cancelled' || status === 'orphaned'
  if (filter === 'artifacts') return Array.isArray(task === null || task === undefined ? undefined : task.artifacts)
    && task.artifacts.length > 0
  return true
}

export const matchesQuery = (task, query) => {
  const needle = String(query ?? '').trim().toLowerCase()
  if (needle === '') return true
  return [task?.title, task?.id, task?.targetDir, task?.groupId]
    .some(value => String(value ?? '').toLowerCase().includes(needle))
}

export const artifactDate = at => {
  if (typeof at !== 'number' || !Number.isFinite(at)) return '日期未知'
  const date = new Date(at)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
export const artifactProject = item => {
  const project = typeof item?.project === 'string' ? item.project : ''
  if (project !== '') return project
  const dir = textOf(item?.targetDir)
  if (dir === '') return '未关联项目'
  return dir.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() || dir
}
export const groupArtifacts = (items, mode) => {
  const groups = new Map()
  for (const item of Array.isArray(items) ? items : []) {
    if (item === null || typeof item !== 'object') continue
    if (typeof item.path !== 'string' || item.path === '') continue
    const key = mode === 'date' ? artifactDate(item.at) : artifactProject(item)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(item)
  }
  const rows = [...groups.entries()]
  rows.sort((left, right) => mode === 'date'
    ? right[0].localeCompare(left[0])
    : left[0].localeCompare(right[0], 'zh-CN'))
  for (const [, list] of rows) {
    list.sort((left, right) => (right.at ?? 0) - (left.at ?? 0) || String(left.path).localeCompare(String(right.path)))
  }
  return rows
}

export const timeLabel = ms => {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '-'
  const minutes = Math.max(0, Math.floor((Date.now() - ms) / 60000))
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

export const shortPath = value => {
  const text = typeof value === 'string' ? value : ''
  return text.length > 60 ? `${text.slice(0, 59)}…` : text
}

// 产物预览走宿主右侧栏：地址语法与 @deepseek-ai/dsh-util-workspace-path 的 sessionFileAddress 逐条对齐。
// `dsh-resource://file/session/<编码后的 sessionId>/<逐段编码的 path>`；`:` 保持字面（Windows 盘符），
// 反斜杠归一成 `/`、去掉开头的 `./`。路径可绝对也可相对 workspace 根，由宿主的 Session 文件系统解析。
// 右侧栏只认领 session 作用域（absolute 作用域不被文件预览 Tab 认领），所以必须带 sessionId。
//
// 不 trim：POSIX 允许路径首尾带空格，`/tmp/report .md` 与 `/tmp/report.md` 是两个文件，
// trim 会静默改写调用方的合法路径。宿主 sessionFileAddress 也不 trim —— 对齐口径优先。
const encodeAddressSegment = segment => encodeURIComponent(segment).replace(/%3A/gi, ':')

// 空串是「拼不出地址」的统一信号，调用方据此不再发请求；成因（没会话 id / 路径为空 / 编码失败）由
// fileAddressProblem 分辨，避免把「路径为空」误报成「拿不到会话」。
export const fileAddressOf = (sessionId, path) => {
  if (fileAddressProblem(sessionId, path) !== null) return ''
  const normalized = path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
  try {
    const encoded = normalized.split('/').map(encodeAddressSegment).join('/')
    return `dsh-resource://file/session/${encodeAddressSegment(sessionId)}/${encoded}`
  } catch {
    // 孤立代理项等非法 UTF-16 会让 encodeURIComponent 抛 URIError；按「拼不出地址」处理。
    return ''
  }
}

/**
 * 拼地址前的成因判定，供调用方给出可分辨的失败原因。
 * @returns {null|'no-session'|'bad-path'} null 表示可以拼地址。
 */
export const fileAddressProblem = (sessionId, path) => {
  if (typeof sessionId !== 'string' || sessionId === '') return 'no-session'
  if (typeof path !== 'string' || path === '') return 'bad-path'
  return null
}

// ---------------------------------------------------------------------------
// 回复底部「关联任务 chip」（conversation.chat.turnTail）
//
// 关联规则（写进报告；改这里必须同步 test/client.test.js 的 chip 用例）：
// R1 会话绑定：只收 task.coordinatorSession === 当前会话 id 的任务 —— 会话不是派任务的协调者时
//    一个都收不到，于是整行不渲染（无关联 = 不渲染）。
// R2 轮次：组件只在「最新一轮已完成回复」的尾部渲染（见 views.js 的 isLatestTurn），历史回复不带 chip。
// R3 入选：活跃状态（等前置/待派发/进行中/等你确认/要授权/待确认）全收；终态（完成/失败/取消/丢失）
//    只在 lastEventAt 落在最近 CHIP_RECENT_MS 内时收 —— 「刚跑完」要能看到，昨天的旧任务不翻旧账。
// R4 排序与截断：lastEventAt ↓ → updatedAt ↓ → id ↑，取前 CHIP_MAX 个出 chip，其余折成「+N」。
// ---------------------------------------------------------------------------
const CHIP_ACTIVE = new Set(CHIP_ACTIVE_STATUSES)

/** 台账状态 → 5 个视觉态之一（未知状态按「等前置」的静圈处理，不谎报成功/失败）。 */
export const chipStateOf = status => (
  Object.hasOwn(CHIP_STATE_OF, status) ? CHIP_STATE_OF[status] : 'waiting'
)

/** 视觉态对应的图标 / 动效 class / 语义色。 */
export const chipViewOf = status => {
  const state = chipStateOf(status)
  return { state, ...CHIP_STATE_VIEW[state] }
}

export const chipNameOf = task => {
  const title = textOf(task === null || task === undefined ? undefined : task.title)
  if (title !== '') return title
  const id = textOf(task === null || task === undefined ? undefined : task.id)
  return id === '' ? '任务' : `任务 ${id}`
}

/** 悬浮提示：任务名 + 状态（标题截断后仍能看到全名与状态）。 */
export const chipTooltipOf = task => {
  const status = task === null || task === undefined ? undefined : task.status
  const label = Object.hasOwn(STATUS_LABEL, status) ? STATUS_LABEL[status] : '状态未知'
  return `${chipNameOf(task)}｜${label}`
}

export const CHIP_TITLE_MAX = 24

/** 视觉标题按码点截断（emoji 不被切成半个），像素级省略由 CSS ellipsis 兜住。 */
export const chipVisibleTitle = (title, max = CHIP_TITLE_MAX) => {
  const text = textOf(title)
  if (text === '') return '任务'
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : CHIP_TITLE_MAX
  const chars = [...text]
  return chars.length > limit ? `${chars.slice(0, limit - 1).join('')}…` : text
}

/**
 * 从快照里挑出「本轮回复该挂的任务」。
 * @param tasks - 快照 tasks（只有 id/title/status/coordinatorSession/lastEventAt/updatedAt 被读）。
 * @param options.sessionId - 当前会话 id（turnTail 的标准 prop）。
 * @param options.now - 判定「最近结束」的时钟（默认 Date.now；测试注入）。
 * @returns {{chips: object[], rest: number, total: number}|null} 无关联时 null（调用方不渲染）。
 */
export const selectTaskChips = (tasks, { sessionId, now = Date.now(), max = CHIP_MAX, recentMs = CHIP_RECENT_MS } = {}) => {
  if (typeof sessionId !== 'string' || sessionId === '') return null
  const list = (Array.isArray(tasks) ? tasks : [])
    .filter(task => task !== null && typeof task === 'object')
    .filter(task => task.coordinatorSession === sessionId)
    .filter(task => {
      if (CHIP_ACTIVE.has(task.status)) return true
      const at = task.lastEventAt
      return typeof at === 'number' && Number.isFinite(at) && now - at <= recentMs
    })
    .sort((left, right) => (right.lastEventAt ?? 0) - (left.lastEventAt ?? 0)
      || (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
      || String(left.id ?? '').localeCompare(String(right.id ?? '')))
  if (list.length === 0) return null
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 0
  const chips = list.slice(0, limit)
  return { chips, rest: list.length - chips.length, total: list.length }
}

/** 这一轮是不是「最新一轮」（chat 时间线末位）；turnTail 的 owner.turn 是 TurnLocation。 */
export const isLatestTurn = (snapshot, turn) => {
  const order = snapshot === null || snapshot === undefined ? undefined : snapshot.timeline?.turnOrder
  return Array.isArray(order) && order.length > 0 && order[order.length - 1] === turn
}

/**
 * 面板「打开并定位」的一次性请求：chip 点击时记下任务 id，面板下次挂载时取走并直接开详情抽屉。
 * 取走即清空 —— 用户自己点开面板时不会被上一次的残留弹窗打扰。
 */
export const createFocusRequest = () => {
  let pending = null
  return {
    request: id => {
      const value = textOf(id)
      if (value === '') return false
      pending = value
      return true
    },
    take: () => {
      const value = pending
      pending = null
      return value
    },
    peek: () => pending,
  }
}

