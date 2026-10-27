'use strict';
/*
 * 阅读时长统计回归：
 *   Node 侧：readingstats.js——addSpan 累加、非法心跳忽略、merge 相加、aggregate
 *            分桶 / Top 文档 / 活跃天数、fmtDuration、normalize 剔除非法值。
 *   Electron 侧：真实文档 + 测试钩子（_readingAddForTest 记秒落盘）——磁盘统计正确、
 *            统计面板出现「阅读时长」区与热力图格子、跨重启（第二次启动）数据还在。
 * 运行：node scripts/test-reading-time.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const RS = require('../src/readingstats.js');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { runProbe } = require('./probe-runner');

// ---------- A. Node 纯逻辑 ----------
(function nodePart() {
  let st = RS.empty();
  st = RS.addSpan(st, '2026-10-27T10:00:00', 'C:/a.pdf', 60);
  st = RS.addSpan(st, '2026-10-27T10:01:00', 'C:/a.pdf', 120);
  st = RS.addSpan(st, '2026-10-26T22:00:00', 'C:/b.pdf', 30);
  assert.equal(st.days['2026-10-27']['C:/a.pdf'], 180, '同天同文档累加');
  assert.equal(st.days['2026-10-26']['C:/b.pdf'], 30, '跨天分桶');
  // 非法心跳
  st = RS.addSpan(st, '2026-10-27T10:02:00', '', 100);
  st = RS.addSpan(st, '2026-10-27T10:02:00', 'C:/a.pdf', -5);
  st = RS.addSpan(st, '2026-10-27T10:02:00', 'C:/a.pdf', 0);
  assert.equal(st.days['2026-10-27']['C:/a.pdf'], 180, '空路径 / 负数 / 零忽略');
  // 上限：单次最大 1 小时
  st = RS.addSpan(st, '2026-10-27T11:00:00', 'C:/c.pdf', 99999);
  assert.equal(st.days['2026-10-27']['C:/c.pdf'], 3600, '单次上限 1 小时');
  // merge 相加
  const merged = RS.merge(st, RS.addSpan(RS.empty(), '2026-10-27T12:00:00', 'C:/a.pdf', 20));
  assert.equal(merged.days['2026-10-27']['C:/a.pdf'], 200, 'merge 相加');
  // aggregate
  const agg = RS.aggregate(st, { today: '2026-10-27', nDays: 7 });
  assert.equal(agg.totalSeconds, 180 + 30 + 3600, '总计');
  assert.equal(agg.activeDays, 2, '活跃天数');
  assert.equal(agg.byDoc[0].path, 'C:/c.pdf', 'Top 文档排序');
  assert.equal(agg.byDay.length, 7, '7 天序列');
  // normalize 剔除非法
  const n = RS.normalize({ days: { '2026-01-01': { a: 10, b: -3, c: 'x' }, bad: 1, '2026-13-99': { d: 5 } } });
  assert.equal(n.days['2026-01-01'].a, 10, 'normalize 保留合法');
  assert.ok(!('b' in (n.days['2026-01-01'] || {})), '负数剔除');
  assert.ok(!('c' in (n.days['2026-01-01'] || {})), '非数字剔除');
  assert.ok(!('2026-13-99' in n.days), '非法日期键剔除');
  assert.equal(RS.fmtDuration(3725), '1 小时 2 分', '时长格式化');
  console.log('[reading-time-node] PASS');
})();

// ---------- B. Electron 端到端 ----------
let code = 0;
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-rt-'));
  const ud = path.join(tmp, 'ud');
  fs.mkdirSync(ud, { recursive: true });
  try {
    const pdf = path.join(tmp, 'reading.pdf');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const p = doc.addPage([612, 792]);
    p.drawText('Reading time fixture', { x: 60, y: 700, size: 18, font });
    fs.writeFileSync(pdf, await doc.save());

    const probe = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 10000)) { if (await fn()) return true; await sleep(60); } return !!(await fn()); };
  const loaded = await waitFor(() => App.state.pdfDoc && App.state.rendered.get(1), 25000);
  push('PDF 已打开', loaded);
  push('ReadingStats 挂载', !!(window.ReadingStats && ReadingStats.aggregate));
  if (!loaded) return { checks };
  // 测试钩子：给当前文档记 60s + 120s，各自动落盘
  const r1 = await App._readingAddForTest(60);
  const r2 = await App._readingAddForTest(120);
  push('落盘成功', r1.ok && r2.ok);
  const path = r2.stats && Object.keys(r2.stats.days || {}).length ? Object.values(r2.stats.days)[0] : null;
  const secs = path ? Object.values(path)[0] : 0;
  push('磁盘累计 180 秒', secs === 180, JSON.stringify(r2.stats || {}).slice(0, 120));
  // 统计面板
  await LibraryUI.show();
  await waitFor(() => document.querySelectorAll('#lib-grid .lib-card').length >= 1, 8000);
  document.getElementById('lib-stats').click();
  const body = await waitFor(() => { const b = document.getElementById('stats-body'); return b && b.textContent.includes('阅读时长'); }, 8000)
    ? document.getElementById('stats-body') : null;
  push('面板出现阅读时长区', !!body);
  push('热力图有格子', document.querySelectorAll('#stats-body .rs-cell').length === 84);
  push('累计时长显示 3 分钟', body && body.textContent.includes('3 分钟'), body && body.textContent.slice(0, 200));
  push('Top 文档列出文件名', body && body.textContent.includes('reading.pdf'));
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
      label: 'reading-time-first',
      timeout: 240000,
    });
    assert.equal(r.fail, 0);

    // 跨重启：同一 userData 再启动，统计还在（通过面板核对）
    const probe2 = `(async () => {
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 10000)) { if (await fn()) return true; await sleep(60); } return !!(await fn()); };
  const loaded = await waitFor(() => window.LibraryUI && LibraryUI.isOpen(), 10000);
  push('启动就绪', loaded);
  if (!loaded) return { checks };
  await LibraryUI.refresh();
  document.getElementById('lib-stats').click();
  const ok = await waitFor(() => { const b = document.getElementById('stats-body'); return b && b.textContent.includes('阅读时长'); }, 8000);
  push('跨重启统计还在', ok && document.getElementById('stats-body').textContent.includes('3 分钟'));
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
      },
      args: ['--user-data-dir=' + ud],
      label: 'reading-time-second',
      timeout: 240000,
    });
    assert.equal(r2.fail, 0);
    code = 0;
  } catch (e) {
    console.error('[reading-time] ERROR', e && e.message ? e.message : e);
    code = 3;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(code);
})();
