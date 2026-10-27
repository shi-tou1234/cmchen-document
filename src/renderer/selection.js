'use strict';
/*
 * 文字选区高亮 / 评论（v11）。
 * 选区来自 .textlayer 的真实 DOM Range，转换成每页的单位坐标后存进 Anno 模型，
 * 因此缩放、重新打开、导出 PDF 都能保持位置。评论与高亮框一起持久化。
 */
window.SelectionUI = (function () {
  const $ = (id) => document.getElementById(id);
  let pending = null;
  let commentCb = null;
  let inited = false;

  function pageGeo() {
    const viewer = $('viewer');
    if (!viewer) return [];
    // PDF 用 .page，富文档（Word/PPT/Markdown…）用 .doc-page：两者都有标注层，
    // 统一按「页面 CSS 像素」算坐标（富文档整体靠 #doc-view 的 zoom 缩放）
    return Array.from(viewer.querySelectorAll('.page, .doc-page')).map((el) => {
      const r = el.getBoundingClientRect();
      const unit = el._unit && el._unit.w
        ? el._unit
        : { w: el.offsetWidth || r.width, h: el.offsetHeight || r.height };
      return { el, r, unit };
    }).filter((x) => x.unit && x.unit.w > 10 && x.r.width > 10 && x.r.height > 10);
  }

  // 客户端矩形 → 页面单位坐标。
  // PDF 页可能被视图旋转（v34）：用标注层的逆 CTM 换算，旋转、缩放一起算进去，
  // 得到的仍是「未旋转页面坐标」——标注数据、导出副本都按这套坐标存。
  // 富文档不旋转，仍按页面矩形 + CSS zoom 算。
  function toUnitRect(el, r) {
    const unit = el._unit || { w: el.offsetWidth || 1, h: el.offsetHeight || 1 };
    if (window.App && App.state && App.state.mode !== 'rich') {
      const svg = el.querySelector('.anno') || el.querySelector('.anno-base');
      const ctm = svg && svg.getScreenCTM ? svg.getScreenCTM() : null;
      if (ctm) {
        const inv = ctm.inverse();
        const pts = [
          new DOMPoint(r.left, r.top).matrixTransform(inv),
          new DOMPoint(r.right, r.top).matrixTransform(inv),
          new DOMPoint(r.right, r.bottom).matrixTransform(inv),
          new DOMPoint(r.left, r.bottom).matrixTransform(inv),
        ];
        const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
        const x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
        const y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
        const x = Math.max(0, Math.min(unit.w, x0));
        const y = Math.max(0, Math.min(unit.h, y0));
        return {
          x, y,
          w: Math.max(0.5, Math.min(unit.w, x1) - x),
          h: Math.max(0.5, Math.min(unit.h, y1) - y),
        };
      }
    }
    const pr = el.getBoundingClientRect();
    const scale = pr.width / unit.w || 1;
    return {
      x: Math.max(0, (r.left - pr.left) / scale),
      y: Math.max(0, (r.top - pr.top) / scale),
      w: Math.max(0.5, r.width / scale),
      h: Math.max(0.5, r.height / scale),
    };
  }

  // 同一行相邻/重叠的框合并，避免一整段文字生成几十个碎片
  function mergeInto(out, q) {
    const last = out[out.length - 1];
    if (last && Math.abs(q.y - last.y) < Math.max(2, q.h * 0.35)
      && q.x <= last.x + last.w + 2.5) {
      const right = Math.max(last.x + last.w, q.x + q.w);
      last.x = Math.min(last.x, q.x);
      last.w = right - last.x;
      last.h = Math.max(last.h, q.h);
      last.y = Math.min(last.y, q.y);
    } else out.push(q);
  }

  // 已知某一页时直接换算（朗读句级高亮用）：不用遍历所有页，长文档里更省
  function rectsForPage(el, range) {
    const out = [];
    for (const r of range.getClientRects()) {
      if (!r || r.width < 1 || r.height < 1) continue;
      mergeInto(out, toUnitRect(el, r));
    }
    return out;
  }

  function rectsForRange(range) {
    const pages = pageGeo();
    const groups = new Map();
    const rects = Array.from(range.getClientRects());
    for (const r of rects) {
      if (!r || r.width < 1 || r.height < 1) continue;
      const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
      let page = pages.find((p) => cx >= p.r.left && cx <= p.r.right && cy >= p.r.top && cy <= p.r.bottom);
      if (!page) page = pages.reduce((best, p) => {
        const d = Math.hypot(cx - (p.r.left + p.r.width / 2), cy - (p.r.top + p.r.height / 2));
        return !best || d < best.d ? { p, d } : best;
      }, null)?.p;
      if (!page) continue;
      const q = toUnitRect(page.el, r);
      const arr = groups.get(+page.el.dataset.page) || [];
      mergeInto(arr, q);
      groups.set(+page.el.dataset.page, arr);
    }
    return groups;
  }

  function barPos(rect) {
    const bar = $('sel-bar');
    // 工具条宽度按实际内容算（加了「下划线」按钮后固定 260 会偏）
    const w = bar.offsetWidth || 300;
    const h = bar.offsetHeight || 38;
    let left = rect.left + rect.width / 2 - w / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    let top = rect.bottom + 8;
    if (top + h > window.innerHeight - 8) top = Math.max(8, rect.top - h - 8);
    bar.style.left = left + 'px';
    bar.style.top = top + 'px';
  }

  function hideBar() {
    const bar = $('sel-bar');
    if (bar) bar.hidden = true;
    pending = null;
  }

  // 从当前选区重建 pending。抽出来是因为「点了工具条但 pending 已被清空」时还要能兜底，
  // 否则点击会静默 return —— 用户看到的就是「点了没有任何反应」。
  function buildPending() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const text = sel.toString().replace(/\r/g, '').trim();
    if (!text) return null;
    const range = sel.getRangeAt(0);
    const viewer = $('viewer');
    if (!viewer || !viewer.contains(range.commonAncestorContainer)) return null;
    const rich = App.state.mode === 'rich';
    const color = ($('sel-color') && $('sel-color').value) || '#ffd54f';
    const rect = range.getBoundingClientRect();
    // 富文档和 PDF 走同一套：Range 的行框按页分组，再换算成页面像素坐标
    const groups = rectsForRange(range);
    if (!groups.size) return null;
    return {
      text: text.slice(0, 6000), rich, groups: [...groups.entries()],
      page: +groups.keys().next().value, color, rect,
    };
  }

  function onMouseUp() {
    const rich = App.state.mode === 'rich';
    if (!rich && !App.state.pdfDoc) return;
    if (!rich && Anno.state.tool !== 'select') { hideBar(); return; }
    setTimeout(() => {
      const p = buildPending();
      if (!p) { hideBar(); return; }
      pending = p;
      const bar = $('sel-bar');
      bar.hidden = false;          // 先显示，offsetWidth 才有值
      bar.style.display = 'flex';
      barPos(p.rect);
    }, 0);
  }

  function commitMarks(comment, kind) {
    if (!pending) return;
    const p = pending;
    if (!p.groups || !p.groups.length) {
      hideBar();
      App.toast('没找到可标注的文字位置，请重新选中文字再试');
      return;
    }
    try {
      for (const [page, rects] of p.groups) {
        if (!rects.length) continue;
        Anno.addShape(page, {
          tool: 'mark', color: p.color, width: 0, rects,
          text: p.text, comment: String(comment || '').trim(),
          ...(kind ? { kind } : {}),
        });
      }
    } catch (err) {
      // 任何意外都要让用户看到原因，不能再静默
      hideBar();
      App.toast('标注失败：' + ((err && err.message) || '未知错误'));
      return;
    }
    try { window.getSelection().removeAllRanges(); } catch (_) {}
    hideBar();
    const done = kind === 'quote' ? '已摘录' : kind === 'underline' ? '已加下划线' : '已高亮选中文字';
    App.toast(comment ? '已高亮并保存评论' : done);
  }

  function openComment(initial, cb, opts) {
    const o = opts || {};
    const modal = $('comment-modal');
    $('comment-title').textContent = o.title || '高亮评论';
    $('comment-quote').textContent = o.quote ? ('原文：' + String(o.quote).slice(0, 160)) : '';
    $('comment-text').value = initial || '';
    commentCb = typeof cb === 'function' ? cb : null;
    modal.hidden = false;
    setTimeout(() => { const t = $('comment-text'); t.focus(); t.select(); }, 0);
  }

  function closeComment() {
    $('comment-modal').hidden = true;
    commentCb = null;
    hideBar();
  }

  function saveComment() {
    const v = $('comment-text').value.replace(/\r/g, '').trim();
    const cb = commentCb;
    $('comment-modal').hidden = true;
    commentCb = null;
    if (cb) cb(v);
  }

  function init() {
    if (inited) return;
    inited = true;
    const viewer = $('viewer');
    if (!viewer) return;
    viewer.addEventListener('mouseup', onMouseUp);
    document.addEventListener('mousedown', (e) => {
      const bar = $('sel-bar');
      if (!bar || bar.hidden) return;
      if (!bar.contains(e.target)) hideBar();
    }, true);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!$('sel-bar').hidden) hideBar();
        if (!$('comment-modal').hidden) closeComment();
      }
    });
    viewer.addEventListener('scroll', () => { if (!$('sel-bar').hidden) hideBar(); }, { passive: true });
    const bar = $('sel-bar');
    bar.addEventListener('mousedown', (e) => e.preventDefault());
    bar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-sel]');
      if (!b) return;
      // 选区还在就重建（pending 可能被滚动/外部点击清掉），真的没了再给提示——
      // 以前这里是 `if (!b || !pending) return;`，用户看到的就是「点了没反应」
      if (!pending) pending = buildPending();
      if (!pending) {
        App.toast && App.toast('选区已失效，请重新选中文字再点');
        hideBar();
        return;
      }
      const action = b.dataset.sel;
      const text = pending.text;
      const page = pending.page || App.state.currentPage;
      if (action === 'copy') {
        App.copyWithSource(text, page);
        try { window.getSelection().removeAllRanges(); } catch (_) {}
        hideBar();
      } else if (action === 'quote') {
        if (pending.rich) {
          App.quoteSelection(text, page);
          try { window.getSelection().removeAllRanges(); } catch (_) {}
          hideBar();
        } else {
          commitMarks('', 'quote');
          App.copyWithSource(text, page);
        }
      } else if (action === 'highlight') commitMarks('');
      else if (action === 'underline') commitMarks('', 'underline');
      else if (action === 'comment') {
        $('sel-bar').hidden = true;
        openComment('', (v) => commitMarks(v), { title: '高亮 + 评论', quote: text });
      }
    });
    $('sel-color').addEventListener('input', () => { if (pending) pending.color = $('sel-color').value; });

    $('comment-save').addEventListener('click', saveComment);
    $('comment-cancel').addEventListener('click', closeComment);
    $('comment-x').addEventListener('click', closeComment);
    $('comment-text').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveComment(); }
      else if (e.key === 'Escape') { e.preventDefault(); closeComment(); }
    });
  }

  return { init, openComment, closeComment, _rectsForRange: rectsForRange, _rectsForPage: rectsForPage };
})();
