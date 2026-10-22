'use strict';
/*
 * 独立笔记探针：新建笔记条目 → 写正文（失焦保存）→ 搜索命中 → 双击编辑 → 不进阅读器。
 * 被 test-note-item.js 调用。
 */
module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 8000)) { if (fn()) return true; await sleep(80); } return !!fn(); };

  try {
    const libReady = await waitFor(() => window.LibraryUI && LibraryUI.isOpen(), 10000);
    push('启动后文献库自动展开', libReady);
    if (!libReady) return { checks, stage: 'startup' };

    // 1. 新建笔记 → 直接进全屏编辑器（v9.5）
    const btn = $('#lib-new-note');
    push('工具栏有「＋ 笔记」按钮', !!btn, btn ? btn.textContent : '');
    btn.click();
    await waitFor(() => !$('#note-view').hidden, 8000);
    const sum1 = await pdfBridge.lib.summary();
    const noteItem = (sum1.items || []).find((x) => x.itemType === 'note');
    push('库里出现笔记条目', !!noteItem, JSON.stringify((sum1.items || []).map((x) => x.itemType)));
    push('笔记条目默认标题', !!noteItem && noteItem.title === '未命名笔记', noteItem && noteItem.title);
    push('新建后直接进全屏编辑器', !$('#note-view').hidden, '');
    // 侧栏详情仍可打开（卡片上的「详情」），但笔记条目会隐藏引用/相关条目这些无关区块
    LibraryUI.openDetail(noteItem && noteItem.key);
    await sleep(200);
    push('笔记条目隐藏引用/相关条目区块',
      $$('#lib-detail [data-ld-sec][hidden]').length >= 2,
      'hidden=' + $$('#lib-detail [data-ld-sec][hidden]').length);
    LibraryUI.closeDetail();

    // 2. 写正文（Markdown，自动保存）
    const box = $('#nv-md');
    push('编辑器里有 Markdown 正文区', !!box && box.tagName === 'TEXTAREA');
    if (box) {
      box.focus();
      box.value = '这是一条独立笔记，关于深度学习的实验记录：学习率 3e-4 效果最好。';
      box.dispatchEvent(new InputEvent('input', { bubbles: true }));
      await sleep(1300);
    }
    const sum2 = await pdfBridge.lib.summary();
    const it2 = (sum2.items || []).find((x) => x.key === (noteItem && noteItem.key));
    const body = it2 && (it2.notes || [])[0] && it2.notes[0].text;
    push('正文落盘', !!(body && body.indexOf('学习率 3e-4') >= 0), body && body.slice(0, 30));

    // 3. 搜索命中正文（走新的 query 引擎）
    const sbox = $('#lib-search');
    sbox.value = '学习率';
    sbox.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(450);
    const titles = $$('#lib-grid .lctitle').map((x) => x.textContent);
    push('全文式搜索命中笔记正文', titles.length === 1, JSON.stringify(titles));
    sbox.value = '';
    sbox.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(400);

    // 4. 回到列表：双击笔记卡片 → 进全屏编辑器（不是阅读器）
    if (!$('#note-view').hidden) { $('#nv-back').click(); await sleep(900); }
    const card = $('#lib-grid .lib-card[data-key="' + (noteItem && noteItem.key) + '"]');
    push('笔记卡片存在', !!card);
    if (card) {
      card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await sleep(900);
    }
    push('双击笔记打开全屏编辑器', !$('#note-view').hidden, '');
    push('双击笔记不进入阅读器', !document.body.classList.contains('has-doc'), '');
    push('编辑器里能看到刚才的正文', ($('#nv-md') || {}).value && $('#nv-md').value.indexOf('学习率 3e-4') >= 0,
      ($('#nv-md') || {}).value || '');
    push('卡片显示正文摘要', !!card && (card.querySelector('.lcmeta') || {}).textContent.indexOf('独立笔记') >= 0,
      card ? (card.querySelector('.lcmeta') || {}).textContent : '');

    return { checks };
  } catch (e) {
    return { checks, fatal: String((e && e.stack) || e) };
  }
})()`;
