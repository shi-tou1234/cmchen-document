'use strict';
/*
 * 用户反馈修复探针（第二轮）。
 * 被 test-bugfix-round2.js 调用。
 */
module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 8000)) { if (fn()) return true; await sleep(80); } return !!fn(); };

  try {
    // 记录 toast 文案，便于断言"至少有反馈"
    const toasts = [];
    if (window.App) {
      const origToast = App.toast;
      App.toast = function (msg) { toasts.push(String(msg || '')); if (origToast) return origToast.apply(App, arguments); };
    }

    const libReady = await waitFor(() => window.LibraryUI && LibraryUI.isOpen(), 10000);
    push('启动后文献库自动展开', libReady);
    if (!libReady) return { checks, stage: 'startup' };

    // ===== 1. 高亮 / 下划线：真实点击 =====
    const add = await pdfBridge.lib.addPdf('__SAMPLE__', { dedupe: true });
    const res = await pdfBridge.lib.openItem(add.item.key, 1);
    LibraryUI.hide();
    window.__libOpen(res);
    const loaded = await waitFor(() => App.state.pdfDoc && App.state.rendered.get(1), 25000);
    push('PDF 加载到第 1 页', loaded);
    if (!loaded) return { checks, stage: 'load' };

    const page = App.pageEl(1);
    // 文本层是渲染完成之后异步铺的（buildTextLayer 不 await），直接查会偶发空。
    await waitFor(() => page.querySelectorAll('.textlayer span').length > 0, 10000);
    const spans = Array.from(page.querySelectorAll('.textlayer span')).filter((x) => (x.textContent || '').trim().length > 1);
    push('页面有可选中文本', spans.length > 0, 'spans=' + spans.length);
    const selectText = async (idx) => {
      const sp = spans[idx];
      if (!sp) return false;
      const r = document.createRange();
      r.selectNodeContents(sp);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      $('#viewer').dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 200, clientY: 200 }));
      return waitFor(() => !$('#sel-bar').hidden, 3000);
    };

    const bar1 = await selectText(0);
    push('选中文字后工具条出现', bar1);
    if (bar1) {
      const hb = $('#sel-bar [data-sel="highlight"]');
      push('工具条里有「高亮」', !!hb);
      hb.click();
      await sleep(350);
      push('点高亮后页面上出现高亮', page.querySelectorAll('.anno-base .text-mark').length >= 1,
        'marks=' + page.querySelectorAll('.anno-base .text-mark').length);
      push('高亮写入标注数据', (App.state.annos.get(1) || []).length >= 1);
    }

    const bar2 = await selectText(0);
    push('工具条能再次出现（不残留）', bar2);
    if (bar2) {
      const ub = $('#sel-bar [data-sel="underline"]');
      push('工具条里有「下划线」', !!ub);
      ub.click();
      await sleep(350);
      push('点下划线后页面上出现下划线', page.querySelectorAll('.anno-base .text-underline').length >= 1,
        'ul=' + page.querySelectorAll('.anno-base .text-underline').length);
      const kinds = (App.state.annos.get(1) || []).map((s) => s.kind || '');
      push('下划线数据标记为 underline', kinds.includes('underline'), JSON.stringify(kinds));
    }

    // 选区失效时不能静默：清掉选区再点按钮
    if (bar2) {
      try { window.getSelection().removeAllRanges(); } catch (_) {}
      const before = (App.state.annos.get(1) || []).length;
      toasts.length = 0;
      const hb2 = $('#sel-bar [data-sel="highlight"]');
      if (hb2) hb2.click();
      await sleep(250);
      push('选区失效时不再静默（有提示）', toasts.some((t) => /选区已失效|重新选中/.test(t)), JSON.stringify(toasts));
      push('选区失效时不会误加标注', (App.state.annos.get(1) || []).length === before);
    }

    // ===== 2. 富文档朗读 =====
    const opened = await pdfBridge.openPath('__MD__');
    push('Markdown 以富文档方式打开', !!(opened && opened.ok), JSON.stringify(opened));
    const rich = await waitFor(() => App.state.mode === 'rich', 20000);
    push('进入富文档模式', rich, App.state.mode);
    if (rich) {
      await waitFor(() => (document.querySelector('#doc-view') || {}).innerText, 8000);
      toasts.length = 0;
      await App.speakToggle();
      await sleep(500);
      const st = App.speakStatus();
      push('富文档也能开始朗读（不是"没有文字"）', st === 'speaking' || st === 'idle',
        'status=' + st + ' toasts=' + JSON.stringify(toasts));
      push('富文档朗读没有报"没有可朗读的文字"', !toasts.some((t) => /没有可朗读的文字/.test(t)), JSON.stringify(toasts));
      App.speakStop();
      await sleep(150);
      push('停止后回到 idle', App.speakStatus() === 'idle', App.speakStatus());

      // 富文档里点高亮/下划线：必须给出提示，而不是抛错后静默
      const richSpans = Array.from(document.querySelectorAll('#doc-view .doc-page *')).filter((el) => el.children.length === 0 && (el.textContent || '').trim().length > 4);
      if (richSpans.length) {
        const r3 = document.createRange();
        r3.selectNodeContents(richSpans[0]);
        const sel3 = window.getSelection();
        sel3.removeAllRanges();
        sel3.addRange(r3);
        document.getElementById('viewer').dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 200, clientY: 200 }));
        const shown = await waitFor(() => !document.getElementById('sel-bar').hidden, 2500);
        push('富文档选中文字也出工具条', !!shown);
        if (shown) {
          toasts.length = 0;
          // v9.5：富文档也有标注层了，三个按钮都必须可用
          const ub2 = document.querySelector('#sel-bar [data-sel="underline"]');
          const hb3 = document.querySelector('#sel-bar [data-sel="highlight"]');
          const cb3 = document.querySelector('#sel-bar [data-sel="comment"]');
          push('富文档里下划线按钮可用', !!ub2 && !ub2.disabled, ub2 ? String(ub2.disabled) : '');
          push('富文档里高亮按钮可用', !!hb3 && !hb3.disabled, hb3 ? String(hb3.disabled) : '');
          push('富文档里评论按钮可用', !!cb3 && !cb3.disabled, cb3 ? String(cb3.disabled) : '');
          if (hb3) { hb3.click(); await sleep(700); }
          push('富文档里点高亮真的画出来了', $$('#doc-view .doc-page .anno-base .text-mark').length > 0,
            $$('#doc-view .doc-page .anno-base .text-mark').length);
        }
      }
    }

    // ===== 3. 空白笔记：单击选中、双击进全屏编辑器（v9.5 起不再落进侧栏） =====
    LibraryUI.show();
    await sleep(300);
    $('#lib-new-note').click();
    await sleep(1200);
    const sum = await pdfBridge.lib.summary();
    const noteItem = (sum.items || []).find((x) => x.itemType === 'note');
    push('新建了空白笔记', !!noteItem);
    push('新建后直接进全屏编辑器', !$('#note-view').hidden);
    if (noteItem) {
      if (!$('#note-view').hidden) { $('#nv-back').click(); await sleep(900); }
      const card = $('#lib-grid .lib-card[data-key="' + noteItem.key + '"]');
      push('笔记卡片存在', !!card);
      if (card) {
        card.click();     // 单击只选中
        await sleep(400);
        push('单击笔记只选中，不弹侧栏', card.classList.contains('selected') && $('#lib-detail').hidden);
        const card2 = $('#lib-grid .lib-card[data-key="' + noteItem.key + '"]') || card;
        card2.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        await sleep(900);
        push('双击笔记进全屏编辑器', !$('#note-view').hidden);
        const ta = $('#nv-md');
        push('编辑器正文可编辑（Markdown 源码框）', !!ta && ta.tagName === 'TEXTAREA' && !ta.disabled);
        const editBtn = card2.querySelector('[data-open-note]');
        push('笔记卡片按钮写着「编辑」', !!editBtn && editBtn.textContent === '编辑', editBtn ? editBtn.textContent : '');
        if (ta) {
          ta.value = '双击进来的';
          ta.dispatchEvent(new InputEvent('input', { bubbles: true }));
          await sleep(1300);
          const s2 = await pdfBridge.lib.summary();
          const it2 = (s2.items || []).find((x) => x.key === noteItem.key);
          push('编辑内容能保存', ((it2.notes || [])[0] || {}).text === '双击进来的', ((it2.notes || [])[0] || {}).text);
          $('#nv-back').click();
          await sleep(700);
        }
      }
    }

    // ===== 4. 搜索框 placeholder 不被截断 =====
    const sb = $('#lib-search');
    if (sb) {
      const cs = getComputedStyle(sb);
      const cv = document.createElement('canvas').getContext('2d');
      cv.font = cs.fontSize + ' ' + cs.fontFamily;
      const need = cv.measureText(sb.placeholder).width;
      const have = sb.getBoundingClientRect().width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 4;
      push('placeholder 宽度不再超出输入框', need <= have, 'need=' + Math.round(need) + ' have=' + Math.round(have));
      push('语法说明挪到 title 属性', /短语/.test(sb.title || ''), sb.title);
    }

    return { checks };
  } catch (e) {
    return { checks, fatal: String((e && e.stack) || e) };
  }
})()`;
