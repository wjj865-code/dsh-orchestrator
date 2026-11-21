# 文颜 CLI 命令面（`@wenyan-md/cli@2.0.12`）

> 本包只用到 **render** 与 **publish**（= 建草稿，非群发）；其余命令仅作排障参考。
> 版本固定 2.0.12（Apache-2.0），安装走包内 pnpm，不写 PATH、不装全局。

## 调用形态

```
<node> <entry> <command> [options]
```

`node` / `entry` 从包会话 persona 给出的 `.state/install.json` 的 `resolved` 字段读：

```json
{
  "status": "installed",
  "version": "2.0.12",
  "resolved": { "node": "C:\\...\\node.exe", "entry": "C:\\...\\@wenyan-md\\cli\\dist\\cli.js" }
}
```

- `entry` 必须是 **realpath 解析后的真路径**（pnpm 的 `node_modules` 是 junction，
  直接执行 junction 路径会 `ERR_MODULE_NOT_FOUND: commander`）。
- 运行前设 `APPDATA` / `LOCALAPPDATA` 到包内 `.state/wenyan`（文颜会写 token 存储）。

## 命令

| 命令 | 作用 | 本包用法 |
|---|---|---|
| `render -f <md> [-t theme] [-h highlight] [--no-mac-style] [--no-footnote]` | 渲染公众号 HTML 到 stdout | 重定向到 `out/article.html`；不联网、不需要凭据 |
| `publish -f <md> [-t theme] [--proxy url]` | 渲染 + 上传图片 + 建草稿 | 需 `WECHAT_APP_ID`/`WECHAT_APP_SECRET` + IP 白名单；成功打印 `发布成功，Media ID: <id>` |
| `theme -l` | 列出可选主题 | 让用户挑主题 |
| `theme --add/--rm` | 增删主题 | 不使用 |
| `credential -l/-s` | 第三方凭据库（`credential.json`） | **不使用**（会落盘凭据） |
| `token -l/-i` | 第三方 access_token 管理 | 不使用 |
| `serve` | 自建 server 模式 | 不用（不在本版范围） |

## 参数细节

- `-f/--file`：本地路径或 URL。用相对路径时从当前工作目录算；本包统一用 `out/article.md`。
- `-t/--theme`：默认 `default`。
- `-h/--highlight`：代码高亮主题，默认 `solarized-light`。
- `--[no-]mac-style`：代码块 Mac 三色点（默认开）。
- `--[no-]footnote`：脚注（默认开）。

## 实测事实（P0 探针）

- 宿主 Node 为 **Electron-as-node v24.21.0**，`--version` 与 `render` 均可跑。
- 安装体量：259 个包 / `.pnpm` ≈ 184 MiB / 冷装 ≈ 4 分 04 秒 / 热装 ≈ 14 秒；
  **0 个 preinstall/install/postinstall 钩子**；无浏览器/原生二进制。
- `render` 也会初始化 token 存储并写 `%APPDATA%\wenyan-md`；必须重定向。
