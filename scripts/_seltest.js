'use strict';
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const SAMPLE = path.join(ROOT, 'assets', 'sample.pdf');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-'));
const udd = path.join(tmp, 'ud'); fs.mkdirSync(udd);
const env = Object.assign({}, process.env, {
  PDFREADER_PROBE: path.join(ROOT, 'scripts', '_selprobe.js'),
  PDFREADER_PROBE_PDF: SAMPLE,
  PDFREADER_DATA_DIR: tmp,
});
delete env.ELECTRON_RUN_AS_NODE;
const out = execFileSync(ELECTRON, ['.', '--no-sandbox', '--disable-gpu', '--user-data-dir=' + udd], { cwd: ROOT, env, encoding: 'utf8', timeout: 180000 });
console.log(out);
fs.rmSync(tmp, { recursive: true, force: true });
