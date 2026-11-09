'use strict';
/*
 * 持续修复复查 H02 / H03 的回归（真实 Electron 主进程 + 真实文件系统）。
 *
 * H02：损坏标注文件的「按字节复制」分支以前跳过了目标冲突检查，会把目标路径上
 *      已有的有效标注 / 书签整份盖掉。现在所有写目标的分支都先拒绝冲突，且用
 *      COPYFILE_EXCL / atomicCreate 保证「不存在才创建」。
 * H03：恢复记录以前只在「库写失败且回滚也失败」之后才写，PDF 改名到库提交之间
 *      被强制终止就没有任何记录，重启后接不回来。现在改名前先落日志，启动恢复
 *      按磁盘真实状态分四种情况处理。
 *
 * 运行：node scripts/test-rename-boundary.js
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-rename-boundary-'));

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
function writeHarness(cfg, source) {
  const hf = path.join(cfg.dir, 'harness-' + cfg.mode + '-' + (cfg.tag || 'main') + '.cjs');
  fs.writeFileSync(hf, source.split('__ROOT__').join(JSON.stringify(ROOT)).split('__CFG__').join(JSON.stringify(cfg)));
  return hf;
}

// ---------------------------------------------------------------- H02 ----------
const H02_HARNESS = `'use strict';
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const ROOT = __ROOT__, CFG = __CFG__;
process.env.PDFREADER_TEST = '1';
process.env.PDFREADER_HIDDEN = '1';
process.env.PDFREADER_NO_AUTO_INDEX = '1';
process.env.PDFREADER_LIBRARY = CFG.libFile;
process.env.PDFREADER_DATA_DIR = CFG.data;
app.setPath('userData', CFG.ud);
require(path.join(ROOT, 'src/main.js'));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  await pause(250);
  const win = BrowserWindow.getAllWindows()[0];
  if (win && win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
  await pause(300);
  const res = {};
  try { res.rename = await win.webContents.executeJavaScript('pdfBridge.lib.renameFile(' + JSON.stringify(CFG.keys) + ')', true); }
  catch (err) { res.error = String((err && err.stack) || err); }
  fs.writeFileSync(CFG.out, JSON.stringify(res));
  app.exit(0);
});
setTimeout(() => { try { fs.writeFileSync(CFG.out, JSON.stringify({ timeout: true })); } catch (_) {} app.exit(3); }, 60000);
`;

function runH02() {
  const dir = path.join(tmp, 'h02');
  const ud = path.join(dir, 'ud');
  const annoDir = path.join(ud, 'annotations');
  fs.mkdirSync(annoDir, { recursive: true });
  const libFile = path.join(dir, 'library.json');
  const broken = '{"path":"old","pages":[{"page":1,"shapes":[{"text":"recoverable incomplete';
  const validSource = (p) => JSON.stringify({
    path: p, saved: 1,
    pages: [{ page: 1, shapes: [{ id: 'aSOURCE0004', tool: 'text', text: 'valid source', at: { x: 10, y: 10 } }] }],
  });
  const validTarget = (p, id) => JSON.stringify({
    path: p, saved: 1,
    pages: [{ page: 1, shapes: [{ id, tool: 'text', text: 'valuable existing target', at: { x: 20, y: 30 } }] }],
    bookmarks: [{ page: 2, label: 'keep me' }],
  });
  const names = ['A Target', 'B Target', 'C Target', 'D Target'];
  const cases = {};
  const items = names.map((title, i) => {
    const src = path.join(dir, 'src' + i + '.pdf');
    const dst = path.join(dir, title + '.pdf');
    fs.copyFileSync(path.join(ROOT, 'assets/sample.pdf'), src);
    const oldSidecar = path.join(annoDir, hashName(src));
    const newSidecar = path.join(annoDir, hashName(dst));
    cases['k' + (i + 1)] = { src, dst, oldSidecar, newSidecar, title };
    return { key: 'k' + (i + 1), title, itemType: 'document', creators: [], tags: [], collectionIds: [], annoIds: [], attachment: { path: src, name: path.basename(src) } };
  });
  fs.writeFileSync(libFile, JSON.stringify({
    version: 8, collections: [], searches: [], tagColors: {}, feeds: [], noteAliases: {},
    annoTags: {}, annoMeta: {}, items,
  }));
  // k1 broken + valid target；k2 broken + broken target；k3 broken + 无目标；k4 valid + valid target
  fs.writeFileSync(cases.k1.oldSidecar, broken);
  fs.writeFileSync(cases.k1.newSidecar, validTarget(cases.k1.dst, 'aPRE0000001'));
  fs.writeFileSync(cases.k2.oldSidecar, broken);
  fs.writeFileSync(cases.k2.newSidecar, '{"path":"target","pages":[{"page":1,');
  fs.writeFileSync(cases.k3.oldSidecar, broken);
  fs.writeFileSync(cases.k4.oldSidecar, validSource(cases.k4.src));
  fs.writeFileSync(cases.k4.newSidecar, validTarget(cases.k4.dst, 'aPRE0000004'));
  const before = {};
  for (const k of Object.keys(cases)) {
    const c = cases[k];
    before[k] = {
      targetBytes: fs.existsSync(c.newSidecar) ? fs.readFileSync(c.newSidecar, 'utf8') : null,
      oldBytes: fs.readFileSync(c.oldSidecar, 'utf8'),
    };
  }
  const out = path.join(dir, 'out.json');
  const cfg = { dir, ud, libFile, data: path.join(dir, 'data'), out, keys: Object.keys(cases) };
  const hf = writeHarness(cfg, H02_HARNESS);
  const r = spawnSync(ELECTRON, [hf, '--no-sandbox', '--disable-gpu'], { cwd: ROOT, env: cleanEnv(), encoding: 'utf8', timeout: 90000 });
  const res = readJson(out) || {};
  if (!res.rename) {
    check('H02 垫片有结果', false, { exit: r && r.status, stderr: String((r && r.stderr) || '').slice(-400), res });
    return;
  }
  const rename = res.rename;
  const errors = rename.errors || [];
  check('H02 整次改名：只有无冲突的 C 成功', rename.ok === false && rename.renamed === 1 && rename.failed === 3, rename);
  for (const k of ['k1', 'k2', 'k4']) {
    const e = errors.find((x) => x.key === k) || {};
    check('H02 ' + k + ' 被目标冲突拦下', e.step === 'sidecar' && /没有覆盖/.test(e.error || ''), e);
    const c = cases[k];
    check('H02 ' + k + ' 目标字节完全不变', fs.readFileSync(c.newSidecar, 'utf8') === before[k].targetBytes, c.newSidecar);
    check('H02 ' + k + ' 原 sidecar 保留', fs.readFileSync(c.oldSidecar, 'utf8') === before[k].oldBytes, c.oldSidecar);
    check('H02 ' + k + ' PDF 没有改名', fs.existsSync(c.src) && !fs.existsSync(c.dst), c.src);
  }
  const c3 = cases.k3;
  const ch = (rename.changes || []).find((x) => x.key === 'k3') || {};
  check('H02 无冲突时损坏原字节仍随文档迁移',
    fs.existsSync(c3.dst) && !fs.existsSync(c3.src)
    && fs.readFileSync(c3.newSidecar, 'utf8') === broken
    && !fs.existsSync(c3.oldSidecar) && ch.annoStatus === 'copied-broken', ch);
}

// ---------------------------------------------------------------- I02 ----------
// 源状态（missing / ok / broken）× 目标状态（missing / ok / broken）共 9 格：
// 目标已有 sidecar 时一律拒绝、逐字节保留；目标为空时按源状态正确迁移。
// 以前源 missing 会提前 return，跳过冲突检查，把目标遗留的别的文档标注绑到新 PDF 上。
function runI02Matrix() {
  const dir = path.join(tmp, 'i02');
  const ud = path.join(dir, 'ud');
  const annoDir = path.join(ud, 'annotations');
  fs.mkdirSync(annoDir, { recursive: true });
  const libFile = path.join(dir, 'library.json');
  const broken = '{"path":"old","pages":[{"page":1,"shapes":[{"text":"truncated';
  const valid = (p, id) => JSON.stringify({
    path: p, saved: 1,
    pages: [{ page: 1, shapes: [{ id, tool: 'text', text: 'annotation of ' + id, at: { x: 5, y: 5 } }] }],
    bookmarks: [{ page: 2, label: id }],
  });
  const states = ['missing', 'ok', 'broken'];
  const cells = [];
  const items = [];
  let n = 0;
  for (const srcState of states) {
    for (const dstState of states) {
      n++;
      const key = 'm' + n;
      const title = 'S' + srcState[0].toUpperCase() + 'T' + dstState[0].toUpperCase() + n;
      const src = path.join(dir, 'src' + n + '.pdf');
      const dst = path.join(dir, title + '.pdf');
      fs.copyFileSync(path.join(ROOT, 'assets/sample.pdf'), src);
      const oldSidecar = path.join(annoDir, hashName(src));
      const newSidecar = path.join(annoDir, hashName(dst));
      if (srcState === 'ok') fs.writeFileSync(oldSidecar, valid(src, 'aSRC' + n));
      if (srcState === 'broken') fs.writeFileSync(oldSidecar, broken);
      if (dstState === 'ok') fs.writeFileSync(newSidecar, valid(dst, 'aDST' + n));
      if (dstState === 'broken') fs.writeFileSync(newSidecar, '{"path":"dst","pages":[{"page":1,');
      cells.push({
        key, srcState, dstState, src, dst, oldSidecar, newSidecar, title,
        oldBytes: fs.existsSync(oldSidecar) ? fs.readFileSync(oldSidecar, 'utf8') : null,
        newBytes: fs.existsSync(newSidecar) ? fs.readFileSync(newSidecar, 'utf8') : null,
      });
      items.push({
        key, title, itemType: 'document', creators: [], tags: [], collectionIds: [], annoIds: [],
        attachment: { path: src, name: path.basename(src) },
      });
    }
  }
  fs.writeFileSync(libFile, JSON.stringify({
    version: 8, collections: [], searches: [], tagColors: {}, feeds: [], noteAliases: {},
    annoTags: {}, annoMeta: {}, items,
  }));
  const out = path.join(dir, 'out.json');
  const cfg = { dir, ud, libFile, data: path.join(dir, 'data'), out, keys: items.map((x) => x.key) };
  const hf = writeHarness(cfg, H02_HARNESS);
  const r = spawnSync(ELECTRON, [hf, '--no-sandbox', '--disable-gpu'], { cwd: ROOT, env: cleanEnv(), encoding: 'utf8', timeout: 120000 });
  const res = readJson(out) || {};
  if (!res.rename) {
    check('I02 矩阵垫片有结果', false, { exit: r && r.status, stderr: String((r && r.stderr) || '').slice(-400) });
    return;
  }
  const rename = res.rename;
  const byKey = new Map((rename.changes || []).map((c) => [c.key, c]));
  const errByKey = new Map((rename.errors || []).map((e) => [e.key, e]));
  for (const c of cells) {
    const label = 'I02 源' + c.srcState + ' / 目标' + c.dstState;
    if (c.dstState !== 'missing') {
      const e = errByKey.get(c.key) || {};
      check(label + ' 整次拒绝', e.step === 'sidecar' && /没有覆盖/.test(e.error || ''), e);
      check(label + ' 目标字节完全不变', fs.readFileSync(c.newSidecar, 'utf8') === c.newBytes, c.newSidecar);
      check(label + ' 源 PDF 与 sidecar 未动',
        fs.existsSync(c.src) && !fs.existsSync(c.dst)
        && (c.oldBytes === null ? !fs.existsSync(c.oldSidecar) : fs.readFileSync(c.oldSidecar, 'utf8') === c.oldBytes),
        c.src);
    } else {
      const ch = byKey.get(c.key) || {};
      check(label + ' 无冲突时正常改名', !!ch.newPath && fs.existsSync(c.dst) && !fs.existsSync(c.src), ch);
      const expectStatus = c.srcState === 'missing' ? 'missing' : c.srcState === 'ok' ? 'ready' : 'copied-broken';
      check(label + ' annoStatus 正确', ch.annoStatus === expectStatus, { got: ch.annoStatus, expect: expectStatus });
      if (c.srcState === 'missing') {
        check(label + ' 源无标注时不凭空生成 sidecar', !fs.existsSync(c.newSidecar), c.newSidecar);
      } else {
        check(label + ' 标注随文档迁移', fs.existsSync(c.newSidecar) && !fs.existsSync(c.oldSidecar), c.newSidecar);
      }
    }
  }
}

// ---------------------------------------------------------------- H03 ----------
const H03_HARNESS = `'use strict';
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const ROOT = __ROOT__, CFG = __CFG__;
const realWrite = fs.writeFileSync;
const realRename = fs.renameSync;
const realCopy = fs.copyFileSync;
const realUnlink = fs.unlinkSync;
function same(a, b) { try { return path.resolve(String(a)) === path.resolve(String(b)); } catch (_) { return false; } }
function readPending() { try { return JSON.parse(fs.readFileSync(CFG.pending, 'utf8')); } catch (_) { return null; } }
function freeze(tag) {
  realWrite(CFG.checkpoint, JSON.stringify({
    tag, oldDoc: fs.existsSync(CFG.doc), newDoc: fs.existsSync(CFG.newDoc),
    oldSidecar: fs.existsSync(CFG.sidecar), newSidecar: fs.existsSync(CFG.newSidecar),
    pending: readPending(),
  }));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
if (CFG.mode === 'interrupt' && CFG.tag !== 'done') {
  if (CFG.tag === 'sidecar-ready') {
    fs.copyFileSync = function (from, to) {
      const r = realCopy.apply(this, arguments);
      if (same(to, CFG.newSidecar)) freeze(CFG.tag);
      return r;
    };
  } else if (CFG.tag === 'pdf-renamed') {
    fs.renameSync = function (from, to) {
      const r = realRename.apply(this, arguments);
      if (same(from, CFG.doc) && same(to, CFG.newDoc)) freeze(CFG.tag);
      return r;
    };
  } else if (CFG.tag === 'library-committed') {
    fs.renameSync = function (from, to) {
      const r = realRename.apply(this, arguments);
      if (same(to, CFG.libFile)) freeze(CFG.tag);
      return r;
    };
  } else if (CFG.tag === 'cleanup') {
    fs.unlinkSync = function (p) {
      const r = realUnlink.apply(this, arguments);
      if (same(p, CFG.sidecar)) freeze(CFG.tag);
      return r;
    };
  }
}
process.env.PDFREADER_TEST = '1';
process.env.PDFREADER_HIDDEN = '1';
process.env.PDFREADER_NO_AUTO_INDEX = '1';
process.env.PDFREADER_LIBRARY = CFG.libFile;
process.env.PDFREADER_DATA_DIR = CFG.data;
app.setPath('userData', CFG.ud);
require(path.join(ROOT, 'src/main.js'));
const L = require(path.join(ROOT, 'src/library.js'));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  await pause(250);
  const win = BrowserWindow.getAllWindows()[0];
  if (win && win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
  await pause(300);
  if (CFG.mode === 'interrupt') {
    try { await win.webContents.executeJavaScript('pdfBridge.lib.renameFile(["k1"])', true); } catch (_) {}
    realWrite(CFG.out, JSON.stringify({ completed: true }));
    app.exit(0);
    return;
  }
  const it = L.findItem('k1');
  const stored = it && it.attachment && it.attachment.path;
  let anno = null;
  try { anno = await win.webContents.executeJavaScript('pdfBridge.loadAnnosState(' + JSON.stringify(stored) + ')', true); } catch (_) {}
  realWrite(CFG.out, JSON.stringify({
    stored, storedExists: fs.existsSync(stored),
    oldDoc: fs.existsSync(CFG.doc), newDoc: fs.existsSync(CFG.newDoc),
    oldSidecar: fs.existsSync(CFG.sidecar), newSidecar: fs.existsSync(CFG.newSidecar),
    pending: readPending(), anno,
  }));
  app.exit(0);
});
setTimeout(() => { try { realWrite(CFG.out, JSON.stringify({ timeout: true })); } catch (_) {} app.exit(4); }, 40000);
`;

function makeH03Case(tag) {
  const dir = path.join(tmp, 'h03-' + tag);
  const ud = path.join(dir, 'ud');
  const annoDir = path.join(ud, 'annotations');
  fs.mkdirSync(annoDir, { recursive: true });
  const doc = path.join(dir, 'before.pdf');
  const newDoc = path.join(dir, 'Target.pdf');
  const libFile = path.join(dir, 'library.json');
  const pending = path.join(ud, 'pending-renames.json');
  fs.copyFileSync(path.join(ROOT, 'assets/sample.pdf'), doc);
  const sidecar = path.join(annoDir, hashName(doc));
  const newSidecar = path.join(annoDir, hashName(newDoc));
  fs.writeFileSync(sidecar, JSON.stringify({
    path: doc, saved: 1,
    pages: [{ page: 1, shapes: [{ id: 'aKEEP0000001', tool: 'text', text: 'kept annotation', at: { x: 10, y: 10 } }] }],
  }));
  fs.writeFileSync(libFile, JSON.stringify({
    version: 8, collections: [], searches: [], tagColors: {}, feeds: [], noteAliases: {},
    annoTags: {}, annoMeta: {},
    items: [{ key: 'k1', title: 'Target', itemType: 'document', creators: [], tags: [], collectionIds: [], annoIds: [], attachment: { path: doc, name: 'before.pdf' } }],
  }));
  return {
    dir, ud, doc, newDoc, libFile, pending, sidecar, newSidecar,
    data: path.join(dir, 'data'),
    checkpoint: path.join(dir, 'checkpoint-' + tag + '.json'),
    out: path.join(dir, 'out-' + tag + '.json'),
    log: path.join(dir, 'log-' + tag + '.txt'),
    tag,
  };
}

function runH03Interrupt(base) {
  const cfg = Object.assign({}, base, { mode: 'interrupt' });
  const hf = writeHarness(cfg, H03_HARNESS);
  const env = cleanEnv();
  if (cfg.tag === 'done') {
    const r = spawnSync(ELECTRON, [hf, '--no-sandbox', '--disable-gpu'], { cwd: ROOT, env, encoding: 'utf8', timeout: 60000 });
    fs.writeFileSync(cfg.log, String((r && r.stdout) || '') + String((r && r.stderr) || ''));
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const child = spawn(ELECTRON, [hf, '--no-sandbox', '--disable-gpu'], { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    const timer = setInterval(() => {
      if (fs.existsSync(cfg.checkpoint)) { clearInterval(timer); child.kill('SIGKILL'); }
    }, 20);
    const deadline = setTimeout(() => { clearInterval(timer); child.kill('SIGKILL'); }, 30000);
    child.once('close', () => {
      clearInterval(timer); clearTimeout(deadline);
      fs.writeFileSync(cfg.log, log);
      resolve();
    });
  });
}

function runH03Restart(base) {
  const cfg = Object.assign({}, base, { mode: 'restart' });
  // 重启读的是 out-restart.json，不能覆盖中断阶段写出的 out
  cfg.out = path.join(cfg.dir, 'out-restart-' + cfg.tag + '.json');
  const hf = writeHarness(cfg, H03_HARNESS);
  const r = spawnSync(ELECTRON, [hf, '--no-sandbox', '--disable-gpu'], { cwd: ROOT, env: cleanEnv(), encoding: 'utf8', timeout: 60000 });
  fs.appendFileSync(cfg.log, '\n-- restart --\n' + String((r && r.stdout) || '') + String((r && r.stderr) || ''));
  return readJson(cfg.out) || {};
}

async function runH03() {
  for (const tag of ['sidecar-ready', 'pdf-renamed', 'library-committed', 'cleanup', 'done']) {
    const base = makeH03Case(tag);
    await runH03Interrupt(base);
    const cp = readJson(base.checkpoint);
    if (tag !== 'done') {
      check('H03 ' + tag + ' 确实在目标检查点被强制终止', !!cp && cp.tag === tag,
        cp || String(fs.readFileSync(base.log, 'utf8')).slice(-300));
      check('H03 ' + tag + ' 中断时恢复记录已存在',
        !!cp && Array.isArray(cp.pending) && cp.pending.length === 1, cp && cp.pending);
    }
    const after = runH03Restart(base);
    const shapes = ((after.anno && after.anno.pages) || []).flatMap((p) => p.shapes || []);
    check('H03 ' + tag + ' 重启后附件路径可打开', after.storedExists === true, after);
    check('H03 ' + tag + ' 重启后标注能找回', !!after.anno && after.anno.ok === true
      && shapes.some((s) => s.id === 'aKEEP0000001'), after.anno);
    check('H03 ' + tag + ' 恢复记录已收口', Array.isArray(after.pending) && after.pending.length === 0, after.pending);
  }
}

(async () => {
  console.log('[rename-boundary] H02 —— 损坏标注不得覆盖目标');
  runH02();
  console.log('[rename-boundary] I02 —— 源 / 目标状态 3×3 矩阵');
  runI02Matrix();
  console.log('[rename-boundary] H03 —— 各检查点强制终止后重启恢复');
  await runH03();
  console.log('[rename-boundary] ' + (fail ? 'FAIL ' : 'PASS ') + '(' + total + ')');
  if (tmp.startsWith(path.join(os.tmpdir(), 'trove-rename-boundary-'))) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  process.exitCode = fail ? 1 : 0;
})().catch((err) => { console.error(err && err.stack || err); process.exitCode = 1; });
