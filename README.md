# PDF Reader（Electron 轻量版）

按同目录 `PDF阅读器-任务书.md` 落地的实现：以本地文献库为主入口，阅读器负责**阅读 + 缩放 + 翻页导航 + 标注**，纯 HTML/CSS/JS，不引 React/Vue/Antd/TS。

## v2 更新（本次迭代）

- **连续滚动「一滚到底」**：所有页面排成一列，用 `IntersectionObserver` 懒渲染——进入视口附近才画，远离后释放位存内存；页块先按精确尺寸占位，滚动不跳动。翻页改为滚动定位，`◀ ▶`/键盘/页码框都平滑滚到目标页，底部状态栏实时反映当前页。
- **普通滚轮 = 原生滚动**（不再被劫持）；只在 **Ctrl+滚轮** 时才缩放。
- **笔类标注**：画笔 / 荧光笔 / 直线 / 矩形 / 箭头 / 文字 / 橡皮擦，可选颜色与粗细，支持 **撤销 (Ctrl+Z)** 与 **清除本页**。标注存在内存里、用 SVG 叠加层绘制（缩放天然跟随页面），**不自动持久化**。这些绘制工具收进工具栏的 **「绘制 ▾」下拉**（点选工具后自动收起），栏上只保留 选择 · 绘制 · 撤销 · 清除本页 · 导出副本，贴近 Edge 的简洁风格。
- **导出副本 (`Ctrl+S` / 「导出副本」按钮)**：用 `pdf-lib` 在原始 PDF 上把标注烧录进去，另存为一个新的 `.pdf` 文件（原文件不动）。
  - ⚠️ **已知限制**：导出文字用的是内置 Helvetica，只支持 Latin-1，**中文/日文等文字标注无法写进导出的 PDF**（屏幕上能正常显示，但导出时该条会被跳过）。纯图形标注（画笔/线/框/箭头/荧光）不受影响。需要中文文字导出得另接 CJK 字体嵌入，属于更重的改动，暂未做。

## v3 更新（优化 + 图标 + 打包）

- **应用图标**：`assets/icon.ico`（多尺寸 16–256px），Edge 风格线性设计（白底圆角 + 深灰描边文档 + 「PDF」字样 + 蓝色画笔，呼应标注功能）。`scripts/make-icon.js` 用 Electron 离屏渲染生成 PNG，`scripts/make-ico.js` 合成 ico。
- **体验优化**：打开/拖拽文件后窗口标题跟随文件名；记住上次窗口尺寸/位置与上次打开目录（存 userData/window-state.json）；任务栏/窗口图标接入。
- **打包**：`npm run dist` 产出 `build/PDF Reader 1.0.0.exe`（portable 免安装，约 70MB）。
  - 打包注意（国内 Windows 踩坑实录）：① `npmRebuild: false` 跳过 canvas 原生重编译（pdf-lib 的可选依赖，运行时用不到）；② `win.signAndEditExecutable: false` 跳过 builder 的 winCodeSign 步骤（其缓存包含 macOS 符号链接，Windows 无符号链接权限时解压必失败）。

## v4 更新（画笔修复）

- **不再串页**：绘制是跨元素手势，原先 `pointermove/pointerup` 绑在每页自己的 SVG 上，笔一旦甩到下一页，就用**那一页**的坐标矩阵换算并把笔迹画到那一页上。现在 `pointerdown` 锁定落笔页，`move/up` 统一在 `window` 处理，坐标恒按落笔页换算。
- **不再「停不下来」**：抬手落在工具栏或页面外空白处时，原来没有任何 handler 收到 `pointerup`，`drawing` 永久悬挂，之后鼠标只要在页面上移动就继续画线。现在由 window 级 `pointerup` 兜底，并新增 `pointercancel`（切窗/系统手势打断时丢弃未完成笔迹，不留残影）。
- **`setPointerCapture` 加异常保护**：无效 pointerId 不再中断落笔。
- **笔迹更跟手**：慢速拖动 + 亚像素抖动的 301 个采样点抽稀为 51 个点；渲染改用中点二次贝塞尔平滑曲线（硬折角消失）；预览改为只更新 `d` 属性的增量路径，长笔画不再每次 move 重建整棵临时节点树。
- **误点不再留污迹**：按下即抬起、没有实际拖动的落点直接丢弃（原来会留一个小圆点）。
- 回归测试：`scripts/test-pen.js` 注入真实 pointer 事件，断言「甩到下一页不串页 / 页外抬手不复位 / 误点零标注 / 抽稀+平滑 / 导出坐标换算 / 叠加层光栅化确有墨迹像素」，并会把 SVG 叠加层直接光栅化数像素，避免依赖不可靠的窗口截图。

  ```powershell
  Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  & .\node_modules\electron\dist\electron.exe scripts\test-pen.js --no-sandbox --disable-gpu
  # 期望：[test-pen] PASS
  ```


## v5 更新（文字批注修复 + 手势不再可能卡死）

- **根因一（我的上一版引入）**：v4 为防多指互踩加了 `if (ctx) return` 硬闸门。可在真实使用中，「在窗口外松手」「切到别的应用」都可能让本窗口永远收不到 `pointerup`，`ctx` 卡住非空 —— 于是之后**所有工具的 pointerdown 全被挡掉，包括文字**。表现为「画笔坏了，现在写字也不行」。现在：闸门改成**先收尾旧手势再开新落笔**（旧笔迹照常提交，不丢），并补了 `pointerup`(capture) / `pointercancel` / `lostpointercapture` / `window blur` 四条兜底，外加 `pointermove` 里 `e.buttons === 0` 的自愈判定。
- **根因二（事件顺序竞态）**：`pointerdown` 早于焦点切换触发。输入框已开着时再点页面，旧顺序是「新 `startText` 先清空 `value` → 随后 blur 用空值提交并把输入框 hidden 掉」，结果**输入框一闪即消失、刚打的字丢了**。现在 `startText` 开头同步结算上一段文字，不再依赖 blur 是否/何时触发。
- **输入法与换行**：Enter 直接提交（`isComposing`/`keyCode 229` 期间不抢键，避免打断候选词确认）、Shift+Enter 换行、Esc 取消；输入框随内容自动增高（原来 `rows=1 + overflow:hidden` 会把第二行吃掉）。
- **多行渲染**：SVG `<text>` 会把换行折叠成空格，多行改用 `<tspan>` 逐行排；橡皮命中框与导出（`pdf-lib` 逐行 `drawText`）同步支持多行。
- **贴边防溢出**：输入框位置夹到可视区内。
- 回归：`scripts/test-pen.js` 扩到 A–J 组，新增断言「卡住手势不锁死后续工具且旧笔迹被补提交」「Enter 提交 / Shift+Enter 留在编辑 / Esc 丢弃」「重复落笔保留上一段文字且输入框不消失」「多行确实产出 2 个 tspan」。

  ```powershell
  Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  & .\node_modules\electron\dist\electron.exe scripts\test-pen.js --no-sandbox --disable-gpu
  # 期望：[test-pen] PASS
  ```

## v6 更新（真实鼠标下写不出东西）

- **元凶**：v5 为兜住「在窗口外松手」加了个启发式 —— `onMove` 里 `if (e.buttons === 0) releaseGesture(false)`。它会在**第一下移动**就判定手势已结束并收尾，此时笔画只有 1 个点，`commit` 又按「误点」把它丢弃，于是**按下拖动完全不留痕迹**，看起来就是"鼠标在上面无法写字"。已删除。
- 为什么之前的测试没抓到：`test-pen.js` 用 `dispatchEvent(new PointerEvent(...))` **直接派发到叠加层元素**，且显式写了 `buttons: 1`，等于绕过了浏览器输入管线，测不到真实命中与按钮状态。这类"合成事件绿、真机红"的盲区必须用真实输入覆盖。
- **新增 `scripts/test-real-input.js`**：用 `webContents.sendInputEvent` 注入真实 `mouseDown/mouseMove/mouseUp`（走浏览器输入管线 + 命中测试），断言画笔落下一笔且渲染出 `path`、文字工具点击后输入框打开并获焦、真实键入 + Enter 提交后 SVG `text` 内容正确，并直接查 `elementFromPoint` 确认最上层是 `svg.anno`。
- 卡住手势的兜底不再依赖 `buttons`，改由更安全的组合承担：新的 `pointerdown` 会先结算旧手势（旧笔迹不丢）、`pointerup`/`pointercancel` 走 capture 阶段、`lostpointercapture`、`window blur`。

## v7 更新（大文件实测，挖出「滚轮滚动不渲染」的真 bug）

为补齐「只用 3 页样本验证」这个缺口，新增 `scripts/perf-big-pdf.js`（自动生成 400–1200 页带矢量内容的 PDF 并分段计时）。这一测直接测出一个功能性 bug：

- **Bug：观察器从未观察任何页块 → 滚轮滚动时后续页面永不渲染。** `loadPdf` 里的顺序是 `buildPageBlocks()` → `applyLayout()` → `setupObserver()`，而唯一的 `observe(el)` 调用在 `buildPageBlocks` 内部且有 `App.io ? … : null` 兜底 —— 首次加载时 `App.io` 还是 null，于是一个元素都没被观察。`◀ ▶`/键盘/页码框之所以看起来正常，是因为 `scrollToPage()` 内部会显式 `renderPageNum(n)`，把死掉的观察器掩盖了；**只有纯滚轮滚动（也就是"一滚到底"这个需求本身）会露出空白页**。修法：先 `setupObserver()` 再建页块，并把 `observe` 的三元兜底去掉 —— 缺观察器时应当直接抛错，而不是静默降级成空白页。
- 新增 `scripts/test-lazy-render.js` 常驻回归：**只改 `#viewer.scrollTop`（等价滚轮）而绝不调用 `scrollToPage`**，断言目标页被渲染且 canvas 真有像素。这条断言正是上面那个 bug 的照妖镜。
- 渲染失败的 `catch` 不再整体吞掉：只把 `cancel` 视为正常，其余错误 `console.error` 报出（此前它让"页面永不完成渲染"变成静默故障）。

### 实测数据（离屏合成 + 每页 18 行文字 + 14 个矢量图元）

| 页数 | 解析 | 建页块 | 可阅读 | 跳远页 | 常驻位图 | 翻阅 20 页后 JS 堆 |
|---|---|---|---|---|---|---|
| 400 | 99ms | 147ms | 211ms | 35ms | 2 页 / 3.1 Mpx | 10MB |
| 800 | — | — | — | — | 2 页 | 10MB |
| 1200 | 133ms | 281ms | 371ms | 35ms | 2 页 / 3.1 Mpx | 10MB |

单页真实光栅成本 16–20ms（A4 @ 适应宽度）。`buildPageBlocks` 的 1200 次串行 `getPage` 共约 150ms，**不需要改成懒建块**。内存有界：常驻位图页数只与视口有关，与文档总页数无关。

### 测量过程中排掉的四个假信号（都差点被当成产品 bug 去"修"）

1. `sweep` 每页恰好约 2000ms：隐藏窗口 **rAF 被降到 ~1Hz**（实测 `rafMs: [973,1005,1005,1005]`），IntersectionObserver 在动画帧里派发，所以每页必然卡约 2s。开 `offscreen: true` 后 rAF 回到 17ms，数字立刻变成 20–35ms。
2. `directRenderMs` 也全是约 1000ms：同一个 1Hz 假象，连直接 `await render.promise` 都被帧节拍量化 —— 隐藏窗口根本不能测延迟。
3. `liveAfterLoad.n = 400`：**未绘制过的 canvas 默认就是 300×150**，用 `width > 0` 判"已渲染"必然误报，必须按 `rendered` 标志或 `width > 400` 判。同一条也修掉了 `test-lazy-render.js` 里 `painted` 的假阳性（透明像素 r=g=b=0 会满足 `r<250`，必须同时要求 `alpha>0`）。
4. `loadMs` 对 400 页和 1200 页都恰好约 1000ms：一是我的探针里有个 `await wait(1000)` 被算进了耗时，二是判定条件 `pdfDoc.numPages > 0` 在 `buildPageBlocks` **之前**就满足，等于没测建块。改成 parse/built/usable 三段分别计时。


## v8 更新（最近打开 + 记住页码 + 双击直接打开）

- **最近打开**：菜单「文件 → 最近打开」，最多记 8 条，条目直接显示「文件名（上次第 N 页）」，点一下重开；另有「清空最近打开记录」。数据与窗口尺寸、上次目录一起存在 `userData/window-state.json`（零依赖，测试用 `--user-data-dir` 隔离）。
- **记住每文件的页码**：翻页/滚动时按文件去抖 500ms 上报页码（`set-page` IPC → `recordPage`，只更新已有条目、不重排列表、不重建菜单），下次打开同一文件**直接落在上次那一页**，并 toast 提示「已回到上次阅读的第 N 页」。
- **双击 / 右键打开方式**：主进程解析 `process.argv` 里的 `.pdf` 路径，走与菜单完全相同的 `readPdfPayload + rememberRecent` 通道；页面未就绪时用 `pendingOpen` 排队，等 `did-finish-load` 统一投递（冷启动必然遇到）。
- **拖拽打开也进最近列表**：Electron 32 起 `File.path` 被移除，改用 preload 里 `webUtils.getPathForFile(file)`；拿不到路径（非本地来源）则静默降级为「仅本次阅读」，不影响打开。
- **关于「设为默认」没有写注册表**：Windows 禁止程序静默改默认应用（UserChoice 有哈希保护）。菜单「系统 → 设为默认 PDF 阅读器…」只做两件事——打开 `ms-settings:defaultapps`、或把本机 exe 路径复制到剪贴板方便你在文件对话框里粘贴。命令行打开已验证可用，所以现在右键「打开方式 → 选择这个应用」就已经能双击进入了。
- 冒烟/截图模式改为**真正不显示窗口**（此前 `createWindow()` 默认 `show:true`，每次跑测试都会闪一下窗）。
- 新增 `scripts/test-session.js`：跑真实 app 三次做端到端断言——首次打开从第 1 页开始 → 读到末页后状态文件记下 `page=3` → 再次打开 `startPage=3` 且实际落点 `currentPage=3` → 重复打开不堆重复条目 → 命令行带路径启动后**窗口标题出现文件名**（等价双击）。

  ```powershell
  node scripts\test-session.js      # 期望：[session] PASS (9)
  ```

### 已知取舍

- 若在关窗前 500ms 内还在快速翻页，最后那一页可能少记一页（去抖窗口内）。
- 页码按文件路径记忆：移动或重命名文件后视为新文件，从第 1 页开始。
- 仍是单窗口应用：反复双击会在同一窗口里换文档，不会各开一扇窗。


## v9 更新（本地文献库 —— 复刻 Zotero 的 A 块地基）

把「一个 PDF 阅读器」升级成「以文献库为主、阅读器为从」：启动即进入**文献库首页**，条目 = 一个 PDF + 元数据 + 标签 + 所属收藏集；点条目进阅读，工具栏「库」按钮随时返回。

- **不做「逆向」**：Zotero 是开源的（AGPL，阅读器模块 `github.com/zotero/reader`），这里借鉴的是它的**数据模型**（条目/收藏集/标签/按附件记忆位置），不是照搬代码。
- **存储选型（关键）**：这台机器编不了原生模块（当年 `canvas` node-gyp 失败逼出 `npmRebuild:false`）。所以**不引 SQLite/better-sqlite3**，用 **JSON 索引**：`userData/library.json`，零依赖，延续项目一贯的轻。数据量到几千条都够用，真需要 SQL 再上 `sql.js`(WASM)。
- **只做 A 块地基**：条目/标签/收藏集 + 拖入/导入 PDF 建条目（标题从文件名猜）+ 点开进阅读。**不含**：BibTeX 导入导出、元数据联网自动抓取、CSL 引用、同步、群组库、浏览器抓取器——那些是另外的项目量级。
- **只引用不删盘**：库条目「移除」只解绑记录，**绝不删磁盘 PDF**；删收藏集也不删条目，把条目回落到父级/未分类。
- **页码统一到一套**：`pageForPath()` 优先取库条目记的页，其次取「最近打开」。从库打开、双击、最近列表三种入口都恢复到同一页；阅读中翻页经 `set-page` 同时回写 recent 与库条目。
- 覆盖层与阅读器解耦：库 UI 只在 renderer 里通过 `window.__libOpen(payload)` 钩子调用 `loadPdf`，**没改动渲染/标注/导出的任何逻辑**。Electron 不支持 `window.prompt()`，新建集合/改名/加标签一律内联 DOM 输入框。
- 数据层健壮性：原子写（tmp→rename，Windows 退回直写）、读损坏文件自愈并留 `.corrupt-*` 备份、容忍 UTF-8 BOM。

**验证（都是真跑，不是推断）**
- `scripts/test-library.js`（纯 Node，隔离临时文件）：CRUD/标签/集合嵌套/删集合回落/拖PDF建条目/只解绑不删盘/页码/80条key唯一/**跨进程持久化**/损坏自愈/**BOM** —— 23 断言 `PASS`。
- `scripts/test-library-ui.js` + `scripts/libui-check.js`（**真实主进程 + 真实 IPC + 真实 preload**，探针 env 门控、隐藏窗口）：库启动即显示、卡片渲染(标题/作者年份/标签/移动下拉预选)、点卡片→进阅读→加载到3页→覆盖层收起、改名即时刷新 —— 13 断言 `PASS`。
- 集成：种一条 page=2 的库条目，`electron .` 实跑 → `startPage:2 / landedPage:2`（页码库分支在真实主进程生效）。
- 全量回归无退化：pen / real-input / lazy / session / app-smoke / export 全 `PASS`（其中修掉一处我引入的**测试时序脆弱**：runSmoke 改用轮询等渲染完成，不再用固定 sleep）。
- 重新打包 70.6MB，asar 确认含库 IPC；探针钩子仅在 `PDFREADER_LIBUI=1` 时激活，普通使用不会触发。

**已知边界**：元数据要手填/靠文件名（暂未做自动抓取）；标题在卡片上点击可改，作者/年份等尚未做编辑 UI；仍是单窗口；库与「最近打开」是两套记录（同一路径会各存一份页码，取值时库优先）。

## v10 更新（条目详情 / 多收藏集 / 回收站 / 排序 / 附件重定位）

延续 v9 的 Zotero 路线，把「最小可用」补成「能日常整理」：详情面板可改全部元数据，条目能同时归入多个收藏集，删错能还原，附件挪了位置能重新指回去。

- **数据层升级到 v2**（`src/library.js`）：
  - 单收藏集 `collectionId` → 多收藏集 `collectionIds`。读 v1 文件时自动迁移并写回 v2；集合父链防环、幽灵父级回落顶层这两条 v9 的保护继续保留。
  - 新增字段：`itemType`（期刊文章/会议论文/图书/学位论文/报告/网页/文档）、`volume / issue / pages / doi / url / abstract / language`、软删除标记 `deletedAt`。
  - `summary()` 一并返回 `version / itemTypes / trashCount`，UI 不再硬编码类型表。
  - 回收站三件套：`trashItem()`（软删除）、`restoreItem()`、`deleteItemForever()`；`emptyTrash()` **只清索引**。永久原则：**任何删除入口都不碰磁盘 PDF**，`test-library.js` 对每一步都断言文件仍在。
  - `setAttachment()/relinkItem()` 支持把条目重新指向移动后的 PDF；`set-page` 仍同时回写最近打开与库条目。
- **右侧详情面板（Info 面板）**：点卡片上的「详情」打开固定右栏，不遮挡列表。类型/标题/作者/年份/出版物/卷期页/DOI/URL/摘要/笔记/标签/收藏集/附件/日期集中编辑，一次「保存」写回全部字段。标签用草稿数组维护，加标签不会把尚未保存的笔记/摘要冲掉。
- **多收藏集**：详情里勾选任意多个收藏集，卡片上以 chips（标签块）显示全部归属；侧栏计数按交集统计。新建收藏集支持在当前集合下建子级，且按钮不会被内联输入框替换掉（开发中发现的「新建按钮一次性消失」bug）。
- **回收站**：卡片「移除」改为移入回收站，列表默认过滤 `deletedAt`；回收站范围可还原/永久删除/清空。清空与永久删除都用**两步确认**（按钮先变「再点一次确认…」，4 秒后自动复位），避免原生 `confirm` 在测试/无头环境里卡住。「清空回收站」只在回收站范围出现。
- **排序**：添加时间 / 最近修改 / 标题（`localeCompare` + 数字感知）/ 年份（倒序，同年按标题）。搜索范围同步扩到摘要、笔记、DOI、URL、卷期页、语言、附件名。
- **附件**：详情里显示文件名与完整路径；文件被移动/删除时标红提示，「在文件夹中显示」与「重新定位…」可直接处理，不必删条目重导。
- **窗口角色隔离**：`additionalArguments: ['--pdfreader-app']` → preload 暴露 `pdfBridge.isApp`。只有主应用窗口（有 `lib-*` IPC）才自动展开文献库；`test-pen` / `test-real-input` / `test-lazy-render` 这些直接加载 `index.html` 的测试窗口不会因缺 IPC 而报错，也不会抢走阅读器键盘焦点。

**验证（都是真跑）**
- `scripts/test-library.js`：51 断言 `PASS`。覆盖 v1→v2 迁移（含 BOM 文件）、多收藏集过滤、软删除/还原/清空只删索引、永久删除仍保留磁盘文件、`setAttachment`、80 条 key 唯一、跨进程持久化、损坏自愈。
- `scripts/test-library-ui.js` + `scripts/libui-check.js`：43 断言 `PASS`。真实主进程 + 真实 IPC + 真实 preload，覆盖搜索（摘要/笔记/DOI）、四种排序、子收藏集、详情回填/保存/标签草稿、多收藏集 chips、回收站全流程（含按钮显隐与两步确认）、点卡片进阅读。
- 全量回归无退化：`test-pen` / `test-real-input` / `test-lazy-render` / `test-session`(9) / `test-export` / app-smoke(`ok:true`) 全 `PASS`。
- `scripts/libui-shot.js`：`PDFREADER_PROBE_SHOT` 钩子实拍详情面板与回收站状态，核对布局/徽标/chips/按钮显隐（隐藏窗口 rAF 约 1Hz，截图前必须等 ≥1600ms 才是新帧）。
- 重新打包 `build\PDF Reader 1.0.0.exe`（74,254,876 字节，约 70.8MB）：先对 `win-unpacked` 里的普通 PE 嵌图标，再 `--prepackaged` 生成 portable；在打包产物上跑冒烟得到 `ok:true`，并从 asar 解出 `library-ui.js` 确认是修复版（无调试钩子）。

**这轮踩到的两个真坑**
1. **`hidden` 被作者样式盖掉**：`.tbtn { display: flex }` 的优先级高于浏览器对 `hidden` 的默认 `display:none`，导致「清空回收站」在非回收站范围仍然显示。样式表顶部加全局兜底 `[hidden] { display: none !important; }`。
2. **`el.ld.delete` 写错键名**：`delete` 是保留字，绑定表里的键实际叫 `del`。访问 `el.ld.delete.hidden` 抛 `TypeError`，而它位于 `render()` 中段 —— 前半段（侧栏/卡片）已更新，后半段（排序回填、清空按钮显隐）被整段跳过，表现为「回收站里按钮不出现」。是「回收站范围显示清空回收站」这条断言把它抓出来的；现在键名旁留了注释，避免再犯。

**已知边界**：元数据仍需手填/靠文件名，未做联网抓取与 BibTeX/CSL；回收站是索引级软删除，不做文件回收；附件重定位是手动选文件，不自动扫描目录；详情面板固定右栏，窗口很窄时列表会被压缩；仍是单窗口、无同步/群组库。**「移除/清空/永久删除都不删磁盘 PDF」是永久约定，不是临时实现细节。**

### 应用图标

- 源图为 `assets/icon-source.png`（成品方形图，四周带留白）。`scripts/make-icon.js` 先按中心裁掉约 7% 白边，再高质量缩放成 256/128/64/48/32/16 六档 PNG；`scripts/make-ico.js` 把它们打包成 `assets/icon.ico`。
- 重新生成：先跑 `electron scripts/make-icon.js`，再跑 `node scripts/make-ico.js`。窗口图标用 `assets/icon-256.png`，打包用 `assets/icon.ico`。
- 源图不塞进 asar（`package.json` 的 `files` 里已排除），只保留生成后的各尺寸图标。

## 一次性准备

```powershell
cd pdf-reader
npm install --no-audit --no-fund
npm run copy-pdfjs   # 把 pdfjs 的 UMD 构建拷进 src/renderer/pdfjs/
```

> 国内网络若 `npm install` 卡在 Electron 二进制下载：手动跑一次
> `$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"; node node_modules/electron/install.js`。
>
> 如果你在 QoderWork 终端里跑（`ELECTRON_RUN_AS_NODE=1` 由宿主注入），
> 用前先 `Remove-Item Env:\ELECTRON_RUN_AS_NODE`，否则 `electron.exe` 会退化为纯 Node。

## 开发运行

```powershell
npm start
```

窗口打开后：
- 工具栏「打开」/ `Ctrl+O` 选 PDF；
- 直接把 `.pdf` 文件拖进窗口；
- `-` / `+` 或选比例；`Ctrl+滚轮` 缩放；`Ctrl+0` 恢复适应宽度；
- `◀ ▶` 或键盘 ← → / PageUp PageDown 翻页；页码框输入直接跳页。
- 文字批注：「绘制 ▾」选文字 → 点页面落点输入 → **Enter 完成**、**Shift+Enter 换行**、**Esc 取消**。

## 冒烟测试（隐藏窗口，端到端验证）

```powershell
node scripts/make-sample.js        # 生成 3 页样本 assets/sample.pdf
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:SMOKE_PDF = "$PWD\assets\sample.pdf"
& .\node_modules\electron\dist\electron.exe . --no-sandbox --disable-gpu
```

期望 stdout 出现类似：

```
[smoke-result] {"ok":true,"numPages":3,...,"zoomWorks":true,"navWorks":true,"fitWidthWorks":true}
```

进程随后自动退出。

## 标注回归测试

```powershell
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

# 合成 pointer 事件：串页/悬挂/误点/抽稀平滑/多行文字/事件竞态
& .\node_modules\electron\dist\electron.exe scripts\test-pen.js --no-sandbox --disable-gpu
# 期望：[test-pen] PASS

# 真实鼠标（走浏览器输入管线 + 命中测试）—— 合成事件测不到的那类问题只有这里能抓
& .\node_modules\electron\dist\electron.exe scripts\test-real-input.js --no-sandbox --disable-gpu
# 期望：[real-input] PASS（详情见 %TEMP%\pdfreader-real-input.json）

node scripts\test-export.js   # 导出副本：页数不变、体积增大、可重新打开

# 会话记忆端到端（跑真实 app 三次：记页码 → 恢复页码 → 命令行打开改标题）
node scripts\test-session.js
# 期望：[session] PASS (9)

# 懒渲染：只滚 scrollTop（等价滚轮）、不调 scrollToPage，抓「观察器没观察」这类静默故障
& .\node_modules\electron\dist\electron.exe scripts\test-lazy-render.js --no-sandbox --disable-gpu
# 期望：[lazy] PASS
```

## 文献库回归测试

```powershell
# 数据层（纯 Node，临时目录隔离，不碰真实 library.json）
node scripts\test-library.js
# 期望：[library] PASS (51)

Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
# 界面端到端：内部 spawn 真实 app（含 lib-* IPC），执行 libui-check 探针
node scripts\test-library-ui.js
# 期望：[lib-ui] PASS (43)
```

> 若在 PowerShell 里直接 `& electron.exe ...` 发现命令秒退且没有输出，改用
> `Start-Process ... -NoNewWindow -Wait -RedirectStandardOutput out.txt` —— Electron 是 GUI 子系统，
> 某些终端组合下调用方会先返回，输出要等进程真正退出才落盘（测试本身仍在后台跑完）。

## 大文件性能实测

```powershell
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
# offscreen 必须开：隐藏窗口 rAF 会掉到 ~1Hz，测出来的延迟全是假数字
$env:BIG_OFFSCREEN="1"; $env:BIG_PAGES="1200"; $env:BIG_SWEEP="20"
& .\node_modules\electron\dist\electron.exe scripts\perf-big-pdf.js --no-sandbox
# 期望：[perf] PASS（parse/built/usable 三段计时 + 每页光栅成本 + 常驻位图有界性）
```

## 打包 exe

```powershell
# 0) 先确认没有正在运行的实例，否则旧进程锁住 win-unpacked\*.dll 会让 builder 报
#    Access is denied 并留下几十 KB 的残缺 exe
Get-Process | Where-Object { $_.Name -like '*PDF Reader*' } | Stop-Process -Force

$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"

# 1) 常规打包（signAndEditExecutable=false，builder 不动图标）
npx electron-builder --win portable

# 2) 给「应用本体」嵌图标 —— 只对 win-unpacked 里的普通 PE 做
& "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign\837415951\rcedit-x64.exe" `
  "build\win-unpacked\PDF Reader.exe" --set-icon "assets\icon.ico"

# 3) 用已嵌图标的目录重新生成 portable（这一步之后绝不能再碰 rcedit）
npx electron-builder --win portable --prepackaged "build\win-unpacked"

# 4) 验收：体积必须约 70MB+
(Get-Item "build\PDF Reader 1.0.0.exe").Length
```

> ⚠️ **切勿对 portable exe 直接跑 rcedit。** 它是 NSIS 自解压格式，rcedit 重写 PE 资源时会把尾部追加的 app 数据整体丢弃——实测 74,043,319 字节被截成 62,976 字节（只剩 stub），**而退出码仍是 0**，只会静默产出一个双击打不开的残缺文件。

双击 `build\PDF Reader 1.0.0.exe` 即可运行，不需要 `npm start`。

## 目录结构

```
pdf-reader/
├─ package.json
├─ scripts/
│  ├─ copy-pdfjs.js        # 从 node_modules 拷贝 pdfjs UMD 到渲染目录
│  ├─ make-sample.js       # 生成 3 页冒烟样本 assets/sample.pdf
│  ├─ make-icon.js         # 从 assets/icon-source.png 裁切并生成多尺寸 icon-*.png
│  ├─ make-ico.js          # 合成 assets/icon.ico
│  ├─ test-pen.js          # 合成 pointer 事件：串页/悬挂/误点/抽稀/多行/竞态
│  ├─ test-real-input.js   # sendInputEvent 真实鼠标（走命中测试）
│  ├─ test-lazy-render.js  # 只滚 scrollTop，验证懒渲染观察器确实工作
│  ├─ test-export.js       # pdf-lib 导出副本（纯 Node）
│  ├─ test-session.js       # 真实 app 跑三次：记页码/恢复页码/命令行打开
│  ├─ test-library.js       # 数据层：CRUD/多集合/回收站/迁移/持久化/BOM（纯 Node）
│  ├─ libui-check.js        # 库界面探针（在真实渲染进程执行的 DOM 断言脚本）
│  ├─ test-library-ui.js    # 库界面端到端：spawn 真实 app 跑 libui-check 并断言
│  ├─ libui-shot.js         # 截图探针：打开详情面板供 PDFREADER_PROBE_SHOT 抓图
│  └─ perf-big-pdf.js       # 400~1200 页大文件分段计时
├─ src/
│  ├─ main.js               # 窗口/对话框/IPC/菜单/最近打开/页码/命令行/库 IPC/探针钩子
│  ├─ library.js            # 本地库数据层 v2（JSON 索引，零依赖，原子写+损坏/BOM 自愈，v1 自动迁移）
│  ├─ preload.js            # contextBridge：pdfBridge.* 与 pdfBridge.lib.*
│  └─ renderer/
│     ├─ index.html         # 工具栏 + 绘制下拉 + 页容器 + 库覆盖层 + 状态栏
│     ├─ styles.css         # Edge 风浅色扁平
│     ├─ renderer.js        # PDF.js 连续渲染 + 缩放 + 翻页 + 导出 payload
│     ├─ library-ui.js      # 文献库 UI（详情面板/多收藏集/回收站/排序/导入/拖拽）
│     ├─ annotations.js     # 标注：SVG 叠加层 + window 级指针手势
│     └─ pdfjs/            # pdf.min.js / pdf.worker.min.js（npm run copy-pdfjs 生成，已 gitignore）
└─ assets/
   ├─ sample.pdf           # 冒烟样本
   ├─ icon-source.png      # 图标源图（不打包进 asar）
   ├─ icon.ico             # 打包用多尺寸图标
   └─ *.png                # 各尺寸图标
```

## 关键实现点

- **PDF 字节走 IPC**：主进程 `fs.readFileSync` 得到 Buffer，作为 `Uint8Array` 结构化克隆到渲染进程，喂给 `pdfjsLib.getDocument({ data })`。**不用** `file://` 加载，绕开 CSP/worker 老大难。
- **拖拽打开**：渲染进程直接 `File.arrayBuffer()` 拿字节，连 IPC 都省了；只用 `webUtils.getPathForFile()` 单独取一次真实路径，用于进「最近打开」和恢复页码。
- **会话记忆**：`window-state.json` 里 `{width,height,x,y,lastDir,recent:[{path,name,page}]}`；页码按文件记，滚动时去抖 500ms 上报，冷启动带文件参数时用 `pendingOpen` 等 `did-finish-load` 再投递。
- **worker 路径**：`GlobalWorkerOptions.workerSrc = 'pdfjs/pdf.worker.min.js'`（拷贝到项目内，不引 CDN）。
- **高清屏防糊**：`canvas.width = floor(viewport.width*dpr)`、`canvas.style.width = floor(viewport.width)+'px'`，`render()` 传 `transform: [dpr,0,0,dpr,0,0]`。
- **渲染排队**：`pageRendering` 标志 + `pendingPage` 队列，避免翻页/缩放并发时两次 `render` 打架。
- **安全**：`nodeIntegration: false`、`contextIsolation: true`，本地文件读取全部通过 preload 暴露的最小 API；CSP 只允许 self + blob worker。

## 许可

代码 MIT；PDF.js 由 Mozilla 提供，Apache-2.0。
