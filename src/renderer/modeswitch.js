'use strict';
/*
 * 「阅读 / 文献库」视图切换。
 *
 * 两个视图各有一份切换控件（阅读器在工具栏首位，文献库在侧栏顶部），
 * 这里统一管三件事：
 *   1. 位置对齐：两处控件用同一套内边距，落在窗口同一个像素位置；
 *   2. 高亮块滑动：active 状态不是直接给按钮上色，而是一个跟着走的白色药丸
 *      （.mode-thumb），切模式时它滑过去；
 *   3. 即时响应：点一下就切，不等动画（早先先滑 200ms 再切，手感发木；
 *      全屏覆盖层做淡入淡出还会整页重绘、看着闪）。药丸只动 transform，
 *      代价可以忽略。
 */
window.ModeSwitch = (function () {
  const boxes = [];
  let mode = 'read';      // 高亮块当前指向的模式

  // 当前到底在哪个视图：直接看覆盖层的显隐，不另外存状态（不会和界面脱节）
  function currentView() {
    const lib = document.getElementById('library');
    return lib && !lib.hidden ? 'library' : 'read';
  }

  function init() {
    document.querySelectorAll('.mode-switch').forEach((box) => {
      if (box.__msReady) return;
      box.__msReady = true;
      const thumb = document.createElement('span');
      thumb.className = 'mode-thumb';
      box.appendChild(thumb);
      boxes.push({ box, thumb });
      box.addEventListener('click', (e) => {
        const tab = e.target.closest('.mode-tab');
        if (!tab || !box.contains(tab)) return;
        const next = tab.dataset.mode;
        if (!next || next === currentView()) return;
        apply(next);     // 立刻切，不等动画
        set(next);       // 高亮块在切过去之后滑到新位置
      });
    });
    // 初始位置按各控件自己的 active 类摆（HTML 里已经写好初始态）
    boxes.forEach((rec) => {
      const active = rec.box.querySelector('.mode-tab.active');
      if (!active) return;
      for (const tab of rec.box.querySelectorAll('.mode-tab')) {
        const on = tab === active;
        tab.classList.toggle('active', on);
        tab.setAttribute('aria-selected', on ? 'true' : 'false');
      }
      move(rec, true);
    });
    window.addEventListener('resize', () => boxes.forEach((b) => move(b, true)));
  }

  // 真正切视图：库界面开 / 关
  function apply(next) {
    if (!window.LibraryUI) return;
    if (next === 'library') window.LibraryUI.show();
    else window.LibraryUI.hide();
  }

  function set(next) {
    if (!next) return;
    mode = next;
    for (const rec of boxes) {
      for (const tab of rec.box.querySelectorAll('.mode-tab')) {
        const on = tab.dataset.mode === next;
        tab.classList.toggle('active', on);
        tab.setAttribute('aria-selected', on ? 'true' : 'false');
      }
      move(rec, false);
    }
  }

  // 按当前实际视图同步高亮块（库被别处开 / 关时用）
  function sync() {
    set(currentView());
  }

  // 把药丸挪到当前激活的那一格上（用实际像素算，两处控件尺寸不同也不会错位）
  function move(rec, instant) {
    const active = rec.box.querySelector('.mode-tab.active');
    if (!active) return;
    const br = rec.box.getBoundingClientRect();
    const tr = active.getBoundingClientRect();
    if (!br.width || !tr.width) return;
    if (instant) {
      rec.thumb.style.transition = 'none';
      rec.thumb.style.width = tr.width + 'px';
      rec.thumb.style.transform = 'translateX(' + (tr.left - br.left) + 'px)';
      // 强制回流后再恢复过渡，避免首次定位也带动画
      void rec.thumb.offsetWidth;
      rec.thumb.style.transition = '';
      return;
    }
    rec.thumb.style.width = tr.width + 'px';
    rec.thumb.style.transform = 'translateX(' + (tr.left - br.left) + 'px)';
  }

  return {
    init, set, sync,
    current: currentView,
  };
})();

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', window.ModeSwitch.init);
else window.ModeSwitch.init();
