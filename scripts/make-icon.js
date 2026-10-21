'use strict';
// 从 assets/icon-source.png 生成多尺寸应用图标（256 为 electron-builder 主图标）。
// 源图已经是 scripts/crop-icon.js 裁过白边的成品方形图，这里直接高质量缩放即可。
// 想临时多裁一点就调 CROP_RATIO（1 = 不裁）。
// 运行：& node_modules\electron\dist\electron.exe scripts/make-icon.js --no-sandbox --disable-gpu
const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'assets');
const SOURCE = path.join(DIR, 'icon-source.png');
// 源图已经裁到图标本体，四周只留 1% 余量，所以不再裁（CROP_RATIO = 1）
const CROP_RATIO = 1;
const SIZES = [256, 128, 64, 48, 32, 16];

app.whenReady().then(() => {
  try {
    const src = nativeImage.createFromPath(SOURCE);
    if (src.isEmpty()) throw new Error('无法读取 ' + SOURCE);
    const { width, height } = src.getSize();
    const side = Math.round(Math.min(width, height) * CROP_RATIO);
    const cropped = src.crop({
      x: Math.round((width - side) / 2),
      y: Math.round((height - side) / 2),
      width: side,
      height: side,
    });
    for (const size of SIZES) {
      const img = cropped.resize({ width: size, height: size, quality: 'best' });
      fs.writeFileSync(path.join(DIR, `icon-${size}.png`), img.toPNG());
    }
    console.log(`[make-icon] OK ${width}x${height} -> crop ${side} -> assets/icon-{256..16}.png`);
    app.exit(0);
  } catch (e) {
    console.error('[make-icon] FAIL', e);
    app.exit(1);
  }
});
