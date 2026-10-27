'use strict';
/*
 * PDF 原生批注回复（/IRT）导入回归：
 *   pdf-lib 造一份「父便签 + 回复便签（IRT 指向父）」的 PDF，真实导入后断言：
 *   回复 shape 带 replyTo 且值等于父 shape 的 nativeId；父没有 replyTo；
 *   批注面板显示「↳ 回复：」前缀；anno-list（标注库数据源）暴露 replyTo；
 *   二次导入去重不重复加回复。
 * 运行：node scripts/test-anno-reply.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PDFDocument, PDFName, PDFHexString } = require('pdf-lib');
const { runProbe } = require('./probe-runner');

let code = 0;
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-anno-reply-'));
  const ud = path.join(tmp, 'ud');
  fs.mkdirSync(ud, { recursive: true });
  fs.mkdirSync(path.join(tmp, 'data'), { recursive: true });
  try {
    const pdf = path.join(tmp, 'reply.pdf');
    const doc = await PDFDocument.create();
    const page = doc.addPage([595, 842]);
    const font = await doc.embedFont('Helvetica');
    page.drawText('Reply tree fixture page.', { x: 72, y: 700, size: 14, font });
    const ctx = doc.context;
    const parent = ctx.obj({
      Type: PDFName.of('Annot'), Subtype: PDFName.of('Text'),
      Rect: ctx.obj([72, 700, 92, 720]), Contents: PDFHexString.fromText('parent note'),
      T: PDFHexString.fromText('Alice'), NM: PDFHexString.fromText('parent-1'), F: ctx.obj(4),
      P: page.ref,
    });
    const parentRef = ctx.register(parent);
    const reply = ctx.obj({
      Type: PDFName.of('Annot'), Subtype: PDFName.of('Text'),
      Rect: ctx.obj([72, 660, 92, 680]), Contents: PDFHexString.fromText('a reply here'),
      T: PDFHexString.fromText('Bob'), NM: PDFHexString.fromText('reply-1'), F: ctx.obj(4),
      IRT: parentRef, RT: PDFName.of('Reply'), P: page.ref,
    });
    page.node.set(PDFName.of('Annots'), ctx.obj([parentRef, ctx.register(reply)]));
    fs.writeFileSync(pdf, await doc.save());

    const probe = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 10000)) { if (await fn()) return true; await sleep(60); } return !!(await fn()); };
  const loaded = await waitFor(() => App.state.pdfDoc && App.state.rendered.get(1), 25000);
  push('PDF 已打开', loaded);
  if (!loaded) return { checks };

  // 1) 导入原生批注（含回复）
  const r1 = await window.NativeAnnos.import();
  push('导入成功且 2 条', r1 && r1.ok && r1.added === 2, JSON.stringify(r1 || {}).slice(0, 120));
  const shapes = (App.state.annos.get(1) || []);
  push('两条 shape', shapes.length === 2, 'n=' + shapes.length);
  const parentSh = shapes.find((x) => x.text === 'parent note');
  const replySh = shapes.find((x) => x.text === 'a reply here');
  push('父子都找到', !!parentSh && !!replySh);
  push('回复带 replyTo', !!(replySh && replySh.replyTo), replySh && replySh.replyTo);
  push('replyTo 指向父的 nativeId', !!(replySh && parentSh && replySh.replyTo === parentSh.nativeId), replySh && parentSh && replySh.replyTo + ' vs ' + parentSh.nativeId);
  push('父没有 replyTo', !!(parentSh && !parentSh.replyTo));

  // 2) 批注面板出现「↳ 回复：」前缀
  if (window.App && App.refreshAnnoPane) App.refreshAnnoPane(); else refreshAnnoPane();
  await sleep(200);
  const pane = document.getElementById('anno-list');
  push('面板有回复前缀', !!(pane && pane.textContent.includes('↳ 回复：')), pane && pane.textContent.slice(0, 120));

  // 3) 二次导入去重
  const r2 = await window.NativeAnnos.import();
  push('二次导入不重复', r2 && r2.ok && r2.added === 0, JSON.stringify(r2 || {}).slice(0, 100));
  push('仍为两条', (App.state.annos.get(1) || []).length === 2);

  // 4) 标注库数据源暴露 replyTo（anno-list 走 sidecar 落盘后）
  await window.pdfBridge.saveAnnos && pdfBridge.saveAnnos();
  await sleep(500);
  const lib = await pdfBridge.listAnnotations();
  const libReply = (lib || []).find((x) => x.text === 'a reply here');
  const libParent = (lib || []).find((x) => x.text === 'parent note');
  push('标注库回复带 replyTo', !!(libReply && libReply.replyTo), libReply && libReply.replyTo);
  push('标注库父无 replyTo', !!(libParent && !libParent.replyTo));
  return { checks };
})()`;
    const probeFile = path.join(tmp, 'probe.cjs');
    fs.writeFileSync(probeFile, 'module.exports=' + JSON.stringify(probe));
    const r = runProbe({
      probe: probeFile,
      env: {
        PDFREADER_DATA_DIR: path.join(tmp, 'data'),
        PDFREADER_LIBRARY: path.join(tmp, 'library.json'),
        PDFREADER_NO_AUTO_INDEX: '1',
        PDFREADER_PROBE_PDF: pdf,
      },
      args: ['--user-data-dir=' + ud],
      label: 'anno-reply',
      timeout: 240000,
    });
    assert.equal(r.fail, 0);
    code = 0;
  } catch (e) {
    console.error('[anno-reply] ERROR', e && e.message ? e.message : e);
    code = 3;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(code);
})();
