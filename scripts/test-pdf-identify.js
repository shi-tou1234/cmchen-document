'use strict';
/*
 * PDF 首页文本抽取 + 标识识别（2026-10-29）
 * 用 pdf-lib 现场生成两个 PDF：
 *   1. 页脚写 DOI 的论文 → readFirstPageText 能读到，doiscan 能抽出来；
 *   2. 只有正文、没有标识的文档 → 抽得到文本，但抽不到标识（不能瞎猜）。
 * 这一步验证「本地半段」（取文本 + 正则），网络半段由 test-metadata 覆盖。
 * 运行：node scripts/test-pdf-identify.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const pdfmeta = require('../src/pdfmeta.js');
const doiscan = require('../src/doiscan.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-identify-'));
let n = 0;
function ok(name, fn) {
  fn();
  n++;
  console.log('  ok ' + n + ' - ' + name);
}

async function makePdf(file, lines) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  let y = 760;
  for (const line of lines) {
    page.drawText(line, { x: 50, y, size: 11, font });
    y -= 20;
  }
  fs.writeFileSync(file, await doc.save());
  return file;
}

(async () => {
  try {
    const withDoi = await makePdf(path.join(tmp, 'with-doi.pdf'), [
      'A Study of Local-first Reference Managers',
      'Jane Smith, Wei Zhang',
      'Journal of Digital Libraries, 2024',
      'https://doi.org/10.1234/jdl.2024.0042',
    ]);
    const text = await pdfmeta.readFirstPageText(withDoi, 1, 4000);
    ok('首页文本能读出来', () => {
      assert.ok(text.length > 20, '抽取结果太短: ' + text.length);
      assert.ok(/Local-first/i.test(text), '应包含标题文字');
    });
    ok('从首页文本抽出 DOI', () => {
      const ids = doiscan.extractIdentifiers(text);
      assert.equal(ids.doi, '10.1234/jdl.2024.0042', '实际: ' + ids.doi);
      assert.equal(ids.source, 'doi');
    });

    const noId = await makePdf(path.join(tmp, 'no-id.pdf'), [
      'Meeting notes, draft',
      'We discussed three things. No identifier on this page.',
    ]);
    const text2 = await pdfmeta.readFirstPageText(noId, 1, 4000);
    ok('没有标识时不硬猜', () => {
      assert.ok(text2.length > 0, '应读到文本');
      assert.equal(doiscan.extractIdentifiers(text2).identifier, '');
    });

    const missing = await pdfmeta.readFirstPageText(path.join(tmp, 'missing.pdf'), 1, 1000);
    ok('文件不存在时安静返回空串', () => {
      assert.equal(missing, '');
    });
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  console.log('\ntest-pdf-identify: ' + n + ' 项通过');
})().catch((err) => {
  console.error('[pdf-identify] FAIL', err && err.stack ? err.stack : err);
  process.exit(1);
});
