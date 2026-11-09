'use strict';
/*
 * 修复验收复查 J01 / J02 / J03 的回归：**路径不是文档身份**。
 *
 * 上一轮为了让「改名后在途保存落到新路径」，把所有 sidecar 访问都做成「沿改名历史
 * 全局重定向」（annoFileFor 隐式跟随 renamedAway）。代价是路径彻底失去了本来的含义：
 *   J01  A→B→A 时第二次准备阶段把 hash(A) 误判成 hash(B)，返回 same，标注留在 B，
 *        而用户打开的 A 里一条标注都没有；
 *   J02  旧路径 A 被另一份 PDF 复用时，新文档读到了 B 的标注，新笔迹也写进 B；
 *   J03  恢复期间改名，回执被「路径没变才算同一份文档」的判定丢掉，annoState 停在
 *        unknown，之后保存与导航全被拦死。
 *
 * 本轮的模型：
 *   · annoFileFor 是纯函数（给什么路径算什么 hash），prepare / finish / rollback /
 *     journal / 恢复 / 普通加载全部只认真实路径；
 *   · 只有「已经发出、还没落地」的请求才跟随改名，靠渲染层下发的**文档会话 id** +
 *     「该会话自己走过的路径」来认领；复用旧路径的新文档有新的会话 id，绝不会被认领。
 *
 * 运行：node scripts/test-anno-session-identity.js
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-anno-session-'));

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

// 只拦指定通道上「指定路径的第一次请求」，用来把某个请求停在半路上去做别的事。
// 关注的三个通道：anno-save（在途保存）、anno-load / bookmarks-load（在途恢复）。
let holdChannel = '', holdPath = '', holdBefore = false;
let release = null, held = false;
let failBookmarkOnce = false;
function holdOn(channel, p, before) {
  holdChannel = channel; holdPath = p; holdBefore = before; release = null; held = false;
}
function holdOff() { holdChannel = ''; holdPath = ''; release = null; held = false; }

ipcMain.handle = function (channel, fn) {
  return realHandle.call(this, channel, async (e, info) => {
    const call = () => {
      if (channel !== 'bookmarks-save' || !failBookmarkOnce) return fn(e, info);
      failBookmarkOnce = false;
      const write = fs.writeFileSync;
      fs.writeFileSync = function () {
        throw Object.assign(new Error('bookmark queue test disk failure'), { code: 'ENOSPC' });
      };
      try { return fn(e, info); } finally { fs.writeFileSync = write; }
    };
    if (channel === holdChannel && holdPath && info && info.path === holdPath && !held) {
      held = true;
      if (holdBefore) {
        await new Promise((resolve) => { release = resolve; });
        return call();
      }
      const r = await call();
      await new Promise((resolve) => { release = resolve; });
      return r;
    }
    return call();
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
async function until(fn, label, tries) {
  for (let i = 0; i < (tries || 240); i++) { const r = await fn(); if (r) return r; await pause(40); }
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
    return { id: fresh.id, path: App.state.filePath };
  }, pointerId);
}
async function openAndWait(file) {
  openDoc(file);
  await until(() => run((f) => App.state.filePath === f
    && (App.state.annoState.status === 'ok' || App.state.annoState.status === 'missing')
    && !!App.state.rendered.get(1), file), file);
}
async function waitPath(file) {
  await until(() => run((f) => App.state.filePath === f, file), 'migrate ' + file);
}
async function rename(key) {
  const r = await run(async (k) => await pdfBridge.lib.renameFile([k]), key);
  return { resp: r, newPath: (r && r.changes && r.changes[0] && r.changes[0].newPath) || '' };
}
// 一份文档的「全量状态」：内存里的标注 id、annoState、以及它当前认的 sidecar 路径
function docState() {
  return run(() => ({
    path: App.state.filePath,
    status: App.state.annoState && App.state.annoState.status,
    annoPath: (App.state.annoState && App.state.annoState.annoPath) || '',
    dirty: App.annoHasUnsaved(),
    ids: [...App.state.annos.values()].flat().map((s) => s.id),
  }));
}
function seedSidecar(file, ids, bookmarks) {
  const pages = ids.length
    ? [{ page: 1, shapes: ids.map((id, i) => ({ id, tool: 'text', text: id, at: { x: 20 + i * 4, y: 30 } })) }]
    : [];
  const body = { path: file, saved: 1, pages };
  if (bookmarks) body.bookmarks = bookmarks;
  fs.writeFileSync(sidecarFor(file), JSON.stringify(body));
}
function idsOf(file) {
  const body = readJson(sidecarFor(file)) || {};
  return ((body.pages || [])[0] || {}).shapes ? (((body.pages || [])[0].shapes) || []).map((s) => s.id) : [];
}

app.whenReady().then(async () => {
  await pause(250);
  win = BrowserWindow.getAllWindows()[0];
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
  win.webContents.setBackgroundThrottling(false);
  await pause(400);
  const R = {};
  try {
    // ---------- J01 A：A→B→A 往返，标注必须跟着回到 A ----------
    {
      const a = path.join(CFG.dir, 'rt-a.pdf');
      fs.copyFileSync(path.join(ROOT, 'assets/sample.pdf'), a);
      seedSidecar(a, ['RT_ORIG']);
      const it = L.addItem({ title: 'RT One' });
      L.setAttachment(it.key, a);
      await openAndWait(a);

      const r1 = await rename(it.key);                       // rt-a.pdf -> RT One.pdf
      await waitPath(r1.newPath);
      const line = await drawLine(201);
      await run(async () => await App.flushAnnos());
      await pause(400);
      const mid = await docState();
      // 中途状态必须在**这一刻**取样：往返之后 hash(B) 会被删掉，那时再看就什么都看不到了
      const midIds = idsOf(r1.newPath);
      const midExists = fs.existsSync(sidecarFor(r1.newPath));

      L.updateItem(it.key, { title: 'rt-a' });               // 改回原名：RT One.pdf -> rt-a.pdf
      const r2 = await rename(it.key);
      await waitPath(r2.newPath);
      await run(async () => await App.flushAnnos());
      await pause(600);
      const back = await docState();

      R.rt = {
        a, p1: r1.newPath, p2: r2.newPath, line,
        mid,
        back,
        backIds: idsOf(r2.newPath),
        midIds,
        midExists,
        backExists: fs.existsSync(sidecarFor(r1.newPath)),
        annoPathWant: sidecarFor(r2.newPath),
      };
    }

    // ---------- J01 B：A→B→C→A，三段往返 ----------
    {
      const a = path.join(CFG.dir, 'rt3.pdf');
      fs.copyFileSync(path.join(ROOT, 'assets/sample.pdf'), a);
      seedSidecar(a, ['RT3_ORIG']);
      const it = L.addItem({ title: 'RT3 One' });
      L.setAttachment(it.key, a);
      await openAndWait(a);

      const r1 = await rename(it.key);
      await waitPath(r1.newPath);
      const l1 = await drawLine(202);
      L.updateItem(it.key, { title: 'RT3 Two' });
      const r2 = await rename(it.key);
      await waitPath(r2.newPath);
      const l2 = await drawLine(203);
      L.updateItem(it.key, { title: 'rt3' });
      const r3 = await rename(it.key);
      await waitPath(r3.newPath);
      await run(async () => await App.flushAnnos());
      await pause(600);
      R.rt3 = {
        a, p1: r1.newPath, p2: r2.newPath, p3: r3.newPath, l1, l2,
        ids: idsOf(r3.newPath),
        p1Exists: fs.existsSync(sidecarFor(r1.newPath)),
        p2Exists: fs.existsSync(sidecarFor(r2.newPath)),
        state: await docState(),
        annoPathWant: sidecarFor(r3.newPath),
      };
    }

    // ---------- J01 C：连续 9 次改名，每一段画的都要在最终文件里 ----------
    {
      const a = path.join(CFG.dir, 'chain.pdf');
      fs.copyFileSync(path.join(ROOT, 'assets/sample.pdf'), a);
      seedSidecar(a, ['CHAIN_ORIG']);
      const it = L.addItem({ title: 'Chain 0' });
      L.setAttachment(it.key, a);
      await openAndWait(a);
      const paths = [a];
      const drawn = [];
      for (let i = 1; i <= 9; i++) {
        L.updateItem(it.key, { title: 'Chain ' + i });
        const r = await rename(it.key);
        await waitPath(r.newPath);
        paths.push(r.newPath);
        drawn.push(await drawLine(210 + i));
      }
      await run(async () => await App.flushAnnos());
      await pause(700);
      R.chain = {
        paths, drawn,
        final: paths[paths.length - 1],
        ids: idsOf(paths[paths.length - 1]),
        leftovers: paths.slice(0, -1).filter((p) => fs.existsSync(sidecarFor(p))),
        state: await docState(),
        annoPathWant: sidecarFor(paths[paths.length - 1]),
      };
    }

    // ---------- J02 A：旧路径被另一份 PDF 复用，新文档不能认领旧标注 ----------
    {
      const a = path.join(CFG.dir, 'reuse.pdf');
      fs.copyFileSync(path.join(ROOT, 'assets/sample.pdf'), a);
      seedSidecar(a, ['REUSE_ORIG']);
      const it = L.addItem({ title: 'Reuse Old' });
      L.setAttachment(it.key, a);
      await openAndWait(a);
      const r1 = await rename(it.key);
      await waitPath(r1.newPath);
      await run(async () => await App.flushAnnos());
      await pause(500);

      // 旧路径现在放进一份**不同的** PDF
      fs.copyFileSync(path.join(ROOT, 'assets/sample-annotated.pdf'), a);
      const it2 = L.addItem({ title: 'Reuse New' });
      L.setAttachment(it2.key, a);
      await openAndWait(a);
      const beforeDraw = await docState();
      const line = await drawLine(230);
      await run(async () => await App.flushAnnos());
      await pause(600);

      R.reuse = {
        a, p1: r1.newPath, line,
        beforeDraw,
        newIds: idsOf(a),
        oldIds: idsOf(r1.newPath),
        oldSidecarStillThere: fs.existsSync(sidecarFor(r1.newPath)),
      };
    }

    // ---------- J02 B：在途保存跨改名时，旧路径随后被新文档占用的隔离 ----------
    // 顺序受界面本身约束：切文档前必须先 flush 完当前文档，所以在途保存不可能与
    // 「新文档打开」真正重叠。这里要证明的是**已经带着旧路径发出去**的那份保存在
    // 旧路径被别的文档占用之后，仍然只落到它自己改名后的位置。
    {
      const a = path.join(CFG.dir, 'inflight.pdf');
      fs.copyFileSync(path.join(ROOT, 'assets/sample.pdf'), a);
      seedSidecar(a, []);
      const it = L.addItem({ title: 'Inflight Old' });
      L.setAttachment(it.key, a);
      await openAndWait(a);
      holdOn('anno-save', a, true);
      const first = await drawLine(240);                  // 触发防抖保存，被停在写入之前
      await until(() => release !== null, 'anno-save held');
      const r1 = await rename(it.key);
      await waitPath(r1.newPath);
      const rel = release;
      holdOff();
      rel();                                              // 放行：应写到改名后的 sidecar
      await pause(1200);

      // 旧路径现在被另一份 PDF 占用并打开
      fs.copyFileSync(path.join(ROOT, 'assets/sample-annotated.pdf'), a);
      const it2 = L.addItem({ title: 'Inflight New' });
      L.setAttachment(it2.key, a);
      await openAndWait(a);
      const second = await drawLine(241);
      await run(async () => await App.flushAnnos());
      await pause(600);

      R.inflight = {
        a, p1: r1.newPath, first, second,
        oldIds: idsOf(r1.newPath),
        newIds: idsOf(a),
      };
    }

    // ---------- J03 A：anno-load 还在途时改名，回执必须落地 ----------
    {
      const a = path.join(CFG.dir, 'restore.pdf');
      fs.copyFileSync(path.join(ROOT, 'assets/sample.pdf'), a);
      seedSidecar(a, ['RESTORE_ORIG']);
      const it = L.addItem({ title: 'Restore Old' });
      L.setAttachment(it.key, a);
      holdOn('anno-load', a, true);
      openDoc(a);
      // 正文先渲染出来，标注读盘被停住
      await until(() => run((f) => App.state.filePath === f && !!App.state.rendered.get(1), a), 'render restore.pdf');
      await until(() => release !== null, 'anno-load held');
      const r1 = await rename(it.key);
      await waitPath(r1.newPath);
      const heldState = await docState();
      const rel = release;
      holdOff();
      rel();
      // 关键：读盘回执必须让 annoState 落到 ok，而不是停在 unknown
      await until(() => run(() => App.state.annoState.status === 'ok'
        || App.state.annoState.status === 'broken'), 'annoState settles', 200);
      const settled = await docState();
      const line = await drawLine(250);
      const flush = await run(async () => await App.flushAnnos());
      await pause(600);
      R.restore = {
        a, p1: r1.newPath, line, flush,
        heldState, settled,
        ids: idsOf(r1.newPath),
        annoPathWant: sidecarFor(r1.newPath),
      };
    }

    // ---------- J03 B：bookmarks-load 还在途时改名 ----------
    {
      const a = path.join(CFG.dir, 'bm.pdf');
      fs.copyFileSync(path.join(ROOT, 'assets/sample.pdf'), a);
      seedSidecar(a, [], [{ page: 1, at: 1, label: '原书签' }]);
      const it = L.addItem({ title: 'Bookmark Old' });
      L.setAttachment(it.key, a);
      holdOn('bookmarks-load', a, true);
      openDoc(a);
      await until(() => run((f) => App.state.filePath === f && !!App.state.rendered.get(1), a), 'render bm.pdf');
      await until(() => release !== null, 'bookmarks-load held');
      const r1 = await rename(it.key);
      await waitPath(r1.newPath);
      const rel = release;
      holdOff();
      rel();
      await until(() => run(() => App.state.annoState.status === 'ok'
        || App.state.annoState.status === 'missing'), 'annoState settles (bm)', 200);
      await pause(400);
      R.bookmarks = {
        a, p1: r1.newPath,
        list: await run(() => (App.state.bookmarks || []).map((b) => ({ page: b.page, label: b.label }))),
        status: (await docState()).status,
      };
    }
    // K01：改名不能把同一文档的书签队列分成两条；回执前后都要以已提交副本为准。
    R.bookmarkQueues = [];
    for (const mode of ['add', 'toggle', 'fail', 'chain']) {
      const a = path.join(CFG.dir, 'bm-queue-' + mode + '.pdf');
      fs.copyFileSync(path.join(ROOT, 'assets/sample.pdf'), a);
      seedSidecar(a, [], []);
      const it = L.addItem({ title: 'Bookmark Queue ' + mode });
      L.setAttachment(it.key, a);
      await openAndWait(a);
      holdOn('bookmarks-save', a, false);
      await run(() => { window.__bmFirst = App.bookmarkToggle(1); return true; });
      await until(() => release !== null, 'bookmark first acknowledgement held');
      let r = await rename(it.key);
      await waitPath(r.newPath);
      if (mode === 'chain') {
        L.updateItem(it.key, { title: 'Bookmark Queue Final' });
        r = await rename(it.key);
        await waitPath(r.newPath);
      }
      const requestedPage = mode === 'toggle' ? 1 : 3;
      // 第二项须排队，不能等待它完成才放行第一项，否则正确实现会被夹具锁住。
      await run((page) => { window.__bmSecond = App.bookmarkToggle(page); return true; }, requestedPage);
      await pause(150);
      const before = (readJson(sidecarFor(r.newPath)) || {}).bookmarks || [];
      if (mode === 'fail') {
        // 第一项已写成功；只对后续一次真实书签写入注入失败。
        failBookmarkOnce = true;
      }
      const rel = release; holdOff(); rel();
      const replies = await run(async () => await Promise.all([window.__bmFirst, window.__bmSecond]));
      failBookmarkOnce = false;
      const disk = (readJson(sidecarFor(r.newPath)) || {}).bookmarks || [];
      const memory = await run(() => App.state.bookmarks);
      R.bookmarkQueues.push({ mode, before, replies, disk, memory });
    }

    // K02：离开/关窗必须等已发出的书签写入，否则注销会话后旧请求会写回旧路径。
    R.bookmarkLeaves = [];
    for (const mode of ['switch', 'close', 'tab']) {
      const a = path.join(CFG.dir, 'bm-leave-' + mode + '.pdf');
      fs.copyFileSync(path.join(ROOT, 'assets/sample.pdf'), a);
      seedSidecar(a, [], []);
      const it = L.addItem({ title: 'Bookmark Leave ' + mode });
      L.setAttachment(it.key, a);
      await openAndWait(a);
      holdOn('bookmarks-save', a, true);
      await run(() => { window.__bmLeaving = App.bookmarkToggle(1); return true; });
      await until(() => release !== null, 'bookmark write held');
      const r = await rename(it.key);
      await waitPath(r.newPath);
      let next = '';
      if (mode === 'switch') {
        next = path.join(CFG.dir, 'bm-next.pdf');
        fs.copyFileSync(path.join(ROOT, 'assets/sample.pdf'), next);
        openDoc(next);
      } else if (mode === 'close') {
        await run(() => { window.__closeSettled = false; window.__closePromise = App.handleWillClose().then((r) => { window.__closeSettled = true; return r; }); return true; });
      } else {
        await run(() => { window.__tabPromise = App.closeTab(App.activeTabId); return true; });
      }
      await pause(200);
      const heldPath = await run(() => App.state.filePath);
      const closeBefore = mode === 'close' ? await run(() => window.__closeSettled) : false;
      const rel = release; holdOff(); rel();
      await run(async () => await window.__bmLeaving);
      let closeResult = null;
      if (mode === 'switch') await waitPath(next);
      else if (mode === 'close') closeResult = await run(async () => await window.__closePromise);
      else await run(async () => await window.__tabPromise);
      R.bookmarkLeaves.push({ mode, path: r.newPath, heldPath, closeBefore, closeResult,
        oldSidecar: fs.existsSync(sidecarFor(a)),
        disk: (readJson(sidecarFor(r.newPath)) || {}).bookmarks || [],
      });
    }
    // K03：已经读到旧路径的回执，不能盖掉改名通知提供的新 sidecar 位置。
    // K04：强制重建属于发起时的文档，不能在排队期间认领另一份损坏文档。
    {
      const a = path.join(CFG.dir, 'rebuild-a.pdf');
      const b = path.join(CFG.dir, 'rebuild-b.pdf');
      for (const p of [a, b]) fs.copyFileSync(path.join(ROOT, 'assets/sample.pdf'), p);
      const bBytes = '{"valuable":"B original broken data",';
      fs.writeFileSync(sidecarFor(a), '{"valuable":"A broken data",');
      fs.writeFileSync(sidecarFor(b), bBytes);
      openDoc(a);
      await until(() => run((f) => App.state.filePath === f
        && App.state.annoState.status === 'broken' && !!App.state.rendered.get(1), a), 'broken rebuild A loaded');
      holdOn('anno-save', a, true);
      await run(() => { window.__rebuildFirst = App.rebuildAnnosFile(); return true; });
      await until(() => release !== null, 'rebuild held');
      await run(() => { window.__rebuildSecond = App.rebuildAnnosFile(); return true; });
      await pause(100);
      openDoc(b);
      await pause(200);
      const before = await docState();
      const rel = release; holdOff(); rel();
      const replies = await run(async () => await Promise.all([window.__rebuildFirst, window.__rebuildSecond]));
      await waitPath(b);
      R.rebuild = { a, b, before, replies, after: await docState(),
        untouched: fs.readFileSync(sidecarFor(b), 'utf8') === bBytes,
        backups: fs.readdirSync(path.dirname(sidecarFor(b))).filter((n) => n.startsWith(path.basename(sidecarFor(b), '.json') + '.broken-')),
      };
    }
    R.restoreAcks = [];
    for (const mode of ['ok', 'broken']) {
      const a = path.join(CFG.dir, 'restore-ack-' + mode + '.pdf');
      fs.copyFileSync(path.join(ROOT, 'assets/sample.pdf'), a);
      seedSidecar(a, ['ACK_ORIGINAL']);
      if (mode === 'broken') fs.writeFileSync(sidecarFor(a), '{"pages":[');
      const it = L.addItem({ title: 'Restore Ack ' + mode });
      L.setAttachment(it.key, a);
      holdOn('anno-load', a, false);
      openDoc(a);
      await until(() => release !== null, 'restore result held after read');
      await until(() => run(() => !!App.state.rendered.get(1)), 'restore ack rendered');
      const r = await rename(it.key);
      await waitPath(r.newPath);
      const line = mode === 'ok' ? await drawLine(290) : null;
      const rel = release; holdOff(); rel();
      await until(() => run(() => App.state.annoState.status !== 'unknown'), 'restore ack settled');
      const state = await docState();
      const flush = mode === 'ok' ? await run(async () => await App.flushAnnos()) : false;
      R.restoreAcks.push({ mode, state, line, flush, want: sidecarFor(r.newPath), ids: idsOf(r.newPath) });
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
setTimeout(() => { try { realWrite(CFG.out, JSON.stringify({ timeout: true })); } catch (_) {} app.exit(3); }, 240000);
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
    .replace("const realWrite = fs.writeFileSync;",
      "const crypto = require('crypto');\nconst realWrite = fs.writeFileSync;\n" +
      "function sidecarFor(p) { return path.join(CFG.ud, 'annotations', crypto.createHash('sha1').update(path.resolve(p)).digest('hex').slice(0, 20) + '.json'); }\n" +
      "function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } }");
  const hf = path.join(dir, 'harness.cjs');
  fs.writeFileSync(hf, harness);
  const r = spawnSync(ELECTRON, [hf, '--no-sandbox', '--disable-gpu',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows'], {
    cwd: ROOT, env: cleanEnv(), encoding: 'utf8', timeout: 300000, windowsHide: true,
  });
  fs.writeFileSync(path.join(dir, 'log.txt'), String((r && r.stdout) || '') + String((r && r.stderr) || ''));
  const R = readJson(cfg.out) || {};

  check('J 场景执行无脚本错误', !R.error && !R.fatal && !R.timeout, R.error || R.fatal || R.timeout);

  // ---- J01 A：A→B→A ----
  const rt = R.rt || {};
  const rtMid = rt.mid || {};
  const rtBack = rt.back || {};
  check('J01 A→B 后新线写进 B', !!rt.line && (rt.midIds || []).includes(rt.line.id), { ids: rt.midIds });
  check('J01 A→B 后 A 的旧标注确实搬到了 B',
    rt.midExists === true && (rt.midIds || []).includes('RT_ORIG'), { exists: rt.midExists, ids: rt.midIds });
  check('J01 往返后当前路径回到 A', rtBack.path === rt.a, { path: rtBack.path, want: rt.a });
  check('J01 往返后 B 的 sidecar 已清掉（标注没有滞留在 B）', rt.backExists === false, rt.backExists);
  check('J01 往返后 A 的 sidecar 同时有原标注与中途画的线',
    (rt.backIds || []).includes('RT_ORIG') && (rt.backIds || []).includes(rt.line && rt.line.id),
    { ids: rt.backIds, line: rt.line && rt.line.id });
  check('J01 往返后 annoState 指向 A 的 sidecar（不是 B）',
    rtBack.annoPath === rt.annoPathWant, { got: rtBack.annoPath, want: rt.annoPathWant });
  check('J01 往返后没有残留未保存改动', rtBack.dirty === false, rtBack.dirty);

  // ---- J01 B：A→B→C→A ----
  const rt3 = R.rt3 || {};
  const rt3State = rt3.state || {};
  check('J01 三段往返后当前路径回到 A', rt3State.path === rt3.a, { path: rt3State.path, want: rt3.a });
  check('J01 三段往返后中间两段 sidecar 都不存在', rt3.p1Exists === false && rt3.p2Exists === false,
    { p1: rt3.p1Exists, p2: rt3.p2Exists });
  check('J01 三段往返后三条笔迹都在 A',
    ['RT3_ORIG', rt3.l1 && rt3.l1.id, rt3.l2 && rt3.l2.id].every((id) => !!id && (rt3.ids || []).includes(id)),
    { ids: rt3.ids, l1: rt3.l1 && rt3.l1.id, l2: rt3.l2 && rt3.l2.id });
  check('J01 三段往返后 annoState 指向 A 的 sidecar', rt3State.annoPath === rt3.annoPathWant,
    { got: rt3State.annoPath, want: rt3.annoPathWant });

  // ---- J01 C：9 次链式改名 ----
  const ch = R.chain || {};
  const chState = ch.state || {};
  const chWant = ['CHAIN_ORIG'].concat((ch.drawn || []).map((d) => d && d.id)).filter(Boolean);
  check('J01 链式改名 9 次后全部笔迹都在最终文件里',
    chWant.every((id) => (ch.ids || []).includes(id)), { want: chWant, got: ch.ids });
  check('J01 链式改名后没有残留旧 sidecar', (ch.leftovers || []).length === 0, ch.leftovers);
  check('J01 链式改名后 annoState 指向最终 sidecar', chState.annoPath === ch.annoPathWant,
    { got: chState.annoPath, want: ch.annoPathWant });

  // ---- J02 A：旧路径被另一份 PDF 复用 ----
  const ru = R.reuse || {};
  const ruBefore = ru.beforeDraw || {};
  check('J02 旧路径上的新文档读不到旧文档的标注',
    !(ruBefore.ids || []).includes('REUSE_ORIG'), { ids: ruBefore.ids });
  check('J02 旧路径上的新文档状态是 missing（不是 ok）', ruBefore.status === 'missing', ruBefore.status);
  check('J02 新文档的笔迹只写进旧路径的 sidecar',
    (ru.newIds || []).includes(ru.line && ru.line.id) && !(ru.newIds || []).includes('REUSE_ORIG'),
    { ids: ru.newIds });
  check('J02 新文档没有污染改名后的那份 sidecar',
    (ru.oldIds || []).includes('REUSE_ORIG') && !(ru.oldIds || []).includes(ru.line && ru.line.id),
    { ids: ru.oldIds });

  // ---- J02 B：在途保存 + 旧路径复用 ----
  const inf = R.inflight || {};
  check('J02 在途保存仍落在改名后的路径',
    (inf.oldIds || []).includes(inf.first && inf.first.id), { ids: inf.oldIds, want: inf.first && inf.first.id });
  check('J02 在途保存没有写进被复用的旧路径',
    !(inf.newIds || []).includes(inf.first && inf.first.id), { ids: inf.newIds });
  check('J02 旧路径上的新文档自己的笔迹保留',
    (inf.newIds || []).includes(inf.second && inf.second.id), { ids: inf.newIds });

  // ---- J03 A：anno-load 在途时改名 ----
  const rs = R.restore || {};
  const rsHeld = rs.heldState || {};
  const rsSettled = rs.settled || {};
  check('J03 读盘被停住时状态确实是 unknown', rsHeld.status === 'unknown', rsHeld.status);
  check('J03 改名后读盘回执让 annoState 落到 ok', rsSettled.status === 'ok', rsSettled.status);
  check('J03 回执里的标注是从新路径读回来的',
    (rsSettled.ids || []).includes('RESTORE_ORIG'), rsSettled.ids);
  check('J03 annoState 指向改名后的 sidecar', rsSettled.annoPath === rs.annoPathWant,
    { got: rsSettled.annoPath, want: rs.annoPathWant });
  check('J03 恢复完成后基线可信（没有假 dirty）', rsSettled.dirty === false, rsSettled.dirty);
  check('J03 恢复后新画的线能落盘', rs.flush === true || (rs.flush && rs.flush.ok === true), rs.flush);
  check('J03 恢复后新线写进新路径的 sidecar',
    (rs.ids || []).includes(rs.line && rs.line.id) && (rs.ids || []).includes('RESTORE_ORIG'),
    { ids: rs.ids });

  // ---- J03 B：bookmarks-load 在途时改名 ----
  const bm = R.bookmarks || {};
  check('J03 书签读盘跨改名后仍然读到原书签',
    Array.isArray(bm.list) && bm.list.some((b) => b && b.page === 1), bm.list);
  check('J03 书签读盘跨改名后文档状态正常', bm.status === 'ok' || bm.status === 'missing', bm.status);

  for (const mode of ['add', 'toggle', 'fail', 'chain']) {
    const q = (R.bookmarkQueues || []).find((q) => q.mode === mode) || {};
    check('K01 ' + mode + ' 改名后第二次操作等待同一条队列',
      JSON.stringify((q.before || []).map((b) => b.page)) === '[1]', q.before);
    const want = mode === 'toggle' ? [] : mode === 'fail' ? [1] : [1, 3];
    check('K01 ' + mode + ' 磁盘书签结果正确',
      JSON.stringify((q.disk || []).map((b) => b.page)) === JSON.stringify(want), q.disk);
    check('K01 ' + mode + ' 界面与磁盘一致',
      JSON.stringify(q.memory) === JSON.stringify(q.disk), { memory: q.memory, disk: q.disk });
    if (mode === 'fail') check('K01 失败确实返回且第一项仍保留',
      !!q.replies && q.replies[0].ok === true && q.replies[1].ok === false, q.replies);
  }
  for (const mode of ['switch', 'close', 'tab']) {
    const q = (R.bookmarkLeaves || []).find((q) => q.mode === mode) || {};
    check('K02 ' + mode + ' 写入未完成时不离开',
      !!q.path && q.heldPath === q.path && q.closeBefore === false, q);
    check('K02 ' + mode + ' 书签写进改名后的文件',
      JSON.stringify((q.disk || []).map((b) => b.page)) === '[1]', q.disk);
    check('K02 ' + mode + ' 旧 sidecar 没被复活', q.oldSidecar === false, q.oldSidecar);
    if (mode === 'close') check('K02 书签完成后关窗握手成功', !!q.closeResult && q.closeResult.ok, q.closeResult);
  }
  const rb = R.rebuild || {};
  check('K04 重建未完成时离开等待原文档', !!rb.a && rb.before && rb.before.path === rb.a, rb.before);
  check('K04 排队重建不会改写 B 的损坏原文件', rb.untouched === true, rb);
  check('K04 未要求重建的 B 不生成备份', Array.isArray(rb.backups) && rb.backups.length === 0, rb.backups);
  check('K04 切换后 B 仍报告真实损坏状态', rb.after && rb.after.path === rb.b && rb.after.status === 'broken', rb.after);
  for (const mode of ['ok', 'broken']) {
    const q = (R.restoreAcks || []).find((q) => q.mode === mode) || {};
    check('K03 ' + mode + ' 迟到回执保留新 sidecar 位置',
      !!q.want && q.state && q.state.annoPath === q.want, q);
    check('K03 ' + mode + ' 迟到回执保留真实读取状态', !!q.state && q.state.status === mode, q.state);
    if (mode === 'ok') check('K03 恢复期间新画的线与原标注均落盘',
      q.flush === true && !!q.line && ['ACK_ORIGINAL', q.line.id].every((id) => (q.ids || []).includes(id)), q);
  }
  console.log('[anno-session-identity] ' + (fail ? 'FAIL ' : 'PASS ') + '(' + total + ')');
  if (!fail && tmp.startsWith(path.join(os.tmpdir(), 'trove-anno-session-'))) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  process.exitCode = fail ? 1 : 0;
}

main();
