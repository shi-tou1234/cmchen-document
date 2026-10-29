'use strict';
/*
 * 数据目录切换 × 增量索引队列（第四轮审核 R4-05）。
 *
 * 旧行为：restart() 换目录和 worker，但 stop() 不清 queue、也不取消 500 ms 防抖计时器。
 * 重启前排队的旧路径会在计时器触发后交给新 worker，写进新目录的索引——新库里混进旧库
 * 的文件路径与正文。
 *
 * 纯 Node 跑（worker_threads 在 Node 里也能加载 src/search-worker.js），不启 Electron：
 *   1. A 目录排队 → 不等防抖，立刻 restart(B)；
 *   2. B 的索引必须是空的，且原防抖窗口过去之后仍然为空（旧计时器不能诈尸）；
 *   3. 旧批次不能往 B 广播 change 事件；
 *   4. 换到 B 之后新排的任务照常工作（不能因为清理队列把新任务也丢了）。
 *
 * 运行：node scripts/test-search-restart.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const svc = require('../src/search-service.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); return; }
  fail++;
  console.log('  FAIL ' + name + (detail === undefined ? '' : '  <- ' + detail));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function write(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, 'utf8'); }

// 索引目录里有没有指向某个路径的条目（旧任务混进新库时会留下这种文件）
function indexPaths(dir) {
  const d = path.join(dir, 'fulltext');
  const out = [];
  let files = [];
  try { files = fs.readdirSync(d).filter((f) => /\.json$/.test(f)); } catch (_) { return out; }
  for (const f of files) {
    try { out.push(String(JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')).path || '')); } catch (_) {}
  }
  return out;
}

function waitIdle(ms) {
  return new Promise((res) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(t); svc.off('idle', onIdle); res(v); };
    const onIdle = (info) => finish(info);
    const t = setTimeout(() => finish(null), ms);
    svc.on('idle', onIdle);
  });
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-restart-'));
  const A = path.join(root, 'A');
  const B = path.join(root, 'B');
  fs.mkdirSync(A, { recursive: true });
  fs.mkdirSync(B, { recursive: true });
  const changes = [];
  const onChange = (c) => changes.push(c);
  svc.on('change', onChange);
  try {
    const mode = svc.start(A);
    ok('索引服务以 worker 模式启动', mode === 'worker', mode);

    const oldTxt = path.join(A, 'old.txt');
    write(oldTxt, 'stale needlestale content from the old data directory\n');
    svc.scheduleIndex(oldTxt);
    ok('排队后 pendingCount 为 1', svc.pendingCount() === 1, String(svc.pendingCount()));

    // 不等防抖，立刻切到 B（等价于用户在设置里改了数据目录）
    svc.restart(B);
    ok('重启后队列被清空', svc.pendingCount() === 0, String(svc.pendingCount()));

    // 原防抖是 500 ms；等过窗口，确认旧计时器没有把任务交给新 worker
    await sleep(900);
    const stB = await svc.stats();
    ok('B 的索引仍然为空', stB.indexed === 0, JSON.stringify({ indexed: stB.indexed, dir: stB.dir }));
    const stale = indexPaths(B).filter((p) => p && path.resolve(p) === path.resolve(oldTxt));
    ok('B 下没有指向 A 文件的索引条目', stale.length === 0, JSON.stringify(indexPaths(B)));
    ok('旧批次没有向界面广播 change', changes.length === 0, JSON.stringify(changes).slice(0, 200));

    // 换目录之后新的任务必须照常工作
    const newTxt = path.join(B, 'fresh.txt');
    write(newTxt, 'freshneedle content lives in the new data directory\n');
    const idleP = waitIdle(15000);
    svc.scheduleIndex(newTxt);
    await idleP;
    const stB2 = await svc.stats();
    ok('B 里建好了新文件的索引', stB2.indexed === 1, JSON.stringify({ indexed: stB2.indexed }));
    const pathsB = indexPaths(B).map((p) => path.resolve(p));
    ok('B 的索引只指向 B 的文件', pathsB.length === 1 && pathsB[0] === path.resolve(newTxt), JSON.stringify(pathsB));
    const hits = await svc.search('freshneedle');
    ok('B 里能搜到新内容', !!(hits && hits.ok && (hits.results || []).some((r) => String(r.path) === newTxt)),
      JSON.stringify((hits && hits.results) || []).slice(0, 200));
    ok('这期间有且只有新文件的 change 广播', changes.length >= 1 && changes.every((c) => path.resolve(c.path) === path.resolve(newTxt)),
      JSON.stringify(changes).slice(0, 240));
  } finally {
    svc.off('change', onChange);
    svc.stop();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  }
  console.log('test-search-restart: ' + pass + ' passed, ' + fail + ' failed');
  if (fail) process.exit(1);
}

main().catch((err) => {
  console.log('  FAIL 脚本异常 :: ' + (err && err.stack ? err.stack : err));
  try { svc.stop(); } catch (_) {}
  process.exit(1);
});
