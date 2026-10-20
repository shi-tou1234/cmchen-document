'use strict';
/*
 * 单实例锁真实双开回归（v11）。以普通模式（非探针）启动两个进程：
 * 第一个持有锁；第二个必须立刻退出，并通过 second-instance 把命令行里的 PDF 转交给第一个。
 * 用 window-state.json 的 recent 列表作为“第一个实例真的收到了”的磁盘证据。
 * 运行：node scripts/test-single-instance.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const SAMPLE = path.join(ROOT, 'assets', 'sample.pdf');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-single-'));
const udd = path.join(tmp, 'ud');
fs.mkdirSync(udd, { recursive: true });
const pdf1 = path.join(tmp, 'first.pdf');
const pdf2 = path.join(tmp, 'second.pdf');
fs.copyFileSync(SAMPLE, pdf1);
fs.copyFileSync(SAMPLE, pdf2);
const stateFile = path.join(udd, 'window-state.json');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  <- ' + detail : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 20000)) { if (fn()) return true; await sleep(150); }
  return !!fn();
}
function readState() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (_) { return null; }
}
function launch(pdf) {
  const env = Object.assign({}, process.env, { PDFREADER_NO_AUTO_INDEX: '1', PDFREADER_HIDDEN: '1' });
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.PDFREADER_PROBE;
  delete env.PDFREADER_LIBUI;
  delete env.PDFREADER_TEST;
  delete env.SMOKE_PDF;
  return spawn(ELECTRON, ['.', '--no-sandbox', '--disable-gpu', '--user-data-dir=' + udd, pdf], {
    cwd: ROOT, env, stdio: 'ignore', windowsHide: true,
  });
}
function waitExit(child, ms) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, ms);
    child.once('exit', (code, signal) => {
      if (done) return;
      done = true; clearTimeout(timer); resolve({ code, signal });
    });
  });
}

(async () => {
  let first = null;
  try {
    first = launch(pdf1);
    const started = await waitFor(() => {
      const s = readState();
      return !!(s && Array.isArray(s.recent) && s.recent.some((r) => path.resolve(r.path) === path.resolve(pdf1)));
    }, 30000);
    ok('第一个实例启动并记录打开的文件', started, JSON.stringify(readState()));
    ok('第一个实例仍在运行', first.exitCode === null, 'exitCode=' + first.exitCode);

    const second = launch(pdf2);
    const exited = await waitExit(second, 15000);
    ok('第二个实例自动退出（锁生效）', !!exited, exited === null ? 'still running' : '');
    ok('第二个实例退出码为 0', !!exited && exited.code === 0, JSON.stringify(exited));

    const forwarded = await waitFor(() => {
      const s = readState();
      return !!(s && Array.isArray(s.recent) && s.recent.some((r) => path.resolve(r.path) === path.resolve(pdf2)));
    }, 15000);
    const st = readState();
    ok('命令行 PDF 被转交给第一个实例', forwarded, JSON.stringify(st && st.recent));
    ok('转交后两个文件都在最近列表', !!st && Array.isArray(st.recent) &&
      [pdf1, pdf2].every((p) => st.recent.some((r) => path.resolve(r.path) === path.resolve(p))), JSON.stringify(st && st.recent));
    ok('第一个实例始终没有退出', first.exitCode === null, 'exitCode=' + first.exitCode);
  } catch (e) {
    fail++;
    console.log('  FAIL 单实例测试异常  <- ' + (e && e.message ? e.message : e));
  } finally {
    if (first && first.exitCode === null) {
      try { execFileSync('taskkill', ['/PID', String(first.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (_) {}
      await waitExit(first, 8000);
    }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }

  console.log('[single-instance] ' + (fail ? 'FAIL (' + fail + '/' + (pass + fail) + ')' : 'PASS (' + pass + ')'));
  process.exit(fail ? 2 : 0);
})();
