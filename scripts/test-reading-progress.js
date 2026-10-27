'use strict';
/*
 * 阅读进度回归（Koodo Reader 式的列表进度条 + 继续阅读）：
 *   基础：翻页后条目 page / pageTotal 落库（沿用 set-page 链路，仅扩展 total）；
 *   列表：卡片出现进度条与百分比；详情附件区出现「继续阅读 · x%」；
 *   行为：点继续阅读直接落到上次页码；老数据（无 pageTotal）只有页码文字，不画条。
 * 测试 PDF 3 页现场生成。
 * 运行：node scripts/test-reading-progress.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { runProbe } = require('./probe-runner');

// ---------- A. Node：数据层 ----------
(function nodePart() {
  const library = require('../src/library.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-readprog-'));
  process.env.PDFREADER_LIBRARY = path.join(dir, 'library.json');
  process.env.PDFREADER_DATA_DIR = dir;
  try {
    delete require.cache[require.resolve('../src/library.js')];
    const L = require('../src/library.js');
    const add = L.addItem ? null : null;   // 不用 add；直接走 updateReading 场景需要先有条目
    // 直接造库文件再读
    fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify({ version: 8, items: [
      { key: 'k1', itemType: 'journalArticle', title: 'T1', page: 2 },
      { key: 'k2', itemType: 'book', title: 'T2' },
    ] }));
    delete require.cache[require.resolve('../src/library.js')];
    const L2 = require('../src/library.js');
    const r = L2.setPageByKey('k1', 3, 10);
    assert.equal(r.page, 3, '页码更新');
    assert.equal(r.pageTotal, 10, '总页数更新');
    const sum = L2.summary();
    const it = sum.items.find((x) => x.key === 'k1');
    assert.equal(it.pageTotal, 10, 'publicItem 暴露 pageTotal');
    // 非法 total 不落库
    L2.setPageByKey('k2', 1, -5);
    const it2 = L2.summary().items.find((x) => x.key === 'k2');
    assert.ok(!it2.pageTotal, '非法 total 被忽略');
    console.log('[reading-progress-node] PASS');
  } finally {
    delete process.env.PDFREADER_LIBRARY;
    delete process.env.PDFREADER_DATA_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

// ---------- B. Electron：端到端 ----------
let code = 0;
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-readprog-'));
  const ud = path.join(tmp, 'ud');
  fs.mkdirSync(ud);
  try {
    const pdf = path.join(tmp, 'prog.pdf');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let n = 1; n <= 3; n++) {
      const p = doc.addPage([612, 792]);
      p.drawText('Progress page ' + n, { x: 60, y: 700, size: 18, font });
    }
    fs.writeFileSync(pdf, await doc.save());

    const probe = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  // waitFor 必须能等 async 断言：async 函数返回 Promise，直接 if(fn()) 永远为真
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 10000)) { if (await fn()) return true; await sleep(60); } return !!(await fn()); };
  const loaded = await waitFor(() => App.state.pdfDoc && App.state.rendered.get(1), 25000);
  push('PDF 已打开', loaded);
  if (!loaded) return { checks };
  await sleep(700);   // 等初始页码上报（500ms 去抖）先落盘，别跟下面的翻页上报搅在一起

  // 1) 翻到第 2 页，等页码上报落库（去抖 500ms + 落盘时间）
  scrollToPage(2, true);
  const saved = await waitFor(async () => {
    const s = await pdfBridge.lib.summary();
    const it = (s.items || []).find((x) => x.attachment && x.attachment.path && x.attachment.path.toLowerCase().endsWith('prog.pdf'));
    return it && it.page === 2 && it.pageTotal === 3;
  }, 10000);
  push('翻页后 page=2 / pageTotal=3 落库', saved);

  // B06：再造一条没有进度的条目，用来对比「已读 / 未读」的行高与列位
  const unreadAdd = await pdfBridge.addItem({ itemType: 'book', title: '未读样本（无进度）' });
  push('未读样本入库', unreadAdd && unreadAdd.ok !== false, JSON.stringify(unreadAdd || {}).slice(0, 80));

  // 2) 回文献库：卡片有进度条与百分比，详情有「继续阅读」
  window.LibraryUI && LibraryUI.show();
  await LibraryUI.refresh();   // state.items 可能还是打开前的旧快照，先刷新再量卡片
  await waitFor(() => document.querySelectorAll('#lib-grid .lib-card').length >= 1, 8000);
  await sleep(400);
  const s2 = await pdfBridge.lib.summary();
  const it2 = (s2.items || []).find((x) => x.attachment && x.attachment.path && x.attachment.path.toLowerCase().endsWith('prog.pdf'));
  push('刷新后库里页码', it2 && it2.page === 2 && it2.pageTotal === 3, JSON.stringify({ page: it2 && it2.page, pageTotal: it2 && it2.pageTotal, keys: (s2.items || []).length }));
  // 列表里现在有「已读 PDF」和「未读样本」两张卡，取有进度条的那张
  const allCards = Array.from(document.querySelectorAll('#lib-grid .lib-card'));
  const card = allCards.find((c) => c.querySelector('.lc-readbar')) || allCards[0];
  push('卡片有进度条', !!(card && card.querySelector('.lc-readbar')), card && card.querySelector('.lc-readbar') && card.querySelector('.lc-readbar').outerHTML.slice(0, 80));
  const bar = card && card.querySelector('.lc-readbar i');
  push('进度条宽度约 67%', bar && Math.abs(parseInt(bar.style.width, 10) - 67) <= 2, bar && bar.style.width);
  push('卡片页码文字含百分比', card && /第 2 页 · 67%/.test(card.textContent), card && card.textContent.slice(0, 80));

  // B06：进度条曾是第 7 个网格子项，把收藏集/标签右移、操作按钮挤到下一行
  const unread = Array.from(document.querySelectorAll('#lib-grid .lib-card')).find((c) => c.textContent.indexOf('未读样本') >= 0);
  // 行内各格垂直居中，比较「中心线」而不是 top（各元素字号不同，top 天然有差）
  const midOf = (el) => { if (!el) return -999; const r = el.getBoundingClientRect(); return Math.round(r.top + r.height / 2); };
  const titleMid = midOf(card && card.querySelector('.lctitle'));
  push('B06 标题与操作区在同一行', Math.abs(midOf(card && card.querySelector('.lcbar')) - titleMid) <= 2,
    'titleMid=' + titleMid + ' barMid=' + midOf(card && card.querySelector('.lcbar')));
  push('B06 收藏集列仍在第一行', Math.abs(midOf(card && card.querySelector('.lccolls')) - titleMid) <= 2,
    'titleMid=' + titleMid + ' collsMid=' + midOf(card && card.querySelector('.lccolls')));
  push('B06 已读与未读行高一致', !!unread && Math.abs(card.getBoundingClientRect().height - unread.getBoundingClientRect().height) <= 1,
    'read=' + (card && card.getBoundingClientRect().height) + ' unread=' + (unread && unread.getBoundingClientRect().height));
  const barBox = card && card.querySelector('.lc-readbar').getBoundingClientRect();
  const cardBox = card && card.getBoundingClientRect();
  push('B06 进度条贴在卡片底边', !!barBox && !!cardBox && barBox.bottom <= cardBox.bottom + 1 && barBox.top > cardBox.top + cardBox.height / 2,
    barBox && cardBox ? 'barTop=' + Math.round(barBox.top) + ' cardBottom=' + Math.round(cardBox.bottom) : '');
  LibraryUI.openDetail(card.dataset.key);
  const resume = await waitFor(() => document.querySelector('[data-ld-resume]'), 6000)
    ? document.querySelector('[data-ld-resume]') : null;
  push('详情有继续阅读按钮', !!resume, resume && resume.textContent);
  push('按钮显示百分比', resume && resume.textContent.includes('67%'), resume && resume.textContent);

  // 3) 点继续阅读 → 落到第 2 页
  LibraryUI.hide();
  await sleep(300);
  if (!resume) return { checks };
  resume.click();
  const reopened = await waitFor(() => App.state.pdfDoc && App.state.currentPage === 2, 15000);
  push('继续阅读落到第 2 页', reopened, 'cur=' + App.state.currentPage);
  return { checks };
})()`;
    const probeFile = path.join(tmp, 'probe.cjs');
    fs.writeFileSync(probeFile, 'module.exports=' + JSON.stringify(probe));

    // 让 PDF 直接挂进库：探针开头 addPdf（注意保持 Windows 反斜杠路径——主进程
    // recordPage 按路径把页码同步到条目，正斜杠/反斜杠不一致会匹配不到条目）。
    const probe2 = probe.replace(`  const loaded = await waitFor(() => App.state.pdfDoc && App.state.rendered.get(1), 25000);
  push('PDF 已打开', loaded);
  if (!loaded) return { checks };`,
`  const add = await pdfBridge.lib.addPdf(${JSON.stringify(pdf)}, { dedupe: true });
  push('PDF 入库', add && add.ok, JSON.stringify(add || {}).slice(0, 100));
  const opened = await pdfBridge.lib.openItem(add.item.key);
  if (opened && opened.ok && typeof window.__libOpen === 'function') window.__libOpen(opened);   // 与 UI 的 openItem 一致
  await waitFor(() => App.state.pdfDoc && App.state.rendered.get(1), 25000);
  push('PDF 已打开', !!(opened && opened.ok) && !!App.state.pdfDoc, JSON.stringify(opened || {}).slice(0, 100));
  if (!App.state.pdfDoc) return { checks };`);
    fs.writeFileSync(probeFile, 'module.exports=' + JSON.stringify(probe2));

    const r = runProbe({
      probe: probeFile,
      env: {
        PDFREADER_DATA_DIR: tmp,
        PDFREADER_LIBRARY: path.join(tmp, 'library.json'),
        PDFREADER_NO_AUTO_INDEX: '1',
      },
      args: ['--user-data-dir=' + ud],
      label: 'reading-progress',
      timeout: 240000,
    });
    assert.equal(r.fail, 0);
    code = 0;
  } catch (e) {
    console.error('[reading-progress] ERROR', e && e.message ? e.message : e);
    code = 3;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(code);
})();
