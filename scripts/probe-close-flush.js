'use strict';
/*
 * 关窗保存探针（v1.6d）：被 test-close-flush.js 调用。
 *
 * 只做一件事：制造「内存里有、磁盘上还没有」的状态，然后立刻关窗。
 * 600ms 的防抖保存根本来不及触发——如果关窗握手没生效，磁盘上就是空的。
 */
module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 20000)) { if (fn()) return true; await sleep(80); } return !!fn(); };

  const payload = await pdfBridge.openDocPath({ path: __PDF__ });
  if (!payload || !payload.ok) return { checks, stage: 'open-fail' };
  App.openDocument(payload);
  const ready = await waitFor(() => window.App && App.state.pdfDoc && App.state.rendered.get(1), 25000);
  push('文档已加载', ready);
  if (!ready) return { checks, stage: 'no-doc' };

  // 直接改内存标注 + 走正常的「有改动」通道：会排一个 600ms 的写盘定时器
  App.state.annos.set(1, [{
    id: 'close-1', tool: 'mark', color: '#ffd84d', kind: '',
    rects: [{ x: 60, y: 80, w: 160, h: 18 }], text: '关窗前最后一条',
  }]);
  if (window.Anno && Anno.renderPage) Anno.renderPage(1);
  // ===== A. 保存失败后必须保留脏状态，下一次关窗还要重试（R-v1.6e-01） =====
  // 直接调 LibraryUI.flushPendingSaves 并注入一个「保存失败」的假保存函数：
  // 要验的是「失败了还留着待保存记录」，不是「保存函数本身对不对」。
  // 直接开文档时文献库是收起的，先把它展开（详情面板在库里）
  if (window.LibraryUI && !LibraryUI.isOpen()) LibraryUI.show();
  const libReady = await waitFor(() => window.LibraryUI && LibraryUI.isOpen(), 12000);
  push('文献库就绪', libReady);
  if (libReady) {    window.LibraryUI.openDetail('c1');
    const boxOk = await waitFor(() => document.querySelector('.ld-note-rich'), 8000);
    push('详情面板里有富文本笔记', boxOk);
    if (boxOk) {
      const box = document.querySelector('.ld-note-rich');
      box.innerHTML = '<p>改过的正文</p>';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(120);
      push('改动已排进待保存表', LibraryUI.pendingNoteSaves() === 1, LibraryUI.pendingNoteSaves());

      const bad = await LibraryUI.flushPendingSaves(async () => false);
      push('保存失败时 flush 返回 false', bad === false, bad);
      push('失败后待保存记录还在', LibraryUI.pendingNoteSaves() === 1, LibraryUI.pendingNoteSaves());

      const good = await LibraryUI.flushPendingSaves(async () => true);
      push('重试成功后 flush 返回 true', good === true, good);
      push('成功后待保存表清空', LibraryUI.pendingNoteSaves() === 0, LibraryUI.pendingNoteSaves());

      // ===== 自动保存失败也要留下脏状态（R-v1.6f-01） =====
      // 走的是「输入 → 700ms 防抖 → 自动保存」这条路，不是手动 flush。
      // 前一次 flush 成功后详情面板可能已经重绘，这里要重新取一次元素。
      const box2 = document.querySelector('.ld-note-rich');
      push('重绘后仍能拿到笔记编辑区', !!box2);
      LibraryUI._setNoteSaveImpl(async () => ({ ok: false, error: '模拟失败' }));
      if (box2) {
        box2.innerHTML = '<p>自动保存会失败的正文</p>';
        box2.dispatchEvent(new Event('input', { bubbles: true }));
      }
      await sleep(1100);   // 等防抖 + 失败回填
      push('自动保存失败后仍记为待保存', LibraryUI.pendingNoteSaves() === 1, LibraryUI.pendingNoteSaves());
      LibraryUI._setNoteSaveImpl(null);
      const retried = await LibraryUI.flushPendingSaves();
      push('关窗时能把自动保存失败的补上', retried === true && LibraryUI.pendingNoteSaves() === 0,
        JSON.stringify({ retried, pending: LibraryUI.pendingNoteSaves() }));
    }
  }

  App.notifyAnnoChanged();
  // 先确认「磁盘上确实还没有」：否则这条测试就只是在验证一个早已存在的文件
  const before = await pdfBridge.loadAnnos(App.state.filePath);
  const onDisk = (before || []).some((e) => (e.shapes || []).some((s) => s.id === 'close-1'));
  push('关窗之前磁盘上还没有这条', !onDisk, JSON.stringify((before || []).map((e) => e.page)));

  // 关窗握手：主进程拦下 close 后调的就是这个函数。
  // 真去 window.close() 的话窗口会被直接销毁、主进程的 close 事件都不触发（Electron 的行为），
  // 探针也就没法再断言任何东西——所以这里直接调握手入口，再看磁盘。
  push('preload 暴露了关窗握手', typeof pdfBridge.onWillClose === 'function' && typeof pdfBridge.closeReady === 'function');
  await App.handleWillClose();
  const r = App._lastCloseFlush || {};
  push('握手回报「存好了」', r.ok === true, JSON.stringify(r));

  // 不靠防抖：这时候磁盘上必须已经有这条
  const after = await pdfBridge.loadAnnos(App.state.filePath);
  const saved = (after || []).some((e) => (e.shapes || []).some((s) => s.id === 'close-1'));
  push('关窗前那一刻的标注已落盘', saved, JSON.stringify((after || []).map((e) => e.page)));
  return { checks };
})()`;
