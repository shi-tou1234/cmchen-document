'use strict';
/*
 * 重命名附件探针：文件改名 + attachment 更新 + 标注随迁 + 冲突加序号 + 详情按钮。
 * 被 test-rename-file.js 调用。
 */
module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 8000)) { if (fn()) return true; await sleep(80); } return !!fn(); };
  const base = (p) => String(p || '').split(/[\\\\/]/).pop();

  try {
    const libReady = await waitFor(() => window.LibraryUI && LibraryUI.isOpen(), 10000);
    push('启动后文献库自动展开', libReady);
    if (!libReady) return { checks, stage: 'startup' };

    // 1. 两本入库，补元数据（作者 / 年份 / 标题）
    const a1 = await pdfBridge.lib.addPdf('__PDF1__', { dedupe: true });
    const a2 = await pdfBridge.lib.addPdf('__PDF2__', { dedupe: true });
    push('两本 PDF 入库', !!(a1 && a1.ok && a2 && a2.ok), JSON.stringify([(a1 || {}).error, (a2 || {}).error]));
    const k1 = a1.item.key, k2 = a2.item.key;
    const meta = {
      title: '深度学习综述', year: '2024',
      creators: [{ firstName: 'John', lastName: 'Smith', creatorType: 'author' }],
    };
    await pdfBridge.lib.updateItem(k1, meta);
    // 第二本用同作者同年同标题 → 改名时必然冲突，应自动加序号
    await pdfBridge.lib.updateItem(k2, meta);
    await LibraryUI.refresh();

    // 2. 给第一本写一条标注（验证改名后标注随迁）
    const sum0 = await pdfBridge.lib.summary();
    const p1 = sum0.items.find((x) => x.key === k1).attachment.path;
    await pdfBridge.saveAnnos(p1, [{ page: 1, shapes: [{ id: 'aRenameTest1', tool: 'mark', color: '#ffd54f', rects: [{ x: 10, y: 10, w: 100, h: 20 }], text: '改名前的标注', comment: '' }] }]);

    // 3. 单条重命名（详情按钮的底层 IPC）
    const r1 = await pdfBridge.lib.renameFile([k1]);
    push('重命名成功', !!(r1 && r1.ok && r1.renamed === 1), JSON.stringify(r1));
    const newPath = ((r1 && r1.changes && r1.changes[0]) || {}).newPath || '';
    push('新文件名按「作者 - 年份 - 标题」', base(newPath) === 'Smith - 2024 - 深度学习综述.pdf', base(newPath));
    push('旧文件已不存在', !(await pdfBridge.lib.summary()).items.find((x) => x.key === k1).attachment.path.includes('raw-a'), '');
    const sum1 = await pdfBridge.lib.summary();
    const it1 = sum1.items.find((x) => x.key === k1);
    push('attachment 路径 / 文件名已更新', it1.attachment.path === newPath && it1.attachment.name === base(newPath), it1.attachment.name);

    // 4. 标注跟着搬（读新路径能读回，旧路径读不到）
    const annosNew = await pdfBridge.loadAnnos(newPath);
    const kept = !!(annosNew[0] && annosNew[0].shapes[0] && annosNew[0].shapes[0].text === '改名前的标注');
    push('标注文件随迁到新路径', kept, JSON.stringify(annosNew[0] && annosNew[0].shapes[0]));
    const annosOld = await pdfBridge.loadAnnos(p1);
    push('旧路径不再有标注文件', !(annosOld && annosOld.length), JSON.stringify(annosOld && annosOld.length));
    const list = await pdfBridge.listAnnotations();
    push('标注列表指向新路径', (list || []).some((a) => a.path === newPath && a.text === '改名前的标注'), '');

    // 5. 第二本改名：同名冲突自动加序号
    const r2 = await pdfBridge.lib.renameFile([k2]);
    push('第二条也改名成功', !!(r2 && r2.ok && r2.renamed === 1), JSON.stringify(r2 && r2.errors));
    const p2 = (await pdfBridge.lib.summary()).items.find((x) => x.key === k2).attachment.path;
    push('同名冲突自动加 (2)', /Smith - 2024 - 深度学习综述 \\(2\\)\\.pdf$/.test(p2), base(p2));

    // 6. 再跑一次：文件名已符合规则 → 跳过
    const r3 = await pdfBridge.lib.renameFile([k1]);
    push('已符合规则时跳过', !!(r3 && r3.skipped === 1 && r3.renamed === 0), JSON.stringify({ skipped: r3 && r3.skipped, renamed: r3 && r3.renamed }));

    // 7. 详情面板有「按条目重命名」按钮
    await LibraryUI.refresh();
    $('#lib-grid .lib-card[data-key="' + k1 + '"]').click();
    await waitFor(() => !$('#lib-detail').hidden, 4000);
    const btn = await waitFor(() => $('#ld-attach [data-ld-rename]'), 4000);
    push('详情附件区有「按条目重命名」按钮', !!btn, '');
    const bulkBtn = $('#lib-bulk-rename');
    push('批量栏有「重命名文件」按钮', !!bulkBtn, '');

    return { checks };
  } catch (e) {
    return { checks, fatal: String((e && e.stack) || e) };
  }
})()`;
