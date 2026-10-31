# 架构与数据约定

本文描述当前源码。应用版本为 1.6.0，库格式为 v8；二者独立演进。版本变化见 [CHANGELOG](../CHANGELOG.md)，使用说明见 [README](../README.md)。

## 进程与模块

Trove 使用 Electron 31、原生 JavaScript 和本地 JSON。没有前端框架或数据库；业务模块不依赖 node-gyp 扩展。

| 层 | 主要职责与入口 |
| --- | --- |
| 主进程 | `main.js` 管窗口、文件、IPC、转换、备份恢复、目录迁移和索引调度 |
| 数据模块 | `library.js`、`settings.js`、`atomic-file.js`、`data-resources.js` |
| 内容模块 | `docconvert.js`、`fulltext.js`、`query.js`、`formats.js` |
| 引用与抓取 | `creators.js`、`cite.js`、`bib.js`、`csl.js`、`csl-styles.js`、`metadata.js`、`fetchpdf.js`、`pdfwrite.js`（题录写回 PDF 副本的 Info + XMP） |
| 导入识别与附件定位 | `doiscan.js`（首页文本抽 DOI / arXiv 纯逻辑）、`fingerprint.js`（文件指纹、目录遍历与匹配纯逻辑）、`refattach.js`（EndNote `internal-pdf://` → 真实路径的候选与探测） |
| 写作输出 | `review.js`（批注 → 综述草稿，分组 / 编号 / 截断纯逻辑） |
| 阅读增强（v36） | `reflow.js`（按坐标把行拼成段落、去断词、切栏的纯逻辑）、`portal.js`（参考文献条目 → 库里哪一条 + 起始页，纯逻辑）、`similar.js`（词袋 tf-idf 与余弦，纯逻辑） |
| 标注导出字体 | `pdftext.js`（探测系统 CJK 字体、fontkit 子集嵌入、字形覆盖与度量） |
| 参考文献表导入 | `refimport.js`（切条 / 字段抽取 / 置信度 / 查重的纯逻辑） |
| 智能跳转与统计 | `smartjump.js`（引用标记/条目匹配纯逻辑）、`libstats.js`（库统计纯逻辑）、`feedparse.js`（RSS/Atom 解析纯逻辑）、`readingstats.js`（阅读时长纯逻辑） |
| preload | `preload.js` 经 contextBridge 暴露 `window.pdfBridge` |
| 阅读界面 | `renderer/renderer.js` 管 PDF/富文档、标签、页码、搜索、缩放、视图旋转、分屏参考视图、双页对开、智能跳转、朗读、会话与导出；`renderer/math.js`（TroveMath）负责笔记公式 KaTeX 增强 |
| 文献库界面 | `renderer/library-ui.js` 管列表、详情、批量操作、设置及独立笔记编辑器 |
| 使用指南 | `renderer/help.js` 管目录 / 正文 / 搜索 / 「在界面定位」/ 直达功能；`help-content.js` 是纯数据（UMD，Node 里也能 require），`scripts/check-help.js` 拿它和 `index.html` 对账 |
| 标注与图片 | `annotations.js`、`native-annos.js`、`selection.js`、`pdfimages.js`、`lightbox.js` |

`query.js`、`markdown.js`、`richtext.js`、`reflow.js`、`portal.js`、`similar.js`、`advsearch.js`、`help-content.js` 与姓名、引用模块部分采用 UMD，在 Node 与页面共用。**新写的模块只要在 Node 里 require、又在页面里 `<script>` 引用，就必须是 UMD**：CommonJS 的 `module is not defined` 会让整份文件不执行，单测全绿、一进 Electron 就报「X is not defined」。跨脚本 API 显式挂载到 window，不能假定顶层 const 自动成为 window 属性。

使用指南刻意拆成「数据 + 渲染」两层：文案全在 `help-content.js`（纯数据、无 DOM），`renderer/help.js` 只负责排版、搜索与跳转。这样 `scripts/check-help.js` 才能在 Node 里直接 require 文案，和 `index.html` 的控件 id 做覆盖度对账——界面加了按钮却没人写说明时，脚本会失败，而不是等用户发现「这按钮是干嘛的」。

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

2026-10-29 新增三个可选字段，都是 v8 的附加键，旧版本读到忽略、旧库读到补默认：

- `item.readStatus`：`''` / `todo` / `reading` / `done`。与 `page` 相互独立——进度是「读到哪」，状态是「打算怎么办」。打开待读条目时主进程把它转成 `reading`。
- `item.attachment.fingerprint`：`{ size, hash }`，大小 + 首尾 64 KB 的 SHA-1。文件丢了以后无法再算指纹，所以必须在导入 / 重新定位 / 首次成功打开时写入。
- 库级 `noteAliases`：`{ [笔记 key]: [旧标题] }`。笔记改名时记录旧标题（最多 12 个），`[[旧标题]]` 仍能解析到这条笔记；现标题优先，改回旧标题时从别名里摘掉。

笔记记录 id、title、text、html、image、annoIds 与时间戳。独立 Markdown 笔记以 text 为正文、html 为空；富文本子笔记以清洗后的 html 为正文，text 是检索用纯文本。不能用富文本的 text 替代导出正文。

笔记另有可选 `meta: { tags: [], status: '' | 'draft' | 'final' }`（v1.6）。**它不进 `item.tags`**：一条文献下可能挂好几条笔记，各条笔记的标签与「写完没」是两回事，混进文献标签云会把左侧标签区污染成笔记词表。`normalizeNoteMeta()` 是读写两侧共用的唯一入口（标签去空白、截 40 字、最多 20 个，未知状态归空）；`addNote` / `updateNote` 写入，`publicItem` 读出时补默认——**三处少一处就会变成「存得进、界面读不回」**，这是 `notes[].imageW` 踩过的同一个坑，回归从 `summary()` 读回来验。

标注分为三个相关层次：

- `annotations/<hash>.json`：路径、保存时间及各页 shapes，存坐标、颜色、文字与稳定 id。
- `library.annoMeta[id]`：文字、评论、标签、所属条目与生成笔记等对象元数据。
- `items[].annoIds`：与对象所属条目形成双向关联。

标注恢复任务按文档路径和加载代次绑定，并记录等待完成的 promise。状态为 `unknown` 时，保存、归档和离开文档要先等待恢复；只有 `ok` 或 `missing` 才允许写入。实际写入失败会取消文档切换或标签关闭，保留当前内存标注供重试。已确认 `broken` 的文件禁止自动覆盖，离开时明确提示未保存；显式重建先备份原文件，再写入。`.broken-<时间戳>.json` 是恢复备份，不参与活动标注、回顾等扫描。

PDF 标注使用 scale=1 的页面坐标，左上原点、y 向下，SVG viewBox 固定。富文档标注使用页面 CSS 像素并跟随 CSS zoom。两种坐标约定不能混用。

视图旋转（0/90/180/270）不改这套坐标：每页的 `.page` 是旋转后的布局槽，`.page-rot` 承载未旋转的画布、文本层、高亮层和两个标注层，靠 CSS transform 整体旋转。因此标注、选区、搜索命中、图片位置都继续按未旋转坐标存；客户端坐标与页面坐标的换算统一走标注 SVG 的 `getScreenCTM()` 逆矩阵，旋转与缩放一起生效。旋转只对 PDF 生效，打印与带标注副本导出仍按原文件方向。

### 回顾（间隔重复）

复习进度不进 `library.json`：它是一张「标注 id → 下次到期时间」的表，独立放在 `<userData>/recall.json`（`src/recall.js`）。键取标注稳定 id，所以改文字、改颜色、加标签、换标签都不影响复习记录；标注被删除时由 `prune(validIds)` 清掉对应卡片——只有拿到非空 id 集合才动手，读不到标注文件时保留原进度，避免一次 IO 失败把几个月的复习记录清空。

卡片还有可选的 `depth`（0–3，v1.6）：大纲里的缩进层级。**它只影响大纲这张表**，不参与调度、不改变复习顺序，所以 `outline()` 与 `dueList()` 是两条互不相干的读法——前者按 `addedAt` 排全部卡片（回顾的顺序是「你想怎么想」，不是「文献怎么排版」），后者按到期时间升序取前 30 张。`setDepth()` 与评分走同一条 `persist()`：写盘失败回滚内存并如实报错，不假装成功。`recall-outline` 刻意不调用 `prune`——只是打开看了一眼，不该动磁盘上的复习进度。

调度是可预测的 SM-2 骨架，纯函数 `schedule(card, rating, now)`：评分 1/2/3/4 映射到 q=2/3/4/5，`EF' = EF + (0.1 - (5-q)(0.08 + (5-q)·0.02))`（下限 1.3）；q<3 时连击清零、间隔归零、10 分钟后再到期；首次答对 1 天、太简单 3 天，之后模糊 ×1.2、记得 ×EF、太简单 ×EF×1.3，间隔上限 3650 天。刻意不用 FSRS：它要按复习历史拟合记忆稳定性，本地没有足够历史，用户要的只是「今天该看哪几条」。

主进程只做三件事：把到期列表算好（`recall-state`，顺带 prune）、写回评分、整份导入导出。标注正文不重复读盘——渲染层已经把 `anno-list` 的结果放在内存里，面板按 id 拼接。备份 payload 增加 `recall` 段，恢复时整份替换：复习进度是状态而不是条目，合并两份只会得到互相矛盾的到期时间；老备份没有这个字段时不动现有进度。

库写操作支持最多 20 步撤销/重做；连续笔记编辑不加入库快照栈。删除只改索引，不删除原始文档。读取旧版库时先备份再迁移，损坏文件留证后回退。

## 保存、迁移与恢复

`atomic-file.js` 在同目录写临时文件并替换，失败不直接覆盖旧文件。库写入失败回滚缓存，设置在落盘成功后确认。阅读器标注保存失败会提示并阻止相关关闭/切换操作；笔记导出必须等待保存成功。

`data-resources.js` 管理 snapshots/styles/attachments 的打包、路径验证与文件事务。迁移、恢复先暂存再提交，捕获错误后回滚；回滚失败时保留恢复材料并报告。该设计不是跨文件断电事务。

数据目录支持 move/merge/replace，移动后保留旧文件；同 key 合并保留目标条目。资源同名不同内容时避让，并改写库中引用。重新定位附件合并旧/新路径标注，同 id 内容冲突则中止，旧副本保留。

JSON 备份保持 format 1 兼容性，包含库、设置、标注、回顾进度（`recall`，可选），以及 resources/sourceDataDir；兼容旧 images 字段。受管资源原始字节合计最多 60 MB，超限报错。外部文档与全文索引不在 JSON 备份内。恢复前保存快照。

旧应用改名迁移由 `usermigrate.js` 在单实例锁前执行：只补缺、不覆盖、不删除源目录；失败可回退。隔离测试不得导入真实用户旧数据。

## 打开、渲染与会话

打开链路为主进程读取路径 → PDF 字节或富文档 pages → preload → openDocument → loadPdf/loadRichDoc。PDF 不经过富文档转换；PDF.js 会转移传入 buffer，所以渲染使用副本，导出保留原字节。

`loadPdf` 是长异步流程（解析 → 销毁旧文档 → 建页块 → 首屏定位），每一步 `await` 都可能让另一次加载插进来，所以它按**加载代际** `loadSeq` 归属：进入时 `++loadSeq` 记下自己的 `my`，任何一次 `await` 恢复后只要 `my !== loadSeq` 就作废自己。要特别注意的是**销毁等待**——`pdfDoc.destroy()` / `refDoc.destroy()` 都返回 Promise，期间更新的文档可以完整加载完成，因此：①进销毁前先把要销毁的旧实例抓在手里（`prevPdf` / `prevRef`），恢复后不再从 `s.pdfDoc` / `s.refDoc` 读（那里可能已经换成别人的文档）；②每次销毁等待结束、改写任何共享状态之前都要重新校验代际，过期调用销毁自己新解析的 PDF 后退出；③`buildPageBlocks` 逐页 `getPage` 也是 `await`，它接受代际参数并在过期时返回 `false`，避免旧文档的页块被塞进新文档的容器；④结尾回写标签只写给本次加载对应的那个标签（进入时记下的 `tabId`），不用「此刻的活动标签」，否则旧调用会把新标签的 `filePath` 改成自己的。富文档走 `loadRichDoc`，全程同步，没有这个窗口。


打开条目前若附件路径不存在，主进程先在原目录按指纹找一次（没有指纹才退到同名），找到就走与「手动重新定位」同一套事务接回去，并在返回里带 `relinkedFrom`。这条自动路径只扫原目录一层；跨目录批量找回走 `lib-relink-scan`（用户选目录，按指纹匹配，只处理有指纹的条目）。打开成功后补记指纹，并把 `readStatus === 'todo'` 转成 `reading`。

连续模式分别用两个 IntersectionObserver 管预渲染和当前页；不能合并。单页模式由显式跳页控制显示、渲染与释放。离开预渲染区释放 PDF 位图；缩放重新渲染并保持阅读位置。Z 放大模式按鼠标指向的页内位置计算锚点。

标签保存文档字节/转换页、路径、类型和页码。恢复时暂停会话写入，先建立标签对象，只加载激活项，其余切换时按需加载，避免未完成加载覆盖后台页码。恢复跳过失联文件；命令行文件与启动恢复由主进程协调。

导航历史挂在标签对象，显式跳转入栈，普通翻阅不逐页记栈；后退时可补记滚动漂移位置，最多 60 条。

分屏参考视图独立渲染到只读 canvas，不挂标注层和文本层，因此不参与标注、选区与事件。它默认与主视图共用同一个 `PDFDocumentProxy`（看同一份文档的另一页），也可以挂另一篇文献：此时用独立的 `PDFDocumentProxy`（`state.refDoc`），有自己的页数与自然旋转，不参与标注、文本层与搜索；跨文档时「跟随」禁用（两篇的页码不对应）。对照路径按标签保存（`tab.refPath`）并随会话恢复；关掉分屏只释放对照文档、保留路径，下次打开自动重载。分屏偏好存设置，参考页与对照路径存标签与会话。参考视图的渲染始终走 `refTotal()` 取页数（有对照文档用它的，否则用主文档的），避免两套页数混用。切回标签时对照文档还没加载，`refTotal()` 会暂时拿到主文档页数——此时不能拿它夹取会话里记的对照页（5 页的对照文献会被夹成主文档的 3 页），先按记录值保留，`loadRefDoc` 加载完再用真实页数夹一次。对照文档的销毁是异步的：`await` 之后必须再校验一次 `refLoadSeq`，否则用户在等待期间点了「用当前文档的另一页」，已取消的加载会把文档重新挂回去。选择器的候选每次打开都重新向主进程要（库可能刚导入 / 改名 / 删除），不做跨次缓存。

阅读方式有三种：连续滚动（scroll，观察器管渲染）、单页翻页（page）与双页对开（spread）。page/spread 不走观察器：可见页由 `applyPageVisibility` 的 `.is-current` 标记，渲染/释放在 `scrollToPage` 里显式做；spread 显示 `spreadPair(cur)` 的搭档页（封面独占、偶左奇右、落单不补位），对开下「适应宽度」按半幅宽算。富文档无对开，按单页处理——`effectiveViewMode()` 把「用户偏好」（`App.state.viewMode`）和「当前文档的有效模式」分开：富文档的 spread 一律按 page 执行，布局 class、可见性、观察器与导航都读有效模式，切回 PDF 自动恢复对开偏好。设置白名单放行 `spread`。换页时 `freePagesExcept(targets)` 只保留当前页组（对开是两页）的位图，其余页一律释放；从连续模式切入 page/spread 也会清掉散落的位图。回收范围包括**正在渲染**的页（`activeRenders`）：快速跳页时上一组的任务还没结束，`rendered` 仍是 false，但画布已经分配。`renderPageNum` 的回写要同时校验任务身份（`el._task === task`）与文档代际，过期任务不得把离屏页重新标成已渲染，否则会留下没有位图的「已渲染」页。

智能跳转（点引用标记 ↔ 参考文献条目）的识别与行匹配在 `smartjump.js`（Node 可测）；渲染层把文本项按 y 聚行、定位点击字符，跳转走 `scrollToPage(record)` 记入导航历史，落点高亮画在独立 `.sj-layer`。只在默认选择工具的单次单击触发。行缓存按页存（`sj.byPage`），用时按页号拼成整篇行序——用户可能先跳着点某一页，缓存顺序不等于文档顺序，定位一律用「页号 + 行对象」换算下标，不用裸下标。既不是引用标记、也不像参考文献条目的行直接返回，不扫全文。取一页文本项一律走 `pdfPageAt(n)`：先看这一页的元素有没有 `_pdfPage`，没有就用 `pdfDoc.getPage(n)` 现取。**不能只认已渲染的页**——参考文献表入库要扫文末 20 页，而用户此刻多半停在第 1 页，那些页的元素根本不存在，只按元素取会得到「这份 PDF 没有文字层」的假警报。

朗读按句驱动：把文本项拼成一条字符串并记录「字符 → item / item 内偏移」，断句后按 span 建 DOM Range 回算真实文字框。一次只提交一句给 Web Speech，句间才有稳定的位置锚点；读完当前页再取下一页，无文字页跳过。句级高亮画在独立 `.speech-layer`，与搜索高亮互不清除；朗读中 `H` / `U` 用同一组句框写入普通标注。位置按文档路径存本机 `localStorage`，不写库结构。`App._setSpeechDriver()` 允许测试替换语音驱动，避免依赖系统语音引擎。

PDF 原生批注通过 PDF.js 读取，按 viewport 处理旋转与 CropBox，转换到本地 shapes，按 nativeId 去重；回复批注（/IRT）把父批注 id 记成 shape.replyTo（与 nativeId 同一套 ref 格式），列表层显示「↳ 回复」标记，不重排嵌套树。扫描捕获 PDF 实例、路径、标注容器，等待后检查归属，文档切换则取消。部分形状不支持。用户书签（B 键）也存这个 sidecar（bookmarks 字段）：anno-save 会保留已有书签、bookmarks-save 不碰标注页，两者共存。书签保存按「文档路径 + 加载代际 `loadSeq`」归属，同一路径的操作走一条**串行队列**（`bookmarkQueues`，key 是文件路径）：每次基于上一次「已成功落盘」的工作副本构造候选，成功后提交工作副本、失败只把界面回滚到工作副本。队列**跨加载代际共享**——重新打开同一份文档沿用同一条链，只把工作副本换成新读到的磁盘内容，否则新旧两条队列会并行覆盖 sidecar。任务在发 IPC **之前**再校验一次路径与代际：切走 / 关闭 / 重新打开后，尚未发送的旧任务直接取消（返回 `canceled`），不再写盘；落盘成功即使代际已过期也推进工作副本（磁盘真相），界面更新则只按代际过滤。首次操作会等这一份文档的书签读盘完成，避免用空数组覆盖磁盘。`restoreAnnos` 同样按路径与代际校验，避免切文档期间把旧数据读进新文档。

### 撤销：笔记编辑合并成一个点（v1.6d）

撤销栈存的是**整库 JSON 快照**（每次操作前后各拍一张，真有变化才入栈）。这套做法要求「所有会改库的写操作都在栈里」，漏一个就会出问题：笔记编辑当初被排除在外（怕打字把栈填满），结果撤销「添加标签」时会把快照里那份**旧笔记**一起恢复，把后来保存的正文覆盖掉——这是真的丢数据。

现在的做法是两边都占：

- `addNote` / `updateNote` / `removeNote` 都进撤销栈；
- `updateNote` 在**同一条笔记、4 秒窗口内**合并成一个撤销点（`NOTE_COALESCE_MS`），连续打字只留一个点；
- 能合并时连前后快照都省掉（不打字时不必每次序列化整库），只把窗口往后推。

于是撤销按操作顺序一步步走：先「编辑笔记」，再「添加标签」——不会再有「撤了标签，正文也没了」。

### 关窗前的保存握手（v1.6d）

标注与笔记都是防抖保存（600 / 700ms）。用户改完立刻点 ✕，最后那批改动还在定时器里没落盘。

主进程在 `win.on('close')` 里拦下默认行为（`e.preventDefault()`），向渲染层发 `app-will-close`；渲染层按「笔记 → 标注」的顺序 flush，再通过 `app-close-ready` 回报 `{ ok, error }`；主进程收到 `ok` 才真正 `win.close()`。

三条边界：

1. **保存失败不关窗**——弹窗给「仍然关闭（这次改动会丢）」和「返回处理」两个选择，内存里那份还在；选了「返回处理」之后**待保存记录必须留着**，否则再点一次 ✕ 会因为「表里已经空了」而直接放行。
2. **超时不等于成功**——4 秒没回话时**不能**当作存好了。弹窗问一次，默认「继续等待」（再等 4 秒）。「继续等待」**永远在**，且是 `cancelId`：按 Esc / 点关闭都等于继续等待，只有明确点「仍然关闭」才放弃。
3. **握手期间重复点 ✕ 不重复发请求**（`closing` 标志）。

「什么算脏」只有一个来源：`noteSaveTimers`。**任何一次保存失败都要把这条重新登记进去**——不管是关窗前的 flush、700ms 的自动保存，还是工具栏按钮触发的立即保存。只在其中一处补记录是不够的：自动保存失败时记录早被删掉了，关窗就会以为「没有待保存的东西」。

两个提示框的文案与按钮放在 `closedlg.js`：`main.js` 一 require 就会拉起 Electron，抽出来才能在 Node 里断言「Esc 永远不等于放弃」。

注意 Electron 的 `window.close()`（渲染层自己调）会直接销毁窗口、**不触发** `close` 事件，所以它绕不过这个握手。界面里没有任何地方调它；用户能触发的关闭路径（✕ / 菜单 / `app.quit()`）都会走 `close`。

### 关闭文档要作废在途加载（v1.6d）

`loadPdf` 是长异步流程，销毁等待期间可能被别人插队。`closeDocument()` 现在会 `loadSeq++`，让所有在途加载在下一个检查点自行退出；`loadPdf` 在提交状态前还会再确认一次「这次加载的目标标签仍然存在」——关标签不一定递增 `loadSeq`，光靠代际挡不住。

不做这两步的表现是：标签已经关光了，过一会儿文档正文、页数、标题又自己冒出来。

### 合并重复条目要搬标注关联（v1.6d）

标注关联是**双向**的：条目侧 `item.annoIds`，标注侧 `annoMeta[id].itemKey`。`mergeItems` 原来只搬笔记，于是合并后保留项看不到被合并条目的标注，而标注还指着一个已经删掉的 key。现在两边一起改：`annoIds` 并入保留项，`annoMeta` 里指向被删 key 的 `itemKey` 全部改指保留条目。

### 标注保存保护用的是「已显示文档」的凭据（v1.6c）

标注写盘前必须满足两条：①这次读盘已经落地；②状态可信（`ok` / `missing`，`unknown` / `broken` 一律不动笔）——否则会把「还没读完的空」当成「用户删光了」，覆盖掉磁盘上还能修复的原文件（R7-01）。

**凭据不能是全局 `loadSeq`**。`loadPdf` 一进来就 `++loadSeq`，但那一刻屏幕上的还是上一份文档：它要先去销毁旧的主文档与对照文档，等待期间新文档根本没装上去。如果这时再打开第三份，保存检查拿「新代际」去核对「旧文档的恢复句柄」，必然不匹配 → 判定「标注还没读完」→ 把第三次打开直接取消掉（R-v1.6c-02，表现就是 `test-main-race` 里 C 永远加载不出来）。

所以凭据是 `annoDoc = { path, gen }`，**只在这一份文档真正成为当前文档时更新**——也就是 `startAnnoRestore()` 被调用的那一刻（此时 `s.filePath` 已经换成新的）。同一处顺手把 `annoState` 重置成 `unknown`，而不是在 `loadPdf` 开头重置：

- `saveAnnosNow` / `flushBeforeLeave` / `rebuildAnnosFile` / `doExportArchive` 全部用 `annoDoc` 的路径与代际；
- `annoRestoreSettled()` 的「还没切走」判定改成 **恢复令牌身份 + 当前路径**，不再比对 `loadSeq`——下一份可能已经开始加载（`loadSeq` 已递增）但还没装上去，这时这份文档的标注仍然是可信的，该保存就得保存；
- 保护本身一个字没放宽：状态仍是 `unknown` / `broken` 就不写盘，`test-r7-anno-guard`、`test-r01-anno-race`、`test-save-failures` 全部照旧通过。



### 扁平化副本的往返（v1.6）

「导出带标注副本」会把批注**画进页面内容**，`/Annots` 随之消失——这就是「扁平化批注无法恢复」的来由。现在导出时多做一件事：把 `App.state.annos` 的**原始 shapes**（未转 PDF 坐标、保留 id / kind / comment / color）作为 PDF 附件 `trove-annotations.json` 写进副本（pdf-lib 的 `attach`）。于是副本不再单向。

导入侧（`native-annos.js`）的顺序是**先看附件、再看 `/Annots`**：

- `readEmbedded()` 用 `pdfDoc.getAttachments()` 取 `trove-annotations.json`，`TextDecoder` 解 UTF-8 后 `JSON.parse`，按 `{ page, shapes }` 校验。命中就当主源（`source: 'embedded'`），跳过 `/Annots` 扫描——数据是我们自己写的，比从绘制结果反推准得多，也快得多。
- 没有附件才退回 `scan()`（`source: 'native'`），也就是原来的标准批注映射。
- **去重必须同时认 `nativeId` 与稳定 `id`**：内嵌形状未必有 nativeId，只按 nativeId 去重会让同一批批注导一次多一份（`merge` 里给 id 加了 `id:` 前缀，避免与 ref 串撞车）。
- 嵌入失败不影响副本本身：`attach` 抛错只记一条 warn，导出照常成功。这是多出来的恢复能力，不是导出的前提。

外部工具扁平化的 PDF 里没有这份附件，仍然只能靠 `/Annots`——那部分确实读不回来，README 的边界里写明了。

### 图片语法只有一份定义（v1.6b）

Markdown 图片的解析**必须三处共用**：渲染（`Md.render`）、拖拽改宽度（`mdImageWidthSet`）、导出复制（`export-note-bundle`）。这三处各写一条正则时，只有渲染认得 `![图](a.png "说明")` 的标题——缩放会跳过它去改下一张，导出会漏掉这张图而且 `skipped` 还是 0（看起来「什么都没缺」）。

现在 `markdown.js` 里只有 `IMAGE_RE_SRC` 一个常量，配 `scanImages(text, { skipCode })` 返回带绝对偏移的 `{ start, end, alt, url, urlStart, urlEnd, base, width, frag }`：

- 渲染用它替换成 `<img>`；
- 缩放用 `scanImages(..., { skipCode: true })[idx]` 取第 N 张，只替换 `[urlStart, urlEnd)` 这一段——标题和 `#w=` 之外的东西一个字都不动；
- 导出用同一份扫描结果收集引用、并从后往前改写 URL 段（倒序替换，前面的偏移不会被带偏）。

`codeMask()`（围栏代码块 + 行内代码）也放在这里：渲染器本来就不会把代码里的 `![](...)` 变成图片，另外两处按同一口径跳过，编号才对得上。

**源码位置是传下去的，不是反推的**（v1.6e）。`renderBlocks` 先算出每一行的绝对起点，`inline(text, { base })` 把它加到图内偏移上，`imageTag` 直接写进 `data-md-img-src`；容器递归时把正文起点接着传。脚注正文是「各行 trim 后拼空格」重拼出来的，位置对不上原文，所以在**收集阶段**就从定义所在的源码切片扫出图片偏移，渲染时按顺序发下去。

早先的做法是「渲染完再按 URL 贪心配对」，遇到「正文与脚注引用同一张图」就分不清是哪一处——两处 URL 相同，配对只能靠顺序，而顺序在脚注这里恰好是乱的。表格单元格也要算：`cellStarts()` 给出每个单元格正文在行内的起点，拼上行绝对偏移传下去。注意 `cells()` **不能**在这里把 `\|` 解成 `|`——解了文本会短一个字符，后面图片的偏移就全少算一格；转义统一交给 `inline()` 在 `esc` 之后做，偏移始终按原始文本算。

**定位不到就不改**：缩放只认 `data-md-img-src`，没有就明确提示「定位不到源码位置」，不再按 DOM 序号猜——序号在脚注、表格这些会重排的地方本来就是错的。

`#w=NNN` 是**图片自身的属性**，写在 URL 的片段位置（Markdown 的 URL 里不能有空格）：导出时 Markdown 保留它、HTML 由 `imageTag` 变成 `width` 属性；`notes[].imageW` 是富文本笔记的同一件事的结构化形态，导出时会补成 `#w=` 标记。

### 卡片标题自动链接（v1.6）

笔记预览渲染完之后，`library-ui.js` 的 `autolinkCards()` 走 `TreeWalker` 把文本节点里出现的**回顾卡片标题**换成 `<button class="rv-autolink" data-rv-link="<标注 id>">`。三个约束都不是随手加的：

1. **只认回顾里的卡片**。全库标注都参与的话，正文会亮成一片，等于没有提示——「亮」本身就是信息，亮太多就废了。
2. **标题至少 4 个字**。两三字的词（「方法」「模型」）命中率高得没有信息量。
3. **不动 `a` / `code` / `pre` / `button` 里的文字**。代码块里出现同样的词不该变成链接。

标题表在 `openNoteEditor()` 时取一次（`nvLoadCards()` → `recall.outline()`），换来的是每次敲键重渲染预览不用再走 IPC；代价是期间新加的卡片要重开编辑器才生效。调用顺序也重要：**必须放在 KaTeX 增强与图片包装之后**——它替换的是文本节点，放前面会被后面那两步一起冲掉。正则按标题长度降序拼，避免「深度学习」把「深度学习在医学影像中的应用」切碎。

批注归档（`export-anno-archive`）读的是同一份 sidecar，所以有两道前置：渲染层先 `flushAnnos()` 把内存里的改动写进去（写失败就中止，不再假装成功），并在打包前后各核对一次 `filePath + loadSeq`；主进程侧只有 `ENOENT` 才算「从没标注过」，解析失败、结构异常、权限或读取错误一律中止并返回 `broken` 与具体原因。**不能把「读不出来」降级成空 `pages`**——空归档与「备份完成」在界面上长得一模一样，那是最坏的失败方式。

## 重排阅读、标尺与命令面板

重排（`reflow.js`）的输入是渲染层归一化后的文本项 `[{ str, x, y, w, fh }]`（scale=1 视口坐标，y 向下增大），与搜索高亮、智能跳转同一套坐标系，所以旋转与 CropBox 不用再管一遍。处理顺序是：按 y 聚成行 → 行内按 x 拼字符串（间距超过 `h * 0.28` 才补空格，否则 `ab` + `cd` 会变成 `ab cd`）→ 行首尾的断词连字符接回去 → 按行首 x 与宽度聚类切栏 → 把字号与行距相近的行并成段落（遇到缩进、明显更大的行距、列表符号就断段）。跨页合并只在「上一页末尾与下一页开头都没有段落终止感」时做。

它是**纯函数**（无 IO）的原因很实际：这一整段逻辑没有一处需要磁盘或网络，放纯函数里就能在 Node 里跑 40 项回归；一旦掺进 DOM 测量就只能在 Electron 里验。代价是它必须做 UMD——`renderer/index.html` 把它当普通脚本加载，CommonJS 的 `module.exports` 会在浏览器里变成 `module is not defined`，整份文件不执行、`window.Reflow` 不存在，重排要到用户点下去才报错（这条是这轮真踩到的）。

刻意不做的事：图表、公式、跨栏大图不重排，留在原位。做成「PDF 变 EPUB」需要排版引擎，而这里的价值只是「小屏 / 长文时把正文读顺」，不值的部分不做。

重排是页数级的长任务（最多 400 页），所以它必须**绑死打开时那份文档**，光靠 `reflow.open` 判断「还在不在」不够：关掉再打开、或切到另一份 PDF，旧循环都还以为什么都没变，于是按 A 的页数去读 B 的页（B 第 1 页反而没人读），标题仍挂着 A。凭据是四样一起：`token`（每次打开 / 关闭都换）+ `pdfDoc` 对象 + `filePath` + `loadSeq`，每个 `await` 回来都校验一次，不活着就直接返回，不写 DOM；`finally` 也只在自己仍是当前任务时收尾（置 `busy` / `pages`、滚到当前页），否则会抹掉新任务的状态、或把旧文档的页码滚给新文档。载入 PDF、载入富文档、关闭文档三条路径都调 `reflowCancel()`。取页也不再从全局 `App.state.pdfDoc` 现取，而是由调用方传进来。

阅读标尺是**一个 div**，不是 canvas：`pointer-events: none` 所以不拦选区、标注与链接；鼠标在 `#viewer` 或 `#reflow-body` 上移动时按其 y 定位（`clientY - 高度 * 0.38`，让色带压在光标上方一点），高度夹在 18–90 px，开关与高度存设置。它不进任何文档状态，关掉窗口就没有。

命令面板是「已有动作的一张表」：每条 `{ id, label, keys, group, run, need }`，面板只负责模糊过滤与分组渲染。`need: hasPdf` 的项在没有打开文档时不列出——否则用户点了一条注定失败的命令，比没有这条命令更糟。`Esc` 的优先级是面板 → 参考文献入库弹窗 → 重排，越靠前越先吃掉按键，避免一次 `Esc` 关掉两层。

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

笔记公式：markdown.js 把 `$…$` / `$$…$$` 输出成带 `data-md-math` 的等宽占位；渲染进程 TroveMath 在有 KaTeX（`renderer/katex/`，由 copy-pdfjs 拷贝）时换成真排版，缺失时保留源码。导出 HTML 在主进程用同一引擎渲染，css + woff2 字体带进 `.files/katex/`。富文本子笔记不渲染公式。独立笔记 `[[标题]]` 双向链接：占位由编辑器委托按「现标题 → 旧标题」解析跳转，反链在渲染预览时现扫独立笔记正文——判定方式是**把每条链接解析到最终目标**、只统计指向本条的，而不是按名字做正则匹配；否则旧标题被新笔记占用后，原笔记会显示一条实际跳到别处的反链。回收站里的笔记不参与解析。

## 搜索、列表与引用

全文索引按路径 SHA-1 前 24 位保存。新鲜度比较 mtime/size；读索引缓存还检查 ctime，缓存原始文件大小预算为 32 MB。索引抽取有长度限制，扫描件不会自动 OCR。

统一查询解析由 query.js 负责。主进程合并全文、标注和笔记，执行字段上下文过滤、去重和评分，返回 total/counts/offset/limit。默认每页 120，最多 500。饱和首页会保留各来源最佳结果，用固定置换避免分页丢失或重复。

UI 首次展示 20 条，再展开和续拉；类型筛选在结果面板进行。库列表超过阈值后按 80 行分块挂载，选择按 key 维护。

索引的读写与检索**跑在一个 worker 线程里**（`search-worker.js`，协议是 `{ id, cmd, args }` → `{ id, ok, result }`），主进程只做转发与广播（`search-service.js`）。原因很实际：`fulltext.search()` 是同步的，要 `readdir` 整个索引目录、逐份 `JSON.parse`、逐页正则；库一大这段就把主进程的事件循环按住，输入和滚动一起变钝。搬进 worker 后主进程只在等结果时挂起一个 Promise。实测 400 份索引下，查询期间另一个 IPC 的最大往返从 176 ms 降到 2 ms（`test-search-worker` 里有这条对照）。索引文件也只由 worker 读写，主进程不再挂那 32 MB 的条目缓存。

`search-service` 有两条路：worker 正常时全部走 worker；worker 起不来（极端环境）或运行中崩了，自动退回进程内直接调 `fulltext.js`，功能不丢、只是回到原来的性能。`PDFREADER_SEARCH_INLINE=1` 可强制走进程内，用于排错与「两条实现结果必须一致」的对照回归。

打包后 worker **从 asar 里加载**：入口 `app.asar/src/search-worker.js`，它 require 的 `fulltext.js` / `docconvert.js` / `query.js` / `atomic-file.js` 也在 asar 内，相对路径一路通；`node_modules` 里的 jszip、pdfjs 等由 Node 按目录向上解析到 asar 内的包目录。**不要**只把入口写进 `asarUnpack`——那样入口能起来，`require('./fulltext.js')` 却会在 `app.asar.unpacked/src` 下落空（`test-worker-pack` 用临时 asar 和真实 worker 验证此布局）。唯一需要解包的场景是有人手工拆过包，服务把那当成第二候选。

增量队列按**数据目录代际**管理：`stop()` / `restart()` 会清空队列、取消防抖计时器并递增 `gen`，批次每轮循环与每条广播都校验代际，旧目录的任务既不会写进新索引、也不会让界面以为新目录多了东西（R4-05，`test-search-restart` 守这条）。

索引进度按**增量队列**走：导入、抓取 PDF、重新定位、还原条目都只调 `scheduleIndex()`，同一路径自动去重、500 ms 内的连续变更合并成一批、按顺序逐个建；每建好一个文件发 `ft-index-changed`（带 `pending`），整批结束发 `ft-index-idle`（带 done / failed / skipped / 耗时），主进程 `broadcast()` 给所有窗口。渲染进程收到后在设置面板刷新「已索引 N/M」，搜索结果面板显示「索引中 +N」并在整批结束后**自动重跑当前查询**——用户搜的时候文档可能还没进索引，不重跑就会一直显示「没有命中」。

库列表的快速筛选直接复用同一套查询语法（`Query.matchLibraryItem`），因此传入前**不能**先 `toLowerCase()`：`OR` / `AND` 是大小写敏感运算符，提前转小写会让 `title:a OR title:b` 退化成三个普通词；词本身由 `Query.fold` 折叠，大小写不影响匹配。可视化条件构建器（`buildQuery` / `parseQueryToRows`）只在「AND + 字段限定 + 排除 + 短语」子集内做无损往返：隐式 AND 拆成多行、字段别名归一到 UI 字段名、短语内的双引号用 `""` 转义；含 OR / 括号 / 未闭合引号的查询整串保留为 `raw` 行，应用时原样返回，不重新拼装。

收藏集侧栏支持 `Ctrl` / `Cmd` 多选：`scope` 为 `colls` 时按 `ids` 取并集，普通点击折叠为 `coll`，取消最后一个退回 `all`。并集只影响条目过滤，每个收藏集自己的计数仍按直接归属统计；删除集合会自动从 `ids` 移除并收窄范围。并集与搜索、标签、排序、批量选择共用同一条 `visibleItems` 链路。

### 条件检索

搜索框那条串（`query.js`）负责「快」：一个词、一个短语、一个字段限定，回车就有结果。条件检索（`advsearch.js`）负责「准」：多行条件、运算符、全部 / 任一。两者不互相编译——把「标注数 > 3」编译成字符串语法会立刻变成自造方言，保存的检索也没法无损还原成条件行；Zotero 自己也是两条路，保存的检索里存的是条件数组。

条件形态是 `{ field, op, value }`，检索形态是 `{ match: 'all' | 'any', conditions: [...] }`，**组也是同一种形态**（`conditions` 里再放 `{ match, conditions }` 就是嵌套），所以 `normalize` / `matches` / `describe` / `countGroups` 全部递归实现，不需要第二套数据结构。深度上限 `MAX_DEPTH = 4`，超界的组在规范化时**丢弃而不是抛错**——坏数据（手工改过库、老版本导回）不该让整个检索失败；空组同样丢掉，因为它对结果没有约束，留着只会让描述文案与组数变复杂。字段表带 `type`，运算符表按 `type` 分组（`text` / `number` / `enum` / `bool` / `annoEnum`），`needsValue` 决定界面是否禁用值控件。`normalize()` 会丢掉「字段不认识、运算符与字段类型不匹配、需要值但值为空」的条件，`filter()` 在条件为空时原样返回列表——这两点是「弹窗里随便点点不会把列表清空」的前提。

界面上的定位一律靠 `data-path`（`0`、`1.0`、`1.1.2` 这种路径串），不用下标也不用 DOM 层级：嵌套之后下标不再唯一，而 DOM 层级会被重画打断。改字段要整行重画（运算符集合与值控件都跟着变），改运算符只替换值控件、不重画——重画会让正在输入的焦点跳走。

批注属性（标注数 / 标注类型 / 标注颜色 / 标注带批注 / 标注文字）依赖「这篇条目上有哪些标注」。渲染层已经因为标注视图把全量标注放在 `state.annos` 里，`advCtx()` 按 `itemKey` 建一次 Map 就够整轮过滤用；主进程完全不参与。

保存的检索存在 `library.json` 的 `searches` 数组里：老的串式只有 `query`，条件式多 `match` / `conditions`（`query` 为空）。`library.addSearch` 对字段与运算符做白名单、条件数封顶 20、值截到 200 字；老版本读到带 `conditions` 的条目只当空查询处理，不会坏库。存的是条件树本身，不做任何扁平化——扁平化之后「(A 且 B) 或 C」和「A 且 (B 或 C)」会变成同一个东西。

### 相似文献

`similar.js` 是纯函数：进「目标文档的正文词袋 + 语料（每篇的正文词袋）」出「排序好的相似度 + 共享词」。做法是 tf-idf 加余弦，idf 从**当前语料**算（库里的文档集合），tf 取亚线性（`1 + log`），避免一篇长综述靠词多压过同主题的短文。分词口径按语言分开：拉丁取小写、长度 ≥ 3、过一张虚词与期刊套话表（`references` / `et al` / `this study` 之类）；中文取二元组，因为中文没有空格而单字太泛（「的」「研」），二字组在「深度学习」这类术语上召回与精度都够。

要不要上向量模型？不要。引入模型意味着下载权重、加载运行时、几百 MB 内存，而「找同一主题的另一篇」用词袋已经够用；代价是抓不到同义改写（`DL` 与 `deep learning` 不相似），但换来零依赖、离线、几百篇一秒内出结果。`shared` 只挑「两边都出现且 idf 较高」的几个词给界面，作用是解释**为什么像**——用户看到「transformer · attention · encoder」才敢相信 78% 这个数。

主进程只做两件事：从全文索引里读两边正文、把结果拼成条目摘要回给渲染层。索引不在的条目（扫描件、没建索引、已删除）直接排除，不猜。

### 跨文档 Portal

`portal.js` 解决的是「这条参考文献说的是库里哪一篇」。参考文献是自由文本、多数没有 DOI，所以判定只有两级：①两边 DOI 相同（先折叠大小写与标点再比，DOI 里合法的括号不能截断）；②否则算标题词覆盖率 + 年份是否出现 + 第一作者姓氏是否出现，加权后过阈值才算命中。阈值刻意偏保守——「跳错一篇」比「不跳」更让人困惑，而且用户一旦跳过两次错的就再也不用了。

命中后主进程返回 `{ key, page }`。`page` 的顺序是：标题整串能在对方某页找到就用那页 → 整串被断词 / 分栏拆开时退一步看标题前几个词命中够不够 → 都没有再看 DOI 出现在哪页 → 仍然没有就给第 1 页。渲染层拿着 `{ key, page }` 交给分屏参考栏打开——**不改变本文位置**，这正是 Portal 与「跳转」的区别。

比较前两边都要 `fold`：`findStartPage` 曾经拿原始 DOI 去比折叠过的页面文本，永远找不到，表现是「DOI 明明在库里却总从第 1 页开始」。

### 参考文献表批量入库

`refimport.js` 是纯函数，输入是文末若干页的文本行，输出是候选条目 + 置信度 + 查重结果。四段：

1. **切条**：编号（`[12]` / `12.`）、项目符号、作者-年份起始、以及「句末兜底」四种边界。作者-年份这一种最容易误切（正文里的 `Smith (2019) showed…` 也是这个形状），所以要求当前条目「已经够长（≥40 字）或已经收尾在年份」才断——短条目还没成形就断，会把一条拆成三条。
2. **抽字段**：DOI / arXiv / 年份 / 标题 / 作者 / 刊名卷期页 / 类型。DOI 正则要允许括号（`10.1016/0002-9610(86)90192-2`），只在右括号多于左括号时才去尾括号。
3. **认标题**是难点，做成四级可解释的规则链：带引号的标题 → APA 的 `(年份).` 锚点（`(2019).` 是标题起点最强的信号）→ 句点切片（带缩写点回拼：`C. M. Bishop` 被 `. ` 切碎后，用「前段以缩写结尾 / 本段是纯缩写」拼回去）→ 逗号切片（要求多词段里至少有一个缩写或全大写姓，否则 `Deep Learning` 会被当成作者）。GB/T 7714 走另一条更可靠的路：靠 `[J] / [M] / [C] / [EB/OL]` 标记切「作者. 题名[类型]. 出处」，比猜中文标题稳。
4. **置信度**：抽到 DOI / arXiv 是 `id`；有年份、作者或刊名是 `parsed`；都没有是 `weak`。界面默认只勾「新增且非 weak」，认错了取消勾选即可——不追求全自动正确，追求「错了不痛」。

两段式 IPC：`dryRun` 只解析 + 查重（不联网、不写盘、立刻返回），确认后再 `import`（可联网补全题录、3 路并发、上限 60 条）。分两段是因为「解析对不对」和「要不要联网」是两个问题，混在一次调用里只能给用户一个转圈。查重三级：DOI 相同 → 标题键（折叠标点与大小写）+ 年份相同 → 批内重复。单次最多 400 条（`MAX_ENTRIES`），防止把一整份 bibliography 数据库误粘进来。

引用格式化、citekey 与参考文献表由 Cite/Creators/Bib/CSL 协作。CSL 仅实现参考文献表常用子集；自定义样式存在 styles/。Word .doc 导出是 HTML 包装，RTF 为独立格式。笔记的 Word 导出同理：一份带 mso 命名空间与 `@page` 设置的 HTML，Word / WPS 双击可开；刻意不引 KaTeX 的相对样式表（Word 不会加载），公式退化成 KaTeX 展开后的 HTML。

**引用键模板**（`Cite.citekey(it, { template })`）是纯字符串变换：`[字段:修饰符]` 加字面量，`expandKeyTemplate` 先取字段原值（**保留词间空格**，修饰符要靠它认词边界，`:abbr` 就是每词首字母），再依次应用修饰符，最后统一 `keyClean` 去掉分隔符并按 40 字符截断。默认模板 `[auth:lower][year][veryshorttitle:lower]` 与改造前的固定规则逐字符等价——老用户贴进文稿的 `[@key]` 不会变，这条有回归对拍。作者不可用（没有作者 / 中文作者没有拼音转写）时字段本身退到 `item`+条目 key 前缀，而不是等整串为空才兜底。

文内引注由 `Cite.citeInText(it, { style, num, locator, year, ambiguous })` 生成：编号制定位符进方括号，作者-年份制进圆括号。脚注体走另一组函数（`noteCite` / `shortNote` / `opCit` / `citeSequence`），因为它们解决的不是同一件事：同上 / 前引只在脚注体里有意义，作者-年份制重复引用必须重复写全，编号制靠编号指回表里。`citeSequence(entries, { collapse, locale, ambiguous })` 按正文出现顺序返回 `[{ text, form, key }]`，`form` 是 `full` / `ibid` / `short` / `opcit`——**只有紧接上一次才是同上**，中间隔了一条还写「同上」会让读者指错地方。

同姓消歧由 `Cite.authorLabels(items)` 统一算：它返回 `Map<item.key, Set<小写姓氏>>`，被命中的姓在文内引注里补名字首字母。规则与 APA 一致——**所有**撞车的条目都补，只补其中一条会让另一条看起来像「唯一的 Smith」。两个以上不同首字母才算撞车（同一个人重复出现不算），中文名不硬造拉丁首字母。

同作者同年的消歧年份由 `Bib.disambiguatedYears(items, style)` 统一算：它返回与 `Bib.build()` 内部一致的**完整年份**（`2024a` / `2024a-10`），调用方通过 `Cite.citeInText(it, { year })` 用在正文。返回完整年份而不是「后缀」，是因为年份字段可能带月份 / 日期，而后缀是插在四位年之后的——用「截掉原长度」去推算后缀会截错（`2024-10 → 2024a-10`，末尾是 0 不是 a）。

参考文献表的 HTML 导出每条内嵌 COinS（`Bib.coinsFor(it)`）：`ctx_ver` + `rft_val_fmt` 按文献类型选 journal / book / dissertation，字段映射 `rft.atitle` / `rft.jtitle` / `rft.btitle` / `rft.date` / `rft.volume` / `rft.issue` / `rft.spage` / `rft.epage` / `rft.pages` / `rft.au` / `rft_id`，值做 `encodeURIComponent`，属性里 `&` 写成 `&amp;`（浏览器解码后才是原串）。只写进 HTML——Markdown / RTF / Word 里放 `title` 属性没有意义。

综述草稿（`review.js`）把批注编成 Markdown：输入是 `listAllAnnotations()` 的结果（标签从 `annoMeta` 补上）与未删除条目，按 `groupBy` 分组，组内按作者 → 标题 → 页码排序。编号制样式在渲染过程中按「第一次出现」分配编号，参考文献表用 `Bib.build(items, { order: 'entry' })` 按同一顺序生成，因此正文编号与表内序号一一对应；作者-年份制走默认姓氏排序，正文不编号。输出刻意保持扁平结构（标题 + 引用块 + 斜体出处），不用嵌套列表——自带 Markdown 渲染器对嵌套块引用支持有限，扁平结构在预览与导出里都稳。主进程处理该 IPC 时会先注册用户 CSL 样式，否则 `csl:` 样式会退化成默认样式。范围语义必须用「是否传了 keys」区分：不传（null / undefined）表示全库，传数组就是明确范围、空数组表示零条——不能用 `length` 判断，否则空收藏集或零匹配查询会被放大成全库，生成一份完全不相干的草稿。

库统计（`libstats.js`）区分两种年份口径：`byYear` 按条目 `year`（出版年份）分桶，`byCreated` 按 `created` 的本地年份（入库年份）分桶，面板上分列「出版年份」「入库年份」。老文献今天导入时前者落「更早」、后者落今年——不能只用一个年份却挂「添加年份」的标题。

## 格式与联网边界

docconvert 将支持格式转成受限 HTML，限制页数、总 HTML、单图及表格尺寸，清理不允许的脚本和资源。metadata/fetchpdf 在用户操作时联网；下载校验类型、大小与 PDF 内容，成功后安排索引。网页快照生成 MHTML/PNG，应用内不提供完整网页浏览器。RSS 订阅同样按需联网：feedparse.js 解析（纯逻辑），主进程用 Node 原生 http/https 拉取（不走 Chromium 网络栈，规避系统代理；重定向、20 秒超时、4MB 上限），条目经 lib-add-item 落成 webpage 条目。 阅读时长统计：readingstats.js 纯逻辑（心跳累加 / 合并 / 聚合，Node 可测），渲染层每 15 秒记一次心跳（库覆盖层、窗口隐藏、无文档时不计），增量与 userData/reading-stats.json 合并落盘，不进 library.json。

导入 PDF 的题录识别分两段：`pdfmeta.readFirstPageText` 取前两页文本（不渲染，最多 8000 字符，失败返回空串）→ `doiscan.extractIdentifiers` 抽 DOI / arXiv（带 `doi` 标签的优先；arXiv 裸编号必须文本里出现 "arxiv"）→ `metadata.fetchMetadata` 走 Crossref / arXiv。单条识别超时 9 秒，失败只意味着「没补全」，导入照常成功。字段合并由 `identify.fieldsFromMetadata(meta, explicit)` 统一处理：**直接把完整的 opts 传进去**，函数只读它认识的字段，因此调用方不需要手工列举「哪些字段是显式的」——列漏一个就会导致该字段被识别结果覆盖。优先级为显式 opts > 识别结果 > PDF 内嵌元数据；`itemType` 为空或 `document` 都算「没有明确类型」，允许被识别结果替换。批量导入在渲染层用 3 路并发，避免几十个文件排成几分钟。

并发导入的去重不能只靠处理函数开头的检查：识别要等网络，两个调用可能都通过检查再各自建条目。`library.ensurePdf()` 把「查重 + 建条目」放进同一段同步代码（中间没有 await），第二次调用一定能看到第一次刚写入的记录；`opts.dedupe` 为假时仍保持「每次新建」的老语义。开头的快速检查保留，只用来省掉无谓的网络请求。

题录导入的字段取值要按 XML 文本内容处理：EndNote 会把一段文字包进 `<style face="…">` / `<i>` 之类内联标签，直接正则抓标签对会把标签当正文写进标题和作者。formats.js 的做法是先剥内联标签、再把其余标签当空白，最后解实体（顺序不能反，否则 `&lt;` 会被误剥）；CDATA 段原样保留。字段可能由「普通文本 + CDATA + 普通文本」多段拼成，各段必须原样拼接、最后对整段做一次空白规范化——逐段 trim 会把 `Before <![CDATA[Middle]]> After` 粘成 `BeforeMiddleAfter`，而简单在段间插空格又会把 `pre<![CDATA[fix]]>` 变成 `pre fix`。XML 属性单双引号都要认（`ref-type name='Book Section'`），Book Section 映射到项目自己的 `bookSection` 类型。feedparse 的 Atom 链接同理：`href` / `rel` 支持单双引号，标签允许命名空间前缀（`atom:link`，解析前统一剥前缀；RSS 不剥，避免把自闭合的 `<atom:link>` 当成正文链接）。

单实例锁在正常运行时启用，探针/冒烟按测试模式隔离；单实例回归使用自己的 userData，但仍必须保留锁逻辑。

### RDF 与 MARCXML（v1.6）

这两个格式都是「嵌套元素 + 属性」，用正则一层套一层抠字段会越写越脆，所以 `formats.js` 里先放了一个**极小的 XML 树解析器** `parseXmlTree()`：元素 / 属性 / CDATA / 注释 / 自闭合，出错不抛（找不到同名结束标签就忽略，坏文档不该让整份导入失败）。它不是通用 XML 解析器——不处理 DTD、实体定义与命名空间解析，只把 `a:b` 当普通名字，`xmlLocal()` 去掉前缀再比。

- **RDF**：导出 Zotero RDF 的形态（`bib:Article` / `bib:Book` 等顶层节点 + `z:itemType` + `bib:authors/rdf:Seq/rdf:li/foaf:Person`）。解析同时吃 Zotero RDF 与 Dublin Core 简版：DC 没有 `z:itemType` 就从 `dc:type`（`Text.JournalArticle` 这类）取尾段反查类型，`dc:creator` 直接是「姓, 名」时交给 `Creators.parseName`。ISBN 既认 `dc:identifier` 里的 `ISBN …` 也认独立元素。
- **MARCXML**：只做「论文库够用」的一小撮字段（leader / 001 / 008 / 020 / 022 / 024 / 041 / 100 / 245 / 264 / 300 / 520 / 650 / 700 / 773 / 856）。类型靠 `773` 是否存在区分连续出版物与专著（有 773 → 期刊，leader/07 = s；没有 → 图书，leader/07 = m），年份从 `264$c` 或 `260$c` 取。刻意不追求编目级映射——那要一张 200 行的字段表，收益不在论文库这一侧。
- **`.xml` 三种格式按内容分辨**：`<rdf:RDF` → rdf，`MARC21/slim` → marcxml，其余当 EndNote XML。三种都可能叫 `.xml`，按扩展名硬猜必然错一种。导出侧 `.xml` 默认按 MARCXML（EndNote XML 只进不出）。

### EndNote 附件路径（v1.6）

EndNote 导出的 XML 里附件不是普通路径，而是「库内位置」：`internal-pdf://<分桶目录>/<文件名>`。那串数字只有配上 `.enl` 库目录才有意义，而用户通常只把 XML 拷出来。`refattach.js` 按「XML 所在目录」试几个落点：`<stem>.Data/PDF/<host>/<name>` → `<stem>.Data/PDF/<name>` → `PDF/<name>` → `<name>`，`%20` 会解码。

**试不到就安静放弃**：编一个不存在的路径会让条目一打开就报「文件不见了」，比「有题录没附件」更烦。单独成模块（而不是塞在 `main.js` 里）是为了能在 Node 里直接回归——主进程文件一 require 就会拉起 Electron。`formats.js` 只负责把原始串带出来（`attachmentHint`），落不落成附件由主进程决定，这个内部字段在入库前删掉。

### 题录写回 PDF（v1.6）

`pdfwrite.js` 把条目的标题 / 作者 / 摘要 / 关键词 / DOI 写进 PDF 自身，**同时写 Info 字典与 XMP**：Info 是 90 年代的老机制但兼容面最广，XMP 是新工具看的，只写一边总会有一半软件读不到。

两条保守决定：

1. **默认另存副本（`-元数据.pdf`），不改原文件**。写 PDF 二进制不是无损操作——对象重排、交叉引用表重建，一次失败就可能让原文档打不开。这和「删除只改索引、绝不删原始文档」是同一条原则。重名自动加序号，不覆盖已有文件。
2. 只动题录相关字段，不碰书签、注释、附件与加密状态。

XMP 是手写的最小可用包（`dc:title` / `dc:creator` / `dc:description` / `dc:subject` / `dc:identifier` / `xmp:CreatorTool` / `xmp:ModifyDate` / `pdf:Producer` / `pdf:Keywords`），通过 `doc.context.stream(xmp, { Type: 'Metadata', Subtype: 'XML' })` 注册后挂到 catalog 的 `/Metadata`。所有值走 `xmlEsc()`，标题里有 `<C>` 也不会把结构写坏。

**`/Producer` 设了也留不住**：pdf-lib 在序列化时会把 Info 里的 Producer 改写成它自己的字符串（实测 `setProducer('Trove')` → 保存后读回是 `pdf-lib (https://…)`）。所以「谁生成的」只写在 XMP 的 `pdf:Producer` 里——那是我们自己的流，不会被覆盖。这条写在模块注释里，免得下次有人再试一遍。

IPC 是 `lib-write-pdf-meta`：主进程按 key 找条目与附件，`outPath` 只给探针/自动化用，界面入口不传（走默认命名）。

### 抓取：多源聚合与机构代理（v1.6）

`fetchpdf.js` 的候选顺序是 arXiv → 开放获取 → DOI / 直链 → 代理版 → OpenURL。

- **四路开放获取并行**（Unpaywall / OpenAlex / Semantic Scholar / Europe PMC），`Promise.all` 后按可靠性排序去重。串行的话最坏要等四个超时，用户会以为卡死。每路的返回形状都不一样，`pickPdfUrl()` 按来源分别取：OpenAlex 看 `best_oa_location.pdf_url`（没有就找 `locations` 里第一个有 `pdf_url` 的），Semantic Scholar 看 `openAccessPdf.url`，Europe PMC 先挑 `documentStyle` 含 pdf 的、再退到 `availabilityCode` 是 OA/F 的。
- 排序用的 `rank[source] || 9` 是错的——unpaywall 的序号就是 0，会被当成「没有」而排到最后。改成 `hasOwnProperty` 判断，这条写进了回归。
- **机构代理** `applyProxy()` 支持两种真实写法：带协议的前缀（`…/login?url=` 后面拼编码后的目标，已有 `url=` / `qurl=` 就直拼，否则补一个）与域名后缀（`doi-org.proxy.univ.edu`，主机名里的 `.` 换 `-`，这是 EZproxy 的既定规则）。**代理版排在直连之后**：反过来会让本来能下到的 PDF 绕一圈登录页。
- **OpenURL** `openUrlFor()` 用题录拼 ContextObject（`rft.atitle` / `rft.jtitle` / `rft.date` / `rft.volume` / `rft.issue` / `rft.pages` / `rft.spage` / `rft_id=info:doi/…`）。多数解析器返回的是落地页而不是 PDF，所以它排最后一站。
- 代理与解析器**只从设置读**，抓取参数里不接受——否则一条 IPC 就能把请求引到任意地址。
