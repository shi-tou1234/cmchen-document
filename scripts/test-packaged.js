'use strict';
/*
 * 打包产物冒烟：在 build/win-unpacked/PDF Reader.exe 上跑真实探针。
 * 覆盖：渲染、主进程全文索引（asar 里的 pdfjs-dist）、库级搜索、导出带标注副本。
 * 运行：node scripts/test-packaged.js
 *      node scripts/test-packaged.js <可执行文件路径>
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const pdfjs = require('pdfjs-dist/build/pdf.js');

const ROOT = path.join(__dirname, '..');
const SAMPLE = path.join(ROOT, 'assets', 'sample.pdf');
const EXE = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'build', 'win-unpacked', 'PDF Reader.exe');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-packaged-'));
const udd = path.join(tmp, 'ud');
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(udd, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
const libFile = path.join(dataDir, 'library.json');
fs.writeFileSync(libFile, JSON.stringify({
  version: 3, collections: [], searches: [],
  items: [{
    key: 'pkg1', itemType: 'journalArticle', title: 'Packaged Smoke', creators: [], year: '2024',
    tags: [], collectionIds: [], attachment: { path: SAMPLE, name: 'sample.pdf' }, page: 0, created: 1, updated: 1,
  }],
}, null, 2));
const outJson = path.join(tmp, 'probe-out.json');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  <- ' + detail : '')); }
}

(async () => {
  ok('打包产物存在', fs.existsSync(EXE), EXE);
  if (!fs.existsSync(EXE)) { console.log('[packaged] FAIL'); process.exit(2); }

  const env = Object.assign({}, process.env, {
    PDFREADER_PROBE: path.join(__dirname, 'probe-packaged.js'),
    PDFREADER_PROBE_PDF: SAMPLE,
    PDFREADER_PROBE_OUT: outJson,
    PDFREADER_LIBRARY: libFile,
    PDFREADER_DATA_DIR: dataDir,
    PDFREADER_NO_AUTO_INDEX: '1',
  });
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(EXE, ['--no-sandbox', '--disable-gpu', '--user-data-dir=' + udd], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => { stdout += String(d); });
  child.stderr.on('data', (d) => { stderr += String(d); });

  const exit = await new Promise((resolve) => {
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} resolve({ timeout: true }); }, 120000);
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });

  let res = null;
  try { res = JSON.parse(fs.readFileSync(outJson, 'utf8')); } catch (_) {}
  if (!res) {
    const line = stdout.split(/\r?\n/).find((l) => l.includes('[probe-result]'));
    if (line) { try { res = JSON.parse(line.slice(line.indexOf('{'))); } catch (_) {} }
  }
  ok('探针在打包产物中运行完成', !!res, JSON.stringify(exit) + '\nSTDOUT:\n' + stdout.slice(-800) + '\nSTDERR:\n' + stderr.slice(-800));
  if (!res) { console.log('[packaged] FAIL'); process.exit(2); }
  ok('探针没有抛错', !res.fatal, res.fatal);

  for (const [name, okFlag, detail] of res.checks || []) {
    if (!okFlag) { fail++; console.log('  FAIL ' + name + (detail ? '  <- ' + detail : '')); }
    else { pass++; console.log('  ok   ' + name); }
  }
  ok('运行的是 asar 打包版本', res.asar === true, String(res.asar));

  // 文件级验证：导出的 PDF 可重新打开、页数不变
  const outPath = res.outPath;
  ok('打包后导出文件已落盘', !!outPath && fs.existsSync(outPath), String(outPath));
  if (outPath && fs.existsSync(outPath)) {
    const data = new Uint8Array(fs.readFileSync(outPath));
    let doc = null;
    try { doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise; } catch (_) {}
    ok('打包导出的 PDF 能被重新打开', !!doc);
    if (doc) {
      ok('打包导出 PDF 页数不变', doc.numPages === 3, 'pages=' + doc.numPages);
      const page = await doc.getPage(1);
      const ops = await page.getOperatorList();
      const fills = [];
      for (let i = 0; i < ops.fnArray.length; i++) {
        if (ops.fnArray[i] === pdfjs.OPS.setFillRGBColor || ops.fnArray[i] === pdfjs.OPS.setFillColor) fills.push(ops.argsArray[i]);
      }
      const want = [1, 235 / 255, 59 / 255]; // 探针里写入的 #ffeb3b
      const hit = fills.some((args) => {
        const rgb = Array.isArray(args[0]) ? args[0] : args;
        if (!rgb || rgb.length < 3) return false;
        const scale = Math.max(+rgb[0], +rgb[1], +rgb[2]) > 1 ? 255 : 1;
        return want.every((v, i) => Math.abs(+rgb[i] / scale - v) < 0.02);
      });
      ok('打包导出的 PDF 含高亮填充', hit, JSON.stringify(fills.slice(0, 4)));
      await doc.destroy();
    }
  }

  console.log('[packaged] ' + (fail ? 'FAIL (' + fail + '/' + (pass + fail) + ')' : 'PASS (' + pass + ')'));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 2 : 0);
})().catch((e) => {
  console.error('[packaged] ERROR', e && e.stack ? e.stack : e);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  process.exit(3);
});
