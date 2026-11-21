# 0.25.1 主会话权限徽标真机验证（C：钉 read-only）

日期：2026-11-21｜结论：**4/4 PASS**｜被测包：本仓库工作区打出的 `@wjj865-code/dsh-orchestrator@0.25.1` tarball

| # | 验证点 | 结果 | 证据 |
|---|---|---|---|
| a | 新建主会话后输入区权限徽标 = 「Read Only / 仅可查看」 | **PASS** | `screenshots/e2e-02-main-badge.png`、`evidence/main-session-events.json`（seq 3–4） |
| b | `/permission danger-full-access` 后徽标变为对应值，协调者工具表**仍无** `read`/`write`/`bash`（工具面未解锁） | **PASS** | `screenshots/e2e-05-after-permission.png`、`evidence/coordinator-tool-table.json`（16 次请求只有 **1 种**工具集合，13 个工具，无文件/命令工具） |
| c | 再次「打开主会话」/adopt 后徽标拉回 read-only，日志出现 `main.session.permission-pinned` | **PASS** | `screenshots/e2e-07-reopened.png`、`evidence/plugin-audit-picks.json`（`from: danger-full-access → read-only`）、`evidence/main-session-events.json`（seq 47–49） |
| d | 同批普通任务子会话能正常写文件（workspace-write 生效），不因主会话只读而失败 | **PASS** | `screenshots/e2e-09-child-task.png`、`evidence/child-session-events.json`（委派继承 read-only → 插件钉回 workspace-write，早于首个模型请求）、`evidence/e2e-child.txt` |

## 0. 上次异常结束的原因（先查清再续）

上一轮子会话在**四项验证全部完成之后**（只剩截图复核）以 `stopReason=error` 结束。子会话日志里是模型侧账户余额问题，不是本地环境：

```json
{"type":"assistant/attempt","data":{"stream":[{"chunk":{"type":"finish","reason":{"kind":"error","failure":{
  "message":"Insufficient Balance (request_id: ccd0990e-1972-4880-b659-7afae9fce43d)",
  "code":"ACCOUNT_QUOTA","status":402}}}}]}}
{"type":"turn/end","data":{"reason":{"kind":"error","error":{"code":"ACCOUNT_QUOTA","status":402}}}}
```

- 与无头 Chrome / profile 启动 / tarball 安装**无关**：三者在本轮复跑中全部正常工作（新实例、新 token、新 profile 都成功）。
- 修复/等价方式：无。本轮用同一套环境重新跑了一遍（主要是给 (d) 一次干净的子会话记录），并补齐报告产物。
- 完整片段见 `evidence/failure-cause.json`。

## 1. 环境与隔离（不碰用户真实 profile）

| 项 | 值 |
|---|---|
| `DSH_HOME` | `C:\Users\72489\AppData\Local\Temp\orch-e2e-home`（临时目录，验证后删除） |
| profile | `e2e`，用 DSH 自带 `--from-default-profile web` 生成 → bundles = `dsh-base` + `dsh-web-app` + 本插件 |
| 插件安装 | `pnpm pack --pack-destination <temp>` 打出 `wjj865-code-dsh-orchestrator-0.25.1.tgz`，`dsh plugin --profile e2e add <tarball>` 安装；**安装副本里确认含本轮改动**（`src/main-session.js` 的 `MAIN_PERMISSION_PRESET` / `pinPermission`） |
| 模型 | 本地 Messages 兼容 stub（`harness/mock-llm.mjs`），通过 `DEEPSEEK_BASE_URL` 指过去 + 假 `DEEPSEEK_API_KEY`；**不消耗用户真实额度、不读用户凭据**。stub 会记录每次请求的 `tools[]`，所以能直接看到运行时工具表 |
| 端口 | DSH Web `127.0.0.1:53517`（`--no-open`）、模型 stub `127.0.0.1:47123`、Chrome CDP `9333` |
| 浏览器 | 系统 Chrome `--headless=new`，独立 `--user-data-dir`，用原生 CDP（`harness/cdp.mjs`，无第三方依赖）驱动 |

启动命令（PowerShell，token 每次随机）：

```powershell
$env:DSH_HOME='C:\Users\72489\AppData\Local\Temp\orch-e2e-home'
$env:DEEPSEEK_BASE_URL='http://127.0.0.1:47123'
$env:DEEPSEEK_API_KEY='sk-e2e-mock-0000000000'
& 'C:\Users\72489\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' `
    --profile e2e --no-open --port 53517 --host 127.0.0.1
# 打印：dsh web: http://127.0.0.1:53517/?token=<token>
```

## 2. 验证过程与实测结果

### (a) 新建主会话 → 徽标「仅可查看」

从侧栏「◈ 主会话」打开（临时 home 里是新建），输入区权限按钮：

```json
{"aria":"访问模式，当前：仅可查看","text":"仅可查看"}
```

- 对照：同一个新实例里，普通空白会话的徽标是「工作区内修改」（`screenshots/e2e-01-initial.png`），说明不是全局改成了只读。
- 见 `screenshots/e2e-02-main-badge.png`（主会话标题 + 底部「仅可查看」）。
- 运行时写入的事件（主会话日志）：

```json
{"type":"permission/preset","seq":3,"data":{"preset":"read-only"}}
{"type":"sandbox/mode","seq":4,"data":{"mode":"read-only"}}
```

（seq 0–2 是宿主给新会话的默认 `workspace-write` + `ask`，紧接着被插件钉成只读；seq 顺序即「宿主默认 → 插件钉只读」）。
插件审计：

```json
{"event":"main.session.permission-pinned","detail":{"from":"workspace-write","preset":"read-only"}}
{"event":"main.session.created","detail":{"agentPreset":"dsh-orchestrator-coordinator","permission":"pinned"}}
```

### (b) `/permission danger-full-access` → 徽标变化，工具表不变

在输入区执行 `/permission danger-full-access`（命令直接生效，无确认弹窗、无「已开始会话」锁），徽标立即变成：

```json
{"aria":"访问模式，当前：完全权限","text":"完全权限"}
```

见 `screenshots/e2e-05-after-permission.png`。会话日志：

```json
{"type":"permission/preset","seq":30,"data":{"preset":"danger-full-access"}}
{"type":"sandbox/mode","seq":31,"data":{"mode":"danger-full-access"}}
{"type":"approval/policy","seq":32,"data":{"policy":"never"}}
```

**工具表不变**（这是本条的核心）：stub 抓到的 16 次协调者请求里，工具集合只有 **1 种**，都是 13 个协调者工具，始终没有 `read`/`write`/`pwsh`/`bash`/`glob`/`grep`：

```json
["ask_user_question","context","memory_note","present","read_workspace",
 "schedule_create","schedule_edit","schedule_list","schedule_view",
 "task_create","task_list","task_message","task_status"]
```

切换前后两次请求的对照（`evidence/coordinator-tool-table.json`）：

| 时间（UTC） | 当前文件策略 | 工具数 | read | write | bash |
|---|---|---|---|---|---|
| 03:22:37 切换前 | read-only | 13 | ✗ | ✗ | ✗ |
| 03:22:42 切换后 | **danger-full-access** | 13 | ✗ | ✗ | ✗ |
| 03:22:47 重新打开后 | read-only | 13 | ✗ | ✗ | ✗ |

主会话日志里**没有** `agent-preset/selected` 事件；权限切换只写 `permission/preset` + 两个旋钮事件，协调者预设与工具面一字未动。

### (c) 再次「打开主会话」→ 徽标拉回 read-only + 审计日志

点侧栏「主会话」再次打开后，徽标回到「仅可查看」（`screenshots/e2e-07-reopened.png`），插件审计新增：

```json
{"event":"main.session.permission-pinned","detail":{"from":"danger-full-access","preset":"read-only"}}
```

会话日志对应 seq 47–49：`permission/preset read-only` + `sandbox/mode read-only` + `approval/policy ask`；随后派单请求的运行时上下文也回到 `Current DSH file policy: read-only`（见上表 03:22:47 行）。
另外，**进程重启后恢复的主会话**同样显示只读（本轮重启实例后驱动脚本第一步读到的就是「仅可查看」），说明 `agent/created` 兜底路径也生效。

### (d) 普通任务子会话照常写文件（workspace-write）

主会话仍为只读时派一个普通任务（mock 让协调者调用 `task_create`，子会话再调用 `write`）：

- 子会话工具表（29 个）含 `write` / `pwsh` / `read` / `glob` / `grep`，与协调者工具面完全不同（`evidence/worker-tool-table.json`）。
- 子会话日志（`evidence/child-session-events.json`）——**关键顺序**：

```json
{"type":"agent-preset/selected","seq":0,"data":{"agentPreset":"dsh-orchestrator-worker"}}
{"type":"sandbox/mode","seq":2,"data":{"mode":"read-only","source":"delegation"}}      // 平台把只读主会话的覆盖种进来
{"type":"approval/policy","seq":3,"data":{"policy":"never","source":"delegation"}}
{"type":"sandbox/mode","seq":6,"data":{"mode":"workspace-write","source":"delegation"}} // 插件在首个模型请求（seq 19）之前钉回可写
```

- 插件审计：`subagent.workspace-write`（mode=workspace-write）+ `subagent.writable-root`（target 目录）+ `task.transition running → delivered`。
- 实际写盘成功：`<temp>/task-target3/e2e-child.txt`，内容 `written-by-e2e-child`（`evidence/e2e-child.txt`）。
- 见 `screenshots/e2e-09-child-task.png`：主会话徽标仍「仅可查看」，同一屏里已有子会话任务 chip（说明只读主会话与可写子会话同时成立）。

## 3. 关键日志片段（原始）

插件审计（`~/.dsh/state/orchestrator/logs/*.jsonl`，本轮临时 home 内）：

```json
{"at":"2026-11-21T03:21:33.769Z","event":"main.session.permission-pinned","detail":{"sessionId":"session-4810b765-8584-4d8f-9600-2826a9d45244","from":"workspace-write","preset":"read-only"}}
{"at":"2026-11-21T03:22:42.883Z","event":"main.session.permission-pinned","detail":{"sessionId":"session-4810b765-8584-4d8f-9600-2826a9d45244","from":"danger-full-access","preset":"read-only"}}
{"at":"2026-11-21T03:35:10.688Z","event":"subagent.workspace-write","detail":{"sessionId":"54975f4e-031a-4911-9b6f-b2f784ca21f5","mode":"workspace-write"}}
{"at":"2026-11-21T03:35:10.699Z","event":"subagent.writable-root","detail":{"directory":"…\\task-target3"}}
{"at":"2026-11-21T03:35:11.037Z","event":"subagent.settled","detail":{"stopReason":"completed","output":"DONE: 文件已写入，任务已回报。"}}
```

完整列表：`evidence/plugin-audit-picks.json`。

## 4. 边界与已知噪音

- **模型是本地 stub**：验证的是「宿主 + 插件 + 沙箱 + 徽标」这条链，不验证模型行为。抓到的 `tools[]` 是宿主真实发给模型的请求体，所以工具表结论是真的。
- **stub 自身曾造成一次任务循环**：第一次 (d) 尝试里 stub 对每个 tool_result 都回 `task_report`，导致子会话反复回报直到 mock 修复（`alreadyReported` 判断）。这是**验证脚本**的问题，不是插件缺陷；插件对重复回报照常入库/结算，最终任务正常 `delivered`。报告里 (d) 采用修复后的干净运行（`evidence/child-session-events.json`）。
- 认证：临时实例用假 key + 本地 baseURL，不读用户真实密钥；临时 `DSH_HOME` 验证后整目录删除，用户真实 profile 零改动。
- `/permission` 切换本身**没有**「已开始会话」锁（宿主 `PermissionPresetService.apply` 无 locked 分支），所以 b 能直接切走；这符合交付文档「钉不是锁」的口径——拉回发生在下一次打开/重载/adopt。

## 5. 复跑方式

`harness/` 里是完整脚本（无第三方依赖，Node ≥ 22）：

```powershell
node harness/mock-llm.mjs                                   # 1) 本地模型 stub（见文件头环境变量）
$env:DSH_HOME=<temp>; dsh --profile e2e --no-open --port 53517 --host 127.0.0.1
$env:DSH_URL='http://127.0.0.1:53517/?token=<token>'
node harness/drive2.mjs    # a + b + c（徽标/切换/工具表/重新打开）
node harness/drive3.mjs    # d（派普通任务，子会话写文件）
node harness/unzstd.mjs <session.v4.jsonl.zstd> out.jsonl    # 解会话日志（多帧 zstd）
```

## 6. 清理

验证结束后已停止 stub/DSH/Chrome 进程，临时 `DSH_HOME`、Chrome profile、原始 mock 抓包（本轮曾达 118 MB 的循环噪音）删除；仓库只保留本报告的截图/精简证据/脚本。既有 0.25.1 交付内容（12 个改动文件）未做任何修改。

## 7. 交付完整性

- 本轮只新增本报告目录（`reports/main-permission-badge-verify/`），0.25.1 的 12 个既有改动文件 `git status` 仍原样（未重写、未回退）。
- 复跑 `pnpm test`：**1065 例 / 1060 pass / 0 fail / 5 skip**（pretest 的 client build、check-client-size、check-docs 全过），与上一轮交付结果一致。
- 真机验证临时环境已全部清理，端口 53517 / 47123 / 9333 已释放，用户真实 profile 与 `~/.dsh` 未被写入。

