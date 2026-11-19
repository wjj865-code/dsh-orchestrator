# P10 插件页配置 UI：实施报告

> 任务 t-ff5cce99｜基线 **`7d9e559`（v0.21.0）**｜本地提交 `08bf23d`
> 状态：**已 rebase 到 0.21.0 并对齐配置面；仅本地提交，未推送**

## 0. 基线与 ff 结果

| 项 | 值 |
|---|---|
| `git fetch origin --prune` | **成功**（首次因只读沙箱失败，进入可写后重试成功） |
| 拉取前 HEAD | `8770718`（v0.19.1），behind 3 |
| ff 后 HEAD | **`69b28f2247433f6581577d491fc083abead79137`**（v0.20.1） |
| 本地独有提交 | 0（`git rev-list --left-right --count origin/main...HEAD` = `3 0`） |
| `git merge --ff-only` | 成功，无冲突 |
| 工作区 | 干净（唯一未跟踪文件 `reports/preference-mechanism-plan.md` 是 ff 前就有的，非本次产物） |

**0.20.1 的 preferences 机制与本次改动无冲突**：它走 SQLite `settings.orchestrator_preferences`，
不读 Config；本次只是把 Config 补上（新增 3 个 `preferences*` 字段进字段表与 README）。

## 0.5 与 0.21.0 对齐（第二轮修正）

首次提交基于 0.20.1。期间远端推进到 **0.21.0（`7d9e559`）**，其中 `c43c881 refactor: P1-A 配置面收缩（41→35）`
直接改动了本字段表所依据的配置面，因此按用户决定（方案 A）rebase 并对齐。

**rebase**：`git rebase origin/main`，4 处冲突逐个解决，无 merge 提交，保持单一线性提交：

| 冲突 | 解决 |
|---|---|
| `README.md` | 以上游为准（已含 preferences 行、`mainRotation` 默认 `off`），只保留本次加的「页面只读」标注；`backend` 行不再加回 |
| `index.js` | 双方各加一行 import → 都保留；上游新增 `loadConfig(raw, {onWarn})` 与 `createHostCapabilities` → 把 `unwrapVolatile` 融进新签名（先解包再归一化），`rawWorkerPreset` 复用已解包值避免二次解包 |
| `docs/UI.md` | **上游 P1-D 已删除该文件**（UI 内容合并进 `docs/ARCHITECTURE.md`）→ 跟随上游删除，把配置卡片说明写进 ARCHITECTURE「插件页与面板错误码」节下的新小节 |
| `dist/client.js.map` | 构建产物冲突 → 取上游版本，随后由 `pnpm build` 重新生成 |

**配置面修正**（以 0.21.0 的 `loadConfig` 实跑结果为准，非硬编码）：

- 删除 6 个已废弃键：`backend`、`rotateAfterTasks`、`rotateAfterSessions`、`rotateAfterContextTokens`、
  `rotateAfterDiskMiB`、`rotateCheckIntervalHours`；
- `mainRotation` 默认值 `auto` → **`off`**（0.21.0「默认必须安全」）；
- 字段表 41 → **35**，与真实 `loadConfig` 双向比对**完全一致**（schema 投影同样 35/35，废弃键不在其中）。

**DEPRECATED_KEYS**：0.21.0 已在 `src/config.js` 实现（读到旧键 warn 一次、值不回填），与 UI 无关；
本次只需保证字段表不暴露这些键，**无需额外接入**（测试断言了这一点）。

## 1. 改了什么

### 新增文件（1244 行）

| 文件 | 行数 | 职责 |
|---|---|---|
| `src/config-fields.js` | 243 | **字段单一事实源**：32 个字段的名称/类型/枚举/区间/默认/只读/分组 |
| `src/config-schema.js` | 128 | schemastery `Config` 投影 + `unwrapVolatile` + **降级加载** |
| `client/src/config-form.js` | 256 | 配置卡片组件（分组折叠/草稿/保存/冲突/只读/未加载） |
| `client/src/config-logic.js` | 79 | 卡片纯逻辑（buildOps/isDirty/parseInput），可 node 直测 |
| `test/config-fields.test.js` | 256 | 宿主侧 18 条（不拒载 / volatile 双向 / 默认值一致 / 降级契约） |
| `test/client-config-form.test.js` | 282 | 客户端 22 条（纯逻辑 / key 契约 / 四态渲染冒烟） |

### 修改文件

| 文件 | 改动 |
|---|---|
| `index.js` | `export { Config }`；`apply` 首行 `loadConfig(unwrapVolatile(rawConfig))`；`rawWorkerPreset` 同样解包 |
| `client/src/client.js` | `ctx.inject(['configForms'], …)` 注册 `plugins.bundle.config`（+34 行） |
| `client/src/styles.css` | `.orch-cfg*` 样式（+90 行） |
| `package.json` | `dsh.client.inject` 增 `@deepseek-ai/dsh-client-ui-settings`；`peerDependencies` + `devDependencies` 声明 schemastery |
| `pnpm-lock.yaml` | 3 个包记录（schemastery / cosmokit / standard-schema-spec），integrity 取自 registry |
| `dist/client.js` + `.map` | 重建（155.99 kB） |
| `README.md` | 配置段重写（两种改法等价 / 保存位置 / 生效语义 / 只读字段）；补 3 个 `preferences*` 字段（0.20.x 漏的） |
| `docs/UI.md` | 新增 §10 插件页配置卡片 |

## 2. 三个必须守住的点（都做了，都反向验证过）

### P0-1：非法配置不能拒载

Cordis 的 `resolveConfig()` 校验失败会抛 `ValidationError` → **插件起不来**。
这与 `src/config.js`「非法值一律回落默认」的既有契约直接冲突。

**解法**：每字段 `.default(...)` + 不 `required()` + `.loose()`。

**反向验证**：去掉 `.loose()` 后立刻 2 条用例失败：
```
not ok 2 - Config：垃圾配置不产生 issues（非法值回落默认，不拒载）
not ok 3 - Config：NaN / Infinity / 极端值都不拒载
```

### P0-2：字段不能静默消失

`volatileForm()` 只保留 volatile 字段，漏标 = 页面上**不报错地少一行**。

**解法**：单测把「schema 的 volatile 集合」与「字段表 key 集合」**双向比对**。

**反向验证**：去掉 `.volatile()` 后立刻 2 条失败：
```
not ok 5 - volatile 集合 ↔ 字段表双向比对（漏标/多标都算失败）
not ok 10 - unwrapVolatile：解包后 loadConfig 能正常识别类型
```

### P0-3（实施中新发现）：volatile 字段到达 apply 时是包装对象

这是计划里没写、实施中实测发现的**新风险**：`.volatile()` 字段经 Cordis 校验后
**不是普通值**，而是带 `.get()` 的 cosmokit Volatile 包装：

```
a typeof: object | a isVolatile: true | a.get() = 7
不解包 → loadConfig({staleMinutes:10}).staleMinutes === 30   ← 用户配置被静默丢弃
解包后 → 10                                                    ← 正确
```

**解法**：`unwrapVolatile()` + 单测同时钉住「不解包会坏」和「解包后正确」。
`rawWorkerPreset` 也一并修（否则警告文案会打印 `{}`）。

### P0-4（实施中新发现）：schemastery 解析失败会拖垮整个插件

`schemastery` 是宿主自带包，本插件声明为 **optional peer**。但「optional」不等于「一定拿得到」。
若用静态 `import`，解析失败 = 模块加载失败 = **插件连任务面板和全部工具一起消失**。

**解法**：`createRequire` + try/catch **同步降级**，拿不到则 `Config = undefined`。
已核实宿主语义：`resolveConfig()` 里 `if (!runtime.Config) return config` —— **跳过校验，不报错**。

**实测降级**（在无 node_modules 的 `/tmp` 下加载打包产物）：
```
name: dsh-orchestrator
inject: ["tools","agents","systemPrompt","subagents"]
Config 存在: false          ← 降级生效
```

## 3. 验证证据

### 全量测试

```
# tests 993
# pass 993
# fail 0
```
（rebase 到 0.21.0 后基线为 982；本次新增 **11 条**。按「测试以模块为边界、不堆低价值用例」
精简过一轮：原 44 条删掉 33 条重复断言 / 内部实现细节 / 过度构造的边界，四个 P0 各保留 1 条）

附加门禁（0.21.0 新增）：
```
check:docs    → 文档检查通过：总行数 2041 / 预算 2250；配置表 35 键、工具表 10 个
check:version → 版本口径一致：0.21.0
```

### 构建与产物契约

```
dist/client.js  155.99 kB │ gzip: 35.96 kB │ map: 237.27 kB
✓ built in 180ms
node --check dist/client.js → OK
```
无顶层 `import`/`export`（平台要求 classic script）。

### 真机加载验证（模拟宿主完整路径）

在模拟 profile 布局（`node_modules/@wjj865-code/dsh-orchestrator` + 同级 schemastery）下加载**打包产物**：

```
schemastery 可见: true
Config 存在: true
校验通过（无 issues）
keepAlive: true | maxQueue: 50 | sameDirGuard: warn
REAL-LOAD OK
```
（`maxQueue: 'garbage'` 正确回落默认 50，说明 `.loose()` 生效）

### 客户端产物验证

```
registered slots: main, main, sidebar.panellist, conversation.header.leading,
                  conversation.chat.turnTail, plugins.bundle.config
config card key: @wjj865-code/dsh-orchestrator
whileServed namespaces: ["orchestrator"]
renders 配置: true | renders 派发与队列: true | renders 保存: true
CLIENT OK
```

### key 契约反向验证

把 slot key 误写成 entry id（模拟手滑）→ 2 条用例立刻失败：
```
not ok 11 - 注册 key：slot key 是包名，configForms 的 key 是 entry id（两者必须不同源）
not ok 15 - 注册：apply 在 configForms 可用时注册配置卡片（key = 包名）
```

## 4. 红线遵守

| 红线 | 状态 |
|---|---|
| 不改任务面板 | ✅ `views.js`/`feed.js`/`gate.js`/`api.js`/`logic.js` 零改动 |
| 不动台账结构 | ✅ `src/ledger.js` 零改动 |
| 不改 sameDirGuard/worktreePolicy 安全默认值 | ✅ `src/write-guard.js`/`src/worktree-request.js` 零改动；字段表只是**读取**这些常量并断言一致 |
| 不实现 schema 自动生成表单 | ✅ `autoGenerate` 仅出现在一句注释里（说明为什么不用它） |

## 5. 未完成 / 需用户处理

### 5.1 真机 UI —— 已用无头 Chrome 完成验证（9/9 PASS）

在**隔离测试 profile**（`DSH_HOME=/tmp/dshverify`，`--profile verify-config-ui`，端口 52847）上跑，
**未触碰 desktop profile、未重启当前会话、未 kill 宿主进程**。证据目录：`reports/config-ui-verify/`。

| # | 断言 | 结果 |
|---|---|---|
| 1 | 打开首页（带 token 鉴权） | PASS |
| 2 | 侧栏「插件」可进入 | PASS |
| 3 | 找到 dsh-orchestrator 详情页 | PASS |
| 4 | 配置卡片出现（`data-orchestrator-config`） | PASS |
| 5 | 字段数 = **35**（8 分组全展开） | PASS |
| 6 | 6 个废弃键不出现在卡片 | PASS |
| 7 | `mainRotation` 默认 **off** | PASS |
| 8 | 改 keepAlive → 保存 → profile YAML 出现 `id: orchestrator` + `keepAlive: true` | PASS |
| 9 | 手改 YAML → 刷新 → 显示「已覆盖」 | PASS |
| 10 | 清空字段 → YAML 键移除 → 回落默认 60 → 「已覆盖」清除 | PASS |

**lockfile 复核**：`pnpm install --frozen-lockfile` **通过**（手工补的 3 个包声明正确，lockfile 未被改动）。

### 5.2 pnpm 在沙箱内不可用

`pnpm install` 报 `create the temporary package manager install directory: Operation not permitted`。
`pnpm-lock.yaml` 是**手工按 registry 元数据补齐**的（3 个包，integrity 均来自 registry 响应，
依赖树扁平、无传递冲突）。建议推送前在可写环境跑一次 `pnpm install --frozen-lockfile` 复核。

### 5.3 真机「保存后 profile 出现该行」未验证

同上，需要能写 `~/.dsh/profiles/desktop/cordis.patch.yml` 的环境。

## 6. 交付清单

- diff：`git status` 见 §1；未提交
- 计划文档：`/Users/bytedance/.dsh/state/orchestrator/workspace/reports/plans/t-ff5cce99.md`
- 本报告：`/Users/bytedance/Documents/fullstack/dsh-orchestrator/reports/p10-config-ui.md`
