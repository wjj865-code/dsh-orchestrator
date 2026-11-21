# P0 门禁：能力包机制真机核查（pack-spike）

- 日期：2026-11-21｜任务：t-472f178a｜宿主：DSH **0.2.2-rc.5** Desktop（Windows 11）
- 探针：`docs/probes/capability-pack-probe.mjs`（隔离 `DSH_HOME`，不碰真实 `~/.dsh`；产物在系统临时目录，`--keep` 可保留）
- 复跑：`node docs/probes/capability-pack-probe.mjs [--skip-cli] [--json <path>]`

## 1. 结论

**GO**：运行时注册预设、包内技能目录、以该预设开新会话、撤销注册四项在真机全部可用；
文颜 CLI 2.0.12 在宿主同款 Node（Electron-as-node **v24.21.0**）上 `--version` 与 `render` 均可运行。
静态 `cordis.patch.yml` 兜底仍保留（P0 通过不等于所有 rc 都通过，见 §5）。

## 2. 运行时预设 / 技能 / 会话（隔离 home + 临时 profile）

做法：用 launcher 在隔离 `DSH_HOME` 里建 profile `probe`（`--from-default-profile web`），把探针插件直接放进
`profiles/probe/node_modules/dsh-pack-probe` 并在 profile 的 `cordis.patch.yml` insert 一行；启动
`DeepSeek Harness.exe --expose-internals <app.asar>/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js --profile probe --no-open --port 0`。
探针插件在 `apply()` 里注册预设 `pack-probe-preset`（persona + `skill-filesystem{customSkillDirs}` + `tool-skill`），
开一个会话，读技能快照，再 unregister。

| 检查 | 结果 | 证据 |
|---|---|---|
| `agentPresets.register()` 挂载 | **PASS** | 返回 `function`（disposer），无抛错 |
| `agentPresets.list()` 可见且无 broken | **PASS** | `ids = [standard, ptc, minimal, cordis, pack-probe-preset]`，`broken = null` |
| `sessionController.create({ cwd, agentPreset })` | **PASS** | `sessionId = session-…`，`agentPreset = pack-probe-preset` |
| 会话 agent 起来（`agents.get`） | **PASS** | 100ms×100 轮内 live |
| **customSkillDirs 技能可见** | **PASS** | 该会话快照含 `probe-skill`（与内置 office 等并列），`complete = true` |
| 会话实际预设 | **PASS** | `agentPresets.composedPreset(agent.ctx) === 'pack-probe-preset'` |
| `unregister()` 撤销 | **PASS** | 撤销后 `list()` 不再含该 id |

宿主事实（`host-facts`，非判定项）：

```json
{ "electron": true, "node": "24.21.0", "profileName": "probe" }
```

- `profileContext` 可读（launcher 提供），`name` 等于启动的 profile 名；**官方 Desktop 判定就是
  `ctx.get('profileContext')?.name === 'desktop'`**（宿主自身 patch 里多处这么写），本插件照此实现，
  `process.versions.electron` 作为补充信号。
- profile 名 `desktop` 由 Electron 应用独占，CLI 无法启动同名 profile（`dsh --profile desktop` 直接报错），
  所以「desktop 真机分支」只能在 Desktop 应用里验证；P0 只证明该判定的输入（`profileContext`）真实存在。

## 3. 文颜 CLI（`@wenyan-md/cli@2.0.12`）在宿主 Node 上的可用性

做法：临时目录 `pnpm add --ignore-scripts --registry=https://registry.npmjs.org @wenyan-md/cli@2.0.12`
（**仅为探测，不属于产品路径**；产品是懒装到 `tools/<id>`），再用宿主同款 Electron-as-node 执行。

| 检查 | 结果 | 证据 |
|---|---|---|
| `--version` | **PASS** | 输出 `2.0.12`（exit 0） |
| `render -f smoke.md` | **PASS** | stdout 输出公众号 HTML（含 `<section id="wenyan" style="…inline…">`），无网络/无凭据 |
| pnpm junction 直接执行 | **失败（须 realpath）** | `node node_modules/@wenyan-md/cli/dist/cli.js` → `ERR_MODULE_NOT_FOUND: commander`；`fs.realpathSync.native()` 解析到 `.pnpm/…` 后正常 |
| `APPDATA` 未重定向 | **失败（须重定向）** | `render` 也会初始化 token 存储并试图写 `%APPDATA%\wenyan-md`（受限沙箱下 EPERM）；重定向到包内 `.state/wenyan` 后正常，并在该目录创建 `wenyan-md/` |

## 4. 安装体量（用于安装确认卡的「预计新增体积/耗时」）

实测（Windows 11 / pnpm 11.22.0 / `--ignore-scripts`）：

| 指标 | 数值 |
|---|---|
| 安装包数 | 259 个（虚拟 store 去重后 243 个 id） |
| `node_modules/.pnpm` 解包体积 | **≈ 184 MiB**（12,554 文件） |
| pnpm content-addressable store | ≈ 178 MiB（首次安装额外占用，后续包共享） |
| 冷装耗时（空 store） | **≈ 4 分 04 秒** |
| 热装耗时（store 命中） | ≈ 14 秒 |
| CLI 包本身 | 55–58 KB / 17 文件 |
| `preinstall` / `install` / `postinstall` 钩子 | **0 / 0 / 0**（无安装脚本，`--ignore-scripts` 安全） |
| 浏览器/原生二进制（puppeteer/playwright/chromium/node-gyp/napi/sharp…） | **无** |
| 体积大头 | `mermaid` 71.7 MiB、`mathjax-full` 32.7 MiB、`@mermaid-js/parser` 11.7 MiB（均由 `@wenyan-md/core` 拉入，用于图表/公式渲染） |

## 5. 判定与遗留

- **U1（运行时注册预设）GO** → 计划 §3 的「运行时为主」可用；静态兜底继续实现（rc 契约无公开承诺）。
- **U2（customSkillDirs）GO**；**U3（create({agentPreset})）GO**；**U4（Desktop 判定输入）GO（输入可观测）**。
- 未验（如实记录，不阻塞）：
  1. 运行时注册的预设在**宿主 UI 预设选择器**里的刷新时机（P0 只证明 `list()` 同源，未驱动桌面 UI）；
  2. Desktop 应用的 `profileContext.name === 'desktop'` 真机分支（CLI 无法启动同名 profile）；
  3. 文颜 `publish` 建草稿（需要真实公众号凭据与 IP 白名单，按硬约束不做，联调用本地 stub/人工）。
- 探针输出示例（一次成功的运行）：`7/7 host PASS + cli:install-and-run PASS`，失败项为空。
