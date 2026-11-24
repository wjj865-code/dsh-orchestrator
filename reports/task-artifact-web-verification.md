# 任务产物修复与 DSH Web 验证（2026-11-24）

## 当前结论

用户确认调整后：私有真源和主会话暂存/引用已分离，默认、额外、临时与目标写根覆盖私有库则拒绝普通任务派发、续派及再授予。原三个问题已收敛；仍保留 worker 摘要不可用、完整访问/外部进程不保证防覆盖的边界。用户明确保留本报告并授权直接更新 main、打 v0.34.0 tag 发布，不创建 PR；授权不等于发布已完成。

## 私有真源边界最终验证

- 台账增量字段 `artifact_store_dir` 固定宿主私有真源；`artifact_dir` 保留主会话 staging/引用，`storage.json` 不参与保存路径解析。历史产物不移动、不追溯宣称受保护。
- 当前新增文档、快照、清单均登记私有库绝对路径；修改展示引用不影响文档旧版本或后续保存位置。
- 覆盖检查保护整个 artifact-store（不是只保护本任务目录），包含符号链接真实路径，无法核验时 fail closed。`access:full` 阶段明确 unprotected。
- 最终 web profile 的 DSH_HOME 在本任务 worktree `.artifact-web-home`（非 temp 写根），不用真实 ~/.dsh。测试结束停止服务，profile 移到临时证据归档，避免混入代码。
- 真机文件 sentinel：`FS_SANDBOX_DENIED`、protected=true；shell sentinel：exitCode=1、Operation not permitted、sandbox.denied=true、enforcement=full，内容仍为 original。
- 证据 `/private/tmp/dsh-artifact-private-confirm/events.jsonl`、`browser.json`、`snapshot.json`、`04-tasks.png`、`05-detail.png`。文档预览/详情 HTTP 200，面板展示私有版本/清单。
- 0.34.0 发版复跑完整测试 1453 项：1450 通过、0 失败、3 个 Windows 专属跳过；日志 `/tmp/artifact-v0.34.0-tests.log`。文档 1800/1800 行、客户端 163836/163840 字节，构建与版本检查通过；原复审 `/tmp/dsh-artifact-private-review/`，发版复核 `/tmp/dsh-artifact-release-review/`。联网重跑 preflight 成功：该仓库未配置自定义工作流，之前的 DNS 缺口已消除。

## 私有边界调整前的修复与回归（历史验证）

- 收集绑定本次结束事件序号；历史摘要不可代替本轮摘要，缺失序号记录在 `missingSummarySeqs`。
- `done`/checkpoint 的显式交付省略数持久记录到请求及清单 `documentsOmitted`，省略时不报告完整。
- 删除工具层遗留 chainAuto 交付分支、阶段复制冗余时间戳分支。
- 普通任务的额外根缩为 `staging/`，**这不是完整权限修复**，见下文。
- 当前完整测试：1449 项，1446 通过，0 失败，3 个 Windows 专属跳过。通知时序夹具改为等待可观察结果，不再假定固定 30/50ms。
- 文档检查 1800/1800、客户端体积 163831/163840 字节、版本检查及 diff whitespace 检查通过。客户端本轮没有源码变更，沿用上一轮已构建产物。

## 私有边界调整前的真机环境与证据（历史验证）

- 官方 npm `@deepseek-ai/dsh@0.2.2-rc.5`，临时安装 `/private/tmp/dsh-artifact-web-runtime`；实际启动 Node 24.22.3。
- 隔离 `DSH_HOME=/private/tmp/dsh-artifact-web-home`，`verify` profile；禁用真实 DeepSeek 模型适配器，本地确定性 `artifact-probe`，不使用账号凭据。
- 官方 plugin add 对 `link:<path>` 报 invalid package name，随后在临时 profile 声明 link 依赖并注册 bundle；未更改真实桌面 profile。
- 独立无头 Chrome，独立 user-data-dir；CDP 复用仓库既有 harness。
- 脚本：`docs/probes/artifact-web-probe.mjs`、`docs/probes/artifact-web-browser.mjs`。
- 完整证据：`/private/tmp/dsh-artifact-web-evidence/events.jsonl`、`browser.json`、`snapshot.json`、`04-tasks.png`、`05-detail.png`。
- 初始化时宿主 UI 曾选择系统默认 Documents 工作区（非测试目标），没有对该目录运行任务或文件写入；发现后配置临时 `documentsDirectory`，所有任务使用临时目录。未擅自删除系统默认目录。

## 真机通过项

- 协调者打开、任务创建、宿主真实执行 `artifact_save`，同名文档两版本均保留。
- 普通非 Git 任务 `write(file_path)` 和 `bash(command,description)` 写入成功。
- `changedFiles` 的 out.txt / shell.txt 保存独立副本，清单明确为不完整（宿主摘要不可用）。
- 只读任务保存两版文档成功；文件工具返回 `FS_SANDBOX_DENIED`，shell 返回 Operation not permitted；只读目标目录没有生成文件。
- done 回执为待交付请求，回合结束后清单保存并进入 delivered；通知明确收集不完整。
- snapshot/detail/document-preview HTTP 200，任务面板及抽屉显示文档版本、清单、固定产物目录和不完整状态。

## 调整前已复现的宿主契约（历史取证）

1. **默认可写根包含产物目录**：`dsh-sandbox-policy` 的 resolve 使用不可变 `session.header.cwd`；子会话该目录继承协调者工作区，workingDirectory.set 改的是执行目录。只把额外根缩为 staging 不排除原默认根。探针 `artifact.protection` 实测 `protected:false`，宿主文件能力可以覆盖位于 artifacts 的 sentinel。
2. **临时目录也默认可写**：官方 `dsh-sandbox/src/roots.ts#writableRoots` 额外允许 `/tmp` 和系统 tmpdir。因此仅把宿主存储移到另一个临时目录也不能构成保护。
3. **没有拒写子树 API**：`SandboxExecutionPolicy` 只有 mode/workspaceRoot/additionalWritableRoots；不能在默认允许的父目录下排除 docs/snapshots，chmod 也不是同 UID 的可靠安全边界。
4. **worker 没有 workspaceChanges 摘要**：官方 `dsh-workspace-changes/src/index.ts#eligible` 对 origin=subagent 或 delegationDepth>0 返回 undefined。真机 worker 没产生摘要；非 Git 无法自动收集 shell/文件改动，必须显式 changedFiles，当前保守标不完整。

## 已确认采用的边界

采用宿主私有存储作为版本/快照真源（必须位于任务默认根、额外写根及默认 temp 根之外），主会话 artifacts 仅作暂存/引用；普通任务写根覆盖私有库则拒绝，完整访问明确不受保护。不把展示引用或历史文件冒充防覆盖备份。

本次不增加宿主沙箱自建适配器、不隐藏默认写根、不声称完整自动备份；不自动迁移旧产物，不提交或推送。
