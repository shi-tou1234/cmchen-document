'use strict';
/*
 * 数据层新增字段回归（2026-10-29）
 * 覆盖：readStatus 的读写与非法值、批量标记、附件指纹落库、
 *       笔记改名的旧标题别名（累积 / 改回 / 非笔记不受影响）、
 *       老库兼容（没有新字段照常读）、合并库时别名跟随条目、永久删除清别名。
 * 运行：node scripts/test-library-meta.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-lib-'));
process.env.PDFREADER_LIBRARY = path.join(dir, 'library.json');
const library = require('../src/library.js');
library.init(dir);

let n = 0;
function ok(name, fn) {
  fn();
  n++;
  console.log('  ok ' + n + ' - ' + name);
}

const fp = { size: 12345, hash: 'a'.repeat(40) };
const pdf = path.join(dir, 'paper.pdf');

try {
  const item = library.addPdf(pdf, { title: '测试论文', fingerprint: fp });
  const key = item.key;

  ok('导入时保存附件指纹', () => {
    const it = library.summary().items.find((x) => x.key === key);
    assert.deepEqual(it.attachment.fingerprint, fp);
  });

  ok('新条目默认没有阅读状态', () => {
    const it = library.summary().items.find((x) => x.key === key);
    assert.equal(it.readStatus, '');
  });

  ok('标记待读并落盘', () => {
    library.updateItem(key, { readStatus: 'todo' });
    library.resetCache();
    const it = library.summary().items.find((x) => x.key === key);
    assert.equal(it.readStatus, 'todo');
  });

  ok('非法状态值归一为空', () => {
    library.updateItem(key, { readStatus: 'whatever' });
    const it = library.summary().items.find((x) => x.key === key);
    assert.equal(it.readStatus, '');
  });

  ok('批量标记阅读状态', () => {
    const b = library.addPdf(path.join(dir, 'b.pdf'), { title: 'B' });
    const r = library.bulkUpdate([key, b.key], { readStatus: 'done' });
    assert.equal(r.updated, 2);
    const items = library.summary().items;
    assert.equal(items.find((x) => x.key === key).readStatus, 'done');
    assert.equal(items.find((x) => x.key === b.key).readStatus, 'done');
  });

  const note = library.addItem({ itemType: 'note', title: '原始笔记' });

  ok('笔记改名记录旧标题', () => {
    library.updateItem(note.key, { title: '改名后' });
    const it = library.summary().items.find((x) => x.key === note.key);
    assert.deepEqual(it.aliases, ['原始笔记']);
  });

  ok('多次改名累积旧标题，最新的排前面', () => {
    library.updateItem(note.key, { title: '第三版' });
    const it = library.summary().items.find((x) => x.key === note.key);
    assert.deepEqual(it.aliases, ['改名后', '原始笔记']);
  });

  ok('改回旧标题时把它从别名里摘掉', () => {
    library.updateItem(note.key, { title: '原始笔记' });
    const it = library.summary().items.find((x) => x.key === note.key);
    assert.equal(it.aliases.includes('原始笔记'), false, '现标题不该同时是别名');
    assert.equal(it.aliases[0], '第三版');
  });

  ok('普通条目改名不产生别名', () => {
    library.updateItem(key, { title: '论文改名' });
    const it = library.summary().items.find((x) => x.key === key);
    assert.deepEqual(it.aliases, []);
  });

  ok('没有新字段的老库照常读', () => {
    const raw = {
      version: 8,
      collections: [],
      searches: [],
      items: [{ key: 'old1', itemType: 'note', title: '老笔记', notes: [{ id: 'n1', text: '正文' }] }],
    };
    fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify(raw));
    library.resetCache();
    const s = library.summary();
    assert.equal(s.items.length, 1);
    assert.equal(s.items[0].readStatus, '');
    assert.deepEqual(s.items[0].aliases, []);
  });

  ok('合并库时别名跟着新条目走', () => {
    const merged = library.combineStores(
      { version: 8, items: [{ key: 'a1', itemType: 'note', title: 'A' }], noteAliases: { a1: ['旧A'] } },
      { version: 8, items: [{ key: 'b1', itemType: 'note', title: 'B' }], noteAliases: { b1: ['旧B'], a1: ['不该覆盖'] } },
    );
    assert.deepEqual(merged.noteAliases.b1, ['旧B']);
    assert.deepEqual(merged.noteAliases.a1, ['旧A'], '当前库已有的别名优先');
  });

  ok('永久删除条目时清掉别名', () => {
    const tmp = library.addItem({ itemType: 'note', title: '待删' });
    library.updateItem(tmp.key, { title: '删前改名' });
    assert.deepEqual(library.summary().items.find((x) => x.key === tmp.key).aliases, ['待删']);
    library.deleteItemForever(tmp.key);
    library.resetCache();
    assert.equal(library.summary().items.some((x) => x.key === tmp.key), false);
    assert.equal(library.exportStore().noteAliases[tmp.key], undefined);
  });
  ok('ensurePdf 在同步代码里完成查重与建条目（审核问题 2）', () => {
    const p = path.join(dir, 'race.pdf');
    const a = library.ensurePdf(p, { dedupe: true, title: 'Race A' });
    const b = library.ensurePdf(p, { dedupe: true, title: 'Race B' });
    assert.equal(a.deduped, false, '第一次应新建');
    assert.equal(b.deduped, true, '第二次应命中刚建的那条');
    assert.equal(a.item.key, b.item.key, '两次必须指向同一条记录');
    assert.equal(b.item.title, 'Race A', '后来的调用不能改掉已存在条目的字段');
    const same = library.summary().items.filter((x) => x.attachment && x.attachment.path === p);
    assert.equal(same.length, 1, '同路径只能有一条记录，实际 ' + same.length);
  });

  ok('ensurePdf 会把回收站里的同路径条目还原', () => {
    const p = path.join(dir, 'race.pdf');
    const first = library.summary().items.find((x) => x.attachment && x.attachment.path === p);
    library.trashItem(first.key);
    const r = library.ensurePdf(p, { dedupe: true });
    assert.equal(r.deduped, true);
    assert.equal(r.restored, true);
    assert.equal(r.item.deletedAt, 0, '应已离开回收站');
  });

  ok('ensurePdf 未要求去重时仍然可以建重复记录', () => {
    const p = path.join(dir, 'race.pdf');
    const before = library.summary().items.filter((x) => x.attachment && x.attachment.path === p).length;
    const r = library.ensurePdf(p, {});
    assert.equal(r.deduped, false);
    const after = library.summary().items.filter((x) => x.attachment && x.attachment.path === p).length;
    assert.equal(after, before + 1, '不传 dedupe 时应保持「每次新建」的老语义');
  });
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

console.log('\ntest-library-meta: ' + n + ' 项通过');
