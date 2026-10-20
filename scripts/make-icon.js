'use strict';
// 从 assets/icon-source.png 生成多尺寸应用图标（256 为 electron-builder 主图标）。
// 源图是 1254×1254 的成品图，四周留白较多；先按中心裁成方形，再高质量缩放，
// 这样 16px 任务栏图标不会因为白边太多而显得又小又糊。
// 运行：& node_modules\electron\dist\electron.exe scripts/make-icon.js --no-sandbox --disable-gpu
const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'assets');
const SOURCE = path.join(DIR, 'icon-source.png');
// 裁掉源图外围约 7% 的白边；remain 86.1% 是目测后能完整包住圆角主体的比例
const CROP_RATIO = 0.861;
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
