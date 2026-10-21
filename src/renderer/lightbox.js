'use strict';
/*
 * 图片灯箱：交互逻辑移植自博客站点的 markdown-image-lightbox
 * （D:\项目\博客站点\src\components\misc\Markdown.astro）——
 * 以指针为中心缩放、拖拽平移、双指捏合、上下张切换、计数说明、滚动锁定那一整套。
 * 这里显示的内容换成了 PDF 里抽出来的内嵌位图（原图像素，放大不糊）。
 *
 * 与博客版的差异：
 *   - 预览元素是 <canvas> 而不是 <img>（PDF 抽出来的是位图数据）；
 *   - 滚动锁定锁的是阅读区 #viewer（PDF 在这里滚），不是 body；
 *   - 说明文字由调用方给（图注 / 页码）。
 */
const Lightbox = (function () {
  const ID = 'pdf-image-lightbox';
  const MIN_SCALE = 1;
  const MAX_SCALE = 6;
  const ZOOM_STEP = 1;      // 按钮缩放步长
  const WHEEL_STEP = 0.25;  // 滚轮缩放步长

  const state = {
    items: [],        // [{ canvas, label }]
    index: -1,
    scale: 1,
    tx: 0,
    ty: 0,
    dragging: false,
    dragMoved: false,
    dragStartX: 0,
    dragStartY: 0,
    dragOriginX: 0,
    dragOriginY: 0,
    pinchDist: 0,
    pinchScale: 1,
    pointers: new Map(),
    natW: 0, natH: 0,     // 预览的原始像素尺寸（平移边界用，避免强制重排）
    root: null,
    onClose: null,
  };

  const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

  function els() {
    const root = state.root;
    if (!root) return {};
    return {
      preview: root.querySelector('.lb-preview'),
      content: root.querySelector('.lb-content'),
      caption: root.querySelector('.lb-caption'),
      counter: root.querySelector('.lb-counter'),
      prev: root.querySelector('[data-lb-prev]'),
      next: root.querySelector('[data-lb-next]'),
      zoomOut: root.querySelector('[data-lb-zoom-out]'),
      zoomReset: root.querySelector('[data-lb-zoom-reset]'),
      zoomIn: root.querySelector('[data-lb-zoom-in]'),
      close: root.querySelector('[data-lb-close]'),
    };
  }

  // 锁住阅读区滚动（灯箱开着的时候别让底下的 PDF 跟着滚）
  function lockScroll() {
    const v = document.getElementById('viewer');
    if (v) { state.lockedViewer = v; v.style.overflow = 'hidden'; }
  }
  function unlockScroll() {
    if (state.lockedViewer) { state.lockedViewer.style.overflow = ''; state.lockedViewer = null; }
  }

  function syncControls() {
    const e = els();
    const total = state.items.length;
    if (e.counter) e.counter.textContent = total > 0 && state.index >= 0 ? (state.index + 1) + ' / ' + total : '';
    if (e.prev) e.prev.disabled = state.index <= 0;
    if (e.next) e.next.disabled = state.index < 0 || state.index >= total - 1;
    if (e.zoomOut) e.zoomOut.disabled = state.scale <= MIN_SCALE;
    if (e.zoomIn) e.zoomIn.disabled = state.scale >= MAX_SCALE;
    if (e.zoomReset) {
      e.zoomReset.disabled = state.scale === MIN_SCALE;
      e.zoomReset.textContent = Math.round(state.scale * 100) + '%';
    }
  }

  // 平移边界：图片居中，超出部分才允许拖
  // 用缓存的原始尺寸（fitPreview 时量好），别在 pointermove 里读 offsetWidth 触发强制重排
  function clampTranslate() {
    const e = els();
    if (!e.preview) return;
    const w = state.natW || e.preview.offsetWidth;
    const h = state.natH || e.preview.offsetHeight;
    const maxX = Math.max(0, (w * state.scale - w) / 2);
    const maxY = Math.max(0, (h * state.scale - h) / 2);
    state.tx = clamp(state.tx, -maxX, maxX);
    state.ty = clamp(state.ty, -maxY, maxY);
  }

  function updateTransform() {
    const e = els();
    if (!e.preview || !e.content) return;
    clampTranslate();
    e.preview.style.transform = 'translate3d(' + state.tx + 'px,' + state.ty + 'px,0) scale(' + state.scale + ')';
    e.preview.classList.toggle('is-panning', state.dragging);
    e.preview.classList.toggle('is-zoomed', state.scale > 1);
    e.preview.style.cursor = state.scale > 1 ? (state.dragging ? 'grabbing' : 'grab') : 'zoom-in';
    e.content.classList.toggle('is-zoomed', state.scale > 1);
    syncControls();
  }

  function resetZoom() {
    state.scale = 1;
    state.tx = 0;
    state.ty = 0;
    state.dragging = false;
    state.dragMoved = false;
    state.dragStartX = state.dragStartY = 0;
    state.dragOriginX = state.dragOriginY = 0;
    state.pinchDist = 0;
    state.pinchScale = 1;
    state.pointers.clear();
    updateTransform();
  }

  function setScale(next, opts) {
    const keepOffset = !opts || opts.keepOffset !== false;
    state.scale = clamp(next, MIN_SCALE, MAX_SCALE);
    if (state.scale === MIN_SCALE || !keepOffset) { state.tx = 0; state.ty = 0; }
    updateTransform();
  }

  // 以指针为中心缩放：缩放前后指针下的那一点保持不动
  function zoomToPoint(nextScale, clientX, clientY) {
    const e = els();
    if (!e.preview || !e.content) return;
    const bounded = clamp(nextScale, MIN_SCALE, MAX_SCALE);
    if (bounded === MIN_SCALE) { setScale(MIN_SCALE, { keepOffset: false }); return; }
    const r = e.content.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const px = (clientX - cx - state.tx) / state.scale;
    const py = (clientY - cy - state.ty) / state.scale;
    state.scale = bounded;
    state.tx = clientX - cx - px * bounded;
    state.ty = clientY - cy - py * bounded;
    updateTransform();
  }

  function pointerDistance() {
    const pts = [...state.pointers.values()];
    if (pts.length < 2) return 0;
    return Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
  }

  function releasePointer(id) {
    state.pointers.delete(id);
    if (state.pointers.size < 2) state.pinchDist = 0;
    if (state.pointers.size === 0) state.dragging = false;
  }

  function changeScale(step) {
    const e = els();
    if (!e.content) return;
    const r = e.content.getBoundingClientRect();
    zoomToPoint(state.scale + step, r.left + r.width / 2, r.top + r.height / 2);
  }

  // 把预览按「位图像素」摆进内容区：不超过原始像素（避免糊），也不小于原始像素（等于原始大小）
  // 博客那边是 max-width:100% —— 小图不会被放大；这里同样不放大，但内容区留白更少。
  function fitPreview() {
    const e = els();
    if (!e.preview || !e.content) return;
    const natW = e.preview.width || 1;
    const natH = e.preview.height || 1;
    const box = e.content.getBoundingClientRect();
    const availW = Math.max(40, box.width - 140);   // 给左右翻图箭头留位置
    const availH = Math.max(40, box.height - 120);  // 给上下工具条与图注留位置
    const fit = Math.min(availW / natW, availH / natH, 1);
    state.natW = natW;
    state.natH = natH;
    e.preview.style.width = Math.max(1, Math.round(natW * fit)) + 'px';
    e.preview.style.height = Math.max(1, Math.round(natH * fit)) + 'px';
  }

  // 换图：把新图的内容画进预览 canvas
  function showIndex(i, opts) {
    const it = state.items[i];
    if (!it) return;
    const e = els();
    state.index = i;
    if (e.preview && it.canvas) {
      e.preview.width = it.canvas.width;
      e.preview.height = it.canvas.height;
      const ctx = e.preview.getContext('2d');
      ctx.clearRect(0, 0, e.preview.width, e.preview.height);
      ctx.drawImage(it.canvas, 0, 0);
      fitPreview();
    }
    if (e.caption) e.caption.textContent = it.label || '';
    if (!opts || opts.resetZoom !== false) resetZoom();
    else updateTransform();
    syncControls();
  }

  function ensure() {
    if (state.root) return state.root;
    const root = document.createElement('div');
    state.root = root;          // 先挂上，els() 才能取到里面的元素
    root.id = ID;
    root.className = 'lb-root';
    root.setAttribute('aria-hidden', 'true');
    root.hidden = true;
    root.innerHTML =
      '<div class="lb-backdrop" data-lb-close></div>' +
      '<div class="lb-dialog" role="dialog" aria-modal="true" aria-label="图片预览">' +
        '<div class="lb-toolbar">' +
          '<div class="lb-counter"></div>' +
          '<div class="lb-actions">' +
            '<button type="button" class="lb-btn" data-lb-zoom-out aria-label="缩小">－</button>' +
            '<button type="button" class="lb-btn lb-zoom-label" data-lb-zoom-reset aria-label="复位缩放">100%</button>' +
            '<button type="button" class="lb-btn" data-lb-zoom-in aria-label="放大">＋</button>' +
            '<button type="button" class="lb-btn lb-close" data-lb-close aria-label="关闭">' +
              '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>' +
            '</button>' +
          '</div>' +
        '</div>' +
        '<div class="lb-content">' +
          '<button type="button" class="lb-nav lb-prev" data-lb-prev aria-label="上一张">' +
            '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="m15 18-6-6 6-6"></path></svg>' +
          '</button>' +
          '<canvas class="lb-preview" tabindex="0"></canvas>' +
          '<button type="button" class="lb-nav lb-next" data-lb-next aria-label="下一张">' +
            '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="m9 18 6-6-6-6"></path></svg>' +
          '</button>' +
        '</div>' +
        '<div class="lb-caption"></div>' +
      '</div>';

    const e = els.call({ root: root });
    const close = () => {
      resetZoom();
      root.classList.remove('is-open');
      root.setAttribute('aria-hidden', 'true');
      root.hidden = true;
      unlockScroll();
      state.items = [];
      state.index = -1;
      if (state.onClose) { const cb = state.onClose; state.onClose = null; cb(); }
    };
    state.close = close;

    root.addEventListener('click', (ev) => {
      const t = ev.target;
      if (!(t instanceof HTMLElement)) return;
      if (t.closest('[data-lb-close]')) { close(); return; }
      if (t === root || t.closest('.lb-backdrop')) close();
    });

    document.addEventListener('keydown', (ev) => {
      if (!root.classList.contains('is-open')) return;
      if (ev.key === 'Escape') { ev.preventDefault(); close(); }
      else if (ev.key === 'ArrowLeft') { ev.preventDefault(); if (state.index > 0) showIndex(state.index - 1); }
      else if (ev.key === 'ArrowRight') { ev.preventDefault(); if (state.index < state.items.length - 1) showIndex(state.index + 1); }
      else if (ev.key === '+' || ev.key === '=') { ev.preventDefault(); changeScale(ZOOM_STEP); }
      else if (ev.key === '-' || ev.key === '_') { ev.preventDefault(); changeScale(-ZOOM_STEP); }
      else if (ev.key === '0') { ev.preventDefault(); setScale(MIN_SCALE, { keepOffset: false }); }
    });

    const preview = e.preview;
    preview.addEventListener('click', (ev) => ev.stopPropagation());
    preview.addEventListener('dblclick', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const next = state.scale >= MAX_SCALE ? MIN_SCALE : state.scale + ZOOM_STEP;
      zoomToPoint(next, ev.clientX, ev.clientY);
    });
    // 缩放：滚轮 / 触控板手势。
    // 触控板一次手势会连发几十个 wheel 事件（delta 小而密），如果每个事件都直接改
    // scale，画面会一格一格跳、看着像闪烁。所以：先把 delta 攒起来，最多每 16ms 应用
    // 一次，并且用真实 delta 大小（指数映射）而不是固定步长；缩放过程中关掉 CSS 过渡。
    // （不用 requestAnimationFrame：窗口隐藏时 rAF 不触发，攒下的 delta 会一直不生效。）
    let wheelAcc = 0;
    let wheelLast = 0;
    let wheelTimer = null;
    let wheelPoint = { x: 0, y: 0 };
    const applyWheel = () => {
      wheelLast = Date.now();
      const acc = wheelAcc;
      wheelAcc = 0;
      if (!acc) return;
      zoomToPoint(state.scale * Math.exp(-acc * 0.0016), wheelPoint.x, wheelPoint.y);
    };
    preview.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const unit = ev.deltaMode === 1 ? 16 : (ev.deltaMode === 2 ? 400 : 1);
      let d = ev.deltaY * unit;
      if (ev.ctrlKey) d *= 0.6;                 // 触控板双指捏合：浏览器发的是 ctrl+wheel，再放缓些
      if (!d) return;
      wheelAcc += d;
      wheelPoint = { x: ev.clientX, y: ev.clientY };
      const now = Date.now();
      if (now - wheelLast >= 16) applyWheel();
      else if (!wheelTimer) wheelTimer = setTimeout(() => { wheelTimer = null; applyWheel(); }, 16);
      preview.classList.add('is-zooming');
      clearTimeout(wheelEndTimer);
      wheelEndTimer = setTimeout(() => preview.classList.remove('is-zooming'), 180);
    }, { passive: false });
    preview.addEventListener('pointerdown', (ev) => {
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      try { preview.setPointerCapture(ev.pointerId); } catch (_) {}
      state.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (state.pointers.size === 2) {
        state.pinchDist = pointerDistance();
        state.pinchScale = state.scale;
        state.dragging = false;
        return;
      }
      if (state.scale > 1) {
        state.dragging = true;
        state.dragMoved = false;
        state.dragStartX = ev.clientX;
        state.dragStartY = ev.clientY;
        state.dragOriginX = state.tx;
        state.dragOriginY = state.ty;
        updateTransform();
      }
    });
    preview.addEventListener('pointermove', (ev) => {
      if (!state.pointers.has(ev.pointerId)) return;
      state.pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (state.pointers.size === 2) {
        ev.preventDefault();
        const dist = pointerDistance();
        if (state.pinchDist > 0) setScale(state.pinchScale * (dist / state.pinchDist));
        return;
      }
      if (!state.dragging || state.scale <= 1) return;
      ev.preventDefault();
      const dx = ev.clientX - state.dragStartX;
      const dy = ev.clientY - state.dragStartY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) state.dragMoved = true;
      state.tx = state.dragOriginX + dx;
      state.ty = state.dragOriginY + dy;
      updateTransform();
    });
    const onRelease = (ev) => {
      try { preview.releasePointerCapture(ev.pointerId); } catch (_) {}
      releasePointer(ev.pointerId);
      updateTransform();
    };
    preview.addEventListener('pointerup', onRelease);
    preview.addEventListener('pointercancel', onRelease);
    preview.addEventListener('pointerleave', onRelease);

    if (e.content) e.content.addEventListener('click', (ev) => ev.stopPropagation());
    if (e.prev) e.prev.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); if (state.index > 0) showIndex(state.index - 1); });
    if (e.next) e.next.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); if (state.index < state.items.length - 1) showIndex(state.index + 1); });
    if (e.zoomOut) e.zoomOut.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); changeScale(-ZOOM_STEP); });
    if (e.zoomIn) e.zoomIn.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); changeScale(ZOOM_STEP); });
    if (e.zoomReset) e.zoomReset.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); setScale(MIN_SCALE, { keepOffset: false }); });
    if (e.close) e.close.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); close(); });

    document.body.appendChild(root);
    syncControls();
    return root;
  }

  // 打开：items = [{ canvas, label }]，index 是起始项
  function open(opts) {
    const o = opts || {};
    const items = o.items || [];
    if (!items.length) return false;
    ensure();
    state.items = items;
    state.onClose = o.onClose || null;
    const root = state.root;
    root.hidden = false;
    root.classList.add('is-open');
    root.setAttribute('aria-hidden', 'false');
    lockScroll();
    showIndex(Math.min(Math.max(o.index || 0, 0), items.length - 1));
    return true;
  }

  function close() {
    if (state.close) state.close();
  }

  function isOpen() {
    return !!(state.root && state.root.classList.contains('is-open'));
  }

  return { open, close, isOpen, state, MIN_SCALE, MAX_SCALE };
})();

window.Lightbox = Lightbox;
