'use strict';
/*
 * 库级全文索引回归（v11）。纯 Node（pdfjs-dist 可在 Node 里直接抽文本），临时目录隔离。
 * 覆盖：建索引、新鲜度、搜索片段、多词 AND、重建/清空、重复附件、坏 PDF、坏索引容错。
 * 运行：node scripts/test-fulltext.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SAMPLE = path.join(ROOT, 'assets', 'sample.pdf');
const fulltext = require(path.join(ROOT, 'src', 'fulltext.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-ft-'));
const copy = path.join(tmp, 'sample-copy.pdf');
fs.copyFileSync(SAMPLE, copy);

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  <- ' + detail : '')); }
}

(async () => {
  fulltext.init(tmp);
  ok('索引目录在数据目录下', fulltext.dirPath() === path.join(tmp, 'fulltext'));
  ok('索引文件名是 24 位 sha1', /^[a-f0-9]{24}\.json$/.test(path.basename(fulltext.fileFor(copy))), path.basename(fulltext.fileFor(copy)));

  // 建索引
  let r = await fulltext.indexFile(copy);
  ok('首次建索引成功', r.ok === true && r.pages === 3, JSON.stringify(r));
  ok('抽出文本非空', r.chars > 0, 'chars=' + r.chars);
  ok('索引文件已落盘', fs.existsSync(fulltext.fileFor(copy)));
  let st = fulltext.stats();
  ok('stats 计入 1 个索引', st.indexed === 1 && st.failed === 0 && st.pages === 3, JSON.stringify(st));
  ok('isFresh 判断为新鲜', fulltext.isFresh(copy) === true);

  // 搜索
  let hit = fulltext.search('sample page 2');
  ok('多词 AND 命中第 2 页', hit.results.length === 1 && hit.results[0].page === 2, JSON.stringify(hit.results));
  ok('摘要片段正确', /Sample page 2 of 3/.test(hit.results[0].snippet), hit.results[0].snippet);
  ok('命中次数', hit.results[0].count >= 1, String(hit.results[0].count));
  ok('大小写不敏感', fulltext.search('SAMPLE PAGE 3').results.some((x) => x.page === 3));
  ok('无结果词返回空', fulltext.search('zzz-not-exist').results.length === 0);
  const emptyQ = fulltext.search('   ');
  ok('空查询返回空结果', emptyQ.results.length === 0 && emptyQ.query === '');
  ok('搜索结果带绝对路径', hit.results[0].path === path.resolve(copy), hit.results[0].path);

  // 新鲜度：未变化时跳过，force 强制重建
  let again = await fulltext.indexFile(copy);
  ok('未变化时跳过重建', again.ok === true && again.skipped === true, JSON.stringify(again));
  again = await fulltext.indexFile(copy, { force: true });
  ok('force 强制重建', again.ok === true && !again.skipped, JSON.stringify(again));

  // 文件变动后索引失效
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(copy, future, future);
  ok('mtime 变化后 isFresh=false', fulltext.isFresh(copy) === false);
  r = await fulltext.indexFile(copy);
  ok('变动后能重建', r.ok === true && !r.skipped, JSON.stringify(r));

  // 同一 PDF 被两个条目引用：只存 1 份索引，indexedItems 仍为 2（主进程统计）
  fulltext.clear();
  let all = await fulltext.indexAll([
    { key: 'a', attachment: { path: copy } },
    { key: 'b', attachment: { path: copy } },
  ]);
  ok('indexAll 两条都处理', all.ok && all.done === 2 && all.failed === 0, JSON.stringify(all));
  ok('同一路径只建 1 份索引', all.skipped === 1 && fulltext.stats().indexed === 1, JSON.stringify({ skipped: all.skipped, st: fulltext.stats() }));

  // 回收站/无附件条目被跳过
  all = await fulltext.indexAll([
    { key: 'trash', deletedAt: 1, attachment: { path: copy } },
    { key: 'noatt' },
    null,
  ]);
  ok('回收站/无附件条目不计入', all.total === 0 && all.done === 0, JSON.stringify(all));

  // 坏 PDF：记录错误但不抛错，也不影响其他索引
  const broken = path.join(tmp, 'broken.pdf');
  fs.writeFileSync(broken, 'this is definitely not a pdf');
  r = await fulltext.indexFile(broken);
  ok('坏 PDF 返回失败而非抛错', r.ok === false && !!r.error, JSON.stringify(r));
  st = fulltext.stats();
  ok('stats.failed 计入坏 PDF', st.failed === 1 && st.indexed === 1, JSON.stringify(st));
  ok('坏 PDF 的索引不算新鲜', fulltext.isFresh(broken) === false);
  ok('坏 PDF 不污染正常搜索', fulltext.search('sample page 2').results.length === 1);

  // 坏索引文件：搜索跳过、stats 忽略、可重建
  fs.writeFileSync(fulltext.fileFor(copy), '{ broken json');
  ok('坏索引 isFresh=false', fulltext.isFresh(copy) === false);
  ok('坏索引不会让搜索抛错', Array.isArray(fulltext.search('sample').results));
  ok('坏索引在 stats 里不计入 indexed', fulltext.stats().indexed === 0, JSON.stringify(fulltext.stats()));
  r = await fulltext.indexFile(copy);
  ok('坏索引可重建', r.ok === true && fulltext.isFresh(copy) === true, JSON.stringify(r));

  // 索引是缓存：删除后 search 空，但原 PDF 不受影响
  ok('removeForPath 生效', fulltext.removeForPath(copy) === true && !fs.existsSync(fulltext.fileFor(copy)));
  ok('删索引不碰原 PDF', fs.existsSync(copy));
  ok('索引删除后搜不到', fulltext.search('sample page 2').results.length === 0);

  // 重建后清空
  await fulltext.indexFile(copy);
  ok('重建后能搜到', fulltext.search('sample page 2').results.length === 1);
  const n = fulltext.clear();
  ok('clear 清空索引', n >= 1 && fulltext.stats().indexed === 0, 'removed=' + n);

  // 边界：不存在的文件 / 无附件条目
  r = await fulltext.indexFile(path.join(tmp, 'nope.pdf'));
  ok('不存在的文件返回失败', r.ok === false && /不存在/.test(r.error), JSON.stringify(r));
  r = await fulltext.indexOne({ key: 'x' });
  ok('无附件条目返回失败', r.ok === false && /附件/.test(r.error), JSON.stringify(r));

  // 清理
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}

  console.log('[fulltext] ' + (fail ? 'FAIL (' + fail + '/' + (pass + fail) + ')' : 'PASS (' + pass + ')'));
  process.exit(fail ? 2 : 0);
})().catch((e) => {
  console.error('[fulltext] ERROR', e && e.stack ? e.stack : e);
  process.exit(3);
});
