'use strict';
/*
 * 抠图：把图标源图周围多余的留白（含柔和投影）裁掉，只保留中间那个圆角图标本体。
 *
 * 全部在 Electron 主进程里用 nativeImage 完成（不开窗口、不跑 canvas），
 * 因此不会出现「图片加载超时 / executeJavaScript 挂住」那一类问题。
 *
 * 做法：把图读成 BGRA 位图逐像素扫描，找出「明显不是白底」的外接框，再裁成正方形，
 * 缩放到统一尺寸输出。阈值太低会把投影和压缩噪点算进来，太高会切到图标本身的浅色边，
 * 默认 18 对这张浅蓝底图标比较稳。
 *
 * 运行：& node_modules\electron\dist\electron.exe scripts/crop-icon.js <输入.png> <输出.png> --no-sandbox --disable-gpu
 */
const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const IN = path.resolve(args[0] || path.join(__dirname, '..', 'assets', '_new-icon-src.png'));
const OUT = path.resolve(args[1] || path.join(__dirname, '..', 'assets', 'icon-source.png'));
const SIZE = Number(process.env.CROP_SIZE || 1024);   // 输出方形边长
const THRESHOLD = Number(process.env.CROP_THRESHOLD || 18);
const PAD_RATIO = Number(process.env.CROP_PAD || 0.012);  // 裁完再留一点余量，别把圆角切掉

function bboxOf(buf, w, h, t) {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const off = 255 - Math.min(buf[i], buf[i + 1], buf[i + 2]); // BGRA，三通道一样取 min
      if (off <= t) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  return { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

app.whenReady().then(() => {
  try {
    const img = nativeImage.createFromPath(IN);
    if (img.isEmpty()) throw new Error('图片读不出来: ' + IN);
    const { width: w, height: h } = img.getSize();
    const buf = img.toBitmap();

    const probes = [6, 10, 14, 18, 24, 32, 48].map((t) => ({ t, box: bboxOf(buf, w, h, t) }));
    for (const p of probes) console.log(`[crop-icon] threshold ${p.t}:`, JSON.stringify(p.box));

    const b = bboxOf(buf, w, h, THRESHOLD);
    if (!b) throw new Error('整张图都是白的');

    // 以内容外接框为准裁成正方形，再按 PAD_RATIO 往外放一点
    const side = Math.round(Math.max(b.w, b.h) * (1 + PAD_RATIO * 2));
    const cx = b.x0 + b.w / 2;
    const cy = b.y0 + b.h / 2;
    let sx = Math.round(cx - side / 2);
    let sy = Math.round(cy - side / 2);
    let ss = side;
    if (sx < 0) { ss += sx * 2; sx = 0; }
    if (sy < 0) { ss += sy * 2; sy = 0; }
    ss = Math.min(ss, w, h);
    if (sx + ss > w) sx = w - ss;
    if (sy + ss > h) sy = h - ss;

    const cropped = img.crop({ x: sx, y: sy, width: ss, height: ss });
    const out = cropped.resize({ width: SIZE, height: SIZE, quality: 'best' });
    fs.writeFileSync(OUT, out.toPNG());

    console.log('[crop-icon] 源图', JSON.stringify({ w, h }));
    console.log('[crop-icon] 裁剪区域', JSON.stringify({ x: sx, y: sy, side: ss }), '->', OUT,
      (fs.statSync(OUT).size / 1024).toFixed(0) + ' KB');
    app.exit(0);
  } catch (e) {
    console.error('[crop-icon] FAIL', (e && e.message) || e);
    app.exit(1);
  }
});
