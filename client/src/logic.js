/**
 * 面板纯逻辑（P7 / T7.2 迁入）：显示名、筛选/计数、搜索、产物分组、时间文案。
 *
 * 全部是无副作用的纯函数，单测经 __test 直接断言（test/client.test.js 的「U2 纯函数」用例）。
 */
import {
  CHIP_ACTIVE_STATUSES, CHIP_MAX, CHIP_RECENT_MS, CHIP_STATE_OF, CHIP_STATE_VIEW, STATUS_LABEL,
} from './constants.js'
// 面板对外只用显示名：重名才附**任务引用**后缀（tk-xxxxxx，与工具层同口径）。
// 版本 B《ID 出口网关》：界面上不出现 t-xxxx 这类内部编号；拿不到引用时退回 4 位短后缀
// （不构成 t-xxxx 形态），仍能区分同名任务。
export const shortId = id => String(id || '').replace(/^t-/, '').slice(0, 4)
export const refSuffixOf = task => {
  const ref = String((task && task.ref) || '').trim()
  return ref !== '' ? ref : shortId(task && task.id)
}
export const displayNameOf = (task, all) => {
  const title = String((task && task.title) || '').trim()
  if (title === '') return '任务'
  const duplicate = all.some(other => other !== task && other.id !== task.id
    && String((other && other.title) || '').trim() === title)
  return duplicate ? `${title}（${refSuffixOf(task)}）` : title
}
export const textOf = value => typeof value === 'string' ? value.trim() : ''
export const listOf = value => (Array.isArray(value) ? value.map(item => textOf(item)).filter(Boolean) : [])

/**
 * 0.36.0 多协调者：快照 → 面板「主会话」行要用的只读摘要。
 *
 * 判据（与服务端 session-role 同源，都是「会话 ∈ 名单」）：
 *   - `count`   名单长度（面板显示「协调者 N」）；
 *   - `primary` 首位（主协调者，「打开主会话」打开的就是它）；
 *   - `self`    当前会话在名单里的位置（-1 = 不是协调者）；
 *   - `canLeave` 名单 > 1 且当前会话在名单里 → 显示「本会话退出」（只剩一个时不给，避免一键把协调者清空）。
 * 快照缺失/形状异常一律降级成空摘要（面板不渲染特权入口，与 gate 的 fail-closed 同口径）。
 */
export const coordinatorSummaryOf = (snapshot, currentSessionId) => {
  const main = snapshot !== null && typeof snapshot === 'object' ? snapshot.mainSession : undefined
  const id = textOf(main?.id)
  const ids = Array.isArray(main?.ids) ? listOf(main.ids) : (id === '' ? [] : [id])
  const self = textOf(currentSessionId)
  const index = self === '' ? -1 : ids.indexOf(self)
  const isSelf = index >= 0
  return { count: ids.length, ids, primary: ids[0] ?? null, selfIndex: index, isSelf, canLeave: isSelf && ids.length > 1 }
}

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
// R1/R3：正文里的任务引用（tk-xxxxxx）→ 「任务名」chip
//
// 为什么在客户端做：模型回复（最新回复 / 消息）里常出现 `tk-7f3a2c` 这种引用，用户认不出是哪个任务。
// 这里把正文按引用切段，查台账现名后渲染成 chip；查不到就**原样显示**（绝不隐藏用户的字）。
//
// 五种兜底 + tooltip 口径（改这里必须同步 test/client.test.js 的 RefText 用例）：
//   F1 重名：两个任务同名 → chip 写「名称（tk-xxx）」，否则用户分不清是哪一个；
//   F2 改名过期：正文是旧时间段写的，名字以**台账现名**为准（快照/详情每轮刷新，不用正文里的旧名）；
//   F3 长名：chip 按码点截断（chipVisibleTitle），全名放 tooltip；
//   F4 查不到：引用不在快照/引用索引里 → 原样显示 `tk-xxxxxx`（不猜、不隐藏）；
//   F5 已删除：引用已置墓碑（详情 refs 里 deleted=true）→ 原样显示 + tooltip「引用已失效」。
//   F6 tooltip：**恒带 `（tk-xxxxxx）`**（正文口径不变：重名才带引用后缀）——chip 悬停要能拿到引用。
// ---------------------------------------------------------------------------

/**
 * 正文里认的引用形态：`tk-` + 6 位小写字母数字（与 src/task-ref.js 的 TASK_REF_RE 同口径）。
 *
 * 两侧的边界断言是必要的：`tk-abc1234`（多一位）、`x-tk-abc123`（前面粘着别的 token）都不是引用，
 * 不能只匹配到前面 6 位就当成引用——那会把用户的字吞掉一半、换成一个错的任务名。
 */
export const TASK_REF_TEXT_RE = /(?<![0-9a-z-])tk-[0-9a-z]{6}(?![0-9a-z])/g

/** chip 上名字的最大码点数（与回复底部 chip 的 `CHIP_TITLE_MAX` 一致，值相同不互相依赖）。 */
export const REF_TEXT_MAX = 24

/**
 * 把一段自由文本切成「文字 / 引用」片段（纯函数，不查表）。
 *
 * @param {string} value 正文
 * @returns {Array<{type:'text', text:string} | {type:'ref', text:string, ref:string}>}
 *   无引用时返回单个 text 片段（调用方可据此零开销地按原样渲染）。
 */
export const splitTaskRefs = value => {
  const text = typeof value === 'string' ? value : ''
  const segments = []
  let last = 0
  for (const match of text.matchAll(TASK_REF_TEXT_RE)) {
    const at = match.index ?? 0
    if (at > last) segments.push({ type: 'text', text: text.slice(last, at) })
    segments.push({ type: 'ref', text: match[0], ref: match[0] })
    last = at + match[0].length
  }
  if (last < text.length) segments.push({ type: 'text', text: text.slice(last) })
  return segments
}

/**
 * 引用 → 展示信息（查表现名 + 五种兜底）。
 *
 * @param {string} ref `tk-xxxxxx`
 * @param {{tasks?: object[], refs?: object[]}} [source]
 *   tasks = 面板快照（现名 + 同名判定）；refs = 详情下发的引用索引（含已删除的墓碑引用）。
 * @returns {{ref:string, label:string, found:boolean, deleted:boolean, duplicate:boolean,
 *   truncated:boolean, tone:string, tooltip:string}|null}
 *   形态不像引用时返回 null（调用方原样显示）。
 */
export const refDisplayOf = (ref, { tasks = [], refs = [] } = {}) => {
  const value = textOf(ref)
  if (value === '' || !/^tk-[0-9a-z]{6}$/.test(value)) return null
  const live = (Array.isArray(tasks) ? tasks : []).find(task => textOf(task?.ref) === value)
  const index = (Array.isArray(refs) ? refs : []).find(row => textOf(row?.ref) === value) ?? null
  const deleted = live === undefined && index?.deleted === true
  // F2：名字一律取台账现名（快照优先，详情索引兜底），正文里写的时间点不影响显示名。
  const title = textOf(live?.title) || (deleted ? '' : textOf(index?.title))
  if (title === '') {
    // F4 / F5：查不到或已删除 —— 原样显示引用，只换 tooltip。
    // F6：tooltip 一律以 `（tk-xxxxxx）` 结尾（与命中分支同形状），悬停时总能拿到引用。
    return {
      ref: value,
      label: value,
      found: false,
      deleted,
      duplicate: false,
      truncated: false,
      tone: 'muted',
      tooltip: deleted
        ? `引用已失效：任务已删除（${value}）`
        : `找不到这个任务引用（${value}）`,
    }
  }
  // F1：同名任务用引用后缀区分（与 displayNameOf / taskLabel 同口径）。
  const duplicate = (Array.isArray(tasks) ? tasks : [])
    .some(other => textOf(other?.title) === title && textOf(other?.ref) !== value)
  const full = duplicate ? `${title}（${value}）` : title
  // F3：chip 上截断，tooltip 里给全名。
  const label = chipVisibleTitle(full, REF_TEXT_MAX)
  // F6：tooltip 恒带 `（tk-xxxxxx）` —— chip 正文只在「重名」时才有引用后缀，不重名时只有一个名字，
  // 悬停看不到引用就没法对着台账/会话/通知里的 tk-xxxxxx 找任务。正文（label）口径不变，只补 tooltip。
  return {
    ref: value,
    label,
    found: true,
    deleted: false,
    duplicate,
    truncated: label !== full,
    tone: 'info',
    tooltip: `${title}（${value}）｜点击面板任务卡片可查看详情`,
  }
}

/**
 * 正文 → 片段 + 每条引用的展示信息（view 层只做装配，单测直接断言这个函数）。
 * @param {string} value 正文
 * @param {{tasks?: object[], refs?: object[]}} [source] 同 refDisplayOf
 */
export const refSegmentsOf = (value, source = {}) => splitTaskRefs(value).map(segment => (
  segment.type === 'ref'
    ? { ...segment, display: refDisplayOf(segment.ref, source) }
    : segment
))

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
// R5 点击：有子会话（task.childSessionId）→ 打开该子会话；没有 / 宿主不认这个 id → 降级打开任务详情，
//    并把「无子会话」写进 tooltip（见 chipOpenTargetOf），不给「会跳会话」的误导。
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
  // R1：没有标题时用**引用**兜底（`任务 tk-xxxxxx`），不回落台账内部编号。
  const ref = textOf(task === null || task === undefined ? undefined : task.ref)
  return ref === '' ? '任务' : `任务 ${ref}`
}

/**
 * chip 点击要打开什么（R5）。
 *
 * 有子会话 id（快照 tasks[].childSessionId，来自台账 session_id）→ `{ kind: 'session', sessionId }`：
 * 点一下直接跳到那个子会话（宿主 uiWorkspace.openSession，与面板行的「打开子会话」同一个调用）。
 * 没有 → `{ kind: 'detail', sessionId: null }`：降级成老行为（打开面板 + 定位任务详情）。
 *
 * 「会话目录已清理 / 已归档」在客户端看不出来（快照只下发 id），所以由调用方 try/catch 兜：
 * 宿主 openSession 抛错（`sessions.retain: unknown session <id>`）时同样走降级分支。
 */
export const chipOpenTargetOf = task => {
  const value = task === null || task === undefined ? undefined : task.childSessionId
  const sessionId = textOf(value)
  return sessionId === '' ? { kind: 'detail', sessionId: null } : { kind: 'session', sessionId }
}

/** 悬浮提示：任务名（+ 引用）+ 状态 + 点下去会发生什么（标题截断后仍能看到全名与状态）。 */
export const chipTooltipOf = task => {
  const status = task === null || task === undefined ? undefined : task.status
  const label = Object.hasOwn(STATUS_LABEL, status) ? STATUS_LABEL[status] : '状态未知'
  const hint = chipOpenTargetOf(task).kind === 'session'
    ? '点击打开子会话'
    : '无子会话，点击打开任务详情'
  // R3：tooltip 补引用（tk-xxxxxx）——chip 上只有名字，引用放在 tooltip 里对账 task_list。
  const name = chipNameOf(task)
  const ref = textOf(task === null || task === undefined ? undefined : task.ref)
  return `${name}${ref === '' || name.includes(ref) ? '' : `（${ref}）`}｜${label}｜${hint}`
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

/**
 * 取出「第几轮」这个数字。
 *
 * turnTail 的 owner.turn 真实形状是 TurnLocation（`@deepseek-ai/dsh-client-ui-conversation` 的
 * `TurnLocation`：`{ turn: number, start, end, status, steps, data }`），不是裸数字；
 * ChatSnapshot 的 `timeline.turnOrder` 才是 `readonly number[]`。
 * 裸 number 只是早期实现/旧测试遗留的入参形状（非真实形状），这里保留兼容，新代码不要这样传。
 */
const turnNumberOf = turn => {
  if (typeof turn === 'number') return Number.isFinite(turn) ? turn : null
  if (turn === null || typeof turn !== 'object') return null
  const value = turn.turn
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * 这一轮是不是「最新一轮」（chat 时间线末位）。
 * 回归：曾经直接拿 `order[order.length - 1] === turn` 比较 —— 左边是数字、右边是 TurnLocation
 * 对象，恒为 false，于是 chip 在真实宿主里永远不渲染（单测传裸数字才「绿」）。现在取字段比较。
 */
export const isLatestTurn = (snapshot, turn) => {
  const order = snapshot === null || snapshot === undefined ? undefined : snapshot.timeline?.turnOrder
  const current = turnNumberOf(turn)
  return Array.isArray(order) && order.length > 0 && current !== null && order[order.length - 1] === current
}

/**
 * 面板「打开并定位」的一次性请求：chip 点击时记下任务 id，面板下次挂载时取走并直接开详情抽屉。
 * 取走即清空 —— 用户自己点开面板时不会被上一次的残留弹窗打扰。
 *
 * 还可以带一条 `notice`（降级原因：子会话打不开了），面板取走后作为可见提示显示在详情里。
 * notice 与 id 分开取：`take()` 的返回值保持「任务 id 字符串」这个老契约不变。
 */
export const createFocusRequest = () => {
  let pending = null
  let pendingNotice = null
  let pendingContext = null
  return {
    request: (id, options = {}) => {
      const value = textOf(id)
      if (value === '') return false
      pending = value
      pendingNotice = textOf(options === null || options === undefined ? undefined : options.notice) || null
      // 工作台 v1：chip 只知道任务 id，工作台要据此直接进「组工作台」并开抽屉。
      // 上下文与 id 分开取，保持 take() 的旧契约（只返回任务 id 字符串）。
      pendingContext = {
        view: textOf(options?.view) || 'general',
        groupId: textOf(options?.groupId) || null,
      }
      return true
    },
    take: () => {
      const value = pending
      pending = null
      return value
    },
    // 取走即清空：面板只在挂载消费一次，提示跟着那一次走，不留到下次开面板。
    takeNotice: () => {
      const value = pendingNotice
      pendingNotice = null
      return value
    },
    takeContext: () => {
      const value = pendingContext
      pendingContext = null
      return value
    },
    peek: () => pending,
    peekNotice: () => pendingNotice,
  }
}

// ---------------------------------------------------------------------------
// 工作台 v1（P11）纯逻辑：日历格 / 看板列 / 排期桶 / 文案
// 与 React 无关，单测经 __test 直接断言（见 test/client-workbench.test.js）。
// ---------------------------------------------------------------------------

const pad = value => String(value).padStart(2, '0')

/** 本地日键 `YYYY-MM-DD`（与 src/workbench.js 的 dayKeyOf 同口径）。 */
export const dateKeyOf = ms => {
  const date = new Date(Number.isFinite(ms) ? ms : Date.now())
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 本地零点（日历格里「拖到某天」的基准）。 */
export const startOfDay = ms => {
  const date = new Date(Number.isFinite(ms) ? ms : Date.now())
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** 当月 1 日（月份翻页锚点）。 */
export const startOfMonth = ms => {
  const date = new Date(Number.isFinite(ms) ? ms : Date.now())
  date.setDate(1)
  return startOfDay(date.getTime())
}

/** `HH:MM` 时刻文案（本地时区）。 */
export const clockOf = ms => {
  const date = new Date(Number.isFinite(ms) ? ms : Date.now())
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** `11月22日 20:00`（排期卡与「下一条」共用）。 */
export const planWhenLabel = ms => {
  if (!Number.isFinite(ms)) return '未排期'
  const date = new Date(ms)
  return `${date.getMonth() + 1}月${date.getDate()}日 ${clockOf(ms)}`
}

/**
 * 月历格（周一起始、固定 6 行）：2 月/31 天都占满 42 格，避免翻月时网格高度跳动。
 * @returns {{year:number, month:number, label:string, cells:Array<{key:string, day:number, inMonth:boolean, isToday:boolean, ms:number}>}}
 */
export const monthGrid = (anchorMs, todayMs = Date.now()) => {
  const anchor = startOfMonth(anchorMs)
  const base = new Date(anchor)
  const year = base.getFullYear()
  const month = base.getMonth()
  const firstWeekday = (base.getDay() + 6) % 7 // 周一 = 0
  const start = startOfDay(anchor) - firstWeekday * 86400000
  const todayKey = dateKeyOf(todayMs)
  const cells = []
  for (let index = 0; index < 42; index += 1) {
    const ms = start + index * 86400000
    const date = new Date(ms)
    const key = dateKeyOf(ms)
    cells.push({
      key,
      ms,
      day: date.getDate(),
      inMonth: date.getMonth() === month,
      isToday: key === todayKey,
    })
  }
  return { year, month, label: `${year} 年 ${month + 1} 月`, cells }
}

/** 看板列：按 BOARD_COLUMNS 压列，列内按 优先级↓ → 最近事件↓ 排序。 */
export const groupBoard = (tasks, columns) => {
  const list = Array.isArray(tasks) ? tasks : []
  return (Array.isArray(columns) ? columns : []).map(column => {
    const rows = list
      .filter(task => column.statuses.includes(task.status))
      .sort((left, right) => (Number(right.priority) || 0) - (Number(left.priority) || 0)
        || (Number(right.lastEventAt) || 0) - (Number(left.lastEventAt) || 0))
    return { ...column, tasks: rows, count: rows.length }
  })
}

/** 某个组的任务（`groupId` 为空/undefined 视为未分组）。 */
export const groupTasksOf = (tasks, groupId) => (Array.isArray(tasks) ? tasks : [])
  .filter(task => (task.groupId ?? null) === (groupId ?? null))

/**
 * 排期页右栏的**派生分组**（不是任务状态）：状态机一个都不改，只是把「还需要人排一下的」
 * 与「正在跑的 / 等你确认的」分开显示，免得进行中、待确认的任务被误读成「还没排期」。
 *
 * - 待排期：`waiting_dep` / `pending` 且还没有计划日；
 * - 进行中：`running` / `waiting_user` / `waiting_auth`；
 * - 待确认：`delivered`；
 * - 已排期（有 `plannedAt`）只出现在月历与「下一条」，不落上面三组；
 * - 终态（done/failed/cancelled/orphaned/missing）哪组都不进（排了也永远不会跑）。
 */
export const SCHEDULE_GROUPS = Object.freeze([
  { key: 'tray', label: '待排期', empty: '没有待排期的任务。', hint: '把卡片拖到日历某天即排期；拖回这里或点「清除」取消。' },
  { key: 'active', label: '进行中', empty: '没有进行中的任务。', hint: null },
  { key: 'confirm', label: '待确认', empty: '没有待确认的任务。', hint: null },
])

/** 每组最多渲染几条（沿用旧待排 tray 的 20），防止长期不清理把右栏拖成长列表。 */
export const SCHEDULE_GROUP_LIMIT = 20

/** 状态 → 派生分组（`null` = 不属于右栏任何一组）。 */
const SCHEDULE_BUCKET_BY_STATUS = Object.freeze({
  waiting_dep: 'tray',
  pending: 'tray',
  running: 'active',
  waiting_user: 'active',
  waiting_auth: 'active',
  delivered: 'confirm',
})

/** 单条任务的派生分组：`tray` / `active` / `confirm` / `scheduled`；终态与未知状态是 `null`。 */
export const scheduleBucketOf = task => {
  if (task === null || typeof task !== 'object') return null
  if (Number.isFinite(task.plannedAt)) return 'scheduled'
  return SCHEDULE_BUCKET_BY_STATUS[task.status] ?? null
}

/** 右栏三组（待排期 / 进行中 / 待确认）的分组结果：组内最近事件↓，`count` 是命中总数。 */
export const scheduleGroups = tasks => {
  const rows = Array.isArray(tasks) ? tasks : []
  return SCHEDULE_GROUPS.map(group => {
    const matched = rows
      .filter(task => scheduleBucketOf(task) === group.key)
      .sort((left, right) => (Number(right.lastEventAt) || 0) - (Number(left.lastEventAt) || 0))
    return { ...group, tasks: matched.slice(0, SCHEDULE_GROUP_LIMIT), count: matched.length }
  })
}

/** 今日排期（总览的「今天」列与日历今天高亮共用）。 */
export const plannedOnDay = (tasks, dateKey) => (Array.isArray(tasks) ? tasks : [])
  .filter(task => Number.isFinite(task.plannedAt) && dateKeyOf(task.plannedAt) === dateKey)
  .sort((left, right) => left.plannedAt - right.plannedAt)

/** 下一条要做的（未来最近的排期）。 */
export const nextPlannedTask = (tasks, now = Date.now()) => {
  let best = null
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!Number.isFinite(task.plannedAt) || task.plannedAt < now) continue
    if (best === null || task.plannedAt < best.plannedAt) best = task
  }
  return best
}

/**
 * 「拖到某天」换算：保留原时刻，没排过就用默认 20:00。
 * 与 media-desk 的日程落点习惯一致；不同的是**只写 planned_at，不改任务状态**。
 */
export const planStampOnDay = (dateKey, sourceMs, defaultHour = 20) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey ?? ''))
  if (match === null) return null
  const base = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 0, 0, 0, 0)
  const source = Number.isFinite(sourceMs) ? new Date(sourceMs) : null
  const hour = source === null ? defaultHour : source.getHours()
  const minute = source === null ? 0 : source.getMinutes()
  base.setHours(hour, minute, 0, 0)
  return base.getTime()
}

/** 自动化行的人类可读状态（面板只读宿主状态 + 镜像，不猜）。 */
export const automationStateLabel = row => {
  if (row?.hostMissing === true) return '宿主侧已不存在'
  if (row?.active !== true) return '已暂停'
  return row?.nextFireAt ? `下次 ${planWhenLabel(row.nextFireAt)}` : '等待宿主触发'
}

