# 调试子会话：`workerPreset` 与 `orch-debug` 预设

> 目标：让某个子任务跑在「创造模式」的能力栈上（`cordis_*` 只读运行时洞察工具 + `dsh-doc` 技能），
> 用来调试 DSH 插件、查服务/工具/事件契约。默认行为不变：不配 `workerPreset` 就是 `dsh-orchestrator-worker`。

## 1. 能力入口

| 入口 | 作用 |
|---|---|
| `config.workerPreset` | 派发子会话时落到启动 spec 的 `agentPreset`（`src/config.js:29`，`index.js:232`，`src/dispatch.js:334`） |
| `npm run preset:debug` | 把随包「创造模式」(`cordis`) 组合复制成可安装的 `orch-debug` bundle |
| `docs/DEBUG-PRESET.md` | 本文：安装、启用、边界、回滚 |

## 2. 为什么不是 `$DSH_HOME/.agent-presets/orch-debug/`

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

## 3. 生成

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

源组合的查找顺序（找到第一个可用即停）：

1. `--source`
2. 环境变量 `DSH_ORCH_DEBUG_PRESET_SOURCE`
3. 环境变量 `DSH_ASAR`（Desktop 安装的 `resources/app.asar`）
4. Electron 的 `process.resourcesPath/app.asar`
5. Windows：`%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\app.asar`、`%PROGRAMFILES%\DeepSeek Harness\resources\app.asar`
6. macOS：`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`

Desktop 版把 web-app bundle 打在 `app.asar` 里，普通 `fs` 读不进去，脚本自带一个最小的 asar 读取器
（只读目录 + 取一段字节，不落盘、不执行归档里的代码）。

生成内容**逐行照抄**源预设的 `plugins:` 列表（注释、`!!js` 表达式、块量缩进都保留），只改四处：

1. 声明行 id：`preset-cordis` → `preset-orch-debug`；
2. `config.id`：`cordis` → `orch-debug`；
3. 显示名 / 描述 / 排序；
4. `skill-filesystem` 的 `customSkillDirs`：源组合写的是
   `createRequire(baseUrl).resolve('@deepseek-ai/dsh-agent-preset/package.json')`，这个表达式只在「补丁与
   `@deepseek-ai/dsh-agent-preset` 同处一个 `node_modules`」时成立（随包发货的布局）。装进 profile 的 bundle
   解析不到那个包（`MODULE_NOT_FOUND`），会让整条预设声明激活失败——插件自己的 `cordis.patch.yml` 早踩过这个坑。
   所以生成时改成指向 bundle 里 `skills/` 的**绝对路径**；没有技能源（如源码检出且没给 `--skills-dir`）时整段删掉，
   退回 `skill-filesystem` 的默认技能根（项目/用户技能照常可用）。

## 4. 安装

### 4.1 推荐：`plugin_manager`（创造模式里也能装）

```text
plugin_manager({ action: 'install_bundle', target: '<上一步打印的绝对目录>' })
```

它会自己跑包安装与 bundle 选择；安装后 `list_bundles` 能看到 `@local/dsh-orch-debug-preset`，
`list_plugins` 能看到 `preset-orch-debug` 行及其激活状态。**不要**用 shell 手工复刻这两步。

### 4.2 手工：把声明行合并进 profile 补丁

没有 `plugin_manager` 时，把生成的 `cordis.patch.yml` 里 `- insert:` 整段追加到 profile 的补丁文件
（Desktop：`%DSH_HOME%\profiles\desktop\cordis.patch.yml`），保存后彻底重启 DSH。
插件页的预设列表里出现「调试（创造者能力）」即成功；出现诊断信息则是某行插件名/服务不匹配（见 §7）。

## 5. 启用：`workerPreset`

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
  `tool-cordis` 的窄预设（见 §7）。

## 6. 宿主需要重启

- 预设声明在插件加载（Loader 装配）时生效：**只关窗口不生效，要彻底退出 DSH 再启动**。
- 新预设/新 bundle 安装后同样要重启，之后新会话才会按新组合装配。
- 重启后请用一次真实派发验证（§8）；已打开的旧子会话不会「升级」到新组合。

## 7. 能力边界

`orch-debug` = 创造模式的完整组合，包含：

| 能力 | 说明 |
|---|---|
| `cordis_inspect_list` / `cordis_inspect_query` | 当前安装（rc.3）的 `@deepseek-ai/dsh-tool-cordis` 只暴露 **2 个只读工具**：列 Inspect Provider、按 provider/method 查询。不能调用业务方法、不能改运行时；Client 侧查询需要页面在响应。 |
| `dsh-doc` 技能 | 生成时从安装包把 `@deepseek-ai/dsh-agent-preset/skills/dsh-doc` 抄进 bundle，`skill-filesystem` 的 `customSkillDirs` 指向那个绝对目录；`SKILL.md` + `references/` 覆盖插件开发、补丁方言、MCP、Web UI、预设等。移动/删除生成目录只会丢技能，不影响其余能力（重新生成即可）。 |
| 文件/shell/web/todo/present/skill | 与 worker 预设同级；调试任务可以读写仓库、跑测试。 |
| planning（plan mode）、goal、schedule | 创造模式自带的交互能力；调试时一般用不到，但会出现在工具表里。 |
| delegation（`subagent` / `subagent_fork` / workflow） | 子会话可以再派自己的子会话；注意别和编排台账混用。 |
| `plugin_manager` / `plugin_market` | 预设里带 `disabled: !!js "!ctx.get('profileContext')"`；预设作用域通常拿不到 `profileContext`，即默认关闭。要装配插件请用创造模式主会话，不要在子任务里改 profile。 |

边界与坑：

- **不是沙箱**：预设可执行 Host 代码（registry README 明示「Presets are not security sandboxes」）。只给可信任务用。
- **只读洞察不等于只读文件**：`cordis_*` 只读运行时 API；文件写入能力仍在，`readOnly: true` 打开的沙箱才是硬约束。
- **任务工具不受预设影响**：`task_report` / `task_create` 等来自插件全局注册，换了预设仍有；调试子任务照样要 `task_report` 收尾，否则台账停在 `running`。
- **升级 DSH 后要重新生成**：组合随版本变化，包名/行 id 变更会让声明行激活失败（插件页显示 broken），旧组合不会自动跟随；跑一次 `npm run preset:debug` 重装即可。
- **源不可得时降级，不崩**：`no-source`（找不到安装/asar）、`no-preset-row`（版本换了预设格式）、`write-failed`（目录不可写）都返回可读原因；技能成分单独降级（`skipped:*`），`prepareDebugPreset` 从不抛异常。
- **不要手改生成物**：`package.json` / `cordis.patch.yml` 是生成器输出；升级 DSH 或换安装目录后重跑生成器，别直接编辑（`customSkillDirs` 里写着绝对路径）。
- **不影响默认路径**：不配 `workerPreset` 时派发行为与之前完全一致（同样的 `dsh-orchestrator-worker`）。

## 8. 验证清单

1. `npm run preset:debug` → 打印输出目录、两个文件（有 asar 源时还会打印 `技能：copied:N`）；重复执行幂等。
2. `node scripts/orch-debug-preset.mjs --print | Select-String 'tool-cordis'` → 有 `tool-cordis` 行，且输出里没有 `createRequire(baseUrl)`。
3. `plugin_manager list_plugins`（或插件页）→ `preset-orch-debug` 已激活、无 broken 诊断。
4. 配 `workerPreset: orch-debug` → 彻底重启 → `task_create` 派一个调试任务。
5. 子任务工具表有 `cordis_inspect_list` / `cordis_inspect_query`；技能列表有 `dsh-doc`。
6. 子任务 `task_report done` 后，主会话收到通知、台账进 `done`（说明任务工具与预设互不影响）。

## 9. 回滚

- 停用：把 `workerPreset` 删掉或改回 `dsh-orchestrator-worker` → 重启。
- 卸载：`plugin_manager` 里移除 `@local/dsh-orch-debug-preset` bundle（或从 profile 补丁里删掉 `preset-orch-debug` 行）→ 重启。
- 生成物可随时删除：`$DSH_HOME/state/orchestrator/debug-presets/orch-debug/`（插件不依赖它，只在生成时写）。
