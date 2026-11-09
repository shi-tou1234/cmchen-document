'use strict';
/*
 * 1.6.2 反馈修复回归（无头 Electron 探针）：
 *   1) 标注色板：一排常用色、分工具记忆（荧光笔一桶 / 画笔一桶），取色器跟着同步；
 *   2) 橡皮局部擦除：笔迹只擦掉经过的一段（切成两段），文字高亮按行横向切开，都能撤销；
 *   3) 双页对开：在第 N 页切过去时不能停在旧的滚动位置上（旧的 scrollTop 会把页顶推出视口，
 *      看起来像「点了没反应」）；按钮要有点亮状态；
 *   4) 双页独立缩放：开启后只放大鼠标所指的那一页，另一页尺寸不变；关掉后回到同步；
 *   5) 「导入文献库」按钮：存在、随文档状态切换提示与弱化态。
 * 运行：node scripts/test-v162-feedback.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { runProbe } = require('./probe-runner');

let code = 0;
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-v162-'));
  const ud = path.join(tmp, 'ud');
  fs.mkdirSync(ud);
  try {
    const pdf = path.join(tmp, 'feedback.pdf');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let n = 1; n <= 8; n++) {
      const p = doc.addPage([612, 792]);
      p.drawText('Page ' + n + ' marker', { x: 60, y: 700, size: 18, font });
    }
    fs.writeFileSync(pdf, await doc.save());

    const probe = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 12000)) { if (await fn()) return true; await sleep(60); } return !!(await fn()); };
  const fire = (el, type, x, y) => el.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, composed: true, isPrimary: true, pointerId: 1,
    pointerType: 'mouse', button: 0, buttons: 1, clientX: x, clientY: y,
  }));
  const ann = (n) => (App.state.annos.get(n) || []);
  const svgOf = (n) => document.querySelector('#page-' + n + ' .anno');
  // 单位坐标 → 客户端坐标（走 SVG 的 CTM，缩放/旋转都算进去）
  const at = (svg, ux, uy) => {
    const m = svg.getScreenCTM();
    const p = new DOMPoint(ux, uy).matrixTransform(m);
    return { x: p.x, y: p.y };
  };
  const fireU = (svg, el, type, ux, uy) => { const c = at(svg, ux, uy); fire(el, type, c.x, c.y); };

  const loaded = await waitFor(() => App.state.pdfDoc && App.state.rendered.get(1), 25000);
  push('PDF 已打开', loaded);
  if (!loaded) return { checks };
  const s1 = svgOf(1);
  if (!s1) return { checks: checks.concat([['第 1 页标注层存在', false]]) };

  // ---------- 1. 色板 ----------
  const swBox = document.getElementById('note-swatches');
  push('标注工具栏有色板', !!swBox && swBox.querySelectorAll('[data-color]').length >= 6,
    swBox ? swBox.querySelectorAll('[data-color]').length : -1);
  Anno.setTool('highlight');
  const hlDefault = Anno.state.color;
  push('荧光笔默认黄色', hlDefault.toLowerCase() === '#ffd54f', hlDefault);
  const swGreen = swBox && swBox.querySelector('[data-color="#a5d6a7"]');
  if (swGreen) swGreen.click();
  push('点色板即换色', Anno.state.color.toLowerCase() === '#a5d6a7', Anno.state.color);
  push('取色器同步成色板颜色', String(document.getElementById('note-color').value).toLowerCase() === '#a5d6a7',
    document.getElementById('note-color').value);
  const swActive = swBox.querySelector('[data-color="#a5d6a7"]').classList.contains('active');
  push('色板上标出当前颜色', swActive);
  // 切到画笔：颜色该回到画笔那一桶（红），再切回荧光笔要拿回绿色
  Anno.setTool('pen');
  push('画笔有自己的默认色', Anno.state.color.toLowerCase() === '#e53935', Anno.state.color);
  Anno.setTool('highlight');
  push('切回荧光笔颜色还在', Anno.state.color.toLowerCase() === '#a5d6a7', Anno.state.color);

  // ---------- 2. 橡皮局部擦除 ----------
  Anno.setTool('pen');
  await sleep(30);
  fireU(s1, s1, 'pointerdown', 60, 100);
  for (let i = 1; i <= 30; i++) fireU(s1, window, 'pointermove', 60 + i * 10, 100);
  fireU(s1, window, 'pointerup', 360, 100);
  await sleep(60);
  const stroke = ann(1)[0];
  push('画出了一条笔迹', ann(1).length === 1 && stroke && stroke.tool === 'pen' && stroke.pts.length > 10,
    'n=' + ann(1).length + ' pts=' + (stroke ? stroke.pts.length : -1));
  const ptsBefore = stroke ? stroke.pts.length : 0;

  Anno.setTool('eraser');
  await sleep(30);
  fireU(s1, s1, 'pointerdown', 210, 100);   // 只点中间一下
  fireU(s1, window, 'pointerup', 210, 100);
  await sleep(60);
  const pieces = ann(1);
  push('擦一下不再整条消失', pieces.length === 2, 'n=' + pieces.length);
  push('两段都还有笔迹', pieces.length === 2 && pieces.every((p) => p.pts && p.pts.length >= 2),
    pieces.map((p) => (p.pts || []).length).join('/'));
  const minGap = pieces.length === 2
    ? Math.min(...pieces[1].pts.map((q) => Math.hypot(q.x - pieces[0].pts[pieces[0].pts.length - 1].x, q.y - pieces[0].pts[pieces[0].pts.length - 1].y)))
    : 0;
  push('断开处确实留出了缺口', pieces.length === 2 && minGap > 5, 'gap=' + Math.round(minGap));

  Anno.undo();
  await sleep(40);
  push('撤销后恢复成一条完整笔迹', ann(1).length === 1 && ann(1)[0].pts.length === ptsBefore,
    'n=' + ann(1).length + ' pts=' + (ann(1)[0] ? ann(1)[0].pts.length : -1));

  // 文字高亮：横向切开，左右各留一截
  Anno.addShape(1, { tool: 'mark', color: '#ffd54f', width: 0, rects: [{ x: 60, y: 300, w: 300, h: 12 }], text: '一段被高亮的文字' });
  await sleep(40);
  const markBefore = ann(1).find((x) => x.tool === 'mark');
  push('高亮已落到模型里', !!markBefore && markBefore.rects.length === 1);
  Anno.setTool('eraser');
  fireU(s1, s1, 'pointerdown', 200, 306);
  fireU(s1, window, 'pointerup', 200, 306);
  await sleep(60);
  const markAfter = ann(1).find((x) => x.tool === 'mark');
  push('高亮被切成左右两截', !!markAfter && markAfter.rects.length === 2,
    markAfter ? JSON.stringify(markAfter.rects.map((r) => Math.round(r.w))) : 'none');
  const widths = markAfter ? markAfter.rects.map((r) => Math.round(r.w)) : [];
  push('两截宽度大致等于原宽减擦除带', widths.length === 2 && Math.abs(widths[0] + widths[1] - 298) <= 20,
    widths.join('+'));
  Anno.undo();
  await sleep(40);
  const markUndo = ann(1).find((x) => x.tool === 'mark');
  push('撤销后高亮恢复整条', !!markUndo && markUndo.rects.length === 1 && Math.round(markUndo.rects[0].w) === 300,
    markUndo ? JSON.stringify(markUndo.rects) : 'none');
  Anno.setTool('select');

  // ---------- 3. 双页对开：滚动位置不该把人甩出页面 ----------
  App.setViewMode('scroll');
  scrollToPage(6, true);
  await sleep(220);
  const scrollBefore = document.getElementById('viewer').scrollTop;
  document.getElementById('btn-spread').click();
  await sleep(320);
  const viewer = document.getElementById('viewer');
  push('切到了双页对开', document.body.classList.contains('view-spread'));
  push('切对开后滚动位置归零（页面顶端在视口里）', viewer.scrollTop === 0, 'scrollTop=' + viewer.scrollTop + ' before=' + scrollBefore);
  const visible = () => Array.from(document.querySelectorAll('#pages .page'))
    .filter((el) => el.classList.contains('is-current')).map((el) => +el.dataset.page).sort((a, b) => a - b);
  push('显示第 6 页那一对（6,7）', visible().join(',') === '6,7', visible().join(','));
  const vr = viewer.getBoundingClientRect();
  const top6 = document.getElementById('page-6').getBoundingClientRect().top;
  push('页顶真的落在视口内', top6 >= vr.top - 2 && top6 < vr.bottom, 'top=' + Math.round(top6) + ' vr=' + Math.round(vr.top));
  push('双页按钮点亮', document.getElementById('btn-spread').classList.contains('active'));
  push('独立缩放按钮在对开下出现', document.getElementById('btn-spread-zoom').hidden === false);

  // ---------- 4. 双页独立缩放 ----------
  const zoomBtn = document.getElementById('btn-spread-zoom');
  zoomBtn.click();
  await sleep(120);
  push('独立缩放已开启', App.state.perPageZoom === true && App.perPageZoomActive() === true);
  const p6 = document.getElementById('page-6'), p7 = document.getElementById('page-7');
  const w0 = p6.getBoundingClientRect().width, w1 = p7.getBoundingClientRect().width;
  push('初始两页等宽', Math.abs(w0 - w1) < 2, Math.round(w0) + '/' + Math.round(w1));
  const c = p6.getBoundingClientRect();
  App.zoomPageAt(6, App.pageScale(6) * 1.6, c.left + c.width / 2, c.top + 80);
  await sleep(200);
  const w6 = p6.getBoundingClientRect().width, w7 = p7.getBoundingClientRect().width;
  push('只放大了第 6 页', Math.abs(w6 / w0 - 1.6) < 0.08 && Math.abs(w7 - w1) < 2,
    'p6=' + Math.round(w6) + '(x' + (w6 / w0).toFixed(2) + ') p7=' + Math.round(w7));
  push('页级缩放记在模型里', Math.abs(App.pageZoomOf(6) - 1.6) < 0.05 && App.pageZoomOf(7) === 1,
    App.pageZoomOf(6).toFixed(2) + '/' + App.pageZoomOf(7));
  push('放大后的页按新尺寸重渲染', await waitFor(() => Math.abs((p6._renderScale || 0) - App.pageScale(6)) < 1e-3, 8000),
    '_renderScale=' + p6._renderScale + ' want=' + App.pageScale(6));
  zoomBtn.click();
  await sleep(220);
  const w6b = p6.getBoundingClientRect().width, w7b = p7.getBoundingClientRect().width;
  push('关掉后两页恢复等宽', Math.abs(w6b - w7b) < 2 && Math.abs(w6b - w0) < 2,
    Math.round(w6b) + '/' + Math.round(w7b));
  push('页级倍数已清空', App.state.pageZoom.size === 0);

  // 回到连续滚动
  document.getElementById('btn-spread').click();
  await sleep(250);
  push('再点一次回到连续滚动', !document.body.classList.contains('view-spread'));
  push('连续滚动下独立缩放按钮隐藏', document.getElementById('btn-spread-zoom').hidden === true);

  // ---------- 5. 导入文献库按钮 ----------
  const libBtn = document.getElementById('btn-to-lib');
  push('工具栏有「导入文献库」按钮', !!libBtn);
  App.state.itemKey = '';
  App.updateToLibButton();
  push('未入库时状态是 out', libBtn.dataset.state === 'out', libBtn.dataset.state);
  App.state.itemKey = 'probe-key';
  App.updateToLibButton();
  push('已入库时状态是 in', libBtn.dataset.state === 'in' && /已在文献库/.test(libBtn.title), libBtn.dataset.state + ' | ' + libBtn.title);
  App.state.itemKey = '';
  App.updateToLibButton();
  push('入口函数存在', typeof App.saveCurrentToLibrary === 'function');

  return { checks };
})()`;

    const probeFile = path.join(tmp, 'probe.cjs');
    fs.writeFileSync(probeFile, 'module.exports=' + JSON.stringify(probe));
    const r = runProbe({
      probe: probeFile,
      env: {
        PDFREADER_DATA_DIR: tmp,
        PDFREADER_LIBRARY: path.join(tmp, 'library.json'),
        PDFREADER_NO_AUTO_INDEX: '1',
        PDFREADER_PROBE_PDF: pdf,
      },
      args: ['--user-data-dir=' + ud],
      label: 'v162-feedback',
      timeout: 240000,
    });
    assert.equal(r.fail, 0);
    code = 0;
  } catch (e) {
    console.error('[v162-feedback] ERROR', e && e.message ? e.message : e);
    code = 3;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(code);
})();
