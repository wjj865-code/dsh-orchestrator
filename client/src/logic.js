/**
 * 面板纯逻辑（P7 / T7.2 迁入）：显示名、筛选/计数、搜索、产物分组、时间文案。
 *
 * 全部是无副作用的纯函数，单测经 __test 直接断言（test/client.test.js 的「U2 纯函数」用例）。
 */
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
