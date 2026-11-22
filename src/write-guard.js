// 同写域并发防护：两个**未隔离**的活跃任务写同一批文件 = 迟早互相覆盖。
//
// 事故背景：协调者在同一个 target 目录上并发派了两个任务（都没开 worktree），两个子会话同时写
// 同一份工作树，改动互相踩。此前 writeScopes 只做 advisory 提示、target 从不参与冲突判定，等于没有防护。
//
// 口径（默认安全、可显式放宽、不做不可绕过的硬拒）：
// - 判定对象：新任务 target 与某个**活跃且未隔离**任务的 target 相同或互相包含；
//   以及新任务 writeScopes 与活跃未隔离任务写域重叠。
// - **已交付待确认（delivered）不占写域**：交付那一刻就释放该子会话的 target 可写根，
//   同目录可以正常创建新任务；要接着改就追问原会话——追问回 running 前会按 target / 写域复判
//   （`decideFollowupGuard`），被占用就拒绝投递并给「等确认/关占用任务」与「worktree:true 新派」两条路。
// - 三个档位 `config.sameDirGuard`：
//   - `require`（默认）：拒绝创建，返回可操作错误（先 task_message({ action: 'close' }) / 改 worktree 隔离 / 传 allowConcurrent:true）；
//   - `warn`：只给强警告，照常创建（返回文本 + 日志都留痕）；
//   - `off`：完全关闭（writeScopes 退回旧的 advisory 一行提示）。
// - 三条显式出路（都不是「硬拒」）：`allowConcurrent:true`、`worktree:true` 隔离、先 `task_message({ action: 'close' })` 旧任务。
// - 只读任务（readOnly）永远不写文件，不参与判定（既不算冲突方，也不被拦）；
//   `planFirst` 计划阶段虽然当下只读，但批准后会转可写，所以照常参与判定（否则批准那刻就撞了）。
// - 隔离任务（`requested`/`created`/`reused`）在各自检出目录里跑，不算冲突方；
//   `requested` 是派发时才建检出的待建状态，任务注定在检出里跑、不碰原目录，同样不算。
//   `degraded`（目标不是 git 仓库）降级后仍在原工作树写，必须继续占目录。
// - 只对活跃任务判定：done/cancelled/failed/orphaned 都已释放目录。
//
// 本模块只做纯计算与文案，不读库、不跑 git，便于单测（台账遍历在 tools.js）。
import { resolve, sep } from 'node:path'
import { taskLabelWithRef } from './task-label.js'
import { worktreeStatesWithout } from './worktree-facts.js'
import { statusLabel } from './state.js'
import { hasCap } from './status-facts.js'

/** 防护档位：require（默认，拒绝）/ warn（只警告）/ off（关闭）。 */
export const SAME_DIR_GUARD_MODES = Object.freeze(['require', 'warn', 'off'])
export const DEFAULT_SAME_DIR_GUARD = 'require'

const trim = value => (typeof value === 'string' ? value.trim() : '')

/** 路径归一：解析成绝对路径、去尾部分隔符；Windows 大小写不敏感。空值返回 ''。 */
export function normalizePath(value) {
  const text = trim(value)
  if (text === '') return ''
  let path
  try {
    path = resolve(text)
  } catch {
    return text
  }
  const stripped = path.length > 1 ? path.replace(/[\\/]+$/, '') : path
  return process.platform === 'win32' ? stripped.toLowerCase() : stripped
}

/** 两个路径是否同一目录或互相包含（一方是另一方的祖先）。 */
export function pathsOverlap(left, right) {
  const a = normalizePath(left)
  const b = normalizePath(right)
  if (a === '' || b === '') return false
  if (a === b) return true
  return a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`)
}

/** 写域归一：与 tools.normalizeScopes 同口径（斜杠统一、去尾斜杠、截断 200 字）。 */
export const normalizeScope = value => trim(value).replace(/\\/g, '/').replace(/\/+$/, '').slice(0, 200)

/** 两个写域是否重叠（相等或一方是另一方的父目录）。 */
export function scopesOverlap(left, right) {
  const a = normalizeScope(left)
  const b = normalizeScope(right)
  if (a === '' || b === '') return false
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

/**
 * 「已隔离」状态：这些任务在独立检出目录里跑，不写原目录，因此既不算冲突方、也不该被拦。
 *
 * - `requested`：派发时才建检出。此时 target_dir 还没换算成检出目录（换算发生在
 *   `prepareTaskWorktree`），但任务**注定**在检出里跑，不会碰原目录。因 dependsOn 停在
 *   `waiting_dep` 的任务也停在这个状态——把它当成占用原目录会误拦同目录的合法任务。
 * - `created` / `reused`：检出已建好 / 复用既有检出。
 *
 * 注意 `degraded`（目标不是 git 仓库）**不在**此列：它降级后仍在原工作树里写，必须继续占目录。
 *
 * 这份列表是唯一事实来源：`tools.js` 判定「新任务自己是否隔离」也引用它，
 * 避免两处各写一套、口径漂移（曾因两处列表不一致导致 P1 误拦）。
 */
export const ISOLATED_WORKTREE_STATES = Object.freeze(worktreeStatesWithout('occupiesTarget'))

/** 隔离任务：在独立检出目录里跑，不算同写域。 */
export const isolatedTask = task => ISOLATED_WORKTREE_STATES.includes(task?.worktree_state)

/** 只读任务不写文件（永远不写），不占写域。计划阶段虽然只读，但批准后会转可写，所以照常占。 */
export const readOnlyTask = task => task?.read_only === true

/** 已交付待确认：写根已释放，不再占写域（但会话还在、仍能被追问）。 */
export const deliveredTask = task => task?.status === 'delivered'

/** 任务是否「占着」写域：写文件 ∧ 未隔离 ∧ 还没交付释放。 */
export const occupiesTarget = task => !readOnlyTask(task) && !isolatedTask(task) && !deliveredTask(task)

/**
 * 追问视角的占用：`delivered` 也可能被追问重新拿到写根，所以它仍是「潜在写者」。
 * 判「能不能追问」时用它（否则两条 delivered 可以先后被追问、最后同时写同一目录）。
 */
export const occupiesTargetOnFollowup = task => !readOnlyTask(task) && !isolatedTask(task)

/** 任务对外的目标目录：优先 target_dir（隔离任务派发后已换算成检出目录），退回 brief.target。 */
export const taskTargetDir = task => {
  const dir = trim(task?.target_dir)
  return dir !== '' ? dir : trim(task?.brief?.target)
}

/**
 * 新任务经 dependsOn 串起来的祖先任务 id（含间接前置）。
 * 这些任务与新任务**不会同时跑**（新任务等它们 done 才派发），所以同目录不算并发写。
 */
export function serializedIdsOf(tasks, dependsOn = []) {
  const byId = new Map((Array.isArray(tasks) ? tasks : []).map(task => [task?.id, task]))
  const seen = new Set()
  const queue = (Array.isArray(dependsOn) ? dependsOn : []).filter(id => typeof id === 'string')
  while (queue.length > 0) {
    const id = queue.shift()
    if (seen.has(id)) continue
    seen.add(id)
    const task = byId.get(id)
    for (const next of Array.isArray(task?.depends_on) ? task.depends_on : []) {
      if (!seen.has(next)) queue.push(next)
    }
  }
  return seen
}

/**
 * 同 target 冲突：新任务 target 与某个活跃未隔离任务的 target 相同或互相包含。
 * `includeDelivered:true` 把「已交付待确认」也算潜在写者（追问复判用；它随时能被追问重新拿到写根）。
 * @returns {Array<{task: object, target: string}>}
 */
export function targetConflicts(tasks, { target, excludeId, serializedIds, includeDelivered = false } = {}) {
  const wanted = trim(target)
  if (wanted === '') return []
  const serialized = serializedIds instanceof Set ? serializedIds : new Set()
  const occupies = includeDelivered === true ? occupiesTargetOnFollowup : occupiesTarget
  const conflicts = []
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (task === null || typeof task !== 'object') continue
    if (excludeId !== undefined && task.id === excludeId) continue
    if (serialized.has(task.id)) continue
    if (!occupies(task)) continue
    const other = taskTargetDir(task)
    if (other === '' || !pathsOverlap(wanted, other)) continue
    conflicts.push({ task, target: other })
    if (conflicts.length >= 5) break
  }
  return conflicts
}

/**
 * 写域冲突：新任务 writeScopes 与活跃未隔离任务的 writeScopes 重叠。
 * 同 target 的冲突已由 targetConflicts 覆盖，这里跳过它们，只报「不同目录但写域撞了」。
 */
export function scopeConflicts(tasks, { scopes = [], excludeId, skipTaskIds = [], serializedIds, includeDelivered = false } = {}) {
  const wanted = (Array.isArray(scopes) ? scopes : []).map(normalizeScope).filter(scope => scope !== '')
  if (wanted.length === 0) return []
  const skip = new Set(Array.isArray(skipTaskIds) ? skipTaskIds : [])
  const serialized = serializedIds instanceof Set ? serializedIds : new Set()
  const occupies = includeDelivered === true ? occupiesTargetOnFollowup : occupiesTarget
  const conflicts = []
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (task === null || typeof task !== 'object') continue
    if (excludeId !== undefined && task.id === excludeId) continue
    if (skip.has(task.id) || serialized.has(task.id)) continue
    if (!occupies(task)) continue
    const other = Array.isArray(task.write_scopes) ? task.write_scopes : []
    const overlap = wanted.find(scope => other.some(candidate => scopesOverlap(scope, candidate)))
    if (overlap === undefined) continue
    conflicts.push({ task, scope: overlap, other: other.find(candidate => scopesOverlap(overlap, candidate)) ?? overlap })
    if (conflicts.length >= 5) break
  }
  return conflicts
}

/**
 * 冲突任务名 + 状态：文案里要能直接认人（「写域A（t-1a2b3c4d）（进行中）」）。
 * 降级任务（不是 git 仓库）额外标注——它看起来像开了隔离，实际仍在原工作树里写，
 * 不标出来用户会困惑「我明明传了 worktree:true」。
 */
const conflictLine = ({ task, target }) => {
  const degraded = task?.worktree_state === 'degraded' ? '｜隔离已降级：目标不是 git 仓库，仍在原工作树写' : ''
  return `- 「${taskLabelWithRef(task)}」（${statusLabel(task.status)}）：${trim(target) || '目标目录未记录'}${degraded}`
}

/** 任务的检出目录（没有检出/未隔离为空串）。 */
export const checkoutPath = task => trim(task?.worktree_path)

/**
 * 检出被「活跃」任务占着：`worktreeMode:'continue'` 复用它之前必须判。
 * 用 `active` 状态能力（pending / waiting_dep / running / waiting_* / delivered）而不是「有没有 session」：
 * 排队中的复用任务同样会写这份检出；`delivered` 也可能被追问重新拿到写根。
 */
export const occupiesCheckout = task => checkoutPath(task) !== '' && hasCap(task?.status, 'active')

/**
 * 同一个 worktree_path 的并发占用：两个子会话写同一份检出，git 索引会互相踩。
 * @returns {Array<{task: object, path: string}>}
 */
export function checkoutConflicts(tasks, { path, excludeId, serializedIds } = {}) {
  const wanted = normalizePath(path)
  if (wanted === '') return []
  const serialized = serializedIds instanceof Set ? serializedIds : new Set()
  const conflicts = []
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (task === null || typeof task !== 'object') continue
    if (excludeId !== undefined && task.id === excludeId) continue
    if (serialized.has(task.id)) continue
    if (!occupiesCheckout(task)) continue
    const other = normalizePath(checkoutPath(task))
    if (other === '' || other !== wanted) continue
    conflicts.push({ task, path: checkoutPath(task) })
    if (conflicts.length >= 5) break
  }
  return conflicts
}

/** 复用检出被占用时的拒绝文案（两条出路：dependsOn 串行 / 新建检出）。 */
export function checkoutRejection({ path, conflicts = [] } = {}) {
  return [
    `未创建任务：worktreeMode:"continue" 要复用的检出 ${trim(path) || '(未指定)'} 正被下面这些任务占着——两个子会话会同时写同一份检出，git 索引也会互相踩：`,
    ...conflicts.map(({ task, path: other }) => `- 「${taskLabelWithRef(task)}」（${statusLabel(task.status)}）：检出 ${trim(other) || '(未记录)'}`),
    '两种做法（任选其一）：',
    '1. 串行复用：把占用任务设为 dependsOn 前置（等它 done 再复用同一检出；已交付待确认的先 task_message({ action: \'close\' }) 确认），再重派；',
    '2. 并行新建：改传 worktreeMode:"new"，让新任务在自己的分支/检出里跑（合并由你决定）。',
  ].join('\n')
}

/** 同 target 拒绝文案：说清「为什么被拒 + 三条出路」。（delivered 交付即释放，不会出现在冲突方里。） */
export function sameDirRejection({ target, conflicts = [] } = {}) {
  return [
    `未创建任务：目标目录 ${trim(target) || '(未指定)'} 与活跃任务相同或互相包含，且新任务没有 worktree 隔离——两个子会话会同时写同一份工作树。`,
    '冲突任务（已在独立检出里跑的任务不在此列，它们不写这个目录）：',
    ...conflicts.map(conflictLine),
    '三种做法（任选其一）：',
    '1. 先 task_message({ action: \'close\' }) 关闭旧任务（或 task_message({ action: \'stop\' }) 取消），再重派；',
    '2. 传 worktree:true 让新任务在独立检出里跑（推荐：两个任务可并行，合并由你决定）；',
    '3. 确认确实要并发写同一目录时，显式传 allowConcurrent:true 放行（冲突风险自负）。',
  ].join('\n')
}

/** 写域重叠拒绝文案：列出重叠路径与冲突任务。 */
export function scopeRejection({ scopes = [], conflicts = [] } = {}) {
  return [
    `未创建任务：写域 ${scopes.map(scope => `「${scope}」`).join('、')} 与活跃任务重叠，且双方都没有 worktree 隔离。`,
    '冲突任务与重叠路径：',
    ...conflicts.map(({ task, scope, other }) => `- 「${taskLabelWithRef(task)}」（${statusLabel(task.status)}）：重叠 ${other}（本次 ${scope}）`),
    '三种做法（任选其一）：',
    '1. 先 task_message({ action: \'close\' }) 关闭旧任务，再重派；',
    '2. 传 worktree:true 隔离，或用 dependsOn 把两个任务串起来（串行写入）；',
    '3. 确认确实要并发写同一批文件时，显式传 allowConcurrent:true 放行（冲突风险自负）。',
  ].join('\n')
}

/** 放行 / 降级时写进返回文本的风险标注（require 档被 allowConcurrent 放行、warn 档照常创建）。 */
export function concurrentRiskNote({ target, targetConflicts: same = [], scopeConflicts: scopes = [], mode = DEFAULT_SAME_DIR_GUARD, allowed = false } = {}) {
  const lines = []
  const head = allowed
    ? '并发风险（allowConcurrent:true 已放行）'
    : `并发风险（配置 sameDirGuard="${mode}"，本应拒绝，已降级为警告）`
  if (same.length > 0) {
    lines.push(`${head}：目标目录 ${trim(target) || '(未指定)'} 与活跃任务重叠——两个子会话可能同时改同一份工作树，冲突要你/用户自己兜。`)
    lines.push(...same.map(conflictLine))
  }
  if (scopes.length > 0) {
    lines.push(`${head}：写域 ${scopes.map(scope => `「${scope}」`).join('、')} 与活跃任务重叠——两个子会话可能同时改同一批文件。`)
    lines.push(...scopes.map(({ task, scope, other }) => `- 「${taskLabelWithRef(task)}」（${statusLabel(task.status)}）：重叠 ${other}（本次 ${scope}）`))
  }
  return lines.join('\n')
}

/** 配置档位归一：非法值（含拼错）一律回落 require —— 默认必须安全。 */
export const guardModeOf = value => (SAME_DIR_GUARD_MODES.includes(value) ? value : DEFAULT_SAME_DIR_GUARD)

/**
 * 一次性判定：把「冲突 + 档位 + 覆盖开关」折成动作。
 * @returns {{action: 'pass'|'reject', mode: string, targetConflicts: Array, scopeConflicts: Array, note: string, text: string}}
 *   - action='pass'：可创建，note 是附在返回里的风险提示（可能为空）；
 *   - action='reject'：不创建，text 是可操作错误信息。
 */
export function decideWriteGuard({
  tasks = [], target, scopes = [], dependsOn = [], excludeId, mode = DEFAULT_SAME_DIR_GUARD, allowConcurrent = false, skipChecks = false,
} = {}) {
  const guard = guardModeOf(mode)
  if (skipChecks || guard === 'off') return { action: 'pass', mode: guard, targetConflicts: [], scopeConflicts: [], note: '', text: '' }
  // dependsOn 链上的前置任务不会与新任务同时跑（等它们 done 才派发），同目录不算并发写。
  const serializedIds = serializedIdsOf(tasks, dependsOn)
  const same = targetConflicts(tasks, { target, excludeId, serializedIds })
  const scopeHits = scopeConflicts(tasks, { scopes, excludeId, skipTaskIds: same.map(({ task }) => task.id), serializedIds })
  if (same.length === 0 && scopeHits.length === 0) {
    return { action: 'pass', mode: guard, targetConflicts: [], scopeConflicts: [], note: '', text: '' }
  }
  if (allowConcurrent === true) {
    return {
      action: 'pass',
      mode: guard,
      targetConflicts: same,
      scopeConflicts: scopeHits,
      note: concurrentRiskNote({ target, targetConflicts: same, scopeConflicts: scopeHits, mode: guard, allowed: true }),
      text: '',
    }
  }
  if (guard === 'warn') {
    return {
      action: 'pass',
      mode: guard,
      targetConflicts: same,
      scopeConflicts: scopeHits,
      note: concurrentRiskNote({ target, targetConflicts: same, scopeConflicts: scopeHits, mode: guard, allowed: false }),
      text: '',
    }
  }
  const text = same.length > 0
    ? sameDirRejection({ target, conflicts: same })
    : scopeRejection({ scopes, conflicts: scopeHits })
  return { action: 'reject', mode: guard, targetConflicts: same, scopeConflicts: scopeHits, note: '', text }
}

/**
 * 以 taskId 为前置的下游任务 id（含间接前置链）。
 * 它们只会在本任务 `done` 之后才派发，所以「追问本任务」与它们不会同时跑，不算并发写
 * （与 `serializedIdsOf` 同口径，方向相反：这里是「谁在等我」，那里是「我在等谁」）。
 */
export function downstreamSerializedIds(tasks, taskId) {
  const list = Array.isArray(tasks) ? tasks : []
  const byId = new Map(list.map(task => [task?.id, task]))
  const seen = new Set()
  for (const task of list) {
    if (task === null || typeof task !== 'object') continue
    if (task.id === taskId) continue
    const queue = Array.isArray(task.depends_on) ? [...task.depends_on] : []
    const walked = new Set()
    while (queue.length > 0) {
      const id = queue.shift()
      if (walked.has(id)) continue
      walked.add(id)
      if (id === taskId) {
        seen.add(task.id)
        break
      }
      const upstream = byId.get(id)
      for (const next of Array.isArray(upstream?.depends_on) ? upstream.depends_on : []) {
        if (!walked.has(next)) queue.push(next)
      }
    }
  }
  return seen
}

/**
 * 追问被拒文案：说清「谁占着 + 两条出路」。
 * 追问只能投回原会话（无法中途加隔离），所以这里没有 allowConcurrent 那条路。
 */
export function followupConflictText({ target, conflicts = [], scopes = [], checkouts = [] } = {}) {
  return [
    `目标目录 ${trim(target) || '(未指定)'}${checkouts.length > 0 ? '（或它所在的检出）' : ''} 正被下面这些任务占着——现在追问会让两个子会话同时写同一份工作树/检出：`,
    ...conflicts.map(conflictLine),
    ...scopes.map(({ task, scope, other }) => `- 「${taskLabelWithRef(task)}」（${statusLabel(task.status)}）：写域重叠 ${other}（本任务 ${scope}）`),
    ...checkouts.map(({ task, path }) => `- 「${taskLabelWithRef(task)}」（${statusLabel(task.status)}）：同一个检出 ${trim(path) || '(未记录)'}`),
    '两种做法（任选其一）：',
    '1. 等占用任务交付并确认（task_message({ action: \'close\' })）或取消（task_message({ action: \'stop\' })）之后再追问；',
    '2. 这次改动确实要并行 → 新派一个带 worktree:true 的任务（原会话无法中途加隔离，追问也不改变它的目录）。',
  ].join('\n')
}

/**
 * 追问（delivered → running）前的写域复判：交付时写根已释放，重新开工前必须确认目录/写域/检出没人占。
 *
 * 只对 `delivered` 生效：其余可追问状态（running / waiting_*）本来就还占着写域，
 * 同目录的并发在 `task_create` 那侧就会拦（那侧用 `occupiesTarget`，不看 delivered）。
 *
 * @returns {{action:'pass'|'reject', mode:string, targetConflicts:Array, scopeConflicts:Array, checkoutConflicts:Array, note:string, text:string}}
 */
export function decideFollowupGuard({ tasks = [], task, mode = DEFAULT_SAME_DIR_GUARD } = {}) {
  const guard = guardModeOf(mode)
  const pass = {
    action: 'pass',
    mode: guard,
    targetConflicts: [],
    scopeConflicts: [],
    checkoutConflicts: [],
    note: '',
    text: '',
  }
  if (guard === 'off' || task === undefined || task === null) return pass
  if (readOnlyTask(task)) return pass
  if (deliveredTask(task) !== true) return pass
  const serializedIds = downstreamSerializedIds(tasks, task.id)
  const target = taskTargetDir(task)
  const same = targetConflicts(tasks, { target, excludeId: task.id, serializedIds, includeDelivered: true })
  const scopeHits = scopeConflicts(tasks, {
    scopes: Array.isArray(task.write_scopes) ? task.write_scopes : [],
    excludeId: task.id,
    skipTaskIds: same.map(({ task: item }) => item.id),
    serializedIds,
    includeDelivered: true,
  })
  // 隔离任务的写域是检出目录（它不占原 target），单独按 worktree_path 判。
  const checkouts = checkoutConflicts(tasks, { path: checkoutPath(task), excludeId: task.id, serializedIds })
  if (same.length === 0 && scopeHits.length === 0 && checkouts.length === 0) return pass
  if (guard === 'warn') {
    return {
      action: 'pass',
      mode: guard,
      targetConflicts: same,
      scopeConflicts: scopeHits,
      checkoutConflicts: checkouts,
      note: concurrentRiskNote({ target, targetConflicts: same, scopeConflicts: scopeHits, mode: guard, allowed: false }),
      text: '',
    }
  }
  return {
    action: 'reject',
    mode: guard,
    targetConflicts: same,
    scopeConflicts: scopeHits,
    checkoutConflicts: checkouts,
    note: '',
    text: followupConflictText({ target, conflicts: same, scopes: scopeHits, checkouts }),
  }
}
