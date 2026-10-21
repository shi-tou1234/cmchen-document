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
ok('会议论文年份与页码之间不留 .:', s.indexOf('2022: 5-9.') > 0 && s.indexOf('.:') < 0, s);

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

// ---------- v27：文献库 v5 的 37 类条目 ----------
ok('TYPE_CODE 覆盖 37 类', Object.keys(Cite.TYPE_CODE).length === 37, String(Object.keys(Cite.TYPE_CODE).length));
ok('每个类型都有中文名', Object.keys(Cite.TYPE_CODE).every((k) => !!Cite.TYPE_NAME[k]),
  Object.keys(Cite.TYPE_CODE).filter((k) => !Cite.TYPE_NAME[k]).join(','));
ok('typeLabel 认识数据集', Cite.typeLabel({ itemType: 'dataset' }) === '数据集', Cite.typeLabel({ itemType: 'dataset' }));
ok('typeLabel 未知类型退回文档', Cite.typeLabel({ itemType: 'nope' }) === '文档');

const typeCase = (itemType, code, extra) => {
  const s2 = Cite.gbt({ itemType, title: '题名', creators: ['甲'], year: '2020', publication: '来源', ...(extra || {}) });
  return { s: s2, hit: s2.indexOf('[' + code + ']') > 0 };
};

let tc = typeCase('bookSection', 'M', { pages: '1-12' });
ok('图书章节用 [M]//', tc.hit && tc.s.indexOf('[M]//来源') > 0, tc.s);
ok('图书章节年份与页码之间不留 .:', tc.s.indexOf('2020: 1-12.') > 0, tc.s);
tc = typeCase('newspaperArticle', 'N');
ok('报纸文章用 [N]', tc.hit && tc.s.indexOf('[N].') > 0, tc.s);
tc = typeCase('preprint', 'Z');
ok('预印本用 [Z]', tc.hit && tc.s.indexOf('[Z].') > 0, tc.s);
tc = typeCase('software', 'CP');
ok('软件用 [CP]', tc.hit, tc.s);
tc = typeCase('dataset', 'DS');
ok('数据集用 [DS]', tc.hit, tc.s);
tc = typeCase('map', 'CM');
ok('地图用 [CM]', tc.hit, tc.s);
tc = typeCase('patent', 'P');
ok('专利用 [P]', tc.hit, tc.s);
tc = typeCase('standard', 'S');
ok('标准用 [S]', tc.hit, tc.s);
tc = typeCase('film', 'V');
ok('电影用 [V]', tc.hit, tc.s);
tc = typeCase('videoRecording', 'V');
ok('视频用 [V]', tc.hit, tc.s);

// ---------- 引用键 citekey ----------
const en = { key: 'smith2020', itemType: 'journalArticle', creators: ['John Smith'], year: '2020', title: 'The Great Gatsby' };
ok('citekey 英文规则为 姓+年+标题词', Cite.citekey(en) === 'smith2020great', Cite.citekey(en));
ok('citekey 对同一条目稳定', Cite.citekey(en) === Cite.citekey({ ...en }));
ok('citekey 从「2020-05」中取年份', Cite.citekey({ ...en, year: '2020-05' }) === 'smith2020great');
ok('citekey 无年份用 nd', Cite.citekey({ key: 'k1', creators: ['Li Si'], title: 'A Study' }) === 'sindstudy',
  Cite.citekey({ key: 'k1', creators: ['Li Si'], title: 'A Study' }));
ok('citekey 中文作者退化为 item+key', Cite.citekey({ key: 'ABCD1234', creators: ['张三'], year: '2021', title: '深度学习' }) === 'itemabcd2021',
  Cite.citekey({ key: 'ABCD1234', creators: ['张三'], year: '2021', title: '深度学习' }));
ok('citekey 无作者也稳定', Cite.citekey({ key: 'x9', year: '2019', title: 'Report on Things' }) === 'itemx92019report',
  Cite.citekey({ key: 'x9', year: '2019', title: 'Report on Things' }));
ok('citekey 最长 40 字符', Cite.citekey({ key: 'k', creators: ['A'.repeat(40)], year: '2020', title: 'B'.repeat(40) }).length <= 40);

ok('atCitation 生成 Pandoc 行内引用', Cite.atCitation('smith2020great') === '[@smith2020great]', Cite.atCitation('smith2020great'));
ok('atCitation 空键返回空串', Cite.atCitation('') === '');

const dupA = { key: 'b', creators: ['John Smith'], year: '2020', title: 'The Great Gatsby' };
const dupB = { key: 'a', creators: ['John Smith'], year: '2020', title: 'The Great Gatsby' };
const keys1 = Cite.citekeys([dupA, dupB]);
ok('citekeys 先按 key 排序分配', keys1.get('a') === 'smith2020great' && keys1.get('b') === 'smith2020great-2',
  keys1.get('a') + ' / ' + keys1.get('b'));
const keys2 = Cite.citekeys([dupB, dupA]);
ok('citekeys 与输入顺序无关', keys2.get('a') === keys1.get('a') && keys2.get('b') === keys1.get('b'));
ok('citekeys 跳过没有 key 的条目', Cite.citekeys([{ creators: ['A B'] }]).size === 0);

console.log('[cite] ' + (fail ? 'FAIL (' + fail + ')' : 'PASS'));
process.exit(fail ? 2 : 0);
