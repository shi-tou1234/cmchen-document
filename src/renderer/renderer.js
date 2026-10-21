'use strict';

// ---------- PDF.js worker ----------
if (window.pdfjsLib) {
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'pdfjs/pdf.worker.min.js';
}

const $ = (id) => document.getElementById(id);

// 工具快捷键（v18：工具常驻一排，顺手给每个工具一个字母键）
const TOOL_KEYS = {
  v: 'image', p: 'pen', h: 'highlight', l: 'line',
  r: 'rect', a: 'arrow', t: 'text', n: 'note', e: 'eraser',
};

const App = window.App = {
  state: {
    pdfDoc: null,
    sourceBytes: null,   // Uint8Array，导出副本时回传给主进程
    numPages: 0,
    currentPage: 1,
    scaleMode: 'page-width',
    scale: 1,            // 已解析的实际缩放倍数
    unitMaxW: 1, unitMaxH: 1,
    fileName: '',
    filePath: '',
    annos: new Map(),    // pageNum -> shape[]
    rendered: new Map(), // pageNum -> bool
    visible: new Set(),  // 当前视口内的页
    textCache: new Map(), // pageNum -> TextItem[]
    search: { query: '', results: [], rects: new Map() }, // rects: pageNum -> [{x,y,w,h}]
  },
  tabs: [],          // v12：多标签页会话（内存里保留原始字节，切换不重新读盘）
  activeTabId: null,
  tabSeq: 0,
  els: {},
  io: null,   // 预渲染观察器（视口上下 600px 提前渲染）
  vo: null,   // 可见性观察器（真实视口，决定「当前页」）
  pageEl: (n) => document.getElementById('page-' + n),
};

// ---------- 尺寸 / 缩放 ----------
function availW() { return Math.max(200, App.els.viewer.clientWidth - 32); }
function availH() { return Math.max(200, App.els.viewer.clientHeight - 32); }

function computeScale() {
  const s = App.state;
  if (s.scaleMode === 'page-actual') return 1;
  if (s.scaleMode === 'page-width') return availW() / s.unitMaxW;
  if (s.scaleMode === 'page-fit') return Math.min(availW() / s.unitMaxW, availH() / s.unitMaxH);
  return parseFloat(s.scaleMode) || 1;
}

// 布局：设置每页 CSS 尺寸（占位稳定，滚动不跳动），重排已渲染页
function applyLayout() {
  const s = App.state;
  s.scale = computeScale();
  for (let n = 1; n <= s.numPages; n++) {
    const el = App.pageEl(n);
    if (!el) continue;
    const u = el._unit;
    const w = Math.round(u.w * s.scale), h = Math.round(u.h * s.scale);
    el.style.width = w + 'px';
    el.style.height = h + 'px';
    const base = el.querySelector('.anno-base'), anno = el.querySelector('.anno');
    for (const svg of [base, anno]) { if (svg) { svg.style.width = w + 'px'; svg.style.height = h + 'px'; } }
    // 文本层 / 搜索高亮层与 SVG 同策略：内部用单位坐标，外层用 scale 拉伸
    for (const cls of ['.textlayer', '.hl-layer']) {
      const ly = el.querySelector(cls);
      if (ly) { ly.style.width = u.w + 'px'; ly.style.height = u.h + 'px'; ly.style.transform = 'scale(' + s.scale + ')'; }
    }
    if (s.rendered.get(n)) renderPageNum(n);
  }
  App.els.zoom.textContent = Math.round(s.scale * 100) + '%';
}

// ---------- 懒渲染 ----------
function renderPageNum(n) {
  const s = App.state;
  const el = App.pageEl(n);
  if (!el || !el._pdfPage) return;
  const dpr = window.devicePixelRatio || 1;
  const viewport = el._pdfPage.getViewport({ scale: s.scale });
  const canvas = el.querySelector('canvas');
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  canvas.style.width = Math.floor(viewport.width) + 'px';
  canvas.style.height = Math.floor(viewport.height) + 'px';
  const ctx = canvas.getContext('2d');
  if (el._task) { try { el._task.cancel(); } catch (_) {} }
  el._task = el._pdfPage.render({
    canvasContext: ctx, viewport,
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
  });
  el._task.promise.then(() => {
    s.rendered.set(n, true);
    buildTextLayer(n);   // 首次渲染后铺设可选中文本层（幂等）
    paintSearchHl(n);    // 若该页有搜索命中，画高亮
  }).catch((err) => {
    // 只把「主动取消」当正常；其余错误必须冒出来，否则会出现「页面永远空白」这类静默故障
    const msg = err && err.message ? err.message : String(err);
    if (!/cancel/i.test(msg)) console.error('[render] page ' + n + ' failed:', msg);
  });
}

function freePage(n) {
  const el = App.pageEl(n);
  if (!el) return;
  if (el._task) { try { el._task.cancel(); } catch (_) {} el._task = null; }
  const canvas = el.querySelector('canvas');
  if (canvas) { canvas.width = 0; canvas.height = 0; }
  App.state.rendered.set(n, false);
}

// 两个观察器分工明确，不能混用：
//   App.io —— 预渲染：视口上下 600px 内的页块提前渲染，远离时释放位图内存
//   App.vo —— 当前页：以真实视口(rootMargin 0)为准，取视口里最靠上的一页
// 早先只有一个观察器，既预渲染又更新页码，于是「还在 600px 预渲染区里」的下一页
// 也把页码带跑了：状态栏页码提前跳、记住的阅读位置也跟着错。
function setupObserver() {
  App.io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const n = +e.target.dataset.page;
      if (e.isIntersecting) {
        if (!App.state.rendered.get(n)) renderPageNum(n);
      } else {
        // 远离视口的页释放位图内存（标注在 SVG 层，不受影响）
        freePage(n);
      }
    }
  }, { root: App.els.viewer, rootMargin: '600px 0px' });

  App.vo = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const n = +e.target.dataset.page;
      if (e.isIntersecting) App.state.visible.add(n);
      else App.state.visible.delete(n);
    }
    syncCurrentPage();
  }, { root: App.els.viewer, rootMargin: '0px 0px' });
}

// 当前页 = 视口内最靠上的一页（上一页还露着边就仍算上一页，与常见阅读器一致）
function syncCurrentPage() {
  const s = App.state;
  if (!s.visible.size) return;
  let top = Infinity;
  for (const n of s.visible) if (n < top) top = n;
  if (top !== Infinity) updateCurrentPage(top);
}

function updateCurrentPage(n) {
  if (n !== App.state.currentPage) {
    App.state.currentPage = n;
    App.els.pageInput.value = String(n);
    syncActiveTab();
    schedulePageReport();
    markCurrentThumb();
  }
}

// 连续滚动时页码变化很密，去抖后再写盘，避免每次换页都落一次文件
let pageReportTimer = null;
function schedulePageReport() {
  clearTimeout(pageReportTimer);
  pageReportTimer = setTimeout(() => {
    if (App.state.filePath && window.pdfBridge.reportPage) {
      window.pdfBridge.reportPage(App.state.filePath, App.state.currentPage);
    }
  }, 500);
}

// ---------- 载入 PDF ----------
// 载入代际号：快速切标签/连续打开时，两个 loadPdf 可能交错。
// 旧的那次 await 晚回来时会把新文档 destroy 掉再把自己设成当前文档。
let loadSeq = 0;
// 搜索代际号：清空/换词后，旧的异步搜索必须立刻作废，
// 否则它会在 await 之后把结果写回已经清空的状态（幽灵高亮 + 旧结果）。
let searchSeq = 0;
async function loadPdf(data, fileName, smoke, meta) {
  const s = App.state;
  const m = meta || {};
  const my = ++loadSeq;
  try {
    setStatus('解析中…');
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    // PDF.js 会把传入 data 的底层 ArrayBuffer 转移给 worker，转移后原数组变成 detached。
    // 「导出副本」还要在主线程拿原始字节，所以传给 pdfjs 一份副本，bytes 自己留着。
    const task = window.pdfjsLib.getDocument({ data: bytes.slice() });
    const pdfDoc = await task.promise;
    // 已经有更新的载入开始了：这份文档直接丢弃，别去 destroy 新文档
    if (my !== loadSeq) { try { await pdfDoc.destroy(); } catch (_) {} return; }
    if (s.pdfDoc) { try { await s.pdfDoc.destroy(); } catch (_) {} }

    // 重置
    s.pdfDoc = pdfDoc;
    s.sourceBytes = bytes;
    s.numPages = pdfDoc.numPages;
    s.currentPage = 1;
    s.fileName = fileName || '';
    s.filePath = m.filePath || '';
    s.annos = new Map();
    s.rendered = new Map();
    s.visible = new Set();
    s.textCache = new Map();
    s.search = { query: '', results: [], rects: new Map() };
    searchSeq++;              // 作废上一份文档还在跑的搜索
    pageImageCache = new Map();  // 换文档了，图片位置缓存作废
    if (window.Anno && Anno.reset) Anno.reset();  // 撤销栈不能跨文档
    $('sb-outline')._done = false;
    $('sb-thumbs')._docId = null;
    document.body.classList.add('has-doc');
    App.els.pageCount.textContent = '/ ' + pdfDoc.numPages;
    App.els.pageInput.max = String(pdfDoc.numPages);
    App.els.fileName.textContent = s.fileName;
    if (window.pdfBridge.setTitle) window.pdfBridge.setTitle(s.fileName);
    if (App.io) App.io.disconnect();
    if (App.vo) App.vo.disconnect();
    // 观察器必须先于页面块建立：buildPageBlocks 里会对每个页块调用 observe()，
    // 早先顺序颠倒导致首次加载时 App.io 仍为 null —— 一个元素都没被观察，
    // 滚轮滚动时后续页面永不渲染（◀▶/页码框因 scrollToPage 内部会强制渲染而看不出来）。
    setupObserver();
    await buildPageBlocks(pdfDoc);
    applyLayout();
    const start = Math.min(pdfDoc.numPages, Math.max(1, m.startPage || 1));
    s.startPage = start;
    scrollToPage(start, true);
    setStatus(`${s.fileName} · 共 ${pdfDoc.numPages} 页`);
    if (start > 1) toast(`已回到上次阅读的第 ${start} 页`);
    if (start > 1 && window.pdfBridge.reportPage) window.pdfBridge.reportPage(s.filePath, start);
    if (window.LibraryUI) window.LibraryUI.hide(); // 进入阅读，收起库覆盖层
    restoreAnnos(s.filePath);   // 恢复该文件上次保存的标注（异步，不阻塞首屏）
    refreshSidebar();           // 侧栏若开着，立刻按新文档重建

    syncActiveTab({ page: start, fileName: s.fileName, filePath: s.filePath });
    renderTabs();
    if (smoke) runSmoke(fileName);
  } catch (err) {
    App.lastLoadError = String(err && err.stack || err);
    console.error(err);
    setStatus('打开失败：' + (err && err.message ? err.message : err));
    if (smoke) window.pdfBridge.reportSmoke({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

// ---------- 多标签页（v12） ----------
// 每个标签保留原始字节和页码；切换时重载当前阅读区，不重新读盘。
// 关闭标签只关阅读会话，不删 PDF、不删标注文件。
function tabById(id) { return App.tabs.find((t) => t.id === id) || null; }
// 注意：侧栏也有一个 activeTab()（返回 outline/thumbs/annos），这里用 currentTab() 区分。
function currentTab() { return tabById(App.activeTabId); }

function syncActiveTab(extra) {
  const t = currentTab();
  if (!t) return;
  t.page = Math.max(1, App.state.currentPage || t.page || 1);
  if (App.state.fileName) t.fileName = App.state.fileName;
  if (App.state.filePath) t.filePath = App.state.filePath;
  if (extra) Object.assign(t, extra);
}

function makeTab(payload) {
  const raw = payload.data;
  const data = raw instanceof Uint8Array ? raw.slice() : new Uint8Array(raw);
  return {
    id: 'tab-' + (++App.tabSeq),
    fileName: payload.fileName || '未命名.pdf',
    filePath: payload.filePath || '',
    itemKey: payload.itemKey || '',
    data,
    page: Math.max(1, Math.floor(+payload.startPage || 1)),
  };
}

function renderTabs() {
  const bar = $('tabbar'), host = $('tabs');
  if (!bar || !host) return;
  bar.hidden = App.tabs.length === 0;
  host.innerHTML = App.tabs.map((t) =>
    '<div class="tab' + (t.id === App.activeTabId ? ' active' : '') + '" data-tab-id="' + t.id + '" title="' + escHtml(t.filePath || t.fileName) + '">' +
    '<span class="tab-title">' + escHtml(t.fileName || '未命名.pdf') + '</span>' +
    '<button class="tab-x" data-tab-close="' + t.id + '" title="关闭标签页">✕</button>' +
    '</div>').join('');
}

function loadTab(tab) {
  if (!tab) return;
  App.activeTabId = tab.id;
  loadPdf(tab.data.slice(), tab.fileName, false, {
    filePath: tab.filePath, itemKey: tab.itemKey, startPage: tab.page,
  });
}

function switchTab(id, page) {
  const t = tabById(id);
  if (!t) return;
  if (id === App.activeTabId) {
    if (page) scrollToPage(page);
    return;
  }
  syncActiveTab();
  App.flushAnnos();
  if (page) t.page = Math.max(1, Math.floor(+page || 1));
  loadTab(t);
}

function closeDocument() {
  const s = App.state;
  if (s.pdfDoc) { try { s.pdfDoc.destroy(); } catch (_) {} }
  if (App.io) { try { App.io.disconnect(); } catch (_) {} }
  if (App.vo) { try { App.vo.disconnect(); } catch (_) {} }
  pageImageCache = new Map();
  if (window.Anno && Anno.reset) Anno.reset();   // 撤销栈不能跨文档
  searchSeq++;
  s.pdfDoc = null; s.sourceBytes = null; s.numPages = 0; s.currentPage = 1;
  s.fileName = ''; s.filePath = ''; s.startPage = 1;
  s.annos = new Map(); s.rendered = new Map(); s.visible = new Set(); s.textCache = new Map();
  if (App.els.pages) App.els.pages.innerHTML = '';
  if (App.els.pageCount) App.els.pageCount.textContent = '/ 0';
  if (App.els.pageInput) { App.els.pageInput.value = '1'; App.els.pageInput.max = '1'; }
  if (App.els.fileName) App.els.fileName.textContent = '';
  document.body.classList.remove('has-doc');
  setStatus('就绪');
  renderTabs();
  if (window.LibraryUI && window.pdfBridge.isApp) window.LibraryUI.show();
}

function closeTab(id) {
  const idx = App.tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const wasActive = App.tabs[idx].id === App.activeTabId;
  if (wasActive) { syncActiveTab(); App.flushAnnos(); }
  App.tabs.splice(idx, 1);
  if (!App.tabs.length) {
    App.activeTabId = null;
    closeDocument();
    return;
  }
  if (wasActive) {
    const next = App.tabs[Math.min(idx, App.tabs.length - 1)];
    loadTab(next);
  } else renderTabs();
}

// 文献库/菜单/拖拽统一入口。同一路径已经打开时直接切过去，避免开一堆重复标签。
function openDocument(payload, opts) {
  const o = opts || {};
  if (!payload || !payload.ok) return;
  if (payload.smoke) { loadPdf(payload.data, payload.fileName, true, payload); return; }
  const p = payload.filePath || '';
  const same = p ? App.tabs.find((t) => t.filePath === p) : null;
  if (same && !o.forceNew) {
    if (same.id === App.activeTabId) {
      if (payload.startPage) scrollToPage(payload.startPage);
    } else switchTab(same.id, payload.startPage);
    return;
  }
  let tab;
  if (!o.newTab && currentTab()) {
    tab = currentTab();
    const raw = payload.data;
    tab.data = raw instanceof Uint8Array ? raw.slice() : new Uint8Array(raw);
    tab.fileName = payload.fileName || tab.fileName;
    tab.filePath = p;
    tab.itemKey = payload.itemKey || '';
    tab.page = Math.max(1, Math.floor(+payload.startPage || 1));
  } else {
    tab = makeTab(payload);
    App.tabs.push(tab);
  }
  App.activeTabId = tab.id;
  loadPdf(tab.data.slice(), tab.fileName, false, Object.assign({}, payload, {
    startPage: tab.page, filePath: tab.filePath, itemKey: tab.itemKey,
  }));
}
App.openDocument = openDocument;
App.switchTab = switchTab;
App.closeTab = closeTab;
App.renderTabs = renderTabs;


async function buildPageBlocks(pdfDoc) {
  const s = App.state;
  const host = App.els.pages;
  host.innerHTML = '';
  s.unitMaxW = 1; s.unitMaxH = 1;
  const dims = [];
  for (let n = 1; n <= s.numPages; n++) {
    const page = await pdfDoc.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    dims.push({ page, w: vp.width, h: vp.height });
    s.unitMaxW = Math.max(s.unitMaxW, vp.width);
    s.unitMaxH = Math.max(s.unitMaxH, vp.height);
  }
  for (let i = 0; i < dims.length; i++) {
    const n = i + 1, { page, w, h } = dims[i];
    const el = document.createElement('div');
    el.className = 'page';
    el.id = 'page-' + n;
    el.dataset.page = String(n);
    el.style.width = w + 'px'; el.style.height = h + 'px';
    const canvas = document.createElement('canvas');
    const base = mkSvg('anno-base', w, h);
    const anno = mkSvg('anno', w, h);
    const textlayer = document.createElement('div');
    textlayer.className = 'textlayer';
    textlayer.style.width = w + 'px'; textlayer.style.height = h + 'px';
    const hlLayer = document.createElement('div');
    hlLayer.className = 'hl-layer';
    hlLayer.style.width = w + 'px'; hlLayer.style.height = h + 'px';
    el.appendChild(canvas); el.appendChild(base); el.appendChild(textlayer); el.appendChild(hlLayer); el.appendChild(anno);
    el._pdfPage = page; el._unit = { w, h }; el._task = null;
    host.appendChild(el);
    Anno.attachPage(el, n, anno);
    App.io.observe(el);  // 不加三元兜底：观察器缺失应当直接抛错暴露，而不是静默变成空白页
    if (App.vo) App.vo.observe(el);
  }
}

function mkSvg(cls, unitW, unitH) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('viewBox', `0 0 ${unitW} ${unitH}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  return svg;
}

// ---------- 文本层（选中/复制）与全文搜索 ----------
async function getTextContent(n) {
  const s = App.state;
  if (s.textCache.has(n)) return s.textCache.get(n);
  const el = App.pageEl(n);
  if (!el || !el._pdfPage) return [];
  const tc = await el._pdfPage.getTextContent();
  const items = (tc && tc.items) || [];
  s.textCache.set(n, items);
  return items;
}

// 铺设可选中文本：span 用单位坐标定位在 .textlayer 里（层本身被 scale 拉伸），
// color 透明 → 平时不挡视觉，浏览器原生选中/Ctrl+C 直接可用。
async function buildTextLayer(n) {
  const el = App.pageEl(n);
  if (!el || !el._pdfPage || el._textDone) return;
  el._textDone = true;
  const host = el.querySelector('.textlayer');
  if (!host) return;
  const vp = el._pdfPage.getViewport({ scale: 1 });
  let items;
  try { items = await getTextContent(n); } catch (_) { items = []; }
  const frag = document.createDocumentFragment();
  for (const item of items) {
    if (!item || !item.str) continue;
    const tx = window.pdfjsLib.Util.transform(vp.transform, item.transform);
    const fh = Math.hypot(tx[2], tx[3]);
    if (!fh || !isFinite(fh)) continue;
    const span = document.createElement('span');
    span.textContent = item.str;
    span.style.left = tx[4] + 'px';
    span.style.top = (tx[5] - fh) + 'px';
    span.style.fontSize = fh + 'px';
    const ang = Math.atan2(tx[1], tx[0]);
    if (Math.abs(ang) > 0.001) span.style.transform = 'rotate(' + ang + 'rad)';
    frag.appendChild(span);
  }
  host.appendChild(frag);
}

// 画当前页的搜索命中高亮（rect 存单位坐标）
function paintSearchHl(n) {
  const el = App.pageEl(n);
  if (!el) return;
  const host = el.querySelector('.hl-layer');
  if (!host) return;
  host.innerHTML = '';
  const rects = App.state.search.rects.get(n) || [];
  for (const r of rects) {
    const d = document.createElement('div');
    d.className = 'hl';
    d.style.left = r.x + 'px'; d.style.top = r.y + 'px';
    d.style.width = r.w + 'px'; d.style.height = r.h + 'px';
    host.appendChild(d);
  }
}

// 全文搜索：遍历所有页文本，命中处生成「跳转结果 + 单位坐标高亮矩形」。
// 限制：命中必须落在单个文本项内（跨行/跨项的关键词匹配不到，和 PDF.js viewer 的行为一致）。
App.doSearch = async function (queryRaw) {
  const s = App.state;
  const q = String(queryRaw || '').trim().toLowerCase();
  const seq = ++searchSeq;          // 本次搜索的代号：后面的 await 都要先验它
  s.search = { query: q, results: [], rects: new Map() };
  if (!q || !s.pdfDoc) {
    clearSearchHl();                // 清空时必须把已经画上的高亮擦掉
    renderSearchResults();
    refreshAnnoPane();
    return;
  }
  setStatus('搜索中…');
  for (let n = 1; n <= s.numPages; n++) {
    if (seq !== searchSeq) return;  // 已被新的搜索/清空取代，直接放弃
    const el = App.pageEl(n);
    if (!el || !el._pdfPage) continue;
    const vp = el._pdfPage.getViewport({ scale: 1 });
    let items;
    try { items = await getTextContent(n); } catch (_) { continue; }
    if (seq !== searchSeq) return;
    for (const item of items) {
      if (!item || !item.str) continue;
      const hay = item.str.toLowerCase();
      let idx = hay.indexOf(q);
      if (idx === -1) continue;
      const tx = window.pdfjsLib.Util.transform(vp.transform, item.transform);
      const fh = Math.hypot(tx[2], tx[3]);
      // 高亮框：整行级别（item.width 是 scale=1 下的近似像素宽）
      const w = Math.max(8, item.width || (item.str.length * fh * 0.5));
      const rect = { x: tx[4], y: tx[5] - fh, w: w, h: fh * 1.25 };
      const list = s.search.rects.get(n) || [];
      list.push(rect);
      s.search.rects.set(n, list);
      while (idx !== -1) {
        const snippet = item.str.length > 60 ? item.str.slice(0, 60) + '…' : item.str;
        s.search.results.push({ page: n, snippet });
        idx = hay.indexOf(q, idx + q.length);
      }
      break; // 每个文本项只记一条结果，避免同一行刷屏
    }
  }
  if (seq !== searchSeq) return;
  // 重画所有已渲染页的高亮
  for (const [n, v] of s.rendered) { if (v) paintSearchHl(n); }
  renderSearchResults();
  setStatus(`「${queryRaw}」共 ${s.search.results.length} 处命中`);
};

// 擦掉所有页面上已经画出的搜索高亮（清空搜索 / 换文档时调用）
function clearSearchHl() {
  for (const el of document.querySelectorAll('#pages .page')) {
    const host = el.querySelector('.hl-layer');
    if (host) host.innerHTML = '';
  }
}

// 搜索结果渲染进批注面板上方（侧栏切到批注标签可见）；同时刷新批注列表
function renderSearchResults() {
  const host = document.getElementById('sb-search-results');
  if (!host) return;
  const s = App.state;
  if (!s.search.query) { host.innerHTML = ''; host.hidden = true; return; }
  host.hidden = false;
  if (!s.search.results.length) { host.innerHTML = '<div class="sb-empty">无命中</div>'; return; }
  host.innerHTML = s.search.results.slice(0, 200).map((r, i) =>
    '<div class="search-result" data-goto="' + r.page + '"><span class="pg">P' + r.page + '</span>' +
    '<span class="snip">' + escHtml(r.snippet) + '</span></div>').join('');
}
function escHtml(t) {
  return String(t == null ? '' : t).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- 侧栏：目录 / 缩略图 / 批注 ----------
function initSidebar() {
  const sb = $('sidebar');
  if (!sb || sb._inited) return;
  sb._inited = true;
  $('btn-sidebar').addEventListener('click', () => {
    sb.hidden = !sb.hidden;
    if (!sb.hidden) refreshSidebar();
    // 侧栏显隐改变 viewer 宽度，适应宽度模式需要重排
    setTimeout(applyLayout, 30);
  });
  for (const tab of document.querySelectorAll('.sb-tab')) {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.sb-tab').forEach((t) => t.classList.toggle('active', t === tab));
      for (const pane of ['outline', 'thumbs', 'annos']) {
        $('sb-' + pane).hidden = pane !== tab.dataset.tab;
      }
      refreshSidebar();
    });
  }
  // 搜索结果点击跳转（委托）
  $('sb-annos').addEventListener('click', (e) => {
    const r = e.target.closest('[data-goto]');
    if (r) { scrollToPage(+r.dataset.goto); return; }
    const del = e.target.closest('[data-anno-del]');
    if (del) { deleteAnno(+del.dataset.annoPage, +del.dataset.annoIdx); return; }
    const cmt = e.target.closest('[data-anno-comment]');
    if (cmt) { editAnnoComment(+cmt.dataset.annoPage, +cmt.dataset.annoIdx); return; }
    const tagBtn = e.target.closest('[data-anno-tag]');
    if (tagBtn) { e.stopPropagation(); addAnnoTag(tagBtn, +tagBtn.dataset.annoPage, +tagBtn.dataset.annoIdx); return; }
    const jump = e.target.closest('[data-anno-jump]');
    if (jump) scrollToPage(+jump.dataset.annoJump);
    const ex = e.target.closest('[data-note-fmt]');
    if (ex) exportAnnoNote(ex.dataset.noteFmt);
  });
  // 搜索结果容器挂在批注面板顶部
  const sr = document.createElement('div');
  sr.id = 'sb-search-results'; sr.hidden = true;
  $('sb-annos').prepend(sr);
}

function activeTab() {
  const t = document.querySelector('.sb-tab.active');
  return t ? t.dataset.tab : 'outline';
}

function refreshSidebar() {
  const sb = $('sidebar');
  if (!sb || sb.hidden || !App.state.pdfDoc) return;
  const tab = activeTab();
  if (tab === 'outline') buildOutlinePane();
  else if (tab === 'thumbs') buildThumbsPane();
  else refreshAnnoPane();
}

// 目录：pdfDoc.getOutline() → 解析目标页 → 可点击树
async function buildOutlinePane() {
  const host = $('sb-outline');
  if (host._done) return;
  host._done = true;
  host.innerHTML = '<div class="sb-empty">载入目录…</div>';
  const s = App.state;
  let outline = null;
  try { outline = await s.pdfDoc.getOutline(); } catch (_) {}
  if (!outline || !outline.length) { host.innerHTML = '<div class="sb-empty">此文档没有目录书签</div>'; return; }
  const destPage = async (dest) => {
    try {
      let d = dest;
      if (typeof d === 'string') d = await s.pdfDoc.getDestination(d);
      if (!Array.isArray(d) || !d[0]) return null;
      if (typeof d[0] === 'object' && d[0] !== null) return (await s.pdfDoc.getPageIndex(d[0])) + 1;
      if (typeof d[0] === 'number') return d[0] + 1;
    } catch (_) {}
    return null;
  };
  const build = async (nodes, depth) => {
    const wrap = document.createElement('div');
    if (depth > 0) wrap.className = 'outline-kids';
    for (const node of nodes) {
      const btn = document.createElement('button');
      btn.className = 'outline-node';
      btn.textContent = node.title || '(无标题)';
      const pg = await destPage(node.dest);
      if (pg) btn.addEventListener('click', () => scrollToPage(pg));
      wrap.appendChild(btn);
      if (node.items && node.items.length) wrap.appendChild(await build(node.items, depth + 1));
    }
    return wrap;
  };
  host.innerHTML = '';
  host.appendChild(await build(outline, 0));
}

// 缩略图：占位 + IntersectionObserver 懒渲染（1200 页文档也只画看得见的那几张）
let thumbIO = null;
function buildThumbsPane() {
  const host = $('sb-thumbs');
  if (host._docId === App.state.fileName + App.state.numPages) { markCurrentThumb(); return; }
  host._docId = App.state.fileName + App.state.numPages;
  host.innerHTML = '';
  if (thumbIO) thumbIO.disconnect();
  thumbIO = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) { thumbIO.unobserve(e.target); renderThumb(+e.target.dataset.page); }
    }
  }, { root: $('sb-panel'), rootMargin: '200px 0px' });
  for (let n = 1; n <= App.state.numPages; n++) {
    const d = document.createElement('div');
    d.className = 'thumb';
    d.dataset.page = String(n);
    d.innerHTML = '<div class="tph"></div><div class="tno">' + n + '</div>';
    d.addEventListener('click', () => scrollToPage(n));
    host.appendChild(d);
    thumbIO.observe(d);
  }
  markCurrentThumb();
}
async function renderThumb(n) {
  const el = App.pageEl(n);
  const holder = $('sb-thumbs').querySelector('.thumb[data-page="' + n + '"] .tph');
  if (!el || !el._pdfPage || !holder || holder._done) return;
  holder._done = true;
  try {
    const vp = el._pdfPage.getViewport({ scale: 130 / el._unit.w });
    const cv = document.createElement('canvas');
    cv.width = Math.floor(vp.width); cv.height = Math.floor(vp.height);
    await el._pdfPage.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
    holder.replaceWith(cv);
  } catch (err) { console.error('[thumb] page ' + n + ' failed:', err && err.message ? err.message : err); /* 取消/失败留占位 */ }
}
function markCurrentThumb() {
  const cur = App.state.currentPage;
  for (const t of $('sb-thumbs').querySelectorAll('.thumb')) t.classList.toggle('current', +t.dataset.page === cur);
}

// 批注面板：当前文档全部标注列表（点击跳页 / 单条删除 / 加标签 / 搜索 / 导出）
let annoQuery = '';

function annoTagsOf(sh) {
  return Array.isArray(sh && sh.tags) ? sh.tags.filter(Boolean) : [];
}

function refreshAnnoPane() {
  const host = $('sb-annos');
  if (!host) return;
  renderSearchResults();
  const list = host.querySelector('#anno-list');
  if (!list) {
    const l = document.createElement('div');
    l.id = 'anno-list';
    const search = document.createElement('input');
    search.id = 'anno-search';
    search.type = 'search';
    search.className = 'anno-search';
    search.placeholder = '搜批注 / 评论';
    search.addEventListener('input', (e) => {
      annoQuery = String(e.target.value || '').trim().toLowerCase();
      refreshAnnoPane();
    });
    // v19：批注导出可挑格式
    const bar = document.createElement('div');
    bar.className = 'anno-export-bar';
    bar.innerHTML =
      '<span class="anno-export-label">导出批注</span>' +
      '<button class="tbtn sb-export-note" data-note-fmt="md" title="导出为 Markdown（可直接贴进笔记软件）">MD</button>' +
      '<button class="tbtn sb-export-note" data-note-fmt="csv" title="导出为 CSV（表格）">CSV</button>' +
      '<button class="tbtn sb-export-note" data-note-fmt="txt" title="导出为纯文本">TXT</button>';
    host.appendChild(search);
    host.appendChild(l);
    host.appendChild(bar);
  }
  const s = App.state;
  const rows = [];
  const toolName = { pen: '画笔', highlight: '荧光', line: '直线', rect: '矩形', arrow: '箭头', text: '文字', note: '便签', mark: '选区高亮' };
  const q = annoQuery;
  for (const [n, shapes] of s.annos) {
    shapes.forEach((sh, i) => {
      let label;
      if (sh.tool === 'mark') {
        label = (sh.text || '选区高亮').slice(0, 90);
        if (sh.comment) label += ' · 评论：' + sh.comment;
      } else if (sh.tool === 'text' || sh.tool === 'note') {
        label = sh.text || '(空)';
      } else {
        label = toolName[sh.tool] || sh.tool;
      }
      const tags = annoTagsOf(sh);
      // 搜索：批注文字、评论、标签都参与匹配
      if (q) {
        const hay = (String(label) + ' ' + String(sh.comment || '') + ' ' + tags.join(' ')).toLowerCase();
        if (hay.indexOf(q) < 0) return;
      }
      rows.push({ n, i, sh, label, tags });
    });
  }
  const l2 = host.querySelector('#anno-list');
  if (!rows.length) {
    l2.innerHTML = '<div class="sb-empty">' + (q ? '没有匹配的批注' : '还没有标注。选中文字可高亮/评论，或用「绘制 ▾」里的工具画点什么。') + '</div>';
    return;
  }
  l2.innerHTML = rows.map((r) =>
    '<div class="anno-item" data-anno-jump="' + r.n + '" title="跳到第 ' + r.n + ' 页">' +
    '<span class="dot" style="background:' + r.sh.color + '"></span>' +
    '<span class="txt">' + escHtml(r.label) + '</span>' +
    (r.tags.length ? '<span class="anno-tags">' + r.tags.map((t) => '<span class="anno-tag">' + escHtml(t) + '</span>').join('') + '</span>' : '') +
    '<span class="pg">P' + r.n + '</span>' +
    (r.sh.tool === 'mark'
      ? '<button class="edit" data-anno-comment="1" data-anno-page="' + r.n + '" data-anno-idx="' + r.i + '" title="编辑评论">✎</button>'
      : '') +
    '<button class="tagbtn" data-anno-tag="1" data-anno-page="' + r.n + '" data-anno-idx="' + r.i + '" title="给这条批注加标签">🏷</button>' +
    '<button class="del" data-anno-del="1" data-anno-page="' + r.n + '" data-anno-idx="' + r.i + '" title="删除这条">✕</button>' +
    '</div>').join('');
}

// 给一条批注加标签（点 🏷 弹出小输入框）
function addAnnoTag(anchor, page, idx) {
  const arr = App.state.annos.get(page);
  const sh = arr && arr[idx];
  if (!sh) return;
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.className = 'anno-tag-input';
  inp.placeholder = '标签，回车确认';
  const done = (commit) => {
    if (commit) {
      const v = inp.value.trim();
      if (v) {
        const tags = annoTagsOf(sh);
        if (tags.indexOf(v) < 0) {
          tags.push(v);
          Anno.updateShape(page, idx, { tags });
          App.toast && App.toast('已加标签：' + v);
        }
      }
    }
    if (inp.isConnected) inp.replaceWith(anchor);
    refreshAnnoPane();
  };
  anchor.replaceWith(inp);
  inp.focus();
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); done(true); }
    else if (e.key === 'Escape') { e.preventDefault(); done(false); }
  });
  inp.addEventListener('blur', () => done(false));
}

// 选区高亮的评论可随时补写/修改；空评论等于纯高亮
function editAnnoComment(page, idx) {
  const arr = App.state.annos.get(page);
  const sh = arr && arr[idx];
  if (!sh || sh.tool !== 'mark') return;
  if (!window.SelectionUI) return;
  window.SelectionUI.openComment(sh.comment || '', (text) => {
    Anno.updateShape(page, idx, { comment: text });
    toast(text ? '评论已更新' : '已清空评论');
  }, { title: '编辑高亮评论', quote: sh.text || '' });
}
function deleteAnno(page, idx) {
  const shapes = App.state.annos.get(page);
  if (!shapes || !shapes[idx]) return;
  shapes.splice(idx, 1);
  Anno.renderPage(page);
  refreshAnnoPane();
  App.notifyAnnoChanged();
}

// 「导出批注为笔记」的纯文本内容：按页排列，供导出与回归断言共用
App.buildNoteText = function buildNoteText(fmt) {
  const f = fmt || 'txt';
  if (f === 'md') return buildNoteMd();
  if (f === 'csv') return buildNoteCsv();
  const s = App.state;
  const lines = [];
  const toolName = { pen: '画笔', highlight: '荧光', line: '直线', rect: '矩形', arrow: '箭头', text: '文字', note: '便签', mark: '选区高亮' };
  const pages = [...s.annos.keys()].filter((n) => (s.annos.get(n) || []).length).sort((a, b) => a - b);
  lines.push('# ' + (s.fileName || '文档') + ' 批注笔记');
  lines.push('');
  for (const n of pages) {
    lines.push('── 第 ' + n + ' 页 ──');
    for (const sh of s.annos.get(n)) {
      if (sh.tool === 'mark') {
        lines.push('[选区高亮] ' + String(sh.text || '').replace(/\n/g, ' / '));
        if (sh.comment) lines.push('  评论：' + String(sh.comment).replace(/\n/g, ' / '));
      } else if (sh.tool === 'text' || sh.tool === 'note') {
        lines.push('[' + toolName[sh.tool] + '] ' + String(sh.text || '').replace(/\n/g, ' / '));
      } else lines.push('[' + (toolName[sh.tool] || sh.tool) + ']');
    }
    lines.push('');
  }
  return lines.join('\n');
};

// 批注导出：Markdown 版（给 Obsidian / Logseq 这类笔记软件用）
// 格式按 Zotero 的引用习惯来：原文用引用块，评论另起一行，页码用小节标题，标签写成 #标签
function buildNoteMd() {
  const s = App.state;
  const toolName = { pen: '画笔', highlight: '荧光', line: '直线', rect: '矩形', arrow: '箭头', text: '文字', note: '便签', mark: '选区高亮' };
  const pages = [...s.annos.keys()].filter((n) => (s.annos.get(n) || []).length).sort((a, b) => a - b);
  const total = pages.reduce((sum, n) => sum + (s.annos.get(n) || []).length, 0);
  const out = [];
  out.push('# ' + (s.fileName || '文档') + ' 批注笔记');
  out.push('');
  out.push('> 导出时间：' + new Date().toLocaleString('zh-CN', { hour12: false }) +
    ' · 共 ' + total + ' 条批注，' + pages.length + ' 页');
  out.push('');
  for (const n of pages) {
    out.push('## 第 ' + n + ' 页');
    out.push('');
    for (const sh of s.annos.get(n)) {
      const tags = Array.isArray(sh.tags) ? sh.tags.filter(Boolean) : [];
      if (sh.tool === 'mark') {
        // 原文用引用块
        out.push(String(sh.text || '').split('\n').map((x) => '> ' + x).join('\n'));
        if (sh.comment) out.push('', '**评论**：' + String(sh.comment).split('\n').join(' '));
      } else if (sh.tool === 'text' || sh.tool === 'note') {
        out.push('- **' + toolName[sh.tool] + '**：' + String(sh.text || '').split('\n').join(' '));
      } else {
        out.push('- **' + (toolName[sh.tool] || sh.tool) + '**' + (sh.color ? '（' + colorName(sh.color) + '）' : ''));
      }
      if (tags.length) out.push('  **标签**：' + tags.map((t) => '#' + t).join(' '));
      out.push('');
    }
  }
  return out.join('\n');
}

// 批注导出：CSV 版（给 Excel / 表格工具用）
function buildNoteCsv() {
  const s = App.state;
  const toolName = { pen: '画笔', highlight: '荧光', line: '直线', rect: '矩形', arrow: '箭头', text: '文字', note: '便签', mark: '选区高亮' };
  const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""').replace(/\r?\n/g, ' ') + '"';
  const rows = [['页码', '类型', '颜色', '内容/引用', '评论'].map(q).join(',')];
  const pages = [...s.annos.keys()].filter((n) => (s.annos.get(n) || []).length).sort((a, b) => a - b);
  for (const n of pages) {
    for (const sh of s.annos.get(n)) {
      const isText = sh.tool === 'mark' || sh.tool === 'text' || sh.tool === 'note';
      rows.push([
        q(n), q(toolName[sh.tool] || sh.tool), q(sh.color || ''),
        q(isText ? (sh.text || '') : ''), q(sh.tool === 'mark' ? (sh.comment || '') : ''),
      ].join(','));
    }
  }
  return '﻿' + rows.join('\n');
}

// 标注颜色的中文名（认不出来的就退回色值本身）
function colorName(hex) {
  const map = {
    '#e53935': '红', '#ff5252': '红', '#f44336': '红',
    '#ffd54f': '黄', '#ffeb3b': '黄', '#ffca28': '黄',
    '#81c784': '绿', '#4caf50': '绿', '#43a047': '绿',
    '#64b5f6': '蓝', '#2196f3': '蓝', '#42a5f5': '蓝',
    '#ba68c8': '紫', '#9c27b0': '紫', '#ab47bc': '紫',
    '#ff8a65': '橙', '#ff9800': '橙',
    '#9e9e9e': '灰', '#607d8b': '灰蓝', '#795548': '棕',
    '#000000': '黑', '#ffffff': '白',
  };
  const k = String(hex || '').toLowerCase();
  return map[k] || k;
}

// 「导出批注为笔记」：纯文本 / Markdown / CSV，按页排列
async function exportAnnoNote(fmt) {
  const s = App.state;
  const pages = [...s.annos.keys()].filter((n) => (s.annos.get(n) || []).length);
  if (!pages.length) { toast('还没有标注'); return; }
  const f = fmt || 'txt';
  const res = await window.pdfBridge.exportNote({ fileName: s.fileName, text: App.buildNoteText(f), fmt: f });
  if (res && res.ok) { toast('批注已导出'); setStatus('批注已导出：' + res.path); }
  else if (res && res.canceled) setStatus('已取消导出');
  else setStatus('导出失败：' + (res && res.error ? res.error : '未知错误'));
}

// ---------- 看图模式：点页面里的内嵌位图，弹灯箱看原图 ----------
// 灯箱的缩放/拖拽/捏合/翻页那套交互移植自博客站点的 markdown-image-lightbox
// （D:\项目\博客站点\src\components\misc\Markdown.astro）。
let pageImageCache = new Map();   // pageNum -> [{x,y,w,h}]（单位坐标，scale=1）

function getPageImages(pageNum, pdfPage) {
  if (pageImageCache.has(pageNum)) return Promise.resolve(pageImageCache.get(pageNum));
  return PdfImages.collect(pdfPage)
    .then((list) => { pageImageCache.set(pageNum, list); return list; })
    .catch(() => []);
}

// 抽不到原图时的兜底：把这一块按较高分辨率重渲染再裁出来
// （矢量手写/插图不是位图时走这条：矢量重渲染是清晰的，放大不糊）
async function renderImageRegion(pdfPage, rect) {
  try {
    const vp1 = pdfPage.getViewport({ scale: 1 });
    const pw = Math.max(1, vp1.width), ph = Math.max(1, vp1.height);
    let scale = Math.min(5, Math.max(2, 1200 / Math.max(1, rect.w)));
    const cap = Math.sqrt(12e6 / (pw * ph));   // 整页渲染别超过 ~1200 万像素
    if (scale > cap) scale = cap;
    const big = pdfPage.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(big.width);
    canvas.height = Math.ceil(big.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await pdfPage.render({ canvasContext: ctx, viewport: big }).promise;
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(rect.w * scale));
    out.height = Math.max(1, Math.round(rect.h * scale));
    out.getContext('2d').drawImage(
      canvas,
      Math.round(rect.x * scale), Math.round(rect.y * scale), out.width, out.height,
      0, 0, out.width, out.height,
    );
    return out;
  } catch (_) {
    return null;
  }
}

// 点在没有位图的地方时，取点击处周围一块当「局部放大」的区域
function regionAround(ux, uy, unit) {
  const u = unit || { w: 600, h: 800 };
  const rw = Math.min(u.w, u.w * 0.3);
  const rh = Math.min(u.h, u.h * 0.3);
  const x = Math.max(0, Math.min(Math.max(0, u.w - rw), ux - rw / 2));
  const y = Math.max(0, Math.min(Math.max(0, u.h - rh), uy - rh / 2));
  return { x, y, w: rw, h: rh };
}

async function openImageLightbox(pageEl, clientX, clientY) {
  const pageNum = +pageEl.dataset.page;
  const pdfPage = pageEl._pdfPage;
  if (!pdfPage) return;
  const s = App.state;
  const r = pageEl.getBoundingClientRect();
  const ux = (clientX - r.left) / (s.scale || 1);
  const uy = (clientY - r.top) / (s.scale || 1);
  const images = await getPageImages(pageNum, pdfPage);
  const hit = images.length ? PdfImages.findAt(images, ux, uy) : null;

  // 命中位图 → 给原图像素；没命中 → 给点击处周围一块的高清重渲染（矢量内容也清晰）
  let items = [];
  let index = 0;
  if (hit) {
    const list = images.slice(0, 12);
    const built = [];
    for (let i = 0; i < list.length; i++) {
      const c = await PdfImages.extract(pdfPage, list[i]) || await renderImageRegion(pdfPage, list[i]);
      if (!c) continue;
      built.push({
        canvas: c,
        srcIndex: i,
        label: '第 ' + pageNum + ' 页 · 图 ' + (i + 1) + (list.length > 1 ? ' / ' + list.length : ''),
      });
    }
    if (built.length) {
      const want = list.indexOf(hit);
      items = built;
      index = Math.max(0, built.findIndex((b) => b.srcIndex === want));
    }
  }
  if (!items.length) {
    const region = regionAround(ux, uy, pageEl._unit);
    const c = await renderImageRegion(pdfPage, region);
    if (!c) { toast('这一块取不出来'); return; }
    items = [{ canvas: c, label: '第 ' + pageNum + ' 页 · 局部放大' }];
    index = 0;
  }
  Lightbox.open({ items, index });
}

// ---------- 专注阅读模式（F11） ----------
App.setFocusMode = function (on) {
  const next = on === undefined ? !document.body.classList.contains('focus-mode') : !!on;
  document.body.classList.toggle('focus-mode', next);
  if (next) {
    toast('专注阅读模式：Esc 或 F11 退出');
    setTimeout(applyLayout, 60);
  }
  return next;
};

// ---------- 页面右键菜单 ----------
let ctxMenu = null;
function closeCtxMenu() {
  if (ctxMenu) { ctxMenu.remove(); ctxMenu = null; }
}
function openCtxMenu(x, y, items) {
  closeCtxMenu();
  ctxMenu = document.createElement('div');
  ctxMenu.className = 'ctx-menu';
  ctxMenu.style.left = Math.round(x) + 'px';
  ctxMenu.style.top = Math.round(y) + 'px';
  for (const it of items) {
    if (it === '-') {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      ctxMenu.appendChild(sep);
      continue;
    }
    const b = document.createElement('button');
    b.textContent = it.label;
    b.addEventListener('click', () => { closeCtxMenu(); it.run(); });
    ctxMenu.appendChild(b);
  }
  document.body.appendChild(ctxMenu);
  // 贴着窗口边缘收一收
  const r = ctxMenu.getBoundingClientRect();
  if (r.right > window.innerWidth - 8) ctxMenu.style.left = Math.max(8, window.innerWidth - r.width - 8) + 'px';
  if (r.bottom > window.innerHeight - 8) ctxMenu.style.top = Math.max(8, window.innerHeight - r.height - 8) + 'px';
}

// 当前页导出为 PNG
async function exportCurrentPagePng() {
  const el = App.pageEl(App.state.currentPage);
  const canvas = el && el.querySelector('canvas');
  if (!canvas || !canvas.width) { toast('当前页还没渲染出来'); return; }
  let dataUrl = '';
  try { dataUrl = canvas.toDataURL('image/png'); } catch (e) { toast('导出失败：' + (e && e.message || e)); return; }
  const name = (App.state.fileName || 'page').replace(/\.pdf$/i, '') + '-p' + App.state.currentPage + '.png';
  const res = await window.pdfBridge.exportPagePng({ dataUrl, fileName: name });
  if (res && res.ok) { toast('已导出：' + res.path); setStatus('已导出当前页图片：' + res.path); }
  else if (res && res.canceled) setStatus('已取消导出');
  else setStatus('导出失败：' + ((res && res.error) || '未知错误'));
}

// 复制当前页文字
async function copyPageText() {
  const n = App.state.currentPage;
  let items = [];
  try { items = await getTextContent(n); } catch (_) {}
  const text = (items || []).map((it) => (it && it.str) || '').join(' ').replace(/\s+/g, ' ').trim();
  if (!text) { toast('这一页没有可选文字'); return; }
  try {
    const r = await window.pdfBridge.copyText(text);
    if (r && r.ok) toast('已复制第 ' + n + ' 页文字');
    else toast('复制失败');
  } catch (_) { toast('复制失败'); }
}

// ---------- 标注自动保存 / 恢复（按文件路径存 userData/annotations/） ----------
async function saveAnnosNow() {
  const s = App.state;
  if (!s.filePath || !window.pdfBridge.saveAnnos) return;
  const pages = [];
  for (const [n, shapes] of s.annos) {
    if (shapes && shapes.length) pages.push({ page: n, shapes: JSON.parse(JSON.stringify(shapes)) });
  }
  try { await window.pdfBridge.saveAnnos(s.filePath, pages); } catch (_) {}
}
App.flushAnnos = saveAnnosNow;
App.notifyAnnoChanged = function () {
  refreshAnnoPane();
  clearTimeout(App._annoSaveTimer);
  App._annoSaveTimer = setTimeout(saveAnnosNow, 600);
};

async function restoreAnnos(filePath) {
  if (!filePath || !window.pdfBridge.loadAnnos) return;
  let saved = null;
  try { saved = await window.pdfBridge.loadAnnos(filePath); } catch (_) {}
  if (!saved || !saved.length) return;
  // 读盘期间可能已经切到别的文档：这时把上一份文档的标注恢复到新文档里，
  // 后续任何保存都会把它们写进新文档的标注文件。路径对不上就直接放弃。
  if (filePath !== App.state.filePath) return;
  const s = App.state;
  for (const entry of saved) {
    const n = Math.min(s.numPages, Math.max(1, entry.page || 1));
    const arr = s.annos.get(n) || [];
    for (const sh of (entry.shapes || [])) arr.push(sh);
    s.annos.set(n, arr);
  }
  for (const n of s.annos.keys()) Anno.renderPage(n);
  refreshAnnoPane();
}

// ---------- 翻页导航（滚动定位） ----------
function scrollToPage(n, instant) {
  n = Math.min(App.state.numPages, Math.max(1, n));
  const el = App.pageEl(n);
  if (!el) return;
  el.scrollIntoView({ behavior: instant ? 'auto' : 'smooth', block: 'start' });
  if (!App.state.rendered.get(n)) renderPageNum(n);
  updateCurrentPage(n);
}
const nextPage = () => scrollToPage(App.state.currentPage + 1);
const prevPage = () => scrollToPage(App.state.currentPage - 1);

// ---------- 缩放控制 ----------
// 缩放前后页面高度变了，滚动位置会漂；先记住当前页顶边相对视口的位置，改完再补回来
function relayoutKeepingPosition() {
  const keep = App.state.currentPage;
  const el0 = App.pageEl(keep);
  const vr0 = App.els.viewer.getBoundingClientRect();
  const anchor = el0 ? (el0.getBoundingClientRect().top - vr0.top) : 0;
  applyLayout();
  const el1 = App.pageEl(keep);
  if (el1) {
    const vr1 = App.els.viewer.getBoundingClientRect();
    const now = el1.getBoundingClientRect().top - vr1.top;
    App.els.viewer.scrollTop += (now - anchor);
  }
}

function setNumericScale(next) {
  const clamped = Math.min(6, Math.max(0.2, next));
  App.state.scaleMode = String(clamped);
  syncScaleSelect(clamped);
  relayoutKeepingPosition();
}
function syncScaleSelect(scale) {
  const sel = App.els.scale;
  if (!sel) return;
  // option 的 value 是 "0.5"/"1"/"1.25" 这种小数，不是百分比字符串，
  // 早先拿 Math.round(scale*100) 去匹配，永远匹配不到 → 缩放后下拉框直接空了。
  let opt = Array.from(sel.options).find((o) => {
    const v = parseFloat(o.value);
    return !Number.isNaN(v) && Math.abs(v - scale) < 0.005;
  });
  if (!opt) {
    // 不是预设档位：补一个「自定义 xx%」选项，别让下拉框空着
    opt = sel.querySelector('option[data-custom="1"]');
    if (!opt) {
      opt = document.createElement('option');
      opt.setAttribute('data-custom', '1');
      sel.appendChild(opt);
    }
    opt.value = String(scale);
    opt.textContent = '自定义 ' + Math.round(scale * 100) + '%';
  }
  sel.value = opt.value;
}

// ---------- 状态栏 ----------
function setStatus(t) { App.els.status.textContent = t; }

// ---------- 导出副本 ----------
App.buildExportPayload = function (outPath) {
  const s = App.state;
  const pages = [];
  for (const [n, shapes] of s.annos) {
    if (!shapes || !shapes.length) continue;
    const el = App.pageEl(n);
    if (!el || !el._pdfPage) continue;
    const vp = el._pdfPage.getViewport({ scale: 1 });
    const conv = (p) => { const r = vp.convertToPdfPoint(p.x, p.y); return { x: r[0], y: r[1] }; };
    const out = shapes.map((sh) => {
      // 便签在导出副本里按「文字」处理（前缀已加 [便签]）
      const g = { tool: sh.tool === 'note' ? 'text' : sh.tool, color: sh.color, width: sh.width };
      if (sh.tool === 'pen' || sh.tool === 'highlight') g.pts = sh.pts.map(conv);
      else if (sh.tool === 'text' || sh.tool === 'note') { g.at = conv(sh.at); g.size = sh.size; g.text = (sh.tool === 'note' ? '[便签] ' : '') + sh.text; }
      else if (sh.tool === 'mark') {
        // 单位坐标（左上原点）→ PDF 坐标（左下原点）：两个角都转换后取最小/最大
        g.rects = (sh.rects || []).map((r) => {
          const a = conv({ x: r.x, y: r.y });
          const b = conv({ x: r.x + r.w, y: r.y + r.h });
          return {
            x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
            w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y),
          };
        });
        g.text = sh.text || ''; g.comment = sh.comment || '';
      }
      else { g.a = conv(sh.a); g.b = conv(sh.b); }
      return g;
    });
    pages.push({ index: n - 1, shapes: out });
  }
  return { fileName: s.fileName, data: s.sourceBytes, pages, outPath };
};

async function doSave() {
  const payload = App.buildExportPayload();
  if (!payload.pages.length) { toast('还没有任何标注'); return; }
  setStatus('导出中…');
  const res = await window.pdfBridge.exportPdf(payload);
  if (res && res.ok) { setStatus('已导出副本：' + res.path); toast('已保存副本'); }
  else if (res && res.canceled) setStatus('已取消导出');
  else setStatus('导出失败：' + (res && res.error ? res.error : '未知错误'));
}

// ---------- toast ----------
let toastTimer = null;
function toast(msg) {
  let t = $('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}
App.toast = toast;

// ---------- 主题（light / dark / system） ----------
let themeMedia = null;
function applyTheme(theme) {
  const t = theme === 'dark' || theme === 'light' ? theme : 'system';
  App._theme = t;
  const dark = t === 'dark' || (t === 'system' && window.matchMedia
    && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.body.classList.toggle('theme-dark', !!dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  if (t === 'system' && window.matchMedia && !themeMedia) {
    themeMedia = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme('system');
    if (themeMedia.addEventListener) themeMedia.addEventListener('change', onChange);
    else if (themeMedia.addListener) themeMedia.addListener(onChange);
  }
}
App.applyTheme = applyTheme;

// 深色模式下把页面反色（夜读护眼）
function applyInvert(on) {
  document.body.classList.toggle('invert-pages', !!on);
}
App.applyInvert = applyInvert;

// ---------- 冒烟 ----------
function runSmoke(fileName) {
  const s = App.state;
  // 会话恢复的观测点必须赶在下面的 scrollToPage(1) 之前抓，否则会被自己覆盖掉
  const session = { hasFilePath: !!s.filePath, startPage: s.startPage || 1, landedPage: s.currentPage };
    // 轮询等渲染完成，别用固定 sleep（启动负载变化会让固定等待忽冷忽热）
    const waitRendered = async (n, ms) => {
      const t0 = performance.now();
      while (!s.rendered.get(n)) { if (performance.now() - t0 > ms) return false; await new Promise((r) => setTimeout(r, 30)); }
      return true;
    };
    setTimeout(async () => {
      try {
        scrollToPage(1, true);
        if (!s.rendered.get(1)) renderPageNum(1);
        await waitRendered(1, 4000);
        const c1 = App.pageEl(1).querySelector('canvas');
        let drawn = false;
        const cctx = c1.getContext('2d');
        const img = cctx.getImageData(0, 0, c1.width, c1.height).data;
        // 必须同时要求 alpha>0：未绘制的 canvas 是透明黑（r=g=b=0），只看 r<250 会假阳性
        for (let i = 0; i < img.length; i += 4) {
          if (img[i + 3] > 0 && (img[i] < 250 || img[i + 1] < 250 || img[i + 2] < 250)) { drawn = true; break; }
        }
        const w1 = c1.width;

        // 缩放：page1 已 rendered，applyLayout 会同步把 canvas 尺寸改到 2x
        App.state.scaleMode = '2'; applyLayout();
        await new Promise((r) => setTimeout(r, 120));
        const w2 = App.pageEl(1).querySelector('canvas').width;

        // 翻页（滚动定位到末页）
        scrollToPage(s.numPages, true);
        await new Promise((r) => setTimeout(r, 120));
        const navOk = s.currentPage === s.numPages;

      // 标注模型 + 导出 payload（含坐标单位→PDF 点转换）
      const shapes = s.annos.get(s.numPages) || [];
      shapes.push({ tool: 'pen', color: '#e53935', width: 3, pts: [{ x: 50, y: 50 }, { x: 120, y: 90 }] });
      s.annos.set(s.numPages, shapes);
      const payload = App.buildExportPayload();
      const geomOk = payload.pages.length === 1 && payload.pages[0].shapes[0].pts
        && Number.isFinite(payload.pages[0].shapes[0].pts[0].x);

      // 模拟「读到末页」：上报页码，供下一次启动验证是否真被记住
      if (s.filePath && window.pdfBridge.reportPage) window.pdfBridge.reportPage(s.filePath, s.numPages);
      await new Promise((r) => setTimeout(r, 60));

      window.pdfBridge.reportSmoke({
        ok: true, numPages: s.numPages, drawnPixels: drawn,
        continuousPages: !!App.pageEl(2) || s.numPages === 1,
        zoomWorks: w2 !== w1 && w2 > 0, navWorks: navOk, exportGeomOk: geomOk,
        session,
      });
    } catch (err) {
      window.pdfBridge.reportSmoke({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  }, 200);
}

// ---------- 事件绑定 ----------
function bind() {
  const E = App.els = {
    open: $('btn-open'), zoomOut: $('btn-zoom-out'), zoomIn: $('btn-zoom-in'),
    scale: $('scale-select'), prev: $('btn-prev'), next: $('btn-next'),
    pageInput: $('page-input'), pageCount: $('page-count'), fileName: $('file-name'),
    status: $('status-text'), zoom: $('zoom-text'), hint: $('empty-hint'),
    viewer: $('viewer'), pages: $('pages'),
    save: $('btn-save'),
  };

  E.open.addEventListener('click', async () => {
    const res = await window.pdfBridge.openPdfDialog();
    if (res && res.ok) openDocument(res, { newTab: true });
  });
  window.pdfBridge.onPdfOpened((res) => {
    if (!res || !res.ok) return;
    if (res.smoke) loadPdf(res.data, res.fileName, true, res);
    else openDocument(res, { newTab: true });
  });

  // 标签栏：+ 打开新 PDF；点标签切换；点 × 关闭
  const tabNew = $('tab-new');
  if (tabNew) tabNew.addEventListener('click', async () => {
    const res = await window.pdfBridge.openPdfDialog();
    if (res && res.ok) openDocument(res, { newTab: true });
  });
  const tabsHost = $('tabs');
  if (tabsHost) tabsHost.addEventListener('click', (e) => {
    const x = e.target.closest('[data-tab-close]');
    if (x) { e.stopPropagation(); closeTab(x.dataset.tabClose); return; }
    const t = e.target.closest('[data-tab-id]');
    if (t) switchTab(t.dataset.tabId);
  });

  // 文献库：暴露打开钩子给覆盖层用；工具栏「库」按钮回到库；启动即显示库
  window.__libOpen = (payload) => openDocument(payload, { newTab: true });
  if (window.DocSwitch) window.DocSwitch.init();
  if (window.LibraryUI) {
    window.LibraryUI.init();
    const libBtn = $('btn-library');
    if (libBtn) libBtn.addEventListener('click', () => window.LibraryUI.show());
    // 只有主应用窗口启动即进库；test-pen 等独立测试窗口不自动展开（也没有 lib-* IPC）
    if (window.pdfBridge.isApp) window.LibraryUI.show();
  }
  if (window.pdfBridge.getSettings) {
    window.pdfBridge.getSettings().then((s) => applyTheme(s && s.theme)).catch(() => {});
  }
  if (window.pdfBridge.onOpenSettings) {
    window.pdfBridge.onOpenSettings(() => {
      if (window.LibraryUI) {
        window.LibraryUI.show();
        if (window.LibraryUI.openSettings) window.LibraryUI.openSettings();
      }
    });
  }

  E.zoomIn.addEventListener('click', () => setNumericScale(App.state.scale * 1.25));
  E.zoomOut.addEventListener('click', () => setNumericScale(App.state.scale / 1.25));
  E.scale.addEventListener('change', () => { App.state.scaleMode = E.scale.value; applyLayout(); });

  E.prev.addEventListener('click', prevPage);
  E.next.addEventListener('click', nextPage);
  E.pageInput.addEventListener('change', () => scrollToPage(parseInt(E.pageInput.value, 10) || 1));
  E.save.addEventListener('click', doSave);

  // 侧栏 + 全文搜索
  initSidebar();
  const sbx = $('search-box');
  if (sbx) {
    sbx.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); App.doSearch(sbx.value); }
      else if (e.key === 'Escape') { sbx.value = ''; App.doSearch(''); }
    });
  }
  document.addEventListener('keydown', (e) => {
    // 库覆盖层开着时，Ctrl+F 属于“库内搜索”，别再抢去聚焦阅读器的全文搜索框
    if (window.LibraryUI && window.LibraryUI.isOpen()) return;
    if (e.ctrlKey && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); sbx.focus(); sbx.select(); }
  });

  document.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    // 焦点在按钮/链接上时，别抢它的键盘语义：
    // 早先只排除了输入类元素，按钮上按空格会翻页，还顺手 preventDefault 掉按钮的原生激活。
    if (e.target && e.target.closest && e.target.closest('button, a, [role="button"], [contenteditable="true"]')) return;
    if (window.LibraryUI && window.LibraryUI.isOpen()) return; // 库开着时方向键不应在后台翻 PDF
    if (e.defaultPrevented) return;                          // 弹窗/灯箱已经处理过这个键
    if (e.ctrlKey && (e.key === 'z' || e.key === 'Z')) { Anno.undo(); e.preventDefault(); return; }
    if (e.ctrlKey && (e.key === 's' || e.key === 'S')) { doSave(); e.preventDefault(); return; }
    // 工具快捷键：v 看图 / p 画笔 / h 荧光 / l 直线 / r 矩形 / a 箭头 / t 文字 / n 便签 / e 橡皮
    if (!e.ctrlKey && !e.altKey && !e.metaKey) {
      const tool = TOOL_KEYS[e.key.toLowerCase()];
      if (tool) { Anno.setTool(tool); e.preventDefault(); return; }
      if (e.key === 'Escape') {
        if (window.Lightbox && Lightbox.isOpen()) return;   // 灯箱自己处理 Esc
        if (document.body.classList.contains('focus-mode')) { App.setFocusMode(false); e.preventDefault(); return; }
        Anno.setTool('select');
        e.preventDefault();
        return;
      }
    }
    if (e.key === 'F11') { App.setFocusMode(); e.preventDefault(); return; }
    switch (e.key) {
      case 'ArrowLeft': case 'PageUp': prevPage(); e.preventDefault(); break;
      case 'ArrowRight': case 'PageDown': case ' ': nextPage(); e.preventDefault(); break;
      case 'Home': scrollToPage(1); e.preventDefault(); break;
      case 'End': scrollToPage(App.state.numPages); e.preventDefault(); break;
      case '+': case '=': if (e.ctrlKey) { setNumericScale(App.state.scale * 1.25); e.preventDefault(); } break;
      case '-': if (e.ctrlKey) { setNumericScale(App.state.scale / 1.25); e.preventDefault(); } break;
      case '0': if (e.ctrlKey) { App.state.scaleMode = 'page-width'; E.scale.value = 'page-width'; applyLayout(); e.preventDefault(); } break;
    }
  });

  // Ctrl+滚轮缩放；普通滚轮保持原生连续滚动（不劫持）
  E.viewer.addEventListener('wheel', (e) => {
    if (!e.ctrlKey || !App.state.pdfDoc) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    setNumericScale(App.state.scale * factor);
  }, { passive: false });

  // 看图模式：点页面里的图片 → 灯箱放大看原图
  E.pages.addEventListener('click', (e) => {
    if (!document.body.classList.contains('tool-image')) return;
    const pageEl = e.target.closest && e.target.closest('.page');
    if (!pageEl) return;
    e.preventDefault();
    e.stopPropagation();
    openImageLightbox(pageEl, e.clientX, e.clientY);
  });

  // 页面右键菜单：把不常用的操作收在这里，工具栏就不用越堆越多
  E.pages.addEventListener('contextmenu', (e) => {
    const pageEl = e.target.closest && e.target.closest('.page');
    if (!pageEl) return;
    e.preventDefault();
    const n = +pageEl.dataset.page;
    openCtxMenu(e.clientX, e.clientY, [
      { label: '复制第 ' + n + ' 页文字', run: copyPageText },
      { label: '导出第 ' + n + ' 页为图片', run: exportCurrentPagePng },
      '-',
      { label: '放大看这一块（看图模式）', run: () => { Anno.setTool('image'); toast('点页面任意位置放大查看'); } },
      { label: '复制页码', run: () => { window.pdfBridge.copyText(String(n)); toast('已复制页码 ' + n); } },
    ]);
  });
  document.addEventListener('click', closeCtxMenu);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCtxMenu(); });
  window.addEventListener('blur', closeCtxMenu);

  let rt = null;
  window.addEventListener('resize', () => {
    if (App.state.scaleMode === 'page-width' || App.state.scaleMode === 'page-fit') {
      clearTimeout(rt); rt = setTimeout(applyLayout, 120);
    }
  });

  // 拖拽打开
  document.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); });
  document.addEventListener('drop', async (e) => {
    e.preventDefault(); e.stopPropagation();
    // 库覆盖层开着时，拖放由库处理（导入条目），这里不要再顺手把文件打开
    if (window.LibraryUI && window.LibraryUI.isOpen()) return;
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') { setStatus('请拖入 PDF 文件'); return; }
    // 取真实路径：拖拽进来的文件也要能进「最近打开」并恢复页码。
    // 拿不到路径（例如非本地来源）时静默降级为「仅本次阅读」，不影响打开。
    let realPath = '';
    try { if (window.pdfBridge.pathForFile) realPath = window.pdfBridge.pathForFile(file) || ''; } catch (_) {}
    let startPage = 1;
    if (realPath && window.pdfBridge.noteRecent) {
      try { const r = await window.pdfBridge.noteRecent(realPath); if (r && r.page) startPage = r.page; } catch (_) {}
    }
    const buf = await file.arrayBuffer();
    openDocument({ ok: true, data: new Uint8Array(buf), fileName: file.name, filePath: realPath, startPage }, { newTab: true });
  });

  Anno.init();
  if (window.SelectionUI) window.SelectionUI.init();
  if (window.pdfBridge.onToggleFocusMode) window.pdfBridge.onToggleFocusMode(() => App.setFocusMode());
  if (window.pdfBridge.onExportPagePng) window.pdfBridge.onExportPagePng(() => exportCurrentPagePng());
  initHintBar();
}

// 首次上手提示：只出现一次（记在 settings.json）
function initHintBar() {
  const bar = $('hint-bar');
  if (!bar) return;
  const close = () => {
    bar.hidden = true;
    try { window.pdfBridge.setSettings && window.pdfBridge.setSettings({ hintSeen: true }); } catch (_) {}
  };
  const btn = $('hint-x');
  if (btn) btn.addEventListener('click', close);
  Promise.resolve()
    .then(() => (window.pdfBridge && window.pdfBridge.getSettings ? window.pdfBridge.getSettings() : null))
    .then((st) => {
      if (!st || st.hintSeen) { bar.hidden = true; return; }
      bar.hidden = false;
    })
    .catch(() => { bar.hidden = true; });
}

document.addEventListener('DOMContentLoaded', bind);
