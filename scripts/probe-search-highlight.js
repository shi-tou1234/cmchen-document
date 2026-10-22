'use strict';
/*
 * 检索闭环探针：库全文结果 → 点进去 → 页面高亮关键词 + 跳到首个命中。
 * 被 test-search-highlight.js 调用。
 */
module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 10000)) { if (fn()) return true; await sleep(80); } return !!fn(); };

  try {
    const libReady = await waitFor(() => window.LibraryUI && LibraryUI.isOpen(), 10000);
    push('启动后文献库自动展开', libReady);
    if (!libReady) return { checks, stage: 'startup' };

    // 1. 入库 + 打开一次拿到正文词（后面用它做全文检索）
    const add = await pdfBridge.lib.addPdf('__SAMPLE__', { dedupe: true });
    push('样例 PDF 入库', !!(add && add.ok), JSON.stringify((add || {}).error));
    const key = add.item.key;
    const res = await pdfBridge.lib.openItem(key, 1);
    LibraryUI.hide();
    window.__libOpen(res);
    const loaded = await waitFor(() => App.state.pdfDoc && App.state.rendered.get(1), 25000);
    push('文档加载到第 1 页', loaded);
    if (!loaded) return { checks, stage: 'load' };

    let term = '';
    try {
      const tc = await App.pageEl(1)._pdfPage.getTextContent();
      for (const it of tc.items) {
        const w = String(it.str || '').trim();
        if (w.length >= 4 && /[A-Za-z\\u4e00-\\u9fff]/.test(w)) { term = w.split(/\\s+/)[0]; break; }
      }
    } catch (_) {}
    push('取到一个正文词', !!term, term);
    if (!term) return { checks, stage: 'term' };

    // 2. 建全文索引
    const idx = await pdfBridge.lib.indexAll(true);
    push('全文索引已建', !!(idx && idx.ok !== false), JSON.stringify({ done: idx && idx.done, failed: idx && idx.failed }));
    const sr = await pdfBridge.lib.searchFull(term);
    push('全文检索命中', !!(sr && sr.ok && sr.results.length), JSON.stringify((sr && sr.results || []).length));

    // 3. 回库，让全文面板出现
    LibraryUI.show();
    await sleep(300);
    const box = $('#lib-search');
    box.value = term;
    box.dispatchEvent(new Event('input', { bubbles: true }));
    const rows = await waitFor(() => $$('#lib-ft .lib-ft-row').length, 8000);
    push('全文面板列出命中', !!rows, 'rows=' + $$('#lib-ft .lib-ft-row').length);
    if (!rows) return { checks, stage: 'ft-panel' };

    // 4. 点第一条结果 → 打开 + 自动高亮 + 跳首个命中
    const row = $('#lib-ft .lib-ft-row');
    const pageTarget = +row.dataset.ftPage || 1;
    row.click();
    const opened = await waitFor(() => !document.getElementById('library').hidden === false
      && App.state.pdfDoc && App.state.filePath, 20000);
    push('点结果后回到阅读态', !!opened);
    const hl = await waitFor(() => $$('#pages .page .hl-layer .hl').length, 15000);
    push('页面上出现搜索高亮', !!hl, 'hl=' + $$('#pages .page .hl-layer .hl').length);
    const q = (App.state.search && App.state.search.query) || '';
    push('高亮词就是查询词', q === term.toLowerCase(), JSON.stringify({ q: q, term: term }));
    push('搜索框回填了词', ($('#search-box').value || '').toLowerCase() === term.toLowerCase(), $('#search-box').value);
    const cur = $$('#pages .page .hl-layer .hl.is-current').length;
    push('第一处命中被标为当前', cur === 1, 'is-current=' + cur);
    push('当前页就是命中页', App.state.currentPage === pageTarget, App.state.currentPage + '/' + pageTarget);
    const status = ($('#status-text').textContent || '');
    push('状态栏显示命中数', /处命中/.test(status), status);

    return { checks };
  } catch (e) {
    return { checks, fatal: String((e && e.stack) || e) };
  }
})()`;
