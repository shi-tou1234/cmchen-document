'use strict';
/*
 * 抓取 PDF 全文的 UI 探针（不碰外网）：按钮存在、无标识时给提示、设置里邮箱能存。
 * 被 test-fetch-pdf-ui.js 调用。
 */
module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 8000)) { if (fn()) return true; await sleep(80); } return !!fn(); };

  try {
    const libReady = await waitFor(() => window.LibraryUI && LibraryUI.isOpen(), 10000);
    push('启动后文献库自动展开', libReady);
    if (!libReady) return { checks, stage: 'startup' };

    // 1. 入库后打开详情，检查按钮
    const add = await pdfBridge.lib.addPdf('__SAMPLE__', { dedupe: true });
    push('样例 PDF 入库', !!(add && add.ok), JSON.stringify((add || {}).error));
    const key = add.item.key;
    // 清掉 DOI / URL，制造「没有标识」的场景
    await pdfBridge.lib.updateItem(key, { doi: '', url: '' });
    await LibraryUI.refresh();
    await waitFor(() => $$('#lib-grid .lib-card').length >= 1, 6000);
    const card = $('#lib-grid .lib-card[data-key="' + key + '"]');
    if (card) card.click();
    await waitFor(() => !$('#lib-detail').hidden, 4000);
    const btn = await waitFor(() => $('#ld-fetch-pdf'), 4000) ? $('#ld-fetch-pdf') : null;
    push('详情里有「抓 PDF 全文」按钮', !!btn, btn ? btn.textContent : '');
    push('按钮在元数据抓取按钮旁边', !!$('#ld-fetch'), '');

    // 2. 没有 DOI / URL 时点它 → 给出提示而不是发请求
    if (btn) btn.click();
    await sleep(400);
    const st = $('#ld-fetch-status').textContent || '';
    push('无标识时给出提示', /DOI|链接/.test(st), st);

    // 3. 设置里能存联系邮箱
    $('#lib-settings').click();
    await waitFor(() => $('#settings-modal') && !$('#settings-modal').hidden, 4000);
    const email = $('#set-fetch-email');
    push('设置里有抓取邮箱输入框', !!email, '');
    if (email) {
      email.value = 'tester@example.org';
      const saveBtn = $('#set-save');
      if (saveBtn) saveBtn.click();
      await sleep(600);
      const s = await pdfBridge.getSettings();
      push('邮箱写进设置', !!(s && s.fetchEmail === 'tester@example.org'), JSON.stringify(s && s.fetchEmail));
      // 非法邮箱要被清空
      email.value = 'not-an-email';
      if (saveBtn) saveBtn.click();
      await sleep(600);
      const s2 = await pdfBridge.getSettings();
      push('非法邮箱被丢弃', !!(s2 && !s2.fetchEmail), JSON.stringify(s2 && s2.fetchEmail));
      if ($('#settings-close')) $('#settings-close').click();
    }

    return { checks };
  } catch (e) {
    return { checks, fatal: String((e && e.stack) || e) };
  }
})()`;
