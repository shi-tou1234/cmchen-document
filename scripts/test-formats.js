'use strict';
/*
 * BibTeX / RIS 解析与导出回归（v12）。纯 Node，不依赖 Electron。
 * 覆盖：格式识别、多作者、页码、特殊字符、类型映射、多记录、往返一致性、坏数据容错。
 * 运行：node scripts/test-formats.js
 */
const path = require('path');
const formats = require(path.join(__dirname, '..', 'src', 'formats.js'));

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  <- ' + detail : '')); }
}

const BIB = `
% 注释行应被忽略
@string{jtest = "Journal of Testing"}

@article{smith2020,
  title = {Neural {N}etworks for {PDF} Reading},
  author = {Smith, John and Doe, Jane and {ACME Research Group}},
  year = {2020},
  journal = {Journal of Testing},
  volume = {12},
  number = {3},
  pages = {45--67},
  doi = {https://doi.org/10.1000/xyz.123},
  url = {https://example.org/a},
  keywords = {machine learning, PDF; reading},
  abstract = {An abstract with \\& escaped chars and {braces}.},
  language = {en}
}

@inproceedings{lee2019,
  title = "A Quoted Title",
  author = "Lee, Ann and Kim, Bob",
  booktitle = {Proc. of Testing},
  year = 2019,
  pages = {100--110}
}

@phdthesis{wang2018,
  title = {学位论文标题},
  author = {王五},
  school = {测试大学},
  year = {2018}
}

@misc{broken_no_title,
  author = {Nobody}
}
`;

const r = formats.parseRefs(BIB, 'refs.bib');
ok('按扩展名识别 BibTeX', r.format === 'bibtex', r.format);
ok('解析出 4 条记录', r.records.length === 4, 'n=' + r.records.length);

const a = r.records[0];
ok('标题去除内层花括号', a.title === 'Neural Networks for PDF Reading', a.title);
ok('三作者且 Last, First 归一', JSON.stringify(a.creators) === JSON.stringify([
  { firstName: 'John', lastName: 'Smith', creatorType: 'author' },
  { firstName: 'Jane', lastName: 'Doe', creatorType: 'author' },
  { firstName: '', lastName: 'ACME Research Group', creatorType: 'author' },
]), JSON.stringify(a.creators));
ok('年份', a.year === '2020', a.year);
ok('期刊名', a.publication === 'Journal of Testing', a.publication);
ok('卷/期', a.volume === '12' && a.issue === '3', a.volume + '/' + a.issue);
ok('BibTeX 双连字符页码归一', a.pages === '45-67', a.pages);
ok('DOI 去掉 doi.org 前缀', a.doi === '10.1000/xyz.123', a.doi);
ok('URL/语言', a.url === 'https://example.org/a' && a.language === 'en');
ok('关键词按逗号和分号切开', JSON.stringify(a.tags) === JSON.stringify(['machine learning', 'PDF', 'reading']), JSON.stringify(a.tags));
ok('摘要中的 \\& 还原为 &', a.abstract === 'An abstract with & escaped chars and braces.', a.abstract);
ok('article → journalArticle', a.itemType === 'journalArticle', a.itemType);

const b = r.records[1];
ok('引号值也能解析', b.title === 'A Quoted Title', b.title);
ok('inproceedings → conferencePaper', b.itemType === 'conferencePaper', b.itemType);
ok('裸数字年份', b.year === '2019', b.year);
ok('booktitle 作为出版物', b.publication === 'Proc. of Testing', b.publication);
ok('中文页码区间', b.pages === '100-110', b.pages);

const c = r.records[2];
ok('phdthesis → thesis', c.itemType === 'thesis', c.itemType);
ok('中文字段不丢', c.title === '学位论文标题' && c.creators[0].lastName === '王五' && c.creators[0].firstName === '' && c.publication === '测试大学', JSON.stringify([c.title, c.creators, c.publication]));
ok('学位论文 school 作为出版物', c.publication === '测试大学');

ok('缺标题条目用 key 兜底', r.records[3].title === 'broken_no_title', r.records[3].title);

// 导出：类型映射、作者拼接、key 去重、花括号转义
const exported = formats.recordsToBibtex(r.records);
ok('导出含 @article', /@article\{/.test(exported));
ok('导出含 @inproceedings', /@inproceedings\{/.test(exported));
ok('导出含 @phdthesis', /@phdthesis\{/.test(exported));
ok('作者用 and 拼接', /author = \{Smith, John and Doe, Jane and \{ACME Research Group\}\}/.test(exported), exported.slice(0, 300));

const again = formats.parseBibtex(exported);
ok('导出后重新解析条数一致', again.length === 4, 'n=' + again.length);
ok('往返标题一致', again[0].title === a.title, again[0].title);
ok('往返作者一致', JSON.stringify(again[0].creators) === JSON.stringify(a.creators), JSON.stringify(again[0].creators));
ok('往返页码一致', again[0].pages === a.pages, again[0].pages);
ok('往返标签一致', JSON.stringify(again[0].tags) === JSON.stringify(a.tags), JSON.stringify(again[0].tags));
ok('往返 DOI 一致', again[0].doi === a.doi, again[0].doi);

// 花括号往返：导出时转义，解析时还原，不留孤立反斜杠
const braceRec = [{ itemType: 'journalArticle', title: 'A {B} C', creators: ['X Y'], year: '2020', tags: [], pages: '', volume: '', issue: '', doi: '', url: '', abstract: '', language: '', publication: '' }];
const braceOut = formats.recordsToBibtex(braceRec);
const braceBack = formats.parseBibtex(braceOut);
ok('花括号往返不丢字符', braceBack[0].title === 'A B C' && !/\\/.test(braceBack[0].title), JSON.stringify([braceOut, braceBack[0].title]));

// RIS：多记录 / 多作者 / SP+EP / 关键词 / 类型
const RIS = `
TY  - JOUR
TI  - 一篇中文论文
AU  - 张, 三
AU  - 李四
PY  - 2021
JO  - 测试学报
VL  - 5
IS  - 2
SP  - 10
EP  - 20
DO  - 10.1000/cn
KW  - 机器学习
KW  - 数据库
AB  - 中文摘要
LA  - zh
ER  - 

TY  - CONF
TI  - Second Paper
AU  - Doe, Jane
PY  - 2019/05/01
T2  - Proc. of Testing
SP  - 100
ER  - 
`;
const rr = formats.parseRefs(RIS, 'refs.ris');
ok('按扩展名识别 RIS', rr.format === 'ris', rr.format);
ok('RIS 解析出 2 条记录', rr.records.length === 2, 'n=' + rr.records.length);
const ra = rr.records[0];
ok('RIS 中文标题', ra.title === '一篇中文论文', ra.title);
ok('RIS 多作者 Last, First 归一', JSON.stringify(ra.creators) === JSON.stringify([
  { firstName: '三', lastName: '张', creatorType: 'author' },
  { firstName: '', lastName: '李四', creatorType: 'author' },
]), JSON.stringify(ra.creators));
ok('RIS 年份', ra.year === '2021', ra.year);
ok('RIS 期刊', ra.publication === '测试学报', ra.publication);
ok('RIS 卷期', ra.volume === '5' && ra.issue === '2');
ok('RIS SP/EP 合并页码', ra.pages === '10-20', ra.pages);
ok('RIS DOI', ra.doi === '10.1000/cn', ra.doi);
ok('RIS 关键词', JSON.stringify(ra.tags) === JSON.stringify(['机器学习', '数据库']), JSON.stringify(ra.tags));
ok('RIS 摘要/语言', ra.abstract === '中文摘要' && ra.language === 'zh');
ok('RIS JOUR → journalArticle', ra.itemType === 'journalArticle', ra.itemType);
ok('RIS 无 EP 时页码只取 SP', rr.records[1].pages === '100', rr.records[1].pages);
ok('RIS CONF → conferencePaper', rr.records[1].itemType === 'conferencePaper');
ok('RIS 日期字段取年份', rr.records[1].year === '2019', rr.records[1].year);

const risOut = formats.recordsToRis(rr.records);
ok('RIS 导出含 TY/ER 成对', (risOut.match(/^TY  - /gm) || []).length === 2 && (risOut.match(/^ER  - /gm) || []).length === 2);
ok('RIS 导出拆 SP/EP', /SP  - 10/.test(risOut) && /EP  - 20/.test(risOut), risOut.split('\n').filter((l) => /^S[PE]/.test(l)).join('|'));
const risBack = formats.parseRis(risOut);
ok('RIS 往返条数一致', risBack.length === 2, 'n=' + risBack.length);
ok('RIS 往返标题一致', risBack[0].title === ra.title);
ok('RIS 往返作者一致', JSON.stringify(risBack[0].creators) === JSON.stringify(ra.creators), JSON.stringify(risBack[0].creators));
ok('RIS 往返页码一致', risBack[0].pages === ra.pages, risBack[0].pages);
ok('RIS 往返标签一致', JSON.stringify(risBack[0].tags) === JSON.stringify(ra.tags), JSON.stringify(risBack[0].tags));

// 格式自动识别（无扩展名）
ok('无扩展名按内容识别 BibTeX', formats.detectFormat('@book{x, title={T}}', 'x.txt') === 'bibtex');
ok('无扩展名按内容识别 RIS', formats.detectFormat('TY  - BOOK\nTI  - T\nER  - ', 'x.txt') === 'ris');
ok('无法识别时默认 BibTeX', formats.detectFormat('hello world', 'x.txt') === 'bibtex');

// 坏数据不能抛错
let threw = false;
try {
  formats.parseRefs('@article{unclosed, title = {Never ends', 'x.bib');
  formats.parseRefs('\uFEFFgarbage\n\n', 'x.ris');
  formats.parseRefs('', '');
} catch (e) { threw = true; }
ok('坏数据/空输入不抛错', !threw);

// ---------- CSL-JSON（v19：Zotero 也能导出这个格式） ----------
const cslText = JSON.stringify([{
  id: 'smith2020',
  type: 'article-journal',
  title: 'Neural Networks for PDF Reading',
  author: [{ family: 'Smith', given: 'John' }, { literal: 'ACME Research Group' }],
  issued: { 'date-parts': [[2020]] },
  'container-title': 'Journal of Testing',
  volume: '12', issue: '3', page: '45-67',
  DOI: '10.1000/xyz.123', URL: 'https://example.org/a',
  abstract: 'An abstract.', language: 'en',
  keyword: ['machine learning', 'PDF'],
}], null, 2);
ok('按扩展名识别 CSL-JSON', formats.detectFormat(cslText, 'x.json') === 'csljson');
ok('无扩展名按内容识别 CSL-JSON', formats.detectFormat(cslText, 'x.txt') === 'csljson');
const cslRecs = formats.parseCslJson(cslText);
ok('CSL-JSON 解析出条目', cslRecs.length === 1, 'n=' + cslRecs.length);
ok('CSL-JSON 类型映射', cslRecs[0].itemType === 'journalArticle', cslRecs[0].itemType);
ok('CSL-JSON 标题', cslRecs[0].title === 'Neural Networks for PDF Reading', cslRecs[0].title);
ok('CSL-JSON 作者 family+given 合结构', cslRecs[0].creators[0].lastName === 'Smith' && cslRecs[0].creators[0].firstName === 'John', JSON.stringify(cslRecs[0].creators));
ok('CSL-JSON 作者 literal 原样', cslRecs[0].creators[1].lastName === 'ACME Research Group' && cslRecs[0].creators[1].firstName === '', JSON.stringify(cslRecs[0].creators));
ok('CSL-JSON 日期取年', cslRecs[0].year === '2020', cslRecs[0].year);
ok('CSL-JSON 容器名→出版物', cslRecs[0].publication === 'Journal of Testing', cslRecs[0].publication);
ok('CSL-JSON 卷期页码', cslRecs[0].volume === '12' && cslRecs[0].issue === '3' && cslRecs[0].pages === '45-67');
ok('CSL-JSON DOI/URL', cslRecs[0].doi === '10.1000/xyz.123' && cslRecs[0].url === 'https://example.org/a');
ok('CSL-JSON 关键词切数组', JSON.stringify(cslRecs[0].tags) === '["machine learning","PDF"]', JSON.stringify(cslRecs[0].tags));
const cslOut = formats.recordsToCslJson(cslRecs);
const cslBack = JSON.parse(cslOut);
ok('CSL-JSON 导出是数组', Array.isArray(cslBack) && cslBack.length === 1);
ok('CSL-JSON 导出 type', cslBack[0].type === 'article-journal', cslBack[0].type);
ok('CSL-JSON 导出用 family+given 作者', !!(cslBack[0].author && cslBack[0].author[0].family === 'Smith' && cslBack[0].author[0].given === 'John'), JSON.stringify(cslBack[0].author));
ok('CSL-JSON 导出机构名用 literal', !!(cslBack[0].author && cslBack[0].author[1].literal === 'ACME Research Group'), JSON.stringify(cslBack[0].author));
ok('CSL-JSON 导出 date-parts', JSON.stringify(cslBack[0].issued) === '{"date-parts":[[2020]]}', JSON.stringify(cslBack[0].issued));
ok('CSL-JSON 往返标题一致', cslBack[0].title === cslRecs[0].title);
let cslThrew = false;
try { formats.parseCslJson('{ 坏 json'); } catch (e) { cslThrew = true; }
ok('CSL-JSON 坏数据被 parseRefs 兜住', !formats.parseRefs('{ 坏 json', 'x.json').records.length);

console.log('[formats] ' + (fail ? 'FAIL (' + fail + '/' + (pass + fail) + ')' : 'PASS (' + pass + ')'));
process.exit(fail ? 2 : 0);
