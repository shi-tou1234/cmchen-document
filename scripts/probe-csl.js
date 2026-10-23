module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 8000)) { if (fn()) return true; await sleep(60); } return !!fn(); };

  const api = window.pdfBridge && window.pdfBridge.lib;
  push('preload 暴露 CSL 接口', !!(api && api.cslStyles && api.cslImport && api.cslRemove));

  // 1. 主进程扫描 <数据目录>/styles/*.csl
  const listed = api && api.cslStyles ? await api.cslStyles() : null;
  push('cslStyles 返回扫描结果', !!(listed && listed.ok), JSON.stringify(listed && listed.styles && listed.styles.map((s) => s.id)));
  push('扫到磁盘上的用户样式', !!(listed && listed.styles && listed.styles.length === 1 && listed.styles[0].id === 'probe-style'),
    JSON.stringify(listed && listed.styles && listed.styles.map((s) => s.id)));
  push('样式标题取自 info/title', !!(listed && listed.styles && listed.styles[0] && listed.styles[0].label === 'Probe Style'),
    listed && listed.styles && listed.styles[0] && listed.styles[0].label);

  // 2. 渲染层启动时把用户样式注册进引擎，并重建下拉
  const optionReady = await waitFor(() => !!document.querySelector('#ld-cite-style option[value="csl:probe-style"]'), 8000);
  push('启动后用户样式进入详情下拉', optionReady);
  const opt = document.querySelector('#bib-style option[value="csl:probe-style"]');
  push('参考文献下拉也包含用户样式', !!opt);
  push('用户样式分组是「导入的 CSL 样式」', !!(opt && opt.parentElement && opt.parentElement.tagName === 'OPTGROUP' &&
    opt.parentElement.label.indexOf('导入') >= 0), opt && opt.parentElement && opt.parentElement.label);

  // 3. 选中用户样式后，详情预览走 CSL 引擎
  const opened = await (async () => {
    $('#btn-library').click();
    await waitFor(() => $$('#lib-grid .lib-card').length >= 1, 8000);
    const dbtn = $('#lib-grid .lib-card [data-detail]');
    if (!dbtn) return false;
    dbtn.click();
    await waitFor(() => !$('#lib-detail').hidden && ($('#ld-title') || {}).value, 5000);
    return !$('#lib-detail').hidden;
  })();
  push('打开条目详情（探针前提）', opened);
  const sel = $('#ld-cite-style');
  if (sel) {
    sel.value = 'csl:probe-style';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(200);
  }
  const preview = ($('#ld-cite-preview') || {}).textContent || '';
  push('详情预览使用用户样式渲染', preview.indexOf('PROBE:Attention Is All You Need') === 0, preview.slice(0, 120));

  // 4. 参考文献表同样走 CSL
  $('#bib-style').value = 'csl:probe-style';
  $('#bib-style').dispatchEvent(new Event('change', { bubbles: true }));
  $('#lib-bib').click();
  await waitFor(() => !$('#bib-modal').hidden, 4000);
  await sleep(200);
  const bibText = ($('#bib-preview') || {}).value || '';
  push('参考文献预览使用用户样式', bibText.indexOf('PROBE:Attention Is All You Need') > 0, bibText.slice(0, 140));

  // 5. 界面里删除：管理样式 → 列出导入的 → 点删除
  const mgr = $('#csl-manager');
  push('管理面板默认收起', !!(mgr && mgr.hidden));
  const manageBtn = $('#bib-csl-manage');
  if (manageBtn) manageBtn.click();
  await sleep(120);
  push('点「管理样式」展开面板', !!(mgr && !mgr.hidden));
  const row = mgr ? mgr.querySelector('.csl-row[data-csl-id="csl:probe-style"]') : null;
  push('面板列出已导入的样式', !!row, mgr ? mgr.textContent.slice(0, 80) : 'no panel');
  push('样式标题取自 info/title', !!(row && row.textContent.indexOf('Probe Style') >= 0),
    row ? row.textContent : '');

  const delBtn = row ? row.querySelector('[data-csl-del]') : null;
  if (delBtn) delBtn.click();
  await waitFor(() => !(mgr && mgr.querySelector('.csl-row[data-csl-id="csl:probe-style"]')), 5000);
  const afterUi = api && api.cslStyles ? await api.cslStyles() : null;
  push('界面删除后磁盘上的样式没了', !!(afterUi && afterUi.ok && afterUi.styles && afterUi.styles.length === 0),
    JSON.stringify(afterUi && afterUi.styles));
  const goneOpt = await waitFor(() => !document.querySelector('#ld-cite-style option[value="csl:probe-style"]'), 5000);
  push('界面删除后详情下拉里的选项也清掉', goneOpt);
  push('删除后面板显示空态', !!(mgr && /还没有导入过/.test(mgr.textContent)), mgr ? mgr.textContent.slice(0, 60) : '');

  // 6. 删除接口是幂等的（文件已经没了再删一次也不报错）
  const again = api && api.cslRemove ? await api.cslRemove('probe-style') : null;
  push('重复删除同一 id 仍然返回成功', !!(again && again.ok), JSON.stringify(again && again.error));

  return { checks };
})();`;
