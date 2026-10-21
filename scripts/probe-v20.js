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

  // ---------- 1. 专注阅读模式 ----------
  push('默认不是专注模式', !document.body.classList.contains('focus-mode'));
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F11', bubbles: true, cancelable: true }));
  await sleep(200);
  push('F11 进入专注模式', document.body.classList.contains('focus-mode'), document.body.className);
  push('专注模式收掉了工具栏', getComputedStyle($('#toolbar')).display === 'none',
    'display=' + getComputedStyle($('#toolbar')).display);
  push('专注模式收掉了状态栏', getComputedStyle($('#statusbar')).display === 'none');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await sleep(200);
  push('Esc 退出专注模式', !document.body.classList.contains('focus-mode'));
  push('退出后工具栏回来', getComputedStyle($('#toolbar')).display !== 'none');

  // ---------- 2. 页面右键菜单 ----------
  const el = App.pageEl(1);
  const r = el.getBoundingClientRect();
  el.dispatchEvent(new MouseEvent('contextmenu', { clientX: r.left + 40, clientY: r.top + 40, bubbles: true, cancelable: true }));
  await sleep(250);
  const menu = $('.ctx-menu');
  push('右键弹出页面菜单', !!menu);
  const items = menu ? $$('.ctx-menu button').map((b) => b.textContent) : [];
  push('菜单里有复制页面文字', items.some((t) => /复制第 1 页文字/.test(t)), items.join(' | '));
  push('菜单里有导出页面图片', items.some((t) => /导出第 1 页为图片/.test(t)), items.join(' | '));
  push('菜单里有看图模式', items.some((t) => /放大看这一块/.test(t)), items.join(' | '));
  // 点外面关掉
  document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await sleep(150);
  push('点外面关掉菜单', !$('.ctx-menu'));

  // ---------- 3. 批注 Markdown 导出带引用与标签 ----------
  App.state.annos.set(1, [
    { tool: 'mark', color: '#ffd54f', rects: [{ x: 1, y: 2, w: 30, h: 9 }], text: '这是一段原文', comment: '值得注意', tags: ['重点'] },
  ]);
  App.notifyAnnoChanged();
  await sleep(200);
  const md = App.buildNoteText('md');
  push('Markdown 含页小节', md.indexOf('## 第 1 页') > 0, md.slice(0, 120));
  push('Markdown 原文是引用块', md.indexOf('> 这是一段原文') > 0, md.slice(0, 200));
  push('Markdown 带评论', md.indexOf('**评论**：值得注意') > 0, md.slice(0, 240));
  push('Markdown 带标签', md.indexOf('#重点') > 0, md.slice(0, 260));
  push('Markdown 头部有统计', /共 1 条批注/.test(md), md.slice(0, 120));

  // ---------- 4. 深色模式反色开关 ----------
  const inv = $('#set-invert-pages');
  push('设置里有「深色反色」开关', !!inv);
  if (inv) {
    inv.checked = true;
    if (window.App && App.applyInvert) App.applyInvert(true);
    await sleep(150);
    push('打开后页面加反色类', document.body.classList.contains('invert-pages'));
    if (window.App && App.applyInvert) App.applyInvert(false);
    await sleep(100);
    push('关掉后反色类移除', !document.body.classList.contains('invert-pages'));
  }

  return { checks };
})()`;
