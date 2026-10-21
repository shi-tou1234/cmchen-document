# PDF Reader v11~v24 开发交接文档

> 更新时间：2026-10-21（v24 触控板缩放闪烁修复 + 一批顺手性修复）  
> 项目目录：`D:\项目\pdf阅读\pdf-reader`  
> 目标仓库：`https://github.com/shi-tou1234/cmchen-document`  
> 当前结论：**v11/v12 收尾已完成。探针已全部转正为正式回归（全部失败即非零退出），备份/恢复、数据目录 move/merge/replace、单实例双开、真实导出高亮烧录、打包产物冒烟、NSIS 安装/卸载都已实测通过。已推送到 GitHub（main HEAD = 1d96490；推送需按第 7 节第 11 条绕开 Steam++ 的 hosts 劫持）。v13 修掉 6 组实测复现的缺陷，v14 加了标签选择器 / 复制引用 / 批注多格式导出，v15 重做视觉层并精简 README，v16 换成学术编辑风，v17 加上看图模式（图片灯箱，交互移植自博客站点），v18 工具带常驻 + 工具快捷键 + 文档快速切换 + 导入读 PDF 元数据，v19 界面减负 + 引用样式 5 种 + CSL-JSON 互通 + 批注标签与搜索，v20 专注模式 + 页面右键菜单 + 导出当前页 PNG + 深色反色，v21 缩放保持位置 + 标签管理 + 汇总导出批注，v22 单页/滚动双模式 + 搜索命中上下跳 + 大纲带页码，v23 独立阅读笔记（数据层 v4），**v24 触控板缩放闪烁修复 + 搜索去抖 + 库滚动位置保留（按要求不做同步）**。

## 收尾后的一句话现状

- 临时探针已删除，正式回归共 14 个测试文件，全部通过：library 82 / lib-ui 43 / fulltext 36 / formats 59 / settings 22 / metadata 47 / selection 14 / tabs 14 / ui-v11 22 / ui-v12 21 / backup 32 / datadir 19 / single-instance 7 / export-highlight 12 / packaged 15。
- v13 起回归脚本共 22 个，v14 起 24 个，v17 起 25 个，v18 起 26 个，v19 起 27 个，v20 起 28 个，v21 起 29 个，v22 起 30 个，**v23 起 31 个**（新增 `test-v23.js` 20 项），全部通过。

## 三条踩过的坑（别再踩）

1. **全局 `const` 不会挂到 window 上**：新写的渲染层模块（`lightbox.js` / `pdfimages.js` / `docswitch.js`）末尾都要显式 `window.X = X;`，否则别的脚本 `window.X` 拿不到（同一个 `const` 在另一个脚本里能用，但 `window.X` 是 undefined）。
2. **单页模式下别让 IntersectionObserver 管渲染**：隐藏→显示的快照乱序会把刚渲染的页又 free 掉，页面白一块且不会自愈。现在单页模式由 `scrollToPage` 自己渲染/释放，切换回滚动时用 `renderVisiblePages()` 补渲染。
3. **数据层迁移里别用会 `load()` 的 id 生成器**：`genKey()` 内部要 `load()`，而迁移正是在 `load()→normalize→migrateItem` 里跑的，会无限递归把栈打爆、库被当损坏文件重置。笔记 id 用本地随机生成器（`genNoteId`），不碰 store。

## 四条体验约定

1. **触控板与鼠标滚轮要区别对待**：不要用固定步长处理 wheel，也不要对每个 wheel 事件跑一次全量重排。做法是「攒 delta + 最多每 16ms 应用一次 + 用真实 delta 做指数映射」。
2. **别用 `requestAnimationFrame` 做必须执行的事**：窗口隐藏时 rAF 不触发（本项目早就踩过），测试环境（隐藏窗口）会直接测不出来。要么用时间节流，要么加兜底定时器。
3. **高频提示别反复弹**：同一类提示只弹一次（看图模式提示），否则每按一次快捷键都闪一下。
4. **别在 `pointermove` 里读布局属性**（`offsetWidth` 等）：每次都强制重排，大图会拖不跟手。尺寸在初始化时量好缓存起来。
- **推送方式（v17 实测有效）**：SteamTools 证书那条路现在不通（`sslCAInfo` 指向 SteamTools CA，直连 GitHub 时证书链对不上，报 `unable to get local issuer certificate`）。hosts 里已没有 github 的劫持，直接用系统证书库即可：
  ```powershell
  git -c http.sslBackend=schannel push -u origin main
  ```
- **文档结构（v15）**：`README.md` 只讲「有什么 / 怎么用 / 怎么测 / 有什么边界」；逐版本演进记录在 `CHANGELOG.md`；交接细节与约定留在本文件。改 README 时不要再往里堆版本流水账。
- **视觉约定（v16）**：暖纸底 + 墨色字 + 印泥红强调色；衬线标题 / 等宽元信息；发丝线分层，阴影只给浮层；条目是表格行不是卡片。**不要再往回加蓝底、圆角胶囊、软阴影卡片**——那是这轮要推翻的「AI 味」。
- **跨项目复用（v17）**：图片灯箱的交互（缩放/拖拽/捏合/翻页/计数/滚动锁定）来自博客站点 `D:\项目\博客站点\src\components\misc\Markdown.astro` 的 markdown-image-lightbox，移植到 `src/renderer/lightbox.js`；博客那边只读不改。
- v13 重新打包（2026-10-20）：`build/win-unpacked/`、`PDF-Reader-1.0.0-portable.exe`（74,276,569 B）、`PDF-Reader-Setup-1.0.0.exe`（83,641,859 B，NSIS）。打包冒烟在 win-unpacked 与 portable 上各跑过一遍，都是 PASS(15)；**NSIS 本轮没有在本机静默安装**（避免动用户机器），如需验证安装/卸载请手动跑一次 `/S /currentuser`。
- 打包产物已产出并冒烟：`build/win-unpacked/`、`PDF-Reader-1.0.0-portable.exe`（74,277,787 B）、`PDF-Reader-Setup-1.0.0.exe`（83,635,175 B，NSIS）。
- 安装 → 已安装版冒烟 → 静默卸载，全部通过（快捷方式/安装目录随之清理）。
- 收尾过程中修掉 8 个真实缺陷（详见 README v11/v12 章节），其中**「导出副本在真实链路失效」是 v10 起就存在的高危 bug**。

---

## 0. v13：复查修掉的 6 组缺陷（2026-10-20）

这一轮只修 bug、不加功能。全部流程是「先用真实 Electron 探针复现 → 再改 → 再把断言固化进 `scripts/test-bugfix.js`」。

| # | 严重度 | 缺陷 | 位置 | 修法 |
|---|---|---|---|---|
| 1 | 高 | 跨文档撤销把 A 的标注写进 B（并自动落盘到 B 的标注文件） | `annotations.js` undoStack / `renderer.js` loadPdf | 新增 `Anno.reset()`，载入文档与关闭文档时清空撤销栈 |
| 2 | 中 | 页码指示器提前跳页（连带「清除本页」清错页、记住的阅读位置错） | `renderer.js` setupObserver | 拆成两个观察器：`App.io` 预渲染（600px）、`App.vo` 当前页（rootMargin 0） |
| 3 | 中 | 清空搜索后高亮/结果残留，旧搜索还会回填 | `renderer.js` doSearch | 加搜索代号 `searchSeq`，每次 await 后校验；空查询走 `clearSearchHl()` |
| 4 | 中 | 文献库覆盖层没有退路；设置弹窗残留且 Esc 失效 | `library-ui.js` hide/Esc、`index.html` 库头 | 库头加「← 阅读」按钮；`hide()` 一并关子弹窗；Esc 逐层关闭 |
| 5 | 低 | 缩放后下拉框变空（value 是小数、匹配用百分比） | `renderer.js` syncScaleSelect | 改数值匹配；非预设档位补「自定义 xx%」选项 |
| 6 | 低 | 按钮聚焦时按空格会翻页并吃掉按钮的原生激活 | `renderer.js` 键盘处理 | 焦点在 button/a/[role=button]/contenteditable 时让行 |

顺带修掉：`loadPdf` 加载代号（防旧加载 destroy 新文档）、`restoreAnnos` 读盘回来后校验 `filePath`、拖进库时 drop 捕获补 `stopPropagation()`（原来拖进库会被阅读器再打开一次）、导入/拖入同一路径不再重复建条目（`addPdf(..., { dedupe: true })`）。

**约定提醒**：`lib-add-pdf` 的去重是**显式 opt-in**（`opts.dedupe`），底层 API 默认仍「建一条新的」——`test-backup-restore` 用同一路径造第 3 条条目，正是靠这个默认行为。加新的导入入口时记得传 `dedupe: true`。

---

## 0.1 v14：把文献「用起来」的三件事（2026-10-20）

v14 只加功能、不改数据结构，三个功能都对着「读完之后怎么把文献用出去」：

| 功能 | 位置 | 说明 |
|---|---|---|
| 标签选择器 | `src/renderer/library-ui.js` + `index.html`（`#lib-tags`）+ `styles.css` | 侧栏列出所有标签与条数，点一下按标签筛；可多选（命中任一即可）；卡片上的标签也可点（`data-tag-filter`，不会顺手打开 PDF）；有「清除筛选」 |
| 复制引用 | 新增 `src/cite.js` + 详情面板「引用」区 + `preload.copyText` + 主进程 `copy-text` | GB/T 7714-2015 / APA 7 两种样式，实时预览，一键复制到剪贴板 |
| 批注导出多格式 | `src/renderer/renderer.js`（`buildNoteText(fmt)`）+ 主进程 `export-note` 的 `fmt` | MD / CSV / TXT 三个按钮；纯文本格式保持 v11 原样不变 |

**约定提醒**

- `src/cite.js` 是 UMD：Node 端 `require('./cite.js')`、浏览器端 `<script src="../cite.js">` 拿到 `window.Cite`。
- 引用排版的**已知边界**：作者是逗号分隔的纯字符串，没有姓/名/角色结构化信息，APA 不做姓名拆分；没有引文数据库，不支持页码定位符/语言本地化/自定义样式。要完整 CSL 得引 `citeproc-js` + 样式库。
- 批注导出内容在渲染层拼好再走 `export-note` IPC，主进程只管落盘与后缀；新增格式要同时改 `renderer.js` 的 `buildNoteText` 和 `main.js` 的 `NOTE_FORMATS`。

**验证**：`scripts/test-cite.js`（33 项，纯 Node）+ `scripts/test-v14.js`（29 项，真实 Electron）。回归脚本从 22 个增加到 24 个，全部通过。

---

## 1. 一句话现状（收尾前存档）

- 文献库、阅读器、全文检索、文字高亮/评论、备份恢复、设置、元数据抓取、BibTeX/RIS、查重/批量编辑/智能收藏集、多标签页都已有代码。
- 已有回归：数据层 51 项、库 UI 43 项、v11 主流程 12 项、文字高亮 8 项、多标签 10 项，当前全部通过。
- 尚未完成：正式测试固化、恢复/切数据目录/单实例/安装包的端到端验证、打包配置修正、README v11/v12、临时探针清理。
- **当前目录不是 Git 仓库，没有任何 commit，也没有推送到目标仓库。**
- 现有的 `build\PDF Reader 1.0.0.exe` 是 v10 基线产物，**不是 v11/v12 的最新包**。

---

## 2. P0 完成情况

| P0 需求 | 代码 | 实测 | 还差什么 |
|---|---|---|---|
| 库级全文检索 | ✅ `src/fulltext.js` + 主进程 IPC + 库 UI | ✅ 12 项 v11 探针中检索/索引/状态均通过 | 正式测试；打包后 `pdfjs-dist` 是否可加载 |
| 选中文字高亮 + 评论 + 持久化展示 | ✅ `selection.js` + mark 标注 + 侧栏/提示/导出 | ✅ 8 项选区探针通过；评论已写入标注文件 | 真实 PDF 导出的高亮烧录端到端断言；正式测试 |
| 一键备份/恢复 + 升级前自动备份 | ✅ 主进程备份/恢复 + `library.js` 迁移备份 | 🟡 备份文件创建已验证；恢复、恢复前自动备份未做端到端 | 恢复全流程；数据目录移动/合并/替换；备份内容校验 |
| 设置面板：存储位置、默认排序、主题 | ✅ `settings.js` + 设置 UI | ✅ 主题/排序/设置持久化已验证 | 切换存储位置的迁移/合并/替换未端到端；需验证重启后生效 |
| 单实例锁 + 安装包 | 🟡 单实例锁代码已有；安装包未做 | ❌ 单实例只做了代码检查，没有真实双开测试；❌ 目前只有 portable 配置 | 真实双开测试；NSIS/安装包配置；重新打包并冒烟 |

### 2.1 全文检索

实现位置：

- `src/fulltext.js`：主进程用 `pdfjs-dist/build/pdf.js` 抽文本，不依赖渲染窗口，不引 SQLite。
- 每个 PDF 一个索引：`<dataDir>/fulltext/<sha1(绝对路径)>.json`。
- 按 `mtime + size` 判断索引是否新鲜；索引是**可重建缓存**，不进入备份。
- 启动时按设置 `autoIndex` 后台建索引；设置面板可手动重建/清空。
- 搜索结果显示条目、页码、摘要片段；主进程按 `item.key + page` 去重，最多 120 条。

已验证：

- 索引 2 个条目成功，`done=2 / failed=0`。
- 库级搜索出现结果行，片段正确。
- 索引状态有 `indexed/pages/chars`。
- 同一个 PDF 被两个条目引用时，索引文件只有 1 个（按路径缓存），但 `indexedItems=2`。**这是设计行为，不要当成 bug。**

已知边界：

- 全文结果按 `findItemByPath()` 找条目；如果两个库条目指向同一个 PDF，搜索命中通常只会归到其中一个条目。
- 目前 `stats.indexed` 统计的是索引文件数，不是条目数；与 `indexedItems` 可能不同。
- 扫描件没有文本层时索引为空，这是预期。
- 索引按绝对路径生成；移动/重命名 PDF 后需要重新索引。

### 2.2 文字高亮 + 评论

实现位置：

- `src/renderer/selection.js`：把浏览器 selection 的 range 转成页面坐标矩形，弹出浮动工具条。
- `src/renderer/renderer.js`：`mark` 形状渲染、评论编辑、标注自动保存/恢复、导出 payload。
- 标注文件：`<userData>/annotations/<sha1(绝对路径)>.json`，形状为：

```js
{ tool: 'mark', color, rects: [{x,y,w,h}], text, comment }
```

已验证：

- 文本层可选中。
- 选区工具条出现。
- 高亮写入标注模型，矩形坐标有限且宽度大于 0。
- 高亮在页面 SVG 中渲染。
- 高亮 + 评论写入模型和标注文件。
- 导出 payload 含高亮矩形。

还差：

- 在真实“导出副本”PDF 中确认高亮确实被 `pdf-lib` 烧录（当前只验证了导出 payload）。
- 侧栏评论列表、tooltip、笔记导出中的展示需要一条正式回归断言。
- 标注按路径哈希存储：移动 PDF 后旧标注不会自动跟随；重新定位只更新库索引，不会迁移标注文件。

### 2.3 备份 / 恢复 / 迁移备份

实现位置：`src/main.js`、`src/library.js`。

备份文件是 JSON，结构大致为：

```js
{
  app: 'pdf-reader',
  format: 1,
  createdAt: '...',
  settings: { ... },
  library: { version: 3, collections, searches, items },
  annotations: [{ name, data }],
  note: '全文索引不包含在备份内；恢复后可在设置里重建。'
}
```

关键行为：

- 一键备份默认弹保存对话框；也支持传入 `outPath`（探针用）。
- 恢复前会先写一份 `pre-restore-<timestamp>.json` 到 `<dataDir>/backups/`。
- 恢复是**替换库 + 替换标注集**；设置会恢复，但 `dataDir` 保留当前值，避免恢复时把库路径改回旧机器路径。
- 恢复后重建全文索引（索引本身不在备份里）。
- 库版本从 v1/v2 迁移到 v3 前，会把原始文件备份到 `<库目录>/backups/library-pre-vN-*.json`，最多保留 10 份。
- `library.json` 损坏时复制为 `.corrupt-*` 留证，然后从空库继续；带 BOM 的文件可正常读取。

已验证：

- 一键备份生成文件成功（探针）。
- 数据层 v1→v3 读取/迁移、BOM、损坏留证、跨进程持久化通过。
- 恢复、恢复前快照、数据目录切换**尚未端到端验证**。

### 2.4 设置

实现位置：`src/settings.js`。

字段：

```js
{
  dataDir: '',          // 空 = 使用 Electron userData
  defaultSort: 'added', // added | modified | title | year
  theme: 'light',       // light | dark | system
  autoIndex: true,
  restoreTabs: false    // 预留，本版未启用
}
```

行为：

- 设置文件固定在 `<userData>/settings.json`，不随数据目录移动。
- 白名单清洗，非法值回落默认。
- 读坏自动备份 `.corrupt-*` 并回落默认。
- 写盘使用 `tmp → rename` 工程化写法；**注意：rename 前会先 unlink 目标，严格说不是原子替换，断电窗口仍有丢失风险。**
- `dataDir` 只能通过“设置 → 存储位置”走 `lib-choose-data-dir`，普通 `settings-set` 会主动删掉这个字段，避免绕过迁移。

已验证：

- 设置面板打开。
- 显示存储位置。
- 深色主题应用。
- `defaultSort/theme/dataDir` 持久化。
- 重启读取还没有单独断言。

### 2.5 单实例锁与安装包

单实例锁在 `src/main.js` 顶部：

- 非测试模式调用 `app.requestSingleInstanceLock()`。
- 第二个实例聚焦已有窗口；如果命令行带 PDF，会转交给第一个实例打开。
- 测试模式（`SMOKE_PDF` / `PDFREADER_PROBE` / `PDFREADER_LIBUI` / `PDFREADER_TEST`）跳过锁，避免并行测试互相顶掉。

**未完成：**

- 没有真实双开验证。
- `package.json` 的 `build.win.target` 只有 `portable`，没有 NSIS 安装包。
- `build.files` 没有包含主进程全文检索需要的 `pdfjs-dist` 构建；直接打包后全文索引很可能报 `Cannot find module 'pdfjs-dist/build/pdf.js'`。
- 现有 exe 是 v10 的旧包（74,254,876 字节），v11/v12 没有重新打包。

---

## 3. P1 完成情况

| P1 需求 | 代码 | 实测 | 还差什么 |
|---|---|---|---|
| DOI/arXiv 元数据抓取 | ✅ `src/metadata.js` + IPC + 详情面板入口 | 🟡 Crossref 假 fetch 临时验证通过；arXiv 未正式测 | 正式单测；真实网络；UI 回填/错误提示；超时/取消 |
| BibTeX/RIS 导入导出 | ✅ `src/formats.js` + IPC + UI | 🟡 BibTeX 解析/导出临时验证通过；RIS 未正式测 | RIS 单测；UI 导入导出；特殊字符/多作者/学位论文类型 |
| 重复检测、批量编辑、智能收藏集 | ✅ `library.js` + IPC + UI | 🟡 批量编辑、保存搜索已验证；查重/合并未做端到端 | 重复组 UI、保留项选择、合并后附件/标签/收藏集断言 |
| 多标签页 | ✅ `renderer.js` + 标签栏 + 新标签按钮 | ✅ 10 项探针全部通过 | 正式测试；大文件内存策略；关闭标签时未保存标注的边界 |

### 3.1 元数据抓取

- 支持 DOI（Crossref）和 arXiv（export API）。
- 只使用 Node 自带 `fetch`，可注入 `fetchImpl` 方便测试。
- 识别失败、HTTP 错误、JSON/XML 解析失败都返回中文错误，不覆盖原有元数据。
- 目前没有请求缓存、重试、代理设置；Crossref/arXiv 网络不可达时只提示错误。

临时验证结果（fake fetch）：

```json
{"ok":true,"title":"A Study","authors":["Ada Lovelace"],"source":"doi"}
```

### 3.2 BibTeX / RIS

实现：

- `parseRefs(text, filename)` 自动识别 BibTeX/RIS。
- 导出按扩展名选择 `.bib` 或 `.ris`。
- 条目类型映射、作者拆分、页码/年份处理、导入去重（DOI 或标题+年份）已有。

临时验证：

```json
{"format":"bibtex","n":1,"title":"Hello World","authors":["John Doe","Jane Smith"]}
@article{John2024Hello, ...
```

**未测：** RIS 的 `TY/ER` 多记录、`AU` 多作者、`SP/EP` 页码；UI 文件选择与错误提示；导入后的库刷新。

### 3.3 查重 / 批量 / 智能收藏集

- 查重规则：DOI 相同，或“标准化标题 + 年份”相同；按并查集分组。
- 合并：保留项补空字段、合并作者/标签/收藏集；保留可用附件；删除被合并条目（**只删索引，不删 PDF**）。
- 批量编辑：标题、年份、类型、作者、标签、收藏集等；支持批量移入回收站。
- 智能收藏集：`searches: [{id, name, query}]`，本质是保存搜索条件，不复制条目。

已验证：

- 全选 2 项进入批量条。
- 批量改年份生效（两条都变成 2031）。
- 保存智能收藏集成功。

未验证：

- 查重弹窗、合并按钮、合并后的数据一致性。
- 批量标签/收藏集的边界。
- 智能收藏集重新打开后的结果刷新。

### 3.4 多标签页

实现：

- 每个标签保存原始 PDF 字节、文件名、路径、条目 key、当前页。
- 打开不同 PDF 默认新建标签；同一路径已经打开时直接切过去。
- 切换标签时重载当前文档，不重新读盘。
- 关闭标签只结束阅读会话，不删 PDF、不删标注文件。
- 关闭最后一个标签回到空态并显示文献库。

已验证（`_tabstest.js`，10/10）：

- 初始无标签。
- 打开第一条生成标签。
- 打开不同 PDF 生成第二个标签。
- 第二个标签激活。
- 标签栏渲染两个标签。
- 点标签切回第一个文档。
- 切回后页码恢复（条目进度第 2 页）。
- 关闭非激活标签只移除一个。
- 关闭最后一个标签回到空态。
- 空态自动显示文献库。

开发中已修的关键 bug：

- `renderer.js` 里侧栏原本有 `activeTab()`（返回 `'outline' / 'thumbs' / 'annos'`），多标签代码又定义了一个同名 `activeTab()`。函数声明提升导致侧栏版本被覆盖，`syncActiveTab()` 把字符串当对象写 `page`，抛错后标签栏不渲染。现在多标签助手改名为 `currentTab()`，**不要改回去**。

已知边界：

- 多个大 PDF 同时打开会把原始字节都留在内存，暂未做 LRU/磁盘回读。
- 标签页不跨重启恢复（`restoreTabs` 是预留字段，本版未启用）。
- 关闭标签前会 `flushAnnos()`，但没有“有未保存标注时确认”的交互。

---

## 4. 当前测试状态（都是真跑）

在 `D:\项目\pdf阅读\pdf-reader` 下执行：

```powershell
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

node scripts\test-library.js          # [library] PASS (51)
node scripts\test-library-ui.js       # [lib-ui] PASS (43)
node scripts\_v11test.js              # 12 项 checks 全 true
node scripts\_seltest.js              # 8 项 checks 全 true
node scripts\_tabstest.js             # 10 项 checks 全 true
```

说明：

- `test-library.js` 已把版本断言从 v2 更新为 v3；目前 51 项全过。
- `_v11test.js`、`_seltest.js`、`_tabstest.js` 是**临时探针**，依赖 Electron 探针环境，不是正式测试文件；交付前应转正或删除。
- 探针里的 `checks` 是数组，没有统一退出码；建议转成正式脚本时用“失败即非零退出”的方式。
- 旧版回归（`test-pen` / `test-real-input` / `test-lazy-render` / `test-session` / `test-export` / app-smoke）在 v10 全部通过，但**本轮 v11/v12 改动后没有全部重跑**，交接后应补跑。

### 4.1 收尾验证结果（2026-10-20）

| 清单项 | 结果 |
|---|---|
| 备份恢复完整流程（库/设置/标注/pre-restore 快照） | ✅ `test-backup-restore.js` 32 项 |
| 数据目录 move / merge / replace | ✅ `test-datadir.js` 19 项（注意：测试不能用 `PDFREADER_DATA_DIR` 钉住目录） |
| 单实例真实双开 + 命令行 PDF 转交 | ✅ `test-single-instance.js` 7 项（新增 `PDFREADER_HIDDEN` 只藏窗口不跳锁） |
| 查重弹窗与合并 | ✅ `test-ui-v12.js` + `test-library.js` |
| RIS 导入导出 | ✅ `test-formats.js` 59 项 + 导入去重 |
| arXiv 抓取 | ✅ `test-metadata.js`（fake fetch 47 项；真实网络需 `PDFREADER_LIVE=1`，本机 GitHub 不通未跑） |
| 导入/导出 UI 的文件选择 | ⚠️ 原生对话框无法在无头测试中断言，IPC 层已覆盖；真实弹窗路径请人工点一次 |
| 真实 PDF 导出中的高亮烧录 | ✅ `test-export-highlight.js`（探针 5 + 文件级 7）——**顺带修掉导出失效的大 bug** |
| 打包后的全文索引 | ✅ `test-packaged.js` 15 项（asar 含 pdfjs-dist，索引/搜索/导出全过） |
| NSIS 安装包安装/卸载/图标 | ✅ 静默安装→已安装版冒烟→静默卸载全过；升级前注意清理 `HKCU\Software\45ff96a2-*` 残留 |
| 深色主题截图核对 | ⚠️ 探针断言 `theme-dark` class 生效；肉眼观感请自行 `npm start` 切一次主题 |
| v10 旧回归全套重跑 | ✅ pen / real-input / lazy-render / export / library-ui 全部重跑通过 |

**遗留（下轮可做，不阻塞交付）**
- [ ] GitHub 推送（本机 `git ls-remote` 报 CRYPT_E_NO_REVOCATION_CHECK；可试代理或 `git config http.schannelCheckRevoke false`）。
- [ ] 元数据真实网络抓取（本机网络受限时只测了 fake fetch 与错误分支）。
- [ ] 关闭标签前「有未保存标注」的确认交互（当前会自动落盘，不丢数据，只是没有确认弹窗）。
- [ ] 大 PDF 多开内存策略（LRU/磁盘回读）与 `restoreTabs`（预留字段，本版未启用）。

---

## 5. 数据与目录约定（很重要）

默认数据目录是 Electron `app.getPath('userData')`。设置里的 `dataDir` 非空时，库、全文索引、备份跟随数据目录；**设置文件和标注不跟随**。

| 内容 | 路径 |
|---|---|
| 设置 | `<userData>/settings.json` |
| 窗口状态/最近打开 | `<userData>/window-state.json` |
| 文献库（默认） | `<userData>/library.json` |
| 文献库（设置了 dataDir） | `<dataDir>/library.json` |
| 标注 | `<userData>/annotations/<sha1(路径)>.json` |
| 全文索引 | `<dataDir>/fulltext/<sha1(路径)>.json` |
| 备份/恢复前快照 | `<dataDir>/backups/` |
| 库迁移备份 | `<库文件所在目录>/backups/` |

库 v3 形状：

```js
{
  version: 3,
  collections: [{ id, name, parentId }],
  searches: [{ id, name, query }],
  items: [{
    key, itemType, title, creators, year, publication, volume, issue,
    pages, doi, url, abstract, note, language, tags, collectionIds,
    attachment: { path, name }, page, created, updated, deletedAt
  }]
}
```

**永久约定：**

- 任何删除入口都只删索引/软删除，**绝不删除磁盘 PDF**。
- 备份只包含库、设置、标注，不包含 PDF 文件，也不包含全文索引。
- 恢复后 PDF 仍按备份里的绝对路径查找；文件被移动/删除时需要“重新定位”。
- 数据目录切换不会移动 `<userData>/annotations`；但备份会包含标注，恢复时会按标注集替换。

测试环境变量：

- `PDFREADER_LIBRARY`：覆盖 `library.json` 路径。
- `PDFREADER_DATA_DIR`：覆盖全文索引/备份的数据目录。
- `PDFREADER_PROBE` / `PDFREADER_LIBUI` / `SMOKE_PDF` / `PDFREADER_TEST`：测试模式，跳过单实例锁。
- `PDFREADER_NO_AUTO_INDEX=1`：禁止启动自动建索引。
- 测试时建议同时指定 `--user-data-dir=<临时目录>`，不要碰真实库。

---

## 6. 代码地图

```text
pdf-reader/
  src/
    main.js                 Electron 主进程：窗口/菜单/单实例/IPC/备份恢复/导出/索引调度
    library.js              文献库 v3 数据层（纯 Node，可单测）
    settings.js             设置读写、白名单、BOM、损坏备份
    fulltext.js             主进程 pdfjs 文本抽取与库级搜索
    formats.js              BibTeX/RIS 解析与导出
    metadata.js             DOI/arXiv 元数据抓取
    preload.js              contextBridge 暴露 pdfBridge
    renderer/
      index.html            库 UI、标签栏、设置/查重/批量/评论弹窗
      renderer.js           阅读器、连续滚动、标注、标签页、导出
      library-ui.js         文献库列表/详情/搜索/批量/设置/查重交互
      selection.js          文字选区 → 矩形 → 浮动工具条/评论
      annotations.js        标注绘制/命中/导出辅助
      styles.css            全部样式 + 深色主题
      pdfjs/                pdfjs 浏览器构建（由 npm run copy-pdfjs 生成，git 忽略）
  scripts/
    test-library.js         数据层回归（51）
    test-library-ui.js      真实 Electron 库 UI 回归（43）
    libui-check.js          UI 探针脚本
    test-pen.js             画笔/文字标注回归（v10）
    test-real-input.js      真实鼠标输入回归（v10）
    test-lazy-render.js     滚动懒渲染回归（v10）
    test-session.js         最近打开/页码/命令行打开（v10）
    test-export.js          导出副本回归（v10）
    _v11test.js             临时 v11 探针（待转正/删除）
    _seltest.js             临时选区探针（待转正/删除）
    _tabstest.js            临时多标签探针（待转正/删除）
    _v11probe.js / _selprobe.js / _tabsprobe.js   探针内容
  assets/                   图标、sample.pdf
  package.json              Electron Builder 配置
```

架构原则：

- 主进程负责所有文件系统、对话框、网络、索引、备份；renderer 不直接读盘。
- `preload.js` 是唯一桥；新增 IPC 时同步更新 preload 和 `pdfBridge` 类型/调用点。
- `library.js` 保持纯 Node，不依赖 Electron，方便直接 `node scripts/test-library.js`。
- 不引入 SQLite/原生模块；继续用 JSON + 原子写 + 损坏自愈。

---

## 7. 已知风险 / 交接注意（✅ = 收尾已处理）

1. ✅ **打包配置已修正。**  
   `build.files` 已包含 `pdfjs-dist/build/pdf.js`、`pdf.worker.js`、`cmaps/**`、`standard_fonts/**`；`test-packaged.js` 在产物上实跑「建索引 + 搜索 + 导出」验证。

2. ✅ **NSIS 安装包已做。**  
   `win.target: ["portable","nsis"]`，NSIS 为非一键安装（可选目录、建快捷方式）。`win.signAndEditExecutable:false` 和 `npmRebuild:false` 是这台机器的既有规避配置，不要随意删。

3. ✅ **旧包已替换。**  
   v10 旧 exe 已删除，当前产物为 `PDF-Reader-1.0.0-portable.exe`（74,277,787 B）与 `PDF-Reader-Setup-1.0.0.exe`（83,635,175 B），均为 v11/v12 代码。

4. ✅ **v10 回归已全部重跑。**  
   pen / real-input / lazy-render / session / export / library-ui 全部通过。

5. ✅ **备份/恢复已完整演练。**  
   `test-backup-restore.js` 覆盖备份内容、恢复替换、pre-restore 快照、坏备份拒绝。

6. ✅ **数据目录切换已端到端验证。**  
   `test-datadir.js` 覆盖 move/merge/replace；注意测试环境不能用 `PDFREADER_DATA_DIR`（会把 currentDataDir 钉死）。

7. **标注和索引都按绝对路径哈希。**  
   移动/重命名 PDF 会丢标注关联、索引失效；“重新定位”只改库路径，不迁移标注文件。这是当前设计边界，不是本次遗漏。

8. **原子写不是严格原子。**  
   `library.js`、`settings.js`、`main.js` 的 `atomicWrite` 都是 `tmp → unlink 目标 → rename`。正常测试能过，但进程在 unlink/rename 之间崩溃可能短暂无文件；如果要强化，改成直接 rename 覆盖或保留 `.bak`，并加断电恢复测试。

9. **不要恢复 `activeTab` 同名函数。**  
   侧栏的 `activeTab()` 和多标签的 `currentTab()` 必须保持区分；这是本轮实际踩过的 bug。

10. ✅ **临时探针已转正并删除。**  
    正式测试在 `scripts/test-*.js`（探针内容在 `scripts/probe-*.js`，由 `probe-runner.js` 统一驱动）。

11. ✅ **已推送远端成功（2026-10-20，最终方案）。**  
    目标仓库 `https://github.com/shi-tou1234/cmchen-document`，本地提交已全部推上 `main`。  
    **之前推不上去的根因**：SteamTools（Watt Toolkit）的 GitHub 加速在 hosts 里把 `github.com` 指到 `127.0.0.1`，本机 443 端口的 `Steam++.Accelerator.exe` 用自签的 "SteamTools Certificate" 做 TLS 劫持——浏览器信任它所以能开 GitHub，git 不信任所以握手失败（schannel 报吊销检查失败、openssl 报不信任的签发者）。  
    **最终方案（已配置好，日常 `git push/pull` 直接可用）**：
    1. 从 Windows 证书库导出 SteamTools 根证书到 `C:\Users\24256\.git-certs\steamtools-root.pem`（`certutil -store Root f46bbcdd1375119fa56861247f573d43008e6f97 <out.cer>` 后转 PEM）；
    2. 本仓库 `.git/config` 已设 `http.sslBackend=openssl` + `http.sslCAInfo=<上面那个 pem>`——git 走 Steam++ 加速通道并信任其证书。
    备用方案：GFW 抖动时可绕开 hosts 直连真实 IP：`git -c http.curloptResolve=github.com:443:<IP> push`（IP 用 `nslookup github.com 223.5.5.5` 查，2026-10-20 时为 20.205.243.166；注意该配置与代理同时存在时会互相干扰，二选一）。  
    **远端原有占位 Initial commit**（1 行 README），已用 `--allow-unrelated-histories -s ours` 合并进本地历史，完整项目树无损。

12. **新克隆环境需要先生成 pdfjs 浏览器构建。**  
    `src/renderer/pdfjs/` 被 git 忽略，首次运行要：
    ```powershell
    npm install --no-audit --no-fund
    npm run copy-pdfjs
    ```

13. **测试终端的 `ELECTRON_RUN_AS_NODE`。**  
    如果宿主注入了 `ELECTRON_RUN_AS_NODE=1`，Electron 会退化成纯 Node，测试会表现异常。跑任何 Electron 探针前：
    ```powershell
    Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    ```

---

## 8. 建议的收尾顺序（✅ 已全部执行，以下留档）

### 第一步：先保住现有工作（✅ 已完成）

```powershell
cd D:\项目\pdf阅读\pdf-reader
git init
git add .
git commit -m "chore: snapshot v11/v12 implementation before verification"
```

确认 `.gitignore` 不会漏掉必要源码；`src/renderer/pdfjs/` 被忽略是预期，但新环境要 `npm run copy-pdfjs`。

### 第二步：把临时探针转正

建议新增/改造：

- `scripts/test-fulltext.js`：索引新鲜度、搜索片段、重建/清空、重复附件行为。
- `scripts/test-formats.js`：BibTeX/RIS 解析/导出、多作者、页码、特殊字符。
- `scripts/test-settings.js`：白名单、BOM、损坏备份、原子写。
- `scripts/test-metadata.js`：fake fetch Crossref/arXiv、错误分支、超时。
- `scripts/test-selection.js`：现 `_seltest.js` 转正，补侧栏/评论/真实 PDF 导出。
- `scripts/test-tabs.js`：现 `_tabstest.js` 转正。
- 扩展 `scripts/test-library.js`：`searches`、`bulkUpdate`、`findDuplicates/mergeItems`、`importItems`、迁移前备份。
- 扩展 `scripts/libui-check.js`：全文结果、智能收藏集、查重弹窗、批量编辑、设置面板、导入导出。

所有正式测试应“失败退出码非 0”，不要只打印 checks。

### 第三步：补端到端

- 备份 → 改库 → 恢复 → 校验库/设置/标注/pre-restore。
- 数据目录 move / merge / replace 三条路径。
- 单实例真实双开 + 命令行带 PDF。
- arXiv 真实抓取、DOI 真实抓取（网络失败也要有可读提示）。
- 真实导出 PDF 后重新打开，确认高亮/评论/矩形存在。

### 第四步：打包

1. 更新 `package.json` 的 `build.files`，加入 `pdfjs-dist` 主进程构建。
2. 增加 NSIS 安装包 target（保留 portable）。
3. 先 `npm run copy-pdfjs`，再构建 `win-unpacked`。
4. 按现有流程对 `win-unpacked\PDF Reader.exe` 跑 rcedit 嵌图标，再 `electron-builder --win portable --prepackaged build\win-unpacked`。
5. 在**打包产物**上冒烟：打开 PDF、建全文索引、搜索、看高亮、导出副本、检查图标。
6. 记录 exe 大小/哈希/冒烟结果。

### 第五步：文档与交付

- README 增加 v11（P0）和 v12（P1）章节，写清已验证/未验证、数据路径、备份不含 PDF/索引、测试命令。
- 删除或转正 `_v11probe.js`、`_v11test.js`、`_selprobe.js`、`_seltest.js`、`_tabsprobe.js`、`_tabstest.js`。
- 更新 `HANDOFF.md` 的最终验证结果。
- Git 提交，添加 remote，推送：
  ```powershell
  git remote add origin https://github.com/shi-tou1234/cmchen-document.git
  git branch -M main
  git push -u origin main
  ```
- 推送前确认远端是否为空；如果远端已有内容，先拉取/合并，不要强推。

---

## 9. 当前可直接运行的命令（✅ 已更新）

```powershell
cd D:\项目\pdf阅读\pdf-reader
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

# 开发启动
npm start

# 数据层 / 库 UI
node scripts\test-library.js        # [library] PASS (82)
node scripts\test-library-ui.js     # [lib-ui] PASS (43)

# v11/v12 正式回归（完整清单见 README「v11/v12 回归测试」）
node scripts\test-fulltext.js       # [fulltext] PASS (36)
node scripts\test-formats.js        # [formats] PASS (59)
node scripts\test-settings.js       # [settings] PASS (22)
node scripts\test-metadata.js       # [metadata] PASS (47)
node scripts\test-selection.js      # [selection] PASS (14)
node scripts\test-tabs.js           # [tabs] PASS (14)
node scripts\test-ui-v11.js         # [ui-v11] PASS
node scripts\test-ui-v12.js         # [ui-v12] PASS
node scripts\test-backup-restore.js # [backup] PASS (32)
node scripts\test-datadir.js        # [datadir] PASS (19)
node scripts\test-single-instance.js  # [single-instance] PASS (7)
node scripts\test-export-highlight.js # [export-highlight] PASS (12)

# 打包产物冒烟
node scripts\test-packaged.js       # [packaged] PASS (15)
```

> 所有测试自建临时目录并在结束时清理；不要在没有隔离环境变量的情况下让测试指向真实 `userData`。

---

## 10. 交接时最需要先确认的三件事

1. 目标仓库是否已有内容，是否允许直接推 `main`。
2. 安装包是必须 NSIS，还是 portable 也可接受（当前代码只有 portable）。
3. 备份/恢复是否要求“跨机器可恢复 PDF 本体”（当前设计只备份元数据+标注，PDF 需另行携带）。

如果这三点没有确认，先不要做破坏性数据目录演练或强推远端。
