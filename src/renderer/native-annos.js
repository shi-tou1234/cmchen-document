'use strict';
/*
 * PDF 原生批注导入（v29 新增）。
 *
 * 只做一件事：把 PDF 文件里已经存在的标准批注对象（/Annots）读出来，映射成
 * Trove 自己的标注形状，交给现有的保存 / 列表 / 导出链路，不另建一套数据。
 *
 * 映射范围（第一版）：
 *   Highlight / Underline / Squiggly / StrikeOut → mark（带 kind 区分子类型）
 *   Text（便签图标）                            → note
 *   FreeText                                   → text
 *   Ink（手绘）                                 → pen，一条笔画一个形状
 *   Square                                     → rect
 *   Line                                       → line
 *
 * 刻意不做的：
 *   - 已经扁平化进页面内容的“批注”无法恢复，getAnnotations() 读不到；
 *   - 回复关系只保留为评论文本（「↳ 作者：内容」），不建树；
 *   - Popup / Stamp / Polygon / Circle 等第一版跳过，计入 skipped 而不是静默丢弃。
 *
 * 坐标：PDF 用户空间（左下原点）→ 页面单位坐标（左上原点），统一走
 * PageViewport.convertToViewportPoint / convertToViewportRectangle，页面旋转和
 * CropBox 由 PDF.js 自己处理，不手写三角函数。
 */
const NativeAnnos = window.NativeAnnos = (() => {
  const TEXTUAL = new Set(['Highlight', 'Underline', 'Squiggly', 'StrikeOut']);
  const KIND = { Underline: 'underline', Squiggly: 'squiggly', StrikeOut: 'strike' };
  const DEFAULTS = {
    Highlight: '#ffd84d', Underline: '#e05a4f', Squiggly: '#e05a4f', StrikeOut: '#e05a4f',
    Text: '#ffe082', FreeText: '#3b3b3b', Ink: '#d64541', Square: '#8a7f6a', Line: '#8a7f6a',
  };
  const MAX_SHAPES = 5000;

  function hexOf(c) {
    if (!c || !c.length) return '';
    return '#' + [0, 1, 2].map((i) => ('0' + Math.max(0, Math.min(255, c[i] | 0)).toString(16)).slice(-2)).join('');
  }

  function boxOf(points) {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const p of points) {
      if (!p || !isFinite(p.x) || !isFinite(p.y)) continue;
      if (p.x < x1) x1 = p.x;
      if (p.y < y1) y1 = p.y;
      if (p.x > x2) x2 = p.x;
      if (p.y > y2) y2 = p.y;
    }
    if (x1 === Infinity) return null;
    return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) };
  }

  function overlap(a, b) {
    const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    return ox > 0.5 && oy > 0.5;
  }

  // 文本项 → 页面单位坐标里的外框。PDF.js 的 transform 是「文本空间 → PDF 用户空间」，
  // 乘 viewport 的变换才是屏幕坐标；高度取变换后的字号，宽度 PDF.js 已按字号展开。
  function itemBox(it, vp, pdfjsLib) {
    const tr = it.transform;
    if (!tr || tr.length < 6) return null;
    const h = Math.hypot(tr[2], tr[3]) || it.height || 0;
    const x = tr[4], y = tr[5] - h;
    const w = Math.abs(it.width || 0);
    if (!(w > 0 && h > 0)) return null;
    let a, b;
    try {
      if (pdfjsLib && pdfjsLib.Util && pdfjsLib.Util.transform) {
        const m = pdfjsLib.Util.transform(vp.transform, tr);
        const vh = Math.hypot(m[2], m[3]);
        const p1 = { x: m[4], y: m[5] - vh };
        const p2 = { x: m[4] + w * (vp.scale || 1), y: m[5] };
        return { x: Math.min(p1.x, p2.x), y: Math.min(p1.y, p2.y), w: Math.abs(p2.x - p1.x), h: Math.abs(p2.y - p1.y) };
      }
      const p1 = vp.convertToViewportPoint(x, y);
      const p2 = vp.convertToViewportPoint(x + w, y + h);
      a = p1; b = p2;
    } catch (_) { return null; }
    return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]) };
  }

  // 高亮底下的原文：拿 PDF.js 的文本层按矩形相交取，取不到就留空（不阻断导入）
  function textUnder(rects, tc, vp, pdfjsLib) {
    if (!tc || !Array.isArray(tc.items) || !rects.length) return '';
    const parts = [];
    for (const it of tc.items) {
      if (!it || !it.str) continue;
      const b = itemBox(it, vp, pdfjsLib);
      if (!b) continue;
      if (rects.some((r) => overlap(r, b))) parts.push(it.str);
    }
    return parts.join('').replace(/\s+/g, ' ').trim();
  }

  function convertOne(a, vp, tc, pdfjsLib) {
    const sub = a.subtype;
    if (!sub) return null;
    const color = hexOf(a.color) || DEFAULTS[sub] || '#ffd84d';
    const rects = () => {
      const quads = Array.isArray(a.quadPoints) ? a.quadPoints : null;
      if (quads && quads.length) {
        // quadPoints 给的是 PDF 用户空间坐标（左下原点），必须逐点转成页面坐标；
        // 直接把 y=700 当屏幕坐标会把高亮画到页面外面去。
        const out = quads.map((q) => boxOf((q || []).map((p) => {
          const v = vp.convertToViewportPoint(p.x, p.y);
          return { x: v[0], y: v[1] };
        }))).filter((b) => b && b.w > 0.5 && b.h > 0.5);
        if (out.length) return out;
      }
      const r = vp.convertToViewportRectangle(a.rect);
      const b = { x: Math.min(r[0], r[2]), y: Math.min(r[1], r[3]), w: Math.abs(r[2] - r[0]), h: Math.abs(r[3] - r[1]) };
      return b.w > 0.5 && b.h > 0.5 ? [b] : [];
    };
    // PDF.js 3.x 把评论 / 作者放在 contentsObj / titleObj 里（不是 contents / title），
    // 两者都兼容一下，老版本或自定义探针传进来的扁平字段也能读。
    const contentsObj = a.contentsObj && a.contentsObj.str;
    const comment = String(contentsObj || a.contents || '').trim();
    const authorObj = a.titleObj && a.titleObj.str;
    const author = String(authorObj || a.title || '').trim();
    if (TEXTUAL.has(sub)) {
      const rs = rects();
      if (!rs.length) return null;
      const text = textUnder(rs, tc, vp, pdfjsLib);
      const sh = {
        tool: 'mark', color, rects: rs, text, comment, tags: [],
        nativeId: String(a.id || ''), nativeType: sub,
      };
      if (KIND[sub]) sh.kind = KIND[sub];
      return sh;
    }
    if (sub === 'Text') {
      const r = vp.convertToViewportRectangle(a.rect);
      return {
        tool: 'note', color, width: 1, at: { x: Math.min(r[0], r[2]), y: Math.min(r[1], r[3]) },
        text: comment, tags: [], nativeId: String(a.id || ''), nativeType: sub,
      };
    }
    if (sub === 'FreeText') {
      const r = vp.convertToViewportRectangle(a.rect);
      const x = Math.min(r[0], r[2]), y = Math.min(r[1], r[3]);
      const h = Math.abs(r[3] - r[1]);
      return {
        tool: 'text', color, at: { x, y: y + Math.min(4, h * 0.1) },
        size: Math.max(8, Math.min(36, Math.round(h * 0.7) || 14)),
        text: comment, tags: [], nativeId: String(a.id || ''), nativeType: sub,
      };
    }
    if (sub === 'Ink') {
      const strokes = Array.isArray(a.inkLists) && a.inkLists.length ? a.inkLists : [];
      const w = (a.borderStyle && a.borderStyle.width) || 2;
      const shapes = [];
      strokes.forEach((stroke, i) => {
        const pts = (stroke || []).map((p) => vp.convertToViewportPoint(p.x, p.y)).map((q) => ({ x: q[0], y: q[1] }));
        if (!pts.length) return;
        shapes.push({
          tool: 'pen', color, width: Math.max(1, Math.min(12, w)), pts, tags: [],
          nativeId: String(a.id || '') + (strokes.length > 1 ? '#' + i : ''), nativeType: sub,
        });
      });
      return shapes.length ? shapes : null;
    }
    if (sub === 'Square') {
      const r = vp.convertToViewportRectangle(a.rect);
      return {
        tool: 'rect', color, width: (a.borderStyle && a.borderStyle.width) || 2,
        a: { x: Math.min(r[0], r[2]), y: Math.min(r[1], r[3]) },
        b: { x: Math.max(r[0], r[2]), y: Math.max(r[1], r[3]) },
        tags: [], nativeId: String(a.id || ''), nativeType: sub,
      };
    }
    if (sub === 'Line' && Array.isArray(a.lineCoordinates) && a.lineCoordinates.length >= 4) {
      const p1 = vp.convertToViewportPoint(a.lineCoordinates[0], a.lineCoordinates[1]);
      const p2 = vp.convertToViewportPoint(a.lineCoordinates[2], a.lineCoordinates[3]);
      return {
        tool: 'line', color, width: (a.borderStyle && a.borderStyle.width) || 2,
        a: { x: p1[0], y: p1[1] }, b: { x: p2[0], y: p2[1] },
        tags: [], nativeId: String(a.id || ''), nativeType: sub,
      };
    }
    return null;
  }

  async function scanPage(pdfDoc, n, pdfjsLib) {
    const page = await pdfDoc.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    const raw = await page.getAnnotations({ intent: 'display' });
    const list = (raw || []).filter((a) => a && !a.hidden);
    let tc = null;
    if (list.some((a) => TEXTUAL.has(a.subtype))) {
      try { tc = await page.getTextContent(); } catch (_) { tc = null; }
    }
    const shapes = [];
    const counts = {};
    let skipped = 0;
    for (const a of list) {
      let got;
      try { got = convertOne(a, vp, tc, pdfjsLib); } catch (_) { got = null; }
      const arr = Array.isArray(got) ? got : (got ? [got] : []);
      if (!arr.length) { skipped++; continue; }
      counts[a.subtype] = (counts[a.subtype] || 0) + arr.length;
      const author = String((a.titleObj && a.titleObj.str) || a.title || '').trim();
      for (const sh of arr) {
        // 作者与原生时间戳只用于展示，不参与布局
        if (author) sh.author = author;
        if (a.modificationDate) sh.nativeDate = String(a.modificationDate);
        shapes.push(sh);
        if (shapes.length >= MAX_SHAPES) break;
      }
      if (shapes.length >= MAX_SHAPES) break;
    }
    return { page: n, shapes, counts, skipped };
  }

  async function scan(pdfDoc, opts) {
    const o = opts || {};
    if (!pdfDoc) return { pages: [], counts: {}, total: 0, skipped: 0, pagesScanned: 0 };
    const pdfjsLib = window.pdfjsLib;
    const max = Math.min(pdfDoc.numPages, o.maxPages || pdfDoc.numPages);
    const pages = [];
    const counts = {};
    let total = 0, skipped = 0;
    for (let n = 1; n <= max; n++) {
      let r;
      try { r = await scanPage(pdfDoc, n, pdfjsLib); } catch (_) { continue; }
      skipped += r.skipped;
      for (const k of Object.keys(r.counts)) counts[k] = (counts[k] || 0) + r.counts[k];
      if (r.shapes.length) { pages.push({ page: n, shapes: r.shapes }); total += r.shapes.length; }
      if (total >= MAX_SHAPES) break;
    }
    return { pages, counts, total, skipped, pagesScanned: max };
  }

  function existingIds(annos) {
    const set = new Set();
    for (const list of annos.values()) for (const sh of (list || [])) if (sh && sh.nativeId) set.add(sh.nativeId);
    return set;
  }

  function merge(scanned, annos) {
    const seen = existingIds(annos);
    let added = 0, skipped = 0;
    for (const entry of (scanned.pages || [])) {
      const arr = annos.get(entry.page) || [];
      for (const sh of entry.shapes) {
        const key = sh.nativeId || '';
        if (key && seen.has(key)) { skipped++; continue; }
        if (key) seen.add(key);
        arr.push(sh);
        added++;
      }
      if (arr.length) annos.set(entry.page, arr);
    }
    return { added, skipped };
  }

  // 真正写进当前文档：扫描 → 合并 → 重绘 → 落盘。返回统计，供界面与回归断言使用。
  async function run(opts) {
    const s = window.App && App.state;
    if (!s || !s.pdfDoc || s.mode !== 'pdf') return { ok: false, error: '没有打开的 PDF' };
    const scanned = await scan(s.pdfDoc, opts);
    if (!scanned.total) return { ok: true, added: 0, skipped: 0, total: 0, counts: scanned.counts, pages: 0 };
    const merged = merge(scanned, s.annos);
    if (merged.added) {
      for (const entry of scanned.pages) if (window.Anno && Anno.renderPage) Anno.renderPage(entry.page);
      if (window.App && App.notifyAnnoChanged) App.notifyAnnoChanged();
      else if (window.App && App.flushAnnos) App.flushAnnos();
    }
    return {
      ok: true, added: merged.added, skipped: merged.skipped + scanned.skipped,
      total: scanned.total, counts: scanned.counts, pages: scanned.pages.length,
    };
  }

  // 打开文档后的提示：只扫描前若干页，避免 400 页文档一打开就全量解析。
  // 不自动写入，等用户点「导入 PDF 批注」。
  async function hint() {
    const s = window.App && App.state;
    if (!s || !s.pdfDoc || s.mode !== 'pdf') return { ok: false };
    const key = s.filePath || s.fileName;
    if (!key || (hint.seen && hint.seen.has(key))) return { ok: false };
    if (!hint.seen) hint.seen = new Set();
    hint.seen.add(key);
    const scanned = await scan(s.pdfDoc, { maxPages: Math.min(30, s.numPages) });
    if (!scanned.total) return { ok: true, total: 0 };
    const kinds = Object.keys(scanned.counts).map((k) => k + ' ' + scanned.counts[k]).join('、');
    if (window.App && App.toast) App.toast('这份 PDF 自带 ' + scanned.total + ' 条批注（' + kinds + '），可在「批注」面板点「导入 PDF 批注」', 6000);
    return { ok: true, total: scanned.total, counts: scanned.counts };
  }

  return { scan, merge, import: run, hint, _convertOne: convertOne, _textUnder: textUnder };
})();
