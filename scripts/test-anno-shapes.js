'use strict';
/*
 * 1.7.0（本轮改动）功能回归：
 *   A 页面排列不再有下拉，三个小按钮 + 分屏常驻；
 *   B 新图形工具（圆 / 三角 / 一笔成型）与形状识别；
 *   C 橡皮擦对直线 / 矩形 / 圆按段擦，Alt 整条删，撤销可复原；
 *   D 阅读界面「导入文献库」一个入口两条来路；
 *   E 菜单高度上限（P2 修复）在人工造超高内容时仍然生效。
 *
 * 运行：node scripts/test-anno-shapes.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runProbe } = require('./probe-runner');

const PROBE = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const key = (k, opts) => document.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, opts || {})));
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    if (App.state.mode === 'pdf' && App.state.rendered.get(1)) break;
    await sleep(100);
  }
  if (!App.state.rendered.get(1)) return { checks: [['样本 PDF 已加载', false, 'timeout']] };
  await sleep(500);

  // ---------- A 页面排列常驻 ----------
  const vis = (id) => { const b = document.getElementById(id); return !!b && b.getClientRects().length > 0; };
  push('没有页面布局下拉', !$('#tb-view-btn') && !$('#tb-view-pop'));
  push('三个排列按钮常驻', ['btn-vm-scroll', 'btn-vm-page', 'btn-spread'].every(vis));
  push('分屏按钮常驻', vis('btn-split'));
  push('导入文献库入口带文字', /导入文献库/.test($('#btn-to-lib').textContent));
  $('#btn-vm-page').click(); await sleep(180);
  push('点单页切换并高亮', App.state.viewMode === 'page' && $('#btn-vm-page').getAttribute('aria-pressed') === 'true');
  $('#btn-spread').click(); await sleep(180);
  push('点双页放出独立缩放', App.state.viewMode === 'spread' && vis('btn-spread-zoom'));
  $('#btn-vm-scroll').click(); await sleep(180);
  push('回连续滚动收起独立缩放', App.state.viewMode === 'scroll' && $('#btn-spread-zoom').hidden);
  push('旋转 / 重排 / 标尺入口仍在（供命令面板与右键菜单）',
    ['btn-rotate-left', 'btn-reflow', 'btn-ruler'].every((id) => !!document.getElementById(id)));

  // ---------- B 图形工具与一笔成型 ----------
  const hasTool = (t) => !!$('#notetools .ntool[data-tool="' + t + '"]');
  push('圆 / 三角 / 一笔成型都在标注栏', ['ellipse', 'triangle', 'smart'].every(hasTool));
  push('印章按钮已从工具栏退役', !hasTool('stamp'));
  Anno.setTool('smart'); await sleep(80);
  push('一笔成型提示条出现', !$('#smart-hint').hidden);
  Anno.setTool('select'); await sleep(80);
  push('切走后提示条收起', $('#smart-hint').hidden);

  const S = (pts) => Anno.recognizeStroke({ tool: 'smart', color: '#e53935', width: 3, pts });
  const circle = [];
  for (let i = 0; i < 40; i++) {
    const a = 2 * Math.PI * i / 40;
    circle.push({ x: 100 + 40 * Math.cos(a), y: 100 + 40 * Math.sin(a) });
  }
  circle.push({ x: circle[0].x, y: circle[0].y });
  const rect = [];
  const rc = [[40, 40], [160, 40], [160, 140], [40, 140], [40, 40]];
  for (let k = 0; k < 4; k++) for (let i = 0; i < 10; i++) {
    const t = i / 10;
    rect.push({ x: rc[k][0] + (rc[k + 1][0] - rc[k][0]) * t, y: rc[k][1] + (rc[k + 1][1] - rc[k][1]) * t });
  }
  rect.push({ x: 40, y: 40 });
  const tri = [];
  const tc = [[100, 40], [160, 140], [40, 140], [100, 40]];
  for (let k = 0; k < 3; k++) for (let i = 0; i < 12; i++) {
    const t = i / 12;
    tri.push({ x: tc[k][0] + (tc[k + 1][0] - tc[k][0]) * t, y: tc[k][1] + (tc[k + 1][1] - tc[k][1]) * t });
  }
  tri.push({ x: 100, y: 40 });
  const line = [];
  for (let i = 0; i < 20; i++) line.push({ x: 40 + i * 6, y: 100 + Math.sin(i) * 0.4 });
  const scribble = [];
  for (let i = 0; i < 30; i++) scribble.push({ x: 40 + i * 4, y: 100 + Math.sin(i * 0.9) * 25 });
  const J = (pts, amp) => pts.map((q, i) => ({ x: q.x + Math.sin(i * 2.7) * amp, y: q.y + Math.cos(i * 3.1) * amp }));
  push('画得圆 → 圆', S(circle).tool === 'ellipse');
  push('四个角 → 矩形', S(rect).tool === 'rect');
  push('三个角 → 三角形', S(tri).tool === 'triangle');
  push('笔直 → 直线', S(line).tool === 'line');
  push('随手涂鸦保持手绘', S(scribble).tool === 'pen');
  push('带手抖也能识别（圆 / 方 / 三角 / 直线）',
    S(J(circle, 2.2)).tool === 'ellipse' && S(J(rect, 2.2)).tool === 'rect' &&
    S(J(tri, 2.2)).tool === 'triangle' && S(J(line, 1.5)).tool === 'line');

  // 直接拖出来的圆 / 三角能画到页面上
  Anno.setTool('ellipse'); await sleep(60);
  push('圆工具可选中', Anno.state.tool === 'ellipse' && !$('#note-width-wrap').hidden);
  Anno.setTool('triangle'); await sleep(60);
  push('三角形工具可选中', Anno.state.tool === 'triangle');
  Anno.setTool('select');

  // ---------- C 橡皮按段擦 ----------
  const svg = $('#page-1 .anno');
  const r = svg.getBoundingClientRect();
  const toUnit = (x, y) => {
    const p = new DOMPoint(x, y).matrixTransform(svg.getScreenCTM().inverse());
    return { x: p.x, y: p.y };
  };
  const cx = r.left + r.width * 0.5, cy = r.top + r.height * 0.35;
  const u1 = toUnit(cx - 80, cy), u2 = toUnit(cx + 80, cy);
  const erase = (x, y, alt) => {
    Anno.setTool('eraser');
    svg.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, button: 0, pointerId: 21, clientX: x, clientY: y, altKey: !!alt,
    }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 21, clientX: x, clientY: y }));
  };
  const resetPage = () => { App.state.currentPage = 1; Anno.clearPage(); };
  const arr = () => App.state.annos.get(1) || [];

  resetPage();
  Anno.addShape(1, { tool: 'line', color: '#e53935', width: 3, a: u1, b: u2 });
  erase(cx, cy); await sleep(120);
  push('擦直线只擦中间一段', arr().length >= 2 && arr().every((s) => s.tool === 'pen'),
    'n=' + arr().length + ' tools=' + arr().map((s) => s.tool).join(','));
  Anno.undo(); await sleep(80);
  push('撤销把直线整条放回来', arr().length === 1 && arr()[0].tool === 'line');

  resetPage();
  Anno.addShape(1, { tool: 'rect', color: '#e53935', width: 3, a: toUnit(cx - 80, cy - 50), b: toUnit(cx + 80, cy + 50) });
  erase(cx, cy - 50); await sleep(120);
  push('擦矩形边框只断那一段', arr().length >= 2 && !arr().some((s) => s.tool === 'rect'),
    'n=' + arr().length + ' tools=' + arr().map((s) => s.tool).join(','));

  resetPage();
  Anno.addShape(1, { tool: 'pen', color: '#e53935', width: 3, pts: [u1, u2] });
  erase(cx, cy); await sleep(120);
  push('两点笔迹也能从中间擦开', arr().length === 2, 'n=' + arr().length);

  resetPage();
  Anno.addShape(1, { tool: 'ellipse', color: '#e53935', width: 3, a: toUnit(cx - 80, cy - 50), b: toUnit(cx + 80, cy + 50) });
  erase(cx, cy - 50, true); await sleep(120);
  push('按住 Alt 点一下整条删', arr().length === 0, 'n=' + arr().length);
  Anno.undo(); await sleep(80);
  push('整条删也能撤销', arr().length === 1 && arr()[0].tool === 'ellipse');
  Anno.setTool('select');

  // ---------- D 导入文献库 ----------
  $('#btn-to-lib').click(); await sleep(150);
  push('导入文献库弹窗打开', !$('#import-lib-modal').hidden);
  push('两种来路都在', !!$('#import-lib-current') && !!$('#import-lib-refs'));
  key('Escape'); await sleep(150);
  push('Esc 关闭弹窗', $('#import-lib-modal').hidden);
  $('#btn-to-lib').click(); await sleep(120);
  $('#import-lib-refs').click(); await sleep(500);
  push('选「参考文献表批量入库」打开解析弹窗', !$('#refi-modal').hidden);
  const rx = $('#refi-x'); if (rx) rx.click();
  await sleep(120);

  // ---------- E 菜单高度上限（人工造超高内容） ----------
  const pop = $('#tb-output-pop');
  const tall = document.createElement('div');
  tall.style.height = '2000px';
  pop.appendChild(tall);
  const wrap = $('#tb-output-wrap');
  GroupMenus.set(wrap, true); await sleep(120);
  const cs = getComputedStyle(pop);
  push('超高菜单被限高并在内部滚动', pop.style.maxHeight !== '' && cs.overflowY === 'auto',
    'max=' + pop.style.maxHeight + ' ov=' + cs.overflowY);
  push('菜单不越过视口底部', pop.getBoundingClientRect().bottom <= innerHeight + 1);
  GroupMenus.set(wrap, false);
  tall.remove();
  push('关闭后限制被清掉', pop.style.maxHeight === '');

  return { checks };
})()`;

let code = 0;
(function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-anno-shapes-'));
  const probe = path.join(tmp, 'probe.js');
  fs.writeFileSync(probe, 'module.exports = `' + PROBE + '`;');
  try {
    const r = runProbe({
      probePath: probe,
      env: { PDFREADER_PROBE_PDF: path.join(__dirname, '..', 'assets', 'sample.pdf'), PDFREADER_PROBE_VISIBLE: '1' },
      timeout: 240000,
      label: 'anno-shapes',
    });
    if (r.fail) code = 1;
  } catch (e) {
    code = 1;
    console.log('  FAIL 探针抛错：' + ((e && e.message) || e));
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  process.exit(code);
})();
