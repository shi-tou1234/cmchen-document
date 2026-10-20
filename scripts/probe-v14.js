module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 8000)) { if (fn()) return true; await sleep(60); } return !!fn(); };

  // ---------- 1. 标签选择器 ----------
  await waitFor(() => $$('#lib-grid .lib-card').length >= 3, 8000);
  push('库里有 3 个条目（探针前提）', $$('#lib-grid .lib-card').length === 3, 'cards=' + $$('#lib-grid .lib-card').length);

  const tagRows = $$('#lib-tags .lib-tag-row');
  push('侧栏出现标签选择器', tagRows.length >= 2, 'rows=' + tagRows.length);
  const mlRow = tagRows.find((r) => (r.dataset.tagFilter || '') === 'ML');
  push('标签列表里有 ML', !!mlRow, tagRows.map((r) => r.dataset.tagFilter).join(','));

  if (mlRow) {
    mlRow.click();
    await sleep(200);
    const cards = $$('#lib-grid .lib-card');
    const allMl = cards.length > 0 && cards.every((c) => (c.textContent || '').indexOf('ML') >= 0);
    push('点标签后只留带该标签的条目', allMl && cards.length < 3, 'cards=' + cards.length);
    push('标签行进入选中态', !!$('#lib-tags .lib-tag-row.active'), 'active=' + $$('#lib-tags .lib-tag-row.active').length);
    const clearBtn = $('#lib-tags [data-tag-clear]');
    push('出现清除筛选按钮', !!clearBtn);
    if (clearBtn) { clearBtn.click(); await sleep(200); }
    push('清除筛选后恢复全部', $$('#lib-grid .lib-card').length === 3, 'cards=' + $$('#lib-grid .lib-card').length);
  }

  // 卡片上的标签也能点（且不会顺手打开 PDF）
  const cardTag = $('#lib-grid .lib-card .lctag[data-tag-filter]');
  const before = App.state.fileName;
  if (cardTag) {
    cardTag.click();
    await sleep(250);
    push('点卡片标签即按标签筛选', $$('#lib-tags .lib-tag-row.active').length >= 1, 'active=' + $$('#lib-tags .lib-tag-row.active').length);
    push('点卡片标签不会打开 PDF', App.state.fileName === before, 'file=' + App.state.fileName);
    const clr = $('#lib-tags [data-tag-clear]');
    if (clr) { clr.click(); await sleep(150); }
  } else {
    push('点卡片标签即按标签筛选', false, '卡片上没有标签');
    push('点卡片标签不会打开 PDF', false, '卡片上没有标签');
  }

  // ---------- 2. 引用预览与复制 ----------
  const detailBtn = $('#lib-grid .lib-card [data-detail="itA"]') || $('#lib-grid .lib-card [data-detail]');
  if (detailBtn) detailBtn.click();
  await waitFor(() => !$('#lib-detail').hidden, 4000);
  const prev = $('#ld-cite-preview');
  push('详情面板有引用预览', !!prev && !$('#lib-detail').hidden, 'prev=' + (prev ? prev.textContent.slice(0, 60) : 'null'));
  const gbtText = prev ? prev.textContent : '';
  push('引用预览是 GB/T 7714 格式', gbtText.indexOf('[J]') > 0, gbtText);
  push('引用预览含标题与刊名', gbtText.indexOf('Alpha') >= 0 && gbtText.indexOf('测试期刊') >= 0, gbtText);

  const styleSel = $('#ld-cite-style');
  push('有引用样式选择', !!styleSel && styleSel.options.length === 2, styleSel ? String(styleSel.options.length) : 'null');
  if (styleSel) {
    styleSel.value = 'apa';
    styleSel.dispatchEvent(new Event('change'));
    await sleep(200);
    const apaText = $('#ld-cite-preview').textContent;
    push('切到 APA 后预览变化', apaText.indexOf('(2020)') > 0 && apaText.indexOf('[J]') < 0, apaText);
    const copyBtn = $('#ld-cite-copy');
    push('有复制引用按钮', !!copyBtn);
    if (copyBtn) {
      copyBtn.click();
      await sleep(300);
      push('复制后有状态提示', ($('#ld-cite-status').textContent || '').indexOf('已复制') >= 0, $('#ld-cite-status').textContent);
    }
    // 主进程剪贴板通道：把内容原样带回来，便于断言
    const probeCopy = await pdfBridge.copyText('probe-clipboard-ok');
    push('剪贴板通道可用', !!(probeCopy && probeCopy.ok), JSON.stringify(probeCopy));
    styleSel.value = 'gbt7714';
    styleSel.dispatchEvent(new Event('change'));
    await sleep(150);
  }

  // ---------- 3. 批注导出：Markdown / CSV / TXT ----------
  // 批注面板要先有文档、侧栏可见、切到「批注」页才会渲染导出按钮
  const openCard = $('#lib-grid .lib-card[data-open]');
  if (openCard) openCard.click();
  const opened = await waitFor(() => App.state.pdfDoc && App.state.numPages === 3, 15000);
  push('能打开条目进入阅读（探针前提）', opened, 'pdfDoc=' + !!App.state.pdfDoc + ' tabs=' + App.tabs.length);
  const sb = $('#sidebar');
  if (sb && sb.hidden) $('#btn-sidebar').click();
  const annoTab = $('.sb-tab[data-tab="annos"]');
  if (annoTab) annoTab.click();
  await sleep(400);

  const btns = $$('[data-note-fmt]');
  push('批注面板有 MD/CSV/TXT 三个导出按钮', btns.length === 3, 'buttons=' + btns.length);
  push('导出按钮带格式标记', btns.map((b) => b.dataset.noteFmt).sort().join(',') === 'csv,md,txt', btns.map((b) => b.dataset.noteFmt).join(','));

  App.state.annos.set(1, [
    { tool: 'mark', color: '#ffd54f', rects: [{ x: 1, y: 2, w: 30, h: 9 }], text: '引用文字', comment: '我的评论' },
    { tool: 'pen', color: '#e53935', width: 2, pts: [{ x: 1, y: 1 }, { x: 5, y: 5 }] },
  ]);
  const md = App.buildNoteText('md');
  push('Markdown 有页标题', md.indexOf('## 第 1 页') > 0, md.slice(0, 120));
  push('Markdown 引用是 blockquote', md.indexOf('> 引用文字') > 0, md.slice(0, 200));
  push('Markdown 带评论', md.indexOf('**评论**：我的评论') > 0, md.slice(0, 240));
  push('Markdown 带文档名', md.indexOf('# ') === 0, md.slice(0, 60));

  const csv = App.buildNoteText('csv');
  push('CSV 有 BOM', csv.charCodeAt(0) === 0xFEFF, String(csv.charCodeAt(0)));
  push('CSV 有表头', csv.indexOf('"页码","类型","颜色","内容/引用","评论"') > 0, csv.slice(0, 120));
  push('CSV 有数据行', csv.indexOf('"1","选区高亮"') > 0, csv.slice(0, 240));
  push('CSV 正确转义引号', csv.indexOf('""') > 0, csv.slice(0, 240));

  const txt = App.buildNoteText('txt');
  push('纯文本格式保持原样（回归）', txt.indexOf('── 第 1 页 ──') > 0 && txt.indexOf('[选区高亮] 引用文字') > 0, txt.slice(0, 160));

  return { checks };
})()`;
