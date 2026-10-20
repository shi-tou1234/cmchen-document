module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 10000)) { if (fn()) return true; await sleep(60); } return !!fn(); };

  // 渲染链路：pdfjs 浏览器构建 + worker + canvas
  const rendered = await waitFor(() => App.state.pdfDoc && App.state.rendered.get(1), 15000);
  push('打包后 PDF 能渲染', rendered && App.state.numPages === 3, 'pages=' + App.state.numPages);
  const canvas = document.querySelector('#page-1 canvas');
  push('页面 canvas 有像素尺寸', !!canvas && canvas.width > 100 && canvas.height > 100, canvas && (canvas.width + 'x' + canvas.height));

  // 主进程全文索引：验证 asar 里的 pdfjs-dist/build/pdf.js 能加载
  const idx = await pdfBridge.lib.indexAll(true);
  push('打包后主进程能建全文索引', idx && idx.ok && idx.failed === 0 && idx.done >= 1, JSON.stringify(idx && { done: idx.done, failed: idx.failed, errors: idx.errors }));
  const st = await pdfBridge.lib.ftStatus();
  push('打包后索引状态正常', st && st.indexedItems >= 1, JSON.stringify(st));

  // 库级搜索
  const ft = await pdfBridge.lib.searchFull('sample page 2');
  push('打包后库级全文搜索命中', ft && ft.ok && ft.results.length >= 1, JSON.stringify(ft && ft.results.slice(0, 2)));
  push('搜索结果带页码与片段', !!(ft && ft.results[0] && ft.results[0].page === 2 && /Sample page 2/.test(ft.results[0].snippet)), JSON.stringify(ft && ft.results[0]));

  // 导出副本：验证 asar 里的 pdf-lib + 渲染层字节回传
  App.state.annos.set(1, [{ tool: 'mark', color: '#ffeb3b', rects: [{ x: 60, y: 80, w: 120, h: 16 }], text: 'packaged export' }]);
  Anno.renderPage(1);
  const s = await pdfBridge.getSettings();
  const outPath = String(s.dataDir).replace(/[\\\\/]+$/, '') + '/packaged-export.pdf';
  const payload = App.buildExportPayload(outPath);
  const exp = await pdfBridge.exportPdf(payload);
  push('打包后能导出带标注副本', exp && exp.ok && exp.skipped === 0, JSON.stringify(exp));

  return { checks, outPath: exp && exp.path, asar: location.href.indexOf('app.asar') >= 0 };
})()`;
