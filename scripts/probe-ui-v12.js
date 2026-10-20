module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 8000)) { if (fn()) return true; await sleep(60); } return !!fn(); };
  await waitFor(() => $$('#lib-grid .lib-card').length === 3, 6000);

  // ---------- 查重弹窗 ----------
  $('#lib-dup').click();
  await waitFor(() => !$('#dup-modal').hidden && $$('#dup-body .dup-group').length > 0, 5000);
  push('查重弹窗打开', !$('#dup-modal').hidden);
  push('查重只列 1 组', $$('#dup-body .dup-group').length === 1, 'groups=' + $$('#dup-body .dup-group').length);
  push('查重列出 2 条候选', $$('#dup-body .dup-row').length === 2, 'rows=' + $$('#dup-body .dup-row').length);
  push('查重显示原因', /DOI 相同/.test(($('#dup-body .dup-reason') || {}).textContent || ''), ($('#dup-body .dup-reason') || {}).textContent);
  push('默认选中第一条', !!document.querySelector('input[name="dup-0"]:checked'));

  // 保留第二条（dupB），合并另一条
  const keepRadio = document.querySelector('input[name="dup-0"][value="dupB"]');
  if (keepRadio) { keepRadio.checked = true; keepRadio.dispatchEvent(new Event('change', { bubbles: true })); }
  $('#dup-body [data-dup-merge="0"]').click();
  await waitFor(() => /已合并/.test(($('#dup-status') || {}).textContent || ''), 5000);
  push('合并后提示条数', /已合并 1 条/.test(($('#dup-status') || {}).textContent || ''), ($('#dup-status') || {}).textContent);
  await sleep(400);
  const sumAfterMerge = await pdfBridge.lib.summary();
  push('合并后只剩 2 条', sumAfterMerge.items.length === 2, 'items=' + sumAfterMerge.items.length);
  const kept = sumAfterMerge.items.find((x) => x.key === 'dupB');
  const gone = sumAfterMerge.items.find((x) => x.key === 'dupA');
  push('保留项存在、被合并项消失', !!kept && !gone, JSON.stringify([!!kept, !!gone]));
  push('保留项仍有可用附件', !!(kept && kept.hasFile), JSON.stringify(kept && kept.attachment));
  $('#dup-close2').click();
  await sleep(100);

  // ---------- 详情面板 + 元数据抓取错误路径（无网络） ----------
  $('[data-detail="dupB"]').click();
  await waitFor(() => !$('#lib-detail').hidden, 3000);
  push('详情面板打开', !$('#lib-detail').hidden);
  push('详情回填 DOI', ($('#ld-doi').value || '').indexOf('10.1000/dup') === 0, $('#ld-doi').value);
  const titleBefore = $('#ld-title').value;
  $('#ld-doi').value = 'not-an-identifier';
  $('#ld-fetch').click();
  await waitFor(() => /抓取失败/.test(($('#ld-fetch-status') || {}).textContent || ''), 6000);
  push('无法识别的标识符给出错误提示', /无法识别/.test(($('#ld-fetch-status') || {}).textContent || ''), ($('#ld-fetch-status') || {}).textContent);
  push('抓取失败不覆盖已有标题', $('#ld-title').value === titleBefore, titleBefore + ' -> ' + $('#ld-title').value);
  $('#ld-close').click();
  await sleep(100);

  // ---------- IPC：BibTeX 导入 / 导出（数据层 + preload 桥） ----------
  const bib = '@article{ipc2023, title = {IPC Imported Paper}, author = {Doe, Jane and Roe, Rick}, year = {2023}, journal = {Bridge Journal}, pages = {11--22}, doi = {10.1000/ipc}, keywords = {bridge, ipc}}';
  const imp = await pdfBridge.lib.importRefs(bib, 'probe.bib');
  push('IPC 导入 BibTeX', imp && imp.ok && imp.added === 1 && imp.parsed === 1, JSON.stringify(imp));
  const sumImp = await pdfBridge.lib.summary();
  const ipcItem = sumImp.items.find((x) => x.doi === '10.1000/ipc');
  push('导入条目字段正确', !!ipcItem && ipcItem.title === 'IPC Imported Paper' && ipcItem.creators.length === 2 && ipcItem.pages === '11-22', JSON.stringify(ipcItem && [ipcItem.title, ipcItem.creators, ipcItem.pages]));
  const st = await pdfBridge.getSettings();
  const outPath = String(st.dataDir).replace(/[\\\\/]+$/, '') + '/probe-export.bib';
  const exp = await pdfBridge.lib.exportRefs({ outPath });
  push('IPC 导出 BibTeX', exp && exp.ok && exp.count >= 3, JSON.stringify(exp));

  // 无网络的元数据 IPC 错误路径：直接验证桥接，不依赖外网
  const meta = await pdfBridge.lib.fetchMetadata('这是什么');
  push('IPC 元数据错误可读', meta && meta.ok === false && /无法识别/.test(meta.error), JSON.stringify(meta));

  return { checks, outPath: exp && exp.path, importedKey: ipcItem && ipcItem.key };
})()`;
