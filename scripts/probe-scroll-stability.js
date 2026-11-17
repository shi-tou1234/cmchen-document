'use strict';
/*
 * 阅读位置稳定性探针（渲染进程内断言）。
 *
 * 复现用户报的「打开 / 关闭侧栏、缩放、最大化、分屏、旋转之后页面跳一下，停不住在原本读的地方」。
 * 度量方式：记「视口顶部那一点落在第几页、页内几分之几」，操作后再看这一点跑到了哪里。
 * 漂移 0~3px 属正常（页间 gap 与取整），超过 1/4 页高就是「跳走了」。
 */
module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 20000)) { if (fn()) return true; await sleep(60); }
    return !!fn();
  };

  const ready = await waitFor(() => window.App && App.state.pdfDoc && App.state.rendered.get(1) && App.els.viewer, 25000);
  push('文档已打开且首页已渲染（探针前提）', ready);
  if (!ready) return { checks };

  const viewer = App.els.viewer;
  const $ = (id) => document.getElementById(id);

  // 统一初始状态：连续滚动 + 适应宽度 + 侧栏关闭
  const sb = $('sidebar');
  if (sb && !sb.hidden) { $('btn-sidebar').click(); await sleep(400); }
  App.setViewMode('scroll');
  await sleep(200);
  const sel = App.els.scale;
  sel.value = 'page-width';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(400);

  // 停在「页中间」：页顶在视口上方时，「保页顶像素」和「保页内比例」才会分道扬镳
  const mid = Math.min(3, App.state.numPages);
  App.scrollToPage(mid, true);
  await sleep(350);
  viewer.scrollTop += 160;
  await sleep(300);

  const vRect = () => viewer.getBoundingClientRect();
  // 度量的是「视口正中那一点」：这是眼睛实际盯着的位置，也是锚点用的参考点。
  // 操作后这一点必须仍在正中 —— 换成绝对屏幕坐标会被工具栏显隐（视口整体上移）干扰。
  const refY = () => {
    const r = vRect();
    return Math.round(r.top + r.height * 0.5);
  };

  function contentAt(y) {
    for (let n = 1; n <= App.state.numPages; n++) {
      const el = App.pageEl(n);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.height > 4 && y >= r.top && y <= r.bottom) return { page: n, frac: (y - r.top) / r.height };
    }
    return null;
  }
  function whereIs(a) {
    const el = App.pageEl(a.page);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.height > 0 ? r.top + a.frac * r.height : null;
  }

  // 视线中心正好落在页间缝隙时轻微挪一下，让锚点落在一页上
  async function centerOnPage() {
    for (let i = 0; i < 12; i++) {
      if (contentAt(refY())) return true;
      viewer.scrollTop += 26;
      await sleep(120);
    }
    return !!contentAt(refY());
  }
  push('视线中心压在一页上（探针前提）', await centerOnPage());

  // 每个用例：取锚 → 操作 → 等布局落定 → 看同一个内容点还在不在视口正中
  async function steady(label, action, waitMs) {
    const y = refY();
    const a = contentAt(y);
    if (!a) { push(label + '（前提：视口中心压在某页上）', false, '找不到锚点页'); return; }
    await action();
    await sleep(waitMs || 500);
    const y2 = whereIs(a);
    if (y2 == null) { push(label, false, '锚点页消失'); return; }
    const drift = Math.abs(y2 - refY());
    const pageH = App.pageEl(a.page).getBoundingClientRect().height || 1;
    // 容差按页高比例给（约 0.6%，半行字）：取整、页间距、滚动条进出都会带来几像素误差；
    // 而「页面跳走」是页高的 10%~30%，两者差着一个数量级。
    const tol = Math.max(8, pageH * 0.006);
    push(label + '（漂移 ≤ ' + Math.round(tol) + 'px）', drift <= tol,
      '漂移 ' + drift.toFixed(1) + 'px / 页高 ' + Math.round(pageH) + 'px' + (drift > pageH / 4 ? ' ← 整段跑出视口' : ''));
  }

  const neutral = () => ({ ok: true });

  // ---------- 1. 侧栏（目录 / 缩略图）开合 ----------
  await steady('打开侧栏后阅读位置不变', async () => { $('btn-sidebar').click(); await sleep(60); });
  await steady('侧栏内切到缩略图面板后位置不变', async () => {
    const t = document.querySelector('.sb-tab[data-tab="thumbs"]');
    if (t) t.click();
    await sleep(60);
  });
  await steady('关闭侧栏后阅读位置不变', async () => { $('btn-sidebar').click(); await sleep(60); });

  // ---------- 2. 缩放 ----------
  await steady('放大一档后阅读位置不变', async () => {
    App.els.zoomIn.click();
    await sleep(80);
  });
  await steady('再缩小一档后阅读位置不变', async () => {
    App.els.zoomOut.click();
    await sleep(80);
  });
  await steady('缩放下拉切到 150% 后位置不变', async () => {
    App.els.scale.value = '1.5';
    App.els.scale.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(80);
  });
  await steady('缩放下拉切回适应宽度后位置不变', async () => {
    App.els.scale.value = 'page-width';
    App.els.scale.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(80);
  });
  await steady('Ctrl+0（适应宽度）后位置不变', async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '0', ctrlKey: true, bubbles: true, cancelable: true }));
    await sleep(80);
  });

  // ---------- 3. 专注模式 ----------
  await steady('进入专注模式后位置不变', async () => { App.setFocusMode(true); await sleep(120); });
  await steady('退出专注模式后位置不变', async () => { App.setFocusMode(false); await sleep(120); });

  // ---------- 4. 分屏对照 ----------
  await steady('打开分屏对照后位置不变', async () => { App.setSplitView(true); await sleep(500); });
  await steady('关闭分屏对照后位置不变', async () => { App.setSplitView(false); await sleep(500); });

  // ---------- 5. 旋转 ----------
  await steady('旋转 90° 后阅读位置不变', async () => { App.rotateView(90); await sleep(300); });
  await steady('转回 0° 后阅读位置不变', async () => { App.rotateView(-90); await sleep(300); });

  // ---------- 6. 阅读区宽度突变（等同窗口最大化 / 还原） ----------
  // 直接改整窗尺寸在渲染进程里做不到，但「阅读区宽高一起变」走的正是同一条路径。
  await steady('阅读区变窄（等同窗口变窄）后位置不变', async () => {
    viewer.style.padding = '22px 120px 40px';
    await sleep(220);
  });
  await steady('阅读区还原后位置不变', async () => {
    viewer.style.padding = '';
    await sleep(220);
  });

  // ---------- 7. 停在页中间时缩放 ----------
  // 页顶已经滚到视口上方：这正是「保页顶像素」会翻车的场景
  const topBefore = App.pageEl(contentAt(refY()).page).getBoundingClientRect().top;
  push('测试停在页中间（页顶在视口上方，前提）', topBefore < vRect().top - 20,
    '页顶在视口上方 ' + Math.round(vRect().top - topBefore) + 'px');
  await steady('页面停在页中间时放大，内容点仍在正中', async () => {
    App.els.zoomIn.click();
    await sleep(120);
  });
  await steady('把缩放还原后内容点仍在正中', async () => {
    App.els.scale.value = 'page-width';
    App.els.scale.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(120);
  });

  return { checks };
})();`;
