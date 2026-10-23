'use strict';
/*
 * 放大模式探针（渲染进程内断言）。
 * 覆盖：Z 进入 / 滚轮连续缩放锚点不动 / 上下限 / 空格+左键拖动平移 / Z 与 Esc 退出。
 */
module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 10000)) { if (fn()) return true; await sleep(60); }
    return !!fn();
  };
  const key = (type, k) => document.dispatchEvent(new KeyboardEvent(type, { key: k, bubbles: true, cancelable: true }));
  const fire = (target, type, init) => {
    if (!target) return false;
    target.dispatchEvent(new MouseEvent(type, Object.assign({
      bubbles: true, cancelable: true, view: window,
    }, init)));
    return true;
  };
  const wheel = (dy, x, y) => {
    const t = document.elementFromPoint(x, y);
    if (!t) return;
    t.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true, cancelable: true, deltaY: dy, deltaMode: 0, clientX: x, clientY: y,
    }));
  };

  const ready = await waitFor(() => window.App && App.state.pdfDoc && App.state.rendered.get(1)
    && App.els && App.els.viewer, 20000);
  push('文档已打开且首页已渲染（探针前提）', ready);

  const viewer = App.els.viewer;
  const page1 = App.pageEl(1);
  push('拿到首页元素（探针前提）', !!page1);

  const baseScale = App.state.scale;
  const r0 = page1.getBoundingClientRect();
  const vr = viewer.getBoundingClientRect();
  const x = Math.round(r0.left + r0.width * 0.5);
  const y = Math.round(Math.min(r0.top + Math.min(150, r0.height * 0.35), vr.bottom - 20));
  const ux = (x - r0.left) / (baseScale || 1);
  const uy = (y - r0.top) / (baseScale || 1);
  const anchorNow = () => {
    const el = App.pageEl(1);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const s = App.state.scale || 1;
    return { x: r.left + ux * s, y: r.top + uy * s };
  };
  const near = (a, b, tol) => Math.abs(a - b) <= (tol == null ? 5 : tol);

  // ---------- 1. Z 进入放大模式 ----------
  push('初始不在放大模式', App.zoomModeState().on === false);
  key('keydown', 'z');
  await sleep(80);
  push('按 Z 进入放大模式', App.zoomModeState().on === true, JSON.stringify(App.zoomModeState()));
  push('进入后 body 有放大标记', document.body.classList.contains('zoom-mode'));
  push('进入时不动缩放（等你滚）', Math.abs(App.state.scale - baseScale) < 0.02, baseScale + ' -> ' + App.state.scale);

  // ---------- 2. 滚轮 = 连续缩放，锚点不动 ----------
  wheel(-240, x, y);
  await sleep(180);
  const s1 = App.state.scale;
  push('放大模式下滚轮向上放大', s1 > baseScale * 1.05, baseScale + ' -> ' + s1);
  let a = anchorNow();
  push('放大后光标下那一点没跑（横向）', near(a.x, x), a.x + ' vs ' + x);
  push('放大后光标下那一点没跑（纵向）', near(a.y, y), a.y + ' vs ' + y);

  wheel(-240, x, y);
  await sleep(180);
  const s2 = App.state.scale;
  push('继续滚继续放大（连续，不是跳固定档）', s2 > s1 * 1.05 && s2 < s1 * 2.2, s1 + ' -> ' + s2);
  a = anchorNow();
  push('连续放大时锚点始终不动（横向）', near(a.x, x), a.x + ' vs ' + x);
  push('连续放大时锚点始终不动（纵向）', near(a.y, y), a.y + ' vs ' + y);

  // 换个位置滚：锚点应该跟着新光标
  const x3 = x + 60, y3 = y + 40;
  const rb = page1.getBoundingClientRect();
  const uew = (x3 - rb.left) / (App.state.scale || 1);
  const ueh = (y3 - rb.top) / (App.state.scale || 1);
  wheel(-120, x3, y3);
  await sleep(180);
  const r3 = App.pageEl(1).getBoundingClientRect();
  const sc3 = App.state.scale || 1;
  push('换个位置滚，锚点跟着新光标（横向）', near(r3.left + uew * sc3, x3, 7),
    (r3.left + uew * sc3) + ' vs ' + x3);
  push('换个位置滚，锚点跟着新光标（纵向）', near(r3.top + ueh * sc3, y3, 7),
    (r3.top + ueh * sc3) + ' vs ' + y3);

  // ---------- 3. 上下限 ----------
  for (let i = 0; i < 30; i++) wheel(-240, x3, y3);
  await sleep(320);
  push('放大有上限 600%', App.state.scale <= 6.001, 'scale=' + App.state.scale);
  for (let i = 0; i < 70; i++) wheel(240, x3, y3);
  await sleep(450);
  push('缩小有下限 20%', App.state.scale >= 0.199, 'scale=' + App.state.scale);

  // ---------- 4. 空格 + 左键拖动 = 平移 ----------
  wheel(-600, x, y);
  await sleep(260);
  const scaleBeforePan = App.state.scale;
  const topBefore = viewer.scrollTop;
  const leftBefore = viewer.scrollLeft;
  key('keydown', ' ');
  await sleep(50);
  push('放大模式下空格标记已置位', App.zoomModeState().space === true);
  const panTarget = document.elementFromPoint(x, y) || page1;
  fire(panTarget, 'mousedown', { button: 0, buttons: 1, clientX: x, clientY: y });
  await sleep(40);
  push('空格+左键进入平移', App.zoomModeState().panning === true);
  fire(panTarget, 'mousemove', { button: 0, buttons: 1, clientX: x - 50, clientY: y - 35 });
  await sleep(60);
  push('拖动平移了滚动条', viewer.scrollTop !== topBefore || viewer.scrollLeft !== leftBefore,
    topBefore + ',' + leftBefore + ' -> ' + viewer.scrollTop + ',' + viewer.scrollLeft);
  fire(panTarget, 'mouseup', { button: 0, buttons: 0, clientX: x - 50, clientY: y - 35 });
  key('keyup', ' ');
  await sleep(60);
  push('松手退出平移', App.zoomModeState().panning === false);
  push('平移不改缩放', Math.abs(App.state.scale - scaleBeforePan) < 0.02,
    scaleBeforePan + ' -> ' + App.state.scale);

  // ---------- 5. 退出 ----------
  key('keydown', 'z');
  await sleep(80);
  push('再按 Z 退出放大模式', App.zoomModeState().on === false);
  push('退出后 body 标记清掉', !document.body.classList.contains('zoom-mode'));

  key('keydown', 'z');
  await sleep(80);
  key('keydown', 'Escape');
  await sleep(80);
  push('Esc 也能退出放大模式', App.zoomModeState().on === false);

  const scaleAfterExit = App.state.scale;
  wheel(-240, x, y);
  await sleep(180);
  push('退出后滚轮不再改缩放', Math.abs(App.state.scale - scaleAfterExit) < 0.02,
    scaleAfterExit + ' -> ' + App.state.scale);

  return { checks };
})();`;
