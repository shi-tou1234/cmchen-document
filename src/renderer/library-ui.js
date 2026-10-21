'use strict';
/*
 * 文献库覆盖层 UI（v12：全文检索 / 智能收藏集 / 批量编辑 / 查重 / 设置 / 备份）。
 * 与阅读器解耦：
 *  - 打开条目靠 window.__libOpen(payload) 钩子（renderer.js 注入，内部即 loadPdf）。
 *  - Electron 不支持 prompt()，新建集合 / 加标签 / 改名一律内联 DOM 控件。
 *  - 所有“移除”都是软删除；清空回收站也只删索引，绝不删磁盘 PDF。
 */
window.LibraryUI = (function () {
  const L = () => (window.pdfBridge && window.pdfBridge.lib) || null;
  const $ = (id) => document.getElementById(id);
  let el = {};
  let state = {
    collections: [], searches: [], items: [], itemTypes: [], tagColors: {},
    scope: { type: 'all' }, query: '', sort: 'added', sortDir: '',
    selectedKey: null, detailTags: [], flash: '',
    selectedKeys: new Set(),
    tagFilter: new Set(),   // v14：标签选择器（多选，命中任一即可）
    citeStyle: 'gbt7714',   // v14：引用样式
    citekeys: new Map(),    // v27：条目 key → 确定性 citekey
    secOpen: { searches: false, tags: false },  // v19：进阶分区默认折叠（新手少看两眼）
    ft: { query: '', results: [], stats: null, loading: false, error: '' },
    settings: { theme: 'light', defaultSort: 'added', autoIndex: true, dataDir: '' },
    dupGroups: [],
    sortTouched: false,
  };
  let inited = false;
  let emptyArmed = false, emptyTimer = null;
  let deleteArmed = 0;
  let ftTimer = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const typeLabel = (id) => {
    const t = state.itemTypes.find((x) => x.id === id);
    return t ? t.label : '文档';
  };
  const isTrash = () => state.scope.type === 'trash';

  async function refresh() {
    if (!L()) return;
    let s;
    try {
      s = await L().summary();
    } catch (err) {
      // 独立测试窗口（test-pen 等）只加载了 preload、没有主进程的 lib IPC：
      // 静默保持空库即可，绝不能把未处理的 rejection 冒到控制台。
      console.warn('[library] summary unavailable:', err && err.message ? err.message : err);
      return;
    }
    state.collections = s.collections || [];
    state.searches = s.searches || [];
    state.items = s.items || [];
    state.itemTypes = s.itemTypes || [];
    state.tagColors = s.tagColors || {};
    state.citekeys = (window.Cite && window.Cite.citekeys) ? window.Cite.citekeys(state.items) : new Map();
    if (state.selectedKey && !state.items.some((x) => x.key === state.selectedKey)) state.selectedKey = null;
    for (const k of [...state.selectedKeys]) if (!state.items.some((x) => x.key === k && !x.deletedAt)) state.selectedKeys.delete(k);
    render();
  }

  // ---------- 过滤 / 排序 ----------
  function itemCollections(it) { return it.collectionIds || []; }
  function matchesQuery(it, q) {
    if (!q) return true;
    const hay = [
      it.title, (it.creators || []).join(' '), it.year, it.publication,
      it.volume, it.issue, it.pages, it.doi, it.url, it.abstract, it.note, it.language,
      (it.tags || []).join(' '), (it.attachment && it.attachment.name) || '',
    ].join(' ').toLowerCase();
    return hay.includes(q);
  }

  function scopeSearch() {
    return state.scope.type === 'search' ? state.searches.find((x) => x.id === state.scope.id) || null : null;
  }

  function visibleItems() {
    let list = state.items.filter((x) => (isTrash() ? !!x.deletedAt : !x.deletedAt));
    if (state.scope.type === 'uncollected') list = list.filter((x) => !itemCollections(x).length);
    else if (state.scope.type === 'coll') list = list.filter((x) => itemCollections(x).includes(state.scope.id));
    // v14 标签选择器：选中多个标签时命中任一即可（与 Zotero 的标签选择器一致）
    if (state.tagFilter.size) {
      list = list.filter((x) => (x.tags || []).some((t) => state.tagFilter.has(t)));
    }
    const saved = scopeSearch();
    const q = (saved ? saved.query : state.query).trim().toLowerCase();
    if (q) list = list.filter((x) => matchesQuery(x, q));
    return sortItems(list);
  }

  function sortItems(list) {
    const out = list.slice();
    const byTitle = (a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
    const first = (arr) => (Array.isArray(arr) && arr.length ? String(arr[0] || '') : '');
    const field = state.sort;
    const dir = state.sortDir || (['added', 'modified', 'year'].includes(field) ? 'desc' : 'asc');
    let cmp;
    if (field === 'title') cmp = byTitle;
    else if (field === 'creator') cmp = (a, b) => first(a.creators).localeCompare(first(b.creators), 'zh-Hans-CN', { sensitivity: 'base' }) || byTitle(a, b);
    else if (field === 'type') cmp = (a, b) => typeLabel(a.itemType).localeCompare(typeLabel(b.itemType), 'zh-Hans-CN') || byTitle(a, b);
    else if (field === 'collection') cmp = (a, b) => firstCollName(a).localeCompare(firstCollName(b), 'zh-Hans-CN') || byTitle(a, b);
    else if (field === 'tag') cmp = (a, b) => first(a.tags).localeCompare(first(b.tags), 'zh-Hans-CN') || byTitle(a, b);
    else if (field === 'year') cmp = (a, b) => (Number(a.year) || 0) - (Number(b.year) || 0) || byTitle(a, b);
    else if (field === 'modified') cmp = (a, b) => (a.updated || 0) - (b.updated || 0);
    else cmp = (a, b) => (a.created || 0) - (b.created || 0);
    out.sort(cmp);
    if (dir === 'desc') out.reverse();
    return out;
  }

  function firstCollName(it) {
    const id = (it.collectionIds || [])[0];
    return id ? collName(id) : '';
  }

  function collName(id) { const c = state.collections.find((x) => x.id === id); return c ? c.name : ''; }
  function collDepth(id) {
    const byId = new Map(state.collections.map((c) => [c.id, c]));
    let d = 0, c = byId.get(id), guard = 0;
    while (c && c.parentId && guard++ < 20) { d++; c = byId.get(c.parentId); }
    return d;
  }

  // ---------- 渲染 ----------
  function render() {
    renderSidebar();
    renderTagList();
    renderSecToggles();
    renderGrid();
    renderDetail();
    renderBulk();
    renderFt();
    if (el.sort) el.sort.value = state.sort;
    renderSortHeads();
    if (el.emptyTrash) el.emptyTrash.hidden = !isTrash();
  }

  // 表头排序指示：同一列再点一次切换升/降序
  function renderSortHeads() {
    for (const btn of document.querySelectorAll('.lib-sort-h')) {
      const on = btn.dataset.sort === state.sort;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-sort', on ? ((state.sortDir || (['added', 'modified', 'year'].includes(state.sort) ? 'desc' : 'asc')) === 'asc' ? 'ascending' : 'descending') : 'none');
      const ind = btn.querySelector('.sort-ind');
      if (ind) ind.textContent = on ? ((state.sortDir || (['added', 'modified', 'year'].includes(state.sort) ? 'desc' : 'asc')) === 'asc' ? '▲' : '▼') : '';
    }
  }

  // 折叠分区（智能收藏集 / 标签）：默认收起，点标题展开
  function renderSecToggles() {
    for (const btn of document.querySelectorAll('.lib-sec-toggle')) {
      const key = btn.dataset.sec;
      const open = !!state.secOpen[key];
      btn.classList.toggle('open', open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      const target = key === 'tags' ? el.tagList : el.searches;
      if (target) target.hidden = !open;
    }
  }

  // ---------- 标签选择器（v14） ----------
  // 侧栏列出库里出现过的标签与条数，点一下就按这个标签筛；可多选。
  function allTags() {
    const cnt = new Map();
    for (const it of state.items) {
      if (it.deletedAt) continue;
      for (const t of (it.tags || [])) {
        const name = String(t || '').trim();
        if (!name) continue;
        cnt.set(name, (cnt.get(name) || 0) + 1);
      }
    }
    return [...cnt.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0], 'zh-Hans-CN'));
  }

  function renderTagList() {
    if (!el.tagList) return;
    const tags = allTags();
    if (!tags.length) {
      el.tagList.innerHTML = '<div class="lib-side-title">标签</div><div class="lib-side-empty">还没有标签</div>';
      return;
    }
    let html = '<div class="lib-side-title">标签 <span class="lib-side-hint">点击筛选</span></div>';
    if (state.tagFilter.size) {
      html += '<button class="lib-tag-clear" data-tag-clear="1">清除筛选（' + state.tagFilter.size + '）</button>';
    }
    html += tags.map(([name, n]) => {
      const on = state.tagFilter.has(name);
      const color = (state.tagColors && state.tagColors[name]) || '';
      return '<div class="lib-tag-wrap">' +
        '<button class="lib-tag-row' + (on ? ' active' : '') + '" data-tag-filter="' + esc(name) + '"' +
        ' title="' + esc(name) + '（' + n + ' 条）">' +
        '<span class="tcolor" data-tag-color="' + esc(name) + '" title="设置标签颜色"' +
          (color ? ' style="background:' + esc(color) + '"' : '') + '></span>' +
        '<span class="cname">' + esc(name) + '</span>' +
        '<span class="lc-count">' + n + '</span></button>' +
        '<span class="lib-tag-mgr">' +
          '<span class="tagmgr" data-tag-rename="' + esc(name) + '" title="重命名（改成已有标签名即合并）">✎</span>' +
          '<span class="tagmgr" data-tag-del="' + esc(name) + '" title="从所有条目上移除这个标签">🗑</span>' +
        '</span>' +
      '</div>';
    }).join('');
    el.tagList.innerHTML = html;
  }

  function toggleTagFilter(name) {
    const t = String(name || '').trim();
    if (!t) return;
    if (state.tagFilter.has(t)) state.tagFilter.delete(t);
    else state.tagFilter.add(t);
    render();
  }

  function renderSidebar() {
    const active = state.items.filter((x) => !x.deletedAt).length;
    const trash = state.items.filter((x) => !!x.deletedAt).length;
    const uncoll = state.items.filter((x) => !x.deletedAt && !itemCollections(x).length).length;
    let html = '';
    html += collRow('all', '全部条目', active, state.scope.type === 'all');
    html += collRow('uncollected', '未分类', uncoll, state.scope.type === 'uncollected');
    for (const c of state.collections) {
      const cnt = state.items.filter((x) => !x.deletedAt && itemCollections(x).includes(c.id)).length;
      const pad = 8 + Math.min(6, collDepth(c.id)) * 14;
      const color = c.color || '';
      html += '<button class="lib-coll' + (state.scope.type === 'coll' && state.scope.id === c.id ? ' active' : '') + '"' +
        ' data-scope="coll" data-id="' + esc(c.id) + '" data-drop-coll="' + esc(c.id) + '" style="padding-left:' + pad + 'px">' +
        '<span class="ccolor" data-coll-color="' + esc(c.id) + '" title="设置收藏集颜色"' +
          (color ? ' style="background:' + esc(color) + '"' : '') + '></span>' +
        '<span class="cname" data-coll-rename="' + esc(c.id) + '" title="双击重命名">' + esc(c.name) + '</span>' +
        '<span class="lc-count" style="color:#9aa0a6;font-size:11px">' + cnt + '</span>' +
        '<span class="cdel" data-del="' + esc(c.id) + '" title="删除收藏集（不删条目/不删文件）">✕</span>' +
        '</button>';
    }
    html += '<div class="lib-side-sep"></div>';
    html += collRow('trash', '回收站', trash, isTrash());
    el.collections.innerHTML = html;
    // 选中某个收藏集时，“新建”落到它的子级（数据层早已支持 parentId，v10 补上入口）
    el.newColl.textContent = state.scope.type === 'coll' ? '＋ 新建子收藏集' : '＋ 新建收藏集';
    renderSearches();
  }

  function renderSearches() {
    if (!el.searches) return;
    const active = state.scope.type === 'search';
    let html = '<div class="lib-side-title">智能收藏集</div>';
    if (!state.searches.length) {
      html += '<div class="lib-side-empty">搜索后点下方按钮保存条件</div>';
    } else {
      for (const s of state.searches) {
        const q = String(s.query || '').toLowerCase();
        const cnt = state.items.filter((x) => !x.deletedAt && matchesQuery(x, q)).length;
        html += '<button class="lib-coll lib-search-row' + (active && state.scope.id === s.id ? ' active' : '') + '"' +
          ' data-search="' + esc(s.id) + '" title="' + esc(s.query) + '">' +
          '<span class="cname">' + esc(s.name) + '</span>' +
          '<span class="lc-count">' + cnt + '</span>' +
          '<span class="cdel" data-del-search="' + esc(s.id) + '" title="删除智能收藏集（不删条目）">✕</span>' +
          '</button>';
      }
    }
    el.searches.innerHTML = html;
    if (el.saveSearch) el.saveSearch.hidden = !state.query.trim() || isTrash();
  }
  function collRow(type, name, cnt, active) {
    return '<button class="lib-coll' + (active ? ' active' : '') + '" data-scope="' + type + '">' +
      '<span class="cname">' + esc(name) + '</span>' +
      '<span style="color:#9aa0a6;font-size:11px">' + cnt + '</span></button>';
  }

  function renderGrid() {
    const list = visibleItems();
    const saved = scopeSearch();
    el.scopeTitle.textContent =
      state.scope.type === 'all' ? '全部条目' :
      state.scope.type === 'uncollected' ? '未分类' :
      state.scope.type === 'trash' ? '回收站' :
      state.scope.type === 'search' ? ('智能收藏集：' + (saved ? saved.name : '')) :
      collName(state.scope.id);
    el.count.textContent = list.length + ' 条';
    el.empty.hidden = list.length !== 0;
    el.empty.textContent = isTrash() ? '回收站是空的。'
      : (state.query.trim() || saved) ? '没有匹配的条目。'
      : '还没有条目。点右上角「导入文档」，或把 PDF / Word / PPT / Excel / Markdown 等文件拖进来。';
    if (el.selectAll) {
      const checked = list.filter((x) => !x.deletedAt && state.selectedKeys.has(x.key)).length;
      el.selectAll.checked = list.length > 0 && checked === list.length;
      el.selectAll.indeterminate = checked > 0 && checked < list.length;
      el.selectAll.disabled = isTrash() || !list.length;
    }
    const keepTop = el.grid.scrollTop;
    el.grid.innerHTML = list.map((it) => cardHtml(it)).join('');
    el.grid.scrollTop = keepTop;
  }

  // 条目渲染成「学术表格」的一行：标题 / 作者·年份·来源 / 类型 / 收藏集 / 标签 / 操作
  // 类名保持不变（lib-card / lctitle / lctype / lcprog / lccoll…），探针与事件委托都依赖它们。
  function cardHtml(it) {
    const trashed = !!it.deletedAt;
    const selected = it.key === state.selectedKey;
    const picked = state.selectedKeys.has(it.key);
    // 当前正在读的那篇，标一下（回库时一眼知道自己在哪）
    const cur = !!(window.App && App.state.filePath && it.attachment
      && it.attachment.path && it.attachment.path === App.state.filePath);
    const check = trashed ? '' : '<label class="lc-check" title="选择条目"><input type="checkbox" data-select-key="' + esc(it.key) + '"' + (picked ? ' checked' : '') + ' /></label>';
    const meta = [];
    if (it.creators && it.creators.length) meta.push(esc(it.creators.join(', ')));
    if (it.year) meta.push(esc(it.year));
    if (it.publication) meta.push(esc(it.publication));
    const tags = (it.tags || []).map((t) => {
      const color = (state.tagColors && state.tagColors[t]) || '';
      return '<span class="lctag" data-tag-filter="' + esc(t) + '" title="按这个标签筛选">' +
        (color ? '<span class="tcolor" style="background:' + esc(color) + '"></span>' : '') + esc(t) +
        (trashed ? '' : '<span class="tagdel" data-rmtag="' + esc(it.key) + '" data-tag="' + esc(t) + '" title="移除标签">×</span>') + '</span>';
    }).join('');
    const colls = itemCollections(it).map((id) => {
      const c = state.collections.find((x) => x.id === id);
      if (!c) return '';
      return '<span class="lccoll">' + (c.color ? '<span class="ccolor" style="background:' + esc(c.color) + '"></span>' : '') + esc(c.name) + '</span>';
    }).join('');
    const progress = it.page > 1 ? '<span class="lcprog">第 ' + it.page + ' 页</span>' : '';
    const openAttr = trashed ? '' : ' data-open="' + esc(it.key) + '"';
    // 2026-10-21 用户反馈：点条目名字应该进阅读，不该弹重命名（Zotero 也是这么做的：
    // 列表里单击=选中/打开，标题编辑在右侧详情面板）。重命名入口 = 详情面板的标题字段。
    const titleAttr = trashed ? '' : ' title="单击选中，双击打开阅读"';
    const tagAdd = trashed ? '' : '<span class="lc-addtag" data-addtag="' + esc(it.key) + '" title="加标签">＋</span>';
    const actions = trashed
      ? '<button data-detail="' + esc(it.key) + '">详情</button>' +
        '<button data-restore="' + esc(it.key) + '">还原</button>' +
        '<button class="rm" data-delete="' + esc(it.key) + '">永久删除</button>'
      : '<button data-detail="' + esc(it.key) + '">详情</button>' +
        '<button class="rm" data-trash="' + esc(it.key) + '">回收站</button>';
    const note = trashed
      ? '<div class="lcpath">在回收站中 · 磁盘文件未被删除</div>'
      : (!it.hasFile ? '<div class="lcpath">文件已移动或删除 · 可在详情里重新定位</div>' : '');
    return '<div class="lib-card' + (selected ? ' selected' : '') + (picked ? ' picked' : '') + (cur ? ' current' : '') + (it.hasFile ? '' : ' missing') + '" data-key="' + esc(it.key) + '"' + openAttr +
      (trashed ? '' : ' draggable="true"') + '>' +
      check +
      '<div class="lctitle"' + titleAttr + '>' + esc(it.title || '(无标题)') + '</div>' +
      '<div class="lcmeta">' + (meta.join(' · ') || esc((it.attachment && it.attachment.name) || '')) + '</div>' +
      '<div class="lcmeta2"><span class="lctype">' + esc(typeLabel(it.itemType)) + '</span>' + progress + '</div>' +
      '<div class="lccolls">' + colls + '</div>' +
      '<div class="lctags">' + tags + tagAdd + '</div>' +
      '<div class="lcbar">' + actions + '</div>' +
      note +
    '</div>';
  }

  function renderBulk() {
    if (!el.bulk) return;
    const n = state.selectedKeys.size;
    el.bulk.hidden = n === 0 || isTrash();
    if (el.bulkCount) el.bulkCount.textContent = '已选 ' + n + ' 项';
  }

  // ---------- 库级全文检索结果 ----------
  function renderFt() {
    if (!el.ft) return;
    const q = state.query.trim();
    const show = !!q && !isTrash();
    el.ft.hidden = !show;
    if (!show) return;
    if (state.ft.loading) {
      el.ft.innerHTML = '<div class="lib-ft-head"><span class="lib-ft-title">全文检索：“' + esc(q) + '”</span><span class="ld-hint">搜索索引中…</span></div>';
      return;
    }
    if (state.ft.error) {
      el.ft.innerHTML = '<div class="lib-ft-head"><span class="lib-ft-title">全文检索：“' + esc(q) + '”</span></div>' +
        '<div class="sb-empty">' + esc(state.ft.error) + '</div>';
      return;
    }
    if (state.ft.query !== q) return; // 旧请求结果，等新结果
    const list = state.ft.results || [];
    if (!list.length) {
      const st = state.ft.stats || {};
      const hint = st.indexed ? '全文索引里没有命中。' : '全文索引还是空的，可在「设置 → 全文索引」里补建。';
      el.ft.innerHTML = '<div class="lib-ft-head"><span class="lib-ft-title">全文检索：“' + esc(q) + '”</span>' +
        '<span class="ld-hint">' + esc(hint) + '</span></div>';
      return;
    }
    el.ft.innerHTML = '<div class="lib-ft-head"><span class="lib-ft-title">全文检索：“' + esc(q) + '” · ' + list.length + ' 处命中</span>' +
      '<span class="ld-hint">全文 / 摘录 / 批注 / 笔记合并搜索，点击跳到对应页</span></div>' +
      list.map((r) => {
        const kind = r.type || 'fulltext';
        const label = r.label || (kind === 'note' ? '笔记' : kind === 'annotation' ? '批注' : '全文');
        return '<button class="lib-ft-row" data-ft-key="' + esc(r.key) + '" data-ft-page="' + (r.page || 1) + '"' +
          (r.noteId ? ' data-ft-note="' + esc(r.noteId) + '"' : '') + '>' +
          '<span class="lib-ft-type ' + esc(kind) + '">' + esc(label) + '</span>' +
          '<span class="lib-ft-doc">' + esc(r.title || '(无标题)') + '</span>' +
          '<span class="lib-ft-pg">P' + (r.page || '?') + '</span>' +
          '<span class="lib-ft-snip">' + esc(r.snippet || '') + '</span>' +
          '</button>';
      }).join('');
  }

  function scheduleFulltext() {
    clearTimeout(ftTimer);
    ftTimer = setTimeout(runFulltext, 320);
  }

  async function runFulltext() {
    if (!L() || !L().searchFull) return;
    const q = state.query.trim();
    if (!q || isTrash()) {
      state.ft = { query: q, results: [], stats: null, loading: false, error: '' };
      renderFt();
      return;
    }
    state.ft = { query: q, results: [], stats: state.ft.stats, loading: true, error: '' };
    renderFt();
    try {
      const r = await L().searchFull(q);
      if (state.query.trim() !== q) return;
      state.ft = {
        query: q, results: (r && r.results) || [], stats: (r && r.stats) || null,
        loading: false, error: (r && r.ok === false) ? (r.error || '检索失败') : '',
      };
    } catch (err) {
      state.ft = { query: q, results: [], stats: null, loading: false, error: '检索失败：' + (err && err.message ? err.message : err) };
    }
    renderFt();
  }

  // ---------- 详情面板 ----------
  function selectedItem() {
    return state.selectedKey ? state.items.find((x) => x.key === state.selectedKey) || null : null;
  }

  function openDetail(key) {
    state.selectedKey = key;
    state.flash = '';
    state.detailTags = [];
    markSelection();
    renderDetail();
  }
  function closeDetail() {
    state.selectedKey = null;
    el.detail.hidden = true;
    markSelection();
  }

  // 只更新选中态，不重建列表：否则第一次 click 就把卡片节点换掉，dblclick 永远触发不了。
  function markSelection() {
    if (!el.grid) return;
    for (const card of el.grid.querySelectorAll('.lib-card')) {
      const k = card.dataset.key;
      card.classList.toggle('selected', k === state.selectedKey);
      card.classList.toggle('picked', state.selectedKeys.has(k));
      const cb = card.querySelector('[data-select-key]');
      if (cb) cb.checked = state.selectedKeys.has(k);
    }
    renderBulk();
  }

  function fillTypeOptions() {
    if (el.ld.type.options.length || !state.itemTypes.length) return;
    el.ld.type.innerHTML = state.itemTypes.map((t) =>
      '<option value="' + esc(t.id) + '">' + esc(t.label) + '</option>').join('');
  }

  // v23：阅读笔记列表（每条独立保存，不影响表单里没保存的其他字段）
  function renderNotes(it) {
    if (!el.ld.notes) return;
    const notes = (it && it.notes) || [];
    if (!notes.length) {
      el.ld.notes.innerHTML = '<div class="ld-hint">还没有笔记。读完一段写一条，之后能单独翻出来看。</div>';
      return;
    }
    el.ld.notes.innerHTML = notes.map((n) => (
      '<div class="ld-note" data-note-id="' + esc(n.id) + '">' +
        '<input class="ld-note-title" data-note-field="title" value="' + esc(n.title) + '" placeholder="标题（可以留空）" />' +
        '<textarea class="ld-note-text" data-note-field="text" rows="3" placeholder="这条笔记的内容…">' + esc(n.text) + '</textarea>' +
        '<div class="ld-note-foot"><span class="ld-hint">失焦自动保存</span>' +
        '<button class="ld-mini ld-note-del" title="删除这条笔记">删除</button></div>' +
      '</div>'
    )).join('');
  }

  // 刷新条目数据但不重绘详情表单（免得把用户没保存的其它字段冲掉）
  async function reloadItemsQuiet() {
    try {
      const s = await L().summary();
      if (s && Array.isArray(s.items)) state.items = s.items;
    } catch (_) {}
  }

  function renderDetail() {
    const it = selectedItem();
    if (!it) { el.detail.hidden = true; return; }
    const trashed = !!it.deletedAt;
    el.detail.hidden = false;
    fillTypeOptions();

    el.ld.type.value = it.itemType || 'document';
    el.ld.title.value = it.title || '';
    el.ld.creators.value = (it.creators || []).join(', ');
    el.ld.year.value = it.year || '';
    el.ld.publication.value = it.publication || '';
    el.ld.volume.value = it.volume || '';
    el.ld.issue.value = it.issue || '';
    el.ld.pages.value = it.pages || '';
    el.ld.doi.value = it.doi || '';
    el.ld.url.value = it.url || '';
    el.ld.abstract.value = it.abstract || '';
    renderNotes(it);
    state.detailTags = (it.tags || []).slice();
    renderDetailTags(trashed);
    renderDetailColls(it, trashed);
    renderAttach(it, trashed);
    renderCite(it, trashed);
    renderCitekey(it, trashed);
    renderRelations(it, trashed);

    const fields = [el.ld.type, el.ld.title, el.ld.creators, el.ld.year, el.ld.publication,
      el.ld.volume, el.ld.issue, el.ld.pages, el.ld.doi, el.ld.url, el.ld.abstract];
    for (const f of fields) f.disabled = trashed;
    if (el.ld.notes) el.ld.notes.querySelectorAll('input, textarea, button').forEach((n) => { n.disabled = trashed; });
    if (el.ld.noteAdd) el.ld.noteAdd.disabled = trashed;
    el.ld.tagInput.disabled = trashed;
    el.ld.tagAdd.disabled = trashed;
    el.ld.save.hidden = trashed;
    el.ld.trash.hidden = trashed;
    el.ld.trash.textContent = '移入回收站';
    el.ld.restore.hidden = !trashed;
    // 注意键名是 del：delete 是保留字。曾误写成 el.ld.delete，抛错后 render 后半段（排序/清空按钮）被整段跳过。
    el.ld.del.hidden = !trashed;
    if (el.ld.fetch) el.ld.fetch.disabled = trashed;
    if (el.ld.fetchStatus) el.ld.fetchStatus.textContent = trashed ? '回收站条目不能抓取' : '';

    const added = it.created ? new Date(it.created).toLocaleString('zh-CN', { hour12: false }) : '未知';
    const modified = it.updated ? new Date(it.updated).toLocaleString('zh-CN', { hour12: false }) : '未知';
    el.ld.dates.textContent = '添加于 ' + added + ' · 修改于 ' + modified +
      (it.page > 1 ? ' · 已读至第 ' + it.page + ' 页' : '');
    el.ld.status.textContent = state.flash || '';
    state.flash = '';
  }

  // ---------- 引用（v14） ----------
  // 预览与复制都按「表单里当前的字段」算，改完标题不用先保存也能看到引用长什么样。
  function citeOfForm() {
    const it = selectedItem();
    if (!it || !window.Cite) return '';
    let merged = it;
    try { merged = Object.assign({}, it, readDetailForm()); } catch (_) { merged = it; }
    try { return window.Cite.format(merged, state.citeStyle); } catch (_) { return ''; }
  }

  function renderCite(it, trashed) {
    if (!el.ld.citePreview) return;
    if (el.ld.citeStyle) el.ld.citeStyle.value = state.citeStyle;
    const text = it ? citeOfForm() : '';
    el.ld.citePreview.textContent = text || '（先填标题）';
    el.ld.citePreview.classList.toggle('empty', !text);
    if (el.ld.citeCopy) el.ld.citeCopy.disabled = trashed || !text;
    if (el.ld.citeStatus) el.ld.citeStatus.textContent = '';
  }

  async function copyCitation() {
    const text = citeOfForm();
    if (!text) { if (el.ld.citeStatus) el.ld.citeStatus.textContent = '先填标题'; return; }
    try {
      const r = await window.pdfBridge.copyText(text);
      if (r && r.ok) {
        if (el.ld.citeStatus) el.ld.citeStatus.textContent = '已复制到剪贴板';
        window.App && window.App.toast && window.App.toast('引用已复制');
      } else if (el.ld.citeStatus) el.ld.citeStatus.textContent = (r && r.error) || '复制失败';
    } catch (err) {
      if (el.ld.citeStatus) el.ld.citeStatus.textContent = '复制失败';
    }
  }

  // ---------- 引用键（citekey） ----------
  function citekeyOf(it) {
    if (!it) return '';
    const stable = state.citekeys.get(it.key);
    if (stable) return stable;
    return (window.Cite && window.Cite.citekey) ? window.Cite.citekey(it) : '';
  }

  function renderCitekey(it, trashed) {
    if (!el.ld.citekey) return;
    const key = citekeyOf(it);
    el.ld.citekey.textContent = key || '—';
    el.ld.citekey.title = key ? ('引用键：' + key + '（确定性生成）') : '先填标题';
    if (el.ld.citekeyCopy) el.ld.citekeyCopy.disabled = trashed || !key;
    if (el.ld.citekeyAt) el.ld.citekeyAt.disabled = trashed || !key;
    if (el.ld.citekeyStatus) el.ld.citekeyStatus.textContent = '';
  }

  async function copyCitekey(asAt) {
    const it = selectedItem();
    if (!it) return;
    const key = citekeyOf(it);
    if (!key) return;
    const text = asAt ? ('[@' + key + ']') : key;
    try {
      const r = await window.pdfBridge.copyText(text);
      if (el.ld.citekeyStatus) el.ld.citekeyStatus.textContent = (r && r.ok) ? '已复制 ' + text : '复制失败';
    } catch (_) {
      if (el.ld.citekeyStatus) el.ld.citekeyStatus.textContent = '复制失败';
    }
  }

  // ---------- 相关条目（双向） ----------
  function renderRelations(it, trashed) {
    if (!el.ld.relations) return;
    const rels = (it && it.relations) || [];
    const rows = rels.map((k) => state.items.find((x) => x.key === k)).filter(Boolean);
    if (!rows.length) {
      el.ld.relations.innerHTML = '<div class="ld-hint">还没有关联条目。</div>';
    } else {
      el.ld.relations.innerHTML = rows.map((x) =>
        '<div class="ld-rel" data-rel-key="' + esc(x.key) + '">' +
          '<span class="rname" data-rel-open="' + esc(x.key) + '" title="打开条目详情">' + esc(x.title || '(无标题)') + '</span>' +
          '<span class="rmeta">' + esc(typeLabel(x.itemType)) + (x.year ? ' · ' + esc(x.year) : '') + '</span>' +
          (trashed ? '' : '<button class="rdel" data-rel-remove="' + esc(x.key) + '" title="解除关联">✕</button>') +
        '</div>').join('');
    }
    if (!el.ld.relSelect || !el.ld.relAdd) return;
    const options = state.items
      .filter((x) => !x.deletedAt && x.key !== (it && it.key) && !rels.includes(x.key))
      .sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'zh-Hans-CN'))
      .map((x) => '<option value="' + esc(x.key) + '">' + esc(x.title || '(无标题)') + '</option>');
    el.ld.relSelect.innerHTML = '<option value="">选择条目…</option>' + options.join('');
    el.ld.relSelect.disabled = trashed || !options.length;
    el.ld.relAdd.disabled = trashed || !options.length;
  }

  function renderDetailTags(trashed) {    el.ld.tags.innerHTML = state.detailTags.length
      ? state.detailTags.map((t) => '<span class="ld-tag">' + esc(t) +
          (trashed ? '' : '<button class="ld-tagd" data-ld-rmtag="' + esc(t) + '" title="移除标签">✕</button>') + '</span>').join('')
      : '<span class="ld-hint">暂无标签</span>';
  }

  function renderDetailColls(it, trashed) {
    if (!state.collections.length) {
      el.ld.colls.innerHTML = '<span class="ld-hint">还没有收藏集</span>';
      return;
    }
    el.ld.colls.innerHTML = state.collections.map((c) => {
      const checked = itemCollections(it).includes(c.id);
      const pad = 0;
      return '<label class="ld-coll" style="padding-left:' + pad + 'px">' +
        '<input type="checkbox" value="' + esc(c.id) + '"' + (checked ? ' checked' : '') + (trashed ? ' disabled' : '') + ' />' +
        '<span>' + esc(c.name) + '</span></label>';
    }).join('');
  }

  function renderAttach(it, trashed) {
    if (!it.attachment) {
      el.ld.attach.innerHTML = '<span class="ld-hint">无附件</span>';
      return;
    }
    const name = it.attachment.name || it.attachment.path;
    const missing = !it.hasFile;
    el.ld.attach.innerHTML =
      '<div class="ld-fname">' + esc(name) + '</div>' +
      '<div class="ld-fpath' + (missing ? ' ld-missing' : '') + '">' + esc(it.attachment.path) +
        (missing ? ' · 文件已移动或删除' : '') + '</div>' +
      '<div class="ld-attach-actions">' +
        '<button class="ld-mini" data-ld-reveal="1"' + (missing ? ' disabled' : '') + '>在文件夹中显示</button>' +
        '<button class="ld-mini" data-ld-relink="1"' + (trashed ? ' disabled' : '') + '>重新定位…</button>' +
      '</div>';
  }

  function readDetailForm() {
    const val = (id) => el.ld[id].value.trim();
    const tags = state.detailTags.slice();
    const pending = el.ld.tagInput.value.trim();
    if (pending && !tags.includes(pending)) tags.push(pending);
    const collectionIds = Array.from(el.ld.colls.querySelectorAll('input[type="checkbox"]:checked')).map((x) => x.value);
    return {
      itemType: val('type'), title: val('title'),
      creators: val('creators').split(/[,，;；]/).map((x) => x.trim()).filter(Boolean),
      year: val('year'), publication: val('publication'),
      volume: val('volume'), issue: val('issue'), pages: val('pages'),
      doi: val('doi'), url: val('url'), abstract: val('abstract'),
      tags, collectionIds,   // v23：阅读笔记走 notes[]，不再由表单整块保存
    };
  }

  async function saveDetail() {
    const it = selectedItem();
    if (!it || it.deletedAt) return;
    const patch = readDetailForm();
    if (!patch.title) patch.title = '(无标题)';
    await L().updateItem(it.key, patch);
    await refresh();
    el.ld.status.textContent = '已保存';
    window.App && window.App.toast && window.App.toast('条目已保存');
  }

  // ---------- 动作 ----------
  async function openItem(key, page) {
    const res = await L().openItem(key, page);
    if (!res || !res.ok) {
      if (res && res.missingPath) { await refresh(); }
      window.App && window.App.toast && window.App.toast('打开失败：' + ((res && res.error) || '未知错误'));
      return;
    }
    hide();
    if (typeof window.__libOpen === 'function') window.__libOpen(res);
  }

  async function importPdf() {
    const res = await window.pdfBridge.openPdfDialog();
    if (res && res.ok && res.filePath) {
      // dedupe: 同一个文件已经在库里就别再塞一条（导入/拖入的用户语义）
      const added = await L().addPdf(res.filePath, { dedupe: true });
      if (added && added.ok && added.item) { state.selectedKey = added.item.key; state.scope = { type: 'all' }; }
      await refresh();
    }
  }

  async function handleDrop(e) {
    // 支持所有常见文档：PDF / Word / PPT / Excel / Markdown / EPUB / 图片 / 纯文本…
    // 后端 lib-add-pdf 会再校验一次扩展名；这里只挡一下目录和空文件。
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []).filter((f) => f && f.name);
    if (!files.length) return;
    let n = 0, lastKey = null, failed = 0;
    for (const file of files) {
      let p = '';
      try { p = window.pdfBridge.pathForFile(file) || ''; } catch (_) {}
      if (!p) { failed++; continue; }
      const r = await L().addPdf(p, { dedupe: true });
      if (r && r.ok && r.item) { n++; lastKey = r.item.key; }
      else failed++;
    }
    if (!n) { window.App && window.App.toast && window.App.toast(failed ? '没有可导入的文档（格式不支持或路径不可用）' : '无法取得文件路径'); return; }
    if (lastKey) state.selectedKey = lastKey;
    state.scope = { type: 'all' };
    await refresh();
    window.App && window.App.toast && window.App.toast('已导入 ' + n + ' 个文档' + (failed ? '，' + failed + ' 个跳过' : ''));
  }

  async function trashItem(key) {
    await L().trashItem(key);
    await refresh();
    window.App && window.App.toast && window.App.toast('已移入回收站（未删除磁盘文件）');
  }
  async function restoreItem(key) {
    await L().restoreItem(key);
    await refresh();
    window.App && window.App.toast && window.App.toast('已还原条目');
  }
  async function deleteItem(key) {
    await L().deleteItem(key);
    if (state.selectedKey === key) state.selectedKey = null;
    await refresh();
    window.App && window.App.toast && window.App.toast('已删除索引（磁盘 PDF 未删除）');
  }

  function resetEmptyArm() {
    emptyArmed = false;
    clearTimeout(emptyTimer);
    if (el.emptyTrash) el.emptyTrash.textContent = '清空回收站';
  }
  async function emptyTrash() {
    if (!emptyArmed) {
      emptyArmed = true;
      el.emptyTrash.textContent = '再点一次确认清空';
      clearTimeout(emptyTimer);
      emptyTimer = setTimeout(resetEmptyArm, 4000);
      return;
    }
    resetEmptyArm();
    const res = await L().emptyTrash();
    state.selectedKey = null;
    await refresh();
    window.App && window.App.toast && window.App.toast('已清空 ' + ((res && res.removed) || 0) + ' 条索引（磁盘 PDF 未删除）');
  }

  // ---------- 设置 / 备份 / 全文索引 ----------
  function applyTheme(theme) {
    if (window.App && window.App.applyTheme) window.App.applyTheme(theme);
  }

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n > 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    if (n > 1024) return Math.round(n / 1024) + ' KB';
    return n + ' B';
  }

  async function loadSettings() {
    if (!window.pdfBridge || !window.pdfBridge.getSettings) return;
    try {
      const s = await window.pdfBridge.getSettings();
      if (!s) return;
      state.settings = Object.assign({}, state.settings, s);
      if (!state.sortTouched && s.defaultSort) state.sort = s.defaultSort;
      if (el.sort) el.sort.value = state.sort;
      applyTheme(state.settings.theme);
      if (window.App && App.applyInvert) App.applyInvert(!!state.settings.invertPages);
    } catch (_) {}
  }

  function setSettingsStatus(text) {
    if (el.setStatus) el.setStatus.textContent = text || '';
  }

  async function refreshFtStatus() {
    if (!el.setFtStatus) return;
    if (!L() || !L().ftStatus) { el.setFtStatus.textContent = '当前窗口无索引接口'; return; }
    try {
      const s = await L().ftStatus();
      const total = s.totalItems || 0;
      el.setFtStatus.textContent = (s.indexedItems || 0) + ' / ' + total + ' 个 PDF 已索引 · ' +
        (s.pages || 0) + ' 页 · ' + fmtBytes(s.bytes);
    } catch (err) {
      el.setFtStatus.textContent = '索引状态读取失败';
    }
  }

  async function openSettings() {
    if (!el.settingsModal) return;
    fillBulkOptions();
    if (el.setTheme) el.setTheme.value = state.settings.theme || 'light';
    if (el.setSort) el.setSort.value = state.settings.defaultSort || 'added';
    if (el.setAutoIndex) el.setAutoIndex.checked = state.settings.autoIndex !== false;
    if (el.setInvertPages) el.setInvertPages.checked = !!state.settings.invertPages;
    if (el.setViewMode) el.setViewMode.value = state.settings.viewMode === 'page' ? 'page' : 'scroll';
    if (window.App && App.setViewMode && state.settings.viewMode) {
      App.state.viewMode = state.settings.viewMode === 'page' ? 'page' : 'scroll';
      document.body.classList.toggle('view-page', App.state.viewMode === 'page');
    }
    if (el.setDataDir) el.setDataDir.textContent = state.settings.dataDir || '（默认 userData）';
    setSettingsStatus('');
    el.settingsModal.hidden = false;
    refreshFtStatus();
  }

  function closeSettings() { if (el.settingsModal) el.settingsModal.hidden = true; }

  async function saveSettings() {
    if (!window.pdfBridge || !window.pdfBridge.setSettings) return;
    const patch = {
      theme: el.setTheme ? el.setTheme.value : 'light',
      defaultSort: el.setSort ? el.setSort.value : 'added',
      autoIndex: el.setAutoIndex ? el.setAutoIndex.checked : true,
      invertPages: el.setInvertPages ? el.setInvertPages.checked : false,
      viewMode: el.setViewMode ? el.setViewMode.value : 'scroll',
    };
    const r = await window.pdfBridge.setSettings(patch);
    if (!r || !r.ok) { setSettingsStatus('保存失败：' + ((r && r.error) || '未知错误')); return; }
    state.settings = Object.assign({}, state.settings, r.effective || patch);
    state.sort = state.settings.defaultSort || state.sort;
    state.sortTouched = false;
    if (el.sort) el.sort.value = state.sort;
    applyTheme(state.settings.theme);
    if (window.App && App.applyInvert) App.applyInvert(!!state.settings.invertPages);
    if (window.App && App.setViewMode) App.setViewMode(state.settings.viewMode === 'page' ? 'page' : 'scroll');
    await refresh();
    setSettingsStatus('设置已保存');
    window.App && window.App.toast && window.App.toast('设置已保存');
  }

  async function changeDataDir() {
    if (!L() || !L().chooseDataDir) return;
    setSettingsStatus('等待选择目录…');
    const r = await L().chooseDataDir();
    if (!r || r.canceled) { setSettingsStatus('已取消'); return; }
    if (!r.ok) { setSettingsStatus('切换失败：' + (r.error || '未知错误')); return; }
    state.settings.dataDir = r.dataDir;
    if (el.setDataDir) el.setDataDir.textContent = r.dataDir;
    await refresh();
    setSettingsStatus('存储位置已切换；旧位置已自动备份');
    window.App && window.App.toast && window.App.toast('存储位置已切换');
  }

  async function doBackup() {
    if (!L() || !L().backup) return;
    setSettingsStatus('正在备份…');
    const r = await L().backup();
    if (r && r.ok) setSettingsStatus('已备份 ' + r.items + ' 条到 ' + r.path);
    else if (r && r.canceled) setSettingsStatus('已取消备份');
    else setSettingsStatus('备份失败：' + ((r && r.error) || '未知错误'));
  }

  async function doRestore() {
    if (!L() || !L().restore) return;
    setSettingsStatus('等待选择备份…');
    const r = await L().restore();
    if (r && r.ok) {
      await refresh();
      setSettingsStatus('已恢复 ' + r.items + ' 条；恢复前快照在 ' + r.preBackup);
    } else if (r && r.canceled) setSettingsStatus('已取消恢复');
    else setSettingsStatus('恢复失败：' + ((r && r.error) || '未知错误'));
  }

  async function indexAll(force) {
    if (!L() || !L().indexAll) return;
    setSettingsStatus(force ? '正在全部重建索引…' : '正在补建索引…');
    if (el.setIndex) el.setIndex.disabled = true;
    if (el.setReindex) el.setReindex.disabled = true;
    const r = await L().indexAll(force);
    if (el.setIndex) el.setIndex.disabled = false;
    if (el.setReindex) el.setReindex.disabled = false;
    if (r && r.ok) setSettingsStatus('索引完成：新索引 ' + (r.done - r.skipped) + '，跳过 ' + r.skipped + '，失败 ' + r.failed);
    else setSettingsStatus('索引失败：' + ((r && r.error) || '未知错误'));
    await refreshFtStatus();
    scheduleFulltext();
  }

  async function clearIndex() {
    if (!L() || !L().ftClear) return;
    const r = await L().ftClear();
    setSettingsStatus('已清空 ' + ((r && r.removed) || 0) + ' 个索引文件；原 PDF 未受影响');
    await refreshFtStatus();
    state.ft = { query: state.query, results: [], stats: null, loading: false, error: '' };
    renderFt();
  }

  // ---------- DOI / arXiv 元数据 ----------
  async function fetchMetadata() {
    const it = selectedItem();
    if (!it || it.deletedAt) return;
    const ident = (el.ld.doi.value.trim() || el.ld.url.value.trim());
    if (!ident) {
      el.ld.fetchStatus.textContent = '请先填写 DOI 或 arXiv 链接/id';
      return;
    }
    el.ld.fetch.disabled = true;
    el.ld.fetchStatus.textContent = '抓取中…';
    const r = await L().fetchMetadata(ident);
    el.ld.fetch.disabled = false;
    if (!r || !r.ok) {
      el.ld.fetchStatus.textContent = '抓取失败：' + ((r && r.error) || '未知错误');
      return;
    }
    const m = r.metadata || {};
    const set = (id, v) => { if (el.ld[id] && v != null && String(v) !== '') el.ld[id].value = v; };
    set('title', m.title);
    set('creators', (m.creators || []).join(', '));
    set('year', m.year);
    set('publication', m.publication);
    set('volume', m.volume);
    set('issue', m.issue);
    set('pages', m.pages);
    set('doi', m.doi);
    set('url', m.url);
    set('abstract', m.abstract);
    if (el.ld.type && m.itemType) {
      const opt = Array.from(el.ld.type.options).find((o) => o.value === m.itemType);
      if (opt) el.ld.type.value = m.itemType;
    }
    if (m.tags && m.tags.length) {
      for (const t of m.tags) if (!state.detailTags.includes(t)) state.detailTags.push(t);
      renderDetailTags(false);
    }
    el.ld.fetchStatus.textContent = '已从 ' + String(r.source || '').toUpperCase() + ' 抓取，记得点「保存」';
  }

  // ---------- 查重 ----------
  async function openDuplicates() {
    if (!L() || !L().duplicates) return;
    const r = await L().duplicates();
    state.dupGroups = (r && r.groups) || [];
    renderDuplicates();
    if (el.dupModal) el.dupModal.hidden = false;
  }

  function renderDuplicates() {
    if (!el.dupBody) return;
    if (!state.dupGroups.length) {
      el.dupBody.innerHTML = '<div class="sb-empty">没有发现重复条目。查重依据：DOI 相同，或标题+年份相同。</div>';
      return;
    }
    el.dupBody.innerHTML = state.dupGroups.map((g, gi) =>
      '<div class="dup-group"><div class="dup-reason">' + esc((g.reasons || []).join(' / ')) + '</div>' +
      g.items.map((it, ii) =>
        '<label class="dup-row"><input type="radio" name="dup-' + gi + '" value="' + esc(it.key) + '"' + (ii === 0 ? ' checked' : '') + ' />' +
        '<span class="dup-title">' + esc(it.title || '(无标题)') + '</span>' +
        '<span class="ld-hint">' + esc(it.year || '') + (it.doi ? ' · ' + esc(it.doi) : '') + (it.hasFile ? ' · 有附件' : ' · 无附件') + '</span></label>').join('') +
      '<div class="dup-actions"><button class="ld-mini" data-dup-merge="' + gi + '">合并到选中的条目</button>' +
      '<span class="ld-hint">其余条目只删索引；磁盘 PDF 不删除</span></div></div>').join('');
  }

  async function mergeDup(index) {
    const g = state.dupGroups[index];
    if (!g) return;
    const keep = document.querySelector('input[name="dup-' + index + '"]:checked');
    if (!keep) return;
    const others = g.keys.filter((k) => k !== keep.value);
    await L().mergeItems(keep.value, others);
    if (el.dupStatus) el.dupStatus.textContent = '已合并 ' + others.length + ' 条';
    await refresh();
    await openDuplicates();
    window.App && window.App.toast && window.App.toast('已合并重复条目');
  }

  // ---------- 批量编辑 ----------
  function fillBulkOptions() {
    if (el.bulkType && !el.bulkType.options.length && state.itemTypes.length) {
      el.bulkType.innerHTML = '<option value="">不改</option>' + state.itemTypes.map((t) =>
        '<option value="' + esc(t.id) + '">' + esc(t.label) + '</option>').join('');
    }
    if (el.bulkColl && state.collections.length) {
      const cur = el.bulkColl.value;
      el.bulkColl.innerHTML = '<option value="">不添加</option>' + state.collections.map((c) =>
        '<option value="' + esc(c.id) + '">' + esc(c.name) + '</option>').join('');
      if (cur) el.bulkColl.value = cur;
    }
  }

  function openBulk() {
    if (!state.selectedKeys.size) return;
    fillBulkOptions();
    if (el.bulkTitle) el.bulkTitle.textContent = '批量编辑（已选 ' + state.selectedKeys.size + ' 项）';
    for (const id of ['bulkYear', 'bulkPublication', 'bulkAddTags', 'bulkRemoveTags']) if (el[id]) el[id].value = '';
    if (el.bulkType) el.bulkType.value = '';
    if (el.bulkColl) el.bulkColl.value = '';
    if (el.bulkStatus) el.bulkStatus.textContent = '';
    if (el.bulkModal) el.bulkModal.hidden = false;
  }

  function splitTags(v) {
    return String(v || '').split(/[,，;；]/).map((x) => x.trim()).filter(Boolean);
  }

  async function saveBulk() {
    const keys = [...state.selectedKeys];
    if (!keys.length) return;
    const patch = {};
    if (el.bulkType && el.bulkType.value) patch.itemType = el.bulkType.value;
    if (el.bulkYear && el.bulkYear.value.trim()) patch.year = el.bulkYear.value.trim();
    if (el.bulkPublication && el.bulkPublication.value.trim()) patch.publication = el.bulkPublication.value.trim();
    const add = splitTags(el.bulkAddTags && el.bulkAddTags.value);
    const rm = splitTags(el.bulkRemoveTags && el.bulkRemoveTags.value);
    if (add.length) patch.addTags = add;
    if (rm.length) patch.removeTags = rm;
    if (el.bulkColl && el.bulkColl.value) patch.addCollectionIds = [el.bulkColl.value];
    if (!Object.keys(patch).length) { if (el.bulkStatus) el.bulkStatus.textContent = '没有填写任何要修改的字段'; return; }
    const r = await L().bulkUpdate(keys, patch);
    if (el.bulkStatus) el.bulkStatus.textContent = '已更新 ' + ((r && r.updated) || 0) + ' 条';
    state.selectedKeys.clear();
    if (el.bulkModal) el.bulkModal.hidden = true;
    await refresh();
    window.App && window.App.toast && window.App.toast('批量修改已应用');
  }

  async function bulkTrash() {
    const keys = [...state.selectedKeys];
    if (!keys.length) return;
    await L().trashItems(keys);
    state.selectedKeys.clear();
    await refresh();
    window.App && window.App.toast && window.App.toast('已移入回收站（磁盘 PDF 未删除）');
  }

  async function importRefs() {
    if (!L() || !L().importRefs) return;
    const r = await L().importRefs();
    if (r && r.ok) {
      await refresh();
      window.App && window.App.toast && window.App.toast('导入 ' + r.added + ' 条，跳过重复 ' + r.skipped + ' 条');
    } else if (r && !r.canceled) {
      window.App && window.App.toast && window.App.toast('导入失败：' + (r.error || '未知错误'));
    }
  }

  async function exportRefs() {
    if (!L() || !L().exportRefs) return;
    const r = await L().exportRefs();
    if (r && r.ok) window.App && window.App.toast && window.App.toast('已导出 ' + r.count + ' 条到 ' + r.path);
    else if (r && !r.canceled) window.App && window.App.toast && window.App.toast('导出失败：' + (r.error || '未知错误'));
  }

  function saveCurrentSearch() {
    const q = state.query.trim();
    if (!q || !el.saveSearch) return;
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.placeholder = '智能收藏集名称';
    inp.value = q;
    inp.style.cssText = 'font:inherit;width:100%;padding:6px 8px;border:1px solid #1a73e8;border-radius:7px;outline:none';
    el.saveSearch.hidden = true;
    el.saveSearch.parentNode.insertBefore(inp, el.saveSearch);
    inp.focus(); inp.select();
    let closed = false;
    const finish = async (commit) => {
      if (closed) return; closed = true;
      const v = inp.value.trim();
      inp.remove();
      el.saveSearch.hidden = false;
      if (commit && v) {
        const r = await L().addSearch(v, q);
        await refresh();
        if (r && r.search) { state.scope = { type: 'search', id: r.search.id }; render(); }
      } else renderSidebar();
    };
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    inp.addEventListener('blur', () => finish(true));
  }

  // ---------- 内联输入 ----------
  // 新建收藏集不能替换按钮本身（按钮不在会重绘的 #lib-collections 里），
  // 否则建完一次后「＋ 新建收藏集」就永久消失了。这里改为在按钮前插入临时输入框。
  function inlineNewCollection() {
    const parentId = state.scope.type === 'coll' ? state.scope.id : null;
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.placeholder = parentId ? '子收藏集名称' : '收藏集名称';
    inp.style.cssText = 'font:inherit;width:100%;padding:6px 8px;border:1px solid #1a73e8;border-radius:7px;outline:none';
    el.newColl.hidden = true;
    el.newColl.parentNode.insertBefore(inp, el.newColl);
    inp.focus();
    let closed = false;
    const finish = async (commit) => {
      if (closed) return; closed = true;
      const v = inp.value.trim();
      inp.remove();
      el.newColl.hidden = false;
      if (commit && v) {
        await L().addCollection(v, parentId);
        await refresh();
      } else {
        renderSidebar();
      }
    };
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    inp.addEventListener('blur', () => finish(true));
  }

  function inlineInput(anchorEl, initial, onDone) {
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.value = initial || '';
    inp.style.cssText = 'font:inherit;width:100%;padding:4px 6px;border:1px solid #1a73e8;border-radius:6px;outline:none';
    anchorEl.replaceWith(inp);
    inp.focus();
    let closed = false;
    const finish = (commit) => {
      if (closed) return; closed = true;
      const v = inp.value.trim();
      if (commit && v) onDone(v); else render();
    };
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    inp.addEventListener('blur', () => finish(true));
  }

  // ---------- 绑定 ----------
  // v21：标签重命名（改成已有标签名 = 合并）
  async function renameTagFlow(anchor) {
    const name = anchor.dataset.tagRename;
    inlineInput(anchor, name, async (v) => {
      const to = String(v || '').trim();
      if (!to || to === name) { render(); return; }
      const r = await L().renameTag(name, to);
      if (r && r.ok) {
        if (state.tagFilter.has(name)) { state.tagFilter.delete(name); state.tagFilter.add(to); }
        await refresh();
        window.App && window.App.toast && window.App.toast('已重命名 ' + r.renamed + ' 条条目的标签');
      } else {
        window.App && window.App.toast && window.App.toast('重命名失败');
        render();
      }
    });
  }

  // v21：从所有条目上移除某个标签（两步确认）
  async function removeTagEverywhereFlow(anchor) {
    const name = anchor.dataset.tagDel;
    if (anchor.dataset.armed !== '1') {
      anchor.dataset.armed = '1';
      anchor.textContent = '确认?';
      setTimeout(() => {
        if (anchor.isConnected) { anchor.dataset.armed = '0'; anchor.textContent = '🗑'; }
      }, 4000);
      return;
    }
    const r = await L().removeTagEverywhere(name);
    if (r && r.ok) {
      state.tagFilter.delete(name);
      await refresh();
      window.App && window.App.toast && window.App.toast('已从 ' + r.removed + ' 条条目上移除标签');
    } else {
      window.App && window.App.toast && window.App.toast('移除失败');
    }
  }

  // ---------- v27：列表交互（单击选中 / 双击打开 / 多选 / 拖拽 / 右键） ----------
  function selectCard(key, e) {
    const mod = e && (e.ctrlKey || e.metaKey);
    const shift = e && e.shiftKey;
    if (mod) {
      if (state.selectedKeys.has(key)) state.selectedKeys.delete(key);
      else state.selectedKeys.add(key);
      state.selectedKey = key;
      markSelection(); renderDetail();
      return;
    }
    if (shift) {
      const list = visibleItems().filter((x) => !x.deletedAt).map((x) => x.key);
      const from = list.indexOf(state.selectedKey);
      const to = list.indexOf(key);
      if (from >= 0 && to >= 0) {
        state.selectedKeys.clear();
        for (let i = Math.min(from, to); i <= Math.max(from, to); i++) state.selectedKeys.add(list[i]);
        state.selectedKey = key;
        markSelection(); renderDetail();
        return;
      }
    }
    state.selectedKeys.clear();
    openDetail(key);
  }

  async function addKeyToCollection(key, collId) {
    const it = state.items.find((x) => x.key === key);
    if (!it || !collId) return;
    const ids = itemCollections(it).slice();
    if (ids.includes(collId)) {
      window.App && window.App.toast && window.App.toast('已经在收藏集里');
      return;
    }
    ids.push(collId);
    const r = await L().setCollections(key, ids);
    if (r) {
      await refresh();
      window.App && window.App.toast && window.App.toast('已加入收藏集「' + collName(collId) + '」');
    }
  }

  function renameCollectionFlow(id, anchor) {
    const c = state.collections.find((x) => x.id === id);
    if (!c || !anchor) return;
    inlineInput(anchor, c.name, async (v) => {
      const r = await L().renameCollection(id, v);
      if (r && r.ok) {
        await refresh();
        window.App && window.App.toast && window.App.toast('收藏集已重命名');
      } else {
        window.App && window.App.toast && window.App.toast('重命名失败');
        render();
      }
    });
  }

  // 颜色选择浮层：收藏集 / 标签共用
  const PALETTE = ['#8c3b2e', '#c2703c', '#c9a227', '#5f7d4f', '#3f7a8a', '#4a5d8a',
    '#7a4f8a', '#8b6b4a', '#a53a28', '#2f7d6d', '#6b6b6b'];
  let colorPop = null;

  function closeColorPop() {
    if (colorPop && colorPop.parentNode) colorPop.parentNode.removeChild(colorPop);
    colorPop = null;
  }

  function openColorPop(anchor, current, onPick) {
    closeColorPop();
    const pop = document.createElement('div');
    pop.className = 'lib-color-pop';
    pop.innerHTML = PALETTE.map((c) => '<button type="button" data-color="' + c + '" style="background:' + c + '" title="' + c + '"></button>').join('') +
      '<button type="button" class="none" data-color="" title="清除颜色"></button>';
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    const w = 160, h = 76;
    pop.style.left = Math.max(6, Math.min(r.left, window.innerWidth - w - 6)) + 'px';
    pop.style.top = Math.max(6, Math.min(r.bottom + 4, window.innerHeight - h - 6)) + 'px';
    colorPop = pop;
    pop.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-color]');
      if (!b) return;
      const color = b.dataset.color;
      closeColorPop();
      await onPick(color);
    });
    setTimeout(() => {
      const off = (ev) => { if (!pop.contains(ev.target)) { closeColorPop(); document.removeEventListener('mousedown', off, true); } };
      document.addEventListener('mousedown', off, true);
    }, 0);
  }

  // 卡片右键菜单
  let cardMenu = null;
  function closeCardMenu() {
    if (cardMenu && cardMenu.parentNode) cardMenu.parentNode.removeChild(cardMenu);
    cardMenu = null;
  }

  async function copyPlain(text, okText) {
    if (!text) return;
    try {
      const r = await window.pdfBridge.copyText(text);
      window.App && window.App.toast && window.App.toast((r && r.ok) ? (okText || '已复制') : '复制失败');
    } catch (_) {
      window.App && window.App.toast && window.App.toast('复制失败');
    }
  }

  function showCardMenu(x, y, key) {
    closeCardMenu();
    const it = state.items.find((v) => v.key === key);
    if (!it) return;
    const trashed = !!it.deletedAt;
    const menu = document.createElement('div');
    menu.className = 'ctx-menu lib-ctx';
    const keyName = citekeyOf(it);
    menu.innerHTML =
      (trashed ? '' : '<button data-act="open">打开阅读</button>' +
        '<button data-act="detail">条目详情</button>' +
        '<div class="ctx-sep"></div>' +
        '<button data-act="reveal">在文件夹中显示</button>' +
        '<button data-act="copy-cite">复制引用（' + esc((window.Cite && Cite.styleLabel(state.citeStyle)) || 'GB/T') + '）</button>' +
        '<button data-act="copy-key"' + (keyName ? '' : ' disabled') + '>复制引用键 ' + esc(keyName || '') + '</button>' +
        '<button data-act="copy-at"' + (keyName ? '' : ' disabled') + '>复制 [@key]</button>' +
        '<div class="ctx-sep"></div>' +
        '<button data-act="tag">添加标签…</button>') +
      '<button data-act="trash" class="' + (trashed ? '' : 'rm') + '">' + (trashed ? '从回收站还原' : '移入回收站') + '</button>';
    document.body.appendChild(menu);
    const w = menu.offsetWidth || 200, h = menu.offsetHeight || 220;
    menu.style.left = Math.max(6, Math.min(x, window.innerWidth - w - 6)) + 'px';
    menu.style.top = Math.max(6, Math.min(y, window.innerHeight - h - 6)) + 'px';
    cardMenu = menu;
    menu.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      closeCardMenu();
      if (act === 'open') openItem(key);
      else if (act === 'detail') openDetail(key);
      else if (act === 'reveal') {
        const r = await L().revealItem(key);
        if (!r || !r.ok) window.App && window.App.toast && window.App.toast('无法定位文件');
      } else if (act === 'copy-cite') {
        copyPlain(window.Cite ? Cite.format(it, state.citeStyle) : '', '引用已复制');
      } else if (act === 'copy-key') {
        copyPlain(citekeyOf(it), '引用键已复制');
      } else if (act === 'copy-at') {
        copyPlain('[@' + citekeyOf(it) + ']', '[@key] 已复制');
      } else if (act === 'tag') {
        openDetail(key);
        setTimeout(() => { if (el.ld.tagInput) el.ld.tagInput.focus(); }, 30);
      } else if (act === 'trash') {
        if (trashed) await restoreItem(key); else await trashItem(key);
      }
    });
  }

  function bind() {
    el = {
      root: $('library'), search: $('lib-search'), collections: $('lib-collections'),
      searches: $('lib-searches'), saveSearch: $('lib-save-search'),
      back: $('lib-back'),
      tagList: $('lib-tags'),
      newColl: $('lib-new-coll'), scopeTitle: $('lib-scope-title'), count: $('lib-count'),
      import: $('lib-import'), grid: $('lib-grid'), empty: $('lib-empty'),
      sort: $('lib-sort'), emptyTrash: $('lib-empty-trash'),
      ft: $('lib-ft'), bulk: $('lib-bulk'), bulkCount: $('lib-bulk-count'), selectAll: $('lib-select-all'),
      dup: $('lib-dup'), importRefs: $('lib-import-refs'), exportRefs: $('lib-export-refs'),
      settingsBtn: $('lib-settings'),
      settingsModal: $('settings-modal'), setTheme: $('set-theme'), setSort: $('set-sort'), setViewMode: $('set-view-mode'),
      setAutoIndex: $('set-auto-index'), setInvertPages: $('set-invert-pages'), setDataDir: $('set-data-dir'), setStatus: $('set-status'),
      setFtStatus: $('set-ft-status'), setIndex: $('set-index'), setReindex: $('set-reindex'),
      dupModal: $('dup-modal'), dupBody: $('dup-body'), dupStatus: $('dup-status'),
      bulkModal: $('bulk-modal'), bulkTitle: $('bulk-title'), bulkType: $('bulk-type'), bulkColl: $('bulk-add-coll'),
      bulkYear: $('bulk-year'), bulkPublication: $('bulk-publication'),
      bulkAddTags: $('bulk-add-tags'), bulkRemoveTags: $('bulk-remove-tags'), bulkStatus: $('bulk-status'),
      detail: $('lib-detail'), ld: {
        body: $('ld-body'),
        type: $('ld-type'), title: $('ld-title'), creators: $('ld-creators'), year: $('ld-year'),
        publication: $('ld-publication'), volume: $('ld-volume'), issue: $('ld-issue'), pages: $('ld-pages'),
        doi: $('ld-doi'), url: $('ld-url'), abstract: $('ld-abstract'),
        notes: $('ld-notes'), noteAdd: $('ld-note-add'),
        tags: $('ld-tags'), tagInput: $('ld-tag-input'), tagAdd: $('ld-tag-add'),
        colls: $('ld-colls'), attach: $('ld-attach'), dates: $('ld-dates'), status: $('ld-status'),
        fetch: $('ld-fetch'), fetchStatus: $('ld-fetch-status'),
        save: $('ld-save'), trash: $('ld-trash'), restore: $('ld-restore'),
        del: $('ld-delete'), close: $('ld-close'),
        citeStyle: $('ld-cite-style'), citeCopy: $('ld-cite-copy'),
        citeStatus: $('ld-cite-status'), citePreview: $('ld-cite-preview'),
        citekey: $('ld-citekey'), citekeyCopy: $('ld-citekey-copy'),
        citekeyAt: $('ld-citekey-at'), citekeyStatus: $('ld-citekey-status'),
        relations: $('ld-relations'), relSelect: $('ld-rel-select'), relAdd: $('ld-rel-add'),
      },
    };

    // 搜索框：每次按键都重画整张列表，条目一多就会卡。去抖一下（90ms），
    // 全文检索那边本来就�� 320ms 去抖。
    let searchTimer = null;
    el.search.addEventListener('input', () => {
      state.query = el.search.value;
      if (state.scope.type === 'search') state.scope = { type: 'all' };
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        renderGrid();
        renderSidebar();
      }, 90);
      scheduleFulltext();
    });
    el.import.addEventListener('click', importPdf);
    // 右键菜单 / 颜色浮层：点别处或滚动就收起
    document.addEventListener('mousedown', (e) => {
      if (cardMenu && !cardMenu.contains(e.target)) closeCardMenu();
    }, true);
    document.addEventListener('scroll', () => { closeCardMenu(); closeColorPop(); }, true);
    // v23：阅读笔记（新建 / 失焦保存 / 删除）
    if (el.ld.notes) {
      el.ld.notes.addEventListener('change', async (e) => {
        const box = e.target.closest('[data-note-id]');
        if (!box) return;
        const field = e.target.dataset.noteField;
        if (field !== 'title' && field !== 'text') return;
        const patch = {};
        patch[field] = e.target.value;
        const key = state.selectedKey;
        if (!key) return;
        await L().updateNote(key, box.dataset.noteId, patch);
        await reloadItemsQuiet();
        const it = state.items.find((x) => x.key === key);
        if (it) renderNotes(it);
      });
      el.ld.notes.addEventListener('click', async (e) => {
        const del = e.target.closest('.ld-note-del');
        if (!del) return;
        const box = del.closest('[data-note-id]');
        const key = state.selectedKey;
        if (!box || !key) return;
        await L().removeNote(key, box.dataset.noteId);
        await reloadItemsQuiet();
        const it = state.items.find((x) => x.key === key);
        renderNotes(it || { notes: [] });
      });
    }
    if (el.ld.noteAdd) {
      el.ld.noteAdd.addEventListener('click', async () => {
        const key = state.selectedKey;
        if (!key) return;
        const n = await L().addNote(key, { title: '', text: '' });
        await reloadItemsQuiet();
        const it = state.items.find((x) => x.key === key);
        if (it) renderNotes(it);
        if (n && el.ld.notes) {
          const box = el.ld.notes.querySelector('[data-note-id="' + n.id + '"] .ld-note-text');
          if (box) box.focus();
        }
      });
    }
    // v19：折叠分区（智能收藏集 / 标签）
    for (const btn of document.querySelectorAll('.lib-sec-toggle')) {
      btn.addEventListener('click', () => {
        const key = btn.dataset.sec;
        state.secOpen[key] = !state.secOpen[key];
        renderSecToggles();
      });
    }
    // v14：引用样式切换 + 复制引用
    if (el.ld.citeStyle) el.ld.citeStyle.addEventListener('change', () => {
      state.citeStyle = el.ld.citeStyle.value || 'gbt7714';
      renderCite(selectedItem(), false);
    });
    if (el.ld.citeCopy) el.ld.citeCopy.addEventListener('click', copyCitation);
    if (el.ld.citekeyCopy) el.ld.citekeyCopy.addEventListener('click', () => copyCitekey(false));
    if (el.ld.citekeyAt) el.ld.citekeyAt.addEventListener('click', () => copyCitekey(true));
    if (el.ld.relAdd) el.ld.relAdd.addEventListener('click', async () => {
      const it = selectedItem();
      const other = el.ld.relSelect && el.ld.relSelect.value;
      if (!it || !other) return;
      const r = await L().addRelation(it.key, other);
      if (r && r.ok) { await refresh(); el.ld.status.textContent = '已添加关联'; }
      else window.App && window.App.toast && window.App.toast('添加关联失败');
    });
    if (el.ld.relations) el.ld.relations.addEventListener('click', async (e) => {
      const open = e.target.closest('[data-rel-open]');
      if (open) { openDetail(open.dataset.relOpen); return; }
      const del = e.target.closest('[data-rel-remove]');
      if (del) {
        const it = selectedItem();
        if (!it) return;
        const r = await L().removeRelation(it.key, del.dataset.relRemove);
        if (r && r.ok) { await refresh(); el.ld.status.textContent = '已解除关联'; }
      }
    });
    // 表单一改，引用预览跟着变
    if (el.ld.body) {
      el.ld.body.addEventListener('input', () => {
        const it = selectedItem();
        if (it) renderCite(it, false);
      });
    }
    // 「返回阅读」：覆盖层是 absolute/inset:0，会盖住工具栏和标签栏，
    // 没有这个按钮就没有应用内的退路（空库时尤其明显）。
    if (el.back) el.back.addEventListener('click', () => hide());
    el.sort.addEventListener('change', () => {
      state.sort = el.sort.value;
      state.sortDir = '';
      state.sortTouched = true;
      renderGrid();
      renderSortHeads();
    });
    // 表头点击排序：同列再点切换升降序（Zotero 的列头行为）
    for (const btn of document.querySelectorAll('.lib-sort-h')) {
      btn.addEventListener('click', () => {
        const f = btn.dataset.sort;
        if (!f) return;
        if (state.sort === f) state.sortDir = (state.sortDir || 'asc') === 'asc' ? 'desc' : 'asc';
        else { state.sort = f; state.sortDir = 'asc'; }
        state.sortTouched = true;
        renderGrid();
        renderSortHeads();
      });
    }
    el.emptyTrash.addEventListener('click', emptyTrash);
    if (el.selectAll) el.selectAll.addEventListener('change', () => {
      const list = visibleItems().filter((x) => !x.deletedAt);
      if (el.selectAll.checked) for (const x of list) state.selectedKeys.add(x.key);
      else for (const x of list) state.selectedKeys.delete(x.key);
      renderGrid(); renderBulk();
    });
    if (el.saveSearch) el.saveSearch.addEventListener('click', saveCurrentSearch);
    if (el.searches) el.searches.addEventListener('click', async (e) => {
      const del = e.target.closest('[data-del-search]');
      if (del) {
        e.stopPropagation();
        await L().removeSearch(del.dataset.delSearch);
        if (state.scope.type === 'search' && state.scope.id === del.dataset.delSearch) state.scope = { type: 'all' };
        await refresh();
        return;
      }
      const b = e.target.closest('[data-search]');
      if (b) {
        const s = state.searches.find((x) => x.id === b.dataset.search);
        if (!s) return;
        state.scope = { type: 'search', id: s.id };
        state.query = s.query;
        el.search.value = s.query;
        render();
        scheduleFulltext();
      }
    });
    if (el.ft) el.ft.addEventListener('click', (e) => {
      const row = e.target.closest('[data-ft-key]');
      if (row) openItem(row.dataset.ftKey, +row.dataset.ftPage || 1);
    });
    if (el.dup) el.dup.addEventListener('click', openDuplicates);
    if (el.importRefs) el.importRefs.addEventListener('click', importRefs);
    if (el.exportRefs) el.exportRefs.addEventListener('click', exportRefs);
    if (el.settingsBtn) el.settingsBtn.addEventListener('click', openSettings);

    // 设置弹层
    if (el.settingsModal) {
      $('settings-close').addEventListener('click', closeSettings);
      $('set-close').addEventListener('click', closeSettings);
      $('set-save').addEventListener('click', saveSettings);
      $('set-change-dir').addEventListener('click', changeDataDir);
      $('set-open-dir').addEventListener('click', async () => {
        const r = await L().openDataDir();
        if (!r || !r.ok) setSettingsStatus('打开目录失败：' + ((r && r.error) || '未知错误'));
      });
      $('set-backup').addEventListener('click', doBackup);
      $('set-restore').addEventListener('click', doRestore);
      $('set-index').addEventListener('click', () => indexAll(false));
      $('set-reindex').addEventListener('click', () => indexAll(true));
      $('set-ft-clear').addEventListener('click', clearIndex);
      // v26：原来挂在「系统」菜单里的两项，现在从设置里发起
      const dflt = $('set-default-pdf');
      if (dflt) dflt.addEventListener('click', async () => {
        if (!window.pdfBridge || !window.pdfBridge.setDefaultPdfReader) return;
        const r = await window.pdfBridge.setDefaultPdfReader();
        if (r && r.action === 'copied') setSettingsStatus('程序路径已复制到剪贴板');
        else if (r && r.action === 'settings') setSettingsStatus('已打开 Windows 默认应用设置');
      });
      const dev = $('set-devtools');
      if (dev) dev.addEventListener('click', () => {
        if (window.pdfBridge && window.pdfBridge.openDevTools) window.pdfBridge.openDevTools();
      });
    }

    // 查重弹层
    if (el.dupModal) {
      $('dup-close').addEventListener('click', () => { el.dupModal.hidden = true; });
      $('dup-close2').addEventListener('click', () => { el.dupModal.hidden = true; });
      el.dupBody.addEventListener('click', (e) => {
        const b = e.target.closest('[data-dup-merge]');
        if (b) mergeDup(+b.dataset.dupMerge);
      });
    }

    // 批量编辑弹层
    if (el.bulkModal) {
      $('bulk-close').addEventListener('click', () => { el.bulkModal.hidden = true; });
      $('bulk-cancel').addEventListener('click', () => { el.bulkModal.hidden = true; });
      $('bulk-save').addEventListener('click', saveBulk);
      $('lib-bulk-edit').addEventListener('click', openBulk);
      $('lib-bulk-trash').addEventListener('click', bulkTrash);
      $('lib-bulk-clear').addEventListener('click', () => { state.selectedKeys.clear(); renderGrid(); renderBulk(); });
    }

    // 详情：DOI/arXiv 抓取
    if (el.ld.fetch) el.ld.fetch.addEventListener('click', fetchMetadata);

    // 侧栏：集合选择 / 删除（事件委托）
    el.collections.addEventListener('click', async (e) => {
      const colorBtn = e.target.closest('[data-coll-color]');
      if (colorBtn) {
        e.stopPropagation();
        const c = state.collections.find((x) => x.id === colorBtn.dataset.collColor);
        openColorPop(colorBtn, c ? c.color : '', async (color) => {
          await L().setCollectionColor(colorBtn.dataset.collColor, color || '');
          await refresh();
        });
        return;
      }
      const del = e.target.closest('[data-del]');
      if (del) {
        e.stopPropagation();
        await L().removeCollection(del.dataset.del);
        if (state.scope.type === 'coll' && state.scope.id === del.dataset.del) state.scope = { type: 'all' };
        await refresh();
        return;
      }
      const b = e.target.closest('[data-scope]');
      if (b) {
        const t = b.dataset.scope;
        resetEmptyArm();
        state.scope = t === 'coll' ? { type: 'coll', id: b.dataset.id } : { type: t };
        render();
      }
    });
    // 收藏集重命名：双击名字就地编辑（和 Zotero 一致）
    el.collections.addEventListener('dblclick', (e) => {
      const nameEl = e.target.closest('[data-coll-rename]');
      if (!nameEl) return;
      e.preventDefault();
      e.stopPropagation();
      renameCollectionFlow(nameEl.dataset.collRename, nameEl);
    });
    // 拖拽条目到收藏集
    el.collections.addEventListener('dragover', (e) => {
      const row = e.target.closest('[data-drop-coll]');
      if (!row) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      row.classList.add('drop-target');
    });
    el.collections.addEventListener('dragleave', (e) => {
      const row = e.target.closest('[data-drop-coll]');
      if (row) row.classList.remove('drop-target');
    });
    el.collections.addEventListener('drop', async (e) => {
      const row = e.target.closest('[data-drop-coll]');
      if (!row) return;
      e.preventDefault();
      e.stopPropagation();
      row.classList.remove('drop-target');
      const key = e.dataTransfer.getData('text/x-lib-key') || state.dragKey;
      state.dragKey = '';
      if (!key) return;
      await addKeyToCollection(key, row.dataset.dropColl);
    });

    el.newColl.addEventListener('click', () => inlineNewCollection());

    // v14：侧栏标签选择器（点标签筛选 / 清除筛选）
    if (el.tagList) el.tagList.addEventListener('click', (e) => {
      const clear = e.target.closest('[data-tag-clear]');
      if (clear) { state.tagFilter.clear(); render(); return; }
      const colorBtn = e.target.closest('[data-tag-color]');
      if (colorBtn) {
        e.stopPropagation();
        const name = colorBtn.dataset.tagColor;
        openColorPop(colorBtn, state.tagColors[name] || '', async (color) => {
          await L().setTagColor(name, color || '');
          await refresh();
        });
        return;
      }
      const ren = e.target.closest('[data-tag-rename]');
      if (ren) { e.stopPropagation(); renameTagFlow(ren); return; }
      const del = e.target.closest('[data-tag-del]');
      if (del) { e.stopPropagation(); removeTagEverywhereFlow(del); return; }
      const row = e.target.closest('[data-tag-filter]');
      if (row) toggleTagFilter(row.dataset.tagFilter);
    });

    // 卡片：打开 / 详情 / 改名 / 标签 / 回收站
    el.grid.addEventListener('click', async (e) => {
      const detailBtn = e.target.closest('[data-detail]');
      if (detailBtn) { openDetail(detailBtn.dataset.detail); return; }
      const trashBtn = e.target.closest('[data-trash]');
      if (trashBtn) { e.stopPropagation(); await trashItem(trashBtn.dataset.trash); return; }
      const restoreBtn = e.target.closest('[data-restore]');
      if (restoreBtn) { e.stopPropagation(); await restoreItem(restoreBtn.dataset.restore); return; }
      const delBtn = e.target.closest('[data-delete]');
      if (delBtn) {
        e.stopPropagation();
        const now = Date.now();
        if (now - deleteArmed < 4000 && delBtn.dataset.armed === '1') {
          deleteArmed = 0;
          await deleteItem(delBtn.dataset.delete);
        } else {
          deleteArmed = now;
          delBtn.dataset.armed = '1';
          delBtn.textContent = '确认删除';
          setTimeout(() => { deleteArmed = 0; if (delBtn.isConnected) { delBtn.dataset.armed = '0'; delBtn.textContent = '永久删除'; } }, 4000);
        }
        return;
      }
      const rmTag = e.target.closest('[data-rmtag]');
      if (rmTag) { await L().removeTag(rmTag.dataset.rmtag, rmTag.dataset.tag); await refresh(); return; }
      // v14：点卡片上的标签 = 按这个标签筛选（别顺手把 PDF 打开了）
      const tagFilter = e.target.closest('[data-tag-filter]');
      if (tagFilter) { e.stopPropagation(); toggleTagFilter(tagFilter.dataset.tagFilter); return; }
      const addTag = e.target.closest('[data-addtag]');
      if (addTag) { inlineInput(addTag, '', async (tag) => { await L().addTag(addTag.dataset.addtag, tag); await refresh(); }); return; }
      // 2026-10-21：点标题不再重命名（和整行一样进阅读）；重命名走详情面板标题字段
      if (e.target.closest('button') || e.target.closest('input') || e.target.closest('.lc-check')) return;
      const card = e.target.closest('.lib-card');
      if (card && card.dataset.key) selectCard(card.dataset.key, e);
    });

    // 双击打开（Zotero 的列表行为：单击选中，双击进阅读）
    el.grid.addEventListener('dblclick', (e) => {
      if (e.target.closest('button') || e.target.closest('input') || e.target.closest('.lc-check')) return;
      const card = e.target.closest('.lib-card[data-open]');
      if (card) openItem(card.dataset.open);
    });

    // 右键菜单
    el.grid.addEventListener('contextmenu', (e) => {
      const card = e.target.closest('.lib-card[data-key]');
      if (!card) return;
      e.preventDefault();
      if (!card.classList.contains('selected')) selectCard(card.dataset.key, {});
      showCardMenu(e.clientX, e.clientY, card.dataset.key);
    });

    // 拖拽到侧栏收藏集
    el.grid.addEventListener('dragstart', (e) => {
      const card = e.target.closest('.lib-card[data-open]');
      if (!card) { e.preventDefault(); return; }
      state.dragKey = card.dataset.key;
      try {
        e.dataTransfer.setData('text/x-lib-key', card.dataset.key);
        e.dataTransfer.setData('text/plain', card.dataset.key);
        e.dataTransfer.effectAllowed = 'copy';
      } catch (_) {}
    });
    el.grid.addEventListener('dragend', () => {
      state.dragKey = '';
      for (const r of el.collections.querySelectorAll('.drop-target')) r.classList.remove('drop-target');
    });

    // 批量选择复选框（change 与点击打开分区处理，避免点勾选也打开 PDF）
    el.grid.addEventListener('change', (e) => {
      const cb = e.target.closest('[data-select-key]');
      if (!cb) return;
      if (cb.checked) state.selectedKeys.add(cb.dataset.selectKey);
      else state.selectedKeys.delete(cb.dataset.selectKey);
      renderGrid(); renderBulk();
    });

    // 详情：关闭 / 保存 / 回收站
    el.ld.close.addEventListener('click', closeDetail);
    el.ld.save.addEventListener('click', saveDetail);
    el.ld.trash.addEventListener('click', async () => {
      const it = selectedItem(); if (!it) return;
      await trashItem(it.key);
      el.ld.status.textContent = '已移入回收站';
    });
    el.ld.restore.addEventListener('click', async () => {
      const it = selectedItem(); if (!it) return;
      await restoreItem(it.key);
      el.ld.status.textContent = '已还原';
    });
    el.ld.del.addEventListener('click', async () => {
      const it = selectedItem(); if (!it) return;
      const now = Date.now();
      if (now - deleteArmed < 4000 && el.ld.del.dataset.armed === '1') {
        deleteArmed = 0;
        el.ld.del.dataset.armed = '0';
        el.ld.del.textContent = '永久删除';
        await deleteItem(it.key);
      } else {
        deleteArmed = now;
        el.ld.del.dataset.armed = '1';
        el.ld.del.textContent = '确认永久删除';
        setTimeout(() => {
          if (el.ld.del.isConnected) { el.ld.del.dataset.armed = '0'; el.ld.del.textContent = '永久删除'; }
          deleteArmed = 0;
        }, 4000);
      }
    });

    // 详情标签：草稿式，点保存才落盘（避免加标签时冲掉正在编辑的元数据）
    el.ld.tagAdd.addEventListener('click', addDetailTag);
    el.ld.tagInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addDetailTag(); }
      else if (e.key === 'Escape') { el.ld.tagInput.value = ''; el.ld.tagInput.blur(); }
    });
    el.ld.tags.addEventListener('click', (e) => {
      const b = e.target.closest('[data-ld-rmtag]');
      if (!b) return;
      state.detailTags = state.detailTags.filter((t) => t !== b.dataset.ldRmtag);
      renderDetailTags(false);
      el.ld.status.textContent = '标签待保存';
    });

    // 详情附件动作（内容是动态渲染的，用委托）
    el.ld.attach.addEventListener('click', async (e) => {
      const it = selectedItem(); if (!it) return;
      if (e.target.closest('[data-ld-reveal]')) {
        const r = await L().revealItem(it.key);
        if (!r || !r.ok) window.App && window.App.toast && window.App.toast('无法定位：' + ((r && r.error) || '未知错误'));
      } else if (e.target.closest('[data-ld-relink]')) {
        const r = await L().relinkItem(it.key);
        if (r && r.ok) { await refresh(); el.ld.status.textContent = '附件已重新定位'; }
        else if (r && !r.canceled) window.App && window.App.toast && window.App.toast('重新定位失败：' + (r.error || '未知错误'));
      }
    });

    // 库内快捷键：Ctrl+F 搜标题/摘要；Esc 逐层关闭（弹窗 → 详情 → 整个库）
    // 注意：不能一上来就 if (!isOpen()) return —— 库已经收起、但设置弹窗还留在
    // 阅读器上时（loadPdf 会调 hide()），Esc 就再也关不掉那个弹窗了。
    document.addEventListener('keydown', (e) => {
      const modalOpen = (el.settingsModal && !el.settingsModal.hidden)
        || (el.dupModal && !el.dupModal.hidden)
        || (el.bulkModal && !el.bulkModal.hidden);
      if (!isOpen() && !modalOpen) return;
      if (e.ctrlKey && (e.key === 'f' || e.key === 'F')) {
        if (!isOpen()) return;
        e.preventDefault(); e.stopPropagation();
        el.search.focus(); el.search.select();
      } else if (isOpen() && !modalOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter')) {
        const t = e.target;
        const typing = t && (t.closest('input, textarea, select, [contenteditable="true"]'));
        if (typing || (e.key === 'Enter' && t && t.closest('button, a'))) return;
        if (e.key === 'Enter') {
          if (!state.selectedKey) return;
          e.preventDefault();
          openItem(state.selectedKey);
          return;
        }
        const list = visibleItems().filter((x) => !x.deletedAt);
        if (!list.length) return;
        e.preventDefault();
        let i = list.findIndex((x) => x.key === state.selectedKey);
        if (i < 0) i = e.key === 'ArrowDown' ? -1 : list.length;
        i = Math.max(0, Math.min(list.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
        state.selectedKey = list[i].key;
        markSelection(); renderDetail();
        const card = el.grid.querySelector('.lib-card.selected');
        if (card && card.scrollIntoView) card.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Escape') {
        if (cardMenu || colorPop) { e.preventDefault(); closeCardMenu(); closeColorPop(); return; }
        if (el.settingsModal && !el.settingsModal.hidden) { e.preventDefault(); closeSettings(); }
        else if (el.dupModal && !el.dupModal.hidden) { e.preventDefault(); el.dupModal.hidden = true; }
        else if (el.bulkModal && !el.bulkModal.hidden) { e.preventDefault(); el.bulkModal.hidden = true; }
        else if (state.selectedKey) { e.preventDefault(); closeDetail(); }
        else if (isOpen()) { e.preventDefault(); hide(); }   // Esc 收起整个库，回到阅读器
      }
    }, true);
  }

  function addDetailTag() {
    const t = el.ld.tagInput.value.trim();
    if (!t) return;
    if (!state.detailTags.includes(t)) state.detailTags.push(t);
    el.ld.tagInput.value = '';
    renderDetailTags(false);
    el.ld.status.textContent = '标签待保存';
  }

  function show() {
    el.root.hidden = false;
    refresh().then(() => {
      // 回到文献库时停在上次的位置（长列表里重新找很烦）
      if (state.listScroll) el.grid.scrollTop = state.listScroll;
    });
  }
  // 收起库时必须把子弹窗一起收掉：设置/查重/批量是独立的 fixed 节点（z-index 95），
  // 只藏根节点的话，它们会留在阅读器上面，遮住整页。
  // 收起库时记住列表滚动位置
  function hide() {
    if (el.grid) state.listScroll = el.grid.scrollTop;
    if (el.root) el.root.hidden = true;
    closeSettings();
    if (el.dupModal) el.dupModal.hidden = true;
    if (el.bulkModal) el.bulkModal.hidden = true;
    closeDetail();
  }
  function isOpen() { return el.root && !el.root.hidden; }

  function init() {
    if (inited) return; inited = true;
    bind();
    // 拖到库界面也能导入（支持一次多个 PDF）
    // 必须 stopPropagation：否则同一次 drop 还会冒泡到阅读器的 drop 处理器，
    // 那里会把第一个文件当「打开阅读」，库刚导入完就被覆盖层盖掉了。
    document.addEventListener('drop', (e) => {
      if (!isOpen()) return;
      e.preventDefault();
      e.stopPropagation();
      handleDrop(e);
    }, true);
    document.addEventListener('dragover', (e) => { if (isOpen()) { e.preventDefault(); e.stopPropagation(); } }, true);
    // 菜单里导入/恢复/切数据目录后，主进程会广播；库开着就立刻刷新
    if (window.pdfBridge && window.pdfBridge.onLibChanged) {
      window.pdfBridge.onLibChanged(() => { if (isOpen()) refresh(); });
    }
    loadSettings().then(() => refresh());
  }

  return { init, show, hide, refresh, isOpen, openDetail, closeDetail, openSettings };
})();
