'use strict';
/*
 * v36 标注侧三个功能的界面级回归（真实 Electron）：
 *   1. 印章标注：选工具 → 预设条出现 → 一次点击落章（不进拖拽手势）→ 画在标注层 → 可撤销
 *   2. 中文标注导出：带印章 / 中文文字的副本能存盘，缺字计数如实回报
 *   3. 批注归档：一次导出成单个 zip，里面有原文档 + annotations.json + 标注.md + README
 *   4. 笔记表格可视化编辑：工具栏「表格」→ 格子界面 → 加减行列 → 插入 Markdown 表格
 * 运行：node scripts/test-v36-anno-ui.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pdfjs = require('pdfjs-dist/build/pdf.js');
const JSZip = require('jszip');
const { runProbe } = require('./probe-runner');

const ROOT = path.join(__dirname, '..');
const SAMPLE = path.join(ROOT, 'assets', 'sample.pdf');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); return; }
  fail++;
  console.log('  FAIL ' + name + (detail ? '  <- ' + detail : ''));
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-v36anno-'));
  const ud = path.join(tmp, 'ud');
  fs.mkdirSync(ud);
  try {
    const pdf = path.join(tmp, 'doc.pdf');
    fs.copyFileSync(SAMPLE, pdf);
    // R5-03 用：第二份文档，两页，正文带标记，便于看出「重排到底读的谁」
    const { PDFDocument, StandardFonts } = require('pdf-lib');
    const secondPath = path.join(tmp, 'second.pdf');
    {
      const d = await PDFDocument.create();
      const font = await d.embedFont(StandardFonts.Helvetica);
      for (let i = 1; i <= 2; i++) {
        const pg = d.addPage([420, 560]);
        pg.drawText('BETA_CURRENT page ' + i, { x: 40, y: 500, size: 18, font });
      }
      fs.writeFileSync(secondPath, await d.save());
    }
    // R5-02 用：一份 sidecar 损坏（存在但解析不了）、一份从未标注过（sidecar 不存在）
    const crypto = require('crypto');
    const sidecarFor = (p) => path.join(ud, 'annotations',
      crypto.createHash('sha1').update(path.resolve(p)).digest('hex').slice(0, 20) + '.json');
    const brokenPath = path.join(tmp, 'broken.pdf');
    fs.copyFileSync(SAMPLE, brokenPath);
    fs.mkdirSync(path.dirname(sidecarFor(brokenPath)), { recursive: true });
    // 截断的 JSON，但里面有完整可辨认的字段：人工还能从原文里捞回这条标注
    fs.writeFileSync(sidecarFor(brokenPath),
      '{"path":"' + brokenPath.replace(/\\/g, '\\\\') + '","saved":1,"pages":[{"page":1,"shapes":[' +
      '{"id":"rec1","tool":"text","text":"ORIGINAL_RECOVERABLE_TEXT","at":{"x":20,"y":30}}]}');
    const brokenBytesBefore = fs.statSync(sidecarFor(brokenPath)).size;
    // 第二份损坏夹具：只用来验「显式重建」——重建会改写文件，所以不能和上面那份共用
    const broken2Path = path.join(tmp, 'broken2.pdf');
    fs.copyFileSync(SAMPLE, broken2Path);
    fs.writeFileSync(sidecarFor(broken2Path), '{"pages":[{"page":1,"shapes":[{"id":"r2","tool":"text","text":"RECOVER_ME"}');
    const emptyPath = path.join(tmp, 'empty.pdf');
    fs.copyFileSync(SAMPLE, emptyPath);

    fs.writeFileSync(path.join(tmp, 'library.json'), JSON.stringify({
      version: 8,
      items: [
        { key: 'k1', itemType: 'journalArticle', title: '印章测试文档', year: '2024', attachment: { path: pdf, name: 'doc.pdf' } },
        { key: 'k2', itemType: 'journalArticle', title: '第二份文档', year: '2023', attachment: { path: secondPath, name: 'second.pdf' } },
        { key: 'k3', itemType: 'journalArticle', title: '标注损坏的文档', year: '2022', attachment: { path: brokenPath, name: 'broken.pdf' } },
        { key: 'k4', itemType: 'journalArticle', title: '用来重建标注的文档', year: '2021', attachment: { path: broken2Path, name: 'broken2.pdf' } },
      ],
    }));

    // R5-01 / R5-02 的落盘位置（探针里按绝对路径导出，绕开保存对话框）
    const flushZip = path.join(tmp, 'flush.zip');
    const badZip = path.join(tmp, 'broken.zip');
    const emptyZip = path.join(tmp, 'empty.zip');
    const chainZip = path.join(tmp, 'broken-chain.zip');

    const probe = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 10000)) { if (await fn()) return true; await sleep(80); } return !!(await fn()); };

  try {
  const ready = await waitFor(() => window.LibraryUI && LibraryUI.isOpen(), 12000);
  push('文献库就绪', ready);
  if (!ready) return { checks };
  const res = await pdfBridge.lib.openItem('k1', 1);
  LibraryUI.hide();
  window.__libOpen(res);
  const loaded = await waitFor(() => App.state.pdfDoc && App.state.rendered.get(1), 25000);
  push('PDF 加载', loaded);
  if (!loaded) return { checks };
  await sleep(400);

  // ---------- 1. 印章 ----------
  Anno.setTool('stamp');
  await sleep(120);
  push('选中印章工具后预设条出现', !$('#stamp-bar').hidden);
  const pickNo = $('#stamp-bar [data-stamp="no"]');
  push('预设条有五枚章', $$('#stamp-bar .stamp-pick').length === 5, $$('#stamp-bar .stamp-pick').length);
  pickNo.click();
  await sleep(80);
  push('选中的预设高亮', pickNo.classList.contains('active'));

  const svg = $('#page-1 .anno');
  const r = svg.getBoundingClientRect();
  svg.dispatchEvent(new PointerEvent('pointerdown', {
    bubbles: true, button: 0, pointerId: 7,
    clientX: r.left + r.width * 0.5, clientY: r.top + r.height * 0.35,
  }));
  await sleep(250);
  const stamps = (App.state.annos.get(1) || []).filter((s) => s.tool === 'stamp');
  push('一次点击就落章（不用拖）', stamps.length === 1, stamps.length);
  push('章上带预设文字', stamps[0] && stamps[0].text === '存疑', stamps[0] && stamps[0].text);
  push('章有位置没有尺寸（尺寸由预设决定）', stamps[0] && Number.isFinite(stamps[0].at.x) && !stamps[0].w,
    JSON.stringify(stamps[0] && { at: stamps[0].at, w: stamps[0].w }));
  push('章画在标注层', $$('#page-1 .anno .stamp-mark').length === 1, $$('#page-1 .anno .stamp-mark').length);
  push('章的文字是预设文字', (($('#page-1 .anno .stamp-mark text') || {}).textContent || '') === '存疑',
    ($('#page-1 .anno .stamp-mark text') || {}).textContent);

  // 换一枚章，再点一次
  $('#stamp-bar [data-stamp="star"]').click();
  svg.dispatchEvent(new PointerEvent('pointerdown', {
    bubbles: true, button: 0, pointerId: 8,
    clientX: r.left + r.width * 0.3, clientY: r.top + r.height * 0.6,
  }));
  await sleep(200);
  const stamps2 = (App.state.annos.get(1) || []).filter((s) => s.tool === 'stamp');
  push('连点两下就是两枚章', stamps2.length === 2, stamps2.length);
  push('第二枚用的是新预设', stamps2[1] && stamps2[1].stamp === 'star', stamps2[1] && stamps2[1].stamp);

  Anno.undo();
  await sleep(200);
  push('撤销撤掉刚落的章', (App.state.annos.get(1) || []).filter((s) => s.tool === 'stamp').length === 1,
    (App.state.annos.get(1) || []).filter((s) => s.tool === 'stamp').length);

  // 切回选择工具后预设条收起
  Anno.setTool('select');
  await sleep(80);
  push('切回选择工具后预设条收起', $('#stamp-bar').hidden);

  // ---------- 2. 导出副本（中文 + 印章） ----------
  App.state.annos.get(1).push({ tool: 'text', color: '#e53935', size: 14, at: { x: 120, y: 200 }, text: '中文批注' });
  Anno.renderPage(1);
  const st = await pdfBridge.getSettings();
  const outPath = String(st.dataDir).replace(/[\\\\/]+$/, '') + '/stamp-export.pdf';
  const exp = await pdfBridge.exportPdf(App.buildExportPayload(outPath));
  push('导出副本成功', !!(exp && exp.ok) && !!exp.path, JSON.stringify(exp && { ok: exp.ok, skipped: exp.skipped, cjk: exp.cjk, font: exp.cjkFont }));
  push('印章与中文都没被跳过', exp && exp.skipped === 0,
    JSON.stringify({ skipped: exp && exp.skipped, reasons: exp && exp.reasons, missing: exp && exp.missingGlyphs }));
  push('导出结果说明用了哪套 CJK 字体', !exp || exp.cjk === true || exp.skipped === 1,
    JSON.stringify({ cjk: exp && exp.cjk, font: exp && exp.cjkFont }));

  // ---------- 3. 批注归档 zip ----------
  const zipPath = String(st.dataDir).replace(/[\\\\/]+$/, '') + '/archive.zip';
  // 归档读的是磁盘上的 sidecar，而标注要等 600ms 的自动保存才落盘。
  // 不先等它落地，这条断言就变成「看机器快不快」——机器闲的时候反而会失败（既有 flake）。
  const sideShapes = async () => {
    const pages = await pdfBridge.loadAnnos(App.state.filePath);
    return (pages || []).reduce((n, e) => n + ((e.shapes || []).length), 0);
  };
  for (let i = 0; i < 40 && (await sideShapes()) < 2; i++) await sleep(100);
  const arc = await pdfBridge.exportAnnoArchive({ path: App.state.filePath, outPath: zipPath });
  push('归档导出成功', !!(arc && arc.ok) && !!arc.path, JSON.stringify(arc));
  push('归档统计到批注条数', arc && arc.annotations >= 2, arc && arc.annotations);

  // ---------- 3b. 归档前必须先存批注（R5-01） ----------
  // 只排 600ms 的自动保存定时器、不写盘：旧实现直接读 sidecar，会把刚加的这条漏掉
  App.state.annos.get(1).push({ id: 'flush-mark-1', tool: 'text', color: '#111111', size: 14, at: { x: 150, y: 260 }, text: 'FLUSH_MARK' });
  if (Anno.renderPage) Anno.renderPage(1);
  App.notifyAnnoChanged();
  const arcFlush = await App.exportArchive(${JSON.stringify(flushZip)});
  push('归档前先 flush：不等自动保存也能打到刚加的批注',
    !!(arcFlush && arcFlush.ok) && arcFlush.annotations >= 3,
    JSON.stringify({ ok: arcFlush && arcFlush.ok, n: arcFlush && arcFlush.annotations }));

  // ---------- 3b2. 别拦过头：正常文档里用户主动清空标注仍要能存 ----------
  // 这条和 3e 是一对：拦截要按「读没读成功」来判，不是按「这条保存是不是空数组」来判
  App.state.annos.clear();
  const cleared = await App.flushAnnos();
  push('正常文档清空全部标注后仍能保存空数组', cleared === true, JSON.stringify(cleared));

  // ---------- 3c. 标注文件读不出来 ≠ 没有批注（R5-02） ----------
  const bad = await pdfBridge.exportAnnoArchive({ path: ${JSON.stringify(brokenPath)}, outPath: ${JSON.stringify(badZip)} });
  push('标注文件损坏：中止归档，不出空包',
    !!(bad && bad.ok === false && bad.broken === true),
    JSON.stringify({ ok: bad && bad.ok, broken: bad && bad.broken }));
  push('中止时说得出原因', !!(bad && /损坏/.test(String((bad && bad.error) || ''))),
    String((bad && bad.error) || '').slice(0, 120));
  const emptyArc = await pdfBridge.exportAnnoArchive({ path: ${JSON.stringify(emptyPath)}, outPath: ${JSON.stringify(emptyZip)} });
  push('从未标注过的文档仍能导出空归档',
    !!(emptyArc && emptyArc.ok === true && emptyArc.annotations === 0),
    JSON.stringify({ ok: emptyArc && emptyArc.ok, n: emptyArc && emptyArc.annotations }));

  // ---------- 3d. 重排要绑死文档（R5-03） ----------
  // 卡住 A 的第一次取页，期间切到 B，再放行：旧实现会按 A 的页数读 B、标题还挂着 A
  const aPath = App.state.filePath;
  const docA = App.state.pdfDoc;
  const origGetPage = docA.getPage.bind(docA);
  let releaseGate = null;
  const gate = new Promise((r) => { releaseGate = r; });
  let gated = true;
  docA.getPage = async (n) => { if (gated) { gated = false; await gate; } return origGetPage(n); };
  $('#btn-reflow').click();
  await sleep(150);
  push('重排已打开并卡在第一页', !$('#reflow-view').hidden && gated === false,
    JSON.stringify({ hidden: $('#reflow-view').hidden, gated: gated }));
  const resB = await pdfBridge.lib.openItem('k2', 1);
  window.__libOpen(resB);
  const onB = await waitFor(() => App.state.filePath === ${JSON.stringify(secondPath)} && App.state.pdfDoc, 25000);
  push('已切到第二份文档', onB, App.state.filePath);
  push('切文档时重排覆盖层被收起', $('#reflow-view').hidden,
    JSON.stringify({ hidden: $('#reflow-view').hidden, title: $('#reflow-title').textContent }));
  releaseGate();
  await sleep(700);
  push('旧任务放行后没有把 A 的内容写回来',
    $('#reflow-view').hidden && $('#reflow-pages').children.length === 0,
    JSON.stringify({ hidden: $('#reflow-view').hidden, nodes: $('#reflow-pages').children.length, title: $('#reflow-title').textContent }));
  $('#btn-reflow').click();
  const reflowB = await waitFor(() => !$('#reflow-view').hidden && $('#reflow-pages').children.length > 0, 25000);
  push('切文档后还能正常重排新文档（busy 没被旧任务锁死）', reflowB,
    JSON.stringify({ hidden: $('#reflow-view').hidden, nodes: $('#reflow-pages').children.length }));
  const bodyB = $('#reflow-pages').textContent || '';
  push('新文档的重排内容来自 B', /BETA_CURRENT/.test(bodyB), bodyB.slice(0, 120));
  push('重排标题跟着换成 B', /second/i.test($('#reflow-title').textContent), $('#reflow-title').textContent);
  $('#reflow-close').click();
  await sleep(120);
  push('关闭重排后覆盖层收起', $('#reflow-view').hidden);

  // ---------- 3e. 完整链路：打开损坏 sidecar 的文档 → 不编辑 → 走界面归档（R6-01） ----------
  // 上一轮只测了「直接调归档 IPC」和「正常文档的 flush」，两条各自成立；
  // 合起来走界面就会：flush 把损坏原文换成空 JSON → 主进程再读就「通过」了 → 出空包 + 原文丢失。
  const resC = await pdfBridge.lib.openItem('k3', 1);
  LibraryUI.hide();
  window.__libOpen(resC);
  const onC = await waitFor(() => App.state.filePath === ${JSON.stringify(brokenPath)} && App.state.pdfDoc, 25000);
  push('打开标注文件损坏的文档', onC, App.state.filePath);
  await sleep(300);
  await waitFor(() => App.state.annoState && App.state.annoState.status !== 'unknown', 8000);
  push('读失败被记成 broken，而不是「没有标注」',
    App.state.annoState && App.state.annoState.status === 'broken',
    JSON.stringify(App.state.annoState));
  push('界面上确实没有标注可显示（空的是展示，不是真相）',
    (App.state.annos.get(1) || []).length === 0, (App.state.annos.get(1) || []).length);
  const chainArc = await App.exportArchive(${JSON.stringify(chainZip)});
  push('界面归档被拦住，不生成空包',
    !!(chainArc && chainArc.ok === false), JSON.stringify(chainArc));
  push('拦住时说明是标注文件坏了',
    !!(chainArc && (chainArc.broken === true || /损坏/.test(String(chainArc.error || '')))),
    JSON.stringify({ broken: chainArc && chainArc.broken, error: chainArc && chainArc.error }));
  const chainFlush = await App.flushAnnos();
  push('自动保存也被拦住（不拿空标注覆盖原文件）', chainFlush === false, JSON.stringify(chainFlush));
  const chainBm = await pdfBridge.bookmarksSave(${JSON.stringify(brokenPath)}, [{ page: 1, at: 1, label: 'X' }]);
  push('书签保存同样被拦住（同一个 sidecar）',
    !!(chainBm && chainBm.ok === false), JSON.stringify(chainBm));

  // 修好之后要能继续用：换一份损坏夹具做「显式重建」，原文件另存，之后保存恢复
  // （上面那份 k3 不重建，留给测试在外面对字节）
  const resD = await pdfBridge.lib.openItem('k4', 1);
  window.__libOpen(resD);
  const onD = await waitFor(() => App.state.filePath === ${JSON.stringify(broken2Path)} && App.state.pdfDoc, 25000);
  push('打开第二份损坏文档', onD, App.state.filePath);
  await sleep(300);
  await waitFor(() => App.state.annoState && App.state.annoState.status !== 'unknown', 8000);
  push('这份同样是 broken', App.state.annoState.status === 'broken', App.state.annoState.status);
  const rebuilt = await App.rebuildAnnosFile();
  push('显式重建成功并留下原文件备份',
    !!(rebuilt && rebuilt.ok === true && rebuilt.backup), JSON.stringify(rebuilt));
  push('重建后状态回到正常，可以继续保存', App.state.annoState.status === 'ok',
    JSON.stringify(App.state.annoState));
  App.state.annos.set(1, [{ id: 'after-rebuild', tool: 'text', at: { x: 40, y: 50 }, text: 'AFTER_REBUILD', size: 14, color: '#111111' }]);
  const afterWrite = await App.flushAnnos();
  push('重建后的保存不再被拦', afterWrite === true, JSON.stringify(afterWrite));

  // ---------- 4. 笔记表格可视化编辑 ----------
  LibraryUI.show();
  await sleep(200);
  const newNote = $('#lib-new-note');
  push('工具栏有「新建笔记」', !!newNote);
  if (newNote) {
    newNote.click();
    const noteOpen = await waitFor(() => !$('#note-view').hidden, 8000);
    push('笔记编辑器打开', noteOpen);
    const tableBtn = $('.toolbar-btn[data-action="table"]');
    push('工具栏有「表格」按钮', !!tableBtn);
    if (tableBtn) {
      tableBtn.click();
      const modal = await waitFor(() => !$('#tbl-modal').hidden, 4000);
      push('表格弹窗打开', modal);
      const cells = () => $$('#tbl-grid .tbl-cell');
      push('默认给了一张可编辑的表', cells().length >= 4, cells().length);
      const setCell = (rr, cc, v) => {
        const el = $('#tbl-grid .tbl-cell[data-r="' + rr + '"][data-c="' + cc + '"]');
        if (!el) return false;
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      };
      setCell(0, 0, '指标');
      setCell(0, 1, '数值');
      setCell(1, 0, '召回率');
      setCell(1, 1, '0.91');
      $('#tbl-add-row').click();
      await sleep(80);
      const afterAdd = cells().length;
      push('加一行后多出格子', afterAdd > 6, afterAdd);
      setCell(2, 0, '精确率');
      setCell(2, 1, '0.88');
      const rowsNow = () => $$('#tbl-grid .tbl-cell[data-c="0"]').length;
      const rowsBeforeCol = rowsNow();
      $('#tbl-add-col').click();
      await sleep(80);
      push('加一列后每行都多一格', cells().length === afterAdd + rowsBeforeCol,
        cells().length + ' vs ' + (afterAdd + rowsBeforeCol) + '（' + rowsBeforeCol + ' 行）');
      setCell(0, 2, '备注');
      setCell(1, 2, '第一轮');
      $('#tbl-del-col').click();
      await sleep(80);
      push('减列把手误删的列撤掉', cells().length === afterAdd, cells().length);
      $('#tbl-ok').click();
      await sleep(200);
      const md = ($('#nv-md') || {}).value || '';
      push('表格弹窗关闭', $('#tbl-modal').hidden);
      push('插入的是 Markdown 表格', /\\| 指标 \\| 数值 \\|/.test(md) && /\\| --- \\| --- \\|/.test(md), md.slice(0, 160));
      push('表体内容进到正文', /召回率/.test(md) && /0\\.91/.test(md), md.slice(0, 200));
      push('加的行也在里面', /精确率/.test(md), md.slice(0, 240));
      push('减掉的列没留下空列', !/\\|\\s*\\|\\s*\\|/.test(md.split('\\n').filter((l) => l.indexOf('指标') >= 0).join('')),
        md.split('\\n').filter((l) => l.indexOf('指标') >= 0).join(''));
    }
  }
  return { checks, outPath: exp && exp.path, zipPath: arc && arc.path };
  } catch (e) { push('探针未抛错', false, String((e && e.stack) || e).slice(0, 500)); return { checks }; }
})()`;

    const probeFile = path.join(tmp, 'probe.cjs');
    fs.writeFileSync(probeFile, 'module.exports=' + JSON.stringify(probe));
    const r = runProbe({
      probe: probeFile,
      env: { PDFREADER_LIBRARY: path.join(tmp, 'library.json'), PDFREADER_DATA_DIR: tmp, PDFREADER_NO_AUTO_INDEX: '1' },
      args: ['--user-data-dir=' + ud],
      label: 'v36-anno',
      timeout: 300000,
    });
    const res = r.res || {};

    // ---------- 文件级断言 ----------
    const outPath = res.outPath;
    ok('导出副本文件存在', !!outPath && fs.existsSync(outPath), String(outPath));
    if (outPath && fs.existsSync(outPath)) {
      ok('导出副本比原文件大（多了标注）', fs.statSync(outPath).size > fs.statSync(SAMPLE).size,
        fs.statSync(outPath).size + ' vs ' + fs.statSync(SAMPLE).size);
      let doc = null;
      try { doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(outPath)), verbosity: 0 }).promise; } catch (_) {}
      ok('导出副本能被 pdfjs 重新打开', !!doc);
      if (doc) { ok('页数不变', doc.numPages === 3, doc.numPages); await doc.destroy(); }
    }

    const zipPath = res.zipPath;
    ok('归档 zip 存在', !!zipPath && fs.existsSync(zipPath), String(zipPath));
    if (zipPath && fs.existsSync(zipPath)) {
      const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
      const names = Object.keys(zip.files);
      ok('zip 里有原文档', names.indexOf('doc.pdf') >= 0, names.join(','));
      ok('zip 里有 annotations.json', names.indexOf('annotations.json') >= 0, names.join(','));
      ok('zip 里有给人看的标注清单', names.indexOf('标注.md') >= 0, names.join(','));
      ok('zip 里有 README', names.indexOf('README.txt') >= 0, names.join(','));
      const md = await zip.file('标注.md').async('string');
      ok('标注清单里能读到印章', /存疑/.test(md), md.slice(0, 200));
      ok('标注清单按页分组', /第\s*1\s*页|第 1 页|## /.test(md), md.slice(0, 200));
      const json = JSON.parse(await zip.file('annotations.json').async('string'));
      ok('annotations.json 是可回读的原始数据', Array.isArray(json.pages) && json.pages.length >= 1, JSON.stringify(json).slice(0, 120));
      const readme = await zip.file('README.txt').async('string');
      ok('README 说明「标注不在 PDF 里」的原因', /可恢复|未改动/.test(readme), readme.slice(0, 120));
    }

    // R5-01：归档前先 flush —— 那条「自动保存还没到点」的批注必须进包
    ok('flush 后生成了归档', fs.existsSync(flushZip), String(flushZip));
    if (fs.existsSync(flushZip)) {
      const zf = await JSZip.loadAsync(fs.readFileSync(flushZip));
      const jf = JSON.parse(await zf.file('annotations.json').async('string'));
      const texts = (jf.pages || []).reduce((a, p) => a.concat((p.shapes || []).map((s) => String(s.text || ''))), []);
      ok('没等到自动保存的那条批注也在归档里', texts.indexOf('FLUSH_MARK') >= 0, texts.join('|').slice(0, 160));
    }

    // R5-02：损坏的 sidecar 必须中止（不出 zip），真正没标注的才出空归档
    ok('标注文件损坏时没有生成 zip', !fs.existsSync(badZip), String(badZip));
    ok('从未标注过的文档仍出空归档', fs.existsSync(emptyZip), String(emptyZip));
    if (fs.existsSync(emptyZip)) {
      const ze = await JSZip.loadAsync(fs.readFileSync(emptyZip));
      const je = JSON.parse(await ze.file('annotations.json').async('string'));
      ok('空归档的 pages 是空数组（可回读）', Array.isArray(je.pages) && je.pages.length === 0, JSON.stringify(je.pages));
    }

    // R6-01：走完整界面链路（打开 → 不编辑 → 归档）之后，损坏的原文件必须一个字节都没动
    ok('界面归档被拦住时没有生成 zip', !fs.existsSync(chainZip), String(chainZip));
    const brokenSidecar = sidecarFor(brokenPath);
    ok('损坏的标注文件仍然存在', fs.existsSync(brokenSidecar), brokenSidecar);
    if (fs.existsSync(brokenSidecar)) {
      const now = fs.readFileSync(brokenSidecar, 'utf8');
      ok('损坏的标注文件字节未变（没有被前置 flush 覆盖）',
        fs.statSync(brokenSidecar).size === brokenBytesBefore && now.indexOf('ORIGINAL_RECOVERABLE_TEXT') >= 0,
        'size ' + fs.statSync(brokenSidecar).size + ' vs ' + brokenBytesBefore);
    }
    // 显式重建：原文件被另存，新文件可用
    const dir4 = path.dirname(sidecarFor(broken2Path));
    const backups = fs.readdirSync(dir4).filter((f) => /\.broken-\d+\.json$/.test(f));
    ok('重建时把损坏的原文件另存了一份', backups.length >= 1, backups.join(','));
    if (backups.length) {
      const saved = fs.readFileSync(path.join(dir4, backups[backups.length - 1]), 'utf8');
      ok('另存的那份保留了原始可恢复内容', saved.indexOf('RECOVER_ME') >= 0, saved.slice(0, 120));
    }
    const afterRebuild = fs.readFileSync(sidecarFor(broken2Path), 'utf8');
    ok('重建后的标注文件是合法 JSON', (() => { try { JSON.parse(afterRebuild); return true; } catch (_) { return false; } })(),
      afterRebuild.slice(0, 120));
    ok('重建后的标注文件里有新写的标注', afterRebuild.indexOf('AFTER_REBUILD') >= 0, afterRebuild.slice(0, 160));

    // 清空标注的正常路径也落了盘（pages 为空数组，不是文件缺失）
    const clearedSidecar = sidecarFor(pdf);
    ok('清空标注后 sidecar 里是空 pages（不是被误判成损坏）',
      fs.existsSync(clearedSidecar) && JSON.parse(fs.readFileSync(clearedSidecar, 'utf8')).pages.length === 0,
      fs.existsSync(clearedSidecar) ? fs.readFileSync(clearedSidecar, 'utf8').slice(0, 120) : 'missing');

    console.log('[v36-anno] ' + (fail ? 'FAIL (' + fail + '/' + (pass + fail) + ')' : 'PASS (' + pass + ')'));
    process.exit(fail ? 2 : 0);
  } catch (e) {
    console.error('[v36-anno] ERROR', e && e.message ? e.message : e);
    process.exit(3);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
})();
