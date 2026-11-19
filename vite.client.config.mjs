import { defineConfig } from 'vite'

// 客户端构建：`client/src/**`（ESM 源码）→ `dist/client.js`（平台要求的 classic script）。
//
// 平台契约（0.2.2-rc.3，证据见 reports/t0.1-probes.md §3.8 / 设计文档「关键约束」）：
// - `clientExportOf()` 读 package.json 的 `exports["./client"]`，把那个文件**原样 serve** 成
//   `/plugins/<id>/client.js` → 平台不打包，那个文件自己必须是 classic script；
// - 只 serve 一个 JS（+ 同名 `.map`），CSS 路由白名单不含 `.css` → 样式只能 `?inline` 进 JS；
// - 平台按 `exports["./client"]` 的**文件内容**算 rev，所以产物文件名固定、不带 hash。
//
// 因此：lib mode + iife + `entryFileNames: 'client.js'`，`name` 必填（rollup iife 要求），
// 顶层不许出现 import/export。
//
// P2-5（S9′）：体积是交付预算（`dist/client.js` ≤ 95 KiB，闸门 scripts/check-client-size.mjs），
// 默认开 esbuild minify；sourcemap 保留，线上排查按 map 还原。
// 需要读可读产物时：`CLIENT_MINIFY=0 pnpm run build`（只影响本次构建，不入库）。
export default defineConfig({
  // S0（JSX 迁移）：源码继续用 `.js` 后缀，靠 esbuild 的 loader 覆盖把 `.js` 按 JSX 解析。
  // - vite 默认 esbuild 插件 include 只含 jsx/tsx，且 exclude 默认排除 `.js`，两个都要显式改；
  // - 经典运行时 + `jsxFactory: 'h'`：`h` 就是工厂注入的 `req('react').createElement`
  //   （见 client.js 的 createUi(h) / createViews({ h, ... })），不需要每文件 import、也不引入
  //   `react/jsx-runtime`（平台只认 factory 里那份 React，双 React 会废掉 hooks）；
  // - 不开 fragment：`<>` 会编译成未定义的 `Fragment`；要分组就直接用数组。
  esbuild: {
    include: /[\\/]client[\\/]src[\\/][^\\/]+\.js$/,
    exclude: [],
    loader: 'jsx',
    jsxFactory: 'h',
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    minify: process.env.CLIENT_MINIFY === '0' ? false : 'esbuild',
    // 平台是 Chromium（Electron / Web GUI），按 ES2022 输出即可；不降到更老语法，避免产物变形。
    target: 'es2022',
    lib: {
      entry: 'client/src/index.js',
      formats: ['iife'],
      name: 'DshOrchestratorClient',
      fileName: () => 'client.js',
    },
    rollupOptions: {
      // 平台按固定名字取文件；`dist/client.js` 与 `dist/client.js.map` 成对入库。
      output: { entryFileNames: 'client.js' },
    },
  },
})
