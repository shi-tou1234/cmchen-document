'use strict';
/*
 * 库统计（LibStats）的纯计算：给定条目数组，算出类型分布、年份分布、标签 Top、
 * 附件/笔记覆盖率和最近添加。不碰 DOM / IPC，Node 可单测；界面在 library-ui.js。
 *
 * 口径：回收站条目（deletedAt > 0）不计入统计，只在总数里单列。
 * UMD：Node 里 require 可测，浏览器里挂 window.LibStats。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LibStats = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  function alive(it) { return !(it && +it.deletedAt > 0); }

  function countBy(list, keyFn) {
    const m = new Map();
    for (const x of list) {
      const k = keyFn(x);
      if (k == null || k === '') continue;
      m.set(k, (m.get(k) || 0) + 1);
    }
    return m;
  }

  // 年份分桶：最近 N 年逐年 + 「更早」+「未知」；非 4 位年份一律算未知
  function yearBucket(year, recentN) {
    const y = String(year == null ? '' : year).trim();
    const m = /^(18|19|20|21)\d{2}$/.exec(y);
    if (!m) return '未知';
    const n = parseInt(y, 10);
    const thisYear = new Date().getFullYear();
    if (n >= thisYear - (recentN - 1) && n <= thisYear + 1) return y;
    return '更早';
  }

  // 分桶结果 → 面板要的有序行（最近年份倒序，更早 / 未知垫底）
  function yearRows(map, recentN) {
    const thisYear = new Date().getFullYear();
    const out = [];
    for (let y = thisYear + 1; y >= thisYear - (recentN - 1); y--) {
      const k = String(y);
      out.push({ year: k, count: map.get(k) || 0 });
      map.delete(k);
    }
    const early = map.get('更早') || 0, unknown = map.get('未知') || 0;
    if (early) out.push({ year: '更早', count: early });
    if (unknown) out.push({ year: '未知', count: unknown });
    return out;
  }

  // items：summary().items（publicItem 已含 notes/attachment/tags/deletedAt）
  function compute(items, opts) {
    const o = opts || {};
    const recentN = o.recentYears || 12;
    const topN = o.topTags || 15;
    const all = Array.isArray(items) ? items : [];
    const live = all.filter(alive);
    const trashed = all.length - live.length;

    const byTypeMap = countBy(live, (it) => String(it.itemType || 'document'));
    const byType = [...byTypeMap.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count || String(a.type).localeCompare(String(b.type)));

    // 出版年份：按条目 year 分桶（文献本身的年代）
    const byYear = yearRows(countBy(live, (it) => yearBucket(it.year, recentN)), recentN);
    // 入库年份：按 created（首次入库时间）分桶。和出版年份是两件事，
    // 面板上分开列——老文献今天导入，出版年份归「更早」，入库年份归今年（B12）。
    const byCreated = yearRows(countBy(live, (it) => {
      const t = +it.created || 0;
      return t > 0 ? yearBucket(String(new Date(t).getFullYear()), recentN) : '未知';
    }), recentN);

    const tagMap = countBy(live.flatMap((it) => (Array.isArray(it.tags) ? it.tags : [])).map((t) => String(t).trim()).filter(Boolean), (t) => t);
    const topTags = [...tagMap.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh-CN'))
      .slice(0, topN);

    const hasAtt = (it) => !!(it.attachment && (it.attachment.path || it.attachment.name));
    const withPdf = live.filter((it) => hasAtt(it) && /\.pdf$/i.test(String(it.attachment.path || it.attachment.name || ''))).length;
    const withAttachment = live.filter(hasAtt).length;
    const withNotes = live.filter((it) => Array.isArray(it.notes) && it.notes.some((n) => n && String(n.text || n.html || '').trim())).length;
    const withAnnos = live.filter((it) => Array.isArray(it.annoIds) && it.annoIds.length).length;

    const recent = live.slice()
      .sort((a, b) => (+b.created || 0) - (+a.created || 0))
      .slice(0, o.recentItems || 10)
      .map((it) => ({ key: it.key, title: String(it.title || '（无标题）'), created: +it.created || 0 }));

    return {
      total: live.length,
      trashed,
      byType,
      byYear,
      byCreated,
      topTags,
      withAttachment,
      withPdf,
      withNotes,
      withAnnos,
      recent,
    };
  }

  return { compute, yearBucket };
});
