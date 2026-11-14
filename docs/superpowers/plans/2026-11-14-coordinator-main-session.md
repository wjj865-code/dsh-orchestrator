# 协调者主会话（预设开启）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用固定入口和协调者预设创建唯一「主会话」，取代首次 `task_create` 自动绑定；任务可带目标目录，子会话在目标目录运行。

**Architecture:** 新增 `src/main-session.js` 管理主会话的创建/打开/重建（依赖 `sessionController`、workspace registry、`agents`）；`index.js` 移除自动绑定，暴露 `open-main` 动作端点并把协调者判定收敛到 `settings.main_session_id`；`host-route` 的 `snapshot` 保持只读并增加 `mainSession`/`targetDir`；客户端面板把「打开协调者会话」改成「打开主会话」；bundle 的 `cordis.patch.yml` 注册协调者预设，工具集在预设层定型；运行期 `restrict`/`guard` 只保留给配置覆盖会话兜底。

**Tech Stack:** Node 22 ESM、`node:sqlite`、`node:test`、cordis 插件服务（`sessionController` / `workspaceRegistry` / `agents` / `connection` / `subagents`）、经典脚本客户端（`__ModuleLoader__.load`）。

---

## File Structure

| 文件 | 职责 |
| --- | --- |
| `src/main-session.js`（新建） | 主会话：解析配置覆盖 / 读 `settings.main_session_id` / 校验 live / 创建（工作区 + 预设）/ 重建 |
| `src/ledger.js` | `tasks.target_dir` 列；`getMainSessionId` / `setMainSessionId` |
| `src/brief.js` | `validateTargetDir`；`renderBrief` 增加【工作目录】 |
| `src/dispatch.js` | `spawn({ cwd })` 透传到 `startActivation.request.cwd` |
| `src/queue.js` | 派发时传 `cwd: task.target_dir` |
| `src/tools.js` | `task_*` 只允许主会话；`task_create` 校验/落 `target_dir`，渲染带目标目录 |
| `src/host-route.js` | `snapshot` 增加 `mainSession` 与 `targetDir`；`open-main` 动作端点 |
| `index.js` | 移除自动绑定；装配 main-session、`open-main`、prompt/guard 按主会话 |
| `client.js` | 「打开主会话」按钮与状态、目标目录展示、`open-main` 调用 |
| `cordis.patch.yml` | 插入协调者预设行 |
| `docs/probes/main-session-probe.md`（新建） | 平台契约探测结论（预设/创建/工作区/事件/cwd 沙箱） |
| `README.md` / `docs/api-notes.md` | 主会话、目标目录、预设、迁移与已知局限 |

---

### Task 0: 平台契约探测

**Files:**
- Create: `docs/probes/main-session-probe.mjs`
- Create: `docs/probes/main-session-probe.md`
- Test: 运行探针脚本

- [ ] **Step 1: 写探针脚本**

```js
// docs/probes/main-session-probe.mjs
// 读已安装的 app.asar，核对主会话需要的主机契约；只读源码，不启动 app。
import { readFileSync } from 'node:fs'

const ASAR = process.argv[2] ?? 'C:/Users/72489/AppData/Local/Programs/DeepSeek Harness/resources/app.asar'
const source = readFileSync(ASAR, 'utf8')
const checks = []
const check = (name, pattern) => {
  const hit = typeof pattern === 'string' ? source.includes(pattern) : pattern.test(source)
  const at = typeof pattern === 'string' ? source.indexOf(pattern) : source.search(pattern)
  checks.push({ name, hit, at })
}
check('agent-preset 配置含 toolFilter', /toolFilter/)
check('sessionController.create 接受 workspaceId', /create\(request\)/)
check('workspaceRegistry 注册工作区', /workspaceRegistry/)
check('session/created 事件', /session\/created/)
check('agent/created 事件', /agent\/created/)
check('subagent request 支持 cwd', /maxDepth/)
for (const item of checks) console.log(`${item.hit ? 'PASS' : 'FAIL'} ${item.name} @${item.at}`)
process.exit(checks.every(item => item.hit) ? 0 : 1)
```

- [ ] **Step 2: 运行探针，记录命中片段**

Run: `node docs/probes/main-session-probe.mjs`
Expected: 6 行 PASS；把 `agent-preset` 的 `config` 形状、`create` 的入参、工作区 API、`session/created` 载荷、`startActivation.request.cwd` 的原文摘录写进 `main-session-probe.md` §1–§5。

- [ ] **Step 3: 写探针文档**

写 `docs/probes/main-session-probe.md`，逐条给出：预设行 `toolFilter` 的准确字段与嵌套位置、`sessionController.create({ workspaceId, agentPreset })` 是否成立、工作区确保/注册 API、创建后如何拿到 `sessionId`、子会话 `cwd` 指向主会话工作区之外时沙箱行为（附 asar 偏移与原文）。

- [ ] **Step 4: 提交**

```bash
git add docs/probes/main-session-probe.mjs docs/probes/main-session-probe.md
git commit -m "docs: 主会话平台契约探测"
```

---

### Task 1: 台账 target_dir 与 main_session_id

**Files:**
- Modify: `src/ledger.js`
- Test: `test/ledger.test.js`

- [ ] **Step 1: 写失败测试**

在 `test/ledger.test.js` 末尾加：

```js
test('tasks 表有 target_dir，旧库自动补列', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-ledger-'))
  const db = await openLedger(dir)
  const cols = db.prepare('PRAGMA table_info(tasks)').all().map(row => row.name)
  assert.ok(cols.includes('target_dir'))
  const task = createTask(db, {
    brief: { title: '任务', goal: '目标', acceptance: ['a'] },
    coordinatorSession: 's-1',
    targetDir: 'C:/work/project',
  })
  assert.equal(task.target_dir, 'C:/work/project')
  db.close()
})

test('main_session_id 读写', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-ledger-'))
  const db = await openLedger(dir)
  assert.equal(getMainSessionId(db), undefined)
  setMainSessionId(db, 'session-main')
  assert.equal(getMainSessionId(db), 'session-main')
  db.close()
})
```

并在文件顶部补 import：`getMainSessionId, setMainSessionId`。

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/ledger.test.js`
Expected: FAIL（`target_dir` 不存在 / 导出缺失）

- [ ] **Step 3: 实现**

`src/ledger.js`：

```js
// SCHEMA 的 tasks 表加列
  status TEXT NOT NULL, session_id TEXT, target TEXT, target_dir TEXT, coordinator_session TEXT NOT NULL,

// openLedger 旧库补列
    if (!taskColumns.includes('target_dir')) db.exec('ALTER TABLE tasks ADD COLUMN target_dir TEXT')

// createTask
export function createTask(db, { brief, coordinatorSession, targetDir }) {
  const now = Date.now()
  const id = `t-${randomUUID().slice(0, 8)}`
  db.prepare(`INSERT INTO tasks (id, title, goal, brief_json, status, coordinator_session, target_dir, created_at, updated_at, last_event_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`)
    .run(id, String(brief.title), String(brief.goal), JSON.stringify(brief), String(coordinatorSession ?? ''), targetDir ?? null, now, now, now)
  return getTask(db, id)
}

// 文件末尾
export const MAIN_SESSION_KEY = 'main_session_id'
export function getMainSessionId(db) {
  return getSetting(db, MAIN_SESSION_KEY)
}
export function setMainSessionId(db, sessionId) {
  return setSetting(db, MAIN_SESSION_KEY, sessionId)
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/ledger.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/ledger.js test/ledger.test.js
git commit -m "feat: 台账支持 target_dir 与 main_session_id"
```

---

### Task 2: brief 目标目录校验与渲染

**Files:**
- Modify: `src/brief.js`
- Test: `test/brief.test.js`

- [ ] **Step 1: 写失败测试**

在 `test/brief.test.js` 末尾加：

```js
test('validateTargetDir：相对路径/不存在/非目录都拒绝', () => {
  assert.equal(validateTargetDir('relative/dir', { isDirectory: () => true }), 'target 必须是绝对路径')
  assert.equal(validateTargetDir('C:/nope', { isDirectory: () => false }), 'target 目录不存在或不是目录')
  assert.equal(validateTargetDir('C:/work', { isDirectory: () => true }), undefined)
  assert.equal(validateTargetDir(undefined, { isDirectory: () => true }), undefined)
})

test('renderBrief：有 target 时渲染【工作目录】', () => {
  const text = renderBrief({ title: 't', goal: 'g', acceptance: ['a'], target: 'C:/work' })
  assert.match(text, /【工作目录】C:\/work/)
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/brief.test.js`
Expected: FAIL（`validateTargetDir` 未定义）

- [ ] **Step 3: 实现**

`src/brief.js` 顶部加 `import { isAbsolute } from 'node:path'`，并加：

```js
export function validateTargetDir(target, { isDirectory = value => statSync(value).isDirectory() } = {}) {
  const value = text(target)
  if (value === '') return undefined
  if (!isAbsolute(value)) return 'target 必须是绝对路径'
  let ok = false
  try { ok = isDirectory(value) } catch { ok = false }
  return ok ? undefined : 'target 目录不存在或不是目录'
}
```

`renderBrief` 在【目标】后插入：

```js
  const target = text(brief.target)
  if (target !== '') lines.splice(2, 0, `【工作目录】${single(target)}`)
```

顶部 import：`import { statSync } from 'node:fs'`。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/brief.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/brief.js test/brief.test.js
git commit -m "feat: brief 支持目标目录校验与渲染"
```

---

### Task 3: 派发与队列透传 cwd

**Files:**
- Modify: `src/dispatch.js`
- Modify: `src/queue.js`
- Test: `test/dispatch.test.js`

- [ ] **Step 1: 写失败测试**

在 `test/dispatch.test.js` 末尾加：

```js
test('spawn 透传 cwd；默认用父会话 cwd', async () => {
  const calls = []
  const subagents = {
    startActivation: spec => {
      calls.push(spec)
      return Promise.resolve({ childId: spec.childId, result: Promise.resolve({}), dispose: async () => {} })
    },
    sendMessage: async () => {},
    interruptByParent: async () => {},
    listChildren: async () => [],
  }
  const parent = { id: 's-1', session: { header: { cwd: 'C:/parent' } } }
  const dispatcher = createSubagentDispatcher({ subagents, agent: parent })
  await dispatcher.spawn({ prompt: 'hi', cwd: 'C:/target' })
  assert.equal(calls[0].request.cwd, 'C:/target')
  await dispatcher.spawn({ prompt: 'hi' })
  assert.equal(calls[1].request.cwd, 'C:/parent')
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/dispatch.test.js`
Expected: FAIL（`request.cwd` 仍是父目录）

- [ ] **Step 3: 实现**

`src/dispatch.js`（subagent 版）：

```js
    async spawn({ name, label, prompt, signal, taskId, cwd }) {
      const parent = requireAgent()
      const childId = randomUUID()
      const baseCwd = cwd ?? parent.session?.header?.cwd
      const spec = {
        ...
        request: {
          parent,
          prompt: [{ type: 'text', text: String(prompt ?? '') }],
          ...(baseCwd === undefined ? {} : { cwd: baseCwd }),
        },
      }
```

`src/queue.js` 的 `dispatcher.spawn({...})` 调用加一行：

```js
            cwd: task.target_dir ?? undefined,
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/dispatch.test.js test/queue.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/dispatch.js src/queue.js test/dispatch.test.js
git commit -m "feat: 子会话按目标目录运行"
```

---

### Task 4: task_* 只允许主会话，task_create 支持 target

**Files:**
- Modify: `src/tools.js`
- Test: `test/tools.test.js`

- [ ] **Step 1: 写失败测试**

在 `test/tools.test.js` 末尾加：

```js
test('非主会话调用 task_* 被拒', async () => {
  const tools = createTools({ db, dispatcher, notifier, config, status: () => ({ id: 'main-1', live: true }) })
  const create = tools.find(tool => tool.name === 'task_create')
  const result = await create.execute({ title: 't', goal: 'g', acceptance: ['a'] }, { agent: { id: 'other-1' } })
  assert.match(result, /主会话/)
})

test('task_create 校验 target 并落 target_dir', async () => {
  const tools = createTools({ db, dispatcher, notifier, config, status: () => ({ id: 'main-1', live: true }) })
  const create = tools.find(tool => tool.name === 'task_create')
  const bad = await create.execute({ title: 't', goal: 'g', acceptance: ['a'], target: 'relative' }, { agent: { id: 'main-1' } })
  assert.match(bad, /绝对路径/)
  const ok = await create.execute({ title: 't2', goal: 'g', acceptance: ['a'], target: 'C:/work' }, { agent: { id: 'main-1' } })
  assert.match(ok, /已派发/)
  const row = db.prepare("select target_dir from tasks where title = 't2'").get()
  assert.equal(row.target_dir, 'C:/work')
})
```

（测试里 `dispatcher.spawn` 用假实现返回 `{ id: 'c-1', sessionId: 'c-1', target: 'c-1' }`；按现有 `test/tools.test.js` 的 helper 改。）

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/tools.test.js`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/tools.js`：

```js
  const MAIN_ONLY_HINT = '请从主会话操作任务（面板「打开主会话」）。'
  const MAIN_MISSING_HINT = '尚未打开主会话，请先从面板「打开主会话」。'
  const requireMain = exec => {
    const current = status()
    if (current.id === undefined) return MAIN_MISSING_HINT
    if (exec?.agent?.id !== current.id) return MAIN_ONLY_HINT
    return undefined
  }
```

每个 `task_*` 的 execute 第一行：

```js
      const denied = requireMain(exec)
      if (denied !== undefined) return denied
```

`task_create` 里：

```js
      const targetError = validateTargetDir(args.target)
      if (targetError !== undefined) return targetError
      const task = createTask(db, { brief: args, coordinatorSession: binding?.id ?? coordinatorSession, targetDir: args.target })
      const rendered = `【任务编号】${task.id}\n${renderBrief(args)}`
```

（`createTools` 的 `status` 参数由 index 传入 `() => ({ id: resolvedId(), live })`。）

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/tools.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/tools.js test/tools.test.js
git commit -m "feat: 任务只允许主会话派发并支持目标目录"
```

---

### Task 5: 主会话模块

**Files:**
- Create: `src/main-session.js`
- Test: `test/main-session.test.js`

- [ ] **Step 1: 写失败测试**

新建 `test/main-session.test.js`：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openLedger, getMainSessionId } from '../src/ledger.js'
import { createMainSession, PRESET_ID } from '../src/main-session.js'

const fake = ({ live = new Set() } = {}) => {
  const created = []
  const set = new Set(live)
  return {
    created,
    agents: { get: id => set.has(id) ? { id, session: { id } } : undefined },
    sessionController: {
      create: async request => { created.push(request); return { sessionId: 'session-main-new' } },
    },
    workspaces: {
      list: () => [{ id: 'ws-1', name: '指挥舱', path: 'C:/ws' }],
      create: async () => ({ id: 'ws-new' }),
    },
  }
}

test('无主会话时创建（工作区 + 预设）并写台账', async () => {
  const db = await openLedger(mkdtempSync(join(tmpdir(), 'orch-main-')))
  const f = fake()
  const main = createMainSession({
    db, config: {}, agents: f.agents, sessionController: f.sessionController,
    workspaces: f.workspaces, workspacePath: 'C:/ws', workspaceName: '指挥舱',
  })
  const result = await main.open()
  assert.deepEqual(result, { ok: true, sessionId: 'session-main-new', created: true })
  assert.equal(getMainSessionId(db), 'session-main-new')
  assert.equal(f.created[0].agentPreset, PRESET_ID)
  assert.equal(f.created[0].title, '主会话')
  db.close()
})

test('主会话 live 时直接返回，不重复创建', async () => {
  const db = await openLedger(mkdtempSync(join(tmpdir(), 'orch-main-')))
  const f = fake({ live: new Set(['session-main-old']) })
  f.agents.get = id => id === 'session-main-old' ? { id } : undefined
  // 先写入旧 id
  const { setMainSessionId } = await import('../src/ledger.js')
  setMainSessionId(db, 'session-main-old')
  const main = createMainSession({ db, config: {}, agents: f.agents, sessionController: f.sessionController, workspacePath: 'C:/ws' })
  const result = await main.open()
  assert.equal(result.created, false)
  assert.equal(result.sessionId, 'session-main-old')
  assert.equal(f.created.length, 0)
  db.close()
})

test('主会话失效时重建；创建失败不写台账', async () => {
  const db = await openLedger(mkdtempSync(join(tmpdir(), 'orch-main-')))
  const f = fake()
  f.sessionController.create = async () => { throw new Error('boom') }
  const main = createMainSession({ db, config: {}, agents: f.agents, sessionController: f.sessionController, workspacePath: 'C:/ws' })
  const result = await main.open()
  assert.equal(result.ok, false)
  assert.equal(getMainSessionId(db), undefined)
  db.close()
})

test('配置覆盖优先，失效时返回错误不创建', async () => {
  const db = await openLedger(mkdtempSync(join(tmpdir(), 'orch-main-')))
  const f = fake()
  const main = createMainSession({ db, config: { coordinatorSession: 'session-override' }, agents: f.agents, sessionController: f.sessionController, workspacePath: 'C:/ws' })
  const result = await main.open()
  assert.equal(result.ok, false)
  assert.equal(f.created.length, 0)
  db.close()
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/main-session.test.js`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

新建 `src/main-session.js`：

```js
// 主会话：唯一协调者。创建/打开/重建都从这里走；不再由 task_create 自动绑定。
import { getMainSessionId, setMainSessionId } from './ledger.js'

export const PRESET_ID = 'dsh-orchestrator-coordinator'
export const MAIN_SESSION_HINT = '尚未打开主会话，请先从面板「打开主会话」。'

export function createMainSession({ db, config, agents, sessionController, workspaces, workspacePath, workspaceName = '指挥舱', log = () => {} }) {
  const liveAgent = id => agents?.get?.(id)
  const currentId = () => config?.coordinatorSession ?? getMainSessionId(db)

  const ensureWorkspace = async () => {
    if (workspaces === undefined) return undefined
    const found = workspaces.list?.().find(row => row.path === workspacePath || row.name === workspaceName)
    if (found !== undefined) return found.id
    const created = await workspaces.create?.({ name: workspaceName, path: workspacePath })
    return created?.id
  }

  const open = async () => {
    const override = config?.coordinatorSession
    if (override !== undefined) {
      if (liveAgent(override) === undefined) return { ok: false, error: `配置的协调者会话 ${override} 当前未加载` }
      return { ok: true, sessionId: override, created: false }
    }
    const id = getMainSessionId(db)
    if (id !== undefined && liveAgent(id) !== undefined) return { ok: true, sessionId: id, created: false }
    let workspaceId
    try { workspaceId = await ensureWorkspace() } catch (error) {
      return { ok: false, error: `指挥舱工作区不可用：${error?.message ?? error}` }
    }
    let created
    try {
      created = await sessionController.create({ workspaceId, agentPreset: PRESET_ID, title: '主会话' })
    } catch (error) {
      return { ok: false, error: `创建主会话失败：${error?.message ?? error}` }
    }
    const sessionId = created?.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') return { ok: false, error: '创建主会话失败：没有返回 sessionId' }
    setMainSessionId(db, sessionId)
    log('main.session.created', { sessionId })
    return { ok: true, sessionId, created: true }
  }

  return { open, currentId }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/main-session.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/main-session.js test/main-session.test.js
git commit -m "feat: 主会话创建/打开/重建模块"
```

---

### Task 6: index.js 装配（移除自动绑定 + open-main）

**Files:**
- Modify: `index.js`
- Test: `test/index.test.js`

- [ ] **Step 1: 写失败测试**

在 `test/index.test.js` 加：

```js
test('apply 后 task_create 不再自动绑定；无主会话返回提示', async () => {
  const ctx = fakeCtx() // 沿用现有 helper
  await apply(ctx, {})
  const create = ctx.registeredTools.find(tool => tool.name === 'task_create')
  const result = await create.execute({ title: 't', goal: 'g', acceptance: ['a'] }, { agent: { id: 'any-session' } })
  assert.match(result, /主会话/)
  assert.equal(dbSetting(ctx, 'main_session_id'), undefined)
})

test('open-main 动作端点创建主会话并写 settings', async () => {
  const ctx = fakeCtx({ connection: true, sessionController: { create: async () => ({ sessionId: 'session-main' }) } })
  await apply(ctx, {})
  const route = ctx.routeHandlers[0]
  const response = await route(new Request('http://x/api/orchestrator', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: 'open-main' }),
  }))
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.sessionId, 'session-main')
  assert.equal(dbSetting(ctx, 'main_session_id'), 'session-main')
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/index.test.js`
Expected: FAIL

- [ ] **Step 3: 实现**

`index.js` 关键改动：

```js
import { createMainSession, PRESET_ID } from './src/main-session.js'
import { getMainSessionId, setMainSessionId, getSetting, addNotification } from './src/ledger.js'

// 删除 bindCoordinator / bindSettingOnce / rebindSetting 的调用与相关常量
const resolvedCoordinatorId = () => config.coordinatorSession ?? getMainSessionId(db)
const resolveCoordinator = () => {
  const id = resolvedCoordinatorId()
  return id === undefined ? undefined : ctx.get?.('agents')?.get?.(id)
}
const coordinatorStatus = () => {
  const id = resolvedCoordinatorId()
  return { id, live: id !== undefined && resolveCoordinator() !== undefined }
}

const mainSession = createMainSession({
  db, config,
  agents: ctx.get?.('agents'),
  sessionController: ctx.get?.('sessionController'),
  workspaces: ctx.get?.('workspaceRegistry'),
  workspacePath: join(stateDir(), 'workspace'),
  workspaceName: '指挥舱',
  log: (event, detail) => log(...),
})

// 只对配置覆盖会话保留运行期收窄；主会话由预设保证
if (config.coordinatorSession !== undefined) {
  const configured = resolveCoordinator()
  if (configured !== undefined) scheduleRestriction(configured)
}
```

`createTools({ db, dispatcher, notifier, config, status: coordinatorStatus, queue })`。

`createHostRoute({ db, coordinatorStatus, openMain: () => mainSession.open(), staleMinutes, limit })`，并用现有 `ctx.inject(['connection'], scope => ...)` 注册。

`guard` 与 `systemPrompt.context` 继续用 `resolvedCoordinatorId()` / `coordinatorStatus()`；不再有关键 `COORDINATOR_KEY` 的自动写库。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/index.test.js`
Expected: PASS（删除/改写旧的自动绑定用例）

- [ ] **Step 5: 提交**

```bash
git add index.js test/index.test.js
git commit -m "feat: 主会话取代首绑，open-main 端点"
```

---

### Task 7: host-route 扩展

**Files:**
- Modify: `src/host-route.js`
- Test: `test/host-route.test.js`

- [ ] **Step 1: 写失败测试**

在 `test/host-route.test.js` 加：

```js
test('snapshot 带 mainSession 与 targetDir；open-main 只建主会话', async () => {
  const db = await openLedger(dir)
  createTask(db, { brief: { title: 't', goal: 'g', acceptance: ['a'] }, coordinatorSession: 's', targetDir: 'C:/work' })
  const calls = []
  const route = createHostRoute({
    db,
    coordinatorStatus: () => ({ id: 's', live: true }),
    openMain: async () => { calls.push('open'); return { ok: true, sessionId: 'session-main' } },
  })
  const snapshot = await (await route(req({ endpoint: 'snapshot' }))).json()
  assert.deepEqual(snapshot.mainSession, { id: 's', live: true })
  assert.equal(snapshot.tasks[0].targetDir, 'C:/work')
  const opened = await (await route(req({ endpoint: 'open-main' }))).json()
  assert.equal(opened.sessionId, 'session-main')
  assert.deepEqual(calls, ['open'])
})
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/host-route.test.js`
Expected: FAIL

- [ ] **Step 3: 实现**

`src/host-route.js`：

```js
export function createHostRoute({ db, coordinatorStatus, openMain, staleMinutes = 30, limit = 200, now = Date.now }) {
  const snapshot = () => {
    const status = coordinatorStatus?.() ?? {}
    ...
      mainSession: { id: status.id ?? null, live: status.live === true },
      tasks: tasks.map(task => ({ ..., targetDir: task.target_dir ?? null, ... }))
  }
  return async function fetch(request) {
    let body
    try { body = await request.json() } catch { body = {} }
    const endpoint = String(body?.endpoint ?? '')
    if (endpoint === 'open-main') {
      if (openMain === undefined) return json({ ok: false, error: 'open-main-unavailable' }, 500)
      const result = await openMain()
      return json(result?.ok === true
        ? { ok: true, sessionId: result.sessionId, created: result.created === true }
        : { ok: false, error: result?.error ?? '创建主会话失败' }, result?.ok === true ? 200 : 500)
    }
    if (!ENDPOINTS.has(endpoint)) return json({ ok: false, error: 'unknown-endpoint' }, 400)
    return json(snapshot(), 200)
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/host-route.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/host-route.js test/host-route.test.js
git commit -m "feat: snapshot 主会话/目标目录与 open-main 动作"
```

---

### Task 8: 客户端「打开主会话」

**Files:**
- Modify: `client.js`
- Test: `test/client.test.js`

- [ ] **Step 1: 写失败测试**

在 `test/client.test.js` 加：

```js
test('面板提供「打开主会话」并调用 open-main', () => {
  assert.match(source, /打开主会话/)
  assert.match(source, /open-main/)
})

test('入口/头部按钮的文案仍是任务', () => {
  assert.match(source, /任务面板/)
})
```

- [ ] **Step 2: 实现**

`client.js`：

- 面板状态从 `snapshot.coordinator` 改为 `snapshot.mainSession`。
- 右上角按钮：

```js
  const openMain = async () => {
    const response = await fetch('/api/orchestrator', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint: 'open-main' }),
    })
    const body = await response.json()
    if (body?.ok === true && typeof body.sessionId === 'string') return ctx.uiWorkspace.openSession(body.sessionId)
    throw new Error(body?.error ?? '打开主会话失败')
  }
```

- 顶栏文案：`h('button', { type: 'button', onClick: handleOpenMain, style: styles.button }, '打开主会话')`；状态 `主会话在线 / 未创建 / 已失效`。
- 任务行在标题后加 `h('span', { style: styles.meta }, task.targetDir ?? '')`（截断 60 字）。

- [ ] **Step 3: 运行确认通过**

Run: `node --test test/client.test.js && node --check client.js`
Expected: PASS / exit 0

- [ ] **Step 4: 提交**

```bash
git add client.js test/client.test.js
git commit -m "feat: 客户端打开主会话与目标目录"
```

---

### Task 9: 协调者预设与文档

**Files:**
- Modify: `cordis.patch.yml`
- Modify: `README.md`
- Modify: `docs/api-notes.md`
- Test: `test/config.test.js`

- [ ] **Step 1: 写失败测试**

在 `test/config.test.js` 加：

```js
test('cordis.patch.yml 注册协调者预设行', () => {
  const source = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(source, /dsh-orchestrator-coordinator/)
  assert.match(source, /toolFilter/)
  assert.match(source, /task_create/)
})
```

- [ ] **Step 2: 实现**

按 `docs/probes/main-session-probe.md` §3 的准确字段，在 `cordis.patch.yml` 加预设行（以下为结构示意，字段以探针为准）：

```yaml
- insert:
    - id: orchestrator
      name: dsh-orchestrator
    - id: orchestrator-coordinator-preset
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: dsh-orchestrator-coordinator
        name: 协调者
        description: 只做协调：拆任务、派子会话、看回报；不读写文件、不执行命令。
        order: 80
        toolFilter:
          allow: [task_create, task_list, task_status, task_message, task_stop, ask_user, show_view]
```

README 增加「主会话」一节（入口、创建/重建、指挥舱、目标目录、预设工具集、迁移、配置覆盖），api-notes 补预设与 `create` 的探测结论。

- [ ] **Step 3: 运行确认通过**

Run: `npm test`
Expected: 全绿

- [ ] **Step 4: 提交**

```bash
git add cordis.patch.yml README.md docs/api-notes.md test/config.test.js
git commit -m "feat: 协调者预设与主会话文档"
```

---

### Task 10: 真机验收

**Files:** 无代码改动

- [ ] **Step 1: 隔离 profile 冒烟**

按 `docs/qa-checklist.md` 的新章节逐条跑：打开主会话（指挥舱 + 协调者预设）→ 工具表只剩允许项 → 带 target 派任务 → 子会话在目标目录 → 删除主会话后点入口重建 → 旧任务仍在面板。

- [ ] **Step 2: 装 desktop 并重启一次**

用 `link:` + bundle 的方式更新 desktop profile，用户重启一次；核对侧栏入口、面板「打开主会话」、旧任务列表、通知回主会话。

- [ ] **Step 3: 记录结论**

把通过数、截图/日志路径、未过项写进 `docs/qa-checklist.md`，提交。
