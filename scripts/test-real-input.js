'use strict';
// 用 webContents.sendInputEvent 注入「真实鼠标」事件（走浏览器输入管线 + 命中测试），
// 与之前合成 PointerEvent 的区别：合成事件直接派发到目标元素，绕过了 hit-test，
// 无法证明真实点击能落到标注叠加层上。
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer', 'index.html');
const PRELOAD = path.join(__dirname, '..', 'src', 'preload.js');
const SAMPLE = path.join(__dirname, '..', 'assets', 'sample.pdf');
const OFFSCREEN = process.argv.includes('--offscreen');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe(win) {
  const geo = await win.webContents.executeJavaScript(`(() => {
    if (!App.state.pdfDoc) return null;
    const b = document.querySelector('#page-1 .anno').getBoundingClientRect();
    return { x: Math.round(b.left + b.width * 0.4), y: Math.round(b.top + b.height * 0.35) };
  })()`);
  if (!geo) return { fatal: 'no doc' };

  const wc = win.webContents;
  // sendInputEvent 的回调在部分版本不会被调用，加超时兜底避免卡死
  const once = (p) => Promise.race([p, wait(400)]);
  const mouse = (type, x, y) => once(new Promise((res) => wc.sendInputEvent({ type, x, y, button: 'left', clicks: 1 }, () => res())));

  const out = { geo };

  // 1) 真实鼠标 + 画笔：拖出一条线
  await wc.executeJavaScript("Anno.setTool('pen'); Anno.state.color='#e53935'; 1");
  await mouse('mouseDown', geo.x, geo.y);
  for (let i = 1; i <= 12; i++) await mouse('mouseMove', geo.x + i * 9, geo.y + i * 5);
  await mouse('mouseUp', geo.x + 110, geo.y + 60);
  await wait(120);
  out.pen = await wc.executeJavaScript(`(() => {
    const a = App.state.annos.get(1) || [];
    const node = document.querySelector('#page-1 .anno path');
    return { shapes: a.length, tool: a.length ? a[a.length-1].tool : null,
             pts: a.length && a[a.length-1].pts ? a[a.length-1].pts.length : 0,
             hasPathNode: !!node };
  })()`);

  // 2) 真实鼠标 + 文字工具：点页面应弹出输入框（必须选视口内的点：整页 1210px 比视口高，页面几何中心可能在视口外）
  await wc.executeJavaScript("Anno.setTool('text'); 1");
  const b2 = await wc.executeJavaScript(`(() => { const b=document.querySelector('#page-1 .anno').getBoundingClientRect(); return {x:Math.round(b.left+b.width*0.5), y:Math.round(b.top+Math.min(180, innerHeight-b.top-60))}; })()`);
  await mouse('mouseDown', b2.x, b2.y);
  await mouse('mouseUp', b2.x, b2.y);
  await wait(200);
  out.text = await wc.executeJavaScript(`(() => {
    const ed = document.getElementById('text-editor');
    return { editorOpen: !ed.hidden, focused: document.activeElement === ed };
  })()`);

  // 3) 真实键盘输入 + Enter 提交
  await wc.insertText('real mouse note');
  await wait(80);
  out.typedValue = await wc.executeJavaScript("document.getElementById('text-editor').value");
  await once(new Promise((res) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' }, () => {
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' }, res);
    });
  }));
  await wait(250);
  out.textResult = await wc.executeJavaScript(`(() => {
    const t = (App.state.annos.get(1) || []).filter(s => s.tool === 'text');
    const node = document.querySelector('#page-1 .anno text');
    return { count: t.length, last: t.length ? t[t.length-1].text : null, editorClosed: document.getElementById('text-editor').hidden, svgText: node ? node.textContent : null };
  })()`);

  // 4) 命中测试直查：视口内的页面点，最上层元素到底是谁
  out.hitTest = await wc.executeJavaScript(`(() => {
    const b = document.querySelector('#page-1 .anno').getBoundingClientRect();
    const x = Math.round(b.left + b.width/2), y = Math.round(b.top + 150);
    const el = document.elementFromPoint(x, y);
    const cs = getComputedStyle(document.querySelector('#page-1 .anno'));
    return { at: {x, y}, topElement: el ? (el.tagName + (el.getAttribute && el.getAttribute('class') ? '.' + el.getAttribute('class') : '')) : null,
             annoPointerEvents: cs.pointerEvents };
  })()`);
  out.pass = out.pen.shapes === 1 && out.pen.hasPathNode
    && out.text.editorOpen === true && out.text.focused === true
    && out.textResult.count >= 1 && out.textResult.svgText === 'real mouse note';
  return out;
}

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      show: false, width: 1000, height: 760,
      webPreferences: { nodeIntegration: false, contextIsolation: true, preload: PRELOAD, offscreen: OFFSCREEN },
    });
    await win.loadFile(RENDERER);
    win.webContents.send('pdf-opened', { ok: true, fileName: 'sample.pdf', data: new Uint8Array(fs.readFileSync(SAMPLE)), smoke: false });
    await wait(1000);
    const res = await probe(win);
    fs.writeFileSync(path.join(require('os').tmpdir(), 'pdfreader-real-input.json'), JSON.stringify(res, null, 1));
    console.log('[real-input] ' + (res.pass ? 'PASS' : 'FAIL') + ' (details -> %TEMP%\\pdfreader-real-input.json)');
  } catch (e) {
    console.error('[real-input] ERROR', e && e.message ? e.message : e);
  }
  app.exit(0);
});
