'use strict';
/*
 * 模式切换（阅读 ↔ 文献库）回归：复现并锁死用户 2026-10-22 报的三个问题——
 *   1. 文献库切回阅读器时整层回闪（fill:'none' 动画播完弹回 opacity 1）；
 *   2. 从库里打开文档后高亮药丸不跟人走，点「阅读」像没反应；
 *   3. 关掉文档后侧栏缩略图/目录残留上一篇。
 * 运行：node scripts/test-modeswitch.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runProbe } = require('./probe-runner');

const ROOT = path.join(__dirname, '..');
const SAMPLE = path.join(ROOT, 'assets', 'sample.pdf');

let code = 0;
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-modeswitch-'));
  const udd = path.join(tmp, 'ud');
  fs.mkdirSync(udd);
  try {
    const { fail } = runProbe({
      // 渲染进程里没有 process/env，样例路径直接注入探针源码
      probePath: path.join(__dirname, 'probe-modeswitch.js'),
      tmpDir: tmp,
      inject: { __SAMPLE__: SAMPLE.replace(/\\/g, '/') },
      env: {
        PDFREADER_PROBE_LIB_PDF: SAMPLE,
        PDFREADER_DATA_DIR: tmp,
        PDFREADER_LIBRARY: path.join(tmp, 'library.json'),
        PDFREADER_NO_AUTO_INDEX: '1',
      },
      args: ['--user-data-dir=' + udd],
      label: 'modeswitch',
      timeout: 240000,
    });
    code = fail ? 2 : 0;
  } catch (e) {
    console.error('[modeswitch] ERROR', e && e.message ? e.message : e);
    code = 3;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(code);
})();
