# 开发、测试与打包

本文面向维护者。用户操作见 [README](../README.md)，数据与异步约定见 [architecture.md](architecture.md)。

## 环境与启动

Windows 10/11，Node.js 18+、npm；主要依赖为 Electron 31、electron-builder 24、PDF.js 3.11.174 和 pdf-lib。使用 package-lock 固定依赖，不需要 node-gyp 业务扩展。

```powershell
npm ci --no-audit --no-fund
npm run copy-pdfjs
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
npm start
```

PDF.js 的浏览器构建输出到 src/renderer/pdfjs/，该目录受 .gitignore 排除，新克隆必须生成。Electron 下载失败时可按本机网络配置 ELECTRON_MIRROR，再运行 node_modules/electron/install.js；不要把网络安装失败当作应用启动错误。

## 源码测试

项目提供多组 **test-*.js 回归脚本**：绝大多数用 Node 驱动（其中不少会拉起真实 Electron 做端到端），少数是纯 Node 单元测试（`test-citekey`、`test-advsearch`、`test-recall`、`test-query`、`test-reflow`、`test-similar`、`test-portal`、`test-pdftext`、`test-refimport` 等），另有直接运行 Electron 的与验证打包产物的。不要把「用 Node 跑」当成「纯单元测试」。

项目尚无 npm test 总入口。以下循环在单项失败后继续收集，最终以失败清单判定：

```powershell
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$skip = @('test-pen.js', 'test-real-input.js', 'test-lazy-render.js', 'test-packaged.js')
$failed = @()
Get-ChildItem scripts/test-*.js | Sort-Object Name |
    Where-Object { $skip -notcontains $_.Name } | ForEach-Object {
        node $_.FullName
        if ($LASTEXITCODE -ne 0) { $failed += $_.Name }
    }
if ($failed.Count) { throw ('测试失败：' + ($failed -join ', ')) }
```

三个直接 Electron 测试分别验证画笔、真实鼠标和懒渲染。每个实例使用独立的临时 userData；PowerShell 直接调用 GUI exe 可能拿不到正确等待行为，可用 Start-Process -Wait -PassThru，或 Node child_process.execFileSync 检查退出码。

```powershell
$direct = @('test-pen.js', 'test-real-input.js', 'test-lazy-render.js')
foreach ($name in $direct) {
    $testData = Join-Path $env:TEMP ('trove-direct-' + [guid]::NewGuid())
    New-Item -ItemType Directory -Path $testData | Out-Null
    $testArgs = @("scripts/$name", '--no-sandbox', '--disable-gpu',
        ('--user-data-dir="{0}"' -f $testData))
    $result = Start-Process -FilePath 'node_modules/electron/dist/electron.exe' `
        -ArgumentList $testArgs -Wait -PassThru -WindowStyle Hidden
    if ($result.ExitCode -ne 0) { throw ("测试失败：$name") }
}
```

上例会生成 trove-direct-* 临时目录，完成后可核对路径再清理。独立渲染器测试壳没有完整主进程 IPC，相关未注册 handler 日志不能当作整套应用验证通过的证据。

### 重点回归入口

| 范围 | 脚本 |
| --- | --- |
| 数据、撤销与作者 | test-library、test-undo、test-creators |
| 导入识别与附件找回 | test-identify-fields、test-doiscan、test-pdf-identify、test-fingerprint |
| 阅读队列与笔记别名 | test-read-queue、test-library-meta |
| 综述草稿 | test-review、test-review-ui |
| 标注读取与备份扫描 | test-r7-anno-guard（读取完成前保护、损坏文件重建、备份隔离） |
| 保存失败后的文档切换 | test-anno-save-navigation（真实只读文件失败、保留未保存标注、恢复写入后切换） |
| 保存失败 | test-save-failures、test-reliability-ui、test-n01-note-export-save |
| 迁移与备份 | test-datadir、test-data-resources、test-resource-roundtrip、test-backup-restore |
| 搜索与列表 | test-search、test-search-boundaries、test-search-paging、test-large-library |
| 检索 worker 与增量索引 | test-search-worker（worker / 进程内两条路结果一致、导入后自动补建并广播、查询期间主进程仍响应）、test-search-restart（换数据目录后旧队列不得写进新索引）、test-worker-pack（打包布局：从 app.asar 内起 worker 并建索引） |
| 回顾（间隔重复） | test-recall（调度序列 / 边界 / 落盘容错 / 写盘失败回滚 / prune / 导入导出，纯 Node）、test-recall-ui（空态 → 纳入 → 模糊与禁用 → 空格显示 → 评分写回 → 汇总 → 备份恢复往返）、test-recall-scan（标注文件读失败时不得清理复习进度） |
| 条件检索 | test-advsearch（引擎语义 / 布尔与数量 / 批注属性 / 坏条件 / 条件组嵌套与深度上限 / 存储白名单，纯 Node）、test-adv-ui（字段联动、且或切换、条件组增删与嵌套、组内且或、应用与横幅、存为智能收藏集、标注回复树、Word 导出、引用键模板） |
| 重排阅读 | test-reflow（拼行补空格 / 断词连字符 / 聚行与切栏 / 缩进与列表断段 / 跨页合并，纯 Node）、test-v36-reading-ui（重排层字号栏宽、目录跳页，真实 Electron） |
| 阅读标尺与命令面板 | test-v36-reading-ui（标尺跟随与高度夹取、不拦选区、开关持久化；命令面板过滤与执行、无文档时按 need 过滤；重排出块与关闭） |
| 相似文献 | test-similar（分词口径 / 亚线性 tf / 语料 idf / 余弦 / 共享词，纯 Node）、test-v36-reading-ui（详情列表与点击打开） |
| 跨文档 Portal | test-portal（DOI 与标题词判定、候选过滤、起始页三级回退、跨行拼条，纯 Node）、test-v36-reading-ui（参考栏打开且本文位置不变） |
| 印章与批注归档 | test-v36-anno-ui（一次点击落章 / 撤销 / 导出位置与中文、归档前先 flush 且中途切文档放弃、sidecar 损坏中止而空标注仍出包、归档 zip 四个成员、重排跨文档切换不串页、表格可视化编辑） |
| 中文标注字体子集 | test-pdftext（候选字体 / 子集体积 / 字形覆盖 / 无字体降级，纯 Node）、test-export-highlight（按 cjk 分流断言）、test-reliability-ui |
| 参考文献表批量入库 | test-refimport（切条 / 字段抽取 / 标题四级识别 / 查重 / 置信度 / 上限，纯 Node）、test-refimport-ui（预览 → 取消一条 → 导入 → 就地变「已有」） |
| 引用键模板 | test-citekey（与旧算法逐字符对拍、混合作者守第一作者语义、字段与修饰符、兜底与上限、重名后缀与顺序无关、设置项规范化，纯 Node） |
| 原生批注归属 | test-native-annos、test-r01-anno-race |
| 笔记保真与链接 | test-note-templates-export、test-review-r02-r05、test-n02-n04-note-content、test-m01-legacy-md-note |
| 会话与历史 | test-session、test-session-restore、test-tabs、test-nav-history |
| 旋转与分屏 | test-reader-rotate-split（含会话二次启动恢复）、test-ref-doc（跨文档对照） |
| 使用指南 | check-help（结构 / 相关链接 / action 与 ui 存在性 / 每个控件都有归属节 / 名字出现在正文里，纯 Node）、test-help（六个入口、76 节逐节渲染、搜索与回车、Esc 与 F1、定位闪烁、直达条件检索、命令面板条目，真实 Electron） |
| 引用候选与笔记图片 | test-overview（候选排序跨 IPC、排除当前文档、全库搜索、Esc、portal-pick 补起始页）、test-note-image（拖把手写回源码、渲染读回、双击还原、截图宽度跨存储层）；两者的纯逻辑部分在 test-portal 与 test-markdown 里 |
| 加载代际与竞态 | test-main-race（主文档加载撞旧对照销毁）、test-r01-anno-race（标注跨文档串写） |
| 朗读 | test-reader-speech（跨页 / 句级高亮 / 暂停恢复 / 跨启动位置记忆） |
| 收藏集并集 | test-library-multi-collection（Ctrl 多选 / 去重 / 取消 / 删除收窄） |
| 笔记公式 | test-math（占位标记 / KaTeX 渲染 / 无 katex 降级 / 导出携带字体） |
| 智能跳转 | test-smart-jump（标记识别 / 条目匹配 / 反向高亮 / 普通文本不触发） |
| 双页对开 | test-two-page（搭档规则 / 并排布局 / 旋转下成立 / 设置持久化） |
| 库统计 | test-lib-stats（回收站口径 / 年份分桶 / 面板渲染） |
| 阅读进度 | test-reading-progress（page+pageTotal 落库 / 进度条 / 继续阅读） |
| EndNote XML | test-enw-xml（字段映射 / 实体解码 / 坏 XML / IPC 入库） |
| 笔记双向链接 | test-wikilinks（占位渲染 / 互跳 / 反链列表 / 不存在提示） |
| 条件构建器 | test-query-builder（语法生成 / roundtrip / 面板回填 / 排除组合） |
| 批注回复 | test-anno-reply（IRT 捕获 / replyTo 指向 / 面板前缀 / 去重） |
| RSS 订阅 | test-feed（解析 / 本地源端到端 / URL 去重 / 跨启动持久） |
| 文内引注 | test-atc-citation（编号制 / 作者-年份制 / 定位符 / 列表位次编号） |
| 阅读时长 | test-reading-time（累加 / 非法剔除 / 落盘 / 面板热力图 / 跨重启） |
| 用户书签 | test-bookmarks（B 键 / 侧栏跳页 / sidecar 共存 / 跨启动） |
| 审核 B01–B12 + 复查 R01–R04 | test-audit-fixes（书签串行队列与失败回滚 / 合并订阅 / EndNote 样式与混合 CDATA / 条件构建器往返 / 组行下标 / Atom 引号 / 年份口径） |
| 引用与格式 | test-csl、test-csl-ui、test-bib、test-formats |
| 引用补齐（同上 / 前引 / 消歧 / COinS） | test-cite-note（纯 Node：消歧边界、四种文献类型的脚注体、三种 collapse、坏输入、COinS 编码）、test-atc-citation（引注体下拉） |
| 题录格式（RDF / MARCXML / EndNote 附件） | test-refio-formats（纯 Node：RDF 往返与 DC 简版、MARCXML 往返、`.xml` 三种格式分辨、附件候选路径）、test-enw-xml |
| 抓取聚合与机构代理 | test-fetchpdf（四路 OA 聚合、代理两种写法、OpenURL 拼装与排序）、test-fetch-pdf-ui |
| 笔记元数据与标题样式 | test-note-meta（规范化 / 落库 / `publicItem` 字段完整性；面板、字数、跨存储层往返、倍率真的改到预览字号、卡片自动链接） |
| 回顾大纲 | test-recall（depth 上下限 / 落盘 / 写盘失败回滚）、test-recall-ui（页签切换、Tab / Shift+Tab 缩进与落库） |
| 扁平化副本恢复 | test-native-annos（导出内嵌 `trove-annotations.json` → 打开副本恢复 11 条，含颜色 / 评论 / 子类型 / 稳定 id） |
| 题录写回 PDF | test-pdf-meta（原文件字节不变、Info 与 XMP 都能读回、缺字段不写空值、默认不覆盖、坏输入不抛、特殊字符转义） |
| 懒渲染与缩放 | test-lazy-render、test-zoom-mode，以及相关 reader/v 系列 |

scripts/ 中的 probe 脚本是正式测试辅助文件，不因文件名含 probe 或 test 就删除。

### 测试隔离与判定

| 设置 | 用途 |
| --- | --- |
| PDFREADER_LIBRARY | 指定隔离 library.json |
| PDFREADER_DATA_DIR | 指定隔离索引、资源与备份目录 |
| --user-data-dir | 隔离 Electron 设置、会话和标注 |
| PDFREADER_NO_AUTO_INDEX | 关闭自动索引，稳定无关测试 |
| PDFREADER_PROBE | 指定返回 checks 的渲染器探针 |
| PDFREADER_PROBE_PDF | 预先打开测试 PDF |
| PDFREADER_PROBE_OUT / PDFREADER_PROBE_SHOT | 输出结构化结果或截图 |
| PDFREADER_PROBE_VISIBLE | 显示窗口，用于真实布局检查 |

- 不使用真实 %APPDATA%/trove，也不让旧应用迁移把真实数据带进测试。
- 测试数据目录切换时不要固定 PDFREADER_DATA_DIR，否则会掩盖当前目录变化。
- 隐藏窗口的 rAF/平滑滚动可能延迟；页码测试可用单页模式，但不能据此声称连续滚动视觉已验收。
- 每个探针必须包含有效断言。PASS (0)、只检查按钮存在或固定返回 true 不能证明端到端流程正确。
- IPC 结果和进度事件是不同投递链路；需要等待事件后再解除订阅。
- 故障注入限定在临时进程和目录。测试保存失败时同时核对编辑器、库缓存、落盘文件、提示与后续重试。
- 会话恢复要逐个核对内存和磁盘页码，并切到后台标签验证，不能只检查标签数量或激活项。
- 视图旋转要同时核对「布局槽宽高互换」和「标注坐标不变」；涉及坐标的功能（选区、画笔、灯箱、放大锚点）必须用 `getScreenCTM()` 逆矩阵验一遍，不能只看页面截图。
- 朗读测试用 `App._setSpeechDriver()` 注入假语音驱动逐句推进，不要依赖机器上是否装了语音引擎，也不要断言真的出声。
- 修改后运行对应回归；全量通过后，只有新变化或未解决风险才需要重复扩大测试。

## 打包与产物验证

打包会生成 build/。验证发布产物时，必须确认它由当前待发布源码构建。

```powershell
npm run copy-pdfjs
npx electron-builder --win dir
```

如需手动嵌图标，只对 build/win-unpacked/Trove.exe 运行缓存中的 rcedit-x64.exe，指定 assets/icon.ico，再从该目录生成两类包：

```powershell
npx electron-builder --win portable --prepackaged "build/win-unpacked"
npx electron-builder --win nsis --prepackaged "build/win-unpacked"
node scripts/test-packaged.js "build/Trove-1.5.0-portable.exe"
```

不要对最终 portable 或安装包运行 rcedit：它们包含自解压附加数据，改 PE 资源可能破坏整个包，即使工具退出码为 0。

build.files 必须携带主进程需要的 pdfjs-dist build、cmaps、standard_fonts，以及渲染器 PDF.js 构建。--prepackaged 必须明确传目录。图标源与生成脚本在 assets/、scripts/make-icon.js、scripts/make-ico.js。

发布前分别检查源码回归、当前提交构建、打包冒烟、隔离安装/启动/卸载及快捷方式。记录安装包字节数、构建提交与日期；卸载默认保留用户数据。签名、版本升级、发布、提交和推送按用户明确要求执行，测试通过本身不意味着授权发布。

## 文档维护

文档索引见 [docs/README.md](README.md)。功能与使用方法更新根 README，架构和开发约定更新对应长期文档，版本变化汇总到 CHANGELOG。README 保持面向使用者，不收录逐项 bug 修复过程。不要新增逐轮审核、验收、修复计划或开发流水记录；测试场景保留在正式回归脚本中。

移动、改名或删文档后跑一遍链接检查（扫全仓 md 的相对链接，外链与纯锚点跳过，围栏代码块与行内代码里的 `[x](y)` 视为举例不算）：

```bash
node scripts/check-doc-links.js
```

退出码 0 表示 0 死链；有死链时逐条打印 `文件:行号 -> 目标` 并以 1 退出。这不是 `test-*.js`，不会进上面的全量循环。

## 修改约定

- 所有删除入口只改索引，不删除原始文档。
- 异步扫描/加载/弹层要捕获所属文档或请求代际，等待后再次确认归属。
- 两个 PDF 观察器分别管理预渲染与当前页，不能合并；单页模式不由观察器回收。
- PDF.js 使用字节副本，避免 ArrayBuffer 转移后导出失败。
- 模板追加与光标插入是不同语义；不能复用替换选区的函数。
- 富文本 html 是正文，text 是检索内容；链接转换同时兼容标准 href 和内部 data-md-link，并保留协议校验。
- 新增条目 / 笔记字段时，`migrateItem`、写入函数与 `publicItem` 三处要一起改：漏了 `publicItem` 就是「存得进、界面读不回」，纯 Node 单测发现不了。回归要**从 `summary()` 读回来**验，而不是只查内存对象。
- 需要「写在设置里、算在导出里」的样式（例如笔记标题倍率），预览用 CSS 变量、导出算成绝对单位，两处必须读同一个设置值；CSS 变量**不要**在子容器里重复声明，局部声明会遮蔽 `:root`，表现是「滑杆动了、预览没动」。
- 导出前必须确认保存成功，缺图和部分 PDF 导出必须明确提示。
- 迁移和恢复先暂存，再提交；出错保留恢复证据。
- 大列表单击保持节点与选择状态，避免重绘破坏双击；不要在 pointermove 中反复读取布局。
- 版本号修改时同时核对 package.json、package-lock.json、产物名称与文档；库格式版本升级还要更新迁移和相关测试。

## 常见问题与清理

| 现象 | 排查入口 |
| --- | --- |
| 启动无窗口 | ELECTRON_RUN_AS_NODE、Electron 安装、copy-pdfjs |
| 页面脚本 404 | src/renderer/pdfjs/ 是否已生成 |
| 打包后索引缺模块 | build.files 中 pdfjs-dist 资源 |
| PDF 放大后左侧不可达 | 页面 flex 溢出对齐，检查 safe center |
| 单实例回归异常 | 隔离 userData 与 TEST_MODE 是否误关闭了锁 |
| 保存失败但导出成功 | 保存返回值、await 与错误提示 |
| 导出来源链接消失 | HTML/Markdown 转换是否保留 data-md-link |
| 恢复后台页码变成 1 | 加载完成时序、标签归属及 syncActiveTab |

正常保留 node_modules/、build/、src/renderer/pdfjs/。assets/sample-annotated.pdf 是 test-export.js 的可再生输出；确认无用途后可删除。清理仅针对明确归属的临时数据，不删除正式回归脚本、用户文档或未知运行时目录。
