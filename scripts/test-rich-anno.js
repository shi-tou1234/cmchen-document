'use strict';
/*
 * 富文档（Word / PPT / Markdown…）文字标注回归（v9.5）：
 *   高亮 / 下划线 / 评论在富文档页上也要能用，位置随页面保存，重开恢复。
 * 运行：node scripts/test-rich-anno.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');
const { runProbe } = require('./probe-runner');

function xmlHeader(tag, attrs) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><' + tag + (attrs || '') + '>';
}

async function makeDocx(file) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', xmlHeader('Types', ' xmlns="http://schemas.openxmlformats.org/package/2006/content-types"') +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>');
  zip.file('_rels/.rels', xmlHeader('Relationships', ' xmlns="http://schemas.openxmlformats.org/package/2006/relationships"') +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>');
  zip.file('word/document.xml', xmlHeader('w:document', ' xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"') +
    '<w:body>' +
    '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>第一段加粗文字，用来测试高亮</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>第二段普通文字，用来测试下划线</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>第三段文字，用来测试评论</w:t></w:r></w:p>' +
    '</w:body></w:document>');
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
}

let code = 0;
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-richanno-'));
  const udd = path.join(tmp, 'ud');
  fs.mkdirSync(udd);
  const docx = path.join(tmp, '标注测试.docx');
  try {
    await makeDocx(docx);
    const { fail } = runProbe({
      probePath: path.join(__dirname, 'probe-rich-anno.js'),
      tmpDir: tmp,
      inject: { __DOCX__: docx.replace(/\\/g, '/') },
      env: {
        PDFREADER_DATA_DIR: tmp,
        PDFREADER_LIBRARY: path.join(tmp, 'library.json'),
        PDFREADER_NO_AUTO_INDEX: '1',
      },
      args: ['--user-data-dir=' + udd],
      label: 'rich-anno',
      timeout: 300000,
    });
    code = fail ? 2 : 0;
  } catch (e) {
    console.error('[rich-anno] ERROR', e && e.message ? e.message : e);
    code = 3;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(code);
})();
