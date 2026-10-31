'use strict';
/*
 * 笔记图片缩放探针（v1.6）：被 test-note-image.js 调用。
 *
 * 要验的是「拖完能存下来」，不是「DOM 上的尺寸变了」——预览每敲几个字就重渲染一次，
 * DOM 改动会被冲掉。所以两条路径各自盯住自己的落点：
 *   1. Markdown 笔记（NV 编辑器）→ 源码里的 #w=NNN；
 *   2. 标注截图（详情面板里的 ld-note-img）→ notes[].imageW 字段。
 * 覆盖：把手出现、拖动 → 源码改写、渲染回读、双击还原、截图宽度落库。
 */
module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 8000)) { if (fn()) return true; await sleep(80); } return !!fn(); };
  const errs = [];
  window.addEventListener('error', (e) => errs.push(String(e.message || e.error)));
  let stage = 'load';
  try {

  // ===== 1. NV 编辑器里的 Markdown 图片 =====
  stage = 'open-editor';
  const libReady = await waitFor(() => window.LibraryUI && LibraryUI.isOpen(), 12000);
  push('文献库已打开', libReady);
  if (!libReady) return { checks, stage };
  $('#lib-new-note').click();
  push('笔记编辑器已打开', await waitFor(() => !$('#note-view').hidden, 8000));
  const md = $('#nv-md');
  if (!md) return { checks, stage: 'no-md' };

  stage = 'render';
  md.focus();
  md.value = '正文一段。\\n\\n![封面](snapshots/a.png)\\n\\n尾巴一段。';
  md.dispatchEvent(new InputEvent('input', { bubbles: true }));
  await waitFor(() => $('#nv-preview img.md-img') && $('#nv-preview .note-img-wrap'), 8000);
  const wrap = $('#nv-preview .note-img-wrap');
  push('预览里的图片被包了一层（可放射把手）', !!wrap, wrap && wrap.className);
  push('右下角有拖拽把手', !!(wrap && wrap.querySelector('[data-img-handle]')));
  push('把手标注了来源与序号', !!wrap && wrap.dataset.imgSource === 'md' && wrap.dataset.imgIdx === '0',
    wrap && (wrap.dataset.imgSource + '/' + wrap.dataset.imgIdx));
  // R-v1.6-04：没设宽度的图不能被夹到最小宽度 40px
  const imgEl = wrap && wrap.querySelector('img');
  push('未设宽度时不写死宽度', !!imgEl && !imgEl.style.width, imgEl && imgEl.style.width);
  push('未设宽度时没有 data-md-w', !!imgEl && !imgEl.getAttribute('data-md-w'), imgEl && imgEl.getAttribute('data-md-w'));
  if (!wrap) return { checks, stage: 'no-wrap' };

  stage = 'drag';
  const handle = wrap.querySelector('[data-img-handle]');
  const before = md.value;
  const drag = (dx) => {
    handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }));
    handle.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 100 + dx, clientY: 100 }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 100 + dx, clientY: 100 }));
  };
  drag(260);
  const after = md.value;
  push('拖动后源码被改写（不是只改 DOM）', after !== before, JSON.stringify(after.slice(0, 120)));
  push('宽度写成了 #w= 标记', /!\\u005b封面\\u005d\\(snapshots\\/a\\.png#w=\\d+\\)/.test(after), JSON.stringify(after));
  push('图片以外的正文没被牵动', after.indexOf('正文一段。') >= 0 && after.indexOf('尾巴一段。') >= 0, JSON.stringify(after));

  stage = 'render-back';
  const w1 = (after.match(/#w=(\\d+)/) || [])[1];
  push('渲染把宽度读回来了', await waitFor(() => {
    const im = $('#nv-preview img.md-img');
    return im && im.getAttribute('data-md-w') === String(w1);
  }, 8000), 'want ' + w1);

  stage = 'restore';
  handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  push('双击把手还原原始尺寸', await waitFor(() => $('#nv-md').value.indexOf('#w=') < 0, 6000), $('#nv-md').value);

  stage = 'persist';
  await waitFor(() => ($('#nv-status') || {}).textContent, 6000);
  const saved = await pdfBridge.lib.summary();
  const note = (saved.items || []).find((x) => x.itemType === 'note' && (x.notes || []).length);
  push('改动已经过存储层（库里这条笔记存在）', !!note, note && note.key);

  // ===== 1.5 代码块里的示例图不能被误改（R-v1.6-05） =====
  stage = 'code-block';
  md.value = '前言\\n\\n\\u0060\\u0060\\u0060md\\n![](snapshots/code.png)\\n\\u0060\\u0060\\u0060\\n\\n![真图](snapshots/real.png)\\n';
  md.dispatchEvent(new InputEvent('input', { bubbles: true }));
  // 等这一批图渲染出来（上一次的预览还在，只数数量会白等）
  await waitFor(() => $$('#nv-preview img.md-img').some((i) => i.getAttribute('data-md-img') === 'snapshots/real.png'), 8000);
  await sleep(250);
  const wraps2 = $$('#nv-preview .note-img-wrap');
  push('代码块里的图不渲染成图片', wraps2.length === 1, wraps2.length);
  if (wraps2.length === 1) {
    const h2 = wraps2[0].querySelector('[data-img-handle]');
    const before2 = md.value;
    h2.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }));
    h2.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 320, clientY: 100 }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 320, clientY: 100 }));
    await sleep(150);
    const after2 = md.value;
    push('拖动改了源码', after2 !== before2, JSON.stringify(after2));
    push('改的是正文那张图', after2.indexOf('snapshots/real.png#w=') >= 0, JSON.stringify(after2));
    push('代码块里的示例没被改', after2.indexOf('![](snapshots/code.png)') >= 0, JSON.stringify(after2));
  }

  // ===== 1.6 带标题的图片也要能定位（R-v1.6b-01） =====
  stage = 'titled';
  md.value = '带标题：\\n\\n![图](snapshots/a.png "说明")\\n\\n![第二张](snapshots/b.png)\\n';
  md.dispatchEvent(new InputEvent('input', { bubbles: true }));
  await waitFor(() => $$('#nv-preview .note-img-wrap').length === 2, 8000);
  await sleep(200);
  const wraps3 = $$('#nv-preview .note-img-wrap');
  push('带标题的图也渲染出来了', wraps3.length === 2, wraps3.length);
  if (wraps3.length === 2) {
    const h3 = wraps3[0].querySelector('[data-img-handle]');
    h3.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }));
    h3.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 300, clientY: 100 }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 300, clientY: 100 }));
    await sleep(150);
    const after3 = md.value;
    push('带标题的那张被改到', after3.indexOf('snapshots/a.png#w=') >= 0, JSON.stringify(after3));
    push('标题说明没被吞掉', after3.indexOf('"说明"') >= 0, JSON.stringify(after3));
    push('下一张没被误改', after3.indexOf('b.png#w=') < 0 && after3.indexOf('snapshots/b.png') >= 0, JSON.stringify(after3));
  }

  // ===== 1.7 标题含 & 的图片：编号不能错位（R-v1.6c-01） =====
  stage = 'amp-title';
  md.value = '前言\\n\\n![first](snapshots/one.png "R&D")\\n\\n![second](snapshots/two.png)\\n';
  md.dispatchEvent(new InputEvent('input', { bubbles: true }));
  // 等的是「这一批图渲染出来」，不是「有两张图」——上一次的预览还在，数量对得上就白等了
  const seen = (url) => $$('#nv-preview img.md-img').some((i) => i.getAttribute('data-md-img') === url);
  await waitFor(() => seen('snapshots/two.png') && $$('#nv-preview .note-img-wrap').length === 2, 8000);
  await sleep(200);
  const wraps4 = $$('#nv-preview .note-img-wrap');
  push('含 & 的标题不影响渲染', wraps4.length === 2, wraps4.length);
  if (wraps4.length === 2) {
    // 拖第二张：必须改第二张，第一张（含 & 标题那张）不许动
    const h4 = wraps4[1].querySelector('[data-img-handle]');
    h4.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }));
    h4.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 300, clientY: 100 }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 300, clientY: 100 }));
    await sleep(150);
    const after4 = md.value;
    push('第二张被改到', after4.indexOf('snapshots/two.png#w=') >= 0, JSON.stringify(after4));
    push('第一张没被误改', after4.indexOf('one.png#w=') < 0, JSON.stringify(after4));
    push('第一张的标题还在', after4.indexOf('"R&D"') >= 0, JSON.stringify(after4));
  }

  // ===== 1.8 脚注图片：同一张图两处引用，也要各改各的（R-v1.6e-03） =====
  stage = 'footnote';
  md.value = '[^1]: 脚注 ![same](snapshots/same.png#w=120)\\n\\n正文一段。\\n\\n![body](snapshots/same.png#w=320)\\n\\n看这里[^1]。\\n';
  md.dispatchEvent(new InputEvent('input', { bubbles: true }));
  await waitFor(() => seen('snapshots/same.png') && $$('#nv-preview .note-img-wrap').length === 2, 8000);
  await sleep(250);
  const wraps5 = $$('#nv-preview .note-img-wrap');
  push('同 URL 的两处引用都渲染出来', wraps5.length === 2, wraps5.length);
  if (wraps5.length === 2) {
    // 第一张 DOM 图是正文那张（脚注被挪到文末）：宽度 320
    const w0 = wraps5[0].querySelector('img').getAttribute('data-md-w');
    push('第一张 DOM 图是正文那张（宽 320）', w0 === '320', w0);
    const h5 = wraps5[0].querySelector('[data-img-handle]');
    h5.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }));
    h5.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 300, clientY: 100 }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 300, clientY: 100 }));
    await sleep(150);
    const after5 = md.value;
    push('脚注那条引用没被改（仍是 120）', after5.indexOf('same.png#w=120') >= 0, JSON.stringify(after5));
    push('正文那条引用被改掉了', after5.indexOf('same.png#w=320') < 0, JSON.stringify(after5));
    push('还是只有两个 #w= 标记', (after5.match(/#w=/g) || []).length === 2, JSON.stringify(after5));
  }

  // ===== 1.9 表格里的图片：脚注在前面也不能改错（R-v1.6f-03） =====
  stage = 'table';
  // 单元格里带转义竖线：解转义会让后面图片的偏移少算一格（R-v1.6g-01）
  md.value = '[^1]: 脚注 ![f](snapshots/fn2.png)\\n\\n| 列 |\\n| --- |\\n| before \\u005c| ![cell](snapshots/cell.png) |\\n\\n看[^1]。\\n';
  md.dispatchEvent(new InputEvent('input', { bubbles: true }));
  await waitFor(() => seen('snapshots/cell.png') && $$('#nv-preview .note-img-wrap').length === 2, 8000);
  await sleep(250);
  const wraps6 = $$('#nv-preview .note-img-wrap');
  push('表格图与脚注图都渲染出来', wraps6.length === 2, wraps6.length);
  if (wraps6.length === 2) {
    const cellWrap = wraps6.find((w) => w.querySelector('img').getAttribute('data-md-img') === 'snapshots/cell.png');
    push('找得到表格里的那张', !!cellWrap);
    if (cellWrap) {
      const h6 = cellWrap.querySelector('[data-img-handle]');
      h6.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 100, clientY: 100 }));
      h6.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 300, clientY: 100 }));
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 300, clientY: 100 }));
      await sleep(150);
      const after6 = md.value;
      push('表格里的图被改到', after6.indexOf('cell.png#w=') >= 0, JSON.stringify(after6));
      push('脚注图没被改到', after6.indexOf('fn2.png#w=') < 0, JSON.stringify(after6));
      // 模板字符串里写反斜杠要过两层转义，直接用码点拼，避免「看起来一样其实不是一个字符」
      push('单元格里的转义竖线还在', after6.indexOf('before ' + String.fromCharCode(92) + '| ') >= 0, JSON.stringify(after6));
    }
  }

  // ===== 2. 详情面板里的标注截图 =====
  stage = 'note-image';
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await waitFor(() => window.LibraryUI && LibraryUI.isOpen(), 8000);
  window.LibraryUI.openDetail('kd1');
  await waitFor(() => $('.ld-note-img') && $('.ld-note .note-img-wrap'), 9000);
  const imgWrap = $('.ld-note .note-img-wrap');
  push('截图也带上了缩放把手', !!imgWrap && !!imgWrap.querySelector('[data-img-handle]'), imgWrap && imgWrap.className);
  push('把手认得自己属于哪条笔记', !!imgWrap && imgWrap.dataset.imgNoteId === 'nimg', imgWrap && imgWrap.dataset.imgNoteId);
  // R-v1.6-04：旧截图没有 imageW（= 0），不能被强制缩成 40px
  const shotImg = imgWrap && imgWrap.querySelector('img');
  push('没设宽度的截图不写死宽度', !!shotImg && !shotImg.style.width, shotImg && shotImg.style.width);
  if (!imgWrap) return { checks, stage: 'no-shot-wrap' };

  const shotHandle = imgWrap.querySelector('[data-img-handle]');
  shotHandle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 }));
  shotHandle.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 380, clientY: 200 }));
  document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 380, clientY: 200 }));
  // 注意：这个是给「异步断言」用的，不能复用 waitFor —— 那里 if (fn()) 拿到的是 Promise，
  // Promise 恒为真，会当场返回 true 而不等真正的结果。
  const waitAsync = async (fn, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 9000)) { if (await fn()) return true; await sleep(150); }
    return !!(await fn());
  };
  let stored = null;
  const storedOk = await waitAsync(async () => {
    const s = await pdfBridge.lib.summary();
    const it = (s.items || []).find((x) => x.key === 'kd1');
    const n = it && (it.notes || []).find((x) => x.id === 'nimg');
    if (n && n.imageW) { stored = n.imageW; return true; }
    return false;
  }, 9000);
  push('截图宽度落到了 notes[].imageW（跨存储层）', storedOk, stored);

  stage = 'errors';
  push('全程无脚本错误', errs.length === 0, errs.join(' | '));
  return { checks };
  } catch (e) {
    return { checks, fatal: stage + ': ' + ((e && e.message) || e) };
  }
})()`;
