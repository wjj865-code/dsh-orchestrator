# 贡献与发布（维护者）

面向**改这个仓库的人**。用户文档看 [README](../README.md)；内部设计看 [ARCHITECTURE.md](ARCHITECTURE.md)；
平台/沙箱边界看 [LIMITATIONS.md](LIMITATIONS.md)。

## 环境

- Node `>= 22.15`（`package.json` 的 `engines`），npm（仓库不依赖 pnpm）。
- 唯一 devDependency 是 `vite`（构建 `client/src/**` → `dist/client.js`）。
- 仓库约定：`*.js` 一律 LF（`.gitattributes`）；`dist/` **入库**，由 `npm run build` 重建，不手改。

## 仓库结构

```text
index.js             插件入口：apply()、协调者系统提示（COORDINATOR_POLICY / worktree 策略）、
                     COORDINATOR_DENY、工具注册、派发/通知/队列/看门狗/结算的接线
src/                 宿主侧逻辑（每个模块一个职责，见 docs/ARCHITECTURE.md）
  ledger.js          台账（SQLite）：任务/消息/通知/记忆/设置
  state.js           状态机（STATUSES / 迁移 / 文案）
  tools.js           14 个工具的 schema + 文案 + 门控
  dispatch.js        派发后端（subagent/team）、沙箱/plan/guard 注入
  delivered.js       两段式终态：确认交付 + 超时 sweeper
  settlement.js      结算闭环（子会话结束 → 终态/交付）
  notify.js          通知分级、合并、产物交付口径（present）
  memory.js          记忆分层（task-log / 事实层）
  plan-mode.js       计划模式状态与文案
  worktree.js        git worktree 隔离（宿主侧 git）
  host-route.js      /api/orchestrator（面板只读 + 动作）
client/src/**        面板/入口/抽屉（vite 构建成 dist/client.js）
scripts/             preset 生成/漂移检查、镜像同步、access:'full' 离线验证
cordis.patch.yml     随包预设：协调者 + worker
test/                node:test，按模块分文件（*.test.js）
docs/                ARCHITECTURE / LIMITATIONS / UI / DETAIL / DEBUG-PRESET / probes
```

## 本地开发

```bash
npm install
npm test                 # pretest 会先 npm run build，再跑 node --test
npm run build            # client/src/** --vite--> dist/client.js（+ .map）
npm run check:client     # node --check dist/client.js
npm run preset:debug     # 把随包「创造模式」组合复制成可安装的 orch-debug 预设
node scripts/orch-debug-preset.mjs --check   # 升级 DSH 后查预设漂移
node scripts/verify-access-full.mjs          # 离线核对 access:'full' 整条链（台账→brief→派发→沙箱事件→通知）
node docs/probes/api-probe.mjs               # 契约探针（升级 DSH 后按 docs/probes/ 逐条重跑）
```

- 改面板/详情 = 改 `client/src/**` 再 `npm run build`；`dist/` 的改动要一起提交。
- **沙箱里跑不了完整构建**：`vite build` 要写 `dist/` 并 spawn 子进程，在 DSH 子会话的默认沙箱里可能被拒。
  用 `access:'full'` 的子任务跑构建，或交给 CI / 本地终端。
- 本地 link 安装（开发用）：profile 的 `package.json` 加
  `"@wjj865-code/dsh-orchestrator": "link:C:/Users/72489/Documents/dsh-orchestrator"`，
  并把包名加入 `dsh.profile.bundles`，重启 profile。

## 测试策略

- `node:test` + `assert/strict`，一个模块一个 `test/*.test.js`；`--experimental-test-isolation=none`（共享进程，省启动时间）。
- 新增/修改行为：先补一条会红的用例，再改实现；涉及台账的用例用临时 `DSH_HOME`（见 `test/helpers.js`）。
- 文案口径由 `test/copy-consistency.test.js` 统一锁：`done` 不是终态、协调者默认不主动 `task_close`、
  present 1-4 个、brief 不越权定义交付语义。改这些文案先跑它。
- 全量门槛：`npm test` 全绿 + `npm run check:client` 通过（`prepublishOnly` 也是这两个）。

## 发版

版本号**唯一真源是 `package.json`**，并遵循 SemVer；`CHANGELOG.md` 每个版本写清「为什么改 / 改了什么 / 边界」。

1. 更新 `CHANGELOG.md`（新版本一节）与 `package.json` 的 `version`。
2. 发版前清仓库：任务产物（`reports/`、`workspace/`、`.agents/`）不进提交；只提交代码/测试/文档/版本文件。
   `dist/client.js` 由 `npm run build` 重建后一起提交。
3. 本地全绿后打 tag：

   ```powershell
   npm version patch --no-git-tag-version
   git add package.json CHANGELOG.md
   git commit -m "release: vX.Y.Z"
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin main --follow-tags
   ```

4. `.github/workflows/ci.yml`（push main / PR）跑测试；`.github/workflows/release.yml`（推 `v*` tag）：
   校验 tag 与 `package.json` 一致 → 该版本未发布过 → `npm test` + `npm run check:client` →
   `npm publish --provenance --access public --ignore-scripts` → 触发 npmmirror 镜像同步。
   仓库 Secrets 需要 `NPM_TOKEN`（npm Granular Token，Read and write，Bypass 2FA）；长期可换 Trusted Publishing（OIDC）。
5. **补镜像同步**：`registry.npmmirror.com` 是独立的库，新版本常延迟出现，国内用户装不到新版。
   `release.yml` 会自动 `PUT /-/package/<name>/syncs` 并轮询；失败或手动发版时：

   ```powershell
   npm run mirror:check   # 只看镜像 latest 是不是 package.json 的版本
   npm run mirror:sync    # 触发同步并轮询（--no-wait 只触发，--timeout 600 多等会儿）
   ```

   本地 `npm view` 有缓存，怀疑时加 `--prefer-online`；`mirror:check` 每次发真请求。
6. 发布后核对：`npm view @wjj865-code/dsh-orchestrator dist-tags` 的 `latest` 是新版本，
   `dist.attestations` 有 provenance，`gitHead` 与发版提交一致。

## 改动边界（容易踩的）

- 只读/计划/完整访问都靠平台的 `sandbox/mode` 注入；改沙箱逻辑前先读 [LIMITATIONS.md](LIMITATIONS.md) 的「平台 / 沙箱」。
- 协调者工具面由 `cordis.patch.yml` 的 `preset-tools` allow 名单收窄，执行层还有 `COORDINATOR_DENY` + guard 兜底；两处要一起改。
- 新增文案先确认受众（协调者 / 子会话 / 用户），`task_report` 的返回是给**子会话**看的，别写只有协调者能做的动作。
- 会话头「任务」入口依赖宿主身份信号，默认隐藏；不要把它当安全边界。
- 平台契约会变（rc 包），升级 DSH 后按 `docs/probes/` 重跑探针再动代码。
