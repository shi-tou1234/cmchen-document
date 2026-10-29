'use strict';
/*
 * 参考文献表批量入库（v36）回归：纯 Node，不联网、不建库。
 *
 * 覆盖三件事：
 *   1. 切分：编号制 / 作者-年份制 / GB/T 7714 / 跨行条目 / 标题行与页码的干扰；
 *   2. 解析：DOI、arXiv、年份、标题、作者、刊名卷期页、类型；
 *   3. 查重与落库形态：DOI 优先、标题+年份次之、批内重复、弱条目不进、
 *      mergeMeta 用官方题录覆盖猜测、toRecord 只在没抓到题录时把原文留进笔记。
 * 运行：node scripts/test-refimport.js
 */
const assert = require('assert');
const R = require('../src/refimport.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.log('  FAIL ' + name + (detail === undefined ? '' : ' :: ' + detail));
}
function eq(name, got, want) {
  ok(name, got === want, 'got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want));
}

// ---------- 夹具：三种主流参考文献写法 ----------

// ① 编号制 + 引号标题（IEEE 风格），第 5 条跨行
const IEEE = [
  'References',
  '[1] J. Smith and A. Lee, "Deep learning for document analysis," IEEE Trans. Pattern Anal. Mach. Intell., vol. 42, no. 5, pp. 1123–1140, 2020.',
  '[2] A. Vaswani, N. Shazeer, N. Parmar, et al. Attention is all you need. arXiv:1706.03762, 2017.',
  '[3] C. M. Bishop, Pattern Recognition and Machine Learning. Springer, 2006.',
  '[4] A. Krizhevsky, I. Sutskever, and G. E. Hinton, "ImageNet classification with deep convolutional neural networks," in Advances in Neural Information Processing Systems, 2012, pp. 1097-1105.',
  '[5] J. Smith, A. Lee, and B. Chen, "A very long title that',
  'spans two lines in the PDF," Journal of Testing, vol. 3, 2021, pp. 1-9.',
];

// ② 作者-年份制（APA）：括号年份 + 卷(期) + 页码 + DOI
const APA = [
  'Bibliography',
  'Smith, J. A., & Jones, B. (2019). A survey of PDF text extraction. Journal of Documentation, 75(3), 456-478. https://doi.org/10.1108/JD-01-2019-0001',
  'Lee, C. (2021). Reading interfaces for scholars. Digital Scholarship, 12(2), 33-51.',
];

// ③ GB/T 7714：文献类型标记 [J]/[M]
const GBT = [
  '参考文献',
  '[1] 张三, 李四. 基于深度学习的文档分析[J]. 计算机学报, 2020, 43(2): 123-135.',
  '[2] 王五. 数字阅读界面设计[M]. 北京: 清华大学出版社, 2021.',
  '[3] 李四. 阅读器中的标注系统[J]. 软件学报, 2019, 30(8): 2401-2415.',
];

// ---------- 1. 切分 ----------
console.log('1. 切分');
{
  const a = R.parseSection(IEEE);
  eq('IEEE：标题行被吃掉', a.heading, true);
  eq('IEEE：跨行条目算一条', a.entries.length, 5);
  eq('IEEE：跨行条目正文接上了', a.entries[4].title, 'A very long title that spans two lines in the PDF');
  eq('IEEE：作者行不会被当成新条目', a.entries[0].creators.length, 2);

  const b = R.parseSection(APA);
  eq('APA：两条', b.entries.length, 2);
  eq('APA：作者-年份行是条目开头', b.entries[1].title, 'Reading interfaces for scholars');

  const c = R.parseSection(GBT);
  eq('GB/T：三条', c.entries.length, 3);

  // 页码、重复的页眉都必须在切分前被清掉，否则会成为「续行」把上一条吃掉
  const noisy = R.parseSection(['REFERENCES', '[1] A. One. Title one. Journal A, 2020.', '12', 'REFERENCES', '[2] B. Two. Title two. Journal B, 2021.']);
  eq('页码 / 重复页眉不干扰切分', noisy.entries.length, 2);
  eq('脏输入里第一条仍然完整', noisy.entries[0].title, 'Title one');
}

// ---------- 2. 解析字段 ----------
console.log('2. 解析字段');
{
  const e = R.parseSection(IEEE).entries;
  eq('引号标题', e[0].title, 'Deep learning for document analysis');
  eq('年份', e[0].year, '2020');
  eq('刊名', e[0].publication, 'IEEE Trans. Pattern Anal. Mach. Intell.');
  eq('卷', e[0].volume, '42');
  eq('期', e[0].issue, '5');
  eq('页码', e[0].pages, '1123–1140');
  eq('作者姓', e[0].creators.map((x) => x.lastName).join(','), 'Smith,Lee');
  eq('作者名', e[0].creators.map((x) => x.firstName).join(','), 'J.,A.');

  eq('arXiv id', e[1].arxiv, '1706.03762');
  eq('arXiv 标题', e[1].title, 'Attention is all you need');
  eq('arXiv 类型是预印本', e[1].itemType, 'preprint');
  eq('et al. 之前的作者都拿到了', e[1].creators.length, 3);
  eq('arXiv 条目有外部标识时不标 weak', e[1].confidence, 'id');

  eq('书名（出版社前缀不吞标题）', e[2].title, 'Pattern Recognition and Machine Learning');
  eq('出版社当刊名', e[2].publication, 'Springer');
  eq('图书类型', e[2].itemType, 'book');

  eq('会议论文类型', e[3].itemType, 'conferencePaper');
  eq('会议名（去掉 in）', e[3].publication, 'Advances in Neural Information Processing Systems');
  eq('会议页码不带句点', e[3].pages, '1097-1105');

  const b = R.parseSection(APA).entries;
  eq('APA 标题', b[0].title, 'A survey of PDF text extraction');
  eq('DOI 归一成小写裸标识符', b[0].doi, '10.1108/jd-01-2019-0001');
  eq('APA 作者两人', b[0].creators.length, 2);
  eq('APA 作者名', b[0].creators.map((x) => x.lastName + ' ' + x.firstName).join(' / '), 'Smith J. A. / Jones B.');
  eq('APA 卷', b[0].volume, '75');
  eq('APA 期', b[0].issue, '3');
  eq('APA 页码', b[0].pages, '456-478');
  eq('APA 刊名不含页码与链接', b[0].publication, 'Journal of Documentation');
  eq('APA 第二条年份', b[1].year, '2021');

  const c = R.parseSection(GBT).entries;
  eq('GB/T 标题', c[0].title, '基于深度学习的文档分析');
  eq('GB/T 作者', c[0].creators.map((x) => x.lastName).join(','), '张三,李四');
  eq('GB/T 刊名', c[0].publication, '计算机学报');
  eq('GB/T 卷期页', c[0].volume + '(' + c[0].issue + '):' + c[0].pages, '43(2):123-135');
  eq('GB/T [M] 是图书', c[1].itemType, 'book');
  eq('GB/T 年份', c[2].year, '2019');
}

// ---------- 3. 细节：DOI / 年份 / 标题兜底 ----------
console.log('3. DOI / 年份');
{
  eq('DOI 去掉结尾句点', R.doiIn('see 10.1000/xyz.123.'), '10.1000/xyz.123');
  eq('DOI 里的括号保留', R.doiIn('10.1016/0002-9610(86)90192-2.'), '10.1016/0002-9610(86)90192-2');
  eq('DOI 前缀被去掉', R.doiIn('https://doi.org/10.1108/JD-01-2019-0001'), '10.1108/jd-01-2019-0001');
  eq('没有 DOI 时为空', R.doiIn('just a title, 2020'), '');

  eq('arXiv 老编号', R.arxivIn('arXiv:cs/0112017v2'), 'cs/0112017');
  eq('arXiv 新编号带版本', R.arxivIn('arXiv:2103.00020v3'), '2103.00020');

  eq('括号年份优先', R.guessYear('Smith (2018). Something 2020 came later'), '2018');
  eq('结尾年份', R.guessYear('Journal of X, pp. 1-9, 2017.'), '2017');
  eq('没有年份', R.guessYear('no year here'), '');

  // 完全没有结构的一行：整行当标题，标成 weak（界面上默认不勾）
  const junk = R.parseEntry('Some loose reference text without any year');
  eq('无结构条目仍留下标题', junk.title.length > 0, true);
  eq('无结构条目是 weak', junk.confidence, 'weak');

  // 句点兜底：整节只有一个编号都没有，靠「句末 + 大写开头」切段
  const flat = ['References', 'A. One. First title of a paper. Journal A, 2019.', 'B. Two. Second title of a paper. Journal B, 2020.'];
  const f = R.parseSection(flat);
  eq('没有行内编号也能切段', f.entries.length, 2);
}

// ---------- 4. 查重 ----------
console.log('4. 查重');
{
  const entries = R.parseSection(APA).entries;
  const items = [
    { key: 'k1', title: '完全不同', year: '2000', doi: '10.1108/jd-01-2019-0001' },
    { key: 'k2', title: 'Reading interfaces for scholars', year: '2021', doi: '' },
  ];
  const plan = R.plan(entries, items);
  eq('DOI 相同的标 dup', plan[0].status, 'dup');
  eq('DOI 命中时指向库里那条', plan[0].dupWith && plan[0].dupWith.key, 'k1');
  eq('标题+年份相同也标 dup', plan[1].status, 'dup');
  eq('dup 的原因写得出来', plan[1].why.length > 0, true);

  const fresh = R.plan(entries, []);
  eq('空库全部是新增', fresh.every((x) => x.status === 'new'), true);

  // 库里的DOI大小写/前缀不同也要认出来
  const messy = R.plan(R.parseSection(APA).entries, [{ key: 'k3', title: 'x', doi: 'https://doi.org/10.1108/JD-01-2019-0001' }]);
  eq('DOI 查重不受大小写与前缀影响', messy[0].status, 'dup');

  // 批内重复：同一条文献在表里出现两次
  const twice = R.parseSection(['References', '[1] A. One. Title one. Journal A, 2020.', '[2] A. One. Title one. Journal A, 2020.']).entries;
  const p2 = R.plan(twice, []);
  eq('批内重复只留第一条', p2[0].status + '/' + p2[1].status, 'new/dup');

  // 认不出标题的条目不参与入库
  const weakPlan = R.plan([{ title: '', year: '', doi: '' }], []);
  eq('没标题的标 weak', weakPlan[0].status, 'weak');
}

// ---------- 5. 落库形态 ----------
console.log('5. 落库形态');
{
  const e = R.parseSection(APA).entries[0];
  const rec = R.toRecord(e);
  eq('记录带 DOI', rec.doi, '10.1108/jd-01-2019-0001');
  eq('记录带卷期页', [rec.volume, rec.issue, rec.pages].join('/'), '75/3/456-478');
  ok('有 DOI 但还没抓到题录时也留原文（标题仍是猜的）', typeof rec.note === 'string');

  const parsedOnly = R.parseSection(GBT).entries[0];
  const rec2 = R.toRecord(parsedOnly);
  ok('只有猜测题录时把原文留在笔记里', typeof rec2.note === 'string' && rec2.note.indexOf('参考文献') >= 0);

  // 官方题录覆盖本地猜测
  const merged = R.mergeMeta(e, {
    itemType: 'journalArticle', title: 'OFFICIAL TITLE', creators: [{ firstName: 'John', lastName: 'Smith', creatorType: 'author' }],
    year: '2019', publication: 'Journal of Documentation', volume: '75', issue: '3', pages: '456-478',
    doi: '10.1108/JD-01-2019-0001', url: 'https://doi.org/10.1108/JD-01-2019-0001', abstract: 'abs', language: 'en', tags: ['x'],
  });
  eq('官方标题覆盖猜测', merged.title, 'OFFICIAL TITLE');
  eq('官方作者覆盖猜测', merged.creators.length, 1);
  eq('抓到官方题录后不再留原文笔记', R.toRecord(merged).note, undefined);
  ok('官方摘要带进来', R.toRecord(merged).abstract === 'abs');

  // 官方题录缺字段时回落到本地猜测
  const partial = R.mergeMeta(e, { title: 'Only Title' });
  eq('官方缺年份时用本地猜的', partial.year, '2019');
  eq('官方缺刊名时用本地猜的', partial.publication, 'Journal of Documentation');
}

// ---------- 6. 上限与健壮性 ----------
console.log('6. 上限与健壮性');
{
  const many = ['References'];
  for (let i = 1; i <= 450; i++) many.push('[' + i + '] A. Author' + i + '. Title number ' + i + ' of things. Journal, 20' + String(10 + (i % 20)) + ', 1(1): 1-2.');
  const r = R.parseSection(many);
  eq('条目数有上限', r.entries.length, R.MAX_ENTRIES);
  eq('超上限会被标出来', r.truncated, true);

  const huge = ['References', '[1] A. Author. ' + 'x'.repeat(5000) + '.'];
  const h = R.parseSection(huge);
  ok('超长条目被截断而不是爆内存', h.entries.length === 1 && h.entries[0].rawText.length <= 1600);

  // 空输入 / 只有标题 / 非字符串
  eq('空输入不炸', R.parseSection([]).entries.length, 0);
  eq('只有标题行', R.parseSection(['References']).entries.length, 0);
  eq('null 输入不炸', R.parseSection(null).entries.length, 0);
  eq('对象数组（带 text 字段）也吃', R.parseSection([{ text: 'References' }, { text: '[1] A. One. Title. J, 2020.' }]).entries.length, 1);

  // 全是噪声：切出来的是垃圾，但不能抛错
  let threw = null;
  try { R.parseSection(['References', '……', '...', '12-13']); } catch (err) { threw = err; }
  eq('噪声输入不抛错', threw, null);
}

console.log('test-refimport: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
