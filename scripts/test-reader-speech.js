'use strict';
/*
 * v35 朗读回归：跨页连续 + 句级高亮 + 暂停恢复 + 位置记忆。
 * 测试 PDF 现场生成：第 1 页 3 句、第 2 页空白、第 3 页 1 句，用来验证空白页跳过。
 * 运行：node scripts/test-reader-speech.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { runProbe } = require('./probe-runner');

let code = 0;
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-speech-'));
  const ud = path.join(tmp, 'ud');
  fs.mkdirSync(ud);
  try {
    const pdf = path.join(tmp, 'speech.pdf');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const p1 = doc.addPage([612, 792]);
    p1.drawText('First sentence. Second sentence. Third sentence.', { x: 60, y: 700, size: 18, font });
    doc.addPage([612, 792]);   // 空白页：朗读应跳过
    const p3 = doc.addPage([612, 792]);
    p3.drawText('Last page text.', { x: 60, y: 700, size: 18, font });
    fs.writeFileSync(pdf, await doc.save());

    const env = {
      PDFREADER_DATA_DIR: tmp,
      PDFREADER_LIBRARY: path.join(tmp, 'library.json'),
      PDFREADER_NO_AUTO_INDEX: '1',
    };
    const inject = { __PDF__: pdf.replace(/\\/g, '/') };

    const r1 = runProbe({
      probePath: path.join(__dirname, 'probe-reader-speech.js'),
      tmpDir: tmp,
      inject: Object.assign({ __MODE__: 'first' }, inject),
      env,
      args: ['--user-data-dir=' + ud],
      label: 'speech-first',
      timeout: 240000,
    });
    if (r1.fail) throw new Error('朗读首轮失败');

    // 同一 userData 再启动：验证 localStorage 里的句序能跨启动恢复
    const r2 = runProbe({
      probePath: path.join(__dirname, 'probe-reader-speech.js'),
      tmpDir: tmp,
      inject: Object.assign({ __MODE__: 'second' }, inject),
      env,
      args: ['--user-data-dir=' + ud],
      label: 'speech-second',
      timeout: 240000,
    });
    if (r2.fail) throw new Error('朗读跨启动恢复失败');

    code = 0;
  } catch (e) {
    console.error('[reader-speech] ERROR', e && e.message ? e.message : e);
    code = 3;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(code);
})();
