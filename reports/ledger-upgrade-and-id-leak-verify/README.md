# 发版前验证：真实台账升级 + 用户面 ID 泄漏率抽查（0.32.1 前置）

日期：2026-11-22｜被测代码：`main` @ `79f5824`（四个分支合并后、未 bump 版本，`package.json` 仍是 0.32.0）
结论：**① 真实台账副本升级 29/29 PASS；② 4 条真实任务流的用户可见文本裸编号泄漏 = 0 条 / 47 个消息单元（0%）**。
另有 1 个**交付确认文案缺陷**（结算路径的 delivered 通知里 `task_id` 为空串）需要修，见 §6.1。

| # | 验证项 | 结果 | 证据 |
| --- | --- | --- | --- |
| ① | 真实台账副本：`task_refs` 自动建表/回填、`plan_path`、计数、integrity、幂等、旧任务解析、墓碑、原库 sha256 | **PASS 29/29** | `evidence/ledger-upgrade.json` |
| ② | 隔离 DSH_HOME + Web 测试 profile + mock 模型，4 条任务流（create → 子会话执行 → report → message 追问/close） | **PASS 4/4 流程走完** | `evidence/drive-results.json`、`screenshots/` |
| ② | 用户可见文本裸 `t-xxxx` 泄漏率 | **0 / 47（0%）**；更宽口径 0 条真实编号（仅 1 处模板字样 `t-xxxx`） | `evidence/id-leakage.json` |
| ② | 根因面：模型上下文里的真实编号 / `task_id` 入参形态 | **0 条**；84 次 `task_id` 入参全部是 `tk-` | `evidence/id-leakage.json` |
| — | 原库只读（前后 sha256 一致）、临时目录/进程/端口清理 | **PASS**，无发版、无 push、无 bump | 见 §2、§5 |

## 1. 环境与隔离

| 项 | 值 |
| --- | --- |
| 真实台账 | `C:\Users\72489\.dsh\state\orchestrator\tasks.sqlite`（**只读**，仅经只读连接 + 副本操作） |
| 升级验证方法 | 只读连接上 `VACUUM INTO` 一致性快照到临时目录（源库不写），再用**合并后**的 `src/ledger.js` `openLedger` 打开副本；副本三份（升级/幂等/墓碑）用完即删 |
| 泄漏抽查 `DSH_HOME` | `%TEMP%\orch-leak-verify\home`（验证后整目录删除） |
| profile | `lkweb`，`dsh --profile lkweb --from-default-profile web` 生成；`dsh plugin --profile lkweb add link:<仓库>` **link 到本仓库工作树**（测的就是合并后的代码） |
| 宿主 | `dsh 0.2.2-rc.5`，`dsh --profile lkweb --no-open --port 54477 --host 127.0.0.1`；Web 测试 profile，不碰 Desktop |
| 模型 | 本地 Messages 兼容 stub（`harness/mock-llm.mjs`），`DEEPSEEK_BASE_URL=http://127.0.0.1:47331` + 假 key，不读用户凭据、不烧额度 |
| 浏览器 | 系统 Chrome `--headless=new` + 独立 `--user-data-dir` + 原生 CDP（`harness/cdp.mjs`），只驱动测试实例 |
| 时间窗口 | `DSH_ORCH_NOTIFY_MERGE_MS=0`、`DSH_ORCH_PROGRESS_MS=1000`（只缩窗口、不改语义） |
| 测试数据 | 临时 `target-a..d`（A 写说明文件，B 读同一文件，C/D 空目录） |

隔离证明：验证期间真实 `~/.dsh` 只被**只读**打开（副本由 `VACUUM INTO` 产出，前后 sha256 一致，见 §2.3）；Desktop 实例零重启、零改动；没有新增依赖、没有改插件代码。

## 2. ① 真实台账副本升级

### 2.1 方法

1. 打开源库的**只读**连接，取当前计数（tasks 376 / messages 1102 / notifications 421 / memories 483 / settings 12 / automations 1 / groups 50）。
2. `VACUUM INTO '临时目录/tasks.sqlite'` 产出一致性快照（WAL 已并入）；确认副本计数与源库只读连接一致（不是旧状态）。
3. 用合并后的 `openLedger(临时目录)` 打开副本 → 记录 `task_refs`、`tasks.plan_path`、各表计数、`PRAGMA integrity_check`、引用回填质量。
4. 关闭后再打开一次 → 幂等校验（token/task_id/created_at 完全一致）。
5. 第三份副本上 `deleteTask()` → 墓碑语义；重开台账确认墓碑不补回、任务不复活。
6. 前后对源库 `tasks.sqlite` / `-wal` / `-shm` 取 sha256 与 mtime，确认只读。

脚本：`harness/verify-ledger-upgrade.mjs`（可复跑：`node --disable-warning=ExperimentalWarning reports/ledger-upgrade-and-id-leak-verify/harness/verify-ledger-upgrade.mjs`）。

### 2.2 结果（29/29 PASS）

| 验证点 | 结果 |
| --- | --- |
| 升级前副本无 `task_refs`、`tasks` 无 `plan_path` | 是（7 张表；`plan_path` 缺失） |
| 新版 `openLedger` 自动建 `task_refs` | 是 |
| `tasks.plan_path` 补列 | 是 |
| 任务/消息/通知/设置/记忆/组计数不变 | 376 / 1102 / 421 / 12 / 483 / 50 全部前后一致 |
| `PRAGMA integrity_check` | `ok`（第一次打开、第二次打开都 ok） |
| 引用回填 | 376 行 = 376 任务；`token` 形状全部 `tk-` + 6 位；无重复 token、无重复 task_id；无「有任务无引用」、无「引用指向已删任务」 |
| 回填只补缺的 | 引用数 = 任务数，无墓碑行被补 |
| 历史任务 `t-xxxx` 仍可解析 | 抽查 8 条（running/done/delivered/failed/cancelled 各状态）：`resolveTaskInput('t-…')` 走 `via:id` 成功；同任务的 `tk-` 走 `via:ref` 成功；`getTask().ref` 与 `task_refs` 一致 |
| `task_id` 仍接受 `t-xxxx` | 8/8 通过 `TASK_ID_RE` |
| 幂等（第二次打开） | 任务/消息/引用数不变，`(token, task_id, created_at)` 全等，integrity ok |
| 删除任务 → 墓碑 | `deleteTask` 后：任务行消失、`taskRefOf` 返回 null、按 `tk-` 解析返回「已失效（retired）」、按 `t-` 解析返回「找不到」 |
| 墓碑重开不被补回 | 重开台账后墓碑行仍在（`retired_at` 有值）、任务不复活 |
| 原库只读 | `tasks.sqlite` sha256 `5af915da…e619` 前后一致；`-wal` / `-shm` 一致；mtime/size 未变 |

结论：**旧库升级路径可用、幂等、不丢数据、不产生重复 token；旧任务两种引用都能解析，删除任务的墓碑语义正确。**

### 2.3 源库 sha256（前 / 后）

```
main: 5af915da83f012b730b46ab0a81dca61676b34699e09c8efb2a773b65997e619  (前、后一致)
-wal: 26f1ac1f592c6a679afb3d3df6812df5a5662ba75258a7b3f4c090385f4967a6  (前、后一致)
-shm: 5501e9047e2adc186fb5e37b24d98f80ece4a7d8b0c3090a17d7ad073fccae4c  (前、后一致)
```

> 注意：用户真实的 DSH 实例在验证期间仍在运行，它自己会为该任务/会话写台账。上表证明的是**本次验证没有写源库**；验证之外宿主自身的写入不在此列。
> 收尾复核（验证结束后）：`tasks.sqlite` 主文件仍是 `5af915da…e619`（mtime/大小未变）；`tasks.sqlite-wal` 有变化，来自宿主自身对当前任务的写入。

## 3. ② 泄漏率抽查

### 3.1 口径（先定义，再看数）

**分母 = 去重后的「用户可见消息单元」**（4 类，实时抓自动作后的会话/台账/屏幕）：

| 类 | 来源 | 本次单元数 |
| --- | --- | --- |
| U1 协调者回复正文 | mock 每次 text 决策（= 主会话里逐条显示的助手回复） | 11 |
| U2 任务通知正文 | 注入协调者的「任务「…」…」交付/进展/阻塞通知（GUI 显示为用户消息） | 9 |
| U3 台账 `messages.rendered` | 面板「消息」/`task_detail` 读到的渲染文本 | 19 |
| U4 台账任务字段 | `title` / `question` / `options` / `last_message.summary` / 产物 `label` | 8 |
| **合计** | | **47** |

**分子 = 这些文本里 `\bt-[0-9a-z]{4,32}\b` 的出现次数**；编号形态再分两层：
- **真实台账编号** = `t-` + 8 位十六进制（`createTask` 生成，能反查到唯一任务）——这才是「泄漏」；
- **模板字样** = 其它匹配（如插件提示词里的示例 `t-xxxx`）——单列，不算泄漏。

**参考口径（更宽）**：再加 R1 用户手打提示（4）、R2 平台/插件 system-reminder 与策略正文（9）、R3 浏览器整页可见文本去重行（103）→ 163 单元。
**根因面（不进分母）**：模型上下文（tool_result / brief / task_detail）里的真实编号；`task_id` 工具入参的形态。

对手模型是「不老实」的：mock 会把上下文里看到的**真实编号**（`t-` + 8 hex）原样抄进回复与 `task_report.summary`。所以「有没有泄漏」等价于「编号有没有漏到模型手里」——漏了就会被抄进用户可见文本。

### 3.2 4 条任务流（全部走完、全部收尾）

| 流 | 内容 | 命中路径 | 结果 |
| --- | --- | --- | --- |
| A | 普通任务：写 `note-a.md` → 交付 → `task_message(message)` 追问 → 二次交付 → `close` | `task_create`→worker(`task_detail`+`write`)→`task_report(done)`→追问→`progress`+`done`→close | PASS（6 条任务消息，状态 `done`） |
| B | 只读任务：读 `note-a.md` → 交付 → `close` | `readOnly:true` 子会话（read-only 沙箱）→`task_report(done)`→close | PASS（3 条，`done`） |
| C | blocked（带问题/选项）→ 协调者 `task_message` 拍板 → 交付 → `close` | `task_report(blocked)`→通知「需要你」→续派→`done`→close | PASS（5 条，`done`） |
| D | 连续两次 `task_report(progress)` → 交付 → `close` | `progress` 通知 ×2 →`done`→close | PASS（5 条，`done`） |

mock 决策分布：`task_create`×4、`task_detail`×4、`write`×1、`read`×1、`task_report` done×5 / progress×3 / blocked×1、协调者 `task_message`×6（message×2、close×4）。子会话侧 `task_id` 全部用 brief 里的 `tk-`。

### 3.3 泄漏统计

| 口径 | 单元数 | 真实编号命中 | 模板字样命中 | 泄漏率 |
| --- | --- | --- | --- | --- |
| **主口径（用户可见 U1–U4）** | **47** | **0** | **0** | **0%（0/47）** |
| 参考口径（+提示/system 文本/浏览器行） | 163 | 0 | 1（`t-xxxx`，插件策略示例，非真实编号） | 0 条真实编号 |
| 浏览器整页文本（4 个流程 + 任务面板） | 103 行 | 0 | 0 | 屏幕上一条都没有 |
| 根因面：模型上下文里的真实编号 | 45 个请求 | **0 次** | 24 次（同一段策略里的 `t-xxxx` 示例） | — |
| `task_id` 工具入参形态 | 84 次 | 裸 `t-`：**0** | `tk-`：**84** | — |

**样本（用户可见文本，均只出现 `tk-`）**

```
协调者回复：已派发：说明文件编写（泄漏抽查 A）（tk-vua57k），等它交付后我追问一句再收尾。
通知正文：任务「说明文件编写（泄漏抽查 A）」已交付待确认：说明文件已写入 target（note-a.md）。
         交付确认：…再 task_message({ action: "close", task_id: 'tk-vua57k' })；…
通知正文：任务「只读核对（泄漏抽查 B）（只读）」已交付待确认：只读任务：已读取说明文件，未写任何文件。
协调者回复：已收尾：分阶段推进（泄漏抽查 D）（tk-r9ps6t）。
```

- 交付通知里的「交付确认」共出现 63 次（去重 5 条，A 两条、B/C/D 各一条），**全部**带 `tk-` 引用（`withoutRef = 0`）。
- 页面上没有任何 `t-` 形态的串（包含任务面板 innerText）；`screenshots/02-flow-*.png`、`03-task-panel.png` 可核对。

## 4. 未覆盖项

1. **计划模式 / `plan_save`**：本次 4 条流不含 `planFirst`，计划文档正文的出口清洗（`plan_save` 落盘前清洗）没有在真机路径上跑；单测已覆盖（`test/plan-save.test.js`、`test/exit-gateway.test.js`）。
2. **worktree / `access:'full'` / 官方 Team 板 / 续跑（resume）文案**：未在本次流里触发；其出口走同一套标签与清洗函数。
3. **真实模型**：mock 是脚本化对手（会 echo 真实编号，但不会自己编）；真实模型在长对话里「凭记忆拼 id」的尾部风险仍未测。
4. **面板筛选/搜索/详情抽屉的逐屏文本**：只抓了任务面板整页与每轮会话页；抽屉深层的键盘/滚动场景未逐项点。
5. **Desktop 入口**：按要求完全未碰；Web 测试 profile 的结论不覆盖桌面特有分支。
6. **用户真实台账上的版本 B 行为**：只在副本上验证了升级；真实实例重启后才有 `task_refs`，本次不重启用户 DSH。

## 5. 清理与边界

- 隔离 `DSH_HOME`、mock stub、headless Chrome、`dsh web` 测试实例全部停止/删除；`%TEMP%\orch-leak-verify` 已不存在；没有残留 headless Chrome（按 `--user-data-dir` 匹配确认）。
- 真实台账、真实凭据、Desktop profile、用户浏览器进程零改动。
- 未 `push`、未改版本号、未改业务代码（仓库只新增本报告目录与 harness 脚本）。

## 6. 风险与发现

### 6.1 【需修】结算路径的 delivered 通知缺 `ref` → 「交付确认」提示里 `task_id` 为空串

- 现象（第一轮隔离实例实测，`evidence/settlement-empty-ref.json`）：
  `用户明确说确认完成时再 task_message({ action: "close", task_id: '' })；…`
  白话：协调者按提示调用 close 时会传空 `task_id`，只能自己回想原始回执里的引用。
- 触发条件：子会话**自然结束、没有自己调 `task_report`** → `src/settlement.js` 合成 delivered 通知。这是最常见的收场路径之一（worker 干完活直接结束回合）。
- 根因：`src/settlement.js:82-96` 的 `notifier.push({...})` 没有带 `ref`；而 `src/tools.js:2092`（task_report 路径）带了 `ref: next.ref`，所以自报 done 的路径提示正常（本次 4 条流 63 次全部带引用）。
- 修改建议（未改，按任务约束只报告）：`settlement.js` 的 notify 项补 `ref: task.ref`（`task` 已是台账行，`getTask`/`transition` 都带 `LEFT JOIN task_refs`）；顺手给 `test/settlement.test.js` 加一条「delivered 通知的交付确认含 tk-」的断言。
- 影响面：文案层（协调者动作提示），不泄漏编号、不影响状态机；但会让「确认交付」这一步在自然收场路径上多一次猜引用。

### 6.2 模板字样 `t-xxxx` 仍在协调者策略正文里（进模型上下文，不进屏幕）

- `task_ref` 相关规则里写的是「不要出现 `t-xxxx` 这类内部编号」——这是**说明文字**，被 system-reminder 原样喂给模型；本次宽口径命中就是这一处（24 次请求、1 个去重文本）。
- 不是泄漏：它不是任何真实任务编号，屏幕/回复/台账里都没有；但它是模型唯一见过的 `t-` 形态串，若真实模型被诱导「复述你见过的编号」，它可能抄出 `t-xxxx`（无意义串）。建议版本 C 顺手改成 `t-…` 或 `内部编号` 字样。

### 6.3 泄漏率 0% 的适用范围

本次 0/47 的成立前提是**模型手里没有真实编号可抄**（根因面 0、84 次入参全 `tk-`）。这不能推出「任何真实模型、任何超长会话都不会泄漏」：
- 版本 C（宿主 `llm/stream` / `tools/post-execute` 改写回复正文与工具结果）**仍未做**（`docs/ARCHITECTURE.md` §「ID 出口网关」第 ③ 层）；
- 模型仍可能从「用户自己贴的 id」或历史对话里拿到编号——这类输入不在本次口径内；
- 建议上线后按同样口径在真实会话里抽查一轮（尤其自然结算 + 长会话）。

### 6.4 其它观察

- 新库上 `task_refs` 与 `tasks` 一一对应；实例重启/二次打开不会重复生成 token（与本轮副本幂等结论一致）。
- 任务面板整页文本无任何 `t-`（含「最近任务」/消息区），说明面板侧出口与台账侧一致。
- 交付通知文案较长（每条都带两段动作指令），在 GUI 里占屏明显；属文案取舍，不是缺陷。

## 7. 复跑

```powershell
# ① 真实台账副本升级（只读，自动清理临时目录）
node --disable-warning=ExperimentalWarning reports/ledger-upgrade-and-id-leak-verify/harness/verify-ledger-upgrade.mjs

# ② 泄漏抽查：先起隔离实例（见 harness/README.md），再跑驱动 + 统计
$env:DSH_URL='<dsh web 打印的带 token URL>'; $env:E2E_OUT='<artifacts>'; $env:E2E_HOME='<home>'
node --disable-warning=ExperimentalWarning reports/ledger-upgrade-and-id-leak-verify/harness/drive-leak.mjs
node --disable-warning=ExperimentalWarning reports/ledger-upgrade-and-id-leak-verify/harness/analyze-leak.mjs
```

证据文件：

| 文件 | 内容 |
| --- | --- |
| `evidence/ledger-upgrade.json` | ① 的 29 项检查明细、源库前后 sha256、计数、引用/墓碑/幂等结果 |
| `evidence/id-leakage.json` | ② 的口径、各单元统计、回复/通知样本、根因面、`task_id` 形态、交付确认样本 |
| `evidence/drive-results.json` | 4 条流每轮的页面文本、台账状态、截图清单 |
| `evidence/mock-decisions.jsonl`、`mock-requests-lite.jsonl` | mock 每次决策与请求（去掉大请求体） |
| `evidence/settlement-empty-ref.json` | §6.1 的第一轮实测样本 |
| `screenshots/` | 初始页、主会话、4 条流收尾、任务面板 |
