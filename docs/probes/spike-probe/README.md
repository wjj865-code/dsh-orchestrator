# spike-probe（smoke profile 专用，验证完即删）

直连 subagent 的探针插件，配合 `docs/probes/subagent-probe.md` 使用。**不属于 `dsh-orchestrator` 产品代码**，不要装进 desktop profile，不要发版。

## 装法

smoke profile 的 `cordis.patch.yml` 里已有：

```yaml
- insert:
    - id: spike-probe
      name: spike-probe
```

把本目录 junction 到 profile 的 `node_modules/spike-probe` 即可（PowerShell，管理员或开发者模式）：

```powershell
$profile = "$env:USERPROFILE\.dsh\profiles\smoke"
New-Item -ItemType Junction -Path "$profile\node_modules\spike-probe" -Target "C:\Users\72489\Documents\dsh-orchestrator\docs\probes\spike-probe"
```

> 注意：之前的 junction 指向 `%TEMP%\orch-smoke\spike-probe`，换成本目录前先删旧链接。

## 跑法

在 smoke profile 的协调者会话里让模型依次调用（工具都是全局注册，子会话也能调带「子级专用」的）：

| 调用 | 回答什么 |
| --- | --- |
| `probe_whoami` | 当前会话身份、`origin`/`parentSession`、可见工具里有没有 `task_report` |
| `probe_report_e2e` | **问题 1**：种一条 `session_id = childId` 的任务 → 起子会话 → 子级真调 `task_report` → 回读台账（状态、messages、子级输出原文） |
| `probe_spawn` + `probe_followup` + `probe_poll` | **问题 2**：同一 `childId` 追加消息并被消费（子级用 `probe_note` 留证据） |
| `probe_capacity` | **问题 3**：先占 N 个驻留子会话 → 第 N+1 个是否 `ACTIVATION_LIMIT_REACHED` → `dispose` 一个后能否再起 |
| `probe_catalog` | **问题 4**：父会话能否 `listChildren` 发现子会话（客户端跳转走这个目录） |
| `probe_notes` / `probe_poll` | 读子级留下的 `probe_note` 证据 |

问题 5（父会话关闭释放后代）不主动测，按平台文档记风险。

## 说明

- `probe_report_e2e` 会**直接往 smoke profile 的台账里种一条 `t-spike-*` 任务**（`$DSH_HOME/state/orchestrator/tasks.sqlite`），只为了满足 `task_report` 的「回报方 = 任务 session_id」校验；smoke 台账是临时的，验证完整个 profile 删掉即可。
- 探针用 `delivery: 'caller'`，给 `activation.result` 挂了 `.catch`；任何路径都显式 `dispose()`。
- `probe_hold`/`probe_release` 是容量测试用的阻塞开关，子级调 `probe_hold` 后父级用 `probe_release` 放行。
