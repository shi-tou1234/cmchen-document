'use strict';
/*
 * 生成《Trove 与 Zotero 功能差距评估报告》更新版 PDF（2026-10-30，第八版）。
 * 第五版新增第四章：与 9 款同类产品的横向对照，并据此重排缺口清单。
 * 第六版把「对齐度」表里仍标「仍差」的四项补齐（citekey 模板、批注属性条件、嵌套回复树、笔记导出 Word）。
 * 第七版对应 v1.5.0：第六版「仍然缺什么」清单里的 9 项（含三笔老账）全部清账。
 * 第八版对应 v1.5.1（软件内置使用指南，已打包安装）+ v1.5.2（源码就绪、尚未打包）：
 *   第七版收尾时排的下一步是「Overview 候选弹窗 → 卡片标题自动链接 → 笔记图片缩放」，
 *   这一轮做了第一和第三项，并顺手解决了一个更前面的问题——功能都在，但没人知道怎么用。
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
// 旧版备份放项目目录（评审报告/），不再往桌面塞文件
const BACKUP = path.join(__dirname, '..', '..', '评审报告', 'Trove与Zotero功能差距评估报告-第七版-2026-10-30.pdf');
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
<div class="sub">2026-10-30 更新版（第八版）· 评估对象：Trove <b>v1.5.2</b>（源码已就绪，尚未打包发布；基线 v1.5.0 已发布，v1.5.1 已打包安装）·
本版新增：软件内置使用指南（<code>F1</code>，1.5.1）+ Overview 候选弹窗 + 笔记图片缩放（1.5.2），逐模块重算对齐度</div>

<div class="note">
  <b>这一版做了什么</b>：第七版收尾时说「下一步按自己用得爽排」，列了三件：<b>Overview 候选弹窗、卡片标题自动链接、笔记图片缩放</b>。
  这一轮做了第一件和第三件，另外补了一个更前面的问题——<b>功能都在，但没人知道怎么用</b>：v1.5.1 把使用说明搬进了软件内部（<code>F1</code>，10 组 76 节，可搜索，覆盖度由机器守）。
  v1.5.2 则把「机器不猜的时候人怎么接手」做实：<b>Overview 候选弹窗</b>给引用跟随补上手选入口，<b>笔记图片缩放</b>补上笔记编辑器剩下的最大体感缺口。
  加权对齐度 <b>95.6% → 96.2%</b>（同一套权重，权重表在第三章），涨幅仍然克制——剩下的压分项还是那批跨应用能力。
</div>

<h2>一、这一版的变化</h2>
<table class="avoid-break">
  <thead><tr><th style="width:14%">方向</th><th style="width:46%">做了什么</th><th style="width:40%">为什么值得单独记一笔</th></tr></thead>
  <tbody>
  <tr>
    <td><b>上手（v1.5.1）</b></td>
    <td><b>软件内置使用指南</b>（<code>F1</code>）：10 组 <b>76 节</b>，左侧分类 + 顶上搜索；每节「这是什么 → 按步骤怎么做 → 快捷键 → 做不到什么 → 相关」；带「在界面定位」的节会关掉指南并把对应按钮滚进视野闪两下，部分节有直达功能的主色按钮</td>
    <td>以前说明只在 README / docs 里，用户在软件里找不到「这个按钮是干什么的」。更关键的是<b>覆盖度不能靠人记</b>：<code>check-help</code> 做三件事——结构校验、归属校验（<code>index.html</code> 里每个控件都必须登记由哪一节负责）、证据校验（登记的控件名字要真的出现在那一节正文里）。现在 235 个控件全部登记并命中，新增控件忘了写说明会让脚本失败</td>
  </tr>
  <tr>
    <td><b>阅读</b></td>
    <td><b>Overview 候选出处</b>（<code>Alt+O</code> / 右键 / 状态栏「挑一篇」）：机器排过序的候选在上（带把握百分比），全库标题 / 作者搜索在下；选一篇立刻开到对照栏</td>
    <td>引用跟随的原则一直是「够不到阈值就不猜」——跳错一篇比不跳更让人困惑，这条不能动。但「不猜」的代价是用户明明知道自己要哪一篇却没处说。这里<b>不改判定策略，只补落口</b>：候选与自动匹配共用同一个 <code>scoreEntry</code>（算法漂移会让「自动跳的那篇不在候选第一位」这种矛盾显现，单测钉了这条不变量），选完走完全相同的 <code>setSplitView → loadRefDoc</code> 通路</td>
  </tr>
  <tr>
    <td><b>笔记</b></td>
    <td><b>图片缩放</b>：预览里图片右下角把手拖动改宽度（40–2400 px，双击还原），Markdown 侧写回源码 <code>![x](a.png#w=420)</code>，截图侧写进 <code>notes[].imageW</code></td>
    <td>难点不在「拖」，在「拖完能存住」：预览每敲几个字就整体重渲染，改 DOM 等于白改。宽度写成图片地址上的标记是为了<b>跟着图走</b>——导出、富文本互转、互传笔记都不丢；截图另走结构化字段，是因为富文本每次保存都要过 sanitize，塞进 style 迟早被洗掉</td>
  </tr>
  <tr>
    <td><b>工程质量</b></td>
    <td>修掉两处「看起来没问题、实际已经坏了」的地方：<code>publicItem</code> 漏了 <code>notes[].imageW</code>（存得进、读不回）；指南标题栏版本号写在数据文件里，已经漂到 1.5.0（现在以 <code>app.getVersion</code> 为准）</td>
    <td>都是端到端探针逼出来的：<code>test-note-image</code> 直连 IPC 也拿不到宽度，才查到是返回给界面的字段被裁剪。<b>纯 Node 单测两套全绿也发现不了这种「存进去但界面读不回」的断点</b></td>
  </tr>
  <tr>
    <td><b>可靠性</b></td>
    <td>Overview 的两个 IPC 用代际号丢弃过期响应；候选列表排除当前在读的那篇</td>
    <td>连续打开 / 刚切过文档时，上一轮 IPC 可能晚到一步并把旧结果盖回来（与既有 <code>loadRefDoc</code> 同一手法）。排除自己是因为：在自己的 PDF 里盯着 <code>[12]</code> 时，不需要再跳一次当前这篇</td>
  </tr>
</tbody>
</table>

<h2>二、能力对照（上一版 → 当前）</h2>
<table>
  <thead><tr><th style="width:15%">模块</th><th style="width:30%">上一版（1.5.0，第七版）</th><th style="width:38%">当前（1.5.2，源码）</th><th style="width:17%">结论</th></tr></thead>
  <tbody>
  <tr>
    <td><b>阅读器</b></td>
    <td>reflow / 标尺 / 命令面板 / Portal 已通；<b>缺 Overview 式候选弹窗</b>——识别不了或认错了没有手选入口</td>
    <td><b>Overview 候选出处</b>补齐：<code>rankCandidates</code> 排序列候选 + 全库搜索兜底 + <code>portal-pick</code> 补起始页</td>
    <td class="c"><span class="tag t-done">已补齐</span> 缺 Portals 多窗口跟随</td>
  </tr>
  <tr>
    <td><b>笔记</b></td>
    <td>表格可视化编辑已通；<b>缺笔记内图片缩放</b></td>
    <td><b>图片缩放</b>补齐：把手拖拽 + 两侧各自持久化（<code>#w=</code> 标记 / <code>imageW</code> 字段）+ 双击还原</td>
    <td class="c"><span class="tag t-done">已补齐</span> 缺多级标题样式、笔记级元数据面板</td>
  </tr>
  <tr>
    <td><b>上手与说明</b><br /><span class="unk">（不计入加权）</span></td>
    <td>只有仓库里的 README / docs，软件内没有入口</td>
    <td><b>内置使用指南</b>（<code>F1</code>）：76 节、可搜索、可在界面定位、可直达功能；覆盖度靠 <code>check-help</code> 守</td>
    <td class="c"><span class="tag t-done">已补齐</span></td>
  </tr>
  <tr>
    <td><b>检索 / 标注 / 组织 / 引用 / 抓取 / 导入导出</b></td>
    <td>第七版已补齐的条件组嵌套、印章、归档、相似文献、参考文献表入库等均保持</td>
    <td>本轮没有改动这些模块；剩余差距与第七版一致（见第三章）</td>
    <td class="c"><span class="tag t-mid">保持</span></td>
  </tr>
  <tr>
    <td><b>可靠性</b></td>
    <td>R7-01 / R7-02 已闭环</td>
    <td>新增：Overview 竞态防护、<code>publicItem</code> 字段漏传修复、指南版本号漂移修复</td>
    <td class="c"><span class="tag t-done">已闭环</span></td>
  </tr>
</tbody>
</table>

<h2>三、对齐度与工程质量</h2>
<p>这一版的分数来自<b>两个体感件的补齐</b>：阅读器拿到 Overview（96 → 98），笔记拿到图片缩放（97 → 99）。加权后 <b>95.6% → 96.2%</b>——
涨幅比上两版都小，因为这两项本来就是清单末端的「自己用得爽」项，而<b>分母里那批跨应用能力（Word 活引用、群组库、协作、机构代理）一件都没动</b>。
权重与第七版完全一致，表列出来便于复核。</p>

<div class="kpi">
  <div><b>96.2%</b><span>加权对齐度（95.6% → 96.2%）</span></div>
  <div><b>2 + 1</b><span>第七版清单完成 2 项，另加使用指南 1 件</span></div>
  <div><b>534</b><span>11 支核心纯 Node 回归合计（复跑全过）</span></div>
  <div><b>128</b><span>仓库内 test-*.js 脚本（第七版时 125）</span></div>
</div>

<table>
  <thead><tr><th style="width:22%">模块</th><th class="c" style="width:9%">权重</th><th class="c" style="width:11%">第七版</th><th class="c" style="width:11%">当前</th><th>依据 / 剩余差距</th></tr></thead>
  <tbody>
  <tr><td>阅读器</td><td class="c">0.18</td><td class="c">96%</td><td class="c">98%</td><td><b>补齐 Overview 候选弹窗</b>：判定不猜、人能接手。剩 2 分：Sioyek Portals 的多窗口跟随（现在只在单窗口对照栏内）</td></tr>
  <tr><td>标注</td><td class="c">0.16</td><td class="c">99%</td><td class="c">99%</td><td>本轮未改动。剩 1 分：扁平化批注恢复（把外部工具散落的输出收敛回 sidecar）</td></tr>
  <tr><td>检索</td><td class="c">0.14</td><td class="c">98%</td><td class="c">98%</td><td>本轮未改动。剩 2 分：万条级复杂条件上 Zotero 的数据库索引仍有性能优势；自然语言查询不做</td></tr>
  <tr><td>笔记</td><td class="c">0.12</td><td class="c">97%</td><td class="c">99%</td><td><b>补齐图片缩放</b>（含导出 / 互转时的宽度保真）。剩 1 分：多级标题样式自定义、笔记级元数据面板</td></tr>
  <tr><td>组织</td><td class="c">0.12</td><td class="c">97%</td><td class="c">97%</td><td>本轮未改动。仍差群组库（决定不做，结构性）</td></tr>
  <tr><td>引用</td><td class="c">0.12</td><td class="c">92%</td><td class="c">92%</td><td>本轮未改动。仍差：同上 / 前引（ibid. / op. cit.）、作者消歧、COinS、Word 活引用（跨应用，不做）</td></tr>
  <tr><td>抓取与发现</td><td class="c">0.08</td><td class="c">88%</td><td class="c">88%</td><td>本轮未改动。仍差：机构代理、Find Full Text 式多源聚合、OCR（不做）</td></tr>
  <tr><td>导入导出</td><td class="c">0.08</td><td class="c">93%</td><td class="c">93%</td><td>本轮未改动。仍差 RDF / MARC、EndNote 的附件路径还原</td></tr>
</tbody>
</table>
<p class="note">口径说明：跨应用能力（Word 插件、群组库、移动端、协作）在<b>分母里保留、不给满分</b>，所以天花板仍压在 96 上下——
这是<b>结构性的</b>，不是没干活。加权合计 95.64% → 96.24%（保留一位：95.6% → 96.2%）。
「上手与说明」不计入加权：Zotero 有完整的文档站与社区，Trove 有软件内指南，两者形态不同、不宜直接比分数。</p>

<h3>3.1 工程质量（不与 Zotero 比，跟自己比）</h3>
<table class="avoid-break">
  <thead><tr><th style="width:22%">指标</th><th style="width:16%">上一版</th><th style="width:16%">当前</th><th>说明</th></tr></thead>
  <tbody>
  <tr><td>软件内可发现性</td><td>README / docs（软件外）</td><td class="ok">F1 内置指南 76 节</td><td>覆盖度不再靠人记：<code>check-help</code> 做结构 / 归属 / 证据三道校验，<code>index.html</code> 里 235 个控件全部登记命中；新控件忘了写说明直接失败</td></tr>
  <tr><td>引用识别的手动兜底</td><td>识别不了就断了</td><td class="ok">候选 + 全库搜索</td><td>「不猜」不再等于「没得选」：候选按把握排序（含百分比），下面还能搜全库；当前在读的这篇不进列表</td></tr>
  <tr><td>笔记图片</td><td>尺寸只能改源码 / 无处存</td><td class="ok">把手拖拽 + 两侧持久化</td><td>Markdown 侧写回 <code>#w=</code>（<code>fromHtml</code> 三级回读：标记 → 属性 → 行内样式），截图侧写 <code>imageW</code> 字段；往返稳定有单测钉住</td></tr>
  <tr><td>存储层字段完整性</td><td><code>publicItem</code> 漏字段（存进读不回）</td><td class="ok">已修 + 探针拦截</td><td><code>notes[].imageW</code> 现在进返回；端到端探针会验「跨存储层能读回」，避免同类漏字段再发生</td></tr>
  <tr><td>版本号一致性</td><td>指南里写死，已漂到 1.5.0</td><td class="ok">以 <code>app.getVersion</code> 为准</td><td>数据文件里那份只作离线兜底，两处不会再各写各的</td></tr>
  <tr><td>查询期间主进程响应</td><td class="ok">2 ms（已达标）</td><td class="ok">保持</td><td>400 份合成索引、查询同时连发 8 次 <code>lib-summary</code> 的门槛复测仍通过</td></tr>
</tbody>
</table>

<h2>四、竞品横向对照（第五版引入，第六 / 七 / 八版更新状态列）</h2>

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
  <tr><td>Readwise / Reader</td><td>高亮汇总 + 每日复习</td><td>Daily Review 的配额与评分交互、阅读队列</td><td>readwise.io、官方博客</td></tr>
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
  <tr><td>并排 / 分屏对照</td><td class="c ok">✓ 只读参考 + Portal 跟随</td><td class="c ok">✓ 第二视图</td><td class="c ok">✓ 第二窗口</td><td class="c ok">✓ 最多三篇</td><td class="c ok">✓ 双文对照</td><td class="c ok">✓ 拆分视图</td></tr>
  <tr><td>无链接也能跳引用 / 图表</td><td class="c ok">✓ 引用反查 + Portal 开原文</td><td class="c gap">—</td><td class="c ok">✓ 含图表公式</td><td class="c unk">·</td><td class="c unk">·</td><td class="c gap">—</td></tr>
  <tr><td><b>识别不了 / 认错了能手选（Overview）</b></td><td class="c ok">✓ 候选 + 全库搜索</td><td class="c gap">—</td><td class="c ok">✓</td><td class="c gap">—</td><td class="c gap">—</td><td class="c gap">—</td></tr>
  <tr><td>PDF 重排（reflow / Reading Mode）</td><td class="c ok">✓ 按坐标还原段落</td><td class="c ok">✓</td><td class="c gap">—</td><td class="c gap">—</td><td class="c gap">—</td><td class="c gap">—</td></tr>
  <tr><td>视觉阅读标尺 / 命令面板</td><td class="c ok">✓ 两者都有</td><td class="c gap">—</td><td class="c ok">✓</td><td class="c gap">—</td><td class="c gap">—</td><td class="c gap">—</td></tr>
  <tr><td>朗读（系统 TTS）</td><td class="c ok">✓ 句级高亮 + 跨页 + 句序记忆</td><td class="c ok">✓</td><td class="c gap">—</td><td class="c unk">·</td><td class="c unk">·</td><td class="c unk">·</td></tr>
  <tr><td>批注类型齐全度</td><td class="c ok">✓ 含印章</td><td class="c ok">✓</td><td class="c part">△ 高亮 + 手绘</td><td class="c ok">✓ 含墨迹</td><td class="c ok">✓</td><td class="c ok">✓ 含印章与打字机</td></tr>
  <tr><td>批注可在原文外独立保存</td><td class="c ok">✓ sidecar + 归档 zip</td><td class="c ok">✓</td><td class="c ok">✓ 数据库</td><td class="c ok">✓ 项目文件</td><td class="c ok">✓ 学习集</td><td class="c ok">✓ 默认不写回</td></tr>
  <tr><td>带标注的 PDF 副本</td><td class="c ok">✓ 中文字形子集嵌入</td><td class="c ok">✓</td><td class="c unk">·</td><td class="c ok">✓</td><td class="c ok">✓</td><td class="c ok">✓</td></tr>
  <tr><td>标注 → 卡片 → 间隔复习</td><td class="c ok">✓ 回顾（SM-2）</td><td class="c gap">—</td><td class="c gap">—</td><td class="c gap">—</td><td class="c ok">✓ FSRS</td><td class="c gap">—</td></tr>
  <tr><td>摘录工作区（拖出、连线、跨文档）</td><td class="c gap">—</td><td class="c gap">—</td><td class="c gap">—</td><td class="c ok">✓ 核心</td><td class="c ok">✓ 脑图</td><td class="c gap">—</td></tr>
  <tr><td>扫描件 OCR</td><td class="c gap">—</td><td class="c gap">—</td><td class="c part">△ 外部命令</td><td class="c part">△ 付费</td><td class="c ok">✓</td><td class="c gap">—</td></tr>
</tbody>
</table>
<p class="note">Trove 在这一格里比 Zotero 多出的：智能跳转与 Portal（Zotero 只认文档自带链接）、<b>Overview 候选（识别不了也能手选）</b>、
图像区域放大灯箱、直线 / 矩形 / 箭头图形标注、句级朗读高亮、重排阅读、阅读标尺与命令面板（Zotero 均无）。
少的是：摘录画布（决定不做）、OCR（不做）。</p>

<h3>4.3 组织、检索与引用</h3>
<table class="m">
  <thead><tr>
    <th style="width:24%">能力</th><th class="c">Trove</th><th class="c">Zotero</th><th class="c">JabRef</th>
    <th class="c">calibre</th><th class="c">Paperless</th><th class="c">Readwise</th><th class="c">Koodo</th>
  </tr></thead>
  <tbody>
  <tr><td>层级收藏集 / 分组</td><td class="c ok">✓</td><td class="c ok">✓</td><td class="c ok">✓ Groups</td><td class="c ok">✓ 虚拟库</td><td class="c part">△ 标签</td><td class="c part">△ 标签</td><td class="c gap">—</td></tr>
  <tr><td>保存的检索 / 智能集合</td><td class="c ok">✓ 条件树</td><td class="c ok">✓</td><td class="c ok">✓ 搜索组</td><td class="c ok">✓</td><td class="c unk">·</td><td class="c ok">✓ 搜索</td><td class="c gap">—</td></tr>
  <tr><td>标签 + 颜色</td><td class="c ok">✓</td><td class="c ok">✓</td><td class="c part">△ 关键词</td><td class="c ok">✓</td><td class="c ok">✓</td><td class="c ok">✓</td><td class="c gap">—</td></tr>
  <tr><td>查重与合并</td><td class="c ok">✓</td><td class="c ok">✓</td><td class="c ok">✓</td><td class="c part">△</td><td class="c gap">—</td><td class="c gap">—</td><td class="c gap">—</td></tr>
  <tr><td>大库列表流畅度（视口挂载）</td><td class="c ok">✓ 1 万条 0.5 s</td><td class="c ok">✓</td><td class="c ok">✓</td><td class="c unk">·</td><td class="c unk">·</td><td class="c unk">·</td><td class="c gap">—</td></tr>
  <tr><td>正文全文检索</td><td class="c ok">✓ worker + 增量索引</td><td class="c ok">✓</td><td class="c ok">✓ Lucene</td><td class="c ok">✓</td><td class="c ok">✓ OCR 全量</td><td class="c ok">✓ 高亮库</td><td class="c part">△</td></tr>
  <tr><td>检索语法：字段 / 布尔 / 条件组 UI</td><td class="c ok">✓ 嵌套条件组 + 正则</td><td class="c ok">✓ 嵌套条件组</td><td class="c ok">✓ LaTeX 语法</td><td class="c ok">✓</td><td class="c part">△</td><td class="c part">△</td><td class="c gap">—</td></tr>
  <tr><td>相似文档推荐</td><td class="c ok">✓ tf-idf + 共享词</td><td class="c part">△ 需插件</td><td class="c gap">—</td><td class="c gap">—</td><td class="c ok">✓</td><td class="c gap">—</td><td class="c gap">—</td></tr>
  <tr><td>结果级切换（条目 / 附件 / 批注 / 笔记）</td><td class="c ok">✓</td><td class="c ok">✓</td><td class="c gap">—</td><td class="c gap">—</td><td class="c gap">—</td><td class="c ok">✓</td><td class="c gap">—</td></tr>
  <tr><td>citekey 可配模板</td><td class="c ok">✓ 模板 + 修饰符</td><td class="c part">△ 需插件</td><td class="c ok">✓ 修饰符齐全</td><td class="c gap">—</td><td class="c gap">—</td><td class="c gap">—</td><td class="c gap">—</td></tr>
  <tr><td>CSL 样式</td><td class="c part">△ 子集 + 可导入</td><td class="c ok">✓ 上万份在线</td><td class="c ok">✓</td><td class="c unk">·</td><td class="c gap">—</td><td class="c gap">—</td><td class="c gap">—</td></tr>
  <tr><td>写作软件集成（Word / LaTeX）</td><td class="c gap">—</td><td class="c ok">✓</td><td class="c ok">✓</td><td class="c gap">—</td><td class="c gap">—</td><td class="c ok">✓ 导出</td><td class="c gap">—</td></tr>
  <tr><td>参考文献表批量入库</td><td class="c ok">✓ 预览 + 置信度</td><td class="c ok">✓ 逐条 magic wand</td><td class="c part">△</td><td class="c gap">—</td><td class="c gap">—</td><td class="c gap">—</td><td class="c gap">—</td></tr>
  <tr><td><b>笔记内图片缩放</b></td><td class="c ok">✓ 把手拖拽 + 写回内容</td><td class="c unk">·</td><td class="c unk">·</td><td class="c unk">·</td><td class="c unk">·</td><td class="c unk">·</td><td class="c unk">·</td></tr>
  <tr><td><b>内置使用说明（软件内可搜索）</b></td><td class="c ok">✓ F1，76 节</td><td class="c part">△ 文档站 + 社区（软件内无）</td><td class="c unk">·</td><td class="c unk">·</td><td class="c unk">·</td><td class="c unk">·</td><td class="c unk">·</td></tr>
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
    <td><span class="tag t-done">Smart Jump（10-27）、标尺 / 命令面板 / Portal（1.5.0）、Overview（1.5.2）已移植</span>；
      Portals 是单窗口对照栏版（不做多窗口）。Overview 做成了「候选区 + 全库搜索」两段——比原版多一个「机器没候选时人还能搜」的兜底</td>
  </tr>
  <tr>
    <td>LiquidText</td>
    <td>把摘录拖到原文旁边的画布、跨页连线、多文档并排；导出摘录为 DOCX</td>
    <td>中 / 低</td>
    <td>画布整体不做（Web 渲染 + 单窗口下收益低于成本）；「导出 DOCX」已作为笔记导出 Word 补上（第六版）</td>
  </tr>
  <tr>
    <td>MarginNote 4</td>
    <td>摘录自动成卡、<b>遮挡式主动回忆</b>、FSRS 排期、卡片标题自动链接（读到旧概念自动亮）、大纲（Tab 缩进调层级）</td>
    <td>高</td>
    <td><span class="tag t-done">成卡 + 遮挡 + 排期已移植（10-29）</span>；用 SM-2 而非 FSRS；<b>大纲与标题自动链接仍未做</b>——第八版清单里的第一件</td>
  </tr>
  <tr>
    <td>Readwise</td>
    <td>每日复习配额（每天 5–15 条而不是倾泻全部）、显示答案后一次性给足评分选项、复习与来源双向跳转、阅读队列</td>
    <td>高</td>
    <td><span class="tag t-done">配额 / 评分 / 跳转已移植（10-29），阅读队列已移植（1.5.0）</span></td>
  </tr>
  <tr>
    <td>JabRef</td>
    <td><b>citekey 模板</b>（<code>[auth][year][title:abbr]</code> 与 <code>authN</code> / <code>auth.etal</code> 等修饰符）；XMP 元数据写回 PDF；Lucene 全文索引；按关键词自动归组</td>
    <td>中高</td>
    <td><span class="tag t-done">citekey 模板已移植（10-29）</span>；XMP 写回暂不做（要写 PDF 二进制，与「导出副本」是两条路）；Lucene 不引（已有自研索引 worker）</td>
  </tr>
  <tr>
    <td>Okular</td>
    <td>印章（stamp）标注、批注归档成单文件（<code>.okular</code>）、PDF 表单填写、数字签名验证、DjVu / CBZ / CHM 阅读</td>
    <td>中 / 低</td>
    <td><span class="tag t-done">印章 + 批注归档 zip 已移植（1.5.0）</span>；签名验证要引密码学依赖，暂不做；DjVu / CHM 不做</td>
  </tr>
  <tr>
    <td>calibre</td>
    <td>阅读统计与热力图、元数据批量下载、虚拟库（= 智能收藏集）</td>
    <td>高</td>
    <td><span class="tag t-done">统计热力图 / 虚拟库已移植（10-27）</span>；元数据来源仍只有 Crossref / arXiv（1.5.0 起支持首页识别自动取）</td>
  </tr>
  <tr>
    <td>Paperless-ngx</td>
    <td>OCR、自动标签 / 文档类型抽取、<b>相似文档</b>推荐、全文命中直接高亮跳转</td>
    <td>中</td>
    <td><span class="tag t-done">相似文档已移植（1.5.0）：tf-idf + 余弦 + 共享词</span>；OCR 明确不做（要外部引擎，违背零依赖）；命中跳转已有</td>
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
  <thead><tr><th style="width:24%">功能</th><th style="width:18%">出处</th><th style="width:42%">在 Trove 里长成什么样</th><th style="width:16%">轮次</th></tr></thead>
  <tbody>
  <tr><td>智能跳转</td><td>Sioyek Smart Jump</td><td>点 <code>[12]</code> / <code>[Smith, 2020]</code> 跳参考文献并高亮；点条目行反查正文标记，不依赖文档自带链接</td><td>10-27</td></tr>
  <tr><td>双页对开</td><td>Okular / Sumatra 标配</td><td><code>Ctrl+Shift+D</code>，封面独占、偶左奇右</td><td>10-27</td></tr>
  <tr><td>阅读进度与统计</td><td>Koodo / calibre</td><td>列表进度条 + 「继续阅读」；统计面板 + 12 周阅读时长热力图</td><td>10-27</td></tr>
  <tr><td>公式渲染 / 双向链接</td><td>Joplin / Obsidian</td><td>KaTeX 本地渲染；<code>[[标题]]</code> + 反链 + 别名</td><td>10-27</td></tr>
  <tr><td>可视化检索条件 / 期刊订阅</td><td>Zotero 10</td><td>条件构建器；Feeds 式按需拉取订阅</td><td>10-27</td></tr>
  <tr><td>检索迁出主进程</td><td>（工程向；JabRef 用 Lucene 的思路）</td><td>worker 线程 + 增量索引队列 + 建完自动重跑查询；打包路径已验证</td><td>10-29 / 10-30</td></tr>
  <tr><td>回顾（间隔重复）</td><td>MarginNote + Readwise</td><td>标注 → 卡片 → 模糊遮挡 → 想一下 → 显示 → 四档评分 → 到期再见</td><td>10-29</td></tr>
  <tr><td>citekey 模板 / 嵌套回复树 / 笔记导出 Word</td><td>JabRef / Zotero / LiquidText</td><td>模板引擎与旧算法逐字符等价；<code>/IRT</code> 重建父子树；Word 零依赖导出</td><td>10-29</td></tr>
  <tr><td>阅读标尺 / 命令面板 / 重排阅读 / Portal / 印章 / 归档 / 条件组嵌套 / 相似文献 / 参考文献表入库 / 中文字形子集 / 笔记表格编辑 / 题录识别 / 阅读队列</td><td>（第七版一次清账，出处见 4.4）</td><td>对齐度 94% → 96% 的全部来处</td><td>10-30（1.5.0）</td></tr>
  <tr><td><b>内置使用指南（F1）</b></td><td>（自研；对标缺口而非某家产品）</td><td>10 组 76 节、可搜索、可在界面定位、可直达功能；覆盖度由 <code>check-help</code> 机器守（235 个控件登记 + 证据校验）</td><td>10-30（1.5.1）</td></tr>
  <tr><td><b>Overview 候选出处</b></td><td>Sioyek Overview</td><td>候选按把握排序（百分比）+ 全库搜索兜底；<code>Alt+O</code> / 右键 / 状态栏「挑一篇」；选完走与自动 Portal 完全相同的通路；排除当前在读的那篇</td><td>10-30（1.5.2）</td></tr>
  <tr><td><b>笔记图片缩放</b></td><td>（Notion / Typora 式图片尺寸的轻量版）</td><td>把手拖拽 40–2400 px，Markdown 侧写回 <code>#w=</code>、截图侧写 <code>imageW</code>；双击还原原尺寸</td><td>10-30（1.5.2）</td></tr>
</tbody>
</table>

<h2>五、仍然缺什么（按影响排序，按本版清账后的新局面重排）</h2>

<h3>1. 体感件（下一轮候选）</h3>
<ul>
  <li><b>卡片标题自动链接与大纲</b>（MarginNote）—— 读到旧概念自动亮、Tab 缩进调层级；回顾体验的下一步。<b>现在是清单里排最前的一项</b>。</li>
  <li><b>Sioyek Portals 的多窗口跟随</b> —— 现在只在单窗口对照栏内跟随；多窗口要重新设计会话与标签的关系。</li>
  <li><b>笔记里的多级标题样式自定义与笔记级元数据面板</b> —— 图片缩放补齐后，笔记模块剩下的就是这两件。</li>
</ul>

<h3>2. 中等成本、收益明确</h3>
<ul>
  <li><b>XMP 元数据写回 PDF</b>（JabRef）—— 要写 PDF 二进制，与「导出副本」是两条路；做之前要先想清楚与 sidecar 的关系。</li>
  <li><b>扁平化批注恢复</b> —— 把外部工具散落输出的批注收敛回 sidecar；数据模型不动，纯解析活。</li>
</ul>

<h3>3. 老账：已全部清账</h3>
<ul>
  <li><b>中文文字标注的字体子集</b> —— 已还（1.5.0）：系统 CJK TrueType + fontkit 子集嵌入。</li>
  <li><b>从参考文献表批量入库</b> —— 已还（1.5.0）：规则链解析 + dryRun 预览 + 三档置信度。</li>
  <li><b>PDF reflow</b> —— 已还（1.5.0）：坐标还原段落的纯函数方案，不追排版引擎。</li>
  <li><b>「功能都在、没人知道怎么用」</b> —— 已还（1.5.1）：内置使用指南，且覆盖度由脚本守住，新的功能不会再漏。</li>
</ul>
<p>第七版排的「Overview 候选弹窗 / 卡片标题自动链接 / 笔记图片缩放」三件，<b>两件已还、一件仍在</b>。</p>

<h3>4. 明确不做（写清理由，避免每轮重复讨论）</h3>
<p>云同步、群组库、协作、Web Library、移动端、插件系统、跨平台打包；Word / LibreOffice 插件与 RTF Scan（跨应用，与「无账号 / 单窗口 / 本地文件」冲突）；
OCR（要外部引擎，违背零依赖；真要做得作为外部工具接入）；内置翻译（需联网 API）；LiquidText 式摘录画布（Web 渲染 + 单窗口下收益低于成本）。
这一版没有一处被「对齐度」逼着改口。</p>

<h3>5. 结构性缺口（跨应用，分母里保留、不给满分）</h3>
<p>Word 活引用、群组库 / 协作、机构代理与 Find Full Text 式多源聚合、移动端——这些决定了加权对齐度的天花板。
第八版的结论与第七版一致：<b>96% 上下就是「单机 / 单窗口 / 零依赖」这个前提下的合理水位</b>（本版实测 96.2%），
继续往上抬只有两种方式：要么破前提，要么等 Zotero 侧的对照口径变化。</p>

<h2>六、本轮验证</h2>
<table class="avoid-break">
  <thead><tr><th style="width:34%">回归</th><th class="c" style="width:12%">项数</th><th>覆盖</th></tr></thead>
  <tbody>
  <tr><td>核心纯 Node 回归 11 支（本报告生成时复跑，全部退出 0）</td><td class="c">534</td>
    <td><code>test-reflow</code> 40、<code>test-similar</code> 35、<code>test-advsearch</code> 139、<code>test-citekey</code> 75、
      <code>test-refimport</code> 81、<code>test-portal</code> <b>44</b>（原 30，新增候选排序 14 条：降序、地板、limit、回收站过滤、
      「matchEntry 结果 = 候选第一名」不变量）、<code>test-recall</code> 64、<code>test-pdftext</code> 21、
      <code>test-fingerprint</code> 10、<code>test-identify-fields</code> 10、<code>test-library-meta</code> 15</td></tr>
  <tr><td><code>test-markdown</code>（<code>#w=</code> 往返）</td><td class="c">56</td>
    <td>渲染出 <code>data-md-w</code> / style 且 URL 里的标记被剥掉；<code>fromHtml</code> 三级回读（标记 → 属性 → 行内样式）；
      <code>fromHtml(render(fromHtml))</code> 稳定；上下限收敛、非法值不生效</td></tr>
  <tr><td><code>test-overview</code>（真实 Electron，真库 + 占位 PDF）</td><td class="c">22</td>
    <td>入口打开并显示当前条目、候选排序第一名正确、把握百分比、无关条目不进候选、排除当前在读的这篇、全库搜索能绕开排名、Esc 关闭、
      <code>portal-pick</code> 补出路径与起始页、不存在的 key 给失败而不是异常、全程无脚本错误</td></tr>
  <tr><td><code>test-note-image</code>（真实 Electron）</td><td class="c">15</td>
    <td>把手出现、拖动后源码被改写（不是只改 DOM）、图片以外正文不动、渲染读回宽度、双击还原、截图宽度跨存储层落库、全程无脚本错误</td></tr>
  <tr><td>使用指南</td><td class="c">32 + 0 待补</td>
    <td><code>check-help</code>：76 节 / 235 个控件全部登记并命中（结构 + 归属 + 证据三道校验）；<code>test-help</code>：32 项真实 Electron 回归全过</td></tr>
  <tr><td>既有的界面端到端（本轮复跑）</td><td class="c">—</td>
    <td><code>test-library-ui</code>、<code>test-reader-rotate-split</code>、<code>test-ref-doc</code>、<code>test-v36-reading-ui</code>、
      <code>test-read-queue</code>、<code>test-review-ui</code> 全量通过；另有 19 支纯 Node 回归（library / 备份 / 迁移 / 搜索 / 引用 / 导出 等）同轮通过</td></tr>
  <tr><td>打包产物冒烟（<code>test-packaged</code>）</td><td class="c">未重跑</td>
    <td><b>v1.5.2 本轮未打包</b>（按用户选择：先只落源码），打包冒烟仍以 1.5.1 为准（17/17）；下一轮出包时必须重跑</td></tr>
  </tbody>
</table>
<p class="note">仓库内共 <b>128</b> 个 <code>test-*.js</code>（第七版时 125）。上面加粗数字为本次复跑实测。
<b>这一版有两处是端到端探针抓出来的、纯 Node 单测发现不了的问题</b>：<code>publicItem</code> 漏传 <code>notes[].imageW</code>（存得进、界面读不回），
以及候选列表的过期响应覆盖新结果（已用代际号修）。</p>

<h2>七、结论</h2>
<p>加权对齐度 <b>95.6% → 96.2%</b>，涨的每一分都能指到具体一行：阅读器 96→98（Overview 候选弹窗）、笔记 97→99（图片缩放）。
其余模块本轮未动，剩余差距与第七版一致。</p>
<p>清单的形状继续在变：第七版末尾排的三件「自己用得爽」的事，这一轮还清两件；另外把<b>「功能都在、没人知道怎么用」</b>这件事一并解决——
内置使用指南不是新功能，但它决定了前面那些功能有没有被用上。剩下的体感件以<b>卡片标题自动链接与大纲</b>为首，
中等成本项仍是 XMP 写回与扁平化批注恢复，结构性跨应用缺口一件没动。</p>
<p><b>明确不做的仍然不做</b>：云同步、群组库、协作、Web Library、移动端、插件系统、跨平台打包、Word / LibreOffice 插件与 RTF Scan、
OCR、内置翻译、LiquidText 式摘录画布。理由在第五章第 4 节。96% 不是终点，是「单机 / 单窗口 / 零依赖」这个前提下的合理水位。</p>

<footer>Trove · 本地文献库与 PDF 阅读器 · 报告生成于 2026-10-30（第八版）· 评估对象：v1.5.2（源码已就绪、尚未打包；基线 v1.5.0 已发布，v1.5.1 已打包安装）·
数据来源：本仓库 CHANGELOG（1.5.1 / 1.5.2 两节）、测试套件（128 支 test-*.js，本报告生成时复跑核心 11 支 + markdown / overview / note-image + check-help）；
Zotero 基线来自 zotero.org 变更日志与 support 文档（10.x，检索时间 2026-10-29）；其余产品来源同第六版
（sioyek.info、liquidtext.net、marginnote.com、readwise.io、docs.jabref.org、okular.kde.org、calibre 手册、docs.paperless-ngx.com、koodoreader.com，
本轮未重检，未核实项沿用 · 号）</footer>

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
    // 旧版备份进项目目录（评审报告/），桌面只保留最新一份
    try {
      if (fs.existsSync(OUT) && !fs.existsSync(BACKUP)) fs.copyFileSync(OUT, BACKUP);
    } catch (_) {}
    fs.writeFileSync(OUT, pdf);
    // 项目目录里也留一份，源码与文档同源
    try { fs.writeFileSync(PROJECT_COPY, pdf); } catch (_) {}
    console.log('report written:', OUT, pdf.length, 'bytes');
    console.log('project copy:', PROJECT_COPY);
    if (fs.existsSync(BACKUP)) console.log('backup:', BACKUP);
  } catch (err) {
    console.error('report failed:', err && err.message ? err.message : err);
    process.exitCode = 1;
  } finally {
    try { fs.unlinkSync(tmpHtml); } catch (_) {}
    win.destroy();
    app.quit();
  }
});
