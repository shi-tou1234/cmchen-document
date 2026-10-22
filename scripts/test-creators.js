'use strict';
/*
 * 作者结构化（数据层 v6）回归。纯 Node，不启 Electron。
 * 覆盖：姓名拆分 / 归一化 / v5→v6 迁移 / 5 种引用样式的姓名拆分 / 姓氏排序 / citekey /
 *       BibTeX·RIS·CSL-JSON 往返。
 * 运行：node scripts/test-creators.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const Creators = require(path.join(ROOT, 'src', 'creators.js'));
const Cite = require(path.join(ROOT, 'src', 'cite.js'));
const Bib = require(path.join(ROOT, 'src', 'bib.js'));
const formats = require(path.join(ROOT, 'src', 'formats.js'));
const lib = require(path.join(ROOT, 'src', 'library.js'));

let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) console.log('  ok   ' + name);
  else { fail++; console.log('  FAIL ' + name + (detail ? '  <- ' + detail : '')); }
};

// ---------- 姓名拆分 ----------
let p = Creators.parseName('Smith, John');
ok('逗号写法：姓在前名在后', p.lastName === 'Smith' && p.firstName === 'John', JSON.stringify(p));
p = Creators.parseName('John Smith');
ok('空格写法：名在前姓在后', p.lastName === 'Smith' && p.firstName === 'John', JSON.stringify(p));
p = Creators.parseName('J. R. Smith');
ok('带缩写点：姓取最后一段', p.lastName === 'Smith' && p.firstName === 'J. R.', JSON.stringify(p));
p = Creators.parseName('张三');
ok('中文名不拆', p.lastName === '张三' && p.firstName === '', JSON.stringify(p));
p = Creators.parseName('中国科学院计算所');
ok('机构名不拆', p.lastName === '中国科学院计算所' && p.firstName === '', JSON.stringify(p));
p = Creators.parseName('{World Health Organization}');
ok('花括号 = 原样显示', p.lastName === 'World Health Organization' && p.firstName === '', JSON.stringify(p));
p = Creators.parseName('van der Berg, Jan');
ok('复姓带前缀', p.lastName === 'van der Berg' && p.firstName === 'Jan', JSON.stringify(p));
p = Creators.parseName('Smith, John, Jr.');
ok('三段逗号：后缀并进名', p.lastName === 'Smith' && p.firstName === 'John Jr.', JSON.stringify(p));

// ---------- 归一化 ----------
let list = Creators.normalizeCreators(['张三', 'Brown, John']);
ok('字符串作者被拆成结构', list.length === 2 && list[0].lastName === '张三' && list[1].lastName === 'Brown'
  && list[1].firstName === 'John', JSON.stringify(list));
ok('默认角色是作者', list.every((c) => c.creatorType === 'author'), JSON.stringify(list));
list = Creators.normalizeCreators([
  { firstName: 'John', lastName: 'Smith', creatorType: 'editor' },
  { firstName: 'John', lastName: 'Smith', creatorType: 'editor' },
]);
ok('同人同角色去重', list.length === 1, JSON.stringify(list));
list = Creators.normalizeCreators([
  { firstName: 'John', lastName: 'Smith', creatorType: 'author' },
  { firstName: 'John', lastName: 'Smith', creatorType: 'editor' },
]);
ok('同人不同时代不合并', list.length === 2, JSON.stringify(list));
list = Creators.normalizeCreators([{ firstName: 'A', lastName: 'B', creatorType: '不存在的角色' }, null, '', 123]);
ok('未知角色退回作者', list.length === 1 && list[0].creatorType === 'author', JSON.stringify(list));
ok('空输入返回空数组', Creators.normalizeCreators(null).length === 0 && Creators.normalizeCreators([]).length === 0);

// ---------- 展示与缩写 ----------
ok('展示名是「名 姓」', Creators.displayName({ firstName: 'John', lastName: 'Smith' }) === 'John Smith');
ok('只有姓就显示姓', Creators.displayName({ firstName: '', lastName: '张三' }) === '张三');
ok('列表拼接', Creators.displayList([{ firstName: '', lastName: '张三' }, { firstName: 'John', lastName: 'Smith' }]) === '张三, John Smith');
ok('首字母缩写带点', Creators.initials('John Michael') === 'J. M.', Creators.initials('John Michael'));
ok('首字母缩写不带点', Creators.initials('John Michael', false) === 'J M', Creators.initials('John Michael', false));
ok('连字符名缩写', Creators.initials('Jean-Paul') === 'J.-P.', Creators.initials('Jean-Paul'));
ok('排序键取姓', Creators.sortName({ firstName: 'John', lastName: 'Smith' }) === 'Smith');

// ---------- 引用样式：结构化姓名真正被拆开 ----------
const it = {
  key: 'k1', itemType: 'journalArticle', title: 'A Study',
  creators: [{ firstName: 'John', lastName: 'Smith', creatorType: 'author' },
    { firstName: 'Kim', lastName: 'Lee', creatorType: 'author' }],
  year: '2020', publication: 'J', volume: '1', issue: '2', pages: '3-9',
};
ok('GB/T 外文作者姓全大写名缩写', Cite.gbt(it).indexOf('SMITH J, LEE K') === 0, Cite.gbt(it));
ok('APA 姓在前 + 名字缩写', Cite.apa(it).indexOf('Smith, J., & Lee, K.') === 0, Cite.apa(it));
ok('Chicago 第一位姓在前', Cite.chicago(it).indexOf('Smith, John, and Kim Lee') === 0, Cite.chicago(it));
ok('IEEE 名缩写在前', Cite.ieee(it).indexOf('J. Smith and K. Lee') > 0, Cite.ieee(it));
ok('MLA 第一位姓在前', Cite.mla(it).indexOf('Smith, John, and Kim Lee') === 0, Cite.mla(it));

const zh = { key: 'k2', itemType: 'journalArticle', title: '中文', creators: [{ firstName: '', lastName: '张三', creatorType: 'author' }], year: '2020' };
ok('中文名在 GB/T 原样输出', Cite.gbt(zh).indexOf('张三.') === 0, Cite.gbt(zh));
ok('中文名在 APA 原样输出', Cite.apa(zh).indexOf('张三') === 0, Cite.apa(zh));

// 结构化作者也能直接吃字符串（旧数据 / 外部调用）
ok('字符串作者仍能格式化', Cite.apa({ ...it, creators: ['Smith, John'] }).indexOf('Smith, J.') === 0, Cite.apa({ ...it, creators: ['Smith, John'] }));

// ---------- citekey 用姓 ----------
ok('citekey 用结构化姓氏', Cite.citekey(it) === 'smith2020study', Cite.citekey(it));
ok('citekey 对字符串作者同样稳定', Cite.citekey({ ...it, creators: ['Smith, John'] }) === 'smith2020study', Cite.citekey({ ...it, creators: ['Smith, John'] }));

// ---------- 参考文献表按姓氏排序 ----------
const sorted = Bib.build([
  { key: 'b', title: 'B', creators: [{ firstName: 'Zoe', lastName: 'Zhao', creatorType: 'author' }], year: '2020' },
  { key: 'a', title: 'A', creators: [{ firstName: 'Amy', lastName: 'Adams', creatorType: 'author' }], year: '2020' },
], { style: 'apa' });
ok('参考文献表按姓氏排', /^Adams, A\./.test(sorted.entries[0]), sorted.entries.join(' | '));

// ---------- 导入导出往返 ----------
const bib = formats.parseBibtex('@article{x, title={T}, author={Smith, John and Doe, Jane and {ACME Lab}}, year={2020}}');
ok('BibTeX 导入拆成结构', bib[0].creators.length === 3 && bib[0].creators[0].lastName === 'Smith'
  && bib[0].creators[0].firstName === 'John' && bib[0].creators[2].lastName === 'ACME Lab', JSON.stringify(bib[0].creators));
const bibOut = formats.recordsToBibtex(bib);
ok('BibTeX 导出写 "姓, 名"', /author = \{Smith, John and Doe, Jane and \{ACME Lab\}\}/.test(bibOut), bibOut.slice(0, 200));
const ris = formats.parseRis('TY  - JOUR\nTI  - T\nAU  - Smith, John\nED  - Doe, Jane\nER  - \n');
ok('RIS 导入区分作者与编者', ris[0].creators.length === 2 && ris[0].creators[0].creatorType === 'author'
  && ris[0].creators[1].creatorType === 'editor', JSON.stringify(ris[0].creators));
const csl = formats.parseCslJson(JSON.stringify([{ type: 'article-journal', title: 'T', author: [{ family: 'Smith', given: 'John' }, { literal: 'ACME' }] }]));
ok('CSL-JSON 导入拆成结构', csl[0].creators[0].lastName === 'Smith' && csl[0].creators[0].firstName === 'John'
  && csl[0].creators[1].lastName === 'ACME', JSON.stringify(csl[0].creators));
const cslOut = JSON.parse(formats.recordsToCslJson(csl));
ok('CSL-JSON 导出 family/given', cslOut[0].author[0].family === 'Smith' && cslOut[0].author[0].given === 'John'
  && cslOut[0].author[1].literal === 'ACME', JSON.stringify(cslOut[0].author));

// ---------- v5 → v6 迁移 ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'creators-'));
const store = path.join(tmp, 'library.json');
fs.writeFileSync(store, JSON.stringify({
  version: 5,
  collections: [], searches: [], tagColors: {},
  items: [{
    key: 'old1', itemType: 'journalArticle', title: '旧条目',
    creators: ['张三', 'Brown, John'], year: '2020', tags: [], collectionIds: [],
    attachment: null, page: 0, created: 1, updated: 1, deletedAt: 0,
  }],
}));
process.env.PDFREADER_LIBRARY = store;
lib.resetCache();
const sum = lib.summary();
ok('v5 库读出来是 v8', sum.version === 8, 'version=' + sum.version);
ok('v5 字符串作者被拆成结构', sum.items[0].creators.length === 2
  && sum.items[0].creators[0].lastName === '张三'
  && sum.items[0].creators[1].lastName === 'Brown' && sum.items[0].creators[1].firstName === 'John',
  JSON.stringify(sum.items[0].creators));
const onDisk = JSON.parse(fs.readFileSync(store, 'utf8'));
ok('迁移后落盘版本是 8', onDisk.version === 8, 'version=' + onDisk.version);
ok('迁移后落盘作者是结构', Array.isArray(onDisk.items[0].creators[0]) === false
  && onDisk.items[0].creators[0].lastName === '张三', JSON.stringify(onDisk.items[0].creators));
ok('迁移前留了备份', fs.readdirSync(path.join(tmp, 'backups')).some((f) => /pre-v5/.test(f)),
  fs.readdirSync(path.join(tmp, 'backups')).join(','));

// 迁移后新增 / 编辑仍然正常
lib.addItem({ title: '新条目', creators: ['Lee, Kim'] });
const after = lib.summary();
ok('迁移后能新增结构化作者', after.items.some((x) => x.title === '新条目'
  && x.creators[0].lastName === 'Lee' && x.creators[0].firstName === 'Kim'), JSON.stringify(after.items[0].creators));
lib.updateItem(after.items.find((x) => x.title === '新条目').key, { creators: [{ firstName: 'Kim', lastName: 'Lee', creatorType: 'editor' }] });
ok('迁移后能改角色', lib.summary().items.find((x) => x.title === '新条目').creators[0].creatorType === 'editor');

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}

console.log('[creators] ' + (fail ? 'FAIL (' + fail + ')' : 'PASS'));
process.exit(fail ? 2 : 0);
