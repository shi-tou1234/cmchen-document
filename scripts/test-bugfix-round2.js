'use strict';
/*
 * 用户反馈修复回归（2026-10-22 第二轮）：
 *   1) 高亮 / 下划线真实点击（select-bar 路径），以及「选区失效时不能静默无反应」
 *   2) 富文档（Word / Markdown）朗读 —— 以前只走 pdfPage，富文档直接失败
 *   3) 空白笔记单击卡片就能进详情（不依赖双击）
 *   4) 搜索框 placeholder 不再被截断
 * 运行：node scripts/test-bugfix-round2.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runProbe } = require('./probe-runner');

const ROOT = path.join(__dirname, '..');
const SAMPLE = path.join(ROOT, 'assets', 'sample.pdf');
const MD = path.join(ROOT, 'README.md');

let code = 0;
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-fix2-'));
  const udd = path.join(tmp, 'ud');
  fs.mkdirSync(udd);
  try {
    const { fail } = runProbe({
      probePath: path.join(__dirname, 'probe-bugfix-round2.js'),
      tmpDir: tmp,
      inject: {
        __SAMPLE__: SAMPLE.replace(/\\/g, '/'),
        __MD__: MD.replace(/\\/g, '/'),
      },
      env: {
        PDFREADER_DATA_DIR: tmp,
        PDFREADER_LIBRARY: path.join(tmp, 'library.json'),
        PDFREADER_NO_AUTO_INDEX: '1',
      },
      args: ['--user-data-dir=' + udd],
      label: 'bugfix-round2',
      timeout: 300000,
    });
    code = fail ? 2 : 0;
  } catch (e) {
    console.error('[bugfix-round2] ERROR', e && e.message ? e.message : e);
    code = 3;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(code);
})();
