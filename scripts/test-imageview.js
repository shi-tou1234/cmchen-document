'use strict';
/*
 * 看图模式回归（v17）：点 PDF 里的内嵌位图 → 灯箱放大看原图。
 * 夹具用 pdf-lib 现造一个带 PNG 图片的 PDF（真实 Electron + 临时 userData）。
 * 运行：node scripts/test-imageview.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runProbe } = require('./probe-runner');
const { PDFDocument } = require('pdf-lib');

const ROOT = path.join(__dirname, '..');
const SAMPLE = path.join(ROOT, 'assets', 'sample.pdf');
const ICON = path.join(ROOT, 'assets', 'icon-256.png');

async function makeFixture(target) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const img = await doc.embedPng(fs.readFileSync(ICON));
  page.drawImage(img, { x: 120, y: 420, width: 240, height: 240 });
  const bytes = await doc.save();
  fs.writeFileSync(target, bytes);
}

let code = 0;
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-imgview-'));
  const udd = path.join(tmp, 'ud');
  fs.mkdirSync(udd);
  const fixture = path.join(tmp, 'with-image.pdf');
  try {
    await makeFixture(fixture);
    const { fail } = runProbe({
      probe: path.join(__dirname, 'probe-imageview.js'),
      env: {
        PDFREADER_PROBE_PDF: fixture,
        PDFREADER_DATA_DIR: tmp,
        PDFREADER_LIBRARY: path.join(tmp, 'library.json'),
        PDFREADER_NO_AUTO_INDEX: '1',
      },
      args: ['--user-data-dir=' + udd],
      label: 'imageview',
      timeout: 180000,
    });
    code = fail ? 2 : 0;
  } catch (e) {
    console.error('[imageview] ERROR', e && e.message ? e.message : e);
    code = 3;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(code);
})();
