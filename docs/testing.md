# 测试与复核（维护者）

本文件是**测试/复核的唯一入口**：怎么跑、判据是什么、历史复核落在哪。用户文档看 [README](../README.md)，
内部设计看 [ARCHITECTURE.md](ARCHITECTURE.md)，平台/沙箱边界看 [LIMITATIONS.md](LIMITATIONS.md)。

> 原 `docs/qa-checklist.md`（阶段 1–5 的 36 节逐任务清单）已合并到这里：可复跑的部分进 §1–§5，
> 历史过程压成 §6 的「版本 → 复核要点 → 证据」索引，真机矩阵进 §7。逐条原文与勾选记录在 git 历史里。

## 1. 怎么跑

| 命令 | 作用 | 判据 |
| --- | --- | --- |
| `pnpm test` | `pretest` = `pnpm run build` + `check:client-size` + `check:docs`，然后 `node --test … "test/*.test.js"` | 0 fail；pass 数与用例数一致；无未说明的 skip；进程正常退出不挂起 |
| `pnpm run check:client` | `node --check dist/client.js`（构建产物语法） | exit 0 |
| `pnpm run check:client-size` | `dist/client.js` 字节数 ≤ **148 KiB**（`scripts/check-client-size.mjs`） | exit 0 |
| `pnpm run check:version` | `package.json` / README / CHANGELOG 三处版本口径 | exit 0 |
| `pnpm run check:docs` | 文档行数预算（**1,800**）+ README 首屏结构 + 配置表/工具表/文档链接 + 内链可达 | exit 0（详见 §3.4） |
| `npm pack --dry-run` | 包内容与 `package.json.files` | 含 `README`/`CHANGELOG`/`docs/testing.md`，不含被删文档与调试预设 |
| `node --test test/<file>.test.js` | 单文件复跑（先跑 `pnpm run build`，客户端用例读 `dist/client.js`） | 同上 |
| `node docs/probes/<probe>.mjs` | 宿主契约探针（升级 DSH 后按 `docs/probes/` 逐条重跑） | 探针自报 PASS/FAIL |
| `pnpm run mirror:check` | npm 镜像 latest 是否已是本版本 | 发版后核对 |

- **干净副本**：复核在 worktree / 干净 clone 上做，只认自己跑出来的输出，不采信开发自测数字；记录「命令 + 关键输出 + 未过项」。
- **先 `pnpm install`**：`node_modules/` 不入库，新检出目录直接 `pnpm test` 会 `vite: not found`。
- **沙箱**：`vite build` 要写 `dist/` 并 spawn 子进程，DSH 默认沙箱里可能被拒；用 `access:'full'` 的子任务跑构建，或交给 CI/终端。
- **不碰真实数据**：涉及台账/日志的用例一律走临时 `DSH_HOME`（`test/helpers.js`），真机冒烟也用临时 home。

## 2. 门禁（每个提交都要过）

| # | 门禁 | 怎么验 | 判据 |
| --- | --- | --- | --- |
| G1 | 全量测试绿 | 干净副本 `pnpm test` | 0 fail、无挂起（见 §1） |
| G2 | 提交干净 | `git show --stat <sha>`、`git status --porcelain` | 只含本次改动；无 `node_modules/`、`*.sqlite`、临时脚本、`.env`、任务产物 |
| G3 | **JSON 绝不进子会话** | 捕获派发收到的 prompt 文本，用含 `{}`、引号、换行、超长的 brief 渲染 | prompt 是渲染文字；无 `"title":`/`"acceptance":` 键名；整体不是可 `JSON.parse` 的对象 |
| G4 | **台账/日志只写 `$DSH_HOME/state/orchestrator`** | 临时 `DSH_HOME` 跑「建任务→回报→停止」，审计整个临时 home 与仓库 | 除 `state/orchestrator/` 外零新增；仓库内无 sqlite/wal/shm；真实 `~/.dsh` 不被写 |
| G5 | 工具 schema 契约 | 逐个工具体检 | `parameters.type === 'object'`、根上无 `minimum`/`maximum`；`output.schema` 与 `output.render` 都在；`render(args, value)` 返回 `[{type:'text', text:string}]` |
| G6 | 错误全转可读中文 | 每个失败路径：不存在 id、非法参数、底层抛错 | 中文可读；无 `SQLITE_`、`TypeError`、`at …` 堆栈、`undefined` 字面 |
| G7 | 依赖收窄 | 源码扫描 `ctx.` / `agentTeams.` | 派活只走 `startActivation`（+ 子会话 `task_report` 链路），不偷用未声明的服务 |
| G8 | 工具面 / 配置面 | `Object.keys(loadConfig({}))`、`createTools({}).length`、`cordis.patch.yml` 的 `preset-tools` deny/keep 与预设行 | 配置 22 键；全局工具 10 个（协调者可见 7 + 子会话 3）；协调者另有预设自有的只读 `read`/`glob`/`grep` 与 `skill`（不计入 10）；deny/keep 名单与工具表一致 |
| G9 | 文档面 | `pnpm run check:docs` | 见 §3.4（总行数 ≤1,800、README 首屏四要素、配置表/工具表同源、内链可达） |
| G10 | **面板体积闸门** | `pnpm run check:client-size`（`pretest` / `prepublishOnly` 已跑） | `dist/client.js` ≤ **148 KiB**；148 KiB 之下按子预算表（脚本头部，合计 = 148）逐块核算，某一页超了先删重复渲染/收敛样式，再谈抬预算。**为什么从 95 调到 148**：工作台 v1 要新增总览/任务组/组工作台/排期/自动化五页与常驻只读 dock，平台只 serve 一个 `client.js`（无代码分割），全功能实测 143–146 KiB；先定 128 KiB 实测不够（差 12–16 KiB），用户拍板保留全功能 → 148 KiB（留 2–5 KiB 余量）。中间不设 148 之外的档位，超了就回头砍重复渲染 |

## 3. 断言口径（测试怎么写）

### 3.1 基本约定

- `node:test` + `assert/strict`，一个模块一个 `test/*.test.js`；`--experimental-test-isolation=none`（共享进程省启动）。
- 新增/修改行为：**先补一条会红的用例**，再改实现；台账类用例用临时 `DSH_HOME` + 独立 db 文件。
- 纯函数优先：状态机、筛选、分组、prompt 渲染都提到组件/模块外层再断言，避免靠 UI 快照兜底。
- 未注入能力（`ctx.schedule`、`ctx.goals`、`sessionPersistence` 等）一律测「缺失不崩 + 明确降级文案」，不模拟成功。

### 3.2 文案与提示词的单一事实源

- `test/copy-consistency.test.js` 锁口径：`done` 不是终态、协调者默认不主动确认交付、`present` 1–4 个、
  brief 不越权定义交付语义、计划/完整访问的原子句只允许在 `src/copy.js` 定义一次。
- `test/prompt-layers.test.js` 锁分层：L1 policy / L2 brief / L3 task_detail / L4 onboarding / 通知 hint 各自独占，
  `layerViolations` 防「删掉的重叠又抄回来」；brief 行数为 **4 行基准，完整访问 / 隔离各加一行 → 4–6 行**。
  worker 预设 persona 是 L2 的第二个载体：`cordis.patch.yml` 必须**逐字包含** `WORKER_CONTEXT_HINT`（主动读 `context`），
  brief 不重复它（只留任务信息）。
- `test/preset-tools.test.js` 锁预设层收窄：保留式（`allow` 补集）与遮挡式（`deny` 点名 + `keep` 声明）二选一、
  互斥/冲突配置直接抛错、`preset.deny` / `preset.keep` 审计；真机语义（真实 `ToolsService`）由
  `docs/probes/preset-scope-restrict.mjs` 覆盖（10/10 PASS）。
- `test/status-facts.test.js` 锁能力位：`STATUS_CAPS` 是唯一状态能力表；`test/status-property.test.js` 用固定种子
  跑 10k 步随机迁移，断言无非法边、终态闭包、`delivered` 可追问不可轮换（<2s，确定性可复现）。
- `test/tool-migrations.test.js`：旧工具名 → 新调用的映射表是唯一真源，README「工具迁移映射」必须与它逐条一致。
- 交互三闸门（0.26.0）：判级表 / 堵塞项四类 / 评估三行只许在 L1——`test/interaction-policy.test.js` 锁结构与同源（`BLOCKER_RULE` / `CHANGE_REVIEW_FIELDS` 都在 `src/copy.js`），`layerViolations` 的 L2/L3 探针挡住子会话把分级与评估抄回去。
- grill-me 技能（0.26.0）：`test/skill-grill-me.test.js` 锁两件事——`skills/grill-me/SKILL.md` 的 frontmatter（name=kebab / description / whenToUse）与协议要点（前沿提问、每问带推荐、事实自己查、2 轮 8 问、三栏决策记录、T2/T3 衔接、grill≠批准），以及注册模块「读包内文件 → 预设作用域 `ctx.skills.register`」、frontmatter 坏格式给可读报错、文件缺失/注册失败只 warn 不阻断预设挂载；`test/config.test.js` 锁协调者预设挂 `skill-grill-me` + `tool-skill` 而 worker 不挂。

### 3.3 文档一致性（`test/copy-consistency.test.js` 静态部分）

- 任何「N 个工具」的说法都必须是 10（全局工具），修旧数会红。
- 维护者内容放 `docs/`，README 只留用户内容与链接；README 必须链到 CONTRIBUTING / ARCHITECTURE / LIMITATIONS / testing / CHANGELOG。

### 3.4 `scripts/check-docs.mjs` 校验什么

1. **行数预算**：`README.md` + `docs/*.md`（顶层，不含 `docs/superpowers/`、`docs/probes/`）总行数 ≤ **1800**；
   超了直接打印「多几行、最大的是哪几篇」，并列出各文件行数。P2-6 从 2,250 降到 1,800：预算不是目标，是天花板。
2. **README 首屏结构**：前 60 行必须有一句话定位、兼容基线（含 `rc.5`）、带版本号的安装命令、demo 入口；
   README 不许再出现已删除的 `keepAlive*` 配置键（迁移只在 CHANGELOG / LIMITATIONS 里讲）。
3. **README 配置表 == 代码**：表格里反引号键集合必须与 `loadConfig({})` 的键集合完全一致（缺一行/多一行都红）。
4. **README 工具表 == 代码**：`## 工具清单` 两张表的工具名集合必须与 `createTools()` 逐名一致。
5. **包内文档**：`package.json.files` 里的 `docs/*.md` 必须真实存在（防止发出去 404）。
6. **相对链接可达**：README 与 `docs/*.md` 里的 `.md` 相对链接（含锚点）必须指向存在的文件/标题。
7. **交接契约字段同源**：`docs/ARCHITECTURE.md` 的「契约字段」表必须与 `src/handoff.js` 的 `HANDOFF_FIELDS` 逐字一致，事件名逐个出现。

### 3.5 用例规模

- 66 个 `test/*.test.js`、约 1.9 万行、1,112 条 `test()`（1,107 pass / 5 skip，`pnpm test` 会打印总数）。
- 大文件：`client.test.js`（U2 客户端）、`index.test.js`（装配）、`tools.test.js`（工具面）、`main-session.test.js`（open-main / adopt / 代建协调者会话）。

## 4. 已知 flaky / 环境限制

- **headless 收尾竞态**：一次性进程在合并窗口内退出时，`agent.steer` 可能抛 `initiator scope is disposed`，
  `notifications` 记 `failed` 是正确审计；长驻 desktop 不受影响。
- **测试进程不挂起**：通知/看门狗/轮询都测「卸载后清 timer」；出现挂起先看泄漏的定时器而不是加 `--test-force-exit`。
- **Windows**：`pwsh`/`bash` 写 target 仍受平台沙箱限制（只对 harness 文件工具生效）；`target` 不要用符号链接。
- **首回合窗口**：只读 / 计划 / 完整访问在 `agent/created` 之后设置，极短窗口内仍是继承模式，用例按「最终生效」断言。
- **探针依赖宿主 asar 契约**：升级 DSH 后先重跑 `docs/probes/`，探针红优先怀疑平台契约漂移，不要直接改断言。
- **UI 渲染**：单测用 React 垫片只渲染一帧（结构 + 骨架）；有数据/抽屉/产物视图靠探针 `qa-stage2-slots.mjs`、
  `qa-taskchip-dom.mjs` 与真机矩阵（§7）兜底，不承诺像素级回归。

## 5. 新功能自检模板（复制过去逐条勾）

```text
[ ] 先写会红的用例（行为断言优先，不靠快照）
[ ] 台账/日志只写 $DSH_HOME/state/orchestrator（临时 DSH_HOME 跑一遍）
[ ] 能力缺失路径：不崩、可读降级文案、不假装成功
[ ] 文案：进 src/copy.js / prompt-layers 对应层，跑 copy-consistency + prompt-layers
[ ] 工具面变化 → cordis.patch.yml allow、README 工具表、tool-migrations 映射、check-docs
[ ] 配置面变化 → loadConfig 键数、README 配置表、check-docs
[ ] 文档：README（用户可见）/ ARCHITECTURE（机制）/ LIMITATIONS（边界）/ 本文件（复核）
[ ] CHANGELOG 顶部本次版本段写清「为什么改 / 改了什么 / 边界」
[ ] pnpm test + check:client + check:version + check:docs + npm pack --dry-run
[ ] 真机矩阵（§7）勾一遍，未验项写明原因与谁验
[ ] 文档总行数仍在预算内（check-docs 若超，先删重复而不是抬预算）
```

## 6. 历史复核索引

阶段 1–5 的逐任务清单、探针输出与勾选记录（原 `qa-checklist.md`）压缩成下表；原文在 git 历史里。

| 里程碑 | 复核要点 | 证据 |
| --- | --- | --- |
| 阶段 1 Task 1–10 | 配置回落、状态机 8×8 全矩阵、brief 无 JSON、台账 WAL/并发 seq、派活四方法、通知分级/合并/落库、工具 schema、DSH_HOME 审计 | `67a3669`…`ceb9516`（CHANGELOG `0.12.0` 之前） |
| 阶段 1 裁决 R1–R8 | 快照只报错不自动恢复、notifications 落库、stale 标记、白名单探测、orphaned 推迟、续派重试 3 次、并发 8、唤醒时序 | `2689186`；CHANGELOG `0.12.0` |
| B 方案投递 | 协调者 `agent.steer` 直插、忙时排队、合并窗口、卸载不丢行、两条通知链路不重复计 | `8956d89`、`642eba0`；CHANGELOG `0.12.0` |
| 协调者自动绑定 | 首次绑定 CAS 先到先得、只读工具不绑定、配置覆盖不写库、rebind 校验、失效提示 | `f6a1c7a`；CHANGELOG `0.12.0` |
| P0 阻塞等待 | `wait_agent` 属 agent scope 自注册、restrict 遮不到；改用 policy + 执行期 guard；收窄延到回合边界 | `ef99e1f`、`b98922c`；CHANGELOG `0.12.0` |
| 队列额度 | `maxActive` 废弃改 `maxQueue` 安全阀；等待态不占额度；并发不超发 | `f02bd10`、`60d8ef9`；CHANGELOG `0.12.0` |
| 幽灵任务 | spawn 失败落 `failed`（不留无 session 的 pending）、同 title+goal 幂等、启动清理 | `7413a2b` 等；CHANGELOG `0.12.0` |
| 协调者硬规则 | 「不得凭记忆推断」进 L1；三路隔离；与 team policy 的优先级声明 | `ef99e1f`；ARCHITECTURE「提示词分层」 |
| 结构化日志 | 按天一个 jsonl、保留 7 天、单文件 5MB 换新 | `test/log.test.js` |
| 阶段 2 客户端 | L1 槽位探针 / L2 路由探针 / 快照零写入、筛选与退避、错误分流 | `d59da8f`、`5bdca13`；CHANGELOG `0.13.0` |
| 阶段 2 主会话 | 创建/复用/失效重建、target 落库、`open-main` 200/500、in-flight 互斥、惰性服务 | `6d2f6b9`；`docs/probes/qa-main-session*.mjs` |
| 侧栏入口 | 入口从 `panellist` 改 `footer.action`（Bot 模式隐藏面板列表），再改「插件」下方启动器 | `e4bb07e`；CHANGELOG `0.13.0` |
| 只读子任务 | 只写目标 child session 的 `sandbox/mode`、不注册可写根、续派仍只读、文案/徽标 | `f515a4a`；CHANGELOG `0.14.0` |
| 两段式交付 | `delivered` 独立态、超时收成 `done`、确认/追问同源门控、`canClose` | CHANGELOG `0.14.0` |
| `access:'full'` | 只接受 `'full'`、与只读/计划互斥、不继承、可观测 | `scripts/verify-access-full.mjs`；CHANGELOG `0.14.0` |
| 协调者读产物 | 工作区包含性 + 已登记产物并集、符号链接/`../` 拒绝、行窗口截断、审计日志 | CHANGELOG `0.15.0` |
| 回复底部 chip | R1–R4 关联规则、6 个视觉态、点击定位、单实例 feed 与退避、历史轮次不渲染 | `docs/probes/qa-taskchip-dom.mjs`；CHANGELOG `0.16.0` |
| P8 计划模式 | 只读 + plan-mode 软引导、`plan_save` 唯一写入口、`exit_plan_mode` 拒绝、批准切可写 | CHANGELOG `0.17.0`；`test/plan-mode.test.js` |
| P9 worktree | 结构化声明、建树 7 类失败、多分支询问、清理三档、`.agents/` exclude | CHANGELOG `0.18.x`；`test/worktree*.test.js` |
| T1 brief 纯指引 | brief 只给编号+指引，详情走 `task_detail`；经验只留指针；越权拒绝 | CHANGELOG `0.19.0`；`test/task-detail.test.js` |
| 状态事实源 | `STATUS_CAPS` 单表、删三条死边、`failed` 非流程终态、worktree 转移校验 | CHANGELOG `0.19.2` |
| 自动绑定回归 | 协调者会话失效/未绑定文案、`open-main` 互斥、面板三态 | CHANGELOG `0.19.x` |
| P0 版本口径 | README/CHANGELOG/package.json 三处一致 + `CHANGELOG` 进 files | `scripts/check-version.mjs`；CHANGELOG `0.21.0` |
| P1-A 配置收缩 | 41→35 键、弃用警告去重、轮换只剩两因子、默认 `off` | CHANGELOG `0.21.0`；`test/config-deprecated.test.js` |
| P1-B 工具面 | 15→10、旧名迁移提示、文案面三处同步、输出逐字等价 | CHANGELOG `0.21.0`；`test/tool-migrations.test.js` |
| P1-C 文案单源 | 计划文案单一真源、12k 步状态迁移 + 10k 组文案属性测试 | CHANGELOG `0.21.0`；`test/status-property.test.js` |
| P1-D 文档合并 | 文档 3,128→1,985 行、README 配置表/工具表与代码同源、内链可达 | `scripts/check-docs.mjs`（预算 2,250）；CHANGELOG `0.21.0` |
| P1-E 调试预设外移 | 生成器/测试/文档移出主包、`files` 不含 `docs/DEBUG-PRESET.md`、`tools/debug-preset/` 四件套 | CHANGELOG `0.21.0`；`node tools/debug-preset/cli.mjs --check` |
| P2-2 续跑委托宿主 goal | 28 键（再删 7 键各一条弃用警告）、`goalRounds=0` create+disarm / `>0` create 带 maxGoalRounds 且保持 armed、`src/` 无 `turn-stopping` 订阅 | `test/config-deprecated.test.js`、`test/goal.test.js`、`test/index.test.js` |
| P2-2 通知合并窗口 | 配置键删除后仍按 5 秒合并；测试用 `DSH_ORCH_NOTIFY_MERGE_MS` 旁路（只调窗口，不改语义） | `test/notify.test.js`、`test/index.test.js` |
| 追问必达 / progress 送达 | `report_expected_at` 置位与清标记、`answeredFollowup` 跳过水位与窗口、同任务水位尾沿补投、投递失败不占水位、每条 progress 都有 `notifications` 行；水位测试用 `DSH_ORCH_PROGRESS_MS` 旁路（只调水位，不改语义） | `test/notify.test.js`、`test/tools.test.js`、`test/ledger.test.js`、`test/resume.test.js`、`test/integration.test.js`（端到端：追问 → 先报 progress → 主会话立刻收到） |
| 记忆优化 P0（0.25.1） | `history` 首行【检索范围】、`project` 多键（≤2）/`all`/未知名警告、质量门槛（多词 ≥2 命中或 score ≥2、停用词）、分层配额 2+1、日志层单独成块 ≤2 且排在事实层后、`task-log` 单项目 200 且事实层不淘汰、`done` 的 projectKey 取 `brief.target → repo_root → target_dir`、`docs/ARCHITECTURE.md` 默认 1200/`include` 4000 字、旧全局偏好迁移取更正版且不双写 | `test/memory.test.js`、`test/tools.test.js`、`test/preferences.test.js`；CHANGELOG `0.25.1` 同批 |
| P2-1 可执行验收 | `task_create.checks`（1–5 条、argv、超时/跳过）、交付前执行且失败阻断、`readOnly` 拒绝配检查、台账 `acceptance_json` ALTER 幂等 | `test/acceptance.test.js`、`test/tools.test.js`、`test/ledger.test.js` |
| P2-3 交接契约 v1 | 三条确认路径的 `acceptedBy`、事件各一次、幂等关闭、存量行 NULL、字段表与代码同源 | `test/handoff.test.js`、`test/host-route.test.js`、`scripts/check-docs.mjs` |
| P2-4 官方 Team 板 | 只读快照透传 `revision`、`enabled:false` 不读板、CAS 冲突只重读一次、超时自动完成不反写 | `test/team-board.test.js`、`test/index.test.js` |
| P2-5 面板 S9′ | esbuild minify + ≤95 KiB 闸门、官方板只读分区、交接区块、验收小标 | `test/client-build.test.js`、`test/client.test.js` |
| P2-6 文档收口 | 文档 ≤1,800 行（预算常量与失败提示同改）、README 首屏重写 + 结构断言、P2 变更入档 | `scripts/check-docs.mjs`、本文件 §3.4 |
| 外部依赖 | ds-bot Bot 模式不撤外部 root 会话皮肤、rc.3 子会话沙箱根=父目录、团队工具残留 | CHANGELOG `0.13.0`/`0.14.0`；[LIMITATIONS](LIMITATIONS.md) |
| 任务链规则（0.28.0） | L1 五条规则（判据与建链时机 / 不阻塞 / 失败传播 / delivered≠done / 同检出串行）逐字来自 `src/copy.js`；`task_create.dependsOn` 描述与 `waiting_dep` 回执同源；L2/L3 探针；机制用 `dependencyState`/`promoteDependents` 复核 | `test/task-chain-policy.test.js`、`test/prompt-layers.test.js`；CHANGELOG `0.28.0` |

## 7. 真机复核清单（装 profile + 彻底重启后逐条勾）

结果栏：`[ ]` 未验 / `[x]` 通过 / `[!]` 不通过（记现象）。宿主端口用实际 DSH Web 端口。

### 7.1 入口与面板

| # | 操作 | 期望 |
| --- | --- | --- |
| 1 | 侧栏「插件」下方点「主会话」 | 一帧占位后进入主会话对话（新建或复用），侧栏无残留高亮 |
| 2 | 已在主会话时再点一次 | 不重复创建、不报错 |
| 3 | 会话头「任务」按钮 | 打开任务面板：顶栏、4 张指标卡、筛选轨、列表（首帧骨架） |
| 4 | 点任务卡/详情 | 抽屉滑入、遮罩变暗；`Esc`/遮罩/关闭都收起 |
| 5 | 切 6 档筛选与搜索 | 分类正确、无匹配显示「没有匹配的任务。」 |
| 6 | 点产物「预览」 | 主栏切回会话、右侧栏打开该文件 Tab；缺侧栏时给可读原因 |
| 7 | 无 cookie / 跨站 Origin 调 `/api/orchestrator` | 401 / 403 |
| 8 | 停宿主后看面板 | 5s 内「台账暂不可用」，恢复后刷新或等 30s 自动恢复 |
| 9 | 官方 Team 开启时打开面板 | 出现「官方 Team（只读）」折叠分区；行内**没有**按钮；关掉 Team 或宿主没装 Agent Teams 时整区不渲染（不显示提示条） |

### 7.2 任务流

| # | 操作 | 期望 |
| --- | --- | --- |
| 1 | `task_create` 派一条普通任务 | 子会话在 target 目录跑，面板出现任务并变「待确认」 |
| 2 | 子会话 `task_report done` | 协调者收到通知；`task_message({action:'close'})` 收成「已完成」 |
| 3 | 交付后追问 | 复用同一个子会话，任务回「进行中」，完成后再次交付 |
| 4 | `task_message({action:'stop'})` | 任务「已取消」，子会话被中断 |
| 5 | 计划任务 `planFirst:true` | 只读沙箱；计划落 `reports/plans/<taskId>.md`；`blocked` 上报后批准切可写 |
| 6 | 只读任务 `readOnly:true` | 写文件/写 shell 被拒且可读；续派仍只读 |
| 7 | `worktree:true` | 真的建出 `orch/<taskId>` 与检出；通知/`task_status` 标「隔离」；`git status` 无 `.agents/` |
| 8 | 多分支仓库不给 `worktreeBase` | 任务不创建、返回候选，带基线重调后建树 |
| 9 | 同目录并发派两条 | 默认拒绝并给三条出路；`allowConcurrent:true` 放行并标风险 |
| 10 | 主会话上下文维护（0.25.0） | 在指挥舱新建会话选「协调者」→ 会话头点「设为协调者」后 `settings.main_session_id` 切到它、旧会话不改名不归档；压力 ≥ `contextPressureThreshold`（可先调低到 0.1 复现）时弹一次问题卡，选「继续当前会话」后同一 band 不再问 |
| 11 | 配了 `checks` 的任务报 done | 全过才「待确认」并显示「验收 N/N」；有失败项即拒绝交付、任务仍「进行中」、回执给退出码与输出尾部 |
| 12 | 关联官方板的任务被**人**确认交付 | 官方任务按 CAS 标 `complete`；超时自动完成时官方板**不变**，日志有 `team.board.skipped` |
| 13 | 主会话权限徽标（0.25.1） | 新建主会话后输入区徽标显示「Read Only / 仅可查看」（日志 `main.session.permission-pinned`）；`/permission danger-full-access` 切走后徽标如实变「Full access」，再点「打开主会话」被拉回 `read-only`（日志再记一条 `permission-pinned`，返回 `permissionRestored`）；同批普通任务子会话 `sandbox/mode` 停在 `workspace-write`（日志 `subagent.workspace-write`），照常写文件 |

### 7.3 取证

- 宿主日志有 `只读路由已注册 /api/orchestrator`；`state/orchestrator/logs/*.jsonl` 无异常新增。
- 面板打开期间 network 每 2s 一次 `snapshot`，关闭面板后无请求（失败退避 30s）。
- 调接口前后 `tasks.sqlite` 的 `tasks/messages/notifications/settings` 行数不变（只读端点）。
- 真机判定结论进 `logs/`（`main.rotation.decided`、`task.*`、`workspace.read.rejected` 等），复核对日志而不是靠界面猜。
