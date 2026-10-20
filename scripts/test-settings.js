'use strict';
/*
 * 设置模块回归（v11）。纯 Node，临时目录隔离。
 * 覆盖：默认值、白名单清洗、持久化、BOM、损坏备份、未知字段、残留临时文件。
 * 运行：node scripts/test-settings.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const settings = require(path.join(__dirname, '..', 'src', 'settings.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-settings-'));
const file = path.join(tmp, 'settings.json');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  <- ' + detail : '')); }
}

// 全新目录 → 默认值
settings.init(tmp);
settings.resetCache();
let s = settings.get();
ok('默认排序 added', s.defaultSort === 'added', s.defaultSort);
ok('默认主题 light', s.theme === 'light', s.theme);
ok('默认自动索引开启', s.autoIndex === true);
ok('默认 dataDir 为空', s.dataDir === '');
ok('默认不恢复标签', s.restoreTabs === false);
ok('读默认值不落盘', !fs.existsSync(file));

// 写入 + 持久化
const w = settings.set({ theme: 'dark', defaultSort: 'title' });
ok('set 返回 ok', w.ok === true, JSON.stringify(w));
ok('set 写入文件', fs.existsSync(file));
settings.resetCache();
s = settings.get();
ok('重载后主题仍是 dark', s.theme === 'dark', s.theme);
ok('重载后排序仍是 title', s.defaultSort === 'title', s.defaultSort);

// 白名单清洗：非法值回落默认，未知字段不写入
settings.set({ theme: 'neon', defaultSort: 'random', autoIndex: 'yes', restoreTabs: 1, hacked: 'x' });
s = settings.get();
ok('非法主题回落 light', s.theme === 'light', s.theme);
ok('非法排序回落 added', s.defaultSort === 'added', s.defaultSort);
ok('非布尔 autoIndex 回落 true', s.autoIndex === true, String(s.autoIndex));
ok('非布尔 restoreTabs 回落 false', s.restoreTabs === false, String(s.restoreTabs));
ok('未知字段不写入', !('hacked' in JSON.parse(fs.readFileSync(file, 'utf8'))), fs.readFileSync(file, 'utf8'));

// dataDir 去空白
settings.set({ dataDir: '  D:\\Docs\\Library  ' });
ok('dataDir 去首尾空白', settings.get().dataDir === 'D:\\Docs\\Library', JSON.stringify(settings.get().dataDir));
settings.set({ dataDir: '' });

// 写盘不留 .tmp
settings.set({ theme: 'dark' });
const strays = fs.readdirSync(tmp).filter((f) => /\.tmp$/.test(f));
ok('写盘后没有残留 .tmp', strays.length === 0, JSON.stringify(strays));

// BOM 容忍
fs.writeFileSync(file, '\uFEFF' + JSON.stringify({ theme: 'dark', defaultSort: 'year' }));
settings.resetCache();
s = settings.get();
ok('带 BOM 的设置能读取', s.theme === 'dark' && s.defaultSort === 'year', JSON.stringify(s));

// 损坏文件：留证 + 回落默认，不抛错
fs.writeFileSync(file, '{ not json ]');
settings.resetCache();
let crashed = false;
try { s = settings.get(); } catch (_) { crashed = true; }
ok('损坏设置不抛错', !crashed);
ok('损坏后回落默认', s.theme === 'light' && s.defaultSort === 'added', JSON.stringify(s));
const corrupts = fs.readdirSync(tmp).filter((f) => /^settings\.json\.corrupt-/.test(f));
ok('损坏文件留证备份', corrupts.length >= 1, JSON.stringify(corrupts));

// 文件缺失也回落默认
fs.rmSync(file, { force: true });
settings.resetCache();
ok('文件缺失回落默认', settings.get().theme === 'light');

// 清理
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}

console.log('[settings] ' + (fail ? 'FAIL (' + fail + '/' + (pass + fail) + ')' : 'PASS (' + pass + ')'));
process.exit(fail ? 2 : 0);
