# progress 通知必达（t-99d4a98c）：设计与验证

## 现象与根因

用户报的原场景：子任务长时间没回 → 协调者 `task_message` 追问「先给部分结论」→ 子会话
`task_report(progress)` 报完继续跑 → **主会话什么都收不到**，15 分钟后只剩看门狗提示。

根因（t-1f4bc448 已查实）：`src/notify.js` 的分级表把 `progress` 标成 `silent`，
`notifier.push()` 第一行就 `return`——不进 5 秒合并窗口、不 `steer` 协调者、连
`notifications` 审计行都不写。台账实证 8/8：followup 之后的下一条 report 是 progress 的，
`notifications` 邻近窗口 0 行。

## 设计（结构性，不是补丁）

三档之外新增一档 `coalesce`，只给 progress 用：

| status | 级别 | 行为 |
|---|---|---|
| progress | **coalesce** | 默认送达：5 秒合并窗口；同任务 60 秒水位（窗口内只留最新一条、到水位线补投）；**追问/续跑后的第一条不看水位、立刻送** |
| done / delivered / failed / stalled / cancelled / orphaned | notify | 不变（5 秒合并） |
| blocked / needs_auth | interrupt | 不变（立即打断） |

三个关键判据：

1. **追问必达**：台账新列 `tasks.report_expected_at`——`task_message` / `resume` / 面板「追加」
   **投递成功**后置位；下一份回报读它得到 `answeredFollowup`，progress 据此跳过水位与合并窗口。
   回报一到就清标记，只对第一条生效（否则一次追问会把整段长任务变成每条 progress 都即时唤醒）。
   为什么落台账而不是「最近一条 followup」：追问可能隔很久，中间夹着结算、状态迁移、插件重启。
2. **不刷屏**：同任务 60 秒水位 + 5 秒合并窗口；水位内只留**最新**一条，到点补投（尾沿保留
   最后状态）。同窗口内同任务的第二条 progress 覆盖第一条；被同窗口的 `done`/`blocked`
   取代的直接撤掉（一条消息里不重复列同一任务）。
3. **每条 progress 都有审计行**：送达 `delivered`；被压住/覆盖/取代写
   `skipped` + `reason: progress_watermark | progress_merged | progress_superseded`。
   旧口径连行都不写，这是「主会话为什么没收到」唯一好用的判据。

配套：投递失败（skipped/failed）撤回水位（一次「主会话没打开」不会连带压住后续 progress）；
卸载时 `drain` / `flushNow` 把压住的 progress 一并送掉；水位定时器 `unref`，不挂住进程。
水位在进程内，重启后重置——重启后的第一条 progress 立即送，正是重启后最需要的那条状态。

## 与「复用已有上下文的会话、无显式终态、靠 resume 继续」的关系

progress 不是「汇报完成」，而是**协调关系的信号**：它告诉协调者「这个子会话还活着、走到哪了」，
于是下一步是 `task_message` 追问同一个会话（或 `resume` 冷恢复），而不是重派一个新任务。
本修复把这条信号接通了三个入口：

- 追问（`task_message` / 面板「追加」）后的第一条回报必达——否则「追问石沉大海」，复用会话
  这条路在用户眼里就不成立；
- 续跑（`resume`）后的第一条回报同样必达——冷恢复的价值在于「接着干」，干到哪儿必须先看得见；
- 通知文案与 L1 policy 共用一句话（`src/copy.js` 的 `PROGRESS_NOTICE_HINT`）：progress 是信号、
  不是终态，要结论就追问同一子会话，别为此重派任务。

## 改动文件

- `src/notify.js`：`progress: 'coalesce'`；合并窗口去重、同任务水位尾沿、追问必达、审计原因、
  progress 专用文案（「有新进展」/「有新进展（回答你的追问）」+ 动作指令 + 不列产物）。
- `src/ledger.js`：`tasks.report_expected_at` 列与旧库迁移、`markReportExpected` / `clearReportExpected`。
- `src/tools.js`：`task_message` / `resume` 投递成功置位；`task_report` 读标记 → `answeredFollowup`、
  清标记、写日志 `task.report` 的 `answeredFollowup`。
- `src/panel-actions.js`：面板「追加」同口径置位。
- `src/copy.js`：`PROGRESS_NOTICE_HINT` 单一文案源。
- `index.js`：L1 协调者 policy 加一条「收到 progress 通知」的口径（逐字引用上面的常量）。
- 文档：`docs/ARCHITECTURE.md`（回报/通知表与三条判据）、`docs/LIMITATIONS.md`（节流与必达边界）、
  `README.md`（看进度 + 工具清单）、`docs/testing.md`（测试行）、`CHANGELOG.md`（0.25.1 同批小节）。

## 怎么验证

```text
$ pnpm test        # pretest: vite build + check-client-size + check:docs
  客户端体积在预算内：93.2 KB (95402 B) / 预算 95.0 KB (97280 B)（余 1.8 KB）
  文档检查通过：总行数 1495 / 预算 1800；配置表 22 键、工具表 10 个、包内文档与内链均可达。
# tests 1080
# pass 1075
# fail 0
# skipped 5
```

新增/更新的用例：

- `test/notify.test.js`：默认送达（文案 + 追问出口）、与 done 同窗口合并、同任务窗口覆盖、
  水位尾沿补投、追问必达立刻送、被 done 取代、投递失败不占水位、卸载释放待发。
- `test/tools.test.js`：追问置位、progress 必达透传、只对第一条生效、done 也清标记、
  投递失败不置位。
- `test/ledger.test.js`：标记置位/清空、旧库（无该列）自动补列。
- `test/resume.test.js`：续跑后置位。
- `test/panel-actions.test.js`：面板追问置位。
- `test/copy-consistency.test.js`：L1 policy 与通知逐字同源。
- `test/integration.test.js`：**端到端复现用户场景**——追问 → 子会话先报 progress → 主会话立刻
  收到「有新进展（回答你的追问）」；后续 progress 走水位（inject 次数不涨）并留
  `progress_watermark` 行。

## 可观察行为（排障用）

- 主会话侧：追问后应立刻收到一条 `任务「X」有新进展（回答你的追问）：…`，尾部带
  「要结论就 task_message 追问同一子会话」；窗口外的 progress 不会再出现主会话完全无感的情况。
- 台账：`notifications` 里每条 progress 都有行——`level='coalesce'`，`status=delivered` 或
  `skipped` + `reason`；`tasks.report_expected_at` 非空表示「刚追问/续跑过、在等回报」。
- 日志：`notify.delivered` / `notify.coalesced`（带 reason）/ `notify.skipped`；
  `task.report` 的 `detail.answeredFollowup` 标明这条回报是不是追问的答案。
- 测试旁路：`DSH_ORCH_PROGRESS_MS` 只调水位（默认 60000），与 `DSH_ORCH_NOTIFY_MERGE_MS` 同档，
  不改语义、不进插件配置面。

## 待确认

- 水位取 **60 秒**（固定常量，不新增配置键）：如果实际使用中觉得「长任务看不到中间过程」，
  可以改成可配置或调小；反之觉得打扰，可以调大。默认按「一次追问往返以分钟计」定。
- `task_status` / 面板目前不显示「在等回报（`report_expected_at`）」——需要的话可以加一行只读展示
  （本单未做，避免扩大改动面）。
