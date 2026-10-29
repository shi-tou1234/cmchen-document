'use strict';
/*
 * 条件检索（v35）回归：纯 Node。
 *
 * 两层：
 *   1. src/advsearch.js 的引擎——运算符语义、全部/任一、空条件、坏条件；
 *   2. library.addSearch 的条件式存储——白名单、上限、与旧的串式检索共存。
 * 界面层（弹窗、横幅、列表条数）在 scripts/test-adv-ui.js 里用真实 Electron 验。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const A = require('../src/advsearch.js');
const Library = require('../src/library.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.log('  FAIL ' + name + (detail === undefined ? '' : ' :: ' + detail));
}
function eq(name, got, want) {
  ok(name, got === want, 'got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want));
}
function ids(spec) { return A.filter(items, spec, ctx).map((x) => x.key).join(','); }

// ---------- 夹具 ----------
const items = [
  {
    key: 'a', title: 'Deep Learning', year: '2015', itemType: 'journalArticle',
    creators: [{ lastName: 'LeCun', firstName: 'Yann' }], tags: ['ml', '综述'],
    publication: 'Nature', doi: '10.1038/nature14539', readStatus: 'done',
    attachment: { path: 'D:/docs/deep.pdf' },
  },
  {
    key: 'b', title: 'Attention Is All You Need', year: '2017', itemType: 'conferencePaper',
    creators: [{ lastName: 'Vaswani', firstName: 'Ashish' }], tags: [],
    publication: 'NeurIPS', doi: '', readStatus: 'todo',
  },
  { key: 'c', title: '中文文献：深度学习综述', year: '', itemType: 'book', creators: [], tags: ['综述'], abstract: '' },
];
const annos = {
  a: [
    { kind: '高亮', color: '#ffd400', text: 'deep nets', comment: '' },
    { kind: '批注', color: '#ff6666', text: 'layer', comment: '我的批注' },
  ],
  b: [{ kind: '高亮', color: '#ffd400', text: 'attention', comment: '' }],
  c: [],
};
const ctx = { annosOf: (it) => annos[it.key] || [] };

// ---------- 1. 文本运算符 ----------
eq('包含（大小写不敏感）', ids({ conditions: [{ field: 'title', op: 'contains', value: 'DEEP' }] }), 'a');
eq('不包含', ids({ conditions: [{ field: 'title', op: 'notContains', value: 'deep' }] }), 'b,c');
eq('等于（整串相等）', ids({ conditions: [{ field: 'title', op: 'is', value: 'deep learning' }] }), 'a');
eq('不等于', ids({ conditions: [{ field: 'title', op: 'isNot', value: 'Deep Learning' }] }), 'b,c');
eq('开头是', ids({ conditions: [{ field: 'title', op: 'beginsWith', value: 'attention' }] }), 'b');
eq('结尾是', ids({ conditions: [{ field: 'title', op: 'endsWith', value: 'need' }] }), 'b');
eq('为空（DOI 空）', ids({ conditions: [{ field: 'doi', op: 'isEmpty' }] }), 'b,c');
eq('不为空（DOI 有值）', ids({ conditions: [{ field: 'doi', op: 'isNotEmpty' }] }), 'a');
eq('中文按子串匹配', ids({ conditions: [{ field: 'title', op: 'contains', value: '综述' }] }), 'c');
eq('标签是逗号拼接的整串（contains 命中任一）', ids({ conditions: [{ field: 'tag', op: 'contains', value: '综述' }] }), 'a,c');
eq('作者用结构化姓 + 名', ids({ conditions: [{ field: 'author', op: 'contains', value: 'vaswani' }] }), 'b');
eq('任意字段跨 title/author/tag', ids({ conditions: [{ field: 'any', op: 'contains', value: 'vaswani' }] }), 'b');

// ---------- 2. 数值 / 数量条件 ----------
eq('年份大于', ids({ conditions: [{ field: 'year', op: 'gt', value: '2016' }] }), 'b');
eq('年份不小于', ids({ conditions: [{ field: 'year', op: 'gte', value: '2017' }] }), 'b');
eq('年份小于', ids({ conditions: [{ field: 'year', op: 'lt', value: '2016' }] }), 'a');
eq('年份等于', ids({ conditions: [{ field: 'year', op: 'eq', value: '2015' }] }), 'a');
eq('年份为空（没有年份的条目）', ids({ conditions: [{ field: 'year', op: 'isEmpty' }] }), 'c');
eq('标注数大于 1', ids({ conditions: [{ field: 'annoCount', op: 'gt', value: '1' }] }), 'a');
eq('标注数等于 0', ids({ conditions: [{ field: 'annoCount', op: 'eq', value: '0' }] }), 'c');
eq('标注数不为空（总是一个数）', ids({ conditions: [{ field: 'annoCount', op: 'isNotEmpty' }] }), 'a,b,c');
eq('非数字的值不命中（不抛错）', ids({ conditions: [{ field: 'year', op: 'gt', value: 'abc' }] }), '');

// ---------- 3. 枚举 / 布尔 / 批注属性 ----------
eq('类型是会议论文', ids({ conditions: [{ field: 'itemType', op: 'is', value: 'conferencePaper' }] }), 'b');
eq('类型不是期刊论文', ids({ conditions: [{ field: 'itemType', op: 'isNot', value: 'journalArticle' }] }), 'b,c');
eq('阅读状态是已读', ids({ conditions: [{ field: 'readStatus', op: 'is', value: 'done' }] }), 'a');
eq('阅读状态为空', ids({ conditions: [{ field: 'readStatus', op: 'isEmpty' }] }), 'c');
eq('有附件', ids({ conditions: [{ field: 'hasAttachment', op: 'has' }] }), 'a');
eq('没有附件', ids({ conditions: [{ field: 'hasAttachment', op: 'hasNot' }] }), 'b,c');
eq('有标注', ids({ conditions: [{ field: 'hasAnnotation', op: 'has' }] }), 'a,b');
eq('没有标注', ids({ conditions: [{ field: 'hasAnnotation', op: 'hasNot' }] }), 'c');
eq('有红色批注（按颜色）', ids({ conditions: [{ field: 'annoColor', op: 'has', value: '#ff6666' }] }), 'a');
eq('没有红色批注', ids({ conditions: [{ field: 'annoColor', op: 'hasNot', value: '#ff6666' }] }), 'b,c');
eq('有「批注」类型的标注', ids({ conditions: [{ field: 'annoKind', op: 'has', value: '批注' }] }), 'a');
eq('标注带批注（comment 非空）', ids({ conditions: [{ field: 'annoHasComment', op: 'has' }] }), 'a');
eq('标注文字里搜关键词', ids({ conditions: [{ field: 'annoText', op: 'contains', value: 'attention' }] }), 'b');
eq('附件路径按子串', ids({ conditions: [{ field: 'attachmentPath', op: 'contains', value: 'deep.pdf' }] }), 'a');

// ---------- 4. 全部 / 任一 ----------
eq('全部条件（且）', ids({ match: 'all', conditions: [
  { field: 'tag', op: 'contains', value: '综述' },
  { field: 'year', op: 'isEmpty' },
] }), 'c');
eq('任一条件（或）', ids({ match: 'any', conditions: [
  { field: 'itemType', op: 'is', value: 'book' },
  { field: 'year', op: 'eq', value: '2017' },
] }), 'b,c');
eq('默认 match 是 all', A.normalize({ conditions: [{ field: 'title', op: 'contains', value: 'deep' }] }).match, 'all');
eq('非法 match 归到 all', A.normalize({ match: 'xxx', conditions: [] }).match, 'all');

// ---------- 5. 坏条件 / 空条件 ----------
eq('空条件不过滤', A.filter(items, { conditions: [] }, ctx).length, 3);
eq('null spec 不过滤', A.filter(items, null, ctx).length, 3);
eq('没有值的条件被丢掉', A.normalize({ conditions: [{ field: 'title', op: 'contains', value: '   ' }] }).conditions.length, 0);
eq('缺值的条件不参与过滤', A.filter(items, { conditions: [{ field: 'title', op: 'contains', value: '' }] }, ctx).length, 3);
eq('不需要值的条件即使 value 为空也保留', A.normalize({ conditions: [{ field: 'doi', op: 'isEmpty', value: '' }] }).conditions.length, 1);
eq('未知字段整条丢掉', A.normalize({ conditions: [{ field: 'nope', op: 'contains', value: 'x' }] }).conditions.length, 0);
eq('未知运算符整条丢掉', A.normalize({ conditions: [{ field: 'title', op: 'fuzzy', value: 'x' }] }).conditions.length, 0);
eq('字段与运算符不匹配时丢掉（文本字段用数值运算符）', A.normalize({ conditions: [{ field: 'title', op: 'gt', value: '1' }] }).conditions.length, 0);
ok('引擎不改写值（截断由存储层做）', A.normalize({ conditions: [{ field: 'title', op: 'contains', value: 'x'.repeat(500) }] }).conditions[0].value.length === 500);

// ---------- 6. 描述 ----------
eq('describe 全部', A.describe({ match: 'all', conditions: [
  { field: 'title', op: 'contains', value: 'deep' },
  { field: 'year', op: 'gt', value: '2010' },
] }), '标题 包含 “deep” 且 年份 大于 “2010”');
eq('describe 任一', A.describe({ match: 'any', conditions: [
  { field: 'itemType', op: 'is', value: 'book' },
  { field: 'doi', op: 'isEmpty' },
] }), '条目类型 是 “图书” 或 DOI 为空');
eq('describe 布尔', A.describe({ conditions: [{ field: 'hasAttachment', op: 'hasNot' }] }), '有附件：否');
eq('空条件的 describe 是空串', A.describe({ conditions: [] }), '');

// ---------- 7. 字段 / 运算符表自身的完整性 ----------
for (const f of A.FIELDS) {
  ok('字段 ' + f.id + ' 有可用运算符', A.opsFor(f.id).length > 0, f.id);
  ok('字段 ' + f.id + ' 有标签', !!f.label, f.id);
}
ok('需要的值运算符都标了 needsValue', A.opsFor('title').every((o) => typeof o.needsValue === 'boolean'));
ok('「为空」不需要值', A.opDef('title', 'isEmpty').needsValue === false);

// ---------- 8. library.addSearch：条件式存储 ----------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-adv-'));
try {
  Library.init(dir);
  const spec = { match: 'any', conditions: [
    { field: 'annoColor', op: 'has', value: '#ff6666' },
    { field: 'year', op: 'isEmpty', value: '' },
  ] };
  const saved = Library.addSearch('红色批注或没年份', '', spec);
  ok('空查询 + 有条件是合法的', !!saved);
  eq('条件式检索的 query 为空串', saved.query, '');
  eq('match 被保留', saved.match, 'any');
  eq('条件被保留', saved.conditions.length, 2);
  const sum = Library.summary();
  const back = (sum.searches || []).find((x) => x.id === saved.id);
  ok('落盘后能读回来', !!back && Array.isArray(back.conditions) && back.conditions.length === 2);

  const dirty = Library.addSearch('脏条件', '', { conditions: [
    { field: 'title', op: 'contains', value: 'ok' },
    { field: '<script>', op: 'contains', value: 'x' },
    { field: 'title', op: 'evil', value: 'x' },
    null,
    'not an object',
  ] });
  eq('只留下合法条件', dirty.conditions.length, 1);

  const many = Library.addSearch('太多条件', '', { conditions: Array.from({ length: 40 }, (_, i) => ({ field: 'title', op: 'contains', value: 'v' + i })) });
  eq('条件数封顶 20', many.conditions.length, 20);

  eq('空查询 + 空条件不建条目', Library.addSearch('什么都没有', '', { conditions: [] }), null);
  eq('空查询 + 空条件（不传 spec）也不建', Library.addSearch('什么都没有', ''), null);

  const legacy = Library.addSearch('老式串', 'title:deep');
  ok('老的串式检索仍然可用', !!legacy && legacy.query === 'title:deep' && !legacy.conditions);

  eq('值被截断到 200 字', Library.addSearch('长值', '', { conditions: [{ field: 'title', op: 'contains', value: 'y'.repeat(300) }] }).conditions[0].value.length, 200);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------- 9. 条件组嵌套（v36） ----------
const NOW = Date.UTC(2026, 9, 29, 4, 0, 0);
const dated = [
  { key: 'n1', title: 'Deep nets', abstract: 'layer wise', created: NOW - 2 * 86400000, updated: NOW - 86400000, tags: [] },
  { key: 'n2', title: 'Attention', abstract: 'transformer', created: NOW - 400 * 86400000, updated: NOW - 400 * 86400000, tags: [] },
  { key: 'n3', title: 'Something else', abstract: '', created: 0, updated: 0, tags: [] },
];
const dctx = { annosOf: (it) => (it.key === 'n1' ? [{ kind: '高亮', color: '#ffd400', text: '', comment: '' }] : []) };
const g = (match, ...conditions) => ({ match, conditions });
const leaf = (field, op, value) => ({ field, op, value: value === undefined ? '' : value });
function ids2(spec) { return A.filter(dated, spec, Object.assign({ now: NOW }, dctx)).map((x) => x.key).join(','); }

eq('组内「或」+ 组外「且」',
  ids2(g('all', g('any', leaf('title', 'contains', 'deep'), leaf('abstract', 'contains', 'transformer')),
    leaf('hasAnnotation', 'has'))), 'n1');
eq('外层「或」里放一个组',
  ids2(g('any', g('all', leaf('title', 'contains', 'attention'), leaf('abstract', 'contains', 'transformer')),
    leaf('title', 'contains', 'deep'))), 'n1,n2');
eq('组内「且」两个条件都不满足就是空',
  ids2(g('all', g('all', leaf('title', 'contains', 'deep'), leaf('abstract', 'contains', 'transformer')))), '');
eq('空组被丢掉，不改变结果', A.normalize(g('all', g('any'), leaf('title', 'contains', 'deep'))).conditions.length, 1);
eq('组里只有不完整条件时整组被丢掉', A.normalize(g('all', g('any', leaf('title', 'contains', '')), leaf('year', 'gt', '2000'))).conditions.length, 1);
eq('深度超限的组被丢弃', A.normalize(g('all', g('any', g('all', g('any', g('all', leaf('title', 'contains', 'x'))))))).conditions.length, 0);
eq('countConditions 递归计数', A.countConditions(g('all', leaf('title', 'contains', 'a'), g('any', leaf('year', 'gt', '2000'), leaf('doi', 'isEmpty')))), 3);
eq('countGroups 不含顶层', A.countGroups(A.normalize(g('all', leaf('title', 'contains', 'a'), g('any', leaf('year', 'gt', '2000')))), 0), 1);
eq('嵌套描述带括号', A.describe(g('all', g('any', leaf('title', 'contains', 'a'), leaf('year', 'gt', '2000')), leaf('doi', 'isEmpty'))),
  '(标题 包含 “a” 或 年份 大于 “2000”) 且 DOI 为空');

// ---------- 10. 正则 ----------
eq('正则命中', ids2({ conditions: [leaf('title', 'regex', '^deep')] }), 'n1');
eq('正则多分支', ids2({ conditions: [leaf('title', 'regex', 'attention|else')] }), 'n2,n3');
eq('正则不区分大小写', ids2({ conditions: [leaf('title', 'regex', 'DEEP')] }), 'n1');
eq('正则按原文匹配（fold 后 \\b 不成立）', ids2({ conditions: [leaf('title', 'regex', '\\bnet\\b')] }), '');
eq('非法正则不命中也不抛错', ids2({ conditions: [leaf('title', 'regex', '[')] }), '');
eq('不匹配正则', ids2({ conditions: [leaf('title', 'notRegex', '^deep')] }), 'n2,n3');
eq('空正则视为不完整', A.normalize({ conditions: [leaf('title', 'regex', '   ')] }).conditions.length, 0);

// ---------- 11. 日期条件（距今 N 天） ----------
eq('距今不超过 7 天', ids2({ conditions: [leaf('dateAdded', 'withinDays', '7')] }), 'n1');
eq('距今超过 300 天', ids2({ conditions: [leaf('dateAdded', 'olderThanDays', '300')] }), 'n2');
eq('日期为空（时间戳 0）', ids2({ conditions: [leaf('dateAdded', 'isEmpty')] }), 'n3');
eq('日期不为空', ids2({ conditions: [leaf('dateAdded', 'isNotEmpty')] }), 'n1,n2');
eq('距今超过 0 天 = 不是今天加的', ids2({ conditions: [leaf('dateAdded', 'olderThanDays', '0')] }), 'n1,n2');
eq('修改日期距今不超过 1 天', ids2({ conditions: [leaf('dateModified', 'withinDays', '1')] }), 'n1');
eq('天数为负视为不命中', ids2({ conditions: [leaf('dateAdded', 'withinDays', '-1')] }), '');
eq('天数非数字视为不命中', ids2({ conditions: [leaf('dateAdded', 'withinDays', 'abc')] }), '');

// 同一天的不同时刻都算 0 天（自然日口径）
eq('同日不同时刻算 0 天', A.filter([{ key: 'x', created: NOW - 3600000 }], { conditions: [leaf('dateAdded', 'withinDays', '0')] }, { now: NOW }).length, 1);

// ---------- 12. 嵌套条件的存储 ----------
try {
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'adv-nest-'));
  try {
    Library.init(dir2);
    const nested = Library.addSearch('嵌套', '', g('all',
      g('any', leaf('title', 'contains', 'a'), leaf('abstract', 'contains', 'b')),
      leaf('hasAnnotation', 'has')));
    ok('嵌套条件能存进智能收藏集', !!nested && Array.isArray(nested.conditions));
    eq('顶层保留 2 项（一个组 + 一个叶子）', nested.conditions.length, 2);
    eq('组内 match 保留', nested.conditions[0].match, 'any');
    eq('组内条件保留', nested.conditions[0].conditions.length, 2);
    const summary = Library.summary();
    const back = (summary.searches || []).find((x) => x.id === nested.id);
    ok('落盘后组结构还在', !!back && Array.isArray(back.conditions[0] && back.conditions[0].conditions));

    const emptyGroup = Library.addSearch('空组', '', g('all', g('any'), leaf('title', 'contains', 'x')));
    eq('空组不落盘', emptyGroup.conditions.length, 1);

    const deep = g('all', g('any', g('all', g('any', g('all', leaf('title', 'contains', 'deep'))))));
    const cut = Library.addSearch('太深', '', deep);
    eq('超出深度上限的检索退化成空，不建条目', cut, null);
    ok('只留空组的检索不会建条目', Library.addSearch('只剩空组', '', g('all', g('any'))) === null);

    const manyNested = Library.addSearch('嵌套也封顶', '', g('all',
      ...Array.from({ length: 30 }, (_, i) => leaf('title', 'contains', 'v' + i))));
    eq('嵌套时条件总数仍封顶 20', A.countConditions(manyNested), 20);
  } finally {
    fs.rmSync(dir2, { recursive: true, force: true });
  }
} catch (err) {
  ok('嵌套存储测试不抛错', false, err && err.message);
}


console.log('test-advsearch: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
