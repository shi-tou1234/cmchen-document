'use strict';
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const SAMPLE = path.join(ROOT, 'assets', 'sample.pdf');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tabs-'));
const udd = path.join(tmp, 'ud'); fs.mkdirSync(udd);
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
const env = Object.assign({}, process.env, {
  PDFREADER_PROBE: path.join(ROOT, 'scripts', '_tabsprobe.js'),
  PDFREADER_LIBRARY: libFile,
  PDFREADER_DATA_DIR: tmp,
  PDFREADER_NO_AUTO_INDEX: '1',
});
delete env.ELECTRON_RUN_AS_NODE;
const out = execFileSync(ELECTRON, ['.', '--no-sandbox', '--disable-gpu', '--user-data-dir=' + udd], { cwd: ROOT, env, encoding: 'utf8', timeout: 180000 });
console.log(out);
fs.rmSync(tmp, { recursive: true, force: true });
