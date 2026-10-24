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
  // v6：作者是结构化的。展示一律走 creators.js，别处不再自己拼字符串
  const creatorText = (list, sep) => (window.Creators ? window.Creators.displayList(list, sep) : '');
  const creatorSortKey = (list) => {
    if (!window.Creators) return '';
    const rows = window.Creators.normalizeCreators(list);
    return rows.length ? (rows[0].lastName || rows[0].firstName) : '';
  };
  let el = {};
  let state = {
    collections: [], searches: [], items: [], itemTypes: [], tagColors: {},
    scope: { type: 'all' }, query: '', sort: 'added', sortDir: '',
    selectedKey: null, detailTags: [], flash: '',
    selectedKeys: new Set(),
    annos: [],            // 标注条目化 —— 汇总起来的标注
    annoTags: {},         // 标注 id → 标签
    annoLoaded: false,
    annoFilter: { kinds: new Set(), colors: new Set() },  // v33：标注视图按类型 / 颜色筛选（多选，命中任一即可）
    tagFilter: new Set(),   // v14：标签选择器（多选，命中任一即可）
    citeStyle: 'gbt7714',   // v14：引用样式
    citekeys: new Map(),    // v27：条目 key → 确定性 citekey
    secOpen: { searches: false, tags: false },  // v19：进阶分区默认折叠（新手少看两眼）
    ft: { query: '', results: [], stats: null, loading: false, error: '', type: 'all', show: 20, total: 0, counts: {} },
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
    if (id === 'annotation') return '标注';
    const t = state.itemTypes.find((x) => x.id === id);
    return t ? t.label : '文档';
  };
  const isTrash = () => state.scope.type === 'trash';
  // 标注视图。标注不是条目，是「附在文件上的批注」汇总成的列表
  const isAnnoScope = () => state.scope.type === 'annotations';
  const ANNO_PREFIX = 'anno:';

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
    // v8：标签搬进标注对象层 annoMeta（{id:{tags,...}}）；旧库的 annoTags（{id:[tags]}）
    // 由数据层迁移进来，这里两种形态都读得动
    state.annoTags = s.annoMeta || s.annoTags || {};
    state.annoMeta = s.annoMeta || {};
    state.citekeys = (window.Cite && window.Cite.citekeys) ? window.Cite.citekeys(state.items) : new Map();
    if (state.selectedKey && !state.items.some((x) => x.key === state.selectedKey)) state.selectedKey = null;
    for (const k of [...state.selectedKeys]) {
      if (k.startsWith(ANNO_PREFIX)) {
        if (!state.annos.some((a) => ANNO_PREFIX + a.id === k)) state.selectedKeys.delete(k);
      } else if (!state.items.some((x) => x.key === k && !x.deletedAt)) state.selectedKeys.delete(k);
    }
    render();
    syncUndoButtons();
  }

  // 标注本体在 userData/annotations/<hash>.json，这里一次性读回来
  async function loadAnnos(force) {
    if (state.annoLoaded && !force) return;
    state.annoLoaded = true;
    const B = window.pdfBridge;
    if (!B || !B.listAnnotations) { state.annos = []; return; }
    try {
      const list = await B.listAnnotations();
      state.annos = Array.isArray(list) ? list : [];
    } catch (err) {
      console.warn('[library] annotations unavailable:', err && err.message ? err.message : err);
      state.annos = [];
    }
  }

  // ---------- 过滤 / 排序 ----------
  function itemCollections(it) { return it.collectionIds || []; }
  // 检索补强（2026-10-22）：支持 "短语"、-排除、title:/author:/tag: 等字段限定，
  // 变音折叠（cafe 命中 café）；解析与匹配都在 query.js（window.Query）。
  let lastQ = null, lastAst = null;
  function queryAst(q) {
    if (lastQ !== q) { lastQ = q; lastAst = window.Query ? window.Query.parseQuery(q) : null; }
    return lastAst;
  }
  function matchesQuery(it, q) {
    if (!q) return true;
    const ast = queryAst(q);
    if (!ast) {
      const hay = window.Query ? window.Query.itemHaystack(it) : String(it.title || '').toLowerCase();
      return hay.indexOf(q.toLowerCase()) >= 0;
    }
    return window.Query.matchLibraryItem(it, ast);
  }

  function scopeSearch() {
    return state.scope.type === 'search' ? state.searches.find((x) => x.id === state.scope.id) || null : null;
  }

  // 标注标签：v8 在标注对象层（{id:{tags}}），旧形态是直接的字符串数组
  function annoTagsOf(id) {
    const v = state.annoTags && state.annoTags[id];
    if (!v) return [];
    return Array.isArray(v) ? v : (v.tags || []);
  }

  // 标注 → 临时「条目」：标题是标注文字，来源是文献名，标签来自标注对象层
  function annoItem(a) {
    const id = a.id;
    return {
      key: ANNO_PREFIX + id,
      itemType: 'annotation',
      title: a.text || a.comment || '（无文字标注）',
      creators: [],
      year: '',
      publication: a.fileName || '',
      abstract: a.fileName || '',
      tags: annoTagsOf(id).slice(),
      collectionIds: [],
      page: a.page || 0,
      created: a.saved || 0,
      updated: a.saved || 0,
      deletedAt: 0,
      hasFile: true,
      _anno: a,
    };
  }
  function annoOf(item) {
    return (item && item._anno) ? item._anno : null;
  }

  function visibleItems() {
    // 标注视图里「条目」是临时拼出来的标注，搜索/排序/多选全部复用同一套逻辑
    if (isAnnoScope()) {
      let list = state.annos.map(annoItem);
      if (state.tagFilter.size) list = list.filter((x) => (x.tags || []).some((t) => state.tagFilter.has(t)));
      // v33：类型 / 颜色筛选（多选，命中任一即可；kind 是主进程给好的中文类型名）
      if (state.annoFilter.kinds.size) list = list.filter((x) => x._anno && state.annoFilter.kinds.has(x._anno.kind));
      if (state.annoFilter.colors.size) list = list.filter((x) => x._anno && state.annoFilter.colors.has(x._anno.color || ''));
      const q = state.query.trim().toLowerCase();
      if (q) list = list.filter((x) => matchesQuery(x, q));
      return sortItems(list);
    }
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
    else if (field === 'creator') cmp = (a, b) => creatorSortKey(a.creators).localeCompare(creatorSortKey(b.creators), 'zh-Hans-CN', { sensitivity: 'base' }) || byTitle(a, b);
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
    // 标注也是库里的一类东西（汇总所有文档的批注）
    html += collRow('annotations', '标注', state.annos.length, isAnnoScope());
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

  let gridWindow = null;
  function renderRows(list, scrollTop) {
    if (gridWindow) { gridWindow.destroy(); gridWindow = null; }
    if (list.length <= 240 || !window.IntersectionObserver) {
      el.grid.innerHTML = list.map(cardHtml).join('');
      return;
    }
    // Keep distant rows as measured placeholders. Event delegation and the data selection
    // model stay unchanged; only a few chunks need live DOM nodes at any one time.
    const chunkSize = 80, chunks = [], heights = new Map();
    const kind = it => it.itemType === 'annotation' ? 'annotation' : (it.deletedAt ? 'trash' : (it.attachment && !it.hasFile ? 'missing' : 'normal'));
    el.grid.innerHTML = '';
    const measure = document.createElement('div');
    measure.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;width:' + el.grid.clientWidth + 'px';
    el.grid.appendChild(measure);
    for (const it of list) if (!heights.has(kind(it))) {
      measure.innerHTML = cardHtml(it);
      heights.set(kind(it), measure.firstElementChild.getBoundingClientRect().height || 40);
    }
    measure.remove();
    const fragment = document.createDocumentFragment();
    for (let start = 0; start < list.length; start += chunkSize) {
      const rows = list.slice(start, start + chunkSize);
      const node = document.createElement('div');
      node.className = 'lib-chunk';
      node.style.height = rows.reduce((n, it) => n + heights.get(kind(it)), 0) + 'px';
      const chunk = { node, rows, mounted: false };
      node.__chunk = chunk;
      chunks.push(chunk); fragment.appendChild(node);
    }
    el.grid.appendChild(fragment);
    function mount(chunk) {
      if (chunk.mounted) return;
      chunk.node.innerHTML = chunk.rows.map(cardHtml).join('');
      chunk.node.style.height = '';
      chunk.mounted = true;
    }
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const chunk = entry.target.__chunk;
        if (entry.isIntersecting) mount(chunk);
        else if (chunk.mounted && !chunk.node.contains(document.activeElement) && !state.dragKey) {
          const height = chunk.node.getBoundingClientRect().height;
          chunk.node.style.height = height + 'px';
          chunk.node.replaceChildren(); chunk.mounted = false;
        }
      }
    }, { root: el.grid, rootMargin: '800px 0px' });
    // Mount the current viewport synchronously, including refresh at a saved scroll position.
    let top = 0;
    for (const chunk of chunks) {
      const height = parseFloat(chunk.node.style.height);
      if (top + height >= scrollTop - 800 && top <= scrollTop + el.grid.clientHeight + 800) mount(chunk);
      top += height; observer.observe(chunk.node);
    }
    let width = el.grid.clientWidth, resizeFrame = null;
    const resize = new ResizeObserver(() => {
      if (el.grid.clientWidth === width) return;
      width = el.grid.clientWidth;
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(renderGrid);
    });
    resize.observe(el.grid);
    gridWindow = {
      ensure(key) { const i = list.findIndex(it => it.key === key); if (i >= 0) mount(chunks[Math.floor(i / chunkSize)]); },
      destroy() { observer.disconnect(); resize.disconnect(); cancelAnimationFrame(resizeFrame); },
    };
  }

  function renderGrid() {
    const list = visibleItems();
    const saved = scopeSearch();
    el.scopeTitle.textContent =
      state.scope.type === 'all' ? '全部条目' :
      state.scope.type === 'uncollected' ? '未分类' :
      state.scope.type === 'trash' ? '回收站' :
      state.scope.type === 'annotations' ? '标注' :
      state.scope.type === 'search' ? ('智能收藏集：' + (saved ? saved.name : '')) :
      collName(state.scope.id);
    el.count.textContent = isAnnoScope() ? (list.length + ' 条标注') : (list.length + ' 条');
    el.empty.hidden = list.length !== 0;
    el.empty.textContent = isTrash() ? '回收站是空的。'
      : isAnnoScope() ? (state.annos.length ? '没有符合筛选条件的标注。' : '还没有标注。在文档里选中文字做高亮 / 批注，或加一条便签，这里就会出现。')
      : (state.query.trim() || saved) ? '没有匹配的条目。'
      : '还没有条目。点右上角「添加文档」，或把 PDF / Word / PPT / Excel / Markdown 等文件拖进来。';
    if (el.selectAll) {
      const checked = list.filter((x) => !x.deletedAt && state.selectedKeys.has(x.key)).length;
      el.selectAll.checked = list.length > 0 && checked === list.length;
      el.selectAll.indeterminate = checked > 0 && checked < list.length;
      el.selectAll.disabled = isTrash() || !list.length;
    }
    // 标注视图不是条目表格，列头和搜索提示都换一套
    if (el.columns) el.columns.hidden = isAnnoScope();
    if (el.annoFilter) {
      el.annoFilter.hidden = !isAnnoScope();
      if (isAnnoScope()) renderAnnoFilter();
    }
    // placeholder 别塞语法说明：输入框只有 190px 宽，长文案会被截断（用户看到的"文字被切断"）
    if (el.search) {
      el.search.placeholder = isAnnoScope() ? '搜索标注文字…' : '搜索标题 / 作者 / 全文…';
      el.search.title = '检索语法："短语" 精确匹配 · -词 排除 · OR（或）· ( ) 分组 · title:/author:/tag:/year: 等字段限定';
    }
    const keepTop = el.grid.scrollTop;
    renderRows(list, keepTop);
    el.grid.scrollTop = keepTop;
  }

  // v33：标注视图筛选条 —— 类型（主进程给好的中文类型名，按固定顺序展示）+ 颜色圆点。
  // 多选、命中任一即可；出现过的类型 / 颜色才显示，避免一排空筛选。
  const ANNO_KIND_ORDER = ['高亮', '摘录', '批注', '下划线', '手绘', '文字', '便签', '图片', '矩形', '箭头', '直线', '选区'];
  function renderAnnoFilter() {
    if (!el.annoFilter) return;
    const kinds = new Map();   // kind → 数量
    const colors = new Map();  // color → 数量
    for (const a of state.annos) {
      const k = a.kind || '标注';
      kinds.set(k, (kinds.get(k) || 0) + 1);
      const c = a.color || '';
      if (c) colors.set(c, (colors.get(c) || 0) + 1);
    }
    const f = state.annoFilter;
    const kindList = [...kinds.keys()].sort((a, b) => {
      const ia = ANNO_KIND_ORDER.indexOf(a), ib = ANNO_KIND_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    const colorList = [...colors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
    const kindChips = kindList.map((k) =>
      '<button class="af-chip' + (f.kinds.has(k) ? ' on' : '') + '" data-anno-kind="' + esc(k) + '">' +
      esc(k) + ' <span class="af-n">' + kinds.get(k) + '</span></button>').join('');
    const colorChips = colorList.map(([c, n]) =>
      '<button class="af-dot' + (f.colors.has(c) ? ' on' : '') + '" data-anno-color="' + esc(c) + '" ' +
      'title="颜色 ' + esc(c) + ' · ' + n + ' 条"><span class="af-dotc" style="background:' + esc(c) + '"></span>' +
      '<span class="af-n">' + n + '</span></button>').join('');
    const clear = (f.kinds.size || f.colors.size)
      ? '<button class="af-clear" data-anno-clear="1">清除筛选</button>' : '';
    el.annoFilter.innerHTML = (kindChips ? '<span class="af-lbl">类型</span>' + kindChips : '') +
      (colorChips ? '<span class="af-lbl">颜色</span>' + colorChips : '') + clear;
  }

  // 条目渲染成「学术表格」的一行：标题 / 作者·年份·来源 / 类型 / 收藏集 / 标签 / 操作
  // 类名保持不变（lib-card / lctitle / lctype / lcprog / lccoll…），探针与事件委托都依赖它们。
  function cardHtml(it) {
    // 标注是「附在文件上的批注」，不是条目：单独一套行样式 + 打开/标签两个动作
    if (it.itemType === 'annotation') return annoCardHtml(it);
    const trashed = !!it.deletedAt;
    const selected = it.key === state.selectedKey;
    const picked = state.selectedKeys.has(it.key);
    // 当前正在读的那篇，标一下（回库时一眼知道自己在哪）
    const cur = !!(window.App && App.state.filePath && it.attachment
      && it.attachment.path && it.attachment.path === App.state.filePath);
    const check = trashed ? '' : '<label class="lc-check" title="选择条目"><input type="checkbox" data-select-key="' + esc(it.key) + '"' + (picked ? ' checked' : '') + ' /></label>';
    const meta = [];
    if (it.creators && it.creators.length) meta.push(esc(creatorText(it.creators)));
    if (it.year) meta.push(esc(it.year));
    if (it.publication) meta.push(esc(it.publication));
    // v9：独立笔记没有作者/年份，摘要就是正文前几十个字
    const isNoteItem = it.itemType === 'note' && !it.attachment;
    const missingFile = !!(it.attachment && it.attachment.path && !it.hasFile);
    if (isNoteItem) {
      const body = ((it.notes || [])[0] || {}).text || it.note || '';
      const flat = String(body).replace(/\s+/g, ' ').trim();
      if (flat) meta.push(esc(flat.length > 80 ? flat.slice(0, 80) + '…' : flat));
    }
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
    const titleAttr = trashed
      ? ''
      : (isNoteItem ? ' title="单击选中，双击编辑笔记"' : ' title="单击选中，双击打开阅读"');
    const tagAdd = trashed ? '' : '<span class="lc-addtag" data-addtag="' + esc(it.key) + '" title="加标签">＋</span>';
    const actions = trashed
      ? '<button data-detail="' + esc(it.key) + '">详情</button>' +
        '<button data-restore="' + esc(it.key) + '">还原</button>' +
        '<button class="rm" data-delete="' + esc(it.key) + '">永久删除</button>'
      : (isNoteItem
        // 笔记没有附件，"编辑"就是打开全屏编辑器
        ? '<button data-open-note="' + esc(it.key) + '">编辑</button>' +
          '<button class="rm" data-trash="' + esc(it.key) + '">回收站</button>'
        : '<button data-detail="' + esc(it.key) + '">详情</button>' +
          '<button class="rm" data-trash="' + esc(it.key) + '">回收站</button>');
    const note = trashed
      ? '<div class="lcpath">在回收站中 · 磁盘文件未被删除</div>'
      : (missingFile ? '<div class="lcpath">文件已移动或删除 · 可在详情里重新定位</div>' : '');
    return '<div class="lib-card' + (selected ? ' selected' : '') + (picked ? ' picked' : '') + (cur ? ' current' : '')
      + (missingFile ? ' missing' : '') + '" data-key="' + esc(it.key) + '"' + openAttr +
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

  // 标注一行：勾选 / 标注文字 / 出处（文献名 · 页码 · 类型）/ 标签 / 打开
  function annoCardHtml(it) {
    const a = annoOf(it) || {};
    const picked = state.selectedKeys.has(it.key);
    const tags = (it.tags || []).map((t) => {
      const color = (state.tagColors && state.tagColors[t]) || '';
      return '<span class="lctag" data-tag-filter="' + esc(t) + '" title="按这个标签筛选">' +
        (color ? '<span class="tcolor" style="background:' + esc(color) + '"></span>' : '') + esc(t) +
        '<span class="tagdel" data-rmtag="' + esc(it.key) + '" data-tag="' + esc(t) + '" title="移除标签">×</span></span>';
    }).join('');
    // 阶段二：标注是库里的对象 —— 显示所属条目，可编辑文字 / 批注
    const parent = a.itemKey ? state.items.find((x) => x.key === a.itemKey) : null;
    const owner = parent
      ? '<span class="lcprog anno-owner" data-anno-item="' + esc(a.itemKey) + '" title="打开所属条目">' + esc(parent.title || '(无标题)') + '</span>'
      : (a.itemTitle ? '<span class="lcprog">' + esc(a.itemTitle) + '</span>' : '');
    const src = esc(a.fileName || '') + (a.page ? ' · 第 ' + a.page + ' 页' : '') + ' · ' + esc(a.kind || '标注');
    return '<div class="lib-card lib-anno' + (picked ? ' picked' : '') + '" data-key="' + esc(it.key) + '">' +
      '<label class="lc-check" title="选择标注"><input type="checkbox" data-select-key="' + esc(it.key) + '"' + (picked ? ' checked' : '') + ' /></label>' +
      '<div class="lctitle" data-anno-open="' + esc(it.key) + '" title="打开到这一页">' + esc(it.title) + '</div>' +
      '<div class="lcmeta">' + src + '</div>' +
      '<div class="lcmeta2"><span class="lctype">' + (a.color ? '<span class="af-dotc" style="background:' + esc(a.color) + '" title="标注颜色 ' + esc(a.color) + '"></span>' : '') + '标注</span>' + (a.comment ? '<span class="lcprog">有批注</span>' : '') + owner + '</div>' +
      '<div class="lccolls"></div>' +
      '<div class="lctags">' + tags + '<span class="lc-addtag" data-addtag="' + esc(it.key) + '" title="加标签">＋</span></div>' +
      '<div class="lcbar">' +
        '<button data-anno-open="' + esc(it.key) + '">打开</button>' +
        '<button data-anno-edit="' + esc(it.key) + '" title="改标注文字 / 批注">编辑</button>' +
      '</div>' +
      '</div>';
  }

  // ---------- 标注 ----------
  // 打开一条标注 = 打开它所在的文件并跳到那一页
  async function openAnno(key) {
    const it = visibleItems().find((x) => x.key === key);
    const a = annoOf(it);
    if (!a) return;
    const parent = state.items.find((x) => x.attachment && x.attachment.path === a.path);
    if (parent) {
      const res = await L().openItem(parent.key, a.page);
      if (!res || !res.ok) {
        window.App && window.App.toast && window.App.toast('打开失败：' + ((res && res.error) || '未知错误'));
        return;
      }
      hide();
      if (typeof window.__libOpen === 'function') window.__libOpen(res);
      return;
    }
    // 不在文献库里的文件：直接按路径打开
    if (window.pdfBridge && window.pdfBridge.openPath) {
      hide();
      window.pdfBridge.openPath(a.path);
    }
  }

  // ---------- 编辑标注（阶段二：标注是库里的对象，可改文字 / 批注） ----------
  let annoEditKey = null;
  function annoEditSrc(a) {
    return esc((a.fileName || '') + (a.page ? ' · 第 ' + a.page + ' 页' : '') + ' · ' + (a.kind || '标注'));
  }
  function openAnnoEdit(key) {
    const it = visibleItems().find((x) => x.key === key);
    const a = annoOf(it);
    if (!a) return;
    annoEditKey = key;
    const m = $('anno-edit-modal');
    $('anno-edit-src').innerHTML = '出处：' + annoEditSrc(a);
    $('anno-edit-text').value = a.text || '';
    $('anno-edit-comment').value = a.comment || '';
    $('anno-edit-color').value = /^#[0-9a-f]{6}$/i.test(a.color || '') ? a.color : '#ffd54f';
    $('anno-edit-status').textContent = '';
    m.hidden = false;
    setTimeout(() => $('anno-edit-text').focus(), 30);
  }
  function closeAnnoEdit() {
    annoEditKey = null;
    const m = $('anno-edit-modal');
    if (m) m.hidden = true;
  }
  async function saveAnnoEdit() {
    if (!annoEditKey) return;
    const it = visibleItems().find((x) => x.key === annoEditKey);
    const a = annoOf(it);
    if (!a) { closeAnnoEdit(); return; }
    const patch = {
      text: String($('anno-edit-text').value || ''),
      comment: String($('anno-edit-comment').value || ''),
    };
    const color = String($('anno-edit-color').value || '');
    if (/^#[0-9a-f]{6}$/i.test(color)) patch.color = color;
    const r = await window.pdfBridge.updateAnno(a.id, patch);
    if (!r || !r.ok) {
      $('anno-edit-status').textContent = '保存失败：' + ((r && r.error) || '标注可能已被删除');
      return;
    }
    await loadAnnos(true);
    await refresh();
    closeAnnoEdit();
    window.App && window.App.toast && window.App.toast('标注已更新');
  }

  // 选中的标注 → Markdown（Zotero 的「标注 → 笔记」闭环）
  function selectedAnnos() {
    return state.annos.filter((a) => state.selectedKeys.has(ANNO_PREFIX + a.id));
  }

  function annoMarkdown(list) {
    const lines = [];
    for (const a of list) {
      const body = (a.text || a.comment || '').trim();
      if (!body) continue;
      const src = (a.fileName || '') + (a.page ? ' · 第 ' + a.page + ' 页' : '');
      lines.push('> ' + body.replace(/\n+/g, '\n> '));
      lines.push('> —— ' + src);
      lines.push('');
    }
    return lines.join('\n');
  }

  async function exportAnnos() {
    const list = selectedAnnos();
    if (!list.length) return;
    const text = annoMarkdown(list);
    if (!text.trim()) {
      window.App && window.App.toast && window.App.toast('选中的标注没有文字');
      return;
    }
    if (!window.pdfBridge || !window.pdfBridge.saveText) return;
    const res = await window.pdfBridge.saveText({
      text,
      format: 'markdown',
      defaultName: 'Trove-标注-' + new Date().toISOString().slice(0, 10),
    });
    if (res && res.ok) {
      window.App && window.App.toast && window.App.toast('已导出 ' + list.length + ' 条标注');
      if (el.annoStatus) el.annoStatus.textContent = '已保存：' + res.path;
    } else if (res && !res.canceled) {
      window.App && window.App.toast && window.App.toast('导出失败：' + (res.error || '未知错误'));
    }
  }

  // ---------- 从标注生成笔记（v8 阶段二：带页面截图） ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitUntil(fn, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < (ms || 8000)) { if (fn()) return true; await sleep(80); }
    return !!fn();
  }

  // 确保标注所在文件已打开并渲染到那一页（没开就借用阅读器打开）
  async function ensureDocForAnno(pathStr, page) {
    const App = window.App;
    if (!App) return false;
    if (App.state.filePath === pathStr && App.state.pdfDoc) {
      if (!App.state.rendered.get(page)) {
        try { App.scrollToPage(page); } catch (_) {}
      }
      return waitUntil(() => App.state.rendered.get(page), 15000);
    }
    const it = state.items.find((x) => x.attachment && x.attachment.path === pathStr);
    if (!it) return false;
    const res = await L().openItem(it.key, page);
    if (!res || !res.ok) return false;
    hide();
    if (typeof window.__libOpen === 'function') window.__libOpen(res);
    const ok = await waitUntil(() => App.state.filePath === pathStr && App.state.pdfDoc, 20000);
    if (!ok) return false;
    return waitUntil(() => App.state.rendered.get(page), 20000);
  }

  // 等标注数据从磁盘恢复，并按 id 取出形状
  async function shapesByIds(page, ids) {
    const App = window.App;
    const want = new Set(ids);
    const pick = () => {
      const arr = (App.state.annos && App.state.annos.get(page)) || [];
      const hit = arr.filter((sh) => sh && want.has(sh.id));
      return hit.length ? hit : null;
    };
    if (!pick()) await waitUntil(() => !!pick(), 8000);
    return pick() || [];
  }

  async function notesFromSelectedAnnos() {
    const sel = selectedAnnos();
    if (!sel.length) {
      window.App && window.App.toast && window.App.toast('先选中要生成笔记的标注');
      return;
    }
    // 一次只处理同一篇文档、同一页的标注（跨页截图拼一起没有意义）
    const a0 = sel[0];
    const same = sel.filter((a) => a.path === a0.path && a.page === a0.page);
    const parent = state.items.find((x) => x.key === a0.itemKey)
      || state.items.find((x) => x.attachment && x.attachment.path === a0.path);
    if (!parent) {
      window.App && window.App.toast && window.App.toast('这些标注不在文献库里，无法生成笔记');
      return;
    }
    if (el.annoStatus) el.annoStatus.textContent = '正在截取页面…';
    const ready = await ensureDocForAnno(a0.path, a0.page);
    if (!ready) {
      window.App && window.App.toast && window.App.toast('打开原文档失败，没能生成截图');
      return;
    }
    const shapes = await shapesByIds(a0.page, same.map((a) => a.id));
    let dataUrl = '';
    try {
      const canvas = await window.App.renderAnnoSnapshot(a0.page, shapes);
      if (canvas) dataUrl = canvas.toDataURL('image/png');
    } catch (_) {}
    const text = same
      .map((a) => [a.text, a.comment].filter(Boolean).join(' — '))
      .filter(Boolean)
      .join('\n\n');
    const r = await window.pdfBridge.noteFromAnno({
      itemKey: parent.key,
      title: '标注 · 第 ' + a0.page + ' 页',
      text,
      dataUrl,
      annoIds: same.map((a) => a.id),
    });
    if (!r || !r.ok) {
      window.App && window.App.toast && window.App.toast('生成笔记失败：' + ((r && r.error) || '未知错误'));
      return;
    }
    await loadAnnos(true);
    show();                           // 回到文献库，让用户看到刚生成的笔记
    await refresh();
    state.selectedKey = parent.key;
    render();
    window.App && window.App.toast && window.App.toast('已生成笔记（带页面截图）' + (dataUrl ? '' : '，但截图失败'));
  }

  async function tagSelectedAnnos() {
    const ids = selectedAnnos().map((a) => a.id);
    const raw = el.annoTagInput ? el.annoTagInput.value.trim() : '';
    const tags = raw.split(/[,，;；]/).map((x) => x.trim()).filter(Boolean);
    if (!ids.length || !tags.length) {
      window.App && window.App.toast && window.App.toast('先选标注，再写标签');
      return;
    }
    const r = await window.pdfBridge.addAnnoTags(ids, tags);
    if (el.annoTagInput) el.annoTagInput.value = '';
    await refresh();
    window.App && window.App.toast && window.App.toast('已给 ' + (r.updated || 0) + ' 条标注加上标签');
  }

  function renderBulk() {
    if (!el.bulk) return;
    const n = state.selectedKeys.size;
    el.bulk.hidden = n === 0 || isTrash();
    if (el.bulkCount) el.bulkCount.textContent = '已选 ' + n + ' 项';
    // 标注视图用另一套批量动作（加标签 / 导出标注）
    const anno = isAnnoScope();
    if (el.bulkEdit) el.bulkEdit.hidden = anno;
    if (el.bulkBib) el.bulkBib.hidden = anno;
    if (el.bulkTrash) el.bulkTrash.hidden = anno;
    if (el.bulkFetch) el.bulkFetch.hidden = anno;
    const bulkRename = $('lib-bulk-rename');
    if (bulkRename) bulkRename.hidden = anno;
    if (el.annoTools) el.annoTools.hidden = !anno;
  }

  // ---------- 库级全文检索结果 ----------
  // v33：结果面板 = 类型切换（全部/文献/正文/批注/笔记）+ 分页。
  // 首次拉 FT_PAGE 条（主进程默认 120），界面先显示 FT_STEP 条，「展开更多」逐步放行；
  // 已载入的看完了但主进程还有（total > 已载入），再按 offset 续拉，不整段重来。
  const FT_PAGE = 120;
  const FT_STEP = 20;
  const FT_TYPES = [
    ['item', '文献'], ['fulltext', '正文'], ['annotation', '批注'], ['note', '笔记'],
  ];

  function ftFiltered() {
    const list = state.ft.results || [];
    return state.ft.type === 'all' ? list : list.filter((r) => (r.type || 'fulltext') === state.ft.type);
  }

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
    const counts = state.ft.counts || {};
    const total = state.ft.total || list.length;
    // 类型过滤粘在会话上：这次搜索没有该类型时自动回「全部」，避免空面板
    if (state.ft.type !== 'all' && !counts[state.ft.type]) state.ft.type = 'all';
    const chips = ['<button class="lib-ft-chip' + (state.ft.type === 'all' ? ' on' : '') + '" data-ft-type="all">全部 ' + total + '</button>']
      .concat(FT_TYPES.filter(([k]) => counts[k]).map(([k, label]) =>
        '<button class="lib-ft-chip' + (state.ft.type === k ? ' on' : '') + '" data-ft-type="' + k + '">' + label + ' ' + counts[k] + '</button>'))
      .join('');
    const filtered = ftFiltered();
    const showN = Math.min(state.ft.show || FT_STEP, filtered.length);
    const more = showN < filtered.length || list.length < total
      ? '<button class="lib-ft-more" data-ft-more="1">展开更多（已显示 ' + showN + ' / 共 ' + total + ' 处）</button>'
      : '';
    el.ft.innerHTML = '<div class="lib-ft-head"><span class="lib-ft-title">全文检索：“' + esc(q) + '” · 共 ' + total + ' 处命中</span>' +
      '<span class="ld-hint">全文 / 摘录 / 批注 / 笔记合并搜索，按相关性排序；支持 "短语"、-排除、title: 等字段限定</span></div>' +
      '<div class="lib-ft-chips">' + chips + '</div>' +
      filtered.slice(0, showN).map((r) => {
        const kind = r.type || 'fulltext';
        const label = r.label || (kind === 'note' ? '笔记' : kind === 'annotation' ? '批注' : kind === 'item' ? '条目' : '全文');
        return '<button class="lib-ft-row" data-ft-key="' + esc(r.key) + '" data-ft-page="' + (r.page || 1) + '"' +
          (r.noteId ? ' data-ft-note="' + esc(r.noteId) + '"' : '') + '>' +
          '<span class="lib-ft-type ' + esc(kind) + '">' + esc(label) + '</span>' +
          '<span class="lib-ft-doc">' + esc(r.title || '(无标题)') + '</span>' +
          '<span class="lib-ft-pg">P' + (r.page || '?') + '</span>' +
          '<span class="lib-ft-snip">' + esc(r.snippet || '') + '</span>' +
          '</button>';
      }).join('') + more;
  }

  function scheduleFulltext() {
    clearTimeout(ftTimer);
    ftTimer = setTimeout(runFulltext, 320);
  }

  async function runFulltext() {
    if (!L() || !L().searchFull) return;
    const q = state.query.trim();
    if (!q || isTrash()) {
      state.ft = { query: q, results: [], stats: null, loading: false, error: '', type: 'all', show: FT_STEP, total: 0, counts: {} };
      renderFt();
      return;
    }
    state.ft = { query: q, results: [], stats: state.ft.stats, loading: true, error: '', type: state.ft.type || 'all', show: FT_STEP, total: 0, counts: {} };
    renderFt();
    try {
      const r = await L().searchFull(q, { limit: FT_PAGE });
      if (state.query.trim() !== q) return;
      state.ft = {
        query: q, results: (r && r.results) || [], stats: (r && r.stats) || null,
        total: (r && r.total) || ((r && r.results) || []).length,
        counts: (r && r.counts) || {},
        loading: false, error: (r && r.ok === false) ? (r.error || '检索失败') : '',
        type: state.ft.type, show: FT_STEP,
      };
    } catch (err) {
      state.ft = { query: q, results: [], stats: null, loading: false, error: '检索失败：' + (err && err.message ? err.message : err), type: 'all', show: FT_STEP, total: 0, counts: {} };
    }
    renderFt();
  }

  // 「展开更多」：先放行已载入的下一批；已载入看完而主进程还有，就按 offset 续拉一页
  async function ftMore() {
    const ft = state.ft;
    if (ft.loading) return;
    const filtered = ftFiltered();
    if (ft.show < filtered.length) {
      ft.show += FT_STEP;
      renderFt();
      return;
    }
    if (!L() || !L().searchFull) return;
    if ((ft.results || []).length >= (ft.total || 0)) return;
    const q = ft.query;
    ft.loading = true;
    try {
      const r = await L().searchFull(q, { offset: (ft.results || []).length, limit: FT_PAGE });
      if (state.ft.query !== q || state.query.trim() !== q) { ft.loading = false; return; }
      if (r && r.ok !== false) {
        ft.results = (ft.results || []).concat((r && r.results) || []);
        ft.total = (r && r.total) || ft.total;
        ft.counts = (r && r.counts) || ft.counts;
        ft.show += FT_STEP;
      }
    } catch (_) { /* 续拉失败保持现状，用户可重点一次 */ }
    ft.loading = false;
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

  // v8：条目详情里的标注列表（标注是库对象，从条目这一侧也能看见 / 跳回原页）
  function annosOfItem(it) {
    const path = (it.attachment && it.attachment.path) || '';
    return (state.annos || []).filter((a) => {
      const m = state.annoMeta && state.annoMeta[a.id];
      if (m && m.itemKey) return m.itemKey === it.key;
      return path && a.path === path;
    });
  }
  function renderDetailAnnos(it) {
    if (!el.ld.annos) return;
    const list = annosOfItem(it);
    if (!list.length) {
      el.ld.annos.innerHTML = '<div class="ld-hint">这篇文献上还没有标注。在阅读器里选中文字高亮，或画点什么。</div>';
      return;
    }
    el.ld.annos.innerHTML = list
      .slice()
      .sort((a, b) => (a.page || 0) - (b.page || 0))
      .map((a) => {
        const body = (a.text || a.comment || '').trim();
        const short = body.length > 90 ? body.slice(0, 90) + '…' : body;
        return '<button class="ld-anno" data-ld-anno-page="' + (a.page || 1) + '">' +
          '<span class="ld-anno-kind">' + esc(a.kind || '标注') + '</span>' +
          '<span class="ld-anno-pg">P' + (a.page || '?') + '</span>' +
          '<span class="ld-anno-text">' + esc(short || '（无文字）') + '</span>' +
          '</button>';
      }).join('');
  }

  // ---------- 撤销 / 重做（v9） ----------
  async function doUndo(isRedo) {
    if (!L() || (isRedo ? !L().redo : !L().undo)) return;
    let r = null;
    try { r = await (isRedo ? L().redo() : L().undo()); } catch (err) { r = { ok: false, error: err && err.message }; }
    await refresh();
    if (!r || !r.ok) {
      window.App && window.App.toast && window.App.toast((r && r.error) || (isRedo ? '没有可重做的操作' : '没有可撤销的操作'));
    } else {
      window.App && window.App.toast && window.App.toast((isRedo ? '已重做：' : '已撤销：') + (r.desc || ''));
      // 撤销可能把当前选中的条目删掉了
      if (state.selectedKey && !state.items.some((x) => x.key === state.selectedKey)) closeDetail();
    }
    syncUndoButtons();
  }
  function syncUndoButtons() {
    if (!L() || !L().undoInfo) return;
    L().undoInfo().then((info) => {
      if (!info) return;
      if (el.undo) {
        el.undo.disabled = !info.canUndo;
        el.undo.title = info.canUndo ? '撤销：' + info.undoDesc + '（Ctrl+Z）' : '没有可撤销的操作';
      }
      if (el.redo) {
        el.redo.disabled = !info.canRedo;
        el.redo.title = info.canRedo ? '重做：' + info.redoDesc + '（Ctrl+Shift+Z / Ctrl+Y）' : '没有可重做的操作';
      }
    }).catch(() => {});
  }

  // v9：独立笔记条目（Zotero 的 standalone note）—— 建一条 itemType:'note' 的条目，正文在 notes[0]
  async function newNoteItem() {
    if (!L() || !L().newNote) return;
    const r = await L().newNote({});
    if (!r || !r.ok || !r.item) {
      window.App && window.App.toast && window.App.toast('新建笔记失败');
      return;
    }
    state.scope = { type: 'all' };
    state.tagFilter.clear();
    state.query = '';
    if (el.search) el.search.value = '';
    await refresh();
    // 只标记选中，不调 render()：render 会顺带把右侧详情栏打开
    state.selectedKey = r.item.key;
    state.selectedKeys.clear();
    markSelection();
    // 新建笔记直接进全屏编辑器：像打开一份文档一样，落笔就能写
    await openNoteEditor(r.item.key);
  }

  // ---------- 独立笔记的全屏 Markdown 编辑器（v9.6） ----------
  // 语法与样式对齐用户博客后台（D:/项目/博客站点）：按钮组工具栏（无下拉）+ 左源码右实时预览。
  // 正文存 notes[].text（Markdown 源码）；html 置空，避免和旧的富文本内容打架。
  const nv = { key: '', noteId: '', timer: null, open: false, previewTimer: null };

  function nvStatus(msg) {
    const s = $('nv-status');
    if (s) s.textContent = msg || '';
  }

  function nvSaveNow() {
    const md = $('nv-md');
    if (!nv.open || !nv.key || !nv.noteId || !md) return Promise.resolve(true);
    if (nv.timer) { clearTimeout(nv.timer); nv.timer = null; }
    const text = md.value;
    const title = ($('nv-title') && $('nv-title').value.trim()) || '';
    const key = nv.key, id = nv.noteId;
    nvStatus('保存中…');
    const p = Promise.resolve()
      .then(() => L().updateNote(key, id, { text, html: '' }))
      .then(() => (title ? L().updateItem(key, { title }) : null))
      .then(() => reloadItemsQuiet())
      .then(() => {
        if (nv.key !== key) return true;
        const d = new Date();
        nvStatus('已保存 ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'));
        return true;
      })
      .catch(() => { if (nv.key === key) nvStatus('保存失败，请检查磁盘或目录权限后重试'); return false; });
    return p;
  }

  function nvScheduleSave() {
    if (!nv.open) return;
    nvStatus('编辑中…');
    if (nv.timer) clearTimeout(nv.timer);
    nv.timer = setTimeout(() => { nv.timer = null; nvSaveNow(); }, 700);
  }

  function nvRenderPreview() {
    const md = $('nv-md'), box = $('nv-preview');
    if (!box || !window.Md) return;
    box.innerHTML = window.Md.render(md ? md.value : '');
    nvLoadLocalImages(box);   // 本地图片（snapshots/xx.png）走 IPC 读 dataURL
  }

  function nvSchedulePreview() {
    if (!nv.open) return;
    if (nv.previewTimer) clearTimeout(nv.previewTimer);
    nv.previewTimer = setTimeout(() => { nv.previewTimer = null; nvRenderPreview(); }, 350);
  }

  function nvMdSource(note) {
    // Markdown 笔记直接用 text；旧富文本笔记（只有 html）在这里一次性转成 Markdown
    if (!note) return '';
    const text = String(note.text || '');
    if (text.trim()) return text;
    if ((note.html || '').trim() && window.Md && window.Md.fromHtml) return window.Md.fromHtml(note.html);
    return '';
  }

  async function openNoteEditor(key) {
    if (nv.open && !await nvSaveNow()) return;
    const it = state.items.find((x) => x.key === key);
    if (!it || !L()) return;
    let note = (it.notes || [])[0] || null;
    if (!note) {
      // 老条目 / 空笔记：没有正文就先建一条，保证打开后能直接写
      const created = await L().addNote(key, { title: '', text: '' });
      if (created && created.id) note = created;
      await reloadItemsQuiet();
    }
    const md = $('nv-md'), title = $('nv-title');
    if (!md || !title) return;
    nv.key = key;
    nv.noteId = note ? note.id : '';
    nv.open = true;
    md.value = nvMdSource(note);
    title.value = it.title || '';
    nvStatus('已打开');
    $('note-view').hidden = false;
    document.body.classList.add('note-editing');
    nvRenderPreview();
    setTimeout(() => { md.focus(); }, 30);
  }

  // 不发网络/不刷新的快速关闭：切到阅读器时用，避免和文献库淡出动画抢状态
  function nvCloseQuiet() {
    if (!nv.open) return;
    nv.open = false;
    nv.key = '';
    nv.noteId = '';
    if (nv.timer) { clearTimeout(nv.timer); nv.timer = null; }
    if (nv.previewTimer) { clearTimeout(nv.previewTimer); nv.previewTimer = null; }
    const box = $('note-view');
    if (box) box.hidden = true;
    document.body.classList.remove('note-editing');
  }

  async function closeNoteEditor() {
    if (!nv.open) return;
    if (!await nvSaveNow()) return; // 保存失败保留编辑内容，允许重试。
    nvCloseQuiet();
    if (window.App && window.App.toast) window.App.toast('笔记已保存');
    // 回到文献库时不要顺手把右侧详情栏弹出来（renderDetail 会跟着 selectedKey 走）
    state.selectedKey = null;
    state.selectedKeys.clear();
    await refresh();
  }

  // ===== Markdown 工具栏（博客 posts.ts 的 insertMarkdownSnippet 移植版，操作 #nv-md） =====
  function nvAfterEdit() { nvScheduleSave(); nvSchedulePreview(); }

  // 光标处包裹：有选中就包选中内容，没有就插占位符并选中之
  function nvWrap(before, after, placeholder) {
    const ta = $('nv-md');
    if (!ta) return;
    const start = ta.selectionStart, end = ta.selectionEnd;
    const sel = ta.value.slice(start, end);
    const body = sel || placeholder || '';
    ta.setRangeText(before + body + after, start, end, 'end');
    ta.focus();
    ta.setSelectionRange(start + before.length, start + before.length + body.length);
    nvAfterEdit();
  }

  // 光标处插入一段文本（替换选中）
  function nvInsertText(str) {
    const ta = $('nv-md');
    if (!ta) return;
    ta.setRangeText(str, ta.selectionStart, ta.selectionEnd, 'end');
    ta.focus();
    nvAfterEdit();
  }

  // 插入块级内容：自动补前面的空行，写完不挤压上一段
  function nvInsertBlock(text) {
    const ta = $('nv-md');
    if (!ta) return;
    const start = ta.selectionStart;
    const pre = ta.value.slice(0, start);
    const pad = !pre ? '' : (/\n\n$/.test(pre) ? '' : (/\n$/.test(pre) ? '\n' : '\n\n'));
    ta.setRangeText(pad + text, ta.selectionStart, ta.selectionEnd, 'end');
    ta.focus();
    nvAfterEdit();
  }

  function nvInsertSnippet(type) {
    const ta = $('nv-md');
    if (!ta || !type) return;
    switch (type) {
      case 'bold': nvWrap('**', '**', '加粗文本'); break;
      case 'italic': nvWrap('*', '*', '斜体文本'); break;
      case 'strike': nvWrap('~~', '~~', '删除线文本'); break;
      case 'underline': nvWrap('++', '++', '下划线文本'); break;
      case 'spoiler': nvWrap('!!', '!!', '模糊文本，悬停或点击后清晰'); break;
      case 'rainbow': nvWrap('==', '==', '彩虹文字'); break;
      case 'code-inline': nvWrap('`', '`', 'code'); break;
      case 'code-block': nvWrap('```ts\n', '\n```', "console.log('hello')"); break;
      case 'formula-inline': nvWrap('$', '$', 'a^2+b^2=c^2'); break;
      case 'formula-block': nvWrap('$$\n', '\n$$', '\\int_a^b f(x)\\,dx'); break;
      case 'heading-2': nvInsertText('## 二级标题\n'); break;
      case 'heading-3': nvInsertText('### 三级标题\n'); break;
      case 'link': nvInsertText('[链接标题](https://example.com)'); break;
      case 'ruby': nvInsertText('{汉字}(hàn|zì)'); break;
      case 'blockquote': nvInsertText('> 这是一段引用\n'); break;
      case 'ul': nvInsertText('- 列表项 1\n- 列表项 2\n'); break;
      case 'ol': nvInsertText('1. 列表项 1\n2. 列表项 2\n'); break;
      case 'task': nvInsertText('- [ ] 待办事项\n- [x] 已完成事项\n'); break;
      case 'hr': nvInsertBlock('---\n'); break;
      case 'table': nvInsertText('| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n| 内容1 | 内容2 | 内容3 |\n'); break;
      case 'tip': nvInsertBlock(':::tip\n这里填写提示内容\n:::\n'); break;
      case 'tip-note': nvInsertBlock(':::note\n这里填写注意内容\n:::\n'); break;
      case 'tip-important': nvInsertBlock(':::important\n这里填写重要内容\n:::\n'); break;
      case 'tip-warning': nvInsertBlock(':::warning\n这里填写警告内容\n:::\n'); break;
      case 'tip-caution': nvInsertBlock(':::caution\n这里填写危险内容\n:::\n'); break;
      case 'tip-title': nvInsertBlock(':::tip[自定义标题]\n这里填写提示内容\n:::\n'); break;
      case 'derivation': nvInsertBlock(':::derivation\n**推导过程：**\n\n在此填写推导内容...\n:::\n'); break;
      case 'quote-card': nvInsertBlock(':::quote\n在此填写引用内容\n\n<right>—— 出处</right>\n:::\n'); break;
      case 'music-card': nvInsertBlock('::music{id="网易云歌曲ID"}\n'); break;
      case 'github-card': nvInsertBlock('::github{repo="用户名/仓库名"}\n'); break;
      case 'footnote': {
        // 自动选未占用的编号：光标处插引用，文末追加定义（博客同款行为）
        const used = Array.from(ta.value.matchAll(/\[\^(\d+)\]/g)).map((m) => parseInt(m[1], 10));
        const next = (used.length ? Math.max(...used) : 0) + 1;
        nvInsertText('[^' + next + ']');
        ta.setRangeText('\n\n[^' + next + ']: 在此填写脚注内容\n', ta.value.length, ta.value.length, 'end');
        ta.focus();
        nvAfterEdit();
        break;
      }
      default: break;
    }
  }

  // v33：笔记模板 —— 课程笔记 / 论文卡片 / 摘录汇总三种（评审报告 6.5 的轻量模板）。
  // 全部用现有 Markdown 语法（::: 容器、任务列表、引用卡），预览直接能渲染；
  // 摘录位置留「—— 作者：《标题》，年份，第 N 页」的出处行，和摘录/批注的出处格式一致。
  const NOTE_TEMPLATES = {
    course: '## 课程笔记：课程主题\n\n' +
      ':::tip[课程信息]\n课程：\xa0\xa0·\xa0\xa0日期：\xa0\xa0·\xa0\xa0讲师：\n:::\n\n' +
      '### 课堂要点\n- 要点 1\n- 要点 2\n\n' +
      '### 重点推导\n:::derivation\n**推导过程：**\n\n在此填写推导内容…\n:::\n\n' +
      '### 疑问与待办\n- [ ] 待弄清的问题\n',
    paper: '## 论文卡片：论文标题\n\n' +
      ':::quote\n「核心摘录：作者最重要的观点或结论」\n\n<right>—— 作者：《标题》，年份，第 N 页</right>\n:::\n\n' +
      '### 研究问题\n\n### 方法与数据\n\n### 结论与启发\n\n### 我的评价\n',
    excerpt: '## 摘录汇总：主题\n\n' +
      ':::quote\n「摘录 1」\n\n<right>—— 作者：《标题》，年份，第 N 页</right>\n:::\n\n' +
      ':::quote\n「摘录 2」\n\n<right>—— 出处</right>\n:::\n\n' +
      '### 综合笔记\n',
  };
  function nvApplyTemplate(v) {
    const tpl = NOTE_TEMPLATES[v];
    if (!tpl) return;
    const ta = $('nv-md');
    if (!ta) return;
    // R02：模板必须真正「追加到末尾」。不能走 nvInsertBlock——它替换当前选区 /
    // 在光标处插入，界面却提示「已在末尾」，选中的正文会被模板吃掉。
    // 这里用 setRangeText 钉死在正文末尾的位置：原正文逐字不变，选区 / 光标也不动语义。
    if (!ta.value.trim()) {
      ta.setRangeText(tpl, 0, 0, 'end');
    } else {
      ta.setRangeText('\n\n' + tpl, ta.value.length, ta.value.length, 'end');
    }
    ta.focus();
    ta.selectionStart = ta.selectionEnd = ta.value.length;
    nvAfterEdit();
    nvStatus('已在末尾插入模板');
  }

  // v33：导出这条笔记（HTML 自带图片 / Markdown 带相对图片目录）。先落盘再导出，
  // 保存失败就不导——导出去的内容必须和库里的一致，不做「假导出」。
  async function nvExportNote(fmt) {
    if (!nv.open || !window.pdfBridge || !window.pdfBridge.exportNoteBundle) return;
    const saved = await nvSaveNow();
    if (saved === false) { nvStatus('保存失败，已取消导出'); return; }
    const r = await window.pdfBridge.exportNoteBundle({
      key: nv.key, noteId: nv.noteId, fmt,
      title: ($('nv-title') && $('nv-title').value.trim()) || '',
    });
    if (!r) { nvStatus('导出失败'); return; }
    if (r.canceled) { nvStatus('已取消导出'); return; }
    if (!r.ok) { nvStatus('导出失败：' + (r.error || '未知错误')); return; }
    const imgs = (r.images || 0) + (r.skipped ? ' 张缺失' : '');
    nvStatus(r.images ? ('已导出到 ' + r.path + '（图片 ' + imgs + '）') : ('已导出到 ' + r.path));
    window.App && window.App.toast && window.App.toast(r.images ? '笔记已导出（含 ' + r.images + ' 张图片）' : '笔记已导出');
  }


  // v9：笔记改成富文本（像 Word 一样直接排版，不再是「写 Markdown 再切预览」）
  const RICH_BAR = '<div class="rt-bar">' +
    '<button type="button" data-rt="bold" title="加粗 (Ctrl+B)"><b>B</b></button>' +
    '<button type="button" data-rt="italic" title="斜体 (Ctrl+I)"><i>I</i></button>' +
    '<button type="button" data-rt="underline" title="下划线 (Ctrl+U)"><u>U</u></button>' +
    '<button type="button" data-rt="strikeThrough" title="删除线"><s>S</s></button>' +
    '<select data-rt="formatBlock" title="段落样式">' +
      '<option value="p">正文</option><option value="h2">标题</option>' +
      '<option value="h3">小标题</option><option value="blockquote">引用</option>' +
    '</select>' +
    '<button type="button" data-rt="insertUnorderedList" title="无序列表">• 列表</button>' +
    '<button type="button" data-rt="insertOrderedList" title="有序列表">1. 列表</button>' +
    '<button type="button" data-rt="createLink" title="把选中的文字变成链接">链接</button>' +
    '<button type="button" data-rt="removeFormat" title="清除格式">清除格式</button>' +
    '</div>';

  // v23：阅读笔记列表（每条独立保存，不影响表单里没保存的其他字段）
  function renderNotes(it) {
    if (!el.ld.notes) return;
    const notes = (it && it.notes) || [];
    const isNoteItem = !!(it && it.itemType === 'note' && !it.attachment);
    // 独立笔记：侧栏只留「去编辑器」入口 + 只读 Markdown 预览（编辑在 Markdown 编辑器里做，
    // 不在侧栏改，免得两种格式互相覆盖）
    const openBtn = isNoteItem
      ? '<button class="ld-btn primary ld-note-open" data-open-note-editor="1" '
        + 'title="像打开文档一样全屏编辑（双击卡片也可以）">在编辑器里打开这条笔记</button>'
      : '';
    if (isNoteItem) {
      const n0 = notes[0] || null;
      const body = n0 ? ((window.Md && window.Md.render(n0.text || '')) || '') : '';
      el.ld.notes.innerHTML = openBtn
        + '<div class="ld-note-md ld-note-readonly">' + (body || '<div class="ld-hint">还没有内容，点上面的按钮去写。</div>') + '</div>';
      nvLoadLocalImages(el.ld.notes);
      return;
    }
    if (!notes.length) {
      el.ld.notes.innerHTML = openBtn + '<div class="ld-hint">还没有笔记。读完一段写一条，之后能单独翻出来看。</div>';
      return;
    }
    el.ld.notes.innerHTML = openBtn + notes.map((n) => {
      // 富文本正文：优先用存下来的 html；老笔记（只有 Markdown text）在这里一次性渲染成富文本
      const mdHtml = (window.Md && n.text) ? window.Md.render(n.text) : '';
      const body = window.RichText ? window.RichText.initial(n, mdHtml) : esc(n.text || '');
      return '<div class="ld-note" data-note-id="' + esc(n.id) + '">' +
        '<input class="ld-note-title" data-note-field="title" value="' + esc(n.title) + '" placeholder="标题（可以留空）" />' +
        (n.image
          ? '<img class="ld-note-img" data-note-img="' + esc(n.image) + '" alt="标注截图" title="从标注生成的页面截图" />'
          : '') +
        RICH_BAR +
        '<div class="ld-note-rich" contenteditable="true" data-note-field="html" ' +
          'data-placeholder="直接在这里写，选中文字就能加粗 / 列表 / 链接…">' + body + '</div>' +
        '<div class="ld-note-foot"><span class="ld-hint">改完自动保存' + (n.image ? ' · 含标注截图' : '') + '</span>' +
        // R04：子笔记的导出入口（独立笔记的全屏编辑器里另有「导出…」下拉）
        '<select class="ld-note-export" title="导出这条笔记（HTML 自带图片 / Markdown 带图片目录）">' +
          '<option value="">导出…</option><option value="html">HTML</option><option value="md">Markdown</option></select>' +
        '<button class="ld-mini ld-note-del" title="删除这条笔记">删除</button></div>' +
      '</div>';
    }).join('');
    nvLoadLocalImages(el.ld.notes);
  }

  // 容器里的本地图片（截图 data-note-img / Markdown 图片 data-md-img）走 IPC 读 dataURL
  function nvLoadLocalImages(scope) {
    if (!scope) return;
    for (const img of scope.querySelectorAll('[data-note-img], [data-md-img]')) {
      const rel = img.dataset.noteImg || img.dataset.mdImg;
      if (!rel || !window.pdfBridge || !window.pdfBridge.noteImage) continue;
      const token = rel;
      window.pdfBridge.noteImage(rel).then((r) => {
        if (!r || !r.ok || !img.isConnected) return;
        if ((img.dataset.noteImg || img.dataset.mdImg) !== token) return;   // 详情面板已经换了条目
        img.src = r.dataUrl;
      }).catch(() => {});
    }
  }

  // 富文本正文保存：html 落库，同时提纯文本给搜索/摘要；不重建列表（免得丢焦点）
  const noteSaveTimers = new Map();
  async function saveNoteRich(noteEl, immediate) {
    const key = state.selectedKey;
    const id = noteEl && noteEl.dataset.noteId;
    const box = noteEl && noteEl.querySelector('.ld-note-rich');
    if (!key || !id || !box || !window.RichText) return;
    const clear = () => { const t = noteSaveTimers.get(id); if (t) { clearTimeout(t); noteSaveTimers.delete(id); } };
    if (!immediate) {
      const prev = noteSaveTimers.get(id);
      if (prev) clearTimeout(prev);
      noteSaveTimers.set(id, setTimeout(() => { noteSaveTimers.delete(id); saveNoteRich(noteEl, true); }, 700));
      return;
    }
    clear();
    const html = window.RichText.sanitize(box.innerHTML);
    const text = window.RichText.toText(html);
    try {
      await L().updateNote(key, id, { html, text });
      await reloadItemsQuiet();
    } catch (_) {}
  }

  // 刷新条目数据但不重绘详情表单（免得把用户没保存的其它字段冲掉）
  async function reloadItemsQuiet() {
    try {
      const s = await L().summary();
      if (s && Array.isArray(s.items)) state.items = s.items;
    } catch (_) {}
  }

  // ---------- 作者行（v6：姓 / 名 / 角色 分开填） ----------
  function creatorRow(c) {
    const row = document.createElement('div');
    row.className = 'ld-cr';
    const last = document.createElement('input');
    last.type = 'text'; last.className = 'ld-cr-last'; last.placeholder = '姓';
    last.value = c.lastName || '';
    const first = document.createElement('input');
    first.type = 'text'; first.className = 'ld-cr-first'; first.placeholder = '名';
    first.value = c.firstName || '';
    const type = document.createElement('select');
    type.className = 'ld-cr-type';
    for (const t of (window.Creators ? window.Creators.CREATOR_TYPES : [{ id: 'author', label: '作者' }])) {
      const opt = document.createElement('option');
      opt.value = t.id; opt.textContent = t.label;
      if (t.id === c.creatorType) opt.selected = true;
      type.appendChild(opt);
    }
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'ld-cr-del'; del.textContent = '✕';
    del.title = '删掉这位作者';
    del.addEventListener('click', () => { row.remove(); });
    row.appendChild(last); row.appendChild(first); row.appendChild(type); row.appendChild(del);
    return row;
  }

  function renderCreators(list) {
    const box = el.ld.creators;
    if (!box) return;
    box.innerHTML = '';
    const rows = window.Creators ? window.Creators.normalizeCreators(list) : [];
    if (!rows.length) {
      const hint = document.createElement('div');
      hint.className = 'ld-hint';
      hint.textContent = '还没有作者，点下面「添加作者」';
      box.appendChild(hint);
      return;
    }
    for (const c of rows) box.appendChild(creatorRow(c));
  }

  // 从行里读回作者（姓/名/角色），顺手归一化去重
  function readCreators() {
    const box = el.ld.creators;
    if (!box) return [];
    const out = [];
    for (const row of box.querySelectorAll('.ld-cr')) {
      const last = (row.querySelector('.ld-cr-last') || {}).value || '';
      const first = (row.querySelector('.ld-cr-first') || {}).value || '';
      const type = (row.querySelector('.ld-cr-type') || {}).value || 'author';
      const one = { lastName: last.trim(), firstName: first.trim(), creatorType: type };
      if (!one.lastName && !one.firstName) continue;
      out.push(one);
    }
    return window.Creators ? window.Creators.normalizeCreators(out) : out;
  }

  function renderDetail() {
    const it = selectedItem();
    if (!it) { el.detail.hidden = true; return; }
    const trashed = !!it.deletedAt;
    el.detail.hidden = false;
    fillTypeOptions();

    el.ld.type.value = it.itemType || 'document';
    el.ld.title.value = it.title || '';
    renderCreators(it.creators);
    el.ld.year.value = it.year || '';
    el.ld.publication.value = it.publication || '';
    el.ld.volume.value = it.volume || '';
    el.ld.issue.value = it.issue || '';
    el.ld.pages.value = it.pages || '';
    el.ld.doi.value = it.doi || '';
    el.ld.url.value = it.url || '';
    el.ld.abstract.value = it.abstract || '';
    // v9：独立笔记条目只关心正文与标签，标注 / 引用 / 相关条目对她没有意义
    const isNoteItem = it.itemType === 'note' && !it.attachment;
    for (const sec of el.detail.querySelectorAll('[data-ld-sec]')) {
      const name = sec.dataset.ldSec;
      sec.hidden = isNoteItem && (name === 'annos' || name === 'cite' || name === 'relations');
    }
    el.ld.kind.textContent = isNoteItem ? '笔记' : '条目详情';
    if (el.ld.noteAdd) el.ld.noteAdd.textContent = isNoteItem ? '＋ 继续写一条' : '＋ 新建一条笔记';
    renderDetailAnnos(it);
    renderNotes(it);
    state.detailTags = (it.tags || []).slice();
    renderDetailTags(trashed);
    renderDetailColls(it, trashed);
    renderAttach(it, trashed);
    renderCite(it, trashed);
    renderCitekey(it, trashed);
    renderRelations(it, trashed);

    const fields = [el.ld.type, el.ld.title, el.ld.year, el.ld.publication,
      el.ld.volume, el.ld.issue, el.ld.pages, el.ld.doi, el.ld.url, el.ld.abstract];
    for (const f of fields) f.disabled = trashed;
    if (el.ld.creators) el.ld.creators.querySelectorAll('input, select, button').forEach((n) => { n.disabled = trashed; });
    if (el.ld.creatorAdd) el.ld.creatorAdd.disabled = trashed;
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
    if (el.ld.snapshot) el.ld.snapshot.disabled = trashed;
    if (el.ld.snapshotOpen) {
      el.ld.snapshotOpen.hidden = !(it.snapshot && it.snapshot.path && it.snapshot.hasFile !== false);
    }

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
        '<button class="ld-mini" data-ld-rename="1"' + (trashed || missing ? ' disabled' : '')
          + ' title="按「作者 - 年份 - 标题」重命名文件，标注与全文索引会一起跟着搬">按条目重命名</button>' +
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
      creators: readCreators(),
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
    try { await L().updateItem(it.key, patch); }
    catch (err) {
      el.ld.status.textContent = '保存失败：' + (err.message || String(err));
      window.App && window.App.toast && window.App.toast('条目尚未保存，请重试', 4000);
      return;
    }
    await refresh();
    el.ld.status.textContent = '已保存';
    window.App && window.App.toast && window.App.toast('条目已保存');
  }

  // ---------- 动作 ----------
  async function openItem(key, page, opts) {
    const res = await L().openItem(key, page);
    if (!res || !res.ok) {
      if (res && res.missingPath) { await refresh(); }
      window.App && window.App.toast && window.App.toast('打开失败：' + ((res && res.error) || '未知错误'));
      return;
    }
    hide();
    if (typeof window.__libOpen === 'function') window.__libOpen(res);
    // v9：从全文检索点进来时，顺手在页面上高亮关键词并跳到第一个命中
    const q = opts && opts.highlight;
    if (q) await highlightAfterOpen(res, q);
  }

  // 查询语法 → 适合页内搜索的正文词（页内搜索是纯子串，字段限定 / 排除词在这里没有意义）
  function bodyTermOf(q) {
    if (!window.Query) return String(q || '').trim();
    try {
      const ast = window.Query.parseQuery(q);
      const tok = (ast.text || [])[0];
      return tok ? tok.t : '';
    } catch (_) { return String(q || '').trim(); }
  }

  async function highlightAfterOpen(res, q) {
    const term = bodyTermOf(q);
    if (!term) return;                       // 纯字段限定的查询没有正文词可高亮
    const it = res && res.item;
    const target = (it && it.attachment && it.attachment.path) || '';
    const t0 = Date.now();
    while (Date.now() - t0 < 8000) {
      const s = window.App && window.App.state;
      if (s && s.pdfDoc && (!target || s.filePath === target)) break;
      await sleep(100);
    }
    const s = window.App && window.App.state;
    if (!s || !s.pdfDoc) return;
    try {
      window.App.doSearch(term);
      window.App.toast && window.App.toast('已在文档内高亮“' + term + '”');
    } catch (_) {}
  }

  // 统一入库：对话框添加与拖入共用，dedupe 由 lib-add-pdf 处理。
  async function addPaths(paths) {
    let added = 0, deduped = 0, failed = 0, lastKey = null;
    for (const p of paths) {
      const r = await L().addPdf(p, { dedupe: true });
      if (r && r.ok && r.item) {
        if (r.deduped) deduped++; else added++;
        lastKey = r.item.key;
      } else failed++;
    }
    if (lastKey) state.selectedKey = lastKey;
    state.scope = { type: 'all' };
    await refresh();
    return { added, deduped, failed };
  }

  function toastAdded(r) {
    const parts = [];
    if (r.added) parts.push('已添加 ' + r.added + ' 个文档');
    if (r.deduped) parts.push('已在库中 ' + r.deduped + ' 个');
    if (r.failed) parts.push('失败 ' + r.failed + ' 个');
    window.App && window.App.toast && window.App.toast(parts.length ? parts.join('，') : '没有添加文档');
  }

  // 只选路径，不预先读取/转换；真正读取发生在打开条目时。
  async function addDocuments() {
    if (!window.pdfBridge || !window.pdfBridge.pickDocuments) return;
    const res = await window.pdfBridge.pickDocuments();
    if (!res || !res.ok || !res.filePaths || !res.filePaths.length) return;
    toastAdded(await addPaths(res.filePaths));
  }

  async function handleDrop(e) {
    // 支持所有常见文档：PDF / Word / PPT / Excel / Markdown / EPUB / 图片 / 纯文本…
    // 后端 lib-add-pdf 会再校验一次扩展名；这里只挡一下目录和空文件。
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []).filter((f) => f && f.name);
    if (!files.length) return;
    const paths = [];
    let missing = 0;
    for (const file of files) {
      let p = '';
      try { p = window.pdfBridge.pathForFile(file) || ''; } catch (_) {}
      if (p) paths.push(p); else missing++;
    }
    if (!paths.length) { window.App && window.App.toast && window.App.toast('无法取得文件路径'); return; }
    const r = await addPaths(paths);
    if (!r.added && !r.deduped) {
      window.App && window.App.toast && window.App.toast('没有可添加的文档（格式不支持或路径不可用）');
      return;
    }
    toastAdded({ added: r.added, deduped: r.deduped, failed: r.failed + missing });
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
    if (el.setRestoreTabs) el.setRestoreTabs.checked = !!state.settings.restoreTabs;
    if (el.setInvertPages) el.setInvertPages.checked = !!state.settings.invertPages;
    if (el.setFetchEmail) el.setFetchEmail.value = state.settings.fetchEmail || '';
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
      restoreTabs: el.setRestoreTabs ? el.setRestoreTabs.checked : false,
      invertPages: el.setInvertPages ? el.setInvertPages.checked : false,
      viewMode: el.setViewMode ? el.setViewMode.value : 'scroll',
      fetchEmail: el.setFetchEmail ? el.setFetchEmail.value.trim() : '',
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
    await loadCslStyles();
    fillStyleSelects();
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
    // 作者是结构化的，直接重画行（不能往 div 里塞 .value）
    if (m.creators && m.creators.length) renderCreators(m.creators);
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

  // v9：抓 PDF 全文（arXiv → Unpaywall → 直链 / doi.org）
  async function fetchPdfFull() {
    const it = selectedItem();
    if (!it || it.deletedAt) return;
    if (!L() || !L().fetchPdf) { el.ld.fetchStatus.textContent = '当前环境不支持抓取'; return; }
    // 表单里刚填的 DOI / 链接优先（不必先保存）
    const doi = (el.ld.doi.value || '').trim();
    const url = (el.ld.url.value || '').trim();
    if (!doi && !url && !(it.attachment && it.attachment.path)) {
      el.ld.fetchStatus.textContent = '先填 DOI 或链接';
      return;
    }
    const old = (el.ld.fetchPdf || {}).textContent;
    if (el.ld.fetchPdf) { el.ld.fetchPdf.disabled = true; el.ld.fetchPdf.textContent = '下载中…'; }
    el.ld.fetchStatus.textContent = '正在找开放获取的 PDF…';
    let r;
    try { r = await L().fetchPdf(it.key, url || undefined, doi); }
    catch (err) { r = { ok: false, error: err.message || String(err) }; }
    finally { if (el.ld.fetchPdf) { el.ld.fetchPdf.disabled = false; el.ld.fetchPdf.textContent = old || '抓 PDF 全文'; } }
    if (!r || !r.ok) {
      el.ld.fetchStatus.textContent = '没抓到：' + ((r && r.error) || '未知错误');
      return;
    }
    await reloadItemsQuiet();
    await refresh();
    const kb = Math.round((r.bytes || 0) / 1024);
    el.ld.fetchStatus.textContent = '已下载（' + kb + ' KB · 来源 ' + String(r.source || '')
      + '），可以直接双击阅读';
    window.App && window.App.toast && window.App.toast('PDF 已挂到条目上');
  }

  // v31：批量抓取。选中多条 → 依次抓，进度实时显示在批量条上；再点一次可请求取消。
  let fetchBatchRunning = false;
  async function bulkFetchPdfs() {
    if (fetchBatchRunning) {
      if (L() && L().cancelFetchPdfBatch) await L().cancelFetchPdfBatch();
      window.App && window.App.toast && window.App.toast('已请求取消，当前这条抓完就停');
      return;
    }
    if (!L() || !L().fetchPdfBatch) {
      window.App && window.App.toast && window.App.toast('当前环境不支持批量抓取');
      return;
    }
    const keys = Array.from(state.selectedKeys)
      .filter((k) => state.items.some((x) => x.key === k && !x.deletedAt));
    if (!keys.length) {
      window.App && window.App.toast && window.App.toast('先选条目再抓取');
      return;
    }
    fetchBatchRunning = true;
    if (el.bulkFetch) { el.bulkFetch.textContent = '取消抓取'; el.bulkFetch.title = '再点一次：当前这条抓完就停'; }
    const off = L().onFetchPdfProgress ? L().onFetchPdfProgress((p) => {
      if (el.bulkCount) {
        el.bulkCount.textContent = '抓取中 ' + p.done + '/' + p.total
          + ' · 成功 ' + p.fetched + ' · 失败 ' + p.failed + ' · 跳过 ' + p.skipped;
      }
    }) : null;
    let r = null;
    try { r = await L().fetchPdfBatch(keys); } catch (err) {
      r = { ok: false, error: String(err && err.message ? err.message : err) };
    }
    if (off) off();
    fetchBatchRunning = false;
    if (el.bulkFetch) { el.bulkFetch.textContent = '抓 PDF'; el.bulkFetch.title = '给选中的条目批量抓取开放获取 PDF（arXiv / Unpaywall / 直链）'; }
    if (el.bulkCount) el.bulkCount.textContent = '已选 ' + state.selectedKeys.size + ' 项';
    if (!r || !r.ok) {
      window.App && window.App.toast && window.App.toast('批量抓取失败：' + ((r && r.error) || '未知错误'));
      return;
    }
    await reloadItemsQuiet();
    await refresh();
    let msg = '抓取完成：成功 ' + (r.fetched || 0) + '，失败 ' + (r.failed || 0) + '，跳过 ' + (r.skipped || 0);
    if (r.aborted) msg += '（已取消）';
    const bad = (r.results || []).filter((x) => x.status === 'failed');
    if (bad.length) msg += '；' + (bad[0].title || bad[0].key) + '：' + (bad[0].error || '');
    window.App && window.App.toast && window.App.toast(msg, bad.length ? 6000 : 3500);
  }

  // v31：网页快照——把条目网址存成本地单文件 MHTML + 首屏 PNG
  async function snapshotPage() {
    const it = selectedItem();
    if (!it || it.deletedAt) return;
    if (!L() || !L().snapshotPage) { el.ld.fetchStatus.textContent = '当前环境不支持快照'; return; }
    const url = (el.ld.url.value || '').trim() || it.url || '';
    if (!/^https?:\/\//i.test(url)) {
      el.ld.fetchStatus.textContent = '先填链接（http/https）再快照';
      return;
    }
    if (el.ld.snapshot) { el.ld.snapshot.disabled = true; el.ld.snapshot.textContent = '快照中…'; }
    el.ld.fetchStatus.textContent = '正在打开网页并保存快照…（最长 30 秒）';
    let r = null;
    try { r = await L().snapshotPage(it.key, url); } catch (err) {
      r = { ok: false, error: String(err && err.message ? err.message : err) };
    }
    if (el.ld.snapshot) { el.ld.snapshot.disabled = false; el.ld.snapshot.textContent = '网页快照'; }
    if (!r || !r.ok) {
      el.ld.fetchStatus.textContent = '快照失败：' + ((r && r.error) || '未知错误');
      return;
    }
    await reloadItemsQuiet();
    await refresh();
    if (el.ld.fetchStatus) el.ld.fetchStatus.textContent = '快照已保存，点「打开快照」回看';
    if (el.ld.snapshotOpen) el.ld.snapshotOpen.hidden = false;
    window.App && window.App.toast && window.App.toast('网页快照已保存');
  }

  async function openSnapshot() {
    const it = selectedItem();
    const p = it && it.snapshot && it.snapshot.path;
    if (!p) { if (el.ld.fetchStatus) el.ld.fetchStatus.textContent = '还没有快照'; return; }
    // .mhtml 归系统浏览器管，走专门的 IPC；open-path 只认应用自己支持的文档格式
    if (L() && L().openSnapshot) {
      const r = await L().openSnapshot(it.key);
      if (!r || !r.ok) {
        if (el.ld.fetchStatus) {
          el.ld.fetchStatus.textContent = '打开失败：' + ((r && r.error) || '系统没有关联 .mhtml 的程序');
        }
      }
      return;
    }
    if (window.pdfBridge && window.pdfBridge.openPath) window.pdfBridge.openPath(p);
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

  // v9：批量按「作者 - 年份 - 标题」重命名附件（标注与全文索引随迁，见 main.js）
  async function bulkRenameFiles() {
    const keys = [...state.selectedKeys].filter((k) => !k.startsWith(ANNO_PREFIX));
    if (!keys.length) {
      window.App && window.App.toast && window.App.toast('先选中要重命名的条目');
      return;
    }
    const r = await L().renameFile(keys);
    await refresh();
    if (!r || !r.ok) {
      window.App && window.App.toast && window.App.toast('重命名失败：' + ((r && r.errors && r.errors[0] && r.errors[0].error) || '未知错误'));
      return;
    }
    const parts = ['已重命名 ' + (r.renamed || 0) + ' 个文件'];
    if (r.skipped) parts.push('跳过 ' + r.skipped + ' 个（文件名已符合规则 / 没有附件）');
    if (r.failed) parts.push('失败 ' + r.failed + ' 个');
    window.App && window.App.toast && window.App.toast(parts.join('，'));
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

  // ---------- 参考文献表 ----------
  // 只在渲染层拼装：条目数据已经在 state 里，不需要主进程再读一次库。
  // 范围三种：当前列表（含搜索/收藏集/标签筛选与当前排序）/ 选中条目 / 整库。
  //
  // v32：样式来源有三类（5 种内置、内置 CSL、用户导入的 .csl），列表统一由
  // Cite.styleList() 生成，这里只负责填下拉和把用户样式送进引擎。
  function styleExists(id) {
    return !!(window.Cite && Cite.styleList && Cite.styleList().some((x) => x.id === id));
  }

  function styleOptionsHtml() {
    if (!window.Cite || !Cite.styleList) return '';
    const groups = new Map();
    for (const s of Cite.styleList()) {
      const group = s.group || '内置样式';
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(s);
    }
    let html = '';
    for (const [group, list] of groups) {
      html += '<optgroup label="' + esc(group) + '">' +
        list.map((s) => '<option value="' + esc(s.id) + '">' + esc(s.label) + '</option>').join('') +
        '</optgroup>';
    }
    return html;
  }

  function fillStyleSelects() {
    const html = styleOptionsHtml();
    if (!html) return;
    for (const sel of [el.ld && el.ld.citeStyle, el.bib && el.bib.style]) {
      if (!sel) continue;
      const keep = sel.value || state.citeStyle;
      sel.innerHTML = html;
      sel.value = styleExists(keep) ? keep : 'gbt7714';
    }
    if (!styleExists(state.citeStyle)) state.citeStyle = 'gbt7714';
  }

  // 用户样式在 <数据目录>/styles；启动 / 换目录时整批读回来，避免下拉里留幽灵项。
  async function loadCslStyles() {
    if (!L() || !L().cslStyles || !window.Cite || !Cite.registerCslStyles) return;
    try {
      const r = await L().cslStyles();
      if (r && r.ok) Cite.registerCslStyles(r.styles || []);
    } catch (err) {
      console.warn('[library] csl styles unavailable:', err && err.message ? err.message : err);
    }
  }

  async function importCslStyle() {
    if (!L() || !L().cslImport) return;
    let r;
    try { r = await L().cslImport(); }
    catch (err) { r = { ok: false, error: err && err.message ? err.message : String(err) }; }
    if (!r || r.canceled) return;
    if (!r.ok) {
      window.App && App.toast && App.toast('导入失败：' + (r.error || '未知错误'), 5000);
      return;
    }
    if (window.Cite && Cite.registerCslStyles) Cite.registerCslStyles(r.styles || []);
    state.citeStyle = 'csl:' + r.id;
    fillStyleSelects();
    if (el.bib && el.bib.style) el.bib.style.value = state.citeStyle;
    if (el.ld && el.ld.citeStyle) el.ld.citeStyle.value = state.citeStyle;
    if (el.bib && el.bib.modal && !el.bib.modal.hidden) renderBib();
    if (el.detail && !el.detail.hidden) renderDetail();
    const missing = (r.warnings || []).slice(0, 3);
    const extra = missing.length
      ? '（样式含未支持特性：' + missing.join('、') + '，个别字段可能缺失）'
      : '';
    window.App && App.toast && App.toast('已导入样式：' + (r.label || r.id) + extra, 6000);
  }

  // ---------- 已导入 CSL 样式的管理（删除入口） ----------
  // 删除 = 删掉 <数据目录>/styles/<id>.csl，扫描列表由主进程重扫后返回，
  // 所以这里不自己维护列表，永远以 cslStyles() 的结果为准。
  function cslImportedList() {
    if (!window.Cite || !Cite.styleList) return [];
    return Cite.styleList().filter((s) => s.kind === 'user');
  }

  function renderCslManager() {
    if (!el.cslManager) return;
    const list = cslImportedList();
    if (!list.length) {
      el.cslManager.innerHTML = '<div class="csl-empty">还没有导入过 CSL 样式。点「导入 CSL…」从 zotero.org/styles 下载的 .csl 可以直接用。</div>';
      return;
    }
    el.cslManager.innerHTML = list.map((s) => {
      const warn = (s.warnings && s.warnings.length) ? ' title="样式含未支持特性：' + esc(s.warnings.slice(0, 3).join('、')) + '"' : '';
      return '<div class="csl-row" data-csl-id="' + esc(s.id) + '">' +
        '<span class="csl-name"' + warn + '>' + esc(s.label) + '</span>' +
        '<span class="csl-id">' + esc(s.id) + '</span>' +
        '<button class="ld-mini" data-csl-del="' + esc(s.id) + '">删除</button>' +
        '</div>';
    }).join('');
  }

  async function removeCslStyle(id) {
    if (!L() || !L().cslRemove) return;
    const r = await L().cslRemove(id);
    if (!r || !r.ok) {
      window.App && App.toast && App.toast('删除失败：' + ((r && r.error) || '未知错误'), 5000);
      return;
    }
    if (window.Cite && Cite.registerCslStyles) Cite.registerCslStyles(r.styles || []);
    // 正在用的样式被删了就退回 GB/T，别让下拉停在幽灵选项上
    if (state.citeStyle === 'csl:' + id) state.citeStyle = 'gbt7714';
    fillStyleSelects();
    renderCslManager();
    if (el.bib && el.bib.modal && !el.bib.modal.hidden) renderBib();
    if (el.detail && !el.detail.hidden) renderDetail();
    window.App && App.toast && App.toast('已删除样式：' + id);
  }

  function bibStyleId() {
    return (el.bib && el.bib.style.value) || state.citeStyle || 'gbt7714';
  }

  function bibScopeItems() {
    const scope = (el.bib && el.bib.scope.value) || 'list';
    if (scope === 'selected') return state.items.filter((x) => state.selectedKeys.has(x.key) && !x.deletedAt);
    if (scope === 'all') return state.items.filter((x) => !x.deletedAt);
    return visibleItems().filter((x) => !x.deletedAt);
  }

  function bibOrder() {
    const v = (el.bib && el.bib.order.value) || 'auto';
    if (v === 'author' || v === 'entry') return v;
    return window.Bib ? window.Bib.defaultOrder(bibStyleId()) : 'entry';
  }

  function currentBibliography() {
    if (!window.Bib || !el.bib) return { text: '', count: 0, skipped: 0, entries: [] };
    const fmt = el.bib.format.value;
    return window.Bib.build(bibScopeItems(), {
      style: bibStyleId(),
      order: bibOrder(),
      format: fmt,
      includeKeys: el.bib.keys.checked,
      title: el.bib.title.value.trim(),
      // 用整库分配好的 citekey，避免只选部分条目时出现不同的 -2 后缀
      citekeys: state.citekeys,
    });
  }

  function renderBib() {
    if (!el.bib || el.bib.modal.hidden) return;
    const r = currentBibliography();
    const fmt = el.bib.format.value;
    // html / word / rtf 的「复制」复制的是源码本身（剪贴板是纯文本，粘进 Word 会是源码），
    // 所以标签写清楚，真正要 Word 文档请用「保存为文件…」。
    const COPY_LABEL = { markdown: '复制 Markdown', text: '复制纯文本', html: '复制 HTML', word: '复制 HTML 源码', rtf: '复制 RTF 源码' };
    const scopeName = { list: '当前列表', selected: '已选条目', all: '整库' }[el.bib.scope.value] || '当前列表';
    el.bib.preview.value = r.text || '';
    el.bib.copy.textContent = COPY_LABEL[fmt] || '复制';
    let meta = r.count
      ? r.count + ' 条 · ' + scopeName + ' · ' + (r.styleLabel || '')
      : scopeName + '里没有可生成的条目';
    if (r.skipped) meta += ' · 跳过 ' + r.skipped + ' 条（无标题/已删除）';
    el.bib.count.textContent = meta;
    el.bib.copy.disabled = r.count === 0;
    el.bib.save.disabled = r.count === 0;
    el.bib.status.textContent = '';
  }

  function openBib(preferSelected) {
    if (!el.bib) return;
    if (!state.items.some((x) => !x.deletedAt)) {
      window.App && window.App.toast && window.App.toast('库里还没有条目');
      return;
    }
    if (el.bib.style && !el.bib.style.options.length) fillStyleSelects();
    const sel = state.selectedKeys.size;
    const opt = el.bib.scope.querySelector('option[value="selected"]');
    if (opt) {
      opt.disabled = sel === 0;
      opt.textContent = sel ? '已选条目（' + sel + '）' : '已选条目（未选）';
    }
    el.bib.style.value = state.citeStyle || 'gbt7714';
    el.bib.scope.value = (preferSelected || sel) ? 'selected' : 'list';
    if (el.bib.scope.value === 'selected' && !sel) el.bib.scope.value = 'list';
    el.bib.order.value = 'auto';
    el.bib.format.value = 'markdown';
    el.bib.keys.checked = false;
    el.bib.title.value = '参考文献';
    el.bib.modal.hidden = false;
    // 管理面板默认收起：多数时候只是来复制参考文献，别一开就占掉一截高度
    if (el.cslManager) el.cslManager.hidden = true;
    renderBib();
    setTimeout(() => { if (el.bib && !el.bib.modal.hidden) el.bib.preview.focus(); }, 30);
  }

  function closeBib() {
    if (el.bib) el.bib.modal.hidden = true;
  }

  async function copyBibliography() {
    const r = currentBibliography();
    if (!r.count || !window.pdfBridge || !window.pdfBridge.copyText) return;
    const FMT_NAME = { markdown: ' Markdown', text: '纯文本', html: ' HTML', word: ' Word（HTML 源码）', rtf: ' RTF' };
    const label = FMT_NAME[el.bib.format.value] || '纯文本';
    try {
      const res = await window.pdfBridge.copyText(r.text);
      if (res && res.ok) {
        el.bib.status.textContent = '已复制 ' + r.count + ' 条' + label + '到剪贴板';
        window.App && window.App.toast && window.App.toast('参考文献表已复制');
      } else {
        el.bib.status.textContent = '复制失败';
      }
    } catch (_) {
      el.bib.status.textContent = '复制失败';
    }
  }

  async function saveBibliography() {
    const r = currentBibliography();
    if (!r.count) return;
    if (!window.pdfBridge || !window.pdfBridge.saveText) {
      el.bib.status.textContent = '当前环境不能保存文件';
      return;
    }
    const fmt = el.bib.format.value;
    try {
      const res = await window.pdfBridge.saveText({
        text: r.text,
        format: fmt,
        defaultName: 'Trove-参考文献-' + new Date().toISOString().slice(0, 10),
      });
      if (res && res.ok) {
        el.bib.status.textContent = '已保存：' + res.path;
        window.App && window.App.toast && window.App.toast('参考文献表已保存');
      } else if (res && !res.canceled) {
        el.bib.status.textContent = '保存失败：' + (res.error || '未知错误');
      }
    } catch (err) {
      el.bib.status.textContent = '保存失败：' + (err && err.message ? err.message : err);
    }
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
      back: $('lib-back'),   // 「阅读」分段（点击由 modeswitch.js 处理）
      tagList: $('lib-tags'),
      newColl: $('lib-new-coll'), scopeTitle: $('lib-scope-title'), count: $('lib-count'),
      import: $('lib-import'), grid: $('lib-grid'), empty: $('lib-empty'),
      sort: $('lib-sort'), emptyTrash: $('lib-empty-trash'),
      ft: $('lib-ft'), bulk: $('lib-bulk'), bulkCount: $('lib-bulk-count'), selectAll: $('lib-select-all'),
      columns: document.querySelector('#lib-main .lib-columns'),
      bulkEdit: $('lib-bulk-edit'), bulkBib: $('lib-bulk-bib'), bulkTrash: $('lib-bulk-trash'),
      bulkFetch: $('lib-bulk-fetch'),
      annoTools: $('lib-anno-tools'), annoTagInput: $('lib-anno-tag-input'), annoFilter: $('lib-anno-filter'),
      annoTagAdd: $('lib-anno-tag-add'), annoExport: $('lib-anno-export'), annoNote: $('lib-anno-note'),
      dup: $('lib-dup'), importRefs: $('lib-import-refs'), exportRefs: $('lib-export-refs'),
      newNote: $('lib-new-note'), undo: $('lib-undo'), redo: $('lib-redo'),
      settingsBtn: $('lib-settings'),
      settingsModal: $('settings-modal'), setTheme: $('set-theme'), setSort: $('set-sort'), setViewMode: $('set-view-mode'),
      setAutoIndex: $('set-auto-index'), setRestoreTabs: $('set-restore-tabs'), setInvertPages: $('set-invert-pages'), setFetchEmail: $('set-fetch-email'), setDataDir: $('set-data-dir'), setStatus: $('set-status'),
      setFtStatus: $('set-ft-status'), setIndex: $('set-index'), setReindex: $('set-reindex'),
      dupModal: $('dup-modal'), dupBody: $('dup-body'), dupStatus: $('dup-status'),
      bulkModal: $('bulk-modal'), bulkTitle: $('bulk-title'), bulkType: $('bulk-type'), bulkColl: $('bulk-add-coll'),
      bulkYear: $('bulk-year'), bulkPublication: $('bulk-publication'),
      bulkAddTags: $('bulk-add-tags'), bulkRemoveTags: $('bulk-remove-tags'), bulkStatus: $('bulk-status'),
      detail: $('lib-detail'), ld: {
        kind: $('ld-kind'),
        body: $('ld-body'),
        type: $('ld-type'), title: $('ld-title'), creators: $('ld-creators'), creatorAdd: $('ld-creator-add'), year: $('ld-year'),
        publication: $('ld-publication'), volume: $('ld-volume'), issue: $('ld-issue'), pages: $('ld-pages'),
        doi: $('ld-doi'), url: $('ld-url'), abstract: $('ld-abstract'),
        notes: $('ld-notes'), noteAdd: $('ld-note-add'),
        annos: $('ld-annos'),
        tags: $('ld-tags'), tagInput: $('ld-tag-input'), tagAdd: $('ld-tag-add'),
        colls: $('ld-colls'), attach: $('ld-attach'), dates: $('ld-dates'), status: $('ld-status'),
        fetch: $('ld-fetch'), fetchPdf: $('ld-fetch-pdf'), fetchStatus: $('ld-fetch-status'),
        snapshot: $('ld-snapshot'), snapshotOpen: $('ld-snapshot-open'),
        save: $('ld-save'), trash: $('ld-trash'), restore: $('ld-restore'),
        del: $('ld-delete'), close: $('ld-close'),
        citeStyle: $('ld-cite-style'), citeCopy: $('ld-cite-copy'),
        citeStatus: $('ld-cite-status'), citePreview: $('ld-cite-preview'),
        citekey: $('ld-citekey'), citekeyCopy: $('ld-citekey-copy'),
        citekeyAt: $('ld-citekey-at'), citekeyStatus: $('ld-citekey-status'),
        relations: $('ld-relations'), relSelect: $('ld-rel-select'), relAdd: $('ld-rel-add'),
      },
      bib: {
        modal: $('bib-modal'), style: $('bib-style'), scope: $('bib-scope'),
        order: $('bib-order'), format: $('bib-format'), keys: $('bib-keys'),
        title: $('bib-title'), preview: $('bib-preview'), count: $('bib-count'),
        copy: $('bib-copy'), save: $('bib-save'), status: $('bib-status'),
        cslImport: $('bib-csl-import'), cslManage: $('bib-csl-manage'),
        close: $('bib-close'), close2: $('bib-close2'),
      },
      cslManager: $('csl-manager'),
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
    el.import.addEventListener('click', addDocuments);
    // 右键菜单 / 颜色浮层：点别处或滚动就收起
    document.addEventListener('mousedown', (e) => {
      if (cardMenu && !cardMenu.contains(e.target)) closeCardMenu();
    }, true);
    document.addEventListener('scroll', () => { closeCardMenu(); closeColorPop(); }, true);
    // v23：阅读笔记（新建 / 编辑 / 删除）。v9：正文改为富文本 contenteditable
    if (el.ld.notes) {
      // 工具栏按钮不要抢走编辑器的焦点
      el.ld.notes.addEventListener('mousedown', (e) => {
        if (e.target.closest('[data-rt]')) e.preventDefault();
      });
      el.ld.notes.addEventListener('change', async (e) => {
        const box = e.target.closest('[data-note-id]');
        if (!box) return;
        // R04：子笔记导出——导出前先落盘，导出的内容必须和库里的一致
        if (e.target.classList.contains('ld-note-export')) {
          const fmt = e.target.value;
          e.target.value = '';
          if (!fmt || !window.pdfBridge || !window.pdfBridge.exportNoteBundle) return;
          const key = state.selectedKey;
          if (!key) return;
          // 这条笔记可能有未落盘的编辑，先保存
          const rich = box.querySelector('.ld-note-rich');
          if (rich) saveNoteRich(box, true);
          const r = await window.pdfBridge.exportNoteBundle({ key, noteId: box.dataset.noteId, fmt, title: '' });
          if (r && r.ok) window.App && window.App.toast && window.App.toast(r.images ? '笔记已导出（含 ' + r.images + ' 张图片）' : '笔记已导出');
          else if (r && !r.canceled && window.App && window.App.toast) window.App.toast('导出失败：' + ((r && r.error) || '未知错误'));
          return;
        }
        // 段落样式下拉（正文 / 标题 / 小标题 / 引用）
        if (e.target.matches('select[data-rt="formatBlock"]')) {
          const rich = box.querySelector('.ld-note-rich');
          if (rich) {
            rich.focus();
            document.execCommand('formatBlock', false, '<' + e.target.value + '>');
            saveNoteRich(box, true);
          }
          return;
        }
        const field = e.target.dataset.noteField;
        if (field !== 'title') return;
        const key = state.selectedKey;
        if (!key) return;
        await L().updateNote(key, box.dataset.noteId, { title: e.target.value });
        await reloadItemsQuiet();
      });
      // 正文输入 → 防抖保存；失焦 → 立刻保存
      el.ld.notes.addEventListener('input', (e) => {
        const rich = e.target.closest('.ld-note-rich');
        if (rich) saveNoteRich(rich.closest('[data-note-id]'), false);
      });
      el.ld.notes.addEventListener('focusout', (e) => {
        const rich = e.target.closest('.ld-note-rich');
        if (rich) saveNoteRich(rich.closest('[data-note-id]'), true);
      });
      // 从 Word / 网页粘贴：先清洗再插入，别把外部样式和脚本带进来
      el.ld.notes.addEventListener('paste', (e) => {
        const rich = e.target.closest('.ld-note-rich');
        if (!rich) return;
        e.preventDefault();
        const html = (e.clipboardData && e.clipboardData.getData('text/html')) || '';
        const text = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
        if (html && window.RichText) {
          document.execCommand('insertHTML', false, window.RichText.sanitize(html));
        } else if (text) {
          document.execCommand('insertText', false, text);
        }
        saveNoteRich(rich.closest('[data-note-id]'), false);
      });
      el.ld.notes.addEventListener('click', async (e) => {
        const openEd = e.target.closest('[data-open-note-editor]');
        if (openEd) { openNoteEditor(state.selectedKey); return; }
        // v9：Markdown 预览切换 / 预览里的外链
        // 富文本工具栏（加粗 / 斜体 / 下划线 / 段落样式 / 列表 / 链接 / 清除格式）
        const rt = e.target.closest('[data-rt]');
        if (rt && rt.tagName === 'BUTTON') {
          const noteEl = rt.closest('[data-note-id]');
          const box = noteEl && noteEl.querySelector('.ld-note-rich');
          if (!noteEl || !box) return;
          box.focus();
          const cmd = rt.dataset.rt;
          if (cmd === 'createLink') {
            const sel = window.getSelection();
            if (!sel || sel.isCollapsed) {
              window.App && window.App.toast && window.App.toast('先选中要变成链接的文字');
              return;
            }
            inlineInput(rt, 'https://', (url) => {
              if (!/^(https?:\/\/|mailto:)/i.test(url)) {
                window.App && window.App.toast && window.App.toast('只支持 http/https/mailto 链接');
                return;
              }
              box.focus();
              document.execCommand('createLink', false, url);
              saveNoteRich(noteEl, true);
            });
            return;
          }
          document.execCommand(cmd, false, null);
          box.focus();
          saveNoteRich(noteEl, true);
          return;
        }
        // 富文本里的链接点一下就打开（编辑时要按住 Alt 才点）
        const link = e.target.closest('.ld-note-rich a');
        if (link) {
          e.preventDefault();
          const url = link.getAttribute('href') || '';
          if (e.altKey && window.pdfBridge && window.pdfBridge.openExternal) {
            const r = await window.pdfBridge.openExternal(url);
            if (!r || !r.ok) window.App && window.App.toast && window.App.toast('打不开这个链接：' + ((r && r.error) || url));
          } else {
            window.App && window.App.toast && window.App.toast('编辑状态下按住 Alt 再点链接可打开');
          }
          return;
        }
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
        const n = await L().addNote(key, { title: '', text: '', html: '' });
        await reloadItemsQuiet();
        const it = state.items.find((x) => x.key === key);
        if (it) renderNotes(it);
        if (n && el.ld.notes) {
          const box = el.ld.notes.querySelector('[data-note-id="' + n.id + '"] .ld-note-rich');
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
    // 「添加作者」：加一行空的（姓、名、角色），填完再保存
    if (el.ld.creatorAdd) {
      el.ld.creatorAdd.addEventListener('click', () => {
        const box = el.ld.creators;
        if (!box) return;
        const hint = box.querySelector('.ld-hint');
        if (hint) hint.remove();
        const row = creatorRow({ lastName: '', firstName: '', creatorType: 'author' });
        box.appendChild(row);
        const input = row.querySelector('.ld-cr-last');
        if (input) input.focus();
      });
    }
    // 「返回阅读」由 modeswitch.js 统一处理（切模式时高亮块先滑过去，再收起库）
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
      // v33：类型切换片 + 「展开更多」；行点击仍走原来的跳页逻辑
      const chip = e.target.closest('[data-ft-type]');
      if (chip) {
        // 已展开深度跨类型保留：切走再切回来，不用重新点「展开更多」
        state.ft.type = chip.dataset.ftType || 'all';
        renderFt();
        return;
      }
      if (e.target.closest('[data-ft-more]')) { ftMore(); return; }
      const row = e.target.closest('[data-ft-key]');
      // v9：点全文结果 → 打开到那一页，并把搜索词在页面上高亮出来
      if (row) openItem(row.dataset.ftKey, +row.dataset.ftPage || 1, { highlight: state.query.trim() });
    });
    // v33：标注筛选条 —— 点类型 / 颜色片切换（再点一次取消），「清除筛选」复位
    if (el.annoFilter) el.annoFilter.addEventListener('click', (e) => {
      const clear = e.target.closest('[data-anno-clear]');
      if (clear) {
        state.annoFilter.kinds.clear();
        state.annoFilter.colors.clear();
        render();
        return;
      }
      const kindBtn = e.target.closest('[data-anno-kind]');
      if (kindBtn) {
        const k = kindBtn.dataset.annoKind;
        state.annoFilter.kinds.has(k) ? state.annoFilter.kinds.delete(k) : state.annoFilter.kinds.add(k);
        render();
        return;
      }
      const colorBtn = e.target.closest('[data-anno-color]');
      if (colorBtn) {
        const c = colorBtn.dataset.annoColor;
        state.annoFilter.colors.has(c) ? state.annoFilter.colors.delete(c) : state.annoFilter.colors.add(c);
        render();
      }
    });
    if (el.dup) el.dup.addEventListener('click', openDuplicates);
    if (el.importRefs) el.importRefs.addEventListener('click', importRefs);
    if (el.exportRefs) el.exportRefs.addEventListener('click', exportRefs);
    if (el.newNote) el.newNote.addEventListener('click', newNoteItem);
    if (el.undo) el.undo.addEventListener('click', () => doUndo(false));
    if (el.redo) el.redo.addEventListener('click', () => doUndo(true));
    if (el.settingsBtn) el.settingsBtn.addEventListener('click', openSettings);

    // 全屏笔记编辑器（Markdown）
    const nvBack = $('nv-back');
    if (nvBack) nvBack.addEventListener('click', closeNoteEditor);
    // v33：模板 / 导出下拉——用完归位到「模板…」/「导出…」，同一项可以连续用
    const nvTpl = $('nv-template');
    if (nvTpl) nvTpl.addEventListener('change', () => {
      if (nvTpl.value) { nvApplyTemplate(nvTpl.value); nvTpl.value = ''; }
    });
    const nvExportSel = $('nv-export');
    if (nvExportSel) nvExportSel.addEventListener('change', () => {
      if (nvExportSel.value) { const f = nvExportSel.value; nvExportSel.value = ''; nvExportNote(f); }
    });
    const nvSaveBtn = $('nv-save');
    if (nvSaveBtn) nvSaveBtn.addEventListener('click', async () => {
      const saved = await nvSaveNow();
      if (saved && window.App && window.App.toast) window.App.toast('笔记已保存');
    });
    const nvTitle = $('nv-title');
    if (nvTitle) nvTitle.addEventListener('input', nvScheduleSave);
    const nvMd = $('nv-md');
    if (nvMd) {
      nvMd.addEventListener('input', () => { nvScheduleSave(); nvSchedulePreview(); });
      nvMd.addEventListener('focusout', nvSaveNow);
      nvMd.addEventListener('keydown', (e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        const k = (e.key || '').toLowerCase();
        if (k === 'b') { e.preventDefault(); nvInsertSnippet('bold'); }
        else if (k === 'i') { e.preventDefault(); nvInsertSnippet('italic'); }
        else if (k === 'u') { e.preventDefault(); nvInsertSnippet('underline'); }
      });
    }
    const nvToolbar = $('nv-toolbar');
    if (nvToolbar) {
      // 点按钮别抢走编辑器的焦点（否则选区会丢）
      nvToolbar.addEventListener('mousedown', (e) => {
        if (e.target.closest('.toolbar-btn')) e.preventDefault();
      });
      nvToolbar.addEventListener('click', (e) => {
        const btn = e.target.closest('.toolbar-btn[data-action]');
        if (!btn) return;
        nvInsertSnippet(btn.dataset.action);
      });
    }
    // 预览交互：剧透点击显示 / 脚注跳转 / 外链（博客预览同款行为）
    const nvPreview = $('nv-preview');
    if (nvPreview) {
      nvPreview.addEventListener('click', async (e) => {
        const sp = e.target.closest('[data-spoiler]');
        if (sp) { sp.classList.toggle('revealed'); return; }
        const fnj = e.target.closest('[data-fnjump]');
        if (fnj) {
          const target = nvPreview.querySelector('[id="' + (fnj.dataset.fnjump || '').replace(/"/g, '') + '"]');
          if (target && target.scrollIntoView) target.scrollIntoView({ block: 'center' });
          return;
        }
        const link = e.target.closest('[data-md-link]');
        if (link) {
          e.preventDefault();
          const url = link.dataset.mdLink || '';
          if (window.pdfBridge && window.pdfBridge.openExternal) {
            const r = await window.pdfBridge.openExternal(url);
            if (!r || !r.ok) window.App && window.App.toast && window.App.toast('打不开这个链接：' + ((r && r.error) || url));
          }
        }
      });
    }
    const nvPreviewToggle = $('nv-preview-toggle');
    if (nvPreviewToggle) nvPreviewToggle.addEventListener('click', () => {
      const hidden = document.body.classList.toggle('nv-preview-hidden');
      nvPreviewToggle.setAttribute('aria-pressed', hidden ? 'false' : 'true');
    });
    document.addEventListener('keydown', (e) => {
      if (!nv.open) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        closeNoteEditor();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        nvSaveNow().then(saved => { if (saved && window.App && window.App.toast) window.App.toast('笔记已保存'); });
      }
    });

    // 参考文献表
    if (el.bib && el.bib.modal) {
      el.bib.close.addEventListener('click', closeBib);
      el.bib.close2.addEventListener('click', closeBib);
      const bibTop = $('lib-bib');
      if (bibTop) bibTop.addEventListener('click', () => openBib(false));
      const bibBulk = $('lib-bulk-bib');
      if (bibBulk) bibBulk.addEventListener('click', () => openBib(true));
      for (const key of ['style', 'scope', 'order', 'format']) {
        el.bib[key].addEventListener('change', () => {
          if (key === 'style') {
            state.citeStyle = el.bib.style.value;
            if (el.ld.citeStyle) el.ld.citeStyle.value = state.citeStyle;
          }
          renderBib();
        });
      }
      el.bib.title.addEventListener('input', renderBib);
      el.bib.keys.addEventListener('change', renderBib);
      el.bib.copy.addEventListener('click', copyBibliography);
      el.bib.save.addEventListener('click', saveBibliography);
      if (el.bib.cslImport) el.bib.cslImport.addEventListener('click', importCslStyle);
      if (el.bib.cslManage) {
        el.bib.cslManage.addEventListener('click', () => {
          el.cslManager.hidden = !el.cslManager.hidden;
          if (!el.cslManager.hidden) renderCslManager();
        });
      }
      if (el.cslManager) {
        el.cslManager.addEventListener('click', (e) => {
          const btn = e.target.closest && e.target.closest('[data-csl-del]');
          if (btn) removeCslStyle(btn.getAttribute('data-csl-del'));
        });
      }
    }

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
      const bulkRename = $('lib-bulk-rename');
      if (bulkRename) bulkRename.addEventListener('click', bulkRenameFiles);
      if (el.bulkFetch) el.bulkFetch.addEventListener('click', bulkFetchPdfs);
      $('lib-bulk-clear').addEventListener('click', () => { state.selectedKeys.clear(); renderGrid(); renderBulk(); });
      // 标注视图的批量动作
      if (el.annoTagAdd) el.annoTagAdd.addEventListener('click', tagSelectedAnnos);
      if (el.annoExport) el.annoExport.addEventListener('click', exportAnnos);
      if (el.annoNote) el.annoNote.addEventListener('click', notesFromSelectedAnnos);
      if (el.annoTagInput) {
        el.annoTagInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); tagSelectedAnnos(); }
        });
      }
    }

    // 详情：DOI/arXiv 抓取
    if (el.ld.fetch) el.ld.fetch.addEventListener('click', fetchMetadata);
    if (el.ld.fetchPdf) el.ld.fetchPdf.addEventListener('click', fetchPdfFull);
    if (el.ld.snapshot) el.ld.snapshot.addEventListener('click', snapshotPage);
    if (el.ld.snapshotOpen) el.ld.snapshotOpen.addEventListener('click', openSnapshot);

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
        if (t === 'annotations') {
          // 标注本体在磁盘上，进这个视图时重新读一遍
          loadAnnos(true).then(() => render());
          return;
        }
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

    // v9：打开语义统一入口 —— 笔记进详情，其余进阅读
    let lastClickKey = '', lastClickAt = 0, skipNextDbl = 0;
    function openByKey(key) {
      const it = state.items.find((x) => x.key === key);
      if (it && it.itemType === 'note' && !it.attachment) { openNoteEditor(key); return; }
      openItem(key);
    }

    // 卡片：打开 / 详情 / 改名 / 标签 / 回收站
    el.grid.addEventListener('click', async (e) => {
      const detailBtn = e.target.closest('[data-detail]');
      if (detailBtn) { openDetail(detailBtn.dataset.detail); return; }
      const openNoteBtn = e.target.closest('[data-open-note]');
      if (openNoteBtn) { e.stopPropagation(); openNoteEditor(openNoteBtn.dataset.openNote); return; }
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
      if (rmTag) {
        // 标注的标签在标注对象层（annoMeta），不走条目的 tags
        if (rmTag.dataset.rmtag.startsWith(ANNO_PREFIX)) {
          const id = rmTag.dataset.rmtag.slice(ANNO_PREFIX.length);
          await window.pdfBridge.removeAnnoTag(id, rmTag.dataset.tag);
          await refresh();
          return;
        }
        await L().removeTag(rmTag.dataset.rmtag, rmTag.dataset.tag);
        await refresh();
        return;
      }
      // v14：点卡片上的标签 = 按这个标签筛选（别顺手把 PDF 打开了）
      const tagFilter = e.target.closest('[data-tag-filter]');
      if (tagFilter) { e.stopPropagation(); toggleTagFilter(tagFilter.dataset.tagFilter); return; }
      const addTag = e.target.closest('[data-addtag]');
      if (addTag) {
        inlineInput(addTag, '', async (tag) => {
          if (addTag.dataset.addtag.startsWith(ANNO_PREFIX)) {
            const id = addTag.dataset.addtag.slice(ANNO_PREFIX.length);
            await window.pdfBridge.setAnnoTags(id, annoTagsOf(id).concat([tag]));
          } else {
            await L().addTag(addTag.dataset.addtag, tag);
          }
          await refresh();
        });
        return;
      }
      // 点标注 = 打开到那一页
      const annoOpen = e.target.closest('[data-anno-open]');
      if (annoOpen) { openAnno(annoOpen.dataset.annoOpen); return; }
      // 阶段二：编辑标注文字 / 批注
      const annoEdit = e.target.closest('[data-anno-edit]');
      if (annoEdit) { e.stopPropagation(); openAnnoEdit(annoEdit.dataset.annoEdit); return; }
      // 点标注上的「所属条目」跳到那个条目
      const annoItem = e.target.closest('[data-anno-item]');
      if (annoItem) {
        e.stopPropagation();
        state.scope = { type: 'all' };
        const k = annoItem.dataset.annoItem;
        state.selectedKey = k;
        render();
        const cardEl = el.grid.querySelector('.lib-card[data-key="' + k.replace(/"/g, '') + '"]');
        if (cardEl && cardEl.scrollIntoView) cardEl.scrollIntoView({ block: 'nearest' });
        return;
      }
      // 2026-10-21：点标题不再重命名（和整行一样进阅读）；重命名走详情面板标题字段
      if (e.target.closest('button') || e.target.closest('input') || e.target.closest('.lc-check')) return;
      const card = e.target.closest('.lib-card');
      if (!card || !card.dataset.key) return;
      const key = card.dataset.key;
      if (key.startsWith(ANNO_PREFIX)) { selectCard(key, e); return; }
      const it = state.items.find((x) => x.key === key);
      const isNoteItem = !!(it && it.itemType === 'note' && !it.attachment);
      // v9.5：笔记单击只选中（不再打开右侧详情栏），双击进全屏编辑器 —— 和「打开文件」一致
      if (isNoteItem) {
        closeDetail();          // 会清 selectedKey，所以先关再设
        state.selectedKeys.clear();
        state.selectedKey = key;
        markSelection();
        return;
      }
      // 其他条目：单击选中，双击打开。这里用时间戳兜底一次——
      // 第一次单击会打开详情面板、网格宽度变化，浏览器有时不会补发 dblclick
      const now = Date.now();
      const doubleHit = lastClickKey === key && (now - lastClickAt) < 520;
      lastClickKey = key;
      lastClickAt = now;
      if (doubleHit) {
        skipNextDbl = Date.now() + 900;
        openByKey(key);
        return;
      }
      selectCard(key, e);
    });

    // 双击打开（Zotero 的列表行为：单击选中，双击进阅读）
    el.grid.addEventListener('dblclick', (e) => {
      if (Date.now() < skipNextDbl) return;   // click 里的双击兜底已经处理过
      if (e.target.closest('button') || e.target.closest('input') || e.target.closest('.lc-check')) return;
      const card = e.target.closest('.lib-card[data-open]');
      if (!card) return;
      openByKey(card.dataset.open);
    });

    // 右键菜单
    el.grid.addEventListener('contextmenu', (e) => {
      const card = e.target.closest('.lib-card[data-key]');
      if (!card) return;
      if (card.dataset.key.startsWith(ANNO_PREFIX)) return;   // 标注没有条目菜单
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

    // 详情里的标注：点一下打开到那一页
    if (el.ld.annos) {
      el.ld.annos.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-ld-anno-page]');
        if (!b) return;
        const it = selectedItem();
        if (!it) return;
        const res = await L().openItem(it.key, +b.dataset.ldAnnoPage || 1);
        if (!res || !res.ok) {
          window.App && window.App.toast && window.App.toast('打开失败：' + ((res && res.error) || '未知错误'));
          return;
        }
        hide();
        if (typeof window.__libOpen === 'function') window.__libOpen(res);
      });
    }

    // 详情附件动作（内容是动态渲染的，用委托）
    el.ld.attach.addEventListener('click', async (e) => {
      const it = selectedItem(); if (!it) return;
      if (e.target.closest('[data-ld-reveal]')) {
        const r = await L().revealItem(it.key);
        if (!r || !r.ok) window.App && window.App.toast && window.App.toast('无法定位：' + ((r && r.error) || '未知错误'));
      } else if (e.target.closest('[data-ld-rename]')) {
        const r = await L().renameFile([it.key]);
        if (r && r.renamed) {
          await refresh();
          el.ld.status.textContent = '已重命名：' + ((r.changes[0] || {}).newPath || '');
        } else if (r && r.ok) {
          el.ld.status.textContent = '文件名已经是这个规则了，不用改';
        } else {
          window.App && window.App.toast && window.App.toast('重命名失败：' + ((r && r.errors && r.errors[0] && r.errors[0].error) || '未知错误'));
        }
      } else if (e.target.closest('[data-ld-relink]')) {
        const r = await L().relinkItem(it.key);
        if (r && r.ok) { await refresh(); el.ld.status.textContent = '附件已重新定位'; }
        else if (r && !r.canceled) window.App && window.App.toast && window.App.toast('重新定位失败：' + (r.error || '未知错误'));
      }
    });

    // 库内快捷键：Ctrl+F 搜标题/摘要；Esc 逐层关闭（弹窗 → 详情 → 整个库）
    // 注意：不能一上来就 if (!isOpen()) return —— 库已经收起、但设置弹窗还留在
    // 阅读器上时（loadPdf 会调 hide()），Esc 就再也关不掉那个弹窗了。
    // 编辑标注弹窗（阶段二）
    const aeModal = $('anno-edit-modal');
    if (aeModal) {
      const ax = $('anno-edit-x'); if (ax) ax.addEventListener('click', closeAnnoEdit);
      const ac = $('anno-edit-cancel'); if (ac) ac.addEventListener('click', closeAnnoEdit);
      const as = $('anno-edit-save'); if (as) as.addEventListener('click', saveAnnoEdit);
      aeModal.addEventListener('click', (e) => { if (e.target === aeModal) closeAnnoEdit(); });
      // Ctrl+Enter 保存，省得摸鼠标
      aeModal.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); saveAnnoEdit(); }
      });
    }

    document.addEventListener('keydown', (e) => {
      const modalOpen = (el.settingsModal && !el.settingsModal.hidden)
        || (el.dupModal && !el.dupModal.hidden)
        || (el.bib && el.bib.modal && !el.bib.modal.hidden)
        || (el.bulkModal && !el.bulkModal.hidden)
        || (aeModal && !aeModal.hidden);
      if (!isOpen() && !modalOpen) return;
      // v9：撤销 / 重做（输入框里让浏览器自己处理，别抢 Ctrl+Z）
      if ((e.ctrlKey || e.metaKey) && !modalOpen && /^[zZyY]$/.test(e.key)) {
        const t = e.target;
        if (t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]')) return;
        e.preventDefault();
        const isRedo = (e.key === 'y' || e.key === 'Y') || e.shiftKey;
        doUndo(isRedo);
        return;
      }
      if (e.ctrlKey && (e.key === 'f' || e.key === 'F')) {
        if (!isOpen() || nv.open) return;
        e.preventDefault(); e.stopPropagation();
        el.search.focus(); el.search.select();
      } else if (isOpen() && !modalOpen && !nv.open && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter')) {
        const t = e.target;
        const typing = t && (t.closest('input, textarea, select, [contenteditable="true"]'));
        if (typing || (e.key === 'Enter' && t && t.closest('button, a'))) return;
        if (e.key === 'Enter') {
          if (!state.selectedKey) return;
          e.preventDefault();
          openByKey(state.selectedKey);   // 笔记条目走全屏编辑器，别去开附件
          return;
        }
        const list = visibleItems().filter((x) => !x.deletedAt);
        if (!list.length) return;
        e.preventDefault();
        let i = list.findIndex((x) => x.key === state.selectedKey);
        if (i < 0) i = e.key === 'ArrowDown' ? -1 : list.length;
        i = Math.max(0, Math.min(list.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)));
        state.selectedKey = list[i].key;
        if (gridWindow) gridWindow.ensure(state.selectedKey);
        markSelection(); renderDetail();
        const card = el.grid.querySelector('.lib-card.selected');
        if (card && card.scrollIntoView) card.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Escape') {
        // 全屏笔记编辑器开着时，Esc 只关它（由编辑器自己的 keydown 处理），
        // 不能顺手把整个文献库收掉、把人丢到空白阅读页
        if (nv.open) return;
        if (cardMenu || colorPop) { e.preventDefault(); closeCardMenu(); closeColorPop(); return; }
        if (el.settingsModal && !el.settingsModal.hidden) { e.preventDefault(); closeSettings(); }
        else if (el.dupModal && !el.dupModal.hidden) { e.preventDefault(); el.dupModal.hidden = true; }
        else if (el.bib && el.bib.modal && !el.bib.modal.hidden) { e.preventDefault(); closeBib(); }
        else if (el.bulkModal && !el.bulkModal.hidden) { e.preventDefault(); el.bulkModal.hidden = true; }
        else if (aeModal && !aeModal.hidden) { e.preventDefault(); closeAnnoEdit(); }
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

  // 覆盖层进出场：用 Web Animations API 驱动，只动 transform / opacity（合成器搬运，不重绘）。
  // 关键是有兜底：Electron 窗口被遮挡时动画时间线会停住，纯 CSS animation 会把元素钉死在
  // opacity 0（界面看起来就是"闪一下没了"）。这里无论时间线停没停，到点都强制收尾。
  let layerAnim = null;
  let layerAnimTimer = null;
  let layerSeq = 0;          // 淡出 / 淡入的序号，用来作废过期的收尾回调
  let leaving = false;       // 正在淡出
  let layerDir = '';         // 当前动画方向：leave / enter
  let layerDone = [];        // 同一次动画的收尾回调（同方向重复调用只追加，不重启计时）
  const REDUCED_MOTION = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function animateLayer(dir, done) {
    if (!el.root) { if (done) done(); return; }
    // 已经在往同一方向演：只挂收尾回调，别重启动画和定时器。
    // 打开条目时 hide() 会被调两次（点条目 + loadPdf 收尾），重启计时会让
    // 覆盖层多停 220ms，看起来就是"点了文档要等一下才进阅读"。
    if (dir === 'leave' && layerDir === 'leave' && layerAnim) {
      if (done) layerDone.push(done);
      return;
    }
    layerDone = done ? [done] : [];
    layerDir = dir;
    if (layerAnimTimer) { clearTimeout(layerAnimTimer); layerAnimTimer = null; }
    // 先记下当前实际透明度再取消旧动画：连续两次 hide()（点条目 + loadPdf 收尾）
    // 或淡出途中反向切换时，新动画从现状出发才不会跳一帧
    const prevOp = parseFloat(getComputedStyle(el.root).opacity) || 1;
    if (layerAnim) { try { layerAnim.cancel(); } catch (_) {} layerAnim = null; }
    if (REDUCED_MOTION) { if (done) done(); return; }
    // 库已经收起来了就别再演一遍（loadPdf 末尾的 hide() 常落在淡出完成之后）
    if (dir === 'leave' && el.root.hidden) { if (done) done(); return; }
    const dur = dir === 'leave' ? 160 : 200;
    const frames = dir === 'leave'
      ? [{ opacity: prevOp, transform: 'none' }, { opacity: 0, transform: 'translate3d(0, 8px, 0)' }]
      : [{ opacity: 0, transform: 'translate3d(0, 12px, 0)' }, { opacity: 1, transform: 'none' }];
    try {
      layerAnim = el.root.animate(frames, {
        duration: dur,
        easing: dir === 'leave' ? 'ease' : 'cubic-bezier(.2,.7,.3,1)',
        // 必须 fill:'forwards'：播完停在最后一帧。用 'none' 的话动画一结束
        // opacity 立刻弹回 CSS 的 1——整层闪回来一瞬，等兜底定时器才真正藏起来，
        // 用户看到的就是「切过去了又抽回来，过一会儿才跳走」。
        fill: 'forwards',
      });
      // 兜底：时间线真停住了（窗口被遮挡）就直接落到最终状态。
      // 判断要看**时间线**有没有走，不能看动画自己的 currentTime ——
      // 动画刚开始那一帧 currentTime 本来就是 0，拿它判断会把动画立刻跳完（等于没有过渡）。
      const anim = layerAnim;
      const t0 = (document.timeline && document.timeline.currentTime) || 0;
      requestAnimationFrame(() => {
        const t1 = (document.timeline && document.timeline.currentTime) || 0;
        if (anim.playState === 'running' && t1 === t0) {
          try { anim.finish(); } catch (_) {}
        }
      });
    } catch (_) { layerAnim = null; }
    // 兜底收尾：时间线停了也保证到达最终状态，不会把界面留在半透明
    layerAnimTimer = setTimeout(() => {
      layerAnimTimer = null;
      const anim = layerAnim;
      layerAnim = null;
      layerDir = '';
      if (anim) {
        try { if (anim.playState === 'running') anim.finish(); } catch (_) {}
      }
      const pending = layerDone;
      layerDone = [];
      for (const fn of pending) { try { fn(); } catch (_) {} }
      // 收尾后松开 fill 效果：leave 时 root 已 hidden、enter 时终态就是 CSS 态，都不会闪
      if (anim) { try { anim.cancel(); } catch (_) {} }
    }, dur + 60);
  }

  function show() {
    layerSeq++;            // 作废待执行的隐藏（淡出途中又点回来）
    leaving = false;
    if (el.root) {
      // 先把高亮块摆回上一个模式，等库露出来时它再滑到「文献库」——只动药丸，不动整页
      if (window.ModeSwitch) window.ModeSwitch.set('read');
      el.root.hidden = false;
      animateLayer('enter');
    }
    if (window.ModeSwitch) window.ModeSwitch.sync();
    // 侧栏「标注」入口要显示条数，开库时顺手读一次标注
    loadAnnos().then(() => { if (el.root && !el.root.hidden) render(); });
    refresh().then(() => {
      // 回到文献库时停在上次的位置（长列表里重新找很烦）
      if (state.listScroll) el.grid.scrollTop = state.listScroll;
    });
  }
  // 收起库时必须把子弹窗一起收掉：设置/查重/批量是独立的 fixed 节点（z-index 95），
  // 只藏根节点的话，它们会留在阅读器上面，遮住整页。
  // 收起库时记住列表滚动位置
  function hide() {
    if (nv.open) return nvSaveNow().then(saved => {
      if (saved) { nvCloseQuiet(); hide(); }
    });
    nvCloseQuiet();   // 去阅读器时把全屏笔记收掉（先落盘），别让它盖住文档
    if (el.grid) state.listScroll = el.grid.scrollTop;
    const seq = ++layerSeq;
    leaving = true;
    if (el.root) {
      animateLayer('leave', () => {
        if (seq !== layerSeq) return;   // 淡出途中又点回来了
        if (el.root) el.root.hidden = true;
        leaving = false;
        // 收起完成后视图才真正是「阅读」，此刻再同步一次兜底
        if (window.ModeSwitch) window.ModeSwitch.sync();
      });
    }
    // 立刻把高亮块跟到「阅读」，不等淡出——原来这里调 sync()，但淡出途中
    // root 还可见，sync() 会误判回「文献库」，药丸就不跟人了：从库里打开
    // 文档后工具栏还亮着「文献库」，点「阅读」自然像没反应。
    if (window.ModeSwitch) window.ModeSwitch.set('read');
    closeSettings();
    if (el.dupModal) el.dupModal.hidden = true;
    if (el.bib && el.bib.modal) el.bib.modal.hidden = true;
    if (el.bulkModal) el.bulkModal.hidden = true;
    closeDetail();
  }
  // 淡出中算「已经关了」：这 140ms 里后台不该再拦键盘
  function isOpen() { return !!(el.root && !el.root.hidden && !leaving); }

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
    fillStyleSelects();
    loadCslStyles()
      .then(() => loadSettings())
      .then(() => { fillStyleSelects(); refresh(); });
  }

  // annoMarkdown 暴露出来：回归脚本要能直接验「标注 → 笔记」的排版
  return { init, show, hide, refresh, isOpen, openDetail, closeDetail, openSettings, annoMarkdown, loadAnnos };
})();
