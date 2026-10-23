'use strict';
/*
 * 放大模式回归：真实 Electron 里 Z 进入 / 滚轮连续缩放 / 空格拖动平移 / 退出。
 * 运行：node scripts/test-zoom-mode.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runProbe } = require('./probe-runner');

const ROOT = path.join(__dirname, '..');
const SAMPLE = path.join(ROOT, 'assets', 'sample.pdf');

let code = 0;
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-zoom-'));
  const udd = path.join(tmp, 'ud');
  fs.mkdirSync(udd);
  try {
    const { fail } = runProbe({
      probe: path.join(__dirname, 'probe-zoom-mode.js'),
      env: {
        PDFREADER_PROBE_PDF: SAMPLE,
        PDFREADER_DATA_DIR: tmp,
        PDFREADER_NO_AUTO_INDEX: '1',
      },
      args: ['--user-data-dir=' + udd],
      label: 'zoom-mode',
      timeout: 180000,
    });
    code = fail ? 2 : 0;
  } catch (e) {
    console.error('[loupe] ERROR', e && e.message ? e.message : e);
    code = 3;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(code);
})();
