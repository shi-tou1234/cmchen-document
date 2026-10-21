'use strict';
/*
 * v25 回归：看图模式放大后「变白」。
 *
 * 原因：预览用的是「原图尺寸的 canvas + CSS transform: scale()」。
 * 大图（比如 3000×2000 的插图）放大后，合成层要的纹理 = 位图 × 缩放倍数，
 * 很容易超过显卡 / 软件渲染器的纹理上限 —— 一旦分配失败，整块画布不画，
 * 元素只剩 CSS 背景色，看着就是「双击放大以后变白」。
 *
 * 现在缩放改成「按当前显示分辨率重绘位图（上限 = 原图像素），CSS 只做平移」，
 * 合成纹理尺寸恒定受控。本脚本验证：
 *   - 画布位图永远不超过原图像素；
 *   - CSS 变换里不再出现 scale()；
 *   - 放大时位图跟着变清晰，显示尺寸确实变大；
 *   - 缩回后仍受控。
 *
 * 运行：node scripts/test-v25.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runProbe } = require('./probe-runner');
const { PDFDocument } = require('pdf-lib');
const { encodePNG } = require('./make-bigpng');

const ROOT = path.join(__dirname, '..');
const BIG_W = 3000;
const BIG_H = 2000;

async function makeFixture(target) {
  // 造一张大图（纯 Node 生成 PNG，无第三方依赖）
  const png = encodePNG(BIG_W, BIG_H);
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const img = await doc.embedPng(png);
  page.drawImage(img, { x: 20, y: 300, width: 555, height: 370 });
  const bytes = await doc.save();
  fs.writeFileSync(target, bytes);
}

let code = 0;
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-v25-'));
  const udd = path.join(tmp, 'ud');
  fs.mkdirSync(udd);
  const fixture = path.join(tmp, 'big-image.pdf');
  try {
    await makeFixture(fixture);
    const { fail } = runProbe({
      probe: path.join(__dirname, 'probe-v25.js'),
      env: {
        PDFREADER_PROBE_PDF: fixture,
        PDFREADER_DATA_DIR: tmp,
        PDFREADER_LIBRARY: path.join(tmp, 'library.json'),
        PDFREADER_NO_AUTO_INDEX: '1',
      },
      args: ['--user-data-dir=' + udd],
      label: 'v25',
      timeout: 240000,
    });
    code = fail ? 2 : 0;
  } catch (e) {
    console.error('[v25] ERROR', e && e.message ? e.message : e);
    code = 3;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(code);
})();
