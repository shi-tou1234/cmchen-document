'use strict';
/*
 * 老标注 ID 迁移的两条失败路径（二次复查 F01 / F02）。
 *
 * F02：sidecar 已换成稳定 id、library.json 那一次原子写失败。以前接口照旧报
 *      migration:'ok'，标签永久挂在旧键上，重开也不会补（形状已有 id，映射不再产生）。
 * F01：sidecar 写失败后界面停在 migration:'failed'，磁盘恢复可写也出不来：
 *      flush 被同一个状态拦住，切标签 / 关文档都走不了。
 *
 * 这两条都需要「在真实写入点注入故障」，所以不用 probe-runner，直接用一个
 * 自定义主进程垫片：它先给 fs.writeFileSync 装好故障，再 require src/main.js，
 * 让启动迁移、IPC、渲染层都跑真实代码。
 *
 * 运行：node scripts/test-migration-retry.js
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-migration-'));

function makeCase(name) {
  const dir = path.join(tmp, name);
  const ud = path.join(dir, 'ud');
  fs.mkdirSync(path.join(ud, 'annotations'), { recursive: true });
  const doc = path.join(dir, name + '.pdf');
  fs.copyFileSync(path.join(ROOT, 'assets/sample.pdf'), doc);
  const fileId = crypto.createHash('sha1').update(path.resolve(doc)).digest('hex').slice(0, 20);
  const sidecar = path.join(ud, 'annotations', fileId + '.json');
  const legacyKey = fileId + ':1:0';
  // 老格式：形状没有 id，库里标签挂在位置式键上
  const sidecarBody = JSON.stringify({
    path: doc, saved: 1,
    pages: [{ page: 1, shapes: [{ tool: 'text', text: '旧的', at: { x: 60, y: 90 }, color: '#000000' }] }],
  });
  fs.writeFileSync(sidecar, sidecarBody);
  const libFile = path.join(dir, 'library.json');
  fs.writeFileSync(libFile, JSON.stringify({
    version: 8, collections: [], searches: [], tagColors: {}, feeds: [], noteAliases: {},
    annoTags: {}, items: [{ key: 'k1', title: name, attachment: { path: doc, name: path.basename(doc) } }],
    annoMeta: {
      [legacyKey]: { text: '', comment: '', tags: ['important'], itemKey: 'k1', noteIds: [], created: 1, updated: 1 },
    },
  }));
  return { name, dir, ud, doc, fileId, sidecar, libFile, legacyKey, sidecarBody };
}

const HARNESS = `'use strict';
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const ROOT = __ROOT__;
const CFG = __CFG__;

// 故障注入：只命中指定文件的「原子替换临时文件」，一次或一直命中
const realWrite = fs.writeFileSync;
let injected = 0;
let armed = !!CFG.startArmed;
function hit(file) {
  if (!armed) return false;
  const f = String(file);
  if (!/\\.tmp$/.test(f)) return false;
  if (CFG.fault === 'index') return f.startsWith(CFG.libFile + '.');
  if (CFG.fault === 'sidecar') return f.startsWith(CFG.sidecar + '.');
  return false;
}
// 保存慢一点：用来制造「请求还在飞、用户又画了一笔」的窗口（G01 第二条）
let slowLeft = CFG.slowSave ? 1 : 0;
const realRead = fs.readFileSync;
let delayLeft = CFG.delayRead ? 1 : 0;
fs.writeFileSync = function (file) {
  const f = String(file);
  if (slowLeft && /\.tmp$/.test(f) && f.startsWith(CFG.sidecar + '.')) {
    slowLeft--;
    const t0 = Date.now();
    while (Date.now() - t0 < 900) { /* 阻塞主进程，模拟慢盘 */ }
  }
  if (hit(file) && injected < CFG.maxFaults) {
    injected++;
    const e = new Error('ENOSPC: no space left on device (injected)');
    e.code = 'ENOSPC';
    throw e;
  }
  return realWrite.apply(this, arguments);
};
// 把「读标注」这一步拖住：用户在这段时间里画的东西，绝不能算进「磁盘上已有的内容」
fs.readFileSync = function (file) {
  if (delayLeft && String(file) === CFG.sidecar) {
    delayLeft--;
    const t0 = Date.now();
    while (Date.now() - t0 < 1200) { /* 阻塞主进程，模拟慢读 */ }
  }
  return realRead.apply(this, arguments);
};
function release() { fs.writeFileSync = realWrite; fs.readFileSync = realRead; }

process.env.PDFREADER_TEST = '1';
process.env.PDFREADER_HIDDEN = '1';
process.env.PDFREADER_NO_AUTO_INDEX = '1';
process.env.PDFREADER_LIBRARY = CFG.libFile;
process.env.PDFREADER_DATA_DIR = CFG.data;
app.setPath('userData', CFG.ud);
require(path.join(ROOT, 'src/main.js'));

const results = { mode: CFG.mode, faults: 0, checks: [] };
const push = (n, ok, d) => results.checks.push([n, !!ok, d === undefined ? '' : String(d).slice(0, 220)]);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } };
let win = null;
const run = (fn, arg) => win.webContents.executeJavaScript('(' + fn.toString() + ')(' + JSON.stringify(arg) + ')', true);

app.whenReady().then(async () => {
  await pause(250);
  win = BrowserWindow.getAllWindows()[0];
  if (win && win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
  if (win) win.webContents.setBackgroundThrottling(false);
  await pause(500);
  try {
    if (CFG.mode === 'index-fail') {
      // sidecar 在 ready 之后才落盘：启动补齐扫不到它，故障只影响「这一次加载」
      if (CFG.seed) realWrite(CFG.sidecar, fs.readFileSync(CFG.seed));
      armed = true;      // 只让这一次加载的库写入失败
      const a = await run((p) => pdfBridge.loadAnnosState(p), CFG.doc);
      armed = false;
      push('库索引写失败时不报迁移成功', a && a.migration === 'library-failed', JSON.stringify(a && { ok: a.ok, migration: a.migration, error: a.error }));
      const sc1 = readJson(CFG.sidecar);
      push('稳定 ID 已写进文件', !!(sc1 && sc1.pages[0].shapes[0].id), sc1 && sc1.pages[0].shapes[0]);
      push('待迁移映射留在 sidecar 里', !!(sc1 && sc1.pendingIds && Object.keys(sc1.pendingIds).length === 1), sc1 && sc1.pendingIds);
      const lb1 = readJson(CFG.libFile);
      push('旧键标签未被删除', !!(lb1 && lb1.annoMeta[CFG.legacyKey] && lb1.annoMeta[CFG.legacyKey].tags.includes('important')),
        lb1 && Object.keys(lb1.annoMeta));
      push('新 ID 上还没有标签（确实是半途）', !(lb1 && lb1.annoMeta[sc1.pages[0].shapes[0].id]), lb1 && Object.keys(lb1.annoMeta));

      // 故障解除后同窗口重试
      const retry = await run((p) => pdfBridge.migrateAnnos(p), CFG.doc);
      push('重试报告迁移完成', retry && retry.ok === true && retry.migration === 'ok', JSON.stringify(retry));
      const sc2 = readJson(CFG.sidecar);
      const id = sc2.pages[0].shapes[0].id;
      push('成功后清掉待迁移映射', !sc2.pendingIds, sc2.pendingIds);
      const lb2 = readJson(CFG.libFile);
      push('标签迁到真正的稳定 ID', !!(lb2 && lb2.annoMeta[id] && lb2.annoMeta[id].tags.includes('important')), lb2 && Object.keys(lb2.annoMeta));
      push('旧键已清理', !(lb2 && lb2.annoMeta[CFG.legacyKey]), lb2 && Object.keys(lb2.annoMeta));
      const again = await run((p) => pdfBridge.migrateAnnos(p), CFG.doc);
      push('重复重试是空操作', again && again.ok === true && again.remapped === 0, JSON.stringify(again));
      const lb3 = readJson(CFG.libFile);
      push('重复重试不产生空对象', !!(lb3 && lb3.annoMeta[id] && Object.keys(lb3.annoMeta).length === 1), lb3 && Object.keys(lb3.annoMeta));
    } else if (CFG.mode === 'index-fail-all' || CFG.mode === 'index-after-restart') {
      if (CFG.mode === 'index-fail-all') {
        const a = await run((p) => pdfBridge.loadAnnosState(p), CFG.doc);
        push('首次加载报告半途', a && a.migration === 'library-failed', JSON.stringify(a && a.migration));
        const sc = readJson(CFG.sidecar);
        push('待迁移映射已存盘（等重启也能补）', !!(sc && sc.pendingIds), sc && sc.pendingIds);
      } else {
        const sc = readJson(CFG.sidecar);
        const id = sc && sc.pages[0].shapes[0].id;
        const lb = readJson(CFG.libFile);
        push('重启后自动补完迁移（启动升级）', !!(lb && id && lb.annoMeta[id] && lb.annoMeta[id].tags.includes('important')),
          lb && Object.keys(lb.annoMeta));
        push('重启后待迁移映射已清', !(sc && sc.pendingIds), sc && sc.pendingIds);
        const a = await run((p) => pdfBridge.loadAnnosState(p), CFG.doc);
        push('重启后加载报告迁移完成', a && a.migration === 'ok', JSON.stringify(a && a.migration));
      }
    } else if (CFG.mode === 'retry-in-window') {
      // 打开文档 → 渲染层进入 migration:'failed'
      win.webContents.send('pdf-opened', {
        ok: true, filePath: CFG.doc, fileName: path.basename(CFG.doc), startPage: 1,
        data: new Uint8Array(fs.readFileSync(CFG.doc)),
      });
      let st = null;
      for (let i = 0; i < 150; i++) {
        st = await run(() => (App.state.annoState && App.state.annoState.migration === 'failed')
          ? { migration: App.state.annoState.migration, n: [...App.state.annos.values()].flat().length } : null);
        if (st) break;
        await pause(100);
      }
      push('打开后进入迁移失败状态', !!st, JSON.stringify(st));
      const blocked = await run(async () => ({ flush: await App.flushAnnos(), rebuild: await App.rebuildAnnosFile() }));
      push('故障未解除时保存仍被拦住', blocked.flush === false, JSON.stringify(blocked.flush));
      push('重建入口不拿内存覆盖有效文件', blocked.rebuild && blocked.rebuild.ok === false && blocked.rebuild.migration === 'failed',
        JSON.stringify(blocked.rebuild));

      // 故障解除：用户在失败期间新画一条，然后点重试
      release();
      const added = await run(() => {
        const arr = App.state.annos.get(1) || [];
        arr.push({ id: 'aNEWONE001', tool: 'text', color: '#000000', width: 1, at: { x: 40, y: 40 }, text: '新的' });
        App.state.annos.set(1, arr);
        return [...App.state.annos.values()].flat().length;
      });
      push('失败期间可以继续编辑', added === 2, added);
      const flushed = await run(async () => await App.flushAnnos());
      push('恢复写入后 flush 成功', flushed === true, JSON.stringify(flushed));
      const after = await run(() => ({ migration: App.state.annoState && App.state.annoState.migration, n: [...App.state.annos.values()].flat().length }));
      push('状态回到可保存', after && after.migration === 'ok' && after.n === 2, JSON.stringify(after));
    } else if (CFG.mode === 'draw-during-restore') {
      // 先把「读盘期间画一笔」装进渲染层，再打开文档
      const install = await run(() => {
        window.__draw = (async () => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const t0 = Date.now();
          let svg = null;
          while (Date.now() - t0 < 20000) {
            svg = document.querySelector('#page-1 .anno');
            if (svg) break;
            await sleep(30);
          }
          if (!svg) return { ok: false, error: 'no anno layer' };
          Anno.setTool('pen');
          const ctm = svg.getScreenCTM();
          const toC = (x, y) => { const p = new DOMPoint(x, y).matrixTransform(ctm); return { x: p.x, y: p.y }; };
          const a = toC(80, 120), b = toC(300, 120);
          svg.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 77, clientX: a.x, clientY: a.y }));
          window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 77, clientX: b.x, clientY: b.y }));
          window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 77, clientX: b.x, clientY: b.y }));
          await sleep(80);
          return { ok: true, n: [...App.state.annos.values()].flat().length };
        })();
        return true;
      });
      if (!install) push('装上绘制脚本', false, '');
      win.webContents.send('pdf-opened', {
        ok: true, filePath: CFG.doc, fileName: path.basename(CFG.doc), startPage: 1,
        data: new Uint8Array(realRead(CFG.doc)),
      });
      let drewRes = null;
      try { drewRes = await run(() => window.__draw); } catch (_) {}
      let st = null;
      for (let i = 0; i < 200; i++) {
        st = await run(() => (App.state.annoState && App.state.annoState.migration === 'failed')
          ? { migration: App.state.annoState.migration, n: [...App.state.annos.values()].flat().length } : null);
        if (st) break;
        await pause(100);
      }
      push('读盘期间成功画了一笔', !!(drewRes && drewRes.ok && drewRes.n >= 1), JSON.stringify(drewRes));
      push('恢复完成后标注读到了，新笔迹也在', !!st && st.n === 2, JSON.stringify(st));
      const state = await run(() => ({ unsaved: App.annoHasUnsaved(), n: [...App.state.annos.values()].flat().length }));
      push('读盘期间的新笔迹没有被当成已保存', state && state.unsaved === true, JSON.stringify(state));
      const leave = await run(async () => await App.flushBeforeLeave('切换文档'));
      push('有未保存新笔迹时不按「无改动」放行', leave === false, JSON.stringify(leave));
      // 解除故障：补存之后两条都应落盘
      release();
      const flushed = await run(async () => await App.flushAnnos());
      push('恢复写入后补存成功', flushed === true, JSON.stringify(flushed));
    } else if (CFG.mode === 'slow-save-edit') {
      win.webContents.send('pdf-opened', {
        ok: true, filePath: CFG.doc, fileName: path.basename(CFG.doc), startPage: 1,
        data: new Uint8Array(realRead(CFG.doc)),
      });
      let ready = null;
      for (let i = 0; i < 150; i++) {
        ready = await run(() => (App.state.annoState && App.state.annoState.status === 'ok'
          && App.state.annoState.migration === 'ok') ? { n: [...App.state.annos.values()].flat().length } : null);
        if (ready) break;
        await pause(100);
      }
      push('文档加载完成', !!ready, JSON.stringify(ready));
      const r = await run(async () => {
        const p = App.flushAnnos();       // 保存请求已经发出（主进程会慢 900ms）
        await new Promise((res) => setTimeout(res, 150));
        const arr = App.state.annos.get(1) || [];
        arr.push({ id: 'aLATEEDIT01', tool: 'text', color: '#000000', width: 1, at: { x: 20, y: 20 }, text: '回执前又画的一笔' });
        App.state.annos.set(1, arr);
        const ok = await p;
        return { ok, unsaved: App.annoHasUnsaved(), n: [...App.state.annos.values()].flat().length };
      });
      push('回执成功；但等待期间的新编辑仍算未保存', r && r.ok === true && r.unsaved === true, JSON.stringify(r));
    } else if (CFG.mode === 'leave-without-changes') {
      win.webContents.send('pdf-opened', {
        ok: true, filePath: CFG.doc, fileName: path.basename(CFG.doc), startPage: 1,
        data: new Uint8Array(fs.readFileSync(CFG.doc)),
      });
      let st = null;
      for (let i = 0; i < 150; i++) {
        st = await run(() => (App.state.annoState && App.state.annoState.migration === 'failed') ? App.state.annoState.migration : null);
        if (st) break;
        await pause(100);
      }
      push('打开后进入迁移失败状态', !!st, JSON.stringify(st));
      const canLeave = await run(async () => await App.flushBeforeLeave('切换标签'));
      push('没有未保存改动时可以安全离开', canLeave === true, JSON.stringify(canLeave));
      const blocked = await run(async () => {
        const arr = App.state.annos.get(1) || [];
        arr.push({ id: 'aNEWTWO0002', tool: 'text', color: '#000000', width: 1, at: { x: 30, y: 30 }, text: '待保存' });
        App.state.annos.set(1, arr);
        return await App.flushBeforeLeave('切换标签');
      });
      push('有未保存改动时仍然拦住', blocked === false, JSON.stringify(blocked));
    }
  } catch (err) {
    push('垫片执行', false, String((err && err.stack) || err));
  }
  results.faults = injected;
  release();
  try { realWrite(CFG.out, JSON.stringify(results)); } catch (_) {}
  app.exit(0);
});

setTimeout(() => {
  try { realWrite(CFG.out, JSON.stringify(results)); } catch (_) {}
  app.exit(3);
}, 90000);
`;

function runHarness(c, opts) {
  const o = opts || {};
  const out = path.join(c.dir, 'out-' + o.mode + '.json');
  const hf = path.join(c.dir, 'harness-' + o.mode + '.cjs');
  const cfg = {
    mode: o.mode,
    doc: c.doc, libFile: c.libFile, sidecar: c.sidecar, legacyKey: c.legacyKey,
    data: path.join(c.dir, 'data-' + o.mode), ud: c.ud,
    out,
    fault: o.fault || 'none',
    maxFaults: o.maxFaults || 0,
    startArmed: o.startArmed !== false,
    seed: o.seed || '',
    slowSave: !!o.slowSave,
    delayRead: !!o.delayRead,
  };
  fs.writeFileSync(hf, HARNESS.split('__ROOT__').join(JSON.stringify(ROOT)).split('__CFG__').join(JSON.stringify(cfg)));
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const r = spawnSync(ELECTRON, [hf, '--no-sandbox', '--disable-gpu'], {
    cwd: ROOT, env, encoding: 'utf8', timeout: 120000,
  });
  let res = null;
  try { res = JSON.parse(fs.readFileSync(out, 'utf8')); } catch (_) {}
  if (!res) {
    console.log('  ! 没有拿到结果（exit=' + (r && r.status) + '）');
    console.log(String((r && r.stdout) || '').slice(-1200));
    console.log(String((r && r.stderr) || '').slice(-800));
    return { checks: [['垫片有结果', false, 'exit ' + (r && r.status)]], faults: 0 };
  }
  return res;
}

function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } }

function absorb(label, res) {
  for (const [name, ok, detail] of (res.checks || [])) check(label + ' · ' + name, ok, ok ? undefined : detail);
}

// MIG_ONLY=index / restart / retry / leave 只跑其中一组（调试用）
const ONLY = process.env.MIG_ONLY || '';

// ---------- F02：库索引写失败 ----------
if (!ONLY || ONLY === 'index') {
  const c = makeCase('index');
  const seed = path.join(c.dir, 'seed.json');
  fs.writeFileSync(seed, c.sidecarBody);
  fs.unlinkSync(c.sidecar);        // 启动时还没有这份标注，加载时才出现
  const res = runHarness(c, { mode: 'index-fail', fault: 'index', maxFaults: 1, startArmed: false, seed });
  absorb('F02', res);
  check('F02 · 故障确实注入了一次', res.faults === 1, res.faults);
  if (process.env.MIG_DEBUG) console.log(JSON.stringify(res.debugLib));
  const sc = JSON.parse(fs.readFileSync(c.sidecar, 'utf8'));
  check('F02 · 落盘后 sidecar 结构完好', Array.isArray(sc.pages) && sc.pages[0].shapes.length === 1, sc.pages && sc.pages.length);
}

// ---------- F02：半途中断 + 重启补完 ----------
if (!ONLY || ONLY === 'restart') {
  const c = makeCase('restart');
  const r1 = runHarness(c, { mode: 'index-fail-all', fault: 'index', maxFaults: 99 });
  absorb('F02-重启前', r1);
  const r2 = runHarness(c, { mode: 'index-after-restart' });
  absorb('F02-重启后', r2);
}

// ---------- F01：同一窗口重试 + 新笔迹保全 ----------
if (!ONLY || ONLY === 'retry') {
  const c = makeCase('retry');
  const res = runHarness(c, { mode: 'retry-in-window', fault: 'sidecar', maxFaults: 4 });
  absorb('F01', res);
  const sc = JSON.parse(fs.readFileSync(c.sidecar, 'utf8'));
  const shapes = (sc.pages || []).flatMap((p) => p.shapes || []);
  const ids = shapes.map((s) => s.id);
  check('F01 · 磁盘上旧标注与新标注都在', shapes.length === 2, shapes.length);
  check('F01 · 新标注有自己的 id', ids.includes('aNEWONE001'), ids);
  check('F01 · 待迁移映射已清空', !sc.pendingIds, sc.pendingIds);
  const lb = JSON.parse(fs.readFileSync(c.libFile, 'utf8'));
  const legacyId = ids.find((x) => x !== 'aNEWONE001');
  check('F01 · 标签迁到稳定 id', !!(lb.annoMeta[legacyId] && lb.annoMeta[legacyId].tags.includes('important')),
    Object.keys(lb.annoMeta || {}));
}

// ---------- G01：读盘期间画的笔迹不能被当成已保存 ----------
if (!ONLY || ONLY === 'draw') {
  const c = makeCase('draw-during');
  const res = runHarness(c, { mode: 'draw-during-restore', fault: 'sidecar', maxFaults: 99, delayRead: true });
  absorb('G01', res);
  const sc = readJson(c.sidecar);
  const shapes = ((sc && sc.pages) || []).flatMap((p) => p.shapes || []);
  check('G01 · 解除故障后旧标注与新笔迹都落盘', shapes.length === 2, shapes.length);
  check('G01 · 新笔迹是画笔', shapes.some((s) => s.tool === 'pen'), shapes.map((s) => s.tool));
}

// ---------- G01：保存回执只能确认这一次发出去的快照 ----------
if (!ONLY || ONLY === 'receipt') {
  const c = makeCase('slow-save');
  const sc = JSON.parse(fs.readFileSync(c.sidecar, 'utf8'));
  sc.pages[0].shapes[0].id = 'aSEED00001';      // 已有稳定 ID，不触发迁移
  fs.writeFileSync(c.sidecar, JSON.stringify(sc));
  const res = runHarness(c, { mode: 'slow-save-edit', slowSave: true });
  absorb('G01-回执', res);
}

// ---------- F01：没有未保存改动时允许离开 ----------
if (!ONLY || ONLY === 'leave') {
  const c = makeCase('leave');
  const res = runHarness(c, { mode: 'leave-without-changes', fault: 'sidecar', maxFaults: 99 });
  absorb('F01-离开', res);
}

console.log('[migration-retry] ' + (fail ? 'FAIL ' : 'PASS ') + '(' + total + ')');
process.exitCode = fail ? 1 : 0;
