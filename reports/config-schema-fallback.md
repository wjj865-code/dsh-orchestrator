# config-schema 兜底解析 + 显式告警（0.23.1 补丁）

- 分支：`feat/config-schema-hardening`｜任务：`t-e471168a`｜日期：2026-11-20
- 改动：`src/config-schema.js`（兜底解析 + 显式告警 + 诊断快照）、`test/config-schema.test.js`（新增 7 条）
- 不动：`loadConfig()` 运行时归一化、`Config` 校验语义、插件其它行为、版本号（不 bump、不 push）

## 1. 根因

2026-11-20 二诊（`reports/config-ui-diag2.md`，工作区报告）的链：

1. 活宿主 `settings.describe()` 里没有 `orchestrator` 命名空间（24 项）；
2. 客户端 `client.js` 的 `forms.whileServed(['orchestrator'])` 因此永不触发 → `plugins.bundle.config` 槽位根本没注册；
3. 页面**连空壳都没有、控制台零报错**（`whileServed` 的设计就是「不服务即无痕」）。

宿主侧 `SettingsForms.describe()` 只在 `entry.fiber.runtime.Config` 非空时列命名空间；而插件 `active`、服务端也在写台账 —— 唯一能同时解释全部观测的路径是**该进程加载插件时 `@deepseek-ai/schemastery` 解析失败**：旧实现 `catch { return undefined }` → `Config = undefined` → 静默降级。ESM 模块缓存决定进程内不会重试，所以「重启后可能自己好」，下次再踩也查不到原因。

## 2. 修复：兜底解析 + 显式告警

`src/config-schema.js`：

1. **兜底解析**（主路径失败后）——`schemaAnchors()` 按「最可能命中」排序、去重、只留真实存在路径：
   - 宿主注入的 `DSH_PROFILE_DIR` / `DSH_HOME` / `DSH_INSTALL_DIR`（profile 的 `node_modules` 里通常有一份）；
   - 宿主进程 argv 里带斜杠的路径（CLI 宿主是 `…/app.asar/dsh/…`）；
   - Electron 布局 `<exe>/resources/{app.asar,app.asar.unpacked}/dsh`、`process.resourcesPath`、`DSH_NODE_EXECUTABLE` 同源推导；
   - 目录锚点补假文件名（`__host-module-resolve__.cjs`）再交给 `createRequire`；asar 路径在纯 node 下 `existsSync` 为 false，自然被跳过。
2. **显式告警**：全部失败时 `console.warn` **一次**，文案含：用户可见后果（配置卡片将不显示）、插件仍可用、缺的包名、试过的位置列表、首个错误原因。
3. **诊断快照** `configSchemaDiagnostics`：`{ available, source: 'plugin'|'host'|'unavailable', anchor, packageName, attempts[] }`，深冻结，供日志/测试取证。
4. 主路径命中时**不**碰兜底、**不**告警；走兜底成功也**不**告警（卡片还在，不该吓用户）。

## 3. 测试

新增 `test/config-schema.test.js`（7 条）：

| 用例 | 锁什么 |
| --- | --- |
| 主路径命中 | `source='plugin'`、不试兜底、零告警 |
| 主路径失败 + 宿主目录命中 | `source='host'`、记下锚点、目录补假文件名、保留失败证据、不告警 |
| 全失败 | `z=undefined`、`source='unavailable'`、**恰好一次** warn、文案含后果/包名/位置数/首个原因 |
| 坏包形状 / ESM 互操作 | 没有 `object()` 按失败处理；工厂在 `default` 上算命中 |
| `schemaAnchors` | 保序、去重、只留存在项、覆盖 `DSH_*`/argv/Electron 布局、argv 非数组不炸 |
| 本环境正常安装 | `Config` 非空、诊断与运行时一致、对象冻结、`validate()` 可用 |
| 真实模块加载（子进程） | 无 schemastery + 无锚点 → `Config=undefined` 且 warn 打到 stderr（非静默） |

全量：`pnpm test` = **1089 tests / 1084 pass / 0 fail / 5 skip**（skip 为既有项）。

## 4. 真机验证（测试 profile + 无头 Chrome）

环境：临时 `DSH_HOME`、profile `e2e`（`--from-default-profile web`），插件用 `pnpm pack` 产物安装（等价 npm 安装）：

- 安装副本 `…/node_modules/@wjj865-code/dsh-orchestrator` **没有本地 `node_modules`**，profile 的 `node_modules` 也没有 schemastery ⇒ 插件自身 `createRequire` 必然失败，**只剩兜底路径**；
- `POST /api/settings/describe` → **23 个命名空间，`hasOrchestrator: true`**（`describe-trace.json`）；
- 无头 Chrome 打开真实 GUI → 插件页「任务编排」：`[data-orchestrator-config]` 存在、**7 组 / 29 行**（`card-trace.json`、`e2e-card.png`）；
- 宿主日志无降级 warn —— 符合设计（兜底成功，不打扰用户）。

模拟「连兜底也失败」：把 `src/config-schema.js` + `src/config-fields.js` 复制到空目录、清空 `DSH_*`，用真实模块加载跑子进程：

```
[dsh-orchestrator] 配置卡片将不显示（插件照常工作，任务面板与工具不受影响）：@deepseek-ai/schemastery 解析失败
（已尝试 3 个位置：插件自身（createRequire(import.meta.url)）、宿主目录（…node.exe）、宿主目录（…probe.mjs)）。
首个原因：Cannot find module '@deepseek-ai/schemastery'
Config=undefined
```

见 `warn-evidence.txt`。说明：这是**宿主进程侧**的 `console.warn`，浏览器 DevTools 看不到（不在渲染进程），所以用真实模块加载的子进程取证，而不是浏览器 console。

## 5. 门禁

| 命令 | 结果 |
| --- | --- |
| `pnpm test` | 1084 pass / 0 fail / 5 skip（1089 条） |
| `pnpm run check:client` | exit 0 |
| `pnpm run check:client-size` | 91.9 KB / 预算 95.0 KB |
| `pnpm run check:version` | 0.23.1 三处一致 |
| `pnpm run check:docs` | 1495 / 1800 行，配置表 29 键、工具表 10 个 |
| `npm pack --dry-run` | 77 files / unpacked 1.5 MB |

## 6. 边界

- 兜底只在**模块加载期**跑一次（ESM 缓存）；失败告警也只打一次。
- 极端裁剪安装（宿主里根本没有 schemastery）时 `Config` 仍为 `undefined`：此时插件照常工作，但会有明确 warn，不再静默。
- 未改 `cordis.patch.yml`、README 配置表、版本号；未 push/tag。
