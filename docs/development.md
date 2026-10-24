# 开发与维护

这份文档写给"下一次打开这个仓库的人"（大概率是未来的你）。目标：十分钟内能把项目跑起来、知道改哪里、知道哪些线不能踩。

## 环境

| 项目 | 要求 |
|---|---|
| 系统 | Windows 10 / 11（只在 Windows 上开发和打包过） |
| Node.js | 18+；开发时用 20 / 22 均可 |
| 包管理 | npm（`package-lock.json` 已提交） |
| 主要依赖 | Electron 31、electron-builder 24、pdfjs-dist 3.11、pdf-lib |
| 原生模块 | 无。这是刻意选的：这台机器编不了 node-gyp，所以全部用纯 JS 方案 |

## 第一次跑

```powershell
cd pdf-reader
npm install --no-audit --no-fund
npm run copy-pdfjs      # 必须：把 pdfjs 的 UMD 构建拷进 src/renderer/pdfjs/
npm start
```

`src/renderer/pdfjs/` 在 `.gitignore` 里，所以每次新克隆 / 新环境都要跑一次 `copy-pdfjs`。

国内下载 Electron 卡住：

```powershell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
node node_modules/electron/install.js
```

终端被 IDE 注入了 `ELECTRON_RUN_AS_NODE=1` 时，Electron 会以 Node 模式启动、看不到窗口：

```powershell
Remove-Item Env:\ELECTRON_RUN_AS_NODE
```

## 目录与职责

| 文件 | 职责 |
|---|---|
| `src/main.js` | 窗口、IPC、打开文档、备份恢复、数据目录、单实例、全文索引调度 |
| `src/preload.js` | `contextBridge` 暴露 `window.pdfBridge`，渲染层唯一入口 |
| `src/library.js` | 库数据层 v8：CRUD、标签、收藏集、回收站、迁移、查重、标注对象、撤销栈 |
| `src/fulltext.js` | 全文索引：建、查、清、状态 |
| `src/docconvert.js` | Word / PPT / Excel / EPUB / Markdown → 安全 HTML |
| `src/formats.js` | BibTeX / RIS / CSL-JSON / EndNote / RefWorks 解析与导出 |
| `src/cite.js` | 5 种引用样式、37 类标识、citekey |
| `src/creators.js` | 作者结构化：姓 / 名 / 角色拆分、归一化、缩写 |
| `src/bib.js` | 参考文献表：排序 / 编号 / 同年 a-b / Markdown 与纯文本 |
| `src/query.js` | 统一检索语法：短语 / 排除 / 14 个字段限定 / 变音折叠（主进程与渲染进程共用） |
| `src/markdown.js` | Markdown 渲染器（UMD，零依赖）+ `fromHtml()` 迁移器 |
| `src/richtext.js` | 富文本 HTML 白名单清洗 + 纯文本提取（UMD） |
| `src/fetchpdf.js` | arXiv / Unpaywall / doi.org 抓 PDF 全文 |
| `src/metadata.js` | Crossref / arXiv 抓取 |
| `src/pdfmeta.js` | 读 PDF 的 Title / Author |
| `src/settings.js` | 设置白名单、原子写、损坏回退 |
| `src/usermigrate.js` | PDF Reader → Trove 的数据目录搬家 |
| `src/renderer/renderer.js` | 阅读器主逻辑（PDF / 富文档 / 缩放 / 翻页 / 标签 / 搜索 / 导出 / 朗读 / 打印） |
| `src/renderer/library-ui.js` | 库界面（列表 / 详情 / 收藏集 / 标签 / 批量 / 设置）+ 全屏 Markdown 笔记编辑器 |
| `src/renderer/annotations.js` | 标注模型与 SVG 渲染 |
| `src/renderer/native-annos.js` | PDF 自带批注（/Annots）读取、坐标转换、去重合并 |
| `src/renderer/selection.js` | 文本层选区、高亮、评论、摘录 |
| `src/renderer/lightbox.js` | 看图模式灯箱 |
| `src/renderer/pdfimages.js` | 从 PDF 操作符定位内嵌位图 |
| `src/renderer/modeswitch.js` | 阅读 / 文献库 双视图切换 |

更细的调用链见 [architecture.md](architecture.md)。

## 测试

### 一键跑

```powershell
Remove-Item Env:\ELECTRON_RUN_AS_NODE
$skip = @('test-pen.js','test-real-input.js','test-lazy-render.js','test-packaged.js')
Get-ChildItem scripts\test-*.js | Where-Object { $skip -notcontains $_.Name } | ForEach-Object {
    node $_.FullName
    if ($LASTEXITCODE -ne 0) { Write-Host "FAIL $($_.Name)" -ForegroundColor Red }
}
```

这样会跑 72 个 Node 驱动的脚本（76 个减去下面 4 个）；`test-packaged.js` 和 3 个直跑 Electron 的脚本单独跑（见下）。

| 类型 | 数量 | 怎么跑 |
|---|---|---|
| 纯 Node | 16 | `node scripts/test-library.js` 等，不需要 Electron |
| Electron 回归 | 56 | `node scripts/test-*.js`，多数经 `probe-runner` spawn Electron 并用 `PDFREADER_PROBE` 注入探针 |
| 打包冒烟 | 1 | `node scripts/test-packaged.js build\Trove-1.2.0-portable.exe` |
| 直跑 Electron | 3 | `electron.exe scripts/test-pen.js` 等，需要真实输入 / 手势 |

### 测试隔离

每个 Electron 测试都自己建临时目录，靠这几条环境变量：

| 变量 | 作用 |
|---|---|
| `PDFREADER_LIBRARY` | 把 `library.json` 钉到临时文件 |
| `PDFREADER_DATA_DIR` | 把索引 / 备份钉到临时目录 |
| `PDFREADER_PROBE` | 指向一个 `module.exports = "(async()=>{...})()"` 的探针脚本 |
| `PDFREADER_PROBE_PDF` | 启动后先把这份文档投给渲染层 |
| `PDFREADER_PROBE_OUT` | 把探针结果写文件（GUI 子系统拿不到 stdout 时用） |
| `PDFREADER_PROBE_SHOT` | 探针跑完后抓一帧 PNG |
| `PDFREADER_PROBE_VISIBLE` | 探针模式也显示窗口（核对布局类改动时必须） |

约定：

- **测试不搬家**。`main.js` 里 `ISOLATED_USER_DATA` 为真时跳过 `runUserDataMigration()`。否则临时 userData 会被塞进真实用户的最近打开和页码——打包冒烟曾因此稳定打开到第 3 页，看起来像"PDF 渲染坏了"。
- **单实例测试要保留锁**。`test-single-instance.js` 用 `PDFREADER_HIDDEN` + `--user-data-dir`，但**不能**被当成 `TEST_MODE`，否则锁被关掉，测试失去意义。
- **隐藏窗口不重绘**。靠截图核对布局时要开 `PDFREADER_PROBE_VISIBLE=1`，否则抓到的是旧帧。
- **隐藏窗口的平滑滚动不可靠**（v33 踩过）：rAF 被限到 ~1Hz，`scrollIntoView({behavior:'smooth'})` 不真正发生，迟到的 IntersectionObserver 还会把页码纠正回实际可见页。断言"跳到第 N 页"的探针先 `App.setViewMode('page')` 切单页模式（不走滚动），或开 `PDFREADER_PROBE_VISIBLE=1`。
- **`--user-data-dir` 会改 Electron 的 userData**（所以迁移逻辑必须跳过它），但库 / 索引的路径仍以 `PDFREADER_DATA_DIR` 为准；测试里两个都设最稳。

### 加一条回归

1. 优先做成纯 Node（数据层、格式化、转换），快且稳。
2. 必须碰 DOM / PDF.js 时，写 `scripts/test-xxx.js`（Node 驱动）+ `scripts/probe-xxx.js`（页面内探针），断言用 `[name, ok, detail]` 三元组。
3. 断言要能指向具体证据：页码、像素尺寸、文件名、错误消息，不要只写 `ok === true`。
4. 修 bug 时先让测试红，再修绿——否则下一个人不知道这条测试在守什么。

### 已知的测试坑

- Electron 是 GUI 子系统，`& electron.exe ...` 可能秒退且没有输出。用：

  ```powershell
  Start-Process -FilePath .\node_modules\electron\dist\electron.exe `
      -ArgumentList @('scripts\test-pen.js', '--no-sandbox', '--disable-gpu') `
      -Wait -NoNewWindow -RedirectStandardOutput out.txt
  ```

- 隐藏窗口的 `requestAnimationFrame` 会降到约 1 Hz。任何依赖 rAF 的等待都会变成"随机超时"。
- **断言"页面上画出了某物"之前先确认那一页渲染完了**。搜索高亮画在 `.hl-layer` 里，元素要等该页 `renderPageNum` 的 promise 兑现才存在；隐藏窗口里渲染是异步的，直接查会得到 0。改成轮询等 `App.state.rendered.get(page)` 为真再断言。
- **功能语义变了，断言要一起改**。`test-v22.js` 曾经按"搜索后不自动跳转"写期望，而 v9 起搜索有命中就会自动落到第一处——断言没跟上，测试红了 4 项。改断言时要在 commit 里写清"为什么旧期望不再成立"，否则下一个人会以为改坏了产品。
- `canvas` 默认尺寸是 300×150，不能用"有尺寸"判断"已渲染"；要量实际位图或像素。
- 合成 `PointerEvent` 会绕过命中测试，画笔类问题要用 `webContents.sendInputEvent()` 注入真实鼠标（`test-real-input.js`）。
- `getDocument({data})` 会把 ArrayBuffer 转移给 worker，之后原 buffer 是 detached 的；测试里别复用同一个 buffer。

## 打包

```powershell
Get-Process | Where-Object { $_.Name -like '*Trove*' } | Stop-Process -Force
npm run copy-pdfjs
npx electron-builder --win dir

# 嵌图标：只对 win-unpacked 里的普通 PE 做
& "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign\837415951\rcedit-x64.exe" `
    "build\win-unpacked\Trove.exe" --set-icon "assets\icon.ico"

# 用已嵌图标的目录出两个包；此后再也不要碰 rcedit
npx electron-builder --win portable --prepackaged "build\win-unpacked"
npx electron-builder --win nsis     --prepackaged "build\win-unpacked"

node scripts\test-packaged.js "build\Trove-1.2.0-portable.exe"
```

### 三条铁律

1. **绝不对 portable exe 跑 rcedit。** portable 是 NSIS 自解压格式，rcedit 重写 PE 资源会把尾部 app 数据整体丢掉。实测 74 MB 变成 63 KB，**退出码仍然是 0**，只留下一个双击打不开的文件。
2. **`build.files` 必须包含 pdfjs-dist 的主进程构建**：`build/pdf.js`、`build/pdf.worker.js`、`cmaps/`、`standard_fonts/`。少了它，asar 里的主进程建全文索引会报 `Cannot find module`。
3. **`--prepackaged` 必须带目录**：`--prepackaged "build\win-unpacked"`。只写 `--prepackaged` 会抛 `The "paths[1]" argument must be of type string`。

### 图标

```
assets/icon-source.png      ← 1024×1024 成品图（已裁白边）
  scripts/make-icon.js      → icon-{256,128,64,48,32,16}.png
  scripts/make-ico.js       → icon.ico（6 个尺寸的 PNG 条目）
```

换图标时：新图先跑 `scripts/crop-icon.js <in> <out>` 裁掉白边和投影，覆盖 `icon-source.png`，再跑 `make-icon.js`、`make-ico.js`，最后重新打包（图标是编译进 exe 的，不重新打包不会变）。

### 安装包验证

```powershell
# 静默安装到临时目录，跑冒烟，再卸载
.\build\Trove-Setup-1.2.0.exe /S /D=$env:TEMP\TroveInstall
& "$env:TEMP\TroveInstall\Trove.exe" --no-sandbox --disable-gpu
```

NSIS 安装包默认装到当前用户目录（`%LOCALAPPDATA%\Programs\Trove`），不需要管理员权限；卸载时用户数据默认保留（`deleteAppDataOnUninstall: false`）。

## 工程约定

这些是踩过的坑，不是风格偏好。

1. **渲染层模块末尾显式 `window.X = X`。** 全局 `const` 不会挂到 `window` 上，另一个脚本里 `window.X` 会是 `undefined`。
2. **别用 `requestAnimationFrame` 做"必须执行"的事。** 隐藏窗口不触发；用时间节流或加 `setTimeout` 兜底。
3. **两个 IntersectionObserver 不能合并。** 预渲染区和"当前页"必须分开，否则页码提前跳。
4. **单页模式别让观察器管渲染。** 快照乱序会把刚渲染的页 free 掉，白一块且不自愈。
5. **别在 `pointermove` 里读布局属性**（`offsetWidth` 等）。初始化时量好缓存，否则拖动会掉帧。
6. **别用 CSS `transform: scale()` 放大大位图。** 纹理超限会整块不画（"放大后变白"）。按显示分辨率重绘，CSS 只做平移。
7. **异步弹层要带代号。** 每个 `await` 后校验"请求仍是最新 + 模式没变"，否则会出现"阅读模式莫名弹灯箱"。
8. **删除只删索引。** 删条目、删收藏集、清空回收站都不碰磁盘文件；富文档同样适用。
9. **转换结果必须 sanitize。** 新增格式不要绕过 `clean()`；只允许 `data:` 图片。
10. **字体只有一套。** `--font-serif` / `--font-mono` 都指向 `--font-sans`，不要再引入 Georgia / Times。
11. **列表单击只选中，不重画。** `library-ui.js` 的单击走 `markSelection()`；调 `renderGrid()` 会替换节点，`dblclick` 永远不触发。
12. **数据迁移里别用会 `load()` 的 id 生成器。** 迁移发生在 `load() → normalize` 内部，递归会把栈打爆、库被当损坏文件重置。用不碰 store 的本地生成器。
13. **去掉菜单项前，先写下每个功能的去处。** 菜单是"藏功能"的地方，功能不能跟着消失。
14. **给页面加视觉处理时，检查灯箱 / 缩略图 / 导出。** 否则同一张图在三处颜色不一致。

## 排错

| 现象 | 先查什么 |
|---|---|
| `npm start` 没窗口 | `ELECTRON_RUN_AS_NODE` 是否还在；`src/renderer/pdfjs/` 是否存在 |
| 窗口空白 / 控制台 404 | 忘了 `npm run copy-pdfjs` |
| 打包后索引报 `Cannot find module` | `build.files` 漏了 pdfjs-dist 的 `build/` / `cmaps/` / `standard_fonts/` |
| 打包后页面空白，开发模式正常 | 先确认 portable 有没有被 rcedit 动过；再跑 `test-packaged.js` |
| 测试打开到第 3 页 | 迁移把真实用户数据搬进了临时 userData；检查 `ISOLATED_USER_DATA` |
| 单实例测试一跑就过 / 双开不拦 | `TEST_MODE` 把 `PDFREADER_HIDDEN` 也算进去了 |
| 数据目录改名后找不到库 | userData 跟 `package.json` 的 `name` 走，不是 productName |
| `git push` 连不上 github.com | 先重试；仍不行用 `git -c http.sslBackend=schannel push origin main` |
| 双击安装包一闪就退，向导都没出来 | 直接重试；并发大文件 I/O / 杀软扫描时 NSIS 从 `%TEMP%\nsXXXX.tmp` 加载插件 DLL 会失败（事件查看器里是 `System.dll` 访问冲突 `0xc0000005`）。反复失败就先退掉正在跑的旧版，或直接用 portable |
| 安装包"静默装成功"但装回了旧目录 | electron-builder 把上次的 `InstallLocation` 记在 `HKCU\Software\<GUID>`；换目录装前先删这个键，否则静默安装会沿用旧路径 |
| 放大后页面左半边看不见 / 水平滚不到头 | flex 容器 `align-items: center` 的超宽子项会向左右**各溢出一半**，左侧溢出滚不到。`#pages` 用 `align-items: safe center`（溢出时退回 `start`）；别改回纯 `center` |
| 放大模式下按空格却翻页了 | `switch` 里空格原本走 `nextPage()`；放大模式要拦下来当手形工具的修饰键，别漏了 `keyup` 复位 |

## 发布清单

- [ ] 16 个纯 Node 回归全过
- [ ] 50 个 Electron 回归全过（至少 library-ui / csl-ui / richdoc / reader-plus / backup / datadir / single-instance / note-editor / rich-anno / undo / search / native-annos；另有 3 个直跑 Electron 的探针）
- [ ] `npx electron-builder --win dir` → rcedit → portable + nsis
- [ ] `node scripts/test-packaged.js "build\Trove-<版本>-portable.exe"` 17 项全过
- [ ] 安装包静默安装 → 启动 → 卸载，快捷方式与安装目录清理干净
- [ ] 更新 `CHANGELOG.md`（版本号在 `package.json`）
- [ ] 更新 README / docs 里的版本号、测试数量与"已知边界"（功能变了边界也会变）
- [ ] 推送 `main`（`git ls-remote origin main` 对一下本地 HEAD）
- [ ] 打并推送 tag：`git tag -a v<版本> -m "Trove <版本>"` → `git push origin v<版本>`
- [ ] 建 GitHub Release 并上传安装包（`gh` 不在 PATH，用完整路径）：
      `C:\Users\24256\AppData\Local\Programs\gh-cli\bin\gh.exe release create v<版本> --repo shi-tou1234/cmchen-document --title "Trove <版本>" --notes-file <说明> "build\Trove-<版本>-portable.exe" "build\Trove-Setup-<版本>.exe"`
- [ ] `gh release view v<版本> --json assets` 核对两个附件的 `size` 与本地字节数一致、`isDraft=false`、`isPrerelease=false`

> 打 tag 后别忘 Release：只推代码和 tag 的话，仓库页面的 Releases 里仍然是旧版本（1.2.0 就是这么漏的）。

## 版本与分支

- 分支只有一个：`main`。提交信息用 conventional commits（`feat:` / `fix:` / `docs:` / `refactor:`）。
- 版本号只在用户确认后改；改名不自动等于升版本。升版本时 `package.json` 与 `package-lock.json` 一起改，README / docs 里出现的产物文件名与测试数量也要跟着改。
- 数据层版本（`library.js` 的 `VERSION`）和应用版本无关，改数据结构时才升，并同时写迁移与回归。
- **数据层升版本后要 grep 全部测试里的 `version === N` 断言**，别只改新写的那个测试（v8 时 `test-v23.js` 与 `test-creators.js` 就漏了 4 处）。
