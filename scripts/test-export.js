'use strict';
// 独立的导出管线验证：不依赖 Electron/浏览器，纯 Node + pdf-lib。
// 验证「把标注烧进 PDF 副本」这条链路真能工作：绘制各类图元 → save → 重新打开校验页数。
const fs = require('fs');
const path = require('path');
const { PDFDocument, rgb, StandardFonts, LineCapStyle } = require('pdf-lib');

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function drawAnno(page, sh, font) {
  const [r, g, b] = hexToRgb(sh.color);
  const color = rgb(r, g, b);
  const t = Math.max(0.5, sh.width || 2);
  const round = { lineCap: LineCapStyle.Round };
  const seg = (a, bp, opts) => page.drawLine(Object.assign({ start: { x: a.x, y: a.y }, end: { x: bp.x, y: bp.y } }, opts));
  if (sh.tool === 'pen') { for (let i = 0; i < sh.pts.length - 1; i++) seg(sh.pts[i], sh.pts[i + 1], { color, thickness: t, ...round }); }
  else if (sh.tool === 'highlight') { for (let i = 0; i < sh.pts.length - 1; i++) seg(sh.pts[i], sh.pts[i + 1], { color, opacity: 0.35, thickness: t, ...round }); }
  else if (sh.tool === 'line') { seg(sh.a, sh.b, { color, thickness: t, ...round }); }
  else if (sh.tool === 'arrow') {
    seg(sh.a, sh.b, { color, thickness: t, ...round });
    const ang = Math.atan2(sh.b.y - sh.a.y, sh.b.x - sh.a.x), len = Math.max(8, t * 3.5), s = Math.PI / 7;
    seg(sh.b, { x: sh.b.x - len * Math.cos(ang - s), y: sh.b.y - len * Math.sin(ang - s) }, { color, thickness: t, ...round });
    seg(sh.b, { x: sh.b.x - len * Math.cos(ang + s), y: sh.b.y - len * Math.sin(ang + s) }, { color, thickness: t, ...round });
  } else if (sh.tool === 'rect') {
    page.drawRectangle({ x: Math.min(sh.a.x, sh.b.x), y: Math.min(sh.a.y, sh.b.y), width: Math.abs(sh.b.x - sh.a.x), height: Math.abs(sh.b.y - sh.a.y), borderColor: color, borderWidth: t, opacity: 0 });
  } else if (sh.tool === 'text') {
    const size = sh.size || 14;
    String(sh.text).split('\n').forEach((ln, i) => {
      page.drawText(ln, { x: sh.at.x, y: sh.at.y - size - i * size * 1.25, size, font, color });
    });
  }
}

async function main() {
  const inPath = path.join(__dirname, '..', 'assets', 'sample.pdf');
  const bytes = fs.readFileSync(inPath);
  const origPages = (await PDFDocument.load(bytes)).getPageCount();

  // 一页放满各类图元（PDF 坐标系，y 向上）
  const shapes = [
    { tool: 'pen', color: '#e53935', width: 3, pts: [{ x: 72, y: 650 }, { x: 150, y: 600 }, { x: 220, y: 650 }] },
    { tool: 'highlight', color: '#ffd54f', width: 16, pts: [{ x: 72, y: 620 }, { x: 300, y: 620 }] },
    { tool: 'line', color: '#1e88e5', width: 2, a: { x: 72, y: 560 }, b: { x: 300, y: 540 } },
    { tool: 'arrow', color: '#1e88e5', width: 2, a: { x: 72, y: 500 }, b: { x: 260, y: 480 } },
    { tool: 'rect', color: '#43a047', width: 2, a: { x: 72, y: 460 }, b: { x: 320, y: 360 } },
    { tool: 'text', color: '#000000', width: 0, size: 18, at: { x: 72, y: 340 }, text: 'annotation copy' + '\n' + 'second line' },
  ];

  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.getPages()[0];
  for (const sh of shapes) drawAnno(page, sh, font);
  const out = Buffer.from(await doc.save());

  const outPath = path.join(__dirname, '..', 'assets', 'sample-annotated.pdf');
  fs.writeFileSync(outPath, out);

  // 重新打开校验
  const re = await PDFDocument.load(out);
  const check = {
    ok: re.getPageCount() === origPages && out.length > bytes.length,
    origPages, outPages: re.getPageCount(),
    origBytes: bytes.length, outBytes: out.length,
    outPath,
  };
  console.log('[test-export] ' + JSON.stringify(check));
  process.exit(check.ok ? 0 : 1);
}

main().catch((e) => { console.error('[test-export] FAIL', e); process.exit(1); });
