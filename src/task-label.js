// 对外文案的显示名：t-xxx 只留在日志/台账；重名时附短 id 后缀（取 t-xxx 后 4 位）。
const titleOf = task => String(task?.title ?? '').trim()
const idOf = task => String(task?.id ?? '')

export function shortTaskId(id) {
  const text = idOf({ id })
  const bare = text.startsWith('t-') ? text.slice(2) : text
  return bare.slice(0, 4)
}

/**
 * 显示名：默认 title；同集合里还有同名任务（trim 后相同、id 不同）时附短 id。
 * @param {object} task 台账任务行
 * @param {{all?: object[]}} options all = 用于判重的全量任务
 */
export function taskLabel(task, { all = [] } = {}) {
  const title = titleOf(task)
  const id = idOf(task)
  const name = title !== '' ? title : (id !== '' ? `任务 ${id}` : '任务')
  const duplicate = title !== '' && Array.isArray(all) && all.some(other =>
    other !== task && idOf(other) !== id && titleOf(other) === title)
  return duplicate ? `${name}（${shortTaskId(id)}）` : name
}

/** 模型需要 id 继续操作的三处返回（task_create/task_list/task_status）统一用「标题（t-xxxx）」。 */
export function taskLabelWithId(task) {
  const title = titleOf(task)
  const id = idOf(task)
  if (id === '') return title !== '' ? title : '任务'
  return `${title !== '' ? title : '任务'}（${id}）`
}
