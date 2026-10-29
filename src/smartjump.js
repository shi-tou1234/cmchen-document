'use strict';
/*
 * 智能跳转（Smart Jump）的纯逻辑，借鉴 Sioyek 的同名功能：
 * 点正文里的引用标记（[12]、[3,5]、[Smith, 2020]、(Smith et al., 2020)）跳到
 * 参考文献表里对应条目；点参考文献条目反查正文里的引用标记。
 *
 * PDF 里这些引用几乎都没有超链接，只能靠「读文字」：本模块只做文字判定
 * （正则 + 行匹配），不碰 DOM / 坐标，Node 可单测。
 * 渲染层（renderer.js）负责：把 PDF.js 文本项组成行、定位点击字符、跳页和高亮。
 *
 * UMD：Node 里 require 可测，浏览器里挂 window.SmartJump。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SmartJump = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // ---------- 引用标记识别 ----------

  // 数字型：[12] / [3, 5] / [12-15] / [8,12,20]
  const NUMERIC = /\[([ \t]*\d{1,3}(?:[ \t]*[,;–—-][ \t]*\d{1,3}){0,6}[ \t]*)\]/g;
  // 作者-年份（方括号 / 圆括号）：[Smith, 2020] / [Smith et al., 2020] / (Smith & Jones, 2019)。
  // 先宽松抓出「文字 + 年份」，再用 validNames 校验里层确实是人名列表（纯字母与分隔符、
  // 首字母大写），避免把日期、图表号误当引用。
  const AY_BRACKET = /\[([A-Za-z][\w'’\-.,&; ]*?)[ \t]*,?[ \t]*((?:19|20)\d{2})[a-z]?\]/g;
  const AY_PAREN = /\(([^()[\]]{2,80}?)[ \t]*,?[ \t]*((?:19|20)\d{2})[a-z]?\)/g;

  function validNames(inner) {
    const s = String(inner || '').trim();
    if (!/^[A-Z][A-Za-z0-9'’\-.,&; ]*$/.test(s)) return false;
    return /[A-Za-z]/.test(s);
  }

  function splitNumbers(inner) {
    const out = [];
    // "3, 12-15" → 3,12,13,14,15（区间展开有上限，防止手滑写成 [1-999]）
    for (const part of inner.split(/[,;]/)) {
      const seg = part.trim();
      if (!seg) continue;
      const range = /^(\d{1,3})[ \t]*[–—-][ \t]*(\d{1,3})$/.exec(seg);
      if (range) {
        const a = parseInt(range[1], 10), b = parseInt(range[2], 10);
        if (a >= 1 && b >= a && b - a <= 30) for (let n = a; n <= b; n++) out.push(n);
        continue;
      }
      const n = parseInt(seg, 10);
      if (n >= 1 && n <= 999) out.push(n);
    }
    return out;
  }

  // 从上下文里找出「包含 caretIndex 这个字符」的引用标记。
  // context：点击位置附近的一段正文（由渲染层拼接）；caretIndex：点击字符在 context 里的下标。
  // 返回 null 或：
  //   { kind:'numeric', numbers:[..], start, end }
  //   { kind:'authoryear', surname, year, start, end }
  function extractCitation(context, caretIndex) {
    const s = String(context || '');
    const ci = Math.max(0, Math.min(caretIndex, s.length - 1));
    if (ci < 0 || !s.length) return null;
    let best = null;
    const consider = (m, kind, extra) => {
      if (m.index <= ci && ci < m.index + m[0].length) {
        if (!best || m[0].length > best.len) best = Object.assign({ kind, start: m.index, end: m.index + m[0].length, len: m[0].length }, extra);
      }
    };
    let m;
    NUMERIC.lastIndex = 0;
    while ((m = NUMERIC.exec(s))) consider(m, 'numeric', { numbers: splitNumbers(m[1]) });
    AY_BRACKET.lastIndex = 0;
    while ((m = AY_BRACKET.exec(s))) {
      if (!validNames(m[1])) continue;
      const surname = (/^[ \t]*([A-Z][\w'’\-]*)/.exec(m[1]) || [])[1] || '';
      if (surname) consider(m, 'authoryear', { surname, year: m[2] });
    }
    AY_PAREN.lastIndex = 0;
    while ((m = AY_PAREN.exec(s))) {
      // 里层必须是人名列表，避免把 (2020-01) 这类日期误当引用
      if (!validNames(m[1])) continue;
      const head = /^[ \t]*([A-Z][\w'’\-]*)/.exec(m[1]);
      if (!head) continue;
      consider(m, 'authoryear', { surname: head[1], year: m[2] });
    }
    if (!best) return null;
    delete best.len;
    return best;
  }

  // ---------- 参考文献表识别与条目匹配 ----------

  // 行文本是否是「参考文献」标题。允许整行就是这个词（前后可带少量装饰）。
  function isBibHeading(text) {
    const t = String(text || '').trim().replace(/^[—–-\s]+|[—–-\s:.]+$/g, '');
    return /^(references|bibliography|works cited|reference list|literature cited|参考文献|參考文獻|参考文献表)$/i.test(t);
  }

  // 行文本是否是参考文献里编号为 num 的条目："12." / "12)" / "[12]" / "12 " 开头
  function matchNumericLine(text, num) {
    const t = String(text || '').trim();
    const n = String(num);
    return new RegExp('^[ \\t]*(?:[\\[（(]' + n + '[\\]）).]|[\\[（(]' + n + '[ \\t]|[\\[（(]' + n + '\\]|' + n + '[.）、)]?[ \\t])').test(t)
      || new RegExp('^[ \\t]*[\\[（(]' + n + '[\\]）)]').test(t);
  }

  // 行文本是否包含姓氏 + 年份（参考文献条目行）。姓氏做词边界匹配。
  function matchAuthorYearLine(text, surname, year) {
    const t = String(text || '');
    if (!surname || !year) return false;
    const nameRe = new RegExp('(^|[^A-Za-z])' + surname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z])');
    return nameRe.test(t) && t.indexOf(String(year)) >= 0;
  }

  // 在 docLines（跨页行数组，元素 {page,text,...}）里从头往后找第一个参考文献标题行
  function findBibStartIndex(docLines, fromIdx) {
    for (let i = Math.max(0, fromIdx | 0); i < docLines.length; i++) {
      if (isBibHeading(docLines[i].text)) return i;
    }
    return -1;
  }

  // 在参考文献区（bibStart 之后）找目标条目所在的行下标；找不到返回 -1
  function findEntryLine(docLines, bibStart, target) {
    for (let i = bibStart + 1; i < docLines.length; i++) {
      const t = docLines[i].text;
      if (target.numbers && target.numbers.some((n) => matchNumericLine(t, n))) return i;
      if (target.surname && target.year && matchAuthorYearLine(t, target.surname, target.year)) return i;
    }
    return -1;
  }

  // 反查：在一段页面文本里找出所有指向 target 条目的引用标记位置。
  // 返回 [{ start, end }]，最多 max 条（防止一篇综述几十个标记全画）。
  function findMarkerPositions(text, target, max) {
    const s = String(text || '');
    const cap = max || 40;
    const out = [];
    let m;
    if (target.numbers && target.numbers.length) {
      NUMERIC.lastIndex = 0;
      while ((m = NUMERIC.exec(s)) && out.length < cap) {
        const nums = splitNumbers(m[1]);
        if (nums.some((n) => target.numbers.indexOf(n) >= 0)) out.push({ start: m.index, end: m.index + m[0].length });
      }
    }
    if (!out.length && target.surname && target.year) {
      const y = String(target.year);
      AY_BRACKET.lastIndex = 0;
      while ((m = AY_BRACKET.exec(s)) && out.length < cap) {
        if (validNames(m[1]) && new RegExp('(^|[^A-Za-z])' + target.surname + '(?![A-Za-z])', 'i').test(m[1]) && m[2] === y) {
          out.push({ start: m.index, end: m.index + m[0].length });
        }
      }
      AY_PAREN.lastIndex = 0;
      while ((m = AY_PAREN.exec(s)) && out.length < cap) {
        const head = /^[ \t]*([A-Z][\w'’\-]*)/.exec(m[1]);
        if (head && validNames(m[1]) && head[1].toLowerCase() === String(target.surname).toLowerCase() && m[2] === y) {
          out.push({ start: m.index, end: m.index + m[0].length });
        }
      }
      out.sort((a, b) => a.start - b.start);
    }
    return out;
  }

  // ---------- 行构造（渲染层把 PDF.js 文本项交给这里拼行） ----------

  // items: 渲染层预归一化的数组 [{ str, x, y, w, fh }]，坐标用 scale=1 视口坐标
  //（与搜索高亮同一坐标系：x 左起，y 是基线，向下增大）。把它们按 y 聚成视觉行。
  // 返回 [{ text, x, y, w, h, idx:[items 下标] }]，按阅读序（先上后下、先左后右）。
  function buildLines(items) {
    const rows = [];
    const list = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it || !it.str || !isFinite(it.x) || !isFinite(it.y)) continue;
      list.push({ str: it.str, x: it.x, y: it.y, fh: it.fh || 10, w: it.w || it.str.length * (it.fh || 10) * 0.5, src: i });
    }
    list.sort((a, b) => (a.y - b.y) || (a.x - b.x));
    for (const it of list) {
      const last = rows[rows.length - 1];
      if (last && Math.abs(last.y - it.y) <= Math.max(last.h, it.fh) * 0.5) {
        // 同一行：按 x 找插入位置，保持行内从左到右。
        // last.idx 存的是「原始 items 下标」，比较时必须回查 items（或 list 里的对象），
        // 不能拿它去索引排过序的 list —— 两套下标在 PDF 绘制顺序与视觉顺序不同时会错位，
        // 把 [12] 拆成多个文本项的行拼成 1324 这种乱序（B10）。
        let k = last.idx.length;
        while (k > 0 && items[last.idx[k - 1]].x > it.x) k--;
        last.idx.splice(k, 0, it.src);
        last.text = last.idx.map((ix) => items[ix].str).join('');
        last.x = Math.min(last.x, it.x);
        last.h = Math.max(last.h, it.fh);
        last.w = Math.max(last.x + last.w, it.x + it.w) - last.x;
      } else {
        rows.push({ text: it.str, x: it.x, y: it.y, w: it.w, h: it.fh, idx: [it.src] });
      }
    }
    return rows;
  }

  return {
    extractCitation,
    isBibHeading,
    matchNumericLine,
    matchAuthorYearLine,
    findBibStartIndex,
    isBibHeading,
    findEntryLine,
    findMarkerPositions,
    buildLines,
  };
});
