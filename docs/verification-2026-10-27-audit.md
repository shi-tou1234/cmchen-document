# 审核报告 B01–B12 与两轮复查 R01–R05 修复记录 · 2026-10-27

对象：三轮外部审核（基于提交 `ac60e34` 的工作区）共报出 17 项问题——首轮 12 项（B01–B12）、复查追加 4 项（R01–R04）、二次复查追加 1 项（R05）。三份审核报告是过程记录，结论已并入本文并随发版清理；本文是这轮修复的长期记录。只改源码、测试与文档，未改动真实文献库。

## 结论

B01–B12 与 R01–R05 **共 17 项全部修复**，各自补了回归。全量源码回归 **95 个 `test-*.js` 脚本通过**（其中 92 个 Node 驱动、3 个直跑 Electron：pen / lazy-render / real-input），另 `test-packaged` 未跑（本轮未打包，旧产物不代表当前源码）。

### 复查追加项（R01–R04）

| 编号 | 级别 | 状态 | 改动 | 回归 |
| --- | --- | --- | --- | --- |
| R01 重叠书签操作丢失 | P2 | 已修复 | 同一文档的书签操作改为**串行队列**：每次基于上一次「已成功落盘」的工作副本构造候选，成功后提交、失败只回滚界面；首次操作前等书签读盘完成 | test-audit-fixes（并发/串行/成功失败组合 10 组）、test-bookmarks（真实 IPC 并发 + 磁盘回读） |
| R02 进行中渲染未被回收 | P2 | 已修复 | 新增 `activeRenders` 记录在渲染页；`freePagesExcept` 同时回收「已渲染」与「渲染中」；渲染回写校验任务身份与文档代际，过期任务不再把离屏页标成已渲染 | test-two-page（快速跳页后只保留当前页组、离屏画布归零） |
| R03 混合 CDATA 空格丢失 | P2 | 已修复 | 根因是 `xmlDecode` 自带 trim；改为只解码不裁剪，字段各段原样拼接后统一规范化空白 | test-audit-fixes（8 组混排用例） |
| R04 审核脚本提前退出 | P2 | 已修复 | 重写为单一 async 入口，`await` 全部检查后才汇总；补 `window` 替身；断言只收集不抛出；连续操作改为「保留全部有效动作」的预期；并断言异步用例确实执行 | 脚本自身退出码 + 用例计数 |
| R05 旧队列切文档后仍写盘 | P1 | 已修复 | 队列改为**按文件路径跨代际共享**（重新打开沿用同一条链、只换基线）；任务在发 IPC 前再校验路径与代际，切走/关闭/重开后未发送的任务直接取消；落盘成功即推进队列工作副本（界面仍按代际过滤） | test-audit-fixes（切走 / A→B→A / 关闭 三组）、test-bookmarks |

R01 的并发用例在真实 Electron（preload + 主进程 + 隔离 sidecar）里跑过：`Promise.all([bookmarkToggle(1), bookmarkToggle(3)])` 后内存与磁盘都是 `[1,2,3]`；同页连按两次回到 `[1,2,3]`。

R02 的复现条件是「上一组还没渲染完就跳页」。测试里连续 6 次无等待跳页后，`rendered` 只剩当前对开组 `4,5`，第 1–3 页画布尺寸归零。

R05 的关键在「任务真正开始时」而不是「入队时」：上一版只在入队前校验归属，旧队列里排着的任务仍会发 IPC。现在发请求前再校验一次，并且队列按路径共享，重新打开同一份文档不会再出现两条并行覆盖磁盘的链。回归里把这道校验临时去掉后，5 项 R05 断言立即失败（旧队列写出 `[2,3]`、A→B→A 变成 `[2,3,4]`），说明用例确实咬住了这个缺陷。

| 编号 | 原级别 | 状态 | 主要改动 | 回归 |
| --- | --- | --- | --- | --- |
| B01 书签回包覆盖新文档 | P1 | 已修复 | 请求绑定路径 + `loadSeq`；`restoreAnnos` 同样按路径与代际校验 | test-audit-fixes、test-bookmarks |
| B02 合并漏订阅 | P1 | 已修复 | `combineStores` 纳入 `feeds`：URL 去重、同 ID 换 ID、标题与 addedAt 规则 | test-audit-fixes、test-datadir（move/merge） |
| B03 书签保存失败不回滚 | P2 | 已修复 | 先构造候选、成功后提交；失败保持原状态并提示可重试；IPC 异常同路径 | test-audit-fixes（单次失败/重试/抛异常 + R01 的成败组合） |
| B04 EndNote XML 样式混入 | P2 | 已修复 | 字段取 XML 文本内容（内联标签、CDATA、实体、十六进制实体）；Book Section → `bookSection`；属性单双引号 | test-audit-fixes（含 R03 混排）、test-enw-xml |
| B05 条件构建器有损 | P2 | 已修复 | 隐式 AND 拆行、别名归一、`""` 转义；OR/括号整串保留为 `raw` 并禁止有损应用；顺带修掉列表查询被强制小写导致 `OR` 失效 | test-audit-fixes、test-query-builder |
| B06 进度条错列 | P2 | 已修复 | `.lc-readbar` 改为卡片底边绝对定位，退出六列网格 | test-reading-progress（几何断言） |
| B07 对开遗留搭档位图 | P2 | 已修复 | `freePagesExcept(当前页组)`；连续模式切入对开也清理 | test-two-page（含 R02 快速跳页） |
| B08 富文档继承对开 | P2 | 已修复 | `effectiveViewMode()`：布局、可见性、观察器、导航统一读有效模式 | test-richdoc（8 项） |
| B09 跨页首次反查失败 | P2 | 已修复 | 行缓存按页存、按页序组合、页号 + 行对象定位；普通文本提前返回 | test-smart-jump（首次点击即反查） |
| B10 组行下标混用 | P2 | 已修复 | 行内插入比较回查原始 `items` | test-audit-fixes、test-smart-jump |
| B11 Atom 单引号属性 | P2 | 已修复 | `href` / `rel` 支持单双引号；命名空间前缀；alternate 优先级不变；`id` 单独保留 | test-audit-fixes、test-feed |
| B12 「添加年份」口径 | P3 | 已修复 | 新增 `byCreated`（入库年份），面板分列「出版年份」「入库年份」 | test-audit-fixes、test-lib-stats |

## 验证明细

| 脚本 | 结果 | 覆盖 |
| --- | --- | --- |
| test-audit-fixes（新增） | 83 / 83 | B01/B03/R01/R05 用源码原函数 + 受控 IPC 时序；B02/B04/R03/B05/B10/B11/B12 纯逻辑 |
| test-reading-progress | 15 / 15 | B06：标题与操作同一行、收藏集未右移、已读/未读行高一致、条形贴底 |
| test-two-page | 28 / 28 | B07：旧搭档页释放、画布尺寸归零、连续跳页后已渲染页 ≤ 2；R02：无等待快速跳页后只剩当前组、离屏画布归零 |
| test-richdoc | 40 / 40 | B08：spread 偏好下富文档按单页显示、跳页只显示目标页、切回连续恢复 |
| test-smart-jump | 18 / 18 | B09：新文档首次直接点条目即反查 2 处；B10 组行 |
| test-bookmarks | 13 / 13 | B01/B03 既有流程；R01：真实 IPC 并发加两页、同页连按两次，内存与磁盘一致 |
| test-datadir | 21 / 21 | B02：move / merge 都保留订阅 |
| test-query-builder | 18 / 18 | B05：OR 查询打开面板后应用不改写、结果不变 |
| test-lib-stats | 11 / 11 | B12：出版年份与入库年份分列 |
| test-enw-xml / test-feed | 通过 | B04 / B11 的既有断言未回退 |

全量：`scripts/test-*.js` 共 96 个，其中 `test-packaged.js` 需要已构建产物，本轮跳过；其余 95 个全部通过。三个直跑 Electron 的脚本按开发文档用 `electron.exe --no-sandbox` 运行，均 PASS（用 `node` 运行会因 `require('electron')` 拿不到 app 而失败，不是产品问题）。

## 顺带修掉的两个小问题

- 库列表的快速筛选在解析前把整条查询 `toLowerCase()`，`OR` / `AND` 作为大小写敏感运算符因此失效（`title:a OR title:b` 退化成三个普通词）。现在保留原始大小写交给 `Query.parseQuery`，词本身仍由 `fold` 折叠。
- 阅读时长落盘失败时，渲染进程已经把增量从 `pending` 里摘走，失败即丢；现在失败会合回待写队列、节流提示，并在打开统计面板前主动 flush（原先最多滞后约 150 秒）。

## 复查后仍保留的建议（未实施）

- 审核报告「可优化项」里的笔记互链稳定身份与回收站排除、RSS 请求代际 / 去重 / 取消、`probe-runner` 拒绝零断言、按功能拆分 `renderer.js` / `library-ui.js`。
- 中文文字标注导出仍受 Helvetica 编码限制（F03 的既有边界）。

## 未做的部分（审核报告「可优化项」）

- 智能跳转的局部识别与参考文献区从尾部扫描：本轮只做了「不像引用/条目不扫描全文」的提前返回，未改扫描顺序。
- 笔记互链的稳定身份与回收站排除、RSS 请求的代际/去重/取消、`probe-runner` 拒绝零断言、按功能拆分 `renderer.js` / `library-ui.js`：仍待后续规划。
- 中文文字标注导出仍受 Helvetica 编码限制（F03 的既有边界），本轮未动。

## 收尾

改动文件：`src/library.js`、`src/formats.js`、`src/query.js`、`src/feedparse.js`、`src/libstats.js`、`src/smartjump.js`、`src/renderer/renderer.js`、`src/renderer/library-ui.js`、`src/renderer/styles.css`、`src/renderer/index.html`；新增 `scripts/test-audit-fixes.js`；更新 `CHANGELOG.md`、`docs/architecture.md`、`docs/development.md`。未暂存、提交或推送，未重新打包。
