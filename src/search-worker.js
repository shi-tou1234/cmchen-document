'use strict';
/*
 * 全文索引 worker（2026-10-29）。
 *
 * 为什么要有它：抽文本（pdfjs / docx / pptx 解析）和遍历索引文件都是纯 CPU + 同步 IO 的活，
 * 放在主进程里会把整窗输入、滚动、库列表刷新一起拖钝。搬进 worker 后，主进程只负责
 * 收结果、发广播；索引文件也只在 worker 里读写，主进程内存不再挂着那 32 MB 的条目缓存。
 *
 * 这个文件只做转发：真正的实现在 fulltext.js，Node 里可以脱离 worker 直接单测它。
 * 协议：主进程发 { id, cmd, args }，worker 回 { id, ok: true, result } 或 { id, ok: false, error }。
 */
const { parentPort, workerData } = require('worker_threads');
const fulltext = require('./fulltext.js');

const dataDir = (workerData && workerData.dataDir) || null;
fulltext.init(dataDir);

const CMDS = {
  search: (args) => fulltext.search(args[0]),
  stats: () => fulltext.stats(),
  // 批量新鲜度：状态面板要给每个条目比一次 mtime + size，放这里做才不占主进程
  freshness: (args) => {
    const list = Array.isArray(args[0]) ? args[0] : [];
    const out = [];
    for (const p of list) out.push(!!fulltext.isFresh(p));
    return out;
  },
  indexFile: (args) => fulltext.indexFile(args[0], args[1]),
  indexOne: (args) => fulltext.indexOne(args[0], args[1]),
  indexAll: (args) => fulltext.indexAll(args[0], args[1]),
  clear: () => fulltext.clear(),
  removeForPath: (args) => fulltext.removeForPath(args[0]),
  // 附件改名 / 重新定位后，索引文件跟着搬家（路径哈希变了）
  moveIndex: (args) => moveIndex(args[0], args[1]),
  ping: () => ({ ok: true, dir: fulltext.dirPath() }),
};

function moveIndex(oldPath, newPath) {
  if (!oldPath || !newPath) return { ok: false, error: '缺少路径' };
  const from = fulltext.fileFor(oldPath);
  const to = fulltext.fileFor(newPath);
  if (from === to) return { ok: true, moved: false };
  let raw;
  try { raw = require('fs').readFileSync(from, 'utf8'); } catch (_) { return { ok: true, moved: false }; }
  try {
    const entry = JSON.parse(raw);
    entry.path = newPath;
    require('./atomic-file').atomicWrite(to, JSON.stringify(entry));
    try { require('fs').unlinkSync(from); } catch (_) {}
    return { ok: true, moved: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

parentPort.on('message', async (msg) => {
  if (!msg || typeof msg.id !== 'number') return;
  const fn = CMDS[msg.cmd];
  if (!fn) {
    parentPort.postMessage({ id: msg.id, ok: false, error: '未知命令：' + String(msg.cmd) });
    return;
  }
  try {
    const result = await fn(Array.isArray(msg.args) ? msg.args : []);
    parentPort.postMessage({ id: msg.id, ok: true, result });
  } catch (err) {
    parentPort.postMessage({ id: msg.id, ok: false, error: String((err && err.message) || err) });
  }
});
