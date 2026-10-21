'use strict';

// 标注模块：把每一页的图形以“单位坐标”(=scale-1 视口像素，左上原点、y 向下) 存进数据模型，
// 用两个 SVG 叠加层渲染（base=荧光笔层，anno=常规+文字层）。缩放时 viewBox 不变，天然跟随页面。
const Anno = window.Anno = (() => {
  const NS = 'http://www.w3.org/2000/svg';
  const state = {
    tool: 'select',
    color: '#e53935',
    width: 3,
    textHeight: 18,
  };
  const undoStack = []; // {type:'add'|'del'|'clear', n, shape|shapes}
  let hintShown = false; // 看图模式的提示只弹一次
  let drawing = null;   // 正在绘制的临时 shape

  // ---- 颜色转 rgb 供 CSS（导出在主进程用 pdf-lib 直接吃 hex） ----
  function shapesOf(n) {
    const map = App.state.annos;
    let arr = map.get(n);
    if (!arr) { arr = []; map.set(n, arr); }
    return arr;
  }

  function el(tag, attrs) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  function arrowHead(a, b, w) {
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const len = Math.max(8, w * 3.5);
    const s = Math.PI / 7;
    return [
      { x: b.x - len * Math.cos(ang - s), y: b.y - len * Math.sin(ang - s) },
      { x: b.x - len * Math.cos(ang + s), y: b.y - len * Math.sin(ang + s) },
    ];
  }

  // ---- 渲染整页（从模型重绘，供 commit/undo/eraser 用） ----
  function renderPage(n) {
    const page = App.pageEl(n);
    if (!page) return;
    const base = page.querySelector('.anno-base');
    const top = page.querySelector('.anno');
    base.textContent = ''; top.textContent = '';
    for (const sh of shapesOf(n)) drawShape(base, top, sh);
  }

  function drawShape(base, top, sh) {
    const stroke = { stroke: sh.color, fill: 'none', 'stroke-width': sh.width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
    const mk = (tag, attrs) => { const e = el(tag, attrs); top.appendChild(e); return e; };
    switch (sh.tool) {
      case 'highlight':
        base.appendChild(inkNode(sh, 0.4)); break;
      case 'mark': {
        // 文字选区高亮：矩形来自真实文本层选区，存单位坐标，缩放后不漂。
        // kind:'quote' 是「摘录」，用更淡的底 + 虚线和普通高亮区分。
        const g = document.createElementNS(NS, 'g');
        g.setAttribute('class', 'text-mark' + (sh.kind === 'quote' ? ' text-quote' : ''));
        for (const r of (sh.rects || [])) {
          g.appendChild(el('rect', {
            x: r.x, y: r.y, width: Math.max(1, r.w), height: Math.max(1, r.h),
            fill: sh.color || '#ffd54f', 'fill-opacity': sh.kind === 'quote' ? '0.18' : '0.42',
            stroke: sh.color || '#ffd54f', 'stroke-opacity': sh.kind === 'quote' ? '0.75' : '0.55', 'stroke-width': '1',
            rx: '1.5',
          }));
        }
        const ti = el('title', {});
        ti.textContent = (sh.kind === 'quote' ? '摘录：' : '') + String(sh.text || '') + (sh.comment ? '\n评论：' + sh.comment : '');
        g.appendChild(ti);
        base.appendChild(g);
        break;
      }
      case 'pen':
        top.appendChild(inkNode(sh)); break;
      case 'line':
        mk('line', Object.assign({ x1: sh.a.x, y1: sh.a.y, x2: sh.b.x, y2: sh.b.y }, stroke)); break;
      case 'rect': {
        const x = Math.min(sh.a.x, sh.b.x), y = Math.min(sh.a.y, sh.b.y);
        mk('rect', Object.assign({ x, y, width: Math.abs(sh.b.x - sh.a.x), height: Math.abs(sh.b.y - sh.a.y) }, stroke)); break;
      }
      case 'arrow': {
        mk('line', Object.assign({ x1: sh.a.x, y1: sh.a.y, x2: sh.b.x, y2: sh.b.y }, stroke));
        const h = arrowHead(sh.a, sh.b, sh.width);
        mk('line', Object.assign({ x1: sh.b.x, y1: sh.b.y, x2: h[0].x, y2: h[0].y }, stroke));
        mk('line', Object.assign({ x1: sh.b.x, y1: sh.b.y, x2: h[1].x, y2: h[1].y }, stroke)); break;
      }
      case 'text': {
        // SVG <text> 会把换行折叠成空格，多行必须拆成 tspan，否则输入两行会挤成一坨
        const t = mk('text', { x: sh.at.x, y: sh.at.y + sh.size * 0.85, fill: sh.color, 'font-size': sh.size, 'font-family': 'system-ui, "Segoe UI", sans-serif' });
        const lines = String(sh.text).split('\n');
        if (lines.length === 1) {
          t.textContent = lines[0];
        } else {
          lines.forEach((ln, i) => {
            const ts = el('tspan', { x: sh.at.x, dy: i === 0 ? 0 : sh.size * 1.25 });
            ts.textContent = ln;
            t.appendChild(ts);
          });
        }
        break;
      }
      case 'note': {
        // 便签：黄色小标记 + 原生 <title> 悬停提示显示内容（不需要额外 DOM 弹层）
        const m = 16;
        const g = document.createElementNS(NS, 'g');
        g.setAttribute('class', 'note-mark');
        g.appendChild(el('rect', { x: sh.at.x, y: sh.at.y, width: m, height: m, fill: '#ffe082', stroke: '#f0a500', 'stroke-width': 1 }));
        g.appendChild(el('path', { d: 'M' + (sh.at.x + m - 5) + ' ' + sh.at.y + ' v5 h5', fill: 'none', stroke: '#f0a500', 'stroke-width': 1 }));
        const ti = el('title', {});
        ti.textContent = String(sh.text || '');
        g.appendChild(ti);
        top.appendChild(g);
        break;
      }
    }
  }

  // 中点二次贝塞尔平滑：消除鼠标抖动产生的硬折角，笔迹圆润
  function pathD(pts) {
    const a = pts[0], b = pts[pts.length - 1];
    let d = 'M' + a.x + ' ' + a.y;
    if (pts.length === 2) return d + ' L' + b.x + ' ' + b.y;
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
      d += ' Q' + pts[i].x + ' ' + pts[i].y + ' ' + mx + ' ' + my;
    }
    return d + ' L' + b.x + ' ' + b.y;
  }

  // 画笔/荧光笔统一节点生成：单点=圆点标记，多点=平滑曲线
  function inkNode(sh, opacity) {
    let node;
    if (sh.pts.length === 1) {
      node = el('circle', { cx: sh.pts[0].x, cy: sh.pts[0].y, r: Math.max(0.8, sh.width / 2), fill: sh.color });
      if (opacity) node.setAttribute('opacity', opacity);
    } else {
      const attrs = { d: pathD(sh.pts), fill: 'none', stroke: sh.color, 'stroke-width': sh.width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
      if (opacity) attrs['stroke-opacity'] = opacity;
      node = el('path', attrs);
    }
    if (sh.tool === 'highlight') node.style.mixBlendMode = 'multiply';
    return node;
  }

  // ---- 客户端坐标 → 单位坐标 ----
  function toUnit(svg, clientX, clientY) {
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return { x: p.x, y: p.y };
  }

  // ---- 绘制上下文 ----
  // 拖拽是「跨元素」的连续手势：若把 move/up 绑在每页自己的 svg 上，笔一旦甩到别的页
  // 就会用那一页的 CTM 换算坐标（串页错位）；抬手落在工具栏/页外空白处则根本没人收到
  // pointerup，drawing 永久悬挂（笔停不下来，移动就继续画）。
  // 所以：down 时锁定「落笔页 + 该页 svg」，move/up 统一在 window 上处理，坐标恒按落笔页换算。
  const MIN_STEP = 0.75; // 抽稀阈值（PDF 单位）：毛刺抖动与冗余点
  let ctx = null;        // { n, svg } —— 当前落笔的页
  let pointerId = null;

  function attachPage(pageEl, n, topSvg) {
    topSvg.addEventListener('pointerdown', (e) => onDown(e, n, topSvg));
    // 指针捕获意外丢失（窗口切换、系统抢指针）时也收尾，绝不留悬挂手势
    topSvg.addEventListener('lostpointercapture', () => releaseGesture(false));
  }

  function bindGlobalPointer() {
    window.addEventListener('pointermove', onMove);
    // capture 阶段先于任何 stopPropagation，保证工具栏/浮层吞掉事件时我们仍能收尾
    window.addEventListener('pointerup', () => releaseGesture(false), true);
    window.addEventListener('pointercancel', () => releaseGesture(true), true);
    window.addEventListener('blur', () => releaseGesture(false)); // 切去别的应用：本窗口再也收不到 up
  }

  // 结束当前手势。drop=true 时丢弃未完成笔迹，否则提交（用户确实画完了）。
  function releaseGesture(drop) {
    if (!ctx) { drawing = null; return; }
    const { n } = ctx;
    const keep = drawing && !drop && drawing.tool !== 'eraser';
    if (keep) commit(n, drawing);
    endDraw(n);
  }

  function onDown(e, n, svg) {
    if (e.button !== 0) return;
    // 关键：上一笔若因「在窗口外抬手」「切应用」而没收到 up，这里绝不能把新落笔一起锁死
    // （那会让所有工具包括文字彻底无响应）。先收尾旧手势，再照常开始新的。
    if (ctx) releaseGesture(false);
    const tool = state.tool;
    if (tool === 'select') return;
    const p = toUnit(svg, e.clientX, e.clientY);
    if (tool === 'text' || tool === 'note') {
      // 点到已有的便签/文字 → 打开编辑器改它；没点中才新建
      // （原来不管点哪儿都开一个空编辑器，保存过的便签再也点不开）
      startText(e, n, svg, p, tool, findEditable(n, p, tool));
      return;
    }
    try { svg.setPointerCapture(e.pointerId); pointerId = e.pointerId; }
    catch (_) { /* 合成事件或失效的 pointerId：不影响，move/up 已在 window 上兜住 */ }
    ctx = { n, svg };
    if (tool === 'eraser') { drawing = { tool: 'eraser' }; eraseAt(n, p); return; }
    const sh = { tool, color: state.color, width: state.width };
    if (tool === 'pen' || tool === 'highlight') sh.pts = [p];
    else { sh.a = p; sh.b = p; }
    drawing = sh;
  }

  function onMove(e) {
    if (!drawing || !ctx) return;
    const { n, svg } = ctx;
    const p = toUnit(svg, e.clientX, e.clientY);
    if (drawing.tool === 'eraser') { eraseAt(n, p); return; }
    if (drawing.pts) {
      const last = drawing.pts[drawing.pts.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) < MIN_STEP) return; // 太近的点丢弃
      drawing.pts.push(p);
    } else drawing.b = p;
    preview(n, drawing);
  }

  function endDraw(n) {
    if (pointerId !== null) {
      try { if (ctx && ctx.svg.hasPointerCapture(pointerId)) ctx.svg.releasePointerCapture(pointerId); }
      catch (_) {}
      pointerId = null;
    }
    drawing = null;
    ctx = null;
    clearPreview(n);
    renderPage(n);
    notify(); // 手势结束即可能改了标注模型（提交/橡皮），触发自动保存+批注面板刷新
  }
  function notify() { if (App.notifyAnnoChanged) App.notifyAnnoChanged(); }

  // ---- 实时预览 ----
  // 笔画工具走「增量更新几何」：原先每次 pointermove 都销毁重建整棵临时节点并重建 path，
  // 长笔画时点数越多开销越大（O(n²)），表现为画快了掉帧、笔迹跟不上手。
  let tempG = null, tempPath = null, tempTarget = null, tempIsDot = false;
  function removeTemp() {
    if (tempG && tempG.parentNode) tempG.parentNode.removeChild(tempG);
    tempG = tempPath = tempTarget = null; tempIsDot = false;
  }
  function preview(n, sh) {
    const page = App.pageEl(n);
    if (!page) return;
    const target = sh.tool === 'highlight' ? page.querySelector('.anno-base') : page.querySelector('.anno');
    if (sh.pts) {
      const isDot = sh.pts.length === 1;
      if (tempPath && tempG && tempG.parentNode && tempTarget === target && tempIsDot === isDot) {
        if (isDot) { tempPath.setAttribute('cx', sh.pts[0].x); tempPath.setAttribute('cy', sh.pts[0].y); }
        else tempPath.setAttribute('d', pathD(sh.pts));
        return;
      }
      removeTemp();
      tempG = document.createElementNS(NS, 'g');
      target.appendChild(tempG);
      tempG.appendChild(inkNode(sh, sh.tool === 'highlight' ? 0.4 : null));
      tempPath = tempG.firstChild; tempTarget = target; tempIsDot = isDot;
      return;
    }
    removeTemp();
    tempG = document.createElementNS(NS, 'g');
    target.appendChild(tempG);
    drawShapeInto(tempG, sh);
    tempTarget = target;
  }
  function drawShapeInto(group, sh) {
    const stroke = { stroke: sh.color, fill: 'none', 'stroke-width': sh.width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
    const mk = (tag, attrs) => group.appendChild(el(tag, attrs));
    if (sh.tool === 'highlight') group.appendChild(inkNode(sh, 0.4));
    else if (sh.tool === 'pen') group.appendChild(inkNode(sh));
    else if (sh.tool === 'line') mk('line', Object.assign({ x1: sh.a.x, y1: sh.a.y, x2: sh.b.x, y2: sh.b.y }, stroke));
    else if (sh.tool === 'rect') mk('rect', Object.assign({ x: Math.min(sh.a.x, sh.b.x), y: Math.min(sh.a.y, sh.b.y), width: Math.abs(sh.b.x - sh.a.x), height: Math.abs(sh.b.y - sh.a.y) }, stroke));
    else if (sh.tool === 'arrow') {
      mk('line', Object.assign({ x1: sh.a.x, y1: sh.a.y, x2: sh.b.x, y2: sh.b.y }, stroke));
      const h = arrowHead(sh.a, sh.b, sh.width);
      mk('line', Object.assign({ x1: sh.b.x, y1: sh.b.y, x2: h[0].x, y2: h[0].y }, stroke));
      mk('line', Object.assign({ x1: sh.b.x, y1: sh.b.y, x2: h[1].x, y2: h[1].y }, stroke));
    }
  }
  function clearPreview(n) { removeTemp(); }

  function commit(n, sh) {
    if (sh.pts) {
      // 误点判定：没有实际拖动的落点（包围盒极小）不生成标注，避免留下小圆点污迹
      if (sh.pts.length < 2) return;
      let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
      for (const p of sh.pts) {
        if (p.x < minx) minx = p.x; if (p.x > maxx) maxx = p.x;
        if (p.y < miny) miny = p.y; if (p.y > maxy) maxy = p.y;
      }
      if (maxx - minx < 1.5 && maxy - miny < 1.5) return;
    } else if (!sh.a || (Math.abs(sh.a.x - sh.b.x) < 1 && Math.abs(sh.a.y - sh.b.y) < 1)) {
      return;
    }
    shapesOf(n).push(sh);
    undoStack.push({ type: 'add', n, shape: sh });
  }

  // ---- 橡皮：命中测试删除 ----
  function eraseAt(n, p) {    const arr = shapesOf(n);
    for (let i = arr.length - 1; i >= 0; i--) {
      if (hit(arr[i], p)) {
        const [rm] = arr.splice(i, 1);
        undoStack.push({ type: 'del', n, shape: rm });
        renderPage(n);
        return;
      }
    }
  }

  function hit(sh, p) {
    const r = Math.max(6, (sh.width || 2) / 2 + 4);
    if (sh.tool === 'text' || sh.tool === 'note') {
      const lines = String(sh.text).split('\n');
      const w = Math.max.apply(null, lines.map((l) => l.length * sh.size * 0.6));
      const h = lines.length * sh.size * 1.25;
      const bw = sh.tool === 'note' ? 16 : w; // 便签命中框就是 16 单位的标记本身
      return p.x >= sh.at.x - r && p.x <= sh.at.x + bw + r && p.y >= sh.at.y - r && p.y <= sh.at.y + Math.max(h, sh.tool === 'note' ? 16 : h) + r;
    }
    if (sh.tool === 'rect') {
      const x1 = Math.min(sh.a.x, sh.b.x) - r, y1 = Math.min(sh.a.y, sh.b.y) - r;
      const x2 = Math.max(sh.a.x, sh.b.x) + r, y2 = Math.max(sh.a.y, sh.b.y) + r;
      // 命中边框附近：点在框内但在内框外
      const ix1 = x1 + 2 * r, iy1 = y1 + 2 * r, ix2 = x2 - 2 * r, iy2 = y2 - 2 * r;
      const inside = p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2;
      const inner = p.x > ix1 && p.x < ix2 && p.y > iy1 && p.y < iy2;
      return inside && !inner;
    }
    if (sh.tool === 'mark') {
      for (const q of (sh.rects || [])) {
        if (p.x >= q.x && p.x <= q.x + q.w && p.y >= q.y && p.y <= q.y + q.h) return true;
      }
      return false;
    }
    if (sh.a && sh.b) return distToSeg(p, sh.a, sh.b) < r;
    if (sh.pts) {
      for (let i = 0; i < sh.pts.length - 1; i++) if (distToSeg(p, sh.pts[i], sh.pts[i + 1]) < r) return true;
      return false;
    }
    return false;
  }

  function distToSeg(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = a.x + t * dx, cy = a.y + t * dy;
    return Math.hypot(p.x - cx, p.y - cy);
  }

  // ---- 文字批注 ----
  // 事件顺序陷阱：pointerdown 先于焦点切换（blur）触发。若输入框已开着又点了页面，
  // 旧的顺序是「新 startText 清空 value → 随后 blur 用空值提交并 hidden=true」，
  // 结果输入框一闪即消失、上一段字也丢了 —— 表现为「写字不行了」。所以先收尾再开新的。
  let textFinish = null;

  // 找点到的已有便签/文字（用来「点开改它」）
  function findEditable(n, p, kind) {
    const arr = shapesOf(n);
    for (let i = arr.length - 1; i >= 0; i--) {
      const sh = arr[i];
      if (!sh || sh.tool !== kind) continue;
      if (hit(sh, p)) return { shape: sh, index: i };
    }
    return null;
  }

  function startText(e, n, svg, unit, toolKind, editTarget) {
    const kind = toolKind || 'text'; // 'text' 直接排字；'note' 落一个便签标记
    if (textFinish) textFinish(true);          // 先把未提交的文字结账掉
    const ed = document.getElementById('text-editor');
    ed.value = '';
    ed.hidden = false;
    ed.style.width = '180px';
    ed.style.height = 'auto';
    ed.placeholder = kind === 'note' ? '便签内容 · Enter 完成 · Esc 取消' : 'Enter 完成 · Esc 取消';
    // 贴边时把输入框拉回可视区，避免点开右下角后输入框跑到窗口外
    const left = Math.max(6, Math.min(e.clientX, window.innerWidth - 190));
    const top = Math.max(6, Math.min(e.clientY, window.innerHeight - 90));
    ed.style.left = left + 'px';
    ed.style.top = top + 'px';
    ed.dataset.ux = unit.x; ed.dataset.uy = unit.y;
    // 改已有的便签/文字：把原文带进编辑器，回车就是「改」而不是「再加一条」
    if (editTarget && editTarget.shape) {
      ed.value = String(editTarget.shape.text || '');
      ed.style.height = 'auto';
      ed.style.height = Math.min(320, ed.scrollHeight) + 'px';
    }
    setTimeout(() => { ed.focus(); ed.setSelectionRange(ed.value.length, ed.value.length); }, 0);

    const finish = (commitIt) => {
      const v = ed.value.replace(/\r/g, '').replace(/[ \t]+$/gm, '').trim();
      textFinish = null; ed.onblur = null; ed.oninput = null; ed.onkeydown = null;
      ed.hidden = true;
      if (!commitIt) return;
      if (editTarget && editTarget.shape) {
        // 改写已有便签：内容没变就别重画，省一次保存
        const sh = editTarget.shape;
        if (v && v !== sh.text) {
          const before = sh.text;
          sh.text = v;
          undoStack.push({ type: 'edit', n, shape: sh, before });
          renderPage(n);
          notify();
        }
        return;
      }
      if (v) {
        const sh = { tool: kind, color: state.color, width: 0, size: state.textHeight,
          at: { x: +ed.dataset.ux, y: +ed.dataset.uy }, text: v };
        shapesOf(n).push(sh);
        undoStack.push({ type: 'add', n, shape: sh });
        renderPage(n);
        notify();
      }
    };
    textFinish = finish;
    ed.oninput = () => { ed.style.height = 'auto'; ed.style.height = ed.scrollHeight + 'px'; };
    ed.onblur = () => finish(true);
    ed.onkeydown = (ev) => {
      if (ev.isComposing || ev.keyCode === 229) return; // 输入法候选确认中，别抢键
      if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
      else if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); finish(true); }
    };
  }

  // ---- 撤销 / 清除本页 ----
  // 撤销栈是模块级状态。切换文档 / 关闭标签时必须清空：
  // 否则上一份文档的 undo 操作会被作用到新文档上
  // （clear 类操作会把上一份文档的形状整批写进新文档，并被自动保存到新文档的标注文件）。
  function reset() {
    undoStack.length = 0;
  }
  function undo() {
    const op = undoStack.pop();
    if (!op) { App.toast('没有可撤销的标注'); return; }
    const arr = shapesOf(op.n);
    if (op.type === 'add') {
      const i = arr.indexOf(op.shape); if (i >= 0) arr.splice(i, 1);
    } else if (op.type === 'del') {
      arr.push(op.shape);
    } else if (op.type === 'edit') {
      // 改写便签/文字：撤销回原来的内容
      op.shape.text = op.before;
    } else if (op.type === 'clear') {
      App.state.annos.set(op.n, op.shapes.slice());
    }
    renderPage(op.n);
    notify();
  }

  function clearPage() {
    const n = App.state.currentPage;
    const old = shapesOf(n).slice();
    if (!old.length) { App.toast('本页没有标注'); return; }
    App.state.annos.set(n, []);
    undoStack.push({ type: 'clear', n, shapes: old });
    renderPage(n);
    notify();
  }

  // 供选区高亮/评论等外部模块写入模型，同时进撤销栈
  function addShape(n, sh, opts) {
    if (!sh) return null;
    shapesOf(n).push(sh);
    if (!opts || opts.undo !== false) undoStack.push({ type: 'add', n, shape: sh });
    renderPage(n);
    notify();
    return sh;
  }
  function updateShape(n, idx, patch) {
    const arr = shapesOf(n);
    if (!arr[idx]) return null;
    Object.assign(arr[idx], patch || {});
    renderPage(n);
    notify();
    return arr[idx];
  }

  // ---- 工具切换 + 「更多」浮层 ----
  function setTool(t) {
    state.tool = t;
    document.body.classList.remove('tool-select', 'tool-pen', 'tool-highlight', 'tool-line', 'tool-rect', 'tool-arrow', 'tool-text', 'tool-eraser', 'tool-note', 'tool-image');
    document.body.classList.add('tool-' + t);
    for (const b of document.querySelectorAll('.ntool')) b.classList.toggle('active', b.dataset.tool === t);
    if (t === 'image' && !hintShown) {
      // 同一条提示只弹一次，不然每次按 V 都闪一下
      hintShown = true;
      App.toast && App.toast('看图模式：点页面里的图片查看原图（放大任意区域用右键菜单）');
    }
  }

  // 「更多」浮层：选完工具**不自动收起**（可以连着点几个），点外部或 Esc 才关
  function setPop(open) {
    const pop = document.getElementById('more-pop');
    const btn = document.getElementById('more-btn');
    if (!pop || !btn) return;
    pop.hidden = !open;
    btn.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  function popOpen() {
    const pop = document.getElementById('more-pop');
    return !!(pop && !pop.hidden);
  }

  function init() {
    bindGlobalPointer();
    // 工具按钮：点一下就切（浮层里的也不会收起浮层）
    for (const b of document.querySelectorAll('.ntool')) {
      b.addEventListener('click', () => setTool(b.dataset.tool));
    }
    // 「更多」开关
    const moreBtn = document.getElementById('more-btn');
    if (moreBtn) moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const pop = document.getElementById('more-pop');
      setPop(pop ? pop.hidden : false);
    });
    // 点浮层外部 / 按 Esc 关闭
    document.addEventListener('click', (e) => {
      if (!popOpen()) return;
      const pop = document.getElementById('more-pop');
      const wrap = pop.closest('.dd-wrap');
      if (wrap && !wrap.contains(e.target)) setPop(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && popOpen()) { e.preventDefault(); setPop(false); }
    });
    document.getElementById('note-color').addEventListener('input', (e) => { state.color = e.target.value; });
    document.getElementById('note-width').addEventListener('change', (e) => { state.width = parseFloat(e.target.value) || 3; });
    document.getElementById('btn-undo').addEventListener('click', undo);
    document.getElementById('btn-clear-page').addEventListener('click', clearPage);
    setTool('select');
  }

  return { init, attachPage, setTool, undo, clearPage, renderPage, addShape, updateShape, reset, get state() { return state; } };
})();
