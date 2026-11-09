'use strict';
/*
 * 工具栏悬停提示（1.7.0 批次 B）。
 *
 * 为什么不用原生 title：按钮改成纯图标后，说明全靠悬停；原生提示要等约 1 秒、
 * 样式是系统的、位置也不受控。这里换成一个 300ms 出现的小气泡。
 *
 * 做法：显示期间把 title 挪到 data-tip-held（否则原生提示会随后叠上来），
 * 移开 / 按下 / 滚动 / 切窗时还原。只接管工具栏、标注栏、标签条与选区浮条，
 * 其余地方的 title 行为不变。
 */
window.Tips = (function () {
  const HOSTS = '#toolbar, #notetools';
  let layer = null;
  let timer = 0;
  let cur = null;
  let inited = false;

  function ensure() {
    if (layer && layer.isConnected) return layer;
    layer = document.createElement('div');
    layer.id = 'tip-layer';
    layer.setAttribute('role', 'tooltip');
    layer.hidden = true;
    document.body.appendChild(layer);
    return layer;
  }

  function hold(el) {
    if (el.dataset.tipHeld != null) return;
    el.dataset.tipHeld = el.getAttribute('title') || '';
    el.removeAttribute('title');
  }

  function release(el) {
    const held = el.dataset.tipHeld;
    if (held == null) return;
    delete el.dataset.tipHeld;
    // 显示期间业务代码可能改了 title（例如入库按钮）：有新的就不再写回旧值
    if (held && !el.getAttribute('title')) el.setAttribute('title', held);
  }

  function hide() {
    if (timer) { clearTimeout(timer); timer = 0; }
    if (cur) { release(cur); cur = null; }
    if (layer) layer.hidden = true;
  }

  function place(el, text) {
    const box = ensure();
    box.textContent = text;
    box.hidden = false;
    const r = el.getBoundingClientRect();
    const w = box.offsetWidth, h = box.offsetHeight;
    let left = r.left + r.width / 2 - w / 2;
    left = Math.max(6, Math.min(left, window.innerWidth - w - 6));
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 6) top = Math.max(6, r.top - h - 6);
    box.style.left = Math.round(left) + 'px';
    box.style.top = Math.round(top) + 'px';
  }

  function host(node) {
    const el = node && node.closest ? node.closest('[title], [data-tip-held]') : null;
    if (!el || !el.closest(HOSTS)) return null;
    // 菜单里的条目本来就有完整名称，不需要再浮一层提示
    if (el.closest('.dd-pop')) return null;
    return el;
  }

  function init() {
    if (inited) return;
    inited = true;
    let pointerAt = 0;

    document.addEventListener('pointerover', (e) => {
      const el = host(e.target);
      if (!el || el === cur) return;
      hide();
      cur = el;
      hold(el);
      timer = setTimeout(() => { timer = 0; if (cur === el) place(el, el.dataset.tipHeld || ''); }, 300);
    });
    document.addEventListener('pointerout', (e) => {
      const el = host(e.target);
      if (!el || el !== cur) return;
      const to = e.relatedTarget;
      if (to && el.contains(to)) return;   // 在按钮内部挪动（图标 / 文字）不算离开
      hide();
    });

    // 键盘用户同样要能知道图标是什么：Tab 聚焦时直接给提示。
    // 鼠标点出来的焦点不弹（pointerdown 已经收起了提示），否则点一下就先冒一个气泡。
    document.addEventListener('pointerdown', () => { pointerAt = Date.now(); }, true);
    document.addEventListener('focusin', (e) => {
      const el = host(e.target);
      if (!el) return;
      if (Date.now() - pointerAt < 600) return;
      hide();
      cur = el;
      hold(el);
      place(el, el.dataset.tipHeld || '');
    });
    document.addEventListener('focusout', (e) => {
      const el = host(e.target);
      if (el && el === cur) hide();
    });

    // 按下 / 点击 / Esc / 切窗：连「还在等 300ms」的那一个也一起取消。
    // 之前只收已经显示的，于是快速点开菜单后，过期提示还会补着弹出来盖住菜单。
    const hideNow = () => hide();
    document.addEventListener('pointerdown', hideNow, true);
    document.addEventListener('click', hideNow, true);
    window.addEventListener('scroll', () => { if (layer && !layer.hidden) hide(); }, true);
    window.addEventListener('blur', hideNow);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideNow(); }, true);
  }

  return { init, hide };
})();

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => window.Tips.init());
else window.Tips.init();
