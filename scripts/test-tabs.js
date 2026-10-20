'use strict';
/*
 * 多标签页回归（v11）。真实 Electron + 临时库。
 * 覆盖：开标签、切换、恢复页码、关闭、空态回库、切换不丢标注、关闭不删标注/PDF。
 * 运行：node scripts/test-tabs.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runProbe } = require('./probe-runner');

const ROOT = path.join(__dirname, '..');
const SAMPLE = path.join(ROOT, 'assets', 'sample.pdf');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-tabs-'));
const udd = path.join(tmp, 'ud');
fs.mkdirSync(udd);
const copy = path.join(tmp, 'sample-copy.pdf');
fs.copyFileSync(SAMPLE, copy);
const libFile = path.join(tmp, 'library.json');
fs.writeFileSync(libFile, JSON.stringify({
  version: 3,
  collections: [], searches: [],
  items: [
    { key: 'itA', itemType: 'journalArticle', title: 'Alpha', creators: [], year: '2020', tags: [], collectionIds: [], attachment: { path: SAMPLE, name: 'sample.pdf' }, page: 2, created: 2, updated: 2 },
    { key: 'itB', itemType: 'journalArticle', title: 'Beta', creators: [], year: '2022', tags: [], collectionIds: [], attachment: { path: copy, name: 'sample-copy.pdf' }, page: 1, created: 1, updated: 1 },
  ],
}, null, 2));

let code = 0;
try {
  const { fail } = runProbe({
    probe: path.join(__dirname, 'probe-tabs.js'),
    env: { PDFREADER_LIBRARY: libFile, PDFREADER_DATA_DIR: tmp, PDFREADER_NO_AUTO_INDEX: '1' },
    args: ['--user-data-dir=' + udd],
    label: 'tabs',
    timeout: 180000,
  });
  code = fail ? 2 : 0;
} catch (e) {
  console.error('[tabs] ERROR', e && e.message ? e.message : e);
  code = 3;
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
}
process.exit(code);
