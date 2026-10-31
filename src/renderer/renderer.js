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
  s: 'stamp',   // v36：印章（S = Stamp）
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
    refPath: '',           // 2026-10-29：对照视图挂的另一篇文献（空 = 用当前文档的另一页）
    refName: '',
    refDoc: null,          // 对照文档的 PDFDocumentProxy（与主文档相互独立）
    refDocPages: 0,
    annos: new Map(),    // pageNum -> shape[]
    rendered: new Map(), // pageNum -> bool
    visible: new Set(),  // 当前视口内的页
    textCache: new Map(), // pageNum -> TextItem[]
    search: { query: '', results: [], rects: new Map(), hits: [], hitIndex: -1 }, // rects: pageNum -> [{x,y,w,h}]
    sj: { byPage: new Map(), builtTo: 0 },  // 智能跳转：按页存的跨页行缓存 page → [{page,text,x,y,w,h,idx}]
    bookmarks: [],   // 用户书签 [{page, at, label}]，存标注 sidecar
    bookmarksReady: null,   // 这一份文档的书签读盘 promise（首次操作前要等它）
    // 这一份文档的标注读盘结果：{ status: 'unknown'|'ok'|'missing'|'broken', annoPath, error }
    // broken 时必须禁止自动保存与归档——内存里现在这份「空标注」并不是磁盘上的真相，
    // 拿它去 flush 等于把还能人工修复的原文件换掉（第六轮审核 R6-01）。
    annoState: { status: 'unknown', annoPath: '', error: '' },
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
      refPath: t.refPath || '', refName: t.refName || '',
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
  // 换文档就把在跑的重排任务作废：它读的是上一份的页，留着只会串内容
  if (reflow.busy || reflow.open) reflowCancel();
  // 这里**不**重置 s.annoState：此刻屏幕上的还是上一份文档，它的标注状态仍然有效。
  // 提前重置会让「打开下一份」时被保存保护判成「标注还没读完」而取消（R-v1.6c-02）；
  // 真正的重置发生在 startAnnoRestore()——新文档成为当前文档的那一刻。
  // 这次加载是为哪个标签开的：结尾回写标签时要用它，不能拿「此刻的活动标签」凑合
  const tabId = App.activeTabId;
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
    // 销毁是异步的，而 await 期间共享的 s.pdfDoc / s.refDoc 可能已经被更新的载入换成别的文档。
    // 所以先把「要销毁的旧实例」抓在手里，恢复后不再从共享状态读它们。
    const prevPdf = s.pdfDoc;
    const prevRef = s.refDoc;
    // 切主文档时对照文档也要换：先作废还在跑的对照加载（它们要挂的是即将消失的旧文档），
    // 再销毁旧对照。放在销毁等待之前，新的主文档加载会自己再 ++，不会被这一跳误伤。
    refLoadSeq++;
    if (prevPdf) { try { await prevPdf.destroy(); } catch (_) {} }
    // 关键：销毁等待结束后必须再校验一次代际。等待期间用户可能又打开了 C 并已完成加载，
    // 旧调用在这里不退出的话会把已经显示的 C 换回 B，结尾的 syncActiveTab 还会把
    // C 的标签路径改成 B（第三轮审核 P2）。
    if (my !== loadSeq) { try { await pdfDoc.destroy(); } catch (_) {} return; }
    if (prevRef) { try { await prevRef.destroy(); } catch (_) {} }
    if (my !== loadSeq) { try { await pdfDoc.destroy(); } catch (_) {} return; }
    // 目标标签已经没了（关掉了它、或关掉了最后一个标签）：这次加载没有归宿。
    // 代际检查挡不住「关标签」——关标签不一定递增 loadSeq，所以这里再确认一次（R-v1.6d-03）。
    if (tabId && !tabById(tabId)) { try { await pdfDoc.destroy(); } catch (_) {} return; }
    s.refDoc = null;
    s.refDocPages = 0;

    // 重置
    s.mode = 'pdf';
    s.richPages = null;
    s.pdfDoc = pdfDoc;
    s.sourceBytes = bytes;
    s.numPages = pdfDoc.numPages;
    s.currentPage = 1;
    s.rotation = normRot(m.rotation || 0);   // v34：标签 / 会话里记的视图旋转
    s.refPage = Math.max(1, Math.floor(+m.refPage || +m.startPage || 1));
    s.refPath = m.refPath || '';
    s.refName = m.refName || '';
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
    // 建页块本身也有 await（逐页 getPage）。期间又开了别的文档时，页面容器已经被
    // 新加载接管，这里必须立刻收手，别把旧文档的页块塞进新文档的容器里。
    const built = await buildPageBlocks(pdfDoc, my);
    if (!built || my !== loadSeq) return;
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
    startAnnoRestore(s.filePath);   // 恢复该文件上次保存的标注（异步，不阻塞首屏）
    // v29：PDF 自带的批注不自动写入，只提示一次；用户点「导入 PDF 批注」才合并
    if (window.NativeAnnos) NativeAnnos.hint().catch(() => {});
    refreshSidebar();           // 侧栏若开着，立刻按新文档重建

    // 只回写给「这次加载」对应的标签：拿 currentTab() 凑合时，
    // 一旦活动标签已经不是它，就会把别人的路径改成这份文档的。
    if (!tabId || App.activeTabId === tabId) {
      syncActiveTab({ page: start, fileName: s.fileName, filePath: s.filePath });
    }
    renderTabs();
    if (smoke) runSmoke(fileName);
  } catch (err) {
    // 已经被更新的加载取代：失败信息不要盖掉新文档的状态栏
    if (my !== loadSeq) return;
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
  if (reflow.busy || reflow.open) reflowCancel();   // 重排只服务 PDF，切到富文档就收掉
  s.annoState = { status: 'unknown', annoPath: '', error: '' };
  s.annoBrokenNotified = false;
  try {
    if (s.pdfDoc) { try { s.pdfDoc.destroy(); } catch (_) {} }
    // 富文档没有分屏：对照文档一并释放，别让它挂在内存里
    refLoadSeq++;
    if (s.refDoc) { try { s.refDoc.destroy(); } catch (_) {} }
    s.refDoc = null; s.refDocPages = 0; s.refPath = ''; s.refName = '';
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
    startAnnoRestore(s.filePath);   // 富文档的标注也按文件路径存取，和 PDF 一致
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
  t.refPath = App.state.refPath || '';
  t.refName = App.state.refName || '';
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
      refPath: payload.refPath || '',
      refName: payload.refName || '',
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
    refPath: payload.refPath || '',
    refName: payload.refName || '',
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
    refPath: tab.refPath || '', refName: tab.refName || '',
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
  if (!(await flushBeforeLeave('切换标签')) || previous !== App.activeTabId || !tabById(id)) return;
  if (page) t.page = Math.max(1, Math.floor(+page || 1));
  loadTab(t);
}

function closeDocument() {
  const s = App.state;
  if (reflow.busy || reflow.open) reflowCancel();
  // 作废还没落地的加载：closeDocument 之后又有一份文档「加载完成」是最坏的情况——
  // 标签已经没了，正文却重新出现（R-v1.6d-03）。代际一加，所有在途的加载都会在
  // 下一个 await 检查点自行退出。
  loadSeq++;
  s.annoState = { status: 'unknown', annoPath: '', error: '' };
  s.annoBrokenNotified = false;
  if (s.pdfDoc) { try { s.pdfDoc.destroy(); } catch (_) {} }
  refLoadSeq++;
  if (s.refDoc) { try { s.refDoc.destroy(); } catch (_) {} }
  s.refDoc = null; s.refDocPages = 0; s.refPath = ''; s.refName = '';
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
    if (!(await flushBeforeLeave('切换标签')) || App.activeTabId !== id) return;
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
    if (!(await flushBeforeLeave('打开另一份文档')) || previous !== App.activeTabId) return;
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


// seq：发起这次建页的加载代际号。逐页 getPage 是 await，期间可能已有更新的加载
// 清空容器并重建；返回 false 表示这次建页作废，调用方不要再往下写界面状态。
async function buildPageBlocks(pdfDoc, seq) {
  const s = App.state;
  const host = App.els.pages;
  host.innerHTML = '';
  s.unitMaxW = 1; s.unitMaxH = 1;
  const dims = [];
  for (let n = 1; n <= s.numPages; n++) {
    if (seq != null && seq !== loadSeq) return false;
    const page = await pdfDoc.getPage(n);
    if (seq != null && seq !== loadSeq) return false;
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
  return true;
}

function mkSvg(cls, unitW, unitH) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('viewBox', `0 0 ${unitW} ${unitH}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  return svg;
}

// ---------- 文本层（选中/复制）与全文搜索 ----------
// 取一页的 PDFPageProxy：不要求这一页已经渲染出 DOM。
// 智能跳转/参考文献入库要扫文末的页，而用户此刻多半停在第 1 页——那些页的元素根本
// 还没建，只按 App.pageEl 拿就会一律返回空，参考文献入库于是永远报「没读到参考文献
// （扫描版）」，这是假警报。pdfDoc.getPage 是异步且被 PDF.js 自己缓存的。
async function pdfPageAt(n) {
  const el = App.pageEl(n);
  if (el && el._pdfPage) return el._pdfPage;
  const s = App.state;
  if (!s.pdfDoc) return null;
  try { return await s.pdfDoc.getPage(n); } catch (_) { return null; }
}

async function getTextContent(n) {
  const s = App.state;
  if (s.textCache.has(n)) return s.textCache.get(n);
  // 已渲染的页走快路径（一个 tick 都不多等），没渲染的页才去 pdfDoc 现取
  const el = App.pageEl(n);
  let pg = el && el._pdfPage;
  if (!pg) pg = await pdfPageAt(n);
  if (!pg) return [];
  const tc = await pg.getTextContent();
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
  const pg = await pdfPageAt(n);
  if (!pg) return [];
  const vp = pg.getViewport({ scale: 1 });
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

// ---------- 跨文档 Portal（v36） ----------
// 置信度不足就不开：宁可只是「跳到参考文献」，也不要把不相干的一篇怼到对开栏里。
const portal = { ready: null };

function portalEnabled() {
  return !(portal.off === true);
}

async function portalFollow(entry) {
  const s = App.state;
  const text = String(entry || '').trim();
  // 不管最后找没找到，都先把这条条目记下来：Overview 的手动入口随时可调用，
  // 用户不必为了改一篇再点回去把 Smart Jump 跑一遍。
  overview.pending = text;
  if (!text || !s.filePath) return null;
  if (!window.pdfBridge || !pdfBridge.portalTarget) return null;
  if (!portalEnabled()) return null;
  let r = null;
  try { r = await pdfBridge.portalTarget({ entry: text, path: s.filePath }); } catch (_) { return null; }
  if (!r || !r.ok || !r.found) { portalHint(true); return null; }
  if (r.path && s.filePath && String(r.path) === String(s.filePath)) return null;
  if ((r.score || 0) < 0.75) {
    // 弱匹配只提示、不动作：跳错一篇比不跳更让人困惑。
    // 但「不猜」不该等于「没得选」——右下角挂一个入口让用户自己挑。
    setStatus('库里可能有这条引用：' + r.title + '（把握不大 → Alt+O 或点「挑一篇」自己选）');
    portalHint(true);
    return null;
  }
  portalHint(false);
  if (!s.split) App.setSplitView(true);
  const ok = await loadRefDoc(r.path, r.title, { page: r.page || 1 });
  if (!ok) return null;
  setStatus('引用跟随：已在对开栏打开 ' + r.title + ' · 第 ' + (r.page || 1) + ' 页');
  toast('引用跟随：' + r.title, 2600);
  return r;
}

/* ---------- Overview：机器没把握时，由用户自己挑（仿 Sioyek 的 Overview） ----------
 * Smart Jump 与 Portal 的判定原则是「够不到阈值就不猜」——跳错一篇比不跳更让人困惑，
 * 这条不能动。但「不猜」的代价是：用户明明知道自己要哪一篇，却没处说。
 * 这里不改变判定策略，只补一个落口：把机器排过序的候选摆出来，点一下就走自动 Portal
 * 那条完全相同的路径（同样的 setSplitView + loadRefDoc + findStartPage）。
 * 候选为空也不算失败——下面还有整库的标题/作者搜索，手挑永远能做到。
 */
const overview = { pending: '', cands: [], candError: '', libItems: [], libError: '', timer: 0, seq: 0 };

function overviewPending() {
  return String(overview.pending || '').trim();
}

// 右下角那个「挑一篇」：弱匹配时才出现，避免常态占着状态栏
function portalHint(show) {
  const b = $('portal-cand');
  clearTimeout(overview.timer);
  if (!b) return;
  if (show) {
    b.hidden = false;
    overview.timer = setTimeout(() => { b.hidden = true; }, 45000);
  } else {
    b.hidden = true;
  }
}

function ovScoreHtml(c) {
  const pct = Math.round((c.score || 0) * 100);
  const cls = (c.score || 0) >= 0.75 ? ' strong' : ((c.score || 0) >= 0.5 ? ' mid' : '');
  return '<span class="ov-score' + cls + '" title="' + escHtml(c.why || '') + '">' + pct + '%</span>';
}

function ovRowHtml(it, opts) {
  const o = opts || {};
  const meta = [it.authors, it.year].filter(Boolean).join(' · ');
  // data-ov-cand：区分「机器排出来的候选」和「全库列表」，界面上行距一致，语义不同
  return '<button class="ov-item" data-ov-key="' + escHtml(it.key) + '"'
    + (o.cand ? ' data-ov-cand="1"' : '')
    + ' data-ov-title="' + escHtml(it.title) + '">'
    + '<span class="ov-title">' + escHtml(it.title) + '</span>'
    + '<span class="ov-meta">' + escHtml(meta || '—')
    + (o.why && it.why ? ' · ' + escHtml(it.why) : '') + '</span>'
    + (o.score ? ovScoreHtml(it) : '')
    + '</button>';
}

function closeOverview() {
  const m = $('overview-picker');
  if (m) m.hidden = true;
}

function ovMatch(it, q) {
  if (!q) return true;
  return (String(it.title || '') + ' ' + String(it.authors || '') + ' ' + String(it.year || ''))
    .toLowerCase().indexOf(q) >= 0;
}

function renderOverview() {
  const list = $('overview-list');
  if (!list) return;
  const q = String(($('overview-q') || {}).value || '').trim().toLowerCase();
  const out = [];
  const cand = q ? overview.cands.filter((c) => ovMatch(c, q)) : overview.cands.slice();
  if (cand.length) {
    if (!q) out.push('<div class="ov-sec">机器觉得可能是这几篇（按把握排序）</div>');
    for (const c of cand) out.push(ovRowHtml(c, { score: true, why: true, cand: true }));
  }
  const shown = new Set(cand.map((c) => c.key));
  const pool = overview.libItems.filter((x) => ovMatch(x, q) && (q || !shown.has(x.key)));
  if (overview.libError) {
    out.push('<button class="ov-empty" data-ov-retry="1">库列表读取失败：'
      + escHtml(overview.libError) + '（点击重试）</button>');
  } else if (overview.candError && !overview.cands.length) {
    out.push('<button class="ov-empty" data-ov-retry="1">候选读取失败：'
      + escHtml(overview.candError) + '（点击重试）</button>');
  } else if (pool.length) {
    out.push('<div class="ov-sec">' + (q ? '库里匹配到的（' + pool.length + ' 篇）' : '库里其余 PDF（打几个字按标题 / 作者缩小范围）') + '</div>');
    for (const x of pool.slice(0, q ? 120 : 60)) out.push(ovRowHtml(x, {}));
    if (pool.length > (q ? 120 : 60)) out.push('<div class="ov-empty">还有 ' + (pool.length - (q ? 120 : 60)) + ' 篇没列出，继续打字缩小范围</div>');
  } else if (!cand.length) {
    out.push('<div class="ov-empty">' + (q ? '没有匹配「' + escHtml(q) + '」的条目' : '库里还没有带 PDF 附件的条目') + '</div>');
  }
  list.innerHTML = out.join('');
}

async function loadOverviewCandidates(text) {
  // 代际号：快速连续打开（或刚切换了当前文档）时，上一轮的响应可能晚到一步，
  // 直接用会把「上一次的结果」盖回到列表里。这里和对开栏 loadRefDoc 同一个手法。
  const my = overview.seq;
  let r = null;
  try {
    r = await window.pdfBridge.portalCandidates({ entry: text, path: App.state.filePath || '' });
  } catch (err) { r = { ok: false, error: err && err.message }; }
  if (my !== overview.seq) return;
  if (r && r.ok && Array.isArray(r.candidates)) {
    overview.cands = r.candidates;
    overview.candError = '';
  } else {
    overview.cands = [];
    overview.candError = (r && r.error) || '未知错误';
  }
  renderOverview();
}

async function loadOverviewLib() {
  const my = overview.seq;
  let r = null;
  try { r = await window.pdfBridge.lib.pdfList(); }
  catch (err) { r = { ok: false, error: err && err.message }; }
  if (my !== overview.seq) return;
  if (r && r.ok && Array.isArray(r.items)) {
    const cur = String(App.state.filePath || '');
    overview.libItems = r.items.filter((x) => !cur || String(x.path) !== cur);
    overview.libError = '';
  } else {
    overview.libItems = [];
    overview.libError = (r && r.error) || '未知错误';
  }
  renderOverview();
}

async function openOverview(entry) {
  const modal = $('overview-picker');
  if (!modal) return;
  const text = String(entry === undefined ? overviewPending() : (entry || '')).trim();
  overview.seq++;
  if (text) overview.pending = text;
  overview.cands = []; overview.candError = '';
  overview.libItems = []; overview.libError = '';
  const box = $('overview-entry');
  if (box) {
    box.textContent = overviewPending()
      ? (overviewPending().length > 240 ? overviewPending().slice(0, 240) + '…' : overviewPending())
      : '（还没点过参考文献条目；直接在下面搜标题 / 作者也行）';
  }
  const q = $('overview-q');
  if (q) q.value = '';
  modal.hidden = false;
  portalHint(false);
  renderOverview();
  setTimeout(() => { try { if (q) q.focus(); } catch (_) {} }, 30);
  await Promise.all([loadOverviewCandidates(overviewPending()), loadOverviewLib()]);
}
App.openOverview = openOverview;

async function pickOverview(key, title) {
  closeOverview();
  if (!key) return;
  if (!window.pdfBridge || !window.pdfBridge.portalPick) return;
  let r = null;
  try { r = await window.pdfBridge.portalPick({ key }); }
  catch (err) { r = { ok: false, error: err && err.message }; }
  if (!r || !r.ok) { toast('打不开这篇：' + ((r && r.error) || '未知错误')); return; }
  if (r.path && String(r.path) === String(App.state.filePath)) {
    closeRefPicker();
    App.clearRefDoc();
    toast('这篇就是当前在读的文档');
    return;
  }
  if (!App.state.split) App.setSplitView(true);
  const ok = await loadRefDoc(r.path, r.title || title || '', { page: r.page || 1 });
  if (ok) {
    setStatus('手动选定：' + (r.title || '') + ' · 第 ' + (r.page || 1) + ' 页');
    toast('对照文献：' + (r.title || '已载入'));
  }
}
App.pickOverview = pickOverview;

// 设置里读到 portal=false 就关掉（默认开）
function portalLoadPref() {
  try {
    const p = window.pdfBridge && window.pdfBridge.getSettings ? window.pdfBridge.getSettings() : null;
    Promise.resolve(p).then((st) => { portal.off = !!(st && st.portal === false); }).catch(() => {});
  } catch (_) {}
}
App.portalFollow = portalFollow;


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
      // Portal：把这条参考文献整段（可能跨行）交给主进程，在库里找那一篇并开到对开栏。
      // 不 await：跳转本身已经完成了，找库慢不该让页面卡在这里。
      const entryFull = (window.Portal && window.Portal.entryAt)
        ? window.Portal.entryAt(lines, entryIdx, { maxLines: 6 })
        : ln.text;
      portalFollow(entryFull).catch(() => {});
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

// ---------- 参考文献表批量入库（v36） ----------
// 交互只有三步：从文末往前找到「参考文献 / References」→ 把那一节的行交给主进程解析 →
// 列表逐条过目（默认只勾「新增且认得出」的）→ 导入。可联网按 DOI 补全题录。
// 这一层不写任何东西：写库发生在用户点「导入」之后、由主进程做。
const refi = {
  open: false, busy: false, lines: [], entries: [], picked: new Set(),
  info: null, seq: 0,
};

function refiSetStatus(text, cls) {
  const el = $('refi-status');
  if (!el) return;
  el.textContent = text || '';
  el.className = 'refi-status' + (cls ? ' ' + cls : '');
}

// 参考文献区的行（按阅读顺序）。标题找不到时退回最后两页，并把这件事写在界面上。
async function refiScanLines() {
  const s = App.state;
  const total = s.numPages || 0;
  if (!total || !SJ()) return { lines: [], page: 0, found: false };
  const look = Math.min(total, 20);   // 参考文献再长，标题也不会离文末太远
  const ensure = async (n) => {
    if (s.sj.byPage.has(n)) return s.sj.byPage.get(n);
    const items = await sjPageItems(n);
    const rows = items.length ? SJ().buildLines(items).map((ln) => Object.assign({ page: n }, ln)) : [];
    s.sj.byPage.set(n, rows);
    return rows;
  };
  let startPage = 0, startIdx = 0, misses = 0;
  for (let n = total; n > total - look && n >= 1; n--) {
    const rows = await ensure(n);
    const at = rows.findIndex((ln) => SJ().isBibHeading(ln.text));
    if (at >= 0) { startPage = n; startIdx = at; misses = 0; }
    else if (startPage) { misses++; if (misses >= 2) break; }
  }
  const found = startPage > 0;
  if (!found) { startPage = Math.max(1, total - 1); startIdx = 0; }
  const out = [];
  for (let n = startPage; n <= total; n++) {
    const rows = n === startPage ? (await ensure(n)).slice(startIdx) : await ensure(n);
    for (const ln of rows) {
      const t = String(ln.text || '').trim();
      if (t) out.push(t);
    }
  }
  return { lines: out, page: startPage, found };
}

const REFI_CONF = {
  meta: ['补全', 'ok'], id: ['可补全', 'id'], parsed: ['仅标题', 'parsed'], weak: ['认不出', 'weak'],
};

function refiRowHtml(e) {
  const on = refi.picked.has(e.no);
  const dup = e.status === 'dup';
  const conf = REFI_CONF[e.confidence] || REFI_CONF.weak;
  const badge = dup ? ['已有', 'dup'] : conf;
  const meta = [];
  if (e.creators && e.creators.length) meta.push(e.creators.join(', ') + (e.creators.length >= 6 ? ' 等' : ''));
  if (e.year) meta.push(e.year);
  if (e.publication) meta.push(e.publication);
  const vip = [e.volume && ('vol. ' + e.volume), e.issue && ('no. ' + e.issue), e.pages].filter(Boolean).join(', ');
  if (vip) meta.push(vip);
  const id = e.doi ? ('DOI ' + e.doi) : (e.arxiv ? ('arXiv ' + e.arxiv) : '');
  return '<label class="refi-row' + (dup || e.confidence === 'weak' ? ' refi-dim' : '') + '" data-refi-no="' + e.no + '">' +
    '<input type="checkbox" data-refi-pick="' + e.no + '"' + (on ? ' checked' : '') + ' />' +
    '<span class="refi-main">' +
      '<span class="refi-title">' + escHtml(e.title || '（没认出标题）') + '</span>' +
      '<span class="refi-meta">' + escHtml(meta.join(' · ') || '—') + '</span>' +
      '<span class="refi-raw">' + escHtml(e.rawText || '') + '</span>' +
      (id ? '<span class="refi-id">' + escHtml(id) + '</span>' : '') +
    '</span>' +
    '<span class="refi-badge refi-badge-' + badge[1] + '" title="' + escHtml(e.why || '') + '">' + escHtml(badge[0]) + '</span>' +
  '</label>';
}

function refiRender() {
  const list = $('refi-list');
  if (!list) return;
  if (!refi.entries.length) {
    list.innerHTML = '<div class="refi-empty">没认出条目。这张 PDF 的参考文献可能是图片（扫描版），或者标题不叫 References。</div>';
  } else {
    list.innerHTML = refi.entries.map(refiRowHtml).join('');
  }
  const add = refi.entries.filter((e) => e.status === 'new').length;
  const dup = refi.entries.filter((e) => e.status === 'dup').length;
  const weak = refi.entries.filter((e) => e.status === 'weak' || e.confidence === 'weak').length;
  const cnt = $('refi-count');
  if (cnt) cnt.textContent = '共 ' + refi.entries.length + ' 条 · 新增 ' + add + ' · 已有 ' + dup + ' · 认不出 ' + weak;
  const go = $('refi-go');
  if (go) {
    go.disabled = refi.busy || !refi.picked.size;
    go.textContent = refi.picked.size ? '导入 ' + refi.picked.size + ' 条' : '导入选中';
  }
}

function refiDefaultPick(entries) {
  // 默认只勾「库里没有、并且认得出」的：既不会重复入库，也不会把切错的残句塞进去
  for (const e of entries) {
    if (e.status === 'new' && e.confidence !== 'weak') refi.picked.add(e.no);
  }
}

async function openRefImport() {
  const s = App.state;
  if (!s.pdfDoc || s.mode !== 'pdf') { toast('先打开一份 PDF'); return; }
  const box = $('refi-modal');
  if (!box) return;
  const seq = ++refi.seq;
  refi.open = true;
  refi.entries = [];
  refi.lines = [];
  refi.picked = new Set();
  refi.busy = false;
  box.hidden = false;
  refiSetStatus('正在读取参考文献…');
  const list = $('refi-list');
  if (list) list.innerHTML = '';
  const cnt = $('refi-count');
  if (cnt) cnt.textContent = '';

  let scan = null;
  try { scan = await refiScanLines(); } catch (_) { scan = null; }
  if (seq !== refi.seq) return;   // 期间关掉了弹窗 / 换了文档
  if (!scan || !scan.lines.length) {
    refiSetStatus('没读到参考文献：这份 PDF 可能没有文字层（扫描版）。', 'refi-warn');
    refiRender();
    return;
  }
  refi.lines = scan.lines;
  refiSetStatus('已取到 ' + scan.lines.length + ' 行，正在解析…（第 ' + scan.page + ' 页起）');
  let r = null;
  try {
    r = await pdfBridge.importReferences({ lines: scan.lines, dryRun: true });
  } catch (err) { r = { ok: false, error: String((err && err.message) || err) }; }
  if (seq !== refi.seq) return;
  if (!r || !r.ok) {
    refiSetStatus('解析失败：' + ((r && r.error) || '未知错误'), 'refi-warn');
    refiRender();
    return;
  }
  refi.entries = r.entries || [];
  refi.info = r;
  refi.picked = new Set();
  refiDefaultPick(refi.entries);
  const hint = [];
  if (!scan.found && !r.heading) hint.push('没找到「参考文献」标题，这是最后几页的解析结果，请逐条核对。');
  if (r.truncated) hint.push('条目太多，只解析了前 ' + refi.entries.length + ' 条。');
  refiSetStatus((hint.length ? hint.join(' ') + ' ' : '') + '（第 ' + scan.page + ' 页起）', hint.length ? 'refi-warn' : '');
  refiRender();
}

function closeRefImport() {
  const box = $('refi-modal');
  refi.seq++;
  refi.open = false;
  refi.busy = false;
  if (box) box.hidden = true;
}

async function refiGo() {
  if (refi.busy || !refi.picked.size) return;
  refi.busy = true;
  refiRender();
  refiSetStatus('正在入库…');
  const picks = refi.entries.filter((e) => refi.picked.has(e.no)).map((e) => e.no);
  const fetchOn = $('refi-fetch') ? $('refi-fetch').checked : true;
  let r = null;
  try {
    r = await pdfBridge.importReferences({ lines: refi.lines, dryRun: false, pick: picks, fetch: fetchOn });
  } catch (err) { r = { ok: false, error: String((err && err.message) || err) }; }
  refi.busy = false;
  if (!r || !r.ok) {
    refiSetStatus('导入失败：' + ((r && r.error) || '未知错误'), 'refi-warn');
    refiRender();
    return;
  }
  const bits = ['已入库 ' + r.added + ' 条'];
  if (r.fetched) bits.push('联网补全 ' + r.fetched + ' 条');
  if (r.skipped) bits.push('跳过重复 ' + r.skipped + ' 条');
  if (r.failures && r.failures.length) bits.push('补全失败 ' + r.failures.length + ' 条');
  refiSetStatus(bits.join('，'), r.added ? 'refi-ok' : 'refi-warn');
  toast('参考文献入库：' + bits.join('，'), 3200);
  // 导入后这些条目已在库里：原地把它们标成「已有」，按钮置灰，避免第二次点成重复导入
  const done = new Set(picks);
  refi.entries = refi.entries.map((e) => done.has(e.no) ? Object.assign({}, e, { status: 'dup', why: '本次已导入' }) : e);
  refi.picked = new Set();
  refiRender();
  if (r.failures && r.failures.length) {
    const el = $('refi-status');
    if (el) el.title = r.failures.map((f) => (f.title || '') + ' → ' + (f.doi || '')).join('\n');
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
      '<button class="tbtn" id="anno-import-native" title="导入这份 PDF 里已有的标准批注；如果这份是 Trove 导出的副本，会从内嵌数据完整恢复（含颜色、评论、子类型）">导入 PDF 批注</button>' +
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
        if (!r.total) { state.textContent = '没有自带批注'; toast('这份 PDF 没有可导入的批注（也没有 Trove 副本里的内嵌数据）', 3500); return; }
        state.textContent = r.added ? '已恢复 ' + r.added + ' 条' : '已是全部导入';
        toast(r.added
          ? (r.source === 'embedded'
            ? '已从副本内嵌数据恢复 ' + r.added + ' 条批注' + (r.skipped ? '，跳过 ' + r.skipped + ' 条（已存在）' : '')
            : '已导入 ' + r.added + ' 条 PDF 原有批注' + (r.skipped ? '，跳过 ' + r.skipped + ' 条（已存在或不支持）' : ''))
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
// ---------- 标注的「可信状态」与「本次恢复」凭据 ----------
// 打开文档时先把内存标注清空，再异步把磁盘上的标注读回来。中间这段时间里，
// 内存里的「空」既不是「这份文档没有标注」，也不是「用户删光了」——它只是**还没读完**。
// 此时任何写盘（自动保存 / 归档 / 切文档前保存）都会把上次正常保存的标注一次性抹掉，
// 而且事后无从分辨是丢了还是删了。所以写盘前必须：①等这次恢复落地；②状态是可信的。
// 可信 = ok（有内容）或 missing（确实没有文件）；unknown / broken 一律不动笔。
//
// 凭据是「每次加载一份」的：路径 + 加载代际 + promise。用旧文档的恢复结果放行，
// 等于把 A 的结论用在 B 上（第七轮审核 R7-01）。
let annoRestore = { gen: -1, path: '', promise: null };
// 「当前已显示文档」的标注凭据：路径 + 它是第几代加载装上去的。
// 不能拿全局 loadSeq 当凭据：下一次加载一开始就把 loadSeq 递增了，但屏幕上的还是上一份，
// 拿新代际去核对旧文档的恢复句柄必然不匹配，保存保护就会把「打开下一份」也一并拦掉
// （R-v1.6c-02）。凭据只在这一份文档真正成为当前文档时更新。
let annoDoc = { path: '', gen: -1 };
let annoRetry = 0;

function startAnnoRestore(filePath) {
  annoRetry = 0;
  const p = String(filePath || '');
  // 新文档成为当前文档的时刻：凭据与状态一起换。放在这里而不是 loadPdf 开头，
  // 是因为 loadPdf 开头到真正换页之间还有一段销毁等待，那期间显示的仍是上一份。
  annoDoc = { path: p, gen: loadSeq };
  App.state.annoState = { status: 'unknown', annoPath: '', error: '' };
  App.state.annoBrokenNotified = false;
  const token = { gen: loadSeq, path: p, promise: null };
  annoRestore = token;
  token.promise = restoreAnnos(p);
  return token;
}

// 等到「这一份文档、这一次加载」的标注恢复出结果。
// 返回 true 表示等到了、且等待期间没有切文档（可以放心用 App.state.annoState 判断）。
// 判定「还没切走」靠的是恢复令牌 + 当前路径：令牌换了或路径变了都说明换了文档。
// 刻意不比对 loadSeq——下一份文档可能已经开始加载（loadSeq 已递增）但还没装上去，
// 那种情况下这份文档的标注仍然是可信的，该保存就得保存。
async function annoRestoreSettled(path0, gen0) {
  const t = annoRestore;
  if (!t || !t.promise) return false;
  if (t.gen !== gen0 || t.path !== path0) return false;
  try { await t.promise; } catch (_) {}
  return annoRestore === t && App.state.filePath === path0;
}

function annoStateOk() {
  const st = App.state.annoState;
  return !!st && (st.status === 'ok' || st.status === 'missing');
}

// 不是 unknown/broken 才返回空串。调用前必须先 await annoRestoreSettled。
function annoUnsafeReason(force) {
  const st = App.state.annoState;
  if (force) return '';
  if (!st) return '标注状态未知';
  if (st.status === 'broken') return st.error || '标注文件读不出来';
  if (st.status !== 'ok' && st.status !== 'missing') return '标注还没有读完（不能把「没读完」当成「没有标注」）';
  return '';
}

// 兼容旧调用点：只问「是不是已确认损坏」
function annoBrokenReason() {
  const st = App.state.annoState;
  if (!st || st.status !== 'broken') return '';
  return st.error || '标注文件读不出来';
}
App.annoBrokenReason = annoBrokenReason;

function annoBrokenMessage() {
  const st = App.state.annoState;
  if (st && st.status !== 'broken') {
    return '标注还在读取，这次改动先留在内存里；读完会自动补存（不必重画）';
  }
  const name = st && st.annoPath ? st.annoPath.split(/[\\/]/).pop() : '标注文件';
  return name + ' 已损坏，本次修改不会保存（原文件保留在 ' + (st.annoPath || 'annotations 目录') + '），' +
    '可在命令面板执行「重建标注文件」把原文件另存一份后重新开始';
}

// force = 用户明确要求重建（主进程会先把损坏的原文件另存为 *.broken-<时间戳>.json）
async function saveAnnosNow(force) {
  const s = App.state;
  if (!s.filePath || !window.pdfBridge.saveAnnos) return;
  if (!force) {
    // 先看这次文档的标注有没有读完，再决定动不动笔（R7-01）：
    // 刚打开就保存会把「空」写回去，覆盖上次正常保存的标注，且主进程的损坏检查查不出来
    // ——磁盘上那份是把.request 写成功的合法 JSON，看起来跟「用户删光了」一模一样。
    // 凭据取「当前已显示文档」的那一份，不是全局 loadSeq——下一份可能正在加载但还没装上去
    const path0 = annoDoc.path || s.filePath;
    const gen0 = annoDoc.gen >= 0 ? annoDoc.gen : loadSeq;
    const settled = path0 === s.filePath ? await annoRestoreSettled(path0, gen0) : false;
    if (!settled) {
      // 这批改动还留在内存里，别让用户白画：等这次读盘落地后再补一次（最多重试 20 次，
      // 避免在没有恢复句柄的环境里空转出一个永不停止的定时器）
      clearTimeout(App._annoSaveTimer);
      if (annoRetry < 20) { annoRetry++; App._annoSaveTimer = setTimeout(saveAnnosNow, 300); }
      return false;
    }
    const why = annoUnsafeReason(force);
    if (why) {
      const st = s.annoState;
      const what = (st && st.status === 'broken') ? '标注文件已损坏' : '标注还没有读完';
      setStatus('标注没有保存：' + what + '（' + why + '）');
      // 每次改动都弹会把界面刷爆，一份文档只提示一次
      if (!s.annoBrokenNotified) { s.annoBrokenNotified = true; toast(annoBrokenMessage(), 7000); }
      return false;
    }
  }
  const pages = [];
  for (const [n, shapes] of s.annos) {
    if (!shapes || !shapes.length) continue;
    // v8：稳定 id 兜底（库里按 id 存标签 / 所属条目，缺 id 会串位）
    for (const sh of shapes) if (!sh.id && window.Anno) sh.id = window.Anno.newAnnoId();
    pages.push({ page: n, shapes: JSON.parse(JSON.stringify(shapes)) });
  }
  try {
    const result = await window.pdfBridge.saveAnnos(s.filePath, pages, force ? { force: true } : undefined);
    if (result !== true && !(result && result.ok === true)) {
      // 主进程拦下来的（读盘时还没查出来，或状态还没回来就先改了标注）：
      // 把状态补上，后续归档 / 保存才会一起停手
      if (result && result.broken) {
        s.annoState = { status: 'broken', annoPath: result.annoPath || s.annoState.annoPath, error: result.error || '' };
        setStatus('标注没有保存：标注文件已损坏（原文件已保留）');
        if (!s.annoBrokenNotified) { s.annoBrokenNotified = true; toast(annoBrokenMessage(), 7000); }
        return false;
      }
      throw new Error((result && result.error) || '写入失败');
    }
    if (force) {
      // 重建成功：磁盘上现在是一份干净的标注，后续自动保存恢复
      s.annoState = { status: 'ok', annoPath: s.annoState.annoPath, error: '' };
      s.annoBrokenNotified = false;
    }
    return force && result && result.backup ? result : true;
  } catch (err) {
    setStatus('标注保存失败：' + err.message);
    toast('标注尚未保存，请检查磁盘或目录权限后重试', 5000);
    return false;
  }
}
App.flushAnnos = saveAnnosNow;

// 关窗握手（v1.6d）：主进程拦下 close，等这里把标注与笔记都存完再真正关闭。
// 顺序有讲究：笔记先存（它可能改动条目标题），标注后存；任一步失败都要如实回报，
// 让主进程保留窗口——把没保存的内容关掉是最坏的失败方式。
async function handleWillClose() {
  let ok = true;
  let error = '';
  try {
    if (window.LibraryUI && LibraryUI.flushPendingSaves) {
      if (!await LibraryUI.flushPendingSaves()) { ok = false; error = '笔记没能保存到磁盘。'; }
    }
  } catch (e) { ok = false; error = '笔记保存出错：' + (e && e.message ? e.message : e); }
  if (ok) {
    try {
      // 标注还在读盘（刚打开就关窗）时给它一小会儿：直接 flush 会被保护拦成失败，
      // 用户看到的却是「保存失败」的弹窗，容易误判成丢数据。
      if (App.state.filePath) {
        await Promise.race([
          annoRestoreSettled(annoDoc.path || App.state.filePath, annoDoc.gen),
          new Promise((r) => setTimeout(r, 1500)),
        ]);
      }
      clearTimeout(App._annoSaveTimer);
      if ((await App.flushAnnos()) === false) { ok = false; error = '标注没能写入磁盘（磁盘空间或目录权限？）。'; }
    } catch (e) { ok = false; error = '标注保存出错：' + (e && e.message ? e.message : e); }
  }
  if (window.pdfBridge && pdfBridge.closeReady) pdfBridge.closeReady({ ok, error });
  // 给回归留个可读的结果（关窗后窗口就没了，探针没法再问一次）
  App._lastCloseFlush = { ok, error };
  return { ok, error };
}
App.handleWillClose = handleWillClose;
if (window.pdfBridge && pdfBridge.onWillClose) pdfBridge.onWillClose(handleWillClose);

// 切文档 / 关标签前先保存当前标注。返回 true 表示可以继续走。
// 标注文件损坏时不能 flush（会把还能人工修复的原文件换成一份合法空数据），
// 但也不能因此把导航卡死——只如实提示「这批改动没保存」，人得能走。
async function flushBeforeLeave(where) {
  // 先等这批标注读完：读到的内容会并进内存（restore 是往 Map 里追加，不清空用户刚画的），
  // 存下去才是「旧的 + 新的」。不等就用空覆盖上一次的正常保存（R7-01）。
  // 等的是「当前已显示文档」那一份，不是正在加载的下一份（R-v1.6c-02）。
  if (App.state.filePath) await annoRestoreSettled(annoDoc.path || App.state.filePath, annoDoc.gen);
  if (annoBrokenReason()) {
    clearTimeout(App._annoSaveTimer);
    toast('当前文档的标注文件已损坏，改动没有保存' + (where ? '（' + where + '后这些改动会丢失）' : ''), 6000);
    return true;
  }
  if ((await App.flushAnnos()) === false) {
    toast('标注尚未保存，已取消' + (where || '离开文档') + '；请等待标注读取完成，或解决写入问题后重试', 6000);
    return false;
  }
  return true;
}
App.flushBeforeLeave = flushBeforeLeave;

// 显式重建：把损坏的原文件先另存一份，再用内存里的标注重写。
// 只应在用户确认「原文件我不要了 / 已自己备份」之后调用（命令面板入口）。
App.rebuildAnnosFile = async function () {
  const s = App.state;
  if (!s.filePath) return { ok: false, error: '没有文档路径' };
  // 重建的判断依据是「读盘状态」，而状态要等这次读盘结束才有意义；
  // 没等就直接看 'unknown'，会把「还在读」误判成「没坏，无需重建」。
  await annoRestoreSettled(annoDoc.path || s.filePath, annoDoc.gen);
  if (annoBrokenReason() === '') return { ok: true, note: '当前标注文件没有损坏，无需重建' };
  clearTimeout(App._annoSaveTimer);
  const r = await saveAnnosNow(true);
  if (r && r.ok === true && r.backup) {
    setStatus('已重建标注文件；原文件另存为 ' + r.backup.split(/[\\/]/).pop());
    toast('已重建标注文件；损坏的原文件已另存一份：' + r.backup, 7000);
    refreshAnnoPane();
    return { ok: true, backup: r.backup };
  }
  const msg = (r && r.error) || '重建失败';
  setStatus('重建标注文件失败：' + msg);
  toast('重建失败：' + msg, 6000);
  return { ok: false, error: msg };
};
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
  if (!filePath) return;
  // annoState 已在 startAnnoRestore() 里重置（那一刻这份文档才成为当前文档）。
  // 这里再置一次会把「读盘期间已经被更新的加载换掉」的状态又打回 unknown，反而更危险。
  if (!window.pdfBridge.loadAnnos && !window.pdfBridge.loadAnnosState) {
    // 压根没有读标注的通道，也就没有什么「还没读完」可等——留在 unknown 会把所有保存永久挡住
    App.state.annoState = { status: 'ok', annoPath: '', error: '' };
    return;
  }
  // 优先用「带状态」的读法：空数组既可能是「没标注过」，也可能是「读不出来」，
  // 后者如果当成前者，下一次自动保存 / 归档就把还能修复的原文件覆盖了（R6-01）
  let res = null;
  try {
    res = window.pdfBridge.loadAnnosState
      ? await window.pdfBridge.loadAnnosState(filePath)
      : { ok: true, status: 'ok', pages: await window.pdfBridge.loadAnnos(filePath) };
  } catch (err) {
    res = { ok: false, status: 'broken', pages: [], error: String((err && err.message) || err) };
  }
  if (!res) res = { ok: false, status: 'broken', pages: [], error: '没有返回结果' };
  if (!stillCurrent()) return;
  const st = res.status || (res.ok === false ? 'broken' : 'ok');
  App.state.annoState = { status: st, annoPath: res.annoPath || '', error: res.error || '' };
  if (st === 'broken') {
    // 不写任何标注，也不再往下走：内存里的空不是磁盘上的真相。
    // 状态栏 + 一次性提示，说清「修改不会保存」和原文件在哪，别让用户以为标注丢了。
    setStatus('标注文件读不出来，已按空标注显示；修改将不会保存（原文件已保留）');
    toast('标注文件已损坏（' + (res.error || '读取失败') + '）。为免覆盖原文件，本次打开期间不会自动保存标注。' +
      '可在命令面板执行「重建标注文件」把原文件另存后重新开始。', 8000);
    return;
  }
  const saved = Array.isArray(res.pages) ? res.pages : [];
  if (!saved.length) return;
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
let refLoadSeq = 0;

// 参考视图当前该显示多少页：挂了对照文献就用它自己的页数，否则用主文档的。
function refTotal() {
  const s = App.state;
  return s.refDoc ? (s.refDocPages || s.refDoc.numPages || 0) : (s.numPages || 0);
}

// 对照文档的标题与「跟随」开关：跨文档时跟随没有意义（两篇页码不对应），禁用并取消。
function updateRefHeader() {
  const s = App.state;
  const cross = !!s.refDoc;
  const nameEl = $('ref-name');
  if (nameEl) {
    nameEl.hidden = !cross;
    nameEl.textContent = cross ? (s.refName || '对照文献') : '';
    nameEl.title = cross ? (s.refPath || '') : '';
  }
  const follow = $('ref-follow');
  if (follow) {
    follow.disabled = cross;
    if (cross) { follow.checked = false; ref.follow = false; }
  }
  const pick = $('ref-pick');
  if (pick) pick.classList.toggle('active', cross);
}

/*
 * 加载对照文献（跨文档分屏）。
 * 与主文档完全独立：自己的 PDFDocumentProxy、自己的页数，不参与标注 / 文本层 / 搜索。
 * path 为空或等于当前文档时退回「同一份的另一页」。
 */
async function loadRefDoc(path, name, opts) {
  const s = App.state;
  const o = opts || {};
  const p = String(path || '');
  if (!p || p === s.filePath) { clearRefDoc(); return true; }
  if (!window.pdfBridge || !window.pdfBridge.openDocPath) return false;
  const my = ++refLoadSeq;
  let payload = null;
  try { payload = await window.pdfBridge.openDocPath({ path: p }); }
  catch (err) { payload = { ok: false, error: err && err.message }; }
  if (my !== refLoadSeq) return false;
  if (!payload || !payload.ok) {
    toast('打不开对照文献：' + ((payload && payload.error) || '未知错误'));
    clearRefDoc();
    return false;
  }
  if (payload.kind === 'rich' || (!payload.data && Array.isArray(payload.pages))) {
    toast('对照视图只支持 PDF');
    clearRefDoc();
    return false;
  }
  const bytes = payload.data instanceof Uint8Array ? payload.data : new Uint8Array(payload.data);
  let doc = null;
  try { doc = await window.pdfjsLib.getDocument({ data: bytes.slice() }).promise; }
  catch (_) {
    if (my === refLoadSeq) { toast('对照文献解析失败'); clearRefDoc(); }
    return false;
  }
  if (my !== refLoadSeq) { try { await doc.destroy(); } catch (_) {} return false; }
  // 旧对照文档的销毁是异步的。await 期间用户可能点了「用当前文档的另一页」或换了别的对照，
  // 代际号会变；等销毁结束必须再校验一次，否则已取消的加载会把文档重新挂回去。
  const old = s.refDoc;
  if (old) { try { await old.destroy(); } catch (_) {} }
  if (my !== refLoadSeq) { try { await doc.destroy(); } catch (_) {} return false; }
  s.refDoc = doc;
  s.refDocPages = doc.numPages;
  s.refPath = p;
  s.refName = String(name || payload.fileName || p.split(/[\\/]/).pop() || '');
  ref.page = Math.min(doc.numPages, Math.max(1, Math.floor(+o.page || 1)));
  s.refPage = ref.page;
  // 标签也要跟着更新 refPage：会话保存读的是标签，只改全局状态会存下旧页码
  const t = currentTab();
  if (t) { t.refPath = s.refPath; t.refName = s.refName; t.refPage = ref.page; }
  updateRefHeader();
  syncSplitPane({ relayout: false });
  scheduleSessionSave();
  return true;
}
App.loadRefDoc = loadRefDoc;

function clearRefDoc() {
  const s = App.state;
  refLoadSeq++;
  if (s.refDoc) { try { s.refDoc.destroy(); } catch (_) {} }
  s.refDoc = null;
  s.refDocPages = 0;
  s.refPath = '';
  s.refName = '';
  const t = currentTab();
  if (t) { t.refPath = ''; t.refName = ''; }
  updateRefHeader();
  if (s.split && hasDoc(s) && s.mode === 'pdf') syncSplitPane({ relayout: false });
  scheduleSessionSave();
}
App.clearRefDoc = clearRefDoc;

// 只释放对照文档的位图 / 解析结果，保留 refPath：关掉分屏后重新打开不用重新挑文献。
function unloadRefDoc() {
  const s = App.state;
  refLoadSeq++;
  if (s.refDoc) { try { s.refDoc.destroy(); } catch (_) {} }
  s.refDoc = null;
  s.refDocPages = 0;
}

// ---------- 对照文献选择器 ----------
// 候选来自主进程的 lib-pdf-list（库里有现存 PDF 的条目），不在渲染层复制一份库状态。
// 每次打开都重新请求：库可能刚导入 / 改名 / 删过条目，缓存一份列表只会显示过期数据。
let refPickerItems = null;
let refPickerError = '';

function closeRefPicker() {
  const modal = $('ref-picker');
  if (modal) modal.hidden = true;
}

function renderRefPickerItems() {
  const list = $('ref-picker-list');
  if (!list) return;
  if (refPickerError) {
    list.innerHTML = '<button class="ref-picker-empty ref-picker-retry" data-ref-retry="1">'
      + escHtml('读取失败：' + refPickerError + '（点击重试）') + '</button>';
    return;
  }
  const qEl = $('ref-picker-q');
  const q = String((qEl && qEl.value) || '').trim().toLowerCase();
  const items = (refPickerItems || []).filter((x) => {
    if (!q) return true;
    return (String(x.title || '') + ' ' + String(x.authors || '')).toLowerCase().indexOf(q) >= 0;
  });
  if (!items.length) {
    list.innerHTML = '<div class="ref-picker-empty">没有匹配的 PDF 条目</div>';
    return;
  }
  list.innerHTML = items.slice(0, 300).map((x) => {
    const meta = [x.authors, x.year].filter(Boolean).join(' · ');
    return '<button class="ref-picker-item" data-ref-path="' + escHtml(x.path) + '"'
      + ' data-ref-title="' + escHtml(x.title) + '">'
      + '<span class="rp-title">' + escHtml(x.title) + '</span>'
      + '<span class="rp-meta">' + escHtml(meta || '—') + '</span>'
      + '</button>';
  }).join('');
}

async function loadRefPickerItems() {
  const list = $('ref-picker-list');
  if (list) list.innerHTML = '<div class="ref-picker-empty">读取中…</div>';
  let r = null;
  try { r = await window.pdfBridge.lib.pdfList(); } catch (err) { r = { ok: false, error: err && err.message }; }
  if (r && r.ok && Array.isArray(r.items)) {
    refPickerItems = r.items;
    refPickerError = '';
  } else {
    refPickerItems = [];
    refPickerError = (r && r.error) || '未知错误';
  }
  renderRefPickerItems();
}

async function openRefPicker() {
  const modal = $('ref-picker');
  if (!modal) return;
  modal.hidden = false;
  const q = $('ref-picker-q');
  if (q) { q.value = ''; setTimeout(() => { try { q.focus(); } catch (_) {} }, 20); }
  await loadRefPickerItems();
}
App.openRefPicker = openRefPicker;


function refSetPage(n, opts) {
  const s = App.state;
  if (!hasDoc(s) || s.mode !== 'pdf') return;
  const total = refTotal();
  if (!total) return;
  ref.page = Math.min(total, Math.max(1, Math.floor(+n || 1)));
  s.refPage = ref.page;
  const t = currentTab();
  if (t) t.refPage = ref.page;
  const inp = $('ref-page');
  if (inp) { inp.value = String(ref.page); inp.max = String(total); }
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
  const doc = s.refDoc || s.pdfDoc;
  const total = refTotal();
  if (!doc || !total) { cv.hidden = true; return; }
  const seq = ++ref.seq;
  const pageNo = Math.min(total, Math.max(1, ref.page));
  let page;
  try { page = await doc.getPage(pageNo); } catch (_) { return; }
  if (seq !== ref.seq) return;
  // 跨文档对照不套用主文档的视图旋转：对方有自己的横竖版式，跟着转只会看着别扭
  const rot = (page.rotate + (s.refDoc ? 0 : normRot(s.rotation))) % 360;
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
  if (cnt) cnt.textContent = '/ ' + total;
  const inp = $('ref-page');
  if (inp) { inp.value = String(pageNo); inp.max = String(total); }
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
  updateRefHeader();
  if (want) {
    // 对照文档还没加载时 refTotal() 拿到的是主文档页数，不能拿它夹取会话里记的对照页：
    // 5 页的对照文献会被夹成主文档的 3 页。真实页数等 loadRefDoc 加载完再夹。
    const pendingCross = !!(s.refPath && s.refPath !== s.filePath && !s.refDoc);
    const total = refTotal();
    ref.page = pendingCross
      ? Math.max(1, Math.floor(s.refPage || 1))
      : Math.min(total, Math.max(1, Math.floor(s.refPage || s.currentPage || 1)));
    s.refPage = ref.page;
    const inp = $('ref-page');
    if (inp) { inp.value = String(ref.page); inp.max = String(total || 1); }
    // 对照文献按需加载：分屏没开时不去读第二份 PDF
    if (pendingCross) {
      // 带上标签 / 会话里记的对照页，重开分屏时回到上次看的那页
      loadRefDoc(s.refPath, s.refName, { page: s.refPage }).catch(() => {});
    } else {
      refRender();   // 读 clientWidth 会强制同步布局，隐藏窗口里也不依赖 rAF
    }
  } else {
    ref.seq++;   // 作废正在跑的参考页渲染
    if (ref.task) { try { ref.task.cancel(); } catch (_) {} ref.task = null; }
    // 关掉分屏就释放对照文档，别让它一直占着内存；refPath 保留，下次打开自动重载
    if (s.refDoc) unloadRefDoc();
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
App.splitState = () => ({
  on: !!App.state.split, page: ref.page, follow: ref.follow,
  visible: !!($('ref-pane') && !$('ref-pane').hidden),
  refPath: App.state.refPath || '', refName: App.state.refName || '',
  refPages: App.state.refDoc ? (App.state.refDocPages || 0) : (App.state.numPages || 0),
});

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
  // v1.6：给「扁平化后可恢复」留一份原始数据。上面那套是**画给 PDF 看**的坐标指令
  // （已转成 PDF 用户空间、便签被摊成文字），拿回来当标注用会丢掉 id、kind、评论结构；
  // 所以另存一份 sidecar 原样数据，由主进程作为附件塞进副本。
  const recoverPages = [];
  for (const [n, shapes] of s.annos) {
    if (!shapes || !shapes.length) continue;
    const el = App.pageEl(n);
    if (!el || !el._pdfPage) continue;
    recoverPages.push({ page: n, shapes });
    const vp = el._pdfPage.getViewport({ scale: 1 });
    const conv = (p) => { const r = vp.convertToPdfPoint(p.x, p.y); return { x: r[0], y: r[1] }; };
    const out = shapes.map((sh) => {
      // 便签在导出副本里按「文字」处理（前缀已加 [便签]）
      const g = { tool: sh.tool === 'note' ? 'text' : sh.tool, color: sh.color, width: sh.width };
      if (sh.tool === 'pen' || sh.tool === 'highlight') g.pts = sh.pts.map(conv);
      else if (sh.tool === 'text' || sh.tool === 'note') { g.at = conv(sh.at); g.size = sh.size; g.text = (sh.tool === 'note' ? '[note] ' : '') + sh.text; }
      else if (sh.tool === 'stamp') {
        // 印章：画布上框是从 at 往右下扩展，PDF 坐标系 y 朝上，所以要把「框的左下角」
        // 换算过去（at.y + 框高），否则导出后会整体偏上半个框。
        const h = (sh.size || 15) * 1.85;
        g.at = conv({ x: sh.at.x, y: sh.at.y + h });
        g.size = sh.size || 15;
        g.text = sh.text || '';
        g.stamp = sh.stamp || '';
      }
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
  return {
    fileName: s.fileName, data: s.sourceBytes, pages, outPath,
    recover: {
      version: 1, app: 'Trove', exportedAt: new Date().toISOString(),
      sourcePath: s.filePath || '', fileName: s.fileName || '',
      pages: recoverPages,
    },
  };
};

// 批注归档（v36）：原文档 + 标注 JSON + 可读清单，一个 zip 带走。
// 与「导出副本」的分工：副本是「给别人的、画好的 PDF」，归档是「给自己的、可恢复的包」。
// outPath 只给探针/自动化用：界面入口不传它，仍走系统保存对话框。
async function doExportArchive(outPath) {
  const s = App.state;
  if (s.mode !== 'pdf' || !s.filePath) { toast('先把文档存到本地，再导出归档'); return; }
  if (!window.pdfBridge || !pdfBridge.exportAnnoArchive) { toast('当前环境不支持归档导出'); return; }
  // 归档读的是磁盘上的 sidecar，而标注改动要等 600ms 才落盘（notifyAnnoChanged）。
  // 不先 flush 就打包，会把「刚改完的那批」漏掉；第一条标注还没保存时甚至导出零批注。
  // 同时记住路径与凭据：flush 是异步的，期间切了文档就不能再按新文档的口径打包。
  // 凭据取「当前已显示文档」那一份（annoDoc），不是全局 loadSeq——下一份可能正在加载。
  const path0 = annoDoc.path || s.filePath;
  const gen0 = annoDoc.gen >= 0 ? annoDoc.gen : loadSeq;
  const sameDoc = () => App.state.filePath === path0 && App.state.mode === 'pdf';

  clearTimeout(App._annoSaveTimer);   // 无论走哪条分支，都别留一个待触发的写盘定时器

  // 先看这次文档的标注有没有读完。这条比「是否损坏」更早成立：
  // 文档刚打开时内存是空的、磁盘上的旧标注还没读回来，此时归档 = 把空写进 sidecar 再打包，
  // 用户的旧标注一次性没了，而主进程的保护查不出来（新写的文件是完全合法的 JSON）。
  const settled = await annoRestoreSettled(path0, gen0);
  if (!settled) { setStatus('文档已切换，已取消归档'); return { ok: false, error: 'doc-changed' }; }
  const st0 = App.state.annoState;
  if (!st0 || (st0.status !== 'ok' && st0.status !== 'missing' && st0.status !== 'broken')) {
    setStatus('归档中止：标注还在读取（等文档打开完再试，避免覆盖已保存的批注）');
    toast('标注还没读完，先让它读一会儿再归档。', 5000);
    return { ok: false, error: 'anno-not-ready' };
  }

  // 再看标注读盘结果，要不要 flush：
  // 读不出来时内存里的「空」不是磁盘上的真相，这一 flush 会把还能人工修复的原文件换成一份合法空数据（R6-01）
  const whyBroken = annoBrokenReason();
  if (whyBroken) {
    const name = (App.state.annoState.annoPath || '标注文件').split(/[\\/]/).pop();
    setStatus('归档失败：标注文件已损坏，未生成归档（原文件已保留）');
    toast(name + ' 读不出来（' + whyBroken + '），已中止归档。原文件仍在原处，可先备份 / 修复后重试。', 7000);
    return { ok: false, broken: true, error: 'anno-broken', annoPath: App.state.annoState.annoPath || '' };
  }

  setStatus('正在保存批注…');
  const flushed = await App.flushAnnos();
  if (flushed === false) {
    setStatus('归档失败：批注没有保存成功，已中止（避免导出不完整的归档）');
    toast('批注保存失败，归档已中止；先解决保存问题再试', 5000);
    return { ok: false, error: 'anno-save-failed' };
  }
  if (!sameDoc()) { setStatus('文档已切换，已取消归档'); return { ok: false, error: 'doc-changed' }; }

  setStatus('正在打包…');
  let res = null;
  try { res = await window.pdfBridge.exportAnnoArchive({ path: path0, outPath: outPath || '' }); } catch (err) { res = { ok: false, error: String((err && err.message) || err) }; }
  // 打包期间可能切走了：结果属于原来那份文档，不要写进新文档的状态栏
  if (!sameDoc()) return { ok: false, error: 'doc-changed' };
  if (res && res.ok) {
    setStatus('已导出归档：' + res.path);
    toast('已打包 ' + res.annotations + ' 条批注（' + Math.max(1, Math.round(res.bytes / 1024)) + ' KB）');
  } else if (res && res.canceled) setStatus('已取消导出归档');
  else if (res && res.broken) {
    setStatus('归档失败：标注文件读不出来，未生成归档');
    toast('标注文件读到问题，归档已中止（原文件保留在原处）', 6000);
  } else setStatus('归档失败：' + ((res && res.error) || '未知错误'));
  return res;   // 探针/命令面板拿得到结果；界面只用 status 与 toast
}
// 探针入口：与界面按钮同一条路径（含 flush 与代际检查），只是能指定落盘位置、不弹对话框
App.exportArchive = doExportArchive;

async function doSave() {
  if (App.state.mode === 'rich') { toast('当前格式不支持导出标注副本'); return; }
  const payload = App.buildExportPayload();
  if (!payload.pages.length) { toast('还没有任何标注'); return; }
  setStatus('导出中…');
  const res = await window.pdfBridge.exportPdf(payload);
  if (res && res.ok) {
    const partial = res.skipped > 0 ? '；有 ' + res.skipped + ' 条标注未导出（可能包含不支持的文字）' : '';
    const recover = res.embedded ? '；副本内嵌了可恢复的批注数据' : '';
    setStatus('已导出副本：' + res.path + partial + recover);
    toast(partial ? '副本已保存，但有 ' + res.skipped + ' 条标注未导出，请核对' : '已保存副本' + (res.embedded ? '（打开副本点「导入 PDF 批注」可完整恢复）' : ''), partial ? 6000 : 2600);
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
    refFollow: $('ref-follow'), refClose: $('ref-close'), refPick: $('ref-pick'), refName: $('ref-name'),
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
    if (ref.follow) refSetPage(Math.min(refTotal() || 1, (App.state.currentPage || 1) + 1));
  });
  // 跨文档对照：选另一篇文献挂到参考视图
  if (E.refPick) E.refPick.addEventListener('click', () => openRefPicker());
  {
    const modal = $('ref-picker');
    const x = $('ref-picker-x'), c = $('ref-picker-close'), same = $('ref-picker-same');
    const q = $('ref-picker-q'), list = $('ref-picker-list');
    if (x) x.addEventListener('click', closeRefPicker);
    if (c) c.addEventListener('click', closeRefPicker);
    if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closeRefPicker(); });
    if (same) same.addEventListener('click', () => {
      closeRefPicker();
      clearRefDoc();
      toast('已退回同一份文档的另一页');
    });
    if (q) q.addEventListener('input', renderRefPickerItems);
    if (list) list.addEventListener('click', async (e) => {
      if (e.target.closest('[data-ref-retry]')) { await loadRefPickerItems(); return; }
      const btn = e.target.closest('[data-ref-path]');
      if (!btn) return;
      const path = btn.getAttribute('data-ref-path') || '';
      const title = btn.getAttribute('data-ref-title') || '';
      closeRefPicker();
      if (path === App.state.filePath) {
        clearRefDoc();
        toast('已切换为同一份文档的另一页');
        return;
      }
      if (!App.state.split) App.setSplitView(true);
      const ok = await loadRefDoc(path, title, { page: 1 });
      if (ok) toast('对照文献：' + (title || '已载入'));
    });
  }

  // Overview 候选：机器没把握时的手动兜底。同一个「比较 → 呈现 → 打开」流程，
  // 只不过「比」在 portal.rankCandidates 里做一次，由人来决定用哪个结果。
  {
    const modal = $('overview-picker');
    const x = $('overview-x'), c = $('overview-close');
    const q = $('overview-q'), list = $('overview-list');
    if (x) x.addEventListener('click', closeOverview);
    if (c) c.addEventListener('click', closeOverview);
    if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closeOverview(); });
    if (q) q.addEventListener('input', renderOverview);
    if (list) list.addEventListener('click', async (e) => {
      if (e.target.closest('[data-ov-retry]')) {
        await Promise.all([loadOverviewCandidates(overviewPending()), loadOverviewLib()]);
        return;
      }
      const btn = e.target.closest('[data-ov-key]');
      if (!btn) return;
      await pickOverview(btn.getAttribute('data-ov-key'), btn.getAttribute('data-ov-title'));
    });
    // Esc 挂在弹窗自己身上：全局那个 keydown 在文献库打开时会提前返回，
    // 而 Overview 也可能从库目录里被调用（阅读器被覆盖层挡着时同样走得到）。
    if (modal) modal.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeOverview(); }
    });
    const hint = $('portal-cand');
    if (hint) hint.addEventListener('click', () => { portalHint(false); openOverview(); });
  }

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
            // 2026-10-29：对照文献也随标签恢复；文件不在了会在分屏打开时提示并退回同文档
            payload.refPath = t.refPath || '';
            payload.refName = t.refName || '';
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
      startAnnoRestore(p);
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
    // 命令面板：Ctrl+K（也认 Ctrl+Shift+P，跟编辑器习惯一致）
    if (e.ctrlKey && !e.altKey && ((e.key === 'k' || e.key === 'K') || (e.shiftKey && (e.key === 'p' || e.key === 'P')))) {
      if (cmd.open) closeCmd(); else openCmd();
      e.preventDefault(); return;
    }
    // 阅读标尺：Ctrl+Shift+L 开/关；开着时 Alt+↑/↓ 调横带高度
    if (e.ctrlKey && e.shiftKey && (e.key === 'l' || e.key === 'L')) {
      setRuler(!ruler.on); e.preventDefault(); return;
    }
    if (ruler.on && e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      ruler.h = Math.max(18, Math.min(90, ruler.h + (e.key === 'ArrowUp' ? -6 : 6)));
      rulerApply(); e.preventDefault(); return;
    }
    // 重排阅读：Ctrl+Shift+R 开/关（Ctrl+R 单独留给之后的刷新语义，不占）
    if (e.ctrlKey && e.shiftKey && (e.key === 'r' || e.key === 'R')) {
      if (reflow.open) closeReflow(); else openReflow();
      e.preventDefault(); return;
    }
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
    if (e.key === 'Escape' && cmd.open) { closeCmd(); e.preventDefault(); return; }
    if (e.key === 'Escape' && refi.open) { closeRefImport(); e.preventDefault(); return; }
    if (e.key === 'Escape' && reflow.open) { closeReflow(); e.preventDefault(); return; }
    if (e.key === 'Escape' && zoomMode.on) { setZoomMode(false); e.preventDefault(); return; }
    if (e.key === 'Escape' && !$('overview-picker').hidden) { closeOverview(); e.preventDefault(); return; }
    // Alt+O：Overview。放在 Alt+← 旁边，与 Portal 的入口同一只手够得着
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'o' || e.key === 'O')) {
      openOverview(); e.preventDefault(); return;
    }
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
      { label: '这条引用的出处：自己挑一篇…', run: () => {
        // 优先用上一次 Smart Jump / Portal 拿到的参考文献条目文本；没有就用选中的文字，
        // 再没有就让弹窗空着 —— 下面那份「库里所有 PDF」本来就够手挑。
        const sel = String((window.getSelection && window.getSelection()) || '').trim();
        openOverview(overviewPending() || sel);
      } },
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

  // 命令面板
  if ($('cmd-input')) {
    $('cmd-input').addEventListener('input', () => { cmd.idx = 0; cmdRender(); });
    $('cmd-input').addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { cmd.idx++; cmdRender(); e.preventDefault(); return; }
      if (e.key === 'ArrowUp') { cmd.idx--; cmdRender(); e.preventDefault(); return; }
      if (e.key === 'Enter') { cmdRun(cmd.idx); e.preventDefault(); return; }
      if (e.key === 'Escape') { closeCmd(); e.preventDefault(); }
    });
  }
  if ($('cmd-list')) {
    $('cmd-list').addEventListener('click', (e) => {
      const row = e.target.closest('[data-cmd-i]');
      if (row) cmdRun(Number(row.dataset.cmdI));
    });
  }
  if ($('cmd-modal')) {
    $('cmd-modal').addEventListener('click', (e) => { if (e.target === $('cmd-modal')) closeCmd(); });
  }

  if ($('btn-archive')) $('btn-archive').addEventListener('click', () => { doExportArchive(); });

  portalLoadPref();
  // 阅读标尺
  rulerInit();
  // 参考文献表批量入库
  refiInit();

  // 重排阅读
  if ($('btn-reflow')) $('btn-reflow').addEventListener('click', () => { openReflow(); });
  if ($('reflow-close')) $('reflow-close').addEventListener('click', () => closeReflow());
  if ($('reflow-size')) $('reflow-size').addEventListener('input', (e) => {
    reflow.size = Number(e.target.value) || 17; reflowApplyStyle(); reflowSavePrefs();
  });
  if ($('reflow-width')) $('reflow-width').addEventListener('input', (e) => {
    reflow.width = Number(e.target.value) || 660; reflowApplyStyle(); reflowSavePrefs();
  });
  if ($('reflow-pages')) $('reflow-pages').addEventListener('dblclick', (e) => {
    const sec = e.target.closest('.rf-page');
    if (sec) reflowJumpTo(Number(sec.dataset.page));
  });

  Anno.init();
  if (window.SelectionUI) window.SelectionUI.init();
  if (window.pdfBridge.onToggleFocusMode) window.pdfBridge.onToggleFocusMode(() => App.setFocusMode());
  if (window.pdfBridge.onExportPagePng) window.pdfBridge.onExportPagePng(() => exportCurrentPagePng());
  initHintBar();
}

// ---------- 命令面板（v36） ----------
// 一个输入框 + 一张命令表：不用记快捷键也能用全功能，记得住的仍然用快捷键。
// 命令表是现算的（每次打开时重建）：里面有几条依赖当前文档状态（有没有打开 PDF、
// 在不在朗读），写死一份静态表会点出「无文档时导出」这种空操作。
const cmd = { open: false, items: [], shown: [], idx: 0 };

function cmdCommands() {
  const s = App.state;
  const hasPdf = !!s.pdfDoc && s.mode === 'pdf';
  const list = [
    { id: 'open', label: '打开文档…', keys: 'Ctrl+O', group: '文件', run: () => { if ($('btn-open')) $('btn-open').click(); } },
    { id: 'library', label: '打开文献库', keys: '', group: '文件', run: () => { if ($('btn-library')) $('btn-library').click(); } },
    { id: 'print', label: '打印当前文档', keys: 'Ctrl+P', group: '文件', run: () => App.printCurrent(), need: hasPdf },
    { id: 'save', label: '导出标注副本（PDF）', keys: '', group: '文件', run: () => { doSave(); }, need: hasPdf },
    { id: 'png', label: '导出当前页为图片', keys: 'Ctrl+Shift+P', group: '文件', run: () => { if (typeof exportCurrentPagePng === 'function') exportCurrentPagePng(); }, need: hasPdf },
    { id: 'archive', label: '导出批注归档（zip：文档 + 标注 + 清单）', keys: '', group: '文件', run: () => { doExportArchive(); }, need: hasPdf },
    // 只在标注文件真的坏掉时出现：主进程会先把原文件另存为 *.broken-<时间戳>.json，再写新的
    { id: 'rebuild-anno', label: '重建标注文件（损坏时用；原文件另存一份）', keys: '', group: '文件', run: () => { App.rebuildAnnosFile(); }, need: hasPdf && !!annoBrokenReason() },
    { id: 'refimport', label: '参考文献表批量入库…', keys: '', group: '文献库', run: () => { openRefImport(); }, need: hasPdf },

    { id: 'search', label: '文档内搜索', keys: 'Ctrl+F', group: '浏览', run: () => { const b = $('search-box'); if (b) { b.focus(); b.select(); } } },
    { id: 'goto', label: '跳到指定页…', keys: '', group: '浏览', run: () => {
      const n = window.prompt('跳到第几页？（共 ' + (s.numPages || 0) + ' 页）', String(s.currentPage || 1));
      if (n == null) return;
      const page = parseInt(n, 10);
      if (!page || page < 1 || page > (s.numPages || 1)) { toast('页码超出范围'); return; }
      scrollToPage(page, false, true);
    }, need: hasPdf },
    { id: 'prev', label: '上一页', keys: 'PgUp', group: '浏览', run: () => { if ($('btn-prev')) $('btn-prev').click(); }, need: hasPdf },
    { id: 'next', label: '下一页', keys: 'PgDn', group: '浏览', run: () => { if ($('btn-next')) $('btn-next').click(); }, need: hasPdf },
    { id: 'scroll', label: '视图：连续滚动', keys: '', group: '浏览', run: () => { App.setViewMode('scroll'); } },
    { id: 'page', label: '视图：单页翻页', keys: '', group: '浏览', run: () => { App.setViewMode('page'); } },
    { id: 'spread', label: '视图：双页对开', keys: 'Ctrl+Shift+D', group: '浏览', run: () => { App.setViewMode('spread'); } },
    { id: 'sidebar', label: '侧栏（目录 / 缩略图 / 批注）', keys: '', group: '浏览', run: () => { if ($('btn-sidebar')) $('btn-sidebar').click(); } },
    { id: 'zoomin', label: '放大', keys: 'Ctrl+=', group: '浏览', run: () => { if ($('btn-zoom-in')) $('btn-zoom-in').click(); } },
    { id: 'zoomout', label: '缩小', keys: 'Ctrl+-', group: '浏览', run: () => { if ($('btn-zoom-out')) $('btn-zoom-out').click(); } },
    { id: 'rotl', label: '逆时针旋转 90°', keys: 'Ctrl+[', group: '浏览', run: () => App.rotateView(-90), need: hasPdf },
    { id: 'rotr', label: '顺时针旋转 90°', keys: 'Ctrl+]', group: '浏览', run: () => App.rotateView(90), need: hasPdf },

    { id: 'reflow', label: '重排阅读（可调字号栏宽）', keys: 'Ctrl+Shift+R', group: '阅读', run: () => { openReflow(); }, need: hasPdf },
    { id: 'ruler', label: (ruler.on ? '关闭阅读标尺' : '打开阅读标尺'), keys: 'Ctrl+Shift+L', group: '阅读', run: () => { setRuler(!ruler.on); } },
    { id: 'focus', label: '专注阅读模式', keys: 'F11', group: '阅读', run: () => App.setFocusMode() },
    { id: 'speak', label: '朗读当前页', keys: '', group: '阅读', run: () => App.speakToggle(), need: hasPdf },
    { id: 'speakstop', label: '停止朗读', keys: '', group: '阅读', run: () => App.speakStop(), need: hasPdf },
    { id: 'split', label: '分屏参考视图', keys: '', group: '阅读', run: () => { if ($('btn-split')) $('btn-split').click(); }, need: hasPdf },
    { id: 'overview', label: '候选出处：手动挑一篇（Overview）', keys: 'Alt+O', group: '阅读', run: () => { openOverview(); } },
    { id: 'portal', label: (portalEnabled() ? '关闭引用跟随（Portal）' : '打开引用跟随（Portal）'), keys: '', group: '阅读', run: () => {
      portal.off = portalEnabled();
      if (window.pdfBridge && window.pdfBridge.setSettings) window.pdfBridge.setSettings({ portal: !portal.off });
      toast(portal.off ? '引用跟随已关闭' : '引用跟随已打开');
    } },

    { id: 'tool-select', label: '工具：选择 / 浏览', keys: 'Esc', group: '标注', run: () => Anno.setTool('select'), need: hasPdf },
    { id: 'tool-pen', label: '工具：画笔', keys: 'P', group: '标注', run: () => Anno.setTool('pen'), need: hasPdf },
    { id: 'tool-hl', label: '工具：荧光笔', keys: 'H', group: '标注', run: () => Anno.setTool('highlight'), need: hasPdf },
    { id: 'tool-text', label: '工具：文字', keys: 'T', group: '标注', run: () => Anno.setTool('text'), need: hasPdf },
    { id: 'tool-note', label: '工具：便签', keys: 'N', group: '标注', run: () => Anno.setTool('note'), need: hasPdf },
    { id: 'tool-stamp', label: '工具：印章', keys: 'S', group: '标注', run: () => Anno.setTool('stamp'), need: hasPdf },
    { id: 'undo', label: '撤销', keys: 'Ctrl+Z', group: '标注', run: () => Anno.undo(), need: hasPdf },
    { id: 'clear', label: '清除本页标注', keys: '', group: '标注', run: () => { if ($('btn-clear-page')) $('btn-clear-page').click(); }, need: hasPdf },
    { id: 'bookmark', label: '本页加 / 删书签', keys: 'B', group: '标注', run: () => { if (typeof bookmarkToggle === 'function') bookmarkToggle(App.state.currentPage); }, need: hasPdf },

    { id: 'theme', label: '切换深色 / 浅色', keys: '', group: '外观', run: () => {
      const dark = document.body.classList.contains('theme-dark');
      const next = dark ? 'light' : 'dark';
      applyTheme(next);
      if (window.pdfBridge && window.pdfBridge.setSettings) window.pdfBridge.setSettings({ theme: next });
      toast('已切换到' + (next === 'dark' ? '深色' : '浅色') + '主题');
    } },

    // 帮助：说明写在 src/help-content.js；这里只留最常用的三个入口，
    // 具体某条功能可以在指南里搜（Help 打开后输入框自动聚焦）。
    { id: 'help', label: '使用指南（所有功能怎么用）', keys: 'F1', group: '帮助', run: () => { if (window.Help) window.Help.open(); } },
    { id: 'help-keys', label: '快捷键速查', keys: '', group: '帮助', run: () => { if (window.Help) window.Help.openTopic('shortcuts'); } },
    { id: 'help-trouble', label: '常见问题排查', keys: '', group: '帮助', run: () => { if (window.Help) window.Help.openTopic('trouble'); } },
    { id: 'help-limits', label: '当前版本做不到什么', keys: '', group: '帮助', run: () => { if (window.Help) window.Help.openTopic('limits'); } },
  ];
  return list.filter((c) => c.need !== false);
}

function cmdScore(q, text) {
  const s = String(text || '').toLowerCase();
  const needle = String(q || '').toLowerCase();
  if (!needle) return 1;
  if (s.indexOf(needle) >= 0) return 100 - s.indexOf(needle) * 0.1;
  // 子序列匹配：允许「导副」命中「导出标注副本」，避免拼音/跳字就打不着
  let si = 0, gap = 0, hit = 0;
  for (const ch of needle) {
    const at = s.indexOf(ch, si);
    if (at < 0) return 0;
    gap += at - si;
    si = at + 1;
    hit++;
  }
  return Math.max(1, 40 - gap * 0.6 - (s.length - hit) * 0.05);
}

function cmdRender() {
  const box = $('cmd-list');
  const inp = $('cmd-input');
  if (!box || !inp) return;
  const q = inp.value.trim();
  const scored = cmd.items.map((c) => ({ c, sc: Math.max(cmdScore(q, c.label), cmdScore(q, c.group + ' ' + c.label) * 0.6) }))
    .filter((x) => x.sc > 0)
    .sort((a, b) => b.sc - a.sc);
  cmd.shown = scored.slice(0, 14).map((x) => x.c);
  if (!cmd.shown.length) {
    box.innerHTML = '<div class="cmd-empty">没有匹配的命令。试试「重排」「标尺」「导出」「标注」。</div>';
    return;
  }
  if (cmd.idx >= cmd.shown.length) cmd.idx = 0;
  if (cmd.idx < 0) cmd.idx = cmd.shown.length - 1;
  box.innerHTML = cmd.shown.map((c, i) => (
    '<button class="cmd-row' + (i === cmd.idx ? ' active' : '') + '" data-cmd-i="' + i + '">' +
      '<span class="cmd-group">' + escHtml(c.group || '') + '</span>' +
      '<span class="cmd-label">' + escHtml(c.label) + '</span>' +
      '<span class="cmd-keys">' + escHtml(c.keys || '') + '</span>' +
    '</button>'
  )).join('');
}

function openCmd() {
  if (cmd.open) return;
  const box = $('cmd-modal');
  const inp = $('cmd-input');
  if (!box || !inp) return;
  cmd.open = true;
  cmd.items = cmdCommands();
  cmd.idx = 0;
  inp.value = '';
  box.hidden = false;
  cmdRender();
  setTimeout(() => inp.focus(), 10);
}

function closeCmd() {
  const box = $('cmd-modal');
  if (!box) return;
  cmd.open = false;
  box.hidden = true;
}

function cmdRun(i) {
  const c = cmd.shown[i];
  if (!c) return;
  closeCmd();
  // 先关面板再执行：命令里可能有 prompt / 对话框，面板压在上面会让人以为没反应
  setTimeout(() => {
    try { c.run(); } catch (err) { toast('命令执行失败：' + String((err && err.message) || err)); }
  }, 0);
}

// ---------- 阅读标尺（v36） ----------
// 一条跟随鼠标的半透明横带：看长段落时眼睛有个「轨道」，不容易串到下一行。
// 实现刻意不画在页面 canvas 上（那会跟着缩放、旋转、重绘一起重算），
// 而是 fixed 定位的一条 DOM，坐标用 clientY —— 屏幕坐标，和缩放无关。
const ruler = { on: false, h: 38, el: null, dragging: false };

function rulerEnsure() {
  if (ruler.el) return ruler.el;
  const d = document.createElement('div');
  d.id = 'read-ruler';
  d.hidden = true;
  // 标尺本身挡鼠标会让「点击页面」失效，所以永远 pointer-events:none，
  // 高度调节换成快捷键（Alt+↑/↓）。
  document.body.appendChild(d);
  ruler.el = d;
  return d;
}

function rulerApply() {
  const el = rulerEnsure();
  el.style.height = ruler.h + 'px';
  el.hidden = !ruler.on;
  document.body.classList.toggle('ruler-on', ruler.on);
  const btn = $('btn-ruler');
  if (btn) btn.classList.toggle('active', ruler.on);
}

function rulerMove(clientY) {
  if (!ruler.on) return;
  const el = rulerEnsure();
  // 横带中心略低于指针：指针通常在「正在读的那一行」上，带子压住它和下一行
  const top = clientY - ruler.h * 0.38;
  el.style.transform = 'translateY(' + Math.round(top) + 'px)';
}

function setRuler(on, opts) {
  ruler.on = !!on;
  rulerApply();
  if (!ruler.on) {
    const el = rulerEnsure();
    el.style.transform = 'translateY(-999px)';
  }
  if (!(opts && opts.silent) && window.pdfBridge && window.pdfBridge.setSettings) {
    try { window.pdfBridge.setSettings({ ruler: ruler.on }); } catch (_) {}
  }
}

function rulerInit() {
  if (!document.getElementById('viewer')) return;
  document.addEventListener('mousemove', (e) => {
    if (!ruler.on) return;
    // 只在正文区显示：工具栏、侧栏、弹窗上都不该出现一条横带
    const t = e.target;
    const inside = t && t.closest && t.closest('#viewer, #reflow-body');
    const el = rulerEnsure();
    if (!inside) { el.style.opacity = '0'; return; }
    el.style.opacity = '';
    rulerMove(e.clientY);
  }, { passive: true });
  document.addEventListener('mouseleave', () => {
    if (ruler.el) ruler.el.style.opacity = '0';
  });
  // 窗口滚动时横带要跟着内容走：不重算位置的话它会停在屏幕原处，看起来像「标尺没跟上」
  document.addEventListener('scroll', () => {
    if (ruler.on && ruler.el) ruler.el.style.opacity = '0';
  }, { passive: true, capture: true });

  if ($('btn-ruler')) $('btn-ruler').addEventListener('click', () => {
    setRuler(!ruler.on);
    if (ruler.on) toast('阅读标尺已开：Alt+↑/↓ 调高度');
  });

  // 启动时按设置恢复（设置读不到就当没开，不要因为一个装饰性功能挡住启动）
  try {
    const p = window.pdfBridge && window.pdfBridge.getSettings ? window.pdfBridge.getSettings() : null;
    Promise.resolve(p).then((st) => {
      if (st && st.ruler) { ruler.on = true; rulerApply(); }
    }).catch(() => {});
  } catch (_) {}
}

// ---------- 参考文献表批量入库（v36）的事件绑定 ----------
function refiInit() {
  const btn = $('btn-refimport');
  if (btn) btn.addEventListener('click', () => openRefImport());
  const x = $('refi-x');
  if (x) x.addEventListener('click', closeRefImport);
  const cancel = $('refi-cancel');
  if (cancel) cancel.addEventListener('click', closeRefImport);
  const go = $('refi-go');
  if (go) go.addEventListener('click', () => { refiGo(); });
  const all = $('refi-all');
  if (all) all.addEventListener('click', () => {
    // 「全选」只勾「认得出」的：切错的残句进来只会污染库，用户真要也可以单条勾
    for (const e of refi.entries) if (e.confidence !== 'weak') refi.picked.add(e.no);
    refiRender();
  });
  const none = $('refi-none');
  if (none) none.addEventListener('click', () => { refi.picked.clear(); refiRender(); });
  const list = $('refi-list');
  if (list) {
    // 只绑 change：点行本身也落在 label 上，浏览器会把点击转给 checkbox，不必再绑 click
    list.addEventListener('change', (e) => {
      const cb = e.target.closest && e.target.closest('[data-refi-pick]');
      if (!cb) return;
      const no = Number(cb.getAttribute('data-refi-pick'));
      if (cb.checked) refi.picked.add(no); else refi.picked.delete(no);
      refiRender();
    });
  }
  // 联网补全的进度：只改状态行，不重绘列表（重绘会把用户正在看的滚动位置打回顶部）
  try {
    if (window.pdfBridge && window.pdfBridge.onRefImportProgress) {
      window.pdfBridge.onRefImportProgress((msg) => {
        if (!refi.open || !msg) return;
        refiSetStatus('正在补全题录 ' + msg.done + '/' + msg.total + '：' + (msg.title || ''));
      });
    }
  } catch (_) {}
}

// ---------- 重排阅读（v36） ----------
// 纯文本层的段落实现在 src/reflow.js；这里只做三件事：按页取文本项、拼 DOM、记住字号栏宽。
// 取文本项直接用 state.pdfDoc.getPage，不依赖页面是否已渲染（没滚到的页也能重排）。
const reflow = { open: false, size: 17, width: 660, busy: false, pages: 0, scrollAt: 0, token: 0 };

function reflowLoadPrefs() {
  try {
    const o = JSON.parse(localStorage.getItem('trove.reflow') || '{}');
    if (Number(o.size) >= 13 && Number(o.size) <= 24) reflow.size = Number(o.size);
    if (Number(o.width) >= 420 && Number(o.width) <= 900) reflow.width = Number(o.width);
  } catch (_) {}
}
function reflowSavePrefs() {
  try { localStorage.setItem('trove.reflow', JSON.stringify({ size: reflow.size, width: reflow.width })); } catch (_) {}
}

// 取哪份文档由调用方给死：不能每页都从 App.state.pdfDoc 现取——
// 重排是长任务，中途切文档后全局早已换成新文档，旧任务会按旧页数读新页。
async function reflowPageData(doc, n) {
  const page = await doc.getPage(n);
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const items = [];
  for (const item of (tc && tc.items) || []) {
    if (!item || !item.str) continue;
    const tx = window.pdfjsLib.Util.transform(vp.transform, item.transform);
    const fh = Math.hypot(tx[2], tx[3]);
    if (!fh || !isFinite(fh)) continue;
    items.push({ str: item.str, x: tx[4], y: tx[5], w: Math.max(2, item.width || item.str.length * fh * 0.5), fh });
  }
  return { page: n, width: vp.width, items };
}

function reflowBlocksHtml(blocks) {
  const out = [];
  let listOpen = false;
  for (const b of blocks) {
    if (b.type === 'li') {
      if (!listOpen) { out.push('<ul class="rf-list">'); listOpen = true; }
      out.push('<li>' + escHtml(b.text) + '</li>');
      continue;
    }
    if (listOpen) { out.push('</ul>'); listOpen = false; }
    if (b.type === 'h2' || b.type === 'h3') out.push('<' + b.type + '>' + escHtml(b.text) + '</' + b.type + '>');
    else out.push('<p>' + escHtml(b.text) + '</p>');
  }
  if (listOpen) out.push('</ul>');
  return out.join('');
}

function reflowApplyStyle() {
  const body = $('reflow-body');
  const pages = $('reflow-pages');
  if (!body || !pages) return;
  body.style.setProperty('--rf-size', reflow.size + 'px');
  body.style.setProperty('--rf-width', reflow.width + 'px');
  if ($('reflow-size')) $('reflow-size').value = String(reflow.size);
  if ($('reflow-width')) $('reflow-width').value = String(reflow.width);
  if ($('reflow-size-val')) $('reflow-size-val').textContent = String(reflow.size);
  if ($('reflow-width-val')) $('reflow-width-val').textContent = String(reflow.width);
}

// 重排是长任务（最多 400 页），必须绑死「打开时那份文档」：
// 只看 reflow.open 不够——关掉再打开、切到别的 PDF，旧循环都还以为什么都没变，
// 于是按 A 的页数去读 B 的页（B 的第 1 页干脆没人读），标题还挂着 A。
// 凭据 = token（每次打开/关闭都换）+ 文档对象 + 文件路径 + 加载代际，四样全对上才算活着。
function reflowAlive(token, doc, gen, path0) {
  return reflow.open && reflow.token === token &&
    loadSeq === gen && App.state.pdfDoc === doc && App.state.filePath === path0;
}

// 文档切换 / 关闭时调用：作废在跑的循环并收起覆盖层。
// 不动 scrollAt——新文档要按自己的位置重新定位，不该跳回上一篇的滚动位置。
function reflowCancel() {
  reflow.token++;
  reflow.busy = false;
  reflow.open = false;
  const box = $('reflow-view');
  if (box) box.hidden = true;
  if ($('reflow-pages')) $('reflow-pages').innerHTML = '';
}

async function openReflow() {
  const s = App.state;
  if (!s.pdfDoc || s.mode !== 'pdf') {
    toast(s.mode === 'rich' ? '重排阅读只适用于 PDF（当前是转换后的文档）' : '先打开一份 PDF');
    return;
  }
  if (reflow.busy) return;
  // 打开那一刻就把凭据固定下来，之后所有 await 回来都对照它
  const doc0 = s.pdfDoc;
  const path0 = s.filePath;
  const gen0 = loadSeq;
  const token = ++reflow.token;
  const alive = () => reflowAlive(token, doc0, gen0, path0);

  reflowLoadPrefs();
  reflow.open = true;
  reflow.busy = true;
  reflow.scrollAt = window.scrollY || 0;
  const box = $('reflow-view');
  const pagesBox = $('reflow-pages');
  const empty = $('reflow-empty');
  box.hidden = false;
  pagesBox.innerHTML = '';
  empty.hidden = true;
  reflowApplyStyle();
  if ($('reflow-title')) $('reflow-title').textContent = '重排阅读 · ' + (s.fileName || '未命名');
  const note = $('reflow-note');
  const cap = Math.min(s.numPages || 0, 400);
  if (!cap) { note.textContent = '这份文档没有可读页'; reflow.busy = false; return; }

  const collected = [];
  try {
    for (let n = 1; n <= cap; n++) {
      if (!alive()) return;   // 中途关了 / 换了文档：后面的页不读，也不许再写 DOM
      if (note) note.textContent = '正在读文字 ' + n + ' / ' + cap + '…';
      let data = null;
      try { data = await reflowPageData(doc0, n); } catch (_) { data = null; }
      if (!alive()) return;   // await 期间切走了：这页属于旧文档，丢掉
      if (data && data.items.length) collected.push(data);
      // 每 8 页让出一次主线程，滚动条和关闭按钮才不算卡死
      if (n % 8 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    if (!alive()) return;
    if (note) note.textContent = '正在排版…';
    const doc = Reflow.reflowDoc(collected, {});
    if (!doc.length) {
      empty.hidden = false;
      empty.textContent = '这些页面里没有可提取的文字（可能是扫描件）。扫描件要靠 OCR，本工具不做。';
    } else {
      pagesBox.innerHTML = doc.map((pg) => (
        '<section class="rf-page" data-page="' + pg.page + '" title="双击回到 PDF 第 ' + pg.page + ' 页">' +
        reflowBlocksHtml(pg.blocks) +
        '<div class="rf-pagemark">第 ' + pg.page + ' 页</div>' +
        '</section>'
      )).join('');
    }
    if (note) {
      const blocks = doc.reduce((n, p) => n + p.blocks.length, 0);
      note.textContent = doc.length + ' 页 · ' + blocks + ' 段';
      if (cap < (s.numPages || 0)) note.textContent += '（只重排了前 ' + cap + ' 页）';
    }
  } catch (err) {
    if (alive() && note) note.textContent = '重排出错：' + String((err && err.message) || err);
  } finally {
    // 只有自己仍是当前任务才收尾：否则会把新任务的 busy 抹掉、或把旧文档的页码滚给新文档
    if (alive()) {
      reflow.busy = false;
      reflow.pages = collected.length;
      // 回到打开时所在的页，省得再从第 1 页找
      const cur = String(s.currentPage || 1);
      const hit = pagesBox.querySelector('.rf-page[data-page="' + cur + '"]');
      if (hit && hit.scrollIntoView) hit.scrollIntoView({ block: 'start' });
      else if ($('reflow-body')) $('reflow-body').scrollTop = 0;
    }
  }
}

function closeReflow() {
  const box = $('reflow-view');
  if (!box) return;
  // 关掉同时作废在跑的循环；busy 一并清掉，否则下次打开会被旧任务一直挡着
  reflowCancel();
  try { window.scrollTo(0, reflow.scrollAt || 0); } catch (_) {}
}

function reflowJumpTo(page) {
  const n = Math.max(1, Math.min(App.state.numPages || 1, page | 0));
  closeReflow();
  scrollToPage(n, false, true);
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
