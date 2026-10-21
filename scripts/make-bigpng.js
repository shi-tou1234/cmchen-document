'use strict';
/*
 * 生成一张大尺寸 PNG（纯 Node，无第三方依赖）：用来造「大图」夹具。
 * 用法：node scripts/make-bigpng.js out.png 5000 3000
 */
const fs = require('fs');
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

// 画一张有颜色层次的图（便于肉眼判断是否变白/变形）
function encodePNG(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let p = 0;
  for (let y = 0; y < h; y++) {
    raw[p++] = 0;                       // filter: none
    for (let x = 0; x < w; x++) {
      raw[p++] = (x * 255 / w) | 0;              // R 渐变
      raw[p++] = (y * 255 / h) | 0;              // G 渐变
      raw[p++] = ((x + y) % 512 < 256) ? 220 : 40; // B 棋盘
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 2;    // color type: truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 1 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = process.argv[2] || 'big.png';
const w = +(process.argv[3] || 5000);
const h = +(process.argv[4] || 3000);
if (require.main === module) {
  fs.writeFileSync(out, encodePNG(w, h));
  console.log('written ' + out + ' (' + w + 'x' + h + ', ' + fs.statSync(out).size + ' bytes)');
}
module.exports = { encodePNG, crc32, chunk };
