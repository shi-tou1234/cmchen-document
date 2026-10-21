'use strict';
/*
 * 富文档端到端回归（v27）：
 *   在真实 Electron（Node 20）里打开 docx / xlsx / epub，验证主进程转换、IPC、
 *   富文档渲染、缩放、页内搜索、页码跳转与引用信息都通。
 *
 * 纯 Node 的格式单测在 test-docconvert.js；这里专门补「Electron 兼容性 + 界面」。
 * 运行：node scripts/test-richdoc.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');
const XLSX = require('xlsx');
const { runProbe } = require('./probe-runner');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-rich-'));
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

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
    '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>第一段加粗文字</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>第二段普通文字</w:t></w:r></w:p>' +
    '</w:body></w:document>');
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
}

function makeXlsx(file) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['姓名', '分数'], ['张三', 90], ['李四', 85]]), '成绩汇总');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['备注'], ['第二章']]), '备注表');
  XLSX.writeFile(wb, file);
}

async function makeEpub(file) {
  const zip = new JSZip();
  zip.file('META-INF/container.xml', xmlHeader('container', ' xmlns="urn:oasis:names:tc:opendocument:xmlns:container"') +
    '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('OEBPS/content.opf', xmlHeader('package', ' xmlns="http://www.idpf.org/2007/opf"') +
    '<manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>' +
    '<item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>' +
    '<item id="img" href="pic.png" media-type="image/png"/></manifest>' +
    '<spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>');
  zip.file('OEBPS/ch1.xhtml', xmlHeader('html', ' xmlns="http://www.w3.org/1999/xhtml"') +
    '<body><h1>第一章 开始</h1><p>第一章正文</p><p><img src="pic.png" alt="插图"/></p></body></html>');
  zip.file('OEBPS/ch2.xhtml', xmlHeader('html', ' xmlns="http://www.w3.org/1999/xhtml"') +
    '<body><h1>第二章 继续</h1><p>第二章正文</p></body></html>');
  zip.file('OEBPS/pic.png', PNG_1PX);
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
}

let code = 0;
(async () => {
  const udd = path.join(TMP, 'ud');
  fs.mkdirSync(udd);
  const docx = path.join(TMP, '测试文档.docx');
  const xlsx = path.join(TMP, '成绩表.xlsx');
  const epub = path.join(TMP, '电子书.epub');
  const libFile = path.join(TMP, 'library.json');
  try {
    await makeDocx(docx);
    makeXlsx(xlsx);
    await makeEpub(epub);
    fs.writeFileSync(libFile, JSON.stringify({
      version: 3, collections: [], searches: [],
      items: [
        { key: 'itDocx', itemType: 'document', title: '测试 Word 文档', creators: ['张三'], year: '2024', tags: [], collectionIds: [], attachment: { path: docx, name: path.basename(docx) }, page: 1, created: 3, updated: 3 },
        { key: 'itXlsx', itemType: 'dataset', title: '成绩表', creators: ['李四'], year: '2024', tags: [], collectionIds: [], attachment: { path: xlsx, name: path.basename(xlsx) }, page: 1, created: 2, updated: 2 },
        { key: 'itEpub', itemType: 'book', title: '电子书', creators: ['王五'], year: '2024', tags: [], collectionIds: [], attachment: { path: epub, name: path.basename(epub) }, page: 1, created: 1, updated: 1 },
      ],
    }, null, 2));

    const { fail } = runProbe({
      probe: path.join(__dirname, 'probe-richdoc.js'),
      env: {
        PDFREADER_DATA_DIR: TMP,
        PDFREADER_LIBRARY: libFile,
        PDFREADER_NO_AUTO_INDEX: '1',
      },
      args: ['--user-data-dir=' + udd],
      label: 'richdoc',
      timeout: 240000,
    });
    code = fail ? 2 : 0;
  } catch (e) {
    console.error('[richdoc] ERROR', e && e.message ? e.message : e);
    code = 3;
  } finally {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(code);
})();
