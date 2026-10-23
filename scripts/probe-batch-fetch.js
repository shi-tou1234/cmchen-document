'use strict';
/*
 * 批量抓取 + 网页快照探针（不碰外网）：本地 HTTP 服务提供 PDF / HTML。
 * 被 test-batch-fetch.js 调用。
 */
module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 8000)) { if (fn()) return true; await sleep(80); } return !!fn(); };

  try {
    // ---- UI 入口 ----
    push('批量条有「抓 PDF」按钮', !!$('#lib-bulk-fetch'), $('#lib-bulk-fetch') ? $('#lib-bulk-fetch').textContent : '');
    push('详情里有「网页快照」按钮', !!$('#ld-snapshot'));
    push('详情里有「打开快照」按钮', !!$('#ld-snapshot-open'));

    // ---- 批量抓取 ----
    const keys = __KEYS__;
    const events = [];
    let off = null;
    if (pdfBridge.lib.onFetchPdfProgress) off = pdfBridge.lib.onFetchPdfProgress((p) => events.push(p));
    const r = await pdfBridge.lib.fetchPdfBatch(keys);
    // Progress events and invoke replies travel on separate IPC deliveries.
    await waitFor(() => events.length === (r && r.done), 4000);
    if (off) off();

    push('批量抓取返回 ok', r && r.ok, r && r.error);
    push('成功 1 条', !!r && r.fetched === 1, r && r.fetched);
    push('失败 1 条', !!r && r.failed === 1, r && r.failed);
    push('跳过 2 条（无来源 / 已有附件）', !!r && r.skipped === 2, r && r.skipped);
    push('进度事件按条目回传', events.length === 4, events.length);
    push('最后一条进度 done=total', events.length > 0 && events[events.length - 1].done === 4,
      events.length ? JSON.stringify(events[events.length - 1]) : '无事件');

    const sum = await pdfBridge.lib.summary();
    const a = (sum.items || []).find((x) => x.key === 'BATCHA0001');
    push('抓取成功的条目挂上了附件', !!(a && a.attachment && a.hasFile), JSON.stringify(a && a.attachment));
    const d = (sum.items || []).find((x) => x.key === 'BATCHD0004');
    push('已有附件的条目没被覆盖', !!(d && d.attachment && /sample/i.test(d.attachment.name)), JSON.stringify(d && d.attachment));

    // ---- 网页快照 ----
    const s = await pdfBridge.lib.snapshotPage('BATCHA0001', '__PAGE_URL__/page');
    push('网页快照返回 ok', s && s.ok, s && s.error);
    const sum2 = await pdfBridge.lib.summary();
    const a2 = (sum2.items || []).find((x) => x.key === 'BATCHA0001');
    push('条目记录了快照', !!(a2 && a2.snapshot && a2.snapshot.path), JSON.stringify(a2 && a2.snapshot));
    push('快照文件落在磁盘上', !!(a2 && a2.snapshot && a2.snapshot.hasFile));
    push('快照首屏截图也存了', !!(a2 && a2.snapshot && a2.snapshot.png));
    push('快照记住了来源网址', !!(a2 && a2.snapshot && a2.snapshot.url && a2.snapshot.url.indexOf('/page') >= 0),
      a2 && a2.snapshot && a2.snapshot.url);

    const bad = await pdfBridge.lib.snapshotPage('BATCHC0003', '');
    push('没有网址时快照给出错误', !!(bad && !bad.ok && /网址|URL/.test(bad.error || '')), JSON.stringify(bad));
    const noSnap = await pdfBridge.lib.openSnapshot('NO_SUCH_KEY');
    push('打开不存在的快照给出错误', !!(noSnap && !noSnap.ok), JSON.stringify(noSnap));

    // ---- 有快照时详情里能打开 ----
    if (window.LibraryUI && LibraryUI.refresh) await LibraryUI.refresh();
    const card = $('#lib-grid .lib-card[data-key="BATCHA0001"]');
    if (card) card.click();
    await waitFor(() => $('#lib-detail') && !$('#lib-detail').hidden, 4000);
    await sleep(200);
    const openBtn = $('#ld-snapshot-open');
    push('有快照时详情显示「打开快照」', !!(openBtn && !openBtn.hidden), openBtn ? String(openBtn.hidden) : '没有按钮');

    return { checks };
  } catch (e) {
    return { checks, fatal: String((e && e.stack) || e) };
  }
})()`;
