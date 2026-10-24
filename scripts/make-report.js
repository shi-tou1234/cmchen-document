'use strict';
/*
 * 生成《Trove 与 Zotero 功能差距评估报告》更新版 PDF（2026-10-24，评估对象 v1.3.0）。
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
<div class="sub">2026-10-24 更新版 · 评估对象：Trove 1.3.0（提交 7d78a8b）· 在 2026-10-22 版基础上同步当前实现状态</div>

<div class="note">
  <b>这一版的核心变化</b>：10-22 版列出的剩余硬缺口已全部落地——自研 CSL 引用引擎与多格式参考文献导出、
  批量抓取与网页快照、检索 OR / 括号嵌套、大库视口挂载、PDF 原生批注导入；另新增搜索结果分页与类型切换、
  标注类型 / 颜色筛选、阅读会话恢复、阅读导航历史、笔记模板与自包含导出。三轮独立评审核查
  （R01–R06、N01–N05、M01）共 12 个缺陷全部修复并有回归覆盖。下面按模块重新打分，并列出仍然缺失的能力。
</div>

<h2>一、能力对照（上一版 → 当前）</h2>

<table class="avoid-break">
  <tr><th style="width:16%">模块</th><th style="width:30%">上一版状态（10-22）</th><th style="width:34%">当前状态（1.3.0）</th><th style="width:20%">结论</th></tr>
  <tr>
    <td><b>检索</b></td>
    <td>差 OR / 括号嵌套；结果无分页与来源切换</td>
    <td>OR、显式 AND、括号、整组排除；结果分页（每页 120）+ 全部 / 文献 / 正文 / 批注 / 笔记类型切换与计数 + 展开更多；独立笔记字段限定修复</td>
    <td class="c"><span class="tag t-done">已补齐</span></td>
  </tr>
  <tr>
    <td><b>标注</b></td>
    <td>库对象层完整；缺 PDF 原生批注导入与库级筛选</td>
    <td>原生批注导入（高亮 / 下划线 / 波浪线 / 删除线 / 便签 / 文字框 / 手绘 / 方框 / 直线，nativeId 去重，旋转页与 CropBox）；标注库按类型 / 颜色筛选；导出跳过数量可见</td>
    <td class="c"><span class="tag t-done">已补齐</span>缺回复树 / 扁平化</td>
  </tr>
  <tr>
    <td><b>笔记</b></td>
    <td>Markdown 编辑器完整；缺模板与导出</td>
    <td>课程笔记 / 论文卡片 / 摘录汇总模板；自包含导出（HTML 含图片包 / Markdown 带相对图片目录）；富文本子笔记结构保真导出；保存失败不假导出</td>
    <td class="c"><span class="tag t-done">已补齐</span>缺公式 / 表格编辑</td>
  </tr>
  <tr>
    <td><b>组织</b></td>
    <td>差大库虚拟滚动</td>
    <td>列表视口挂载（1 万条刷新约 0.5 秒，整页约 2 千 DOM 节点）；多选 / 批量 / 撤销保持一致</td>
    <td class="c"><span class="tag t-done">已补齐</span></td>
  </tr>
  <tr>
    <td><b>阅读器</b></td>
    <td>差会话恢复与导航历史</td>
    <td>启动恢复上次标签页（20 个、激活项与页码，失联跳过）；导航历史 Alt+←/→ 与鼠标侧键；放大模式（滚轮连续缩放）</td>
    <td class="c"><span class="tag part">部分补齐</span>缺旋转 / 分屏 / reflow</td>
  </tr>
  <tr>
    <td><b>引用</b></td>
    <td>5 种硬编码样式，无 CSL、无 Word 导出</td>
    <td>自研 CSL 1.0.2 子集（macro / group / choose / names / date / number / label / sort / 页码范围）；3 份内置 CSL + 导入任意 .csl；参考文献表导出 HTML / Word(.doc) / RTF</td>
    <td class="c"><span class="tag t-done">已补齐</span>投稿级逐字一致建议官方样式</td>
  </tr>
  <tr>
    <td><b>抓取</b></td>
    <td>三路抓全文已通；缺快照与批量</td>
    <td>批量抓取（逐条进度 / 中途取消 / 已有附件跳过）；网页快照 MHTML + 首屏 PNG；下载后自动入索引</td>
    <td class="c"><span class="tag t-done">已补齐</span>缺机构代理</td>
  </tr>
  <tr>
    <td><b>可靠性</b></td>
    <td>—</td>
    <td>保存失败可见并回滚（不再假保存）；迁移 / 备份 / 恢复携带图片 / 快照 / CSL / 托管附件并回滚；附件重定位保留标注；三轮评审核查 R01–R06、N01–N05、M01 全部闭环</td>
    <td class="c"><span class="tag t-done">已补齐</span></td>
  </tr>
</table>

<h2>二、对齐度重新评估</h2>

<div class="kpi">
  <div><b>75% → 87%</b><span>加权总对齐度（按使用频次加权）</span></div>
  <div><b>10-22 版缺口 → 0</b><span>上一版列出的硬缺口剩余未做</span></div>
  <div><b>79 个</b><span>测试脚本（75 Node 驱动 + 3 直跑 + 1 打包冒烟）</span></div>
</div>

<table class="avoid-break">
  <tr><th style="width:22%">模块</th><th style="width:12%">上一版</th><th style="width:12%">当前</th><th>主要依据</th></tr>
  <tr><td>检索</td><td class="c">85%</td><td class="c ok">92%</td><td>OR / 括号、分页与类型切换；差可视化条件构建器</td></tr>
  <tr><td>标注</td><td class="c">90%</td><td class="c ok">93%</td><td>原生批注导入、类型 / 颜色筛选；差回复树与扁平化批注</td></tr>
  <tr><td>笔记</td><td class="c">72%</td><td class="c ok">85%</td><td>模板 + 自包含导出；差公式渲染与表格可视化编辑</td></tr>
  <tr><td>组织</td><td class="c">92%</td><td class="c ok">94%</td><td>大库视口挂载；差多集合并集与群组（缓做）</td></tr>
  <tr><td>引用</td><td class="c">55%</td><td class="c ok">80%</td><td>CSL 子集 + Word / HTML / RTF 导出；差文内引注定位符</td></tr>
  <tr><td>阅读器</td><td class="c">78%</td><td class="c ok">85%</td><td>会话恢复、导航历史、放大模式；差旋转 / 分屏 / reflow</td></tr>
  <tr><td>抓取</td><td class="c">45%</td><td class="c ok">80%</td><td>批量 + 快照 + 自动索引；差机构代理与非开放获取</td></tr>
  <tr><td>导入导出</td><td class="c">75%</td><td class="c ok">85%</td><td>备份资源闭环 + 笔记导出；差 RDF / MARC / EndNote XML</td></tr>
</table>

<h2>三、仍然缺失什么（按影响排序）</h2>

<h3>1. 引用（投稿级一致性）</h3>
<ul>
  <li><b>CSL 完全兼容</b>：自研子集覆盖参考文献表常用元素；文内引注定位符、同上 / 前引、作者消歧不做。投稿要求逐字一致时，从 zotero.org/styles 导入官方 .csl。</li>
  <li>HTML 内嵌 COinS、Word 活引用插件——按项目定位暂缓。</li>
</ul>

<h3>2. 阅读器（重交互，建议单独一轮）</h3>
<ul>
  <li><b>页面旋转（90 / 180 / 270）</b>：需统一 overlay 坐标体系（标注、选区、高亮都按未旋转坐标存），改动面大。</li>
  <li><b>只读分屏 / 双页对照</b>；PDF reflow 重排；跨页连续朗读续读。</li>
</ul>

<h3>3. 数据与性能（重度使用场景）</h3>
<ul>
  <li><b>查询移出主进程</b>：搜索 / 统计仍同步扫 JSON，大库查询时输入可能被拖慢；增量 IPC 未做。</li>
  <li>全文索引全量重建仍是全量（单文件已按 mtime / size 跳过）；扫描件 OCR；PDF 副本中文文字标注字体限制（Helvetica，需嵌 CJK 字体）。</li>
</ul>

<h3>4. 笔记与表格</h3>
<ul>
  <li>公式渲染（LaTeX / KaTeX，当前 $…$ 按等宽原样显示）；表格增删行列的可视化编辑；笔记双向链接。</li>
</ul>

<h3>5. 明确不做（保持产品定位）</h3>
<p>云同步、群组库、协作、Web Library、移动端、插件系统、跨平台 —— 与「无账号 / 无网络 / 单窗口 / Windows / JSON / 零原生依赖」的前提冲突，不在规划内。</p>

<h2>四、本轮验证</h2>
<p>当前共 <b>79 个测试脚本</b>：75 个 Node 驱动 + 3 个直跑 Electron（画笔 / 真实输入 / 懒渲染）+ 1 个打包产物冒烟
（17 项），全量退出码为 0。三轮独立评审核查的 12 个缺陷（R01–R06 跨文档串写 / 模板选区 / 导出完整性 /
会话截断；N01–N05 保存确认 / 富文本保真 / 缺图占位 / 链接转义 / 恢复页码；M01 旧 Markdown 链接）各有回归，
外部诊断全部转为「验证修复」通过。安装包 exe 已内嵌 Trove 名称与图标（文件关联显示正常）。</p>

<h2>五、结论</h2>
<p>10-22 版指出的两大硬缺口已补齐：<b>抓取</b>（三路全文 + 批量 + 快照 + 自动索引）与<b>引用</b>
（自研 CSL 子集 + HTML / Word / RTF 导出）。加上检索分页与类型切换、标注导入与筛选、笔记模板与自包含导出、
会话恢复与导航历史、大库视口挂载，Trove 在<b>阅读 + 标注 + 笔记 + 检索 + 整理</b>主线上的对齐度由 75% 升至
<b>87%</b>。剩余差距集中在两类：重交互的阅读能力（旋转 / 分屏 / reflow，建议下一轮单独做）与重工程的数据层
优化（查询调度 / OCR）；均不阻塞日常使用。</p>

<footer>Trove · 本地文献库与 PDF 阅读器 · 报告生成于 2026-10-24 · 评估对象 v1.3.0（提交 7d78a8b）· 数据来源：本仓库 CHANGELOG 与测试套件</footer>

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
