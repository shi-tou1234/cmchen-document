'use strict';
/*
 * v23 回归：独立阅读笔记（数据层 v4 + v3 迁移 + 增删改）。
 * 纯 Node，不启 Electron。
 * 运行：node scripts/test-v23.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  <- ' + detail : '')); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-v23-'));
const libFile = path.join(tmp, 'library.json');
process.env.PDFREADER_LIBRARY = libFile;

// ---------- v3 旧库：单条 note 字段要自动搬成第一条笔记 ----------
fs.writeFileSync(libFile, JSON.stringify({
  version: 3,
  collections: [],
  searches: [],
  items: [
    { key: 'old1', itemType: 'journalArticle', title: '旧条目', creators: ['张三'], year: '2020',
      note: '这是旧库里的单条笔记', tags: [], collectionIds: [], created: 100, updated: 200 },
    { key: 'old2', itemType: 'book', title: '没有笔记的条目', creators: [], year: '',
      tags: [], collectionIds: [], created: 1, updated: 2 },
  ],
}, null, 2));

const lib = require(path.join(__dirname, '..', 'src', 'library.js'));
lib.init();
lib.resetCache();

let sum = lib.summary();
ok('库版本升到 v5', sum.version === 5, 'version=' + sum.version);
const old1 = sum.items.find((x) => x.key === 'old1');
ok('v3 的 note 字段搬成第一条笔记', !!(old1.notes && old1.notes.length === 1 && old1.notes[0].text === '这是旧库里的单条笔记'),
  JSON.stringify(old1.notes));
ok('搬过来的笔记有 id', !!(old1.notes[0].id && old1.notes[0].id.length >= 4), JSON.stringify(old1.notes[0]));
const old2 = sum.items.find((x) => x.key === 'old2');
ok('没有 note 的条目笔记为空', Array.isArray(old2.notes) && old2.notes.length === 0, JSON.stringify(old2.notes));
ok('迁移后落盘为 v5', (() => {
  const raw = JSON.parse(fs.readFileSync(libFile, 'utf8'));
  return raw.version === 5 && raw.items.find((x) => x.key === 'old1').notes.length === 1;
})(), fs.readFileSync(libFile, 'utf8').slice(0, 80));
ok('迁移前留了备份', (() => {
  const dir = path.join(tmp, 'backups');
  return fs.existsSync(dir) && fs.readdirSync(dir).some((f) => /pre-v3/.test(f));
})(), fs.existsSync(path.join(tmp, 'backups')) ? fs.readdirSync(path.join(tmp, 'backups')).join(',') : 'no backups dir');

// ---------- 增 / 改 / 删 ----------
const n1 = lib.addNote('old1', { title: '第一章', text: '第一段想法' });
ok('能新建笔记', !!(n1 && n1.id && n1.text === '第一段想法'), JSON.stringify(n1));
const n2 = lib.addNote('old1', { title: '第二章', text: '第二段想法' });
ok('一条文献能挂多条笔记', lib.findItem('old1').notes.length === 3, 'n=' + lib.findItem('old1').notes.length);
ok('笔记 id 不重复', n1.id !== n2.id, n1.id + '/' + n2.id);

const upd = lib.updateNote('old1', n1.id, { text: '改过的想法', title: '第一章（改）' });
ok('能改笔记', !!(upd && upd.text === '改过的想法' && upd.title === '第一章（改）'), JSON.stringify(upd));
ok('改完落盘', (() => {
  const raw = JSON.parse(fs.readFileSync(libFile, 'utf8'));
  const it = raw.items.find((x) => x.key === 'old1');
  const hit = it.notes.find((x) => x.id === n1.id);
  return hit && hit.text === '改过的想法';
})());
ok('改不存在的笔记返回 null', lib.updateNote('old1', 'nope', { text: 'x' }) === null);

ok('能删笔记', lib.removeNote('old1', n2.id) === true);
ok('删完少一条', lib.findItem('old1').notes.length === 2, 'n=' + lib.findItem('old1').notes.length);
ok('删不存在的笔记返回 false', lib.removeNote('old1', 'nope') === false);
ok('删的是别人的笔记不生效', lib.removeNote('old1', n1.id) === true && lib.findItem('old1').notes.length === 1);

// ---------- 对外接口 ----------
sum = lib.summary();
const it1 = sum.items.find((x) => x.key === 'old1');
ok('summary 带出 notes 数组', Array.isArray(it1.notes) && it1.notes.length === 1, JSON.stringify(it1.notes));
ok('note 字段等于剩下的笔记内容', it1.note === it1.notes[0].text, JSON.stringify(it1.note));
lib.addNote('old1', { title: '', text: '第二条' });
const s2 = lib.summary();
const it2 = s2.items.find((x) => x.key === 'old1');
ok('note 字段按段落拼接多条笔记', it2.note.split('\n\n').length === 2 && it2.note.indexOf('第二条') >= 0,
  JSON.stringify(it2.note));
ok('给不存在的条目加笔记返回 null', lib.addNote('nokey', { text: 'x' }) === null);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('[v23] ' + (fail ? 'FAIL (' + fail + '/' + (pass + fail) + ')' : 'PASS (' + pass + ')'));
process.exit(fail ? 2 : 0);
