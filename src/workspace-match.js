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

// 全等匹配用全部非空键（2 字 title 全等也应命中）；子串匹配才用长度过滤防误伤。
const keysOf = workspace => {
  const keys = new Set()
  for (const value of [workspace?.title, pathTail(workspace?.path)]) {
    const key = normalize(value)
    if (key !== '') keys.add(key)
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
    const equal = fields.filter(field => entry.keys.has(field))
    if (equal.length > 0) {
      exact.push({ ...entry, hits: new Set(equal) })
      continue
    }
    if (hay === '') continue
    const hits = new Set([...entry.keys].filter(key => isMatchable(key) && hay.includes(key)))
    if (hits.size > 0) substring.push({ ...entry, hits })
  }

  // 包含消歧（只在子串层）：某个命中的**全部**匹配文本都被另一命中的某个文本严格包含 → 它是更泛的那条，丢掉。
  // 严格包含要求 key 不相等，所以两个同名工作区（key 相同）都保留、仍走候选。
  const strictlyContainedIn = (entry, other) => [...entry.hits].every(key =>
    [...other.hits].some(otherKey => otherKey !== key && otherKey.includes(key)))
  const pick = exact.length > 0
    ? exact
    : substring.filter((entry, index) => !substring.some((other, otherIndex) =>
      otherIndex !== index && strictlyContainedIn(entry, other)))
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
