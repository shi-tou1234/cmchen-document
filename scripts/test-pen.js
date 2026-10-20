'use strict';
// 画笔回归测试（无头）：在渲染进程注入真实 pointer 事件序列，复现三类历史 bug 并断言已修复。
// 运行：& node_modules\electron\dist\electron.exe scripts/test-pen.js --no-sandbox --disable-gpu
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer', 'index.html');
const PRELOAD = path.join(__dirname, '..', 'src', 'preload.js');
const SAMPLE = path.join(__dirname, '..', 'assets', 'sample.pdf');

// 注入到渲染进程执行的测试体
const TEST = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fire = (el, type, x, y) => el.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, composed: true, isPrimary: true, pointerId: 1,
    pointerType: 'mouse', button: 0, buttons: 1, clientX: x, clientY: y,
  }));
  const ann = (n) => (App.state.annos.get(n) || []);

  if (!window.pdfjsLib || !App.state.pdfDoc) return { fatal: 'pdf not loaded' };
  const s1 = document.querySelector('#page-1 .anno');
  const s2 = document.querySelector('#page-2 .anno');
  if (!s1 || !s2) return { fatal: 'pages missing' };
  const r1 = s1.getBoundingClientRect(), r2 = s2.getBoundingClientRect();
  Anno.setTool('pen');
  await sleep(30);

  // A. 甩到下一页并在下一页抬手：笔迹必须只归属落笔页，绝不能串页
  fire(s1, 'pointerdown', r1.left + 60, r1.top + 60);
  for (let i = 1; i <= 8; i++) fire(window, 'pointermove', r1.left + 60 + i * 10, r1.top + 60 + i * 6);
  fire(s2, 'pointermove', r2.left + 80, r2.top + 40);
  fire(s2, 'pointerup', r2.left + 80, r2.top + 40);
  await sleep(30);
  const A = {
    onPage1: ann(1).length,
    leakedToPage2: ann(2).length,
    page2HasStrayNodes: s2.childElementCount,
  };

  // B. 抬手落在页面外（工具栏）：drawing 必须复位，不能「停不下来」继续画
  const nBefore = ann(1).length;
  fire(s1, 'pointerdown', r1.left + 100, r1.top + 240);
  fire(window, 'pointermove', r1.left + 120, r1.top + 260);
  fire(document.getElementById('toolbar'), 'pointerup', 30, 10);
  await sleep(20);
  fire(s1, 'pointermove', r1.left + 320, r1.top + 320);
  fire(s1, 'pointermove', r1.left + 360, r1.top + 340);
  await sleep(20);
  const B = {
    stillDrawingTempNodes: s1.querySelectorAll('g').length,
    countGrewAfterRelease: ann(1).length > nBefore + 1,
  };
  Anno.clearPage();

  // C. 误点（按下即抬起、未拖动）：不应留下任何标注
  const c0 = ann(1).length;
  fire(s1, 'pointerdown', r1.left + 40, r1.top + 40);
  fire(window, 'pointerup', r1.left + 40, r1.top + 40);
  await sleep(20);
  const C = { created: ann(1).length - c0 };

  // D. 抽稀 + 平滑：慢速拖动 + 亚像素抖动不应产生海量冗余点，且渲染为平滑 path
  fire(s1, 'pointerdown', r1.left + 60, r1.top + 420);
  for (let i = 1; i <= 300; i++) {
    fire(window, 'pointermove', r1.left + 60 + i * 0.2, r1.top + 420 + (i % 2 ? 0.02 : -0.02));
  }
  fire(window, 'pointerup', r1.left + 120, r1.top + 420);
  await sleep(30);
  const last = ann(1)[ann(1).length - 1];
  const node = s1.querySelector('path:last-of-type') || s1.lastElementChild;
  const D = {
    injected: 301, stored: last ? last.pts.length : -1,
    thinned: !!last && last.pts.length < 120,
    isSmoothPath: !!node && node.tagName === 'path' && node.getAttribute('d').indexOf('Q') >= 0,
  };

  // F. 把 .anno 叠加层直接光栅化并数彩色像素：绕开窗口截图的合成不确定性，
  //    证明笔迹的 SVG 几何本身真的能画出可见线条。
  const sc = r1.width / 612; // 单位 → CSS px
  fire(s1, 'pointerdown', r1.left + 60 * sc, r1.top + 540 * sc);
  for (let i = 1; i <= 80; i++) fire(window, 'pointermove', r1.left + (60 + i * 6) * sc, r1.top + (540 + i * 1.2) * sc);
  fire(window, 'pointerup', r1.left + 540 * sc, r1.top + 636 * sc);
  await sleep(40);
  const xml = new XMLSerializer().serializeToString(s1);
  const inkPx = await new Promise((resolve) => {
    const im = new Image();
    im.onload = () => {
      const c = document.createElement('canvas'); c.width = 612; c.height = 792;
      const cx = c.getContext('2d');
      cx.drawImage(im, 0, 0, 612, 792);
      const d = cx.getImageData(0, 0, 612, 792).data;
      let red = 0;
      for (let i = 0; i < 612 * 792; i++) {
        if (d[i * 4] > 150 && d[i * 4 + 1] < 120 && d[i * 4 + 2] < 130 && d[i * 4 + 3] > 100) red++;
      }
      resolve(red);
    };
    im.onerror = () => resolve(-1);
    im.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
  });
  const F = { inkPx, visibleInk: inkPx > 400 };

  // 导出坐标换算仍正常（模型未变，只是渲染层改了）
  const payload = App.buildExportPayload();
  const E = { exportPtsFinite: payload.pages.every((p) => p.shapes.every((sh) => !sh.pts || sh.pts.every((q) => Number.isFinite(q.x) && Number.isFinite(q.y)))) };

  // ===== G/H/I：文字批注（含手势卡死自愈与事件竞态） =====
  const ed = document.getElementById('text-editor');
  const txts = () => ann(1).filter((s) => s.tool === 'text');
  const blurEd = () => ed.dispatchEvent(new FocusEvent('blur'));
  const key = (k, opt) => ed.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true }, opt || {})));

  // G. 上一笔没收到尾（在窗口外松手）时，绝不能把后续工具一起锁死
  Anno.setTool('pen');
  fire(s1, 'pointerdown', r1.left + 30, r1.top + 700);
  for (let i = 1; i <= 5; i++) fire(window, 'pointermove', r1.left + 30 + i * 12, r1.top + 700 + i * 4);
  // 故意不发 pointerup，直接换工具落笔
  const gBefore = ann(1).length;
  Anno.setTool('text');
  fire(s1, 'pointerdown', r1.left + 300, r1.top + 700);
  await sleep(40);
  const G = {
    editorOpenedDespiteStuck: !ed.hidden,          // 文字仍能唤起输入框
    stuckStrokeCommitted: ann(1).length > gBefore, // 旧的一笔没丢，被补提交
  };

  // H. Enter 提交 / Shift+Enter 换行 / Esc 取消
  ed.focus(); ed.value = 'note A';
  key('Enter');
  await sleep(30);
  const H1 = { committedOnEnter: txts().some((s) => s.text === 'note A'), editorClosed: ed.hidden };
  fire(s1, 'pointerdown', r1.left + 320, r1.top + 730);
  await sleep(30);
  ed.focus(); ed.value = 'draft';
  key('Enter', { shiftKey: true });
  await sleep(20);
  const H2 = { shiftEnterKeepsEditing: !ed.hidden };
  key('Escape');
  await sleep(20);
  const H3 = { escDiscards: !txts().some((s) => s.text === 'draft') && ed.hidden };

  // I. 输入框已开时再点页面：旧文字要保留、新输入框不能一闪即消失
  fire(s1, 'pointerdown', r1.left + 200, r1.top + 760);
  await sleep(30);
  ed.focus(); ed.value = 'keep me';
  const iBefore = txts().length;
  fire(s1, 'pointerdown', r1.left + 260, r1.top + 760);   // 第二次落笔
  await sleep(40);
  const I = {
    prevTextCommitted: txts().length === iBefore + 1 && txts().some((s) => s.text === 'keep me'),
    newEditorStillOpen: !ed.hidden,
  };
  blurEd();
  await sleep(20);

  // J. 多行：提交含换行的文字，渲染层应拆成多个 tspan（用 fromCharCode 避开模板字面量转义）
  const NL = String.fromCharCode(10);
  fire(s1, 'pointerdown', r1.left + 210, r1.top + 640);
  await sleep(30);
  ed.focus(); ed.value = 'first line' + NL + 'second line';
  key('Enter');
  await sleep(40);
  const jNode = [...s1.querySelectorAll('text')].pop();
  const J = {
    multilineStored: txts().some((s) => s.text.indexOf(NL) > 0),
    tspans: jNode ? jNode.querySelectorAll('tspan').length : 0,
  };

  return { A, B, C, D, E, F, G, H1, H2, H3, I, J, numPages: App.state.numPages };
})()`;

app.whenReady().then(async () => {
  let code = 1;
  try {
    const win = new BrowserWindow({
      show: false, width: 1000, height: 720,
      webPreferences: { nodeIntegration: false, contextIsolation: true, preload: PRELOAD },
    });
    await win.loadFile(RENDERER);
    const buf = fs.readFileSync(SAMPLE);
    win.webContents.send('pdf-opened', { ok: true, fileName: 'sample.pdf', data: new Uint8Array(buf), smoke: false });
    await new Promise((r) => setTimeout(r, 900));
    const res = await win.webContents.executeJavaScript(TEST, true);
    console.log('[test-pen] ' + JSON.stringify(res));
    const pass = res && !res.fatal
      && res.A.onPage1 === 1 && res.A.leakedToPage2 === 0 && res.A.page2HasStrayNodes === 0
      && res.B.stillDrawingTempNodes === 0 && res.B.countGrewAfterRelease === false
      && res.C.created === 0
      && res.D.thinned && res.D.isSmoothPath
      && res.E.exportPtsFinite && res.F.visibleInk
      && res.G.editorOpenedDespiteStuck && res.G.stuckStrokeCommitted
      && res.H1.committedOnEnter && res.H1.editorClosed
      && res.H2.shiftEnterKeepsEditing && res.H3.escDiscards
      && res.I.prevTextCommitted && res.I.newEditorStillOpen
      && res.J.multilineStored && res.J.tspans === 2;
    console.log('[test-pen] ' + (pass ? 'PASS' : 'FAIL'));
    code = pass ? 0 : 2;
  } catch (e) {
    console.error('[test-pen] ERROR', e && e.message ? e.message : e);
    code = 3;
  }
  app.exit(code);
});
