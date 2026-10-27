'use strict';
/*
 * v34 阅读器探针：页面旋转（90/180/270）+ 只读分屏参考视图。
 * 重点不是「按钮存在」，而是三件容易做错的事：
 *   1. 旋转后页面外框宽高互换，但标注仍按未旋转坐标存；
 *   2. 客户端坐标 ↔ 单位坐标的换算带上旋转（选区、放大锚点、图片灯箱都靠它）；
 *   3. 分屏是独立渲染的只读页，能自己翻页、跟随正文，并且跟着旋转。
 * 被 test-reader-rotate-split.js 调用。
 */
module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 8000)) { if (fn()) return true; await sleep(80); } return !!fn(); };
  const near = (a, b, t) => Math.abs(a - b) <= (t == null ? 2 : t);

  try {
    // 0. 界面入口
    push('工具栏有逆时针旋转按钮', !!$('#btn-rotate-left'));
    push('工具栏有顺时针旋转按钮', !!$('#btn-rotate-right'));
    push('工具栏有分屏按钮', !!$('#btn-split'));
    push('分屏面板默认隐藏', $('#ref-pane').hidden);
    push('设置面板有分屏开关', !!$('#set-split-view'));
    push('暴露旋转与分屏接口', typeof App.rotateView === 'function' && typeof App.setSplitView === 'function');
    // 没有文档时也能先记下分屏偏好，但面板不显示
    App.setSplitView(true);
    push('无文档时可记住分屏偏好', App.state.split === true && $('#ref-pane').hidden,
      App.state.split + '/' + $('#ref-pane').hidden);
    App.setSplitView(false);

    // 1. 打开示例 PDF
    await waitFor(() => window.LibraryUI && LibraryUI.isOpen(), 10000);
    const add = await pdfBridge.lib.addPdf('__SAMPLE__', { dedupe: true });
    const res = await pdfBridge.lib.openItem(add.item.key, 1);
    LibraryUI.hide();
    window.__libOpen(res);
    const loaded = await waitFor(() => App.state.pdfDoc && App.state.rendered.get(1), 25000);
    push('示例 PDF 加载到第 1 页', loaded);
    if (!loaded) return { checks, stage: 'load' };
    await waitFor(() => $('#page-1 .textlayer span'), 8000);

    const p1 = document.getElementById('page-1');
    const u = p1._unit;
    const rotEl = p1.querySelector('.page-rot');
    push('页面有独立旋转层', !!rotEl);
    push('初始旋转为 0', App.viewRotation() === 0, App.viewRotation());
    push('初始旋转层为 0°', /rotate\\(0deg\\)/.test(rotEl.style.transform || ''), rotEl.style.transform);

    // 2. 顺时针 90°
    const r1 = App.rotateView(90);
    await sleep(250);
    const s2 = App.state.scale;
    push('旋转状态为 90°', r1 === 90 && App.viewRotation() === 90, r1);
    push('页面外框宽高互换', near(p1.clientWidth, u.h * s2, 2) && near(p1.clientHeight, u.w * s2, 2),
      p1.clientWidth + 'x' + p1.clientHeight + ' 期望 ' + Math.round(u.h * s2) + 'x' + Math.round(u.w * s2));
    push('旋转层保持未旋转尺寸', near(rotEl.clientWidth, u.w * s2, 2) && near(rotEl.clientHeight, u.h * s2, 2),
      rotEl.clientWidth + 'x' + rotEl.clientHeight);
    push('旋转层 transform 为 rotate(90deg)', /rotate\\(90deg\\)/.test(rotEl.style.transform || ''), rotEl.style.transform);

    const svg = p1.querySelector('.anno');
    const ctm = svg.getScreenCTM();
    const rect = p1.getBoundingClientRect();
    const origin = new DOMPoint(0, 0).matrixTransform(ctm);
    push('90° 时单位原点落在页面右上角', near(origin.x, rect.right, 2) && near(origin.y, rect.top, 2),
      Math.round(origin.x) + ',' + Math.round(origin.y) + ' 期望 ' + Math.round(rect.right) + ',' + Math.round(rect.top));
    const back = App.clientToUnit(p1, origin.x - 2, origin.y + 2);
    push('客户端坐标回算单位坐标（含旋转）', near(back.x, 0, 2) && near(back.y, 0, 2), JSON.stringify(back));
    const sampleOk = [[0, 0], [u.w / 2, u.h / 3], [u.w, u.h]].every(([x, y]) => {
      const q = new DOMPoint(x, y).matrixTransform(ctm);
      const off = App.unitToSlotOffset(p1, x, y);
      const rr = p1.getBoundingClientRect();
      return near(rr.left + off.x, q.x, 1.5) && near(rr.top + off.y, q.y, 1.5);
    });
    push('槽内偏移公式与 CTM 一致（搜索命中定位用）', sampleOk);

    // 页面 PNG 是视图导出：90° 时输出宽高应与画布互换
    const pngUrl = App.pagePngDataUrl();
    const pngBin = atob((pngUrl.split(',')[1] || ''));
    const pw = ((pngBin.charCodeAt(16) << 24) | (pngBin.charCodeAt(17) << 16) | (pngBin.charCodeAt(18) << 8) | pngBin.charCodeAt(19)) >>> 0;
    const ph = ((pngBin.charCodeAt(20) << 24) | (pngBin.charCodeAt(21) << 16) | (pngBin.charCodeAt(22) << 8) | pngBin.charCodeAt(23)) >>> 0;
    const cv0 = p1.querySelector('canvas');
    push('页面 PNG 按旋转方向输出', pw === cv0.height && ph === cv0.width,
      pw + 'x' + ph + ' vs 画布 ' + cv0.width + 'x' + cv0.height);

    // 3. 旋转后的文字选区仍落在未旋转页面坐标内
    const span = p1.querySelector('.textlayer span');
    let selOk = false, selDetail = '没有文本层 span';
    if (span && span.firstChild) {
      const range = document.createRange();
      range.selectNodeContents(span);
      const groups = SelectionUI._rectsForRange(range);
      const arr = groups.get(1) || [];
      selOk = arr.length > 0 && arr.every((q) => q.x >= -0.6 && q.y >= -0.6 && q.x + q.w <= u.w + 1 && q.y + q.h <= u.h + 1);
      selDetail = JSON.stringify(arr.slice(0, 2)) + ' 页面 ' + u.w + 'x' + u.h;
    }
    push('旋转后选区落在页面坐标范围内', selOk, selDetail);
    if (selOk) {
      // 反投影：把合并后的单位矩形映射回屏幕，应与原文字框重合（证明高亮会贴在竖排文字上）
      const r2 = document.createRange();
      r2.selectNodeContents(span);
      const arr = SelectionUI._rectsForRange(r2).get(1) || [];
      const x0 = Math.min.apply(null, arr.map((q) => q.x));
      const y0 = Math.min.apply(null, arr.map((q) => q.y));
      const x1 = Math.max.apply(null, arr.map((q) => q.x + q.w));
      const y1 = Math.max.apply(null, arr.map((q) => q.y + q.h));
      const m = svg.getScreenCTM();
      const corners = [
        new DOMPoint(x0, y0).matrixTransform(m), new DOMPoint(x1, y0).matrixTransform(m),
        new DOMPoint(x1, y1).matrixTransform(m), new DOMPoint(x0, y1).matrixTransform(m),
      ];
      const bx0 = Math.min.apply(null, corners.map((p) => p.x));
      const by0 = Math.min.apply(null, corners.map((p) => p.y));
      const bx1 = Math.max.apply(null, corners.map((p) => p.x));
      const by1 = Math.max.apply(null, corners.map((p) => p.y));
      const cr = r2.getBoundingClientRect();
      push('选区反投影与原文字框重合',
        near(bx0, cr.left, 2.5) && near(by0, cr.top, 2.5) && near(bx1, cr.right, 2.5) && near(by1, cr.bottom, 2.5),
        [bx0, by0, bx1, by1].map((v) => v.toFixed(1)).join(',') + ' vs ' +
        [cr.left, cr.top, cr.right, cr.bottom].map((v) => v.toFixed(1)).join(','));
    }

    // 4. 旋转状态下标注仍可写入、且数据坐标不随旋转改变
    const sh = Anno.addShape(1, { tool: 'rect', color: '#e53935', width: 3, a: { x: 100, y: 100 }, b: { x: 200, y: 160 } });
    await sleep(120);
    const rectNode = p1.querySelector('.anno rect');
    push('旋转后仍能写入标注', !!sh && !!rectNode, rectNode && rectNode.getAttribute('x'));
    App.rotateView(90);   // 180°
    await sleep(200);
    const rectNode2 = p1.querySelector('.anno rect');
    push('旋转到 180° 后标注仍在', !!rectNode2);
    push('标注数据坐标不随旋转改变', !!rectNode2 && rectNode2.getAttribute('x') === '100' && rectNode2.getAttribute('width') === '100',
      rectNode2 && rectNode2.getAttribute('x') + '/' + rectNode2.getAttribute('width'));
    const rect2 = p1.getBoundingClientRect();
    const origin2 = new DOMPoint(0, 0).matrixTransform(svg.getScreenCTM());
    push('180° 时单位原点落在页面右下角', near(origin2.x, rect2.right, 2) && near(origin2.y, rect2.bottom, 2),
      Math.round(origin2.x) + ',' + Math.round(origin2.y) + ' 期望 ' + Math.round(rect2.right) + ',' + Math.round(rect2.bottom));

    // 5. 旋转状态下用真实指针事件画一笔：落点必须换算回未旋转坐标
    Anno.setTool('rect');
    const ctmNow = svg.getScreenCTM();
    const scr = (x, y) => { const p = new DOMPoint(x, y).matrixTransform(ctmNow); return { clientX: p.x, clientY: p.y }; };
    const pa = scr(300, 400), pb = scr(380, 460);
    svg.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ bubbles: true, button: 0, pointerId: 7 }, pa)));
    window.dispatchEvent(new PointerEvent('pointermove', Object.assign({ bubbles: true, pointerId: 7 }, pb)));
    window.dispatchEvent(new PointerEvent('pointerup', Object.assign({ bubbles: true, pointerId: 7 }, pb)));
    await sleep(200);
    const shapes = App.state.annos.get(1) || [];
    const drawn = shapes[shapes.length - 1];
    push('旋转状态下画笔落点换算正确',
      !!drawn && near(drawn.a.x, 300, 2) && near(drawn.a.y, 400, 2) && near(drawn.b.x, 380, 2) && near(drawn.b.y, 460, 2),
      drawn ? JSON.stringify({ a: drawn.a, b: drawn.b }) : '没有新标注');
    Anno.setTool('select');

    // 5. 分屏
    const curPage = App.state.currentPage;
    App.setSplitView(true);
    const shown = await waitFor(() => !$('#ref-pane').hidden, 3000);
    push('分屏面板显示', shown);
    push('正文区标记分屏状态', document.body.classList.contains('split-view'));
    const refDrawn = await waitFor(() => { const c = $('#ref-canvas'); return c && !c.hidden && c.width > 10; }, 12000);
    push('参考页渲染出画布', refDrawn);
    push('参考页默认等于正文当前页', App.splitState().page === curPage, App.splitState().page + ' vs ' + curPage);

    const pageBefore = App.splitState().page;
    $('#ref-next').click();
    const nextOk = await waitFor(() => App.splitState().page === Math.min(App.state.numPages, pageBefore + 1), 5000);
    await sleep(400);
    push('参考视图可独立翻页', nextOk, App.splitState().page);
    push('翻页后参考画布仍有效', $('#ref-canvas').width > 10, $('#ref-canvas').width);

    // 6. 旋转 270°：参考视图要跟着转（页面变成横向）
    App.rotateView(90);   // 90 -> 180 -> 270
    await sleep(700);
    const cv = $('#ref-canvas');
    const ratio = cv.width / cv.height;
    push('参考视图跟随视图旋转（90/270 时横向）', ratio > 1.15, ratio.toFixed(2));

    // 7. 跟随模式：参考页 = 正文下一页
    $('#ref-follow').checked = true;
    $('#ref-follow').dispatchEvent(new Event('change'));
    await sleep(700);
    push('跟随模式参考页为正文下一页',
      App.splitState().page === Math.min(App.state.numPages, App.state.currentPage + 1),
      App.splitState().page + ' 正文 ' + App.state.currentPage);

    // 8. 关闭分屏
    App.setSplitView(false);
    await sleep(150);
    push('关闭分屏后面板隐藏', $('#ref-pane').hidden);
    push('关闭分屏后正文标记移除', !document.body.classList.contains('split-view'));
    const rotNow = App.viewRotation();
    const baseW = rotNow % 180 ? u.h : u.w;   // 90/270 时「适应宽度」对应的是页面高度
    push('关闭分屏后缩放回到正文宽度', App.state.scale > 0 && Math.abs(App.state.scale - (App.els.viewer.clientWidth - 32) / baseW) < 0.02,
      App.state.scale.toFixed(3));

    // 9. 第二个标签：旋转各自独立，切回来要恢复
    const add2 = await pdfBridge.lib.addPdf('__SAMPLE2__', { dedupe: true });
    const res2 = await pdfBridge.lib.openItem(add2.item.key, 1);
    window.__libOpen(res2);
    const loaded2 = await waitFor(() => /sample2/.test(App.state.filePath || '') && App.state.rendered.get(1), 25000);
    push('第二个文档打开', loaded2, App.state.filePath);
    if (loaded2) {
      push('新标签从 0° 开始', App.viewRotation() === 0, App.viewRotation());
      App.rotateView(90);
      await sleep(200);
      const tab1 = App.tabs.find((t) => /sample\\.pdf$/.test(t.filePath || ''));
      await App.switchTab(tab1.id);
      const restored = await waitFor(() => App.viewRotation() === 270, 8000);
      push('切回标签恢复各自旋转角', restored, App.viewRotation());
    }

    // 10. 会话落盘带上旋转与参考页
    await sleep(1200);
    const sess = await pdfBridge.getSession();
    const rec = sess && sess.tabs ? sess.tabs.find((t) => /sample\\.pdf$/.test(String(t.path || '').replace(/\\\\/g, '/'))) : null;
    push('会话记录旋转角', rec && rec.rotation === 270, rec && rec.rotation);
    push('会话记录参考页', rec && rec.refPage >= 1, rec && rec.refPage);

    // 11. 单页模式与「适应页面」也要按旋转后的外框算
    App.setViewMode('page');
    await sleep(150);
    App.rotateView(90);   // 270 -> 0
    await sleep(150);
    const p1b = document.getElementById('page-1');
    const p2b = document.getElementById('page-2');
    push('单页模式只显示当前页',
      getComputedStyle(p1b).display !== 'none' && getComputedStyle(p2b).display === 'none',
      getComputedStyle(p1b).display + '/' + getComputedStyle(p2b).display);
    App.els.scale.value = 'page-fit';
    App.els.scale.dispatchEvent(new Event('change'));
    await sleep(150);
    const availW = App.els.viewer.clientWidth - 32, availH = App.els.viewer.clientHeight - 32;
    push('0° 适应页面按原尺寸计算',
      Math.abs(App.state.scale - Math.min(availW / u.w, availH / u.h)) < 0.02,
      App.state.scale.toFixed(3));
    App.rotateView(90);   // 90
    await sleep(200);
    push('90° 适应页面按互换后的尺寸计算',
      Math.abs(App.state.scale - Math.min(availW / u.h, availH / u.w)) < 0.02,
      App.state.scale.toFixed(3));
    App.setViewMode('scroll');
    App.els.scale.value = 'page-width';
    App.els.scale.dispatchEvent(new Event('change'));
    App.rotateView(90);
    App.rotateView(90);
    await sleep(200);
    push('收尾旋转回到 270°', App.viewRotation() === 270, App.viewRotation());

    // 12. 连续缩放时缩放下拉框不能把工具栏挤成两行（会连带把阅读区推下去，锚点纵向漂移）
    const tb0 = $('#toolbar').getBoundingClientRect().height;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', bubbles: true }));
    const pz = document.getElementById('page-1').getBoundingClientRect();
    const px = Math.round(pz.left + pz.width / 2), py = Math.round(Math.max(10, pz.top + 60));
    (document.elementFromPoint(px, py) || document.getElementById('page-1'))
      .dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -240, deltaMode: 0, clientX: px, clientY: py }));
    await sleep(400);
    const tb1 = $('#toolbar').getBoundingClientRect().height;
    push('连续缩放后工具栏仍是一行', tb1 < tb0 + 5, tb0.toFixed(1) + ' -> ' + tb1.toFixed(1));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', bubbles: true }));

    return { checks };
  } catch (e) {
    return { checks, fatal: String((e && e.stack) || e) };
  }
})()`;
