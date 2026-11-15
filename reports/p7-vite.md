# T7.1 P7 第一单：vite 构建脚手架（空壳产物）

- 日期：2026-11-15
- 任务：`t-79d6fe1d`（P7 / T7.1，`master-plan-4docs.md:539`；设计文档 `2026-11-15-client-vite-build.md`「Task 1 构建脚手架」）
- 目标：把「手写经典脚本 `client.js`」的构建链换成「ESM 源码 + vite 构建」，**先不搬代码**——立 `dist/client.js` 的产物契约（classic script、无顶层 import/export、`__ModuleLoader__.load`、不含 react），并让 `npm test` 前置构建、`check:client` 校验产物。
- 结论：脚手架 + 空壳产物 + 契约测试落地；`npm test` **645/645 全绿**（基线 637 + 新增 8）；构建可复现；平台契约探针 **87/87 PASS**；改动已本地 commit、**未 push**。

---

## 0. 先看这一页

| # | 结论 | 证据 / 位置 |
|---|---|---|
| A | `vite` 已 pin 成 devDependency **`7.3.8`**（不用 `^`/`~`），构建链只有它一个新依赖；未生成 `package-lock.json`（仓库本来就没有，pin 精确版本已足够锁产物） | `package.json:74-76`；`npm ls vite` → `vite@7.3.8` |
| B | `npm run build` → `dist/client.js`（**341 B**）+ `dist/client.js.map`（**1.7 KB**），iife classic script，文件内只有一个 `window.__ModuleLoader__.load({ id, factory })` | `vite.client.config.mjs`、`dist/client.js` |
| C | 三条硬约束都有测试兜住：① 产物无顶层 `import/export`（vm 按 script 解析）② `node --check` 通过 ③ 产物含 `__ModuleLoader__.load` 且 `id === package.json.name` | `test/client-build.test.js` 8 条 |
| D | 约束「源码不许打包 react」用**源码扫描**兜住：`client/src/**` 不得出现 `from 'react'` / `require('react')` | 同上 |
| E | **本单没切 `exports["./client"]`**：它仍指手写的 `client.js`（面板继续可用），`dist/client.js` 只用来立契约。切换点 = T7.2 搬完第一块源码后（见 §4） | `package.json:10`（未改） |
| F | 构建**可复现**：连续两次 `npm run build` 的 `client.js`/`.map` SHA-256 完全相同；map 内 `sources` 是相对路径 `../client/src/index.js`（不含本机绝对路径） | §5.4 |
| G | 平台契约与 T0.1 差异表一致（单入口原样 serve、CSS 不 serve、iife/classic、包内分块「不做不是不能做」）；本机复跑 `contract-probe-t0.1.mjs` **87/87 PASS** | §2 |

---

## 1. 计划依据与本单范围

设计文档把 P7 拆成 4 个 Task，本单只做 **Task 1**（其余三单不在本轮）：

| Task | 内容 | 本单 |
|---|---|---|
| **Task 1** | 构建脚手架（vite pin、lib iife、`pretest`、`check:client`，产物入库） | ✅ 本轮 |
| Task 2 | 搬源码（入口 → styles.css → logic → api → components，五步） | ❌ 下一单 |
| Task 3 | 测试拆契约（读 `dist/client.js`）/ UI 不变量（读 `client/src/**`） | ❌ |
| Task 4 | CI/release/文档 + 发版 `0.14.0` | ❌ |

本单**没有**搬任何 UI 代码：根目录 `client.js`（2198 行）原样保留、仍是生效入口；`client/src/index.js` 是 31 行空壳。

## 2. 构建假设 vs T0.1 探针差异表（逐条确认）

> 依据：`reports/t0.1-probes.md` §3.8（`dsh-client-modules`）、§4.2（对 P7 的结论）。本轮又在本机复跑了一次探针（`node docs/probes/contract-probe-t0.1.mjs --no-write` → **87/87 PASS**）。

| 构建假设（设计文档） | T0.1 结论 | 本单怎么落 |
|---|---|---|
| 平台不打包，`clientExportOf()` 把 `exports["./client"]` 那个文件**原样 serve** 成 `/plugins/<id>/client.js` | 成立（`dsh-client-modules/src/index.ts:206`、`:908`） | 产物文件名固定 `client.js`（`entryFileNames`，**不带 hash**），`exports` 未来直接指向它 |
| 只 serve 一个 JS（+ `.map`），CSS 抽出去就丢 | 成立（assets 路由白名单只有 `.svg/.png/.webp/.jpg/.jpeg`，`.css` 404） | 空壳阶段无 CSS；T7.2 的 `styles.css` 必须 `?inline` 回 JS（配置里不做 CSS 拆分） |
| 产物必须是 classic script（顶层无 import/export） | 成立（README：产物是「注册 factory 的 classic 脚本」） | lib mode + `formats:['iife']` + `name`；测试用 `vm.Script` + 正则双保险 |
| 不许打包 react（只用 factory 内 `req('react')`） | 成立（平台 seed `require('react')`） | 源码扫描断言；空壳不引用 react（产物里也确认没有） |
| 「拆多个产物超出平台能力」 | **措辞要改**：平台已支持包内分块 `client.<name>.js`（`require.async`，自包含块） | 本期仍单入口（收益小、风险高）→ 配置里只有 `client/src/index.js` 一个 entry |
| 产物入库 | 不变（GitHub 安装路径要用仓库里的文件） | `dist/` 未进 `.gitignore`，两个产物文件按本单提交入库 |
| 平台按 `mtimeMs/ctimeMs/size` 算 rev | 补充事实（`README.md:85`） | 每次 build 都会改 mtime → 已打开页面仍取缓存；不影响文件内容与入库判断 |

**没被本单改动、但下一单要记住的**：CSS 只能 `?inline`；`require` → `req` 参数改名；`__test` 出口必须保留（T7.2/T7.3 的验收点）。

## 3. 改动清单

| 文件 | 类型 | 改了什么 |
|---|---|---|
| `vite.client.config.mjs` | 新增 | lib mode / `formats:['iife']` / `outDir:'dist'` / `emptyOutDir:true` / `sourcemap:true` / `minify:false` / `target:'es2022'` / `name:'DshOrchestratorClient'` / `entryFileNames:'client.js'`；文件头注释写清平台契约来源 |
| `client/src/index.js` | 新增 | 31 行入口空壳：`window.__ModuleLoader__.load({ id: 包名, factory: (req) => ({ inject:['slots','layout','uiWorkspace'], apply }) })`；注释标明 T7.2 五步搬运路线与三条约束 |
| `package.json` | 修改 | `devDependencies.vite = "7.3.8"`（精确版本）；`scripts.build` / `scripts.pretest` 新增；`scripts.check:client` 由 `node --check client.js` 改为 `node --check dist/client.js`。**`exports` / `files` 未动**（见 §4） |
| `test/client-build.test.js` | 新增 | 8 条构建契约测试（详见 §5.2） |
| `dist/client.js`、`dist/client.js.map` | 新增（入库） | 构建产物（`minify:false`，可读；map 带 `sourcesContent`，`sources` 为相对路径） |
| `docs/ARCHITECTURE.md` | 修改 | 「面板与详情（UI U2）」开头补「构建链与产物路径（P7）」一条，写明当前 T7.1 过渡状态与切换点 |
| `reports/p7-vite.md` | 新增 | 本报告 |

**没有**动的文件：根目录 `client.js`、`test/client.test.js`、`.github/workflows/**`、`README.md`、`src/**`、`index.js`。

## 4. client 构建生效路径（文档化）

### 4.1 平台怎么拿到客户端（不变的部分）

```text
package.json exports["./client"]
        │  clientExportOf() 读这个字段（platform 不打包）
        ▼
被指向的那个文件 ──原样 serve──▶ GET /plugins/@wjj865-code/dsh-orchestrator/client.js
                                  GET …/client.js.map（同名 map 路由）
        │
        └─ 浏览器 <script> 执行 → window.__ModuleLoader__.load({ id, factory })
                                     └─ id 必须等于包名，平台按包名索引
```

- `.css` 走 `/plugins/<id>/…` 的 assets 路由**一律 404** → 样式只能 `?inline` 进 JS 再由 `ensureStyles()` 注入 `<style>`。
- 产物里**不能**出现顶层 `import/export`：平台把它当 classic script 直接喂给 `<script>`。

### 4.2 本单之后仓库内的两条路径（过渡状态，明确写清）

| 路径 | 谁在用 | 内容 |
|---|---|---|
| `exports["./client"] = "./client.js"` | **当前生效**（`package.json:10`，本单未改） | 手写经典脚本 2198 行，面板功能完整 |
| `dist/client.js`（新） | **当前只是契约靶子**（`npm test` 的 `client-build.test.js` 读它） | vite 产物：空壳 factory，无 UI |

构建入口是 `client/src/index.js`。也就是说本单交付的是「**源码 → 产物**这条链已通、产物已符合平台契约」，但**平台还没被指到产物上**——这是刻意的最小步：先让产物能过契约测试，再搬真正的 UI。

### 4.3 生效路径切换（下一单 T7.2 的动作，写在这里防漏）

1. 把 `client.js` 的入口 + 常量 + `ensureStyles`（+ `STYLE_TEXT` → `client/src/styles.css` 的 `?inline`）搬进 `client/src/**`，`npm test`（含 `pretest` 构建）全绿；
2. 当产物能注册出与手写脚本等价的 `{ inject, apply, __test }` 后，改三处：
   - `package.json` `exports["./client"]` → `"./dist/client.js"`；
   - `package.json` `files` 加 `"dist/"`（本单的测试已埋好断言：一旦 `exports` 指 dist，`files` 必须含 `dist/`）；
   - `test/client.test.js` 的 `pkg.exports` 断言（Task 3 同步改；本单刻意不冻结过渡值，只断言「`exports` 指向的文件必须真实存在」）。
3. 切换后 `npm run check:client` 与 `pretest` 已经在校验 `dist/client.js`，不需要再改命令。

## 5. 验证记录（全部本地实跑）

### 5.1 基线

```text
$ npm test            # 改动前
# tests 637 / pass 637 / fail 0
```

### 5.2 新增契约测试（`test/client-build.test.js`，8 条）

| # | 断言 | 守住什么 |
|---|---|---|
| 1 | `vite` 是精确版本（`/^\d+\.\d+\.\d+$/`）；`build` / `pretest` / `check:client` 三条命令逐字匹配 | 构建链不被随手改成 `^` 或跳过构建 |
| 2 | `dist/client.js` + `.map` 存在、非空、产物末尾 `//# sourceMappingURL=client.js.map` | 产物成对入库 |
| 3 | 产物无顶层 `import/export`；`new vm.Script(artifact)` 不抛 | classic script（平台 `<script>` 能解析） |
| 4 | `node --check dist/client.js`（子进程）通过 | 语法门禁与 `check:client` 一致 |
| 5 | `__ModuleLoader__.load` 恰好一次、`id === pkg.name` | 模块 id 回归（0.3.0 踩过的坑） |
| 6 | factory 返回 `{ inject, apply }`，`inject` 含 `slots/layout/uiWorkspace`；`apply({})` 不抛 | 空壳形状 = 平台期望形状 |
| 7 | `client/src/**` 无 `from 'react'` / `require('react')`；入口无顶层 import/export | 双 React（R5）在构建期守住 |
| 8 | `exports["./client"]` 指向的文件必须存在；若指向 `dist/` 则 `files` 必须含 `"dist/"` | 生效路径不悬空（切换前后都成立） |

### 5.3 全量 + 构建 + 语法

```text
$ npm run build
vite v7.3.8 building client environment for production...
✓ 1 modules transformed.
dist/client.js     0.34 kB │ gzip: 0.26 kB │ map: 1.73 kB
✓ built in 47ms

$ npm test            # pretest 先构建，再跑 39 个测试文件
# tests 645 / pass 645 / fail 0 / duration_ms 10521

$ npm run check:client
> node --check dist/client.js        # 无输出 = 通过
```

### 5.4 产物可复现 + map 可移植

```text
连续两次 npm run build：
  dist/client.js       SHA-256 BBABF75A76D2DA2BD3B3E41A7D1EFCF5453FA7F65F2781C13838F5B60415E372  （一致）
  dist/client.js.map   SHA-256 B279A1F80524F1E9E7EC6D62EAB4ADD97AB94E3BB9AF075830AFEBFBD816515A  （一致）
map: {"file":"client.js","sources":["../client/src/index.js"],"sourcesContent":[…]}   # 相对路径，无本机绝对路径
```

> 这条很重要：T7.4 的 CI「产物与源码一致」（`git diff --exit-code dist/client.js`）依赖「同源码 → 同字节」；本单已先验证一遍。

### 5.5 平台契约复跑

```text
$ node docs/probes/contract-probe-t0.1.mjs --no-write
结果：87/87 PASS
```

构建假设所依赖的 `clientExportOf` / 单 JS 路由 / CSS 不 serve / classic script 事实全部仍成立（工作区里没有 `vite.config` 之类会改变平台读法的额外声明）。

## 6. 边界与下一步

| 项 | 状态 |
|---|---|
| 搬 UI 源码（`client/index.js` / `styles.css` / `logic.js` / `api.js` / `components/`） | ❌ 未做（T7.2） |
| `exports["./client"]` 切到 `dist/client.js` | ❌ 未做（T7.2 搬完第一块后切；见 §4.3） |
| `client.test.js` 拆契约/源码 | ❌ 未做（T7.3）；本单手写脚本的全部老断言仍读 `client.js`，所以继续全绿 |
| CI / release workflow / README 开发小节 / `build:watch` | ❌ 未做（T7.4） |
| 真机看面板卡片 | 本单不适用：平台加载的仍是手写 `client.js`；真机加载 `dist/client.js` 属 T7.2 之后 |
| 风险 R3（搬运改坏 UI） | 本单未搬，无风险；R4/R5 已用测试兜住第一道 |
| 风险 R4（产物 diff 噪音） | 已接受：`dist/client.js` 341 B（空壳）→ 搬完约 100 KB，每改 UI 多一份生成文件 diff；T7.4 的 CI 一致检查收口 |

## 7. 交付

```text
commit: feat(client): vite 构建脚手架 + dist/client.js 空壳产物（T7.1）
本地提交、未 push
```

产物：`dist/client.js`（341 B）、`dist/client.js.map`（1.7 KB）、`client/src/index.js`、`vite.client.config.mjs`、`test/client-build.test.js`（8 条用例）、本报告。
