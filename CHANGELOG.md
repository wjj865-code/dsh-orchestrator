# Changelog

## 未发布（2026-11-24）—— 任务引用人类友好展示（名字+chip）/ 协调者可加载技能判断派活 / 写域判定修复（隔离任务写根=检出）/ 镜像轮询缓存穿透 / manifest 只记 Git 视野路径 / worktree 分支名改约定式命名

**一句话**：这一批不含发版动作（**不 bump 版本**）：用户面不再出现 `t-xxxx`/光秃秃的 `tk-xxxxxx`——任务一律「名字 + 引用」，抽屉正文里的引用渲染成名字 chip；协调者仍不干活，但被明确允许按需加载技能来判断「怎么派活」（只读不执行）；此外写域判定把「隔离任务的写域」收成它那份检出、镜像状态判定改打版本端点并区分 unknown、Git 阶段清单只收 Git 视野内的路径、worktree 分支名改由协调者按约定式 `<type>/<slug>` 传入（必填，不再默认 `orch/<taskId>`）。

**任务引用人类友好展示（R1–R3，用户拍板：抬 164 KiB / task_detail 合成一行 / 通知标题带引用 / brief 补名字 / 面板两处都做）**
- `task_detail` 首行合成 `任务：名称（tk-xxxxxx）`（`src/task-detail.js`）：子会话第一次就同时拿到「怎么称呼」与「怎么调工具」，原来单列的「任务引用：」行删掉，`t-xxxx` 仍然一个字都不出现。
- 面板两处不再回落内部编号：抽屉依赖/下游行补 `ref`，缺失的前置显示「（任务已删除）」+ 墓碑引用而不是 4 位 `t-` 后缀（`src/panel-actions.js`）；自动化列表的 `refLabel` 改 `taskLabelWithRef`（`src/workbench.js`，客户端 `client/src/workbench.js` 读它）。
- 通知标题带引用（`src/notify.js` 的 `nameOf`）：`任务「名字（tk-xxx）」完成/已交付待确认`，`displayName` 里已有引用时不重复追加；`ref` 缺失（旧行）只写名字。
- brief 补任务名（`src/brief.js`）：`【任务引用】tk-xxx` 之后多一行 `【任务名】名称`（可选，2–4 行仍守 L2 预算），子会话第一句就能用名字汇报。
- L1 汇报口径补两句（`index.js`）：「**再次提到同一个任务只写名称**」「**不要只写 tk-xxxxxx**」，原来「只用任务名 + 任务引用」「不要出现 t-xxxx」两句照留。
- 抽屉正文里的引用 → 名字 chip（`client/src/logic.js` + `views.js` + `feed.js`）：新增纯函数 `splitTaskRefs`（严格形态、两侧边界断言，`tk-abc1234`/`x-tk-abc123` 不当引用）、`refDisplayOf`/`refSegmentsOf` 与 `RefText` 组件，覆盖「最新回复」「消息」两处；五种兜底各有实现与用例——重名（名字+引用）、改名过期（以台账现名为准）、长名（chip 截断、tooltip 全名）、查不到（原样显示引用）、已删除（引用置墓碑 → 原样显示 + 「引用已失效」）。详情新增只读 `refs` 索引（消息里出现过的引用 → 现名/墓碑状态）；回复底部 chip 的 tooltip 与 feed 快照也补 `ref`。
- 体积：`scripts/check-client-size.mjs`、`test/client-build.test.js:58`、`docs/testing.md` 的 G10 同步抬到 **164 KiB**（实测见下），`dist/client.js` 重建、`node --check` 通过。

**协调者可加载技能判断派活（R0，用户追加）**
- L1 新增一条通用许可（`index.js`）：协调者可以 `skill({ name })` 读技能说明来判断「该不该派、带什么约束、要不要建议用户走某个技能」——一次 1–2 个、只在摘要不足/匹配不确定时加载、能直接回答的不加载；**只读不执行**（加载技能 ≠ 按步骤干活，仍不写文件、不跑命令），读到的信息写进 `task_create` 的 goal/constraints 或汇报里点一句「这项可以走 X 技能」。技能目录（名称+摘要）由宿主注入上下文，协调者预设自 0.26.0 就挂着只读 `read` 与 `tool-skill`（`cordis.patch.yml:36/44-47`），此前 L1 只有 grill-me 一条触发语，没有通用许可。
- 没新增任何工具、没动 `MAIN_PERMISSION_PRESET` 的沙箱与审批；`src/prompt-layers.js` 的 L1 `owns` 登记这条职责。
- 文档：`docs/ARCHITECTURE.md`「协调者只读工具与 grill-me 技能」节补一句「可加载技能只为判断派活（只读不执行）」、`README.md` 的「只读总指挥」一句同步；**文档总行数仍 1799/1800**（同段内合并，不加行）。

**写域判定修复（隔离任务写根 = 检出）**
- 新增 `isolatedConflicts` 与单向包含 `pathWithin`（`src/write-guard.js`）：隔离任务（`requested`/`created`/`reused`）重新拿写根（resume / 追问 / retry / 派发）只判「同一份检出（含 `worktreeMode:'continue'` 复用）」与「别人写进我的检出」，**原 target 与 `writeScopes` 不参与**。
- 派发 chokepoint（`decideDispatchGrant`）与动作层（`decideRegrantGuard`）共用同一个判定函数（单源），口径不再分叉；检出被占的风险也写进 `concurrentRiskNote`。
- 修掉的误拦：检出天生在仓库根内（`<repo>/.agents/worktrees/<taskId>`），父子包含不是同一份工作树——仓库根任务在跑时，隔离任务的 resume/追问曾被判「同写域占用」拒绝。
- 文档：`README.md`、`docs/ARCHITECTURE.md`、`docs/LIMITATIONS.md` 同步；`docs/LIMITATIONS.md` 里「防护不覆盖 `retry`/`resume`」改为覆盖（都走 `write-gate` 同一次判定）。

**镜像轮询：版本端点 + 缓存穿透 + unknown 三态**
- `scripts/mirror-sync.mjs` 判「镜像有没有这个版本」只认版本端点 `GET /:name/:version`（200 / 404），每次请求叠 `?t=` 时间戳与 `no-cache` 头：packument 的 `dist-tags`/`versions` 走 CDN（`public, max-age=300`），刚同步完还会回旧内容，轮询会一直假阴性跑满预算。
- `probeVersion` 三态：`ready`（200）/ `absent`（404）/ `unknown`（5xx、429、网络错）。unknown **不冒充「缺版本」**：不 PUT、不触发同步；轮询遇 unknown 只记一行继续等服务恢复，`--check` 遇 unknown 如实报「镜像状态未知」并 exit 1。
- `.github/workflows/release.yml` 的轮询同样改打版本端点看 HTTP 码（200 即就绪），单请求 5s 连接 / 10s 总超时，非 200 只记日志继续，跑满 180s 才 warning（仍 `continue-on-error`）；`docs/CONTRIBUTING.md`、`docs/testing.md` 的 `mirror:check` 口径同步。

**manifest 只记 Git 视野内的路径**
- `src/artifact-stage.js` 的 Git 模式不再跑 `git status --ignored`：改用 `git ls-files -z --cached --others --exclude-standard -- :(literal)<path>`（50 条一批）精确问出「tracked 或未跟踪未忽略」，`files[]` 只留这些路径——`node_modules/`、`.pnpm/`、`dist/` 这类被 ignore 的树既不进清单，也不再让「只有 ignore 文件在工作」的仓库被标成未归档。
- `.git` 内 / repo 外 / 被 ignore / 已删除的候选写进 `stage.excluded` 并带原因（`inside-git-dir` / `outside-repo` / `ignored` / `missing-or-deleted`）；批量核验失败记 `git.ignoreProbe='failed'`，不假装过滤过；产物库目录里的文件先剔掉、不参与 ignore 询问。
- `docs/ARCHITECTURE.md` 的产物一节写明新口径。

**worktree 分支名改约定式命名（`<type>/<slug>`，必填）**
- `task_create.worktreeBranch` 改为**必填**（凡是要新建检出）：形态 `<type>/<slug>`，type 11 类白名单 `feat|fix|docs|refactor|chore|test|perf|build|ci|style|revert`，slug 为小写 ASCII kebab（1–40 字符、单词间单个 `-`）。没传 → `BRANCH_REQUIRED`，不合规 → 词法拒绝，都在**创建期**报错、不落库、不碰 git；错误文案带白名单 + 正例 `feat/login-retry` + 反例 `orch/t-1a2b3c4d`。
- 删掉整套写死的默认名：`DEFAULT_BRANCH_PREFIX` / `branchNameFor` 移除，台账里的分支名就是协调者传的那个。`worktreeMode:'continue'`（复用检出）、`worktree:false` 与普通任务不受影响；`worktreePolicy=required` 也只决定「要不要隔离」，**不包办名字**（漏传同样拒绝）。
- 配置键 `worktreeBranchPrefix` 删除并进 `DEPRECATED_KEYS`（老 profile 读到给一条弃用警告、值不回填）：配置面 25 → 24 键，客户端配置页少一行。
- 重派被清理过的隔离任务沿用**台账原分支名**重建（`retryWorktreeOf` 不再返回空分支名）；`prepareTaskWorktree` 里的 `orch/<taskId>` 只留作 0.34 及更早台账里空分支行的 legacy 兜底。既有 `orch/*` 分支照旧可见/可复用/可清理，只是不再产生新名字。
- L1 提示词 worktree 段改写：首行 `分支命名：<type>/<slug>（必填，由你传）`，required/auto/off 三条与步骤 4 都要求协调者传 `worktreeBranch`，不再出现「分支名默认 `orch/<taskId>`」。
- 文档：`README.md`、`docs/CONFIG.md`、`docs/ARCHITECTURE.md`、`docs/LIMITATIONS.md`、`docs/testing.md`、`docs/compat.md` 同步。

**边界与验证**
- 不含发版动作：**不 bump `package.json` version、不 push、不打 tag、不 publish、不删分支**。
- 验证：`test/write-guard.test.js`、`test/write-gate.test.js`、`test/write-hold.test.js`、`test/artifact-stage.test.js`、`test/mirror-sync.test.js`、`test/worktree.test.js`、`test/worktree-request.test.js`、`test/access-full.test.js`、`test/config*.test.js`、`test/client-config-form.test.js` 全绿；`node scripts/check-docs.mjs`（1799/1800、配置参考 24 键）与 `pnpm run check:version` 通过；客户端只少一行字段投影 → `dist/client.js` 重建、`check:client-size` 通过。
- 本批（引用展示）追加验证：全量 `node --test --experimental-test-isolation=none "test/*.test.js"` **1475 项 / 0 fail / 5 skip**；`test/client.test.js`（`splitTaskRefs` 切段 + 五种兜底 + 抽屉两处渲染）、`test/client-build.test.js`（`__test` 出口与 164 KiB）、`test/task-detail.test.js`、`test/panel-actions.test.js`、`test/workbench.test.js`、`test/notify.test.js`、`test/brief.test.js`、`test/prompt-layers.test.js`（L1 技能许可）、`test/plan-save.test.js` 同步；`dist/client.js` 重建后 **165,597 B / 167,936 B（余 2,339 B）**、`node --check` 通过；`check:docs` 1799/1800、`check:version` 未 bump。

## 0.34.0（2026-11-24）—— 任务私有产物存储 / Git 与非 Git 阶段收集 / 收集后交付

- 分离工作目录、冲突声明 `writeScopes` 与产物存储：主会话 `artifacts/<taskId>` 仅暂存/引用，宿主私有 `artifact-store/<taskId>` 保存稳定文档与快照；历史路径不搬移，删除任务保留文件。
- 新增 worker 专用 `artifact_save`，计划保存复用版本化、调用重放幂等的宿主保存实现；只读任务也可保存文档，不因此授予工作区写权限。
- `task_report` 新增 `checkpoint`、`changedFiles`：非 Git 保存已捕获普通文件，Git 记录引用与未归档状态，不自动复制代码；拒绝、缺失、摘要缺口、截断和失败写入清单。
- `done` 验收通过后记录待交付并收紧工作权限；回合结束统一保存最终阶段后才结算、释放占用和放行下游。不完整非 Git/unknown 不自动 chain；未归档 Git 内容、不完整收集阻止不安全清理。
- SQLite 增量新增产物目录、私有存储目录、待交付请求及阶段记录；工具数由 11 增至 12，无新增依赖或配置开关。面板与详情展示真源、收集结果及待交付信息。
- 边界：当前 DSH worker 无自动工作摘要，需显式 `changedFiles`，仍保守标记覆盖缺口；不提供完整历史或全工作区备份。完整访问、外部进程及历史文件不保证防覆盖。
- 验证：完整模块测试 1450 通过、0 失败、3 个 Windows 专属跳过；隔离 DSH Web profile 与无头 Chrome 验证私有存储文件/shell 防覆盖、只读文档保存、快照与预览。用户明确保留 [验证报告](reports/task-artifact-web-verification.md)，作为本次仓库产物保留例外，报告与探针不随 npm 包发布。
- 升级后彻底退出 DSH 再启动；`done` 回执现在表示待交付请求，不代表已释放工作占用。

## 0.33.1（2026-11-23）—— 写域判定下沉到可写根授予 / approve 只记账 / 三条审计 P0（同 cwd、批准前注册、只读重放）

**一句话**：0.33.0 发布后又按「护栏被绕过」审了一遍写域路径，把派发 / 续派 / 面板追加的写权限判定收到**一个入口**（新增 `src/write-gate.js`，`dispatch.grantWritableRoot` 成为唯一 `registerWritableRoot` 调用点），并补上审计出的三条 P0：① 已批准计划任务的 target 恰等于会话 cwd（或没 target 继承父 cwd）时，平台根捷径在 append `workspace-write` 之前就早退，任务标了 granted 却仍只读；② 未批准计划任务与只读任务的续派 / 面板「追加」会先注册可写根；③ 只读任务的 `messageId` / `attemptKey` 重放会顺手补授写权限。**不新增配置键、工具面仍 11 个、状态机与台账 schema 零改动**（`plan_state` 六值、`accepted_kind` 枚举都不动）。

**写域判定下沉（写根授予 + 内存占用）**
- 新增 `src/write-hold.js`：占位按 owner token（`tool:<callId>` / `panel:<requestId>`）**引用计数**，工具与面板互不覆盖；TTL 过期剔除 + 30s 心跳续期；只有路径重叠才合并视图（`C:\a\b` + `C:\a\c` 并列，不误拦 `C:\a\d`）；`tasksWithHolds` 按视图逐条合并台账行。
- 新增 `src/write-gate.js`：动作层统一判定入口（`decideDispatchGrant` / `decideFollowupGuard` / `decideRegrantGuard` / `decideCreate`），登记表覆盖六个写权限动作，approve **不在登记表**（批准只记账）；`isolated` 只看 `worktree_path`，`dependsOn` 串行共享检出放行；`ensureWritableRoot` 加 phase（post-send no-session 诚实失败，不假装切了沙箱）。
- 动作层不再直接 import 判定函数（静态断言 S3'）；`activeWriteHolds(` 只在 `write-gate` 里被调用（S4）；stop / close / 终态必带 token 释放（S6、S10'）。

**approve 只记账、投递即记账（P0-4 补强）**
- `plan-mode` 的 approve 改为 `recordApproval`：不投递、不碰沙箱、不调 dispatcher；已批准再批走 `retryPlanGrant`；续派前切沙箱改由 `needsPlanWriteSwitch` 判定。
- `dispatch.send` 第 9 参带 `planApproved` / `messageId` / `attemptKey`，post-send 整段 try/catch；`sendReliable` 的「已投递」标记改由 `send` 在 `sendMessage` 成功那一刻回调 `onDelivered` 置位——旧实现「`await send` 之后才置位」，catch 里恒为 false，等于没有保护。

**审计 3 个 P0（`afe78fa`）**
- **同 cwd 可写**：`grantApprovedWrite` 把 append `workspace-write` 挪到「平台根 == target」捷径**之前**——平台根只意味着不用注册可写根，不等于沙箱已可写。
- **批准前不注册可写根**：只读任务与未批准计划任务（`planning` / `waiting_user` / `revising` / `rejected` / `none`）的 followup / resume / 面板「追加」统一走 `dispatchReadOnly`，不再进 `ensureWritableRoot`。
- **只读重放不授予**：`messageId` / `attemptKey` 命中的重放改走 `replayGrant`——只读与未批准计划任务一律不 append、不注册、不留 `planWrite` 幽灵行；已批准计划任务仍走 `retryPlanGrant`。
- 面板与 hold：借条行（`addMessage`）先落、hold 后占，抛错不再泄漏 hold 与 30s 心跳；面板无 `sendReliable` 的回退带全参数（不丢 `targetDir` / `readOnly` / `attemptKey`）；`isWriteHeld` 过期剔除后返回 false（旧实现删空仍 return true，多误判一次）。
- 文档：`docs/CONTRIBUTING.md` 记本机 npm token 失效（`npm whoami` → E401），发版只走 tag 触发 `release.yml`。
- 验证：`test/write-gate.test.js`（S1–S12 静态断言 + 派发判定行为）、`test/write-hold.test.js`（引用计数 / TTL / 并列视图 / 台账行合并）、`test/dispatch.test.js`（三条审计 P0 各一个可复现用例 + `sendReliable` 已投递行为）、`test/plan-mode.test.js`（approve 只记账 + 前置四种拒绝）。

**验证**：`pnpm test` **1,438 项（1,433 pass / 0 fail / 5 skip）**；`dist/client.js` 163,629 B / 163,840 B（余 211 B，客户端改动为零）；`check:docs` 1,800 / 1,800 行；`check:version` 0.33.1 三处一致（README 全部点位 / CHANGELOG 首条 / `package.json.files`）。

**升级注意**：装新版后**彻底退出 DSH 再启动**（刷新页面不换版本）。0.33.0 已发布且不可覆盖，本版是它的补丁版：行为面只**收紧**写权限判定（同 cwd / 批准前 / 重放不再授予），工具面、配置键、状态机与台账 schema 与 0.33.0 一致。

## 0.33.0（2026-11-23）—— 三条 P0 护栏 / 子会话工具失败监听 / W1 权限失败必报 / P0-4 显式批准 / chain:auto

**一句话**：这一版把三条「护栏被绕过」的 P0 一并修掉（`delivered` 交付即释放写根、结算落 `delivered` 前必须有本轮验收证据、`worktreeMode:'continue'` 复用检出先判占用），并集中发布三件编排面改动：① 子会话被权限/沙箱拒绝不再从编排面消失（新增 `tools/result` 观察者 + 10 分钟去重告警，W1 per-turn policy 同步加一句「权限/环境失败必须写进回报」）；② 计划批准改成唯一显式动作 `task_message({ action: 'approve' })`（P0-4），普通 `message` 不再批准；③ 任务链新增显式约定标记 `chain: 'auto'`，有 `waiting_dep` 下游时交付即收成 `done`。**不新增配置键、工具面仍 11 个、状态机零改动**（`delivered → done` 是既有边，只多一个触发条件；台账 schema 只多 `accepted_kind` 的枚举值与 brief 里的 `chain` 字段，**无新列、无迁移**）。

**P0 修复（三条）：交付即释放写根 / 结算验收闸门 / 复用检出占用**

**一句话**：修三条「护栏被绕过」的 P0——① `delivered` 交付即释放写根、退出同写域判定，追问回 `running` 前复判写域（被占用返回 `MESSAGE_WRITE_CONFLICT`，面板与工具同口径）；② 配了 `checks` 的任务自然结束（`completed`）不再绕过验收：结算落 `delivered` 前必须有本轮通过证据（`acceptance.ok` 且 `attempts` 匹配），否则落 `failed` 并写明原因；③ `worktreeMode:'continue'` 复用检出前按 `worktree_path` 判活跃占用，冲突拒绝并给「`dependsOn` 串行 / `worktreeMode:'new'` 新建」两条路。
- 不新增配置开关；两段式交付、状态机与台账 schema 不动；`retry` / `resume` 的写域复判仍不在本批（见 `docs/LIMITATIONS.md`）。
- 验证：`test/write-guard.test.js` / `test/settlement.test.js` / `test/worktree.test.js` 的集成用例（真实台账 + 队列，仅 dispatcher 打桩）。

**子会话工具失败监听（`tools/result` 观察者 + 10 分钟去重告警）**

**一句话**：子会话被权限/沙箱拒绝时，协调者原本只拿得到 `task_report` 的 summary，这条事实在编排面上会消失：新增 `src/child-tool-failure.js` 订阅宿主 `tools/result`（只观察、不改结果），按「结构化 `error.info.code` → `sandbox.denied` → `pwsh`/`bash` stderr 文本」三通道判定，**不要求退出码非零**；`denied` 类走 notifier 并按 `(taskId, tool, code)` **10 分钟去重**告警，env 类（命令找不到、依赖缺失、沙箱/runner 起不来）只写日志。
- 归属与打断：`workerTaskOf(exec.agent.id)` 认出任务，协调者自身调用与非任务会话直接丢弃，只有任务还在 followup 状态集合才打断协调者。告警文案 `toolFailureNotice`（`src/copy.js`，NOTIFY 层唯一措辞）：一行事实（工具 + code + 沙箱模式）→ 一行归属（任务名 + `tk-` 引用 + 脱敏后的证据首行）→ 一行动作（判断缺 `sandbox_permissions` / 该给 `access:'full'` / 改派或回落，别让它重试同一条命令）。
- 边界：外部子会话与文本误判写进 `docs/LIMITATIONS.md`；`docs/ARCHITECTURE.md` 补一节、`docs/testing.md` 补验收路径。
- 验证：`test/child-tool-failure.test.js`（三通道判定 / 去重窗口 / 归属丢弃 / 状态集合门控）、`test/index.test.js`（观察者接线，协调者自身调用不告警）。

**W1 新增一句：权限/环境失败必须写进回报**

**一句话**：W1 per-turn policy 由固定五句变六句，新增 `WORKER_PERMISSION_HINT`——遇到权限/沙箱/审批拒绝或环境失败（命令找不到、依赖缺失、沙箱/runner 起不来）不要只当普通报错：能自己用窄一级的 `sandbox_permissions` + `justification` 重试一次就重试一次；仍不行就在 `task_report` 的 summary 里写明「哪条命令、什么 code/提示、试过什么」，交付 `done` 时同样必须写。
- 句子只在 `src/copy.js` 定义一次，`src/prompt-layers.js` 只负责分层归属与渲染顺序；L2 文案层禁止重复该口径（`layerViolations` 兜住）。
- 验证：`test/prompt-layers.test.js`（六句逐字同源 + L2 探针）。

**P0-4：计划批准改为显式动作（`task_message({ action: 'approve' })`）**

**一句话**：计划批准不再是「任何 `task_message` 投递成功 = 批准」的软门禁——普通 `message` 在计划任务上只记讨论（`planning`）或把它转「修订中」（`waiting_user`/`revising`），沙箱始终只读；批准只能显式 `task_message({ action: 'approve' })`，前置为「收到过 blocked 报告（`plan_state='waiting_user'`）+ 子会话停在等你确认 + 计划文档已落盘」，成功切回可写并落审批审计（复用 `accepted_by`/`accepted_at`，新增 `accepted_kind='plan'`；交付确认仍记 `delivery`），**不投递消息**——协调者随后 `task_message` 续派实现。`plan_state` 从四值扩成六值（`none`/`planning`/`waiting_user`/`revising`/`approved`/`rejected`），未批准进终态（含 `delivered`）统一收口 `rejected`；升级时旧库把「`planning` + 等确认」的行幂等回填成 `waiting_user`。面板**不加**批准入口（`plan-approve` 仍是 `UNKNOWN_ENDPOINT` 反例清单），面板 `message` 与工具同口径只是不批准、不改 `plan_state`；无新配置开关、工具面仍 11 个、两段式交付语义未动。
- 验证：`test/plan-mode.test.js`（message 不批准 / approve 前置四种拒绝 / 审批审计 / 幂等 / 四态收口 / 旧库回填）、`test/contract-snapshot.test.js`（enum 加 `approve`、任务行加 `accepted_kind`）、`test/interaction-policy.test.js`（L1「批准是显式动作」）、`test/status-property.test.js`（未批准三态都只读）。
- 该片未跑 `pnpm run build` / 未提交：`dist/client.js` 的重建、`check:client-size` 与 commit 由后续全权限任务完成（0.33.0 发布提交已包含）。

**链式自动放行（`task_create({ chain: 'auto' })`）**

**一句话**：给任务链加一个**显式约定标记** `chain: 'auto'`（只进 `brief` 快照，**不加 DB 列、不做迁移**）：带标记的任务交付（落「已交付待确认」）时，若台账里仍有 `waiting_dep` 的下游依赖它，交付钩子在**同一同步段**复用既有 `closeDelivered` 收成 `done`（`accepted_by='chain'`、`accepted_kind='delivery'`、`close_reason='chain'`），下游仍由 `queue.pump()` 开头的 `promoteDependents` 自动晋升。没有下游 = 保持「已交付待确认」（不猜将来会不会建下游）；**不带标记的链一个字节都不变**（仍等确认/超时）。自动放行的确认人不是人，官方 Team 板**不反写**（与超时同口径，只记 `team.board.skipped{reason:'chain'}`）；通知与子会话回执改「已完成」口径；`done` 不能追问/续跑（要改只能 `retry`）。状态机零改动（`delivered → done` 是既有边，只多一个触发条件），没有新配置键、工具面仍 11 个，P0-4 的计划批准路径一行未动。
- 验证：`test/chain-auto.test.js`（14 条：参数/落点无新列、门控四态、task_report 与结算两条交付路径、无下游/无标记默认不变、幂等与 sweeper 互斥、只读/计划/Team 板边界）、`test/delivered.test.js`（`by=chain` 落库与审计）、`test/handoff.test.js`（第四种 `acceptedBy` 与事件）、`test/resume.test.js`（`close_reason=chain` 等同确认过）、`test/team-board.test.js`（不反写）、`test/contract-snapshot.test.js`（schema 加 `chain`）、`test/client.test.js`（面板标签）、`test/task-chain-policy.test.js` / `test/prompt-layers.test.js`（L1 段落与文案单源）；`node scripts/check-docs.mjs` **1800 / 1800**（行内改写 + 1 增 1 删，预算未抬）。
- 收尾：已 `pnpm run build` 重建 `dist/client.js` 并随源码一并提交（该片提交时未 push / 未打 tag / 未 bump，随 0.33.0 一并发布）；该轮全量 `pnpm test` 1397 tests / 1392 pass / 0 fail / 5 skipped，`check:docs` 1800/1800。

**验证**：`pnpm test` **1,397 项（1,392 pass / 0 fail / 5 skip）**；`dist/client.js` 163,629 B / 163,840 B（余 211 B）；`check:docs` 1,800 / 1,800 行；`check:version` 0.33.0 三处一致（README 全部点位 / CHANGELOG 首条 / `package.json.files`）。

**升级注意**：装新版后**彻底退出 DSH 再启动**（刷新页面不换版本）。`chain: 'auto'` 是可选标记，不写的链行为与 0.32.1 完全一致；计划批准从「任何 `task_message` = 批准」改成显式 `action:'approve'`，旧习惯的「投递即批准」会失效（普通 `message` 只记讨论或转「修订中」）；旧库升级时「`planning` + 等确认」的行幂等回填成 `waiting_user`，无需手工迁移。

## 0.32.1（2026-11-22）——兼容声明（下限 rc.2）/ 任务 ID 出口网关 / 拍板流程 / 界面与文档收口

**一句话**：这一版把「宿主兼容声明」接进正式闸门（`engines.dsh = ">=0.2.2-rc.2 <0.3.0-0"`，区间外拒装 / 启动禁用），并集中发布三件事：任务引用改成 `tk-xxxxxx`（用户面不再出现台账内部编号 `t-xxxx`）、计划批准改成「逐项确认 → 总批准」、界面入口按角色显示 + 自动化改为会话内创建 + 排期页按状态派生分组。**不改派发语义**（计划批准、两段式交付、依赖链、写域、权限模型都不动），全局工具仍是 11 个、配置键仍是 25 个。

**兼容声明（本版重点）**
- `package.json` 新增 `engines.dsh = ">=0.2.2-rc.2 <0.3.0-0"`；宿主 rc.5 的 `app-boot` 在装载插件前按它做**硬预检**：区间外安装侧在 pnpm 之前拒装（`incompatible-version`）、启动侧打 `disabling profile plugin …` 并禁用该行，不是只 warn。要越界跑只能给 profile 的 `compatibility.json` 精确豁免（`dsh plugin allow-version`）。
- **下限从 rc.3 下调到 rc.2**（用户拍板）：rc.2 起 `startActivation` 已是扁平 spec，按基线内放行；**rc.1 及更早**是 `request` 包装形状，契约未按 rc.1 验证，**不声明兼容**（派发仍保留旧包装回退，但不计入声明区间）。
- 上界保持 `<0.3.0-0`：`includePrerelease` 下连 `0.3.0-rc.1` 这类预览也拒；`0.2.2` 正式版放行。内置「公众号文章」包的 `hostBaseline` 同步为同一区间。
- 已发布过的旧版本（≤ `0.32.0`）没有该字段，宿主不做预检；声明从本版起生效。

**任务 ID 出口网关（版本 B）**
- 新增 `task_refs` 表与 `tk-` + 6 位引用（字母表去掉易混的 `0/1/l/o/i`）；`task_create` 与任务行同事务生成，旧台账打开时幂等回填，删除任务置墓碑且**永不复用**。
- 五个 `task_*` 与 `plan_save` 统一走 `resolveTaskInput`：**先 `t-xxxx`、未命中再 `tk-`**；空值/未知/已失效都给可读报错。`task_create.dependsOn` 同样接受两种值并归一成台账 id。
- 工具输出结构不变、只把引用值换成 `tk-`（`test/contract-snapshot.test.js` 冻结 schema 与回执行结构）；面板、详情抽屉、工作台只显示「任务名 + 引用」。
- 计划文档**文件名 = 任务名**（NFC / 删控制符 / 非法字符与空白换 `-` / Windows 保留名 / stem ≤ 60 / 路径 ≤ 240 / 同名 `-2` / 二次落盘覆写原文），`tasks.plan_path` 记幂等依据；改任务名不迁移、删任务不删文件。
- 写入前的出口清洗（`src/user-facing.js`）覆盖标题、summary、question、options、产物 label 与计划正文，**只替换台账已知编号**；真实路径、台账/日志/交接文件不动。

**拍板流程（版本 A，只改提示词/文案）**：L1 新增「拍板流程」段——一项一问、不合成总体确认、用问题原文不用代号；计划批准改为四选一「逐项确认 / 均按推荐 / 先看计划文档 / 放弃」（「均按推荐」必须用户明确点选）；blocked 通知带「待拍板 N 项」；新增 `renderDecisionSummary`。`plan_save` 参数面不变（仍只有 `task_id` / `content`），不做文档解析或校验。

**并行策略**：L1 新增「并行策略」段——互不依赖、无需复用同一子会话上下文、同写域会撞车三条同时满足时才优先 `worktree: true` 隔离并行，不把无依赖任务串成 `dependsOn` 链；只有「有依赖」或「要复用同一子会话上下文 / 同一检出」才串行。派发、队列、写域判定与客户端零改动。

**界面**：会话头入口按角色渲染（`main` → 「任务」、`adopt` → 「设为协调者」、子智能体 → 不渲染）；自动化面板删掉自定义表单，改为「创建自动化」按钮 → 主会话预填提示词、由宿主原生 `schedule_create` 创建；排期页右栏改为按状态派生的三组（待排期 / 进行中 / 待确认），不改状态机与拖拽语义；侧栏「主会话」「能力包」入口图标改为按宿主 `size` 绘制的内联 SVG，与官方项同盒同中线。

**文档**：README 面向使用者重写（422 → 186 行：定位 / 适用场景 / 安装 / 3 分钟上手 / 核心功能 / 常用配置 / 常见问题 / 安全边界 / 迁移映射 / 文档索引）；参考表下沉到 `docs/CONFIG.md`（25 个配置键）与 `docs/TOOLS.md`（11 个工具及角色差异）；`check-docs` 改为断言两份参考表与代码同源；验收口径明确「Desktop 是开发与安装面，自动化验收走 Web 测试 profile」。

**修复**
- Windows 上 checks 的 `pnpm`/`npm`/`npx` 现在按 `PATH × PATHEXT` 解析到 `.cmd` 并经 `ComSpec` 执行，不再因裸名字 `ENOENT` 被 `skipIfMissing` 静默记成「跳过」；参数含双引号/控制字符直接判失败（不做整串拼接）。
- `delivered` 通知补齐任务引用：结算路径（子会话自然结束）与多条批量合并都不再渲染出 `task_id: ''` 或 `<任务引用>` 占位符，close 示例逐条给 `tk-` 引用。
- `workspace-index` 在 git spawn 被禁（EPERM）时回退到读 `.git` 目录，仍能报出真实仓库状态（外部 PR #1）。
- 测试侧去掉 POSIX `mkdir -p` 依赖，Windows 本机也能跑完整套件。

**验证**：`pnpm test` **1,344 项（1,339 pass / 0 fail / 5 skip）**；`dist/client.js` 163,187 B / 163,840 B；`check:docs` 1,794 / 1,800 行；`check:version` 0.32.1 三处一致。

**升级注意**：装新版后**彻底退出 DSH 再启动**（刷新页面不换版本）。旧 `t-xxxx` 引用仍可继续用；历史计划文档文件名不迁移；rc.1 及更早宿主不在声明区间内。0.32.0 条目里标注「同版新增」的拍板流程 / ID 网关 / 并行策略，其 tag 早于这些提交，对外首次可见即本版。

## 0.32.0（2026-11-21）——能力包（工厂 MVP + 内置公众号包）：P0 GO → P1–P6

**一句话**：新增「能力包」——预设 + 技能 + 可选 CLI（文颜）+ 环境变量声明的成套能力；内置「公众号文章」包（写作 → 排版 → **建草稿**，不做群发），协调者可用 `capability_pack` 生成/删除用户包，侧栏新增「能力包」面板。**不改派发语义**（计划批准 / 两段式交付 / 依赖链 / 写域 / 权限模型一律不动）；能力包会话是普通根会话，不写台账、不进队列。

**阶段与 commit**（本仓库 `git log`）：

| 阶段 | commit | 内容 |
|---|---|---|
| P0 门禁 | `31f3412` | 真机探针 `docs/probes/capability-pack-probe.mjs` + `reports/pack-spike.md`：运行时预设注册/技能/开会话/撤销 **7/7 PASS**；文颜 2.0.12 在宿主 Node（Electron-as-node v24.21.0）`--version`/`render` 通过；安装体量实测（259 包 / ≈184 MiB / 冷装≈4分04秒 / 0 钩子） |
| P1 | `8b5f560` | `src/pack/{manifest,registry,store}.js`：schemaVersion 2 校验、原子写、`.trash` 回退、路径不越界、env 只声明不落值、install/health 状态 |
| P2 | `18ee091` | `packs/wechat-mp-article/**`（3 技能 + references）、`preset-template.js`（禁 `task_*`/`plan_save`/`capability_pack`）、`preset-registry.js`（运行时注册 + 静态兜底）、Desktop 判定、`capabilityPacks*` 三配置 |
| P3 | `0b3640a` | `capability_pack` 工具（list/describe/create/update/delete/open/install/uninstall/health/export-static）、生成器、安装器（argv 白名单/确认卡/planHash/版本校验/realpath 入口/render 冒烟/失败清理）、env 服务、健康检查、面板服务端窄写口 |
| P4 | `5b862b1` | 能力包面板（侧栏入口 + 包卡 + 安装确认卡 + EnvVarsCard）、`pack-*` 路由（409/404 映射、clientRequestId 幂等）、客户端预算 **148 → 160 KiB**（实测 163,430 B / 余 410 B） |
| P5 | `5fec406` | `src/pack/wenyan.js`（render 落文件 / publish 解析 Media ID / 错误映射 / 冒烟 / 草稿记账 / 重复建草稿确认）；安装器装后 render 冒烟；删包被 Windows watcher 挡住时「撤预设 + 目录延后清理」 |
| P6 | 本提交 | 文档收口（README 能力包一节、ARCHITECTURE、LIMITATIONS、本 CHANGELOG）、真机验收探针与报告、0.32.0 |

**新增工具**：`capability_pack`（协调者专用；worker 与包会话由 preset-tools deny）。创建流程固定：`dry-run（不带 confirm）→ 看文件树/预设行/安装卡 → confirm:true + clientRequestId`。工具数 10 → 11（协调者可见 8）。

**安全与边界**（都有单测）：

- 文颜 `@wenyan-md/cli@2.0.12` 懒装到 `capability-packs/tools/<id>`：精确版本 + registry 白名单 + `--ignore-scripts` + `--ignore-workspace`；装后校验版本、`realpathSync.native()` 解析入口（pnpm junction 直接跑会 `ERR_MODULE_NOT_FOUND`）、`--version` + `render` 冒烟。
- 运行期 `APPDATA`/`LOCALAPPDATA` 重定向到包内 `.state/wenyan`（文颜 token 不落用户目录）。
- 凭据只认 `WECHAT_APP_ID`/`WECHAT_APP_SECRET`：插件不落盘、不读值、不回显；`setx` 默认只生成可复制命令，执行需二次确认且只回 `{ok, code}`。
- 只做草稿箱：不调发布/群发接口；`publish` 无幂等，重复执行前必须问用户（`out/draft.json` 记 Media ID）。
- Desktop-only；Web 下工具返回 `PLATFORM_UNSUPPORTED`（`capabilityPacksAllowOnWeb=true` 才放开）。

**配置面 22 → 25**：`capabilityPacks`（总开关）、`capabilityPacksPanel`（面板入口）、`capabilityPacksAllowOnWeb`（Web 覆盖）。

**门禁**：`pnpm test`（build + `check:client-size` 160 KiB + `check:docs`）全绿；客户端 163,430 B / 163,840 B；`check:version`、`check:docs` 通过。新增用例：manifest（22）、store/registry、预设模板/注册、生成器、安装器（argv/确认/版本复用/升级/失败回退/冒烟）、服务闸门（dry-run/幂等/回滚/只读内置/开包会话/env 不落值）、路由、文颜封装、客户端契约。

**真机验收（隔离 `DSH_HOME` + 临时 profile）**：`docs/probes/capability-pack-acceptance.mjs` **24/24 PASS**——建用户包 → 预设可见 → 开包会话 → 2 技能可见 → env 降级路径 → 文颜懒装（102 秒，pnpm store 命中；冷装实测 ≈4 分 04 秒）→ `render` 695 B HTML（含 `<section>`）→ 删包预设消失；零 error 日志、零凭据泄漏（宿主进程带 `WECHAT_APP_SECRET` 哨兵值扫描状态/工作/profile 目录均未命中）。详见 `reports/pack-acceptance.md`。

**未验 / 明确不做**：真实公众号 `publish` 联调（需测试号 + IP 白名单，未做）；宿主 UI 预设选择器的刷新时机（P0 未验项）；Web 分支的安装执行（v1 只在 Windows 执行）；不做群发/发布、不做 server 模式、不自研渲染、不自动升级 CLI、不 vendor 二进制、不写 PATH。

**同版修复（t-8a81264c，2026-11-21）—— 开包会话 `sessions.retain: unknown session`**：`pack-open` 的结果走 HTTP、新会话的目录行走 WebSocket（`api-session/added`），宿主 `sessions.retain()` 只认已进客户端会话目录的 id，所以「建好就立刻切过去」会偶发未知会话。客户端改成短退避重试 4 次（≈1.2 秒，`client/src/open-session.js`），仍失败就给「已建好（session-xxx），但打不开：<原因>。请从左侧列表打开。」的可读降级（不重试创建、不吞错）。同时 `open` 先用 `workspaceRegistry.resolveByPath(cwd)` 找目标目录所属工作区、找到就传 `workspaceId`（宿主只在该分支 `attachSession`；只给 `cwd` 的会话会落「未分组」、UI 只显示「选择一个工作区开始」），找不到才退回 `cwd`，不自动建工作区。真机复现/验收：`reports/pack-open-fix.md`。

**同版新增（t-1ab20748，2026-11-22，拍板流程优化 · 版本 A，只改提示词/文案）**：把「拍板」从「一次总批准」改成「逐项确认 → 总批准核对」。①L1 新增「拍板流程」段（一项一问、不合成总体确认、用问题原文不用代号、依赖分批且独立项可同批连续问、计划审批先逐项或均按推荐再总批准）；②计划批准改四选一「逐项确认 / 均按推荐 / 先看计划文档 / 放弃」，「均按推荐」必须用户明确点选（协调者不得默认）；③blocked 通知带「待拍板 N 项，逐项提问，不要合并成一个总批准」（N 由通知层从 question 的「待拍板：」条目行数粗算，不是文档解析、不做校验）；④新增 `renderDecisionSummary`（`问句原文 → 选择`，按提问顺序）；⑤回执「子会话」字段保留会话 id（用户拍板，不改成「面板可打开」）。**明确不做工具层改造**：`plan_save` 仍是 `task_id` / `content` 两个参数，正文原样落盘——不解析正文、不渲染 `## 待拍板` 段、不校验文档格式、不存待拍板元数据（中途试过的 `pendingItems` 结构化参数、`parsePendingItems` 文档 lint、`plan_pending_json` 台账列在提交前全部撤掉，最终方案没有 schema 变化）。不改派发语义、不 bump 版本。测试：`test/decision-flow.test.js`（决策汇总顺序 / blocked 通知措辞 / plan_save 参数面未变 / 会话 id）+ `test/interaction-policy.test.js`（五条规则 + 四选一）；文档：README、`docs/ARCHITECTURE.md`、`docs/testing.md`。工作量重估：≈0.5 人日（原计划 §5.8 的 1.5 人日大部分花在模板/校验/测试上，最终口径只写文案，明显更低）。

**同版新增（t-4035212f，2026-11-22，任务 ID 出口网关 · 版本 B）**：用户面与工具面不再出现台账内部编号（`t-xxxx`）。①`task_refs` 表 + 任务引用 `tk-`+6（字母表去易混的 `0/1/l/o/i`）：`createTask` 与任务行**同事务**生成、打开台账幂等回填、`getTask` 命中无 token 时懒补、删除任务置墓碑（`retired_at`）且**永不复用**；②五个 `task_*` + `plan_save` 统一走 `src/task-ref.js` 的 `resolveTaskInput`（**先** `t-xxxx`、未命中**再** `tk-`），空值/未知值/已失效都给可读文案（不出现表名/SQL/内部列名/裸编号），不支持 session id 别名、不做空参绑定；`task_create.dependsOn` 同样接受两种值并归一成台账 id 落库；③工具输出**结构不变**、只把引用值换成 `tk-`（新增 `test/contract-snapshot.test.js` 冻结 schema 与回执行结构），交付通知里的 `task_message({ action: "close", task_id })` 也填引用；回执「子会话」按用户拍板保留会话 id；④计划文档**文件名 = 任务名**（`src/plan-doc.js`：NFC / 删控制符 / 非法字符与空白换 `-` / 折叠 / 去前导点 / Windows 保留名 / stem ≤ 60 / 绝对路径 ≤ 240 / 同名 `-2`（大小写不敏感）/ 二次落盘**覆写原文件** / 改名不迁移 / 删任务不删文件），`tasks.plan_path` 记幂等依据；⑤写入前出口清洗 `src/user-facing.js`（标题、summary、question、options、产物 label、计划正文；**只替换台账已知编号**，真实路径与台账/日志/handoff 不动）；面板、详情抽屉、工作台只显示「任务名 + 引用」。**白名单（不清洗）**：`tasks.id`、`messages`/`notifications` 的 `task_id` 列、日志、`handoff/*.jsonl`、`worktree` 路径与 `orch/<taskId>` 分支名、历史 `reports/plans/t-xxxx.md`。**明确不做**：回复正文的宿主门禁（`llm/stream` + `tools/post-execute`，版本 C）——协调者回复仍可能偶发抄出编号，靠「不喂 id」降概率，待实测泄漏率后再定。**测试**：新增 `test/{task-ref,plan-doc-name,exit-gateway,contract-snapshot}.test.js`；`pnpm test` **1,327 项 / 1,322 pass / 0 fail / 5 skip**（5 条全是本机能力跳过：符号链接权限、管道 spawn）；`dist/client.js` 162,529 B / 163,840 B（余 1,311 B）；`check:docs` 1,718 / 1,800 行。**不 push、不 bump、不打 tag**（同一版本内追加）。
**同版新增（t-c8adaeb1，2026-11-22，并行策略，只改提示词/文案）**：用户原话「协调者提示词现在有冲突就创建 worktree，尽量提高并行（如果不依赖、无需复用上下文的话）的提示吗？没有就加上」。① L1 新增「并行策略」段（`renderParallelPolicy`，句子唯一真源 `src/copy.js` 的 `PARALLEL_LINES`），拼在任务链之后、worktree/写域之前：三条同时满足才并行（互不依赖 / 无需复用同一子会话上下文 / 同写域会撞车）→ 优先 `worktree:true` 隔离并行，不把无依赖任务串成 `dependsOn` 链；只有「有依赖」或「要复用同一子会话上下文/同一检出」才串行；代价（合并由用户决定、检出要先装依赖、并发 `git commit` 争 `.git` 锁）与例外（只读/计划不必隔离、同一检出必须串行）写在同一段。② 口径对齐：worktree 隔离段（auto 档同写域冲突时优先隔离并行）、同写域并发防护段（被拒后先想到隔离并行，再才是关旧任务重派）、任务链段（同一检出不并发不变，互不依赖时直指并行策略）互相引用；硬规则（计划批准、两段式交付、同写域判定、任务链失败传播）一条没变。③ 测试 `test/parallel-policy.test.js`（关键句 / 段位置 / 三段对齐 / 归层 / 文案单源 / 文档同口径）+ `test/prompt-layers.test.js` 登记 L1 owns；文档 README（新增「并行」一节）、`docs/ARCHITECTURE.md`、`docs/testing.md`。不 bump 版本；派发、队列、写域判定与客户端零改动。

## 0.31.0（2026-11-21）—— 台账正文去重（P1）+ 抽屉正文徽标 + 测试 skip 守卫（t-90651ad4 / 9f38721）

**本版三件事**：① **P1 台账正文去重**（主体，`3cb364e`）：正文类消息只存借条、读时冷读宿主会话日志、读不到就降级、旧行零迁移；② **抽屉正文徽标**（`client/src/views.js`）：详情抽屉「最新回复」标出「正文来自子会话 / 正文不可读（摘要）」并给降级说明行；③ **测试 skip 守卫**（`9f38721`）：配置模块加载用例在管道 spawn 不可用（受限沙箱 EPERM）时 `skip`，不再把环境限制判成失败。

**只做数据去重，不改派发后端、不改状态机、不新增工具**（`createTools()` 仍是 10 个）。用户原话：「dsh官方就有保存子智能体的相关状态和会话数据，看下是否可以从插件中移除这部分数据，避免重复。」计划文档：`reports/plans/t-90651ad4.md`（P2–P4「派发改普通会话」不在本次范围）。

**背景（实测）**：会话正文的真源是宿主会话日志（`~/.dsh/sessions` 的 jsonl + `sessionPersistence`/`sessionQuery`；dsh-context 的「编队/Fleet」也是读它）。本机台账 333 个任务里，`messages` 表 561 KB（report 327 / brief 182 / followup 46）与 `tasks.last_message_json` 300 KB 都是同一段文本的第二份副本，另有一个「超 64 KiB 落 `reports/<taskId>.md`」的第三条旁路。

**行为变化**

1. **正文类消息只存借条**：`messages` 的 `brief` / `followup` / `resume` / `report` 四类，`rendered` 改为**单行摘要（≤240 字）**，`meta_json` 记 `{body:'host', chars, digest, summary}`。台账里不再有这几类的正文。
2. **最新返回消息只存借条**：`tasks.last_message_json` 从 `{text}` / `{path}` 改为 `{at, stopReason, source, bytes, chars, digest, summary, stored:'host'}`；**不再写 `<state>/reports/<taskId>.md`**（该目录只剩历史文件，插件不再读写）。
3. **读侧按需冷读宿主**：`task_status({include:'full'})` 与面板抽屉的「最新回复」在需要全文时才读宿主会话日志——`src/session-body.js`（新）先试 live 会话 `sessions.get(id).snapshotEvents(0)`，再试冷读 `sessionPersistence.open(id,'read')` + `handle.read(0)`，抽 `assistant/message`（最后一段话）、`user/message`（简报/追问，按 digest 精确匹配）、`tool/call` 里的 `task_report` 参数（回报正文）。
4. **读不到就降级，不抛错不伪造**：`task_status` 显示「正文不可读：host-log-missing；以下只是摘要」；面板 detail 返回 `body:{source:'summary', unavailable:'host-log-missing'}` 并在抽屉里显示「正文不可读（摘要）」徽标。抽屉徽标由 `client/src/views.js` 渲染：`source='host'` → 「正文来自子会话」；`source='summary'` → 「正文不可读（摘要）」+ 降级原因行；旧行（`inline`/`file`）不加徽标（正文本来就在台账里）。
5. **旧行零迁移**：P1 之前的行没有 `meta.body` 标记，`rendered`/`text`/`path` 就是正文，读路径原样返回（`source:'inline'|'file'`）。**不改 schema、不删列、不 VACUUM**，回滚只需把写入侧切回「也写正文」。

**不动的部分（C 档）**：`tasks.brief_json`（创建快照：目标/验收/约束/背景原话/`checks`/工作区索引/worktreeCleanup——宿主没有、删了 `task_detail` 与 A1 机器验收会坏）、`settle`/`acceptance`/`close`/`delivery_failed` 消息、`acceptance_json`、两段式交付（`delivered`/`accepted_*`/`close_reason`）、`depends_json`、`notifications`、`question*`、`goal_state`、worktree 七列、`team_task_*`、`memories`/`groups_v1`/`automations`。

**代码**：新增 `src/session-body.js`（宿主事件抽取 + live/冷读 + 5 秒/32 条短缓存）、`src/message-body.js`（借条写入 `compactMessage` 与解析 `resolveMessageBody`）；改 `src/last-message.js`（`captureLastMessage` 只产出借条、新增 `resolveLastMessage`，`readLastMessage` 保留读旧行）、`src/settlement.js`（结算只落借条，`reportsDir` 入参保留但不再使用）、`src/tools.js`（brief/followup/resume/report 写入瘦身 + `task_status include:full` 冷读 + 降级行）、`src/panel-actions.js`（新增异步 `detailBody`；消息行带 `body` 标记；followup/brief 写入瘦身）、`src/host-route.js`（detail 走 `detailBody`）、`src/queue.js`（派发一律 `renderBriefForTask(task)` 现渲染）、`src/ledger.js`（`briefText` 降级为「读旧行的兜底」并注明不再用于派发）、`index.js`（唯一 `bodySource` 装配，注入 tools 与面板）、`client/src/views.js`（抽屉徽标「正文来自子会话 / 正文不可读（摘要）」+ 降级说明行）。

**测试**：新增 `test/body-dedupe.test.js`（5 条：写侧借条不带正文、读侧按 digest 从宿主日志取回、旧行原样可读、宿主缺失降级口径（`task_status` 与面板 detail 同源）、`session-body` 抽取器 + 冷读句柄含抛错降级）；改写 `test/settlement.test.js`（借条形状、超 64 KiB 不再落盘、幂等与空输出）、`test/tools.test.js`（`include:full` 冷读/降级/旧 inline-file 行）、`test/index.test.js`（装配级借条落地 + 宿主可读时给回全文 + 不可读时降级）、`test/panel-actions.test.js`（重派 brief 借条 + 重渲染出的两行）、`test/client.test.js`（抽屉「最新回复」的「正文来自子会话 / 正文不可读（摘要）」徽标与降级说明行）。全量 `1178` 条用例：`1173` 通过、`5` 跳过（符号链接权限，CI/有权限环境真跑）、`0` 失败。

**测试守卫（`9f38721`）**：`test/config-schema.test.js` 的「真实模块加载」用例靠 `spawnSync` + `stdio:'pipe'` 捕获子进程输出，而受限沙箱禁止子进程打开命名管道（EPERM）。用例改成先问 `canSpawnWithPipes()`（`test/helpers.js` 同一口径）：能力不可用时 `t.skip` 并写明原因，本地全权 / CI 照样真跑——环境限制不再被判成失败。

**文档**：`docs/ARCHITECTURE.md`（重写「最新返回消息（B1）」+ 新增「台账正文去重（P1）」一节，含三类数据对照表、读侧口径、回滚与风险；落盘清单删掉 `reports/<taskId>.md`）、`docs/LIMITATIONS.md`（正文可用性绑定宿主会话、缓存窗口）、`README.md`（`task_status` 行）、本条目。

**验证**：`pnpm test`（含 `pretest` 的 build + `check:client-size` + `check:docs`）**1,178 项 / 1,173 pass / 0 fail / 5 skip**（5 条 skip 全是「当前环境无法创建文件符号链接」的环境跳过）；`pnpm run check:version`（0.31.0 三处一致）；`pnpm run check:docs` **1,703 行 / 预算 1,800**；`pnpm run check:client-size` **150,792 B / 151,552 B**（余 760 B）；`pnpm run build` 重建后 `dist/client.js` 与入库一致（git 无 diff）。发版前本机 web 冒烟见下方「冒烟记录」。

**冒烟记录（0.31.0 本地 tgz）**

- **环境**：Windows 11 + DSH `0.2.2-rc.5`；隔离 `DSH_HOME=<临时目录>/home` + 独立 profile `smoke`（`--from-default-profile web` 生成）；`npm pack` 出 `wjj865-code-dsh-orchestrator-0.31.0.tgz`，`dsh plugin --profile smoke add <tgz>` 安装（安装副本 `version` 实测 **0.31.0**，`dist/client.js` 与仓库 SHA-256 一致）；`dsh --profile smoke --no-open --port 0`（系统分配空闲端口，**不碰 49682 / 54746**）；冒烟进程全程用隔离 `DSH_HOME`，真实 `~/.dsh` 不参与。
- **模型**：本地 `127.0.0.1:49911` 的 Messages 兼容 stub（假 key `sk-smoke-local`，只记录宿主真实请求的 `tools[]` / system / messages，回可预测的助手回合）；**没有复制、也没有读取任何真实凭据**。
- **HTTP 12/12 ✓**：壳页 303（token→cookie）→ 带 cookie 后 `snapshot` / `main-nav` / `main-nav-ack` / `session-role` / `groups` / `calendar` / `automations` / `stats` 全 200；反例 `task-create` → 400 `UNKNOWN_ENDPOINT`；`open-main` → 200 建出主会话。
- **协调者工具表（宿主真实下发 15 个 ✓）**：`ask_user_question` / `context` / `memory_note` / `present` / `read` / `read_workspace` / `schedule_create` / `schedule_edit` / `schedule_list` / `schedule_view` / `skill` / `task_create` / `task_list` / `task_message` / `task_status`——**没有 `grep` / `glob`**，也没有 `write` / `edit` / `pwsh` / `bash`；`read` + `read_workspace` + `memory_note` + 4 个 `task_*` 都在。
- **worker 工具表（30 个）**：`preset-tools` 是 keep-only（`keep: [context, task_detail, task_report, memory_note]`，**无 deny 行**），子会话表里 `memory_note` / `task_detail` / `task_report` 都可用；`preset.keep` / `preset.deny` 审计行与 0.30.0 同口径。
- **插件加载零 error / 零 warn ✓**：插件日志 24 行覆盖 `snapshot.created` / `host.capabilities` / `preset.keep`×2 / `preset.deny`×1 / `main.session.created` / `task.create.created` / `subagent.spawn.*` / `goal.created` / `task.transition`×2 / `task.spawn.ok` / `task.queue.drained` / `task.settle`×2 / `task.settle.late-message` / `notify.delivered`；**没有 error/warn 级别行、没有 `*.failed` / `*.rejected` 事件**；`host.capabilities` 报 rc.5、8/10 能力（缺 `registry` / `team-board` 属隔离环境懒挂载预期）。
- **浏览器（headless Chrome + CDP，隔离 user-data-dir）12/12 ✓**：侧栏「主会话」入口与会话头「任务」入口可点；面板五页导航标签 `总览 / 任务组 / 排期 / 自动化 / 复盘` 逐项点击都切到对应 `data-page`（`overview` / `groups` / `schedule` / `automations` / `review`）；从「任务组」组卡进入组工作台 `data-page="group"`；dock 实渲染（`.orch-wb-dock`，`aria-label="任务上下文（只读）"`，**0 个 input/textarea/select/form**，文案「dock 是只读镜像：不代发消息、不代批计划」）；详情抽屉「最新回复」显示 **「正文来自子会话」** 徽标；浏览器 console/log **零 error、零 warning**。
- **P1 隔离台账断言 10/10 ✓**：`tasks.last_message_json` 是借条（无 `text`/`path`、`stored:'host'`、`summary` 短于 `chars`）；`messages` 的 `brief` / `report` 行 `meta.body='host'`、`rendered` 单行摘要（report 摘要 241 字 vs 原文 351 字）、无换行；C 档消息不带 `body` 标记；`tasks.brief_json` 保留目标/验收；`messages` 六列 schema 未变（旧行零迁移）。
- **读侧（与 `task_status include:full` 同一条 `readBody`）✓**：正常时面板 detail `body:{source:'host'}`，`lastMessage.text` 取回 **744 字全文**（台账摘要 241 字）；把宿主会话日志目录挪走后重启同一隔离 home，detail 仍 `200 {ok:true}`，`body:{source:'summary', unavailable:'host-log-missing'}`，`text` 退回 241 字摘要——**降级不抛错、不伪造**。
- **未验（附原因）**：① 真实模型是否照着 W1 policy / 工具说明行动——stub 只能证明注入内容与工具表，不证明模型服从；② 真实上下文压力下的提醒 deferred、确认「新建」后的浏览器跳转（`main-nav` 待办）——需要真实长任务压到阈值，本次只验到空待办的降级口径（`nav:null` / `cleared:false`）；③ 排期拖拽、自动化新建/暂停的写动作（会真建调度，不属本次冒烟范围）；④ 暗色主题 / 多语言外观。
- **证据**（临时目录，未入库）：`probe-results.json`（12 项）、`browser-results.json`（12 项 + `browser-panel.png`）、`ledger-check.json`（10 项）、`detail-results.json` / `detail-degraded.json`、`mock-requests.jsonl`（宿主真实请求体）、隔离 home 的 `logs/orchestrator-2026-11-21.jsonl`。用完关服务、清 headless Chrome 与临时目录。

## 0.30.0（2026-11-21）—— 有任务在跑不再弹切换卡、确认后真跳过去 + 子会话可写项目记忆（t-a79e12d8 / t-94b99f3f）

两条用户直接提的改动合并发版，**没有改派发语义、状态机、权限模型，也没有新增工具**（`createTools()` 仍是 10 个）。用户原话：「目前超过40%，自动切新的主会话逻辑不太对，例如有运行中任务时，依然会询问用户是否切换，选择确认后，当前会话不是主会话了，但没有新建和跳转到新会话」、「另外写记忆为啥只属于协调者，按理说子会话在执行任务也能读到很多项目背景和已有实践，也需要进行写入记忆。A 子会话写项目记忆（推荐）。」

**升级注意**：装包后要**彻底退出 DSH 再启动**（刷新页面无效），worker 预设的 keep-only 形态与 W1 policy 才生效；台账 schema 有一处**加列**（`memories.source`，旧库自动 `ALTER TABLE` 补列），旧库直接可用。

**1. 压力提醒不再打扰运行中任务，确认「新建」后真的会跳过去（t-a79e12d8）**

**根因（实读 + 真机日志）**：① `src/main-context.js` 的 `decideAlert` 只看压力 band，完全不看台账任务状态——真机 08:29:10 弹卡时 `t-4f7ce108` 正在跑（08:40:38 才交付）；② 代建只做到「create + 切指针」（`index.js` 的 `requestNewCoordinator` → `mainSession.createCoordinatorSession`），**跳转是客户端能力**（宿主 `uiWorkspace.openSession`），插件当年没有任何通道让浏览器知道要跳过去：真机 08:29:20 `main.adopt.created` 成功（newId=session-341c…），用户仍停在旧会话、看到会话头变成「设为协调者」，08:33:52 又把它点了回去。

**行为变化（2 条）**

1. **有非终态任务就不弹卡**：`decideAlert` 在「该问」时检查 `DEFERRED_TASK_STATUSES`（`pending` / `running` / `waiting_dep` / `waiting_user` / `waiting_auth`；`delivered` 不算在跑），命中就改成 `defer`：只记 `main.context.alert.deferred`（按 band + 任务集合去重），**不写 `settings.main_context_alert`、不占 band**；任务收尾后下一次打开主会话仍会问（同一 band 也问）。
2. **确认「新建协调者会话」后真的会跳过去**：代建成功 → 写一条进程内导航待办（`src/main-nav.js`，TTL 5 分钟）→ 浏览器每 5s 轮询 `main-nav` → `uiWorkspace.openSession(新会话 id)` → `main-nav-ack` 清待办。失败全部降级、不留「当前不是主会话又没新会话可跳」的中间态：create 失败零处置（不切指针）并给可读提示；切指针失败保持旧主会话 + 提示；导航失败保留指针（用户从会话列表打开「主会话」）+ 面板顶部可读提示 + 审计 `main.nav.navigate-failed`。旧宿主没有 `openSession` 时只给提示、不崩。**不新增归档/删除旧会话**。

**代码**：新增 `src/main-nav.js`（`createMainNav` / `planCoordinatorNav` / `MAIN_NAV_TEXT`）、`client/src/nav.js`（`createMainNavPoller` / `createNavNotice`）；改 `src/main-context.js`（`DEFERRED_TASK_STATUSES`、`decideAlert({activeTasks})`、`remind` 的 defer 分支）、`src/host-route.js`（`main-nav` / `main-nav-ack`，未装配时降级）、`index.js`（`activeTasks` 注入、`requestNewCoordinator` 发布待办、路由装配 `mainNav`）、`client/src/{api,client,views}.js`（轮询 + 面板可读提示）。文案：问题卡「新建」项改成「新建一个空白协调者会话、切过去并跳到新会话（旧会话保留）」。

**测试**：新增 `test/main-nav.test.js`（4 条：代建结果→待办、单条/覆盖/id 匹配 ack、失败审计、TTL 过期）；`test/main-context.test.js` 加 3 条（defer 纯函数与 delivered 口径、deferred 不写 asked 且收尾后再问、只有 delivered 照常问）；`test/host-route.test.js` 加 1 条（读/ack/降级/零写入）；`test/index.test.js` 加 2 条装配级用例（有任务在跑时 `open-main` 走 deferred、停止后再问；选「新建」→ 代建 + 切指针 + `main-nav` 待办 + ack 才清）；`test/client.test.js` 加 4 条（navigate 跳转 + 不重复、拒绝后重试 3 次 + 可读提示、notice 原样显示 + 缺 openSession 降级、面板顶部提示已挂载订阅/未挂载 take）；`test/client-build.test.js` 同步 `__test` 出口与源码文件清单。文档：README（提醒/延后/跳转三条 + 排障一行）、`docs/ARCHITECTURE.md`（模块/延后/跳转/日志/路由）、`docs/LIMITATIONS.md`（延后代价 + 跳转尽力而为）。

**边界（未做）**：不改 `contextPressureThreshold`、不改宿主压缩、不恢复轮换/归档；不新增工具、不改权限模型；跳转不保证成功（尽力而为，失败的手动路径已在提示里写明）。

**2. 子会话可写项目记忆（note / lesson / decision），全局偏好仍只协调者（t-94b99f3f）**

**行为变化（3 条）**

1. **子会话可以沉淀项目经验**：任务执行者的工具表里恢复 `memory_note`（worker 预设 `preset-tools` 改成 **keep-only**：deny 为空、`keep` 声明 `context` / `task_detail` / `task_report` / `memory_note`）。子会话只能写**自己任务 `target_dir`** 那个项目的 `note` / `lesson` / `decision`；不传 `project` 就落本项目，传别的项目或 `global` 一律拒绝（点名本任务项目键），不会串到别的项目。
2. **全局偏好与跨项目记忆仍只协调者**：子会话写 `kind:'preference'`、没有 `target` 的任务、或找不到任务归属的会话（别的 profile / 孙会话）都被拒绝，并给可执行替代路径（写 `task_report` 的 summary / 让协调者 `memory_note`）。协调者行为不变（全局偏好仍进 `settings.orchestrator_preferences`，任意项目仍可写）。
3. **硬护栏**：同 `project + kind + text` 幂等（重复返回 `already`）；单任务最多 **3 条**（`MAX_WORKER_MEMORIES_PER_TASK`，`countWorkerMemories` 按 `source='worker'` + `source_task_id` 计数，超限拒绝）；`memories` 新增 `source` 列（旧库 ALTER 补），子会话写入记 `source='worker'` + taskId/sessionId，写入/拒绝都记日志（`memory.note` / `memory.note.rejected`，含 `written`/`cap`）。

**代码**：`src/tools.js` 的 `memory_note` 按角色分流（协调者原路由不变；子会话走归属 → 项目 → kind → 去重/上限的硬护栏），新增 `taskOfWorker`（优先用注入的 spawn 映射，再退 `findTaskBySession`，首回合 `tasks.session_id` 没回写也认得出），拒绝原因 `worker-no-task` / `worker-no-target` / `worker-preference-denied` / `worker-project-mismatch` / `worker-quota-denied`；`src/memory.js` 的 `addMemory` / `remember` 增加 `source`，新增 `MEMORY_SOURCE_WORKER` / `MAX_WORKER_MEMORIES_PER_TASK` / `countWorkerMemories`，`searchMemories` 结果带 `source`；`src/ledger.js` 建表列 + 旧库 `ALTER TABLE` 补列；`preset-tools.js` 允许 **keep-only**（deny 空 + keep 非空）形态，worker 预设不再遮 `memory_note`；`src/copy.js` / `src/prompt-layers.js` 的 W1 新增 `WORKER_MEMORY_HINT`（「有值得复用的项目经验就用 memory_note 写一条 note/lesson/decision，project 只能是你自己任务的 target_dir、单任务最多 3 条；不写 preference、不写全局/跨项目记忆，也不写日志」），`WORKER_CONTEXT_HINT` 删掉「写记忆只属协调者」，`PROMPT_LAYERS` 的 W1 owns 登记、L2 探针加「W1 记忆沉淀句被抄回 brief 就红」；`cordis.patch.yml` 的 worker `preset-tools` 从 `deny: [memory_note]` 改为 keep-only 并写明放开范围与理由；`index.js` 的 `createTools` 注入 `taskOfAgent: workerTaskOf`（与 W1 同一份归属解析）。

**测试**：`test/tools.test.js` 新增两条——子会话写自己任务项目记忆成功（project 强制 target、去重 `already`、来源字段、单任务上限 3 条 + 审计日志）与「preference / global / 别的项目 / 无 target / 无归属」全部拒绝且不写库，schema 描述断言同步；`test/memory.test.js` 来源审计（`source`/taskId/sessionId 落行、检索可见、`countWorkerMemories` 单任务计数）；`test/preset-tools.test.js` 新增 keep-only 形态（不遮任何工具、只写 keep 审计）+ 配置互斥用例；`test/config.test.js` worker 预设不再有 `deny`、`keep` 含 `memory_note`、`index.js` 注入 `taskOfAgent`；`test/prompt-layers.test.js` / `test/index.test.js` 的 W1 五句 + `WORKER_MEMORY_HINT` 逐字断言 + L2 探针。

**文档**：README（工具清单 `memory_note` 行、预设收窄形态、W1 层职责、记忆与偏好）、`docs/ARCHITECTURE.md`（权限矩阵、preset 形态、W1 句子、新增「子会话写入项目记忆」一节）、`docs/LIMITATIONS.md`（「子会话能读上下文，也能写项目记忆」的边界与代价）。

**3. 工具面口径（两张表各自说清）**

- **协调者（宿主真实下发 15 个）**：`ask_user_question` / `context` / `memory_note` / `present` / `read` / `read_workspace` / `schedule_create` / `schedule_edit` / `schedule_list` / `schedule_view` / `skill` / `task_create` / `task_list` / `task_message` / `task_status`——`read` 在，`grep` / `glob` 不在（0.29.0 起 `tool-fs-search` 整行移除），也没有 `write` / `edit` / `pwsh` / `bash` / `apply_patch`，以及角色专属的 `task_report` / `task_detail` / `plan_save` 与会改 cwd 的 `working_directory`。
- **子会话（worker 预设 keep-only）**：`preset-tools` 的 `deny` 为空、`keep` 声明 `context` / `task_detail` / `task_report` / `memory_note`——即这 4 个插件工具出生即可用，`memory_note` 不再被遮（0.29.x 是 `deny: [memory_note]`）；其余按预设自有行照旧（`pwsh`（Windows）/ `bash`、`glob` / `grep` / `read` / `write` / `edit`、`web` / `todo` / `skill` / `present` / `get_goal` / `jobs`）。
- **工具总数没变**：`createTools()` 仍是 10 个（`task_create` / `task_list` / `task_status` / `task_detail` / `task_message` / `read_workspace` / `context` / `memory_note` / `task_report` / `plan_save`），`check:docs` 的 README 工具表与代码同源。

**验证**

- `pnpm test`（含 `pretest` 的 build + `check:client-size` + `check:docs`）= **1,170 项 / 1,165 pass / 0 fail / 5 skip**；5 条 skip 全是「当前环境无法创建文件符号链接」的环境跳过（Windows 未开开发者模式），与本次改动无关。
- `pnpm run check:version`（0.30.0 三处一致：`package.json` / README 定位行与 3 处命令 / CHANGELOG 首条）/ `check:docs`（**1,677 行 / 预算 1,800**）/ `check:client-size`（**150,446 B / 151,552 B**，余 1,106 B）全绿。
- 本次改了 `client/src/{api,client,views}.js` + 新增 `client/src/nav.js`，`pnpm run build` 重建后的 `dist/client.js` 与入库副本逐字一致（SHA-256 未变），`dist/client.js.map` 同批入库。
- 发版前本机 web 冒烟（0.30.0 本地 tgz，隔离 `DSH_HOME` + 独立 profile，空闲端口不碰 49682）：结果见下方「冒烟记录」。

**冒烟记录（0.30.0 本地 tgz）**

- **环境**：Windows 11 + DSH `0.2.2-rc.5`；隔离 `DSH_HOME=<临时目录>/home2` + 独立 profile `smoke`（`--from-default-profile web` 生成）；`npm pack` 出 `wjj865-code-dsh-orchestrator-0.30.0.tgz`，`dsh plugin --profile smoke add <tgz>` 安装（安装副本 `version` 实测 **0.30.0**）；`dsh --profile smoke --no-open --port 49734`（空闲端口，**不碰 49682 / 55726**）；冒烟进程全程用 `DSH_HOME` 覆盖，真实 `~/.dsh` 零读写；用完关服务、清 headless Chrome。
- **模型**：本地 `127.0.0.1:49911` 的 DeepSeek Messages 兼容 stub（假 key `sk-smoke-local`，只记录宿主真实请求的 `tools[]` / system / messages，回固定助手文本；需要造数据时只回一次 `task_create` tool_use），**没有复制、也没有读取任何真实凭据**。
- **结果 33/33 ✓**（21 项 HTTP/静态 + 12 项浏览器/面板；工具表与日志按读数核对）：
  - **插件加载零 error / 零 warn**：插件日志 21 行，覆盖 `main.session.created` / `main.session.permission-pinned` / `subagent.spawn.requested` / `subagent.spawn.accepted` / `task.spawn.ok` / `task.transition`×2 / `task.settle` / `notify.delivered` / `preset.keep`×2 / `preset.deny`×1 / `host.capabilities` / `snapshot.created`，**无 error/warn 行**；`host.capabilities` 报 rc.5、`inside`、8/10 能力（缺 `registry` / `team-board` 属该隔离环境的懒挂载预期）。
  - **协调者工具表（宿主真实下发，15 个）**：`ask_user_question` / `context` / `memory_note` / `present` / `read` / `read_workspace` / `schedule_create` / `schedule_edit` / `schedule_list` / `schedule_view` / `skill` / `task_create` / `task_list` / `task_message` / `task_status`——**没有 `grep` / `glob`**，也没有 `write` / `edit` / `pwsh` / `bash` / `task_report` / `task_detail` / `plan_save` / `working_directory`；`read` + `read_workspace` + `memory_note` + 4 个 `task_*` 都在。
  - **worker 工具表（宿主真实下发，30 个）含 `memory_note`**：`memory_note` / `context` / `task_detail` / `task_report` / `task_create` / `task_list` / `task_status` / `task_message` / `plan_save` / `read` / `read_workspace` / `read_image` / `write` / `edit` / `glob` / `grep` / `pwsh` / `job_*` / `web_*` / `todo_write` / `skill` / `present` / `get_goal` / `create_goal` / `update_goal` / `working_directory` / `ask_user_question`。安装副本 `cordis.patch.yml` 的 worker `preset-tools` 只有 `keep: [context, task_detail, task_report, memory_note]`、**没有 `deny`**；`preset.keep` 审计行同口径，`preset.deny` 只有协调者那一行（worker 预设全程没有 deny 行）。
  - **端点**：`snapshot` / `session-role` / `groups` / `calendar` / `automations` / `stats` 全 200；`main-nav` → `200 {ok:true,nav:null}`，`main-nav-ack`（无待办）→ `200 {ok:true,cleared:false}`；反例 `task-create` 返回 400 `UNKNOWN_ENDPOINT`；壳页 200 且已登记 `@wjj865-code/dsh-orchestrator/client.js`（token→cookie：303 → 带 cookie 200）。
  - **面板六页 / 组工作台 / dock / 排期**（真实 Chrome headless 驱动，隔离 profile）：会话头「任务」打开面板（`data-page` 命中）；`总览` / `任务组` / `排期` / `自动化` / `复盘` 五次点击都切到 `overview` / `groups` / `schedule` / `automations` / `review`；从「任务组」卡片进入组工作台 `data-page="group"`（组里一条夹具任务，`readOnly`，落「已交付待确认」）；dock 实渲染 `.orch-wb-dock`、**0 个 input/textarea/form/select**、文案「dock 是只读镜像：不代发消息、不代批计划」。
  - **bundle**：平台 serve 的多模块组里含本插件模块；入库 `dist/client.js`（150,446 B）的头/尾片段逐字出现（只差平台补的 `;\n` 分隔与 `??…&rev=…` sourceMappingURL 改写）；bundle 含 `main-nav` / `main-nav-ack` / `openSession` / 「打开『主会话』」提示、六页 `data-page` 标记与「只读镜像」文案；**浏览器实测每 5s 轮询 `main-nav`**（12s 窗口 7 次），客户端 console **零 error / 零 warn**。
- **未验（附原因）**：① **真实压力提醒 deferred 弹卡**（有任务在跑时不弹、收尾后再问）——需要一个真实长任务把上下文压到阈值，stub 只能证明接口与纯函数（单测覆盖），冒烟未触发；② **真实「确认新建后跳转」**——同上，`main-nav` 只验到空待办的降级口径（`nav:null` / `cleared:false`），没有一次真实待办让浏览器跳过去；③ **worker 实际写项目记忆**——工具面已证明 `memory_note` 在子会话表里，但 stub 不会真调它，去重 / 单任务上限 / 来源审计仍由单测覆盖；④ **模型是否照着 W1 policy 行动**——stub 只证明注入内容与每回合重渲染，不证明模型服从；⑤ **排期拖拽与自动化新建/暂停的写动作**——只验到页面可进入 + 只读接口 200（写动作会真建调度，不在本次冒烟范围）；⑥ 暗色主题 / 多语言外观未覆盖。
- **证据**（临时目录，未入库）：`probe-results2.json`（21 项）、`drive-results2.json`（12 项）、`10-page-*.png` / `11-group-dock.png` / `05-after-create.png`、`mock-requests2.jsonl`（宿主真实请求体）、隔离 home 下 `logs/orchestrator-2026-11-21.jsonl`（插件日志 21 行）。
- **过程备注**：第一次驱动时 stub 每回合重放同一个 `task_create` tool_use，宿主按「已存在任务…未重复创建」去重门控连续拒绝（info 级，零 error/warn）；随后换成「只造一次」的 stub 在全新 `home2` 重跑取最终证据，台账里只留一条夹具任务（`delivered`、`readOnly`）。

## 0.29.0（2026-11-21）—— 协调者去掉 grep/glob 只留 read + 任务执行者 W1 policy（t-4f7ce108）

两条用户直接提的改动，**没有改派发语义、状态机、权限、工具数量，也没有新增工具**。用户原话：「目前发现 grep 工具会让主会话自行搜索，导致有时主会话会自主搜索文件调研，现在把这个工具从协调者预设中移除。另外协调者预设有 policy，但任务执行者却没有，建议参考协调者，将静态提示词内容都统一移入任务执行者的 policy，这样每次跑都会注入，效果更好。」

**升级注意**：装包后要**彻底退出 DSH 再启动**（刷新页面无效），新的预设与 W1 policy 才生效；台账无 schema 变更，旧库直接可用。

**1. 协调者移除 `glob` / `grep`（整行移除 `tool-fs-search`）**

- **为什么整行移除而不是只关 grep**：先查了实际安装的 `@deepseek-ai/dsh-tool-fs-search`（`app.asar` 内的 `src/index.ts` 与 `lib/index.js`）——`Config` 只有 `sampleOverCapGlobResults` 与 `globMaxResults` / `grepMaxMatches` / `grepMaxLineBytes` / `searchMetaMaxBytes` / `rawOutputMaxBytes` / `graceMs` / `stderrMaxBytes` / `timeoutMs`，**没有按工具开关**；`apply()` 无条件同时 `applyGlobTool` + `applyGrepTool`。而 `preset-tools` 的 `deny` 只作用于「已注册的全局工具」（`ctx.tools.view().restrictableNames`），`restrict` 遮不到预设自有行。所以「只关 grep、保留 glob」在本平台做不到，只能把协调者预设的 `tool-fs-search` 整行移除：协调者的原生只读工具只剩 `read`。
- **预设与文案**：`cordis.patch.yml` 协调者预设删掉 `tool-fs-search` 行并写明取舍（含包内 schema 证据）；预设 `description` / persona prefix 不再提 glob/grep；`index.js` 的 L1 硬规则（看文件只留 `read`、检索类工作派只读任务）、工具清单句、`DENY_HINT`、`COORDINATOR_DENY` 注释、`src/prompt-layers.js` 的 L1 `owns`、`skills/grill-me/SKILL.md` 的「先只读调研」步骤、`src/read-workspace.js` / `src/tools.js` / `preset-tools.js` 的取舍注释全部同步，源码里不再暗示协调者可以搜索。
- **测试**：`test/config.test.js` 改为断言「协调者预设没有 `tool-fs-search` 行、没有该包名、worker 仍挂」；`test/index.test.js` 的 deny/guard 名单去掉 glob/grep；`test/prompt-layers.test.js` 加「L1 不许再出现 `read / glob / grep`」。
- **代价**：协调者不能自己枚举目录/跨文件检索，需要时派一条 `readOnly:true` 任务（多一次派发往返）；`read` 仍是全盘可读、没有产物边界，凭据纪律不变。

**2. 新增 W1「任务执行者 policy」（per-turn，只命中任务子会话）**

- **新增层**：`src/copy.js` 定义句子（`SUMMARY_FIELDS` / `WORKER_DETAIL_HINT` / `BLOCKED_HINT` / `CONFIRM_HINT` / `WORKTREE_INSTALL_HINT` / `WORKER_CONTEXT_HINT` / `WORKER_POLICY_HEADING` / `WORKER_POLICY_LINES`），`src/prompt-layers.js` 的 `renderWorkerPolicy({ worktreeState })` 渲染（固定四句 + 隔离任务才有的装依赖授权），`index.js` 用**第二条** `ctx.systemPrompt.context` 注册（`name: 'orchestrator:worker-policy'`、`order: 131`，与 L1 的 130 分开、互不覆盖）。
- **归属判定**：只命中任务子会话——`subagent.spawn.accepted` 事件先记「子会话 id → 任务 id」，台账 `tasks.session_id`（`transition(..., 'running', { sessionId })` 写入）是唯一真相，两者都查；协调者、无关会话、孙会话一律返回空串。
- **迁移的句子（从 brief / persona 移出，brief 收到的只是一次性参数）**：①「先调 `task_detail` 读详情」的字段清单与「不要凭 brief 猜任务内容」；②执行中怎么上报（`blocked` + `问题/选项建议` + 四条「不要」+ 追加调整先评估）；③交付怎么回报（`task_report` 四状态、summary = 结论 + 三问、`done` 清空 `question`/`options`、两段式终态、`DELEGATED_CALLER`、不催关闭）；④隔离任务装依赖（只装不升）；⑤主动调 `context` 找历史/项目背景（原 worker persona）。task_detail 末尾的 `FINISH_HINT` 删除（完成动作归 W1，同一句只在一层）。
- **brief / persona 精简**：`renderBrief({ taskId, access })` 从 4–6 行收到 **2–3 行**（任务编号 + 可选访问级别 + 一行详情指针）；`worktree_state` 不再进 brief；worker 预设 persona 从「身份 + 主动读 context」收到**身份一句**。
- **测试**：`test/brief.test.js` 重写为「只留一次性参数」；`test/prompt-layers.test.js` 重写为六层（L1/W1/L2/L3/L4/NOTIFY）+ W1 逐字同源 + L2 探针抓「W1 静态句被抄回 brief」；`test/index.test.js` 加 W1 注入/归属用例（协调者/无关/孙会话拿空串、隔离任务多一句装依赖）；`test/copy-consistency.test.js` / `test/interaction-policy.test.js` / `test/task-detail.test.js` / `test/tools.test.js` / `test/panel-actions.test.js` / `test/worktree.test.js` / `test/status-property.test.js` 同步到新分层。
- **文档**：README（工具清单、技能与只读工具、新增「提示词分层」表、已知限制）、`docs/ARCHITECTURE.md`（六层表 + W1 注入判定 + brief 节重写 + B 片取舍）、`docs/LIMITATIONS.md`（「协调者读文件（read）」节 + 无检索能力的代价）、`docs/testing.md`（G8、§3.2、里程碑表新增一行）。

**验证**

- `pnpm test`（含 `pretest` 的 build + `check:client-size` + `check:docs`）= **1,153 项 / 1,148 pass / 0 fail / 5 skip**；5 条 skip 全是「当前环境无法创建文件符号链接」的环境跳过（Windows 未开开发者模式），与本次改动无关。`pnpm run check:version`（0.29.0 三处一致）/ `check:docs`（**1,658 行 / 预算 1,800**）/ `check:client-size`（**148,323 B / 151,552 B**，余 3,229 B）全绿。
- 本次未改 `client/**`，`pnpm run build` 重建后 `dist/client.js` 仍是入库的 148,323 B、git 零 diff（SHA-256 未变）。
- **发版前本机 web 冒烟（0.29.0 本地 tgz，隔离 `DSH_HOME` + 独立 profile，空闲端口，不碰 49682）**：结果见下方「冒烟记录」。

**冒烟记录（0.29.0 本地 tgz）**

- **环境**：Windows 11 + DSH `0.2.2-rc.5`；隔离 `DSH_HOME=<临时目录>/home` + 独立 profile `smoke`（`--from-default-profile web` 生成，`dsh plugin --profile smoke add <0.29.0 本地 tgz>` 装包，安装副本 `version` 实测 0.29.0）、`dsh --profile smoke --no-open --port 49611`（空闲端口，**不碰 49682**）；真实 `~/.dsh` 零读写；用完关服务、删临时目录。
- **模型**：本地 Messages 兼容 stub（假 key，记录宿主真实请求的 `tools[]`、system 上下文与消息体），**没有复制、也没有读取任何真实凭据**（「凭据只复制不读取」这条授权本次未使用）。
- **结果 31/31 ✓**（15 项 HTTP/静态 + 16 项浏览器/模型回合）：
  - **插件加载零 error / 零 warn**：插件日志 44 行（主会话创建、任务派发、worker 两回合、结算、通知全链路），无 error/warn 行；`host.capabilities` 报 rc.5、8/10 能力（缺 `registry` / `team-board` 属该隔离环境预期）。
  - **协调者工具表（宿主真实下发，15 个）**：`ask_user_question` / `context` / `memory_note` / `present` / `read` / `read_workspace` / `schedule_create` / `schedule_edit` / `schedule_list` / `schedule_view` / `skill` / `task_create` / `task_list` / `task_message` / `task_status`——**没有 `grep` / `glob`**，也没有 `write` / `edit` / `pwsh` / `bash` / `apply_patch`。
  - **worker brief 实测 2 行**：`【任务编号】t-eb9b3f8d` + `【任务详情】先调 task_detail 读完整详情（task_id 就是上面的任务编号）。`；不含任何 W1 静态句（`堵塞项` / `summary 写成` / `task_report` / `worktree` 都不在 brief 里）。
  - **W1 policy 每回合注入**：worker 两个回合（1 条消息 / 3 条消息）的上下文都含标题「回报与确认（任务子会话每回合都在，不必等 brief 再说）」与 `blocked` / `report` / `context` 三句原文；协调者的 3 个请求一次都没出现该段。
  - **面板六页 / dock**：会话头「任务」打开面板；`总览` / `任务组` / `排期` / `自动化` / `复盘` 五次点击都切到对应 `data-page`（第 6 页「组工作台」由任务组卡片进入，`data-page="group"`）；dock 实渲染、**0 个 input/textarea/form**，文案「dock 是只读镜像：不代发消息、不代批计划」。
  - **接口与产物**：`snapshot` / `session-role` / `groups` / `calendar` / `automations` / `stats` 全 200，反例 `task-create` 返回 400 `UNKNOWN_ENDPOINT`；壳页 200 且已登记 `@wjj865-code/dsh-orchestrator/client.js`；平台 serve 的 bundle 内含入库 `dist/client.js` 全文（源文件 148,323 B）。
- **未验（附原因）**：① 真实模型回合下「模型是否照着 W1 行动」——stub 只证明注入内容与每回合重渲染，不证明模型服从；② 排期拖拽与自动化新建/暂停的交互动作——只验到页面可进入、接口 200；拖拽需要真实指针序列，自动化写动作会真建调度，不在本次冒烟范围；③ 暗色主题 / 多语言外观未覆盖。
- **证据**（临时目录，未入库）：`probe-results.json`（15 项）、`drive-results.json`（16 项）、`06-page-*.png` / `07-group-dock.png` 等截图、`mock/requests.jsonl`（宿主真实请求体）、`plugin-log-scan.json`。

## 0.28.0（2026-11-21）—— 任务链（dependsOn）进 L1：依赖完成自动开始，不再「等 A 完成再派 B」

本版只有一类改动：把**早就存在**的依赖编排机制写成协调者每回合都在的规则，并小版本发布。**没有改派发语义、状态机、权限，也没有新增工具**。用户原话：「你可以使用 dependson，依赖任务结束时会自动开始。这个机制是不是没写到预设或者提示词，怎么没怎么使用。」

**升级注意**：装 `@wjj865-code/dsh-orchestrator@0.28.0` 后要**彻底退出 DSH 再启动**（刷新页面无效），新的协调者 policy 才生效；台账无 schema 变更，旧库直接可用。

**新增**

- **L1 新增「任务链」段**（`src/prompt-layers.js` 的 `renderTaskChainPolicy()`，拼在**推进循环之后、worktree/写域之前**）：五条规则——① **判据与建链时机**：B 的输入是 A 的产物（实现 → 验收/冒烟、构建 → 发布、修复 → 回归、迁移 → 回归复核）时，派 A 之后**同一回合**就把 B 建出来并传 `dependsOn:[A 的编号]`，**不要等 A 完成再建、也不要轮询**；② **`dependsOn` 不是阻塞等待**：B 先落 `waiting_dep`，前置全 `done` 后由**插件队列自动晋升** `pending` 并派发，**不占协调者回合**、不是 `wait_agent`；③ **前置失败 → 下游自动 `failed`**（failed/cancelled/orphaned/不存在，原因写明、沿链循环传播，要接着做用 `retry`）；④ **前置「已交付待确认」（`delivered`）不算 `done`**（就绪只认 `done`；要推进先 `close` 或等超时，别重复派下游）；⑤ **同一 worktree 检出必须用 `dependsOn` 串行**（两个任务写一个检出让后一个排队，或各建检出）。
- **文案单源**（`src/copy.js` 的 `TASK_CHAIN_LINES` / `TASK_CHAIN_TOOL_DESC` / `TASK_CHAIN_WAITING_NOTE`）：L1 段、`task_create.dependsOn` 描述、`waiting_dep` 创建回执**三处逐字同源**；`PROMPT_LAYERS` 的 L1 登记归属，`layerViolations` 新增 L2/L3 探针（任务链是协调者的派单判断，子会话只读前置事实）。
- **工具描述同步**：`task_create.dependsOn` 从「依赖全部完成后才派发；任一前置失败则本任务失败」扩成完整五条——只写「会等待」会让协调者以为要自己盯，反而不敢用；`waiting_dep` 回执补一句「依赖完成由插件队列自动晋升（不占回合，不用轮询）」。
- **文档**：README（「依赖、分组、写域、优先级」节 + §6 协作节奏）、`docs/ARCHITECTURE.md`（依赖节新增协调者规则一条）、`docs/testing.md`（里程碑表新增一行）。

**行为变更（用户可感知，3 条）**

1. 有先后关系的需求不再「先派 A，等 A 交付后再派 B」：协调者在派 A 的同一回合就把 B 建好并挂 `dependsOn`，A 完成（确认或超时）后 B 自动开始，不占协调者回合；
2. B 在前置**已交付但未确认**（`delivered`）时会一直等——这是既有语义（依赖就绪只认 `done`），现在写进规则：协调者会明确告诉你「要推进就先确认或等超时」，而不是重复派单；
3. 前置失败/取消时下游立刻失败并写明原因（一直如此，现在规则里也说了）。

**不变**

- 派发语义、状态机、权限、`src/deps.js` 的晋升/失败传播、队列、工具面（10 个）、配置面（22 键）、brief 行数（4–6）、两段式交付、推进循环与交互三闸门、面板与客户端行为：**一行代码不改**。规则与既有口径互相引用、不推翻（禁止轮询 / 能直接回答就不派任务 / 交付两段式），并如实标注「晋升是执行层硬机制，建不建链是提示词判断」。

**验证**

- 新增 `test/task-chain-policy.test.js`（9 条：段位置在推进循环之后、worktree/写域之前；五条规则齐全且逐字来自 `copy.js`；`task_create.dependsOn` 描述逐字同源；`waiting_dep` 回执写明自动晋升；机制与文案一致——用 `dependencyState`/`promoteDependents` 证明 delivered 不晋升、done 晋升、失败沿链传播；L2/L3 探针；与既有口径兼容；文案单源；README/ARCHITECTURE 同口径）；`test/prompt-layers.test.js` 加「任务链归 L1：五条规则逐字来自 copy.js」；`test/tools.test.js` 的依赖用例加「回执写明自动晋升、不占回合」两条断言。
- 全门禁：`node --test` 全量 = **1,158 项 / 1,145 pass / 1 fail / 12 skip**；其中 1 fail + 12 skip 全是**沙箱环境限制**（`spawnSync(..., {stdio:'pipe'})` 与文件符号链接在本机受限沙箱里 EPERM，`test/config-schema.test.js` 那条「真实模块加载」与符号链接用例需要完整权限；仓库既有的 `canSpawnWithPipes()` / `canCreateFileSymlink()` 探测已把相关用例标 skip）。`check:docs`（**1,635 行 / 预算 1,800**）/ `check:version`（0.28.0 三处一致）/ `check:client-size`（148,323 B / 151,552 B，余 3,229 B）全绿。
- 本次**未改客户端源码**（`client/**` 零改动），`dist/client.js` 保持入库的 148,323 B、无需重建；隔离 web 冒烟已证明平台 serve 的产物与该文件逐字节一致（见下）。`pnpm run build` 需要 esbuild 子进程，本次受限沙箱不允许 `spawn`，因此「重建后 dist 与源码一致」这一步留给发版任务在完整权限下复核（本次改动不含客户端源码，重建产物应保持同一 SHA-256）。
- **发版前本机 web 冒烟（0.28.0 本地 tgz，隔离 `DSH_HOME` + 独立 web profile，空闲端口，不碰 49682）**：结果见下方「冒烟记录」。

**冒烟记录（0.28.0 本地 tgz）**

- **环境**：Windows 11 + DSH `0.2.2-rc.5`；隔离 `DSH_HOME=<临时目录>/dsh-home` + 独立 profile `web`（`dsh plugin --profile web add <0.28.0 本地 tgz>`，pnpm store/cache/`npm pack` 全指到临时目录）、`dsh web --no-open --port 49791`（空闲端口，**不碰 49682**），真实 `~/.dsh` 零读写；用完关服务、删临时目录。
- **结果 18/18 ✓**：① token 换 cookie 后壳页 200，壳 HTML 已登记 `@wjj865-code/dsh-orchestrator/client.js`（`rev=f9f611e3426d`）；② `/plugins/??…/client.js` **200 / 148,374 B**，正文与入库 `dist/client.js`（148,323 B）**逐字节一致**（差的 51 B 全是平台 serve 时追加的 `;\n` 分隔符 + 改写成 `??…&rev=…` 的 `sourceMappingURL` 尾行）；③ 插件日志 `snapshot.created` / `host.capabilities`（rc.5，8/10 能力，缺 `registry`/`team-board` 属该隔离环境预期）/ `preset.keep` / `preset.deny` 齐全、**零 error / 零 warn**；④ `POST /api/orchestrator` 的 `snapshot` / `session-role` / 工作台只读 `groups` / `calendar` / `automations` / `stats` 全 200（`snapshot` 带 `tasks` / `mainSession` / `teamBoard` 降级说明），反例 `task-create` 返回 400 `UNKNOWN_ENDPOINT`；⑤ 产物内工作台六页 `data-page` 标记、dock 组件**无 input/textarea/form**、排期待排 tray、自动化清单、复盘统计、五页导航标记全在。
- **未验（附原因）**：真实浏览器里的交互（打开面板、切六页、拖拽排期、dock 渲染、复盘页三态）——该环境没有浏览器自动化，只做了产物静态核对 + 接口核对；`open-main`（建/开主会话）——隔离 home 没有模型凭据，且与本冒烟目标（插件加载 + 面板可用）无关。
- **证据**（临时目录，未入库）：`smoke-0.28.0.json`（逐项结果）、`probe-0.28.0.mjs`（探针脚本）、`plugin-startup.log.jsonl`（插件启动日志）。
- **前置条件**：前置任务对**已发布 0.27.0** 的隔离 web 冒烟已交付、结论无阻断（见其交付回报）；本次未用 0.27.0 冒烟替代 0.28.0 冒烟。

## 0.27.0（2026-11-21）—— 工作台 v1（组 / 排期 / 自动化 / 复盘 / 只读 dock）+ 推进循环

本版两批：任务台改版为**工作台 v1**（五页 + 复盘页、常驻只读 dock、排期两层、原生自动化桥），以及交互收紧为**推进循环**（收到回报后必须推进、不许只汇报）。

**升级注意**：装 `@wjj865-code/dsh-orchestrator@0.27.0` 后要**彻底退出 DSH 再启动**（刷新页面无效），客户端产物与新预设才生效；台账只做增量 DDL（多 `groups_v1` / `automations` 两张表 + `tasks.planned_at` 一列），旧库直接可用、无需手工迁移，代码回滚时新表/新列留着也无害。

**工作台 v1（P11）**

- **工作台六页**（`client/src/workbench.js`，挂在原 `main` 槽位面板 `orchestrator` 内部导航，不新增第二个 main key）：总览（指标 + 收件箱 + 今日排期 + 最近产物）、任务组（组卡网格 + 未分组虚拟卡）、组工作台（状态列板 + 右侧 dock + 详情抽屉 + 产物格）、排期（月历 + 下一条 + 待排 tray）、运行与自动化（清单 + 新建 + 暂停/恢复/删除 + 降级）、复盘（7/30 天窗口的交付/确认/平均时长 + 失败归因 + 产物类型 + 组排行，见下）。交互骨架参考消费级工作台插件（单快照渲染、白名单写入口、常驻 dock、日历拖拽、三态齐备），不带 i18n / 示例数据。
- **组成为一等维度**：新增 `groups_v1` 表（表名带 `_v1` 因为 `GROUPS` 是 SQLite 窗口帧关键字）。`groups_v1.id` **就是** `tasks.group_id` 且不可变——worktree 检出复用（`src/worktree-request.js` 的 `findReusableCheckout`）与 `task_list({ group })` 都按这个字符串判定，改键会静默漂移。改名只改 `name`；要改键只能走显式批量迁移（本版不提供入口）。启动时 `backfillGroups()` 幂等补元数据行（`INSERT OR IGNORE` + `settings.groups_backfilled_at`；**没有任何组时不写 settings**，保住「仅仅打开台账不写 settings」这条既有不变量）。没有元数据行的组按「虚拟组」读（名字回落 id，第一次改名时补行）。
- **排期两层，互不推导**：L1 `tasks.planned_at`（人工计划日，纯展示，工作台 `plan-set` 写）；L2 `automations` 表（镜像 + 授权审计）+ 宿主 `ctx.schedule`（真身，到点投递 `target: { kind:'session', sessionId: 唯一主会话 }`）。日历上排一天**不会**自动派任务，创建自动化也**不会**改 `planned_at`——否则会变成「拖一下 = 授权定时派单」的隐性授权。
- **自动化桥接**（`src/workbench.js`）：创建/暂停/恢复/删除走宿主 `schedule.create / view / edit`；`timing` 只接受白名单形状（`daily` / `weekly` / `cron` / `rrule`），与宿主 `ScheduleTiming` 逐字对齐（形状已用 asar 探针核实，**不与工具层的 rrule 混用**）；下次触发取宿主 `record.scheduledAt`，读不到就显示「未知」而不是猜。宿主没有 schedule 服务时整页只读降级（`available:false`，写动作回 `AUTOMATION_UNAVAILABLE` 502）。
- **新端点**（`POST /api/orchestrator`，owner-only + `clientRequestId` 幂等 + 危险动作 `confirm:true` + 审计日志）：只读 `groups` / `group` / `calendar` / `automations` / `stats`；写 `group-save` / `group-archive` / `plan-set` / `automation-save` / `automation-toggle` / `automation-delete`。**刻意没有** `task-create` / `plan-approve` / `close-all` / `patch-task`（反例清单，`test/host-route.test.js` 断言它们仍是 `UNKNOWN_ENDPOINT`）。
- **门控纯函数**（`src/panel-gates.js`）：`planSetGate`（终态不给排期）、`groupSaveGate`（未归档 + 名字 1–40 字）、`groupArchiveGate`（要二次确认）、`automationGate`（先报「宿主没这个能力」再报「没这条记录」）；`snapshot`/`group` 下发 `canPlan` / `canRename` / `canArchive` 布尔值，按钮可见性与动作可执行性同源。
- **右侧 dock 只读**：显示选中对象摘要、最近消息、阻塞项（`blocked` 的 question/options 只读）与「到主会话说」跳转；**没有输入框、没有发送按钮**（`test/client-workbench.test.js` 断言）。不新增发消息通道：面板「追加消息」仍只走协调者 `task_message`，计划批准仍只能由用户拍板。

**阶段 3 · 复盘页（只读统计 `stats` + 第 6 页）**

- **只读端点 `stats`**（`{ days }`，缺省 7、夹到 ≤62）：窗口内**交付数**（`delivered_at` 落在窗口）、**确认数**（`accepted_at` 落在窗口）、**平均「创建→交付」时长**（仅统计窗口内交付且 `created_at` 可知的行，无交付时为 `null`）、**失败归因**（窗口内 `updated_at` 且状态 `failed`/`orphaned`，按 `tasks.error` **首行**截 60 字归类，最多 5 类，无错误信息时如实写「没有错误信息」）、**产物类型分布**（窗口内创建或交付的任务，按路径扩展名归类、去重、最多 8 类，**不读文件内容**）、**组维度排行**（交付 / 失败 / 总数，最多 10 个组，「未分组」单列）、**窗口内 messages 条数**。数据源只有台账既有时间戳 + 既有产物登记 + `messages.at`（新增只读 `countMessagesBetween`，**无 schema 变更**）。
- **复盘页**：导航第 5 项（工作台第 6 页），7 / 30 天切换、三态齐全（骨架 / 错误 Banner + 重试 / 空态）、窄屏单列；图表只用数字卡 + 横向条 + 排行行，**不引图表库**；只读，不新增任何写口（`test/client-workbench.test.js` 断言页面里没有 `workbenchAction` / `clientRequestId` / `confirm: true`）。
- **体积**：复盘页从组工作台 / 排期 / 自动化三页各让 1 KiB 进子预算表（新增「复盘页 ≤ 3」，合计仍 = 148 KiB），**没有抬预算、没有删既有功能**；重建后 `dist/client.js` = **148,323 B（144.85 KiB）**，余 3,229 B。

**推进循环（交互收紧：报告之后必须推进，不许只汇报）**

- **L1 推进循环段**（`src/prompt-layers.js` 的 `renderAdvanceLoopPolicy()`，`renderCoordinatorPolicy()` 拼在三闸门之后、worktree/写域之前）：收到任何回报（`progress` / `done` / `delivered` / `blocked` / `needs_auth`）或用户消息后，协调者必须落到三类动作之一——**推进**（按已批准计划 `task_message` 续派/追问同一子会话，或已授权时 `task_create` 继续做）、**提问**（`ask_user_question`，2–4 个选项带建议、多个待决合成一条清单）、**问新任务**（仅无活跃且无待确认时问「还有新任务吗」）——**禁止只输出汇报文字**。另四条：已批准计划（`plan_state=approved`）批准后立即续派实现、不许只回确认；卡点（B1–B4）与待拍板必须提问、不能拖也不能自批；全部完成先问新任务、同一事件只问一次、不答不重复轰炸，也不许宣称「已全部完成」然后静默；与既有口径的边界写死（问新任务 ≠ 问能否关闭、交付仍默认待确认、T0 直答不违反、软门禁不假装硬拦截）。
- **通知动作指令**（`src/notify.js`）：`done` / `delivered` / `blocked` / `needs_auth` 的通知末尾各贴一行「下一步：推进 / 提问 / 宣布完成前先问新任务——只输出汇报文字不算推进」；打断级（blocked / needs_auth）的即时通知也带。`progress` 仍只贴它自己的追问指令（不重复「下一步」），结算异常（failed / cancelled / orphaned）只报事实。
- **文案单源**：句子本体在 `src/copy.js`（`ADVANCE_LOOP_LINES` / `ADVANCE_NOTICE_HINT`），policy 与通知逐字同源；`PROMPT_LAYERS` 的 L1 与 NOTIFY 条目登记了这条归属，`layerViolations` 新增 L2/L3 探针（推进循环与「还有新任务吗」属 L1，子会话不许复述）。

**行为变更（用户可感知，5 条）**

1. 任务面板变成六页工作台：原来的「筛选轨 + 任务卡列表」收进总览页（筛选与搜索不变），新增组 / 排期 / 自动化 / 复盘；2. 可以在面板里给任务排计划日（只写 `planned_at`，不改状态、不派发）；3. 可以在面板里创建/暂停/删除「到点让协调者派单」的自动化（二次确认 + 授权勾选 + 审计），目标固定为唯一主会话；4. 新增「复盘」页：按 7 / 30 天看交付、确认、平均交付时长、失败归因、产物类型与组排行（纯只读统计，数据来自台账既有时间戳）；5. 回报之后协调者不再只回一段「XX 完成了」：要么续派/追问、要么结构化提问、要么在全部完成时问一句「还有新任务吗」——`done` / `delivered` / `blocked` / `needs_auth` 的通知末尾也多一行动作指令，已批准的计划在批准后立刻续派实现。

**预算变更（用户拍板 D1：95 → 128 → 148 KiB）**

- 客户端体积闸门 **95 KiB → 148 KiB**（`scripts/check-client-size.mjs`），并在脚本头部写死子预算表（改版前已有 ≤93 / 工作台壳 ≤6 / 总览 ≤5 / 任务组 ≤7 / 组工作台 ≤8 / dock ≤5 / 排期 ≤8 / 自动化 ≤6 / 复盘 ≤3 / 工作台样式 ≤7，合计 = 148；阶段 3 加复盘页时从组工作台/排期/自动化各让 1 KiB，总预算不变）。
- **决策过程**：改版前产物 95,402 B（余 1,878 B），平台只 serve 一个 `client.js`（无代码分割）。先按估算定 **128 KiB**；实施完成后实测（同版 esbuild 计量 JS 116,910 B + 内联 CSS 38,644 B，按 vite 与 esbuild 旧产物差 −8,956 B 校正）真实产物 **143–146 KiB**，128 KiB 差 12–16 KiB。用户明确要求「保留全功能、不削减」，因此拍板 **148 KiB**（余约 2–5 KiB）。**没有第三个档位**：超 148 KiB 就回头删重复渲染/收敛样式，不自行加预算。
- `docs/testing.md` G10 同步改成「148 KiB + 子预算表逐块核算」并写明这次调整的原因；README/docs/脚本里 95 / 128 的旧数字一并改成 148（**历史 CHANGELOG 条目保持当时口径**，不改写）。

**不变**

- 派发语义（`task_create` 仍只由协调者调用，工作台的「新任务」只生成派单草稿）、计划批准四步与「计划中任务收到追加消息即批准」、交付两段式（`delivered` 仍需确认或超时才 `done`）、权限模型（协调者仍钉 `read-only`、子会话沙箱不变）、同写域默认拒绝、worktree 与 planFirst 互斥、2s 轮询无 SSE、产物预览仍走宿主右侧栏、面板动作门控与错误码同源。全局工具仍 **10 个**，配置面仍 **22 键**。推进循环是提示词层改动：没有新增工具、没有自动代批、没有执行层拦截，也不改派发/状态机/权限。

**已知限制**

- **推进循环是软约束**：插件不检查协调者这一回合是否真的调了 `task_message` / `ask_user_question`，也没有「只汇报就重试」的拦截；模型仍可能只输出汇报文字。「同一事件只问一次」也不记账（只在模型上下文里）。详见 `docs/LIMITATIONS.md`「交互规范（软约束）」。
- **复盘页口径**：平均时长只统计窗口内交付且 `created_at` 可知的任务（跨窗口不回溯）；失败归因取 `tasks.error` 首行（相同即合并、截 60 字）；产物只按扩展名归类（不读文件内容，扩展名超 8 字符归「其他」）；组排行只统计窗口内有活动的组；15s 轮询不是实时流；窗口上限 62 天、不支持自定义起止日期。

**验证**

- 新增 `test/workbench.test.js`（16 条：timing 归一与文案、组卡统计、日历分桶、backfill 幂等、组改名/归档、排期写清与终态拒绝、自动化全链路与降级、门控矩阵、复盘投影 `reviewStats` 的窗口/归因/产物/排行口径、`createWorkbench.stats` 只读不改台账）；`test/host-route.test.js` 增 7 条（只读端点、`stats` 端点（days 缺省 7 / 上限 62 / 非法回落）、未装配 500、反例端点 400、`plan-set` + 幂等、`group-save`/`archive`、`automation-*` 全链路与 502 降级）；`test/client-workbench.test.js` 新增 10 条（月历格 / 拖拽换算 / 看板列 / 待排与下一条 / dock 无输入框 / 复盘页导航与三态 / 客户端无派发与批准端点 / 面板不新增 main key）；`test/ledger.test.js` 表集合断言同步到 7 张表。
- **体积实测**（`access:'full'` 收尾任务真的重建了产物）：`pnpm run build`（vite 7.3.8 + esbuild minify，sourcemap 保留）→ 工作台 v1 首版 `dist/client.js` **142,811 B（139.46 KiB）**，距 148 KiB 预算余 8,741 B；**阶段 3 复盘页加入后 148,323 B（144.85 KiB）**、`dist/client.js.map` 380,700 B，余 **3,229 B**。`pnpm run check:client-size` 两次都 exit 0（最后一次输出「客户端体积在预算内：144.8 KB (148323 B) / 预算 148.0 KB (151552 B)」）。
- **全门禁**（本版定版时）：`pnpm test` = **1,148 项 / 1,143 pass / 0 fail / 5 skip**（5 条 skip 全是「当前环境无法创建文件符号链接」的环境跳过，与本次改动无关）；`check:docs`（1,632 行 / 预算 1,800）/ `check:version`（0.27.0 三处一致）/ `check:client-size`（148,323 B / 151,552 B）均 exit 0。过程里程碑：工作台 v1 首版 1,140 项 / 1,135 pass；阶段 3 复盘页 1,145 项 / 1,140 pass。
- **推进循环的测试**：`test/prompt-layers.test.js` 断言 `ADVANCE_LOOP_LINES` 每句逐字出现在 `renderAdvanceLoopPolicy()` 与 `renderCoordinatorPolicy()`、L1 `owns` 登记措辞源、L2/L3 探针命中即失败、`ADVANCE_NOTICE_HINT` 归 NOTIFY 且不重复能力边界；`test/interaction-policy.test.js` 断言五条规则、位置（三闸门之后 / worktree 之前）、与「不催关闭」「T0 直答」的边界、`BLOCKER_RULE` 只出现一次、软门禁措辞；`test/notify.test.js` 断言四种状态通知都带动作指令、progress 与结算异常不带（三条原文案断言改为「首行 + 动作指令」口径，标签断言意图不变）。
- **重建暴露并修掉的一处失败**：重建 `dist/client.js` 后 `test/client.test.js` 的面板首帧用例报 `t.useMemo is not a function`（9 条）——根因是那份「最小 React 垫片」没实现 `useMemo`（工作台 v1 在 `views.js` 里用它读 `sessionStorage`），与 `test/client-config-form.test.js` 的垫片口径不一致。垫片补上 `useMemo` 与 `useState` 惰性初始值求值（React 语义，槽位被用例预置时仍以预置值为准）后 49 条全绿，**没有改动任何断言、没有删用例**。

## 0.26.0（2026-11-21）—— 交互三闸门：开工前确认、执行期少打扰、改动先评估

**新增**

- **L1 新增 `renderInteractionPolicy()`**（`index.js`）：协调者每回合都在的第三段结构化 policy，拼在硬规则之后、worktree/写域之前。三件事——① **判级 T0–T3**：能直接答就不派（T0）、单点可回退直接做并回一句「我的理解：…」（T1）、现象/多方案/改可见默认行为/歧义先 `ask_user_question` 问一次（T2）、跨仓库/动 5 个以上文件/重构迁移/不可逆/推远端或发布/写仓库外 → `task_create({ planFirst: true })` 先出计划再动手（T3）；判级只做一次，不可逆永远最低 T2。② **执行期四类堵塞项**（B1 验收/范围不可达、B2 要新授权、B3 子会话 blocked 且选项要用户定、B4 工具面外查不到），其余（进度、能否关闭、可给默认值的细节）不算堵塞项、不打扰；一个堵塞项只问一次。③ **追加调整 R0–R2**：先评估（影响面/风险/建议）再确认，最后才 `task_message`；R0 直接转原会话、R1 要确认、R2 必须拍板。
- **文案单源**：`src/copy.js` 新增 `BLOCKER_RULE`（L1 与 brief 的 `BLOCKED_HINT` 共用）与 `CHANGE_REVIEW_FIELDS`（L1 与 `task_message` 描述共用）；brief 的「执行中待确认」改为只报堵塞项（brief 仍 4 行）；`task_create` / `planFirst` / `task_message` 三处工具描述带上 T3 与评估要素。
- **既有硬规则收紧**：「需要先看方案再动手…可用 planFirst」升级为「复杂任务必须走计划闸门」；「少打扰」明确限定为**执行期**口径；开工前意图确认与追加评估确认都归「需要拍板」，同样走结构化提问。

**行为变更（用户可感知，4 条）**

1. 复杂需求（T3）先出一份计划文档并要求批准，不再直接开写；2. 简单需求（T1）仍不提问，但会先回一句「我的理解：…」；3. 执行期提问收窄到四类堵塞项，每个问题带建议、只问一次；4. 用户追加调整会先收到「影响面/风险/建议」评估，确认后才动子任务（R0 直接转原会话）。

**不变**

- 工具面（10 个）、配置面（22 键）、状态机、两段式终态、`planFirst` 审批四步与「计划中任务收到追加消息即批准」的平台行为、brief 行数（4–6）、通知分级、面板与客户端行为，一字不改。三闸门是**提示词软约束**，没有执行层门禁（边界见 LIMITATIONS「交互规范（软约束）」）。

**验证**

- 新增 `test/interaction-policy.test.js`（8 条：段的顺序、T0–T3 表、堵塞项与 brief 同源、不算堵塞项清单、R0–R2、顺序闸门、不可逆最低 T2、与既有口径互引）；`test/brief.test.js` 改锁堵塞项四类（原「业务取舍/方案歧义」泛问口径已收窄到开工前）；`test/copy-consistency.test.js` 加三闸门正向断言与「堵塞项/评估要素只许在 `src/copy.js`」的静态断言；`test/prompt-layers.test.js` 加 L1 owns 与 L2/L3 探针。文档：README 新 §6「协作节奏」、ARCHITECTURE 新节、LIMITATIONS 新「交互规范（软约束）」、testing 断言口径一行。`pnpm test` / `check:docs` / `check:version` 全绿。

### 同批（`t-48e8ce06`）：技能 + 只读工具（A 片 grill-me / B 片 tool-scope）

按 `t-8b583258` 调研与用户拍板「A + B，接受默认（deny-keep）」实施。**版本不另 bump**：0.26.0 尚未发布（`package.json` / CHANGELOG 首条 / README 版本号都还是 0.26.0，且工作树里还有同批未提交改动），所以并入同一批。

**新增**

- **A 片：grill-me 技能随包发**。新增 `skills/grill-me/SKILL.md`（frontmatter：`name: grill-me` / `description` / `whenToUse`）与根模块 `skill-grill-me.js`：`apply()` 用 `import.meta.url` 读包内 SKILL.md → 解析 frontmatter → `ctx.skills.register({ name, description, whenToUse, content, source: 'bundled', path })`。注册进的是**调用方 context 的作用域层**，所以只对协调者预设可见（worker 预设不挂该模块）。协调者预设新增两行：`skill-grill-me`（`@wjj865-code/dsh-orchestrator/skill-grill-me`）+ `tool-skill`（`@deepseek-ai/dsh-tool-skill`，模型面 `skill({name})` 与技能目录）。`package.json` 增加 `exports['./skill-grill-me']`，`files` 增加 `skill-grill-me.js` 与 `skills/`（否则技能文件不发货）。SKILL.md 缺失/坏格式只 warn、不注册——技能是增强项，不能让预设挂载失败。
- **协议（草案落地）**：多轮前沿提问（一次只问一个决定性问题）、每问带我的推荐、事实自己查、决策归用户、最多 **2 轮 8 问**、最后给「决策点｜你定的｜影响」三栏决策记录、与交互三闸门 T2/T3 衔接、**grill ≠ 批准**（不替代 T2 确认，也不替代 T3 计划批准）。灵感来自 Matt Pocock 的 grilling（MIT），措辞重写，未复制任何 GPL 版本。
- **B 片：协调者只读工具面**。协调者预设新增 `tool-fs`（`read: true`，`write`/`edit`/`applyPatch`/`readImage` 全 `false`）与 `tool-fs-search`（`sampleOverCapGlobResults: false`）→ 协调者拿到 `read` / `glob` / `grep`，工具表里仍然没有写工具；`bash`/`pwsh` 不挂。`COORDINATOR_DENY` 从「文件/命令/团队/子任务/密钥」大名单缩到**编排正确性清单**（`wait_agent`、`spawn_teammate`/`send_message`/`list_agents`/`interrupt_agent`、`team_task_*`、`plugin_manager`、`request_secret`/`request_connector`、IM/bot 8 个）。角色专属的 `task_report`/`task_detail`/`plan_save` 从执行层名单移出、改由协调者预设的 `preset-tools` `deny` 遮掉（工具表里看不到；执行层仍按任务归属拒绝越权调用）。
- **preset-tools 协调者改遮挡式**：`allow` 补集 → `deny`（编排正确性 + 三个角色专属）+ `keep`（7 个任务工具，挂载后校验并写 `preset.keep` 审计）。与 worker 同形，`preset-tools.js` 的 `allow` 形态保留兼容旧 profile/探针，但本插件不再使用。

**行为变更（用户可感知，4 条）**

1. 协调者现在能只读看文件（`read`/`glob`/`grep`）——核对子会话改动、读 target 与技能文件不用再派任务；2. 协调者能用 `skill({name})` 加载技能，系统提示里会多一份只有 `grill-me` 的技能目录；3. `COORDINATOR_DENY` 缩到编排正确性清单：`write`/`edit`/`bash`/`pwsh`/`web_search`/`job_*` 等不再被协调者 guard 硬拦（但协调者预设本来就没挂它们，工具表里仍然没有）；4. T2/T3 开工前会先按 grill-me 拷问需求（一次一问、每问带推荐、最多 8 问、给三栏决策记录），再走原来的确认/计划批准。

**不变**

- 插件全局工具数仍 **10 个**（协调者可见 7 + 子会话专属 3），`test/index.test.js` / `test/tools.test.js` / `test/tool-migrations.test.js` 的 10 条工具断言没动；配置面 22 键；状态机、两段式终态、计划批准四步、面板与客户端；协调者默认权限仍是钉死的 `read-only`（不新增「工作区只读」档位）；`read_workspace` 保留（受控产物读，1.0 前不退役）；worker 预设与子会话不见 grill-me、读取面不变。

**验证**

- 新增 `test/skill-grill-me.test.js`（7 条：SKILL.md frontmatter 合规、协议要点齐全、注册进 skills 的参数形状、缺文件只 warn、坏 frontmatter 可读报错、注册失败只 warn、正文随文件走/名字不匹配拒绝）；`test/config.test.js` 改锁协调者预设（`read`/`glob`/`grep`/`skill` 已挂、`tool-fs` 只开 `read`、worker 不挂 `skill-grill-me`、deny/keep 名单、`package.json.exports`/`files`）；`test/index.test.js` 改锁 deny 名单与 guard（只读工具放行、编排正确性项仍拒、角色专属工具改预设层）；`test/prompt-layers.test.js` 加 L1 grill-me 触发语与只读工具说明；`test/plan-save.test.js` 改断 `plan_save` 在预设 deny。文档：README「工具清单」新增「技能与只读工具」一节 + 权限徽标/交付口径/已知限制同步、ARCHITECTURE 新节 + 工具面/权限/L1/收窄形态、LIMITATIONS 新「协调者读文件」一节、testing G8 与断言口径。`pnpm test` / `check:docs` / `check:version` 全绿。

**风险与取舍（待确认）**

- **`read`/`glob`/`grep` 能读全盘**（含 `~/.dsh/.credentials.yaml`、`.env`、SSH key、token），插件只靠 L1 提示词要求「不读凭据、不转述」，没有路径黑名单/执行层拦截——这是本批的主要残余风险，已在 README「已知限制」与 LIMITATIONS 写明。
- **`bash`/`pwsh` 仍未挂**（B 片只到只读文件工具）；用户手切 `full` 时沙箱不再挡写，但工具面不变（协调者仍然没有写工具/命令工具），插件也不额外提示。
- **版本**：并入 0.26.0，不单独 bump（见本批开头）；若要单独发版，改动仅在 CHANGELOG 分段与版本号。

**发版前修正（真机复验补漏，`t-740b8b7a`）**

- **协调者工具表多出宿主全局 `working_directory`**：0.26.0 把协调者 `preset-tools` 从 allow 补集改成遮挡式 `deny` 后，`@deepseek-ai/dsh-tool-working-directory` 不再被顺带遮住，出现在真机工具表里（证据与影响见 `reports/skill-and-readonly-tools-verify/README.md` §9）。处理：**选「加进名单」而不是「补文档」**——它改的是协调者会话 cwd，而 cwd 是指挥锚（`task_create` 未给 target 时子会话继承它、工作区/写域判定与 `projectKeyOf` 推断都以它为准），会话内切目录会让这些锚点静默漂移；协调者看文件用 `read`/`glob`/`grep` 的绝对路径，不需要切目录。落点：协调者预设 `preset-tools.deny`（出生即遮）+ 执行层 `COORDINATOR_DENY`（硬拦兜底）两处；文档 README「技能与只读工具」/「打开主会话」、ARCHITECTURE B 片段、LIMITATIONS「协调者读文件」写明清空口径；`test/config.test.js`（deny 必须列、keep 不能列）与 `test/index.test.js`（执行层名单必须含）双锁。`pnpm test` / `check:docs` / `check:version` 全绿。


## 0.25.1（2026-11-21）—— 主会话权限徽标一致：协调者钉 `read-only`

**修正**

- **主会话权限徽标与协调者工具面对不上**：协调者预设没有 `read`/`write`/`bash`，但宿主给新会话 pin 的默认权限预设有 `workspace-write`，输入区徽标就显示「工作区写入」——徽标说能写、实际什么都写不了。现在协调者会话的 `permission preset` 显式钉成宿主出厂预设 **`read-only`**（沙箱 `read-only` + 审批 `ask`），徽标显示「Read Only / 仅可查看」，与实际工具面一致。
- **写路径** `ctx.permissionPresets.set(session,'read-only')`（`src/main-session.js` 的 `pinPermission`）：追加 `permission/preset` + `sandbox/mode` + `approval/policy` 三条会话事件，`permissions` 投影（徽标数据源）随之变。覆盖四条路：`open` 新建、压力卡代建、adopt（会话头「设为协调者」）、复用已有主会话时把用户切走的预设拉回（日志 `main.session.permission-pinned`）。已经只读时什么都不追加。
- **不挡打开主会话**：钉失败只记 `main.session.permission-pin-failed`（例如宿主预设表里没有 `read-only`），老宿主没有 `permissionPresets` 服务时整段降级为「不动权限」。
- **配套（子会话不受影响）**：宿主会把父会话的显式 `sandbox/mode` 覆盖按 `source:'delegation'` 种进子会话，主会话只读后不写回来普通子任务会跟着只读。`src/dispatch.js` 因此对普通任务显式钉 `workspace-write`（日志 `subagent.workspace-write`），只读/计划任务照旧 `read-only`、`access:'full'` 照旧 `danger-full-access`。**行为不变**（普通子任务仍 `workspace-write`），只是子会话日志里多一条幂等的 `sandbox/mode` 事件。
- **口径（不是锁）**：宿主没有锁权限选择器的 API——`/permission` 与输入区选择器仍可切走（宿主的 `locked` 只针对 agent 预设 `agentPresets.select`），插件只在下次打开主会话 / adopt / 协调者 `agent/created` 时拉回。旧主会话在升级后的下一次观察点变只读；插件不改宿主全局 `permission.defaultPreset`。
- 文档：README（三分钟跑通 + 已知限制）、ARCHITECTURE（主会话权限段 + 子会话沙箱注入段）、LIMITATIONS（新增「主会话权限徽标」一节）同步；单测覆盖新建/幂等/失败降级/复用拉回/adopt/代建六条路。

**不变**

- 协调者工具面不变（仍无 `read`/`write`/`bash`）；配置面不变（22 键）；普通任务派发、可写根、只读/计划/完整访问口径除「普通任务显式钉 workspace-write」外一字不改。

### 同批（`t-99d4a98c`）：progress 通知必达——追问后主会话不再收不到消息

#### 修正

- **`task_report(progress)` 不再静默**：通知分级里 `progress` 从 `silent` 改成 **`coalesce`（默认送达）**。旧口径下 `notifier.push` 第一行就 return——不进合并窗口、不 `steer` 协调者、连 `notifications` 审计行都不写，于是「追问 → 子会话先报部分结论 → 继续跑」这条路径对主会话永久不可见（实测 t-1f70bedb：追问后子会话回了 `[progress]`，主会话 0 消息，15 分钟后只剩看门狗）。
- **追问必达（结构性判据，不是补丁）**：台账新增 `tasks.report_expected_at`——`task_message` / `resume` **投递成功后**置位（面板「追加」同口径），下一份回报带 `answeredFollowup`，progress 据此跳过水位与合并窗口**立刻送达**；回报一到就清标记，只对第一条生效。扩展了 A 方案（原本靠「最近一条 followup」猜），落成能跨回合、跨重启的台账事实。
- **不刷屏：5 秒合并窗口 + 同任务 60 秒水位（尾沿补投）**：合并窗口内同一任务的第二条 progress 覆盖前一条；水位内只留最新一条、到水位线补投（最后状态不丢）；已被同窗口的 `done`/`blocked` 取代的旧 progress 直接撤掉（同一批里既列「有新进展」又列「已交付待确认」是噪音）。`done` / `blocked` / `needs_auth` 的既有语义与合并窗口一字不改。
- **每条 progress 都有审计行**：送达写 `delivered`；被水位压住/窗口覆盖/被终态取代写 `skipped` + `reason: progress_watermark | progress_merged | progress_superseded`（旧口径连行都不写，这是「主会话为什么没收到」唯一好用的判据）。
- **通知文案**：progress 通知写「有新进展」（追问后的第一条写「有新进展（回答你的追问）」），并附一句动作指令——这是进度信号不是终态，要结论就 `task_message` 追问同一子会话，别为此重派任务；L1 协调者 policy 同步这条口径（共用语在 `src/copy.js` 的 `PROGRESS_NOTICE_HINT`）。
- **投递失败不占水位**：`skipped`/`failed` 会撤回水位，否则一次「主会话没打开」会连带压住接下来的 progress；卸载时 `drain`/`flushNow` 把压住的 progress 一并送掉。
- 改了什么：`src/notify.js`（分级 + 合并/水位/尾沿 + 文案）、`src/ledger.js`（`report_expected_at` 列与迁移 + `markReportExpected`/`clearReportExpected`）、`src/tools.js`（追问/续跑置位、回报读标记并清）、`src/panel-actions.js`（面板「追加」同口径置位）、`src/copy.js`（`PROGRESS_NOTICE_HINT`）、`index.js`（L1 一条 policy）。文档：ARCHITECTURE「回报、通知」、LIMITATIONS「通知与生命周期」、README「看进度 / 工具清单」、testing 行。
- 验证：`test/notify.test.js`（默认送达、同窗口合并、水位尾沿、追问必达、被 done 取代、失败不占水位、卸载不丢行）、`test/tools.test.js`（置位/清标记/必达透传/投递失败不置位）、`test/ledger.test.js`（新列与旧库迁移）、`test/resume.test.js`（续跑置位）、`test/panel-actions.test.js`（面板追问置位）、`test/copy-consistency.test.js`（L1 与通知逐字同源）、`test/integration.test.js`（端到端：追问 → 子会话先报 progress → 主会话**立刻**收到；后续 progress 走水位并留 `progress_watermark` 行）；`DSH_ORCH_PROGRESS_MS` 只调水位、不改语义（与 `DSH_ORCH_NOTIFY_MERGE_MS` 同档）。

### 同批（`t-3e27f4b4`）：记忆优化 P0——检索范围、质量门槛、淘汰分层、worktree 归一、分块

按 `reports/memory-and-main-session-audit.md` §7 最小落地包与 context 核查（`t-c8df6366`）实施。**行为变更**（升级要留意）见下 1、2、5 三条。

**修正**

1. **`context({ mode: 'history' })` 首行打印【检索范围】**（行为变更：可见性）：不传 `project` 时**只查 `global` 跨项目记忆**，输出首行写明 `【检索范围】global（未含项目记忆）`；传了项目则写 `【检索范围】project: <key>｜+ global（跨项目记忆）`。同时修正 `project` 参数描述（旧文案「不传则查全局+当前项目」是错的）。
2. **`project` 支持 string | string[] | 'all'**（行为变更：多键合并）：数组去重后最多取 **2 个项目键** + 自动带 `global`，合并后统一按分数截 `limit`；`'all'` 不按项目过滤。未知名项目给一行 `【警告】未找到项目「x」`，不再静默回落 global。检索内部新增 `normalizeProjectKeys` / `searchMemories({ projectKeys })`。
3. **质量门槛**：`memoryTokens` 停用词从 7 个扩到 27 个（任务/插件/测试/代码/文件/项目…）；多词查询要求命中 **≥2 个词**或 `score ≥ 2`（decision 的 +2 权重也算），单词查询仍是命中即相关。`pickLayered` 加分层配额：`decision`/`preference` 一次最多 2 条，其余槽位先给 `lesson`/`note`（候选全是决策类时按分数补满）。
4. **`history` 结果分块**：事实层进 `【记忆】`，日志层（`task-log`）单独进 `【任务日志】`、**最多 2 条**、排在事实层之后，不再挤占 `limit` 槽位。
5. **淘汰分层**（行为变更：容量口径）：`task-log` 单项目保留最新 **200 条**（`MAX_TASK_LOG_PER_PROJECT`），**事实层不参与淘汰**；旧「单项目 300 条总量」常量删除——混算会让活跃项目先删手记的 decision/note。README / LIMITATIONS 同步新口径。
6. **worktree 记忆归一**：`task_report done` 的 projectKey 取 `brief.target ?? repo_root ?? target_dir`（以前直接用检出目录，写出 8 个 `.agents/worktrees/t-*` 分裂键）。历史分裂键不迁移。
7. **`context({ mode: 'project' })` 白名单加 `docs/ARCHITECTURE.md`**：默认前 **1200 字**，`include: ['docs/ARCHITECTURE.md']` 给前 **4000 字**；项目背景总输出上限 6000 → **8000 字**；未识别 include 给一行提示，白名单外仍不读。
8. **旧全局偏好迁移**：启动时 `migrateLegacyPreferences` 把 `memories` 里 `project='global'` 的 `preference` 搬进 `settings.orchestrator_preferences`（幂等标记 `orchestrator_preferences_migrated`）；带「更正/修正/纠正/推翻/不再用」标记的条目按共享主题词（≥3）取代旧条目（present 取更正后的 1–4）；写成功后删 memories 行（不双写），失败不写标记、下次重试，没有旧行时不动 settings。
9. **提示词**：L1 硬规则改成「查本项目经验：`context({ mode: 'history', query, project: <target_dir 或工作区名> })`，不传只查 global」；worker persona（`WORKER_CONTEXT_HINT` / `cordis.patch.yml`）同步「查本项目经验要显式传 `project:<target_dir 或工作区名>`」。

- 不采纳审计 §7 第 1 条「默认键改 `defaultDir()`」：核查（`t-c8df6366`）确认协调者 cwd 是指挥舱，推断出的项目键对指挥舱无效；改为「显式 project + 首行可见」。
- 改了什么：`src/memory.js`（停用词/门槛/配额/多键/淘汰分层）、`src/tools.js`（检索范围与分块、多键 scope、ARCHITECTURE 白名单与 include、done 的 projectKey、context schema）、`src/preferences.js`（旧偏好迁移）、`index.js`（启动迁移 + L1 一条 policy）、`src/prompt-layers.js` + `cordis.patch.yml`（persona 措辞）。
- 验证：`test/memory.test.js`（淘汰分层 260→200、事实保留、质量门槛、配额、多键/all）、`test/tools.test.js`（首行检索范围、多键与 all 合并、未知名警告、日志分块 ≤2 且排在事实层后、ARCHITECTURE 截断与 include、worktree 归一）、`test/preferences.test.js`（迁移取更正版、不双写、幂等、无旧数据不写 settings）、`test/prompt-layers.test.js` / `test/copy-consistency.test.js`（persona 逐字同源）；`pnpm test` 全绿。


## 0.25.0（2026-11-20）—— 删轮换、宿主自压、插件只提醒 + 手动 adopt

**破坏性变更（升级须知）**

- **主会话轮换整套删除**：`src/main-rotation.js`（判定 / 12 条保护 / 检查节流 / 采集 / marker 崩溃恢复 / 旧会话改名+归档）下线；`main-session.rotateMain`、`index.js` 的装配与 `recoverPendingRotation` 启动恢复一并删除。**不再自动换主会话、不再归档旧会话**。
- **8 个配置键删除**：`mainRotation` / `rotateAfterMainLogMiB` / `rotateAfterDays` / `rotateCooldownHours` / `rotateMinAgeHours` / `rotateIdleMinutes` / `rotateCheckIntervalHours` / `rotateArchiveOld` → 进 `DEPRECATED_KEYS`，老 profile 留着只 warn 一次、按默认运行。
- **配置面 29 → 22**：删 8 个轮换键、新增 1 个 `contextPressureThreshold`（默认 0.4，0.1–0.95，卡片可编辑）。
- **5 个 settings 键一次性清理**：`main_session_created_at` / `main_rotation_at` / `main_rotation_last` / `main_rotation_pending`（崩溃锚点，留着会让回滚旧版误归档会话）/ `main_rotation_checked_at` 在启动时删掉并记 `main.rotation.legacy-cleaned`。
- `status-facts` 的 `rotationActive` 能力位删除（`statusesWith('rotationActive')` 返回空）。

**新增**

- **上下文观测**（`src/main-context.js`，只读）：打开主会话时算一次压力（`tokenMeter.contextPressure`）/ 日志体积（`locate`+`stat`）/ 压缩次数（`sessionQuery.observeSession` 的 `compaction/start`，`turn:null` = 手动），结果进 `snapshot.mainSession.context` 与 `main.context.observed` 日志；日志 ≥ 16 MiB 给一次性提示（`main_log_hint_shown`）。
- **压力提醒**（唯一出口，宿主 `userQuestions` 问题卡）：压力 ≥ `contextPressureThreshold` 时问一次「新建协调者会话 / 继续当前会话 / 稍后再说」；去重 `settings.main_context_alert`（0.1 band + 0.05 滞回），`NO_PROVIDER`/缺服务只 warn 一次、不建会话、不代压。
- **手动换协调者（只切指针）**：会话头「设为协调者」（新端点 `adopt-session`，校验指挥舱工作区/已加载/预设可拉回，错误码 `ADOPT_*`）；提醒卡选「新建」→ 插件代建空白协调者会话并切换（`main.adopt.created`）。旧会话不改名、不归档、随时可回看；同一时刻只允许一次切换。
- **计划审批顺序写进协调者预设 policy**：先回复摘要 + 计划文档**绝对路径**并 `present`，再 `ask_user_question`（选项至少 批准执行 / **先看计划文档** / 调整计划），选「先看」只展示不推进，只有明确批准才续派。
- 探测位：`probeCompaction`（`agentPresets.serviceFor(agent,'compaction')` + `compactNow` 存在性 + 能否读到宿主 `thresholdRatio`），结果进 `host.capabilities.compaction`；**只读、不触发任何动作**。

**不做**

- 不调用 `compactNow`、不写宿主压缩阈值/预设行内 config、不重试、不加定时器、不碰子会话。`/compact` 手动路径照旧。
- 官方 plan-mode UI 未接：`planMode` 在预设隔离域里、协调者预设不挂它，宿主也没有对插件开放的计划审批端点（见 LIMITATIONS）。

## 0.24.0（2026-11-20）

0.23.1 之后的 **minor 版**，四片合发（按提交从新到旧）：**config-schema 兜底解析 + 显式告警**（`Config` 解析失败
不再静默降级，配置卡片不再「连空壳都没有」）、**resume 复用原会话**（`task_message` 新增 `action:'resume'`：失败 /
孤儿 / 超时交付在**原 `task_id` + 原子会话**上冷恢复；`retry` 仍是新任务 + 新会话）、**计划批准必须由用户拍板**
（协调者转交摘要 + 路径并用 `ask_user_question` 请批准，**不得自行批准**）、**恢复轮换检查节流**（打开主会话不再
每次都做采集 + 判定，默认 24 小时一次）。
本版**没有默认值翻面**：轮换默认仍是 0.23.1 的 `auto`，`resume` 是新增动作、`message` / `retry` / `stop` / `close`
口径不变；配置面 **28 → 29**（`rotateCheckIntervalHours` 从弃用名单移回正式配置）。

### config-schema 兜底解析 + 显式告警（`e1cc338`）

#### 修正

1. **根因：`Config` 解析失败会静默降级，配置卡片「连空壳都没有」**。宿主 `SettingsForms.describe()` 只在
   `entry.fiber.runtime.Config` 非空时列命名空间；插件加载时若 `@deepseek-ai/schemastery` 解析失败，旧实现
   `catch { return undefined }` → `Config = undefined` → `describe` 里没有 `orchestrator` 命名空间 → 客户端
   `forms.whileServed(['orchestrator'])` 永不触发、`plugins.bundle.config` 槽位根本没注册——页面零报错
   （`whileServed` 的设计就是「不服务即无痕」）。ESM 模块缓存决定进程内不会重试，所以「重启后可能自己好」，
   下次再踩也查不到原因。
2. **兜底解析**：主路径 `createRequire(import.meta.url)` 失败后按「最可能命中」顺序试锚点——`DSH_PROFILE_DIR` /
   `DSH_HOME` / `DSH_INSTALL_DIR`（profile 的 `node_modules` 里通常有一份）、宿主进程 argv 里带斜杠的路径（CLI 宿主是
   `…/app.asar/dsh/…`）、Electron 布局 `<exe>/resources/{app.asar,app.asar.unpacked}/dsh`、`process.resourcesPath`、
   `DSH_NODE_EXECUTABLE` 同源推导；保序去重、只留真实存在的路径，目录锚点补假文件名再交给 `createRequire`
   （asar 路径在纯 node 下 `existsSync` 为 false，自然被跳过）。
3. **显式告警（恰好一次）**：全部失败时 `console.warn` 一次，文案含用户可见后果（配置卡片将不显示）、插件仍可用、
   缺的包名、试过的位置、首个错误原因——不再静默。
4. **诊断快照** `configSchemaDiagnostics`：`{ available, source: 'plugin'|'host'|'unavailable', anchor, packageName,
   attempts[] }`，深冻结，供日志与测试取证。
5. **不该吵的时候不吵**：主路径命中时不碰兜底、不告警；走兜底成功也不告警（卡片还在，别吓用户）。

#### 验证

`pnpm test`（当时 1,089 条 / 1,084 pass / 5 skip / 0 fail）+ `check:client` + `check:client-size`（91.9 KB / 预算
95.0 KB）+ `check:version` + `check:docs`（1,495 / 1,800 行）+ `npm pack --dry-run`；新增 `test/config-schema.test.js`
7 条锁住：主路径命中（`source='plugin'`、零兜底、零告警）、宿主目录命中（记锚点、补假文件名、保留失败证据、
不告警）、全失败（`Config=undefined`、`source='unavailable'`、**恰好一次** warn、文案含后果/包名/位置数/首个原因）、
坏包形状与 ESM 互操作、`schemaAnchors` 保序去重与 `DSH_*` / argv / Electron 布局覆盖、真实模块加载子进程取证
（无 schemastery + 无锚点 → warn 打到 stderr，非静默）。
真机（临时 `DSH_HOME` + profile `e2e`，用 `pnpm pack` 产物安装＝等价 npm 安装，安装副本没有本地 `node_modules`、
profile 也没有 schemastery ⇒ 只剩兜底路径）：`POST /api/settings/describe` → **23 个命名空间、`hasOrchestrator: true`**；
无头 Chrome 打开插件页「任务编排」→ `[data-orchestrator-config]` 存在、**7 组 / 29 行**，宿主日志无降级 warn。

### resume 复用原会话（后端）（`cb82116`）

#### 变更

1. **`task_message` 新增 `action:'resume'`**：在**原 `task_id` + 原子会话**上冷恢复（复用 `dispatch.send` 那条链），
   续跑提示只讲「接着做什么、别重做、跑偏就上报」，不复述任务详情（详情在 `task_detail`、原文在会话历史里）。
   与 `retry` 的分工写进 `src/resume.js` 顶部：「resume = 同 `task_id` + 同子会话（失败 / 额度中断 / 重启孤儿的默认
   出口）；retry = 新任务 + 新子会话（污染、换检出/权限、不可达时用）」。
2. **状态口径一律走能力表**：`status-facts` 的 `CAPS` 加 `resume` 位（10 个状态统一），新增 failed / orphaned / done
   → running 三条入边（done 另有 `close_reason='timeout'` 行级白名单）；**`cancelled` 刻意不复活**。
3. **判定与阈值单一来源**：`resumeGate(task, { history })` 是纯函数（不碰台账）——状态能力 + done 白名单 +
   `target` 缺失（`no_session`）+ 检出已清理（`checkout_cleaned`）；历史消息 **> 60 条只建议 retry、不拦截**
   （`RESUME_HISTORY_THRESHOLD`，软阈值：硬拦会把「额度中断的长任务」正好挡在最需要续跑的那类之外，反而逼出新派）。
4. **台账两列**：`resume_count` / `last_stop_reason`（旧库 `ALTER` + 回读归一）；新增 `incrementResumeCount` /
   `countTaskMessages`；结算与启动对账把 `stopReason` 落 `last_stop_reason`；孤儿汇总通知的默认出口改成 resume。
5. **投递失败只报错回退，绝不静默新建任务**：`RESUME_NOT_ALLOWED` / `RESUME_CLOSED` / `RESUME_NO_SESSION` /
   `RESUME_CHECKOUT_CLEANED` / `RESUME_UNREACHABLE` / `RESUME_DELIVERY_FAILED`，文案统一指向 retry；成功后
   `attempts` 与 `resume_count` 自增、清死因 / `close_reason` / 旧问题，沙箱 / 可写根 / goal 由 `dispatch.send` 幂等补。
6. **文档同步**：README 工具表·状态表·排障、`docs/ARCHITECTURE.md` 能力表·动作·对账、`docs/LIMITATIONS.md` 边界。

#### 验证

`pnpm test`（当时 1,082 pass / 5 skip / 0 fail，含 `pretest` 的 build + client size 91.9 KB + `check:docs`
1,501 / 1,800 行）；新增 `test/resume.test.js`：同子会话 id 冷恢复、orphaned、timeout done、不可达 / 投递失败回退、
重复 resume 幂等、阈值建议；`state` / `status-property` / `ledger` 用例随新边与新能力位更新。

### 计划批准必须由用户拍板（`96d2c51`）

#### 变更

1. **计划批准是最硬的人工闸门**：`planFirst` 任务 `blocked` 后，协调者把计划摘要 + `reports/plans/<taskId>.md` 路径
   原样转交用户，并**必须用 `ask_user_question` 结构化提问**（options 至少「批准执行 / 调整计划」）；
   **协调者不得自行批准**——不得自己判断「计划没问题 / 用户应该会同意」就直接续派，也不得把用户沉默、含糊回应或
   自己的默认当成批准。
2. **答「调整」**：修改点原样转回**同一个子会话**先出修订版计划（追加消息里写明「只修订计划、不要开始实现」），
   再次 `blocked` 后重新走到「转交摘要 + `ask_user_question` 请批准」；**用户不回答**：任务保持 `waiting_user`
   （计划中），不续派、不代批。
3. **只改提示词与文档**：`index.js` 的 `COORDINATOR_POLICY`、README 的 `planFirst` 行与「计划任务批准」段、
   `docs/ARCHITECTURE.md` 两行、`test/copy-consistency.test.js` 新增断言；状态机、工具入参、`dist/` 未动。

#### 验证

`pnpm test` 全绿（新增断言锁住 policy 与 README 的「批准只认用户的话」「不得代批」「不回答就不续派」口径），
`check:docs` 行数在预算内。

### 恢复轮换检查节流（默认一天一次）（`2a6c885`）

#### 变更

1. **恢复 `rotateCheckIntervalHours`（默认 `24`，区间 1–168，越界夹取、非法回落默认）**：重新把「打开主会话时
   最多每 N 小时做一次采集 + 判定」的节流接回 `createRotationService.evaluate`。0.23.0 的 P1-A 把它删了
   （理由：采集只剩 `locate` + `stat`），现场反馈「以前一天最多查一次，现在每次打开都查」——恢复的原因是
   **每打开一次就是一次台账读 + 日志 `stat` + 平台 `locate`**，而主会话可能一天被打开几十次。
2. **跳过路径零开销**：`evaluate` 在采集之前只读 `settings.main_rotation_checked_at`（`readRotationState`），
   交给纯函数 `rotationCheckWindow({ now, lastCheckedAt, intervalHours })` 判定；没到间隔就**直接返回**
   `{ due:false, skipped:true, skipReason:'check-interval', check:{…} }`——不读台账、不 `locate`、不 `stat`、
   不碰平台服务，只写一条 `main.rotation.check.skipped` 日志（`intervalHours` / `checkedAt` / `nextCheckAt` / `elapsedHours`）。
   首次（没有记录）视为需要检查；时钟回拨（记录在未来）按「该检查」处理，检查完用当前时间覆盖。
3. **只在「不需要换」时写检查时间戳**：`due !== true` 才写 `main_rotation_checked_at = now`（写失败只记
   `main.rotation.check.record-failed`，不影响本次判定）；`due === true` 不写——动作（create / 切指针）还在后面，
   失败或崩溃后下次打开要能重试，不能被自己刚记的时间戳挡一个间隔；检查整体异常（`evaluate` 落 `catch`）同样不写。
4. **三个时间参数分工写清（语义区分，不是同义词）**：
   - `rotateCheckIntervalHours`（默认 24）＝**查不查**：这次打开要不要花开销做采集 + 判定；
   - `rotateCooldownHours`（默认 48）＝**换不换**：距上次轮换不足冷却就在判定里挡 `cooldown`，**检查照做**；
   - `rotateMinAgeHours`（默认 12）＝**换不换**：主会话跑得不够久就挡 `min-age`，同样**不拦检查**。
   节流的 `skipped` 返回不是判定结论（`triggers` / `blockedBy` 都空），不会把上一次的 blocks 重算一遍。
5. **配置面 28 → 29**：`rotateCheckIntervalHours` 从 `DEPRECATED_KEYS` 移回正式配置（老 profile 里写过这个键的
   不再收到「已删除」警告，而是**直接生效**）；插件页配置卡片「主会话轮换」分组恢复该行（可写 int，默认 24，
   区间 1–168，提示里写明「检查节流 ≠ 轮换冷却」）。README 配置表加回一行 + 增「检查节流」小节、ARCHITECTURE
   补节流位置与执行顺序、LIMITATIONS 补「一天最多一次」的粒度限制。
6. **不碰因子/保护/动作层**：触发因子仍是 `main-log` / `age` 两个，十二条保护、冷却/最小龄、动作时序、
   崩溃恢复一字未动；`readRotationState` / `writeRotationState` 本来就保留 `checkedAt` 这个键，无需迁移旧库。

#### 验证

`pnpm test`（1,080 条 / 1,075 pass / 5 skip / 0 fail）+ `pnpm run check:client` + `pnpm run check:client-size`
（91.9 KB / 预算 95.0 KB）+ `pnpm run check:version` + `pnpm run check:docs`（1,491 / 1,800 行）+ `npm pack --dry-run`；
新增用例锁住：**未到间隔跳过且零采集**（`persistence.locate` 调用数为 0、无 `main.rotation.decided`、只写
`main.rotation.check.skipped`）、**到点检查并记录时间戳**、**首次无记录视为需检查**、**边界夹取**（0.5→1、
1e6→168、非数字/非正数回落 24）、**与冷却叠加**（冷却期内检查照做、`blockedBy:['cooldown']`、时间戳照记）。

### 发版门禁（0.24.0 实跑，各片「验证」里的数字是当时快照）

`pnpm test` **1,094 条 / 1,089 pass / 5 skip / 0 fail**（5 条 skip 是本机建不了符号链接的显式跳过，与 0.23.x 同因）+
`check:client` + `check:client-size`（**91.9 KB / 94,150 B**，预算 95.0 KB，余 3.1 KB）+ `check:version`（`0.24.0`）
+ `check:docs`（**1,501 / 1,800** 行；配置表 29 键、工具表 10 个）+ `npm pack --dry-run`（**78 个文件 / 535.7 kB**）全绿；
`dist/` 在 `pnpm build` 前后无 diff；`git status` 除本版版本/文档三文件外无改动。

## 0.23.1（2026-11-20）

0.23.0 之后的 **patch 版**，四片合发（按提交从新到旧）：**子会话开放只读 `context`**（提高记忆读取主动性；
写记忆仍只属协调者）、**配置卡片保存口径修正**（保存只落 profile，需重载插件或重启 DSH 后生效）、
**需拍板时用 `ask_user_question` 结构化提问**、**轮换默认开启 + 配置卡片可写**（`mainRotation` 缺省回到 `auto`，
轮换 7 个键可在插件页直接改、`coordinatorSession` 仍只读）。
本版唯一会自己动手的行为变化是**主会话轮换默认开启**——不想被换的先看最后一节的升级须知。

### 子会话开放只读 context（提高记忆读取主动性）（`31b4a85`）

#### 变更

1. **子会话可以自己读上下文了**：`context` 的三种 mode（`history` / `project` / `workspaces`）对子会话只读开放，与协调者**同一条实现**（同参数输出逐字一致）；`src/tools.js` 不再按主会话拦截它。
2. **写记忆仍仅主会话**：`memory_note` 从子会话工具表里消失（worker 预设 `preset-tools` 的**遮挡式** `deny`），能力声明落在预设层；执行层再兜一层——万一被别的 profile/旧会话露出，返回「拒绝：写记忆只属协调者」+ 替代路径（`task_report` 的 summary / `context` 只读查 / 请协调者记），并记 `memory.note.rejected`。
3. **`preset-tools.js` 两种形态**：保留式（`allow` 补集，协调者，不变）与遮挡式（`deny` 点名，worker）二选一；遮挡式另支持 `keep` 正向声明（当前 `context` / `task_detail` / `task_report`），挂载后随 `tools/change` 校验并写 `preset.keep` 审计，未注册先静默、不抛。
4. **引导写进 worker 预设 prompt**（不是每条 brief）：worker persona prefix 带上 `src/prompt-layers.js` 的 `WORKER_CONTEXT_HINT`——「需要历史经验/项目背景时主动调 context，不要等协调者注入；写记忆只属协调者，要沉淀的结论写进 task_report 的 summary」。brief 仍是 4 行纯指路，不重复这句。
5. **注入侧只做减法**：brief 自 T1 起就没有记忆正文；`task_detail` 的 `【经验文件】<路径>（N 条）` 保留（关键指针），只在末尾加一句出口「更多历史与项目背景用 `context({ mode: 'history' | 'project' })`」；索引任务的说明里删掉已不存在的「不允许 memory_note 越权」。
6. **真机语义实验**：`docs/probes/preset-scope-restrict.mjs` 扩到 10/10 PASS（用真实 `ToolsService` 验证「预设 scope 里 deny 只遮点名项」「keep 晚注册后补确认」）。

#### 验证

`pnpm test`（1,072 条 / 1,067 pass / 5 skip / 0 fail）+ `check:client` + `check:client-size`（≤95 KiB）+ `check:version`
+ `check:docs` 全绿；新增/改写用例锁住：子会话三种 mode 与协调者逐字一致且不被主会话门槛拦、`memory_note` 子会话被拒（理由含
替代路径、不写库、留 `memory.note.rejected` 审计）、worker 预设 `preset-tools` 是 `deny`+`keep`（没有 `allow` 补集）、
worker persona 逐字包含 `WORKER_CONTEXT_HINT` 且 brief 不重复它。

### 轮换默认开启 + 配置卡片可写（`74cb735`）

#### 升级须知（相对 0.23.0）

1. **`mainRotation` 默认从 `off` 改回 `auto`（开启）**：升级后，主会话跑久了（日志 > 6 MiB **或** 运行 > 10 天，任一命中）
   会在你**下一次打开主会话**时被换掉——旧会话改名「主会话（已退役 YYYY-MM-DD HH:MM）」并归档（**不可逆**，平台没有 unarchive）。
   12 条保护照旧兜底（有活跃任务 / 待确认 / 刚聊过 / 主会话正在跑回合 / 未到最小龄 12h / 冷却 48h 等任一命中都不换）。
   **不想换就显式配 `mainRotation: 'off'`**（插件页配置卡片里也能直接关）：仍会检测，但绝不动作。
2. **拼错不再「安全地关掉」**：总开关只认显式 `'off'`，缺省/拼错一律按默认 `auto`（与 `memoryInject` / `rotateArchiveOld`
   的「只有显式 false 才关」同口径）。想关轮换只有一条路：写 `off`。
3. **配置卡片轮换分组：7 个键取消只读、`coordinatorSession` 保持只读**。`mainRotation` 与 6 个 `rotate*` 现在都能在
   插件页直接改，保存到当前 profile 的 `cordis.patch.yml`，**重载插件或重启 DSH 后生效**（台账不受影响）；轮换分组不再默认折叠。**`coordinatorSession` 仅运维手改**
   （页面只读展示）：它是兜底通道，填错会让协调者指向不存在的会话、且只能改配置才恢复，属高危误操作，要改请直接编辑
   当前 profile 的 `cordis.patch.yml`。`rotateArchiveOld` 仍是不可逆开关（`false` = 只改名不归档）。卡片侧机制没删：
   `readonly` 标记即让某键只读，表单与保存路径（`EDITABLE_KEYS`）自动跟随，只读键保存时不下发。

#### 验证

`pnpm test`（全绿）+ `check:client` + `check:client-size`（≤95 KiB）+ `check:version` + `check:docs` + `npm pack --dry-run`；
新增/改写用例锁住：默认 `mainRotation === 'auto'`、显式 `off` 才关、轮换 7 个键可写标记与真实可写性一致（字段表双向 + 渲染控件不 disabled）、
`coordinatorSession` 保持只读且保存时不下发（`buildOps`/`isDirty` 都不带它）、卡片保存生成的 ops 经 `loadConfig` 真读到新值。

### 需拍板时用 ask_user_question 结构化提问（`c0147c9`）

#### 升级须知（相对 0.23.0）

1. **「少打扰」只覆盖不用拍板的进展汇报**：progress / done 这类汇报照旧直接说结论、不提问；这不影响既有的
   「交付后不催关闭」与「能直接回答就不派任务」——三者的共同边界是「不替用户做决定、也不逼用户表态」，
   而不是「不问用户」。
2. **凡需要用户拍板的，必须用 `ask_user_question` 结构化提问**（问题 + 2–4 个选项）：方案/业务取舍、范围变更、
   权限变更、不可逆操作（删数据、覆盖历史、强推）、远端写授权（推送、建 MR、发布、改权限）都算。**不得用纯文字问句代替**：
   纯文字既容易被用户忽略、又没有选项可点，等于让决策悬空；不可逆操作必须先拿到拍板再做，不能先做后报。
3. **只改提示词与测试**：状态机、工具入参、台账结构、`dist/` 一字未动；「任务能否关闭」仍不属于提问范畴。

#### 验证

`pnpm test`（1,062 条 / 1,057 pass / 5 skip / 0 fail）+ `pnpm run check:client` + `pnpm run check:client-size`
+ `pnpm run check:version` + `pnpm run check:docs`（1,444 / 1,800）+ `npm pack --dry-run` 全绿；新增用例锁住 policy 含
「必须用 ask_user_question 结构化提问」「不得用纯文字问句代替」、「少打扰」只针对不拍板的进展汇报、与
「不催关闭」「能直接回答就不派任务」并列且不矛盾，并反向断言不出现「不问用户就直接执行不可逆操作」式口径。

### 配置卡片保存口径（重载/重启后生效）（`f2f5e7d`）

#### 修正

1. **卡片保存不会让运行中的插件热生效**（0.23.0 发版前 UI 冒烟 §6.1，两轮独立复现）：保存只把值写进当前 profile 的
   `cordis.patch.yml`（落盘、读回都对，`revision` 栅栏正常），但插件实例**没有被重新 apply**——主会话轮换判定仍用启动时
   那份配置。用户点完保存、看到「已保存」，以为已经关掉轮换，同一进程内下次打开主会话仍可能被换走。本版**只改口径、不改保存链路**：
   保存后**重载插件或重启 DSH 后生效**。
2. **卡片回执/简介改口径**：回执「已保存到当前 profile 的 `cordis.patch.yml。需重载插件或重启 DSH 后生效（台账在 SQLite，不受影响）。」；
   简介「保存在当前 profile 的 `cordis.patch.yml；运行中的插件不热重载，需重载插件或重启 DSH 后生效（台账不受影响）。」
   README「生效方式」、`docs/ARCHITECTURE.md` 保存语义、`docs/LIMITATIONS.md` 新增一条，与实现逐字同口径。
3. **为什么不做运行时热重载**：卡片走宿主 `configForms.mutate` → settings 服务写 profile，宿主不保证重新 apply loader 条目
   （冒烟里 `host.capabilities` 只在进程启动时出现，保存后没有任何 re-apply 事件）；插件侧「每次判读现读 profile」会多一条 I/O
   与失败面、并绕过宿主的 `revision` 栅栏，不值得。要真热重载得先查 `dsh-settings` → loader 的 reload 链路，建议后续单独评估。

#### 验证

`pnpm test`（1,064 条 / 1,059 pass / 5 skip / 0 fail）+ `check:client` + `check:client-size`（≤95 KiB）+ `check:version`
+ `check:docs`（1,448 / 1,800）+ `npm pack --dry-run` 全绿；新增用例走真实交互（改字段 → 点保存 → 读回执）断言文案含「重载插件或重启 DSH
后生效」且不再承诺保存后立刻生效，并锁住 README / ARCHITECTURE / LIMITATIONS / CHANGELOG 与实现同口径。

### 发版门禁（0.23.1 实跑，各片「验证」里的数字是当时快照）

`pnpm test` **1,072 条 / 1,067 pass / 5 skip / 0 fail**（5 条 skip 是本机建不了符号链接的显式跳过，与 0.23.0 同因）+
`check:client` + `check:client-size`（**91.6 KB / 93,824 B**，预算 95.0 KB，余 3.4 KB）+ `check:version`（`0.23.1`）
+ `check:docs`（**1,473 / 1,800** 行；配置表 28 键、工具表 10 个）+ `npm pack --dry-run`（**77 个文件 / 516.8 kB**）全绿；
可选探针 `node docs/probes/preset-scope-restrict.mjs` **10/10 PASS**；`git status` 除本版版本/文档文件外无改动。

## 0.23.0（2026-11-19）

这一版把两条线合到一起发：远端已发布的 **0.22.0（插件页配置卡片）** 与 **0.22.1（少派一次活、少问一次关闭）**，
加上本地 **P2-1 ~ P2-6** 六片（机器可判定验收 / 删自建 keepAlive 回归宿主 goal / 交接契约 v1 / 官方 Team 板只读互通 /
面板体积与只读视图 / 文档收口），以及发版前 UI 冒烟揪出的**两处 inject 取服务修复**（官方 Team 板、goal 桥）。
版本定 **0.23.0**——0.22.0、0.22.1 已被占用，这次是它们之后的 **minor**：
新增能力为主，配置面 **35 → 28**，面板体积第一次进机器闸门。

### 升级须知（相对 0.22.1）

1. **配置面 35 → 28**：`keepAlive` / `keepAliveMode` / `keepAliveMaxRounds` / `keepAlivePrompt` 续跑四键，以及
   `mergeWindowMs` / `stallRounds` / `preferencesMaxItems` 三个阈值键已删除；老 profile 里留着不影响加载，
   启动时各给一条弃用警告、按默认值运行。续跑改用 `task_create({ goalRounds: N })`（默认 0 = 不续跑）。
2. **插件页配置卡片按 28 键投影**：0.22.0 的卡片（35 字段）与 P2-2 的收缩在同一份字段表里对齐，
   **已删的 7 个键不再出现在表单上**（只在弃用警告里出现）；字段表、schema、表单三处同源，由单测双向守住。
3. **默认不续跑**：`task_create.goalRounds` 默认 0，派发后 `create` 立刻 `disarm`，与旧行为一致；
   要续跑必须按任务显式声明（1–50，与 `planFirst` 互斥）。
4. **面板体积进闸门**：`dist/client.js` ≤ **95 KiB**（`pnpm run check:client-size`，已挂进 `pretest` / `prepublishOnly`）。
5. **官方 Team 板只读互通**：插件任务可选 `teamTaskId` 关联官方任务，人/协调者确认交付时按 CAS 反写 `complete`；
   超时自动完成不反写。没开官方 Team 的用户完全无感；服务缺失/Team 未开启时面板**整区隐藏**（不刷存在感）。
6. **可选服务一律经 `ctx.get`（inject 安全）**：官方 Team 板与 goal 桥在本版修掉「读 `ctx.<服务名>` 属性必抛」的写法。
   若你在真机上曾觉得「官方 Team 分区从来不出现」或「`goalRounds` 设了也不续跑」，就是这个——本版取得到服务了。

### 六片一览

| 片 | commit | 一句话 |
|---|---|---|
| P2-1 | `feat: P2-1 task_create.checks 机器可判定验收（失败阻断交付）` | 交付前跑退出码，失败拒绝交付 |
| P2-2 | `refactor: P2-2 删自建 keepAlive、goal 收敛单写方、配置 35→28` | 续跑交宿主 goal driver；配置 35 → 28 |
| P2-3 | `feat: P2-3 交接契约 v1（acceptedBy/acceptedAt + JSONL）` | 交接字段契约 + 按天 JSONL 事件，外部可消费 |
| P2-4 | `feat: P2-4 官方 Team 板只读 + 确认反写（CAS）` | 官方板只读快照 + 确认交付时按 CAS 反写 `complete` |
| P2-5 | `refactor: P2-5 面板 S9′（dist ≤95KB + 交接/官方板只读视图）` | esbuild minify：面板 129.9 → 77.6 KB，体积闸门进 `pretest` |
| P2-6 | `docs: P2-6 文档收口（≤1800 行）+ P2 变更收录` | README 首屏重写，文档 2,152 → 1,386 行，`check-docs` 预算 1,800 + 首屏结构断言 |

### 发版前两处 inject 修复（P2-4 官方板 / goal 桥）

发版前 UI 冒烟（`workspace/reports/p2-ui-verify.md`，19/19 断言 PASS）抓到一个**真机缺陷**：P2-4 的「官方 Team 板只读」
在任何宿主都不渲染，面板只多一条 cordis 内部报错。根因不在 P2-4 的业务逻辑，而在**取服务的方式**，同类写法一并收口。

- **`fix: P2-4 修正 agentTeams 取服务路径（inject 安全）`**：`src/host-capabilities.js` 里
  `agentTeams: () => ctx?.agentTeams ?? service('agentTeams')` 改成**只走** `service('agentTeams')`。
  `agentTeams` 不在 `index.js` 的 `inject` 里，cordis 的 get trap 对**未 inject 服务的属性读取必抛**
  `cannot get property "agentTeams" without inject`——于是 `??` 右边永远走不到，每次 snapshot 都记一条内部报错。
  真机探针（`at-probe.mjs`）对照过：`ctx.get('settings')` 有对象、`ctx.settings` 同样抛错，与业务无关。
  顺带把面板口径对齐 `docs/compat.md`：`teamBoard.enabled !== true`（服务缺失 / 形状变了 / Team 未开启）时**整区隐藏**，
  只有 `enabled === true` 而这次 `listTasks` 没读成才给一条只读提示——不把「没装 Agent Teams」吼到用户脸上。
- **`fix: host-capabilities 统一经 service() 取可选服务（goals 等）`**：同一个坑的其余实例一起修，
  `goals` / `agents` / `subagents` 全部改成 `service('x')`（`agents` / `subagents` 当前在 `inject` 里、属性读不抛，
  也统一，不给下一个可选服务留坏样板）。`index.js` 里 `/api/orchestrator` 装配处的 `host.connection() ?? ctx.connection`
  与能力检查的 `host.schedule() ?? ctx.schedule` 同样去掉属性兜底——`connection` / `schedule` 都不在 `inject` 里，
  旧写法会把「可选服务缺失」变成装配期异常，而不是走既有的友好降级。
  **用户可见影响**：真机上 goal 桥以前一直拿到 `undefined`、`task_create({ goalRounds })` 永不 arm，现在取得到 `goals` 服务；
  缺 `connection` 时回到「警告 + 面板路由不可用」而不是抛错。
- **回归**：`test/host-capabilities.test.js`（属性读抛错仍返回 undefined、`service()` 是唯一入口）、
  `test/goal.test.js`（真机形状下 `goalRounds` 能 arm）、`test/index.test.js` / `test/integration.test.js`（缺服务时装配不炸）
  与 `test/client.test.js`（`enabled` 三态 → 渲染/提示/隐藏）锁住。

### 合并与验证（本次 rebase 记录）

六个 commit 以 **rebase**（不是 merge）落到 `origin/main` 的 `27222f2`（v0.22.1）之上，冲突逐个按语义解决：

| 位置 | 冲突形态 | 解决口径 |
|---|---|---|
| `README.md`（P2-1 / P2-6） | 内容冲突 ×2 | 交付小节两条并存（远端「不主动问能否关闭」+ P2 的 `checks` 验收）；0.22.0 的配置卡片小节与 28 键表合并 |
| `CHANGELOG.md`（P2-2 / P2-6） | 内容冲突 ×2 | 远端 0.22.0 / 0.22.1 段落收进本版「一并发布」小节，P2-1~6 按切片收录 |
| `dist/client.js(.map)`（P2-1 / P2-5） | 内容冲突 ×2 | **不手合**：取 P2 侧产物继续 rebase，最后统一 `pnpm build` 重建 |
| `src/keepalive.js`（P2-2） | 修改/删除冲突 | **保持删除**（不复活自建续跑器），远端 27222f2 的文案意图移植到 `src/copy.js` / `src/brief.js` / `src/handoff.js` |
| `index.js`（P2-4） | 内容冲突 ×1 | 保留远端 `unwrapVolatile(flatConfig)`（volatile 包装必须解包）+ P2-4 的 10 类宿主能力注释 |
| `client/src/styles.css`（P2-5） | 内容冲突 ×1 | 保留 P2 的样式收敛，追加 0.22.0 配置卡片所需的 `.orch-cfg*` 样式，去掉重复的 reduced-motion 断点 |
| `docs/ARCHITECTURE.md`（P2-6） | 内容冲突 ×1 | 保留收口后的 brief 小节，补入「交付后协调者不会为能否关闭提问」的新口径 |

语义对齐三件事（不是文本合并能解决的）：

- **配置卡片改为按 `loadConfig()` 实际 28 键投影**：`src/config-fields.js` 删掉 7 个已删键与 `keepalive` 分组，
  schema（`src/config-schema.js`）与表单（`client/src/config-form.js`）自动跟随；`test/config-fields.test.js`
  新增「已删 7 键不得回到表单」与「字段表 = 28 键」两条断言，并把用旧键做样本的用例改成真实键。
- **keepAlive 保持删除**：`src/keepalive.js` 不复活；远端那句「报 done 会停在『已交付待确认』，确认或超时后才收成完成」
  落到 `src/copy.js` 的 `deliveredReceiptNote` / `finishHint`、`src/brief.js` 的 `CONFIRM_HINT`
  与 `src/handoff.js` 的「未确认（等你或用户确认，或超时自动完成）」。
- **dist 用 `pnpm build` 重建**：`dist/client.js` = 93,745 B（**91.5 KiB / 95 KiB**，余 3.5 KiB），sourcemap 一并重建。

**全门禁**（两处 inject 修复后的最后一次全跑）：`pnpm test`（1,058 例：1,053 pass / 5 skip / 0 fail）、
`pnpm run check:client`、`pnpm run check:client-size`（91.5 / 95 KiB）、`pnpm run check:version`（0.23.0）、
`pnpm run check:docs`（1,442 / 1,800）、`npm pack --dry-run`（77 文件，504.4 kB）全绿，工作树干净。
rebase 当时**未 push、未打 tag、未发版**；本版随后以 `v0.23.0` 一次发出（不再重打 tag）。

### P2-6 文档收口（≤1,800 行）+ P2 变更收录

**P2-6：文档收口（≤1,800 行）+ P2 变更收录**（`docs: P2-6 文档收口（≤1800 行）+ P2 变更收录`，单 commit，未 bump / 未 tag）

文档从 **2,152 行压到 1,386 行（−766，−36%）**，预算从 2,250 降到 **1,800**；README 首屏从「安装手册」改写成「3 分钟看懂 + 3 分钟跑通」；P2-1~5 的能力变化全部补进用户文档与 CHANGELOG。

#### 行数前后（`scripts/check-docs.mjs` 口径）

| 文件 | 前 | 后 | 动作 |
|---|---|---|---|
| `README.md` | 546 | **311** | 首屏重写：定位 1 句 + 兼容基线 + 安装 + 3 分钟 demo + 工具/配置表 + 概念速查 + 排障；机制细节下沉 docs |
| `docs/ARCHITECTURE.md` | 881 | **444** | 合并面板/UI 两节；主会话轮换、brief、计划、worktree 只留机制与边界；新增 A1/D2/D6 三节 |
| `docs/LIMITATIONS.md` | 184 | **167** | goal 两节里重复的 re-arm/降级/轮次条目合并；新增 A1/D2/D6 边界 |
| `docs/api-notes.md` | 161 | **67** | 删与 ARCHITECTURE 重复且已过时的「主会话接法」「工作区推断」两节，只留平台探测结论 |
| `docs/CONTRIBUTING.md` | 118 | **122** | 删与 testing.md 重复的测试策略；补 `check:client-size` 与 P2 新增模块 |
| `docs/compat.md` | 81 | **81** | 不动（P2-4 已把 9 类同步到 10 类） |
| `docs/testing.md` | 181 | **194** | 新增 G10 体积闸门、check-docs 新预算与首屏断言、P2-1~6 复核索引、真机矩阵 3 条 |
| **合计** | **2,152** | **1,386** | **−766**（预算 1,800，余 414） |

#### 删 / 并了哪些段（删前确认已过时或已在别处）

- **README**：删「目录」（短文档不需要）；「装好后的自检」并进安装一步；入口说明压成 1 条；面板表格压成一段；`read_workspace` 闸表、worktree 声明表、轮换保护表下沉到 ARCHITECTURE / LIMITATIONS（README 只留用户会踩到的边界 + 链接）。
- **ARCHITECTURE**：合并「面板与详情（U2）」与「界面与消息块（原 UI.md）」重复的布局/交互/入口描述；主会话轮换从「模块 + 判定 + 时序 + 恢复 + settings + 日志」六小节压成一节事实清单（边界仍在 LIMITATIONS）；brief 纯指引、计划阶段、worktree 隔离只保留机制与安全边界，操作步骤交给 README。
- **api-notes**：删「主会话（固定入口 + 预设开启）」与「工作区推断与 artifacts」两节——它们与 ARCHITECTURE「主会话」「目标目录推断」重复且停留在 rc.1/rc.3；保留仍只在本文件成立的平台探测结论（注入名、`sendMessage` 限制、restrict 缺口、`wait_agent` 禁令、schema `required`、rc.3 沙箱根缺陷）。
- **LIMITATIONS**：合并「目标（G1）」与「自动续跑（P2-2）」两节里重复的 re-arm / 降级 / 轮次预算条目。
- **CONTRIBUTING**：删「测试策略」（testing.md 已是唯一入口），改为两条提醒 + 门禁清单。

#### 新增（P2 变更收录）

- **README**：`checks` 机器验收小节（argv/超时/失败语义/安全边界）、交付与确认里的验收结论、工具表的 `checks`/`goalRounds`/`teamTaskId`、配置表 28 行、`goalRounds` 续跑说明、面板的「官方 Team（只读）」/「交接」/「验收小标」。
- **ARCHITECTURE**：新增「交接契约 v1（字段表 + JSONL + 兼容边界）」「机器可判定验收（A1）」「官方 Team 板互通（D6）」三节（P2-1/3/4 的唯一真源）。
- **LIMITATIONS**：新增「子会话与检查（A1）」「交接契约（D2）」「官方 Team 板（D6）」三节，补写「检查跑在宿主进程」「超时不反写」「CAS 只重试一次」等真实边界。
- **testing**：G10 面板体积闸门、check-docs 预算 1,800 + 首屏四要素、P2-1~6 历史复核索引与真机矩阵 3 条。
- **CHANGELOG**：本段统一收录 P2-1~6（补上 P2-1 / P2-3 此前缺失的条目）。

#### 闸门变化

- `scripts/check-docs.mjs`：`DOC_LINE_BUDGET` 2,250 → **1,800**；失败提示同时说明「多几行 / 哪几篇最大 / 先删并再下沉」；新增 **README 首屏四要素**断言（定位句、兼容基线含 `rc.5`、带版本号安装命令、demo 入口）与「README 不出现 `keepAlive`」断言（失效配置只在 CHANGELOG / LIMITATIONS 讲）。
- **面板体积闸门**（P2-5）正式写进 `docs/testing.md`：§1 命令表 `pnpm run check:client-size`、§2 门禁 **G10**（≤ 95 KiB）。

#### 验证

`pnpm test`（1,041 条 / 1,036 pass / 5 skip / 0 fail）+ `pnpm run check:client` + `pnpm run check:client-size` + `pnpm run check:version` + `pnpm run check:docs`（**1,386 / 1,800**）+ `npm pack --dry-run` 全绿；不改产品代码、不动 `dist/`。

### P2-5 面板 S9′（dist ≤95 KB + 交接 / 官方板只读视图）

**P2-5：面板 S9′（dist ≤95 KB + 交接/官方板只读视图）**（`refactor: P2-5 面板 S9′（dist ≤95KB + 交接/官方板只读视图）`，单 commit，未 bump / 未 tag）

面板产物从 **129.9 KB 压到 77.6 KB（−52.3 KB，−40%）**，并把 P2-3 的交接数据、P2-4 的官方 Team 板快照真正渲染出来。
**功能不减少**：三段式布局、抽屉八区块、产物库、二次确认、骨架/空态/错误态全在；只收敛重复渲染与样式排版。

#### 能力变化

1. **构建**：`vite.client.config.mjs` 默认开 esbuild minify（`sourcemap: true` 保留）；
   `CLIENT_MINIFY=0 pnpm run build` 可出可读产物排查。产物仍入库（平台按 exports 原样 serve）。
2. **体积闸门**：新增 `scripts/check-client-size.mjs`（`dist/client.js` ≤ **95 KiB**，超了退出 1 并说超多少、
   怎么回去），挂进 `pretest` 与 `prepublishOnly`，另有 `pnpm run check:client-size`。体积预算从「约定」变成机器可判定。
3. **官方 Team（只读）分区**：消费 `snapshot.teamBoard`（P2-4）。`enabled:true` 时在任务列表上方出现可折叠分区，
   逐行显示 `subject / statusLabel / owner / blockedBy / revision`，**行内没有按钮**（认领与完成只能在官方 Team 里做）；
   `enabled:false` 整区不渲染；服务在但读不到时只给一条「官方 Team 板暂时读不到：<原因>」提示。
4. **交接区块**：抽屉新增「交接」区块，读 `detail.task.handoff`（P2-3）——契约版本、交付/确认时间、
   **谁确认**（协调者/面板/超时）、派发与追问次数、验收结论、官方板关联（id/revision/当前状态）；没交付过显示空态。
   卡片上已确认的交接多一枚「谁确认」小标（悬浮提示带时间），待确认仍由状态徽标表达，不重复。
5. **验收小标**：任务卡显示 `验收 2/2`（数据来自 `snapshot.tasks[].acceptance`，P2-1）；没配检查就没有这枚小标。

#### 代码（收敛，不改行为）

- `client/src/views.js`：把「停止 / 确认交付 / 删除」三条二次确认条合成 `ConfirmBar`，圆点行合一成 `DotRow`，
  键值对网格合一成 `KvRows`，状态徽标与标签兜底合一成 `statusBadge` / `labelOf` / `toneOf`
  （替掉各处 `X_LABEL[v] || v || '未知'`），卡片小标从十来个三元嵌套改成清单；14 处内联
  `style={{ display:'flex', flexDirection:'column' }}` 换成 `.orch-stack*` 档位类。
- `client/src/styles.css`：一条规则一行（**692 条声明的值逐字不变**，脚本比对过），合并重复规则
  （`.orch-drawer-content`）与两处 `prefers-reduced-motion` 断点，新增 `.orch-stack*`、`.orch-chip--good`、
  `.orch-board-subject`。
- 净变化：`client/src` **3,589 → 3,082 行（−507）**，其中 `styles.css` 838 → 255、`views.js` 1,525 → 1,601
  （新增两个只读视图 ≈ +150 行，其余为收敛）。

#### 测试

`test/client-build.test.js`：pretest 链含体积闸门、`CLIENT_SIZE_LIMIT`/`collectClientSizeProblems` 纯函数口径、
构建配置真的开了 minify 且保留 sourcemap、空壳护栏阈值 50 KB → 35 KB（minify 后）、CSS 内联标记按 minify 形态断言；
`test/client.test.js`：新增官方板分区（enabled/disabled/degraded/折叠/行内零按钮）、验收小标（通过/未通过/无数据）、
交接（卡片小标 + 抽屉区块 + 待确认 + 官方板降级 + 无交接空态）三组用例，并把既有样式断言改成空白/引号可选
（`.x{`、`a:b`、`[data-state=confirming]`）——断言仍是同一批声明，只是不再依赖排版。

> 同批「未发布」里还有 P2-1（检查）、P2-3（交接契约）、P2-4（官方板互通），细节见 `docs/ARCHITECTURE.md`。

### P2-4 官方 Team 板只读互通 + 确认反写（CAS）

**P2-4：官方 Team 板只读互通 + 确认反写（CAS）**（`feat: P2-4 官方 Team 板只读 + 确认反写（CAS）`，单 commit，未 bump / 未 tag）

把官方 Team 任务板**只读**接进插件视图；插件任务若显式关联官方板任务（`task_create.teamTaskId`），
确认交付时按 CAS 反写官方任务 `complete`。**方向已定：D6 优先，不做 workspace 第二后端**——官方板挂在 subagent 树上，
派发改走 root 工作区会话就整段失效，所以本片不新增 root 派发路径、不新增配置键、不接管官方派发与生命周期。

#### 能力变化

1. **面板/快照能看到官方板**：`snapshot.teamBoard = { enabled, rows, degraded }`，`rows[]` 只读
   （`id / revision / subject / status / statusLabel / owner / blockedBy / writeScopes / ready`，不含 `description`）。
   抽屉与 `task_status` 能看任务的官方关联；官方板本身在插件里**没有可操作入口**。
2. **可选关联**：`task_create({ teamTaskId: 'task-3' })`——只读校验任务存在并记下 revision（CAS 基线）。
   官方任务不存在 / 已完成 / Team 未开启时**明确报错**，不静默忽略参数。
3. **确认反写**：任务被**人/协调者确认**完成（工具 / 面板两条路径，`acceptedBy` 为 `coordinator` / `panel`）→
   `updateTask({ action:'complete', expectedRevision })`。`expectedRevision` 不符时**只重读一次、只再试一次**，
   仍冲突就记 `team.board.stale` 并提示，不重试轰炸；**失败只 warn，不回滚本地 done**。
   **超时自动完成不反写**（那不是人的确认）：只记 `team.board.skipped`（`reason: timeout`），官方板一次都不写。
4. **降级**：服务缺失 / 形状变了 / Team 未开启 → `enabled:false` 或 `degraded`，面板隐藏该分区，
   现有编排流程零变化；未开启官方 Team 的用户完全无感。

#### 代码

- **新增** `src/team-board.js`：只读快照（`readTeamBoard`）、关联校验（`linkBoardTask`）、CAS 反写（`confirmOnBoard`）、
  关联视图（`teamLinkView`）与进程级确认 sink（`setTeamBoardSink` / `emitTeamBoardConfirm`）。
- **宿主能力**：`src/host-capabilities.js` 加 `agentTeams()` 惰性访问器与第 10 类耦合 `team-board`
  （`isEnabled` + `listTasks` 探测）；`report()` 的 `total` 9 → 10。
- **台账**：新列 `team_task_id` / `team_task_revision`（旧库启动 ALTER 补齐，存量行 NULL = 没关联）；
  `createTask` 接受 `teamTask`，重派复制关联。
- **接线**：`delivered.js` 在 `closeDelivered` 成功后 emit 反写（旁路，异常吞掉；`acceptedBy='timeout'` 时
  index 的 sink 只记 `team.board.skipped`、**不调用** `updateTask`）；`host-route.js` snapshot 加 `teamBoard`
  与任务行 `teamTask`；`panel-actions.js` detail 加 `teamTask`；`tools.js` 的 `task_create.teamTaskId`、`task_status` 关联行；
  `task-detail.js` 告知子会话「官方任务只是只读关联，不要操作官方板」。

#### 测试

新增 `test/team-board.test.js`（fake `agentTeams`：只读行透传、`enabled:false` 不读板、服务缺失/抛错降级、
CAS 成功 / 冲突重读一次 / 二次冲突停手、不触发派发、确认后 sink 触发且 sink 抛错不挡 done）；
`test/host-capabilities.test.js`（10 类 + `team-board` 探测 + 文档同口径）、`test/host-route.test.js`（snapshot 的
`teamBoard` 与降级形状）、`test/tools.test.js`（`teamTaskId` 成功/失败/重派复制/`task_status` 行）、
`test/index.test.js`（缺 `agentTeams` 仍能 apply、快照只读行、协调者确认反写 CAS、官方报错只 warn，
以及**超时自动完成不调 `updateTask`、只记 `team.board.skipped`（reason: timeout）**）。

> 同批「未发布」里还有 P2-1（`task_create.checks` 可执行验收）与 P2-3（交接契约 v1），细节见
> `docs/ARCHITECTURE.md` 对应小节；本片只改 D6。

### P2-3 交接契约 v1（`acceptedBy` / `acceptedAt` + JSONL）

**P2-3：交接契约 v1（`acceptedBy` / `acceptedAt` + JSONL）**（`feat: P2-3 交接契约 v1（acceptedBy/acceptedAt + JSONL）`，单 commit，未 bump / 未 tag）

把「交付 → 确认 / 追问 → 完成」从插件内部状态机提升为**可被外部消费的只读契约**：稳定字段 + 版本号 + JSONL 审计事件。**v1 只做数据契约与事件，不做进程内订阅 API**（回调/事件总线留 v2）。

#### 能力变化

1. **`handoff` 对象（`contract: 1`）**出现在 `task_status`、面板 detail 端点、JSONL 事件三处：`taskId / sessionId / title / deliveredAt / acceptedAt / acceptedBy / rounds / evidence / status / closeReason`。字段表以 `docs/ARCHITECTURE.md`「契约字段」为唯一真源，`scripts/check-docs.mjs` 与 `src/handoff.js` 的 `HANDOFF_FIELDS` 逐字对齐（发布即契约，改名必须升版本）。
2. **三条确认路径各自带 `by`**：工具 `task_message({action:'close'})` → `coordinator`；面板「确认交付」→ `panel`；超时 sweeper → `timeout`。落库与事件只在 `closeDelivered` 一处写，重复确认走 `already` 分支（不写 accepted_*、不发第二条事件）。
3. **每日 JSONL**：`$DSH_HOME/state/orchestrator/handoff/handoff-YYYY-MM-DD.jsonl`，事件 `task.handoff.delivered`（进入待确认）与 `task.handoff.confirmed`（确认/超时），单文件超 5 MiB 换新、保留 30 天，与运行日志共用 `src/log.js` 的轮转实现；**不进仓库、不写台账 messages**，写入失败只 warn。
4. **视图**：snapshot 下发精简版 `{contract, deliveredAt, acceptedAt, acceptedBy, acceptedByLabel, acceptanceOk}`（不给证据，避免快照变大）；`task_status` 渲染「交接 / 交接轮次」两行；面板 detail 给完整契约对象。
5. **存量兼容**：`accepted_by` / `accepted_at` 由旧库启动时 ALTER 补列，存量行 NULL；v1 之前已 `done` 的任务没有 `handoff`（不是空壳对象），面板显示「没有交接记录」，不猜。

#### 代码

- **新增** `src/handoff.js`（~190 行）：`HANDOFF_CONTRACT_VERSION` / `HANDOFF_FIELDS` / `HANDOFF_EVENT` / `ACCEPTED_BY` 常量，`handoffOf` / `handoffOfTask` / `handoffSnapshot` / `handoffStatusLines`，进程级 sink（`setHandoffSink` / `emitHandoffDelivered` / `emitHandoffConfirmed`）与按天 JSONL 写入。
- **台账**：新列 `accepted_by` / `accepted_at`（ALTER 补齐）；新增 `setTaskAccepted`。
- **接线**：`delivered.js` 的 `closeDelivered` 成功后写确认信息并 emit `confirmed`；`index.js` 装配 sink（`transition` 观察者发 `delivered`、超时 sweeper 发 `timeout`）；`host-route.js` snapshot/detail 下发 `handoff`；`tools.js` 的 `task_status` 交接段；`panel-actions.js` 传 `by:'panel'`。
- **文档**：`docs/ARCHITECTURE.md` 新增「交接契约 v1」全节；`docs/api-notes.md` 记外部消费方式（`jq` 示例）；`scripts/check-docs.mjs` 新增字段/事件同源断言。

#### 测试

新增 `test/handoff.test.js`（契约字段齐全且 `contract === 1`、三条确认路径的 `acceptedBy`、重复 close 幂等且只发一次、未交付任务没有 `handoff`、存量 NULL 行渲染不炸）；`test/host-route.test.js` 断言 snapshot 的 `handoff` 精简版；`test/index.test.js` 断言 delivered/confirmed 事件接线与超时路径。

### P2-2 删自建 keepAlive、goal 收敛为单一写方、配置 35 → 28

**P2-2：删自建 keepAlive、goal 收敛为单一写方、配置 35 → 28**（`refactor: P2-2 …`，单 commit，未 bump / 未 tag）

这一版把「续跑」从插件自己实现改成交给宿主：删掉 `src/keepalive.js`（246 行，订阅 `agent/turn-stopping` 注入下一轮），
续跑改由 `task_create.goalRounds` 声明、平台 `dsh-goal-round-driver` 驱动；插件对 goal 只剩 `create` / `edit` / `complete` / `clear`
（+ 只读 `get`），**不再持有轮次预算**。同时把三个纯阈值键固定成常量，配置面 **35 → 28**。

#### 升级须知（行为变化）

1. **默认不续跑**：`task_create.goalRounds` 默认 **0**，与 P2-2 之前完全一致（create 后立刻 `disarm`）。
   需要续跑时显式传 `task_create({ goalRounds: 8 })`（1–50）；轮次由宿主 goal 轮次驱动，插件不注入消息、不模拟续跑。
2. **`keepAlive*` 四个键失效**：留在老 profile 里不影响加载——启动时各给一条弃用警告、按默认值运行。
3. **`goalRounds` 与 `planFirst` 互斥**：计划任务每轮都要停下来等批准，自动续轮会绕过批准闸门（`task_create` 直接拒绝）。
4. **通知合并窗口固定 5 秒**、**卡住提醒固定连续 3 次**、**偏好段条数上限固定 12 条**：三个键不再可配（同批任务仍合并成一条通知）。

#### 迁移表（7 个键）

| 旧键 | 迁移 |
|---|---|
| `keepAlive` | 删掉该键；要续跑改用 `task_create({ goalRounds: N })`（默认 0 = 不续跑） |
| `keepAliveMode` | 删掉：插件不再注入消息（回合形态归宿主 driver），没有 steer/followup 之分 |
| `keepAliveMaxRounds` | 删掉：轮次预算按任务声明（`goalRounds`，1–50） |
| `keepAlivePrompt` | 删掉：续跑提示由宿主生成；目标正文与「最新指示」都在平台 goal 里 |
| `mergeWindowMs` | 删掉：完成通知的合并窗口固定 5000 ms |
| `stallRounds` | 删掉：「连续 3 次 progress 无变化」是提醒口径，不再是策略 |
| `preferencesMaxItems` | 删掉：偏好段条数上限固定 12（字数主约束 `preferencesMaxChars` 仍可配） |

#### 代码

- **删除**：`src/keepalive.js`（246）、`test/keepalive.test.js`（330）、`index.js` 的装配与 disposer、
  `ledger.js` 的 `bumpKeepAliveRound()` 与「进 running 清零轮数」；`tasks.keep_alive_rounds` **停写、列保留**（旧库兼容）。
- **goal 单写方**（`src/goal.js` 291 → 248）：`attach`/`update` 按台账 `goal_rounds` 决定 activation——
  0 → `create` 后紧接 `disarm`（老行为）；>0 → `create({ objective, maxGoalRounds })` 并保持 armed。
  `edit` 只在文本/轮次变化时发；0 时把外部留下的 armed 压回 disarmed；平台没 arm 时记 `goal.degraded`（`reason:'not-armed'`）。
- **台账**：新列 `goal_rounds INTEGER NOT NULL DEFAULT 0`（旧库 ALTER 补齐）；`task_create.goalRounds` 落库、重派复制。
- **配置**（`src/config.js`）：删 4 + 3 键，7 条弃用提示（进程级去重、值不回填）；`loadConfig({})` 现在 **28** 键。
- **工具面**：`task_create` 新增 `goalRounds`（0–50 整数，非法值明确报错）；`task_status` 显示「目标状态｜目标轮次 x/y」；
  keep-alive 轮次行删除。
- **文档**：README（goal/续跑小节 + 配置表 28 行 + 排障）、`docs/ARCHITECTURE.md`（「子会话目标与续跑」重写，删 keep-alive 全节）、
  `docs/LIMITATIONS.md`（「自动续跑（委托宿主 goal）」）、`docs/testing.md`（28 键 + 两条复核索引）、`docs/api-notes.md`。

#### 测试

`test/keepalive.test.js` 删除（330 行）；`test/goal.test.js` 新增 armed/disarmed 两组断言与静态扫描（`src/` 不得再出现
`turn-stopping` / `createKeepAlive` 等引用）；`test/config.test.js` / `test/config-deprecated.test.js` 锁 28 键与 7 条弃用警告；
`test/index.test.js` 用 fake goals 断言「`goalRounds=0` → create+disarm」「`goalRounds=3` → create 带 maxGoalRounds 且保持 armed」。

### P2-1 `task_create.checks` 机器可判定验收（失败阻断交付）

**P2-1：`task_create.checks` 机器可判定验收（失败阻断交付）**（`feat: P2-1 task_create.checks 机器可判定验收（失败阻断交付）`，单 commit，未 bump / 未 tag）

`acceptance` 是给人读的标准，`checks` 是给机器执行的证据：**子会话报 `done` 时由插件先在任务目录跑一遍检查，全过才落「已交付待确认」，任一条失败即拒绝交付**（任务保持进行中）。这让「任务做完了」第一次有了退出码证据，而不是只靠子会话自述。

#### 能力变化

1. **`task_create` 新增 `checks`**：`[{ name?, command: string[], timeoutMs?, skipIfMissing? }]`，**1–5 条**；`command` 是 **argv 数组**（第 1 项是命令、≤16 项、单项 ≤2000 字符），按 argv 直接执行、**不经 shell**；`timeoutMs` 1s–600s（默认 120s）；`skipIfMissing` 让缺失命令记「跳过」而不是失败。
2. **交付语义**：全过 → `delivered`，回执/通知带「验收 N/N 通过」；任一失败 → **状态不迁移**、不登记产物、不发交付通知，只落验收证据 + `kind='acceptance'` 消息，返回失败清单（失败项、退出码、最后 10 行输出）。子会话修完重报 `done`（会重跑）或报 `blocked`；确认交付与超时 sweeper **都不重跑**检查。
3. **执行边界**：超时先 SIGTERM、5 秒后 SIGKILL（`timedOut:true`）；stdout/stderr 各只留最后 4 KiB；cwd 固定 `worktree_path ?? target_dir`，**不继承主会话目录**；**没有 `target` 或 `readOnly` 的任务拒绝配 `checks`**；命令只来自协调者的 `task_create`（`task_report` 没有任何命令参数可注入）。
4. **如实声明**：检查跑在**插件宿主进程**（宿主权限），不是子会话沙箱——隔离任务只是 cwd 在检出目录，不做「假安全」。
5. **视图**：`snapshot.tasks[].acceptance` 摘要（`ok/total/passed/skipped/failed/ranAt`）、`task_status` 验收段（逐条退出码/耗时）、面板抽屉「验收」区块与任务卡「验收 2/2」小标、`task_detail`/brief 的检查清单。

#### 代码

- **新增** `src/acceptance.js`（~375 行）：`normalizeChecks`（结构/条数/超时/字符上限校验）、`runChecks`（argv spawn + 超时 + 输出尾部）、`acceptanceCountText` / 失败文案 / 详情块（纯函数 + 可注入 spawn，便于测试）。
- **台账**：新列 `acceptance_json`（`{spec, ranAt, cwd, ok, total, passed, skipped, failed, results[]}`；旧库启动 ALTER 补齐，存量行 NULL = 没跑过），新增 `setTaskAcceptance`。
- **接线**：`tools.js`（schema、创建期校验、`task_report done` 前执行与拒绝交付）、`brief.js` / `task-detail.js`（检查清单）、`host-route.js`（snapshot 摘要）、`panel-actions.js`（detail 证据）。

#### 测试

新增 `test/acceptance.test.js`（normalize 边界、超时/跳过、尾部输出与截断）；`test/tools.test.js`（交付前执行、失败阻断且状态不变、无 `checks` 行为逐字不变、`readOnly` 拒绝配检查）；`test/ledger.test.js`（ALTER 幂等）；`test/client.test.js` 与 `test/panel-actions.test.js`（验收区块/小标/detail 证据）。

### 一并发布：0.22.1 少派一次活、少问一次关闭（2026-11-19 已发布为 0.22.1）

这一版只调**协调者提示词的两条行为取向**：少派一次活、少问一次「要不要关」。
工具面、台账结构、状态机、通知分级、配置键全部零变化，是 **patch**：升级不需要改任何配置或调用。

#### ① 能直接回答就不派任务（feat(coordinator)）

协调者过去遇到「再确认一下」的场合倾向新派一个子会话；现在提示词直接给出**二分判据**：

- 答案能从**记忆、上下文、已交付结论或本会话已知事实**得出 → 直接回复用户，不派子会话；
- 只有需要**新鲜取证**（读代码 / 跑命令 / 查远端或外部状态）、需要**写文件**、或需要**跨仓库证据**时才 `task_create`；
- 拿不准就用一句话自问：**这次要不要动文件、要不要跑命令**——都不要就直接答。

#### ② 不再主动问「任务能否关闭」（feat(coordinator)）

原文那条「待确认要主动问用户，不许只挂台账」把「交付后必须当场追问确认」变成了硬要求，
结果是每个任务交付都催一次用户表态。现在改成：

- 子任务交付后**不要**用 `ask_user_question` 问「确认 / 要改？」；任务保持 `delivered`（已交付待确认），
  到 `deliveredTimeoutMinutes`（默认 60 分钟）**超时自动完成**——用户看完还想改是常态，主动催反而添打扰；
- 交付后正常汇报**结果、产物与注意事项**即可，不附「确认 / 要改？」的尾巴；
- 用户主动说「要改 / 补充」→ `task_message` 追问**原会话**（复用，不新建任务）；
- 协调者确实需要终态（要派依赖它的任务、要删任务、要收尾整个需求）→ 自行 `task_message({ action: 'close' })`，**不用先问用户**；
- 提问收窄到**真需要拍板**的三种场合：方案歧义 / 业务取舍、不可逆操作（删数据、覆盖历史、强推）、
  远端写授权（推送、建 MR、发布、改权限）；多条待拍板**合并成一条清单一次问完**，不逐任务连问。

「默认保持待确认、不主动 close」「done 不是终态」「超时自动完成」这些既有语义**一条没动**——
只是把「必须主动问」换成「按意图收敛」。

**同步口径**：L2 brief 的 `CONFIRM_HINT` 不再向子会话承诺「协调者会带选项来问确认」（改为「不会为能不能关闭来问你」），
`src/prompt-layers.js` 的 L1 职责表、README 与 `docs/ARCHITECTURE.md` 的口径段落一并更新；
`test/copy-consistency.test.js` / `test/brief.test.js` 里锁旧口径的断言改成锁新口径，并新增一条锁「能直接答就不派」。

**验证**：`pnpm test` **994 例全通过**（`pretest` 含 `vite build` + `check:docs`）；
`check:docs`（2,043 行 / 预算 2,250）、`check:version`、`check:client` 均通过。

### 一并发布：0.22.0 插件页配置卡片（2026-11-19 已发布为 0.22.0）

这一版给插件加上了**插件页配置 UI**：在侧栏「插件」→ `dsh-orchestrator` 详情页里出现一张「配置」卡片，
可以直接改 35 个配置项，等价于手改 profile 的 `cordis.patch.yml`。此前配置只能改 YAML，插件没有任何 UI。

相对 0.21.0 是 **minor**：新增能力，配置键名/默认值/运行时语义零变化，不改变任何既有工具、台账或状态机行为。

#### 插件页配置卡片（feat(config-ui)）

- **机制**：DSH 的插件配置 UI 是「插件自带组件」模型——宿主只提供 `configForms`（值 + 写操作）与 slot，
  **不生成表单**（0.2.2-rc.3 的 `autoGenerate` 字段全 asar 无 client 消费方，已核实）。
  所以本次自带三件套：`src/config-fields.js`（35 个字段的单一事实源）、`src/config-schema.js`
  （投影成 schemastery `Config`，每字段 `.default().loose().volatile()`）、
  `client/src/config-form.js` + `config-logic.js`（分组折叠表单）。
- **暴露策略**：高频子集可编辑；`coordinatorSession` 与 `mainRotation.*`（含 `rotateArchiveOld`）
  只读展示——前者是运维兜底通道，后者牵动不可逆归档，不该在表单里手滑改。
- **保存语义**：写当前 profile 的 `cordis.patch.yml`，**重载插件或重启 DSH 后生效**（台账在 SQLite，不受影响）。**订正（0.23.0 发版前冒烟）**：运行中的插件不会因保存而重新 apply，判定/计时器仍按启动时那份配置。
  `mutate` 带 revision 栅栏，别人先改过就拒绝并刷新，**不静默覆盖**；清空一个「已覆盖」字段发 `unset`
  （回落组合默认且不再算覆盖）。
- **四个必须守住的 P0**（都已用反向验证钉住）：① 非法配置不得拒载（`.loose()` 兜底，否则 Cordis 校验失败会让插件起不来）；
  ② volatile 字段不得漏标（漏标 = 页面上静默少一行）；③ volatile 字段到达 `apply` 是带 `.get()` 的包装对象，
  不解包会让 `loadConfig` 全部失效、用户配置被无声丢弃；④ schemastery 解析失败不得拖垮整个插件
  （`createRequire` + try/catch 降级为 `Config=undefined`，宿主遇空 Config 跳过校验）。

**验证**：`pnpm test` 993 例全通过（含 11 条新增：四个 P0 守卫 + 字段集双向比对 + 废弃键不在 UI 表 +
mainRotation 默认 off）；`check:client` / `check:docs`（配置表 35 键）/ `check:version` 通过；
`pnpm install --frozen-lockfile` 复核通过；无头 Chrome 在隔离测试 profile 上真机验证 10/10
（卡片出现、字段数 35、6 个废弃键不出现、`mainRotation` 默认 `off`、保存写入 profile YAML、
手改 YAML 后显示「已覆盖」、清空字段回落默认），截图见 `reports/config-ui-verify/`。
## 0.21.0（2026-11-19）

这一版把 **P1 五片整体发出**：配置面 **41 → 35**、工具面 **15 → 10**（旧名给迁移提示）、文案收口到**单一真源**、
文档 **3,128 → 1,985 行**（`check-docs` 进 CI）、调试预设**移出主包**（−1,476 行不再随包发货）。
相对 0.20.1 是 **minor**：运行时契约（`task_report` / `task_detail` / `plan_save`、台账结构、沙箱注入、面板、通知分级）没变，
但有两处**升级须知**值得先看一眼：

1. **`mainRotation` 默认从 `auto` 改成 `off`**：升级后不再自动换主会话；要自动换就显式配 `mainRotation: 'auto'`。
   被删掉的 6 个轮换键留在老 profile 里不会报错（启动时各给一条弃用警告，按默认值运行）。
2. **六个旧工具名已删**：`task_stop` / `task_retry` / `task_close` / `task_inbox` / `history_search` / `project_context`。
   照旧名调用会拿到一条**可读迁移提示**（「已删除 + 改成什么 + 原来干什么」），不是「未知工具」；
   自定义提示词、`AGENTS.md` 与外部脚本里的旧名需要一次性手工替换（映射表见 P1-B）。

**五片一览**

| 片 | 一句话 | 用户可见变化 |
|---|---|---|
| P1-A | 配置 41 → 35，轮换只剩两个因子 | `mainRotation` 默认 `off`；6 个旧键弃用警告 |
| P1-B | 工具 15 → 10，旧名给迁移提示 | 模型侧选择面 12 → 7；旧名提示可读 |
| P1-C | 三组文案收口到 `src/copy.js` | 无行为变化，只是同一件事不再有第二套说法 |
| P1-D | 文档 3,128 → 1,985 行，三篇合并删除 | 三个旧文档链接失效（内容已迁入） |
| P1-E | 调试预设生成器移出主包 | 普通使用者无感；维护者命令改为 `node tools/debug-preset/cli.mjs` |

**发版验证**：`pnpm test` 982 例（977 pass / 5 skip / 0 fail，`pretest` 含 `vite build` + `check:docs`）、
`pnpm run check:client`、`pnpm run check:version`、`node scripts/check-docs.mjs`（1,987 行 / 预算 2,250）、
`npm pack --dry-run`（72 个文件，含 `docs/testing.md`，不含 DETAIL/UI/qa-checklist/调试预设）全部通过。

> 下面五节原在「未发布」段里逐片记录；各节末尾「不 bump 版本 / 不 push / 不打 tag」是那一片单独提交时的边界，
> 本版已五片合并发布，阅读时以本节为准。

### P1-A：配置面收缩 41 → 35（refactor(config)）

配置面从 **41 个键收缩到 35 个**，同时把主会话轮换降级成「两个因子 + 默认关闭」。
起因是「同一个事实在多处配置」：六个轮换因子里有四个（子任务数 / 子会话数 / 上下文 token / 日志总占用）
都在描述「主会话有点大了」，但它们的采集成本（读台账 + `listSnapshots` + 逐个 `stat` + `tokenMeter.measure`）
远高于一次 `locate` + `stat`；而三个时间参数（查不查 / 换不换 / 冷却）谁管什么，一直是支持成本最高的一段。

**删掉的 6 个键**（老 profile 里留着不影响加载：启动时各给一条弃用警告，按默认值运行）

| 键 | 迁移 |
|---|---|
| `backend` | 派发只剩 subagent 一条路（team 后端在 P0-1 已随平台 API 删除）：删掉该键即可，行为不变 |
| `rotateAfterTasks` | 因子删除：改用 `rotateAfterMainLogMiB`（日志体积）或 `rotateAfterDays`（龄） |
| `rotateAfterSessions` | 同上 |
| `rotateAfterContextTokens` | 同上 |
| `rotateAfterDiskMiB` | 同上（日志总占用与主日志体积高度相关） |
| `rotateCheckIntervalHours` | 检查节流删除：现在**每次打开主会话都现算**（一次 `locate` + `stat`），调低阈值后下一次打开即生效 |

**行为变化（升级须知）**

- `mainRotation` **默认从 `auto` 改成 `off`**：升级后不再自动换主会话。要自动换就显式配 `mainRotation: 'auto'`。
- 触发因子只剩 `main-log`（默认 6 MiB）与 `age`（默认 10 天）；十二条保护、`rotateIdleMinutes`、`rotateArchiveOld` 全部保留。
- 采不到的指标仍记 `degraded`（未知 ≠ 0）；两个因子都拿不到时 fail-closed 不换。

**代码**

- `src/main-rotation.js`：`ROTATION_DEFAULTS` / `ROTATION_LIMITS` 12 → 7，`ROTATION_TRIGGERS` 6 → 2；删 `rotationCheckWindow` 与 `evaluate` 里的节流闸门；`collectRotationMetrics` 只留 `locate` + `stat`（`settings.main_rotation_checked_at` 只读不写，旧库无害）。
- `src/config.js`：删 `backend`；新增 `DEPRECATED_KEYS` 弃用警告（进程级去重、值不回填）与 `resetDeprecatedKeyWarnings()`。
- `src/dispatch.js`：删 `TEAM_REMOVED_MESSAGE` 与占位派发器，`createDispatcher` 只剩 subagent。
- `index.js` / `src/tools.js`：去掉 `backend` 与 `tokenMeter` 接线。
- 文档：README 配置表 / 轮换章节 / 排障、`docs/ARCHITECTURE.md` 轮换节、`docs/LIMITATIONS.md`、`docs/api-notes.md`、`docs/compat.md` 同步。

**测试**：`pnpm test` 969 例全绿（净减 6 例：删掉 M1/M2/M4/M6 与检查节流用例，新增弃用键用例与「只剩两个因子」边界）。

### P1-B：工具面 15 → 10（refactor(tools)）

模型面的选择面 **12 → 7**（合计 15 → 10）：**旧名立刻删**（不注册、不在 `cordis.patch.yml` allow 名单里），
但**不静默**——照旧名调用会拿到一条可读迁移提示（「已删除 + 改成什么 + 原来干什么」）。
映射表的唯一真源是 `src/tool-migrations.js`（README 与本表都对齐它，测试 `test/tool-migrations.test.js` 断言三处一致）。

**迁移映射（旧名 → 新调用）**

| 旧名 | 新调用 | 说明 |
|---|---|---|
| `task_stop` | `task_message({ task_id, action: 'stop' })` | 停止任务：运行中/排队/等前置/已交付待确认都能停 |
| `task_retry` | `task_message({ task_id, action: 'retry' })` | 重派 failed/orphaned：新任务编号、旧任务留审计 |
| `task_close` | `task_message({ task_id, action: 'close' })` | 把「已交付待确认」确认成 `done`（走同一个 `closeDelivered`） |
| `task_inbox` | `task_list({ view: 'inbox' })` | 收件箱：待你决定/待确认/失败丢失/长时间没动静 |
| `history_search` | `context({ mode: 'history', query })` | 跨项目历史检索（插件记忆/历史任务/平台会话） |
| `project_context` | `context({ mode: 'project', target })` | 项目背景；只要工作区与仓库索引用 `context({ mode: 'workspaces' })` |

**合并明细**

- `task_message` 新增 `action: 'message' | 'stop' | 'retry' | 'close'`（默认 `message`；`message` 仅 `action:'message'` 必填）：
  吸收 `task_stop` / `task_retry` / `task_close`。业务实现搬成内部函数 `stopTask` / `retryTask` / `closeTask`，**一字未改**，
  错误码（`STOP_TASK_ENDED` / `RETRY_NOT_ALLOWED` / `CLOSE_NOT_DELIVERED` …）、门控顺序、文案全部沿用。
- `task_list` 新增 `view: 'list' | 'inbox'`（默认 `list`）：吸收 `task_inbox`，输出逐字一致（`limit` 只在 inbox 视图生效）。
- 新工具 `context` 用 `mode: 'history' | 'project' | 'workspaces'` 吸收 `history_search` + `project_context`，两段输出逐字一致；
  旧入参形状继续可用（`workspaces:true` → `mode:'workspaces'`，只给 `target` → `mode:'project'`）。
- 子会话契约 `task_report` / `task_detail` / `plan_save` **名字不变**（in-band 契约稳定）。

**文案面同步（漏一处就会出现「模型调用不存在的工具」）**

- `index.js`：协调者 policy 全部改到新入口（`context` / `task_list view:inbox` / `task_message action:*`），并新增一行
  「工具表就这 10 个 + 旧名映射」；执行层 `tools.guard` 增加旧名拦截 → 返回迁移提示（不挑 agent，子会话拿到同样提示）。
- `cordis.patch.yml`：协调者 allow 名单 13 项 task 工具 → 7 项（`task_stop` / `task_close` / `task_retry` / `task_inbox` /
  `history_search` / `project_context` 移除，`context` 加入）；4 个 schedule 与 `present` 不变。
- 文案模块：`src/digest.js`（日报提示）、`src/notify.js`（交付 hint，改成 `task_message({ action: "close", task_id: '<任务编号>' })`）、
  `src/action-errors.js`（5 条错误文案）、`src/onboarding.js`、`src/reconcile.js`、`src/plan-mode.js`、`src/watchdog.js`、
  `src/write-guard.js`、`src/deps.js`、`src/settlement.js`、`src/memory.js`（经验文件里的指引）、`src/preferences.js`。
- 文档：README 工具表（12 → 7 行）+ 新增「工具迁移映射」小节；`docs/ARCHITECTURE.md`、`docs/DETAIL.md`、`docs/LIMITATIONS.md`、
  `docs/UI.md`、`docs/qa-checklist.md`、`docs/compat.md`、`docs/api-notes.md`、`docs/CONTRIBUTING.md` 同步工具名。

**测试**

- 新增 `test/tool-migrations.test.js`（4 条）：10 个工具名集合精确相等、6 个旧名各有一条映射且指向的新工具真实存在、
  迁移提示只对旧名生效、CHANGELOG/README 两处映射表覆盖全部旧名。
- `test/tools.test.js` 所有调用点改到新入口（`task_message action:*` / `task_list view:inbox` / `context mode:*`）；
  `test/index.test.js` 的 guard 用例增加「旧名返回迁移提示」断言；`test/config.test.js` 断言 allow 名单不再列旧名。

**用户可见影响**：协调者工具 12 → 7（模型侧更少选择）；台账、面板、通知、错误码行为不变；
照旧名调用不再是一句「未知工具」，而是可读迁移提示；自定义提示词 / AGENTS.md 里的旧名按上表改一次即可。

**不做**：不加 `legacyTools` 兼容开关（那会多一个临时配置键，且旧名会重新出现在工具表里）；不动面板
（`panel-actions` / `host-route` / 客户端）；不删 stop/retry/close 的业务实现（只换入口）；不 bump 版本、不 push、不打 tag。

### P1-C：文案单源 + 属性测试（refactor(copy)）

把「计划阶段怎么落盘」「交付不是终态」「完整访问是什么」这三件事的措辞收口到**一个叶子模块**
`src/copy.js`（不 import 任何模块，谁都能引用而不引环），其余模块只引用、不再各写一份；同时补一组
**固定种子的属性测试**（12,000 步状态迁移 + 10,000 组文案组合），防止文案与状态机在随机组合下漂移。

**合并的文案源**

| 文案域 | 真源（`src/copy.js`） | 复用到 |
|---|---|---|
| 计划阶段 | `PLAN_PHASE_LINES`（原子句）/ `PLAN_FIRST_DETAIL` / `EXIT_PLAN_MODE_DENIAL` / `PLAN_STATUS_LINES` / `planDocPathText()` / `planCreateReceipt()` / `PLAN_SAVE_TOOL_DESC` / `planSavedNextStep` | `task-detail`（L3 详情）、`plan-mode`（计划域门面，转出同一对象）、`plan-doc`（落盘回执）、`tools`（`task_create` 回执 + `plan_save` 工具描述）、`dispatch`（`exit_plan_mode` 拒绝文案）、`index.js`（协调者 policy 插值） |
| 两段式终态 | `DELIVERY_LINES`（状态名/非终态/追问/确认/超时原子句）/ `DELIVERY_NOT_FINAL` / `DELIVERED_HINT` / `finishHint()` / `deliveredReceiptNote` | `task-detail`（L3 完成动作）、`brief`（L2 回报指引同源 `SUMMARY_FIELDS`）、`notify`（交付通知动作指令）、`prompt-layers`（跨层共享口径）、`keepalive`（续跑提示）、`write-guard`（冲突提示）、`tools`（回执/`task_status`/收件箱）、`deps` / `main-rotation` / `tool-migrations`（状态名） |
| 完整访问 | `ACCESS_FULL.label` / `.briefLine` / `.workerHint` / `.createNote` | `brief`（L2 访问级别行）、`task-detail`（标签 + 纪律提示）、`tools`（`task_create` 回执 + `task_status` 行） |

**删掉的重复点**（同一句话原先各写一份）

1. **计划出口**（`plan_save` 落盘 → `task_report blocked` 只报摘要 → 批准后续派）：`plan-mode.js` 的
   `PLAN_FIRST_DETAIL`（7 行块）、`EXIT_PLAN_MODE_DENIAL`、`planStatusLine` 的 planning 行，`plan-doc.js` 的
   `planSavedNote`，`tools.js` 的 `task_create` 回执与 `plan_save` 描述，`index.js` policy 各一份 → **7 处 → 1 处**。
2. **交付不是终态**（状态名 + 追问复用原会话 + 确认/超时收成完成）：`prompt-layers` 的 `DELIVERY_NOT_FINAL`、
   `notify` 的 `DELIVERED_HINT`、`task-detail` 的 `FINISH_HINT`、`tools` 的交付回执 / `task_status` 交付行 /
   收件箱汇总 / 追问回执、`write-guard` 的待确认提示、`keepalive` 的续跑提示 → **10 处 → 1 处**（状态名与五个原子句）。
3. **完整访问**：`brief` 的【访问级别】行、`task-detail` 的标签与风险提示、`tools` 的创建回执与状态行 → **5 处 → 1 处**。
4. **客户端双份文案**（浏览器 bundle 不能 import 服务端模块）：`client/src/constants.js` 的 `PLAN_STATE_LABEL` /
   `STATUS_LABEL` 保留字面量，但加**同值断言**（`test/copy-consistency.test.js`），漂移即红。

**属性测试（`test/status-property.test.js`，4 条）**

- 随机迁移 **12,000 步**（固定种子 `0x9e3779b9`，同种子路径逐条可复现）：每步 `canTransition` / `nextStatus` 与
  `TRANSITIONS` 逐位一致，非法边必抛错；走到终态即「重启新任务」，12k 步覆盖全部 10 个状态；耗时 ~120ms（预算 < 2s）。
- **能力位不变量**：`terminal ⇒ !followup`、`releases ⇒ !active`、`rotationActive/waiting ⇒ active`、
  `followup ⇒ 有回 running 的边`、`retryable ⇒ 不能原地复活`、非活跃态只能迁到非活跃态（终态闭包）、
  无出边 ⇒ 必须是流程终态。
- 文案随机组合 **10,000 组**（只读 × 完整访问 × 计划 × 四种 `plan_state` × 隔离 × 编排字段）：同输入渲染两次逐字相同、
  只读与完整访问互斥、计划说明恰一段且逐字等于 `PLAN_FIRST_DETAIL`、「已交付待确认」恰出现一次，并断言四条分支都被覆盖。

**测试断言**

- `test/copy-consistency.test.js` 新增 5 条：原子句标记只许出现在 `src/copy.js`（静态扫描 `src/**` + `index.js`）；
  计划文案在详情 / 创建回执 / 工具描述 / 落盘回执 / 拒绝文案 / policy **逐字同源**；交付文案在 brief / 详情 / 通知 /
  分层常量同源；完整访问文案四处同源；客户端 `PLAN_STATE_LABEL` / `STATUS_LABEL` 与服务端**同值**。
- 用例数 973 → **982**（+4 属性 +5 单源）；`pnpm test` 982 条 / 977 pass / 5 skip / 0 fail。

**文案差异（两处等价说法统一，无行为变化）**：`plan_saved` 回执补上摘要口径「（做什么、改哪些文件、怎么验证）」
与 500 字上限的说明；`task_status` 的完整访问行由「（danger-full-access）——该子会话…」改为与 brief/详情同一句。

**用户可见影响**：无行为变化（工具契约、台账、面板、通知分级、沙箱注入都没动）；只是同一件事不再有第二套说法。

**不做**：不改工具面（P1-B 已完成）、不动配置（P1-A）、不合并文档（P1-D）；不删 `plan-doc.js`（只读沙箱下唯一写入口）；
不引入官方 `exit_plan_mode` 审阅流（P2）；不 bump 版本、不 push、不打 tag。

### P1-D：文档合并 + check-docs 预算（docs）

文档从 **3,128 行压到 1,985 行**（README + 顶层 `docs/*.md`，−1,143 行 / −36.5%），三篇重复/过时文档被合并后删除，
并把「文档别再长回去」变成 CI 断言：新增 `scripts/check-docs.mjs`（行数预算 2,250 + README 配置表/工具表与代码同源 +
包内文档存在 + 内链与锚点可达），`pretest` 与 CI 都会跑。

**合并与删除**

| 原文档 | 去向 |
|---|---|
| `docs/qa-checklist.md`（989 行） | → 新增 `docs/testing.md`（177 行）：怎么跑 / 门禁 / 断言口径 / 已知 flaky / 新功能自检模板 + 历史复核索引表（版本 → 要点 → 证据）+ 真机矩阵 |
| `docs/UI.md`（291 行） | → `docs/ARCHITECTURE.md`「界面与消息块」「回复底部关联任务 chip（官方 turnTail 槽位）」（token 表、交互、入口按钮、chip 规则/状态/性能） |
| `docs/DETAIL.md`（44 行） | → `docs/ARCHITECTURE.md`「插件页与面板错误码」（动作/错误码/门控同源/边界）；插件页简介合并进 README |
| `docs/LIMITATIONS.md`（250 行） | → 251 → **176 行**：与 README「已知限制」去重，README 只留入口级 6 条 + 链接，维护者细节只留本文件 |

- README：面板/UI 两处链接改指 ARCHITECTURE；配置表补 3 个漏掉的 `preferences*` 键（35 键齐）；轮换章节压成
  「两因子 + 12 保护 + 默认 off + 三条风险」；「更多文档」表换成 testing/ARCHITECTURE/LIMITATIONS/CONTRIBUTING/CHANGELOG。
- `package.json`：`files` 去掉 `docs/DETAIL.md` / `docs/UI.md`，加 `docs/testing.md`；新增 `check:docs` script，
  `pretest` = `pnpm run build && pnpm run check:docs`，`prepublishOnly` 也加一道。
- `locale/{zh,en}.json`：插件页 `meta.detail` 由 `docs/DETAIL.md` 改为 `README.md`（DETAIL 已删，不能让插件页 404）。
- 测试同步 4 处：`config.test.js`（files/locale 断言）、`copy-consistency.test.js`（docs 列表改 testing.md、常用工具断言改指 ARCHITECTURE）、
  `prompt-layers.test.js`（brief 行数断言改读 testing.md）、`write-guard.test.js`（去掉 DETAIL）、`client-build.test.js`（pretest 新口径）。

**`scripts/check-docs.mjs` 校验什么**

1. `README.md` + 顶层 `docs/*.md`（不含 `docs/superpowers/`、`docs/probes/`）总行数 ≤ 2,250；超了直接说「差多少 + 最大的几篇」。
2. README 配置表键集合 == `loadConfig({})`（35 个键；原来漏了 3 个偏好键，这次补上了）。
3. README 工具表工具名集合 == `createTools()`（10 个；迁移映射表里的旧名不算工具面）。
4. `package.json.files` 里的 `docs/*.md` 必须存在。
5. README 与 `docs/*.md` 的相对链接（含 `#锚点`）都可达；锚点按 GitHub slug 规则（CJK 保留、标点去掉、空格转连字符）。

**验证**：`pnpm test` 982 条 / 977 pass / 5 skip / 0 fail（`pretest` 里 build + check-docs 都过）；
`pnpm run check:client`、`pnpm run check:version`、`node scripts/check-docs.mjs`（1,985 / 2,250）exit 0；
`npm pack --dry-run` 72 个文件，含 `docs/testing.md`，不含 DETAIL/UI/qa-checklist。另做了反向验证：把 README 灌到 2,385 行 →
check-docs 报「多 135 行」并列出最大几篇；旧文档里指向已删文件的链接会被报出来。

**用户可见影响**：三个旧文档链接失效（README 已同步）；信息不丢（迁入 ARCHITECTURE / testing / LIMITATIONS）。
**不做**：不重写 README 首屏（≤1,800 行预算仍留 P2）、不删 CHANGELOG、不动源码行为；不 bump 版本、不 push、不打 tag。

### P1-E：调试预设外移（refactor(debug-preset)）

调试预设生成器从主包外移到开发仓库的 `tools/debug-preset/`：**移出 1,476 行**（`src/debug-preset.js` 626、
`test/debug-preset.test.js` 465、`docs/DEBUG-PRESET.md` 263、`scripts/orch-debug-preset.mjs` 122），
`npm pack` 不再包含这些文件。插件运行时行为不变：`config.workerPreset` 仍原样透传给宿主，`orch-debug` 照旧可用。

#### 改了什么

- 移动（保留 git 历史）：`src/debug-preset.js` → `tools/debug-preset/src/debug-preset.js`；
  `scripts/orch-debug-preset.mjs` → `tools/debug-preset/cli.mjs`；
  `test/debug-preset.test.js` → `tools/debug-preset/test/debug-preset.test.js`；
  `docs/DEBUG-PRESET.md` → `tools/debug-preset/README.md`。
- 新增 `tools/debug-preset/package.json`（`generate` / `check` / `test` 三个 script，private）。
- `package.json`：删 `files` 里的 `docs/DEBUG-PRESET.md`，删 `preset:debug` / `preset:debug:check` 两个 script；
  `tools/` 不在 `files` 白名单里，天然不随包发货。
- 文案：生成器/检查器提示从 `pnpm run preset:debug` 改为 `node tools/debug-preset/cli.mjs`；
  README（配置表 + 排障 + 文档表）、`docs/ARCHITECTURE.md`、`docs/LIMITATIONS.md`、`docs/CONTRIBUTING.md` 的指向同步。
- 测试：主包 `pnpm test` 不再跑这 26 例（用例数 −26，代码行 −465）；外移工具的用例一条没删，
  改由 `node --test tools/debug-preset/test/debug-preset.test.js`（或 `pnpm --dir tools/debug-preset test`）运行。
  主包新增断言：`package.json.files` 不含 `docs/DEBUG-PRESET.md`、两个旧 script 已删、`tools/debug-preset/` 四件套在位。

#### 安装（需要调试子会话时，维护者手动装）

1. `git clone https://github.com/wjj865-code/dsh-orchestrator.git`，在仓库根执行 `node tools/debug-preset/cli.mjs`
   （或 `pnpm --dir tools/debug-preset generate`）生成 bundle；
2. 用 `plugin_manager` 的 `install_bundle` 装生成目录；
3. 配置 `workerPreset: orch-debug`，**彻底退出 DSH 再启动**；
4. DSH 升级后先 `node tools/debug-preset/cli.mjs --check` 看漂移，再重新生成 + 重装 + 重启。

完整步骤（含手工合并 profile 补丁的备选路径）见 `tools/debug-preset/README.md`。

#### 回退

- 只停用调试能力：`workerPreset` 改回 `dsh-orchestrator-worker`（或 `plugin_manager remove_bundle`）→ 重启。
- 恢复「随包发货」形态：`git revert` 本 commit，生成器、测试、两个 npm script 与 `docs/DEBUG-PRESET.md` 全部回到主包。

#### 影响与不做的事

- 普通使用者无感：不配 `workerPreset` 时派发行为不变；已经装好的 `orch-debug` bundle 继续可用（插件运行时不 import 生成器）。
- 维护者工作流变化：`pnpm run preset:debug` / `preset:debug:check` 不再存在，改用上面的命令；这些文件不再随 npm 包装到本地。
- 不做：不 bump 版本、不改 `workerPreset` 透传语义、不改 `cordis.patch.yml`、不删已安装 bundle、不动面板。

## 0.20.1（2026-11-17）

这一版**只改测试，产品零变更**：`src/`、`dist/`、`index.js`、`preset-tools.js` 一行未动，不发新能力、
不改工具入参、不改台账结构、不改沙箱。发版的理由是让测试在**两类真实环境**下都说真话——
Windows 本地没开「开发者模式」时没有符号链接权限，以及宿主真实台账里确实躺着超大产物。

相对 0.20.0 是 **patch**（纯测试 patch）。

### 符号链接用例：建不了链接时 skip，不判失败（test）

- **问题**：Windows 未开「开发者模式」时，普通用户没有 `SeCreateSymbolicLinkPrivilege`，`symlinkSync` 直接
  `EPERM`。于是五条链接相关用例（三条整条、两条尾段）在本地永远红——红的是环境，不是被测代码；
  把它们删掉又会丢掉 CI 上的真覆盖。
- **修法**：`test/helpers.js` 新增两个导出——
  `canCreateFileSymlink()`：在临时目录里真造一条文件链接来判断能力，每进程只探测一次并缓存，探测目录用完即删；
  `SYMLINK_SKIP_REASON`：跳过原因写清楚「为什么没真跑」，**不许静默 pass**。
- **用到的地方**：`test/read-workspace.test.js` 的「目录里指向工作区外的符号链接被标为不可读」「符号链接逃逸被拒」，
  `test/artifact-location.test.js` 的「登记表里的符号链接仍被拒」「`deliverableOf` 的链接分支」——
  无权限环境走 `t.skip(理由)`，CI/有权限环境照常真跑（覆盖不减）。
  「已登记目录放开子树」那条只把**尾段造链接**的部分跳过，前面的目录/文件断言照跑。

### 存量台账抽样：把「体积拒绝」和「读取面缺口」分开（test）

- **问题**：原判据是「所有仍然存在的已登记产物都必须可读」。宿主台账里只要有一条超过 `MAX_FILE_BYTES`（4MB）的产物，
  这条回归测试就红——但那是**内容太大**，不是**读取面被收窄**（越界 / 未登记）。两者混在一起，
  会把人往「权限/登记表」方向引，而真正该做的是缩产物。
- **修法**：`test/artifact-location.test.js` 里抽样用例改两档判定——体积超限允许 `ok:false`，
  但错误文案必须且只能是体积类（`/文件过大/`）；其余（含上限内全部产物）必须 `ok:true`，
  任何「越界/未登记/不存在」都记进 `unexpected` 并由 `deepEqual` 报出明细（带任务号、路径、字节数）。
- **新增一条用例钉死语义**：「已登记的超大产物：按体积拒绝，不判成读取面缺口」——登记表认它（读取面是通的），
  拒绝文案不含「越界/未登记」，同一路径缩到上限内立刻可读；证明拒的是体积，不是权限。

### 测试

`pnpm test` 总数 998：**993 pass / 5 skip / 0 fail**。5 条 skip 全部是「本机建不了符号链接」的显式跳过
（跳过原因见 `SYMLINK_SKIP_REASON`），在 CI（ubuntu，有链接权限）上真跑。

## 0.19.2（2026-11-17）

修一个**可触发的真实缺陷**：对**失败任务**点「停止」（面板按钮或 `task_stop`），任务会被改成「已取消」，
「失败」这个信息就丢了——用户再也看不出它是失败，也看不出该重派还是该放弃。

相对 0.19.1 是 **patch**：只改一处判据（「已收尾」vs「流程终态」），不动台账结构、工具入参、状态机与沙箱。

### 停止失败任务不再抹掉「失败」（fix(state)）

- **根因**：面板 `stop` 与工具 `task_stop` 的幂等判定用的是 `TERMINAL_STATUSES`（`done`/`cancelled`/`orphaned`，
  **不含 `failed`**——因为 `failed` 还能重派）。于是失败任务走不到幂等分支，直接落到 `transition(failed → cancelled)`；
  转移表允许这条边（「停止」确实可以从失败态发起），但语义上等于把「失败」降级成「主动取消」。
- **修法**：新增 `stopIsIdempotent(task)`（`src/panel-gates.js`）——判据是「**已收尾**」（`done`/`failed`/`cancelled`/`orphaned`），
  不是「流程终态」。面板与工具两个通道都用它：失败任务再点停止返回 `already:true`，状态保持 `failed`。
- **两个通道一起修**：`src/panel-actions.js` 与 `src/tools.js` 的 `task_stop` 是两份平行实现（审计 §4.1.2），
  只修一侧会让「面板点一下」和「协调者调一次」结果不同——这正是审计指出的分叉风险。
- **兼容性**：对失败任务点「停止」从「改成已取消」变为「幂等成功」。若有人依赖旧行为把失败洗成取消，
  现在要显式 `task_retry`（重派）或面板「删除」。
- **不做的事**：本版**不**引入状态事实源（`status-facts.js`）、不改 `RESUME_STATUS` 里的死分支、
  不删三条不可达边——那些是 0.20.0 的结构收敛，属 minor，不塞进 patch。

### 测试

新增 3 条用例（总数 941 → 944，全绿）：`stopIsIdempotent` 判据单测、面板 `stop` 端到端、工具 `task_stop` 端到端。

## 0.20.0（2026-11-17）

这一版是一次**结构性收敛**，不是新功能：把三件「同一事实在多处判定」的东西各自收成一个唯一事实源——
产物位置（`artifact-location`）、状态判定（`status-facts`）、提示词分层（`prompt-layers`）。
起因是一份全量设计审计（`reports/design-audit/dsh-orchestrator-design-audit.md`）：15 个工具、940 条测试、
零运行时依赖的实现质量高于它的**文本层**，5 天 30 个版本的节奏让「同一句口径写五遍」累积成
**能力失效**——`read_workspace` 上线首日就只覆盖 21.3% 的真实产物。

相对 **0.19.2** 是 **minor**：`read_workspace` 的读取面放宽（能力变化）、偏好机制新增配置键、onboarding 文案瘦身；
台账结构、工具入参、沙箱默认值、状态机语义（只删了三条从未可达的边）都没变。

> 本版**不含** 0.19.2 的停止缺陷修复之外的任何行为修正；那一项已在 0.19.2 单独发布（patch）。
> 本版把 `stopIsIdempotent` 的判据从手写四态改成 `status-facts` 的 `releases` 能力，行为不变。

### 产物位置：已登记产物成为唯一合法性判据（feat(artifact)）

**问题**：`read_workspace` 的边界是「主会话工作区包含性」，而子会话按契约把产物写在 **target 目录**内
（`WRITE_HINT`：所有产出只写到该目录内）。两条规则各自自洽，拼在一起才断裂——真实台账 89 条产物里
**78.7% 落在 `read_workspace` 读不到的地方**，能力上线首日即失效。同时工具描述写着「子会话产物常落在
reports/ 等目录」，模型据此反复撞墙。

**修法**：把台账里**已经存在**的 `tasks.artifacts_json` 提升为产物唯一合法性判据（审计方案 C），四条读取路径
（`read_workspace` / 面板 `preview` / 右侧栏 / `present`）从此同源：

- 新增 `src/artifact-location.js`：`registeredArtifacts(tasks)` 构造登记表、`registeredMatch(realPath, registered)`
  判定命中、`deliverableOf(path)` 统一「能不能交付」的类型判定（`notify.js` 的 `classifyPath` 改为引用它）。
- `src/read-workspace.js`：`resolveWorkspaceTarget` 增加第二个判据——工作区包含性 **OR** 已登记产物；
  已登记的**目录**放开子树（产物允许是目录），已登记的**文件**只放开它自己。
- 两条安全边界（都有测试）：① 登记表**不扩大**读取面，未登记的同目录文件仍被拒；② 登记表**不借符号链接**
  放行——登记一个指向 `~/.ssh` 的链接不等于登记了任意文件。
- 工具描述与拒绝文案改口径：说清「工作区 **或** 已登记产物」，拒绝时区分「越界（未登记）」与「不存在」。
- 读取结果头行标明来源：`【工作区文件】` / `【已登记产物文件】（任务 t-xxxx 登记）`；审计日志加 `via` 与
  `artifactTaskId` 字段。
- **存量兼容**：不需要迁移任何数据、不需要改 `WRITE_HINT`。用宿主真实台账验证：91 条仍存在的产物
  **91/91 全部可读**（19 条工作区内 + 72 条登记产物），此前只有 19 条可读。

### 状态判定：单一 caps 表（refactor(status)）

**问题**：`state.js` 有唯一转移表，但**状态集合**被复制到 9 个模块，已产生三处真实不一致：

1. `tools.js` 的 `RESUME_STATUS` 含 `failed`，面板层不含——但 `followupGate` 一直拒绝 failed，工具层那个 `failed`
   是**死分支**，表达的是错误意图；
2. 「流程终态」（无 `failed`）与「要释放资源的终态」（有 `failed`）名字几乎一样、语义不同；
3. 面板 stop 用「不含 failed 的终态」做幂等判定 → 对**失败任务**点「停止」会走 `failed → cancelled`，
   把「失败」抹成「已取消」（**已在 0.19.2 修复**；本版把判据改由 `releases` 能力表达，行为不变）。

**修法**：新增 `src/status-facts.js`，一张 `STATUS_CAPS` 表回答 13 个具体问题（`active` / `followup` / `resumable` /
`deletable` / `terminal` / `releases` / `retryable` / `waiting` / `rotationActive` / `liveness` / `catalog` /
`watchdog` / `planSettled`），其余模块全部派生：

- 删掉 13 处本地状态 Set（`tools` / `panel-gates` / `panel-actions` / `settlement` / `reconcile` / `watchdog` /
  `main-rotation` / `host-route` 内联三态 / `ledger` 的两处 SQL 字面量）。
- `ledger.js` 的活跃状态 SQL 由 `ACTIVE_STATUSES` 生成，不再手抄字面量。
- **三条不可达边已删**：`running → done`、`failed → running`、`orphaned → pending`（自加入起无调用点）。
  `test/state.test.js` 的 10×10 矩阵曾把它们写成 `allowed`——**测试在保护死代码**；矩阵现在从 `TRANSITIONS` 派生，
  另有正向用例断言这三条必须被拒。
- **修掉三处不一致**：`resumable` 与 `followup` 分开（`running` 能续派但续派不改状态）；`terminal` 与 `releases`
  分开（`failed` 只属后者）；面板与工具的 stop 幂等判定统一用 `stopIsIdempotent`（`releases` 能力）——
  0.19.2 已就地修过这个缺陷，本版只是把判据换成能力表表达，行为不变（有回归用例）。
- **迁移有审计日志了**：`transition` 是全部状态变化的唯一入口，`index.js` 通过 `setTransitionObserver` 挂一次
  `task.transition` 日志（19 个调用点里此前只有 6 个有日志）。

### worktree 状态：caps 表 + 转移校验（refactor(worktree)）

- 新增 `src/worktree-facts.js`（叶子模块，不 import 任何东西——`worktree.js` 与 `worktree-request.js` 本来就互相
  引用，表放在其中一边会撞 TDZ）：`WORKTREE_STATE_CAPS`（`occupiesTarget` / `needsCreate` / `hasCheckout` /
  `showsBadge` / `retryable` / `notifyIsolated`）+ `WORKTREE_TRANSITIONS` + `canWorktreeTransition`。
- 7 份独立列表改为查表，派生结果与原先**逐一等价**（有测试锁定）。
- `setTaskWorktree` 现在校验转移（非法抛错，同 `tasks.status` 的做法）；同状态重复写入幂等。
- 这修的是同类 bug 第二次发生的结构原因：0.17.0 的 P1「`requested` 被误当占用目录」就是 7 份列表漂移的产物。

### 提示词分层：五层职责边界（refactor(prompt)）

**问题**：同一批口径写在 5 个地方（policy 3403 字 / brief / task_detail / onboarding 708 字 / 通知 hint），
**L1 与 L4 重叠 6 条**、**L1 与通知重叠 3 条**，还有 3 处措辞互相打架。

- 新增 `src/prompt-layers.js`：`PROMPT_LAYERS` 表定义五层的**独占职责**与 `forbids`，`layerViolations(id, text)`
  是机器可读的归层探针（测试用它防止「删掉的重叠又抄回来」）。
- **L4 onboarding 瘦身 708 → 525 字**：删掉 6 条与 L1 重复的能力边界（只协调不写文件 / 原生 read-glob 被拒 /
  read_workspace 边界 / 默认 worker 无自动化 / full 只改单任务沙箱）。理由：L1 每回合都在且不会被 compaction 吃掉；
  onboarding 是一次性 user message，轮换时还会被直接标 `sent` 跳过。
- **三处矛盾已修**：① 文档不再教「交付时选项进 `question+options`」（实现明确不支持，`done` 会清空）；
  ② brief 的 `CONFIRM_HINT` 与 task_detail 的 `FINISH_HINT` 统一成「summary = 结论 + 改了什么/改了哪些文件/
  怎么验证的 + 待确认要点」，同源 `SUMMARY_FIELDS`；③ `DETAIL.md` 的 brief 行数改为「4 行基准 → 4–6 行」。
- 跨层共享口径只留一份常量：`PRESENT_LIMIT_TEXT`（1-4 个）、`DELIVERY_NOT_FINAL`（done 不是终态）。

### 偏好机制：L1 policy 第 4 段（feat(preferences)）

- 新增 `src/preferences.js`：出厂种子 2 条（`cli-access-full` / `worktree-build-access-full`）、
  `normalizePreferences`（坏数据逐条丢弃不抛）、`loadPreferences` / `savePreferences` / `upsertPreference` /
  `setPreferenceEnabled` / `renderPreferenceBlock`。
- 存 `settings.orchestrator_preferences` 单键 JSON（与 `workspace_repo_index` 同一种存法），**不需要** `ALTER TABLE`。
- 注入点是 L1 的 `systemPrompt.context().text` 回调——**每回合重渲染**，改完下一回合生效，不用重启；
  放在 policy **末尾**（阅读顺序即优先级顺序），可单独开关（`preferencesInject`）。
- 预算：`preferencesMaxChars`（默认 1200，区间 200–4000）为主约束、`preferencesMaxItems`（默认 12，区间 1–20）
  为安全阀；超限按 priority 降序保留**完整条目**，段尾写明「另有 N 条未展示」——**不静默丢弃**。
- **不双写**（审计 §5.3 待定项 2 的结论）：全局偏好只写 settings，`history_search` 查不到；项目偏好只写 memories，
  随 `task_detail` 注入子会话。`memory_note` 的返回文案会明确告知这条偏好去了哪儿、会不会生效。
- **偏好不是权限通道**：只是提示词文本，不进 config、不改 dispatch、不碰 `sandboxPolicy`；内置种子里不放任何
  「放宽安全边界」的条目（测试有正向断言）。v1 不带 `scripts/preferences.mjs`（避免第二套写入路径）。

### 文档漂移修正

- `docs/ARCHITECTURE.md`：全局工具数 14 → 15（含 `read_workspace`）；新增「状态事实源」「worktree 状态事实源」
  「提示词分层」三节；`read_workspace` 一节改为「两个判据的并集」。
- `docs/DETAIL.md`：常用工具补 `read_workspace`；brief 行数与实现对齐（4–6 行）。
- `docs/LIMITATIONS.md`：删掉「选项进 question+options」（教用户用不存在的能力），改为如实说明 `done` 不支持；
  新增「状态与提示词的单一事实源」一节。
- `README.md`：`read_workspace` 边界、brief 行数、交付 summary 口径、偏好机制各节与实现对齐。

### 测试

新增 4 个测试文件、53 条用例（总数 944 → 997，全绿）：

- `test/artifact-location.test.js`（13 条）：已登记产物可读 / 未登记仍拒 / 符号链接不放行 / 目录子树 /
  工作区优先 / 存量台账抽样（真实台账 91 条全部可读）。
- `test/status-facts.test.js`（11 条）：caps 表完整性、三处不一致的回归、静态断言「`src/` 里不再有本地状态集合」。
- `test/prompt-layers.test.js`（12 条）：五层归层探针、onboarding 瘦身、三处矛盾回归、跨层常量同源。
- `test/preferences.test.js`（13 条）：归一化、预算截断、不双写路由、出厂种子约束、配置夹取。

`test/state.test.js` 的矩阵改为从 `TRANSITIONS` 派生并新增「三条死边必须被拒」；
19 处 `transition(db, id, 'done')` 测试夹具改为 `markDone(db, id)` 走合法的
`… → delivered → done` 路径（这正是「测试锁死死代码」的清理）。

## 0.19.1（2026-11-17）

修一个视觉不统一的小问题：主会话会话头左上角的「任务」入口按钮原本带 1px 描边 + 不透明白底 +
hover 悬浮阴影，而同一排的**协调者预设标签**和**子智能体计数**都是无描边、透明底的 chip，
于是它一个人在同排里「凸」出来。

相对 0.19.0 是 **patch**：只改一条 CSS 规则（加删一条 hover 规则），不动逻辑、结构、槽位注册与台账。

### 任务入口去掉外边框（fix(ui)）

- `.orch-btn--entry` 不再自己声明 `border-color` 与 `background`，改为沿用基类 `.orch-btn` 的
  `border: 1px solid transparent` + `background: transparent`。保留 1px 透明描边是为了**不改盒模型**：
  按钮高度仍是 26px，与宿主头部 28px 紧凑控件同基线（`<button>` 默认 `border-box`）。
- 删掉 `.orch-btn--entry:hover`（原来换描边色 + 加 `--dsw-shadow-lv1`）。hover / active / disabled /
  focus-visible 四态全部继承 `.orch-btn`：hover 只换 `--dsw-alias-interactive-bg-hover` 并转文字色，
  active 再加 `scale(.985)`，disabled 降到 `opacity: .45`，focus-visible 走焦点环——都不出现描边或阴影。
- 内边距 `0 10px` → `0 4px`：10px 是给描边按钮留的呼吸位，收窄后与相邻 chip 同级（协调者标签 0/2px、
  子智能体计数 2/2px）。品牌色方块（`.orch-entry-mark`）与文字（`.orch-entry-label`）未动。
- 新增一条测试守住「不画外框」：断言该规则块里没有 `border*` / `background*` / `box-shadow` 声明、
  不再引用描边色 token、样式表里不存在 `.orch-btn--entry:hover`、内边距是 `0 4px`。反向验证过：
  把描边加回去这条用例立刻失败。

## 0.19.0（2026-11-17）

这一版给**协调者**加了一只受控的手：新增 `read_workspace`，主会话终于能直接「看一眼」子会话落在工作区的
产物正文（报告、调研、评审、`diag/` 快照），不必再派一个子任务或靠 `task_status include:'full'` 读最后一条
返回消息；同时**派发 brief 多了三段提示**，把「执行中遇阻怎么上报、交付时怎么给选项、worktree 里可以装依赖」
从口头约定变成子会话一开始就看得到的话。

相对 0.18.2 是 **minor**：新增 1 个工具（协调者 11 → 12 个，全局 14 → 15 个）、brief 行数与文案变化；
台账结构、状态机、配置键、派发/沙箱/通知链路都没动。

### 协调者受控读工作区产物（feat(coordinator)）

- 新工具 `read_workspace({ path, offset?, limit? })`，**只对主会话开放**（`requireMain`）。读的是
  `$DSH_HOME/state/orchestrator/workspace` 之下（`reports/`、`diag/`、`backups/` 等），不是全盘。
- **为什么不开放原生 `read`/`glob`**：平台的文件工具没有读路径白名单——`dsh-fs-sandbox` 只给写操作加栅栏
  （`Reads pass through untouched: every mode permits reading.`），`LocalFileSystem` 的 `cwd` 只是相对路径基准
  而非包含性边界，`glob` 直接 spawn ripgrep 用 `--no-ignore --hidden` 全树枚举。给协调者开原生 `read`
  等于给它一个**全盘可读**的宿主进程读者（`~/.dsh/.credentials.yaml` 也在射程内）。所以自建一条只读工作区的入口。
- **三道闸**：① 形状（空路径 / 含 NUL / `~` 开头拒绝，不做家目录展开）；② `realpathSync` 真实路径包含性
  （挡符号链接逃逸，含中间目录是链接的情况）；③ 真实路径解析失败时退回词法包含性，把「越界」与「不存在」分开报。
- **体积与截断**：单文件 > 4 MB 直接拒绝（不整块读入）；正文按行窗口返回（默认 400 行 / 上限 2000 行、
  单次 ≤ 64 K 字符），截断给 `nextOffset` 续读；单行本身超上限时只返回该行前 64 K 字符并标 `truncatedLine`，
  `nextOffset` 仍指向**下一行**。目录只列一层、最多 200 项，指向工作区外或断链的符号链接条目标 `readable:false`。
- **入参宽容**：`offset`/`limit` 收数字也收字符串（先 `Number()` 再判有限），非法值回落默认，不静默忽略。
- **审计**：`workspace.read`（只记路径/类型/体积，不记正文）、`workspace.read.rejected`。
- **不用于校验存在性**：存在性仍由插件（通知路径已 `lstat`）与子任务保证，`present` 只列真实文件。

### brief 三段提示（feat(brief)）

派发 brief 从「任务编号 + 先调 `task_detail`」两行，扩成含两段固定提示的四行（完整访问多一行【访问级别】，
隔离任务再多一行【worktree 依赖】）：

- **【执行中待确认】`blocked` 上报**：执行中遇到需要用户拍板的事（业务取舍、范围变更、不可逆操作、方案歧义），
  用 `task_report` 的 `blocked` 上报「问题 + 选项建议」，由协调者 `ask_user_question` 问用户后经 `task_message`
  续派再继续；不自行假设用户意图、不阻塞等待、不因等不到回复就跳过。**`blocked` 只是上报，不等于已获授权。**
- **【确认方式】交付时给选项**：`done` 会清空 `question`/`options`，所以待确认要点必须写进 `summary`；
  子会话直接调 `ask_user_question` 会被平台以 `DELEGATED_CALLER` 拒绝（`assertLiveRoot` 见到
  `origin === 'subagent'` 就抛），问用户始终由协调者带选项做——brief 因此不写「你去调 ask_user_question」。
- **【worktree 依赖】隔离任务可装依赖**：检出目录是全新目录，`node_modules/`/虚拟环境不在库里，
  子会话可执行安装命令（`pnpm install` / `npm install` / `uv sync` 等），**只安装不升级**（不改依赖声明与版本）。
  只在 `requested`/`created`/`reused`（`ISOLATED_WORKTREE_STATES`）出现；`none`/`degraded` 仍在原工作树、依赖齐全，不给这行。
- 字段映射收敛到 `renderBriefForTask(task)`（`src/brief.js`）：`tasks.access` / `tasks.worktree_state` 是唯一真相，
  `task_create` / `task_retry` / 面板 retry / 队列兜底四个入口共用，不再各自拼一遍参数。

### 行为说明（升级者注意）

- **协调者获得了读工作区文件的能力**：这是本版最实质的变化。范围被限制在主会话工作区，越界/`../` 穿越/
  符号链接逃逸都会被拒并留审计日志，但「工作区里本来就有的文件」都能读——包括子会话写进去的产物正文。
- **IM 外发风险（残余风险，不可配置）**：若 profile 开了 IM 双向同步（如 `@xmanrui/dsh-im`），协调者读进上下文的
  正文可能随「最终助手文字」同步到外部渠道且**不可撤回**。涉密产物不要用 `read_workspace` 读进主会话。
- **子会话在 target 目录里写的产物仍读不到**：`read_workspace` 只能读主会话工作区；仓库里的改动、worktree
  检出里的文件要子会话回报路径，或把摘要写进工作区产物。这是「只开一个受控入口」的直接代价。
- **brief 变长但不含详情**：新增的都是固定提示行，目标/验收/经验/前置/产物仍不内联，仍靠 `task_detail` 现取。
- **不需要迁移**：没有台账结构、配置键、状态机变化；升级后新派发的任务才带新 brief，已存在的任务不受影响。

### 文档

- README 增「读工作区产物（`read_workspace`）」一节（含边界表、截断口径与 IM 外发提示）、工具清单 11 → 12 /
  14 → 15、brief 三段提示说明与自检口径；四处版本号同步到 `0.19.0`。
- ARCHITECTURE 补 `read_workspace` 的分层（`src/read-workspace.js` 纯逻辑 + `src/tools.js` 身份校验/审计）与三道闸。
- LIMITATIONS 补「协调者读工作区产物」与「子会话不能直接问用户」两组边界，写明 IM 外发与只读主会话工作区的代价。
- DETAIL / qa-checklist 同步 brief 形态（两行 → 四行）与提示触发条件。

### 验证

- `pnpm test`（`pretest` 自动构建）**940 passed / 0 failed**；`pnpm run check:client` exit 0。

## 0.18.2（2026-11-17）

这一版是**一处交互补齐的 patch**：主会话回复底部那排「关联任务」chip，点下去以前只会开任务面板再弹详情抽屉，
用户以为它能跳会话。现在**有子会话的任务点一下就跳进那个子会话**（与面板行「打开子会话」走同一个宿主入口）；
**没子会话**（待派发 / 等前置 / 台账里没有 `session_id`）仍降级打开任务详情，并把「点下去会发生什么」写进
tooltip。相对 0.18.1 没有工具入参、台账结构、配置项、服务端行为变化，只有客户端 chip 的点击语义。

### chip 点击跳转子会话（feat(client)）

- 新增 `chipOpenTargetOf(task)`（`client/src/logic.js`）：`childSessionId` 有值 → `{ kind: 'session', sessionId }`，
  否则 → `{ kind: 'detail' }`。点击目标只由这一个纯函数决定，视图与 tooltip 都读它，不会再各写一份而分叉。
- 快照裁剪 `slimTask` 补上 `childSessionId` 并计入身份签名（`client/src/feed.js`）——子会话一变就触发重渲染，
  不必等台账再动一下。
- 跳转走宿主唯一官方入口 `ctx.uiWorkspace.openSession(sessionId)`，抽成 `openChildSession`；
  面板行的「打开子会话」、详情抽屉、主会话启动器与 chip 四处同一实现（`client/src/client.js`）。
- **降级两条路**：① 任务本身没有子会话 → 老行为（一次性 focus 请求 + 开面板 + 弹详情抽屉）；
  ② 宿主不认这个 id（会话已归档 / 目录已清理 / 宿主无该能力）——`openSession` 同步抛
  `sessions.retain: unknown session <id>`，客户端 try/catch 兜住后同样开面板定位，并在抽屉顶部显示一条提示：
  「子会话已打不开（原因），已改为展示任务详情」。
- **不假装能跳**：`chipTooltipOf` 追加「点击打开子会话 / 无子会话，点击打开任务详情」；`data-orch-chip-open`
  落在按钮上（测试的稳定观察点）；无子会话的 chip 用 `cursor: default`，不给「可跳转」的手感误导。
- **提示生命周期**：`createFocusRequest` 增加 `takeNotice()`——与 `take()` 同样「取走即清空」，而 `take()` 的
  返回值仍是任务 id 字符串（老契约不变）；抽屉关闭时清空，不残留到下一次打开面板。
- **测试**：点击目标判定、tooltip/cursor 分化、无子会话降级、`openSession` 抛错降级 + 提示、签名含
  `childSessionId`、chip 首帧结构（`test/client.test.js`）；`dist/` 重建（`pnpm run build` 产物随源码提交）。

### 文档

- README 四处版本号同步到 `0.18.2`（当前版本、安装命令、故障排查「确认装的是」、镜像未同步时的显式版本）。
- `docs/UI.md` §7 仍写着「点 chip 打开面板并定位」，与本次新行为不一致；本版按「发版提交只含版本文件」不动文档，
  已记为待办（另开文档单统一口径）。

### 验证

- `pnpm test`（`pretest` 自动构建）**905 passed / 0 failed**；`pnpm run check:client` exit 0；`pnpm run build` 通过；
  干净树里重跑 `pnpm run build` 后 `git status --short dist/` 为空（已入库产物与源码同源）。

## 0.18.1（2026-11-17）

这一版是**两处收尾的 patch**：会话头部底部那排 chip 在真实宿主里**根本不渲染**（判「最新一轮」时把
`TurnLocation` 对象当数字比），以及主会话轮换的检查**每次打开都做一遍**（读台账 + `listSnapshots` +
`stat` 会话日志）把打开拖慢——现在默认**一天最多查一次**。相对 0.18.0 没有工具入参、台账结构、既有状态机
变化；轮换只新增 1 个配置键 `rotateCheckIntervalHours`（默认 24h）。

### chip 渲染修复（fix(client)）

- **根因**：turnTail 槽位的 `owner.turn` 是 `TurnLocation` 对象（`{turn,start,end,status,steps,data}`），
  而 `snapshot.timeline.turnOrder` 是 `number[]`；旧实现直接 `order[last] === turn`，对象与数字恒不相等 →
  `isLatestTurn` 在真实宿主里永远 `false`，底部 chip 永不渲染。单测只传裸数字，正好绕过了这个 bug。
- **修法**：新增 `turnNumberOf`（`TurnLocation` 取 `.turn`，裸 number 保留兼容），`isLatestTurn` 改为字段比较；
  非法入参、空时间线不误判。
- **测试**：改用真实 `TurnLocation` + `ChatSnapshot` 形状，并加回归用例锁死「整对象比较」这一类错误；
  `dist/` 重建（`pnpm run build` 产物随源码提交）。

### 检查节流（feat(main-rotation)）

- 打开主会话的判定前先看 `settings.main_rotation_checked_at`：距上次真正检查不足 `rotateCheckIntervalHours`
  （默认 24，区间 1–168）就**整段跳过**——零采集、零判定，只留一条 `main.rotation.check.skipped` 日志；这次打开
  的固定开销从「读台账 + `listSnapshots` + `stat` 会话日志」压成一次 settings 读。
- `rotationCheckWindow()` 纯函数：首次检查 / 时钟回拨按「该检查」，到点用 `>=` 口径；间隔复用
  `normalizeRotationConfig` 归一化（非法值回落 24、越界夹到 1–168）。
- **只在「不需要换」时写检查时间戳**：`due = true` 不写（动作失败或进程崩了，下次打开还能重试），检查整体
  异常也不写。
- **三个时间参数分工别混**：`rotateCheckIntervalHours` 管「查不查」，`rotateCooldownHours`（48h）/
  `rotateMinAgeHours`（12h）仍管「换不换」——冷却期内检查照做，只是不换。
- `readRotationState` / `writeRotationState` 扩到五个键。

### 文档

- README 增「检查节流」小节（开关口径、三个时间参数分工、如何回到「每次打开都检查」、手动验证时先清
  `main_rotation_checked_at`），配置表补 `rotateCheckIntervalHours` 一行、故障排查与「已知限制」同步口径。
- ARCHITECTURE 补检查节流的执行顺序（节流 → 采集 → 判定 → 动作）、跳过日志字段与「只在 not-due 时写时间戳」
  的理由；LIMITATIONS 写明「调低阈值后可能先被节流挡一次」。

### 验证

- `pnpm test`（`pretest` 自动构建）**901 passed / 0 failed**；`pnpm run check:client` exit 0；`pnpm run build`
  通过；干净树里重跑 `pnpm run build` 后 `git status --short dist/` 为空（已入库产物与源码同源）。
- `chip` 回归用例覆盖：真实 `TurnLocation` 形状、`turnOrder` 尾项比较、空/非法入参；`rotationCheckWindow`
  覆盖：首次、未到点、到点边界、时钟回拨、间隔归一化，以及「due 不写时间戳」与「跳过零采集」。

## 0.18.0（2026-11-17）

这一版给主会话加**轮换**：协调者跑久了（默认 10 天 / 120 个子任务 / 会话日志 6 MiB / 上下文 15 万 token /
指挥舱日志总占用 512 MiB 等六个因子任一命中）会在**你下一次打开主会话**时换一个干净的新会话，
旧会话改名「主会话（已退役 …）」并按配置归档。判定是纯函数 + 只读采集，动作有 marker 崩溃锚点与启动恢复；
默认阈值都在「跑很久」量级，正常使用不会触发，`mainRotation: 'off'` 可完全关闭。

相对 0.17.1 是 **minor**：工具入参、台账结构、既有状态机都没动；新增 11 个配置键、4 个 settings 键
与一组 `main.rotation.*` 日志。

### 主会话轮换（feat(main-rotation)）

- **判定**：`src/main-rotation.js` 的 `evaluateRotation` 纯函数——M1–M6 六个触发因子（子任务数/子会话数/主会话日志/
  上下文 token/龄/日志总占用）+ 12 条保护（`active-tasks`、`delivered-pending`、`agent-running`、`recent-activity`、
  `min-age`、`cooldown`、`mode-off` 等）+ 冷却/最小龄；指标采不到按「未知」降级、六项全缺才 fail-closed；
  结论只进日志，不写任何 settings。
- **单点判定**：只在「打开主会话」时算一次（`main-session.openOnce` → `createRotationService.evaluate`），
  `due === true` 才动作；启动、`agent/created`、面板轮询都不判定（S4 的三处检测已回退）。
- **动作时序**：create → 写 marker → 切指针 → 写时间戳/跳过 onboarding → 新会话改名 → 旧会话改名+归档 →
  写审计+清 marker；create 失败 **零处置**、切指针失败旧会话仍可用（空白新会话归档）、后续每步只降级不回滚；
  启动时按 marker 幂等恢复（complete 补完 / abandoned 归档残留 / invalid 只清不猜）。
- **安全阀**：`rotateArchiveOld:false` 只改名退役不归档（**归档不可逆，平台无 unarchive**）；判定与动作之间不复查；
  并发 `open()` 单飞；轮换后新会话未 live 的 60 秒窗口内再打开直接交回同一 id，不重复建。
- **配置**：`mainRotation`（默认 `auto`，只认 `'off'` 关闭）+ 六个阈值 + 冷却/最小龄/闲置 + `rotateArchiveOld`，
  非法值回落默认、越界夹边界（见 README 配置表）。

### 文档

- README 增「主会话轮换」用户向说明（触发因子与阈值、十二条保护、默认策略与关闭方法、如何手动触发、归档不可逆等风险）、
  配置表 11 行、故障排查三条、已知限制一组。
- ARCHITECTURE 补模块分工、判定与保护、动作时序与回退边界、崩溃恢复四态、settings 键与日志事件。
- LIMITATIONS 补「主会话轮换」边界，重点写明**归档不可逆**、判定快照与动作之间不复查、采集降级口径、恢复的不可逆操作。

### 冒烟与验证

- 隔离冒烟（临时台账 + 桩平台动作，**不碰真实主会话**）跑通 13 项矩阵：隔离自检、not-due 零副作用（×2）、off 模式、
  open-main 命中路径、create 失败零处置、指针写失败 F3、只退役不归档、60s 窗口、崩溃恢复 complete/abandoned、
  配置归一化、纯判定契约。探针脚本是一次性验证件，不进仓库。
- `pnpm test`（`pretest` 自动构建）**892 passed / 0 failed**；`pnpm run check:client` exit 0；`pnpm run build` 通过。

### 升级提示

- 装新版仍要**彻底退出 DSH 再启动**（插件宿主侧代码在启动时加载，刷新页面不会换版本）。
- 升级后第一次打开主会话会**正常判定一次**：龄不到 12 小时、没有活跃任务时不会换；不想要这套机制就配
  `mainRotation: 'off'`，只想留旧会话入口就配 `rotateArchiveOld: false`。
- 旧主会话升级后不会被补做轮换，也不会补首次介绍/工作区索引任务。

## 0.17.1（2026-11-17）

这一版是**纯修复**：会话头「任务」入口的图标与文字没对齐。根因不在 flex、字号或间距算错，而是那套样式
**根本没生效**——桌面端升级插件包时，宿主会在页面存活期间热替换客户端插件（JS 重新求值），上一代构建注入的
`<style id="dsh-orchestrator-styles">` 却还留在 `<head>` 里；旧实现按 id 去重直接 return，于是 0.17.0 的新标记
（`.orch-entry-mark` / `.orch-entry-label`，0.14.1 的样式表里没有）一条规则都匹配不到，12px 的内联 SVG 便裸坐在
18px 行盒的基线上，比「任务」文字高约 2px，品牌气泡与主色也一并丢失。同排其他宿主 chip 有自己的样式，所以只有它偏。
相对 0.17.0 是 **patch**：工具入参、台账结构、配置项与既有行为都没动。

### 样式注入自愈（fix(client)）

- **按内容判定，不再按 id 一刀切**（`client/src/styles.js`）：`ensureStyles()` 发现同 id 的 `<style>` 文本与当前构建的
  样式不一致时**就地覆盖**，一致时不白写 DOM（幂等）。热替换后 CSS 自动追平 JS，不会再出现「新 JS + 旧 CSS」的混合态。
- **入口对齐规格回到样式表**（规则 0.17.0 已有，本次保证它们真的被应用）：按钮与图标块都走 flex 居中、
  `gap: 6px`、图标块 18×18、文字 12px。
- **测试**：新增两条回归 —— ① 旧样式内容不同 → 整段覆盖且不重复插 `<style>`，同一构建二次 `apply()` 不重写；
  ② 入口的 flex 居中、间距、尺寸、字号规则必须在本构建样式表里（断样式表，不只看标记）。另修一条既有断言在
  Windows 上的必挂（`test/write-guard.test.js` 的路径归一改为断不变量，不动 `src/write-guard.js` 行为）。

### 升级提示

- 装 0.17.1 仍要**彻底退出 DSH 再启动**；刷新页面只重载前端，不会换服务端代码。
- 已经在 0.17.0 上整页刷新过的人看到的是一致态（不会有错位）；本次修的是**以后再热替换**时样式跟着刷新。
  若此刻仍看到图标偏高，先整页刷新（Ctrl+R）恢复，再升级到 0.17.1。

## 0.17.0（2026-11-17）

这一版补上**同写域并发防护**：修掉一个真实事故的缺口——协调者在**同一个目标目录**并发派了两个都没开 worktree 的任务，
两个子会话同时写同一份工作树、改动互相覆盖。此前 `task_create` 的检查里 `target_dir` **从不参与冲突判定**，
`writeScopes` 只是 advisory 提示，`worktreePolicy=auto` 也没有代码分支。

相对 0.16.0 是 **minor，但含行为变更**：台账结构、状态迁移、既有工具入参都没动，但**同目录并发派任务默认被拒**——
这是本次要修的问题本身，不是顺带收紧。放宽方式见下「升级提示」。

### 同写域并发防护（feat(guard)）

- **默认拒绝**：新任务 target 与某个**活跃且未隔离**任务的 target 相同或互相包含（或两者 `writeScopes` 重叠）时，`task_create` 不创建任务，
  返回可操作错误并列出冲突任务名 + 目录。三条出路：先 `task_close`/`task_stop` 旧任务、传 `worktree:true` 隔离、或显式 `allowConcurrent:true`。
- **新增参数 `task_create.allowConcurrent`**（布尔，默认不传）：唯一显式放行开关；放行时返回里标注「并发风险」并记 `task.create.concurrent-write` 日志。
- **新增配置 `sameDirGuard`**：`require`（默认，拒绝）/ `warn`（只强警告）/ `off`（关闭，退回旧的 advisory）；非法值一律回落 `require`。
- **不受影响**：不同 target、worktree 隔离任务（`requested` 待建检出 / `created` / `reused` 都算隔离，含因 `dependsOn` 停在等前置的）、`dependsOn` 链上的前置任务、`readOnly` 任务、终态任务；`delivered`（待确认）算活跃，拒绝文案会提示改用 `task_message` 追问。
  例外：`degraded`（目标不是 git 仓库、隔离降级）仍在原工作树里写，照常占目录，拒绝文案会标注降级原因。
- **协调者 policy** 新增「同写域并发防护」段（含三条出路），避免被拒后原样重试。
- **文档**：README「同写域并发防护」+ 配置表、`docs/ARCHITECTURE.md`、`docs/LIMITATIONS.md`、`docs/DETAIL.md`。
- **测试**：新增 `test/write-guard.test.js`（纯函数 + task_create 集成：同目录被拒、父子目录、`allowConcurrent` 放行、隔离放行、只读不参与、
  `dependsOn` 不拦、写域重叠被拒、`warn`/`off` 降级、`task_close` 后可再派、日志留痕；隔离状态口径含
  `requested` 不占原目录、`degraded` 仍占、`worktree:true` + `waiting_dep` 不阻塞同目录任务）；`test/tools.test.js` 的写域 advisory 用例改为显式 `sameDirGuard:'off'`。

### 升级提示

- **行为变更（需要你确认一遍既有用法）**：以前「同一个目标目录并发派多个任务」是可以的（`writeScopes` 只打一行提示），
  现在默认**被拒**并返回可操作错误。三条放宽路径：改成 `worktree:true`（推荐，两个任务各在独立检出里跑）、
  先 `task_close`/`task_stop` 旧任务再派、或显式传 `allowConcurrent:true`（放行后返回里标注「并发风险」，冲突自负）。
  想整体退回旧行为就把配置改成 `sameDirGuard:'warn'`（只警告）或 `'off'`（完全关闭）。
- **`delivered`（待确认）也占目录**：它还占着目标目录，要接着改就用 `task_message` 追问原会话，不要新建同目录任务。
- 装 0.17.0 仍要**彻底退出 DSH 再启动**；刷新页面只重载前端，不会换服务端代码。

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)；版本号以 `package.json` 为唯一真源，
推 `vX.Y.Z` tag 触发 `.github/workflows/release.yml` 发布到 npm。

## 0.16.0（2026-11-16）

这一版全是**面板与入口的 UI 改造**：会话头入口按面板设计语言重做、删掉一个从来发不出请求的「追加」按钮、
产物预览改为复用宿主的会话右侧栏。相对 0.15.0 是 **minor**：没有破坏性变更——台账结构、工具入参、
状态迁移、门控判定（`canFollowup`/`canClose`/`canDelete`）与后端接口都没动，`preview` 端点也保留作回退。

### 会话头「任务」入口重做（feat(ui)）

- **视觉与面板顶栏 `.orch-brand` 同一套语言**：品牌色方块（`.orch-entry-mark`，18×18、`--dsw-radius-xs` 圆角、
  `--dsw-specific-bubble` 底、`--dsw-alias-state-business-primary` 前景）内装 `ui.js` 新增的 `menu` 内联 SVG
  （三条横线），右侧半粗文字（`.orch-entry-label`，12px）；不再用裸字符 `☰`。
- **按钮规格**：`.orch-btn--entry` 高 26px、`padding: 0 10px`、`--dsw-alias-border-l2` 描边、
  `--dsw-alias-bg-layer-1` 底、`--dsw-alias-label-primary` 半粗字；hover 换 `--dsw-alias-border-l3` + `--dsw-shadow-lv1`。
  hover/active/disabled/focus-visible 四态继承 `.orch-btn`，不重复声明。补 `aria-label="打开任务面板"`。
- 闸门不变：仍由 `client/src/gate.js` 的 fail-closed 判定控制「只在主会话显示」。

### 移除面板「追加消息」（fix(ui)）

- 旧「追加」按钮点击走 `window.prompt`，而 Electron 渲染进程把 `window.prompt` 换成抛错桩
  （`prompt() is not supported.`）——**这个入口从来没有真正发出过请求**。任务卡、抽屉底部动作条与 `messageControl`
  一并删除，`ui.js` 的 `message` 图标随之移除。
- **续派与计划批准统一走协调者 `task_message`**；服务端 `canFollowup` 门控与 `message` 端点都保留
  （快照仍下发该布尔值，只是前端不再消费）。README / ARCHITECTURE / UI 里「面板追加」的说法同步改掉。

### 产物预览复用宿主右侧栏（feat(ui)）

- **不自建预览视图**：产物库「预览」、任务卡产物路径、抽屉「产物」区块的路径，统一走
  `client.js` 的 `openArtifactPreview(path)` → `ctx.sidebarRight.openResource(address)`，由宿主的
  `@deepseek-ai/dsh-client-ui-sidebar-documentpreview`（`kind:'text'`）渲染 Markdown / 代码 / 图片 / PDF / Office。
- **地址拼装对齐宿主**：`logic.js` 新增 `fileAddressOf` / `fileAddressProblem`，拼
  `dsh-resource://file/session/<编码 id>/<逐段编码 path>`，与 `@deepseek-ai/dsh-util-workspace-path` 的
  `sessionFileAddress` 逐条对齐（`:` 保持字面以兼容盘符、**不 trim** 以保留 POSIX 合法首尾空格、
  非法 UTF-16 收敛成空串不让 `URIError` 冒到事件处理器）。文件预览类型只认领 `session` 作用域，所以必须带会话 id。
- **必须先切回会话**：右侧栏按 Session 挂载，面板占主栏时 `ctx.sidebarRight.mounted` 是 `undefined`，
  直接 `openResource` 会抛。顺序固定为 `selectPanel(null)` → `openResource`；**全部可用性探测都前置在切面板之前**，
  `openResource` 抛错时切回 `PANEL_ID` 再报错，保证提示落在还活着的面板上。时序不靠轮询 `mounted` 的宏任务轮数
  （早期实现的 4 轮 `setTimeout(0)` 已删）——座位没就绪就让宿主抛错、如实上报。
- **失败分四档**：`sidebar-missing`（宿主没装侧栏）/ `no-session`（拿不到当前会话 id）/ `bad-path`（路径为空或编码不出地址）/
  `host-refused`（宿主抛错，带原始 message）。**只有产物库那一行**能就地回退旧 `preview` 端点 + `previewBlock` 行内预览，
  任务卡与抽屉只提示「到产物页看或复制路径」，不假装成功。
- **不绕开「已登记产物」校验**：服务端 `preview` 端点只读本任务已登记产物，而右侧栏链路是宿主直接读文件；
  因此 `views.js` 的 `isRegisteredArtifact(path)` 在前端做等价校验，只允许快照卡片 / 产物库 / 详情抽屉三个
  服务端下发来源里出现过的路径。
- **依赖是软依赖**：`package.json` 的 `dsh.client.inject` 增加 `@deepseek-ai/dsh-client-ui-sidebar-right` 与
  `@deepseek-ai/dsh-client-ui-sidebar-documentpreview`（只是加载顺序的预取提示）；客户端 `inject` 数组**不加**
  `sidebarRight`——用 `serviceOf('sidebarRight')` 现取，写进 `inject` 会变成硬依赖、服务缺失时卡住 `apply`，
  那就没有「缺侧栏 → 提示 + 行内回退」这条路了。宽度/折叠/多 Tab/窄屏全屏由宿主负责，插件不存预览状态。

### 升级提示

- 装 0.16.0 仍要**彻底退出 DSH 再启动**；刷新页面只重载前端，不会换服务端代码。
- 产物右侧栏预览需要宿主装了 `ui-sidebar-right` 与 `ui-sidebar-documentpreview`；缺了会在产物库那一行提示
  「右侧栏不可用（<原因>），已改为行内预览」，其余位置提示去「产物」页看或复制路径。
- **本版 UI 未经真机视觉验证**：只过了 `vite build`、`npm test`（793 条）、`npm run check:client`、槽位探针与静态核对。
  入口按钮的实际观感、右侧栏 Tab 的真实滑出与几何、深浅色主题下的观感都需要在真实宿主里手工确认（见 [docs/UI.md](docs/UI.md) §8）。

## 0.15.0（2026-11-16）

这一版给协调者接上**宿主原生自动化**（不再只是派任务），并让新建主会话**首次打开时自报能力、顺手把已登记工作区的仓库映射存下来**。
相对 0.14.1 是 **minor**：新增能力与一个只读回报契约，没有破坏性变更——台账结构、既有工具入参、状态迁移、默认 worker 工具面都没动。

### 主会话原生自动化（feat(schedule)）

- **协调者预设挂宿主 `@deepseek-ai/dsh-tool-schedule`**：`cordis.patch.yml` 只给 coordinator 加一行，allow 显式保留
  `schedule_create` / `schedule_list` / `schedule_view` / `schedule_edit`；worker 预设不挂、不新增 allow。不另造调度器。
- **`index.js` 白名单同步**：`COORDINATOR_DENY` 删掉三个 schedule deny 名（原本是「缺失能力就当危险工具拦掉」的旧口径），
  文件/shell/团队/子任务专属禁止项一律不变；执行层 guard 对四工具放行。
- **协调者 policy 补真实契约**：四个工具的真实入参（`schedule_create` 必填 `title`/`prompt`/`rrule`/`target`；
  `schedule_edit` 用 `action:'update'|'delete'`，暂停/恢复用 `active:false|true`，没有独立 delete/pause 工具）、
  **Host-wide** 可见性、写操作需用户明确授权、`target:'this_session'` 自动编排边界、
  `new`/`new_once` 不是唯一主会话所以不能直接 `task_create`、`expectedUpdatedAt` 冲突保护、默认 worker 不开放、`access:full` 不增加工具。
- **缺能力诊断**：`checkScheduleCapability` 只在唯一主会话、打开/非 running 创建/idle/每轮 policy 渲染时检查
  `ctx.schedule` 与 `tools.get(name, agent)`；缺失去重 warning + policy 提示，恢复后自动消失，不改运行回合工具表、不调真实自动化 API。
  四个工具不进入 `createTools`，**插件全局工具数仍为 14**。
- **文档**：README「主会话原生自动化」、`docs/ARCHITECTURE.md`「原生自动化工具面」、`docs/LIMITATIONS.md`「原生自动化」。
- **测试**：预设挂载、preset-tools 初始/晚注册保留、白名单与诊断边界、口径一致性各一组。

### 首次打开介绍 + 工作区仓库索引（feat(onboarding)）

- **新建主会话启动一次模型轮次**：先介绍能力与权限边界，再立即派一个只读「工作区与仓库索引」子任务；
  `settings.main_onboarding:<id>` 用 CAS `pending→sending→sent` 防并发重复，**await 预设恢复成功再投递**，
  注入失败退 `pending` 并让 open 返回 `onboardingError`（HTTP 503 可见、重开可重试）。老主会话与 `coordinatorSession` 覆盖不补初始化。
- **新增 `src/workspace-index.js` + 随包 `scripts/workspace-index.mjs`**：只读扫描 **DSH 已登记**工作区，
  复用 `runGit`（`execFile`/timeout）读 `repoRoot`/`branch`/`HEAD`/`origin`/`commonDir`；remote 去 userinfo/query/fragment，
  非仓库/不存在/无权限逐项记录，**不 fetch/pull、不写文件、不新增依赖**。
- **回报契约 `task_report.workspace_index`**：仅接受该任务本人 `done` 的完整 JSON，按创建时名单校验覆盖并用名单真 title/path，
  与每任务成功标记同 `SAVEPOINT` 写入 settings 独立快照，**不覆盖手写 memories**；`project_context({workspaces:true})` 可查映射与采样快照。
- **结算兜底**：索引任务 `completed` 但缺本任务成功标记时落 `failed` 并提示 `task_retry`，防止遗漏/非法回报被自然误交付；
  普通任务与已交付只补消息的路径不变。
- **文档**：README「打开主会话」、`docs/ARCHITECTURE.md`「首次打开与工作区索引」、`docs/LIMITATIONS.md` 同名章节。
- **测试**：新增 `test/workspace-index.test.js`（扫描/脱敏/校验/回滚），并补首次打开、并发一次、投递失败重试、名单持久化回归。

### 升级提示

- 装 0.15.0 仍要**彻底退出 DSH 再启动**；刷新页面只重载前端，不会换服务端代码。
- 自动化四工具依赖宿主 `@deepseek-ai/dsh-tool-schedule`（契约核实于 DSH **0.2.2-rc.3**）；宿主缺该包时主会话会收到能力缺失提示，
  现有编排照常可用。升级宿主后请复核契约。
- 首次打开的介绍轮次**只在新建主会话时跑一次**，升级后历史主会话不会补跑；需要索引就自己派一个只读「工作区与仓库索引」任务。

## 0.14.1（2026-11-16）

这一版只改「怎么说」和「怎么读」：README 按**只服务使用者**重写（维护者内容移到 `docs/CONTRIBUTING.md`），
协调者预设从「默认立刻 `task_close` 确认」改成**默认保持待确认、不主动关闭**，并把 6 个文案面查出的 **13 处口径冲突**一次修干净、用测试锁住。
相对 0.14.0 **无破坏性变更**（patch）——台账结构、工具入参、状态迁移一字未动；唯一可感知的变化是「交付后默认停在待确认等用户拍板」。

### README 拆分：只写使用者要的

- **README 重写为 360 行使用者文档**：一句话定位 / 安装与升级（含「刷新页面不会换版本，必须彻底重启 DSH」）/ 快速上手 /
  状态机与交付口径 / 各任务类型 / 工具清单 / 配置 / 状态与数据 / 已知限制 / 故障排查 / 文档索引。
- **维护者内容移入新建的 `docs/CONTRIBUTING.md`（103 行）**：环境、仓库结构（模块地图）、本地开发命令、测试策略、
  发版流程（版本真源、`release.yml`、provenance、`NPM_TOKEN`、npmmirror 同步）、发布前清仓库、`dist/` 入库约定、改动边界。
- `package.json` 的 `files` 补 `docs/CONTRIBUTING.md`，保证 npm 包里 README 的链接打得开。
- 删掉过时内容：0.13 时代的「工具表 13 个」、keep-alive「与旧版逐字一致」、goal/keep-alive 各占一节的长篇历史叙述
  （压成「可选能力」两段）、「reports 文件确认存在后再 present」、「默认立刻 task_close」。

### 预设默认：交付后不自动关闭

- **协调者预设（`COORDINATOR_POLICY`）**：子任务报 `done` 后默认**保持待确认、不要主动 `task_close`**——追问窗口留着，
  用户看完结果常还要改；只有用户明确说「确认 / 没问题 / 不用再改」，或确实需要终态（派依赖它的任务、删任务、收尾）时才关闭。
  要改一律 `task_message` 追问（复用同一个子会话），一直不确认按 `deliveredTimeoutMinutes` 超时自动完成。
- **通知与视图同口径**：`DELIVERED_HINT` 不再以「确认：task_close」开头催关闭；`task_status` 交付行、`task_inbox`「待确认」栏头、
  `task_message` 追问回执、`task_report` 回执（受众是子会话，不再教它 `task_close`）全部改成「默认保持、确认才关、超时兜底」。
- **对子会话讲清语义**：`task_detail` 的收尾提示与 keep-alive 默认提示都补上「报 done 只是交付，会停在『已交付待确认』；
  收到追问就在同一会话继续，不要自行宣告任务结束」。
- 行为本身不变：超时自动完成仍默认 60 分钟兜底，协调者仍可随时 `task_close`；不想多一步可配 `deliveredTimeoutMinutes: 1`。

### 文案一致性：13 处冲突修复 + 测试锁定

- **6 个文案面、13 处**：`index.js` 预设（1）、`src/notify.js`（注释 / `PRESENT_HINT` / `DELIVERED_HINT`，3）、
  `src/tools.js`（`task_status` / `task_message` / `task_inbox` / `task_report`，4）、`src/task-detail.js`（收尾提示，1）、
  `src/keepalive.js`（默认续跑提示，1）、文档（`docs/DETAIL.md` 补「两段式交付」/`task_close`/`delivered` 可追问，1；
  `docs/ARCHITECTURE.md` 错字与旧版对比句，1；`README.md` 整篇重写，1）。
- **present 口径归一**：通知正文与注释里的「1-2 个最关键的」改为「1-4 个最关键的」（与 0.13.1 起的偏好一致）。
- **新增 `test/copy-consistency.test.js`（8 条）**：锁「口径」不锁措辞——`done` 不是终态、协调者默认不主动 `task_close`、
  追问复用原会话、present 1-4、brief 不越权定义交付语义、README 不写维护者内容；并用冲突正则
  （`默认立刻 task_close` / `done 即结束` / `自动关闭` / `1-2 个最关键`）防止改回去。
- **测试**：`npm test` **775/775**（0.14.0 基线 767 + 新增 8）。

### 升级提示

- 装 0.14.1 仍要**彻底退出 DSH 再启动**；刷新页面只重载前端，不会换服务端代码。
- 行为差异只有一条：任务交付后默认停在「已交付待确认」，等你确认或用追加消息提修改；不需要这个窗口就配 `deliveredTimeoutMinutes: 1`。

## 0.14.0（2026-11-16）

这一版把「交付」和「完成」拆成两段（`delivered` → `done`），并补上两个长期缺口：计划模式终于能把计划落盘成交付物（`plan_save`），构建/发版类任务可以只对**单条任务**放开沙箱（`access:'full'`）。
相对 0.13.2 无破坏性变更（minor）——不开 `planFirst` / `access` 的任务行为不变，存量 `done` 任务一个字段都不动。
行为上唯一需要协调者记住的差别：**子任务报 `done` 后任务先停在「已交付待确认」**，要协调者 `task_close` 确认（或等超时自动完成）才落 `done`。

### 两段式终态：交付（`delivered`）→ 确认（`done`）

- **新状态 `delivered`（已交付待确认）**：`task_report({ status:'done' })` 与「子会话自然结束」的结算都先落 `delivered`，不再直接 `done`；中断/异常仍直接 `cancelled` / `failed` / `orphaned`（两段式只改「自然交付」这一条路）。新增台账列 `delivered_at`（超时判据）与 `close_reason`（`coordinator` / `timeout`，审计与面板展示），旧库 `ALTER TABLE` 补列，存量行都是 `NULL`。
- **新工具 `task_close`（仅主会话）**：把 `delivered` 收成 `done`（`close_reason=coordinator`）。与面板「确认交付」共用 `closeDelivered()`，副作用顺序统一：迁移 + 审计消息 + 释放可写根 + goal `complete` + 检出清理 + 队列补位；已 `done` 的重复确认按幂等成功返回（「无需重复确认」），非 `delivered` 返回 `CLOSE_NOT_DELIVERED` / 已是终态返回 `CLOSE_TASK_ENDED`。
- **追问复用原会话**：`delivered` 上 `task_message`（或面板「追加」）投递成功 → 任务回 `running`、**同一个子会话**继续跑（可写根与平台 goal 都**不**提前收），完成后再次交付；投递失败保留 `delivered`（只记原因，不降级成 `waiting_user` / `failed`，交付结果不丢）。
- **超时自动完成**：新增 `createDeliveredSweeper()`（`src/delivered.js`），每分钟扫一次 `delivered`，超过 `deliveredTimeoutMinutes`（新增配置，默认 60，1–1440）自动 `done` + `close_reason=timeout`；启动时先扫一次（覆盖进程停机期间过期的任务），timer `unref()` 不阻止退出。
- **状态机与视图**：`delivered` 计入活跃任务与收件箱（`task_inbox` 单独一栏「待确认」）、不进历史列表；依赖就绪只认 `done`（`delivered` 会短暂挡住下游，确认/超时后晋升）；keep-alive、可写根释放、goal 收口都只对真终态生效。`task_status` 给「交付：已交付待确认（如何确认 / 追问 / 超时阈值）」与「关闭：协调者确认 / 超时自动完成」；`task_list` 给「·待确认」与组进度「待确认 N」；面板任务卡有「待确认」小标、抽屉有交付时间/关闭原因与「确认交付」（两步确认，`canClose` 门控）。
- **通知**：交付通知带动作指令「确认：`task_close <编号>`；要改：`task_message` 追问原会话（不新建任务）；不确认则按超时自动完成」；重复的 `done` 回报不再发第二条通知、不重复沉淀记忆。
- **修复（B1「最后一条返回消息」时序）**：`task_report done` 会先把状态推到 `delivered`，本回合结束时到达的结算一直被「只改 `running`」的闸门挡掉，导致**真实台账里所有经 `task_report done` 收尾的任务 `last_message` 全为空**（存量 104 条 `done` 全缺）。现在 `delivered` / `done` 上到达的结算只**补写** `last_message`（不动状态、不发通知、不写 settle 行、不释放会话），短消息内联、超 64 KiB 落 reports 文件只留路径 + 摘要。

### 计划落盘（`plan_save`，计划阶段的唯一写入口）

- **新工具 `plan_save({ task_id, content })` + `src/plan-doc.js`**：计划模式子会话把计划正文（Markdown：目标 / 步骤 / 要改的文件 / 验证方式 / 待拍板问题）写进**主会话工作区**的 `reports/plans/<taskId>.md`（目录自动创建，文档头带任务名/编号/目标/落盘时间），写完自动登记为任务产物——通知、`task_status`、面板抽屉都从台账产物读，不另开视图。
- **没有自定义路径**：只收任务编号，路径由插件拼；编号形状白名单（`^t-[0-9a-z]{4,32}$`，`..`、`/`、`\`、盘符、换行、NUL 全部不合法）+ `relative()` 目录包含性校验两道闸，校验发生在 `mkdir` / `writeFile` **之前**（被拒不留空目录、不写半截文件）。正文上限 200000 字、空正文拒绝（不静默截断）；重复保存覆盖同一份（只留一版，无版本对比/审批流 UI）。
- **谁能写**：只有任务自己的子会话（与 `task_report` 同口径）且任务本身是 `planFirst`；普通任务被告知「直接写到自己的工作目录」；别的子会话越权拒绝；协调者侧 `COORDINATOR_DENY` + 执行层 guard 硬拦。
- **planFirst 交付流程改写**：只读探索 → `plan_save` 落盘 → `task_report blocked` 只上报 **3–8 行摘要 + 计划文档绝对路径 + 待拍板清单**（不再把计划正文塞进 500 字上限的 `question`）→ 用户批准后 `task_message` 续派执行；`PLAN_FIRST_DETAIL` / `EXIT_PLAN_MODE_DENIAL` / `task_create` 返回提示同步改写，`task_detail` 直接渲染同一份说明。
- **协调者提示（`COORDINATOR_POLICY`）**：新增硬规则「向用户汇报任务时用任务名（可附编号），不只甩 id」；planFirst 那条改成「先 `plan_save` 落盘 → 摘要 + 路径」。
- **沙箱语义不变**：`plan_save` 是插件在宿主进程写固定路径，不是给子会话开写权限；只读沙箱对 `write` / `edit` / `pwsh` 的拦截一字未改。

### 完整访问任务（`task_create({ access: 'full' })`）

- **per-task 放宽沙箱**：`access: 'full'` 只给**这一条任务**的子会话 append 一条 `sandbox/mode { mode:'danger-full-access', source:'delegation' }`，复用只读任务的同一条注入路径（`agent/created` 时早注入压掉首回合窗口 + 激活返回/续派时幂等补设，已有则跳过）。用途只有一个：构建 / 发版 / 装依赖 / 写仓库外目录这类确实要越过默认沙箱边界的任务。
- **默认一点都不动**：不传 `access` = 完全沿用会话策略（不 append 任何事件、不改部署默认、不碰父会话、不碰其他任务）；台账 `access` 为 `NULL`。
- **只接受 `'full'`**：`'workspace-write'` / `'read-only'` / `'true'` / `true` / 数字等一律创建期报错并提示，不静默降级（「以为放开了、其实没放开」比报错危险）。与 `readOnly` / `planFirst` **互斥**（创建期拒绝）；与 `worktree` 不冲突（目录隔离 vs 权限放开是两件事）。team 后端给可读拒绝。
- **不继承、可观测**：`access` 不写进配置/默认值、不往孙任务传；重派（`task_retry` / 面板重派）与面板追问沿用原任务的 `access`。台账新增 `tasks.access` 列（旧库 `ALTER TABLE` 补列，非 `'full'` 一律归一成 `NULL`）；brief 第二行「【访问级别】完整」、`task_detail` 「访问级别：完整（danger-full-access…）」+ 任务边界纪律（只读/计划阶段压过 full）、`task_status` / `task_list` 文案、通知标题「（完整访问）」、`task.create.created` 审计字段。
- **新增 `scripts/verify-access-full.mjs`**：离线跑**生产代码**（台账 → brief → 派发参数 → 会话沙箱事件 → 通知）核对整条链，不用真派子会话也能看出「只对这一条任务 inject、其他会话 0 条」。

### 测试与构建

- **测试**：`npm test` **767 条全绿**（0.13.2 基线 723，本版 +44）。新增 `test/delivered.test.js`（9）、`test/plan-save.test.js`（8）、`test/access-full.test.js`（6），并补齐 ledger / dispatch / tools / settlement / notify / task-detail / brief / panel-* / client 等回归。
- **构建**：`client/src/**` 改了交付相关 UI（`确认交付` 按钮、`待确认` 小标、详情「交付」「关闭」行），`dist/client.js` 与 `.map` 由 `vite build` 重建（`pretest` 自动跑），`npm run check:client` 通过。
- **文档**：README 新增「两段式终态（交付 → 确认）」「完整访问任务（per-task access:'full'）」两节、重写「计划任务」为四步流程（含工具表、数据位置、安全边界），并发版/配置/排障/已知限制同步；`docs/ARCHITECTURE.md`、`docs/LIMITATIONS.md`、`docs/UI.md`、`docs/qa-checklist.md`、`cordis.patch.yml` 同步。

## 0.13.2（2026-11-16）

计划任务这一版的收尾修复：`planFirst` 不再因读不到平台计划服务而整单创建失败；任务 blocked 后答问续派会把**原会话**拉回「进行中」；只读任务续派时回执如实写明仍只读。相对 0.13.1 无破坏性变更（patch）——不开 `planFirst` 的任务行为不变。

### 计划任务（P8 修复）

- **`task_create({ planFirst: true })` 不再整单失败**：某些 profile 下平台把计划模式装在每个 agent 预设的隔离作用域里，插件读不到就报错、任务直接落 failed，只能退回只读任务。现在读不到计划服务只降级成「只有只读沙箱」并 warn 一行，创建与批准照常。
- **批准即在同一会话继续**：计划任务 `task_report blocked` → 用户答问 → 协调者 `task_message`（或面板「追加」）→ 原会话由只读切回可写并继续执行，不新建会话；计划服务不可用时也照切可写。
- **blocked 续派复用原会话**：`task_message` / 面板「追加」对「等你确认」的任务投递成功后回到「进行中」、清空待确认问题、在原会话继续（原有行为，本次补回归测试锁住）。要「接着跑」请续派；`task_create` / `task_retry` 必然新开会话。
- **只读任务续派如实提示**：`readOnly` 任务 blocked 后答问续派，回执会写明「子会话仍是 read-only 沙箱、写操作会被拒」，并给两条出口（新派可写任务 / 下次用 `planFirst`），避免把「投递成功」误解成「已切可写」。
- **已知限制（未变）**：`readOnly` 任务续派不会转可写（只读契约保持）；计划服务彻底不可用时，计划阶段的硬拦只剩「只读沙箱」，`exit_plan_mode` 仍被拒，请用 `task_report blocked` 上报计划。
- **测试**：新增 5 条回归（服务不可见时降级、预设隔离域读取、批准仍切回可写、blocked 续派复用原会话且不新建、只读续派回执明示仍只读），当前 `npm test` 723 条全绿。

## 0.13.1（2026-11-16）

### 偏好内置（present 默认交付）

- **`present` 默认交付偏好写进协调者提示**：`index.js` 的 `COORDINATOR_POLICY` 里 present 那条改写成
  「子任务回报产物路径后，默认用 present 展示 1-4 个最关键的产物（最多 4 个；只列真实存在的文件、写绝对路径），
  不必等用户点名；没有产物就不提 present；不要自行 stat/read 校验存在性（协调者的 read/glob 已被 deny，
  插件与子任务负责确认），present 只声明交付、不读文件内容。」
- **为什么改**：旧句的触发条件是「子任务完成、`reports` 文件确认存在后」，而协调者的 `read` / `glob` 本来就被 deny，
  它无法自查文件存在性——结果要么漏交付，要么先撞一次被拒的工具调用才肯交付。新句把存在性判断交回插件与子任务，
  协调者只按回报的产物路径交付。
- **范围**：只改这一句措辞；工具挂载、`COORDINATOR_DENY`、guard、执行逻辑与面板一律未动，无破坏性变更（patch）。

## 0.13.0（2026-11-15）

通知与产物回流闭环（T6）+ 客户端源码化与 vite 构建（P7）+ 子任务计划模式（P8）+ 子任务 worktree 隔离（P9），
另修 0.13.0 UI 冒烟发现的 F4：面板「隔离」小标没接线，台账里一旦出现 worktree 任务整块面板变白。
相对 0.12.0 无破坏性变更（minor）——不开 `planFirst` / `worktree` 的任务行为不变，只是面板与 `task_status`
多了计划/隔离两种小标。

### 交付闭环（T6：通知与 `task_status` 带产物 + present 交付指令）

- **通知产物按可交付性过滤**（T6.1）：`src/notify.js` 的产物区块只列 present 接得住的候选（`lstat` 判普通文件 +
  绝对路径），目录 / 符号链接 / 不存在 / 相对路径跳过并计数（「另有 K 条产物不能交付（目录 1、不存在 1）」）；
  候选上限 4，超出折叠成「另有 N 条产物未列出」。
- **交付指令一条**：单条 done、合并 done、`blocked`/`needs_auth` 打断三条投递路径都写「在你自己的回合里调用
  `present`，`files` 填上面这些绝对路径」；无可交付候选时不写指令（不诱导一次必然失败的 present）。
- **`task_status` 产物区块**（T6.2）：`产物：共 N 条（可交付 M 条）` + 可交付绝对路径 + 不可交付按类型计数，
  与通知**共用同一个渲染函数** `artifactLines()`（不是两处各写一份）；无产物时零字样。
- **结算通知带产物（D5）**：`settlement.notify()` payload 总带 `artifacts`；新增 `beforeNotify(task, status)` 钩子排在
  `transition → lastMessage → beforeNotify → notify` 上，`index.js` 把产物收集改接该钩子（通知拿到补齐后的台账行）；
  钩子抛错只记日志，不回滚终态、不阻塞通知。

### 构建（P7：客户端源码化 + vite）

- **vite 构建脚手架**（T7.1）：`vite@7.3.8` pin 成唯一新增 devDependency；`npm run build` → `dist/client.js`
  （iife classic script，只有一个 `window.__ModuleLoader__.load`，不含 react）；`pretest` 自动构建、`check:client`
  校验产物；`test/client-build.test.js` 把「无顶层 import/export」「`__ModuleLoader__.load` 且 id = 包名」
  「源码不许引 react」三条契约钉住。
- **源码迁入 `client/src/**`**（T7.2）：2283 行手写 `client.js` 拆成 10 个 ESM 文件（入口 / styles / logic / api / 组件），
  `STYLE_TEXT` 落到 `client/src/styles.css` 用 `?inline` 构建期内联，旧代码逐字保留；`exports["./client"]` 与 `files`
  切到 `dist/`，根 `client.js` 删除（`npm pack` 里只剩 `dist/client.js`）；两次构建产物字节一致、map 里 `sources`
  全为相对路径。

### 计划模式（P8）

`task_create({ planFirst: true })` 让子会话以**计划阶段**起步：只读沙箱（硬拦）+ 平台 plan-mode 提示（软引导）。
子会话只读探索后用 `task_report blocked` 上报计划；用户批准后协调者 `task_message`（或面板「追加」）续派，
插件在投递成功且任务回到 `running` 之后切回 `workspace-write`、关闭 plan mode。不开 `planFirst` 的任务行为不变。

- **`task_create` 新增 `planFirst`**：只认显式 `true`；与 `readOnly` 互斥（创建期拒绝并给可读原因）。
- **台账两列**：`plan_first`（0/1）+ `plan_state`（`none` / `planning` / `approved` / `rejected`），
  旧库逐列 `ALTER TABLE` 补；计划任务在 `planning` 状态进终态收口成 `rejected`，已 `approved` 的保留。
- **派发进入**：复用 `ensureReadOnly`（`agent/created` 先设 + 激活后幂等补），再用子 agent 作用域的
  `agent.ctx.get('planMode')?.set(agent, true)` 置 plan mode；`planMode` 服务缺失只 warn，降级为「只有只读沙箱」；
  计划任务批准前不注册 target 可写根。
- **`exit_plan_mode` 拒绝**：在子会话 **agent 作用域** 装 `agent.ctx.tools.guard`（插件根的 guard 是全局的，会误伤协调者），
  文案指向 `task_report blocked`；协调者与其它会话不受影响。
- **批准退出**：投递成功 + 回到 `running` 后 `sandbox/mode → workspace-write` + `planMode.set(agent,false)` +
  补登记 target 可写根；投递失败路径不碰 plan 状态。
- **视图**：`task_list` 「·计划中」、`task_status` 「计划：」行、`task_detail` 计划阶段说明（只读是预期）、
  快照/详情下发 `planFirst`/`planState`、面板任务卡「计划中」小标 + 「计划·…」chip + 抽屉概览「计划」行；非计划任务无任何计划字样。
- **文档**：README「计划任务」、`docs/ARCHITECTURE.md`「计划阶段（P8）」、`docs/LIMITATIONS.md`「计划阶段（P8）」、
  `docs/UI.md` 概览行、`docs/qa-checklist.md` §35 复核矩阵。
- **测试**：新增 `test/plan-mode.test.js` 26 条（映射/台账/工具/派发/面板/客户端），当期 `npm test` 672 条全绿。
- 发版：随 0.13.0 一版打包（原计划 0.13.0 / 0.14.0 分批发改为一版）。

### 隔离（P9）

`task_create({ ..., worktree: true })` 时插件在宿主进程建 `git worktree`，子会话在检出目录
（`<repo>/.agents/worktrees/<taskId>`）里干活；分支留在你的仓库、**合并由你决定**。不开 `worktree` 的任务行为一字不改
（一次 git 都不调）。

- **结构化声明只有两处**（零自然语言解析）：profile 配置 `worktreePolicy` / `worktreeBranchPrefix` /
  `worktreeRecentDays`，与 `task_create` 的 `worktree` / `worktreeBase` / `worktreeBranch` / `worktreeMode` /
  `worktreeCleanup`。插件不读 `AGENTS.md`、不解析自然语言、不缓存指令文件（v2 删除 v1 的 `worktree-policy.js` 方案）。
- **职责切分**：DSH 注入用户级/工作区级指引 → 协调者判断「要不要建 / 基线 / 分支名」（policy 文本里给了三条件引导
  与 `ask_user_question` 闭环）→ 插件只做校验 + 执行。`AGENTS.md` 里的要求仍有效，路径是「注入 → 协调者读懂 →
  传 `worktree:true`」；要硬保证就配 `worktreePolicy: 'required'`（漏传也兜底建，来源标 `config`）。
- **新增 `src/worktree.js`**：宿主侧 git 能力（`probeRepo` / `create` / `remove` / `ensureExcluded` / 分支名校验 /
  `prepareTaskWorktree` / `cleanupTaskWorktree` / `retryWorktreeOf`），7 类失败分类（`NOT_A_REPO` / `BASE_NOT_FOUND` /
  `BRANCH_INVALID` / `BRANCH_EXISTS` / `PATH_EXISTS` / `GIT_MISSING` / `FAILED`），全部走 `execFile`（不经 shell）。
- **新增 `src/worktree-request.js`**：结构化请求校验 + 机械映射（§4.5 全表）+ 全部展示文案（纯函数）。
  多分支时返回 `needsBranchChoice` 且**不落库**；基线与分支名缺省值由插件填（不算判断）。
- **台账七列**：`worktree_path` / `worktree_branch` / `repo_root` / `worktree_base` / `worktree_mode` /
  `worktree_source`（`task`/`config`/`default`）/ `worktree_state`（`none`/`requested`/`created`/`reused`/
  `degraded`/`rejected`/`failed`/`cleaned`），旧库逐列 `ALTER TABLE`。
- **派发接线**：`queue.pump` 在 spawn 前建树（或复用），`target_dir` = 检出目录 + 原 target 相对 `repoRoot` 的偏移，
  可写根天然覆盖；`.agents/` 写进 `.git/info/exclude`；非仓库降级、建树失败标 `failed`（不静默降级）。
- **清理三档**：`off`（默认全保留）/ `checkout-only`（只删检出）/ `full`（连分支一起删，未合并提交会提示）。
- **视图**：`task_status`「隔离：」行、`task_list`「·隔离」、通知「产物在分支 X 的检出目录 Y，合并由你决定」、
  面板「隔离」小标 + 「隔离·…」chip + 抽屉「隔离」行；普通任务零隔离字样。
- **文档**：README「隔离任务」、`docs/ARCHITECTURE.md`「worktree 隔离（P9）」、`docs/LIMITATIONS.md`
  「worktree 隔离（P9）」、`docs/qa-checklist.md` §36 复核矩阵。
- **测试**：新增 `test/worktree.test.js` 26 条 + `test/worktree-request.test.js` 19 条，当期 `npm test` 717 条全绿。
- 发版：随 0.13.0 一版打包（原计划 0.13.0–0.16.0 分批发改为一版）。

### 修复（F4：面板「隔离」小标未接线会让整块面板变白）

- **根因**：`client/src/views.js` 从 `createViews({…})` 参数里解构 `WORKTREE_STATE_LABEL` / `WORKTREE_SOURCE_LABEL`，
  但 `client/src/client.js` 既没 import 也没传，两个值恒为 `undefined`；台账里只要有一条 `worktree_state != 'none'`
  的任务，卡片渲染就抛 `TypeError`，`main` 槽位被宿主错误边界清空（面板全白）。0.13.0 UI 冒烟第 4 项（F4）发现。
- **修复**：`client.js` 补 import 与传参；`views.js` 两处使用点改成 `WORKTREE_STATE_LABEL?.[…]` /
  `WORKTREE_SOURCE_LABEL?.[…]`，文案表缺失或服务端新增枚举时退化成原始值、不再打死面板。
  `dist/client.js` 由 `vite build` 重建（未手改产物）。
- **回归**：`test/client.test.js` 新增 1 条（+67 行）：喂 `worktreeState:'created'` 快照断言卡片出现「隔离·已隔离」、
  抽屉「隔离」行状态/分支/检出/决定者四段齐全；未知状态 `weird-state` 断言不抛错并退化成原始值；`none` 任务零「隔离」字样。
  真机复测（dsh-dev 临时宿主 + headless Chrome/CDP）：`.orch-shell` 1、122 张卡片、console 0 error。
  发版前 `npm test` **718 条全绿**（717 + 本条回归）。

## 0.12.0（2026-11-15）

面板门控 + 删除任务/子会话 + 发版后镜像同步固化：新增 `src/panel-gates.js` 做唯一的「能否续派」判定，面板与 `task_message`
共用同一套状态门控（只有可续派状态才显示「追加」）；面板任务卡与详情抽屉新增「删除」，仅终态可用、复用内联二次确认并级联清理台账；
发布链路把 npmmirror 镜像同步固定成 `release.yml` 最后一步（`continue-on-error`），并补 `npm run mirror:sync` / `npm run mirror:check`
手动兜底。相对 0.11.0 无破坏性变更（minor）。

### 面板优化（续派门控 + 删除任务/子会话）

- **追加消息按状态门控**：新增 `src/panel-gates.js` 作为唯一判定（`followupGate`），面板动作与 `task_message`
  共用；`snapshot` / `detail` 下发 `canFollowup`，`client.js` 只读字段渲染。只在 `running` / `waiting_user` /
  `waiting_auth` 且已有子会话时显示「追加」；终态、等前置、待派发、失败任务都不再显示。
  失败任务新增 `MESSAGE_NOT_FOLLOWABLE`（提示改用重派），避免消息投进死会话。
- **新增删除任务/子会话**：面板任务卡与详情抽屉的「删除」只在终态（`done` / `failed` / `cancelled` / `orphaned`）
  显示，复用停止的内联二次确认（确认删除 → 取消）；活跃任务不显示并提示先「停止」。
  后端 `endpoint: 'delete'` → `panel.delete`：活跃任务 `DELETE_TASK_ACTIVE`，还有活跃下游依赖
  `DELETE_HAS_ACTIVE_DEPENDENTS`；成功时台账级联删除 `tasks` + `messages` + `notifications`，
  返回 `deleted:{messages,notifications}`。产物文件、`reports/` 正文、`memories` 保留；平台子会话历史没有删除 API。
- **测试**：新增 `test/panel-gates.test.js`（门控矩阵）并补 panel-actions / host-route / ledger / tools / client
  用例（渲染门控、二次确认、级联清理、活跃/下游拦截）；`npm test` 626 条全绿。

### 流程（发版后镜像同步，固化进发布链路）

- **主动触发 npmmirror 同步**：新增 `scripts/mirror-sync.mjs`（`npm run mirror:sync` / `npm run mirror:check`）——
  先查镜像 `dist-tags.latest`，缺版本就 `PUT /-/package/{name}/syncs` 触发回源再轮询到出现；
  上游 npm 没这个版本时直接报错退出（不同步空气），镜像已有则幂等退出 0。`--no-wait` 只触发，`--timeout/--interval` 调等待。
- **release.yml 加「触发 npmmirror 镜像同步」步骤**：Publish 之后触发同步并轮询约 3 分钟，
  `continue-on-error` + 超时 `::warning::`，镜像慢了不把发布判红；文件头把这一步写进发布流程注释。
- **README 发版章节**新增「npm 发布后：触发 npmmirror 镜像同步」小节（自动/手动两条路、syncs 接口的 scoped 编码、
  幂等与上游校验、同步完的验收），排障表补「装到的是旧版」一行。
- **踩坑记录**：`npm view --registry=https://registry.npmmirror.com` 会命中本地 npm 缓存（曾显示旧 `latest` / `404`），
  要用 `--prefer-online` 或直接看 HTTP 才准；`npm run mirror:check` 发真请求，不受缓存影响。
- 0.11.0 的补同步已于 2026-11-15 完成：syncs `id=6af9638ec819a802c9ff64c1`，镜像 `latest` 由 0.10.0 → 0.11.0
  （`dist-tags` 与 `-0.11.0.tgz` 均验证通过），细节见 `reports/mirror-sync-0.11.0.md`。

## 0.11.0（2026-11-15）

回合间 keep-alive + 子会话读任务详情 + 任务入口仅主会话可见 + 面板/详情 UI 重做：K2 让子会话在回合边界接着跑（带台账轮数预算、默认关、与 S1 结算去重），
T1 给子会话一个只读 `task_detail` 并把 brief 收成两行指引（经验改存记忆文件指针），U1 把会话头「☰ 任务」入口限定给主会话（fail-closed 闸门 + `session-role` 端点），
U2 用宿主 DeepSeek 设计 token 重做任务面板与详情抽屉（三段式布局 + 抽屉详情 + 骨架/空态/错误态）。相对 0.10.0 无破坏性变更（minor）。

### 变更（U2 面板/详情 UI 重做：DeepSeek 风格 + 三段式 + 右侧抽屉）

- **三段式布局**：任务面板拆成 ① 顶部命令栏（标题、主会话状态点、搜索框、刷新、打开主会话）
  ② 中部工作区（左侧筛选轨带计数徽标 + 任务卡列表 / 产物库）③ 右侧详情抽屉。
  抽屉常驻挂载、`data-open` 驱动 `transform` 滑入滑出，遮罩点击、关闭按钮、`Esc` 都能收起。
  窄屏（≤860px）筛选轨转横向条、指标两列；≤640px 抽屉铺满。
- **DeepSeek 风格 token 落地**：`client.js` 新增 `STYLE_TEXT` 样式表（第 76 行起）与 `ensureStyles()`
  运行时按 `#dsh-orchestrator-styles` 去重注入；颜色/圆角/阴影/动效全部取宿主设计平台 token
  （`--dsw-alias-bg-layer-*`、`--dsw-alias-label-*`、`--dsw-alias-border-l*`、`--dsw-alias-state-*`、
  `--dsw-alias-card-fill*`、`--dsw-radius-*`、`--dsw-shadow-lv1`、`--dsw-elevation-prominent`、
  `--dsw-focus-ring-color`、`--ds-transition-duration*`、`--ds-ease-in-out`），深浅色跟随宿主自动切换。
  **顺带修 bug**：旧代码用的 `--dsw-alias-color-*` 在宿主 token 表里不存在（一直走 fallback、深色下发脏），
  已换成 `--dsw-alias-state-*` / `--dsw-alias-label-*` 语义 token，测试用 `doesNotMatch` 守住。
- **现代化交互**：卡片/按钮/指标/区块 hover 与按下反馈；抽屉滑入、区块 `0fr↔1fr` 折叠动画（chevron 旋转）、
  `@keyframes orch-slide-in` 内容入场、`@keyframes orch-shimmer` 骨架闪光；首帧 5 张骨架卡、产物库/抽屉各有骨架；
  空态（无任务/无匹配/无产物/无消息/无前置/无下游/没有 brief/没有返回消息）与错误态（快照「台账暂不可用」+重试、
  动作错误带错误码、产物加载失败+重试、抽屉「重新加载」、预览失败）；「停止」改内联二次确认（确认停止/取消），
  不再用 `window.confirm`；`aria-expanded/aria-pressed/aria-hidden`、`:focus-visible` 焦点环、
  `prefers-reduced-motion` 关闭动效；顶栏搜索按标题/编号/目录过滤。
- **详情抽屉**：7 个可折叠区块——概览、最新回复（B1）、Brief（验收/约束/背景/用户原话改成结构化列表）、
  目标状态（G1，只读）、消息（投递三态）、依赖（上下游）、产物（复制路径）；底部动作条：停止/重派/追加消息/打开子会话。
- **B1 增补**：`src/panel-actions.js` 的 `detail` 回传 `task.lastMessage`（内联正文或摘要+报告文件路径），
  抽屉「最新回复」区块直接展示子会话最后一条 assistant 消息；没有回复时是 `null`（走空态）。
- **保留功能**：A3 面板动作（stop/retry/message 的错误码、幂等 `already` 提示、在途合并、`clientRequestId`）、
  A4 产物库（`artifacts`/`preview` 端点、按项目/日期分组、复制路径、打开子会话、文本预览 64 KiB）、
  B1 最新回复、G1 目标状态只读区块、U1 任务入口仅主会话可见（闸门与侧栏「◈ 主会话」不变）。
- 测试：`test/client.test.js` 新增 6 条（三段式结构、token 清单、交互清单、样式表自检（括号成对 + class 与规则对齐）、
  纯函数 `countTasks/matchesFilter/matchesQuery/groupArtifacts/artifactDate/artifactProject` 与语义色、面板首帧渲染冒烟）；
  `test/panel-actions.test.js` 新增 1 条（B1 最新回复内联/文件/无回复）。`npm test` 602 条全绿。
- 文档：[docs/UI.md](docs/UI.md)（布局图、token 对照表、交互清单、file:line）、README 面板小节、
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#面板与详情ui-u2)。

### 变更（U1 任务入口仅主会话可见）

- **会话头「☰ 任务」只在协调者/主会话显示**：`client.js` 新增任务入口闸门 `createMainViewGate`（fail-closed）。
  当前会话信号优先取 `uiSession.adapter.current` 的 `key`，取不到时退到 `sessions.list` 里 `retainedBy.mainView > 0` 的会话；
  再 POST `/api/orchestrator` 的 `session-role` 端点，由宿主按台账主会话 id 回答 `isMain`。
  切到子会话（或其他会话）时组件返回 `null`，入口隐藏；同一会话的判定结果会缓存，换会话立即重判。
- **判定信号与降级规则**：宿主侧 `isMainSession(sessionId, mainSessionId)`（`src/session-role.js`）只认非空字符串逐字相等；
  信号与 `task_*` 工具同源（`coordinatorStatus()` → `settings.main_session_id`，`config.coordinatorSession` 覆盖）。
  任一侧缺失、未打开主会话、请求失败、响应不是 `ok:true` 都按 `false`，即入口**默认隐藏**；
  失败不缓存，靠会话切换和 5 秒兜底轮询重试。侧栏「◈ 主会话」跳转入口**始终可见**，不做主会话判定（避免没建主会话时无从引导）。
- **路由**：`src/host-route.js` 新增只读查询端点 `session-role`（`{ sessionId }` → `{ ok:true, isMain }`），
  与 `snapshot` 一样不写台账、不建会话、不派发。
- 测试：`test/session-role.test.js`（相等/不等/空串/非字符串/未打开主会话降级）、`test/host-route.test.js`（主会话/子会话/空 body/无 coordinatorStatus、零写入）、
  `test/client.test.js`（闸门默认隐藏、主会话显示、子会话隐藏、请求失败降级、会话订阅与 5 秒轮询、侧栏入口始终注册、渲染条件）。
  `npm test` 595 条全绿。
- 文档：README（打开入口/排障）、[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)、[docs/LIMITATIONS.md](docs/LIMITATIONS.md)、[docs/api-notes.md](docs/api-notes.md)。

### 变更（T1 子会话读任务详情 + brief 纯指引化）

- **新增 `task_detail` 只读工具（只给任务自己的子会话）**：`createTools` 的第 12 个工具（`src/tools.js`），渲染在 `src/task-detail.js`。
  字段：任务编号/标题/状态、目标全文（保留换行）、工作目录 + 可写/只读提示、验收标准、约束、背景资料、用户原话、编排（分组/优先级/写域，非默认才显示）、
  `【前置任务】`（复用 `deps.upstreamBrief`，按**当前**台账现读状态/最近回报/产物）、`【经验文件】`（路径 + 条数 + 「可 read 全文/文件已丢失」；
  记忆文件写不出来时退回内联块）、`【已有产物】`（路径/标签/存在性）、完成口径（`task_report` 选项 + 汇报三问）。
  **只读**：不写消息、不改状态/时间戳/进度，经验文件只 `stat` 存在性（正文由子会话自己的 `read` 决定）。
  **越权拒绝**：`exec.agent.id` 或 `exec.agent.session.id` 必须等于 `tasks.session_id`；主会话、别的子会话、尚未派发的任务都返回
  「读取被拒绝…主会话查任务用 task_status」并记 `task.detail.rejected` 日志。
- **brief 纯指引化**：`renderBrief({ taskId })` 只输出 `【任务编号】` + `【任务详情】先调 task_detail…` 两行，
  不再内联目标/验收/约束/背景/用户原话/工作目录/经验/前置任务/产物，也不再写 `【目标兜底】`；
  `src/brief.js` 的 `goalLines` / `MAX_GOAL_FALLBACK_CHARS` / `GOAL_POINTER_TEXT` / `GOAL_FALLBACK_TEXT` 一并移除。
  目标正文仍写进平台 goal（子会话可 `get_goal` 读实时目标），创建时快照由 `task_detail` 提供，两条路互不依赖。
- **经验改存指针**：`task_create` 命中事实层记忆时仍写 `lessons/<项目>-<hash>.md`，但只把 `{ path, count }`（写文件失败时 `{ inline }`）
  存进 `brief.experience` 供 `task_detail` 读；提示词里不再出现经验正文，长度与记忆条数无关。
- **重派同口径**：`task_retry` 与面板 `retry` 都改用 `renderBrief({ taskId: 新任务编号 })`，面板重派不再回退到内联目标。
- **派发不再拼前置摘要**：`queue.pump` 直接发落库的 brief 消息（缺失时 `renderBrief({ taskId })` 兜底），
  不再在派发时拼 `【任务】标题 + 目标` 或 `【前置任务】` 快照——依赖可能在创建后才完成，改由 `task_detail` 现读。
- **挂载链**：`task_detail` 与其它 `task_*` 一样由 `index.js` 的 `createTools(...).map(tool => ctx.tools.register(tool))` 注册成 host plane 全局工具；
  `dsh-orchestrator-worker` 预设不挂 `preset-tools`、不做 allow/deny 收窄，子会话工具表直接继承（与 `task_report` 同一条路）；
  协调者预设的 `preset-tools` 白名单不含它，执行层 `COORDINATOR_DENY` 也补了 `task_detail`（与 `task_report` 同类）。
  `cordis.patch.yml` 的 worker 预设补了这条挂载链的注释。
- 测试：`test/brief.test.js` 重写为纯指引用例；新增 `test/task-detail.test.js`（字段、只读、越权、未派发、前置现读、经验指针/降级/丢失、产物存在性）；
  `test/tools.test.js`、`test/index.test.js`、`test/config.test.js`、`test/panel-actions.test.js`、`test/queue.test.js`、`test/integration.test.js` 同步改口。
  `npm test` 587 条全绿。
- 文档：README（工具表/目标段/配置/数据目录）、[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#brief-纯指引t1)、
  [docs/LIMITATIONS.md](docs/LIMITATIONS.md#目标g1)、[docs/DETAIL.md](docs/DETAIL.md)。

### 新增（K2 回合间 keep-alive）

- **`keepAlive` 开关（默认关）**：开启后插件订阅平台 `agent/turn-stopping`，在回合边界（`agent.status` 仍为 `running`、尚未 idle）同步给子会话投递下一轮，
  让它接着跑而不是先 idle 再被 S1 结算。只对「台账 `running` + 平台 goal 未完成（phase 不是 `complete`/`cleared`）」的任务注入；
  默认 `steer`（同 turn 多走一步，不写 `turn/end`），`keepAliveMode: 'followup'` 切新回合。
  停止条件：轮满（`keepAliveMaxRounds`，默认 8，1–50）、goal 已收口、任务不在 `running`（`task_stop`/S1 结算/S2 对账）、回合被中断、
  只读任务、inbox 已有人排了下一轮、注入异常；监听器全量 `try/catch`，绝不把异常抛回 serial dispatch。
- **台账预算 `tasks.keep_alive_rounds`**：旧库自动补列（历史行 0 轮），`bumpKeepAliveRound` 用条件 `UPDATE ... WHERE status='running' AND keep_alive_rounds < ?`
  原子加轮（重复/并发事件不超发），每次进入 `running`（重派/续派/冷恢复）归零；每次注入写一条 `kind='keepalive'` 审计消息 + `task.keepalive.injected` 日志，
  `task_status` 显示「keep-alive 已注入 N/M 轮」。
- **与 S1 结算不冲突**：keep-alive 不改状态、不写 `progress_count`、不写 `kind='followup'` 消息（避开面板同文去重口径）、不触发结算；
  结算仍只在真正的 `subagent.settled` / `subagent/end` 上由 S1 做一次（状态机天然幂等），任务一旦离开 `running`，同一会话后续的 `turn-stopping` 直接跳过。
- 接线：新增 `src/keepalive.js`（`createKeepAlive` / `keepAliveSkipReason` / `keepAliveText`），`index.js` 在 settlement 之后 `start(ctx)` 并在卸载时 dispose；
  `src/config.js` 新增 `keepAlive` / `keepAliveMode` / `keepAliveMaxRounds` / `keepAlivePrompt`；`src/ledger.js` 新增列、迁移、`bumpKeepAliveRound`、
  进入 `running` 归零；`src/tools.js` 的 `task_status` 显示续跑轮数。
- 文档：README（用法小节 + 配置表）、[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 「回合间 keep-alive（K2）」、[docs/LIMITATIONS.md](docs/LIMITATIONS.md#回合间-keep-alivek2)；
  用例 `test/keepalive.test.js`（12 条：默认关、steer/followup、轮满、goal 完成/缺失、非 running、只读、中断、inbox 排队、注入异常、台账原子加轮与旧库补列、S1 去重）
  + `test/index.test.js` 两条接线用例（默认关不注入 / 开启后 `turn-stopping` 注入且 S1 只结算一次）。

## 0.10.0（2026-11-15）

子会话读目标 + 主会话读全文 + brief 瘦身 + 协调者交付产物：G2 让子会话真正拿到 `get_goal`，B1 把「最后一条 assistant 消息」落进台账供主会话直读，
L1 把目标与经验外置（brief 只留指引与指针），P1 让协调者可用 `present` 交付子会话产物；D2 给调试预设补逐项对齐自检与 `--check` 漂移检查；
另附 K1「回合间 keep-alive」可行性探针（仅文档与探针代码，不动产品逻辑）。相对 0.9.0 无破坏性变更（minor）。

### 变更（L1 brief 精简）

- **目标不再在 brief 里重复一份**：平台 goal 可用时（`goalBridge.available()`，即 `ctx.goals` 方法齐全），`【目标】` 写成
  「先调 `get_goal` 读取完整目标（含「最新指示」）」的指引，紧跟一行 `【目标兜底】get_goal 不可用时按此执行：<目标前 160 字>…`，
  这样目标正文只存在平台 goal 里，brief 不重复。attach 失败 / worker 预设没挂 `tool-goal` 时，子会话至少还有兜底可开工。
  goal 降级（没有 goals 服务、方法不全、能力探测抛错）时**仍然内联目标全文**，与旧行为逐字一致。
  重派（`task_retry` / 面板「重派」）重渲染 brief 时同口径。
- **经验写记忆文件，brief 只留短摘要 + 指针**：`task_create` 命中事实层记忆时，把完整内容写进
  `$DSH_HOME/state/orchestrator/lessons/<项目目录名>-<key 短 hash>.md`（同一项目稳定复用同一文件，每次派发覆盖为最新快照，
  含层标签、日期、`id`、来源任务/会话、生成时间）；brief 里的【历史经验】改成「N 条｜完整内容见经验文件（可 read 全文）」+
  每条 ≤64 字摘要 + `完整经验：<路径>`。worker 预设自带 `read`，子会话能自己读全文。
  降级：`stateDir` 缺失、`lessons/` 建不出来或写文件失败时，退回原来的内联记忆块（不丢经验，只是 brief 变长）。
  路径行永不截断；超 `MAX_MEMORY_BLOCK` 时先丢摘要行、保留路径。
- `src/brief.js` 导出 `goalLines` / `MAX_GOAL_FALLBACK_CHARS` / `GOAL_POINTER_TEXT`；`renderBrief(brief, { goalAvailable })`。
  `src/memory.js` 导出 `buildLessonBlock` / `writeLessonFile` / `renderLessonFile` / `lessonPointerBlock` / `lessonFilePath`，
  `buildMemoryBlock` 拆出 `memoryBlockFromRows`（`project_context` 与降级路径共用）。`createTools` 新增 `stateDir`（`index.js` 传插件写入根）。

### 变更（P1 协调者交付产物）

- **协调者预设挂 `present`**：新增 `@deepseek-ai/dsh-tool-present` 行（与标准预设 `dsh-web-app/presets/cordis.patch.yml`、worker 预设逐字同形），
  主会话可把子会话的 `reports/` 文件作为交付产物声明给客户端。在 web/desktop 里 `present` 是预设自有工具（own），deny 补集本来就遮不到；
  同时把它列进 `preset-tools` 的 `allow` 作跨 profile 保底（allow 只用于过滤 deny、不交给 `restrict`，写 own 名字不会 `unknown global tool`；
  SDK 等 profile 的 host plane 也注册 `present`，不列就会被当成全局工具 deny 掉）。
- **执行层解除拦截**：`COORDINATOR_DENY` 移除 `present`（否则预设挂了也会被 `tools.restrict`/`guard` 硬拦）；
  协调者系统提示补一条：产物确认存在后用 `present` 交付，路径写绝对路径（主会话工作目录不是项目目录）。
- **生效方式**：预设行在 profile 加载时挂载，重启 DSH（或重载 profile）后生效；客户端需支持 `deliverables/presented` 的 present 卡片
  （Desktop/Web 已支持，worker 预设早已在用）。

### 修复（G2 子会话读目标）

- **子会话读不到自己的目标**：`dsh-orchestrator-worker` 预设原先没有任何 goal 工具行，而 web-app 层把 host plane 的 `tool-goal` 行 `disabled: true`（模型面工具改由预设挂载），`goals` 服务则留在 host plane——两边都缺，子会话工具表里就没有 `get_goal`，G1 写进平台的目标只有宿主和面板看得见。
  现在 worker 预设在 `tool-jobs` 后补一行 `tool-goal`（`@deepseek-ai/dsh-tool-goal`，与随包 `standard` / `ptc` / `cordis` 预设逐字同形），子会话可 `get_goal` 读到本任务目标（含「最新指示」拼接文本）。
- **写能力仍然关闭**：`create_goal` / `update_goal` 由平台 `goalToolExecution` + `requireDirectHuman` 校验，要求顶层 agent 的直接人类回合，子会话调用必被拒；改目标仍只走 `task_message` / 面板「追加」。协调者预设不挂 `tool-goal`（它只做协调，工具面由 `preset-tools` 白名单收窄）。

### 新增

- **最新返回消息（B1）**：结算时持久化子会话最后一条 assistant 消息（新增 `src/last-message.js` + `tasks.last_message_json`）。≤64 KiB 内联台账；更大写 `$DSH_HOME/state/orchestrator/reports/<taskId>.md`，台账只留路径 + 240 字摘要；写文件失败降级内联，空输出不覆盖上一次记录。派发侧 `subagent.settled` 的 `detail.output` 仍是 240 字摘要（日志不膨胀），完整正文走事件上的非日志字段 `lastMessage`。
- **`task_status` 新增 `include: 'full'`**：默认给正文（超 1200 字给预览 + 截断提示）或「reports 路径 + 摘要」，`full` 时读全文（文件被删则降级为摘要 + 读取失败原因）。
- **对齐自检**：`prepareDebugPreset` 生成后自动比较「源 cordis 组合 vs 生成物 plugins」，只允许预设 id / 显示名 / 描述 / 排序与 `customSkillDirs` 落点不同；工具行、`!!js` 权限条件、persona 系统提示逐行比对，结果随 `alignment` 返回。
- **`--check` 只读检查**：`node scripts/orch-debug-preset.mjs --check` 读取当前安装的随包 `cordis` 与已生成 bundle，发现漂移时打印逐行差异并以退出码 1 结束；技能根单独报告 `dsh-doc` 是否在位。DSH 升级后先跑它再决定重新生成。
- **技能目录报告**：生成结果新增 `skillNames`（如 `['dsh-doc']`），`--check` 同时复核 `skills/dsh-doc/SKILL.md` 是否存在。
- **文档**：`docs/DEBUG-PRESET.md` 新增「与 `cordis` 的逐项差异」「插件更新流程（`plugin_manager` / client HMR / host HMR / 动态插件边界）」「`cordis_*` 可用性证据与限制」，并修正旧文档「调试子会话里 `plugin_manager` 默认关闭」的错误结论（Desktop/Web profile 下有 `profileContext` 即启用）。

### 测试

- `test/debug-preset.test.js` 新增插件行切分、对齐比较（缺少/多出/顺序/包名/`disabled`/系统提示）、技能根归一化、`skillNamesOf`、`prepareDebugPreset` 自检与 `--check` 漂移检测用例。
- `test/config.test.js` 新增 worker 预设 `tool-goal` 行的回归用例（按 `config.id` 抠 plugins 块：worker 恰好一行、包名正确、纯行无 `config`/`disabled`、整份补丁只出现一次；协调者不挂）。
- P1 用例：`test/config.test.js`（协调者预设恰好一行 `present`、标准包名、纯行、`allow` 含 `present` 保底、整份补丁两行）、`test/index.test.js`（`present` 不在 `COORDINATOR_DENY`、协调者 guard 放行、`present` 不进入运行期 deny）。
- B1 用例：`test/settlement.test.js`（短消息内联、超 64 KiB 写 `reports/` 并与文件内容比对、派发侧只给 `lastMessage`、重复结算幂等且不多写文件、空输出不覆盖）、`test/ledger.test.js`（旧库补 `last_message_json`、坏 JSON、同 digest 回落幂等）、`test/tools.test.js`（默认正文/预览/路径 + 摘要、`include: 'full'` 读全文、报告文件缺失降级）、`test/dispatch.test.js`（事件带完整 `lastMessage`、`detail.output` 仍 241 字符）、`test/index.test.js`（平台 `subagent/end` 全链路短/长两条）。
- L1 用例：`test/brief.test.js`（goal 可用 → 指引 + 截断兜底、短目标兜底即全文、降级内联全文、与工作目录/只读的相对顺序、纯函数）、`test/memory.test.js`（`lessons/` 文件写入并与 brief 摘要比对、路径稳定、摘要截短、`stateDir` 缺失 / `lessons/` 被同名文件占位两种降级、无命中不建目录、指针块超限保路径、`lessonFilePath` 命名）、`test/tools.test.js`（`task_create` 的两种目标形态、能力探测抛错也降级、经验指针 + 文件落盘、`stateDir` 缺失退回内联、`task_retry` 重渲染同口径）。
- `npm test` 570/570，`npm run check:client` 通过。

### 文档（K1 keep-alive 探针）

- **`agent/turn-stopping` 可行性探针**：新增 `docs/probes/keepalive-probe/`（`index.js` 订阅 `agent/turn-stopping`，`followup` / `steer` / `followup-async` / `none` 四模式 + 一次性 `DSH_HOME` 的 `run.ps1`，不碰桌面 profile）与四组原始事件 `out/k1-events.*.jsonl`，结论见 `reports/k1-keepalive-probe.md`。
- **结论**：可行——事件 `serial` 且被 await，监听器里同步调用 `agent.steer()`（同 turn 多跑一步、无 `turn/end`，推荐）或 `agent.followup()`（新 turn、`turn` 计数 +1）都在回合并界面前生效，且天然避开 `idle` 之后的结算/dispose 竞态；必须自带预算与终止条件。**本次只提交探针与结论，不改产品逻辑。**

## 0.9.0（2026-11-15）

记忆分层 + 空闲看门狗 + 子会话目标：done 结果降级为日志层只归档，长时间空转主动告警，子任务目标同步到平台 `ctx.goals`。相对 0.8.0 无破坏性变更（minor）。

### 变更（M1 记忆分层）

- **记忆分层**：`task_report done` 不再写 `kind='task-done'`，改为日志层 `task-log`——一行完成任务记录（≤180 字符，不拼产物清单、不贴 verbatim），
  只归档、**不注入 brief**；旧库里的 `task-done` 在打开台账时自动迁到 `task-log` 并重算 hash（幂等）。分层规则见 `src/memory.js` 的 `memoryLayerOf`。
- **写入即蒸馏**：`addMemory` / `memory_note` 写入前统一清洗（整块丢代码围栏、shell/测试输出行、`>` 引用原话、纯路径清单），
  事实层单条上限 160 字符、日志层 180 字符，不再落长日志或 verbatim。
- **经验才注入**：done 摘要里带「结论/经验/注意/避免/改用/必须…」标记的分句蒸馏成 `lesson` 原子事实（最多 2 条），
  与 `decision`/`preference`/`note` 一起进 brief 的【历史经验】；`history_search` 结果按层标注 `[日志]`/`[经验]`/`[决策]`。
- `memory_note` 的 `kind` 新增 `lesson`；`src/ledger.js` 打开台账时执行 `migrateLegacyTaskDone`。

### 新增（W1 空闲看门狗）

- `src/watchdog.js`：每 `watchdogIntervalMinutes`（默认 5 分钟）巡检 `running` 任务，最新活动（`last_event_at` 心跳 / `messages.at` 消息 / `updated_at` 状态变化三源取最新）早于 `watchdogIdleMinutes`（默认 15 分钟）就推一条 `stalled` 汇总告警。
- **只告警**：不改状态、不 kill、不重派、不写任务表；同一段空闲每任务只报一次，出现新活动后重置、可再报一次；任务离开 `running` 即出表。
- 启动时在 S2 启动对账之后立即巡检一次（先让重启遗留的 `running` 落 `orphaned`）；插件卸载先 `stop()` 再关台账。用法与边界见 `docs/ARCHITECTURE.md`「空闲看门狗（W1）」。
- 配置：`idleWatchdog`（默认 `true`，显式 `false` 关闭）、`watchdogIntervalMinutes`、`watchdogIdleMinutes`（均 1–1440，非法值回落默认）。

### 新增（G1 子会话目标）

- `src/goal.js`：声明式接入平台 `ctx.goals`。spawn 成功后 `create` + **紧接着 `disarm`**（goal 只做持久目标状态，不驱动子会话自动续轮）；
  `task_message`/面板追加把「原目标 + 最新指示」同步为 goal（文本变化才 `edit`，并保持 disarmed）；
  `done` → `complete`，`stop`/`retry`/`orphaned`/`failed` → `clear`。
- 台账新增 `tasks.goal_state_json` 只读镜像（裁剪字段，坏 JSON 按无镜像处理）；面板 snapshot 带紧凑 goalState，
  详情抽屉新增「目标状态」只读区块，列表显示「目标·阶段」小标；面板不提供任何 goal 写操作。
- **静默降级**：`ctx.goals` 缺失/方法不全时所有钩子 no-op，不 warn、不阻塞派发/续派/结算；子 agent 晚出现时等 `agent/created`（最多 3 秒）。
- 边界（不自动续跑、冷恢复窗口、外部 re-arm）见 `docs/LIMITATIONS.md`「目标（G1）」；接入点见 `docs/ARCHITECTURE.md` 同名小节。

### 测试

- `npm test` 532/532：新增看门狗判定数据源/阈值边界、每任务一次去重、活动重置、`system` 汇总通知、无 `summary` 回退 push、关闭开关、`start()` 立即巡检与 `stop()` 卸载清理、台账读失败降级，以及 `apply()` 接入与卸载；配置默认/覆盖/夹取。
- G1 新增 `test/goal.test.js`（桥的 create+disarm 顺序、目标复用/edit、complete/clear、能力缺失静默降级、错误只 warn 一次、台账镜像）与 `test/goal-hooks.test.js`（工具/面板/结算/快照挂钩），`test/dispatch.test.js` 增加 spawn/send/stop 契约，`test/index.test.js` 增加真实 `apply()` 接入与无 goals 降级。

## 0.8.0（2026-11-15）

稳定性闭环 + 调试能力：子会话结算原因自动收场、启动对账兜底孤儿、子会话可切「创造模式」。相对 0.7.0 无破坏性变更（minor）。

### 新增

- **结算原因闭环（S1）**：新增 `src/settlement.js` 消费子会话 `settle` 的 `stopReason`，自动把 `running` 推到终态
  （正常完成→`done`、被中断→`cancelled`、异常→`failed`、只报过进展→`orphaned`），记录死因并合并通知；
  原本只靠子会话自己 `task_report` 的「沉默中断」不再留在 `running`。
  取值与时序见真机探针 `docs/probes/stop-reason-probe.md`。
- **启动对账（S2）**：插件启动与协调者晚加载时扫描台账，`running` 但子会话已不活跃（`agents.get` 查不到）的任务标 `orphaned`，
  补上进程重启/崩溃后的「沉默中断」兜底；`waiting_dep` 不参与、`waiting_*` 不因不 live 被误标；重复启动幂等。
- **孤儿汇总上报**：对账结果合并成一条通知（任务名 + id，超 10 条折叠），协调者未加载时保留待发、`agent/created` 后补发一次。
- **子会话调试能力（D1）**：新增 `config.workerPreset`（默认 `dsh-orchestrator-worker`，透传到子会话启动的 `agentPreset`，
  非法 id 回落并 warn）；`npm run preset:debug` 把随包「创造模式」(`cordis`) 组合复制成可安装的 `orch-debug` 预设
  （含 `cordis_*` 只读洞察工具与 `dsh-doc` 技能），装好后 `workerPreset: orch-debug` 即可让调试子会话拿到创造者能力。
  用法、边界（预设不是沙箱、宿主需彻底重启、升级后要重新生成）见 `docs/DEBUG-PRESET.md`。

## 0.7.0（2026-11-15）

面板操作台收尾：错误码与幂等、详情抽屉、产物自动收集。相对 0.6.1 无破坏性变更，属向后兼容的功能新增（minor）。

### 新增

- **面板动作错误码与幂等**：统一 `action-errors` 错误码表，工具层与面板复用同一口径；`stop` 对重复调用/已终态返回 `already`；
  `retry` 仅允许 `failed` / `orphaned`，同源活跃重派视为幂等；`message` 支持 `clientRequestId` 进程内去重，
  并带同文短窗口兜底；面板直接展示错误码与 `already` 提示。
- **详情抽屉四区块**：面板详情抽屉按「基本信息 / 执行 / 依赖 / 产物」四区块展示，并显示 followup 投递状态。
- **done 自动收集产物**：子任务 `task_report done` 时从 `workspaceChanges` 自动收集改动文件，与显式 `artifacts`
  按路径去重合并；产物库支持按项目/日期分组、预览与复制，并可从任务卡片直达。

### 文档与内部

- 轮询注释对齐实现（2s `POLL_MS`、30s 退避 `POLL_BACKOFF_MS`），清理遗留审计与探针文件。
- README 发版流程改为 annotated tag + `git push --follow-tags`；安装示例与排障版本号同步到 0.7.0。

## 更早版本

按 `git tag` 主题重建的简要索引，细节见对应 tag 的提交与 `docs/`：

| 版本 | 主题 |
|---|---|
| 0.6.1 | 重构 README，拆分 ARCHITECTURE / LIMITATIONS 文档 |
| 0.6.0 | P3 产物库与面板操作台 |
| 0.5.1 | P0 收尾：插件展示元数据与 npm 占位版本清理 |
| 0.5.0 | P2 收件箱 / 问题选项 / `stallRounds` / 日报 |
| 0.4.0 | P1 依赖编排：`dependsOn` / `group` / `writeScopes` / `priority` |
| 0.3.x | 发布流水线（provenance + 重复发布保护）、client id 回归、MIT LICENSE |
| 0.2.x | 插件入口直达主会话、显示名文案、只读子任务（`readOnly`） |
| 0.0.0-stage | npm 占位版本（已 deprecate） |

