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
| `pnpm run check:client-size` | `dist/client.js` 字节数 ≤ **160 KiB**（`scripts/check-client-size.mjs`） | exit 0 |
| `pnpm run check:version` | `package.json` / README / CHANGELOG 三处版本口径 | exit 0 |
| `pnpm run check:docs` | 文档行数预算（**1,800**）+ README 首屏结构 + 参考表（`docs/CONFIG.md` / `docs/TOOLS.md`）与代码同源 + 文档链接与内链可达 | exit 0（详见 §3.4） |
| `npm pack --dry-run` | 包内容与 `package.json.files` | 含 `README`/`CHANGELOG`/`docs/testing.md`，不含被删文档与调试预设 |
| `node --test test/<file>.test.js` | 单文件复跑（先跑 `pnpm run build`，客户端用例读 `dist/client.js`） | 同上 |
| `node docs/probes/<probe>.mjs` | 宿主契约探针（升级 DSH 后按 `docs/probes/` 逐条重跑） | 探针自报 PASS/FAIL |
| `pnpm run mirror:check` | npm 镜像是否已有本版本（版本端点 `/:name/:version`，带 `?t=` + `no-cache` 绕缓存；`mirror:sync` 会先等上游版本可下载，空跑时按间隔重触发） | 发版后核对 |

- **干净副本**：复核在 worktree / 干净 clone 上做，只认自己跑出来的输出，不采信开发自测数字；记录「命令 + 关键输出 + 未过项」。
- **先 `pnpm install`**：`node_modules/` 不入库，新检出目录直接 `pnpm test` 会 `vite: not found`。
- **沙箱**：`vite build` 要写 `dist/` 并 spawn 子进程，DSH 默认沙箱里可能被拒；用 `access:'full'` 的子任务跑构建，或交给 CI/终端。
- **两个面**：**开发与安装 = Desktop**（桌面 GUI + 本地 `link:` 装插件，见 [CONTRIBUTING](CONTRIBUTING.md)）；**真机验收 = Web 测试 profile**（隔离 `DSH_HOME` + 临时 profile + 无头浏览器/HTTP 断言，见 §7.0）。能自动化的一律走 web profile，只有确实自动化不了的才请用户手工验（§7.4）。
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
| G8 | 工具面 / 配置面 | `Object.keys(loadConfig({}))`、`createTools({}).length`、`cordis.patch.yml` 的 `preset-tools` deny/keep 与预设行 | 配置 25 键；全局工具 12 个（协调者可见 8 + worker 专属 4）；协调者另有预设自有的只读 `read` 与 `skill`；**协调者预设不得出现 `tool-fs-search`**；deny/keep 名单与工具表一致 |
| G9 | 文档面 | `pnpm run check:docs` | 见 §3.4（总行数 ≤1,800、README 首屏四要素、参考表同源、内链可达） |
| G10 | **面板体积闸门** | `pnpm run check:client-size`（`pretest` / `prepublishOnly` 已跑） | `dist/client.js` ≤ **164 KiB**；164 KiB 之下按子预算表（脚本头部，合计 = 164）逐块核算，某一页超了先删重复渲染/收敛样式，再谈抬预算。**为什么从 95 调到 148**：工作台 v1 要新增总览/任务组/组工作台/排期/自动化五页与常驻只读 dock，平台只 serve 一个 `client.js`（无代码分割），全功能实测 143–146 KiB；先定 128 KiB 实测不够（差 12–16 KiB），用户拍板保留全功能 → 148 KiB。**0.32.0 能力包面板**（独立 main panel + 侧栏入口 + 安装确认卡 + EnvVarsCard）没有代码分割，只能加进同一个产物 → 用户拍板抬到 **160 KiB**。**0.33.0 自动化创建入口**（删自定义表单、加「创建自动化」按钮 + 主会话预填 + 会话头角色判定）是**净减**，不抬预算。**0.35.0 引用 chip**（正文 `tk-xxxxxx` 渲染成任务名 chip）无代码分割 → 用户拍板抬到 **164 KiB** |

## 3. 断言口径（测试怎么写）

### 3.1 基本约定

- `node:test` + `assert/strict`，一个模块一个 `test/*.test.js`；`--experimental-test-isolation=none`（共享进程省启动）。
- 新增/修改行为：**先补一条会红的用例**，再改实现；台账类用例用临时 `DSH_HOME` + 独立 db 文件。
- 纯函数优先：状态机、筛选、分组、prompt 渲染都提到组件/模块外层再断言，避免靠 UI 快照兜底。
- 未注入能力（`ctx.schedule`、`ctx.goals`、`sessionPersistence` 等）一律测「缺失不崩 + 明确降级文案」，不模拟成功。

### 3.2 文案与提示词的单一事实源

- `test/copy-consistency.test.js` 锁口径：`done` 不是终态、协调者默认不主动确认交付、`present` 1–4 个、
  brief 不越权定义交付语义、计划/完整访问的原子句只允许在 `src/copy.js` 定义一次。
- `test/prompt-layers.test.js` 锁分层：L1 policy / W1 任务执行者 policy / L2 brief / L3 task_detail / L4 onboarding / 通知 hint 各自独占，
  `layerViolations` 防「删掉的重叠又抄回来」（L2 探针会抓「W1 的静态句被抄回 brief」）；brief 行数为 **2 行基准（只给引用），
  有任务名 +1、`access:'full'` +1 → 2–4 行**，静态提示（上报 / 交付 / 装依赖 / 主动读 `context`）只在 W1 出现一次。
- `test/index.test.js` 锁 W1 注入：`orchestrator:worker-policy` 的 `order` 是 131（与 L1 的 130 分开注册）、
  只命中 `tasks.session_id` 属于任务的子会话（协调者、无关会话、孙会话都拿到空串）；隔离任务（台账
  `worktree_state=created`）多一句装依赖授权。worker 预设 persona 只剩身份一句，不再内联 `WORKER_CONTEXT_HINT`。
- `test/preset-tools.test.js` 锁预设层收窄：保留式（`allow` 补集）与遮挡式（`deny` 点名 + `keep` 声明）二选一、
  互斥/冲突配置直接抛错、`preset.deny` / `preset.keep` 审计；真机语义（真实 `ToolsService`）由
  `docs/probes/preset-scope-restrict.mjs` 覆盖（10/10 PASS）。
- `test/status-facts.test.js` 锁能力位：`STATUS_CAPS` 是唯一状态能力表；`test/status-property.test.js` 用固定种子
  跑 10k 步随机迁移，断言无非法边、终态闭包、`delivered` 可追问不可轮换（<2s，确定性可复现）。
- `test/tool-migrations.test.js`：旧工具名 → 新调用的映射表是唯一真源，README「工具迁移映射」必须与它逐条一致。
- **兼容声明（0.32.x）**：`test/engines-compat.test.js` 锁 `package.json:engines.dsh` 与 `HOST_BASELINE` 逐字一致、区间语义矩阵（rc.2–rc.5 放行；`0.2.1`、`0.2.2-rc.1`、`0.3.0-rc.1`、`0.3.0-rc.2`、`0.3.0` 拒绝——上界必须是 `<0.3.0-0`，写 `<0.3.0` 会被 `0.3.0-rc.1 < 0.3.0` 钻过去）、README / docs/compat.md 同口径，以及「不许再写区间外只 warn」。改区间 = 声明 + 常量 + 文档三处同改，少一处就红。
- 交互三闸门（0.26.0）：判级表 / 堵塞项四类 / 评估三行只许在 L1——`test/interaction-policy.test.js` 锁结构与同源（`BLOCKER_RULE` / `CHANGE_REVIEW_FIELDS` 都在 `src/copy.js`），`layerViolations` 的 L2/L3 探针挡住子会话把分级与评估抄回去。
- 拍板流程（版本 A，0.32.x 同版，**只改提示词/文案**）：`test/interaction-policy.test.js` 锁 L1 五条规则与批准四选一（旧「批准执行 / 先看计划文档 / 调整计划」组合必须消失、均按推荐必须用户点选）与「批准是显式动作」；`test/decision-flow.test.js` 锁决策汇总顺序（3 项样例）、blocked 通知「待拍板 N 项」措辞、`plan_save` **参数面未变**（仍只有 `task_id` / `content`，无结构化参数/文档 lint）、回执「子会话」保留会话 id；P0-4 的显式批准（`test/plan-mode.test.js`）锁「普通 message 不批准 / approve 前置 / 审计落库 / 四态收口」。
- grill-me 技能（0.26.0）：`test/skill-grill-me.test.js` 锁两件事——`skills/grill-me/SKILL.md` 的 frontmatter（name=kebab / description / whenToUse）与协议要点（前沿提问、每问带推荐、事实自己查、2 轮 8 问、三栏决策记录、T2/T3 衔接、grill≠批准），以及注册模块「读包内文件 → 预设作用域 `ctx.skills.register`」、frontmatter 坏格式给可读报错、文件缺失/注册失败只 warn 不阻断预设挂载；`test/config.test.js` 锁协调者预设挂 `skill-grill-me` + `tool-skill` 而 worker 不挂；0.35.0 P0 追加锁 `skill-filesystem`（本地技能发现：协调者一行、纯行无 `config`/`disabled`、排在 `tool-skill` 之前，整份补丁恰好协调者+worker 两行），并锁「技能发现不是工具面变更」（协调者仍不挂 `tool-bash`/`tool-pwsh`/`tool-fs-search`/`tool-web`/`tool-todo`）。

### 3.3 文档一致性（`test/copy-consistency.test.js` 静态部分）

- 任何「N 个工具」的说法都必须是 11（全局工具；0.32.0 加入 `capability_pack`），修旧数会红。
- 维护者内容放 `docs/`，README 只留用户内容与链接；README 必须链到 CONTRIBUTING / ARCHITECTURE / LIMITATIONS / CONFIG / TOOLS / testing / CHANGELOG。

### 3.4 `scripts/check-docs.mjs` 校验什么

1. **行数预算**：`README.md` + `docs/*.md`（顶层，不含 `docs/superpowers/`、`docs/probes/`）总行数 ≤ **1800**；
   超了直接打印「多几行、最大的是哪几篇」，并列出各文件行数。P2-6 从 2,250 降到 1,800：预算不是目标，是天花板。
2. **README 首屏结构**：前 60 行必须有一句话定位、兼容基线（含 `rc.5`）、带版本号的安装命令、demo 入口；
   README 不许再出现已删除的 `keepAlive*` 配置键（迁移只在 CHANGELOG / LIMITATIONS 里讲）。
3. **配置参考表 == 代码**：`docs/CONFIG.md` 的 `## 配置` 表里反引号键集合必须与 `loadConfig({})` 的键集合完全一致（缺一行/多一行都红）；README 的「常用项」表只能列真键，且必须链到 `docs/CONFIG.md`。
4. **工具参考表 == 代码**：`docs/TOOLS.md` 的 `## 工具清单` 两张表工具名集合必须与 `createTools()` 逐名一致；README 必须链到 `docs/TOOLS.md`。
5. **包内文档**：`package.json.files` 里的 `docs/*.md` 必须真实存在（防止发出去 404）。
6. **相对链接可达**：README 与 `docs/*.md` 里的 `.md` 相对链接（含锚点）必须指向存在的文件/标题。
7. **交接契约字段同源**：`docs/ARCHITECTURE.md` 的「契约字段」表必须与 `src/handoff.js` 的 `HANDOFF_FIELDS` 逐字一致，事件名逐个出现。

### 3.5 用例规模

- 89 个 `test/*.test.js`、约 2.3 万行、1,329 条 `test()`（静态扫描统计；`pnpm test` 会打印通过/跳过总数）。
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
[ ] 工具面变化 → cordis.patch.yml allow、docs/TOOLS.md 工具表、tool-migrations 映射、check-docs
[ ] 配置面变化 → loadConfig 键数、docs/CONFIG.md 配置表、README 常用项、check-docs
[ ] 文档：README（用户可见）/ ARCHITECTURE（机制）/ LIMITATIONS（边界）/ CONFIG·TOOLS（参考表）/ 本文件（复核）
[ ] CHANGELOG 顶部本次版本段写清「为什么改 / 改了什么 / 边界」
[ ] pnpm test + check:client + check:version + check:docs + npm pack --dry-run
[ ] 真机矩阵（§7）勾一遍，未验项写明原因与谁验
[ ] 自动化冒烟/回归在 Web 测试 profile 上跑（§7.0），证据按 §7.3 口径；桌面只补手工冒烟
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
| P8 计划模式 | 仓库只读 + 可写 `$TMPDIR`/scratch（模式与授权解耦）、`plan_save` 唯一写入口、`exit_plan_mode` 拒绝；P0-4 起批准是显式 `task_message({action:'approve'})`（前置 + 审计 + 四态） | CHANGELOG `0.17.0` / `0.33.0`；`test/plan-mode.test.js`；`scripts/verify-plan-scratch.mjs` |
| 拍板流程 vA（0.32.x 同版） | **只改提示词/文案**：L1 五条规则、批准四选一、决策汇总顺序、blocked 通知「待拍板 N 项」、回执「子会话」保留会话 id；`plan_save` 参数面未变（无结构化参数/文档 lint） | `test/decision-flow.test.js`、`test/interaction-policy.test.js`；CHANGELOG `0.32.0` |
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
| P2-3 交接契约 v1 | 三条确认路径的 `acceptedBy` + 链式自动放行（`chain`）、事件各一次、幂等关闭、存量行 NULL、字段表与代码同源 | `test/handoff.test.js`、`test/chain-auto.test.js`、`test/host-route.test.js`、`scripts/check-docs.mjs` |
| P2-4 官方 Team 板 | 只读快照透传 `revision`、`enabled:false` 不读板、CAS 冲突只重读一次、超时自动完成不反写 | `test/team-board.test.js`、`test/index.test.js` |
| P2-5 面板 S9′ | esbuild minify + ≤95 KiB 闸门、官方板只读分区、交接区块、验收小标 | `test/client-build.test.js`、`test/client.test.js` |
| P2-6 文档收口 | 文档 ≤1,800 行（预算常量与失败提示同改）、README 首屏重写 + 结构断言、P2 变更入档 | `scripts/check-docs.mjs`、本文件 §3.4 |
| 外部依赖 | ds-bot Bot 模式不撤外部 root 会话皮肤、rc.3 子会话沙箱根=父目录、团队工具残留 | CHANGELOG `0.13.0`/`0.14.0`；[LIMITATIONS](LIMITATIONS.md) |
| 任务链规则（0.28.0） | L1 五条规则（判据与建链时机 / 不阻塞 / 失败传播 / delivered≠done / 同检出串行）逐字来自 `src/copy.js`；`task_create.dependsOn` 描述与 `waiting_dep` 回执同源；L2/L3 探针；机制用 `dependencyState`/`promoteDependents` 复核 | `test/task-chain-policy.test.js`、`test/prompt-layers.test.js`；CHANGELOG `0.28.0` |
| 并行策略（t-c8adaeb1） | L1 独立一段（互不依赖 + 无需复用上下文 + 同写域撞车 → 优先 `worktree:true` 并行；有依赖/复用上下文才串行；代价与只读/计划例外；同一检出必须串行）逐字来自 `src/copy.js` 的 `PARALLEL_LINES`；与 worktree/写域/任务链三段口径对齐（不再暗示默认先串行）；派发/队列/写域判定未动 | `test/parallel-policy.test.js`、`test/prompt-layers.test.js` |
| 协调者去 grep + W1 任务执行者 policy（t-4f7ce108） | 协调者预设移除 `tool-fs-search` 整行（该包无按工具开关、`deny` 遮不到预设自有行）→ 只留 `read`；W1 由 `renderWorkerPolicy` 渲染、`index.js` 第二条 `systemPrompt.context`（order 131）按 `tasks.session_id` 注入，静态提示（详情/上报/交付/装依赖/context）只在此出现一次；brief 收到 2–3 行、persona 只剩身份 | `test/config.test.js`、`test/index.test.js`、`test/prompt-layers.test.js`、`test/brief.test.js`、`test/copy-consistency.test.js`、`test/worktree.test.js` |
| 子会话工具失败监听（2026-11-23） | `tools/result` 观察者：判定三通道（结构化 code → `sandbox.denied` → stderr 文本，**不要求退出码非零**）、`workerTaskOf` 归属 + 协调者/非任务会话排除、10 分钟 `(taskId,tool,code)` 去重通知、env 类只写日志、家目录脱敏；真实样本 seq 816 / seq 824 做成夹具；W1 新增「权限/环境失败必须写进回报」 | `test/child-tool-failure.test.js`、`test/index.test.js`、`test/prompt-layers.test.js` |

## 7. 真机复核（开发/安装面 = Desktop；自动化验收面 = Web 测试 profile）

**主次**：交付前的自动化冒烟与回归**一律**在 Web 测试 profile 上跑——隔离 `DSH_HOME` + 临时 profile + 无头浏览器/HTTP 断言，不碰 Desktop、不影响用户正在用的桌面实例，可复跑、可取证。Desktop 是**开发与安装面**，只承担「用户真实入口」的手工冒烟（§7.1、§7.2）与自动化确实覆盖不了的项（§7.4）；**测试结论优先引用 web 测试 profile 的证据**。

**为什么外部自动化不盯桌面 GUI**：桌面窗口的 `?token=` 由宿主在启动时注入窗口，调用方没有受支持的取法（只有 `dsh web` 会把带 token 的 URL 打到 stdout）；对着用户真实桌面实例做自动化还会写真实台账、用真实账号凭据，违反 §1「不碰真实数据」。

结果栏：`[ ]` 未验 / `[x]` 通过 / `[!]` 不通过（记现象）。宿主端口用实际 DSH Web 端口。

### 7.0 起一个 Web 测试 profile（自动化冒烟/回归的固定入口）

每次验收从零起：隔离 `DSH_HOME`（真实 `~/.dsh` 零读写）+ 临时 profile（不动 `desktop`）+ 空闲端口。

```powershell
$env:DSH_HOME = "$env:TEMP\orch-verify-$(Get-Random)"                     # 隔离 home
dsh --profile verify --from-default-profile web --dump-config | Out-Null   # 临时 profile（web 模板）
pnpm pack --pack-destination "$env:TEMP"                                   # 发版前：验「用户装到的东西」
dsh plugin --profile verify add "$env:TEMP\wjj865-code-dsh-orchestrator-<version>.tgz"
# 改代码时用 link：dsh plugin --profile verify add "link:<仓库路径>"
dsh --profile verify web --no-open --port <空闲端口> --host 127.0.0.1
# 打印：dsh web: http://127.0.0.1:<端口>/?token=<token>   ← 自动化就吃这一行
```

- 模型：真验收用账号凭据；不想烧额度就把 `DEEPSEEK_BASE_URL` 指向本地 Messages 兼容 stub（`reports/main-permission-badge-verify/harness/mock-llm.mjs`）+ 假 key，不读用户凭据。
- 浏览器：系统 Chrome `--headless=new` + 独立 `--user-data-dir` + 原生 CDP（`reports/*/harness/cdp.mjs`，零第三方依赖）；只验接口就直接对 `/api/orchestrator` 发 HTTP。
- 端口挑空闲的（`--port 0` 也行），别占用户正在用的实例；收工停服务、关 Chrome、删临时 home。

**典型步骤（按需挑，证据口径见 §7.3）**

1. HTTP 面：`POST /api/orchestrator` 取 `snapshot` → 结构与筛选档正确；无 cookie 401/405 均可（拒绝即通过）、跨站 Origin 403；调接口前后 `tasks.sqlite` 行数不变。
2. UI 面：无头 Chrome 打开带 token 的 URL → 侧栏「主会话」/ 会话头「任务」可点、`data-page` 五页切换、抽屉与 dock 实渲染、console 零 error（§7.1 逐条挑）。
3. 任务流面：派任务 → `task_report` → 「已交付待确认」→ `close` 收 `done`；只读任务写文件被拒；worktree 按传入的 `<type>/<slug>` 建出分支与检出（漏传报错）（§7.2）。
4. 插件页：`[data-orchestrator-config]` 存在，配置卡片组数/行数与代码一致。
5. 隔离审计：临时 home 之外零新增；真实 `~/.dsh` 与用户 profile 未被写；收工清理（§1「不碰真实数据」）。

### 7.1 入口与面板

| # | 操作 | 期望 |
| --- | --- | --- |
| 1 | 侧栏「插件」下方点「主会话」 | 一帧占位后进入主会话对话（新建或复用），侧栏无残留高亮 |
| 2 | 已在主会话时再点一次 | 不重复创建、不报错 |
| 3 | 会话头「任务」按钮 | 打开任务面板：顶栏、4 张指标卡、筛选轨、列表（首帧骨架） |
| 4 | 点任务卡/详情 | 抽屉滑入、遮罩变暗；`Esc`/遮罩/关闭都收起 |
| 5 | 切 6 档筛选与搜索 | 分类正确、无匹配显示「没有匹配的任务。」 |
| 6 | 点产物「预览」 | 主栏切回会话、右侧栏打开该文件 Tab；缺侧栏时给可读原因 |
| 7 | 无 cookie / 跨站 Origin 调 `/api/orchestrator` | 401/405 均可（拒绝即通过） / 跨站 403 |
| 8 | 停宿主后看面板 | 5s 内「台账暂不可用」，恢复后刷新或等 30s 自动恢复 |
| 9 | 官方 Team 开启时打开面板 | 出现「官方 Team（只读）」折叠分区；行内**没有**按钮；关掉 Team 或宿主没装 Agent Teams 时整区不渲染（不显示提示条） |
| 10 | 在区间外宿主（如 `0.3.0`）装本包 | 插件页**拒装**（`incompatible-version`，列出未满足的 `engines.dsh`）；若已装，启动 stderr 有 `disabling profile plugin …`、该行不加载；按 `docs/compat.md` §1.1 给 `compatibility.json` 精确豁免后能加载 |

### 7.2 任务流

| # | 操作 | 期望 |
| --- | --- | --- |
| 1 | `task_create` 派一条普通任务 | 子会话在 target 目录跑，面板出现任务并变「待确认」 |
| 2 | 子会话 `task_report done` | 协调者收到通知；`task_message({action:'close'})` 收成「已完成」 |
| 3 | 交付后追问 | 复用同一个子会话，任务回「进行中」，完成后再次交付 |
| 4 | `task_message({action:'stop'})` | 任务「已取消」，子会话被中断 |
| 5 | 计划任务 `planFirst:true` | 只读沙箱；计划落任务产物目录 `docs/<任务名>-<版本>.md`；`blocked` 上报后**普通 message 不批准**，`task_message({action:'approve'})` 才切可写并落审计 |
| 6 | 只读任务 `readOnly:true` | 写文件/写 shell 被拒且可读；续派仍只读 |
| 7 | `worktree:true` + `worktreeBranch:"feat/smoke"` | 真的按传入名建出 `feat/smoke` 与检出；漏传 `worktreeBranch` 直接报错（带 type 白名单）；通知/`task_status` 标「隔离」；`git status` 无 `.agents/` |
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

交报告时按这张表给证据（自动化证据优先）：

| 证据 | 要求 |
| --- | --- |
| 结论表 | 「验证点 / PASS·FAIL / 证据文件名」一条一行；FAIL 写现象与判据，不写「偶发」 |
| 截图 | 关键状态各一张（面板、抽屉、徽标、配置卡），放 `reports/<主题>/screenshots/` |
| console / network | 浏览器 console 零 error（warn 逐条说明来源）；network 的 `snapshot` 节奏与面板开关一致 |
| 服务端日志 | 临时 home 的 `state/orchestrator/logs/*.jsonl` 关键事件（`task.*`、`main.session.permission-pinned`、`host.capabilities`）；启动瞬间能力数 ≠ 最终能力面（见 compat.md §3） |
| 隔离证明 | 临时 `DSH_HOME`、profile 名、端口、被测包版本（读**安装副本**的 `package.json`，不是仓库里的） |

### 7.4 人工验收：确实自动化不了的项

以下三类允许把本地插件 link 进用户环境（`desktop` 或指定 profile），由用户手动操作并回报现象——动手前先确认没有更便宜的 web 自动化路径：

- **GUI 交互细节**：真实鼠标/键盘手感、滚动与动画、拖拽排序、剪贴板、焦点与输入法、宿主主题切换下的观感；
- **桌面特有行为**：桌面窗口的菜单/快捷键、托盘与单实例、Electron 与 Web 的差异分支、装完「彻底退出再启动」的生效路径；
- **真实安装态**：在用户自己的 `desktop` profile 里装正式包或 `link:` 之后的表现、真实账号凭据下的模型行为。

请用户验时按这四项写清（缺一项就不算可执行的人工验证）：

1. **为什么必须人工**：哪条自动化断言覆盖不了，写到具体项，不写「不好测」；
2. **影响哪个 profile**：改 `desktop` 还是某个测试 profile、装 tarball 还是 `link:`、要不要重启宿主；
3. **怎么回滚**：先给回滚动作（`dsh plugin --profile <p> remove <包名>`、把 profile `package.json` 的 link 改回版本号、或恢复备份的 profile 目录），再让人动手；
4. **要回报什么**：操作步骤 + 截图（哪一屏）+ 日志片段（`$DSH_HOME/state/orchestrator/logs/*.jsonl` 或宿主日志）+ 结论（通过 / 现象 / 能否复现）。

结论进报告时标「用户手动验证」，与 web 测试 profile 的自动化证据**分列**；同一项两种证据都有时，优先引用 web profile 的。
