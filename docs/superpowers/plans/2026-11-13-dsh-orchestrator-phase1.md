# dsh-orchestrator 阶段 1 实现计划

> **给执行者：** 本计划由「dsh-orchestrator 组」的研发 Bot 顺序执行，每个任务「先写失败测试 → 跑失败 → 写实现 → 跑通过 → 提交」。测试 Bot 在独立 worktree 复跑，不采信转述数字。阶段 2（客户端）另立计划。

**目标：** 交付 dsh-orchestrator 的服务端核心：任务台账、状态机、结构化 brief 渲染、子会话派活、子任务回报、分级通知、协调者工具集与聊天内任务卡片。无客户端。

**架构：** cordis 插件（纯 ESM），台账用 `node:sqlite`，子会话复用平台 `ctx.agentTeams`（已确认方法：`spawnTeammate` / `sendMessage` / `interrupt` / `listMembers` / `membership`）。协调者会话即 Team Lead，子任务是同队的 teammate，回报走 `task_report` 工具 + 台账。

**技术栈：** Node ≥ 22.15、`node:sqlite`、`node:test`、cordis 插件。

**仓库：** `C:\Users\72489\Documents\dsh-orchestrator`（已初始化，设计文档已提交）。

---

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `index.js` | 插件入口：加载配置、装配各模块、注册工具 |
| `src/config.js` | 配置归一化（默认值、非法值回落） |
| `src/ledger.js` | SQLite 台账：建表、任务/消息/通知读写、快照 |
| `src/state.js` | 状态机：合法迁移表（纯函数） |
| `src/brief.js` | brief 校验与渲染成文字（纯函数） |
| `src/dispatch.js` | 封装 `ctx.agentTeams`：建子会话、投递、停止 |
| `src/notify.js` | 分级、合并、投递协调者会话 |
| `src/tools.js` | 协调者工具 + `task_report` 工具 |
| `src/card.js` | 任务卡片视图数据（`show_view` 用） |
| `test/helpers.js` | 临时台账、假 agentTeams |
| `test/*.test.js` | 单测与集成测试 |

---

### Task 1: 仓库骨架与配置

**Files:** Create `package.json`, `src/config.js`, `test/config.test.js`

- [ ] **Step 1: 写 `package.json`**

```json
{
  "name": "dsh-orchestrator",
  "version": "0.1.0",
  "private": true,
  "description": "Coordinator + task sessions for DeepSeek Harness: durable task ledger, brief rendering, progress reports, interrupt-controlled notifications.",
  "type": "module",
  "main": "index.js",
  "exports": { ".": "./index.js" },
  "files": ["index.js", "src/", "cordis.patch.yml", "README.md"],
  "engines": { "node": ">=22.15" },
  "scripts": { "test": "node --test --experimental-test-isolation=none \"test/*.test.js\"" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
  "keywords": ["dsh-plugin", "orchestrator", "tasks"]
}
```

- [ ] **Step 2: 写失败测试 `test/config.test.js`**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../src/config.js'

test('loadConfig 填默认值', () => {
  const config = loadConfig({})
  assert.equal(config.staleMinutes, 30)
  assert.equal(config.stallRounds, 3)
  assert.equal(config.maxActive, 8)
  assert.equal(config.mergeWindowMs, 5000)
  assert.equal(config.coordinatorSession, undefined)
})

test('loadConfig 覆盖合法值、忽略非法值', () => {
  const config = loadConfig({ staleMinutes: 10, stallRounds: -1, maxActive: 'x', mergeWindowMs: 0 })
  assert.equal(config.staleMinutes, 10)
  assert.equal(config.stallRounds, 3)
  assert.equal(config.maxActive, 8)
  assert.equal(config.mergeWindowMs, 5000)
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npm test`
Expected: FAIL，找不到 `../src/config.js`

- [ ] **Step 4: 写 `src/config.js`**

```js
// 配置归一化：非法值一律回落默认，不让坏配置把插件带崩。
const DEFAULTS = {
  staleMinutes: 30,
  stallRounds: 3,
  maxActive: 8,
  mergeWindowMs: 5000,
}

const positive = (value, fallback) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback

export function loadConfig(raw = {}) {
  const config = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS)) {
    config[key] = positive(raw[key], DEFAULTS[key])
  }
  config.coordinatorSession = typeof raw.coordinatorSession === 'string' && raw.coordinatorSession !== ''
    ? raw.coordinatorSession
    : undefined
  return config
}
```

- [ ] **Step 5: 跑测试确认通过并提交**

Run: `npm test` → PASS
```bash
git add package.json src/config.js test/config.test.js
git commit -m "feat: 骨架与配置"
```

---

### Task 2: 状态机

**Files:** Create `src/state.js`, `test/state.test.js`

- [ ] **Step 1: 写失败测试**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { canTransition, nextStatus, STATUSES } from '../src/state.js'

test('合法迁移', () => {
  assert.equal(canTransition('pending', 'running'), true)
  assert.equal(canTransition('running', 'waiting_auth'), true)
  assert.equal(canTransition('waiting_auth', 'running'), true)
  assert.equal(canTransition('running', 'done'), true)
  assert.equal(canTransition('running', 'failed'), true)
  assert.equal(canTransition('pending', 'cancelled'), true)
})

test('非法迁移', () => {
  assert.equal(canTransition('done', 'running'), false)
  assert.equal(canTransition('cancelled', 'pending'), false)
  assert.equal(canTransition('pending', 'done'), false)
  assert.equal(canTransition('running', 'pending'), false)
})

test('nextStatus 返回新状态或抛错', () => {
  assert.equal(nextStatus('running', 'done'), 'done')
  assert.throws(() => nextStatus('done', 'running'), /不允许/)
})

test('状态集合完整', () => {
  assert.deepEqual(STATUSES.sort(), ['cancelled', 'done', 'failed', 'orphaned', 'pending', 'running', 'waiting_auth', 'waiting_user'])
})
```

- [ ] **Step 2: 跑失败**：`npm test` → FAIL

- [ ] **Step 3: 写 `src/state.js`**

```js
// 任务状态机。只有子会话的回报能推进 running 之后的状态；
// 协调者只能创建、续派、停止、重派。
export const STATUSES = ['pending', 'running', 'waiting_user', 'waiting_auth', 'done', 'failed', 'cancelled', 'orphaned']

const TRANSITIONS = {
  pending: ['running', 'cancelled'],
  running: ['waiting_user', 'waiting_auth', 'done', 'failed', 'cancelled', 'orphaned'],
  waiting_user: ['running', 'cancelled', 'failed'],
  waiting_auth: ['running', 'cancelled', 'failed'],
  failed: ['running', 'cancelled'],
  done: [],
  cancelled: [],
  orphaned: ['pending', 'cancelled'],
}

export function canTransition(from, to) {
  if (!STATUSES.includes(from) || !STATUSES.includes(to)) return false
  return TRANSITIONS[from].includes(to)
}

export function nextStatus(from, to) {
  if (!canTransition(from, to)) throw new Error(`不允许的状态迁移：${from} → ${to}`)
  return to
}
```

- [ ] **Step 4: 跑通过并提交**

```bash
git add src/state.js test/state.test.js
git commit -m "feat: 任务状态机"
```

---

### Task 3: brief 校验与渲染

**Files:** Create `src/brief.js`, `test/brief.test.js`

- [ ] **Step 1: 写失败测试**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { validateBrief, renderBrief } from '../src/brief.js'

const valid = {
  title: '修复空数据文案',
  goal: '空窗口时报表给出明确说明',
  constraints: ['只改 src/report.js'],
  acceptance: ['空窗口输出明确说明', 'npm test 全绿'],
  refs: ['src/report.js:66'],
  user_verbatim: '你看这个空数据啥也没显示',
}

test('合法 brief 通过校验', () => {
  assert.deepEqual(validateBrief(valid), [])
})

test('缺必填项报错', () => {
  assert.match(validateBrief({}).join('\n'), /title/)
  assert.match(validateBrief({ title: 'x' }).join('\n'), /goal/)
  assert.match(validateBrief({ title: 'x', goal: 'y' }).join('\n'), /acceptance/)
})

test('渲染成结构化文字且不含 JSON', () => {
  const text = renderBrief(valid)
  assert.match(text, /【任务】修复空数据文案/)
  assert.match(text, /【目标】/)
  assert.match(text, /【约束】- 只改 src\/report\.js/)
  assert.match(text, /【验收标准】/)
  assert.match(text, /【背景资料】- src\/report\.js:66/)
  assert.match(text, /【用户原话】\n> /)
  assert.equal(text.includes('{'), false)
  assert.equal(text.includes('acceptance'), false)
})

test('可选字段为空时不出现对应小节', () => {
  const text = renderBrief({ title: 't', goal: 'g', acceptance: ['a'] })
  assert.equal(text.includes('【约束】'), false)
  assert.equal(text.includes('【用户原话】'), false)
})
```

- [ ] **Step 2: 跑失败**

- [ ] **Step 3: 写 `src/brief.js`**

```js
// brief 是内部结构化数据；发给子会话的永远是 renderBrief 渲染出的文字。
const text = value => typeof value === 'string' ? value.trim() : ''
const list = value => Array.isArray(value) ? value.map(text).filter(Boolean) : []

/** 返回错误列表；空数组表示合法。 */
export function validateBrief(brief = {}) {
  const errors = []
  if (text(brief.title) === '') errors.push('title 必填')
  if (text(brief.goal) === '') errors.push('goal 必填')
  if (list(brief.acceptance).length === 0) errors.push('acceptance 至少一条')
  return errors
}

export function renderBrief(brief = {}) {
  const lines = [`【任务】${text(brief.title)}`, `【目标】${text(brief.goal)}`]
  const constraints = list(brief.constraints)
  if (constraints.length > 0) lines.push(`【约束】${constraints.map(item => `- ${item}`).join('；')}`)
  lines.push(`【验收标准】\n${list(brief.acceptance).map(item => `- ${item}`).join('\n')}`)
  const refs = list(brief.refs)
  if (refs.length > 0) lines.push(`【背景资料】${refs.map(item => `- ${item}`).join('；')}`)
  const verbatim = text(brief.user_verbatim)
  if (verbatim !== '') lines.push(`【用户原话】\n> ${verbatim}`)
  lines.push('完成后请汇报：改了什么、改了哪些文件、怎么验证的。')
  return lines.join('\n')
}
```

- [ ] **Step 4: 跑通过并提交**

```bash
git add src/brief.js test/brief.test.js
git commit -m "feat: brief 校验与渲染"
```

---

### Task 4: 台账

**Files:** Create `src/ledger.js`, `test/helpers.js`, `test/ledger.test.js`

- [ ] **Step 1: 写夹具与失败测试**

`test/helpers.js`：

```js
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const tempDir = () => mkdtempSync(join(tmpdir(), 'orchestrator-'))

export function sampleBrief(overrides = {}) {
  return {
    title: 't', goal: 'g', constraints: [], acceptance: ['a'], refs: [], ...overrides,
  }
}
```

`test/ledger.test.js`：

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { openLedger, createTask, getTask, listTasks, transition, addMessage } from '../src/ledger.js'
import { tempDir, sampleBrief } from './helpers.js'

test('创建并读回任务', async () => {
  const db = await openLedger(tempDir())
  const task = createTask(db, { brief: sampleBrief({ title: 'A' }), coordinatorSession: 's-1' })
  assert.match(task.id, /^t-/)
  assert.equal(task.status, 'pending')
  assert.equal(getTask(db, task.id).title, 'A')
})

test('listTasks 默认只列活跃任务', async () => {
  const db = await openLedger(tempDir())
  const a = createTask(db, { brief: sampleBrief({ title: 'A' }), coordinatorSession: 's-1' })
  const b = createTask(db, { brief: sampleBrief({ title: 'B' }), coordinatorSession: 's-1' })
  transition(db, a.id, 'running')
  transition(db, b.id, 'cancelled')
  assert.deepEqual(listTasks(db, { active: true }).map(task => task.title), ['A'])
  assert.equal(listTasks(db).length, 2)
})

test('非法状态迁移被拒绝', async () => {
  const db = await openLedger(tempDir())
  const task = createTask(db, { brief: sampleBrief(), coordinatorSession: 's-1' })
  transition(db, task.id, 'running')
  transition(db, task.id, 'done')
  assert.throws(() => transition(db, task.id, 'running'), /不允许/)
})

test('消息按 seq 递增保存', async () => {
  const db = await openLedger(tempDir())
  const task = createTask(db, { brief: sampleBrief(), coordinatorSession: 's-1' })
  addMessage(db, task.id, { kind: 'brief', rendered: 'hello' })
  addMessage(db, task.id, { kind: 'followup', rendered: 'more' })
  const rows = db.prepare('SELECT kind, rendered FROM messages WHERE task_id = ? ORDER BY seq').all(task.id)
  assert.deepEqual(rows.map(row => row.kind), ['brief', 'followup'])
})
```

- [ ] **Step 2: 跑失败**

- [ ] **Step 3: 写 `src/ledger.js`**

```js
// 任务台账。SQLite，WAL，单写者串行化；所有状态迁移都过状态机。
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { nextStatus } from './state.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, goal TEXT NOT NULL, brief_json TEXT NOT NULL,
  status TEXT NOT NULL, session_id TEXT, target TEXT, coordinator_session TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  last_event_at INTEGER NOT NULL, error TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  task_id TEXT NOT NULL, seq INTEGER NOT NULL, kind TEXT NOT NULL,
  rendered TEXT NOT NULL, meta_json TEXT, at INTEGER NOT NULL, PRIMARY KEY (task_id, seq)
);
CREATE TABLE IF NOT EXISTS notifications (
  task_id TEXT NOT NULL, level TEXT NOT NULL, status TEXT NOT NULL,
  created_at INTEGER NOT NULL, delivered_at INTEGER, merged_into TEXT
);`

export async function openLedger(stateDir) {
  mkdirSync(stateDir, { recursive: true })
  const db = new DatabaseSync(join(stateDir, 'tasks.sqlite'))
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(SCHEMA)
  return db
}

const taskOf = row => row === undefined ? undefined : ({
  ...row,
  brief: JSON.parse(row.brief_json),
})

export function createTask(db, { brief, coordinatorSession }) {
  const now = Date.now()
  const id = `t-${randomUUID().slice(0, 8)}`
  db.prepare(`INSERT INTO tasks (id, title, goal, brief_json, status, coordinator_session, created_at, updated_at, last_event_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`)
    .run(id, brief.title, brief.goal, JSON.stringify(brief), coordinatorSession, now, now, now)
  return getTask(db, id)
}

export function getTask(db, id) {
  return taskOf(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id))
}

export function listTasks(db, { active = false } = {}) {
  const sql = active
    ? "SELECT * FROM tasks WHERE status IN ('pending','running','waiting_user','waiting_auth') ORDER BY created_at DESC"
    : 'SELECT * FROM tasks ORDER BY created_at DESC'
  return db.prepare(sql).all().map(taskOf)
}

export function transition(db, id, to, patch = {}) {
  const task = getTask(db, id)
  if (task === undefined) throw new Error(`任务不存在：${id}`)
  nextStatus(task.status, to)
  const now = Date.now()
  db.prepare('UPDATE tasks SET status = ?, updated_at = ?, last_event_at = ?, session_id = COALESCE(?, session_id), target = COALESCE(?, target), error = COALESCE(?, error) WHERE id = ?')
    .run(to, now, now, patch.sessionId ?? null, patch.target ?? null, patch.error ?? null, id)
  return getTask(db, id)
}

/** 只更新时间戳，不改状态（progress 回报用）。 */
export function touchTask(db, id) {
  const now = Date.now()
  db.prepare('UPDATE tasks SET updated_at = ?, last_event_at = ? WHERE id = ?').run(now, now, id)
  return getTask(db, id)
}

export function addMessage(db, taskId, { kind, rendered, meta = null }) {
  const next = db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages WHERE task_id = ?').get(taskId).seq
  db.prepare('INSERT INTO messages (task_id, seq, kind, rendered, meta_json, at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(taskId, next, kind, rendered, meta === null ? null : JSON.stringify(meta), Date.now())
  return next
}
```

- [ ] **Step 4: 跑通过并提交**

```bash
git add src/ledger.js test/helpers.js test/ledger.test.js
git commit -m "feat: 任务台账"
```

---

### Task 5: 派活封装（agentTeams）+ 接口探测

**Files:** Create `src/dispatch.js`, `test/dispatch.test.js`, `docs/api-notes.md`

平台侧已确认的服务方法（来自 `@deepseek-ai/dsh-experimental-agent-team` 实现）：

- `ctx.agentTeams.spawnTeammate(agent, { name, description, prompt, context, provider, signal })` → `{ member: { id, name, status, ... } }`
- `ctx.agentTeams.sendMessage(agent, { target, content, signal })`
- `ctx.agentTeams.interrupt(agent, target)`
- `ctx.agentTeams.listMembers(agent)`

- [ ] **Step 1: 写失败测试（假 agentTeams）**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { createDispatcher } from '../src/dispatch.js'

function fakeTeams() {
  const calls = []
  return {
    calls,
    async spawnTeammate(agent, input) { calls.push(['spawn', input.name]); return { member: { id: 'm1', name: input.name } } },
    async sendMessage(agent, input) { calls.push(['send', input.target]) },
    async interrupt(agent, target) { calls.push(['interrupt', target]) },
    listMembers() { return [{ id: 'm1', name: 'worker-1', status: 'inactive' }] },
  }
}

const agent = { id: 'a1' }

test('spawn 生成合法 kebab 名字并透传 prompt', async () => {
  const teams = fakeTeams()
  const dispatcher = createDispatcher({ agentTeams: teams, agent })
  const member = await dispatcher.spawn({ name: '修复 空数据', prompt: '【任务】x' })
  assert.equal(member.name, 'worker-1')
  assert.deepEqual(teams.calls[0], ['spawn', teams.calls[0][1]])
  assert.match(teams.calls[0][1], /^task-\d+-/)
})

test('send 与 stop 透传', async () => {
  const teams = fakeTeams()
  const dispatcher = createDispatcher({ agentTeams: teams, agent })
  await dispatcher.send('worker-1', '继续')
  await dispatcher.stop('worker-1')
  assert.deepEqual(teams.calls.map(call => call[0]), ['send', 'interrupt'])
})

test('slug 化：中文与空格转成 kebab', async () => {
  const teams = fakeTeams()
  const dispatcher = createDispatcher({ agentTeams: teams, agent })
  const name = dispatcher.slug('修复 空数据 文案')
  assert.match(name, /^[a-z0-9-]+$/)
})
```

- [ ] **Step 2: 跑失败**

- [ ] **Step 3: 写 `src/dispatch.js`**

```js
// 把 agentTeams 的能力收成一个窄接口：本插件只做派活、追加消息、停止。
let counter = 0

function slugify(title) {
  const ascii = String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  counter += 1
  return ascii === '' ? `task-${Date.now()}-${counter}` : `${ascii.slice(0, 32)}-${counter}`
}

export function createDispatcher({ agentTeams, agent, provider, onWarn = () => {} }) {
  return {
    slug(title) {
      return slugify(title)
    },
    async spawn({ name, description, prompt }) {
      const input = {
        name: name ?? slugify(prompt.slice(0, 20)),
        description: description ?? 'orchestrator task',
        prompt: [{ type: 'text', text: prompt }],
        context: 'fresh',
        ...(provider === undefined ? {} : { provider }),
      }
      const result = await agentTeams.spawnTeammate(agent, input)
      return result.member
    },
    async send(target, message) {
      return agentTeams.sendMessage(agent, { target, content: [{ type: 'text', text: message }] })
    },
    async stop(target) {
      return agentTeams.interrupt(agent, target)
    },
    members() {
      return agentTeams.listMembers(agent)
    },
  }
}
```

- [ ] **Step 4: 写接口说明 `docs/api-notes.md`**

记录三点，供联调核对：`inject` 服务名（先按 `['agentTeams', 'tools', 'agents']` 试，加载失败就逐个减）、`agent` 对象的来源（协调者会话 id → `ctx.get('agents')` 取得）、teammate 的 `id` 与 `session_id` 的对应关系（阶段 2 UI 需要它跳转）。

- [ ] **Step 5: 跑通过并提交**

```bash
git add src/dispatch.js test/dispatch.test.js docs/api-notes.md
git commit -m "feat: 派活封装与接口说明"
```

---

### Task 6: 通知分级与合并

**Files:** Create `src/notify.js`, `test/notify.test.js`

- [ ] **Step 1: 写失败测试**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { levelOf, createNotifier } from '../src/notify.js'

test('状态到级别映射', () => {
  assert.equal(levelOf('progress'), 'silent')
  assert.equal(levelOf('done'), 'notify')
  assert.equal(levelOf('blocked'), 'interrupt')
  assert.equal(levelOf('needs_auth'), 'interrupt')
})

test('silent 不投递，notify 合并，interrupt 立刻投递', async () => {
  const delivered = []
  const notifier = createNotifier({ send: async text => delivered.push(text), mergeWindowMs: 20 })
  notifier.push({ taskId: 't-1', title: 'A', status: 'progress', summary: '在跑' })
  assert.equal(delivered.length, 0)
  notifier.push({ taskId: 't-2', title: 'B', status: 'done', summary: '完成' })
  notifier.push({ taskId: 't-3', title: 'C', status: 'done', summary: '完成' })
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(delivered.length, 1)
  assert.match(delivered[0], /2 个任务完成/)
  notifier.push({ taskId: 't-4', title: 'D', status: 'blocked', summary: '要授权' })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(delivered.length, 2)
  assert.match(delivered[1], /需要你/)
})
```

- [ ] **Step 2: 跑失败**

- [ ] **Step 3: 写 `src/notify.js`**

```js
// 通知分级：progress 静默，done 批量合并，blocked/needs_auth 立即打断。
const LEVEL = { progress: 'silent', done: 'notify', blocked: 'interrupt', needs_auth: 'interrupt' }

export function levelOf(status) {
  return LEVEL[status] ?? 'silent'
}

const line = item => `- ${item.title}：${item.summary}`

export function createNotifier({ send, mergeWindowMs = 5000, onWarn = () => {} }) {
  let buffer = []
  let timer = null
  const flush = async () => {
    timer = null
    const batch = buffer
    buffer = []
    if (batch.length === 0) return
    const text = batch.length === 1
      ? `任务「${batch[0].title}」完成：${batch[0].summary}`
      : `${batch.length} 个任务完成：\n${batch.map(line).join('\n')}`
    try {
      await send(text)
    } catch (error) {
      onWarn(`通知投递失败：${error?.message ?? error}`)
    }
  }
  return {
    push(item) {
      const level = levelOf(item.status)
      if (level === 'silent') return
      if (level === 'interrupt') {
        void send(`任务「${item.title}」需要你：${item.summary}`).catch(error => onWarn(String(error)))
        return
      }
      buffer.push(item)
      if (timer === null) timer = setTimeout(() => { void flush() }, mergeWindowMs)
    },
    async drain() {
      if (timer !== null) clearTimeout(timer)
      await flush()
    },
  }
}
```

- [ ] **Step 4: 跑通过并提交**

```bash
git add src/notify.js test/notify.test.js
git commit -m "feat: 通知分级与合并"
```

---

### Task 7: 工具集（协调者工具 + task_report）

**Files:** Create `src/tools.js`, `test/tools.test.js`

- [ ] **Step 1: 写失败测试**

测试覆盖（用临时台账 + 假 teams + 假 notifier）：

- `task_create`：缺 `acceptance` 返回可读提示且不建任务；正常创建后子会话被 spawn、台账状态为 running。
- `task_list`：默认只列活跃任务；空表时返回"没有活跃任务"。
- `task_status`：不存在的 id 返回可读提示。
- `task_message`：追加 followup 并调用 `send`。
- `task_stop`：状态变 cancelled 且调用 `interrupt`。
- `task_report`：`progress` 不改状态只更新时间；`done` 迁移并触发通知；`blocked` 迁到 waiting_user。
- 每个工具的 `parameters` 是对象根 schema 且不带 `minimum`/`maximum`。

- [ ] **Step 2: 写 `src/tools.js`**

```js
// 工具层：只做参数校验、编排与可读文案；规则都在 brief / ledger / state / notify。
import { validateBrief, renderBrief } from './brief.js'
import { addMessage, createTask, getTask, listTasks, touchTask, transition } from './ledger.js'

const objectSchema = properties => ({ type: 'object', properties, additionalProperties: false })
const str = description => ({ type: 'string', description })
const strList = description => ({ type: 'array', items: { type: 'string' }, description })
const textOutput = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }

const REPORT_STATUS = ['progress', 'done', 'blocked', 'needs_auth']
const STATUS_LABEL = {
  pending: '待派发', running: '进行中', waiting_user: '等你确认', waiting_auth: '要授权',
  done: '已完成', failed: '失败', cancelled: '已取消', orphaned: '会话丢失',
}

const line = task => `- ${task.id}｜${task.title}｜${STATUS_LABEL[task.status] ?? task.status}｜子会话 ${task.target ?? '-'}`

export function createTools({ db, dispatcher, notifier, config }) {
  const wrap = (name, description, parameters, execute) => ({
    name,
    description,
    parameters,
    output: textOutput,
    async execute(args = {}) {
      try {
        return await execute(args ?? {})
      } catch (error) {
        return `任务协调失败：${error?.message ?? error}`
      }
    },
  })

  return [
    wrap('task_create', '创建一个子任务：建台账、检查活跃上限、渲染 brief 派生一个子会话。description 由你写清目标与验收。', objectSchema({
      title: str('一句话任务名，卡片上显示'),
      goal: str('要达成的目标，一两句话'),
      constraints: strList('约束，可空'),
      acceptance: strList('验收标准，至少一条'),
      refs: strList('背景资料，如文件路径，可空'),
      user_verbatim: str('用户原话，可空；子任务能自己读到'),
    }), async args => {
      const errors = validateBrief(args)
      if (errors.length > 0) return `任务描述不完整：${errors.join('；')}。补齐后再派。`
      const active = listTasks(db, { active: true })
      if (active.length >= config.maxActive) return `活跃任务已达上限 ${config.maxActive}，先完成或停止一些任务。`
      const task = createTask(db, { brief: args, coordinatorSession: config.coordinatorSession ?? 'unknown' })
      const rendered = `【任务编号】${task.id}\n${renderBrief(args)}`
      addMessage(db, task.id, { kind: 'brief', rendered })
      const member = await dispatcher.spawn({ name: dispatcher.slug(args.title), description: args.title, prompt: rendered })
      transition(db, task.id, 'running', { sessionId: member.id, target: member.name })
      return `任务 ${task.id}「${task.title}」已派发，子会话 ${member.name}。`
    }),

    wrap('task_list', '列出任务。默认只列活跃任务（pending/running/waiting），active=false 时连同历史一起列出。', objectSchema({
      active: { type: 'boolean', description: '是否只看活跃任务，默认 true' },
    }), async args => {
      const tasks = listTasks(db, { active: args.active !== false })
      if (tasks.length === 0) return args.active === false ? '台账里还没有任何任务。' : '没有活跃任务。'
      return tasks.map(line).join('\n')
    }),

    wrap('task_status', '查看一个任务的详情与最近消息。', objectSchema({ task_id: str('任务编号，如 t-1a2b3c4d') }), async args => {
      const task = getTask(db, args.task_id ?? '')
      if (task === undefined) return `没有任务 ${args.task_id ?? ''}。用 task_list 查编号。`
      const messages = db.prepare('SELECT kind, rendered, at FROM messages WHERE task_id = ? ORDER BY seq DESC LIMIT 3').all(task.id)
      const recent = messages.map(row => `- [${row.kind}] ${row.rendered.split('\n')[0]}`).join('\n')
      return `任务 ${task.id}「${task.title}」\n状态：${STATUS_LABEL[task.status] ?? task.status}\n子会话：${task.target ?? '-'}\n最近消息：\n${recent || '- 无'}`
    }),

    wrap('task_message', '给已有子任务追加一条消息（续派），不新建任务。', objectSchema({
      task_id: str('任务编号'),
      message: str('要追加的内容'),
    }), async args => {
      const task = getTask(db, args.task_id ?? '')
      if (task === undefined) return `没有任务 ${args.task_id ?? ''}。`
      if (task.target === null || task.target === undefined) return `任务 ${task.id} 还没有子会话，先停止再重建。`
      addMessage(db, task.id, { kind: 'followup', rendered: args.message })
      await dispatcher.send(task.target, args.message)
      return `已把消息追加给任务 ${task.id}（子会话 ${task.target}）。`
    }),

    wrap('task_stop', '停止一个子任务（会中断它的当前一轮）。', objectSchema({ task_id: str('任务编号') }), async args => {
      const task = getTask(db, args.task_id ?? '')
      if (task === undefined) return `没有任务 ${args.task_id ?? ''}。`
      if (task.target !== null && task.target !== undefined) await dispatcher.stop(task.target)
      transition(db, task.id, 'cancelled')
      return `任务 ${task.id} 已停止。`
    }),

    wrap('task_report', '子任务每轮结束必须调用：progress（有进展未完成）、done（完成）、blocked（卡住等人决定）、needs_auth（需要授权）。协调者据此决定是否打扰用户。', objectSchema({
      task_id: str('任务编号，创建时给过'),
      status: { type: 'string', enum: REPORT_STATUS, description: 'progress / done / blocked / needs_auth' },
      summary: str('一句话说明这轮做了什么'),
    }), async args => {
      const task = getTask(db, args.task_id ?? '')
      if (task === undefined) return `没有任务 ${args.task_id ?? ''}，确认 task_id 是否抄错。`
      if (!REPORT_STATUS.includes(args.status)) return `status 只能是 ${REPORT_STATUS.join(' / ')}。`
      addMessage(db, task.id, { kind: 'report', rendered: `[${args.status}] ${args.summary ?? ''}` })
      let next = task
      if (args.status === 'done') next = transition(db, task.id, 'done')
      else if (args.status === 'blocked') next = transition(db, task.id, 'waiting_user')
      else if (args.status === 'needs_auth') next = transition(db, task.id, 'waiting_auth')
      else next = touchTask(db, task.id)
      notifier.push({ taskId: next.id, title: next.title, status: args.status, summary: args.summary ?? '' })
      return `已记录任务 ${next.id} 的 ${args.status} 回报。`
    }),
  ]
}
```

- [ ] **Step 3: 跑通过并提交**

Run: `npm test` → PASS
```bash
git add src/tools.js test/tools.test.js
git commit -m "feat: 协调者与回报工具"
```

---

### Task 8: 任务卡片数据

**Files:** Create `src/card.js`, `test/card.test.js`

- [ ] **Step 1: 写失败测试**

断言：卡片包含标题、状态中文名、最近摘要、`taskId`；状态色值映射；长摘要截断到 80 字。

- [ ] **Step 2: 写 `src/card.js`**

```js
// 卡片只描述数据，不关心渲染框架；阶段 2 的客户端直接复用它。
const STATUS_LABEL = {
  pending: '待派发', running: '进行中', waiting_user: '等你确认', waiting_auth: '要授权',
  done: '已完成', failed: '失败', cancelled: '已取消', orphaned: '会话丢失',
}
const STATUS_TONE = { pending: 'muted', running: 'info', waiting_user: 'warn', waiting_auth: 'warn', done: 'good', failed: 'bad', cancelled: 'muted', orphaned: 'bad' }

export function taskCard(task, { summary = '', maxLength = 80 } = {}) {
  const text = summary.length > maxLength ? `${summary.slice(0, maxLength)}…` : summary
  return {
    taskId: task.id,
    title: task.title,
    status: task.status,
    label: STATUS_LABEL[task.status] ?? task.status,
    tone: STATUS_TONE[task.status] ?? 'muted',
    summary: text,
  }
}
```

- [ ] **Step 3: 跑通过并提交**

```bash
git add src/card.js test/card.test.js
git commit -m "feat: 任务卡片数据"
```

---

### Task 9: 插件入口与装配

**Files:** Create `index.js`, `cordis.patch.yml`, `test/index.test.js`

- [ ] **Step 1: 写失败测试**

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, inject, name } from '../index.js'

test('inject 声明包含 tools 与 agentTeams', () => {
  assert.equal(name, 'dsh-orchestrator')
  assert.deepEqual([...inject].sort(), ['agents', 'agentTeams', 'tools'])
})

test('apply 注册 6 个工具', async () => {
  const home = mkdtempSync(join(tmpdir(), 'orch-home-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const registered = []
  const agent = { id: 'a1' }
  const ctx = {
    logger: { warn() {} },
    tools: { register(tool) { registered.push(tool); return () => {} } },
    get: () => ({ get: () => agent }),
    agentTeams: {
      async spawnTeammate() { return { member: { id: 'm1', name: 'w-1' } } },
      async sendMessage() {},
      async interrupt() {},
      listMembers() { return [] },
    },
    effect: () => () => {},
  }
  try {
    await apply(ctx, { coordinatorSession: 's-1' })
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
  assert.deepEqual(registered.map(tool => tool.name).sort(),
    ['task_create', 'task_list', 'task_message', 'task_report', 'task_status', 'task_stop'])
})
```

- [ ] **Step 2: 写 `index.js`**

```js
// dsh-orchestrator：协调者会话 + 子任务。唯一写入是 $DSH_HOME/state/orchestrator。
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from './src/config.js'
import { openLedger } from './src/ledger.js'
import { createDispatcher } from './src/dispatch.js'
import { createNotifier } from './src/notify.js'
import { createTools } from './src/tools.js'

export const name = 'dsh-orchestrator'
export const inject = ['tools', 'agentTeams', 'agents']

export async function apply(ctx, rawConfig = {}) {
  const config = loadConfig(rawConfig)
  const stateDir = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'state', 'orchestrator')
  const db = await openLedger(stateDir)

  const agent = config.coordinatorSession === undefined
    ? undefined
    : ctx.get('agents')?.get?.(config.coordinatorSession)
  if (agent === undefined) {
    ctx.logger?.warn?.('dsh-orchestrator: 未配置或找不到 coordinatorSession，工具会注册但派活会失败')
  }

  const dispatcher = createDispatcher({
    agentTeams: ctx.agentTeams,
    agent,
    onWarn: message => ctx.logger?.warn?.(message),
  })
  const notifier = createNotifier({
    mergeWindowMs: config.mergeWindowMs,
    onWarn: message => ctx.logger?.warn?.(message),
    send: async text => {
      if (agent === undefined) return
      await ctx.agentTeams.sendMessage(agent, { target: 'lead', content: [{ type: 'text', text }] })
    },
  })

  for (const tool of createTools({ db, dispatcher, notifier, config })) {
    ctx.tools.register(tool)
  }
  ctx.effect?.(() => () => {
    void notifier.drain()
    try { db.close() } catch { /* 关闭失败不影响已完成的写入 */ }
  })
}
```

`cordis.patch.yml`：

```yaml
- insert:
    - id: orchestrator
      name: dsh-orchestrator
```

- [ ] **Step 3: 跑通过并提交**

Run: `npm test` → PASS
```bash
git add index.js cordis.patch.yml test/index.test.js
git commit -m "feat: 插件入口"
```

---

### Task 10: README 与集成冒烟

- [ ] **Step 1: 写 README**：定位、只写 `state/orchestrator` 的说明、配置项表、工具清单、一个完整示例（建任务→子任务回报→卡片→通知）。
- [ ] **Step 2: `npm test` 全绿**
- [ ] **Step 3: 真机冒烟**：装进 profile（`link:` + bundle），建一个任务，确认子会话被创建、回报写入台账、done 通知出现在协调者会话。
- [ ] **Step 4: 提交**

---

## 自查记录

- 规格覆盖：设计 §5 台账 → Task 4；§6 状态机 → Task 2；§7 协议 → Task 3；§8 回报与打扰 → Task 6/7；§9 复用判定 → Task 7 的 `task_list` + `task_message`（判定由协调者做）；§10 能力边界 → Task 7 的工具集；§11 卡片 → Task 8；§12 错误处理 → 各任务的可读文案要求；§14 阶段 1 → 本计划全部任务。
- 占位符扫描：无 TBD/TODO；每个任务都给出完整代码或完整测试代码与命令。
- 命名一致性：`openLedger / createTask / getTask / listTasks / transition / touchTask / addMessage`、`validateBrief / renderBrief`、`createDispatcher`、`levelOf / createNotifier`、`createTools`、`taskCard` 在定义与调用处一致。
- 已知待联调点（不影响任务顺序）：`ctx.agentTeams.sendMessage` 向 `lead` 投递能否唤醒协调者自身会话，Task 5 Step 4 的 `docs/api-notes.md` 要先验这一条；若不能，改用会话注入 API，并在该文档记录最终用法。
