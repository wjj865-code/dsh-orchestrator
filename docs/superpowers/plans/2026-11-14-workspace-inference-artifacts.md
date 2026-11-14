# 阶段 3 增量：工作区推断与交付产物回传

> 依据：用户 2026-11-14 在群里确认的两条规则；Chief 的开题口径。目标是在已完成的主会话机制上补两件事，不回退阶段 1/2/3 已有能力。

## 目标

1. `task_create` **不传 target** 时，用任务标题/目标文本推断已注册工作区；唯一命中直接用该工作区目录，多命中列候选、不建任务、不猜测，无命中仍回指挥舱。**显式 target 契约不变**（必须是存在的绝对目录，不合法拒绝）。
2. `task_report` 增加可选 `artifacts`（路径列表 + 说明），**按任务 cwd 解析成绝对路径**后落台账；`done` 通知里附「产物：绝对路径 — 说明」回主会话；面板任务行显示产物条数并可展开。只认子会话**显式上报**，不做目录自动扫描；文件不存在标注「未找到」，不影响任务状态。

## 契约

### 工作区推断（纯函数 `src/workspace-match.js`）

输入：`text`（`title` + `goal`，换行连接）、`workspaces`（`workspaceRegistry.list()` 的实体数组：`{ id, title, path }`）。

- 每个工作区提供两个匹配键：显示名 `title`、路径末段 `basename(path)`；大小写不敏感、去首尾空白。
- 键过滤：空键跳过；纯 ASCII 键长度 < 3 跳过（避免 `ai` 这类短词误命中），含中文等非 ASCII 的键长度 ≥ 2。
- **精确层**：键与标题或目标（整段、trim、小写）完全相等。
- **子串层**：键出现在文本里（小写包含）。
- 结果按层优先：精确层有命中就**只在精确层里选**（子串命中不混入）；否则看子串层。命中集合按工作区 id 去重（title 与路径末段都命中只算一个）。
- 返回：唯一命中 `{ ok: true, workspace }`；多命中 `{ ok: false, candidates: [{id,title,path}] }`；无命中 `{ ok: true, workspace: undefined }`。不按最近活跃/排序取第一个。

工具层：

- 有 target → 走原 `validateTargetDir`，不推断。
- 唯一命中 → `targetDir = workspace.path`，**同时写进 `target_dir`**（artifacts 相对路径与面板展示都依赖它），brief 增加【工作目录】。
- 多命中 → 返回可读文本，**不落库、不建任务**，列出 `title → path` 候选，提示用 `target` 指定绝对路径；文本包含「匹配到多个工作区」和 `candidates` 语义。
- 无命中 → 保持现状：不写 `target_dir`，子会话跑在主会话 cwd（指挥舱）。
- 服务依赖：`index.js` 给 `createTools` 传 `workspaces: () => ctx.get('workspaceRegistry')`（惰性 getter）；服务缺失时按 `none` 处理，不报错。

### artifacts（`task_report`）

- 入参：`artifacts: [{ path, label? }]`，可选；`path` 允许相对，按任务 cwd 解析。
- 任务 cwd：`task.target_dir ?? 主会话指挥舱目录`（`index.js` 把 `join(stateDir(),'workspace')` 作为 `defaultCwd` 传给 `createTools`；推断/显式 target 都会写 `target_dir`）。
- 解析结果每条：`{ path: 绝对路径, label: label ?? '', exists: <stat 是否存在> }`；**非法条目静默丢弃**（非数组、缺 path、非字符串），解析/stat 失败按 `exists: false`，任何情况都不让 report 失败。
- 落库：台账 `tasks.artifacts_json TEXT`，旧库 `ALTER TABLE` 自动补列；`taskOf` 解析成 `task.artifacts`，**无记录/旧库按 `[]`**。新增 `setTaskArtifacts(db, id, artifacts)`。
- 聚合：合并窗口内多条 report 的产物各自随消息列出，不互相覆盖；`blocked`/`needs_auth` 立即通知同样带产物。
- 通知：`task_report` 的 done 通知在 `- 标题：摘要` 后追加
  ```
    产物：
    - <绝对路径> — <说明>（未找到）
  ```
  合并窗口多条任务时每条各自带产物；没上报 artifacts 时文本与现在完全一致。
- 面板：`snapshot.tasks[].artifacts`（`path/label/exists`），任务行显示 `产物 N` 徽标，点击展开路径列表；`taskCard` 增加 `artifactCount`；旧任务缺字段按空数组处理，客户端不能抛。

## 任务拆分（TDD，每任务一提交）

| # | 任务 | 文件 | 测试 |
| --- | --- | --- | --- |
| 1 | 计划提交 | 本文件 | — |
| 2 | 工作区匹配纯函数 | `src/workspace-match.js` | `test/workspace-match.test.js`：精确优先/子串/多命中/无命中/短键过滤/大小写/去重 |
| 3 | `task_create` 推断接入 | `src/tools.js`、`index.js` | `test/tools.test.js`：唯一命中写 `target_dir` + brief【工作目录】；多命中不建任务且列候选；无命中 `target_dir=NULL`；显式 target 覆盖推断；workspaces 缺失降级 |
| 4 | 台账 artifacts 列 | `src/ledger.js` | `test/ledger.test.js`：新库有列、旧库 ALTER、`setTaskArtifacts` 读写 |
| 5 | `task_report` artifacts + 通知文本 | `src/tools.js`、`src/notify.js` | `test/tools.test.js` + `test/notify.test.js`：相对路径按 cwd 解析、缺失标注、done 通知原文含绝对路径/说明/未找到、不传 artifacts 完全兼容 |
| 6 | 快照/卡片/客户端展示 | `src/host-route.js`、`src/card.js`、`client.js` | `test/host-route.test.js`（`artifacts` 字段）、`test/card.test.js`（`artifactCount`）、`test/client.test.js`（徽标/展开文案） |
| 7 | 文档 | `README.md`、`docs/api-notes.md` | 文案与实现对齐 |

## 验收

- `npm test` 全绿；`node --check client.js`。
- 增量探针：`qa-main-session`、L1/L2 复跑 PASS（回归）。
- 测试 worktree 独立复跑通过；审查终审必须改 0 条。
- 已知风险：工作区标题可能高度相似导致多命中（按「列候选」处理，不猜）；相对产物路径依赖任务 cwd，未推断/未传 target 时按指挥舱解析；不做目录扫描。
