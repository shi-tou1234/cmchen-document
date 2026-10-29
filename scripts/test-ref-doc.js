'use strict';
/*
 * 跨文档对照阅读回归（2026-10-29）
 * 造两份不同页数的 PDF（主文档 3 页 / 对照 5 页）：
 *   1. 默认分屏仍是同一份文档的另一页；
 *   2. 从「选择对照文献」里挑另一篇，参考视图换成对方、页数变成 5；
 *   3. 对照页可独立翻页，主文档页数不受影响；
 *   4. 跨文档时「跟随」禁用，标题显示对方名字；
 *   5. 会话记录对照路径；「用当前文档的另一页」能退回同文档模式。
 * 运行：node scripts/test-ref-doc.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { runProbe } = require('./probe-runner');

const ROOT = path.join(__dirname, '..');
const SAMPLE = path.join(ROOT, 'assets', 'sample.pdf');

async function makeOther(file) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 5; i++) {
    const page = doc.addPage([595, 842]);
    page.drawText('OTHER DOCUMENT - PAGE ' + i, { x: 60, y: 760, size: 16, font });
  }
  fs.writeFileSync(file, await doc.save());
  return file;
}

let code = 0;
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-refdoc-'));
  const ud = path.join(tmp, 'ud');
  fs.mkdirSync(ud);
  try {
    const mainPdf = path.join(tmp, 'main.pdf');
    fs.copyFileSync(SAMPLE, mainPdf);
    const otherPdf = await makeOther(path.join(tmp, 'other.pdf'));
    const thirdPdf = await makeOther(path.join(tmp, 'third.pdf'));
    fs.writeFileSync(path.join(tmp, 'library.json'), JSON.stringify({
      version: 8,
      items: [
        {
          key: 'k1', itemType: 'journalArticle', title: '主文档', year: '2024',
          creators: [{ firstName: 'Jane', lastName: 'Smith', creatorType: 'author' }],
          attachment: { path: mainPdf, name: 'main.pdf' },
        },
        {
          key: 'k2', itemType: 'journalArticle', title: '对照文献', year: '2023',
          creators: [{ firstName: 'Wei', lastName: 'Zhang', creatorType: 'author' }],
          attachment: { path: otherPdf, name: 'other.pdf' },
        },
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
  const loaded = await waitFor(() => App.state.pdfDoc && App.state.rendered.get(1), 25000);
  push('主文档加载（3 页）', loaded && App.state.numPages === 3, App.state.numPages);
  if (!loaded) return { checks };

  push('参考视图有选择对照的入口', !!$('#ref-pick'));
  App.setSplitView(true);
  const paneShown = await waitFor(() => !$('#ref-pane').hidden, 5000);
  push('分屏打开', paneShown);
  push('默认是同文档的另一页', App.splitState().refPages === 3 && !App.splitState().refPath, JSON.stringify(App.splitState()));
  push('同文档模式不显示对照标题', $('#ref-name').hidden);

  // 先把同文档参考页翻到第 2 页：选新对照后应该回到第 1 页，会话也要存 1（第二轮 3）
  App.refSetPage(2);
  await waitFor(() => $('#ref-page').value === '2', 3000);

  $('#ref-pick').click();
  const modalShown = await waitFor(() => !$('#ref-picker').hidden, 5000);
  push('选择器打开', modalShown);
  const listed = await waitFor(() => document.querySelectorAll('#ref-picker-list .ref-picker-item').length >= 2, 8000);
  push('选择器列出可对照的 PDF', listed, document.querySelectorAll('#ref-picker-list .ref-picker-item').length);
  const target = Array.from(document.querySelectorAll('#ref-picker-list .ref-picker-item'))
    .find((b) => String(b.dataset.refPath || '').includes('other.pdf'));
  push('列表里有对照文献', !!target, target && target.dataset.refPath);
  if (target) target.click();

  const cross = await waitFor(() => App.splitState().refPath && App.splitState().refPages === 5, 20000);
  push('对照文献加载为 5 页', cross, JSON.stringify(App.splitState()));
  push('新对照从第 1 页开始', App.splitState().page === 1, App.splitState().page);
  push('标题显示对照文献名', !$('#ref-name').hidden && $('#ref-name').textContent.includes('对照文献'), $('#ref-name').textContent);
  push('跨文档时禁用跟随', $('#ref-follow').disabled);
  const painted = await waitFor(() => $('#ref-canvas') && !$('#ref-canvas').hidden && $('#ref-canvas').width > 10, 8000);
  push('参考画布已渲染', painted, $('#ref-canvas').width);

  await sleep(1200);
  const sess = await pdfBridge.getSession();
  const rec = sess && sess.tabs && sess.tabs[0];
  push('会话记录对照文献路径', !!(rec && String(rec.refPath || '').includes('other.pdf')), rec && rec.refPath);
  push('会话里的参考页是新文献的第 1 页（第二轮 3）', !!(rec && Number(rec.refPage) === 1), rec && rec.refPage);

  App.refSetPage(5);
  const p5 = await waitFor(() => $('#ref-page').value === '5' && $('#ref-count').textContent.trim() === '/ 5', 6000);
  push('对照页可独立翻到第 5 页', p5, $('#ref-page').value + ' ' + $('#ref-count').textContent);
  push('主文档页数不受影响', App.state.numPages === 3, App.state.numPages);
  await sleep(1200);
  const sess5 = await pdfBridge.getSession();
  const rec5 = sess5 && sess5.tabs && sess5.tabs[0];
  push('会话记录翻到第 5 页', !!(rec5 && Number(rec5.refPage) === 5), rec5 && rec5.refPage);

  // 对照文献按标签各自保存：开第二个标签（主文档换成对照那篇），再切回来
  const res2 = await pdfBridge.lib.openItem('k2', 1);
  window.__libOpen(res2);
  const second = await waitFor(() => App.tabs.length >= 2 && String(App.state.filePath || '').includes('other.pdf') && App.state.rendered.get(1), 25000);
  push('第二个标签打开为另一篇主文档', second, App.state.filePath);
  push('新标签默认没有对照文献', !App.state.refPath && $('#ref-name').hidden,
    JSON.stringify({ refPath: App.state.refPath, hidden: $('#ref-name').hidden }));
  const tab1 = App.tabs.find((t) => String(t.filePath || '').includes('main.pdf'));
  const tabEl = tab1 && document.querySelector('.tab[data-tab-id="' + tab1.id + '"]');
  push('找到主文档标签', !!tabEl);
  if (tabEl) tabEl.click();
  const restored = await waitFor(() => String(App.state.filePath || '').includes('main.pdf')
    && String(App.splitState().refPath || '').includes('other.pdf')
    && App.splitState().refPages === 5, 25000);
  push('切回标签恢复对照文献', restored, App.state.filePath + ' | ' + App.splitState().refPath);
  push('恢复后对照页数仍为 5', App.splitState().refPages === 5, App.splitState().refPages);
  push('恢复后对照页停在第 5 页', App.splitState().page === 5,
    JSON.stringify({ page: App.splitState().page, tabs: App.tabs.map((t) => ({ f: String(t.filePath || '').split(/[\\\\/]/).pop(), ref: t.refPage })) }));

  // 第二轮 1：选择器每次打开都重新取，新导入的文献必须能出现
  await pdfBridge.lib.addPdf(${JSON.stringify(thirdPdf)}, { dedupe: true, skipIdentify: true });
  $('#ref-pick').click();
  await waitFor(() => !$('#ref-picker').hidden, 5000);
  const refreshed = await waitFor(() => document.querySelectorAll('#ref-picker-list .ref-picker-item').length >= 3, 10000);
  push('新增文献后选择器会刷新（第二轮 1）', refreshed, document.querySelectorAll('#ref-picker-list .ref-picker-item').length);
  const thirdBtn = Array.from(document.querySelectorAll('#ref-picker-list .ref-picker-item'))
    .find((b) => String(b.dataset.refPath || '').includes('third.pdf'));
  push('列表里出现新导入的文献', !!thirdBtn);
  $('#ref-picker-x').click();

  // 第二轮 2：旧对照文档销毁等待期间取消，已取消的加载不能再把文档挂回来
  const old = App.state.refDoc;
  let destroyCalled = false, release = null;
  const pending = new Promise((res) => { release = res; });
  const origDestroy = old.destroy.bind(old);
  old.destroy = () => { destroyCalled = true; try { origDestroy(); } catch (_) {} return pending; };
  const loading = App.loadRefDoc(${JSON.stringify(thirdPdf)}, 'third');
  const entered = await waitFor(() => destroyCalled, 15000);
  push('进入旧对照文档的销毁等待', entered);
  App.clearRefDoc();
  push('取消后立即清空对照', !App.state.refPath && !App.state.refDoc, App.state.refPath);
  release();
  try { await loading; } catch (_) {}
  await sleep(300);
  push('已取消的加载不会把对照挂回来（第二轮 2）', !App.state.refPath && !App.state.refDoc,
    JSON.stringify({ refPath: App.state.refPath, hasDoc: !!App.state.refDoc }));

  // 再选一次对照，然后验证「用当前文档的另一页」能退回
  $('#ref-pick').click();
  await waitFor(() => !$('#ref-picker').hidden, 5000);
  await waitFor(() => Array.from(document.querySelectorAll('#ref-picker-list .ref-picker-item'))
    .some((b) => String(b.dataset.refPath || '').includes('other.pdf')), 10000);
  const againBtn = Array.from(document.querySelectorAll('#ref-picker-list .ref-picker-item'))
    .find((b) => String(b.dataset.refPath || '').includes('other.pdf'));
  if (againBtn) againBtn.click();
  const again = await waitFor(() => String(App.splitState().refPath || '').includes('other.pdf') && App.splitState().refPages === 5, 20000);
  push('可以再次选择对照文献', again, App.splitState().refPath);

  $('#ref-pick').click();
  await waitFor(() => !$('#ref-picker').hidden, 5000);
  $('#ref-picker-same').click();
  const back = await waitFor(() => !App.splitState().refPath && App.splitState().refPages === 3, 8000);
  push('可以退回同一份的另一页', back, JSON.stringify(App.splitState()));
  push('退回后标题隐藏', $('#ref-name').hidden);
  return { checks };
})()`;

    const probeFile = path.join(tmp, 'probe.cjs');
    fs.writeFileSync(probeFile, 'module.exports=' + JSON.stringify(probe));
    const r = runProbe({
      probe: probeFile,
      env: { PDFREADER_LIBRARY: path.join(tmp, 'library.json'), PDFREADER_DATA_DIR: tmp, PDFREADER_NO_AUTO_INDEX: '1' },
      args: ['--user-data-dir=' + ud],
      label: 'ref-doc',
      timeout: 300000,
    });
    assert.equal(r.fail, 0);
    code = 0;
  } catch (e) {
    console.error('[ref-doc] ERROR', e && e.message ? e.message : e);
    code = 3;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(code);
})();
