module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 8000)) { if (fn()) return true; await sleep(60); } return !!fn(); };
  await waitFor(() => App.state.pdfDoc && App.state.rendered.get(1), 10000);
  await sleep(500);
  const spans = Array.from(document.querySelectorAll('#page-1 .textlayer span')).filter((s) => (s.textContent || '').trim());
  push('文本层可选中', spans.length > 0, 'spans=' + spans.length);
  if (!spans.length) return { checks };

  function selectSpan(span) {
    const node = span.firstChild || span;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, node.textContent.length);
    const sel = window.getSelection();
    sel.removeAllRanges(); sel.addRange(range);
    $('#viewer').dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 100, clientY: 100 }));
  }

  selectSpan(spans[0]);
  await waitFor(() => !$('#sel-bar').hidden, 3000);
  push('选中文字出现浮动工具条', !$('#sel-bar').hidden, $('#sel-bar').hidden);
  $('#sel-bar [data-sel="highlight"]').click();
  await waitFor(() => (App.state.annos.get(1) || []).some((s) => s.tool === 'mark'), 3000);
  const mark = (App.state.annos.get(1) || []).find((s) => s.tool === 'mark');
  push('高亮写入标注模型', !!mark, JSON.stringify(mark && { text: mark.text, rects: mark.rects.length }));
  push('选区矩形坐标有效', !!mark && mark.rects.length > 0 && Number.isFinite(mark.rects[0].x) && mark.rects[0].w > 0, JSON.stringify(mark && mark.rects[0]));
  await sleep(120);
  push('高亮在页面 SVG 中渲染', $$('#page-1 .anno-base .text-mark').length > 0 || document.querySelectorAll('#page-1 .anno-base .text-mark').length > 0);

  // 第二次选中并加评论
  selectSpan(spans[spans.length - 1]);
  await waitFor(() => !$('#sel-bar').hidden, 3000);
  $('#sel-bar [data-sel="comment"]').click();
  await waitFor(() => !$('#comment-modal').hidden, 2000);
  $('#comment-text').value = '这是一条测试评论';
  $('#comment-save').click();
  await waitFor(() => (App.state.annos.get(1) || []).some((s) => s.tool === 'mark' && s.comment), 3000);
  const cm = (App.state.annos.get(1) || []).find((s) => s.tool === 'mark' && s.comment);
  push('高亮+评论保存到模型', !!cm && cm.comment === '这是一条测试评论', cm && cm.comment);

  await App.flushAnnos();
  const saved = await pdfBridge.loadAnnos(App.state.filePath);
  const flat = (saved || []).reduce((acc, x) => acc.concat(x.shapes || []), []);
  push('高亮与评论写入标注文件', flat.some((s) => s.tool === 'mark' && s.comment === '这是一条测试评论'), JSON.stringify(flat.map((s) => s.tool)));
  const payload = App.buildExportPayload();
  const ex = payload.pages[0] && payload.pages[0].shapes.filter((s) => s.tool === 'mark')[0];
  push('导出 payload 含高亮矩形', !!ex && ex.rects.length > 0 && Number.isFinite(ex.rects[0].x), JSON.stringify(ex && ex.rects[0]));
  await sleep(100);
  return { checks, markCount: (App.state.annos.get(1) || []).length, saved: flat.length };
})()`;
