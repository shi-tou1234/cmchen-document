'use strict';
/*
 * 扁平化副本恢复探针（v1.6）：被 test-native-annos.js 的第二步调用。
 *
 * 打开的是一份「导出的带标注副本」——页面上的批注已经画进内容流，/Annots 是空的。
 * 要验的是：点「导入 PDF 批注」时，Trove 能从副本内嵌的 trove-annotations.json 里
 * 把原始批注完整拿回来（id / 颜色 / 评论 / 子类型都在），而不是只得到一片空白。
 */
module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 10000)) { if (fn()) return true; await sleep(80); } return !!fn(); };
  const errs = [];
  window.addEventListener('error', (e) => errs.push(String(e.message || e.error)));
  try {
    const ready = await waitFor(() => window.App && App.state && App.state.pdfDoc && App.state.mode === 'pdf', 20000);
    push('副本已打开', ready);
    if (!ready) return { checks };

    const before = Array.from(App.state.annos.values()).reduce((n, a) => n + a.length, 0);
    push('打开副本时标注是空的（已扁平化）', before === 0, before);

    const r = await App.importNativeAnnos();
    push('恢复成功', !!(r && r.ok), JSON.stringify(r));
    push('数据来源是副本内嵌数据', r && r.source === 'embedded', r && r.source);
    push('恢复出全部批注', r && r.added === 11, r && r.added);
    push('没有重复跳过', r && r.skipped === 0, r && r.skipped);

    const shapes = Array.from(App.state.annos.values()).flat();
    push('恢复后内存里有 11 条', shapes.length === 11, shapes.length);
    const ul = shapes.find((s) => s.kind === 'underline');
    push('子类型（下划线）保住了', !!ul, ul && ul.kind);
    push('颜色保住了', !!ul && /^#[0-9a-f]{6}$/i.test(String(ul.color || '')), ul && ul.color);
    push('稳定 id 保住了', !!ul && !!ul.id, ul && ul.id);
    const withComment = shapes.find((s) => String(s.comment || '').trim());
    push('评论保住了', !!withComment, withComment && withComment.comment);

    // 再点一次不该翻倍
    const r2 = await App.importNativeAnnos();
    push('再恢复一次不产生副本', r2 && r2.added === 0, JSON.stringify(r2));
    const after = Array.from(App.state.annos.values()).reduce((n, a) => n + a.length, 0);
    push('标注总数没有翻倍', after === 11, after);

    await App.flushAnnos();
    const saved = await pdfBridge.loadAnnos(App.state.filePath);
    const savedShapes = (saved || []).reduce((n, e) => n + (e.shapes || []).length, 0);
    push('恢复结果已落盘', savedShapes === 11, savedShapes);

    push('全程无脚本错误', errs.length === 0, errs.slice(0, 3).join(' | '));
    return { checks, source: r && r.source, added: r && r.added };
  } catch (e) {
    push('探针异常：' + (e && e.message ? e.message : e), false);
    return { checks, error: String(e && e.stack || e) };
  }
})()`;
