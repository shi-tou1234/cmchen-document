'use strict';
/*
 * 真实 PDF 高亮烧录回归（v11）。真实 Electron：选区 → 高亮 → buildExportPayload → pdf-lib 导出。
 * 断言：导出文件可被 pdfjs 重新打开、页数不变、原文件未改、导出页确实多出高亮填充色。
 * 运行：node scripts/test-export-highlight.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const pdfjs = require('pdfjs-dist/build/pdf.js');
const { runProbe } = require('./probe-runner');

const ROOT = path.join(__dirname, '..');
const SAMPLE = path.join(ROOT, 'assets', 'sample.pdf');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-exporthl-'));
const udd = path.join(tmp, 'ud');
fs.mkdirSync(udd, { recursive: true });
const hash = (p) => crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex');
const beforeHash = hash(SAMPLE);
const beforeSize = fs.statSync(SAMPLE).size;

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  <- ' + detail : '')); }
}
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

(async () => {
  let probeRes = null;
  try {
    const r = await runProbe({
      probe: path.join(__dirname, 'probe-export-highlight.js'),
      env: { PDFREADER_PROBE_PDF: SAMPLE, PDFREADER_DATA_DIR: tmp, PDFREADER_NO_AUTO_INDEX: '1' },
      args: ['--user-data-dir=' + udd],
      label: 'export-highlight',
      timeout: 180000,
    });
    probeRes = r.res;
    if (r.fail) { /* 探针内部失败已打印，继续做文件级断言 */ }
  } catch (e) {
    console.error('[export-highlight] ERROR', e && e.message ? e.message : e);
    process.exit(3);
  }

  const outPath = probeRes && probeRes.outPath;
  ok('导出文件已生成', !!outPath && fs.existsSync(outPath), String(outPath));
  if (outPath && fs.existsSync(outPath)) {
    ok('原 PDF 未被修改', hash(SAMPLE) === beforeHash);
    ok('导出文件比原文件大', fs.statSync(outPath).size > beforeSize, fs.statSync(outPath).size + ' vs ' + beforeSize);

    const data = new Uint8Array(fs.readFileSync(outPath));
    let doc = null;
    try { doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise; } catch (_) {}
    ok('导出 PDF 能被 pdfjs 重新打开', !!doc, doc ? '' : 'open failed');
    if (doc) {
      ok('导出 PDF 页数不变（3）', doc.numPages === 3, 'pages=' + doc.numPages);
      const page = await doc.getPage(1);
      const ops = await page.getOperatorList();
      const fills = [];
      for (let i = 0; i < ops.fnArray.length; i++) {
        if (ops.fnArray[i] === pdfjs.OPS.setFillRGBColor) fills.push(ops.argsArray[i]);
        // 某些版本用 setFillColor + 数组/hex，两种都收
        if (ops.fnArray[i] === pdfjs.OPS.setFillColor) fills.push(ops.argsArray[i]);
      }
      const want = hexToRgb(probeRes.color);
      const near = (a, b) => Math.abs(a - b) < 0.02;
      const hit = want && fills.some((args) => {
        const rgb = Array.isArray(args[0]) ? args[0] : args;
        if (rgb.length < 3) return false;
        // pdfjs 的 setFillRGBColor 参数既可能是 0–1 浮点，也可能是 0–255 整数
        const scale = Math.max(+rgb[0], +rgb[1], +rgb[2]) > 1 ? 255 : 1;
        return near(+rgb[0] / scale, want[0]) && near(+rgb[1] / scale, want[1]) && near(+rgb[2] / scale, want[2]);
      });
      ok('导出页含高亮填充色', !!hit, JSON.stringify({ want, fills: fills.slice(0, 6) }));
      ok('高亮矩形尺寸有效', !!probeRes.rect && probeRes.rect.w > 0 && probeRes.rect.h > 0, JSON.stringify(probeRes.rect));
      await doc.destroy();
    }
  }

  if (probeRes && probeRes.cjk) {
    ok('导出结果带上实际用的字体名（便于排查缺字）', typeof probeRes.cjkFont === 'string' && probeRes.cjkFont.length > 0, probeRes.cjkFont);
  }
  console.log('[export-highlight] ' + (fail ? 'FAIL (' + fail + '/' + (pass + fail) + ')' : 'PASS (' + pass + ')'));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 2 : 0);
})().catch((e) => {
  console.error('[export-highlight] ERROR', e && e.stack ? e.stack : e);
  process.exit(3);
});
