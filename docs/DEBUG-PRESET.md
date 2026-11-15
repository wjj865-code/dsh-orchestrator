# 调试子会话：`workerPreset` 与 `orch-debug` 预设

> 目标：让某个子任务跑在「创造模式」的能力栈上（`cordis_*` 只读运行时洞察工具 + `dsh-doc` 技能 + `plugin_manager`），
> 用来调试、更新 DSH 插件。默认行为不变：不配 `workerPreset` 就是 `dsh-orchestrator-worker`。

## 1. 能力入口

| 入口 | 作用 |
|---|---|
| `config.workerPreset` | 派发子会话时落到启动 spec 的 `agentPreset`（`src/config.js:29`，`index.js:232`，`src/dispatch.js:334`） |
| `npm run preset:debug` | 把随包「创造模式」(`cordis`) 组合复制成可安装的 `orch-debug` bundle |
| `npm run preset:debug:check` | 只读检查：已生成的 bundle 是否仍与当前随包 `cordis` 组合逐行对齐（等价 `node scripts/orch-debug-preset.mjs --check`） |
| `docs/DEBUG-PRESET.md` | 本文：对齐差异、安装、插件更新流程、边界、回滚 |

## 2. 与随包「创造模式」(`cordis`) 的差异

生成器**整段照抄**源预设的 `plugins:` 列表（注释、`!!js` 表达式、块量缩进都保留），只做四处改写：

| # | 改写 | 源 `cordis` | 生成的 `orch-debug` | 为什么 |
|---|---|---|---|---|
| 1 | 声明行 id | `preset-cordis` | `preset-orch-debug` | 不能覆盖随包预设，两条声明要能共存 |
| 2 | `config.id` | `cordis` | `orch-debug` | `workerPreset` 按这个 id 选组合 |
| 3 | 显示名 / 描述 / 排序 | 无 | 「调试（创造者能力）」、`order: 300` | 插件页可区分，排在随包预设之后 |
| 4 | `skill-filesystem.customSkillDirs` | `createRequire(baseUrl)` 表达式 | bundle 内 `skills/` 的绝对路径（或省略） | 见 §4 的 `MODULE_NOT_FOUND` 说明 |

除此之外**逐项一致**（当前 rc.3 是 23 个插件行）：

| 能力面 | `cordis` 里有什么 | `orch-debug` 是否一致 |
|---|---|---|
| 工具 | 文件 / shell（bash+pwsh 按平台二选一）/ search / jobs / schedule / goal / todo / web / ask-user / skill / present / plan-mode / compaction / subagent / workflow | 一致（同一份行，顺序不变） |
| 运行时洞察 | `tool-cordis`（`cordis_inspect_list` / `cordis_inspect_query`） | 一致 |
| 插件管理 | `tool-plugin-manager` / `tool-plugin-market`，带 `disabled: !!js "!ctx.get('profileContext')"` | 一致（Desktop/Web profile 下启用，见 §7） |
| 技能 | `skill-filesystem` 挂 `dsh-doc`（`SKILL.md` + `references/` + `templates/`） | 一致；生成时把整个技能目录抄进 bundle |
| 系统提示 | `persona` 的 prefix：「You are a coding agent … customize DeepSeek Harness itself.」 | 一致（逐字保留） |
| 权限条件 | 平台判断、`!!js` disabled 表达式、group/isolate 结构 | 一致（逐字保留） |

**对齐检查**：`--check` 会重新读取当前安装的随包 `cordis`，与已生成 bundle 的 `plugins` 逐行比较（技能根落点抹平、`skills` 单独报告）：

```powershell
node scripts/orch-debug-preset.mjs --check
# 已对齐：…\debug-presets\orch-debug\cordis.patch.yml
#   插件行：23（工具 / 技能 / 权限条件 / 系统提示与随包 cordis 一致）
#   技能：已挂 dsh-doc（…\debug-presets\orch-debug\skills）
```

发现差异时退出码为 1，并打印 `缺少插件行 … / 多出插件行 … / disabled … → … / 第 N 行：源 …，生成物 …`。
这正是 DSH 升级后「旧 bundle 还跟不跟得上」的判定：差异 = 需要重新生成 + 重装 + 彻底重启。

## 3. 为什么不是 `$DSH_HOME/.agent-presets/orch-debug/`

DSH 0.2.2-rc.3 起，预设是 **bundle 补丁里的 `@deepseek-ai/dsh-agent-preset` 声明行**；随包文档写得直接：

> Before declaration rows, a user preset was a directory `$DSH_HOME/.agent-presets/<id>/` holding `preset.yml` … and `agent.cordis.yml` …
> **Nothing reads that directory any more.**

（`@deepseek-ai/dsh-agent-preset` 的 `skills/dsh-doc/references/agent-presets.md`“Migrate a legacy preset”，
`@deepseek-ai/dsh-agent-preset-registry` README：“The registry neither scans directories nor accepts preset paths.”）

所以本插件生成的不是那个早已失效的目录，而是等价的安装物：一个 bundle 目录

```text
<outDir>/
  package.json       # { "dsh": { "bundle": { "patch": "./cordis.patch.yml" } } }
  cordis.patch.yml   # insert 一行 preset-orch-debug 声明（plugins = cordis 组合原文）
  skills/dsh-doc/    # 从安装包里抄出来的 dsh-doc 技能（有 asar 源时才会生成）
```

默认落地在 `$DSH_HOME/state/orchestrator/debug-presets/orch-debug/`（插件唯一的写入根，见 README「数据与日志」）。

## 4. 生成

```powershell
npm run preset:debug
# 等价：node scripts/orch-debug-preset.mjs
```

| 参数 | 说明 |
|---|---|
| `--out <dir>` | 改输出目录（默认 `$DSH_HOME/state/orchestrator/debug-presets/orch-debug`） |
| `--source <path>` | 直接指定源的 `presets/cordis.patch.yml`（源码检出在 `packages/bundle/web-app/presets/cordis.patch.yml`） |
| `--skills-dir <path>` | 用现成的技能目录（不传时从 asar 抄 `dsh-doc`） |
| `--no-skills` | 不挂 `dsh-doc` 技能 |
| `--print` | 只把生成的补丁打到 stdout，不落盘 |
| `--check` | 只读检查已生成的 bundle 是否与当前随包 `cordis` 对齐；不写盘 |

源组合的查找顺序（找到第一个可用即停）：

1. `--source`
2. 环境变量 `DSH_ORCH_DEBUG_PRESET_SOURCE`
3. 环境变量 `DSH_ASAR`（Desktop 安装的 `resources/app.asar`）
4. Electron 的 `process.resourcesPath/app.asar`
5. Windows：`%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\app.asar`、`%PROGRAMFILES%\DeepSeek Harness\resources\app.asar`
6. macOS：`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`

Desktop 版把 web-app bundle 打在 `app.asar` 里，普通 `fs` 读不进去，脚本自带一个最小的 asar 读取器
（只读目录 + 取一段字节，不落盘、不执行归档里的代码）。

第 4 处改写的细节：源组合写的是
`createRequire(baseUrl).resolve('@deepseek-ai/dsh-agent-preset/package.json')`，这个表达式只在「补丁与
`@deepseek-ai/dsh-agent-preset` 同处一个 `node_modules`」时成立（随包发货的布局）。装进 profile 的 bundle
解析不到那个包（`MODULE_NOT_FOUND`），会让整条预设声明激活失败——插件自己的 `cordis.patch.yml` 早踩过这个坑。
所以生成时改成指向 bundle 里 `skills/` 的**绝对路径**；没有技能源（如源码检出且没给 `--skills-dir`）时整段删掉，
退回 `skill-filesystem` 的默认技能根（项目/用户技能照常可用）。生成结束会打印 `对齐：…` 与 `skillNames`，
`--check` 再复核一次技能根是否真的含 `dsh-doc/SKILL.md`。

## 5. 安装

### 5.1 推荐：`plugin_manager`（创造模式里也能装）

```text
plugin_manager({ action: 'install_bundle', target: '<上一步打印的绝对目录>' })
```

它会自己跑包安装与 bundle 选择；安装后 `list_bundles` 能看到 `@local/dsh-orch-debug-preset`，
`list_plugins` 能看到 `preset-orch-debug` 行及其激活状态。**不要**用 shell 手工复刻这两步。

### 5.2 手工：把声明行合并进 profile 补丁

没有 `plugin_manager` 时，把生成的 `cordis.patch.yml` 里 `- insert:` 整段追加到 profile 的补丁文件
（Desktop：`%DSH_HOME%\profiles\desktop\cordis.patch.yml`），保存后彻底重启 DSH。
插件页的预设列表里出现「调试（创造者能力）」即成功；出现诊断信息则是某行插件名/服务不匹配（见 §8）。

## 6. 启用：`workerPreset`

在插件自己的配置里指定（profile 补丁里 `id: orchestrator` 那行的 `config`）：

```yaml
- id: orchestrator
  name: '@wjj865-code/dsh-orchestrator'
  config:
    workerPreset: orch-debug
```

- 只影响**新派发**的子会话；已在跑/续派的会话保留创建时的组合（平台行为：组合在会话创建时定）。
- 只有 `spawnProvider: spawn` 生效；`fork` 不支持 `agentPreset`，平台会拒绝，插件也会跳过该字段。
- 值必须是合法 preset id（小写字母/数字/连字符）。写错会回落 `dsh-orchestrator-worker` 并在日志里 warn 一行。
- 想只让**个别**任务用调试能力：保持 `workerPreset` 默认，临时改配置重启，或在 `orch-debug` 外另建一个只带
  `tool-cordis` 的窄预设（见 §8）。

## 7. 插件更新流程（client HMR / host 更新 / 动态插件）

创造模式更新插件靠三件事：`plugin_manager`（profile 组合）+ `dsh-hmr`（Host 代码/配置）+ `client-hmr`（浏览器 bundle）。
`orch-debug` 复制了同样的工具行，所以调试子会话走同样的路径；差异只在**沙箱与审批**（见本节末尾）。

### 7.1 profile 组合与插件包：`plugin_manager`

| action | 用途 |
|---|---|
| `list_plugins` / `list_bundles` | 列当前 profile 的插件行与组合包；先用它们拿精确 `entryId` / 包名 |
| `set_plugin` / `set_bundle` | 启停某一行 / 某个组合包 |
| `install_bundle` | 安装组合包：`target` 可以是 npm spec、git/tarball URL，或本地绝对目录（`orch-debug` 生成物就走这个） |
| `remove_bundle` | 卸载组合包；**升级已安装的包 = 先 remove 再 install**（`install_bundle` 对已装包返回 `already-installed`） |
| `list_version_exemptions` / `set_version_exemption` | 读/写版本兼容豁免；授权前必须向用户说明崩溃与数据丢失风险并拿到明确同意 |

结果里的 `application` 决定下一步：

- `applied`：HMR 在场时在线生效，**不用重启**；
- `restart-required`：带 `restartReason`（`no-hmr` / `package-moved` / `host-module` / `unmanaged-plugin` / `module-comparison`）——
  保存成功但运行中的组合没换，需要彻底重启 DSH；
- `failed` / `cancelled`：看 `error.code` 与 `nextStep`；失败会回滚 `package.json` / `pnpm-lock.yaml`。

每次调用都需要 `danger-full-access` 权限，或当次审批。调试子会话的审批请求会回到同一 Web 页面；
`readOnly: true` 派生的任务只读沙箱，**不能**更新插件。子会话的 `target` 目录会被登记为可写根，
所以直接把插件源码目录当 `task_create.target` 最省事。

### 7.2 client 插件（浏览器 bundle）：`client-hmr` 热重载

`dsh-client-hmr` 在 web-app 组合里**无条件挂载**（`cordis.patch.yml` 的 `client-hmr` 行，注释写明 idle 直到构建产物变化）：

- Host 半侧每 `pollIntervalMs`（默认 500ms）stat 一次每个客户端插件的入口 bundle；mtime/ctime/size 变化即视为新 revision；
- 变化经 `/plugins/events` SSE 推给已打开页面，浏览器半侧逐个替换插件 bundle 并重置该插件的组件状态——**无需刷新页面**；
- 失败不会回滚旧 bundle，会在「设置 → 插件 → 插件列表」显示，可原地重试；无关插件继续运行；
- 前提是**真的重新构建出了 `lib/client.js`**：生产安装没有 watch 进程，手动 `pnpm build` / 插件自己的构建命令即可，HMR 只认产物变化。

所以调试子会话里改 client 插件代码的完整链路是：改源码 → 构建 → 页面自动换新（状态丢失是预期），不需要跑 `pnpm run dev:web`；
`dev:web` 只是把「构建 + watcher」也自动化了。

### 7.3 host 插件代码 / profile 配置：`dsh-hmr` + 重新组合

- `dsh-hmr` 在 `profileContext` 存在时由 base 组合包启用（Desktop / Web profile 都是），Headless/SDK/ACP 在 YAML 里禁用；
- 它监听 profile 目录与链接包目标；`plugin_manager` 的每次操作本身就是一次 profile 重新组合，会替换「磁盘上已变化的已加载模块」，
  因此**有 HMR 时**装/卸/升级插件、改 profile 补丁都能在线生效；
- 直接改链接包源码并重新构建后，需要一次重新组合才生效：再跑一次 `plugin_manager` 操作（如 `set_bundle` 重新选中同一 bundle）
  或保存 profile 配置即可，不必重启；
- 没有 HMR（Headless/SDK/ACP，或 profileContext 缺失）：同样的操作返回 `restart-required`，必须重启进程；
- HMR **不重启进程**：宿主依赖、进程入口、`package-moved` 一类变化只能彻底退出 DSH 再启动。

### 7.4 动态插件与 `cordis_*`：能看不能改

DSH 没有「运行期注册插件」的工具。插件是 Loader entry，随组合（profile / agent preset）装配；`cordis_*` 只有两个**只读**工具：

- `cordis_inspect_list`：列出 Host 与 Client 的 Inspect Provider 及其只读方法/schema；
- `cordis_inspect_query`：按 provider/method 查询 Service 方法、Event 模式、运行中 entry 的 Config schema、Tool schema、主题 token、Slot 树等。

它们**不能**创建 Loader entry、不能改配置、不能调用业务方法；Client 查询还需要页面在线响应。
所谓「动态」体现在 Loader 的 `!!js` disabled 条件、`cordis:group` isolate 和 HMR 对 entry 的替换上，而不是一个运行期写 API。
要改组合请走 §7.1 的 `plugin_manager`，要查契约请走 `cordis_*`，要改插件代码请走 §7.2 / §7.3。

**可用性证据与限制**：`cordis-inspect-providers`（`@deepseek-ai/dsh-tool-cordis/host`）在 web-app bundle 里无条件挂载、
进程级只注册一次；预设的 `tool-cordis` 行注入 `tools` + `cordisInspect`，而 agent preset 的 scope 由
`agent-preset-registry` 在宿主 Loader 树下创建，能看到宿主服务。若 provider 缺失，挂载审计会把该行判为
`pending (waiting for cordisInspect)` 并让整条预设声明 broken——所以只要插件页里 `preset-orch-debug` 已激活且无 broken，
调试子会话的工具表里就一定有 `cordis_inspect_list` / `cordis_inspect_query`（与创造模式主会话同一份行、同一份实现）。

### 7.5 预设自身的更新

`orch-debug` 的组合在**生成时**定格：DSH 升级 / 随包 `cordis` 变了以后，先 `--check` 看漂移，再重新生成并重装：

```powershell
node scripts/orch-debug-preset.mjs --check     # 有差异会打印逐行 diff，退出码 1
npm run preset:debug                           # 重新生成 bundle
# plugin_manager: remove_bundle → install_bundle（或直接重装生成目录）
# 彻底退出 DSH 再启动
```

预设声明在启动装配时读取，**运行中的会话不会换组合**；改完必须重启，且只影响之后新派发的子会话。

## 8. 宿主重启与能力边界

- 预设声明在插件加载（Loader 装配）时生效：**只关窗口不生效，要彻底退出 DSH 再启动**。
- 新预设/新 bundle 安装后同样要重启，之后新会话才会按新组合装配。
- 无 HMR 的 profile（Headless/SDK/ACP）、`package-moved`、宿主依赖变化：`plugin_manager` 返回 `restart-required`，只能重启。
- 重启后请用一次真实派发验证（§9）；已打开的旧子会话不会「升级」到新组合。

`orch-debug` = 创造模式的完整组合，能力与边界：

| 能力 | 说明 |
|---|---|
| `cordis_inspect_list` / `cordis_inspect_query` | 2 个只读工具：列 Inspect Provider、按 provider/method 查询。不能调用业务方法、不能改运行时；Client 侧查询需要页面在响应。可用性证据见 §7.4。 |
| `dsh-doc` 技能 | 生成时从安装包把 `@deepseek-ai/dsh-agent-preset/skills/dsh-doc` 抄进 bundle，`skill-filesystem` 的 `customSkillDirs` 指向那个绝对目录；`SKILL.md` + `references/` 覆盖插件开发、补丁方言、MCP、Web UI、预设、HMR 等。移动/删除生成目录只会丢技能，不影响其余能力（重新生成即可）。 |
| `plugin_manager` / `plugin_market` | 与创造模式同一行，带 `disabled: !!js "!ctx.get('profileContext')"`：Desktop/Web profile 的 `profileContext` 存在时**启用**（调试子会话也继承宿主服务），Headless/SDK/ACP 里关闭。每次调用需 `danger-full-access` 或当次批准；`readOnly` 任务不能用。 |
| 文件/shell/web/todo/present/skill | 与 worker 预设同级；调试任务可以读写仓库、跑测试。子会话的可写根 = `task_create.target`，别把 profile 目录漏配。 |
| planning（plan mode）、schedule | 创造模式自带的交互能力；调试时一般用不到，但会出现在工具表里。`tool-goal` 现在 worker 预设也有（只读 `get_goal`），不再是差异。 |
| delegation（`subagent` / `subagent_fork` / workflow） | 子会话可以再派自己的子会话；注意别和编排台账混用。 |

边界与坑：

- **不是沙箱**：预设可执行 Host 代码（registry README 明示「Presets are not security sandboxes」）。只给可信任务用。
- **只读洞察不等于只读文件**：`cordis_*` 只读运行时 API；文件写入能力仍在，`readOnly: true` 打开的沙箱才是硬约束。
- **插件更新受沙箱/审批约束**：`plugin_manager` 需要 `danger-full-access` 或当次审批；只读子任务改不了 profile。
- **任务工具不受预设影响**：`task_report` / `task_create` 等来自插件全局注册，换了预设仍有；调试子任务照样要 `task_report` 收尾，否则台账停在 `running`。
- **升级 DSH 后要重新生成**：组合随版本变化，包名/行 id 变更会让声明行激活失败（插件页显示 broken），旧组合不会自动跟随；先 `--check` 再 `npm run preset:debug` 重装。
- **源不可得时降级，不崩**：`no-source`（找不到安装/asar）、`no-preset-row`（版本换了预设格式）、`write-failed`（目录不可写）都返回可读原因；技能成分单独降级（`skipped:*`），`prepareDebugPreset` 从不抛异常。
- **不要手改生成物**：`package.json` / `cordis.patch.yml` 是生成器输出；升级 DSH 或换安装目录后重跑生成器，别直接编辑（`customSkillDirs` 里写着绝对路径）。
- **不影响默认路径**：不配 `workerPreset` 时派发行为与之前完全一致（同样的 `dsh-orchestrator-worker`）。

## 9. 验证清单

1. `npm run preset:debug` → 打印输出目录、两个文件、`技能：copied:N`、`对齐：与随包 cordis 逐行一致（N 个插件行）`；重复执行幂等。
2. `node scripts/orch-debug-preset.mjs --check` → 退出码 0，打印插件行数与 `dsh-doc` 状态。
3. `node scripts/orch-debug-preset.mjs --print | Select-String 'tool-cordis'` → 有 `tool-cordis` 行，且输出里没有 `createRequire(baseUrl)`。
4. `plugin_manager list_plugins`（或插件页）→ `preset-orch-debug` 已激活、无 broken 诊断。
5. 配 `workerPreset: orch-debug` → 彻底重启 → `task_create` 派一个调试任务。
6. 子任务工具表有 `cordis_inspect_list` / `cordis_inspect_query` / `plugin_manager`；技能列表有 `dsh-doc`。
7. 在子任务里 `plugin_manager list_bundles` → 能看到当前 profile 的组合包；`install_bundle` / `remove_bundle` 返回 `application: applied`（HMR）或 `restart-required`（无 HMR）。
8. client 插件：改源码并构建出 `lib/client.js` → 已打开页面在 ~1s 内自动换新（无需刷新）；失败出现在插件列表。
9. 子任务 `task_report done` 后，主会话收到通知、台账进 `done`（说明任务工具与预设互不影响）。

## 10. 回滚

- 停用：把 `workerPreset` 删掉或改回 `dsh-orchestrator-worker` → 重启。
- 卸载：`plugin_manager` 里移除 `@local/dsh-orch-debug-preset` bundle（或从 profile 补丁里删掉 `preset-orch-debug` 行）→ 重启。
- 生成物可随时删除：`$DSH_HOME/state/orchestrator/debug-presets/orch-debug/`（插件不依赖它，只在生成时写）。
