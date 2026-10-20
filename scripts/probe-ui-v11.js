module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 8000)) { if (fn()) return true; await sleep(60); } return !!fn(); };
  await waitFor(() => $$('#lib-grid .lib-card').length > 0, 5000);

  // 主进程建索引（library 两条都指向同一个 PDF → 1 份索引 / 2 个已索引条目）
  const idx = await pdfBridge.lib.indexAll(false);
  push('主进程全文索引成功', idx && idx.ok && idx.failed === 0 && idx.done === 2, JSON.stringify({ done: idx && idx.done, failed: idx && idx.failed }));
  const st = await pdfBridge.lib.ftStatus();
  push('索引状态有已索引条目', st && st.indexedItems >= 2 && st.indexed >= 1, JSON.stringify(st));

  // 库级全文检索
  const inp = $('#lib-search');
  inp.value = 'sample page 2';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  await waitFor(() => $$('#lib-ft .lib-ft-row').length > 0, 8000);
  push('库级全文检索出现结果行', $$('#lib-ft .lib-ft-row').length > 0, 'rows=' + $$('#lib-ft .lib-ft-row').length);
  push('全文结果含页号与摘要', /P2/.test(($('#lib-ft .lib-ft-row .lib-ft-pg') || {}).textContent || '') &&
    /Sample page 2/.test(($('#lib-ft .lib-ft-row .lib-ft-snip') || {}).textContent || ''), ($('#lib-ft .lib-ft-row .lib-ft-snip') || {}).textContent);
  push('全文结果可点击跳转', !!$('#lib-ft .lib-ft-row[data-ft-key]'), $('#lib-ft .lib-ft-row') && $('#lib-ft .lib-ft-row').outerHTML.slice(0, 120));

  // 智能收藏集 = 保存当前搜索
  $('#lib-save-search').click();
  await sleep(60);
  const si = $('#lib-side input[placeholder="智能收藏集名称"]');
  if (si) { si.value = 'Smoke 集'; si.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }
  await waitFor(() => $$('#lib-searches [data-search]').length > 0, 4000);
  const sumS = await pdfBridge.lib.summary();
  push('保存智能收藏集', sumS.searches && sumS.searches.length === 1 && sumS.searches[0].query === 'sample page 2', JSON.stringify(sumS.searches));
  push('智能收藏集出现在侧栏', $$('#lib-searches [data-search]').length === 1, 'n=' + $$('#lib-searches [data-search]').length);

  // 批量选择 + 批量编辑
  inp.value = ''; inp.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(120);
  $('#lib-select-all').checked = true;
  $('#lib-select-all').dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(80);
  push('全选后进入批量条', !$('#lib-bulk').hidden, $('#lib-bulk-count').textContent);
  $('#lib-bulk-edit').click();
  await sleep(80);
  $('#bulk-year').value = '2031';
  $('#bulk-save').click();
  await sleep(600);
  const sumB = await pdfBridge.lib.summary();
  push('批量编辑年份生效', sumB.items.filter((x) => !x.deletedAt).every((x) => x.year === '2031'), JSON.stringify(sumB.items.map((x) => x.year)));

  // 设置：主题 / 默认排序 / 存储位置
  $('#lib-settings').click();
  await sleep(100);
  push('设置面板打开', !$('#settings-modal').hidden);
  const shownDir = ($('#set-data-dir').textContent || '').trim();
  push('设置显示存储位置', !!shownDir, shownDir);
  $('#set-theme').value = 'dark';
  $('#set-sort').value = 'title';
  $('#set-save').click();
  await sleep(500);
  push('深色主题应用', document.body.classList.contains('theme-dark'));
  const st2 = await pdfBridge.getSettings();
  push('设置持久化', st2.theme === 'dark' && st2.defaultSort === 'title', JSON.stringify(st2));
  push('设置回显有效数据目录', pathLike(st2.dataDir) && pathLike(st2.settingsFile), JSON.stringify([st2.dataDir, st2.settingsFile]));
  $('#set-close').click();
  await sleep(100);

  // 一键备份：把目标路径放在数据目录里，避免写死某台机器的临时路径
  const bakPath = String(st2.dataDir).replace(/[\\\\/]+$/, '') + '/probe-backup.json';
  const bak = await pdfBridge.lib.backup(bakPath);
  push('一键备份生成文件', bak && bak.ok && bak.items >= 2, JSON.stringify({ ok: bak && bak.ok, items: bak && bak.items, path: bak && bak.path }));
  return { checks, idx, st, sumS, bakPath: bak && bak.path };

  function pathLike(s) { return typeof s === 'string' && s.length > 2 && /[\\\\/]/.test(s); }
})()`;
