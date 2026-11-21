---
name: wechat-mp-format
description: 用文颜把 Markdown 排版成公众号 HTML（本地预览/导出，不联网、不需凭据）
---

# 公众号排版（本地预览）

用文颜 `render` 把 `out/article.md` 渲染成**公众号可粘贴**的 HTML。
`render` **不联网、不需要凭据、不上传图片**；它只把 HTML 写到 stdout，适合本地看效果/导出留档。
需要建草稿（含图片上传）请用 `wechat-mp-draft`。

## 先确认 CLI 可用

1. 读包会话 persona 里给出的**安装状态文件**（`.../.state/install.json`）。
2. 只有 `status: "installed"` 且 `resolved.node` / `resolved.entry` 都在时才能执行；否则明确告诉用户
   「文颜未安装」，并让他到面板「能力包 → 公众号文章 → 安装 CLI」。**不要自己跑 pnpm/npm 安装、不要自研渲染兜底。**
3. 每次执行 CLI 都设置这两个环境变量（文颜会往 `%APPDATA%\wenyan-md` 写 token 存储；
   不重定向就会写到用户目录，属于计划外写入）：

```
APPDATA=<stateDir>/wenyan
LOCALAPPDATA=<stateDir>/wenyan
```

`<stateDir>` 就在 persona 给的安装状态文件路径里（同目录的上一级）；本插件的运行期调用已经自动这样设。

## 命令

在文章所在目录（有 `out/article.md` 的那层）执行：

```powershell
$node = <install.json 的 resolved.node>
$entry = <install.json 的 resolved.entry>
& $node $entry render -f out/article.md -t default > out/article.html
```

- `-t/--theme`：主题（`default` 起；可选主题用 `& $node $entry theme -l` 列出，让用户挑）。
- `-h/--highlight`：代码高亮（默认 `solarized-light`）。
- `--no-mac-style`：关掉代码块 Mac 三色点。
- `--no-footnote`：关掉脚注。

成功判据：`out/article.html` 非空且含 `<section`（文颜输出全内联样式）。失败时把 stderr 尾部给用户，
**不要**重试或改参数猜。

## 自检

```powershell
& $node $entry --version          # 期望 2.0.12
& $node $entry render -f references/smoke.md > out/smoke.html
```

第二条用包内 `references/smoke.md`（相对包根；按 persona 给的包根拼绝对路径）。

## 边界

- `render` 不替换图片地址：HTML 里仍是 `assets/x.png` 这类原 src，粘贴进公众号后图片不会自动上传——
  这是预期，图片交给「建草稿」路径处理。
- 不要把 HTML 直接当最终稿交付：公众号编辑器的样式与浏览器预览有差异，最终以粘贴后为准。
- 用户要「改样式」而不是改主题时，先建议换主题；本包不做自定义 CSS 注入。
