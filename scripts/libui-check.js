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
  await sleep(220);   // 搜索框做了 90ms 去抖（打字时不再每键重画整张表）
  push('搜索摘要命中', cards() === 1 && firstTitle() === 'Alpha', 'cards=' + cards());
  setInput('#lib-search', 'diffusion');
  await sleep(220);
  push('搜索笔记命中', cards() === 1 && firstTitle() === 'Beta', 'cards=' + cards());
  setInput('#lib-search', '10.1/x');
  await sleep(220);
  push('搜索 DOI 命中', cards() === 1 && firstTitle() === 'Alpha', 'cards=' + cards());
  setInput('#lib-search', '');
  await sleep(220);
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

  // 编辑 + 标签草稿 + 多收藏集 + 阅读笔记，一起保存
  $('#ld-title').value = 'Alpha 改';
  $('#ld-abstract').value = '改过的摘要';
  // v23：笔记改成多条，先新建一条写点内容（失焦自动保存）
  $('#ld-note-add').click();
  await sleep(300);
  const nb = document.querySelector('#ld-notes .ld-note-text');
  if (nb) {
    nb.value = '未保存的笔记';
    nb.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(250);
  }
  push('能新建一条阅读笔记', !!(nb && nb.value), nb ? nb.value : 'null');
  $('#ld-tag-input').value = '新标签';
  $('#ld-tag-add').click();
  await sleep(60);
  const nb2 = document.querySelector('#ld-notes .ld-note-text');
  push('加标签不冲掉未保存的笔记草稿', !!nb2 && nb2.value === '未保存的笔记', nb2 ? nb2.value : 'null');
  const col2 = $('#ld-colls input[value="col2"]'); col2.checked = true;
  $('#ld-save').click();
  await waitFor(() => firstTitle() === 'Alpha 改' || $$('#lib-grid .lib-card .lctitle').some((x) => x.textContent.trim() === 'Alpha 改'), 4000);
  const sum1 = await pdfBridge.lib.summary();
  const a1 = sum1.items.find((x) => x.key === 'itA');
  push('保存后卡片标题更新', $$('#lib-grid .lib-card .lctitle').some((x) => x.textContent.trim() === 'Alpha 改'));
  push('保存写入摘要/笔记', a1.abstract === '改过的摘要' && a1.note === '未保存的笔记', a1.note);
  push('条目挂了独立笔记', Array.isArray(a1.notes) && a1.notes.length === 1 && a1.notes[0].text === '未保存的笔记',
    JSON.stringify(a1.notes));
  push('保存写入新标签', a1.tags.indexOf('新标签') >= 0, JSON.stringify(a1.tags));
  push('保存写入多收藏集', a1.collectionIds.length === 2 && a1.collectionIds.indexOf('col1') >= 0 && a1.collectionIds.indexOf('col2') >= 0,
    JSON.stringify(a1.collectionIds));
  push('卡片收藏集 chip 变 2 个', $$('[data-key="itA"] .lccoll').length === 2);

  // v6：作者结构化 —— 详情面板按「姓 / 名 / 角色」分行编辑
  const crRows = $$('#ld-creators .ld-cr');
  push('作者渲染成结构化行', crRows.length === 1, 'rows=' + crRows.length);
  const crLast = crRows[0] && crRows[0].querySelector('.ld-cr-last');
  const crFirst = crRows[0] && crRows[0].querySelector('.ld-cr-first');
  const crType = crRows[0] && crRows[0].querySelector('.ld-cr-type');
  push('作者行有姓 / 名 / 角色三格', !!(crLast && crFirst && crType), crLast ? 'ok' : 'missing');
  push('旧库的作者已拆出姓', crLast && crLast.value === '张三' && crFirst && crFirst.value === '',
    (crLast ? crLast.value : '') + '/' + (crFirst ? crFirst.value : ''));
  // 加一位作者：填姓 / 名 / 角色
  $('#ld-creator-add').click();
  await sleep(80);
  const newRow = $$('#ld-creators .ld-cr')[1];
  if (newRow) {
    const l = newRow.querySelector('.ld-cr-last');
    const f = newRow.querySelector('.ld-cr-first');
    l.value = 'Brown';
    f.value = 'John';
    newRow.querySelector('.ld-cr-type').value = 'author';
    // 模拟真人在打字：引用预览靠 input 事件刷新
    l.dispatchEvent(new Event('input', { bubbles: true }));
    f.dispatchEvent(new Event('input', { bubbles: true }));
  }
  await sleep(80);
  const citeNow = ($('#ld-cite-preview') || {}).textContent || '';
  push('引用预览用结构化姓名', citeNow.indexOf('BROWN J') > 0, citeNow.slice(0, 80));
  $('#ld-save').click();
  await sleep(400);
  const sumCr = await pdfBridge.lib.summary();
  const aCr = sumCr.items.find((x) => x.key === 'itA');
  push('保存后作者是结构化对象', !!(aCr.creators && aCr.creators.length === 2
    && aCr.creators[0].lastName === '张三' && aCr.creators[1].lastName === 'Brown'
    && aCr.creators[1].firstName === 'John' && aCr.creators[1].creatorType === 'author'),
    JSON.stringify(aCr.creators));

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

  // ---------- v27：citekey / 表头排序 / 颜色 / 相关条目 / 右键菜单 ----------
  let step = 'start';
  try {
  step = 'detail';
  $('[data-scope="all"]').click();
  await waitFor(() => cards() === 2, 3000);
  $('[data-detail="itA"]').click();
  await sleep(80);
  const ck = ($('#ld-citekey') || {}).textContent || '';
  push('详情显示确定性 citekey', /^[a-z0-9-]+$/.test(ck.trim()), ck);
  push('citekey 复制按钮可用', !$('#ld-citekey-at').disabled);

  step = 'sort';
  $('[data-scope="all"]').click();
  await waitFor(() => cards() === 2, 3000);
  $('.lib-sort-h[data-sort="title"]').click();
  await sleep(60);
  push('表头点击按标题升序', firstTitle().startsWith('Alpha'), firstTitle());
  $('.lib-sort-h[data-sort="title"]').click();
  await sleep(60);
  push('表头再次点击切降序', firstTitle() === 'Beta', firstTitle());
  setSelect('#lib-sort', 'added');
  await sleep(60);

  // 标签颜色
  step = 'tag-color';
  $('[data-tag-color="ML"]').click();
  await sleep(40);
  const pop = $('.lib-color-pop');
  push('标签颜色浮层打开', !!pop);
  if (pop) pop.querySelector('[data-color="#5f7d4f"]').click();
  await sleep(220);
  const sumTag = await pdfBridge.lib.summary();
  push('标签颜色写入数据层', !!(sumTag.tagColors && sumTag.tagColors.ML === '#5f7d4f'), JSON.stringify(sumTag.tagColors));

  // 收藏集颜色
  step = 'coll-color';
  $('[data-coll-color="col1"]').click();
  await sleep(40);
  const pop2 = $('.lib-color-pop');
  if (pop2) pop2.querySelector('[data-color="#3f7a8a"]').click();
  await sleep(220);
  const sumColl2 = await pdfBridge.lib.summary();
  push('收藏集颜色写入数据层', ((sumColl2.collections.find((c) => c.id === 'col1') || {}).color) === '#3f7a8a');

  // 相关条目
  step = 'relation';
  $('[data-detail="itA"]').click();
  await sleep(80);
  const relSel = $('#ld-rel-select');
  relSel.value = 'itB';
  relSel.dispatchEvent(new Event('change', { bubbles: true }));
  $('#ld-rel-add').click();
  await sleep(280);
  push('相关条目添加成功', $$('#ld-relations .ld-rel').length === 1, 'rows=' + $$('#ld-relations .ld-rel').length);
  const relDel = $('#ld-relations [data-rel-remove]');
  if (relDel) relDel.click();
  await sleep(280);
  push('相关条目可解除', $$('#ld-relations .ld-rel').length === 0);

  // 右键菜单
  step = 'context';
  const menuCard = $('[data-key="itA"]');
  menuCard.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 200 }));
  await sleep(60);
  push('卡片右键菜单打开', !!$('.lib-ctx'), '');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(40);
  } catch (e) {
    push('v27 交互块未抛错', false, step + ': ' + (e && e.message ? e.message : e));
  }

  // ---------- 参考文献表 ----------
  step = 'bib';
  try {
    $('[data-scope="all"]').click();
    await waitFor(() => cards() === 2, 3000);
    $('#lib-bib').click();
    await waitFor(() => !document.getElementById('bib-modal').hidden, 3000);
    push('参考文献弹层打开', !document.getElementById('bib-modal').hidden);
    push('样式下拉有 5 种', $$('#bib-style option').length === 5, 'options=' + $$('#bib-style option').length);
    const bibText = $('#bib-preview').value;
    push('默认按当前列表生成两条（GB/T）', bibText.indexOf('## 参考文献') === 0 && bibText.indexOf('[1] ') > 0 &&
      bibText.indexOf('Beta') > 0 && bibText.indexOf('Alpha') > 0, bibText.slice(0, 120));
    push('计数显示 2 条', /2 条/.test(($('#bib-count') || {}).textContent || ''), ($('#bib-count') || {}).textContent);

    setSelect('#bib-style', 'apa');
    await sleep(60);
    const apaText = $('#bib-preview').value;
    push('APA 改为作者字母序（李四在张三前）', apaText.indexOf('Beta') < apaText.indexOf('Alpha 改'),
      apaText.slice(0, 90));

    setSelect('#bib-format', 'text');
    await sleep(40);
    push('纯文本格式不带 Markdown 标题', $('#bib-preview').value.indexOf('## ') < 0, $('#bib-preview').value.slice(0, 40));

    $('#bib-keys').checked = true;
    $('#bib-keys').dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(40);
    push('可选附引用键 [@key]', $('#bib-preview').value.indexOf('[@') > 0, $('#bib-preview').value.slice(-80));

    $('#bib-close').click();
    await sleep(40);
    push('参考文献弹层可关闭', document.getElementById('bib-modal').hidden);

    const cbA = $('[data-select-key="itA"]');
    cbA.click();
    await sleep(60);
    $('#lib-bulk-bib').click();
    await waitFor(() => !document.getElementById('bib-modal').hidden, 3000);
    const selText = $('#bib-preview').value;
    push('批量栏入口按选中条目生成（只 1 条）', /1 条/.test(($('#bib-count') || {}).textContent || '') &&
      selText.indexOf('Alpha 改') > 0 && selText.indexOf('Beta') < 0, selText.slice(0, 80));
    push('范围下拉显示已选数量', /已选条目（1）/.test(($('#bib-scope option[value="selected"]') || {}).textContent || ''),
      ($('#bib-scope option[value="selected"]') || {}).textContent);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(40);
    push('Esc 关闭参考文献弹层', document.getElementById('bib-modal').hidden);
    $('#lib-bulk-clear').click();
    await sleep(40);
  } catch (e) {
    push('参考文献块未抛错', false, step + ': ' + (e && e.message ? e.message : e));
  }

  // 回到全部条目 → 点卡片进阅读（回归：覆盖层 → 阅读器钩子没被 v10 改坏）
  $('[data-scope="all"]').click();
  await waitFor(() => cards() === 2, 3000);
  push('回到全部条目可见 2 条', cards() === 2, 'cards=' + cards());
  const openCard = $('[data-open="itA"]');
  if (openCard) openCard.click();
  await sleep(150);
  push('单击卡片只选中不打开', !document.body.classList.contains('has-doc') && openCard.classList.contains('selected'));
  push('单击后详情面板打开', !document.getElementById('lib-detail').hidden);
  // Zotero 交互：双击才进阅读
  if (openCard) openCard.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  await waitFor(() => document.body.classList.contains('has-doc'), 8000);
  await waitFor(() => App.state.numPages === 3, 8000);
  await sleep(200);
  const post = {
    hasDoc: document.body.classList.contains('has-doc'),
    libraryHidden: document.getElementById('library').hidden,
    pageNums: App.state.numPages,
    canvas: !!document.querySelector('#pages .page canvas'),
  };
  push('双击卡片后进入阅读态', post.hasDoc);
  push('进阅读后覆盖层收起', post.libraryHidden);
  push('阅读器加载到 3 页', post.pageNums === 3, 'pages=' + post.pageNums);
  push('页面 canvas 已建', post.canvas);

  // 视图切换的过渡：点「文献库」后动画必须真的在跑。
  // 早先兜底逻辑误判"时间线停住"，把动画一步跳完 —— 效果就是完全没有过渡。
  const libEl = document.getElementById('library');
  const libTab = document.querySelector('#toolbar .mode-switch [data-mode="library"]');
  if (libTab) libTab.click();
  const anims = libEl.getAnimations ? libEl.getAnimations().length : 0;
  push('切到文献库时过渡动画在跑', anims > 0, 'anims=' + anims);
  push('切到文献库后覆盖层可见', !libEl.hidden, '');
  await sleep(400);
  push('过渡结束后覆盖层完全可见', getComputedStyle(libEl).opacity === '1', getComputedStyle(libEl).opacity);

  return { checks, pre, dPre, post };
})()`;
