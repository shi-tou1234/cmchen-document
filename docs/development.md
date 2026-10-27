# 开发、测试与打包

本文面向维护者。用户操作见 [README](../README.md)，数据与异步约定见 [architecture.md](architecture.md)，本轮验证见 [verification-2026-10-26-multi-collection.md](verification-2026-10-26-multi-collection.md)。

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

当前有 **96 个 test-*.js 脚本**：92 个用 Node 驱动，3 个直接运行 Electron，1 个验证打包产物。不要将 92 个 Node 驱动脚本全部称为纯 Node 单元测试，其中多数会启动真实 Electron。

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
| 保存失败 | test-save-failures、test-reliability-ui、test-n01-note-export-save |
| 迁移与备份 | test-datadir、test-data-resources、test-resource-roundtrip、test-backup-restore |
| 搜索与列表 | test-search、test-search-boundaries、test-search-paging、test-large-library |
| 原生批注归属 | test-native-annos、test-r01-anno-race |
| 笔记保真与链接 | test-note-templates-export、test-review-r02-r05、test-n02-n04-note-content、test-m01-legacy-md-note |
| 会话与历史 | test-session、test-session-restore、test-tabs、test-nav-history |
| 旋转与分屏 | test-reader-rotate-split（含会话二次启动恢复） |
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

打包会生成 build/；本轮文档验收没有自动重新打包。现有 exe 不能作为当前提交的验收对象。

```powershell
npm run copy-pdfjs
npx electron-builder --win dir
```

如需手动嵌图标，只对 build/win-unpacked/Trove.exe 运行缓存中的 rcedit-x64.exe，指定 assets/icon.ico，再从该目录生成两类包：

```powershell
npx electron-builder --win portable --prepackaged "build/win-unpacked"
npx electron-builder --win nsis --prepackaged "build/win-unpacked"
node scripts/test-packaged.js "build/Trove-1.4.0-portable.exe"
```

不要对最终 portable 或安装包运行 rcedit：它们包含自解压附加数据，改 PE 资源可能破坏整个包，即使工具退出码为 0。

build.files 必须携带主进程需要的 pdfjs-dist build、cmaps、standard_fonts，以及渲染器 PDF.js 构建。--prepackaged 必须明确传目录。图标源与生成脚本在 assets/、scripts/make-icon.js、scripts/make-ico.js。

发布前分别检查源码回归、当前提交构建、打包冒烟、隔离安装/启动/卸载及快捷方式。记录安装包字节数、构建提交与日期；卸载默认保留用户数据。签名、版本升级、发布、提交和推送按用户明确要求执行，测试通过本身不意味着授权发布。

## 修改约定

- 所有删除入口只改索引，不删除原始文档。
- 异步扫描/加载/弹层要捕获所属文档或请求代际，等待后再次确认归属。
- 两个 PDF 观察器分别管理预渲染与当前页，不能合并；单页模式不由观察器回收。
- PDF.js 使用字节副本，避免 ArrayBuffer 转移后导出失败。
- 模板追加与光标插入是不同语义；不能复用替换选区的函数。
- 富文本 html 是正文，text 是检索内容；链接转换同时兼容标准 href 和内部 data-md-link，并保留协议校验。
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

正常保留 node_modules/、build/、src/renderer/pdfjs/，以及历史评审证据。assets/sample-annotated.pdf 是 test-export.js 的可再生输出；确认无用途后可删除。清理仅针对明确归属的临时数据，不删除正式回归脚本、用户文档或未知运行时目录。
