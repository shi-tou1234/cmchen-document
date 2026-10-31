'use strict';
/*
 * Overview（手动挑候选）探针：被 test-overview.js 调用。
 *
 * 验的是「机器不确定的时候，入口真的能接住」这条链：
 *   1. 入口能打开、显示当前那条参考文献；
 *   2. 候选按把握排序，第一名是确实最像的那篇（跨 IPC + 真库，不是单测里的假数据）；
 *   3. 完全无关的条目不占候选位（兜住 rankCandidates 的地板）；
 *   4. 当前在读的那篇不出现在候选里（在自己的 PDF 里盯着 [12] 时不需要再跳一次）；
 *   5. 手动搜索全库能绕开排名找到任意一篇（这条才让「有时不猜」不会变成死路）；
 *   6. Esc 能关；7. portal-pick 能补出路径与起始页。
 * 注意：这里没有真的打开 PDF，所以「打开对开栏」只能验到 IPC 返回正确为止。
 */
module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 9000)) { if (fn()) return true; await sleep(80); } return !!fn(); };
  const errs = [];
  window.addEventListener('error', (e) => errs.push(String(e.message || e.error)));
  const rowsIn = (box) => Array.from((box || document).querySelectorAll('.ov-item'));
  const candRows = () => rowsIn().filter((x) => x.hasAttribute('data-ov-cand'));
  const key_close = () => { try { const b = $('#overview-x'); if (b) b.click(); } catch (_) {} };
  let stage = 'load';
  try {

  // ===== 1. 入口 =====
  stage = 'open';
  push('Overview 模块已挂到 window', !!window.App && typeof App.openOverview === 'function');
  const entry = 'M. Zhang, "Reading interfaces for scholars," Digital Scholarship, 2021, pp. 33-51.';
  window.App.openOverview(entry);
  await waitFor(() => $('#overview-picker') && !$('#overview-picker').hidden, 9000);
  push('入口能打开弹窗', !$('#overview-picker').hidden);
  push('弹窗里显示了当前这条参考文献', ($('#overview-entry') || {}).textContent.indexOf('Reading interfaces') >= 0,
    ($('#overview-entry') || {}).textContent);

  // ===== 2. 候选排序（跨主进程 IPC） =====
  stage = 'candidates';
  await waitFor(() => candRows().length > 0, 9000);
  const rows = candRows();
  push('列出了候选', rows.length > 0, rows.length);
  push('第一名是最像的那篇', rows.length > 0 && rows[0].getAttribute('data-ov-key') === 'k2',
    rows.map((r) => r.getAttribute('data-ov-key')).join(','));
  const scoreTxt = rows.length ? ((rows[0].querySelector('.ov-score') || {}).textContent || '') : '';
  push('候选带上把握百分比', /\\d+%/.test(scoreTxt), scoreTxt);
  push('把握在合理范围', parseInt(scoreTxt, 10) >= 80, scoreTxt);
  const keys = rows.map((r) => r.getAttribute('data-ov-key'));
  push('完全无关的条目没进候选', keys.indexOf('k3') < 0, keys.join(','));
  push('全库列表另行列出（不混在候选里）', rowsIn().length > rows.length,
    rowsIn().length + '/' + rows.length);

  // ===== 3. 当前在读的那篇不该出现在候选里 =====
  // 路径从库列表里取，不注入常量：探针源码是模板字符串，注入路径会被转义吃掉反斜杠。
  stage = 'self-exclude';
  const libAll = await window.pdfBridge.lib.pdfList();
  const curItem = (libAll.items || []).find((x) => x.key === 'kcur');
  window.App.state.filePath = curItem ? curItem.path : '';
  window.App.openOverview(entry);
  await waitFor(() => candRows().length > 0, 9000);
  const allKeys = rowsIn().map((r) => r.getAttribute('data-ov-key'));
  push('当前在读的那篇被排除（候选与全库列表都不出现）', allKeys.indexOf('kcur') < 0, allKeys.join(','));
  push('排除自己之后候选仍然有效', candRows().length > 0, candRows().length);
  window.App.state.filePath = '';

  // ===== 4. 手动搜索能绕开排名 =====
  stage = 'search';
  const q = $('#overview-q');
  q.value = 'cast';
  q.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(150);
  const found = rowsIn();
  push('手动搜索能翻出本来没排上的篇目',
    found.length > 0 && found[0].getAttribute('data-ov-key') === 'k3',
    found.map((x) => x.getAttribute('data-ov-key')).join(','));
  q.value = '';
  q.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(150);
  push('清空搜索后回到候选视图', candRows().length > 0, rowsIn().length);

  // ===== 5. Esc 关闭（焦点在弹窗里也要能关） =====
  stage = 'escape';
  q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await waitFor(() => $('#overview-picker').hidden, 6000);
  push('Esc 能关掉弹窗', $('#overview-picker').hidden);

  // ===== 6. 对不上时也不是死路 =====
  stage = 'fallback';
  window.App.openOverview('zzz 完全对不上的一段文字 zzz');
  await waitFor(() => candRows().length === 0 && rowsIn().length > 0, 9000);
  push('机器没把握时，全库列表仍然可用', rowsIn().length > 0, rowsIn().length);
  push('没有出现读失败的横幅', ($('#overview-list') || {}).innerHTML.indexOf('读取失败') < 0);
  key_close();

  // ===== 7. portal-pick 补出路径与起始页 =====
  stage = 'pick';
  const pick = await window.pdfBridge.portalPick({ key: 'k2' });
  push('portal-pick 能命中', !!(pick && pick.ok && pick.path), JSON.stringify(pick).slice(0, 140));
  push('起始页有值（没索引也不为 0）', !!(pick && pick.page >= 1), pick && pick.page);
  const bad = await window.pdfBridge.portalPick({ key: 'nope' });
  push('不存在的 key 给出失败而不是异常', !!(bad && bad.ok === false), JSON.stringify(bad).slice(0, 100));

  // 点一篇：这里没有真的 PDF 可打开，只能验「流程走完、没有卡住」
  window.App.openOverview(entry);
  await waitFor(() => candRows().length > 0, 9000);
  const target = candRows()[0];
  const targetKey = target.getAttribute('data-ov-key');
  target.click();
  await waitFor(() => $('#overview-picker').hidden, 8000);
  push('选中后弹窗关闭', $('#overview-picker').hidden);
  push('选的是排第一的那篇', targetKey === 'k2', targetKey);

  stage = 'errors';
  push('全程无脚本错误', errs.length === 0, errs.join(' | '));
  return { checks };
  } catch (e) {
    return { checks, fatal: stage + ': ' + ((e && e.message) || e) };
  }
})()`;
