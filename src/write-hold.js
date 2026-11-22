// 写域瞬时占位（write-hold）：追问 / 续跑 / 批准在「guard 通过」与「真正投递」之间要先占住目标，
// 否则 `await send` 的窗口里另一条 `task_create` 能通过判定，两个子会话同时写同一份工作树。
//
// 为什么是内存 hold 而不是「先迁 running」：
// - `running → done` 没有合法回边（`status-facts.js` 已刻意删死边），resume 的 `done(timeout)` 来源
//   无法「先迁 running 再回滚」；
// - 保持既有纪律「**投递成功才迁状态**」：失败时状态与死因原样保留，不需要新的回滚分支；
// - hold 只是「这 120 秒内这个 taskId 占着这些路径」，不污染台账、不新增状态、重启即清（无残留）。
//
// 引用计数（P0-3，v6 规格）：
// - 每个 hold 按 **ownerToken** 记账（工具 `tool:<callId>`、面板 `panel:<requestId>`）；同一 task 的
//   工具投递与面板投递**互不覆盖**：先 release 一侧，另一侧仍占着（否则 finally 一次就误放）。
// - 过期 owner 在读取时剔除（`expiresAt <= now`），只剩过期 owner 的 hold 直接删除——过期 token 不得继续占路径。
// - 合并：**仅路径重叠才合并**（`C:\a\b` + `C:\a\c` 不得合成 `C:\a` 去误拦 `C:\a\d`），不重叠就并列视图；
//   跨盘符天然并列。`activeWriteHolds` 因此返回**数组**，同一 taskId 可能出现多条视图。
//
// 展开成「虚拟任务」后交给 write-guard 的既有谓词（`occupiesTarget` / `occupiesCheckout` 等），
// 所以判定函数一行都不用改：hold 的 status 固定 `running`（活跃且未交付），read_only=false。
import { resolve, sep } from 'node:path'

export const DEFAULT_WRITE_HOLD_TTL_MS = 120_000

// taskId → { taskId, owners: Map<ownerToken, {token,targetDir,writeScopes,checkoutPath,acquiredAt,expiresAt}> }
const holds = new Map()
// 诊断日志出口（index.js 注入 logger；未注入时静默）。合并/并列视图只在这里留痕，不影响判定。
let logSink = () => {}
export function setWriteHoldLogger(sink) {
  logSink = typeof sink === 'function' ? sink : () => {}
}
const log = (event, fields) => {
  try { logSink(event, fields) } catch { /* 日志失败不影响占位 */ }
}

const text = value => (typeof value === 'string' ? value.trim() : '')

// 与 write-guard 的 `normalizePath` / `pathsOverlap` 同口径（write-guard 依赖本模块的 heldTaskView，
// 反向 import 会成环，所以这里保留一份最小实现；口径变化时两处一起改）。
const normalizedPath = value => {
  const raw = text(value)
  if (raw === '') return ''
  let path
  try {
    path = resolve(raw)
  } catch {
    return raw
  }
  const stripped = path.length > 1 ? path.replace(/[\\/]+$/, '') : path
  return process.platform === 'win32' ? stripped.toLowerCase() : stripped
}
const pathsOverlap = (left, right) => {
  const a = normalizedPath(left)
  const b = normalizedPath(right)
  if (a === '' || b === '') return false
  if (a === b) return true
  return a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`)
}
const normalizeScopes = scopes => {
  const list = (Array.isArray(scopes) ? scopes : [])
    .map(scope => text(scope).replace(/\\/g, '/').replace(/\/+$/, '').slice(0, 200))
    .filter(scope => scope !== '')
  return [...new Set(list)]
}

/**
 * 占住一个任务的写域（目标目录 / 写域 / 检出）。
 *
 * `ownerToken` 必填语义（缺省时生成一次性 token，调用方仍应在 acquire 与所有 release 之间共用同一个）：
 * 同一 token 重复 acquire 只更新字段并刷新 `expiresAt = max(now+ttl, 现有)`；不同 token 增加 owner。
 *
 * @returns {object|undefined} 归一后的 owner 视图；taskId 非法时返回 undefined（不占位）。
 */
export function acquireWriteHold({
  taskId,
  ownerToken,
  targetDir,
  writeScopes = [],
  checkoutPath = '',
  ttlMs = DEFAULT_WRITE_HOLD_TTL_MS,
  now = Date.now(),
} = {}) {
  const id = text(taskId)
  if (id === '') return undefined
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_WRITE_HOLD_TTL_MS
  const token = text(ownerToken) === '' ? `anon:${id}:${now}:${Math.random().toString(36).slice(2, 8)}` : text(ownerToken)
  let hold = holds.get(id)
  if (hold === undefined) {
    hold = { taskId: id, owners: new Map() }
    holds.set(id, hold)
  }
  const existing = hold.owners.get(token)
  const expiresAt = Math.max(now + ttl, existing?.expiresAt ?? 0)
  const owner = {
    token,
    targetDir: text(targetDir),
    writeScopes: normalizeScopes(writeScopes),
    checkoutPath: text(checkoutPath),
    acquiredAt: existing?.acquiredAt ?? now,
    expiresAt,
  }
  hold.owners.set(token, owner)
  return { ...owner, taskId: id }
}

/**
 * 释放占位（幂等：没有也当成功）。
 *
 * - 带 `ownerToken`：只释放自己的 owner；owner 清空才删 hold（工具/面板各自的 finally 走这条）；
 * - 不带 `ownerToken`：强制清空整个任务（**只允许** stop/close/终态，见 S10' 静态断言）。
 */
export function releaseWriteHold(taskId, ownerToken) {
  const id = text(taskId)
  if (id === '') return false
  const hold = holds.get(id)
  if (hold === undefined) return false
  if (ownerToken === undefined) return holds.delete(id)
  const token = text(ownerToken)
  if (token === '') return false
  const removed = hold.owners.delete(token)
  if (hold.owners.size === 0) holds.delete(id)
  return removed
}

/** 续期：只更新自己 token 的 `expiresAt`（心跳用；别的 owner 的到期时间不受影响）。 */
export function touchWriteHold(taskId, ownerToken, ttlMs = DEFAULT_WRITE_HOLD_TTL_MS, now = Date.now()) {
  const id = text(taskId)
  const token = text(ownerToken)
  if (id === '' || token === '') return false
  const hold = holds.get(id)
  if (hold === undefined) return false
  const owner = hold.owners.get(token)
  if (owner === undefined) return false
  const ttl = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : DEFAULT_WRITE_HOLD_TTL_MS
  owner.expiresAt = Math.max(now + ttl, owner.expiresAt)
  return true
}

/** 剔除过期 owner（只剩过期 owner 的 hold 直接删除）；返回仍存活的 hold 列表。 */
const liveHolds = now => {
  const live = []
  for (const [id, hold] of holds) {
    for (const [token, owner] of hold.owners) {
      if (owner.expiresAt <= now) hold.owners.delete(token)
    }
    if (hold.owners.size === 0) {
      holds.delete(id)
      continue
    }
    live.push(hold)
  }
  return live
}

/**
 * 组件内取「最宽」的路径（是所有其它路径的祖先）；不存在这样的唯一祖先时 `ok:false`（调用方拆子视图）。
 * @returns {{ok:boolean, value:string}}
 */
const widestPath = values => {
  const pairs = values
    .map(value => ({ raw: text(value), norm: normalizedPath(value) }))
    .filter(pair => pair.norm !== '')
  if (pairs.length <= 1) return { ok: true, value: pairs[0]?.raw ?? '' }
  const candidates = pairs.filter(pair => pairs.every(other => other.norm === pair.norm || other.norm.startsWith(`${pair.norm}${sep}`)))
  if (candidates.length === 0) return { ok: false, value: '' }
  candidates.sort((left, right) => left.norm.length - right.norm.length)
  return { ok: true, value: candidates[0].raw }
}

const viewOf = (taskId, owners) => {
  const target = widestPath(owners.map(owner => owner.targetDir))
  const checkout = widestPath(owners.map(owner => owner.checkoutPath))
  const scopes = [...new Set(owners.flatMap(owner => owner.writeScopes))]
  return {
    taskId,
    targetDir: target.value,
    writeScopes: scopes,
    checkoutPath: checkout.value,
    expiresAt: Math.max(...owners.map(owner => owner.expiresAt)),
    ownerCount: owners.length,
    ownerTokens: owners.map(owner => owner.token),
    // 内部标记（不对外承诺）：false = 组件内不存在唯一祖先，调用方拆子视图。
    _targetAncestor: target.ok,
    _checkoutAncestor: checkout.ok,
  }
}

/** 把同一 task 的 owner 按「路径重叠」分组（重叠才有资格合并）。 */
const componentsOf = owners => {
  const parent = owners.map((_, index) => index)
  const find = index => {
    let root = index
    while (parent[root] !== root) root = parent[root]
    let cursor = index
    while (parent[cursor] !== cursor) {
      const next = parent[cursor]
      parent[cursor] = root
      cursor = next
    }
    return root
  }
  const union = (left, right) => {
    const a = find(left)
    const b = find(right)
    if (a !== b) parent[b] = a
  }
  for (let i = 0; i < owners.length; i += 1) {
    for (let j = i + 1; j < owners.length; j += 1) {
      if (pathsOverlap(owners[i].targetDir, owners[j].targetDir)
        || pathsOverlap(owners[i].checkoutPath, owners[j].checkoutPath)) {
        union(i, j)
      }
    }
  }
  const groups = new Map()
  owners.forEach((owner, index) => {
    const root = find(index)
    const list = groups.get(root) ?? []
    list.push(owner)
    groups.set(root, list)
  })
  return [...groups.values()]
}

const driveOf = path => {
  const match = /^([a-z]:)[\\/]/i.exec(path)
  return match === null ? '' : match[1].toLowerCase()
}

/**
 * 当前有效的 hold 视图（顺手剔除过期 owner）：调用方只拿「此刻还算占着」的那批。
 *
 * @returns {Array<{taskId:string,targetDir:string,writeScopes:string[],checkoutPath:string,expiresAt:number,ownerCount:number,ownerTokens:string[]}>}
 *   同一 taskId 可能有多条视图（互不重叠的并发投递 / 跨盘符）：调用方按视图逐条合并台账行，**不要**假设一 task 一视图。
 */
export function activeWriteHolds(now = Date.now()) {
  const views = []
  for (const hold of liveHolds(now)) {
    const components = componentsOf([...hold.owners.values()])
    const taskViews = []
    for (const component of components) {
      const view = viewOf(hold.taskId, component)
      if (component.length > 1 && (view._targetAncestor !== true || view._checkoutAncestor !== true)) {
        // 组件内有路径但没有唯一祖先（异常形状）：拆成每条 owner 一个子视图，宁可少并一条，不多拦一片。
        log('write-hold.split', {
          taskId: hold.taskId,
          detail: { tokens: component.map(owner => owner.token), values: component.map(owner => owner.targetDir), chosen: null, reason: 'split-no-common-ancestor' },
        })
        for (const owner of component) taskViews.push(viewOf(hold.taskId, [owner]))
        continue
      }
      if (component.length > 1) {
        log('write-hold.merge', {
          taskId: hold.taskId,
          detail: {
            tokens: component.map(owner => owner.token),
            values: component.map(owner => ({ targetDir: owner.targetDir, checkoutPath: owner.checkoutPath })),
            chosen: { targetDir: view.targetDir, checkoutPath: view.checkoutPath },
            reason: 'overlap-merged',
          },
        })
      }
      taskViews.push(view)
    }
    if (taskViews.length > 1) {
      const drives = new Set(taskViews.flatMap(view => [driveOf(normalizedPath(view.targetDir)), driveOf(normalizedPath(view.checkoutPath))]).filter(drive => drive !== ''))
      log('write-hold.parallel-views', {
        taskId: hold.taskId,
        detail: { views: taskViews.length, drives: [...drives], reason: drives.size > 1 ? 'cross-drive' : 'no-overlap' },
      })
    }
    views.push(...taskViews.map(publicView))
  }
  return views
}

// 去掉内部标记后的对外视图（`_` 前缀字段不对外承诺）。
const publicView = ({ _targetAncestor, _checkoutAncestor, ...view }) => view

/** hold 的每条 owner 明细（诊断/测试用；不含过期项）。 */
export function writeHoldOwners(taskId, now = Date.now()) {
  const hold = holds.get(text(taskId))
  if (hold === undefined) return []
  return [...hold.owners.values()]
    .filter(owner => owner.expiresAt > now)
    .map(owner => ({ ...owner, writeScopes: [...owner.writeScopes] }))
}

/** 任务此刻是否仍被 hold（动作层只问这个，不直接碰 `activeWriteHolds`）。 */
export function isWriteHeld(taskId, now = Date.now()) {
  const hold = holds.get(text(taskId))
  if (hold === undefined) return false
  for (const [token, owner] of hold.owners) {
    if (owner.expiresAt <= now) hold.owners.delete(token)
  }
  if (hold.owners.size === 0) {
    holds.delete(text(taskId))
    // 全部 owner 都过期 = 已经不被占：旧实现删空后仍 return true，会让「过期剔除」多误判一次。
    return false
  }
  return true
}

/** hold → 虚拟任务行（只实现判定用到的字段，别假装是台账行）。 */
export function heldTaskView(hold) {
  return {
    id: hold.taskId,
    target_dir: hold.targetDir,
    write_scopes: hold.writeScopes,
    worktree_path: hold.checkoutPath,
    status: 'running',
    read_only: false,
  }
}

/** 测试用：清空全部 hold（避免用例之间互相污染）。 */
export function __resetHolds() {
  holds.clear()
}

/** 测试 / 诊断用：当前 hold 数量（按任务，不按 owner）。 */
export const writeHoldCount = () => holds.size
