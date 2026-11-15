# keepalive-probe（K1，一次性验证）

验证 `agent/turn-stopping` 能否作为「宿主 keep-alive」扩展点：插件在回合停止前投递一条消息，让子会话继续跑而不进入 idle/结算。

**不属于 `dsh-orchestrator` 产品代码**，不要装进 desktop profile。结论与源码证据见 [reports/k1-keepalive-probe.md](../../../reports/k1-keepalive-probe.md)。

## 跑法

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File docs/probes/keepalive-probe/run.ps1 -Mode followup
# steer | followup-async | none
```

脚本用 `ELECTRON_RUN_AS_NODE=1` 启动安装包里的 headless CLI，在 `docs/probes/keepalive-probe/.out/` 下建一个**一次性 `DSH_HOME`**（`profiles/kp`），不会碰 `~/.dsh` 的 desktop profile。每次事件写到 `.out/k1-events.<mode>.jsonl`；已提交的四组结果在 `out/`。

## 四种模式

| mode | 动作 | 预期 |
| --- | --- | --- |
| `followup` | `agent.followup()`（`next-turn`） | 当前 turn 结束 → 立刻起 turn 2；中间无 `agent/status=idle`；最后正常 `subagent/end` |
| `steer` | `agent.steer()`（`next-step`） | 同一个 turn 里多跑一步；中间无 `turn/end`；最后正常 `subagent/end` |
| `followup-async` | 先 `await 50ms` 再 `followup` | 和 `followup` 一样，证明 serial 事件会等异步监听器 |
| `none` | 不注入 | 对照组：第一次 turn-stopping 后立刻 idle → `subagent/end`（`child turn 1`） |

## 实现要点

- 探针自己注册一个 mock `LlmAdapter`（provider `probe`），不依赖真实模型/API key。
- 顶层 mock 第一次请求调用 `probe_run` 工具；工具用 `ctx.subagents.startActivation({provider:'spawn', delivery:'caller'})` 起一个真实子会话并等结算。
- 子会话第一次 `agent/turn-stopping` 时按 mode 注入一次；第二次不注入，让它自然结算。
- 所有注入都检查 `inbox` 并只注入一次；生产实现必须再加预算/终止条件（见报告）。

## 注意

- `DeepSeek Harness.exe` 是 GUI 子系统程序，PowerShell 里 `& $exe ...` 不会等它退出；脚本用 `Start-Process -Wait`。
- 安装包里的 dsh 入口在 `app.asar` 虚拟路径里，PowerShell `Test-Path` 看不到它，但 Electron-as-Node 能加载。
