'use strict';
/*
 * 数据目录切换端到端回归（v11）：move / merge / replace 三条路径。
 * 每个模式用独立临时目录跑一次真实 Electron，跑完直接读磁盘上的 library.json 校验。
 * 运行：node scripts/test-datadir.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runProbe } = require('./probe-runner');

const ROOT = path.join(__dirname, '..');
const SAMPLE = path.join(ROOT, 'assets', 'sample.pdf');
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-datadir-'));

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  <- ' + detail : '')); }
}
function item(key, title, path_) {
  return { key, itemType: 'journalArticle', title, creators: [], year: '2020', tags: [], collectionIds: [], attachment: { path: path_, name: path.basename(path_) }, page: 0, created: 1, updated: 1 };
}
function seed(dir, store) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify(store, null, 2));
}
function readLib(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'library.json'), 'utf8')); } catch (_) { return null; }
}

function runMode(mode) {
  const root = path.join(BASE, mode);
  // 初始数据目录 = Electron userData（--user-data-dir），不能再用 PDFREADER_DATA_DIR，
  // 否则 currentDataDir() 会被环境变量钉死，切换目录看起来“没生效”。
  const dataA = path.join(root, 'dataA-' + mode);
  const dataB = path.join(root, 'dataB');
  const udd = dataA;
  fs.mkdirSync(udd, { recursive: true });
  seed(dataA, {
    version: 3,
    collections: [{ id: 'colA', name: 'A 集合', parentId: null }],
    searches: [{ id: 'sA', name: 'A 搜索', query: 'alpha' }],
    items: [item('itA', 'Alpha', SAMPLE), item('itB', 'Beta', SAMPLE)],
  });
  if (mode === 'merge' || mode === 'replace') {
    seed(dataB, {
      version: 3,
      collections: [{ id: 'colB', name: 'B 集合', parentId: null }],
      searches: [{ id: 'sB', name: 'B 搜索', query: 'gamma' }],
      items: [item(mode === 'merge' ? 'itC' : 'itR', mode === 'merge' ? 'Gamma' : 'Replacement', SAMPLE)],
    });
  }

  console.log('  -- ' + mode + ' --');
  const { fail: probeFail, res } = runProbe({
    probe: path.join(__dirname, 'probe-datadir.js'),
    env: { PDFREADER_NO_AUTO_INDEX: '1' },
    args: ['--user-data-dir=' + udd],
    label: 'datadir-' + mode,
    timeout: 180000,
  });

  const libB = readLib(dataB);
  const backupDirA = path.join(dataA, 'backups');
  const backupsA = fs.existsSync(backupDirA) ? fs.readdirSync(backupDirA).filter((f) => /^library-pre-move-/.test(f)) : [];

  if (mode === 'move') {
    ok('move: 空目标得到 2 条', !!libB && libB.items.length === 2, String(libB && libB.items.length));
    ok('move: 条目 key 一致', !!libB && ['itA', 'itB'].every((k) => libB.items.some((x) => x.key === k)), JSON.stringify(libB && libB.items.map((x) => x.key)));
    ok('move: 原目录文件保留（不破坏）', fs.existsSync(path.join(dataA, 'library.json')));
    ok('move: 集合/搜索一起迁移', !!libB && libB.collections.length === 1 && libB.searches.length === 1);
  } else if (mode === 'merge') {
    ok('merge: 目标变成 3 条', !!libB && libB.items.length === 3, String(libB && libB.items.length));
    ok('merge: 两边条目都在', !!libB && ['itA', 'itB', 'itC'].every((k) => libB.items.some((x) => x.key === k)), JSON.stringify(libB && libB.items.map((x) => x.key)));
    ok('merge: 集合合并', !!libB && ['colA', 'colB'].every((k) => libB.collections.some((c) => c.id === k)), JSON.stringify(libB && libB.collections.map((c) => c.id)));
    ok('merge: 智能收藏集合并', !!libB && ['sA', 'sB'].every((k) => libB.searches.some((s) => s.id === k)), JSON.stringify(libB && libB.searches.map((s) => s.id)));
  } else {
    ok('replace: 目标只剩自己的 1 条', !!libB && libB.items.length === 1 && libB.items[0].key === 'itR', JSON.stringify(libB && libB.items.map((x) => x.key)));
    ok('replace: 目标集合不被旧库污染', !!libB && libB.collections.length === 1 && libB.collections[0].id === 'colB', JSON.stringify(libB && libB.collections.map((c) => c.id)));
  }
  ok('切换前当前库已自动备份（' + mode + '）', backupsA.length >= 1, JSON.stringify(backupsA));
  const settingsFile = path.join(udd, 'settings.json');
  let st = null;
  try { st = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch (_) {}
  ok('设置文件记录新目录', !!st && st.dataDir === dataB, JSON.stringify(st && st.dataDir));
  ok('探针报告切换成功', probeFail === 0 && res && res.after >= 1, String(probeFail));
}

try {
  for (const mode of ['move', 'merge', 'replace']) runMode(mode);
  console.log('[datadir] ' + (fail ? 'FAIL (' + fail + '/' + (pass + fail) + ')' : 'PASS (' + pass + ')'));
  process.exitCode = fail ? 2 : 0;
} catch (e) {
  console.error('[datadir] ERROR', e && e.message ? e.message : e);
  process.exitCode = 3;
} finally {
  try { fs.rmSync(BASE, { recursive: true, force: true }); } catch (_) {}
}
