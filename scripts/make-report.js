'use strict';
/*
 * 生成《Trove 与 Zotero 功能差距评估报告》更新版 PDF（2026-10-31，第九版）。
 * 第五版新增第四章：与 9 款同类产品的横向对照，并据此重排缺口清单。
 * 第六版把「对齐度」表里仍标「仍差」的四项补齐（citekey 模板、批注属性条件、嵌套回复树、笔记导出 Word）。
 * 第七版对应 v1.5.0：第六版「仍然缺什么」清单里的 9 项（含三笔老账）全部清账。
 * 第八版对应 v1.5.1（软件内置使用指南）+ v1.5.2（Overview 候选弹窗、笔记图片缩放）。
 * 第九版对应 v1.6.0：第八版「仍然缺什么」里**不属于「明确不做」的项一次清完**——
 *   引用（同上 / 前引、作者消歧、COinS）、题录（RDF / MARCXML、EndNote 附件还原）、
 *   抓取（机构代理、多源聚合）、笔记（多级标题样式、笔记级元数据）、回顾（大纲、卡片自动链接）、
 *   标注（扁平化副本可恢复）、题录写回 PDF。另经七轮外部复核，把「关窗丢改动」「撤销回退笔记」
 *   两条 P1 数据丢失问题闭环。
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
<div class="sub">2026-10-31 更新版（第九版）· 评估对象：Trove <b>v1.6.0</b>（已打包发布，portable + 安装包）·
本版把第八版「仍然缺什么」里不属于「明确不做」的项<b>一次清完</b>，并闭环两条 P1 数据丢失问题</div>

<div class="note">
  <b>这一版做了什么</b>：第八版收尾时列了三件体感件（卡片标题自动链接与大纲、Portals 多窗口、笔记标题样式与元数据面板），
  外加两件「中等成本」的老账（XMP 写回、扁平化批注恢复）。这一轮<b>除了 Portals 多窗口（与「单窗口」前提冲突，未动）之外，其余全部做完</b>，
  并把报告里另外三处「仍差」一并补齐：<b>引用</b>（同上 / 前引、作者消歧、COinS）、<b>题录</b>（RDF / MARCXML、EndNote 附件还原）、
  <b>抓取</b>（机构代理、Find Full Text 式多源聚合）。
  加权对齐度 <b>96.2% → 97.8%</b>。涨得比前几版多，原因不是「这轮干得多」，而是<b>天花板本身被抬高了</b>——
  机构代理与多源聚合此前被记在「结构性缺口」里，这一轮在应用内做成了，那笔账要重算。
</div>

<h2>一、这一版的变化</h2>
<table class="avoid-break">
  <thead><tr><th style="width:14%">方向</th><th style="width:46%">做了什么</th><th style="width:40%">为什么值得单独记一笔</th></tr></thead>
  <tbody>
  <tr>
    <td><b>引用</b></td>
    <td><b>脚注体引注</b>（Chicago note 写法，期刊出卷期年页 + DOI 链接）、<b>同上 / 前引</b>（紧接同一条出「同上 / Ibid.」，之前引过出「前引 / op. cit.」）、<b>同姓作者消歧</b>（<code>J. Smith</code> / <code>R. Smith</code>）、参考文献 HTML <b>内嵌 COinS</b></td>
    <td>这三件事看起来零碎，其实是同一个问题：<b>文内引注只写姓，读者凭什么分清是谁</b>。消歧规则抄 APA——撞车时<b>所有</b>条目都补首字母，只补一条会让另一条看起来像「唯一的 Smith」。同上则只对脚注体有意义，作者-年份制重复引用必须重复写全，所以拆成一组独立函数，不去污染 <code>citeInText</code> 的语义</td>
  </tr>
  <tr>
    <td><b>题录</b></td>
    <td><b>Zotero RDF / Dublin Core / MARCXML</b> 读写（<code>.xml</code> 按内容分辨三种格式）、<b>EndNote <code>internal-pdf://</code> 附件还原</b>（按 XML 所在目录试几个落点）、<b>题录写回 PDF</b>（Info + XMP，另存副本）</td>
    <td>前两项是「和别的工具换数据」欠的账；第三项是 JabRef 的 XMP 写回，报告里躺了两版没做。做的时候定了一条：<b>默认另存副本，不改原文件</b>——写 PDF 二进制不是无损操作（对象重排、交叉引用表重建），一次失败就可能让原文档打不开，这和「删除只改索引」是同一条原则</td>
  </tr>
  <tr>
    <td><b>抓取</b></td>
    <td><b>机构代理</b>（EZproxy 前缀式 / 域名式两种真实写法）、<b>OpenURL 链接解析器</b>（SFX / Alma / 360Link）、<b>开放获取四路并行</b>（Unpaywall / OpenAlex / Semantic Scholar / Europe PMC）；已知直链先跑，不等索引返回</td>
    <td>这是报告里挂了四版的「结构性缺口」，一直以「要账号 / 要机构」为由没做。实际上 EZproxy 只是<b>给 URL 加个前缀</b>，OpenURL 只是<b>按规范拼一串参数</b>——不需要账号，只需要用户填一个地址。真正难的只有「别让它拖慢正常抓取」：代理版排在直连之后，落地页排在 OA 之后</td>
  </tr>
  <tr>
    <td><b>笔记与回顾</b></td>
    <td>笔记 <b>H1–H6 字号倍率与字重</b>（预览与导出同一套数）、<b>笔记级元数据面板</b>（状态 / 标签 / 字数 / 时间 / 来源）；回顾 <b>大纲页签</b>（<code>Tab</code> 缩进调层级）、笔记正文里<b>卡片标题自动变链接</b></td>
    <td>大纲与自动链接是第八版清单里排第一的体感件（MarginNote 那一路）。自动链接刻意只认<b>在回顾里</b>的卡片、标题至少 4 个字、不动代码块——「亮」本身就是信息，亮太多就废了</td>
  </tr>
  <tr>
    <td><b>标注</b></td>
    <td><b>扁平化副本可恢复</b>：导出副本时把原始 shapes 作为 PDF 附件写进去（<code>trove-annotations.json</code>），打开副本点「导入 PDF 批注」可完整恢复（含颜色、评论、子类型、稳定 id）</td>
    <td>「扁平化之后批注就回不来了」原本是代码注释里的一句免责声明。这轮换了条路：<b>既然副本是我们自己导出的，那就把原始数据一起塞进去</b>。外部工具扁平化的 PDF 仍然读不回来——这条边界照旧写在 README 里，不吹</td>
  </tr>
  <tr>
    <td><b>可靠性</b></td>
    <td>七轮外部复核，逐条闭环：<b>关窗保存握手</b>（笔记 + 标注存完再关；存失败拦下关闭；超时不算成功；<code>Esc</code> 永不等于放弃）、<b>撤销纳入笔记编辑</b>并按「一次连续编辑」合并、标注保存保护改用「已显示文档」的凭据、<b>图片语法收敛成一份定义</b>、合并重复条目同时搬标注关联、关闭文档作废在途加载</td>
    <td>前两条都是<b>真丢数据</b>：撤销「加标签」会把后来保存的笔记正文一起回退；改完标注立刻点 ✕，最后一批改动还在 600ms 的防抖定时器里。这类问题界面一切正常，只有重启或关窗才现形——纯 Node 单测发现不了，得靠端到端探针和磁盘比对</td>
  </tr>
</tbody>
</table>

<h2>二、能力对照（上一版 → 当前）</h2>
<table>
  <thead><tr><th style="width:15%">模块</th><th style="width:30%">上一版（1.5.2，第八版）</th><th style="width:38%">当前（1.6.0）</th><th style="width:17%">结论</th></tr></thead>
  <tbody>
  <tr>
    <td><b>引用</b></td>
    <td>文内引注只有「作者-年份 / 编号」两种体；<b>缺同上 / 前引、作者消歧、COinS</b></td>
    <td><b>脚注体 + 同上 / 前引</b>（<code>citeSequence</code> 按序列判定）、<b>同姓消歧</b>（<code>authorLabels</code>）、参考文献 HTML <b>内嵌 COinS</b></td>
    <td class="c"><span class="tag t-done">已补齐</span> 缺 Word 活引用（跨应用）</td>
  </tr>
  <tr>
    <td><b>题录 / 导入导出</b></td>
    <td>BibTeX / RIS / CSL-JSON / EndNote / RefWorks；<b>缺 RDF、MARC，EndNote 附件路径不还原</b></td>
    <td><b>Zotero RDF / Dublin Core / MARCXML</b> 读写；<code>.xml</code> 按内容分辨；<b>EndNote <code>internal-pdf://</code> 还原</b>；<b>题录写回 PDF</b>（Info + XMP，另存副本）</td>
    <td class="c"><span class="tag t-done">已补齐</span> MARC 只映射常用字段</td>
  </tr>
  <tr>
    <td><b>抓取与发现</b></td>
    <td>arXiv → Unpaywall → doi.org / 直链；<b>缺机构代理、多源聚合</b></td>
    <td><b>机构代理</b>（两种写法）+ <b>OpenURL 解析器</b> + <b>开放获取四路并行</b>；已知直链先跑不等索引</td>
    <td class="c"><span class="tag t-done">已补齐</span> 缺 OCR（不做）</td>
  </tr>
  <tr>
    <td><b>笔记</b></td>
    <td>图片缩放已通；<b>缺多级标题样式、笔记级元数据面板</b></td>
    <td><b>H1–H6 倍率 + 字重</b>（预览与导出同源）、<b>元数据面板</b>（状态 / 标签 / 字数 / 时间 / 来源）</td>
    <td class="c"><span class="tag t-done">已补齐</span></td>
  </tr>
  <tr>
    <td><b>回顾</b></td>
    <td>成卡 / 遮挡 / 排期已通；<b>缺大纲、卡片标题自动链接</b></td>
    <td><b>大纲页签</b>（<code>Tab</code> 缩进，落 <code>recall.json</code>）+ <b>卡片标题自动变链接</b></td>
    <td class="c"><span class="tag t-done">已补齐</span> 用 SM-2 而非 FSRS</td>
  </tr>
  <tr>
    <td><b>标注</b></td>
    <td>印章 / 归档 / 副本已通；<b>扁平化批注无法恢复</b></td>
    <td><b>副本内嵌 <code>trove-annotations.json</code></b>，打开副本可完整恢复</td>
    <td class="c"><span class="tag t-done">已补齐</span> 仅限 Trove 导出的副本</td>
  </tr>
  <tr>
    <td><b>阅读器</b></td>
    <td>Overview 已补齐；缺 Portals 多窗口跟随</td>
    <td>本轮未改动</td>
    <td class="c"><span class="tag t-mid">保持</span> 多窗口与「单窗口」前提冲突</td>
  </tr>
  <tr>
    <td><b>检索 / 组织</b></td>
    <td>条件组嵌套、相似文献、智能收藏集均保持</td>
    <td>本轮未改动</td>
    <td class="c"><span class="tag t-mid">保持</span> 群组库不做</td>
  </tr>
  <tr>
    <td><b>可靠性</b></td>
    <td>R7-01 / R7-02 已闭环</td>
    <td>七轮复核：<b>关窗丢改动</b>、<b>撤销回退笔记</b>两条 P1 闭环；标注保存保护改凭据；图片定位改传偏移</td>
    <td class="c"><span class="tag t-done">已闭环</span></td>
  </tr>
</tbody>
</table>

<h2>三、对齐度与工程质量</h2>
<p>这一版的分数来自<b>六块同时补齐</b>：引用（92 → 96）、抓取（88 → 94）、导入导出（93 → 97）、笔记（99 → 100）、标注（99 → 100），
加权后 <b>96.2% → 97.8%</b>。涨得比前几版都多，原因不是「这轮干得多」，而是<b>天花板被抬高了</b>：
机构代理与 Find Full Text 式多源聚合此前被记在「结构性缺口」里（第 5 节），这一轮在应用内做成了，那笔账要重算。
权重与前八版完全一致，表列出来便于复核。</p>

<div class="kpi">
  <div><b>97.8%</b><span>加权对齐度（96.2% → 97.8%）</span></div>
  <div><b>6</b><span>第八版清单里不属于「明确不做」的项，全部清账</span></div>
  <div><b>7 轮</b><span>外部复核逐条闭环（含 2 条 P1 数据丢失）</span></div>
  <div><b>17/17</b><span>1.6.0 打包产物冒烟（asar / 索引 / 导出副本 / docx）</span></div>
</div>

<table>
  <thead><tr><th style="width:22%">模块</th><th class="c" style="width:9%">权重</th><th class="c" style="width:11%">第八版</th><th class="c" style="width:11%">当前</th><th>依据 / 剩余差距</th></tr></thead>
  <tbody>
  <tr><td>阅读器</td><td class="c">0.18</td><td class="c">98%</td><td class="c">98%</td><td>本轮未改动。剩 2 分：Sioyek Portals 的多窗口跟随（与「单窗口」前提冲突，明确不做）</td></tr>
  <tr><td>标注</td><td class="c">0.16</td><td class="c">99%</td><td class="c">100%</td><td><b>补齐扁平化副本恢复</b>：副本内嵌原始 shapes，打开即可还原。边界：只对 Trove 导出的副本成立</td></tr>
  <tr><td>检索</td><td class="c">0.14</td><td class="c">98%</td><td class="c">98%</td><td>本轮未改动。剩 2 分：万条级复杂条件上 Zotero 的数据库索引仍有性能优势；自然语言查询不做</td></tr>
  <tr><td>笔记</td><td class="c">0.12</td><td class="c">99%</td><td class="c">100%</td><td><b>补齐多级标题样式与笔记级元数据面板</b>——笔记模块的清单清空</td></tr>
  <tr><td>组织</td><td class="c">0.12</td><td class="c">97%</td><td class="c">97%</td><td>本轮未改动。仍差群组库（决定不做，结构性）</td></tr>
  <tr><td>引用</td><td class="c">0.12</td><td class="c">92%</td><td class="c">96%</td><td><b>补齐同上 / 前引、作者消歧、COinS</b>。剩 4 分：CSL 仍是自研子集（不是 citeproc-js）、Word 活引用跨应用不做</td></tr>
  <tr><td>抓取与发现</td><td class="c">0.08</td><td class="c">88%</td><td class="c">94%</td><td><b>补齐机构代理与多源聚合</b>。剩 6 分：OCR 不做；解析器只做「形状」校验，可用性取决于机构配置</td></tr>
  <tr><td>导入导出</td><td class="c">0.08</td><td class="c">93%</td><td class="c">97%</td><td><b>补齐 RDF / MARCXML 与 EndNote 附件还原</b>。剩 3 分：MARC 只映射常用字段，不是编目级转换；BibTeX 类型专属字段仍会丢</td></tr>
</tbody>
</table>
<p class="note">口径说明：跨应用能力（Word 插件、群组库、移动端、协作）在<b>分母里保留、不给满分</b>。
第八版说「96% 上下是合理水位」，这一版要修正半句：<b>机构代理与多源聚合原本被算进那批跨应用能力，实际不需要账号也能做</b>，
所以水位抬到了 97.5 上下。剩下的 2 分以上仍然只能靠破前提（Word 插件、群组库、移动端）来拿。
加权合计 97.80%（保留一位：97.8%）。「上手与说明」不计入加权。</p>

<h3>3.1 工程质量（不与 Zotero 比，跟自己比）</h3>
<table class="avoid-break">
  <thead><tr><th style="width:22%">指标</th><th style="width:16%">上一版</th><th style="width:16%">当前</th><th>说明</th></tr></thead>
  <tbody>
  <tr><td>关窗时的改动</td><td class="gap">600ms 防抖里的改动会丢</td><td class="ok">握手 + 重试 + 不误判</td><td>关闭前先把笔记与标注存完再关；<b>存失败拦下关闭</b>（选「返回处理」后待保存记录保留，下次关窗继续重试）；<b>超时不算成功</b>（弹窗询问，默认继续等待）；<code>Esc</code> 永不等于「放弃」</td></tr>
  <tr><td>撤销与笔记</td><td class="gap">撤销别的操作会回退已保存的正文</td><td class="ok">笔记进栈 + 合并撤销点</td><td>笔记三个写操作都进撤销栈，同一条笔记 4 秒内的连续编辑合并成一个点；撤销按操作顺序走，不再一次退掉一大段</td></tr>
  <tr><td>图片定位</td><td class="part">按 DOM 序号对应源码</td><td class="ok">源码偏移一路传递</td><td>渲染时把图片的源码位置写进 <code>data-md-img-src</code>（脚注挪位、表格重排都不影响）；<b>定位不到就不改</b>，不按序号猜——宁可这次不改，也不能改到别人身上</td></tr>
  <tr><td>标注保存保护</td><td class="part">凭据用全局加载代际</td><td class="ok">用「已显示文档」的凭据</td><td>修掉「打开第三份文档被误拦」；<code>unknown</code> / <code>broken</code> 仍然一律不写盘，保护一个字没放宽</td></tr>
  <tr><td>打包产物</td><td>1.5.1 冒烟 17/17</td><td class="ok">1.6.0 冒烟 17/17</td><td>asar 内运行、PDF 渲染、全文索引、库级搜索、导出带标注副本、docx 转换、导出 PDF 可重开且含高亮填充</td></tr>
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
  <tr><td>标注 → 卡片 → 间隔复习</td><td class="c ok">✓ 回顾（SM-2）+ 大纲 + 卡片标题自动链接</td><td class="c gap">—</td><td class="c gap">—</td><td class="c gap">—</td><td class="c ok">✓ FSRS</td><td class="c gap">—</td></tr>
  <tr><td>摘录工作区（拖出、连线、跨文档）</td><td class="c gap">—</td><td class="c gap">—</td><td class="c gap">—</td><td class="c ok">✓ 核心</td><td class="c ok">✓ 脑图</td><td class="c gap">—</td></tr>
  <tr><td>扫描件 OCR</td><td class="c gap">—</td><td class="c gap">—</td><td class="c part">△ 外部命令</td><td class="c part">△ 付费</td><td class="c ok">✓</td><td class="c gap">—</td></tr>
</tbody>
</table>
<p class="note">Trove 在这一格里比 Zotero 多出的：智能跳转与 Portal（Zotero 只认文档自带链接）、<b>Overview 候选（识别不了也能手选）</b>、
图像区域放大灯箱、直线 / 矩形 / 箭头图形标注、句级朗读高亮、重排阅读、阅读标尺与命令面板、<b>回顾卡片的大纲与标题自动链接</b>（Zotero 均无）。
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
  <tr><td><b>同上 / 前引、作者消歧</b></td><td class="c ok">✓ 脚注体 + 同姓补首字母</td><td class="c part">△ 需插件</td><td class="c part">△</td><td class="c gap">—</td><td class="c gap">—</td><td class="c gap">—</td><td class="c gap">—</td></tr>
  <tr><td><b>题录可被别的工具抓回</b>（COinS / RDF / MARC）</td><td class="c ok">✓ 三者都支持</td><td class="c ok">✓ 全格式</td><td class="c ok">✓ BibTeX / XMP</td><td class="c unk">·</td><td class="c gap">—</td><td class="c gap">—</td><td class="c gap">—</td></tr>
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
    <td><span class="tag t-done">成卡 + 遮挡 + 排期（10-29）、大纲与标题自动链接（1.6.0）已移植</span>；用 SM-2 而非 FSRS。
      自动链接刻意只认<b>在回顾里</b>的卡片、标题至少 4 个字、不动代码块——「亮」本身就是信息，亮太多就废了</td>
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
    <td><span class="tag t-done">citekey 模板（10-29）、XMP 写回（1.6.0）已移植</span>；XMP 写回做成「<b>另存副本</b>」而不是就地写回——
      写 PDF 二进制不是无损操作，一次失败就可能让原文档打不开。另注：pdf-lib 在序列化时会改写 <code>/Producer</code>，
      所以「谁生成的」只写在 XMP 里。Lucene 不引（已有自研索引 worker）</td>
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
  <tr><td><b>回顾大纲 / 卡片标题自动链接</b></td><td>MarginNote 4</td><td>大纲按加入顺序排全部卡片，<code>Tab</code> 缩进调层级（只影响这张表，不改调度）；笔记正文里出现卡片标题自动变链接，点一下回原文</td><td>10-31（1.6.0）</td></tr>
  <tr><td><b>同上 / 前引、作者消歧、COinS</b></td><td>Zotero / 学术写作惯例</td><td>脚注体引注 + 序列判定同上 / 前引；同姓补首字母；参考文献 HTML 内嵌 COinS，可被连接器抓回</td><td>10-31（1.6.0）</td></tr>
  <tr><td><b>RDF / MARCXML / EndNote 附件还原</b></td><td>Zotero / EndNote</td><td>两种 RDF 与 MARCXML 读写，<code>.xml</code> 按内容分辨；<code>internal-pdf://</code> 按 XML 所在目录试落点，找不到只导入题录</td><td>10-31（1.6.0）</td></tr>
  <tr><td><b>机构代理 / OpenURL / 多源聚合</b></td><td>Zotero Find Full Text</td><td>EZproxy 两种写法 + SFX / Alma / 360Link 基址 + 四路开放获取并行；代理与解析器只从设置读，抓取参数里不接受</td><td>10-31（1.6.0）</td></tr>
  <tr><td><b>题录写回 PDF（XMP）</b></td><td>JabRef</td><td>Info 字典 + XMP 一起写，<b>另存副本</b>不动原文件；尖括号与 <code>&amp;</code> 等全部转义，中文按 UTF-8 落盘</td><td>10-31（1.6.0）</td></tr>
  <tr><td><b>扁平化副本可恢复</b></td><td>（自研；补的是「扁平化不可逆」这条老边界）</td><td>导出副本时把原始 shapes 作为 PDF 附件写进去，打开副本点「导入 PDF 批注」可完整恢复</td><td>10-31（1.6.0）</td></tr>
</tbody>
</table>

<h2>五、仍然缺什么（按影响排序，按本版清账后的新局面重排）</h2>

<h3>1. 体感件（下一轮候选）：已清空</h3>
<p>第八版这一档列了三件，这一版做完两件半：<b>卡片标题自动链接与大纲</b>（做完）、<b>笔记多级标题样式与元数据面板</b>（做完）、
<b>Portals 多窗口跟随</b>（<b>不做</b>——它要求「会话与标签」重新设计，与「单窗口」这个前提直接冲突）。
所以这一档现在<b>没有下一轮候选</b>了。这是第一次出现这种情况，值得记一笔：
不是清单被悄悄删掉，而是清单上的东西真的做完了。</p>

<h3>2. 中等成本、收益明确：已清空</h3>
<p>第八版这两件——<b>XMP 元数据写回 PDF</b>、<b>扁平化批注恢复</b>——都做完了。做的时候各让了一步，写在这里免得下一轮重新讨论：</p>
<ul>
  <li><b>XMP 写回做成「另存副本」</b>，不就地改原文件。写 PDF 二进制不是无损操作（对象重排、交叉引用表重建），一次失败就可能让原文档打不开。</li>
  <li><b>扁平化恢复只对 Trove 导出的副本成立</b>：数据是我们自己塞进去的附件；外部工具扁平化出来的 PDF 里没有这份附件，仍然只能靠 <code>/Annots</code>，那部分确实读不回来。</li>
</ul>
<p>如果还要继续投入，下一档候选是「CSL 换成 citeproc-js + 官方样式库」（引用模块剩下的 4 分）与「检索换倒排索引」（检索模块剩下的 2 分）——
两件都不是「补一个功能」，是<b>换一套引擎</b>，所以没放进这一轮。</p>

<h3>3. 老账：已全部清账</h3>
<ul>
  <li><b>中文文字标注的字体子集</b> —— 已还（1.5.0）：系统 CJK TrueType + fontkit 子集嵌入。</li>
  <li><b>从参考文献表批量入库</b> —— 已还（1.5.0）：规则链解析 + dryRun 预览 + 三档置信度。</li>
  <li><b>PDF reflow</b> —— 已还（1.5.0）：坐标还原段落的纯函数方案，不追排版引擎。</li>
  <li><b>「功能都在、没人知道怎么用」</b> —— 已还（1.5.1）：内置使用指南，覆盖度由脚本守住。</li>
  <li><b>引用三件（同上 / 前引、消歧、COinS）、题录两件（RDF / MARC、EndNote 附件）、抓取两件（机构代理、多源聚合）</b> —— 已还（1.6.0）。</li>
</ul>

<h3>4. 明确不做（写清理由，避免每轮重复讨论）</h3>
<p>云同步、群组库、协作、Web Library、移动端、插件系统、跨平台打包；Word / LibreOffice 插件与 RTF Scan（跨应用，与「无账号 / 单窗口 / 本地文件」冲突）；
OCR（要外部引擎，违背零依赖；真要做得作为外部工具接入）；内置翻译（需联网 API）；LiquidText 式摘录画布（Web 渲染 + 单窗口下收益低于成本）；
自然语言检索；<b>Sioyek Portals 的多窗口跟随</b>（与「单窗口」前提冲突）。
这一版<b>没有一处</b>因为「做不动」而改口——清单上的项要么做完，要么本来就在这一档。</p>

<h3>5. 结构性缺口（跨应用，分母里保留、不给满分）</h3>
<p>Word 活引用、群组库 / 协作、移动端——这些决定了加权对齐度剩下的天花板。
第八版把「机构代理与 Find Full Text 式多源聚合」也列在这里，<b>这一版要修正</b>：它们其实不需要账号，只需要用户填一个地址
（EZproxy 前缀 / OpenURL 基址），所以在应用内做成了。剩下三件都是真跨应用：<b>要么破前提，要么等 Zotero 侧的对照口径变化</b>。</p>

<h2>六、本轮验证</h2>
<table class="avoid-break">
  <thead><tr><th style="width:34%">回归</th><th class="c" style="width:12%">项数</th><th>覆盖</th></tr></thead>
  <tbody>
  <tr><td><b>新增</b> <code>test-cite-note</code></td><td class="c">74</td>
    <td>同姓消歧边界（撞车 / 同一人重复 / 中文名不造首字母）、四种文献类型的脚注体、三种 collapse（同上 / 前引 / 不缩写）、坏输入不抛、COinS 字段映射与编码、章节的 atitle / btitle 不混</td></tr>
  <tr><td><b>新增</b> <code>test-refio-formats</code></td><td class="c">89</td>
    <td>RDF 往返与 DC 简版、MARCXML 往返、<b>角色与字段往返</b>（编者不降级成作者、出版社 / ISBN / ISSN 不丢）、<code>.xml</code> 三种格式按内容分辨、EndNote 附件候选路径与「找不到就放弃」</td></tr>
  <tr><td><b>新增</b> <code>test-note-meta</code></td><td class="c">23 + 29</td>
    <td>元数据规范化 / 落库 / <code>publicItem</code> 字段完整性 / <b>重启后仍在</b>；面板开关、字数、状态与标签跨存储层往返、标题倍率真的改到预览字号、卡片自动链接只认回顾卡片</td></tr>
  <tr><td><b>新增</b> <code>test-pdf-meta</code></td><td class="c">39</td>
    <td><b>原文件字节不变</b>、Info 与 XMP 都能读回、<b>中文 XMP 不乱码</b>、缺字段不写空值、默认不覆盖、坏输入不抛、特殊字符转义</td></tr>
  <tr><td><b>新增</b> <code>test-close-flush</code></td><td class="c">15</td>
    <td>关窗前那一刻的标注<b>真的落盘</b>（磁盘验证，不靠防抖）；保存失败保留脏状态、重试成功才清空；<b>自动保存失败</b>同样保留；超时提示的 <code>Esc</code> 永不等于「放弃」</td></tr>
  <tr><td><code>test-markdown</code></td><td class="c">76</td>
    <td>渲染与扫描口径一致（含标题里的 <code>&amp;</code>）、代码区两侧都不算、<b>同一张图两处引用的源码位置各自正确</b>、表格图与转义竖线后的偏移</td></tr>
  <tr><td><code>test-note-image</code></td><td class="c">40</td>
    <td>把手拖拽 / 源码改写 / 渲染读回 / 双击还原；带标题、含 <code>&amp;</code>、脚注图、表格图四种错位场景各改各的</td></tr>
  <tr><td><code>test-undo</code> / <code>test-main-race</code> / <code>test-library</code></td><td class="c">27 / 21 / 87</td>
    <td>笔记编辑合并成撤销点且撤销不回退正文；关闭最后一个标签时在途加载作废；合并重复条目同时搬 <code>annoIds</code> 与 <code>annoMeta.itemKey</code></td></tr>
  <tr><td><code>test-fetchpdf</code> / <code>test-native-annos</code> / <code>test-atc-citation</code></td><td class="c">55 / 44 / 16</td>
    <td>四路 OA 聚合、代理两种写法、OpenURL 排序、落地页不挡 OA；打开副本恢复 11 条（含颜色 / 评论 / 子类型 / 稳定 id）；<code>A→B→A</code> 出前引、紧接出同上</td></tr>
  <tr><td>使用指南</td><td class="c">32 + 0 待补</td>
    <td><code>check-help</code>：78 节 / <b>248</b> 个控件全部登记并命中（结构 + 归属 + 证据三道校验）；<code>test-help</code> 32 项真实 Electron 回归全过</td></tr>
  <tr><td><b>打包产物冒烟</b>（<code>test-packaged</code>）</td><td class="c">17 / 17</td>
    <td>1.6.0 portable：asar 内运行、PDF 渲染、主进程建索引、库级搜索命中、导出带标注副本、docx 转换、导出 PDF 可重开且含高亮填充</td></tr>
  <tr><td>其余界面端到端（本轮复跑）</td><td class="c">—</td>
    <td><code>test-library-ui</code>、<code>test-reader-rotate-split</code>、<code>test-ref-doc</code>、<code>test-v36-reading-ui</code>、<code>test-read-queue</code>、<code>test-review-ui</code>、<code>test-v36-anno-ui</code> 全量通过；另有数十支纯 Node 回归同轮通过</td></tr>
  </tbody>
</table>
<p class="note"><b>这一版最值得记的不是功能数，是七轮复核的结论</b>：新增功能里有两条 <b>P1 数据丢失</b>（撤销回退笔记、关窗丢改动），
它们界面一切正常、纯 Node 单测全绿，只有端到端探针 + 磁盘比对才抓得到。
修的过程也暴露了一个模式：同一个概念散在几个入口时，只修报告指出的那一处是不够的——
最后把「什么算脏」收敛到 <code>saveNoteRich</code> 一处，才算收口。</p>

<h2>七、结论</h2>
<p>加权对齐度 <b>96.2% → 97.8%</b>，涨的每一分都能指到具体一行：引用 92→96（同上 / 前引、消歧、COinS）、
抓取 88→94（机构代理、多源聚合）、导入导出 93→97（RDF / MARC、EndNote 附件）、笔记 99→100、标注 99→100。</p>
<p><b>这一版最实质的变化是「清单空了」</b>：第八版的「体感件」与「中等成本」两档，本版清完；
剩下的只有两类——<b>明确不做的</b>（含 Portals 多窗口），和<b>要换引擎才能再进一步的</b>（CSL → citeproc、检索 → 倒排索引）。
前者不该做，后者是另一轮工程，都不适合塞在「补功能」的轮次里。</p>
<p>还有一个口径要修正：第八版说「96% 上下是单机前提下的合理水位」，把机构代理与多源聚合算进了结构性缺口。
这一版证明<b>它们不需要账号，只需要用户填一个地址</b>，所以水位抬到了 97.5 上下。
剩下 2 分以上仍然只能靠破前提（Word 插件、群组库、移动端）来拿。</p>
<p><b>明确不做的仍然不做</b>：云同步、群组库、协作、Web Library、移动端、插件系统、跨平台打包、Word / LibreOffice 插件与 RTF Scan、
OCR、内置翻译、LiquidText 式摘录画布、自然语言检索、Portals 多窗口。理由在第五章第 4 节。</p>

<footer>Trove · 本地文献库与 PDF 阅读器 · 报告生成于 2026-10-31（第九版）· 评估对象：v1.6.0（已打包发布：portable + 安装包，打包冒烟 17/17）·
数据来源：本仓库 CHANGELOG（1.6.0 一节，含七轮复核记录）、测试套件（本报告生成时复跑新增 5 支 + 扩展十余支 + 打包冒烟）、
Zotero 基线来自 zotero.org 变更日志与 support 文档（10.x）；其余产品来源同第六版
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
    // 桌面只保留最新一份：旧版不再备份到项目目录（2026-10-31 起只输出这一份）
    fs.writeFileSync(OUT, pdf);
    console.log('report written:', OUT, pdf.length, 'bytes');
  } catch (err) {
    console.error('report failed:', err && err.message ? err.message : err);
    process.exitCode = 1;
  } finally {
    try { fs.unlinkSync(tmpHtml); } catch (_) {}
    win.destroy();
    app.quit();
  }
});
