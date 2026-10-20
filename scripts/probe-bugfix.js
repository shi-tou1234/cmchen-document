module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.getElementById(s);
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 10000)) { if (fn()) return true; await sleep(80); } return !!fn(); };
  const viewer = $('viewer');
  const pageAtTop = () => {
    const vr = viewer.getBoundingClientRect();
    for (const el of document.querySelectorAll('#pages .page')) {
      const r = el.getBoundingClientRect();
      if (r.bottom > vr.top + 20) return +el.dataset.page;
    }
    return 0;
  };
  const hlCount = () => document.querySelectorAll('.hl').length;

  // ---------- 0. 前提：文档已加载 ----------
  const loaded = await waitFor(() => App.state.pdfDoc && App.state.numPages === 3 && App.state.rendered.get(1), 15000);
  push('文档已加载（探针前提）', loaded, 'pages=' + App.state.numPages);
  if (!loaded) return { checks, stage: 'load' };
  const realPath = App.state.filePath;   // 后面会切文档，先留住这份真实路径
  await sleep(500);

  // ---------- 1. 页码指示器：只改 scrollTop，页码必须是视口顶部那一页 ----------
  viewer.scrollTop = 0;
  await sleep(600);
  push('起始页码 = 1', App.state.currentPage === 1, 'current=' + App.state.currentPage);
  viewer.scrollTop = 900;
  await sleep(800);
  const topPage = pageAtTop();
  push('纯滚动时页码 = 视口顶部页', App.state.currentPage === topPage,
    'current=' + App.state.currentPage + ' actualTop=' + topPage + ' scrollTop=' + viewer.scrollTop);

  // ---------- 2. 搜索：清空必须擦掉高亮和结果 ----------
  App.doSearch('Sample');
  App.doSearch('');
  await sleep(1500);
  push('并发清空后无残留高亮', hlCount() === 0, 'hl=' + hlCount() + ' results=' + App.state.search.results.length);
  push('并发清空后无残留结果', App.state.search.results.length === 0 && App.state.search.query === '',
    'query=' + JSON.stringify(App.state.search.query) + ' results=' + App.state.search.results.length);

  await App.doSearch('Sample');
  const hlHas = hlCount();
  await App.doSearch('');
  await sleep(300);
  push('搜完再清空，高亮消失', hlHas > 0 && hlCount() === 0, 'afterSearch=' + hlHas + ' afterClear=' + hlCount());
  push('搜完再清空，结果清零', App.state.search.results.length === 0, 'results=' + App.state.search.results.length);

  // ---------- 3. 缩放下拉框不能空 ----------
  $('btn-zoom-in').click();
  await sleep(400);
  const sel = $('scale-select');
  push('缩放后下拉框有值', !!sel.value, 'scaleMode=' + App.state.scaleMode + ' value=' + JSON.stringify(sel.value));

  // ---------- 4. 按钮聚焦时空格不能翻页 ----------
  const nextBtn = $('btn-next');
  nextBtn.focus();
  const pageBefore = App.state.currentPage;
  const ev = new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true });
  nextBtn.dispatchEvent(ev);
  await sleep(400);
  push('按钮聚焦时空格不翻页也不阻止默认', App.state.currentPage === pageBefore && !ev.defaultPrevented,
    'before=' + pageBefore + ' after=' + App.state.currentPage + ' prevented=' + ev.defaultPrevented);

  // ---------- 5. 跨文档撤销：切文档后 undo 不得把上一份文档的标注带过来 ----------
  viewer.scrollTop = 0;
  await sleep(300);
  App.state.currentPage = 1;
  Anno.addShape(1, { tool: 'pen', color: '#e53935', width: 2, pts: [{ x: 10, y: 10 }, { x: 60, y: 60 }] }, { undo: false });
  Anno.clearPage();
  await sleep(700);
  const bytes = App.state.sourceBytes.slice();
  const fakePath = (App.state.filePath || 'C:\\\\tmp\\\\sample.pdf') + '.second.pdf';
  App.openDocument({ ok: true, data: bytes, fileName: 'second.pdf', filePath: fakePath, startPage: 1 }, { newTab: true });
  const switched = await waitFor(() => App.state.fileName === 'second.pdf' && App.state.numPages === 3 && App.state.rendered.get(1), 15000);
  push('已切换到第二个文档（探针前提）', switched, 'name=' + App.state.fileName);
  if (!switched) return { checks, stage: 'switch' };
  await sleep(900);
  Anno.undo();
  await sleep(1000);
  const leaked = (App.state.annos.get(1) || []).filter((s) => s.tool === 'pen' && s.color === '#e53935');
  push('切文档后撤销不会注入上一份文档的标注', leaked.length === 0, 'leaked=' + leaked.length);
  const persisted = await window.pdfBridge.loadAnnos(fakePath);
  push('上一份文档的标注不会写进新文档的标注文件', JSON.stringify(persisted).indexOf('e53935') < 0, JSON.stringify(persisted).slice(0, 200));

  // ---------- 6. 文献库覆盖层：要有退路，弹窗不能残留 ----------
  $('btn-library').click();
  await waitFor(() => !$('library').hidden, 4000);
  push('库覆盖层已打开', !$('library').hidden);
  const back = $('lib-back');
  push('库里有「返回阅读」按钮', !!back && back.offsetParent !== null, 'back=' + !!back);

  LibraryUI.openSettings();
  await sleep(300);
  const settingsOpen = !$('settings-modal').hidden;
  push('设置弹窗已打开', settingsOpen);
  LibraryUI.hide();
  await sleep(200);
  push('库收起时设置弹窗一起关闭', !$('settings-modal').hidden === false, 'stillVisible=' + !$('settings-modal').hidden);

  // Esc 逐层关闭：弹窗 → 详情 → 整个库
  $('btn-library').click();
  await waitFor(() => !$('library').hidden, 4000);
  LibraryUI.openSettings();
  await sleep(200);
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await sleep(200);
  push('Esc 能关掉设置弹窗', $('settings-modal').hidden, 'stillVisible=' + !$('settings-modal').hidden);
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await sleep(200);
  push('Esc 能收起整个库', $('library').hidden, 'stillOpen=' + !$('library').hidden);

  // ---------- 7. 拖进库时阅读器不要重复打开 ----------
  $('btn-library').click();
  await waitFor(() => !$('library').hidden, 4000);
  const file = new File([App.state.sourceBytes.slice()], 'drop-probe.pdf', { type: 'application/pdf' });
  const dt = new DataTransfer();
  dt.items.add(file);
  const beforeName = App.state.fileName;
  document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  await sleep(1200);
  push('拖进库时阅读器不会同时打开它', App.state.fileName === beforeName,
    'before=' + beforeName + ' after=' + App.state.fileName);
  push('拖进库后库仍然开着', !$('library').hidden);

  // ---------- 8. 同一路径重复导入不产生重复条目 ----------
  if (realPath) {
    const a1 = await window.pdfBridge.lib.addPdf(realPath, { dedupe: true });
    const a2 = await window.pdfBridge.lib.addPdf(realPath, { dedupe: true });
    const sum = await window.pdfBridge.lib.summary();
    push('重复导入同一路径只留一条', !!(a1 && a1.ok) && !!(a2 && a2.ok) && a2.deduped === true && sum.items.length === 1,
      'a1ok=' + !!(a1 && a1.ok) + ' a2dedup=' + JSON.stringify(a2 && a2.deduped) + ' items=' + sum.items.length);
  }

  return { checks };
})()`;
