module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 10000)) { if (fn()) return true; await sleep(60); } return !!fn(); };
  await waitFor(() => App.state.pdfDoc && App.state.rendered.get(1), 12000);
  await sleep(600);

  const spans = Array.from(document.querySelectorAll('#page-1 .textlayer span')).filter((s) => (s.textContent || '').trim());
  push('文本层可选中', spans.length > 0, 'spans=' + spans.length);
  if (!spans.length) return { checks };

  // 真实选区 → 高亮
  const node = spans[0].firstChild || spans[0];
  const range = document.createRange();
  range.setStart(node, 0);
  range.setEnd(node, node.textContent.length);
  const sel = window.getSelection();
  sel.removeAllRanges(); sel.addRange(range);
  $('#viewer').dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 100, clientY: 100 }));
  await waitFor(() => !$('#sel-bar').hidden, 3000);
  $('#sel-bar [data-sel="highlight"]').click();
  await waitFor(() => (App.state.annos.get(1) || []).some((s) => s.tool === 'mark'), 3000);
  const mark = (App.state.annos.get(1) || []).find((s) => s.tool === 'mark');
  push('高亮写入模型', !!mark && mark.rects.length > 0, JSON.stringify(mark && { color: mark.color, rects: mark.rects.length }));

  // 再放一条中文文字标注：导出用的 Helvetica 不支持 CJK，应该被 per-shape 跳过而不是让整次导出失败
  App.state.annos.get(1).push({ tool: 'text', color: '#e53935', size: 14, at: { x: 120, y: 200 }, text: '中文标注' });
  Anno.renderPage(1);

  const st = await pdfBridge.getSettings();
  const outPath = String(st.dataDir).replace(/[\\\\/]+$/, '') + '/export-highlight.pdf';
  const payload = App.buildExportPayload(outPath);
  const rect = payload.pages[0].shapes.find((s) => s.tool === 'mark').rects[0];
  push('导出矩形是 PDF 坐标系', Number.isFinite(rect.x) && Number.isFinite(rect.y) && rect.w > 0 && rect.h > 0, JSON.stringify(rect));

  const res = await pdfBridge.exportPdf(payload);
  push('导出副本成功', res && res.ok && !!res.path, JSON.stringify(res));
  // v36：有系统 CJK 字体时中文用子集嵌入导出（不再被跳过）；没有字体时退回跳过并计数
  const hasCjk = !!(res && res.cjk);
  push(hasCjk ? '中文标注用系统 CJK 字体子集导出' : '没有 CJK 字体时中文标注被跳过并计数',
    hasCjk ? (res.skipped === 0 && typeof res.missingGlyphs === 'number') : res.skipped === 1,
    JSON.stringify({ skipped: res && res.skipped, cjk: res && res.cjk, font: res && res.cjkFont, missing: res && res.missingGlyphs }));

  return { checks, outPath: res && res.path, color: mark.color, rect, markText: mark.text, cjk: !!(res && res.cjk), cjkFont: res && res.cjkFont };
})()`;
