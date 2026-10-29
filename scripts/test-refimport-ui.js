'use strict';
/*
 * 参考文献表批量入库（v36）端到端：真实 Electron + 真 PDF。
 *
 * 造一份 3 页的 PDF，第 3 页是 "References" + 5 条英文参考文献（不带 DOI / arXiv，
 * 所以整个流程一次网都不联）。验的是：
 *   1. 工具栏按钮能打开弹窗，并从文末找到标题页；
 *   2. 解析出 5 条，标题 / 年份 / 卷期页都进到了行里；
 *   3. 默认勾选全部新增条目，取消一条后导入按钮上的数字跟着变；
 *   4. 导入后库里真的多了 4 条，字段对得上；
 *   5. 导完这些条目就地变成「已有」，按钮置灰（不会重复导入）；
 *   6. Esc 关弹窗。
 * 运行：node scripts/test-refimport-ui.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { runProbe } = require('./probe-runner');

const ROOT = path.join(__dirname, '..');

const REFS = [
  '[1] J. Smith and A. Lee, "Deep learning for document analysis," IEEE Trans. Pattern Anal. Mach. Intell., vol. 42, no. 5, pp. 1123-1140, 2020.',
  '[2] C. M. Bishop, Pattern Recognition and Machine Learning. Springer, 2006.',
  '[3] A. Krizhevsky, I. Sutskever, and G. E. Hinton, "ImageNet classification," in Advances in Neural Information Processing Systems, 2012, pp. 1097-1105.',
  '[4] Smith, J. A., & Jones, B. (2019). A survey of PDF text extraction. Journal of Documentation, 75(3), 456-478.',
  '[5] M. Lee. Reading interfaces for scholars. Digital Scholarship, 12(2), 33-51, 2021.',
];

async function makePdf(file) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 2; i++) {
    const page = doc.addPage([595, 842]);
    page.drawText('BODY PAGE ' + i, { x: 60, y: 780, size: 14, font });
    page.drawText('Body text of the paper. No reference entries on this page.', { x: 60, y: 740, size: 10, font });
  }
  const page = doc.addPage([595, 842]);
  page.drawText('References', { x: 60, y: 780, size: 12, font });
  let y = 748;
  for (const line of REFS) {
    page.drawText(line, { x: 26, y, size: 6.5, font });
    y -= 16;
  }
  fs.writeFileSync(file, await doc.save());
  return file;
}

let code = 0;
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-refi-'));
  const ud = path.join(tmp, 'ud');
  fs.mkdirSync(ud);
  try {
    const pdf = await makePdf(path.join(tmp, 'refs.pdf'));
    fs.writeFileSync(path.join(tmp, 'library.json'), JSON.stringify({
      version: 8,
      items: [{
        key: 'k1', itemType: 'journalArticle', title: '带参考文献的论文', year: '2024',
        creators: [{ firstName: 'Jane', lastName: 'Smith', creatorType: 'author' }],
        attachment: { path: pdf, name: 'refs.pdf' },
      }],
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
  push('文档加载（3 页）', loaded, App.state.numPages);
  if (!loaded) return { checks };

  push('工具栏有入库按钮', !!$('#btn-refimport'));
  // 真实场景：用户停在第 1 页就点「参考文献表入库」，文末那页根本没画出来。
  // 扫描必须能走 pdfDoc.getPage，不能依赖已渲染的页面元素——否则在长文档里
  // 永远只能得到「没读到参考文献（扫描版）」这个假警报。
  const lastEl = App.pageEl(3);
  const savedPage = lastEl && lastEl._pdfPage;
  if (lastEl) lastEl._pdfPage = null;
  App.state.textCache.delete(3);
  App.state.sj.byPage.delete(3);
  push('文末页未渲染也能扫到参考文献（不依赖页面元素）', true,
    savedPage ? '原本已渲染，测试里临时摘掉 _pdfPage' : '原本就未渲染');
  $('#btn-refimport').click();
  const opened = await waitFor(() => !$('#refi-modal').hidden, 6000);
  push('弹窗打开', opened);

  const rows = await waitFor(() => document.querySelectorAll('#refi-list .refi-row').length === 5, 25000);
  const status = ($('#refi-status') || {}).textContent || '';
  if (lastEl && savedPage) lastEl._pdfPage = savedPage;   // 还原，后续断言照常
  push('解析出 5 条', rows, document.querySelectorAll('#refi-list .refi-row').length);
  if (!rows) {
    // 没出列表时把状态行带进失败详情：多半是「没有文字层」或「解析失败」
    push('解析出条目', false, status || '(状态行为空)');
    return { checks };
  }
  push('状态行说明从第 3 页起', /第 3 页/.test(status), status);
  push('计数行正确', /共 5 条/.test($('#refi-count').textContent), $('#refi-count').textContent);

  const titles = Array.from(document.querySelectorAll('#refi-list .refi-title')).map((x) => x.textContent);
  push('引号标题', titles[0] === 'Deep learning for document analysis', titles[0]);
  push('书名', titles[1] === 'Pattern Recognition and Machine Learning', titles[1]);
  push('会议论文标题', titles[2] === 'ImageNet classification', titles[2]);
  push('APA 标题', titles[3] === 'A survey of PDF text extraction', titles[3]);
  push('刊名-年份制标题', titles[4] === 'Reading interfaces for scholars', titles[4]);

  const meta0 = (document.querySelectorAll('#refi-list .refi-meta')[0] || {}).textContent || '';
  push('题录带作者/年份/卷期页', /2020/.test(meta0) && /1123-1140/.test(meta0) && /vol\\. 42/.test(meta0), meta0);

  const checked = () => Array.from(document.querySelectorAll('#refi-list [data-refi-pick]')).filter((x) => x.checked).length;
  push('默认勾选全部新增', checked() === 5, checked());
  push('导入按钮带条数', /5/.test($('#refi-go').textContent), $('#refi-go').textContent);

  const cb5 = document.querySelector('#refi-list [data-refi-pick="5"]');
  cb5.click();
  await sleep(150);
  push('取消一条后计数跟着变', checked() === 4 && /4/.test($('#refi-go').textContent), checked() + ' / ' + $('#refi-go').textContent);

  // 这几条都没有 DOI / arXiv，联网补全不会发起任何请求
  $('#refi-go').click();
  const done = await waitFor(() => /已入库/.test($('#refi-status').textContent), 30000);
  push('导入完成', done, $('#refi-status').textContent);
  push('导入结果 4 条', /已入库 4 条/.test($('#refi-status').textContent), $('#refi-status').textContent);

  const sum = await pdfBridge.lib.summary();
  const items = (sum.items || []).filter((x) => !x.deletedAt);
  push('库里多了 4 条', items.length === 5, items.length);
  const byTitle = (t) => items.find((x) => x.title === t);
  const deep = byTitle('Deep learning for document analysis');
  push('新条目字段：年份', !!deep && deep.year === '2020', deep && deep.year);
  push('新条目字段：卷/期/页', !!deep && deep.volume === '42' && deep.issue === '5' && deep.pages === '1123-1140',
    deep && [deep.volume, deep.issue, deep.pages].join('/'));
  push('新条目字段：刊名', !!deep && /IEEE Trans/.test(deep.publication), deep && deep.publication);
  push('新条目字段：作者两人', !!deep && deep.creators.length === 2, deep && deep.creators.length);
  push('没导入被取消的那条', !byTitle('Reading interfaces for scholars'));
  push('认出的类型：会议论文', (byTitle('ImageNet classification') || {}).itemType === 'conferencePaper',
    (byTitle('ImageNet classification') || {}).itemType);
  push('猜测题录留下原文笔记', !!(byTitle('A survey of PDF text extraction') || {}).notes.length);

  push('导完就地变成已有', document.querySelectorAll('#refi-list .refi-badge-dup').length === 4,
    document.querySelectorAll('#refi-list .refi-badge-dup').length);
  push('没东西可导时按钮置灰', $('#refi-go').disabled);

  $('#refi-cancel').click();
  push('关闭按钮可用', $('#refi-modal').hidden);
  $('#btn-refimport').click();
  await waitFor(() => !$('#refi-modal').hidden, 6000);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  const esc = await waitFor(() => $('#refi-modal').hidden, 3000);
  push('Esc 关弹窗', esc);
  return { checks };
})()`;

    const probeFile = path.join(tmp, 'probe.cjs');
    fs.writeFileSync(probeFile, 'module.exports=' + JSON.stringify(probe));
    const r = runProbe({
      probe: probeFile,
      env: { PDFREADER_LIBRARY: path.join(tmp, 'library.json'), PDFREADER_DATA_DIR: tmp, PDFREADER_NO_AUTO_INDEX: '1' },
      args: ['--user-data-dir=' + ud],
      label: 'refimport-ui',
      timeout: 300000,
    });
    assert.equal(r.fail, 0);
    code = 0;
  } catch (e) {
    console.error('[refimport-ui] ERROR', e && e.message ? e.message : e);
    code = 3;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(code);
})();
