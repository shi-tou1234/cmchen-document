'use strict';
/*
 * 本地文献库 v6（继续对齐 Zotero 的数据模型，零原生依赖）。
 * 存储：userData/library.json（测试可用 env PDFREADER_LIBRARY 覆盖路径，互不污染）。
 * 数据形状（v6）：
 *   { version, tagColors:{[tag]:#rrggbb},
 *     collections:[{id,name,parentId,color}], searches:[{id,name,query}], items:[{
 *       key, itemType, title, creators:[{firstName,lastName,creatorType}], year, publication,
 *       volume, issue, pages, doi, url, abstract, note, language, tags:[str], collectionIds:[str],
 *       fields:{publisher,place,isbn,...}, relations:[key], notes:[{id,title,text}],
 *       attachment:{path,name}, page, created, updated, deletedAt
 *   }] }
 *
 * 相对 v5 的变化：
 *   - creators 从字符串数组变成结构化对象（姓 / 名 / 角色），见 creators.js；
 *     旧库读进来时自动拆分升级，原文件先备份，不需要手工处理。
 *
 * 相对 v4 的变化：
 *   - 条目类型从 12 类扩到 30+ 类；新增按类型的通用 fields 对象。
 *   - 收藏集支持颜色，标签支持全局颜色映射 tagColors。
 *   - 新增相关条目 relations（双向），供“相关条目”面板使用。
 *
 * 兼容策略：读到低版本数据时先自动备份原始文件，再迁移到当前版本；旧文件无需手工处理。
 * 原则：附件只“引用”磁盘路径，永不删改用户的文件；写盘原子 + 读盘损坏自愈。
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Creators = require('./creators.js');

const VERSION = 8;
const BACKUP_KEEP = 10;

// v5：补齐 Zotero 常用的条目类型（30+），让导入 BibTeX/RIS/CSL-JSON 时不至于全被压成「文档」。
// label 交给 UI 直接显示，避免两处各写一份映射。
const ITEM_TYPES = [
  { id: 'journalArticle', label: '期刊文章' },
  { id: 'magazineArticle', label: '杂志文章' },
  { id: 'newspaperArticle', label: '报纸文章' },
  { id: 'conferencePaper', label: '会议论文' },
  { id: 'book', label: '图书' },
  { id: 'bookSection', label: '图书章节' },
  { id: 'thesis', label: '学位论文' },
  { id: 'report', label: '报告' },
  { id: 'preprint', label: '预印本' },
  { id: 'manuscript', label: '手稿' },
  { id: 'webpage', label: '网页' },
  { id: 'blogPost', label: '博客文章' },
  { id: 'forumPost', label: '论坛帖子' },
  { id: 'encyclopediaArticle', label: '百科条目' },
  { id: 'dictionaryEntry', label: '词典条目' },
  { id: 'letter', label: '信件' },
  { id: 'email', label: '电子邮件' },
  { id: 'interview', label: '访谈' },
  { id: 'presentation', label: '演示文稿' },
  { id: 'artwork', label: '艺术作品' },
  { id: 'film', label: '电影' },
  { id: 'tvBroadcast', label: '电视节目' },
  { id: 'podcast', label: '播客' },
  { id: 'videoRecording', label: '视频' },
  { id: 'audioRecording', label: '音频' },
  { id: 'software', label: '软件' },
  { id: 'dataset', label: '数据集' },
  { id: 'map', label: '地图' },
  { id: 'patent', label: '专利' },
  { id: 'standard', label: '标准' },
  { id: 'legislation', label: '法律' },
  { id: 'case', label: '判例' },
  { id: 'statute', label: '法规' },
  { id: 'hearing', label: '听证会' },
  { id: 'document', label: '文档' },
  { id: 'note', label: '笔记' },
  { id: 'attachment', label: '附件' },
];
const ITEM_TYPE_IDS = new Set(ITEM_TYPES.map((t) => t.id));

// v5：按类型字段先收进一个通用 fields 对象（不追求 CSL 全字段，先覆盖写论文常用的）。
const FIELD_KEYS = [
  'publisher', 'place', 'edition', 'isbn', 'issn', 'conference',
  'university', 'department', 'institution', 'series', 'seriesNumber',
  'shortTitle', 'archive', 'archiveLocation', 'callNumber', 'rights',
];
const FIELD_KEY_SET = new Set(FIELD_KEYS);

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

function emptyStore() {
  return { version: VERSION, collections: [], searches: [], items: [], tagColors: {}, annoTags: {}, annoMeta: {} };
}

// 标注的标签：{ "<annoId>": ["方法", "待读"] }。
// 标注本体仍存在 userData/annotations/<hash>.json（跟着文件走），这里只存用户加的标签。
function normalizeAnnoTags(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const k of Object.keys(src)) {
    const id = str(k);
    if (!id) continue;
    const tags = strList(src[k]).filter((t) => t.length <= 40).slice(0, 20);
    if (tags.length) out[id] = tags;
  }
  return out;
}

// 标注对象（数据层 v8）：{ "<annoId>": { text, comment, tags, itemKey, noteIds, created, updated } }。
// 标注的真身（坐标 / 颜色 / 工具）仍在 annotations/<hash>.json，这里存"库这一侧"的东西：
// 可编辑的文字、标签、所属条目、由它生成的笔记。v7 的 annoTags 读进来并入 tags。
function normalizeAnnoMeta(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const k of Object.keys(src)) {
    const id = str(k);
    if (!id) continue;
    const m = src[k] && typeof src[k] === 'object' ? src[k] : {};
    out[id] = {
      text: str(m.text),
      comment: str(m.comment),
      tags: strList(m.tags).filter((t) => t.length <= 40).slice(0, 20),
      itemKey: str(m.itemKey),
      noteIds: strList(m.noteIds).slice(0, 50),
      created: Number.isFinite(+m.created) ? +m.created : 0,
      updated: Number.isFinite(+m.updated) ? +m.updated : 0,
    };
  }
  return out;
}

function clearTags(list) { return strList(list).filter((t) => t.length <= 40).slice(0, 20); }

// 标签颜色是全局映射（标签本身仍是字符串，不把每条标签都对象化，兼容旧数据）。
function normalizeTagColors(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const k of Object.keys(src)) {
    const name = str(k);
    const color = normalizeColor(src[k]);
    if (name && color) out[name] = color;
  }
  return out;
}

function normalizeColor(v) {
  const s = String(v == null ? '' : v).trim();
  return /^#[0-9a-f]{6}$/i.test(s) ? s.toLowerCase() : '';
}

function normalizeFields(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const k of FIELD_KEYS) {
    if (k in src) out[k] = str(src[k]);
  }
  return out;
}

// 相关条目只存 key（8 位类 Zotero key；测试数据可能更短，这里不做强格式校验）
function normalizeRelations(raw) {
  return strList(raw).filter((k) => /^[A-Za-z0-9_-]{1,64}$/.test(k));
}

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
      color: normalizeColor(c.color),
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
    s.tagColors = normalizeTagColors(o.tagColors);
    s.annoTags = normalizeAnnoTags(o.annoTags);
    s.annoMeta = normalizeAnnoMeta(o.annoMeta);
    if (Array.isArray(o.items)) s.items = o.items.filter((it) => it && it.key).map(migrateItem);
  }
  // v7→v8：标注标签搬进标注对象层（annoTags 只留着做兼容读，不再写）
  for (const id of Object.keys(s.annoTags)) {
    const tags = s.annoTags[id];
    if (!tags || !tags.length) continue;
    const m = s.annoMeta[id] || (s.annoMeta[id] = emptyAnnoMeta());
    for (const t of tags) if (!m.tags.includes(t)) m.tags.push(t);
  }
  return s;
}

function emptyAnnoMeta() {
  return { text: '', comment: '', tags: [], itemKey: '', noteIds: [], created: 0, updated: 0 };
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
  // v6：作者结构化。v5 的字符串数组在这里顺手拆成 {firstName,lastName,creatorType}
  x.creators = Creators.normalizeCreators(src.creators);
  x.tags = strList(src.tags);
  x.fields = normalizeFields(src.fields);
  x.relations = normalizeRelations(src.relations).filter((k) => k !== x.key);

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
  // v23：阅读笔记改成多条（notes[]）。v3 的单个 note 字段自动搬成第一条笔记。
  x.notes = normalizeNotes(src.notes, x.note, x.created, x.updated);
  // v8：条目 ↔ 标注双向关联的「条目这一侧」（标注那侧的 itemKey 在 annoMeta 里）
  x.annoIds = strList(src.annoIds).slice(0, 500);
  return x;
}

// 笔记条目：{ id, title, text, created, updated }
// 注意：这里不能用 genKey()——它会 load()，而本函数正是在 load()→normalize→migrateItem
// 里被调用的，会无限递归把栈打爆。笔记 id 用本地随机生成，不与库里的 key 冲突。
function genNoteId() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += alphabet[bytes[i] % alphabet.length];
  return 'n' + s;
}

function normalizeNotes(raw, legacyText, created, updated) {
  const src = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const n of src) {
    if (!n || typeof n !== 'object') continue;
    const id = String(n.id || '').trim() || genNoteId();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      title: str(n.title),
      text: str(n.text),
      // v8：从标注生成的笔记带一张页面截图（数据目录内的相对/绝对路径）
      image: str(n.image),
      annoIds: strList(n.annoIds).slice(0, 30),
      created: Number.isFinite(+n.created) ? +n.created : (created || 0),
      updated: Number.isFinite(+n.updated) ? +n.updated : (updated || 0),
    });
  }
  if (!out.length && legacyText) {
    // 老库里的单条 note → 变成第一条笔记，不丢内容
    out.push({ id: genNoteId(), title: '', text: legacyText, created: created || 0, updated: updated || 0 });
  }
  return out;
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
  const base = path.basename(p).replace(/\.[A-Za-z0-9]{1,8}$/, '');
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
  // （v23 起 note 不再直接写：阅读笔记走 notes[]，旧 note 字段只作迁移来源）
  const textFields = ['title', 'year', 'publication', 'volume', 'issue', 'pages', 'doi', 'url', 'abstract', 'language'];
  for (const k of textFields) if (k in patch) it[k] = str(patch[k]);
  if ('doi' in patch) it.doi = normDoi(patch.doi);
  if ('itemType' in patch) it.itemType = ITEM_TYPE_IDS.has(patch.itemType) ? patch.itemType : 'document';
  if ('fields' in patch) it.fields = normalizeFields(Object.assign({}, it.fields, patch.fields));
  if ('creators' in patch) it.creators = Creators.normalizeCreators(patch.creators);
  if ('tags' in patch) it.tags = strList(patch.tags);
  if ('relations' in patch) it.relations = normalizeRelations(patch.relations).filter((k) => k !== it.key);
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

// ---------- 阅读笔记（v23：一条文献可以挂多条笔记） ----------
function addNote(key, note) {
  const it = findItem(key); if (!it) return null;
  const n = {
    id: genNoteId(),
    title: str(note && note.title),
    text: str(note && note.text),
    image: str(note && note.image),
    annoIds: strList(note && note.annoIds).slice(0, 30),
    created: now(),
    updated: now(),
  };
  if (!Array.isArray(it.notes)) it.notes = [];
  it.notes.push(n);
  it.updated = now();
  save();
  return n;
}

function updateNote(key, id, patch) {
  const it = findItem(key); if (!it || !Array.isArray(it.notes)) return null;
  const n = it.notes.find((x) => x.id === id);
  if (!n) return null;
  if (patch && 'title' in patch) n.title = str(patch.title);
  if (patch && 'text' in patch) n.text = str(patch.text);
  n.updated = now();
  it.updated = now();
  save();
  return n;
}

function removeNote(key, id) {
  const it = findItem(key); if (!it || !Array.isArray(it.notes)) return false;
  const i = it.notes.findIndex((x) => x.id === id);
  if (i < 0) return false;
  it.notes.splice(i, 1);
  it.updated = now();
  save();
  return true;
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
  // 标签颜色跟着名字走；目标已有颜色时不覆盖
  if (s.tagColors && s.tagColors[a] && !s.tagColors[b]) s.tagColors[b] = s.tagColors[a];
  if (s.tagColors) delete s.tagColors[a];
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
  if (s.tagColors) delete s.tagColors[t];
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
  if (s.tagColors && s.tagColors[a] && !s.tagColors[b]) s.tagColors[b] = s.tagColors[a];
  if (s.tagColors) delete s.tagColors[a];
  save();
  return { ok: true, merged: n, from: a, into: b };
}

// 标签颜色：空字符串表示清除；标签本身仍以字符串存放在条目上
function setTagColor(tag, color) {
  const t = str(tag);
  if (!t) return { ok: false, error: '标签名不对' };
  const s = load();
  if (!s.tagColors) s.tagColors = {};
  const c = normalizeColor(color);
  if (c) s.tagColors[t] = c;
  else delete s.tagColors[t];
  save();
  return { ok: true, tag: t, color: c };
}

// ---------- 相关条目（双向） ----------
// Zotero 的相关条目是双向关系：A 关联 B 时，B 也会出现在 A 的相关列表里。
function addRelation(key, otherKey) {
  const it = findItem(key);
  const other = findItem(otherKey);
  if (!it || !other || it.key === other.key) return null;
  if (!it.relations.includes(other.key)) it.relations.push(other.key);
  if (!other.relations.includes(it.key)) other.relations.push(it.key);
  it.updated = now();
  other.updated = now();
  save();
  return it;
}
function removeRelation(key, otherKey) {
  const it = findItem(key);
  const other = findItem(otherKey);
  let changed = false;
  if (it) {
    const before = it.relations.length;
    it.relations = it.relations.filter((k) => k !== otherKey);
    if (it.relations.length !== before) { it.updated = now(); changed = true; }
  }
  if (other) {
    const before = other.relations.length;
    other.relations = other.relations.filter((k) => k !== key);
    if (other.relations.length !== before) { other.updated = now(); changed = true; }
  }
  if (changed) save();
  return it || null;
}

function addCollection(name, parentId) {
  const pid = parentId && findCollection(parentId) ? parentId : null;
  const c = { id: genKey(), name: String(name || '未命名').trim() || '未命名', parentId: pid, color: '' };
  load().collections.push(c); save(); return c;
}

// v5：收藏集重命名 / 颜色（只改索引，不碰条目与文件）
function renameCollection(id, name) {
  const c = findCollection(id);
  if (!c) return null;
  const n = String(name == null ? '' : name).trim();
  if (!n) return c;
  c.name = n;
  save();
  return c;
}
function setCollectionColor(id, color) {
  const c = findCollection(id);
  if (!c) return null;
  c.color = normalizeColor(color);
  save();
  return c;
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
  const notes = (Array.isArray(it.notes) ? it.notes : []).map((n) => ({
    id: n.id, title: n.title, text: n.text, image: n.image || '', annoIds: (n.annoIds || []).slice(),
    created: n.created || 0, updated: n.updated || 0,
  }));
  return {
    key: it.key, itemType: it.itemType, title: it.title, creators: Creators.normalizeCreators(it.creators),
    year: it.year, publication: it.publication, volume: it.volume, issue: it.issue,
    pages: it.pages, doi: it.doi, url: it.url, abstract: it.abstract,
    fields: Object.assign({}, it.fields || {}),
    relations: (it.relations || []).slice(),
    note: notes.map((n) => n.text).filter(Boolean).join('\n\n'),   // 老字段保留：导出/兼容用
    notes,
    language: it.language, tags: it.tags.slice(),
    // v8：条目 → 标注（双向关联的条目侧）
    annoIds: (it.annoIds || []).slice(),
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
    tagColors: Object.assign({}, s.tagColors || {}),
    annoTags: Object.assign({}, s.annoTags || {}),   // v7 兼容读（写入统一走 annoMeta）
    annoMeta: Object.assign({}, s.annoMeta || {}),   // v8：标注对象层（text/comment/tags/itemKey/noteIds）
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
  // 标签颜色：当前库已有的优先，避免恢复旧备份把新配色覆盖
  if (!cur.tagColors) cur.tagColors = {};
  for (const [tag, color] of Object.entries(inc.tagColors || {})) {
    if (!cur.tagColors[tag] && color) cur.tagColors[tag] = color;
  }
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
    if ('fields' in p) it.fields = normalizeFields(Object.assign({}, it.fields, p.fields));
    if ('creators' in p) it.creators = Creators.normalizeCreators(p.creators);
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
    if ('fields' in other) {
      keep.fields = keep.fields || {};
      for (const k of FIELD_KEYS) if (!keep.fields[k] && other.fields[k]) keep.fields[k] = other.fields[k];
    }
    // 作者按「姓+名+角色」去重：结构化之后不能拿对象引用比（includes 比的是同一性）
    const keepCreators = Creators.normalizeCreators(keep.creators);
    const keepCreatorKeys = new Set(keepCreators.map((c) => Creators.creatorKey(c)));
    for (const c of Creators.normalizeCreators(other.creators)) {
      const ck = Creators.creatorKey(c);
      if (keepCreatorKeys.has(ck)) continue;
      keepCreatorKeys.add(ck);
      keepCreators.push(c);
    }
    keep.creators = keepCreators;
    for (const t of other.tags) if (!keep.tags.includes(t)) keep.tags.push(t);
    for (const id of other.collectionIds) if (!keep.collectionIds.includes(id)) keep.collectionIds.push(id);
    for (const n of other.notes || []) {
      if (!keep.notes.some((x) => x.id === n.id)) keep.notes.push(n);
    }
    for (const rk of other.relations || []) {
      if (drop.has(rk) || rk === keepKey) continue;
      if (!keep.relations.includes(rk)) keep.relations.push(rk);
    }
    if (keep.itemType === 'document' && other.itemType !== 'document') keep.itemType = other.itemType;
    if (!keep.attachment && other.attachment) keep.attachment = other.attachment;
    else if (keep.attachment && !fs.existsSync(keep.attachment.path) && other.attachment && fs.existsSync(other.attachment.path)) keep.attachment = other.attachment;
    if (!keep.page && other.page) keep.page = other.page;
  }
  // 其它条目指向被合并条目的关系，统一改指到保留条目，避免出现悬空 key
  if (drop.size) {
    for (const it of load().items) {
      if (drop.has(it.key) || it.key === keepKey) continue;
      if (!it.relations.some((k) => drop.has(k))) continue;
      it.relations = it.relations.filter((k) => !drop.has(k));
      if (!it.relations.includes(keepKey)) it.relations.push(keepKey);
      if (!keep.relations.includes(it.key)) keep.relations.push(it.key);
      it.updated = now();
    }
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

// ---------- 标注对象（v8） ----------
// 标注真身（坐标 / 颜色）在 annotations/<hash>.json，库里存的是"对象层"：
// 可编辑的文字、标签、所属条目、由它生成的笔记。标签从 v7 的 annoTags 迁进来。
function annoMetaOf(id, s) {
  const key = str(id);
  const store = s || load();
  return store.annoMeta[key] || null;
}

// 读一条标注的标签（兼容 v7 的 annoTags：annoMeta 里没有就回退）
function annoTagsOf(id, s) {
  const key = str(id);
  const store = s || load();
  if (store.annoMeta[key]) return store.annoMeta[key].tags.slice();
  return strList(store.annoTags[key]);
}

function setAnnoTags(id, tags) {
  const key = str(id);
  if (!key) return { ok: false, error: '标注 id 为空' };
  const s = load();
  const list = clearTags(tags);
  const m = s.annoMeta[key] || (s.annoMeta[key] = emptyAnnoMeta());
  m.tags = list;
  m.updated = now();
  delete s.annoTags[key];      // 迁过来了，旧位置不再存
  save();
  return { ok: true, id: key, tags: list };
}

function addAnnoTags(ids, tags) {
  const set = Array.isArray(ids) ? ids : [];
  const add = clearTags(tags);
  if (!set.length || !add.length) return { ok: false, updated: 0 };
  const s = load();
  let n = 0;
  for (const raw of set) {
    const key = str(raw);
    if (!key) continue;
    const m = s.annoMeta[key] || (s.annoMeta[key] = emptyAnnoMeta());
    let changed = false;
    for (const t of add) if (!m.tags.includes(t)) { m.tags.push(t); changed = true; }
    if (changed) { m.tags = clearTags(m.tags); m.updated = now(); n++; }
    delete s.annoTags[key];
  }
  if (n) save();
  return { ok: true, updated: n };
}

function removeAnnoTag(id, tag) {
  const key = str(id), t = str(tag);
  const s = load();
  const m = s.annoMeta[key] || (s.annoMeta[key] = emptyAnnoMeta());
  const next = m.tags.filter((x) => x !== t);
  if (next.length !== m.tags.length) { m.tags = next; m.updated = now(); save(); }
  delete s.annoTags[key];
  return { ok: true, id: key, tags: next };
}

// 更新标注对象（文字 / 批注 / 所属条目 / 生成的笔记）。坐标不在这里改。
function updateAnno(id, patch) {
  const key = str(id);
  if (!key) return { ok: false, error: '标注 id 为空' };
  const p = patch && typeof patch === 'object' ? patch : {};
  const s = load();
  const m = s.annoMeta[key] || (s.annoMeta[key] = emptyAnnoMeta());
  if (!m.created) m.created = now();
  if (typeof p.text === 'string') m.text = str(p.text);
  if (typeof p.comment === 'string') m.comment = str(p.comment);
  if (p.tags != null) m.tags = clearTags(p.tags);
  if (typeof p.itemKey === 'string') m.itemKey = str(p.itemKey);
  if (Array.isArray(p.noteIds)) m.noteIds = strList(p.noteIds).slice(0, 50);
  m.updated = now();
  save();
  return { ok: true, id: key, anno: annoPublic(key, m) };
}

// 标注 → 条目：把标注挂到条目上（两边都写，双向关联）
function linkAnnoToItem(id, itemKey) {
  const key = str(id);
  const s = load();
  const it = itemKey ? s.items.find((x) => x.key === itemKey) : null;
  if (!key || !it) return { ok: false, error: '条目不存在' };
  const m = s.annoMeta[key] || (s.annoMeta[key] = emptyAnnoMeta());
  if (m.itemKey && m.itemKey !== it.key) {
    const prev = s.items.find((x) => x.key === m.itemKey);
    if (prev) prev.annoIds = prev.annoIds.filter((x) => x !== key);
  }
  m.itemKey = it.key;
  m.updated = now();
  if (!it.annoIds.includes(key)) { it.annoIds.push(key); it.updated = now(); }
  save();
  return { ok: true, id: key, itemKey: it.key, annoIds: it.annoIds.slice() };
}

function unlinkAnno(id) {
  const key = str(id);
  const s = load();
  const m = s.annoMeta[key];
  if (!m) return { ok: true, id: key, removed: 0 };
  const prev = m.itemKey ? s.items.find((x) => x.key === m.itemKey) : null;
  if (prev) prev.annoIds = prev.annoIds.filter((x) => x !== key);
  m.itemKey = '';
  m.updated = now();
  save();
  return { ok: true, id: key, removed: 1 };
}

// 稳定 id 升级后，把标签 / 对象的键从旧 id（hash:页:下标）搬到新 id
function remapAnnoTags(map) {
  const m = map && typeof map === 'object' ? map : {};
  const s = load();
  let n = 0;
  for (const oldId of Object.keys(m)) {
    const newId = str(m[oldId]);
    if (!newId || newId === oldId) continue;
    const oldTags = strList(s.annoTags[oldId]);
    const oldMeta = s.annoMeta[oldId];
    const target = s.annoMeta[newId] || (s.annoMeta[newId] = emptyAnnoMeta());
    for (const t of oldTags) if (!target.tags.includes(t)) target.tags.push(t);
    if (oldMeta) {
      for (const t of oldMeta.tags) if (!target.tags.includes(t)) target.tags.push(t);
      if (!target.text) target.text = oldMeta.text;
      if (!target.comment) target.comment = oldMeta.comment;
      if (!target.itemKey) target.itemKey = oldMeta.itemKey;
      for (const nid of oldMeta.noteIds) if (!target.noteIds.includes(nid)) target.noteIds.push(nid);
      if (!target.created) target.created = oldMeta.created;
      delete s.annoMeta[oldId];
    }
    delete s.annoTags[oldId];
    n++;
  }
  if (n) save();
  return { ok: true, remapped: n };
}

function annoPublic(id, m) {
  return {
    id: str(id),
    text: m.text || '',
    comment: m.comment || '',
    tags: (m.tags || []).slice(),
    itemKey: m.itemKey || '',
    noteIds: (m.noteIds || []).slice(),
    created: m.created || 0,
    updated: m.updated || 0,
  };
}

// ---------- 撤销 / 重做（v9） ----------
// 快照式：每次「可撤销操作」执行前后各序列化一次库，有变化就压一个撤销点。
// 比起给每个操作写反向逻辑，这样覆盖全、不会漏字段，代价是两步 JSON.stringify
// （库通常几百 KB ~ 几 MB，用户手动操作时才跑，可以接受）。
const UNDO_LIMIT = 20;
let undoStack = [];
let redoStack = [];

function snapshotJson() { return JSON.stringify(load()); }

function restoreSnapshot(str) {
  try {
    cache = normalize(JSON.parse(str));
    save();
    return true;
  } catch (_) { return false; }
}

function undoInfo() {
  return {
    canUndo: undoStack.length,
    canRedo: redoStack.length,
    undoDesc: undoStack.length ? undoStack[undoStack.length - 1].desc : '',
    redoDesc: redoStack.length ? redoStack[redoStack.length - 1].desc : '',
  };
}

function undo() {
  const it = undoStack.pop();
  if (!it) return { ok: false, error: '没有可撤销的操作' };
  const nowSnap = snapshotJson();
  if (!restoreSnapshot(it.snap)) return { ok: false, error: '撤销失败：备份数据损坏' };
  redoStack.push({ desc: it.desc, snap: nowSnap });
  if (redoStack.length > UNDO_LIMIT) redoStack.shift();
  return { ok: true, desc: it.desc };
}

function redo() {
  const it = redoStack.pop();
  if (!it) return { ok: false, error: '没有可重做的操作' };
  const nowSnap = snapshotJson();
  if (!restoreSnapshot(it.snap)) return { ok: false, error: '重做失败：备份数据损坏' };
  undoStack.push({ desc: it.desc, snap: nowSnap });
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  return { ok: true, desc: it.desc };
}

// 给导出函数套一层：执行前后比对，真有变化才留撤销点（返回 false / 没有改动时不污染栈）。
// 注意 addPdf / importItems 之类是 async：要等 Promise 落定后再比快照，否则永远比在中间态。
function enableUndo(names) {
  for (const name of Object.keys(names)) {
    const orig = module.exports[name];
    if (typeof orig !== 'function' || orig.__undoWrapped) continue;
    const wrapped = function (...args) {
      let before = '';
      try { before = snapshotJson(); } catch (_) {}
      const finish = () => {
        let after = before;
        try { after = snapshotJson(); } catch (_) {}
        if (before && after !== before) {
          undoStack.push({ desc: names[name], snap: before });
          if (undoStack.length > UNDO_LIMIT) undoStack.shift();
          redoStack = [];
        }
      };
      const r = orig.apply(module.exports, args);
      if (r && typeof r.then === 'function') {
        r.then(finish, finish);
        return r;
      }
      finish();
      return r;
    };
    wrapped.__undoWrapped = true;
    module.exports[name] = wrapped;
  }
}

module.exports = {
  init, filePath, load, save, summary,
  addPdf, addItem, updateItem, removeItem,
  trashItem, restoreItem, deleteItemForever, emptyTrash,
  findItem, findItemByPath, setPageByKey,
  addTag, removeTag, renameTag, removeTagEverywhere, mergeTags, setTagColor,
  addRelation, removeRelation,
  addNote, updateNote, removeNote,
  addCollection, removeCollection, renameCollection, setCollectionColor, moveItem, setCollections, setAttachment,
  addSearch, removeSearch,
  setAnnoTags, addAnnoTags, removeAnnoTag,
  annoMetaOf, annoTagsOf, updateAnno, linkAnnoToItem, unlinkAnno, remapAnnoTags,
  bulkUpdate, trashItems, findDuplicates, mergeItems, importItems,
  exportStore, replaceStore, mergeStore, backupNow,
  guessTitleFromPath, ITEM_TYPES,
  undo, redo, undoInfo,
  resetCache() { cache = null; }, // 测试钩子：模拟新进程从磁盘重载
  resetUndo() { undoStack = []; redoStack = []; },   // 测试钩子：清空撤销栈（不动数据）
};

// 哪些操作可以撤销（描述会显示在提示里）。笔记的逐字编辑不进撤销栈，否则打字就把栈填满了。
enableUndo({
  addPdf: '添加文档',
  trashItem: '移入回收站',
  restoreItem: '从回收站还原',
  deleteItemForever: '永久删除条目',
  emptyTrash: '清空回收站',
  trashItems: '批量移入回收站',
  updateItem: '修改条目信息',
  addItem: '新建条目',
  addTag: '添加标签',
  removeTag: '移除标签',
  renameTag: '重命名标签',
  removeTagEverywhere: '全库移除标签',
  mergeTags: '合并标签',
  addCollection: '新建收藏集',
  removeCollection: '删除收藏集',
  renameCollection: '重命名收藏集',
  setCollections: '修改收藏集归属',
  moveItem: '移动到收藏集',
  bulkUpdate: '批量编辑',
  importItems: '导入题录',
  mergeItems: '合并重复条目',
  addRelation: '添加关联',
  removeRelation: '解除关联',
  addSearch: '保存搜索条件',
  removeSearch: '删除搜索条件',
  setAnnoTags: '标注加标签',
  addAnnoTags: '标注批量加标签',
  removeAnnoTag: '标注移除标签',
  updateAnno: '编辑标注',
  linkAnnoToItem: '关联标注与条目',
  unlinkAnno: '解除标注关联',
});
