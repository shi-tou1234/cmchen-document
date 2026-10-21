module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 12000)) { if (fn()) return true; await sleep(80); } return !!fn(); };
  const openCard = async (key, filePart) => {
    const c = $('[data-open="' + key + '"]');
    if (!c) return false;
    c.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    c.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    return await waitFor(() => App.state.mode === 'rich' && App.state.fileName.indexOf(filePart) >= 0, 20000);
  };
  const backToLibrary = async () => {
    $('#btn-library').click();
    return await waitFor(() => !$('#library').hidden && $$('[data-open]').length >= 3, 8000);
  };

  await waitFor(() => $$('#lib-grid .lib-card').length === 3, 8000);
  push('文献库加载三份文档', $$('#lib-grid .lib-card').length === 3, 'cards=' + $$('#lib-grid .lib-card').length);

  // ---------- DOCX ----------
  const opened = await openCard('itDocx', '.docx');
  await waitFor(() => $$('#doc-view .doc-page').length === 1, 8000);
  push('docx 在 Electron 里打开为富文档', opened && App.state.mode === 'rich', 'mode=' + App.state.mode + ' err=' + (App.lastLoadError || ''));
  push('docx 进入阅读态且切到富文档类', document.body.classList.contains('has-doc') && document.body.classList.contains('rich-doc'));
  push('docx 隐藏 PDF 页面层、显示富文档层', $('#pages').hidden === true && $('#doc-view').hidden === false);
  push('docx 页数正确', App.state.numPages === 1 && $$('#doc-view .doc-page').length === 1,
    'num=' + App.state.numPages + ' cards=' + $$('#doc-view .doc-page').length);

  const body = $('#doc-view .doc-page-body');
  const bodyText = body ? body.textContent : '';
  push('docx 正文渲染出来', bodyText.indexOf('第一段加粗文字') >= 0 && bodyText.indexOf('第二段普通文字') >= 0, bodyText.slice(0, 80));
  push('docx 加粗保留为 strong', !!body && !!body.querySelector('strong'));
  push('docx 页眉标题来自转换结果', ($('#doc-view .doc-page-title') || {}).textContent === '正文',
    ($('#doc-view .doc-page-title') || {}).textContent);
  push('docx 携带条目引用信息', App.state.itemKey === 'itDocx' && App.state.citation.indexOf('测试 Word 文档') >= 0,
    'key=' + App.state.itemKey + ' cite=' + String(App.state.citation).slice(0, 60));

  const bodyFont = getComputedStyle(document.body).fontFamily || '';
  const docFont = body ? getComputedStyle(body).fontFamily || '' : '';
  push('全软件字体统一为无衬线栈', /Segoe UI/i.test(bodyFont) && /Segoe UI/i.test(docFont) && !/Georgia|Times New Roman/i.test(docFont),
    bodyFont + ' || ' + docFont);

  // 选区摘录：富文档没有标注层，摘录应写进该条目的阅读笔记
  const p2 = body ? body.querySelectorAll('p')[1] : null;
  const tn = p2 && p2.firstChild;
  if (tn && tn.nodeType === 3) {
    const range = document.createRange();
    range.setStart(tn, 0);
    range.setEnd(tn, tn.textContent.length);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    $('#viewer').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await sleep(150);
  }
  push('docx 选中文字弹出操作条', !$('#sel-bar').hidden, 'hidden=' + $('#sel-bar').hidden);
  const quoteBtn = $('[data-sel="quote"]');
  if (quoteBtn) quoteBtn.click();
  await sleep(400);
  let docxNotes = [];
  try {
    const sum = await window.pdfBridge.lib.summary();
    const it = (sum.items || []).find((x) => x.key === 'itDocx');
    docxNotes = (it && it.notes) || [];
  } catch (_) {}
  const quoteNote = docxNotes.find((n) => String(n.title || '').indexOf('摘录') === 0) || null;
  push('富文档摘录写入阅读笔记', !!quoteNote && quoteNote.text.indexOf('第二段普通文字') >= 0
    && quoteNote.text.indexOf('第 1 页') >= 0,
    quoteNote ? String(quoteNote.title) + ' | ' + String(quoteNote.text).slice(0, 60) : 'notes=' + docxNotes.length);
  push('摘录后操作条收起', $('#sel-bar').hidden === true);

  // 缩放：富文档用 #doc-view 的 CSS zoom
  const scale = $('#scale-select');
  scale.value = '1.5';
  scale.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(120);
  push('docx 缩放到 150%', Math.abs(parseFloat($('#doc-view').style.zoom) - 1.5) < 0.01, $('#doc-view').style.zoom);
  scale.value = 'page-width';
  scale.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(120);
  push('docx 能回到适应宽度', $('#doc-view').style.zoom !== '1.5' && /^\\d+%$/.test($('#zoom-text').textContent),
    'zoom=' + $('#doc-view').style.zoom + ' label=' + $('#zoom-text').textContent);

  // 页内搜索
  await App.doSearch('第二段普通文字');
  await sleep(80);
  push('docx 页内搜索有命中', App.state.search.results.length >= 1 && $$('#doc-view mark.doc-hit').length >= 1,
    'results=' + App.state.search.results.length + ' marks=' + $$('#doc-view mark.doc-hit').length);
  push('docx 命中标记带页码', (($('#doc-view mark.doc-hit') || {}).dataset || {}).page === '1',
    (($('#doc-view mark.doc-hit') || {}).dataset || {}).page);
  await App.doSearch('');
  await sleep(80);
  push('清空搜索后命中标记移除', $$('#doc-view mark.doc-hit').length === 0);

  // ---------- XLSX ----------
  await backToLibrary();
  const openedX = await openCard('itXlsx', '.xlsx');
  await waitFor(() => App.state.mode === 'rich' && $$('#doc-view .doc-page').length === 2, 12000);
  push('xlsx 每个工作表一页', openedX && App.state.numPages === 2 && $$('#doc-view .doc-page').length === 2,
    'num=' + App.state.numPages + ' err=' + (App.lastLoadError || ''));
  push('xlsx 页标题是工作表名', ($('#page-1 .doc-page-title') || {}).textContent === '成绩汇总',
    ($('#page-1 .doc-page-title') || {}).textContent);
  push('xlsx 渲染为表格', !!$('#page-1 table.doc-sheet') && !!$('#page-1 table.doc-sheet th'));
  push('xlsx 单元格内容正确', ($('#page-1') || {}).textContent.indexOf('张三') >= 0 && ($('#page-1') || {}).textContent.indexOf('李四') >= 0);

  const pageInput = $('#page-input');
  pageInput.value = '2';
  pageInput.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(200);
  push('xlsx 页码输入能跳到第 2 页', App.state.currentPage === 2, 'page=' + App.state.currentPage);

  await App.doSearch('李四');
  await sleep(80);
  push('xlsx 页内搜索命中第 1 页', App.state.search.results.length >= 1 && App.state.search.results[0].page === 1,
    JSON.stringify(App.state.search.results.slice(0, 2)));
  await App.doSearch('');
  await sleep(80);

  // ---------- EPUB ----------
  await backToLibrary();
  const openedE = await openCard('itEpub', '.epub');
  await waitFor(() => App.state.mode === 'rich' && $$('#doc-view .doc-page').length === 2, 12000);
  push('epub 每章一页', openedE && App.state.numPages === 2 && $$('#doc-view .doc-page').length === 2,
    'num=' + App.state.numPages + ' err=' + (App.lastLoadError || ''));
  push('epub 章节标题取 h1', ($('#page-1 .doc-page-title') || {}).textContent === '第一章 开始',
    ($('#page-1 .doc-page-title') || {}).textContent);
  const img = $('#page-1 img');
  push('epub 章节图片内联为 data URL', !!img && /^data:image\\/png;base64,/.test(img.getAttribute('src') || ''),
    img ? String(img.getAttribute('src')).slice(0, 40) : 'no img');
  push('epub 第二章正文存在', ($('#page-2') || {}).textContent.indexOf('第二章正文') >= 0);

  await App.doSearch('第二章正文');
  await sleep(80);
  push('epub 搜索定位到第 2 页', App.state.search.results.length >= 1 && App.state.search.results[0].page === 2,
    JSON.stringify(App.state.search.results.slice(0, 2)));
  await App.doSearch('');
  await sleep(80);
  push('epub 搜索清空后标记归零', $$('#doc-view mark.doc-hit').length === 0);

  // ---------- 标签页 ----------
  push('三份文档各占一个标签', App.tabs.length === 3 && App.tabs.filter((t) => t.kind === 'rich').length === 3,
    'tabs=' + App.tabs.length);
  const tab1 = $$('#tabs .tab')[0];
  if (tab1) {
    tab1.click();
    await waitFor(() => App.state.fileName.indexOf('.docx') > 0, 8000);
  }
  push('切回第一个富文档标签', App.state.fileName.indexOf('.docx') > 0 && App.state.numPages === 1,
    App.state.fileName + ' pages=' + App.state.numPages);

  return { checks };
})()`;
