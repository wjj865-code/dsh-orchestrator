# 0.26.0 真机验证：技能 + 只读工具面 + progress 通知（e2e profile）

日期：2026-11-21｜被测包：本仓库工作树打出的 `@wjj865-code/dsh-orchestrator@0.26.0` tarball
结论：**6/6 验证点 PASS + progress 通知 3/3 PASS**；1 个差异已在发版前处理（协调者工具表多出 `working_directory`，见 §9）。

| # | 验证点 | 结果 | 证据 |
|---|---|---|---|
| ① | 协调者工具表含 `read`/`glob`/`grep`，协调者预设含 `skill-grill-me`，技能目录出现 `grill-me` | **PASS** | `evidence/tool-tables.json`（18 个工具；catalog 6 个技能含 `grill-me`）、`screenshots/03-coordinator-tools.png` |
| ② | `read` 能读 target 产物与安装副本里的 `skills/grill-me/SKILL.md`；`skill({name:'grill-me'})` 能加载正文 | **PASS** | `evidence/read-and-skill.json` |
| ③ | read-only 权限下写操作被沙箱拒绝，目标文件不产生 | **PASS** | `evidence/readonly-denials.json`（`Error: [sandbox: file access denied under read-only mode]`）、`screenshots/05-readonly-task.png` |
| ④ | 用户手动切 `danger-full-access` 后徽标变化、工具表不新增；同模式沙箱写放开 | **PASS** | `screenshots/12-permission-full.png`、`evidence/tool-tables.json`（切换前后逐名相同、`added: []`）、`evidence/session-events.json`（seq 275–277）、`evidence/full-access.json` |
| ⑤ | worker 子会话看不到 `grill-me` 技能 | **PASS** | `evidence/tool-tables.json`（worker catalog 14 个、无 `grill-me`）、`evidence/readonly-denials.json`（`skill "grill-me" is unknown or no longer available`） |
| ⑥ | 回归：主会话徽标仍钉 read-only；普通任务子会话 workspace-write 可写 | **PASS** | `screenshots/14-reopened-readonly.png`、`evidence/session-events.json`（主会话 seq 292–294、各子会话 read-only→workspace-write）、`evidence/normal-task.json` |
| P1 | 正常 progress 送达（合并窗口 + 水位 + notifications 行） | **PASS** | `evidence/progress.json`（p1 送达延迟 5075 ms；p2 `skipped/progress_watermark` 后尾沿送达） |
| P2 | 追问场景：`task_message` 后子会话 `progress` 立刻送达「回答你的追问」 | **PASS** | `evidence/progress.json`（送达延迟 **10 ms**）、`evidence/plugin-audit-picks.json`（`task.report` `answeredFollowup: true`） |
| P3 | 回归：done/blocked/needs_auth 分级与合并窗口不变 | **PASS** | `evidence/status-grading.json`（done 5053 ms / blocked 22 ms / needs_auth 7 ms）、`evidence/progress.json`（notifications 行 level=notify/interrupt） |

## 1. 环境与隔离（不碰用户真实 profile）

| 项 | 值 |
|---|---|
| `DSH_HOME` | `C:\Users\72489\AppData\Local\Temp\orch-e2e-026\home`（验证后整目录删除） |
| profile | `e2e`，`dsh --profile e2e --from-default-profile web` 生成 → bundles = `dsh-base` + `dsh-web-app` + 本插件 |
| 插件安装 | `pnpm pack` 打出 `wjj865-code-dsh-orchestrator-0.26.0.tgz`，`dsh plugin --profile e2e add <tarball>`；**安装副本已确认含本轮改动**：`skills/grill-me/SKILL.md`、`skill-grill-me.js`、`cordis.patch.yml` 的 `tool-fs(read:true)` / `skill-grill-me` / `tool-skill` |
| 模型 | 本地 Messages 兼容 stub（`harness/mock-llm.mjs`），`DEEPSEEK_BASE_URL` 指过去 + 假 key；不消耗真实额度。stub 记录每次请求的 `tools[]`、技能目录与全部 tool_result，所以工具表/读取结果的结论是宿主真实请求体 |
| 端口 | DSH Web `127.0.0.1:54326`（`--no-open`）、模型 stub `127.0.0.1:47223`、Chrome CDP `9533` |
| 浏览器 | 系统 Chrome `--headless=new`，独立 `--user-data-dir`，原生 CDP（`harness/cdp.mjs`，无第三方依赖） |
| 时间窗口旁路 | `DSH_ORCH_PROGRESS_MS=3000`（**只**缩短同任务 progress 水位；5 秒合并窗口仍是默认 5000，没改语义；见 `docs/testing.md` §3.2 口径） |

启动方式（PowerShell；token 每次随机）：

```powershell
$env:DSH_HOME='<temp>\home'
$env:DEEPSEEK_BASE_URL='http://127.0.0.1:47223'
$env:DEEPSEEK_API_KEY='sk-e2e-mock-0000000000'
$env:DSH_ORCH_PROGRESS_MS='3000'
dsh --profile e2e --no-open --port 54326 --host 127.0.0.1
```

## 2. ① 协调者工具表与技能目录

第一个协调者请求（`CHECK_TOOLS`）里宿主真实下发的工具集合（`evidence/tool-tables.json`）：

```json
["ask_user_question","context","glob","grep","memory_note","present","read","read_workspace",
 "schedule_create","schedule_edit","schedule_list","schedule_view","skill","task_create","task_list",
 "task_message","task_status","working_directory"]
```

- 只读文件/技能面**已挂上**：`read` / `glob` / `grep` / `skill`；**没有** `write` / `edit` / `pwsh` / `bash` / `apply_patch`；角色专属的 `task_report` / `task_detail` / `plan_save` 也不在（被预设 `preset-tools` 的 deny 遮掉）。
- 技能目录（宿主注入的 `<available_skills>`，本会话共 6 个）：`diagnose-windows-sandbox-acl`、**`grill-me`**、`office`、`office-docx`、`office-pptx`、`office-xlsx`。`grill-me` 的目录行来自随包 `SKILL.md` 的 frontmatter：

```text
- `grill-me`: 动手前把需求拷问清楚：一次只问一个决定性问题、每问都带我的推荐、事实我自己查、决策归你，最多 2 轮 8 问，最后给一张三栏决策记录。
```

- 预设行证据（安装副本 `cordis.patch.yml`）：`tool-fs { read: true, readImage/write/edit/applyPatch: false }`、`tool-fs-search`、`skill-grill-me`、`tool-skill` 四行都在协调者预设里；worker 预设不挂 `skill-grill-me`（只有 `skill-filesystem` + `tool-skill`）。

## 3. ② read 读 target 产物与技能文件

协调者用 `read` 读了两类路径（原文见 `evidence/read-and-skill.json`）：

```text
<path>…\targets\target-main\artifact.txt</path><type>file</type><content>1: artifact-from-target-main
<path>…\profiles\e2e\node_modules\@wjj865-code\dsh-orchestrator\skills\grill-me\SKILL.md</path>
  1: --- 2: name: grill-me 3: description: 动手前把需求拷问清楚…
```

`skill({name:'grill-me'})` 返回技能正文（`<skill_content name="grill-me">…</skill_content>`，含「一次只问一个决定性问题」「grill ≠ 批准」等全文）。同一轮里 `read` 读的是**工作区之外**的路径（temp target 与安装目录），说明协调者读能力按设计不受工作区/产物登记限制（`docs/LIMITATIONS.md`「协调者读文件」已写明这是残留风险，不是本轮缺陷）。

## 4. ③ read-only 权限下的写拒绝

派 `task_create({ readOnly: true })`，子会话先 `skill('grill-me')` 再尝试 `write` 到 target：

```text
Error: skill "grill-me" is unknown or no longer available
Error: [sandbox: file access denied under read-only mode]
[sandbox: escalation available — retry this exact operation once with sandbox_permissions …]
```

- 目标文件 `targets/target-ro/ro-blocked.txt` 不存在（`evidence/readonly-denials.json`）。
- 子会话日志（`evidence/session-events.json`，readonly-deny）：`agent-preset/selected worker` + `sandbox/mode read-only (source=delegation)`，**没有**后续 `workspace-write` 事件——只读没有被插件「救回」成可写。
- 拒绝是沙箱层的（不是工具不存在）：同一个 worker 的 `write` 工具存在，调用后才被沙箱拒；可读错误文案完整。

## 5. ④ 用户手动切 danger-full-access

在输入区执行 `/permission danger-full-access`（无需确认弹窗）：

| 观察点 | 结果 |
|---|---|
| 徽标 | `{"aria":"访问模式，当前：完全权限","text":"完全权限"}`（`screenshots/12-permission-full.png`） |
| 会话日志 | `permission/preset danger-full-access` (seq 275) → `sandbox/mode danger-full-access` (276) → `approval/policy never` (277) |
| 工具表 | 切换前后**逐名相同**（18 个，`sameAsBefore: true`、`added: []`）；依然没有写/命令工具（`screenshots/13-after-switch.png`、`evidence/tool-tables.json`） |
| 写放开 | 主会话本身没有写工具，**无法**在会话内直接发起写；因此用同一沙箱模式的对照实验取证：`access:'full'` 子会话（`sandbox/mode danger-full-access`）成功写到 **target 之外** 的 `outside-full/out.txt`（内容 `written-by-full-access`），而只读子会话写同一批目标是 `[sandbox: file access denied under read-only mode]`——同一张沙箱策略表，模式一换写就放开（`evidence/full-access.json`、`evidence/session-events.json`） |

## 6. ⑤ worker 子会话看不到 grill-me

- worker 请求的 `<available_skills>` 目录共 **14** 个（都是宿主自带的 `brainstorming`/`office`/…），**没有 `grill-me`**（`evidence/tool-tables.json`）。
- worker 调用 `skill('grill-me')` 的返回：`Error: skill "grill-me" is unknown or no longer available`。
- 结论：技能注册在协调者预设作用域（`skill-grill-me` 只挂协调者预设），worker 预设不挂 → 子会话既看不到目录也加载不了；不是靠工具遮罩实现的。

## 7. ⑥ 回归：主会话徽标钉 read-only + 普通任务可写

- 新建主会话：徽标「仅可查看」（`screenshots/02-main-badge-readonly.png`），会话日志 `permission/preset read-only` (seq 3) + `sandbox/mode read-only` (4)；插件审计 `main.session.permission-pinned { from: workspace-write, preset: read-only }`。
- 用户切成 full 后再次点侧栏「主会话」：徽标拉回「仅可查看」（`screenshots/14-reopened-readonly.png`），插件审计再记一条 `permission-pinned { from: danger-full-access, preset: read-only }`，会话日志 seq 292–294 回到 read-only + approval ask。
- 普通任务子会话：`sandbox/mode read-only (delegation)` → `workspace-write (delegation)`（seq 2→6，早于首个模型请求），插件审计 `subagent.workspace-write` + `subagent.writable-root`；实际写盘成功 `targets/target-normal/worker-ok.txt`（内容 `written-by-worker`，`evidence/normal-task.json`）。
- 对照：运行中的主会话徽标仍是「仅可查看」时，同屏子会话任务照常写文件（`docs/testing.md` §7.2 #13 口径）。

## 8. progress 通知必达（t-99d4a98c 修复）实测

### 8.1 正常 progress：合并窗口 / 水位 / 尾沿

`evidence/progress.json` 的关键行（`notifications` 表，共 11 行）：

| id | task | level | status | reason |
|---|---|---|---|---|
| 3 | 进度通知 | coalesce | delivered | — |
| 4 | 进度通知 | coalesce | **skipped** | **progress_watermark** |
| 5 | 进度通知 | coalesce | delivered | —（水位到点尾沿补投 p2） |
| 6 | 进度通知 | coalesce | delivered | —（追问答复） |
| 7 | 进度通知 | notify | delivered | —（3 次 progress 的「可能卡住」提示，既有行为） |

时间线（`progress.json.timings`）：

- p1：tool_result 后 **5075 ms** 送达 → 正好是默认 5 秒合并窗口。
- p2：在 p1 送达后 3 秒水位内上报 → 先落 `skipped + progress_watermark` 审计行，水位到点（p1 送达 + 3 s）尾沿补投，**2010 ms** 后送达。
- 送达文案：`任务「E2E 进度通知 SCN=progress」有新进展：进度 1/2：环境已就绪 …` 并附 `PROGRESS_NOTICE_HINT`（「要结论就 task_message 追问同一子会话，别为此重派任务」）。

### 8.2 追问场景：回答追问的第一条 progress 立刻送达

1. 主会话对运行中任务调用 `task_message({ action:'message', task_id, message:'先给部分结论…' })`（插件 `report_expected_at` 置位）。
2. 子会话在同一会话里报 `task_report(progress, summary:'追问答复：…')`。
3. 通知在 tool_result 后 **10 ms** 送达（不等合并窗口、不看水位），文案带 **「有新进展（回答你的追问）」**：

```text
任务「E2E 进度通知 SCN=progress」有新进展（回答你的追问）：追问答复：已完成一半，剩下的是收尾（answeredFollowup 验证）。
```

4. 插件审计 `task.report` 同一条带 `"answeredFollowup": true`（`evidence/plugin-audit-picks.json`），与 `notify.delivered`（notificationId 6）时间对齐。

### 8.3 回归：done / blocked / needs_auth 分级与合并窗口

| 状态 | level | 送达延迟（tool_result → 通知请求） | 文案形态 |
|---|---|---|---|
| `done`（→ delivered） | `notify` | **5053 ms**（5 秒合并窗口） | `任务「E2E done 分级」已交付待确认：…` |
| `blocked` | `interrupt` | **22 ms** | `任务「E2E blocked 分级」需要你：… 问题/选项` |
| `needs_auth` | `interrupt` | **7 ms** | `任务「E2E needs_auth 分级」需要你：… 问题/选项` |

对应 notifications 行：done = level `notify` delivered；blocked/needs_auth = level `interrupt` delivered（`evidence/status-grading.json`、`evidence/progress.json`）。

## 9. 待确认差异与已知噪音

1. **协调者工具表多出 `working_directory`（已在发版前处理）**：0.26.0 把协调者的 `preset-tools` 从「allow 补集」改成「deny 点名」后，宿主全局工具 `working_directory`（切换会话 cwd，不写文件）不再被遮，出现在 18 个工具里。README「工具清单」只写了 `read`/`glob`/`grep`/`skill`，没有这个工具。建议：要么把它加进 `COORDINATOR_DENY`（与「协调者不执行命令/不改变工作目录」口径一致），要么在 README/文档里补一句「另有宿主导航工具 `working_directory`」。**发版前已按方案①处理（`t-740b8b7a`）**：协调者预设 `preset-tools.deny` + 执行层 `COORDINATOR_DENY` 两处都加（cwd 是指挥锚，会话内切目录会让子会话默认目录/写域/记忆项目键静默漂移），文档与测试同步；理由与落点见 CHANGELOG 0.26.0「发版前修正」。本节其余判据不受影响。
2. **progress 的「可能卡住」提示会与第三次 progress 叠加**：同任务连续 3 次 progress 会触发既有 stall 提示（`notify` 级），它会把同任务的 progress 覆盖成 `progress_superseded` / 进入同一合并批次。这是 `recordProgress` 的既有行为（3 次心跳提醒），不是修复回退；实测时用「先等 stall 提示出窗口再派下一个任务」隔离。若用户希望长任务的心跳不触发 stall，需要单独改阈值（不在本批范围）。
3. **`read`/`glob`/`grep` 可读全盘**（含凭据）：这是 0.26.0 已写进 README/LIMITATIONS 的残留风险，本轮实测确认读能力按设计不受工作区限制；只是提示词要求「不读凭据、不转述」，没有执行层黑名单。
4. **`DSH_ORCH_PROGRESS_MS=3000` 是测试旁路**：只缩短 progress 水位以便在几十秒内实测「水位压住 + 尾沿补投」；5 秒合并窗口与所有语义用默认值。生产不受影响（该变量不进配置面）。

## 10. 清理

- 验证结束后已停止 DSH / mock / 无头 Chrome 进程，删除临时 `DSH_HOME`、Chrome profile、大体积 mock 抓包；**本次验证实例全程用临时 `DSH_HOME` 启动，没有用用户真实 profile 启动实例、没有读取用户真实凭据**（用户自己的 DSH Web GUI 仍在 53761，未被本验证启停或改配置）。
- 仓库只新增本报告目录（`reports/skill-and-readonly-tools-verify/`）；0.26.0 同批改动文件未做任何修改。

## 11. 复跑方式

`harness/` 内脚本无第三方依赖（Node ≥ 22，`node:sqlite` 读台账）：

```powershell
node harness/mock-llm.mjs                    # 1) 模型 stub（环境变量见文件头）
$env:DSH_HOME=<temp>; dsh --profile e2e --no-open --port 54326 --host 127.0.0.1
$env:DSH_URL='http://127.0.0.1:54326/?token=<token>'
$env:E2E_OUT=<temp>\artifacts; $env:E2E_BASE=<temp>
node harness/drive.mjs                       # 2) 全量驱动（截图 + drive-results.json）
node harness/collect.mjs                     # 3) 归一化证据（evidence/*.json）
```

单轮约 3–4 分钟（progress 水位 3 秒 + 每个状态一次 5 秒合并窗口）。`harness/asar-extract.mjs` 只读解析宿主 `app.asar`（核对 `dsh-tool-skill` / `dsh-skill` 契约用，不参与判据）。
