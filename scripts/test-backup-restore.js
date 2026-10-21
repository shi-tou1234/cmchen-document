'use strict';
/*
 * 备份 / 恢复端到端回归（v11）。真实 Electron + 临时 userData + 临时数据目录。
 * 覆盖：备份内容、备份后改动、恢复替换库/设置/标注、pre-restore 快照内容、坏备份拒绝。
 * 运行：node scripts/test-backup-restore.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runProbe } = require('./probe-runner');

const ROOT = path.join(__dirname, '..');
const SAMPLE = path.join(ROOT, 'assets', 'sample.pdf');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-backup-'));
const dataDir = path.join(tmp, 'data');
const udd = path.join(tmp, 'ud');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(udd, { recursive: true });
const libFile = path.join(dataDir, 'library.json');
fs.writeFileSync(libFile, JSON.stringify({
  version: 3,
  collections: [{ id: 'col1', name: '论文库', parentId: null }],
  searches: [{ id: 's1', name: '深度学习', query: 'transformer' }],
  items: [
    { key: 'itA', itemType: 'journalArticle', title: 'Alpha', creators: ['张三'], year: '2020', publication: '测试期刊', doi: '10.1000/a', tags: ['ML'], collectionIds: ['col1'], attachment: { path: SAMPLE, name: 'sample.pdf' }, page: 2, created: 2, updated: 2 },
    { key: 'itB', itemType: 'book', title: 'Beta', creators: ['李四'], year: '2022', tags: [], collectionIds: [], attachment: { path: SAMPLE, name: 'sample.pdf' }, page: 0, created: 1, updated: 1 },
  ],
}, null, 2));
// 给“坏备份”用例准备一个合法 JSON 但不是本程序的备份
fs.writeFileSync(path.join(dataDir, 'bad.json'), JSON.stringify({ hello: 'world' }));
// 改名前（Trove 之前叫 PDF Reader）的备份：app 标识是 'pdf-reader'，必须仍能恢复。
// 内容与本次备份保持一致（Alpha/Beta 两条 + BEFORE 标注），恢复后磁盘状态应与恢复新备份完全相同。
const annoName = require('crypto').createHash('sha1').update(path.resolve(SAMPLE)).digest('hex').slice(0, 20) + '.json';
fs.writeFileSync(path.join(dataDir, 'legacy.json'), JSON.stringify({
  app: 'pdf-reader',
  format: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  settings: { theme: 'light' },
  library: {
    version: 3,
    collections: [{ id: 'col1', name: '论文库', parentId: null }],
    searches: [{ id: 's1', name: '深度学习', query: 'transformer' }],
    items: [
      { key: 'itA', itemType: 'journalArticle', title: 'Alpha', creators: ['张三'], year: '2020', publication: '测试期刊', doi: '10.1000/a', tags: ['ML'], collectionIds: ['col1'], attachment: { path: SAMPLE, name: 'sample.pdf' }, page: 2, created: 2, updated: 2 },
      { key: 'itB', itemType: 'book', title: 'Beta', creators: ['李四'], year: '2022', tags: [], collectionIds: [], attachment: { path: SAMPLE, name: 'sample.pdf' }, page: 0, created: 1, updated: 1 },
    ],
  },
  annotations: [
    { name: annoName, data: { path: SAMPLE, saved: Date.now(), pages: [{ page: 1, shapes: [{ tool: 'mark', color: '#ffeb3b', rects: [{ x: 1, y: 2, w: 30, h: 9 }], text: 'BEFORE', comment: '备份前的评论' }] }] } },
  ],
}, null, 2));

let code = 0;
try {
  const { fail, res } = runProbe({
    probe: path.join(__dirname, 'probe-backup.js'),
    env: { PDFREADER_LIBRARY: libFile, PDFREADER_DATA_DIR: dataDir, PDFREADER_NO_AUTO_INDEX: '1' },
    args: ['--user-data-dir=' + udd],
    label: 'backup',
    timeout: 180000,
  });

  let extraFail = 0;
  const extra = (name, ok, detail) => {
    if (!ok) { extraFail++; console.log('  FAIL ' + name + (detail ? '  <- ' + detail : '')); }
    else console.log('  ok   ' + name);
  };
  const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } };

  // 备份文件内容
  const bak = res && res.backupPath ? readJson(res.backupPath) : null;
  extra('备份文件存在', !!bak, String(res && res.backupPath));
  extra('备份含 2 条条目', !!bak && bak.library.items.length === 2, String(bak && bak.library.items.length));
  extra('备份保留收藏集/智能收藏集', !!bak && bak.library.collections.length === 1 && bak.library.searches.length === 1);
  extra('备份记录备份时主题 light', !!bak && bak.settings.theme === 'light', JSON.stringify(bak && bak.settings));
  extra('备份含 1 条标注', !!bak && bak.annotations.length === 1 && JSON.stringify(bak.annotations).indexOf('BEFORE') >= 0, JSON.stringify(bak && bak.annotations).slice(0, 160));

  // 恢复前快照：必须是“改动后”的状态，证明恢复可回滚
  const pre = res && res.preBackup ? readJson(res.preBackup) : null;
  extra('pre-restore 快照存在', !!pre, String(res && res.preBackup));
  extra('快照记录改动后的 3 条', !!pre && pre.library.items.length === 3, String(pre && pre.library.items.length));
  const preA = pre && pre.library.items.find((x) => x.key === 'itA');
  extra('快照保留改动后的标题', !!preA && preA.title === 'CHANGED', preA && preA.title);
  extra('快照保留改动后的主题 dark', !!pre && pre.settings.theme === 'dark', JSON.stringify(pre && pre.settings));
  extra('快照保留改动后的标注 AFTER', !!pre && JSON.stringify(pre.annotations).indexOf('AFTER') >= 0);

  // 恢复后的磁盘状态
  const disk = readJson(libFile);
  extra('磁盘库恢复为 2 条', !!disk && disk.items.length === 2, String(disk && disk.items.length));
  extra('磁盘库标题恢复 Alpha', !!disk && (disk.items.find((x) => x.key === 'itA') || {}).title === 'Alpha');

  const settingsFile = path.join(udd, 'settings.json');
  const st = readJson(settingsFile);
  extra('设置文件主题恢复 light', !!st && st.theme === 'light', JSON.stringify(st));

  const annoDir = path.join(udd, 'annotations');
  let annoText = '';
  try {
    for (const f of fs.readdirSync(annoDir)) annoText += fs.readFileSync(path.join(annoDir, f), 'utf8');
  } catch (_) {}
  extra('标注文件恢复为 BEFORE', annoText.indexOf('BEFORE') >= 0 && annoText.indexOf('AFTER') < 0, annoText.slice(0, 160));

  const failTotal = fail + extraFail;
  console.log('[backup] ' + (failTotal ? 'FAIL (' + failTotal + ')' : 'PASS'));
  code = failTotal ? 2 : 0;
} catch (e) {
  console.error('[backup] ERROR', e && e.message ? e.message : e);
  code = 3;
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
}
process.exit(code);
