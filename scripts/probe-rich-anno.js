'use strict';
/*
 * 富文档文字标注探针（v9.5）：被 test-rich-anno.js 调用。
 * Word（docx）→ 富文档渲染 → 选中文字 → 高亮 / 下划线 / 评论 → 落盘 → 重开恢复。
 */
module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 8000)) { if (fn()) return true; await sleep(80); } return !!fn(); };

  // 选中某个块级元素里的文字，并触发阅读区的 mouseup（走真实工具条路径）
  const selectEl = async (elm) => {
    const r = document.createRange();
    r.selectNodeContents(elm);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    $('#viewer').dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 300, clientY: 300 }));
    await sleep(120);
    if ($('#sel-bar').hidden) {   // 上一步的收尾可能刚好把它关掉，补发一次
      $('#viewer').dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 300, clientY: 300 }));
    }
    return waitFor(() => !$('#sel-bar').hidden, 3000);
  };

  try {
    // ===== 1. 打开 docx（富文档） =====
    const add = await pdfBridge.lib.addPdf('__DOCX__', { dedupe: true });
    push('docx 能入库', !!(add && add.ok && add.item), (add && add.error) || '');
    if (!add || !add.ok) return { checks, stage: 'add' };
    const res = await pdfBridge.lib.openItem(add.item.key, 1);
    push('打开 docx 返回富文档', !!(res && res.ok && res.kind === 'rich'), (res && res.error) || (res && res.kind));
    LibraryUI.hide();
    window.__libOpen(res);
    const loaded = await waitFor(() => App.state.mode === 'rich'
      && document.body.classList.contains('rich-doc')
      && $$('#doc-view .doc-page').length > 0, 25000);
    push('富文档渲染出页面', loaded);
    if (!loaded) return { checks, stage: 'load' };

    const page = $('#doc-view .doc-page');
    push('富文档页挂上了标注层', !!(page && page.querySelector('.anno-base') && page.querySelector('.anno')));

    // 工具栏不再被隐藏（画笔 / 文字 / 便签…）
    const penBtn = $('#notetools [data-tool="pen"]');
    push('富文档里标注工具可用', !!penBtn && getComputedStyle(penBtn).display !== 'none',
      penBtn ? getComputedStyle(penBtn).display : 'missing');

    const ps = $$('#doc-view .doc-page-body p').filter((p) => (p.textContent || '').trim().length > 3);
    push('正文有可选中文字', ps.length >= 3, 'p=' + ps.length);
    if (ps.length < 3) return { checks, stage: 'text' };

    // ===== 2. 高亮 =====
    const shown1 = await selectEl(ps[0]);
    push('选中文字弹出工具条', shown1);
    const hb = $('#sel-bar [data-sel="highlight"]');
    push('高亮按钮可用（不再置灰）', !!hb && !hb.disabled);
    if (hb) { hb.click(); await sleep(700); }
    const marks = $$('#doc-view .doc-page .anno-base .text-mark:not(.text-underline)');
    push('富文档页出现高亮框', marks.length > 0, marks.length);
    push('高亮框有实际尺寸', !!marks[0] && marks[0].querySelector('rect')
      && +marks[0].querySelector('rect').getAttribute('width') > 5,
      marks[0] && marks[0].querySelector('rect') ? marks[0].querySelector('rect').getAttribute('width') : '');

    // ===== 3. 下划线 =====
    const shown2 = await selectEl(ps[1]);
    push('再次选中能再弹工具条', shown2);
    const ub = $('#sel-bar [data-sel="underline"]');
    if (ub) { ub.click(); await sleep(700); }
    const ul = $$('#doc-view .doc-page .anno-base .text-underline');
    push('富文档页出现下划线', ul.length > 0, ul.length);

    // ===== 4. 评论 =====
    const shown3 = await selectEl(ps[2]);
    push('第三次选中也能弹工具条', shown3);
    const cb = $('#sel-bar [data-sel="comment"]');
    if (cb) { cb.click(); await sleep(500); }
    const modalOpen = !$('#comment-modal').hidden;
    push('评论弹窗打开', modalOpen);
    if (modalOpen) {
      $('#comment-text').value = '富文档也能评论';
      $('#comment-save').click();
      await sleep(800);
    }
    const marked = $$('#doc-view .doc-page .anno-base .text-mark');
    push('评论也生成了高亮', marked.length >= 3, marked.length);

    // ===== 4b. 文字批注（直接用文字工具在页面上落字） =====
    const textTool = $('#notetools [data-tool="text"]');
    push('文字工具按钮存在', !!textTool);
    if (textTool) {
      textTool.click();
      await sleep(200);
      const annoSvg = $('#doc-view .doc-page .anno');
      const pr = $('#doc-view .doc-page').getBoundingClientRect();
      annoSvg.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, button: 0, pointerId: 1, isPrimary: true,
        clientX: pr.left + 120, clientY: pr.top + 240,
      }));
      const edOpen = await waitFor(() => !$('#text-editor').hidden, 3000);
      push('页面上能落文字批注', edOpen);
      if (edOpen) {
        const ed = $('#text-editor');
        ed.value = '富文档文字批注';
        ed.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        await sleep(500);
      }
      push('文字批注画在页面上',
        $$('#doc-view .doc-page .anno text').some((t) => (t.textContent || '').indexOf('富文档文字批注') >= 0),
        $$('#doc-view .doc-page .anno text').map((t) => t.textContent).join('|'));
      const selTool = $('#notetools [data-tool="select"]');
      if (selTool) selTool.click();
    }

    // ===== 5. 落盘 =====
    await App.flushAnnos();
    await sleep(500);
    const saved = await pdfBridge.loadAnnos('__DOCX__');
    const shapes = [].concat(...(Array.isArray(saved) ? saved : []).map((p) => p.shapes || []));
    push('标注写进标注文件', shapes.length >= 4, shapes.length);
    push('批注文字一并保存', shapes.some((s) => s.comment === '富文档也能评论'),
      JSON.stringify(shapes.map((s) => s.comment || '')));
    const listed = await pdfBridge.listAnnotations();
    push('标注进了库的标注列表', (listed || []).some((a) => String(a.text || '').indexOf('第三段') >= 0),
      (listed || []).length);

    // ===== 6. 重开恢复 =====
    // 关标签页（只关阅读会话，不删文件/标注）；只调 closeDocument 会留下标签，
    // 再打开同一路径会被 openDocument 判定为「已打开」而直接切过去
    App.closeTab(App.activeTabId);
    await sleep(500);
    const res2 = await pdfBridge.lib.openItem(add.item.key, 1);
    window.__libOpen(res2);
    const restored = await waitFor(() => App.state.mode === 'rich'
      && $$('#doc-view .doc-page .anno-base .text-mark').length >= 3, 25000);
    push('重开文档后标注恢复', restored, $$('#doc-view .doc-page .anno-base .text-mark').length);
    push('恢复后下划线还在', $$('#doc-view .doc-page .anno-base .text-underline').length > 0,
      $$('#doc-view .doc-page .anno-base .text-underline').length);

    // ===== 7. 在库里改标注 → 富文档页跟着重绘 =====
    const anyId = shapes.map((s) => s.id).find(Boolean);
    push('标注有稳定 id', !!anyId, anyId || '');
    if (anyId) {
      const upd = await pdfBridge.updateAnno(anyId, { comment: '改过的批注' });
      push('标注改动写回文件', !!(upd && upd.ok), JSON.stringify(upd && upd.error));
      await sleep(1000);
      const titles = $$('#doc-view .doc-page .anno-base .text-mark title').map((t) => t.textContent).join('|');
      push('富文档页跟着重绘（能看到新批注）', titles.indexOf('改过的批注') >= 0, titles.slice(0, 140));
    }

    return { checks };
  } catch (e) {
    return { checks, fatal: String((e && e.stack) || e) };
  }
})()`;
