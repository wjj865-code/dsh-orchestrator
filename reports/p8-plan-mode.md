# P8 子任务计划模式（subtask-plan-mode）：planFirst → 只读+plan mode → blocked 上报 → 批准 → 可写执行

- 日期：2026-11-15
- 任务：`t-cbcc1d87`（P8，`master-plan-4docs.md:506-514` / §2.3；设计文档 `2026-11-15-subtask-plan-mode.md`）
- 目标：`task_create({ planFirst: true })` 让子会话以「只读沙箱 + plan-mode 提示」起步；探索完用 `task_report blocked`
  上报计划；协调者转交用户，批准后 `task_message` 续派时插件解除只读、关闭 plan mode。不开 `planFirst` 的任务行为不变。
- 结论：T8.1–T8.5 全部落地，T8.6 文档齐；**`npm test` 672/672 全绿**（新增 `test/plan-mode.test.js` 26 条），
  `npm run check:client` 通过；改动**本地 commit、未 push**。真机端到端（批准链路）按计划留在装 profile 后复核，
  清单已写进 `docs/qa-checklist.md` §35.2。
- 版本号：**暂留 0.12.0**。P6/P7 的发版（0.13.0 / 0.14.0）尚未做，P8 的 0.15.0 与它们一起在发布批次处理；
  本单按任务约束只本地提交不 push（见 §7 偏差）。

---

## 0. 先看这一页

| # | 结论 | 证据 |
|---|---|---|
| A | **进入**：派发时复用 `ensureReadOnly`（agent/created 先设 + 激活后幂等补）→ 子会话只读；再在**子 agent 作用域** `agent.ctx.get('planMode')?.set(agent, true)` 置 plan mode；服务缺失只 warn 降级 | `src/dispatch.js`（spawn / applyPlanMode）；`test/plan-mode.test.js` §派发 4 条 |
| B | **出口**：`exit_plan_mode` 在**子会话 agent 作用域**被拒，文案指向 `task_report blocked`；协调者与其它会话不受影响（插件根 guard 是全局的，所以没用它） | `src/dispatch.js`（installExitPlanGuard）、`src/plan-mode.js`（`EXIT_PLAN_MODE_DENIAL`） |
| C | **批准**：`task_message`（面板「追加」同源）投递成功、任务从 `waiting_user` 回 `running` 后 → `sandbox/mode=workspace-write` + `planMode.set(agent,false)` + 补 target 可写根 + `plan_state='approved'`；投递失败不碰 plan 状态 | `src/plan-mode.js`（`approvePlan`）、`src/tools.js`、`src/panel-actions.js`；用例 3 条 |
| D | **台账两列**：`plan_first`（0/1）+ `plan_state`（`none`/`planning`/`approved`/`rejected`），旧库逐列 `ALTER TABLE`；计划任务在 `planning` 时进终态收口成 `rejected`，已 `approved` 保留 | `src/ledger.js`；用例 3 条（含旧库迁移） |
| E | **契约**：`planFirst` 只认显式 `true`（字符串 `'true'` 不生效）；与 `readOnly` 创建期互斥；`task_retry` / 面板 retry 重新进计划阶段 | `src/tools.js`、`src/panel-actions.js`；用例 3 条 |
| F | **视图**：`task_list`「·计划中」、`task_status`「计划：」行、`task_detail` 计划阶段说明（只读是预期）、快照/详情 `planFirst`/`planState`、任务卡「计划中」小标 + 「计划·…」chip + 抽屉概览「计划」行 | `src/tools.js`、`src/task-detail.js`、`src/host-route.js`、`src/panel-actions.js`、`client/src/**`；用例 4 条 |
| G | **不回归**：非计划任务一次 `planMode` 调用都没有、无 guard、无计划字样；`readOnly` 任务照旧只读 | `test/plan-mode.test.js`；全量 672 条 |

---

## 1. 范围对照（计划 T8.1–T8.6）

| 计划 | 本单 | 落点 |
|---|---|---|
| T8.1 台账两列 + `planFirst` 契约（互斥） | ✅ | `src/ledger.js`（SCHEMA/迁移/`taskOf`/`createTask`/`setPlanState`/`transition` 收口）、`src/tools.js` |
| T8.2 派发进入计划阶段 | ✅ | `src/queue.js` 透传 `task.plan_first` → `src/dispatch.js`（`ensureReadOnly` + `applyPlanMode` + guard） |
| T8.3 批准后恢复执行 | ✅ | `src/plan-mode.js`（`approvePlan`/`approvalNote`）→ `src/tools.js` `task_message`、`src/panel-actions.js` `message` |
| T8.4 拒子会话 `exit_plan_mode` | ✅ | `src/dispatch.js`（`agent.ctx.tools.guard`，agent 作用域） |
| T8.5 面板 + `task_status` 计划状态 | ✅ | `src/host-route.js`、`src/panel-actions.js`、`client/src/{constants,client,views}.js`、`src/tools.js` |
| T8.6 文档 + 全量 + 发版 0.15.0 | ✅ 文档/全量；⏭ 发版 | `README.md`、`docs/{ARCHITECTURE,LIMITATIONS,qa-checklist,UI}.md`、`CHANGELOG.md`；版本见 §7 |

**没有**动的：沙箱/派发以外的既有能力（goal、keep-alive、结算、对账、依赖、产物）行为不变；
协调者工具白名单不变（没新增工具）；`cordis.patch.yml` / 平台依赖不变。

---

## 2. 平台契约（按 P0 探针 0.2.2-rc.3 复核后的形状）

本单实现按 `docs/probes/out/t0.1-contract-probe.json`（P0 产出）里的现装契约写：

- 服务名 `planMode`，方法 `set(agent, active)` 返回 `'committed' | 'queued' | 'cancelled' | 'noop'`，
  `get(agent)` 返回 `{active, pending?}`；
- `plan/mode { active }` 是 **log-only** 事件，重启/fork/压缩由平台投影恢复；
- plan mode **不碰沙箱**（模块注释原话：沙箱与 approval 策略独立执行、不读写 plan 状态）→ 硬拦只能靠 `read-only` 沙箱；
- `exit_plan_mode` 依赖 `userQuestions` 服务：**子会话没有直接人类，批准会悬空** → 这就是本单不走 `exit_plan_mode` 的原因；
- `planMode` 在子会话预设作用域：插件必须 `agent.ctx.get('planMode')`，不能用插件根作用域的 `ctx.get`。

> 设计文档写的是 `@deepseek-ai/dsh-plan-mode@0.0.1-rc.1`；现装 0.2.2-rc.3。`set()` 四态、`get()`、事件形状、
> `exit_plan_mode` 准入这些都按探针结果实现，没有照抄文档里的行号/返回值假设。

---

## 3. 实现要点（评审要看的四处）

### 3.1 进入：软引导 + 硬沙箱叠加，且只装一次

- `queue.pump` 把 `planFirst: task.plan_first === true` 传给 `dispatcher.spawn`；
- `spawn` 在 `startActivation` **之前**把 childId 记进 `planChildren`（与 `readOnlyChildren` 同一机制），
  所以 `agent/created` 一到就能设沙箱（压掉首回合窗口）；
- 激活返回后再补一次：`ensureReadOnlyReady`（幂等）+ `installExitPlanGuard` + `applyPlanMode(true)`；
- `applyPlanMode` 内部用 `planApplied` 去重：`agent/created` 与激活返回两条路都调一次，但真正 `set()` 只有一次；
- `planFirst` 的任务在**批准前不注册 target 可写根**（否则只读有后门）；可写根在批准/续派时补。

### 3.2 出口：`task_report blocked`，不是 `exit_plan_mode`

- 子会话 agent 作用域注册 `agent.ctx.tools.guard`：命中 `exit_plan_mode` 返回可读拒绝文案，
  指向 `task_report({status:'blocked', summary:'计划已就绪', question:'<计划正文>'})`；
- guard 还额外核对 `exec.agent.id === childId`，避免作用域复用串扰；
- 一段 activation 结束时释放 guard（`releasePlanGuard`），续派/冷恢复按 `agent/created` 重装；
- 任务终态/停止时 `releasePlan` 连 `planChildren` 一起收口，后续不会再把会话拉回计划模式。

### 3.3 批准：只在「投递成功 + 回到 running」之后切

`task_message` / 面板 `message` 都按同一顺序：

1. `sendReliable` 投递（失败路径：`plan_state` 不动，任务仍在 `waiting_user`，面板显示投递失败）；
2. 投递成功 → `plan_state` 从 `waiting_user` 迁回 `running`；
3. `approvePlan`：`session.append('sandbox/mode', { mode: 'workspace-write' })`（与 `ensureReadOnly` 同一入口、同一事件形状）
   → `planMode.set(agent, false)` → 补 target 可写根（rc.3 子会话 `header.cwd` 是父会话目录）→ 台账 `approved`；
4. 运行期切换失败（拿不到子会话/没有 append）**不假装成功**：台账仍标批准（用户确实批准了），
   但工具结果/面板返回带「子会话可能仍是只读，必要时 task_stop 后重派」。

### 3.4 台账只是编排视图

- 运行期真相在平台会话日志（`plan/mode`）；台账 `plan_state` 只服务协调者/面板；
- `transition()` 在计划任务进终态时收口：还在 `planning` 就结束 → `rejected`；已 `approved` 保留；
- 这样会话丢失/失败/停止都不会留下「一直在计划中」的僵尸视图。

---

## 4. 改动文件

| 文件 | 变更 |
|---|---|
| `src/plan-mode.js` | **新增**：状态常量/文案、`isPlanTask`/`planStateOf`/`planListMarker`/`planStatusLine`、`PLAN_FIRST_DETAIL`、`EXIT_PLAN_MODE_DENIAL`、`approvePlan`/`approvalNote` |
| `src/ledger.js` | `tasks` 加 `plan_first`/`plan_state` + 旧库补列；`taskOf` 归一；`createTask({planFirst, planState})`；`setPlanState`；`transition` 终态收口 |
| `src/dispatch.js` | 计划任务登记/去重；`applyPlanMode`；agent 作用域 `exit_plan_mode` guard；`approvePlan`；settle/stop/终态释放；team 后端明确拒绝 `planFirst` |
| `src/queue.js` | 派发透传 `planFirst` |
| `src/tools.js` | `task_create.planFirst`（显式 true、与 readOnly 互斥、brief 标记、结果指引）；`task_list` 标记；`task_status` 计划行；`task_message` 批准链路；`task_retry` 重新进入计划 |
| `src/task-detail.js` | 计划任务权限按 `plan_state` 渲染（planning=只读、approved=可写）；计划阶段说明 |
| `src/panel-actions.js` | 详情 `planFirst`/`planState`；retry 重新计划；面板「追加」批准链路 |
| `src/host-route.js` | snapshot 下发 `planFirst`/`planState` |
| `client/src/constants.js` / `client.js` / `views.js` | `PLAN_STATE_LABEL`；任务卡「计划中」小标 + 「计划·…」chip；抽屉概览「计划」行 + 副标题 |
| `index.js` | 协调者 policy 增加一句 `planFirst` 用法（与 readOnly 互斥） |
| `test/plan-mode.test.js` | **新增** 26 条：映射/文案、台账与迁移、task_create/message/stop/retry、派发进入/退出、team 拒绝、snapshot/detail、面板追加、客户端产物 |
| `dist/client.js(.map)` | vite 重建产物（`npm run build`） |
| `README.md` / `docs/ARCHITECTURE.md` / `docs/LIMITATIONS.md` / `docs/UI.md` / `docs/qa-checklist.md` / `CHANGELOG.md` | 计划模式文档 + 复核矩阵 + 未发布记录 |

---

## 5. 验证

| 门禁 | 命令 | 结果 |
|---|---|---|
| 全量单测 | `npm test`（`pretest` 自动 `vite build`） | **672 / pass 672 / fail 0** |
| 本单新用例 | `node --test --experimental-test-isolation=none test/plan-mode.test.js` | **26 / 26** |
| 客户端语法 | `npm run check:client`（`node --check dist/client.js`） | 通过 |
| 客户端构建 | `npm run build` | 10 modules，`dist/client.js` ≈ 100.36 kB（gzip 23.12 kB）+ map |
| 台账迁移 | 用例内建旧 schema 库 → `openLedger` | 两列自动补齐，旧行读 `false`/`none` |
| 非计划任务回归 | 派发用例断言「一次 planMode/guard/只读都不碰」 | 通过 |

用例覆盖（`test/plan-mode.test.js`）：

1. 计划状态映射（列表只标 planning；status 行区分三态；非计划无字样）；
2. exit 文案指向 `task_report blocked`；计划说明写明「只读是预期」；
3. keep-alive 不把等批准任务当可续跑（`task-not-running`）；
4. 台账默认/落库/`setPlanState`；旧库补列；终态收口；
5. `task_create` 透传 + 结果指引 + task_detail 计划说明；字符串 `'true'` 不生效；互斥拒绝；
6. `task_list`/`task_status` 标记；`task_message` 批准/投递失败不批准/running 普通消息不批准；`task_stop` rejected；`task_retry` 重新计划；
7. `task_detail` 纯渲染三态（planning/approved/非计划）；
8. 派发：只读 + planMode + guard；`agent/created` 先路径不重复；非计划不碰；服务缺失降级；
9. 批准：切 workspace-write + plan off + 释放 guard + 补可写根；拿不到会话返回 `ok:false`；
10. team 后端拒绝 `planFirst`；
11. snapshot/detail 字段；面板「追加」批准链路；
12. 源码与 `dist` 产物都带「计划中」/计划状态文案。

---

## 6. 真机待办（本单未执行，需装 profile 后逐条勾）

子代理会话没有平台 GUI / profile 安装权限，真机链路留给协调者/用户按 `docs/qa-checklist.md` §35.2 复核：

| 场景 | 期望 |
|---|---|
| 派发 `planFirst:true` | 子会话沙箱 read-only；任务卡「计划中」小标 |
| 计划阶段让子会话写文件 | 被沙箱拒绝；模型改走只读探索 |
| 子会话调 `exit_plan_mode` | 被拒且指向 `task_report blocked`；协调者不受影响 |
| `task_report blocked` 上报计划 | 协调者收到待决定通知；`task_status` 显示「计划：计划中」 |
| 批准（`task_message` / 面板「追加」） | 切回可写；子会话能写文件；`plan_state=approved` |
| 不批准直接 `task_stop` | `cancelled` + `plan_state=rejected` |
| 非计划任务 | 无 plan 调用/字样/guard |
| `planMode` 服务缺失 | 只 warn；仍只读、仍能上报；批准后仍能切回可写 |

---

## 7. 与计划的偏差 / 遗留

1. **发版 0.15.0 未做**（计划 T8.6 的一部分）：任务明确「npm test 全绿后本地提交不 push」，且 P6 的 0.13.0、P7 的
   0.14.0 都还没发；本单把版本留在 0.12.0，CHANGELOG 记「未发布：P8 计划模式」，发版与版本号统一在发布批次处理。
2. **真机端到端未执行**（§6）：需要装 profile / 重启 DSH 才能验，子代理会话不具备。
3. **`planFirst + worktree`**：P9 尚不存在；本单只做 `planFirst + readOnly` 互斥。P9 落地时按 `master-plan-4docs.md` §4.5 #7
   在创建期拒绝该组合即可（不需要 P8 预留代码）。
4. **「切回可写后能写指挥舱」**：沿用 `workspace-write` 的既有口径（根 = 子会话 `header.cwd` + 可写根），
   如实写进 `docs/LIMITATIONS.md`，未在本单收紧。

---

## 8. 风险与边界（与计划 §R6–R8 对照）

| 风险 | 本单的落法 |
|---|---|
| R6 plan mode 是软引导，模型边规划边写 | 只读沙箱硬拦 + `task_detail` 写明「写被拒是预期」「出口是 task_report blocked」 |
| R7 `planMode` 服务拿不到（作用域/版本） | `agent.ctx.get('planMode')`；缺失只 warn 一次/子会话，降级为只有只读沙箱；派发不阻塞 |
| R8 计划状态两处真相（会话日志 vs 台账） | 台账只作编排视图；终态收口 `rejected`/保留 `approved`；LIMITATIONS 写明重启后以平台为准 |
| 首回合极短可写窗口 | 与 `readOnly` 任务同一机制（`agent/created` 先设 + 激活后补），已写进 LIMITATIONS |

---

## 9. 提交

- 本地提交：`feat(plan-mode): 子任务计划模式（T8.1–T8.6）`（`git log -1 --oneline` 可查），**未 push**。
- 工作区仅剩 P0 阶段遗留的未跟踪探针文件（`docs/probes/**`、`reports/t0.1-probes.md`），不属于本单，未纳入本次提交。
