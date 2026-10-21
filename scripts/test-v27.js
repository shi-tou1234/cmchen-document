'use strict';
/*
 * v27 回归：
 *   1) 看图模式（灯箱）里的图是「原样」—— v28 起用户明确要求灯箱不做任何处理，
 *      v27 原来断言的「灯箱跟随页面反色」已按用户要求回退（见 test-v28.js）；
 *   2) 灯箱预览的底色是纸白（图里有透明区域时露出纸，不是灯箱的深底）；
 *   3) 便签保存后能点开再改（之前点哪儿都是开一个空编辑器，保存过的便签再也点不开）。
 *
 * 运行：node scripts/test-v27.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runProbe } = require('./probe-runner');
const { PDFDocument } = require('pdf-lib');

const ROOT = path.join(__dirname, '..');
const ICON = path.join(ROOT, 'assets', 'icon-256.png');

// 夹具：现造一个带内嵌 PNG 的 PDF（灯箱断言需要点真实位图，sample.pdf 没有图）
async function makeFixture(target) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const img = await doc.embedPng(fs.readFileSync(ICON));
  page.drawImage(img, { x: 120, y: 420, width: 240, height: 240 });
  fs.writeFileSync(target, await doc.save());
}

let code = 0;
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-v27-'));
  const udd = path.join(tmp, 'ud');
  fs.mkdirSync(udd);
  const fixture = path.join(tmp, 'with-image.pdf');
  try {
    await makeFixture(fixture);
    const { fail } = runProbe({
      probe: path.join(__dirname, 'probe-v27.js'),
      env: {
        PDFREADER_PROBE_PDF: fixture,
        PDFREADER_DATA_DIR: tmp,
        PDFREADER_LIBRARY: path.join(tmp, 'library.json'),
        PDFREADER_NO_AUTO_INDEX: '1',
      },
      args: ['--user-data-dir=' + udd],
      label: 'v27',
      timeout: 240000,
    });
    code = fail ? 2 : 0;
  } catch (e) {
    console.error('[v27] ERROR', e && e.message ? e.message : e);
    code = 3;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(code);
})();
