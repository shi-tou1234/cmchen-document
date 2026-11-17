'use strict';
/*
 * 滚轮滚动流畅度实测（真实窗口 + 真实输入事件）。
 *
 * 为什么单独一个脚本，而不是塞进 probe-runner：
 *   1) 隐藏窗口的 rAF 会被降频到 ~1Hz，测不出「一卡一卡」；
 *   2) 合成 WheelEvent 不会触发原生滚动，只有 webContents.sendInputEvent 走真实输入管线。
 * 所以这里自己建窗口、自己发滚轮事件，只做测量不做断言（阈值给参考线，人工判读）。
 *
 * 输出：帧间隔分布 + 长帧计数 + 滚动期间发生的页渲染次数。
 * 运行：& node_modules\electron\dist\electron.exe scripts\perf-scroll.js --no-sandbox
 * 可选环境变量：PERF_PAGES（默认 40）、PERF_TICKS（默认 90）、PERF_HIDDEN=1（不显示窗口）
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PAGES = Number(process.env.PERF_PAGES || 40);
const TICKS = Number(process.env.PERF_TICKS || 90);
const RENDERER = path.join(__dirname, '..', 'src', 'renderer', 'index.html');
const PRELOAD = path.join(__dirname, '..', 'src', 'preload.js');
const OUT_PDF = path.join(os.tmpdir(), 'trove-perf-scroll-' + (process.env.PERF_HEAVY === '1' ? 'heavy-' : '') + PAGES + '.pdf');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function makePdf() {
  if (fs.existsSync(OUT_PDF)) return fs.readFileSync(OUT_PDF);
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  // HEAVY=1：每页加 700 条矢量线 + 60 行文字，模拟图表/公式密集的论文页。
  // 单页光栅成本进到几十毫秒量级，「滚动时同步渲染」造成的卡顿才测得出来。
  const HEAVY = process.env.PERF_HEAVY === '1';
  for (let i = 0; i < PAGES; i++) {
    const page = doc.addPage([595, 842]);
    page.drawText('Page ' + (i + 1) + ' of ' + PAGES, { x: 50, y: 780, size: 20, font });
    const lines = HEAVY ? 120 : 30;
    for (let l = 0; l < lines; l++) {
      page.drawText('Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.', {
        x: 50, y: 740 - l * 11, size: 7, font, color: rgb(0.15, 0.15, 0.15),
      });
    }
    for (let g = 0; g < (HEAVY ? 3000 : 12); g++) {
      const x = 40 + (g % 40) * 12, y = 40 + Math.floor(g / 40) * 8;
      page.drawLine({
        start: { x, y }, end: { x: x + 18, y: y + (g % 7) },
        thickness: 0.8, color: rgb(0.1, 0.4, 0.9),
      });
    }
  }
  const bytes = Buffer.from(await doc.save());
  fs.writeFileSync(OUT_PDF, bytes);
  return bytes;
}

// 渲染进程内的记录器：装一次，之后 start/stop 取数
const RECORDER = `(() => {
  if (window.__perfRec) return 'already';
  const state = { on: false, gaps: [], renders: 0, last: 0, prevScroll: 0, ticks: [] };
  // 统计「滚动期间发生了多少次页渲染」：包一层 canvas 尺寸变化+render 调用太重，
  // 改用 MutationObserver 观察 canvas 宽度属性变化——每完成一次渲染必然设一次 width。
  const patch = () => {
    const proto = HTMLCanvasElement.prototype;
    if (proto.__perfPatched) return;
    proto.__perfPatched = true;
    const d = Object.getOwnPropertyDescriptor(proto, 'width');
    Object.defineProperty(proto, 'width', {
      get() { return d.get.call(this); },
      set(v) { if (window.__perfRec && window.__perfRec.on && v > 100) window.__perfRec.renders++; d.set.call(this, v); },
    });
  };
  const tick = (t) => {
    const s = window.__perfRec;
    if (!s.on) return;
    if (s.last) {
      const dt = t - s.last;
      s.gaps.push(Math.round(dt * 10) / 10);
    }
    s.last = t;
    const v = App.els.viewer;
    s.ticks.push({ t: Math.round(t), top: Math.round(v.scrollTop) });
    requestAnimationFrame(tick);
  };
  window.__perfRec = Object.assign(state, {
    start() { this.gaps = []; this.ticks = []; this.renders = 0; this.last = 0; this.on = true; patch(); requestAnimationFrame(tick); return true; },
    stop() {
      this.on = false;
      const g = this.gaps.slice().sort((a, b) => a - b);
      const q = (f) => (g.length ? g[Math.min(g.length - 1, Math.floor(g.length * f))] : -1);
      const v = App.els.viewer;
      const long = (ms) => g.filter((x) => x > ms).length;
      return {
        frames: g.length, p50: q(0.5), p90: q(0.9), p95: q(0.95), max: q(1),
        over8: long(8), over10: long(10), over16: long(16), over32: long(32), over50: long(50),
        rendersDuringScroll: this.renders,
        scrollTop: Math.round(v.scrollTop),
        scaleToPageBox: App.state.scale,
      };
    },
  });
  return 'ok';
})()`;

app.whenReady().then(async () => {
  let code = 1;
  try {
    const bytes = await makePdf();
    const win = new BrowserWindow({
      show: !process.env.PERF_HIDDEN,
      width: 1240, height: 820,
      webPreferences: { nodeIntegration: false, contextIsolation: true, preload: PRELOAD, backgroundThrottling: false },
    });
    await win.loadFile(RENDERER);
    win.webContents.send('pdf-opened', { ok: true, fileName: 'perf-scroll.pdf', data: new Uint8Array(bytes), smoke: false });

    // 等首页画出来
    for (let i = 0; i < 400; i++) {
      const ok = await win.webContents.executeJavaScript('!!(window.App && App.state.pdfDoc && App.state.rendered.get(1))');
      if (ok) break;
      await wait(100);
    }
    await win.webContents.executeJavaScript('App.els.viewer.scrollTop = 0; 1');
    await wait(400);
    await win.webContents.executeJavaScript(RECORDER);
    await win.webContents.executeJavaScript('window.__perfRec.start()');

    const box = win.getContentBounds();
    const x = Math.round(box.width / 2), y = Math.round(box.height / 2);
    // 90 次滚轮 ≈ 1.5 秒的连续滚动，节奏贴近真实鼠标
    for (let i = 0; i < TICKS; i++) {
      win.webContents.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: 0, deltaY: -120, canScroll: true });
      await wait(16);
    }
    await wait(300);
    const res = await win.webContents.executeJavaScript('window.__perfRec.stop()');
    console.log('[perf-scroll] ' + JSON.stringify(res));
    const bad = res.over50 > Math.max(3, Math.round(res.frames * 0.1));
    console.log('[perf-scroll] ' + (bad ? 'REVIEW（长帧偏多）' : 'OK') + '  长帧>50ms: ' + res.over50 + '/' + res.frames
      + '  滚动期间渲染次数: ' + res.rendersDuringScroll);
    code = 0;
  } catch (e) {
    console.error('[perf-scroll] ERROR', e && e.stack ? e.stack : e);
  }
  app.exit(code);
});
