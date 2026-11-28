// 协调者名单（多协调者，0.36.0）：纯函数，不碰 db / 不碰宿主服务。
//
// 语义（用户 2026-11-26 拍板）：
//   - 名单是**有序数组**：`[0]` = 主协调者（primary），决定「打开主会话」打开谁、日报挂谁、
//     通知的兜底目标是谁；
//   - 上限 `MAX_COORDINATORS`（4）是硬常量、不进配置面（配置仍 24 键）：名单不是越多越好，
//     每个协调者都会收到自己任务的回报，4 个已经够用；
//   - 「设为协调者」= 加入名单并**提升为主**（前插）；已在名单里再设一次只提升、不重复；
//   - 「退出协调者」= 从名单删除；删首位则下一位升主；删光等于回到「尚未打开主会话」；
//   - id 一律**逐字**比较（来自台账/宿主，不做 trim 之外的归一，更不做大小写归一）。
//
// 为什么不把 db 读写放这里：台账/设置是 `src/ledger.js` 的唯一职责，这里只做「怎么算」，
// 这样上限、去重、前插、升主这些容易出错的分支都能用纯函数单测锁死（test/coordinator-set.test.js）。

/** 名单上限：常量。为什么不进配置面：配置面每加一键要同步 CONFIG 文档/参考表/门禁，收益不足。 */
export const MAX_COORDINATORS = 4

/**
 * 单个 id 的归一：只接受非空字符串，去首尾空白；其余（数字/对象/空白串）一律丢弃。
 * @param {unknown} value
 * @returns {string|undefined}
 */
export function coordinatorIdOf(value) {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text === '' ? undefined : text
}

/**
 * 名单归一：去非法项 → 去重（保序）→ 截断到上限。
 * @param {unknown} value 数组或「数组样」值
 * @returns {string[]}
 */
export function normalizeCoordinatorIds(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    const id = coordinatorIdOf(item)
    if (id === undefined || out.includes(id)) continue
    out.push(id)
    if (out.length >= MAX_COORDINATORS) break
  }
  return out
}

/**
 * 解析 settings 里的名单字符串（JSON 数组）。
 * 坏 JSON / 非数组 / 空串一律回落 `[]`——读路径绝不为一行脏数据抛错。
 * @param {unknown} raw
 * @returns {string[]}
 */
export function parseCoordinatorIds(raw) {
  if (Array.isArray(raw)) return normalizeCoordinatorIds(raw)
  if (typeof raw !== 'string') return []
  const text = raw.trim()
  if (text === '') return []
  try {
    return normalizeCoordinatorIds(JSON.parse(text))
  } catch {
    return []
  }
}

/** 名单序列化成 settings 值（空名单回空串，便于「键存在但没成员」和「键不存在」都读成 []）。 */
export function serializeCoordinatorIds(ids) {
  const list = normalizeCoordinatorIds(ids)
  return list.length === 0 ? '' : JSON.stringify(list)
}

/** 主协调者（名单首位）；空名单 → undefined。 */
export function primaryCoordinatorOf(ids) {
  return Array.isArray(ids) && ids.length > 0 ? ids[0] : undefined
}

/** 是不是名单成员（逐字比较）。 */
export function isCoordinatorId(ids, id) {
  const value = coordinatorIdOf(id)
  return value !== undefined && Array.isArray(ids) && ids.includes(value)
}

/**
 * 加入名单并提升为主（前插）。三种结果要分得清，面板/日志据此说人话：
 *   - `added:true`            新成员，已成为主协调者；
 *   - `added:false, promoted:true`  本来就在名单里，这次只提升为主（幂等重设）；
 *   - `added:false, promoted:false, unchanged:true`  已经是主协调者，什么都没变；
 *   - `limitReached:true`     名单已满且不是成员 → **名单原样返回**，调用方决定拒绝或腾位。
 * @param {string[]} ids 当前名单
 * @param {unknown} id 目标会话 id
 */
export function addCoordinatorId(ids, id) {
  const current = normalizeCoordinatorIds(ids)
  const value = coordinatorIdOf(id)
  if (value === undefined) return { ids: current, added: false, promoted: false, unchanged: false, limitReached: false }
  const index = current.indexOf(value)
  if (index === 0) return { ids: current, added: false, promoted: false, unchanged: true, limitReached: false }
  if (index > 0) {
    const next = [value, ...current.filter(item => item !== value)]
    return { ids: next, added: false, promoted: true, unchanged: false, limitReached: false }
  }
  if (current.length >= MAX_COORDINATORS) {
    return { ids: current, added: false, promoted: false, unchanged: false, limitReached: true }
  }
  return { ids: [value, ...current], added: true, promoted: false, unchanged: false, limitReached: false }
}

/**
 * 从名单删除；删首位则下一位升主。
 * @param {string[]} ids 当前名单
 * @param {unknown} id 目标会话 id
 * @returns {{ids: string[], dropped: boolean, primaryChanged: boolean}}
 */
export function removeCoordinatorId(ids, id) {
  const current = normalizeCoordinatorIds(ids)
  const value = coordinatorIdOf(id)
  if (value === undefined) return { ids: current, dropped: false, primaryChanged: false }
  const index = current.indexOf(value)
  if (index === -1) return { ids: current, dropped: false, primaryChanged: false }
  const next = current.filter(item => item !== value)
  return { ids: next, dropped: true, primaryChanged: index === 0 }
}
