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
    stamp: 'ok',           // v36：当前印章预设 id
  };

  // ---- 颜色：色板 + 分工具记忆 ----
  // 用户最常见的诉求是「荧光笔想换几种颜色」（重点 / 疑问 / 结论各一色），
  // 而取色器每次都要点开、拖、确认，所以给一排常用色；取色器保留给自定义。
  const PALETTE = ['#ffd54f', '#a5d6a7', '#90caf9', '#f8bbd0', '#ffcc80', '#ce93d8'];
  const PALETTE_NAME = {
    '#ffd54f': '黄', '#a5d6a7': '绿', '#90caf9': '蓝',
    '#f8bbd0': '粉', '#ffcc80': '橙', '#ce93d8': '紫',
  };
  // 分两桶：荧光笔一桶，其余（画笔 / 直线 / 文字…）一桶。
  // 只分两桶是因为「画红线」和「画蓝框」是同一个意图下的两种颜色，
  // 按工具各存一份反而每次换工具都要重新调色。
  const COLOR_BUCKET = {
    pen: 'ink', line: 'ink', rect: 'ink', arrow: 'ink', text: 'ink', note: 'ink',
    ellipse: 'ink', triangle: 'ink', smart: 'ink',
    highlight: 'hl',
  };
  const bucketColor = { ink: '#e53935', hl: '#ffd54f' };

  function bucketOf(tool) { return COLOR_BUCKET[tool] || ''; }

  // 把 state.color 同步到取色器和色板的高亮状态（两处控件永远不打架）
  function syncColor() {
    const inp = document.getElementById('note-color');
    if (inp && /^#[0-9a-f]{6}$/i.test(state.color || '')) inp.value = state.color;
    const box = document.getElementById('note-swatches');
    if (box) {
      for (const b of box.querySelectorAll('[data-color]')) {
        b.classList.toggle('active', String(b.dataset.color).toLowerCase() === String(state.color).toLowerCase());
      }
    }
  }

  function setColor(hex) {
    const c = String(hex || '').trim();
    if (!/^#[0-9a-f]{6}$/i.test(c)) return;
    state.color = c;
    const b = bucketOf(state.tool);
    if (b) bucketColor[b] = c;
    syncColor();
  }

  function buildSwatches() {
    const box = document.getElementById('note-swatches');
    if (!box || box._done) return;
    box._done = true;
    for (const c of PALETTE) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sw';
      b.dataset.color = c;
      b.style.background = c;
      b.title = (PALETTE_NAME[c] || '') + '色';
      box.appendChild(b);
    }
    box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-color]');
      if (b) setColor(b.dataset.color);
    });
  }

  // 印章（借鉴 Okular）：点一下就落一个带框的标记，不拖不画。
  // 预设里放的是「审阅时最常盖的那几个」，颜色各自固定 —— 印章的含义靠颜色区分，
  // 跟着取色器变色会让「已阅」变成红色，反而读不出来。
  const STAMPS = [
    { id: 'ok', text: '已阅', color: '#2e7d32' },
    { id: 'no', text: '存疑', color: '#c62828' },
    { id: 'star', text: '★', color: '#ef6c00' },
    { id: 'done', text: '✓', color: '#1565c0' },
    { id: 'todo', text: '待办', color: '#6a1b9a' },
  ];
  const STAMP_BY_ID = new Map(STAMPS.map((x) => [x.id, x]));

  // 印章的框：文字宽度按「CJK 算一个全角、拉丁算半个」估，够用且不依赖测量
  function stampBox(sh) {
    const size = sh.size || 15;
    const text = String(sh.text || (STAMP_BY_ID.get(sh.stamp) || STAMPS[0]).text);
    let units = 0;
    for (const ch of text) units += /[\u3400-\u9fff\uf900-\ufaff]/.test(ch) ? 1 : 0.58;
    const w = Math.max(size * 1.9, units * size + size * 1.1);
    const h = size * 1.85;
    return { x: sh.at.x, y: sh.at.y, w, h, size, text };
  }
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

  // ---- 几何图形的公共骨架 ----
  // 所有「画出来的形状」都只存 a / b 两个角（和矩形一致），渲染、导出、橡皮擦
  // 都从这两个角推导出轮廓，新增形状不用再各写一份坐标换算。
  const GEOM_TOOLS = new Set(['line', 'rect', 'arrow', 'ellipse', 'triangle']);

  function cornersOf(sh) {
    const x1 = Math.min(sh.a.x, sh.b.x), y1 = Math.min(sh.a.y, sh.b.y);
    const x2 = Math.max(sh.a.x, sh.b.x), y2 = Math.max(sh.a.y, sh.b.y);
    return { x1, y1, x2, y2, cx: (x1 + x2) / 2, cy: (y1 + y2) / 2 };
  }
  function rectCorners(sh) {
    const c = cornersOf(sh);
    return [{ x: c.x1, y: c.y1 }, { x: c.x2, y: c.y1 }, { x: c.x2, y: c.y2 }, { x: c.x1, y: c.y2 }];
  }
  function ellipsePoints(sh, n) {
    const c = cornersOf(sh), rx = Math.max(1, (c.x2 - c.x1) / 2), ry = Math.max(1, (c.y2 - c.y1) / 2);
    const out = [];
    for (let i = 0; i < n; i++) {
      const t = 2 * Math.PI * i / n;
      out.push({ x: c.cx + rx * Math.cos(t), y: c.cy + ry * Math.sin(t) });
    }
    return out;
  }
  function trianglePoints(sh) {
    const c = cornersOf(sh);
    return [{ x: c.cx, y: c.y1 }, { x: c.x2, y: c.y2 }, { x: c.x1, y: c.y2 }];
  }

  // 按住 Shift 时把拖拽框约束成「正」的：
  // 矩形 / 圆 / 椭圆 → 正方形；三角形 → 高度 = 底边 × √3/2（真正的等边三角）。
  // 旧版一律套正方形，画出来的是腰比底长的等腰三角形，和帮助里写的「正三角」对不上（B08）。
  function constrainBox(tool, a, p) {
    const dx = p.x - a.x, dy = p.y - a.y;
    if (tool === 'triangle') {
      const w = Math.max(Math.abs(dx), Math.abs(dy) * 2 / Math.sqrt(3));
      return {
        x: a.x + (dx < 0 ? -w : w),
        y: a.y + (dy < 0 ? -w * Math.sqrt(3) / 2 : w * Math.sqrt(3) / 2),
      };
    }
    const s = Math.max(Math.abs(dx), Math.abs(dy));
    return { x: a.x + (dx < 0 ? -s : s), y: a.y + (dy < 0 ? -s : s) };
  }
  // 一条形状可以拆成几条折线（箭头有分叉的箭头尖，所以不止一条）
  function shapePolylines(sh) {
    switch (sh.tool) {
      case 'line': return [[sh.a, sh.b]];
      case 'rect': { const p = rectCorners(sh); return [[p[0], p[1], p[2], p[3], p[0]]]; }
      case 'ellipse': { const p = ellipsePoints(sh, 32); return [p.concat([p[0]])]; }
      case 'triangle': { const p = trianglePoints(sh); return [[p[0], p[1], p[2], p[0]]]; }
      case 'arrow': {
        const h = arrowHead(sh.a, sh.b, sh.width);
        return [[sh.a, sh.b], [sh.b, h[0]], [sh.b, h[1]]];
      }
      default: return [];
    }
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
        // kind:'quote' 是「摘录」，用更淡的底 + 虚线和普通高亮区分；
        // kind:'underline' 是「下划线」，只在每行底部画一条线（Zotero 的下划线标注）。
        // kind:'strike' / 'squiggly' 来自 PDF 原生批注导入（删除线 / 波浪线）。
        const g = document.createElementNS(NS, 'g');
        g.setAttribute('class', 'text-mark'
          + (sh.kind === 'quote' ? ' text-quote' : '')
          + (sh.kind === 'underline' ? ' text-underline' : '')
          + (sh.kind === 'strike' ? ' text-strike' : '')
          + (sh.kind === 'squiggly' ? ' text-squiggly' : ''));
        for (const r of (sh.rects || [])) {
          const lineY = sh.kind === 'strike' ? r.y + Math.max(0, r.h / 2)
            : r.y + Math.max(0, r.h - 2);
          if (sh.kind === 'underline' || sh.kind === 'strike') {
            g.appendChild(el('rect', {
              x: r.x, y: lineY, width: Math.max(1, r.w), height: 2,
              fill: sh.color || '#ffd54f', 'fill-opacity': '0.95', rx: '1',
            }));
          } else if (sh.kind === 'squiggly') {
            g.appendChild(el('line', {
              x1: r.x, y1: lineY + 1, x2: r.x + Math.max(1, r.w), y2: lineY + 1,
              stroke: sh.color || '#e05a4f', 'stroke-width': 1.6, 'stroke-dasharray': '2 1.6',
            }));
          } else {
            g.appendChild(el('rect', {
              x: r.x, y: r.y, width: Math.max(1, r.w), height: Math.max(1, r.h),
              fill: sh.color || '#ffd54f', 'fill-opacity': sh.kind === 'quote' ? '0.18' : '0.42',
              stroke: sh.color || '#ffd54f', 'stroke-opacity': sh.kind === 'quote' ? '0.75' : '0.55', 'stroke-width': '1',
              rx: '1.5',
            }));
          }
        }
        const ti = el('title', {});
        const label = sh.kind === 'quote' ? '摘录：' : sh.kind === 'underline' ? '下划线：'
          : sh.kind === 'strike' ? '删除线：' : sh.kind === 'squiggly' ? '波浪线：' : '';
        ti.textContent = label + String(sh.text || '') + (sh.comment ? '\n评论：' + sh.comment : '');
        g.appendChild(ti);
        base.appendChild(g);
        break;
      }
      case 'pen':
      case 'smart':   // 没识别成功的一笔成型会退回手绘；旧数据也能照常显示
        top.appendChild(inkNode(sh)); break;
      case 'line':
        mk('line', Object.assign({ x1: sh.a.x, y1: sh.a.y, x2: sh.b.x, y2: sh.b.y }, stroke)); break;
      case 'rect': {
        const x = Math.min(sh.a.x, sh.b.x), y = Math.min(sh.a.y, sh.b.y);
        mk('rect', Object.assign({ x, y, width: Math.abs(sh.b.x - sh.a.x), height: Math.abs(sh.b.y - sh.a.y) }, stroke)); break;
      }
      case 'ellipse': {
        const c = cornersOf(sh);
        mk('ellipse', Object.assign({
          cx: c.cx, cy: c.cy, rx: Math.abs(c.x2 - c.x1) / 2, ry: Math.abs(c.y2 - c.y1) / 2,
        }, stroke)); break;
      }
      case 'triangle': {
        const t = trianglePoints(sh);
        mk('polygon', Object.assign({ points: t.map((q) => q.x + ',' + q.y).join(' ') }, stroke)); break;
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
      case 'image': {
        // 图片标注（v9）：页面上画一个虚线框标出位置，缩略图在文献库「标注」里看
        for (const r of (sh.rects || [])) {
          const box = el('rect', {
            x: r.x, y: r.y, width: Math.max(1, r.w), height: Math.max(1, r.h),
            fill: 'none', stroke: sh.color || '#8a7f6a', 'stroke-width': 1.2,
            'stroke-dasharray': '5 3', rx: '2',
          });
          const bti = el('title', {});
          bti.textContent = String(sh.text || '图片标注');
          box.appendChild(bti);
          top.appendChild(box);
          const badge = el('text', {
            x: r.x + 4, y: r.y + 13, fill: sh.color || '#8a7f6a',
            'font-size': '11', 'font-family': 'system-ui, "Segoe UI", sans-serif',
          });
          badge.textContent = '图';
          top.appendChild(badge);
        }
        break;
      }
      case 'stamp': {
        // 印章：圆角框 + 居中文字。用 dirty 的虚线感（dasharray）区分于普通矩形框，
        // 一眼能看出「这是盖章，不是画的框」。
        const box = stampBox(sh);
        const g = document.createElementNS(NS, 'g');
        g.setAttribute('class', 'stamp-mark');
        g.appendChild(el('rect', {
          x: box.x, y: box.y, width: box.w, height: box.h,
          rx: Math.min(6, box.h * 0.22), ry: Math.min(6, box.h * 0.22),
          fill: 'none', stroke: sh.color || '#2e7d32', 'stroke-width': Math.max(1.2, box.size * 0.11),
        }));
        const t = el('text', {
          x: box.x + box.w / 2, y: box.y + box.h / 2,
          fill: sh.color || '#2e7d32', 'font-size': box.size,
          'font-family': 'system-ui, "Segoe UI", "Microsoft YaHei", sans-serif',
          'font-weight': '600', 'text-anchor': 'middle', 'dominant-baseline': 'central',
          'letter-spacing': '0.5',
        });
        t.textContent = box.text;
        g.appendChild(t);
        const ti = el('title', {});
        ti.textContent = '印章：' + box.text + (sh.comment ? '\n' + sh.comment : '');
        g.appendChild(ti);
        top.appendChild(g);
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
    flushEraseGesture();   // 橡皮：整段手势合成一个撤销点（擦除已写进模型，取消也要提交）
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
    if (tool === 'stamp') {
      // 落章是「一次点击」的动作：不进拖拽手势，也不等 pointerup，
      // 否则用户点一下再移开鼠标，章会跟着跑到别处。
      const preset = STAMP_BY_ID.get(state.stamp) || STAMPS[0];
      const sh = {
        id: newAnnoId(), tool: 'stamp', at: p, stamp: preset.id, text: preset.text,
        color: preset.color, width: 0, size: state.textHeight || 15,
      };
      shapesOf(n).push(sh);
      undoStack.push({ type: 'add', n, shape: sh });
      renderPage(n);
      notify();
      return;
    }
    if (tool === 'text' || tool === 'note') {
      // 点到已有的便签/文字 → 打开编辑器改它；没点中才新建
      // （原来不管点哪儿都开一个空编辑器，保存过的便签再也点不开）
      startText(e, n, svg, p, tool, findEditable(n, p, tool));
      return;
    }
    try { svg.setPointerCapture(e.pointerId); pointerId = e.pointerId; }
    catch (_) { /* 合成事件或失效的 pointerId：不影响，move/up 已在 window 上兜住 */ }
    ctx = { n, svg };
    if (tool === 'eraser') {
      drawing = { tool: 'eraser', whole: !!e.altKey };
      beginEraseGesture(n, p, !!e.altKey);
      return;
    }
    const sh = { tool, color: state.color, width: state.width };
    // 「一笔成型」先按手绘收集点，抬手时才决定要不要换成标准图形
    if (tool === 'pen' || tool === 'highlight' || tool === 'smart') sh.pts = [p];
    else { sh.a = p; sh.b = p; }
    drawing = sh;
  }

  function onMove(e) {
    if (!drawing || !ctx) return;
    const { n, svg } = ctx;
    const p = toUnit(svg, e.clientX, e.clientY);
    if (drawing.tool === 'eraser') { eraseAt(n, p, drawing.whole); return; }
    if (drawing.pts) {
      const last = drawing.pts[drawing.pts.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) < MIN_STEP) return; // 太近的点丢弃
      drawing.pts.push(p);
    } else {
      drawing.b = p;
      // 按住 Shift 画方 / 正圆 / 正三角：把拖出来的框约束成正方形（三角形按等边算）
      if (e.shiftKey && GEOM_TOOLS.has(drawing.tool) && drawing.tool !== 'line' && drawing.tool !== 'arrow') {
        drawing.b = constrainBox(drawing.tool, drawing.a, p);
      }
    }
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
    else if (sh.tool === 'pen' || sh.tool === 'smart') group.appendChild(inkNode(sh));
    else if (sh.tool === 'line') mk('line', Object.assign({ x1: sh.a.x, y1: sh.a.y, x2: sh.b.x, y2: sh.b.y }, stroke));
    else if (sh.tool === 'rect') mk('rect', Object.assign({ x: Math.min(sh.a.x, sh.b.x), y: Math.min(sh.a.y, sh.b.y), width: Math.abs(sh.b.x - sh.a.x), height: Math.abs(sh.b.y - sh.a.y) }, stroke));
    else if (sh.tool === 'ellipse') {
      const c = cornersOf(sh);
      mk('ellipse', Object.assign({ cx: c.cx, cy: c.cy, rx: Math.abs(c.x2 - c.x1) / 2, ry: Math.abs(c.y2 - c.y1) / 2 }, stroke));
    }
    else if (sh.tool === 'triangle') mk('polygon', Object.assign({ points: trianglePoints(sh).map((q) => q.x + ',' + q.y).join(' ') }, stroke));
    else if (sh.tool === 'arrow') {
      mk('line', Object.assign({ x1: sh.a.x, y1: sh.a.y, x2: sh.b.x, y2: sh.b.y }, stroke));
      const h = arrowHead(sh.a, sh.b, sh.width);
      mk('line', Object.assign({ x1: sh.b.x, y1: sh.b.y, x2: h[0].x, y2: h[0].y }, stroke));
      mk('line', Object.assign({ x1: sh.b.x, y1: sh.b.y, x2: h[1].x, y2: h[1].y }, stroke));
    }
  }
  function clearPreview(n) { removeTemp(); }

  // ---- 一笔成型（ink-to-shape） ----
  // 参考 Drawboard 的 Smart ink、GoodNotes / Notability 的「画完停一下吸附」：
  // 鼠标没有「停住」这个动作，所以改成抬手即判定；认不出来的原样留成手绘，
  // 绝不擅自改掉用户画的东西。判定只看几何，不联网、不引入识别库。
  function bboxOf(pts) {
    let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
    for (const q of pts) {
      if (q.x < minx) minx = q.x; if (q.x > maxx) maxx = q.x;
      if (q.y < miny) miny = q.y; if (q.y > maxy) maxy = q.y;
    }
    return { minx, maxx, miny, maxy };
  }
  function pathLen(pts) {
    let n = 0;
    for (let i = 1; i < pts.length; i++) n += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    return n;
  }
  // 按弧长把闭合笔迹重采样成等距点：手写速度不均时，拐角计数才不会被采样密度带偏
  function resampleClosed(pts, count) {
    const loop = pts.concat([pts[0]]);
    const cum = [0];
    let total = 0;
    for (let i = 1; i < loop.length; i++) {
      total += Math.hypot(loop[i].x - loop[i - 1].x, loop[i].y - loop[i - 1].y);
      cum.push(total);
    }
    if (total <= 0) return [pts[0]];
    const out = [];
    for (let k = 0; k < count; k++) {
      const target = total * k / count;
      let i = 1;
      while (i < cum.length - 1 && cum[i] < target) i++;
      const t = (target - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1]);
      out.push({
        x: loop[i - 1].x + (loop[i].x - loop[i - 1].x) * t,
        y: loop[i - 1].y + (loop[i].y - loop[i - 1].y) * t,
      });
    }
    return out;
  }
  // 数「明显拐弯」的地方：圆几乎数不到，三角 3 个，矩形 4 个
  function cornerCount(points) {
    const n = points.length, win = Math.max(2, Math.round(n / 16));
    const turns = [];
    for (let i = 0; i < n; i++) {
      const a = points[(i - win + n) % n], b = points[i], c = points[(i + win) % n];
      const a1 = Math.atan2(b.y - a.y, b.x - a.x), a2 = Math.atan2(c.y - b.y, c.x - b.x);
      let d = a2 - a1;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      turns.push(Math.abs(d));
    }
    const used = new Array(n).fill(false);
    let count = 0;
    for (const [v, i] of turns.map((v, i) => [v, i]).sort((x, y) => y[0] - x[0])) {
      if (v < 0.7) break;                 // 约 40°，滤掉手抖
      if (used[i]) continue;
      count++;
      for (let k = -win; k <= win; k++) used[(i + k + n) % n] = true;
    }
    return count;
  }
  function geomShape(sh, tool, a, b) {
    const o = { tool, color: sh.color, width: sh.width, a, b };
    if (sh.comment) o.comment = sh.comment;
    return o;
  }
  function recognizeStroke(sh) {
    const pts = sh.pts || [];
    const keepPen = () => Object.assign({}, sh, { tool: 'pen' });
    if (pts.length < 6) return keepPen();
    const box = bboxOf(pts);
    const w = box.maxx - box.minx, h = box.maxy - box.miny;
    const diag = Math.hypot(w, h), len = pathLen(pts);
    if (diag < 18 || len < 20) return keepPen();
    const first = pts[0], last = pts[pts.length - 1];
    const closed = Math.hypot(last.x - first.x, last.y - first.y) < diag * 0.30 && len > diag * 1.8;
    if (!closed) {
      // 开放笔迹：只认「基本是直的」，其余保留手绘
      let dev = 0;
      for (const q of pts) dev = Math.max(dev, distToSeg(q, first, last));
      if (dev / Math.max(1, len) < 0.05) {
        return geomShape(sh, 'line', { x: first.x, y: first.y }, { x: last.x, y: last.y });
      }
      return keepPen();
    }
    const corners = cornerCount(resampleClosed(pts, 48));
    const a = { x: box.minx, y: box.miny }, b = { x: box.maxx, y: box.maxy };
    if (corners <= 2) {
      // 闭合又没尖角 → 圆。以较长边为直径，落在笔画的重心附近
      const cx = (box.minx + box.maxx) / 2, cy = (box.miny + box.maxy) / 2;
      const r = Math.max(w, h) / 2;
      return geomShape(sh, 'ellipse', { x: cx - r, y: cy - r }, { x: cx + r, y: cy + r });
    }
    if (corners === 3) return geomShape(sh, 'triangle', a, b);
    if (corners === 4 || corners === 5) return geomShape(sh, 'rect', a, b);
    return keepPen();
  }

  function commit(n, sh) {
    let out = sh;
    if (sh.tool === 'smart') {
      out = recognizeStroke(sh);
      const said = { line: '已拉直为直线', ellipse: '已吸附为标准圆', rect: '已吸附为矩形', triangle: '已吸附为三角形' };
      if (said[out.tool] && App.toast) App.toast(said[out.tool], 1800);
    }
    if (out.pts) {
      // 误点判定：没有实际拖动的落点（包围盒极小）不生成标注，避免留下小圆点污迹
      if (out.pts.length < 2) return;
      const box = bboxOf(out.pts);
      if (box.maxx - box.minx < 1.5 && box.maxy - box.miny < 1.5) return;
    } else if (!out.a || (Math.abs(out.a.x - out.b.x) < 1 && Math.abs(out.a.y - out.b.y) < 1)) {
      return;
    }
    out.id = newAnnoId();      // v8：稳定 id 在形状落地时就定下来
    shapesOf(n).push(out);
    undoStack.push({ type: 'add', n, shape: out });
  }

  // ---- 橡皮：局部擦除（默认） / 整条删除（按住 Alt） ----
  // 参考 Xodo「擦到哪删到哪」与 Drawboard 的 Partial / Whole Erase：
  // 笔迹和所有几何形状都按「擦头圆与线段的交点」切开，只留下没被碰到的那几段，
  // 而不是把整条直线 / 整个矩形一起删掉（这是 1.7.0 之前的老行为）。
  // 擦出来的碎片统一变成笔迹：它们还能继续被局部擦、被撤销，也不会破坏导出。
  const ERASE_R = 7;   // 单位坐标（=scale-1 视口像素）半径

  function canSplitShape(sh) {
    if ((sh.tool === 'pen' || sh.tool === 'highlight') && Array.isArray(sh.pts) && sh.pts.length > 1) return true;
    if (sh.tool === 'mark') return Array.isArray(sh.rects) && sh.rects.length > 0;
    return GEOM_TOOLS.has(sh.tool) && !!(sh.a && sh.b);
  }

  /*
   * 一次橡皮手势 = 一个撤销点。
   * 旧实现在每次采样命中时压一条撤销记录，一次拖拽横跨三条线就要按三次 Ctrl+Z（B07）。
   * 现在手势期间只往 eraserGesture.steps 里攒「这一步改了什么」，抬手时合成一个复合记录。
   * 擦除一旦发生就已经写进模型了，所以 pointercancel / 失焦也照样提交，
   * 否则用户会得到一个「擦了但撤不回」的半状态。
   */
  let eraserGesture = null;

  function pushEraseStep(step) {
    if (eraserGesture) eraserGesture.steps.push(step);
    else undoStack.push(step);
  }

  /*
   * 单个采样点上的擦除；只改模型，不渲染、不入栈（由外层统一收尾）。
   *
   * 以前命中一条就 return，叠在一起的两条笔迹只擦得到上层，下层整条留在那儿（R04）。
   * 现在先把「这个采样点命中的所有原始形状」拍个快照再逐个处理：
   *   · 快照里没有本轮刚切出来的碎片，所以不会同一个点反复切自己；
   *   · 形状被前一步整条删掉时 indexOf 找不到，直接跳过；
   *   · 从下往上改，splice 之后剩下的索引仍然有效。
   */
  function eraseOnce(n, p, whole) {
    const arr = shapesOf(n);
    const targets = arr.filter((sh) => sh && hit(sh, p));
    if (!targets.length) return false;
    let changed = false;
    for (const sh of targets) {
      const i = arr.indexOf(sh);
      if (i < 0) continue;
      if (!whole && canSplitShape(sh)) {
        const parts = sh.tool === 'mark' ? splitMark(sh, p, ERASE_R) : splitShape(sh, p, ERASE_R);
        if (parts.length === 1 && parts[0] === sh) continue;   // 只是命中框偏宽，实际没擦到
        arr.splice(i, 1, ...parts);
        pushEraseStep({ type: 'erase', n, index: i, before: sh, after: parts });
      } else {
        arr.splice(i, 1);
        pushEraseStep({ type: 'del', n, index: i, shape: sh });
      }
      changed = true;
    }
    return changed;
  }

  /*
   * 连续扫掠：指针事件是稀疏的（画快了 / 掉帧时一次移动可能跨几十个单位），
   * 只在事件点擦会留下中间一段没擦到的「大桥」（B06，实测 140→260 中间 106 单位还在）。
   * 这里按擦头半径的 0.6 倍插值，把整段路径都过一遍；上限 400 步，避免一次疯狂拖动
   * 变成上万次判定。
   */
  function eraseSweep(n, from, to, whole) {
    if (!from) return eraseOnce(n, to, whole);
    const d = Math.hypot(to.x - from.x, to.y - from.y);
    const stepLen = Math.max(1.5, ERASE_R * 0.6);
    const steps = Math.min(400, Math.max(1, Math.ceil(d / stepLen)));
    let changed = false;
    for (let i = 1; i <= steps; i++) {
      if (eraseOnce(n, lerpPt(from, to, i / steps), whole)) changed = true;
    }
    return changed;
  }

  function eraseAt(n, p, whole) {
    if (eraserGesture && eraserGesture.n === n) {
      const from = eraserGesture.last;
      eraserGesture.last = p;
      if (eraseSweep(n, from, p, whole)) renderPage(n);
      return;
    }
    if (eraseSweep(n, null, p, whole)) renderPage(n);
  }

  function beginEraseGesture(n, p, whole) {
    eraserGesture = { n, last: p, steps: [] };
    if (eraseOnce(n, p, whole)) renderPage(n);
  }

  function flushEraseGesture() {
    const g = eraserGesture;
    eraserGesture = null;
    if (!g || !g.steps.length) return;
    if (g.steps.length === 1) undoStack.push(g.steps[0]);
    else undoStack.push({ type: 'compound', n: g.n, steps: g.steps });
  }

  const lerpPt = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

  // 一条线段被圆擦掉中间一截时，返回圆外的 t 区间（[0,1] 表示整段都留着）
  function outsideParts(a, b, p, R) {
    const dx = b.x - a.x, dy = b.y - a.y, fx = a.x - p.x, fy = a.y - p.y;
    const A = dx * dx + dy * dy;
    if (A < 1e-9) return (fx * fx + fy * fy > R * R) ? [[0, 1]] : [];
    const B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - R * R;
    const D = B * B - 4 * A * C;
    if (D <= 0) return [[0, 1]];
    const sq = Math.sqrt(D);
    const t1 = (-B - sq) / (2 * A), t2 = (-B + sq) / (2 * A);
    if (t2 <= 0 || t1 >= 1) return [[0, 1]];
    const lo = Math.max(0, t1), hi = Math.min(1, t2);
    const out = [];
    if (lo > 0) out.push([0, lo]);
    if (hi < 1) out.push([hi, 1]);
    return out;
  }

  // 折线按圆切成若干段；相邻且没被擦到的段会重新接成一条，不会碎成一堆小形状
  function splitPolyline(pts, p, R) {
    const runs = [];
    let cur = null, cut = false;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const parts = outsideParts(a, b, p, R);
      const full = parts.length === 1 && parts[0][0] === 0 && parts[0][1] === 1;
      if (full) {
        if (!cur) cur = [a];
        cur.push(b);
        continue;
      }
      cut = true;
      for (const [lo, hi] of parts) {
        const s = lerpPt(a, b, lo), e = lerpPt(a, b, hi);
        if (Math.hypot(e.x - s.x, e.y - s.y) < 1.2) {          // 碎渣不留，也算一个断口
          if (cur && cur.length >= 2) runs.push(cur);
          cur = null;
          continue;
        }
        if (lo <= 1e-6 && cur) cur.push(e);                     // 和上一段连着，别切成两截
        else {
          if (cur && cur.length >= 2) runs.push(cur);
          cur = [s, e];
        }
        if (hi < 0.999999) {                                    // 到圆周为止，后面的段另起一条
          if (cur.length >= 2) runs.push(cur);
          cur = null;
        }
      }
    }
    if (cur && cur.length >= 2) runs.push(cur);
    return { cut, runs };
  }

  function splitShape(sh, p, R) {
    const isInk = sh.tool === 'pen' || sh.tool === 'highlight';
    const polys = isInk ? [sh.pts] : shapePolylines(sh);
    const pieces = [];
    let cut = false;
    for (const poly of polys) {
      const r = splitPolyline(poly, p, R);
      if (r.cut) cut = true;
      for (const pts of r.runs) if (pts && pts.length >= 2) pieces.push(pts);
    }
    if (!cut) return [sh];
    if (!pieces.length) return [];                 // 整条都被擦光了
    return pieces.map((pts, k) => {
      const id = k === 0 ? (sh.id || newAnnoId()) : newAnnoId();
      if (isInk) return Object.assign({}, sh, k === 0 ? { pts } : { pts, id });
      const o = { tool: 'pen', color: sh.color, width: sh.width || 2, pts, id };
      if (sh.comment) o.comment = sh.comment;
      return o;
    });
  }

  // 文字高亮：按横向切一刀，保留左右两截（窄于 1.5 的碎渣不留）
  function splitMark(sh, p, R) {
    const out = [];
    let cut = false;
    for (const r of sh.rects) {
      // 纵向没覆盖到这一行就不动它，否则擦一行会顺带削掉上下行
      if (p.y < r.y - R || p.y > r.y + r.h + R) { out.push(r); continue; }
      const leftW = Math.max(0, Math.min(r.w, (p.x - R) - r.x));
      const rightW = Math.max(0, Math.min(r.w, (r.x + r.w) - (p.x + R)));
      if (leftW + rightW >= r.w - 0.5) { out.push(r); continue; }   // 没切到
      cut = true;
      if (leftW >= 1.5) out.push({ x: r.x, y: r.y, w: leftW, h: r.h });
      if (rightW >= 1.5) out.push({ x: r.x + r.w - rightW, y: r.y, w: rightW, h: r.h });
    }
    if (!cut) return [sh];
    if (!out.length) return [];                 // 整条都被擦掉了
    return [Object.assign({}, sh, { rects: out })];
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
    if (sh.tool === 'stamp') {
      const b = stampBox(sh);
      return p.x >= b.x - r && p.x <= b.x + b.w + r && p.y >= b.y - r && p.y <= b.y + b.h + r;
    }
    // 几何形状按真实轮廓命中：矩形只在边框附近算（框内空白不算），
    // 箭头连两个箭头尖也算，圆 / 三角按折线近似算 —— 橡皮才能只擦到经过的那一段。
    if (GEOM_TOOLS.has(sh.tool)) {
      for (const poly of shapePolylines(sh)) {
        for (let i = 0; i < poly.length - 1; i++) {
          if (distToSeg(p, poly[i], poly[i + 1]) < r) return true;
        }
      }
      return false;
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
    // v9：输入框和最终排出来的文字用同一套字号/行高/字体，并且跟着页面缩放 ——
    // 以前输入框固定 13px、缩放 150% 时最终文字大一圈，用户看到的就是「输入时和正式的不一致」。
    // 双页独立缩放时按「这一页」的缩放算，不能用全局 scale。
    const zs = (App.pageScale ? App.pageScale(n) : (App.state.scale || 1)) || 1;
    const zsize = (state.textHeight || 14) * zs;
    ed.style.font = zsize + 'px/1.25 "Segoe UI", system-ui, -apple-system, "Microsoft YaHei", sans-serif';
    ed.style.width = Math.max(170, Math.round(190 * zs)) + 'px';
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
        const sh = { id: newAnnoId(), tool: kind, color: state.color, width: 0, size: state.textHeight,
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
    eraserGesture = null;
  }
  function undo() {
    const op = undoStack.pop();
    if (!op) { App.toast('没有可撤销的标注'); return; }
    const arr = shapesOf(op.n);
    if (op.type === 'add') {
      const i = arr.indexOf(op.shape); if (i >= 0) arr.splice(i, 1);
    } else if (op.type === 'del') {
      // 放回原来的位置：擦掉中间一条再撤销，不该把它挪到末尾
      arr.splice(Math.min(op.index == null ? arr.length : op.index, arr.length), 0, op.shape);
    } else if (op.type === 'edit') {
      // 改写便签/文字：撤销回原来的内容
      op.shape.text = op.before;
    } else if (op.type === 'erase') {
      // 局部擦除：先把擦出来的碎片摘掉，再把原形状放回它原来的位置
      for (const piece of (op.after || [])) {
        const i = arr.indexOf(piece);
        if (i >= 0) arr.splice(i, 1);
      }
      arr.splice(Math.min(op.index, arr.length), 0, op.before);
    } else if (op.type === 'compound') {
      // 逐步倒放（后发生的先撤），这样中途产生的碎片 / 索引都能对上
      for (let i = op.steps.length - 1; i >= 0; i--) {
        const st = op.steps[i];
        if (st.type === 'erase') {
          for (const piece of (st.after || [])) {
            const k = arr.indexOf(piece);
            if (k >= 0) arr.splice(k, 1);
          }
          arr.splice(Math.min(st.index, arr.length), 0, st.before);
        } else if (st.type === 'del') {
          arr.splice(Math.min(st.index == null ? arr.length : st.index, arr.length), 0, st.shape);
        }
      }
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

  // v8：每条标注一个稳定 id。库里按 id 存标签 / 所属条目，删掉中间一条不能再串位。
  const ANNO_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  function newAnnoId() {
    let s = '';
    const buf = new Uint8Array(10);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(buf);
    else for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
    for (let i = 0; i < buf.length; i++) s += ANNO_ALPHABET[buf[i] % ANNO_ALPHABET.length];
    return 'a' + s;
  }

  // 供选区高亮/评论等外部模块写入模型，同时进撤销栈
  function addShape(n, sh, opts) {
    if (!sh) return null;
    if (!sh.id) sh.id = newAnnoId();
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
  // 绘制参数只在真要落笔时出现：浏览 / 看图 / 橡皮 / 印章不必常年摆着六个色点。
  // 六色与分工具记忆都还在，只是收进了「用得上的时候」。
  const COLOR_TOOLS = new Set(['pen', 'highlight', 'line', 'rect', 'arrow', 'text', 'note', 'ellipse', 'triangle', 'smart']);
  const WIDTH_TOOLS = new Set(['pen', 'highlight', 'line', 'rect', 'arrow', 'ellipse', 'triangle', 'smart']);
  function syncParams() {
    const box = document.getElementById('note-params');
    if (box) box.hidden = !COLOR_TOOLS.has(state.tool);
    const w = document.getElementById('note-width-wrap');
    if (w) w.hidden = !WIDTH_TOOLS.has(state.tool);
  }

  function setTool(t) {
    // 切工具时把当前颜色存回旧工具那一桶、取出新工具那一桶：
    // 于是「荧光笔上次用的绿」和「画笔上次用的红」互不干扰。
    const prevBucket = bucketOf(state.tool);
    if (prevBucket) bucketColor[prevBucket] = state.color;
    state.tool = t;
    const nextBucket = bucketOf(t);
    if (nextBucket) state.color = bucketColor[nextBucket];
    document.body.classList.remove('tool-select', 'tool-pen', 'tool-highlight', 'tool-line', 'tool-rect', 'tool-arrow', 'tool-text', 'tool-eraser', 'tool-note', 'tool-image', 'tool-stamp',
      'tool-ellipse', 'tool-triangle', 'tool-smart');
    document.body.classList.add('tool-' + t);
    for (const b of document.querySelectorAll('.ntool')) b.classList.toggle('active', b.dataset.tool === t);
    const bar = document.getElementById('stamp-bar');
    if (bar) bar.hidden = t !== 'stamp';
    const hint = document.getElementById('smart-hint');
    if (hint) hint.hidden = t !== 'smart';
    syncColor();
    syncParams();
    if (t === 'image' && !hintShown) {
      // 同一条提示只弹一次，不然每次按 V 都闪一下
      hintShown = true;
      App.toast && App.toast('看图模式：点页面里的图片查看原图（放大任意区域用右键菜单）');
    }
  }

  // 所有工具都在一排里：点一下就切，没有需要先展开的浮层
  function init() {
    bindGlobalPointer();
    for (const b of document.querySelectorAll('.ntool')) {
      b.addEventListener('click', () => setTool(b.dataset.tool));
    }
    document.getElementById('note-color').addEventListener('input', (e) => setColor(e.target.value));
    buildSwatches();
    syncColor();
    document.getElementById('note-width').addEventListener('change', (e) => { state.width = parseFloat(e.target.value) || 3; });
    document.getElementById('btn-undo').addEventListener('click', undo);
    document.getElementById('btn-clear-page').addEventListener('click', clearPage);
    // 印章预设：点一个就切过去（保持印章工具不变，方便连着盖）
    const sbar = document.getElementById('stamp-bar');
    if (sbar) {
      sbar.addEventListener('click', (e) => {
        const b = e.target.closest('[data-stamp]');
        if (!b) return;
        state.stamp = b.dataset.stamp;
        setTool('stamp');
        for (const x of sbar.querySelectorAll('[data-stamp]')) x.classList.toggle('active', x.dataset.stamp === state.stamp);
      });
    }
    setTool('select');
  }

  return {
    init, attachPage, setTool, undo, clearPage, renderPage, addShape, updateShape, reset,
    newAnnoId, setColor, PALETTE, recognizeStroke,
    // 导出要按「真实的三个顶点」逐点换算，不能再从包围框重建（B05）
    trianglePoints,
    shapePolylines,
    get state() { return state; },
  };
})();
