// 把 pdfjs-dist 的 UMD 构建文件拷贝到渲染进程目录，保证应用自包含、可离线、便于打包。
// pdfjs-dist@3.11.x 在 build/ 下提供 pdf.min.js(UMD, 全局 pdfjsLib) 与 pdf.worker.min.js。
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const srcDir = path.join(root, 'node_modules', 'pdfjs-dist', 'build');
const destDir = path.join(root, 'src', 'renderer', 'pdfjs');

const files = [
  ['pdf.min.js', 'pdf.min.js'],
  ['pdf.worker.min.js', 'pdf.worker.min.js'],
];

fs.mkdirSync(destDir, { recursive: true });
for (const [from, to] of files) {
  const s = path.join(srcDir, from);
  const d = path.join(destDir, to);
  if (!fs.existsSync(s)) {
    console.error('[copy-pdfjs] 缺少源文件：' + s + '（请先 npm install）');
    process.exit(1);
  }
  fs.copyFileSync(s, d);
  const size = fs.statSync(d).size;
  console.log(`[copy-pdfjs] ${to}  (${(size / 1024).toFixed(0)} KB)`);
}
console.log('[copy-pdfjs] 完成 -> src/renderer/pdfjs/');
