# 发版记录：0.12.0（面板门控 + 删除子会话）

- 日期：2026-11-15
- 版本：`0.12.0`（minor，相对 0.11.0 无破坏性变更）
- 仓库：<https://github.com/wjj865-code/dsh-orchestrator>
- 发布 commit：`3893647`（`release: v0.12.0`，父提交 `f51adcf`）
- tag：`v0.12.0`（annotated，tag 对象 `f707b9d`）→ commit `3893647`
- 工作流：release run `43717273227`，**success**（<https://github.com/wjj865-code/dsh-orchestrator/actions/runs/43717273227>）

## 这次发的内容

- 面板「追加消息」按续派状态门控：新增 `src/panel-gates.js`（`followupGate`）作唯一判定，`snapshot` / `detail` 下发
  `canFollowup`，面板只读字段渲染；失败任务报 `MESSAGE_NOT_FOLLOWABLE`（提示改用重派）。
- 终态任务「删除」：面板任务卡 + 详情抽屉，二次确认，后端 `endpoint: 'delete'` → `panel.delete`；活跃任务
  `DELETE_TASK_ACTIVE`、有活跃下游 `DELETE_HAS_ACTIVE_DEPENDENTS`；成功级联清理台账 `tasks` / `messages` / `notifications`。
- 发版后 npmmirror 镜像同步固化进 `release.yml`（Publish 之后 `PUT /-/package/{name}/syncs` + 轮询约 3 分钟，
  `continue-on-error`），并带 `scripts/mirror-sync.mjs`（`npm run mirror:sync` / `mirror:check`）手动兜底。
- 测试：`npm test` 626 条全绿；`npm run check:client` 通过（发版前本地 + 工作流里各跑一次）。

## 发版动作

| 步骤 | 内容 | 结果 |
| --- | --- | --- |
| 1 | `package.json` version `0.11.0` → `0.12.0` | ✅ |
| 2 | `CHANGELOG.md`：「未发布」收成 `## 0.12.0（2026-11-15）` + 版本摘要段（面板优化 / 流程两节保留在下面） | ✅ |
| 3 | `README.md` 版本字面量同步 0.12.0（顶部最新版、安装命令、发版示例、排障首行） | ✅ |
| 4 | `git commit -m "release: v0.12.0"` → `3893647` | ✅ |
| 5 | `git tag -a v0.12.0 -m "v0.12.0: 面板续派门控 + 删除任务/子会话 + 镜像同步固化"` | ✅ |
| 6 | `git push origin main --follow-tags`（`7bfa096..3893647` + 新 tag `v0.12.0`） | ✅ |

## 工作流逐步骤结果（run 43717273227）

| 步骤 | 结论 |
| --- | --- |
| Checkout / Setup Node | success |
| Tag 必须等于 package.json version | success（tag `v0.12.0` = version `0.12.0`） |
| 该版本不能已经在 npm 上 | success（0.12.0 未发布过） |
| Test（`npm test` + `check:client`） | success |
| Publish（`npm publish --provenance --access public --ignore-scripts`） | success |
| **触发 npmmirror 镜像同步** | **success**（这一步真的生效了：镜像 latest 已是 0.12.0，不再是 0.11.0 时的手工补同步） |

## 发布后验证

npm（registry.npmjs.org）：

```text
$ npm view @wjj865-code/dsh-orchestrator dist-tags
{ latest: '0.12.0' }

$ npm view @wjj865-code/dsh-orchestrator@0.12.0 version dist.tarball
version = '0.12.0'
dist.tarball = 'https://registry.npmjs.org/@wjj865-code/dsh-orchestrator/-/dsh-orchestrator-0.12.0.tgz'

$ curl -I https://registry.npmjs.org/@wjj865-code/dsh-orchestrator/-/dsh-orchestrator-0.12.0.tgz
HTTP 200
```

provenance：`dist.attestations.url` 指向 `/-/npm/v1/attestations/...@0.12.0`，`provenance.predicateType = https://slsa.dev/provenance/v1`（OIDC 签名正常）。

npmmirror（registry.npmmirror.com）：

```text
$ npm run mirror:check
包：@wjj865-code/dsh-orchestrator@0.12.0
镜像已有 0.12.0（镜像 latest = 0.12.0）：无需同步
```

直接打 HTTP（绕开本地 npm 缓存）：

| 检查项 | 结果 |
| --- | --- |
| packument `dist-tags.latest` | `0.12.0` |
| packument 版本数 | 16（含 `0.12.0`） |
| `/-/dsh-orchestrator-0.12.0.tgz` | `HEAD` 302（CDN 重定向，正常）→ `-L` 跟随 **200** |
| 从镜像 `npm pack @0.12.0` 解包 `package.json` | `version: 0.12.0`，`dsh.client.inject` 4 项 |

包内容抽查（npm 正式包，50 个文件）：`package/client.js`、`package/src/panel-gates.js`、`package/src/` 共 33 个文件、
`package/scripts/mirror-sync.mjs`、`package/docs/UI.md` 均在包内 —— 新门控模块没有漏发。

## 小结

- 0.12.0 在 npm 与 npmmirror 两侧都已可装，`latest` 一致；国内镜像这次是 `release.yml` 自动同步到的（发布后不到 4 分钟就查到了），
  印证「Publish 后触发 syncs」这一步按预期生效。
- 后续再发版：只需 `npm version patch --no-git-tag-version` + CHANGELOG/README 版本字面量 + commit + annotated tag + push，
  镜像同步交给工作流；若超时未就绪，用 `npm run mirror:sync` 补。
