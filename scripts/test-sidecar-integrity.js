'use strict';
/*
 * B02 / B03 回归：标注副文件的读写一致性。
 *
 *   A. 纯 Node 直接测 SidecarStore 的策略：缺失可创建、有效可追加、
 *      损坏默认拒绝、显式 force 先备份并重建、回调抛错不落盘。
 *   B. 真实 Electron IPC：损坏的 sidecar 上「存为图片标注」必须失败且不动原文件；
 *      编辑标注在写盘失败时报磁盘原因，而不是「没找到这条标注」。
 *
 * 运行：node scripts/test-sidecar-integrity.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createSidecarStore } = require('../src/sidecar-store.js');
const { atomicWrite } = require('../src/atomic-file.js');

let fail = 0; let total = 0;
function check(name, ok, detail) {
  total++;
  if (!ok) { fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  <- ' + JSON.stringify(detail) : '')); }
  else console.log('  ok   ' + name);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-sidecar-'));
const store = createSidecarStore({
  fileFor: (p) => path.join(root, crypto.createHash('sha1').update(String(p)).digest('hex').slice(0, 16) + '.json'),
  atomicWrite,
  backupNameFor: (f) => f.replace(/\.json$/i, '') + '.broken-' + Date.now() + '.json',
});

// ---------- A1 缺失 → 首次创建 ----------
{
  const doc = path.join(root, 'doc-a.pdf');
  const file = store.read(doc).file;
  const r = store.update(doc, (obj) => { obj.pages = [{ page: 1, shapes: [{ id: 'A1' }] }]; return obj; });
  check('缺失文件可以首次创建', r.ok && fs.existsSync(file), r);
  check('创建后能读回内容', store.read(doc).status === 'ok' && store.read(doc).data.pages[0].shapes[0].id === 'A1', store.read(doc).status);
}

// ---------- A2 有效 → 追加保留旧内容 ----------
{
  const doc = path.join(root, 'doc-b.pdf');
  const file = store.read(doc).file;
  fs.writeFileSync(file, JSON.stringify({ path: doc, saved: 1, pages: [{ page: 1, shapes: [{ id: 'B1', text: '旧' }] }], bookmarks: [{ page: 3 }] }));
  const r = store.update(doc, (obj) => { obj.pages[0].shapes.push({ id: 'B2', text: '新' }); return obj; });
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  check('追加成功', r.ok, r);
  check('旧标注仍在', after.pages[0].shapes.some((s) => s.id === 'B1'), after.pages[0].shapes);
  check('新标注写入', after.pages[0].shapes.some((s) => s.id === 'B2'), after.pages[0].shapes);
  check('书签没被冲掉', Array.isArray(after.bookmarks) && after.bookmarks.length === 1, after.bookmarks);
}

// ---------- A3 损坏 → 拒绝覆盖，字节不变 ----------
{
  const doc = path.join(root, 'doc-c.pdf');
  const file = store.read(doc).file;
  const brokenBytes = '{"path":"x","pages":[{"page":1,"shapes":[{"id":"C1"';
  fs.writeFileSync(file, brokenBytes);
  const before = fs.readFileSync(file, 'utf8');
  const r = store.update(doc, (obj) => { obj.pages = []; return obj; });
  check('损坏文件被识别为 broken', store.read(doc).status === 'broken', store.read(doc).status);
  check('损坏时拒绝普通保存', r.ok === false && r.code === 'broken', r);
  check('原文件字节没变', fs.readFileSync(file, 'utf8') === before, '');
  const backups = fs.readdirSync(root).filter((f) => /\.broken-\d+\.json$/.test(f));
  check('没有偷偷生成备份（普通保存被拒）', backups.length === 0, backups);
}

// ---------- A4 损坏 + force → 先备份再重建 ----------
{
  const doc = path.join(root, 'doc-d.pdf');
  const file = store.read(doc).file;
  const brokenBytes = '{"path":"x","pages":[{';
  fs.writeFileSync(file, brokenBytes);
  const r = store.update(doc, (obj) => { obj.pages = [{ page: 1, shapes: [{ id: 'D1' }] }]; return obj; }, { force: true });
  check('force 重建成功', r.ok && !!r.backup, r);
  check('重建前的原文件被备份', !!r.backup && fs.readFileSync(r.backup, 'utf8') === brokenBytes, r.backup);
  check('重建后文件可解析', store.read(doc).status === 'ok', store.read(doc).status);
}

// ---------- A5 回调抛错 → 不落盘 ----------
{
  const doc = path.join(root, 'doc-e.pdf');
  const file = store.read(doc).file;
  fs.writeFileSync(file, JSON.stringify({ path: doc, saved: 1, pages: [] }));
  const before = fs.readFileSync(file, 'utf8');
  const r = store.update(doc, () => { throw new Error('boom'); });
  check('回调抛错返回失败', r.ok === false && r.code === 'update', r);
  check('回调抛错时原文件不变', fs.readFileSync(file, 'utf8') === before, '');
}

// ---------- A6 写入失败 → 报真实原因，旧文件仍可解析 ----------
{
  const doc = path.join(root, 'doc-f.pdf');
  const file = store.read(doc).file;
  const good = JSON.stringify({ path: doc, saved: 1, pages: [{ page: 1, shapes: [{ id: 'F1', comment: '旧' }] }] });
  fs.writeFileSync(file, good);
  // 用一个「原子替换一定失败」的 store 模拟磁盘满 / 权限不足
  const failing = createSidecarStore({
    fileFor: () => file,
    atomicWrite: () => { const e = new Error('ENOSPC: no space left on device'); e.code = 'ENOSPC'; throw e; },
    backupNameFor: (f) => f + '.bak',
  });
  const r = failing.update(doc, (obj) => { obj.pages[0].shapes[0].comment = '新'; return obj; });
  check('写入失败被报出来', r.ok === false && r.code === 'write', r);
  check('错误里带磁盘原因', /ENOSPC|空间|失败/.test(String(r.error)), r.error);
  check('写入失败后旧文件仍可解析', JSON.parse(fs.readFileSync(file, 'utf8')).pages[0].shapes[0].comment === '旧', fs.readFileSync(file, 'utf8'));
}

// ---------- B. 真实 Electron IPC ----------
const { runProbe } = require('./probe-runner');

function partB() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-sidecar-ipc-'));
  const ud = path.join(dir, 'ud');
  const doc = path.join(dir, 'broken.pdf');
  fs.writeFileSync(doc, '%PDF-1.4\n%%EOF\n');
  const annoDir = path.join(ud, 'annotations');
  fs.mkdirSync(annoDir, { recursive: true });
  const sidecar = path.join(annoDir, crypto.createHash('sha1').update(path.resolve(doc)).digest('hex').slice(0, 20) + '.json');
  const truncated = '{"path":"' + path.resolve(doc).replace(/\\/g, '\\\\') + '","saved":1,"pages":[{"page":1,"shapes":[{"id":"X1"';
  fs.writeFileSync(sidecar, truncated);

  const code = `(async () => {
    const checks = [];
    const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d).slice(0, 200)]);
    const p = ${JSON.stringify(doc)};
    const st = await pdfBridge.loadAnnosState(p);
    push('损坏 sidecar 被识别', st && st.status === 'broken', JSON.stringify(st && st.status));
    const img = await pdfBridge.saveImageAnno({ path: p, page: 1, rect: { x: 10, y: 10, w: 20, h: 20 },
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' });
    push('损坏文件上存图片标注被拒', img && img.ok === false && img.broken === true, JSON.stringify(img));
    const upd = await pdfBridge.updateAnno('X1', { comment: '改一下' });
    push('损坏目录里编辑标注不误报「没找到」', upd && upd.ok === false && !/没找到/.test(upd.error || ''), JSON.stringify(upd));
    return { checks };
  })()`;
  const file = path.join(dir, 'probe.cjs');
  fs.writeFileSync(file, 'module.exports=' + JSON.stringify(code));

  const out = runProbe({
    probe: file,
    env: {
      PDFREADER_LIBRARY: path.join(dir, 'library.json'),
      PDFREADER_DATA_DIR: dir,
      PDFREADER_NO_AUTO_INDEX: '1',
    },
    args: ['--user-data-dir=' + ud],
    timeout: 60000,
    label: 'sidecar-ipc',
  });
  const before = fs.readFileSync(sidecar, 'utf8');
  check('损坏文件在两次调用后字节未变', before === truncated, before.slice(0, 40));
  const snaps = path.join(ud, 'snapshots');
  const pngCount = fs.existsSync(snaps) ? fs.readdirSync(snaps).filter((f) => /\.png$/.test(f)).length : 0;
  check('被拒的图片没有留下孤立文件', pngCount === 0, pngCount);
  return out;
}

// ---------- C. R01：补 ID 写盘失败时不得迁移库内关联 ----------
function partC() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-sidecar-migrate-'));
  const ud = path.join(dir, 'ud');
  const doc = path.join(dir, 'legacy.pdf');
  fs.writeFileSync(doc, '%PDF-1.4\n%%EOF\n');
  const annoDir = path.join(ud, 'annotations');
  fs.mkdirSync(annoDir, { recursive: true });
  const fileId = crypto.createHash('sha1').update(path.resolve(doc)).digest('hex').slice(0, 20);
  const sidecar = path.join(annoDir, fileId + '.json');
  const legacyKey = fileId + ':1:0';
  const body = JSON.stringify({ path: doc, saved: 1, pages: [{ page: 1, shapes: [{ tool: 'text', text: 'legacy', at: { x: 10, y: 20 } }] }] });
  fs.writeFileSync(sidecar, body);
  const libFile = path.join(dir, 'library.json');
  fs.writeFileSync(libFile, JSON.stringify({
    version: 8, collections: [], searches: [], tagColors: {}, feeds: [], noteAliases: {},
    annoTags: {}, items: [{ key: 'a', title: 'Legacy', attachment: { path: doc, name: 'legacy.pdf' } }],
    annoMeta: { [legacyKey]: { text: '', comment: '', tags: ['important'], itemKey: 'a', noteIds: [], created: 1, updated: 1 } },
  }));

  const probeCode = (expectFailed) => `(async () => {
    const checks = [];
    const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d).slice(0, 160)]);
    const p = ${JSON.stringify(doc)};
    const a = await pdfBridge.loadAnnosState(p);
    push(${JSON.stringify('returned-migration')}, a && a.status === 'ok' && a.migration === ${JSON.stringify('PLACEHOLDER')}, JSON.stringify(a && { ok: a.ok, status: a.status, migration: a.migration }));
    const idA = a && a.pages && a.pages[0] && a.pages[0].shapes[0] && a.pages[0].shapes[0].id;
    push('标注仍然可读（不遮住已有内容）', !!(a && a.pages && a.pages.length === 1), '');
    const b = await pdfBridge.loadAnnosState(p);
    const idB = b && b.pages && b.pages[0] && b.pages[0].shapes[0] && b.pages[0].shapes[0].id;
    push('两次读取给出同一个推导 id（不漂移）', !!idA && idA === idB, idA + ' vs ' + idB);
    return { checks };
  })()`.replace('"PLACEHOLDER"', JSON.stringify(expectFailed ? 'failed' : 'ok'));

  const run = (expectFailed) => {
    const file = path.join(dir, 'probe-' + (expectFailed ? 'locked' : 'free') + '.cjs');
    fs.writeFileSync(file, 'module.exports=' + JSON.stringify(probeCode(expectFailed)));
    return runProbe({
      probe: file,
      env: { PDFREADER_LIBRARY: libFile, PDFREADER_DATA_DIR: dir, PDFREADER_NO_AUTO_INDEX: '1' },
      args: ['--user-data-dir=' + ud],
      timeout: 60000,
      label: expectFailed ? 'sidecar-migrate-locked' : 'sidecar-migrate-free',
    });
  };

  fs.chmodSync(sidecar, 0o444);
  const failRun = run(true);
  check('迁移失败时原文件字节不变', fs.readFileSync(sidecar, 'utf8') === body, '');
  const lib1 = JSON.parse(fs.readFileSync(libFile, 'utf8'));
  check('只有旧键的标签仍在库内', !!(lib1.annoMeta && lib1.annoMeta[legacyKey] && lib1.annoMeta[legacyKey].tags.includes('important')),
    Object.keys(lib1.annoMeta || {}));

  // 恢复写权限后重新打开：应当补 ID、写回文件，并把关联迁过去
  fs.chmodSync(sidecar, 0o666);
  const okRun = run(false);
  const after = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
  const newId = after.pages[0].shapes[0].id;
  const lib2 = JSON.parse(fs.readFileSync(libFile, 'utf8'));
  check('恢复权限后 id 落盘', !!newId && newId !== undefined, newId);
  check('恢复权限后关联迁到新 id', !!(lib2.annoMeta && lib2.annoMeta[newId] && lib2.annoMeta[newId].tags.includes('important')),
    Object.keys(lib2.annoMeta || {}));
  check('旧键已清理', !(lib2.annoMeta || {})[legacyKey], Object.keys(lib2.annoMeta || {}));
  return { total: (failRun.total || 0) + (okRun.total || 0), fail: (failRun.fail || 0) + (okRun.fail || 0) };
}

try {
  const res = partB();
  // runProbe 已经把每条断言打印过了，这里只并入总数
  total += res.total || 0;
  fail += res.fail || 0;
} catch (err) {
  check('探针执行', false, String(err && err.message));
}

try {
  const c = partC();
  total += c.total; fail += c.fail;
} catch (err) {
  check('迁移失败探针执行', false, String(err && err.message));
}

console.log('[sidecar-integrity] ' + (fail ? 'FAIL ' : 'PASS ') + '(' + total + ')');
process.exitCode = fail ? 1 : 0;
