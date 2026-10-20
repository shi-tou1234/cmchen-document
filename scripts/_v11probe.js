module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 8000)) { if (fn()) return true; await sleep(60); } return !!fn(); };
  await waitFor(() => $$('#lib-grid .lib-card').length > 0, 5000);

  const idx = await pdfBridge.lib.indexAll(false);
  push('主进程全文索引成功', idx && idx.ok && idx.failed === 0, JSON.stringify({ done: idx && idx.done, failed: idx && idx.failed }));
  const st = await pdfBridge.lib.ftStatus();
  push('索引状态有已索引文件', st && st.indexedItems >= 1, JSON.stringify(st));

  const inp = $('#lib-search');
  inp.value = 'sample page 2';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => $$('#lib-ft .lib-ft-row').length > 0, 8000);
  push('库级全文检索出现结果行', $$('#lib-ft .lib-ft-row').length > 0, 'rows=' + $$('#lib-ft .lib-ft-row').length);
  push('全文结果含页号与摘要', /P2/.test(($('#lib-ft .lib-ft-row .lib-ft-pg') || {}).textContent || ''), ($('#lib-ft .lib-ft-row .lib-ft-snip') || {}).textContent);

  $('#lib-save-search').click();
  await sleep(50);
  const si = $('#lib-side input[placeholder="智能收藏集名称"]');
  if (si) { si.value = 'Smoke 集'; si.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }
  await waitFor(() => $$('#lib-searches [data-search]').length > 0, 4000);
  const sumS = await pdfBridge.lib.summary();
  push('保存智能收藏集', sumS.searches && sumS.searches.length === 1 && sumS.searches[0].query === 'sample page 2', JSON.stringify(sumS.searches));

  // 批量选择 + 批量编辑年份
  inp.value = ''; inp.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(100);
  $('#lib-select-all').checked = true;
  $('#lib-select-all').dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(80);
  push('全选后进入批量条', !$('#lib-bulk').hidden, $('#lib-bulk-count').textContent);
  $('#lib-bulk-edit').click();
  await sleep(80);
  $('#bulk-year').value = '2031';
  $('#bulk-save').click();
  await waitFor(async () => false, 300);
  await sleep(500);
  const sumB = await pdfBridge.lib.summary();
  push('批量编辑年份生效', sumB.items.filter((x) => !x.deletedAt).every((x) => x.year === '2031'), JSON.stringify(sumB.items.map((x) => x.year)));

  // 设置：主题 / 默认排序
  $('#lib-settings').click();
  await sleep(80);
  push('设置面板打开', !$('#settings-modal').hidden);
  push('设置显示存储位置', !!($('#set-data-dir').textContent || '').trim(), $('#set-data-dir').textContent);
  $('#set-theme').value = 'dark';
  $('#set-sort').value = 'title';
  $('#set-save').click();
  await sleep(400);
  push('深色主题应用', document.body.classList.contains('theme-dark'));
  const st2 = await pdfBridge.getSettings();
  push('设置持久化', st2.theme === 'dark' && st2.defaultSort === 'title', JSON.stringify(st2));
  $('#set-close').click();

  // 备份文件（直接指定路径，不弹窗）
  const bak = await pdfBridge.lib.backup('C:\\\\Users\\\\24256\\\\AppData\\\\Local\\\\Temp\\\\v11-backup-test.json');
  push('一键备份生成文件', bak && bak.ok && bak.items >= 2, JSON.stringify({ ok: bak && bak.ok, items: bak && bak.items, path: bak && bak.path }));

  return { checks, idx, st, sumS };
})()`;
