'use strict';
/*
 * 按父条目元数据重命名附件回归（2026-10-22 报告「组织」缺口）：
 * 文件真的改名、attachment 更新、标注文件与全文索引随迁、文件名冲突自动加序号。
 * 运行：node scripts/test-rename-file.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runProbe } = require('./probe-runner');

const ROOT = path.join(__dirname, '..');
const SAMPLE = path.join(ROOT, 'assets', 'sample.pdf');

let code = 0;
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-rename-'));
  const udd = path.join(tmp, 'ud');
  fs.mkdirSync(udd);
  // 两份源文件：一份会被改名，一份用来制造同名冲突
  const src1 = path.join(tmp, 'raw-a.pdf');
  const src2 = path.join(tmp, 'raw-b.pdf');
  fs.copyFileSync(SAMPLE, src1);
  fs.copyFileSync(SAMPLE, src2);
  try {
    const { fail } = runProbe({
      probePath: path.join(__dirname, 'probe-rename-file.js'),
      tmpDir: tmp,
      inject: {
        __PDF1__: src1.replace(/\\/g, '/'),
        __PDF2__: src2.replace(/\\/g, '/'),
        __DIR__: tmp.replace(/\\/g, '/'),
      },
      env: {
        PDFREADER_DATA_DIR: tmp,
        PDFREADER_LIBRARY: path.join(tmp, 'library.json'),
        PDFREADER_NO_AUTO_INDEX: '1',
      },
      args: ['--user-data-dir=' + udd],
      label: 'rename-file',
      timeout: 300000,
    });
    code = fail ? 2 : 0;
  } catch (e) {
    console.error('[rename-file] ERROR', e && e.message ? e.message : e);
    code = 3;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(code);
})();
