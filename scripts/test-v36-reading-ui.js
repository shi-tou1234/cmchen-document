'use strict';
/*
 * v36 阅读侧三个功能的界面级回归（真实 Electron）：
 *   1. 跨文档 Portal：点正文里的 [Smith, 2020] → 对开栏自动打开库里那一篇（第 1 页）
 *   2. 重排阅读：覆盖层出块、页数说明、字号跟着滑杆走、能关掉
 *   3. 阅读标尺 + 命令面板：标尺跟着鼠标走且不吃点击（pointer-events:none）；
 *      命令面板能搜到「重排阅读」并执行
 * 相似文献（详情面板里的「按内容找相似」）也在这条链上，一并验：
 *   两篇共享词汇的 PDF，点一下要列出对方，并且带「为什么像」的词。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { runProbe } = require('./probe-runner');

async function makeCites(file) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const mk = (lines) => {
    const p = doc.addPage([612, 792]);
    let y = 700;
    for (const t of lines) { p.drawText(t, { x: 60, y, size: 12, font }); y -= 30; }
  };
  // 第一页给一个真标题（大字号）：重排阅读的标题识别靠字号对比，正文全是 12pt 就分不出标题
  const p1 = doc.addPage([612, 792]);
  p1.drawText('Document analysis with neural models', { x: 60, y: 700, size: 24, font });
  const bodyY = [660, 630, 600];
  const bodyLines = [
    'Prior work [12] shows the effect. See also [Smith, 2020].',
    'Another study (Jones, 2018) agrees with the analysis of documents.',
    'The document analysis pipeline uses neural models for effects.',
  ];
  bodyLines.forEach((t, i) => p1.drawText(t, { x: 60, y: bodyY[i], size: 12, font }));
  mk(['More discussion of [12] appears here about document analysis.']);
  mk([
    'References',
    '11. Someone, A. 2017. Early work on documents.',
    '12. Writer, B. 2019. The effect study.',
    'Smith, J. 2020. Big paper on effects.',
    'Jones, K. 2018. Prior study of it.',
  ]);
  fs.writeFileSync(file, await doc.save());
  return file;
}

async function makeBig(file) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 2; i++) {
    const p = doc.addPage([612, 792]);
    p.drawText('Big paper on effects', { x: 60, y: 700, size: 16, font });
    p.drawText('Neural models for document analysis and effects of the study.', { x: 60, y: 660, size: 12, font });
    p.drawText('Page ' + i + ' of the document analysis study.', { x: 60, y: 630, size: 12, font });
  }
  fs.writeFileSync(file, await doc.save());
  return file;
}

let code = 0;
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-v36read-'));
  const ud = path.join(tmp, 'ud');
  fs.mkdirSync(ud);
  try {
    const cites = await makeCites(path.join(tmp, 'cites.pdf'));
    const big = await makeBig(path.join(tmp, 'big.pdf'));
    fs.writeFileSync(path.join(tmp, 'library.json'), JSON.stringify({
      version: 8,
      items: [
        { key: 'k1', itemType: 'journalArticle', title: 'Citing paper', year: '2024', attachment: { path: cites, name: 'cites.pdf' } },
        { key: 'k2', itemType: 'journalArticle', title: 'Big paper on effects', year: '2020', doi: '',
          creators: [{ firstName: 'John', lastName: 'Smith', creatorType: 'author' }], attachment: { path: big, name: 'big.pdf' } },
        { key: 'k3', itemType: 'book', title: 'Cooking with cast iron', year: '2018' },
      ],
    }));

    const probe = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 10000)) { if (await fn()) return true; await sleep(80); } return !!(await fn()); };

  const ready = await waitFor(() => window.LibraryUI && LibraryUI.isOpen(), 12000);
  push('文献库就绪', ready);
  if (!ready) return { checks };
  const res = await pdfBridge.lib.openItem('k1', 1);
  LibraryUI.hide();
  window.__libOpen(res);
  const loaded = await waitFor(() => App.state.pdfDoc && App.state.numPages === 3, 25000);
  push('PDF 加载（3 页）', loaded, App.state.numPages);
  if (!loaded) return { checks };
  await waitFor(() => document.querySelector('#page-1 .textlayer span'), 8000);
  await sleep(400);

  // ---------- 1. Portal ----------
  const clickText = (pageN, needle) => {
    const spans = document.querySelectorAll('#page-' + pageN + ' .textlayer span');
    for (const sp of spans) {
      const t = sp.textContent || '';
      const idx = t.indexOf(needle);
      if (idx < 0) continue;
      const r = sp.getBoundingClientRect();
      return { x: r.left + r.width * ((idx + needle.length / 2) / t.length), y: r.top + r.height / 2 };
    }
    return null;
  };
  let pt = null;
  for (let i = 0; i < 20 && !pt; i++) { pt = clickText(1, '[Smith, 2020]'); if (!pt) await sleep(150); }
  push('找到正文里的引用标记', !!pt);
  if (pt) {
    const r = await App._smartJumpAt(pt.x, pt.y, document.getElementById('page-1'));
    push('引用标记识别为作者-年份', r && r.kind === 'authoryear' && r.found === true, JSON.stringify(r));
  }
  const followed = await waitFor(() => App.state.split && String(App.state.refPath || '').indexOf('big.pdf') >= 0, 20000);
  push('引用跟随打开了库里那一篇', followed, JSON.stringify({ split: !!App.state.split, ref: App.state.refPath }));
  push('对开栏停在目标文献的第 1 页', App.splitState && App.splitState().page === 1, App.splitState && App.splitState().page);
  push('状态行说明是引用跟随', /引用跟随/.test(($('#status-text') || {}).textContent || ''), ($('#status-text') || {}).textContent);
  push('目标文献标题进了对开栏标题', /Big paper/.test(($('#ref-name') || {}).textContent || ''), ($('#ref-name') || {}).textContent);
  App.setSplitView(false);
  await sleep(200);

  // ---------- 2. 相似文献 ----------
  // 相似度读的是全量索引；测试环境默认关掉自动索引入口，这里手动建一次
  const idx = await pdfBridge.lib.indexAll(false);
  push('全量索引建好', !!(idx && idx.ok !== false), JSON.stringify(idx && { done: idx.done, skipped: idx.skipped, failed: idx.failed }).slice(0, 120));
  LibraryUI.show();
  const detail = await waitFor(() => { LibraryUI.openDetail('k1'); return !!$('#ld-similar-btn'); }, 8000);
  push('详情面板有「按内容找相似」', detail);
  if (detail) {
    $('#ld-similar-btn').click();
    const listed = await waitFor(() => document.querySelectorAll('#ld-similar .ld-similar-row').length >= 1, 40000);
    if (!listed) push('相似列表出结果', false, '状态：' + (($('#ld-similar-status') || {}).textContent || '') + ' / 面板：' + (($('#ld-similar') || {}).textContent || '').slice(0, 120));
    push('相似列表出结果', listed, document.querySelectorAll('#ld-similar .ld-similar-row').length);
    const row = document.querySelector('#ld-similar .ld-similar-row');
    push('最像的是那一篇', row && /Big paper/.test(row.textContent), row && row.textContent.slice(0, 60));
    push('给出相似度百分比', row && /%/.test(row.textContent), row && row.textContent.slice(0, 60));
    push('注明为什么像（共享词）', row && !!row.querySelector('.ld-similar-why'), row && (row.querySelector('.ld-similar-why') || {}).textContent);
    push('不列自己', !/Citing paper/.test($('#ld-similar').textContent));
  }
  LibraryUI.hide();
  await sleep(200);

  // ---------- 3. 重排阅读 ----------
  openReflow();
  const shown = await waitFor(() => !$('#reflow-view').hidden, 8000);
  push('重排覆盖层打开', shown);
  const hasBlocks = await waitFor(() => document.querySelectorAll('#reflow-pages p, #reflow-pages h2, #reflow-pages li').length > 0, 30000);
  if (!hasBlocks) push('重排没出块的说明', false, 'note=' + (($('#reflow-note') || {}).textContent || '') + ' / empty=' + (($('#reflow-empty') || {}).textContent || '') + ' / hidden=' + (($('#reflow-empty') || {}).hidden));
  push('重排出块', hasBlocks, document.querySelectorAll('#reflow-pages p, #reflow-pages h2, #reflow-pages li').length);
  const text = ($('#reflow-pages') || {}).textContent || '';
  push('重排出的是正文内容', /document analysis/i.test(text), text.slice(0, 80));
  push('标题块认出来了', !!document.querySelector('#reflow-pages h2'), document.querySelectorAll('#reflow-pages h2').length);
  push('参考文献段落收进来了', /References/.test(text), text.slice(-80));
  const sizeBefore = ($('#reflow-body') || {}).style.getPropertyValue('--rf-size');
  const slider = $('#reflow-size');
  if (slider) {
    slider.value = '22';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  }
  await sleep(120);
  const sizeAfter = ($('#reflow-body') || {}).style.getPropertyValue('--rf-size');
  push('字号跟着滑杆变', sizeBefore === '17px' && sizeAfter === '22px', sizeBefore + ' → ' + sizeAfter);
  const widthBefore = ($('#reflow-body') || {}).style.getPropertyValue('--rf-width');
  const wslider = $('#reflow-width');
  if (wslider) { wslider.value = '520'; wslider.dispatchEvent(new Event('input', { bubbles: true })); }
  await sleep(120);
  push('栏宽跟着滑杆变', widthBefore !== ($('#reflow-body') || {}).style.getPropertyValue('--rf-width'),
    widthBefore + ' → ' + ($('#reflow-body') || {}).style.getPropertyValue('--rf-width'));
  $('#reflow-close').click();
  push('能关掉重排', await waitFor(() => $('#reflow-view').hidden, 4000));

  // ---------- 4. 阅读标尺 ----------
  setRuler(true);
  await sleep(60);
  push('标尺出现', !$('#read-ruler').hidden);
  const before = $('#read-ruler').style.transform;
  const viewer = $('#viewer').getBoundingClientRect();
  const viewerEl = $('#viewer');
  viewerEl.dispatchEvent(new MouseEvent('mousemove', { clientX: viewer.left + 200, clientY: viewer.top + 300, bubbles: true }));
  await sleep(80);
  const after = $('#read-ruler').style.transform;
  push('标尺跟着鼠标移动', before !== after, before + ' → ' + after);
  push('标尺不吃鼠标事件', getComputedStyle($('#read-ruler')).pointerEvents === 'none', getComputedStyle($('#read-ruler')).pointerEvents);
  setRuler(false);
  await sleep(60);
  push('能关掉标尺', $('#read-ruler').hidden);

  // ---------- 5. 命令面板 ----------
  openCmd();
  const cmdOpen = await waitFor(() => !$('#cmd-modal').hidden, 4000);
  push('命令面板打开', cmdOpen);
  const inp = $('#cmd-input');
  inp.value = '重排';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(120);
  const labels = Array.from(document.querySelectorAll('#cmd-list .cmd-row .cmd-label')).map((x) => x.textContent);
  push('搜得到重排阅读', labels.some((l) => /重排阅读/.test(l)), labels.join('|'));
  inp.value = '标尺';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(120);
  const labels2 = Array.from(document.querySelectorAll('#cmd-list .cmd-row .cmd-label')).map((x) => x.textContent);
  push('搜得到阅读标尺', labels2.some((l) => /标尺/.test(l)), labels2.join('|'));
  const firstRow = document.querySelector('#cmd-list .cmd-row');
  if (firstRow) firstRow.click();
  await sleep(150);
  push('点命令后执行并关闭面板', $('#cmd-modal').hidden && !$('#read-ruler').hidden, JSON.stringify({ cmd: $('#cmd-modal').hidden, ruler: $('#read-ruler').hidden }));
  return { checks };
})()`;

    const probeFile = path.join(tmp, 'probe.cjs');
    fs.writeFileSync(probeFile, 'module.exports=' + JSON.stringify(probe));
    const r = runProbe({
      probe: probeFile,
      env: { PDFREADER_LIBRARY: path.join(tmp, 'library.json'), PDFREADER_DATA_DIR: tmp, PDFREADER_NO_AUTO_INDEX: '1' },
      args: ['--user-data-dir=' + ud],
      label: 'v36-reading',
      timeout: 300000,
    });
    assert.equal(r.fail, 0);
    code = 0;
  } catch (e) {
    console.error('[v36-reading] ERROR', e && e.message ? e.message : e);
    code = 3;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(code);
})();
