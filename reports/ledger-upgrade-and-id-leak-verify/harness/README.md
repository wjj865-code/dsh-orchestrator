# harness：真实台账升级 + 泄漏抽查的复跑步骤

两个脚本互不依赖；② 需要 operator 先起隔离实例。

## ① 真实台账副本升级（`verify-ledger-upgrade.mjs`）

```powershell
node --disable-warning=ExperimentalWarning reports/ledger-upgrade-and-id-leak-verify/harness/verify-ledger-upgrade.mjs
# 可选：DSH_ORCH_STATE_DIR=<含 tasks.sqlite 的目录>；--keep 保留临时副本（默认删）
```

- 只读：源库用 `DatabaseSync readOnly` + `VACUUM INTO` 出快照；不会 `ALTER`/`INSERT` 源库。
- 输出：`evidence/ledger-upgrade.json`；退出码 0 = 全部 PASS。
- 临时目录前缀：`orch-ledger-upgrade-*`、`orch-ledger-delete-*`（结束删除；`--keep` 保留以便排查）。

## ② 泄漏抽查（隔离 DSH_HOME + Web 测试 profile + mock 模型）

```powershell
$BASE = "$env:TEMP\orch-leak-verify"
$HOME_DIR = "$BASE\home"; $ART = "$BASE\artifacts"
New-Item -ItemType Directory -Force -Path $HOME_DIR,$ART,"$ART\screenshots","$BASE\targets\target-a","$BASE\targets\target-b","$BASE\targets\target-c","$BASE\targets\target-d" | Out-Null

# 1) 临时 profile（web 模板）+ link 本仓库（测合并后的代码）
$env:DSH_HOME = $HOME_DIR
dsh --profile lkweb --from-default-profile web --dump-config | Out-Null
dsh plugin --profile lkweb add "link:C:\Users\72489\Documents\dsh-orchestrator"

# 2) mock 模型（Messages 兼容 stub）
$env:MOCK_PORT='47331'; $env:MOCK_OUT="$ART\mock"
$env:MOCK_TARGET_A="$BASE\targets\target-a"; $env:MOCK_TARGET_B="$BASE\targets\target-b"
$env:MOCK_TARGET_C="$BASE\targets\target-c"; $env:MOCK_TARGET_D="$BASE\targets\target-d"
Start-Process node -ArgumentList 'reports\ledger-upgrade-and-id-leak-verify\harness\mock-llm.mjs' -WindowStyle Hidden

# 3) 起隔离 Web 实例（记下打印的带 token URL）
$env:DEEPSEEK_BASE_URL='http://127.0.0.1:47331'; $env:DEEPSEEK_API_KEY='sk-mock-0000000000000000'
$env:DSH_ORCH_NOTIFY_MERGE_MS='0'; $env:DSH_ORCH_PROGRESS_MS='1000'
dsh --profile lkweb --no-open --port 54477 --host 127.0.0.1

# 4) 驱动 4 条流（headless Chrome；首启会点掉「预览版说明」并打开主会话）
$env:DSH_URL='http://127.0.0.1:54477/?token=...'; $env:E2E_OUT=$ART; $env:E2E_HOME=$HOME_DIR
node --disable-warning=ExperimentalWarning reports\ledger-upgrade-and-id-leak-verify\harness\drive-leak.mjs

# 5) 统计（写 evidence/id-leakage.json 并打印摘要）
$env:E2E_OUT=$ART; $env:E2E_HOME=$HOME_DIR
node --disable-warning=ExperimentalWarning reports\ledger-upgrade-and-id-leak-verify\harness\analyze-leak.mjs

# 6) 收工：停 dsh web 与 mock、删 $BASE（driver 自己会关 Chrome）
```

要点：

- mock 会扮演「不老实」的模型：把上下文里真实编号（`t-` + 8 hex）原样抄进回复/`task_report.summary`；所以 0 泄漏 = 编号没漏进模型手里。
- 子会话 brief 只有指针（`【任务引用】tk-…`），worker 先 `task_detail` 再按 `SCN=` 执行；协调者从 `task_create` 回执/交付通知里取 `tk-` 做 `task_message`。
- Chrome 在 `%TEMP%` 下用独立 `--user-data-dir`；端口 9541（CDP）/47331（mock）/54477（web）都可改。
- 只碰临时 `DSH_HOME`；不写真实台账、不读真实凭据、不动 Desktop。
