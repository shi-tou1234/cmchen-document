'use strict';
/*
 * PDF 用户书签回归：
 *   pdf-lib 造 3 页 PDF，真实 Electron 探针：B 键加书签 → 侧栏「我的书签」出现行；
 *   点击行跳页；再按 B 删书签；书签在标注保存（anno-save）后不被冲掉（共存验证）；
 *   同一 userData 二次启动书签还在（持久化）。
 * 运行：node scripts/test-bookmarks.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { runProbe } = require('./probe-runner');

let code = 0;
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-bm-'));
  const ud = path.join(tmp, 'ud');
  fs.mkdirSync(ud, { recursive: true });
  try {
    const pdf = path.join(tmp, 'bm.pdf');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let n = 1; n <= 3; n++) {
      const p = doc.addPage([612, 792]);
      p.drawText('Bookmark page ' + n, { x: 60, y: 700, size: 18, font });
    }
    fs.writeFileSync(pdf, await doc.save());

    const probe = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 10000)) { if (await fn()) return true; await sleep(60); } return !!(await fn()); };
  const pressB = () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true })); };
  const loaded = await waitFor(() => App.state.pdfDoc && App.state.rendered.get(1), 25000);
  push('PDF 已打开', loaded);
  if (!loaded) return { checks };
  // 侧栏：目录页（书签块挂在目录窗格顶部）
  const sb = document.getElementById('btn-sidebar');
  if (sb && document.getElementById('sidebar').hidden) sb.click();
  document.querySelector('.sb-tab[data-tab="outline"]').click();
  await sleep(300);
  const bmBlock = () => document.getElementById('bm-block');
  // 1) 空书签提示 + B 加书签
  push('空书签提示', !!(bmBlock() && bmBlock().textContent.includes('按 B')), bmBlock() && bmBlock().textContent.slice(0, 40));
  scrollToPage(2, true);
  await sleep(200);
  pressB();
  await waitFor(() => App.state.bookmarks.some((b) => b.page === 2), 5000);
  push('B 键加第 2 页书签', App.state.bookmarks.some((b) => b.page === 2), JSON.stringify(App.state.bookmarks));
  await sleep(300);
  push('侧栏出现书签行', !!(bmBlock() && bmBlock().textContent.includes('P2')), bmBlock() && bmBlock().textContent.slice(0, 60));
  push('星标变实心', !!(bmBlock() && bmBlock().querySelector('.bm-toggle').textContent.includes('★')));

  // 2) 再加第 3 页，点击行跳回第 2 页
  scrollToPage(3, true);
  await sleep(200);
  pressB();
  await waitFor(() => App.state.bookmarks.length === 2, 5000);
  scrollToPage(1, true);
  await sleep(200);
  const rows = bmBlock().querySelectorAll('.bm-row');
  rows[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await waitFor(() => App.state.currentPage === 2, 5000);
  push('点书签行跳页', App.state.currentPage === 2, 'cur=' + App.state.currentPage);

  // 3) 落盘 + 标注保存不冲掉书签：写一条标注并保存，磁盘共存性在 Node 侧核对
  App.state.annos.set(1, [{ id: 'sx1', tool: 'note', color: '#ffe082', at: { x: 10, y: 10 }, text: 'bm-coexist', tags: [] }]);
  await App.flushAnnos();
  await sleep(600);
  push('标注已保存', (App.state.annos.get(1) || []).length === 1);

  // 4) 删书签：B 再按一次（第 3 页），留下第 2 页那条给 Node 侧核对共存
  scrollToPage(3, true);
  await sleep(200);
  pressB();
  await waitFor(() => App.state.bookmarks.length === 1, 5000);
  push('B 再按删除书签', App.state.bookmarks.length === 1 && App.state.bookmarks[0].page === 2, JSON.stringify(App.state.bookmarks));
  return { checks };
})()`;
    const probeFile = path.join(tmp, 'probe.cjs');
    fs.writeFileSync(probeFile, 'module.exports=' + JSON.stringify(probe));
    const r = runProbe({
      probe: probeFile,
      env: {
        PDFREADER_DATA_DIR: tmp,
        PDFREADER_LIBRARY: path.join(tmp, 'library.json'),
        PDFREADER_NO_AUTO_INDEX: '1',
        PDFREADER_PROBE_PDF: pdf,
      },
      args: ['--user-data-dir=' + ud],
      label: 'bookmarks-first',
      timeout: 240000,
    });
    assert.equal(r.fail, 0);

    // Node 侧核对 sidecar：书签与标注共存（渲染进程无 fs，这里验）
    const annoDir = path.join(ud, 'annotations');
    const scFiles = fs.readdirSync(annoDir).filter((f) => f.endsWith('.json'));
    assert.equal(scFiles.length, 1, 'sidecar 文件存在');
    const sidecar = JSON.parse(fs.readFileSync(path.join(annoDir, scFiles[0]), 'utf8'));
    assert.ok(Array.isArray(sidecar.bookmarks) && sidecar.bookmarks.length === 1 && sidecar.bookmarks[0].page === 2, '书签在 sidecar：' + JSON.stringify(sidecar.bookmarks));
    assert.ok(JSON.stringify(sidecar.pages || []).includes('bm-coexist'), '标注与书签共存');

    // 跨启动：同一 userData 再开，书签还在
    const probe2 = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 10000)) { if (await fn()) return true; await sleep(60); } return !!(await fn()); };
  const loaded = await waitFor(() => App.state.pdfDoc && App.state.rendered.get(1), 25000);
  if (!loaded) { push('PDF 已打开', false); return { checks }; }
  await sleep(500);   // 书签随 restoreAnnos 异步载入
  const bm = await pdfBridge.bookmarksLoad(App.state.filePath);
  push('跨启动书签还在', bm && bm.ok && bm.bookmarks.length === 1 && bm.bookmarks[0].page === 2, JSON.stringify(bm || {}));

  // R01：同文档重叠操作必须都保留，并且内存与磁盘一致（真实 preload + 主进程 + sidecar）
  const pages = () => App.state.bookmarks.map((b) => b.page).join(',');
  // 这份 PDF 只有 3 页：并发加第 1、3 页（第 2 页已在）
  await Promise.all([App.bookmarkToggle(1), App.bookmarkToggle(3)]);
  await sleep(400);
  push('R01 并发加两页内存都在', pages() === '1,2,3', pages());
  const disk = await pdfBridge.bookmarksLoad(App.state.filePath);
  push('R01 并发加两页落盘都在', disk && disk.bookmarks.map((b) => b.page).join(',') === '1,2,3',
    JSON.stringify((disk && disk.bookmarks) || []));

  // R01：同页连按两次 = 删 + 加，最终与磁盘一致
  await Promise.all([App.bookmarkToggle(1), App.bookmarkToggle(1)]);
  await sleep(400);
  push('R01 同页连按两次回到原状', pages() === '1,2,3', pages());
  const disk2 = await pdfBridge.bookmarksLoad(App.state.filePath);
  push('R01 同页连按两次磁盘一致', disk2 && disk2.bookmarks.map((b) => b.page).join(',') === '1,2,3',
    JSON.stringify((disk2 && disk2.bookmarks) || []));
  return { checks };
})()`;
    const probeFile2 = path.join(tmp, 'probe2.cjs');
    fs.writeFileSync(probeFile2, 'module.exports=' + JSON.stringify(probe2));
    const r2 = runProbe({
      probe: probeFile2,
      env: {
        PDFREADER_DATA_DIR: tmp,
        PDFREADER_LIBRARY: path.join(tmp, 'library.json'),
        PDFREADER_NO_AUTO_INDEX: '1',
        PDFREADER_PROBE_PDF: pdf,
      },
      args: ['--user-data-dir=' + ud],
      label: 'bookmarks-second',
      timeout: 240000,
    });
    assert.equal(r2.fail, 0);
    code = 0;
  } catch (e) {
    console.error('[bookmarks] ERROR', e && e.message ? e.message : e);
    code = 3;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(code);
})();
