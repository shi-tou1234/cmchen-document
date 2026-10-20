'use strict';
/*
 * 恢复探针：第二次启动（同一 userData），断言上一次的标注从磁盘自动恢复。
 */
module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const checks = [];
  const push = (n, ok, detail) => checks.push([n, !!ok, detail == null ? '' : String(detail)]);
  for (let i = 0; i < 200 && !App.state.pdfDoc; i++) await sleep(50);
  if (!App.state.pdfDoc) return { fatal: 'doc not loaded' };
  await sleep(1000); // restoreAnnos 是异步的，等它完成并重绘
  const shapes = App.state.annos.get(1) || [];
  push('标注已自动恢复(>=2条)', shapes.length >= 2, 'n=' + shapes.length);
  push('便签恢复且文本一致', shapes.some((s) => s.tool === 'note' && s.text === '探针便签'));
  push('便签标记已重绘', !!document.querySelector('#page-1 .anno .note-mark'));
  return { checks };
})()`;
