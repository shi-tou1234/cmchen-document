'use strict';
/*
 * 引用键模板（v35）回归：纯 Node，不启 Electron。
 *
 * 重点不是「模板能拼出字符串」，而是三件事：
 *   1. 默认模板必须与改造前的固定规则逐字符一致——老用户已经贴进文稿的 [@key] 不能变；
 *   2. 修饰符 / 字段的边界（缺作者、中文作者、缺年份、未知字段）不能产出空键或乱码键；
 *   3. 整库分配的重名后缀与列表顺序无关（同一批条目、换个顺序，键必须一样）。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Cite = require('../src/cite.js');
const Settings = require('../src/settings.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.log('  FAIL ' + name + (detail === undefined ? '' : ' :: ' + detail));
}
function eq(name, got, want) {
  ok(name, got === want, 'got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want));
}

// ---------- 夹具 ----------
const v2017 = {
  key: 'k1', itemType: 'journalArticle', year: '2017',
  title: 'Attention Is All You Need',
  creators: [{ lastName: 'Vaswani', firstName: 'Ashish' }, { lastName: 'Shazeer', firstName: 'Noam' }],
  publication: 'Advances in Neural Information Processing Systems',
  journalAbbreviation: 'NeurIPS',
  volume: '30', pages: '5998-6008', doi: '10.5555/3295222.3295349',
};
const book2020 = { key: 'k2', itemType: 'book', year: '2020', title: 'The Craft of Research', creators: [{ lastName: 'Booth', firstName: 'Wayne' }] };
const noAuthor = { key: 'k3', itemType: 'document', year: '1999', title: 'Anonymous Report' };
const cjk = { key: 'k4', itemType: 'journalArticle', year: '2021', title: '中文标题的实验', creators: [{ lastName: '张三', firstName: '三' }] };
const noYear = { key: 'k5', itemType: 'webpage', title: 'Undated Page', creators: [{ lastName: 'Doe', firstName: 'Jane' }] };

// 改造前的算法（原样抄一份，用来对拍默认模板）
function legacyCitekey(it) {
  const slug = (s, max) => String(s == null ? '' : s)
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '').toLowerCase().slice(0, max || 28);
  const STOP = new Set(['the', 'a', 'an', 'on', 'of', 'for', 'and', 'to', 'in', 'with', 'from', 'by', 'at', 'as']);
  const titleWord = (title) => {
    const words = String(title || '').match(/[A-Za-z][A-Za-z0-9]{2,}/g) || [];
    for (const w of words) if (!STOP.has(w.toLowerCase())) return slug(w, 12);
    return '';
  };
  const list = Array.isArray(it.creators) ? it.creators : [];
  const first = list[0] || null;
  let who = slug(first ? (first.lastName || first.firstName) : '');
  const year = (String(it.year || '').match(/\d{4}/) || [''])[0] || 'nd';
  if (!who) who = 'item' + slug(it.key || '', 4);
  const base = (who + year + titleWord(it.title)).slice(0, 40);
  return base || ('item' + year);
}

// ---------- 1. 默认模板与旧算法对拍 ----------
const fixtures = [v2017, book2020, noAuthor, cjk, noYear];
for (const it of fixtures) {
  eq('默认模板 == 旧算法（' + it.key + '）', Cite.citekey(it), legacyCitekey(it));
}
eq('传入空模板等于默认模板', Cite.citekey(v2017, { template: '' }), legacyCitekey(v2017));
eq('不含方括号的串退回默认模板', Cite.citekey(v2017, 'auth year'), legacyCitekey(v2017));
eq('模板用字符串直接传也行', Cite.citekey(v2017, '[auth][year]'), 'Vaswani2017');

// 第三轮审查漏掉的兼容面（R4-04）：旧算法用 slug() 洗作者段、标题首词截 12 字符。
// 连字符、重音、超长姓氏、超长标题词、中文作者，这五类以前没进夹具，重构时悄悄走样了。
const compat = [
  { key: 'c1', year: '2024', title: 'A Study', creators: [{ lastName: 'Smith-Jones' }] },
  { key: 'c2', year: '2024', title: 'Electroencephalography Methods', creators: [{ lastName: 'Smith' }] },
  { key: 'c3', year: '2024', title: 'Über die Elektrodynamik', creators: [{ lastName: 'Müller' }] },
  { key: 'c4', year: '2024', title: 'On the Continuity of Gases', creators: [{ lastName: 'van der Waals' }] },
  { key: 'c5', year: '2024', title: 'A Long Surname Study', creators: [{ lastName: 'Wolfeschlegelsteinhausenbergerdorff' }] },
  { key: 'c6', year: '2024', title: '数据驱动的实验方法', creators: [{ lastName: '李四' }] },
  { key: 'c7', year: '2024', title: 'Self-Supervised Learning', creators: [{ lastName: 'O’Brien' }] },
  // R5-04：混合作者。第一作者不能转写时旧算法用 item+key 兜底，**不会顺位换成第二作者**。
  // 这类夹具以前没有，所以「先 filter 再取 [0]」把第一作者身份换掉时测试是绿的。
  { key: 'c8', year: '2024', title: 'Neural Models', creators: [{ lastName: '王', firstName: '伟' }, { lastName: 'Smith', firstName: 'John' }] },
  { key: 'c9', year: '2024', title: 'Neural Models', creators: [{ lastName: 'Smith', firstName: 'John' }, { lastName: '王', firstName: '伟' }] },
];
for (const it of compat) eq('默认模板 == 旧算法（' + it.key + '）', Cite.citekey(it), legacyCitekey(it));
eq('混合作者：中文第一作者仍走 item+key 兜底，不换成第二作者', Cite.citekey(compat[7]), 'itemc82024neural');
eq('混合作者：英文第一作者取自己', Cite.citekey(compat[8]), 'smith2024neural');
eq('混合作者：自定义 [auth] 同样守第一作者语义', Cite.citekey(compat[7], '[auth][year]'), 'itemc82024');
eq('混合作者：[auth2] 取前两位，第二作者仍可用', Cite.citekey(compat[7], '[auth2]'), 'itemc8Smith');
eq('显式写出默认模板也要等价', Cite.citekey(compat[0], { template: '[auth:lower][year][veryshorttitle:lower]' }), legacyCitekey(compat[0]));
eq('auth 段不含连字符', Cite.citekey(compat[0], '[auth][year]'), 'SmithJones2024');
eq('auth 段去掉撇号', Cite.citekey(compat[6], '[auth]'), 'OBrien');
eq('veryshorttitle 沿用旧口径截 12 字符', Cite.citekey(compat[1], '[veryshorttitle:upper]'), 'ELECTROENCEP');
eq('长姓氏截到 28 字符', Cite.citekey(compat[4], '[auth:lower]'), legacyCitekey(compat[4]).slice(0, 28));

// ---------- 2. 字段展开 ----------
eq('auth 保留原大小写', Cite.citekey(v2017, '[auth]'), 'Vaswani');
eq('authEtAl 多于一位作者时加 EtAl', Cite.citekey(v2017, '[auth][authEtAl]'), 'VaswaniVaswaniEtAl');
eq('authEtAl 单作者不追加', Cite.citekey(book2020, '[authEtAl]'), 'Booth');
eq('authIni 取每位作者的姓首字母', Cite.citekey(v2017, '[authIni]'), 'VS');
eq('authN 取前 N 位', Cite.citekey(v2017, '[auth2]'), 'VaswaniShazeer');
eq('auth1 只取第一位', Cite.citekey(v2017, '[auth1]'), 'Vaswani');
eq('authors 全部姓', Cite.citekey(v2017, '[authors][year]'), 'VaswaniShazeer2017');
eq('year 四位年份', Cite.citekey(v2017, '[year]'), '2017');
eq('shortyear 后两位', Cite.citekey(v2017, '[shortyear]'), '17');
eq('缺年份 year 给 nd', Cite.citekey(noYear, '[auth][year]'), 'Doend');
eq('title 驼峰拼接', Cite.citekey(v2017, '[title]'), 'AttentionIsAllYouNeed');
eq('shorttitle 前 3 个实词（跳过 Is）', Cite.citekey(v2017, '[shorttitle]'), 'AttentionAllYou');
eq('veryshorttitle 第一个实词', Cite.citekey(v2017, '[veryshorttitle]'), 'Attention');
eq('journalabbr 用缩写字段', Cite.citekey(v2017, '[journalabbr]'), 'NeurIPS');
eq('journal 去标点（并受 40 字符上限约束）', Cite.citekey(v2017, '[journal]'), 'AdvancesinNeuralInformationProcessingSys');
eq('volume / pages', Cite.citekey(v2017, '[volume]-[pages]'), '30-5998-6008');
eq('firstpage 只取起始页', Cite.citekey(v2017, '[firstpage]'), '5998');
eq('lastpage 只取末页', Cite.citekey(v2017, '[lastpage]'), '6008');
ok('doi 里的斜杠被清掉', Cite.citekey(v2017, '[doi]') === '10.55553295222.3295349', Cite.citekey(v2017, '[doi]'));
eq('itemtype 用 BibTeX 式类型名', Cite.citekey(v2017, '[itemtype]'), 'article');
eq('key 取条目 key 前缀', Cite.citekey(v2017, '[key]'), 'k1');

// ---------- 3. 修饰符 ----------
eq('lower', Cite.citekey(v2017, '[auth:lower]'), 'vaswani');
eq('upper', Cite.citekey(v2017, '[auth:upper]'), 'VASWANI');
eq('capitalize（先小写再首字母大写）', Cite.citekey(v2017, '[auth:lower:capitalize]'), 'Vaswani');
eq('abbr 取每词首字母', Cite.citekey(v2017, '[shorttitle:abbr]'), 'AAY');
eq('数字截断', Cite.citekey(v2017, '[auth:3]'), 'Vas');
eq('多个修饰符串联', Cite.citekey(v2017, '[auth:lower:3][shortyear]'), 'vas17');
eq('abbr 之后还能截断', Cite.citekey(v2017, '[shorttitle:abbr:2]'), 'AA');
eq('未知修饰符被忽略', Cite.citekey(v2017, '[auth:nosuch]'), 'Vaswani');
eq('未知字段展开为空', Cite.citekey(v2017, '[nosuchfield][year]'), '2017');

// ---------- 4. 边界：不能产出空键 / 乱码键 ----------
ok('中文作者的键不为空', Cite.citekey(cjk, '[auth][year][title]').length > 0, Cite.citekey(cjk, '[auth][year][title]'));
ok('中文作者退到 item+key 兜底', /^item/.test(Cite.citekey(cjk, '[auth][year]')), Cite.citekey(cjk, '[auth][year]'));
eq('无作者无标题也非空', Cite.citekey({ key: 'zz9', itemType: 'document' }, '[auth]'), 'itemzz9');
eq('只写年份是合法键（不被兜底改写）', Cite.citekey(v2017, '[year]'), '2017');
eq('只写类型偏移量也合法', Cite.citekey(v2017, '[volume]'), '30');
eq('空条目返回空串', Cite.citekey(null), '');
ok('字面量里的空格与括号被清掉', Cite.citekey(v2017, '[auth] (draft)').indexOf(' ') < 0, Cite.citekey(v2017, '[auth] (draft)'));
eq('键长上限沿用旧实现的 40', Cite.citekey(v2017, '[authors][title][title][title]').length, 40);

// ---------- 5. 整库分配：重名后缀与顺序无关 ----------
const same = [
  { key: 'b', year: '2020', title: 'Alpha', creators: [{ lastName: 'Smith' }] },
  { key: 'a', year: '2020', title: 'Beta', creators: [{ lastName: 'Smith' }] },
  { key: 'c', year: '2020', title: 'Gamma', creators: [{ lastName: 'Smith' }] },
];
const m1 = Cite.citekeys(same, { template: '[auth:lower][year]' });
const m2 = Cite.citekeys(same.slice().reverse(), { template: '[auth:lower][year]' });
eq('排序无关：b 的键稳定', m1.get('b'), m2.get('b'));
eq('排序无关：a 的键稳定', m1.get('a'), m2.get('a'));
eq('第一个（key 最小）不加后缀', m1.get('a'), 'smith2020');
eq('后两个依次 -2 / -3', m1.get('b') + '|' + m1.get('c'), 'smith2020-2|smith2020-3');
eq('不传模板时用默认', Cite.citekeys(same).get('a'), 'smith2020beta');

// ---------- 6. 设置项：模板规范化 ----------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-ck-'));
try {
  Settings.init(dir);
  eq('默认设置为空（用默认模板）', Settings.get().citeKeyTemplate, '');
  eq('保存合法模板', Settings.set({ citeKeyTemplate: '[auth:lower][year]' }).settings.citeKeyTemplate, '[auth:lower][year]');
  eq('不含 [字段] 的模板按空处理', Settings.set({ citeKeyTemplate: 'not a template' }).settings.citeKeyTemplate, '');
  eq('超长模板按空处理', Settings.set({ citeKeyTemplate: '[auth]'.repeat(60) }).settings.citeKeyTemplate, '');
  eq('前后空白被去掉', Settings.set({ citeKeyTemplate: '  [auth]  ' }).settings.citeKeyTemplate, '[auth]');
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  eq('模板落到 settings.json', onDisk.citeKeyTemplate, '[auth]');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('test-citekey: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
