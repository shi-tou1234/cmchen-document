'use strict';
/*
 * 持续修复复查 I03 的回归：全文索引完成后，当前搜索结果要自动刷新。
 *
 * 根因：preload 把 onFtIndexChanged / onFtIndexIdle 挂在 pdfBridge.lib 下，
 * library-ui.js 却判断 window.pdfBridge.onFtIndexChanged —— 永远为假，整段监听
 * 从未注册。索引建完后「索引中」状态不更新，搜索时还没入索引的文档也不会补上。
 *
 * 本测试直接发送主进程会发的真实事件，验证「事件 → 界面 → 重新检索」这条链路：
 *   · change 只更新状态，不触发检索（密集广播要合并）；
 *   · idle 触发一次当前查询的重新检索；
 *   · 面板关着时 idle 不白跑；
 *   · 重新打开后 idle 仍能刷新。
 *
 * 运行：node scripts/test-ft-index-events.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-ft-events-'));

let fail = 0;
let total = 0;
function check(name, ok, detail) {
  total++;
  if (!ok) { fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  <- ' + JSON.stringify(detail) : '')); }
  else console.log('  ok   ' + name);
}
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } }
function cleanEnv() {
  const e = Object.assign({}, process.env);
  delete e.ELECTRON_RUN_AS_NODE;
  delete e.NODE_OPTIONS;
  return e;
}

const HARNESS = `'use strict';
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');
const ROOT = __ROOT__, CFG = __CFG__;
const realWrite = fs.writeFileSync;
const realHandle = ipcMain.handle;
let searchCalls = 0;

// 统计真实检索 IPC：验证事件到底有没有把查询重跑一遍
ipcMain.handle = function (channel, fn) {
  return realHandle.call(this, channel, async (e, info) => {
    if (channel === 'lib-search-full') searchCalls++;
    return fn(e, info);
  });
};

process.env.PDFREADER_TEST = '1';
process.env.PDFREADER_HIDDEN = '1';
process.env.PDFREADER_NO_AUTO_INDEX = '1';
process.env.PDFREADER_LIBRARY = CFG.libFile;
process.env.PDFREADER_DATA_DIR = CFG.data;
app.setPath('userData', CFG.ud);
require(path.join(ROOT, 'src/main.js'));

let win = null;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (fn, arg) => win.webContents.executeJavaScript('(' + fn.toString() + ')(' + JSON.stringify(arg) + ')', true);
async function until(fn, label) {
  for (let i = 0; i < 200; i++) { const r = await fn(); if (r) return r; await pause(40); }
  throw new Error('wait timeout: ' + (label || ''));
}

app.whenReady().then(async () => {
  await pause(250);
  win = BrowserWindow.getAllWindows()[0];
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
  win.webContents.setBackgroundThrottling(false);
  await pause(400);
  const R = {};
  try {
    R.api = await run(() => ({
      rootChanged: typeof pdfBridge.onFtIndexChanged,
      rootIdle: typeof pdfBridge.onFtIndexIdle,
      nestedChanged: typeof (pdfBridge.lib && pdfBridge.lib.onFtIndexChanged),
      nestedIdle: typeof (pdfBridge.lib && pdfBridge.lib.onFtIndexIdle),
    }));
    await run(() => {
      LibraryUI.show();
      const q = document.getElementById('lib-search');
      q.value = 'probe-before-index';
      q.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await until(() => searchCalls > 0, 'first search');
    await pause(900);
    R.before = searchCalls;

    // 密集 change：只更新「索引中 +N」，不触发检索
    for (let i = 0; i < 5; i++) win.webContents.send('ft-index-changed', { pending: 5 - i });
    await pause(1300);
    R.afterChanges = searchCalls;

    // idle：整批建完，重跑当前查询
    win.webContents.send('ft-index-idle', { pending: 0 });
    await pause(1600);
    R.afterIdle = searchCalls;

    // 面板关着：不白跑
    await run(() => { LibraryUI.hide(); return true; });
    win.webContents.send('ft-index-idle', { pending: 0 });
    await pause(1300);
    R.afterHidden = searchCalls;

    // 重新打开：idle 仍能刷新
    await run(() => { LibraryUI.show(); return true; });
    await pause(600);
    R.afterShow = searchCalls;
    win.webContents.send('ft-index-idle', { pending: 0 });
    await pause(1600);
    R.afterShownIdle = searchCalls;
  } catch (err) {
    R.error = String((err && err.stack) || err);
  }
  realWrite(CFG.out, JSON.stringify(R));
  app.exit(0);
}).catch((err) => {
  try { realWrite(CFG.out, JSON.stringify({ fatal: String((err && err.stack) || err) })); } catch (_) {}
  app.exit(1);
});
setTimeout(() => { try { realWrite(CFG.out, JSON.stringify({ timeout: true })); } catch (_) {} app.exit(3); }, 60000);
`;

function main() {
  const dir = path.join(tmp, 'run');
  const ud = path.join(dir, 'ud');
  fs.mkdirSync(ud, { recursive: true });
  fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify({
    version: 8, collections: [], searches: [], tagColors: {}, feeds: [], noteAliases: {},
    annoTags: {}, annoMeta: {}, items: [],
  }));
  const cfg = {
    dir, ud,
    libFile: path.join(dir, 'library.json'),
    data: path.join(dir, 'data'),
    out: path.join(dir, 'out.json'),
  };
  const hf = path.join(dir, 'harness.cjs');
  fs.writeFileSync(hf, HARNESS.split('__ROOT__').join(JSON.stringify(ROOT)).split('__CFG__').join(JSON.stringify(cfg)));
  const r = spawnSync(ELECTRON, [hf, '--no-sandbox', '--disable-gpu', '--disable-background-timer-throttling'], {
    cwd: ROOT, env: cleanEnv(), encoding: 'utf8', timeout: 90000, windowsHide: true,
  });
  fs.writeFileSync(path.join(dir, 'log.txt'), String((r && r.stdout) || '') + String((r && r.stderr) || ''));
  const R = readJson(cfg.out) || {};

  check('I03 场景执行无脚本错误', !R.error && !R.fatal && !R.timeout, R.error || R.fatal || R.timeout);
  check('I03 两个索引事件都挂在 lib 下', R.api && R.api.nestedChanged === 'function' && R.api.nestedIdle === 'function', R.api);
  check('I03 密集 change 不逐条重跑检索', R.afterChanges === R.before, { before: R.before, afterChanges: R.afterChanges });
  check('I03 idle 后当前查询自动重跑', R.afterIdle > R.afterChanges, { afterChanges: R.afterChanges, afterIdle: R.afterIdle });
  check('I03 面板关着时 idle 不白跑', R.afterHidden === R.afterIdle, { afterIdle: R.afterIdle, afterHidden: R.afterHidden });
  check('I03 重开面板后 idle 仍能刷新', R.afterShownIdle > R.afterShow, { afterShow: R.afterShow, afterShownIdle: R.afterShownIdle });

  console.log('[ft-index-events] ' + (fail ? 'FAIL ' : 'PASS ') + '(' + total + ')');
  if (!fail && tmp.startsWith(path.join(os.tmpdir(), 'trove-ft-events-'))) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  process.exitCode = fail ? 1 : 0;
}

main();
