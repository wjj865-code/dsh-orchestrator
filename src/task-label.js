// 对外文案的显示名：**用户面只用任务名 + 引用（tk-xxxxxx）**，台账内部编号只留在台账/日志。
//
// 版本 B《ID 出口网关》（用户拍板）：工具回执与面板不再把 `t-xxxx` 喂给模型/用户——
// 引用值一律换成 `tk-xxxxxx`；重名时也附引用而不是内部编号的后 4 位。
// 兜底：任务行没有 `ref`（旧库尚未回填 / 测试里手搓的行）时退回 `shortTaskId` 的 4 位后缀，
// 保持重名仍可区分；那 4 位不构成 `t-xxxx` 形态，不违反「用户面零裸编号」。
const titleOf = task => String(task?.title ?? '').trim()
const idOf = task => String(task?.id ?? '')
const refOf = task => String(task?.ref ?? '').trim()

export function shortTaskId(id) {
  const text = idOf({ id })
  const bare = text.startsWith('t-') ? text.slice(2) : text
  return bare.slice(0, 4)
}

/** 重名后缀：优先任务引用（tk-xxxxxx），没有引用时退回 4 位短后缀。 */
const suffixOf = task => {
  const ref = refOf(task)
  return ref !== '' ? ref : shortTaskId(idOf(task))
}

/**
 * 显示名：默认 title；同集合里还有同名任务（trim 后相同、id 不同）时附引用。
 * @param {object} task 台账任务行
 * @param {{all?: object[]}} options all = 用于判重的全量任务
 */
export function taskLabel(task, { all = [] } = {}) {
  const title = titleOf(task)
  const id = idOf(task)
  const name = title !== '' ? title : (id !== '' ? `任务 ${suffixOf(task)}` : '任务')
  const duplicate = title !== '' && Array.isArray(all) && all.some(other =>
    other !== task && idOf(other) !== id && titleOf(other) === title)
  return duplicate ? `${name}（${suffixOf(task)}）` : name
}

/**
 * 模型需要「可读引用」继续操作的三处返回（task_create / task_list / task_status）统一用
 * 「标题（tk-xxxxxx）」——引用是模型手里**唯一**的任务标识，回复里抄到的是 tk-，不是裸编号。
 */
export function taskLabelWithRef(task) {
  const title = titleOf(task)
  const suffix = suffixOf(task)
  const name = title !== '' ? title : '任务'
  return suffix === '' ? name : `${name}（${suffix}）`
}
