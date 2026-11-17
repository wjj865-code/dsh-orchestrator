# SSOT 三件套结构收敛：实施报告

- 任务编号：`t-2966c244`
- 检出目录：`.agents/worktrees/t-2966c244`（分支 `orch/t-2966c244`，基线 `main`）
- 起点版本：0.19.1（`8770718`）→ 实施后版本：**0.20.0**（minor）
- 审计依据：`reports/design-audit/dsh-orchestrator-design-audit.md`（§2.1 / §2.3 / §2.4 / §3 / §4.5 / §5 / §6 / §7）
- 状态：**未提交、未推送**（按约束：合并/提交由用户决定）

---

## 0. 一句话结论

按审计报告的 SSOT 三件套方案（方案 C + status-facts + prompt-layers，附带 worktree caps）实施完毕：
**新增 5 个事实源模块、4 个测试文件，改动 40 个文件（+901 / −252 行，另新增 1617 行）**；
`npm test` **997/997 全绿**（起点 941 条），`check:client` 通过；
真实台账验证：存量产物可读率 **21.3% → 100%**（91/91 条仍存在的产物全部可读）。

---

## 1. 改动文件清单与行数

### 1.1 新增模块（5 个，832 行）

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/artifact-location.js` | 138 | 产物位置的唯一判据：`registeredArtifacts` / `registeredMatch` / `isRegisteredPath` / `deliverableOf` / `isInside` |
| `src/status-facts.js` | 161 | 任务状态的唯一事实源：`STATUS_CAPS`（13 个能力字段）+ `TRANSITIONS` + 派生函数 |
| `src/worktree-facts.js` | 127 | worktree 状态的唯一事实源：`WORKTREE_STATE_CAPS`（6 个能力）+ `WORKTREE_TRANSITIONS` |
| `src/prompt-layers.js` | 189 | 提示词五层的职责边界表 + 归层探针 `layerViolations` + 跨层共享常量 |
| `src/preferences.js` | 217 | 偏好机制：出厂种子、归一化、读写、L2 段渲染、写入路由 |

### 1.2 新增测试（4 个，794 行，共 49 条用例）

| 文件 | 行数 | 条数 | 覆盖 |
|---|---|---|---|
| `test/artifact-location.test.js` | 259 | 13 | 已登记可读 / 未登记仍拒 / 符号链接不放行 / 目录子树 / 工作区优先 / 存量台账抽样 |
| `test/status-facts.test.js` | 175 | 11 | caps 表完整性 / 三处不一致回归（含端到端）/ 静态断言「无本地状态集合」 |
| `test/prompt-layers.test.js` | 157 | 12 | 五层归层探针 / onboarding 瘦身 / 三处矛盾回归 / 跨层常量同源 |
| `test/preferences.test.js` | 206 | 13 | 归一化 / 预算截断 / 不双写路由 / 出厂种子约束 / 配置夹取 |

### 1.3 修改文件（按类别）

| 类别 | 文件 | 改动要点 |
|---|---|---|
| **核心逻辑** | `src/read-workspace.js` | 边界改为「工作区 **OR** 已登记产物」；`via`/`artifact` 字段；越界与「已登记但缺失」文案分离 |
| | `src/tools.js` | `read_workspace` 接入登记表、工具描述改口径；5 个本地状态 Set 改为派生；`task_stop` 用 `stopIsIdempotent`；`memory_note` 分流 |
| | `src/state.js` | 改为门面：事实转发给 `status-facts.js`，只保留文案表 |
| | `src/panel-gates.js` | 5 个集合改为派生；新增 `stopIsIdempotent` / `stopGate` / `canStop` / `RETRYABLE_STATUSES` |
| | `src/panel-actions.js` | stop 幂等改用 `releases` 能力（**修 failed→cancelled 缺陷**）；4 个本地 Set 改为派生 |
| | `src/ledger.js` | 活跃状态 SQL 由常量生成；`setTransitionObserver` + `task.transition` 审计日志；`setTaskWorktree` 转移校验；plan 收口用 `planSettled` |
| | `src/worktree.js` | 派发/重派/清理三处列表改为查表 |
| | `src/worktree-request.js` | 能力表 re-export；`hasCheckout` / 列表小标 / 详情行改为查表 |
| | `src/write-guard.js` | `ISOLATED_WORKTREE_STATES` 改为派生（值不变：`requested/created/reused`） |
| | `src/settlement.js` / `reconcile.js` / `watchdog.js` / `main-rotation.js` / `host-route.js` | 各自的本地状态集合改为派生（`releases` / `liveness` / `catalog` / `watchdog` / `rotationActive`） |
| | `src/notify.js` | `classifyPath` 改为引用 `deliverableOf`；`PRESENT_HINT` 改为「已登记的产物」+ 共享上限常量 |
| **提示词** | `index.js` | L1 加偏好第 4 段；`read_workspace` 口径改写；`present` 上限用共享常量；接入 transition 观察者 |
| | `src/brief.js` | `SUMMARY_FIELDS` 共享常量；`CONFIRM_HINT` 改为「summary = 结论 + 三问 + 待确认要点」 |
| | `src/task-detail.js` | `FINISH_HINT` 引用 `SUMMARY_FIELDS`（与 brief 同源）；工作目录判定用 `hasCheckout` 能力 |
| | `src/onboarding.js` | **708 → 525 字**，删 6 条与 L1 重复的能力边界 |
| | `src/config.js` | 新增 3 个偏好配置键（`preferencesInject` / `preferencesMaxChars` / `preferencesMaxItems`） |
| **文档** | `CHANGELOG.md` | 新增 0.20.0 完整条目（122 行） |
| | `docs/ARCHITECTURE.md` | 工具数 14→15；新增「状态事实源」「worktree 状态事实源」「提示词分层」三节；`read_workspace` 一节改写 |
| | `docs/LIMITATIONS.md` | 删「选项进 question+options」；新增「状态与提示词的单一事实源」一节；`read_workspace` 一节改写 |
| | `docs/DETAIL.md` | 常用工具补 `read_workspace`；brief 行数改为 4–6 行 |
| | `README.md` | `read_workspace` 边界、brief 行数、交付 summary 口径、偏好机制 |
| | `package.json` | 0.19.1 → **0.20.0** |
| **测试夹具** | `test/helpers.js` | 新增 `markDone(db, id)`：走合法的 `… → delivered → done` 路径 |
| | 10 个既有测试文件 | 19 处 `transition(db, id, 'done')` 改为 `markDone`；`state.test.js` 矩阵改为派生；`copy-consistency` 扩展到 `docs/*.md` |

---

## 2. 三件套各自解决了哪些问题（对应审计条目）

### 2.1 artifact-location（审计 §2.1 / §2.5 / §4.3.2 / §3.10）

| 审计条目 | 修法 | 验证 |
|---|---|---|
| **§2.1 P0**：78.7% 产物读不到 | 台账 `tasks.artifacts_json` 提升为产物唯一合法性判据；`read_workspace` 边界 = 工作区包含性 **OR** 已登记产物 | 真实台账：**91/91 可读**（19 工作区内 + 72 已登记），此前仅 19 条 |
| **§2.1.5 方案 C 的三条实现要点** | ① 新增 `resolveWorkspaceTarget(root, input, {registered})`；② `tools.js` 汇总 `listTasks(db,{active:false})` 的 artifacts；③ 工具描述与拒绝文案改口径 | 工具描述不再含「常落在 reports/」（有断言） |
| **§2.1.5 第 4 点：三条安全测试** | 「已登记可读」「未登记同目录仍拒」「登记表内符号链接仍拒」 | `test/artifact-location.test.js` 各一条，另加目录子树与存量抽样 |
| **§2.5 P1**：四条读取路径判定不同源 | `deliverableOf` 成为 `present` 口径的唯一定义（`notify.js` 引用）；`preview`/右侧栏本来就是登记表，现在与 `read_workspace` 同源 | `deliverableOf` 单测 6 类 |
| **§3.10 必须修**：工具描述错误 | 改为「读产物正文：主会话工作区内，或任务回报过 artifacts 的已登记产物」 | `test/artifact-location.test.js`「工具描述不再声称…」 |
| **§3.4 必须修**：`LIMITATIONS.md` 教不存在的能力 | 删掉「选项进 question+options」，如实说明 `done` 会清空 | `test/prompt-layers.test.js`「矛盾 1 已修」扫 4 份文档 |
| **§3.1 / §3.2 必须修**：工具数 14 vs 15、DETAIL 缺 `read_workspace` | `ARCHITECTURE.md` 14→15；`DETAIL.md` 补 `read_workspace` | `copy-consistency` 新增「文档工具数一致」断言（扩展到 `docs/*.md`） |

**两条刻意保留的安全边界**（都有测试）：
1. 登记表**不扩大**读取面——未登记的同目录文件仍被拒（读取面 = 工作区 ∪ 登记集合，不是整个 target 仓库）；
2. 登记表**不借符号链接**放行——登记一个指向 `~/.ssh` 的链接不等于登记了任意文件。

**为什么没选方案 A / B**（审计 §2.1.5 已论证，实施中再次确认）：
- A（改提示词让产物写工作区）破坏 worktree 语义（检出里的产物要合并，搬走就分裂）；
- B（放开所有 target）把整个仓库（含 `.env`、未提交改动）暴露给协调者上下文，再叠加 IM 外发风险。

### 2.2 status-facts（审计 §2.3 / §4.2 / §4.5）

| 审计条目 | 修法 | 验证 |
|---|---|---|
| **§2.3.1**：状态集合 9 处定义 | 一张 `STATUS_CAPS` 表 + 派生；删掉 13 处本地 Set（`tools` 5 个、`panel-gates` 5 个、`panel-actions` 5 个、`settlement` 1 个、`reconcile` 2 个、`watchdog` 1 个、`main-rotation` 1 个、`host-route` 内联三态、`ledger` 2 处 SQL 字面量） | 静态断言：`src/` 里不再有 `new Set([…'waiting_*'…])` |
| **§2.3.2 第 1 处**：`RESUME_STATUS` 含 `failed`（死分支） | 拆成 `followup`（能续派）与 `resumable`（续派后要迁回 running）两个能力；工具层用 `resumable`，面板层用 `followup`，两者不再冲突 | `test/status-facts.test.js` 断言 running 上 `followup:true` 但 `resumable:false` |
| **§2.3.2 第 2 处**：「流程终态」vs「要释放资源的终态」同名混淆 | 拆成 `terminal`（done/cancelled/orphaned）与 `releases`（+failed），语义各自可断言 | 同上，断言 `failed.terminal===false && failed.releases===true` |
| **§2.3.2 第 3 处（可触发缺陷）**：面板 stop 把 failed 变 cancelled | 新增 `stopIsIdempotent`（判 `releases` 能力），面板与工具 `task_stop` 都用它 | **端到端回归**：面板 stop 与工具 `task_stop` 对 failed 任务各一条，断言状态仍是 failed |
| **§2.3.3 三条不可达边** | 删 `running→done`、`failed→running`、`orphaned→pending` | `test/state.test.js` 新增「三条不可达边已删」正向断言 |
| **§2.3.3 测试锁死错误行为** | 10×10 矩阵从 `TRANSITIONS` 派生；19 处 `transition(db,id,'done')` 夹具改为 `markDone`（走合法两步） | 全绿；夹具同时覆盖了交付主路径 |
| **§2.3.4 `main-rotation` 的「不含 delivered」** | 独立字段 `rotationActive`（不是复用 `active`） | 断言 `rotationActive` = 5 态，`delivered` 不在内 |
| **§4.5 transition 无日志（最大可观测性缺口）** | `setTransitionObserver` + `index.js` 挂 `task.transition` 日志，覆盖全部 19 个调用点 | 观察者失败不影响迁移（try/catch 旁路） |
| **§4.2.2 worktree 无转移校验** | 见 2.3 | — |

### 2.3 worktree caps（审计 §2.4，附带项）

| 审计条目 | 修法 | 验证 |
|---|---|---|
| **§2.4 七份独立列表** | `WORKTREE_STATE_CAPS` 6 个能力字段；7 处引用改查表 | 派生结果与原先**逐一等价**（脚本核验 + 既有 81 条 worktree 测试全绿） |
| **§2.4 「没有任何一处文档解释这些差异」** | 能力表每个字段用注释回答一个具体问题（占不占目录 / 要不要建树 / 有没有检出 / 显不显示小标 / 要不要重派 / 要不要通知） | 模块头注释 + `docs/ARCHITECTURE.md` 新节 |
| **§4.2.2 无转移校验** | `WORKTREE_TRANSITIONS` + `canWorktreeTransition`；`setTaskWorktree` 校验，同状态幂等 | 真实台账 65 行状态全部合法（`none 49 / created 11 / reused 5`），不会因校验报错 |

**一个实施中发现的约束**（已处理）：能力表不能放在 `worktree.js` 或 `worktree-request.js`——这两者本来就互相引用
（后者要 `branchNameLooksValid`），表放在其中一边会在模块求值期撞 TDZ。所以独立成叶子模块 `worktree-facts.js`（不 import 任何东西）。

### 2.4 prompt-layers（审计 §2.7 / §2.8 / §3 / §5.1 / §5.4）

| 审计条目 | 修法 | 验证 |
|---|---|---|
| **§5.1 五层职责边界** | `PROMPT_LAYERS` 表：每层的载体/生命周期/受众/`owns`/`forbids` | `test/prompt-layers.test.js` 逐层断言 |
| **§2.7 L1 与 L4 重叠 6 条** | onboarding **708 → 525 字**，删掉 6 条能力边界 | `layerViolations('L4', …)` 从 5 条命中降到 **0** |
| **§2.8 L1 与通知重叠 3 条** | 通知只留动作指令；`PRESENT_LIMIT_TEXT` 成为 L1 与通知的唯一来源 | 断言 policy 与 `PRESENT_HINT` 都含同一常量 |
| **§5.1.2 矛盾 1**：文档教「选项进 question+options」 | 删掉，如实说明 `done` 不支持 | 扫 4 份文档断言不再出现 |
| **§5.1.2 矛盾 2**：brief「要点进 summary」vs task_detail「写三问」 | 统一为「summary = 结论 + `SUMMARY_FIELDS` + 待确认要点」，两处引用同一常量 | 断言两处都逐字包含 `SUMMARY_FIELDS` |
| **§5.1.2 矛盾 3**：DETAIL 说 brief 是四件事、实际 6 行 | 改为「4 行基准，full/隔离各加一行 → 4–6 行」 | 断言 `renderBrief` 四种组合行数 4/5/5/6 |
| **§5.2 / §5.3 偏好机制归 L1** | `src/preferences.js` + `index.js` 第 4 段 + 3 个 config 键 | `test/preferences.test.js` 13 条 |
| **§5.3 待定项 1：放末尾** | policy 末尾独立段，可单独开关 | 段首自带「优先级低于硬规则」声明 |
| **§5.3 待定项 2：不双写** | 全局偏好**只写 settings**，`history_search` 查不到；项目偏好只写 memories | 端到端断言：settings 有 / memories 无；项目偏好反之 |
| **§5.3 待定项 3：字数 + 条数双限** | `preferencesMaxChars=1200` 为主 + `preferencesMaxItems=12` 为安全阀；超限**显式告知** | 断言段尾有「另有 N 条偏好因超限未展示」 |
| **§5.3 待定项 4：v1 不带脚本** | 未新增 `scripts/preferences.mjs`，只有 `memory_note` 一条写入路径 | — |
| **§5.3 结构性保证：偏好不是权限通道** | 只是提示词文本，不进 config / 不改 dispatch / 不碰沙箱；种子无放宽安全边界的条目 | 测试断言种子不含「一律/全都/所有任务都」这类泛化授权 |

---

## 3. 测试结果（实际运行）

```
$ npx pnpm test          # pretest 会先跑 vite build
# tests 997
# suites 0
# pass 997
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 7568.63625

$ npx pnpm run check:client
$ node --check dist/client.js
（exit 0）
```

- 起点基线：**941 条全绿**（改动前实测，与审计报告 §4.6.1 的 940 条一致）
- 改动后：**997 条全绿**（+56：新增 4 个文件 49 条 + `copy-consistency` 1 条 + `state.test.js` 净增 6 条）
- 客户端构建产物已重新生成（`dist/client.js`，129.09 kB），`check:client` 通过

### 3.1 真实台账验证（存量兼容性的直接证据）

用宿主真实台账（`~/.dsh/state/orchestrator/tasks.sqlite`，65 任务 / 93 条产物）跑一遍：

| 指标 | 改动前 | 改动后 |
|---|---|---|
| 产物总数 | 93 | 93 |
| 仍存在 | 91 | 91 |
| **可读** | **19（21.3%）** | **91（100%）** |
| 其中工作区内 | 19 | 19 |
| 其中已登记产物 | 0（读不到） | **72** |
| 已删除的产物 | 报「越界被拒绝」（误导） | 报「不存在（该产物已登记，但文件已被删除或移动）」 |

这条也写进了测试：`test/artifact-location.test.js` 的「存量台账抽样」用例在存在真实台账时自动断言 `readable === total`（CI/无台账时跳过）。

### 3.2 没有运行的验证项

- **浏览器/面板实机验证未做**：本次改动不涉及 `client/src/**`（客户端只读服务端下发字段），`dist/client.js` 由构建重新生成且 `check:client` 通过；但**没有**在 Web GUI 里点过面板动作。风险低（面板行为由 `panel-actions`/`panel-gates` 的服务端测试覆盖），如需视觉确认请在实际环境点一次「停止/重派/预览」。
- **没有在真实 DSH 会话里跑过 `read_workspace`**：只做了纯函数 + 工具层端到端（`createTools` + 真实台账），没有在协调者会话里实调。

---

## 4. 兼容性影响

| 改动 | 破坏兼容？ | 说明 |
|---|---|---|
| `read_workspace` 边界放宽 | ❌ 纯放宽 | 工作区内路径行为**一字未变**；只多放行「已登记产物」。旧调用不传 `registered` 时行为与 0.19.1 完全一致（有测试） |
| 删除 3 条转移边 | ❌ | 只影响**未来**的迁移；不改任何存量行。台账里不存在需要这些边的数据（真实台账 65 行状态全部合法） |
| `stopIsIdempotent` 修 failed→cancelled | ⚠️ 行为修正 | 对失败任务点「停止」从「改成已取消」变为「幂等成功」。这是**修 bug**，但如果有人依赖旧行为（把失败洗成取消），需要知道 |
| `setTaskWorktree` 校验转移 | ⚠️ 新增守卫 | 合法路径全部覆盖（`none→requested→created/reused/failed`、`created/reused→cleaned`、`failed/cleaned→requested` 等）；历史台账状态全部合法；**人工改库写入非法值**时会在下次写状态时报错 |
| `memory_note(kind:'preference')` 路由变化 | ⚠️ 语义变化 | 全局偏好从「写 memories」变为「写 settings 偏好」——**这是审计 §5.3 待定项 2 的明确结论**（不双写）。影响：`history_search` 查不到全局偏好；返回文案已明确告知。项目偏好行为不变 |
| 偏好段注入 policy | ❌ 纯增量 | 默认开启（出厂种子 2 条）；`preferencesInject:false` 可关；只影响提示词文本 |
| onboarding 文案瘦身 | ⚠️ 文案变化 | 708 → 525 字，删的是与 L1 重复的能力边界（L1 每回合都在）；`workspace-index` 测试已同步 |
| 新增 `task.transition` 日志 | ❌ 纯增量 | 每条状态迁移多一行日志 |
| 台账结构 / 工具入参 / 沙箱默认值 | ❌ 完全不动 | 无 `ALTER TABLE`、无新表、无新工具（仍是 15 个） |

### 4.1 是否需要版本跃迁

**建议 0.20.0（minor）**，已写入 `package.json` 与 `CHANGELOG.md`。理由：
- `read_workspace` 的**能力范围变化**（读取面放宽）属于用户可感知的能力增强 → 不是 patch；
- `memory_note` 的偏好路由变化是**语义变化**（用户可感知）；
- 新增 3 个配置键；
- 但台账结构、工具入参、沙箱默认值、状态机语义（只删死边）都不变 → **不需要 major**。

若团队更倾向保守，也可以拆成 0.19.2（artifact-location + status-facts + worktree caps，纯内部 + 纯放宽）+ 0.20.0（偏好机制 + onboarding 瘦身）两版——审计 §7.3 的建议就是这种拆法。**当前实现是一次打包**，因为三件套共享同一批测试与文档改动，拆开会重复改同一批文件。

---

## 5. 实施中偏离/补充审计方案的地方（需用户知晓）

审计方案总体可执行，有 4 处做了补充或微调，都不改变方案意图：

1. **`resumable` 是新增能力字段**（审计 §2.3.4 的示例表里没有）。实施中发现 `followup` 一个字段不够：
   `running` 能续派（`followup:true`）但续派**不改状态**，而 `waiting_*`/`delivered` 续派要迁回 `running`。
   用同一个字段会让 `task_message` 对 running 任务触发 `running → running` 非法迁移（测试立刻抓到）。
   → 拆成 `followup`（能不能投递）与 `resumable`（投递后要不要改状态）。

2. **worktree 能力表独立成 `worktree-facts.js`**（审计建议放 `worktree-request.js`）。实施中发现循环依赖
   （`worktree-request` → `worktree` → `worktree-request`）导致 TDZ 崩溃，改为无依赖的叶子模块。
   语义与字段完全按审计 §2.4 的建议。

3. **`stopIsIdempotent` 同时用在工具层 `task_stop`**（审计只提到面板 stop）。实施中发现工具层有**同一个 bug**
   （`TERMINAL_STATUS.has(task.status)` 同样不含 failed），一并修掉，避免两个通道行为不一致。

4. **测试夹具 `markDone`**（审计未提）。删掉 `running→done` 后 19 处测试夹具失效，新增 helper 让它们走
   合法的 `… → delivered → done`——这样夹具本身也覆盖了交付主路径，比原来更有价值。

**没有发现审计方案有错或不可行的地方**；§2.1.5 的三个方案评估、§2.3.4 的 caps 表设计、§5.3 的四个待定项结论
在实施中都被验证是准确的（尤其「不双写」这条：实施时确实发现双写会让「改了一处、另一处还是旧值」）。

---

## 6. 明确没做的事（审计里不属于本次范围的）

以下审计条目**不在**本任务的验收标准内，本次未做，也未改坏：

| 审计条目 | 为什么没做 |
|---|---|
| §2.2 M2：`done` 带 `question`/`options` | 审计标为「建议修，不阻塞 P0」，且用户已批准的是「三件套」；本任务只修正了文档误导（§3.4） |
| §4.1.2 S1：动作下沉 `task-actions.js` | 属第 3 批，约 300 行搬移，风险中等，不在本次范围 |
| §4.4.2 S2：错误码扩展 | 同上 |
| §4.6 M6：`test/deps.test.js` | 不在三件套范围 |
| §4.1.3 S6：`debug-preset.js` 移到 `scripts/lib/` | 同上 |
| §3.3 / §3.6 / §3.7 / §3.8：其余文档漂移 | 不在本次验收标准（只做了 §3.1/3.2/3.4/3.10） |
| §2.6 R1：双水位 | 审计裁定「仅记录，不建议在本插件里修」；只按建议在 `LIMITATIONS.md` 加了 `.mr-watch/` 不要用 `read_workspace` 读的一句 |

---

## 7. 交付物与验证命令

```bash
# 在检出目录里
cd .agents/worktrees/t-2966c244

# 依赖（worktree 里没有 node_modules）
PNPM_HOME=/tmp/pnpm-home npm_config_cache=/tmp/npm-cache npx --yes pnpm@11.22.0 install --frozen-lockfile --prefer-offline

# 完整测试（含客户端构建）
npx pnpm test           # 997 passed / 0 failed

# 客户端语法检查
npx pnpm run check:client
```

产物文件：
- 本报告：`.agents/worktrees/t-2966c244/reports/ssot-convergence-0.20.0.md`
- 代码改动：见 §1（`git status` / `git diff`）
- **未提交、未推送**：所有改动留在工作区，由用户决定提交/合并。
