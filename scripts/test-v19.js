'use strict';
/*
 * v19 回归：界面减负（首次提示 / 工具分组 / 库里分区折叠）+ 引用样式扩充
 * + 批注搜索与标签。
 * 运行：node scripts/test-v19.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runProbe } = require('./probe-runner');

const ROOT = path.join(__dirname, '..');
const SAMPLE = path.join(ROOT, 'assets', 'sample.pdf');

let code = 0;
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-v19-'));
  const udd = path.join(tmp, 'ud');
  fs.mkdirSync(udd);
  const libFile = path.join(tmp, 'library.json');
  fs.writeFileSync(libFile, JSON.stringify({
    version: 3, collections: [], searches: [],
    items: [
      { key: 'itA', itemType: 'journalArticle', title: 'Attention Is All You Need', creators: ['Ashish Vaswani', 'Noam Shazeer'], year: '2017', publication: 'NeurIPS', volume: '30', issue: '2', pages: '5998-6008', doi: '10.1000/attn', tags: ['必读'], collectionIds: [], attachment: { path: SAMPLE, name: 'sample.pdf' }, page: 1, created: 2, updated: 2 },
    ],
  }, null, 2));
  try {
    const { fail } = runProbe({
      probe: path.join(__dirname, 'probe-v19.js'),
      env: {
        PDFREADER_PROBE_PDF: SAMPLE,
        PDFREADER_DATA_DIR: tmp,
        PDFREADER_LIBRARY: libFile,
        PDFREADER_NO_AUTO_INDEX: '1',
      },
      args: ['--user-data-dir=' + udd],
      label: 'v19',
      timeout: 180000,
    });
    code = fail ? 2 : 0;
  } catch (e) {
    console.error('[v19] ERROR', e && e.message ? e.message : e);
    code = 3;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(code);
})();
