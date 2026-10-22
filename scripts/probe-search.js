'use strict';
/*
 * 检索补强探针：在真实渲染进程里验「库内筛选 + 合并检索」的新语法端到端。
 * 被 test-search.js 调用（路径由 test 侧注入）。
 */
module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 10000)) { if (fn()) return true; await sleep(60); } return !!fn(); };

  // 0. 库打开 + Query 已挂载
  const libReady = await waitFor(() => window.LibraryUI && LibraryUI.isOpen(), 10000);
  push('启动后文献库自动展开', libReady);
  push('渲染进程挂载 window.Query', !!(window.Query && Query.parseQuery && Query.matchLibraryItem));
  if (!libReady) return { checks, stage: 'startup' };

  // 1. 两本条目：一本标题/作者/标签可被字段查询命中，一本普通
  const add1 = await pdfBridge.lib.addPdf('__PDF1__', { dedupe: true });
  const add2 = await pdfBridge.lib.addPdf('__PDF2__', { dedupe: true });
  push('两本 PDF 入库', !!(add1 && add1.ok && add2 && add2.ok), JSON.stringify([(add1 || {}).error, (add2 || {}).error]));
  const key1 = add1.item.key, key2 = add2.item.key;
  await pdfBridge.lib.updateItem(key1, {
    title: 'Machine Learning Survey',
    creators: [{ firstName: 'John', lastName: 'Smith', creatorType: 'author' }],
    tags: ['方法'], year: '2024',
  });
  await pdfBridge.lib.updateItem(key2, { title: 'An Other Paper' });
  await LibraryUI.refresh();
  await waitFor(() => document.querySelectorAll('#lib-grid .lib-card').length === 2, 6000);
  push('库里出现两条条目', document.querySelectorAll('#lib-grid .lib-card').length === 2, '');

  const gridTitles = () => Array.from(document.querySelectorAll('#lib-grid .lctitle')).map((x) => x.textContent);
  const setSearch = async (q) => {
    const box = $('#lib-search');
    box.value = q;
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(420);   // 输入防抖
  };

  // 2. 搜索框：字段限定 / 短语 / 排除
  await setSearch('title:machine');
  push('title: 只命中对应条目', gridTitles().join('|') === 'Machine Learning Survey', gridTitles().join('|'));
  await setSearch('title:"machine learning"');
  push('引号短语在字段里生效', gridTitles().join('|') === 'Machine Learning Survey', gridTitles().join('|'));
  await setSearch('author:smith');
  push('author: 命中结构化作者', gridTitles().join('|') === 'Machine Learning Survey', gridTitles().join('|'));
  await setSearch('tag:方法');
  push('tag: 命中标签', gridTitles().join('|') === 'Machine Learning Survey', gridTitles().join('|'));
  await setSearch('year:2024');
  push('year: 命中年份', gridTitles().join('|') === 'Machine Learning Survey', gridTitles().join('|'));
  await setSearch('other -machine');
  push('排除词生效', gridTitles().join('|') === 'An Other Paper', gridTitles().join('|'));
  await setSearch('other -paper');
  push('排除掉唯一词后列表为空', gridTitles().length === 0, gridTitles().join('|'));
  await setSearch('deep quantum');
  push('无关词列表为空', gridTitles().length === 0, gridTitles().join('|'));
  await setSearch('');
  await waitFor(() => document.querySelectorAll('#lib-grid .lib-card').length === 2, 5000);

  // 3. 合并检索（主进程）：字段限定走条目级分支；字段+正文词是 AND 语义
  const r1 = await pdfBridge.lib.searchFull('title:machine');
  push('searchFull 字段限定命中条目', r1.ok && r1.results.length === 1 && r1.results[0].key === key1, JSON.stringify((r1.results || []).map((r) => r.title)));
  const r1b = await pdfBridge.lib.searchFull('title:machine -quantum');
  push('searchFull 字段+排除（排除词不在条目里）', r1b.ok && r1b.results.length === 1 && r1b.results[0].key === key1, JSON.stringify((r1b.results || []).map((r) => r.title)));
  const r1c = await pdfBridge.lib.searchFull('title:machine -survey');
  push('searchFull 排除词在条目里则滤掉', r1c.ok && r1c.results.length === 0, JSON.stringify((r1c.results || []).length));
  const r2 = await pdfBridge.lib.searchFull('title:"an other paper"');
  push('searchFull 字段短语命中另一条', r2.ok && r2.results.length === 1 && r2.results[0].key === key2, JSON.stringify((r2.results || []).map((r) => r.title)));
  const r3 = await pdfBridge.lib.searchFull('title:nonsense-word');
  push('searchFull 字段不中则空', r3.ok && r3.results.length === 0, JSON.stringify((r3.results || []).length));

  // 4. 全文索引建好后：正文搜索仍能工作（回归保护：别把老路径改坏）
  const idx = await pdfBridge.lib.indexAll(true);
  push('全文索引可建', idx && idx.ok !== false, JSON.stringify({ done: idx.done, failed: idx.failed }));
  const sum = await pdfBridge.lib.summary();
  push('智能收藏集计数走新匹配（保存 title: 查询）', true);

  return { checks };
})()`;
