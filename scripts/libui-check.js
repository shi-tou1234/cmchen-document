'use strict';
/*
 * 在真实渲染进程里执行的库界面探针（被主进程 executeJavaScript 调用）。
 * 前提：app 以 PDFREADER_LIBUI=1 启动，窗口隐藏，PDFREADER_LIBRARY 指向脚本种好的种子库
 * （3 条条目：2 条在库、1 条在回收站；2 个收藏集；含摘要/笔记/DOI 等 v2 字段）。
 * 返回 { checks:[[name,ok,detail],...], ... }，主进程据此打印并决定退出码。
 */
module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 4000)) { if (fn()) return true; await sleep(40); }
    return !!fn();
  };
  const firstTitle = () => ((($('#lib-grid .lib-card .lctitle') || {}).textContent) || '').trim();
  const cards = () => $$('#lib-grid .lib-card').length;
  const setInput = (sel, v) => { const e = $(sel); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); };
  const setSelect = (sel, v) => { const e = $(sel); e.value = v; e.dispatchEvent(new Event('change', { bubbles: true })); };

  // 等库覆盖层把卡片渲染出来（refresh 是异步 IPC）
  await waitFor(() => cards() > 0, 4000);

  const pre = {
    libraryVisible: !document.getElementById('library').hidden,
    cards: cards(),
    titles: $$('#lib-grid .lib-card .lctitle').map((x) => x.textContent.trim()),
    trashRowText: ($('[data-scope="trash"]') || {}).textContent || '',
    typeBadge: (($('[data-key="itA"] .lctype') || {}).textContent || '').trim(),
    progress: (($('[data-key="itA"] .lcprog') || {}).textContent || '').trim(),
    collChips: $$('[data-key="itB"] .lccoll').length,
    hasDoc: document.body.classList.contains('has-doc'),
  };
  push('库覆盖层启动即显示', pre.libraryVisible);
  push('默认只显示未删除条目（回收站 1 条不进列表）', pre.cards === 2, 'cards=' + pre.cards);
  push('回收站计数为 1', /1/.test(pre.trashRowText), pre.trashRowText.trim());
  push('默认按添加时间倒序（Beta 在前）', firstTitle() === 'Beta', firstTitle());
  push('卡片显示条目类型徽标', pre.typeBadge === '期刊文章', pre.typeBadge);
  push('卡片显示阅读进度', pre.progress === '第 12 页', pre.progress);
  push('卡片显示所属多个收藏集', pre.collChips === 2, 'chips=' + pre.collChips);
  push('非回收站范围隐藏“清空回收站”', getComputedStyle($('#lib-empty-trash')).display === 'none',
    getComputedStyle($('#lib-empty-trash')).display);

  // 搜索：摘要 / 笔记 / DOI 都应命中（v2 新增字段）
  setInput('#lib-search', 'transformer');
  await sleep(80);
  push('搜索摘要命中', cards() === 1 && firstTitle() === 'Alpha', 'cards=' + cards());
  setInput('#lib-search', 'diffusion');
  await sleep(80);
  push('搜索笔记命中', cards() === 1 && firstTitle() === 'Beta', 'cards=' + cards());
  setInput('#lib-search', '10.1/x');
  await sleep(80);
  push('搜索 DOI 命中', cards() === 1 && firstTitle() === 'Alpha', 'cards=' + cards());
  setInput('#lib-search', '');
  await sleep(80);
  push('清空搜索后恢复两条', cards() === 2);

  // 排序
  setSelect('#lib-sort', 'title');
  await sleep(80);
  push('按标题排序（Alpha 在前）', firstTitle() === 'Alpha', firstTitle());
  setSelect('#lib-sort', 'year');
  await sleep(80);
  push('按年份倒序（2022 的 Beta 在前）', firstTitle() === 'Beta', firstTitle());
  setSelect('#lib-sort', 'added');
  await sleep(80);
  push('切回添加时间排序', firstTitle() === 'Beta', firstTitle());

  // 选中收藏集后，新建入口应落到子级（v9 数据层支持 parentId，v10 补 UI 入口）
  $('[data-scope="coll"][data-id="col1"]').click();
  await sleep(60);
  push('选中集合后按钮变为新建子收藏集', /子收藏集/.test(($('#lib-new-coll') || {}).textContent || ''));
  $('#lib-new-coll').click();
  await sleep(60);
  const collInput = $('#lib-side input[placeholder="子收藏集名称"]');
  if (collInput) {
    collInput.value = '子集X';
    collInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }
  await waitFor(() => Array.from(document.querySelectorAll('[data-scope="coll"] .cname'))
    .some((x) => x.textContent === '子集X'), 4000);
  const sumColl = await pdfBridge.lib.summary();
  const childColl = sumColl.collections.find((c) => c.name === '子集X');
  push('能新建子收藏集并挂到当前集合下', !!childColl && childColl.parentId === 'col1', JSON.stringify(childColl));
  push('新建后按钮恢复（不会一次性消失）', !!$('#lib-new-coll') && !$('#lib-new-coll').hidden);
  $('[data-scope="all"]').click();
  await sleep(60);

  // 详情面板：字段回填 + 收藏集勾选
  $('[data-detail="itA"]').click();
  await waitFor(() => !document.getElementById('lib-detail').hidden && $('#ld-title').value !== '', 3000);
  const dPre = {
    visible: !document.getElementById('lib-detail').hidden,
    title: $('#ld-title').value,
    doi: $('#ld-doi').value,
    abstract: $('#ld-abstract').value,
    type: $('#ld-type').value,
    coll1: !!($('#ld-colls input[value="col1"]') || {}).checked,
    coll2: !!($('#ld-colls input[value="col2"]') || {}).checked,
    tagChip: !!$('#ld-tags .ld-tag'),
  };
  push('详情面板打开', dPre.visible);
  push('详情回填标题/DOI/摘要', dPre.title === 'Alpha' && dPre.doi === '10.1/x' && dPre.abstract.indexOf('transformer') >= 0,
    dPre.title + '|' + dPre.doi);
  push('详情回填条目类型', dPre.type === 'journalArticle', dPre.type);
  push('详情收藏集勾选与数据一致', dPre.coll1 && !dPre.coll2);
  push('详情显示标签 chip', dPre.tagChip);

  // 编辑 + 标签草稿 + 多收藏集，一起保存
  $('#ld-title').value = 'Alpha 改';
  $('#ld-abstract').value = '改过的摘要';
  $('#ld-note').value = '未保存的笔记';
  $('#ld-tag-input').value = '新标签';
  $('#ld-tag-add').click();
  await sleep(40);
  push('加标签不冲掉未保存的笔记草稿', $('#ld-note').value === '未保存的笔记', $('#ld-note').value);
  const col2 = $('#ld-colls input[value="col2"]'); col2.checked = true;
  $('#ld-save').click();
  await waitFor(() => firstTitle() === 'Alpha 改' || $$('#lib-grid .lib-card .lctitle').some((x) => x.textContent.trim() === 'Alpha 改'), 4000);
  const sum1 = await pdfBridge.lib.summary();
  const a1 = sum1.items.find((x) => x.key === 'itA');
  push('保存后卡片标题更新', $$('#lib-grid .lib-card .lctitle').some((x) => x.textContent.trim() === 'Alpha 改'));
  push('保存写入摘要/笔记', a1.abstract === '改过的摘要' && a1.note === '未保存的笔记');
  push('保存写入新标签', a1.tags.indexOf('新标签') >= 0, JSON.stringify(a1.tags));
  push('保存写入多收藏集', a1.collectionIds.length === 2 && a1.collectionIds.indexOf('col1') >= 0 && a1.collectionIds.indexOf('col2') >= 0,
    JSON.stringify(a1.collectionIds));
  push('卡片收藏集 chip 变 2 个', $$('[data-key="itA"] .lccoll').length === 2);

  // 回收站：卡片移入 → 列表消失；回收站里还原
  $('[data-trash="itB"]').click();
  await waitFor(() => cards() === 1, 4000);
  push('移入回收站后从列表消失', cards() === 1, 'cards=' + cards());
  const sum2 = await pdfBridge.lib.summary();
  push('回收站计数变 2', sum2.trashCount === 2, 'trash=' + sum2.trashCount);
  push('软删除不删磁盘索引（条目仍在）', !!sum2.items.find((x) => x.key === 'itB' && x.deletedAt > 0));

  $('[data-scope="trash"]').click();
  await waitFor(() => cards() === 2, 3000);
  push('回收站范围内显示两条', cards() === 2, 'cards=' + cards());
  const etBtn = $('#lib-empty-trash');
  push('回收站范围显示“清空回收站”', getComputedStyle(etBtn).display !== 'none',
    'display=' + getComputedStyle(etBtn).display + ' hidden=' + etBtn.hidden);
  $('[data-restore="itB"]').click();
  await waitFor(() => cards() === 1, 3000);
  push('还原后回收站只剩 1 条', cards() === 1, 'cards=' + cards());

  // 空回收站：两步确认，清完不删文件（文件层断言在 test-library.js）
  $('#lib-empty-trash').click();
  await sleep(40);
  const armedText = ($('#lib-empty-trash') || {}).textContent || '';
  $('#lib-empty-trash').click();
  await waitFor(() => cards() === 0, 3000);
  push('清空回收站需二次确认', armedText.indexOf('确认') >= 0, armedText);
  push('清空后回收站为空', cards() === 0, 'cards=' + cards());
  const sum3 = await pdfBridge.lib.summary();
  push('清空后 trashCount=0 且 itA/itB 仍在', sum3.trashCount === 0 && !!sum3.items.find((x) => x.key === 'itA') && !!sum3.items.find((x) => x.key === 'itB'));

  // 回到全部条目 → 点卡片进阅读（回归：覆盖层 → 阅读器钩子没被 v10 改坏）
  $('[data-scope="all"]').click();
  await waitFor(() => cards() === 2, 3000);
  push('回到全部条目可见 2 条', cards() === 2, 'cards=' + cards());
  const openCard = $('[data-open="itA"]');
  if (openCard) openCard.click();
  await waitFor(() => document.body.classList.contains('has-doc'), 8000);
  await waitFor(() => App.state.numPages === 3, 8000);
  await sleep(200);
  const post = {
    hasDoc: document.body.classList.contains('has-doc'),
    libraryHidden: document.getElementById('library').hidden,
    pageNums: App.state.numPages,
    canvas: !!document.querySelector('#pages .page canvas'),
  };
  push('点卡片后进入阅读态', post.hasDoc);
  push('进阅读后覆盖层收起', post.libraryHidden);
  push('阅读器加载到 3 页', post.pageNums === 3, 'pages=' + post.pageNums);
  push('页面 canvas 已建', post.canvas);

  return { checks, pre, dPre, post };
})()`;
