'use strict';
/*
 * 首页标识抽取回归（2026-10-29）
 * 覆盖：DOI 标签优先、doi.org 前缀、结尾标点与括号、同页多个 DOI、
 *       arXiv 新式 / 旧式 / 裸编号、无标识、误判防护。
 * 运行：node scripts/test-doiscan.js
 */
const assert = require('assert');
const Scan = require('../src/doiscan.js');

let n = 0;
function ok(name, fn) {
  fn();
  n++;
  console.log('  ok ' + n + ' - ' + name);
}

ok('带 DOI 标签', () => {
  const r = Scan.extractIdentifiers('Some Journal\nDOI: 10.1038/nature12373\nVol 1');
  assert.equal(r.doi, '10.1038/nature12373');
  assert.equal(r.source, 'doi');
  assert.equal(r.identifier, '10.1038/nature12373');
});

ok('doi.org 前缀与结尾句号', () => {
  const r = Scan.extractIdentifiers('Available at https://doi.org/10.1016/j.cell.2020.01.002.');
  assert.equal(r.doi, '10.1016/j.cell.2020.01.002');
});

ok('DOI 内含成对括号不被截断', () => {
  const r = Scan.extractIdentifiers('doi:10.1016/S0140-6736(00)02020-1).');
  assert.equal(r.doi, '10.1016/S0140-6736(00)02020-1');
});

ok('同页多个 DOI 时取带标签的那个', () => {
  const text = 'Cited as 10.1000/other.999 in text.\nArticle DOI: 10.5555/real.2024.7\n';
  const r = Scan.extractIdentifiers(text);
  assert.equal(r.doi, '10.5555/real.2024.7', '应优先 labeled: ' + r.doi);
});

ok('没有标签时取第一个 DOI', () => {
  const r = Scan.extractIdentifiers('10.1000/first 10.1000/second');
  assert.equal(r.doi, '10.1000/first');
});

ok('arXiv 新式带标签', () => {
  const r = Scan.extractIdentifiers('Preprint arXiv:2401.01234v2 submitted');
  assert.equal(r.arxivId, '2401.01234v2');
  assert.equal(r.source, 'arxiv');
});

ok('arXiv 裸编号需出现 arxiv 字样', () => {
  assert.equal(Scan.extractIdentifiers('arXiv 2401.01234').arxivId, '2401.01234');
  assert.equal(Scan.extractIdentifiers('区间 2020.12345 不是编号').arxivId, '');
});

ok('arXiv 旧式分类号', () => {
  const r = Scan.extractIdentifiers('arXiv:hep-th/9901001');
  assert.equal(r.arxivId, 'hep-th/9901001');
});

ok('DOI 优先于 arXiv', () => {
  const r = Scan.extractIdentifiers('arXiv:2401.01234\nDOI 10.1000/x.1');
  assert.equal(r.source, 'doi');
  assert.equal(r.identifier, '10.1000/x.1');
});

ok('没有标识时返回空', () => {
  const r = Scan.extractIdentifiers('这是一篇没有 DOI 的中文文章，2024 年。');
  assert.equal(r.identifier, '');
  assert.equal(r.source, '');
  assert.equal(Scan.isConfident(r), false);
});

ok('cleanDoi 拒绝不完整写法', () => {
  assert.equal(Scan.cleanDoi('10.1234'), '');
  assert.equal(Scan.cleanDoi('doi: 10.1000/ok'), '10.1000/ok');
  assert.equal(Scan.cleanDoi('https://dx.doi.org/10.1000/ok'), '10.1000/ok');
});

console.log('\ntest-doiscan: ' + n + ' 项通过');
