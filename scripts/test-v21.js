'use strict';
/*
 * v21 回归：缩放保持位置 / 标签重命名与全局移除 / 导出全部批注。
 * 运行：node scripts/test-v21.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runProbe } = require('./probe-runner');

const ROOT = path.join(__dirname, '..');
const SAMPLE = path.join(ROOT, 'assets', 'sample.pdf');

let code = 0;
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-v21-'));
  const udd = path.join(tmp, 'ud');
  fs.mkdirSync(udd);
  // 用临时目录里的副本当夹具：批注与「导出全部批注」都写在那里，不污染仓库
  const fixture = path.join(tmp, 'sample.pdf');
  fs.copyFileSync(SAMPLE, fixture);
  const libFile = path.join(tmp, 'library.json');
  fs.writeFileSync(libFile, JSON.stringify({
    version: 3, collections: [], searches: [],
    items: [
      { key: 'itA', itemType: 'journalArticle', title: 'Alpha', creators: ['张三'], year: '2020', tags: ['ML', '必读'], collectionIds: [], attachment: { path: fixture, name: 'sample.pdf' }, page: 1, created: 3, updated: 3 },
      { key: 'itB', itemType: 'book', title: 'Beta', creators: ['李四'], year: '2021', tags: ['ML'], collectionIds: [], attachment: { path: fixture, name: 'sample.pdf' }, page: 0, created: 2, updated: 2 },
      { key: 'itC', itemType: 'document', title: 'Gamma', creators: [], year: '', tags: [], collectionIds: [], attachment: { path: fixture, name: 'sample.pdf' }, page: 0, created: 1, updated: 1 },
    ],
  }, null, 2));
  try {
    const { fail } = runProbe({
      probe: path.join(__dirname, 'probe-v21.js'),
      env: {
        PDFREADER_PROBE_PDF: fixture,
        PDFREADER_DATA_DIR: tmp,
        PDFREADER_LIBRARY: libFile,
        PDFREADER_NO_AUTO_INDEX: '1',
      },
      args: ['--user-data-dir=' + udd],
      label: 'v21',
      timeout: 180000,
    });
    code = fail ? 2 : 0;
  } catch (e) {
    console.error('[v21] ERROR', e && e.message ? e.message : e);
    code = 3;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(code);
})();
