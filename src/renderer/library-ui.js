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
    collections: [], searches: [], items: [], itemTypes: [],
    scope: { type: 'all' }, query: '', sort: 'added',
    selectedKey: null, detailTags: [], flash: '',
    selectedKeys: new Set(),
    tagFilter: new Set(),   // v14：标签选择器（多选，命中任一即可）
    citeStyle: 'gbt7714',   // v14：引用样式
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
    if (state.sort === 'title') out.sort(byTitle);
    else if (state.sort === 'year') out.sort((a, b) => (Number(b.year) || 0) - (Number(a.year) || 0) || byTitle(a, b));
    else if (state.sort === 'modified') out.sort((a, b) => (b.updated || 0) - (a.updated || 0));
    else out.sort((a, b) => (b.created || 0) - (a.created || 0));
    return out;
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
    if (el.emptyTrash) el.emptyTrash.hidden = !isTrash();
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
      return '<button class="lib-tag-row' + (on ? ' active' : '') + '" data-tag-filter="' + esc(name) + '"' +
        ' title="' + esc(name) + '（' + n + ' 条）">' +
        '<span class="cname">' + esc(name) + '</span>' +
        '<span class="lc-count">' + n + '</span></button>';
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
      html += '<button class="lib-coll' + (state.scope.type === 'coll' && state.scope.id === c.id ? ' active' : '') + '"' +
        ' data-scope="coll" data-id="' + esc(c.id) + '" style="padding-left:' + pad + 'px">' +
        '<span class="cname">' + esc(c.name) + '</span>' +
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
      : '还没有条目。点右上角「导入 PDF」，或把 PDF 直接拖进来。';
    if (el.selectAll) {
      const checked = list.filter((x) => !x.deletedAt && state.selectedKeys.has(x.key)).length;
      el.selectAll.checked = list.length > 0 && checked === list.length;
      el.selectAll.indeterminate = checked > 0 && checked < list.length;
      el.selectAll.disabled = isTrash() || !list.length;
    }
    el.grid.innerHTML = list.map((it) => cardHtml(it)).join('');
  }

  // 条目渲染成「学术表格」的一行：标题 / 作者·年份·来源 / 类型 / 收藏集 / 标签 / 操作
  // 类名保持不变（lib-card / lctitle / lctype / lcprog / lccoll…），探针与事件委托都依赖它们。
  function cardHtml(it) {
    const trashed = !!it.deletedAt;
    const selected = it.key === state.selectedKey;
    const picked = state.selectedKeys.has(it.key);
    const check = trashed ? '' : '<label class="lc-check" title="选择条目"><input type="checkbox" data-select-key="' + esc(it.key) + '"' + (picked ? ' checked' : '') + ' /></label>';
    const meta = [];
    if (it.creators && it.creators.length) meta.push(esc(it.creators.join(', ')));
    if (it.year) meta.push(esc(it.year));
    if (it.publication) meta.push(esc(it.publication));
    const tags = (it.tags || []).map((t) => '<span class="lctag" data-tag-filter="' + esc(t) + '" title="按这个标签筛选">' + esc(t) +
      (trashed ? '' : '<span class="tagdel" data-rmtag="' + esc(it.key) + '" data-tag="' + esc(t) + '" title="移除标签">×</span>') + '</span>').join('');
    const colls = itemCollections(it).map((id) => collName(id)).filter(Boolean)
      .map((n) => '<span class="lccoll">' + esc(n) + '</span>').join('');
    const progress = it.page > 1 ? '<span class="lcprog">第 ' + it.page + ' 页</span>' : '';
    const openAttr = trashed ? '' : ' data-open="' + esc(it.key) + '"';
    const titleAttr = trashed ? '' : ' data-rename="' + esc(it.key) + '" title="点击重命名"';
    const tagAdd = trashed ? '' : '<span class="lc-addtag" data-addtag="' + esc(it.key) + '" title="加标签">＋</span>';
    const actions = trashed
      ? '<button data-detail="' + esc(it.key) + '">详情</button>' +
        '<button data-restore="' + esc(it.key) + '">还原</button>' +
        '<button class="rm" data-delete="' + esc(it.key) + '">永久删除</button>'
      : '<button data-detail="' + esc(it.key) + '">详情</button>' +
        '<button class="rm" data-trash="' + esc(it.key) + '">回收站</button>';
    const note = trashed
      ? '<div class="lcpath">在回收站中 · 磁盘 PDF 未被删除</div>'
      : (!it.hasFile ? '<div class="lcpath">文件已移动或删除 · 可在详情里重新定位</div>' : '');
    return '<div class="lib-card' + (selected ? ' selected' : '') + (picked ? ' picked' : '') + (it.hasFile ? '' : ' missing') + '" data-key="' + esc(it.key) + '"' + openAttr + '>' +
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
      '<span class="ld-hint">点击直接跳到对应页</span></div>' +
      list.map((r) =>
        '<button class="lib-ft-row" data-ft-key="' + esc(r.key) + '" data-ft-page="' + (r.page || 1) + '">' +
        '<span class="lib-ft-doc">' + esc(r.title || '(无标题)') + '</span>' +
        '<span class="lib-ft-pg">P' + (r.page || '?') + '</span>' +
        '<span class="lib-ft-snip">' + esc(r.snippet || '') + '</span>' +
        '</button>').join('');
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
    renderGrid();
    renderDetail();
  }
  function closeDetail() {
    state.selectedKey = null;
    el.detail.hidden = true;
  }

  function fillTypeOptions() {
    if (el.ld.type.options.length || !state.itemTypes.length) return;
    el.ld.type.innerHTML = state.itemTypes.map((t) =>
      '<option value="' + esc(t.id) + '">' + esc(t.label) + '</option>').join('');
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
    el.ld.note.value = it.note || '';
    state.detailTags = (it.tags || []).slice();
    renderDetailTags(trashed);
    renderDetailColls(it, trashed);
    renderAttach(it, trashed);
    renderCite(it, trashed);

    const fields = [el.ld.type, el.ld.title, el.ld.creators, el.ld.year, el.ld.publication,
      el.ld.volume, el.ld.issue, el.ld.pages, el.ld.doi, el.ld.url, el.ld.abstract, el.ld.note];
    for (const f of fields) f.disabled = trashed;
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
      doi: val('doi'), url: val('url'), abstract: val('abstract'), note: val('note'),
      tags, collectionIds,
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
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || [])
      .filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    if (!files.length) return;
    let n = 0, lastKey = null;
    for (const file of files) {
      let p = '';
      try { p = window.pdfBridge.pathForFile(file) || ''; } catch (_) {}
      if (!p) continue;
      const r = await L().addPdf(p, { dedupe: true });
      if (r && r.ok && r.item) { n++; lastKey = r.item.key; }
    }
    if (!n) { window.App && window.App.toast && window.App.toast('无法取得文件路径'); return; }
    if (lastKey) state.selectedKey = lastKey;
    state.scope = { type: 'all' };
    await refresh();
    window.App && window.App.toast && window.App.toast('已导入 ' + n + ' 个 PDF');
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
    };
    const r = await window.pdfBridge.setSettings(patch);
    if (!r || !r.ok) { setSettingsStatus('保存失败：' + ((r && r.error) || '未知错误')); return; }
    state.settings = Object.assign({}, state.settings, r.effective || patch);
    state.sort = state.settings.defaultSort || state.sort;
    state.sortTouched = false;
    if (el.sort) el.sort.value = state.sort;
    applyTheme(state.settings.theme);
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
      settingsModal: $('settings-modal'), setTheme: $('set-theme'), setSort: $('set-sort'),
      setAutoIndex: $('set-auto-index'), setDataDir: $('set-data-dir'), setStatus: $('set-status'),
      setFtStatus: $('set-ft-status'), setIndex: $('set-index'), setReindex: $('set-reindex'),
      dupModal: $('dup-modal'), dupBody: $('dup-body'), dupStatus: $('dup-status'),
      bulkModal: $('bulk-modal'), bulkTitle: $('bulk-title'), bulkType: $('bulk-type'), bulkColl: $('bulk-add-coll'),
      bulkYear: $('bulk-year'), bulkPublication: $('bulk-publication'),
      bulkAddTags: $('bulk-add-tags'), bulkRemoveTags: $('bulk-remove-tags'), bulkStatus: $('bulk-status'),
      detail: $('lib-detail'), ld: {
        body: $('ld-body'),
        type: $('ld-type'), title: $('ld-title'), creators: $('ld-creators'), year: $('ld-year'),
        publication: $('ld-publication'), volume: $('ld-volume'), issue: $('ld-issue'), pages: $('ld-pages'),
        doi: $('ld-doi'), url: $('ld-url'), abstract: $('ld-abstract'), note: $('ld-note'),
        tags: $('ld-tags'), tagInput: $('ld-tag-input'), tagAdd: $('ld-tag-add'),
        colls: $('ld-colls'), attach: $('ld-attach'), dates: $('ld-dates'), status: $('ld-status'),
        fetch: $('ld-fetch'), fetchStatus: $('ld-fetch-status'),
        save: $('ld-save'), trash: $('ld-trash'), restore: $('ld-restore'),
        del: $('ld-delete'), close: $('ld-close'),
        citeStyle: $('ld-cite-style'), citeCopy: $('ld-cite-copy'),
        citeStatus: $('ld-cite-status'), citePreview: $('ld-cite-preview'),
      },
    };

    el.search.addEventListener('input', () => {
      state.query = el.search.value;
      if (state.scope.type === 'search') state.scope = { type: 'all' };
      renderGrid();
      renderSidebar();
      scheduleFulltext();
    });
    el.import.addEventListener('click', importPdf);
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
      state.sortTouched = true;
      renderGrid();
    });
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

    el.newColl.addEventListener('click', () => inlineNewCollection());

    // v14：侧栏标签选择器（点标签筛选 / 清除筛选）
    if (el.tagList) el.tagList.addEventListener('click', (e) => {
      const clear = e.target.closest('[data-tag-clear]');
      if (clear) { state.tagFilter.clear(); render(); return; }
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
      const rename = e.target.closest('[data-rename]');
      if (rename) {
        inlineInput(rename, (state.items.find((x) => x.key === rename.dataset.rename) || {}).title || '',
          async (v) => { await L().updateItem(rename.dataset.rename, { title: v }); await refresh(); });
        return;
      }
      if (e.target.closest('button') || e.target.closest('input') || e.target.closest('.lc-check')) return;
      const card = e.target.closest('[data-open]');
      if (card) openItem(card.dataset.open);
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
      } else if (e.key === 'Escape') {
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

  function show() { el.root.hidden = false; refresh(); }
  // 收起库时必须把子弹窗一起收掉：设置/查重/批量是独立的 fixed 节点（z-index 95），
  // 只藏根节点的话，它们会留在阅读器上面，遮住整页。
  function hide() {
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
