// 工作区推断：按任务标题/目标匹配已注册工作区的显示名与路径末段。
// 规则（增量计划）：精确名优先；只在最高命中层里取结果；唯一命中才用，多命中列候选，绝不猜。
const normalize = value => typeof value === 'string' ? value.trim().toLowerCase() : ''
const compact = value => value.replace(/[^a-z0-9]+/g, '')

/** 纯 ASCII 键要求至少 3 个字母数字，CJK 等键至少 2 个字，避免 `ai`/`main` 这类短词误命中。 */
const isMatchable = key => {
  if (key === '') return false
  if (/^[\x00-\x7f]+$/.test(key)) return compact(key).length >= 3
  return key.length >= 2
}

/** 跨平台取路径末段：`C:\a\b` 与 `/a/b` 都返回 `b`。 */
export function pathTail(path) {
  const parts = String(path ?? '').split(/[\\/]+/).filter(Boolean)
  return parts.length === 0 ? '' : parts[parts.length - 1]
}

const keysOf = workspace => {
  const keys = new Set()
  for (const value of [workspace?.title, pathTail(workspace?.path)]) {
    const key = normalize(value)
    if (isMatchable(key)) keys.add(key)
  }
  return keys
}

/**
 * @param {{title?: string, goal?: string}} brief 任务标题与目标
 * @param {Array<{id: string, title?: string, path?: string}>} workspaces workspaceRegistry.list()
 * @returns {{ok: true, workspace: object|undefined} | {ok: false, candidates: Array<{id,title,path}>}}
 */
export function inferWorkspaceTarget(brief = {}, workspaces = []) {
  const fields = [normalize(brief.title), normalize(brief.goal)].filter(Boolean)
  const hay = fields.join('\n')
  const entries = []
  for (const workspace of Array.isArray(workspaces) ? workspaces : []) {
    if (workspace === null || typeof workspace !== 'object' || workspace.id === undefined) continue
    const keys = keysOf(workspace)
    if (keys.size === 0) continue
    entries.push({ workspace, keys })
  }

  const exact = []
  const substring = []
  for (const entry of entries) {
    if (fields.some(field => entry.keys.has(field))) exact.push(entry)
    else if (hay !== '' && [...entry.keys].some(key => hay.includes(key))) substring.push(entry)
  }

  const pick = exact.length > 0 ? exact : substring
  if (pick.length === 0) return { ok: true, workspace: undefined }
  if (pick.length === 1) return { ok: true, workspace: pick[0].workspace }
  const candidates = pick
    .map(({ workspace }) => ({
      id: workspace.id,
      title: typeof workspace.title === 'string' ? workspace.title : pathTail(workspace.path),
      path: workspace.path,
    }))
    .sort((a, b) => String(a.title).localeCompare(String(b.title)))
  return { ok: false, candidates }
}
