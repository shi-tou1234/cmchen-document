module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 8000)) { if (fn()) return true; await sleep(60); } return !!fn(); };

  const loaded = await waitFor(() => window.App && App.state.pdfDoc && App.state.numPages >= 1 && App.state.rendered.get(1), 15000);
  push('夹具 PDF 已加载（探针前提）', loaded);
  if (!loaded) return { checks, stage: 'load' };
  await sleep(400);

  // ---------- 1. 缩放保持当前位置 ----------
  const viewer = App.els.viewer;
  viewer.scrollTop = 400;
  await sleep(400);
  const page1 = App.pageEl(1);
  const vr = viewer.getBoundingClientRect();
  const before = page1.getBoundingClientRect().top - vr.top;
  const beforePage = App.state.currentPage;
  document.getElementById('btn-zoom-in').click();
  await sleep(500);
  const vr2 = viewer.getBoundingClientRect();
  const after = App.pageEl(beforePage).getBoundingClientRect().top - vr2.top;
  push('缩放后当前页还在视口同一位置', Math.abs(after - before) < 40,
    'before=' + before.toFixed(1) + ' after=' + after.toFixed(1) + ' page=' + beforePage);
  push('缩放后当前页没变', App.state.currentPage === beforePage, 'page=' + App.state.currentPage);

  // ---------- 2. 标签重命名 / 全局移除 ----------
  const sum0 = await pdfBridge.lib.summary();
  const withTag = (sum0.items || []).filter((x) => (x.tags || []).indexOf('ML') >= 0);
  push('有带 ML 标签的条目', withTag.length >= 1, 'n=' + withTag.length);

  // 打开库、展开标签分区
  $('#btn-library').click();
  await waitFor(() => $$('#lib-grid .lib-card').length >= 1, 6000);
  const tagToggle = $$('.lib-sec-toggle').find((b) => b.dataset.sec === 'tags');
  if (tagToggle && $('#lib-tags').hidden) { tagToggle.click(); await sleep(200); }
  const renBtn = $$('#lib-tags [data-tag-rename]').find((s) => s.dataset.tagRename === 'ML');
  push('标签行有重命名按钮', !!renBtn);
  if (renBtn) {
    renBtn.click();
    await sleep(200);
    const inp = $('#lib-tags input');
    push('点重命名弹出输入框', !!inp);
    if (inp) {
      inp.value = '机器学习';
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await sleep(600);
      const sum1 = await pdfBridge.lib.summary();
      const renamed = (sum1.items || []).filter((x) => (x.tags || []).indexOf('机器学习') >= 0);
      const leftOld = (sum1.items || []).filter((x) => (x.tags || []).indexOf('ML') >= 0);
      push('重命名改到了所有条目', renamed.length === withTag.length, 'n=' + renamed.length);
      push('旧标签名不再出现', leftOld.length === 0, 'n=' + leftOld.length);
    }
  }

  // 全局移除
  const delBtn = $$('#lib-tags [data-tag-del]').find((s) => s.dataset.tagDel === '机器学习');
  push('标签行有移除按钮', !!delBtn);
  if (delBtn) {
    delBtn.click();
    await sleep(200);
    push('移除需要二次确认', (delBtn.textContent || '').indexOf('确认') >= 0, delBtn.textContent);
    delBtn.click();
    await sleep(700);
    const sum2 = await pdfBridge.lib.summary();
    const left = (sum2.items || []).filter((x) => (x.tags || []).indexOf('机器学习') >= 0);
    push('标签已从所有条目移除', left.length === 0, 'n=' + left.length);
  }

  // ---------- 3. 导出全部批注 ----------
  const p = App.state.filePath;
  await pdfBridge.saveAnnos(p, [{ page: 1, shapes: [{ tool: 'mark', color: '#ffd54f', rects: [{ x: 1, y: 2, w: 30, h: 9 }], text: '汇总用的原文', comment: '汇总评论' }] }]);
  await sleep(300);
  const outPath = p.replace(/\\.pdf$/i, '') + '-all.md';
  const ex = await pdfBridge.exportAllNotes(outPath);
  push('导出全部批注成功', !!(ex && ex.ok), JSON.stringify(ex));
  if (ex && ex.ok) {
    const fsr = window.require ? null : null;
    void fsr;
    push('导出结果有批注条数', ex.notes >= 1, 'notes=' + ex.notes);
  }

  return { checks };
})()`;
