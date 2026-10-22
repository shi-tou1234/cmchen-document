'use strict';
/*
 * 抓取 PDF 全文的 UI 回归：按钮存在、没有标识时给提示、设置里能存联系邮箱。
 * 真实下载由 test-fetchpdf.js（本地服务）覆盖，这里不碰外网。
 * 运行：node scripts/test-fetch-pdf-ui.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runProbe } = require('./probe-runner');

const ROOT = path.join(__dirname, '..');
const SAMPLE = path.join(ROOT, 'assets', 'sample.pdf');

let code = 0;
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-fetchui-'));
  const udd = path.join(tmp, 'ud');
  fs.mkdirSync(udd);
  try {
    const { fail } = runProbe({
      probePath: path.join(__dirname, 'probe-fetch-pdf-ui.js'),
      tmpDir: tmp,
      inject: { __SAMPLE__: SAMPLE.replace(/\\/g, '/') },
      env: {
        PDFREADER_DATA_DIR: tmp,
        PDFREADER_LIBRARY: path.join(tmp, 'library.json'),
        PDFREADER_NO_AUTO_INDEX: '1',
      },
      args: ['--user-data-dir=' + udd],
      label: 'fetch-pdf-ui',
      timeout: 240000,
    });
    code = fail ? 2 : 0;
  } catch (e) {
    console.error('[fetch-pdf-ui] ERROR', e && e.message ? e.message : e);
    code = 3;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(code);
})();
