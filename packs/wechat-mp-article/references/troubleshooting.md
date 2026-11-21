# 排障：文颜（公众号排版 / 建草稿）

先按「现象」找到一行，再执行对应动作；**不要**靠改参数反复重试。

| 现象 | 原因 | 处理 |
|---|---|---|
| `ERR_MODULE_NOT_FOUND: commander` | 用 pnpm 的 junction 路径直接执行 `dist/cli.js` | 用 `realpathSync.native()` 解析后的真路径（安装器已回填到 `install.json` 的 `resolved.entry`） |
| `EPERM` / 写入 `%APPDATA%\wenyan-md` 失败 | 未重定向 `APPDATA`/`LOCALAPPDATA` | 设到包内 `.state/wenyan`（插件运行期自动设置；你自己起子进程时要手动设） |
| `invalid ip` | 本机出口 IP 不在公众号 IP 白名单 | 公众号后台「开发 → 基本配置 → IP 白名单」加上出口 IP；或换网络。**不自动重试** |
| `invalid appid` / `invalid secret` / `40013` / `40125` | `WECHAT_APP_ID` / `WECHAT_APP_SECRET` 不对 | 只提变量名让用户核对；不要读值、不要打印值 |
| `publish` 成功但找不到 Media ID | 版本行为变化/输出被截断 | 不猜成功：把 stdout/stderr 尾部给用户，标「未知」 |
| 图片上传失败（路径不存在/格式不支持） | 图片路径错或格式不支持 | 指出具体图片路径；用户修正后重跑 |
| 建草稿超过 5 分钟 | 大图上传/网络慢 | 报超时与已等待时长；不要循环重试 |
| 草稿箱出现两条 | 重复执行（无幂等） | 建前问用户；已有 `out/draft.json` 时先报 Media ID |
| `--version` 输出不是 2.0.12 | 装了别的版本（手工污染 `tools/<id>`） | 面板卸载后重装；不要手改 `node_modules` |
| 安装 npm 包 404/超时 | registry/代理 | 安装器显式 `--registry=https://registry.npmjs.org`；检查网络与代理，不要改用第三方 registry |

## 快速自检

```powershell
& $node $entry --version
& $node $entry theme -l
& $node $entry render -f <包根>\references\smoke.md > $env:TEMP\smoke.html
node -e "console.log(!!process.env.WECHAT_APP_ID, !!process.env.WECHAT_APP_SECRET)"
```

最后一条只输出布尔；任何一步失败都按上表处理。
