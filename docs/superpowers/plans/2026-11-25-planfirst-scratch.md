# planFirst 放开 scratch：设计与验收细节（2026-11-25）

> 正式文档（`docs/ARCHITECTURE.md` / `docs/LIMITATIONS.md` / `docs/testing.md` / `README.md`）只做等量改写，
> 细节与取证留在本文件。`docs/superpowers/` 不进 `scripts/check-docs.mjs` 的行数预算。
>
> 关联：任务 tk-fvgc3d（实施）、tk-6kefeu（方案取证）、tk-00ffccbd（实施计划落盘）。

## 1. 一句话

计划阶段（planFirst 且未批准）的**沙箱模式**从 `read-only` 换成 `workspace-write`，**target 可写根仍然一行不注册**。
仓库可写与否只取决于「有没有登记可写根」，与 mode 无关 —— 所以硬门强度不变，而 `workspace-write` 天生自带
`/tmp` + `os.tmpdir()`，scratch 就此可写。

## 2. 宿主算法（asar 内原文摘录，复刻进 `scripts/verify-plan-scratch.mjs`）

`@deepseek-ai/dsh-sandbox/src/roots.ts`

```ts
:62  export function canonicalPath(path: string): string {
:68    return realpathSync.native(path)      // /tmp 在 darwin 上是 /private/tmp
:70  } catch { return path }                 // 解析失败按原样（保守：缺的根匹配不到任何东西）
:87  export function workspaceWritableRoots(policy) {
:88    if (policy.mode !== 'workspace-write') return []        // ← read-only 一律空
:90    return [...new Set([canonicalPath(policy.workspaceRoot), ...additional])]
:103 export function writableRoots(policy) {
:104   if (policy.mode !== 'workspace-write') return []        // ← 同上（mode 门禁）
:105   return [...new Set([...workspaceWritableRoots(policy), canonicalPath('/tmp'), canonicalPath(tmpdir())])]
```

`@deepseek-ai/dsh-sandbox-local/src/profiles.ts`

```ts
:53  export function seatbeltProfileArgs(policy) {
:54    const forms = ['(version 1)', '(allow default)', '(deny file-write*)', `(allow file-write* (literal "/dev/null"))`]
:55    const roots = writableRoots(policy)
:56    if (roots.length > 0) forms.push(`(allow file-write* ${roots.map(r => `(subpath "…")`).join(' ')})`)
:59    return ['-p', forms.join(' ')]
```

三条直接推论：

1. `read-only` 下 `roots.length === 0` → 方括号那段不生成 → 唯一可写只剩 `/dev/null`（所以「只读任务连 `/tmp` 都写不了」是模式语义，不是 bug）；
2. `workspace-write` 下 `/tmp` 与 `os.tmpdir()` **无条件**进允许清单，插件无法只放行其中一个 → 计划阶段能写指挥舱 `workspace/`（含 artifacts 暂存），这是已知副作用；
3. 仓库要可写**只能**靠 `registerWritableRoot(session, target)`，与 mode 正交 —— 这就是本方案的着力点。

## 3. 解耦设计：两个正交事实

| 事实 | 载体 | 计划阶段 | 批准后 | 普通任务 | 只读任务 |
|---|---|---|---|---|---|
| 沙箱模式（能不能写 `$TMPDIR`） | `sandbox/mode` 事件 | `workspace-write` | `workspace-write` | `workspace-write` | `read-only` |
| 可写根授权（能不能写 target） | `registerWritableRoot` | **不注册** | **注册 target** | 注册 target | 不注册 |

拆法：**`dispatch.send` 的 `readOnly` 参数保留「不授权 + 不 preflight」原义**（三个投递点的位置参数一个不动），
**新增 `options.planPhase` 只负责选 mode**。于是所有 `readOnly === true` 的守卫原样生效，模式选择被隔离在一个 if 里。

代码位置（`90e6056` 之后的行号）：

| 文件:行 | 内容 |
|---|---|
| `src/dispatch.js:196-206` | `sandboxModeFor`：`readOnlyChildren→'read-only'`、`planChildren→'workspace-write'` 两行分开 |
| `src/dispatch.js:360-362` | 新增 `ensurePlanReady = childId => ensureModeReady(childId, 'workspace-write')` |
| `src/dispatch.js:850-852` | spawn 的 planFirst 分支改调 `ensurePlanReady`（`installExitPlanGuard`/`applyPlanMode` 不动） |
| `src/dispatch.js:969-975` | send：`if (readOnly === true) { planPhase==='workspace-write' ? ensurePlanReady : ensureReadOnly }` |
| `src/plan-mode.js:78-95` | 新增 `planPhaseMode(task)`：`isPlanTask && planStateOf !== 'approved' → 'workspace-write'`，其余 `'read-only'` |
| `src/tools.js:652`、`:1044`、`src/panel-actions.js:596` | options 各追加 `planPhase: planPhaseMode(task)` |

**判定口径为什么不用现成的 `planInPhase`**：`dispatchReadOnly` 的 plan 半边是 `planStateOf !== 'approved'`（含 `none`/`rejected`），
`planInPhase` 只含三态。两者不一致会在 `plan_state='none'` 的旧行上留下「readOnly===true 但模式 read-only」的空档——
不是安全问题，但那些旧计划任务会继续写不了 scratch。所以 `planPhaseMode` 与 `dispatchReadOnly` 逐字对齐。

## 4. 硬门清单（这些行一行都没动）

| 文件:行 | 条件 | 作用 |
|---|---|---|
| `src/dispatch.js:863` | `if (readOnly !== true && planFirst !== true && cwd !== '')` → `ensureWritableRoot` | **批准前不注册 target —— 硬门的全部重量** |
| `src/dispatch.js:877` | `if (readOnly !== true && planFirst !== true) grantArtifactRoot(...)` | 产物 staging 根同样不注册 |
| `src/dispatch.js:811` | `if (readOnly !== true && planFirst !== true) { 写域 preflight }` | 计划阶段仍跳过（`write-guard` 在创建期已判） |
| `src/dispatch.js:439-458` | `grantWritableRoot` | 全仓唯一 `registerWritableRoot` 调用点 |
| `src/dispatch.js:503-506` | 授予失败补偿回 `read-only` | 更严的失败态 |
| `src/dispatch.js:1032-1040` | `freezeWork` | 交付/终态回只读 |
| `src/dispatch.js:660-700` | `agent/created` hook | 按 `sandboxModeFor` 自动跟随，未改 |

另外不动：`COORDINATOR_DENY`、`tools.guard`、preset-tools deny、主会话权限钉 `read-only`、`checks` 机器验收、配置面（26 键）、台账列。

## 5. 失败方向（新增的唯一可降级点）

`send` 的模式选择依赖调用方传的 `options.planPhase`。**漏传 ⇒ 回落到 `ensureReadOnly`**：
scratch 又写不了，但仓库照样不可写。所有漏传都是「退化到现状」，不会变成「仓库可写」。
`test/plan-mode.test.js` 的「漏传 planPhase 的降级方向」用例锁这条性质。

## 6. 验收证据

### 6.1 单元测试（`node --test`，152 项受影响面全绿）

- `test/plan-mode.test.js`：42 → 46 项（新增 4 条解耦用例：模式分叉 / 未批准续派不注册且幂等 / 批准前后对比 / 漏传降级）；
- `test/status-property.test.js`：权限口径从「只读/完整/普通」三档拆成四档，并断言 `seen.planPhase > 0`；
- `test/parallel-policy.test.js`：`skills/orch-parallel/SKILL.md` 的例外句与 `PARALLEL_LINES.exceptions` 同步；
- `test/dispatch.test.js` 的 readOnly 用例与 `test/task-detail.test.js` 的 `read_only` 用例**未动**（语义不变）。

### 6.2 `node scripts/verify-plan-scratch.mjs`

A 段（profile 算法）与 C 段（真实 dispatcher 代码路径）在任意环境可跑；B 段（真实 Seatbelt 写入）需要
**未沙箱化的终端** —— 脚本被跑在已沙箱化的会话里时，宿主拒绝嵌套 `sandbox_apply`，脚本会显式 `SKIP` 整段
（而不是把「全被拒」当通过，避免假绿）。

### 6.3 真机验收（需协调者在主会话做，子会话没有 `task_create` 权限）

1. `task_create({ title:'planFirst scratch 真机验收', goal:'…', acceptance:['…'], planFirst:true, target:<repo> })`
2. 子会话里 `echo probe > "$TMPDIR/tk-probe.txt"` → **成功**；
3. `echo probe > <repo>/__probe.txt` → **`Operation not permitted`**（触发一次 `child-tool-failure` 通知，属预期）；
4. `task_status` 权限行显示「仓库只读（临时目录可写）」；
5. `task_report blocked` → `task_message({action:'approve'})` → 续派 → 日志出现 `subagent.writable-root`（directory=`<repo>`），此时写仓库**成功**。

## 7. 回退

| 层级 | 操作 | 残留 |
|---|---|---|
| 最快（1 行） | `src/dispatch.js` 的 plan 分支改回 `'read-only'` | 模式注入立刻回全只读；文案不一致但只是提示；`planPhase` 分支成为死代码 |
| 完整 | `git revert` 该提交 | 零残留：无配置键、无台账列、无数据迁移；日志里已有的 `sandbox/mode` 按「最后一条」折叠，重启/新派发即恢复 |
| 运行时 | `task_message({action:'stop'})` / 进终态（`freezeWork`） | 该会话被 append `read-only` 并释放可写根 |

## 8. 已知限制

1. 计划阶段可写指挥舱 `workspace/`（含 artifacts 暂存）：宿主 `workspace-write` 的可写面固定含 workspaceRoot + `/tmp` + `os.tmpdir()`，无法只放行 scratch（用户已接受）。产物真源 `artifact-store/` 在 workspace 之外、仍不可写。
2. 若协调者 cwd 被改成仓库目录，`workspace-write` 会让整个仓库可写。当前部署是 `$DSH_HOME/state/orchestrator/workspace`（`index.js:629`），`main-session.js:179` 的 adopt 校验也按这个路径判。`sandboxModeFor` 的 plan 分支旁已写注释把这个前提固定住。
3. macOS 的 `os.tmpdir()` 是 `/var/folders/…/T` 而不是 `/tmp`，所以文案统一写 `$TMPDIR`。
4. Windows 未验证：`additionalWritableRoots` 对 harness 文件工具生效、对沙箱进程不生效（`dsh-sandbox/src/index.ts:57`）。
