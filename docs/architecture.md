# 架构与数据约定

本文描述当前源码。应用版本为 1.4.0，库格式为 v8；二者独立演进。历史修复过程见 [CHANGELOG](../CHANGELOG.md)，使用说明见 [README](../README.md)。

## 进程与模块

Trove 使用 Electron 31、原生 JavaScript 和本地 JSON。没有前端框架或数据库；业务模块不依赖 node-gyp 扩展。

| 层 | 主要职责与入口 |
| --- | --- |
| 主进程 | `main.js` 管窗口、文件、IPC、转换、备份恢复、目录迁移和索引调度 |
| 数据模块 | `library.js`、`settings.js`、`atomic-file.js`、`data-resources.js` |
| 内容模块 | `docconvert.js`、`fulltext.js`、`query.js`、`formats.js` |
| 引用与抓取 | `creators.js`、`cite.js`、`bib.js`、`csl.js`、`csl-styles.js`、`metadata.js`、`fetchpdf.js` |
| 智能跳转与统计 | `smartjump.js`（引用标记/条目匹配纯逻辑）、`libstats.js`（库统计纯逻辑）、`feedparse.js`（RSS/Atom 解析纯逻辑）、`readingstats.js`（阅读时长纯逻辑） |
| preload | `preload.js` 经 contextBridge 暴露 `window.pdfBridge` |
| 阅读界面 | `renderer/renderer.js` 管 PDF/富文档、标签、页码、搜索、缩放、视图旋转、分屏参考视图、双页对开、智能跳转、朗读、会话与导出；`renderer/math.js`（TroveMath）负责笔记公式 KaTeX 增强 |
| 文献库界面 | `renderer/library-ui.js` 管列表、详情、批量操作、设置及独立笔记编辑器 |
| 标注与图片 | `annotations.js`、`native-annos.js`、`selection.js`、`pdfimages.js`、`lightbox.js` |

`query.js`、`markdown.js`、`richtext.js`、姓名和引用模块部分采用 UMD，在 Node 与页面共用。跨脚本 API 显式挂载到 window，不能假定顶层 const 自动成为 window 属性。

窗口启用 context isolation，关闭 Node integration。页面不直接读取 fs，磁盘操作经 preload/IPC 交给主进程。富文档转换与富文本分别使用对应的清洗链路。

## 存储位置

`USER_DATA` 来自 Electron userData；`currentDataDir()` 依次采用测试环境覆盖、用户设置或 userData。默认两者均位于 `%APPDATA%\trove`。

| 文件或目录 | 所属位置 | 说明 |
| --- | --- | --- |
| `library.json` | 数据目录 | v8 文献库、收藏集、标签、搜索条件和标注对象元数据 |
| `fulltext/` | 数据目录 | 路径哈希索引，可重建 |
| `snapshots/` | 数据目录 | 标注截图、图片标注和网页快照资源 |
| `styles/`、`attachments/` | 数据目录 | 自定义 CSL、托管附件 |
| `backups/` | 数据目录 | 迁移、恢复等操作的快照 |
| `annotations/` | userData | 文档标注，文件名采用路径 SHA-1 前 20 位 |
| `settings.json` | userData | 白名单设置，含 dataDir、restoreTabs、viewMode、splitView 等 |
| `window-state.json` | userData | 窗口、最后使用目录和最多 8 条最近打开记录 |
| `session.json` | userData | 最多 20 个文档标签、页码、视图旋转角与参考页、激活路径 |
| `reading-stats.json` | userData | 阅读时长（天 × 文档路径 → 秒），统计面板热力图数据，可整文件删除 |

改变数据目录不会将所有 userData 状态文件搬到同一目录。测试与备份程序必须明确区分这两个根目录。

## 文献库与标注模型

库包含 `items`、`collections`、`searches`、`tagColors`、`annoMeta`、`feeds`（RSS 订阅，v8 可选附加键，旧文件自动补默认），并兼容旧版 `annoTags`。数据目录合并（`combineStores`）把订阅也算进合并契约：按 URL 去重、当前库优先、同 ID 不同 URL 时给导入方换新 ID，同 URL 时取更可读的标题与更早的 addedAt——早先只合并集合 / 搜索 / 标签 / 条目，合并后订阅会静默消失。

条目使用稳定 key，记录 itemType、title、结构化 creators、year、publication、DOI/URL、fields、tags、collectionIds、relations、notes、attachment、page 及时间戳；`pageTotal`（阅读器上报的总页数）可选，与 page 一起支撑列表阅读进度条与「继续阅读」。作者记录 firstName、lastName、creatorType；中文姓名与机构不按西文规则强拆。

笔记记录 id、title、text、html、image、annoIds 与时间戳。独立 Markdown 笔记以 text 为正文、html 为空；富文本子笔记以清洗后的 html 为正文，text 是检索用纯文本。不能用富文本的 text 替代导出正文。

标注分为三个相关层次：

- `annotations/<hash>.json`：路径、保存时间及各页 shapes，存坐标、颜色、文字与稳定 id。
- `library.annoMeta[id]`：文字、评论、标签、所属条目与生成笔记等对象元数据。
- `items[].annoIds`：与对象所属条目形成双向关联。

PDF 标注使用 scale=1 的页面坐标，左上原点、y 向下，SVG viewBox 固定。富文档标注使用页面 CSS 像素并跟随 CSS zoom。两种坐标约定不能混用。

视图旋转（0/90/180/270）不改这套坐标：每页的 `.page` 是旋转后的布局槽，`.page-rot` 承载未旋转的画布、文本层、高亮层和两个标注层，靠 CSS transform 整体旋转。因此标注、选区、搜索命中、图片位置都继续按未旋转坐标存；客户端坐标与页面坐标的换算统一走标注 SVG 的 `getScreenCTM()` 逆矩阵，旋转与缩放一起生效。旋转只对 PDF 生效，打印与带标注副本导出仍按原文件方向。

库写操作支持最多 20 步撤销/重做；连续笔记编辑不加入库快照栈。删除只改索引，不删除原始文档。读取旧版库时先备份再迁移，损坏文件留证后回退。

## 保存、迁移与恢复

`atomic-file.js` 在同目录写临时文件并替换，失败不直接覆盖旧文件。库写入失败回滚缓存，设置在落盘成功后确认。阅读器标注保存失败会提示并阻止相关关闭/切换操作；笔记导出必须等待保存成功。

`data-resources.js` 管理 snapshots/styles/attachments 的打包、路径验证与文件事务。迁移、恢复先暂存再提交，捕获错误后回滚；回滚失败时保留恢复材料并报告。该设计不是跨文件断电事务。

数据目录支持 move/merge/replace，移动后保留旧文件；同 key 合并保留目标条目。资源同名不同内容时避让，并改写库中引用。重新定位附件合并旧/新路径标注，同 id 内容冲突则中止，旧副本保留。

JSON 备份保持 format 1 兼容性，包含库、设置、标注，以及 resources/sourceDataDir；兼容旧 images 字段。受管资源原始字节合计最多 60 MB，超限报错。外部文档与全文索引不在 JSON 备份内。恢复前保存快照。

旧应用改名迁移由 `usermigrate.js` 在单实例锁前执行：只补缺、不覆盖、不删除源目录；失败可回退。隔离测试不得导入真实用户旧数据。

## 打开、渲染与会话

打开链路为主进程读取路径 → PDF 字节或富文档 pages → preload → openDocument → loadPdf/loadRichDoc。PDF 不经过富文档转换；PDF.js 会转移传入 buffer，所以渲染使用副本，导出保留原字节。

连续模式分别用两个 IntersectionObserver 管预渲染和当前页；不能合并。单页模式由显式跳页控制显示、渲染与释放。离开预渲染区释放 PDF 位图；缩放重新渲染并保持阅读位置。Z 放大模式按鼠标指向的页内位置计算锚点。

标签保存文档字节/转换页、路径、类型和页码。恢复时暂停会话写入，先建立标签对象，只加载激活项，其余切换时按需加载，避免未完成加载覆盖后台页码。恢复跳过失联文件；命令行文件与启动恢复由主进程协调。

导航历史挂在标签对象，显式跳转入栈，普通翻阅不逐页记栈；后退时可补记滚动漂移位置，最多 60 条。

分屏参考视图与主视图共用同一个 `PDFDocumentProxy`，但独立渲染到只读 canvas，不挂标注层和文本层，因此不参与标注、选区与事件。参考页有自己的页码与「跟随正文下一页」开关；视图旋转直接烘进参考页 viewport。分屏偏好存设置，参考页存标签与会话。

阅读方式有三种：连续滚动（scroll，观察器管渲染）、单页翻页（page）与双页对开（spread）。page/spread 不走观察器：可见页由 `applyPageVisibility` 的 `.is-current` 标记，渲染/释放在 `scrollToPage` 里显式做；spread 显示 `spreadPair(cur)` 的搭档页（封面独占、偶左奇右、落单不补位），对开下「适应宽度」按半幅宽算。富文档无对开，按单页处理——`effectiveViewMode()` 把「用户偏好」（`App.state.viewMode`）和「当前文档的有效模式」分开：富文档的 spread 一律按 page 执行，布局 class、可见性、观察器与导航都读有效模式，切回 PDF 自动恢复对开偏好。设置白名单放行 `spread`。换页时 `freePagesExcept(targets)` 只保留当前页组（对开是两页）的位图，其余页一律释放；从连续模式切入 page/spread 也会清掉散落的位图。回收范围包括**正在渲染**的页（`activeRenders`）：快速跳页时上一组的任务还没结束，`rendered` 仍是 false，但画布已经分配。`renderPageNum` 的回写要同时校验任务身份（`el._task === task`）与文档代际，过期任务不得把离屏页重新标成已渲染，否则会留下没有位图的「已渲染」页。

智能跳转（点引用标记 ↔ 参考文献条目）的识别与行匹配在 `smartjump.js`（Node 可测）；渲染层把文本项按 y 聚行、定位点击字符，跳转走 `scrollToPage(record)` 记入导航历史，落点高亮画在独立 `.sj-layer`。只在默认选择工具的单次单击触发。行缓存按页存（`sj.byPage`），用时按页号拼成整篇行序——用户可能先跳着点某一页，缓存顺序不等于文档顺序，定位一律用「页号 + 行对象」换算下标，不用裸下标。既不是引用标记、也不像参考文献条目的行直接返回，不扫全文。

朗读按句驱动：把文本项拼成一条字符串并记录「字符 → item / item 内偏移」，断句后按 span 建 DOM Range 回算真实文字框。一次只提交一句给 Web Speech，句间才有稳定的位置锚点；读完当前页再取下一页，无文字页跳过。句级高亮画在独立 `.speech-layer`，与搜索高亮互不清除；朗读中 `H` / `U` 用同一组句框写入普通标注。位置按文档路径存本机 `localStorage`，不写库结构。`App._setSpeechDriver()` 允许测试替换语音驱动，避免依赖系统语音引擎。

PDF 原生批注通过 PDF.js 读取，按 viewport 处理旋转与 CropBox，转换到本地 shapes，按 nativeId 去重；回复批注（/IRT）把父批注 id 记成 shape.replyTo（与 nativeId 同一套 ref 格式），列表层显示「↳ 回复」标记，不重排嵌套树。扫描捕获 PDF 实例、路径、标注容器，等待后检查归属，文档切换则取消。扁平化批注无法恢复，部分形状不支持。用户书签（B 键）也存这个 sidecar（bookmarks 字段）：anno-save 会保留已有书签、bookmarks-save 不碰标注页，两者共存。书签保存按「文档路径 + 加载代际 `loadSeq`」归属，同一路径的操作走一条**串行队列**（`bookmarkQueues`，key 是文件路径）：每次基于上一次「已成功落盘」的工作副本构造候选，成功后提交工作副本、失败只把界面回滚到工作副本。队列**跨加载代际共享**——重新打开同一份文档沿用同一条链，只把工作副本换成新读到的磁盘内容，否则新旧两条队列会并行覆盖 sidecar。任务在发 IPC **之前**再校验一次路径与代际：切走 / 关闭 / 重新打开后，尚未发送的旧任务直接取消（返回 `canceled`），不再写盘；落盘成功即使代际已过期也推进工作副本（磁盘真相），界面更新则只按代际过滤。首次操作会等这一份文档的书签读盘完成，避免用空数组覆盖磁盘。`restoreAnnos` 同样按路径与代际校验，避免切文档期间把旧数据读进新文档。

## 笔记转换与导出

详情面板兼容旧 Markdown 子笔记：渲染为富文本后，应用内部链接的实际 URL 可能存在 data-md-link，href 只是占位或被清洗为 #。

转换约定：

1. Markdown 渲染只对 URL 属性编码一次，查询参数不能变成 amp;b。
2. HTML→Markdown 优先解析 data-md-link，再读取 href，解码后执行协议白名单校验。
3. 富文本导出使用 html 转换后的正文；Markdown 正文直接使用 text。
4. 收集正文图片与 note.image，复制到导出旁的安全资源目录并改写引用，同图不重复插入。
5. 独立 HTML 把应用内链接改为真实 href，把本地图片占位改为 src；缺失图片生成可见说明，UI 显示缺失数量。
6. HTML 与 Markdown 都依赖旁边的图片目录；没有把本地资源全部内联到单文件。

转换会简化部分富文本排版；复杂表格、嵌套样式与粘贴内容不能按“无损往返”承诺。

笔记公式：markdown.js 把 `$…$` / `$$…$$` 输出成带 `data-md-math` 的等宽占位；渲染进程 TroveMath 在有 KaTeX（`renderer/katex/`，由 copy-pdfjs 拷贝）时换成真排版，缺失时保留源码。导出 HTML 在主进程用同一引擎渲染，css + woff2 字体带进 `.files/katex/`。富文本子笔记不渲染公式。独立笔记 `[[标题]]` 双向链接：占位由编辑器委托按标题精确匹配跳转，反链在渲染预览时现扫独立笔记正文。

## 搜索、列表与引用

全文索引按路径 SHA-1 前 24 位保存。新鲜度比较 mtime/size；读索引缓存还检查 ctime，缓存原始文件大小预算为 32 MB。索引抽取有长度限制，扫描件不会自动 OCR。

统一查询解析由 query.js 负责。主进程合并全文、标注和笔记，执行字段上下文过滤、去重和评分，返回 total/counts/offset/limit。默认每页 120，最多 500。饱和首页会保留各来源最佳结果，用固定置换避免分页丢失或重复。

UI 首次展示 20 条，再展开和续拉；类型筛选在结果面板进行。库列表超过阈值后按 80 行分块挂载，选择按 key 维护。分页并没有把整个查询迁到后台，主进程搜索与全量 summary 广播仍是后续优化项。

库列表的快速筛选直接复用同一套查询语法（`Query.matchLibraryItem`），因此传入前**不能**先 `toLowerCase()`：`OR` / `AND` 是大小写敏感运算符，提前转小写会让 `title:a OR title:b` 退化成三个普通词；词本身由 `Query.fold` 折叠，大小写不影响匹配。可视化条件构建器（`buildQuery` / `parseQueryToRows`）只在「AND + 字段限定 + 排除 + 短语」子集内做无损往返：隐式 AND 拆成多行、字段别名归一到 UI 字段名、短语内的双引号用 `""` 转义；含 OR / 括号 / 未闭合引号的查询整串保留为 `raw` 行，应用时原样返回，不重新拼装。

收藏集侧栏支持 `Ctrl` / `Cmd` 多选：`scope` 为 `colls` 时按 `ids` 取并集，普通点击折叠为 `coll`，取消最后一个退回 `all`。并集只影响条目过滤，每个收藏集自己的计数仍按直接归属统计；删除集合会自动从 `ids` 移除并收窄范围。并集与搜索、标签、排序、批量选择共用同一条 `visibleItems` 链路。

引用格式化、citekey 与参考文献表由 Cite/Creators/Bib/CSL 协作。CSL 仅实现参考文献表常用子集；自定义样式存在 styles/。Word .doc 导出是 HTML 包装，RTF 为独立格式。文内引注由 `Cite.citeInText(it, { style, num, locator })` 生成：编号制定位符进方括号，作者-年份制进圆括号，不做同上 / 前引与作者消歧。

库统计（`libstats.js`）区分两种年份口径：`byYear` 按条目 `year`（出版年份）分桶，`byCreated` 按 `created` 的本地年份（入库年份）分桶，面板上分列「出版年份」「入库年份」。老文献今天导入时前者落「更早」、后者落今年——不能只用一个年份却挂「添加年份」的标题。

## 格式与联网边界

docconvert 将支持格式转成受限 HTML，限制页数、总 HTML、单图及表格尺寸，清理不允许的脚本和资源。metadata/fetchpdf 在用户操作时联网；下载校验类型、大小与 PDF 内容，成功后安排索引。网页快照生成 MHTML/PNG，应用内不提供完整网页浏览器。RSS 订阅同样按需联网：feedparse.js 解析（纯逻辑），主进程用 Node 原生 http/https 拉取（不走 Chromium 网络栈，规避系统代理；重定向、20 秒超时、4MB 上限），条目经 lib-add-item 落成 webpage 条目。 阅读时长统计：readingstats.js 纯逻辑（心跳累加 / 合并 / 聚合，Node 可测），渲染层每 15 秒记一次心跳（库覆盖层、窗口隐藏、无文档时不计），增量与 userData/reading-stats.json 合并落盘，不进 library.json。

题录导入的字段取值要按 XML 文本内容处理：EndNote 会把一段文字包进 `<style face="…">` / `<i>` 之类内联标签，直接正则抓标签对会把标签当正文写进标题和作者。formats.js 的做法是先剥内联标签、再把其余标签当空白，最后解实体（顺序不能反，否则 `&lt;` 会被误剥）；CDATA 段原样保留。字段可能由「普通文本 + CDATA + 普通文本」多段拼成，各段必须原样拼接、最后对整段做一次空白规范化——逐段 trim 会把 `Before <![CDATA[Middle]]> After` 粘成 `BeforeMiddleAfter`，而简单在段间插空格又会把 `pre<![CDATA[fix]]>` 变成 `pre fix`。XML 属性单双引号都要认（`ref-type name='Book Section'`），Book Section 映射到项目自己的 `bookSection` 类型。feedparse 的 Atom 链接同理：`href` / `rel` 支持单双引号，标签允许命名空间前缀（`atom:link`，解析前统一剥前缀；RSS 不剥，避免把自闭合的 `<atom:link>` 当成正文链接）。

单实例锁在正常运行时启用，探针/冒烟按测试模式隔离；单实例回归使用自己的 userData，但仍必须保留锁逻辑。
