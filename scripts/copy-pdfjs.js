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

// katex：笔记公式渲染。只拷运行需要的 css + UMD js + woff2 字体（现代浏览器通用格式，
// ttf/woff 不带），布局与 node_modules/katex/dist 保持一致，katex.min.css 里的
// url(fonts/...) 相对引用原样可用。
const katexDist = path.join(root, 'node_modules', 'katex', 'dist');
const katexDest = path.join(root, 'src', 'renderer', 'katex');
const katexFiles = ['katex.min.css', 'katex.min.js'];
const katexFonts = fs.readdirSync(path.join(katexDist, 'fonts')).filter((f) => f.endsWith('.woff2'));

fs.mkdirSync(path.join(katexDest, 'fonts'), { recursive: true });
for (const f of katexFiles) {
  const s = path.join(katexDist, f);
  if (!fs.existsSync(s)) {
    console.error('[copy-pdfjs] 缺少 katex 文件：' + s + '（请先 npm install）');
    process.exit(1);
  }
  fs.copyFileSync(s, path.join(katexDest, f));
  console.log('[copy-pdfjs] katex/' + f);
}
for (const f of katexFonts) {
  fs.copyFileSync(path.join(katexDist, 'fonts', f), path.join(katexDest, 'fonts', f));
}
console.log(`[copy-pdfjs] katex/fonts ${katexFonts.length} 个 woff2`);
console.log('[copy-pdfjs] 完成 -> src/renderer/katex/');
