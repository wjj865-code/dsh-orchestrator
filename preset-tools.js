// 协调者预设内的工具收窄：预设层 deny 补集（allow 名单 = 显式保留的工具）。
//
// 平台契约（docs/probes/main-session-preset-restrict.md，实验可复现）：
// - 预设 scope 里 `tools.restrict({ allow })` 会把**同一 scope 注册的工具**（如
//   `ask_user_question`）一起遮掉：agent 视图沿 scope 链取交集，预设自己的工具也在链上。
// - 同一 scope 里 `restrict` 又不允许 allow 出现非全局工具名（抛 `unknown global tool`）。
// 所以「allow 名单」在预设层只能用补集表达：deny 掉所有**已注册的全局工具**中不在
// allow 名单里的项；预设自己挂的工具不受影响。
//
// 时序：预设是 profile 加载时 eager 挂载的，我们的 `task_*` 可能还没注册。这里在
// `tools/change` 上增量补 deny（只 deny 新出现的全局工具），不硬抛、不一次性削成空表。
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

/**
 * 收窄当前 scope 的全局工具：保留 allow 名单，deny 其余已知全局工具。
 * @param ctx - 预设 scope 的上下文（`ctx.tools` 已注入）
 * @param config - `{ allow: string[] }`，必须是显式、非空的工具名单
 */
export function apply(ctx, config = {}) {
  const allow = new Set(config.allow ?? [])
  if (allow.size === 0) throw new Error('preset-tools: config.allow 必须列出要保留的工具名（空名单会让协调者失去全部工具）')
  const denied = new Set()
  const lifts = []
  let fileLog
  // stateDir 可注入（测试传临时目录，别改 process.env）；默认与 index.js 一致。
  const resolveLogDir = () => typeof config.stateDir === 'function' ? config.stateDir() : (config.stateDir ?? stateDir())
  const audit = fresh => {
    // 审计日志失败不能打断预设挂载。
    try {
      fileLog ??= createLogger({ stateDir: resolveLogDir() })
      fileLog.log('preset.deny', { detail: { tools: fresh } })
    } catch { /* 忽略 */ }
  }
  const sync = () => {
    const known = ctx.tools.view().restrictableNames
    const fresh = [...known].filter(item => !allow.has(item) && !denied.has(item) && item !== RUN_CODE)
    if (fresh.length === 0) return
    for (const item of fresh) denied.add(item)
    lifts.push(ctx.tools.restrict({ deny: fresh }))
    // 审计：记下实际被 deny 的工具；后续 tools/change 补的批次也逐条记录。
    ctx.logger?.info?.(`preset-tools: deny ${fresh.join(', ')}`)
    audit(fresh)
  }
  const off = ctx.on('tools/change', sync)
  ctx.effect(() => () => {
    off()
    for (const lift of lifts.splice(0)) lift()
  })
  sync()
}
