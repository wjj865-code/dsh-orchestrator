/**
 * dsh-orchestrator 客户端入口（P7 / T7.2：UI 源码已全部迁入 client/src/**）。
 *
 * 构建链：`client/src/**`（ESM 源码）--vite--> `dist/client.js`（classic script）。
 * 平台 `clientExportOf()` 把 package.json `exports["./client"]` 指向的文件**原样** serve 成
 * `/plugins/<id>/client.js` 给 <script> 加载，所以：
 * - 产物里不能有顶层 import/export（源码的 ESM 在构建期被摊平）；本条由 test/client-build.test.js 守；
 * - 样式表用 `./styles.css?inline` 内联回 JS（.css 路由平台不 serve）；
 * - 模块 id 必须等于 package.json 的 name（平台按包名索引，不一致会半静默丢弃）；
 * - 源码不许 import react：React 只能从 factory 的 req 参数拿（否则平台与产物各一份 React，hooks 全废）。
 *
 * 这个文件只做「注册 factory」这一件事；面板与详情在 views.js，装配在 client.js。
 */
import { CLIENT_ID } from './constants.js'
import { createClient } from './client.js'

window.__ModuleLoader__.load({
  id: CLIENT_ID,
  factory: req => createClient(req),
})
