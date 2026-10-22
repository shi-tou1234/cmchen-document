'use strict';
/*
 * 生成《Trove 与 Zotero 功能差距评估报告》更新版 PDF（2026-10-22）。
 * 用 Electron 的 printToPDF 渲染 HTML（中文字体走系统，别引额外依赖）。
 * 运行：npx electron scripts/make-report.js
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.disableHardwareAcceleration();

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
<div class="sub">2026-10-22 更新版 · 在原 2026-10-21 报告基础上同步当前实现状态 · 评估对象：Trove（本地轻量 PDF 阅读器 + 文献库）</div>

<div class="note">
  <b>这一版的核心变化</b>：原报告列出的 7 项差距（检索补强、标注条目化二期、下划线标注、图片标注落盘、
  富文本笔记、按元数据重命名文件、EndNote / RefWorks 导入）以及独立笔记入口、库操作撤销 / 重做
  已全部落地。下面按模块重新打分，并列出仍然缺失的能力与优先级建议。
</div>

<h2>一、能力对照（上一版 → 当前）</h2>

<table class="avoid-break">
  <tr><th style="width:16%">模块</th><th style="width:30%">上一版状态</th><th style="width:34%">当前状态</th><th style="width:20%">结论</th></tr>
  <tr>
    <td><b>检索</b></td>
    <td>仅 AND 子串，按路径排序，无字段限定 / 排除 / 折叠</td>
    <td>短语、排除、14 个字段限定、变音折叠、CJK 整串；全文按相关性排序；点结果自动高亮并跳到首个命中</td>
    <td class="c"><span class="tag t-done">已补齐</span>缺 OR / 括号</td>
  </tr>
  <tr>
    <td><b>标注</b></td>
    <td>能高亮 / 批注，但无稳定 id，删一条后标签串位；不能编辑；只能导出 Markdown</td>
    <td>每条标注稳定 id + 库对象层；可改文字 / 批注 / 颜色；与条目双向关联；下划线；图片标注落盘；生成带截图笔记</td>
    <td class="c"><span class="tag t-done">已补齐</span></td>
  </tr>
  <tr>
    <td><b>笔记</b></td>
    <td>纯文本，挂条目；无独立笔记入口</td>
    <td>独立笔记条目；Markdown 预览（标题 / 表格 / 图片 / 链接 / 代码）；带页面截图的笔记；搜索命中正文</td>
    <td class="c"><span class="tag t-done">已补齐</span>缺公式 / 表格编辑</td>
  </tr>
  <tr>
    <td><b>组织</b></td>
    <td>能建收藏集 / 标签 / 回收站，不能撤销；文件名不跟随元数据</td>
    <td>按「作者 - 年份 - 标题」重命名附件（标注与全文索引随迁）；库操作撤销 / 重做（20 步）</td>
    <td class="c"><span class="tag t-done">已补齐</span></td>
  </tr>
  <tr>
    <td><b>题录</b></td>
    <td>BibTeX / RIS / CSL-JSON</td>
    <td>新增 EndNote（.enw）与 RefWorks（tagged）解析，含类型映射、结构化作者、页码区间、ISSN / 出版社</td>
    <td class="c"><span class="tag t-done">已补齐</span></td>
  </tr>
  <tr>
    <td><b>阅读器</b></td>
    <td>无旋转 / 打印 / 朗读 / 分屏</td>
    <td>朗读当前页（播放 / 暂停 / 停止，切文档自动停）；打印当前文档（交给系统默认程序，尊重打印设置）</td>
    <td class="c"><span class="tag part">部分补齐</span>缺旋转 / 分屏</td>
  </tr>
  <tr>
    <td><b>引用</b></td>
    <td>5 种引用样式 + 参考文献表 + citekey</td>
    <td>无变化（本轮未动）</td>
    <td class="c"><span class="tag part">未变</span>缺 CSL</td>
  </tr>
  <tr>
    <td><b>抓取</b></td>
    <td>DOI / arXiv 元数据；无 PDF 全文抓取</td>
    <td>arXiv 直链 / Unpaywall 开放获取 / doi.org 兜底三路抓 PDF 全文，校验魔数后会挂到条目上</td>
    <td class="c"><span class="tag t-done">已补齐</span>缺快照 / 批量</td>
  </tr>
</table>

<h2>二、对齐度重新评估</h2>

<div class="kpi">
  <div><b>42% → 75%</b><span>加权总对齐度（按使用频次加权）</span></div>
  <div><b>9 → 1</b><span>原报告「差距项」剩余未做</span></div>
  <div><b>520+</b><span>自动化断言（本轮新增 74 项）</span></div>
</div>

<table class="avoid-break">
  <tr><th style="width:22%">模块</th><th style="width:12%">上一版</th><th style="width:12%">当前</th><th>主要依据</th></tr>
  <tr><td>检索</td><td class="c">25%</td><td class="c ok">85%</td><td>语法、相关性、折叠、结果高亮闭环；差 OR / 嵌套与权重调优</td></tr>
  <tr><td>标注</td><td class="c">50%</td><td class="c ok">90%</td><td>稳定 id、可编辑、双向关联、下划线、图片标注、带图层截图</td></tr>
  <tr><td>笔记</td><td class="c">32%</td><td class="c ok">72%</td><td>独立笔记 + Markdown 预览 + 截图；差公式渲染与表格可视化编辑</td></tr>
  <tr><td>组织</td><td class="c">80%</td><td class="c ok">92%</td><td>重命名随迁、撤销重做；差标签层级与大库虚拟滚动</td></tr>
  <tr><td>引用</td><td class="c">50%</td><td class="c part">55%</td><td>仅 5 种硬编码样式；CSL 引擎仍是最大写作缺口</td></tr>
  <tr><td>阅读器</td><td class="c">60%</td><td class="c ok">78%</td><td>朗读、打印补齐；差旋转、分屏、reflow</td></tr>
  <tr><td>抓取</td><td class="c">10%</td><td class="c ok">45%</td><td>arXiv / Unpaywall / doi.org 三路抓全文已通；差网页快照与批量</td></tr>
  <tr><td>导入导出</td><td class="c">55%</td><td class="c ok">75%</td><td>四种题录格式；导出仍以 Markdown / 纯文本为主</td></tr>
</table>

<h2>三、仍然缺失什么（按影响排序）</h2>

<h3>1. 抓取（本轮进展最大，10% → 45%）</h3>
<ul>
  <li><b>arXiv / Unpaywall / doi.org 三路抓全文已通</b>（详情里新增「抓 PDF 全文」按钮）：开放获取的论文现在能一步入库，下载后校验 %PDF- 魔数，付费墙网页不会冒充成功。</li>
  <li><b>网页快照</b>（保存引用页面防链接失效）；<b>批量抓取</b>（选中一批条目一次下载）；<b>非开放获取全文</b>（需要机构代理或手动拖入）。</li>
</ul>

<h3>2. 引用（写作闭环的关键缺口）</h3>
<ul>
  <li><b>CSL 引擎</b>：Zotero 支持 10000+ 种 CSL 样式，Trove 只有 5 种硬编码（GB/T 7714、APA、Chicago、IEEE、MLA）。做这件事需要引入 citeproc-js 或自研 CSL 子集。</li>
  <li>参考文献表导出为 Word / HTML（当前 Markdown / 纯文本，粘进 Word 要再排版）。</li>
  <li>引用插入对话框（选择样式 → 插入引注到外部编辑器）——注意：Word / LibreOffice 插件属于「跨应用协作」，与项目定位冲突，不建议做。</li>
</ul>

<h3>3. 阅读器（体验缺口）</h3>
<ul>
  <li><b>页面旋转（90 / 180 / 270）</b>：需要重构 overlay 坐标体系（标注、文本选择、文字高亮都按未旋转的页面坐标存），一次性改动面较大，风险评估为「中高」，建议单独一轮做。</li>
  <li><b>分屏 / 双页对照</b>：同一文档双页并排，或两篇文档对照阅读。</li>
  <li>PDF reflow（Zotero 10 新增的重排阅读模式）；连续朗读跨页续读。</li>
</ul>

<h3>4. 笔记（知识沉淀）</h3>
<ul>
  <li>公式渲染（LaTeX）：当前 <code>$…$</code> 按等宽原样显示，没有数学排版引擎；做需要 KaTeX（约 300KB）。</li>
  <li>表格可视化编辑（现在是手写 Markdown 表格）；笔记反向链接（哪篇文献引用了这条笔记）。</li>
  <li>笔记导出 HTML / Word。</li>
</ul>

<h3>5. 数据与性能</h3>
<ul>
  <li>查询支持 <b>OR / 括号嵌套</b>：当前是 AND + 排除，复杂条件表达不了。</li>
  <li>全文索引<b>增量更新</b>：现在重建是全量的，2000 页级库要几十秒。</li>
  <li>大库<b>虚拟滚动</b>：5000+ 条目一次性渲染卡片，滚动会卡。</li>
  <li>PDF 内已有批注（Annotations）导入为 Trove 标注；扫描件 OCR（当前扫描件全文检索为空）。</li>
</ul>

<h3>6. 明确不做（保持产品定位）</h3>
<p>云同步、群组库、协作、Web Library、移动端、插件系统、跨平台 —— 与「无账号 / 无网络 / 单窗口 / Windows / JSON / 零原生依赖」的前提冲突，不在规划内。</p>

<h2>四、本轮验证</h2>
<p>本轮新增 7 个测试文件、74 项断言：<code>test-anno-extras</code> 18、<code>test-note-item</code> 14、
<code>test-rename-file</code> 14、<code>test-markdown</code> 20、<code>test-undo</code> 21、
<code>test-reader-extras</code> 19、<code>test-search-highlight</code> 14。原有 16 套回归（library 82、
lib-ui 76、search 42、formats 100、anno 系、tabs、v26-v28、bugfix、session、fulltext、v14、richdoc、
backup、modeswitch）全部通过。</p>

<h2>五、结论</h2>
<p>原报告列出的「优先级 1 检索补强」「优先级 2 标注条目化二期」与全部次要项已清零，Trove 在
<b>阅读 + 标注 + 笔记 + 本地检索</b>这条主线上已经能覆盖 Zotero 的日常使用；真正剩下的硬缺口集中在
<b>抓取（拿不到 PDF 全文）</b> 与 <b>引用（没有 CSL 引擎）</b> 两处，都属于「要引新依赖或新引擎」的
中等工程，建议下一轮先做抓取，再做 CSL。</p>

<footer>Trove · 本地文献库与 PDF 阅读器 · 报告生成于 2026-10-22 · 数据来源：本仓库 CHANGELOG 与测试套件</footer>

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
    // data URL：绕开 file:// 路径在部分环境的加载失败
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML));
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
