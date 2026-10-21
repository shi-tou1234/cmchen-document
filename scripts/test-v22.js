'use strict';
/*
 * v22 回归：单页/连续滚动双模式 / 搜索命中上下跳 / 大纲带页码。
 * 运行：node scripts/test-v22.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runProbe } = require('./probe-runner');

const ROOT = path.join(__dirname, '..');
const SAMPLE = path.join(ROOT, 'assets', 'sample.pdf');

let code = 0;
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-v22-'));
  const udd = path.join(tmp, 'ud');
  fs.mkdirSync(udd);
  const fixture = path.join(tmp, 'sample.pdf');
  fs.copyFileSync(SAMPLE, fixture);
  try {
    const { fail } = runProbe({
      probe: path.join(__dirname, 'probe-v22.js'),
      env: {
        PDFREADER_PROBE_PDF: fixture,
        PDFREADER_DATA_DIR: tmp,
        PDFREADER_LIBRARY: path.join(tmp, 'library.json'),
        PDFREADER_NO_AUTO_INDEX: '1',
      },
      args: ['--user-data-dir=' + udd],
      label: 'v22',
      timeout: 180000,
    });
    code = fail ? 2 : 0;
  } catch (e) {
    console.error('[v22] ERROR', e && e.message ? e.message : e);
    code = 3;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(code);
})();
