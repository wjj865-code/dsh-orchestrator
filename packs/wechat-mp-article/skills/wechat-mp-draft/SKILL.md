---
name: wechat-mp-draft
description: 用文颜把 Markdown 建到公众号草稿箱（需 env 凭据与 IP 白名单；不做群发）
---

# 建公众号草稿（不做发布）

用文颜 `publish` 把 `out/article.md` **渲染 + 上传图片 + 建一条草稿**。
**它不是群发**：草稿进公众号后台「草稿箱」，最终发布由用户自己在后台完成。本包绝不调用发布接口。

## 前置检查（按顺序，缺一就停）

1. **CLI 已安装**：读 persona 给的 `.state/install.json`，必须 `status: "installed"` 且有 `resolved.node` / `resolved.entry`。
   未安装 → 告诉用户到面板「能力包 → 公众号文章 → 安装 CLI」，不要自己装。
2. **凭据已设置**：只检查存在性（`WECHAT_APP_ID`、`WECHAT_APP_SECRET`），**不要打印值**：
   ```powershell
   node -e "console.log(!!process.env.WECHAT_APP_ID, !!process.env.WECHAT_APP_SECRET)"
   ```
   任一为 false → 让用户去面板「环境变量」段复制 `setx` 命令或由插件设置，然后**彻底重启 DSH**。
3. **文章合格**：`out/article.md` 有 frontmatter `title`；图片路径存在（本地相对/绝对或网络 URL）。

## 命令

```powershell
$node = <install.json 的 resolved.node>
$entry = <install.json 的 resolved.entry>
$env:APPDATA = '<stateDir>\wenyan'
$env:LOCALAPPDATA = '<stateDir>\wenyan'
& $node $entry publish -f out/article.md -t default
```

- 凭据只走环境变量；**不要**用 `--app-id`、`--env-file` 或 `wenyan credential`（会落盘第三方凭据库）。
- 成功输出形如 `发布成功，Media ID: <id>`。解析出 Media ID 后写入 `out/draft.json`：

```json
{ "mediaId": "<id>", "title": "<title>", "at": "2026-11-21T12:00:00.000Z", "theme": "default" }
```

- 输出里没有 `Media ID` → **不要猜成功**：把 stdout/stderr 尾部给用户，标「结果未知」。
- 失败不自动重试（文颜没有幂等，重复执行会新建草稿）。

## 重复建草稿

每次 `publish` 都会**新建**一条草稿，文颜没有查重参数。执行前：

1. 有 `out/draft.json` 时，先告诉用户已有草稿的 Media ID 与时间；
2. 用一句话问「是否再建一条」——用户明确同意才执行；不同意就只排版不建草稿。

## 常见错误 → 可操作提示

| 输出 | 处理 |
|---|---|
| `invalid ip` | 本机出口 IP 不在公众号 IP 白名单：到公众号后台「开发 → 基本配置 → IP 白名单」加上；或换网络。不重试 |
| `invalid appid` / `invalid secret` / `40013` / `40125` | 只提变量名 `WECHAT_APP_ID` / `WECHAT_APP_SECRET`，让用户核对；不打印值 |
| 图片相关报错 | 指出具体图片路径，让用户修正后重跑 |
| 网络/超时（>5 分钟） | 报超时与已等待时长；不要循环重试 |

更多见包内 `references/troubleshooting.md`。

## 安全边界（硬性）

- 插件不落盘、不读取、不回显任何凭据值；你也不要把值写进文章、草稿 JSON、命令历史或回复。
- 不使用 `--server`（自建服务端模式不在本版范围）、不做群发、不调 `freepublish` 接口。
- 文颜自己可能缓存 `access_token`；因已把 `APPDATA`/`LOCALAPPDATA` 重定向到包状态目录，删包即清。
