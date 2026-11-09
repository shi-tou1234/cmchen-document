'use strict';
/*
 * 界面分组下拉（v1.6.3）：把低频功能从主栏收进有名字的菜单。
 *
 * 为什么要单独一份：阅读顶栏、标注栏、笔记格式栏、文献库、详情、设置
 * 都要「收起但找得到」。如果每处各写一套 open/close，行为迟早会飘：
 * 有的选完不收、有的 Esc 不关、帮助「在界面定位」只滚不展开。
 *
 * 约定（纯 markup 驱动，不写死任何业务按钮）：
 *   <div class="dd-wrap" data-menu="xxx">
 *     <button class="dd-btn" data-menu-btn>…</button>
 *     <div class="dd-pop" data-menu-pop hidden>…</div>
 *   </div>
 *   - 点菜单里的按钮默认收起；加 data-menu-keep 可保持打开（例如工具面板）
 *   - 点外部 / Esc 收起；Esc 时焦点退回触发按钮
 *   - reveal(el)：把 el 所有隐藏的祖先菜单展开，供帮助「在界面定位」调用
 *
 * 不在本模块里的老下拉（#more-pop、#lib-more-pop）由各自模块管理，
 * 但 reveal() 对它们一视同仁——只要父层是 .dd-pop，就能一起展开。
 */
window.GroupMenus = (function () {
  const wraps = [];

  const EDGE = 8;   // 与视口上下边缘至少留出的余地
  const GAP = 5;    // 与触发按钮的间距，和 CSS 的 calc(100% + 5px) 保持一致

  // 窄窗口把分组搬进「更多」后，子菜单是内联展开的（position: static）：
  // 它的高度由外层浮层负责，自己不该再设上限。
  function isInline(pop) {
    return !!(pop && pop.isConnected && getComputedStyle(pop).position === 'static');
  }

  function resetFit(pop) {
    if (!pop) return;
    pop.style.maxHeight = '';
    pop.style.overflowY = '';
    pop.classList.remove('is-up');
  }

  // 窗口不高时，菜单会一路画到屏幕外面：下面那几项看得见、点不到。
  // 做法是给浮层一个「实际还剩多少高度」的上限，超出部分在菜单内部滚动；
  // 上方空间更大时改为向上展开。只动纵向，横向对齐仍交给 CSS。
  function fit(pop) {
    if (!pop || pop.hidden) return;
    if (isInline(pop)) { resetFit(pop); return; }
    const wrap = pop.parentElement;
    const btn = wrap ? wrap.querySelector('[data-menu-btn]') : null;
    // 先量自然高度：清掉上一次的限制，否则量到的是被裁过的值
    pop.style.maxHeight = 'none';
    pop.style.overflowY = 'visible';
    pop.classList.remove('is-up');
    const natural = Math.round(pop.getBoundingClientRect().height);
    const vh = window.innerHeight;
    const a = btn ? btn.getBoundingClientRect() : null;
    const below = a ? vh - a.bottom - GAP - EDGE : vh - EDGE * 2;
    const above = a ? a.top - GAP - EDGE : 0;
    const up = natural > below && above > below;
    const space = Math.max(0, up ? above : below);
    pop.classList.toggle('is-up', up);
    if (natural <= space) {
      pop.style.maxHeight = '';
      pop.style.overflowY = '';
    } else {
      pop.style.maxHeight = Math.max(48, Math.floor(space)) + 'px';
      pop.style.overflowY = 'auto';
    }
  }

  // 子菜单展开后父层内容变长，父层的高度上限要跟着重算；反之收起时也要收回去。
  function refitChain(pop) {
    fit(pop);
    let node = pop.parentElement;
    while (node) {
      const outer = node.closest ? node.closest('.dd-pop') : null;
      if (!outer) break;
      fit(outer);
      node = outer.parentElement;
    }
  }

  // 内联子菜单刚展开时，触发行可能正好落在滚动区底部：把子项往上露出来一点。
  function revealInScroller(btn) {
    const sc = btn && btn.closest ? btn.closest('.dd-pop') : null;
    if (!sc || sc.scrollHeight <= sc.clientHeight + 1) return;
    const sr = sc.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    if (br.top < sr.top + 2) sc.scrollTop += br.top - sr.top - 6;
    else if (br.bottom > sr.bottom - 2) sc.scrollTop += Math.min(br.bottom - sr.bottom + 6, br.top - sr.top - 6);
  }

  function set(wrap, open, focusBack) {
    const btn = wrap.querySelector('[data-menu-btn]');
    const pop = wrap.querySelector('[data-menu-pop]');
    if (!pop) return;
    if (open) closeAll(wrap);
    pop.hidden = !open;
    if (open) {
      // 打开这一刻才知道还剩多少视口可用；键盘 / 帮助定位 打开的菜单也走这里
      refitChain(pop);
      revealInScroller(btn);
    } else {
      resetFit(pop);
    }
    if (btn) {
      btn.classList.toggle('open', open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    if (!open && focusBack && btn && pop.contains(document.activeElement)) {
      try { btn.focus(); } catch (_) {}
    }
  }

  // 一个 wrap 是否「住在」另一个 wrap 展开的面板里。
  // 窄窗口把「页面布局 / 导出」搬进「更多」后，它们就成了嵌套菜单：
  // 打开子菜单时若把父层一起关掉，子面板会跟着祖先一起消失（点开一闪就没）。
  function nestedIn(wrap, ancestor) {
    const pop = ancestor && ancestor.querySelector('[data-menu-pop]');
    return !!(pop && pop.contains(wrap));
  }

  function closeAll(except) {
    for (const w of wraps) {
      if (w === except) continue;
      // 保留 except 的整条祖先链，只关不相关的分组
      if (except && nestedIn(except, w)) continue;
      const p = w.querySelector('[data-menu-pop]');
      if (p && !p.hidden) set(w, false);
    }
  }

  // 菜单嵌套深度：Esc 先关最深的一层（子菜单 → 父菜单 → 更外层）
  function depthOf(wrap) {
    let d = 0;
    let node = wrap.parentElement;
    while (node) {
      const pop = node.closest && node.closest('.dd-pop');
      if (!pop) break;
      d++;
      node = pop.parentElement ? pop.parentElement.parentElement : null;
    }
    return d;
  }

  function deepestOpen() {
    let best = null, bestD = -1;
    for (const w of wraps) {
      const p = w.querySelector('[data-menu-pop]');
      if (!p || p.hidden) continue;
      const d = depthOf(w);
      if (d > bestD) { best = w; bestD = d; }
    }
    return best;
  }

  // 帮助定位：把目标所在的所有收起层都打开（含别的模块管的下拉与分组页签）
  function reveal(el) {
    let opened = 0;
    let cur = el;
    while (cur && cur !== document.body && cur.parentElement) {
      if (cur.hidden && cur.classList && cur.classList.contains('dd-pop')) {
        cur.hidden = false;
        opened++;
        const btn = cur.parentElement.querySelector('.dd-btn');
        if (btn) { btn.classList.add('open'); btn.setAttribute('aria-expanded', 'true'); }
      }
      // 详情 / 设置的分组页：定位到别的分组里的控件时先切过去
      if (cur.hidden && cur.dataset && cur.dataset.pane) {
        const isSet = !!cur.closest('#settings-modal');
        const sel = isSet
          ? '[data-set-pane="' + cur.dataset.pane + '"]'
          : '[data-pane-btn="' + cur.dataset.pane + '"]';
        const btn = document.querySelector(sel);
        if (btn) btn.click();              // 真正切页，让业务代码同步状态
        if (cur.hidden) { cur.hidden = false; opened++; }
      }
      cur = cur.parentElement;
    }
    return opened;
  }

  function open(id) {
    const wrap = document.querySelector('.dd-wrap[data-menu="' + id + '"]');
    if (wrap) set(wrap, true);
  }

  function close(id) {
    const wrap = document.querySelector('.dd-wrap[data-menu="' + id + '"]');
    if (wrap) set(wrap, false);
  }

  // 窄窗口把「页面布局 / 导出」两个低频分组挪进一个溢出菜单，主栏保持单行。
  // 用 DOM 搬家而不是隐藏：搬过去的还是原来那几个按钮，功能与可达性都不丢。
  //
  // 什么时候算窄：不写死某个像素值，而是把分组放回去、按单行量一次真实内容宽度。
  // 图标尺寸、字号、文案长度、系统缩放都会影响占宽，写死 1020 只会在改版后悄悄失准。
  function initOverflow() {
    const host = document.getElementById('tb-overflow-pop');
    const ovWrap = document.getElementById('tb-overflow-wrap');
    const tb = document.getElementById('toolbar');
    if (!host || !ovWrap || !tb) return;
    // 页面排列与分屏已经常驻主栏（用户要求「页面布局不要下拉」），只剩导出这一组
    // 会在窄窗口收进「更多」。占位 span 的数量跟着 movable 走，DOM 搬家逻辑不变。
    const movable = ['tb-output-wrap']
      .map((id) => document.getElementById(id)).filter(Boolean);
    if (!movable.length) return;
    const slots = movable.map((g) => {
      const s = document.createElement('span');
      s.className = 'tb-slot';
      g.parentNode.insertBefore(s, g);
      return s;
    });
    const place = (narrow) => {
      movable.forEach((g, i) => {
        if (narrow) host.appendChild(g);
        else if (slots[i].parentNode) slots[i].parentNode.insertBefore(g, slots[i].nextSibling);
      });
    };
    // 先按「不换行、不压缩」量一次：内容总宽是否超过可用宽。
    // 只设 nowrap 不够：按钮默认 flex-shrink:1 会被压扁，量出来永远「刚好放得下」。
    const fits = () => {
      // 可用宽度取「工具栏自身宽」和「窗口宽」中较小的那个：正常情况下两者一致，
      // 窗口还在动画 / 布局未落定时以窗口宽为准，宁可早点收进菜单也不要挤成两行。
      const avail = Math.min(tb.clientWidth, window.innerWidth);
      const prevW = tb.style.width;
      tb.classList.add('tb-measuring');
      // 量之前把工具栏压到可用宽：真实窗口里本来就相等，这样量到的 scrollWidth
      // 才是「内容比可用宽多多少」——否则它会被 clientWidth 顶住，永远显示放得下。
      tb.style.width = avail + 'px';
      const rowH = Math.round(tb.getBoundingClientRect().height);
      const over = tb.scrollWidth > avail + 1;
      tb.style.width = prevW;
      tb.classList.remove('tb-measuring');
      if (over) return false;
      // nowrap 量着「放得下」，实际布局仍可能因为取整 / 可伸缩元素多出半像素而换行：
      // 以真实高度为准，比单行高就当作放不下。只在「量的是真实窗口宽」时这么判 —
      // 测试里会把 innerWidth 改小来模拟窄窗，此时真实布局仍是宽窗口，高度说明不了问题。
      if (Math.abs(tb.clientWidth - window.innerWidth) > 2) return true;
      return Math.round(tb.getBoundingClientRect().height) <= rowH + 2;
    };
    const measure = () => {
      // 量的是「全放回主栏要占多宽」，「更多」按钮自己不该算进去，否则宽窗口也会误判成放不下
      const wasHidden = ovWrap.hidden;
      ovWrap.hidden = true;
      place(false);
      const over = !fits();
      ovWrap.hidden = wasHidden;
      return over;
    };
    let narrow = null;
    let lastW = -1;
    const apply = (force) => {
      // 宽度没变就不重量：每次 resize 都先把分组搬回主栏再判断，会白抖一下
      if (!force && window.innerWidth === lastW) return;
      lastW = window.innerWidth;
      let needNarrow = measure();
      if (needNarrow) {
        // 收进「更多」只有在真能省出一行时才有意义。窗口窄到连主操作都放不下时，
        // 藏掉两个分组仍然是两行 —— 那就别再多出一个「更多」按钮，让它自然换行。
        ovWrap.hidden = false;
        place(true);
        if (!fits()) {
          ovWrap.hidden = true;
          place(false);
          needNarrow = false;
        }
      } else {
        ovWrap.hidden = true;
      }
      if (needNarrow === narrow) return;
      const wasNarrow = narrow;
      narrow = needNarrow;
      // 只在「从窄变宽」时收菜单：启动时第一次量宽不等于用户刚关了一个菜单，
      // 别把已经展开的分组顺手关掉。
      if (!narrow && wasNarrow === true) closeAll();
    };
    window.addEventListener('resize', () => apply(false));
    apply(true);
    // 字体加载完宽度会变（中文字体尤其），加载后再量一次；只用一次性回调，
    // 不用 ResizeObserver —— 搬家本身会改高度，观察自己会来回触发。
    if (document.fonts && document.fonts.ready) {
      Promise.resolve(document.fonts.ready).then(() => apply(true)).catch(() => {});
    }
    return apply;
  }

  function bindWrap(wrap) {
    if (wrap._gmInited) return;
    wrap._gmInited = true;
    wraps.push(wrap);
    const btn = wrap.querySelector('[data-menu-btn]');
    const pop = wrap.querySelector('[data-menu-pop]');
    if (!btn || !pop) return;
    btn.setAttribute('aria-haspopup', 'true');
    btn.setAttribute('aria-expanded', 'false');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      set(wrap, pop.hidden);
    });
    pop.addEventListener('click', (e) => {
      const item = e.target.closest('button, [data-menu-close]');
      if (!item || item.hasAttribute('data-menu-btn')) return;
      if (item.dataset && item.dataset.menuKeep !== undefined) return;
      set(wrap, false);
    });
  }

  // 动态渲染的面板（例如详情里的「文件操作」）也能用同一套行为
  function bind(root) {
    for (const w of (root || document).querySelectorAll('.dd-wrap[data-menu]')) bindWrap(w);
  }

  function init() {
    bind(document);

    document.addEventListener('click', (e) => {
      for (const w of wraps) {
        const p = w.querySelector('[data-menu-pop]');
        if (p && !p.hidden && !w.contains(e.target)) set(w, false);
      }
    }, true);
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      // 嵌套时一次只退一层：子菜单 → 父菜单。否则一次 Esc 把整条链关掉，
      // 用户会以为自己点错了地方。
      const w = deepestOpen();
      if (w) {
        e.preventDefault();
        e.stopPropagation();
        set(w, false, true);
      }
    }, true);

    // 拖窗口改高度时，已经展开的菜单要跟着重新分配高度，否则会悬在屏幕外
    let rz = 0;
    window.addEventListener('resize', () => {
      if (rz) return;
      rz = requestAnimationFrame(() => {
        rz = 0;
        for (const w of wraps) {
          const p = w.querySelector('[data-menu-pop]');
          if (p && !p.hidden) fit(p);
        }
      });
    });

    initOverflow();
  }

  return { init, bind, reveal, open, close, closeAll, set };
})();

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => window.GroupMenus.init());
else window.GroupMenus.init();
