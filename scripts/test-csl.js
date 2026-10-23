'use strict';
/*
 * CSL 子集引擎回归。纯 Node，不启 Electron。
 * 覆盖：XML 解析、变量映射、macro/group/choose、names（et-al / 姓名倒置 / 缩写）、
 * date、number、label、页码范围、sort、内置样式、与 Cite/Bib 的接入、用户样式注册。
 * 运行：node scripts/test-csl.js
 */
const path = require('path');
const Csl = require(path.join(__dirname, '..', 'src', 'csl.js'));
const Cite = require(path.join(__dirname, '..', 'src', 'cite.js'));
const Bib = require(path.join(__dirname, '..', 'src', 'bib.js'));

let fail = 0;
let checks = 0;
const ok = (name, cond, detail) => {
  checks++;
  if (cond) console.log('  ok   ' + name);
  else { fail++; console.log('  FAIL ' + name + (detail != null ? '  <- ' + detail : '')); }
};

let seq = 0;
function styleXml(inner, styleAttrs) {
  const n = ++seq;
  return '<?xml version="1.0" encoding="utf-8"?>' +
    '<style xmlns="http://purl.org/net/xbiblio/csl" version="1.0" class="in-text" default-locale="en-US"' +
    (styleAttrs || '') + '>' +
    '<info><title>Test ' + n + '</title><id>http://example.com/test-' + n + '</id></info>' +
    '<bibliography><layout>' + inner + '</layout></bibliography></style>';
}

function render(inner, item, opts, styleAttrs) {
  const style = Csl.register(styleXml(inner, styleAttrs), { source: 'builtin' });
  return Csl.render(style, item, opts || {});
}

const article = {
  key: 'a1',
  itemType: 'journalArticle',
  title: 'Deep learning',
  creators: [
    { firstName: 'John', lastName: 'Smith', creatorType: 'author' },
    { firstName: 'Carol', lastName: 'Jones', creatorType: 'author' },
  ],
  year: '2020',
  publication: 'Nature',
  volume: '580',
  issue: '7803',
  pages: '100-110',
  doi: '10.1038/x',
};

const book = {
  key: 'b1',
  itemType: 'book',
  title: 'The Craft of Research',
  creators: [{ firstName: 'Wayne', lastName: 'Booth', creatorType: 'author' }],
  year: '2016',
  fields: { publisher: 'University of Chicago Press', place: 'Chicago', edition: '4' },
};

// ---------------------------------------------------------------------------
console.log('\n[1] XML 解析');
// ---------------------------------------------------------------------------
let x = Csl.parseXml('<a x="1" y="a>b"><b>hi &amp; bye</b><!-- c --></a>');
ok('根元素与属性', x.name === 'a' && x.attrs.x === '1' && x.attrs.y === 'a>b', JSON.stringify(x.attrs));
ok('嵌套文本与实体', x.children[0].name === 'b' && x.children[0].children.join('') === 'hi & bye');
const cdata = Csl.parseXml('<a><![CDATA[<raw> & stuff]]></a>');
ok('CDATA 原样保留', cdata.children[0] === '<raw> & stuff', cdata.children[0]);
const numericEntity = Csl.parseXml('<a>&#65;&#x42;</a>');
ok('数字实体', numericEntity.children.join('') === 'AB', numericEntity.children.join(''));
const selfClose = Csl.parseXml('<a><b/><b x="1"/></a>');
ok('自闭合标签', selfClose.children.length === 2 && selfClose.children[1].attrs.x === '1');
let threw = false;
try { Csl.parseXml('<a><b></a>'); } catch (_) { threw = true; }
ok('标签不匹配会抛错', threw);
threw = false;
try { Csl.parseXml('<a></a><b></b>'); } catch (_) { threw = true; }
ok('多个根节点会抛错', threw);
threw = false;
try { Csl.parseXml('<style><macro></style>'); } catch (_) { threw = true; }
ok('未闭合标签会抛错', threw);

// ---------------------------------------------------------------------------
console.log('\n[2] 内置样式');
// ---------------------------------------------------------------------------
const ids = Cite.styleList().map((s) => s.id);
ok('注册了三种内置 CSL 样式',
  ['csl:vancouver', 'csl:nature', 'csl:harvard-cite-them-right'].every((id) => ids.includes(id)),
  ids.join(','));
ok('样式标签取 info/title', Cite.styleLabel('csl:nature') === 'Nature', Cite.styleLabel('csl:nature'));
ok('编号制识别（Nature）', Cite.isNumericStyle('csl:nature') === true);
ok('作者-年份制识别（Harvard）', Cite.isNumericStyle('csl:harvard-cite-them-right') === false);
ok('内置 5 种仍排在前面', ids.slice(0, 5).join(',') === 'gbt7714,apa,chicago,ieee,mla', ids.slice(0, 5).join(','));
ok('legacy 样式不受影响', Cite.format(article, 'apa').indexOf('Smith, J.') === 0, Cite.format(article, 'apa'));
ok('未知样式仍回落 GB/T', Cite.format(article, 'nope').indexOf('[J]') > 0);

// ---------------------------------------------------------------------------
console.log('\n[3] 内置样式输出');
// ---------------------------------------------------------------------------
let s = Cite.format(article, 'csl:vancouver', 3);
ok('Vancouver 编号 + 姓前名缩写', s === '3. Smith J, Jones C. Deep learning. Nature. 2020;580(7803):100\u2013110. doi: 10.1038/x.', s);

const manyAuthors = Object.assign({}, article, {
  creators: Array.from({ length: 8 }, (_, i) => ({
    firstName: 'A' + (i + 1), lastName: 'Author' + String.fromCharCode(65 + i), creatorType: 'author',
  })),
});
s = Cite.format(manyAuthors, 'csl:vancouver', 1);
ok('Vancouver 超过 6 位用 et al.', s.indexOf('AuthorF A, et al.') > 0, s);

s = Cite.format(article, 'csl:nature', 3);
ok('Nature 编号 + 期刊卷页', s === '3. Smith, J., Jones, C. Deep learning. Nature 580, 100\u2013110 (2020). doi:10.1038/x.', s);
s = Cite.format(manyAuthors, 'csl:nature', 1);
ok('Nature 只列第一作者 + et al.', s.indexOf('Smith') < 0 && s.indexOf('AuthorA, A. et al.') > 0, s);
const noDoi = Object.assign({}, article, { doi: '' });
s = Cite.format(noDoi, 'csl:nature', 1);
ok('Nature 缺 DOI 时正常收尾', /\(2020\)\.$/.test(s), s);

s = Cite.format(article, 'csl:harvard-cite-them-right');
ok('Harvard 作者 + 年份 + 单引号标题',
  s === 'Smith, J. and Jones, C. (2020) \u2018Deep learning\u2019, Nature, 580(7803), pp. 100\u2013110. doi: 10.1038/x.', s);
s = Cite.format(book, 'csl:harvard-cite-them-right');
ok('Harvard 图书带版次与出版地',
  s.indexOf('4th ed.') > 0 && s.indexOf('Chicago: University of Chicago Press.') > 0, s);
s = Cite.format(book, 'csl:vancouver');
ok('Vancouver 图书带出版地与年份', s.indexOf('Chicago: University of Chicago Press; 2016.') > 0, s);

// ---------------------------------------------------------------------------
console.log('\n[4] text / macro / group');
// ---------------------------------------------------------------------------
ok('text variable + 前后缀', render('<text variable="title" prefix="《" suffix="》"/>', article) === '《Deep learning》');
ok('text value 字面量', render('<text value="in"/>', article) === 'in');
ok('text term', render('<text term="page" form="short"/>', article) === 'p.');
ok('text term 复数', render('<text term="page" form="short" plural="true"/>', article) === 'pp.');
const macroStyle = Csl.parseStyle(styleXml('<text macro="m" suffix="."/>').replace(
  '<bibliography>', '<macro name="m"><text variable="title"/></macro><bibliography>'));
ok('macro 调用', Csl.render(macroStyle, article) === 'Deep learning.', Csl.render(macroStyle, article));
ok('group 用分隔符连接', render('<group delimiter=", "><text variable="title"/><text variable="container-title"/></group>', article) === 'Deep learning, Nature');
ok('group 丢弃空子元素', render('<group delimiter=", "><text variable="title"/><text variable="DOI"/></group>', noDoi) === 'Deep learning');
ok('group 变量全空时整组消失',
  render('<group delimiter=" "><text term="volume" form="short"/><text variable="volume"/></group>', { title: 'x' }) === '');
ok('group 有变量时保留词条',
  render('<group delimiter=" "><text term="volume" form="short"/><text variable="volume"/></group>', article) === 'vol. 580');
ok('宏递归不会爆栈', render('<macro name="a"><text macro="a"/></macro><text macro="a"/>', article) === '');

// ---------------------------------------------------------------------------
console.log('\n[5] choose / 条件 / 文本变换');
// ---------------------------------------------------------------------------
ok('type 条件', render('<choose><if type="article-journal"><text value="J"/></if><else><text value="X"/></else></choose>', article) === 'J');
ok('bookSection 映射为 chapter',
  render('<choose><if type="chapter"><text value="C"/></if></choose>', { itemType: 'bookSection', title: 'x' }) === 'C');
ok('variable 条件', render('<choose><if variable="DOI"><text value="yes"/></if><else><text value="no"/></else></choose>', noDoi) === 'no');
ok('match=any', render('<choose><if variable="DOI ISBN" match="any"><text value="yes"/></if></choose>', noDoi) === '');
ok('match=none', render('<choose><if variable="DOI ISBN" match="none"><text value="none"/></if></choose>', noDoi) === 'none');
ok('is-numeric', render('<choose><if is-numeric="volume"><text value="num"/></if><else><text value="str"/></else></choose>', article) === 'num');
ok('is-numeric 负例', render('<choose><if is-numeric="volume"><text value="num"/></if><else><text value="str"/></else></choose>', { title: 'x', volume: 'S1' }) === 'str');
ok('else-if 分支', render('<choose><if type="book"><text value="B"/></if><else-if type="article-journal"><text value="A"/></else-if><else><text value="O"/></else></choose>', article) === 'A');
ok('uppercase', render('<text variable="title" text-case="uppercase"/>', article) === 'DEEP LEARNING');
ok('capitalize-first', render('<text variable="title" text-case="capitalize-first"/>', { title: 'deep learning' }) === 'Deep learning');
ok('capitalize-all 跳过虚词', render('<text variable="title" text-case="capitalize-all"/>', { title: 'the craft of research' }) === 'The Craft of Research');
ok('strip-periods', render('<text term="et-al" strip-periods="true"/>', article) === 'et al');
ok('quotes 使用 locale 引号', render('<text variable="title" quotes="true"/>', article) === '\u201cDeep learning\u201d');

// ---------------------------------------------------------------------------
console.log('\n[6] names');
// ---------------------------------------------------------------------------
const three = {
  title: 'x',
  creators: [
    { firstName: 'John', lastName: 'Smith' },
    { firstName: 'Carol', lastName: 'Jones' },
    { firstName: 'Alice', lastName: 'Brown' },
  ],
};
ok('and=text 两人', render('<names variable="author"><name and="text"/></names>', article) === 'John Smith and Carol Jones');
ok('and=symbol 两人', render('<names variable="author"><name and="symbol"/></names>', article) === 'John Smith & Carol Jones');
ok('三人默认逗号', render('<names variable="author"><name/></names>', three) === 'John Smith, Carol Jones, Alice Brown');
ok('delimiter-precedes-last=always', render('<names variable="author"><name and="symbol" delimiter-precedes-last="always"/></names>', three) === 'John Smith, Carol Jones, & Alice Brown');
ok('name-as-sort-order=all + 缩写',
  render('<names variable="author"><name name-as-sort-order="all" initialize-with=". "/></names>', article) === 'Smith, J., Jones, C.');
ok('name-as-sort-order=first',
  render('<names variable="author"><name name-as-sort-order="first"/></names>', article) === 'Smith, John, Carol Jones',
  render('<names variable="author"><name name-as-sort-order="first"/></names>', article));
ok('initialize-with 为空（Vancouver）',
  render('<names variable="author"><name name-as-sort-order="all" sort-separator=" " initialize-with=""/></names>', article) === 'Smith J, Jones C');
ok('form=short', render('<names variable="author"><name form="short"/></names>', article) === 'Smith, Jones');
ok('et-al 触发', render('<names variable="author"><name et-al-min="3" et-al-use-first="1"/></names>', three) === 'John Smith et al.');
ok('et-al 分隔符 always', render('<names variable="author"><name et-al-min="3" et-al-use-first="1" delimiter-precedes-et-al="always"/></names>', three) === 'John Smith, et al.');
ok('substitute 用编者顶替作者',
  render('<names variable="author"><name form="short"/><substitute><names variable="editor"><name form="short"/></names></substitute></names>',
    { title: 'x', creators: [{ firstName: 'Ed', lastName: 'Itor', creatorType: 'editor' }] }) === 'Itor');
ok('names label 复数短式',
  render('<names variable="editor"><name form="short"/><label form="short" prefix=", "/></names>',
    { title: 'x', creators: [
      { firstName: 'Ed', lastName: 'Itor', creatorType: 'editor' },
      { firstName: 'Ann', lastName: 'Other', creatorType: 'editor' },
    ] }) === 'Itor, Other, eds.');
ok('CJK 姓名不拆不加空格',
  render('<names variable="author"><name/></names>', { title: 'x', creators: [{ lastName: '张三' }] }) === '张三');
ok('连字符名缩写', render('<names variable="author"><name initialize-with=". "/></names>',
  { title: 'x', creators: [{ firstName: 'Jean-Paul', lastName: 'Sartre' }] }) === 'J.-P. Sartre');

// ---------------------------------------------------------------------------
console.log('\n[7] 日期 / 数字 / 标签');
// ---------------------------------------------------------------------------
const dated = Object.assign({}, article, { year: '2020-10-03' });
ok('只输出年份', render('<date variable="issued"><date-part name="year"/></date>', dated) === '2020');
ok('年 + 长月份 + 日',
  render('<date variable="issued"><date-part name="year"/><date-part name="month" form="long" prefix=" "/><date-part name="day" prefix=" "/></date>', dated) === '2020 October 3');
ok('月份短式',
  render('<date variable="issued"><date-part name="month" form="short"/></date>', dated) === 'Oct.');
ok('日序数词', render('<date variable="issued"><date-part name="day" form="ordinal"/></date>', dated) === '3rd');
ok('date-parts 只留年',
  render('<date variable="issued" date-parts="year"><date-part name="year"/><date-part name="month" prefix=" "/></date>', dated) === '2020');
ok('缺日期返回空串', render('<date variable="issued"><date-part name="year"/></date>', { title: 'x' }) === '');
ok('ordinal 2nd', render('<number variable="edition" form="ordinal"/>', book) === '4th');
ok('ordinal 11th', render('<number variable="edition" form="ordinal"/>', { title: 'x', fields: { edition: '11' } }) === '11th');
ok('ordinal 21st', render('<number variable="edition" form="ordinal"/>', { title: 'x', fields: { edition: '21' } }) === '21st');
ok('long-ordinal', render('<number variable="edition" form="long-ordinal"/>', { title: 'x', fields: { edition: '3' } }) === 'third');
ok('roman', render('<number variable="volume" form="roman"/>', { title: 'x', volume: '4' }) === 'iv');
ok('label page 复数', render('<label variable="page" form="short"/>', article) === 'pp.');
ok('label page 单数强制', render('<label variable="page" form="short" plural="never"/>', article) === 'p.');
ok('label page 长式复数', render('<label variable="page"/>', article) === 'pages');
ok('label volume 单数', render('<label variable="volume" form="short"/>', article) === 'vol.');
ok('label 空变量不输出', render('<label variable="page" form="short"/>', { title: 'x' }) === '');

// ---------------------------------------------------------------------------
console.log('\n[8] 页码范围');
// ---------------------------------------------------------------------------
ok('expanded', Csl.formatPageRange('321-328', 'expanded') === '321\u2013328', Csl.formatPageRange('321-328', 'expanded'));
ok('minimal', Csl.formatPageRange('321-328', 'minimal') === '321\u20138', Csl.formatPageRange('321-328', 'minimal'));
ok('minimal-two', Csl.formatPageRange('321-328', 'minimal-two') === '321\u201328', Csl.formatPageRange('321-328', 'minimal-two'));
ok('minimal-two 四位数', Csl.formatPageRange('1002-1049', 'minimal-two') === '1002\u201349', Csl.formatPageRange('1002-1049', 'minimal-two'));
ok('无格式也统一成 en dash', Csl.formatPageRange('100-110', '') === '100\u2013110', Csl.formatPageRange('100-110', ''));
ok('样式里应用 page-range-format',
  render('<text variable="page"/>', article, {}, ' page-range-format="minimal"') === '100\u201310');

// ---------------------------------------------------------------------------
console.log('\n[9] 排序');
// ---------------------------------------------------------------------------
const sortStyle = Csl.parseStyle(styleXml('<text variable="title"/>').replace(
  '<bibliography><layout>',
  '<bibliography><sort><key variable="title"/></sort><layout>'));
const sorted = Csl.sortItems(sortStyle, [
  { key: 'c', title: 'Charlie' },
  { key: 'a', title: 'Alpha' },
  { key: 'b', title: 'Bravo' },
]);
ok('按 title 升序', sorted.map((it) => it.key).join('') === 'abc', sorted.map((it) => it.key).join(''));

const descStyle = Csl.parseStyle(styleXml('<text variable="title"/>').replace(
  '<bibliography><layout>',
  '<bibliography><sort><key variable="title" sort="descending"/></sort><layout>'));
const sortedDesc = Csl.sortItems(descStyle, [
  { key: 'a', title: 'Alpha' }, { key: 'c', title: 'Charlie' }, { key: 'b', title: 'Bravo' },
]);
ok('descending', sortedDesc.map((it) => it.key).join('') === 'cba', sortedDesc.map((it) => it.key).join(''));

const noSort = Csl.parseStyle(styleXml('<text variable="title"/>'));
ok('没有 sort 返回 null', Csl.sortItems(noSort, [{ title: 'x' }]) === null);

// ---------------------------------------------------------------------------
console.log('\n[10] 与 Cite / Bib 接入');
// ---------------------------------------------------------------------------
const r1 = Bib.build([article, book], { style: 'csl:nature' });
ok('CSL 编号制被 Bib 识别', r1.numeric === true && r1.order === 'entry');
ok('编号由样式写，不重复套 [n]', r1.entries[0].indexOf('1. ') === 0 && r1.entries[0].indexOf('[') < 0, r1.entries[0]);
ok('第二条序号递增', r1.entries[1].indexOf('2. ') === 0, r1.entries[1]);
ok('styleLabel 跟 CSL 一致', r1.styleLabel === 'Nature', r1.styleLabel);

const dupA = {
  key: 'd1', itemType: 'journalArticle', title: 'Alpha', year: '2020',
  creators: [{ firstName: 'A', lastName: 'Same' }], publication: 'J',
};
const dupB = Object.assign({}, dupA, { key: 'd2', title: 'Beta' });
const r2 = Bib.build([dupA, dupB], { style: 'csl:harvard-cite-them-right' });
ok('作者-年份制同年补 a/b',
  r2.entries[0].indexOf('(2020a)') > 0 && r2.entries[1].indexOf('(2020b)') > 0,
  r2.entries.join(' || '));

const listed = Cite.styleList();
ok('styleList 带分组', listed.some((x) => x.id === 'csl:vancouver' && x.group === 'CSL 样式（内置）'));
ok('cslStyleInfo 给出 source', Cite.cslStyleInfo('csl:nature').source === 'builtin');

const userXml = styleXml('<text variable="title"/>');
Cite.registerCslStyles([{ id: 'user-demo', label: 'User Demo', xml: userXml }]);
ok('注册用户样式', Cite.styleList().some((x) => x.id === 'csl:user-demo' && x.kind === 'user'));
ok('用户样式可渲染', Cite.format(article, 'csl:user-demo') === 'Deep learning');
Cite.registerCslStyles([]);
ok('清空用户样式后移除', !Cite.styleList().some((x) => x.id === 'csl:user-demo'));

// ---------------------------------------------------------------------------
console.log('\n[11] 字段映射 / 容错');
// ---------------------------------------------------------------------------
ok('出版者 / 出版地 / ISBN / ISSN 映射',
  render('<group delimiter="|"><text variable="publisher"/><text variable="publisher-place"/><text variable="ISBN"/><text variable="ISSN"/></group>',
    { title: 'x', fields: { publisher: 'P', place: 'L', isbn: '978', issn: '1234-5678' } }) === 'P|L|978|1234-5678',
  render('<group delimiter="|"><text variable="publisher"/><text variable="publisher-place"/><text variable="ISBN"/><text variable="ISSN"/></group>',
    { title: 'x', fields: { publisher: 'P', place: 'L', isbn: '978', issn: '1234-5678' } }));
ok('会议名映射到 event', render('<text variable="event"/>', { title: 'x', fields: { conference: 'CHI' } }) === 'CHI');
ok('series 映射到 collection-title', render('<text variable="collection-title"/>', { title: 'x', fields: { series: 'LNCS' } }) === 'LNCS');
ok('citation-number 变量', render('<text variable="citation-number"/>', article, { number: 7 }) === '7');
ok('citekey 变量', render('<text variable="citation-key"/>', article, { citekey: 'smith2020deep' }) === 'smith2020deep');

const warnStyle = Csl.parseStyle(styleXml('<text variable="title"/><fancy/>'));
ok('未知元素进 warnings', warnStyle.warnings.includes('fancy'), warnStyle.warnings.join(','));

threw = false;
try { Csl.parseStyle('<html><body/></html>'); } catch (_) { threw = true; }
ok('非 CSL 根元素抛错', threw);

threw = false;
try { Csl.register(styleXml('<text variable="title"/>').replace('<bibliography>', '<citation>').replace('</bibliography>', '</citation>')); } catch (_) { threw = true; }
ok('没有 bibliography 的样式拒绝注册', threw);

const zhStyle = Csl.parseStyle(styleXml('<text term="page" form="short"/>', ' default-locale="zh-CN"'));
ok('zh-CN locale 词条', Csl.render(zhStyle, article) === '页', Csl.render(zhStyle, article));
const zhOrd = Csl.parseStyle(styleXml('<number variable="edition" form="ordinal"/>', ' default-locale="zh-CN"'));
ok('zh-CN 序数词不硬加 th', Csl.render(zhOrd, { title: 'x', fields: { edition: '2' } }) === '2', Csl.render(zhOrd, { title: 'x', fields: { edition: '2' } }));

console.log('\n[csl] ' + (fail ? 'FAIL (' + fail + ')' : 'PASS') + '  ' + checks + ' checks');
process.exit(fail ? 2 : 0);
