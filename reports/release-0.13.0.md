# 发版记录：0.13.0（T6 交付闭环 + P7 客户端源码化 + P8 计划模式 + P9 worktree 隔离 + F4 面板修复）

- 日期：2026-11-15
- 版本：`0.13.0`（minor，相对 0.12.0 无破坏性变更；不开 `planFirst` / `worktree` 的任务行为不变）
- 仓库：<https://github.com/wjj865-code/dsh-orchestrator>
- 发布 commit：`56fbc2f`（`release: v0.13.0`，父提交 `c898854`）
- tag：`v0.13.0`（annotated，tag 对象 `dc8c6d8`）→ commit `56fbc2f`
- 结论：**代码/tag/npm/镜像都已到位，但 `release.yml` 这次没跑绿**——CI 缺「装依赖」步骤导致 `npm test` 秒失败
  （`vite: not found` → exit 127），0.13.0 的 npm 发布因此改为本地 `npm publish` 兜底（**无 provenance**）。
  CI 工作流已修（`aecb24c`，main 上 ci run `43731964256` 绿），tag 未移动、未重复推。

## 这次发的内容

- **T6 交付闭环**：通知的产物区块只列 present 接得住的候选（普通文件 + 绝对路径，目录/符号链接/不存在/相对路径只计数），
  并带「在你自己的回合里调用 `present`」交付指令（候选上限 4）；`task_status` 新增产物区块，与通知**共用**
  `artifactLines()`；结算自动 done 的通知补上 `artifacts`（`beforeNotify` 钩子在通知前跑）。
- **P7 客户端源码化 + vite**：2283 行手写 `client.js` 拆成 `client/src/**` 10 个 ESM 文件，
  `vite@7.3.8` 构建出 `dist/client.js`（iife classic script、单 `__ModuleLoader__.load`、不含 react），
  `exports["./client"]` / `files` 切到 `dist/`，`pretest` 自动构建。
- **P8 计划模式**：`task_create({ planFirst: true })` 让子会话只读沙箱 + 平台 plan-mode 起步，
  批准后切 `workspace-write` 并关 plan mode；台账 `plan_first` / `plan_state`。
- **P9 worktree 隔离**：`task_create({ ..., worktree: true })` 在宿主建 `git worktree`，子会话在
  `<repo>/.agents/worktrees/<taskId>` 干活，分支留仓库、合并由用户决定；台账七列 + 清理三档。
- **F4 修复**（0.13.0 UI 冒烟第 4 项）：`client/src/views.js` 解构 `WORKTREE_STATE_LABEL` /
  `WORKTREE_SOURCE_LABEL`，但 `client.js` 没传 → 台账里一旦有 `worktree_state != 'none'` 的任务，
  `renderTask` 抛 `TypeError`、`main` 槽位被错误边界清空（面板全白）。补 import + 传参，两处使用点改可选链兜底；
  回归用例 +1（喂 `created` / 未知状态 `weird-state` / `none` 三种快照）。

## 发版动作

| 步骤 | 内容 | 结果 |
| --- | --- | --- |
| 1 | `npm test`（`pretest` 触发 `vite build`）+ `npm run check:client` | ✅ 718 tests / 718 pass / 0 fail；check:client 通过 |
| 2 | `npm version minor --no-git-tag-version`：`package.json` `0.12.0` → `0.13.0` | ✅ |
| 3 | `CHANGELOG.md`：两条「未发布」（P9/P8）收成 `## 0.13.0（2026-11-15）`，补 T6 / P7 / F4 三节，修掉「版本号暂留 0.12.0」的旧说明 | ✅ |
| 4 | `README.md` 版本字面量同步 0.13.0（顶部最新版、安装命令、发版示例、排障首行） | ✅ |
| 5 | `git commit` F4 修复 → `c898854`（5 文件：`client/src/client.js`、`client/src/views.js`、`test/client.test.js`、`dist/client.js(+map)`） | ✅ |
| 6 | `git commit -m "release: v0.13.0"`（`package.json` / `CHANGELOG.md` / `README.md`）→ `56fbc2f` | ✅ |
| 7 | `git tag -a v0.13.0 -m "..."`（tag 对象 `dc8c6d8`） | ✅ |
| 8 | `git push origin main --follow-tags`（`623735a..56fbc2f` + 新 tag `v0.13.0`） | ✅ |

## 工作流：release.yml 失败（根因 + 修复）

| run | 工作流 | 触发 | 结论 |
| --- | --- | --- | --- |
| [43731752060](https://github.com/wjj865-code/dsh-orchestrator/actions/runs/43731752060) | `release.yml` | tag `v0.13.0` push | ❌ **failure**（12s，`Test` 步骤 `Process completed with exit code 127`） |
| [43731752097](https://github.com/wjj865-code/dsh-orchestrator/actions/runs/43731752097) | `ci.yml` | main push | ❌ failure（10s，同根因，2 条 error：exit 1 / exit 127） |
| [43731964256](https://github.com/wjj865-code/dsh-orchestrator/actions/runs/43731964256) | `ci.yml` | CI 修复 commit `aecb24c` | ✅ **success**（21s） |

- **根因**：P7（`cf7fe4c`）给 `pretest` 加了 `vite build`（`vite` 是 devDependency），但 `ci.yml` / `release.yml`
  从来只有 Checkout + Setup Node，**没有装依赖的步骤**。这两个工作流此前的成功记录都早于 P7，而 P7–P9 的提交当时
  「只本地提交、不 push」，所以 0.13.0 是 CI 第一次见到 `vite`。
- **本地复现**：`git archive HEAD` 到一个不含 `node_modules` 的空目录跑 `npm test`
  → `> pretest` → `> vite build` → `'vite' is not recognized as an internal or external command`（Linux CI 上即 `vite: not found` / 127）。
- **修复**：`aecb24c` 在 `ci.yml`、`release.yml` 的 Setup Node 之后各加一步 `npm install --no-audit --no-fund`
  （仓库有意不提交 lockfile，`vite` 已 pin 精确版本，所以不用 `npm ci`）。推 main 后 `ci.yml` 立即转绿（run `43731964256`，21s，含 718 条测试）。
- **为什么不重跑 tag 工作流**：GitHub 重跑用的是 **tag 指向的那个提交**里的 `release.yml`（仍然缺装依赖步骤），
  要让它生效就得移动 `v0.13.0` tag——按发布约定不重复推 tag、不移动已发布的 tag，所以没有这么做。

## npm 发布（本地兜底，无 provenance）

因为 tag 工作流不可重跑、也不允许移动 tag，0.13.0 的 npm 发布改用本地已登录的 npm 凭据兜底，其余参数与工作流一致：

```text
$ npm publish --access public --ignore-scripts
npm notice Publishing to https://registry.npmjs.org/ with tag latest and public access
npm notice Your package is being processed and may take a few minutes to become available.
+ @wjj865-code/dsh-orchestrator@0.13.0
（PUT 返回 202 Accepted；约 3 分钟后 packument 才出现 0.13.0）
```

- **与 0.12.0 的差异**：0.12.0 由 `release.yml` 用 `--provenance`（OIDC）发布，带 SLSA 来源证明；
  这次是本地发布，`npm view …@0.13.0 dist.attestations` 为空 = **没有 provenance**。
  后续版本修好 CI 后回到工作流发布即可恢复；0.13.0 本身不重新发布（npm 不允许覆盖已发布版本）。
- 包里 54 个文件，`dist/client.js`、`src/worktree.js`、`src/plan-mode.js`、`docs/UI.md` 等均在包内。

## 发布后验证

npm（registry.npmjs.org）：

```text
$ npm view @wjj865-code/dsh-orchestrator dist-tags
{ latest: '0.13.0' }

$ npm view @wjj865-code/dsh-orchestrator@0.13.0 version dist.tarball dist.shasum
version = '0.13.0'
dist.tarball = 'https://registry.npmjs.org/@wjj865-code/dsh-orchestrator/-/dsh-orchestrator-0.13.0.tgz'
dist.shasum = 'e2a05b899ae5e2c259d1b9f0e259bcc6b33ec2c7'

$ npm view @wjj865-code/dsh-orchestrator versions --json   # 末三项
  "0.11.0", "0.12.0", "0.13.0"
```

- tarball：刚发布时 `HEAD …0.13.0.tgz` 404（CDN 还在传播），约 5 分钟后 `HEAD` → **HTTP 200**。
- `npm view` 的结果与直接打 packument（带 cache-buster）一致，不是本地缓存骗人。

npmmirror（registry.npmmirror.com）：

```text
$ node scripts/mirror-sync.mjs --no-wait
包：@wjj865-code/dsh-orchestrator@0.13.0
镜像缺 0.13.0（镜像 latest = 0.12.0）
上游 npm 已有 0.13.0，可以触发镜像同步
已提交同步请求：PUT https://registry.npmmirror.com/-/package/%40wjj865-code%2Fdsh-orchestrator/syncs
  响应：{"ok":true,"id":"6af9d602f754a7fd82f21815","type":"sync_package","state":"waiting"}
```

同步结果（`syncs` 接受后约 1 分钟，镜像 packument 出现 0.13.0）：

| 检查项 | 结果 |
| --- | --- |
| 直接打 packument（带 cache-buster，绕开本地缓存） | `dist-tags.latest` = **0.13.0**，17 个版本（含 0.13.0） |
| `…/-/dsh-orchestrator-0.13.0.tgz` | `GET` **200**（259,428 B） |
| 从镜像 `npm pack @0.13.0` 解包 | `version: 0.13.0`，54 个文件，`dsh.client.inject` 4 项 |
| `npm view … dist-tags --registry=https://registry.npmmirror.com --prefer-online --cache <新目录>` | `{ latest: '0.13.0' }`，版本清单末尾 `0.13.0` |
| 62s 后 `npm run mirror:check` | `镜像已有 0.13.0（镜像 latest = 0.13.0）：无需同步` |

过场说明：同步请求被接受后那 1～3 分钟里，`mirror:check`（node `fetch`、不带 cache-buster）有一阵子仍报
`镜像缺 0.13.0（镜像 latest = 0.12.0）`，而同一时刻 PowerShell 直连同一 URL 已能读到 0.13.0、tarball 也已 200——
是 npmmirror 不同 CDN 边缘的 packument 缓存还没统一；等缓存翻页后两条路径都报 0.13.0（上表最后一行）。

## 仓库卫生

- 提交范围只用代码 / 测试 / 文档 / 版本文件 / 工作流：`c898854`（修复+回归+产物）、`56fbc2f`（版本+CHANGELOG+README）、
  `aecb24c`（CI 装依赖）。
- `reports/` 里没有 `smoke-*`（本轮冒烟证据都在编排工作区 `reports/smoke-0.13.0-*`，没进仓库）。
- 跟踪文件干净；**仍有本任务开始前就存在的未跟踪产物**（非本次发版产出，原样未动）：
  `docs/probes/contract-probe-t0.1.mjs`、`docs/probes/lib/asar-read.mjs`、`docs/probes/out/t0.1-contract-probe.json`、
  `reports/t0.1-probes.md`、`reports/dev-profile/`、`reports/local-dev-profile.md`、`reports/local-link-backup/`、
  `reports/web-smoke/`、`web-smoke-dsh-dev.md`。

## 小结

- 0.13.0 已可安装：npm `latest` = 0.13.0，版本清单含 0.13.0，tarball 200；npmmirror 见上。
- 这次踩的坑值得记：**给 `pretest` / `prepublishOnly` 加构建步骤，必须同时确认 CI 装了依赖**——否则工作流秒失败（127），
  而 tag 一旦推上去就不可原地修（工作流文件取自 tag 提交）。
- 下次发版：依赖步骤已在两个工作流里，正常 `npm version minor --no-git-tag-version` → 改 CHANGELOG/README → commit →
  annotated tag → `git push --follow-tags` 即可回到「CI 发布 + provenance + 自动镜像同步」的原流程。
