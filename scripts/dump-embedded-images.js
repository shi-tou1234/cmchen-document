'use strict';
/*
 * 证据脚本：把 PDF 里存储的内嵌位图原样导出（不渲染、不加任何底色/滤镜），
 * 看它本身的底色 —— 回答「灯箱发白是不是处理出来的」。
 * 运行：node scripts/dump-embedded-images.js <pdf路径> <输出目录>
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PDF = process.argv[2];
const OUT = process.argv[3] || path.join(__dirname, '..', '.workbuddy-tmp');

// ---- 最小 PNG 编码器（RGB / 灰度→RGB），纯 Node 无依赖 ----
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
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
function writePNG(file, w, h, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8bit, truecolor
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, png);
}

// 1bpp 掩码/灰度 → RGB（按 pdf.js 的语义：0=黑 1=白，_decode 拍平）
function grayToRgb(w, h, bytes) {
  const rgb = Buffer.alloc(w * h * 3, 255);
  const rowBytes = (w + 7) >> 3;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const bit = (bytes[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
      const v = bit ? 255 : 0;
      const o = (y * w + x) * 3;
      rgb[o] = rgb[o + 1] = rgb[o + 2] = v;
    }
  }
  return rgb;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(PDF)), disableFontFace: true, isEvalSupported: false }).promise;
  console.log('pages=' + doc.numPages);

  for (let pno = 1; pno <= doc.numPages; pno++) {
    const page = await doc.getPage(pno);
    let opList;
    try { opList = await page.getOperatorList(); } catch (e) { continue; }
    const OPS = pdfjs.OPS;
    const fn = opList.fnArray, args = opList.argsArray;
    const seen = new Set();
    for (let i = 0; i < fn.length; i++) {
      let objId = null;
      if (fn[i] === OPS.paintImageXObject) objId = args[i][0];
      else if (fn[i] === OPS.paintJpegXObject) objId = args[i][0];
      if (objId == null || seen.has(objId)) continue;
      seen.add(objId);
      const obj = await new Promise((res) => {
        let done = false;
        const fin = (o) => { if (!done) { done = true; res(o || null); } };
        try { const o = page.objs.get(objId, fin); if (o) fin(o); } catch (_) { fin(null); }
        setTimeout(() => fin(null), 4000);
      });
      if (!obj) { console.log(`p${pno} ${objId}: 对象拿不到（可能未解码）`); continue; }
      const w = obj.width || 0, h = obj.height || 0;
      if (!w || !h || !obj.data || !obj.data.length) { console.log(`p${pno} ${objId}: w=${w} h=${h} kind=${obj.kind} 无数据`); continue; }
      const tag = `p${pno}_${String(objId).replace(/[^a-zA-Z0-9]/g, '_')}`;
      let file = null, note = '';
      let sum = 0, n = 0;   // 亮度累计（RGBA 在合成白底后统计）
      if (obj.kind === 1) { // GRAYSCALE_1BPP
        writePNG(path.join(OUT, tag + '.png'), w, h, grayToRgb(w, h, obj.data));
        file = tag + '.png';
      } else if (obj.kind === 2 && obj.data.length === w * h * 3) { // RGB_24BPP
        writePNG(path.join(OUT, tag + '.png'), w, h, Buffer.from(obj.data.buffer, obj.data.byteOffset, obj.data.length));
        file = tag + '.png';
      } else if (obj.kind === 3 && obj.data.length === w * h * 4) { // RGBA_32BPP
        const rgb = Buffer.alloc(w * h * 3);
        const d = Buffer.from(obj.data.buffer, obj.data.byteOffset, obj.data.length);
        let opaque = 0;
        for (let k = 0; k < w * h; k++) {
          const a = d[k * 4 + 3] / 255;
          if (a > 0.5) opaque++;
          // 合成到白底（模拟页面上的纸），保留可见内容
          for (let c = 0; c < 3; c++) rgb[k * 3 + c] = Math.round(d[k * 4 + c] * a + 255 * (1 - a));
        }
        writePNG(path.join(OUT, tag + '.png'), w, h, rgb);
        file = tag + '.png';
        note = '（RGBA 合成到白底，不透明像素 ' + (100 * opaque / (w * h)).toFixed(1) + '%）';
        // 亮度改按「合成到白底后」算，才有意义
        sum = 0; n = w * h;
        for (let k = 0; k < w * h; k++) sum += 0.299 * rgb[k * 3] + 0.587 * rgb[k * 3 + 1] + 0.114 * rgb[k * 3 + 2];
      } else if (obj.kind === 2 || obj.kind === 1) {
        fs.writeFileSync(path.join(OUT, tag + '.jpg'), Buffer.from(obj.data.buffer, obj.data.byteOffset, obj.data.length));
        file = tag + '.jpg'; note = '（JPEG 字节原样落盘）';
      } else {
        fs.writeFileSync(path.join(OUT, tag + `_kind${obj.kind}.bin`), Buffer.from(obj.data.buffer, obj.data.byteOffset, Math.min(obj.data.length, 2e6)));
        console.log(`p${pno} ${objId}: 未知 kind=${obj.kind}，前 2MB 落盘`);
        continue;
      }
      // 亮度统计
      if (file.endsWith('.png')) {
        const buf = fs.readFileSync(path.join(OUT, file));
        // 粗略统计：直接重算（避免再解 PNG）——用原数据
        const d = obj.data;
        if (obj.kind === 2) { for (let k = 0; k < d.length; k += 3) { sum += 0.299 * d[k] + 0.587 * d[k + 1] + 0.114 * d[k + 2]; n++; } }
        else if (obj.kind === 3) { /* RGBA 已在上面按合成白底统计过 */ }
        else if (obj.kind === 1) { for (let k = 0; k < d.length; k++) { sum += d[k] ? 255 : 0; n++; } }
      } else { n = 0; }
      console.log(`p${pno} ${objId}: ${w}x${h} kind=${obj.kind} 平均亮度=${n ? (sum / n).toFixed(1) : '(JPEG 不算)'} /255 -> ${file}${note}`);
    }
    page.cleanup();
  }
  console.log('输出目录: ' + OUT);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
