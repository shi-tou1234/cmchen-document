'use strict';
/*
 * 阅读时长统计（Calibre reading stats 的本地化实现）的纯逻辑。
 *
 * 数据形态（存储在 userData/reading-stats.json）：
 *   { version: 1, days: { 'YYYY-MM-DD': { '<path>': seconds, ... }, ... } }
 * 按天 × 文档路径记秒；路径只作为聚合键（换目录后旧路径仍在，聚合视图按天合计不受影响）。
 *
 * 原则：合并单向累加（渲染进程本地攒一段、落盘时与磁盘文件合并），
 * 不用时钟差值回推，丢几次心跳只少记几十秒，不会算错。
 * UMD：Node 里 require 可测，浏览器里挂 window.ReadingStats。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ReadingStats = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  function dayOf(ts) {
    const d = new Date(ts || Date.now());
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function empty() { return { version: 1, days: {} }; }

  function normalize(raw) {
    const out = empty();
    const src = raw && typeof raw === 'object' ? raw : {};
    if (src.days && typeof src.days === 'object') {
      for (const day of Object.keys(src.days)) {
        const doc = src.days[day];
        if (!doc || typeof doc !== 'object') continue;
        // 日期键必须是真实存在的 YYYY-MM-DD（2026-13-99 这类直接丢弃）
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || isNaN(Date.parse(day + 'T00:00:00'))) continue;
        const dd = {};
        for (const k of Object.keys(doc)) {
          const n = +doc[k];
          if (Number.isFinite(n) && n > 0 && n < 24 * 3600) dd[String(k).slice(0, 400)] = Math.round(n);
        }
        if (Object.keys(dd).length) out.days[day] = dd;
      }
    }
    return out;
  }

  // 累加一次心跳：stats.days[day][path] += seconds（上限单次 1 小时，防手滑）
  function addSpan(stats, ts, path, seconds) {
    const st = stats && typeof stats === 'object' ? stats : empty();
    if (!st.days) st.days = {};
    const sec = +seconds;
    if (!path || !Number.isFinite(sec) || sec <= 0) return st;
    const day = dayOf(ts);
    const dd = st.days[day] || (st.days[day] = {});
    const key = String(path).slice(0, 400);
    dd[key] = Math.min(dd[key] || 0, 24 * 3600) + Math.min(Math.round(sec), 3600);
    return st;
  }

  // 合并两份统计（落盘时：磁盘文件 + 本地未落盘增量）。同键取大者？不——累加语义下
  // 两份来自同一会话的拆分，直接相加；但合并磁盘与内存时内存里可能已含磁盘的旧值，
  // 所以调用方必须保证「内存增量」是独立累计的（本应用按此约定）。
  function merge(a, b) {
    const out = normalize(a);
    const add = normalize(b);
    for (const day of Object.keys(add.days)) {
      const dd = out.days[day] || (out.days[day] = {});
      for (const k of Object.keys(add.days[day])) dd[k] = (dd[k] || 0) + add.days[day][k];
    }
    return out;
  }

  // 聚合：总时长、最近 nDays 天逐日、按文档 Top。today 传 'YYYY-MM-DD' 可让测试确定性。
  function aggregate(stats, opts) {
    const o = opts || {};
    const days = (stats && stats.days) || {};
    const today = o.today || dayOf(Date.now());
    const nDays = Math.max(1, +o.nDays || 84);   // 默认 12 周
    // 最近 nDays 天的日期序列（含今天）
    const seq = [];
    const t = new Date(today + 'T00:00:00');
    for (let i = nDays - 1; i >= 0; i--) {
      const d = new Date(t.getTime() - i * 86400000);
      const p = (n) => String(n).padStart(2, '0');
      seq.push(d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()));
    }
    const byDay = seq.map((d) => ({
      day: d,
      seconds: Object.values(days[d] || {}).reduce((a, b) => a + b, 0),
    }));
    const docMap = {};
    let total = 0;
    for (const day of Object.keys(days)) {
      for (const k of Object.keys(days[day])) {
        const sec = days[day][k];
        total += sec;
        docMap[k] = (docMap[k] || 0) + sec;
      }
    }
    const byDoc = Object.keys(docMap)
      .map((p) => ({ path: p, seconds: docMap[p] }))
      .sort((a, b) => b.seconds - a.seconds)
      .slice(0, o.topDocs || 8);
    const rangeTotal = byDay.reduce((a, b) => a + b.seconds, 0);
    return {
      totalSeconds: total,
      rangeTotalSeconds: rangeTotal,
      byDay,
      byDoc,
      activeDays: byDay.filter((d) => d.seconds > 0).length,
    };
  }

  function fmtDuration(seconds) {
    const s = Math.max(0, Math.round(seconds));
    const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
    if (h > 0) return h + ' 小时 ' + m + ' 分';
    if (m > 0) return m + ' 分钟';
    return s + ' 秒';
  }

  return { dayOf, empty, normalize, addSpan, merge, aggregate, fmtDuration };
});
