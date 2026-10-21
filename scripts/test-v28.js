'use strict';
/*
 * v28 回归（2026-10-21 第三轮扩充）：
 *   1) 阅读模式绝不弹灯箱（异步打开带代号，切换模式后旧请求作废）；
 *   2) 看图模式点内嵌位图 → 灯箱；点空白不弹（toast 提示）；
 *   3) 灯箱反色默认跟随「深色反色页面」，◐ 按钮一键切回原色；
 *   4) 关闭按钮两条路径（✕ 图标 / 按钮本体）都能关；
 *   5) 右键菜单同款「放大看这一块」任何模式可用；
 *   6) 重叠多层图（白板导出的 底色层+笔迹层）自动合成一张，不再拆成 图1/图2。
 *
 * 夹具：第 1 页单张 icon（走原图像素直出）；第 2 页两张同矩形叠加（底色 PNG + 透明笔迹
 * PNG，pdf-lib 画在同一矩形）——合成后应看到 红方块叠在蓝底上。
 * 运行：node scripts/test-v28.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { runProbe } = require('./probe-runner');
const { PDFDocument } = require('pdf-lib');

const ROOT = path.join(__dirname, '..');
const ICON = path.join(ROOT, 'assets', 'icon-256.png');

// ---- 最小 PNG 编码器（真彩 RGB/RGBA），纯 Node ----
function crc32(buf) {
  let table = crc32.t;
  if (!table) {
    table = crc32.t = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c; }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
// pixelFn(x, y) -> Buffer（rgb 3 字节或 rgba 4 字节）
function makePNG(w, h, isRgba, file, pixelFn) {
  const bpp = isRgba ? 4 : 3;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = isRgba ? 6 : 2;   // 8bit；6=RGBA 2=RGB
  const raw = Buffer.alloc((w * bpp + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * bpp + 1)] = 0;   // filter: none
    for (let x = 0; x < w; x++) {
      pixelFn(x, y).copy(raw, y * (w * bpp + 1) + 1 + x * bpp, 0, bpp);
    }
  }
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

async function makeFixture(target) {
  // 第 2 页用的两层图：底色（纯蓝）+ 透明笔迹（中央红方块）
  const bgPng = path.join(os.tmpdir(), 'lb-bg-' + Date.now() + '.png');
  const inkPng = path.join(os.tmpdir(), 'lb-ink-' + Date.now() + '.png');
  makePNG(100, 100, false, bgPng, (x, y) => {
    const b = Buffer.alloc(3); b[0] = 42; b[1] = 77; b[2] = 143; return b;   // #2a4d8f
  });
  makePNG(100, 100, true, inkPng, (x, y) => {
    const b = Buffer.alloc(4);
    if (x >= 30 && x <= 70 && y >= 30 && y <= 70) { b[0] = 230; b[1] = 40; b[2] = 40; b[3] = 255; }
    return b;   // 透明底 + 中央红方块
  });

  const doc = await PDFDocument.create();
  const page1 = doc.addPage([595, 842]);
  const icon = await doc.embedPng(fs.readFileSync(ICON));
  page1.drawImage(icon, { x: 120, y: 420, width: 240, height: 240 });
  const page2 = doc.addPage([595, 842]);
  const bg = await doc.embedPng(fs.readFileSync(bgPng));
  const ink = await doc.embedPng(fs.readFileSync(inkPng));
  // 同一矩形叠两层：先底色后笔迹（白板导出的典型层序）
  page2.drawImage(bg, { x: 150, y: 300, width: 250, height: 250 });
  page2.drawImage(ink, { x: 150, y: 300, width: 250, height: 250 });
  fs.writeFileSync(target, await doc.save());
  try { fs.unlinkSync(bgPng); fs.unlinkSync(inkPng); } catch (_) {}
}

let code = 0;
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-v28-'));
  const udd = path.join(tmp, 'ud');
  fs.mkdirSync(udd);
  const fixture = path.join(tmp, 'fixture.pdf');
  try {
    await makeFixture(fixture);
    const { fail } = runProbe({
      probe: path.join(__dirname, 'probe-v28.js'),
      env: {
        PDFREADER_PROBE_PDF: fixture,
        PDFREADER_DATA_DIR: tmp,
        PDFREADER_LIBRARY: path.join(tmp, 'library.json'),
        PDFREADER_NO_AUTO_INDEX: '1',
      },
      args: ['--user-data-dir=' + udd],
      label: 'v28',
      timeout: 240000,
    });
    code = fail ? 2 : 0;
  } catch (e) {
    console.error('[v28] ERROR', e && e.message ? e.message : e);
    code = 3;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(code);
})();
