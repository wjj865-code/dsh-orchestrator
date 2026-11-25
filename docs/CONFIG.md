# 配置参考

插件全部配置键与默认值。日常其实只需要改几个（常用项与改法见 [README「配置」](../README.md#配置)）；**两种改法，等价**：① 在**插件页**（侧栏「插件」→ dsh-orchestrator 页面里的「配置」卡片）改；② 直接编辑当前 profile 的 `cordis.patch.yml`（`id: orchestrator` 那一行的 `config`）。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `coordinatorSession` | — | 显式覆盖主会话；不配则读 `settings.main_session_id`（**页面只读**：运维兜底通道，仅手改 profile YAML；填错会让协调者指向不存在的会话） |
| `spawnProvider` | `spawn` | 本地 fresh 子会话 provider（只支持 `spawn`） |
| `workerPreset` | `dsh-orchestrator-worker` | 子会话预设；调试可切 `orch-debug`（生成器与说明已移出主包，见 [tools/debug-preset/README.md](../tools/debug-preset/README.md)，不随 npm 包发货） |
| `staleMinutes` | `30` | 多久无动静标陈旧 / 卡住提醒间隔 |
| `deliveredTimeoutMinutes` | `60` | 「已交付待确认」多久没确认就自动 `done`（1–1440） |
| `idleWatchdog` | `true` | 空闲看门狗，只告警 |
| `watchdogIntervalMinutes` | `5` | 看门狗巡检间隔（1–1440） |
| `watchdogIdleMinutes` | `15` | 判空闲阈值（1–1440） |
| `digestAt` | `''` | 每日日报 `HH:MM`；空 = 关闭 |
| `digestTimeZone` | `''` | 日报时区；空 = 系统时区 |
| `maxQueue` | `50` | `pending` + `waiting_dep` 安全阀 |
| `autoResumeQueue` | `true` | 重启后自动恢复排队任务 |
| `memoryInject` | `true` | 新任务是否注入事实层记忆 |
| `memoryLimit` | `3` | 注入记忆条数（1–10） |
| `preferencesInject` | `true` | 是否把协调者偏好段（`settings.orchestrator_preferences`）注入 L1 提示词 |
| `preferencesMaxChars` | `2400` | 偏好段字数上限（条数上限固定 24 条，不可配） |
| `policyMaxChars` | `8000` | 协调者 policy 字符预算（2000–20000）：超出按「并行→任务链→worktree→写域→推进循环→三闸门」丢段，**硬规则段与拍板流程段永不丢**，每次丢段 warn 一次 |
| `promptProfile` | `full` | policy 档位：`full` 八段全渲染 / `minimal` 只留硬规则 + 拍板流程（省预算、不可逆闸门不丢） |
| `snapshotRetentionDays` | `7` | 台账快照保留天数（1–30） |
| `sameDirGuard` | `require` | 同写域并发防护：`require`（默认，拒绝）/ `warn`（只警告）/ `off`（关闭） |
| `worktreePolicy` | `auto` | `required` / `auto` / `off`；渲染进协调者 policy，只兜底「要不要隔离」，不包办分支名（名字由 `task_create.worktreeBranch` 传） |
| `worktreeRecentDays` | `7` | 「近期活跃分支」窗口（1–90） |
| `contextPressureThreshold` | `0.4` | **插件自己的提醒阈值**（0.1–0.95）：主会话最近一次请求 prompt 占上下文窗口的比例达到它时，弹一张问题卡问「要不要换新协调者会话」。**与宿主 compaction-basic 的 thresholdRatio（0.8）无关**，改它不会改变宿主压缩行为、也不影响子会话；插件只提醒、不压缩、不自动切换 |
| `capabilityPacks` | `true` | 能力包总开关：关掉后不注册内置包预设、`capability_pack` 返回停用、面板隐藏入口 |
| `capabilityPacksPanel` | `true` | 显示能力包面板（入口 + 包列表）；关掉不影响已注册的预设与会话 |
| `capabilityPacksAllowOnWeb` | `false` | Desktop-only 默认：Web 下不注册预设、工具返回 `PLATFORM_UNSUPPORTED`；打开后按 Desktop 处理（自担风险） |

字段规格的单一事实源是 [`src/config-fields.js`](../src/config-fields.js)，schema 投影在 [`src/config-schema.js`](../src/config-schema.js)，页面在 [`client/src/config-form.js`](../client/src/config-form.js)——三处都只投影 `loadConfig()` 真实存在的键。

## 保存与生效

| 要点 | 说明 |
|---|---|
| 保存位置 | **当前 profile** 的 `cordis.patch.yml`，不是插件目录 |
| 生效方式 | **重载插件或重启 DSH 后生效**：保存只把值写进当前 profile 的 `cordis.patch.yml`，运行中的插件不热重载（判定与计时器仍按启动时那份配置；台账在 SQLite 不受影响） |
| 优先级 | 表单写 profile 层；若 home patch 或命令行 overlay 覆盖同一字段，保存被**拒绝**并提示原因 |
| 非法值 | 一律**回落默认**，不会让插件起不来（schema 用 `.loose()` 兜底，运行时再由 `loadConfig` 二次归一化） |
| 可编辑范围 | 除 `coordinatorSession` 外全部可编辑（含 `contextPressureThreshold`）；**`coordinatorSession` 只读**（运维兜底通道，仅在运维场景手改 profile YAML） |

## 已删除的键

老 profile 里留着已删键不影响加载——启动时各给一条弃用警告、按默认值运行。历史沿革：P1-A 删了 `backend` 与 5 个 `rotate*`；P2-2 删了续跑四键（续跑改用 `task_create({ goalRounds })`）与三个固定成常量的阈值键；0.25.0 删掉轮换的 8 个键（`mainRotation` + 7 个 `rotate*`），只留 `contextPressureThreshold`；0.32.0 新增能力包三键；0.35 起删 `worktreeBranchPrefix`——分支名改由 `task_create.worktreeBranch` 按 `<type>/<slug>` 传入（必填，漏传直接报错），旧键只 warn、值不回填。逐键迁移说明见 [CHANGELOG](../CHANGELOG.md#02302026-11-19)。
