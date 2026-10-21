'use strict';
/*
 * 引用格式化回归（v14）。纯 Node，不启 Electron。
 * 覆盖：GB/T 7714-2015 与 APA 7 两种样式的排版规则、类型标识、缺字段容错。
 * 运行：node scripts/test-cite.js
 */
const path = require('path');
const Cite = require(path.join(__dirname, '..', 'src', 'cite.js'));

let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) console.log('  ok   ' + name);
  else { fail++; console.log('  FAIL ' + name + (detail ? '  <- ' + detail : '')); }
};

const journal = {
  itemType: 'journalArticle',
  title: '深度学习综述',
  creators: ['张三', '李四'],
  year: '2020',
  publication: '计算机学报',
  volume: '43',
  issue: '2',
  pages: '100-110',
  doi: '10.1000/a',
};

// ---------- GB/T 7714-2015 ----------
let s = Cite.gbt(journal);
ok('期刊文章带 [J] 标识', s.indexOf('[J].') > 0, s);
ok('期刊文章作者用逗号分隔', s.indexOf('张三, 李四.') === 0, s);
ok('期刊文章含刊名/年份/卷期/页码', /计算机学报,\s*2020,\s*43\(2\):\s*100-110\./.test(s), s);
ok('期刊文章结尾带 DOI', /DOI:10\.1000\/a\.$/.test(s), s);

s = Cite.gbt({ ...journal, creators: ['A', 'B', 'C', 'D'] });
ok('作者超过 3 个用「等」', s.indexOf('A, B, C, 等') === 0, s);

s = Cite.gbt({ itemType: 'book', title: '书名', creators: ['王五'], year: '2018', publication: '某出版社' });
ok('图书用 [M] 标识', s.indexOf('[M].') > 0, s);
ok('图书含出版社与年份', /某出版社,\s*2018\./.test(s), s);

s = Cite.gbt({ itemType: 'thesis', title: '硕士论文', creators: ['赵六'], year: '2021' });
ok('学位论文用 [D] 标识', s.indexOf('[D].') > 0, s);

s = Cite.gbt({ itemType: 'conferencePaper', title: '会议论文', creators: ['孙七'], year: '2022', publication: '某会议', pages: '5-9' });
ok('会议论文用 [C]// 标识', s.indexOf('[C]//某会议.') > 0, s);

s = Cite.gbt({ itemType: 'webpage', title: '网页标题', creators: ['周八'], url: 'https://example.com/a' });
ok('网页用 [EB/OL] 标识', s.indexOf('[EB/OL].') > 0, s);
ok('网页带链接', s.indexOf('https://example.com/a') > 0, s);

s = Cite.gbt({ itemType: 'report', title: '报告', creators: ['吴九'], year: '2020', publication: '某机构' });
ok('报告用 [R] 标识', s.indexOf('[R].') > 0, s);

s = Cite.gbt({ itemType: 'document', title: '普通文档', creators: ['郑十'] });
ok('其它类型用 [Z] 标识', s.indexOf('[Z].') > 0, s);

// 缺字段容错
s = Cite.gbt({ title: '只有标题' });
ok('缺作者不报错且有标题', s.indexOf('只有标题') === 0, s);
s = Cite.gbt({ itemType: 'journalArticle', title: '无年份', creators: ['甲'], publication: '刊' });
ok('缺年份容错（不留悬空逗号）', s === '甲. 无年份[J]. 刊.', s);
s = Cite.gbt(null);
ok('null 条目返回空串', s === '', JSON.stringify(s));
s = Cite.gbt({});
ok('空条目返回空串', s === '', JSON.stringify(s));

// ---------- APA 7 ----------
s = Cite.apa(journal);
ok('APA 含年份括号', s.indexOf('(2020).') > 0, s);
ok('APA 作者用 & 连接', s.indexOf('张三, & 李四') === 0, s);
ok('APA 含刊名卷期页码', /计算机学报,\s*43\(2\),\s*100-110\./.test(s), s);
ok('APA DOI 用 https 形式', /https:\/\/doi\.org\/10\.1000\/a$/.test(s), s);

s = Cite.apa({ ...journal, creators: ['A', 'B', 'C'] });
ok('APA 三位以上作者用 et al.', s.indexOf('A, et al.') === 0, s);

s = Cite.apa({ itemType: 'book', title: '书名', creators: ['王五'], year: '2018', publication: '某出版社' });
ok('APA 图书含出版社', s.indexOf('某出版社.') > 0, s);

s = Cite.apa({ itemType: 'thesis', title: '硕士论文', creators: ['赵六'], year: '2021' });
ok('APA 学位论文带 [Doctoral dissertation]', s.indexOf('[Doctoral dissertation]') > 0, s);

s = Cite.apa({ itemType: 'journalArticle', title: '无年份', creators: ['甲'] });
ok('APA 缺年份用 n.d.', s.indexOf('(n.d.).') > 0, s);

// ---------- 统一入口 ----------
ok('format 默认走 GB/T', Cite.format(journal) === Cite.gbt(journal));
ok('format(apa) 走 APA', Cite.format(journal, 'apa') === Cite.apa(journal));
ok('format 未知样式退回 GB/T', Cite.format(journal, 'nope') === Cite.gbt(journal));
ok('styleLabel 有中文名', Cite.styleLabel('gbt7714') === 'GB/T 7714-2015', Cite.styleLabel('gbt7714'));
ok('typeLabel 有中文名', Cite.typeLabel(journal) === '期刊文章', Cite.typeLabel(journal));
ok('样式表有 5 种', Cite.STYLES.length === 5, String(Cite.STYLES.length));

// ---------- 新增样式（v19：Chicago / IEEE / MLA） ----------
s = Cite.chicago(journal);
ok('Chicago 含年份与标题引号', s.indexOf('2020.') > 0 && s.indexOf('"深度学习综述."') > 0, s);
ok('Chicago 含刊名卷期页码', /计算机学报 43 \(2\): 100-110\./.test(s), s);
ok('Chicago 作者超 3 个用 et al.', Cite.chicago({ ...journal, creators: ['A', 'B', 'C', 'D'] }).indexOf('et al.') > 0);

s = Cite.ieee(journal);
ok('IEEE 以 [1] 开头', s.indexOf('[1] ') === 0, s);
ok('IEEE 含 vol./no./pp.', /vol\. 43, no\. 2, pp\. 100-110/.test(s), s);
ok('IEEE 含年份与 doi', s.indexOf('2020') > 0 && s.indexOf('doi: 10.1000/a') > 0, s);

s = Cite.mla(journal);
ok('MLA 标题带引号', s.indexOf('"深度学习综述."') > 0, s);
ok('MLA 含 vol. 与 pp.', s.indexOf('vol. 43') > 0 && s.indexOf('pp. 100-110') > 0, s);

ok('format(chicago) 走 Chicago', Cite.format(journal, 'chicago') === Cite.chicago(journal));
ok('format(ieee) 走 IEEE', Cite.format(journal, 'ieee') === Cite.ieee(journal));
ok('format(mla) 走 MLA', Cite.format(journal, 'mla') === Cite.mla(journal));
ok('样式表有 5 种', Cite.STYLES.length === 5, String(Cite.STYLES.length));

console.log('[cite] ' + (fail ? 'FAIL (' + fail + ')' : 'PASS'));
process.exit(fail ? 2 : 0);
