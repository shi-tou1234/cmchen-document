'use strict';
/*
 * 应用设置（v11）。
 * 存储：userData/settings.json。数据目录为空表示使用 Electron 默认 userData。
 * 原则：读坏自动回退默认值并留证；写盘原子；字段白名单，绝不把脏值写进 UI。
 */
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  dataDir: '',            // 空 = <userData>
  defaultSort: 'added',   // added | modified | title | year
  theme: 'light',         // light | dark | system
  autoIndex: true,        // 启动后自动建全文索引
  restoreTabs: false,     // 预留：下次启动恢复标签页（本版不启用）
  hintSeen: false,        // v19：首次上手提示是否已经看过
  invertPages: false,     // v20：深色模式下把页面反色（护眼）
};

const SORTS = new Set(['added', 'modified', 'title', 'year']);
const THEMES = new Set(['light', 'dark', 'system']);

let DIR = null;
let FILE = null;
let cache = null;

function init(userDataDir) {
  DIR = userDataDir || DIR;
  if (DIR) FILE = path.join(DIR, 'settings.json');
  cache = null;
  return FILE;
}

function filePath() {
  if (!FILE) {
    const os = require('os');
    init(path.join(os.tmpdir(), 'pdfreader-settings-default'));
  }
  return FILE;
}

function sanitize(raw) {
  const out = Object.assign({}, DEFAULTS);
  const src = raw && typeof raw === 'object' ? raw : {};
  if (typeof src.dataDir === 'string') out.dataDir = src.dataDir.trim();
  if (SORTS.has(src.defaultSort)) out.defaultSort = src.defaultSort;
  if (THEMES.has(src.theme)) out.theme = src.theme;
  if (typeof src.autoIndex === 'boolean') out.autoIndex = src.autoIndex;
  if (typeof src.restoreTabs === 'boolean') out.restoreTabs = src.restoreTabs;
  if (typeof src.hintSeen === 'boolean') out.hintSeen = src.hintSeen;
  if (typeof src.invertPages === 'boolean') out.invertPages = src.invertPages;
  return out;
}

function get() {
  if (cache) return Object.assign({}, cache);
  const p = filePath();
  try {
    let raw = fs.readFileSync(p, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    cache = sanitize(JSON.parse(raw));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      try { fs.copyFileSync(p, p + '.corrupt-' + Date.now()); } catch (_) {}
    }
    cache = Object.assign({}, DEFAULTS);
  }
  return Object.assign({}, cache);
}

function set(patch) {
  const cur = get();
  const next = sanitize(Object.assign({}, cur, patch || {}));
  cache = next;
  try {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    const tmp = filePath() + '.tmp';
    const json = JSON.stringify(next, null, 2);
    fs.writeFileSync(tmp, json);
    try {
      if (fs.existsSync(filePath())) fs.unlinkSync(filePath());
      fs.renameSync(tmp, filePath());
    } catch (_) {
      fs.writeFileSync(filePath(), json);
    }
    return { ok: true, settings: Object.assign({}, next) };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err), settings: Object.assign({}, next) };
  }
}

module.exports = {
  init, filePath, get, set, DEFAULTS,
  resetCache() { cache = null; },
  _sanitize: sanitize,
};
