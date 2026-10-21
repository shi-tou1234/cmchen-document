# PDF Reader

> 本地优先的轻量 **PDF 阅读器 + 文献库**。Electron + PDF.js + pdf-lib，纯 HTML/CSS/JS，零原生依赖。

它做的事：把一堆 PDF 收进一个本地文献库（标签 / 收藏集 / 全文检索 / 元数据），用顺手的阅读器逐篇读、逐页标注，再把批注和引用导出成能用的东西。

**不是 Zotero 的替代品。** 这里只做 Zotero 的「A 块地基」——条目 / 标签 / 收藏集 / 阅读标注；没有同步、群组库、CSL 引用、浏览器抓取器（详见 [已知边界](#已知边界)）。数据全在本地，不联网也能用。

---

## 有什么

| 模块 | 能力 |
|---|---|
| **文献库** | 条目与元数据 · 标签 · 多级收藏集 · 智能收藏集（保存搜索条件）· 标签选择器 · 回收站与还原 · 查重合并 · 批量编辑 · BibTeX/RIS 导入导出 · DOI/arXiv 元数据抓取 · 复制引用（GB/T 7714-2015 / APA 7） |
| **阅读器** | 连续滚动 + 懒渲染（400–1200 页实测流畅）· 适应宽度/页面/百分比缩放 · 多标签页 · 记住每份文件的页码 · 目录 / 缩略图 / 批注侧栏 · 文档内全文搜索 · **看图模式：点页面里的图片放大看原图** · 最近打开 · 单实例 |
| **标注** | 画笔 · 荧光笔 · 直线 · 矩形 · 箭头 · 文字 · 便签 · 橡皮擦 · 撤销 / 清除本页 · 选中文字高亮 + 评论 · 自动保存 · 导出带标注的 PDF 副本 · 导出批注为 **Markdown / CSV / TXT** |
| **检索** | 库级全文索引（后台自动建，AND 多关键词，片段 + 页码）· 命中结果直接跳页 |
| **数据** | 全部本地 JSON：库 `library.json`、标注按路径哈希存、全文索引可重建不进备份 · 一键备份 / 恢复（恢复前自动快照）· 数据目录可迁移 / 合并 / 替换 · 浅色 / 深色主题 |

**永久约定：任何删除入口都不碰磁盘上的 PDF。** 删条目、删收藏集、清空回收站都只动索引。

---

## 快速开始

```powershell
cd pdf-reader
npm install --no-audit --no-fund
npm run copy-pdfjs      # 把 pdfjs 的 UMD 构建拷进 src/renderer/pdfjs/（新环境必跑）
npm start
```

> 国内网络下载 Electron 卡住：`$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"; node node_modules/electron/install.js`  
> 终端里若有 `ELECTRON_RUN_AS_NODE=1`（某些 IDE 注入），跑 Electron 前先 `Remove-Item Env:\ELECTRON_RUN_AS_NODE`。

现成的产物（免安装）：`build\PDF-Reader-1.0.0-portable.exe`，或 `build\PDF-Reader-Setup-1.0.0.exe`（NSIS 安装包）。

---

## 快捷键

| 按键 | 作用 | 按键 | 作用 |
|---|---|---|---|
| `Ctrl+O` | 打开 PDF | `Ctrl+F` | 文档内全文搜索 |
| `Ctrl+滚轮` | 缩放 | `Ctrl+0` | 适应宽度 |
| `←` `→` `PgUp` `PgDn` `空格` | 翻页 | `Home` `End` | 首页 / 末页 |
| `Ctrl+Z` | 撤销标注 | `Ctrl+S` | 导出带标注的 PDF 副本 |
| `V` `P` `H` `L` `R` `A` `T` `N` `E` | 切换工具（看图/画笔/荧光/直线/矩形/箭头/文字/便签/橡皮） | `Esc` | 回选择 / 取消输入 / 关闭弹窗 |

文字批注：`Enter` 完成、`Shift+Enter` 换行、`Esc` 取消。

看图：按 `V` 或点工具栏第二个按钮（放大镜）进入「看图」模式，再点页面任意位置即弹灯箱——点到位图给**原图像素**（照片放多大都不糊），点到位图之外给那一块的**高清重渲染**（矢量手写、插图同样清晰）。灯箱里滚轮缩放、拖拽平移、`←` `→` 换图、`Esc` 关闭。

换文档：点工具栏右上角的文件名，弹出「切换文档」面板（当前标签 / 最近打开 / 文献库，可搜索），点一下直接换，不用回文献库。

---

## 数据放在哪

| 内容 | 位置 |
|---|---|
| 文献库 | `<数据目录>\library.json`（v3） |
| 标注 | `<userData>\annotations\<sha1(路径)>.json` |
| 全文索引 | `<数据目录>\fulltext\<hash>.json`（可重建，不进备份） |
| 设置 | `<userData>\settings.json` |
| 最近打开 / 窗口位置 | `<userData>\window-state.json` |

备份 = 设置 + 库 + 标注（不含 PDF 本体与索引）。数据目录可在「设置 → 存储位置」里换，三种模式：move / merge / replace。

---

## 回归测试

24 个脚本，全部失败即非零退出。跑之前先 `Remove-Item Env:\ELECTRON_RUN_AS_NODE`。

| 脚本 | 覆盖 |
|---|---|
| `node scripts/test-library.js` | 数据层 v3：CRUD / 回收站 / 迁移 / 查重合并 / 批量 / 导入去重 / 持久化（82） |
| `node scripts/test-fulltext.js` | 全文索引 / 搜索 / 新鲜度 / 容错（36） |
| `node scripts/test-formats.js` | BibTeX / RIS 解析与导出（59） |
| `node scripts/test-settings.js` | 设置白名单 / BOM / 损坏自愈（22） |
| `node scripts/test-metadata.js` | DOI / arXiv 抓取（fake fetch，47） |
| `node scripts/test-cite.js` | 引用格式化：GB/T 7714 + APA（33） |
| `node scripts/test-export.js` | pdf-lib 导出管线（纯 Node） |
| `node scripts/test-session.js` | 真实 app 三次：记页码 → 恢复页码 → 命令行打开（9） |
| `node scripts/test-single-instance.js` | 真实双开 + PDF 转交（7） |
| `node scripts/test-selection.js` | 选区高亮 / 评论 / 侧栏 / 笔记（14） |
| `node scripts/test-tabs.js` | 多标签开 / 切 / 关，标注不丢（14） |
| `node scripts/test-ui-v11.js` | 全文检索 / 智能收藏集 / 批量 / 设置 / 备份 |
| `node scripts/test-ui-v12.js` | 查重 / 合并 / 详情 / 导入导出 IPC |
| `node scripts/test-library-ui.js` | 库界面端到端（43） |
| `node scripts/test-export-highlight.js` | 真实选区 → 导出 → 重开，验证高亮烧进 PDF（12） |
| `node scripts/test-backup-restore.js` | 备份 / 恢复 / pre-restore 快照（32） |
| `node scripts/test-datadir.js` | 数据目录 move / merge / replace（19） |
| `node scripts/test-reader-plus.js` | 阅读器端到端：文本层 / 搜索 / 缩略图 / 标注恢复（17） |
| `node scripts/test-bugfix.js` | 跨文档撤销隔离 / 页码指示 / 搜索清空 / 库退路 / 缩放 / 键盘（21） |
| `node scripts/test-v14.js` | 标签选择器 / 复制引用 / 批注多格式导出（29） |
| `node scripts/test-imageview.js` | 看图模式：定位内嵌位图 → 灯箱放大 / 缩放 / 翻页 / 关闭（16） |
| `node scripts/test-v18.js` | 工具带常驻 / 工具快捷键 / 导入读 PDF 元数据 / 文档快速切换（20） |
| `node scripts/test-packaged.js` | 打包产物冒烟（15） |
| `electron.exe scripts/test-pen.js` | 画笔：串页 / 悬挂 / 误点 / 抽稀平滑 / 多行 / 竞态 |
| `electron.exe scripts/test-real-input.js` | 真实鼠标（走命中测试）——合成事件抓不到的那类问题 |
| `electron.exe scripts/test-lazy-render.js` | 只滚 scrollTop，验证懒渲染观察器工作 |

> Electron 是 GUI 子系统，PowerShell 里 `& electron.exe ...` 可能秒退且没输出，改用
> `Start-Process ... -NoNewWindow -Wait -RedirectStandardOutput out.txt`。

冒烟（隐藏窗口，真实启动）：

```powershell
$env:SMOKE_PDF = "$PWD\assets\sample.pdf"
& .\node_modules\electron\dist\electron.exe . --no-sandbox --disable-gpu
# 期望：[smoke-result] {"ok":true,"numPages":3,...}
```

---

## 已知边界

- **没有同步 / 群组库 / 浏览器抓取器 / 完整 CSL**：多设备、协作、网页抓取、自动插入引用都做不到。
- **引用不是完整 CSL**：只内置 GB/T 7714-2015 与 APA 7 两种；作者是逗号分隔的字符串，没有姓/名/角色结构，APA 不做姓名拆分，也没有引文数据库。
- **导出 PDF 副本里的文字标注只支持 Latin-1**：中文/日文文字标注会被跳过（图形标注不受影响）——内置字体是 Helvetica，要支持 CJK 得嵌字体。
- **标注按路径哈希存储**：移动或重命名 PDF 后旧标注不会跟随，需要重新定位附件。
- **文献库是 JSON**：几千条够用，再大建议上 SQLite。
- **单窗口、Windows 优先**：macOS / Linux 没有打包验证。
- **全文检索是子串匹配**：不做分词、不做相关性排序。

---

## 打包

```powershell
Get-Process | Where-Object { $_.Name -like '*PDF Reader*' } | Stop-Process -Force
npm run copy-pdfjs
npx electron-builder --win dir
# 嵌图标（只对 win-unpacked 里的普通 PE 做）
& "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign\837415951\rcedit-x64.exe" "build\win-unpacked\PDF Reader.exe" --set-icon "assets\icon.ico"
# 用已嵌图标的目录重新生成两个包（这一步之后绝不能再碰 rcedit）
npx electron-builder --win portable --prepackaged "build\win-unpacked"
npx electron-builder --win nsis     --prepackaged "build\win-unpacked"
node scripts\test-packaged.js "build\PDF-Reader-1.0.0-portable.exe"
```

> ⚠️ **切勿对 portable exe 直接跑 rcedit**：它是 NSIS 自解压格式，rcedit 重写 PE 资源会把尾部 app 数据整体丢弃（实测 74MB 被截成 63KB，**退出码仍是 0**），只留下一个双击打不开的残缺文件。  
> ⚠️ `build.files` 必须包含 `pdfjs-dist` 的主进程构建（`build/pdf.js`、`build/pdf.worker.js`、`cmaps/`、`standard_fonts/`），否则打包后主进程建全文索引会报 `Cannot find module`。

---

## 目录结构

```
pdf-reader/
├─ src/
│  ├─ main.js            # 窗口 / IPC / 菜单 / 备份恢复 / 单实例 / 数据目录
│  ├─ library.js         # 本地库数据层 v3
│  ├─ fulltext.js        # 主进程全文索引
│  ├─ settings.js        # 设置读写
│  ├─ formats.js         # BibTeX / RIS
│  ├─ metadata.js        # DOI / arXiv 抓取
│  ├─ pdfmeta.js         # 读 PDF 自带元数据（Title/Author），导入时自动填表
│  ├─ cite.js            # 引用格式化（GB/T 7714 + APA）
│  ├─ preload.js         # contextBridge
│  └─ renderer/          # index.html · styles.css · renderer.js · library-ui.js
│                        # annotations.js · selection.js · lightbox.js · pdfimages.js
│                        # docswitch.js
├─ scripts/              # 26 个回归脚本 + 探针 + 打包/图标/样本工具
└─ assets/               # sample.pdf · icon.ico …
```

---

版本演进记录见 [CHANGELOG.md](CHANGELOG.md)，交接细节见 [HANDOFF.md](HANDOFF.md)。
