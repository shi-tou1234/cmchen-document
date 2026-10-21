'use strict';
/*
 * 数据层回归：本地库 v2 —— 元数据 / 多收藏集 / 回收站 / 附件重定位 / v1 迁移 /
 * 跨进程持久化 / 损坏自愈 / BOM。纯 Node，不需要 Electron。
 * 运行：node scripts/test-library.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const LIB = path.join(__dirname, '..', 'src', 'library.js');
const lib = require(LIB);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-lib-'));
const storeFile = path.join(tmp, 'library.json');
const fakePdf = path.join(tmp, 'Smith_2020_Neural_Nets.pdf');
const movedPdf = path.join(tmp, 'Smith_2020_Neural_Nets_renamed.pdf');
fs.writeFileSync(fakePdf, '%PDF-1.4\n% fake\n');
fs.writeFileSync(movedPdf, '%PDF-1.4\n% fake moved\n');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  <- ' + detail : '')); }
}

// 全新库
process.env.PDFREADER_LIBRARY = storeFile;
lib.resetCache();
let sum = lib.summary();
ok('空库无条目/集合', sum.items.length === 0 && sum.collections.length === 0);
ok('库版本为 v4', sum.version === 4, 'version=' + sum.version);
ok('summary 带条目类型表', Array.isArray(sum.itemTypes) && sum.itemTypes.some((t) => t.id === 'journalArticle'));

// 拖入 PDF → 建条目，标题从文件名猜（去下划线、去数字前缀）
const it = lib.addPdf(fakePdf);
ok('addPdf 生成条目', !!it && !!it.key && it.attachment.path === fakePdf);
ok('标题从文件名推断', it.title === 'Smith 2020 Neural Nets', 'got=' + it.title);
ok('默认类型 document', it.itemType === 'document');
ok('默认字段齐全', it.volume === '' && it.issue === '' && it.pages === '' && it.doi === '' &&
  it.abstract === '' && it.note === '' && it.language === '' && it.deletedAt === 0);

// 改元数据：只认白名单字段，attachment/deletedAt 不能被 updateItem 覆盖
const upd = lib.updateItem(it.key, {
  title: '改过的标题', year: '2020', volume: '12', issue: '3', pages: '45-67',
  doi: '10.1000/xyz', url: 'https://example.org/a', abstract: '这是一段摘要', language: 'zh',
  itemType: 'journalArticle', attachment: 'HACK', deletedAt: 999,
});
ok('updateItem 改标题/年份', upd.title === '改过的标题' && upd.year === '2020');
ok('updateItem 写新文献字段', upd.volume === '12' && upd.issue === '3' && upd.pages === '45-67' &&
  upd.doi === '10.1000/xyz' && upd.url === 'https://example.org/a' && upd.abstract === '这是一段摘要');
ok('updateItem 改条目类型', upd.itemType === 'journalArticle');
ok('updateItem 忽略 attachment 字段', upd.attachment && upd.attachment.path === fakePdf, JSON.stringify(upd.attachment));
ok('updateItem 不能直接改 deletedAt', lib.findItem(it.key).deletedAt === 0);
ok('非法 itemType 回落 document', lib.updateItem(it.key, { itemType: 'martian' }).itemType === 'document');

// 标签：去重
lib.addTag(it.key, 'ML'); lib.addTag(it.key, 'ML'); lib.addTag(it.key, '论文');
ok('标签去重', JSON.stringify(lib.findItem(it.key).tags) === '["ML","论文"]');
lib.removeTag(it.key, 'ML');
ok('删标签', JSON.stringify(lib.findItem(it.key).tags) === '["论文"]');

// 收藏集 + 嵌套 + 多归属
const root = lib.addCollection('研究');
const child = lib.addCollection('子集A', root.id);
ok('集合嵌套 parentId', child.parentId === root.id);
lib.setCollections(it.key, [root.id, child.id]);
ok('条目可同属多个集合', JSON.stringify(lib.findItem(it.key).collectionIds.sort()) === JSON.stringify([root.id, child.id].sort()));
lib.setCollections(it.key, [child.id, 'ghost-collection']);
ok('多集合写入会过滤不存在的集合', JSON.stringify(lib.findItem(it.key).collectionIds) === JSON.stringify([child.id]));
lib.moveItem(it.key, child.id);
ok('moveItem 收敛为单一集合', JSON.stringify(lib.findItem(it.key).collectionIds) === JSON.stringify([child.id]));
ok('summary 暴露 collectionIds', (lib.summary().items.find((x) => x.key === it.key) || {}).collectionIds.length === 1);

// 删父集合：条目应回落到父级（root 被删→它父级是 null→变未分类），且不删条目/不删文件
lib.removeCollection(root.id);
ok('删集合后集合消失', !lib.summary().collections.some((c) => c.id === root.id));
ok('删集合不删条目', !!lib.findItem(it.key));
ok('删集合后子集合也没了', !lib.summary().collections.some((c) => c.id === child.id));
ok('PDF 文件仍在（只解绑不删盘）', fs.existsSync(fakePdf));

// 页码
lib.setPageByKey(it.key, 42);
ok('记住页码', lib.findItem(it.key).page === 42);
ok('按路径找条目', lib.findItemByPath(fakePdf) && lib.findItemByPath(fakePdf).key === it.key);

// 附件重新定位：只改索引路径，不动磁盘
const relinked = lib.setAttachment(it.key, movedPdf);
ok('setAttachment 更新路径+文件名', relinked.attachment.path === movedPdf && relinked.attachment.name === path.basename(movedPdf));
ok('两个磁盘文件都还在', fs.existsSync(fakePdf) && fs.existsSync(movedPdf));
lib.setAttachment(it.key, fakePdf); // 复原，后面回收站断言还用这个路径

// 回收站：软删除 → 还原 → 清空（都绝不删磁盘 PDF）
const trashIt = lib.addPdf(fakePdf, { title: '待回收的条目' });
lib.trashItem(trashIt.key);
ok('trashItem 写入 deletedAt', lib.findItem(trashIt.key).deletedAt > 0);
ok('回收站条目仍在 summary 里（带 deletedAt）', (lib.summary().items.find((x) => x.key === trashIt.key) || {}).deletedAt > 0);
ok('summary.trashCount 计入', lib.summary().trashCount === 1);
lib.restoreItem(trashIt.key);
ok('restoreItem 清掉 deletedAt', lib.findItem(trashIt.key).deletedAt === 0);
ok('还原后 trashCount 归零', lib.summary().trashCount === 0);
lib.trashItem(trashIt.key);
const removedN = lib.emptyTrash();
ok('emptyTrash 只删索引', removedN === 1 && !lib.findItem(trashIt.key));
ok('清空回收站后磁盘 PDF 仍在', fs.existsSync(fakePdf));
const foreverIt = lib.addPdf(fakePdf, { title: '永久删除' });
ok('deleteItemForever 生效', lib.deleteItemForever(foreverIt.key) === true && !lib.findItem(foreverIt.key));
ok('永久删索引也不删磁盘文件', fs.existsSync(fakePdf));

// 大量条目 key 不撞
const keys = new Set();
for (let i = 0; i < 80; i++) keys.add(lib.addPdf(fakePdf, { title: 'dup' + i }).key);
ok('80 条 key 全唯一', keys.size === 80, 'unique=' + keys.size);

// 跨进程持久化：新进程从同一磁盘文件重载
const child1 = lib.summary().items.length;
const out = execFileSync(process.execPath, ['-e',
  'const l=require(process.argv[1]);const s=l.summary();' +
  'process.stdout.write(JSON.stringify({items:s.items.length,pages:s.items.find(x=>x.page>0),' +
  'multi:(s.items.find(x=>x.key===' + JSON.stringify(it.key) + ')||{}).collectionIds,types:s.itemTypes.length}));',
  LIB,
], { env: Object.assign({}, process.env, { PDFREADER_LIBRARY: storeFile }), encoding: 'utf8' });
const reloaded = JSON.parse(out);
ok('新进程读到持久化条目', reloaded.items === child1, 'disk=' + reloaded.items + ' mem=' + child1);
ok('新进程读到页码 42', reloaded.pages && reloaded.pages.page === 42, JSON.stringify(reloaded.pages));
ok('新进程读到完整字段', reloaded.pages && reloaded.pages.abstract === '这是一段摘要' && reloaded.pages.doi === '10.1000/xyz');

// 同进程模拟重载
lib.resetCache();
ok('resetCache 后仍从盘恢复', lib.summary().items.length === child1);

// v1 → v2 迁移：旧的单值 collectionId 自动进 collectionIds
const v1File = path.join(tmp, 'v1-library.json');
fs.writeFileSync(v1File, JSON.stringify({
  version: 1,
  collections: [{ id: 'c1', name: '旧集合', parentId: null }],
  items: [{ key: 'old1', itemType: 'document', title: '旧条目', creators: ['张三'], year: '2019',
    tags: ['旧标签'], collectionId: 'c1', attachment: { path: fakePdf, name: 'x.pdf' }, page: 3 }],
}));
process.env.PDFREADER_LIBRARY = v1File; lib.init(); lib.resetCache();
const oldSum = lib.summary();
ok('v1 数据能读', oldSum.items.length === 1 && oldSum.collections.length === 1);
ok('v1 collectionId 迁入 collectionIds', JSON.stringify(oldSum.items[0].collectionIds) === '["c1"]');
ok('v1 缺省字段被补齐', oldSum.items[0].abstract === '' && oldSum.items[0].volume === '' && oldSum.items[0].deletedAt === 0);

// 父级成环/幽灵父级：必须被打断，不能把 UI 挂死
const cycFile = path.join(tmp, 'cyclic.json');
fs.writeFileSync(cycFile, JSON.stringify({ version: 2, collections: [
  { id: 'a', name: 'A', parentId: 'b' }, { id: 'b', name: 'B', parentId: 'a' },
  { id: 'c', name: 'C', parentId: 'ghost' }], items: [] }));
process.env.PDFREADER_LIBRARY = cycFile; lib.init(); lib.resetCache();
const cs = lib.summary().collections;
const depths = cs.map((c) => { // 从任一节点向上走，步数必须有界
  let d = 0, cur = c; const seen = new Set([c.id]);
  while (cur && cur.parentId && d < 10) { if (seen.has(cur.parentId)) return 99; seen.add(cur.parentId); cur = cs.find((x) => x.id === cur.parentId); d++; }
  return d;
});
ok('集合父链不成环（深度有界）', depths.every((d) => d < 10), JSON.stringify(depths));
ok('幽灵父级回落顶层', (cs.find((c) => c.id === 'c') || {}).parentId === null);

// 恢复主库，损坏自愈：写垃圾再重载，应备份坏文件并从空库继续、不抛错
process.env.PDFREADER_LIBRARY = storeFile; lib.init(); lib.resetCache();
fs.writeFileSync(storeFile, '{ this is : not json ]');
lib.resetCache();
const afterCorrupt = lib.summary();
ok('损坏后不崩溃且清空', afterCorrupt.items.length === 0);
const backups = fs.readdirSync(tmp).filter((f) => f.startsWith('library.json.corrupt-'));
ok('坏文件被留证备份', backups.length >= 1, JSON.stringify(backups));

// BOM 容忍：记事本/PowerShell 常写 UTF-8 BOM，应能正常解析而非判为损坏
const bomFile = path.join(tmp, 'bom.json');
fs.writeFileSync(bomFile, '\uFEFF' + JSON.stringify({ version: 2,
  collections: [{ id: 'nope', name: 'BOM 集合', parentId: null }],
  items: [{ key: 'b0', title: 'BOM Item', collectionId: 'nope', tags: [] }] }));
process.env.PDFREADER_LIBRARY = bomFile; lib.init(); lib.resetCache();
ok('带 BOM 的库文件能正常读取', lib.summary().items.length === 1 && lib.summary().items[0].title === 'BOM Item');
ok('BOM 文件的 v1 字段也迁移', JSON.stringify(lib.summary().items[0].collectionIds) === '["nope"]');
process.env.PDFREADER_LIBRARY = storeFile; lib.init(); lib.resetCache(); // 复原

// ---------- v3 新能力：智能收藏集 / 批量编辑 / 查重合并 / BibTeX 导入 ----------
// 用独立的库文件，避免前面「损坏自愈」留下的空库影响计数
const v3File = path.join(tmp, 'v3-library.json');
process.env.PDFREADER_LIBRARY = v3File; lib.init(); lib.resetCache();
const colX = lib.addCollection('查重集');
const pdfA = path.join(tmp, 'a.pdf'); fs.writeFileSync(pdfA, '%PDF-1.4\n');
const pdfB = path.join(tmp, 'b.pdf'); fs.writeFileSync(pdfB, '%PDF-1.4\n');

// 智能收藏集 = 保存的搜索条件
const s1 = lib.addSearch('深度学习', 'transformer');
ok('addSearch 生成收藏集', !!s1 && s1.name === '深度学习' && s1.query === 'transformer', JSON.stringify(s1));
ok('空查询不建智能收藏集', lib.addSearch('空', '   ') === null);
ok('summary 暴露 searches', lib.summary().searches.length === 1);
ok('removeSearch 生效', lib.removeSearch(s1.id) === true && lib.summary().searches.length === 0);
ok('removeSearch 不存在返回 false', lib.removeSearch('nope') === false);

// 查重：DOI（含 doi.org URL 形式）+ 标准化标题 & 年份；太短标题不参与
const A = lib.addItem({
  title: 'Deep Learning', year: '2020', doi: '10.1000/dup', publication: 'Nature',
  creators: ['Ada Lovelace'], tags: ['ML'], collectionIds: [colX.id],
  attachment: { path: pdfA, name: 'a.pdf' }, page: 5,
});
const B = lib.addItem({ title: 'Deep   Learning', year: '2020', attachment: { path: pdfB, name: 'b.pdf' } });
const C = lib.addItem({ title: 'Deep Learning', year: '2019' });
const D = lib.addItem({ title: 'AI', year: '2020', doi: '10.1000/ai' });
const E = lib.addItem({ title: 'Another Title', year: '2021', doi: 'https://doi.org/10.1000/dup' });
const dup = lib.findDuplicates();
ok('查重只返回 1 组', dup.length === 1, 'groups=' + dup.length);
ok('DOI 与标题+年份把 A/B/E 并成一组', dup[0] && dup[0].keys.length === 3 &&
  [A.key, B.key, E.key].every((k) => dup[0].keys.includes(k)), JSON.stringify(dup[0] && dup[0].keys));
ok('不同年份不误判', dup[0] && !dup[0].keys.includes(C.key));
ok('过短标题不参与查重', dup[0] && !dup[0].keys.includes(D.key));
ok('查重原因包含两种规则', dup[0] && dup[0].reasons.length >= 2, JSON.stringify(dup[0] && dup[0].reasons));
ok('查重组带条目摘要', dup[0] && dup[0].items.length === 3 && dup[0].items.every((x) => !!x.key));

// 合并：保留项补空字段、合并作者/标签/收藏集/页码；被合并项只删索引，不删 PDF
const merged = lib.mergeItems(B.key, [A.key, E.key]);
ok('mergeItems 返回保留项', !!merged && merged.key === B.key, JSON.stringify(merged && merged.key));
ok('合并补齐 DOI/出版物', merged.doi === '10.1000/dup' && merged.publication === 'Nature', JSON.stringify([merged.doi, merged.publication]));
ok('合并作者/标签/收藏集', merged.creators.includes('Ada Lovelace') && merged.tags.includes('ML') && merged.collectionIds.includes(colX.id), JSON.stringify([merged.creators, merged.tags, merged.collectionIds]));
ok('合并带过页码', merged.page === 5, String(merged.page));
ok('被合并条目已从索引移除', !lib.findItem(A.key) && !lib.findItem(E.key));
ok('合并后原 PDF 都还在', fs.existsSync(pdfA) && fs.existsSync(pdfB));
ok('mergeItems 找不到保留项返回 null', lib.mergeItems('nope', [B.key]) === null);

// 批量编辑：只动选中且未删除的条目；标签/收藏集支持增删
const b1 = lib.addItem({ title: 'Bulk 1', year: '2000', tags: ['old'], collectionIds: [colX.id] });
const b2 = lib.addItem({ title: 'Bulk 2', year: '2001', tags: ['old'] });
const b3 = lib.addItem({ title: 'Bulk 3', year: '2002' });
lib.trashItem(b3.key);
let bulk = lib.bulkUpdate([b1.key, b2.key, b3.key], { year: '2024', addTags: ['批量'], addCollectionIds: [colX.id] });
ok('批量编辑命中 2 条', bulk.updated === 2, JSON.stringify(bulk));
ok('批量改年份生效', lib.findItem(b1.key).year === '2024' && lib.findItem(b2.key).year === '2024');
ok('批量加标签去重', lib.findItem(b2.key).tags.includes('批量') && lib.findItem(b2.key).tags.filter((t) => t === '批量').length === 1, JSON.stringify(lib.findItem(b2.key).tags));
ok('批量加收藏集', lib.findItem(b2.key).collectionIds.includes(colX.id), JSON.stringify(lib.findItem(b2.key).collectionIds));
ok('回收站条目不被批量修改', lib.findItem(b3.key).year === '2002' && lib.findItem(b3.key).tags.length === 0);
bulk = lib.bulkUpdate([b1.key], { removeTags: ['old'], removeCollectionIds: [colX.id], itemType: 'martian' });
ok('批量删标签/收藏集', !lib.findItem(b1.key).tags.includes('old') && !lib.findItem(b1.key).collectionIds.includes(colX.id), JSON.stringify([lib.findItem(b1.key).tags, lib.findItem(b1.key).collectionIds]));
ok('非法 itemType 不覆盖原值', lib.findItem(b1.key).itemType === 'document', lib.findItem(b1.key).itemType);
bulk = lib.bulkUpdate([b1.key], { addCollectionIds: ['ghost'] });
ok('批量加幽灵收藏集被过滤', lib.findItem(b1.key).collectionIds.length === 0, JSON.stringify(lib.findItem(b1.key).collectionIds));

// BibTeX/RIS 导入：按 DOI 或标题+年份去重
const beforeImport = lib.summary().items.length;
let imp = lib.importItems([
  { title: 'Imported One', year: '2021', doi: '10.1000/imp', creators: ['X Y'], itemType: 'journalArticle', tags: ['t1'] },
  { title: 'Imported One', year: '2021' },                       // 同标题+年份 → 跳过
  { title: 'Imported Two', year: '2022', doi: '10.1000/dup' },    // DOI 已存在 → 跳过
  { title: '' },                                                   // 无标题 → 跳过
]);
ok('导入只加 1 条', imp.added === 1 && imp.skipped === 3, JSON.stringify(imp));
ok('导入后条目数 +1', lib.summary().items.length === beforeImport + 1);
const imported = lib.findItem(imp.keys[0]);
ok('导入字段完整', imported.title === 'Imported One' && imported.year === '2021' && imported.creators[0] === 'X Y' && imported.itemType === 'journalArticle', JSON.stringify(imported));
ok('导入 DOI 去前缀', imported.doi === '10.1000/imp', imported.doi);
imp = lib.importItems([{ title: 'Imported One', year: '2021' }], { skipDuplicates: false });
ok('关闭去重后可重复导入', imp.added === 1 && imp.skipped === 0, JSON.stringify(imp));

// 清理
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}

console.log('[library] ' + (fail ? 'FAIL (' + fail + '/' + (pass + fail) + ')' : 'PASS (' + pass + ')'));
process.exit(fail ? 2 : 0);
