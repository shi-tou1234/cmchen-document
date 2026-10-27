module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 8000)) { if (fn()) return true; await sleep(60); } return !!fn(); };
  try {
  const loaded = await waitFor(() => window.App && App.state.pdfDoc && App.state.numPages >= 1 && App.state.rendered.get(1), 15000);
  push('夹具 PDF 已加载（探针前提）', loaded, 'pages=' + (window.App ? App.state.numPages : 0));
  if (!loaded) return { checks, stage: 'load' };
  await sleep(400);
  // 抓渲染报错（看渲染失败的具体原因）
  const errs = [];
  const origErr = console.error;
  console.error = function () { errs.push(Array.from(arguments).map(String).join(' ')); return origErr.apply(console, arguments); };

  // ---------- 1. 单页翻页模式 ----------
  const mode = App.setViewMode('page');
  await sleep(400);
  push('能切到单页模式', mode === 'page' && document.body.classList.contains('view-page'), document.body.className);
  const p1 = App.pageEl(1), p2 = App.pageEl(2);
  push('单页模式下只有当前页可见', p1 && p2 &&
    getComputedStyle(p1).display !== 'none' && getComputedStyle(p2).display === 'none',
    'p1=' + (p1 ? getComputedStyle(p1).display : '-') + ' p2=' + (p2 ? getComputedStyle(p2).display : '-'));
  // 翻到第 2 页
  App.state.currentPage = 1;
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
  await sleep(500);
  push('方向键翻到第 2 页', App.state.currentPage === 2, 'page=' + App.state.currentPage);
  push('换页后第 2 页可见、第 1 页隐藏', p2 && getComputedStyle(p2).display !== 'none' && getComputedStyle(p1).display === 'none',
    'p1=' + getComputedStyle(p1).display + ' p2=' + getComputedStyle(p2).display);
  // 切回连续滚动
  App.setViewMode('scroll');
  await sleep(400);
  push('能切回连续滚动', !document.body.classList.contains('view-page'));
  push('连续滚动下所有页都显示', getComputedStyle(p1).display !== 'none' && getComputedStyle(p2).display !== 'none');
  await sleep(800);
  push('切回滚动后页面重新渲染', App.state.rendered.get(1) === true,
    'r1=' + App.state.rendered.get(1) + ' r2=' + App.state.rendered.get(2) + ' errs=' + JSON.stringify(errs.slice(0, 2)));

  // ---------- 2. 搜索命中上下跳 ----------
  await App.doSearch('Sample');
  await sleep(500);
  const hits = App.state.search.hits || [];
  push('搜索记录了命中位置', hits.length >= 1, 'hits=' + hits.length);
  push('页面上画出了高亮', $$('.hl-layer .hl').length >= 1, 'hl=' + $$('.hl-layer .hl').length);
  const h0 = hits[0];
  if (h0) {
    const rects = (App.state.search.rects.get(h0.page) || []);
    push('命中矩形能在 rects 里定位', rects.indexOf(h0.rect) >= 0,
      'page=' + h0.page + ' idx=' + rects.indexOf(h0.rect) + ' rects=' + rects.length);
  }
  // 「当前命中」的高亮画在 .hl-layer 里，而 .hl-layer 的元素要等该页渲染完才存在。
  // 所以断言前先等目标页渲染出来（隐藏窗口里渲染是异步的）。
  const waitCurrentMark = async (ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 10000)) {
      const h = hits[App.state.search.hitIndex];
      if (h && App.state.rendered.get(h.page) && $$('.hl-layer .hl.is-current').length === 1) return true;
      await sleep(120);
    }
    return false;
  };
  // v9 起：搜索有命中就自动跳到第一处（从文献库点全文结果进来时落点就是命中位置）
  push('搜索后自动落在第一处命中', App.state.search.hitIndex === 0, 'index=' + App.state.search.hitIndex);
  push('当前命中有高亮标记', await waitCurrentMark(), 'n=' + $$('.hl-layer .hl.is-current').length +
    ' hitIdx=' + App.state.search.hitIndex + ' hits=' + hits.length);
  const n = hits.length;
  const F3 = (shift) => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F3', bubbles: true, shiftKey: !!shift, cancelable: true }));
  F3(false);
  await sleep(400);
  push('F3 到下一处命中', App.state.search.hitIndex === 1 % n, 'index=' + App.state.search.hitIndex + ' hits=' + n);
  push('下一处命中有高亮标记', await waitCurrentMark(), 'n=' + $$('.hl-layer .hl.is-current').length + ' hitIdx=' + App.state.search.hitIndex);
  F3(false);
  await sleep(400);
  push('再按 F3 到下一处', App.state.search.hitIndex === 2 % n, 'index=' + App.state.search.hitIndex);
  F3(true);
  await sleep(400);
  push('Shift+F3 回到上一处', App.state.search.hitIndex === (2 % n - 1 + n) % n, 'index=' + App.state.search.hitIndex);
  await App.doSearch('');
  await sleep(200);

  // ---------- 3. 大纲带页码 ----------
  const sb = $('#sidebar');
  if (sb && sb.hidden) $('#btn-sidebar').click();
  const outlineTab = $('.sb-tab[data-tab="outline"]');
  if (outlineTab) outlineTab.click();
  await sleep(600);
  const nodes = $$('#sb-outline .outline-node');
  if (nodes.length) {
    push('大纲条目带页码', !!$('#sb-outline .outline-node .opg'), 'n=' + nodes.length);
    const pgText = ($('#sb-outline .outline-node .opg') || {}).textContent || '';
    push('页码是 P+数字', /P\d+/.test(pgText), pgText);
  } else {
    push('大纲条目带页码（样本无目录，跳过断言）', true, '样本没有大纲');
  }

  // ---------- 4. 设置里有阅读方式 ----------
  // v22 时是 2 项；本轮新增「双页对开」后为 3 项（scroll / page / spread）
  const vm = $('#set-view-mode');
  push('设置里有阅读方式', !!vm && vm.options.length === 3, vm ? String(vm.options.length) : 'null');

  return { checks };
  } catch (e) {
    checks.push(['探针未抛错', false, String((e && e.stack) || e)]);
    return { checks };
  }
})()`;
