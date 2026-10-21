'use strict';
/*
 * 看图模式放大后的「肉眼验收」：造一张 5000×3000 的大图 PDF，在灯箱里放大到
 * 400%，抓一帧存到 build/lbzoom-shot.png，用来肉眼确认「放大后不会变白」。
 *
 * 跑法：
 *   node scripts/make-bigpng.js build\big.png 5000 3000
 *   node scripts/shot-lbzoom.js
 *
 * 关键：PDFREADER_PROBE_VISIBLE=1 —— 隐藏窗口不重绘，靠截图只能看到旧帧，
 * 布局类的改动必须开可见窗口才验得准。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runProbe } = require('./probe-runner');
const { PDFDocument } = require('pdf-lib');

const ROOT = path.join(__dirname, '..');
const BIG = path.join(ROOT, 'build', 'big.png');

async function makeFixture(target) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  if (fs.existsSync(BIG)) {
    const p = await doc.embedPng(fs.readFileSync(BIG));
    page.drawImage(p, { x: 20, y: 300, width: 555, height: 333 });
  } else {
    const jpg = JPG_CANDIDATES.find((f) => fs.existsSync(f));
    if (!jpg) throw new Error('找不到测试用图片');
    const j = await doc.embedJpg(fs.readFileSync(jpg));
    page.drawImage(j, { x: 60, y: 300, width: 470, height: 470 });
  }
  const bytes = await doc.save();
  fs.writeFileSync(target, bytes);
}

let code = 0;
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-lbzoom-'));
  const udd = path.join(tmp, 'ud');
  fs.mkdirSync(udd);
  const fixture = path.join(tmp, 'photo.pdf');
  try {
    await makeFixture(fixture);
    const shot = path.join(tmp, 'shot.png');
    const { fail, res } = runProbe({
      probe: path.join(__dirname, 'probe-lbzoom.js'),
      env: {
        PDFREADER_PROBE_PDF: fixture,
        PDFREADER_DATA_DIR: tmp,
        PDFREADER_LIBRARY: path.join(tmp, 'library.json'),
        PDFREADER_NO_AUTO_INDEX: '1',
        PDFREADER_PROBE_SHOT: shot,
        PDFREADER_PROBE_VISIBLE: '1',
      },
      args: ['--user-data-dir=' + udd],
      label: 'lbzoom',
      timeout: 180000,
    });
    console.log('--- info ---');
    console.log(JSON.stringify(res && res.info, null, 2));
    if (fs.existsSync(shot)) {
      const dst = path.join(ROOT, 'build', 'lbzoom-shot.png');
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(shot, dst);
      console.log('shot: ' + dst);
    }
  } catch (e) {
    console.error('[lbzoom] ERROR', e && e.message ? e.message : e);
    code = 3;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(code);
})();
