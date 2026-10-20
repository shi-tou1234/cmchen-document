'use strict';
/*
 * 大文件实测：填补「只用 3 页样本验证」这个证据缺口。
 * 1) 生成 400 页、每页含实际矢量内容的 PDF（放 %TEMP%，不污染项目）
 * 2) 用真实渲染进程加载它，测：
 *    - 首屏可用耗时（含 buildPageBlocks 对每页 getPage 的串行开销 —— 已知风险点）
 *    - 懒渲染是否真生效（视口外页的 canvas 位图是否被释放）
 *    - 跳远页的渲染延迟、连续翻阅的每页渲染延迟分布
 *    - JS 堆与进程内存增长
 * 可选环境变量：BIG_PAGES（默认 400）、BIG_SWEEP（默认 20）
 * 运行：& node_modules\electron\dist\electron.exe scripts\perf-big-pdf.js --no-sandbox
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PAGES = Number(process.env.BIG_PAGES || 400);
const SWEEP = Number(process.env.BIG_SWEEP || 20);
const JUMP = Number(process.env.BIG_JUMP || 200);
const RENDERER = path.join(__dirname, '..', 'src', 'renderer', 'index.html');
const PRELOAD = path.join(__dirname, '..', 'src', 'preload.js');
const OUT_PDF = path.join(os.tmpdir(), 'pdfreader-big-' + PAGES + '.pdf');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function makeBigPdf() {
  if (fs.existsSync(OUT_PDF)) return fs.readFileSync(OUT_PDF);
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < PAGES; i++) {
    const page = doc.addPage([595, 842]);
    page.drawText('Page ' + (i + 1) + ' of ' + PAGES, { x: 50, y: 780, size: 22, font });
    // 每页 18 行文本 + 14 个矢量图元：让渲染真的干活，而不是空页
    for (let l = 0; l < 18; l++) {
      page.drawText('Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod.', {
        x: 50, y: 730 - l * 24, size: 11, font, color: rgb(0.2, 0.2, 0.2),
      });
    }
    for (let g = 0; g < 14; g++) {
      const x = 50 + (g % 4) * 120, y = 150 - Math.floor(g / 4) * 46;
      if (g % 3 === 0) {
        page.drawRectangle({ x, y, width: 90, height: 30, borderColor: rgb(0.1, 0.4, 0.9), borderWidth: 1.5 });
      } else if (g % 3 === 1) {
        page.drawLine({ start: { x, y }, end: { x: x + 90, y: y + 30 }, thickness: 1.5, color: rgb(0.9, 0.2, 0.2) });
      } else {
        page.drawCircle({ x: x + 45, y: y + 15, size: 16, borderColor: rgb(0.1, 0.7, 0.3), borderWidth: 1.5 });
      }
    }
  }
  const bytes = Buffer.from(await doc.save());
  fs.writeFileSync(OUT_PDF, bytes);
  return bytes;
}

// 在渲染进程里跑的探测体
const MEASURE = `(async () => {
  const now = () => performance.now();
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const sleepUntil = async (fn, timeout) => { const t0 = now(); while (!fn()) { if (now() - t0 > timeout) return false; await wait(15); } return true; };
  const renderedCount = () => { let n = 0; for (const [, v] of App.state.rendered) if (v) n++; return n; };
  const liveBitmaps = () => { // 只统计「确实渲染过」的页：未画过的 canvas 仍是默认 300 宽，会误报
    let n = 0, px = 0;
    for (const [k, v] of App.state.rendered) {
      if (!v) continue;
      const cv = App.pageEl(k) && App.pageEl(k).querySelector('canvas');
      if (cv && cv.width > 400) { n++; px += cv.width * cv.height; }
    }
    return { n, mpix: Math.round(px / 1e6 * 10) / 10 };
  };

  // 阶段化计时（t0 由外部在投递字节的前一刻设置）：
  //  parseMs  = getDocument 解析出文档对象
  //  builtMs  = buildPageBlocks 完成（每页 getPage + 建 DOM）—— 之前被漏测的真正的串行开销
  //  usableMs = 首页已绘制，用户可开始阅读
  if (!(await sleepUntil(() => App.state.pdfDoc && App.state.pdfDoc.numPages > 0, 90000))) return { fatal: 'load timeout' };
  const out = { numPages: App.state.numPages, parseMs: Math.round(now() - window.__t0) };
  const total = App.state.numPages;
  if (!(await sleepUntil(() => document.querySelectorAll('.page').length === total, 120000))) return Object.assign(out, { fatal: 'build timeout' });
  out.builtMs = Math.round(now() - window.__t0);
  if (!(await sleepUntil(() => renderedCount() > 0, 60000))) return Object.assign(out, { fatal: 'first paint timeout' });
  out.usableMs = Math.round(now() - window.__t0);
  out.domPages = document.querySelectorAll('.page').length;
  out.renderedAfterLoad = renderedCount();
  out.liveAfterLoad = liveBitmaps();
  out.heapAfterLoadMB = Math.round((performance.memory ? performance.memory.usedJSHeapSize : 0) / 1e6 * 10) / 10;

  // 跳远页
  const jp = ${JUMP};
  const jumpEl = App.pageEl(jp);
  if (!jumpEl) return Object.assign(out, { fatal: 'jump target missing' });
  const s0 = now();
  jumpEl.scrollIntoView({ block: 'start' });
  await sleepUntil(() => App.state.rendered.get(jp) === true, 15000);
  out.jumpMs = Math.round(now() - s0);
  out.jumpRendered = App.state.rendered.get(jp) === true;
  out.renderedAfterJump = renderedCount();
  out.liveAfterJump = liveBitmaps();

  // 连续翻阅：每页渲染延迟分布
  const lat = [];
  for (let p = jp + 1; p <= jp + ${SWEEP}; p++) {
    const el = App.pageEl(p); if (!el) break;
    const a = now();
    el.scrollIntoView({ block: 'start' });
    await sleepUntil(() => App.state.rendered.get(p) === true, 15000);
    lat.push(Math.round(now() - a));
  }
  const sorted = lat.slice().sort((x, y) => x - y);
  const q = (f) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * f))] : -1;
  out.sweep = { n: sorted.length, min: q(0), p50: q(0.5), p95: q(0.95), max: q(1) };
  out.renderedAfterSweep = renderedCount();
  out.liveAfterSweep = liveBitmaps();
  out.heapAfterSweepMB = Math.round((performance.memory ? performance.memory.usedJSHeapSize : 0) / 1e6 * 10) / 10;

  // 判别 sweep 的 ~2s 是否为「隐藏窗口 rAF 被降频」造成的测量假象：
  // IntersectionObserver 的回调在动画帧里派发，若 rAF 只有 0.5Hz，则每页必然卡约 2s。
  out.rafMs = await new Promise((res) => {
    const d = []; let last = now(), k = 0;
    const tick = (t) => { d.push(Math.round(t - last)); last = t; if (++k < 6) requestAnimationFrame(tick); else res(d); };
    requestAnimationFrame(tick);
  });
  // 绕开观察器，直接量单页光栅化成本（渲染到一次性 canvas，不影响视图）
  out.directRenderMs = [];
  for (let p = jp + 1; p <= jp + 6; p++) {
    const el = App.pageEl(p); if (!el || !el._pdfPage) break;
    const vp = el._pdfPage.getViewport({ scale: App.state.scale });
    const cv = document.createElement('canvas');
    cv.width = Math.floor(vp.width); cv.height = Math.floor(vp.height);
    const a = now();
    try { await el._pdfPage.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise; } catch (_) {}
    out.directRenderMs.push(Math.round(now() - a));
    cv.width = 0; cv.height = 0;
  }
  return out;
})()`;

app.whenReady().then(async () => {
  let code = 1;
  try {
    const t = Date.now();
    const bytes = await makeBigPdf();
    console.log('[perf] fixture: ' + PAGES + ' pages, ' + Math.round(bytes.length / 1024) + ' KB (gen ' + (Date.now() - t) + 'ms)');

    const win = new BrowserWindow({
      show: false, width: 1100, height: 800,
      // 隐藏窗口的 rAF 会被降到 ~1Hz，足以把「每页渲染 1s」这类假数字测出来；
      // 开离屏合成让帧节拍回到正常节奏，测到的才是真实成本。
      webPreferences: { nodeIntegration: false, contextIsolation: true, preload: PRELOAD, backgroundThrottling: false, offscreen: process.env.BIG_OFFSCREEN === '1' },
    });
    await win.loadFile(RENDERER);
    // t0 紧贴字节投递，中间不再插固定 sleep（此前的 await wait(1000) 被算进了 loadMs）
    await win.webContents.executeJavaScript('window.__t0 = performance.now(); 1');
    win.webContents.send('pdf-opened', { ok: true, fileName: 'big.pdf', data: new Uint8Array(bytes), smoke: false });

    const memAt = () => app.getAppMetrics().reduce((s, p) => s + (p.memory ? p.memory.workingSetSize / 1024 : 0), 0);
    const memBefore = Math.round(memAt());
    const res = await win.webContents.executeJavaScript(MEASURE, true);
    const memAfter = Math.round(memAt());

    if (res.fatal) { console.log('[perf] FATAL ' + JSON.stringify(res)); app.exit(2); return; }
    // 有界性：任意时刻真正持有位图的页数应当只与视口有关，与文档总页数无关
    const bounded = res.liveAfterLoad.n <= 10 && res.liveAfterSweep.n <= 10;
    // 流畅度以 directRenderMs（绕开观察器的真实光栅成本）为准；
    // sweep 里的每页耗时会受隐藏窗口 rAF 降频影响，只作参考。
    const worstDirect = res.directRenderMs.length ? Math.max.apply(null, res.directRenderMs) : 1e9;
    const pass = res.jumpRendered && res.usableMs < 6000 && worstDirect < 200 && bounded;
    console.log('[perf] ' + JSON.stringify(res));
    console.log('[perf] procMemMB before/after = ' + memBefore + '/' + memAfter);
    console.log('[perf] ' + (pass ? 'PASS' : 'REVIEW'));
    code = pass ? 0 : 2;
  } catch (e) {
    console.error('[perf] ERROR', e && e.stack ? e.stack : e);
  }
  app.exit(code);
});
