'use strict';
/*
 * 回顾（间隔重复复习）：把标注变成需要复习的卡片。
 *
 * 移植自两个竞品的同一套思路 —— MarginNote 的「摘录自动成卡 + FSRS 复习」与
 * Readwise 的「Daily Review 每天把高亮推回你眼前」。Trove 这边标注、标签、页码、
 * 所属条目都已经在库里，缺的只是「什么时候再看一遍」这一层，
 * 所以这个模块只做纯数据：卡片状态 + 调度，不碰渲染（渲染在 library-ui 的回顾面板）。
 *
 * 调度用 SM-2 的骨架（Anki / SuperMemo 一系），刻意保持可预测：
 *   评分 1 忘了 / 2 模糊 / 3 记得 / 4 太简单 → SM-2 的 q = 2 / 3 / 4 / 5
 *   EF' = EF + (0.1 - (5-q) * (0.08 + (5-q) * 0.02))，下限 1.3
 *   q < 3（忘了）：连击清零、间隔归零，10 分钟后再出现一次
 *   首次答对：记得 1 天、太简单 3 天
 *   之后：模糊 = 间隔 × 1.2，记得 = 间隔 × EF，太简单 = 间隔 × EF × 1.3
 * 不用 FSRS 是有意的：FSRS 要按复习历史拟合记忆稳定性，这里没有历史可拟合，
 * 而且用户要的是「今天该看哪几条」，不是一条最优保留率曲线。
 *
 * 卡片键就是标注 id（阅读器与标注库里的同一个 id），所以改文字、改颜色、加标签
 * 都不影响复习记录；标注被删掉时由 prune() 清掉对应卡片。
 */
const fs = require('fs');
const path = require('path');

const DAY = 24 * 60 * 60 * 1000;
const MIN_EASE = 1.3;
const MAX_INTERVAL = 3650;              // 天，10 年封顶
const MAX_CARDS = 20000;
const AGAIN_DELAY = 10 * 60 * 1000;     // 「忘了」→ 本轮 10 分钟后再抽到
const SESSION_MAX = 30;                 // 一次最多复习这么多张，做不完明天见
const RATINGS = [1, 2, 3, 4];
const Q_OF = { 1: 2, 2: 3, 3: 4, 4: 5 };

let dir = null;
let store = null;

function emptyStore() { return { version: 1, cards: {} }; }
function filePath() { return path.join(dir, 'recall.json'); }

function num(v, dflt) { const n = Number(v); return Number.isFinite(n) ? n : dflt; }
function clampRating(v) { const n = Math.round(num(v, 1)); return RATINGS.indexOf(n) >= 0 ? n : 1; }

// 读盘时逐字段校验：这是用户能直接编辑的 JSON，坏一个字段不该拖垮整个回顾。
function sanitizeCard(c, now) {
  if (!c || typeof c !== 'object') return null;
  const addedAt = Math.max(0, Math.round(num(c.addedAt, now)));
  const lr = Math.round(num(c.lastRating, 0));
  return {
    addedAt,
    due: Math.max(0, Math.round(num(c.due, addedAt))),
    interval: Math.max(0, Math.min(MAX_INTERVAL, num(c.interval, 0))),
    ease: Math.max(MIN_EASE, Math.min(5, num(c.ease, 2.5))),
    reps: Math.max(0, Math.round(num(c.reps, 0))),
    lapses: Math.max(0, Math.round(num(c.lapses, 0))),
    last: Math.max(0, Math.round(num(c.last, 0))),
    lastRating: lr >= 0 && lr <= 4 ? lr : 0,
  };
}

function sanitize(obj, now) {
  const out = emptyStore();
  const cards = obj && obj.cards && typeof obj.cards === 'object' ? obj.cards : {};
  let n = 0;
  for (const [id, raw] of Object.entries(cards)) {
    const key = String(id || '').trim();
    if (!key || key.length > 200) continue;
    const card = sanitizeCard(raw, now);
    if (!card) continue;
    out.cards[key] = card;
    if (++n >= MAX_CARDS) break;
  }
  return out;
}

function load() {
  if (!dir) return emptyStore();
  try {
    let raw = fs.readFileSync(filePath(), 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    return sanitize(JSON.parse(raw), Date.now());
  } catch (_) { return emptyStore(); }
}

// 先写临时文件再改名：复习记录写一半比重新学一遍还难受。
// 返回 false 表示没写进去——调用方必须回滚内存并如实报错，否则界面以为评分成功了，
// 重启后又回到旧进度（第四轮审核 R4-03）。
let lastError = '';
function persist() {
  if (!dir) { lastError = '回顾记录目录还没就绪'; return false; }
  const target = filePath();
  const tmp = target + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(store));
    fs.renameSync(tmp, target);
    lastError = '';
    return true;
  } catch (err) {
    lastError = String((err && (err.code || err.message)) || err);
    try { fs.unlinkSync(tmp); } catch (_) {}
    return false;
  }
}

function saveFailed(what) {
  return { ok: false, error: (what || '复习进度') + '没能写入磁盘（' + (lastError || '未知原因') + '），这次改动没有保存' };
}

// 回滚用：卡片数量最多两万，整份拷贝比逐条记录改动更不容易漏。
function snapshot() { return store ? Object.assign({ version: store.version, cards: Object.assign({}, store.cards) }, {}) : null; }
function settleError(snap, what) { if (snap) store = snap; return saveFailed(what); }

function init(d) {
  dir = d || dir;
  store = load();
  return stats();
}

// 下一次复习时间完全由 (卡片, 评分, 现在) 决定：同样的操作得到同样的结果，方便单测。
function schedule(card, rating, now) {
  const at = num(now, Date.now());
  const r = clampRating(rating);
  const q = Q_OF[r];
  const c = sanitizeCard(card, at) || sanitizeCard(null, at);
  let ease = c.ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
  if (ease < MIN_EASE) ease = MIN_EASE;
  if (ease > 5) ease = 5;
  const next = Object.assign({}, c, { ease: Math.round(ease * 1000) / 1000, last: at, lastRating: r });
  if (q < 3) {
    next.reps = 0;
    next.lapses = c.lapses + 1;
    next.interval = 0;
    next.due = at + AGAIN_DELAY;
    return next;
  }
  const prev = c.interval;
  let days;
  if (!prev) days = q === 5 ? 3 : 1;
  else if (q === 3) days = Math.round(prev * 1.2);
  else if (q === 5) days = Math.round(prev * next.ease * 1.3);
  else days = Math.round(prev * next.ease);
  days = Math.max(1, Math.min(MAX_INTERVAL, days));
  next.reps = c.reps + 1;
  next.interval = days;
  next.due = at + days * DAY;
  return next;
}

function add(ids, now) {
  const at = num(now, Date.now());
  if (!store) store = emptyStore();
  const list = Array.isArray(ids) ? ids : [];
  const before = snapshot();
  let added = 0, skipped = 0, full = 0;
  for (const raw of list) {
    const id = String(raw || '').trim();
    if (!id || id.length > 200) { skipped++; continue; }
    if (store.cards[id]) { skipped++; continue; }
    if (Object.keys(store.cards).length >= MAX_CARDS) { full++; break; }
    // 新卡立刻到期：加进回顾就该能复习，不留「明天才开始」的空窗
    store.cards[id] = { addedAt: at, due: at, interval: 0, ease: 2.5, reps: 0, lapses: 0, last: 0, lastRating: 0 };
    added++;
  }
  if (added && !persist()) {
    return Object.assign(settleError(before, '加入回顾'), { added: 0, skipped, full, total: Object.keys(store.cards).length });
  }
  return { ok: true, added, skipped, full, total: Object.keys(store.cards).length };
}

function rate(id, rating, now) {
  const key = String(id || '').trim();
  if (!store) store = emptyStore();
  if (!key || !store.cards[key]) return { ok: false, error: '这张卡不在回顾里' };
  const at = num(now, Date.now());
  const prev = store.cards[key];
  store.cards[key] = schedule(prev, rating, at);
  if (!persist()) {
    // 内存回滚：界面停在当前这张卡，「刚才那一下」还可以再点一次
    store.cards[key] = prev;
    return Object.assign(saveFailed('这次评分'), { id: key, card: prev, stats: stats(at) });
  }
  return { ok: true, id: key, card: store.cards[key], stats: stats(at) };
}

function remove(id) {
  const key = String(id || '').trim();
  if (!store || !key || !store.cards[key]) return { ok: false, removed: 0, stats: stats(Date.now()) };
  const prev = store.cards[key];
  delete store.cards[key];
  if (!persist()) {
    store.cards[key] = prev;
    return Object.assign(saveFailed('移出回顾'), { removed: 0, stats: stats(Date.now()) });
  }
  return { ok: true, removed: 1, stats: stats(Date.now()) };
}

function has(id) { return !!(store && store.cards[String(id || '').trim()]); }
function all() { return store ? store.cards : {}; }
function cardOf(id) { return (store && store.cards[String(id || '').trim()]) || null; }

// 到期卡：按到期时间升序（逾期最久的最先），一次最多 limit 张。
function dueList(now, limit) {
  const at = num(now, Date.now());
  const cap = Math.max(1, Math.min(SESSION_MAX, Math.round(num(limit, SESSION_MAX))));
  const out = [];
  for (const [id, c] of Object.entries(store ? store.cards : {})) {
    if (c.due > at) continue;
    out.push({ id, due: c.due, interval: c.interval, reps: c.reps, lapses: c.lapses, last: c.last, lastRating: c.lastRating, addedAt: c.addedAt });
  }
  out.sort((a, b) => (a.due - b.due) || a.id.localeCompare(b.id));
  return out.slice(0, cap);
}

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function stats(now) {
  const at = num(now, Date.now());
  const cards = store ? store.cards : {};
  const ids = Object.keys(cards);
  const day0 = startOfDay(at);
  let due = 0, never = 0, todayDone = 0, nextDue = 0, learned = 0;
  for (const id of ids) {
    const c = cards[id];
    if (c.due <= at) due++;
    if (!c.last) never++;
    else {
      learned++;
      if (c.last >= day0) todayDone++;
    }
    if (c.due > at && (!nextDue || c.due < nextDue)) nextDue = c.due;
  }
  return { total: ids.length, due, never, learned, todayDone, nextDue };
}

// 标注被删掉之后，卡片留着只会让「待复习」永远清不掉。
// 但「扫不到」和「被删了」是两件事：第三个参数 complete === false（有标注文件读失败）
// 时一律不动手——一次 IO 抖动不该把几个月的复习进度清空（第四轮审核 R4-01）。
function prune(validIds, now, opts) {
  const o = opts || {};
  const valid = validIds instanceof Set ? validIds : new Set(Array.isArray(validIds) ? validIds : []);
  if (o.complete === false) return { ok: true, removed: 0, skipped: true, reason: 'incomplete-scan' };
  if (!store || !valid.size) return { ok: true, removed: 0, skipped: true };
  const removedCards = [];
  for (const id of Object.keys(store.cards)) {
    if (valid.has(id)) continue;
    removedCards.push([id, store.cards[id]]);
    delete store.cards[id];
  }
  const removed = removedCards.length;
  if (removed && !persist()) {
    for (const [id, card] of removedCards) store.cards[id] = card;
    return Object.assign(saveFailed('清理回顾'), { removed: 0, skipped: true, stats: stats(num(now, Date.now())) });
  }
  return { ok: true, removed, stats: stats(num(now, Date.now())) };
}

function exportStore() {
  const cards = {};
  for (const [id, c] of Object.entries(store ? store.cards : {})) cards[id] = Object.assign({}, c);
  return { version: 1, cards };
}

// 恢复备份时整份替换：复习进度是「状态」不是「条目」，合并两份只会得到互相矛盾的到期时间。
function importStore(obj, now) {
  if (!obj || typeof obj !== 'object') return { ok: false, error: '备份里没有回顾记录' };
  const before = snapshot();
  store = sanitize(obj, num(now, Date.now()));
  if (!persist()) return settleError(before, '恢复回顾记录');
  return { ok: true, total: Object.keys(store.cards).length };
}

function clear() {
  const before = snapshot();
  const n = store ? Object.keys(store.cards).length : 0;
  store = emptyStore();
  if (!persist()) return Object.assign(settleError(before, '清空回顾'), { removed: 0 });
  return { ok: true, removed: n };
}

module.exports = {
  init, schedule, add, rate, remove, has, all, cardOf, dueList, stats, prune,
  exportStore, importStore, clear, filePath,
  constants: { DAY, MIN_EASE, MAX_INTERVAL, MAX_CARDS, AGAIN_DELAY, SESSION_MAX },
};
