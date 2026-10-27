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
    mode: 'pdf',         // v27：pdf = PDF.js；rich = 其它文档转成的安全 HTML
    richPages: null,     // 富文档页面 [{title,html}]
    itemKey: '',
    item: null,          // 从文献库打开时带出的条目（复制引用用）
    citation: '',
    sourceBytes: null,   // Uint8Array，导出副本时回传给主进程
    numPages: 0,
    currentPage: 1,
    scaleMode: 'page-width',
    scale: 1,            // 已解析的实际缩放倍数
    unitMaxW: 1, unitMaxH: 1,
    fileName: '',
    filePath: '',
    viewMode: 'scroll',    // v22：scroll 连续滚动 / page 单页翻页
    rotation: 0,           // v34：整篇文档的视图旋转 0/90/180/270（只改显示，不改原文件）
    split: false,          // v34：分屏参考视图（用户偏好，富文档时自动隐藏）
    refPage: 1,            // v34：参考视图页码
    annos: new Map(),    // pageNum -> shape[]
    rendered: new Map(), // pageNum -> bool
    visible: new Set(),  // 当前视口内的页
    textCache: new Map(), // pageNum -> TextItem[]
    search: { query: '', results: [], rects: new Map(), hits: [], hitIndex: -1 }, // rects: pageNum -> [{x,y,w,h}]
    sj: { byPage: new Map(), builtTo: 0 },  // 智能跳转：按页存的跨页行缓存 page → [{page,text,x,y,w,h,idx}]
    bookmarks: [],   // 用户书签 [{page, at, label}]，存标注 sidecar
    bookmarksReady: null,   // 这一份文档的书签读盘 promise（首次操作前要等它）
  },
  tabs: [],          // v12：多标签页会话（内存里保留原始字节，切换不重新读盘）
  activeTabId: null,
  tabSeq: 0,
  els: {},
  io: null,   // 预渲染观察器（视口上下 600px 提前渲染）
  vo: null,   // 可见性观察器（真实视口，决定「当前页」）
  richVO: null, // 富文档的当前页观察器
  pageEl: (n) => document.getElementById('page-' + n),
};

// ---------- 尺寸 / 缩放 ----------
function availW() { return Math.max(200, App.els.viewer.clientWidth - 32); }
function availH() { return Math.max(200, App.els.viewer.clientHeight - 32); }

// 没有打开文档时，页宽 / 页高还是占位值 1，算缩放会得到 941 倍这种废数
function hasDoc(s) { return !!(s.pdfDoc || (s.richPages && s.richPages.length)); }

// ---------- 视图旋转（v34） ----------
// 约定：标注、选区、搜索高亮、图片位置全部仍按「未旋转页面坐标」存。
// 旋转只发生在 .page-rot 这一层：画布 / 文本层 / 两个标注层一起转。
// 因此：改旋转 = 换布局槽尺寸 + 换 CSS transform，数据层一行都不用动。
function normRot(r) {
  const n = Math.round((Number(r) || 0) / 90) * 90;
  return ((n % 360) + 360) % 360;
}
// 旋转 90/270 时页面外框宽高互换；缩放必须按互换后的尺寸算，否则「适应宽度」会算出界
function effDims(w, h, rot) {
  return normRot(rot) % 180 ? { w: h, h: w } : { w, h };
}
// 未旋转页面坐标 → 旋转后布局槽内的偏移（不依赖 DOM，用于平滑滚动期间的定位）
function unitToSlotOffset(pageEl, ux, uy) {
  const u = pageEl._unit || { w: 0, h: 0 };
  const s = App.state.scale || 1;
  const rot = normRot(App.state.rotation);
  if (rot === 90) return { x: (u.h - uy) * s, y: ux * s };
  if (rot === 180) return { x: (u.w - ux) * s, y: (u.h - uy) * s };
  if (rot === 270) return { x: uy * s, y: (u.w - ux) * s };
  return { x: ux * s, y: uy * s };
}

// 客户端坐标 → 页面单位坐标。PDF 页走标注 SVG 的逆 CTM：缩放、CSS 旋转都自动算进去。
// 富文档没有旋转，仍按页面矩形 + CSS zoom 换算（getScreenCTM 对 zoom 的处理各版本不一致，别赌）。
function clientToUnit(pageEl, clientX, clientY) {
  if (!pageEl) return { x: 0, y: 0 };
  const s = App.state;
  if (s.mode !== 'rich') {
    const svg = pageEl.querySelector('.anno') || pageEl.querySelector('.anno-base');
    const ctm = svg && svg.getScreenCTM ? svg.getScreenCTM() : null;
    if (ctm) {
      const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
      return { x: p.x, y: p.y };
    }
  }
  const r = pageEl.getBoundingClientRect();
  const z = s.scale || 1;
  return { x: (clientX - r.left) / z, y: (clientY - r.top) / z };
}
App.clientToUnit = clientToUnit;
App.unitToSlotOffset = (pageEl, ux, uy) => unitToSlotOffset(pageEl, ux, uy);

function computeScale() {
  const s = App.state;
  if (!hasDoc(s)) return 1;
  if (s.mode === 'rich') {
    if (s.scaleMode === 'page-actual') return 1;
    if (s.scaleMode === 'page-width') return availW() / 900;
    if (s.scaleMode === 'page-fit') return Math.min(availW() / 900, availH() / 1200);
    return parseFloat(s.scaleMode) || 1;
  }
  if (s.scaleMode === 'page-actual') return 1;
  const d = effDims(s.unitMaxW, s.unitMaxH, s.rotation);
  // 双页对开：两页并排，一页只占约半幅宽（再扣掉页间距）
  const half = (s.viewMode === 'spread') ? Math.max(160, (availW() - 24) / 2) : availW();
  if (s.scaleMode === 'page-width') return half / d.w;
  if (s.scaleMode === 'page-fit') return Math.min(half / d.w, availH() / d.h);
  return parseFloat(s.scaleMode) || 1;
}

// 布局：设置每页 CSS 尺寸（占位稳定，滚动不跳动），重排已渲染页
function applyLayout() {
  const s = App.state;
  if (!hasDoc(s)) { App.els.zoom.textContent = '—'; return; }
  s.scale = computeScale();
  if (s.mode === 'rich') {
    // 富文档用 CSS zoom：字号、表格、图片一起缩放，滚动高度由浏览器自动算
    const host = $('doc-view');
    if (host) host.style.zoom = String(s.scale);
    App.els.zoom.textContent = Math.round(s.scale * 100) + '%';
    return;
  }
  for (let n = 1; n <= s.numPages; n++) {
    const el = App.pageEl(n);
    if (!el) continue;
    const u = el._unit;
    const d = effDims(u.w, u.h, s.rotation);
    const w = Math.round(d.w * s.scale), h = Math.round(d.h * s.scale);
    // 外层 .page = 旋转后的布局槽；内层 .page-rot = 未旋转的页面本体
    el.style.width = w + 'px';
    el.style.height = h + 'px';
    const rotEl = el.querySelector('.page-rot');
    if (rotEl) {
      rotEl.style.width = Math.round(u.w * s.scale) + 'px';
      rotEl.style.height = Math.round(u.h * s.scale) + 'px';
      rotEl.style.transform = 'translate(-50%, -50%) rotate(' + normRot(s.rotation) + 'deg)';
    }
    const base = el.querySelector('.anno-base'), anno = el.querySelector('.anno');
    for (const svg of [base, anno]) { if (svg) { svg.style.width = Math.round(u.w * s.scale) + 'px'; svg.style.height = Math.round(u.h * s.scale) + 'px'; } }
    // 文本层 / 搜索高亮层 / 朗读高亮层与 SVG 同策略：内部用单位坐标，外层用 scale 拉伸
    for (const cls of ['.textlayer', '.hl-layer', '.speech-layer', '.sj-layer']) {
      const ly = el.querySelector(cls);
      if (ly) { ly.style.width = u.w + 'px'; ly.style.height = u.h + 'px'; ly.style.transform = 'scale(' + s.scale + ')'; }
    }
    if (s.rendered.get(n)) renderPageNum(n);
  }
  App.els.zoom.textContent = Math.round(s.scale * 100) + '%';
}

// ---------- 懒渲染 ----------
// 正在渲染的页（任务未结束）。回收不能只看 rendered=true：
// 快速跳页时上一组的任务还在跑，rendered 仍是 false，但它们已经分配了画布（R02）。
const activeRenders = new Set();

function renderPageNum(n) {
  const s = App.state;
  if (s.mode !== 'pdf') return;
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
  const gen = loadSeq;   // 切文档后旧任务的回写必须作废，否则会把新文档的页标成已渲染（空白页）
  const task = el._pdfPage.render({
    canvasContext: ctx, viewport,
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
  });
  el._task = task;
  activeRenders.add(n);
  task.promise.then(() => {
    // 过期任务（页面已被释放 / 已被新一轮渲染替换 / 已换文档）：不许把离屏页重新标成已渲染
    if (el._task !== task || gen !== loadSeq) return;
    el._task = null;
    activeRenders.delete(n);
    s.rendered.set(n, true);
    buildTextLayer(n);   // 首次渲染后铺设可选中文本层（幂等）
    paintSearchHl(n);    // 若该页有搜索命中，画高亮
  }).catch((err) => {
    if (el._task === task && gen === loadSeq) { el._task = null; activeRenders.delete(n); }
    // 只把「主动取消」当正常；其余错误必须冒出来，否则会出现「页面永远空白」这类静默故障
    const msg = err && err.message ? err.message : String(err);
    if (!/cancel/i.test(msg)) console.error('[render] page ' + n + ' failed:', msg);
  });
}

function freePage(n) {
  if (App.state.mode !== 'pdf') return;
  const el = App.pageEl(n);
  if (!el) return;
  if (el._task) { try { el._task.cancel(); } catch (_) {} el._task = null; }
  activeRenders.delete(n);
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
    // 单页 / 双页对开模式下不用观察器管渲染（隐藏/显示的快照乱序会把刚渲染的页又释放掉），
    // 那边由 scrollToPage 自己负责。
    if (App.state.viewMode !== 'scroll') return;
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
    if (App.state.viewMode !== 'scroll') return;
    for (const e of entries) {
      const n = +e.target.dataset.page;
      if (e.isIntersecting) App.state.visible.add(n);
      else App.state.visible.delete(n);
    }
    syncCurrentPage();
  }, { root: App.els.viewer, rootMargin: '0px 0px' });
}

// 把视口附近的页渲染出来（从单页模式切回连续滚动时用）
function renderVisiblePages() {
  const vr = App.els.viewer.getBoundingClientRect();
  for (let n = 1; n <= App.state.numPages; n++) {
    const el = App.pageEl(n);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom < vr.top - 900 || r.top > vr.bottom + 900) continue;
    if (!App.state.rendered.get(n)) renderPageNum(n);
  }
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
    scheduleRefFollow();   // v34：分屏跟随模式下参考页 = 正文下一页
  }
}

// 连续滚动时页码变化很密，去抖后再写盘，避免每次换页都落一次文件
let pageReportTimer = null;
function schedulePageReport() {
  clearTimeout(pageReportTimer);
  pageReportTimer = setTimeout(() => {
    if (App.state.filePath && window.pdfBridge.reportPage) {
      window.pdfBridge.reportPage(App.state.filePath, App.state.currentPage, App.state.numPages || 0);
    }
    saveSessionNow();   // 页码变了，会话里激活标签的进度也跟着新
  }, 500);
}

// ---------- 阅读时长统计（Calibre reading stats 式；纯逻辑在 src/readingstats.js） ----------
// 心跳制：每 15 秒记一次「当前文档在读」，增量攒在内存，每 10 次心跳 / 手动触发时
// 与磁盘合并落盘（userData/reading-stats.json，不进 library.json）。
const readingTracker = { pending: null, ticks: 0, lastTick: 0, timer: null, flushing: false };

function readingActive() {
  const s = App.state;
  if (!hasDoc(s) || !s.filePath) return false;
  if (document.hidden || document.visibilityState !== 'visible') return false;
  if (window.LibraryUI && LibraryUI.isOpen()) return false;   // 库覆盖层盖着时不算在读
  return true;
}

function readingTick() {
  const now = Date.now();
  const wasActive = readingActive();
  if (!wasActive) { readingTracker.lastTick = now; return; }
  if (!window.ReadingStats) return;
  const delta = Math.max(0, Math.min(30, Math.round((now - readingTracker.lastTick) / 1000)));
  readingTracker.lastTick = now;
  if (!delta) return;
  if (!readingTracker.pending) readingTracker.pending = ReadingStats.empty();
  ReadingStats.addSpan(readingTracker.pending, now, App.state.filePath, delta);
  if (++readingTracker.ticks % 10 === 0) readingFlush();
}

async function readingFlush() {
  if (readingTracker.flushing || !readingTracker.pending || !window.pdfBridge || !pdfBridge.readingStatsMerge) return;
  readingTracker.flushing = true;
  const pending = readingTracker.pending;
  readingTracker.pending = null;
  let r = null;
  try { r = await pdfBridge.readingStatsMerge(pending); } catch (err) { r = { ok: false, error: String(err && err.message || err) }; }
  if (r && r.ok === false) {
    // 落盘失败：把这段增量合回待写队列，下次心跳继续带上，别直接丢掉
    if (window.ReadingStats && ReadingStats.merge) {
      readingTracker.pending = ReadingStats.merge(readingTracker.pending || ReadingStats.empty(), pending);
    }
    if (!readingTracker.warned) {
      readingTracker.warned = true;
      toast('阅读时长暂时没能保存，稍后会自动重试', 4000);
    }
  } else {
    readingTracker.warned = false;
  }
  readingTracker.flushing = false;
}
// 统计面板打开前先把内存里的增量落盘，别让界面比实际少一段（默认 10 次心跳才落一次）
App.readingFlushNow = () => readingFlush();

function startReadingTracker() {
  if (readingTracker.timer) return;
  readingTracker.lastTick = Date.now();
  readingTracker.timer = setInterval(readingTick, 15000);
  document.addEventListener('visibilitychange', () => {
    // 切走/切回都重置心跳锚点：被遮挡的半段不计入，宁可少记不算错
    readingTracker.lastTick = Date.now();
    if (document.visibilityState !== 'visible') readingFlush();
  });
  window.addEventListener('beforeunload', () => { readingFlush(); });
}

// 测试钩子：直接给当前文档记 N 秒 + 立即落盘，返回合并后的统计
App._readingAddForTest = async function (seconds) {
  const s = App.state;
  if (!s.filePath || !window.ReadingStats) return { ok: false };
  if (!readingTracker.pending) readingTracker.pending = ReadingStats.empty();
  ReadingStats.addSpan(readingTracker.pending, Date.now(), s.filePath, seconds);
  await readingFlush();
  const r = await pdfBridge.readingStatsLoad();
  return { ok: true, stats: r && r.stats };
};
App._readingStatsAgg = function (stats, today) {
  return window.ReadingStats ? ReadingStats.aggregate(stats || ReadingStats.empty(), { nDays: 84, today: today || undefined }) : null;
};

// ---------- 阅读会话（v33：restoreTabs） ----------
// 标签变动 / 翻页 / 关窗时把轻量清单（路径 + 页码，不含文档字节）交给主进程存 session.json。
// 页码恢复以库 / 最近打开里记的为准，这里只是兜底。
function sessionTabs() {
  const tabs = [];
  for (const t of App.tabs) {
    if (!t.filePath) continue;
    tabs.push({
      path: t.filePath, name: t.fileName || '',
      kind: t.kind === 'rich' ? 'rich' : 'pdf',
      itemKey: t.itemKey || '', page: Math.max(1, Math.floor(+t.page || 1)),
      rotation: normRot(t.rotation || 0),
      refPage: Math.max(1, Math.floor(+t.refPage || 1)),
    });
  }
  const cur = currentTab();
  return { tabs, active: (cur && cur.filePath) || App.state.filePath || '' };
}
function saveSessionNow() {
  try {
    // R06：启动恢复进行中不能写会话——标签只开了一半时渲染/翻页触发的保存，
    // 会把「部分恢复」的清单写回源快照，丢掉还没恢复的记录。
    if (sessionRestoring) return;
    if (window.pdfBridge && window.pdfBridge.saveSession) window.pdfBridge.saveSession(sessionTabs());
  } catch (_) {}
}
let sessionSaveTimer = null;
let sessionRestoring = false;
function scheduleSessionSave() {
  clearTimeout(sessionSaveTimer);
  sessionSaveTimer = setTimeout(saveSessionNow, 600);
}
window.addEventListener('pagehide', saveSessionNow);

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
  // v9：切文档前先停掉朗读，别让上一篇的声音念着新一篇的文字
  if (App.speakStop) App.speakStop();
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
    s.mode = 'pdf';
    s.richPages = null;
    s.pdfDoc = pdfDoc;
    s.sourceBytes = bytes;
    s.numPages = pdfDoc.numPages;
    s.currentPage = 1;
    s.rotation = normRot(m.rotation || 0);   // v34：标签 / 会话里记的视图旋转
    s.refPage = Math.max(1, Math.floor(+m.refPage || +m.startPage || 1));
    s.fileName = fileName || '';
    s.filePath = m.filePath || '';
    s.itemKey = m.itemKey || '';
    s.item = m.item || null;
    s.citation = m.citation || '';
    s.annos = new Map();
    s.rendered = new Map();
    activeRenders.clear();   // 上一份文档的渲染任务随 pdfDoc 作废，别留在回收名单里
    s.visible = new Set();
    s.textCache = new Map();
    s.search = { query: '', results: [], rects: new Map(), hits: [], hitIndex: -1 };
    s.sj = { byPage: new Map(), builtTo: 0 };   // 智能跳转行缓存随文档作废
    s.bookmarks = [];
    s.bookmarksReady = null;
    searchSeq++;              // 作废上一份文档还在跑的搜索
    pageImageCache = new Map();  // 换文档了，图片位置缓存作废
    if (window.Anno && Anno.reset) Anno.reset();  // 撤销栈不能跨文档
    $('sb-outline')._done = false;
    $('sb-thumbs')._docId = null;
    document.body.classList.add('has-doc');
    document.body.classList.remove('rich-doc');
    const rv = $('doc-view');
    if (rv) { rv.hidden = true; rv.innerHTML = ''; }
    if (App.els.pages) App.els.pages.hidden = false;
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
    syncSplitPane({ relayout: false });   // 先定分屏宽度，再算「适应宽度」，避免首屏缩放跳一下
    applyLayout();
    // 阅读方式（连续滚动 / 单页 / 对开）跟着设置走
    applyViewModeClass();
    applyPageVisibility(s.currentPage);
    const start = Math.min(pdfDoc.numPages, Math.max(1, m.startPage || 1));
    s.startPage = start;
    scrollToPage(start, true);
    setStatus(`${s.fileName} · 共 ${pdfDoc.numPages} 页`);
    // 打开了文档，说明用户已经上手了，把那条提示收掉
    const hint = $('hint-bar');
    if (hint && !hint.hidden) {
      hint.hidden = true;
      try { window.pdfBridge.setSettings && window.pdfBridge.setSettings({ hintSeen: true }); } catch (_) {}
    }
    if (start > 1) toast(`已回到上次阅读的第 ${start} 页`);
    if (start > 1 && window.pdfBridge.reportPage) window.pdfBridge.reportPage(s.filePath, start);
    if (window.LibraryUI) window.LibraryUI.hide(); // 进入阅读，收起库覆盖层
    restoreAnnos(s.filePath);   // 恢复该文件上次保存的标注（异步，不阻塞首屏）
    // v29：PDF 自带的批注不自动写入，只提示一次；用户点「导入 PDF 批注」才合并
    if (window.NativeAnnos) NativeAnnos.hint().catch(() => {});
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

// ---------- 载入富文档（v27：Word / PPT / Excel / Markdown / EPUB 等） ----------
// 主进程已经把文档转成安全 HTML；这里只负责分页展示、缩放、搜索与页码。
function richPageHtml(p, i, total) {
  const title = String(p.title || '');
  return '<article class="doc-page" id="page-' + (i + 1) + '" data-page="' + (i + 1) + '">' +
    (title ? '<header class="doc-page-title">' + escHtml(title) + '</header>' : '') +
    '<div class="doc-page-body">' + String(p.html || '') + '</div>' +
    '<footer class="doc-page-foot">' + (i + 1) + ' / ' + total + '</footer>' +
    '</article>';
}

function setupRichObserver() {
  if (App.richVO) { try { App.richVO.disconnect(); } catch (_) {} }
  App.richVO = new IntersectionObserver((entries) => {
    if (effectiveViewMode() !== 'scroll') return;
    for (const e of entries) {
      const n = +e.target.dataset.page;
      if (e.isIntersecting) App.state.visible.add(n);
      else App.state.visible.delete(n);
    }
    syncCurrentPage();
  }, { root: App.els.viewer, rootMargin: '0px 0px' });
  for (let n = 1; n <= App.state.numPages; n++) {
    const el = App.pageEl(n);
    if (el) App.richVO.observe(el);
  }
}

function loadRichDoc(payload) {
  const s = App.state;
  const my = ++loadSeq;
  try {
    if (s.pdfDoc) { try { s.pdfDoc.destroy(); } catch (_) {} }
    if (App.io) { try { App.io.disconnect(); } catch (_) {} }
    if (App.vo) { try { App.vo.disconnect(); } catch (_) {} }

    const pages = Array.isArray(payload.pages) ? payload.pages : [];
    s.mode = 'rich';
    s.pdfDoc = null;
    s.sourceBytes = null;
    s.rotation = 0;   // 旋转只对 PDF 生效；富文档保持正向
    s.richPages = pages;
    s.numPages = Math.max(1, pages.length);
    s.currentPage = 1;
    s.fileName = payload.fileName || '';
    s.filePath = payload.filePath || '';
    s.itemKey = payload.itemKey || '';
    s.item = payload.item || null;
    s.citation = payload.citation || '';
    s.annos = new Map();
    s.rendered = new Map();
    activeRenders.clear();   // 上一份文档的渲染任务随 pdfDoc 作废，别留在回收名单里
    s.visible = new Set();
    s.textCache = new Map();
    s.search = { query: '', results: [], rects: new Map(), hits: [], hitIndex: -1 };
    searchSeq++;
    pageImageCache = new Map();
    if (window.Anno && Anno.reset) Anno.reset();
    $('sb-outline')._done = false;
    $('sb-thumbs')._docId = null;

    document.body.classList.add('has-doc', 'rich-doc');
    const pagesHost = $('pages');
    if (pagesHost) { pagesHost.hidden = true; pagesHost.innerHTML = ''; }
    const host = $('doc-view');
    if (host) {
      host.hidden = false;
      host.innerHTML = pages.map((p, i) => richPageHtml(p, i, pages.length)).join('');
      // v9.5：富文档页也挂标注层（和 PDF 页同一套两个 SVG）。
      // 不设 viewBox → 用户单位就是页面 CSS 像素；页面因图片加载变高时标注不会漂，
      // 缩放由 #doc-view 的 CSS zoom 统一处理，标注天然跟着放大缩小。
      for (const pageEl of host.querySelectorAll('.doc-page')) {
        const n = +pageEl.dataset.page;
        const base = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        base.setAttribute('class', 'anno-base');
        const anno = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        anno.setAttribute('class', 'anno');
        pageEl.appendChild(base);
        pageEl.appendChild(anno);
        if (window.Anno) window.Anno.attachPage(pageEl, n, anno);
        pageEl._unit = { w: pageEl.offsetWidth || 900, h: pageEl.offsetHeight || 1200 };
      }
    }
    App.els.pageCount.textContent = '/ ' + s.numPages;
    App.els.pageInput.max = String(s.numPages);
    App.els.fileName.textContent = s.fileName;
    if (window.pdfBridge.setTitle) window.pdfBridge.setTitle(s.fileName);

    setupRichObserver();
    syncSplitPane({ relayout: false });   // 富文档不显示参考视图，把宽度还给正文
    applyLayout();
    applyViewModeClass();
    applyPageVisibility(s.currentPage);
    const start = Math.min(s.numPages, Math.max(1, +payload.startPage || 1));    s.startPage = start;
    // 等页面插入后再定位，scrollIntoView 才有布局可算（隐藏窗口里 rAF 不触发，用 setTimeout 兜底）
    setTimeout(() => scrollToPage(start, true), 0);
    setStatus(`${s.fileName} · ${payload.format || '文档'} · 共 ${s.numPages} 页`);
    const hint = $('hint-bar');
    if (hint && !hint.hidden) {
      hint.hidden = true;
      try { window.pdfBridge.setSettings && window.pdfBridge.setSettings({ hintSeen: true }); } catch (_) {}
    }
    if (start > 1) toast(`已回到上次阅读的第 ${start} 页`);
    if (start > 1 && window.pdfBridge.reportPage) window.pdfBridge.reportPage(s.filePath, start);
    if (window.LibraryUI) window.LibraryUI.hide();
    restoreAnnos(s.filePath);   // 富文档的标注也按文件路径存取，和 PDF 一致
    refreshSidebar();
    syncActiveTab({ page: start, fileName: s.fileName, filePath: s.filePath });
    renderTabs();
  } catch (err) {
    App.lastLoadError = String(err && err.stack || err);
    console.error(err);
    setStatus('打开失败：' + (err && err.message ? err.message : err));
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
  t.rotation = normRot(App.state.rotation || 0);
  if (App.state.split) t.refPage = Math.max(1, App.state.refPage || 1);
  if (extra) Object.assign(t, extra);
}

function makeTab(payload) {
  if (payload.kind === 'rich' || (Array.isArray(payload.pages) && !payload.data)) {
    return {
      id: 'tab-' + (++App.tabSeq),
      kind: 'rich',
      fileName: payload.fileName || '未命名文档',
      filePath: payload.filePath || '',
      itemKey: payload.itemKey || '',
      item: payload.item || null,
      citation: payload.citation || '',
      pages: payload.pages || [],
      format: payload.format || '',
      page: Math.max(1, Math.floor(+payload.startPage || 1)),
      rotation: 0,
      refPage: Math.max(1, Math.floor(+payload.startPage || 1)),
    };
  }
  const raw = payload.data;
  const data = raw instanceof Uint8Array ? raw.slice() : new Uint8Array(raw);
  return {
    id: 'tab-' + (++App.tabSeq),
    kind: 'pdf',
    fileName: payload.fileName || '未命名.pdf',
    filePath: payload.filePath || '',
    itemKey: payload.itemKey || '',
    item: payload.item || null,
    citation: payload.citation || '',
    data,
    page: Math.max(1, Math.floor(+payload.startPage || 1)),
    rotation: normRot(payload.rotation || 0),
    refPage: Math.max(1, Math.floor(+payload.refPage || payload.startPage || 1)),
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
  scheduleSessionSave();   // v33：标签增删 / 切换后同步会话清单
}

function loadTab(tab) {
  if (!tab) return;
  App.activeTabId = tab.id;
  if (tab.kind === 'rich') {
    loadRichDoc({
      ok: true, kind: 'rich', pages: tab.pages, fileName: tab.fileName, filePath: tab.filePath,
      itemKey: tab.itemKey, item: tab.item, citation: tab.citation, format: tab.format,
      startPage: tab.page,
    });
    return;
  }
  loadPdf(tab.data.slice(), tab.fileName, false, {
    filePath: tab.filePath, itemKey: tab.itemKey, item: tab.item, citation: tab.citation,
    startPage: tab.page, rotation: tab.rotation, refPage: tab.refPage,
  });
}

async function switchTab(id, page) {
  const t = tabById(id);
  if (!t) return;
  if (id === App.activeTabId) {
    if (page) scrollToPage(page, false, true);
    return;
  }
  syncActiveTab();
  const previous = App.activeTabId;
  if (await App.flushAnnos() === false || previous !== App.activeTabId || !tabById(id)) return;
  if (page) t.page = Math.max(1, Math.floor(+page || 1));
  loadTab(t);
}

function closeDocument() {
  const s = App.state;
  if (s.pdfDoc) { try { s.pdfDoc.destroy(); } catch (_) {} }
  if (App.io) { try { App.io.disconnect(); } catch (_) {} }
  if (App.vo) { try { App.vo.disconnect(); } catch (_) {} }
  if (App.richVO) { try { App.richVO.disconnect(); } catch (_) {} }
  pageImageCache = new Map();
  if (window.Anno && Anno.reset) Anno.reset();   // 撤销栈不能跨文档
  if (App.speakStop) App.speakStop();            // v9：关文档别再念上一篇
  searchSeq++;
  s.pdfDoc = null; s.sourceBytes = null; s.numPages = 0; s.currentPage = 1;
  s.mode = 'pdf'; s.richPages = null; s.itemKey = ''; s.item = null; s.citation = '';
  s.fileName = ''; s.filePath = ''; s.startPage = 1;
  s.rotation = 0; s.refPage = 1;
  s.annos = new Map(); s.rendered = new Map(); activeRenders.clear(); s.visible = new Set(); s.textCache = new Map();
  s.search = { query: '', results: [], rects: new Map(), hits: [], hitIndex: -1 };
  if (App.els.pages) { App.els.pages.innerHTML = ''; App.els.pages.hidden = false; }
  const rv = $('doc-view');
  if (rv) { rv.hidden = true; rv.innerHTML = ''; rv.style.zoom = ''; }
  document.body.classList.remove('has-doc', 'rich-doc');
  // 侧栏三个面板是按文档缓存的，关文档必须一起清空——否则回到空白阅读页
  // 还挂着上一篇的缩略图/目录/批注（refreshSidebar 没有 doc 会直接 return，清不到）。
  const so = $('sb-outline'), st = $('sb-thumbs'), sa = $('sb-annos');
  if (so) { so.innerHTML = ''; so._done = false; }
  if (st) { st.innerHTML = ''; st._docId = null; }
  if (thumbIO) { try { thumbIO.disconnect(); } catch (_) {} thumbIO = null; }
  if (sa) {
    const sr = $('sb-search-results');   // 搜索结果容器是 initSidebar 挂进去的，要保留
    sa.innerHTML = '';
    if (sr) { sr.hidden = true; sr.innerHTML = ''; sa.appendChild(sr); }
  }
  annoQuery = '';
  if (App.els.pageCount) App.els.pageCount.textContent = '/ 0';
  if (App.els.pageInput) { App.els.pageInput.value = '1'; App.els.pageInput.max = '1'; }
  if (App.els.fileName) App.els.fileName.textContent = '';
  if (App.els.zoom) App.els.zoom.textContent = '—';
  syncSplitPane({ relayout: false });   // 没有文档了，参考视图收起（偏好保留）
  setStatus('就绪');
  renderTabs();
  if (window.LibraryUI && window.pdfBridge.isApp) window.LibraryUI.show();
}

async function closeTab(id) {
  let idx = App.tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const wasActive = App.tabs[idx].id === App.activeTabId;
  if (wasActive) {
    syncActiveTab();
    if (await App.flushAnnos() === false || App.activeTabId !== id) return;
    idx = App.tabs.findIndex(t => t.id === id);
    if (idx < 0) return;
  }
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
async function openDocument(payload, opts) {
  const o = opts || {};
  if (!payload || !payload.ok) return;
  if (payload.smoke) { loadPdf(payload.data, payload.fileName, true, payload); return; }
  const rich = payload.kind === 'rich' || (Array.isArray(payload.pages) && !payload.data);
  const p = payload.filePath || '';
  const same = p ? App.tabs.find((t) => t.filePath === p) : null;
  if (same && !o.forceNew) {
    if (same.id === App.activeTabId) {
      if (payload.startPage) scrollToPage(payload.startPage, false, true);
    } else switchTab(same.id, payload.startPage);
    return;
  }
  if (App.state.filePath) {
    const previous = App.activeTabId;
    if (await App.flushAnnos() === false || previous !== App.activeTabId) return;
    syncActiveTab();
  }
  let tab;
  if (!o.newTab && currentTab()) {
    tab = currentTab();
    if (rich) {
      tab.kind = 'rich';
      tab.pages = payload.pages || [];
      tab.format = payload.format || '';
      tab.data = null;
    } else {
      tab.kind = 'pdf';
      const raw = payload.data;
      tab.data = raw instanceof Uint8Array ? raw.slice() : new Uint8Array(raw);
      tab.pages = null;
    }
    tab.fileName = payload.fileName || tab.fileName;
    tab.filePath = p;
    tab.itemKey = payload.itemKey || '';
    tab.item = payload.item || null;
    tab.citation = payload.citation || '';
    tab.page = Math.max(1, Math.floor(+payload.startPage || 1));
    tab.rotation = normRot(payload.rotation || 0);
    tab.refPage = Math.max(1, Math.floor(+payload.refPage || payload.startPage || 1));
  } else {
    tab = makeTab(payload);
    App.tabs.push(tab);
  }
  App.activeTabId = tab.id;
  if (rich) {
    loadRichDoc(Object.assign({}, payload, {
      startPage: tab.page, filePath: tab.filePath, itemKey: tab.itemKey,
      fileName: tab.fileName, item: tab.item, citation: tab.citation,
    }));
    return;
  }
  loadPdf(tab.data.slice(), tab.fileName, false, Object.assign({}, payload, {
    startPage: tab.page, filePath: tab.filePath, itemKey: tab.itemKey,
    item: tab.item, citation: tab.citation,
    rotation: tab.rotation, refPage: tab.refPage,
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
    // v34：朗读的句级高亮单独一层，不和搜索高亮抢 DOM
    const speechLayer = document.createElement('div');
    speechLayer.className = 'speech-layer';
    speechLayer.style.width = w + 'px'; speechLayer.style.height = h + 'px';
    // 智能跳转的目标高亮层（点引用标记 → 参考文献条目的落点标记）
    const sjLayer = document.createElement('div');
    sjLayer.className = 'sj-layer';
    sjLayer.style.width = w + 'px'; sjLayer.style.height = h + 'px';
    // v34：所有页面内容放进旋转层，.page 只负责占位（旋转 90° 时宽高互换）
    const rot = document.createElement('div');
    rot.className = 'page-rot';
    rot.style.width = w + 'px'; rot.style.height = h + 'px';
    rot.appendChild(canvas); rot.appendChild(base); rot.appendChild(textlayer); rot.appendChild(hlLayer);
    rot.appendChild(speechLayer); rot.appendChild(sjLayer); rot.appendChild(anno);
    el.appendChild(rot);
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
// 返回 Promise：朗读需要等文本层就绪后按 span 建 Range 做句级高亮。
function buildTextLayer(n) {
  const el = App.pageEl(n);
  if (!el || !el._pdfPage) return Promise.resolve();
  if (el._textPromise) return el._textPromise;
  el._textDone = true;
  el._textPromise = (async () => {
    try {
      const host = el.querySelector('.textlayer');
      if (!host) return;
      const vp = el._pdfPage.getViewport({ scale: 1 });
      let items;
      try { items = await getTextContent(n); } catch (_) { items = []; }
      const frag = document.createDocumentFragment();
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!item || !item.str) continue;
        const tx = window.pdfjsLib.Util.transform(vp.transform, item.transform);
        const fh = Math.hypot(tx[2], tx[3]);
        if (!fh || !isFinite(fh)) continue;
        const span = document.createElement('span');
        span.textContent = item.str;
        span.dataset.item = String(i);   // 朗读按 item 序号回查 span
        span.style.left = tx[4] + 'px';
        span.style.top = (tx[5] - fh) + 'px';
        span.style.fontSize = fh + 'px';
        const ang = Math.atan2(tx[1], tx[0]);
        if (Math.abs(ang) > 0.001) span.style.transform = 'rotate(' + ang + 'rad)';
        frag.appendChild(span);
      }
      host.appendChild(frag);
    } catch (_) { /* 文本层失败不应阻断渲染；朗读会把它当无文字处理 */ }
  })();
  return el._textPromise;
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
  // 重画会冲掉「当前命中」的标记，这里补回来
  markCurrentHit();
}

// 全文搜索：遍历所有页文本，命中处生成「跳转结果 + 单位坐标高亮矩形」。
// 限制：命中必须落在单个文本项内（跨行/跨项的关键词匹配不到，和 PDF.js viewer 的行为一致）。
App.doSearch = async function (queryRaw) {
  const s = App.state;
  const q = String(queryRaw || '').trim().toLowerCase();
  // 从文献库点全文结果进来时是程序化调用，把词回填到搜索框，让用户看到「在搜什么」
  const sbx = $('search-box');
  if (sbx && sbx.value.trim() !== String(queryRaw || '').trim()) sbx.value = String(queryRaw || '');
  const seq = ++searchSeq;          // 本次搜索的代号：后面的 await 都要先验它
  if (s.mode === 'rich') { richSearch(queryRaw, seq); return; }
  s.search = { query: q, results: [], rects: new Map(), hits: [], hitIndex: -1 };
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
      s.search.hits.push({ page: n, rect: rect });
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
  // v9：有命中就直接跳到第一处（从文献库点全文结果进来时，落点就是命中位置）
  if (s.search.hits.length) gotoSearchHit(1);
};

// 擦掉所有页面上已经画出的搜索高亮（清空搜索 / 换文档时调用）
function clearSearchHl() {
  if (App.state.mode === 'rich') { clearRichSearchMarks(); return; }
  for (const el of document.querySelectorAll('#pages .page')) {
    const host = el.querySelector('.hl-layer');
    if (host) host.innerHTML = '';
  }
}

// ---------- 富文档搜索：直接包裹 DOM 文本节点 ----------
// 不把整页 innerHTML 重新拼字符串，避免破坏表格/图片结构。
function clearRichSearchMarks() {
  const host = $('doc-view');
  if (!host) return;
  for (const m of host.querySelectorAll('mark.doc-hit')) {
    const parent = m.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(m.textContent || ''), m);
    parent.normalize();
  }
}

function richSearch(queryRaw, seq) {
  const s = App.state;
  const q = String(queryRaw || '').trim();
  const ql = q.toLowerCase();
  clearRichSearchMarks();
  s.search = { query: ql, results: [], rects: new Map(), hits: [], hitIndex: -1 };
  if (!q || !s.richPages) {
    renderSearchResults();
    refreshAnnoPane();
    return;
  }
  setStatus('搜索中…');
  const hits = [];
  for (let n = 1; n <= s.numPages; n++) {
    if (seq !== searchSeq) return;
    const pageEl = App.pageEl(n);
    const body = pageEl && pageEl.querySelector('.doc-page-body');
    if (!body) continue;
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const v = node.nodeValue || '';
        if (!v.trim()) return NodeFilter.FILTER_REJECT;
        if (node.parentElement && node.parentElement.closest('mark.doc-hit')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    let cur;
    while ((cur = walker.nextNode())) nodes.push(cur);
    for (const node of nodes) {
      const text = node.nodeValue || '';
      const hay = text.toLowerCase();
      if (hay.indexOf(ql) < 0) continue;
      const frag = document.createDocumentFragment();
      let at = 0, idx;
      while ((idx = hay.indexOf(ql, at)) >= 0) {
        if (idx > at) frag.appendChild(document.createTextNode(text.slice(at, idx)));
        const mark = document.createElement('mark');
        mark.className = 'doc-hit';
        mark.dataset.page = String(n);
        mark.textContent = text.slice(idx, idx + q.length);
        frag.appendChild(mark);
        const start = Math.max(0, idx - 40);
        const end = Math.min(text.length, idx + q.length + 70);
        let snippet = text.slice(start, end).replace(/\s+/g, ' ').trim();
        if (start > 0) snippet = '…' + snippet;
        if (end < text.length) snippet += '…';
        hits.push({ page: n, mark, snippet });
        at = idx + q.length;
      }
      if (at < text.length) frag.appendChild(document.createTextNode(text.slice(at)));
      if (node.parentNode) node.parentNode.replaceChild(frag, node);
    }
  }
  if (seq !== searchSeq) return;
  s.search.hits = hits;
  s.search.results = hits.map((h) => ({ page: h.page, snippet: h.snippet }));
  renderSearchResults();
  setStatus(`「${q}」共 ${hits.length} 处命中`);
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

// ---------- 搜索命中上下跳（F3 / Shift+F3） ----------
function markCurrentHit() {
  const s = App.state;
  if (s.mode === 'rich') {
    for (const el of document.querySelectorAll('#doc-view mark.doc-hit.is-current')) el.classList.remove('is-current');
    const h = s.search.hits && s.search.hits[s.search.hitIndex];
    if (h && h.mark && h.mark.isConnected) h.mark.classList.add('is-current');
    return;
  }
  for (const el of document.querySelectorAll('#pages .page .hl-layer .hl.is-current')) {
    el.classList.remove('is-current');
  }
  const hits = s.search.hits || [];
  const i = s.search.hitIndex == null ? -1 : s.search.hitIndex;
  if (i < 0 || !hits.length) return;
  const h = hits[i];
  if (!h) return;
  const pageEl = App.pageEl(h.page);
  if (!pageEl) return;
  const list = s.search.rects.get(h.page) || [];
  const idx = list.indexOf(h.rect);
  const nodes = pageEl.querySelectorAll('.hl-layer .hl');
  if (idx >= 0 && nodes[idx]) nodes[idx].classList.add('is-current');
}

function gotoSearchHit(step) {
  const s = App.state;
  const hits = s.search.hits || [];
  if (!hits.length) { toast('没有搜索命中'); return; }
  let i = (s.search.hitIndex == null ? -1 : s.search.hitIndex);
  i = i + step;
  if (i < 0) i = hits.length - 1;
  if (i >= hits.length) i = 0;
  s.search.hitIndex = i;
  const h = hits[i];
  if (s.mode === 'rich') {
    scrollToPage(h.page, true, true);
    if (h.mark && h.mark.isConnected) {
      h.mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    markCurrentHit();
    setStatus('第 ' + (i + 1) + ' / ' + hits.length + ' 处命中 · ' + s.search.query);
    return;
  }
  scrollToPage(h.page, false, true);
  const pageEl = App.pageEl(h.page);
  if (pageEl) {
    const vr = App.els.viewer.getBoundingClientRect();
    const pr = pageEl.getBoundingClientRect();
    // v34：按旋转后的槽内偏移定位；90/270 时命中的「纵向」其实是屏幕横向
    const off = unitToSlotOffset(pageEl, h.rect.x + h.rect.w / 2, h.rect.y + h.rect.h / 2);
    App.els.viewer.scrollTop += (pr.top + off.y) - vr.top - vr.height * 0.3;
    if (normRot(App.state.rotation) !== 0) {
      // 旋转后命中的横向位置也变了（90/270 是纵向变横向，180 是左右镜像）
      App.els.viewer.scrollLeft += (pr.left + off.x) - vr.left - vr.width / 2;
    }
  }
  markCurrentHit();
  setStatus('第 ' + (i + 1) + ' / ' + hits.length + ' 处命中 · ' + s.search.query);
}

// ---------- 智能跳转（Smart Jump，逻辑在 src/smartjump.js） ----------
// 点正文里的引用标记（[12] / [Smith, 2020]）跳到参考文献条目；点参考文献条目反查正文标记。
// 引用几乎都没有超链接，只能按文字识别；参考 Sioyek 的 Smart Jump。
function SJ() { return window.SmartJump; }

function sjClearHl() {
  for (const host of document.querySelectorAll('#pages .page .sj-layer')) host.innerHTML = '';
}

// 在页面单位坐标系里画智能跳转落点标记（与搜索高亮同层策略，互不干扰）
function sjPaint(pageN, rects) {
  const el = App.pageEl(pageN);
  const host = el && el.querySelector('.sj-layer');
  if (!host) return;
  for (const r of rects) {
    const d = document.createElement('div');
    d.className = 'sj-hl';
    d.style.left = r.x + 'px'; d.style.top = r.y + 'px';
    d.style.width = r.w + 'px'; d.style.height = r.h + 'px';
    host.appendChild(d);
  }
}

// 行矩形（单位坐标）：行内条目取并集，纵向按基线-字高到基线+0.25 字高
function sjLineRect(items, line) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const ix of line.idx) {
    const it = items[ix];
    if (!it) continue;
    x0 = Math.min(x0, it.x); y0 = Math.min(y0, it.y - it.fh);
    x1 = Math.max(x1, it.x + it.w); y1 = Math.max(y1, it.y + it.fh * 0.25);
  }
  if (!isFinite(x0)) return null;
  return { x: x0, y: y0, w: Math.max(6, x1 - x0), h: Math.max(6, y1 - y0) };
}

// 归一化一页的文本项（scale=1 视口坐标，与搜索高亮同坐标系）
async function sjPageItems(n) {
  const el = App.pageEl(n);
  if (!el || !el._pdfPage) return [];
  const vp = el._pdfPage.getViewport({ scale: 1 });
  let items;
  try { items = await getTextContent(n); } catch (_) { return []; }
  const norm = [];
  for (const item of items) {
    if (!item || !item.str) continue;
    const tx = window.pdfjsLib.Util.transform(vp.transform, item.transform);
    const fh = Math.hypot(tx[2], tx[3]);
    if (!fh || !isFinite(fh)) continue;
    norm.push({ str: item.str, x: tx[4], y: tx[5], w: Math.max(4, item.width || item.str.length * fh * 0.5), fh });
  }
  return norm;
}

// 增量构建跨页行缓存（参考文献通常在当前页之后，先往后扫）。
// 缓存按页存（byPage: page → 行数组）：用户可能先跳着点某一页，若把点击页追加到
// 数组开头，行序就不再是文档序，参考文献标题/条目的前后判断会全错（B09）。
// 需要「整篇行序」时用 sjOrderedLines() 按页号重新拼，定位用页号 + 行对象，不用裸下标。
async function sjEnsureLines(toPage) {
  const s = App.state;
  const sj = s.sj;
  const limit = Math.min(s.numPages, Math.max(0, toPage | 0));
  for (let n = sj.builtTo + 1; n <= limit; n++) {
    // 该页可能已经被「跳着点」单独补进缓存：不能再建一份，
    // 否则点击时拿到的行对象会脱离缓存，行序定位就失效了。
    if (!sj.byPage.has(n)) {
      const norm = await sjPageItems(n);
      if (norm.length) sj.byPage.set(n, SJ().buildLines(norm).map((ln) => Object.assign({ page: n }, ln)));
    }
    sj.builtTo = Math.max(sj.builtTo, n);
  }
  return sj;
}

// 按页序拼出整篇行数组（第 1 页在前）
function sjOrderedLines(sj) {
  const out = [];
  for (let n = 1; n <= (App.state.numPages || 0); n++) {
    const rows = sj.byPage.get(n);
    if (rows) for (const ln of rows) out.push(ln);
  }
  return out;
}

// 行对象在整篇行序里的下标：页号之前的页行数之和 + 页内位置。
// 页内找不到同一个对象时按「文本 + 基线」回退匹配，绝不返回一个错位的下标。
function sjLineIndex(sj, page, line) {
  let idx = 0;
  for (let n = 1; n < page; n++) {
    const rows = sj.byPage.get(n);
    if (rows) idx += rows.length;
  }
  const rows = sj.byPage.get(page) || [];
  let at = rows.indexOf(line);
  if (at < 0 && line) {
    at = rows.findIndex((r) => r.text === line.text && Math.abs(r.y - line.y) < 1);
  }
  return at < 0 ? idx : idx + at;
}

// 点击点 → 所在行 + 行内偏移。返回 { page, line, caret, lineText } 或 null
function sjLocateClick(pageN, unitX, unitY) {
  const s = App.state;
  const sj = s.sj;
  const rows = sj.byPage.get(pageN) || [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const ln = rows[i];
    const top = ln.y - ln.h, bottom = ln.y + ln.h * 0.4;
    if (unitY < top || unitY > bottom) continue;
    if (unitX < ln.x - 2 || unitX > ln.x + ln.w + 2) continue;
    // 行内偏移：按各条目的 x 区间估字符位（宽度近似，够定位标记用）
    const pageItems = sj._itemsCache && sj._itemsCache[pageN] ? sj._itemsCache[pageN] : null;
    let caret = 0, acc = 0;
    for (const ix of ln.idx) {
      const it = pageItems ? pageItems[ix] : null;
      const w = it ? it.w : 8, str = it ? it.str : '';
      if (!it || unitX <= it.x + w) {
        caret = acc + (it ? Math.max(0, Math.min(str.length, Math.round((unitX - it.x) / Math.max(2, w / Math.max(1, str.length))))) : 0);
        break;
      }
      acc += str.length;
      caret = acc;
    }
    return { page: pageN, line: ln, caret, lineText: ln.text };
  }
  return null;
}

// 点击位置直接驱动的入口（真实 click 事件与测试探针共用）。
// pageElHint：测试时直接指定目标页（隐藏窗口里平滑滚动会让屏幕坐标对不上元素）。
App._smartJumpAt = async function (clientX, clientY, pageElHint) {
  const s = App.state;
  if (s.mode !== 'pdf' || !s.pdfDoc || !SJ()) return null;
  const el = document.elementFromPoint(clientX, clientY);
  const pageEl = pageElHint || (el && el.closest ? el.closest('#pages .page') : null);
  if (!pageEl) return null;
  const pageN = parseInt(pageEl.dataset.page, 10) || 1;
  const p = clientToUnit(pageEl, clientX, clientY);
  const items = await sjPageItems(pageN);
  s.sj._itemsCache = s.sj._itemsCache || {};
  s.sj._itemsCache[pageN] = items;
  if (!s.sj.byPage.has(pageN)) {
    // 该页行还没进缓存（用户跳着点）：把这一页按页号补进去，不动其他页
    s.sj.byPage.set(pageN, SJ().buildLines(items).map((ln) => Object.assign({ page: pageN }, ln)));
  }
  const loc = sjLocateClick(pageN, p.x, p.y);
  if (!loc) return null;
  return await sjExecute(loc);
};

App._smartJumpLast = function () { return App.state._sjLast || null; };

async function sjExecute(loc) {
  const s = App.state;
  const sjMod = SJ();
  // 扫描要读很多页文本，期间用户可能已经切了文档：每个 await 之后都要重新确认归属，
  // 否则会把旧文档的高亮和跳页画到新文档上。
  const gen = loadSeq;
  const stale = () => gen !== loadSeq;
  const cite = sjMod.extractCitation(loc.lineText, loc.caret);
  // 既不是引用标记、也不像参考文献条目（无编号、无姓氏+年份）时直接返回：
  // 不必为了确认「这里不是引用」把整篇 PDF 的文本都扫一遍。
  const entryGuess = cite ? null : sjParseEntry(loc.lineText);
  if (!cite && !entryGuess) {
    sjClearHl();
    s._sjLast = { kind: 'none', fromPage: loc.page, found: false };
    return s._sjLast;
  }
  await sjEnsureLines(s.numPages);
  if (stale()) return { kind: 'none', fromPage: loc.page, found: false, stale: true };
  const lines = sjOrderedLines(s.sj);
  const myLineIdx = sjLineIndex(s.sj, loc.page, loc.line);
  // 参考文献起点：从当前行往后找（参考文献表在正文之后；找不到再从头扫一遍）
  let bibStart = sjMod.findBibStartIndex(lines, myLineIdx);
  if (bibStart < 0) bibStart = sjMod.findBibStartIndex(lines, 0);
  const inBib = bibStart >= 0 && myLineIdx > bibStart;

  sjClearHl();
  const result = { kind: cite ? cite.kind : (inBib ? 'entry' : 'none'), fromPage: loc.page };
  if (cite) {
    const entryIdx = bibStart >= 0 ? sjMod.findEntryLine(lines, bibStart, cite) : -1;
    result.target = cite; result.found = entryIdx >= 0;
    if (entryIdx >= 0) {
      const ln = lines[entryIdx];
      const entryItems = await sjPageItems(ln.page);
      if (stale()) return { kind: cite.kind, fromPage: loc.page, found: true, stale: true };
      s.sj._itemsCache[ln.page] = entryItems;
      const built = sjMod.buildLines(entryItems);
      const row = built.find((r) => r.text === ln.text) || built[0];
      const rect = sjLineRect(entryItems, row || ln);
      scrollToPage(ln.page, false, true);   // 记入导航历史，Alt+← 能回来
      setTimeout(() => sjScrollToRect(ln.page, rect), 60);
      sjPaint(ln.page, rect ? [rect] : []);
      result.toPage = ln.page; result.entryText = ln.text.slice(0, 80);
      setStatus('引用 ' + (cite.numbers ? '[' + cite.numbers.join(',') + ']' : cite.surname + ' ' + cite.year) + ' → 参考文献');
    } else {
      setStatus('没找到对应的参考文献条目');
    }
  } else if (inBib) {
    // 反向：参考文献行 → 正文里的引用标记
    const target = sjParseEntry(loc.lineText);
    result.target = target; result.found = !!target;
    if (target) {
      const marks = [];
      for (let n = 1; n <= s.numPages && marks.length < 40; n++) {
        const items = await sjPageItems(n);
        if (stale()) return { kind: 'entry', fromPage: loc.page, found: !!target, stale: true };
        if (!items.length) continue;
        const pageText = items.map((it) => it.str).join('');
        const poses = sjMod.findMarkerPositions(pageText, target, 40);
        for (const pos of poses) {
          // 字符位置 → 文本项：按条目累计长度回查，高亮整个文本项
          let acc = 0, hit = null;
          for (let i = 0; i < items.length; i++) {
            const it = items[i];
            if (pos.start < acc + it.str.length) { hit = it; break; }
            acc += it.str.length;
          }
          if (hit) marks.push({ page: n, rect: { x: hit.x, y: hit.y - hit.fh, w: hit.w, h: hit.fh * 1.3 } });
        }
      }
      result.markers = marks.length;
      if (marks.length) {
        scrollToPage(marks[0].page, false, true);
        setTimeout(() => sjScrollToRect(marks[0].page, marks[0].rect), 60);
        for (const mk of marks) sjPaint(mk.page, [mk.rect]);
        result.toPage = marks[0].page;
        setStatus('正文里找到 ' + marks.length + ' 处引用标记');
      } else {
        setStatus('正文里没有找到这条的引用标记');
      }
    }
  } else {
    result.found = false;
  }
  s._sjLast = result;
  return result;
}

// 从参考文献条目行解析出可反查的目标（行号或姓氏+年份）
function sjParseEntry(text) {
  const t = String(text || '').trim();
  const num = /^\s*[\[（(]?(\d{1,3})[\].）、)]?\s+/.exec(t) || /^\s*(\d{1,3})[.、)）]\s*/.exec(t);
  if (num) return { numbers: [parseInt(num[1], 10)] };
  // 作者-年份条目：第一个大写开头的词当姓氏 + 行里的 4 位年份
  const year = /(19|20)\d{2}/.exec(t);
  const name = /[A-Z][A-Za-z'’\-]+/.exec(t);
  if (year && name) return { surname: name[0], year: year[0] };
  return null;
}

// 把目标行滚到视口上部 30% 处（复用搜索命中的定位算法）
function sjScrollToRect(pageN, rect) {
  if (!rect) return;
  const pageEl = App.pageEl(pageN);
  if (!pageEl) return;
  const vr = App.els.viewer.getBoundingClientRect();
  const pr = pageEl.getBoundingClientRect();
  const off = unitToSlotOffset(pageEl, rect.x + rect.w / 2, rect.y + rect.h / 2);
  App.els.viewer.scrollTop += (pr.top + off.y) - vr.top - vr.height * 0.3;
  if (normRot(App.state.rotation) !== 0) {
    App.els.viewer.scrollLeft += (pr.left + off.x) - vr.left - vr.width / 2;
  }
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
    if (r) { scrollToPage(+r.dataset.goto, false, true); return; }
    const del = e.target.closest('[data-anno-del]');
    if (del) { deleteAnno(+del.dataset.annoPage, +del.dataset.annoIdx); return; }
    const cmt = e.target.closest('[data-anno-comment]');
    if (cmt) { editAnnoComment(+cmt.dataset.annoPage, +cmt.dataset.annoIdx); return; }
    const tagBtn = e.target.closest('[data-anno-tag]');
    if (tagBtn) { e.stopPropagation(); addAnnoTag(tagBtn, +tagBtn.dataset.annoPage, +tagBtn.dataset.annoIdx); return; }
    const jump = e.target.closest('[data-anno-jump]');
    if (jump) scrollToPage(+jump.dataset.annoJump, false, true);
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

// ---------- 用户书签（B 键 / 侧栏目录页顶部的「我的书签」块） ----------
// 并发约定（R01/R05，在 B01/B03 之上）：
//   1) 同一文档（按路径）一条串行队列：后一次基于前一次「已成功落盘」的结果构造候选，
//      不会出现两次操作各写各的、最后只剩一条。同页连续 toggle 两次 = 加 → 删。
//   2) 队列按**文件路径**跨加载代际共享：重新打开同一份文档时沿用同一条链，
//      只把工作副本换成新代际读到的磁盘内容，避免新旧两条队列并行覆盖磁盘（R05）。
//   3) 任务真正开始时（发 IPC 之前）再校验一次路径 + 加载代际：切走 / 关闭 / 重新打开后，
//      尚未发送的旧任务直接取消，不再写盘。
//   4) 落盘成功就是磁盘真相：即使代际已过期也推进队列工作副本（但不动界面），
//      否则新代际会基于过期副本覆盖刚写成功的内容。
//   5) 界面更新只按代际过滤；首次操作前等这一份文档的书签读盘完成。
// 这段代码被 scripts/test-audit-fixes.js 直接切出来做受控时序验证：
// 保持「状态声明在前、App.bookmarkToggle 赋值在末尾」的结构。
const bookmarkQueues = new Map();   // path → { chain, list, gen, pending }

function bookmarkQueueFor(path, gen, seed) {
  const initial = (Array.isArray(seed) ? seed : []).slice();
  let q = bookmarkQueues.get(path);
  if (!q) {
    q = { chain: Promise.resolve(), list: initial, gen, pending: 0 };
    bookmarkQueues.set(path, q);
  } else if (q.gen !== gen) {
    // 新代际：以这次读盘的结果为基线，但继续排在同一条链上
    q.gen = gen;
    q.list = initial;
  }
  return q;
}

// 队列空了且已经不属于当前文档：把条目丢掉，别让 Map 随会话一直长
function bookmarkQueueSweep(path, q) {
  if (q.pending > 0) return;
  if (q.gen === loadSeq && App.state.filePath === path) return;
  if (bookmarkQueues.get(path) === q) bookmarkQueues.delete(path);
}

// 一次书签提交：候选 → 落盘 → 成功后提交工作副本；失败只回滚界面，不动工作副本
async function bookmarkCommit(q, path, gen, page) {
  // 真正开始执行时再确认一次归属：切走 / 关闭 / 重新打开后，未发送的任务不再写盘（R05）
  if (gen !== loadSeq || App.state.filePath !== path) {
    return { ok: false, canceled: true, error: '文档已切换，未保存' };
  }
  const current = () => gen === loadSeq && App.state.filePath === path;
  const i = q.list.findIndex((b) => b.page === page);
  const next = q.list.filter((b, k) => k !== i);
  if (i < 0) next.push({ page, at: Date.now(), label: '' });
  next.sort((a, b) => a.page - b.page);
  let r;
  try {
    r = await pdfBridge.bookmarksSave(path, next);
  } catch (err) {
    r = { ok: false, error: String((err && err.message) || err) };
  }
  if (r && r.ok) {
    q.list = (Array.isArray(r.bookmarks) ? r.bookmarks : next).slice();
    if (current()) {
      App.state.bookmarks = q.list.slice();
      renderBookmarks();
      toast(i >= 0 ? '已删除第 ' + page + ' 页书签' : '已给第 ' + page + ' 页加书签');
    }
  } else if (current()) {
    App.state.bookmarks = q.list.slice();
    renderBookmarks();
    toast('书签保存失败：' + ((r && r.error) || '未知错误') + '（第 ' + page + ' 页未改动，可重试）', 5000);
  }
  return r;
}

async function bookmarkToggle(page) {
  const s = App.state;
  if (!hasDoc(s) || !s.filePath || !window.pdfBridge.bookmarksSave) {
    return { ok: false, error: '当前文档没有可保存的书签位置' };
  }
  const path = s.filePath;
  const gen = loadSeq;
  const n = Math.min(s.numPages, Math.max(1, page || s.currentPage));
  // 书签还在读盘：先等它，别拿空数组覆盖磁盘上已有的书签
  if (s.bookmarksReady) { try { await s.bookmarksReady; } catch (_) {} }
  if (gen !== loadSeq || App.state.filePath !== path) return { ok: false, error: '文档已切换' };
  const q = bookmarkQueueFor(path, gen, App.state.bookmarks);
  q.pending++;
  const op = q.chain.then(() => bookmarkCommit(q, path, gen, n));
  // 无论成功、失败还是取消，都要减计数并可能回收队列；失败也继续排队，不能断链
  const settled = op.then((r) => { q.pending--; bookmarkQueueSweep(path, q); return r; },
    (err) => { q.pending--; bookmarkQueueSweep(path, q); throw err; });
  q.chain = settled.then(() => {}, () => {});
  return settled;
}
App.bookmarkToggle = bookmarkToggle;

function renderBookmarks() {
  const host = $('sb-outline');
  if (!host) return;
  const old = document.getElementById('bm-block');
  if (old) old.remove();
  if (App.state.mode === 'rich') return;
  const s = App.state;
  const block = document.createElement('div');
  block.id = 'bm-block';
  const cur = (s.bookmarks || []).some((b) => b.page === s.currentPage);
  const head = document.createElement('div');
  head.className = 'bm-head';
  head.innerHTML = '<span class="lib-side-title" style="margin:0">我的书签' + ((s.bookmarks || []).length ? ' · ' + s.bookmarks.length : '') + '</span>'
    + '<button class="tbtn bm-toggle" title="给当前页加 / 删书签（B）">' + (cur ? '★' : '☆') + '</button>';
  head.querySelector('.bm-toggle').addEventListener('click', () => bookmarkToggle(s.currentPage));
  block.appendChild(head);
  for (const b of (s.bookmarks || [])) {
    const row = document.createElement('div');
    row.className = 'bm-row';
    row.innerHTML = '<span class="bm-page">P' + b.page + '</span><span class="bm-when">'
      + (b.at ? new Date(b.at).toLocaleDateString('zh-CN') : '') + '</span>';
    row.addEventListener('click', () => scrollToPage(b.page, false, true));
    const del = document.createElement('button');
    del.className = 'bm-del';
    del.textContent = '✕';
    del.title = '删除这个书签';
    del.addEventListener('click', (e) => { e.stopPropagation(); bookmarkToggle(b.page); });
    row.appendChild(del);
    block.appendChild(row);
  }
  if (!(s.bookmarks || []).length) {
    const hint = document.createElement('div');
    hint.className = 'sb-empty';
    hint.textContent = '按 B 给当前页加书签';
    block.appendChild(hint);
  }
  host.insertBefore(block, host.firstChild);
}

function refreshSidebar() {
  const sb = $('sidebar');
  if (!sb || sb.hidden) return;
  if (!App.state.pdfDoc && App.state.mode !== 'rich') return;
  const tab = activeTab();
  if (tab === 'outline') buildOutlinePane();
  else if (tab === 'thumbs') buildThumbsPane();
  else refreshAnnoPane();
}

// 目录：pdfDoc.getOutline() → 解析目标页 → 可点击树
async function buildOutlinePane() {
  const host = $('sb-outline');
  if (host._done) { renderBookmarks(); return; }
  host._done = true;
  const s = App.state;
  if (s.mode === 'rich') {
    host.innerHTML = '';
    if (!s.richPages || !s.richPages.length) {
      host.innerHTML = '<div class="sb-empty">此文档没有目录</div>';
      return;
    }
    s.richPages.forEach((p, i) => {
      const n = i + 1;
      const btn = document.createElement('button');
      btn.className = 'outline-node';
      const title = document.createElement('span');
      title.className = 'otitle';
      title.textContent = p.title || ('第 ' + n + ' 页');
      btn.appendChild(title);
      const pg = document.createElement('span');
      pg.className = 'opg';
      pg.textContent = 'P' + n;
      btn.appendChild(pg);
      btn.addEventListener('click', () => scrollToPage(n, false, true));
      host.appendChild(btn);
      // 页内标题也列出来，长文档找小节更快
      const pageEl = document.getElementById('page-' + n);
      const heads = pageEl ? pageEl.querySelectorAll('.doc-page-body h1, .doc-page-body h2, .doc-page-body h3') : [];
      for (const h of heads) {
        const sub = document.createElement('button');
        sub.className = 'outline-node outline-sub';
        const st = document.createElement('span');
        st.className = 'otitle';
        st.textContent = (h.textContent || '').trim().slice(0, 80);
        sub.appendChild(st);
        sub.addEventListener('click', () => {
          scrollToPage(n, true, true);
          h.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        host.appendChild(sub);
      }
    });
    return;
  }
  host.innerHTML = '<div class="sb-empty">载入目录…</div>';
  let outline = null;
  try { outline = await s.pdfDoc.getOutline(); } catch (_) {}
  if (!outline || !outline.length) {
    host.innerHTML = '<div class="sb-empty">此文档没有目录</div>';
    renderBookmarks();   // 没有目录也要有书签块
    return;
  }
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
      const title = document.createElement('span');
      title.className = 'otitle';
      title.textContent = node.title || '(无标题)';
      btn.appendChild(title);
      const pg = await destPage(node.dest);
      if (pg) {
        // 顺手标上页码，找章节时不用来回滚
        const p = document.createElement('span');
        p.className = 'opg';
        p.textContent = 'P' + pg;
        btn.appendChild(p);
        btn.addEventListener('click', () => scrollToPage(pg, false, true));
      }
      wrap.appendChild(btn);
      if (node.items && node.items.length) wrap.appendChild(await build(node.items, depth + 1));
    }
    return wrap;
  };
  host.innerHTML = '';
  host.appendChild(await build(outline, 0));
  renderBookmarks();   // 目录重建会把书签块冲掉，这里补回来（书签块插在目录上方）
}

// 缩略图：占位 + IntersectionObserver 懒渲染（1200 页文档也只画看得见的那几张）
let thumbIO = null;
function buildThumbsPane() {
  const host = $('sb-thumbs');
  if (App.state.mode === 'rich') {
    const key = 'rich:' + App.state.fileName + ':' + App.state.numPages;
    if (host._docId === key) { markCurrentThumb(); return; }
    host._docId = key;
    host.innerHTML = '';
    if (thumbIO) { thumbIO.disconnect(); thumbIO = null; }
    for (let n = 1; n <= App.state.numPages; n++) {
      const p = App.state.richPages[n - 1] || {};
      const d = document.createElement('div');
      d.className = 'thumb doc-thumb';
      d.dataset.page = String(n);
      d.innerHTML = '<div class="doc-thumb-card"><span class="tno">' + n + '</span>' +
        '<span class="doc-thumb-title">' + escHtml(p.title || ('第 ' + n + ' 页')) + '</span></div>';
      d.addEventListener('click', () => scrollToPage(n, false, true));
      host.appendChild(d);
    }
    markCurrentThumb();
    return;
  }
  if (host._docId === App.state.fileName + App.state.numPages + ':' + normRot(App.state.rotation)) { markCurrentThumb(); return; }
  host._docId = App.state.fileName + App.state.numPages + ':' + normRot(App.state.rotation);
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
    d.addEventListener('click', () => scrollToPage(n, false, true));
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
    // v34：缩略图跟着视图旋转走，旋转 90° 时按页面高度算宽度，保证缩略图宽度仍是 130
    const rot = normRot(App.state.rotation);
    const baseW = rot % 180 ? el._unit.h : el._unit.w;
    const vp = el._pdfPage.getViewport({ scale: 130 / baseW, rotation: (el._pdfPage.rotate + rot) % 360 });
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
  if (App.state.mode === 'rich') {
    host.innerHTML = '<div class="sb-empty">富文档暂不支持画标注。<br>选中文字可以直接复制，或摘录到阅读笔记。</div>';
    return;
  }
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
      '<button class="tbtn sb-export-note" data-note-fmt="txt" title="导出为纯文本">TXT</button>' +
      // v26：原来挂在「文件」菜单里，现在放在这儿 —— 汇总所有文档的批注
      '<button class="tbtn sb-export-note" data-note-fmt="all" title="把所有文档的批注汇总成一份 Markdown">全部</button>';
    // v29：把 PDF 文件里自带的批注（高亮 / 下划线 / 便签 / 手绘）读进当前标注层。
    // 只在 PDF 模式下出现；重复点不会产生副本（按原生 id 去重）。
    const nbar = document.createElement('div');
    nbar.className = 'anno-export-bar anno-native-bar';
    nbar.innerHTML = '<span class="anno-export-label">PDF 自带</span>' +
      '<button class="tbtn" id="anno-import-native" title="导入这份 PDF 里已有的标准批注（高亮 / 下划线 / 删除线 / 便签 / 文字 / 手绘 / 方框 / 直线）">导入 PDF 批注</button>' +
      '<span class="anno-native-state" id="anno-native-state"></span>';
    nbar.querySelector('#anno-import-native').addEventListener('click', async () => {
      const btn = nbar.querySelector('#anno-import-native');
      const state = nbar.querySelector('#anno-native-state');
      if (!App.state.pdfDoc) { toast('先打开一份 PDF'); return; }
      btn.disabled = true;
      state.textContent = '扫描中…';
      try {
        const r = window.NativeAnnos ? await window.NativeAnnos.import() : { ok: false };
        if (!r.ok) { state.textContent = ''; toast(r.error || '导入失败', 4000); return; }
        if (!r.total) { state.textContent = '没有自带批注'; toast('这份 PDF 没有可导入的标准批注', 3500); return; }
        state.textContent = r.added ? '已导入 ' + r.added + ' 条' : '已是全部导入';
        toast(r.added
          ? '已导入 ' + r.added + ' 条 PDF 原有批注' + (r.skipped ? '，跳过 ' + r.skipped + ' 条（已存在或不支持）' : '')
          : '没有新批注可导入（已存在 ' + r.skipped + ' 条）', 4500);
        refreshAnnoPane();
      } finally {
        btn.disabled = false;
      }
    });
    host.appendChild(search);
    host.appendChild(l);
    host.appendChild(nbar);
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
        const kindLabel = sh.kind === 'quote' ? '摘录：' : sh.kind === 'underline' ? '下划线：'
          : sh.kind === 'strike' ? '删除线：' : sh.kind === 'squiggly' ? '波浪线：' : '';
        label = kindLabel + (sh.text || '选区高亮').slice(0, 90);
        if (sh.comment) label += ' · 评论：' + sh.comment;
      } else if (sh.tool === 'text' || sh.tool === 'note') {
        label = (sh.replyTo ? '↳ 回复：' : '') + (sh.text || '(空)');
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
  // v26：汇总所有文档的批注（原来挂在「文件」菜单里）
  if (fmt === 'all') {
    const r = await window.pdfBridge.exportAllNotes();
    if (r && r.ok) { toast('已导出全部批注'); setStatus('全部批注已导出：' + r.path); }
    else if (r && r.canceled) setStatus('已取消导出');
    else { toast('导出失败'); setStatus('导出失败：' + (r && r.error ? r.error : '未知错误')); }
    return;
  }
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
// targetW：期望的像素宽度（多层合成时传各层原始像素宽，保证合成图不比原图糊）
async function renderImageRegion(pdfPage, rect, targetW) {
  try {
    const vp1 = pdfPage.getViewport({ scale: 1 });
    const pw = Math.max(1, vp1.width), ph = Math.max(1, vp1.height);
    let scale;
    if (targetW && targetW > 0) scale = Math.min(8, targetW / Math.max(1, rect.w));
    else scale = Math.min(5, Math.max(2, 1200 / Math.max(1, rect.w)));
    const cap = Math.sqrt(12e6 / (pw * ph));   // 整页渲染别超过 ~1200 万像素
    if (scale > cap) scale = cap;
    if (!(scale > 0)) scale = 1;
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

// v8：从标注生成笔记用的页面截图 —— 按标注包围盒裁一块页面图像，
// 选区高亮（mark）以半透明色块叠在截图上，和阅读器里看到的一致。
function annoShapeBBox(sh) {
  if (!sh) return null;
  if (sh.tool === 'mark' && Array.isArray(sh.rects) && sh.rects.length) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of sh.rects) {
      x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
      x1 = Math.max(x1, r.x + (r.w || 0)); y1 = Math.max(y1, r.y + (r.h || 0));
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  if (sh.a && sh.b) {
    return {
      x: Math.min(sh.a.x, sh.b.x), y: Math.min(sh.a.y, sh.b.y),
      w: Math.abs(sh.b.x - sh.a.x), h: Math.abs(sh.b.y - sh.a.y),
    };
  }
  if (Array.isArray(sh.pts) && sh.pts.length) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of sh.pts) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
    return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
  }
  if (sh.at) {
    const size = sh.size || 14;
    const lines = String(sh.text || '').split('\n');
    const w = Math.max(24, Math.max(...lines.map((l) => l.length)) * size * 0.62);
    return { x: sh.at.x, y: sh.at.y - size, w, h: Math.max(size * 1.4, lines.length * size * 1.25) };
  }
  return null;
}

App.renderAnnoSnapshot = async function (pageNum, shapes) {
  const el = App.pageEl(pageNum);
  const pdfPage = el && el._pdfPage;
  if (!pdfPage) return null;
  const list = Array.isArray(shapes) ? shapes.filter(Boolean) : [];
  const boxes = list.map(annoShapeBBox).filter(Boolean);
  if (!boxes.length) return null;
  const vp = pdfPage.getViewport({ scale: 1 });
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
  }
  const pad = 16;
  const rect = {
    x: Math.max(0, x0 - pad), y: Math.max(0, y0 - pad),
    w: Math.min(vp.width, x1 + pad) - Math.max(0, x0 - pad),
    h: Math.min(vp.height, y1 + pad) - Math.max(0, y0 - pad),
  };
  if (!(rect.w > 1) || !(rect.h > 1)) return null;
  const canvas = await renderImageRegion(pdfPage, rect);
  if (!canvas) return null;
  // 把选区高亮叠上去（坐标是 scale=1 的单位坐标）
  const scale = canvas.width / rect.w;
  const ctx = canvas.getContext('2d');
  for (const sh of list) {
    if (sh.tool !== 'mark' || !Array.isArray(sh.rects)) continue;
    ctx.save();
    ctx.globalAlpha = sh.kind === 'quote' ? 0.2 : 0.38;
    ctx.fillStyle = sh.color || '#ffd54f';
    for (const r of sh.rects) {
      ctx.fillRect((r.x - rect.x) * scale, (r.y - rect.y) * scale, Math.max(1, r.w * scale), Math.max(1, r.h * scale));
    }
    ctx.restore();
  }
  return canvas;
};

// 点在没有位图的地方时，取点击处周围一块当「局部放大」的区域
function regionAround(ux, uy, unit) {
  const u = unit || { w: 600, h: 800 };
  const rw = Math.min(u.w, u.w * 0.3);
  const rh = Math.min(u.h, u.h * 0.3);
  const x = Math.max(0, Math.min(Math.max(0, u.w - rw), ux - rw / 2));
  const y = Math.max(0, Math.min(Math.max(0, u.h - rh), uy - rh / 2));
  return { x, y, w: rw, h: rh };
}

let lbOpenSeq = 0;   // 灯箱打开请求代号：双击两连点、或等待期间切换模式时，旧请求直接作废

async function openImageLightbox(pageEl, clientX, clientY) {
  const seq = ++lbOpenSeq;
  const pageNum = +pageEl.dataset.page;
  const pdfPage = pageEl._pdfPage;
  if (!pdfPage) return;
  const u = clientToUnit(pageEl, clientX, clientY);
  const ux = u.x, uy = u.y;
  const images = await getPageImages(pageNum, pdfPage);
  // 抽图是异步的（要等 PDF.js 解码）：等待期间用户可能已经按 Esc 切回阅读模式，
  // 或双击的第二连点又发起了新请求。旧请求一律作废 ——「阅读模式绝不会莫名其妙弹灯箱」靠这条保证。
  if (seq !== lbOpenSeq || !document.body.classList.contains('tool-image')) return;
  const hit = images.length ? PdfImages.findAt(images, ux, uy) : null;

  // 看图模式只认内嵌位图：点中图片给原图，点空白不再「局部放大」——
  // 那是它跟阅读器放大功能重叠、两个模式边界糊掉的来源；任意区域的放大走右键菜单。
  if (!hit) { toast('这里没有内嵌图片；要放大任意区域，请右键 →「放大看这一块」'); return; }

  // 白板/笔记类导出常把一张图拆成「底色层 + 笔迹层」叠在一起（两层矩形几乎重合）。
  // 拆开看没有意义：底色层=一张白纸，笔迹层=透明底笔画。命中层与其他层重叠时，
  // 按页面渲染把整块合成（分辨率以各层原始像素为准，不糊），灯箱里就是完整的一张图。
  const overlapping = images.filter((r) => r !== hit
    && Math.min(r.x + r.w, hit.x + hit.w) - Math.max(r.x, hit.x) > 1
    && Math.min(r.y + r.h, hit.y + hit.h) - Math.max(r.y, hit.y) > 1);
  if (overlapping.length) {
    const xs = [hit.x, hit.y, hit.x + hit.w, hit.y + hit.h];
    for (const r of overlapping) xs.push(r.x, r.y, r.x + r.w, r.y + r.h);
    const union = {
      x: Math.min.apply(null, xs.filter((_, i) => i % 2 === 0)),
      y: Math.min.apply(null, xs.filter((_, i) => i % 2 === 1)),
    };
    union.w = Math.max.apply(null, xs.filter((_, i) => i % 2 === 0)) - union.x;
    union.h = Math.max.apply(null, xs.filter((_, i) => i % 2 === 1)) - union.y;
    const layers = [hit, ...overlapping];
    const targetW = Math.max(Math.round(union.w),
      Math.max.apply(null, layers.map((r) => r.natW || 0)));
    const c = await renderImageRegion(pdfPage, union, targetW);
    if (seq !== lbOpenSeq || !document.body.classList.contains('tool-image')) return;
    if (!c) { toast('这一块的图片取不出来'); return; }
    Lightbox.open({
      items: [{ canvas: c, label: '第 ' + pageNum + ' 页 · 图（' + layers.length + ' 层已合成）' }],
      index: 0,
      saveCtx: { path: App.state.filePath, page: pageNum, rect: union, text: '图片标注 · 第 ' + pageNum + ' 页' },
    });
    return;
  }

  const list = images.slice(0, 12);
  const built = [];
  for (let i = 0; i < list.length; i++) {
    const c = await PdfImages.extract(pdfPage, list[i]) || await renderImageRegion(pdfPage, list[i]);
    if (seq !== lbOpenSeq) return;   // 更新的请求已经接管，这轮结果全部丢弃
    if (!c) continue;
    built.push({
      canvas: c,
      srcIndex: i,
      rect: list[i],
      label: '第 ' + pageNum + ' 页 · 图 ' + (i + 1) + (list.length > 1 ? ' / ' + list.length : ''),
    });
  }
  if (!built.length) { toast('这一块的图片取不出来'); return; }
  if (seq !== lbOpenSeq || !document.body.classList.contains('tool-image')) return;
  const want = list.indexOf(hit);
  const start = Math.max(0, built.findIndex((b) => b.srcIndex === want));
  const item = built[start] || {};
  Lightbox.open({
    items: built,
    index: start,
    // 图片的位置用当前这张的矩形（翻到别张时上下文不跟着变——存的是打开时那张）
    saveCtx: {
      path: App.state.filePath, page: pageNum, rect: item.rect || hit,
      text: '图片标注 · 第 ' + pageNum + ' 页',
    },
  });
}

// 右键菜单「放大看这一块」：把点击处周围一块按高分辨率重渲染后放进灯箱。
// 任何模式下都可用，不再借道看图模式 —— 左键点图 = 看原图，右键 = 放大区域，两件事彻底分开。
async function openRegionLightbox(pageEl, clientX, clientY) {
  const seq = ++lbOpenSeq;
  const pageNum = +pageEl.dataset.page;
  const pdfPage = pageEl._pdfPage;
  if (!pdfPage) return;
  const u = clientToUnit(pageEl, clientX, clientY);
  const ux = u.x, uy = u.y;
  const region = regionAround(ux, uy, pageEl._unit);
  const c = await renderImageRegion(pdfPage, region);
  if (!c || seq !== lbOpenSeq) { if (!c) toast('这一块取不出来'); return; }
  Lightbox.open({
    items: [{ canvas: c, label: '第 ' + pageNum + ' 页 · 局部放大' }],
    index: 0,
    saveCtx: { path: App.state.filePath, page: pageNum, rect: region, text: '图片标注（局部放大）· 第 ' + pageNum + ' 页' },
  });
}
App.openRegionLightbox = openRegionLightbox;

// v9：图片标注落盘 —— 灯箱里的图片 + 它在 PDF 里的位置，存进库（可搜索 / 打标签 / 生成笔记）
App.saveImageAnno = async function (canvas, ctx) {
  if (!canvas || !ctx || !ctx.path) { toast('当前没有打开文档，存不了图片标注'); return; }
  let dataUrl = '';
  try { dataUrl = canvas.toDataURL('image/png'); } catch (_) { toast('截图失败'); return; }
  const r = await window.pdfBridge.saveImageAnno({
    path: ctx.path, page: ctx.page, dataUrl, rect: ctx.rect, text: ctx.text,
  });
  if (r && r.ok) {
    toast('已存为图片标注，可在文献库「标注」里找到');
    if (window.LibraryUI && window.LibraryUI.isOpen && window.LibraryUI.isOpen()) window.LibraryUI.loadAnnos && window.LibraryUI.loadAnnos(true);
  } else {
    toast('保存失败：' + ((r && r.error) || '未知错误'));
  }
};
App.scrollToPage = scrollToPage;   // 探针/外部跳页用

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
// 当前页 PNG 数据（视图导出）：按当前旋转角输出；PDF 副本与打印仍按原方向
App.pagePngDataUrl = function () {
  const el = App.pageEl(App.state.currentPage);
  const canvas = el && el.querySelector('canvas');
  if (!canvas || !canvas.width) return '';
  const rot = normRot(App.state.rotation);
  let src = canvas;
  if (rot) {
    const c2 = document.createElement('canvas');
    const w = canvas.width, h = canvas.height;
    if (rot % 180) { c2.width = h; c2.height = w; } else { c2.width = w; c2.height = h; }
    const ctx = c2.getContext('2d');
    ctx.translate(c2.width / 2, c2.height / 2);
    ctx.rotate(rot * Math.PI / 180);
    ctx.drawImage(canvas, -w / 2, -h / 2);
    src = c2;
  }
  return src.toDataURL('image/png');
};

async function exportCurrentPagePng() {
  if (App.state.mode === 'rich') { toast('富文档暂不支持导出页面图片'); return; }
  let dataUrl = '';
  try { dataUrl = App.pagePngDataUrl(); } catch (e) { toast('导出失败：' + (e && e.message || e)); return; }
  if (!dataUrl) { toast('当前页还没渲染出来'); return; }
  const name = (App.state.fileName || 'page').replace(/\.pdf$/i, '') + '-p' + App.state.currentPage + '.png';
  const res = await window.pdfBridge.exportPagePng({ dataUrl, fileName: name });
  if (res && res.ok) { toast('已导出：' + res.path); setStatus('已导出当前页图片：' + res.path); }
  else if (res && res.canceled) setStatus('已取消导出');
  else setStatus('导出失败：' + ((res && res.error) || '未知错误'));
}

// 复制当前页文字
async function copyPageText() {
  const n = App.state.currentPage;
  if (App.state.mode === 'rich') {
    const el = App.pageEl(n);
    const body = el && el.querySelector('.doc-page-body');
    const text = body ? String(body.textContent || '').replace(/\s+/g, ' ').trim() : '';
    if (!text) { toast('这一页没有可选文字'); return; }
    await copyWithSource(text, n);
    return;
  }
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

// 复制/摘录时统一附出处：优先用文献库元数据，没有就退回文件名 + 页码
function sourceLine(page) {
  const s = App.state;
  const it = s.item;
  const title = (it && it.title) || s.fileName || '文档';
  const authors = it && window.Creators ? window.Creators.displayList(it.creators) : '';
  const year = it && it.year ? '，' + it.year : '';
  const pg = page ? '，第 ' + page + ' 页' : '';
  return '——' + (authors ? authors + '：' : '') + '《' + title + '》' + year + pg;
}

function quoteText(text, page) {
  return '「' + String(text || '').trim() + '」\n' + sourceLine(page);
}

async function copyWithSource(text, page) {
  const body = quoteText(text, page);
  try {
    const r = await window.pdfBridge.copyText(body);
    if (r && r.ok) toast('已复制，并附上出处');
    else toast('复制失败');
  } catch (_) { toast('复制失败'); }
}
App.sourceLine = sourceLine;
App.quoteText = quoteText;
App.copyWithSource = copyWithSource;

// 富文档「摘录」：没有 PDF 标注层，写进文献库的阅读笔记；没挂条目就只复制。
App.quoteSelection = async function (text, page) {
  const s = App.state;
  const t = String(text || '').trim();
  if (!t) return;
  if (s.itemKey && window.pdfBridge.lib && window.pdfBridge.lib.addNote) {
    try {
      await window.pdfBridge.lib.addNote(s.itemKey, {
        title: '摘录 · 第 ' + (page || s.currentPage) + ' 页',
        text: t + '\n\n' + sourceLine(page),
      });
      toast('已摘录到阅读笔记');
    } catch (_) { toast('摘录保存失败'); }
  } else {
    await copyWithSource(t, page);
  }
};

// ---------- 标注自动保存 / 恢复（按文件路径存 userData/annotations/） ----------
async function saveAnnosNow() {
  const s = App.state;
  if (!s.filePath || !window.pdfBridge.saveAnnos) return;
  const pages = [];
  for (const [n, shapes] of s.annos) {
    if (!shapes || !shapes.length) continue;
    // v8：稳定 id 兜底（库里按 id 存标签 / 所属条目，缺 id 会串位）
    for (const sh of shapes) if (!sh.id && window.Anno) sh.id = window.Anno.newAnnoId();
    pages.push({ page: n, shapes: JSON.parse(JSON.stringify(shapes)) });
  }
  try {
    const result = await window.pdfBridge.saveAnnos(s.filePath, pages);
    if (result !== true) throw new Error(result && result.error || '写入失败');
    return true;
  } catch (err) {
    setStatus('标注保存失败：' + err.message);
    toast('标注尚未保存，请检查磁盘或目录权限后重试', 5000);
    return false;
  }
}
App.flushAnnos = saveAnnosNow;
// v29：探针入口 —— 导入 PDF 自带批注（与界面按钮同一条路径）
App.importNativeAnnos = function (opts) {
  return window.NativeAnnos ? window.NativeAnnos.import(opts) : Promise.resolve({ ok: false, error: 'NativeAnnos 未加载' });
};
App.closeDocument = closeDocument;   // v9：探针/外部关闭文档（顺带停朗读）
App.notifyAnnoChanged = function () {
  refreshAnnoPane();
  clearTimeout(App._annoSaveTimer);
  App._annoSaveTimer = setTimeout(saveAnnosNow, 600);
};

async function restoreAnnos(filePath) {
  // 读盘期间可能已经切到别的文档（甚至切走又切回来）：路径 + 加载代际都要对得上才写入
  const gen = loadSeq;
  const stillCurrent = () => gen === loadSeq && filePath === App.state.filePath;
  // 书签与标注同一个 sidecar：无论有没有标注都要读一份。
  // bookmarksReady 让「刚打开就按 B」的操作等这次读盘完成，避免用空数组覆盖磁盘上的书签。
  if (filePath && window.pdfBridge.bookmarksLoad) {
    App.state.bookmarksReady = (async () => {
      try {
        const bm = await window.pdfBridge.bookmarksLoad(filePath);
        if (stillCurrent()) { App.state.bookmarks = (bm && bm.bookmarks) || []; renderBookmarks(); }
      } catch (_) {}
    })();
    await App.state.bookmarksReady;
  }
  if (!filePath || !window.pdfBridge.loadAnnos) return;
  let saved = null;
  try { saved = await window.pdfBridge.loadAnnos(filePath); } catch (_) {}
  if (!saved || !saved.length) return;
  if (!stillCurrent()) return;
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
// 「有效阅读模式」：spread 是 PDF 的阅读偏好；富文档（Word/PPT/EPUB 转 HTML）没有对开，
// 一律按单页执行。显示、可见性、观察器、导航都读这里，避免工具栏/保存页码/朗读
// 与实际展示位置不一致。用户偏好本身仍留在 App.state.viewMode，切回 PDF 自动恢复。
function effectiveViewMode() {
  const m = App.state.viewMode;
  if (App.state.mode === 'rich') return m === 'scroll' ? 'scroll' : 'page';
  return m;
}
App.effectiveViewMode = effectiveViewMode;

// 单页 / 双页对开模式：只显示当前页（对开时加它的搭档页），其余 display:none（.is-current 标记）
function applyPageVisibility(cur) {
  const mode = effectiveViewMode();
  const show = new Set();
  if (mode === 'page') show.add(cur);
  if (mode === 'spread') for (const n of spreadPair(cur)) if (n) show.add(n);
  for (let n = 1; n <= App.state.numPages; n++) {
    const el = App.pageEl(n);
    if (!el) continue;
    el.classList.toggle('is-current', show.has(n));
  }
}

// 双页对开的搭档规则（书刊习惯：偶数页在左、奇数页在右，第 1 页封面单独占右位）
// 返回 [leftPage, rightPage]，rightPage 可能为 null（落单）。
function spreadPair(cur) {
  const total = App.state.numPages || 1;
  cur = Math.min(total, Math.max(1, cur));
  if (cur === 1) return [null, 1];
  if (cur % 2 === 0) return [cur, cur + 1 <= total ? cur + 1 : null];
  return [cur - 1, cur];
}
App.spreadPair = spreadPair;

// 阅读方式的三种 body class（连续 / 单页 / 对开），加载与切换共用。
// 富文档没有对开布局，按有效模式落到 view-page。
function applyViewModeClass() {
  const m = effectiveViewMode();
  document.body.classList.toggle('view-page', m === 'page');
  document.body.classList.toggle('view-spread', m === 'spread');
}

// 切换阅读方式：连续滚动 / 单页翻页 / 双页对开
App.setViewMode = function (mode) {
  const m = mode === 'page' ? 'page' : (mode === 'spread' ? 'spread' : 'scroll');
  App.state.viewMode = m;
  applyViewModeClass();
  applyPageVisibility(App.state.currentPage);
  const eff = effectiveViewMode();
  if (eff !== 'scroll') {
    // 单页 / 对开：把要显示的页渲染出来，其余页先不渲染（省内存）
    if (App.state.mode === 'pdf') {
      const targets = eff === 'spread' ? spreadPair(App.state.currentPage).filter(Boolean) : [App.state.currentPage];
      for (const n of targets) if (!App.state.rendered.get(n)) renderPageNum(n);
      // 从连续模式切进来时，之前散落的已渲染页要一并回收
      freePagesExcept(targets);
    }
  } else if (App.state.mode === 'pdf') {
    renderVisiblePages();
  }
  relayoutKeepingPosition();
  try { window.pdfBridge.setSettings && window.pdfBridge.setSettings({ viewMode: m }); } catch (_) {}
  return m;
};

// 单页 / 对开模式的内存回收：只保留「当前页组」的位图，其余页一律释放。
// 早先只释放上一张「当前页」，对开时搭档页（例如 2→4 时的 3）会一直留着位图；
// 现在把「已渲染」和「正在渲染」都算进回收范围：快速跳页时上一组的任务还没结束，
// 只清 rendered 会漏掉它们，任务完成后再把离屏页标成已渲染（R02）。
function freePagesExcept(keep) {
  if (App.state.mode !== 'pdf') return 0;
  const keepSet = keep instanceof Set ? keep : new Set(keep || []);
  const targets = new Set();
  for (const [n, done] of App.state.rendered) if (done) targets.add(n);
  for (const n of activeRenders) targets.add(n);
  let freed = 0;
  for (const n of targets) {
    if (keepSet.has(n)) continue;
    freePage(n);
    freed++;
  }
  return freed;
}

function scrollToPage(n, instant, record) {
  n = Math.min(App.state.numPages, Math.max(1, n));
  const el = App.pageEl(n);
  if (!el) return;
  // v33：显式跳转（目录 / 搜索结果 / 批注 / 页码输入 / 缩略图）记入导航历史，
  // Alt+←/→ 或鼠标侧键可返回。初始落页与逐页翻阅不记——后者记了会让「后退」变成一页一页倒。
  if (record && n !== App.state.currentPage) navRecord(n);
  if (App.state.mode === 'rich') {
    // 富文档没有对开：spread 偏好按单页执行（与 applyViewModeClass 的有效模式一致）
    if (effectiveViewMode() !== 'scroll') {
      applyPageVisibility(n);
      updateCurrentPage(n);
      App.els.viewer.scrollTop = 0;
      return;
    }
    el.scrollIntoView({ behavior: instant ? 'auto' : 'smooth', block: 'start' });
    updateCurrentPage(n);
    return;
  }
  if (App.state.viewMode === 'page' || App.state.viewMode === 'spread') {
    // 单页 / 对开模式：换页就是把「当前页」标记挪过去；不属于新页组的位图一律释放
    applyPageVisibility(n);
    const targets = App.state.viewMode === 'spread' ? spreadPair(n).filter(Boolean) : [n];
    for (const t of targets) if (!App.state.rendered.get(t)) renderPageNum(t);
    freePagesExcept(targets);
    updateCurrentPage(n);
    App.els.viewer.scrollTop = 0;
    return;
  }
  el.scrollIntoView({ behavior: instant ? 'auto' : 'smooth', block: 'start' });
  if (!App.state.rendered.get(n)) renderPageNum(n);
  updateCurrentPage(n);
}
const nextPage = () => scrollToPage(App.state.currentPage + 1);
const prevPage = () => scrollToPage(App.state.currentPage - 1);

// ---------- 阅读导航历史（v33：返回上一个阅读位置） ----------
// 历史挂在标签页对象上（t.nav），切标签不丢；只记录显式跳转，纯滚动产生的
// 「位置漂移」在后退那一刻补记，前进时能回到漂移后的位置。栈上限 60，超出丢最老的。
function navRecord(dest) {
  const t = currentTab();
  if (!t) return;
  if (!t.nav) t.nav = { stack: [], idx: -1 };
  const nav = t.nav;
  const cur = App.state.currentPage || 1;
  nav.stack = nav.stack.slice(0, nav.idx + 1);
  if (nav.stack[nav.idx] !== cur) { nav.stack.push(cur); nav.idx++; }
  if (nav.stack[nav.idx] !== dest) { nav.stack.push(dest); nav.idx++; }
  while (nav.stack.length > 60) { nav.stack.shift(); nav.idx--; }
}
function navBack() {
  const t = currentTab();
  const nav = t && t.nav;
  if (!nav || nav.idx <= 0) { toast('没有更早的阅读位置'); return; }
  const cur = App.state.currentPage || 1;
  if (nav.stack[nav.idx] !== cur) {   // 滚动离开过栈顶：补记当前位置，前进时能回来
    nav.stack = nav.stack.slice(0, nav.idx + 1);
    nav.stack.push(cur); nav.idx++;
  }
  nav.idx--;
  scrollToPage(nav.stack[nav.idx], true, false);
  setStatus('阅读位置：后退到第 ' + nav.stack[nav.idx] + ' 页（Alt+→ 前进）');
}
function navForward() {
  const t = currentTab();
  const nav = t && t.nav;
  if (!nav || nav.idx >= nav.stack.length - 1) { toast('没有更靠后的阅读位置'); return; }
  nav.idx++;
  scrollToPage(nav.stack[nav.idx], true, false);
  setStatus('阅读位置：前进到第 ' + nav.stack[nav.idx] + ' 页');
}
App.navBack = navBack;
App.navForward = navForward;
App.navState = () => {
  const t = currentTab();
  return t && t.nav ? { stack: t.nav.stack.slice(), idx: t.nav.idx } : null;
};

// ---------- 视图旋转（v34） ----------
// 只改显示：原文件、导出副本、打印都不动。标注按未旋转坐标存，所以旋转不需要迁移数据。
App.rotateView = function (delta) {
  const s = App.state;
  if (!hasDoc(s)) { toast('先打开一个文档'); return 0; }
  if (s.mode !== 'pdf') { toast('旋转只支持 PDF 文档'); return 0; }
  const next = normRot((s.rotation || 0) + (delta || 0));
  if (next === normRot(s.rotation)) return s.rotation;
  s.rotation = next;
  const t = currentTab();
  if (t) t.rotation = next;
  // 页面外框宽高变了：重新算缩放并保持当前页顶边不跳
  relayoutKeepingPosition();
  // 缩略图是位图，宽高比跟着变，必须重画
  const th = $('sb-thumbs');
  if (th && th.offsetParent !== null) { th._docId = null; buildThumbsPane(); }
  if (s.split) refRender();
  scheduleSessionSave();
  setStatus('页面已旋转 ' + next + '°（只改显示，不改原文件）');
  return next;
};
App.viewRotation = () => normRot(App.state.rotation || 0);

// ---------- 只读分屏参考视图（v34） ----------
// 定位照 Zotero 的第二视图：纯位图、不带标注，用来看参考文献 / 尾注 / 对照页。
// 不复用主视图的页块，避免两套标注层、两套文本层互相抢事件与内存。
const ref = { seq: 0, page: 1, follow: false, task: null };
let refFollowTimer = null;

function refSetPage(n, opts) {
  const s = App.state;
  if (!hasDoc(s) || s.mode !== 'pdf') return;
  ref.page = Math.min(s.numPages, Math.max(1, Math.floor(+n || 1)));
  s.refPage = ref.page;
  const t = currentTab();
  if (t) t.refPage = ref.page;
  const inp = $('ref-page');
  if (inp) { inp.value = String(ref.page); inp.max = String(s.numPages || 1); }
  if (!opts || opts.render !== false) refRender();
  scheduleSessionSave();
}
App.refSetPage = refSetPage;

async function refRender() {
  const s = App.state;
  const pane = $('ref-pane'), cv = $('ref-canvas'), body = $('ref-body'), empty = $('ref-empty');
  if (!pane || !cv || !body) return;
  if (!hasDoc(s) || s.mode !== 'pdf' || pane.hidden) {
    cv.hidden = true;
    if (empty) empty.hidden = false;
    return;
  }
  const seq = ++ref.seq;
  const pageNo = Math.min(s.numPages, Math.max(1, ref.page));
  let page;
  try { page = await s.pdfDoc.getPage(pageNo); } catch (_) { return; }
  if (seq !== ref.seq) return;
  const rot = (page.rotate + normRot(s.rotation)) % 360;   // 参考视图把旋转直接烘进 viewport
  const base = page.getViewport({ scale: 1, rotation: rot });
  const avail = Math.max(160, body.clientWidth - 28);
  const scale = avail / base.width;
  const vp = page.getViewport({ scale, rotation: rot });
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.max(1, Math.floor(vp.width * dpr));
  cv.height = Math.max(1, Math.floor(vp.height * dpr));
  cv.style.width = Math.floor(vp.width) + 'px';
  cv.style.height = Math.floor(vp.height) + 'px';
  try {
    // 连续翻参考页时上一张可能还在画：同一个 canvas 不能并行渲染，先取消
    if (ref.task) { try { ref.task.cancel(); } catch (_) {} ref.task = null; }
    ref.task = page.render({
      canvasContext: cv.getContext('2d'), viewport: vp,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
    });
    await ref.task.promise;
  } catch (_) { return; }
  if (seq !== ref.seq) return;
  ref.task = null;
  cv.hidden = false;
  if (empty) empty.hidden = true;
  const cnt = $('ref-count');
  if (cnt) cnt.textContent = '/ ' + s.numPages;
  const inp = $('ref-page');
  if (inp) inp.value = String(pageNo);
}

function syncSplitPane(opts) {
  const o = opts || {};
  const s = App.state;
  const pane = $('ref-pane');
  if (!pane) return;
  const want = !!s.split && s.mode === 'pdf' && hasDoc(s);
  pane.hidden = !want;
  document.body.classList.toggle('split-view', want);
  const btn = $('btn-split');
  if (btn) {
    btn.classList.toggle('active', !!s.split);
    btn.setAttribute('aria-pressed', s.split ? 'true' : 'false');
  }
  if (want) {
    ref.page = Math.min(s.numPages, Math.max(1, Math.floor(s.refPage || s.currentPage || 1)));
    s.refPage = ref.page;
    const inp = $('ref-page');
    if (inp) { inp.value = String(ref.page); inp.max = String(s.numPages || 1); }
    refRender();   // 读 clientWidth 会强制同步布局，隐藏窗口里也不依赖 rAF
  } else {
    ref.seq++;   // 作废正在跑的参考页渲染
    if (ref.task) { try { ref.task.cancel(); } catch (_) {} ref.task = null; }
  }
  // 参考视图占用宽度后「适应宽度」要重算
  if (o.relayout !== false && hasDoc(s)) relayoutKeepingPosition();
}
App.syncSplitPane = syncSplitPane;

App.setSplitView = function (on, opts) {
  const s = App.state;
  const o = opts || {};
  const want = !!on;
  // 没有文档时也允许先记下偏好：打开 PDF 会自动显示
  if (want && hasDoc(s) && s.mode !== 'pdf') { toast('分屏参考视图只支持 PDF'); return false; }
  s.split = want;
  syncSplitPane();
  if (want && !hasDoc(s)) toast('已开启分屏，打开 PDF 后显示参考视图');
  // 设置面板自己会落盘，别再重复写一次（persist:false）
  if (o.persist !== false) {
    try { window.pdfBridge.setSettings && window.pdfBridge.setSettings({ splitView: want }); } catch (_) {}
  }
  return want;
};
App.splitState = () => ({ on: !!App.state.split, page: ref.page, follow: ref.follow, visible: !!($('ref-pane') && !$('ref-pane').hidden) });

// 跟随：正文换页时参考页自动落到下一页（双页对照）。滚动时页码变化很密，去抖后再渲染。
function scheduleRefFollow() {
  if (!App.state.split || !ref.follow) return;
  clearTimeout(refFollowTimer);
  refFollowTimer = setTimeout(() => {
    if (!App.state.split || !ref.follow) return;
    refSetPage(Math.min(App.state.numPages, (App.state.currentPage || 1) + 1));
  }, 180);
}

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
    // 只写百分比：写「自定义 269%」会把下拉框撑宽，工具栏被挤到第二行，
    // 阅读区整体下移 —— 连续缩放时锚点就会纵向漂移。
    opt.textContent = Math.round(scale * 100) + '%';
  }
  sel.value = opt.value;
}

// ---------- 放大模式（Z 键切换） ----------
/*
 * 按 Z 进入放大模式：此时滚轮 = 连续缩放，锚点始终是鼠标指向的那一点；
 * 再按 Z 或 Esc 退出，滚轮恢复翻页。
 *
 * 为什么用「模式」而不是给滚轮加修饰键：Ctrl+滚轮虽然也能缩放，但那只改缩放、
 * 不会把光标下那一点锁住，看小字/图表时要反复调。进模式后滚轮专职缩放，
 * 想看别处就空格 + 左键拖动（Acrobat 的手形工具），职责清楚、肌肉记忆也好建立。
 *
 * 锚点模型：改缩放前记下「光标下那一点在哪一页、页内什么位置」（单位坐标），
 * applyLayout() 之后把这一点挪回光标处 —— 于是连续缩放时视线中心始终不跑。
 * 走真实重渲染而不是 CSS 拉伸：把已渲染位图拉大会发虚，而放大就是为了看清细节。
 */
const zoomMode = { on: false, space: false, panning: false, px: 0, py: 0 };

// 以 (clientX, clientY) 为锚点把缩放改到 next
function zoomAtPoint(next, clientX, clientY) {
  const s = App.state;
  const want = Math.min(6, Math.max(0.2, next));
  if (Math.abs(want - (s.scale || 1)) < 0.0005) return;
  const host = document.elementFromPoint(clientX, clientY);
  const pageEl = (host && host.closest) ? host.closest('.page, .doc-page') : null;
  if (!pageEl || !pageEl.dataset || !pageEl.dataset.page) { setNumericScale(want); return; }
  // v34：PDF 用页面标注层的逆 CTM 取锚点，旋转 90°/180° 后放大也不会偏；
  // 富文档没有旋转，仍走原来的矩形 + zoom 换算（CSS zoom 不在 CTM 里，别混用）
  const rich = s.mode === 'rich';
  const s0 = s.scale || 1;
  const r0 = pageEl.getBoundingClientRect();
  const u = rich ? { x: (clientX - r0.left) / s0, y: (clientY - r0.top) / s0 } : clientToUnit(pageEl, clientX, clientY);
  const ux = u.x, uy = u.y;

  s.scaleMode = String(want);
  applyLayout();

  const v = App.els.viewer;
  if (v && rich) {
    const r1 = pageEl.getBoundingClientRect();
    const s1 = s.scale || 1;
    v.scrollLeft += (r1.left + ux * s1) - clientX;
    v.scrollTop += (r1.top + uy * s1) - clientY;
  } else if (v) {
    const svg = pageEl.querySelector('.anno') || pageEl.querySelector('.anno-base');
    const ctm = svg && svg.getScreenCTM ? svg.getScreenCTM() : null;
    if (ctm) {
      const p = new DOMPoint(ux, uy).matrixTransform(ctm);
      v.scrollLeft += p.x - clientX;
      v.scrollTop += p.y - clientY;
    }
  }
  syncScaleSelect(s.scale);
}

function setZoomMode(on) {
  zoomMode.on = !!on;
  zoomMode.space = false;
  zoomMode.panning = false;
  document.body.classList.toggle('zoom-mode', zoomMode.on);
  document.body.classList.remove('zoom-pan');
  if (zoomMode.on && window.App && App.toast) {
    App.toast('放大模式：滚轮缩放 · 空格+左键拖动平移 · Z 或 Esc 退出', 4000);
  }
}
App.zoomModeState = () => ({ on: zoomMode.on, space: zoomMode.space, panning: zoomMode.panning });


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
      else if (sh.tool === 'text' || sh.tool === 'note') { g.at = conv(sh.at); g.size = sh.size; g.text = (sh.tool === 'note' ? '[note] ' : '') + sh.text; }
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
        if (sh.kind) g.kind = sh.kind;   // v29：下划线 / 删除线 / 波浪线 / 摘录要传出图方式
      }
      else { g.a = conv(sh.a); g.b = conv(sh.b); }
      return g;
    });
    pages.push({ index: n - 1, shapes: out });
  }
  return { fileName: s.fileName, data: s.sourceBytes, pages, outPath };
};

async function doSave() {
  if (App.state.mode === 'rich') { toast('当前格式不支持导出标注副本'); return; }
  const payload = App.buildExportPayload();
  if (!payload.pages.length) { toast('还没有任何标注'); return; }
  setStatus('导出中…');
  const res = await window.pdfBridge.exportPdf(payload);
  if (res && res.ok) {
    const partial = res.skipped > 0 ? '；有 ' + res.skipped + ' 条标注未导出（可能包含不支持的文字）' : '';
    setStatus('已导出副本：' + res.path + partial);
    toast(partial ? '副本已保存，但有 ' + res.skipped + ' 条标注未导出，请核对' : '已保存副本', partial ? 6000 : 1800);
  }
  else if (res && res.canceled) setStatus('已取消导出');
  else setStatus('导出失败：' + (res && res.error ? res.error : '未知错误'));
}

// ---------- toast ----------
let toastTimer = null;
function toast(msg, ms) {
  let t = $('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), Math.max(1200, +ms || 1800));
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

// ---------- 朗读（v35：跨页连续 + 句级高亮 + 位置记忆） ----------
// 一次只把一句话交给系统语音：句与句之间才有「读到哪」的锚点，
// 暂停 / 继续不会丢页，跨页也能接着读。整页塞进一个 utterance 做不到句级高亮。
const speech = {
  status: 'idle',      // idle | speaking | paused
  page: 0,
  index: 0,
  list: [],
  token: 0,
  hlPage: 0,
  lastPage: 0,
  lastIndex: 0,
  active: false,       // 当前是否真有一条 utterance 在念（跨页加载的间隙为 false）
  docKey: '',          // 上次保存位置对应的文档 key，防止把上一本的页码写到新文档
  driver: null,
};

const defaultSpeechDriver = {
  speak(u) { window.speechSynthesis.speak(u); },
  cancel() { try { window.speechSynthesis.cancel(); } catch (_) {} },
  pause() { try { window.speechSynthesis.pause(); } catch (_) {} },
  resume() { try { window.speechSynthesis.resume(); } catch (_) {} },
};
function speechDriver() { return speech.driver || defaultSpeechDriver; }
// 测试钩子：换成可控驱动后，断言句序 / 跨页 / 暂停恢复，不依赖机器上有没有语音引擎
App._setSpeechDriver = (d) => { speech.driver = d || null; };

function syncSpeakUi() {
  const E = App.els || {};
  if (E.speak) {
    E.speak.classList.toggle('active', speech.status !== 'idle');
    E.speak.title = speech.status === 'speaking' ? '暂停朗读（跨页连续）'
      : speech.status === 'paused' ? '继续朗读' : '朗读：从当前位置连续朗读（句级高亮）';
    E.speak.setAttribute('aria-pressed', speech.status !== 'idle' ? 'true' : 'false');
  }
  if (E.speakStop) E.speakStop.disabled = speech.status === 'idle';
}

// 富文档（Word / PPT / Excel / Markdown）没有 pdfPage，直接读渲染出来的 DOM 文本
function richTextForSpeech(pageNum) {
  const host = document.querySelector('#doc-view');
  if (!host) return '';
  const pages = Array.from(host.querySelectorAll('.doc-page'));
  const node = pages.find((p) => +p.dataset.page === pageNum) || pages[0] || host;
  // 只读正文，别把页眉页脚（「3 / 12」）也念出来
  const body = node.querySelector ? node.querySelector('.doc-page-body') : null;
  return String((body || node).innerText || '').replace(/\s+/g, ' ').trim();
}

const SENT_END = '。！？!?；;';
const SENT_CLOSERS = '”’"\')）】」』';
// 断句：CJK 标点直接断；英文句点后面必须是空白或结尾，且前一个字符不是数字（避开 1.5 / e.g.）。
// 过短的片段并进上一句，过长的按逗号 / 空格切成 <=180 字的块，避免一次念太久。
function splitPlainText(text) {
  const s = String(text || '');
  if (!s.trim()) return [];
  const raw = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    let cut = SENT_END.includes(ch);
    if (!cut && ch === '.') {
      const next = s[i + 1] || '';
      const prev = s[i - 1] || '';
      if ((!next || /\s/.test(next)) && !/\d/.test(prev)) cut = true;
    }
    if (!cut) continue;
    let end = i + 1;
    while (end < s.length && SENT_CLOSERS.includes(s[end])) end++;
    raw.push([start, end]);
    start = end;
    while (start < s.length && /\s/.test(s[start])) start++;
    i = start - 1;
  }
  if (start < s.length) raw.push([start, s.length]);

  const merged = [];
  for (const [a, b] of raw) {
    if (!s.slice(a, b).trim()) continue;
    const last = merged[merged.length - 1];
    if (b - a < 4 && last) last[1] = b;
    else merged.push([a, b]);
  }

  const out = [];
  for (const [a, b] of merged) {
    let cur = a;
    while (cur < b) {
      let cut = Math.min(b, cur + 180);
      if (cut < b) {
        const slice = s.slice(cur, cut);
        const at = Math.max(slice.lastIndexOf('，'), slice.lastIndexOf(','), slice.lastIndexOf(' '));
        if (at > 40) cut = cur + at + 1;
      }
      const piece = s.slice(cur, cut).trim();
      if (piece) out.push({ text: piece, start: cur, end: cut });
      cur = cut;
      while (cur < b && /\s/.test(s[cur])) cur++;
    }
  }
  return out;
}

// PDF 页：把文本项拼成一条字符串，同时记录每个字符属于哪个 item 的第几个字符，
// 这样断句后的范围还能精确回查到 textlayer 的 span。
function buildFlatText(items) {
  let flat = '';
  const map = [];
  for (let i = 0; i < items.length; i++) {
    const str = String((items[i] && items[i].str) || '');
    if (!str) continue;
    for (let c = 0; c < str.length; c++) { flat += str[c]; map.push({ i, c }); }
    if (!/\s$/.test(str)) { flat += ' '; map.push(null); }
  }
  return { flat, map };
}

async function pageSentences(n) {
  const s = App.state;
  if (s.mode === 'rich') {
    const text = richTextForSpeech(n).replace(/\s+/g, ' ').trim();
    return splitPlainText(text).map((x) => ({ text: x.text }));
  }
  const el = App.pageEl(n);
  if (!el || !el._pdfPage) return [];
  await buildTextLayer(n);          // 句级高亮要按 span 建 Range，文本层必须先就绪
  const items = await getTextContent(n);
  const { flat, map } = buildFlatText(items);
  const out = [];
  for (const p of splitPlainText(flat)) {
    let a = p.start, b = p.end;
    while (a < b && !map[a]) a++;
    while (b > a && !map[b - 1]) b--;
    if (a >= b) continue;
    const first = map[a], last = map[b - 1];
    out.push({ text: p.text, item0: first.i, off0: first.c, item1: last.i, off1: last.c + 1 });
  }
  return out;
}

async function safePageSentences(n) {
  try { return await pageSentences(n); } catch (_) { return []; }
}

function sentenceRects(n, item) {
  const el = App.pageEl(n);
  if (!el || item.item0 == null) return [];
  const sp0 = el.querySelector('.textlayer span[data-item="' + item.item0 + '"]');
  const sp1 = el.querySelector('.textlayer span[data-item="' + item.item1 + '"]');
  if (!sp0 || !sp1 || !sp0.firstChild || !sp1.firstChild) return [];
  try {
    const range = document.createRange();
    range.setStart(sp0.firstChild, Math.min(item.off0, sp0.firstChild.length));
    range.setEnd(sp1.firstChild, Math.min(item.off1, sp1.firstChild.length));
    if (window.SelectionUI && SelectionUI._rectsForPage) {
      return SelectionUI._rectsForPage(el, range);
    }
    const pr = el.getBoundingClientRect();
    const unit = el._unit || { w: pr.width || 1, h: pr.height || 1 };
    const scale = (pr.width / unit.w) || 1;
    return Array.from(range.getClientRects()).map((r) => ({
      x: (r.left - pr.left) / scale, y: (r.top - pr.top) / scale,
      w: r.width / scale, h: r.height / scale,
    }));
  } catch (_) { return []; }
}

function clearSpeechHl() {
  for (const el of document.querySelectorAll('#pages .speech-hl')) el.remove();
  speech.hlPage = 0;
}

function paintSpeech(n, rects) {
  const el = App.pageEl(n);
  const host = el && el.querySelector('.speech-layer');
  if (!host) return;
  if (speech.hlPage && speech.hlPage !== n) {
    const old = App.pageEl(speech.hlPage);
    if (old) for (const x of old.querySelectorAll('.speech-hl')) x.remove();
  }
  host.innerHTML = '';
  for (const r of rects) {
    const d = document.createElement('div');
    d.className = 'speech-hl';
    d.style.left = r.x + 'px'; d.style.top = r.y + 'px';
    d.style.width = r.w + 'px'; d.style.height = r.h + 'px';
    host.appendChild(d);
  }
  speech.hlPage = n;
}

function scrollToSpeech(n, rects) {
  const el = App.pageEl(n);
  if (!el || !rects.length) return;
  const r = el.getBoundingClientRect();
  const vr = App.els.viewer.getBoundingClientRect();
  const c = rects[0];
  const off = unitToSlotOffset(el, c.x + c.w / 2, c.y + c.h / 2);
  const y = r.top + off.y;
  if (y < vr.top + 24 || y > vr.bottom - 48) {
    App.els.viewer.scrollTop += y - vr.top - vr.height * 0.35;
    if (normRot(App.state.rotation) !== 0) {
      App.els.viewer.scrollLeft += (r.left + off.x) - vr.left - vr.width / 2;
    }
  }
}

function highlightSentence(n, item) {
  // 单页模式下目标页可能是 display:none，先切过去再量文字框；富文档没有句框也跟着翻页
  if (n !== App.state.currentPage) scrollToPage(n, true, false);
  if (!item || item.item0 == null) { clearSpeechHl(); return; }
  const rects = sentenceRects(n, item);
  paintSpeech(n, rects);
  if (rects.length) scrollToSpeech(n, rects);
}

// ---- 位置记忆：按文档路径存 localStorage（只存页码 + 句序，不写库结构） ----
function speechHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
function speechKey() {
  const s = App.state;
  const p = s.filePath || s.fileName;
  return p ? 'trove.speech.v1.' + speechHash(p) : '';
}
function speechSavePos() {
  const key = speechKey();
  if (!key || speech.docKey !== key) return;
  try {
    localStorage.setItem(key, JSON.stringify({
      page: Math.max(1, speech.lastPage || speech.page || 1),
      index: Math.max(0, speech.lastPage ? speech.lastIndex : (speech.index || 0)),
      updated: Date.now(),
    }));
  } catch (_) {}
}
function speechLoadPos() {
  const key = speechKey();
  if (!key) return null;
  try {
    const v = JSON.parse(localStorage.getItem(key) || 'null');
    if (v && v.page >= 1) return v;
  } catch (_) {}
  return null;
}

function speechFinish() {
  speech.token++;
  speech.active = false;
  speech.status = 'idle';
  speech.list = [];
  speech.index = 0;
  clearSpeechHl();
  speechSavePos();
  syncSpeakUi();
  setStatus('朗读完成：已读到文档末尾');
  toast('已读到文档末尾');
}

function speakCurrent() {
  if (speech.status !== 'speaking') return;
  const item = speech.list[speech.index];
  if (!item) { speechNextPage(); return; }
  const token = speech.token;
  speech.lastPage = speech.page;
  speech.lastIndex = speech.index;
  highlightSentence(speech.page, item);
  speechSavePos();
  setStatus('朗读中：第 ' + speech.page + ' 页 · 第 ' + (speech.index + 1) + ' / ' + speech.list.length + ' 句');

  const u = new SpeechSynthesisUtterance(String(item.text).slice(0, 2000));
  u.lang = /[\u4e00-\u9fff]/.test(item.text) ? 'zh-CN' : 'en-US';
  u.rate = 1;
  u.onend = () => {
    speech.active = false;
    if (token !== speech.token || speech.status !== 'speaking') return;
    speechAdvance();
  };
  u.onerror = (e) => {
    speech.active = false;
    if (token !== speech.token) return;
    // 系统语音不可用：继续念下去只会空转，直接停下并说明原因
    if (e && (e.error === 'not-allowed' || e.error === 'synthesis-unavailable' || e.error === 'audio-busy')) {
      App.speakStop();
      toast('系统语音不可用，朗读已停止');
      return;
    }
    speechAdvance();   // 其它错误（没声音 / 被系统打断）不要卡死
  };
  speech.active = true;
  try { speechDriver().speak(u); } catch (_) {
    speech.active = false;
    setTimeout(speechAdvance, 0);   // 别用同步递归，长文档会爆栈
  }
}

function speechAdvance() {
  if (speech.status !== 'speaking') return;
  speech.index++;
  if (speech.index < speech.list.length) { speakCurrent(); return; }
  speechNextPage();
}

async function speechNextPage() {
  const token = ++speech.token;
  const s = App.state;
  let n = (speech.page || s.currentPage || 1) + 1;
  setStatus('朗读：正在准备第 ' + n + ' 页…');
  while (n <= s.numPages) {
    const list = await safePageSentences(n);
    if (token !== speech.token || speech.status !== 'speaking') return;
    if (list.length) {
      speech.page = n;
      speech.index = 0;
      speech.list = list;
      speakCurrent();
      return;
    }
    setStatus('第 ' + n + ' 页没有可朗读的文字，已跳过');
    n++;
  }
  speechFinish();
}

App.speakToggle = async function () {
  if (!('speechSynthesis' in window) && !speech.driver) { toast('当前环境不支持朗读'); return; }
  const s = App.state;
  if (!s.pdfDoc && s.mode !== 'rich') { toast('先打开一个文档'); return; }
  if (speech.status === 'speaking') {
    speechDriver().pause();
    speech.status = 'paused';
    syncSpeakUi();
    setStatus('朗读已暂停');
    return;
  }
  if (speech.status === 'paused') {
    // 句间准备下一页时暂停：没有 utterance 可 resume，直接重新起当前句
    if (speech.active) speechDriver().resume();
    speech.status = 'speaking';
    syncSpeakUi();
    setStatus('朗读继续：第 ' + speech.page + ' 页 · 第 ' + (speech.index + 1) + ' / ' + speech.list.length + ' 句');
    if (!speech.active) speakCurrent();
    return;
  }

  // 从头开始：从当前页读；若上次就停在这一页，从记住的句子续读
  const pageNum = s.currentPage || 1;
  const token = ++speech.token;
  let list = await safePageSentences(pageNum);
  if (token !== speech.token) return;
  if (!list.length) {
    let n = pageNum + 1;
    while (n <= s.numPages) {
      const l = await safePageSentences(n);
      if (token !== speech.token) return;
      if (l.length) { list = l; break; }
      n++;
    }
    if (!list.length) { toast('这篇文档没有可朗读的文字（可能是扫描件）'); return; }
    speech.page = n;
  } else {
    speech.page = pageNum;
  }
  const memo = speechLoadPos();
  let idx = 0;
  if (memo && memo.page === speech.page && memo.index > 0 && memo.index < list.length) {
    idx = memo.index;
    toast('从上次位置继续：第 ' + speech.page + ' 页第 ' + (idx + 1) + ' 句');
  }
  speech.index = idx;
  speech.list = list;
  speech.docKey = speechKey();
  speech.lastPage = speech.page;
  speech.lastIndex = idx;
  speech.status = 'speaking';
  syncSpeakUi();
  if (!idx) toast('开始朗读：第 ' + speech.page + ' 页');
  speakCurrent();
};

App.speakStop = function () {
  speech.token++;
  speech.active = false;
  speech.status = 'idle';
  speech.list = [];
  speech.index = 0;
  try { speechDriver().cancel(); } catch (_) {}
  clearSpeechHl();
  speechSavePos();
  syncSpeakUi();
  setStatus('朗读已停止');
};
App.speakStatus = function () { return speech.status; };
App.speechState = function () {
  return {
    status: speech.status, page: speech.page, index: speech.index,
    total: speech.list.length, lastPage: speech.lastPage, lastIndex: speech.lastIndex,
    text: (speech.list[speech.index] || {}).text || '',
    highlighted: document.querySelectorAll('#pages .speech-hl').length,
  };
};

// 朗读中按 H / U 直接给当前句加高亮 / 下划线（Zotero Read Aloud 的习惯）。
// 只对 PDF 有效：富文档没有句框，给了也画不准。
App.annotateSpeechSentence = function (kind) {
  const s = speech.list[speech.index];
  if (!s || s.item0 == null) { toast('当前句没有可标注的文字'); return null; }
  const rects = sentenceRects(speech.page, s);
  if (!rects.length) { toast('当前句没有可标注的文字'); return null; }
  const underline = kind === 'underline' || kind === 'u';
  const arr = App.state.annos.get(speech.page) || [];
  const dup = arr.some((sh) => sh && sh.tool === 'mark'
    && (sh.kind === 'underline' ? 'underline' : 'highlight') === (underline ? 'underline' : 'highlight')
    && sh.text === s.text);
  if (dup) { toast('这一句已经标注过了'); return null; }
  const color = ($('sel-color') && $('sel-color').value) || '#ffd54f';
  const sh = Anno.addShape(speech.page, {
    tool: 'mark', color, width: 0, rects, text: s.text,
    ...(underline ? { kind: 'underline' } : {}),
  });
  toast(underline ? '已给当前句加下划线' : '已高亮当前句');
  return sh;
};

// 打印当前文档：交给系统默认程序（Windows Start-Process -Verb Print / macOS·Linux lp）
App.printCurrent = async function () {
  const s = App.state;
  if (!s.filePath) { toast('先打开一个文档'); return; }
  if (!window.pdfBridge || !window.pdfBridge.printFile) { toast('当前环境不支持打印'); return; }
  const r = await window.pdfBridge.printFile(s.filePath);
  if (r && r.ok) toast('已交给系统打印');
  else toast('打印失败：' + ((r && r.error) || '未知错误'));
};

// ---------- 事件绑定 ----------
function bind() {
  const E = App.els = {
    open: $('btn-open'), zoomOut: $('btn-zoom-out'), zoomIn: $('btn-zoom-in'),
    scale: $('scale-select'), prev: $('btn-prev'), next: $('btn-next'), spread: $('btn-spread'),
    pageInput: $('page-input'), pageCount: $('page-count'), fileName: $('file-name'),
    status: $('status-text'), zoom: $('zoom-text'), hint: $('empty-hint'),
    viewer: $('viewer'), pages: $('pages'),
    save: $('btn-save'),
    speak: $('btn-speak'), speakStop: $('btn-speak-stop'), print: $('btn-print'),
    rotateLeft: $('btn-rotate-left'), rotateRight: $('btn-rotate-right'), split: $('btn-split'),
    refPane: $('ref-pane'), refPrev: $('ref-prev'), refNext: $('ref-next'), refPage: $('ref-page'),
    refFollow: $('ref-follow'), refClose: $('ref-close'),
  };

  // v9：朗读 / 停止 / 打印
  if (E.speak) E.speak.addEventListener('click', () => App.speakToggle());
  if (E.speakStop) E.speakStop.addEventListener('click', () => App.speakStop());
  if (E.print) E.print.addEventListener('click', () => App.printCurrent());

  // v34：旋转与分屏
  if (E.rotateLeft) E.rotateLeft.addEventListener('click', () => App.rotateView(-90));
  if (E.rotateRight) E.rotateRight.addEventListener('click', () => App.rotateView(90));
  if (E.split) E.split.addEventListener('click', () => App.setSplitView(!App.state.split));
  if (E.refClose) E.refClose.addEventListener('click', () => App.setSplitView(false));
  if (E.refPrev) E.refPrev.addEventListener('click', () => { ref.follow = false; if (E.refFollow) E.refFollow.checked = false; refSetPage(ref.page - 1); });
  if (E.refNext) E.refNext.addEventListener('click', () => { ref.follow = false; if (E.refFollow) E.refFollow.checked = false; refSetPage(ref.page + 1); });
  if (E.refPage) E.refPage.addEventListener('change', () => { ref.follow = false; if (E.refFollow) E.refFollow.checked = false; refSetPage(parseInt(E.refPage.value, 10) || 1); });
  if (E.refFollow) E.refFollow.addEventListener('change', () => {
    ref.follow = !!E.refFollow.checked;
    if (ref.follow) refSetPage(Math.min(App.state.numPages || 1, (App.state.currentPage || 1) + 1));
  });

  // 弹系统对话框选 PDF（工具栏「打开」、标签栏「＋」、Ctrl+O 都走这里）
  async function openViaDialog() {
    const res = await window.pdfBridge.openPdfDialog();
    if (res && res.ok) openDocument(res, { newTab: true });
    return res;
  }

  E.open.addEventListener('click', () => { openViaDialog(); });
  if (window.pdfBridge.onSaveError) window.pdfBridge.onSaveError(message => { setStatus(message); toast(message, 5000); });
  window.pdfBridge.onPdfOpened((res) => {
    if (!res || !res.ok) return;
    if (res.smoke) loadPdf(res.data, res.fileName, true, res);
    else openDocument(res, { newTab: true });
  });
  // v33：启动恢复上次会话。主进程只在「无命令行文件 + 设置开启 + 有会话」时推送；
  // 这里逐个按路径取回文档字节打开，文件已移走的跳过并计数。
  if (window.pdfBridge.onSessionRestore) {
    window.pdfBridge.onSessionRestore(async (info) => {
      const tabs = (info && info.tabs) || [];
      // R06：恢复全部记录（上限与保存一致，主进程已按 20 条裁剪），不再截断前 8 个；
      // 恢复期间挂起会话写入，结束后按实际打开的清单落一次盘并提示跳过数。
      // N05：后台标签只建标签对象、不启动加载——openDocument 会在 PDF 尚在异步加载时
      // 就返回，下一个标签的 syncActiveTab 会把还没就位的页码覆盖掉。标签对象自带
      // 文档字节，切到哪个标签 loadTab 就加载哪个，页码各归各的。
      let opened = 0, activeId = null;
      sessionRestoring = true;
      try {
        for (const t of tabs) {
          try {
            const payload = await window.pdfBridge.openDocPath({ path: t.path, page: t.page });
            if (!payload || !payload.ok || !payload.filePath) continue;
            payload.rotation = normRot(t.rotation || 0);   // v34：恢复视图旋转与参考页
            payload.refPage = Math.max(1, Math.floor(+t.refPage || t.page || 1));
            const tab = makeTab(payload);
            App.tabs.push(tab);
            opened++;
            if (info.active && t.path === info.active) activeId = tab.id;
          } catch (_) {}
        }
      } finally {
        sessionRestoring = false;
      }
      renderTabs();
      // 只加载激活项（没有记录就落在最后一个），其余标签等用户切换时再加载
      const target = (activeId && tabById(activeId)) || App.tabs[App.tabs.length - 1];
      if (target) loadTab(target);
      saveSessionNow();
      const skipped = tabs.length - opened;
      if (opened && skipped) toast('已恢复上次打开的 ' + opened + ' 个标签页；' + skipped + ' 个文件未能打开，已跳过', 5000);
      else if (opened > 1) toast('已恢复上次打开的 ' + opened + ' 个标签页');
    });
  }
  // v9：库里按条目元数据重命名了附件文件，把打开的标签 / 当前会话的路径跟着换掉
  if (window.pdfBridge.onFilesRenamed) {
    window.pdfBridge.onFilesRenamed((info) => {
      const changes = (info && info.changes) || [];
      if (!changes.length) return;
      const base = (p) => String(p || '').split(/[\\/]/).pop();
      let touched = false;
      for (const c of changes) {
        for (const t of App.tabs) {
          if (t.filePath === c.oldPath) {
            t.filePath = c.newPath;
            t.fileName = base(c.newPath);
            touched = true;
          }
        }
        if (App.state.filePath === c.oldPath) {
          App.state.filePath = c.newPath;
          App.state.fileName = base(c.newPath);
          App.els.fileName.textContent = App.state.fileName;
          touched = true;
        }
      }
      if (touched) {
        renderTabs();
        toast('文件已按条目信息重命名');
      }
    });
  }
  // v8：在文献库里改了标注文字/批注，主进程改完真身后通知阅读器重画
  if (window.pdfBridge.onAnnoReload) {
    window.pdfBridge.onAnnoReload((info) => {
      const p = info && info.path;
      if (!p || p !== App.state.filePath) return;
      const s = App.state;
      s.annos = new Map();
      // 富文档不维护 s.rendered（那是 PDF 的懒渲染表），按页数补齐，避免改完后旧图形残留
      const pages = new Set(s.rendered.keys());
      if (s.mode === 'rich') for (let n = 1; n <= s.numPages; n++) pages.add(n);
      for (const n of pages) { try { Anno.renderPage(n); } catch (_) {} }
      restoreAnnos(p);
      toast('标注已更新');
    });
  }

  // 标签栏：+ 打开新 PDF；点标签切换；点 × 关闭
  const tabNew = $('tab-new');
  if (tabNew) tabNew.addEventListener('click', () => { openViaDialog(); });
  const tabsHost = $('tabs');
  if (tabsHost) tabsHost.addEventListener('click', (e) => {
    const x = e.target.closest('[data-tab-close]');
    if (x) { e.stopPropagation(); closeTab(x.dataset.tabClose); return; }
    const t = e.target.closest('[data-tab-id]');
    if (t) switchTab(t.dataset.tabId);
  });

  // 文献库：暴露打开钩子给覆盖层用；工具栏「库」按钮回到库；启动即显示库
  window.__libOpen = (payload) => openDocument(payload, { newTab: true });
  startReadingTracker();
  if (window.DocSwitch) window.DocSwitch.init();
  if (window.LibraryUI) {
    window.LibraryUI.init();
    // 工具栏「文献库」按钮的点击由 modeswitch.js 统一处理（切模式时先滑高亮块）
    if (window.ModeSwitch) window.ModeSwitch.init();
    // 只有主应用窗口启动即进库；test-pen 等独立测试窗口不自动展开（也没有 lib-* IPC）
    if (window.pdfBridge.isApp) window.LibraryUI.show();
  }
  if (window.pdfBridge.getSettings) {
    window.pdfBridge.getSettings().then((s) => {
      applyTheme(s && s.theme);
      // v34：分屏偏好启动即生效（没有文档时先记着，打开 PDF 再显示）
      if (s && s.splitView) { App.state.split = true; syncSplitPane({ relayout: false }); }
    }).catch(() => {});
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
  if (E.spread) E.spread.addEventListener('click', () => {
    const m = App.setViewMode(App.state.viewMode === 'spread' ? 'scroll' : 'spread');
    toast(m === 'spread' ? '已切换到双页对开' : '已切换到连续滚动');
  });
  E.pageInput.addEventListener('change', () => scrollToPage(parseInt(E.pageInput.value, 10) || 1, false, true));
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
    // v35：朗读中 H / U 标注当前句（必须在工具快捷键之前拦，否则 H 会切成荧光笔）
    if (speech.status !== 'idle' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const sk = e.key.toLowerCase();
      if (sk === 'h' || sk === 'u') {
        App.annotateSpeechSentence(sk);
        e.preventDefault();
        return;
      }
    }
    if (e.ctrlKey && (e.key === 'z' || e.key === 'Z')) {
      if (App.state.mode === 'rich') return;
      Anno.undo(); e.preventDefault(); return;
    }
    if (e.ctrlKey && (e.key === 's' || e.key === 'S')) { doSave(); e.preventDefault(); return; }
    // v26：菜单栏去掉后，原来挂在菜单上的快捷键改到这里
    if (e.ctrlKey && !e.altKey && !e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === 'o') { openViaDialog(); e.preventDefault(); return; }
      if (k === 'p' && e.shiftKey) { exportCurrentPagePng(); e.preventDefault(); return; }
      if (k === 'p') { App.printCurrent(); e.preventDefault(); return; }   // v9：打印当前文档
      if (k === 'i' && e.shiftKey) { window.pdfBridge.openDevTools && window.pdfBridge.openDevTools(); e.preventDefault(); return; }
      if (k === '[') { App.rotateView(-90); e.preventDefault(); return; }   // v34：逆时针旋转
      if (k === ']') { App.rotateView(90); e.preventDefault(); return; }    // v34：顺时针旋转
      if (k === 'd' && e.shiftKey) {                                        // 双页对开
        const m = App.setViewMode(App.state.viewMode === 'spread' ? 'scroll' : 'spread');
        toast(m === 'spread' ? '已切换到双页对开' : '已切换到连续滚动');
        e.preventDefault(); return;
      }
    }
    // B：给当前页加 / 删书签（存标注 sidecar，跨启动可用）
    if (!e.ctrlKey && !e.altKey && !e.metaKey && (e.key === 'b' || e.key === 'B') && App.state.mode === 'pdf') {
      bookmarkToggle(App.state.currentPage);
      e.preventDefault();
      return;
    }
    // Z：放大模式开关。滚轮在这模式下专职缩放（锚点跟光标），空格+左键拖动平移。
    if (!e.ctrlKey && !e.altKey && !e.metaKey && (e.key === 'z' || e.key === 'Z')) {
      setZoomMode(!zoomMode.on);
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape' && zoomMode.on) { setZoomMode(false); e.preventDefault(); return; }
    // 工具快捷键：v 看图 / p 画笔 / h 荧光 / l 直线 / r 矩形 / a 箭头 / t 文字 / n 便签 / e 橡皮
    if (!e.ctrlKey && !e.altKey && !e.metaKey && App.state.mode !== 'rich') {
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
    if (e.key === 'Escape' && App.state.mode === 'rich') {
      if (window.Lightbox && Lightbox.isOpen()) return;
      if (document.body.classList.contains('focus-mode')) { App.setFocusMode(false); e.preventDefault(); }
      return;
    }
    if (e.key === 'F11') { App.setFocusMode(); e.preventDefault(); return; }
    if (e.key === 'F3') { gotoSearchHit(e.shiftKey ? -1 : 1); e.preventDefault(); return; }
    // Alt+←/→：阅读导航历史。必须在下面 ArrowLeft/Right 的翻页分支之前拦截
    //（按住 Alt 时 e.key 仍是 ArrowLeft，不拦就会边后退边翻页）。
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      if (e.key === 'ArrowLeft') navBack(); else navForward();
      e.preventDefault();
      return;
    }
    switch (e.key) {
      case 'ArrowLeft': case 'PageUp': prevPage(); e.preventDefault(); break;
      case 'ArrowRight': case 'PageDown': nextPage(); e.preventDefault(); break;
      case ' ':
        // 放大模式下空格是「手形工具」的修饰键，不能拿去翻页
        if (zoomMode.on) { zoomMode.space = true; e.preventDefault(); break; }
        nextPage(); e.preventDefault();
        break;
      case 'Home': scrollToPage(1, false, true); e.preventDefault(); break;
      case 'End': scrollToPage(App.state.numPages, false, true); e.preventDefault(); break;
      case '+': case '=': if (e.ctrlKey) { setNumericScale(App.state.scale * 1.25); e.preventDefault(); } break;
      case '-': if (e.ctrlKey) { setNumericScale(App.state.scale / 1.25); e.preventDefault(); } break;
      case '0': if (e.ctrlKey) { App.state.scaleMode = 'page-width'; E.scale.value = 'page-width'; applyLayout(); e.preventDefault(); } break;
    }
  });

  // 鼠标侧键（按键 3/4）= 阅读位置后退 / 前进，和浏览器的前进后退一个手感；
  // 库覆盖层开着时不响应，避免在库里误触翻到后台文档。
  document.addEventListener('mouseup', (e) => {
    if (e.button !== 3 && e.button !== 4) return;
    if (window.LibraryUI && window.LibraryUI.isOpen()) return;
    if (!App.state.filePath) return;
    e.preventDefault();
    if (e.button === 3) navBack(); else navForward();
  });

  // Ctrl+滚轮缩放；普通滚轮保持原生连续滚动（不劫持）。
  // 放大模式下不用按 Ctrl，滚轮直接就是缩放，并且锚点跟着光标走。
  // 触控板捏合会连发几十个 wheel 事件；每个事件都走一次 applyLayout（重排 + 重渲染所有页）
  // 会明显卡顿甚至看着闪。所以先把 delta 攒起来，最多每 16ms 应用一次，并用真实 delta 大小。
  // （不用 requestAnimationFrame：窗口隐藏时 rAF 不触发。）
  let zoomAcc = 0;
  let zoomLast = 0;
  let zoomTimer = null;
  let zoomPt = { x: 0, y: 0 };
  const applyZoomAcc = () => {
    zoomLast = Date.now();
    const acc = zoomAcc;
    zoomAcc = 0;
    if (!acc) return;
    const next = App.state.scale * Math.exp(-acc * 0.0016);
    if (zoomMode.on) zoomAtPoint(next, zoomPt.x, zoomPt.y);
    else setNumericScale(next);
  };
  E.viewer.addEventListener('wheel', (e) => {
    const wantZoom = e.ctrlKey || zoomMode.on;
    if (!wantZoom || (!App.state.pdfDoc && App.state.mode !== 'rich')) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : (e.deltaMode === 2 ? 400 : 1);
    const d = e.deltaY * unit;
    if (!d) return;
    zoomAcc += d;
    zoomPt = { x: e.clientX, y: e.clientY };
    const now = Date.now();
    if (now - zoomLast >= 16) applyZoomAcc();
    else if (!zoomTimer) zoomTimer = setTimeout(() => { zoomTimer = null; applyZoomAcc(); }, 16);
  }, { passive: false });

  document.addEventListener('keyup', (e) => {
    if (e.key !== ' ' || !zoomMode.space) return;
    zoomMode.space = false;
    zoomMode.panning = false;
    document.body.classList.remove('zoom-pan');
  });

  // 放大模式下的平移：空格 + 左键拖动（Acrobat 的手形工具）
  // 捕获阶段拦下，否则左键按下会被文字选择 / 标注层吃掉，拖出来是一片蓝
  E.viewer.addEventListener('mousedown', (e) => {
    if (!zoomMode.on || !zoomMode.space || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    zoomMode.panning = true;
    zoomMode.px = e.clientX;
    zoomMode.py = e.clientY;
    document.body.classList.add('zoom-pan');
  }, true);
  window.addEventListener('mousemove', (e) => {
    if (!zoomMode.panning) return;
    const v = App.els.viewer;
    if (v) {
      v.scrollLeft -= (e.clientX - zoomMode.px);
      v.scrollTop -= (e.clientY - zoomMode.py);
    }
    zoomMode.px = e.clientX;
    zoomMode.py = e.clientY;
  }, true);
  window.addEventListener('mouseup', () => {
    if (!zoomMode.panning) return;
    zoomMode.panning = false;
    document.body.classList.remove('zoom-pan');
  }, true);

  // 看图模式：点页面里的图片 → 灯箱放大看原图
  E.pages.addEventListener('click', (e) => {
    if (!document.body.classList.contains('tool-image')) return;
    const pageEl = e.target.closest && e.target.closest('.page');
    if (!pageEl) return;
    e.preventDefault();
    e.stopPropagation();
    openImageLightbox(pageEl, e.clientX, e.clientY);
  });

  // 智能跳转：普通单击点到引用标记 / 参考文献条目时互跳（Sioyek Smart Jump 的做法）。
  // 只在默认选择工具下生效；拖选、双击、带修饰键、画图工具、看图模式都不触发。
  E.pages.addEventListener('click', (e) => {
    if (e.button !== 0 || e.detail > 1) return;
    if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
    if (document.body.classList.contains('tool-image') || document.body.classList.contains('zoom-pan')) return;
    if (window.Anno && Anno.state && Anno.state.tool !== 'select') return;
    if (String(window.getSelection && getSelection())) return;   // 拖选后残留选区不触发
    if (!App.state || App.state.mode !== 'pdf' || !App.state.pdfDoc) return;
    const t = e.target;
    if (t && t.closest && t.closest('.anno, .anno-base, .sj-layer, .hl-layer, .speech-layer')) return;
    const pageEl = t.closest && t.closest('#pages .page');
    if (!pageEl) return;
    Promise.resolve(App._smartJumpAt(e.clientX, e.clientY)).catch(() => {});
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
      { label: '放大看这一块', run: () => openRegionLightbox(pageEl, e.clientX, e.clientY) },
      { label: '复制页码', run: () => { window.pdfBridge.copyText(String(n)); toast('已复制页码 ' + n); } },
      '-',
      {
        label: App.state.viewMode === 'spread' ? '改回连续滚动' : '改成双页对开',
        run: () => {
          const m = App.setViewMode(App.state.viewMode === 'spread' ? 'scroll' : 'spread');
          toast(m === 'spread' ? '已切换到双页对开' : '已切换到连续滚动');
        },
      },
      {
        label: App.state.viewMode === 'page' ? '改成连续滚动' : '改成单页翻页',
        run: () => {
          const m = App.setViewMode(App.state.viewMode === 'page' ? 'scroll' : 'page');
          toast(m === 'page' ? '已切换到单页翻页' : '已切换到连续滚动');
        },
      },
      '-',
      // v26：原来在「视图」菜单里，现在右键也能进（快捷键 F11 仍然有效）
      { label: '专注阅读模式', run: () => { App.setFocusMode(true); } },
    ]);
  });
  document.addEventListener('click', closeCtxMenu);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCtxMenu(); });
  window.addEventListener('blur', closeCtxMenu);

  // 富文档右键：复制/摘录/搜索选中文字；页面图片仍是普通内容
  const docView = $('doc-view');
  if (docView) docView.addEventListener('contextmenu', (e) => {
    const pageEl = e.target.closest && e.target.closest('.doc-page');
    if (!pageEl) return;
    e.preventDefault();
    const n = +pageEl.dataset.page || App.state.currentPage;
    const sel = window.getSelection();
    const selected = sel && !sel.isCollapsed ? String(sel).trim() : '';
    const items = [];
    if (selected) {
      items.push({ label: '复制选中文字（带出处）', run: () => copyWithSource(selected, n) });
      items.push({ label: '摘录选中文字', run: () => App.quoteSelection(selected, n) });
      items.push({ label: '搜索选中文字', run: () => { const box = $('search-box'); if (box) { box.value = selected.slice(0, 80); App.doSearch(box.value); } } });
      items.push('-');
    }
    items.push({ label: '复制第 ' + n + ' 页文字', run: copyPageText });
    items.push({ label: '复制页码', run: () => { window.pdfBridge.copyText(String(n)); toast('已复制页码 ' + n); } });
    items.push('-');
    items.push({
      label: App.state.viewMode === 'page' ? '改成连续滚动' : '改成单页翻页',
      run: () => {
        const m = App.setViewMode(App.state.viewMode === 'page' ? 'scroll' : 'page');
        toast(m === 'page' ? '已切换到单页翻页' : '已切换到连续滚动');
      },
    });
    items.push({ label: '专注阅读模式', run: () => { App.setFocusMode(true); } });
    openCtxMenu(e.clientX, e.clientY, items);
  });

  let rt = null;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      if (App.state.scaleMode === 'page-width' || App.state.scaleMode === 'page-fit') applyLayout();
      // v34：分屏宽度是百分比，窗口变化后参考页要按新宽度重排
      if (App.state.split) refRender();
    }, 120);
  });

  // 拖拽打开
  document.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); });
  document.addEventListener('drop', async (e) => {
    e.preventDefault(); e.stopPropagation();
    // 库覆盖层开着时，拖放由库处理（导入条目），这里不要再顺手把文件打开
    if (window.LibraryUI && window.LibraryUI.isOpen()) return;
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    const supported = /\.(pdf|docx?|rtf|odt|pptx?|odp|xlsx?|ods|csv|md|markdown|html?|epub|txt|log|json|xml|ya?ml|ini|toml|cfg|conf|properties|jsx?|tsx?|css|scss|less|py|java|c|h|cpp|hpp|cs|go|rs|rb|php|sh|bat|ps1|sql|tex|swift|kt|srt|vtt|png|jpe?g|gif|webp|bmp|svg|avif)$/i;
    if (!supported.test(file.name) && file.type !== 'application/pdf') {
      setStatus('暂不支持这个文件格式：' + file.name);
      return;
    }
    // 取真实路径：拖拽进来的文件也要能进「最近打开」并恢复页码。
    // 拿不到路径（例如非本地来源）时静默降级为「仅本次阅读」，不影响打开。
    let realPath = '';
    try { if (window.pdfBridge.pathForFile) realPath = window.pdfBridge.pathForFile(file) || ''; } catch (_) {}
    const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
    if (!isPdf) {
      // 非 PDF 必须由主进程转换；拿不到磁盘路径就没法读，给明确提示
      if (!realPath) { setStatus('这个文件没有本地路径，无法转换：' + file.name); return; }
      const r = await window.pdfBridge.openPath(realPath);
      if (!r || !r.ok) setStatus('打开失败：' + ((r && r.error) || file.name));
      return;
    }
    let startPage = 1;
    if (realPath && window.pdfBridge.noteRecent) {
      try { const r = await window.pdfBridge.noteRecent(realPath); if (r && r.page) startPage = r.page; } catch (_) {}
    }
    const buf = await file.arrayBuffer();
    openDocument({ ok: true, kind: 'pdf', data: new Uint8Array(buf), fileName: file.name, filePath: realPath, startPage }, { newTab: true });
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
