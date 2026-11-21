# frontmatter 与图片

文颜按 Markdown frontmatter 决定标题、封面、摘要等；**`title` 必填**，否则直接失败。

## 字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `title` | 是 | 公众号文章标题 |
| `author` | 否 | 作者名 |
| `digest` | 否 | 摘要（公众号「摘要」栏）；不填时微信取正文前 54 字 |
| `cover` | 否 | 封面图路径（本地相对/绝对或 URL），`publish` 时上传 |
| `source_url` | 否 | 原文链接（阅读原文） |
| `need_open_comment` | 否 | 是否打开评论（`0` / `1`） |
| `only_fans_can_comment` | 否 | 仅粉丝可评论（`0` / `1`） |

图片消息（不是图文）：`type: image` + `image_list`（≤20 项）——本包不使用。

## 图片规则（`publish`）

- 正文图片与封面都会上传到微信素材库；**本地相对路径仅在 `-f` 是本地文件时有效**。
- `render` 不上传图片：HTML 里保留原 `src`，只用于看排版。
- 封面只认 `cover` 字段；不填时平台可能要求你在后台手选。
- 图片格式以微信支持为准（jpg/png/gif 等）；路径不存在会在上传时报具体文件。

## 示例

```markdown
---
title: 把重复劳动交给脚本之前，先算一笔账
author: 张三
digest: 用一个真实案例说明自动化什么时候值得做、什么时候是负收益。
cover: assets/cover.jpg
source_url: https://example.com/original
---

开头三段之内给出结论……
```
