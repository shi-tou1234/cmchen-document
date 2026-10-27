'use strict';
/*
 * v35 多集合并集探针：Ctrl / Cmd + 点击收藏集，取并集；普通点击仍然只选一个。
 * 只看 DOM：卡片数量、标题、行高亮、每个收藏集自己的计数。
 */
module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 12000)) { if (fn()) return true; await sleep(80); } return !!fn(); };
  const cards = () => Array.from(document.querySelectorAll('#lib-grid .lib-card'));
  const titles = () => cards().map((c) => (c.querySelector('.lctitle') || {}).textContent || '');
  const scopeTitle = () => (document.getElementById('lib-scope-title') || {}).textContent || '';
  const collBtn = (name) => Array.from(document.querySelectorAll('#lib-collections .lib-coll'))
    .find((b) => (b.querySelector('.cname') || {}).textContent === name);
  const click = (el, ctrl) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: !!ctrl, metaKey: false }));
  const isActive = (el) => !!el && el.classList.contains('active');

  try {
    const ready = await waitFor(() => window.LibraryUI && LibraryUI.isOpen() && cards().length === 5, 15000);
    push('文献库加载 5 条条目', ready, cards().length);
    if (!ready) return { checks, stage: 'load' };

    const c1 = collBtn('论文');
    const c2 = collBtn('书');
    const c3 = collBtn('笔记');
    push('三个收藏集行都在', !!c1 && !!c2 && !!c3);
    push('收藏集行有并集提示', !!c1 && /多选收藏集/.test(c1.getAttribute('title') || ''), c1 && c1.getAttribute('title'));

    // 单选
    click(c1);
    await sleep(200);
    push('普通点击只选一个收藏集', cards().length === 2 && scopeTitle() === '论文', cards().length + ' / ' + scopeTitle());
    push('单选时只有该行高亮', isActive(collBtn('论文')) && !isActive(collBtn('书')));

    // Ctrl 点击第二个：并集
    click(collBtn('书'), true);
    await sleep(200);
    const unionTitles = titles();
    push('Ctrl 点击取并集（2 + 2 去重 = 3）', cards().length === 3, cards().length + ':' + unionTitles.join('|'));
    push('并集没有重复条目', new Set(unionTitles).size === unionTitles.length, unionTitles.join('|'));
    push('两行同时高亮', isActive(collBtn('论文')) && isActive(collBtn('书')));
    push('标题显示收藏集并集', /收藏集并集/.test(scopeTitle()) && /论文/.test(scopeTitle()) && /书/.test(scopeTitle()), scopeTitle());

    // 再加第三个
    click(collBtn('笔记'), true);
    await sleep(200);
    push('Ctrl 点击第三个继续并入', cards().length === 4, cards().length);
    push('三个收藏集都高亮', isActive(collBtn('论文')) && isActive(collBtn('书')) && isActive(collBtn('笔记')));

    // 再点一次取消
    click(collBtn('笔记'), true);
    await sleep(200);
    push('Ctrl 再点取消该收藏集', cards().length === 3 && !isActive(collBtn('笔记')), cards().length);
    push('取消后标题只剩两个', /论文/.test(scopeTitle()) && /书/.test(scopeTitle()) && !/笔记/.test(scopeTitle()), scopeTitle());

    // 普通点击折叠为单选
    click(collBtn('书'));
    await sleep(200);
    push('普通点击折叠为单选', cards().length === 2 && scopeTitle() === '书', cards().length + ' / ' + scopeTitle());
    push('折叠后只有书高亮', !isActive(collBtn('论文')) && isActive(collBtn('书')));

    // 对唯一选中的收藏集 Ctrl 点击 = 取消选择 → 全部条目
    click(collBtn('书'), true);
    await sleep(200);
    push('取消最后一个收藏集回到全部条目', cards().length === 5 && scopeTitle() === '全部条目', cards().length + ' / ' + scopeTitle());
    push('回到全部后没有收藏集高亮', !isActive(collBtn('书')) && !isActive(collBtn('论文')));

    // 多集合并集 + 搜索
    click(collBtn('论文'), true);
    click(collBtn('笔记'), true);
    await sleep(200);
    const box = document.getElementById('lib-search');
    box.value = 'alpha';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(300);
    push('并集上继续搜索', cards().length === 1 && /Alpha/.test(titles()[0] || ''), cards().length + ':' + titles().join('|'));
    box.value = '';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(250);

    // 每个收藏集自己的计数不受并集影响
    const counts = Array.from(document.querySelectorAll('#lib-collections .lib-coll'))
      .filter((b) => b.querySelector('.cname') && ['论文', '书', '笔记'].includes(b.querySelector('.cname').textContent))
      .map((b) => (b.querySelector('.lc-count') || {}).textContent);
    push('收藏集自身计数保持不变', counts.join(',') === '2,2,1', counts.join(','));

    // Ctrl 点击特殊行 = 普通选择
    click(Array.from(document.querySelectorAll('#lib-collections .lib-coll')).find((b) => b.textContent.includes('全部条目')), true);
    await sleep(200);
    push('Ctrl 点击全部条目按普通选择处理', cards().length === 5 && scopeTitle() === '全部条目', cards().length + ' / ' + scopeTitle());

    // 多选时删掉其中一个收藏集：并集自动收窄
    click(collBtn('论文'), true);
    click(collBtn('书'), true);
    await sleep(200);
    const delBtn = collBtn('书').querySelector('[data-del]');
    click(delBtn);
    await sleep(500);
    push('多选时删除收藏集自动收窄', cards().length === 2 && scopeTitle() === '论文',
      cards().length + ' / ' + scopeTitle());

    return { checks };
  } catch (e) {
    return { checks, fatal: String((e && e.stack) || e) };
  }
})()`;
