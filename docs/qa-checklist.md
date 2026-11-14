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
| G4 | **台账/日志只写 `$DSH_HOME/state/orchestrator`** | 临时 `DSH_HOME` 跑「建任务→回报→停止」；`Get-ChildItem -Recurse` 审计整个临时 home 与仓库 | 临时 home 下除 `state/orchestrator/` 外零新增；其中允许 `tasks.sqlite(+wal/shm)` 与 `logs/orchestrator-YYYY-MM-DD.jsonl`（`logs/` 仍算合规），不得有其他文件；仓库内无 sqlite/wal/shm；`~/.dsh` 真实目录不被写（DSH_HOME 覆盖时） |
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
| **全迁移矩阵** | 我自己生成 8×8 全组合断言（不只计划里的样例） | 只有 `pending→running/failed/cancelled`（`pending→failed` 为设计 `7413a2b` 新增，供 spawn 失败收尾）、`running→waiting_user/waiting_auth/done/failed/cancelled/orphaned`、`waiting_user→running/cancelled/failed`、`waiting_auth→running/cancelled/failed`、`failed→running/cancelled`、`orphaned→pending/cancelled` 为 true，其余 false |
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
| Task 1 | 67a3669 | 通过 | 全量 50/50；独立探针 task1-config 全过（0/负/NaN/Infinity/字符串/null、不传参、未知键、空串）；配置 6 键含 `spawnProvider`（默认 `spawn`、空白/非法回落、去空格） | 测试脚本多 `--disable-warning=ExperimentalWarning`（相对计划的小偏差，无害） |
| Task 2 | 11f04c2 | 通过 | 8×8 矩阵独立全对；终态无出边；未知状态不抛；错误文案含方向 | |
| Task 3 | cd26b06 | 通过 | 花括号/引号/伪小节/多行引用/10k 字/emoji/纯函数独立全过；渲染无 JSON 键名且不可 JSON.parse | |
| Task 4 | e52f858（+15464b7） | 通过 | 三表+WAL+幂等；同毫秒排序稳定；seq 连续；8×20 并发不串号；patch.error 可清空；损坏库「台账损坏」含路径与 snapshots、无 SQLITE_/堆栈；**错误分流**：ENOTDIR 报「台账不可用：<路径>：<原因>」不再误报损坏；落盘仅传入目录 | busy（errcode 5/6）文案存在，本机无法自然触发，代码审查确认 |
| Task 5 | 2f3c322 | 通过 | 四方法透传、重试总调用 4 次、惰性 agent 可读错误、prompt 无 JSON、slug 合法；api-probe 独立复跑 16/16 | 平台限制：协调者不能给自己发，通知须由回报子任务发（Task 6/7/9 按 api-notes §4 接线） |
| Task 6 | 5898843 | 通过 | 分级映射、progress 零投递、单条/3 条合并文案、merged_into 指向首条、失败行 delivered_at=NULL、落库、二次 drain 不重复、timer 不泄漏；**sender 离 roster**（membership/sendAdmitted 抛 TEAM_NOT_MEMBER）→ failed+delivered_at=NULL+可读 warn、不崩、无 unhandled | 真机已复现：done 在 5s 合并窗口后 sender 已离 roster，`TEAM_NOT_MEMBER`；「谁回报谁发 + 5s 合并」与 fresh teammate 生命周期冲突（设计层），修复后复验 |
| Task 7 | 3a5a979（+488257f/+15464b7） | 通过 | 6 工具对象根 schema 无 min/max、render 返回 text 数组；create 上限/spawn 失败留 pending+error；list stale 31/29；message 重试转 waiting_user+error+失败行；report 四态/非法 status 不落库/重复 done 不重复通知；8 路并发不串号；**等待态闭环**：blocked/needs_auth 续派回 running 清 error、waiting 直接 done、progress 从等待态恢复、failed 续派回 running；**回报归属**：exec.agent 与 task.session_id 不符 → 可读拒绝、不落库不通知 | 真机联调未过项已由 B 修复并冒烟通过；重复回报会先写 report 消息再报错（可接受）；pending 任务 session_id 为空时不校验归属（阶段 2 可收紧） |
| Task 8 | f572730（+488257f） | 通过 | 8 状态文案/色值全对、未知状态回落、80/81/自定义 maxLength 截断边界、字段透传；emoji 边界按码点截断（80 个 emoji 不截、81→80+…、无半个代理对）；全量 100/100 | 无遗留 |
| Task 9 | a4d90e1/5a97216/652d593/488257f/15464b7 | 通过 | 6 工具注册；DSH_HOME 只落 `state/orchestrator/tasks.sqlite`(+wal/shm)；白名单按 `view(agent).restrictableNames` 求交集（与真实 `restrict()` 校验口径一致，对照 asar 确认）；scope 内工具（send_message）不喂 restrict、view 无该字段时退回 knownNames；通知由回报方 agent 发 target=lead、非自投；缺 sender/未配置协调者记 `skipped` 且 `delivered_at=NULL`；后加载补装；重复 apply 不崩；卸载 `await notifier.flushNow()` 后再 close | 白名单缺口：`spawn_teammate/send_message/list_agents` 不在 `restrictableNames`，deny 不掉（真机 34→21，其余生效），阶段 3 用 `composition.toolFilter` |
| Task 10 | b7a307d/5a97216 | 通过 | README 落盘/配置表 5 项与 loadConfig 一致/6 工具/完整示例/错误降级/已知局限（R1/R5/R7）齐全；集成冒烟测试真实执行；全量 93/93（终版 100/100） | 真机冒烟：派活/渲染/回报/blocked 即时/R8/白名单主项通过；done 通知未通（`TEAM_NOT_MEMBER`，平台自动结语兜底）→ 修复后复验 |

**总评（2026-11-13，最终 HEAD `ceb9516`，108/108）**：Task 1–10 代码级全过；B 通知方案经进程内探针 + Chief 真机冒烟双验证通过；三条硬化（台账错误分流、回报归属、卸载 `await flushNow()`）复验通过；F 轮「收尾期 initiator disposed」定位为进程级收尾竞态，`failed`+reason 属正确审计。测试侧最终验收通过。白名单 3 个团队控制工具 deny 不掉留阶段 3，平台 settlement 与插件通知的用户体感重复留阶段 2（均已在 README/裁决中记录）。

**真机冒烟复核（`3be1b99`，问题定位；已由 `8956d89` 修复）**：通——插件加载、`task_create` 真派子会话并跑模型回合、brief 进子会话、回报入台账、blocked 即时通知在协调者回合中插入（R8）、白名单真实生效（协调者工具 34→21，read/write/pwsh/glob/grep/skill/web_search/web_fetch/task_report 移除）。不通——done 通知行 `failed`，根因 `TEAM_NOT_MEMBER`：fresh 子任务回报完回合即结束，5s 合并窗口后 sender 已离 roster；窗口设 0 同样失败（发送发生在子会话回合结束之后）。测试侧已按两种失败点（membership 抛 / sendAdmitted 抛）在进程内构造：均记 `failed`+`delivered_at=NULL`+可读 warn、不崩，证明是时序/生命周期问题而非落库丢失。

**真机冒烟复核（`8956d89`，B 修复后，通过）**：`notifications` 里 `t-ceb5740c` 为 `delivered`、`delivered_at` 有值、`reason` 空；协调者会话日志收到插件注入的 `任务「冒烟任务E」完成：冒烟E完成`（source `agent-message`/`relay`，sender 是子会话），且是在协调者回合进行中排队、下一步边界交付（R8 忙时也过）；5 秒窗口后 sender 已离队仍送达；进程退出后行仍在（卸载不丢）；平台 settlement 与插件通知两条链路并存，README 已分开写，用户体感重复留阶段 2。

**真机冒烟复核（F 轮，`15464b7`）**：归属校验未误伤——子会话 `f-1` 正常回报 done，`t-16a2bd7e` 已完成；但该轮 done 通知 `failed`、reason「agent initiator scope is disposed」：消息已 splice 进协调者 `next-step`（seq 101 有注入记录）但没有回合消费，属 headless 收尾竞态（见 §15 第 7 条），`failed`+reason 为正确审计；`ceb9516` 已把定位写进 api-notes §6 与 README 已知局限。

**B 方向可行性（供 A/B 决策）**：真实 `agent.steer(input)` 是公开方法，走 `send(input,'next-step',true)` → inbox 排队 + `wakeDriver`，**不经过 Team roster 校验**（`sendAdmitted` 的 membership 检查在 agentTeams 层）；但 `createUserMessage` 是包内内部函数，B 需自行构造合法 user message（`{ id, role:'user', content, source }`，见 `createMessage` 内部实现：`brandString(randomUUID())` + `role/description`），`source.kind` 能否被会话日志接受必须实测。另卸载竞态仍待修：`index.js:118-119` 先 `void notifier.drain()` 再 `db.close()`，窗口内 done 通知已发出但落库报 `database is not open`（sent=1/rows=0），建议 async disposer 先 `await drain()` 再 close。

## 15. B 方案复验清单（等待开发提交后执行）

Chief 拍板走 B：直插协调者会话、保住 5 秒合并；两道护栏（steer 入参/唤醒/忙时排队实测证据写进 api-notes 与探针；README 分清「插件通知」与「平台 settlement 通知」两条链路）。复验必须覆盖：

1. **B 投递成功**：done 在 5 秒窗口后仍 `delivered`（发送方是协调者 live agent，不依赖回报子会话 roster）；窗口内多条 done 合并后只投 1 条。
2. **入参契约**：`agent.steer` 收到的消息结构合法（`id/role/content/source`），会话日志能正常记录、不报 unknown source / 校验错误；证据写进 api-notes + 探针。
3. **忙时排队**：协调者回合进行中投递 → 在下一步边界插入、不丢、不打断当前步骤（真机由 Chief 冒烟，进程内验调用序列）。
4. **两条链路不重复计**：平台 settlement 通知不经过 notifier、不写行、不计入插件投递；插件 done 写且只写 1 行；`notifications` 行数 = 插件实际投递尝试数，不与平台消息相加。
5. **卸载不丢行**：`await notifier.drain()` 后再 `db.close()`；窗口内 done 卸载场景 `sent=1 / rows=1`（现为 sent=1/rows=0，作为回归必须翻绿）。
6. **顺带收口**：failed 行带失败原因（建议 #4）、`provider` 走 config（建议 #6）；sender 离 roster 用例保留（B 下应不再触发 membership，但回归仍要断言）。

**复验结果（2026-11-13，HEAD `8956d89`，105/105；真机冒烟同时通过）**：

| # | 结果 | 证据 |
| --- | --- | --- |
| 1 | 通过 | 窗口后协调者 `steer` 1 次，done 行 `delivered`+`delivered_at`；窗口内多条合并后只投 1 条 |
| 2 | 通过 | 注入消息 `{id, role:'user', content:[text], source:{kind:'agent-message', form:'relay', senderSessionId}}`；asar 确认 `AgentMessageSource` 类型一致、`brandString` 是恒等函数（`randomUUID` 合法）；api-probe 独立复跑 24/24 |
| 3 | 通过 | 真实忙时排队由 Chief 冒烟：协调者回合中注入、下一步边界交付（R8 过） |
| 4 | 通过 | 插件只走 steer（0 次 `sendMessage`、0 次 `membership`），`notifications` 行数 = 注入次数；平台 settlement 不写行（api-notes §6） |
| 5 | 通过 | 窗口内卸载：sent=1 / rows=1、`delivered_at` 非空；DSH_HOME 只含 orchestrator 库（回归由红转绿） |
| 6 | 通过 | `spawnProvider` 走 config（默认 `spawn`、空白/非法回落、去空格）✓；旧库自动补 `reason` ✓；`steer` 抛错记 `failed`+`reason`、`delivered_at=NULL`、可读 warn ✓（`642eba0`） |

**审计归类缺口已关闭（`642eba0`）**：`index.js` 注入失败不再吞成 `false`，异常交给 notifier 记 `failed`+`reason`；「steer 抛错」独立探针复跑通过，§15 六项全绿。

7. **收尾期 disposed（F 轮真机，`ceb9516`）**：headless 一次性进程在 `mergeWindowMs` 内退出时，`steer` 可能抛 `agent initiator scope is disposed`。测试侧独立对照 asar 确认：这是**进程级 `AgentRegistry` 的 initiator 作用域**（`wakeDriver` 走 `loopCtx.agents.withInitiator(this, () => this.kick())`，`runWithInitiator` 在 `initiatorState !== 'active'` 时抛），不是 sender 子会话 scope、也不是协调者 scope。`steer` 先 splice 再唤醒，所以现象是「inbox 有注入、无回合消费、行 failed+reason」——属正确审计，不判 Task 失败。冒烟前置：最后一条回报后进程需活过 `mergeWindowMs` 才看得到 `delivered`；长驻 desktop 不受影响（README 已知局限）。

## 16. 协调者自动绑定验收（新增，待开发提交）

背景：插件要给别人用，不能手填 `coordinatorSession`。解析顺序 `config.coordinatorSession`（显式覆盖）→ `settings.coordinator_session_id`（台账绑定）→ 未绑定；首次 `task_create` 把调用方会话绑为协调者并落库。

| # | 验收点 | 怎么验 | 判据 |
| --- | --- | --- | --- |
| 1 | 无配置首次绑定 | 临时 DSH_HOME、无 config；会话 A `task_create` | `settings` 出现 `coordinator_session_id=A.id`；有日志一行；任务行 `coordinator_session` 与绑定一致 |
| 2 | 二次不重绑 | 会话 B 紧接着 `task_create` | 绑定仍为 A、settings 不变、白名单不重复装 |
| 3 | 只读工具不绑定 | 未绑定时带 exec.agent 调 `task_list`/`task_status` | settings 无绑定行、不装白名单 |
| 4 | 配置覆盖优先且不写库 | config 有值 + settings 空/不同 | `task_create` 用 config；settings 不被写；通知发 config 会话 |
| 5 | 绑定持久化 | 关闭后重开台账再解析 | 仍解析到 A；重启后 `task_create` 不重绑 |
| 6 | 失效提示 | 绑定/配置会话无 live agent 时 `task_create` 与 `task_report` | 通知行 `skipped`（`delivered_at=NULL`）；结果含「会话已失效…重新绑定」类可读提示；不抛异常 |
| 7 | 绑定时白名单 | 绑定后查绑定 agent 的 `restrict` 调用 | 绑定会话被 deny 一次；子任务 agent 不收窄；重复不重复装 |
| 8 | 并发首次 | 未绑定时 8 个不同会话同时 `task_create` | 只产生一个绑定（规则明确、不振荡）；所有任务指向同一协调者 |
| 9 | 旧库迁移 | 旧库无 `settings` 表 | `openLedger` 自动建表；旧任务仍可读 |
| 10 | 未绑定时其他写工具 | `task_message`/`task_stop` 带 exec.agent 且未绑定 | 行为明确：不绑定；可读提示或按既有逻辑执行，不能静默半执行 |

**待明确（需拍板后写死判据）**：

- a. 并发首次绑定规则：建议先到先得（`UPDATE ... WHERE value IS NULL` 或唯一键），不接受后写覆盖。
- b. 失效后「在新会话里派任务重新绑定」是自动重绑还是仅提示？两种实现与文案不同。
- c. 任务行 `coordinator_session` 是否一律写绑定的协调者 id（不同会话后来派的任务也写它），建议是。

**复验结果（2026-11-13，HEAD `f6a1c7a`，123/123；api-probe 27/27）**：

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 1–2 首绑/不重绑 | 通过 | settings=调用方；第二会话不重绑；任务行写绑定 id；日志一行；白名单只装一次；`bindSettingOnce` 实测先到先得（A 写入后 B 不覆盖） |
| 3 只读不绑 | 通过 | `task_list`/`task_status` 后 settings 仍空、不装白名单 |
| 4 配置覆盖 | 通过 | settings 不写、任务行写 config、config 会话被收窄、调用方不收窄 |
| 5 持久化 | 通过 | 重开台账/重新 apply 后仍用绑定；B 调用不重绑；绑定会话补装白名单 |
| 6 失效 | 通过 | 通知 `skipped`+reason+结果提示；root 重绑走 CAS；子会话重绑被拒（settings 不变） |
| 7 白名单 | 通过 | 绑定会话 deny 一次；调用方/子会话 `restrictions=0`；重复不重复装 |
| 8 并发 | 通过 | 8 路并发只产生一个绑定；`bindSettingOnce` = `ON CONFLICT DO NOTHING` + 回读，后到不覆盖 |
| 9 旧库迁移 | 通过 | 自动建 `settings` 表并可读写 |
| 10 未绑定其他写工具 | 通过 | `task_message`/`task_stop` 返回「尚未绑定协调者，请先 task_create」，不写 followup、不投递、不重试、不改状态 |

**四条口径已关闭（`f6a1c7a`）**：

1. **原子首绑**：`bindSettingOnce`（DO NOTHING + 回读）实测幂等先到先得；失效重绑 `rebindSetting` 走 `WHERE value = 旧值` CAS，旧值不符不动。
2. **root/lead 校验**：带 `parentSession` 的子会话首绑被拒（不建任务、不套白名单）、失效重绑被拒（settings 不变）。
3. **未绑定提示**：`task_message`/`task_stop` 只回提示，followup 0 条、`sendMessage` 0 次、状态不变。
4. **重绑提示**：`task_create` 结果含「协调者会话已变更：旧 → 新」，日志区分首绑/重绑。

**结论**：§16 十条全部通过 @ `f6a1c7a`；白名单真机「子会话工具数」由 Chief 冒烟复核（进程内已证 restrict 只落在绑定 agent）。

## 17. P0：协调者阻塞等待（`wait_agent`）

线上事故：协调者建完任务后调 `wait_agent` 阻塞 5 分 46 秒，用户无法发消息。`COORDINATOR_DENY` 里写了 `wait_agent` 但没生效。

**测试侧独立 asar 复核（结论：`restrict` 拦不住，非配置错误）**：

- Team 工具由 `install(agent, ctx, config)` 用 `const scoped = agent.ctx` 注册在**成员 agent 自己的作用域**（`scoped.tools.register(defineTool({ name: 'wait_agent', … }))`，asar @104105518；`spawn_teammate` @104102857 同处）。
- `restrict()` 校验/遮罩的集合是 `view(scope).restrictableNames`（asar @122952256），即**全局**工具名；scope 内注册的工具不在其中，也不会被 mask。所以 `COORDINATOR_DENY ∩ restrictableNames` 会静默过滤掉 `wait_agent`、`spawn_teammate`、`send_message`、`list_agents`、`interrupt_agent`、`team_task_*` 这一整类。
- 平台还通过 `team:policy` 系统提示（同一 `install` 里注册）告诉 Lead「The Lead must wait for required teammates before giving the final answer」，因此只加一句禁令容易被 policy 盖过，必须显式声明优先级。
- **更硬的拦截手段（建议开发采用）**：`agent.ctx.tools.guard(guard)` 注册**单调拒绝**（asar @122960454），`checkGuards(exec)` 在 dispatch 前按 `exec.agent` 的 scope 链求值，guard 返回 reason 即拒绝，且没有更晚的监听器能翻转。`ToolExecution` 有 `name` 字段，可 `exec.name === 'wait_agent'` 精确拒。绑定时给协调者 agent 装 guard，**同一回合后续的工具调用就会生效**（guard 在执行期读取），比只能下一回合生效的系统提示更硬。

**验收点（dev HEAD 后执行）**：

| # | 验收点 | 怎么验 | 判据 |
| --- | --- | --- | --- |
| 1 | restrict 拦不住的证据 | api-notes/探针引用上面的注册与 `restrictableNames` 事实 | 不把 `wait_agent` 记成「已 deny」，明确列为 scope-local 一类 |
| 2 | 系统提示禁令 | 假 ctx 捕获 `systemPrompt.context` 回调，分别以绑定协调者/非协调者会话 id 渲染 | 协调者文本含：禁止 `wait_agent`/任何阻塞等待、进度只用 `task_list`/`task_status`、子任务完成会主动通知、需要等就结束本回合；非协调者无此段 |
| 3 | 不串会话 | A 绑定 → A 有禁令；B 会话渲染无禁令；重绑后旧会话无、新会话有 | 按会话 id 动态渲染，无全局串扰 |
| 4 | 非协调者不受影响 | 非协调者会话调 `wait_agent` | 照常可用（工具未被遮罩/未被 guard） |
| 5 | 硬拦截（若采用 guard） | 假 agent 捕获 `tools.guard`；`{name:'wait_agent'}` → reason，`{name:'task_list'}` → undefined；绑定时装、卸载/重绑撤销；子任务 agent 无 guard | 返回可读中文 reason；只作用于绑定 agent |
| 6 | 惰性绑定首回合时序 | 文档 + 代码路径核对 | 写清：系统提示下一回合生效；guard 从同回合后续步骤生效；绑定那一步本身已装配的工具表无法回滚 |
| 7 | 降级 | 无 `systemPrompt` 服务时 apply | 可读 warn、不崩；guard 路径（若有）仍生效 |

**复验结果（2026-11-13，HEAD `ef99e1f`，127/127；api-probe 独立复跑 33/33）**：

| # | 结果 | 证据 |
| --- | --- | --- |
| 1 | 通过 | api-notes §5/§8 锁定 `wait_agent` 为 agent scope 注册；api-probe 新增「scope 内注册只进 knownNames / restrictableNames 只收全局工具」机制检查，我独立复跑 33/33；与我的 asar 直读一致，deny 不掉属结构事实，不是配置错 |
| 2 | 通过 | `inject` 含 `systemPrompt`；context 注册 `order:130`（数字）、`interpolate:false`；绑定后文本含「禁止使用 wait_agent」「task_list / task_status」「主动通知」「结束回合」全文，并显式声明「优先于平台默认的 Team Lead 等待要求 / 平台 team policy 的 “The Lead must wait…”」（`ef99e1f`） |
| 3 | 通过 | 协调者/普通会话/子会话三路渲染隔离；重绑后 prompt 跟着新协调者、旧会话恢复空串；config 覆盖只给配置会话 |
| 4 | 通过 | 普通会话与子会话的 `wait_agent` guard 返回 undefined（不拒），工具面未被遮罩 |
| 5 | 通过 | guard 只拒 `exec.name==='wait_agent' && exec.agent.id===协调者`，返回中文原因；`task_list` 不拒；重绑后随新协调者、卸载撤销；绑定写入后同回合顺序调用即被拒 |
| 6 | 通过（文档） | api-notes §8 写清 step N+1 带提示、guard 同回合顺序生效、并行且在绑定前开始的调用仍可能漏、「首绑回合绝对安全」不承诺 |
| 7 | 通过 | 缺 `systemPrompt` → 可读 warn、guard 仍安装、6 工具照常；缺 `tools` 服务 → 先 warn 再走原失败路径（真实平台 `inject` 保证服务存在，不误报） |

**结论**：P0 两层防护（动态 prompt + 执行期 guard）通过；`wait_agent` 仍在工具表里是平台作用域注册的已知限制，阶段 2 用 `composition.toolFilter` 根治。**最终收口（`ef99e1f`，127/127）**：优先级声明与缺服务告警补齐，p0 探针 + 全量回归（13 个探针）全绿，P0 关闭。

### P0 v2：运行期收窄延到回合边界（`b98922c`）

线上 `unknown tool "pwsh"`：绑定发生在回合中，`restrict` 即时生效，模型手里还是旧工具表。修法：`scheduleRestriction` 在协调者 `status === 'running'` 时只挂 pending，监听 `agent/status` 的 `idle` 再装；不用 `pre-step`/`assemble`（平台 `tools.resolve()` 先于 `systemPrompt.assemble()`，在那两处收窄是同一个错位）。

| 验收点 | 结果 | 证据 |
| --- | --- | --- |
| ① 绑定回合工具集不变 | 通过 | running 绑定时 `restrict` 调用 0 次；`running` 状态事件不触发收窄；guard 同回合仍可拒 `wait_agent`（不依赖工具表） |
| ② 下一回合才生效 | 通过 | `idle` 事件后恰好装 1 次、重复 idle 不重复；下一回合可见工具 = 全量 − deny；config 覆盖且 running 时同样延后 |
| ③ 提示点名 wait_agent | 通过 | prompt 含「wait_agent」点名禁令、`task_list`/`task_status`、主动通知、结束回合、优先于 team:policy |
| ④ 非协调者不受影响 | 通过 | 普通会话/子会话 `restrict` 0 次、prompt 空串、guard 放行；协调者后加载补装不受影响 |
| 降级 | 通过 | 缺 `tools.guard` 现在有可读 warn（审查建议闭环）；缺 `systemPrompt` warn 且 guard 仍装；缺 `tools` 先 warn |

**P0 v2 结论**：`b98922c`（文档 `9fb92ae`）复验通过，129/129、api-probe 33/33、13 个独立探针全绿；首绑回合不再有中途收窄，**需重启 DSH 换上新构建后真机复跑**。残留极端：pending 期间绑定若变更（只在原协调者已死时发生）会晚装到旧 agent，实际不可达，留代码审阅。

## 18. 并发额度口径（`maxActive`）— **已被 §24 取代：`maxActive` 废弃，改 `maxQueue` 安全阀**

背景：等待态（`waiting_user`/`waiting_auth`）被算进 `maxActive`，卡在等用户决定的任务占死名额，新建不了。修法：额度只算 `pending` + `running`；`task_list` 的 `active` 语义不变。

| # | 验收点 | 怎么验 | 判据 |
| --- | --- | --- | --- |
| 1 | 等待态不占额度 | 8 条 `waiting_user` 后第 9 个 `task_create` | 创建成功；额度只算 0 占用 |
| 2 | 运行态占额度 | 8 条 `running` 后第 9 个 | 拒绝；不写 tasks/messages 行 |
| 3 | 终态不计入 | 各 8 条 `done`/`cancelled`/`failed`/`orphaned` + 新建 | 全部允许 |
| 4 | 混合只算运行态 | 4 `running` + 4 `waiting_user`，继续建 | 还能建 4 条 `running`，第 5 条被拒（running 达 8） |
| 5 | `pending` 计入 | 1 `pending`（spawn 失败残留）+ 7 `running` | 第 9 个被拒，占用清单含 `pending` 行 |
| 6 | 拒绝文案 | 命中上限的返回 | 列出占用任务 `id｜标题｜状态`，数量恰好 = pending+running 集合（不列等待态），含「先 `task_stop` 或等结束」提示 |
| 7 | list 语义不变 | `task_list` 默认 | 仍列出 `waiting_user`/`waiting_auth` 任务 |
| 8 | 集合分离 | 代码复核 + 行为 | 额度集合与列表集合是两个不同查询/常量，不为省事合并 |
| 9 | 并发不超发 | 8 个并行 `task_create` | 成功数 ≤ `maxActive`，其余拒绝且不建行 |

**复验结果（2026-11-13，`f02bd10`+`60d8ef9`，133/133）**：

| # | 结果 | 证据 |
| --- | --- | --- |
| 1 | 通过 | 8 条 `waiting_user` 后第 9 个创建成功并落库；quota 只含新的 1 条 |
| 2 | 通过 | 8 `running` 后拒绝；文案列 8 条 `id｜标题｜进行中`、含「先 task_stop 或等它们结束」；不写 tasks/messages 行 |
| 3 | 通过 | `done`/`cancelled`/`failed`/`orphaned` 各 8 条后仍可建 |
| 4 | 通过 | 4 running + 4 waiting_user → 再建 4 条 running 成功；第 9 条 running 被拒，占用清单不列等待态；`task_list` 仍列等待态（12 条 active） |
| 5 | 通过 | 1 `pending`（spawn 失败残留）+ 7 running → 被拒；占用清单含 pending 行与「待派发」 |
| 6 | 通过 | 占用清单数量/内容恰好等于 quota 集合，中文状态正确 |
| 7 | 通过 | `task_list(active:true)` 仍含 `waiting_user`；`task_stop` 后额度立即释放（新建立即可成功） |
| 8 | 通过 | `listQuotaTasks` 只 `pending`+`running`，`listTasks(active)` 语义未动，行为验证集合分离 |
| 9 | 通过（`60d8ef9`） | 首次复验 12 并发全部成功（quota 检查在 `await bind()` 前）。修后：`bind()` 提前、额度检查与 `createTask` 同一同步段（中间无 await），12 并发 → 成功 8 / 拒绝 4、台账恰好 8 条，不超发 |

## 19. 幽灵任务 / 幂等去重 / 启动清理

背景：`task_create` 先 `createTask` 落库、再 `dispatcher.spawn`；spawn 抛错（平台成员上限、会话创建失败）不回滚，台账留下无 `session_id` 的 `pending` 幽灵（用户侧 `t-c84fbb2c`、`t-b228e7f8`），成员空出后可能重复派发、两份报告打架。

| # | 验收点 | 怎么验 | 判据 |
| --- | --- | --- | --- |
| 1 | spawn 失败收尾 | fake dispatcher `spawn` 抛错 | 返回可读中文（含原因与任务 id）；任务 `failed` + `error` 记录；不存在无 `session_id` 的 `pending`；`task_list(active)` 不含它 |
| 2 | 幂等去重 | 同 `title`+`goal`（trim 后）且状态**活跃**（`pending/running/waiting_user/waiting_auth`）的任务已存在，再 `task_create` | 返回「已存在任务 X，未重复创建」+ 任务 id/状态；不 spawn；台账仍一条；不占额度 |
| 3 | 去重键精确 | title 同/ goal 不同；goal 同/ title 不同；title/goal 仅首尾空格差异 | 前两种新建；仅空格差异视为同一条（trim 归一） |
| 4 | done 不误判 | 已 `done` 的同 `title`+`goal` 任务存在，再创建 | 允许，生成新任务（新 id） |
| 5 | 终态不误判 | `cancelled`/`failed`/`orphaned` 同目标存在 | 允许新建 |
| 6 | 启动清理 | 预置 `pending` 无 `session_id` 且 `created_at` 早于 `staleMinutes` → `apply` | 变 `failed` + 原因「派发中断」；未超时 pending 不动；running/waiting/终态不动；只通过 `UPDATE` 直改、记录清理条数 |
| 7 | 清理幂等 | 连续两次 `apply` | 不重复改状态、不误伤其他行 |
| 8 | 清理范围 | 有 `session_id` 的 pending / 近期 pending | 不动（或按明确文档口径） |
| 9 | 并发同目标 | 两个并发 `task_create` 同 `title`+`goal` | 只产生一条，另一次返回已存在；不重复 spawn |
| 10 | 与额度交互 | 满额时同目标重复创建 / 不同目标新建 | 同目标应识别为已有任务（不新建）；不同目标按额度拒绝 |
| 11 | spawn 失败走新边 | `pending→failed` 状态迁移 | 设计 `7413a2b` 已加该边；spawn 失败可合法迁到 `failed`（不再留 ghost pending）；`pending` 其余非法边不变 |

## 20. 协调者「不得凭记忆推断」硬规则（系统提示）

背景：协调者没派过 subagent，却断言「和我用 subagent 派的 Rust 审查是同一件事」并据此停了任务——凭记忆推断，不是工具返回。

| # | 验收点 | 怎么验 | 判据 |
| --- | --- | --- | --- |
| 1 | 规则在 prompt 里 | 绑定协调者后渲染 `systemPrompt.context` | 文本明确：任何任务数量/重复/冲突/状态断言，必须先调 `task_list`/`task_status` 拿到返回；不得凭记忆推断 |
| 2 | 三路隔离 | 协调者/普通会话/子会话 | 只有协调者带该段；重绑后跟随 |
| 3 | 与既有禁令共存 | 同一段 prompt | `wait_agent` 禁令、进度方式、结束回合、优先于 team policy 仍在 |

## 21. 结构化日志（排查用）

| # | 验收点 | 怎么验 | 判据 |
| --- | --- | --- | --- |
| 1 | 路径与命名 | 触发事件后查目录 | `$DSH_HOME/state/orchestrator/logs/orchestrator-YYYY-MM-DD.jsonl`，每天一个 |
| 2 | 保留 7 天 | 预置 8 天前的 `orchestrator-*.jsonl` | apply 后旧文件被清理，7 天内保留 |
| 3 | 单文件 5MB 换新 | 预置一个 >5MB 的当天日志 | 新事件不追加到超限文件，另起新文件且不崩 |
| 4 | 行格式 | 逐行 `JSON.parse` | `{ at, event, taskId?, sessionId?, agentId?, detail }`；缺字段不能是坏 JSON |
| 5 | 不写全文 | 用超长 goal（>80 字）和唯一 `user_verbatim` 触发事件 | 日志中 goal/摘要截断 ≤80；完整 `user_verbatim` 字符串不出现 |
| 6 | 事件覆盖 | 跑 create/重复/rejected/spawn 失败/report/notify 三种/cleanup/bind | 对应事件都有：`task.create.requested|created|rejected`、`task.spawn.requested|ok|failed`、`task.report`、`notify.delivered|failed|skipped`、`cleanup.pending`、`bind.coordinator`；带 `callId` 可把同一次调用串成线；`rejected` 带 reason 码（validation/limit/duplicate）+ `maxActive` + 占额 `id+status`（duplicate 带 existing `taskId+status`）；`spawn.failed` 带 taskId、平台错误原文、provider；`notify.*` 带 taskId、level、reason、sender session id、coordinator id；`cleanup.pending` 列被清 task ids；`bind.coordinator` 记 old → new |
| 7 | 写失败不影响主流程 | 让 logs 路径不可写（用文件占位/只读），再跑 `task_create` | 主流程成功；只 warn 一次；不抛错、不阻塞 |
| 8 | README | 文档 | 写清日志路径、保留策略、5MB 换新、「排查请附当天日志」 |
| 9 | 排查价值（审查主验） | 用日志还原：一次 create 被拒原因、一次 spawn 失败原文、一次通知 skipped 原因 | 三条都能仅凭当天日志还原 |

## 22. 槽位复用（行为变更）— **已撤销（2026-11-13，改 §23 协调者轮换）**

背景（已核实）：平台 Team 名册不可变、`maxMembers` 硬上限 8、无移除成员 API（`TEAM_MEMBER_LIMIT`）。「一个任务一个子会话」最多 8 个，必须改为槽位复用。**用户改选「满 8 自动新开协调者会话」（§23），本方案废弃；若已有提交需记录并撤销。**

| # | 验收点 | 怎么验 | 判据 |
| --- | --- | --- | --- |
| 1 | slots 表与迁移 | 旧库（无 slots）打开 | 自动建表；字段 `id/target/member_id/session_id/status/current_task_id/created_at` 齐全 |
| 2 | `maxSlots` 配置 | 默认/1/8/0/-1/9/字符串 | 默认 3；1 与 8 生效；非法值有明确回落（0/-1/9/字符串 → 期望回落默认或夹取，以实现文档口径为准） |
| 3 | 槽位上限 | `maxSlots=3` 连续建 5 个任务 | spawn 恰好 3 次；slots=3；前 3 条 `running`、后 2 条 `pending` 排队（不报上限失败） |
| 4 | 释放后 FIFO 派发 | 完成/停止第 1 条任务 | 槽位回 `idle`、`current_task_id` 清空；第 4 条自动派发到该槽位（不新增 spawn） |
| 5 | 1:1 占用与续派 | 各任务与槽位关系；`task_message` | 一个槽位同时只挂 1 条 running；续派走原槽位、不新建 teammate |
| 6 | 复用防污染 | 第二次在同槽位派任务 | 渲染文本头部含「上一个任务已结束，不要引用它的任何上下文或产物；……从零开始，只做这一件事」，后接新 brief |
| 7 | 释放不调移除 API | 代码/行为 | 不调用任何 teammate 移除；spawn 计数不因释放变化 |
| 8 | 平台上限不突破 | `maxSlots=3` 建 20 条任务；`maxSlots=8` 建 20 条 | 未释放时 spawn 恒为 3 / 8，绝不出现第 4 / 第 9 个 teammate |
| 9 | 启动复位 | 预置 busy 但任务终态/缺失的槽位；busy 且任务 running 的槽位 | 前者复位 `idle` + 清 `current_task_id`；后者不动，不误伤在跑任务 |
| 10 | 可观测 | `task_status` / 卡片数据 | 能看出任务用哪个槽位（`target`）；文档写清「槽位会话里可能有多个任务历史」 |

**待明确（影响判据）**：

- a. `maxSlots` 与旧 `maxActive` 的关系：任务数超过 `maxActive=8` 但槽位已满时，是继续排队还是仍报 `maxActive` 上限失败？槽位语义下应排队（否则「满了进队列」不成立）。
- b. 迁移：已有 `running`/`waiting_*` 任务（旧版本创建、无槽位记录）启动时如何归位——补建槽位并绑定，还是保持原样？需要文档口径。

## 23. 协调者轮换（满 8 自动新开会话）— **已撤销（2026-11-13，改 §24 换 subagent）**

背景：平台 Team 名册不可变、`maxMembers=8`、无移除 API。任务超过 8 个时，`spawnTeammate` 抛 `TEAM_MEMBER_LIMIT`；改为自动新建一个协调者会话接管，旧会话退役。**用户改选「dispatch 换 subagent + 容量队列」（§24），本方案废弃。**

| # | 验收点 | 怎么验 | 判据 |
| --- | --- | --- | --- |
| 1 | 触发识别 | 假 spawn 抛 `TEAM_MEMBER_LIMIT` / message 含 `Team member limit` | 触发轮换；不靠猜成员数；其他 spawn 错误仍走普通失败（标 failed） |
| 2 | 新协调者绑定 | 假 `sessionController.create({ workspaceId })` | 调用一次；`settings.coordinator_session_id` 更新为新 `sessionId`；旧标记 retired（持久化，重启后仍生效） |
| 3 | 交接消息 | 捕获 `sessionController.prompt` / 新会话 prompt | 含「你是新的协调者」、活跃任务清单（id/标题/状态）、台账位置、「继续接活，不要重复派发已有活跃任务」；**不含用户完整原话**（隐私与体积），标题/摘要需截断 |
| 4 | 新会话带规则 | 新会话 id 渲染 `systemPrompt.context` | 与首个协调者同一套：禁止 `wait_agent`、不得凭记忆推断状态等 |
| 5 | 旧协调者退役 | 旧会话再调 `task_create` | 返回「本会话的团队已达成员上限，已迁移到新协调者会话 X，请到那里继续」；不 spawn；`task_list`/`task_status` 仍可用 |
| 6 | 轮换后闭环 | 新协调者第一次 `task_create` | 正常派活成功（真机闭环的主验收）；新任务 `coordinator_session` = 新 id |
| 7 | 失败回滚 | `create` 抛错 / `prompt` 抛错 | 绑定回滚为旧协调者；不出现 retired 半状态；旧协调者仍可用；给用户可读提示；不静默 |
| 8 | 配置 | `autoRotateOnLimit`（默认 true）、`maxSpawnsPerCoordinator`（默认 8，≤8） | 关闭时只报错并提示手动开新会话、不建会话；上限 >8 有明确回落；默认值正确 |
| 9 | 并发触发 | 多个 `task_create` 同时撞 limit | 只轮换一次、只建 1 个新会话（防多开）；其余按退役提示返回 |

**待明确**：

- a. 「旧标记 retired」的存储位置（settings key / 新表）；重启后旧会话再次 `task_create` 必须仍被拒。
- b. 轮换后旧协调者名下已派任务的通知/回报去哪个会话（全局绑定只有一个协调者）；文档写清口径。
- c. 交接清单里 goal/摘要的截断长度（建议 ≤80 字，与日志一致）。

## 24. dispatch 换 subagent + 容量队列（当前方案）

背景：Team 名册不可变（8 上限、无移除 API）；spike 实测 `startActivation` 起子会话可行、`maxActiveSubagents=N` 并发上限、完成即释放容量、平台不排队。插件自己排队；`maxActive` 废弃，改 `maxQueue=50` 安全阀；`autoResumeQueue` 默认开；协调者不再用 Team 工具面。

| # | 验收点 | 怎么验 | 判据 |
| --- | --- | --- | --- |
| 1 | 12 连建不报错 | 容量 N（如 1/3/8）下连续 `task_create` 12 个 | 前 N 个 `running`（各一次 `startActivation`），其余 `pending` 排队（`queued_at` 非空）；不报上限、不 `failed` |
| 2 | 完成补位不双派 | 完成一个 running 任务 | 队列按 `created_at` FIFO 补 1 个；补位任务 `session_id`=新 childId；每个任务只 spawn 一次，无双派 |
| 3 | 队列满 `maxQueue` | 容量 1 + 队列 50 已满，再建 | 拒绝且不落库（无 tasks/messages 行）；文案可读 |
| 4 | 重启自动入队 | `autoResumeQueue=true`（默认）预置 `queued_at` 非空与空但未超时的 pending | 启动后均重新入队并派发；`false` 时不动（文档口径） |
| 5 | 排队任务 stop/message | `task_stop` 排队任务；`task_message` 排队任务 | stop：移出队列、`cancelled`、不 spawn；message：可读「排队中还没有子会话」、不写 messages、不转 `waiting_user` |
| 6 | 孤儿兜底 | 父会话关闭后 running 任务；`listChildren` 查询不可用 | 前者标 `orphaned`（卡片/`task_status` 可见），不留幽灵 running；后者只 warn 保留现状，不误判 orphaned；catalog 是历史≠活着 |
| 7 | 回报归属 | 子会话 `task_report` | `task.session_id` = childId；归属校验通过；冒名仍被拒 |
| 8 | 旧 Team 任务 | 一条真实旧数据 `sendMessage` 续派 | 结果写进文档：可续派 or 只能只读提示重建 |
| 9 | 启动参数 | 捕获 `startActivation` 入参 | `provider=spawnProvider`、`delivery:'caller'`、`childId=uuid`、`request.parent`=协调者 agent、`prompt`=渲染文本、`signal`=插件自有 AbortController（非 `exec.signal`） |
| 10 | 结算驱动 | `activation.result` settle / reject | 均挂 `.catch`；settle 后同步 pump 下一个（单锁串行，防双派） |
| 11 | 非容量错误 | `startActivation` 抛普通错误 | 任务 `failed`+error（不留 `pending` 幽灵）；容量错误才排队 |
| 12 | 卡片/跳转 | `task_status`/卡片数据 | 能看出 child/槽位；子会话跳转按 catalog（阶段 2 入口，阶段 1 文档写清） |

**可测性要求**：`createDispatcher`/工具层需要可注入的 `startActivation`/子会话 runner（测试用假实现），否则容量、settle、双派只能真机验；请给注入点。

## 25. 本轮复验记录（HEAD `1a85b4a`，npm test 162/162，api-probe 33/33）

**§24 subagent + 队列（独立探针 v24，23/23 通过）**：

- 12 连建（cap=1）→ 1 running + 11 pending，无 failed、无报错，排队文案带位置；成功 `startActivation` 恰 1 次。
- done + 结算后 FIFO 补位（补第 2 个而非第 1 个），总 spawn 2 次、childId 不重复（无双派）。
- 排队任务 `task_stop` → cancelled、不 spawn；`task_message` → 排队提示、不写 messages、状态不变。
- `maxQueue=2` 第 3 个排队后拒绝且不落库；重启 `autoResumeQueue` 默认入队派发，`false` 不动。
- catalog 读不到 → 只 warn 不误判；catalog 查不到 child → `orphaned`。
- `task_report` 用 childId 归属通过、冒名拒绝；非容量错误（普通异常）→ `failed` + error、不留 ghost pending。

**§21 日志（独立探针 v21，11/11 通过）**：路径 `state/orchestrator/logs/orchestrator-YYYY-MM-DD.jsonl`；事件含 `task.create.requested/created/rejected`（rejected 带 reason+callId）；不出现完整 `user_verbatim`；goal 截断 ≤80（带省略号）；每行合法 JSON；写失败主流程不受影响且只 warn 一次；7 天保留（惰性：首次写入时清理）；>5MB 换新文件且超限文件不再追加。

**§19/§20（独立探针 v19，10/10 通过）**：`waiting_user` 同 title+goal 被去重、仅空白差异 trim 归一、`done` 后可重建；超时无 session 的 pending 启动清理为 `failed`、近期 pending 不动；协调者 prompt 含「不得凭记忆推断 / 先调 task_list·task_status」，普通会话为空。

**当前有效探针**：task1/2/3/4/6/8（单元，已按新 config 9 键与 `waiting_*→orphaned` 边更新）+ v19/v21/v24。**旧 task5/7、binding/b-injection/b-roster/quota 等为 Team 后端/旧额度语义编写，已停用**（代码 162/162 覆盖）。

**待拍板/缺口（不阻塞本次测试，但影响验收判据）**：

1. **§24 #6 与实现不一致**：`reconcile.js` 只按 `catalog` 查不到才 orphaned；父会话关闭后 catalog 仍留有记录，running 任务会保持 running（幽灵），达不到「父会话关闭后标 orphaned」的判据。审查建议：启动对账加 `agents.get(session_id)` 不存在的 running → orphaned；等待态保持原状。需确认后实现。
2. **未写进设计的迁移边**：`src/state.js` 新增 `waiting_user/waiting_auth → orphaned`，但设计 `7413a2b` 只加了 `pending→failed`；且 reconcile 会把 catalog 缺失的等待态任务标 orphaned——「等待态不 live 也保持」与「catalog 缺失才 orphaned」两种口径需在文档写清。
3. `maxActive` 仍在 config（默认 8）但队列语义下未使用；文档应标废弃或删除。

**修复复验（`f971b9e`，166/166；独立探针 v24b 13/13、v24/v21/v19 全绿）**：

- **spawn 在途被 stop**：stop 立即返回、A 子会话被 `dispose`（不白占槽位）、B 不被连带删并正常派发、pump 不死（v24b A 段）。
- **整队列 `queued_at`**：cap=1 建 12 个后 11 个 pending 全部有 `queued_at`；把 `created_at` 改到 2 小时前模拟重启，`failStalePending` 不再误杀排队任务（v24b B 段）。
- **对账 liveness 口径**：running 且 `agents.get(session_id)` 不存在 → orphaned（即使 catalog 有记录，幽灵被收掉）；waiting_user 不 live 但 catalog 有 → 保持；waiting 且 catalog 查不到 → orphaned；catalog 读失败仍按 liveness 判 running（v24b C 段、v24 已同步改判据）。
- `maxActive` 与 `listQuotaTasks` 已从 config/ledger 移除（探针断言）；设计 §6/README 已同步 `waiting_*→orphaned` 与对账口径。
- **遗留风险（不阻塞）**：`inject` 仍同时声明 `agentTeams` 与 `subagents`，两个后端互相绑死（缺任一服务会加载失败）；开发决定等真机确认缺服务再拆，先记录。

## 26. 阶段 2 客户端薄插件（侧栏入口 + 任务面板 + 跳转）

依据设计 §11、`docs/probes/client-slots-probe.md`（`b8eb693`，审查已签字）与修订后的目标（「侧栏任务 → 面板 → 打开协调者」）。**只读约束**：客户端不建会话、不写绑定、不改状态，数据只走 host 的只读路由。

分三层，可分开独立执行：**L1 注册层**（假 ctx 直接跑 `client.js`，断言 `register` 入参，不需要 DSH）→ **L2 宿主路由层**（mock `ctx.connection.fetch.register` + 假 Request，对台账副本断言只读/鉴权/降级）→ **L3 真机 UI**（Chief 装临时 profile，我读页面/截图逐条勾）。

### A. L1 注册层（客户端 bundle，假 ctx）

判据以 `docs/probes/qa-stage2-slots.mjs` 的捕获结果为准（探针随本清单落地，已在骨架 fixture 与三个反例 fixture 上自检）。

| # | 验收点 | 判据 |
| --- | --- | --- |
| 1 | 入口注册 | `sidebar.panellist` 恰注册 1 次；`id:'orchestrator'`、`order:10`；**无 `priority`**（列表槽位也按 priority 排序，设了会顶掉同 id 低者、可能挤占别人）；`label()` 返回非空中文 |
| 2 | 面板页注册 | `main` 恰注册 1 次，`key:'orchestrator'`；若保留 `locale:'orchestrator'` 必须同时注册字典，否则去掉（审查小瑕疵） |
| 3 | 头部按钮注册 | `conversation.header.leading` 恰注册 1 次、**不带 `id`**（单席位）；组件 props 不依赖 `sessionId` |
| 4 | 打开面板路径 | 触发头部按钮的 `onClick` → `ctx.layout.selectPanel('orchestrator')` 被调且只传该 id；侧栏行点击交给平台，插件不重复调 |
| 5 | 生命周期 | 注册全部经 `ctx.slots.inject(name, …)` 包装（可撤销）；dispose 后重 apply 不重复注册、旧项消失 |
| 6 | bundle 形态 | 无顶层 `import`/`export`（经典脚本）；`__ModuleLoader__.load({ id:'dsh-orchestrator', factory })`；factory 返回 `{inject, apply}`；`inject` 与 `apply` 实际用到的服务一致（用 `ctx.uiSession.current` 就要有 `uiSession`） |
| 7 | 不抢 ds-bot 席位 | 注册槽位集合 ⊆ {`sidebar.panellist`, `main`, `conversation.header.leading`}；出现 `sidebar.workspaces`/`footer.action`/`brand.*`/`conversation.session.header`/`.header.actions` 即不通过；若加 `shell.overlay` 备选须另立条目并说明 id 不与 `bot-computer`/`bot` 冲突 |
| 8 | 客户端零写入 | `client.js` 只有一条 `fetch.register`（path `/api/orchestrator`）；不含写类 endpoint/payload；不调 `task_create`/`task_stop`/绑定接口 |

### B. L2 宿主路由层（`/api/orchestrator`）

| # | 验收点 | 判据 |
| --- | --- | --- |
| 9 | 端点白名单 | 未知 endpoint → 400 + 可读错误、不进查询/写路径；`tasks`/`coordinator` 返回结构与 `task_list`/`getSetting` 一致 |
| 10 | 只读实测（硬断言） | 调全部端点前后对 `tasks`/`messages`/`notifications`/`settings` 做「行数 + `updated_at`」快照，完全一致；`settings.coordinator_session_id` 不变；`snapshots/`、`logs/` 无新增文件 |
| 11 | 鉴权矩阵 | 跨站 Host/Origin → 403、无 cookie/token → 401、非 owner → 403（由 connection `admit()` 拦，断言 handler 未被调用）；同 path 重复注册 → 抛错（原文含 already/registered）；错误响应不含 `DSH_HOME` 绝对路径 |
| 12 | 失败降级（服务端） | handler 抛错 → 500 + 错误体且不抛未捕获；台账损坏/不可用 → 复用既有可读文案，不泄露路径 |
| 13 | 老宿主/未注册 | 路由未注册时客户端拿 404 → 面板降级「台账暂不可用」+ 重试，不白屏不崩 |

### C. L3 真机 UI（需 Chief 装 profile）

| # | 验收点 | 判据 |
| --- | --- | --- |
| 14 | 侧栏入口可见可点 | 「任务」在「插件」下方（图标+文字正常）；点击 → 面板占满内容区；ds-bot 账户位、TeamSidebar、会话头无位移/遮挡；插件重载后入口仍在 |
| 15 | Bot 模式头部按钮 | ds-bot 启用（Bot 模式）时 `conversation.header.leading` 按钮仍可见可点（不能是 `.header.actions`）；非 Bot 模式也可见；点两次不叠面板 |
| 16 | 面板数据 | 列出全部任务（含 done/cancelled/orphaned），状态点/标题/时间与 `task_list` 一致；空台账有空态；筛选正确、「全部」可恢复 |
| 17 | 跳转子会话 | 点有 child 的任务 → 切到该子会话（`origin:'subagent'`，不在普通列表也能到）；关面板再开仍可跳；pending/queued 行给可读提示且不误跳 |
| 18 | 打开协调者 / 未绑定 | 面板内按钮切到协调者会话；未绑定时显示「未绑定」+「先 `task_create` 会自动绑定」提示，**不建会话、不写绑定** |
| 19 | 降级/离线 | 停宿主或断网 → 「台账暂不可用」+ 重试；恢复后自动回正常；聊天不被阻塞 |
| 20 | 轮询生命周期 | 面板可见时 5s 一拉、关闭后无请求（看 network/日志）；连续失败退避 30s |
| 21 | 不回归阶段 1 | 真机 `task_create` 派发/排队/`task_report`/卡片数据不受客户端插件影响；服务端 6 个工具可调；`npm test` 166/166 |

### D. 构建与加载

| # | 验收点 | 判据 |
| --- | --- | --- |
| 22 | 打包清单 | `files` 含 `client.js`；`exports["./client"]`；`dsh.client.platform:'web'`；`dsh.client.inject` 按实际用到的服务列（`ui-sidebar`/`ui-conversation`/`ui-layout`/`ui-workspace`/`ui-session`）；primitives 不打进 bundle 则声明 `dsh.client.external` |
| 23 | 服务端不受影响 | 客户端 bundle 加载失败不影响 `index.js` 与 6 个工具；host 路由注册失败不影响阶段 1 能力（派发/队列/对账/日志） |

### 执行顺序与证据口径

1. 开发交付后先跑 `npm test` + `api-probe` 作为基线（不替代我的独立验证）。
2. L1：`node docs/probes/qa-stage2-slots.mjs <client.js>` → 全 PASS；反例 fixture（顶层 import / 带 priority / 用 `.header.actions`）必须报 FAIL，证明探针有效。
3. L2：copy 台账到临时 `DSH_HOME`，mock `register` 后逐个 endpoint 调用，贴前后快照对比。
4. L3：Chief 装 profile 后逐条勾 14–21，缺任一条不签。
5. 不通过必须给：最小复现步骤、期望、实际、可疑文件位置；L1/L2 贴探针输出，L3 贴读页面结果/截图 + ds-bot 对照。

### 阶段 2 不验收（范围外）

右侧栏 tab（`sidebar.right.pane.tab`）、`shell.overlay` 浮层版面板、任何写操作（改状态/派发/停止/绑定）、子会话嵌套、多协调者、ESM/esbuild 构建（MVP 手写经典脚本）。

### 定稿口径（`b8eb693`，审查签字）

- 入口 `sidebar.panellist`（`id:'orchestrator'`、`order:10`、不设 priority）；面板 `main`（`key:'orchestrator'`）；打开 `ctx.layout.selectPanel('orchestrator')`；与 plugin-manager/schedule 不冲突。
- 会话头按钮 **`conversation.header.leading`**（Bot 模式 ds-bot 的 `HeaderPill` 会顶掉 `conversation.session.header` 且不渲染 `.actions`）；该槽位无 `sessionId`，按钮只开面板；当前会话 `ctx.uiSession.current` / `retainedBy.mainView` 兜底。
- 跳转 `ctx.uiWorkspace.openSession(id)`（协调者/子会话同路径；`ui-subagent.openChild` 同款），无 URL。
- 未绑定协调者：面板显示「未绑定」+ 提示，客户端不建会话不写绑定。
- 刷新：主时间 `last_event_at`（与 stale 同源）、`updated_at` 供排序；打开拉一次、可见 5s 轮询、关闭即停、连续失败退避 30s。
- 路由鉴权：跨站 403 / 无凭证 401 / 非 owner 403 / 重复注册抛；**只读靠 handler 白名单**，不靠平台。
- bundle：经典脚本手写 `__ModuleLoader__.load`，顶层禁止 ESM；`files` 必含 `client.js`。

### 26.1 独立验收记录（`98642d3`，2026-11-14）

**基线（我自己跑）**：`npm test` → `# pass 179 # fail 0`（exit 0）；`node docs/probes/api-probe.mjs` → 33/33 PASS；`node --check client.js` → exit 0。

**L1（`node docs/probes/qa-stage2-slots.mjs client.js`）→ `RESULT: PASS`，39 条全过**：经典脚本无顶层 ESM；`__ModuleLoader__.load` 的 id 为 `dsh-orchestrator`；factory 返回 `{inject, apply}` 且 `inject=['slots','layout','uiWorkspace']` 与实际调用一致；panellist `id:'orchestrator'/order:10/无 priority/label='任务'`；main `key:'orchestrator'`；leading 单席位不带 `id`；头部按钮点击 → `selectPanel('orchestrator')`；不注册任何 ds-bot 槽位；注册全走 `slots.inject` 包装（可撤销）。

**L2（`node docs/probes/qa-stage2-route.mjs`）→ `RESULT: PASS`，48 条全过**：临时 `DSH_HOME` 起真台账，种 4 任务/1 消息/1 通知/1 设置。

- `snapshot` 200：4 条任务、字段齐全、不返回 `goal`/`brief` 原文；`queued`/`stale`/`childSessionId` 判定正确（排队→true、running→false、2 小时无动静→stale）。
- `tasks`/`create`/空 body/坏 JSON/无 endpoint → 400 `unknown-endpoint`，错误体不含绝对路径；payload 不能覆盖真实数据。
- **100 次调用后四表行数+`updated_at`+设置内容+目录文件 mtime 完全不变**（零写入硬断言）。
- 注册选项 = `{path:'/api/orchestrator', methods:['POST'], requestBody:'buffered'}`；平台契约（`review/client-connection-index.js`）核对：跨站 403 / 无凭据 401 / 非 owner 403 / 重复 path 抛；同 path 二次注册按平台行为抛错。
- `src/host-route.js` 只 import `listTasks` + `taskCard`，不 import 任何写函数；关库后 handler 以 rejection 结束（`database is not open`，不带绝对路径）。

**与设计/探针文档的偏差（不阻塞阶段 2 完成标准）**：

1. **状态筛选**（`d59da8f` 已补）：面板加 6 档下拉（全部/进行中/等待/已完成/失败/已取消丢失），覆盖 8 个状态无遗漏（active=pending+running、waiting=waiting_user+waiting_auth、done、failed、closed=cancelled+orphaned）；空态区分「还没有任务。」与「没有匹配的任务。」。
2. **失败退避**（`d59da8f` 已补）：轮询改为链式 `setTimeout`——成功 5s、失败 30s、成功一次恢复；卸载 `stopped=true` + abort + `clearTimeout`，在途请求返回后不再排下一轮（无泄漏路径）。
3. **错误体口径修正**：handler 未 try/catch，库异常时 rejection，由平台 `host-webserver.js:475-483` 统一返回 400 空体 + warn，客户端显示「台账暂不可用：HTTP 400」；探针文档写的「500 + 错误体」与平台实际不符——按平台实际，降级可读，不算缺陷。
4. 小瑕疵：pending 行同时显示「排队中」和「待派发」两个标签（冗余，不影响功能）。

**`d59da8f` delta 复验（筛选 + 退避）**：L1 探针扩到 **47 条全过**（新增：无 `setInterval`、`POLL_BACKOFF_MS=30000`、面板下拉 6 档且文案正确、下拉受控 `value+onChange`、有「打开协调者会话」/「刷新」按钮、未绑定提示）；L2 重跑 `RESULT: PASS`（`host-route.js` 未改动，零写入结论不变）；`npm test` 179/179。

**`f515a4a` + `6a8f07e` delta 复验（connection 晚到 / 快照截断）**：`index.js` 改为 `ctx.inject(['connection'], …)` + `scope.effect` 清理，保留 `ctx.get` 兜底（读 `index.js:272-299`；该路径由 181 测试里的「connection 晚到」用例覆盖，我未单独复跑）。L2 探针同步更新：静态断言改成「ledger 只取 `listTasks`/`listHistoryTasks` 两个查询函数 + `listHistoryTasks` 用 SQL `LIMIT`/`NOT IN` 活跃态」；新增动态用例「1 个早创建 running + 3 个新 done、limit=2」→ 返回 3 条、running 在、done 只 2 条、活跃排前、历史倒序；`limit=0` 只返回活跃。结果：L2 **57 条全过**、L1 47/47、`npm test` 181/181、api-probe 33/33、`node --check client.js` exit 0。

**`e4bb07e` 复验（侧栏入口迁到 `sidebar.footer.action`）**：真机 L3 发现 `sidebar.panellist` 在 Bot 模式被 ds-bot `nav[class*="_panelList"]{display:none!important}` 整条藏掉（按钮在 DOM 但 0×0），改注册 `sidebar.footer.action`（`id:'orchestrator'`、`order:100`、无 priority）。平台契约核对：`dsh-client-ui-sidebar/lib/client.js` @765 `{kind:'list', scope:'root'}`、渲染在 `.footArea > .footerActions` 并传 `{ wide }`；ds-bot 同槽占 `bot-return`(-300)/`bot-account`(-200)，CSS 让每个 action 占整行（`grid-column:1/-1`），我们的按钮单独一行不挤压账户位。L1 探针改断言后 **54 条全过**：不再注册 panellist、footer.action 恰 1 次、id/order/无 priority、id 不等于 bot-account/bot-return、`wide=true/false` 都能渲染出按钮、两态都有 `title/aria-label` 含「任务」、两态点击都 `selectPanel('orchestrator')`；L2 `RESULT: PASS`；`npm test` 182/182；api-probe 33/33；`npm pack --dry-run` 含 `client.js`(10.0kB)。

**结论**：阶段 2 代码侧通过（L1 54/54、L2 57/57、182/182、api-probe 33/33）；L3 真机按 §27 表在装 desktop 后逐条勾（Bot 模式 header 按钮已验证渲染，侧栏入口改 footer 后待重跑）。

## 27. 阶段 3 L3 真机核对表（装 profile + 重启后逐条勾）

前提：Chief 装机只重启一次；现有一个协调者会话 + 至少 3 个不同状态任务（done/cancelled/pending 各一个，供筛选与跳转）。端口用实际 DSH web 端口（本机示例 `127.0.0.1:50269`）。结果栏：`[ ]` 未验 / `[x]` 通过 / `[!]` 不通过（记录现象）。

### A. 入口与面板

| # | 步骤 | 期望 | 结果 |
| --- | --- | --- | --- |
| 1 | 重启后看左侧栏底部（`sidebar.footer.action`） | 出现「☰ 任务」按钮（展开态带文字、折叠态只有图标），与 ds-bot 的「返回」「账户位」并列不重叠、不遮挡账户位 | [ ] |
| 2 | 点 footer「任务」 | 主区域切到任务面板：标题「任务」、状态筛选下拉、刷新、打开协调者会话、任务行 | [ ] |
| 3 | 折叠侧栏再展开 | 折叠时 footer 入口随 shell 隐藏（已知降级，头部按钮可用），展开后入口回来；无报错 | [ ] |

### B. 会话头按钮（Bot 模式）

| # | 步骤 | 期望 | 结果 |
| --- | --- | --- | --- |
| 4 | 启用 ds-bot 的 Bot 模式，打开任一会话 | 会话头左侧出现「任务」按钮；ds-bot `HeaderPill` 在右侧正常；点按钮打开同一面板 | [ ] |
| 5 | 非 Bot 模式会话 | 按钮同样可见可点 | [ ] |

### C. 数据与筛选

| # | 步骤 | 期望 | 结果 |
| --- | --- | --- | --- |
| 6 | 面板与协调者会话里 `task_list` 对照 | 条数/标题/状态/时间一致；done/cancelled/orphaned 历史都在；活跃任务不因历史多被截断（活跃全量 + 历史最近 200） | [ ] |
| 7 | 切换 6 档筛选 | 进行中=pending+running、等待=waiting_user+waiting_auth、已完成/失败/已取消丢失 分类正确；「全部」恢复；无匹配显示「没有匹配的任务。」 | [ ] |

### D. 跳转

| # | 步骤 | 期望 | 结果 |
| --- | --- | --- | --- |
| 8 | 点 done 任务的「打开子会话」 | 切到该子会话（`origin:'subagent'`，不在普通会话列表）；能回到协调者会话 | [ ] |
| 9 | 点「打开协调者会话」 | 切到协调者会话；已在协调者时幂等、不重复创建 | [ ] |
| 10 | （可选）清掉 `coordinator_session_id` 后看面板 | 顶部「未绑定协调者」提示、「打开协调者会话」禁用；不建会话、不写绑定 | [ ] |

### E. 接口与降级

| # | 步骤 | 期望 | 结果 |
| --- | --- | --- | --- |
| 11 | 无 cookie 调接口：`curl.exe -i -X POST http://127.0.0.1:<port>/api/orchestrator -H "content-type: application/json" -d '{"endpoint":"snapshot"}'` | 401（平台 `admit` 拦，handler 不执行） | [ ] |
| 12 | 带跨站 Origin：加 `-H "Origin: http://evil.example"` | 403 | [ ] |
| 13 | 停宿主 / 断网后看面板 | 5s 内出现「台账暂不可用：HTTP xxx」；恢复后点刷新或等 30s 自动恢复；聊天不被阻塞 | [ ] |
| 14 | （可选）路由未注册的旧 profile | 面板显示「HTTP 404」且不白屏、不崩 | [ ] |

### F. 不回归与 ds-bot 隔离

| # | 步骤 | 期望 | 结果 |
| --- | --- | --- | --- |
| 15 | 看 ds-bot 的 TeamSidebar、底部账户位、会话头 | 无位移/遮挡/消失；ds-bot bot 会话正常可用 | [ ] |
| 16 | 协调者会话 `task_create` 派一个任务 → 子会话执行 → `task_report` | 面板出现新任务并变 done；卡片与通知不受影响 | [ ] |
| 17 | （可选）禁用插件再启用 | 入口消失/回来，宿主无报错 | [ ] |

### G. 取证（测试复核用）

- 宿主日志出现 `只读路由已注册 /api/orchestrator`；`state/orchestrator/logs/*.jsonl` 无异常新增。
- 面板打开期间 network 每 5s 一次 `snapshot`；关闭面板后无请求（退避期 30s 一次）。
- 调用接口前后 `tasks.sqlite` 的 `tasks/messages/notifications/settings` 行数不变（只读）。

**分工**：Chief 负责装 profile + 重启；用户按表点一遍并回报现象；我负责接口/日志/network 取证与汇总，不通过项按「步骤/期望/实际/可疑文件」记录。

## 28. 阶段 2（主会话）逐任务复核矩阵

依据 `docs/superpowers/plans/2026-11-14-coordinator-main-session.md` Task 1–9 与设计 §11。每个任务提交后我在 worktree 同步并独立复跑：`node --test <该任务测试>`、`npm test`、对应手写探针；不采信开发的测试输出。

| 任务 | 复核点 | 独立判据 |
| --- | --- | --- |
| 1 台账 | `target_dir` 列、旧库补列、`createTask(targetDir)`、`main_session_id` 读写 | 新库 `PRAGMA table_info(tasks)` 含 `target_dir`；旧 schema 建库后 `openLedger` 自动补列且旧行 `target_dir=NULL`；`getMainSessionId` 初始 `undefined`；`setMainSessionId` 后读回 |
| 2 brief | `validateTargetDir` 四类输入、`renderBrief` 的【工作目录】 | 相对路径→「必须是绝对路径」；不存在/不是目录→「不存在或不是目录」；`undefined`/空串→通过；有 target 时【工作目录】在【目标】之后，无 target 不出现 |
| 3 派发/队列 | `request.cwd` 优先 target、缺省父 cwd；`agentPreset` 固定 worker；queue 透传 `task.target_dir` | 捕获 `startActivation` 入参：`request.cwd === 'C:/target'`；无 target 时等于父会话 cwd；`request.agentPreset === 'dsh-orchestrator-worker'`（每任务都带） |
| 4 工具 | 6 个 `task_*` 只允许主会话；`task_create` 校验 target 并落库 | 非主会话调用返回含「主会话」；无主会话返回「请先从面板打开主会话」；`target:'relative'`→「绝对路径」；成功任务 `target_dir='C:/work'`；未误伤 `ask_user`/`show_view` |
| 5 主会话模块 | 创建/复用/失效重建/override/失败不写库 | 创建顺序：workspace resolve→create→`sessionController.create({agentPreset:PRESET_ID})`→rename「主会话」→写 `main_session_id`；live 直接返回不建；`spawnProvider!=='spawn'` 拒绝且不写库；create 抛错不写库；`coordinatorSession` 覆盖失效→返回 error 不建 |
| 6 装配 | 移除自动绑定、`open-main` 端点、运行期兜底只对 override | `apply` 后 `task_create` 不写 `main_session_id`；`open-main` 创建并写 `settings.main_session_id`；旧 `coordinator_session_id` 不再写；prompt/guard 只认主会话 |
| 7 路由 | `snapshot.mainSession`/`targetDir`、`open-main` 动作 | `snapshot.mainSession={id,live}`、`tasks[].targetDir`；`open-main` 走 `openMain` 一次，成功 200 `{ok,sessionId,created}`，失败 500 `{ok:false,error}`，无 `openMain`→500 `open-main-unavailable`；未知端点仍 400；**snapshot 仍零写入**（open-main 属动作端点，不在只读断言内） |
| 8 客户端 | 「打开主会话」、三态文案、`targetDir` 展示 | 面板按钮文案为「打开主会话」；点击 POST `open-main` 后 `uiWorkspace.openSession(sessionId)`；状态三态（在线/未创建/已失效）；入口与头部按钮文案仍是「任务」/「任务面板」 |
| 9 预设/文档 | `cordis.patch.yml`、`preset-tools.js`、package 清单、README/api-notes | 协调者 preset 只留计划里的工具 + ask_user/show_view/memory；worker preset `plugins: []`；`exports['./preset-tools']`、`files` 含 `preset-tools.js`；README 与 api-notes 对齐主会话语义 |

**L1/L2 探针更新点（随 Task 7/8 落地后改）**：

- L1（`qa-stage2-slots.mjs`）：面板按钮断言从「打开协调者会话」改「打开主会话」；断言点击会 POST `open-main`（mock fetch）而不是直接 `openSession` 空 id；补 `targetDir` 渲染断言；入口/头部槽位与文案不变。
- L2（`qa-stage2-route.mjs`）：补 `snapshot.mainSession`、`tasks[].targetDir`；补 `open-main` 200/500 与 `open-main-unavailable`；零写入断言只覆盖 `snapshot`（`open-main` 是动作端点，写主会话与 settings 是设计行为，由 Task 5/6 的用例覆盖）。

**不回退**：主会话改动不得影响子代理派发、容量队列、orphaned 对账、日志、去重、禁编提示、客户端入口/面板/跳转。每个任务后我跑 `npm test` + L1 + L2 全量，任一红即回给开发。

### 28.1 独立复跑结果（`5bdca13`，干净克隆 `qa/orch-final3`）

**基线**：`npm test` 213/213、`api-probe` 33/33、`npm pack --dry-run` 20 个文件（含 `client.js` 11.0kB、`preset-tools.js` 2.3kB）。

**新探针 `docs/probes/qa-main-session.mjs` → 62 条全过**，逐任务：

| 任务 | 独立断言（全 PASS） |
| --- | --- |
| 1 台账 | 新库有 `target_dir`；`createTask` 落库、未给为 null；`main_session_id` 初始 undefined→读写；**旧 schema 建库后 `openLedger` 自动补列，旧行保持 null（不臆造）** |
| 2 brief | 相对路径/不存在/文件（非目录）三类拒绝，`undefined`/空串通过，真实目录通过；【工作目录】只在有 target 时出现且在【目标】之后 |
| 3 派发/队列 | `request.cwd` 优先 target、缺省父 cwd、父子都无 cwd 时不带该键；`agentPreset` 固定 `dsh-orchestrator-worker` 且可被 `workerPreset` 覆盖；队列把 `target_dir` 透传为 `cwd`，无 target 时为 undefined |
| 4 工具 | `task_create/list/status/message/stop` 对非主会话全部返回「请从主会话操作任务」；`task_report` 不受限；无主会话返回「尚未打开主会话」；相对 target 拒绝且不落库；合法 target 落 `target_dir` 并派发 |
| 5 主会话 | 创建顺序 workspace→会话→rename→写台账；带协调者预设、创建时不传 title；工作区复用；live 复用；override 失效报错不建；`spawnProvider=fork` 拒绝且不写库；create 抛错不写库；rename 失败仍可用并记日志 |
| 6/7 装配/路由 | 不再调 `bindSettingOnce`/`rebindSetting`、无 `COORDINATOR_KEY`；装配 `createMainSession` 且 `open-main` 交给 `mainSession.open`；route 不直接写台账 |
| 9 预设/打包 | 协调者与 worker 预设、`preset-tools`、compaction 组都在；`exports['./preset-tools']`、`files` 含 `preset-tools.js` |

**L1 更新后 54 条全过**：面板按钮「打开主会话」、状态文案「主会话未创建」、点击 POST `open-main`（mock fetch）后用返回的 `sessionId` 调 `uiWorkspace.openSession`、任务行渲染 `targetDir`；入口/头部槽位不变。**L2 更新后 57 条全过**：`snapshot.mainSession{id,live}`、`tasks[].targetDir`（有无 target 两态）、`open-main` 成功 200/失败 500/无 `openMain` 500 `open-main-unavailable`、只调一次；零写入断言仍只覆盖 `snapshot`。

**非阻塞观察**：

1. `task_create` 相对 target 的文案重复：「target 必须是绝对路径。目标目录必须是已存在的绝对路径。」（`validateTargetDir` 的文案 + 拼接的后缀重复），建议只留一句。
2. `client.js` 的 `readSnapshot` 用相对 `api/orchestrator`，`openMainSession` 用绝对 `/api/orchestrator`；根路径下都可用，建议统一。
3. 计划内红点已确认：`25ca34a`/`5723514` 两个提交时 `index.test.js` 旧自动绑定用例为红，`10f684a` 起 213/213 全绿，属计划删改顺序，不算缺陷。

**结论**：阶段 2 测试侧通过（L1 54/54、L2 57/57、main-session 62/62、213/213、api-probe 33/33），无必须改项；两条非阻塞观察可随手修。

### 28.2 终审四条必须改的独立复跑（`6d2f6b9`，新探针 `qa-main-session-fixes.mjs` 22 条全过）

在 `895cee1` 上先跑出 **11 红**（证明探针能抓到问题），`6d2f6b9` 上全绿：

| 项 | 独立断言 |
| --- | --- |
| ① 预设求值 | `cordis.patch.yml` 无 `createRequire(baseUrl)`；worker 段无 `customSkillDirs`、不再引用 `@deepseek-ai/dsh-agent-preset`；协调者 compaction 组与 `preset-tools` 未回退 |
| ② provider 门控 | `provider:'fork'` 的 `request` **没有 `agentPreset` 键**（不是 undefined）；cwd 仍透传；`spawn` 仍注入 worker 预设且可被 `workerPreset` 覆盖；**fork + 配置覆盖会话派发成功**（假平台在收到 `agentPreset` 时抛 `UNSUPPORTED_CAPABILITY`，未触发） |
| ③ open 互斥 | 并发两次 `open()` 只调一次 `sessionController.create`、两次拿同一 `sessionId`、台账只写一次；**失败后 in-flight 已清**（再点成功、create 第 2 次调用）、失败不写库 |
| ④ 惰性服务 | `index.js` 以 getter 传 `sessionController`/`workspaces`；`main-session` 同时接受对象与 getter（动态验证通过）；服务未就绪返回「缺少 sessionController 服务（平台尚未就绪）」而非 TypeError |
| 建议：防双击 | `client.js` 有 `openingMain` 状态，按钮 `disabled: openingMain` 且文案「打开中…」 |

**干净克隆 `6d2f6b9` 全量**：`npm test` 216/216、`api-probe` 33/33、L1 54/54、L2 57/57、`qa-main-session` 62/62、`qa-main-session-fixes` 22/22，全部 exit 0。

**撤回一条观察**：之前说「client 读快照相对路径、open-main 绝对路径不一致」是我基于中间版本的误判——核对后两处都走同一个 `ROUTE='api/orchestrator'` 常量，无需改。`task_create` 相对 target 的文案重复已由 `895cee1` 修掉。

**结论**：阶段 2 测试侧通过（L1 54、L2 57、main 62、fixes 22、216/216、api-probe 33/33），四条必须改与一条建议全部独立复跑通过。



## 29. 与 ds-bot Bot 模式的外部依赖（阶段 3 真机发现）

**现象**：在装了 ds-bot 的 Bot 模式里，「打开主会话」服务端成功（`settings.main_session_id` 写入、`snapshot.mainSession` live、`open-main` 返回同一 `sessionId`），但页面仍停在 Bot（Chief）会话，随后的 `task_create` 被「请从主会话操作任务」拒绝。无 console 错误、无面板报错。

**根因（ds-bot 0.3.6 `client.js`，非本插件）**：

- `41886`：`const plain = isAgentSessionId(main); setPlain(plain); if (plain) dropPanels()`——只有 ds-bot 自己 DSH Agent 名下的会话才 `plain=true`（撤 Bot 皮肤）；外部 root 会话恒为 `false`。
- `40847`：`isAgentSessionId = id => isAgentSession(roster, agentSessionCache, id) || pendingAdopt.has(id)`。
- `41894-41897`：adopt 分支要求 `agentId = agentOfSession(before)` 有值；`40848` `agentOfSession = id => roster.agentOf[id] ?? pendingAdopt.get(id)`，Bot 会话在 `roster.agentOf` 里是 `undefined`（host `agents.js:19` 注释：Bot 和 group 会话是 undefined）→ 直接 return，连 `agent-adopt` 都不触发。

**结论**：主视图实际已切到主会话，错位的是 ds-bot 的 Bot 皮肤与输入框；插件侧无法绕过，按外部依赖记录。插件已加静态提示「主会话已就绪；若仍停在 Bot 会话里，请从左侧会话列表打开「主会话」」。

**以后 ds-bot 修这行时的对表点**：放宽 `plain` 判据，让非 Bot/room 的外部 root 会话也撤皮肤；或给外部插件一个「打开纯 dsh 会话」的 action。修好后复跑本清单 Task 10 ① 的跳转半条即可。

**为什么做不了严格对照**：ds-bot Bot 表面只列它自己 DSH Agent 名下的 Bot 会话，用户在 Bot 模式里造不出「非 bot 的普通 root 会话」，所以「打开任意普通 root 会话」的对照实验不可达。**反向证据**：同一个主会话在不带 ds-bot 的纯 dsh 表面点一次「打开主会话」，`openSession` 一次就切到「工作区 指挥舱 / 协调者」（隔离实例 `AFTER_OPEN` 原文）；且 ds-bot `client.js:41886` 的 `plain = isAgentSessionId(main)` 对外部 root 会话恒 `false`，该判据覆盖所有非 bot root 会话，与「只有我们的会话不切」相互排除。


## 30. 主会话工具表残留团队工具（② 降级口径，平台无干净解）

**现象**：主会话 projection 预设已是 `dsh-orchestrator-coordinator`，但工具表仍列出 `wait_agent`/`spawn_teammate`/`send_message`/`list_agents`/`interrupt_agent`/`team_task_*`（agent-scope 自注册），预设层删不掉。

**平台取证（四条，审查在 asar 核过）**：

1. 注册方 `@deepseek-ai/dsh-experimental-tool-agent-team` 的 `Config` 只有 `{ interrupt, freshProvider, forkProvider }`；`interrupt` 是 profile 全局开关，关掉会连子会话的 `interrupt_agent` 一起关，不能用于协调者。
2. `ToolsService` 只有 `register/restrict/view/get/executable/definitions/schemas/setExecutor/selectExecutor/guard/checkGuards`，**没有移除 API**；`restrict` 只遮继承工具（`view()` 中 `own.tools` 无条件进 `visible`，`restrictableNames` 不含 own）。
3. `session.create` 的 typert schema 只有 `{ workspaceId?, cwd?, sessionId?, agentPreset? }`，没有 `composition`/`toolFilter`/`title`。
4. 唯一硬拦截点是 `guard`（dispatch 前跑 global + agent 链上的 guard，返回原因即拒）。

**本版处理（双保险）**：

- `preset-tools` 收窄全局工具（deny 补集，`ask_user_question` 由预设自有行提供）。
- `COORDINATOR_POLICY` 明确禁止 `wait_agent`/`spawn_teammate`/`send_message`/`list_agents`/`interrupt_agent`/`team_task_*`。
- `guard` 对主会话硬拦整个 `COORDINATOR_DENY` 名单（逐条可读拒绝），子会话同名工具放行；`task_list` 等正常工具不受影响。service 调用（如 `backend:'team'` 的 `spawnTeammate`）不经过工具 guard，team 后端派发不受影响。
- 用例：`guard 覆盖整个 COORDINATOR_DENY 名单：主会话全拒、子会话同名放行、同步返回不阻塞`；`settings.main_session_id 的主会话调用 wait_agent 也被 guard 拒绝（不依赖预设）`。

**真机证据（隔离 home，不带 ds-bot）**：主会话工具表残留如上；模型层面 `wait_agent` 两次拒绝调用（系统禁令优先），回合 1–3 秒结束；guard 层用注入单测覆盖（模型不会违反系统禁令去触发）。①③④⑤ 通过，② 按本降级口径记录，⑥ 探针全绿。

## 31. rc.3 子会话沙箱根 = 父会话目录（平台缺陷 + 可写根兜底）

**现象**：子会话 projection `workingDirectory` 是 target，但 `Current DSH file policy` 的 `workspaceRoot` 仍是主会话目录（指挥舱），`workspace-write` 下 `write`/`pwsh` 写 target 被拒。

**平台取证**：
- `dsh-subagent/lib/index.js` `childSessionMeta`：子会话 `meta.cwd = parentHeader.cwd`。
- 同文件 `startLocal`：`workingDirectory.set(child, create.cwd)` 只追加事件。
- `dsh-sandbox-policy/lib/index.js`：`sessionWorkspaceRoot(session) = session.header.cwd`；额外根走 `registerWritableRoot(session, dir)`（WeakMap 按 Session 对象身份）。

**本版处理**：
- `dispatch.spawn` 成功后、`sendMessage` **成功后**（续派时发送前通常解析不到子会话，恢复后才出现新 Session 对象），按 `agents.get(childId).session` 幂等注册 target 可写根；按 targetId 追加记录（同一会话 resume 前后可能有多个 Session 对象，只追加不替换），settle 不释放，`task_stop` 与终态（done/cancelled/orphaned/failed）把该 targetId 下新旧对象的 disposer 全量释放。
- 已知边界：Windows 上只对 harness 文件工具生效，`pwsh`/`bash` 写 target 仍拒；`target` 不要用符号链接；派发首回合与冷恢复/续派首回合都有极小窗口可能先写后注册、被拒一次（下一回合可重试）。
- 用例：`test/dispatch.test.js` 的 `rc.3 可写根：*`（对象引用同一性、settle 不释放、删除后sendMessage才恢复的补注册、投递失败不注册、终态释放新旧两个 disposer、服务或 target 缺失不炸）；`test/tools.test.js` 的 `可写根生命周期：*`、`waiting_user 续派：*`。

**真机验收（非临时目录）**：不传 target 推断到 `default-workspace` → `write` 写出 `qa-write.txt`，首轮 system-reminder 出现 `Additional writable directories: [...target]`；`blocked` 后 `task_message` 续派再写 `qa-write2.txt` 成功（**续派轮不会再有新的 policy 行**——平台只在会话开始注入一次，续派沿用同一上下文；续派以「无 `file access denied` + 文件存在 + artifacts `exists:true`」为证据）；`pwsh` 写 target 被拒按平台限制留证、不算缺陷。

## 32. 阶段 4：侧栏启动器入口与显示名（L1/L3 复核矩阵）

**槽位依据**：`docs/probes/sidebar-nav-entry-probe.md`；`node docs/probes/sidebar-nav-probe.mjs` → 16/16 PASS。

**L1（`qa-stage2-slots.mjs client.js`）断言**：
| 项 | 期望 |
| --- | --- |
| footer action | **不注册**（`sidebar.footer.action` 0 条） |
| main 面板 | 恰 2 条：`orchestrator`（任务面板）+ `orchestrator-launcher`（启动器） |
| 侧栏条目 | `sidebar.panellist` 恰 1 条：`id:'orchestrator-launcher'`、`order:5`（插件 0 / 自动化任务 10 之间）、`label()='主会话'`、无 priority |
| 启动器挂载 | 渲染「正在打开主会话…」→ POST `open-main` → `openSession(返回 sessionId)` → `selectPanel(null)` |
| 头部按钮 | `conversation.header.leading` 仍在，点击 `selectPanel('orchestrator')` |
| 面板 | 仍读 `snapshot`、筛选、产物展开、「打开主会话」；快照/动作错误分开显示 |

**L3（真机勾选，纯 dsh 表面）**：
| # | 操作 | 期望 | 勾 |
| --- | --- | --- | --- |
| 1 | 点侧栏「插件」下方「主会话」 | 一帧占位后进入主会话对话（新建或复用），侧栏无残留高亮 | [ ] |
| 2 | 已在主会话时再点一次 | 不重复创建、不报错，仍在对话 | [ ] |
| 3 | 侧栏底部 | 无「任务」入口（footer action 已删） | [ ] |
| 4 | 会话头「☰ 任务」 | 打开任务面板 | [ ] |
| 5 | 把侧栏条目取消固定 | 出现在「更多」菜单里，点击同样直达对话 | [ ] |
| 6 | Bot 模式 | 侧栏启动器不可见（ds-bot 隐藏面板列表），头部按钮仍能开任务面板 | [ ] |
| 7 | 面板/通知/任务流 | 任务显示名；重名带短 id 后缀；通知与面板不出现 `t-xxx` | [ ] |

**已知边界**：启动器点击有一帧「正在打开主会话…」占位（`selectPanel(null)` 在 openSession 后立即执行）；Bot 模式入口不可见（与 §29 同源外部依赖）；`task_create`/`task_list`/`task_status` 仍保留「标题（t-xxxx）」供模型操作，其余对外文案零 id。
