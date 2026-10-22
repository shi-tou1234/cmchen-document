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
ok('v6 库升到 v7', sum.version === 7, 'version=' + sum.version);
ok('默认没有标注标签', sum.annoTags && Object.keys(sum.annoTags).length === 0, JSON.stringify(sum.annoTags));

let r = lib.setAnnoTags('abc:2:0', ['方法', '待读']);
ok('给标注打标签', r.ok && r.tags.length === 2, JSON.stringify(r));
sum = lib.summary();
ok('标签进了库数据', (sum.annoTags['abc:2:0'] || []).includes('方法'), JSON.stringify(sum.annoTags));

r = lib.addAnnoTags(['abc:2:0', 'abc:3:1'], ['重要']);
ok('批量加标签', r.updated === 2, JSON.stringify(r));
sum = lib.summary();
ok('标签是累加而不是覆盖', (sum.annoTags['abc:2:0'] || []).length === 3
  && (sum.annoTags['abc:3:1'] || []).length === 1, JSON.stringify(sum.annoTags));

r = lib.removeAnnoTag('abc:2:0', '待读');
sum = lib.summary();
ok('移除单个标签', !(sum.annoTags['abc:2:0'] || []).includes('待读')
  && (sum.annoTags['abc:2:0'] || []).includes('方法'), JSON.stringify(sum.annoTags));

r = lib.setAnnoTags('abc:3:1', []);
sum = lib.summary();
ok('清空标签会删掉这一条', !sum.annoTags['abc:3:1'], JSON.stringify(sum.annoTags));

r = lib.setAnnoTags('', ['x']);
ok('空 id 被拒绝', r.ok === false, JSON.stringify(r));

// 落盘后重新读回来还在
const onDisk = JSON.parse(fs.readFileSync(store, 'utf8'));
ok('落盘为 v7 且带 annoTags', onDisk.version === 7 && onDisk.annoTags && onDisk.annoTags['abc:2:0'],
  JSON.stringify(onDisk.annoTags));

lib.resetCache();
sum = lib.summary();
ok('重开进程后标签还在', (sum.annoTags['abc:2:0'] || []).length === 2, JSON.stringify(sum.annoTags));

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}

console.log('[anno] ' + (fail ? 'FAIL (' + fail + ')' : 'PASS'));
process.exit(fail ? 2 : 0);
