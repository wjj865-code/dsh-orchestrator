# P9 子任务 worktree 隔离（结构化声明 + 职责切分）

- 日期：2026-11-15
- 任务：`t-ce22fc07`（P9，`master-plan-4docs.md` §4 / §6 T9.1–T9.10；原设计文档 `2026-11-15-subtask-worktree.md`）
- 目标：`task_create({ ..., worktree: true })` 时插件在宿主进程建 `git worktree`，检出目录成为子会话的 `target_dir`；
  声明只有结构化两处（配置 + `task_create.worktree*`），**零自然语言解析**；协调者判断、插件执行。
- 结论：T9.1–T9.9 落地（T9.10 只做全量、**不发版**；真机矩阵待装 profile 后勾）；**`npm test` 717/717 全绿**
  （新增 45 条：`test/worktree.test.js` 26 + `test/worktree-request.test.js` 19）；`npm run check:client` 通过；
  本地 commit、**未 push**。

---

## 0. 先看这一页

| # | 结论 | 证据 |
|---|---|---|
| A | **结构化声明**：用户级 `worktreePolicy` / `worktreeBranchPrefix` / `worktreeRecentDays`（配置）+ 任务级 `worktree*` 字段；`worktree` 只认布尔（`'true'`/`'auto'` 拒绝） | `src/config.js`、`src/worktree-request.js`（`parseWorktreeRequest`）；用例 3 条 |
| B | **零自然语言解析（v2 反向验证）**：仓库没有 `worktree-policy.js`、没有 AGENTS 解析、没有自然语言兜底正则；`grep worktree-policy` 零命中，`AGENTS` 只出现在注释与既有 `project_context`（白名单读） | `git grep`；`src/worktree.js:6`、`src/worktree-request.js:4` |
| C | **条件创建引导**：policy 文本写清 required/auto/off 与「git 仓库 ∧ 同需求已有任务 ∧ 新需求」三条件；配置在启动时渲染进协调者 policy（模板函数，不是常量） | `index.js` `renderWorktreePolicy` / `renderCoordinatorPolicy`；用例 1 条 |
| D | **base 分支选择**：n=0 用默认分支、n=1 直接用那条、**n≥2 返回 `needsBranchChoice` 且不落库**（协调者 `ask_user_question` → 带 `worktreeBase` 重调）；显式基线 `rev-parse --verify` 失败拒绝并列候选 | `src/worktree.js` `probeRepo`、`src/tools.js` task_create；用例 4 条 |
| E | **插件创建 + 设 target**：`queue.pump` 派发前 `prepareTaskWorktree` → `worktree add -b` + `.git/info/exclude` + `target_dir = 检出 + 原 target 偏移` | `src/queue.js`、`src/worktree.js`；用例 3 条（含 spawn cwd 断言） |
| F | **失败不静默降级**：非仓库 → `degraded` + 文案；建树失败 → 任务 `failed` + 分类原因 + 通知 | `src/queue.js`；用例 2 条 |
| G | **普通任务零 git 调用**：不传 `worktree` 时 `probeRepo` / `create` 一次都没调 | 用例 1 条（fake service 计数断言） |
| H | **视图**：`task_status`「隔离：」行、`task_list`「·隔离」、通知「产物在分支 X 的检出目录 Y，合并由你决定」、面板「隔离」小标/chip/概览行 | `src/tools.js`、`src/notify.js`、`src/host-route.js`、`client/src/**`；用例 1 条 |

---

## 1. 范围对照（计划 T9.1–T9.10）

| 计划 | 本单 | 落点 |
|---|---|---|
| T9.1 git 能力层 | ✅ | 新 `src/worktree.js`：`probeRepo` / `create` / `remove` / `ensureExcluded` / `recentBranches` / `checkBranchName` / 7 类失败分类；全部 `execFile`、超时 5s、不经 shell |
| T9.2 台账七列 + 迁移 | ✅ | `src/ledger.js`（SCHEMA / 逐列 `ALTER` / `taskOf` 归一 / `createTask({worktree})` / `setTaskWorktree` / `setTaskTargetDir`） |
| T9.3 结构化契约 + 机械映射 | ✅ | 新 `src/worktree-request.js`（`parseWorktreeRequest` / `decideWorktreeIntent` / `decideWorktreeFacts` + 全部文案）；§4.5 全表覆盖 |
| T9.4 policy 渲染 + config 字段 | ✅ | `index.js` `renderWorktreePolicy`/`renderCoordinatorPolicy`（模板化，不再常量）、`src/config.js` 三个字段 |
| T9.5 分支事实 + 询问闭环 | ✅ | `probeRepo` 返回 `isRepo/defaultBranch/recentBranches/n/suggestedBase/needsBranchChoice`；task_create 在 ask 时**不落库**并返回候选 |
| T9.6 派发接线 | ✅ | `src/queue.js`：`prepareTaskWorktree`（create / reuse / degrade / fail）→ `cwd` 传 spawn；台账 `target_dir` 换检出+偏移 |
| T9.7 清理三档 | ✅ | `cleanupTaskWorktree` + `service.remove`（off / checkout-only / full；`full` 有未合并提交保留分支并提示）；挂在结算终态、`task_stop`、面板 stop |
| T9.8 标注（通知/面板/`task_status`/`decisionSource`） | ✅ | `src/notify.js` `worktreeBlock`、`src/tools.js` 状态行/列表标记、`src/task-detail.js` 给子会话的隔离说明、`src/host-route.js` + `src/panel-actions.js` snapshot/detail、`client/src/{constants,views}.js` |
| T9.9 文档 + 真机矩阵 | 🟡 文档齐 / 真机待验 | `README.md`「隔离任务」、`docs/ARCHITECTURE.md`、`docs/LIMITATIONS.md`、`docs/qa-checklist.md` §36、`CHANGELOG.md` |
| T9.10 全量 + 发版 0.16.0 | 🟡 全量绿 / 不发版 | 版本沿用 0.12.0，与 P6–P9 的发版批次一起处理（本单只本地提交不 push） |

**没有动的**：协调者工具白名单（没有新增工具、没放开 read/write/bash）、平台依赖、`cordis.patch.yml`；
present / plan mode / goal / keep-alive / 结算 / 对账的既有行为不变。

---

## 2. 关键设计落地（评审要看的五处）

### 2.1 声明只有结构化两处，v2 删干净的都删了

- `parseWorktreeRequest` 只认布尔与枚举：`worktree: 'true'`（字符串）、v1 的 `'auto'`、`worktreeUserOverride`
  一律拒绝/不存在；
- 只给了 `worktreeBase` / `worktreeBranch` / `worktreeMode` / `worktreeCleanup` 而没传 `worktree` 时按「要隔离」处理
  （`implicit`），并在返回里写明「按 worktree 相关字段推定」——防模型漏传把意图吃掉，但这是**字段推断**，不是语义推断；
- 反向验收：仓库里 `grep worktree-policy` 零命中；`AGENTS` 只出现在注释与既有 `project_context`（读白名单文件）。

### 2.2 机械映射分两步，第二步才碰物理事实

`decideWorktreeIntent`（纯）：互斥（#6/#7）→ 复用查找（#8/#9）→ 缺省兜底（#1–#4）+ hint。
`decideWorktreeFacts`（纯）：`isRepo=false` → degrade（#5）；基线不存在 → reject（#11）；n≥2 无基线 → ask（#10）；
否则 create。这样 `task_create` 的顺序是：**先纯校验（失败不碰 git）→ 只在真要建时才 probe → 再落库**。

### 2.3 建树永远 `-b` 新分支；检出必须在仓库内

`git worktree add -b orch/<taskId> <repo>/.agents/worktrees/<taskId> <base>`：
- 直接检出「已在主工作树检出的基线」会被 git 拒绝，所以「以 X 为基线」= 从 X 起新建任务分支；
- 检出目录在仓库根内 → 子会话登记的可写根（`ensureWritableRoot(target_dir)`）覆盖它，`git commit` 写
  `<repo>/.git/worktrees/...` 也成立；
- `.agents/` 写 `.git/info/exclude`（幂等，不动用户 `.gitignore`；不可写只 warn）。

### 2.4 target 语义：检出目录 + 原 target 偏移

`targetOffset(repoRoot, brief.target)` 算出「用户 target 相对仓库根」的偏移，派发时 `target_dir = join(检出, 偏移)`
（子目录形态的仓库也能对上）。`task_detail` 对隔离任务优先用 `target_dir`（否则子会话会按 `brief.target` 去写用户工作树），
并额外给出「产物不在用户工作树、不要切分支/merge/push」。

### 2.5 清理与重派

- 清理只在终态异步跑，默认 `off`；`checkout-only` 只删检出；`full` 删分支，未合并提交时**保留分支 + 提示**
  （返回值带 `unmerged` / `hint`，日志留痕）；清理失败只记日志，不改任务终态。
- 重派（`task_retry` / 面板 retry）：原检出存在且没被清理 → `state='reused'`（不新建）；被清理/目录不见了 →
  按原 `repo_root` + `worktree_base` 重建（`state='requested'`）。

---

## 3. 改动文件

| 文件 | 变更 |
|---|---|
| `src/worktree.js` | **新增**：git 能力（`runGit`/`classifyGitFailure`/`createWorktreeService`）、路径数学（`checkoutPathFor`/`targetOffset`/`targetInCheckout`）、`prepareTaskWorktree`/`cleanupTaskWorktree`/`retryWorktreeOf`、`WORKTREE_DISPATCH_STATES` |
| `src/worktree-request.js` | **新增**：结构化请求解析、两步机械映射、复用查找、全部展示文案（状态行/列表标记/通知行/detail 说明/create 说明/多分支询问） |
| `src/ledger.js` | 七列 + 旧库逐列迁移；`taskOf` 归一；`createTask({worktree})`；`setTaskWorktree` / `setTaskTargetDir` |
| `src/config.js` | `worktreePolicy`（默认 auto）/ `worktreeBranchPrefix`（orch/）/ `worktreeRecentDays`（7，夹 1–90） |
| `index.js` | `renderWorktreePolicy` / `renderCoordinatorPolicy`（policy 模板化）；创建 worktree 服务；派发/工具/面板共享；终态清理钩子 |
| `src/tools.js` | `task_create` 五个 worktree 参数 + 互斥/复用/降级/询问/拒绝；`task_list` 标记；`task_status` 隔离行；`task_report` 通知带 worktree；`task_stop` 清理；`task_retry` 复用/重建 |
| `src/queue.js` | 派发前 `prepareTaskWorktree`；建树失败标 `failed` + 通知 + 依赖传播 |
| `src/notify.js` | `worktreeBlock`（单条/合并/打断三条路都渲染） |
| `src/settlement.js` | 结算通知带 `worktree` 块 |
| `src/task-detail.js` | 隔离任务的工作目录用检出目录 + 【worktree 隔离】说明 |
| `src/host-route.js` / `src/panel-actions.js` | snapshot / detail 下发 `worktreeState/Branch/Path/Base/Source`；面板 stop 触发清理；retry 复用检出 |
| `client/src/constants.js` / `views.js` | `WORKTREE_STATE_LABEL` / `WORKTREE_SOURCE_LABEL`；任务卡「隔离」小标 + 「隔离·…」chip、抽屉「隔离」行 |
| `dist/client.js(.map)` | vite 重建产物 |
| `test/worktree.test.js` / `test/worktree-request.test.js` | **新增** 44 条用例 |
| `README.md` / `docs/ARCHITECTURE.md` / `docs/LIMITATIONS.md` / `docs/qa-checklist.md` / `CHANGELOG.md` | 结构化声明、判断流程、互斥、清理、限制、复核矩阵 |

---

## 4. 验证

| 门禁 | 命令 | 结果 |
|---|---|---|
| 全量单测 | `npm test`（`pretest` 自动 `vite build`） | **717 / pass 717 / fail 0**（P8 后基线 672 → +45） |
| 本单新用例 | `node --test --experimental-test-isolation=none test/worktree.test.js test/worktree-request.test.js` | **45 / 45** |
| 客户端语法 | `npm run check:client` | 通过 |
| 客户端构建 | `npm run build` | 10 modules，产物与源码一致（`pretest` 内跑过） |
| 反向验证（v2） | `git grep worktree-policy` / 查 `AGENTS` 引用 | 无 policy 解析模块；`AGENTS` 只在注释与既有 `project_context` |
| 工作区卫生 | `git status` | 没有 `.agents/`（单测用临时目录，未在仓库建检出） |

用例覆盖（`test/worktree.test.js` 26 条 / `test/worktree-request.test.js` 19 条）：

1. 结构化参数：布尔/枚举/分支词法校验；`'true'`/`'auto'` 拒绝；相关字段隐式推定；
2. 机械映射 #1–#10：#1 不隔离、#2 配置兜底、#3/#4 hint 不拦、#6/#7 互斥、#8/#9 复用/拒绝、#10 多分支 ask；
3. 事实分档：n=0/1/≥2、基线不存在、非仓库降级、显式基线直接用；
4. 分支名默认/前缀/非法回落；复用检出查找（group / dependsOn / cleaned 不复用）；
5. 视图文案：状态行五态、列表标记、通知行、`task_detail` 说明、create 返回说明、多分支询问、清理三档文案、重派快照；
6. 配置归一 + 协调者 policy 渲染（含反向断言「不解析文件」「不跑 git」）；
7. fake git：probe 失败分类、分支统计与 `suggestedBase`、`worktree add -b` 参数、5 类建树失败、`classifyGitFailure` 顺序；
8. `ensureExcluded` 幂等且不碰 `.gitignore`；`remove` 三档（含未合并确认、目录已消失幂等）；
9. `targetOffset`/`targetInCheckout`；
10. 台账七列默认/落库/旧库迁移；
11. `prepareTaskWorktree`：建树后 target=检出+偏移、写 exclude；失败落 `failed`；reuse 不调 create；
12. 清理：off 不清理、`checkout-only` 落 `cleaned`、失败不影响终态；重派复用/重建；
13. `task_create` 集成：建树 + spawn cwd、降级、互斥、多分支不落库+重调、基线/分支拒绝、required 兜底与 hint、普通任务零 git、continue 复用；
14. 派发失败标 failed + 通知；`task_status`/`task_list`/通知视图；普通任务零隔离字样。

---

## 5. 真机待办（本单未执行，需装 profile 后逐条勾）

子代理会话没有平台 GUI / profile 安装权限；清单已写进 `docs/qa-checklist.md` §36.2：

| 场景 | 期望 |
|---|---|
| 单分支仓库 `worktree:true` | 真建出 `orch/<taskId>` 分支 + `<repo>/.agents/worktrees/<taskId>`；子会话在检出里写文件；`git status` 看不到 `.agents/` |
| 多分支仓库（近 7 天 ≥2 条）+ 不给基线 | 协调者收到候选并 `ask_user_question`；任务未创建；带 `worktreeBase` 重调后建树 |
| 非 git 目录 `worktree:true` | 降级普通模式 + 提示；任务不失败 |
| 宿主无 git / 路径已存在 / 分支重名 | 任务 `failed` + 可读分类；不静默降级 |
| `worktreePolicy:'required'` + 漏传 / 显式 false | 兜底建（来源 config）/ 不建 + hint |
| 项目 `AGENTS.md` 要求必须隔离 | DSH 注入 → 协调者传 `worktree:true` → 建树 |
| `readOnly/planFirst + worktree` | 创建期拒绝 |
| `worktreeMode:'continue'` | 复用原检出（不新建） |
| 清理三档 / 重派 | 与单测同口径；`git status` 干净 |

---

## 6. 与计划的偏差 / 遗留

1. **不发版 0.16.0**（T9.10 只做全量）：任务要求「npm test 全绿后本地提交不 push」；P6/P7/P8 的发版也还没做，
   版本号统一留在发布批次处理（`CHANGELOG.md` 记「未发布：P9」）。
2. **真机矩阵未执行**（§5）：需要装 profile / 重启 DSH，子代理会话不具备。
3. **`worktreeCleanup:'full'` 的确认语义**：计划写「有未合并提交要确认」，本单把「显式传 `full`」当作确认
   （API 层 `remove({confirm})` 仍保留 `confirm:false` → 保留分支 + 提示的路径，并用单测覆盖），
   未加面板二次确认弹窗——留作后续（`docs/LIMITATIONS.md` 已写明）。
4. **`planFirst + worktree` 在创建期拒绝**（v2 §4.5 #7）：计划批准后要隔离需重新派发；未实现「批准后补建检出」。
5. **`worktree_state` 多了一个 `requested`**：派发前的待建状态（计划列七列的枚举里没有，但台账需要区分
   「已请求、还没建」与「none」）；`task_status`/面板都按「待建检出」渲染。
6. **同一检出并发**：`worktreeMode:'continue'` 复用同一目录时只靠 `dependsOn` 串行（`writeScopes` 只提示不锁），
   与既有口径一致，已写进 LIMITATIONS。

---

## 7. 风险与边界（与计划 §R9–R22 对照）

| 风险 | 本单的落法 |
|---|---|
| R9 产物不在用户工作树 | 通知 / `task_status` / 面板 / README 四处写「分支 X / 检出 Y / 合并由你决定」 |
| R10 隔离让用户不知情 | 任务卡「隔离」小标 + 抽屉可复制路径 + 协调者 policy 要求回复写明 |
| R11 非仓库/无 git/建树失败处理不一致 | 映射表 #5（degrade）/ #13（failed）分明；失败不静默降级 |
| R12 复用同一检出被并发写 | `worktreeMode:'continue'` 返回文案 + LIMITATIONS 要求 `dependsOn` 串行 |
| R13 `already checked out` | 永远 `-b` 新分支（§4.4.3） |
| R19 协调者漏判/漏传 | 配置 `required` 兜底建（来源 `config` + 提示）；显式 false + required 给 hint；`task_status` 显示「决定 都没说」可发现 |
| R20 检出爆炸 | 默认 `off` 全保留但 README 推荐 `checkout-only`；只读/计划互斥在创建期拒绝 |
| R21 两处声明不一致 | 配置进 policy 文本、AGENTS 靠注入；冲突只给 `hint`，协调者按用户指引执行并在回复写明 |
| R22 多一次往返 | `needsBranchChoice` 不落库 + 固定「带 worktreeBase 重调」文案；任务不占并发位 |

---

## 8. 提交

- 本地提交：`feat(worktree): 子任务 worktree 隔离（T9.1–T9.10）`（`git log -1 --oneline` 可查），**未 push**。
- 未纳入：P0 阶段遗留的未跟踪探针文件（`docs/probes/**`、`reports/t0.1-probes.md`）不属于本单。
