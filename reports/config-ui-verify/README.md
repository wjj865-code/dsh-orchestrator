# 配置卡片真机验证证据（2026-11-19）

无头 Chrome（playwright-core + 系统 Chrome）在**隔离测试 profile** 上跑出的真机证据。
测试实例：`dsh --profile verify-config-ui --port 52847`（`DSH_HOME=/tmp/dshverify`，不碰 desktop profile）。

| 文件 | 内容 |
|---|---|
| `04c-card-scoped.png` | 配置卡片本体（全部 8 个分组展开，35 个字段） |
| `04b-all-expanded.png` | 同上，含 bundle 页上下文 |
| `05-rotation-group.png` | 「主会话轮换」只读分组（8 个只读标记） |
| `06-after-save.png` | 改 keepAlive 并保存后的状态 |
| `07-after-reload.png` | 手改 YAML 后刷新，显示「已覆盖」 |
| `08-cleared-fallback.png` | 清空字段后回落默认值 |
| `results.json` | 逐项断言结果（9/9 PASS） |
| `page-text.txt` | 页面文本快照（兜底证据） |

## 验证结论

| # | 断言 | 结果 |
|---|---|---|
| 1 | 打开首页 | PASS |
| 2 | 侧栏「插件」可进入 | PASS |
| 3 | 找到 dsh-orchestrator 详情 | PASS |
| 4 | 配置卡片出现（`data-orchestrator-config`） | PASS |
| 5 | 字段数 = **35**（8 分组全展开） | PASS |
| 6 | 6 个废弃键**不出现**在卡片 | PASS |
| 7 | `mainRotation` 默认 **off** | PASS |
| 8 | 改 keepAlive → 保存 → profile `cordis.patch.yml` 出现 `id: orchestrator` + `keepAlive: true` | PASS |
| 9 | 手改 YAML → 刷新 → 显示「已覆盖」 | PASS |
| 10 | 清空字段 → YAML 键移除 → 回落默认 60 → 「已覆盖」清除 | PASS |

字段标签完整清单见 `page-text.txt`；卡片内实测 35 个 `.orch-cfg-row`、35 个 `.orch-cfg-name`。

## 复跑方式

```bash
DSH_HOME=/tmp/dshverify \
  "/Users/bytedance/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  --profile verify-config-ui --no-open --port 52847 --host 127.0.0.1
# 启动日志会打印带 token 的 URL；然后
VERIFY_TOKEN=<token> node /tmp/pwtest/verify2.js
```
