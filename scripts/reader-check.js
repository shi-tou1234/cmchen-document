'use strict';
/*
 * 阅读器新能力探针（跑在真实渲染进程里）：文本层 / 全文搜索高亮 / 侧栏(目录·缩略图·批注) /
 * 便签工具 / 标注自动保存。run2（恢复探针）见 reader-check-restore.js。
 * 前提：app 以 PDFREADER_PROBE=本文件 PDFREADER_PROBE_PDF=样本 启动，隐藏窗口。
 */
module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const checks = [];
  const push = (n, ok, detail) => checks.push([n, !!ok, detail == null ? '' : String(detail)]);

  // 等文档 + 首页渲染 + 文本层铺设（异步）
  for (let i = 0; i < 200 && !App.state.pdfDoc; i++) await sleep(50);
  if (!App.state.pdfDoc) return { fatal: 'doc not loaded' };
  for (let i = 0; i < 200 && !App.state.rendered.get(1); i++) await sleep(50);
  await sleep(400);

  // --- 文本层 ---
  const spans = document.querySelectorAll('#page-1 .textlayer span');
  const allText = Array.from(spans).map((s) => s.textContent).join(' ');
  push('文本层已铺设 span', spans.length > 0, 'spans=' + spans.length);
  push('文本层含页面文字(可选中复制的前提)', /Sample page 1/i.test(allText), allText.slice(0, 60));

  // --- 全文搜索 + 高亮 ---
  await App.doSearch('sample');
  push('搜索命中 3 页', App.state.search.results.length >= 3, 'n=' + App.state.search.results.length);
  push('第1页有命中高亮矩形', (App.state.search.rects.get(1) || []).length >= 1);
  const hlNodes = document.querySelectorAll('#page-1 .hl-layer .hl');
  push('高亮节点已渲染', hlNodes.length >= 1, 'hl=' + hlNodes.length);
  const hRect = hlNodes[0] ? hlNodes[0].getBoundingClientRect() : null;
  const pRect = $('#page-1').getBoundingClientRect();
  push('高亮落在页面范围内', !!hRect && hRect.left >= pRect.left - 2 && hRect.right <= pRect.right + 2,
    hRect ? Math.round(hRect.left - pRect.left) + ',' + Math.round(hRect.top - pRect.top) : 'none');

  // --- 便签 + 画笔 shape 进模型，触发自动保存 ---
  const shapes = App.state.annos.get(1) || [];
  shapes.push({ tool: 'note', color: '#f0a500', width: 0, size: 14, at: { x: 100, y: 100 }, text: '探针便签' });
  shapes.push({ tool: 'pen', color: '#e53935', width: 3, pts: [{ x: 60, y: 60 }, { x: 160, y: 130 }] });
  App.state.annos.set(1, shapes);
  Anno.renderPage(1);
  App.notifyAnnoChanged();
  await sleep(1100); // 保存去抖 600ms + IPC
  push('便签标记已渲染', !!$('#page-1 .anno .note-mark'));
  push('便签悬停 title 含内容', (document.querySelector('#page-1 .anno .note-mark title') || {}).textContent === '探针便签');

  // --- 侧栏：批注面板 ---
  $('#btn-sidebar').click();
  await sleep(80);
  document.querySelector('.sb-tab[data-tab="annos"]').click();
  await sleep(150);
  const annoItems = document.querySelectorAll('#anno-list .anno-item');
  push('批注面板列出标注', annoItems.length >= 2, 'n=' + annoItems.length);
  push('批注面板含便签文本', Array.from(annoItems).some((a) => /探针便签/.test(a.textContent)));
  // v14 起批注导出分成 Markdown / CSV / 纯文本三个按钮
  push('导出批注按钮存在', document.querySelectorAll('[data-note-fmt]').length === 3,
    'n=' + document.querySelectorAll('[data-note-fmt]').length);

  // --- 侧栏：缩略图（隐藏窗口 rAF ~1Hz，渲染被量化到约 1s/张 → 轮询等待） ---
  document.querySelector('.sb-tab[data-tab="thumbs"]').click();
  let thumbCount = 0;
  for (let i = 0; i < 100 && !(thumbCount = document.querySelectorAll('#sb-thumbs canvas').length); i++) await sleep(100);
  push('缩略图已渲染(懒)', thumbCount >= 1, 'n=' + thumbCount);

  // --- 侧栏：目录（sample.pdf 无书签 → 空态文案） ---
  document.querySelector('.sb-tab[data-tab="outline"]').click();
  await sleep(200);
  push('目录空态提示', /没有目录/.test($('#sb-outline').textContent || ''));

  // 搜索结果面板（挂在批注标签下）
  document.querySelector('.sb-tab[data-tab="annos"]').click();
  await sleep(80);
  push('搜索结果面板列出命中', document.querySelectorAll('#sb-search-results .search-result').length >= 3);

  return { checks };
})()`;
