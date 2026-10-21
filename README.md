# Trove

**把文档收进一个库，然后一篇一篇读完。** Trove 是一个本地优先的文档管理器兼阅读器：PDF、Word、PPT、Excel、Markdown、EPUB 都能进同一个文献库，标签、收藏集、全文检索、逐页标注共用一套数据。没有账号，没有云同步，所有东西都在你自己的磁盘上。

![文献库](docs/screenshot-library.png)

> 名字取自 a trove——一批被收起来、值得留下的东西。

---

## 它是什么

一个自用的桌面软件，解决三件事：

1. **找得到**——文件散在十几个文件夹里时，用标题、作者、标签、收藏集或全文搜索把它翻出来。
2. **读得下去**——连续滚动或单页翻页，记住每份文档读到第几页，长文档也只在视口附近渲染。
3. **记得住**——画笔、荧光笔、文字、便签、选区高亮，标注跟着文档走；读完能导出成 Markdown、CSV 或带标注的 PDF 副本。

它站在**文档/档案**这一侧，不是"又一个 PDF 查看器"：打开只是入口，库才是主体。启动后先看到文献库，点条目才进阅读；关掉再开，页码、标签、批注都还在。

![阅读器](docs/screenshot-reader.png)

## 它不是什么

- **不是 Zotero 的替代品。** 只做 Zotero 的"地基"部分：条目、标签、收藏集、阅读标注。没有同步、群组库、浏览器抓取器，也没有完整的 CSL 引用引擎（详见[已知边界](#已知边界)）。
- **不是网盘。** 不登录、不上传、不检查更新。断网可用。
- **不是排版软件。** Word / PPT / Excel 会被转成"阅读版"：保留文字、标题、列表、表格和图片，不还原分栏、文本框定位、动画和图表。

---

## 功能特性

### 文献库

- **条目与元数据**：37 类条目（期刊文章、会议论文、学位论文、图书、报告、网页……），标题 / 作者 / 年份 / 来源 / 卷期页 / DOI / URL / 摘要 / 语言 / 自定义字段。
- **多条阅读笔记**：一条文献可以挂任意多条笔记，各自有标题和正文（Zotero 的 item / child-item 模型）。
- **标签与收藏集**：标签可重命名、合并、全局移除、设颜色；收藏集支持多级嵌套和颜色；还有保存搜索条件的**智能收藏集**。
- **整理**：回收站与还原、查重合并、批量编辑、拖入收藏集、表头排序、Ctrl / Shift 多选、`↑` `↓` + `Enter` 打开。
- **导入导出**：BibTeX / RIS / CSL-JSON，导入时按 DOI 或"标准化标题 + 年份"去重；DOI / arXiv 元数据抓取。
- **引用**：GB/T 7714-2015、APA 7、Chicago 17、IEEE、MLA 9 五种样式；确定性 citekey 与 `[@key]`；相关条目双向关联；按选中条目 / 当前列表 / 整库生成 Markdown 或纯文本参考文献表，可附 citekey。

### 阅读

- **两种阅读方式**：连续滚动（默认）/ 单页翻页，设置里可切，也可用页面右键菜单临时切。
- **全格式**：PDF 走 PDF.js，保留文本层；Word / PPT / Excel / Markdown / EPUB / RTF / ODT / 图片 / 代码由主进程转成安全 HTML。
- **懒渲染**：只画视口附近的页，离开就释放位图；实测 400–1200 页的文档滚动不卡。
- **缩放**：适应宽度 / 适应页面 / 实际大小 / 20%–600%，缩放时保持当前阅读位置。
- **多标签页**：同一份文件只开一个标签，切换不丢标注；也可以手动开新标签。
- **导航**：目录（带页码）、缩略图、页码输入、最近打开、文档快速切换面板。
- **看图模式**：点 PDF 里的内嵌图片看原图像素；多层位图会先合成再显示；工具栏 `◐` 可切原色 / 跟随页面反色。
- **专注阅读（F11）**：收掉工具栏、标签栏、状态栏和侧栏，只留页面。
- **夜读**：深色主题下可选择把页面反色。

### 标注与笔记

- 画笔、荧光笔、直线、矩形、箭头、文字、便签、橡皮擦；撤销 / 清除本页。
- 选中文字高亮、写评论、**摘录**（quote），批注可加标签、可搜索。
- 复制正文自动附出处（文档名 + 页码）。
- 自动保存；导出带标注的 PDF 副本；导出批注为 Markdown / CSV / TXT；一键汇总全部文档的批注。
- 标注是矢量层，缩放、重渲染、翻页回收都不影响；文字高亮用页面单位坐标，换缩放不漂。

### 检索

- 库级全文索引在后台建，可随时重建；索引按路径哈希存 JSON，不进备份。
- 搜索同时覆盖**正文、批注、摘录、阅读笔记**，结果带来源徽标、页码和片段，点一下直接跳页。
- AND 多关键词、子串匹配；不做分词和相关性排序（见边界）。

### 数据

- 全部本地 JSON：库、设置、标注、索引；没有数据库、没有原生模块。
- 一键备份 / 恢复；恢复前自动写快照；坏备份会被拒绝而不是覆盖现有数据。
- 数据目录可迁移 / 合并 / 替换（move / merge / replace）。
- 浅色 / 深色 / 跟随系统；全软件统一字体栈。

> **永久约定：任何删除入口都不碰磁盘上的文档。** 删条目、删收藏集、清空回收站都只动索引；卸载软件也不会删库和标注（`deleteAppDataOnUninstall: false`）。

---

## 支持格式

| 类别 | 扩展名 | 阅读方式 |
|---|---|---|
| PDF | `.pdf` | PDF.js 渲染，保留文本层、搜索、标注、导出 |
| Word | `.docx` `.doc` `.rtf` `.odt` | `.docx` 保留标题 / 列表 / 表格 / 图片；`.doc` 取纯文本；RTF / ODT 转 HTML |
| 演示 | `.pptx` `.odp` | 每页一张幻灯片，含文字与内联图片；旧 `.ppt` 请先另存为 `.pptx` |
| 表格 | `.xlsx` `.xls` `.ods` `.csv` | 每个工作表一页，首行作表头；单表最多 2000 行 × 80 列 |
| Markdown / 网页 | `.md` `.markdown` `.html` `.htm` | 按一级标题分章；本地图片内联，远程图片和脚本剥离 |
| 电子书 | `.epub` | 每章一页，章节图片内联 |
| 图片 | `.png` `.jpg` `.jpeg` `.gif` `.webp` `.bmp` `.svg` `.avif` | 单页查看 |
| 纯文本 / 代码 | `.txt` `.log` `.json` `.xml` `.yaml` `.ini` `.toml` `.js` `.ts` `.py` `.java` `.c` `.cpp` `.go` `.rs` `.sql` `.tex` `.srt` `.vtt` 等 | 纯文本显示，自动识别 UTF-8 / UTF-16 / GB18030 |

富文档同样支持页码、缩放和页内搜索；但**画笔类标注和"导出带标注副本"只对 PDF 开放**。转换有硬上限：400 页、12 MB HTML、单张图片 8 MB，超出会截断而不是拖死进程。

---

## 安装与运行

### 现成产物

打包好的 Windows 版本在 `build/` 下（不随仓库提交）：

- `Trove-1.1.0-portable.exe`——免安装，双击即用。
- `Trove-Setup-1.1.0.exe`——NSIS 安装包，装到当前用户目录，带开始菜单 / 桌面快捷方式。

未签名，Windows SmartScreen 可能提示"未知发布者"，选择"仍要运行"即可。

### 从源码跑

```powershell
cd pdf-reader
npm install --no-audit --no-fund
npm run copy-pdfjs      # 把 pdfjs 的 UMD 构建拷进 src/renderer/pdfjs/，新环境必跑
npm start
```

要求 Node 18+（开发时用 Node 20 / 22 均可）和 Windows 10/11。国内下载 Electron 卡住时：

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
node node_modules/electron/install.js
```

如果终端里被 IDE 注入了 `ELECTRON_RUN_AS_NODE=1`，跑 Electron 前先：

```powershell
Remove-Item Env:\ELECTRON_RUN_AS_NODE
```

---

## 界面与快捷键

顶部没有原生菜单栏：打开用工具栏，导出和专注模式在页面右键菜单，备份恢复和默认阅读器在文献库的"设置"里。

| 按键 | 作用 | 按键 | 作用 |
|---|---|---|---|
| `Ctrl+O` | 打开文档 | `Ctrl+F` | 文档内搜索 |
| `Ctrl+滚轮` | 缩放 | `Ctrl+0` | 适应宽度 |
| `←` `→` `PgUp` `PgDn` `空格` | 翻页 | `Home` `End` | 首页 / 末页 |
| `Ctrl+Z` | 撤销标注 | `Ctrl+S` | 导出带标注的 PDF 副本 |
| `V` `P` `H` `L` `R` `A` `T` `N` `E` | 看图 / 画笔 / 荧光 / 直线 / 矩形 / 箭头 / 文字 / 便签 / 橡皮 | `Esc` | 回选择 / 取消输入 / 关闭弹层 |
| `F11` | 专注阅读模式 | `Ctrl+Shift+P` | 导出当前页为 PNG |
| `F3` / `Shift+F3` | 下一个 / 上一个搜索命中 | `Ctrl+Shift+I` | 开发者工具 |

文字批注：`Enter` 完成、`Shift+Enter` 换行、`Esc` 取消。

**换文档**：点工具栏右上角的文件名，弹出"切换文档"面板（当前标签 / 最近打开 / 文献库，可搜索），点一下直接换，不用先回库。

**看图**：按 `V` 进入看图模式，点页面里的图片弹灯箱；滚轮缩放、拖拽平移、`←` `→` 换图、`Esc` 关闭。点空白只会提示"这里没有内嵌图片"；想放大任意区域，用页面右键菜单里的"放大看这一块"。

---

## 数据、备份与迁移

| 内容 | 位置 |
|---|---|
| 文献库 | `<数据目录>\library.json`（数据层 v5） |
| 标注 | `<userData>\annotations\<sha1(路径)>.json` |
| 全文索引 | `<数据目录>\fulltext\<hash>.json`（可重建，不进备份） |
| 设置 | `<userData>\settings.json` |
| 最近打开 / 窗口位置 | `<userData>\window-state.json` |
| 备份 | `<数据目录>\backups\` |

默认数据目录就是 Electron 的 userData：`%APPDATA%\trove`。可以在"设置 → 存储位置"里换盘，三种模式：

- **move**：把当前库写到目标目录（目标已有库会被覆盖），索引一并拷过去，设置指向新目录；旧目录的文件保留，不会删。
- **merge**：读入目标库，再把当前库的条目并进去；同 key 保留目标目录那条，缺的收藏集 / 搜索条件补上。
- **replace**：用目标目录里已有的库替换当前库（切换前会自动写一份 `pre-move` 快照）。

备份 = 设置 + 库 + 标注，不含 PDF 本体和索引。恢复前会自动写 `pre-restore-*.json`，坏备份不会被应用。

> **改名前叫 PDF Reader。** 老数据目录是 `%APPDATA%\pdf-reader`（Electron 的 userData 跟着 `package.json` 的 `name` 走，不是 productName）。首次启动 Trove 时会自动把老目录内容搬到 `%APPDATA%\trove`：只补缺、不覆盖、`Singleton*` 锁文件不搬；搬失败就继续用老目录。改名前生成的备份（`app` 字段是 `pdf-reader`）也能直接恢复。

---

## 打包

```powershell
Get-Process | Where-Object { $_.Name -like '*Trove*' } | Stop-Process -Force
npm run copy-pdfjs
npx electron-builder --win dir
# 只给 win-unpacked 里的普通 PE 嵌图标
& "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign\837415951\rcedit-x64.exe" `
    "build\win-unpacked\Trove.exe" --set-icon "assets\icon.ico"
# 用已嵌图标的目录生成两个包；这一步之后绝不能再碰 rcedit
npx electron-builder --win portable --prepackaged "build\win-unpacked"
npx electron-builder --win nsis     --prepackaged "build\win-unpacked"
node scripts\test-packaged.js "build\Trove-1.1.0-portable.exe"
```

三条铁律（都踩过）：

1. **绝不对 portable exe 跑 rcedit。** 它是 NSIS 自解压格式，rcedit 重写 PE 资源会把尾部数据整体丢掉（实测 74 MB 变成 63 KB，退出码还是 0）。
2. **`build.files` 必须包含 pdfjs-dist 的主进程构建**（`build/pdf.js`、`build/pdf.worker.js`、`cmaps/`、`standard_fonts/`），否则打包后主进程建全文索引会报 `Cannot find module`。
3. **`--prepackaged` 后面必须带目录**，不能只写 `--prepackaged`，否则 electron-builder 会抛参数类型错误。

图标链路：`scripts/crop-icon.js`（裁白边）→ `assets/icon-source.png` → `scripts/make-icon.js`（多尺寸 PNG）→ `scripts/make-ico.js`（`icon.ico`）。

---

## 测试

39 个 `test-*.js`，全部以非零退出码表示失败。跑之前先 `Remove-Item Env:\ELECTRON_RUN_AS_NODE`。

**纯 Node（10 个）**

| 脚本 | 覆盖 |
|---|---|
| `test-library.js` | 数据层 v5：37 类条目 / fields / relations / 颜色 / CRUD / 回收站 / 迁移 / 查重合并 / 批量 / 持久化（82） |
| `test-fulltext.js` | 全文索引 / 搜索 / 新鲜度 / 容错（36） |
| `test-formats.js` | BibTeX / RIS / CSL-JSON 解析与导出（77） |
| `test-settings.js` | 设置白名单 / BOM / 损坏自愈（22） |
| `test-metadata.js` | DOI / arXiv 抓取，fake fetch（47） |
| `test-cite.js` | 5 种引用样式 + 37 类标识 + citekey / `[@key]`（71） |
| `test-bib.js` | 参考文献表：编号 / 作者排序 / 拼音 / 同年 a-b / Markdown / citekey（33） |
| `test-docconvert.js` | 全格式转换 + sanitize + 图片内联（31） |
| `test-export.js` | pdf-lib 导出管线 |
| `test-usermigrate.js` | 改名搬家：只补缺 / 不覆盖 / 跳过 Singleton / 失败回退（19） |

**真实 Electron（26 个）**

| 脚本 | 覆盖 |
|---|---|
| `test-richdoc.js` | 打开 docx / xlsx / epub：转换 / 渲染 / 缩放 / 搜索 / 页码 / 标签 / 选区摘录（14） |
| `test-session.js` | 记页码 → 恢复页码 → 命令行打开（9） |
| `test-single-instance.js` | 双开 + 文档转交（7） |
| `test-selection.js` | 选区高亮 / 评论 / 摘录 / 侧栏 / 笔记（8） |
| `test-tabs.js` | 多标签开 / 切 / 关，标注不丢（5） |
| `test-ui-v11.js` | 全文检索 / 智能收藏集 / 批量 / 设置 / 备份（13） |
| `test-ui-v12.js` | 查重 / 合并 / 详情 / 导入导出 IPC（11） |
| `test-library-ui.js` | 库界面端到端：Zotero 交互 / citekey / 颜色 / 相关条目 / 排序 / 多选 / 参考文献表（68） |
| `test-export-highlight.js` | 真实选区 → 导出 → 重开，验证高亮烧进 PDF（7） |
| `test-backup-restore.js` | 备份 / 恢复 / pre-restore 快照 / 旧备份兼容（20） |
| `test-datadir.js` | 数据目录 move / merge / replace（19） |
| `test-reader-plus.js` | 文本层 / 搜索 / 缩略图 / 标注恢复（9） |
| `test-bugfix.js` | 跨文档撤销隔离 / 页码指示 / 搜索清空 / 缩放 / 键盘（13） |
| `test-v14.js` | 标签选择器 / 复制引用 / 批注多格式导出（16） |
| `test-imageview.js` | 看图模式：定位内嵌位图 → 灯箱 / 缩放 / 翻页 / 触控板连发不闪（6） |
| `test-v18.js` | 工具带常驻 / 工具快捷键 / 快速切换 / 导入读元数据（13） |
| `test-v19.js` | 首次提示 / 工具分组 / 引用样式 / 批注搜索与标签（18） |
| `test-v20.js` | 专注模式 / 右键菜单 / 批注 Markdown 引用 / 深色反色（11） |
| `test-v21.js` | 缩放保持位置 / 标签重命名与全局移除 / 导出全部批注（6） |
| `test-v22.js` | 单页 / 滚动双模式 / 搜索上下跳 / 大纲页码（3） |
| `test-v23.js` | 多条阅读笔记：v3→v4 迁移 / 增删改 / 导出兼容（10） |
| `test-v25.js` | 大图放大：位图不超原图 / 不炸合成纹理 / 放大更清晰（6） |
| `test-v26.js` | 顶部菜单已移除 / 字体统一 / 设置新增项 / 右键有专注模式（4） |
| `test-v27.js` | 灯箱观感 / 预览底色 / 便签重开与修改（5） |
| `test-v28.js` | 多层图合成 / 反色跟随 / 灯箱关闭 / 阅读模式不误弹（14） |
| `test-packaged.js` | 打包产物冒烟：PDF / 索引 / 搜索 / 导出 / docx（17） |

另外 3 个直接跑 Electron 的探针：

```
electron.exe scripts/test-pen.js          # 画笔：串页 / 悬挂 / 误点 / 抽稀 / 多行 / 竞态
electron.exe scripts/test-real-input.js   # 真实鼠标（sendInputEvent），合成事件测不出的问题
electron.exe scripts/test-lazy-render.js  # 只滚 scrollTop，验证懒渲染观察器
```

> Electron 是 GUI 子系统，PowerShell 里 `& electron.exe ...` 可能秒退且拿不到输出；改用
> `Start-Process ... -Wait -RedirectStandardOutput out.txt`。

跑测试的约定和坑见 [docs/development.md](docs/development.md)。

---

## 已知边界

- **没有同步 / 群组库 / 浏览器抓取器 / 完整 CSL**：多设备、协作、网页抓取、自动插入引用都做不到（CSL-JSON 只能换数据，不能渲染样式）。
- **引用不是完整 CSL**：作者是逗号分隔的字符串，没有姓 / 名 / 角色结构；APA 不做姓名拆分，也没有引文数据库。参考文献表只做排序、编号和 Markdown 包装，不做完整 CSL 渲染。中文作者没有拼音库时，citekey 退化为 `item` + 条目 key 前缀。
- **非 PDF 是"阅读版"而不是原样排版**：复杂分栏、文本框定位、动画、SmartArt、图表不会还原；旧 `.ppt` 不支持，`.doc` 只取纯文本。
- **富文档没有 PDF 标注层**：画笔、荧光笔、便签、导出带标注副本只对 PDF 开放；富文档可以选中文字复制 / 摘录，摘录写进该条目的阅读笔记。
- **安全优先会牺牲内容**：转换结果统一 sanitize，脚本、事件属性、远程图片会被剥离。需要联网的图片请先下载到本地。
- **导出 PDF 里的文字标注只支持 Latin-1**：中文 / 日文文字标注会被跳过（图形标注不受影响）——内置字体是 Helvetica，要支持 CJK 得嵌字体。
- **标注按路径哈希存储**：移动或重命名 PDF 后旧标注不会跟随，需要在库里的"附件重定位"重新指回去。
- **文献库是 JSON**：几千条够用，再大建议上 SQLite。
- **单窗口、Windows 优先**：macOS / Linux 没有打包验证。
- **全文检索是子串匹配**：不做分词、不做相关性排序。

---

## 代码地图

```
pdf-reader/
├─ src/
│  ├─ main.js            # 窗口 / IPC / 打开文档 / 备份恢复 / 单实例 / 数据目录
│  ├─ preload.js         # contextBridge，渲染层唯一的 Node 入口
│  ├─ library.js         # 数据层 v5（JSON + 原子写 + 迁移）
│  ├─ fulltext.js        # 主进程全文索引
│  ├─ docconvert.js      # 全格式 → 安全 HTML
│  ├─ formats.js         # BibTeX / RIS / CSL-JSON
│  ├─ cite.js            # 引用格式化 + citekey
│  ├─ bib.js             # 参考文献表：排序 / 编号 / Markdown
│  ├─ metadata.js        # DOI / arXiv 抓取
│  ├─ pdfmeta.js         # 读 PDF 自带 Title / Author
│  ├─ settings.js        # 设置读写
│  ├─ usermigrate.js     # PDF Reader → Trove 数据搬家
│  └─ renderer/          # index.html / styles.css / renderer.js / library-ui.js
│                        # annotations.js / selection.js / lightbox.js / pdfimages.js / docswitch.js
├─ scripts/              # 39 个回归脚本 + 探针 + 图标 / 样本工具
├─ assets/               # 样本 PDF、图标源图与多尺寸 PNG / ICO
├─ docs/                 # README 截图、架构与开发文档
└─ build/                # electron-builder 产物（不进仓库）
```

架构细节见 [docs/architecture.md](docs/architecture.md)；开发、测试、打包与踩坑见 [docs/development.md](docs/development.md)；版本记录见 [CHANGELOG.md](CHANGELOG.md)。

## 许可

MIT。第三方库的许可见各自的 LICENSE（PDF.js 为 Apache-2.0）。
