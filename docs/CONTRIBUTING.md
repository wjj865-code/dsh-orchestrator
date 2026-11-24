# 贡献与发布（维护者）

面向**改这个仓库的人**。用户文档看 [README](../README.md)；内部设计看 [ARCHITECTURE.md](ARCHITECTURE.md)；
平台/沙箱边界看 [LIMITATIONS.md](LIMITATIONS.md)。

## 环境

- Node `>= 22.15`（`package.json` 的 `engines`），包管理器是 **pnpm**（`packageManager` 固定版本，锁文件 `pnpm-lock.yaml` 入库）。
- 唯一 devDependency 是 `vite`（构建 `client/src/**` → `dist/client.js`）。
- 仓库约定：`*.js` 一律 LF（`.gitattributes`）；`dist/` **入库**，由 `pnpm run build` 重建，不手改。

## 仓库结构

```text
index.js             插件入口：apply()、协调者系统提示（COORDINATOR_POLICY / worktree 策略）、
                     COORDINATOR_DENY、工具注册、派发/通知/队列/看门狗/结算的接线
src/                 宿主侧逻辑（每个模块一个职责，见 docs/ARCHITECTURE.md）
  ledger.js          台账（SQLite）：任务/消息/通知/记忆/设置
  state.js           状态机（STATUSES / 迁移 / 文案）
  status-facts.js    状态能力表（唯一真源，别在别处再写一份 Set）
  copy.js            文案单一真源（计划/交付/完整访问的原子句）
  tools.js           12 个工具的 schema + 文案 + 门控
  dispatch.js        派发（subagent）、沙箱/plan/guard 注入
  acceptance.js      可执行验收（checks）runner
  handoff.js         交接契约 v1（字段 + JSONL 事件）
  team-board.js      官方 Team 板只读快照 + 确认反写（CAS）
  delivered.js       两段式终态：确认交付 + 超时 sweeper
  settlement.js      结算闭环（子会话结束 → 终态/交付）
  notify.js          通知分级、合并、产物交付口径（present）
  memory.js          记忆分层（task-log / 事实层）
  plan-mode.js       计划模式状态与文案
  worktree.js        git worktree 隔离（宿主侧 git）
  host-route.js      /api/orchestrator（面板只读 + 动作）
client/src/**        面板/入口/抽屉/工作台（vite 构建成 dist/client.js，≤160 KiB）
scripts/             文档预算、客户端体积、版本口径、镜像同步
tools/debug-preset/ orch-debug 预设生成器（维护者工具，不随 npm 包发货）
cordis.patch.yml     随包预设：协调者 + worker
test/                node:test，按模块分文件（*.test.js）
docs/                ARCHITECTURE / LIMITATIONS / testing / compat / api-notes / probes
```

## 本地开发

```bash
pnpm install             # 装依赖（按 pnpm-lock.yaml；CI 用 pnpm install --frozen-lockfile）
pnpm test                # pretest = build + check:client-size + check:docs，再跑 node --test
pnpm run build           # client/src/** --vite--> dist/client.js（+ .map，默认 esbuild minify）
pnpm run check:client    # node --check dist/client.js
pnpm run check:client-size  # dist/client.js ≤ 160 KiB 闸门
pnpm run check:docs      # 文档行数预算（1,800）+ docs/CONFIG.md 配置表与 docs/TOOLS.md 工具表同源 + README 入口 + 内链
pnpm run check:version   # package.json / README / CHANGELOG 版本口径
node tools/debug-preset/cli.mjs            # 把随包「创造模式」组合复制成可安装的 orch-debug 预设
node tools/debug-preset/cli.mjs --check    # 升级 DSH 后查预设漂移
node --test tools/debug-preset/test/debug-preset.test.js   # 外移工具的测试（不在 pnpm test 里）
node scripts/verify-access-full.mjs          # 离线核对 access:'full' 整条链
node docs/probes/api-probe.mjs               # 契约探针（升级 DSH 后按 docs/probes/ 逐条重跑）
```

- **没有 pnpm？** `corepack enable pnpm`（按 `packageManager` 取版本）或 `npm i -g pnpm@11`；CI 的 `pnpm/action-setup@v4` 也读同一字段，
  本地 / CI / 文档只有这一个版本真源。
- **worktree 或新克隆里第一步先 `pnpm install`**：`node_modules/` 不入库，不装就直接 `pnpm test` 会 `vite: not found`，
  或读到别处留下的旧产物；pnpm 全局 store 跨目录共享，暖过的 store 下第二个 worktree 装依赖通常 1–2 秒。
- 改面板/详情 = 改 `client/src/**` 再 `pnpm run build`；`dist/` 的改动要一起提交。
- **沙箱里跑不了完整构建**：`vite build` 要写 `dist/` 并 spawn 子进程，在 DSH 子会话的默认沙箱里可能被拒。
  用 `access:'full'` 的子任务跑构建，或交给 CI / 本地终端。
- 装依赖报 `ERR_PNPM_IGNORED_BUILDS` 时：有包想跑构建脚本而没被审过。在 `pnpm-workspace.yaml` 的
  `allowBuilds` 里显式写 `true`（`esbuild` 已经写好）或 `false` 再重装；不要用 `dangerouslyAllowAllBuilds` 一把放开。
- **本地开发 = 装到 Desktop（主开发/安装面）**：官方入口
  `dsh plugin --profile desktop add "link:C:/Users/72489/Documents/dsh-orchestrator"`；或手改 profile 的 `package.json` 加
  `"@wjj865-code/dsh-orchestrator": "link:<仓库路径>"` 并加入 `dsh.profile.bundles`，重启 profile。
  改完 `pnpm run build` 要**彻底退出 DSH 再启动**（刷新页面不会换服务端代码）。
- **验收不在 desktop 里做**：自动化冒烟/回归另起 Web 测试 profile（隔离 `DSH_HOME` + 临时 profile + 无头浏览器/HTTP 断言），
  搭法与典型步骤见 [testing.md §7.0](testing.md#70-起一个-web-测试-profile自动化冒烟回归的固定入口)。
  **别拿桌面 GUI 做外部自动化**：桌面窗口的 `?token=` 由宿主注入、调用方没有受支持的取法，且会写真实台账、用真实凭据。

## 测试与门禁

测试怎么写、门禁判据、已知 flaky 与真机矩阵都在 [testing.md](testing.md)（唯一入口）；这里只提醒两条容易踩的：

- 新增/修改行为先补一条会红的用例；涉及台账的用例走临时 `DSH_HOME`（`test/helpers.js`）。
- 全量门槛：`pnpm test` 全绿 + `pnpm run check:client` + `check:client-size` + `check:version` + `check:docs`（`prepublishOnly` 同口径）。
- **主次**：能自动化的一律 Web 测试 profile（[testing.md §7.0](testing.md#70-起一个-web-测试-profile自动化冒烟回归的固定入口)），
  Desktop 只做用户真实入口的手工冒烟（§7.1–§7.2）；测试结论优先引用 web profile 的自动化证据。
- **确需人工**：只限 GUI 交互细节、桌面特有行为、真实安装态这类自动化覆盖不了的项——先说明影响哪个 profile 与回滚方式，
  再按 [testing.md §7.4](testing.md#74-人工验收确实自动化不了的项) 请用户回报「步骤 + 截图 + 日志 + 结论」。

## 发版

版本号**唯一真源是 `package.json`**，并遵循 SemVer；`CHANGELOG.md` 每个版本写清「为什么改 / 改了什么 / 边界」。

- **别在本机 `npm publish`**：本机 `~/.npmrc` 的 npm token 已失效（`npm whoami` 返回 `E401 Unauthorized`），
  本地发布必失败；直接 push `v*` tag 交给 `release.yml`（secret `NPM_TOKEN` + provenance），发版后按第 5、6 步用 `npm view` 与 npmmirror 两边都核实。

1. 更新 `CHANGELOG.md`（新版本一节）与 `package.json` 的 `version`。
2. 发版前清仓库：任务产物（`reports/`、`workspace/`、`.agents/`）不进提交；只提交代码/测试/文档/版本文件。
   `dist/client.js` 由 `pnpm run build` 重建后一起提交。
3. 本地全绿后打 tag：

   ```powershell
   pnpm version patch --no-git-tag-version
   git add package.json CHANGELOG.md
   git commit -m "release: vX.Y.Z"
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin main --follow-tags
   ```

4. `.github/workflows/ci.yml`（push main / PR）跑测试；`.github/workflows/release.yml`（推 `v*` tag）：
   两个工作流都用 `pnpm/action-setup@v4`（版本取自 `packageManager`）+ `actions/setup-node` 的 pnpm 缓存 +
   `pnpm install --frozen-lockfile`。发布工作流还会校验 tag 与 `package.json` 一致 → 该版本未发布过 →
   `pnpm test` + `pnpm run check:client` → `npm publish --provenance --access public --ignore-scripts`
   （发布这一步仍走 npm CLI，provenance/`--ignore-scripts` 语义最稳）→ 触发 npmmirror 镜像同步。
   仓库 Secrets 需要 `NPM_TOKEN`（npm Granular Token，Read and write，Bypass 2FA）；长期可换 Trusted Publishing（OIDC）。
5. **补镜像同步**：`registry.npmmirror.com` 是独立的库，新版本常延迟出现，国内用户装不到新版。
   `release.yml` 会自动 `PUT /-/package/<name>/syncs` 并轮询；失败或手动发版时：

   ```powershell
   pnpm run mirror:check  # 只看镜像有没有 package.json 的版本（打版本端点，判定「已同步」不吃 CDN 缓存）
   pnpm run mirror:sync   # 触发同步并轮询（--no-wait 只触发，--timeout 600 多等会儿）
   ```

   本地 `npm view` 有缓存，怀疑时加 `--prefer-online`；`mirror:check` 每次发真请求（`/:name/:version` 版本端点 + `?t=` 时间戳与 `no-cache` 头，绕过 packument 的 CDN 缓存）。
6. 发布后核对：`npm view @wjj865-code/dsh-orchestrator dist-tags` 的 `latest` 是新版本、`dist.attestations` 有 provenance、`gitHead` 与发版提交一致。

## 改动边界（容易踩的）

- 只读/计划/完整访问都靠平台的 `sandbox/mode` 注入；改沙箱逻辑前先读 [LIMITATIONS.md](LIMITATIONS.md) 的「平台 / 沙箱」。
- 协调者工具面由 `cordis.patch.yml` 的 `preset-tools` 名单收窄（0.26.0 起两个预设都是遮挡式 `deny` + `keep`），执行层还有 `COORDINATOR_DENY` + guard 兜底；两处要一起改。新增只读/技能类工具时记得它是**预设自有行**（own 工具），不写进 `deny`/`keep`。
- 新增文案先确认受众（协调者 / 子会话 / 用户），`task_report` 的返回是给**子会话**看的，别写只有协调者能做的动作。
- 会话头「任务」入口依赖宿主身份信号，默认隐藏；不要把它当安全边界。
- 平台契约会变（rc 包），升级 DSH 后按 `docs/probes/` 重跑探针再动代码。
