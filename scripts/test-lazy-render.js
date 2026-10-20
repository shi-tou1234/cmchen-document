'use strict';
/*
 * 懒渲染回归测试：滚轮滚动时，新进入视口的页面必须被渲染。
 * 关键设计：**只改 #viewer.scrollTop**（等价于滚轮/触控板滚动），绝不调用 scrollToPage ——
 * 因为 scrollToPage 内部会显式 renderPageNum，会掩盖观察器失效的问题。
 * 运行：& node_modules\electron\dist\electron.exe scripts\test-lazy-render.js --no-sandbox --disable-gpu
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer', 'index.html');
const PRELOAD = path.join(__dirname, '..', 'src', 'preload.js');
const SAMPLE = path.join(__dirname, '..', 'assets', 'sample.pdf');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const TEST = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  if (!App.state.pdfDoc) return { fatal: 'no doc' };
  const viewer = document.getElementById('viewer');
  const total = App.state.numPages;
  const target = Math.min(3, total);            // 滚到第 target 页
  const el = App.pageEl(target);
  const before = [];
  for (let n = 1; n <= total; n++) before.push(App.state.rendered.get(n) === true);

  // 精确滚动量：offsetTop 的参考系是最近的「定位祖先」，这里没有定位祖先，会连工具栏高度一起算进去，
  // 导致滚过头、目标页反而离开视口并被 freePage 取消渲染。必须用 rect 差值算。
  const vrect = viewer.getBoundingClientRect();
  const ereq = el.getBoundingClientRect();
  const wantTop = viewer.scrollTop + (ereq.top - vrect.top) + 4;

  viewer.scrollTop = wantTop;                    // 纯滚动，不碰 scrollToPage
  await sleep(6000);                             // 软件光栅下单页 A4@1.5x 可能就要数秒，给足时间

  const stillInView = (() => { const b = el.getBoundingClientRect(); return b.top < vrect.height - 20 && b.bottom > 20; })();

  const after = [];
  for (let n = 1; n <= total; n++) after.push(App.state.rendered.get(n) === true);
  // 该页 canvas 是否真的有像素内容（渲染完成的硬证据）
  // 注意：从未绘制过的 canvas 仍是默认 300x150 且像素全为 0（透明黑），
  // 只判 r<250 会误报「已渲染」，必须同时要求 alpha>0。
  const cv = el.querySelector('canvas');
  let painted = false;
  try {
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, Math.min(cv.height, 400)).data;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 0 && (d[i] < 250 || d[i + 1] < 250 || d[i + 2] < 250)) { painted = true; break; }
    }
  } catch (_) { painted = false; }

  return {
    total, target,
    renderedBefore: before.filter(Boolean).length,
    targetStillInView: stillInView,
    targetRenderedAfterScroll: after[target - 1] === true,
    canvasNonEmptyBitmap: cv.width > 0 && cv.height > 0,
    painted,
    pageInputValue: document.getElementById('page-input').value,
    diag: { canvasW: cv.width, canvasH: cv.height, hasPdfPage: !!el._pdfPage, scale: Math.round(App.state.scale * 100) / 100,
            renderedFlags: after, taskPending: !!el._task, scrollTop: Math.round(viewer.scrollTop) },
  };
})()`;

app.whenReady().then(async () => {
  let code = 1;
  try {
    const win = new BrowserWindow({
      show: false, width: 1000, height: 700,
      webPreferences: { nodeIntegration: false, contextIsolation: true, preload: PRELOAD },
    });
    await win.loadFile(RENDERER);
    win.webContents.send('pdf-opened', { ok: true, fileName: 'sample.pdf', data: new Uint8Array(fs.readFileSync(SAMPLE)), smoke: false });
    await wait(1200);
    const res = await win.webContents.executeJavaScript(TEST, true);
    const pass = !res.fatal && res.targetRenderedAfterScroll && res.canvasNonEmptyBitmap && res.painted;
    console.log('[lazy] ' + JSON.stringify(res));
    console.log('[lazy] ' + (pass ? 'PASS' : 'FAIL'));
    code = pass ? 0 : 2;
  } catch (e) {
    console.error('[lazy] ERROR', e && e.message ? e.message : e);
  }
  app.exit(code);
});
