'use strict';
/*
 * 内置使用指南（帮助中心）的渲染与交互 —— v1.6.3「先给任务，再给说明书」。
 *
 * 设计原则：
 *  - 首页回答「我现在要做什么」：6 张任务卡 + 搜索，不把 78 节目录铺在脸上。
 *  - 文章默认只给：一句用途、最多 3 步、一个直达操作；
 *    快捷键 / 补充说明 / 较少遇到的限制按需展开。
 *  - 删除、恢复覆盖、保存失败、备份范围这类关键警示**不折叠**，永远留在动作旁。
 *  - 「在界面定位」要真的让用户看见控件：先切到正确页面、展开所在的分组菜单，
 *    再滚动、闪烁并聚焦。目标存在 ≠ 用户能看到。
 *  - 完整手册仍保留在「全部功能」，目录按组折叠，节数计数也只放在那里。
 *
 * 文案在 src/help-content.js（纯数据），这里只管排版、搜索、跳转。
 */
(function () {
  const G = window.HELP_GUIDE || { groups: [] };
  const LS_LAST = 'trove.help.last';

  const state = {
    open: false, current: '', query: '', results: [], idx: 0, inited: false,
    home: true, browse: false, openGroup: '',
    openGroups: null,  // 「全部功能」里真正展开的组；null = 还没渲染过，按默认规则
    notice: null,   // 定位没做成时的解释：说清先做什么，而不是只丢一句「找不到」
    opener: null,   // 打开指南的那个元素：关闭后把焦点还回去
  };

  // 首页的六个常见任务：卡片打开对应的短文章，⌖ 直接把入口指给用户看
  // 标题都写成「能做完的一件事」，和文章标题一致；抽象的功能名留给「全部功能」。
  const TASKS = [
    { id: 'open-file', t: '打开电脑里的 PDF', d: '从本地选一份文档，开始阅读', ui: '#btn-open' },
    { id: 'anno-select', t: '给文字加高亮', d: '选中文字，标出重点', ui: '#sel-bar' },
    { id: 'lib-add', t: '把当前文档存进文献库', d: '以后还能找到它、接着读', ui: '#btn-to-lib' },
    { id: 'read-views', t: '两页并排阅读', d: '换成双页对开，或单页翻页', ui: '#btn-spread' },
    { id: 'note-editor', t: '写一条笔记', d: '新建、输入、保存', ui: '#lib-new-note' },
    { id: 'anno-export', t: '导出带标注 PDF', d: '另存一份带标注的副本', ui: '#tb-output-btn' },
  ];

  // 这些限制必须留在正文，不能为了「简洁」折起来
  const CRITICAL = /删除|恢复|覆盖|保存失败|备份|不含原文档|清空|永久|丢失|损坏|未保存|不联网/;

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
    const parts = [t.title, t.summary, t.where || '', (t.keywords || []).join(' ')];
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

  /* ---------------- 首页 ---------------- */

  // 定位没做成时的解释块。首页 / 全部功能 / 文章页共用同一份渲染：
  // 之前只有文章页会画它，于是「状态记下了、用户看不到」。
  function noticeBox() {
    if (!state.notice) return '';
    const n = state.notice;
    return '<div class="help-notice" role="status"><b>这一步现在做不了。</b>' + fmt(n.msg) +
      (n.point
        ? '<button type="button" class="help-act" data-locate="' + esc(n.point) + '">先去完成它</button>'
        : '') +
      '</div>';
  }

  const MQ_NARROW = '(max-width: 860px)';
  function isNarrowLayout() {
    return !!(window.matchMedia && window.matchMedia(MQ_NARROW).matches);
  }

  function taskCards() {
    return TASKS.filter((t) => hasOwn(byId, t.id)).map((t) => (
      '<div class="help-task-card">' +
        '<button type="button" class="help-task" data-topic="' + t.id + '">' +
          '<span class="ht-t">' + esc(t.t) + '</span>' +
          '<span class="ht-d">' + esc(t.d) + '</span>' +
        '</button>' +
        '<button type="button" class="help-task-go" data-locate="' + esc(t.ui) + '" title="在界面定位：' + esc(t.t) + '">⌖</button>' +
      '</div>'
    )).join('');
  }

  function renderHome() {
    const nav = $('help-nav');
    const box = $('help-article');
    let lastId = '';
    try { lastId = localStorage.getItem(LS_LAST) || ''; } catch (_) {}
    const last = byId[lastId];

    if (nav) nav.innerHTML =
      '<div class="help-nav-note">常见任务</div>' +
      '<div class="help-nav-tip">右边选一张卡，只看这件事要用的那几步。</div>' +
      '<div class="help-nav-note help-nav-gap">完整手册</div>' +
      '<button type="button" class="help-nav-item" data-home-link="browse">全部功能（' + flat.length + ' 节）</button>' +
      '<button type="button" class="help-nav-item" data-home-link="data">数据与备份</button>' +
      '<button type="button" class="help-nav-item" data-home-link="shortcuts">快捷键</button>' +
      (last ? '<div class="help-nav-note help-nav-gap">接着上次</div>' +
        '<button type="button" class="help-nav-item" data-topic="' + last.id + '">' + esc(last.title) + '</button>' : '');

    if (box) {
      box.innerHTML = noticeBox() +
        '<div class="help-home">' +
          '<div class="help-kicker">使用指南</div>' +
          '<h2 class="help-title">你想完成什么？</h2>' +
          '<p class="help-summary">先选一件要做的事，只给你这一步要用的说明。完整手册在「全部功能」里，随时可以翻。</p>' +
          '<div class="help-task-grid">' + taskCards() + '</div>' +
          '<div class="help-home-links">' +
            '<button type="button" class="help-act" data-home-link="browse">全部功能</button>' +
            '<button type="button" class="help-act" data-home-link="data">数据与备份</button>' +
            '<button type="button" class="help-act" data-home-link="shortcuts">快捷键</button>' +
            '<span class="help-home-hint">搜功能、按钮名或快捷键：用上面的搜索框，或按 <kbd>/</kbd></span>' +
          '</div>' +
          '<div class="help-home-warn">备份不包含原文档；恢复会覆盖当前库（恢复前会自动留一份快照）。标注自动保存，失败时状态栏会一直提示并可重试。</div>' +
        '</div>';
      box.scrollTop = 0;
    }
  }

  /* ---------------- 全部功能（按组折叠） ---------------- */

  // 目录里哪几组是展开的：以用户此刻真实展开的集合为准。
  // 之前只记「当前文章所在的组」，手动多展开一组，缩窗重排就只剩默认那组。
  function groupIsOpen(g, i) {
    if (state.openGroups) return state.openGroups.has(g.id);
    return g.id === state.openGroup || (!state.openGroup && i === 0);
  }

  function rememberOpenGroups(nav) {
    // 首次渲染把默认展开的组记成集合；之后就只跟着用户的展开 / 收起走
    if (!state.openGroups) {
      const set = new Set();
      for (const d of nav.querySelectorAll('details.help-fold[open]')) {
        if (d.dataset.group) set.add(d.dataset.group);
      }
      state.openGroups = set;
    }
    if (nav._foldBound) return;
    nav._foldBound = true;
    // toggle 不冒泡，用捕获阶段监听；只记状态，不碰 DOM
    nav.addEventListener('toggle', (e) => {
      const d = e.target;
      if (!d || !d.classList || !d.classList.contains('help-fold')) return;
      const id = d.dataset.group;
      if (!id) return;
      if (!state.openGroups) state.openGroups = new Set();
      if (d.open) state.openGroups.add(id); else state.openGroups.delete(id);
    }, true);
  }

  function renderBrowse(group) {
    if (group) {
      state.openGroup = group;
      // 从某一节回到「全部功能」时，让它所在的那组保持展开
      if (state.openGroups) state.openGroups.add(group);
    }
    const nav = $('help-nav');
    if (nav) nav.innerHTML =
      '<button type="button" class="help-back" data-home-link="home">← 常见任务</button>' +
      '<div class="help-nav-note help-nav-gap">按场景分组 · 共 ' + flat.length + ' 节</div>' +
      (G.groups || []).map((g, i) => (
        '<details class="help-fold" data-group="' + esc(g.id) + '"' + (groupIsOpen(g, i) ? ' open' : '') + '>' +
          '<summary>' + esc(g.title) + '<span class="help-fold-n">' + (g.topics || []).length + '</span></summary>' +
          '<div class="help-fold-body">' + (g.topics || []).map((t) => (
            '<button type="button" class="help-nav-item" data-topic="' + t.id + '">' + esc(t.title) + '</button>'
          )).join('') + '</div>' +
        '</details>'
      )).join('');
    if (nav) rememberOpenGroups(nav);
    const box = $('help-article');
    if (box) {
      // 窄窗口左侧目录整条收起（CSS ≤860px），正文里必须能自己走一遍全部主题，
      // 否则「全部功能」会变成一页只有说明、没有入口的死路。
      const narrow = isNarrowLayout();
      const list = narrow
        ? '<div class="help-browse-all">' + (G.groups || []).map((g) => (
            '<div class="help-browse-g"><div class="help-browse-h">' + esc(g.title) +
              '<span>' + (g.topics || []).length + '</span></div>' +
              (g.topics || []).map((t) => (
                '<button type="button" class="help-nav-item" data-topic="' + t.id + '">' + esc(t.title) + '</button>'
              )).join('') +
            '</div>'
          )).join('') + '</div>'
        : '';
      box.innerHTML = noticeBox() +
        '<div class="help-kicker">全部功能</div>' +
        '<h2 class="help-title">完整手册</h2>' +
        '<p class="help-summary">按场景分成 ' + (G.groups || []).length + ' 组、' + flat.length + ' 节。' +
          (narrow ? '下面按组列出全部主题，点一节就看一节。' : '左边点开一组，再看其中一节；日常任务建议从「常见任务」进去，不用通读。') + '</p>' +
        list +
        '<div class="help-block"><div class="help-block-h">关键提醒（不折叠）</div>' +
          '<ul class="help-tips">' +
            '<li>备份只含元数据、收藏集与标注，**不含原文档**；恢复会覆盖当前库，执行前会自动留一份快照。</li>' +
            '<li>条目详情里改过的字段要按「保存」；切换分组不会丢未保存的值，但离开前请确认保存。</li>' +
            '<li>标注是自动保存的：状态栏显示「正在保存 / 已保存 / 保存失败 · 重试」，失败时点一下重试。</li>' +
          '</ul></div>' +
        '<div class="help-block"><div class="help-block-h">找不到的东西</div>' +
          '<p class="help-summary">按 <kbd>Ctrl+K</kbd> 打开命令面板搜功能名；帮助顶部的搜索会同时搜标题、按钮上的字、界面位置和快捷键。</p></div>';
      box.scrollTop = 0;
    }
  }

  /* ---------------- 导航与文章 ---------------- */

  function renderNav() {
    const nav = $('help-nav');
    if (!nav) return;
    const q = state.query.trim();
    if (q) {
      if (!state.results.length) {
        nav.innerHTML = '<div class="help-empty">没有匹配的说明。<br />换个词试试「导出」「标注」「索引」。</div>';
        return;
      }
      nav.innerHTML = '<button type="button" class="help-back" data-home-link="home">← 常见任务</button>' +
        '<div class="help-nav-note">' + state.results.length + ' 条结果</div>' +
        state.results.map((t, i) => (
          '<div class="help-nav-item help-result' + (i === state.idx ? ' is-cursor' : '') +
            (t.id === state.current ? ' active' : '') + '" data-topic="' + t.id + '">' +
            '<span class="hni-title">' + esc(t.title) + '</span>' +
            '<span class="hni-group">' + esc(t.groupTitle) + '</span>' +
            (t.ui && t.ui.length ? '<button type="button" class="hni-locate" data-locate="' + esc(t.ui[0]) + '" title="在界面定位">⌖</button>' : '') +
          '</div>'
        )).join('');
      return;
    }
    if (state.home) { renderHome(); return; }
    if (state.browse) { renderBrowse(); return; }
    const g = groupOf[state.current] || (G.groups || [])[0];
    if (!g) return;
    nav.innerHTML =
      '<button type="button" class="help-back" data-home-link="home">← 常见任务</button>' +
      '<button type="button" class="help-back" data-home-link="browse">全部功能</button>' +
      '<div class="help-nav-note help-nav-gap">' + esc(g.title) + '</div>' +
      (g.topics || []).map((t) => (
        '<button type="button" class="help-nav-item' + (t.id === state.current ? ' active' : '') +
          '" data-topic="' + t.id + '">' + esc(t.title) + '</button>'
      )).join('');
  }

  function stepHtml(s, i) {
    const title = typeof s === 'string' ? '' : s.t;
    const desc = typeof s === 'string' ? s : s.d;
    return '<li>' +
      '<span class="help-step-n">' + (i + 1) + '</span>' +
      '<div class="help-step-body">' +
        (title ? '<div class="help-step-t">' + fmt(title) + '</div>' : '') +
        '<div class="help-step-d">' + fmt(desc) + '</div>' +
      '</div></li>';
  }

  function renderArticle() {
    const box = $('help-article');
    if (!box) return;
    if (state.home) { renderHome(); return; }
    if (state.browse) { renderBrowse(); return; }
    const t = byId[state.current];
    if (!t) { box.innerHTML = '<div class="help-empty">没有这一节。</div>'; return; }

    const where = t.where ? '<span class="help-where" title="在界面上的位置">' + esc(t.where) + '</span>' : '';
    const actions = [];
    if (t.ui && t.ui.length) {
      const el = document.querySelector(t.ui[0]);
      if (el) actions.push('<button type="button" class="help-act" data-locate="' + esc(t.ui[0]) + '">在界面定位</button>');
    }
    if (t.action) actions.push('<button type="button" class="help-act primary" data-run="' + esc(t.action.id) + '">' + esc(t.action.label || '打开') + '</button>');

    // 必要步骤全部展开。第 4 步往往就是「保存」或「确认」，折起来等于把任务切断；
    // 需要折叠的只有替代做法、原理与进阶选项（在下面的 extras 里）。
    const steps = t.steps || [];
    const allSteps = steps.map(stepHtml).join('');
    const needHtml = t.need
      ? '<div class="help-need"><span class="help-need-h">适用</span>' + fmt(t.need) + '</div>'
      : '';
    const doneHtml = t.done
      ? '<div class="help-done"><span class="help-done-h">完成后</span>' + fmt(t.done) + '</div>'
      : '';
    const noticeHtml = noticeBox();

    // 关键警示始终显示；其余「快捷键 / 补充说明 / 较少遇到的限制 / 相关」按需展开
    const critical = (t.limits || []).filter((x) => CRITICAL.test(x));
    const softLimits = (t.limits || []).filter((x) => !CRITICAL.test(x));
    const warn = critical.length
      ? '<div class="help-block help-limits"><div class="help-block-h">关键提醒</div><ul class="help-tips">' +
          critical.map((x) => '<li>' + fmt(x) + '</li>').join('') + '</ul></div>'
      : '';

    const extras = [];
    if ((t.keys || []).length) extras.push('<div class="help-block"><div class="help-block-h">快捷键</div><div class="help-keys">' +
      t.keys.map((k) => '<div class="help-key-row"><kbd>' + esc(k[0]) + '</kbd><span>' + fmt(k[1]) + '</span></div>').join('') +
      '</div></div>');
    if ((t.tips || []).length) extras.push('<div class="help-block"><div class="help-block-h">补充说明</div><ul class="help-tips">' +
      t.tips.map((x) => '<li>' + fmt(x) + '</li>').join('') + '</ul></div>');
    if (softLimits.length) extras.push('<div class="help-block help-limits"><div class="help-block-h">做不到什么</div><ul class="help-tips">' +
      softLimits.map((x) => '<li>' + fmt(x) + '</li>').join('') + '</ul></div>');
    const see = (t.see || []).filter((id) => hasOwn(byId, id));
    if (see.length) extras.push('<div class="help-block"><div class="help-block-h">相关</div><div class="help-see">' +
      see.map((id) => '<button type="button" class="help-see-btn" data-topic="' + id + '">' + esc(byId[id].title) + '</button>').join('') +
      '</div></div>');
    const more = extras.length
      ? '<details class="help-more"><summary>快捷键、补充说明与相关主题</summary>' + extras.join('') + '</details>'
      : '';

    box.innerHTML =
      '<div class="help-crumbs"><button type="button" class="help-back" data-home-link="home">常见任务</button>' +
        '<span>/</span><button type="button" class="help-back" data-home-link="browse">全部功能</button>' +
        '<span>/</span><span>' + esc(t.groupTitle) + '</span></div>' +
      '<div class="help-kicker">' + esc(t.groupTitle) + '</div>' +
      '<h2 class="help-title">' + esc(t.title) + '</h2>' +
      '<p class="help-summary">' + fmt(t.summary || '') + '</p>' +
      (where || actions.length ? '<div class="help-meta">' + where + actions.join('') + '</div>' : '') +
      noticeHtml + needHtml +
      '<ol class="help-steps">' + allSteps + '</ol>' +
      doneHtml + warn + more;
    box.scrollTop = 0;
  }

  function renderFoot() {
    const i = flat.findIndex((t) => t.id === state.current);
    const p = $('help-progress');
    // 「第 1 / 78 节」只属于完整手册，不让日常查帮助变成阅读任务
    if (p) p.textContent = state.browse ? ('完整手册 · 共 ' + flat.length + ' 节') : '';
    const prev = $('help-prev'), next = $('help-next');
    const inArticle = !state.home && !state.browse && !state.query.trim();
    if (prev) prev.disabled = !inArticle || !(i > 0);
    if (next) next.disabled = !inArticle || !(i >= 0 && i < flat.length - 1);
  }

  function renderAll() {
    renderNav();
    renderArticle();
    renderFoot();
  }

  // 跨 860px 断点时，左侧目录整条收起 / 展开，正文里的「全部主题」也要跟着换。
  // 之前只在渲染那一瞬间判断一次，宽窗打开「全部功能」再缩窄，就会看到正文让你
  // 点左边、左边却已经不存在。这里监听断点变化，保留当前场景与滚动位置。
  function relayout() {
    if (!state.open) return;
    // 搜索中：结果正文由输入框那边维护，重排只刷新目录，别把结果页换回上一篇文章
    if (state.query.trim()) { renderNav(); renderFoot(); return; }
    const box = $('help-article');
    const top = box ? box.scrollTop : 0;
    if (state.home) renderHome();
    else if (state.browse) renderBrowse();
    else if (state.current) { renderNav(); renderArticle(); }
    renderFoot();
    if (box) box.scrollTop = top;
  }

  /* ---------------- 打开 / 关闭 ---------------- */

  function goHome() {
    state.home = true;
    state.notice = null;
    state.browse = false;
    state.current = '';
    state.query = '';
    state.results = [];
    state.idx = 0;
    const inp = $('help-search');
    if (inp) inp.value = '';
    renderAll();
  }

  function openBrowse(group) {
    state.home = false;
    state.browse = true;
    state.current = '';
    state.query = '';
    state.results = [];
    state.idx = 0;
    const inp = $('help-search');
    if (inp) inp.value = '';
    renderBrowse(group);
    renderFoot();
  }

  function openTopic(id) {
    if (!hasOwn(byId, id)) id = flat.length ? flat[0].id : '';
    state.current = id;
    state.notice = null;
    state.home = false;
    state.browse = false;
    state.query = '';
    state.results = [];
    state.idx = 0;
    state.openGroup = (groupOf[id] || {}).id || '';
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
    // 记住是谁打开的：Esc / ✕ 关掉后焦点要回到那个按钮，键盘用户才不用从头 Tab 一遍。
    // 从命令面板进来时焦点在面板里，面板马上会关，记它没有意义（会把焦点还给隐藏输入框）。
    if (!state.open) {
      const op = document.activeElement;
      state.opener = op && op.closest && op.closest('#cmd-modal') ? null : op;
    }
    state.open = true;
    box.hidden = false;
    if (id) openTopic(id);
    else goHome();
    setTimeout(() => { const inp = $('help-search'); if (inp) inp.focus(); }, 30);
  }

  function close() {
    const box = $('help-modal');
    if (!box || !state.open) return;
    state.open = false;
    box.hidden = true;
    const back = state.opener;
    state.opener = null;
    if (back && back.isConnected && typeof back.focus === 'function') {
      try { back.focus({ preventScroll: true }); } catch (_) {}
    }
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
      if (!el) { toast('当前版本没有这个入口，可能已挪到别处'); return; }
      if (window.GroupMenus) GroupMenus.reveal(el);
      el.click();
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

  // 目标存在 ≠ 现在能用。选区浮条、笔记工具栏、文档相关按钮都有前置状态：
  // 直接关掉帮助去闪一个隐藏控件，用户只会看到「闪了一下，什么也没有」。
  function hasDocOpen() {
    return !!(window.App && App.state && (App.state.pdfDoc || App.state.mode === 'rich'));
  }

  function selectionAlive() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
    const viewer = document.getElementById('viewer');
    return !!(viewer && viewer.contains(sel.getRangeAt(0).commonAncestorContainer));
  }

  function noteEditorOpen() {
    const nv = document.getElementById('note-view');
    if (!nv) return false;
    return !nv.hidden && nv.getClientRects().length > 0;
  }

  // 有些目标是「选了工具才出现的浮层」：直接闪它只会闪一个隐藏元素。
  // 这里换成真正的入口，并说明下一步 —— 定位的验收标准是「用户能接着做」，
  // 不是「DOM 里有这个节点」。
  const LOCATE_ALIAS = {
    '#smart-hint': {
      target: '#notetools [data-tool="smart"]',
      activate: () => { if (window.Anno) Anno.setTool('smart'); },
      next: '已切到一笔成型：在页面上随手画，抬手就会自动识别。',
    },
    '#text-editor': {
      target: '#notetools [data-tool="text"]',
      activate: () => { if (window.Anno) Anno.setTool('text'); },
      next: '已切到文字工具：在页面上点一下，就能在那里写字。',
    },
  };

  function precondition(sel) {
    const el = document.querySelector(sel);
    if (!el) {
      return {
        ok: false,
        msg: '现在界面上没有这个控件。它要先打开一份文档或一条笔记才会出现。',
        point: hasDocOpen() ? '' : '#btn-open',
      };
    }
    if (el.closest('#sel-bar, #comment-modal') && !selectionAlive()) {
      return hasDocOpen()
        ? { ok: false, msg: '先在这份文档里拖选一段文字，选区旁的浮条才会出现。', point: '' }
        : { ok: false, msg: '先打开一份能选中文字的 PDF，这一步才有对象可标。', point: '#btn-open' };
    }
    if (el.closest('#nv-toolbar') && !noteEditorOpen()) {
      return { ok: false, msg: '笔记的格式工具栏只在打开一条笔记之后出现。', point: '#lib-new-note' };
    }
    if (!hasDocOpen() && el.closest('#notetools, #viewer, #ref-pane')) {
      return { ok: false, msg: '这个按钮要打开一份文档之后才可用。', point: '#btn-open' };
    }
    // 顶栏里除「打开 / 视图切换 / 帮助」外的按钮（翻页、缩放、页面布局、导出、入库）
    // 都依赖已打开的文档：空窗口里点过去只能看到一个点不动的按钮。
    if (!hasDocOpen() && el.closest('#toolbar') && !el.closest('.mode-switch') &&
        ['btn-open', 'btn-library', 'btn-help'].indexOf(el.id) < 0) {
      return { ok: false, msg: '这个按钮要打开一份文档之后才可用。', point: '#btn-open' };
    }
    return { ok: true, el };
  }

  // 把界面上的控件滚进视野并闪一下：先切到正确页面、展开它藏身的菜单，再显示并聚焦。
  function locate(sel) {
    const alias = LOCATE_ALIAS[sel];
    const targetSel = alias ? alias.target : sel;
    const pre = precondition(targetSel);
    if (!pre.ok) {
      // 留在教程里解释，不关窗口：用户还想看下一步，也不想回来重新搜一遍
      state.notice = { msg: pre.msg, point: pre.point || '' };
      renderArticle();
      toast(pre.msg);
      return;
    }
    state.notice = null;
    const el = pre.el;
    close();
    setTimeout(() => {
      const inLib = !!(el.closest && el.closest('#library'));
      const lib = document.getElementById('library');
      // 直接切覆盖层，不靠模拟点页签：视图切换有淡入淡出，点按钮可能被
      // 正在进行的反向动画盖掉，出现「帮助关了、按钮却还是看不见」。
      const showLib = () => {
        if (!lib || !lib.hidden) return;
        if (window.LibraryUI && typeof LibraryUI.show === 'function') LibraryUI.show();
        else { const b = document.getElementById('btn-library'); if (b) b.click(); }
      };
      const hideLib = () => {
        if (!lib || lib.hidden) return;
        if (window.LibraryUI && typeof LibraryUI.hide === 'function') LibraryUI.hide();
        else { const b = document.getElementById('lib-back'); if (b) b.click(); }
      };
      if (inLib) showLib(); else hideLib();
      // 需要先切工具的（印章 / 文字）：先切过去，浮层才会真的出现
      if (alias && typeof alias.activate === 'function') {
        try { alias.activate(); } catch (_) {}
      }

      setTimeout(() => {
        // 覆盖层可能被别的延时收起过：落点前再确认一次它在正确页面
        if (inLib) showLib();
        // 展开所有收起的祖先：分组下拉、详情 / 设置分组页都算
        if (window.GroupMenus) GroupMenus.reveal(el);
        try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
        try { el.focus({ preventScroll: true }); } catch (_) {}
        // 先闪：目标对不对在这一步已经确定，动画不该被后面的可见性复核拖住
        el.classList.remove('help-flash');
        void el.offsetWidth;
        el.classList.add('help-flash');
        setTimeout(() => el.classList.remove('help-flash'), 2000);
        if (alias && alias.next) toast(alias.next);

        // 目标必须真的可见：存在 ≠ 能用。切页面 / 展开菜单带有动画，
        // 这里给两拍（约 440ms）缓冲；确实还藏着就把用户送回指南并说明，
        // 而不是让界面看起来「闪了一下、什么也没有」。
        let tries = 0;
        const verify = () => {
          if (!el.hidden && el.getClientRects().length > 0) return;
          if (tries++ < 2) { setTimeout(verify, 220); return; }
          const note = { msg: '这个控件现在还是看不到，先把当前页面和工具准备好再来。', point: '' };
          open(state.current || null);
          state.notice = note;
          renderArticle();
          renderFoot();
          toast('这个入口暂时看不到，指南里已说明');
        };
        verify();
      }, 220);
    }, 40);
  }

  /* ---------------- 事件 ---------------- */

  function homeLink(kind) {
    if (kind === 'home') goHome();
    else if (kind === 'browse') openBrowse();
    else if (kind === 'data') openBrowse('data');
    else if (kind === 'shortcuts') openTopic('shortcuts');
  }

  function move(delta) {
    if (state.query.trim()) {
      if (!state.results.length) return;
      state.idx = (state.idx + delta + state.results.length) % state.results.length;
      renderNav();
      const cur = $('help-nav').querySelector('.help-result.is-cursor');
      if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (state.home || state.browse) return;
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
      const inSearch = e.target && e.target.id === 'help-search';
      const inNav = !!(e.target && e.target.closest && e.target.closest('#help-nav'));
      // 翻节改成 Alt+↑/↓：正文里 ↑↓ 留给滚动。读者正按方向键读文章，
      // 突然被切成下一节并不是「快捷」，是抢了阅读的手感。
      if (e.altKey) {
        e.preventDefault(); e.stopImmediatePropagation();
        move(e.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (inSearch || inNav) {
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

    // 帮助面板本身随窗口缩放跨 860px：目录收起 / 展开时把正文一起换过来
    let lastNarrow = isNarrowLayout();
    if (window.matchMedia) {
      const mq = window.matchMedia(MQ_NARROW);
      const onChange = () => { lastNarrow = isNarrowLayout(); relayout(); };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }
    // 窗口还在动画 / 被系统缩放时，matchMedia 的 change 偶尔会漏一拍：
    // 停手 120ms 后再对一次，只有「窄 / 宽」真的翻了面才重排，不跟着每个像素抖。
    window.addEventListener('resize', () => {
      clearTimeout(state._rzTimer);
      state._rzTimer = setTimeout(() => {
        const n = isNarrowLayout();
        if (n === lastNarrow) return;
        lastNarrow = n;
        relayout();
      }, 120);
    });

    const bindOpen = (id) => {
      const b = document.getElementById(id);
      if (b) b.addEventListener('click', (e) => { e.preventDefault(); open(); });
    };
    bindOpen('btn-help');
    bindOpen('lib-help');
    bindOpen('set-help');
    bindOpen('hint-help');
    // 空白页写的是「三步开始」，点了就直接给那一节，不要又丢回首页让人再找一次
    const emptyHelp = document.getElementById('empty-help-btn');
    if (emptyHelp) emptyHelp.addEventListener('click', (e) => { e.preventDefault(); open('quickstart'); });

    const x = $('help-x'); if (x) x.addEventListener('click', close);
    const prev = $('help-prev'); if (prev) prev.addEventListener('click', () => move(-1));
    const next = $('help-next'); if (next) next.addEventListener('click', () => move(1));

    const inp = $('help-search');
    if (inp) {
      inp.addEventListener('input', () => {
        state.query = inp.value;
        state.idx = 0;
        runSearch();
        if (state.query.trim()) { state.home = false; state.browse = false; }
        renderNav();
        const boxArt = $('help-article');
        if (!state.query.trim()) { goHome(); return; }
        if (boxArt) {
          const hits = state.results.slice(0, 8);
          boxArt.innerHTML = '<div class="help-kicker">搜索</div><h2 class="help-title">「' + esc(state.query.trim()) + '」</h2>' +
            (hits.length
              ? '<p class="help-summary">' + state.results.length + ' 条相关说明。点「看说明」读做法，或点 ⌖ 直接指到界面上的入口。</p>' +
                '<div class="help-results">' + hits.map((t) => (
                  '<div class="help-result-row"><div><b>' + esc(t.title) + '</b><span>' + esc(t.groupTitle) + '</span>' +
                  '<p>' + esc(t.summary || '') + '</p></div><div class="help-result-acts">' +
                  '<button type="button" class="help-act" data-topic="' + t.id + '">看说明</button>' +
                  (t.ui && t.ui.length ? '<button type="button" class="help-act" data-locate="' + esc(t.ui[0]) + '">⌖ 定位</button>' : '') +
                  '</div></div>'
                )).join('') + '</div>'
              : '<p class="help-summary">没有匹配。试试「导出」「标注」「索引」「快捷键」。</p>');
        }
        renderFoot();
      });
      inp.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    }

    const nav = $('help-nav');
    if (nav) nav.addEventListener('click', (e) => {
      const loc = e.target.closest('[data-locate]');
      if (loc) { locate(loc.dataset.locate); return; }
      const link = e.target.closest('[data-home-link]');
      if (link) { homeLink(link.dataset.homeLink); return; }
      const b = e.target.closest('[data-topic]');
      if (b) openTopic(b.dataset.topic);
    });

    const art = $('help-article');
    if (art) art.addEventListener('click', (e) => {
      const link = e.target.closest('[data-home-link]');
      if (link) { homeLink(link.dataset.homeLink); return; }
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
    init, open, openTopic, close, isOpen, locate,
    goHome, openBrowse,
    topics: flat,
    tasks: TASKS,
    has: (id) => hasOwn(byId, id),
    get state() { return state; },
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
