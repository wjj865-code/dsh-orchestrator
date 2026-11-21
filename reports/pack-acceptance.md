# 能力包真机验收（0.32.0）

- 时间：2026-11-21T13:13:48.716Z｜宿主：DSH 0.2.2-rc.5 Desktop CLI（隔离 DSH_HOME + 临时 profile `accept`）｜探针：`docs/probes/capability-pack-acceptance.mjs`
- 结果：**24/24 PASS**｜host exit=0｜含文颜懒装 + render｜临时目录已清理

## 实测证据

- 文颜懒装：102 秒（pnpm store 已有缓存，属热装；P0 实测冷装 ≈4 分 04 秒），版本 2.0.12。
- render：695 B，含 `<section>`=true；入口 realpath + `--version` 通过。
- 删除包：deferred=true（包会话仍开着时 Windows watcher 占目录，产品语义是「撤预设/registry + 目录下次启动清理」）。

## 判定明细

| 判定 | 检查 | 说明 |
|---|---|---|
| INFO | probe:host-facts |  |
| PASS | probe:create-dry-run |  |
| PASS | probe:create-confirm |  |
| PASS | probe:preset-visible |  |
| PASS | probe:health-files |  |
| PASS | probe:health-env-present |  |
| PASS | probe:health-env-soft |  |
| PASS | probe:env-missing-degrade |  |
| PASS | probe:env-copy-placeholder |  |
| PASS | probe:open-session |  |
| PASS | probe:agent-live |  |
| PASS | probe:skills-visible |  |
| PASS | probe:session-preset |  |
| PASS | probe:install-confirm-required |  |
| PASS | probe:cli-installed |  |
| PASS | probe:cli-invocation |  |
| PASS | probe:render-html |  |
| PASS | probe:cli-version |  |
| PASS | probe:delete-pack |  |
| PASS | probe:delete-dir-handled |  |
| PASS | probe:no-secret-leak |  |
| PASS | logs-no-failure-events |  |
| PASS | host-log-no-errors |  |
| PASS | no-credential-leak(state/cwd/profile) |  |
| PASS | isolated-home |  |

## 覆盖的验收项

- 建用户包（dry-run → confirm）→ 预设运行时可见 → 开包会话 → 两个技能出现在该会话快照 → 会话预设正确。
- 健康检查：技能文件硬检查通过；env 已设置（哨兵变量）时 env 检查通过；空 env 下全为「未设置」且 soft（不判包失败）→ 无凭据降级。
- 文颜：确认卡（confirm 缺失拒绝）→ 懒装到 `capability-packs/tools/<id>` → `realpathSync.native()` 入口 → `--version` → `render` 产出含 `<section>` 的 HTML；APPDATA/LOCALAPPDATA 重定向到包内 `.state/wenyan`。
- 删除包 → 预设从 `agentPresets.list()` 消失、registry 条目清空；目录在会话仍开着时延后清理（见 LIMITATIONS）。
- 零凭据泄漏：宿主进程带 `WECHAT_APP_SECRET` 哨兵值运行；状态目录 / 工作目录 / profile 目录全文扫描均未命中。
- 日志：orchestrator 日志无 `*.failed` / `*.rejected` / `fatal` 事件（本探针只装 probe 插件，该目录可能为空）；宿主日志无 error/exception/failed 行。

## 未验 / 说明

- 本探针把仓库源码按绝对路径导入临时 profile 的探针插件（与 npm 包 `files` 同一份源码），**不是**先 `npm pack` 再装包；包安装路径由 0.31.0 的 web 冒烟覆盖，P6 不重复。
- 真实公众号 `publish` 建草稿未验：需要测试公众号凭据 + 本机 IP 白名单，按硬约束不接真实账号（本版只做本地 stub/人工联调）。
- 运行时注册的预设在宿主 UI 预设选择器里的刷新时机未验（P0 遗留项）；本探针只证明 `agentPresets.list()`/`composedPreset` 同源一致。
- Web 分支：`capabilityPacksAllowOnWeb=false` 时工具返回 `PLATFORM_UNSUPPORTED` 由单测覆盖；本探针跑在 Desktop CLI 上。

## 复跑

```powershell
node docs/probes/capability-pack-acceptance.mjs            # 全量（含文颜懒装，约 2–6 分钟）
node docs/probes/capability-pack-acceptance.mjs --skip-cli  # 只验 host 部分
node docs/probes/capability-pack-acceptance.mjs --keep      # 保留临时目录与 HTML
```
