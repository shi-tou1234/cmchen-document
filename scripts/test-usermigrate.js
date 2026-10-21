'use strict';
/*
 * 改名搬家回归（PDF Reader → Trove）。纯 Node，临时目录隔离。
 * 覆盖：老目录内容被拷到新目录、只补缺不覆盖、Singleton 锁文件不搬、老目录保留、
 *      老目录不存在时不报错、新旧目录相同时不动、多个历史目录名按顺序取。
 * 运行：node scripts/test-usermigrate.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const { migrateUserData, LEGACY_DIR_NAMES } = require(path.join(__dirname, '..', 'src', 'usermigrate.js'));

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  <- ' + detail : '')); }
}
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-usermigrate-'));
const appData = path.join(root, 'Roaming');

// --- 造一个改名前的老目录 %APPDATA%\pdf-reader ---
const oldDir = path.join(appData, LEGACY_DIR_NAMES[0]);
fs.mkdirSync(path.join(oldDir, 'annotations'), { recursive: true });
fs.writeFileSync(path.join(oldDir, 'settings.json'), JSON.stringify({ theme: 'dark' }));
fs.writeFileSync(path.join(oldDir, 'window-state.json'), JSON.stringify({ width: 1000 }));
fs.writeFileSync(path.join(oldDir, 'annotations', 'abcdef0123456789abcd.json'), JSON.stringify({ pages: [] }));
fs.writeFileSync(path.join(oldDir, 'SingletonLock'), 'lock');
// Chromium 的东西不该被搬
fs.mkdirSync(path.join(oldDir, 'Cache'), { recursive: true });
fs.writeFileSync(path.join(oldDir, 'Cache', 'data_0'), 'junk');
fs.writeFileSync(path.join(oldDir, 'Local State'), 'chrome');
fs.writeFileSync(path.join(oldDir, 'Preferences'), 'chrome');
fs.writeFileSync(path.join(oldDir, 'tmp-123.tmp'), 'tmp');

// 新目录里已经有一个同名文件（必须是"不覆盖"的那一个）
const newDir = path.join(appData, 'trove');
fs.mkdirSync(newDir, { recursive: true });
fs.writeFileSync(path.join(newDir, 'settings.json'), JSON.stringify({ theme: 'light' }));

const r = migrateUserData({ appData, newUserData: newDir });
ok('迁移没报错', r.ok === true, r.error);
ok('报告迁移发生', r.migrated === true, JSON.stringify(r));
ok('认出老目录名 pdf-reader', r.sources.length === 1 && /pdf-reader$/.test(r.sources[0]), JSON.stringify(r.sources));

ok('设置文件没被旧数据覆盖', readJson(path.join(newDir, 'settings.json')).theme === 'light');
ok('已存在的文件被跳过', r.skipped.indexOf('settings.json') >= 0, JSON.stringify(r.skipped));
ok('窗口状态被搬过来', readJson(path.join(newDir, 'window-state.json')).width === 1000);
ok('标注目录被搬过来', fs.existsSync(path.join(newDir, 'annotations', 'abcdef0123456789abcd.json')));
ok('单实例锁文件没搬', !fs.existsSync(path.join(newDir, 'SingletonLock')) && r.copied.indexOf('SingletonLock') < 0, JSON.stringify(r.copied));
ok('Chromium 缓存目录没搬', !fs.existsSync(path.join(newDir, 'Cache')), JSON.stringify(r.copied));
ok('Chromium 的 Local State 没搬', !fs.existsSync(path.join(newDir, 'Local State')));
ok('Chromium 的 Preferences 没搬', !fs.existsSync(path.join(newDir, 'Preferences')));
ok('.tmp 临时文件没搬', !fs.existsSync(path.join(newDir, 'tmp-123.tmp')));

// 老目录必须原样保留（只拷不删）
ok('老目录还在', fs.existsSync(path.join(oldDir, 'settings.json')));
ok('老目录没被搬空', fs.existsSync(path.join(oldDir, 'annotations', 'abcdef0123456789abcd.json')));
ok('老目录的锁文件还在', fs.existsSync(path.join(oldDir, 'SingletonLock')));

// --- 老目录不存在 ---
const fresh = path.join(root, 'fresh');
fs.mkdirSync(fresh, { recursive: true });
const r2 = migrateUserData({ appData: fresh, newUserData: path.join(fresh, 'trove') });
ok('没有老目录时不报错', r2.ok === true, r2.error);
ok('没有老目录时不报迁移', r2.migrated === false);

// --- 新旧目录相同 ---
const r3 = migrateUserData({ appData, newUserData: oldDir });
ok('新旧目录相同时不搬', r3.copied.length === 0, JSON.stringify(r3.copied));

// --- 备用的历史目录名 'PDF Reader' 也能认 ---
const appData2 = path.join(root, 'Roaming2');
const altOld = path.join(appData2, 'PDF Reader');
fs.mkdirSync(altOld, { recursive: true });
fs.writeFileSync(path.join(altOld, 'settings.json'), JSON.stringify({ theme: 'dark' }));
const altNew = path.join(appData2, 'trove');
const r4 = migrateUserData({ appData: appData2, newUserData: altNew });
ok('备用历史目录名也能搬', r4.migrated === true && fs.existsSync(path.join(altNew, 'settings.json')), JSON.stringify(r4));

console.log('[usermigrate] ' + (fail ? 'FAIL (' + fail + ')' : 'PASS (' + pass + ')'));
try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
process.exit(fail ? 2 : 0);
