'use strict';
/*
 * 识别结果合并规则回归（2026-10-29 审核问题 1 / 3）
 *   1. 调用方显式提供的字段（含 DOI、卷期页、标签、摘要等）不能被识别结果覆盖；
 *   2. 未显式指定类型时，应能采用识别到的文献类型（不能因为默认值是 document 就拒绝）。
 * 运行：node scripts/test-identify-fields.js
 */
const assert = require('assert');
const Identify = require('../src/identify.js');

let n = 0;
function ok(name, fn) {
  fn();
  n++;
  console.log('  ok ' + n + ' - ' + name);
}

const remote = {
  title: 'Remote Title',
  creators: [{ firstName: 'R', lastName: 'Emote', creatorType: 'author' }],
  year: '2024', publication: 'Remote Journal', volume: '99', issue: '9', pages: '1-9',
  doi: '10.1234/demo', url: 'https://example.org/demo', abstract: 'remote abstract',
  language: 'en', tags: ['remote'], itemType: 'journalArticle',
};

ok('显式 DOI / 卷期页 / 标签不被覆盖', () => {
  const out = Identify.fieldsFromMetadata(remote, {
    doi: '10.5555/manual', volume: '7', issue: '2', pages: '10-20',
    tags: ['manual'], abstract: 'my abstract', url: 'https://mine', language: 'zh',
  });
  assert.equal(out.doi, undefined, 'DOI 不该被覆盖');
  assert.equal(out.volume, undefined);
  assert.equal(out.issue, undefined);
  assert.equal(out.pages, undefined);
  assert.equal(out.tags, undefined);
  assert.equal(out.abstract, undefined);
  assert.equal(out.url, undefined);
  assert.equal(out.language, undefined);
});

ok('空字段照常补全', () => {
  const out = Identify.fieldsFromMetadata(remote, {});
  assert.equal(out.doi, '10.1234/demo');
  assert.equal(out.volume, '99');
  assert.deepEqual(out.tags, ['remote']);
  assert.equal(out.year, '2024');
});

ok('显式标题与作者优先', () => {
  const out = Identify.fieldsFromMetadata(remote, { title: 'My Title', creators: [{ lastName: 'Me' }] });
  assert.equal(out.title, undefined);
  assert.equal(out.creators, undefined);
});

ok('不可用的识别标题不落地', () => {
  const out = Identify.fieldsFromMetadata({ title: 'LaTeX with hyperref' }, {});
  assert.equal(out.title, undefined);
});

ok('未指定类型时采用识别类型', () => {
  const out = Identify.fieldsFromMetadata(remote, { itemType: undefined });
  assert.equal(out.itemType, 'journalArticle');
});

ok('默认 document 也允许被识别类型替换', () => {
  const out = Identify.fieldsFromMetadata(remote, { itemType: 'document' });
  assert.equal(out.itemType, 'journalArticle');
});

ok('用户明确选择的类型不被替换', () => {
  const out = Identify.fieldsFromMetadata(remote, { itemType: 'thesis' });
  assert.equal(out.itemType, undefined);
});

ok('识别结果是 document 时不改类型', () => {
  const out = Identify.fieldsFromMetadata(Object.assign({}, remote, { itemType: 'document' }), { itemType: 'document' });
  assert.equal(out.itemType, undefined);
});

ok('识别结果为空时不产出任何字段', () => {
  assert.deepEqual(Identify.fieldsFromMetadata({}, {}), {});
  assert.deepEqual(Identify.fieldsFromMetadata(null, {}), {});
});

ok('多余的 opts 键被忽略（调用方可直接传整个 opts）', () => {
  const out = Identify.fieldsFromMetadata(remote, { dedupe: true, skipIdentify: true, doi: '10.5555/x' });
  assert.equal(out.doi, undefined, '显式 DOI 仍然优先');
  assert.equal(out.title, 'Remote Title', '没给标题时正常补全');
});

console.log('\ntest-identify-fields: ' + n + ' 项通过');
