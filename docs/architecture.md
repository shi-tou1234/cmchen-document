# 架构与数据约定

本文描述当前源码。应用版本为 1.3.0，库格式为 v8；二者独立演进。历史修复过程见 [CHANGELOG](../CHANGELOG.md)，使用说明见 [README](../README.md)。

## 进程与模块

Trove 使用 Electron 31、原生 JavaScript 和本地 JSON。没有前端框架或数据库；业务模块不依赖 node-gyp 扩展。

| 层 | 主要职责与入口 |
| --- | --- |
| 主进程 | `main.js` 管窗口、文件、IPC、转换、备份恢复、目录迁移和索引调度 |
| 数据模块 | `library.js`、`settings.js`、`atomic-file.js`、`data-resources.js` |
| 内容模块 | `docconvert.js`、`fulltext.js`、`query.js`、`formats.js` |
| 引用与抓取 | `creators.js`、`cite.js`、`bib.js`、`csl.js`、`csl-styles.js`、`metadata.js`、`fetchpdf.js` |
| preload | `preload.js` 经 contextBridge 暴露 `window.pdfBridge` |
| 阅读界面 | `renderer/renderer.js` 管 PDF/富文档、标签、页码、搜索、缩放、会话与导出 |
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
| `settings.json` | userData | 白名单设置，含 dataDir、restoreTabs、viewMode 等 |
| `window-state.json` | userData | 窗口、最后使用目录和最多 8 条最近打开记录 |
| `session.json` | userData | 最多 20 个文档标签、页码与激活路径 |

改变数据目录不会将所有 userData 状态文件搬到同一目录。测试与备份程序必须明确区分这两个根目录。

## 文献库与标注模型

库包含 `items`、`collections`、`searches`、`tagColors`、`annoMeta`，并兼容旧版 `annoTags`。

条目使用稳定 key，记录 itemType、title、结构化 creators、year、publication、DOI/URL、fields、tags、collectionIds、relations、notes、attachment、page 及时间戳。作者记录 firstName、lastName、creatorType；中文姓名与机构不按西文规则强拆。

笔记记录 id、title、text、html、image、annoIds 与时间戳。独立 Markdown 笔记以 text 为正文、html 为空；富文本子笔记以清洗后的 html 为正文，text 是检索用纯文本。不能用富文本的 text 替代导出正文。

标注分为三个相关层次：

- `annotations/<hash>.json`：路径、保存时间及各页 shapes，存坐标、颜色、文字与稳定 id。
- `library.annoMeta[id]`：文字、评论、标签、所属条目与生成笔记等对象元数据。
- `items[].annoIds`：与对象所属条目形成双向关联。

PDF 标注使用 scale=1 的页面坐标，左上原点、y 向下，SVG viewBox 固定。富文档标注使用页面 CSS 像素并跟随 CSS zoom。两种坐标约定不能混用。

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

PDF 原生批注通过 PDF.js 读取，按 viewport 处理旋转与 CropBox，转换到本地 shapes，按 nativeId 去重。扫描捕获 PDF 实例、路径、标注容器，等待后检查归属，文档切换则取消。扁平化批注无法恢复，部分形状不支持，不重建回复树。

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

## 搜索、列表与引用

全文索引按路径 SHA-1 前 24 位保存。新鲜度比较 mtime/size；读索引缓存还检查 ctime，缓存原始文件大小预算为 32 MB。索引抽取有长度限制，扫描件不会自动 OCR。

统一查询解析由 query.js 负责。主进程合并全文、标注和笔记，执行字段上下文过滤、去重和评分，返回 total/counts/offset/limit。默认每页 120，最多 500。饱和首页会保留各来源最佳结果，用固定置换避免分页丢失或重复。

UI 首次展示 20 条，再展开和续拉；类型筛选在结果面板进行。库列表超过阈值后按 80 行分块挂载，选择按 key 维护。分页并没有把整个查询迁到后台，主进程搜索与全量 summary 广播仍是后续优化项。

引用格式化、citekey 与参考文献表由 Cite/Creators/Bib/CSL 协作。CSL 仅实现参考文献表常用子集；自定义样式存在 styles/。Word .doc 导出是 HTML 包装，RTF 为独立格式。

## 格式与联网边界

docconvert 将支持格式转成受限 HTML，限制页数、总 HTML、单图及表格尺寸，清理不允许的脚本和资源。metadata/fetchpdf 在用户操作时联网；下载校验类型、大小与 PDF 内容，成功后安排索引。网页快照生成 MHTML/PNG，应用内不提供完整网页浏览器。

单实例锁在正常运行时启用，探针/冒烟按测试模式隔离；单实例回归使用自己的 userData，但仍必须保留锁逻辑。
