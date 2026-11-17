'use strict';
/*
 * 窗口尺寸变化时的阅读位置稳定性（独立 Electron 脚本）。
 *
 * 为什么必须独立跑：要真的去 maximize() / setSize()，渲染进程做不到，探针框架也不行。
 * 这条路径上有个只有真实窗口才暴露的坑：ResizeObserver 的回调是在 viewer 已经变大之后
 * 才到的，而页面还是旧尺寸 —— 拿新视口高度去算「视线中心」，锚到的就不是刚才看的那一点。
 *
 * 覆盖：最大化 / 还原 / 拖窄 / 拉宽 四种，以及「窗口最大化后不再自己反复重排」。
 * 运行：node_modules\electron\dist\electron.exe scripts/test-window-resize-anchor.js --no-sandbox
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'src', 'renderer', 'index.html');
const PRELOAD = path.join(ROOT, 'src', 'preload.js');
const FIXTURE = path.join(os.tmpdir(), 'trove-resize-anchor-6.pdf');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function makePdf() {
  if (fs.existsSync(FIXTURE)) return fs.readFileSync(FIXTURE);
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 6; i++) {
    const page = doc.addPage([595, 842]);
    page.drawText('Page ' + (i + 1) + ' / 6', { x: 50, y: 780, size: 20, font });
    for (let l = 0; l < 28; l++) {
      page.drawText('Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.', {
        x: 50, y: 730 - l * 23, size: 11, font, color: rgb(0.15, 0.15, 0.15),
      });
    }
  }
  const bytes = Buffer.from(await doc.save());
  fs.writeFileSync(FIXTURE, bytes);
  return bytes;
}

// 渲染进程里：只在同一个位置反复量「视线中心那一点现在在哪」
const INSTALL = `(() => {
  window.__anchorMark = () => {
    const v = App.els.viewer, vr = v.getBoundingClientRect();
    const y = Math.round(vr.top + vr.height * 0.5);
    for (let n = 1; n <= App.state.numPages; n++) {
      const el = App.pageEl(n);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.height > 4 && y >= r.top && y <= r.bottom) {
        window.__a = { page: n, frac: (y - r.top) / r.height };
        return { ok: true, page: n, frac: window.__a.frac };
      }
    }
    window.__a = null;
    return { ok: false };
  };
  window.__anchorDrift = () => {
    const a = window.__a;
    if (!a) return { ok: false };
    const v = App.els.viewer, vr = v.getBoundingClientRect();
    const el = App.pageEl(a.page);
    if (!el) return { ok: false };
    const r = el.getBoundingClientRect();
    if (!(r.height > 0)) return { ok: false };
    const now = r.top + a.frac * r.height;
    const want = vr.top + vr.height * 0.5;
    return { ok: true, drift: Math.abs(now - want), pageH: r.height, scale: App.state.scale };
  };
  return 'ok';
})()`;

app.whenReady().then(async () => {
  let code = 1;
  try {
    const bytes = await makePdf();
    const win = new BrowserWindow({
      show: true, width: 1000, height: 700,
      webPreferences: { nodeIntegration: false, contextIsolation: true, preload: PRELOAD, backgroundThrottling: false },
    });
    await win.loadFile(RENDERER);
    win.webContents.send('pdf-opened', { ok: true, fileName: 'resize-anchor.pdf', data: new Uint8Array(bytes), smoke: false });
    for (let i = 0; i < 300; i++) {
      if (await win.webContents.executeJavaScript('!!(window.App && App.state.pdfDoc && App.state.rendered.get(1))')) break;
      await wait(100);
    }
    await wait(500);
    await win.webContents.executeJavaScript(INSTALL);
    // 停在页中间：页顶滚到视口上方，锚点必须按页内比例、而不是页顶像素
    await win.webContents.executeJavaScript('App.scrollToPage(3, true); App.els.viewer.scrollTop += 150; 1');
    await wait(400);

    const checks = [];
    const mark = async () => {
      const r = await win.webContents.executeJavaScript('JSON.stringify(window.__anchorMark())');
      return JSON.parse(r);
    };
    const driftNow = async () => {
      const r = await win.webContents.executeJavaScript('JSON.stringify(window.__anchorDrift())');
      return JSON.parse(r);
    };
    const step = async (label, act, settle) => {
      const m = await mark();
      if (!m.ok) { checks.push([label + '（前提：视口中心压在某页上）', false, 'no anchor']); return; }
      await act();
      await wait(settle || 900);
      const d = await driftNow();
      if (!d.ok) { checks.push([label, false, 'anchor lost']); return; }
      // 容差：页高的 0.8%（约半行字）—— 取整与页间距的误差在这个量级，
      // 而「页面跳走」的漂移动辄是页高的 10%~30%，两者区分得很清楚。
      const tol = Math.max(6, d.pageH * 0.008);
      checks.push([label + '（漂移 ≤ ' + Math.round(tol) + 'px）', d.drift <= tol,
        '漂移 ' + d.drift.toFixed(1) + 'px / 页高 ' + Math.round(d.pageH) + 'px / 缩放 ' + Math.round(d.scale * 100) + '%']);
    };

    await step('最大化窗口后阅读位置不变', async () => { win.maximize(); });
    await step('还原窗口后阅读位置不变', async () => { win.unmaximize(); });
    await step('把窗口拖窄后阅读位置不变', async () => { win.setSize(720, 700); });
    await step('把窗口拉宽后阅读位置不变', async () => { win.setSize(1400, 900); });
    // 连续拖动（快速变化，中间会被 200ms 静默期挡住几次）——最常见的真实操作
    await step('连续拖动窗口边缘后阅读位置不变', async () => {
      for (const w of [980, 1120, 880, 1240, 1060, 1180]) { win.setSize(w, 760); await wait(60); }
    }, 1400);

    // 尺寸稳定后，「适应宽度」必须真的贴合当前宽度（不能停在旧缩放上）
    const fit = JSON.parse(await win.webContents.executeJavaScript(`(() => {
      const v = App.els.viewer, p = App.pageEl(1), pr = p.getBoundingClientRect();
      return JSON.stringify({ cw: v.clientWidth, pw: pr.width, want: v.clientWidth - 32 });
    })()`));
    checks.push(['停手后「适应宽度」贴合当前窗口宽', Math.abs(fit.pw - fit.want) <= 2,
      '页宽 ' + Math.round(fit.pw) + ' vs 期望 ' + Math.round(fit.want)]);

    // 反复重排的自激检测：稳定后一秒内不该再有比例变化
    const s1 = await win.webContents.executeJavaScript('App.state.scale');
    await wait(1000);
    const s2 = await win.webContents.executeJavaScript('App.state.scale');
    checks.push(['窗口尺寸稳定后不再自动反复重排', Math.abs(s1 - s2) < 1e-6, s1 + ' -> ' + s2]);

    let fail = 0;
    for (const [name, okFlag, detail] of checks) {
      if (!okFlag) { fail++; console.log('  FAIL ' + name + (detail ? '  <- ' + detail : '')); }
      else console.log('  ok   ' + name);
    }
    console.log('[resize-anchor] ' + (fail ? 'FAIL (' + fail + '/' + checks.length + ')' : 'PASS (' + checks.length + ')'));
    code = fail ? 2 : 0;
  } catch (e) {
    console.error('[resize-anchor] ERROR', e && e.stack ? e.stack : e);
  }
  app.exit(code);
});
