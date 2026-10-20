'use strict';
/*
 * 阅读器新能力端到端驱动：两次启动真实 app（隔离 userData）。
 * run1 跑 reader-check.js（文本层/搜索/高亮/侧栏/便签/自动保存），
 * run2 跑 reader-check-restore.js（同一 userData 内断言标注从磁盘恢复）。
 * 运行：node scripts/test-reader-plus.js
 */
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const SAMPLE = path.join(ROOT, 'assets', 'sample.pdf');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rdplus-'));
const udd = path.join(tmp, 'ud');
fs.mkdirSync(udd);

function run(label, probeFile) {
  const env = Object.assign({}, process.env, {
    PDFREADER_PROBE: path.join(ROOT, 'scripts', probeFile),
    PDFREADER_PROBE_PDF: SAMPLE,
  });
  delete env.ELECTRON_RUN_AS_NODE;
  const out = execFileSync(ELECTRON, ['.', '--no-sandbox', '--disable-gpu', '--user-data-dir=' + udd],
    { cwd: ROOT, env, encoding: 'utf8', timeout: 180000 });
  const text = String(out);
  const line = text.split(/\r?\n/).find((l) => l.includes('[probe-result]'));
  if (!line) throw new Error(label + ': no [probe-result]\n' + text.slice(-600));
  return JSON.parse(line.slice(line.indexOf('{')));
}

let fail = 0, total = 0;
try {
  const r1 = run('run1', 'reader-check.js');
  if (r1.fatal) { console.log('[rd-plus] FAIL run1 fatal: ' + r1.fail || r1.fatal); process.exit(2); }
  for (const [n, ok, d] of r1.checks) { total++; if (!ok) fail++; console.log((ok ? '  ok   ' : '  FAIL ') + n + (ok || !d ? '' : '  <- ' + d)); }

  const r2 = run('run2', 'reader-check-restore.js');
  if (r2.fatal) { console.log('[rd-plus] FAIL run2 fatal: ' + r2.fatal); process.exit(2); }
  for (const [n, ok, d] of r2.checks) { total++; if (!ok) fail++; console.log((ok ? '  ok   ' : '  FAIL ') + n + (ok || !d ? '' : '  <- ' + d)); }
} catch (e) {
  console.error('[rd-plus] ERROR', e && e.message ? e.message : e);
  process.exit(3);
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
}
console.log('[rd-plus] ' + (fail ? 'FAIL (' + fail + '/' + total + ')' : 'PASS (' + total + ')'));
process.exit(fail ? 2 : 0);
