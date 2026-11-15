# npmmirror 同步记录：0.11.0

日期：2026-11-15（Asia/Shanghai）
包：`@wjj865-code/dsh-orchestrator`
镜像：`https://registry.npmmirror.com`
上游：`https://registry.npmjs.org`

## 起因

`0.11.0` 已在 npm 上（`dist-tags { latest: '0.11.0' }`），但 npmmirror 还停在 `0.10.0`——
国内用户默认走镜像，`npm i @wjj865-code/dsh-orchestrator@latest` 与 DSH 插件页的更新入口都拿不到 0.11.0。
npmmirror 只在后台按需/定时回源，新版本常常几十分钟到几小时才出现，所以手动触发一次同步，并把这一步固化进发布流程。

## 触发记录

```
PUT https://registry.npmmirror.com/-/package/%40wjj865-code%2Fdsh-orchestrator/syncs
→ HTTP 201
{"ok":true,"id":"6af9638ec819a802c9ff64c1","type":"sync_package","state":"waiting"}
```

（同一请求再发一次返回同一 `id`，`state` 变成 `processing`：接口按包去重，重复触发不会排队两次。）
同步日志 id：`6af9638ec819a802c9ff64c1`。

注：scoped 包的名字要 URL 编码（`@wjj865-code%2Fdsh-orchestrator`）；不编码也能跑，但编码是官方接口的写法。

## 验证

| 检查 | 同步前 | 同步后 |
| --- | --- | --- |
| `dist-tags`（npmjs） | `{ latest: '0.11.0' }` | `{ latest: '0.11.0' }` |
| `dist-tags`（npmmirror） | `{ latest: '0.10.0' }` | `{ latest: '0.11.0' }` |
| 版本数（npmmirror） | 14（最高 0.10.0） | 15（含 0.11.0） |
| tarball `/-/dsh-orchestrator-0.11.0.tgz` | 404 | HTTP 200，179090 bytes |

同步后的完整性字段与上游一致：

```
version        = '0.11.0'
dist.tarball   = https://registry.npmmirror.com/@wjj865-code/dsh-orchestrator/-/dsh-orchestrator-0.11.0.tgz
dist.integrity = sha512-H+WOlNpJ3XNmcRVJGZ8ldmLhnh3Frz0jcAuWXeCd2CGcGCsOmeTigO5cUhgWrfTCzmkCR0s//TN40WT7N2YVRA==
```

复现命令：

```powershell
npm run mirror:check   # 打真请求查镜像 latest，应为 0.11.0（退出码 0）
npm view @wjj865-code/dsh-orchestrator dist-tags --registry=https://registry.npmmirror.com --prefer-online
```

## 踩坑：本地 npm 缓存会骗人

同步完成后的头几次 `npm view ... --registry=https://registry.npmmirror.com` 仍报 `{ latest: '0.10.0' }`，
`npm view ...@0.11.0 version` 甚至报 `404 No match found for version 0.11.0`——而同一时刻直接 HTTP 拉 packument
（`accept: application/vnd.npm.install-v1+json`，两种格式都试过）已经是 `latest = 0.11.0`、15 个版本。
换新 `--cache` 目录也一样，加到 `--loglevel silly` 才看到真相：

```
npm http fetch GET 200 https://registry.npmmirror.com/@wjj865-code%2fdsh-orchestrator 422ms (cache updated)
{ latest: '0.11.0' }
```

即：**旧答案来自本地 npm 缓存**（响应带 `cache-control: public, max-age=300`，`npm view` 默认不回源校验）。
结论写进 README：排查镜像版本一律用 `--prefer-online`（或直接看 HTTP），`npm run mirror:check` 每次发真请求、不受缓存影响。

## 固化进流程

- `scripts/mirror-sync.mjs`（`npm run mirror:sync` / `npm run mirror:check`）：查镜像 → 缺就 `PUT .../syncs` → 轮询到出现；
  上游 npm 没有该版本直接报错退出 1，镜像已有则幂等退出 0；`--no-wait` / `--timeout <秒>` / `--interval <秒>` 可调。
- `.github/workflows/release.yml`：Publish 后新增「触发 npmmirror 镜像同步」步骤（`continue-on-error`，轮询约 3 分钟，超时 `::warning::`）。
- `README.md` 发版章节 + 排障表、`CHANGELOG.md` 未发布小节同步记录。
- `test/mirror-sync.test.js`：URL 编码、packument 解析、`isSynced` 判定、参数解析共 7 条（不打网络）。
