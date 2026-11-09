'use strict';
/*
 * 文本层几何 / 鼠标拖选回归（v36）。
 *
 * 曾经的毛病：文本层每个隐形 span 只按 font-size 摆位，宽度取回退字体的自然宽度
 * （和 PDF 记录的 advance 能差 10%+），高度又继承了 body 的 line-height: 1.5。
 * 结果一行的右半段没有可命中的文本，鼠标按在那里等于按在空白处，Chromium 把选区
 * 锚点丢到文档开头 —— 用户看到的就是「拖选从第一行一路选到光标，只圈住前半部分」。
 *
 * 这里用 webContents.sendInputEvent 注入真实鼠标事件（走浏览器输入管线 + 命中测试），
 * 断言：
 *   1. 每个 span 的盒子宽度 == PDF 文本项宽度，高度 == 字号（相邻行盒子不重叠）；
 *   2. 在文字右侧的空白处按下再往左拖，不能选出任何东西；
 *   3. 从第 6 行中部拖到第 7 行中部，选中的就是这两行；
 *   4. 按在第 6 行盒子的下缘，锚点仍是第 6 行（不是下一行）。
 *
 * 运行：这个脚本自己 require('electron') 并调 app.whenReady()，必须由 Electron 执行，
 *       不能用 node 直接跑（会报 Cannot read properties of undefined (reading 'whenReady')）：
 *       node_modules/electron/dist/electron.exe scripts/test-textlayer-select.js --no-sandbox
 *       建议再带一个 --user-data-dir=<临时目录>，避免碰到真实 userData。
 */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { PDFDocument, StandardFonts } = require('pdf-lib');

const RENDERER = path.join(__dirname, '..', 'src', 'renderer', 'index.html');
const PRELOAD = path.join(__dirname, '..', 'src', 'preload.js');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 学术论文常见排版：10pt 字 + 12pt 行距（行距比字号大，盒子本该互不重叠）
async function makeDensePdf(file) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  const page = doc.addPage([612, 792]);
  let y = 740;
  for (let i = 0; i < 50; i++) {
    page.drawText(`Row ${String(i + 1).padStart(2, '0')} alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu`, {
      x: 56, y, size: 10, font,
    });
    y -= 12;
  }
  fs.writeFileSync(file, await doc.save());
}

async function probe(win) {
  const wc = win.webContents;
  const checks = [];
  const push = (name, ok, detail) => checks.push([name, !!ok, detail === undefined ? '' : String(detail)]);

  const js = (code) => wc.executeJavaScript(code);
  const waitFor = async (code, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 15000)) {
      if (await js(code)) return true;
      await wait(120);
    }
    return false;
  };

  const loaded = await waitFor('!!(window.App && App.state.pdfDoc && App.state.rendered.get(1))', 25000);
  push('PDF 已打开并渲染首页', loaded);
  if (!loaded) return { checks };
  await waitFor("!!document.querySelector('#page-1 .textlayer span')", 10000);
  await wait(400);

  // ---------- 1. 几何 ----------
  const geo = await js(`(() => {
    const el = document.getElementById('page-1');
    const host = el.querySelector('.textlayer');
    const spans = Array.from(host.querySelectorAll('span'));
    const unitW = el._unit.w;
    const scale = host.getBoundingClientRect().width / unitW;
    const items = App.state.textCache.get(1) || [];
    const rows = spans.map((sp) => {
      const r = sp.getBoundingClientRect();
      const it = items[+sp.dataset.item];
      return {
        text: (sp.textContent || ''),
        w: r.width, h: r.height, top: r.top, bottom: r.bottom, left: r.left, right: r.right,
        pdfW: it ? it.width * scale : 0,
        fs: parseFloat(sp.style.fontSize) * scale,
      };
    });
    const pageRect = el.getBoundingClientRect();
    return { scale, count: spans.length, rows, pageRight: pageRect.right, pageLeft: pageRect.left };
  })()`);

  const widthBad = geo.rows.filter((r) => r.pdfW > 2 && Math.abs(r.w - r.pdfW) > Math.max(1.5, r.pdfW * 0.02));
  push('span 宽度贴合 PDF 字宽（误差 <2%）', geo.count > 5 && widthBad.length === 0,
    'spans=' + geo.count + ' 超差=' + widthBad.length + (widthBad[0] ? ' 例:' + JSON.stringify({ t: widthBad[0].text, w: +widthBad[0].w.toFixed(1), pdfW: +widthBad[0].pdfW.toFixed(1) }) : ''));

  const heightBad = geo.rows.filter((r) => Math.abs(r.h - r.fs) > 1.2);
  push('span 盒高 == 字号（行高锁 1）', geo.count > 5 && heightBad.length === 0,
    '超差=' + heightBad.length + (heightBad[0] ? ' 例:' + JSON.stringify({ t: heightBad[0].text, h: +heightBad[0].h.toFixed(1), fs: +heightBad[0].fs.toFixed(1) }) : ''));

  const sorted = geo.rows.slice().sort((a, b) => a.top - b.top);
  let overlap = 0;
  for (let i = 1; i < sorted.length; i++) if (sorted[i].top < sorted[i - 1].bottom - 0.6) overlap++;
  push('相邻行盒子不纵向重叠', overlap === 0, '重叠行数=' + overlap);

  // ---------- 2. 真实鼠标 ----------
  const once = (p) => Promise.race([p, wait(400)]);
  const mouse = (type, x, y) => once(new Promise((res) => wc.sendInputEvent({ type, x, y, button: 'left', clicks: 1 }, () => res())));
  const drag = async (from, to, steps) => {
    await js('window.getSelection().removeAllRanges(); 1');
    await mouse('mouseDown', Math.round(from.x), Math.round(from.y));
    const n = steps || 6;
    for (let i = 1; i <= n; i++) {
      await mouse('mouseMove', Math.round(from.x + (to.x - from.x) * i / n), Math.round(from.y + (to.y - from.y) * i / n));
      await wait(25);
    }
    await mouse('mouseUp', Math.round(to.x), Math.round(to.y));
    await wait(120);
    return js(`(() => {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return { len: 0, text: '' };
      return { len: sel.toString().length, text: sel.toString() };
    })()`);
  };

  const pick = (i) => geo.rows[i];
  const r6 = pick(6), r7 = pick(7);
  const mid = (r) => ({ x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 });

  if (r6 && r7) {
    // 2a. 文字右侧的空白处按下 → 不能选出东西
    const gap = await drag({ x: r6.right + 30, y: mid(r6).y }, { x: r6.left + 40, y: mid(r6).y });
    push('文字右侧空白处按下拖不动选区', gap.len === 0, JSON.stringify(gap.text.slice(0, 40)));

    // 2b. 第 6 行行首 → 第 7 行中部（跨两行）
    const two = await drag({ x: r6.left + 2, y: mid(r6).y }, { x: r7.left + r7.w * 0.5, y: mid(r7).y });
    const rowsIn = (two.text.match(/Row/g) || []).length;
    push('跨行拖选只选这两行', two.len > 20 && two.len < 260 && rowsIn === 2,
      JSON.stringify({ len: two.len, rows: rowsIn, head: two.text.slice(0, 60) }));

    // 2c. 第 6 行盒子下缘按下：锚点必须还是第 6 行
    const edge = await drag({ x: r6.left + 2, y: r6.bottom - 1.5 }, { x: r6.left + r6.w * 0.6, y: r6.bottom - 1.5 });
    const sel = edge.text.trim();
    // 从行首拖起，选中文本的第一行必须是第 6 行（旧实现会落到第 7 行）
    const want = (r6.text.match(/Row \d+/) || [''])[0];
    const got = (sel.match(/Row \d+/) || [''])[0];
    push('按在行盒子下缘仍命中本行', !!want && got === want,
      JSON.stringify({ got, want, len: sel.length, text: sel.slice(0, 30) }));
  } else {
    push('页面行数足够做拖选用例', false, 'rows=' + geo.count);
  }

  return { checks, geo: { scale: geo.scale, count: geo.count } };
}

app.whenReady().then(async () => {
  let code = 1;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-tlsel-'));
  try {
    const pdf = path.join(tmp, 'dense.pdf');
    await makeDensePdf(pdf);
    const win = new BrowserWindow({
      show: false, width: 1000, height: 760,
      webPreferences: { nodeIntegration: false, contextIsolation: true, preload: PRELOAD },
    });
    await win.loadFile(RENDERER);
    win.webContents.send('pdf-opened', { ok: true, fileName: 'dense.pdf', data: new Uint8Array(fs.readFileSync(pdf)), smoke: false });
    await wait(1000);
    const res = await probe(win);
    let failed = 0;
    for (const [name, ok, detail] of res.checks) {
      if (!ok) failed++;
      console.log('  ' + (ok ? 'ok  ' : 'FAIL') + ' ' + name + (detail ? '  <- ' + detail : ''));
    }
    console.log('[textlayer-select] ' + (failed ? 'FAIL' : 'PASS') + ' (' + res.checks.length + ')');
    code = failed ? 1 : 0;
  } catch (e) {
    console.error('[textlayer-select] ERROR', e && e.message ? e.message : e);
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  app.exit(code);
});
