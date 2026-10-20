'use strict';
// 把 assets/icon-{16..256}.png 打包成一个多尺寸 icon.ico（PNG 条目，Win Vista+ 均支持）。
const fs = require('fs');
const path = require('path');

const sizes = [256, 128, 64, 48, 32, 16];
const dir = path.join(__dirname, '..', 'assets');
const images = sizes.map((s) => fs.readFileSync(path.join(dir, `icon-${s}.png`)));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(sizes.length, 4);

const entries = [];
let offset = 6 + 16 * sizes.length;
sizes.forEach((s, i) => {
  const e = Buffer.alloc(16);
  e.writeUInt8(s === 256 ? 0 : s, 0);
  e.writeUInt8(s === 256 ? 0 : s, 1);
  e.writeUInt8(0, 2);  // colors
  e.writeUInt8(0, 3);  // reserved
  e.writeUInt16LE(1, 4);  // planes
  e.writeUInt16LE(32, 6); // bitcount
  e.writeUInt32LE(images[i].length, 8);
  e.writeUInt32LE(offset, 12);
  offset += images[i].length;
  entries.push(e);
});

const out = Buffer.concat([header, ...entries, ...images]);
const outPath = path.join(dir, 'icon.ico');
fs.writeFileSync(outPath, out);
console.log(`[make-ico] ${outPath} (${out.length} bytes, ${sizes.length} sizes)`);
