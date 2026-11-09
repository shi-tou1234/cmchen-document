'use strict';
/*
 * 持续修复复查 I01 的回归：**打开中的文档**被改名后，后续标注必须落到新路径。
 *
 * 根因有两层：
 *   1. 订阅位置写错（pdfBridge.onFilesRenamed vs pdfBridge.lib.onFilesRenamed），
 *      整段监听从未执行；
 *   2. 就算执行了，旧代码也只改 state/tab 的路径，annoDoc.path 与 annoRestore.path
 *      还是旧值，saveAnnosNow 会因 path0 !== s.filePath 拒绝保存。
 * 所以断言不能只看「改名接口 ok:true」或「重新打开能看到旧标注」，必须检查
 * **改名后新画的那条线确实写进了新路径的 sidecar**。
 *
 * 覆盖：已打开文档改名、600ms 防抖内未落盘的笔迹、保存回执跨改名、
 *       后台标签、连续两次改名、会话路径。
 *
 * 运行：node scripts/test-rename-active-doc.js
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-rename-active-'));

let fail = 0;
let total = 0;
function check(name, ok, detail) {
  total++;
  if (!ok) { fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  <- ' + JSON.stringify(detail) : '')); }
  else console.log('  ok   ' + name);
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
let holdPath = '', holdBefore = false;
let release = null;
let held = false;

// 只拦指定文档的第一次 anno-save：
//   holdBefore —— 在真实写入之前停住（用来验证「在途保存跨改名」会被重定向到新路径）；
//   holdAfter  —— 真实写入之后停住回执（H01 用的方式）。
ipcMain.handle = function (channel, fn) {
  return realHandle.call(this, channel, async (e, info) => {
    if (channel === 'anno-save' && holdPath && info && info.path === holdPath && !held) {
      held = true;
      if (holdBefore) {
        await new Promise((resolve) => { release = resolve; });
        return fn(e, info);
      }
      const r = await fn(e, info);
      await new Promise((resolve) => { release = resolve; });
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
const L = require(path.join(ROOT, 'src/library.js'));

let win = null;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (fn, arg) => win.webContents.executeJavaScript('(' + fn.toString() + ')(' + JSON.stringify(arg) + ')', true);
async function until(fn, label) {
  for (let i = 0; i < 200; i++) { const r = await fn(); if (r) return r; await pause(40); }
  throw new Error('wait timeout: ' + (label || ''));
}
function openDoc(file) {
  win.webContents.send('pdf-opened', {
    ok: true, filePath: file, fileName: path.basename(file), startPage: 1,
    data: new Uint8Array(fs.readFileSync(file)),
  });
}
function drawLine(pointerId) {
  return run((pid) => {
    LibraryUI.hide();
    Anno.setTool('line');
    const svg = App.pageEl(1).querySelector('.anno');
    const p1 = new DOMPoint(80, 90).matrixTransform(svg.getScreenCTM());
    const p2 = new DOMPoint(210, 170).matrixTransform(svg.getScreenCTM());
    svg.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: pid, clientX: p1.x, clientY: p1.y }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: pid, clientX: p2.x, clientY: p2.y }));
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: pid, clientX: p2.x, clientY: p2.y }));
    const shapes = App.state.annos.get(1) || [];
    const fresh = shapes.filter((s) => s.tool === 'line').pop();
    if (!fresh) throw new Error('pointer drawing failed');
    return { id: fresh.id, path: App.state.filePath, dirty: App.annoHasUnsaved() };
  }, pointerId);
}
async function openAndWait(file) {
  openDoc(file);
  await until(() => run((f) => App.state.filePath === f && (App.state.annoState.status === 'ok' || App.state.annoState.status === 'missing') && !!App.state.rendered.get(1), file), file);
}
async function rename(key) {
  return run(async (k) => await pdfBridge.lib.renameFile([k]), key);
}

app.whenReady().then(async () => {
  await pause(250);
  win = BrowserWindow.getAllWindows()[0];
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
  win.webContents.setBackgroundThrottling(false);
  await pause(400);
  const R = {};
  try {
    // ---------- A. 已打开文档改名后继续画，新线必须进新 sidecar ----------
    {
      const doc = path.join(CFG.dir, 'a.pdf');
      fs.copyFileSync(path.join(ROOT, 'assets/sample.pdf'), doc);
      fs.writeFileSync(sidecarFor(doc), JSON.stringify({
        path: doc, saved: 1,
        pages: [{ page: 1, shapes: [{ id: 'aORIGINAL_A', tool: 'text', text: 'original', at: { x: 20, y: 30 } }] }],
      }));
      const it = L.addItem({ title: 'Active Renamed' });
      L.setAttachment(it.key, doc);
      await openAndWait(doc);
      const resp = await rename(it.key);
      const newPath = resp.changes && resp.changes[0] && resp.changes[0].newPath;
      await until(() => run((f) => App.state.filePath === f, newPath), 'path migrated');
      const edit = await drawLine(101);
      const saved = await run(async () => await App.flushAnnos());
      await pause(500);
      const body = readJson(sidecarFor(newPath)) || {};
      const ids = ((body.pages || [])[0] || {}).shapes || [];
      R.a = {
        newPath, edit, saved,
        statePath: await run(() => App.state.filePath),
        tabPaths: await run(() => App.tabs.map((t) => t.filePath)),
        ids: ids.map((s) => s.id),
        oldSidecar: fs.existsSync(sidecarFor(doc)),
        session: (() => { try { return fs.readFileSync(path.join(CFG.ud, 'session.json'), 'utf8'); } catch (_) { return ''; } })(),
      };
    }

    // ---------- B. 600ms 防抖内还没落盘的笔迹，改名后仍保留 ----------
    {
      const doc = path.join(CFG.dir, 'b.pdf');
      fs.copyFileSync(path.join(ROOT, 'assets/sample.pdf'), doc);
      fs.writeFileSync(sidecarFor(doc), JSON.stringify({ path: doc, saved: 1, pages: [] }));
      const it = L.addItem({ title: 'Debounce Renamed' });
      L.setAttachment(it.key, doc);
      await openAndWait(doc);
      const edit = await drawLine(102);
      const resp = await rename(it.key);           // 不等 600ms 防抖，立刻改名
      const newPath = resp.changes && resp.changes[0] && resp.changes[0].newPath;
      await pause(1800);
      const body = readJson(sidecarFor(newPath)) || {};
      const ids = ((body.pages || [])[0] || {}).shapes || [];
      R.b = { newPath, edit, ids: ids.map((s) => s.id), statePath: await run(() => App.state.filePath) };
    }

    // ---------- C. 保存回执跨改名：在途保存要重定向到新路径 ----------
    {
      const doc = path.join(CFG.dir, 'c.pdf');
      fs.copyFileSync(path.join(ROOT, 'assets/sample.pdf'), doc);
      fs.writeFileSync(sidecarFor(doc), JSON.stringify({ path: doc, saved: 1, pages: [] }));
      const it = L.addItem({ title: 'Inflight Renamed' });
      L.setAttachment(it.key, doc);
      await openAndWait(doc);
      holdBefore = true; holdPath = doc; release = null; held = false;
      const first = await drawLine(103);           // 触发 600ms 防抖保存
      await until(() => release !== null, 'first save held');
      const resp = await rename(it.key);           // 保存还停在写入之前
      const newPath = resp.changes && resp.changes[0] && resp.changes[0].newPath;
      await until(() => run((f) => App.state.filePath === f, newPath), 'path migrated');
      const second = await drawLine(104);
      release();                                    // 放行在途保存：应写到新 sidecar
      await pause(1500);
      const body = readJson(sidecarFor(newPath)) || {};
      const ids = ((body.pages || [])[0] || {}).shapes || [];
      R.c = {
        newPath, first, second,
        ids: ids.map((s) => s.id),
        oldSidecar: fs.existsSync(sidecarFor(doc)),
      };
    }

    // ---------- D. 后台标签：改名后切回去应加载新路径的标注 ----------
    {
      const d1 = path.join(CFG.dir, 'd1.pdf');
      const d2 = path.join(CFG.dir, 'd2.pdf');
      fs.copyFileSync(path.join(ROOT, 'assets/sample.pdf'), d1);
      fs.copyFileSync(path.join(ROOT, 'assets/sample.pdf'), d2);
      fs.writeFileSync(sidecarFor(d1), JSON.stringify({
        path: d1, saved: 1,
        pages: [{ page: 1, shapes: [{ id: 'aORIGINAL_D1', tool: 'text', text: 'd1', at: { x: 10, y: 10 } }] }],
      }));
      const it1 = L.addItem({ title: 'Background Renamed' });
      L.setAttachment(it1.key, d1);
      await openAndWait(d1);
      await openAndWait(d2);                        // 新标签，d1 成为后台标签
      const resp = await rename(it1.key);
      const newD1 = resp.changes && resp.changes[0] && resp.changes[0].newPath;
      const tabPath = await run((f) => {
        const t = App.tabs.find((x) => x.filePath === f);
        return t ? t.filePath : '';
      }, newD1);
      const tabId = await run((f) => {
        const t = App.tabs.find((x) => x.filePath === f);
        return t ? t.id : '';
      }, newD1);
      await run((id) => { App.switchTab(id); return true; }, tabId);
      await until(() => run((f) => App.state.filePath === f && App.state.annoState.status === 'ok' && !!App.state.rendered.get(1), newD1), 'switch to renamed tab');
      R.d = {
        newD1, tabPath,
        statePath: await run(() => App.state.filePath),
        ids: await run(() => [...App.state.annos.values()].flat().map((s) => s.id)),
        oldTab: await run((f) => App.tabs.some((x) => x.filePath === f), d1),
      };
    }

    // ---------- E. 连续两次改名 ----------
    {
      const doc = path.join(CFG.dir, 'e.pdf');
      fs.copyFileSync(path.join(ROOT, 'assets/sample.pdf'), doc);
      fs.writeFileSync(sidecarFor(doc), JSON.stringify({ path: doc, saved: 1, pages: [] }));
      const it = L.addItem({ title: 'Chain One' });
      L.setAttachment(it.key, doc);
      await openAndWait(doc);
      const r1 = await rename(it.key);
      const p1 = r1.changes && r1.changes[0] && r1.changes[0].newPath;
      await until(() => run((f) => App.state.filePath === f, p1), 'first rename');
      L.updateItem(it.key, { title: 'Chain Two' });
      const r2 = await rename(it.key);
      const p2 = r2.changes && r2.changes[0] && r2.changes[0].newPath;
      await until(() => run((f) => App.state.filePath === f, p2), 'second rename');
      const edit = await drawLine(105);
      await run(async () => await App.flushAnnos());
      await pause(500);
      const body = readJson(sidecarFor(p2)) || {};
      const ids = ((body.pages || [])[0] || {}).shapes || [];
      R.e = { p1, p2, edit, ids: ids.map((s) => s.id), statePath: await run(() => App.state.filePath) };
    }
  } catch (err) {
    R.error = String((err && err.stack) || err);
  }
  realWrite(CFG.out, JSON.stringify(R));
  app.exit(0);
}).catch((err) => {
  try { realWrite(CFG.out, JSON.stringify({ fatal: String((err && err.stack) || err) })); } catch (_) {}
  app.exit(1);
});
setTimeout(() => { try { realWrite(CFG.out, JSON.stringify({ timeout: true })); } catch (_) {} app.exit(3); }, 120000);
`;

function hashName(p) {
  return crypto.createHash('sha1').update(path.resolve(p)).digest('hex').slice(0, 20) + '.json';
}

function main() {
  const dir = path.join(tmp, 'run');
  const ud = path.join(dir, 'ud');
  fs.mkdirSync(path.join(ud, 'annotations'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify({
    version: 8, collections: [], searches: [], tagColors: {}, feeds: [], noteAliases: {},
    annoTags: {}, annoMeta: {}, items: [],
  }));
  const cfg = {
    dir, ud,
    libFile: path.join(dir, 'library.json'),
    data: path.join(dir, 'data'),
    out: path.join(dir, 'out.json'),
  };
  const harness = HARNESS
    .split('__ROOT__').join(JSON.stringify(ROOT))
    .split('__CFG__').join(JSON.stringify(cfg))
    // sidecar 路径在主进程里自己算：ud/annotations/<sha1(resolve(p))>.json
    .replace("const realWrite = fs.writeFileSync;",
      "const crypto = require('crypto');\nconst realWrite = fs.writeFileSync;\n" +
      "function sidecarFor(p) { return path.join(CFG.ud, 'annotations', crypto.createHash('sha1').update(path.resolve(p)).digest('hex').slice(0, 20) + '.json'); }\n" +
      "function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } }");
  const hf = path.join(dir, 'harness.cjs');
  fs.writeFileSync(hf, harness);
  const r = spawnSync(ELECTRON, [hf, '--no-sandbox', '--disable-gpu', '--disable-background-timer-throttling'], {
    cwd: ROOT, env: cleanEnv(), encoding: 'utf8', timeout: 180000, windowsHide: true,
  });
  fs.writeFileSync(path.join(dir, 'log.txt'), String((r && r.stdout) || '') + String((r && r.stderr) || ''));
  const R = readJson(cfg.out) || {};

  check('I01 场景执行无脚本错误', !R.error && !R.fatal && !R.timeout, R.error || R.fatal || R.timeout);
  const A = R.a || {};
  check('I01 改名后当前文档路径已更新', !!A.newPath && A.statePath === A.newPath, { path: A.statePath, want: A.newPath });
  check('I01 标签路径也换成新路径', Array.isArray(A.tabPaths) && A.tabPaths.includes(A.newPath), A.tabPaths);
  const aIds = A.ids || [];
  check('I01 改名后新画的线写入新 sidecar', !!A.edit && aIds.includes(A.edit.id), { id: A.edit && A.edit.id, ids: A.ids });
  check('I01 原有标注没有丢', aIds.includes('aORIGINAL_A'), A.ids);
  check('I01 旧路径 sidecar 没有被复活', A.oldSidecar === false, A.oldSidecar);
  let sess = null; try { sess = JSON.parse(A.session || '{}'); } catch (_) {}
  const sessPaths = sess ? [sess.active].concat((sess.tabs || []).map((t) => t.path)) : [];
  check('I01 会话已保存新路径', sessPaths.includes(A.newPath), sessPaths);

  const B = R.b || {};
  const bIds = B.ids || [];
  check('I01 防抖内的笔迹在改名后仍落盘', !!B.edit && bIds.includes(B.edit.id), { id: B.edit && B.edit.id, ids: B.ids });
  check('I01 防抖场景状态路径已更新', B.statePath === B.newPath, B.statePath);

  const C = R.c || {};
  check('I01 在途保存跨改名后两条线都在新 sidecar',
    !!C.first && !!C.second && (C.ids || []).includes(C.first.id) && (C.ids || []).includes(C.second.id),
    { ids: C.ids, first: C.first && C.first.id, second: C.second && C.second.id });
  check('I01 在途保存没有重建旧 sidecar', C.oldSidecar === false, C.oldSidecar);

  const D = R.d || {};
  check('I01 后台标签路径已更新', !!D.newD1 && D.tabPath === D.newD1, { tabPath: D.tabPath, want: D.newD1 });
  check('I01 后台标签里不再有旧路径', D.oldTab === false, D.oldTab);
  check('I01 切回后台标签能加载新路径的标注', D.statePath === D.newD1 && (D.ids || []).includes('aORIGINAL_D1'), { path: D.statePath, ids: D.ids });

  const E = R.e || {};
  check('I01 连续两次改名后状态路径正确', !!E.p2 && E.statePath === E.p2, { path: E.statePath, want: E.p2 });
  check('I01 连续两次改名后仍能保存到最终路径', !!E.edit && (E.ids || []).includes(E.edit.id), { ids: E.ids });

  console.log('[rename-active-doc] ' + (fail ? 'FAIL ' : 'PASS ') + '(' + total + ')');
  if (!fail && tmp.startsWith(path.join(os.tmpdir(), 'trove-rename-active-'))) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  process.exitCode = fail ? 1 : 0;
}

main();
