/**
 * 配置卡片的**纯逻辑**（P10）：不做渲染、不碰 React，可在 node 里直接单测。
 *
 * 为什么单独拆出来：`config-form.js` 含 JSX，Node 无法直接 import（平台只经 vite 编译）。
 * 而「保存时到底发什么操作」「什么算有改动」是这张卡片最容易出错、也最该被测试钉住的部分，
 * 不能因为文件里有 JSX 就只靠「渲染冒烟」间接覆盖。所以纯决策逻辑放这里。
 */
import { EDITABLE_KEYS, FIELD_BY_KEY } from '../../src/config-fields.js'

/** 配置卡片在 `plugins.bundle.config` 上的 key：bundle 包名。 */
export const CONFIG_SLOT_KEY = '@wjj865-code/dsh-orchestrator'
/** `configForms.get()` / `whileServed()` 用的 Loader entry id（cordis.patch.yml 的 `id: orchestrator`）。 */
export const CONFIG_ENTRY_ID = 'orchestrator'

/**
 * 分组折叠状态默认全展开。
 * 轮换分组以前整体只读、默认折叠（省一屏噪声）；本版起 7 个键能改、总开关默认还开着，
 * 折叠反而让「关掉轮换」要多点一次——所以一起展开，折叠能力保留给用户自己收。
 */
export const COLLAPSED_BY_DEFAULT = Object.freeze([])

/** 把宿主快照里的值摊平成普通标量（宿主的 volatile 字段在 wire 上已是普通 JSON）。 */
export const plainValues = value => (typeof value === 'object' && value !== null ? value : {})

/** 一个字段「是否被用户覆盖」：看 user 层有没有这个键（存在即覆盖，与值是否等于默认无关）。 */
export const overriddenKeys = user => new Set(Object.keys(plainValues(user)))

/**
 * 判断草稿相对生效值是否有变化。只读字段不计入——它们永远不该让「保存」按钮亮起来。
 * @param {Record<string, unknown>} draft 草稿。
 * @param {Record<string, unknown>} saved 生效值。
 * @returns {boolean} true = 有未保存改动。
 */
export const isDirty = (draft, saved) => {
  const keys = new Set([...Object.keys(draft), ...Object.keys(saved)])
  for (const key of keys) {
    if (!EDITABLE_KEYS.includes(key)) continue
    if (draft[key] !== saved[key]) return true
  }
  return false
}

/**
 * 数字字段夹到字段区间（整数键先四舍五入再夹一次，避免 round 之后越界）。
 *
 * 为什么**必须**在保存前夹：宿主 schemastery 对越界值的处理是**回落默认**（`.loose()`），
 * 不是夹到边界。卡片若把 0.05 原样写进 profile（字段区间是 0.1–0.95），宿主 schema 会把
 * 它解析成默认值 0.4——用户在卡片和 YAML 上看到 0.05，运行时却按 0.4 跑，且卡片还标着
 * 「已覆盖」。这是 0.25.0 真机验证实测到的缺陷（`contextPressureThreshold` 写 0.05 后，
 * 插件日志里的 threshold 仍是 0.4）。夹完再写，「写下去的值 = 运行时 loadConfig 读到的值」。
 * @param {object} field 字段规格（含 min / max / integer）。
 * @param {unknown} value 草稿里的值。
 * @returns {unknown} 夹到区间内的数字；非有限数字原样返回（交给 schema/loadConfig 兜底）。
 */
export function clampFieldNumber(field, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value
  const min = Number.isFinite(field?.min) ? field.min : undefined
  const max = Number.isFinite(field?.max) ? field.max : undefined
  let next = field?.integer === true ? Math.round(value) : value
  if (min !== undefined && next < min) next = min
  if (max !== undefined && next > max) next = max
  return next
}

/**
 * 由草稿生成 mutate 操作列表：只发**真正改了**的可编辑字段。
 *
 * 语义细节：清空一个「已覆盖」字段发 `unset`（回落组合默认、且不再算覆盖），
 * 而不是写一个「等于默认的值」——后者在 `settings.describe` 里仍会被标成「已覆盖」，
 * 用户看到的标签就错了。清空一个「本来没覆盖」的字段则不发操作。
 *
 * 数字字段在下发前夹到字段区间（见 {@link clampFieldNumber}）：越界值会被宿主 schema
 * 静默丢掉并回落默认，写下去等于没改。
 * @param {Record<string, unknown>} draft 草稿。
 * @param {Record<string, unknown>} saved 生效值。
 * @param {Set<string>} overridden 已覆盖字段集合。
 * @returns {Array<{op: 'set'|'unset', path: string[], value?: unknown}>} 路径级操作。
 */
export function buildOps(draft, saved, overridden) {
  const ops = []
  for (const key of EDITABLE_KEYS) {
    if (draft[key] === saved[key]) continue
    if (draft[key] === '' || draft[key] === undefined || draft[key] === null) {
      if (overridden.has(key)) ops.push({ op: 'unset', path: [key] })
      continue
    }
    const field = FIELD_BY_KEY[key]
    const value = field !== undefined && field.kind === 'number' ? clampFieldNumber(field, draft[key]) : draft[key]
    ops.push({ op: 'set', path: [key], value })
  }
  return ops
}

/**
 * 把输入控件的原始字符串还原成字段该有的类型。
 * 数字字段空串 → `''`（交给 buildOps 当「清空」处理）；非法数字 → 原样保留字符串，
 * 由宿主 schema 的 `.loose()` 回落默认并在保存后刷新显示，不在这里猜用户意图。
 * @param {object} field 字段规格。
 * @param {unknown} text 控件里的原始值。
 * @returns {unknown} 归一后的值。
 */
export function parseInput(field, text) {
  if (field.kind === 'boolean') return text === true || text === 'true'
  if (field.kind === 'number') {
    if (text === '') return ''
    const numeric = Number(text)
    return Number.isFinite(numeric) ? numeric : text
  }
  return text
}
