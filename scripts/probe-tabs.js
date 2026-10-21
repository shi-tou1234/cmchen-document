module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 10000)) { if (fn()) return true; await sleep(80); } return !!fn(); };
  await waitFor(() => $$('#lib-grid .lib-card').length === 2, 5000);
  const open = async (key) => {
    const c = $('[data-open="' + key + '"]');
    if (!c) return false;
    // v27 起对齐 Zotero：单击只选中，双击才打开
    c.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    c.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    return await waitFor(() => document.body.classList.contains('has-doc') && App.state.numPages === 3, 10000);
  };
  push('标签页初始为空', App.tabs.length === 0 && $('#tabbar').hidden);
  await open('itA');
  await waitFor(() => App.tabs.length === 1, 4000);
  push('打开第一条生成一个标签', App.tabs.length === 1 && !$('#tabbar').hidden, 'tabs=' + App.tabs.length);
  const firstPath = App.state.filePath;

  // 给第一个文档种一条标注：用于验证切换/关闭标签后标注不丢
  App.state.annos.set(1, [{ tool: 'mark', color: '#ffeb3b', rects: [{ x: 10, y: 20, w: 80, h: 12 }], text: 'tab-anno', comment: 'tab comment' }]);
  App.notifyAnnoChanged();
  await App.flushAnnos();
  const seeded = await pdfBridge.loadAnnos(firstPath);
  push('标注已写入磁盘', JSON.stringify(seeded).indexOf('tab-anno') >= 0, JSON.stringify(seeded).slice(0, 160));

  $('#btn-library').click();
  await waitFor(() => !$('#library').hidden && $$('#lib-grid .lib-card').length === 2, 4000);
  await open('itB');
  await waitFor(() => App.tabs.length === 2, 6000);
  push('打开不同 PDF 生成第二个标签', App.tabs.length === 2, 'tabs=' + App.tabs.length + ' html=' + $('#tabs').innerHTML);
  if (App.tabs.length !== 2) return { checks, stage: 'afterB', hasDoc: document.body.classList.contains('has-doc'), path: App.state.filePath, tabsHtml: $('#tabs').innerHTML };
  push('第二个标签处于激活态', App.tabs.find((t) => t.id === App.activeTabId).fileName.indexOf('copy') >= 0, App.state.filePath);
  const secondPath = App.state.filePath;

  App.renderTabs();
  const tabs = $$('#tabs .tab');
  push('标签栏渲染两个标签', tabs.length === 2, 'rendered=' + tabs.length + ' err=' + (App.lastLoadError || ''));
  if (tabs.length < 2) return { checks, stage: 'render', tabsHtml: $('#tabs').innerHTML };
  tabs[0].click();
  await waitFor(() => App.state.filePath === firstPath, 10000);
  push('点标签切回第一个文档', App.state.filePath === firstPath, App.state.filePath);
  push('切回后页码恢复到条目进度', App.state.currentPage === 2, 'page=' + App.state.currentPage);
  await waitFor(() => (App.state.annos.get(1) || []).some((s) => s.text === 'tab-anno'), 5000);
  const backMark = (App.state.annos.get(1) || []).find((s) => s.text === 'tab-anno');
  push('切换标签不丢标注', !!backMark && backMark.comment === 'tab comment', JSON.stringify(backMark && { text: backMark.text, comment: backMark.comment }));

  await sleep(300);
  const secondTab = $$('#tabs .tab')[1];
  secondTab.querySelector('.tab-x').click();
  await waitFor(() => App.tabs.length === 1, 3000);
  push('关闭非激活标签只移除一个', App.tabs.length === 1 && $$('#tabs .tab').length === 1, 'tabs=' + App.tabs.length);
  $$('#tabs .tab')[0].querySelector('.tab-x').click();
  await waitFor(() => App.tabs.length === 0, 4000);
  push('关闭最后一个标签回到空态', App.tabs.length === 0 && !document.body.classList.contains('has-doc') && $('#tabbar').hidden);
  push('空态自动显示文献库', !$('#library').hidden);

  // 关闭标签只是结束阅读会话：标注文件与磁盘 PDF 都必须还在
  const afterClose = await pdfBridge.loadAnnos(firstPath);
  push('关闭标签不删标注文件', JSON.stringify(afterClose).indexOf('tab-anno') >= 0, JSON.stringify(afterClose).slice(0, 160));
  const sum = await pdfBridge.lib.summary();
  const a = sum.items.find((x) => x.key === 'itA');
  const b = sum.items.find((x) => x.key === 'itB');
  push('关闭标签不删磁盘 PDF', !!(a && a.hasFile) && !!(b && b.hasFile), JSON.stringify([a && a.hasFile, b && b.hasFile]));
  return { checks, firstPath, secondPath };
})()`;
