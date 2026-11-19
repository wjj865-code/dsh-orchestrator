// P0-2b：宿主能力访问层 = 9 类宿主耦合点的**唯一入口**（计划 §7.1 / §7.2）。
//
// 为什么需要这一层：宿主每个 rc 都可能在动服务形状、槽位名与安装布局，而插件历史上把这些
// 直接摊在 index.js / dispatch.js / client 里摸（`ctx.get('x')`、`process.env.DSH_HOME`、
// 硬编码槽位名）。一次升级就退化成「静默不生效」——历史上「真实宿主永不渲染」就是这么来的。
//
// 收敛规则（§7.2）：
//   1. 业务模块只吃这里返回的值，不再写裸 `ctx.get(`、不再直接读 `DSH_HOME`；
//   2. 一律惰性取值：cordis 并发加载，apply 早期服务还没就绪，取值失败返回 undefined 而不是抛；
//   3. 能力缺失要**可见**：`report()` 给出 9 行现状（供日志/面板诊断行），warn 每进程只一次；
//      绝不「模拟成功」。
//
// P0-2b 首片只接线 3 个点（版本探测 / settings / 日志路径），其余 6 类先提供访问器与探测行，
// 消费点分批迁移；剩余清单见 docs/compat.md。

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 声明的宿主兼容基线（含预发布）：README:7 与 docs/compat.md 同口径。 */
export const HOST_BASELINE = Object.freeze({
  min: '0.2.2-rc.3',
  upperExclusive: '0.3.0',
  range: '>=0.2.2-rc.3 <0.3.0',
})

/** 客户端注册过的宿主槽位（client/src/client.js:226/247/252/267）。缺槽位时面板入口隐藏。 */
export const PANEL_SLOTS = Object.freeze([
  'main',
  'sidebar.panellist',
  'conversation.header.leading',
  'conversation.chat.turnTail',
])

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** 解析 semver（含预发布），非法返回 undefined。只做比较用的最小解析，不追求完整语义。 */
export function parseVersion(value) {
  if (typeof value !== 'string') return undefined
  const match = SEMVER.exec(value.trim())
  if (match === null) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/** semver 优先级比较（0.2.2-rc.3 < 0.2.2-rc.5 < 0.2.2 < 0.3.0）；任一不可解析返回 undefined。 */
export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === undefined || b === undefined) return undefined
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0
    // 有预发布的一侧更小（0.2.2-rc.5 < 0.2.2）。
    return a.prerelease.length === 0 ? 1 : -1
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const x = a.prerelease[index]
    const y = b.prerelease[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xNumeric = /^\d+$/.test(x)
    const yNumeric = /^\d+$/.test(y)
    if (xNumeric && yNumeric) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1
      continue
    }
    // 数字标识符优先级低于字母数字标识符。
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** 版本相对基线的位置：inside（基线内）/ below / above / unknown（探测不到或不可解析）。 */
export function versionStatus(version, baseline = HOST_BASELINE) {
  if (parseVersion(version) === undefined) return 'unknown'
  if (compareVersions(version, baseline.min) < 0) return 'below'
  if (compareVersions(version, baseline.upperExclusive) >= 0) return 'above'
  return 'inside'
}

/** 插件唯一写入根的父目录：`$DSH_HOME/state/orchestrator`（`$DSH_HOME` 空白按未设置，同宿主 dsh-home-paths）。 */
export function stateDirFrom({ env = process.env, home = homedir() } = {}) {
  const configured = env?.DSH_HOME
  const root = typeof configured === 'string' && configured.trim() !== '' ? configured.trim() : join(home, '.dsh')
  return join(root, 'state', 'orchestrator')
}

/**
 * 从进程参数推宿主安装清单：宿主在 asar 内执行时 argv 形如
 * `…/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js`，
 * 于是 `<root>/app.asar/dsh/package.json` 就是宿主运行时清单（rc.5 起 `dsh.placeholder` 无版本字段时另说）。
 */
export function manifestFromArgv(argv = process.argv) {
  const entry = (Array.isArray(argv) ? argv : []).find(value => typeof value === 'string' && value.includes('.asar'))
  if (entry === undefined) return undefined
  const cut = entry.indexOf('.asar')
  const asarPath = entry.slice(0, cut + '.asar'.length)
  const inner = entry.slice(cut + '.asar'.length).split(/[\\/]/).filter(part => part !== '')[0] ?? 'dsh'
  return join(asarPath, inner, 'package.json')
}

/**
 * 探测宿主版本：显式环境变量优先，其次宿主安装清单；都拿不到就是 unknown（不 warn、不猜）。
 * 探测全程 try/catch：读不到、坏 JSON、异形清单都只降级为 unknown。
 */
export function readHostVersion({ env = process.env, argv = process.argv, readText = path => readFileSync(path, 'utf8') } = {}) {
  for (const key of ['DSH_HOST_VERSION', 'DSH_VERSION']) {
    const value = env?.[key]
    if (typeof value === 'string' && parseVersion(value) !== undefined) return { version: value.trim(), source: `env:${key}` }
  }
  const manifest = manifestFromArgv(argv)
  if (manifest === undefined) return { version: undefined, source: 'unknown' }
  try {
    const parsed = JSON.parse(readText(manifest))
    const value = typeof parsed?.version === 'string' ? parsed.version.trim() : ''
    if (parseVersion(value) !== undefined) return { version: value, source: 'install-manifest' }
  } catch { /* 读不到 / 坏 JSON：按探测不到降级，不抛 */ }
  return { version: undefined, source: 'unknown' }
}

// 9 类宿主耦合点：id 稳定（日志/面板/文档共用），label 给人看，probe 只查存在性、不执行业务。
const COUPLINGS = Object.freeze([
  { id: 'team-api', label: '团队 / 子代理 API（agents · subagents）', probe: host => host.agents() !== undefined && host.subagents() !== undefined },
  { id: 'session-create', label: '会话创建（sessionController · agentPresets）', probe: host => host.sessionController() !== undefined || host.agentPresets() !== undefined },
  { id: 'settings', label: '宿主 settings 表单缝', probe: host => host.settings() !== undefined },
  { id: 'registry', label: '工作区 registry', probe: host => host.workspaceRegistry() !== undefined },
  { id: 'token-meter', label: 'tokenMeter（当前无消费点）', probe: host => host.tokenMeter() !== undefined },
  { id: 'session-query', label: 'sessionQuery（历史检索）', probe: host => host.sessionQuery() !== undefined },
  { id: 'panel-slots', label: '面板 slot', probe: host => host.slots().length > 0 },
  { id: 'log-path', label: '日志 / 状态路径', probe: host => host.stateDir() !== '' },
  { id: 'version', label: '宿主版本探测', probe: host => host.version().status !== 'unknown' },
])

/**
 * 造一个宿主能力视图。所有取值惰性、失败降级为 undefined；不要跨进程/跨 apply 复用。
 * @param ctx - 插件根上下文（cordis）；缺 get / 服务未就绪都按「不可用」处理。
 * @param options.onWarn - warn 回调（每个 key 每进程一次）；env/argv/home/readText 供测试注入。
 */
export function createHostCapabilities(ctx, { onWarn = () => {}, env = process.env, argv = process.argv, home = homedir(), readText } = {}) {
  const warned = new Set()
  const cache = new Map()
  const once = (key, factory) => {
    if (!cache.has(key)) cache.set(key, factory())
    return cache.get(key)
  }
  const warnOnce = (key, message) => {
    if (warned.has(key)) return false
    warned.add(key)
    onWarn(message)
    return true
  }
  // 唯一的 ctx.get 门：宿主可能在加载中/卸载中抛错，一律当作「当前不可用」。
  const service = name => {
    try {
      return ctx?.get?.(name)
    } catch {
      return undefined
    }
  }
  const host = {
    service,
    warnOnce,
    agents: () => ctx?.agents ?? service('agents'),
    subagents: () => ctx?.subagents ?? service('subagents'),
    sessionController: () => service('sessionController'),
    sessions: () => service('sessions'),
    agentPresets: () => service('agentPresets'),
    settings: () => service('settings'),
    workspaceRegistry: () => service('workspaceRegistry'),
    tokenMeter: () => service('tokenMeter'),
    sessionQuery: () => service('sessionQuery'),
    connection: () => service('connection'),
    sandboxPolicy: () => service('sandboxPolicy'),
    planMode: () => service('planMode'),
    goals: () => ctx?.goals ?? service('goals'),
    schedule: () => service('schedule'),
    sessionPersistence: () => service('sessionPersistence'),
    workspaceChanges: () => service('workspaceChanges'),
    slots: () => [...PANEL_SLOTS],
    stateDir: () => once('stateDir', () => stateDirFrom({ env, home })),
    logDir: () => join(host.stateDir(), 'logs'),
    version: () => once('version', () => {
      const found = readHostVersion({ env, argv, ...(readText === undefined ? {} : { readText }) })
      return { version: found.version, source: found.source, status: versionStatus(found.version), baseline: HOST_BASELINE.range }
    }),
    // 每次现算：服务可能晚加载（与 index.js 的 schedule 能力检查同口径，不永久缓存 unavailable）。
    report: () => {
      const couplings = COUPLINGS.map(({ id, label, probe }) => {
        let available = false
        try {
          available = probe(host) === true
        } catch { /* 探测本身抛错 = 不可用 */ }
        return { id, label, available }
      })
      return {
        version: host.version(),
        couplings,
        available: couplings.filter(row => row.available).length,
        total: couplings.length,
        missing: couplings.filter(row => !row.available).map(row => row.id),
      }
    },
  }
  return host
}
