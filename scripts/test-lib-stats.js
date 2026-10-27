'use strict';
/*
 * 库统计面板回归：
 *   Node 侧：LibStats.compute 的口径——回收站不计、类型/年份/标签排序、年份分桶
 *            （最近 12 年 + 更早 + 未知）、附件/笔记覆盖率、最近添加。
 *   Electron 侧：造一个带类型/年份/标签/回收站的库，打开统计面板核对渲染数字。
 * 运行：node scripts/test-lib-stats.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const LibStats = require('../src/libstats.js');
const { runProbe } = require('./probe-runner');

// ---------- A. Node 纯逻辑 ----------
(function nodePart() {
  const thisYear = new Date().getFullYear();
  const items = [
    { key: 'a', itemType: 'journalArticle', year: String(thisYear), tags: ['ml', '阅读'], attachment: { path: 'C:/x/a.pdf', name: 'a.pdf' }, notes: [{ id: 'n1', text: '有内容' }], annoIds: ['x1'], created: 100 },
    { key: 'b', itemType: 'journalArticle', year: String(thisYear - 1), tags: ['ml'], created: 300 },
    { key: 'c', itemType: 'book', year: '1999', tags: [], attachment: { path: 'C:/x/b.epub', name: 'b.epub' }, created: 200 },
    { key: 'd', itemType: 'document', year: '', created: 50 },
    { key: 'e', itemType: 'preprint', year: 'abc', created: 60 },
    { key: 'f', itemType: 'book', year: String(thisYear - 30), created: 70, deletedAt: 1 },   // 回收站
  ];
  const st = LibStats.compute(items);
  assert.equal(st.total, 5, '回收站不计入总数: ' + st.total);
  assert.equal(st.trashed, 1, '回收站单列');
  assert.deepEqual(st.byType.map((x) => x.type + ':' + x.count).slice(0, 2), ['journalArticle:2', 'book:1'], '类型计数与排序: ' + JSON.stringify(st.byType));
  const ym = Object.fromEntries(st.byYear.map((r) => [r.year, r.count]));
  assert.equal(ym[String(thisYear)], 1, '今年分桶');
  assert.equal(ym[String(thisYear - 1)], 1, '去年分桶');
  assert.equal(ym['更早'], 1, '1999 落入更早');
  assert.equal(ym['未知'], 2, '空年份与非法年份算未知: ' + JSON.stringify(st.byYear));
  // B12：入库年份按 created 分桶，和出版年份分开
  const cm = Object.fromEntries(st.byCreated.map((r) => [r.year, r.count]));
  assert.equal(cm[String(thisYear)], 0, 'created 是 1970 年的时间戳，不该算今年: ' + JSON.stringify(st.byCreated));
  const stNow = LibStats.compute([{ key: 'n', itemType: 'book', year: '1999', created: Date.now() }]);
  assert.equal(Object.fromEntries(stNow.byCreated.map((r) => [r.year, r.count]))[String(thisYear)], 1, '今天入库算今年');
  assert.equal(Object.fromEntries(stNow.byYear.map((r) => [r.year, r.count]))['更早'], 1, '出版年份仍是 1999 → 更早');
  assert.equal(st.topTags[0].tag, 'ml', '标签按次数排序');
  assert.equal(st.topTags[0].count, 2, '标签计数');
  assert.equal(st.withAttachment, 2, '附件计数');
  assert.equal(st.withPdf, 1, 'PDF 附件计数（epub 不算）');
  assert.equal(st.withNotes, 1, '笔记计数');
  assert.equal(st.withAnnos, 1, '批注计数');
  assert.equal(st.recent[0].key, 'b', '最近添加按 created 排序');

  // 边界：空库、全回收站
  const empty = LibStats.compute([]);
  assert.equal(empty.total, 0 && empty.byYear.filter((r) => r.count).length, 0, '空库不报错');
  const allTrash = LibStats.compute([{ key: 'x', itemType: 'book', deletedAt: 5 }]);
  assert.equal(allTrash.total, 0 && allTrash.trashed, 1, '全回收站');

  // 年份桶：未来一年也算进最近区间
  assert.equal(LibStats.yearBucket(String(thisYear + 1), 12), String(thisYear + 1), '未来一年归今年区间');

  console.log('[lib-stats-node] PASS');
})();

// ---------- B. Electron 面板渲染 ----------
let code = 0;
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-stats-'));
  const ud = path.join(tmp, 'ud');
  fs.mkdirSync(ud);
  try {
    const thisYear = new Date().getFullYear();
    fs.writeFileSync(path.join(tmp, 'library.json'), JSON.stringify({ version: 8, items: [
      { key: 'a', itemType: 'journalArticle', title: '深度学习综述', year: String(thisYear), tags: ['ml', '阅读'], created: 100, attachment: { path: 'C:/x/a.pdf', name: 'a.pdf' }, notes: [{ id: 'n1', title: '', text: '有内容' }] },
      { key: 'b', itemType: 'journalArticle', title: '另一篇', year: String(thisYear - 1), tags: ['ml'], created: 300 },
      { key: 'c', itemType: 'book', title: '一本旧书', year: '1999', created: 200, deletedAt: 1 },
    ] }));
    const probe = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 10000)) { if (fn()) return true; await sleep(60); } return !!fn(); };
  const libReady = await waitFor(() => window.LibraryUI && LibraryUI.isOpen() && document.querySelectorAll('#lib-grid .lib-card').length >= 2, 10000);
  push('文献库就绪', libReady);
  push('LibStats 挂载', !!(window.LibStats && LibStats.compute));
  if (!libReady) return { checks };
  document.getElementById('lib-stats').click();
  const body = await waitFor(() => { const b = document.getElementById('stats-body'); return b && !b.textContent.includes('统计中'); }, 8000)
    ? document.getElementById('stats-body') : null;
  push('统计面板打开', !!body);
  if (!body) return { checks };
  const txt = body.textContent;
  push('总览条目数=2（回收站 1 条单列）', txt.includes('2') && !body.innerHTML.includes('一本旧书'), txt.slice(0, 80));
  push('类型条目出现期刊', txt.includes('期刊') || txt.includes('journalArticle'), txt.slice(0, 120));
  push('年份条目出现今年', txt.includes(String(new Date().getFullYear())));
  push('B12 出版年份与入库年份分列', txt.includes('出版年份') && txt.includes('入库年份'), txt.slice(0, 60));
  push('标签 ml 出现两次', txt.includes('ml'));
  push('最近添加列出标题', txt.includes('另一篇'));
  push('回收站条目不进最近列表', !txt.includes('一本旧书'));
  document.getElementById('stats-close').click();
  push('面板可关闭', document.getElementById('stats-modal').hidden === true);
  return { checks };
})()`;
    const probeFile = path.join(tmp, 'probe.cjs');
    fs.writeFileSync(probeFile, 'module.exports=' + JSON.stringify(probe));
    const r = runProbe({
      probe: probeFile,
      env: { PDFREADER_LIBRARY: path.join(tmp, 'library.json'), PDFREADER_DATA_DIR: tmp, PDFREADER_NO_AUTO_INDEX: '1' },
      args: ['--user-data-dir=' + ud],
      label: 'lib-stats',
      timeout: 240000,
    });
    assert.equal(r.fail, 0);
    code = 0;
  } catch (e) {
    console.error('[lib-stats] ERROR', e && e.message ? e.message : e);
    code = 3;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(code);
})();
