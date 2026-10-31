'use strict';
/*
 * 题录格式补齐（v1.6）回归：纯 Node，不启 Electron。
 *
 * 覆盖四件事：
 *   1. Zotero RDF / Dublin Core RDF 的读与写（含往返保真、DC 简版的 creator 文本形态）；
 *   2. MARCXML 的读与写（字段映射、leader 的连续出版物/专著判定、往返）；
 *   3. .xml 后缀按内容分辨三种格式，不能被扩展名硬猜；
 *   4. EndNote internal-pdf:// 的候选路径与「找不到就安静放弃」。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const F = require('../src/formats.js');
const RefAttach = require('../src/refattach.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.log('  FAIL ' + name + (detail === undefined ? '' : ' :: ' + detail));
}
function eq(name, got, want) {
  ok(name, got === want, 'got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want));
}

const article = {
  key: 'k1', itemType: 'journalArticle', title: 'Deep Learning & <AI>', year: '2020',
  publication: 'Nature', volume: '521', issue: '7553', pages: '436-444',
  doi: '10.1038/nature14539', url: 'https://x.test/a', abstract: 'Abs text', language: 'eng',
  tags: ['ml', 'ai'],
  fields: { issn: '0028-0836' },
  creators: [
    { firstName: 'John', lastName: 'Smith', creatorType: 'author' },
    { firstName: 'Ann', lastName: 'Lee', creatorType: 'author' },
  ],
};
const book = {
  key: 'k2', itemType: 'book', title: 'A Book', year: '2011', publication: 'Some Press',
  pages: '300 p.', fields: { isbn: '978-0-00-000000-0' },
  creators: [{ firstName: 'Dan', lastName: 'K', creatorType: 'author' }],
};

// ---------- 1. RDF 往返 ----------
{
  const xml = F.recordsToRdf([article, book]);
  ok('RDF 有根元素', xml.indexOf('<rdf:RDF') >= 0);
  ok('RDF 用 bib:Article 节点', xml.indexOf('<bib:Article') >= 0);
  ok('RDF 带 z:itemType', xml.indexOf('<z:itemType>journalArticle</z:itemType>') >= 0);
  ok('RDF 转义 & 与 <', xml.indexOf('&amp;') >= 0 && xml.indexOf('&lt;AI&gt;') >= 0);
  ok('RDF 作者拆成 foaf:Person', xml.indexOf('<foaf:surname>Smith</foaf:surname>') >= 0);

  const back = F.parseRdf(xml);
  eq('RDF 往返条数', back.length, 2);
  const a = back[0];
  eq('RDF 标题还原（含实体）', a.title, 'Deep Learning & <AI>');
  eq('RDF 类型还原', a.itemType, 'journalArticle');
  eq('RDF 年份', a.year, '2020');
  eq('RDF 刊名', a.publication, 'Nature');
  eq('RDF 卷期页', [a.volume, a.issue, a.pages].join('|'), '521|7553|436-444');
  eq('RDF DOI', a.doi, '10.1038/nature14539');
  eq('RDF URL', a.url, 'https://x.test/a');
  eq('RDF 摘要', a.abstract, 'Abs text');
  eq('RDF 作者数与姓名', a.creators.length + ':' + a.creators[0].lastName + '/' + a.creators[1].firstName,
    '2:Smith/Ann');
  eq('RDF 标签', a.tags.join(','), 'ml,ai');
  eq('RDF 图书类型', back[1].itemType, 'book');
  eq('RDF 图书 ISBN', back[1].fields.isbn, '978-0-00-000000-0');
}

// ---------- 2. Dublin Core 简版 ----------
{
  const dc = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <rdf:Description rdf:about="x">
    <dc:title>A DC Record</dc:title>
    <dc:creator>Smith, John</dc:creator>
    <dc:creator>Lee, Ann</dc:creator>
    <dc:date>2019-05-01</dc:date>
    <dc:type>Text.JournalArticle</dc:type>
    <dc:identifier>doi:10.1000/xyz</dc:identifier>
    <dc:subject>alpha</dc:subject>
  </rdf:Description>
</rdf:RDF>`;
  const back = F.parseRdf(dc);
  eq('DC 条数', back.length, 1);
  eq('DC 标题', back[0].title, 'A DC Record');
  eq('DC 类型从 dc:type 推', back[0].itemType, 'journalArticle');
  eq('DC 作者两个', back[0].creators.length, 2);
  eq('DC 作者姓', back[0].creators[0].lastName, 'Smith');
  eq('DC 作者名', back[0].creators[0].firstName, 'John');
  eq('DC 年份从完整日期取', back[0].year, '2019');
  eq('DC DOI 去前缀', back[0].doi, '10.1000/xyz');
  eq('DC 主题', back[0].tags.join(','), 'alpha');
}

// ---------- 3. MARCXML 往返 ----------
{
  const xml = F.recordsToMarcXml([article, book]);
  ok('MARC 有 collection 根', xml.indexOf('MARC21/slim') >= 0);
  ok('MARC 有 245 题名', xml.indexOf('tag="245"') >= 0);
  ok('MARC 有 100 责任者', xml.indexOf('<subfield code="a">Smith, John</subfield>') >= 0);
  ok('MARC 期刊用 773', xml.indexOf('tag="773"') >= 0);
  ok('MARC 期刊 leader/07 = s', /<leader>00000na s|00000nas/.test(xml.replace(/\s/g, ' ')) || xml.indexOf('<leader>00000nas') >= 0);
  ok('MARC 专著 leader/07 = m', xml.indexOf('<leader>00000nam') >= 0);
  ok('MARC DOI 走 024 $2 doi', xml.indexOf('<subfield code="2">doi</subfield>') >= 0);
  ok('MARC 转义 & 与 <', xml.indexOf('&amp;') >= 0 && xml.indexOf('&lt;AI&gt;') >= 0);

  const back = F.parseMarcXml(xml);
  eq('MARC 往返条数', back.length, 2);
  eq('MARC 标题还原', back[0].title, 'Deep Learning & <AI>');
  eq('MARC 类型（有 773 → 期刊）', back[0].itemType, 'journalArticle');
  eq('MARC 作者', back[0].creators[0].lastName + '/' + back[0].creators[0].firstName, 'Smith/John');
  eq('MARC 年份从 264$c', back[0].year, '2020');
  eq('MARC 刊名从 773$t', back[0].publication, 'Nature');
  eq('MARC 卷从 773$g', back[0].volume, '521');
  eq('MARC 期从 773$g', back[0].issue, '7553');
  eq('MARC 页从 773$g', back[0].pages, '436-444');
  eq('MARC DOI', back[0].doi, '10.1038/nature14539');
  eq('MARC 主题', back[0].tags.join(','), 'ml,ai');
  eq('MARC 图书类型（无 773 → 专著）', back[1].itemType, 'book');
  eq('MARC 图书出版社落回 publication', back[1].publication, 'Some Press');
  eq('MARC 图书 ISBN', back[1].fields.isbn, '978-0-00-000000-0');
  eq('MARC 001 保留成 key', back[1].key, 'k2');
}

// ---------- 3.5 角色与字段往返（R-v1.6-07） ----------
{
  const withEditor = {
    key: 'e1', itemType: 'book', title: 'Edited Volume', year: '2018',
    publication: 'Big Press', pages: '1-20',
    fields: { isbn: '978-1-11-111111-1', issn: '1111-2222', publisher: 'Big Press' },
    creators: [
      { firstName: 'Ann', lastName: 'Author', creatorType: 'author' },
      { firstName: 'Ed', lastName: 'Editor', creatorType: 'editor' },
    ],
  };

  // RDF：编者、出版社、ISBN、ISSN 都要能回来
  const rdf = F.parseRdf(F.recordsToRdf([withEditor]));
  const r = rdf[0];
  eq('RDF 作者角色', r.creators.filter((c) => c.creatorType === 'author').map((c) => c.lastName).join(','), 'Author');
  eq('RDF 编者角色', r.creators.filter((c) => c.creatorType === 'editor').map((c) => c.lastName).join(','), 'Editor');
  eq('RDF 出版社', r.fields.publisher, 'Big Press');
  eq('RDF ISBN', r.fields.isbn, '978-1-11-111111-1');
  eq('RDF ISSN', r.fields.issn, '1111-2222');

  // MARCXML：700$e=editor 不能被当成作者
  const marcXml = F.recordsToMarcXml([withEditor]);
  ok('MARC 编者带 $e', marcXml.indexOf('<subfield code="e">editor</subfield>') >= 0, marcXml.slice(0, 200));
  const m = F.parseMarcXml(marcXml)[0];
  eq('MARC 作者角色', m.creators.filter((c) => c.creatorType === 'author').map((c) => c.lastName).join(','), 'Author');
  eq('MARC 编者角色', m.creators.filter((c) => c.creatorType === 'editor').map((c) => c.lastName).join(','), 'Editor');
  eq('MARC 出版社', m.fields.publisher, 'Big Press');
  eq('MARC ISBN', m.fields.isbn, '978-1-11-111111-1');
  eq('MARC ISSN', m.fields.issn, '1111-2222');

  // 译者（$4 trl）也不该算作者
  const tr = F.parseMarcXml(`<?xml version="1.0"?><collection xmlns="http://www.loc.gov/MARC21/slim"><record>
    <datafield tag="245" ind1="1" ind2="0"><subfield code="a">T</subfield></datafield>
    <datafield tag="700" ind1="1" ind2=" "><subfield code="a">Doe, Jane</subfield><subfield code="4">trl</subfield></datafield>
  </record></collection>`);
  eq('MARC 译者角色', tr[0].creators[0].creatorType, 'translator');
}

// ---------- 4. 格式识别 ----------
{
  eq('.rdf 后缀', F.detectFormat('<rdf:RDF></rdf:RDF>', 'a.rdf'), 'rdf');
  eq('.marcxml 后缀', F.detectFormat('<collection/>', 'a.marcxml'), 'marcxml');
  eq('.xml + MARC21/slim → marcxml', F.detectFormat('<collection xmlns="http://www.loc.gov/MARC21/slim">', 'a.xml'), 'marcxml');
  eq('.xml + rdf:RDF → rdf', F.detectFormat('<rdf:RDF xmlns:rdf="x">', 'a.xml'), 'rdf');
  eq('.xml + record → endnotexml', F.detectFormat('<records><record><ref-type name="Journal Article"/></record></records>', 'a.xml'), 'endnotexml');
  eq('无后缀时按内容认 RDF', F.detectFormat('<?xml?><rdf:RDF>', ''), 'rdf');
  // 原有格式不受影响
  eq('bib 不变', F.detectFormat('@article{a, title={T}}', 'a.bib'), 'bibtex');
  eq('ris 不变', F.detectFormat('TY  - JOUR\nA1 - X\nER  - ', 'a.ris'), 'ris');
  eq('csljson 不变', F.detectFormat('[{"type":"book","title":"T"}]', 'a.json'), 'csljson');
  eq('enw 不变', F.detectFormat('%0 Journal Article\n%T T', 'a.enw'), 'endnote');
}

// ---------- 5. parseRefs 走通新格式 ----------
{
  const rdf = F.parseRefs(F.recordsToRdf([article]), 'x.rdf');
  eq('parseRefs 认 rdf', rdf.format, 'rdf');
  eq('parseRefs rdf 条数', rdf.records.length, 1);
  const marc = F.parseRefs(F.recordsToMarcXml([book]), 'x.xml');
  eq('parseRefs 按内容认 marcxml', marc.format, 'marcxml');
  eq('parseRefs marc 条数', marc.records.length, 1);
  // 坏 XML 不许抛到调用方
  const bad = F.parseRefs('<rdf:RDF><bib:Article><dc:title>未闭合', 'x.rdf');
  ok('坏 RDF 不抛异常', bad && Array.isArray(bad.records));
}

// ---------- 6. EndNote 附件路径还原 ----------
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-refattach-'));
  try {
    // 造一个 EndNote 库的典型布局：<stem>.Data/PDF/<host>/<file>
    const dataPdf = path.join(tmp, 'MyLib.Data', 'PDF', '2295834576');
    fs.mkdirSync(dataPdf, { recursive: true });
    fs.writeFileSync(path.join(dataPdf, 'Smith - 2020 - Title.pdf'), '%PDF-1.4');
    const xmlFile = path.join(tmp, 'MyLib.xml');
    fs.writeFileSync(xmlFile, '<records/>');

    const recs = [
      { title: 'A', attachmentHint: 'internal-pdf://2295834576/Smith - 2020 - Title.pdf' },
      { title: 'B', attachmentHint: 'internal-pdf://2295834576/Missing.pdf' },
      { title: 'C' },
    ];
    const linked = RefAttach.resolve(recs, xmlFile);
    eq('命中一个附件', linked, 1);
    eq('命中的是第一条', recs[0].attachment.path, path.join(dataPdf, 'Smith - 2020 - Title.pdf'));
    eq('找不到的不编路径', recs[1].attachment, undefined);
    eq('内部字段被清掉', recs[0].attachmentHint, undefined);
    eq('无 hint 的条目不动', recs[2].attachment, undefined);

    // 没有源文件时只清理，不找文件（从剪贴板/文本框导入的场景）
    const recs2 = [{ title: 'D', attachmentHint: 'internal-pdf://x/y.pdf' }];
    eq('无源文件时接不到附件', RefAttach.resolve(recs2, ''), 0);
    eq('无源文件也清内部字段', recs2[0].attachmentHint, undefined);

    // %20 编码的文件名
    fs.writeFileSync(path.join(dataPdf, 'Two Words.pdf'), '%PDF');
    const enc = [{ title: 'E', attachmentHint: 'internal-pdf://2295834576/Two%20Words.pdf' }];
    eq('%20 解码后能命中', RefAttach.resolve(enc, xmlFile), 1);

    // 候选顺序：先 <stem>.Data/PDF/<host>/<name>，最后 <dir>/<name>
    const cands = RefAttach.candidatesFor('internal-pdf://1/a.pdf', '/base', 'Lib');
    ok('候选含 .Data/PDF/host', cands[0].indexOf(path.join('Lib.Data', 'PDF', '1', 'a.pdf')) >= 0, cands[0]);
    ok('候选含 PDF 直下', cands.some((c) => c === path.join('/base', 'PDF', '1', 'a.pdf')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------- 7. EndNote XML 抽 attachmentHint ----------
{
  const xml = `<?xml version="1.0"?><records><record>
    <ref-type name="Journal Article"/>
    <contributors><authors><author>Smith, John</author></authors></contributors>
    <title>With Attachment</title>
    <urls><pdf-urls><url>internal-pdf://2295834576/paper.pdf</url></pdf-urls></urls>
  </record></records>`;
  const back = F.parseEndNoteXml(xml);
  eq('抽到 internal-pdf 提示', back[0].attachmentHint, 'internal-pdf://2295834576/paper.pdf');
  const plain = F.parseEndNoteXml('<records><record><title>T</title></record></records>');
  eq('没有附件时为空串', plain[0].attachmentHint, '');
}

console.log('test-refio-formats: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
