// 出口清洗（版本 B《ID 出口网关》第 ② 层）：**写入前**把台账已知的内部编号换成任务引用。
//
// 为什么需要它：光「不喂 id」不够——标题、summary、计划正文是模型自己写的，它可能把从台账/日志里
// 看到的 `t-xxxx` 顺手抄进去，而这些字段会被落进计划文档、通知、面板抽屉，一路到用户眼前。
// 这里做一道**确定性**清洗（不是提示词）：命中就替换成 `tk-xxxxxx`，并回报命中清单供日志留痕。
//
// 边界（不得放宽）：
//   1. **只替换台账已知的编号**，不做泛化正则脱敏——真正的用户内容（例如某仓库的文件名里恰好有
//      `t-abc12345`）不该被误改；查不到的任务编号原样保留。
//   2. 台账/日志/handoff JSONL 不清洗（那里必须保留 id：排障与审计的索引键）。
//   3. 只处理「任务编号」这一种标识；会话 id 属于平台标识，回执里按用户拍板**保留**。
//   4. 不做 HTML/Markdown 转义（清洗只换值，不动结构）。
import { TASK_ID_RE } from './task-ref.js'

/** 全串形态判定：整个字段就是一个编号（`task_create.title` 这种短字段的快速路径）。 */
export const isTaskIdText = value => typeof value === 'string' && TASK_ID_RE.test(value.trim())

// 只扫描「像任务编号」的片段，命中后再查台账确认（不做模糊/前缀匹配）。
const ID_IN_TEXT = /\bt-[0-9a-z]{4,32}\b/g

/**
 * 建一个清洗函数：`sanitize(text)`。查表函数由调用方给（`id => tk-...`，查不到返回空）。
 *
 * 不在这里 import `src/task-ref.js` 的 `taskRefOf`：那会引入「读库」依赖，
 * 让本模块从纯函数变成有状态的；调用方（tools/notify）把 `taskRefOf(db, id)` 注入即可单测。
 *
 * @param {{refOf?: (taskId: string) => string | undefined | null,
 *   onHit?: (taskId: string, ref: string) => void}} [options]
 * @returns {(text: string) => string}
 */
export function createUserFacingSanitizer({ refOf, onHit } = {}) {
  const lookup = typeof refOf === 'function' ? refOf : () => undefined
  const hit = typeof onHit === 'function' ? onHit : () => {}
  return function sanitize(text) {
    if (typeof text !== 'string' || text === '') return text
    if (!text.includes('t-')) return text
    return text.replace(ID_IN_TEXT, match => {
      const ref = lookup(match)
      if (typeof ref !== 'string' || ref === '') return match
      hit(match, ref)
      return ref
    })
  }
}

/**
 * 一次性清洗（不缓存查表结果，适合少量字段）：`sanitizeUserFacing(text, { refOf, onHit })`。
 * 同一批字段要清洗多次时用 `createUserFacingSanitizer`（预编译换行更省）。
 */
export function sanitizeUserFacing(text, { refOf, onHit } = {}) {
  return createUserFacingSanitizer({ refOf, onHit })(text)
}

/** 清洗一组字符串（选项列表这种）：空值/非字符串原样丢弃，不做占位。 */
export function sanitizeUserFacingList(values, options) {
  if (!Array.isArray(values)) return []
  const sanitize = createUserFacingSanitizer(options)
  return values.map(value => sanitize(value))
}
