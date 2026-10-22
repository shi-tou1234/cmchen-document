'use strict';
/*
 * 模式切换（阅读 ↔ 文献库）探针：在真实渲染进程里复现用户报的三个问题——
 *   1. 从文献库切回阅读器时，淡出结束后整层回闪（fill:'none' 的 WAAPI 动画
 *      播完会把 opacity 弹回 1，要等兜底定时器才真正藏起来）；
 *   2. 从库里打开文档后，高亮药丸停在「文献库」不跟人走（hide() 里 sync()
 *      在淡出途中读到的是旧视图），此时点「阅读」就"没有反应"；
 *   3. 关掉最后一个标签后（closeDocument），侧栏缩略图/目录残留上一篇文档。
 * 被 test-modeswitch.js 调用。
 */
module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 8000)) { if (fn()) return true; await sleep(60); } return !!fn(); };

  const SAMPLE = '__SAMPLE__';   // 由 test-modeswitch.js 注入（渲染进程没有 process）
  const pillMode = () => Array.from(document.querySelectorAll('.mode-switch')).map((box) => {
    const a = box.querySelector('.mode-tab.active');
    return a ? a.dataset.mode : '(none)';
  }).join('|');

  // 0. 启动即进库（主应用窗口的既有行为）
  const libReady = await waitFor(() => window.LibraryUI && LibraryUI.isOpen(), 10000);
  push('启动后文献库自动展开', libReady);
  push('启动后两处高亮块都指向「文献库」', pillMode() === 'library|library', pillMode());
  if (!libReady) return { checks, stage: 'startup' };

  // 1. 样例 PDF 入库
  const add = await pdfBridge.lib.addPdf(SAMPLE, { dedupe: true });
  push('样例 PDF 入库', !!(add && add.ok && add.item), JSON.stringify((add && add.error) || ''));
  await LibraryUI.refresh();
  await waitFor(() => document.querySelector('#lib-grid .lib-card[data-open]'), 6000);
  const card = document.querySelector('#lib-grid .lib-card[data-open]');
  push('库列表出现条目卡片', !!card);
  if (!card) return { checks, stage: 'card' };

  // 2. 双击条目打开阅读：库收起 + 高亮块跟到「阅读」
  card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  const opened = await waitFor(() => document.body.classList.contains('has-doc') && !LibraryUI.isOpen(), 15000);
  push('双击条目进入阅读（文档已加载、库已收起）', opened);
  await sleep(400);   // 等淡出兜底定时器走完再核对高亮块
  push('打开文档后两处高亮块都指向「阅读」', pillMode() === 'read|read', pillMode());
  if (!opened) return { checks, stage: 'open' };

  // 3. 阅读器 → 文献库 → 阅读器：回程不得回闪
  $('#btn-library').click();
  const libShown = await waitFor(() => LibraryUI.isOpen(), 5000);
  push('点「文献库」回到库', libShown);
  await sleep(350);
  push('回库后两处高亮块都指向「文献库」', pillMode() === 'library|library', pillMode());

  const root = $('#library');
  $('#lib-back').click();
  // 采样 300ms：leave 动画播完（fill:none）后 opacity 不得弹回 1
  const ops = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 300) {
    ops.push([Date.now() - t0, parseFloat(getComputedStyle(root).opacity), root.hidden]);
    await sleep(25);
  }
  let minOp = 1, flash = false;
  for (const [, op, hid] of ops) {
    if (hid) break;   // 已收起，之后的采样不算
    if (op < minOp) minOp = op;
    else if (minOp < 0.6 && op > 0.9) flash = true;   // 降下去又弹回来
  }
  push('淡出过程不回闪（fill:none 回弹）', !flash, 'minOpacity=' + minOp.toFixed(2) + ' samples=' + ops.length);
  const hidden = await waitFor(() => root.hidden && !LibraryUI.isOpen(), 3000);
  push('点「阅读」能收起库回到阅读器', hidden);
  await sleep(300);
  push('收起后两处高亮块都指向「阅读」', pillMode() === 'read|read', pillMode());
  push('阅读器里的文档还在（切换不清空阅读会话）', document.body.classList.contains('has-doc') && !!App.state.pdfDoc, '');

  // 4. 关闭最后一个标签 → closeDocument：侧栏不得残留上一篇的缩略图
  const tabId = App.tabs.length ? App.tabs[0].id : null;
  push('当前有打开的标签（前提）', !!tabId);
  if (tabId) {
    // 先把侧栏切到缩略图页并等它建好，制造「缩略图已渲染」的状态
    $('#btn-sidebar').click();
    await sleep(150);
    const thumbsTab = document.querySelector('.sb-tab[data-tab="thumbs"]');
    if (thumbsTab) thumbsTab.click();
    await waitFor(() => document.querySelectorAll('#sb-thumbs .thumb').length > 0, 10000);
    const thumbCount = document.querySelectorAll('#sb-thumbs .thumb').length;
    push('缩略图面板已渲染出页面缩略图（前提）', thumbCount > 0, 'thumbs=' + thumbCount);

    App.closeTab(tabId);
    await sleep(500);
    push('关掉标签后退出 has-doc 状态', !document.body.classList.contains('has-doc'), '');
    push('关掉最后一个标签后库自动展开（原行为保留）', LibraryUI.isOpen(), '');
    const stale1 = document.querySelectorAll('#sb-thumbs .thumb').length;
    push('关闭文档后侧栏缩略图不残留', stale1 === 0, 'thumbs=' + stale1);

    // 回到空白阅读页，缩略图同样不该有旧文档
    $('#lib-back').click();
    await waitFor(() => !LibraryUI.isOpen(), 3000);
    await sleep(300);
    const stale2 = document.querySelectorAll('#sb-thumbs .thumb').length;
    push('空白阅读页不显示旧文档缩略图', stale2 === 0, 'thumbs=' + stale2);
    const outlineStale = document.querySelectorAll('#sb-outline .outline-node').length;
    push('空白阅读页不显示旧文档目录', outlineStale === 0, 'outline=' + outlineStale);
  }

  return { checks };
})()`;
