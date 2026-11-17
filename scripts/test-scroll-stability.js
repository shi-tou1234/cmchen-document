'use strict';
/*
 * 阅读位置稳定性回归：侧栏开合 / 缩放 / 专注模式 / 分屏 / 旋转 / 阅读区宽度突变之后，
 * 正在读的那一行必须还在原处。
 *
 * 用的是「带真实 pdf.js + 真实布局」的渲染进程，所以不用 mock：直接量像素。
 * 运行：node scripts/test-scroll-stability.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runProbe } = require('./probe-runner');

const ROOT = path.join(__dirname, '..');
const PAGES = 6;
const FIXTURE = path.join(os.tmpdir(), 'trove-scroll-stability-' + PAGES + '.pdf');

async function makePdf() {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < PAGES; i++) {
    const page = doc.addPage([595, 842]);
    page.drawText('Page ' + (i + 1) + ' / ' + PAGES, { x: 50, y: 780, size: 20, font });
    for (let l = 0; l < 28; l++) {
      page.drawText('Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.', {
        x: 50, y: 730 - l * 23, size: 11, font, color: rgb(0.15, 0.15, 0.15),
      });
    }
  }
  fs.writeFileSync(FIXTURE, Buffer.from(await doc.save()));
}

let code = 0;
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-scroll-stab-'));
  const udd = path.join(tmp, 'ud');
  fs.mkdirSync(udd);
  try {
    await makePdf();
    const { fail } = runProbe({
      probe: path.join(__dirname, 'probe-scroll-stability.js'),
      env: {
        PDFREADER_PROBE_PDF: FIXTURE,
        PDFREADER_DATA_DIR: tmp,
        PDFREADER_NO_AUTO_INDEX: '1',
      },
      args: ['--user-data-dir=' + udd],
      label: 'scroll-stability',
      timeout: 240000,
    });
    code = fail ? 2 : 0;
  } catch (e) {
    console.error('[scroll-stability] ERROR', e && e.message ? e.message : e);
    code = 3;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(code);
})();
