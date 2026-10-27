const { app, BrowserWindow, Menu, ipcMain, dialog, shell, clipboard, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { atomicWrite } = require('./atomic-file');
const resources = require('./data-resources');

const settings = require('./settings.js');
const fulltext = require('./fulltext.js');
const formats = require('./formats.js');
const metadata = require('./metadata.js');
const fetchpdf = require('./fetchpdf.js');
const pdfmeta = require('./pdfmeta.js');
const docconvert = require('./docconvert.js');
const Cite = require('./cite.js');
const Csl = require('./csl.js');
const Creators = require('./creators.js');
const query = require('./query.js');

let win = null;

// ---------- 改名后的数据目录迁移（PDF Reader → Trove） ----------
// Electron 的 userData 目录名取自 package.json 的 `name` 字段（不是 productName），
// 所以改名前是 %APPDATA%\pdf-reader，改名后是 %APPDATA%\trove。
// 搬家规则：只拷不删、只补缺不覆盖、Singleton* 锁文件不搬；失败就退回老目录继续用。
// 必须在 requestSingleInstanceLock() 之前跑，否则单实例锁会落在两个不同目录，等于允许双开。
//
// 测试/探针模式一律不搬：它们用 --user-data-dir 开临时目录，若把真实的老数据搬进去，
// 测试会读到用户自己的最近打开和页码（曾经因此让打包冒烟稳定打开到第 3 页）。
// 注意别把这里并进下面的 TEST_MODE：test-single-instance 用 PDFREADER_HIDDEN +
// --user-data-dir 但**需要**单实例锁，混淆了会把锁关掉。
const ISOLATED_USER_DATA = !!(process.env.SMOKE_PDF || process.env.PDFREADER_PROBE
  || process.env.PDFREADER_LIBUI || process.env.PDFREADER_TEST || process.env.PDFREADER_HIDDEN
  || process.env.PDFREADER_DATA_DIR || process.argv.some((a) => /^--user-data-dir=/.test(a)));

function runUserDataMigration() {
  if (ISOLATED_USER_DATA) return;
  const appData = app.getPath('appData');
  const newUserData = app.getPath('userData');
  const mig = require('./usermigrate.js').migrateUserData({ appData, newUserData });
  if (mig.migrated) console.log('[migrate] userData', mig.sources.join(' , '), '->', newUserData);
  if (!mig.ok) {
    console.warn('[migrate] 迁移失败，继续使用旧目录：', mig.error);
    for (const name of require('./usermigrate.js').LEGACY_DIR_NAMES) {
      const oldDir = path.join(appData, name);
      if (fs.existsSync(oldDir)) { try { app.setPath('userData', oldDir); } catch (_) {} break; }
    }
  }
}
runUserDataMigration();

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
      const p = docArgFrom(argv);
      if (p) openFromPath(p);
    });
  }
}

// ---------- 设置 / 存储位置（v11） ----------
const USER_DATA = app.getPath('userData');
const sessionFile = () => path.join(USER_DATA, 'session.json');
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
  try { atomicWrite(stateFile, JSON.stringify(s)); } catch (_) {}
}
let appState = loadWindowState();

// ---------- 本地文献库（JSON 索引，零原生依赖） ----------
const library = require('./library.js');
library.init(currentDataDir());
fulltext.init(currentDataDir());
// 老标注补稳定 id（v8 地基）：这次不动它，后面删一条标注就会把所有标签串位
try {
  const up = upgradeAnnoIds();
  if (up && up.upgraded) console.log('[anno] upgrade ids ' + JSON.stringify(up));
} catch (err) { console.warn('[anno] id upgrade failed:', err && err.message); }

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

// 只更新已存在条目的页码：翻阅时高频调用，不重排列表、不重建菜单。
// total（总页数）由阅读器一并提供，列表用它算阅读进度百分比。
function recordPage(filePath, page, total) {
  if (!filePath || !Number.isFinite(page)) return;
  const it = recentList().find((r) => r.path === filePath);
  if (it && it.page !== page) { it.page = page; saveWindowState(appState); }
  // 同步到库条目（若该文件属于某个条目）
  const li = library.findItemByPath(filePath);
  if (li && (li.page !== page || (total && li.pageTotal !== total))) library.setPageByKey(li.key, page, total);
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

// 从命令行参数里取文档路径（双击文件 / 右键「打开方式」都会走到这里）
// 支持的不只是 PDF：docx / pptx / xlsx / md / epub 等都能直接双击打开。
function docArgFrom(argvList) {
  for (const a of argvList || []) {
    if (typeof a !== 'string') continue;
    const abs = path.resolve(a);
    if (docconvert.isSupported(abs) && fs.existsSync(abs)) return abs;
  }
  return null;
}

// 兼容旧调用名（v11-v26 的测试/探针里出现过）
const pdfArgFrom = docArgFrom;

// 统一打开入口：PDF 读字节交给 PDF.js，其它格式在主进程转成安全 HTML。
// 返回的 payload 直接经 IPC 结构化克隆到渲染层；转换失败时 ok=false。
async function readDocPayload(filePath, extra) {
  const ext = docconvert.extOf(filePath);
  if (ext === 'pdf') return readPdfPayload(filePath, extra);
  try {
    const doc = await docconvert.readDocument(filePath, {
      startPage: (extra && extra.startPage) || pageForPath(filePath) || 1,
    });
    if (!doc.ok) return Object.assign({ filePath }, doc);
    return Object.assign({}, doc, extra || {}, {
      startPage: Math.max(1, Math.floor(+((extra && extra.startPage) || doc.startPage || pageForPath(filePath) || 1))),
      // 主进程已经记住的页码优先于文档内部默认值
      fileName: path.basename(filePath),
    });
  } catch (err) {
    return { ok: false, filePath, error: String(err && err.message ? err.message : err) };
  }
}

// 打开条目时顺带把「引用键 / 默认格式引用」交给渲染层，详情面板和阅读器都能直接复制。
function citationInfo(it) {
  if (!it) return {};
  try {
    return { item: it, citekey: Cite.citekey(it), citation: Cite.format(it, 'gbt7714') };
  } catch (_) {
    return { item: it, citekey: '', citation: '' };
  }
}

// ---------- 阅读会话（v33：restoreTabs 启用） ----------
// 标签页列表 + 激活项存 <userData>/session.json。渲染层在每次标签变动和关窗前上报，
// 主进程启动时（无命令行文件、设置开启、有会话）把轻量清单推给渲染层，
// 渲染层再逐个按路径取回文档字节打开——恢复不写入「最近打开」，避免搅乱该列表。
const MAX_SESSION_TABS = 20;
function saveSessionInfo(info) {
  try {
    const raw = (info && Array.isArray(info.tabs)) ? info.tabs : [];
    const seen = new Set();
    const tabs = [];
    for (const t of raw) {
      if (!t || typeof t.path !== 'string' || !t.path) continue;
      if (seen.has(t.path)) continue;
      seen.add(t.path);
      tabs.push({
        path: t.path,
        name: String(t.name || path.basename(t.path)).slice(0, 200),
        kind: t.kind === 'rich' ? 'rich' : 'pdf',
        itemKey: String(t.itemKey || '').slice(0, 64),
        page: Math.max(1, Math.min(999999, Math.floor(+t.page) || 1)),
        rotation: [0, 90, 180, 270].includes(+t.rotation) ? +t.rotation : 0,   // v34：视图旋转
        refPage: Math.max(1, Math.min(999999, Math.floor(+t.refPage) || 1)),  // v34：分屏参考页
      });
      if (tabs.length >= MAX_SESSION_TABS) break;
    }
    atomicWrite(sessionFile(), JSON.stringify({ saved: Date.now(), active: String((info && info.active) || ''), tabs }));
    return true;
  } catch (_) { return false; }
}
function readSessionInfo() {
  try {
    const obj = JSON.parse(fs.readFileSync(sessionFile(), 'utf8'));
    const tabs = Array.isArray(obj.tabs) ? obj.tabs : [];
    return {
      saved: Number(obj.saved) || 0,
      active: String(obj.active || ''),
      tabs: tabs.filter((t) => t && typeof t.path === 'string' && t.path).map((t) => ({
        path: t.path, name: String(t.name || ''),
        kind: t.kind === 'rich' ? 'rich' : 'pdf',
        itemKey: String(t.itemKey || ''),
        page: Math.max(1, Math.floor(+t.page) || 1),
        rotation: [0, 90, 180, 270].includes(+t.rotation) ? +t.rotation : 0,
        refPage: Math.max(1, Math.floor(+t.refPage) || 1),
      })).slice(0, MAX_SESSION_TABS),
    };
  } catch (_) { return { saved: 0, active: '', tabs: [] }; }
}
ipcMain.on('session-save', (_e, info) => { saveSessionInfo(info); });
ipcMain.handle('session-get', () => Object.assign({ ok: true }, readSessionInfo()));
// 按路径读文档给恢复用：与库内打开同一条链（含引用信息），但不记「最近打开」
ipcMain.handle('open-doc-path', async (_e, info) => {
  const p = info && info.path;
  if (!p || typeof p !== 'string') return { ok: false, error: '路径为空' };
  const page = Math.max(1, Math.floor(+(info && info.page)) || 1);
  const payload = await readDocPayload(p, { startPage: page });
  if (!payload.ok) return payload;
  const libItem = library.findItemByPath(p);
  if (libItem) Object.assign(payload, citationInfo(libItem), { itemKey: libItem.key });
  // 页码以库 / 最近打开里记的为准（随翻页实时更新），会话快照只在没记录时兜底
  payload.startPage = payload.startPage || page;
  return payload;
});

// 窗口可能还没加载完（冷启动带文件参数时一定会），所以未就绪时排队，等 did-finish-load 再投
let pendingOpen = null;
async function openFromPath(filePath) {
  if (!filePath) return null;
  const payload = await readDocPayload(filePath);
  if (!payload.ok) { dialog.showErrorBox('打开失败', payload.error || filePath); return payload; }
  const libItem = library.findItemByPath(filePath);
  if (libItem) Object.assign(payload, citationInfo(libItem), { itemKey: libItem.key });
  rememberRecent(filePath, payload.startPage || 1);
  if (win && win.__loaded) {
    win.webContents.send('pdf-opened', payload);
  } else {
    // 未就绪：交给 createWindow 里注册的 did-finish-load 统一投递，避免两处重复发
    pendingOpen = payload;
  }
  return payload;
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
    title: 'Trove',
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
    if (pendingOpen) { win.webContents.send('pdf-opened', pendingOpen); pendingOpen = null; return; }
    // v33：会话恢复。只在「没有命令行 / 菜单打开的文件」时进行，避免双开；
    // 冒烟与探针模式不恢复，保持测试路径单一。
    if (process.env.SMOKE_PDF) return;
    try {
      if (!settings.get().restoreTabs) return;
      const sess = readSessionInfo();
      if (sess.tabs.length) win.webContents.send('session-restore', sess);
    } catch (_) {}
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
  if (win) win.setTitle(title ? title + ' - Trove' : 'Trove');
});

ipcMain.on('smoke-result', (_e, payload) => {
  console.log('[smoke-result] ' + JSON.stringify(payload));
  app.exit(payload && payload.ok ? 0 : 2);
});

const DOC_DIALOG_FILTERS = [
  { name: '所有支持的文档', extensions: [...docconvert.SUPPORTED_EXTS] },
  { name: 'PDF 文件', extensions: ['pdf'] },
  { name: 'Word 文档', extensions: ['docx', 'doc'] },
  { name: '演示文稿', extensions: ['pptx', 'odp'] },
  { name: '表格', extensions: ['xlsx', 'xls', 'ods', 'csv'] },
  { name: '文本 / Markdown', extensions: ['md', 'markdown', 'txt', 'html', 'htm', 'rtf'] },
  { name: '电子书', extensions: ['epub'] },
  { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'] },
  { name: '所有文件', extensions: ['*'] },
];

// 弹出文件对话框，读取文档；PDF 回字节，其它格式回转换好的页面。
async function openPdfViaDialog() {
  if (!win) return { ok: false };
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '打开文档',
    filters: DOC_DIALOG_FILTERS,
    properties: ['openFile'],
    defaultPath: appState.lastDir || undefined,
  });
  if (canceled || filePaths.length === 0) return { ok: false };

  const filePath = filePaths[0];
  const payload = await readDocPayload(filePath);
  if (payload.ok) {
    rememberRecent(filePath, payload.startPage || 1);
    appState.lastDir = path.dirname(filePath); saveWindowState(appState);
    if (!win.__loaded) pendingOpen = payload; // 罕见：对话框期间窗口被重载
  } else {
    dialog.showErrorBox('打开失败', payload.error || filePath);
  }
  return payload;
}

ipcMain.handle('open-pdf-dialog', () => openPdfViaDialog());

// 只选文件、不读取内容：库界面的「添加文档」用它，避免把文件先转换一遍再入库。
async function pickDocumentsViaDialog() {
  if (!win) return { ok: false };
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '添加文档',
    filters: DOC_DIALOG_FILTERS,
    properties: ['openFile', 'multiSelections'],
    defaultPath: appState.lastDir || undefined,
  });
  if (canceled || !filePaths.length) return { ok: false, canceled: true };
  appState.lastDir = path.dirname(filePaths[0]);
  saveWindowState(appState);
  return { ok: true, filePaths };
}
ipcMain.handle('pick-documents', () => pickDocumentsViaDialog());

// 渲染进程上报当前页码（按文件记住，下次打开回到同一位置）
ipcMain.on('set-page', (_e, info) => {
  try { if (info) recordPage(info.path, info.page, info.total); }
  catch (err) { if (win && !win.isDestroyed()) win.webContents.send('save-error', '阅读进度保存失败：' + err.message); }
});

// 拖拽打开的文件也要进「最近打开」；返回该文件上次读到的页码，交给渲染层决定落到哪
ipcMain.handle('note-recent', (_e, info) => {
  if (!info || !info.path) return { page: 1 };
  const page = pageForPath(info.path) || 1;
  rememberRecent(info.path, page);
  return { page };
});

// ---------- 数据目录 / 备份恢复 / 导入导出（v11-v12） ----------
function annoDir() { return path.join(USER_DATA, 'annotations'); }

function readAnnotationBundle(strict = false) {
  const out = [];
  try {
    const dir = annoDir();
    for (const f of fs.readdirSync(dir)) {
      if (!/\.json$/i.test(f)) continue;
      try {
        let raw = fs.readFileSync(path.join(dir, f), 'utf8');
        if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
        out.push({ name: f, data: JSON.parse(raw) });
      } catch (err) { if (strict) throw err; }
    }
  } catch (err) { if (strict && err.code !== 'ENOENT') throw err; }
  return out;
}

function buildBackupPayload() {
  const files = resources.readBundle(currentDataDir());
  return {
    app: 'trove',
    format: 1,
    createdAt: new Date().toISOString(),
    settings: settings.get(),
    library: library.exportStore(),
    annotations: readAnnotationBundle(true),
    sourceDataDir: currentDataDir(),
    resources: files,
    images: Object.fromEntries(Object.entries(files).filter(([p]) => /^snapshots\/[^/]+\.png$/i.test(p)).map(([p, data]) => [path.basename(p), data])),
    note: '包含笔记图片、网页快照、自定义 CSL 及托管附件；外部引用的文档和全文索引不包含在备份内。',
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
  const base = 'Trove-备份-' + new Date().toISOString().slice(0, 10) + '.json';
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: '备份文献库', defaultPath: appState.lastBackupDir ? path.join(appState.lastBackupDir, base) : base,
    filters: [{ name: 'Trove 备份', extensions: ['json'] }],
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
  // 兼容改名前的备份（app 标识是 'pdf-reader'），新备份写 'trove'
  if (!obj || (obj.app !== 'trove' && obj.app !== 'pdf-reader') || !obj.library || !Array.isArray(obj.library.items)) {
    return { ok: false, error: '不是本程序生成的备份文件' };
  }
  const tx = new resources.FileTransaction();
  try {
    const pre = path.join(currentDataDir(), 'backups', 'pre-restore-' + Date.now() + '.json');
    atomicWrite(pre, JSON.stringify(buildBackupPayload()));
    const files = Object.assign({}, obj.resources || {});
    for (const [name, data] of Object.entries(obj.images || {})) {
      if (path.basename(name) !== name || !/\.png$/i.test(name)) throw new Error('备份图片路径不合法');
      if (!Object.hasOwn(files, 'snapshots/' + name)) files['snapshots/' + name] = data;
    }
    const map = resources.installResources(tx, currentDataDir(), null, files);
    const store = resources.remapStore(obj.library, obj.sourceDataDir, currentDataDir(), map);
    // Normalize before publishing so invalid metadata cannot leave a half-restored library.
    const normalized = library.combineStores(store, { items: [] });
    tx.add(library.filePath(), JSON.stringify(normalized));
    let n = 0;
    const restoredNames = new Set();
    for (const entry of obj.annotations || []) {
      if (!entry || !entry.data || !/^[a-f0-9]{8,64}\.json$/i.test(entry.name || '')) throw new Error('备份标注文件不合法');
      const data = JSON.parse(JSON.stringify(entry.data));
      const owner = (obj.library.items || []).find(it => it.attachment && it.attachment.path === data.path);
      const restored = owner && normalized.items.find(it => it.key === owner.key);
      if (restored && restored.attachment) data.path = restored.attachment.path;
      const name = data.path ? path.basename(annoFileFor(data.path)) : entry.name;
      if (restoredNames.has(name)) throw new Error('备份标注文件重复：' + name);
      restoredNames.add(name);
      tx.add(path.join(annoDir(), name), JSON.stringify(data)); n++;
    }
    if (fs.existsSync(annoDir())) for (const name of fs.readdirSync(annoDir())) {
      if (/\.json$/i.test(name) && !restoredNames.has(name)) tx.remove(path.join(annoDir(), name));
    }
    const keepDir = settings.get().dataDir;
    const next = settings._sanitize(Object.assign({}, obj.settings || settings.get(), { dataDir: keepDir }));
    tx.add(settings.filePath(), JSON.stringify(next));
    tx.commit();
    library.resetCache(); library.resetUndo(); settings.resetCache(); appSettings = settings.get();
    fulltext.init(currentDataDir());
    if (win) win.webContents.send('lib-changed');
    return { ok: true, path: file, preBackup: pre, items: normalized.items.length, annotations: n, images: Object.keys(obj.images || {}).length };
  } catch (err) { return { ok: false, error: String(err && err.message ? err.message : err) }; }
  finally { tx.dispose(); }
}

async function restoreViaDialog() {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '从备份恢复文献库',
    filters: [{ name: 'Trove 备份', extensions: ['json'] }],
    properties: ['openFile'],
    defaultPath: appState.lastBackupDir || undefined,
  });
  if (canceled || !filePaths.length) return { ok: false, canceled: true };
  return restoreFromFile(filePaths[0]);
}

function switchDataDir(target, mode) {
  const abs = path.resolve(target);
  const curDir = path.resolve(currentDataDir());
  if (abs.toLowerCase() === curDir.toLowerCase()) return { ok: true, unchanged: true, dataDir: abs, summary: library.summary() };
  const tx = new resources.FileTransaction();
  try {
    fs.mkdirSync(abs, { recursive: true });
    const current = library.exportStore();
    if (!library.backupNow('pre-move')) throw new Error('切换前备份失败，已取消切换');
    const incomingFile = path.join(abs, 'library.json');
    let incoming = null;
    if (fs.existsSync(incomingFile)) {
      incoming = JSON.parse(fs.readFileSync(incomingFile, 'utf8').replace(/^\uFEFF/, ''));
      if (!incoming || !Array.isArray(incoming.items)) throw new Error('目标文献库无效');
    }
    let store;
    if (incoming && mode === 'replace') store = library.combineStores(incoming, { items: [] });
    else {
      const map = resources.installResources(tx, abs, curDir);
      const migrated = resources.remapStore(current, curDir, abs, map);
      store = incoming && mode === 'merge' ? library.combineStores(incoming, migrated) : migrated;
      const retainedKeys = new Set(incoming && mode === 'merge' ? incoming.items.map(it => it.key) : []);
      const annotationTargets = new Set();
      // Managed documents change paths. Copy their annotations under the new path hash.
      for (const old of current.items) {
        if (retainedKeys.has(old.key)) continue; // 同 key 保留目标条目，也保留目标的标注关联。
        const updated = store.items.find(it => it.key === old.key);
        if (!old.attachment || !updated || !updated.attachment || old.attachment.path === updated.attachment.path) continue;
        const from = annoFileFor(old.attachment.path), to = annoFileFor(updated.attachment.path);
        if (annotationTargets.has(to)) continue;
        if (!fs.existsSync(from)) continue;
        if (fs.existsSync(to)) throw new Error('目标附件已有关联标注，已取消切换以避免覆盖');
        const data = JSON.parse(fs.readFileSync(from, 'utf8')); data.path = updated.attachment.path;
        tx.add(to, JSON.stringify(data));
        annotationTargets.add(to);
      }
    }
    tx.add(incomingFile, JSON.stringify(store));
    tx.add(settings.filePath(), JSON.stringify(settings._sanitize(Object.assign({}, settings.get(), { dataDir: abs }))));
    tx.commit();
    settings.resetCache(); appSettings = settings.get();
    library.init(abs); library.resetCache(); library.resetUndo(); fulltext.init(abs);
    // Indexes are rebuildable caches. Rebuild at the new paths using the existing queue.
    if (!process.env.PDFREADER_NO_AUTO_INDEX && appSettings.autoIndex) fulltext.indexAll(store.items).catch(err => console.warn('[fulltext]', err.message));
    if (win) win.webContents.send('lib-changed');
    return { ok: true, dataDir: abs, summary: library.summary() };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  } finally { tx.dispose(); }
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
    // EndNote 导出的 XML 有时是 UTF-16（带 BOM），按 utf8 读会成乱码；这里按字节嗅探解码
    let raw = '';
    const buf = fs.readFileSync(file);
    if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) raw = require('iconv-lite').decode(buf, 'utf16le');
    else if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) raw = require('iconv-lite').decode(buf, 'utf16be');
    else { raw = buf.toString('utf8'); if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); }
    const parsed = formats.parseRefs(raw, file);
    const res = library.importItems(parsed.records);
    if (win) win.webContents.send('lib-changed');
    return Object.assign({ ok: true, format: parsed.format, parsed: parsed.records.length }, res);
  } catch (err) { return { ok: false, error: String(err && err.message ? err.message : err) }; }
}

async function importRefsViaDialog() {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '导入题录（BibTeX / RIS / EndNote / RefWorks / CSL-JSON）',
    filters: [
      { name: '题录文件', extensions: ['bib', 'bibtex', 'ris', 'enw', 'refworks', 'json', 'xml', 'txt'] },
      { name: 'BibTeX', extensions: ['bib', 'bibtex'] },
      { name: 'RIS', extensions: ['ris'] },
      { name: 'EndNote', extensions: ['enw'] },
      { name: 'EndNote XML', extensions: ['xml'] },
      { name: 'RefWorks', extensions: ['refworks', 'txt'] },
    ],
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
  const base = 'Trove-文献库-' + new Date().toISOString().slice(0, 10);
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
ipcMain.handle('open-path', async (_e, info) => {
  const p = info && info.path;
  if (!p || !fs.existsSync(p)) return { ok: false, error: '文件不存在' };
  if (!docconvert.isSupported(p)) return { ok: false, error: '不支持这个文件格式' };
  const r = await openFromPath(p);
  return r && r.ok ? { ok: true } : { ok: false, error: (r && r.error) || '打开失败' };
});
// ---------- 按父条目元数据重命名附件（v9） ----------
// 规则与 Zotero 的默认模板一致：作者 - 年份 - 标题，缺的字段跳过。
// 改名的同时要跟着搬两样东西，否则会「文件改了、标注/索引全丢」：
//   annotations/<sha1(旧路径)>.json → 新路径的 hash 文件（并更新里面的 path）
//   fulltext/<sha1(旧路径)>.json    → 同上
function safeFileBase(s) {
  return String(s || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 100)
    .trim();
}

function renameBaseFor(it) {
  const creators = Array.isArray(it.creators) ? it.creators : [];
  const first = creators.find((c) => c && (c.creatorType === 'author' || !c.creatorType)) || creators[0];
  const author = first && typeof first === 'object'
    ? (first.lastName || first.firstName || '')
    : String(first || '');
  const parts = [safeFileBase(author), safeFileBase(it.year), safeFileBase(it.title)].filter(Boolean);
  return parts.join(' - ') || safeFileBase(path.basename(it.attachment && it.attachment.path, path.extname(it.attachment.path || '')) || 'untitled');
}

function uniquePath(dir, base, ext) {
  let target = path.join(dir, base + ext);
  let i = 2;
  while (fs.existsSync(target) && i < 200) {
    target = path.join(dir, base + ' (' + i + ')' + ext);
    i++;
  }
  return target;
}

// 一个文件改了名，它的标注文件与全文索引也跟着搬到新路径对应的文件
function moveSidecar(oldPath, newPath) {
  const moved = { anno: false, ft: false };
  if (path.resolve(oldPath).toLowerCase() === path.resolve(newPath).toLowerCase()) return moved;
  try {
    const oldAnno = annoFileFor(oldPath);
    if (fs.existsSync(oldAnno)) {
      const obj = JSON.parse(fs.readFileSync(oldAnno, 'utf8'));
      obj.path = newPath;
      const target = annoFileFor(newPath);
      if (fs.existsSync(target)) throw new Error('目标附件已有关联标注');
      atomicWrite(target, JSON.stringify(obj));
      try { fs.unlinkSync(oldAnno); } catch (_) {}
      moved.anno = true;
    }
  } catch (_) {}
  try {
    const oldFt = fulltext.fileFor(oldPath);
    if (fs.existsSync(oldFt)) {
      const obj = JSON.parse(fs.readFileSync(oldFt, 'utf8'));
      obj.path = newPath;
      atomicWrite(fulltext.fileFor(newPath), JSON.stringify(obj));
      try { fs.unlinkSync(oldFt); } catch (_) {}
      moved.ft = true;
    }
  } catch (_) {}
  return moved;
}

ipcMain.handle('lib-rename-file', (_e, info) => {
  const keys = Array.isArray(info && info.keys) ? info.keys : [];
  const out = { ok: true, renamed: 0, skipped: 0, failed: 0, changes: [], errors: [] };
  for (const key of keys) {
    const it = library.findItem(key);
    if (!it || it.deletedAt || !it.attachment || !it.attachment.path) { out.skipped++; continue; }
    const oldPath = it.attachment.path;
    if (!fs.existsSync(oldPath)) { out.skipped++; out.errors.push({ key, error: '文件不存在' }); continue; }
    try {
      const ext = path.extname(oldPath);
      const base = renameBaseFor(it);
      if (!base) { out.skipped++; continue; }
      const dir = path.dirname(oldPath);
      // 先看「按规则该叫什么」：已经就是这个名就跳过（不能进 uniquePath，
      // 否则它会把自己当成冲突，改成 XX (2).pdf）
      const want = path.join(dir, base + ext);
      if (path.resolve(want) === path.resolve(oldPath)) { out.skipped++; continue; }
      const target = uniquePath(dir, base, ext);
      fs.renameSync(oldPath, target);
      library.setAttachment(key, target);   // 只接受路径字符串（内部会自己算 name）
      const side = moveSidecar(oldPath, target);
      out.renamed++;
      out.changes.push({ key, oldPath, newPath: target, anno: side.anno, ft: side.ft });
    } catch (err) {
      out.failed++;
      out.errors.push({ key, error: String(err && err.message ? err.message : err) });
    }
  }
  if (out.renamed && win) {
    win.webContents.send('lib-changed');
    win.webContents.send('files-renamed', { changes: out.changes });
  }
  return out;
});

// ---------- 撤销 / 重做（v9） ----------
ipcMain.handle('lib-undo', () => {
  const r = library.undo();
  if (r.ok && win) win.webContents.send('lib-changed');
  return Object.assign(r, { info: library.undoInfo() });
});
ipcMain.handle('lib-redo', () => {
  const r = library.redo();
  if (r.ok && win) win.webContents.send('lib-changed');
  return Object.assign(r, { info: library.undoInfo() });
});
ipcMain.handle('lib-undo-info', () => library.undoInfo());

// v9：打印当前文档 —— 交给系统默认程序（不自己拼打印任务，PDF 阅读器该尊重系统打印设置）
ipcMain.handle('print-file', (_e, info) => {
  const p = String((info && info.path) || '').trim();
  if (!p) return { ok: false, error: '没有打开文档' };
  if (!fs.existsSync(p)) return { ok: false, error: '文件不存在' };
  // 测试钩子：只验证流程，不真的往打印机发任务
  if (process.env.PDFREADER_PRINT_DRY === '1') return { ok: true, dry: true };
  try {
    const { spawn } = require('child_process');
    if (process.platform === 'win32') {
      // PowerShell 的 -Verb Print 会调默认程序的打印动词；路径里的单引号要翻倍转义
      const safe = p.replace(/'/g, "''");
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "Start-Process -FilePath '" + safe + "' -Verb Print"], { windowsHide: true, stdio: 'ignore' });
      child.on('error', () => {});
    } else {
      const child = spawn('lp', [p], { stdio: 'ignore' });
      child.on('error', () => {});
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

// v9：笔记预览里的外链（只放行 http/https/mailto，别把 file:// 或 shell 命令放出去）
ipcMain.handle('open-external', (_e, info) => {
  const url = String((info && info.url) || '').trim();
  if (!/^(https?:\/\/|mailto:)/i.test(url)) return { ok: false, error: '只支持网页链接与邮件地址' };
  try { shell.openExternal(url); return { ok: true }; }
  catch (err) { return { ok: false, error: String(err && err.message ? err.message : err) }; }
});

// v9：独立笔记条目（不挂文献，Zotero 的 standalone note）。正文就是 notes[0]。
ipcMain.handle('lib-new-note', (_e, info) => {
  const text = String((info && info.text) || '');
  const title = String((info && info.title) || '').trim() || '未命名笔记';
  const it = library.addItem({
    itemType: 'note',
    title,
    notes: [{ title: '', text }],
  });
  if (win) win.webContents.send('lib-changed');
  return { ok: true, item: it ? library.summary().items.find((x) => x.key === it.key) : null };
});

ipcMain.handle('lib-add-pdf', async (_e, info) => {
  const p = info && info.path;
  if (!p || !fs.existsSync(p)) return { ok: false, error: '文件不存在' };
  if (!docconvert.isSupported(p)) return { ok: false, error: '不支持这个文件格式' };
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
  // v18：读文档自带元数据填标题/作者（PDF 走 PDF 信息字典，Office/EPUB 读 core.xml）
  let meta = {};
  const ext = docconvert.extOf(p);
  try { meta = ext === 'pdf' ? await pdfmeta.readMeta(p) : await docconvert.readZipCoreMeta(p); } catch (_) { meta = {}; }
  const title = o.title || pdfmeta.usableTitle(meta.title);
  // PDF 元数据里的作者常写成 "A and B" / "A; B"，拆成多个作者再结构化
  const rawCreators = Array.isArray(o.creators) && o.creators.length
    ? o.creators
    : (pdfmeta.usableAuthor(meta.author) ? [meta.author] : []);
  const creatorList = (rawCreators.length === 1 && typeof rawCreators[0] === 'string')
    ? rawCreators[0].split(/\s+and\s+|;|；/).map((x) => x.trim()).filter(Boolean)
    : rawCreators;
  const creators = Creators.normalizeCreators(creatorList);
  const item = library.addPdf(p, Object.assign({}, o, {
    title: title || undefined,
    creators,
  }));
  fulltext.indexOne(item).catch((err) => console.warn('[fulltext] index add failed:', err && err.message));
  return { ok: true, item, meta: { title: meta.title || '', author: meta.author || '' } };
});
ipcMain.handle('lib-open-item', async (_e, info) => {
  const it = info && library.findItem(info.key);
  if (!it || !it.attachment) return { ok: false, error: '条目无附件' };
  if (!fs.existsSync(it.attachment.path)) return { ok: false, error: '文件已移动或删除', missingPath: it.attachment.path };
  if (!docconvert.isSupported(it.attachment.path)) return { ok: false, error: '不支持这个文件格式' };
  const extra = { itemKey: it.key };
  if (info.page && Number.isFinite(+info.page)) extra.startPage = Math.max(1, Math.floor(+info.page));
  const payload = await readDocPayload(it.attachment.path, extra);
  if (payload.ok) {
    Object.assign(payload, citationInfo(it));
    rememberRecent(it.attachment.path, payload.startPage || 1);
  }
  return payload;
});
ipcMain.handle('lib-update-item', (_e, info) => (info ? library.updateItem(info.key, info.patch || {}) : null));
// 订阅条目 → 文献库（webpage 条目）。返回 ok + key，供界面把按钮置灰。
ipcMain.handle('lib-add-item', (_e, info) => {
  try {
    const it = library.addItem(info || {});
    if (win) win.webContents.send('lib-changed');
    return { ok: true, key: it.key };
  } catch (err) { return { ok: false, error: String(err && err.message ? err.message : err) }; }
});
// 回收站：默认“移除”= 软删除；永久删除只删索引，绝不删磁盘 PDF
ipcMain.handle('lib-remove-item', (_e, info) => (info ? library.trashItem(info.key) : null));
ipcMain.handle('lib-trash-item', (_e, info) => (info ? library.trashItem(info.key) : null));
ipcMain.handle('lib-restore-item', (_e, info) => (info ? library.restoreItem(info.key) : null));

// 快照是 app 自己在数据目录里生成的，条目永久删除时顺手清掉；用户的 PDF 仍然一个不动。
function dropSnapshotFiles(snap) {
  if (!snap || !snap.path) return;
  try {
    if (fs.existsSync(snap.path)) fs.unlinkSync(snap.path);
    const filesDir = String(snap.path).replace(/\.(m?html)$/i, '_files');
    if (filesDir !== snap.path && fs.existsSync(filesDir)) fs.rmSync(filesDir, { recursive: true, force: true });
    if (snap.png && fs.existsSync(snap.png)) fs.unlinkSync(snap.png);
  } catch (_) {}
}
ipcMain.handle('lib-delete-item', (_e, info) => {
  if (!info || !info.key) return false;
  const it = library.findItem(info.key);
  const ok = library.deleteItemForever(info.key);
  if (ok && it) dropSnapshotFiles(it.snapshot);
  return ok;
});
ipcMain.handle('lib-empty-trash', () => {
  const snaps = library.summary().items
    .filter((x) => x.deletedAt && x.snapshot)
    .map((x) => x.snapshot);
  const removed = library.emptyTrash();
  for (const s of snaps) dropSnapshotFiles(s);
  return { removed, filesKept: true };
});
ipcMain.handle('lib-add-collection', (_e, info) => library.addCollection(info && info.name, info && info.parentId));
ipcMain.handle('lib-remove-collection', (_e, info) => (info ? library.removeCollection(info.id) : false));
// v27：收藏集重命名 / 颜色、标签颜色
ipcMain.handle('lib-rename-collection', (_e, info) => {
  const c = info ? library.renameCollection(info.id, info.name) : null;
  if (c && win) win.webContents.send('lib-changed');
  return { ok: !!c, collection: c };
});
ipcMain.handle('lib-set-collection-color', (_e, info) => {
  const c = info ? library.setCollectionColor(info.id, info.color) : null;
  if (c && win) win.webContents.send('lib-changed');
  return { ok: !!c, collection: c };
});
ipcMain.handle('lib-set-tag-color', (_e, info) => {
  const r = info ? library.setTagColor(info.tag, info.color) : { ok: false };
  if (r.ok && win) win.webContents.send('lib-changed');
  return r;
});
// v27：相关条目（双向）
ipcMain.handle('lib-add-relation', (_e, info) => {
  const it = info ? library.addRelation(info.key, info.otherKey) : null;
  if (it) win.webContents.send('lib-changed');
  return { ok: !!it, item: it };
});
ipcMain.handle('lib-remove-relation', (_e, info) => {
  const it = info ? library.removeRelation(info.key, info.otherKey) : null;
  if (it) win.webContents.send('lib-changed');
  return { ok: !!it, item: it };
});
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

// v23：阅读笔记（一条文献挂多条笔记）
ipcMain.handle('lib-add-note', (_e, info) => (info ? library.addNote(info.key, info.note || {}) : null));
ipcMain.handle('lib-update-note', (_e, info) => (info ? library.updateNote(info.key, info.id, info.patch || {}) : null));
ipcMain.handle('lib-remove-note', (_e, info) => (info ? library.removeNote(info.key, info.id) : false));

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
// v27：一次搜索同时合并「全文索引 + 批注 / 摘录 + 阅读笔记」，
// 结果用 type 区分，UI 显示不同徽标；点击仍跳到对应页。
function makeSnippet(text, q, width) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  const n = width || 96;
  if (!s) return '';
  // q 可以是 ast（query.js 解析结果）或普通字符串；锚点短语优先
  let needle = String(q || '');
  if (q && q.text) {
    const tok = q.text.find((t) => t.phrase) || q.text[0];
    needle = tok ? tok.t : '';
  }
  const i = s.toLowerCase().indexOf(String(needle).toLowerCase());
  if (i < 0) return s.slice(0, n) + (s.length > n ? '…' : '');
  const from = Math.max(0, i - Math.floor(n / 3));
  const to = Math.min(s.length, from + n);
  return (from > 0 ? '…' : '') + s.slice(from, to) + (to < s.length ? '…' : '');
}

function annotationResults(q, ast, byPath) {
  const A = ast || query.parseQuery(q);
  const out = [];
  for (const entry of readAnnotationBundle()) {
    const data = entry && entry.data;
    const p = data && data.path;
    if (!p) continue;
    const it = byPath ? byPath.get(p) : library.findItemByPath(p);
    if (!it || it.deletedAt) continue;
    for (const pg of (data.pages || [])) {
      for (const sh of (pg && pg.shapes) || []) {
        const text = [sh.text, sh.comment].filter(Boolean).join(' ').trim();
        if (!text) continue;
        const hay = query.fold(text);
        if (!query.matchText(hay, A)) continue;   // 短语 / 排除 / OR / 括号都在这
        out.push({
          key: it.key, title: it.title || '(无标题)', page: pg.page || 1,
          type: 'annotation', label: sh.comment ? '批注' : '摘录',
          snippet: makeSnippet(text, A), path: p,
          ...query.scoreText(hay, A),
        });
      }
    }
  }
  return out;
}

function noteResults(q, ast) {
  const A = ast || query.parseQuery(q);
  const out = [];
  for (const it of library.load().items) {
    if (it.deletedAt) continue;
    for (const n of it.notes || []) {
      const hay = [n.title, n.text].filter(Boolean).join(' ');
      if (!hay) continue;
      if (!query.matchText(query.fold(hay), A)) continue;
      out.push({
        key: it.key, title: it.title || '(无标题)', page: it.page || 1,
        type: 'note', label: '笔记', noteId: n.id,
        snippet: makeSnippet(hay, A), path: (it.attachment && it.attachment.path) || '',
        ...query.scoreText(query.fold(hay), A),
      });
    }
  }
  return out;
}

// v33：搜索支持分页与结果类型计数。
// 默认仍返回前 120 条（老行为），加 offset/limit 可以翻页；counts/total 覆盖全部命中，
// 不受本页条数限制——UI 用它显示「全部 / 文献 / 正文 / 批注 / 笔记」各自的命中数。
function fulltextResults(queryRaw, opts) {
  const o = opts || {};
  const limit = Math.min(500, Math.max(1, Math.floor(+o.limit) || 120));
  const offset = Math.max(0, Math.floor(+o.offset) || 0);
  const ast = query.parseQuery(queryRaw);
  const hit = fulltext.search(queryRaw);
  const items = library.load().items;
  const byKey = new Map(items.map(it => [it.key, it]));
  const byPath = new Map();
  for (const it of items) if (!it.deletedAt && it.attachment && !byPath.has(it.attachment.path)) byPath.set(it.attachment.path, it);
  const out = [];
  const seen = new Set();
  const pageOf = (list) => {
    const total = list.length;
    const counts = {};
    for (const r of list) counts[r.type] = (counts[r.type] || 0) + 1;
    return { ok: true, query: ast.raw, results: list.slice(offset, offset + limit), stats: hit.stats, total, counts, offset, limit };
  };
  // 带字段限定（title:/author:/tag:…）时，正文命中还要过一遍条目字段；
  // 只有字段限定、没有正文词时，直接按条目级字段过滤出结果。
  const hasFields = ((ast.fieldTokens && ast.fieldTokens.length) || Object.keys(ast.fields || {}).length) > 0;
  const filterItem = (it) => query.matchFieldsNot(it, ast);
  if (hasFields && !ast.text.length) {
    for (const it of items) {
      if (it.deletedAt) continue;
      if (!query.matchFieldsNot(it, ast)) continue;
      const id = 'it:' + it.key;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        key: it.key, title: it.title || '(无标题)', page: it.page || 1,
        type: 'item', label: '条目',
        snippet: makeSnippet(query.itemHaystack(it), ast), path: (it.attachment && it.attachment.path) || '',
      });
    }
    return pageOf(out);
  }
  for (const r of hit.results) {
    const it = byPath.get(r.path);
    if (!it || it.deletedAt) continue;
    if (hasFields && !filterItem(it)) continue;
    const id = 'ft:' + it.key + ':' + r.page;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      key: it.key, title: it.title || '(无标题)', page: r.page,
      type: 'fulltext', label: '全文',
      snippet: r.snippet, count: r.count, score: r.score, path: r.path,
    });
  }
  if (String(queryRaw || '').trim()) {
    for (const r of annotationResults(queryRaw, ast, byPath)) {
      const it = byKey.get(r.key);
      if (hasFields && (!it || !query.matchFieldsNot(it, ast))) continue;
      const id = 'an:' + r.key + ':' + r.page + ':' + r.snippet;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(r);
    }
  }
  if (String(queryRaw || '').trim()) {
    for (const r of noteResults(queryRaw, ast)) {
      const it = byKey.get(r.key);
      if (hasFields && (!it || !query.matchFieldsNot(it, ast))) continue;
      const id = 'nt:' + r.key + ':' + r.noteId;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(r);
    }
  }
  const priority = { note: 0, annotation: 1, fulltext: 2 };
  const compare = (a, b) => (b.score || 0) - (a.score || 0) || priority[a.type] - priority[b.type] || a.key.localeCompare(b.key) || a.page - b.page;
  out.sort(compare);
  // 饱和场景：正文先占满第一页时，批注 / 笔记会被挤掉（F05）。
  // 老做法是把各类最佳命中保留进前 120 条、丢掉被挤出的结果——只有一页时没问题，
  // 分页后丢掉的就再也看不到了。改成「交换」：把每个类型的最佳命中换进第一页末尾，
  // 被换出的结果放回原位置。整份 out 仍是同一批结果的排列，翻页不丢不重；
  // 第一页末尾的提升项按 compare 排序，保持页内得分单调。
  // 注意：这个置换必须与 offset 无关——每次调用都构建同一份置换序列，
  // 任何一页都是这份序列的切片；否则第二页会从原始排序取数，和第一页重叠。
  if (out.length > limit) {
    const promoted = [];
    for (const type of [...new Set(out.map(r => r.type))]) {
      const idx = out.findIndex(r => r.type === type);
      if (idx >= limit) promoted.push({ idx, item: out[idx] });
    }
    if (promoted.length && promoted.length < limit) {
      promoted.sort((a, b) => compare(a.item, b.item));
      const displaced = [];
      for (let s = 0; s < promoted.length; s++) displaced.push(out[limit - promoted.length + s]);
      for (let s = 0; s < promoted.length; s++) out[limit - promoted.length + s] = promoted[s].item;
      displaced.sort(compare);
      promoted.sort((a, b) => a.idx - b.idx);
      for (let s = 0; s < promoted.length; s++) out[promoted[s].idx] = displaced[s];
    }
  }
  return pageOf(out);
}
ipcMain.handle('lib-search-full', (_e, info) => fulltextResults(info && info.query, info));
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

// v9：抓 PDF 全文（arXiv → Unpaywall → 直链/doi.org 依次尝试），成功就挂到条目上
ipcMain.handle('lib-fetch-pdf', async (_e, info) => {
  const key = String((info && info.key) || '').trim();
  const it = key ? library.findItem(key) : null;
  if (!it) return { ok: false, error: '条目不存在' };
  if (it.deletedAt) return { ok: false, error: '回收站里的条目不能抓取' };
  const custom = String((info && info.url) || '').trim();
  const src = {
    doi: typeof info.doi === 'string' ? info.doi.trim() : (it.doi || ''),
    arxivId: fetchpdf.arxivIdFromUrl(custom || (it.fields && it.fields.arxivId) || it.url || ''),
    url: custom || it.url || '',
    email: (settings.get().fetchEmail || '').trim(),
  };
  if (!src.doi && !src.arxivId && !src.url) {
    return { ok: false, error: '这条文献没有 DOI / arXiv / 链接，先在详情里补一个再抓' };
  }
  const dir = path.join(currentDataDir(), 'attachments');
  const dest = path.join(dir, key + '.pdf');
  const r = await fetchpdf.fetchToFile(src, dest, { timeout: (info && info.timeout) || undefined });
  if (!r.ok) return Object.assign({ ok: false }, r, { sources: src });
  try {
    const updated = library.setAttachment(key, r.path);
    fulltext.indexOne(updated).catch(err => console.warn('[fulltext] downloaded file:', err.message));
    if (win) win.webContents.send('lib-changed');
  } catch (err) {
    return { ok: false, error: '下载成功但挂载失败：' + (err && err.message ? err.message : err) };
  }
  return { ok: true, path: r.path, source: r.source, bytes: r.bytes, tried: r.tried };
});

// v31：批量抓取。选中多条 → 依次抓，进度实时回传渲染层；可中途取消。
let fetchBatchAbort = false;
ipcMain.handle('lib-fetch-pdf-batch-cancel', () => {
  fetchBatchAbort = true;
  return { ok: true };
});

ipcMain.handle('lib-fetch-pdf-batch', async (_e, info) => {
  const keys = Array.isArray(info && info.keys)
    ? info.keys.map((k) => String(k == null ? '' : k)).filter(Boolean)
    : [];
  if (!keys.length) return { ok: false, error: '没有选中条目' };
  const force = !!(info && info.force);
  const email = (settings.get().fetchEmail || '').trim();
  const dir = path.join(currentDataDir(), 'attachments');
  fetchBatchAbort = false;

  const total = keys.length;
  const results = [];
  let done = 0, fetched = 0, failed = 0, skipped = 0, aborted = false;

  const emit = (rec) => {
    if (!win || win.isDestroyed()) return;
    try {
      win.webContents.send('lib-fetch-pdf-progress',
        Object.assign({ done, total, fetched, failed, skipped }, rec));
    } catch (_) {}
  };

  for (let i = 0; i < keys.length; i++) {
    if (fetchBatchAbort) { aborted = true; break; }
    const key = keys[i];
    const it = library.findItem(key);
    const rec = { key, index: i + 1, total, title: (it && it.title) || '' };

    if (!it) {
      rec.status = 'failed'; rec.error = '条目不存在'; failed++;
    } else if (it.deletedAt) {
      rec.status = 'skipped'; rec.error = '回收站里的条目'; skipped++;
    } else if (!force && it.attachment && it.attachment.path && fs.existsSync(it.attachment.path)) {
      rec.status = 'skipped'; rec.error = '已有附件'; skipped++;
    } else {
      const src = {
        doi: it.doi || '',
        arxivId: fetchpdf.arxivIdFromUrl((it.fields && it.fields.arxivId) || it.url || ''),
        url: it.url || '',
        email,
      };
      if (!src.doi && !src.arxivId && !src.url) {
        rec.status = 'skipped'; rec.error = '没有 DOI / arXiv / 链接'; skipped++;
      } else {
        let r;
        try {
          r = await fetchpdf.fetchToFile(src, path.join(dir, key + '.pdf'), {});
        } catch (err) {
          r = { ok: false, error: String(err && err.message ? err.message : err) };
        }
        if (r.ok) {
          try {
            const updated = library.setAttachment(key, r.path);
            fulltext.indexOne(updated).catch(err => console.warn('[fulltext] downloaded file:', err.message));
            rec.status = 'ok'; rec.source = r.source; rec.bytes = r.bytes; fetched++;
          } catch (err) {
            rec.status = 'failed';
            rec.error = '下载成功但挂载失败：' + (err && err.message ? err.message : err);
            failed++;
          }
        } else {
          rec.status = 'failed'; rec.error = r.error || '抓取失败'; failed++;
        }
      }
    }
    done++;
    results.push(rec);
    emit(rec);
  }

  if (fetched && win && !win.isDestroyed()) win.webContents.send('lib-changed');
  return { ok: true, total, done, fetched, failed, skipped, aborted, results };
});

// v31：网页快照。把条目网址在隐藏窗口里打开，存成 HTML + 首屏 PNG，链接烂了也能回看。
ipcMain.handle('lib-snapshot', async (_e, info) => {
  const key = String((info && info.key) || '').trim();
  const it = key ? library.findItem(key) : null;
  if (!it) return { ok: false, error: '条目不存在' };
  const url = String((info && info.url) || it.url || '').trim();
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: '这条文献没有可以快照的网址（先在详情里填 URL）' };

  const dir = path.join(currentDataDir(), 'snapshots');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  const htmlPath = path.join(dir, key + '.html');
  const pngPath = path.join(dir, key + '.png');

  const snapWin = new BrowserWindow({
    show: false, width: 1280, height: 900,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      partition: 'trove-snapshot',
      images: true,
      javascript: true,
    },
  });
  try {
    snapWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    try {
      snapWin.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    } catch (_) {}
    let loadTimer = null;
    try {
      await Promise.race([
        snapWin.loadURL(url),
        new Promise((_, reject) => {
          loadTimer = setTimeout(() => reject(new Error('打开网页超时（30 秒）')), 30000);
        }),
      ]);
    } finally {
      if (loadTimer) clearTimeout(loadTimer);
    }
    await new Promise((r) => setTimeout(r, 1200));   // 给动态内容一点渲染时间

    // Electron 31 的 webContents.savePage 在隐藏窗口里会静默返回 false（三种格式都失败），
    // 改用 DevTools 协议的 Page.captureSnapshot 拿单文件 MHTML；再退一步只存 DOM HTML。
    let saved = false, saveErr = '', savePath = '';
    const mhtmlPath = path.join(dir, key + '.mhtml');
    try {
      const dbg = snapWin.webContents.debugger;
      try {
        if (!dbg.isAttached()) dbg.attach('1.3');
        await dbg.sendCommand('Page.enable');
        const shot = await dbg.sendCommand('Page.captureSnapshot', { format: 'mhtml' });
        if (shot && shot.data && shot.data.length > 20) {
          fs.writeFileSync(mhtmlPath, shot.data, 'utf8');
          saved = true;
          savePath = mhtmlPath;
        }
      } finally {
        try { if (dbg.isAttached()) dbg.detach(); } catch (_) {}
      }
    } catch (err) {
      saveErr = String(err && err.message ? err.message : err);
    }
    if (!saved) {
      try {
        const html = await snapWin.webContents.executeJavaScript('document.documentElement.outerHTML', true);
        if (html && html.length > 50) {
          fs.writeFileSync(htmlPath, html, 'utf8');
          saved = true;
          savePath = htmlPath;
        }
      } catch (err) {
        saveErr = saveErr || String(err && err.message ? err.message : err);
      }
    }
    let png = '';
    try {
      const img = await snapWin.webContents.capturePage();
      if (img && !img.isEmpty()) { fs.writeFileSync(pngPath, img.toPNG()); png = pngPath; }
    } catch (_) {}

    if (!saved) {
      return { ok: false, error: '快照没写下来' + (saveErr ? '：' + saveErr : '（页面内容为空）') };
    }
    const snapshot = { path: savePath, png, url, at: Date.now() };
    library.setSnapshot(key, snapshot);
    if (win && !win.isDestroyed()) win.webContents.send('lib-changed');
    return { ok: true, snapshot };
  } catch (err) {
    return { ok: false, error: '快照失败：' + (err && err.message ? err.message : err) };
  } finally {
    try { snapWin.destroy(); } catch (_) {}
  }
});

// 用系统默认程序打开快照（.mhtml 归浏览器管；不能走 open-path，那条只认应用自己支持的文档格式）
ipcMain.handle('lib-open-snapshot', async (_e, info) => {
  const key = String((info && info.key) || '').trim();
  const it = key ? library.findItem(key) : null;
  const p = it && it.snapshot && it.snapshot.path ? it.snapshot.path : '';
  if (!p || !fs.existsSync(p)) return { ok: false, error: '快照文件不存在（可能被清理了）' };
  const err = await shell.openPath(p);
  return err ? { ok: false, error: err } : { ok: true };
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

// ---------- CSL 用户样式（v32） ----------
// 放在 <数据目录>/styles/*.csl：导入时复制一份过去，启动时扫描，换数据目录也能跟着走。
function cslStyleDir() { return path.join(currentDataDir(), 'styles'); }

function cslSafeId(value) {
  return String(value == null ? '' : value)
    .replace(/^csl:/i, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 64);
}

// 只返回能解析、且有 bibliography 的样式；坏文件跳过，避免一份坏样式让整张列表消失。
function listUserCslStyles() {
  const dir = cslStyleDir();
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /\.csl$/i.test(f)).sort(); }
  catch (_) { return { ok: true, styles: [] }; }
  const styles = [];
  for (const file of files) {
    try {
      const xml = fs.readFileSync(path.join(dir, file), 'utf8');
      const style = Csl.parseStyle(xml, { id: file.replace(/\.csl$/i, '') });
      if (!style.bibliography) continue;
      styles.push({ id: style.id, label: style.label, xml, warnings: style.warnings });
    } catch (err) {
      console.warn('[csl] 跳过无效样式', file, err && err.message ? err.message : err);
    }
  }
  return { ok: true, styles };
}

ipcMain.handle('csl-styles', () => listUserCslStyles());

ipcMain.handle('csl-import', async () => {
  if (!win) return { ok: false, error: '窗口不可用' };
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '导入 CSL 样式',
    filters: [{ name: 'CSL 样式', extensions: ['csl'] }],
    properties: ['openFile'],
    defaultPath: appState.lastDir || undefined,
  });
  if (canceled || !filePaths.length) return { ok: false, canceled: true };
  const src = filePaths[0];
  let xml;
  try {
    const st = fs.statSync(src);
    if (st.size > 5 * 1024 * 1024) return { ok: false, error: '文件过大（超过 5 MB）' };
    xml = fs.readFileSync(src, 'utf8');
  } catch (err) { return { ok: false, error: '读取失败：' + (err && err.message ? err.message : err) }; }

  let style;
  try { style = Csl.parseStyle(xml); }
  catch (err) { return { ok: false, error: '不是有效的 CSL：' + (err && err.message ? err.message : err) }; }
  if (!style.bibliography) return { ok: false, error: '该样式没有 bibliography 定义，不能生成参考文献表' };

  const id = cslSafeId(style.id) || ('style-' + Date.now().toString(36));
  const dir = cslStyleDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, id + '.csl'), xml, 'utf8');
  } catch (err) {
    return { ok: false, error: '保存失败：' + (err && err.message ? err.message : err) };
  }
  appState.lastDir = path.dirname(src);
  saveWindowState(appState);
  return Object.assign({ ok: true, id, label: style.label, warnings: style.warnings }, listUserCslStyles());
});

// 删除用户样式（目前界面只在数据目录里手动删，IPC 留给脚本/后续入口用）
ipcMain.handle('csl-remove', (_e, info) => {
  const id = cslSafeId(info && info.id);
  if (!id) return { ok: false, error: '无效的样式 id' };
  try { fs.unlinkSync(path.join(cslStyleDir(), id + '.csl')); }
  catch (err) {
    if (!err || err.code !== 'ENOENT') {
      return { ok: false, error: '删除失败：' + (err && err.message ? err.message : err) };
    }
  }
  return Object.assign({ ok: true }, listUserCslStyles());
});
// 渲染层已经拼好的文本（目前是参考文献表）落盘。
// 文件对话框留在主进程，渲染层只传 text / format / 建议文件名。
ipcMain.handle('save-text', async (_e, info) => {
  if (!info || typeof info.text !== 'string' || !info.text.trim()) {
    return { ok: false, error: '没有可保存的内容' };
  }
  if (info.outPath) {
    try {
      atomicWrite(String(info.outPath), info.text);
      return { ok: true, path: String(info.outPath), bytes: Buffer.byteLength(info.text) };
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  }
  // html / word / rtf 的正文由渲染层的 bib.js 拼好，主进程只负责挑对扩展名和过滤器。
  // word 存的是 .doc（内容是 HTML），Word 能直接打开并保留编号与缩进；rtf 是真正的 RTF 源码。
  const FMT_EXT = { markdown: 'md', text: 'txt', html: 'html', word: 'doc', rtf: 'rtf' };
  const FMT_FILTERS = {
    markdown: [{ name: 'Markdown', extensions: ['md'] }, { name: '纯文本', extensions: ['txt'] }],
    text: [{ name: '纯文本', extensions: ['txt'] }, { name: 'Markdown', extensions: ['md'] }],
    html: [{ name: '网页', extensions: ['html'] }, { name: 'Word 文档', extensions: ['doc'] }],
    word: [{ name: 'Word 文档', extensions: ['doc'] }, { name: '网页', extensions: ['html'] }],
    rtf: [{ name: 'RTF 文档', extensions: ['rtf'] }, { name: 'Word 文档', extensions: ['doc'] }],
  };
  const fmt = FMT_EXT[String(info.format)] ? String(info.format) : 'markdown';
  const base = String(info.defaultName || ('Trove-参考文献-' + new Date().toISOString().slice(0, 10)))
    .replace(/[\\/:*?"<>|]/g, '-').replace(/\.(md|txt|html|doc|rtf)$/i, '');
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: '保存参考文献表',
    defaultPath: path.join(appState.lastBackupDir || '', base + '.' + FMT_EXT[fmt]),
    filters: FMT_FILTERS[fmt],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  try {
    atomicWrite(filePath, info.text);
    appState.lastBackupDir = path.dirname(filePath);
    saveWindowState(appState);
    return { ok: true, path: filePath, bytes: Buffer.byteLength(info.text) };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
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
    title: '重新定位附件',
    filters: [
      { name: '所有支持的文档', extensions: [...docconvert.SUPPORTED_EXTS] },
      { name: '所有文件', extensions: ['*'] },
    ],
    properties: ['openFile'],
    defaultPath: it.attachment && fs.existsSync(path.dirname(it.attachment.path))
      ? it.attachment.path : (appState.lastDir || undefined),
  });
  if (canceled || !filePaths.length) return { ok: false, canceled: true };
  const newPath = path.resolve(filePaths[0]);
  const oldPath = it.attachment && it.attachment.path;
  const tx = new resources.FileTransaction();
  try {
    if (!fs.existsSync(newPath)) throw new Error('选择的文件不存在');
    const oldAnno = oldPath && annoFileFor(oldPath), newAnno = annoFileFor(newPath);
    if (oldAnno && oldAnno !== newAnno && fs.existsSync(oldAnno)) {
      const source = JSON.parse(fs.readFileSync(oldAnno, 'utf8'));
      const target = fs.existsSync(newAnno) ? JSON.parse(fs.readFileSync(newAnno, 'utf8')) : { pages: [] };
      for (const pg of source.pages || []) {
        let dest = target.pages.find(p => p.page === pg.page);
        if (!dest) { dest = { page: pg.page, shapes: [] }; target.pages.push(dest); }
        for (const shape of pg.shapes || []) {
          const existing = shape.id && dest.shapes.find(s => s.id === shape.id);
          if (existing && JSON.stringify(existing) !== JSON.stringify(shape)) throw new Error('目标附件包含同 id 的不同标注，已保留原关联');
          if (!existing) dest.shapes.push(shape);
        }
      }
      target.path = newPath; target.saved = Date.now();
      tx.add(newAnno, JSON.stringify(target)); // 原标注仍保留，其他引用旧附件的条目不受影响。
    }
    const store = library.exportStore();
    const updated = store.items.find(x => x.key === it.key);
    updated.attachment = { path: newPath, name: path.basename(newPath) }; updated.updated = Date.now();
    tx.add(library.filePath(), JSON.stringify(store));
    tx.commit(); library.resetCache();
    fulltext.indexOne(updated).catch(err => console.warn('[fulltext] reindex failed:', err.message));
    return { ok: true, item: library.summary().items.find(x => x.key === it.key) };
  } catch (err) { return { ok: false, error: err.message }; }
  finally { tx.dispose(); }
});

// ---------- 标注自动保存 / 恢复（按文件路径，userData/annotations/<hash>.json） ----------
function annoFileFor(filePath) {
  const h = crypto.createHash('sha1').update(path.resolve(filePath)).digest('hex').slice(0, 20);
  const dir = path.join(app.getPath('userData'), 'annotations');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, h + '.json');
}

// ---------- 标注稳定 id（数据层 v8 的地基） ----------
// v7 及更早的标注 id 是「文件 hash:页码:本页下标」——删掉中间一条，后面所有标注的
// 下标都往前挪，库里按 id 存的标签就串到别的标注上了。所以每条标注真身上必须带一个
// 不随顺序变化的 id；老标注首次读到时补齐并回写文件，标签键跟着一次性重映射。
function genAnnoId() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(10);
  let s = '';
  for (let i = 0; i < 10; i++) s += alphabet[bytes[i] % alphabet.length];
  return 'a' + s;
}

// 给一份标注文件的所有形状补齐 id，返回 { changed, map: {旧id: 新id} }
function ensureAnnoIds(obj, fileId, writeBack) {
  const map = {};
  let changed = false;
  const pages = Array.isArray(obj && obj.pages) ? obj.pages : [];
  pages.forEach((pg) => {
    const shapes = (pg && Array.isArray(pg.shapes)) ? pg.shapes : [];
    shapes.forEach((sh, i) => {
      if (!sh || typeof sh !== 'object') return;
      if (sh.id) return;
      sh.id = genAnnoId();
      changed = true;
      const oldId = fileId + ':' + (pg.page || 0) + ':' + i;
      map[oldId] = sh.id;
    });
  });
  if (changed && writeBack) writeBack();
  return { changed, map };
}

// 启动时跑一次：老标注补 id → 库里的标签键重映射到新 id
function upgradeAnnoIds() {
  let dir = '';
  try { dir = annoDir(); } catch (_) { return { ok: false, upgraded: 0 }; }
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /\.json$/i.test(f)); } catch (_) { return { ok: false, upgraded: 0 }; }
  const map = {};
  let upgraded = 0;
  for (const f of files) {
    const full = path.join(dir, f);
    let obj = null;
    try { obj = JSON.parse(fs.readFileSync(full, 'utf8')); } catch (_) { continue; }
    if (!obj || !Array.isArray(obj.pages)) continue;
    const res = ensureAnnoIds(obj, f.replace(/\.json$/i, ''), () => {
      try { fs.writeFileSync(full, JSON.stringify(obj)); } catch (_) {}
    });
    if (!res.changed) continue;
    upgraded++;
    Object.assign(map, res.map);
  }
  let remapped = 0;
  if (Object.keys(map).length) {
    try { remapped = (library.remapAnnoTags(map) || {}).remapped || 0; } catch (_) {}
  }
  return { ok: true, upgraded, remapped };
}
ipcMain.handle('anno-save', (_e, info) => {
  if (!info || !info.path) return false;
  try {
    // 空标注也落盘（用户清空后重开不应复活旧标注）
    const obj = { path: info.path, saved: Date.now(), pages: info.pages || [] };
    // 用户书签存在同一个 sidecar 里，标注保存不能把它们冲掉
    try {
      const oldObj = JSON.parse(fs.readFileSync(annoFileFor(info.path), 'utf8'));
      if (Array.isArray(oldObj.bookmarks)) obj.bookmarks = oldObj.bookmarks;
    } catch (_) {}
    // 兜底：渲染层没带 id 的形状顺手补上（新建标注由渲染层生成 id，这里是保险）
    ensureAnnoIds(obj, '', () => {});
    atomicWrite(annoFileFor(info.path), JSON.stringify(obj));
    return true;
  } catch (err) { return { error: String(err && err.message ? err.message : err) }; }
});
// ---------- 用户书签（每份 PDF 一组，存标注 sidecar 的 bookmarks 字段） ----------
function readSidecarBookmarks(filePath) {
  try {
    const obj = JSON.parse(fs.readFileSync(annoFileFor(filePath), 'utf8'));
    const list = Array.isArray(obj.bookmarks) ? obj.bookmarks : [];
    return list
      .filter((b) => b && Number.isFinite(+b.page) && +b.page >= 1)
      .map((b) => ({ page: Math.floor(+b.page), at: Number.isFinite(+b.at) ? +b.at : 0, label: String(b.label || '').slice(0, 60) }))
      .sort((a, b) => a.page - b.page);
  } catch (_) { return []; }
}

ipcMain.handle('bookmarks-load', (_e, info) => {
  const p = info && info.path;
  if (!p) return { ok: false, bookmarks: [] };
  return { ok: true, bookmarks: readSidecarBookmarks(p) };
});

ipcMain.handle('bookmarks-save', (_e, info) => {
  const p = info && info.path;
  if (!p) return { ok: false, error: '没有文档路径' };
  const list = (Array.isArray(info.bookmarks) ? info.bookmarks : [])
    .filter((b) => b && Number.isFinite(+b.page) && +b.page >= 1)
    .map((b) => ({ page: Math.floor(+b.page), at: Number.isFinite(+b.at) && +b.at > 0 ? +b.at : Date.now(), label: String(b.label || '').slice(0, 60) }))
    .sort((a, b) => a.page - b.page);
  try {
    let obj = {};
    try { obj = JSON.parse(fs.readFileSync(annoFileFor(p), 'utf8')); } catch (_) { obj = {}; }
    obj.path = obj.path || p;
    obj.saved = Date.now();
    obj.bookmarks = list;
    if (!Array.isArray(obj.pages)) obj.pages = [];
    atomicWrite(annoFileFor(p), JSON.stringify(obj));
    return { ok: true, bookmarks: list };
  } catch (err) { return { ok: false, error: String(err && err.message ? err.message : err) }; }
});

ipcMain.handle('anno-load', (_e, info) => {
  if (!info || !info.path) return [];
  const file = annoFileFor(info.path);
  const fileId = path.basename(file, '.json');
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    const pages = Array.isArray(obj.pages) ? obj.pages : [];
    // 老标注首次打开：补 id → 回写文件 → 库里的标签键重映射过去
    const res = ensureAnnoIds(obj, fileId, () => {
      try { fs.writeFileSync(file, JSON.stringify(obj)); } catch (_) {}
    });
    if (res.changed) {
      try { library.remapAnnoTags(res.map); } catch (_) {}
      if (win) win.webContents.send('lib-changed');
    }
    return pages;
  } catch (_) { return []; }
});

// 把所有文档的标注汇总成一张表（标注条目化的第一步）。
// 标注本体仍在 annotations/<hash>.json，这里只是读出来给文献库界面用。
const ANNO_KIND = {
  mark: '高亮', highlight: '高亮', comment: '批注', quote: '摘录', underline: '下划线',
  pen: '手绘', rect: '矩形', arrow: '箭头', line: '直线', text: '文字', note: '便签',
  image: '图片', select: '选区',
};
function annoKindOf(shape) {
  if (!shape) return '标注';
  if (shape.kind === 'quote') return '摘录';
  if (shape.comment) return '批注';
  if (shape.tool === 'mark' && shape.kind === 'underline') return '下划线';
  if (shape.tool === 'text' || shape.tool === 'note') return ANNO_KIND[shape.tool] || '标注';
  if (shape.tool && shape.tool !== 'select') return ANNO_KIND[shape.tool] || '标注';
  return shape.text ? '高亮' : '选区';
}

function listAllAnnotations() {
  const out = [];
  let dir = '';
  try { dir = annoDir(); } catch (_) { return out; }
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /\.json$/i.test(f)); } catch (_) { return out; }
  for (const f of files) {
    let obj = null;
    try { obj = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { continue; }
    const pages = (obj && Array.isArray(obj.pages)) ? obj.pages : [];
    const filePath = String((obj && obj.path) || '');
    const fileId = f.replace(/\.json$/i, '');
    const parent = filePath ? library.findItemByPath(filePath) : null;
    const parentKey = parent && !parent.deletedAt ? parent.key : '';
    for (const pg of pages) {
      const shapes = (pg && Array.isArray(pg.shapes)) ? pg.shapes : [];
      shapes.forEach((sh, i) => {
        if (!sh) return;
        const text = String(sh.text || '').trim();
        const comment = String(sh.comment || '').trim();
        if (!text && !comment) return;   // 纯涂鸦没有文字，先不进列表
        // 稳定 id：真身上有 id 就用它；没有（还没补过的老标注）退回旧的位置式 id
        const id = String(sh.id || (fileId + ':' + (pg.page || 0) + ':' + i));
        const meta = parentKey ? library.annoMetaOf(id) : null;
        out.push({
          id,
          path: filePath,
          fileName: filePath ? path.basename(filePath) : f,
          page: Number(pg.page) || 0,
          saved: Number(obj && obj.saved) || 0,
          tool: String(sh.tool || ''),
          color: String(sh.color || ''),
          text, comment,
          kind: annoKindOf(sh),
          replyTo: String(sh.replyTo || ''),
          itemKey: (meta && meta.itemKey) || parentKey,
          itemTitle: parent ? (parent.title || '(无标题)') : '',
          updated: (meta && meta.updated) || 0,
        });
      });
    }
  }
  out.sort((a, b) => (a.fileName === b.fileName ? a.page - b.page : a.fileName.localeCompare(b.fileName)));
  return out;
}

// 编辑标注对象：改文字 / 批注 / 颜色。文字与批注同时写回标注真身（阅读器要看到），
// 颜色只存在于真身，库里记一份更新时间。
ipcMain.handle('anno-update', (_e, info) => {
  const id = String((info && info.id) || '').trim();
  if (!id) return { ok: false, error: '标注 id 为空' };
  const patch = (info && info.patch) || {};
  let dir = '';
  try { dir = annoDir(); } catch (_) { return { ok: false, error: '标注目录不可用' }; }
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /\.json$/i.test(f)); } catch (_) { return { ok: false, error: '标注目录不可用' }; }
  let touched = null;
  for (const f of files) {
    const full = path.join(dir, f);
    let obj = null;
    try { obj = JSON.parse(fs.readFileSync(full, 'utf8')); } catch (_) { continue; }
    const pages = Array.isArray(obj && obj.pages) ? obj.pages : [];
    let hit = false;
    for (const pg of pages) {
      for (const sh of (pg && Array.isArray(pg.shapes) ? pg.shapes : [])) {
        if (!sh || String(sh.id || '') !== id) continue;
        if (typeof patch.text === 'string') sh.text = patch.text;
        if (typeof patch.comment === 'string') sh.comment = patch.comment;
        if (typeof patch.color === 'string' && patch.color) sh.color = patch.color;
        hit = true;
      }
    }
    if (hit) {
      try { fs.writeFileSync(full, JSON.stringify(obj)); touched = { path: String(obj.path || '') }; break; } catch (_) {}
    }
  }
  if (!touched) return { ok: false, error: '没找到这条标注（可能已被删除）' };
  const r = library.updateAnno(id, patch);
  if (win) win.webContents.send('lib-changed');
  if (touched.path && win) win.webContents.send('anno-reload', { path: touched.path });
  return Object.assign({ ok: true }, r);
});

// v9：图片标注落盘 —— 灯箱里「存为标注」把这一块图片存进快照目录，
// 并在标注文件对应页写入一条 tool:'image' 形状（位置 = 它在页面上的矩形）。
ipcMain.handle('anno-save-image', (_e, info) => {
  const filePath = String((info && info.path) || '').trim();
  const dataUrl = String((info && info.dataUrl) || '');
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!filePath) return { ok: false, error: '当前没有打开文档' };
  if (!m) return { ok: false, error: '截图数据不合法' };
  const rect = (info && info.rect) || {};
  const x = Number(rect.x) || 0, y = Number(rect.y) || 0;
  const w = Math.max(1, Number(rect.w) || 1), h = Math.max(1, Number(rect.h) || 1);
  const page = Math.max(1, Math.floor(+((info && info.page) || 1)) || 1);
  try {
    const buf = Buffer.from(m[1], 'base64');
    if (buf.length > 12 * 1024 * 1024) return { ok: false, error: '图片太大' };
    const name = 'img-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex') + '.png';
    fs.writeFileSync(path.join(snapshotsDir(), name), buf);
    const rel = 'snapshots/' + name;
    const file = annoFileFor(filePath);
    let obj = { path: filePath, saved: Date.now(), pages: [] };
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && Array.isArray(raw.pages)) obj = raw;
    } catch (_) {}
    let pg = obj.pages.find((p) => Number(p && p.page) === page);
    if (!pg) { pg = { page, shapes: [] }; obj.pages.push(pg); }
    if (!Array.isArray(pg.shapes)) pg.shapes = [];
    const shape = {
      id: genAnnoId(), tool: 'image', color: '#8a7f6a', width: 1,
      image: rel, rects: [{ x, y, w, h }],
      text: String((info && info.text) || ('图片标注 · 第 ' + page + ' 页')),
      comment: '',
    };
    pg.shapes.push(shape);
    obj.saved = Date.now();
    fs.writeFileSync(file, JSON.stringify(obj));
    if (win) win.webContents.send('anno-reload', { path: filePath });
    return { ok: true, id: shape.id, image: rel };
  } catch (err) { return { ok: false, error: String(err && err.message ? err.message : err) }; }
});

// ---------- 从标注生成笔记（v8 阶段二：带页面截图） ----------
function snapshotsDir() {
  const dir = path.join(currentDataDir(), 'snapshots');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}

// 渲染层截好图（dataURL）→ 落盘 PNG → 生成一条带图的库笔记 → 标注记下 noteId
ipcMain.handle('note-from-anno', (_e, info) => {
  const itemKey = String((info && info.itemKey) || '').trim();
  const dataUrl = String((info && info.dataUrl) || '');
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!itemKey) return { ok: false, error: '缺少条目' };
  if (!m) return { ok: false, error: '截图数据不合法' };
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length > 12 * 1024 * 1024) return { ok: false, error: '截图太大' };
  try {
    const name = 'anno-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex') + '.png';
    fs.writeFileSync(path.join(snapshotsDir(), name), buf);
    const rel = 'snapshots/' + name;
    const note = library.addNote(itemKey, {
      title: String((info && info.title) || '').trim(),
      text: String((info && info.text) || '').trim(),
      image: rel,
      annoIds: Array.isArray(info && info.annoIds) ? info.annoIds : [],
    });
    if (note) {
      for (const id of note.annoIds) {
        const meta = library.annoMetaOf(id) || {};
        const ids = (meta.noteIds || []).concat([note.id]);
        library.updateAnno(id, { noteIds: ids, itemKey });
      }
    }
    if (win) win.webContents.send('lib-changed');
    return { ok: true, noteId: note ? note.id : '', image: rel };
  } catch (err) { return { ok: false, error: String(err && err.message ? err.message : err) }; }
});

// 笔记里的截图：渲染层按需读 base64（避免 file:// 在不同安全策略下加载不到）
ipcMain.handle('note-image', (_e, info) => {
  const rel = String((info && info.path) || '');
  if (!rel) return { ok: false, error: '没有图片路径' };
  const abs = path.resolve(currentDataDir(), rel);
  // 只允许读数据目录内的 snapshots，别把任意文件读出来
  if (!abs.startsWith(path.resolve(currentDataDir()) + path.sep)) return { ok: false, error: '路径不合法' };
  try {
    const buf = fs.readFileSync(abs);
    return { ok: true, dataUrl: 'data:image/png;base64,' + buf.toString('base64') };
  } catch (_) { return { ok: false, error: '图片读不到（可能被删了）' }; }
});

// 标注 ↔ 条目双向关联
ipcMain.handle('anno-link', (_e, info) => {
  const id = String((info && info.id) || '').trim();
  if (!id) return { ok: false, error: '标注 id 为空' };
  const itemKey = String((info && info.itemKey) || '').trim();
  const r = itemKey ? library.linkAnnoToItem(id, itemKey) : library.unlinkAnno(id);
  if (win) win.webContents.send('lib-changed');
  return r;
});

ipcMain.handle('anno-list', () => listAllAnnotations());

// ---------- 阅读时长统计（Calibre reading stats 式） ----------
// 存 userData/reading-stats.json（不进 library.json：高频小写会搅乱库文件的保存节奏）。
function readingStatsPath() { return path.join(app.getPath('userData'), 'reading-stats.json'); }

ipcMain.handle('reading-stats-load', () => {
  try {
    const raw = fs.readFileSync(readingStatsPath(), 'utf8');
    return { ok: true, stats: JSON.parse(raw) };
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('[reading-stats] load failed:', err.message);
    return { ok: true, stats: null };
  }
});

ipcMain.handle('reading-stats-merge', (_e, info) => {
  try {
    const ReadingStats = require('./readingstats.js');
    let disk = null;
    try { disk = JSON.parse(fs.readFileSync(readingStatsPath(), 'utf8')); } catch (_) { disk = null; }
    // 渲染进程传来的增量独立累计（见 renderer 侧心跳），与磁盘直接相加
    const merged = ReadingStats.merge(disk, info && info.stats);
    atomicWrite(readingStatsPath(), JSON.stringify(merged));
    return { ok: true, stats: merged };
  } catch (err) { return { ok: false, error: String(err && err.message ? err.message : err) }; }
});

// ---------- RSS 订阅（Zotero Feeds 的本地化实现） ----------
// 按需联网：只在用户添加 / 刷新订阅时拉取，不后台轮询。解析在 feedparse.js（纯逻辑）。
// 拉取用 Node 原生 http/https（不走 Chromium 网络栈）：系统代理会把 127.0.0.1 的本地
// 测试源也劫持掉，而且订阅场景要的是「直连原文」，代理缓存/改写只会添乱。
function feedHttpGet(url, redirects) {
  return new Promise((resolve, reject) => {
    const mod = /^https:\/\//i.test(url) ? require('https') : require('http');
    const req = mod.get(url, { headers: { 'User-Agent': 'Trove/1.0 (local literature library)' }, timeout: 20000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && (redirects || 0) < 4) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        feedHttpGet(next, (redirects || 0) + 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return; }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > 4 * 1024 * 1024) { req.destroy(); reject(new Error('订阅源超过 4MB，不像正常的 RSS')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(new Error('拉取超时（20 秒）')); });
    req.on('error', reject);
  });
}

ipcMain.handle('feed-fetch', async (_e, info) => {
  const url = String((info && info.url) || '').trim();
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: '订阅地址要以 http(s):// 开头' };
  try {
    const xml = await feedHttpGet(url);
    const parsed = require('./feedparse.js').parseFeed(xml);
    if (!parsed.entries.length) return { ok: false, error: '没有解析出任何条目（确认这是 RSS / Atom 源）', kind: parsed.kind };
    return { ok: true, title: parsed.title || url, link: parsed.link, entries: parsed.entries };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});
ipcMain.handle('feed-add', async (_e, info) => {
  const url = String((info && info.url) || '').trim();
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: '订阅地址要以 http(s):// 开头' };
  try {
    const xml = await feedHttpGet(url);
    const parsed = require('./feedparse.js').parseFeed(xml);
    if (!parsed.entries.length) return { ok: false, error: '没有解析出任何条目（确认这是 RSS / Atom 源）' };
    const r = library.addFeed(url, parsed.title || url);
    if (!r.ok) return r;
    if (win) win.webContents.send('lib-changed');
    return { ok: true, feed: r.feed, entries: parsed.entries };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});
ipcMain.handle('feed-remove', (_e, info) => {
  const r = library.removeFeed(info && info.id);
  if (r.ok && win) win.webContents.send('lib-changed');
  return r;
});
ipcMain.handle('anno-set-tags', (_e, info) => {
  if (!info || !info.id) return { ok: false, error: '标注 id 为空' };
  return library.setAnnoTags(info.id, info.tags);
});
ipcMain.handle('anno-add-tags', (_e, info) => {
  if (!info) return { ok: false, updated: 0 };
  return library.addAnnoTags(info.ids, info.tags);
});
ipcMain.handle('anno-remove-tag', (_e, info) => {
  if (!info) return { ok: false };
  return library.removeAnnoTag(info.id, info.tag);
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

// v33：导出一条库内笔记为自包含文件——HTML 自带图片，Markdown 带相对图片目录。
// 正文里的 snapshots/ 引用和 note.image 字段一并带走：复制到 <文件名>.files/，
// 引用改写成相对路径；HTML 里图片用真实 src（Md.render 对本地路径只出 data-md-img 占位，
// 这里渲染后统一换成 src）。缺文件跳过并计数，不静默丢。
ipcMain.handle('export-note-bundle', async (_e, info) => {
  const Md = require('./markdown.js');
  const key = info && info.key;
  const fmt = info && info.fmt === 'md' ? 'md' : 'html';
  const it = key ? library.findItem(key) : null;
  if (!it) return { ok: false, error: '找不到这条笔记所属的条目' };
  const notes = it.notes || [];
  const note = notes.find((n) => n.id === info.noteId) || notes[0];
  if (!note) return { ok: false, error: '这条条目还没有笔记内容' };
  // N02：富文本笔记同时存 html（正文，带标题/加粗/链接）和 text（检索用纯文本）——
  // 导出必须以 html 为源（经 fromHtml 转回 Markdown），用 text 会把结构丢成摘要；
  // Markdown 笔记（html 为空）直接用 text。
  let text = '';
  if (String(note.html || '').trim()) {
    try { text = Md.fromHtml(note.html); } catch (_) { text = ''; }
  }
  if (!text.trim()) text = String(note.text || '');
  // R04/N03：纯截图笔记（正文空、只有批注截图）也允许导出，截图会作为正文插图带出去
  const hasImageField = !!(note.image && /^snapshots\/[^\\/]+$/i.test(String(note.image)));
  if (!text.trim() && !hasImageField) return { ok: false, error: '笔记是空的' };

  // 收集图片引用（数据目录内相对路径，只认 snapshots/ 前缀，和 note-image 的守卫一致）
  const refs = [];
  const seenRef = new Set();
  const addRef = (p) => {
    p = String(p || '');
    if (!/^snapshots\/[^\\/]+$/i.test(p) || seenRef.has(p)) return;
    seenRef.add(p);
    refs.push(p);
  };
  addRef(note.image);
  const imgRe = /!\[[^\]]*\]\((snapshots\/[^)\s]+)\)/g;
  let m;
  while ((m = imgRe.exec(text))) addRef(m[1]);

  const rawTitle = String((info && info.title) || it.title || '未命名笔记').trim() || '未命名笔记';
  const safeTitle = rawTitle.replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 80);
  const ext = fmt === 'md' ? 'md' : 'html';
  let filePath = '';
  if (info && info.outPath) {
    filePath = String(info.outPath);   // 测试 / 脚本直写，不弹对话框
  } else {
    const picked = await dialog.showSaveDialog(win, {
      title: fmt === 'md' ? '导出笔记（Markdown，图片在同目录的 .files 文件夹）' : '导出笔记（HTML，图片在同目录的 .files 文件夹）',
      defaultPath: path.join(appState.lastDir || '', safeTitle + '.' + ext),
      filters: [{ name: fmt === 'md' ? 'Markdown' : 'HTML', extensions: [ext] }],
    });
    if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
    filePath = picked.filePath;
  }

  try {
    const dataRoot = path.resolve(currentDataDir());
    // R03：资源目录名只留对文件系统、Markdown 语法和相对 URL 都安全的字符。
    // 空格、#、%、&、括号会让 Markdown 图片目标失配（正文退化成原始文本）
    // 或破坏相对路径解析；中文 / 数字 / 点 / 连字符保留，其余折叠成 -。
    const filesDirName = (path.basename(filePath, path.extname(filePath))
      .replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[-.]+|[-.]+$/g, '') || 'note') + '.files';
    const filesDir = path.join(path.dirname(filePath), filesDirName);
    const rewrite = new Map();   // snapshots/x.png → <files>/x.png
    let copied = 0, skipped = 0;
    if (refs.length) {
      fs.mkdirSync(filesDir, { recursive: true });
      const used = new Set();
      for (const rel of refs) {
        const src = path.resolve(dataRoot, rel);
        if (!src.startsWith(dataRoot + path.sep) || !fs.existsSync(src)) { skipped++; continue; }
        let name = path.basename(rel);
        if (used.has(name)) {
          const dot = name.lastIndexOf('.');
          name = (dot > 0 ? name.slice(0, dot) : name) + '-' + Date.now().toString(36) + (dot > 0 ? name.slice(dot) : '');
        }
        used.add(name);
        fs.copyFileSync(src, path.join(filesDir, name));
        rewrite.set(rel, filesDirName + '/' + name);
        copied++;
      }
    }
    // 引用改写（Markdown 语法里的链接目标）
    let outText = text.replace(imgRe, (whole, rel) => rewrite.has(rel) ? whole.replace(rel, rewrite.get(rel)) : whole);
    // R04/N03：批注截图存在 note.image 字段、正文里未必有引用——导出时统一带进正文
    //（正文已引用同一张图时不重复插图）。文件已缺失时保留 snapshots/ 原引用：
    // HTML 侧的缺失占位逻辑会把它变成可见的「[图片缺失：…]」，不静默消失。
    if (hasImageField && !text.includes('](' + note.image + ')')) {
      outText = '![' + Md.esc('批注截图') + '](' + (rewrite.get(note.image) || note.image) + ')\n\n' + outText;
    }
    if (fmt === 'md') {
      atomicWrite(filePath, outText);
      appState.lastDir = path.dirname(filePath);
      return { ok: true, path: filePath, images: copied, skipped };
    }
    let html = Md.render(outText);
    // 公式：主进程用 KaTeX 把 data-md-math 占位渲染成最终 HTML。katex 不可用时占位原样保留
    // （等宽源码显示），不算失败。有公式时把 css + woff2 字体带进 <文件名>.files/katex/，
    // 否则别人打开导出文件没有字体，排版会退化。
    let mathCount = 0;
    const decodeEnt = (s) => String(s)
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    try {
      const katex = require('katex/dist/katex.min.js');
      html = html.replace(
        /<span class="md-math"[^>]*?data-md-math="([^"]*)"[^>]*>[\s\S]*?<\/span>|<div class="md-math-block"[^>]*?data-md-math="([^"]*)"[^>]*>[\s\S]*?<\/div>/g,
        (whole, spanSrc, divSrc) => {
          const display = divSrc !== undefined;
          const src = decodeEnt(display ? divSrc : spanSrc);
          try {
            mathCount++;
            return katex.renderToString(src, { displayMode: display, throwOnError: false, strict: false });
          } catch (_) {
            return whole;   // 单条失败退回源码占位，不影响其余公式
          }
        });
    } catch (_) { /* 没有 katex（异常环境）：公式保持源码 */ }
    // R05：独立 HTML 里不能保留应用内部的占位链接（href="javascript:void(0)"，
    // 靠渲染层的 data-md-link 点击代理才可点）。这里按原有协议白名单换成真实 URL，
    // 非法协议维持不可点。GitHub / 音乐卡片走同一个 data-md-link 机制，一并覆盖。
    html = html.replace(/data-md-link="([^"]*)" href="javascript:void\(0\)"/g, (_w, raw) => {
      const href = Md.safeHref(raw);
      return href
        ? 'href="' + href + '" target="_blank" rel="noopener noreferrer"'
        : 'href="javascript:void(0)" data-md-link="' + raw + '"';
    });
    // 本地图片：占位属性换成真实相对 src。注意 Markdown 里的引用已先被改写成
    // <文件名>.files/xxx 路径，所以属性值以图片目录前缀开头的就是复制成功的图；
    // 其余（复制失败保留了 snapshots/ 原路径）给出可见说明，不留破图标。
    html = html.replace(/<img class="md-img" data-md-img="([^"]+)"([^>]*)>/g, (_w, rel, rest) => {
      if (rel.indexOf(filesDirName + '/') === 0) return '<img class="md-img" src="' + rel + '"' + rest + '>';
      return '<span class="md-img-missing">[图片缺失：' + rel + ']</span>';
    });
    // 公式渲染成功过 → 把 KaTeX 的 css 和 woff2 字体带进 .files/katex/，导出文件离线可用。
    // css 里的字体引用是相对路径 url(fonts/...)，保持 css 与 fonts 同级即可，不改写。
    let katexHead = '';
    if (mathCount > 0) {
      const katexDist = path.join(__dirname, '..', 'node_modules', 'katex', 'dist');
      const katexOut = path.join(filesDir, 'katex');
      fs.mkdirSync(katexOut, { recursive: true });
      let fontN = 0;
      try {
        fs.copyFileSync(path.join(katexDist, 'katex.min.css'), path.join(katexOut, 'katex.min.css'));
        const fontsDir = path.join(katexDist, 'fonts');
        fs.mkdirSync(path.join(katexOut, 'fonts'), { recursive: true });
        for (const f of fs.readdirSync(fontsDir)) {
          if (!f.endsWith('.woff2')) continue;
          fs.copyFileSync(path.join(fontsDir, f), path.join(katexOut, 'fonts', f));
          fontN++;
        }
        katexHead = '<link rel="stylesheet" href="' + filesDirName + '/katex/katex.min.css">\n';
      } catch (_) { /* 资源拷贝失败不影响导出：公式结构在，字体退化到系统衬线 */ }
      if (fontN === 0) katexHead = '';   // 没拷到字体就不引用，免得 404
    }
    const page = '<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
      '<title>' + Md.esc(rawTitle) + '</title>\n' + katexHead +
      '<style>body{font-family:Georgia,"Noto Serif SC",serif;max-width:760px;margin:40px auto;padding:0 20px;line-height:1.75;color:#24211d;background:#fdfcf9}' +
      'h1,h2,h3{line-height:1.35}img.md-img{max-width:100%;height:auto}blockquote{margin:1em 0;padding:.4em 1em;border-left:3px solid #c9b98a;background:#f6f1e3;color:#4c4436}' +
      'table{border-collapse:collapse}td,th{border:1px solid #d8d2c4;padding:4px 10px}code{background:#f0ece1;border-radius:3px;padding:1px 5px}' +
      'pre{background:#f0ece1;padding:12px;overflow:auto;border-radius:5px}pre code{padding:0;background:none}' +
      '.md-img-missing{color:#a05a2c;font-size:.9em}.q-from{color:#6f6656;font-size:.92em}</style>\n</head>\n<body>\n' +
      html + '\n</body>\n</html>\n';
    atomicWrite(filePath, page);
    appState.lastDir = path.dirname(filePath);
    return { ok: true, path: filePath, images: copied, skipped, math: mathCount };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
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
      const base = 'Trove-全部批注-' + stamp + '.md';
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

// v26：菜单栏去掉后，这几件事改从界面里发起
// 1) 清空「最近打开」记录（文档快速切换面板上的「清空」）
ipcMain.handle('clear-recent', () => clearRecent());
// 2) 设为默认 PDF 阅读器（设置面板里）
ipcMain.handle('set-default-pdf-reader', async () => {
  const { response } = await dialog.showMessageBox(win, {
    type: 'info',
    title: '设为默认 PDF 阅读器',
    message: 'Windows 不允许程序静默改写默认应用，需要你在设置里点一下。',
    detail: '本程序路径：\n' + process.execPath + '\n\n下一步：在「默认应用」里搜索并选择本程序作为 .pdf 的打开方式。',
    buttons: ['打开 Windows 设置', '复制程序路径', '取消'],
    noLink: true,
  });
  if (response === 0) { shell.openExternal('ms-settings:defaultapps'); return { ok: true, action: 'settings' }; }
  if (response === 1) { clipboard.writeText(process.execPath); return { ok: true, action: 'copied' }; }
  return { ok: false, canceled: true };
});
// 3) 开发者工具（设置面板里 / Ctrl+Shift+I）
ipcMain.handle('open-devtools', () => {
  if (!win) return { ok: false };
  win.webContents.openDevTools({ mode: 'detach' });
  return { ok: true };
});
// 4) 给回归脚本用：菜单栏确实没了
ipcMain.handle('app-info', () => ({
  hasMenu: !!Menu.getApplicationMenu(),
  version: app.getVersion(),
}));

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
    // 选区高亮：矩形已由渲染进程转成 PDF 坐标（左下原点）。
    // 下划线 / 删除线 / 波浪线只画一条线，摘录用更淡的底，和渲染层保持一致。
    for (const r of (sh.rects || [])) {
      if (!(r.w > 0 && r.h > 0)) continue;
      if (sh.kind === 'underline' || sh.kind === 'strike' || sh.kind === 'squiggly') {
        const y = sh.kind === 'strike' ? r.y + r.h / 2 : r.y + Math.min(2, r.h / 3);
        page.drawLine({
          start: { x: r.x, y }, end: { x: r.x + r.w, y },
          color, thickness: 1.4,
          ...(sh.kind === 'squiggly' ? { dashArray: [2, 1.6] } : {}),
        });
      } else {
        page.drawRectangle({
          x: r.x, y: r.y, width: r.w, height: r.h,
          color, opacity: sh.kind === 'quote' ? 0.18 : 0.38,
          borderColor: color, borderWidth: 0.6, borderOpacity: 0.55,
        });
      }
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
    const reasons = [];
    for (const pg of payload.pages) {
      const page = pages[pg.index];
      if (!page) continue;
      for (const sh of pg.shapes) {
        try { drawAnno(page, sh, font, lib); }
        catch (err) {
          skipped++;
          // 只留前几条，够定位是哪类标注失败即可；界面仍然只显示总数。
          if (reasons.length < 5) reasons.push({ tool: sh.tool, kind: sh.kind || '', msg: String(err && err.message ? err.message : err) });
        }
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
    return { ok: true, path: target, skipped, reasons };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
});

// 清空「最近打开」记录（v26：原来在菜单里，现在放在文档快速切换面板上）
function clearRecent() {
  appState.recent = [];
  saveWindowState(appState);
  return { ok: true };
}

// v26：不再用原生菜单栏（文件 / 视图 / 系统 三项）——界面更干净，
// 这些功能分别落在：工具栏「打开」、文档快速切换面板、页面右键菜单、
// 批注面板的导出条、文献库与设置面板里。
function buildMenu() {
  Menu.setApplicationMenu(null);
}

// v26：没有原生菜单栏了，「最近打开」由文档快速切换面板负责，
// 这里只留一个空实现（老调用点不必逐个改）。
function rebuildMenu() {
  // noop
}

app.whenReady().then(() => {
  if (!hasLock) return;
  buildMenu();
  // 冒烟/截图/探针模式一律不起可见窗口，避免测试时屏幕上反复闪窗；
  // PDFREADER_HIDDEN 只隐藏窗口，不影响单实例锁（单实例测试要用）。
  // PDFREADER_PROBE_VISIBLE=1 时例外：窗口照常显示 —— 隐藏窗口不重绘，
  // 靠截图核对「布局类」的界面改动会看到旧帧，需要真实窗口才能验。
  const probeVisible = !!process.env.PDFREADER_PROBE_VISIBLE;
  const headless = (process.env.SMOKE_PDF || process.env.PDFREADER_LIBUI
    || process.env.PDFREADER_PROBE || process.env.PDFREADER_HIDDEN) && !probeVisible;
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
