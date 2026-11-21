# 修复：开包会话 `sessions.retain: unknown session`（t-8a81264c）

日期：2026-11-21｜版本：0.32.0（不 bump、不 push，本地 commit）｜真机验证：隔离 `DSH_HOME` + 临时 profile `packfix`，**9/9 PASS**

用户原话：> 开包会话失败：sessions.retain: unknown session session-003fe106-12d8-46b1-9029-78200fa8c127

## 1. 结论

会话**创建是成功的**（插件日志有 `pack.open` + sessionId，会话也落到了磁盘）。报错发生在**创建之后**：客户端拿到 sessionId 就立刻调 `uiWorkspace.openSession` → 宿主 `sessions.retain()`，而宿主只认**已经出现在客户端会话目录里的 id**；新会话的目录行走 WebSocket 的 `api-session/added` 事件、`pack-open` 的结果走另一条 HTTP 通道，**两者没有顺序保证**。事件还没落地时，`retain` 同步抛 `sessions.retain: unknown session <id>`。

这是**时序竞态**，不是创建顺序、不是返回值形状、也不是服务签名错。同一竞态在「新建协调者会话」链早就有：`docs/ARCHITECTURE.md:45` 与 `client/src/nav.js:9-13` 的注释写着「宿主拒绝（`sessions.retain: unknown session`，新会话广播未到）最多试 3 次」——那条链用重试兜住了，**开包会话这条链没有**。

另外查出一个同链路的**第二层缺陷**（用户报错之后会撞上的）：`sessionController.create` 只给 `cwd` 时宿主**不会** `attachSession`（只有 `workspaceId` 分支才挂，宿主 `commands.ts` 的 `create`）。会话因此落在「未分组」，UI 打开后只显示「选择一个工作区开始」而不是正常会话视图——真机复现截图见 `reports/pack-open-fix/evidence/before-fix-placeholder.png`。

## 2. 根因与调用链（file:line + 证据）

### 2.1 失败调用链

```text
client/src/capability-packs.js:177-195（修复前 180-181，commit e53153c）
  const body = await openPackSession(pack.id)     # POST /api/orchestrator {endpoint:'pack-open'}
  openSession(body.sessionId)                     # 无重试，紧跟着就跳
    → client.js:283  ctx.uiWorkspace.openSession(sessionId)
      → @deepseek-ai/dsh-client-ui-workspace src/client/navigation.ts:523-553  replaceMain()
        → this.sessions.retain(target, { source:'mainView' })     # navigation.ts:530
          → @deepseek-ai/dsh-api-session-controller src/client/sessions/service.ts:301-314  retain()
            → src/client/sessions/manager.ts:140-152  resolveTarget()
              → manager.ts:147  throw new Error(`sessions.retain: unknown session ${id}`)
```

`resolveTarget` 的通过条件（manager.ts:143-147）：id 在 `this.sessions`（已物化的 Session 实例）**或** `this.summaries`（客户端会话目录）**或** 有子会话地址。三者都没有就抛——报错文案与用户截图逐字一致。

### 2.2 为什么客户端会话目录里会“晚到”

- 客户端目录的增量来源是宿主事件：`dsh-api-session-controller src/client/index.ts:116` `ctx.remote.$on('api-session/added', …)`；宿主在 `session/created` 时 `emit('api-session/added')`（宿主 `src/index.ts:224-226`）。
- 事件走 **WebSocket**（remote 事件总线），而 `pack-open` 的结果走 **HTTP**（`ctx.connection.fetch.register`，见 `docs/probes/client-slots-probe.md` §3「数据走 host 只读路由」）。两条通道的**投递顺序不保证**：HTTP 响应先被处理，`retain` 就会撞空。
- 事件一旦落地是**立刻**进目录的（manager.ts:582-587 `recordMutation` 先写内存再排队），所以这是纯粹的“还没到”，不是“永远不到”。

### 2.3 日志/现场证据（用户真机）

`reports/pack-open-fix/evidence/user-host-failure.txt`：

- `$DSH_HOME/state/orchestrator/logs/orchestrator-2026-11-21.jsonl:1240`
  `{"at":"2026-11-21T13:31:38.407Z","event":"pack.open","detail":{"id":"wechat-mp-article","sessionId":"session-003fe106-12d8-46b1-9029-78200fa8c127"}}`
  → 创建成功、返回了 sessionId（不是 `SESSION_CREATE_FAILED`）。
- `~/.dsh/sessions/--C-Users-72489-.dsh-state-orchestrator-workspace--/session-003fe106-…/session.v4.jsonl.zstd`（440 B，裸会话头）
  → 会话确实建出来了；目录名按 cwd 归到「指挥舱」工作区路径。
- 用户 UI 原文：`sessions.retain: unknown session session-003fe106-12d8-46b1-9029-78200fa8c127`
  → 与宿主抛错点逐字一致；说明 `create` 之后才失败。

### 2.4 逐项排除

| 候选 | 结论 | 依据 |
|---|---|---|
| 创建顺序（先 open 后 create） | 否 | 日志顺序：`pack.open` 在报错之前；`open` 里 `await create` 之后才返回 sessionId（`src/pack/service.js:400-445`） |
| `controller.create` 返回值形状 | 否 | 宿主返回 `{ sessionId, agentPreset? }`（宿主 `commands.ts:158`）；插件取 `created?.sessionId`，日志证明拿到了 |
| 服务签名（`sessions.retain`） | 否（但这是**报错点**） | `retain(target, {source})` 签名正确；它校验的是客户端目录，不是服务端 |
| 生命周期（会话没活/被删） | 否 | 会话进程内 live、磁盘在；`api-session/added` 事件本应把它写进目录，只是**晚于** HTTP 响应 |
| **workspace 归属** | **是第二层缺陷**（不是 retain 报错原因） | 宿主 `commands.ts:121-157`：只给 `cwd` → 不 `attachSession`；真机复现（隔离环境）UI 显示「选择一个工作区开始」，会话落「未分组」 |

## 3. 修复

### 3.1 客户端：等会话目录就绪再跳（`client/src/open-session.js`（新）+ `client/src/capability-packs.js:177-195`）

- 只对 `unknown session` 这类错误短退避重试 4 次（≈120/240/360 ms，总共 ≈0.7 s 等待）；其它错误（旧宿主没有 `openSession`、宿主真拒绝）**立即失败**，不掩盖真故障。
- 仍失败就给可读降级，不吞错、不重试创建：
  `已建好（session-xxx），但打不开：<宿主原文>。请从左侧列表打开。`
  会话此时已经在左侧「指挥舱」下可见（真机截图同屏可见），手动点开即可。
- 选重试而不是「先 refresh 会话列表」：与 `client/src/nav.js` 已有先例同口径（宿主广播通常只差几十毫秒）；且 `refresh()` 与在途 list 拉取复用时会返回**早于 create** 的结果（宿主 `manager.ts:395-419` + `ordered-baseline.ts:1-10`「baseline 里没有的 id 会被删掉」），反而可能把已到的行删掉。真丢了广播的极端情况由「请从左侧列表打开」兜底（见 LIMITATIONS）。

### 3.2 服务端：包会话挂进目标目录所属工作区（`src/pack/service.js:378-441`、`index.js:946-950`）

- `open` 先用宿主 `workspaceRegistry.resolveByPath(cwd)` 找目标目录所属工作区：找到就 `create({ workspaceId, agentPreset })`（宿主在这一支才 `attachSession`），找不到/服务缺失/抛错就退回原来的 `create({ cwd, agentPreset })`。
- **不自动建工作区**（那是主会话「指挥舱」的语义），因此不改能力包其它设计；返回值多带一个 `workspaceId`（没有就不带），日志 `pack.open` 同步记录。
- 边界不变：仍然只是 `sessionController.create` 普通根会话，不写台账、不进队列（`src/pack/service.js:13`）。

### 3.3 改动文件

| 文件 | 改动 |
|---|---|
| `client/src/open-session.js`（新） | 未知会话重试 + 可读降级（纯函数，可单测） |
| `client/src/capability-packs.js` | 开包会话改走 `openSessionWhenReady`，失败给「已建好…请从左侧列表打开」 |
| `src/pack/service.js` | `workspaces` 注入 + `workspaceIdFor()`；open 优先 `workspaceId`；日志/返回值带 workspaceId |
| `index.js` | 给 pack service 传 `workspaces: () => service('workspaceRegistry')` |
| `test/pack-open-session.test.js`（新） | 重试成功、非 unknown 立即失败、重试用尽带原文、无 openSession 如实失败 |
| `test/pack-service.test.js` | 工作区分支用 `workspaceId`、不再传 cwd；找不到/报错退回 cwd；不自动建工作区 |
| `test/client-packs.test.js` | 源码/产物契约：必须经 `openSessionWhenReady`、产物含降级提示 |
| `docs/LIMITATIONS.md` | 两条降级边界（竞态 + 工作区归属） |
| `CHANGELOG.md` | 0.32.0 条目下补一段「同版修复（t-8a81264c）」 |
| `dist/client.js` | 重建（163,824 B / 预算 163,840 B，余 16 B） |

## 4. 验证

### 4.1 单测 / 门禁

`pnpm test`（含 build + `check:client-size` + `check:docs`）：

- **1254 例 / 1249 pass / 0 fail / 5 skip**（5 条 skip 均为「当前环境无法创建文件符号链接」的环境跳过，与本次无关）。
- 新增用例：`test/pack-open-session.test.js`（4 条）+ `test/pack-service.test.js` 的 2 条工作区归属用例 + `test/client-packs.test.js` 的源码/产物契约。
- `check:client-size`：163,824 B / 163,840 B（余 16 B；没有抬预算）；`check:docs` 1743 / 1800 行；`check:version` 三处一致（0.32.0，未 bump）。

### 4.2 真机（隔离 `DSH_HOME` + 临时 profile + headless Chrome/CDP）

环境：`DSH_HOME=C:\Users\72489\AppData\Local\Temp\orch-packfix-home`、profile `packfix`（`--from-default-profile web`）、插件以仓库路径 link 进 profile、`dsh --profile packfix --no-open --port 53531`、无模型/无账号（开包会话不触发模型）。为贴近用户现场，先在隔离 home 里登记「指挥舱」工作区（路径 = 插件默认 cwd）再开包。

探针 `reports/pack-open-fix/harness/verify.mjs`（CDP 驱动真实 UI，点面板按钮）：

| 检查 | 结果 |
|---|---|
| 侧栏「能力包」入口可点、包卡与「预设已注册」可见 | PASS |
| 点「用这个包开新会话」 | PASS |
| 无「打不开 / 开包会话失败」提示 | PASS（修复前稳定复现见 §2 第二层缺陷截图） |
| 会话视图真的打开（输入框出现） | PASS |
| 会话落在「指挥舱」工作区（不是「未分组」） | PASS |
| 不再出现「选择一个工作区开始」 | PASS |
| 会话标题「公众号文章」（包预设） | PASS |

证据：`reports/pack-open-fix/evidence/after-fix-result.json`（9/9 PASS）、`after-fix-open-session.png`、`after-fix-host-facts.txt`（`pack.open` 带 `workspaceId` + 宿主 `workspace.json` 的 `sessionIds` 含新会话）。

对照：修复前同一套隔离环境（预置了同名工作区）点同一个按钮，UI 显示「选择一个工作区开始」且会话在「未分组」（`evidence/before-fix-placeholder.png`）。

## 5. 是否需要重启 DSH

- **服务端（`src/pack/service.js` / `index.js`）**：改动在插件宿主侧，**需要重载插件或重启 DSH** 才生效（`dsh` 进程里已加载的旧模块不会热替换）。
- **客户端（`dist/client.js`）**：已重建（仓库内产物入库）；平台每次加载页面 serve 的是这个文件，**刷新页面**即可拿到新客户端；宿主侧不需要为它重启。
- 结论：发到用户机器上时重启一次 DSH（或重载插件）+ 刷新页面。

## 6. 未验 / 已知边界

- **竞态本身无法在隔离环境稳定复现**（owner 连接下事件通常先到；真实失败由用户日志坐实）。重试路径由单测覆盖（第 1/2 次抛 unknown、第 3 次成功），正常路径由真机探针覆盖。
- 如果 `api-session/added` **彻底丢失**（例如 create 期间连接代际已变），重试不会成功 → 走「请从左侧列表打开」降级；会话本身已建好、且现在会挂在工作区里，左侧可见可点。要彻底消除需要宿主提供“建完即可 retain”的 API（rc 私有契约，未做）。
- 工作区归属只认**已登记**工作区；目录不是工作区时仍退回 `cwd` 创建（落「未分组」），插件**不自动建工作区**——这是有意的边界。
- 用户真机上那次失败留下的空会话（`session-003fe106-…`）**没有删除**（边界：不碰用户会话/数据），它在「未分组」里且没有 turn，可自行忽略。
- 未改派发语义、未改能力包其它设计、未 bump 版本、未 push/tag。

## 7. 复跑

```powershell
# 1) 隔离环境
$env:DSH_HOME='C:\Users\72489\AppData\Local\Temp\orch-packfix-home'
& '<DSH>\resources\runtime\cli\bin\dsh.cmd' --profile packfix --from-default-profile web --dump-config
& '<DSH>\resources\runtime\cli\bin\dsh.cmd' plugin --profile packfix add 'C:\Users\72489\Documents\dsh-orchestrator'
# 2) （可选）在隔离 home 的 storages/workspace.json 里登记「指挥舱」工作区（路径必须是 canonical 路径）
# 3) 启动
& '<DSH>\resources\runtime\cli\bin\dsh.cmd' --profile packfix --no-open --port 53531 --host 127.0.0.1
# 4) 驱动真实 UI（另开终端）
$env:DSH_URL='http://127.0.0.1:53531/?token=<上一步打印的 token>'
node reports/pack-open-fix/harness/verify.mjs
```
