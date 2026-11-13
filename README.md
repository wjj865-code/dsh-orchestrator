# dsh-orchestrator

协调者会话 + 子任务工作台的服务端核心（阶段 1，无客户端）。

协调者只做协调：把需求拆成结构化任务、派给子会话、看回报、决定是否打扰用户；子任务是普通 DSH 会话（同队 teammate），能力不受限，只多一个 `task_report` 回报工具。

## 落盘范围

唯一写入是：

```
$DSH_HOME/state/orchestrator/tasks.sqlite        （+ -wal / -shm）
```

`DSH_HOME` 未设置时用 `~/.dsh`。不写 profile、不写其他会话目录、不建快照（阶段 3 再做）。

## 安装

由维护者装进 profile（本仓库不碰 `~/.dsh/profiles`）：`link:` 指向本仓库 + 在 profile 里 insert `cordis.patch.yml` 的 `dsh-orchestrator`。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `coordinatorSession` | `undefined` | 协调者会话 id，必填；插件按它现查 live agent，会话后加载也能补上 |
| `staleMinutes` | `30` | `task_list` 里超过这么多分钟无动静就标 `⚠` |
| `stallRounds` | `3` | 预留：阶段 3 的连续无进展升级阈值，阶段 1 只校验并保存 |
| `maxActive` | `8` | 同时活跃任务上限，超了 `task_create` 拒绝 |
| `mergeWindowMs` | `5000` | 完成通知合并窗口 |

非法值（0、负数、NaN、Infinity、字符串）一律回落默认，不会把插件带崩。

## 工具

协调者（5 个）：

| 工具 | 作用 |
| --- | --- |
| `task_create` | 建台账 + 渲染 brief + 派生一个 fresh 子会话；缺验收标准/超上限会拒绝 |
| `task_list` | 默认只列活跃任务；带标题、目标摘要、最近一条消息、陈旧标记；`active:false` 看全量 |
| `task_status` | 单任务详情 + 最近 3 条消息 |
| `task_message` | 续派消息（不新建任务），失败重试 3 次后转 `waiting_user` 并记原因 |
| `task_stop` | 中断当前一轮并标 `cancelled`；已结束任务不重复中断 |

子任务（1 个）：

| 工具 | 作用 |
| --- | --- |
| `task_report` | 每轮结束调用：`progress` / `done` / `blocked` / `needs_auth` |

`task_report` 的四档通知：`progress` 静默只写台账；`done` 在 5 秒窗口内合并后汇报；`blocked` / `needs_auth` 立即打扰。每次实际投递（成功/失败）都写 `notifications` 表（跳过投递记 `skipped`，没有 `delivered_at`），合并的后续行 `merged_into` 指向首条。`task_message` 续派成功会把 `waiting_user`/`waiting_auth`/`failed` 拉回 `running`，`task_report` 的 `progress` 也会从等待态恢复，`done` 从等待态会先回 `running` 再完成。

## 一次完整流程

1. 用户说「空数据时报表啥也不显示，修一下」。
2. 协调者调用 `task_create`：

   ```
   task_create({
     title: '修复空数据文案',
     goal: '空窗口时报表给出明确说明而不是空表',
     constraints: ['只改 src/report.js'],
     acceptance: ['空窗口输出「该窗口没有调用记录」', 'npm test 全绿'],
     user_verbatim: '你看这个空数据啥也没显示'
   })
   ```

3. 子会话收到的输入是渲染文字，不是 JSON：

   ```
   【任务编号】t-1a2b3c4d
   【任务】修复空数据文案
   【目标】空窗口时报表给出明确说明而不是空表
   【约束】- 只改 src/report.js
   【验收标准】
   - 空窗口输出「该窗口没有调用记录」
   - npm test 全绿
   【用户原话】
   > 你看这个空数据啥也没显示
   完成后请汇报：改了什么、改了哪些文件、怎么验证的。
   ```

4. 子任务每轮末尾 `task_report({ task_id:'t-1a2b3c4d', status:'progress', summary:'已定位渲染分支' })`，协调者收到静默台账更新。
5. 完成后 `task_report({ status:'done', summary:'改了空数据分支，npm test 全绿' })`，协调者会话收到：

   ```
   任务「修复空数据文案」完成：改了空数据分支，npm test 全绿
   ```

6. 会话内卡片数据用 `taskCard(task, { summary })` 产出：`taskId`、`title`、`status`、中文 `label`、`tone`、截断到 80 字的 `summary`。

## 错误与降级

- 打不开/损坏的台账：`台账损坏：<路径>（可尝试从 snapshots 目录恢复）：<原因>`，不泄漏 `SQLITE_` 和堆栈。
- 找不到协调者会话：工具仍注册，派活返回「任务协调失败：未找到协调者会话…」，任务留在 `pending` 并记原因。
- 子会话创建失败：任务留 `pending`，`error` 写原因，可重试。
- 续派投递失败：重试 3 次（1s/2s/4s），仍失败标 `waiting_user`，记失败消息行。
- 通知发送失败：写 `notifications` 失败行 + warn，不产生未处理 rejection。

## 已知局限（阶段 3 再做）

- **台账快照与自动恢复**：阶段 1 只把损坏库转成可读错误，不写快照、不自动恢复。
- **orphaned 自动检测/一键重建**：子会话被删后状态会停在 `running`，阶段 1 不自动检测。
- **30 分钟打扰升级**：`stallRounds` 只保存不生效，阶段 1 只有 `task_list` 的陈旧标记。
- **协调者白名单的持久声明**：阶段 1 在协调者 agent 已加载时用 `agent.ctx.tools.restrict({ deny })` 做最小收窄（文件/shell/浏览器/web/团队控制类）；协调者未加载时只能跳过，阶段 3 改由 agent preset 的 `composition.toolFilter` 固化。
- **唤醒时序**：`sendMessage` 到 lead 走 `root.steer`（wakeup=true）会唤醒协调者，机制见 `docs/api-notes.md`；忙时排队不丢的真机时序由维护者冒烟验证。
- 阶段 1 没有客户端入口/历史面板；卡片只提供数据，不渲染 UI。

## 开发

```bash
npm test
node docs/probes/api-probe.mjs   # 核对已安装平台里 agentTeams 的契约
```
