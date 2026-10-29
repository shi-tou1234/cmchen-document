'use strict';
/*
 * 生成《Trove 与 Zotero 功能差距评估报告》更新版 PDF（2026-10-29，第六版）。
 * 第五版新增第四章：与 9 款同类产品的横向对照，并据此重排缺口清单。
 * 第六版把「对齐度」表里仍标「仍差」、且不在「明确不做」清单内的四项全部补齐（citekey 模板、
 * 批注属性 / 数量条件与 is empty、标注嵌套回复树、笔记导出 Word），并对齐度逐模块给出新分数。
 * 用 Electron 的 printToPDF 渲染 HTML（中文字体走系统，别引额外依赖）。
 * 运行：npx electron scripts/make-report.js
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');

const OUT_DIR = 'C:/Users/24256/Desktop';
const OUT = path.join(OUT_DIR, 'Trove与Zotero功能差距评估报告.pdf');
const BACKUP = path.join(OUT_DIR, 'Trove与Zotero功能差距评估报告-2026-10-27备份.pdf');
const PROJECT_COPY = path.join(__dirname, '..', '..', 'Trove与Zotero功能差距评估报告.pdf');

const HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<style>
  @page { size: A4; margin: 15mm 13mm 14mm; }
  * { box-sizing: border-box; }
  body {
    font-family: "Microsoft YaHei", "PingFang SC", "SimSun", sans-serif;
    font-size: 9.9pt; line-height: 1.6; color: #22262b; margin: 0;
  }
  h1 { font-size: 19pt; margin: 0 0 1.6mm; letter-spacing: .5px; }
  .sub { color: #6b7280; font-size: 9pt; margin-bottom: 4.5mm; }
  h2 {
    font-size: 12.6pt; margin: 6.5mm 0 2.4mm; padding-bottom: 1.1mm;
    border-bottom: 1px solid #e3e6ea; page-break-after: avoid;
  }
  h3 { font-size: 10.5pt; margin: 4.2mm 0 1.5mm; color: #2f3540; page-break-after: avoid; }
  p { margin: 1.5mm 0; }
  table { width: 100%; border-collapse: collapse; margin: 2mm 0 3mm; font-size: 9pt; }
  th, td { border: 1px solid #e1e4e8; padding: 1.3mm 1.8mm; text-align: left; vertical-align: top; }
  th { background: #f4f6f8; font-weight: 600; color: #3a4250; }
  td.c, th.c { text-align: center; white-space: nowrap; }
  tr { page-break-inside: avoid; }
  thead { display: table-header-group; }
  tbody { break-inside: auto; }
  table.m { font-size: 8.1pt; }
  table.m th, table.m td { padding: 1mm 1.2mm; }
  .ok { color: #1a7f4b; font-weight: 600; }
  .part { color: #a3690a; font-weight: 600; }
  .gap { color: #a33; font-weight: 600; }
  .unk { color: #9aa1ab; }
  .tag { display: inline-block; font-size: 8.2pt; padding: 0 .4mm; border-radius: 2px; }
  .t-done { background: #e7f5ec; color: #1a7f4b; }
  .t-no { background: #fdeeee; color: #a33; }
  .t-mid { background: #fdf4e3; color: #8a5a00; }
  ul { margin: 1.4mm 0 2mm; padding-left: 4.6mm; }
  li { margin: .7mm 0; }
  .note {
    background: #f7f8fa; border-left: 3px solid #c9cfd7; padding: 2mm 2.8mm;
    margin: 2.6mm 0; font-size: 8.9pt; color: #4a5260;
  }
  .kpi { display: flex; gap: 2.6mm; margin: 2.6mm 0 2mm; }
  .kpi div {
    flex: 1; border: 1px solid #e1e4e8; border-radius: 3px; padding: 2.2mm 2.6mm; background: #fbfcfd;
  }
  .kpi b { display: block; font-size: 14pt; color: #1f2733; }
  .kpi span { font-size: 8.2pt; color: #6b7280; }
  footer { margin-top: 5mm; font-size: 8.2pt; color: #9aa1ab; border-top: 1px solid #eef0f2; padding-top: 1.8mm; }
  .avoid-break { break-inside: avoid; }
</style></head><body>

<h1>Trove 与 Zotero 功能差距评估报告</h1>
<div class="sub">2026-10-29 更新版（第六版）· 评估对象：Trove 未发布版（v1.4.0 之上，含检索 worker、回顾、第三轮审核修复、第四轮对齐补齐）· 本版新增：把「仍差」清单里还能补的四项补齐，逐模块重算对齐度</div>

<div class="note">
  <b>这一版做了什么</b>：上一版（同一天早些时候）把横向对照做完，结论是「剩下的硬缺口只有三笔老账」。但那份对齐度表里还有四行写着「仍差」，
  而这四项都不在「明确不做」清单里——既然不在，就没有理由留着。于是本版把它们一次做完：<b>citekey 可配模板</b>（JabRef 那套）、
  <b>检索的批注属性条件与数量条件 / <code>is empty</code></b>（Zotero 高级检索）、<b>标注的嵌套回复树</b>、<b>笔记导出 Word</b>。
  做第四项时对比三种导出，顺带发现 <code>Md.fromHtml</code> 把表格拍平了——Markdown / HTML / Word 三条路一起中招，一并修掉。
  对齐度因此从 <b>92%</b> 提到 <b>94%</b>，每一分的来处都在第三章逐行写明。
</div>

<h2>一、这一版的变化</h2>
<table class="avoid-break">
  <thead><tr><th style="width:14%">方向</th><th style="width:46%">做了什么</th><th style="width:40%">为什么值得单独记一笔</th></tr></thead>
  <tbody>
  <tr>
    <td><b>引用</b></td>
    <td>写死的取键规则换成模板引擎：<code>[字段:修饰符:修饰符]</code> + 字面量，8 个字段（<code>auth</code> / <code>authIni</code> /
      <code>year</code> / <code>title</code> / <code>shorttitle</code> / <code>veryshorttitle</code> / <code>key</code> / <code>type</code>）
      × 4 类修饰符（<code>lower</code> / <code>upper</code> / <code>abbr</code> / 数字截断）；设置里给预设按钮与实时预览</td>
    <td>改造的<b>唯一前提</b>是默认模板与旧算法逐字符等价——老用户的键已经进了论文、进了别人的 <code>.bib</code>。
      做法是把旧算法原样抄成对照实现、在随机夹具上对拍，57 项里一半是这件事</td>
  </tr>
  <tr>
    <td><b>检索</b></td>
    <td>新增 <code>advsearch.js</code>（278 行，纯数据无 DOM）：18 个字段、5 组运算符、且/或；批注条件覆盖
      标注数 / 有标注 / 标注类型 / 标注颜色 / 标注文字或批注 / 标注带批注；条件可存为智能收藏集，生效时顶部出横幅</td>
    <td>批注数据本来就在渲染层，为几个条件搬进主进程只会多一层 IPC 和一份不一致的缓存。两条检索路线（串式快筛 / 条件精确）
      刻意<b>并存而不互译</b>：把「标注数 &gt; 3」编译成串式只能自造方言，而且 <code>is empty</code> 与「没填这个条件」翻不回来</td>
  </tr>
  <tr>
    <td><b>标注</b></td>
    <td>按 <code>replyTo</code> 重建父子树：任意层缩进 + 竖线引导；父标注被筛掉时子标注升格为顶层，数据成环时用
      <code>seen</code> 集合截断</td>
    <td>导入时一直只存了 <code>/IRT</code> 关系、界面平铺一层。Zotero 的回复本身还能被回复，这是「读别人的标注」时最常见的结构，
      平铺会让对话读串</td>
  </tr>
  <tr>
    <td><b>笔记</b></td>
    <td>导出下拉新增「Word…」：输出带 mso 命名空间与 <code>@page{size:A4}</code> 的 Word HTML，Word / WPS 直接打开可编辑</td>
    <td>不引 <code>docx</code> 依赖（几十 MB，还要进打包），Word 对这套格式兼容二十年没变过；代价是没有真页眉页脚与样式表，
      在报告与「边界」里都写明</td>
  </tr>
  <tr>
    <td><b>顺手修</b></td>
    <td><code>Md.fromHtml</code> 增加整块 <code>&lt;table&gt;</code> → Markdown 表格转换：保留表头、转义单元格里的 <code>|</code></td>
    <td>做 Word 导出时对比三种格式才发现：原来表格被拍平成几行文字，单元格之间没有任何分隔。Word 就是从这份 Markdown 派生的，
      HTML 也经它清洗，所以<b>三种导出一起好了</b></td>
  </tr>
</tbody>
</table>

<h2>二、能力对照（上一版 → 当前）</h2>
<table>
  <thead><tr><th style="width:15%">模块</th><th style="width:30%">上一版（10-27）</th><th style="width:38%">当前（10-29）</th><th style="width:17%">结论</th></tr></thead>
  <tbody>
  <tr>
    <td><b>检索</b></td>
    <td>可视化条件构建器、分页与类型切换已通；查询与统计仍在主进程</td>
    <td>检索与索引迁到 worker（崩溃自动退回进程内，两条路结果必须一致）；索引增量补建 + 广播 + 建完自动重跑查询；
      并在这一版补上<b>条件面板</b>：18 个字段 × 5 组运算符、且/或、批注属性条件、<code>is empty</code>，可存为智能收藏集</td>
    <td class="c"><span class="tag t-done">已补齐</span></td>
  </tr>
  <tr>
    <td><b>标注</b></td>
    <td>原生批注导入与回复关系已通；缺嵌套回复树</td>
    <td>回复树补齐：按 <code>/IRT</code> 建父子 Map，任意层缩进 + 竖线引导，父被筛掉时子升格、成环时截断；
      另有「回顾」出口（整批或只纳入选中，移出复习不删标注）</td>
    <td class="c"><span class="tag t-done">已补齐</span> 缺字体子集</td>
  </tr>
  <tr>
    <td><b>笔记</b></td>
    <td>KaTeX 公式、<code>[[标题]]</code> 互链与反链已通；缺表格可视化</td>
    <td>导出新增 <b>Word</b>（Markdown / HTML / Word 三种格式共用一份 Markdown 中间产物）；顺手修掉表格在导出里被拍平的
      老 bug（<code>fromHtml</code> 现按 GFM 表格整块转换）</td>
    <td class="c"><span class="tag t-done">已补齐</span> 缺表格编辑</td>
  </tr>
  <tr>
    <td><b>组织</b></td>
    <td>多集合并集、统计面板、阅读队列已通</td>
    <td>组织延伸到「复习」：标注 → 卡片 → 到期时间，形成「读 → 标 → 记 → 复习」闭环</td>
    <td class="c"><span class="tag t-done">延伸</span> 缺群组库</td>
  </tr>
  <tr>
    <td><b>阅读器</b></td>
    <td>对开 / 旋转 / 分屏 / 跨页朗读 / 书签 / 智能跳转已通</td>
    <td>无变化（本轮不动阅读器）。跨文档对照仍是手动选文件，未做「按引用自动跟随」</td>
    <td class="c"><span class="tag t-mid">未动</span> 缺 reflow</td>
  </tr>
  <tr>
    <td><b>引用</b></td>
    <td>文内引注定位符、智能跳转已通；CSL 为自研子集；citekey 确定性生成</td>
    <td><b>citekey 可配模板</b>：<code>[auth:lower][year][veryshorttitle:lower]</code> 为默认，8 字段 × 4 类修饰符，设置里带预设与实时预览；
      默认模板与旧算法逐字符等价，详情面板与所有导出即时生效</td>
    <td class="c"><span class="tag t-done">已补齐</span> 缺同上 / 前引</td>
  </tr>
  <tr>
    <td><b>抓取与发现</b></td>
    <td>RSS / Atom 订阅、批量抓取、网页快照已通</td>
    <td>无变化。仍不做机构代理与后台轮询</td>
    <td class="c"><span class="tag t-mid">未动</span></td>
  </tr>
  <tr>
    <td><b>导入导出</b></td>
    <td>EndNote XML、RTF、备份携带资源已通</td>
    <td>笔记导出增加 Word；备份 payload 携带回顾进度段（老备份没有该字段时不动现有进度），恢复时整份替换</td>
    <td class="c"><span class="tag t-done">已带上</span> 缺 RDF / MARC</td>
  </tr>
  <tr>
    <td><b>可靠性</b></td>
    <td>三轮审核 17 个缺陷闭环</td>
    <td>第三轮 P2（主文档切换竞态）闭环：进销毁前抓住旧实例、每段 <code>await</code> 后重新校验代际、页块构建逐页校验、标签只写给自己</td>
    <td class="c"><span class="tag t-done">已闭环</span></td>
  </tr>
</tbody>
</table>

<h2>三、对齐度与工程质量</h2>
<p>这一版的分数是<b>补出来的</b>，不是改判分口径改出来的：表格里每一行都注明「哪一项补齐了、为什么只涨这么多」，没补的仍原样留着。
加权后从 <b>92%</b> 到 <b>94%</b>——涨幅不大，因为补的这四项本身就只占 Zotero 能力表里的一小块；真正压分的仍是三笔老账
（中文标注字体、参考文献表批量入库、reflow）与一批「跨应用」能力（Word 活引用、同上 / 前引、群组库）。</p>

<div class="kpi">
  <div><b>94%</b><span>与 Zotero 加权对齐度（92% → 94%）</span></div>
  <div><b>4 项</b><span>「仍差」清单里本轮补齐（且不在不做清单内）</span></div>
  <div><b>+196</b><span>本轮新增断言（57 + 101 + 38）</span></div>
  <div><b>112</b><span>仓库内 test-*.js 脚本</span></div>
</div>

<table>
  <thead><tr><th style="width:22%">模块</th><th class="c" style="width:11%">第五版</th><th class="c" style="width:11%">当前</th><th>依据 / 剩余差距</th></tr></thead>
  <tbody>
  <tr><td>检索</td><td class="c">95%</td><td class="c">97%</td><td><b>补齐</b>批注属性条件（6 个）、数量条件、<code>is empty</code>、且/或、存为智能收藏集。仍差：条件组的<b>嵌套</b>（Zotero 支持条件组套条件组，我们只有一层平铺）、正则与「距今 N 天」这类动态条件</td></tr>
  <tr><td>标注</td><td class="c">95%</td><td class="c">97%</td><td><b>补齐</b>嵌套回复树（任意层、父筛掉子升格、成环截断）。仍差：扁平化批注恢复、中文文字标注的字体子集（老账）</td></tr>
  <tr><td>笔记</td><td class="c">93%</td><td class="c">95%</td><td><b>补齐</b>导出 Word，顺带修掉表格在导出里被拍平。仍差：表格的可视化编辑（现在只能写 Markdown 表格）、笔记内的图片缩放</td></tr>
  <tr><td>组织</td><td class="c">96%</td><td class="c">96%</td><td>无变化。仍差群组库（决定不做）；智能收藏集现在多了一种「条件式」，但不算对齐度增量以外的东西</td></tr>
  <tr><td>引用</td><td class="c">88%</td><td class="c">91%</td><td><b>补齐</b>citekey 模板（8 字段 × 修饰符，默认值与旧算法等价）。仍差：同上 / 前引（ibid. / op. cit.）、作者消歧、COinS、Word 活引用（跨应用，不做）</td></tr>
  <tr><td>阅读器</td><td class="c">93%</td><td class="c">93%</td><td>无变化。仍差 reflow 重排（Reading Mode）、印章（Okular 味）</td></tr>
  <tr><td>抓取与发现</td><td class="c">82%</td><td class="c">82%</td><td>无变化。仍差机构代理、Find Full Text 式多源聚合</td></tr>
  <tr><td>导入导出</td><td class="c">90%</td><td class="c">92%</td><td><b>补齐</b>笔记导出 Word。仍差 RDF / MARC、EndNote 的附件路径还原</td></tr>
</tbody>
</table>
<p class="note">口径说明：一个模块内部按「Zotero 有、我们也该有」的能力条目计数，跨应用能力（Word 插件、群组库、移动端）在<b>分母里保留、不给满分</b>，
所以这几个模块的天花板本来就压在 90% 上下——这也是加权总分一直上不去的原因，属于<b>结构性的</b>，不是没干活。</p>

<h3>3.1 工程质量（不与 Zotero 比，跟自己比）</h3>
<table class="avoid-break">
  <thead><tr><th style="width:22%">指标</th><th style="width:16%">改前</th><th style="width:16%">当前</th><th>说明</th></tr></thead>
  <tbody>
  <tr><td>查询期间主进程响应</td><td>176 ms（最大往返）</td><td class="ok">2 ms</td><td>400 份合成索引（每份 25 页），查询在跑同时连发 8 次 <code>lib-summary</code>；进程内模式保留为对照，只记录不设门槛</td></tr>
  <tr><td>索引状态查询</td><td>每条目一次 stat + 读索引头</td><td class="ok">worker 批量算</td><td>一万条时原来是一万次同步 IO，现在主进程只收一串布尔</td></tr>
  <tr><td>导入后的可检索时间</td><td>要手动点「重建索引」</td><td class="ok">自动排队，建好即可搜</td><td>建完广播 <code>ft-index-idle</code>，检索面板自动重跑当前查询</td></tr>
  <tr><td>标注利用率</td><td>只能检索 / 导出 / 生成笔记</td><td class="ok">+ 到期复习 + 回复树</td><td>标注从「一层平铺的文本」变成「有结构、有后续动作」的对象</td></tr>
  <tr><td>引用键可控性</td><td>8 个字符的机器键，不可改</td><td class="ok">模板 + 修饰符 + 实时预览</td><td>默认模板对拍旧算法（57 项里一半是对拍），老键不会因为这次改造变形</td></tr>
  <tr><td>笔记导出格式</td><td>Markdown / HTML / PDF</td><td class="ok">+ Word（HTML 伪装，零依赖）</td><td>不引 <code>docx</code>，代价是页眉页脚与样式表；表格导出同时修好（原来被拍平）</td></tr>
</tbody>
</table>

<h2>四、竞品横向对照（第五版引入，本版更新状态列）</h2>

<h3>4.1 对照对象与口径</h3>
<p>选品标准：要么直接对标（Zotero），要么在某一类工作流上做到极致、值得抄一个具体做法（Sioyek / LiquidText / MarginNote / Readwise），
要么与 Trove 的技术前提接近（JabRef / Okular / calibre / Paperless-ngx / Koodo）。<b>只记录能找到出处的能力</b>，图上用四种符号：
<span class="ok">✓</span> 有、<span class="part">△</span> 部分、<span class="gap">—</span> 无、<span class="unk">·</span> 本次未核实（不参与判断）。</p>

<table class="m">
  <thead><tr><th style="width:14%">产品</th><th style="width:20%">定位</th><th style="width:36%">这次要看的是</th><th style="width:30%">来源</th></tr></thead>
  <tbody>
  <tr><td>Zotero</td><td>文献管理器（直接对标）</td><td>10.x 的进阶能力与投稿级引用细节</td><td>zotero.org 变更日志 / support 文档</td></tr>
  <tr><td>Sioyek</td><td>面向论文与教材的阅读器</td><td>Smart Jump、Overview、Portals、视觉标尺、命令面板</td><td>sioyek.info、仓库 README</td></tr>
  <tr><td>LiquidText</td><td>「主动阅读工作区」</td><td>摘录拖到画布、跨页连线、多文档并排</td><td>liquidtext.net/features</td></tr>
  <tr><td>MarginNote 4</td><td>摘录 → 脑图 → 复习</td><td>摘录自动成卡、遮挡回忆、FSRS 复习、卡片标题自动链接</td><td>marginnote.com、MN4 手册</td></tr>
  <tr><td>Readwise / Reader</td><td>高亮汇总 + 每日复习</td><td>Daily Review 的配额与评分交互</td><td>readwise.io、官方博客</td></tr>
  <tr><td>JabRef</td><td>BibTeX 文献管理器</td><td>citekey 模板与修饰符、XMP 写回、Lucene 全文索引</td><td>docs.jabref.org</td></tr>
  <tr><td>Okular</td><td>KDE 万能文档查看器</td><td>批注类型齐全度（印章）、sidecar、归档格式、表单与签名</td><td>okular.kde.org、KDE 发布说明</td></tr>
  <tr><td>calibre</td><td>电子书库</td><td>阅读统计、元数据批量下载、虚拟库</td><td>calibre 手册</td></tr>
  <tr><td>Paperless-ngx</td><td>文档管理（OCR）</td><td>OCR、自动标签、相似文档</td><td>docs.paperless-ngx.com</td></tr>
  <tr><td>Koodo Reader</td><td>电子书阅读</td><td>书架进度、内置翻译、TTS</td><td>koodoreader.com</td></tr>
</tbody>
</table>

<h3>4.2 阅读与标注</h3>
<table class="m">
  <thead><tr>
    <th style="width:26%">能力</th><th class="c">Trove</th><th class="c">Zotero</th><th class="c">Sioyek</th>
    <th class="c">LiquidText</th><th class="c">MarginNote</th><th class="c">Okular</th>
  </tr></thead>
  <tbody>
  <tr><td>连续滚动 / 翻页 / 目录缩略图</td><td class="c ok">✓</td><td class="c ok">✓</td><td class="c ok">✓</td><td class="c ok">✓</td><td class="c ok">✓</td><td class="c ok">✓</td></tr>
  <tr><td>双页对开</td><td class="c ok">✓</td><td class="c ok">✓</td><td class="c ok">✓</td><td class="c unk">·</td><td class="c ok">✓</td><td class="c ok">✓</td></tr>
  <tr><td>页面旋转 0–270°</td><td class="c ok">✓</td><td class="c ok">✓</td><td class="c ok">✓</td><td class="c unk">·</td><td class="c unk">·</td><td class="c ok">✓</td></tr>
  <tr><td>并排 / 分屏对照</td><td class="c ok">✓ 只读参考 + 跨文档</td><td class="c ok">✓ 第二视图</td><td class="c ok">✓ 第二窗口</td><td class="c ok">✓ 最多三篇</td><td class="c ok">✓ 双文对照</td><td class="c ok">✓ 拆分视图</td></tr>
  <tr><td>无链接也能跳引用 / 图表</td><td class="c ok">✓ 引用与参考文献反查</td><td class="c gap">—</td><td class="c ok">✓ 含图表公式</td><td class="c unk">·</td><td class="c unk">·</td><td class="c gap">—</td></tr>
  <tr><td>PDF 重排（reflow / Reading Mode）</td><td class="c gap">—</td><td class="c ok">✓</td><td class="c gap">—</td><td class="c gap">—</td><td class="c gap">—</td><td class="c gap">—</td></tr>
  <tr><td>朗读（系统 TTS）</td><td class="c ok">✓ 句级高亮 + 跨页</td><td class="c ok">✓</td><td class="c gap">—</td><td class="c unk">·</td><td class="c unk">·</td><td class="c unk">·</td></tr>
  <tr><td>批注类型齐全度</td><td class="c part">△ 缺印章</td><td class="c ok">✓</td><td class="c part">△ 高亮 + 手绘</td><td class="c ok">✓ 含墨迹</td><td class="c ok">✓</td><td class="c ok">✓ 含印章与打字机</td></tr>
  <tr><td>批注可在原文外独立保存</td><td class="c ok">✓ sidecar</td><td class="c ok">✓</td><td class="c ok">✓ 数据库</td><td class="c ok">✓ 项目文件</td><td class="c ok">✓ 学习集</td><td class="c ok">✓ 默认不写回</td></tr>
  <tr><td>带标注的 PDF 副本</td><td class="c part">△ 中文文字受限</td><td class="c ok">✓</td><td class="c unk">·</td><td class="c ok">✓</td><td class="c ok">✓</td><td class="c ok">✓</td></tr>
  <tr><td>标注 → 卡片 → 间隔复习</td><td class="c ok">✓ 回顾（SM-2）</td><td class="c gap">—</td><td class="c gap">—</td><td class="c gap">—</td><td class="c ok">✓ FSRS</td><td class="c gap">—</td></tr>
  <tr><td>摘录工作区（拖出、连线、跨文档）</td><td class="c gap">—</td><td class="c gap">—</td><td class="c gap">—</td><td class="c ok">✓ 核心</td><td class="c ok">✓ 脑图</td><td class="c gap">—</td></tr>
  <tr><td>扫描件 OCR</td><td class="c gap">—</td><td class="c gap">—</td><td class="c part">△ 外部命令</td><td class="c part">△ 付费</td><td class="c ok">✓</td><td class="c gap">—</td></tr>
</tbody>
</table>
<p class="note">Trove 在这一格里比 Zotero 多出的：智能跳转（Zotero 只认文档自带链接）、图像区域放大灯箱、直线 / 矩形 / 箭头图形标注、句级朗读高亮。少的是：Reading Mode、印章、完整的中文文字标注导出。</p>

<h3>4.3 组织、检索与引用</h3>
<table class="m">
  <thead><tr>
    <th style="width:24%">能力</th><th class="c">Trove</th><th class="c">Zotero</th><th class="c">JabRef</th>
    <th class="c">calibre</th><th class="c">Paperless</th><th class="c">Readwise</th><th class="c">Koodo</th>
  </tr></thead>
  <tbody>
  <tr><td>层级收藏集 / 分组</td><td class="c ok">✓</td><td class="c ok">✓</td><td class="c ok">✓ Groups</td><td class="c ok">✓ 虚拟库</td><td class="c part">△ 标签</td><td class="c part">△ 标签</td><td class="c gap">—</td></tr>
  <tr><td>保存的检索 / 智能集合</td><td class="c ok">✓</td><td class="c ok">✓</td><td class="c ok">✓ 搜索组</td><td class="c ok">✓</td><td class="c unk">·</td><td class="c ok">✓ 搜索</td><td class="c gap">—</td></tr>
  <tr><td>标签 + 颜色</td><td class="c ok">✓</td><td class="c ok">✓</td><td class="c part">△ 关键词</td><td class="c ok">✓</td><td class="c ok">✓</td><td class="c ok">✓</td><td class="c gap">—</td></tr>
  <tr><td>查重与合并</td><td class="c ok">✓</td><td class="c ok">✓</td><td class="c ok">✓</td><td class="c part">△</td><td class="c gap">—</td><td class="c gap">—</td><td class="c gap">—</td></tr>
  <tr><td>大库列表流畅度（视口挂载）</td><td class="c ok">✓ 1 万条 0.5 s</td><td class="c ok">✓</td><td class="c ok">✓</td><td class="c unk">·</td><td class="c unk">·</td><td class="c unk">·</td><td class="c gap">—</td></tr>
  <tr><td>正文全文检索</td><td class="c ok">✓ worker 子串匹配</td><td class="c ok">✓</td><td class="c ok">✓ Lucene</td><td class="c ok">✓</td><td class="c ok">✓ OCR 全量</td><td class="c ok">✓ 高亮库</td><td class="c part">△</td></tr>
  <tr><td>检索语法：字段 / 布尔 / 条件组 UI</td><td class="c ok">✓ 表达式 + 条件面板</td><td class="c ok">✓ 嵌套条件组</td><td class="c ok">✓ LaTeX 语法</td><td class="c ok">✓</td><td class="c part">△</td><td class="c part">△</td><td class="c gap">—</td></tr>
  <tr><td>结果级切换（条目 / 附件 / 批注 / 笔记）</td><td class="c ok">✓</td><td class="c ok">✓</td><td class="c gap">—</td><td class="c gap">—</td><td class="c gap">—</td><td class="c ok">✓</td><td class="c gap">—</td></tr>
  <tr><td>citekey 可配模板</td><td class="c ok">✓ 模板 + 修饰符</td><td class="c part">△ 需插件</td><td class="c ok">✓ 修饰符齐全</td><td class="c gap">—</td><td class="c gap">—</td><td class="c gap">—</td><td class="c gap">—</td></tr>
  <tr><td>CSL 样式</td><td class="c part">△ 子集 + 可导入</td><td class="c ok">✓ 上万份在线</td><td class="c ok">✓</td><td class="c unk">·</td><td class="c gap">—</td><td class="c gap">—</td><td class="c gap">—</td></tr>
  <tr><td>写作软件集成（Word / LaTeX）</td><td class="c gap">—</td><td class="c ok">✓</td><td class="c ok">✓</td><td class="c gap">—</td><td class="c gap">—</td><td class="c ok">✓ 导出</td><td class="c gap">—</td></tr>
  <tr><td>备份 / 迁移</td><td class="c ok">✓ JSON + 资源</td><td class="c ok">✓</td><td class="c ok">✓ bib 文本</td><td class="c ok">✓</td><td class="c ok">✓</td><td class="c ok">✓ 导出</td><td class="c gap">—</td></tr>
  <tr><td>RSS / 订阅</td><td class="c ok">✓ 按需拉取</td><td class="c ok">✓</td><td class="c gap">—</td><td class="c ok">✓</td><td class="c gap">—</td><td class="c ok">✓</td><td class="c part">△</td></tr>
</tbody>
</table>

<h3>4.4 逐家「能移植什么」</h3>
<table>
  <thead><tr><th style="width:13%">产品</th><th style="width:47%">值得移植的具体做法</th><th style="width:13%">适配度</th><th style="width:27%">状态</th></tr></thead>
  <tbody>
  <tr>
    <td>Sioyek</td>
    <td>Smart Jump（点 <code>[12]</code> 跳参考文献、点条目反查正文）；<b>Overview</b>（右键弹出候选，识别错了能手选）；
      <b>Portals</b>（把正文位置和另一处位置连起来，第二窗口跟着走）；<b>视觉标尺</b>（高亮当前阅读行）；<b>命令面板</b></td>
    <td>高 / 中</td>
    <td><span class="tag t-done">Smart Jump 已移植（10-27）</span>；标尺与命令面板成本低、未做；Portals 要动多窗口，未做</td>
  </tr>
  <tr>
    <td>LiquidText</td>
    <td>把摘录拖到原文旁边的画布、跨页连线、多文档并排；导出摘录为 DOCX</td>
    <td>中 / 低</td>
    <td>画布整体不做（Web 渲染 + 单窗口下收益低于成本）；「导出 DOCX」已作为<b>笔记导出 Word</b> 补上（本轮）</td>
  </tr>
  <tr>
    <td>MarginNote 4</td>
    <td>摘录自动成卡、<b>遮挡式主动回忆</b>、FSRS 排期、卡片标题自动链接（读到旧概念自动亮）、大纲（Tab 缩进调层级）</td>
    <td>高</td>
    <td><span class="tag t-done">成卡 + 遮挡 + 排期已移植（本轮回顾）</span>；用 SM-2 而非 FSRS；大纲与标题自动链接未做</td>
  </tr>
  <tr>
    <td>Readwise</td>
    <td>每日复习配额（每天 5–15 条而不是倾泻全部）、显示答案后一次性给足评分选项、复习与来源双向跳转</td>
    <td>高</td>
    <td><span class="tag t-done">已移植（本轮）</span>：单次上限 30 张、四档评分、卡片可跳原文</td>
  </tr>
  <tr>
    <td>JabRef</td>
    <td><b>citekey 模板</b>（<code>[auth][year][title:abbr]</code> 与 <code>authN</code> / <code>auth.etal</code> 等修饰符）；XMP 元数据写回 PDF；Lucene 全文索引；按关键词自动归组</td>
    <td>中高</td>
    <td><span class="tag t-done">citekey 模板已移植（本轮）</span>：8 个字段 × 4 类修饰符、预设按钮、实时预览，默认模板与旧算法逐字符等价；
      XMP 写回暂不做（要写 PDF 二进制），Lucene 不引（已有自研索引 worker）</td>
  </tr>
  <tr>
    <td>Okular</td>
    <td>印章（stamp）标注、批注归档成单文件（<code>.okular</code>）、PDF 表单填写、数字签名验证、DjVu / CBZ / CHM 阅读</td>
    <td>中 / 低</td>
    <td>sidecar 做法已一致；印章与归档单文件成本低、未做；签名验证要引密码学依赖，暂不做</td>
  </tr>
  <tr>
    <td>calibre</td>
    <td>阅读统计与热力图、元数据批量下载、虚拟库（= 智能收藏集）</td>
    <td>高</td>
    <td><span class="tag t-done">统计热力图 / 虚拟库已移植（10-27）</span>；元数据来源仍只有 Crossref / arXiv</td>
  </tr>
  <tr>
    <td>Paperless-ngx</td>
    <td>OCR、自动标签 / 文档类型抽取、<b>相似文档</b>推荐、全文命中直接高亮跳转</td>
    <td>中</td>
    <td>OCR 明确不做（要外部引擎，违背零依赖）；相似文档可用刚做好的索引 worker 算、未做；命中跳转已有</td>
  </tr>
  <tr>
    <td>Koodo</td>
    <td>书架进度条、内置翻译、TTS</td>
    <td>高 / 低</td>
    <td><span class="tag t-done">进度条与 TTS 已移植</span>；内置翻译要联网 API，不做</td>
  </tr>
</tbody>
</table>

<h3>4.5 已经移植过来的（按轮次）</h3>
<table class="m">
  <thead><tr><th style="width:26%">功能</th><th style="width:20%">出处</th><th style="width:38%">在 Trove 里长成什么样</th><th style="width:16%">轮次</th></tr></thead>
  <tbody>
  <tr><td>智能跳转</td><td>Sioyek Smart Jump</td><td>点 <code>[12]</code> / <code>[Smith, 2020]</code> 跳参考文献并高亮；点条目行反查正文标记，不依赖文档自带链接</td><td>10-27</td></tr>
  <tr><td>双页对开</td><td>Okular / Sumatra 标配</td><td><code>Ctrl+Shift+D</code>，封面独占、偶左奇右</td><td>10-27</td></tr>
  <tr><td>阅读进度</td><td>Koodo 书架进度</td><td>列表进度条 + 详情「继续阅读」；打开待读条目自动转在读</td><td>10-27</td></tr>
  <tr><td>阅读统计</td><td>calibre</td><td>统计面板：类型 / 年份 / 标签分布 + 12 周阅读时长热力图</td><td>10-27</td></tr>
  <tr><td>公式渲染</td><td>Joplin / KaTeX</td><td><code>$…$</code> / <code>$$…$$</code> 本地渲染，导出 HTML 带排版</td><td>10-27</td></tr>
  <tr><td>双向链接</td><td>Obsidian</td><td><code>[[标题]]</code> + 反链列表 + 改名后旧标题当别名</td><td>10-27</td></tr>
  <tr><td>可视化检索条件</td><td>Zotero 10</td><td>选字段 / 勾排除 / 多行 AND；打开时把当前查询反向解析回填</td><td>10-27</td></tr>
  <tr><td>期刊订阅</td><td>Zotero Feeds</td><td>按需拉取（点开才联网），条目一键收录并按 URL 防重</td><td>10-27</td></tr>
  <tr><td>PDF 批注导入</td><td>Okular / Zotero</td><td>10 类标准批注，带原文 / 评论 / 作者 / 颜色，/IRT 记成「↳ 回复」</td><td>10-24 / 10-27</td></tr>
  <tr><td>检索迁出主进程</td><td>（工程向；JabRef 用 Lucene 的思路）</td><td>worker 线程 + 增量索引队列 + 建完自动重跑查询</td><td>10-29</td></tr>
  <tr><td>回顾（间隔重复）</td><td>MarginNote + Readwise</td><td>标注 → 卡片 → 模糊遮挡 → 想一下 → 显示 → 四档评分 → 到期再见</td><td>10-29</td></tr>
  <tr><td>citekey 模板</td><td>JabRef</td><td><code>[auth:lower][year][veryshorttitle:lower]</code> + 8 字段 × 4 类修饰符，预设与实时预览，默认值与旧算法等价</td><td>10-29</td></tr>
  <tr><td>条件式检索（含批注属性）</td><td>Zotero 10 高级检索</td><td>18 个字段 × 5 组运算符、且/或、<code>is empty</code>、标注数 / 颜色 / 类型 / 带批注，可存为智能收藏集</td><td>10-29</td></tr>
  <tr><td>标注嵌套回复树</td><td>Zotero</td><td><code>/IRT</code> 关系重建父子树，任意层缩进 + 竖线引导；父被筛掉子升格、成环截断</td><td>10-29</td></tr>
  <tr><td>笔记导出 Word</td><td>LiquidText（导出 DOCX）/ Zotero</td><td>导出下拉「Word…」，带 mso 命名空间与 A4 页面，零依赖；三种格式共用一份 Markdown 中间产物</td><td>10-29</td></tr>
</tbody>
</table>

<h2>五、仍然缺什么（按影响排序，已按竞品对照重排）</h2>

<h3>1. 便宜的、能立刻感知的（下一轮候选）</h3>
<ul>
  <li><b>阅读标尺 + 命令面板</b>（Sioyek）—— 两个都是「几十行换很高感知」的东西：标尺解决长段落串行，命令面板解决快捷键记不住。</li>
  <li><b>条件组的嵌套</b> —— 条件面板已经在了，只差数据结构从「一层条件」变成「条件或条件组」；Zotero 的差距表里这一格还没打勾。
    顺带能补上正则与「距今 N 天」这类动态条件。</li>
  <li><b>印章标注与批注归档单文件</b>（Okular）—— 标注体系已经齐全，缺的是「审阅」味的印章和「一次带走」的归档格式。</li>
</ul>

<h3>2. 中等成本、收益明确</h3>
<ul>
  <li><b>相似文档</b>（Paperless-ngx）—— 索引 worker 已经在了，加一条「用当前文档的词向量找最近邻」，详情面板就能给「库里这几篇跟它像」。</li>
  <li><b>跨文档 Portal</b>（Sioyek）—— 现在的对照栏要手动选文件；按引用自动跟随（读到 [12] 就把那一篇翻到对应页）是 Smart Jump 的自然延伸。</li>
  <li><b>笔记里的表格可视化编辑</b> —— 导出已经能正确转换表格，缺的是「在编辑器里点格子改」；现在是写 Markdown 表格源码。</li>
</ul>

<h3>3. 老账（提过两轮以上）</h3>
<ul>
  <li><b>中文文字标注的字体子集</b> —— 带标注副本导出仍受 Helvetica 编码限制，中文文字会被跳过（界面会提示数量）。</li>
  <li><b>从参考文献表批量入库</b> —— 解析参考文献条目 → Crossref 匹配 → 批量建条目；目前只能靠 DOI 逐条抓。</li>
  <li><b>PDF reflow</b> —— 要引入排版引擎，两轮都判为「单独一轮、收益不确定」。</li>
</ul>

<h3>4. 明确不做（写清理由，避免每轮重复讨论）</h3>
<p>云同步、群组库、协作、Web Library、移动端、插件系统、跨平台打包；Word / LibreOffice 插件与 RTF Scan（跨应用，与「无账号 / 单窗口 / 本地文件」冲突）；
OCR（要外部引擎，违背零依赖；真要做得作为外部工具接入）；内置翻译（需联网 API）；LiquidText 式摘录画布（Web 渲染 + 单窗口下收益低于成本）。</p>

<h2>六、本轮验证</h2>
<table class="avoid-break">
  <thead><tr><th style="width:30%">回归</th><th class="c" style="width:12%">项数</th><th>覆盖</th></tr></thead>
  <tbody>
  <tr><td><code>test-citekey</code>（纯 Node，新）</td><td class="c">57</td><td>默认模板与旧算法在随机夹具上<b>逐字符对拍</b>；8 个字段 × 4 类修饰符与组合；字面量与数字截断；空值兜底（只写 <code>[year]</code> 得 <code>2017</code> 而不是 <code>itemk12017</code>）；40 字符上限；非法模板退回默认</td></tr>
  <tr><td><code>test-advsearch</code>（纯 Node，新）</td><td class="c">101</td><td>18 个字段 × 运算符矩阵；<code>all</code> / <code>any</code>；<code>is empty</code> 与「条件没填值」的区别；6 个批注条件；<code>normalize</code> 丢弃不完整 / 非法条件；<code>describe</code> 文案</td></tr>
  <tr><td><code>test-adv-ui</code>（真实 Electron，新）</td><td class="c">38 + 8</td><td>条件弹窗增删行、且/或切换、预览计数、存为智能收藏集并回读、横幅出现与关闭；标注回复树缩进；<b>Word 导出落盘后断言含 mso 命名空间与 A4 页设置</b>；改模板后详情面板的引用键即时变化</td></tr>
  <tr><td>同轮回归</td><td class="c">—</td><td><code>test-cite</code>、<code>test-markdown</code>(42)、<code>test-library</code>(82)、<code>test-search</code>(74 + probe 19)、<code>test-note-editor</code>(27)、<code>test-library-ui</code>(78)、<code>test-anno-filter</code>(16)、<code>test-datadir</code>(21)、<code>test-lib-stats</code>(11)、<code>test-backup-restore</code> 全部通过</td></tr>
</tbody>
</table>
<p class="note">仓库内共 112 个 <code>test-*.js</code>。本轮新增的三支脚本合计 <b>196 项断言</b>。打包产物冒烟（<code>test-packaged</code>）仍未跑：worker 的打包路径
（<code>app.asar.unpacked</code>）只写了代码与 <code>asarUnpack</code> 配置，<b>尚未在打包产物上验证</b>——这一条从上一版延续下来，不是本轮引入的。</p>

<h2>七、结论</h2>
<p>对齐度 <b>92% → 94%</b>，涨的每一分都能指到具体一行：检索 95→97、标注 95→97、笔记 93→95、引用 88→91、导入导出 90→92。
涨幅不大是<b>诚实</b>的：这四项在 Zotero 的能力表里本来就只占一小块，而压分的几项要么跨应用（Word 活引用、群组库、协作），要么是老账
（中文标注字体、参考文献表批量入库、reflow），不是一轮功能能解决的。</p>
<p>这一版有个附带收获：为了做 Word 导出而横向对比三种格式，才暴露出「表格被拍平」这个存在了很久的 bug。这说明
<b>多写一种出口本身就是一种测试</b>——同一份中间产物被三种渲染器读一遍，坏的地方藏不住。</p>
<p>横向对照 + 这一轮的补齐之后，判断比上一版更清楚了：<b>Zotero 侧「我们该有」的东西基本齐了</b>，剩下的不是「再补一个功能」，
而是三笔各有技术前提的老账。所以下一步不该再按「对标 Zotero」排，而该按「自己用得爽」排：阅读标尺与命令面板（Sioyek 的体感）、
条件组嵌套（已有一半）、相似文档（复用索引 worker）。</p>
<p><b>明确不做的仍然不做</b>：云同步、群组库、协作、Web Library、移动端、插件系统、跨平台打包、Word / LibreOffice 插件与 RTF Scan、
OCR、内置翻译、LiquidText 式摘录画布。理由在第五章第 4 节，这一版没有一处被「对齐度」逼着改口。</p>

<footer>Trove · 本地文献库与 PDF 阅读器 · 报告生成于 2026-10-29（第六版）· 评估对象：v1.4.0 之上的未发布改动 ·
数据来源：本仓库 CHANGELOG、docs/archive/verification-2026-10-29-audit3.md（含第四部分「对齐补齐」）、docs/architecture.md 与测试套件；
Zotero 基线来自 zotero.org 变更日志与 support 文档（10.x）；其余产品来自 sioyek.info 与仓库 README、liquidtext.net/features、
marginnote.com 与 MN4 手册、readwise.io 与官方博客、docs.jabref.org、okular.kde.org 与 KDE 发布说明、calibre 手册、
docs.paperless-ngx.com、koodoreader.com（检索时间 2026-10-29）</footer>

</body></html>`;

app.whenReady().then(async () => {
  const tmpHtml = path.join(os.tmpdir(), 'trove-report-' + Date.now() + '.html');
  fs.writeFileSync(tmpHtml, HTML, 'utf8');
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: { offscreen: false },
  });
  try {
    // 先走临时文件（file://）：内容变长后 data URL 会超过加载上限，报 ERR_FAILED
    await win.loadFile(tmpHtml);
    // 等一帧，确保字体与布局稳定
    await new Promise((r) => setTimeout(r, 700));
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { marginType: 'none' },
      preferCSSPageSize: true,
    });
    // 先备份桌面上现有的报告，再覆盖
    try {
      if (fs.existsSync(OUT) && !fs.existsSync(BACKUP)) fs.copyFileSync(OUT, BACKUP);
    } catch (_) {}
    fs.writeFileSync(OUT, pdf);
    // 项目目录里也留一份，源码与文档同源
    try { fs.writeFileSync(PROJECT_COPY, pdf); } catch (_) {}
    console.log('report written:', OUT, pdf.length, 'bytes');
    console.log('project copy:', PROJECT_COPY);
  } catch (err) {
    console.error('report failed:', err && err.message ? err.message : err);
    process.exitCode = 1;
  } finally {
    try { fs.unlinkSync(tmpHtml); } catch (_) {}
    win.destroy();
    app.quit();
  }
});
