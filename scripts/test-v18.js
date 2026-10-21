'use strict';
/*
 * v18 回归：工具带常驻 + 工具快捷键 + 导入读 PDF 元数据 + 文档快速切换。
 * 夹具用 pdf-lib 现造一个带 Title/Author 元数据的 PDF（真实 Electron + 临时 userData）。
 * 运行：node scripts/test-v18.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runProbe } = require('./probe-runner');
const { PDFDocument } = require('pdf-lib');

const ROOT = path.join(__dirname, '..');
const SAMPLE = path.join(ROOT, 'assets', 'sample.pdf');

async function makeFixture(target) {
  const doc = await PDFDocument.load(fs.readFileSync(SAMPLE));
  doc.setTitle('自动识别的标题');
  doc.setAuthor('张三, 李四');
  doc.setSubject('测试夹具');
  fs.writeFileSync(target, await doc.save());
}

let code = 0;
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-v18-'));
  const udd = path.join(tmp, 'ud');
  fs.mkdirSync(udd);
  const fixture = path.join(tmp, 'meta.pdf');
  try {
    await makeFixture(fixture);
    const { fail } = runProbe({
      probe: path.join(__dirname, 'probe-v18.js'),
      env: {
        PDFREADER_PROBE_PDF: fixture,
        PDFREADER_DATA_DIR: tmp,
        PDFREADER_LIBRARY: path.join(tmp, 'library.json'),
        PDFREADER_NO_AUTO_INDEX: '1',
      },
      args: ['--user-data-dir=' + udd],
      label: 'v18',
      timeout: 180000,
    });
    code = fail ? 2 : 0;
  } catch (e) {
    console.error('[v18] ERROR', e && e.message ? e.message : e);
    code = 3;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(code);
})();
