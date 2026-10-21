module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 8000)) { if (fn()) return true; await sleep(60); } return !!fn(); };

  const loaded = await waitFor(() => window.App && App.state.pdfDoc && App.state.numPages >= 1, 15000);
  push('夹具 PDF 已加载（探针前提）', loaded);
  if (!loaded) return { checks, stage: 'load' };
  await sleep(400);

  // ---------- 1. 首次上手提示 ----------
  // 提示条在「第一次用」时可见；一旦打开了文档就自动收起（说明用户已经上手了）
  const hint = $('#hint-bar');
  push('有首次上手提示条', !!hint);
  if (hint) {
    const openedDoc = !!(window.App && App.state.pdfDoc);
    push('打开文档后提示自动收起', openedDoc ? hint.hidden : !hint.hidden,
      'hidden=' + hint.hidden + ' openedDoc=' + openedDoc);
    const hx = $('#hint-x');
    if (hx) hx.click();
    await sleep(200);
    push('点「知道了」后收起来', hint.hidden);
  }

  // ---------- 2. 引用样式扩充 ----------
  const styleSel = $('#ld-cite-style');
  push('引用样式有 5 种', !!styleSel && styleSel.options.length === 5, styleSel ? String(styleSel.options.length) : 'null');
  const expect = {
    gbt7714: '[J]', apa: '(2017)', chicago: '2017.', ieee: '[1]', mla: '"',
  };
  // 打开条目的详情面板（引用预览在这里）
  const opened = await (async () => {
    $('#btn-library').click();
    await waitFor(() => $$('#lib-grid .lib-card').length >= 1, 6000);
    const dbtn = $('#lib-grid .lib-card [data-detail]');
    if (!dbtn) return false;
    dbtn.click();
    await waitFor(() => !$('#lib-detail').hidden && ($('#ld-title') || {}).value, 4000);
    return !$('#lib-detail').hidden;
  })();
  push('打开条目详情（探针前提）', opened);
  await waitFor(() => $('#ld-cite-preview') && $('#ld-cite-preview').textContent && $('#ld-cite-preview').textContent !== '（先填标题）', 6000);
  for (const [id, mark] of Object.entries(expect)) {
    if (!styleSel) break;
    styleSel.value = id;
    styleSel.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(150);
    const txt = ($('#ld-cite-preview') || {}).textContent || '';
    push('引用样式 ' + id + ' 预览正确', txt.indexOf(mark) >= 0, txt.slice(0, 110));
  }

  // ---------- 3. 批注搜索 + 批注标签 ----------
  App.state.annos.set(1, [
    { tool: 'mark', color: '#ffd54f', rects: [{ x: 1, y: 2, w: 30, h: 9 }], text: '选中的原文', comment: '第一条评论' },
    { tool: 'pen', color: '#e53935', width: 2, pts: [{ x: 1, y: 1 }, { x: 9, y: 9 }] },
  ]);
  App.notifyAnnoChanged();
  await sleep(300);
  // 打开批注面板
  const sb = $('#sidebar');
  if (sb && sb.hidden) $('#btn-sidebar').click();
  const annoTab = $('.sb-tab[data-tab="annos"]');
  if (annoTab) annoTab.click();
  await sleep(400);
  const rowsAll = $$('#anno-list .anno-item');
  push('批注面板列出全部批注', rowsAll.length === 2, 'n=' + rowsAll.length);
  push('批注面板有搜索框', !!$('#anno-search'));

  const search = $('#anno-search');
  if (search) {
    search.value = '第一条评论';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(200);
    push('按评论内容能搜到批注', $$('#anno-list .anno-item').length === 1, 'n=' + $$('#anno-list .anno-item').length);
    search.value = '选中的原文';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(200);
    push('按批注文字能搜到批注', $$('#anno-list .anno-item').length === 1, 'n=' + $$('#anno-list .anno-item').length);
    search.value = '';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(200);
  }

  // 给第一条批注加标签
  const tagBtn = $$('#anno-list .anno-item .tagbtn')[0];
  push('每条批注有加标签按钮', !!tagBtn);
  if (tagBtn) {
    tagBtn.click();
    await sleep(200);
    const inp = $('.anno-tag-input');
    push('点标签按钮弹出输入框', !!inp);
    if (inp) {
      inp.value = '重点';
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await sleep(400);
      const chips = $$('#anno-list .anno-tag');
      push('标签写进批注并显示成小片', chips.length === 1 && chips[0].textContent === '重点',
        chips.map((c) => c.textContent).join(','));
      const sh = (App.state.annos.get(1) || [])[0];
      push('标签进了数据模型', !!(sh && (sh.tags || []).indexOf('重点') >= 0), JSON.stringify(sh && sh.tags));
      await App.flushAnnos();
      const p = App.state.filePath;
      const saved = await pdfBridge.loadAnnos(p);
      push('标签已落盘', JSON.stringify(saved).indexOf('重点') >= 0, JSON.stringify(saved).slice(0, 160));
    }
  }

  // ---------- 4. 库里进阶分区默认折叠 ----------
  const secToggles = $$('.lib-sec-toggle');
  push('库里有两个可折叠分区', secToggles.length === 2, 'n=' + secToggles.length);
  const tagsSec = $('#lib-tags');
  if (tagsSec) push('标签分区默认折叠', tagsSec.hidden);
  const tagToggle = secToggles.find((b) => b.dataset.sec === 'tags');
  if (tagToggle) {
    tagToggle.click();
    await sleep(200);
    push('点标题能展开标签分区', tagsSec && !tagsSec.hidden);
  }

  return { checks };
})()`;
