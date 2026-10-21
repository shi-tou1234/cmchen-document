const { app, BrowserWindow, Menu, ipcMain, dialog, shell, clipboard, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const settings = require('./settings.js');
const fulltext = require('./fulltext.js');
const formats = require('./formats.js');
const metadata = require('./metadata.js');
const pdfmeta = require('./pdfmeta.js');

let win = null;

// ---------- 单实例锁（v11） ----------
// 探针/冒烟模式跳过：测试经常并发启动多个隔离实例，不能互相顶掉。
const TEST_MODE = !!(process.env.SMOKE_PDF || process.env.PDFREADER_PROBE
  || process.env.PDFREADER_LIBUI || process.env.PDFREADER_TEST);
let hasLock = true;
if (!TEST_MODE) {
  hasLock = app.requestSingleInstanceLock();
  if (!hasLock) {
    app.quit();
  } else {
    app.on('second-instance', (_e, argv) => {
      if (win) {
        // 测试时窗口是隐藏的，不要因为第二个实例把它弹出来
        if (!process.env.PDFREADER_HIDDEN) {
          if (win.isMinimized()) win.restore();
          win.show();
          win.focus();
        }
      }
      const p = pdfArgFrom(argv);
      if (p) openFromPath(p);
    });
  }
}

// ---------- 设置 / 存储位置（v11） ----------
const USER_DATA = app.getPath('userData');
settings.init(USER_DATA);
let appSettings = settings.get();

function currentDataDir() {
  // 测试用 PDFREADER_DATA_DIR 可把索引/备份也钉到临时目录；否则跟随设置。
  return process.env.PDFREADER_DATA_DIR || appSettings.dataDir || USER_DATA;
}

// ---------- 记住窗口状态（尺寸/位置/上次打开目录），无需额外依赖 ----------
const stateFile = path.join(USER_DATA, 'window-state.json');
function loadWindowState() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')) || {}; } catch (_) { return {}; }
}
function saveWindowState(s) {
  try { fs.writeFileSync(stateFile, JSON.stringify(s)); } catch (_) {}
}
let appState = loadWindowState();

// ---------- 本地文献库（JSON 索引，零原生依赖） ----------
const library = require('./library.js');
library.init(currentDataDir());
fulltext.init(currentDataDir());

// ---------- 最近打开 + 每文件页码 ----------
const MAX_RECENT = 8;
const recentList = () => (Array.isArray(appState.recent) ? appState.recent : []);
function lastPageFor(filePath) {
  const it = recentList().find((r) => r.path === filePath);
  return it && Number.isFinite(it.page) ? it.page : 0;
}
function rememberRecent(filePath, page) {
  // 记录归并：文件若已是库条目，页码由库统一记（pageForPath 库优先），
  // 不再往「最近打开」里塞一份，避免同一路径两处各存一份页码。
  if (library.findItemByPath(filePath)) return;
  const list = recentList().filter((r) => r.path !== filePath);
  list.unshift({ path: filePath, name: path.basename(filePath), page: Number.isFinite(page) ? page : 0 });
  appState.recent = list.slice(0, MAX_RECENT);
  appState.lastDir = path.dirname(filePath);
  saveWindowState(appState);
  rebuildMenu();
}
// 页码来源统一：库条目优先，其次「最近打开」。这样从库里打开、双击、最近列表都恢复到同一页。
function pageForPath(filePath) {
  const li = filePath && library.findItemByPath(filePath);
  if (li && li.page) return li.page;
  return lastPageFor(filePath) || 0;
}

// 只更新已存在条目的页码：翻阅时高频调用，不重排列表、不重建菜单
function recordPage(filePath, page) {
  if (!filePath || !Number.isFinite(page)) return;
  const it = recentList().find((r) => r.path === filePath);
  if (it && it.page !== page) { it.page = page; saveWindowState(appState); }
  // 同步到库条目（若该文件属于某个条目）
  const li = library.findItemByPath(filePath);
  if (li && li.page !== page) library.setPageByKey(li.key, page);
}

// 读出字节 + 附上该文件上次的页码，供渲染进程直接落到上次位置
function readPdfPayload(filePath, extra) {
  try {
    const buf = fs.readFileSync(filePath);
    return Object.assign({
      ok: true, filePath, fileName: path.basename(filePath),
      startPage: pageForPath(filePath), data: new Uint8Array(buf),
    }, extra || {});
  } catch (err) {
    return { ok: false, filePath, error: String(err && err.message ? err.message : err) };
  }
}

// 从命令行参数里取 PDF 路径（双击文件 / 右键「打开方式」都会走到这里）
function pdfArgFrom(argvList) {
  for (const a of argvList || []) {
    if (typeof a === 'string' && /\.pdf$/i.test(a)) {
      const abs = path.resolve(a);
      if (fs.existsSync(abs)) return abs;
    }
  }
  return null;
}

// 窗口可能还没加载完（冷启动带文件参数时一定会），所以未就绪时排队，等 did-finish-load 再投
let pendingOpen = null;
function openFromPath(filePath) {
  if (!filePath) return;
  const payload = readPdfPayload(filePath);
  if (!payload.ok) { dialog.showErrorBox('打开失败', payload.error || filePath); return; }
  rememberRecent(filePath, payload.startPage || 1);
  if (win && win.__loaded) {
    win.webContents.send('pdf-opened', payload);
  } else {
    // 未就绪：交给 createWindow 里注册的 did-finish-load 统一投递，避免两处重复发
    pendingOpen = payload;
  }
}

// 记住的窗口位置可能已经不在任何显示器上（副屏拔掉了、分辨率改了），
// 那样窗口会开在屏幕外，看起来像「双击没反应」。这里校验一次，不在就交给系统居中。
function safeWindowPos(x, y, w, h) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { x: undefined, y: undefined };
  try {
    const displays = screen.getAllDisplays();
    for (const d of displays) {
      const a = d.workArea || d.bounds;
      // 至少露出一块（40px）算「还在屏幕上」
      if (x < a.x + a.width - 40 && x + w > a.x + 40 && y < a.y + a.height - 40 && y + h > a.y + 40) {
        return { x, y };
      }
    }
  } catch (_) { /* screen 还没就绪就按原样来 */ }
  return { x: undefined, y: undefined };
}

function createWindow(opts = {}) {
  // 默认给宽一点：文献库是表格式布局，1000px 宽会把列挤没
  const w = appState.width || 1180;
  const h = appState.height || 780;
  const pos = safeWindowPos(appState.x, appState.y, w, h);
  win = new BrowserWindow({
    width: w,
    height: h,
    x: pos.x,
    y: pos.y,
    minWidth: 640,
    minHeight: 400,
    title: 'PDF Reader',
    backgroundColor: '#ececec',
    icon: path.join(__dirname, '..', 'assets', 'icon-256.png'),
    show: opts.show !== false,
    webPreferences: {
      // 安全底线：渲染进程拿不到 Node 能力，本地文件读取全部走 preload/IPC
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      // 给 preload 一个明确标记：这是主应用窗口，而不是 test-pen 等独立测试窗口。
      // 库界面据此决定是否在启动时自动展开，避免测试窗口去调不存在的 lib-* IPC。
      additionalArguments: ['--pdfreader-app'],
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 冷启动带文件参数时，命令行比页面就绪更早，这里统一补投
  win.webContents.on('did-finish-load', () => {
    win.__loaded = true;
    if (pendingOpen) { win.webContents.send('pdf-opened', pendingOpen); pendingOpen = null; }
  });

  // 冒烟模式：隐藏窗口里自动加载样本 PDF，渲染完成后回报结果并退出。
  // 走与真实打开完全相同的一条路（readPdfPayload + rememberRecent），
  // 这样「记住页码 / 恢复页码」能被第二次启动真正验证，而不是只测个函数。
  if (process.env.SMOKE_PDF) {
    const pdfPath = process.env.SMOKE_PDF;
    win.webContents.once('did-finish-load', () => {
      const payload = readPdfPayload(pdfPath, { smoke: !process.env.SMOKE_SHOT });
      if (!payload.ok) {
        console.error('[smoke] read failed: ' + payload.error);
        app.exit(1);
        return;
      }
      rememberRecent(pdfPath, payload.startPage || 1);
      win.webContents.send('pdf-opened', payload);

      // 截图模式：等渲染稳定后抓一帧写盘，用于离线核对 UI 观感
      if (process.env.SMOKE_SHOT) {
        setTimeout(async () => {
          try {
            // 可选：展开「绘制 ▾」下拉，核对分组浮层
            if (process.env.SMOKE_OPEN_DRAW) {
              await win.webContents.executeJavaScript(
                "(function(){var b=document.getElementById('draw-btn');if(b)b.click();return 1;})()");
              await new Promise((r) => setTimeout(r, 120));
            }
            const img = await win.capturePage();
            fs.writeFileSync(process.env.SMOKE_SHOT, img.toPNG());
            console.log('[shot] written ' + process.env.SMOKE_SHOT);
          } catch (e) { console.error('[shot] fail', e); }
          app.exit(0);
        }, 1000);
      }
    });
  }

  win.on('closed', () => { win = null; });
  // 关闭时保存窗口边界，下次启动恢复
  win.on('close', () => {
    if (!win.isMinimized() && !win.isMaximized()) {
      const b = win.getBounds();
      Object.assign(appState, { width: b.width, height: b.height, x: b.x, y: b.y });
    }
    saveWindowState(appState);
  });
}

// 渲染进程通知更新窗口标题（打开/拖拽文件后）
ipcMain.on('set-title', (_e, title) => {
  if (win) win.setTitle(title ? title + ' - PDF Reader' : 'PDF Reader');
});

ipcMain.on('smoke-result', (_e, payload) => {
  console.log('[smoke-result] ' + JSON.stringify(payload));
  app.exit(payload && payload.ok ? 0 : 2);
});

// 弹出文件对话框，读取 PDF 字节，以 Uint8Array 结构克隆回渲染进程
async function openPdfViaDialog() {
  if (!win) return { ok: false };
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '打开 PDF',
    filters: [{ name: 'PDF 文件', extensions: ['pdf'] }],
    properties: ['openFile'],
    defaultPath: appState.lastDir || undefined,
  });
  if (canceled || filePaths.length === 0) return { ok: false };

  const filePath = filePaths[0];
  const payload = readPdfPayload(filePath);
  if (payload.ok) {
    rememberRecent(filePath, payload.startPage || 1);
    if (!win.__loaded) pendingOpen = payload; // 罕见：对话框期间窗口被重载
  } else {
    dialog.showErrorBox('打开失败', payload.error || filePath);
  }
  return payload;
}

ipcMain.handle('open-pdf-dialog', () => openPdfViaDialog());

// 渲染进程上报当前页码（按文件记住，下次打开回到同一位置）
ipcMain.on('set-page', (_e, info) => { if (info) recordPage(info.path, info.page); });

// 拖拽打开的文件也要进「最近打开」；返回该文件上次读到的页码，交给渲染层决定落到哪
ipcMain.handle('note-recent', (_e, info) => {
  if (!info || !info.path) return { page: 1 };
  const page = pageForPath(info.path) || 1;
  rememberRecent(info.path, page);
  return { page };
});

// ---------- 数据目录 / 备份恢复 / 导入导出（v11-v12） ----------
function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.renameSync(tmp, file);
  } catch (_) { fs.writeFileSync(file, text, 'utf8'); }
  try { fs.unlinkSync(tmp); } catch (_) {}
}

function annoDir() { return path.join(USER_DATA, 'annotations'); }

function readAnnotationBundle() {
  const out = [];
  try {
    const dir = annoDir();
    for (const f of fs.readdirSync(dir)) {
      if (!/\.json$/i.test(f)) continue;
      try {
        let raw = fs.readFileSync(path.join(dir, f), 'utf8');
        if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
        out.push({ name: f, data: JSON.parse(raw) });
      } catch (_) {}
    }
  } catch (_) {}
  return out;
}

function applyAnnotationBundle(list) {
  const dir = annoDir();
  fs.mkdirSync(dir, { recursive: true });
  // 恢复是“替换”语义：先清掉现有 .json，再写回备份里的标注；备份前已自动留过当前快照。
  try {
    for (const f of fs.readdirSync(dir)) if (/\.json$/i.test(f)) fs.unlinkSync(path.join(dir, f));
  } catch (_) {}
  let n = 0;
  for (const entry of list || []) {
    if (!entry || !entry.data) continue;
    const name = path.basename(String(entry.name || ''));
    if (!/^[a-f0-9]{8,64}\.json$/i.test(name)) continue;
    try { atomicWrite(path.join(dir, name), JSON.stringify(entry.data)); n++; } catch (_) {}
  }
  return n;
}

function buildBackupPayload() {
  return {
    app: 'pdf-reader',
    format: 1,
    createdAt: new Date().toISOString(),
    settings: settings.get(),
    library: library.exportStore(),
    annotations: readAnnotationBundle(),
    note: '全文索引不包含在备份内；恢复后可在设置里重建。',
  };
}

function writeBackupTo(target) {
  const payload = buildBackupPayload();
  atomicWrite(target, JSON.stringify(payload));
  return {
    ok: true, path: target, bytes: fs.statSync(target).size,
    items: payload.library.items.length, collections: payload.library.collections.length,
    annotations: payload.annotations.length,
  };
}

async function backupViaDialog() {
  const base = 'PDF-Reader-备份-' + new Date().toISOString().slice(0, 10) + '.json';
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: '备份文献库', defaultPath: appState.lastBackupDir ? path.join(appState.lastBackupDir, base) : base,
    filters: [{ name: 'PDF Reader 备份', extensions: ['json'] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  try {
    appState.lastBackupDir = path.dirname(filePath); saveWindowState(appState);
    return writeBackupTo(filePath);
  } catch (err) { return { ok: false, error: String(err && err.message ? err.message : err) }; }
}

function restoreFromFile(file) {
  let obj;
  try {
    let raw = fs.readFileSync(file, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    obj = JSON.parse(raw);
  } catch (err) { return { ok: false, error: '备份文件读取失败：' + (err && err.message ? err.message : err) }; }
  if (!obj || obj.app !== 'pdf-reader' || !obj.library || !Array.isArray(obj.library.items)) {
    return { ok: false, error: '不是本程序生成的备份文件' };
  }
  try {
    const pre = path.join(currentDataDir(), 'backups', 'pre-restore-' + Date.now() + '.json');
    atomicWrite(pre, JSON.stringify(buildBackupPayload()));
    library.replaceStore(obj.library);
    const n = applyAnnotationBundle(obj.annotations || []);
    const keepDir = settings.get().dataDir;
    if (obj.settings && typeof obj.settings === 'object') {
      settings.set(Object.assign({}, obj.settings, { dataDir: keepDir }));
      appSettings = settings.get();
    }
    fulltext.init(currentDataDir());
    if (win) win.webContents.send('lib-changed');
    return { ok: true, path: file, preBackup: pre, items: obj.library.items.length, annotations: n };
  } catch (err) { return { ok: false, error: String(err && err.message ? err.message : err) }; }
}

async function restoreViaDialog() {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '从备份恢复文献库',
    filters: [{ name: 'PDF Reader 备份', extensions: ['json'] }],
    properties: ['openFile'],
    defaultPath: appState.lastBackupDir || undefined,
  });
  if (canceled || !filePaths.length) return { ok: false, canceled: true };
  return restoreFromFile(filePaths[0]);
}

function switchDataDir(target, mode) {
  const abs = path.resolve(target);
  const curDir = path.resolve(currentDataDir());
  if (abs === curDir) return { ok: true, unchanged: true, dataDir: abs, summary: library.summary() };
  try {
    fs.mkdirSync(abs, { recursive: true });
    const cur = library.exportStore();
    library.backupNow('pre-move');
    // 索引是可重建缓存，顺手复制过去，省得切目录后立刻重新抽一遍
    try {
      const from = path.join(curDir, 'fulltext');
      if (fs.existsSync(from)) fs.cpSync(from, path.join(abs, 'fulltext'), { recursive: true, force: true });
    } catch (_) {}
    const incomingFile = path.join(abs, 'library.json');
    const exists = fs.existsSync(incomingFile);
    if (exists && mode === 'replace') {
      let raw = fs.readFileSync(incomingFile, 'utf8');
      if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
      const incoming = JSON.parse(raw);
      library.init(abs); library.resetCache(); fulltext.init(abs);
      library.replaceStore(incoming);
    } else if (exists && mode === 'merge') {
      let raw = fs.readFileSync(incomingFile, 'utf8');
      if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
      const incoming = JSON.parse(raw);
      library.init(abs); library.resetCache(); fulltext.init(abs);
      library.replaceStore(incoming);
      library.mergeStore(cur);
    } else {
      library.init(abs); library.resetCache(); fulltext.init(abs);
      library.replaceStore(cur);
    }
    const saved = settings.set({ dataDir: abs });
    if (!saved.ok) return { ok: false, error: saved.error };
    appSettings = settings.get();
    if (win) win.webContents.send('lib-changed');
    return { ok: true, dataDir: abs, summary: library.summary() };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

async function chooseDataDirViaDialog() {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '选择文献库存储位置',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: currentDataDir(),
  });
  if (canceled || !filePaths.length) return { ok: false, canceled: true };
  const target = filePaths[0];
  const incoming = path.join(target, 'library.json');
  let mode = 'move';
  if (fs.existsSync(incoming)) {
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      title: '目标目录已有文献库',
      message: '目标目录里已经有一个 library.json。要怎么处理？',
      detail: '合并：保留目标库，并把当前库的条目并进去。\n替换：目标库覆盖当前库（当前库会先自动备份）。',
      buttons: ['合并', '替换', '取消'],
      defaultId: 0, cancelId: 2, noLink: true,
    });
    if (response === 2) return { ok: false, canceled: true };
    mode = response === 1 ? 'replace' : 'merge';
  }
  return switchDataDir(target, mode);
}

function importRefsFile(file) {
  try {
    let raw = fs.readFileSync(file, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    const parsed = formats.parseRefs(raw, file);
    const res = library.importItems(parsed.records);
    if (win) win.webContents.send('lib-changed');
    return Object.assign({ ok: true, format: parsed.format, parsed: parsed.records.length }, res);
  } catch (err) { return { ok: false, error: String(err && err.message ? err.message : err) }; }
}

async function importRefsViaDialog() {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '导入 BibTeX / RIS 文献',
    filters: [{ name: 'BibTeX / RIS', extensions: ['bib', 'bibtex', 'ris', 'txt'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths.length) return { ok: false, canceled: true };
  return importRefsFile(filePaths[0]);
}

function exportRefsTo(target) {
  try {
    const ext = path.extname(target).toLowerCase();
    const format = ext === '.ris' ? 'ris' : (ext === '.json' ? 'csljson' : 'bibtex');
    const records = library.summary().items.filter((x) => !x.deletedAt);
    const text = format === 'ris' ? formats.recordsToRis(records)
      : (format === 'csljson' ? formats.recordsToCslJson(records) : formats.recordsToBibtex(records));
    atomicWrite(target, text);
    return { ok: true, path: target, format, count: records.length, bytes: Buffer.byteLength(text) };
  } catch (err) { return { ok: false, error: String(err && err.message ? err.message : err) }; }
}

async function exportRefsViaDialog() {
  const base = 'PDF-Reader-文献库-' + new Date().toISOString().slice(0, 10);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: '导出 BibTeX / RIS / CSL-JSON',
    defaultPath: path.join(appState.lastBackupDir || '', base + '.bib'),
    filters: [
      { name: 'BibTeX', extensions: ['bib'] },
      { name: 'RIS', extensions: ['ris'] },
      { name: 'CSL-JSON', extensions: ['json'] },
    ],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  return exportRefsTo(filePath);
}

// ---------- 本地库 IPC ----------
// 只回传可结构化克隆的纯数据；open-item 复用 readPdfPayload，渲染层拿到字节自己 loadPdf。
ipcMain.handle('lib-summary', () => library.summary());
// v18：最近打开列表（文档快速切换面板用）
ipcMain.handle('recent-list', () => recentList().map((r) => ({
  path: r.path, name: r.name || path.basename(r.path), page: r.page || 0,
})));
// v18：直接打开某个路径（从快速切换面板点「最近打开」时用）
ipcMain.handle('open-path', (_e, info) => {
  const p = info && info.path;
  if (!p || !fs.existsSync(p)) return { ok: false, error: '文件不存在' };
  openFromPath(p);
  return { ok: true };
});
ipcMain.handle('lib-add-pdf', async (_e, info) => {
  const p = info && info.path;
  if (!p || !fs.existsSync(p)) return { ok: false, error: '文件不存在' };
  const o = (info && info.opts) || {};
  // 去重是「导入 / 拖入」这类用户操作的语义，由调用方显式要求（opts.dedupe）：
  // 同一路径不重复建条目；已在回收站里的那条顺手还原回来。
  // 底层 API 默认仍然「建一条新的」，方便测试与将来的一对多场景。
  if (o.dedupe) {
    const exist = library.findItemByPath(p);
    if (exist) {
      if (exist.deletedAt) {
        library.restoreItem(exist.key);
        const back = library.findItem(exist.key);
        fulltext.indexOne(back).catch((err) => console.warn('[fulltext] index add failed:', err && err.message));
        return { ok: true, item: back, deduped: true, restored: true };
      }
      return { ok: true, item: exist, deduped: true };
    }
  }
  // v18：读 PDF 自带元数据填标题/作者（填不上再回退到文件名猜）
  let meta = {};
  try { meta = await pdfmeta.readMeta(p); } catch (_) { meta = {}; }
  const title = o.title || pdfmeta.usableTitle(meta.title);
  const creators = Array.isArray(o.creators) && o.creators.length
    ? o.creators
    : (pdfmeta.usableAuthor(meta.author) ? [meta.author] : []);
  const item = library.addPdf(p, Object.assign({}, o, {
    title: title || undefined,
    creators,
  }));
  fulltext.indexOne(item).catch((err) => console.warn('[fulltext] index add failed:', err && err.message));
  return { ok: true, item, meta: { title: meta.title || '', author: meta.author || '' } };
});
ipcMain.handle('lib-open-item', (_e, info) => {
  const it = info && library.findItem(info.key);
  if (!it || !it.attachment) return { ok: false, error: '条目无附件' };
  if (!fs.existsSync(it.attachment.path)) return { ok: false, error: '文件已移动或删除', missingPath: it.attachment.path };
  const extra = { itemKey: it.key };
  if (info.page && Number.isFinite(+info.page)) extra.startPage = Math.max(1, Math.floor(+info.page));
  const payload = readPdfPayload(it.attachment.path, extra);
  if (payload.ok) rememberRecent(it.attachment.path, payload.startPage || 1);
  return payload;
});
ipcMain.handle('lib-update-item', (_e, info) => (info ? library.updateItem(info.key, info.patch || {}) : null));
// 回收站：默认“移除”= 软删除；永久删除只删索引，绝不删磁盘 PDF
ipcMain.handle('lib-remove-item', (_e, info) => (info ? library.trashItem(info.key) : null));
ipcMain.handle('lib-trash-item', (_e, info) => (info ? library.trashItem(info.key) : null));
ipcMain.handle('lib-restore-item', (_e, info) => (info ? library.restoreItem(info.key) : null));
ipcMain.handle('lib-delete-item', (_e, info) => (info ? library.deleteItemForever(info.key) : false));
ipcMain.handle('lib-empty-trash', () => ({ removed: library.emptyTrash(), filesKept: true }));
ipcMain.handle('lib-add-collection', (_e, info) => library.addCollection(info && info.name, info && info.parentId));
ipcMain.handle('lib-remove-collection', (_e, info) => (info ? library.removeCollection(info.id) : false));
ipcMain.handle('lib-move-item', (_e, info) => (info ? library.moveItem(info.key, info.collectionId) : null));
ipcMain.handle('lib-set-collections', (_e, info) => (info ? library.setCollections(info.key, info.collectionIds) : null));
ipcMain.handle('lib-add-tag', (_e, info) => (info ? library.addTag(info.key, info.tag) : null));
ipcMain.handle('lib-remove-tag', (_e, info) => (info ? library.removeTag(info.key, info.tag) : null));
// v21：标签重命名 / 合并 / 从所有条目上移除
ipcMain.handle('lib-rename-tag', (_e, info) => {
  const r = library.renameTag(info && info.from, info && info.to);
  if (r.ok && win) win.webContents.send('lib-changed');
  return r;
});
ipcMain.handle('lib-merge-tags', (_e, info) => {
  const r = library.mergeTags(info && info.from, info && info.into);
  if (r.ok && win) win.webContents.send('lib-changed');
  return r;
});
ipcMain.handle('lib-remove-tag-everywhere', (_e, info) => {
  const r = library.removeTagEverywhere(info && info.tag);
  if (r.ok && win) win.webContents.send('lib-changed');
  return r;
});

// ---------- 设置 / 备份 / 数据目录 ----------
ipcMain.handle('settings-get', () => Object.assign({}, settings.get(), {
  dataDir: currentDataDir(), dataDirIsDefault: !appSettings.dataDir,
  userData: USER_DATA, settingsFile: settings.filePath(),
}));
ipcMain.handle('settings-set', (_e, patch) => {
  // 存储位置必须走 lib-choose-data-dir（涉及迁移/合并），这里只接受界面偏好
  const p = Object.assign({}, patch || {});
  delete p.dataDir;
  const r = settings.set(p);
  appSettings = settings.get();
  return Object.assign(r, { effective: settings.get(), dataDir: currentDataDir() });
});
ipcMain.handle('lib-backup', (_e, info) => {
  if (info && info.outPath) {
    try { return writeBackupTo(info.outPath); }
    catch (err) { return { ok: false, error: String(err && err.message ? err.message : err) }; }
  }
  return backupViaDialog();
});
ipcMain.handle('lib-restore', (_e, info) => {
  if (info && info.path) return restoreFromFile(info.path);
  return restoreViaDialog();
});
ipcMain.handle('lib-choose-data-dir', (_e, info) => {
  if (info && info.path) return switchDataDir(info.path, info.mode || 'move');
  return chooseDataDirViaDialog();
});
ipcMain.handle('lib-open-data-dir', async () => {
  const err = await shell.openPath(currentDataDir());
  return { ok: !err, error: err || '' };
});

// ---------- 库级全文检索 (v11) ----------
function fulltextResults(query) {
  const hit = fulltext.search(query);
  const out = [];
  const seen = new Set();
  for (const r of hit.results) {
    const it = library.findItemByPath(r.path);
    if (!it || it.deletedAt) continue;
    const id = it.key + ':' + r.page;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      key: it.key, title: it.title || '(无标题)', page: r.page,
      snippet: r.snippet, count: r.count, path: r.path,
    });
    if (out.length >= 120) break;
  }
  return { ok: true, query: hit.query, results: out, stats: hit.stats };
}
ipcMain.handle('lib-search-full', (_e, info) => fulltextResults(info && info.query));
ipcMain.handle('lib-ft-status', () => {
  const s = fulltext.stats();
  const items = library.summary().items.filter((x) => !x.deletedAt && x.attachment);
  return Object.assign(s, {
    totalItems: items.length,
    indexedItems: items.filter((x) => fulltext.isFresh(x.attachment.path)).length,
    pending: items.filter((x) => !fulltext.isFresh(x.attachment.path)).length,
  });
});
ipcMain.handle('lib-ft-index', async (_e, info) => {
  const items = library.summary().items;
  const res = await fulltext.indexAll(items, { force: !!(info && info.force) });
  return Object.assign({ ok: true }, res, { status: fulltext.stats() });
});
ipcMain.handle('lib-ft-clear', () => {
  const removed = fulltext.clear();
  return { ok: true, removed, status: fulltext.stats() };
});

// ---------- 元数据 / BibTeX / RIS / 查重 / 批量 / 智能收藏集 (v12) ----------
ipcMain.handle('lib-fetch-metadata', async (_e, info) => {
  const id = info && info.identifier;
  return metadata.fetchMetadata(id);
});
ipcMain.handle('lib-import-refs', (_e, info) => {
  if (info && typeof info.text === 'string') {
    try {
      const parsed = formats.parseRefs(info.text, info.name || 'import.bib');
      const res = library.importItems(parsed.records);
      if (win) win.webContents.send('lib-changed');
      return Object.assign({ ok: true, format: parsed.format, parsed: parsed.records.length }, res);
    } catch (err) { return { ok: false, error: String(err && err.message ? err.message : err) }; }
  }
  return importRefsViaDialog();
});
ipcMain.handle('lib-export-refs', (_e, info) => {
  if (info && info.outPath) return exportRefsTo(info.outPath);
  return exportRefsViaDialog();
});
ipcMain.handle('lib-duplicates', () => ({ groups: library.findDuplicates() }));
ipcMain.handle('lib-merge-items', (_e, info) => {
  const kept = library.mergeItems(info && info.keepKey, (info && info.otherKeys) || []);
  if (win) win.webContents.send('lib-changed');
  return { ok: !!kept, item: kept };
});
ipcMain.handle('lib-bulk-update', (_e, info) => {
  const r = library.bulkUpdate((info && info.keys) || [], (info && info.patch) || {});
  if (win) win.webContents.send('lib-changed');
  return Object.assign({ ok: true }, r);
});
ipcMain.handle('lib-trash-items', (_e, info) => {
  const r = library.trashItems((info && info.keys) || []);
  return Object.assign({ ok: true }, r);
});
ipcMain.handle('lib-add-search', (_e, info) => {
  const x = library.addSearch(info && info.name, info && info.query);
  return { ok: !!x, search: x };
});
ipcMain.handle('lib-remove-search', (_e, info) => ({ ok: library.removeSearch(info && info.id) }));

// 在资源管理器里定位附件；附件已丢失时返回明确的错误而不是静默无反应
ipcMain.handle('lib-reveal-item', (_e, info) => {
  const it = info && library.findItem(info.key);
  if (!it || !it.attachment) return { ok: false, error: '条目无附件' };
  if (!fs.existsSync(it.attachment.path)) return { ok: false, error: '文件已移动或删除' };
  shell.showItemInFolder(it.attachment.path);
  return { ok: true, path: it.attachment.path };
});

// 附件被移动/改名后重新定位：只更新库索引里的路径，原文件不动
ipcMain.handle('lib-relink-item', async (_e, info) => {
  const it = info && library.findItem(info.key);
  if (!it) return { ok: false, error: '条目不存在' };
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '重新定位 PDF 附件',
    filters: [{ name: 'PDF 文件', extensions: ['pdf'] }],
    properties: ['openFile'],
    defaultPath: it.attachment && fs.existsSync(path.dirname(it.attachment.path))
      ? it.attachment.path : (appState.lastDir || undefined),
  });
  if (canceled || !filePaths.length) return { ok: false, canceled: true };
  const updated = library.setAttachment(it.key, filePaths[0]);
  if (updated) fulltext.indexOne(updated).catch((err) => console.warn('[fulltext] reindex failed:', err && err.message));
  return { ok: !!updated, item: updated };
});

// ---------- 标注自动保存 / 恢复（按文件路径，userData/annotations/<hash>.json） ----------
function annoFileFor(filePath) {
  const h = crypto.createHash('sha1').update(path.resolve(filePath)).digest('hex').slice(0, 20);
  const dir = path.join(app.getPath('userData'), 'annotations');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, h + '.json');
}
ipcMain.handle('anno-save', (_e, info) => {
  if (!info || !info.path) return false;
  try {
    // 空标注也落盘（用户清空后重开不应复活旧标注）
    fs.writeFileSync(annoFileFor(info.path), JSON.stringify({ path: info.path, saved: Date.now(), pages: info.pages || [] }));
    return true;
  } catch (err) { return { error: String(err && err.message ? err.message : err) }; }
});
ipcMain.handle('anno-load', (_e, info) => {
  if (!info || !info.path) return [];
  try {
    const obj = JSON.parse(fs.readFileSync(annoFileFor(info.path), 'utf8'));
    return Array.isArray(obj.pages) ? obj.pages : [];
  } catch (_) { return []; }
});
// 导出批注为笔记
// fmt: txt（默认，纯文本）/ md（Markdown）/ csv（表格）
const NOTE_FORMATS = {
  txt: { ext: 'txt', label: '纯文本文件' },
  md: { ext: 'md', label: 'Markdown 文件' },
  csv: { ext: 'csv', label: 'CSV 文件' },
};
ipcMain.handle('export-note', async (_e, info) => {
  if (!info || !info.text) return { ok: false, error: '没有内容' };
  const fmt = NOTE_FORMATS[info.fmt] ? info.fmt : 'txt';
  const meta = NOTE_FORMATS[fmt];
  const base = String(info.fileName || 'document.pdf').replace(/\.pdf$/i, '') + '-批注笔记.' + meta.ext;
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: '导出批注笔记', defaultPath: base, filters: [{ name: meta.label, extensions: [meta.ext] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  try { fs.writeFileSync(filePath, info.text, 'utf8'); return { ok: true, path: filePath, fmt }; }
  catch (err) { return { ok: false, error: String(err && err.message ? err.message : err) }; }
});

// v21：把**所有**文档的批注汇总成一份 Markdown（写论文时一次导出所有读书笔记）
async function exportAllNotesToFile(outPath) {
  try {
    const dir = annoDir();
    const files = fs.readdirSync(dir).filter((f) => /\.json$/i.test(f));
    const docs = [];
    let total = 0;
    for (const f of files) {
      let obj = null;
      try { obj = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { continue; }
      const pages = (obj && Array.isArray(obj.pages)) ? obj.pages : [];
      if (!pages.length) continue;
      total += pages.reduce((n, pg) => n + ((pg.shapes || []).length), 0);
      docs.push({ name: path.basename(String(obj.path || f)), path: obj.path || '', pages });
    }
    if (!docs.length) {
      if (win && !outPath) dialog.showMessageBox(win, { type: 'info', title: '导出全部批注', message: '还没有任何批注可导出。' });
      return { ok: false, error: '还没有任何批注' };
    }
    let filePath = outPath;
    if (!filePath) {
      const stamp = new Date().toISOString().slice(0, 10);
      const base = 'PDF-Reader-全部批注-' + stamp + '.md';
      const r = await dialog.showSaveDialog(win, {
        title: '导出全部批注',
        defaultPath: path.join(appState.lastBackupDir || '', base),
        filters: [{ name: 'Markdown 文件', extensions: ['md'] }],
      });
      if (r.canceled || !r.filePath) return { ok: false, canceled: true };
      filePath = r.filePath;
    }
    const toolName = { pen: '画笔', highlight: '荧光', line: '直线', rect: '矩形', arrow: '箭头', text: '文字', note: '便签', mark: '选区高亮' };
    const out = ['# 全部批注汇总', '', '> 导出时间：' + new Date().toLocaleString('zh-CN', { hour12: false }) +
      ' · ' + docs.length + ' 个文档，' + total + ' 条批注', ''];
    for (const d of docs.sort((a, b) => a.name.localeCompare(b.name))) {
      out.push('## ' + d.name, '');
      const byPage = new Map();
      for (const pg of d.pages) {
        const shapes = (pg && pg.shapes) || [];
        if (!shapes.length) continue;
        byPage.set(pg.page || 1, shapes);
      }
      for (const p of [...byPage.keys()].sort((a, b) => a - b)) {
        out.push('### 第 ' + p + ' 页', '');
        for (const sh of byPage.get(p)) {
          const tags = Array.isArray(sh.tags) ? sh.tags.filter(Boolean) : [];
          if (sh.tool === 'mark') {
            out.push(String(sh.text || '').split('\n').map((x) => '> ' + x).join('\n'));
            if (sh.comment) out.push('', '**评论**：' + String(sh.comment).split('\n').join(' '));
          } else if (sh.tool === 'text' || sh.tool === 'note') {
            out.push('- **' + (toolName[sh.tool] || sh.tool) + '**：' + String(sh.text || '').split('\n').join(' '));
          } else {
            out.push('- **' + (toolName[sh.tool] || sh.tool) + '**');
          }
          if (tags.length) out.push('  **标签**：' + tags.map((t) => '#' + t).join(' '));
          out.push('');
        }
      }
      out.push('');
    }
    fs.writeFileSync(filePath, out.join('\n'), 'utf8');
    return { ok: true, path: filePath, docs: docs.length, notes: total };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

ipcMain.handle('export-all-notes', (_e, info) => exportAllNotesToFile(info && info.outPath));

// 复制纯文本到系统剪贴板
ipcMain.handle('copy-text', (_e, info) => {
  const text = String((info && info.text) || '');
  if (!text) return { ok: false, error: '没有内容' };
  try { clipboard.writeText(text); return { ok: true, text }; }
  catch (err) { return { ok: false, error: String(err && err.message ? err.message : err) }; }
});

// v20：把当前页导出成 PNG（渲染层给 dataURL，主进程只管落盘）
ipcMain.handle('export-page-png', async (_e, info) => {
  try {
    const dataUrl = String((info && info.dataUrl) || '');
    const m = /^data:image\/png;base64,(.+)$/i.exec(dataUrl);
    if (!m) return { ok: false, error: '图片数据不对' };
    const buf = Buffer.from(m[1], 'base64');
    const name = String((info && info.fileName) || 'page.png').replace(/[\\/:*?"<>|]/g, '_');
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: '导出当前页为图片',
      defaultPath: path.join(appState.lastBackupDir || '', name),
      filters: [{ name: 'PNG 图片', extensions: ['png'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    fs.writeFileSync(filePath, buf);
    return { ok: true, path: filePath, bytes: buf.length };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

// ---------- 导出带标注的 PDF 副本 ----------
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function drawAnno(page, sh, font, lib) {
  const { rgb, LineCapStyle } = lib;
  const [r, g, b] = hexToRgb(sh.color);
  const color = rgb(r, g, b);
  const t = Math.max(0.5, sh.width || 2);
  const round = { lineCap: LineCapStyle.Round };
  const seg = (a, bpt, opts) => page.drawLine(Object.assign({ start: { x: a.x, y: a.y }, end: { x: bpt.x, y: bpt.y } }, opts));

  if (sh.tool === 'pen') {
    for (let i = 0; i < sh.pts.length - 1; i++) seg(sh.pts[i], sh.pts[i + 1], { color, thickness: t, ...round });
  } else if (sh.tool === 'highlight') {
    for (let i = 0; i < sh.pts.length - 1; i++) seg(sh.pts[i], sh.pts[i + 1], { color, opacity: 0.35, thickness: t, ...round });
  } else if (sh.tool === 'mark') {
    // 选区高亮：矩形已由渲染进程转成 PDF 坐标（左下原点）
    for (const r of (sh.rects || [])) {
      if (!(r.w > 0 && r.h > 0)) continue;
      page.drawRectangle({
        x: r.x, y: r.y, width: r.w, height: r.h,
        color, opacity: 0.38, borderColor: color, borderWidth: 0.6, borderOpacity: 0.55,
      });
    }
  } else if (sh.tool === 'line') {
    seg(sh.a, sh.b, { color, thickness: t, ...round });
  } else if (sh.tool === 'arrow') {
    seg(sh.a, sh.b, { color, thickness: t, ...round });
    const ang = Math.atan2(sh.b.y - sh.a.y, sh.b.x - sh.a.x);
    const len = Math.max(8, t * 3.5), s = Math.PI / 7;
    seg(sh.b, { x: sh.b.x - len * Math.cos(ang - s), y: sh.b.y - len * Math.sin(ang - s) }, { color, thickness: t, ...round });
    seg(sh.b, { x: sh.b.x - len * Math.cos(ang + s), y: sh.b.y - len * Math.sin(ang + s) }, { color, thickness: t, ...round });
  } else if (sh.tool === 'rect') {
    page.drawRectangle({
      x: Math.min(sh.a.x, sh.b.x), y: Math.min(sh.a.y, sh.b.y),
      width: Math.abs(sh.b.x - sh.a.x), height: Math.abs(sh.b.y - sh.a.y),
      borderColor: color, borderWidth: t, opacity: 0,
    });
  } else if (sh.tool === 'text') {
    // Helvetica 只支持 Latin-1；含 CJK 等字符会抛错，交由上层 per-shape try/catch 跳过
    const size = sh.size || 14;
    String(sh.text).split('\n').forEach((ln, i) => {
      page.drawText(ln, { x: sh.at.x, y: sh.at.y - size - i * size * 1.25, size, font, color });
    });
  }}

ipcMain.handle('export-pdf', async (_e, payload) => {
  try {
    const { PDFDocument, rgb, StandardFonts, LineCapStyle } = require('pdf-lib');
    const lib = { rgb, LineCapStyle };
    const doc = await PDFDocument.load(payload.data, { ignoreEncryption: true });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const pages = doc.getPages();
    let skipped = 0;
    for (const pg of payload.pages) {
      const page = pages[pg.index];
      if (!page) continue;
      for (const sh of pg.shapes) {
        try { drawAnno(page, sh, font, lib); }
        catch (_) { skipped++; }
      }
    }
    const out = Buffer.from(await doc.save());
    let target = payload.outPath;
    if (!target) {
      const base = String(payload.fileName || 'document.pdf').replace(/\.pdf$/i, '') + '-标注.pdf';
      const { canceled, filePath } = await dialog.showSaveDialog(win, {
        title: '导出标注副本', defaultPath: base, filters: [{ name: 'PDF 文件', extensions: ['pdf'] }],
      });
      if (canceled || !filePath) return { ok: false, canceled: true };
      target = filePath;
    }
    fs.writeFileSync(target, out);
    return { ok: true, path: target, skipped };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

function recentSubmenu() {
  const list = recentList();
  if (!list.length) return [{ label: '（暂无记录）', enabled: false }];
  const items = list.map((r) => ({
    label: r.page ? `${r.name}（上次第 ${r.page} 页）` : r.name,
    toolTip: r.path,
    click: () => openFromPath(r.path),
  }));
  items.push({ type: 'separator' });
  items.push({
    label: '清空最近打开记录',
    click: () => { appState.recent = []; saveWindowState(appState); rebuildMenu(); },
  });
  return items;
}

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '打开 PDF…',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const res = await openPdfViaDialog();
            if (res.ok && win) win.webContents.send('pdf-opened', res);
          },
        },
        { label: '最近打开', submenu: recentSubmenu() },
        { type: 'separator' },
        { label: '导出当前页为图片…', accelerator: 'CmdOrCtrl+Shift+P', click: () => { if (win) win.webContents.send('export-page-png'); } },
        { label: '导出全部批注为一个 Markdown…', click: () => { exportAllNotesToFile(); } },
        { type: 'separator' },
        { label: '导入 BibTeX / RIS…', click: () => importRefsViaDialog() },
        { label: '导出 BibTeX / RIS…', click: () => exportRefsViaDialog() },
        { type: 'separator' },
        { label: '备份文献库…', click: () => backupViaDialog() },
        { label: '从备份恢复…', click: () => restoreViaDialog() },
        { label: '设置…', click: () => { if (win) win.webContents.send('open-settings'); } },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '专注阅读模式', accelerator: 'F11', click: () => { if (win) win.webContents.send('toggle-focus-mode'); } },
        { type: 'separator' },
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
      ],
    },
    {
      label: '系统',
      submenu: [
        {
          label: '设为默认 PDF 阅读器…',
          click: async () => {
            const { response } = await dialog.showMessageBox(win, {
              type: 'info',
              title: '设为默认 PDF 阅读器',
              message: 'Windows 不允许程序静默改写默认应用，需要你在设置里点一下。',
              detail: '本程序路径：\n' + process.execPath + '\n\n下一步：在「默认应用」里搜索并选择本程序作为 .pdf 的打开方式。',
              buttons: ['打开 Windows 设置', '复制程序路径', '取消'],
              noLink: true,
            });
            if (response === 0) shell.openExternal('ms-settings:defaultapps');
            else if (response === 1) clipboard.writeText(process.execPath);
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// 记住页码/新增最近文件后，菜单里的「上次第 N 页」要跟着变，但别在滚动时频繁重建
let menuRefreshTimer = null;
function rebuildMenu() {
  clearTimeout(menuRefreshTimer);
  menuRefreshTimer = setTimeout(buildMenu, 300);
}

app.whenReady().then(() => {
  if (!hasLock) return;
  buildMenu();
  // 冒烟/截图/探针模式一律不起可见窗口，避免测试时屏幕上反复闪窗；
  // PDFREADER_HIDDEN 只隐藏窗口，不影响单实例锁（单实例测试要用）。
  const headless = process.env.SMOKE_PDF || process.env.PDFREADER_LIBUI
    || process.env.PDFREADER_PROBE || process.env.PDFREADER_HIDDEN;
  createWindow({ show: !headless });

  // 启动后低优先级补索引：不阻塞首屏，也不在用户正打开文件时抢 CPU
  if (appSettings.autoIndex && !process.env.PDFREADER_NO_AUTO_INDEX) {
    setTimeout(() => {
      try {
        const items = library.summary().items;
        fulltext.indexAll(items).then((r) => {
          if (r && (r.failed || r.done)) console.log('[fulltext] auto index ' + JSON.stringify({ done: r.done, skipped: r.skipped, failed: r.failed }));
        }).catch((err) => console.warn('[fulltext] auto index failed:', err && err.message));
      } catch (_) {}
    }, 1200);
  }

  // 通用探针：PDFREADER_PROBE 指向一个 module.exports = "(async()=>{...})()" 的探针脚本，
  // 在真实主进程（含全部 IPC handler）的渲染进程里执行，结果打到 [probe-result]。
  const probePath = process.env.PDFREADER_PROBE || (process.env.PDFREADER_LIBUI
    ? path.join(__dirname, '..', 'scripts', 'libui-check.js') : null);
  if (probePath && win) {
    win.webContents.once('did-finish-load', async () => {
      // 探针自带文档：先把 PDF 投给渲染层（不带 smoke 标记，避免冒烟自退出抢跑）
      if (process.env.PDFREADER_PROBE_PDF) {
        const payload = readPdfPayload(process.env.PDFREADER_PROBE_PDF);
        if (payload.ok) win.webContents.send('pdf-opened', payload);
        else console.error('[probe] open failed: ' + payload.error);
      }
      let res;
      try {
        const probe = require(probePath);
        res = await win.webContents.executeJavaScript(probe, true);
      } catch (e) { res = { fatal: String((e && e.message) || e) }; }
      console.log('[probe-result] ' + JSON.stringify(res));
      // 打包产物是 GUI 子系统，标准输出有时拿不到；测试可指定文件落盘作为证据
      if (process.env.PDFREADER_PROBE_OUT) {
        try { fs.writeFileSync(process.env.PDFREADER_PROBE_OUT, JSON.stringify(res)); } catch (_) {}
      }
      // 可选：探针跑完后抓一帧，供离线核对 UI（不会影响正常使用）。
      // 隐藏窗口的 rAF 会被降到 ~1Hz，300ms 抓到的可能是过期帧，这里等足一帧多一点。
      if (process.env.PDFREADER_PROBE_SHOT) {
        try {
          await new Promise((r) => setTimeout(r, 1600));
          const img = await win.capturePage();
          fs.writeFileSync(process.env.PDFREADER_PROBE_SHOT, img.toPNG());
          console.log('[probe-shot] written ' + process.env.PDFREADER_PROBE_SHOT);
        } catch (e) { console.error('[probe-shot] fail ' + ((e && e.message) || e)); }
      }
      app.exit(0);
    });
    return; // 探针模式不处理命令行文件
  }

  // 双击 PDF / 右键「打开方式」：文件路径由命令行传入
  openFromPath(pdfArgFrom(process.argv));
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
