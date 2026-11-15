# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)；版本号以 `package.json` 为唯一真源，
推 `vX.Y.Z` tag 触发 `.github/workflows/release.yml` 发布到 npm。

## 未发布

### 新增

- **启动对账（S2）**：插件启动与协调者晚加载时扫描台账，`running` 但子会话已不活跃（`agents.get` 查不到）的任务标 `orphaned`，
  补上进程重启/崩溃后的「沉默中断」兜底；`waiting_dep` 不参与、`waiting_*` 不因不 live 被误标；重复启动幂等。
- **孤儿汇总上报**：对账结果合并成一条通知（任务名 + id，超 10 条折叠），协调者未加载时保留待发、`agent/created` 后补发一次。

## 0.7.0（2026-11-15）

面板操作台收尾：错误码与幂等、详情抽屉、产物自动收集。相对 0.6.1 无破坏性变更，属向后兼容的功能新增（minor）。

### 新增

- **面板动作错误码与幂等**：统一 `action-errors` 错误码表，工具层与面板复用同一口径；`stop` 对重复调用/已终态返回 `already`；
  `retry` 仅允许 `failed` / `orphaned`，同源活跃重派视为幂等；`message` 支持 `clientRequestId` 进程内去重，
  并带同文短窗口兜底；面板直接展示错误码与 `already` 提示。
- **详情抽屉四区块**：面板详情抽屉按「基本信息 / 执行 / 依赖 / 产物」四区块展示，并显示 followup 投递状态。
- **done 自动收集产物**：子任务 `task_report done` 时从 `workspaceChanges` 自动收集改动文件，与显式 `artifacts`
  按路径去重合并；产物库支持按项目/日期分组、预览与复制，并可从任务卡片直达。

### 文档与内部

- 轮询注释对齐实现（2s `POLL_MS`、30s 退避 `POLL_BACKOFF_MS`），清理遗留审计与探针文件。
- README 发版流程改为 annotated tag + `git push --follow-tags`；安装示例与排障版本号同步到 0.7.0。

## 更早版本

按 `git tag` 主题重建的简要索引，细节见对应 tag 的提交与 `docs/`：

| 版本 | 主题 |
|---|---|
| 0.6.1 | 重构 README，拆分 ARCHITECTURE / LIMITATIONS 文档 |
| 0.6.0 | P3 产物库与面板操作台 |
| 0.5.1 | P0 收尾：插件展示元数据与 npm 占位版本清理 |
| 0.5.0 | P2 收件箱 / 问题选项 / `stallRounds` / 日报 |
| 0.4.0 | P1 依赖编排：`dependsOn` / `group` / `writeScopes` / `priority` |
| 0.3.x | 发布流水线（provenance + 重复发布保护）、client id 回归、MIT LICENSE |
| 0.2.x | 插件入口直达主会话、显示名文案、只读子任务（`readOnly`） |
| 0.0.0-stage | npm 占位版本（已 deprecate） |
