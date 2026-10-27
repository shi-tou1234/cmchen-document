'use strict';
/*
 * 智能跳转（Smart Jump）回归：
 *   Node 侧：smartjump.js 纯逻辑——数字/作者-年份标记识别、区间展开、参考文献标题与
 *            条目匹配、反查标记、行构造（同 y 合并、按 x 排序）。
 *   Electron 侧：真实 PDF（第 1、2 页正文带引用标记，第 3 页 References）驱动
 *            App._smartJumpAt：[12] → 第 3 页第 12 条；[Smith, 2020] → Smith 条目；
 *            (Jones, 2018) → Jones 条目；点参考文献条目反查正文标记（两处 [12]）；
 *            普通文本不触发。落点高亮画在 .sj-layer。
 * 运行：node scripts/test-smart-jump.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SJ = require('../src/smartjump.js');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { runProbe } = require('./probe-runner');

// ---------- A. Node 纯逻辑 ----------
(function nodePart() {
  // 数字型
  let c = SJ.extractCitation('prior work [12] shows', 12);
  assert.ok(c && c.kind === 'numeric' && c.numbers.length === 1 && c.numbers[0] === 12, '数字型识别: ' + JSON.stringify(c));
  c = SJ.extractCitation('see [3, 5] here', 6);
  assert.ok(c && c.numbers.join() === '3,5', '多号识别: ' + JSON.stringify(c));
  c = SJ.extractCitation('range [12-15] case', 8);
  assert.ok(c && c.numbers.join() === '12,13,14,15', '区间展开: ' + JSON.stringify(c));
  c = SJ.extractCitation('wide [1-999] capped', 8);
  assert.ok(c && c.numbers.length === 0, '区间过宽不展开: ' + JSON.stringify(c));
  c = SJ.extractCitation('plain text here', 4);
  assert.equal(c, null, '无标记返回 null');
  c = SJ.extractCitation('before [12] after', 2);
  assert.equal(c, null, '点在标记外不算');

  // 作者-年份
  c = SJ.extractCitation('shown [Smith, 2020] earlier', 9);
  assert.ok(c && c.kind === 'authoryear' && c.surname === 'Smith' && c.year === '2020', '方括号作者年份: ' + JSON.stringify(c));
  c = SJ.extractCitation('work [Smith et al., 2020] done', 8);
  assert.ok(c && c.surname === 'Smith' && c.year === '2020', 'et al. 形式: ' + JSON.stringify(c));
  c = SJ.extractCitation('agree (Jones, 2018) too', 10);
  assert.ok(c && c.surname === 'Jones' && c.year === '2018', '圆括号作者年份: ' + JSON.stringify(c));
  c = SJ.extractCitation('date (2020-01-01) is not a cite', 8);
  assert.equal(c, null, '日期不误判: ' + JSON.stringify(c));
  c = SJ.extractCitation('fig (see Figure 3) here', 8);
  assert.equal(c, null, '无年份的括号不误判');

  // 参考文献识别
  assert.ok(SJ.isBibHeading('References'), 'References');
  assert.ok(SJ.isBibHeading('  参考文献  '), '中文标题');
  assert.ok(SJ.isBibHeading('Bibliography'), 'Bibliography');
  assert.ok(!SJ.isBibHeading('References1'), '带后缀不算标题');
  assert.ok(!SJ.isBibHeading('12. Writer'), '条目不是标题');

  // 条目匹配
  assert.ok(SJ.matchNumericLine('12. Writer, B. 2019.', 12), '数字条目 12.');
  assert.ok(SJ.matchNumericLine('[12] Writer, B. 2019.', 12), '方括号条目');
  assert.ok(!SJ.matchNumericLine('123. Writer', 12), '123 不是 12');
  assert.ok(!SJ.matchNumericLine('121. Writer', 12), '121 不是 12');
  assert.ok(SJ.matchAuthorYearLine('Smith, J. (2020). Big paper.', 'Smith', '2020'), '作者年份条目');
  assert.ok(!SJ.matchAuthorYearLine('Smithson, A. (2020).', 'Smith', '2020'), 'Smithson 不是 Smith');

  // 全文查找
  const lines = [
    { text: 'Intro text' }, { text: 'Intro 2' }, { text: 'References' },
    { text: '11. Someone. 2017.' }, { text: '12. Writer. 2019.' }, { text: 'Smith, J. 2020. Big' },
  ];
  const bib = SJ.findBibStartIndex(lines, 0);
  assert.equal(bib, 2, '标题行下标');
  assert.equal(SJ.findEntryLine(lines, bib, { numbers: [12] }), 4, '数字条目定位');
  assert.equal(SJ.findEntryLine(lines, bib, { surname: 'Smith', year: '2020' }), 5, '作者条目定位');
  assert.equal(SJ.findEntryLine(lines, bib, { numbers: [99] }), -1, '找不到返回 -1');

  // 反查
  const pageText = 'Prior work [12] shows. More [12] here. Also [5] and [Smith, 2020].';
  const p1 = SJ.findMarkerPositions(pageText, { numbers: [12] });
  assert.equal(p1.length, 2, '数字反查两处: ' + JSON.stringify(p1));
  const p2 = SJ.findMarkerPositions(pageText, { surname: 'Smith', year: '2020' });
  assert.equal(p2.length, 1, '作者反查一处');
  const p3 = SJ.findMarkerPositions(pageText, { numbers: [7] });
  assert.equal(p3.length, 0, '无关标记不匹配');

  // 行构造：同 y 合并、按 x 排序、不同 y 分行（视口坐标 y 向下，680 在 700 上方）
  const rows = SJ.buildLines([
    { str: 'world', x: 50, y: 700, w: 30, fh: 10 },
    { str: 'Hello ', x: 10, y: 700, w: 40, fh: 10 },
    { str: 'next', x: 10, y: 680, w: 24, fh: 10 },
  ]);
  assert.equal(rows.length, 2, '两行');
  assert.equal(rows[0].text, 'next', '上面的行在前: ' + rows[0].text);
  assert.equal(rows[1].text, 'Hello world', '行内按 x 排序: ' + rows[1].text);
  assert.deepEqual(rows[1].idx, [1, 0], 'idx 指向输入下标');

  console.log('[smart-jump-node] PASS');
})();

// ---------- B. Electron 真实 PDF ----------
let code = 0;
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-sj-'));
  const ud = path.join(tmp, 'ud');
  fs.mkdirSync(ud);
  try {
    const pdf = path.join(tmp, 'cites.pdf');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const mkPage = (lines) => {
      const p = doc.addPage([612, 792]);
      let y = 700;
      for (const t of lines) { p.drawText(t, { x: 60, y, size: 12, font }); y -= 28; }
      return p;
    };
    mkPage([
      'Chapter 1 Introduction',
      'Prior work [12] shows the effect. See also [Smith, 2020].',
      'Another study (Jones, 2018) agrees with this.',
    ]);
    mkPage(['More discussion of [12] appears here.']);
    mkPage([
      'References',
      '11. Someone, A. 2017. Early work.',
      '12. Writer, B. 2019. The effect study.',
      'Smith, J. 2020. Big paper on effects.',
      'Jones, K. 2018. Prior study of it.',
    ]);
    fs.writeFileSync(pdf, await doc.save());

    const probe = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 10000)) { if (fn()) return true; await sleep(60); } return !!fn(); };
  const libReady = await waitFor(() => window.LibraryUI && LibraryUI.isOpen(), 10000);
  push('文献库就绪', libReady);
  push('SmartJump 挂载', !!(window.SmartJump && SmartJump.extractCitation));
  const loaded = await waitFor(() => App.state.pdfDoc && App.state.rendered.get(1), 25000);
  push('PDF 已打开', loaded);
  if (!loaded) return { checks };
  await waitFor(() => document.querySelector('#page-1 .textlayer span'), 8000);
  await sleep(500);

  // 点击辅助：把「行 span 里第 idx..idx+len 字符」按比例换算成页面上的点。
  // 文本项是整行一个 span，点 span 中心会落在行中间，必须按字符比例定位。
  const clickText = (pageN, needle) => {
    const spans = document.querySelectorAll('#page-' + pageN + ' .textlayer span');
    for (const sp of spans) {
      const t = sp.textContent || '';
      const idx = t.indexOf(needle);
      if (idx < 0) continue;
      const r = sp.getBoundingClientRect();
      const cx = r.left + r.width * ((idx + needle.length / 2) / t.length);
      const cy = r.top + r.height / 2;
      return { x: cx, y: cy };
    }
    return null;
  };
  const run = async (pageN, needle) => {
    const pageEl = document.getElementById('page-' + pageN);
    if (!pageEl) return { error: 'no page ' + pageN };
    let pt = null;
    for (let i = 0; i < 20 && !pt; i++) { pt = clickText(pageN, needle); if (!pt) await sleep(150); }
    if (!pt) return { error: 'span not found: ' + needle };
    // 直接把目标页传给 _smartJumpAt：隐藏窗口里滚动动画会让屏幕坐标对不上元素
    return await App._smartJumpAt(pt.x, pt.y, pageEl);
  };

  // 0) B09：新文档里第一次就点参考文献条目（不先点正文引用）。
  //    旧实现把「点击页的行」追加到跨页缓存开头，整篇行序被打乱，
  //    参考文献标题反而排在点击行之后，inBib 判定失败 → 反查不到。
  scrollToPage(3, true);
  await waitFor(() => document.querySelector('#page-3 .textlayer span'), 8000);
  await sleep(400);
  const r0 = await run(3, '12. Writer');
  push('B09 首次直接点条目可反查', r0 && r0.kind === 'entry' && r0.found === true, JSON.stringify(r0));
  push('B09 首次反查命中 2 处标记', r0 && r0.markers === 2 && r0.toPage === 1, JSON.stringify(r0));
  scrollToPage(1, true);
  await sleep(300);

  // 1) [12] → 第 3 页第 12 条
  let r = await run(1, '[12]');
  push('[12] 识别为数字型', r && r.kind === 'numeric', JSON.stringify(r));
  push('[12] 找到条目', r && r.found === true, JSON.stringify(r));
  push('[12] 跳到第 3 页', r && r.toPage === 3, JSON.stringify(r));
  await sleep(300);
  push('落点高亮画在第 3 页', !!document.querySelector('#page-3 .sj-layer .sj-hl'));

  // 2) 作者-年份（方括号）
  r = await run(1, '[Smith, 2020]');
  push('[Smith, 2020] 找到条目', r && r.found && r.kind === 'authoryear' && r.toPage === 3, JSON.stringify(r));
  push('条目行是 Smith', r && /Smith/.test(r.entryText || ''), r && r.entryText);

  // 3) 作者-年份（圆括号）
  r = await run(1, '(Jones, 2018)');
  push('(Jones, 2018) 找到条目', r && r.found && r.toPage === 3, JSON.stringify(r));

  // 4) 反向：点第 3 页 "12. Writer" 条目 → 正文两处 [12]
  r = await run(3, '12. Writer');
  push('条目识别为反查', r && r.kind === 'entry', JSON.stringify(r));
  push('反查到 2 处标记', r && r.markers === 2, JSON.stringify(r));
  push('跳回正文页', r && r.toPage === 1, JSON.stringify(r));
  await sleep(300);
  const marks1 = document.querySelectorAll('#page-1 .sj-layer .sj-hl').length;
  const marks2 = document.querySelectorAll('#page-2 .sj-layer .sj-hl').length;
  push('正文标记高亮', marks1 >= 1 && marks2 >= 1, marks1 + '/' + marks2);

  // 5) 普通文本不触发跳转
  r = await run(1, 'Chapter 1 Introduction');
  push('普通文本不跳转', r && r.kind === 'none' && r.found === false, JSON.stringify(r));

  // 6) 点条目找不到标记的情形（11 条目正文没有 [11]）
  r = await run(3, '11. Someone');
  push('正文无标记时提示', r && r.kind === 'entry' && r.markers === 0, JSON.stringify(r));
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
      label: 'smart-jump',
      timeout: 240000,
    });
    assert.equal(r.fail, 0);
    code = 0;
  } catch (e) {
    console.error('[smart-jump] ERROR', e && e.message ? e.message : e);
    code = 3;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(code);
})();
