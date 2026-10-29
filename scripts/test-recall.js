'use strict';
/*
 * 回顾（间隔重复）数据层回归：调度序列、到期排序、统计口径、落盘与容错、清理与导入导出。
 * 纯 Node，不需要 Electron —— recall.js 里没有一行渲染代码。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const recall = require('../src/recall.js');

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 29, 2, 0, 0);   // 固定「现在」，别让测试跟着系统时间漂

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-recall-'));
let pass = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; return; }
  console.error('  FAIL ' + name + (extra === undefined ? '' : ' → ' + JSON.stringify(extra)));
  process.exitCode = 1;
}
function eq(name, a, b) { ok(name, a === b, { got: a, want: b }); }

try {
  // ---------- 一、调度 ----------
  const fresh = { addedAt: T0, due: T0, interval: 0, ease: 2.5, reps: 0, lapses: 0, last: 0, lastRating: 0 };

  const good1 = recall.schedule(fresh, 3, T0);
  eq('首次「记得」间隔 1 天', good1.interval, 1);
  eq('首次「记得」到期 = 现在 + 1 天', good1.due, T0 + DAY);
  eq('首次「记得」reps=1', good1.reps, 1);
  eq('首次「记得」ease 不变（q=4 增减为 0）', good1.ease, 2.5);
  eq('首次「记得」记下评分', good1.lastRating, 3);

  const easy1 = recall.schedule(fresh, 4, T0);
  eq('首次「太简单」间隔 3 天', easy1.interval, 3);
  eq('首次「太简单」ease +0.1', easy1.ease, 2.6);

  const good2 = recall.schedule(good1, 3, T0 + DAY);
  eq('第二次「记得」= 间隔 × ease（1×2.5 取整 3）', good2.interval, 3);

  const hard2 = recall.schedule(good1, 2, T0 + DAY);
  eq('「模糊」只拉长 20%（1→1）', hard2.interval, 1);
  eq('「模糊」ease -0.14', hard2.ease, 2.36);

  const again = recall.schedule(good2, 1, T0 + DAY * 4);
  eq('「忘了」间隔归零', again.interval, 0);
  eq('「忘了」连击清零', again.reps, 0);
  eq('「忘了」lapses +1', again.lapses, 1);
  eq('「忘了」10 分钟后再出现', again.due, T0 + DAY * 4 + 10 * 60 * 1000);
  eq('「忘了」ease -0.32', again.ease, 2.18);
  ok('「忘了」不会把 ease 压到 0', again.ease >= 1.3, again.ease);

  // ease 下限：连续答错也不会掉到 1.3 以下
  let drop = fresh;
  for (let i = 0; i < 8; i++) drop = recall.schedule(drop, 1, T0 + i * 1000);
  eq('ease 下限 1.3', drop.ease, 1.3);

  // 间隔上限：伪造一个已经很久的卡，太简单也不该算出超过 10 年
  const longCard = { addedAt: T0, due: T0, interval: 3000, ease: 2.5, reps: 9, lapses: 0, last: T0, lastRating: 3 };
  const capped = recall.schedule(longCard, 4, T0);
  eq('间隔封顶 3650 天', capped.interval, 3650);

  // 非法评分 → 当作「忘了」，不抛错
  const bogus = recall.schedule(fresh, 'x', T0);
  eq('非法评分按「忘了」处理', bogus.lastRating, 1);
  ok('非法评分后仍给出到期时间', bogus.due > T0, bogus.due);

  // 确定性：同样的输入必须给出同样的结果（复习时间的可预期性）
  const a1 = recall.schedule(good2, 3, T0 + DAY * 9);
  const a2 = recall.schedule(good2, 3, T0 + DAY * 9);
  eq('调度是确定性的', JSON.stringify(a1), JSON.stringify(a2));

  // ---------- 二、存储 ----------
  recall.init(dir);
  eq('空目录初始为 0 张', recall.stats(T0).total, 0);

  const add1 = recall.add(['r1', 'r2', 'r1', '', 'r3'], T0);
  eq('add 去重且忽略空 id', add1.added, 3);
  eq('add 报出跳过的条数', add1.skipped, 2);
  eq('新卡立刻到期', recall.stats(T0).due, 3);
  eq('新卡算「没复习过」', recall.stats(T0).never, 3);

  // 到期排序：逾期越久越先
  recall.rate('r1', 3, T0);                       // 1 天后到期
  recall.rate('r2', 3, T0 + DAY * 5);             // 已经逾期，但按 due 排
  const due = recall.dueList(T0 + DAY * 20, 30);
  ok('到期列表按到期时间升序', due.length === 3 && due[0].due <= due[due.length - 1].due,
    due.map((c) => c.id + '@' + ((c.due - T0) / DAY)).join(','));
  eq('r3 从未复习仍在到期列表里', due.some((c) => c.id === 'r3'), true);
  eq('limit 生效（最多 1 张）', recall.dueList(T0 + DAY * 20, 1).length, 1);
  eq('limit 上限被夹到会话上限', recall.dueList(T0 + DAY * 20, 999).length, 3);

  // 落盘：重新 init 读回来
  recall.init(dir);
  eq('重新读取后卡片还在', recall.stats(T0 + DAY * 20).total, 3);
  eq('已复习张数被记住', recall.stats(T0 + DAY * 20).learned, 2);

  const st = recall.stats(T0 + DAY * 20);
  ok('nextDue 是「未来最近的到期」或 0', st.nextDue === 0 || st.nextDue > T0 + DAY * 20, st.nextDue);

  // 「今日已完成」按自然日算
  const todayBase = new Date(T0);
  todayBase.setHours(12, 0, 0, 0);
  const t12 = todayBase.getTime();
  recall.clear();
  recall.add(['d1'], t12);
  recall.rate('d1', 3, t12);
  eq('今天评过一张 → 今日已完成 1', recall.stats(t12 + 3600e3).todayDone, 1);
  eq('跨天后今日已完成归零', recall.stats(t12 + DAY).todayDone, 0);

  // 删除与清理
  recall.remove('d1');
  eq('remove 后卡片消失', recall.stats(t12).total, 0);

  recall.clear();
  recall.add(['a1', 'a2', 'a3'], T0);
  const pr = recall.prune(['a1'], T0);
  eq('prune 清掉没有标注的卡片', pr.removed, 2);
  eq('prune 后只剩 1 张', recall.stats(T0).total, 1);
  const prEmpty = recall.prune([], T0);
  eq('空集合时 prune 不动手', prEmpty.skipped, true);
  eq('空集合后卡片仍在', recall.stats(T0).total, 1);

  // 导出 / 导入
  const dump = recall.exportStore();
  recall.clear();
  eq('clear 之后为空', recall.stats(T0).total, 0);
  recall.importStore(dump, T0);
  eq('import 恢复卡片', recall.stats(T0).total, 1);
  ok('import 之后到期时间原样保留', recall.cardOf('a1').due === dump.cards.a1.due, recall.cardOf('a1').due);

  // 坏文件容错：手写坏了不能崩，也不能把好字段丢掉
  fs.writeFileSync(path.join(dir, 'recall.json'), '{ this is not json');
  recall.init(dir);
  eq('坏 JSON 退回空库且不抛错', recall.stats(T0).total, 0);

  fs.writeFileSync(path.join(dir, 'recall.json'), JSON.stringify({ version: 1, cards: {
    bad1: { due: 'x', interval: -5, ease: 0.1, reps: 'y', lapses: null, last: 'z', lastRating: 99 },
    bad2: null,
    '': { due: T0 },
    good: { due: T0, interval: 2, ease: 2.5, reps: 1, lapses: 0, last: T0, lastRating: 3 },
  } }));
  recall.init(dir);
  eq('坏卡片被丢掉、好卡片保留', recall.stats(T0).total, 2);
  const b1 = recall.cardOf('bad1');
  eq('interval 负数被夹到 0', b1.interval, 0);
  eq('ease 低于下限被夹到 1.3', b1.ease, 1.3);
  eq('未知评分被归零', b1.lastRating, 0);
  eq('due 非数字退回 addedAt', typeof b1.due, 'number');

  // 恢复备份里的「空」不该把现有进度清掉（主进程只在备份带 recall 时才调用 import）
  eq('import 空对象报错', recall.importStore(null).ok, false);

  // ---- R4-03：写盘失败必须如实报错，内存与磁盘都不能变 ----
  // 注入的是 fs.renameSync 的 EACCES：recall.js 与测试共用同一个 fs 模块对象，
  // 所以这一下正好打在 persist() 的「临时文件改名」那一步。
  recall.clear();
  recall.add(['w1', 'w2'], T0);
  const diskBefore = fs.readFileSync(path.join(dir, 'recall.json'), 'utf8');
  const realRename = fs.renameSync;
  let rated, addedBad, removedBad, clearedBad, importedBad;
  fs.renameSync = () => { const e = new Error('injected rename failure'); e.code = 'EACCES'; throw e; };
  try {
    rated = recall.rate('w1', 3, T0);
    addedBad = recall.add(['w3'], T0);
    removedBad = recall.remove('w2');
    clearedBad = recall.clear();
    importedBad = recall.importStore({ version: 1, cards: { z9: { due: T0 } } }, T0);
  } finally { fs.renameSync = realRename; }
  eq('评分写盘失败 → ok:false', rated.ok, false);
  ok('评分失败的报错说得出原因', /写入磁盘|没有保存/.test(String(rated.error)), rated.error);
  eq('评分失败后内存回滚（reps 仍 0）', recall.cardOf('w1').reps, 0);
  eq('加入失败 → ok:false', addedBad.ok, false);
  eq('加入失败后没有留下半张卡', recall.cardOf('w3'), null);
  eq('移出失败 → ok:false', removedBad.ok, false);
  ok('移出失败后卡片还在', !!recall.cardOf('w2'), String(removedBad.error));
  eq('清空失败 → ok:false', clearedBad.ok, false);
  eq('清空失败后卡片还在', recall.stats(T0).total, 2);
  eq('恢复失败 → ok:false', importedBad.ok, false);
  eq('恢复失败后没有被替换成备份内容', recall.stats(T0).total, 2);
  eq('磁盘内容一字未改', fs.readFileSync(path.join(dir, 'recall.json'), 'utf8'), diskBefore);
  // 报错路径不能留下 .tmp 残骸
  const leftovers = fs.readdirSync(dir).filter((f) => /\.tmp$/.test(f));
  eq('失败后没有留下临时文件', leftovers.length, 0);

  // 文件路径可查（主进程日志 / 文档用）
  ok('存储路径在 userData 下', recall.filePath() === path.join(dir, 'recall.json'), recall.filePath());

  console.log('test-recall: ' + pass + ' checks passed');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
