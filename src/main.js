const { app, BrowserWindow, Menu, ipcMain, dialog, shell, clipboard, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const settings = require('./settings.js');
const fulltext = require('./fulltext.js');
const formats = require('./formats.js');
const metadata = require('./metadata.js');
const fetchpdf = require('./fetchpdf.js');
const pdfmeta = require('./pdfmeta.js');
const docconvert = require('./docconvert.js');
const Cite = require('./cite.js');
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

// v8：从标注生成的笔记带页面截图（PNG 存在数据目录 snapshots/）。
// 备份是单个 JSON，图片以 base64 一起带走，恢复时写回；单份备份最多带 60MB 图。
function readSnapshotBundle() {
  const out = {};
  const dir = path.join(currentDataDir(), 'snapshots');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /\.png$/i.test(f)); } catch (_) { return out; }
  let total = 0;
  for (const f of files) {
    try {
      const buf = fs.readFileSync(path.join(dir, f));
      if (total + buf.length > 60 * 1024 * 1024) break;
      total += buf.length;
      out[f] = buf.toString('base64');
    } catch (_) {}
  }
  return out;
}

function applySnapshotBundle(obj) {
  const dir = path.join(currentDataDir(), 'snapshots');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { return 0; }
  let n = 0;
  for (const name of Object.keys(obj || {})) {
    if (!/\.png$/i.test(name)) continue;   // 只认 png，别被备份里的路径穿越坑到
    try {
      fs.writeFileSync(path.join(dir, path.basename(name)), Buffer.from(obj[name], 'base64'));
      n++;
    } catch (_) {}
  }
  return n;
}

function buildBackupPayload() {
  return {
    app: 'trove',
    format: 1,
    createdAt: new Date().toISOString(),
    settings: settings.get(),
    library: library.exportStore(),
    annotations: readAnnotationBundle(),
    images: readSnapshotBundle(),
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
  try {
    const pre = path.join(currentDataDir(), 'backups', 'pre-restore-' + Date.now() + '.json');
    atomicWrite(pre, JSON.stringify(buildBackupPayload()));
    library.replaceStore(obj.library);
    const n = applyAnnotationBundle(obj.annotations || []);
    const imgs = applySnapshotBundle(obj.images || {});
    const keepDir = settings.get().dataDir;
    if (obj.settings && typeof obj.settings === 'object') {
      settings.set(Object.assign({}, obj.settings, { dataDir: keepDir }));
      appSettings = settings.get();
    }
    fulltext.init(currentDataDir());
    if (win) win.webContents.send('lib-changed');
    return { ok: true, path: file, preBackup: pre, items: obj.library.items.length, annotations: n, images: imgs };
  } catch (err) { return { ok: false, error: String(err && err.message ? err.message : err) }; }
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
    title: '导入题录（BibTeX / RIS / EndNote / RefWorks / CSL-JSON）',
    filters: [
      { name: '题录文件', extensions: ['bib', 'bibtex', 'ris', 'enw', 'refworks', 'json', 'txt'] },
      { name: 'BibTeX', extensions: ['bib', 'bibtex'] },
      { name: 'RIS', extensions: ['ris'] },
      { name: 'EndNote', extensions: ['enw'] },
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
  try {
    const oldAnno = annoFileFor(oldPath);
    if (fs.existsSync(oldAnno)) {
      const obj = JSON.parse(fs.readFileSync(oldAnno, 'utf8'));
      obj.path = newPath;
      fs.writeFileSync(annoFileFor(newPath), JSON.stringify(obj));
      try { fs.unlinkSync(oldAnno); } catch (_) {}
      moved.anno = true;
    }
  } catch (_) {}
  try {
    const oldFt = fulltext.fileFor(oldPath);
    if (fs.existsSync(oldFt)) {
      const obj = JSON.parse(fs.readFileSync(oldFt, 'utf8'));
      obj.path = newPath;
      fs.writeFileSync(fulltext.fileFor(newPath), JSON.stringify(obj));
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
// 回收站：默认“移除”= 软删除；永久删除只删索引，绝不删磁盘 PDF
ipcMain.handle('lib-remove-item', (_e, info) => (info ? library.trashItem(info.key) : null));
ipcMain.handle('lib-trash-item', (_e, info) => (info ? library.trashItem(info.key) : null));
ipcMain.handle('lib-restore-item', (_e, info) => (info ? library.restoreItem(info.key) : null));
ipcMain.handle('lib-delete-item', (_e, info) => (info ? library.deleteItemForever(info.key) : false));
ipcMain.handle('lib-empty-trash', () => ({ removed: library.emptyTrash(), filesKept: true }));
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

function annotationResults(q, ast) {
  const A = ast || query.parseQuery(q);
  const out = [];
  for (const entry of readAnnotationBundle()) {
    const data = entry && entry.data;
    const p = data && data.path;
    if (!p) continue;
    const it = library.findItemByPath(p);
    if (!it || it.deletedAt) continue;
    for (const pg of (data.pages || [])) {
      for (const sh of (pg && pg.shapes) || []) {
        const text = [sh.text, sh.comment].filter(Boolean).join(' ').trim();
        if (!text) continue;
        const hay = query.fold(text);
        if (!query.matchTokens(hay, A.text)) continue;   // 短语/排除都在这
        out.push({
          key: it.key, title: it.title || '(无标题)', page: pg.page || 1,
          type: 'annotation', label: sh.comment ? '批注' : '摘录',
          snippet: makeSnippet(text, A), path: p,
        });
      }
    }
  }
  return out;
}

function noteResults(q, ast) {
  const A = ast || query.parseQuery(q);
  const out = [];
  for (const it of library.summary().items) {
    if (it.deletedAt) continue;
    for (const n of it.notes || []) {
      const hay = [n.title, n.text].filter(Boolean).join(' ');
      if (!hay) continue;
      if (!query.matchTokens(query.fold(hay), A.text)) continue;
      out.push({
        key: it.key, title: it.title || '(无标题)', page: it.page || 1,
        type: 'note', label: '笔记', noteId: n.id,
        snippet: makeSnippet(hay, A), path: (it.attachment && it.attachment.path) || '',
      });
    }
  }
  return out;
}

function fulltextResults(queryRaw) {
  const ast = query.parseQuery(queryRaw);
  const hit = fulltext.search(queryRaw);
  const out = [];
  const seen = new Set();
  // 带字段限定（title:/author:/tag:…）时，正文命中还要过一遍条目字段；
  // 只有字段限定、没有正文词时，直接按条目级字段过滤出结果。
  const hasFields = Object.keys(ast.fields || {}).length > 0;
  const filterItem = (it) => query.matchFieldsNot(it, ast);
  if (hasFields && !ast.text.length) {
    for (const it of library.summary().items) {
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
      if (out.length >= 120) break;
    }
    return { ok: true, query: ast.raw, results: out, stats: hit.stats };
  }
  for (const r of hit.results) {
    const it = library.findItemByPath(r.path);
    if (!it || it.deletedAt) continue;
    if (hasFields && !filterItem(it)) continue;
    const id = 'ft:' + it.key + ':' + r.page;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      key: it.key, title: it.title || '(无标题)', page: r.page,
      type: 'fulltext', label: '全文',
      snippet: r.snippet, count: r.count, path: r.path,
    });
    if (out.length >= 120) break;
  }
  if (out.length < 120 && String(queryRaw || '').trim()) {
    for (const r of annotationResults(queryRaw, ast)) {
      const it = library.findItemByPath(r.path);
      if (hasFields && (!it || !query.matchFieldsNot(it, ast))) continue;
      const id = 'an:' + r.key + ':' + r.page + ':' + r.snippet;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(r);
      if (out.length >= 120) break;
    }
  }
  if (out.length < 120 && String(queryRaw || '').trim()) {
    for (const r of noteResults(queryRaw, ast)) {
      const it = library.findItemByPath(r.path);
      if (hasFields && (!it || !query.matchFieldsNot(it, ast))) continue;
      const id = 'nt:' + r.key + ':' + r.noteId;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(r);
      if (out.length >= 120) break;
    }
  }
  return { ok: true, query: ast.raw, results: out, stats: hit.stats };
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

// v9：抓 PDF 全文（arXiv → Unpaywall → 直链/doi.org 依次尝试），成功就挂到条目上
ipcMain.handle('lib-fetch-pdf', async (_e, info) => {
  const key = String((info && info.key) || '').trim();
  const it = key ? library.findItem(key) : null;
  if (!it) return { ok: false, error: '条目不存在' };
  if (it.deletedAt) return { ok: false, error: '回收站里的条目不能抓取' };
  const custom = String((info && info.url) || '').trim();
  const src = {
    doi: it.doi || '',
    arxivId: fetchpdf.arxivIdFromUrl((it.fields && it.fields.arxivId) || it.url || ''),
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
    library.setAttachment(key, r.path);
    if (win) win.webContents.send('lib-changed');
  } catch (err) {
    return { ok: false, error: '下载成功但挂载失败：' + (err && err.message ? err.message : err) };
  }
  return { ok: true, path: r.path, source: r.source, bytes: r.bytes, tried: r.tried };
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
  const markdown = info.format !== 'text';
  const base = String(info.defaultName || ('Trove-参考文献-' + new Date().toISOString().slice(0, 10)))
    .replace(/[\\/:*?"<>|]/g, '-').replace(/\.(md|txt)$/i, '');
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: '保存参考文献表',
    defaultPath: path.join(appState.lastBackupDir || '', base + (markdown ? '.md' : '.txt')),
    filters: markdown
      ? [{ name: 'Markdown', extensions: ['md'] }, { name: '纯文本', extensions: ['txt'] }]
      : [{ name: '纯文本', extensions: ['txt'] }, { name: 'Markdown', extensions: ['md'] }],
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
    // 兜底：渲染层没带 id 的形状顺手补上（新建标注由渲染层生成 id，这里是保险）
    ensureAnnoIds(obj, '', () => {});
    fs.writeFileSync(annoFileFor(info.path), JSON.stringify(obj));
    return true;
  } catch (err) { return { error: String(err && err.message ? err.message : err) }; }
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
