'use strict';
/*
 * 第二批回归（审查报告 B04—B08）：
 *   B04 图片 + 文字 + 线条混合标注能导出（不再在构造阶段抛错）
 *   B05 三角形按真实顶点逐点换算；0 / 90 / 180 / 270° 页都核对生产输出
 *   B06 橡皮稀疏指针事件不漏擦（140→260 一次移动，中间必须擦断）
 *   B07 一次橡皮手势 = 一个撤销点
 *   B08 Shift 正三角真的是等边，不是等腰
 *
 * 跑法：node scripts/test-draw-export.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runProbe } = require('./probe-runner');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-draw-export-'));
const ud = path.join(dir, 'ud');
const sample = path.join(dir, 'sample.pdf');
fs.copyFileSync(path.join(__dirname, '../assets/sample.pdf'), sample);

// 造一份「四种旋转都有」的 PDF：每页一句文字，页 2/3/4 分别 90/180/270 度
async function makeRotated() {
  const { PDFDocument, StandardFonts, degrees, rgb } = require('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 4; i++) {
    const page = doc.addPage([595, 842]);
    page.drawText('PAGE ' + (i + 1), { x: 60, y: 720, size: 24, font, color: rgb(0, 0, 0) });
    page.drawRectangle({ x: 60, y: 500, width: 200, height: 100, borderColor: rgb(0.2, 0.4, 0.8), borderWidth: 1 });
    if (i > 0) page.setRotation(degrees(90 * i));
  }
  const out = path.join(dir, 'rotated.pdf');
  fs.writeFileSync(out, await doc.save());
  return out;
}

const probeA = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) { if (App.state.rendered.get(1)) break; await sleep(100); }
  if (!App.state.rendered.get(1)) return { checks: [['样本 PDF 已加载', false, 'timeout']] };
  await sleep(500);

  const svg = $('#page-1 .anno');
  const ctm = svg.getScreenCTM();
  const toClient = (x, y) => { const p = new DOMPoint(x, y).matrixTransform(ctm); return { x: p.x, y: p.y }; };
  const arr = () => App.state.annos.get(1) || [];
  const resetPage = () => { App.state.currentPage = 1; App.state.annos.set(1, []); Anno.renderPage(1); };

  // ---------- B06 稀疏移动：整段扫掠都要擦到 ----------
  resetPage();
  Anno.addShape(1, { tool: 'pen', color: '#e53935', width: 3, pts: [{ x: 100, y: 200 }, { x: 300, y: 200 }] }, { undo: false });
  Anno.setTool('eraser');
  const p140 = toClient(140, 200), p260 = toClient(260, 200);
  svg.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 31, clientX: p140.x, clientY: p140.y }));
  window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 31, clientX: p260.x, clientY: p260.y }));
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 31, clientX: p260.x, clientY: p260.y }));
  await sleep(150);
  const pieces = arr().filter((s) => s.tool === 'pen');
  const ranges = pieces.map((s) => [Math.min(...s.pts.map((q) => q.x)), Math.max(...s.pts.map((q) => q.x))]);
  const gapCovered = !ranges.some(([a, b]) => a < 250 && b > 150);
  push('一次移动 140→260 的中间被擦断', pieces.length === 2 && gapCovered, JSON.stringify(ranges.map((r) => r.map((v) => Math.round(v)))));
  const left = ranges.find((r) => r[1] < 200), right = ranges.find((r) => r[0] > 200);
  push('残留片段停在擦头边界附近', !!left && !!right && left[1] < 140 && right[0] > 258,
    JSON.stringify({ left: left && Math.round(left[1]), right: right && Math.round(right[0]) }));

  // ---------- B07 一次手势一个撤销点 ----------
  Anno.undo();
  await sleep(80);
  push('一次撤销恢复整条笔迹', arr().filter((s) => s.tool === 'pen').length === 1
    && Math.abs(arr()[0].pts[0].x - 100) < 1 && Math.abs(arr()[0].pts[1].x - 300) < 1,
    JSON.stringify(arr().map((s) => s.tool)));

  // 两条平行线，一次竖着拖过，两条都要断，且只占一个撤销点
  resetPage();
  Anno.addShape(1, { tool: 'line', color: '#e53935', width: 3, a: { x: 100, y: 200 }, b: { x: 300, y: 200 } }, { undo: false });
  Anno.addShape(1, { tool: 'line', color: '#e53935', width: 3, a: { x: 100, y: 240 }, b: { x: 300, y: 240 } }, { undo: false });
  const q1 = toClient(200, 200), q2 = toClient(200, 242);
  svg.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 32, clientX: q1.x, clientY: q1.y }));
  window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 32, clientX: q2.x, clientY: q2.y }));
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 32, clientX: q2.x, clientY: q2.y }));
  await sleep(150);
  push('一竖擦断两条线', arr().length === 4, 'n=' + arr().length + ' tools=' + arr().map((s) => s.tool).join(','));
  Anno.undo();
  await sleep(80);
  push('一次撤销把两条线都放回', arr().length === 2 && arr().every((s) => s.tool === 'line'),
    'n=' + arr().length + ' tools=' + arr().map((s) => s.tool).join(','));

  // ---------- R04 重叠笔迹：擦头覆盖到的每一条都要断 ----------
  resetPage();
  Anno.addShape(1, { tool: 'pen', color: '#e53935', width: 3, pts: [{ x: 100, y: 320 }, { x: 300, y: 320 }] }, { undo: false });
  Anno.addShape(1, { tool: 'pen', color: '#1565c0', width: 3, pts: [{ x: 100, y: 320 }, { x: 300, y: 320 }] }, { undo: false });
  const o1 = toClient(140, 320), o2 = toClient(260, 320);
  svg.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 34, clientX: o1.x, clientY: o1.y }));
  window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 34, clientX: o2.x, clientY: o2.y }));
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 34, clientX: o2.x, clientY: o2.y }));
  await sleep(160);
  const penRanges = arr().filter((s) => s.tool === 'pen').map((s) => [Math.min(...s.pts.map((q) => q.x)), Math.max(...s.pts.map((q) => q.x))]);
  const upperOnly = penRanges.some(([a, b]) => a < 250 && b > 150 && (b - a) > 120);
  push('叠在一起的两条笔迹都被擦断', penRanges.length === 4 && !upperOnly,
    JSON.stringify(penRanges.map((r) => r.map((v) => Math.round(v)))));
  Anno.undo();
  await sleep(100);
  push('一次撤销把两条原线都放回', arr().length === 2 && arr().every((s) => s.tool === 'pen'),
    'n=' + arr().length + ' tools=' + arr().map((s) => s.tool).join(','));

  // ---------- B08 Shift 正三角 ----------
  resetPage();
  Anno.setTool('triangle');
  const d1 = toClient(200, 150), d2 = toClient(320, 300);
  svg.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 33, clientX: d1.x, clientY: d1.y }));
  window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 33, clientX: d2.x, clientY: d2.y, shiftKey: true }));
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 33, clientX: d2.x, clientY: d2.y, shiftKey: true }));
  await sleep(150);
  const triSh = arr().find((s) => s.tool === 'triangle');
  let edges = [];
  if (triSh && window.Anno && Anno.trianglePoints) {
    const v = Anno.trianglePoints(triSh);
    edges = [[0, 1], [1, 2], [2, 0]].map(([i, j]) => Math.hypot(v[i].x - v[j].x, v[i].y - v[j].y));
  }
  const edMax = Math.max(...edges), edMin = Math.min(...edges);
  push('Shift 画出的是等边三角形', !!triSh && edges.length === 3 && edMax / edMin < 1.005,
    JSON.stringify(edges.map((v) => Math.round(v * 10) / 10)));

  // ---------- B04 图片 + 文字 + 线条混合导出 ----------
  resetPage();
  Anno.addShape(1, { tool: 'line', color: '#e53935', width: 3, a: { x: 80, y: 300 }, b: { x: 260, y: 300 } }, { undo: false });
  Anno.addShape(1, { tool: 'image', color: '#8a7f6a', width: 1, image: 'snapshots/demo.png', rects: [{ x: 100, y: 320, w: 60, h: 40 }], text: '图片标注 · 第 1 页' }, { undo: false });
  Anno.addShape(1, { tool: 'text', color: '#1565c0', size: 14, at: { x: 100, y: 400 }, text: 'Mixed export' }, { undo: false });
  let payload = null, buildError = '';
  try { payload = App.buildExportPayload(''); } catch (err) { buildError = String(err && err.message); }
  push('混合标注能构造导出载荷', !!payload && !buildError, buildError);
  const g = payload && payload.pages[0] && payload.pages[0].shapes || [];
  const img = g.find((x) => x.tool === 'image');
  push('图片标注按「只保留恢复数据」处理', !!img && img.skip === 'image-snapshot' && !img.a && Array.isArray(img.rects) && img.rects.length === 1,
    JSON.stringify(img && { skip: img.skip, rects: img.rects && img.rects.length, hasAB: !!img.a }));
  push('同一页的文字与线条仍在载荷里', g.some((x) => x.tool === 'text') && g.some((x) => x.tool === 'line'), g.map((x) => x.tool).join(','));
  const st = await pdfBridge.getSettings();
  const outPath = String(st.dataDir).replace(/[\\\\/]+$/, '') + '/mixed-export.pdf';
  payload.outPath = outPath;
  const res = await pdfBridge.exportPdf(payload);
  push('混合标注导出成功', !!(res && res.ok), JSON.stringify(res && { ok: res.ok, error: res.error }));
  push('图片走「约定不画」而不是失败计数', !!res && res.skipped === 0 && res.imageSkipped === 1,
    JSON.stringify(res && { skipped: res.skipped, image: res.imageSkipped, reasons: res.reasons }));
  return { checks, outPath: res && res.path };
})()`;

const probeB = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const wait = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 15000)) { if (fn()) return true; await sleep(80); } return !!fn(); };

  for (const n of [1, 2, 3, 4]) {
    const opened = await pdfBridge.lib.openItem('rot', n);
    if (!opened || !opened.ok) { push('第 ' + n + ' 页可打开', false, JSON.stringify(opened && opened.error)); continue; }
    await window.__libOpen(opened);
    const ok = await wait(() => App.state.currentPage === n && App.pageEl(n) && App.pageEl(n)._pdfPage, 15000);
    if (!ok) { push('第 ' + n + ' 页可渲染', false, 'timeout'); continue; }
    const el = App.pageEl(n);
    App.state.annos.set(n, [{ id: 'T' + n, tool: 'triangle', color: '#e53935', width: 3,
      a: { x: 100, y: 100 }, b: { x: 300, y: 250 } }]);
    const sh = App.state.annos.get(n)[0];
    const vp = el._pdfPage.getViewport({ scale: 1 });
    const exp = Anno.trianglePoints(sh).map((p) => { const r = vp.convertToPdfPoint(p.x, p.y); return { x: r[0], y: r[1] }; });
    const payload = App.buildExportPayload('');
    const pg = (payload.pages || []).find((p) => p.index === n - 1);
    const got = pg && pg.shapes && pg.shapes[0] && pg.shapes[0].tri;
    const near = (a, b) => Math.abs(a - b) < 0.05;
    const same = Array.isArray(got) && got.length === 3 &&
      got.every((p, i) => near(p.x, exp[i].x) && near(p.y, exp[i].y));
    push('第 ' + n + ' 页三角顶点与逐点换算一致', same, JSON.stringify({ got, exp }));

    // 旧写法（先转包围框再按坐标轴重建）在 90/180/270 会给出另一组顶点：
    // 这里确认两者确实不同，说明这条断言不是「怎么写都过」
    if (n > 1) {
      const ca = (p) => { const r = vp.convertToPdfPoint(p.x, p.y); return { x: r[0], y: r[1] }; };
      const A = ca(sh.a), B = ca(sh.b);
      const x1 = Math.min(A.x, B.x), y1 = Math.min(A.y, B.y), x2 = Math.max(A.x, B.x), y2 = Math.max(A.y, B.y);
      const naive = [{ x: (x1 + x2) / 2, y: y2 }, { x: x1, y: y1 }, { x: x2, y: y1 }];
      const differs = naive.some((p, i) => Math.abs(p.x - exp[i].x) > 0.5 || Math.abs(p.y - exp[i].y) > 0.5);
      push('第 ' + n + ' 页确实是「重建会错」的页', differs, JSON.stringify({ naive, exp }));
    }
    App.state.annos.set(n, []);
  }
  return { checks };
})()`;

async function main() {
  const rotated = await makeRotated();
  fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify({
    version: 8,
    collections: [], searches: [], tagColors: {}, annoTags: {}, annoMeta: {}, feeds: [], noteAliases: {},
    items: [
      { key: 'a', title: 'Sample', attachment: { path: sample, name: 'sample.pdf' } },
      { key: 'rot', title: 'Rotated', attachment: { path: rotated, name: 'rotated.pdf' } },
    ],
  }));
  const env = {
    PDFREADER_LIBRARY: path.join(dir, 'library.json'),
    PDFREADER_DATA_DIR: dir,
    PDFREADER_NO_AUTO_INDEX: '1',
  };
  const run = (label, code, extraEnv) => {
    const file = path.join(dir, label + '.cjs');
    fs.writeFileSync(file, 'module.exports=' + JSON.stringify(code));
    return runProbe({
      probe: file,
      env: Object.assign({}, env, extraEnv || {}),
      args: ['--user-data-dir=' + ud],
      timeout: 120000,
      label,
    });
  };
  const a = run('draw-export', probeA, { PDFREADER_PROBE_PDF: sample });
  const outPath = a.res && a.res.outPath;
  const okFile = !!outPath && fs.existsSync(outPath);
  if (!okFile) { a.fail = (a.fail || 0) + 1; a.total = (a.total || 0) + 1; console.log('  FAIL 导出结果文件真的存在  <- ' + outPath); }
  else { a.total = (a.total || 0) + 1; console.log('  ok   导出结果文件真的存在'); }
  const b = run('export-rotate', probeB, { PDFREADER_PROBE_PDF: rotated });
  const fail = (a.fail || 0) + (b.fail || 0);
  console.log('[draw-export] ' + (fail ? 'FAIL' : 'PASS') + ' (' + a.total + ' + ' + b.total + ')');
  process.exitCode = fail ? 1 : 0;
}

main().catch((err) => {
  console.error('[draw-export] FAIL ' + (err && err.message));
  process.exitCode = 1;
});
