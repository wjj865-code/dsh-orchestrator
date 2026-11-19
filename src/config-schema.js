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
// 4. **schemastery 解析不到时必须降级，不能让插件整体起不来。**
//    `@deepseek-ai/schemastery` 是宿主自带的包（harness 自己的 bundle 从 dsh 安装目录解析），
//    本插件把它声明成 **optional peer**。但「声明成 optional」不等于「运行时一定拿得到」：
//    装法不同（pnpm 提升位置、profile 隔离、宿主版本差异）都可能解析失败。
//    如果这里用静态 `import z from '@deepseek-ai/schemastery'`，解析失败 = 整个模块加载失败 =
//    插件连任务面板和全部工具一起消失——为了一个「配置页」赔掉主功能，不可接受。
//    所以用 `createRequire` + try/catch **同步降级**：拿不到就 `Config = undefined`，
//    Cordis 的 `resolveConfig()` 看到 `runtime.Config` 为空会**原样跳过校验**（已核实宿主实现），
//    插件照常工作，只是插件页上没有配置卡片。`loadConfig()` 的运行时归一化完全不受影响。
import { createRequire } from 'node:module'
import { CONFIG_FIELDS } from './config-fields.js'

/** 同步加载 schemastery；拿不到返回 undefined（降级，不抛）。 */
const loadSchemastery = () => {
  try {
    const require = createRequire(import.meta.url)
    const loaded = require('@deepseek-ai/schemastery')
    // ESM 互操作：`require` 拿到的是 module.exports，schema 工厂可能在 default 上。
    const z = loaded?.default ?? loaded
    return typeof z?.object === 'function' ? z : undefined
  } catch {
    return undefined
  }
}

/** schemastery 工厂；解析不到时为 undefined。 */
const z = loadSchemastery()

/** 是否拿到了 schemastery（false = 插件页上不会有配置卡片，但插件本身照常工作）。 */
export const configSchemaAvailable = z !== undefined

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
 * 会原样跳过校验，插件照常工作（只是插件页上没有配置卡片）。
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
