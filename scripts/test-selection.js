'use strict';
/*
 * 文字选区高亮 + 评论回归（v11）。真实 Electron：preload + 文本层 + selection.js + renderer.js。
 * 覆盖：文本层可选中、浮动工具条、矩形坐标、SVG 渲染、评论、侧栏列表、标注文件、导出 payload、笔记文本。
 * 运行：node scripts/test-selection.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runProbe } = require('./probe-runner');

const SAMPLE = path.join(__dirname, '..', 'assets', 'sample.pdf');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-sel-'));
const udd = path.join(tmp, 'ud');
fs.mkdirSync(udd);

let code = 0;
try {
  const { fail } = runProbe({
    probe: path.join(__dirname, 'probe-selection.js'),
    env: { PDFREADER_PROBE_PDF: SAMPLE, PDFREADER_DATA_DIR: tmp },
    args: ['--user-data-dir=' + udd],
    label: 'selection',
    timeout: 180000,
  });
  code = fail ? 2 : 0;
} catch (e) {
  console.error('[selection] ERROR', e && e.message ? e.message : e);
  code = 3;
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
}
process.exit(code);
