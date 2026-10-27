'use strict';
/*
 * 生成《Trove 与 Zotero 功能差距评估报告》更新版 PDF（2026-10-27，评估对象 v1.4.0）。
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
const BACKUP = path.join(OUT_DIR, 'Trove与Zotero功能差距评估报告-2026-10-21备份-2.pdf');

const HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<style>
  @page { size: A4; margin: 16mm 15mm 15mm; }
  * { box-sizing: border-box; }
  body {
    font-family: "Microsoft YaHei", "PingFang SC", "SimSun", sans-serif;
    font-size: 10.2pt; line-height: 1.62; color: #22262b; margin: 0;
  }
  h1 { font-size: 20pt; margin: 0 0 2mm; letter-spacing: .5px; }
  .sub { color: #6b7280; font-size: 9.4pt; margin-bottom: 6mm; }
  h2 {
    font-size: 13pt; margin: 7mm 0 2.5mm; padding-bottom: 1.2mm;
    border-bottom: 1px solid #e3e6ea;
  }
  h3 { font-size: 10.8pt; margin: 4.5mm 0 1.6mm; color: #2f3540; }
  p { margin: 1.6mm 0; }
  table { width: 100%; border-collapse: collapse; margin: 2.5mm 0 3mm; font-size: 9.2pt; }
  th, td { border: 1px solid #e1e4e8; padding: 1.4mm 2mm; text-align: left; vertical-align: top; }
  th { background: #f4f6f8; font-weight: 600; color: #3a4250; }
  td.c { text-align: center; white-space: nowrap; }
  .ok { color: #1a7f4b; font-weight: 600; }
  .part { color: #a3690a; font-weight: 600; }
  .gap { color: #a33; font-weight: 600; }
  .tag { display: inline-block; font-size: 8.4pt; padding: 0 1.4mm; border-radius: 2px; margin-right: 1mm; }
  .t-done { background: #e7f5ec; color: #1a7f4b; }
  .t-no { background: #fdeeee; color: #a33; }
  .t-keep { background: #eef1f5; color: #4a5563; }
  ul { margin: 1.5mm 0 2mm; padding-left: 5mm; }
  li { margin: .8mm 0; }
  .note {
    background: #f7f8fa; border-left: 3px solid #c9cfd7; padding: 2.2mm 3mm;
    margin: 3mm 0; font-size: 9.2pt; color: #4a5260;
  }
  .kpi { display: flex; gap: 3mm; margin: 3mm 0 2mm; }
  .kpi div {
    flex: 1; border: 1px solid #e1e4e8; border-radius: 3px; padding: 2.6mm 3mm; background: #fbfcfd;
  }
  .kpi b { display: block; font-size: 15pt; color: #1f2733; }
  .kpi span { font-size: 8.6pt; color: #6b7280; }
  footer { margin-top: 6mm; font-size: 8.6pt; color: #9aa1ab; border-top: 1px solid #eef0f2; padding-top: 2mm; }
  .avoid-break { break-inside: avoid; }
</style></head><body>

<h1>Trove 与 Zotero 功能差距评估报告</h1>
<div class="sub">2026-10-27 更新版 · 评估对象：Trove 1.4.0（tag v1.4.0）· 在 2026-10-24 版基础上同步本轮实现状态</div>

<div class="note">
  <b>这一版的核心变化</b>：上一版列为「建议下一轮单独做」的重交互阅读能力全部落地——双页对开、整篇旋转
  0/90/180/270、只读分屏参考视图、跨页连续朗读与句级高亮、用户书签；文献库补上 RSS / Atom 期刊订阅、库统计
  （含阅读时长热力图）、阅读进度与「继续阅读」、检索可视化条件构建器、多集合并集、EndNote XML 导入；笔记补上
  双向链接与 KaTeX 公式；标注补上 PDF 原生批注的回复关系。同时把三轮外部审核报出的 17 个问题（B01–B12、
  R01–R05）全部闭环并落成固定回归。下面按模块重新打分。
</div>

<h2>一、能力对照（上一版 → 当前）</h2>

<table class="avoid-break">
  <tr><th style="width:16%">模块</th><th style="width:30%">上一版状态（10-24）</th><th style="width:34%">当前状态（1.4.0）</th><th style="width:20%">结论</th></tr>
  <tr>
    <td><b>检索</b></td>
    <td>OR / 括号、分页与类型切换已通；缺可视化条件构建器</td>
    <td>可视化条件构建器（字段 + 排除 + 多行 AND，无损往返；OR / 括号原串保留不误改）；列表快速筛选与全文检索共用一套语法</td>
    <td class="c"><span class="tag t-done">已补齐</span>查询仍在主进程</td>
  </tr>
  <tr>
    <td><b>标注</b></td>
    <td>原生批注导入与库级筛选已通；缺回复关系</td>
    <td>原生批注回复关系（/IRT）随导入保留，面板与标注库显示「↳ 回复」；扁平化批注仍无法恢复</td>
    <td class="c"><span class="tag t-done">已补齐</span>缺嵌套回复树</td>
  </tr>
  <tr>
    <td><b>笔记</b></td>
    <td>模板与自包含导出已通；缺公式与双向链接</td>
    <td>KaTeX 公式渲染（$…$ / $$…$$，无 katex 时降级为原文）；独立笔记 [[标题]] 双向链接与反链列表；表格仍是 Markdown 语法</td>
    <td class="c"><span class="tag t-done">已补齐</span>缺表格可视化编辑</td>
  </tr>
  <tr>
    <td><b>组织</b></td>
    <td>大库视口挂载已通；缺多集合并集</td>
    <td>收藏集 Ctrl 多选并集视图；库统计面板（类型 / 出版年份 / 入库年份 / 标签 Top / 附件与笔记覆盖率 / 阅读时长热力图）</td>
    <td class="c"><span class="tag t-done">已补齐</span>缺群组库</td>
  </tr>
  <tr>
    <td><b>阅读器</b></td>
    <td>会话恢复、导航历史、放大模式已通；缺旋转 / 分屏 / 对开</td>
    <td>双页对开（封面独占、偶左奇右）、整篇旋转 0/90/180/270（标注坐标不变）、只读分屏参考视图、跨页连续朗读 + 句级高亮 + 位置记忆、用户书签（B 键，与标注同 sidecar）、阅读进度上报、阅读时长统计</td>
    <td class="c"><span class="tag t-done">已补齐</span>缺 reflow</td>
  </tr>
  <tr>
    <td><b>引用</b></td>
    <td>CSL 子集与多格式导出已通；缺文内引注定位符</td>
    <td>文内引注定位符（编号制 [n, p. 5] / 作者-年份制 (Smith, 2024, p. 5)）；智能跳转：点 [12] / [Smith, 2020] 跳到参考文献条目，点条目反查正文标记，不依赖文档自带链接</td>
    <td class="c"><span class="tag t-done">已补齐</span>缺同上 / 前引与 Word 活引用</td>
  </tr>
  <tr>
    <td><b>抓取与发现</b></td>
    <td>批量抓取、网页快照已通；缺订阅</td>
    <td>RSS / Atom 期刊订阅：按需拉取（点开才联网，不后台轮询）、条目一键收录为 webpage 条目并按 URL 防重复；仍不做机构代理</td>
    <td class="c"><span class="tag part">部分补齐</span>缺机构代理与推送</td>
  </tr>
  <tr>
    <td><b>导入导出</b></td>
    <td>备份资源闭环 + 笔记导出；缺 EndNote XML</td>
    <td>EndNote XML 导入（内联样式、CDATA、实体、单双引号属性、Book Section 类型）；仍缺 RDF / MARC</td>
    <td class="c"><span class="tag t-done">已补齐</span>缺 RDF / MARC</td>
  </tr>
  <tr>
    <td><b>可靠性</b></td>
    <td>三轮评审核查 12 个缺陷闭环</td>
    <td>三轮外部审核 17 个缺陷闭环（B01–B12、R01–R05）：书签保存的跨文档串写与并发覆盖、合并数据目录漏订阅、EndNote 样式污染、条件构建器往返改义、对开位图泄漏与快速跳页残留、富文档继承对开、跨页参考文献首次反查、Atom 单引号链接、统计年份口径</td>
    <td class="c"><span class="tag t-done">已补齐</span></td>
  </tr>
</table>

<h2>二、对齐度重新评估</h2>

<div class="kpi">
  <div><b>87% → 92%</b><span>加权总对齐度（按使用频次加权）</span></div>
  <div><b>16 项</b><span>上一版列出的缺口本轮补齐</span></div>
  <div><b>96 个</b><span>测试脚本（92 Node 驱动 + 3 直跑 + 1 打包冒烟）</span></div>
</div>

<table class="avoid-break">
  <tr><th style="width:22%">模块</th><th style="width:12%">上一版</th><th style="width:12%">当前</th><th>主要依据</th></tr>
  <tr><td>检索</td><td class="c">92%</td><td class="c ok">95%</td><td>可视化条件构建器 + 无损往返；差查询移出主进程</td></tr>
  <tr><td>标注</td><td class="c">93%</td><td class="c ok">95%</td><td>原生批注回复关系；差嵌套回复树与扁平化批注</td></tr>
  <tr><td>笔记</td><td class="c">85%</td><td class="c ok">93%</td><td>公式渲染 + 双向链接；差表格可视化编辑</td></tr>
  <tr><td>组织</td><td class="c">94%</td><td class="c ok">96%</td><td>多集合并集 + 统计面板；差群组（保持不做）</td></tr>
  <tr><td>引用</td><td class="c">80%</td><td class="c ok">88%</td><td>文内引注定位符 + 智能跳转；差同上 / 前引、作者消歧、Word 活引用</td></tr>
  <tr><td>阅读器</td><td class="c">85%</td><td class="c ok">93%</td><td>对开 / 旋转 / 分屏 / 朗读 / 书签 / 进度；差 reflow 重排</td></tr>
  <tr><td>抓取与发现</td><td class="c">80%</td><td class="c ok">82%</td><td>RSS 订阅补上「发现」环节；差机构代理与非开放获取</td></tr>
  <tr><td>导入导出</td><td class="c">85%</td><td class="c ok">90%</td><td>EndNote XML；差 RDF / MARC</td></tr>
</table>

<h2>三、仍然缺失什么（按影响排序）</h2>

<h3>1. 数据层与性能（重度使用场景，最值得投入）</h3>
<ul>
  <li><b>查询移出主进程</b>：搜索 / 统计仍同步扫 JSON，大库查询时输入可能被拖慢；增量 IPC 未做。这是目前唯一影响「大库手感」的结构性问题。</li>
  <li>全文索引仍是全量重建（单文件按 mtime / size 跳过）；扫描件 OCR；PDF 副本中文文字标注受 Helvetica 编码限制（需嵌 CJK 字体）。</li>
</ul>

<h3>2. 引用（投稿级一致性）</h3>
<ul>
  <li>CSL 仍是自研子集：同上 / 前引、作者消歧、et-al 细节不做；投稿要求逐字一致时，从 zotero.org/styles 导入官方 .csl。</li>
  <li>HTML 内嵌 COinS、Word 活引用插件——按项目定位暂缓。</li>
</ul>

<h3>3. 阅读器（剩下的都是重工程）</h3>
<ul>
  <li>PDF reflow 重排（按屏宽重排正文）；跨文档双页对照（当前对开只针对同一份文档）。</li>
  <li>标注的嵌套回复树：导入时只保留 replyTo 关系，不重建树形结构。</li>
</ul>

<h3>4. 笔记与表格</h3>
<ul>
  <li>表格增删行列的可视化编辑（当前按 Markdown 语法手写）。</li>
</ul>

<h3>5. 明确不做（保持产品定位）</h3>
<p>云同步、群组库、协作、Web Library、移动端、插件系统、跨平台 —— 与「无账号 / 无网络 / 单窗口 / Windows / JSON / 零原生依赖」的前提冲突，不在规划内。</p>

<h2>四、本轮验证</h2>
<p>当前共 <b>96 个测试脚本</b>：92 个 Node 驱动 + 3 个直跑 Electron（画笔 / 真实输入 / 懒渲染）+ 1 个打包产物冒烟，
源码回归 95 个全部退出 0（打包冒烟在发版后单独跑）。三轮外部审核的 17 个缺陷各有固定回归：其中书签保存的
时序问题用「源码原函数 + 受控 IPC 时序」覆盖 10 组场景（并发添加、同页连按、成功/失败组合、切文档、
A→B→A、关闭文档），并在真实 Electron 里用真实 preload 与隔离 sidecar 复核内存与磁盘一致。</p>

<h2>五、结论</h2>
<p>上一版判断「阅读器的重交互能力建议单独一轮做」，这一轮做完后<b>阅读器</b>从 85% 升到 93%：对开、旋转、
分屏、朗读、书签、智能跳转、阅读进度都可用，且旋转不改变标注坐标、对开只保留当前页组位图、快速跳页不再
积累离屏画布。加上检索条件构建器、笔记公式与互链、多集合并集、订阅与统计、EndNote XML，Trove 在
<b>阅读 + 标注 + 笔记 + 检索 + 整理</b>主线上的对齐度由 87% 升至 <b>92%</b>。剩余差距集中在两类：数据层
性能（查询调度 / OCR）与投稿级引用细节；都不阻塞日常使用。</p>

<footer>Trove · 本地文献库与 PDF 阅读器 · 报告生成于 2026-10-27 · 评估对象 v1.4.0 · 数据来源：本仓库 CHANGELOG 与测试套件</footer>

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
    await new Promise((r) => setTimeout(r, 600));
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
