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

  // 5. 删除接口：删掉文件后列表归零
  const removed = api && api.cslRemove ? await api.cslRemove('probe-style') : null;
  push('cslRemove 删除样式文件', !!(removed && removed.ok), JSON.stringify(removed && removed.error));
  const after = api && api.cslStyles ? await api.cslStyles() : null;
  push('删除后扫描结果为空', !!(after && after.ok && after.styles && after.styles.length === 0),
    JSON.stringify(after && after.styles));

  return { checks };
})();`;
