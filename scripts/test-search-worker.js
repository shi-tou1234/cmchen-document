'use strict';
/*
 * 全文索引服务回归（2026-10-29）
 *
 * 验证四件事：
 *   1. 检索与索引真的跑在 worker 线程里（不是悄悄退化成进程内）；
 *   2. 迁移前后的行为一致：同一份索引，worker 模式与 PDFREADER_SEARCH_INLINE=1（旧行为）
 *      的两条路给出相同的命中页码；
 *   3. 增量索引：导入 PDF 后不点「重建索引」也能搜到，而且主进程会广播 ft-index-changed；
 *   4. 建索引期间主进程仍然及时回 IPC（这正是把检索搬出主进程的目的）。
 * 运行：node scripts/test-search-worker.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { runProbe } = require('./probe-runner');

const ROOT = path.join(__dirname, '..');

async function makePdf(file, pages, title, lines) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) {
    const page = doc.addPage([595, 842]);
    page.drawText(title + ' page ' + i, { x: 60, y: 780, size: 15, font });
    // 只在第 2 页写正文：命中页码固定，两条实现可以直接比对
    if (i === 2) (lines || []).forEach((ln, idx) => {
      page.drawText(ln, { x: 60, y: 740 - idx * 20, size: 11, font });
    });
  }
  fs.writeFileSync(file, await doc.save());
  return file;
}

// 直接往索引目录里灌一堆索引文件：不生成 PDF，几秒钟就能造出「大库检索」的负载，
// 用来验证「查询期间主进程还回不回 IPC」。
function seedIndex(dataDir, count) {
  const crypto = require('crypto');
  const dir = path.join(dataDir, 'fulltext');
  fs.mkdirSync(dir, { recursive: true });
  const filler = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor ';
  for (let i = 0; i < count; i++) {
    const pages = [];
    for (let pg = 1; pg <= 25; pg++) {
      pages.push({ page: pg, text: 'needle document ' + i + ' page ' + pg + ' ' + filler.repeat(9) });
    }
    const fakePath = 'D:////fake////doc-' + i + '.pdf';
    const h = crypto.createHash('sha1').update(path.resolve(fakePath)).digest('hex').slice(0, 24);
    fs.writeFileSync(path.join(dir, h + '.json'), JSON.stringify({
      version: 1, path: path.resolve(fakePath), size: 1000 + i, mtimeMs: 1,
      indexedAt: Date.now(), numPages: 25, pages, chars: pages.reduce((a, b) => a + b.text.length, 0),
    }));
  }
  return count;
}

function library(pdfA, pdfB) {
  return {
    version: 8,
    items: [
      {
        key: 'k1', itemType: 'journalArticle', title: 'Alpha 文献', year: '2024',
        creators: [{ firstName: 'Jane', lastName: 'Smith', creatorType: 'author' }],
        attachment: { path: pdfA, name: path.basename(pdfA) },
      },
      {
        key: 'k2', itemType: 'journalArticle', title: 'Beta 文献', year: '2023',
        creators: [{ firstName: 'Wei', lastName: 'Zhang', creatorType: 'author' }],
        attachment: { path: pdfB, name: path.basename(pdfB) },
      },
    ],
  };
}

// 探针对比用：worker 模式下 zebra 命中的页码，inline 模式必须完全一致
const PROBE_COMMON = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 10000)) { if (await fn()) return true; await sleep(70); } return !!(await fn()); };
`;

function probeBody(mode) {
  return PROBE_COMMON + `
  const st = await pdfBridge.lib.ftStatus();
  push('索引状态可用', !!st && typeof st.indexed === 'number', JSON.stringify({ worker: st.worker, indexed: st.indexed, total: st.totalItems, pending: st.pending }));
  push('索引跑在预期的执行位置（${mode}）', st.worker === ${JSON.stringify(mode)}, st.worker);

  const idx = await pdfBridge.lib.indexAll(true);
  push('重建索引完成', !!idx && idx.ok && idx.done >= 2, JSON.stringify({ total: idx.total, done: idx.done, failed: idx.failed }).slice(0, 140));

  const r1 = await pdfBridge.lib.searchFull('zebra', { limit: 40 });
  const hits = (r1 && r1.results) || [];
  const ft = hits.filter((x) => x.type === 'fulltext');
  push('搜到全文命中', ft.length >= 1, JSON.stringify(ft.slice(0, 2).map((x) => (x.key || '') + ':' + x.page)));
  push('命中页码可复现（两条实现一致的前提）', ft.length === 2 && ft.every((x) => x.page === 2), JSON.stringify(ft.map((x) => ({ key: x.key, page: x.page }))));
  return { checks, pages: ft.map((x) => x.key + ':' + x.page).sort() };
})()`;
}

let code = 0;
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-ftworker-'));
  try {
    const pdfA = await makePdf(path.join(tmp, 'alpha.pdf'), 4, 'ALPHA', ['The quick zebra jumps over the lazy dog.']);
    const pdfB = await makePdf(path.join(tmp, 'beta.pdf'), 3, 'BETA', ['Nothing to see here except the zebra crossing.']);
    const inbox = path.join(tmp, 'inbox');
    fs.mkdirSync(inbox);
    const libFile = path.join(tmp, 'library.json');
    fs.writeFileSync(libFile, JSON.stringify(library(pdfA, pdfB)));

    // ---- 第一趟：worker 模式 ----
    const runOne = (mode, extraEnv) => {
      const dataDir = path.join(tmp, 'data-' + mode);
      fs.mkdirSync(dataDir);
      const ud = path.join(tmp, 'ud-' + mode);
      fs.mkdirSync(ud);
      const probeFile = path.join(tmp, 'probe-' + mode + '.cjs');
      fs.writeFileSync(probeFile, 'module.exports=' + JSON.stringify(probeBody(mode)));
      return runProbe({
        probe: probeFile,
        env: Object.assign({
          PDFREADER_LIBRARY: libFile,
          PDFREADER_DATA_DIR: dataDir,
          PDFREADER_NO_AUTO_INDEX: '1',
        }, extraEnv || {}),
        args: ['--user-data-dir=' + ud],
        label: 'ft-' + mode,
        timeout: 300000,
      });
    };

    const r1 = runOne('worker');
    assert.equal(r1.fail, 0);
    const pagesWorker = (r1.res && r1.res.pages) || [];

    const r2 = runOne('inline', { PDFREADER_SEARCH_INLINE: '1' });
    assert.equal(r2.fail, 0);
    const pagesInline = (r2.res && r2.res.pages) || [];
    assert.deepEqual(pagesInline, pagesWorker);
    console.log('  ok   worker 与进程内两条路的命中完全一致（' + pagesWorker.join(', ') + '）');

    // ---- 第二趟：增量索引 + 响应性（worker 模式）----
    const dataDir = path.join(tmp, 'data-inc');
    fs.mkdirSync(dataDir);
    const ud = path.join(tmp, 'ud-inc');
    fs.mkdirSync(ud);
    const freshPdf = await makePdf(path.join(inbox, 'fresh.pdf'), 2, 'FRESH', ['A kiwifruit appears only here.']);
    const bigPdf = await makePdf(path.join(tmp, 'big.pdf'), 160, 'BIG', ['Padding text for indexing cost measurement.']);
    // 把大文件挂进库，重建索引时一起算，用来观察「建索引期间主进程还活不活」
    const lib2 = library(pdfA, pdfB);
    lib2.items.push({
      key: 'k3', itemType: 'journalArticle', title: 'Big 文献', year: '2022',
      creators: [{ firstName: 'Bo', lastName: 'Li', creatorType: 'author' }],
      attachment: { path: bigPdf, name: 'big.pdf' },
    });
    fs.writeFileSync(libFile, JSON.stringify(lib2));

    const probe2 = PROBE_COMMON + `
    const st = await pdfBridge.lib.ftStatus();
    push('初始索引为空', st.indexedItems === 0, JSON.stringify({ indexed: st.indexedItems, total: st.totalItems }));

    // 1) 导入一个 PDF：不点「重建索引」，只等广播
    const events = [];
    if (pdfBridge.lib.onFtIndexChanged) pdfBridge.lib.onFtIndexChanged((info) => events.push(info));
    const added = await pdfBridge.lib.addPdf(${JSON.stringify(freshPdf)}, { dedupe: true, skipIdentify: true });
    push('导入成功', !!added && added.ok, JSON.stringify({ ok: added && added.ok, err: added && added.error }).slice(0, 140));
    const broadcast = await waitFor(() => events.some((e) => String(e.path || '').includes('fresh.pdf')), 25000);
    push('导入后主进程广播了索引变更', broadcast, JSON.stringify(events.slice(0, 3)));

    const found = await waitFor(async () => {
      const r = await pdfBridge.lib.searchFull('kiwifruit', { limit: 20 });
      return ((r && r.results) || []).some((x) => x.type === 'fulltext');
    }, 25000);
    push('新导入的文档不用手动重建就能搜到', found);
    const rk = await pdfBridge.lib.searchFull('kiwifruit', { limit: 20 });
    const hit = ((rk && rk.results) || []).find((x) => x.type === 'fulltext');
    push('命中落在新条目上', !!hit && hit.key !== 'k1' && hit.key !== 'k2' && hit.key !== 'k3', hit && (hit.key + '@' + hit.page));

    // 2) 建索引期间主进程要能及时回 IPC
    const job = pdfBridge.lib.indexAll(true);
    const lat = [];
    for (let i = 0; i < 14; i++) {
      const t0 = Date.now();
      await pdfBridge.lib.summary();
      lat.push(Date.now() - t0);
      await sleep(55);
    }
    const done = await job;
    const maxLat = Math.max.apply(null, lat);
    const avgLat = Math.round(lat.reduce((a, b) => a + b, 0) / lat.length);
    push('重建索引期间主进程仍及时回 IPC（最大 ' + maxLat + 'ms / 平均 ' + avgLat + 'ms）', maxLat < 1200, JSON.stringify({ maxLat, avgLat, calls: lat.length }));
    push('重建索引确实跑完了', !!done && done.ok && done.done >= 3, JSON.stringify({ total: done.total, done: done.done, failed: done.failed }).slice(0, 140));

    // 3) 清空索引后搜索不再命中，状态归零
    const cleared = await pdfBridge.lib.ftClear();
    push('清空索引', !!cleared && cleared.ok, cleared && cleared.removed);
    const rEmpty = await pdfBridge.lib.searchFull('kiwifruit', { limit: 20 });
    push('清空后全文不再命中', !((rEmpty && rEmpty.results) || []).some((x) => x.type === 'fulltext'));
    const stEmpty = await pdfBridge.lib.ftStatus();
    push('清空后状态归零', stEmpty.indexed === 0, JSON.stringify({ indexed: stEmpty.indexed, pending: stEmpty.pending }));

    return { checks };
    })()`;

    const probeFile2 = path.join(tmp, 'probe-inc.cjs');
    fs.writeFileSync(probeFile2, 'module.exports=' + JSON.stringify(probe2));
    const r3 = runProbe({
      probe: probeFile2,
      env: { PDFREADER_LIBRARY: libFile, PDFREADER_DATA_DIR: dataDir, PDFREADER_NO_AUTO_INDEX: '1' },
      args: ['--user-data-dir=' + ud],
      label: 'ft-incremental',
      timeout: 300000,
    });
    assert.equal(r3.fail, 0);

    // ---- 第三趟：大索引下的查询响应性（worker / inline 各测一次，做对照）----
    const seeded = 400;
    const latOf = (mode, extraEnv) => {
      const dataDir = path.join(tmp, 'data-big-' + mode);
      fs.mkdirSync(dataDir);
      seedIndex(dataDir, seeded);
      const ud = path.join(tmp, 'ud-big-' + mode);
      fs.mkdirSync(ud);
      const probe = PROBE_COMMON + `
      const st = await pdfBridge.lib.ftStatus();
      push('大索引已就位', st.indexed >= ${seeded - 5}, JSON.stringify({ indexed: st.indexed, worker: st.worker }));

      // 先热一遍（第一次要读盘解析 JSON），测的是「稳定状态下的查询成本」
      const warm = Date.now();
      await pdfBridge.lib.searchFull('needle', { limit: 20 });
      const warmMs = Date.now() - warm;

      // 关键：查询在跑的同时，主进程必须还能及时回别的 IPC
      const searching = pdfBridge.lib.searchFull('needle', { limit: 20 });
      const lat = [];
      for (let i = 0; i < 8; i++) {
        const t0 = Date.now();
        await pdfBridge.lib.summary();
        lat.push(Date.now() - t0);
        await sleep(30);
      }
      const r = await searching;
      const maxLat = Math.max.apply(null, lat);
      const avgLat = Math.round(lat.reduce((a, b) => a + b, 0) / lat.length);
      push('查询本身返回正常', !!r && r.ok !== false, JSON.stringify({ total: r && r.total }).slice(0, 120));
      // 只有 worker 模式是门槛；进程内模式是「改造前」的对照，只记录数字不判失败
      push('查询期间主进程仍及时回 IPC（最大 ' + maxLat + 'ms / 平均 ' + avgLat + 'ms）',
        ${JSON.stringify(mode)} === 'inline' ? true : maxLat < 400,
        JSON.stringify({ maxLat, avgLat, warmMs, mode: ${JSON.stringify(mode)} }));
      return { checks, maxLat, avgLat, warmMs };
      })()`;
      const pf = path.join(tmp, 'probe-big-' + mode + '.cjs');
      fs.writeFileSync(pf, 'module.exports=' + JSON.stringify(probe));
      return runProbe({
        probe: pf,
        env: Object.assign({
          PDFREADER_LIBRARY: libFile,
          PDFREADER_DATA_DIR: dataDir,
          PDFREADER_NO_AUTO_INDEX: '1',
        }, extraEnv || {}),
        args: ['--user-data-dir=' + ud],
        label: 'ft-big-' + mode,
        timeout: 300000,
      });
    };
    const rb1 = latOf('worker');
    assert.equal(rb1.fail, 0);
    const rb2 = latOf('inline', { PDFREADER_SEARCH_INLINE: '1' });
    // inline 只用来做对照，不作为门槛：它本来就会卡，这里只要不是崩掉
    const w = (rb1.res && rb1.res.maxLat) || 0;
    const i2 = (rb2.res && rb2.res.maxLat) || 0;
    console.log('  info 400 份索引下，查询期间 IPC 最大往返：worker ' + w + 'ms / 进程内 ' + i2 + 'ms');
    code = 0;
  } catch (e) {
    console.error('[ft-worker] ERROR', e && e.message ? e.message : e);
    code = 3;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(code);
})();
