'use strict';
/*
 * 持续修复复查 H01 的回归：离开 / 关闭文档时，必须把「回执期间新画的内容」也存下来。
 *
 * 复现方式沿用审查脚本：拦下真实 anno-save 的**回执**（磁盘写入照常发生），
 * 页面仍停在 A 时用真实 pointer 事件画一条新线，再放走回执。
 * 以前 flushBeforeLeave / handleWillClose 一次保存成功就放行，新线随切文档消失。
 *
 * 覆盖：打开另一份文档（真切换）、关标签（真关闭）、关窗（真关窗握手）、
 *       补存失败时留在原文档、普通无编辑切换不多存。
 *
 * 运行：node scripts/test-leave-save-boundary.js
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-leave-save-'));

let fail = 0;
let total = 0;
function check(name, ok, detail) {
  total++;
  if (!ok) { fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  <- ' + JSON.stringify(detail) : '')); }
  else console.log('  ok   ' + name);
}
function hashName(p) {
  return crypto.createHash('sha1').update(path.resolve(p)).digest('hex').slice(0, 20) + '.json';
}
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } }
function cleanEnv() {
  const e = Object.assign({}, process.env);
  delete e.ELECTRON_RUN_AS_NODE;
  delete e.NODE_OPTIONS;
  return e;
}

const HARNESS = `'use strict';
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');
const ROOT = __ROOT__, CFG = __CFG__;
const realWrite = fs.writeFileSync;
const realHandle = ipcMain.handle;
let savesForA = 0;
let release = null;
const holdFirst = CFG.mode !== 'plain';

// 只拦「回执」：真实的 sidecar 写入先照常完成，再让 renderer 等着。
ipcMain.handle = function (channel, fn) {
  return realHandle.call(this, channel, async (e, info) => {
    if (channel === 'anno-save' && info && info.path === CFG.a) {
      savesForA++;
      if (CFG.mode === 'failSecond' && savesForA >= 2) {
        return { ok: false, error: '注入：第二次补存失败' };
      }
      const r = await fn(e, info);
      if (holdFirst && savesForA === 1) await new Promise((resolve) => { release = resolve; });
      return r;
    }
    return fn(e, info);
  });
};

process.env.PDFREADER_TEST = '1';
process.env.PDFREADER_HIDDEN = '1';
process.env.PDFREADER_NO_AUTO_INDEX = '1';
process.env.PDFREADER_LIBRARY = CFG.libFile;
process.env.PDFREADER_DATA_DIR = CFG.data;
app.setPath('userData', CFG.ud);
require(path.join(ROOT, 'src/main.js'));

let win = null;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (fn, arg) => win.webContents.executeJavaScript('(' + fn.toString() + ')(' + JSON.stringify(arg) + ')', true);
async function until(fn) {
  for (let i = 0; i < 200; i++) { const r = await fn(); if (r) return r; await pause(40); }
  throw new Error('wait timeout');
}
function openDoc(file) {
  win.webContents.send('pdf-opened', {
    ok: true, filePath: file, fileName: path.basename(file), startPage: 1,
    data: new Uint8Array(fs.readFileSync(file)),
  });
}
function drawLine() {
  return run(() => {
    LibraryUI.hide();
    Anno.setTool('line');
    const svg = App.pageEl(1).querySelector('.anno');
    const p1 = new DOMPoint(80, 90).matrixTransform(svg.getScreenCTM());
    const p2 = new DOMPoint(210, 170).matrixTransform(svg.getScreenCTM());
    svg.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 91, clientX: p1.x, clientY: p1.y }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 91, clientX: p2.x, clientY: p2.y }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 91, clientX: p2.x, clientY: p2.y }));
    const shapes = App.state.annos.get(1) || [];
    const fresh = shapes.find((s) => s.tool === 'line');
    return { id: fresh ? fresh.id : '', n: shapes.length, unsaved: App.annoHasUnsaved(), path: App.state.filePath };
  });
}

app.whenReady().then(async () => {
  await pause(250);
  win = BrowserWindow.getAllWindows()[0];
  if (win && win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
  win.webContents.setBackgroundThrottling(false);
  await pause(400);
  const result = { mode: CFG.mode, savesForA: 0, edit: null, after: null, error: '' };
  try {
    openDoc(CFG.a);
    await until(() => run((a) => App.state.filePath === a && App.state.annoState.status === 'ok' && !!App.state.rendered.get(1), CFG.a));

    if (CFG.mode === 'plain') {
      openDoc(CFG.b);
      await until(() => run((b) => App.state.filePath === b, CFG.b));
      result.savesForA = savesForA;
      realWrite(CFG.out, JSON.stringify(result));
      app.exit(0);
      return;
    }

    // 发起离开：真切换 / 真关标签 / 真关窗握手
    if (CFG.mode === 'switch' || CFG.mode === 'failSecond') openDoc(CFG.b);
    else if (CFG.mode === 'closeTab') await run(() => { App.closeTab(App.activeTabId); return true; });
    else if (CFG.mode === 'closeWindow') win.close();

    await until(() => release !== null);
    result.edit = await drawLine();
    realWrite(CFG.editOut, JSON.stringify(result.edit));   // 关窗场景窗口会消失，先落证据
    release();

    if (CFG.mode === 'closeWindow') {
      // closeReady 会真的关窗并退出 app，磁盘结果由 Node 侧在进程结束后检查
      await pause(1200);
      result.after = { closed: true };
      realWrite(CFG.out, JSON.stringify(result));
      app.exit(0);
      return;
    }
    if (CFG.mode === 'switch') {
      await until(() => run((b) => App.state.filePath === b, CFG.b));
    } else if (CFG.mode === 'closeTab') {
      await until(() => run(() => App.state.filePath === ''));
    } else {
      await pause(350);   // 补存失败：给界面一点时间，但别等自动保存把线又存上
    }
    result.savesForA = savesForA;
    result.after = await run(() => ({
      path: App.state.filePath,
      ids: [...App.state.annos.values()].flat().map((s) => s.id),
      unsaved: App.annoHasUnsaved(),
    }));
  } catch (err) {
    result.error = String((err && err.stack) || err);
  }
  realWrite(CFG.out, JSON.stringify(result));
  app.exit(0);
}).catch((err) => {
  try { realWrite(CFG.out, JSON.stringify({ fatal: String((err && err.stack) || err) })); } catch (_) {}
  app.exit(1);
});
setTimeout(() => { try { realWrite(CFG.out, JSON.stringify({ timeout: true })); } catch (_) {} app.exit(3); }, 45000);
`;

function makeCase(mode) {
  const dir = path.join(tmp, mode);
  const ud = path.join(dir, 'ud');
  const annoDir = path.join(ud, 'annotations');
  fs.mkdirSync(annoDir, { recursive: true });
  const a = path.join(dir, 'a.pdf');
  const b = path.join(dir, 'b.pdf');
  for (const p of [a, b]) fs.copyFileSync(path.join(ROOT, 'assets/sample.pdf'), p);
  const sidecar = path.join(annoDir, hashName(a));
  fs.writeFileSync(sidecar, JSON.stringify({
    path: a, saved: 1,
    pages: [{ page: 1, shapes: [{ id: 'aORIGINAL0001', tool: 'text', text: 'already saved', at: { x: 20, y: 30 }, size: 14, color: '#000000' }] }],
  }));
  fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify({
    version: 8, collections: [], searches: [], tagColors: {}, feeds: [], noteAliases: {}, annoTags: {}, annoMeta: {}, items: [],
  }));
  const cfg = {
    mode, dir, ud, a, b,
    libFile: path.join(dir, 'library.json'),
    data: path.join(dir, 'data'),
    out: path.join(dir, 'out.json'),
    editOut: path.join(dir, 'edit.json'),
  };
  const hf = path.join(dir, 'harness.cjs');
  fs.writeFileSync(hf, HARNESS.split('__ROOT__').join(JSON.stringify(ROOT)).split('__CFG__').join(JSON.stringify(cfg)));
  const r = spawnSync(ELECTRON, [hf, '--no-sandbox', '--disable-gpu', '--disable-background-timer-throttling'], {
    cwd: ROOT, env: cleanEnv(), encoding: 'utf8', timeout: 90000, windowsHide: true,
  });
  fs.writeFileSync(path.join(dir, 'log.txt'), String((r && r.stdout) || '') + String((r && r.stderr) || ''));
  return { cfg, res: readJson(cfg.out) || {}, edit: readJson(cfg.editOut) || null };
}

function shapeIdsOnDisk(cfg) {
  const p = path.join(cfg.ud, 'annotations', hashName(cfg.a));
  const body = readJson(p);
  return ((body && body.pages) || []).flatMap((x) => (x.shapes || []).map((s) => s.id));
}
function lineId(res, edit) {
  return (res.edit && res.edit.id) || (edit && edit.id) || '';
}

function runCases() {
  // ① 真实 A → B 切换：等待回执期间画的线必须落盘
  {
    const { cfg, res, edit } = makeCase('switch');
    const id = lineId(res, edit);
    check('H01 切换场景没有脚本错误', !res.error && !res.fatal, res.error || res.fatal || res.timeout);
    check('H01 回执前新线确实进入模型且仍 dirty', !!id && res.edit.n === 2 && res.edit.unsaved === true, res.edit);
    check('H01 放行后确实切到了 B', res.after && res.after.path === cfg.b, res.after);
    check('H01 新线已写入 A 的 sidecar', !!id && shapeIdsOnDisk(cfg).includes(id), { id, disk: shapeIdsOnDisk(cfg) });
    check('H01 原有标注没有丢', shapeIdsOnDisk(cfg).includes('aORIGINAL0001'), shapeIdsOnDisk(cfg));
  }
  // ② 真实关标签：同样要补存后才能关掉
  {
    const { cfg, res, edit } = makeCase('closeTab');
    const id = lineId(res, edit);
    check('H01 关标签场景没有脚本错误', !res.error && !res.fatal, res.error || res.fatal || res.timeout);
    check('H01 关标签后文档确实关掉了', res.after && res.after.path === '', res.after);
    check('H01 关标签前新线已落盘', !!id && shapeIdsOnDisk(cfg).includes(id), { id, disk: shapeIdsOnDisk(cfg) });
  }
  // ③ 真实关窗握手：进程结束后看磁盘
  {
    const { cfg, res, edit } = makeCase('closeWindow');
    const id = lineId(res, edit);
    check('H01 关窗场景没有脚本错误', !res.error && !res.fatal, res.error || res.fatal || res.timeout);
    check('H01 关窗前新线已落盘', !!id && shapeIdsOnDisk(cfg).includes(id), { id, disk: shapeIdsOnDisk(cfg) });
  }
  // ④ 补存失败：留在 A，新线仍在内存，不能静默切走
  {
    const { cfg, res } = makeCase('failSecond');
    check('H01 补存失败场景没有脚本错误', !res.error && !res.fatal, res.error || res.fatal || res.timeout);
    check('H01 补存失败后仍停留在 A', res.after && res.after.path === cfg.a, res.after);
    check('H01 补存失败后新线仍在内存', res.edit && !!res.edit.id && res.after && res.after.ids.includes(res.edit.id), res.after);
    check('H01 补存失败后仍标记未保存', res.after && res.after.unsaved === true, res.after);
  }
  // ⑤ 普通无编辑切换：不多写一次盘
  {
    const { res } = makeCase('plain');
    check('H01 普通切换没有脚本错误', !res.error && !res.fatal, res.error || res.fatal || res.timeout);
    check('H01 普通切换只保存一次', res.savesForA === 1, res.savesForA);
  }
}

runCases();
console.log('[leave-save-boundary] ' + (fail ? 'FAIL ' : 'PASS ') + '(' + total + ')');
if (!fail && tmp.startsWith(path.join(os.tmpdir(), 'trove-leave-save-'))) {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
}
process.exitCode = fail ? 1 : 0;
