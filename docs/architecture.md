# 架构

Trove 是一个 Electron 应用：主进程管文件和索引，渲染进程管界面，两边只通过 `preload.js` 暴露的 `window.pdfBridge` 通信。没有数据库、没有原生模块、没有前端框架，渲染层是原生 HTML / CSS / JS。

```
┌──────────────────────────── 主进程 src/main.js ────────────────────────────┐
│ 窗口 · IPC · 打开文档 · 备份恢复 · 数据目录 · 单实例 · 全文索引 · 格式转换  │
│   library.js   fulltext.js   docconvert.js   settings.js   formats.js      │
│   cite.js      csl.js        csl-styles.js   bib.js        creators.js     │
│   metadata.js  pdfmeta.js    query.js        fetchpdf.js   usermigrate.js  │
└───────────────────────────────────┬────────────────────────────────────────┘
                                    │ preload.js / contextBridge
                                    │ window.pdfBridge.*  (invoke / send / on)
┌───────────────────────────────────┴────────────────────────────────────────┐
│ 渲染进程 src/renderer/                                                      │
│   renderer.js     阅读器：PDF.js / 富文档 / 缩放 / 翻页 / 标签 / 搜索        │
│   library-ui.js   文献库：列表 / 详情 / 收藏集 / 标签 / 批量 / 设置          │
│                   + 全屏 Markdown 笔记编辑器（源码 / 预览双栏）              │
│   annotations.js  标注模型与 SVG 绘制                                       │
│   native-annos.js PDF 自带批注（/Annots）→ 本地标注对象                     │
│   selection.js    文本层选区 → 高亮 / 评论 / 摘录                            │
│   lightbox.js     看图模式灯箱                                              │
│   pdfimages.js    从 PDF 操作符里定位内嵌位图                                │
│   docswitch.js    文档快速切换面板                                          │
│   modeswitch.js   阅读 / 文献库 双视图切换                                  │
│   index.html / styles.css                                                   │
│                                                                             │
│ 渲染进程与主进程共用的 UMD 模块：query.js（检索语法）· markdown.js（渲染）    │
│   richtext.js（清洗）· creators.js（姓名）· csl.js / csl-styles.js（CSL）    │
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

### 库 `library.json`（v8）

```js
{
  version: 8,
  tagColors: { "标签": "#rrggbb" },
  annoTags: { "<标注 id>": ["标签"] },    // 兼容读：v7 的位置式键，写入前会并进 annoMeta
  annoMeta: {                            // 标注对象层：标注意体在 annotations/，这里存"对象这一侧"
    "<标注 id>": { text, comment, tags, itemKey, noteIds, created, updated },
  },
  collections: [{ id, name, parentId, color }],
  searches:    [{ id, name, query }],          // 智能收藏集：保存的搜索条件
  items: [{
    key, itemType, title, creators: [creator], year, publication,
    volume, issue, pages, doi, url, abstract, note, language,
    tags: [string], collectionIds: [string],
    fields: { publisher, place, isbn, ... },    // 按条目类型的补充字段
    relations: [key],                            // 双向相关条目
    notes: [{ id, title, text, created, updated }],
    annoIds: [string],                           // 与 annoMeta 的 itemKey 构成双向关联
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
- **撤销栈**：写操作前后各序列化一次库，有变化才入栈（上限 20 步）。笔记的逐字编辑**不进栈**，否则打字就填满。

### 标注对象层（v8）

标注真身（坐标 / 颜色 / 文字）仍然在 `annotations/<sha1(path)>.json`，库这边存"对象这一侧"的东西：

```
annotations/<sha1(path)>.json   ← 形状：pen / highlight / underline / rect / mark / image …
library.json  annoMeta[id]      ← 文字、批注、标签、所属条目、生成的笔记
library.json  items[].annoIds   ← 与 annoMeta.itemKey 双向
```

- **稳定 id**：老 id 是「文件 hash:页码:本页下标」，删掉中间一条后面全串位（标签会贴到别的标注上）。现在形状在创建时生成稳定 id，启动时给老标注补 id，并把 `annoTags` 的旧位置式键一次性重映射成新 id。
- **可编辑**：`updateAnno` 改的是标注真身（写回 `annotations/*.json` 并通知阅读器重绘），`annoMeta` 只存对象这一侧。
- **生成笔记**：按标注包围盒截页面区域（选区高亮叠半透明色块）→ PNG 存 `snapshots/` → 生成一条带图的阅读笔记，标注侧记下 `noteIds`。

### 标注 `annotations/<sha1(path)[:20]>.json`

```js
{ path, saved, pages: [{ page, shapes: [...] }] }
```

图形种类：`pen` / `highlight` / `underline` / `line` / `rect` / `arrow` / `text` / `note` / `mark`（文字选区，含 `kind:'quote'` 摘录）/ `image`（图片标注，位置 = 它在页面上的矩形）。

坐标是**单位坐标**：scale = 1 时的页面像素（等于 PDF 点），左上原点、y 向下。SVG 的 `viewBox` 固定为页面单位尺寸，外层用 CSS 宽高拉伸，所以缩放不需要重算任何形状。

每页有两个叠加层：

- `.anno-base`：荧光笔、文字高亮（在文字下面）；
- `.anno`：画笔、图形、文字、便签（在文字上面）。

**富文档（Word / PPT / Excel / Markdown / EPUB）也有同一套叠加层**：`loadRichDoc` 给每个 `.doc-page` 挂上 `.anno-base` / `.anno` 两个 SVG 并 `Anno.attachPage`。区别是富文档的 SVG **不设 viewBox**——用户单位 = 页面 CSS 像素，页面变高 / 缩放都不漂（`#doc-view` 用 CSS zoom，缩放天然跟随）。

标注按文件路径哈希存盘。在应用里用"按条目重命名"改名时，标注文件与全文索引跟着搬到新路径；在资源管理器里改名 / 移动后，可用"附件重定位"更新路径并复制旧标注到新路径的哈希文件，合并目标已有标注、保留旧副本。同 id 内容冲突时中止，不覆盖原标注。

这些标注现在在文献库里有第二个入口：侧栏「标注」把 `annotations/*.json` 里的批注汇总成一张表（`anno-list` IPC），可以搜索、打标签（标签存在 `library.json` 的 `annoMeta[id].tags` 里）、批量导出成 Markdown 笔记。标注本体仍然跟着文件走，库这边存的是"对象这一侧"（见「标注对象层」）。

### 设置与窗口状态

- `settings.json`：`dataDir`、`defaultSort`、`theme`、`autoIndex`、`restoreTabs`（恢复上次标签页）、`hintSeen`、`invertPages`、`viewMode`、`fetchEmail`（Unpaywall 的联系邮箱）。字段白名单，读坏回退默认值。
- `window-state.json`：窗口位置 / 尺寸 / 最近打开（最多 8 条，含每份文件的页码）。
- `session.json`：上次会话的标签清单（路径 / 页码 / 激活项），`restoreTabs` 开启时启动恢复用（见「标签页、会话与单实例」）。
- `fulltext/<sha1(path)>.json`：全文索引，按 `mtime + size` 判断新鲜度，可重建，不进备份。
- `snapshots/`、`styles/`、`attachments/`：托管资源随迁移和 JSON 备份携带，资源总量上限 60 MB（超限报错，不截断）。备份保留 `format:1` 与旧 `images` 字段，并增加 `resources`、`sourceDataDir` 用于恢复路径。
- `atomic-file.js`：同目录临时文件写完再替换，失败不直写旧文件；库和设置仅在落盘成功后确认状态，库失败时回滚缓存，撤销栈保留重试机会。
- `data-resources.js`：先暂存资源、库、标注与设置，再提交；失败恢复已提交文件。回滚本身失败时保留临时恢复副本并报告位置。
- 大库列表按 80 行分块，只挂载视口附近的 DOM；选择状态仍按 key 保存。引用键重名分配记录下一后缀，避免重复从 2 扫起。

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
- **放大模式（`Z` 切换）用锚点模型**，和上面那条"保持位置"不是一回事：改缩放前记下「光标下那一点在哪一页、页内什么位置」（单位坐标），`applyLayout()` 之后把这一点挪回光标处 —— 所以连续滚滚轮时视线中心始终不跑。它按新倍数走 `applyLayout()` 真实重渲染（不 CSS 拉伸，否则字发虚）。模式下滚轮专职缩放、空格 + 左键拖动平移；退出后滚轮恢复翻页，缩放结果保留。
- **`#pages` 必须是 `align-items: safe center`**：纯 `center` 的超宽子项向左右各溢出一半，左侧溢出滚不到（放大后页面左半边会看不见）。`safe` 在溢出时退回 `start`。
- **不要用 CSS `transform: scale()` 放大位图**：合成层纹理 = 位图 × 倍数，超过 GPU 上限就整块不画（表现为"放大后变白"）。灯箱按显示分辨率重绘位图，CSS 只做平移。
- **不要用 `requestAnimationFrame` 做必须执行的事**：隐藏窗口里 rAF 会降到约 1 Hz，测试环境尤其明显。用时间节流或加 `setTimeout` 兜底。

## 全文索引

- 主进程直接跑 PDF.js 的文本抽取（`pdfjs-dist/build/pdf.js`），不依赖渲染窗口；非 PDF 走 `docconvert.extractText`。
- 每份文档一个 JSON，按路径哈希命名；写入前比对 `mtime + size`，没变就跳过。
- 启动后延迟 1.2 秒后台补索引，不阻塞首屏；也可以在设置里关掉自动索引。
- 搜索是子串匹配 + AND 多关键词，返回 `{page, snippet, source}`；`source` 区分全文 / 批注 / 摘录 / 笔记。
- 结果按**相关性**排序：命中次数 × 词重（短语 ×3）+ 每千字密度加成；snippet 优先在原文上定位（折叠会改字符串长度，不能拿折叠索引切原文）。
- 索引不属于用户数据，备份不包含；丢了在设置里点"重建索引"。

## 统一检索语法（query.js）

`query.js` 是 UMD 模块，主进程与渲染进程共用一份。库内搜索、全文检索、批注 / 摘录 / 笔记合并搜索都走它。

```
"deep learning"      引号短语（直引号 / 中文引号都认）
-综述  -"书评"       排除（词中间的 foo-bar 不算排除）
a OR b  a | b  a || b  或（OR 必须大写；小写 or 仍当普通英文词）
(a OR b) c           括号分组 + 隐式 AND；显式 AND 也行
-(a OR b)            整组排除
title: author: year: tag: note: abstract: type: file: publication:
doi: url: volume: issue: pages: language:      14 个字段限定
```

- **语法树**：`parseQuery` 先词法分析、再递归下降生成 `ast.tree`（`term` / `and` / `or` / `not`）。旧的 `ast.text` / `ast.not` / `ast.fields` 仍然填好，排序、摘要锚点和老调用继续用；但**过滤一律走树**。
- **三值求值 `eval3`**：字段词在正文层返回 `null`、自由词在字段层返回 `null`。这样 `(title:x OR foo)` 不会把 title 条件误当硬约束，OR 分支也不会被拉成 AND。`matchText` / `matchFields` / `evalText` 都基于它。
- **变音折叠**：搜 `cafe` 能命中 `café`；拉丁扩展逐字符折叠（不整串 NFD，韩文等长度不变），弯引号 / 各类空格一并归一。
- **连续 CJK 串**天然按短语整体匹配。
- 匹配助手分工别搞混：`matchTokens`（全中）、`matchNone`（任一命中即弃，排除语义用它，**不能拿 `matchTokens` 取反**）、`matchFields` / `matchFieldsNot`（字段级过滤）、`matchText` / `evalText`（正文级，字段词不参与）。
- 只有字段限定、没有正文词时，走条目级分支（`type:item`）直接按条目字段过滤。

## 引用与参考文献表

- `creators.js` 管**作者结构**：`{firstName, lastName, creatorType}` 的归一化、姓名拆分（逗号在前 / 空格在后 / 中文不拆 / 花括号=机构名）、缩写与显示名。主进程与渲染进程共用同一份。
- `cite.js` 管**入口与 5 种内置样式**：`gbt7714 / apa / chicago / ieee / mla`，37 类标识、citekey。`format()` 先看 `csl:` 前缀，命中就交给 `csl.js`；`styleList()` 把 5 种内置与已注册的 CSL 样式合成下拉数据源（内置样式 / CSL 样式（内置）/ 导入的 CSL 样式）。
- `csl.js` 是**自研 CSL 1.0.2 子集**（UMD，主进程与渲染进程共用）：手写 XML 解析 → 样式解析（macro / citation / bibliography / sort / locale terms / page-range-format）→ 渲染参考文献表布局。不依赖 citeproc-js，也不联网。支持 `text / group / choose / names / date / number / label`、et-al、姓名缩写与排序、页码格式、text-case、引号、affix 与标点去重；不认识的元素记进 `warnings`，不阻断导入。
- `csl-styles.js` 是 3 份手写的内置 CSL 样式（Vancouver / Nature / Harvard–Cite Them Right），由 `cite.js` 在加载时注册；`csl:` 前缀是界面 / 存储里的唯一标识（注册表内部 key 不带前缀）。
- `bib.js` 负责**一批**：`isNumericStyle()` 决定是否编号与默认排序；CSL 样式若带 `<sort>`，由 `cslSort()` 交给引擎，否则退回「编号制保持传入顺序 / 作者-年份制按姓氏」；同作者同年补 a / b，编号制重新编号，最后按 `format` 包装成 **Markdown / 纯文本 / HTML / Word / RTF**——五种格式共用同一份「正文 + 引用键 + 排序」结果，只有外衣不同，且 `format` 优先于老的 `markdown: true`。HTML / Word 走 `<ol>`（编号制）或 `<ul>`（作者-年份制），正文里的 `& < >` 转义；Word 那份是套了 `<meta charset>` 与基础排版的最小 HTML 外壳、存成 `.doc`，Word 打开即带编号与缩进。RTF 走另一套转义：`\ { }` 反斜杠转义、非 ASCII 一律写 `\uN?`（N 为 UTF-16 码元的有符号十进制，代理对拆成两个 `\u`），编号条目用 `\fi-360\li360` + `\tab` 排成悬挂缩进。CSL 样式自己输出 `citation-number`，`bib.js` 不再套 `[n]`。
- **用户样式数据流**：`main.js` 的 `csl-styles` 扫描 `<数据目录>/styles/*.csl` → 用 `Csl.parseStyle` 校验（坏文件跳过）→ preload 暴露 `lib.cslStyles()` → `library-ui.js` 启动 / 切换数据目录时调用 `Cite.registerCslStyles()` → `Csl.setUserStyles()` 先清旧用户样式再整批注册 → 重建两个下拉。导入走 `csl-import`：系统文件对话框 → 校验 → 复制到 `styles/<id>.csl` → 返回全量列表，界面直接选中新样式。
- **删除**：`csl-remove` 按 id 删 `styles/<id>.csl`；参考文献弹层的「管理样式」面板列出已导入的样式并逐个删除，删完以主进程重扫的结果为准（界面不自己维护列表），删掉正在使用的样式会退回 GB/T。
- citekey 由渲染层传入整库分配的 Map，避免只选部分条目时出现不同的 `-2` 后缀。
- 保存走通用 `save-text` IPC：渲染层拼好文本，主进程只弹系统对话框 + 原子写，不再读一遍库。

## 格式转换的安全边界

`docconvert.js` 把 Office / EPUB / Markdown 转成 HTML 后统一过 `sanitize-html`：

- 允许的标签与属性是白名单；`script`、事件属性、`javascript:` 链接、`iframe` / `object` / `embed` 全部剥离；
- 图片只允许 `data:`（本地图片会先读成 data URL 内联），远程图片丢弃；
- 上限：400 页、12 MB HTML、单页 4 MB 文本、单张图片 8 MB、表格 2000 × 80；
- 旧 `.doc` 用 `word-extractor` 取纯文本，旧 `.ppt` 直接提示另存为 `.pptx`。

新增格式时不要绕过 `clean()`，也不要把远程资源放进来。

## 笔记与 Markdown 编辑器

- **存储**：笔记正文存 `notes[].text`（Markdown 源码），`notes[].html` 置空；条目详情里的内联富文本编辑只针对文献条目的笔记。
- **编辑器**：独立的 `#note-view` 全屏视图（占满阅读区），顶栏 + 工具栏 + 左源码 / 右实时预览双栏，预览防抖 350ms 跟随。工具栏的每个按钮对应一个 Markdown 语法片段，插入到光标处。
- **`markdown.js`（UMD，零依赖）**：先转义再拼标签，所以 HTML 注入一律当文本。支持标题 / 粗斜体 / 删除线 / 代码 / 引用 / 列表 / 表格（对齐 + `\|` 转义）/ 链接 / 图片，外加 `:::提示框`、`:::` 推导容器、引用卡、`++下划线++`、`!!剧透!!`、`==彩虹==`、拼音注音、`[^1]` 脚注、任务列表、`::github{}` / `::music{}` 卡片。
- **`javascript:` 链接降级**成纯文本；外链点击经 `open-external`（只放行 http/https/mailto）用系统浏览器打开；本地图片走 IPC 读 dataURL，渲染层不碰 `file://`。
- **`fromHtml()`**：旧的富文本笔记第一次打开时自动转成 Markdown，不丢内容。
- **公式仍是等宽源码**（`$…$` / `$$…$$`）：项目没有数学排版引擎，预览面板会明说，不假装支持。
- **笔记模板（v33）**：顶栏「模板…」下拉三种（课程笔记 / 论文卡片 / 摘录汇总），全是现有 Markdown 语法的字符串常量（`NOTE_TEMPLATES`），空笔记铺开、有内容追加；摘录出处行与摘录 / 批注的 `—— 作者：《标题》，年份` 格式一致。
- **自包含导出（v33，`export-note-bundle` IPC）**：先落盘再导出；`snapshots/` 图片复制到导出文件旁 `<文件名>.files/`（同名避让），Markdown 引用改写成相对路径；HTML 由 `Md.render` 出正文后把本地图片的 `data-md-img` 占位换成真实 `src`（改写后的路径以 `.files/` 前缀判定），缺失图片输出可见的「[图片缺失：…]」并计数返回。`outPath` 参数旁路保存对话框，测试用。
- **`richtext.js`（UMD）**：HTML 白名单清洗（删 script/style/iframe、去 on* 事件与 `javascript:` 链接、未知标签只留文字）+ 纯文本提取。**落库前和渲染前都过一遍**。
- **保存时序**：`closeNoteEditor` 先 `await` 落库再刷新列表，否则卡片摘要会显示旧内容。

## 抓 PDF 全文（fetchpdf.js）

`fetchpdf.js` 是纯 Node 模块，主进程里跑：

- **来源顺序**：arXiv → Unpaywall → 条目里的直链 / doi.org，第一个拿到真 PDF 的就挂到条目上。
  - arXiv：支持新式 id（`2401.12345v2`）、老式 id（`hep-th/9901001`）、abs/pdf 链接、裸 id；
  - Unpaywall：需要设置里填联系邮箱（它的礼貌要求），不填就跳过这一步；
  - doi.org：跟随到出版商页面，**不是 PDF 就明确报错，不会把网页存下来**。
- **下载稳健性**：只走 http/https；重定向最多 5 次；超时 40s；单文件上限 80MB；先写 `.part` 再改名（失败不留半截文件）；**校验前 5 字节必须是 `%PDF-`**——网页冒充 PDF、付费墙登录页都会被挡住。
- **网络错误走返回值不抛出**，失败时返回每个来源的尝试记录（`tried`）便于排查。
- 落到 `<数据目录>/attachments/<条目 key>.pdf`，成功后 `setAttachment` 挂到条目。
- **批量抓取**（`lib-fetch-pdf-batch`）：按选中的 key 依次跑 `fetchToFile`，每处理完一条 `send('lib-fetch-pdf-progress')` 回传 `{done,total,fetched,failed,skipped}`；回收站 / 已有附件（不覆盖）/ 没有来源的条目只计数不下载；`lib-fetch-pdf-batch-cancel` 置模块级标志，当前这条结束后停。
- **网页快照**（`lib-snapshot`）：隐藏 `BrowserWindow`（独立内存分区、`sandbox`、拒绝权限请求与 `window.open`）打开条目 URL，再用 DevTools 协议 `Page.captureSnapshot` 存**单文件 MHTML**，`capturePage()` 另存首屏 PNG。
  - Electron 31 的 `webContents.savePage` 在隐藏窗口里三种格式都会静默返回 false，**不要用它**；失败再退回 `document.documentElement.outerHTML`。
  - 文件落在 `<数据目录>/snapshots/<key>.mhtml` + `.png`，索引里只存引用（`snapshot` 字段走 `library.setSnapshot`，不在 `updateItem` 白名单里）。
  - 条目永久删除 / 清空回收站时清掉快照文件；用户的 PDF 仍然一个不动。

## 标签页、会话与单实例

- 标签页活在当前进程里，同一路径再次打开会切到已有标签，不新开。
- **会话恢复（v33，`settings.restoreTabs`）**：标签清单（路径 / 类型 / 条目 / 页码，不含文档字节）由渲染层在标签变动、翻页（去抖 600ms）和 `pagehide` 时经 `session-save` 写入 `<userData>/session.json`（上限 20 条、按路径去重）。主进程在 `did-finish-load` 且**无命令行文件**、设置开启、会话非空时推送 `session-restore`；渲染层逐个用 `open-doc-path`（与库内打开同链路、含引用信息、不写「最近打开」）取回并打开，最多 8 个，失联文件跳过，最后切回记录的激活标签。页码恢复以库 / 最近打开里记的为准，会话快照只是兜底。冒烟 / 探针模式不恢复，保持测试路径单一。
- 切换标签不销毁 PDF 文档；关闭标签只释放渲染资源，不删 PDF、不删标注文件。
- **阅读导航历史（v33）**：显式跳转（目录 / 搜索命中 / 批注 / 页码输入 / 缩略图 / Home/End）经 `scrollToPage(n, instant, record)` 的第三参入栈，栈挂在标签页对象 `t.nav` 上（上限 60）；`Alt+←/→` 与鼠标侧键（button 3/4）后退前进；纯滚动漂移在后退时补记；初始落页与逐页翻阅不入栈。库覆盖层打开时快捷键不响应。
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
