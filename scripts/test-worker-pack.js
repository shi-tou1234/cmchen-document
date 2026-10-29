'use strict';
/*
 * 打包布局回归（第四轮审核 R4-02）。
 *
 * 之前的配置只把 src/search-worker.js 解包到 app.asar.unpacked，入口能起来，
 * 但它执行 require('./fulltext.js') 时会在 app.asar.unpacked/src 下找同级文件——
 * fulltext.js 还在 app.asar 里，于是 worker 启动即失败，搜索悄悄退回主进程。
 *
 * 这个脚本验证「在 asar 里跑 worker」这条路真的通：
 *   1. 把 src/*.js 复制进一个临时 asar（放在仓库内，好让 require 向上找到项目 node_modules）；
 *   2. 用真实 Electron 起一个 worker，入口就是 app.asar/src/search-worker.js；
 *   3. 让它 ping → 建一条文本索引 → 搜一次，命中必须落在刚索引的那个文件上。
 * 另外两条静态断言：package.json 不许再只解包入口；服务优先选 asar 内的路径。
 *
 * 运行：node scripts/test-worker-pack.js
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const asar = require('@electron/asar');

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); return; }
  fail++;
  console.log('  FAIL ' + name + (detail === undefined ? '' : '  <- ' + detail));
}

const MAIN_SRC = `'use strict';
const { app } = require('electron');
const path = require('path');
const { Worker } = require('worker_threads');
app.disableHardwareAcceleration();
function done(obj) { console.log('RESULT ' + JSON.stringify(obj)); }
app.whenReady().then(async () => {
  const [asarPath, dataDir, txt] = process.argv.slice(2);
  let w = null;
  const wait = new Map();
  let seq = 0;
  const call = (cmd, ...args) => new Promise((res, rej) => {
    const id = ++seq;
    wait.set(id, { res, rej });
    w.postMessage({ id, cmd, args });
  });
  try {
    w = new Worker(path.join(asarPath, 'src', 'search-worker.js'), { workerData: { dataDir } });
  } catch (e) {
    done({ fatal: 'spawn: ' + (e && e.message) }); app.quit(); return;
  }
  w.on('message', (m) => {
    const p = wait.get(m && m.id);
    if (!p) return;
    wait.delete(m.id);
    if (m.ok) p.res(m.result); else p.rej(new Error(m.error || 'worker 返回失败'));
  });
  w.on('error', (e) => { done({ fatal: 'worker: ' + (e && e.message) }); app.quit(); });
  try {
    const ping = await call('ping');
    const idx = await call('indexFile', txt, {});
    const found = await call('search', 'asarneedle');
    done({ ping, idx, found });
  } catch (e) {
    done({ fatal: String((e && e.message) || e) });
  } finally {
    try { if (w) w.terminate(); } catch (_) {}
    app.quit();
  }
});
`;

function main() {
  // 临时 asar 必须放在仓库内：worker 里的 require 会沿目录向上找到项目的 node_modules。
  // 放在 .workbuddy/tmp 下（仓库内、又不污染根目录），跑完即删。
  const tmp = path.join(ROOT, '.workbuddy', 'tmp', 'wpack-' + process.pid);
  const pack = path.join(tmp, 'pack');
  const asarPath = path.join(tmp, 'app.asar');
  const dataDir = path.join(tmp, 'data');
  const txt = path.join(tmp, 'doc.txt');
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(path.join(pack, 'src'), { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    // 只放 src 下的 .js：真实依赖走 node_modules，由 Node 从仓库根解析
    let copied = 0;
    for (const f of fs.readdirSync(path.join(ROOT, 'src'))) {
      if (!/\.js$/i.test(f)) continue;
      fs.copyFileSync(path.join(ROOT, 'src', f), path.join(pack, 'src', f));
      copied++;
    }
    fs.writeFileSync(txt, 'asarneedle alpha beta gamma\nsecond line of the asar probe\n', 'utf8');
    fs.writeFileSync(path.join(tmp, 'main.js'), MAIN_SRC, 'utf8');

    console.log('  info 打包 ' + copied + ' 个源文件进临时 asar');
    asar.createPackage(pack, asarPath).then(() => {
      let out = '';
      const env = Object.assign({}, process.env);
      delete env.ELECTRON_RUN_AS_NODE;
      try {
        out = execFileSync(ELECTRON, [path.join(tmp, 'main.js'), asarPath, dataDir, txt], {
          cwd: ROOT, env, encoding: 'utf8', timeout: 90000,
        });
      } catch (err) {
        out = String((err && err.stdout) || '') + '\n' + String((err && err.stderr) || '');
      }
      const line = out.split(/\r?\n/).find((l) => l.startsWith('RESULT '));
      let res = null;
      if (line) { try { res = JSON.parse(line.slice(7)); } catch (_) { res = null; } }
      ok('asar 内能起 worker 并拿到结果', !!res, out.slice(-400));
      if (!res) { finish(tmp); return; }
      ok('worker 没有报错', !res.fatal, res.fatal);
      ok('ping 指向传入的数据目录', !!(res.ping && res.ping.ok && String(res.ping.dir) === path.join(dataDir, 'fulltext')),
        String(JSON.stringify(res.ping)));
      ok('能从 asar 里的 fulltext 建索引', !!(res.idx && res.idx.ok), String(JSON.stringify(res.idx)).slice(0, 300));
      const found = res.found || {};
      const hit = (found.results || [])[0] || null;
      ok('搜索命中刚索引的文件', !!(hit && String(hit.path) === String(txt)), String(JSON.stringify(found)).slice(0, 300));
      ok('命中落在第 1 页且带摘要', !!(hit && Number(hit.page) === 1 && String(hit.snippet || '').indexOf('asarneedle') >= 0),
        String(JSON.stringify(hit || null)).slice(0, 240));

      // 静态断言：不再「只解包入口」，服务也优先从 asar 内加载
      const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
      const unpack = (pkg.build && pkg.build.asarUnpack) || [];
      ok('package.json 不再单独解包 worker 入口', !unpack.some((p) => /search-worker/.test(String(p))),
        JSON.stringify(unpack));
      const svc = require(path.join(ROOT, 'src', 'search-service.js'));
      const cands = svc._workerCandidates ? svc._workerCandidates() : [];
      ok('服务优先选 asar 内的路径', cands[0] === path.join(ROOT, 'src', 'search-worker.js'), JSON.stringify(cands));
      finish(tmp);
    }).catch((err) => {
      ok('打包临时 asar 失败', false, String((err && err.message) || err));
      finish(tmp);
    });
  } catch (err) {
    ok('准备临时目录失败', false, String((err && err.message) || err));
    finish(tmp);
  }
}

function finish(tmp) {
  const summary = () => {
    console.log('test-worker-pack: ' + pass + ' passed, ' + fail + ' failed');
    process.exitCode = fail ? 1 : 0;
    if (fail) process.exit(1);
  };
  if (process.env.KEEP_TMP === '1') { console.log('  info KEEP_TMP=1，保留 ' + tmp); summary(); return; }
  // Electron 退出后 Windows 还会短暂持有 app.asar 的句柄，删不掉是常态；
  // 这里等一会儿再试，最多 4 秒，实在删不掉就留着（临时目录在 .workbuddy/tmp 下）。
  let tries = 0;
  const attempt = () => {
    tries++;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    if (!fs.existsSync(tmp)) { summary(); return; }
    if (tries < 10) { setTimeout(attempt, 400); return; }
    console.log('  info 临时目录暂时删不掉（句柄未释放），留在 ' + tmp);
    summary();
  };
  setTimeout(attempt, 250);
}

main();
