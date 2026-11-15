# dsh-orchestrator

> DeepSeek Harness 的任务编排插件：一个主会话负责拆任务，子会话并行执行；带跨项目记忆、依赖编排、收件箱、日报和任务面板。

- npm：`@wjj865-code/dsh-orchestrator`（最新 `0.7.0`）
- 仓库：<https://github.com/wjj865-code/dsh-orchestrator>
- License：MIT

## 这是什么

| 能力 | 说明 |
|---|---|
| 协调者 | 固定「主会话」，只拆任务、派子会话、看回报，不读写文件 |
| 子任务 | 独立 DSH 子会话，按目标目录运行；可只读、续派、停止、重派 |
| 依赖编排 | `dependsOn` 前置；完成自动晋升，失败沿依赖链传播 |
| 分组/写域/优先级 | `group` 分组、`writeScopes` 冲突提示、`priority` 队列排序 |
| 跨项目记忆 | 完成摘要自动沉淀；`history_search` / `project_context` 补上下文 |
| 收件箱/日报 | `task_inbox` 看待决与卡点；`digestAt` 开每日汇总 |
| 任务面板 | 侧栏入口 + 会话头面板；详情/停止/重派/追加；产物库按项目/日期分组、可预览/复制 |
| 产物收集 | done 自动从 `workspaceChanges` 收集改动文件，与显式 `artifacts` 按路径去重合并 |
| 结算闭环 | 子会话结束/中断自动收场：正常完成→已完成，被中断→已取消，异常→失败，只报过进展→会话丢失 |

协调者不阻塞等待：进度用 `task_list` / `task_inbox`，子任务完成会主动通知。

## 快速开始

### 从 npm 安装（推荐）

1. DSH → 插件 → **添加插件**，粘贴：

   ```text
   @wjj865-code/dsh-orchestrator@0.7.0
   ```

2. **彻底退出 DSH 再启动**（只关窗口不生效）。
3. 纯 dsh 表面左侧栏「插件」下方会出现「◈ 主会话」；Bot 模式用会话头「任务」按钮进面板。

以后升级：在 DSH 插件页用 registry 包的更新入口升级；维护者发版流程见下文。

### 从 GitHub 安装（备选）

```text
https://github.com/wjj865-code/dsh-orchestrator
```

装完同样要彻底重启。升级时先卸载旧版再装新版；旧包名 `dsh-orchestrator` 要先移除。

### 打开入口

- 侧栏「插件」下方「主会话」：直达协调者对话。
- 会话头「☰ 任务」：打开任务面板。
- 面板右上角「打开主会话」：创建/复用一个主会话。

## 怎么用

用自然语言对主会话说需求即可。协调者会调用 `task_create` 拆任务，例如：

```js
task_create({
  title: '修复空数据文案',
  goal: '空窗口时报表给出明确说明而不是空表',
  constraints: ['只改 src/report.js'],
  acceptance: ['空窗口输出「该窗口没有调用记录」', 'npm test 全绿'],
  user_verbatim: '你看这个空数据啥也没显示',
})
```

### 依赖与分组

```js
// 先建 A，再建依赖 A 的 B
task_create({ title: '改接口', goal: '...', acceptance: ['...'], group: '登录改造' })
task_create({
  title: '联调登录',
  goal: '...',
  acceptance: ['...'],
  dependsOn: ['t-xxxxxxxx'],
  group: '登录改造',
  writeScopes: ['src/auth'],
  priority: 5,
})
```

- 前置没完成：B 是 `waiting_dep`，不派发、不占并发位。
- 前置全部 `done`：B 自动变 `pending`，brief 带 `【前置任务】` 摘要和产物。
- 前置失败：B 自动 `failed`，错误写明原因。
- `writeScopes` 只提示冲突，不是文件锁；`priority` 高的先派。

### 收件箱与日报

- 面板「待你决定」/ `task_inbox`：等确认、要授权、失败、长时间没动静。
- `blocked` / `needs_auth` 可带 `question` + `options`，会显示在通知、详情和面板。
- 日报默认关闭；在 profile 配置：

  ```yaml
  - id: orchestrator
    name: '@wjj865-code/dsh-orchestrator'
    config:
      digestAt: '09:00'
      digestTimeZone: Asia/Shanghai
  ```

  打开主会话后自动挂 schedule；到点汇总完成/在跑/待决定/失败/产物。

### 只读任务

`task_create({ ..., readOnly: true })` 会让子会话进入 read-only 沙箱；只认显式 `true`。只读任务不注册 target 可写根。

### 调试子会话（`orch-debug`）

想让子任务跑在「创造模式」的能力栈上（`cordis_*` 只读运行时洞察工具 + `dsh-doc` 技能）调试 DSH 插件时：

```powershell
npm run preset:debug   # 把随包「创造模式」组合复制成可安装的 orch-debug 预设
```

再用 `plugin_manager` 安装生成的 bundle，在插件配置里写 `workerPreset: orch-debug`，**彻底退出 DSH 再启动**。
安装步骤、能力边界（预设不是沙箱、`cordis_*` 只读、升级后要重新生成）与验证清单见
[docs/DEBUG-PRESET.md](docs/DEBUG-PRESET.md)。

## 工具

协调者（10 个）：

| 工具 | 作用 |
|---|---|
| `task_create` | 建任务并派发；支持 `dependsOn` / `group` / `writeScopes` / `priority` / `readOnly` |
| `task_list` | 活跃任务/历史任务；`group` 过滤看组进度 |
| `task_status` | 单任务详情：依赖、写域、分组、优先级、问题、最近消息 |
| `task_message` | 续派消息；排队/等前置任务返回提示 |
| `task_stop` | 停止任务（运行中/排队/等前置） |
| `task_retry` | 重建 failed/orphaned，保留编排字段 |
| `task_inbox` | 收件箱：待决、失败/丢失、长时间没动静 |
| `history_search` | 查插件记忆、历史任务、平台历史会话 |
| `project_context` | 只读项目白名单文件、顶层结构、最近任务、相关记忆 |
| `memory_note` | 记一条跨任务有效的决策/偏好/约束 |

子任务（1 个）：

| 工具 | 作用 |
|---|---|
| `task_report` | `progress` / `done` / `blocked` / `needs_auth`；可带 `question` / `options` / `artifacts` |

11 个工具全局注册；`task_retry` / `task_inbox` / `history_search` / `project_context` / `memory_note` 仅主会话可调。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `coordinatorSession` | — | 显式覆盖主会话；不配则读 `settings.main_session_id` |
| `backend` | `subagent` | 派发后端；`team` 仅旧平台可用，rc.3 起会返回可读错误 |
| `spawnProvider` | `spawn` | 本地 fresh 子会话 provider |
| `workerPreset` | `dsh-orchestrator-worker` | 子会话预设；调试可切 `orch-debug`（见 [docs/DEBUG-PRESET.md](docs/DEBUG-PRESET.md)） |
| `staleMinutes` | `30` | 多久无动静标陈旧 / stall 提醒间隔 |
| `stallRounds` | `3` | 连续 progress 达阈值后提醒一次「可能卡住」 |
| `digestAt` | `''` | 每日日报 `HH:MM`；空 = 关闭 |
| `digestTimeZone` | `''` | 日报时区；空 = 系统时区 |
| `maxQueue` | `50` | `pending` + `waiting_dep` 安全阀 |
| `autoResumeQueue` | `true` | 重启后自动恢复排队任务 |
| `mergeWindowMs` | `5000` | 完成通知合并窗口 |
| `memoryInject` | `true` | 新任务 brief 注入历史经验 |
| `memoryLimit` | `3` | 注入记忆条数（1–10） |
| `snapshotRetentionDays` | `7` | 台账快照保留天数（1–30） |

## 数据与日志

唯一写入在 `$DSH_HOME/state/orchestrator/`（未设置时 `~/.dsh`）：

```text
tasks.sqlite
snapshots/tasks-YYYY-MM-DD.sqlite   # 每天一份，保留 7 天
logs/YYYY-MM-DD.jsonl               # 按天，保留 7 天
workspace/                          # 「指挥舱」工作区
debug-presets/orch-debug/           # 可选：npm run preset:debug 生成的调试预设 bundle
```

- 日志覆盖建任务/拒绝原因/派发成败/回报/通知/清理；`goal`/`summary` 只留 80 字，不写 `user_verbatim`。
- 快照损坏时只给路径提示，**不自动恢复**；手工用快照替换台账。

## 架构与安全

- 协调者预设只挂 `persona` / `agent-instructions` / `time-context` / `tool-ask-user` / `compaction` / `preset-tools`；执行层还有 guard 硬拦 `read`/`write`/`bash`/`wait_agent` 等。
- 子任务用 worker 预设，文件/shell/web/todo/skill/compaction/present，不含 delegation/goal/plan/schedule；预设可用 `workerPreset` 换成副本（如 `orch-debug`）。
- `/api/orchestrator` 由 connection owner-only 鉴权；`snapshot`/`detail`/`artifacts`/`preview` 只读，`stop`/`retry`/`message` 是面板动作。
- 通知走 `agent.steer`，5 秒合并；每次投递写 `notifications`。

更细的机制、目标目录推断、沙箱与错误降级见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 发版（维护者）

仓库带 GitHub Actions：

- `ci.yml`：push main / PR 跑测试。
- `release.yml`：推 `v*` tag 时跑测试并发布 npm（`NPM_TOKEN`，带 provenance）。

发布流程：

```powershell
npm version patch --no-git-tag-version
git add package.json
git commit -m "release: v0.7.0"
git tag -a v0.7.0 -m "v0.7.0"
git push origin main --follow-tags
```

要求仓库 Secrets 里有 `NPM_TOKEN`（npm Granular Token，Read and write，Bypass 2FA）。长期可换 npm Trusted Publishing（OIDC），不再存长期 token。

## 验收

1. 插件页能看到「任务编排」标题、图标和详情页。
2. 侧栏「主会话」能打开；工具表有 11 个工具。
3. `task_create` 能派发；子会话 `task_report done` 后主会话收到通知。
4. 建 `dependsOn` 任务时先 `waiting_dep`，前置完成后自动派发。
5. 面板「详情」「产物」「停止/重派/追加」可用。

## 排障

| 现象 | 处理 |
|---|---|
| 侧栏没有「主会话」 | 确认装的是 `0.7.0`；刷新页面；彻底重启 DSH |
| 工具表没有 `task_*` | 插件没激活或不是主会话；看插件页和日志 |
| 提示「尚未打开主会话」 | 面板点「打开主会话」 |
| 提示「team 后端不可用」 | `backend` 改回 `subagent` |
| 日志提示 `workerPreset` 回落 | 预设 id 只能用小写字母/数字/连字符；改值后彻底重启 |
| 子任务没有 `cordis_*` 工具 | 确认 `orch-debug` bundle 已装、`workerPreset: orch-debug`、已彻底重启；插件页看 `preset-orch-debug` 是否 broken（见 [docs/DEBUG-PRESET.md](docs/DEBUG-PRESET.md)） |
| 子任务写不进 target | 确认 `permissionPreset` / target；Windows 下 `pwsh` 写 target 仍受沙箱限制 |
| Bot 模式看不到入口 | 用会话头「任务」按钮；侧栏入口只在纯 dsh 表面 |
| 台账损坏 | 用 `snapshots/` 最新快照手工替换 |

## 已知限制

- `writeScopes` 只做冲突提示；依赖关系创建后不可编辑；`dependsOn` 不允许指向未来 id。
- 产物在 done 时自动从 `workspaceChanges` 收集改动文件，并与显式 `task_report.artifacts` 按路径去重合并；Host 未挂 `workspaceChanges` 时只剩显式产物。
- 日报默认关闭；`stallRounds` 只提醒一次，没有二次升级阶梯。
- 结算自动收场只认「一次 activation」：续派/冷恢复起的轮次靠平台 `subagent/end` 观察；子会话只在「没上报过 progress」时自动判完成，上报过 progress 的回合结束落「会话丢失」等人决定。
- 主会话工具表可能仍残留团队工具（agent-scope 自注册，`restrict` 遮不到）；执行层 guard 会硬拦。
- 平台 rc.3 子会话沙箱根、Bot 模式视图、headless 收尾竞态等平台侧限制，详见 [docs/LIMITATIONS.md](docs/LIMITATIONS.md)。

## 开发

```bash
npm test                # node:test
npm run check:client    # client.js 语法
node docs/probes/api-probe.mjs
```

本地 link 安装（开发用）：在 profile 的 `package.json` 加

```json
"@wjj865-code/dsh-orchestrator": "link:C:/Users/72489/Documents/dsh-orchestrator"
```

并把 `@wjj865-code/dsh-orchestrator` 加入 `dsh.profile.bundles`，重启 profile。

## License

MIT
