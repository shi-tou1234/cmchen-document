'use strict';
/*
 * 内置使用指南（帮助中心）的渲染与交互。
 *
 * 设计原则：
 *  - 指南是「说明书」，不是「引导流程」：不遮界面、不强推、不记完成度，
 *    随时按 F1 打开，看完继续干活。
 *  - 文案在 src/help-content.js（纯数据），这里只管排版、搜索、跳转。
 *  - 「在界面定位」会把对应控件滚到视野里并闪一下：说明写在纸上，
 *    但用户真正要记住的是「那个按钮在哪」。
 *
 * 入口：
 *  - 工具栏问号按钮 / 文献库「帮助」/ 设置里的「使用指南…」
 *  - F1
 *  - 命令面板「使用指南」「快捷键速查」「常见问题排查」
 */
(function () {
  const G = window.HELP_GUIDE || { groups: [] };
  const LS_LAST = 'trove.help.last';

  const state = { open: false, current: '', query: '', results: [], idx: 0, inited: false };

  // 选择器简写：写 id 时不必带 #（本文件里的 $('help-x') 都指 id）
  const $ = (s) => document.querySelector(/^[#.\[]/.test(s) || s.indexOf(' ') >= 0 ? s : '#' + s);
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // 极轻量的行内标记：`代码` 与 **加粗**。文案里只用这两种，够用且不会误伤中文标点。
  function fmt(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  }

  // 展平后的主题表：顺序就是「上一节 / 下一节」的顺序
  const flat = [];
  const byId = {};
  const groupOf = {};
  for (const g of G.groups || []) {
    for (const t of g.topics || []) {
      const topic = Object.assign({}, t, { groupId: g.id, groupTitle: g.title });
      flat.push(topic);
      byId[topic.id] = topic;
      groupOf[topic.id] = g;
    }
  }

  function toast(msg) {
    if (window.App && typeof window.App.toast === 'function') { window.App.toast(msg); return; }
    const bar = document.getElementById('hint-bar');
    if (bar) { bar.hidden = false; }
  }

  /* ---------------- 搜索 ---------------- */

  function topicText(t) {
    const parts = [t.title, t.summary, t.where || ''];
    for (const s of t.steps || []) parts.push(typeof s === 'string' ? s : (s.t + ' ' + s.d));
    for (const k of t.keys || []) parts.push(k[0] + ' ' + k[1]);
    for (const x of t.tips || []) parts.push(x);
    for (const x of t.limits || []) parts.push(x);
    return parts.join(' ');
  }

  function score(q, t) {
    if (!q) return 1;
    const ql = q.toLowerCase();
    let sc = 0;
    const title = t.title.toLowerCase();
    const kw = (t.keywords || []).join(' ').toLowerCase();
    if (title.indexOf(ql) >= 0) sc += 120 - title.indexOf(ql);
    if (kw.indexOf(ql) >= 0) sc += 70;
    const sum = (t.summary || '').toLowerCase();
    if (sum.indexOf(ql) >= 0) sc += 40;
    const body = topicText(t).toLowerCase();
    if (body.indexOf(ql) >= 0) sc += 20;
    if (sc) return sc;
    // 子序列兜底：「导副」也能找到「导出标注副本」
    let si = 0, gap = 0;
    for (const ch of ql) {
      const at = body.indexOf(ch, si);
      if (at < 0) return 0;
      gap += at - si;
      si = at + 1;
    }
    return Math.max(1, 12 - gap * 0.05);
  }

  function runSearch() {
    const q = state.query.trim();
    if (!q) { state.results = []; state.idx = 0; return; }
    state.results = flat.map((t) => ({ t, s: score(q, t) })).filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s).map((x) => x.t);
    if (state.idx >= state.results.length) state.idx = 0;
  }

  /* ---------------- 渲染 ---------------- */

  function renderNav() {
    const nav = $('help-nav');
    if (!nav) return;
    const q = state.query.trim();
    if (q) {
      if (!state.results.length) {
        nav.innerHTML = '<div class="help-empty">没有匹配的说明。<br />换个词试试「导出」「标注」「索引」。</div>';
        return;
      }
      nav.innerHTML = '<div class="help-nav-note">' + state.results.length + ' 条结果</div>' +
        state.results.map((t, i) => (
          '<button type="button" class="help-nav-item' + (i === state.idx ? ' is-cursor' : '') +
            (t.id === state.current ? ' active' : '') + '" data-topic="' + t.id + '">' +
            '<span class="hni-title">' + esc(t.title) + '</span>' +
            '<span class="hni-group">' + esc(t.groupTitle) + '</span>' +
          '</button>'
        )).join('');
      return;
    }

    nav.innerHTML = (G.groups || []).map((g) => (
      '<div class="help-group">' +
        '<div class="help-group-title" title="' + esc(g.desc || '') + '">' + esc(g.title) + '</div>' +
        (g.topics || []).map((t) => (
          '<button type="button" class="help-nav-item' + (t.id === state.current ? ' active' : '') +
            '" data-topic="' + t.id + '">' + esc(t.title) + '</button>'
        )).join('') +
      '</div>'
    )).join('');
  }

  function renderArticle() {
    const box = $('help-article');
    if (!box) return;
    const t = byId[state.current];
    if (!t) { box.innerHTML = '<div class="help-empty">没有这一节。</div>'; return; }

    const where = t.where ? '<span class="help-where" title="在界面上的位置">' + esc(t.where) + '</span>' : '';
    const actions = [];
    if (t.ui && t.ui.length) {
      const el = document.querySelector(t.ui[0]);
      if (el) actions.push('<button type="button" class="help-act" data-locate="' + esc(t.ui[0]) + '">在界面定位</button>');
    }
    if (t.action) actions.push('<button type="button" class="help-act primary" data-run="' + esc(t.action.id) + '">' + esc(t.action.label || '打开') + '</button>');

    const steps = (t.steps || []).map((s, i) => {
      const title = typeof s === 'string' ? '' : s.t;
      const desc = typeof s === 'string' ? s : s.d;
      return '<li>' +
        '<span class="help-step-n">' + (i + 1) + '</span>' +
        '<div class="help-step-body">' +
          (title ? '<div class="help-step-t">' + fmt(title) + '</div>' : '') +
          '<div class="help-step-d">' + fmt(desc) + '</div>' +
        '</div></li>';
    }).join('');

    const keys = (t.keys || []).length
      ? '<div class="help-block"><div class="help-block-h">快捷键</div><div class="help-keys">' +
          t.keys.map((k) => '<div class="help-key-row"><kbd>' + esc(k[0]) + '</kbd><span>' + fmt(k[1]) + '</span></div>').join('') +
        '</div></div>'
      : '';

    const tips = (t.tips || []).length
      ? '<div class="help-block"><div class="help-block-h">补充说明</div><ul class="help-tips">' +
          t.tips.map((x) => '<li>' + fmt(x) + '</li>').join('') + '</ul></div>'
      : '';

    const limits = (t.limits || []).length
      ? '<div class="help-block help-limits"><div class="help-block-h">做不到什么</div><ul class="help-tips">' +
          t.limits.map((x) => '<li>' + fmt(x) + '</li>').join('') + '</ul></div>'
      : '';

    const see = (t.see || []).filter((id) => hasOwn(byId, id)).length
      ? '<div class="help-block"><div class="help-block-h">相关</div><div class="help-see">' +
          t.see.filter((id) => hasOwn(byId, id)).map((id) =>
            '<button type="button" class="help-see-btn" data-topic="' + id + '">' + esc(byId[id].title) + '</button>'
          ).join('') + '</div></div>'
      : '';

    box.innerHTML =
      '<div class="help-kicker">' + esc(t.groupTitle) + '</div>' +
      '<h2 class="help-title">' + esc(t.title) + '</h2>' +
      '<p class="help-summary">' + fmt(t.summary || '') + '</p>' +
      (where || actions.length ? '<div class="help-meta">' + where + actions.join('') + '</div>' : '') +
      '<ol class="help-steps">' + steps + '</ol>' +
      keys + tips + limits + see;
    box.scrollTop = 0;
  }

  function renderFoot() {
    const i = state.query.trim() ? -1 : flat.findIndex((t) => t.id === state.current);
    const p = $('help-progress');
    if (p) p.textContent = i < 0 ? '' : '第 ' + (i + 1) + ' / ' + flat.length + ' 节';
    const prev = $('help-prev'), next = $('help-next');
    if (prev) prev.disabled = !(i > 0);
    if (next) next.disabled = !(i >= 0 && i < flat.length - 1);
  }

  function renderAll() {
    renderNav();
    renderArticle();
    renderFoot();
  }

  /* ---------------- 打开 / 关闭 ---------------- */

  function openTopic(id) {
    if (!hasOwn(byId, id)) id = flat.length ? flat[0].id : '';
    state.current = id;
    state.query = '';
    state.results = [];
    state.idx = 0;
    const inp = $('help-search');
    if (inp) inp.value = '';
    renderAll();
    try { localStorage.setItem(LS_LAST, id); } catch (_) {}
    const nav = $('help-nav');
    const active = nav && nav.querySelector('.help-nav-item.active');
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
  }

  function open(id) {
    const box = $('help-modal');
    if (!box) return;
    state.open = true;
    box.hidden = false;
    let target = id;
    if (!target) {
      try { target = localStorage.getItem(LS_LAST) || ''; } catch (_) { target = ''; }
    }
    openTopic(target || (flat[0] && flat[0].id) || '');
    setTimeout(() => { const inp = $('help-search'); if (inp) inp.focus(); }, 30);
  }

  function close() {
    const box = $('help-modal');
    if (!box || !state.open) return;
    state.open = false;
    box.hidden = true;
  }

  function isOpen() { return state.open; }

  /* ---------------- 动作：从说明里直接把功能调出来 ---------------- */

  function ensureLibrary() {
    const lib = document.getElementById('library');
    if (lib && lib.hidden) {
      const b = document.getElementById('btn-library');
      if (b) b.click();
    }
  }

  function clickWhenReady(sel, delay) {
    ensureLibrary();
    setTimeout(() => {
      const el = document.querySelector(sel);
      if (el) el.click();
      else toast('当前版本没有这个入口，可能已挪到别处');
    }, delay == null ? 160 : delay);
  }

  const ACTIONS = {
    library: () => ensureLibrary(),
    settings: () => clickWhenReady('#lib-settings'),
    stats: () => clickWhenReady('#lib-stats'),
    recall: () => clickWhenReady('#lib-recall'),
    feeds: () => clickWhenReady('#lib-feeds'),
    adv: () => clickWhenReady('#lib-adv-btn'),
    import: () => clickWhenReady('#lib-import'),
    newNote: () => clickWhenReady('#lib-new-note'),
    cmd: () => { if (typeof window.openCmd === 'function') window.openCmd(); },
  };

  function runAction(id) {
    const fn = ACTIONS[id];
    if (!fn) { toast('这个入口暂时不可用'); return; }
    close();
    setTimeout(() => { try { fn(); } catch (e) { toast('打开失败：' + ((e && e.message) || e)); } }, 60);
  }

  // 把界面上的控件滚进视野并闪一下：说明里写了「在哪儿」，这里直接指给你看
  function locate(sel) {
    const el = document.querySelector(sel);
    if (!el) { toast('界面上暂时找不到这个控件（可能要先打开文档或文献库）'); return; }
    close();
    setTimeout(() => {
      const inLib = el.closest && el.closest('#library');
      const lib = document.getElementById('library');
      if (inLib && lib && lib.hidden) {
        const b = document.getElementById('btn-library');
        if (b) b.click();
      }
      setTimeout(() => {
        try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
        el.classList.remove('help-flash');
        void el.offsetWidth;
        el.classList.add('help-flash');
        setTimeout(() => el.classList.remove('help-flash'), 2000);
      }, 140);
    }, 40);
  }

  /* ---------------- 事件 ---------------- */

  function move(delta) {
    if (state.query.trim()) {
      if (!state.results.length) return;
      state.idx = (state.idx + delta + state.results.length) % state.results.length;
      renderNav();
      const cur = $('help-nav').querySelector('.help-nav-item.is-cursor');
      if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
      return;
    }
    const i = flat.findIndex((t) => t.id === state.current);
    const j = Math.max(0, Math.min(flat.length - 1, i + delta));
    if (j !== i) openTopic(flat[j].id);
  }

  function onKey(e) {
    if (!state.open) {
      if (e.key === 'F1') { e.preventDefault(); e.stopImmediatePropagation(); open(); }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopImmediatePropagation();
      close();
      return;
    }
    if (e.key === 'F1') {
      e.preventDefault(); e.stopImmediatePropagation();
      close();
      return;
    }
    const tag = (e.target && e.target.tagName) || '';
    const inField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    if (e.key === '/' && !inField) {
      e.preventDefault(); e.stopImmediatePropagation();
      const inp = $('help-search'); if (inp) { inp.focus(); inp.select(); }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      // 搜索框里的上下键用来在结果间移动；正文里用来翻节
      const isSearch = e.target && e.target.id === 'help-search';
      if (!inField || isSearch) {
        e.preventDefault(); e.stopImmediatePropagation();
        move(e.key === 'ArrowDown' ? 1 : -1);
      }
      return;
    }
    if (e.key === 'Enter' && e.target && e.target.id === 'help-search' && state.results.length) {
      e.preventDefault(); e.stopImmediatePropagation();
      openTopic(state.results[state.idx].id);
    }
  }

  function init() {
    if (state.inited) return;
    state.inited = true;

    const ver = document.getElementById('help-ver');
    if (ver) ver.textContent = 'v' + (G.version || '');
    // 版本号以应用为准（app.getVersion ← package.json）。数据在 src/help-content.js 里
    // 也有一个，但那只是离线渲染时的兜底：两处各写各的，版本号就会悄悄漂。
    if (window.pdfBridge && window.pdfBridge.appInfo) {
      Promise.resolve(window.pdfBridge.appInfo()).then((r) => {
        if (ver && r && r.version) ver.textContent = 'v' + r.version;
      }).catch(() => {});
    }

    const box = $('help-modal');
    if (box) box.addEventListener('click', (e) => { if (e.target === box) close(); });

    const bindOpen = (id) => {
      const b = document.getElementById(id);
      if (b) b.addEventListener('click', (e) => { e.preventDefault(); open(); });
    };
    bindOpen('btn-help');
    bindOpen('lib-help');
    bindOpen('set-help');
    bindOpen('empty-help-btn');
    bindOpen('hint-help');

    const x = $('help-x'); if (x) x.addEventListener('click', close);
    const prev = $('help-prev'); if (prev) prev.addEventListener('click', () => move(-1));
    const next = $('help-next'); if (next) next.addEventListener('click', () => move(1));

    const inp = $('help-search');
    if (inp) {
      inp.addEventListener('input', () => {
        state.query = inp.value;
        state.idx = 0;
        runSearch();
        renderNav();
        const boxArt = $('help-article');
        if (!state.query.trim()) renderArticle();
        else if (boxArt) {
          boxArt.innerHTML = '<div class="help-kicker">搜索</div><h2 class="help-title">「' + esc(state.query.trim()) + '」</h2>' +
            (state.results.length
              ? '<p class="help-summary">' + state.results.length + ' 条相关说明，点左边或按 ↑↓ 选择、回车打开。</p>'
              : '<p class="help-summary">没有匹配。试试「导出」「标注」「索引」「快捷键」。</p>');
        }
        renderFoot();
      });
      inp.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    }

    const nav = $('help-nav');
    if (nav) nav.addEventListener('click', (e) => {
      const b = e.target.closest('[data-topic]');
      if (b) openTopic(b.dataset.topic);
    });

    const art = $('help-article');
    if (art) art.addEventListener('click', (e) => {
      const see = e.target.closest('[data-topic]');
      if (see) { openTopic(see.dataset.topic); return; }
      const loc = e.target.closest('[data-locate]');
      if (loc) { locate(loc.dataset.locate); return; }
      const run = e.target.closest('[data-run]');
      if (run) runAction(run.dataset.run);
    });

    document.addEventListener('keydown', onKey, true);
  }

  window.Help = {
    init, open, openTopic, close, isOpen,
    topics: flat,
    has: (id) => hasOwn(byId, id),
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
