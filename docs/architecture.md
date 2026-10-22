# 架构

Trove 是一个 Electron 应用：主进程管文件和索引，渲染进程管界面，两边只通过 `preload.js` 暴露的 `window.pdfBridge` 通信。没有数据库、没有原生模块、没有前端框架，渲染层是原生 HTML / CSS / JS。

```
┌──────────────────────────── 主进程 src/main.js ────────────────────────────┐
│ 窗口 · IPC · 打开文档 · 备份恢复 · 数据目录 · 单实例 · 全文索引 · 格式转换  │
│   library.js   fulltext.js   docconvert.js   settings.js   formats.js      │
│   cite.js      bib.js        creators.js     metadata.js   pdfmeta.js      │
│   usermigrate.js
└───────────────────────────────────┬────────────────────────────────────────┘
                                    │ preload.js / contextBridge
                                    │ window.pdfBridge.*  (invoke / send / on)
┌───────────────────────────────────┴────────────────────────────────────────┐
│ 渲染进程 src/renderer/                                                      │
│   renderer.js     阅读器：PDF.js / 富文档 / 缩放 / 翻页 / 标签 / 搜索        │
│   library-ui.js   文献库：列表 / 详情 / 收藏集 / 标签 / 批量 / 设置          │
│   annotations.js  标注模型与 SVG 绘制                                       │
│   selection.js    文本层选区 → 高亮 / 评论 / 摘录                            │
│   lightbox.js     看图模式灯箱                                              │
│   pdfimages.js    从 PDF 操作符里定位内嵌位图                                │
│   docswitch.js    文档快速切换面板                                          │
│   index.html / styles.css                                                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 进程分工

| 层 | 职责 | 不做什么 |
|---|---|---|
| 主进程 | 建窗口、读写磁盘、文件对话框、备份、全文索引、格式转换、菜单 / 快捷键 | 不碰 DOM，不渲染页面 |
| preload | 把 IPC 包成 `window.pdfBridge`；`contextIsolation: true`、`nodeIntegration: false` | 不写业务逻辑 |
| 渲染进程 | 所有界面与交互；PDF.js 画 canvas；标注、搜索、标签页 | 不直接读文件系统 |

安全底线：渲染层拿不到 `require` / `fs`。拖进来的文件用 `webUtils.getPathForFile()` 取真实路径，再交给主进程读字节。

## 数据模型

### 库 `library.json`（v7）

```js
{
  version: 7,
  tagColors: { "标签": "#rrggbb" },
  annoTags: { "<标注 id>": ["标签"] },    // 标注的标签（标注本体在 annotations/）
  collections: [{ id, name, parentId, color }],
  searches:    [{ id, name, query }],          // 智能收藏集：保存的搜索条件
  items: [{
    key, itemType, title, creators: [creator], year, publication,
    volume, issue, pages, doi, url, abstract, note, language,
    tags: [string], collectionIds: [string],
    fields: { publisher, place, isbn, ... },    // 按条目类型的补充字段
    relations: [key],                            // 双向相关条目
    notes: [{ id, title, text, created, updated }],
    attachment: { path, name },                  // 只引用磁盘路径，不复制文件
    page, created, updated, deletedAt
  }]
}

// creator = { firstName, lastName, creatorType }
// creatorType: author | editor | translator | contributor
```

- **37 类条目**：`ITEM_TYPES` 在 `library.js` 里，label 同时供 UI 和引用格式化使用，不重复维护。
- **作者结构化（v6）**：`creators` 是 `{firstName, lastName, creatorType}` 数组，中文名与机构名只填 `lastName`。
  拆分规则集中在 `creators.js`：逗号在前（`Smith, John`）、空格在后（`John Smith`）、含汉字不拆、`{...}` 当机构名。
- **迁移**：读到低版本先写 `backups/library-pre-vN-*.json` 快照，再逐级补字段。v3 → v4 把单个 `note` 变成 `notes[0]`；v4 → v5 增加 `fields` / `relations` / 颜色；v5 → v6 把字符串作者拆成结构化作者；v6 → v7 增加 `annoTags`（标注标签）；v7 → v8 增加 `annoMeta`（标注对象层：可编辑文字/标签/所属条目/生成的笔记）与条目的 `annoIds`。
- **写盘**：先写临时文件再 `rename`，避免半截 JSON。读坏文件时留 `.corrupt-*` 备份并回退到空库，不让应用起不来。
- **删除**：`deletedAt > 0` 即回收站；所有删除入口只改索引，绝不 `unlink` 附件。

### 标注 `annotations/<sha1(path)[:20]>.json`

```js
{ path, saved, pages: [{ page, shapes: [...] }] }
```

图形种类：`pen` / `highlight` / `line` / `rect` / `arrow` / `text` / `note` / `mark`（文字选区，含 `kind:'quote'` 摘录）。

坐标是**单位坐标**：scale = 1 时的页面像素（等于 PDF 点），左上原点、y 向下。SVG 的 `viewBox` 固定为页面单位尺寸，外层用 CSS 宽高拉伸，所以缩放不需要重算任何形状。

每页有两个叠加层：

- `.anno-base`：荧光笔、文字高亮（在文字下面）；
- `.anno`：画笔、图形、文字、便签（在文字上面）。

标注按文件路径哈希存盘。移动 / 重命名文件后哈希变了，旧标注不会自动跟随——这是"按路径引用"的代价，库里的"附件重定位"只改条目路径，不迁移旧标注。

这些标注现在在文献库里有第二个入口：侧栏「标注」把 `annotations/*.json` 里的批注汇总成一张表（`anno-list` IPC），可以搜索、打标签（标签存在 `library.json` 的 `annoTags` 里）、批量导出成 Markdown 笔记。标注本体仍然跟着文件走，库这边只保存用户加的标签。

### 设置与窗口状态

- `settings.json`：`dataDir`、`defaultSort`、`theme`、`autoIndex`、`hintSeen`、`invertPages`、`viewMode`。字段白名单，读坏回退默认值。
- `window-state.json`：窗口位置 / 尺寸 / 最近打开（最多 8 条，含每份文件的页码）。
- `fulltext/<sha1(path)>.json`：全文索引，按 `mtime + size` 判断新鲜度，可重建，不进备份。

## 打开一份文档的链路

```
用户操作（对话框 / 拖入 / 最近打开 / 双击 / 命令行）
        ↓
主进程 readDocPayload(filePath, extra)
        ├─ .pdf  → readPdfPayload：fs.readFileSync → Uint8Array，附 startPage
        └─ 其它  → docconvert.readDocument：转成 [{ title, html, text }]，附 startPage
        ↓  IPC 'pdf-opened'
渲染进程 openDocument(payload)
        ├─ kind === 'pdf'  → loadPdf：PDF.js getDocument({data}) → buildPageBlocks
        └─ kind === 'rich' → loadRichDoc：把 pages 渲染进 #doc-view
        ↓
scrollToPage(startPage) + restoreAnnos(path) + 记入标签页 / 最近打开
```

关键点：

- **PDF 不经过 docconvert**。`readDocument('x.pdf')` 只返回 `{kind:'pdf'}`，字节仍由 PDF.js 消费。
- **`#pages` 与 `#doc-view` 互斥**。富文档隐藏并清空 `#pages`，但页面 id 仍是 `page-N`，所以页码、`scrollToPage`、目录、侧栏都能复用。
- **PDF.js 会转移 ArrayBuffer**。`getDocument({data})` 之后原字节会 detached，所以导出副本必须用主进程另外保存的副本 / 重新读取，不能直接把同一个 buffer 再经 IPC 传回去。
- **`startPage` 的来源**：条目里记的页码 > 最近打开里记的页码 > 1（命令行 / 拖入时先查最近打开）。

## 渲染与懒加载

PDF 每页一个 `.page` 容器，里面是 `canvas` + `.textlayer` + `.hl-layer` + 两个 SVG 标注层。

- **两个 IntersectionObserver，不能合并**：
  - `App.io`（`rootMargin: 600px`）负责预渲染 / 释放位图；
  - `App.vo`（`rootMargin: 0`）负责判断"当前页"，驱动页码、记住阅读位置。
  合并会导致页码提前跳到下一页。
- **单页模式不走观察器**。隐藏 / 显示的快照乱序会把刚渲染的页又 free 掉，所以单页模式由 `scrollToPage` 自己渲染 / 释放。
- **缩放保持位置**：缩放前记下当前页顶边相对视口的位置，`applyLayout` 之后补回滚动位置。
- **不要用 CSS `transform: scale()` 放大位图**：合成层纹理 = 位图 × 倍数，超过 GPU 上限就整块不画（表现为"放大后变白"）。灯箱按显示分辨率重绘位图，CSS 只做平移。
- **不要用 `requestAnimationFrame` 做必须执行的事**：隐藏窗口里 rAF 会降到约 1 Hz，测试环境尤其明显。用时间节流或加 `setTimeout` 兜底。

## 全文索引

- 主进程直接跑 PDF.js 的文本抽取（`pdfjs-dist/build/pdf.js`），不依赖渲染窗口；非 PDF 走 `docconvert.extractText`。
- 每份文档一个 JSON，按路径哈希命名；写入前比对 `mtime + size`，没变就跳过。
- 启动后延迟 1.2 秒后台补索引，不阻塞首屏；也可以在设置里关掉自动索引。
- 搜索是子串匹配 + AND 多关键词，返回 `{page, snippet, source}`；`source` 区分全文 / 批注 / 摘录 / 笔记。
- 索引不属于用户数据，备份不包含；丢了在设置里点"重建索引"。

## 引用与参考文献表

- `creators.js` 管**作者结构**：`{firstName, lastName, creatorType}` 的归一化、姓名拆分（逗号在前 / 空格在后 / 中文不拆 / 花括号=机构名）、缩写与显示名。主进程与渲染进程共用同一份。
- `cite.js` 只格式化**单条**：5 种样式、37 类标识、citekey。姓与名分开之后，GB/T 能出 `SMITH J`、APA 能出 `Smith, J.`、IEEE 能出 `J. Smith`。
- `bib.js` 负责**一批**：按样式决定默认排序（编号制保持传入顺序，作者-年份制按姓氏），同作者同年补 a / b，编号制重新编号，最后包成 Markdown 或纯文本。
- citekey 由渲染层传入整库分配的 Map，避免只选部分条目时出现不同的 `-2` 后缀。
- 保存走通用 `save-text` IPC：渲染层拼好文本，主进程只弹系统对话框 + 原子写，不再读一遍库。

## 格式转换的安全边界

`docconvert.js` 把 Office / EPUB / Markdown 转成 HTML 后统一过 `sanitize-html`：

- 允许的标签与属性是白名单；`script`、事件属性、`javascript:` 链接、`iframe` / `object` / `embed` 全部剥离；
- 图片只允许 `data:`（本地图片会先读成 data URL 内联），远程图片丢弃；
- 上限：400 页、12 MB HTML、单页 4 MB 文本、单张图片 8 MB、表格 2000 × 80；
- 旧 `.doc` 用 `word-extractor` 取纯文本，旧 `.ppt` 直接提示另存为 `.pptx`。

新增格式时不要绕过 `clean()`，也不要把远程资源放进来。

## 标签页、会话与单实例

- 标签页只活在当前进程里（`settings.restoreTabs` 预留但未启用）。同一路径再次打开会切到已有标签，不新开。
- 切换标签不销毁 PDF 文档；关闭标签只释放渲染资源，不删 PDF、不删标注文件。
- **单实例**：`app.requestSingleInstanceLock()`；第二个实例把命令行里的文档转交给第一个后退出。探针 / 测试模式跳过这把锁（`test-single-instance` 除外，它专门验证锁）。
- **数据目录迁移必须先于单实例锁**：如果两个实例一个用旧目录、一个用新目录，锁会落在不同位置，等于允许双开。

## 改名搬家（PDF Reader → Trove）

- Electron 的 userData 目录名取自 `package.json` 的 `name`：老 `%APPDATA%\pdf-reader`，新 `%APPDATA%\trove`。**不是** productName，也不是 `app.setName()` 的结果。
- `usermigrate.js` 是纯 Node 模块，可单测（`scripts/test-usermigrate.js`）：
  - 只复制新目录里不存在的文件；
  - 跳过 `Singleton*`、`Cache`、`GPUCache`、`Code Cache` 等 Chromium 缓存；
  - 任何一步失败都返回 `ok:false`，`main.js` 退回老目录继续用。
- 备份文件里的 `app` 标识新写 `trove`，恢复时同时接受 `pdf-reader`。
- 测试 / 探针模式（`PDFREADER_*`、`--user-data-dir`）**不搬家**，否则临时目录会读到真实用户的数据，测试互相污染。

内部命名空间刻意保留：`PDFREADER_*` 环境变量、`set-default-pdf-reader` IPC、`--pdfreader-app` 标记、`pdfreader-*` 临时目录前缀。它们与产品名无关，改动面大且没有收益。

## 为什么是 JSON，不是 SQLite

这台机器编不了原生模块，而自用库的量级是几千条。JSON 的好处是可读、可备份、可手改、跨版本迁移简单；代价是全量读写和 O(n) 搜索。数据层把读写收敛在 `library.js`，真要换 SQLite 时不需要动阅读器。

## 目录约定

| 路径 | 说明 |
|---|---|
| `src/` | 主进程与渲染进程源码 |
| `src/renderer/pdfjs/` | `npm run copy-pdfjs` 生成的 PDF.js UMD 构建，不进仓库 |
| `scripts/` | 回归脚本、探针、图标 / 样本 / 截图工具 |
| `assets/` | 图标源图与多尺寸产物、样本 PDF |
| `docs/` | 本文件、开发文档、README 截图 |
| `build/` | electron-builder 产物，不进仓库 |
