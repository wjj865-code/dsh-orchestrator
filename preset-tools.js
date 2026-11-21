// 预设内的工具收窄：两种形态，都只靠 `ctx.tools.restrict({ deny })`（不用 allow）。
//
// 平台契约（docs/probes/preset-scope-restrict.mjs，真机 ToolsService 实验可复现）：
// - 预设 scope 里 `tools.restrict({ allow })` 会把**同一 scope 注册的工具**（如
//   `ask_user_question`）一起遮掉：agent 视图沿 scope 链取交集，预设自己的工具也在链上。
// - 同一 scope 里 `restrict` 又不允许 allow 出现非全局工具名（抛 `unknown global tool`）。
// 所以「allow 名单」在预设层只能用补集表达：deny 掉所有**已注册的全局工具**中不在 allow 名单里的项；
// 预设自己挂的工具不受影响。
//
// 两种形态（config 里二选一）：
//   1. `allow`（保留式）：deny 掉不在名单里的已注册全局工具。allow 必须显式非空。
//      0.26.0 起**本插件的两个预设都不再用它**（协调者改为遮挡式，见下）；保留形态只为兼容旧 profile
//      与 docs/probes 的语义实验，别再往新配置里用。
//   2. `deny`（遮挡式，协调者与子会话同形）：只 deny 点名的全局工具，其余原样继承。
//      - 协调者：只点名「编排正确性」项 + 三个角色专属工具（task_report / task_detail / plan_save）；
//        工具面其余部分全开（read/skill 由预设行自己挂，写由 read-only 权限预设兜底）。
//      - 子会话：**不点名遮任何工具**（deny 为空）。0.29.x 存量的「遮 memory_note（写记忆仍仅主会话）」
//        已按用户方向撤掉：子会话也能写**项目级**记忆（note/lesson/decision，project 强制为任务 target_dir、
//        单任务 ≤3 条），全局偏好与跨项目记忆仍只协调者——那部分由执行层按归属校验。只给 keep。
//      两边都不用 allow 补集：那需要把平台所有全局工具名抄全，漏一个 = 悄悄少一个工具。
//
// `keep`（仅遮挡式）：正向声明「这些全局工具必须对该会话**出生即可用**」
//   （协调者声明 7 个任务工具；子会话声明只读的 `context`、`task_detail`、`task_report` 与可写的 `memory_note`）。
//   - keep 永不被 deny（与 deny 名单重叠是配置错误，直接抛）；
//   - 挂载后随 `tools/change` 校验一次可见性：确认到就写一条 `preset.keep` 审计 + logger.info；
//     还没注册就先静默（全局工具可能比预设挂得晚），缺了不抛——可见性由平台真值决定，本模块只声明并留痕。
//   - **keep-only 合法**（deny 为空、只给 keep）：语义是「不遮任何工具，只做正向可见性声明」。
//     子会话预设就走这个形态——没有该遮的全局工具，又需要声明「出生即可用」。
//   - allow 模式不需要 keep（allow 名单本身就是保留声明），给了就是配置错误。
//
// 时序：预设是 profile 加载时 eager 挂载的，我们的 `task_*` 可能还没注册。这里在
// `tools/change` 上增量补 deny（只 deny 新出现的命中项），不硬抛、不一次性削成空表。
//
// 审计：平台 `ctx.logger.info` 在隔离 profile 里不一定落盘，所以同时写插件自己的
// `$DSH_HOME/state/orchestrator/logs/orchestrator-*.jsonl`（复用 src/log.js），真机可查。
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createLogger } from './src/log.js'

export const name = 'dsh-orchestrator-preset-tools'
export const inject = ['tools']

/** PTC 模式的保留传输工具，平台禁止出现在 restrict 里。 */
const RUN_CODE = 'run_code'

/** 插件日志目录与 index.js 保持一致。 */
const stateDir = () => join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'state', 'orchestrator')

/** 名单归一：只留非空字符串并按首次出现去重。 */
const nameList = value => {
  const out = []
  for (const item of Array.isArray(value) ? value : []) {
    if (typeof item !== 'string') continue
    const text = item.trim()
    if (text === '' || out.includes(text)) continue
    out.push(text)
  }
  return out
}

/**
 * 收窄当前 scope 的全局工具。
 * @param ctx - 预设 scope 的上下文（`ctx.tools` 已注入）
 * @param config - `{ allow: string[] }`（保留式）或 `{ deny: string[], keep?: string[] }`（遮挡式）
 */
export function apply(ctx, config = {}) {
  const allow = new Set(nameList(config.allow))
  const deny = new Set(nameList(config.deny))
  const keep = new Set(nameList(config.keep))
  if (allow.size > 0 && deny.size > 0) {
    throw new Error('preset-tools: allow（保留式）与 deny（遮挡式）只能二选一，不要同时给')
  }
  if (allow.size === 0 && deny.size === 0 && keep.size === 0) {
    throw new Error('preset-tools: 必须给 allow（保留式）或 deny / keep（遮挡式）名单（空名单会让工具表要么全空要么全开）')
  }
  // keep-only 也算遮挡式：不遮任何工具，只做「出生即可用」的正向声明（子会话预设就是这一形态）。
  const mode = allow.size > 0 ? 'allow' : 'deny'
  if (mode === 'allow' && keep.size > 0) {
    throw new Error('preset-tools: keep 只用于遮挡式（deny）；保留式（allow）的名单本身就是保留声明')
  }
  const conflict = [...keep].filter(item => deny.has(item))
  if (conflict.length > 0) {
    throw new Error(`preset-tools: deny 与 keep 冲突（同一个工具不能既遮掉又要求可见）：${conflict.join('、')}`)
  }
  const denied = new Set()
  const kept = new Set()
  const lifts = []
  let fileLog
  // stateDir 可注入（测试传临时目录，别改 process.env）；默认与 index.js 一致。
  const resolveLogDir = () => typeof config.stateDir === 'function' ? config.stateDir() : (config.stateDir ?? stateDir())
  const audit = (event, fresh) => {
    // 审计日志失败不能打断预设挂载。
    try {
      fileLog ??= createLogger({ stateDir: resolveLogDir() })
      fileLog.log(event, { detail: { tools: fresh } })
    } catch { /* 忽略 */ }
  }
  const sync = () => {
    const known = ctx.tools.view().restrictableNames
    // 保留式：deny 补集；遮挡式：只 deny 点名的（都只对「当前已注册的全局工具」生效）。
    const fresh = mode === 'allow'
      ? [...known].filter(item => !allow.has(item) && !denied.has(item) && item !== RUN_CODE)
      : [...known].filter(item => deny.has(item) && !denied.has(item))
    if (fresh.length > 0) {
      for (const item of fresh) denied.add(item)
      lifts.push(ctx.tools.restrict({ deny: fresh }))
      // 审计：记下实际被 deny 的工具；后续 tools/change 补的批次也逐条记录。
      ctx.logger?.info?.(`preset-tools: deny ${fresh.join(', ')}`)
      audit('preset.deny', fresh)
    }
    if (mode !== 'deny' || keep.size === 0) return
    // keep 声明：只报「新确认可见」的，未注册的先等 tools/change（全局工具注册晚于预设是常态）。
    const confirmed = [...keep].filter(item => known.has(item) && !denied.has(item) && !kept.has(item))
    if (confirmed.length === 0) return
    for (const item of confirmed) kept.add(item)
    ctx.logger?.info?.(`preset-tools: keep ${confirmed.join(', ')}`)
    audit('preset.keep', confirmed)
  }
  const off = ctx.on('tools/change', sync)
  ctx.effect(() => () => {
    off()
    for (const lift of lifts.splice(0)) lift()
  })
  sync()
}
