'use strict';
/*
 * 综述草稿回归（2026-10-29）
 * 覆盖：按标签 / 按文献 / 不分组、编号制按出现顺序且与参考文献表一致、
 *       作者-年份制引注、范围过滤、无条目批注跳过、长引文截断、只保留评论。
 * 运行：node scripts/test-review.js
 */
const assert = require('assert');
const Review = require('../src/review.js');

let n = 0;
function ok(name, fn) {
  fn();
  n++;
  console.log('  ok ' + n + ' - ' + name);
}

const items = [
  {
    key: 'k1', title: 'Local-first reference managers', year: '2024', itemType: 'journalArticle',
    creators: [{ firstName: 'Jane', lastName: 'Smith', creatorType: 'author' }],
    publication: 'Journal of Digital Libraries', volume: '12', issue: '3', pages: '45-67',
  },
  {
    key: 'k2', title: 'Annotation practices in reading tools', year: '2023', itemType: 'conferencePaper',
    creators: [
      { firstName: 'Wei', lastName: 'Zhang', creatorType: 'author' },
      { firstName: 'Ana', lastName: 'Lopez', creatorType: 'author' },
    ],
    publication: 'Proceedings of ReadConf',
  },
  {
    key: 'k3', title: 'Deleted paper', year: '2020', deletedAt: 123,
    creators: [{ firstName: 'X', lastName: 'Gone', creatorType: 'author' }],
  },
];

const annos = [
  { id: 'a1', itemKey: 'k1', page: 3, text: '本地优先意味着数据在用户手里', comment: '这是全文的立论基础', tags: ['方法'] },
  { id: 'a2', itemKey: 'k1', page: 5, text: '同步不是必需品', comment: '', tags: ['方法', '结论'] },
  { id: 'a3', itemKey: 'k2', page: 2, text: '标注是阅读的副产物', comment: '与我的观察一致', tags: ['结论'] },
  { id: 'a4', itemKey: 'k2', page: 4, text: '没有标签的一条', comment: '', tags: [] },
  { id: 'a5', itemKey: '', page: 1, text: '没有归属的批注', comment: '', tags: ['方法'] },
  { id: 'a6', itemKey: 'k3', page: 1, text: '回收站里的条目', comment: '', tags: ['方法'] },
];

ok('按标签分组：标签 + 未标注主题', () => {
  const r = Review.build({ items, annos, groupBy: 'tag', style: 'gbt7714' });
  assert.ok(r.markdown.includes('## 方法'), r.markdown);
  assert.ok(r.markdown.includes('## 结论'), r.markdown);
  assert.ok(r.markdown.includes('## 未标注主题'), r.markdown);
  assert.equal(r.stats.annos, 4, '无归属与回收站条目都要排除: ' + r.stats.annos);
  assert.equal(r.stats.items, 2);
  assert.equal(r.stats.skipped, 2, 'a5 无 itemKey、a6 条目在回收站');
});

ok('同一篇文献在组内只出现一次小节标题', () => {
  const r = Review.build({ items, annos, groupBy: 'tag', style: 'gbt7714' });
  const hits = r.markdown.split('\n').filter((l) => l.startsWith('### ') && l.includes('Local-first'));
  assert.equal(hits.length, 1, '实际 ' + hits.length + ' 次: ' + hits.join(' | '));
});

ok('编号制按出现顺序编号，正文与参考文献表一致', () => {
  const r = Review.build({ items, annos, groupBy: 'none', style: 'gbt7714' });
  // 组内先按作者姓排序：Lopez(Zhang 等) vs Smith → Smith 在前，编号 [1]
  assert.ok(r.markdown.includes('[1, p. 3]'), r.markdown);
  assert.ok(r.markdown.includes('[2, p. 2]'), r.markdown);
  const refSection = r.markdown.split('## 参考文献')[1] || '';
  const first = refSection.split('\n').filter((l) => l.trim())[0] || '';
  assert.ok(/^\[1\]/.test(first.trim()), '参考文献第一条应是 [1]: ' + first);
  assert.ok(/smith/i.test(first), '第一条应是 Smith 那篇: ' + first);
  assert.equal(r.stats.cited, 2);
});

ok('作者-年份制出 (Smith, 2024, p. 3)', () => {
  const r = Review.build({ items, annos, groupBy: 'none', style: 'apa' });
  assert.ok(r.markdown.includes('(Smith, 2024, p. 3)'), r.markdown);
  assert.ok(!/\[\d+, p\./.test(r.markdown), '作者-年份制不该出现方括号编号');
});

ok('范围过滤只看选中条目', () => {
  const r = Review.build({ items, annos, groupBy: 'tag', style: 'gbt7714', keys: ['k2'] });
  assert.equal(r.stats.annos, 2, '实际 ' + r.stats.annos);
  assert.ok(!r.markdown.includes('Local-first'), '不该出现 k1 的内容');
});

ok('只保留评论时不出引用块', () => {
  const r = Review.build({ items, annos, groupBy: 'none', style: 'gbt7714', includeQuotes: false });
  assert.ok(!r.markdown.includes('> 本地优先'), '引文应被去掉');
  assert.ok(r.markdown.includes('评论：这是全文的立论基础'));
  assert.ok(!r.markdown.includes('> 没有标签的一条'), '没有评论的条目应被排除');
});

ok('长引文截断到 400 字并加省略号', () => {
  const long = '甲'.repeat(600);
  const r = Review.build({
    items, annos: [{ id: 'x', itemKey: 'k1', page: 1, text: long, comment: '', tags: [] }],
    groupBy: 'none', style: 'gbt7714',
  });
  assert.ok(r.markdown.includes('甲'.repeat(400) + '…'), '应截断到 400 字');
  assert.ok(!r.markdown.includes('甲'.repeat(401)), '不该超过 400 字');
});

ok('按文献分组：不出现标签分组标题', () => {
  const r = Review.build({ items, annos, groupBy: 'item', style: 'gbt7714' });
  assert.ok(!r.markdown.includes('## 方法'), r.markdown);
  assert.ok(r.markdown.includes('## Smith，2024 — Local-first'), r.markdown);
  assert.ok(r.markdown.includes('## Zhang 等，2023 — Annotation practices'), r.markdown);
});

ok('没有可用批注时给出提示而不是空文档', () => {
  const r = Review.build({ items, annos: [], groupBy: 'tag', style: 'gbt7714' });
  assert.equal(r.stats.annos, 0);
  assert.ok(r.markdown.includes('没有可用的批注'), r.markdown);
  assert.ok(r.markdown.startsWith('# '), '仍要有标题');
});

ok('标题可自定义', () => {
  const r = Review.build({ items, annos, groupBy: 'tag', style: 'gbt7714', title: '第二章 文献综述' });
  assert.ok(r.markdown.startsWith('# 第二章 文献综述'), r.markdown.slice(0, 40));
});

ok('显式空范围不会被放大成全库（审核问题 5）', () => {
  const r = Review.build({ items, annos, keys: [], groupBy: 'tag', style: 'gbt7714' });
  assert.equal(r.stats.annos, 0, '空 keys 应该是零条，实际 ' + r.stats.annos);
  assert.equal(r.stats.items, 0);
  assert.ok(r.markdown.includes('没有可用的批注'), r.markdown);
});

ok('同作者同年的 a/b 后缀正文与文献表一致（审核问题 4）', () => {
  const two = [
    { key: 's1', title: 'Alpha', year: '2024', itemType: 'journalArticle', publication: 'J', creators: [{ firstName: 'Jane', lastName: 'Smith', creatorType: 'author' }] },
    { key: 's2', title: 'Beta', year: '2024', itemType: 'journalArticle', publication: 'J', creators: [{ firstName: 'Jane', lastName: 'Smith', creatorType: 'author' }] },
  ];
  const twoAnnos = [
    { id: 'x1', itemKey: 's1', page: 1, text: 'alpha quote', comment: '', tags: [] },
    { id: 'x2', itemKey: 's2', page: 1, text: 'beta quote', comment: '', tags: [] },
  ];
  const r = Review.build({ items: two, annos: twoAnnos, groupBy: 'none', style: 'apa' });
  assert.ok(r.markdown.includes('(Smith, 2024a, p. 1)'), '正文应有 2024a: ' + r.markdown);
  assert.ok(r.markdown.includes('(Smith, 2024b, p. 1)'), '正文应有 2024b: ' + r.markdown);
  const refs = r.markdown.split('## 参考文献')[1] || '';
  assert.ok(/2024a/.test(refs) && /2024b/.test(refs), '文献表也应有 a/b: ' + refs);
});

ok('年份带月份时后缀插在四位年之后（第二轮审核 4）', () => {
  const two = [
    { key: 'm1', title: 'Alpha', year: '2024-10', itemType: 'journalArticle', publication: 'J', creators: [{ firstName: 'Jane', lastName: 'Smith', creatorType: 'author' }] },
    { key: 'm2', title: 'Beta', year: '2024-10', itemType: 'journalArticle', publication: 'J', creators: [{ firstName: 'Jane', lastName: 'Smith', creatorType: 'author' }] },
  ];
  const twoAnnos = [
    { id: 'y1', itemKey: 'm1', page: 1, text: 'alpha quote', comment: '', tags: [] },
    { id: 'y2', itemKey: 'm2', page: 1, text: 'beta quote', comment: '', tags: [] },
  ];
  const r = Review.build({ items: two, annos: twoAnnos, groupBy: 'none', style: 'apa' });
  assert.ok(r.markdown.includes('(Smith, 2024a-10, p. 1)'), '正文应把 a 插在四位年之后: ' + r.markdown);
  assert.ok(r.markdown.includes('(Smith, 2024b-10, p. 1)'), '正文应把 b 插在四位年之后: ' + r.markdown);
  assert.ok(!/2024-10[ab]/.test(r.markdown), '不能把后缀加到字段末尾: ' + r.markdown);
  const refs = r.markdown.split('## 参考文献')[1] || '';
  assert.ok(/2024a-10/.test(refs) && /2024b-10/.test(refs), '文献表同样带 a/b: ' + refs);
});

console.log('\ntest-review: ' + n + ' 项通过');
