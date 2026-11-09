'use strict';
/*
 * 文献库开销基准（审查报告第 3 节）。用同一套夹具对比「改一个小字段要做多少全量工作」。
 *
 * 测什么：
 *   · summary()            列表刷新一次
 *   · setPageByKey()       保存一页阅读进度
 *   · updateItem()         改一个标题（撤销栈已换差量：不再前后各快照一次整库）
 *   · 20 个撤销点占多少字符（旧实现 = 20 份整库 JSON）
 *   · 一次 summary 触发多少次文件系统探测（附件存在性）
 *
 * 不测什么：端到端 IPC 延迟、真实用户库、网络盘。夹具是合成数据，绝对值只能横向比。
 * 运行：node scripts/bench-library.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const lib = require('../src/library.js');

const SIZES = (process.env.BENCH_SIZES || '100,1000,10000').split(',').map((x) => +x);

// 统计 JSON.stringify 与 existsSync 的调用次数/字节（同一进程内替换，只影响本次基准）
const realStringify = JSON.stringify;
const realExists = fs.existsSync;
let strCalls = 0, strBytes = 0, statCalls = 0;
let bigCalls = 0, bigBytes = 0;   // 只数「整库级」序列化（>100 KB），局部的字段比较不算

function instrument() {
  JSON.stringify = function (...args) {
    const out = realStringify.apply(JSON, args);
    strCalls++;
    if (typeof out === 'string') {
      strBytes += out.length;
      if (out.length > 100000) { bigCalls++; bigBytes += out.length; }
    }
    return out;
  };
  fs.existsSync = function (...args) { statCalls++; return realExists.apply(fs, args); };
}
function restore() { JSON.stringify = realStringify; fs.existsSync = realExists; }

function ms(fn, times) {
  const n = times || 3;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) fn(i);
  const t1 = process.hrtime.bigint();
  return Math.round(Number(t1 - t0) / 1e6 / n * 100) / 100;
}

function build(count, dir) {
  const items = [];
  for (let i = 0; i < count; i++) {
    items.push({
      key: 'k' + i,
      itemType: 'journalArticle',
      title: '合成条目 ' + i,
      year: String(1990 + (i % 30)),
      abstract: 'A'.repeat(400),
      tags: ['t' + (i % 50)],
      // 故意让每条各指一个不存在的路径：这是「去重帮不上忙、只能靠 TTL 缓存」的最坏情况
      attachment: { path: path.join(dir, 'files', 'doc-' + i + '.pdf'), name: 'doc-' + i + '.pdf' },
      notes: [{ id: 'n' + i, title: '笔记 ' + i, text: 'B'.repeat(200), html: '', meta: { tags: [], status: '' } }],
    });
  }
  return {
    version: 8, collections: [], searches: [], tagColors: {}, annoTags: {}, annoMeta: {},
    feeds: [], noteAliases: {}, items,
  };
}

const rows = [];
for (const n of SIZES) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-bench-' + n + '-'));
  fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
  process.env.PDFREADER_LIBRARY = path.join(dir, 'library.json');
  lib.init();               // 每个夹具一个独立库文件
  lib.resetCache(); lib.resetUndo();
  fs.writeFileSync(process.env.PDFREADER_LIBRARY, JSON.stringify(build(n, dir)));
  lib.resetCache();

  const bytes = fs.statSync(process.env.PDFREADER_LIBRARY).size;

  // 冷启动第一次 summary：附件缓存是空的（最坏情况）——必须是最先跑的那次
  instrument();
  statCalls = 0; strCalls = 0; strBytes = 0;
  const t0 = process.hrtime.bigint();
  const coldSummary = lib.summary();
  const coldMs = Math.round(Number(process.hrtime.bigint() - t0) / 1e6 * 100) / 100;
  const coldStats = statCalls;
  const coldStr = strBytes;
  restore();
  if (coldSummary.items.length !== n) throw new Error('夹具条目数不对');

  // 热摘要：再刷两次（TTL 缓存命中）
  const summaryMs = ms(() => lib.summary(), 3);

  instrument();
  statCalls = 0;
  lib.summary();
  const warmStats = statCalls;
  restore();

  const pageMs = ms((i) => lib.setPageByKey('k' + i, 10 + i, 100), 3);

  bigCalls = 0; bigBytes = 0; strCalls = 0; strBytes = 0;
  instrument();
  const updMs = ms((i) => lib.updateItem('k' + i, { title: '改过的标题 ' + i }), 3);
  const updBigCalls = bigCalls, updBigBytes = bigBytes;
  restore();

  // 20 个撤销点：每点改一条条目的标签
  lib.resetUndo();
  for (let i = 0; i < 20; i++) lib.addTag('k' + i, 'bench' + i);
  const undo = lib.undoStats();

  rows.push({
    n,
    bytes,
    coldMs, coldStats, coldStr,
    summaryMs, warmStats,
    pageMs,
    updMs, updBigCalls, updBigBytes,
    undoChars: undo.chars, undoDepth: undo.depth,
  });
}

const kb = (b) => (b / 1024).toFixed(1) + ' KB';
const mb = (b) => (b / 1024 / 1024).toFixed(2) + ' MB';
console.log('\n| 条目数 | 库大小 | summary 首次(冷) | 首次 FS 探测 | summary 之后(热) | 热 FS 探测 | 保存页码 | 改标题 | 改标题的整库序列化 |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const r of rows) {
  console.log('| ' + r.n + ' | ' + kb(r.bytes) + ' | ' + r.coldMs + ' ms | ' + r.coldStats + ' 次 | '
    + r.summaryMs + ' ms | ' + r.warmStats + ' 次 | ' + r.pageMs + ' ms | ' + r.updMs + ' ms | '
    + r.updBigCalls + ' 次 / ' + mb(r.updBigBytes) + ' |');
}
console.log('\n| 条目数 | 20 个撤销点占字符 | 相当于整库的 |');
console.log('| --- | --- | --- |');
for (const r of rows) {
  console.log('| ' + r.n + ' | ' + kb(r.undoChars) + ' | ' + (r.undoChars / r.bytes * 100).toFixed(2) + '% |');
}
console.log('');
