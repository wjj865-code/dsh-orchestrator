# settle-probe（真机探针，验证完即删）

直连子会话的 settle 探针插件，配合 `docs/probes/stop-reason-probe.md` 使用。
**不属于 `dsh-orchestrator` 产品代码**，不要装 desktop profile，不要发版。

## 装法

在 `$DSH_HOME/profiles/settle-probe`（从 headless 模板复制）里：

```powershell
dsh settle-probe --from-default-profile headless --dump-config | Out-Null
$profile = "$env:USERPROFILE\.dsh\profiles\settle-probe"
New-Item -ItemType Directory -Force -Path "$profile\node_modules" | Out-Null
New-Item -ItemType Junction -Path "$profile\node_modules\settle-probe" `
  -Target "C:\Users\72489\Documents\dsh-orchestrator\docs\probes\settle-probe"
```

`$profile\cordis.patch.yml`：

```yaml
- insert:
    - id: settle-probe
      name: settle-probe
```

## 跑法

```powershell
$env:DEEPSEEK_API_KEY = '<key>'
dsh settle-probe --json "回复 ok 即可，不要调用工具。"
```

探针在根 agent 创建 1.5s 后自己依次跑 7 个场景（正常完成 / 立刻 dispose / 跑到一半 dispose / 发布后 abort signal / max-tokens / 模型不可用 / settle 后续派），
结果落 `docs/probes/out/settle-probe.json`，同时在 stdout 打一行 `SETTLE_PROBE_RESULT …` 摘要。

## 说明

- 所有子会话都用 `delivery: 'caller'`，`activation.result` 挂了 catch，任何路径都显式 `dispose()`。
- 探针只观察、不改插件状态；子会话 prompt 都是「只回复 OK」这类最小回合，成本只有几次小请求。
- headless 进程在场景跑完后不会立即退出，结果在场景结束时就已写盘，手动结束进程即可。
