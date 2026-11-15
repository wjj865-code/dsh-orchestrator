/**
 * dsh-orchestrator 客户端入口（P7 / T7.1 空壳）。
 *
 * 这一版只立「构建契约」，不搬 UI：
 * - 源码是 ESM（vite 构建），产物是 classic script（平台 `<script>` 直接加载）；
 * - 模块 id 必须等于 package.json 的 name（平台 client-modules 按包名索引，不一致会半静默丢弃）；
 * - 顶层不许 import/export（产物被 `<script>` 解析）；
 * - 不许 import react：React 只能从 factory 的 `req` 参数拿（否则平台 + 产物各一份 React，
 *   hooks 全废）。factory 参数名用 `req` 而不是 `require`，绕开 rollup 的 commonjs 启发式。
 *
 * T7.2 会把根目录 `client.js` 的入口 / 常量 / ensureStyles → styles.css(?inline) → logic
 * → api → components 分五步搬进 `client/src/**`，每步 `npm test`（含构建）全绿；届时本文件
 * 变成纯入口，`apply` 负责注册 slots。空壳阶段只保证「模块能被加载、id/inject/apply 形状正确」。
 */
const CLIENT_ID = '@wjj865-code/dsh-orchestrator'

window.__ModuleLoader__.load({
  id: CLIENT_ID,
  factory: (req) => {
    const inject = ['slots', 'layout', 'uiWorkspace']

    const apply = (ctx) => {
      // T7.2 搬入面板后在这里 ctx.slots.inject/register；空壳阶段没有 UI 可注册。
      void ctx
      void req
    }

    return { inject, apply }
  },
})
