'use strict';
/*
 * B01 回归：撤销只回退「这条命令改过的字段」。
 *
 * 审查报告（2026-11-08）复现的是：加标签 → 保存页码 → 新增订阅 → 改附件路径 → 撤销，
 * 旧实现恢复整库快照，页码 / 订阅 / 附件路径一起被回退。
 * 这里直接调用生产库接口，并另外用 undoStats() 卡住「20 个撤销点 = 20 份全库 JSON」的回退。
 *
 * 运行：node scripts/test-undo-delta.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('../src/library.js');

let fail = 0; let total = 0;
function check(name, ok, detail) {
  total++;
  if (!ok) { fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  <- ' + JSON.stringify(detail) : '')); }
  else console.log('  ok   ' + name);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-undo-delta-'));
process.env.PDFREADER_LIBRARY = path.join(tmp, 'library.json');
lib.resetCache();
lib.resetUndo();

const sample = path.join(tmp, 'sample.pdf');
fs.writeFileSync(sample, '%PDF-1.4\n%%EOF\n');
const moved = path.join(tmp, 'moved.pdf');
fs.writeFileSync(moved, '%PDF-1.4\n%%EOF\n');

// ---------- 1. 交错写入：撤销标签不能碰页码 / 订阅 / 附件 / 标题 ----------
{
  const it = lib.addItem({ title: '旧标题', attachment: { path: sample, name: 'sample.pdf' } });
  lib.resetUndo();
  lib.setPageByKey(it.key, 1, 100);

  lib.addTag(it.key, 'review');
  check('加标签是一个撤销点', lib.undoInfo().undoDesc === '添加标签', lib.undoInfo());

  // 之后发生的、不属于该命令的写入（都不是可撤销命令：页码 / 订阅 / 附件）
  lib.setPageByKey(it.key, 40, 100);
  lib.addFeed('https://example.com/rss', '示例订阅');
  lib.setAttachment(it.key, moved);

  const u = lib.undo();
  check('撤销返回成功', u.ok && u.desc === '添加标签', u);
  let cur = lib.findItem(it.key);
  check('标签已撤回', cur.tags.indexOf('review') < 0, cur.tags);
  check('页码保持 40（不回退）', cur.page === 40, cur.page);
  check('订阅仍在（不回退）', lib.summary().feeds.length === 1, lib.summary().feeds);
  check('附件路径仍是新路径（不回退）', cur.attachment.path === path.resolve(moved), cur.attachment);

  const rd = lib.redo();
  check('重做成功', rd.ok, rd);
  cur = lib.findItem(it.key);
  check('重做后标签回来了', cur.tags.indexOf('review') >= 0, cur.tags);
  check('重做也不回退页码', cur.page === 40, cur.page);
  check('重做也不回退订阅', lib.summary().feeds.length === 1, lib.summary().feeds);
  check('重做也不回退附件', cur.attachment.path === path.resolve(moved), cur.attachment);

  // 再撤销一次，确认重做栈与撤销栈都还能用
  check('再撤一次仍成功', lib.undo().ok, lib.undoInfo());
  check('第二次撤销后标签仍不在', lib.findItem(it.key).tags.indexOf('review') < 0, lib.findItem(it.key).tags);
}

// ---------- 1b. 相邻的两个可撤销命令：各撤各的 ----------
{
  const it = lib.addItem({ title: '旧标题' });
  lib.resetUndo();
  lib.addTag(it.key, 'review');
  lib.updateItem(it.key, { title: '新标题' });
  lib.undo();   // 只该撤「修改条目信息」
  check('撤销修改条目只回退标题', lib.findItem(it.key).title === '旧标题', lib.findItem(it.key).title);
  check('撤销修改条目不回退标签', lib.findItem(it.key).tags.indexOf('review') >= 0, lib.findItem(it.key).tags);
  lib.undo();   // 再撤标签
  check('再撤一次才回退标签', lib.findItem(it.key).tags.indexOf('review') < 0, lib.findItem(it.key).tags);
  check('撤标签不再动标题', lib.findItem(it.key).title === '旧标题', lib.findItem(it.key).title);
}

// ---------- 2. 标签重命名：只改条目上的标签，不动别的字段 ----------
{
  const a = lib.addItem({ title: 'A', year: '2020' });
  const b = lib.addItem({ title: 'B', year: '2020' });
  lib.addTag(a.key, 't1'); lib.addTag(b.key, 't1');
  lib.resetUndo();
  lib.renameTag('t1', 't2');
  lib.setPageByKey(a.key, 12, 30);
  lib.undo();
  check('重命名标签可撤销', lib.findItem(a.key).tags.indexOf('t1') >= 0 && lib.findItem(a.key).tags.indexOf('t2') < 0, lib.findItem(a.key).tags);
  check('重命名撤销不动之后保存的页码', lib.findItem(a.key).page === 12, lib.findItem(a.key).page);
}

// ---------- 3. 笔记编辑：合并成一个点，且不碰标签 ----------
{
  const it = lib.addItem({ title: '笔记条目' });
  const n = lib.addNote(it.key, { title: 'N', text: 'v1' });
  lib.resetUndo();
  lib.updateNote(it.key, n.id, { text: 'v2' });
  lib.updateNote(it.key, n.id, { text: 'v3' });
  check('连续编辑只占一个撤销点', lib.undoInfo().canUndo === 1, lib.undoInfo());
  lib.addTag(it.key, 'keep');
  lib.undo();  // 撤标签
  lib.undo();  // 撤笔记编辑
  const note = (lib.findItem(it.key).notes || []).find((x) => x.id === n.id);
  check('撤销笔记编辑回到 v1', note && note.text === 'v1', note && note.text);
  check('撤销笔记编辑不动标签（标签已单独撤回）', lib.findItem(it.key).tags.length === 0, lib.findItem(it.key).tags);
}

// ---------- 4. 删除与新建：位置可还原 ----------
{
  const a = lib.addItem({ title: '第一' });
  const b = lib.addItem({ title: '第二' });
  const c = lib.addItem({ title: '第三' });
  const idxBefore = lib.summary().items.findIndex((x) => x.key === b.key);
  lib.resetUndo();
  lib.deleteItemForever(b.key);
  check('删除后条目消失', !lib.findItem(b.key), '');
  lib.undo();
  const keys = lib.summary().items.map((x) => x.key);
  check('撤销删除后条目回来', keys.indexOf(b.key) >= 0, keys);
  check('回到原来的位置', keys.indexOf(b.key) === idxBefore, { got: keys.indexOf(b.key), want: idxBefore });
  check('没有复制出重复条目', keys.filter((k) => k === b.key).length === 1, keys);

  lib.deleteItemForever(c.key);
  lib.undo();
  lib.redo();
  check('重做删除又移除了条目', !lib.findItem(c.key), lib.summary().items.map((x) => x.key));
}

// ---------- 5. 批量导入：一次撤销全部撤掉 ----------
{
  lib.resetUndo();
  const r = lib.importItems([
    { title: '导入一', year: '2021' },
    { title: '导入二', year: '2022' },
  ]);
  check('导入两条', r.added === 2, r);
  lib.undo();
  check('一次撤销撤掉全部导入', !lib.summary().items.some((x) => x.title === '导入一' || x.title === '导入二'), lib.summary().items.map((x) => x.title));
}

// ---------- 6. 删除收藏集：集合、子集合与条目的归属都能还原 ----------
{
  const parent = lib.addCollection('父集合');
  const child = lib.addCollection('子集合', parent.id);
  const it = lib.addItem({ title: '挂集合的条目' });
  lib.setCollections(it.key, [child.id]);
  lib.resetUndo();
  lib.removeCollection(parent.id);
  check('删除收藏集后集合没了', !lib.summary().collections.some((c) => c.id === parent.id), lib.summary().collections);
  check('子集合一起没了', !lib.summary().collections.some((c) => c.id === child.id), lib.summary().collections);
  lib.undo();
  check('撤销后父集合回来', lib.summary().collections.some((c) => c.id === parent.id), lib.summary().collections.map((c) => c.name));
  check('撤销后子集合回来', lib.summary().collections.some((c) => c.id === child.id && c.parentId === parent.id), lib.summary().collections);
  check('条目的收藏集归属也回来', lib.findItem(it.key).collectionIds.indexOf(child.id) >= 0, lib.findItem(it.key).collectionIds);
}

// ---------- 6b. R02：连续编辑不同字段，一次撤销全部回退 ----------
{
  const it = lib.addItem({ title: '合并测试' });
  const n = lib.addNote(it.key, { title: 'title0', text: 'v1' });
  lib.resetUndo();
  lib.updateNote(it.key, n.id, { text: 'v2' });
  lib.updateNote(it.key, n.id, { title: 'title1' });
  check('连续改不同字段只占一个撤销点', lib.undoInfo().canUndo === 1, lib.undoInfo());
  lib.undo();
  const cur = (lib.findItem(it.key).notes || []).find((x) => x.id === n.id);
  check('一次撤销把正文与标题都退回', cur && cur.text === 'v1' && cur.title === 'title0', cur && { text: cur.text, title: cur.title });
  lib.redo();
  const re = (lib.findItem(it.key).notes || []).find((x) => x.id === n.id);
  check('一次重做把两个字段都恢复', re && re.text === 'v2' && re.title === 'title1', re && { text: re.text, title: re.title });
}

// ---------- 6c. R02：改回原值不留假撤销点 ----------
{
  const it = lib.addItem({ title: '改回测试' });
  const n = lib.addNote(it.key, { title: 'n', text: 'v1' });
  lib.resetUndo();
  lib.updateNote(it.key, n.id, { text: 'v2' });
  lib.updateNote(it.key, n.id, { text: 'v1' });
  check('改回原值后没有留下撤销点', lib.undoInfo().canUndo === 0, lib.undoInfo());
  check('正文仍是 v1', (lib.findItem(it.key).notes || []).find((x) => x.id === n.id).text === 'v1', '');
}

// ---------- 6d. R02：字段「新增→移除」不残留 ----------
{
  const it = lib.addItem({ title: '字段增删' });
  const n = lib.addNote(it.key, { title: 'n', text: 'v1' });
  lib.resetUndo();
  lib.updateNote(it.key, n.id, { meta: { tags: ['x'], status: 'draft' } });
  lib.updateNote(it.key, n.id, { meta: { tags: [], status: '' } });
  check('元数据加上又去掉也不留撤销点', lib.undoInfo().canUndo === 0, lib.undoInfo());
}

// ---------- 6e. R03：别名数组撤销不能写出 null ----------
{
  const it = lib.addItem({ itemType: 'note', title: 'A' });
  lib.updateItem(it.key, { title: 'B' });          // 别名 ["A"]
  lib.resetUndo();
  lib.updateItem(it.key, { title: 'C' });          // 别名 ["B","A"]
  const before = lib.summary().items.find((x) => x.key === it.key).aliases.slice();
  check('改名后别名是两项', before.length === 2, before);
  lib.undo();
  const item = lib.findItem(it.key);
  const aliases = (lib.summary().items.find((x) => x.key === it.key).aliases || []);
  check('撤销后标题回到 B', item.title === 'B', item.title);
  check('别名严格回到 ["A"]', JSON.stringify(aliases) === JSON.stringify(['A']), aliases);
  check('别名里没有 null / 空洞', aliases.every((x) => typeof x === 'string' && x), aliases);
  // 落盘内容也要干净
  lib.resetCache();
  const raw = fs.readFileSync(process.env.PDFREADER_LIBRARY, 'utf8');
  check('落盘 JSON 里没有 null 别名', !/"noteAliases":\{[^}]*null/.test(raw), '');
}

// ---------- 7. 撤销栈里不再放整库 JSON ----------
{
  // 造一个大一点的库：300 条，每条 400 字符摘要
  const big = [];
  for (let i = 0; i < 300; i++) big.push({ title: '大库条目 ' + i, abstract: 'x'.repeat(400) });
  lib.importItems(big, { skipDuplicates: false });
  lib.resetUndo();
  const libBytes = fs.statSync(process.env.PDFREADER_LIBRARY).size;
  const keys = lib.summary().items.slice(0, 20).map((x) => x.key);
  for (let i = 0; i < 20; i++) lib.addTag(keys[i % keys.length], 'tag' + i);
  const st = lib.undoStats();
  check('20 个撤销点都在', st.depth === 20, st);
  check('撤销栈远小于 20 份整库（' + libBytes + ' B）', st.chars < libBytes / 4, st.chars);
  // 整库快照时代这里约等于 20 × 库大小，现在应该只有几 KB
  check('撤销栈总量在 40 KB 以内', st.chars < 40 * 1024, st.chars);
}

// ---------- 8. 清空回收站：一次撤销全回来 ----------
{
  const a = lib.addItem({ title: '回收一' });
  const b = lib.addItem({ title: '回收二' });
  lib.trashItem(a.key); lib.trashItem(b.key);
  lib.resetUndo();
  const n = lib.emptyTrash();
  check('清空回收站删掉两条', n === 2, n);
  lib.undo();
  check('撤销后两条都回来', !!lib.findItem(a.key) && !!lib.findItem(b.key), '');
  // 撤销「清空回收站」是把条目恢复到「在回收站里」的状态，而不是恢复到阅读列表
  check('回到回收站状态', !!lib.findItem(a.key).deletedAt && !!lib.findItem(b.key).deletedAt, lib.findItem(a.key).deletedAt);
  check('回收站计数恢复到 2', lib.summary().trashCount === 2, lib.summary().trashCount);
}

console.log('[undo-delta] ' + (fail ? 'FAIL ' : 'PASS ') + '(' + total + ')');
process.exitCode = fail ? 1 : 0;
