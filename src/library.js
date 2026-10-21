'use strict';
/*
 * 本地文献库 v3（继续对齐 Zotero 的数据模型，零原生依赖）。
 * 存储：userData/library.json（测试可用 env PDFREADER_LIBRARY 覆盖路径，互不污染）。
 * 数据形状（v3）：
 *   { version, collections:[{id,name,parentId}], searches:[{id,name,query}], items:[{
 *       key, itemType, title, creators:[str], year, publication, volume, issue,
 *       pages, doi, url, abstract, note, language, tags:[str], collectionIds:[str],
 *       attachment:{path,name}, page, created, updated, deletedAt
 *   }] }
 *
 * 相对 v2 的变化：
 *   - 新增 searches（智能收藏集 = 保存的搜索条件）。
 *   - 新增批量更新、查重合并、BibTeX/RIS 导入所需的辅助接口，数据形状保持兼容。
 *
 * 兼容策略：读到 v1/v2 数据时先自动备份原始文件，再迁移到 v3；旧文件无需手工处理。
 * 原则：附件只“引用”磁盘路径，永不删改用户的 PDF；写盘原子 + 读盘损坏自愈。
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const VERSION = 3;
const BACKUP_KEEP = 10;

// 只保留自用文献最常用的几类；label 交给 UI 直接显示，避免两处各写一份映射
const ITEM_TYPES = [
  { id: 'journalArticle', label: '期刊文章' },
  { id: 'conferencePaper', label: '会议论文' },
  { id: 'book', label: '图书' },
  { id: 'thesis', label: '学位论文' },
  { id: 'report', label: '报告' },
  { id: 'webpage', label: '网页' },
  { id: 'document', label: '文档' },
];
const ITEM_TYPE_IDS = new Set(ITEM_TYPES.map((t) => t.id));

let FILE = null; // 由 init() 设定；测试里可覆盖

function defaultFile() {
  // 主进程里由 init() 注入真实 userData 路径；未注入时兜底到临时目录，绝不写到工程里
  const os = require('os');
  return path.join(os.tmpdir(), 'pdfreader-library-default.json');
}

function init(userDataDir) {
  if (process.env.PDFREADER_LIBRARY) {
    FILE = process.env.PDFREADER_LIBRARY;
  } else if (userDataDir) {
    FILE = path.join(userDataDir, 'library.json');
  } else {
    FILE = defaultFile();
  }
  return FILE;
}

function filePath() { return FILE || init(null); }

function emptyStore() { return { version: VERSION, collections: [], searches: [], items: [] }; }

// 版本迁移前把原始文件复制到 <库目录>/backups/，只保留最近 BACKUP_KEEP 份。
// 迁移写盘失败也不影响本次读取：缓存里已经是迁移后的结构。
function backupRaw(raw, label) {
  try {
    const p = filePath();
    const dir = path.join(path.dirname(p), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(dir, 'library-' + (label || 'pre-migration') + '-' + ts + '.json');
    fs.writeFileSync(target, raw);
    const olds = fs.readdirSync(dir).filter((f) => /^library-.*\.json$/.test(f)).sort();
    while (olds.length > BACKUP_KEEP) {
      try { fs.unlinkSync(path.join(dir, olds.shift())); } catch (_) {}
    }
    return target;
  } catch (err) {
    console.warn('[library] migration backup failed:', err && err.message);
    return null;
  }
}

// 读一次缓存住；损坏时把坏文件改名留证，再从空库开始，绝不让 app 崩溃
let cache = null;
function load() {
  if (cache) return cache;
  const p = filePath();
  let raw = '';
  try {
    raw = fs.readFileSync(p, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); // 容忍 UTF-8 BOM（记事本/PowerShell 常加）
    const obj = JSON.parse(raw);
    const oldVersion = Number.isFinite(+obj.version) ? +obj.version : 1;
    cache = normalize(obj);
    if (oldVersion < VERSION) {
      backupRaw(raw, 'pre-v' + oldVersion);
      save(); // 立刻落成当前版本，避免每次启动重复迁移/备份
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // 存在但解析失败 → 备份坏文件
      try { fs.copyFileSync(p, p + '.corrupt-' + Date.now()); } catch (_) {}
    }
    cache = emptyStore();
  }
  return cache;
}

function normalizeCollections(raw) {
  const src = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const out = [];
  for (const c of src) {
    if (!c || !c.id || seen.has(String(c.id))) continue;
    seen.add(String(c.id));
    out.push({
      id: String(c.id),
      name: String(c.name == null ? '未命名' : c.name).trim() || '未命名',
      parentId: c.parentId ? String(c.parentId) : null,
    });
  }
  // 父级不存在 → 回落成顶层；父链成环 → 断开，避免侧栏无限缩进/死循环
  const byId = new Map(out.map((c) => [c.id, c]));
  for (const c of out) {
    if (c.parentId && !byId.has(c.parentId)) c.parentId = null;
    const walked = new Set([c.id]);
    let p = c.parentId;
    while (p) {
      if (walked.has(p)) { c.parentId = null; break; }
      walked.add(p);
      p = (byId.get(p) || {}).parentId || null;
    }
  }
  return out;
}

function normalizeSearches(raw) {
  const src = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const out = [];
  for (const s of src) {
    if (!s || !s.id || seen.has(String(s.id))) continue;
    const query = str(s.query);
    if (!query) continue;
    seen.add(String(s.id));
    out.push({ id: String(s.id), name: str(s.name) || query, query });
  }
  return out;
}

function normalize(o) {
  const s = emptyStore();
  if (o && typeof o === 'object') {
    s.collections = normalizeCollections(o.collections);
    s.searches = normalizeSearches(o.searches);
    if (Array.isArray(o.items)) s.items = o.items.filter((it) => it && it.key).map(migrateItem);
  }
  return s;
}

const str = (v) => (v == null ? '' : String(v).trim());
const strList = (v) => {
  if (!Array.isArray(v)) return [];
  const out = [];
  const seen = new Set();
  for (const x of v) {
    const t = str(x);
    if (t && !seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out;
};

// 向前兼容：补齐缺字段，避免旧数据让新代码读到 undefined；v1 的 collectionId 迁入数组
function migrateItem(it) {
  const src = it && typeof it === 'object' ? it : {};
  const x = Object.assign({
    itemType: 'document', title: '', creators: [], year: '', publication: '',
    volume: '', issue: '', pages: '', doi: '', url: '', abstract: '', note: '',
    language: '', tags: [], collectionIds: [], attachment: null, page: 0,
    created: 0, updated: 0, deletedAt: 0,
  }, src);

  x.itemType = ITEM_TYPE_IDS.has(src.itemType) ? src.itemType : 'document';
  for (const k of ['title', 'year', 'publication', 'volume', 'issue', 'pages', 'doi', 'url', 'abstract', 'note', 'language']) {
    x[k] = str(src[k]);
  }
  // DOI 统一成裸标识符（去掉 https://doi.org/ 与 doi: 前缀），查重/导出才不会出现两种写法
  x.doi = normDoi(src.doi);
  x.creators = strList(src.creators);
  x.tags = strList(src.tags);

  if (Array.isArray(src.collectionIds)) x.collectionIds = strList(src.collectionIds);
  else if (src.collectionId) x.collectionIds = [String(src.collectionId)];
  else x.collectionIds = [];
  delete x.collectionId;

  x.attachment = (src.attachment && src.attachment.path)
    ? { path: String(src.attachment.path), name: String(src.attachment.name || path.basename(String(src.attachment.path))) }
    : null;
  x.page = Number.isFinite(+src.page) ? Math.max(0, Math.floor(+src.page)) : 0;
  x.created = Number.isFinite(+src.created) ? +src.created : 0;
  x.updated = Number.isFinite(+src.updated) ? +src.updated : 0;
  x.deletedAt = Number.isFinite(+src.deletedAt) && +src.deletedAt > 0 ? +src.deletedAt : 0;
  return x;
}

// 原子写：先写 tmp 再替换；Windows 上 rename 目标已存在时可能失败，退回直写
function save() {
  const p = filePath();
  const tmp = p + '.tmp';
  const store = load();
  store.version = VERSION;
  const json = JSON.stringify(store, null, 0);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(tmp, json);
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
      fs.renameSync(tmp, p);
    } catch (_) {
      fs.writeFileSync(p, json);
    }
    return true;
  } catch (err) {
    console.error('[library] save failed:', err && err.message);
    return false;
  }
}

function genKey() {
  // 8 位类 Zotero key（去掉易混字符）
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += alphabet[bytes[i] % alphabet.length];
  // 撞了就重来
  return load().items.some((x) => x.key === s) || load().collections.some((c) => c.id === s) ? genKey() : s;
}

function now() { return Date.now(); }

function findItem(key) { return load().items.find((x) => x.key === key) || null; }
function findCollection(id) { return load().collections.find((c) => c.id === id) || null; }

// 从文件名猜标题：去扩展名、去下划线/连字符、去开头数字前缀
function guessTitleFromPath(p) {
  const base = path.basename(p).replace(/\.pdf$/i, '');
  return base.replace(/^[\s\-_0-9]+/, '').replace(/[_]+/g, ' ').trim() || base;
}

// 收藏集 id 只接受当前真实存在的集合，避免脏数据把条目挂到幽灵集合
function validCollectionIds(ids) {
  const all = new Set(load().collections.map((c) => c.id));
  return strList(ids).filter((id) => all.has(id));
}

function addItem(fields) {
  const s = load();
  const it = migrateItem(Object.assign({ key: genKey(), created: now(), updated: now() }, fields));
  it.collectionIds = validCollectionIds(it.collectionIds);
  s.items.unshift(it);
  save();
  return it;
}

// 拖入/导入一个 PDF → 建条目（附件引用该路径）
function addPdf(filePathArg, opts) {
  const abs = path.resolve(filePathArg);
  const o = opts || {};
  return addItem({
    itemType: o.itemType || 'document',
    title: o.title || guessTitleFromPath(abs),
    creators: Array.isArray(o.creators) ? o.creators : [],
    year: o.year || '',
    publication: o.publication || '',
    collectionIds: o.collectionIds || (o.collectionId ? [o.collectionId] : []),
    attachment: { path: abs, name: path.basename(abs) },
  });
}

function updateItem(key, patch) {
  const it = findItem(key);
  if (!it) return null;
  // 只允许改这些字段；attachment/回收站状态走专门接口，防止误覆盖
  const textFields = ['title', 'year', 'publication', 'volume', 'issue', 'pages', 'doi', 'url', 'abstract', 'note', 'language'];
  for (const k of textFields) if (k in patch) it[k] = str(patch[k]);
  if ('doi' in patch) it.doi = normDoi(patch.doi);
  if ('itemType' in patch) it.itemType = ITEM_TYPE_IDS.has(patch.itemType) ? patch.itemType : 'document';
  if ('creators' in patch) it.creators = strList(patch.creators);
  if ('tags' in patch) it.tags = strList(patch.tags);
  if ('collectionIds' in patch) it.collectionIds = validCollectionIds(patch.collectionIds);
  if ('page' in patch && Number.isFinite(+patch.page)) it.page = Math.max(0, Math.floor(+patch.page));
  it.updated = now();
  save();
  return it;
}

// ---------- 回收站（软删除） ----------
// 移入回收站只改索引，不碰磁盘 PDF；条目仍保留全部元数据，可原样还原。
function trashItem(key) {
  const it = findItem(key);
  if (!it) return null;
  if (!it.deletedAt) it.deletedAt = now();
  it.updated = now();
  save();
  return it;
}
function restoreItem(key) {
  const it = findItem(key);
  if (!it) return null;
  it.deletedAt = 0;
  it.updated = now();
  save();
  return it;
}
// 永久删除“索引记录”，绝不删除磁盘上的 PDF
function deleteItemForever(key) {
  const s = load();
  const before = s.items.length;
  s.items = s.items.filter((x) => x.key !== key);
  const removed = s.items.length !== before;
  if (removed) save();
  return removed;
}
function emptyTrash() {
  const s = load();
  const n = s.items.filter((x) => x.deletedAt).length;
  if (n) {
    s.items = s.items.filter((x) => !x.deletedAt);
    save();
  }
  return n;
}

// 兼容旧调用：显式“移除”仍然表示永久删记录（UI 已改用 trashItem）
function removeItem(key) { return deleteItemForever(key); }

function addTag(key, tag) {
  const it = findItem(key); if (!it) return null;
  const t = String(tag || '').trim(); if (!t) return it;
  if (!it.tags.includes(t)) it.tags.push(t);
  it.updated = now(); save(); return it;
}
function removeTag(key, tag) {
  const it = findItem(key); if (!it) return null;
  it.tags = it.tags.filter((x) => x !== tag);
  it.updated = now(); save(); return it;
}

// v21：标签重命名（改所有条目上的同名标签）
function renameTag(from, to) {
  const a = String(from || '').trim();
  const b = String(to || '').trim();
  if (!a || !b || a === b) return { ok: false, error: '标签名不对' };
  const s = load();
  let n = 0;
  for (const it of s.items) {
    if (!Array.isArray(it.tags) || it.tags.indexOf(a) < 0) continue;
    it.tags = it.tags.filter((x) => x !== a);
    if (it.tags.indexOf(b) < 0) it.tags.push(b);
    it.updated = now();
    n++;
  }
  save();
  return { ok: true, renamed: n, from: a, to: b };
}

// v21：把标签从所有条目上移除（不是删条目）
function removeTagEverywhere(tag) {
  const t = String(tag || '').trim();
  if (!t) return { ok: false, error: '标签名不对' };
  const s = load();
  let n = 0;
  for (const it of s.items) {
    if (!Array.isArray(it.tags) || it.tags.indexOf(t) < 0) continue;
    it.tags = it.tags.filter((x) => x !== t);
    it.updated = now();
    n++;
  }
  save();
  return { ok: true, removed: n, tag: t };
}

// v21：把标签 A 合并进标签 B（所有条目）
function mergeTags(from, into) {
  const a = String(from || '').trim();
  const b = String(into || '').trim();
  if (!a || !b || a === b) return { ok: false, error: '标签名不对' };
  const s = load();
  let n = 0;
  for (const it of s.items) {
    if (!Array.isArray(it.tags) || it.tags.indexOf(a) < 0) continue;
    it.tags = it.tags.filter((x) => x !== a);
    if (it.tags.indexOf(b) < 0) it.tags.push(b);
    it.updated = now();
    n++;
  }
  save();
  return { ok: true, merged: n, from: a, into: b };
}

function addCollection(name, parentId) {
  const pid = parentId && findCollection(parentId) ? parentId : null;
  const c = { id: genKey(), name: String(name || '未命名').trim() || '未命名', parentId: pid };
  load().collections.push(c); save(); return c;
}
// 删收藏集：不删条目、不删文件。被删集合从条目的 collectionIds 里移除；
// 若条目因此一个集合都不剩，且被删集合有父级，则回落到父级（v9 的既有行为）。
function removeCollection(id) {
  const s = load();
  const col = findCollection(id); if (!col) return false;
  const childIds = new Set([id]);
  let grew = true;
  while (grew) { // 连子集合一起找
    grew = false;
    for (const c of s.collections) if (!childIds.has(c.id) && childIds.has(c.parentId)) { childIds.add(c.id); grew = true; }
  }
  s.collections = s.collections.filter((c) => !childIds.has(c.id));
  for (const it of s.items) {
    if (!it.collectionIds.some((cid) => childIds.has(cid))) continue;
    it.collectionIds = it.collectionIds.filter((cid) => !childIds.has(cid));
    if (!it.collectionIds.length && col.parentId) it.collectionIds = [col.parentId];
    it.updated = now();
  }
  save(); return true;
}

function setCollections(key, ids) {
  const it = findItem(key); if (!it) return null;
  it.collectionIds = validCollectionIds(ids);
  it.updated = now(); save(); return it;
}
// 兼容 v9 的单选“移动”：语义收敛为“只属于这一个集合”
function moveItem(key, collectionId) {
  return setCollections(key, collectionId ? [collectionId] : []);
}

// 附件移动后重新定位：只改索引里的路径，不复制/移动用户文件
function setAttachment(key, filePathArg) {
  const it = findItem(key); if (!it || !filePathArg) return null;
  const abs = path.resolve(filePathArg);
  it.attachment = { path: abs, name: path.basename(abs) };
  it.updated = now(); save(); return it;
}

// 供 set-page / 打开时定位条目
function findItemByPath(p) {
  if (!p) return null;
  const abs = path.resolve(p);
  return load().items.find((x) => x.attachment && path.resolve(x.attachment.path) === abs) || null;
}
function setPageByKey(key, page) {
  const it = findItem(key); if (!it) return null;
  it.page = page; save(); return it;
}

function publicItem(it, collIds) {
  return {
    key: it.key, itemType: it.itemType, title: it.title, creators: it.creators.slice(),
    year: it.year, publication: it.publication, volume: it.volume, issue: it.issue,
    pages: it.pages, doi: it.doi, url: it.url, abstract: it.abstract, note: it.note,
    language: it.language, tags: it.tags.slice(),
    collectionIds: it.collectionIds.filter((id) => collIds.has(id)),
    page: it.page || 0, created: it.created || 0, updated: it.updated || 0,
    deletedAt: it.deletedAt || 0,
    hasFile: !!(it.attachment && fs.existsSync(it.attachment.path)),
    attachment: it.attachment,
  };
}

function summary() {
  const s = load();
  const collIds = new Set(s.collections.map((c) => c.id));
  return {
    version: VERSION,
    itemTypes: ITEM_TYPES.map((t) => ({ id: t.id, label: t.label })),
    collections: s.collections.slice(),
    searches: s.searches.slice(),
    items: s.items.map((it) => publicItem(it, collIds)),
    trashCount: s.items.filter((x) => x.deletedAt).length,
  };
}

// ---------- 备份 / 恢复 / 数据目录 ----------
function exportStore() {
  return JSON.parse(JSON.stringify(load()));
}

function replaceStore(obj) {
  cache = normalize(obj);
  save();
  return summary();
}

// 把另一个库合并进来：同 id 的集合/搜索保留当前值，同 key 的条目跳过，避免恢复时把当前库清空。
function mergeStore(obj) {
  const cur = load();
  const inc = normalize(obj);
  const collIds = new Set(cur.collections.map((c) => c.id));
  for (const c of inc.collections) {
    if (!collIds.has(c.id)) { cur.collections.push(c); collIds.add(c.id); }
  }
  const searchIds = new Set(cur.searches.map((x) => x.id));
  for (const x of inc.searches) if (!searchIds.has(x.id)) { cur.searches.push(x); searchIds.add(x.id); }
  const itemKeys = new Set(cur.items.map((x) => x.key));
  let added = 0;
  for (const it of inc.items) {
    if (itemKeys.has(it.key)) continue;
    it.collectionIds = it.collectionIds.filter((id) => collIds.has(id));
    cur.items.push(it);
    itemKeys.add(it.key);
    added++;
  }
  save();
  return { addedItems: added, addedCollections: inc.collections.length, addedSearches: inc.searches.length };
}

function backupNow(label) {
  try {
    const p = filePath();
    const raw = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : JSON.stringify(load());
    return backupRaw(raw, label || 'manual');
  } catch (_) { return null; }
}

// ---------- 智能收藏集（保存的搜索） ----------
function addSearch(name, query) {
  const q = str(query);
  if (!q) return null;
  const s = load();
  const x = { id: genKey(), name: str(name) || q, query: q };
  s.searches.push(x);
  save();
  return x;
}
function removeSearch(id) {
  const s = load();
  const before = s.searches.length;
  s.searches = s.searches.filter((x) => x.id !== id);
  if (s.searches.length !== before) save();
  return s.searches.length !== before;
}

// ---------- 批量编辑 / 批量回收站 ----------
function bulkUpdate(keys, patch) {
  const set = new Set(keys || []);
  const p = patch || {};
  const s = load();
  const textFields = ['title', 'year', 'publication', 'volume', 'issue', 'pages', 'doi', 'url', 'abstract', 'note', 'language'];
  let n = 0;
  for (const it of s.items) {
    if (!set.has(it.key) || it.deletedAt) continue;
    for (const k of textFields) if (k in p) it[k] = str(p[k]);
    if ('doi' in p) it.doi = normDoi(p.doi);
    if ('itemType' in p) it.itemType = ITEM_TYPE_IDS.has(p.itemType) ? p.itemType : it.itemType;
    if ('creators' in p) it.creators = strList(p.creators);
    if ('tags' in p) it.tags = strList(p.tags);
    if (Array.isArray(p.addTags)) for (const t of strList(p.addTags)) if (!it.tags.includes(t)) it.tags.push(t);
    if (Array.isArray(p.removeTags)) it.tags = it.tags.filter((t) => !p.removeTags.includes(t));
    if (Array.isArray(p.addCollectionIds)) {
      for (const id of validCollectionIds(p.addCollectionIds)) if (!it.collectionIds.includes(id)) it.collectionIds.push(id);
    }
    if (Array.isArray(p.removeCollectionIds)) it.collectionIds = it.collectionIds.filter((id) => !p.removeCollectionIds.includes(id));
    if ('collectionIds' in p) it.collectionIds = validCollectionIds(p.collectionIds);
    it.updated = now();
    n++;
  }
  if (n) save();
  return { updated: n };
}

function trashItems(keys) {
  const set = new Set(keys || []);
  let n = 0;
  for (const it of load().items) {
    if (!set.has(it.key) || it.deletedAt) continue;
    it.deletedAt = now();
    it.updated = now();
    n++;
  }
  if (n) save();
  return { trashed: n };
}

// ---------- 查重 / 合并 ----------
function normTitle(t) {
  return str(t).toLowerCase().replace(/[\s\-_.,:;!?()[\]{}'"“”‘’·]+/g, '');
}
function normDoi(d) {
  return str(d).toLowerCase().replace(/^https?:\/\/doi\.org\//, '').replace(/^doi:\s*/, '').trim();
}

function findDuplicates() {
  const items = load().items.filter((x) => !x.deletedAt);
  const byKey = new Map(items.map((x) => [x.key, x]));
  const parent = new Map();
  const reasons = new Map();
  const find = (k) => {
    let r = k;
    while (parent.get(r) && parent.get(r) !== r) r = parent.get(r);
    while (parent.get(k) && parent.get(k) !== k) { const n = parent.get(k); parent.set(k, r); k = n; }
    return r;
  };
  const union = (a, b, why) => {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a), rb = find(b);
    if (ra !== rb) {
      parent.set(rb, ra);
      // 根合并时把旧根上的原因并过来，否则原因会随根变化而丢失
      const old = reasons.get(rb);
      if (old) {
        if (!reasons.has(ra)) reasons.set(ra, new Set());
        for (const x of old) reasons.get(ra).add(x);
        reasons.delete(rb);
      }
    }
    const root = find(a);
    if (!reasons.has(root)) reasons.set(root, new Set());
    reasons.get(root).add(why);
  };
  const doiMap = new Map(), titleMap = new Map();
  for (const it of items) {
    const doi = normDoi(it.doi);
    if (doi) {
      if (doiMap.has(doi)) union(doiMap.get(doi), it.key, 'DOI 相同');
      else doiMap.set(doi, it.key);
    }
    const nt = normTitle(it.title);
    if (nt.length >= 4) {
      const k = nt + '|' + str(it.year);
      if (titleMap.has(k)) union(titleMap.get(k), it.key, '标题+年份相同');
      else titleMap.set(k, it.key);
    }
  }
  const groups = new Map();
  for (const it of items) {
    const root = find(it.key);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(it.key);
  }
  return [...groups.values()].filter((keys) => keys.length > 1).map((keys) => ({
    keys,
    reasons: [...(reasons.get(find(keys[0])) || new Set())],
    items: keys.map((k) => {
      const it = byKey.get(k);
      return { key: k, title: it.title, year: it.year, doi: it.doi, hasFile: !!(it.attachment && fs.existsSync(it.attachment.path)) };
    }),
  }));
}

function mergeItems(keepKey, otherKeys) {
  const keep = findItem(keepKey);
  if (!keep) return null;
  const drop = new Set((otherKeys || []).filter((k) => k && k !== keepKey));
  const others = load().items.filter((x) => drop.has(x.key));
  const textFields = ['title', 'year', 'publication', 'volume', 'issue', 'pages', 'doi', 'url', 'abstract', 'note', 'language'];
  for (const other of others) {
    for (const k of textFields) if (!keep[k] && other[k]) keep[k] = other[k];
    for (const c of other.creators) if (!keep.creators.includes(c)) keep.creators.push(c);
    for (const t of other.tags) if (!keep.tags.includes(t)) keep.tags.push(t);
    for (const id of other.collectionIds) if (!keep.collectionIds.includes(id)) keep.collectionIds.push(id);
    if (keep.itemType === 'document' && other.itemType !== 'document') keep.itemType = other.itemType;
    if (!keep.attachment && other.attachment) keep.attachment = other.attachment;
    else if (keep.attachment && !fs.existsSync(keep.attachment.path) && other.attachment && fs.existsSync(other.attachment.path)) keep.attachment = other.attachment;
    if (!keep.page && other.page) keep.page = other.page;
  }
  if (drop.size) {
    const s = load();
    s.items = s.items.filter((x) => !drop.has(x.key));
  }
  keep.collectionIds = validCollectionIds(keep.collectionIds);
  keep.updated = now();
  save();
  return summary().items.find((x) => x.key === keepKey) || null;
}

// ---------- BibTeX/RIS 导入 ----------
function importItems(records, opts) {
  const o = opts || {};
  const skipDuplicates = o.skipDuplicates !== false;
  const s = load();
  const dois = new Set(s.items.filter((x) => !x.deletedAt && normDoi(x.doi)).map((x) => normDoi(x.doi)));
  const titles = new Set(s.items.filter((x) => !x.deletedAt).map((x) => normTitle(x.title) + '|' + str(x.year)));
  let added = 0, skipped = 0;
  const keys = [];
  for (const r of records || []) {
    if (!r || !str(r.title)) { skipped++; continue; }
    const doi = normDoi(r.doi);
    const key = normTitle(r.title) + '|' + str(r.year);
    if (skipDuplicates && ((doi && dois.has(doi)) || titles.has(key))) { skipped++; continue; }
    const it = migrateItem(Object.assign({ key: genKey(), created: now(), updated: now() }, r));
    it.collectionIds = validCollectionIds(it.collectionIds);
    s.items.unshift(it);
    if (doi) dois.add(doi);
    titles.add(key);
    keys.push(it.key);
    added++;
  }
  if (added) save();
  return { added, skipped, keys };
}

module.exports = {
  init, filePath, load, save, summary,
  addPdf, addItem, updateItem, removeItem,
  trashItem, restoreItem, deleteItemForever, emptyTrash,
  findItem, findItemByPath, setPageByKey,
  addTag, removeTag, renameTag, removeTagEverywhere, mergeTags,
  addCollection, removeCollection, moveItem, setCollections, setAttachment,
  addSearch, removeSearch,
  bulkUpdate, trashItems, findDuplicates, mergeItems, importItems,
  exportStore, replaceStore, mergeStore, backupNow,
  guessTitleFromPath, ITEM_TYPES,
  resetCache() { cache = null; }, // 测试钩子：模拟新进程从磁盘重载
};
