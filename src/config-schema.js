// 宿主侧 schemastery `Config`：把 src/config-fields.js 的字段规格投影成 Cordis 认识的 schema。
//
// 三条硬约束（都是踩过的坑，改动前先读）：
//
// 1. **每个字段都必须 `.default(...)`，且绝不 `required()`。**
//    Cordis 的 `resolveConfig()` 会拿 `Config['~standard'].validate(raw)` 校验配置，
//    校验失败会抛 `ValidationError`，插件**直接起不来**。而 src/config.js 的既有契约是
//    「非法值一律回落默认，不让坏配置把插件带崩」——两条语义冲突，解决方式是：
//    schema 只负责「**形状与合法域**」，非法值靠 `.loose()` 回落默认（不产生 issues），
//    运行时真正用的值仍由 `loadConfig()` 二次归一化。单测断言 `Config(垃圾值)` 不抛。
//
// 2. **只有标了 `.volatile()` 的字段会出现在插件页上。**
//    宿主 `SettingsForms.describe()` 用 `volatileForm(schema)` 过滤，非 volatile 字段
//    **静默消失**（不报错、不提示）。所以「页面上该有的字段」必须 volatile；
//    而 volatile 意味着宿主允许对它做即时写入。所有字段都标 volatile（包括只读的
//    `coordinatorSession`——它也必须显示在页面上）；只读性由浏览器表单保证（不给控件），
//    不是宿主强制的。单测双向比对字段表。
//
// 3. **volatile 字段到达 `apply(ctx, config)` 时不是普通值，而是带 `.get()` 的包装对象**
//    （cosmokit Volatile）。`loadConfig()` 里全是 `typeof === 'string'` / `Number.isFinite()`
//    这类判断，拿到包装对象会全部失效、静默回落默认——等于用户的配置被无声丢弃。
//    因此 `apply` 第一步必须 `unwrapVolatile()`。见本文件末尾。
//
// 4. **schemastery 解析不到时必须降级，且降级必须「有声音」。**
//    `@deepseek-ai/schemastery` 是宿主自带的包（harness 自己的 bundle 从 dsh 安装目录解析），
//    本插件把它声明成 **optional peer**。但「声明成 optional」不等于「运行时一定拿得到」：
//    装法不同（pnpm 隔离的虚拟 store、`link:` 安装、profile 隔离、宿主版本差异、asar 打包）
//    都可能让插件自己那条解析路径失败。
//
//    如果这里用静态 `import z from '@deepseek-ai/schemastery'`，解析失败 = 整个模块加载失败 =
//    插件连任务面板和全部工具一起消失——为了一个「配置页」赔掉主功能，不可接受。所以用
//    `createRequire` + try/catch **同步降级**：拿不到就 `Config = undefined`，Cordis 的
//    `resolveConfig()` 看到 `runtime.Config` 为空会**原样跳过校验**（已核实宿主实现），
//    插件照常工作，只是插件页上没有配置卡片。
//
//    但「静默降级」本身是更坏的 bug（2026-11-20 二诊就卡在这里）：`Config` 为空时
//    宿主 `settings.describe()` 直接不列 `orchestrator` 命名空间，客户端 `whileServed` 门控
//    不触发，页面上**连空壳都没有、控制台零报错**，排查只能靠猜。因此本文件做两件事：
//      a. **兜底解析**：插件自身路径失败后，再按「宿主安装目录」重试一遍（`DSH_*` 环境变量、
//         宿主进程 argv 里的 dsh 目录、Electron `resources/app.asar/dsh`）——这几种布局下
//         schemastery 就在宿主自己的 `node_modules` 里，不需要插件转手；
//      b. **显式告警**：全部失败时 `console.warn` 一次，写明「配置卡片将不显示」、试过哪些位置、
//         首个错误；成功/降级的结果记进 `configSchemaDiagnostics`，供日志与测试取证。
//    `loadConfig()` 的运行时归一化完全不受影响。
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { CONFIG_FIELDS } from './config-fields.js'

/** schemastery 包名（主路径与兜底路径共用这一处，避免两处写法漂移）。 */
const SCHEMA_PACKAGE = '@deepseek-ai/schemastery'

/** 降级的用户可见后果（告警文案只写这一句，避免各处说法不一致）。 */
const SCHEMA_MISSING_HINT = '配置卡片将不显示（插件照常工作，任务面板与工具不受影响）'

/** 兜底锚点里用的假文件名：createRequire 只需要一个路径，按它的 dirname 向上找 node_modules。 */
const ANCHOR_FILE = '__host-module-resolve__.cjs'

/** ESM 互操作取工厂：`require` 拿到的是 module.exports，工厂可能在 `default` 上。 */
const pickFactory = loaded => {
  const z = loaded?.default ?? loaded
  return typeof z?.object === 'function' ? z : undefined
}

/** 锚点 → createRequire 的入参：已经是脚本路径就原样用，目录则补一个假文件名。 */
const anchorFile = anchor => /\.(?:cjs|mjs|js)$/i.test(anchor) ? anchor : join(anchor, ANCHOR_FILE)

/** Electron 布局：`<exe 目录>/resources/{app.asar,app.asar.unpacked}/dsh`（asar 路径在 Electron 里可读）。 */
const electronRoots = exePath => {
  if (typeof exePath !== 'string' || exePath.trim() === '') return []
  const resources = join(dirname(exePath), 'resources')
  return [join(resources, 'app.asar', 'dsh'), join(resources, 'app.asar.unpacked', 'dsh'), resources]
}

/**
 * 兜底解析的候选锚点（按「最可能命中」排序，去重、只留真实存在的路径）。
 *
 * 为什么要这么多来源：宿主有两种形态——桌面宿主（Electron 主进程，插件与 schemastery 都在
 * `resources/app.asar/dsh/node_modules` 里）与 CLI 宿主（同样是 Electron-as-node，argv 里带
 * `app.asar/dsh` 或全局安装目录）。宿主给子进程设的 `DSH_*` 环境变量是最省事的线索，
 * 但**宿主进程自己不保证有**，所以还要从 argv / exe 路径反推，避免只赌一条路。
 * @param {object} [options] 依赖注入点（测试用）。
 * @param {Record<string, string | undefined>} [options.env] 环境变量。
 * @param {string[]} [options.argv] 宿主进程参数。
 * @param {string} [options.execPath] 宿主可执行文件。
 * @param {string} [options.resourcesPath] Electron 的 resources 目录。
 * @param {(path: string) => boolean} [options.exists] 存在性判断（asar 等在 Electron 外一律 false）。
 * @returns {string[]} 真实存在的锚点（目录或脚本路径）。
 */
export function schemaAnchors({
  env = process.env,
  argv = process.argv,
  execPath = process.execPath,
  resourcesPath = process.resourcesPath,
  exists = existsSync,
} = {}) {
  const candidates = []
  const push = value => {
    if (typeof value === 'string' && value.trim() !== '') candidates.push(value)
  }
  // 1) 宿主给会话进程的标准环境变量：profile 的 node_modules 里通常就有一份 schemastery。
  push(env.DSH_PROFILE_DIR)
  push(env.DSH_HOME)
  push(env.DSH_INSTALL_DIR)
  // 2) 宿主进程自己的参数：`…/app.asar/dsh`、profile 目录、host 的 entry 脚本都可能在里面。
  for (const arg of Array.isArray(argv) ? argv : []) {
    if (typeof arg === 'string' && /[\\/]/.test(arg)) push(arg)
  }
  // 3) Electron 打包目录：resourcesPath 只在 Electron 里有；exe 路径兜底同源。
  push(resourcesPath)
  for (const root of [...electronRoots(execPath), ...electronRoots(env.DSH_NODE_EXECUTABLE)]) push(root)

  const seen = new Set()
  const anchors = []
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue
    seen.add(candidate)
    // asar 内部路径在 Electron 里 existsSync 为 true；纯 node 下为 false → 直接跳过，
    // 免得告警里出现一堆注定不可能的位置。
    if (exists(candidate)) anchors.push(candidate)
  }
  return anchors
}

/** 错误信息压成一行、限长：告警要能读，不要夹一屏 node 的解析栈。 */
const reasonOf = error => String(error?.message ?? error ?? '').split('\n')[0].slice(0, 240)

/**
 * 同步加载 schemastery：先按插件自身解析规则找，失败再按宿主安装目录兜底；全失败则显式告警。
 *
 * 返回值：`{ z, source, anchor?, attempts }`
 * - `z`：schemastery 工厂；解析失败为 `undefined`。
 * - `source`：`'plugin'`（插件自身路径）｜`'host'`（宿主目录兜底）｜`'unavailable'`（全失败）。
 * - `anchor`：命中兜底时用的是哪个锚点。
 * - `attempts`：每次尝试的 `{ anchor, reason }`，供日志/告警取证。
 * @param {object} [options] 依赖注入点（测试用）。
 * @param {string[]} [options.anchors] 兜底锚点；默认按 {@link schemaAnchors} 推导。
 * @param {(spec: string) => (name: string) => unknown} [options.requireFor] 由锚点造 require 函数。
 * @param {string} [options.primary] 主路径锚点（默认本模块 URL）。
 * @param {string} [options.packageName] 包名（默认 {@link SCHEMA_PACKAGE}）。
 * @param {(message: string) => void} [options.warn] 告警出口（默认 `console.warn`）。
 */
export function loadSchemastery({
  anchors = schemaAnchors(),
  requireFor = spec => createRequire(spec),
  primary = import.meta.url,
  packageName = SCHEMA_PACKAGE,
  warn = message => console.warn(message),
} = {}) {
  const attempts = []
  const attempt = (label, spec) => {
    try {
      const z = pickFactory(requireFor(spec)(packageName))
      if (z === undefined) throw new Error('包已加载但取不到 schemastery 工厂（缺少 object() 工厂）')
      return z
    } catch (error) {
      attempts.push({ anchor: label, reason: reasonOf(error) })
      return undefined
    }
  }

  // 主路径：插件自己按 Node 解析规则找（正常 npm/pnpm 安装下都能命中）。
  const own = attempt('插件自身（createRequire(import.meta.url)）', primary)
  if (own !== undefined) return { z: own, source: 'plugin', attempts }

  // 兜底：宿主安装目录 / profile / asar —— schemastery 本来就住在那里。
  for (const anchor of anchors) {
    const hit = attempt(`宿主目录（${anchor}）`, anchorFile(anchor))
    if (hit !== undefined) return { z: hit, source: 'host', anchor, attempts }
  }

  // 全失败：显式告警，绝不静默（静默 = 用户只看到「配置卡片没了」，连原因都查不到）。
  const tried = attempts.map(item => item.anchor).join('、')
  warn(
    `[dsh-orchestrator] ${SCHEMA_MISSING_HINT}：${packageName} 解析失败（已尝试 ${attempts.length} 个位置：`
    + `${tried || '无可用锚点'}）。首个原因：${attempts[0]?.reason ?? '未知'}`,
  )
  return { z: undefined, source: 'unavailable', attempts }
}

/** 模块加载期只解析一次（ESM 模块缓存：进程内不会重试，所以失败必须当次说清楚）。 */
const loaded = loadSchemastery()

/** schemastery 工厂；解析不到时为 undefined。 */
const z = loaded.z

/** 是否拿到了 schemastery（false = 插件页上不会有配置卡片，但插件本身照常工作）。 */
export const configSchemaAvailable = z !== undefined

/**
 * 解析诊断（只读快照）：给日志与测试取证用（模块加载期已解析完，进程内不会重试）。
 * - `source`：`plugin`｜`host`｜`unavailable`；
 * - `anchor`：走兜底时命中的宿主目录；
 * - `attempts`：逐个位置的失败原因（`unavailable` 时就是告警里那份证据）。
 */
export const configSchemaDiagnostics = Object.freeze({
  available: z !== undefined,
  source: loaded.source,
  anchor: loaded.anchor,
  packageName: SCHEMA_PACKAGE,
  attempts: Object.freeze(loaded.attempts.map(item => Object.freeze({ ...item }))),
})

/**
 * 按字段规格造一个 schemastery 节点。
 * 统一 `.default()` + `.loose()`：默认值兜底，非法值回落而不是拒载。
 * @param {object} field 来自 CONFIG_FIELDS 的字段规格。
 * @returns {object} schemastery 节点（尚未标 volatile）。
 */
const nodeFor = field => {
  let node
  switch (field.kind) {
    case 'boolean':
      node = z.boolean()
      break
    case 'number': {
      node = z.number()
      if (typeof field.min === 'number') node = node.min(field.min)
      if (typeof field.max === 'number') node = node.max(field.max)
      if (field.integer === true) node = node.step(1)
      break
    }
    case 'enum':
      node = z.union([...field.values])
      break
    case 'string':
    default:
      node = z.string()
      break
  }
  return node.default(field.default).loose()
}

/**
 * 插件配置 schema（Cordis 从插件模块的 `Config` 导出读取）。
 *
 * 注意：这是**投影用** schema，不是运行时归一化。运行时值仍由 `loadConfig()` 决定。
 * 拿不到 schemastery 时为 `undefined`：Cordis 的 `resolveConfig()` 见 `runtime.Config` 为空
 * 会原样跳过校验，插件照常工作（只是插件页上没有配置卡片；此时模块加载期已 warn 过）。
 */
export const Config = z === undefined
  ? undefined
  : z.object(Object.fromEntries(CONFIG_FIELDS.map(field => [field.key, nodeFor(field).volatile()])))

/**
 * 判断一个值是不是 cosmokit 的 Volatile 包装。
 *
 * 为什么不用 `import { isVolatile } from '@deepseek-ai/cosmokit'`：cosmokit 是
 * schemastery 的传递依赖，可能被 npm/pnpm 放在 `schemastery/node_modules/` 下，
 * 从本包直接 import 会因提升位置不同而解析失败（本包并没有直接依赖它）。
 * 这里用**窄鸭子类型**：包装对象只有唯一自有键 `get`（实测 `Object.keys(wrapper) === ['get']`，
 * 且没有 `set`）。本插件的配置全是 number/boolean/string/enum 标量，不存在
 * 「合法配置值恰好是个带 get 的对象」的情况，所以这个判定是安全的。
 * @param {unknown} value 待判定的值。
 * @returns {boolean} true = 是 Volatile 包装。
 */
const isVolatileWrapper = value => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  if (typeof value.get !== 'function') return false
  return Object.keys(value).length === 1 && Object.keys(value)[0] === 'get'
}

/**
 * 把 `apply(ctx, config)` 收到的 config 摊平成普通标量对象。
 *
 * 不这么做的话，`loadConfig()` 的类型判断会全部失效（见文件头第 3 条）。
 * 非包装值原样返回；null/undefined 输入返回空对象（等价于「全用默认」）。
 * @param {unknown} raw Cordis 校验后传进来的配置。
 * @returns {Record<string, unknown>} 摊平后的配置。
 */
export function unwrapVolatile(raw) {
  if (typeof raw !== 'object' || raw === null) return {}
  const out = {}
  for (const [key, value] of Object.entries(raw)) {
    out[key] = isVolatileWrapper(value) ? value.get() : value
  }
  return out
}
