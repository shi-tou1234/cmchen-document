'use strict';
/*
 * 会话记忆与双击打开的端到端验证（跑真实 app，不是自建窗口）：
 *   run1 首次打开        → 记录 filePath、写盘 recent[0].page
 *   run2 再次打开同一文件 → 应当直接落在上次那一页（restore 真生效）
 *   run3 命令行带文件参数 → 窗口标题出现文件名（等价双击 / 右键打开方式）
 * 用独立的 --user-data-dir 隔离状态，绝不碰你真实的最近记录。
 * 运行：node scripts\test-session.js
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const SAMPLE = path.join(ROOT, 'assets', 'sample.pdf');
const TOTAL_PAGES = 3;

function childEnv(extra) {
  const env = Object.assign({}, process.env, extra || {});
  // 宿主注入 ELECTRON_RUN_AS_NODE=1 会让 electron.exe 退化成纯 Node，子进程必须清掉
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function runApp(userDataDir, env, extraArgs) {
  const args = ['.', '--no-sandbox', '--disable-gpu', '--user-data-dir=' + userDataDir]
    .concat(extraArgs || []);
  const r = spawnSync(ELECTRON, args, { cwd: ROOT, env: childEnv(env), encoding: 'utf8', timeout: 120000 });
  const out = String((r.stdout || '') + (r.stderr || ''));
  const line = out.split(/\r?\n/).find((l) => l.includes('[smoke-result]'));
  if (!line) return { fatal: 'no smoke-result', out: out.slice(-600) };
  try { return JSON.parse(line.slice(line.indexOf('{'))); }
  catch (e) { return { fatal: 'bad json: ' + e.message, line }; }
}

function titles() {
  const ps = "Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { $_.MainWindowTitle }";
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 60000 });
  return String(r.stdout || '');
}

const checks = [];
function check(name, ok, detail) { checks.push({ name, ok: !!ok, detail }); }

const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-sess-'));
const stateFile = path.join(udd, 'window-state.json');
try {
  // ---- run1：全新环境第一次打开 ----
  const r1 = runApp(udd, { SMOKE_PDF: SAMPLE });
  check('run1 冒烟通过', r1.ok === true, JSON.stringify(r1).slice(0, 160));
  check('run1 拿到文件真实路径', r1.session && r1.session.hasFilePath === true, JSON.stringify(r1.session));
  check('run1 首次无历史记录→从第 1 页开始', r1.session && r1.session.startPage === 1, JSON.stringify(r1.session));

  // ---- 落盘检查：最近记录 + 页码 ----
  const st = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
  const rec = (st.recent || []).find((x) => /sample\.pdf$/i.test(x.path || ''));
  check('状态文件写入 recent 条目', !!rec, JSON.stringify(st.recent));
  check('页码已记为末页(读到第 3 页)', rec && rec.page === TOTAL_PAGES, rec && 'page=' + rec.page);

  // ---- run2：再次打开同一文件，应直接回到第 3 页 ----
  const r2 = runApp(udd, { SMOKE_PDF: SAMPLE });
  check('run2 恢复 startPage=3', r2.session && r2.session.startPage === TOTAL_PAGES, JSON.stringify(r2.session));
  check('run2 实际落点 currentPage=3', r2.session && r2.session.landedPage === TOTAL_PAGES, JSON.stringify(r2.session));
  const st2 = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  check('重复打开不会堆出多条记录', (st2.recent || []).filter((x) => /sample\.pdf$/i.test(x.path)).length === 1,
    'recent 长度 ' + (st2.recent || []).length);

  // ---- run3：命令行带文件路径（双击 / 右键打开方式） ----
  const childEnv3 = childEnv({});
  delete childEnv3.SMOKE_PDF;
  const { spawn } = require('child_process');
  const p3 = spawn(ELECTRON, ['.', '--no-sandbox', '--disable-gpu', '--user-data-dir=' + udd, SAMPLE],
    { cwd: ROOT, env: childEnv3 });
  let titleHit = '';
  for (let i = 0; i < 12 && !/sample\.pdf/.test(titleHit); i++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000); // 同步 sleep 1s
    titleHit = titles();
  }
  check('命令行打开后窗口标题带文件名', /sample\.pdf\s*-\s*PDF Reader/.test(titleHit),
    (titleHit.trim().split(/\r?\n/).find((t) => /sample\.pdf/i.test(t)) || '（未出现）'));
  p3.kill();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
  try { p3.kill(); } catch (_) {}
} catch (e) {
  check('脚本自身未抛错', false, e && e.message);
} finally {
  try { fs.rmSync(udd, { recursive: true, force: true }); } catch (_) {}
}

const failed = checks.filter((c) => !c.ok);
for (const c of checks) console.log((c.ok ? '  ok   ' : '  FAIL ') + c.name + (c.ok ? '' : '  <- ' + c.detail));
console.log('[session] ' + (failed.length ? 'FAIL (' + failed.length + '/' + checks.length + ')' : 'PASS (' + checks.length + ')'));
process.exit(failed.length ? 2 : 0);
