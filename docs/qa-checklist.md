# dsh-orchestrator 阶段 1 验收清单

- 依据：`docs/superpowers/specs/2026-11-13-dsh-orchestrator-design.md`（设计）、`docs/superpowers/plans/2026-11-13-dsh-orchestrator-phase1.md`（计划 Task 1–10）
- 维护：测试。每个任务提交后在独立 worktree 按本清单复跑，**只认自己跑出来的输出**，不采信开发自测数字。
- 裁决：计划末尾「阶段 1 范围裁决（R1–R8）」（`2689186`）。本清单 §12 按裁决执行；阶段 3 项不判 Task 失败。
- 结论格式：一行「Task N 通过/不通过｜证据：命令 + 关键输出｜不通过项：…」。不通过必须给最小复现步骤、期望、实际、疑似代码位置。

## 0. 复跑方式（每个任务提交后）

1. `git -C C:\Users\72489\Documents\dsh-orchestrator log --oneline -1` 取提交号，确认工作区干净。
2. 独立副本（不碰主工作区）：worktree / 干净 clone 上 `git checkout <提交号>`。
3. `npm test` 记录 pass/fail/skipped 计数；有 skip 必须问清原因。
4. 跑本清单对应 Task 段 + 全局门禁，必要时跑我自己的补充脚本。
5. 只有 1–5 全过，才在群里报该任务通过。

---

## 1. 全局门禁（每个任务提交都要查，不只 Task 10）

| # | 门禁 | 怎么验 | 判据 |
| --- | --- | --- | --- |
| G1 | 全量测试绿 | 干净副本 `npm test` | 0 fail；pass 数与用例数一致；无未说明的 skip；进程正常退出不挂起 |
| G2 | 提交干净 | `git show --stat <sha>`、`git status --porcelain` | 只含该任务的文件；无 `node_modules/`、`*.sqlite`、临时脚本、`.env` 混入 |
| G3 | **JSON 绝不进子会话** | 捕获 `dispatcher.spawn` 收到的 `prompt` 文本；用含 `{}`、引号、换行、超长的边界 brief 渲染 | prompt 是渲染文字；无 `"title":`、`"acceptance":` 等键名；整体不是可 `JSON.parse` 的对象 |
| G4 | **台账只写 `$DSH_HOME/state/orchestrator`** | 临时 `DSH_HOME` 跑「建任务→回报→停止」；`Get-ChildItem -Recurse` 审计整个临时 home 与仓库 | 临时 home 下除 `state/orchestrator/` 外零新增；仓库内无 sqlite/wal/shm；`~/.dsh` 真实目录不被写（DSH_HOME 覆盖时） |
| G5 | 工具 schema 契约 | 6 个工具逐个体检 | `parameters.type === 'object'` 且根上无 `minimum`/`maximum`；`output.schema` 与 `output.render` 都存在；`render(args, value)` 返回 `[{type:'text', text:string}]` |
| G6 | 错误全转可读中文 | 每个失败路径：不存在 id、非法参数、底层抛错 | 返回中文字符串；无 `SQLITE_`、`TypeError`、`at …` 堆栈、`undefined` 字面出现 |
| G7 | 依赖收窄 | 源码 grep `ctx.`、`agentTeams.` | `dispatch.js` 只调 `spawnTeammate / sendMessage / interrupt / listMembers`（+ `membership` 若用到必须说明）；不偷偷用 `ctx.tools` 之外的平台服务做派活 |
| G8 | 工具面正确 | `apply` 后注册表 | 协调者 5 个 `task_*` + 子任务 `task_report` 共 6 个；名字、description 中文、无重复注册 |

---

## 2. Task 1 — 配置（`package.json`、`src/config.js`）

| 验收点 | 怎么验 | 判据 |
| --- | --- | --- |
| 默认值 | `loadConfig({})` | `staleMinutes=30`、`stallRounds=3`、`maxActive=8`、`mergeWindowMs=5000`、`coordinatorSession=undefined` |
| 合法覆盖 | `staleMinutes:10` | 生效 10 |
| 非法回落 | 我另测 `0`、负数、`NaN`、`Infinity`、`'30'`（字符串）、`null`、`undefined` | 一律回落默认；不抛异常 |
| 无参调用 | `loadConfig()`（不传） | 不崩，返回默认 |
| 不泄漏原始键 | `loadConfig({ foo: 1 })` | 结果里无 `foo` |
| 包元数据 | `package.json` | `type=module`、`main=index.js`、`files` 含 `index.js/src/cordis.patch.yml/README.md`、`engines.node>=22.15`、test 脚本可跑 |

不通过判据：坏配置把插件带崩 / `coordinatorSession` 接受空串或非字符串。

## 3. Task 2 — 状态机（`src/state.js`）

| 验收点 | 怎么验 | 判据 |
| --- | --- | --- |
| 状态集合完整 | `STATUSES` 排序 | 8 个：`pending running waiting_user waiting_auth done failed cancelled orphaned` |
| **全迁移矩阵** | 我自己生成 8×8 全组合断言（不只计划里的样例） | 只有 `pending→running/cancelled`、`running→waiting_user/waiting_auth/done/failed/cancelled/orphaned`、`waiting_user→running/cancelled/failed`、`waiting_auth→running/cancelled/failed`、`failed→running/cancelled`、`orphaned→pending/cancelled` 为 true，其余 false |
| 终态无出边 | 矩阵里 `done`、`cancelled` 行 | 全 false |
| 未知状态 | `canTransition('x','running')`、`canTransition('running','x')` | 返回 false 不抛 |
| 抛错文案 | `nextStatus('done','running')` | 抛 `/不允许/`，带 from→to |
| 迁移失败不落库 | 台账里对 done 任务再 `transition` | 抛错后库中状态仍 done、`updated_at` 不变 |
| 非法迁移链 | pending→done 直接跳过 running | false；`done→running` false；`cancelled→pending` false |

## 4. Task 3 — brief 校验与渲染（`src/brief.js`）

| 验收点 | 怎么验 | 判据 |
| --- | --- | --- |
| 必填校验 | `{}`、只 title、只 title+goal | 错误列表分别含 `title` / `goal` / `acceptance`；合法 brief 返回 `[]` |
| 空白视为空 | `title:'  '`、`goal:''` | 报必填错 |
| 类型容错 | `acceptance:['a', 1, null, '']`；`constraints:'x'`（非数组） | 过滤后至少一条合法项；非数组按空处理，不崩 |
| 渲染小节齐全 | 完整 brief | 依次含【任务】【目标】【约束】【验收标准】【背景资料】【用户原话】+ 结尾「完成后请汇报」 |
| 可选小节缺省 | 只有 title/goal/acceptance | 不出现【约束】【背景资料】【用户原话】 |
| **渲染无 JSON** | 上面的文本 | 无 `"title"` / `"acceptance"` 键名；无 `{"` 序列；不含 `JSON.stringify` 结果特征 |
| 用户内容含花括号 | `user_verbatim:'返回 {a:1} 不是数组'`、goal 含引号/换行 | 文本原样可读；仍不是 JSON 文档；不打乱小节结构（换行注入被压成单行或明确降级） |
| 超长/特殊字符 | 10000 字 acceptance、emoji、`【任务】` 注入到 title | 不崩、不截断出乱码；title 里的伪小节不得伪造新的【】小节 |
| 纯函数 | 同一输入两次渲染 | 输出完全相同，无副作用 |

不通过判据：任何 JSON 片段出现在渲染结果 / 渲染抛异常 / 可选字段为空却出现空小节。

## 5. Task 4 — 台账（`src/ledger.js`、`test/helpers.js`）

| 验收点 | 怎么验 | 判据 |
| --- | --- | --- |
| 建表 | `openLedger(临时目录)` | `tasks/messages/notifications` 三表存在；`PRAGMA journal_mode` 为 `wal`；同目录重复 open 幂等不报错 |
| 创建读回 | `createTask` | `id` 匹配 `^t-[0-9a-f]{8}$`；`status=pending`；`title/goal/brief_json` 一致；三个时间戳为数字 |
| 活跃过滤 | pending/running/waiting_user/waiting_auth 各建一条 + done/cancelled | `listTasks({active:true})` 只含 4 种；`listTasks()` 全量；排序 `created_at DESC` |
| **同毫秒排序** | 连续建 5 条（同一毫秒） | 顺序稳定可复现（按 created_at 相同时需有次级排序或明确说明） |
| 非法迁移拒绝 | 台账层对 done 再 running | 抛 `/不允许/`，状态不变 |
| 不存在任务 | `transition(db,'t-nope','running')` | 抛 `任务不存在：t-nope` |
| 消息 seq | 对同一任务连发 5 条 | seq 为 1..5 连续无空洞；按 seq 读回顺序一致 |
| **并发写** | 8 个任务各写 20 条消息（异步交错） | 每条 seq 连续、无主键冲突、无丢失；不同任务不串号 |
| touchTask | 对 running 任务 | 状态不变，`updated_at`/`last_event_at` 增加 |
| patch 语义 | `transition(..., { error:'x' })` 后再传 `{ error:null }` | 明确是否可清空（COALESCE 会保留旧值）——与设计「重新派发清错误」对齐则需可清 |
| **损坏库（R1）** | 把 tasks.sqlite 写成垃圾字节后再 `openLedger` | 抛可读中文 `台账损坏：<库路径>（可尝试从 snapshots 目录恢复）`；输出不含 `SQLITE_`、不含 `at ` 堆栈；不自动恢复、不写快照（阶段 3） |
| 落盘范围 | 只传临时目录 | 除该目录外零写入 |

## 6. Task 5 — 派活封装（`src/dispatch.js`、`docs/api-notes.md`）

| 验收点 | 怎么验 | 判据 |
| --- | --- | --- |
| slug 合法 | 中文/空格/标点/emoji 标题 | 结果匹配 `^[a-z0-9-]+$`；空标题 → `task-<数字>-<n>`；连续调用不重名 |
| spawn 入参 | 假 agentTeams 记录入参 | `name`、`description`、`prompt:[{type:'text',text:渲染文本}]`、`context:'fresh'`；显式 `provider` 时透传，未配时不出现 |
| 返回 member | spawn 返回 `{member}` | 返回 member 对象；台账用 `member.id`/`member.name` |
| send/stop 透传 | 调用 send/stop | `sendMessage(agent,{target,content:[{type:'text',text}]})`；`interrupt(agent,target)`；不调其他方法 |
| members | `dispatcher.members()` | 透传 `listMembers(agent)` |
| **只依赖四方法** | 假 teams 只有四方法 + 额外方法抛错 | 全部功能可用，说明没偷偷用别的 |
| api-notes 三点 | 读 `docs/api-notes.md` | ① inject 服务名（最终值 + 试错记录）② agent 对象来源（会话 id → 实例）③ teammate `id` 与 `session_id` 的对应关系；**每条都要有实测证据**（脚本/输出/日期），纯推测记不通过 |
| **唤醒协调者** | api-notes 里的探测记录 | 有「向 lead 发消息能否唤醒协调者自身会话」的结论与实验证据；不能唤醒时给出替代方案；只有结论没有证据 = 不通过 |
| **api-notes 第 4 点（R4）** | 读 `docs/api-notes.md` | 有「协调者工具集/白名单声明方式」的结论 + 实测证据；不能声明时给出结论与替代方案；只有推测 = 不通过 |
| **send 失败重试（R6）** | 假 teams 的 `sendMessage` 前 3 次抛错、第 4 次成功；另测 4 次全失败 | 重试 3 次、间隔 1s/2s/4s（注入 sleep 断言时序）；第 4 次成功即恢复；全失败时抛错不吞，总调用 4 次 |

## 7. Task 6 — 通知分级与合并（`src/notify.js`）

| 验收点 | 怎么验 | 判据 |
| --- | --- | --- |
| 级别映射 | `levelOf` 四状态 + 未知 | progress→silent、done→notify、blocked/needs_auth→interrupt、未知→silent |
| progress 静默 | push progress 后等窗口 | 0 次投递；不占 buffer（后续 done 文案里不出现该任务） |
| done 合并 | 窗口内 3 条 done | 只投 1 条，含「3 个任务完成」；单条时文案为「任务「X」完成：…」 |
| 合并窗口 | 窗口外第 2 条 done | 单独再投 1 条 |
| blocked/needs_auth 立即 | push 后不等窗口 | 立刻投递，文案含「需要你」；不阻塞/不取消已排队 done 的合并 |
| send 抛错 | `send` 抛错 | 走 onWarn（含原因），无 unhandled rejection，测试进程不挂 |
| drain | 窗口未到就 drain | 立即 flush 且只投一次；空 buffer 不投 |
| 交错顺序 | 先 done 排队、再 blocked、再 drain | blocked 先到，done 合并随后，无重复无丢失 |
| 定时器不泄漏 | 跑完测试进程 | 无残留 timer 导致 `node --test` 挂起；插件卸载后 drain 清 timer |
| **notifications 持久化（R2）** | 投递成功后查 notifications 表 | 每次成功投递写一行：`level` 正确、`status='delivered'`、`delivered_at` 非空；silent 不写行 |
| 合并 `merged_into` | 窗口内 3 条 done 合并投递 | 合并行 `merged_into` 指向该批次首条通知 id；被合并条不重复投递 |
| 失败行（R2） | send 抛错 | 写 `status='failed'`、`delivered_at=NULL`；onWarn 带原因；无 unhandled rejection |
| **发送者约束（平台限制）** | 读 api-notes §4 + 代码 | 通知必须由**回报的子任务** `exec.agent` 发（`notifier.push(item, { sender })` → `send(text, items)`）；没有 sender 时只 warn 不投递；用协调者 agent 自投会 `TEAM_SELF_MESSAGE`，判不通过 |

## 8. Task 7 — 工具集（`src/tools.js`）

先过 G5/G8，再逐工具：

| 工具 | 验收点 | 判据 |
| --- | --- | --- |
| `task_create` | 缺 acceptance | 返回含 `acceptance` 的可读提示；台账 0 条；spawn 未调用 |
| | 正常创建 | 台账 running + `session_id/target` 已写；spawn 入参 prompt = 渲染文本（G3）；返回含任务编号 |
| | 活跃上限 | 已有 8 条活跃时第 9 条被拒、文案含上限数、不建任务 |
| | **spawn 失败** | 返回可读「任务协调失败：…」；核对台账残留（可能留 pending 无 session）→ 记录为已知行为（阶段 1 无卡片 UI），不计 Task 失败 |
| `task_list` | 默认 | 只列活跃；空表「没有活跃任务。」；`active:false` 全量；空表「台账里还没有任何任务。」 |
| | 行格式 | 含 id、标题、中文状态、子会话名；8 状态中文名正确 |
| **stale 标记（R3）** | `last_event_at` 置 31 分钟前 / 29 分钟前，`staleMinutes=30` | 31 分钟行尾出现「⚠ 已 31 分钟无动静」；29 分钟不出现；只标记、状态不变；恰好 30 分钟按「超」判断 |
| `task_status` | 存在 | 标题、状态、子会话、最近消息（最多 3 条，各取首行） |
| | 不存在 | 文案含传入 id 且提示用 task_list |
| `task_message` | 正常 | 写 followup + 调 send；文案含子会话名 |
| | 无子会话 | 可读提示；不调 send |
| | 不存在 id | 可读提示 |
| | 终态任务 | done/cancelled 上续派的行为需明确（拒绝或允许），不能原生抛错 |
| **续派失败重试（R6）** | send 连失败（重试 3 次后仍失败） | 任务转 `waiting_user`、`error` 写失败原因、messages 有失败记录、工具返回可读文案；不整段抛异常；重复调用副作用可控 |
| `task_stop` | 正常 | 状态 cancelled + interrupt 调用一次；文案 |
| | 已结束 | 可读错误、状态不变、interrupt 不再调用 |
| `task_report` | 四状态 | progress 只 touch；done→done；blocked→waiting_user；needs_auth→waiting_auth；通知级别正确 |
| | **回报方发送** | `task_report` 必须把 `exec.agent` 作为 sender 传给 notifier；缺 sender 时通知降级为 warn，不抛 `TEAM_SELF_MESSAGE` |
| | 非法 status | 不写消息、不改状态、返回含可选值列表 |
| | 不存在 id | 可读提示，不写消息 |
| | 重复 done | 第二次可读错误（不允许迁移），不产生第二条 done 通知 |
| | 缺 summary | 不崩，摘要为空 |
| 错误包裹 | 任意工具底层抛错 | `任务协调失败：<原因>`，G6 |
| **并发 8 子任务（R7）** | 并行 8 个 create+report，用独立台账 | 台账 target/status 各归各，无串号；通知与回报不丢 |

## 9. Task 8 — 卡片数据（`src/card.js`）

| 验收点 | 怎么验 | 判据 |
| --- | --- | --- |
| 字段 | `taskCard(task,{summary})` | `taskId/title/status/label/tone/summary` 齐全 |
| 8 状态文案 | 逐一断言 | 待派发/进行中/等你确认/要授权/已完成/失败/已取消/会话丢失 |
| 色值 | 逐一断言 | pending muted、running info、waiting_* warn、done good、failed/orphaned bad、cancelled muted |
| 未知状态 | 伪造 `status:'weird'` | label 回落 status、tone 回落 muted，不崩 |
| 截断 | 81 字 / 恰好 80 / 空 | 81→80 字+「…」；80 不截；空串原样 |
| 自定义长度 | `maxLength:5` | 6 字→5+… |

## 10. Task 9 — 插件入口与装配（`index.js`、`cordis.patch.yml`）

| 验收点 | 怎么验 | 判据 |
| --- | --- | --- |
| name/inject | 导入 | `name='dsh-orchestrator'`；inject 含 `tools`/`agentTeams`/`agents`（与真实平台服务名核对，证据见 Task 5 api-notes） |
| 注册 | 假 ctx 调 apply | 6 个工具全部注册；`tools.register` 返回值被当作 disposer 使用（若使用） |
| **DSH_HOME 隔离** | 临时 DSH_HOME 调 apply + 建任务 | 只创建 `$DSH_HOME/state/orchestrator/tasks.sqlite`（+wal/shm）；无其他文件；未设置 DSH_HOME 时才落到 `~/.dsh` |
| 无 coordinatorSession | apply 后调用派活 | 日志有 warn；工具能注册；不抛；通知不投递（send 静默 return） |
| 卸载 | 触发 disposer | `db.close()` 不抛；未决通知被 drain；卸载后不再注册 |
| 重复 apply | 两次 apply | 不产生两个库文件冲突/锁死；资源可回收 |
| 入口文件正确 | `import('./index.js')` | 导出 `name/inject/apply`，无副作用（导入不建库） |
| cordis.patch.yml | 解析 | `insert` 里 `id: orchestrator`、`name: dsh-orchestrator`，与 package 名一致 |
| **真实注册模拟** | 用真实 `dsh-tools` 版本做内存注册（与审查交叉验证） | 6 个工具 schema 能被真实注册器接受；不存在平台不认的字段 |

## 11. Task 10 — README 与集成冒烟

| 验收点 | 怎么验 | 判据 |
| --- | --- | --- |
| README 内容 | 通读 | 定位、只写 `state/orchestrator`、配置项表（5 项与 `loadConfig` 一致）、6 工具清单、完整示例（建任务→回报→卡片→通知） |
| 示例准确性 | 按示例逐条执行（假 teams / 单测环境） | 文案、流程、字段与实际输出一致；不夸大（不写阶段 2 的 UI 能力） |
| 全量绿 | `npm test` | 0 fail |
| **已知局限（R1/R5/R7）** | 读 README | 有「已知局限（阶段 3 再做）」：快照生成与恢复、orphaned 重建、30 分钟打扰升级、工具白名单（未实现时）；不把阶段 3 项写成已实现 |
| 复用判定（R7） | README/工具说明 | 明说判定归协调者，task_list 提供标题、目标摘要、最近消息；阶段 1 无自动复用代码 |
| 冒烟记录（R8） | 归 Chief（装 profile 不归我）；我核对冒烟记录 | 子会话创建、回报入台账、done 通知出现在协调者会话；唤醒时序（忙时排队不丢）有证据 |
| 阶段面 | 文档 | 明确阶段 1 不含客户端；不把已知缺口写成已实现 |

---

## 12. 设计缺口与裁决（2026-11-13，`2689186`）

裁决原文见计划末尾「阶段 1 范围裁决（R1–R8）」。**按裁决执行，阶段 3 项不判 Task 失败**；开发提交若与裁决不符仍算不通过。

| # | 缺口 | 裁决（阶段 1 口径） | 复核落点 |
| --- | --- | --- | --- |
| R1 | 每日快照 + 损坏恢复 | 只做半件：打开损坏库转可读中文错误（含库路径与 snapshots 目录提示），不自动恢复、不写快照；快照生成/恢复阶段 3 | Task 4「损坏库」行 |
| R2 | notifications 表只建不写 | 阶段 1 做：每次投递（成功/失败）写一行；合并投递填 `merged_into` 指向首条；失败行 `delivered_at=NULL`、`status='failed'` | Task 6「notifications 持久化」组 |
| R3 | task_list 无 stale 标记 | 阶段 1 做：行尾标「⚠ 已 X 分钟无动静」（`last_event_at` 超 `staleMinutes`），只标记不自动升级 | Task 7「stale 标记」行 |
| R4 | 协调者工具白名单 | 先探测：api-notes 第 4 点（工具集/白名单声明方式 + 实测证据）；有低成本声明就实现最小白名单，没有则 README 记局限、阶段 3 | Task 5「api-notes 第 4 点」行 |
| R5 | orphaned 自动检测/重建 | 推迟阶段 3，README 记为已知局限 | Task 10「已知局限」行 |
| R6 | 投递失败三次重试后 blocked | 阶段 1 做，指 `task_message` 续派：send 失败重试 3 次（1s/2s/4s）→ messages 记失败行、任务转 `waiting_user`、`error` 写原因、返回可读文案 | Task 5「send 失败重试」、Task 7「续派失败重试」 |
| R7 | 并发 8 / 复用判定 / 30 分钟升级 | 拆开：并发 8 用例进阶段 1（纯测试）；复用判定不写代码（task_list 提供标题/目标摘要/最近消息）；30 分钟升级阶段 3 | Task 7「并发 8 子任务」、Task 10「复用判定」 |
| R8 | 唤醒协调者时序（忙时排队不丢） | 单测不覆盖；Chief 装 profile 冒烟时真机验；开发在 api-notes 给机制结论与证据 | Task 10「冒烟记录」、Task 5 api-notes 三点 |

各任务增量（复核时逐条对照计划）：

- **Task 4**：`openLedger` 打开失败 → `台账损坏：<路径>（可尝试从 snapshots 目录恢复）`；不含 `SQLITE_`/`at ` 堆栈。
- **Task 5**：api-notes 加第 4 点「协调者工具集/白名单声明方式」+ 实测证据；不能声明时写结论与替代方案。
- **Task 6**：投递成功/失败各写一行 notifications；合并投递 `merged_into` 指向首条；失败行 `delivered_at=NULL`、`status='failed'`。
- **Task 7**：`task_list` 行尾 stale 标记（31 分钟有、29 分钟无）；`task_message` send 重试 3 次后转 `waiting_user` 并写 `error`。
- **Task 10**：README「已知局限（阶段 3 再做）」：快照恢复、orphaned 重建、30 分钟打扰升级、工具白名单（未实现时）。

## 13. 我的独立补充测试（不依赖开发用例）

- 状态机 64 格全矩阵；非法迁移不落库。
- brief 特殊字符/花括号/超长/伪小节注入。
- 台账同毫秒排序、patch.error 清空语义、8 任务并发写、损坏库可读错误（R1）。
- 通知「send 抛错 + drain」「interrupt 与 done 合并交错」「timer 泄漏」「notifications 成功/失败/merged_into 落库」（R2）。
- tools 非法 status 不落库、重复 done、spawn 失败残留、stale 31/29 分钟边界（R3）、续派重试 3 次转 waiting_user（R6）、8 路并发派活（R7）。
- DSH_HOME 全目录审计（G4）与工具 schema 递归扫描（G5）。
- 这些脚本放 worktree 的 `qa/` 或临时目录，不进开发提交。

## 14. 结论记录

| 任务 | 提交 | 结论 | 证据 | 未过项/备注 |
| --- | --- | --- | --- | --- |
| Task 1 | 67a3669 | 通过 | 全量 50/50；独立探针 task1-config 全过（0/负/NaN/Infinity/字符串/null、不传参、未知键、空串） | 测试脚本多 `--disable-warning=ExperimentalWarning`（相对计划的小偏差，无害） |
| Task 2 | 11f04c2 | 通过 | 8×8 矩阵独立全对；终态无出边；未知状态不抛；错误文案含方向 | |
| Task 3 | cd26b06 | 通过 | 花括号/引号/伪小节/多行引用/10k 字/emoji/纯函数独立全过；渲染无 JSON 键名且不可 JSON.parse | |
| Task 4 | e52f858 | 通过 | 三表+WAL+幂等；同毫秒排序稳定；seq 连续；8×20 并发不串号；patch.error 可清空；损坏库文案含路径与 snapshots、无 SQLITE_/堆栈；落盘仅传入目录 | |
| Task 5 | 2f3c322 | 通过 | 四方法透传、重试总调用 4 次、惰性 agent 可读错误、prompt 无 JSON、slug 合法；api-probe 独立复跑 16/16 | 平台限制：协调者不能给自己发，通知须由回报子任务发（Task 6/7/9 按 api-notes §4 接线） |
| Task 6 | 5898843 | 通过 | 分级映射、progress 零投递、单条/3 条合并文案、merged_into 指向首条、失败行 delivered_at=NULL、落库、二次 drain 不重复、timer 不泄漏 | 最终发送函数在 index.js（Task 9），「无 sender 只 warn 不投递」留到 Task 9 验 |
| Task 7 | 3a5a979（+488257f） | 通过 | 6 工具对象根 schema 无 min/max、render 返回 text 数组；create 上限/spawn 失败留 pending+error；list stale 31/29；message 重试转 waiting_user+error+失败行；report 四态/非法 status 不落库/重复 done 不重复通知；8 路并发不串号；**等待态闭环**：blocked/needs_auth 续派回 running 清 error、waiting 直接 done、progress 从等待态恢复、failed 续派回 running | 重复回报会先写 report 消息再报错（可接受）；失败文案写死「已重试 3 次」（生产 dispatcher 恒有 sendReliable，无害） |
| Task 8 | f572730（+488257f） | 通过 | 8 状态文案/色值全对、未知状态回落、80/81/自定义 maxLength 截断边界、字段透传；emoji 边界按码点截断（80 个 emoji 不截、81→80+…、无半个代理对）；全量 100/100 | 无遗留 |
| Task 9 | a4d90e1/5a97216/652d593/488257f | 通过 | 6 工具注册；DSH_HOME 只落 `state/orchestrator/tasks.sqlite`(+wal/shm)；白名单按 `view(agent).restrictableNames` 求交集（与真实 `restrict()` 校验口径一致，对照 asar 确认）；scope 内工具（send_message）不喂 restrict、view 无该字段时退回 knownNames；通知由回报方 agent 发 target=lead、非自投；缺 sender/未配置协调者记 `skipped` 且 `delivered_at=NULL`；后加载补装；重复 apply 不崩；卸载关库 | 真机冒烟确认无白名单安装失败日志 |
| Task 10 | b7a307d/5a97216 | 通过 | README 落盘/配置表 5 项与 loadConfig 一致/6 工具/完整示例/错误降级/已知局限（R1/R5/R7）齐全；集成冒烟测试真实执行；全量 93/93（终版 94/94） | 真机冒烟（装 profile、子会话创建、done 通知进协调者、忙时排队、白名单无失败日志）归 Chief，R8 凭冒烟证据关闭 |

**总评（2026-11-13，最终 HEAD `488257f`，100/100）**：Task 1–10 全部通过，阶段 1 可交付；此前的 2 个低危项（emoji 截断、缺 sender 误记 delivered）已修复并复验关闭。仅剩 R8 唤醒时序与白名单真实安装由 Chief 真机冒烟关闭。
| Task 6 | | | | |
| Task 7 | | | | |
| Task 8 | | | | |
| Task 9 | | | | |
| Task 10 | | | | |
