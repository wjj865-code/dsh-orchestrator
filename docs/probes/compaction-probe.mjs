#!/usr/bin/env node
// 压缩能力真机探针（0.25.0，只读）：确认「宿主压缩」这条链在本 profile 上真的存在。
//
// 用它回答四个问题（不触发任何压缩动作、不改配置）：
//   1. `agentPresets.serviceFor(agent,'compaction')` 能否拿到引擎实例；
//   2. 引擎有没有 `compactNow`（插件**不调用**，只看存在性）；
//   3. 能否读到宿主自己的 `thresholdRatio` / `auto`（读不到就记缺口，不猜）；
//   4. 当前主会话的 `tokenMeter.contextPressure` 与日志体积（与面板同一口径）。
//
// 用法（在 DSH 宿主进程里跑，或在插件加载后的诊断上下文里跑）：
//   node docs/probes/compaction-probe.mjs            # 只读环境自检（无宿主 ctx 时报告 unavailable）
//   import { probe } from 'docs/probes/compaction-probe.mjs'; await probe({ ctx, agent })
//
// 说明：本仓库的探针历史见 docs/probes/main-session-probe.mjs；这里只做只读检查，
// 不安装插件、不启动宿主、不写台账。
import { probeCompaction, readContextPressure, readLogSize, readCompactionStats } from '../../src/main-context.js'

const service = (ctx, name) => {
  try { return ctx?.get?.(name) } catch { return undefined }
}

/**
 * 跑一次只读探针。
 * @param {object} [options]
 * @param {object} [options.ctx] 宿主 cordis 上下文（插件 apply 拿到的那个）
 * @param {object} [options.agent] 当前协调者 live agent
 * @param {boolean} [options.verbose] 是否打印 JSON
 * @returns {Promise<object>} 探针结果（机器可读）
 */
export async function probe({ ctx, agent, verbose = true } = {}) {
  const agentPresets = service(ctx, 'agentPresets')
  const tokenMeter = service(ctx, 'tokenMeter')
  const persistence = service(ctx, 'sessionPersistence')
  const sessionQuery = service(ctx, 'sessionQuery')
  const session = agent?.session
  const sessionId = session?.id ?? session?.header?.id ?? null

  const compaction = probeCompaction({ agent, agentPresets, tokenMeter })
  const pressure = readContextPressure({ session, tokenMeter })
  const size = sessionId === null
    ? { logMiB: null, degraded: 'no-session' }
    : await readLogSize({ session, persistence })
  const stats = sessionId === null
    ? { manual: null, auto: null, degraded: 'no-session' }
    : await readCompactionStats({ sessionId, sessionQuery })

  const result = {
    ok: compaction.available && compaction.compactNow,
    version: '0.25.0',
    sessionId,
    compaction,
    pressure,
    logMiB: size.logMiB ?? null,
    compactions: stats,
    notes: [
      '插件不调用 compactNow：压缩由宿主 compaction-basic 自己触发（thresholdRatio 默认 0.8）。',
      'thresholdSource=host 表示读到了宿主实际配置；assumed-default 表示读不到、按 0.8 兜底显示。',
      '自动压缩是否真的跑过：看 compactions.auto（>0 说明宿主自动压过；0 且压力未到 0.8 属正常）。',
    ],
  }
  if (verbose) console.log(JSON.stringify(result, null, 2))
  return result
}

// 直接执行：没有宿主 ctx 时给出可读结论，而不是崩掉。
if (process.argv[1] && process.argv[1].endsWith('compaction-probe.mjs')) {
  probe({}).then(result => {
    if (!result.ok) {
      console.log('[compaction-probe] 没有宿主 ctx/agent：本脚本需要在 DSH 进程或插件诊断上下文里调用 probe({ ctx, agent }) 才能看到真实结果。')
    }
  }).catch(error => {
    console.error('[compaction-probe] failed:', error?.message ?? error)
    process.exitCode = 1
  })
}
