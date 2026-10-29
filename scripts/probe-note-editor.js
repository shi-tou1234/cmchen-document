'use strict';
/*
 * 独立笔记全屏编辑器探针（v9.6 · Markdown 版）：被 test-note-editor.js 调用。
 * 覆盖：新建即进编辑器、Markdown 输入与实时预览、工具栏插语法、标题自动保存、
 *       旧富文本笔记自动转 Markdown、返回、单击选中、双击进编辑器、Esc 返回。
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

    // ===== 1. 新建笔记 → 直接进全屏 Markdown 编辑器 =====
    const s0 = await pdfBridge.lib.summary();
    const before = (s0.items || []).filter((x) => x.itemType === 'note').length;
    $('#lib-new-note').click();
    const opened = await waitFor(() => !$('#note-view').hidden, 8000);
    push('新建笔记直接进全屏编辑器', opened);
    push('新建时不再打开右侧详情栏', $('#lib-detail').hidden);
    const md = $('#nv-md');
    push('正文是 Markdown 源码框（textarea）', !!md && md.tagName === 'TEXTAREA');
    const toolbar = $('#nv-toolbar');
    push('工具栏是博客同款按钮组（没有下拉框）', !!toolbar
      && toolbar.querySelectorAll('.toolbar-btn[data-action]').length >= 20
      && !toolbar.querySelector('select'),
      toolbar ? toolbar.querySelectorAll('.toolbar-btn[data-action]').length : 0);
    push('预览面板默认打开', !!$('#nv-preview'));
    const s1 = await pdfBridge.lib.summary();
    const noteItem = (s1.items || []).find((x) => x.itemType === 'note');
    push('库里建了一条笔记', !!noteItem && (s1.items || []).filter((x) => x.itemType === 'note').length === before + 1);
    if (!noteItem || !md) return { checks, stage: 'create' };

    // ===== 2. Markdown 输入 + 实时预览 =====
    md.focus();
    md.value = '## 学习记录\\n\\n:::tip\\n这条是提示框\\n:::\\n\\n==彩虹== 与 ++下划++ 与 !!模糊!!';
    md.dispatchEvent(new InputEvent('input', { bubbles: true }));
    push('预览渲染出标题', await waitFor(() => $('#nv-preview h2'), 6000)
      && ($('#nv-preview h2') || {}).textContent === '学习记录',
      ($('#nv-preview h2') || {}).textContent);
    const admon = await waitFor(() => $('#nv-preview .admonition.tip'), 6000);
    push('预览渲染出 :::tip 提示框', !!admon, admon && admon.className);
    push('预览渲染出彩虹 / 下划线 / 剧透',
      !!$('#nv-preview .rainbow-text') && !!$('#nv-preview .underline-text') && !!$('#nv-preview .spoiler'));
    await sleep(1200);
    const snap = await pdfBridge.lib.summary();
    const it = (snap.items || []).find((x) => x.key === noteItem.key);
    const body = ((it && it.notes || [])[0] || {});
    push('Markdown 源码自动落库', String(body.text || '').indexOf('## 学习记录') >= 0, body.text);

    // ===== 3. 工具栏按钮插入语法 =====
    md.focus();
    md.value = '';
    md.dispatchEvent(new InputEvent('input', { bubbles: true }));
    md.setSelectionRange(0, 0);
    const boldBtn = $('#nv-toolbar [data-action="bold"]');
    push('工具栏有加粗按钮', !!boldBtn);
    if (boldBtn) { boldBtn.click(); await sleep(300); }
    push('加粗按钮插入 **加粗文本** 并选中', md.value === '**加粗文本**'
      && md.selectionEnd - md.selectionStart === '加粗文本'.length, md.value);
    const h2Btn = $('#nv-toolbar [data-action="heading-2"]');
    md.setSelectionRange(md.value.length, md.value.length);
    if (h2Btn) { h2Btn.click(); await sleep(300); }
    push('H2 按钮插入二级标题语法', md.value.indexOf('## 二级标题') >= 0, md.value);
    const tableBtn = $('#nv-toolbar [data-action="table"]');
    md.setSelectionRange(md.value.length, md.value.length);
    if (tableBtn) { tableBtn.click(); await sleep(300); }
    // v36：表格按钮不再直接插语法，先打开格子界面（光标不在表格里就从 3×3 起）
    const tblModal = $('#tbl-modal');
    push('表格按钮打开格子界面（默认 3×3）', !!tblModal && !tblModal.hidden && tblModal.querySelectorAll('.tbl-cell').length === 9,
      tblModal ? (tblModal.hidden ? 'hidden' : String(tblModal.querySelectorAll('.tbl-cell').length)) : 'no modal');
    const tblInfo = $('#tbl-info');
    push('格子界面写明行列数', !!tblInfo && /3 行 × 3 列/.test(tblInfo.textContent), tblInfo && tblInfo.textContent);
    const addColBtn = $('#tbl-add-col');
    if (addColBtn) { addColBtn.click(); await sleep(150); }
    push('「＋ 列」把表格加宽到 4 列', !!tblInfo && /4 列/.test(tblInfo.textContent) && tblModal.querySelectorAll('.tbl-cell').length === 12,
      tblInfo && tblInfo.textContent);
    const delColBtn = $('#tbl-del-col');
    if (delColBtn) { delColBtn.click(); await sleep(150); }
    push('「− 列」再退回 3 列', !!tblInfo && /3 列/.test(tblInfo.textContent), tblInfo && tblInfo.textContent);
    const tblOk = $('#tbl-ok');
    if (tblOk) { tblOk.click(); await sleep(300); }
    push('格子界面确认后插入 Markdown 表格', md.value.indexOf('| --- |') >= 0 && /列 1/.test(md.value), md.value);
    const ghBtn = $('#nv-toolbar [data-action="github-card"]');
    md.setSelectionRange(md.value.length, md.value.length);
    if (ghBtn) { ghBtn.click(); await sleep(300); }
    push('GitHub 卡片按钮插入 ::github', md.value.indexOf('::github{repo=') >= 0, md.value);

    // ===== 4. 标题自动保存 =====
    const title = $('#nv-title');
    title.value = '实验记录';
    title.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(1300);
    const snap2 = await pdfBridge.lib.summary();
    const it2 = (snap2.items || []).find((x) => x.key === noteItem.key);
    push('标题自动落库', !!it2 && it2.title === '实验记录', it2 && it2.title);

    // ===== 5. 旧富文本笔记打开时自动转 Markdown =====
    // 先关掉编辑器（它会保存并把 html 清空），再把库里这条笔记改造成「只有 html」的旧格式，
    // 最后重新打开 —— 打开时应自动 fromHtml 转成 Markdown 源码
    $('#nv-back').click();
    await sleep(900);
    const cur = (await pdfBridge.lib.summary()).items.find((x) => x.key === noteItem.key);
    const nid = ((cur.notes || [])[0] || {}).id;
    push('能取到笔记 id', !!nid, nid);
    await pdfBridge.lib.updateNote(noteItem.key, nid, { html: '<p>旧富文本段落</p>', text: '' });
    await LibraryUI.refresh();   // state.items 里还是旧内容（updateNote 不发 lib-changed），手动刷一次
    await sleep(300);
    const card0 = $('#lib-grid .lib-card[data-key="' + noteItem.key + '"]');
    if (card0) { card0.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await sleep(900); }
    push('双击重新进编辑器', !$('#note-view').hidden);
    push('旧富文本自动转成 Markdown 源码', md.value.indexOf('旧富文本段落') >= 0, md.value);

    // ===== 6. 返回 / 单击 / 双击 / Esc =====
    $('#nv-back').click();
    await sleep(900);
    push('返回后编辑器关闭', $('#note-view').hidden);
    const card = $('#lib-grid .lib-card[data-key="' + noteItem.key + '"]');
    push('卡片摘要跟上 Markdown 正文', !!card && (card.querySelector('.lcmeta') || {}).textContent.indexOf('旧富文本段落') >= 0,
      card ? (card.querySelector('.lcmeta') || {}).textContent : '');
    if (card) { card.click(); await sleep(400); }
    push('单击笔记只选中，不弹侧栏', !!card && card.classList.contains('selected') && $('#lib-detail').hidden);
    const card2 = $('#lib-grid .lib-card[data-key="' + noteItem.key + '"]');
    if (card2) { card2.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await sleep(900); }
    push('双击笔记进入全屏编辑器', !$('#note-view').hidden);
    push('不会误进阅读器', !document.body.classList.contains('has-doc'));
    LibraryUI.closeDetail();
    await sleep(150);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await sleep(700);
    push('Esc 也能返回文献库', $('#note-view').hidden);
    push('Esc 返回后仍停在文献库', !$('#library').hidden);

    return { checks };
  } catch (e) {
    return { checks, fatal: String((e && e.stack) || e) };
  }
})()`;
