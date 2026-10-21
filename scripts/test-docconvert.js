'use strict';
/*
 * 全格式文档转换回归（v27 起）。
 * 纯 Node，不启 Electron：现造 docx / pptx / xlsx / odt / epub / md / html / csv / txt，
 * 检查 readDocument 的页结构、文本抽取、图片内联与 sanitize 结果。
 *
 * 运行：node scripts/test-docconvert.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');
const XLSX = require('xlsx');
const iconv = require('iconv-lite');
const Doc = require(path.join(__dirname, '..', 'src', 'docconvert.js'));

let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) console.log('  ok   ' + name);
  else { fail++; console.log('  FAIL ' + name + (detail ? '  <- ' + detail : '')); }
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-doc-'));
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function xmlHeader(body, attrs) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<' + body + (attrs || '') + '>';
}

// ---------- 夹具 ----------
async function makeDocx(file) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', xmlHeader('Types', ' xmlns="http://schemas.openxmlformats.org/package/2006/content-types"') +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '</Types>');
  zip.file('_rels/.rels', xmlHeader('Relationships', ' xmlns="http://schemas.openxmlformats.org/package/2006/relationships"') +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '</Relationships>');
  zip.file('docProps/core.xml', xmlHeader('cp:coreProperties',
    ' xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"' +
    ' xmlns:dc="http://purl.org/dc/elements/1.1/">') +
    '<dc:title>测试 Word 文档</dc:title><dc:creator>张三</dc:creator></cp:coreProperties>');
  zip.file('word/document.xml', xmlHeader('w:document',
    ' xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"') +
    '<w:body>' +
    '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>第一段加粗文字</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>第二段普通文字</w:t></w:r></w:p>' +
    '</w:body></w:document>');
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
}

async function makePptx(file) {
  const zip = new JSZip();
  const slide = (title, body) => xmlHeader('p:sld',
    ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"' +
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"') +
    '<p:cSld><p:spTree><p:sp><p:txBody>' +
    '<a:p><a:r><a:t>' + title + '</a:t></a:r></a:p>' +
    '<a:p><a:r><a:t>' + body + '</a:t></a:r></a:p>' +
    '</p:txBody></p:sp></p:spTree></p:cSld></p:sld>';
  zip.file('ppt/slides/slide2.xml', slide('第二页', '第二页正文') +
    '<p:pic><p:blipFill><a:blip r:embed="rId2"/></p:blipFill></p:pic>');
  zip.file('ppt/slides/slide1.xml', slide('第一页', '第一页正文'));
  zip.file('ppt/slides/_rels/slide2.xml.rels', xmlHeader('Relationships',
    ' xmlns="http://schemas.openxmlformats.org/package/2006/relationships"') +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>' +
    '</Relationships>');
  zip.file('ppt/media/image1.png', PNG_1PX);
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
}

function makeXlsx(file) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([['姓名', '分数'], ['张三', 90], ['李四', 85]]);
  XLSX.utils.book_append_sheet(wb, ws, '成绩汇总');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[]]), '空表');
  XLSX.writeFile(wb, file);
}

function makeCsv(file) {
  // 故意用 GB18030，验证无 BOM 时的中文兜底解码
  fs.writeFileSync(file, iconv.encode('姓名,分数\n王五,88\n', 'gb18030'));
}

async function makeOdt(file) {
  const zip = new JSZip();
  zip.file('content.xml', xmlHeader('office:document-content',
    ' xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"' +
    ' xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"' +
    ' xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"') +
    '<office:body><office:text>' +
    '<text:h text:outline-level="1">第一章</text:h><text:p>第一章正文</text:p>' +
    '<text:h text:outline-level="1">第二章</text:h><text:p>第二章正文</text:p>' +
    '</office:text></office:body></office:document-content>');
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
}

async function makeEpub(file) {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  zip.file('META-INF/container.xml', xmlHeader('container',
    ' xmlns="urn:oasis:names:tc:opendocument:xmlns:container"') +
    '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('OEBPS/content.opf', xmlHeader('package',
    ' xmlns="http://www.idpf.org/2007/opf"') +
    '<manifest>' +
    '<item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>' +
    '<item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>' +
    '<item id="img" href="images/pic.png" media-type="image/png"/>' +
    '</manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>');
  zip.file('OEBPS/ch1.xhtml', xmlHeader('html', ' xmlns="http://www.w3.org/1999/xhtml"') +
    '<head><title>第一章</title></head><body>' +
    '<h1>第一章 开始</h1><p>第一章正文</p>' +
    '<p><img src="images/pic.png" alt="插图"/></p>' +
    '<p><img src="https://evil.example/x.png" alt="远程图"/></p>' +
    '<script>alert(1)</script>' +
    '</body></html>');
  zip.file('OEBPS/ch2.xhtml', xmlHeader('html', ' xmlns="http://www.w3.org/1999/xhtml"') +
    '<head><title>第二章</title></head><body><h1>第二章 继续</h1>' +
    '<p onclick="alert(2)">第二章正文</p></body></html>');
  zip.file('OEBPS/images/pic.png', PNG_1PX);
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
}

function makeMd(file) {
  const img = path.join(TMP, 'pic.png');
  fs.writeFileSync(img, PNG_1PX);
  fs.writeFileSync(file, [
    '# 第一部分',
    '',
    '第一段 **加粗** 文字。',
    '',
    '![本地图](pic.png)',
    '',
    '![远程图](https://evil.example/x.png)',
    '',
    '<script>alert(1)</script>',
    '',
    '```js',
    'const a = 1;',
    '```',
    '',
    '# 第二部分',
    '',
    '第二段文字。',
  ].join('\n'));
}

function makeHtml(file) {
  fs.writeFileSync(file, xmlHeader('html') +
    '<head><title>网页标题</title><script>alert(1)</script></head>' +
    '<body><p onclick="alert(2)">正文 <b>加粗</b></p>' +
    '<img src="x.png" onerror="alert(3)">' +
    '<a href="javascript:alert(4)">坏链接</a></body></html>');
}

function makeTxt(file) {
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('第一行\n第二行\n', 'utf8')]));
}

// ---------- 断言 ----------
(async () => {
  try {
    // 基础能力
    ok('isSupported 大小写不敏感', Doc.isSupported('A.DOCX') === true);
    ok('isSupported 认 epub', Doc.isSupported('book.epub') === true);
    ok('isSupported 拒绝未知扩展名', Doc.isSupported('a.xyz') === false);
    ok('labelFor 返回中文格式名', Doc.labelFor('a.xlsx') === 'Excel 工作簿', Doc.labelFor('a.xlsx'));
    ok('titleFromPath 去掉序号与下划线', Doc.titleFromPath('03 _hello_world.docx') === 'hello world', Doc.titleFromPath('03 _hello_world.docx'));

    // DOCX
    const docx = path.join(TMP, 'sample.docx');
    await makeDocx(docx);
    let r = await Doc.readDocument(docx);
    ok('docx 转换成功', r.ok === true && r.kind === 'rich', JSON.stringify(r).slice(0, 200));
    ok('docx 为单页', r.pages.length === 1, String(r.pages.length));
    ok('docx 保留加粗', /<strong>第一段加粗文字<\/strong>/.test(r.pages[0].html), r.pages[0].html);
    ok('docx 文本含两段', r.pages[0].text.indexOf('第二段普通文字') >= 0, r.pages[0].text);
    const meta = await Doc.readZipCoreMeta(docx);
    ok('docx 读取核心元数据标题', meta.title === '测试 Word 文档', meta.title);
    ok('docx 读取核心元数据作者', meta.author === '张三', meta.author);

    // PPTX
    const pptx = path.join(TMP, 'sample.pptx');
    await makePptx(pptx);
    r = await Doc.readDocument(pptx);
    ok('pptx 每页一张幻灯片', r.ok === true && r.pages.length === 2, String(r.pages.length));
    ok('pptx 按 slide 编号排序', r.pages[0].title === '第一页' && r.pages[1].title === '第二页',
      r.pages.map((p) => p.title).join(' / '));
    ok('pptx 正文进入 HTML', r.pages[0].html.indexOf('第一页正文') >= 0, r.pages[0].html);
    ok('pptx 幻灯片图片内联为 data URL', /<img src="data:image\/png;base64,/.test(r.pages[1].html), r.pages[1].html);
    ok('pptx 抽取文本含第二页', r.pages[1].text.indexOf('第二页正文') >= 0, r.pages[1].text);

    // XLSX / CSV
    const xlsx = path.join(TMP, 'sample.xlsx');
    makeXlsx(xlsx);
    r = await Doc.readDocument(xlsx);
    ok('xlsx 每个工作表一页', r.ok === true && r.pages.length === 2, String(r.pages.length));
    ok('xlsx 页标题为工作表名', r.pages[0].title === '成绩汇总', r.pages[0].title);
    ok('xlsx 首行用 th', /<th>姓名<\/th><th>分数<\/th>/.test(r.pages[0].html), r.pages[0].html);
    ok('xlsx 单元格进入表格', /<td>张三<\/td><td>90<\/td>/.test(r.pages[0].html), r.pages[0].html);
    ok('xlsx 空表提示', r.pages[1].html.indexOf('空工作表') >= 0, r.pages[1].html);

    const csv = path.join(TMP, 'sample.csv');
    makeCsv(csv);
    r = await Doc.readDocument(csv);
    ok('csv 无 BOM 时按 GB18030 解码', r.ok === true && r.pages[0].text.indexOf('姓名') >= 0, r.pages[0].text);
    ok('csv 解析出两行数据', r.pages[0].text.indexOf('王五') >= 0 && /88/.test(r.pages[0].text), r.pages[0].text);

    // ODT
    const odt = path.join(TMP, 'sample.odt');
    await makeOdt(odt);
    r = await Doc.readDocument(odt);
    ok('odt 按一级标题分页', r.ok === true && r.pages.length === 2, String(r.pages.length));
    ok('odt 页标题取标题文字', r.pages[0].title === '第一章' && r.pages[1].title === '第二章',
      r.pages.map((p) => p.title).join(' / '));
    ok('odt 正文保留', r.pages[0].html.indexOf('第一章正文') >= 0, r.pages[0].html);

    // EPUB
    const epub = path.join(TMP, 'sample.epub');
    await makeEpub(epub);
    r = await Doc.readDocument(epub);
    ok('epub 每章一页', r.ok === true && r.pages.length === 2, String(r.pages.length));
    ok('epub 页标题取 h1', r.pages[0].title === '第一章 开始', r.pages[0].title);
    ok('epub 章节图片内联为 data URL', /<img src="data:image\/png;base64,/.test(r.pages[0].html), r.pages[0].html);
    ok('epub 远程图片被剥离', r.pages[0].html.indexOf('evil.example') < 0, r.pages[0].html);
    ok('epub 脚本被剥离', r.pages[0].html.indexOf('<script') < 0 && r.pages[0].html.indexOf('alert(1)') < 0, r.pages[0].html);
    ok('epub 事件属性被剥离', r.pages[1].html.indexOf('onclick') < 0, r.pages[1].html);
    ok('epub 文本抽取含第二章', r.pages[1].text.indexOf('第二章正文') >= 0, r.pages[1].text);

    // Markdown
    const md = path.join(TMP, 'sample.md');
    makeMd(md);
    r = await Doc.readDocument(md);
    ok('markdown 按一级标题分页', r.ok === true && r.pages.length === 2, String(r.pages.length));
    ok('markdown 页标题取标题文字', r.pages[0].title === '第一部分' && r.pages[1].title === '第二部分',
      r.pages.map((p) => p.title).join(' / '));
    ok('markdown 渲染加粗', /<strong>加粗<\/strong>/.test(r.pages[0].html), r.pages[0].html);
    ok('markdown 渲染代码块', /<pre><code/.test(r.pages[0].html), r.pages[0].html);
    ok('markdown 本地图片内联', /<img src="data:image\/png;base64,/.test(r.pages[0].html), r.pages[0].html);
    ok('markdown 远程图片被剥离', r.pages[0].html.indexOf('evil.example') < 0, r.pages[0].html);
    ok('markdown 脚本被剥离', r.pages[0].html.indexOf('<script') < 0, r.pages[0].html);

    // HTML
    const html = path.join(TMP, 'sample.html');
    makeHtml(html);
    r = await Doc.readDocument(html);
    ok('html 标题取 title', r.ok === true && r.pages[0].title === '网页标题', r.pages[0].title);
    ok('html 脚本被剥离', r.pages[0].html.indexOf('<script') < 0 && r.pages[0].html.indexOf('alert(1)') < 0, r.pages[0].html);
    ok('html 事件属性被剥离', r.pages[0].html.indexOf('onclick') < 0 && r.pages[0].html.indexOf('onerror') < 0, r.pages[0].html);
    ok('html javascript: 链接被剥离', r.pages[0].html.indexOf('javascript:') < 0, r.pages[0].html);

    // 纯文本
    const txt = path.join(TMP, 'sample.txt');
    makeTxt(txt);
    r = await Doc.readDocument(txt);
    ok('txt 去 BOM 且保留换行', r.ok === true && r.pages[0].text.trimEnd() === '第一行\n第二行', JSON.stringify(r.pages[0].text));

    // 不支持格式
    const ppt = path.join(TMP, 'old.ppt');
    fs.writeFileSync(ppt, 'not really ppt');
    r = await Doc.readDocument(ppt);
    ok('旧版 .ppt 给出另存为提示', r.ok === false && r.error.indexOf('另存为 .pptx') > 0, r.error);

    const bad = path.join(TMP, 'x.xyz');
    fs.writeFileSync(bad, 'x');
    r = await Doc.readDocument(bad);
    ok('未知格式明确报错', r.ok === false && r.error.indexOf('暂不支持') === 0, r.error);

    const pdf = path.join(TMP, 'x.pdf');
    r = await Doc.readDocument(pdf);
    ok('pdf 仍交给 PDF.js', r.ok === true && r.kind === 'pdf', JSON.stringify(r));

    // 全文抽取
    const tDocx = await Doc.extractText(docx);
    ok('extractText(docx) 有正文', tDocx.pages[0].text.indexOf('第二段普通文字') >= 0, JSON.stringify(tDocx).slice(0, 200));
    const tPptx = await Doc.extractText(pptx);
    ok('extractText(pptx) 两页', tPptx.numPages === 2 && tPptx.pages.length === 2, String(tPptx.numPages));
    const tXlsx = await Doc.extractText(xlsx);
    ok('extractText(xlsx) 两个工作表', tXlsx.numPages === 2, String(tXlsx.numPages));
    const tCsv = await Doc.extractText(csv);
    ok('extractText(csv) 中文正确', tCsv.pages[0].text.indexOf('王五') >= 0, tCsv.pages[0].text);
    const tEpub = await Doc.extractText(epub);
    ok('extractText(epub) 两章', tEpub.pages.length === 2, String(tEpub.pages.length));
    const tMd = await Doc.extractText(md);
    ok('extractText(md) 去掉标记', tMd.pages[0].text.indexOf('第一段') >= 0 && tMd.pages[0].text.indexOf('# 第一部分') < 0,
      tMd.pages[0].text.slice(0, 80));
  } catch (e) {
    fail++;
    console.error('  ERROR ' + (e && e.stack ? e.stack : e));
  } finally {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  }
  console.log('[docconvert] ' + (fail ? 'FAIL (' + fail + ')' : 'PASS'));
  process.exit(fail ? 2 : 0);
})();
