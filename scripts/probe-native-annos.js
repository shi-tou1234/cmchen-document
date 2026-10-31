module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 12000)) { if (fn()) return true; await sleep(80); } return !!fn(); };
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const OUT = __OUTPDF__;

  await waitFor(() => App.state.pdfDoc && App.state.rendered.get(1), 15000);
  await sleep(700);
  push('PDF 已加载', !!App.state.pdfDoc);

  const r1 = await App.importNativeAnnos();
  push('扫描到 11 条可导入形状', r1 && r1.added === 11, JSON.stringify(r1));
  push('不支持的类型计入 skipped', r1 && r1.skipped === 1, JSON.stringify(r1));

  const all = [];
  for (const arr of App.state.annos.values()) all.push(...arr);
  const by = (t, k) => all.filter((s) => s.tool === t && (!k || s.kind === k));
  const marks = by('mark');
  const hl = marks.find((s) => !s.kind);
  const ul = marks.find((s) => s.kind === 'underline');
  const sq = marks.find((s) => s.kind === 'squiggly');
  const so = marks.find((s) => s.kind === 'strike');
  const notes = by('note');
  const texts = by('text');
  const pens = by('pen');
  const rects = by('rect');
  const lines = by('line');

  push('高亮导入为普通 mark', !!hl, marks.length);
  push('下划线导入为 mark/underline', !!ul);
  push('波浪线导入为 mark/squiggly', !!sq);
  push('删除线导入为 mark/strike', !!so);
  push('高亮取到原文', !!hl && /Native highlight target sentence/.test(hl.text), hl && hl.text);
  push('下划线取到原文', !!ul && /Underlined words here/.test(ul.text), ul && ul.text);
  push('高亮评论保留', !!hl && hl.comment === 'native comment', hl && hl.comment);
  push('颜色转成十六进制', !!hl && hl.color === '#ffd933', hl && hl.color);
  push('作者保留', !!hl && hl.author === 'Alice', hl && hl.author);
  push('便签导入为 note', notes.length === 1 && notes[0].text === 'sticky note', notes.map((s) => s.text).join('|'));
  push('文字框导入为 text', texts.length === 1 && texts[0].text === 'free text native');
  push('两笔手绘导入为两条 pen', pens.length === 2 && pens.every((s) => s.pts.length >= 2), pens.length);
  push('方框导入为 rect', rects.length === 1);
  push('直线导入为 line', lines.length === 1);
  push('每条形状都带原生 id', all.length === 11 && all.every((s) => s.nativeId), all.length);

  const pg2 = await App.state.pdfDoc.getPage(2);
  const vp2 = pg2.getViewport({ scale: 1 });
  const p2shapes = App.state.annos.get(2) || [];
  const rmark = p2shapes.find((s) => s.tool === 'mark');
  push('旋转页 + CropBox 的批注也导入', !!rmark, p2shapes.length);
  push('旋转页原文正确', !!rmark && /Rotated target/.test(rmark.text), rmark && rmark.text);
  push('旋转页坐标落在页面内', !!rmark && rmark.rects.every((r) =>
    r.x >= -1 && r.y >= -1 && r.x + r.w <= vp2.width + 1 && r.y + r.h <= vp2.height + 1),
    rmark && JSON.stringify({ rects: rmark.rects, vp: [vp2.width, vp2.height, vp2.rotation] }));

  const r2 = await App.importNativeAnnos();
  push('重复导入不产生副本', r2 && r2.added === 0, JSON.stringify(r2));
  push('重复导入全部计为已存在', r2 && r2.skipped === 12, JSON.stringify(r2));
  const totalAfter = Array.from(App.state.annos.values()).reduce((n, a) => n + a.length, 0);
  push('标注总数没有翻倍', totalAfter === 11, totalAfter);

  await App.flushAnnos();
  const saved = await pdfBridge.loadAnnos(App.state.filePath);
  const savedShapes = (saved || []).reduce((n, e) => n + (e.shapes || []).length, 0);
  push('导入结果已落盘', savedShapes === 11, savedShapes);
  const savedUl = (saved || []).flatMap((e) => e.shapes || []).find((s) => s.kind === 'underline');
  push('落盘保留 kind', !!savedUl, JSON.stringify(savedUl && savedUl.kind));

  const payload = App.buildExportPayload();
  const outShapes = (payload.pages || []).flatMap((p) => p.shapes || []);
  const outUl = outShapes.find((s) => s.kind === 'underline');
  push('导出 payload 带 kind', !!outUl, outShapes.filter((s) => s.kind).length);
  // v1.6：给「扁平化后可恢复」的那份原始数据
  push('导出 payload 带可恢复数据', !!(payload.recover && payload.recover.pages && payload.recover.pages.length),
    payload.recover && payload.recover.pages && payload.recover.pages.length);
  const recShapes = ((payload.recover || {}).pages || []).flatMap((p) => p.shapes || []);
  push('可恢复数据保留稳定 id', recShapes.every((s) => !!s.id), recShapes.length);
  payload.outPath = OUT;
  const res = await pdfBridge.exportPdf(payload);
  push('导出结果标记了「已内嵌批注数据」', !!(res && res.embedded), JSON.stringify(res && { ok: res.ok, embedded: res.embedded }));

  document.querySelector('#btn-sidebar').click();
  await sleep(250);
  const tab = document.querySelector('.sb-tab[data-tab="annos"]');
  if (tab) tab.click();
  await sleep(400);
  push('批注面板出现导入按钮', !!document.querySelector('#anno-import-native'));
  const rows = document.querySelectorAll('#anno-list .anno-item');
  push('侧栏列出导入的批注', rows.length === 11, rows.length);

  return {
    checks,
    outPath: res && res.path,
    exportOk: !!(res && res.ok),
    exportSkipped: res && res.skipped,
    exportError: res && res.error,
    exportReasons: res && res.reasons,
  };
})()`;
