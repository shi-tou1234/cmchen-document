'use strict';
/*
 * 全文索引服务（2026-10-29）。
 *
 * 主进程不再直接碰索引：所有「读索引 / 抽文本 / 建索引 / 搜索」都转发给 search-worker.js，
 * 由一个 worker 线程串行处理。这样 pdfjs 抽文本、遍历上千个索引文件都不会再阻塞
 * 窗口的输入与滚动（README「当前边界」里写的那条「搜索仍在主进程处理」）。
 *
 * 另外提供一条**增量索引队列**：导入 / 抓取 PDF / 重新定位 / 还原条目都只调
 * scheduleIndex()，同一个路径自动去重、短时间内多次变更合并成一次、按顺序跑，
 * 每完成一个文件发一条 change 事件，主进程据此广播给所有窗口。
 *
 * 兜底：worker 起不来（极端环境）或运行时崩了，自动退回进程内直接调 fulltext.js，
 * 功能不丢，只是回到原来的性能。所有公开方法都是 async，调用方不需要关心走哪条路。
 */
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

const emitter = new EventEmitter();
let worker = null;
let seq = 0;
const pending = new Map();          // id -> { res, rej, timer, cmd }
let dataDir = null;
let mode = 'none';                  // 'worker' | 'inline' | 'none'
let inlineMod = null;               // 兜底模式下直接用的 fulltext 模块
let lastFailure = '';

const SEARCH_TIMEOUT = 60000;
const STATS_TIMEOUT = 60000;

// worker 入口候选，按优先级排列。
//
// 打包后的第一个候选是 app.asar 里的路径：Electron 的 worker_threads 能读 asar，
// 入口在 asar 内、它 require 的 fulltext.js / docconvert.js / query.js 也在 asar 内，
// 相对路径一路都通。之前只把入口 asarUnpack 出去，反而让 './fulltext.js' 在
// app.asar.unpacked/src 下找不到——这是第四轮审核 R4-02 的根因。
//
// 第二个候选（解包副本）只为兼容「有人手工解包过」的旧布局：存在才用，不存在就跳过。
function workerCandidates() {
  const plain = path.join(__dirname, 'search-worker.js');
  const list = [plain];
  const unpacked = plain.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
  try { if (unpacked !== plain && fs.existsSync(unpacked)) list.push(unpacked); } catch (_) {}
  return list;
}

// 兼容旧调用点（测试里用它确认「当前会从哪里加载 worker」）
function workerScript() { return workerCandidates()[0]; }

function inline() {
  if (!inlineMod) {
    inlineMod = require('./fulltext.js');
    inlineMod.init(dataDir);
  }
  return inlineMod;
}

function rejectAll(reason) {
  for (const [, p] of pending) {
    try { clearTimeout(p.timer); } catch (_) {}
    try { p.rej(new Error(reason)); } catch (_) {}
  }
  pending.clear();
}

let candidates = [];                // worker 入口候选（见 workerCandidates）
let candIdx = 0;

function spawn() {
  const { Worker } = require('worker_threads');
  const file = candidates[candIdx];
  const w = new Worker(file, { workerData: { dataDir } });
  w.on('message', (msg) => {
    if (!msg || typeof msg.id !== 'number') return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    try { clearTimeout(p.timer); } catch (_) {}
    if (msg.ok) p.res(msg.result);
    else p.rej(new Error(msg.error || '索引服务返回失败'));
  });
  w.on('error', (err) => {
    if (worker !== w) return;          // 已经换过入口 / 主动停掉
    const msg = String((err && err.message) || err);
    if (nextCandidate(msg)) return;
    lastFailure = msg;
    console.warn('[search] worker 异常，退回主进程内索引：', lastFailure);
    degrade();
  });
  w.on('exit', (code) => {
    if (worker !== w) return;          // 主动 restart/stop 导致的退出
    const msg = 'worker 退出（code ' + code + '）';
    if (nextCandidate(msg)) return;
    lastFailure = msg;
    console.warn('[search] worker 退出，退回主进程内索引：code', code);
    degrade();
  });
  // 不 unref：索引是应用的常驻能力，窗口关掉时就该一起收尾（stop() 里 terminate）
  return w;
}

// 换下一个入口再试一次。只在「启动阶段就挂」时有意义——打包布局不对属于这一类，
// 运行期崩溃则没有第二个候选，直接兜底到进程内。
function nextCandidate(reason) {
  if (candIdx + 1 >= candidates.length) return false;
  candIdx++;
  console.warn('[search] worker 入口不可用（' + reason + '），改用 ' + candidates[candIdx]);
  try {
    worker = spawn();
    mode = 'worker';
    return true;
  } catch (err) {
    lastFailure = String((err && err.message) || err);
    return false;
  }
}

function degrade() {
  mode = 'inline';
  const w = worker;
  worker = null;
  rejectAll(lastFailure || '索引服务不可用');
  try { if (w) w.terminate(); } catch (_) {}
}

function start(dir) {
  dataDir = dir || dataDir || null;
  stop();
  mode = 'none';
  inlineMod = null;
  // 排错开关：PDFREADER_SEARCH_INLINE=1 强制在进程内索引（等价于搬 worker 之前的行为）。
  // regression 用它对比「两条路的结果必须一致」，用户遇到 worker 环境问题时也能靠它继续用。
  if (process.env.PDFREADER_SEARCH_INLINE === '1') { mode = 'inline'; return mode; }
  candidates = workerCandidates();
  candIdx = 0;
  try {
    worker = spawn();
    mode = 'worker';
  } catch (err) {
    lastFailure = String((err && err.message) || err);
    if (!nextCandidate(lastFailure)) {
      console.warn('[search] 无法启动索引 worker，退回主进程内索引：', lastFailure);
      degrade();
    }
  }
  return mode;
}

function stop() {
  // 换数据目录 / 退出时都要作废旧任务：queue 里排着的路径属于旧目录，
  // 防抖计时器一响就会把它们交给新 worker，写进新目录的索引里（第四轮审核 R4-05）。
  gen++;
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  queue.clear();
  const w = worker;
  worker = null;
  rejectAll('索引服务已关闭');
  try { if (w) w.terminate(); } catch (_) {}
}

function restart(dir) {
  dataDir = dir || dataDir;
  return start(dataDir);
}

function call(cmd, args, timeoutMs) {
  if (mode === 'inline') {
    // 兜底：进程内直接跑。同步命令也包一层 Promise，保持调用方一致。
    const mod = inline();
    return Promise.resolve().then(() => {
      switch (cmd) {
        case 'search': return mod.search(args[0]);
        case 'stats': return mod.stats();
        case 'freshness': return (args[0] || []).map((p) => !!mod.isFresh(p));
        case 'indexFile': return mod.indexFile(args[0], args[1]);
        case 'indexOne': return mod.indexOne(args[0], args[1]);
        case 'indexAll': return mod.indexAll(args[0], args[1]);
        case 'clear': return mod.clear();
        case 'removeForPath': return mod.removeForPath(args[0]);
        case 'moveIndex': return inlineMove(args[0], args[1]);
        case 'ping': return { ok: true, dir: mod.dirPath(), inline: true };
        default: throw new Error('未知命令：' + cmd);
      }
    });
  }
  if (!worker) return Promise.reject(new Error('索引服务未启动'));
  const id = ++seq;
  return new Promise((res, rej) => {
    const entry = { res, rej, timer: null, cmd };
    if (timeoutMs) {
      entry.timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        rej(new Error('索引请求超时：' + cmd));
      }, timeoutMs);
    }
    pending.set(id, entry);
    try { worker.postMessage({ id, cmd, args }); }
    catch (err) { pending.delete(id); rej(err); }
  });
}

function inlineMove(oldPath, newPath) {
  const mod = inline();
  const from = mod.fileFor(oldPath);
  const to = mod.fileFor(newPath);
  if (from === to) return { ok: true, moved: false };
  try {
    const entry = JSON.parse(fs.readFileSync(from, 'utf8'));
    entry.path = newPath;
    require('./atomic-file').atomicWrite(to, JSON.stringify(entry));
    try { fs.unlinkSync(from); } catch (_) {}
    return { ok: true, moved: true };
  } catch (_) { return { ok: true, moved: false }; }
}

// ---------- 对外：读 ----------
const search = (q) => call('search', [q], SEARCH_TIMEOUT);
const stats = () => call('stats', [], STATS_TIMEOUT).catch(() => ({
  dir: '', indexed: 0, failed: 0, pages: 0, chars: 0, bytes: 0, running: false, unavailable: true,
}));
const freshness = (paths) => call('freshness', [paths || []], STATS_TIMEOUT).catch(() => []);
const ping = () => call('ping', [], 5000).catch((e) => ({ ok: false, error: e.message }));

// ---------- 对外：写 ----------
const indexFile = (p, opts) => call('indexFile', [p, opts], 0);
const indexOne = (item, opts) => call('indexOne', [item, opts], 0);
const indexAll = (items, opts) => call('indexAll', [items, opts], 0);
const clear = () => call('clear', [], 0);
const removeForPath = (p) => call('removeForPath', [p], 0).catch(() => false);
const moveIndex = (from, to) => call('moveIndex', [from, to], 0).catch(() => ({ ok: false }));

// ---------- 增量索引队列 ----------
// 同一个路径只排一次；短时间内的连续变更（导入后立刻抓 PDF、批量导入）合并成一批。
let queue = new Map();     // absPath -> { force }
let draining = false;
let debounceTimer = null;
let batch = null;
// 数据目录代际：restart / stop 之后 +1。旧代际排队的任务与正在跑的批次一律作废，
// 否则旧目录的路径会被写进新目录的索引（R4-05）。
let gen = 0;

function pathOf(item) {
  const raw = item && typeof item === 'object'
    ? (item.attachment ? item.attachment.path : item.path)
    : item;
  const p = typeof raw === 'string' ? raw.trim() : '';
  return p ? path.resolve(p) : '';
}

function scheduleIndex(item, opts) {
  const p = pathOf(item);
  if (!p) return false;
  const prev = queue.get(p);
  queue.set(p, { force: !!(opts && opts.force) || !!(prev && prev.force) });
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(drain, 500);
  return true;
}

function pendingCount() { return queue.size + (draining ? 1 : 0); }

async function drain() {
  if (draining) return;
  const myGen = gen;
  draining = true;
  batch = { done: 0, failed: 0, skipped: 0, startedAt: Date.now(), errors: [] };
  try {
    while (queue.size) {
      // 数据目录已经换过：剩下的路径属于旧目录，继续跑就是往新索引里写脏数据
      if (myGen !== gen) break;
      const it = queue.entries().next().value;
      const p = it[0], o = it[1];
      queue.delete(p);
      let r = null;
      try { r = await indexFile(p, o); }
      catch (err) { r = { ok: false, error: String((err && err.message) || err) }; }
      if (r && r.ok && r.skipped) batch.skipped++;
      else if (!r || !r.ok) {
        batch.failed++;
        if (batch.errors.length < 8) batch.errors.push({ path: p, error: (r && r.error) || '未知错误' });
      } else batch.done++;
      // 旧代际的文件处理完了也不要广播：界面会以为新目录里多了这一条
      if (myGen === gen) {
        emitter.emit('change', {
          path: p, ok: !!(r && r.ok), skipped: !!(r && r.skipped),
          error: (r && r.error) || '', pending: queue.size,
        });
      }
    }
  } finally {
    draining = false;
    const b = batch || { done: 0, failed: 0, skipped: 0, startedAt: Date.now(), errors: [] };
    batch = null;
    if (myGen === gen && (b.done || b.failed || b.skipped)) {
      emitter.emit('idle', Object.assign({ ms: Date.now() - b.startedAt }, b));
    }
    // 换目录正好撞上批次收尾：新目录的任务已经进了 queue，但它的防抖计时器可能
    // 在 draining 为 true 时被我挡回去了，这里补一次交接。
    if (myGen !== gen && queue.size) setTimeout(drain, 0);
  }
}

function on(evt, fn) { emitter.on(evt, fn); }
function off(evt, fn) { emitter.off(evt, fn); }

module.exports = {
  start, stop, restart, call,
  search, stats, freshness, ping,
  indexFile, indexOne, indexAll, clear, removeForPath, moveIndex,
  scheduleIndex, pendingCount, on, off,
  modeOf: () => mode,
  // 仅供测试：确认当前是不是真的走 worker、会从哪个入口加载
  _workerScript: workerScript,
  _workerCandidates: workerCandidates,
};
