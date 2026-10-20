'use strict';
/*
 * v12 界面流程回归：查重弹窗 / 合并 / 详情面板 / 元数据错误提示 / BibTeX 导入导出 IPC。
 * 真实 Electron，临时库隔离；不联网（元数据只测无效标识符分支）。
 * 运行：node scripts/test-ui-v12.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runProbe } = require('./probe-runner');

const ROOT = path.join(__dirname, '..');
const SAMPLE = path.join(ROOT, 'assets', 'sample.pdf');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-v12-'));
const udd = path.join(tmp, 'ud');
fs.mkdirSync(udd);
const copy = path.join(tmp, 'sample-copy.pdf');
fs.copyFileSync(SAMPLE, copy);
const libFile = path.join(tmp, 'library.json');
fs.writeFileSync(libFile, JSON.stringify({
  version: 3,
  collections: [], searches: [],
  items: [
    { key: 'dupA', itemType: 'journalArticle', title: 'Duplicate Paper', creators: ['张三'], year: '2020', doi: 'https://doi.org/10.1000/dup', tags: ['A'], collectionIds: [], attachment: { path: SAMPLE, name: 'sample.pdf' }, page: 2, created: 3, updated: 3 },
    { key: 'dupB', itemType: 'journalArticle', title: 'Duplicate   Paper', creators: [], year: '2020', doi: '10.1000/dup', tags: [], collectionIds: [], attachment: { path: copy, name: 'sample-copy.pdf' }, created: 2, updated: 2 },
    { key: 'uniq', itemType: 'book', title: 'Unique Paper', creators: ['李四'], year: '2021', doi: '10.1000/uniq', tags: [], collectionIds: [], attachment: { path: SAMPLE, name: 'sample.pdf' }, created: 1, updated: 1 },
  ],
}, null, 2));

let code = 0;
try {
  const { fail, res } = runProbe({
    probe: path.join(__dirname, 'probe-ui-v12.js'),
    env: { PDFREADER_LIBRARY: libFile, PDFREADER_DATA_DIR: tmp, PDFREADER_NO_AUTO_INDEX: '1' },
    args: ['--user-data-dir=' + udd],
    label: 'ui-v12',
    timeout: 180000,
  });
  let extraFail = 0;
  const extra = (name, ok, detail) => {
    if (!ok) { extraFail++; console.log('  FAIL ' + name + (detail ? '  <- ' + detail : '')); }
    else console.log('  ok   ' + name);
  };

  const outPath = res && res.outPath;
  extra('导出文件已落盘', !!outPath && fs.existsSync(outPath), String(outPath));
  if (outPath && fs.existsSync(outPath)) {
    const text = fs.readFileSync(outPath, 'utf8');
    extra('导出内容含导入条目', /IPC Imported Paper/.test(text), text.slice(0, 200));
    extra('导出内容含 @article', /@article\{/.test(text));
    extra('导出内容含合并后的条目', /Duplicate Paper/.test(text) || /Duplicate   Paper/.test(text));
  }

  const failTotal = fail + extraFail;
  console.log('[ui-v12] ' + (failTotal ? 'FAIL (' + failTotal + ')' : 'PASS'));
  code = failTotal ? 2 : 0;
} catch (e) {
  console.error('[ui-v12] ERROR', e && e.message ? e.message : e);
  code = 3;
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
}
process.exit(code);
