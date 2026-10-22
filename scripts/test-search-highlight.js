'use strict';
/*
 * 检索闭环回归（2026-10-22）：从文献库全文结果点进来，页面上自动高亮关键词并跳到首个命中。
 * 运行：node scripts/test-search-highlight.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runProbe } = require('./probe-runner');

const ROOT = path.join(__dirname, '..');
const SAMPLE = path.join(ROOT, 'assets', 'sample.pdf');

let code = 0;
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-shl-'));
  const udd = path.join(tmp, 'ud');
  fs.mkdirSync(udd);
  try {
    const { fail } = runProbe({
      probePath: path.join(__dirname, 'probe-search-highlight.js'),
      tmpDir: tmp,
      inject: { __SAMPLE__: SAMPLE.replace(/\\/g, '/') },
      env: {
        PDFREADER_DATA_DIR: tmp,
        PDFREADER_LIBRARY: path.join(tmp, 'library.json'),
      },
      args: ['--user-data-dir=' + udd],
      label: 'search-highlight',
      timeout: 300000,
    });
    code = fail ? 2 : 0;
  } catch (e) {
    console.error('[search-highlight] ERROR', e && e.message ? e.message : e);
    code = 3;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(code);
})();
