'use strict';
/*
 * 附件改名的协调（持续复查 G02 / G03）。
 *
 * 改名一次要动三样东西：磁盘文件名、库里的 attachment.path、标注 sidecar。
 * 以前的顺序是「先改 PDF 名 → 写库 → 搬标注，错误全吞」，于是：
 *   G02：库写失败时 PDF 已经改名，库还指向旧路径 → 条目打不开；
 *   G03：标注搬迁失败被吞掉，界面报改名成功，新路径打开一份「没有标注」的文档。
 *
 * 现在改成「先写新标注 → 改 PDF 名 → 写库 → 删旧标注」，任何一步失败都能退回去。
 * 这个测试在真实写入点注入故障，逐条验证失败后磁盘 / 库 / 标注三者是否一致。
 *
 * 运行：node scripts/test-rename-attachment.js
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

let fail = 0;
let total = 0;
function check(name, ok, detail) {
  total++;
  if (!ok) { fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  <- ' + JSON.stringify(detail) : '')); }
  else console.log('  ok   ' + name);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-rename-'));
const NEW_NAME = 'Zhang - 2020 - 我的论文.pdf';

function makeCase(name) {
  const dir = path.join(tmp, name);
  const ud = path.join(dir, 'ud');
  fs.mkdirSync(path.join(ud, 'annotations'), { recursive: true });
  const doc = path.join(dir, 'orig.pdf');
  fs.copyFileSync(path.join(ROOT, 'assets/sample.pdf'), doc);
  const fileId = (p) => crypto.createHash('sha1').update(path.resolve(p)).digest('hex').slice(0, 20);
  const sidecar = path.join(ud, 'annotations', fileId(doc) + '.json');
  const newDoc = path.join(dir, NEW_NAME);
  const newSidecar = path.join(ud, 'annotations', fileId(newDoc) + '.json');
  // 已有稳定 ID 的标注：不触发 ID 迁移，专测「搬家」这一段
  const sidecarBody = JSON.stringify({
    path: doc, saved: 1,
    pages: [{ page: 1, shapes: [{ id: 'aOLD000001', tool: 'text', text: '原有批注', at: { x: 60, y: 90 }, color: '#000000' }] }],
    bookmarks: [{ page: 2, at: 1, label: '' }],
  });
  fs.writeFileSync(sidecar, sidecarBody);
  const libFile = path.join(dir, 'library.json');
  fs.writeFileSync(libFile, JSON.stringify({
    version: 8, collections: [], searches: [], tagColors: {}, feeds: [], noteAliases: {},
    annoTags: {}, annoMeta: {}, items: [{
      key: 'k1', itemType: 'document', title: '我的论文', year: '2020',
      creators: [{ creatorType: 'author', firstName: 'San', lastName: 'Zhang' }],
      tags: [], collectionIds: [], annoIds: [],
      attachment: { path: doc, name: 'orig.pdf' },
    }],
  }));
  return { name, dir, ud, doc, newDoc, sidecar, newSidecar, libFile, sidecarBody };
}

const HARNESS = `'use strict';
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const ROOT = __ROOT__;
const CFG = __CFG__;

const realWrite = fs.writeFileSync;
const realRename = fs.renameSync;
let armed = false;
let faults = 0;
fs.writeFileSync = function (file) {
  const f = String(file);
  if (armed && /\\.tmp$/.test(f)) {
    if (CFG.fault === 'sidecar' && f.startsWith(CFG.newSidecar + '.')) {
      faults++; const e = new Error('ENOSPC (injected sidecar)'); e.code = 'ENOSPC'; throw e;
    }
    if (CFG.fault === 'library' && f.startsWith(CFG.libFile + '.')) {
      faults++; const e = new Error('ENOSPC (injected library)'); e.code = 'ENOSPC'; throw e;
    }
  }
  return realWrite.apply(this, arguments);
};
// 模拟「文件被占用，改不回原名」
fs.renameSync = function (from, to) {
  if (armed && CFG.fault === 'library' && CFG.blockRollback
    && path.resolve(String(to)) === path.resolve(CFG.doc)) {
    const e = new Error('EPERM (injected rollback block)'); e.code = 'EPERM'; throw e;
  }
  return realRename.apply(this, arguments);
};

process.env.PDFREADER_TEST = '1';
process.env.PDFREADER_HIDDEN = '1';
process.env.PDFREADER_NO_AUTO_INDEX = '1';
process.env.PDFREADER_LIBRARY = CFG.libFile;
process.env.PDFREADER_DATA_DIR = CFG.data;
app.setPath('userData', CFG.ud);
require(path.join(ROOT, 'src/main.js'));

const library = require(path.join(ROOT, 'src/library.js'));
const results = { mode: CFG.mode, faults: 0, checks: [] };
const push = (n, ok, d) => results.checks.push([n, !!ok, d === undefined ? '' : String(d).slice(0, 240)]);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
let win = null;
const run = (fn, arg) => win.webContents.executeJavaScript('(' + fn.toString() + ')(' + JSON.stringify(arg) + ')', true);

app.whenReady().then(async () => {
  await pause(250);
  win = BrowserWindow.getAllWindows()[0];
  if (win && win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
  await pause(400);
  try {
    if (CFG.mode !== 'after-restart') {
      armed = true;
      const r = await run(() => pdfBridge.lib.renameFile(['k1']));
      armed = false;
      results.rename = r;
      const it = library.findItem('k1');
      results.pending = (() => { try { return JSON.parse(fs.readFileSync(path.join(CFG.ud, 'pending-renames.json'), 'utf8')); } catch (_) { return null; } })();
      results.state = {
        itemPath: it && it.attachment && it.attachment.path,
        oldDoc: fs.existsSync(CFG.doc),
        newDoc: fs.existsSync(CFG.newDoc),
        oldSidecar: fs.existsSync(CFG.sidecar),
        newSidecar: fs.existsSync(CFG.newSidecar),
      };
      const loadAt = async (p) => run((x) => pdfBridge.loadAnnosState(x), p);
      if (fs.existsSync(CFG.newDoc)) results.newAnno = await loadAt(CFG.newDoc);
      if (fs.existsSync(CFG.doc)) results.oldAnno = await loadAt(CFG.doc);
    } else {
      const it = library.findItem('k1');
      results.state = { itemPath: it && it.attachment && it.attachment.path, newDoc: fs.existsSync(CFG.newDoc) };
      results.pending = (() => { try { return JSON.parse(fs.readFileSync(path.join(CFG.ud, 'pending-renames.json'), 'utf8')); } catch (_) { return null; } })();
    }
  } catch (err) {
    push('垫片执行', false, String((err && err.stack) || err));
  }
  results.faults = faults;
  fs.writeFileSync = realWrite;
  fs.renameSync = realRename;
  try { realWrite(CFG.out, JSON.stringify(results)); } catch (_) {}
  app.exit(0);
});
setTimeout(() => { try { realWrite(CFG.out, JSON.stringify(results)); } catch (_) {} app.exit(3); }, 60000);
`;

function runHarness(c, opts) {
  const o = opts || {};
  const out = path.join(c.dir, 'out-' + o.mode + '.json');
  const hf = path.join(c.dir, 'harness-' + o.mode + '.cjs');
  const cfg = {
    mode: o.mode, doc: c.doc, newDoc: c.newDoc, sidecar: c.sidecar, newSidecar: c.newSidecar,
    libFile: c.libFile, data: path.join(c.dir, 'data-' + o.mode), ud: c.ud, out,
    fault: o.fault || 'none', blockRollback: !!o.blockRollback,
  };
  fs.writeFileSync(hf, HARNESS.split('__ROOT__').join(JSON.stringify(ROOT)).split('__CFG__').join(JSON.stringify(cfg)));
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const r = spawnSync(ELECTRON, [hf, '--no-sandbox', '--disable-gpu'], { cwd: ROOT, env, encoding: 'utf8', timeout: 90000 });
  let res = null;
  try { res = JSON.parse(fs.readFileSync(out, 'utf8')); } catch (_) {}
  if (!res) {
    console.log('  ! 没有拿到结果（exit=' + (r && r.status) + '）');
    console.log(String((r && r.stdout) || '').slice(-1000));
    console.log(String((r && r.stderr) || '').slice(-600));
    return { checks: [['垫片有结果', false, 'exit ' + (r && r.status)]] };
  }
  return res;
}

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } }

// ---------- 1. 正常改名：三样东西一起走 ----------
{
  const c = makeCase('ok');
  const res = runHarness(c, { mode: 'ok' });
  const r = res.rename || {};
  check('正常改名成功', r.ok === true && r.renamed === 1 && r.failed === 0, r);
  check('PDF 到了新路径', !fs.existsSync(c.doc) && fs.existsSync(c.newDoc), res.state);
  check('标注搬到新 hash', !fs.existsSync(c.sidecar) && fs.existsSync(c.newSidecar), res.state);
  check('库指向新路径', path.resolve(res.state.itemPath || '') === path.resolve(c.newDoc), res.state.itemPath);
  const sc = readJson(c.newSidecar);
  check('新标注里记的 path 是新路径', sc && path.resolve(sc.path) === path.resolve(c.newDoc), sc && sc.path);
  check('书签跟着搬过去', sc && Array.isArray(sc.bookmarks) && sc.bookmarks.length === 1, sc && sc.bookmarks);
  const an = res.newAnno || {};
  check('新路径打开能看到原标注', an.ok && an.pages && an.pages[0] && an.pages[0].shapes[0].id === 'aOLD000001', an && an.status);
}

// ---------- 2. G03：标注搬不过去 → 整次改名放弃，PDF 不动 ----------
{
  const c = makeCase('sidecar-fail');
  const res = runHarness(c, { mode: 'sidecar-fail', fault: 'sidecar' });
  const r = res.rename || {};
  check('标注写不进去时改名不算成功', r.ok === false && r.failed === 1 && r.renamed === 0, r);
  check('错误指明是标注那一步', ((r.errors || [])[0] || {}).step === 'sidecar', (r.errors || [])[0]);
  check('PDF 留在原路径', fs.existsSync(c.doc) && !fs.existsSync(c.newDoc), res.state);
  check('旧标注原封不动', fs.existsSync(c.sidecar) && fs.readFileSync(c.sidecar, 'utf8') === c.sidecarBody, res.state);
  check('没有留下半截的新标注', !fs.existsSync(c.newSidecar), res.state);
  const lib = readJson(c.libFile);
  check('库仍指向旧路径', path.resolve(lib.items[0].attachment.path) === path.resolve(c.doc), lib.items[0].attachment);
  const an = res.oldAnno || {};
  check('原路径打开仍能看到标注', an.ok && an.pages && an.pages[0] && an.pages[0].shapes.length === 1, an && an.status);
}

// ---------- 3. G02：库写失败 → 文件改回原名，库/磁盘一致 ----------
{
  const c = makeCase('library-fail');
  const res = runHarness(c, { mode: 'library-fail', fault: 'library' });
  const r = res.rename || {};
  check('库写失败时改名不算成功', r.ok === false && r.failed === 1 && r.renamed === 0, r);
  check('PDF 被改回原名', fs.existsSync(c.doc) && !fs.existsSync(c.newDoc), res.state);
  check('新标注被撤销', !fs.existsSync(c.newSidecar), res.state);
  check('旧标注还在', fs.existsSync(c.sidecar), res.state);
  const lib = readJson(c.libFile);
  check('库（磁盘）仍是旧路径', path.resolve(lib.items[0].attachment.path) === path.resolve(c.doc), lib.items[0].attachment);
  check('库（内存）也是旧路径', path.resolve(res.state.itemPath || '') === path.resolve(c.doc), res.state.itemPath);
  const an = res.oldAnno || {};
  check('原路径打开仍能看到标注', an.ok && an.pages && an.pages[0] && an.pages[0].shapes.length === 1, an && an.status);
}

// ---------- 4. G02 续：改不回去时留下可恢复记录，重启补上 ----------
{
  const c = makeCase('rollback-blocked');
  const res = runHarness(c, { mode: 'rollback-blocked', fault: 'library', blockRollback: true });
  const r = res.rename || {};
  check('报告失败并说明真实位置', r.ok === false && /改不回去|现在在/.test(((r.errors || [])[0] || {}).error || ''), (r.errors || [])[0]);
  check('PDF 确实在新路径', fs.existsSync(c.newDoc) && !fs.existsSync(c.doc), res.state);
  check('标注跟到了新路径', fs.existsSync(c.newSidecar), res.state);
  check('留下了待恢复记录', Array.isArray(res.pending) && res.pending.length === 1, res.pending);

  // 再启动一次：启动收拾应该把库指向真实文件
  const c2 = c;
  const res2 = runHarness(c2, { mode: 'after-restart' });
  check('重启后库改指到真实文件', path.resolve((res2.state || {}).itemPath || '') === path.resolve(c.newDoc), res2.state);
  const lib = readJson(c.libFile);
  check('重启后库（磁盘）也指向新路径', path.resolve(lib.items[0].attachment.path) === path.resolve(c.newDoc), lib.items[0].attachment);
}

console.log('[rename-attachment] ' + (fail ? 'FAIL ' : 'PASS ') + '(' + total + ')');
process.exitCode = fail ? 1 : 0;
