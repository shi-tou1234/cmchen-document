'use strict';
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const SAMPLE = path.join(ROOT, 'assets', 'sample.pdf');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v11-'));
const libFile = path.join(tmp, 'library.json');
const udd = path.join(tmp, 'ud'); fs.mkdirSync(udd);
fs.writeFileSync(libFile, JSON.stringify({
  version: 3,
  collections: [{ id: 'col1', name: '论文库', parentId: null }],
  searches: [],
  items: [
    { key: 'itA', itemType: 'journalArticle', title: 'Alpha', creators: ['张三'], year: '2020', publication: '测试期刊', doi: '10.1000/a', tags: [], collectionIds: ['col1'], attachment: { path: SAMPLE, name: 'sample.pdf' }, page: 2, created: 2, updated: 2 },
    { key: 'itB', itemType: 'journalArticle', title: 'Beta', creators: ['李四'], year: '2022', publication: '测试期刊', doi: '10.1000/b', tags: [], collectionIds: [], attachment: { path: SAMPLE, name: 'sample.pdf' }, created: 1, updated: 1 },
  ],
}, null, 2));
const env = Object.assign({}, process.env, {
  PDFREADER_PROBE: path.join(ROOT, 'scripts', '_v11probe.js'),
  PDFREADER_LIBRARY: libFile,
  PDFREADER_DATA_DIR: tmp,
  PDFREADER_NO_AUTO_INDEX: '1',
});
delete env.ELECTRON_RUN_AS_NODE;
const out = execFileSync(ELECTRON, ['.', '--no-sandbox', '--disable-gpu', '--user-data-dir=' + udd], { cwd: ROOT, env, encoding: 'utf8', timeout: 180000 });
console.log(out);
fs.rmSync(tmp, { recursive: true, force: true });
