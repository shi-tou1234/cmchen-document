'use strict';
/*
 * 标注条目化回归：库里的标注标签 + 标注汇总。纯 Node，不启 Electron。
 * 运行：node scripts/test-anno.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const lib = require(path.join(ROOT, 'src', 'library.js'));

let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) console.log('  ok   ' + name);
  else { fail++; console.log('  FAIL ' + name + (detail ? '  <- ' + detail : '')); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anno-'));
const store = path.join(tmp, 'library.json');
fs.writeFileSync(store, JSON.stringify({
  version: 6, collections: [], searches: [], tagColors: {},
  items: [{
    key: 'itA', itemType: 'journalArticle', title: '旧条目', creators: ['张三'],
    year: '2020', tags: [], collectionIds: [], attachment: null, page: 0,
    created: 1, updated: 1, deletedAt: 0,
  }],
}));
process.env.PDFREADER_LIBRARY = store;
lib.resetCache();

let sum = lib.summary();
ok('v6 库升到 v8', sum.version === 8, 'version=' + sum.version);
ok('默认没有标注对象', sum.annoMeta && Object.keys(sum.annoMeta).length === 0, JSON.stringify(sum.annoMeta));

let r = lib.setAnnoTags('abc:2:0', ['方法', '待读']);
ok('给标注打标签', r.ok && r.tags.length === 2, JSON.stringify(r));
sum = lib.summary();
ok('标签进了标注对象', ((sum.annoMeta['abc:2:0'] || {}).tags || []).includes('方法'), JSON.stringify(sum.annoMeta));

r = lib.addAnnoTags(['abc:2:0', 'abc:3:1'], ['重要']);
ok('批量加标签', r.updated === 2, JSON.stringify(r));
sum = lib.summary();
ok('标签是累加而不是覆盖', ((sum.annoMeta['abc:2:0'] || {}).tags || []).length === 3
  && ((sum.annoMeta['abc:3:1'] || {}).tags || []).length === 1, JSON.stringify(sum.annoMeta));

r = lib.removeAnnoTag('abc:2:0', '待读');
sum = lib.summary();
ok('移除单个标签', !((sum.annoMeta['abc:2:0'] || {}).tags || []).includes('待读')
  && ((sum.annoMeta['abc:2:0'] || {}).tags || []).includes('方法'), JSON.stringify(sum.annoMeta));

r = lib.setAnnoTags('abc:3:1', []);
sum = lib.summary();
ok('清空标签后标注对象仍在（tags 为空）', !!sum.annoMeta['abc:3:1']
  && (sum.annoMeta['abc:3:1'].tags || []).length === 0, JSON.stringify(sum.annoMeta));

r = lib.setAnnoTags('', ['x']);
ok('空 id 被拒绝', r.ok === false, JSON.stringify(r));

// 落盘后重新读回来还在
const onDisk = JSON.parse(fs.readFileSync(store, 'utf8'));
ok('落盘为 v8 且标注对象带标签', onDisk.version === 8 && onDisk.annoMeta && onDisk.annoMeta['abc:2:0'],
  JSON.stringify(onDisk.annoMeta));

lib.resetCache();
sum = lib.summary();
ok('重开进程后标签还在', ((sum.annoMeta['abc:2:0'] || {}).tags || []).length === 2, JSON.stringify(sum.annoMeta));

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}

console.log('[anno] ' + (fail ? 'FAIL (' + fail + ')' : 'PASS'));
process.exit(fail ? 2 : 0);
