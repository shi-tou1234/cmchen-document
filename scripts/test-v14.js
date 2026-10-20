'use strict';
/*
 * v14 新功能回归：标签选择器 / 复制引用 / 批注导出多格式。
 * 真实 Electron + 临时 userData + 临时库，不碰真实数据。
 * 运行：node scripts/test-v14.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runProbe } = require('./probe-runner');

const ROOT = path.join(__dirname, '..');
const SAMPLE = path.join(ROOT, 'assets', 'sample.pdf');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-v14-'));
const udd = path.join(tmp, 'ud');
fs.mkdirSync(udd);
const libFile = path.join(tmp, 'library.json');
fs.writeFileSync(libFile, JSON.stringify({
  version: 3,
  collections: [{ id: 'col1', name: '论文库', parentId: null }],
  searches: [],
  items: [
    { key: 'itA', itemType: 'journalArticle', title: 'Alpha', creators: ['张三', '李四'], year: '2020', publication: '测试期刊', volume: '43', issue: '2', pages: '100-110', doi: '10.1000/a', tags: ['ML', '重要'], collectionIds: ['col1'], attachment: { path: SAMPLE, name: 'sample.pdf' }, page: 1, created: 2, updated: 2 },
    { key: 'itB', itemType: 'book', title: 'Beta', creators: ['王五'], year: '2021', publication: '某出版社', tags: ['ML'], collectionIds: [], attachment: { path: SAMPLE, name: 'sample.pdf' }, page: 0, created: 1, updated: 1 },
    { key: 'itC', itemType: 'document', title: 'Gamma', creators: [], year: '', tags: ['待读'], collectionIds: [], attachment: { path: SAMPLE, name: 'sample.pdf' }, page: 0, created: 3, updated: 3 },
  ],
}, null, 2));

let code = 0;
try {
  const { fail } = runProbe({
    probe: path.join(__dirname, 'probe-v14.js'),
    env: { PDFREADER_LIBRARY: libFile, PDFREADER_DATA_DIR: tmp, PDFREADER_NO_AUTO_INDEX: '1' },
    args: ['--user-data-dir=' + udd],
    label: 'v14',
    timeout: 180000,
  });
  code = fail ? 2 : 0;
} catch (e) {
  console.error('[v14] ERROR', e && e.message ? e.message : e);
  code = 3;
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
}
process.exit(code);
