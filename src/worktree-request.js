// worktree 结构化请求：`task_create` 的 worktree* 字段 → 校验 + 机械映射（纯函数，不读文件、不跑 git）。
//
// v2 口径（master-plan §4）：声明只有两处 —— profile 配置 `worktreePolicy`（用户级默认）与
// `task_create.worktree*` 字段（任务级决定）。插件**不读** AGENTS.md、**不解析**自然语言、**不缓存**指令文件；
// 「要不要建 / 基线 / 分支名」由协调者判断（DSH 负责把用户指引注入给它），插件只做校验与执行。
//
// 本模块只放纯映射与文案，交给 tools.js（创建期）与 queue/worktree.js（派发期）共用，
// 避免「工具层一套、派发层一套」两处口径（R11/R19 的来源）。
import { branchNameLooksValid } from './worktree.js'
// 状态事实源在叶子模块（无依赖），这里 re-export 保持既有 import 路径可用。
export {
  WORKTREE_STATES, WORKTREE_STATE_CAPS, WORKTREE_CAP_KEYS, WORKTREE_TRANSITIONS,
  canWorktreeTransition, nextWorktreeState, worktreeHasCap, worktreeStatesWith, worktreeStatesWithout,
} from './worktree-facts.js'
import {
  WORKTREE_STATES, worktreeHasCap, worktreeStatesWith,
} from './worktree-facts.js'

/** 状态文案（面板 / task_status / 通知共用）。 */
export const WORKTREE_STATE_LABEL = Object.freeze({
  none: '未隔离',
  requested: '待建检出',
  created: '已隔离',
  reused: '复用已有检出',
  degraded: '已降级（不是 git 仓库）',
  rejected: '隔离被拒绝',
  failed: '隔离创建失败',
  cleaned: '检出已清理',
})

export const DEFAULT_BRANCH_PREFIX = 'orch/'
export const WORKTREE_POLICIES = Object.freeze(['required', 'auto', 'off'])
export const WORKTREE_MODES = Object.freeze(['new', 'continue'])
export const WORKTREE_CLEANUPS = Object.freeze(['off', 'checkout-only', 'full'])
/** 决策来源：协调者传字段 / 配置兜底 / 都没说（面板要能回答「谁决定的」）。 */
export const WORKTREE_SOURCES = Object.freeze(['task', 'config', 'default'])

export const REQUIRED_FALLBACK_HINT = '按配置 worktreePolicy=required 建了隔离（协调者未传参数）'
export const REQUIRED_SKIP_HINT = '配置声明 required，但本次未隔离（协调者判断）；若属漏传请重派'
export const OFF_BUILD_HINT = '配置声明 off，按协调者要求建了隔离（不拦截）'
export const IMPLICIT_HINT = '按 worktree 相关字段推定要隔离（未显式传 worktree:true）'
export const DEGRADE_HINT = '目标不是 git 仓库，隔离已降级为普通模式；产物落在你当前工作树'
export const NO_CHECKOUT_HINT = '没有可复用的检出：改 worktreeMode="new" 或先派一个任务'
export const CLEANUP_HINT = 'worktreeCleanup 默认 "off"（检出与分支都保留）；"checkout-only" 只删检出、保留分支；"full" 连分支一起删'

/** 多分支时给协调者的引导（天数来自 config.worktreeRecentDays）。 */
export const askBranchHint = days => `仓库里近 ${days} 天有多个活跃分支：请 ask_user_question 让用户选基线，再带 worktreeBase 重调 task_create（本次未创建任务）`

/** 面板 / 任务卡小标：只有真的隔离了才出现。 */
export const WORKTREE_LIST_MARKER = '隔离'

const trim = value => (typeof value === 'string' ? value.trim() : '')

/** `task_create` 的 worktree* 参数 → 结构化请求（类型错立刻拒绝，不猜）。 */
export function parseWorktreeRequest(args = {}) {
  const raw = args?.worktree
  let worktree
  if (raw === undefined || raw === null) worktree = undefined
  else if (typeof raw === 'boolean') worktree = raw
  else {
    return {
      ok: false,
      error: 'worktree 只接受布尔值 true/false：字符串 "true" 不生效，v1 的 "auto" 已取消（要不要隔离由你按用户指引判断后显式传）',
    }
  }
  const baseRaw = args?.worktreeBase
  let base
  if (baseRaw === undefined || baseRaw === null || baseRaw === '') base = undefined
  else if (typeof baseRaw === 'string') base = baseRaw.trim()
  else return { ok: false, error: 'worktreeBase 必须是分支名/commit-ish 字符串（缺省 "default"）' }

  const branchRaw = args?.worktreeBranch
  let branch
  if (branchRaw === undefined || branchRaw === null || branchRaw === '') branch = undefined
  else if (typeof branchRaw === 'string') {
    branch = branchRaw.trim()
    if (!branchNameLooksValid(branch)) {
      return { ok: false, error: `worktreeBranch 不合法：${branchRaw}（不能含空格/~^:?*[\\、不能以 - 开头、不能出现 .. 或以 .lock 结尾）` }
    }
  } else return { ok: false, error: 'worktreeBranch 必须是字符串（缺省 orch/<taskId>）' }

  const modeRaw = args?.worktreeMode
  let mode = 'new'
  if (modeRaw !== undefined && modeRaw !== null && modeRaw !== '') {
    if (typeof modeRaw !== 'string' || !WORKTREE_MODES.includes(modeRaw)) {
      return { ok: false, error: `worktreeMode 只接受 ${WORKTREE_MODES.join(' / ')}` }
    }
    mode = modeRaw
  }

  const cleanupRaw = args?.worktreeCleanup
  let cleanup = 'off'
  if (cleanupRaw !== undefined && cleanupRaw !== null && cleanupRaw !== '') {
    if (typeof cleanupRaw !== 'string' || !WORKTREE_CLEANUPS.includes(cleanupRaw)) {
      return { ok: false, error: `worktreeCleanup 只接受 ${WORKTREE_CLEANUPS.join(' / ')}` }
    }
    cleanup = cleanupRaw
  }

  // 只给了 worktreeBase/Branch/Mode:continue 没传 worktree：按「要隔离」处理（防模型漏传把意图吃掉）。
  const implicit = worktree === undefined
    && (base !== undefined || branch !== undefined || mode === 'continue' || cleanup !== 'off')

  return { ok: true, request: { worktree, worktreeBase: base, worktreeBranch: branch, mode, cleanup, implicit } }
}

/** 台账行 → 请求快照（重派/面板复述用）。 */
export function requestOfTask(task = {}) {
  const brief = task.brief ?? {}
  return {
    worktree: typeof task.worktree_state === 'string' && task.worktree_state !== 'none' ? true : undefined,
    worktreeBase: trim(task.worktree_base) || undefined,
    worktreeBranch: trim(task.worktree_branch) || undefined,
    mode: task.worktree_mode === 'continue' ? 'continue' : 'new',
    cleanup: WORKTREE_CLEANUPS.includes(brief.worktreeCleanup) ? brief.worktreeCleanup : 'off',
    implicit: false,
  }
}

/** 是否隔离任务（台账列是唯一真相）。 */
export const isWorktreeTask = task => WORKTREE_STATES.includes(task?.worktree_state)
  && task.worktree_state !== 'none'
  && task.worktree_state !== 'rejected'

/** 真的建了检出（有路径、能交付、能清理）的状态（`hasCheckout` 能力 + 路径非空）。 */
export const hasCheckout = task => worktreeHasCap(task?.worktree_state, 'hasCheckout')
  && trim(task?.worktree_path) !== ''

/** 默认分支名：协调者传了就用协调者的；没传用 `<prefix><taskId>`（默认值填充，不算插件判断）。 */
export function branchNameFor(request = {}, taskId = '', prefix = DEFAULT_BRANCH_PREFIX) {
  const explicit = trim(request.worktreeBranch)
  if (explicit !== '') return explicit
  const candidatePrefix = trim(prefix) === '' ? DEFAULT_BRANCH_PREFIX : trim(prefix)
  const name = `${candidatePrefix}${taskId}`
  return branchNameLooksValid(name) ? name : `${DEFAULT_BRANCH_PREFIX}${taskId}`
}

/**
 * 第一步机械映射：只看结构化字段 + 配置 + 互斥规则 + 台账里的可复用检出。
 * 不碰 git、不碰文件；返回 none / reuse / reject / resolve（resolve 还要物理事实）。
 */
export function decideWorktreeIntent({
  request = {}, policy = 'auto', readOnly = false, planFirst = false, existingCheckout,
} = {}) {
  const explicitTrue = request.worktree === true || request.implicit === true
  const source = request.worktree !== undefined || request.implicit === true
    ? 'task'
    : (policy === 'required' ? 'config' : 'default')

  // #6 只读任务不写文件，隔离没有意义；显式要隔离直接拒绝（不静默吞掉）。
  if (explicitTrue && readOnly === true) {
    return { action: 'reject', code: 'READONLY_CONFLICT', source, error: '只读任务（readOnly:true）不写文件，worktree 与 readOnly 互斥：要隔离就派可写任务。' }
  }
  // #7 计划阶段本来就只读：建了也写不进；批准后要隔离请重新派发。
  if (explicitTrue && planFirst === true) {
    return { action: 'reject', code: 'PLAN_CONFLICT', source, error: '计划阶段不建隔离（planFirst + worktree 互斥）；批准后如需隔离，请带 worktree:true 重新派发。' }
  }
  // #8 / #9 复用已有检出。
  if (request.mode === 'continue') {
    if (existingCheckout !== undefined && trim(existingCheckout.path) !== '') {
      return {
        action: 'reuse',
        source,
        path: trim(existingCheckout.path),
        branch: trim(existingCheckout.branch),
        repoRoot: typeof existingCheckout.repoRoot === 'string' && existingCheckout.repoRoot !== '' ? existingCheckout.repoRoot : null,
        reuseTaskId: existingCheckout.taskId ?? null,
        hint: `复用已有检出 ${trim(existingCheckout.path)}（分支 ${trim(existingCheckout.branch) || '未知'}）`,
      }
    }
    return { action: 'reject', code: 'NO_CHECKOUT', source, error: `${NO_CHECKOUT_HINT}。` }
  }
  // #1 / #2 / #3 / #4 缺省兜底：不传 → 按配置；显式 false 但配置 required → 只给 hint 不拦。
  if (!explicitTrue && request.worktree === undefined && policy !== 'required') {
    return { action: 'none', source: 'default', hint: '' }
  }
  if (request.worktree === false) {
    return { action: 'none', source: 'task', hint: policy === 'required' ? REQUIRED_SKIP_HINT : '' }
  }
  const hint = policy === 'off' && request.worktree === true
    ? OFF_BUILD_HINT
    : (source === 'config' ? REQUIRED_FALLBACK_HINT : (request.implicit === true ? IMPLICIT_HINT : ''))
  return {
    action: 'resolve',
    source,
    hint,
    base: request.worktreeBase,
    branch: request.worktreeBranch,
    mode: request.mode,
  }
}

/**
 * 第二步机械映射：把物理事实（isRepo / 近 N 天分支数 / 基线是否存在）折成动作。
 * 结果：degrade / ask / reject(BASE_NOT_FOUND) / create。
 */
export function decideWorktreeFacts({ intent = {}, facts = {}, baseExists, recentDays = 7 } = {}) {
  if (facts.isRepo !== true) {
    return {
      action: 'degrade',
      source: intent.source,
      code: facts.reason ?? 'NOT_A_REPO',
      hint: DEGRADE_HINT,
    }
  }
  if (baseExists === false) {
    return {
      action: 'reject',
      code: 'BASE_NOT_FOUND',
      source: intent.source,
      candidates: (facts.recentBranches ?? []).map(item => item.name),
      defaultBranch: facts.defaultBranch,
      error: `worktreeBase 不存在：${intent.base ?? ''}；候选：${(facts.recentBranches ?? []).map(item => item.name).join('、') || facts.defaultBranch}`,
    }
  }
  if (trim(intent.base) === '' && facts.needsBranchChoice === true) {
    return {
      action: 'ask',
      source: intent.source,
      defaultBranch: facts.defaultBranch,
      n: facts.n ?? 0,
      candidates: (facts.recentBranches ?? []).map(item => item.name),
      hint: askBranchHint(recentDays),
    }
  }
  const base = trim(intent.base) !== '' ? trim(intent.base) : (trim(facts.suggestedBase) || trim(facts.defaultBranch) || 'default')
  return { action: 'create', source: intent.source, base, branch: intent.branch }
}

/**
 * 候选检出（同 group / 同 dependsOn 链上已建好且还在的），按「dependsOn 链 → 同 group」排序、去重。
 * 只做「哪些检出可复用」；「有没有被活跃任务占着」由调用方用 write-guard 的 `occupiesCheckout` 过滤
 * （同路径并发写的判定与 task_create/追问共用一组谓词，见 src/write-guard.js）。
 */
export function reusableCheckoutCandidates({ tasks = [], groupId = null, dependsOn = [] } = {}) {
  const deps = new Set(Array.isArray(dependsOn) ? dependsOn : [])
  // 可复用的检出必须是「目录真的还在」的两种状态（cleaned 的目录已删，复用会拿到空目录）。
  const usable = (Array.isArray(tasks) ? tasks : []).filter(task => task?.worktree_path
    && ['created', 'reused'].includes(task.worktree_state))
  const upstream = usable.filter(task => deps.has(task.id))
  const sameGroup = groupId === null || groupId === undefined ? [] : usable.filter(task => task.group_id === groupId)
  const seen = new Set()
  return [...upstream, ...sameGroup].filter(task => {
    if (seen.has(task.id)) return false
    seen.add(task.id)
    return true
  })
}

/** 第一个可复用的检出（`worktreeMode:'continue'` 的兼容入口；占用过滤在 tools.js 做）。 */
export function findReusableCheckout({ tasks = [], groupId = null, dependsOn = [] } = {}) {
  const pick = reusableCheckoutCandidates({ tasks, groupId, dependsOn })[0]
  if (pick === undefined) return undefined
  return {
    taskId: pick.id,
    path: pick.worktree_path,
    branch: pick.worktree_branch ?? '',
    // 源仓库根：复用任务的 target 偏移要靠它换算（检出目录里同一个子目录）。
    repoRoot: pick.repo_root ?? null,
  }
}

/** 多分支候选清单（协调者 ask_user_question 用；插件不弹问、不落库）。 */
export function branchChoiceText({ decision = {}, title = '', days = 7 } = {}) {
  const candidates = Array.isArray(decision.candidates) ? decision.candidates : []
  const lines = [
    `「${title}」要建 worktree，但仓库里近 ${days} 天有 ${decision.n ?? candidates.length} 个活跃分支，基线需要你定：`,
    ...candidates.map(name => `- ${name}`),
    `- 用默认分支 ${decision.defaultBranch ?? '(未知)'}`,
  ]
  lines.push('请让用户选一个基线，再带 worktreeBase 重调 task_create（本次未创建任务、没占并发位）。')
  lines.push('要跳过隔离就直接传 worktree:false。')
  return lines.join('\n')
}

/** `task_create` 返回给协调者的隔离说明（一行一条，普通任务返回空数组）。 */
export function worktreeNoteLines(worktree = {}) {
  const state = worktree.state
  const lines = []
  if (state === 'requested') {
    lines.push(`隔离：派发时新建分支 ${worktree.branch ?? '(待定)'}，检出 ${worktree.path ?? '(待定)'}，基线 ${worktree.base ?? 'default'}；产物在检出目录里，合并由你决定（插件不合并、不 push）。`)
  } else if (state === 'created') {
    lines.push(`隔离：新分支 ${worktree.branch}，检出 ${worktree.path}，基线 ${worktree.base ?? 'default'}。合并到你的工作树由你/用户决定（插件不合并、不 push）。`)
  } else if (state === 'reused') {
    lines.push(`隔离：复用已有检出 ${worktree.path}（分支 ${worktree.branch || '未知'}）。同一检出上的任务请用 dependsOn 串行，避免两个子会话写同一目录。`)
  } else if (state === 'degraded') {
    lines.push(`${DEGRADE_HINT}。`)
  } else if (state === 'failed') {
    lines.push(`隔离创建失败：${worktree.error ?? '未知原因'}。任务按失败处理，没有静默降级。`)
  } else if (state === 'cleaned') {
    lines.push(`隔离：检出已清理（${worktree.path ?? '-'}）。`)
  }
  if (typeof worktree.hint === 'string' && worktree.hint !== '') lines.push(`${worktree.hint}。`)
  return lines
}

/** `task_status` 的隔离行；非 worktree 任务返回 undefined（不追加，普通任务零字样）。 */
export function worktreeStatusLine(task = {}) {
  const state = task.worktree_state
  if (!WORKTREE_STATES.includes(state) || state === 'none') return undefined
  const source = WORKTREE_SOURCES.includes(task.worktree_source) ? task.worktree_source : 'default'
  const sourceText = source === 'task' ? '协调者传字段' : (source === 'config' ? '配置兜底' : '都没说')
  const branch = trim(task.worktree_branch)
  const path = trim(task.worktree_path)
  const base = trim(task.worktree_base)
  if (state === 'created' || state === 'reused' || state === 'cleaned') {
    const parts = [
      `隔离：${WORKTREE_STATE_LABEL[state]}`,
      branch === '' ? '分支 -' : `分支 ${branch}`,
      path === '' ? '检出 -' : `检出 ${path}`,
      base === '' ? '' : `基线 ${base}`,
      `决定 ${sourceText}`,
    ].filter(Boolean)
    if (state !== 'cleaned') parts.push('产物在检出目录里，合并由你决定')
    return parts.join('｜')
  }
  if (state === 'degraded') return `隔离：否（已降级：不是 git 仓库）｜决定 ${sourceText}`
  if (state === 'failed') return `隔离：创建失败｜原因 ${task.error ?? '未知'}｜决定 ${sourceText}`
  if (state === 'requested') return `隔离：待建检出（派发时建）｜基线 ${base || 'default'}｜分支 ${branch || '默认'}｜决定 ${sourceText}`
  return `隔离：${WORKTREE_STATE_LABEL[state]}｜决定 ${sourceText}`
}

/** `task_list` 行尾标记：只有真的隔离了才加「·隔离」（`showsBadge` 能力，排除已清理）。 */
export function worktreeListMarker(task = {}) {
  const state = task.worktree_state
  return worktreeHasCap(state, 'showsBadge') && state !== 'cleaned' ? `·${WORKTREE_LIST_MARKER}` : ''
}

/** 通知条目里的 worktree 块（tools.task_report 与结算通知共用同一口径）。 */
export const notifyWorktreeOf = task => (isWorktreeTask(task)
  ? {
    state: task.worktree_state,
    branch: task.worktree_branch ?? null,
    path: task.worktree_path ?? null,
    error: task.error ?? null,
  }
  : undefined)

/** 通知里的隔离行（产物在检出目录 → 用户工作树里没有这些改动，必须说清）。 */
export function worktreeNotifyLine(item = {}) {
  const worktree = item.worktree
  if (worktree === null || worktree === undefined) return ''
  const state = worktree.state
  if (state === 'created' || state === 'reused' || state === 'cleaned') {
    const branch = trim(worktree.branch) || '未知'
    const path = trim(worktree.path) || '未知'
    return `隔离：产物在分支 ${branch} 的检出目录 ${path}，合并到你当前分支由你决定`
  }
  if (state === 'degraded') return `隔离：未隔离（目标不是 git 仓库，已降级）；产物落在当前工作树`
  if (state === 'failed') return `隔离：创建失败（${worktree.error ?? '未知原因'}）`
  return ''
}

/** `task_detail` 给子会话的隔离说明（只需知道「在哪个目录、在哪个分支」，不要它碰分支）。 */
export function worktreeDetailLines(task = {}) {
  // 只有「检出真的可写」的两个状态给这段说明；cleaned 的目录已经没了，说了会误导。
  if (!['created', 'reused'].includes(task.worktree_state)) return []
  const path = trim(task.worktree_path)
  const branch = trim(task.worktree_branch)
  return [
    `【worktree 隔离】检出目录 ${path || '(未知)'}｜分支 ${branch || '(未知)'}｜基线 ${trim(task.worktree_base) || 'default'}`,
    '- 你就在这份检出目录里干活：产物路径都落在它下面，用户的工作树里没有这些改动；合并/提交到主线由用户决定（你不要切分支、不要 merge、不要 push）。',
  ]
}

/** 面板「决定者」短文案。 */
export function decisionSourceLabel(source) {
  return source === 'task' ? '协调者传字段' : (source === 'config' ? '配置兜底' : '都没说（不隔离）')
}
