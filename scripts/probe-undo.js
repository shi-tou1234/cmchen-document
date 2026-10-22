'use strict';
/*
 * 撤销/重做探针：移入回收站 → Ctrl+Z 恢复 → Ctrl+Shift+Z 再删；按钮可用态同步。
 * 被 test-undo.js 调用。
 */
module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 8000)) { if (fn()) return true; await sleep(80); } return !!fn(); };
  const keyDown = (opts) => document.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, opts)));

  try {
    const libReady = await waitFor(() => window.LibraryUI && LibraryUI.isOpen(), 10000);
    push('启动后文献库自动展开', libReady);
    if (!libReady) return { checks, stage: 'startup' };

    const add = await pdfBridge.lib.addPdf('__SAMPLE__', { dedupe: true });
    push('样例 PDF 入库', !!(add && add.ok), JSON.stringify((add || {}).error));
    const key = add.item.key;
    await LibraryUI.refresh();
    await waitFor(() => $$('#lib-grid .lib-card').length >= 1, 6000);

    // 初始：撤销按钮可用（刚才入库算一步），重做不可用
    await sleep(200);
    push('撤销按钮初始可用', !$('#lib-undo').disabled, '');
    push('重做按钮初始不可用', $('#lib-redo').disabled, '');

    // 移入回收站
    const itemCard = $('#lib-grid .lib-card[data-key="' + key + '"]');
    push('条目卡片存在', !!itemCard);
    const trashBtn = itemCard && itemCard.querySelector('[data-trash]');
    push('卡片上有回收站按钮', !!trashBtn);
    if (trashBtn) trashBtn.click();
    await sleep(600);
    const sum1 = await pdfBridge.lib.summary();
    const gone = !sum1.items.find((x) => x.key === key && !x.deletedAt);
    push('条目已移入回收站', gone);
    const info1 = await pdfBridge.lib.undoInfo();
    push('撤销描述是「移入回收站」', info1.canUndo && info1.undoDesc === '移入回收站', JSON.stringify(info1));

    // Ctrl+Z 撤销（焦点不在输入框）
    document.body.focus();
    keyDown({ key: 'z', ctrlKey: true });
    await sleep(800);
    const sum2 = await pdfBridge.lib.summary();
    push('Ctrl+Z 把条目撤回来了', !!sum2.items.find((x) => x.key === key && !x.deletedAt), '');
    await waitFor(() => $$('#lib-grid .lib-card').length >= 1, 5000);
    push('列表也刷新回来了', $$('#lib-grid .lib-card').length >= 1, 'cards=' + $$('#lib-grid .lib-card').length);
    const info2 = await pdfBridge.lib.undoInfo();
    push('此时可以重做', info2.canRedo === 1, JSON.stringify(info2));

    // Ctrl+Shift+Z 重做
    keyDown({ key: 'z', ctrlKey: true, shiftKey: true });
    await sleep(800);
    const sum3 = await pdfBridge.lib.summary();
    push('Ctrl+Shift+Z 重做删除了它', !sum3.items.find((x) => x.key === key && !x.deletedAt), '');

    // 工具栏按钮点一下（重做之后再撤销回来）
    $('#lib-undo').click();
    await sleep(800);
    const sum4 = await pdfBridge.lib.summary();
    push('工具栏撤销按钮也能用', !!sum4.items.find((x) => x.key === key && !x.deletedAt), '');

    // 输入框里 Ctrl+Z 不抢（浏览器自己的撤销）
    const box = $('#lib-search');
    if (box) {
      box.focus();
      const before = (await pdfBridge.lib.undoInfo()).canUndo;
      // 必须在输入框上派发（真实按键的 target 就是焦点元素）
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
      await sleep(300);
      const after = (await pdfBridge.lib.undoInfo()).canUndo;
      push('输入框里的 Ctrl+Z 不动库数据', before === after, before + '->' + after);
      box.blur();
    }

    return { checks };
  } catch (e) {
    return { checks, fatal: String((e && e.stack) || e) };
  }
})()`;
