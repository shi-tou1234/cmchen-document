'use strict';
/*
 * 标注第二阶段探针：真实 app 里跑「标注可编辑 + 条目详情标注区块 + 生成带图笔记」。
 * 被 test-anno-objects.js 调用（PDF 路径由 test 侧注入）。
 */
module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 10000)) { if (fn()) return true; await sleep(80); } return !!fn(); };

  try {
  const libReady = await waitFor(() => window.LibraryUI && LibraryUI.isOpen(), 10000);
  push('启动后文献库自动展开', libReady);
  if (!libReady) return { checks, stage: 'startup' };

  // 1. 入库
  const add = await pdfBridge.lib.addPdf('__SAMPLE__', { dedupe: true });
  push('样例 PDF 入库', !!(add && add.ok), JSON.stringify((add || {}).error));
  const key = add.item.key;
  const itemPath = add.item.attachment.path;
  await LibraryUI.refresh();

  // 2. 造一条标注（走真实保存通道；形状自带稳定 id）
  const pages = [{
    page: 1,
    shapes: [{
      id: 'aTestMark01', tool: 'mark', color: '#ffd54f', width: 0,
      rects: [{ x: 60, y: 90, w: 240, h: 26 }, { x: 60, y: 122, w: 180, h: 26 }],
      text: '这是被高亮的原文', comment: '第一版批注',
    }],
  }];
  const saved = await pdfBridge.saveAnnos(itemPath, pages);
  push('标注保存成功', !!saved, JSON.stringify(saved));
  const loaded = await pdfBridge.loadAnnos(itemPath);
  push('读回的标注带稳定 id', !!(loaded[0] && loaded[0].shapes[0].id === 'aTestMark01'), JSON.stringify(loaded[0] && loaded[0].shapes[0].id));

  // 3. 标注视图：卡片出现
  await LibraryUI.loadAnnos(true);
  $('[data-scope="annotations"]').click();
  const cardReady = await waitFor(() => $('.lib-card.lib-anno'), 8000);
  push('标注视图列出这条标注', cardReady);
  const card = $('.lib-card.lib-anno');
  push('卡片上有「编辑」按钮', !!card.querySelector('[data-anno-edit]'), '');
  push('卡片显示标注文字', (card.textContent || '').indexOf('这是被高亮的原文') >= 0, (card.textContent || '').slice(0, 60));

  // 4. 编辑文字 / 批注
  card.querySelector('[data-anno-edit]').click();
  const modal = $('#anno-edit-modal');
  push('编辑弹窗打开', !!modal && !modal.hidden, '');
  $('#anno-edit-text').value = '改过的原文';
  $('#anno-edit-comment').value = '改过的批注';
  $('#anno-edit-save').click();
  const closed = await waitFor(() => modal.hidden, 8000);
  push('保存后弹窗关闭', closed);
  const after = await pdfBridge.loadAnnos(itemPath);
  const sh = after[0] && after[0].shapes[0];
  push('标注真身已同步（阅读器看到的文字变了）', !!sh && sh.text === '改过的原文' && sh.comment === '改过的批注', JSON.stringify(sh && { text: sh.text, comment: sh.comment }));
  const sum1 = await pdfBridge.lib.summary();
  push('标注对象层同步', !!(sum1.annoMeta['aTestMark01'] && sum1.annoMeta['aTestMark01'].text === '改过的原文'), JSON.stringify(sum1.annoMeta));

  // 5. 条目详情里的「标注」区块
  $('[data-scope="all"]').click();
  await waitFor(() => $$('#lib-grid .lib-card').length >= 1, 5000);
  const itemCard = $('#lib-grid .lib-card[data-key="' + key + '"]');
  if (itemCard) itemCard.click();
  await waitFor(() => !$('#lib-detail').hidden, 4000);
  await waitFor(() => $('#ld-annos [data-ld-anno-page]'), 4000);
  const annoRow = $('#ld-annos [data-ld-anno-page]');
  push('条目详情列出该条目的标注', !!annoRow);
  push('标注行显示页码与文字', !!annoRow && /P1/.test(annoRow.textContent || '')
    && (annoRow.textContent || '').indexOf('改过的原文') >= 0, annoRow ? String(annoRow.textContent || '').slice(0, 60) : '');

  // 6. 生成带截图的笔记：回标注视图，选中 → 生成笔记
  $('[data-scope="annotations"]').click();
  await waitFor(() => $('.lib-card.lib-anno'), 5000);
  $('.lib-card.lib-anno .lc-check input').click();
  await sleep(150);
  push('选中后出现「生成笔记」按钮', !!$('#lib-anno-note') && !$('#lib-anno-note').hidden
    && !!$('#lib-anno-tools') && !$('#lib-anno-tools').hidden, '');
  $('#lib-anno-note').click();
  // 生成过程：打开文档 → 等渲染 → 截图 → 回库刷新（轮询库数据，注意 waitFor 是同步判断）
  let note = null;
  const tNote = Date.now();
  while (Date.now() - tNote < 45000) {
    try {
      const s = await pdfBridge.lib.summary();
      const it = s.items.find((x) => x.key === key);
      if (it && it.notes && it.notes.length) { note = it.notes[0]; break; }
    } catch (_) {}
    await sleep(250);
  }
  push('生成了一条笔记', !!note);
  const sum2 = await pdfBridge.lib.summary();
  push('笔记带截图路径', !!(note && /^snapshots\\/anno-.*\\.png$/.test(note.image || '')), note && note.image);
  push('笔记记下来源标注', !!(note && (note.annoIds || []).includes('aTestMark01')), note && note.annoIds);
  const img = await pdfBridge.noteImage(note && note.image);
  push('截图文件读得回来且是 PNG', !!(img && img.ok && /^data:image\\/png;base64,/.test(img.dataUrl || '')),
    img && (img.error || String(img.dataUrl || '').slice(0, 24)));
  push('标注对象记下 noteId', !!(sum2.annoMeta['aTestMark01'] && (sum2.annoMeta['aTestMark01'].noteIds || []).includes(note.id)), JSON.stringify(sum2.annoMeta['aTestMark01']));
  push('生成后回到文献库并选中条目的详情', LibraryUI.isOpen() && !$('#lib-detail').hidden, '');

  return { checks };
  } catch (e) {
    return { checks, fatal: String((e && e.stack) || e) };
  }
})()`;
