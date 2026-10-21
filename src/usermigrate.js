'use strict';
/*
 * 改名后的 userData 目录搬家。
 *
 * 背景：Electron 的 userData 目录名取自 package.json 的 `name` 字段（不是 productName），
 * 所以产品从「PDF Reader」改名成「Trove」后，目录会从 %APPDATA%\pdf-reader 变成 %APPDATA%\trove。
 * 不搬家的话，用户的文献库 / 标注 / 设置看起来就像凭空消失了。
 *
 * 规则：
 *  - 只拷不删：老目录原样保留，出问题还能回去。
 *  - 只补缺不覆盖：新目录里已有的文件一律不碰（避免用旧数据盖掉新数据）。
 *  - Singleton* 不搬：那是 Electron 的单实例锁文件，换目录会导致双开。
 */
const fs = require('fs');
const path = require('path');

// 改名前用过的目录名（按尝试顺序）。第一个是历史真实存在的（package.json name = 'pdf-reader'）。
const LEGACY_DIR_NAMES = ['pdf-reader', 'PDF Reader'];

// 本程序自己写进 userData 的东西：搬这些就够了
const APP_ITEMS = ['library.json', 'settings.json', 'window-state.json', 'annotations', 'backups', 'fulltext'];

// Chromium 自己管的目录/文件：不要搬（缓存可以重建，LevelDB 里的锁甚至是脏的）
const CHROMIUM_ITEMS = new Set([
  'Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'GrShaderCache', 'ShaderCache',
  'Dictionaries', 'Local Storage', 'Session Storage', 'Network', 'Trust Tokens', 'Shared Dictionary',
  'blob_storage', 'Crashpad', 'Extensions', 'Partitions', 'Local State', 'Preferences',
]);

function shouldCopy(name) {
  if (/^Singleton/i.test(name)) return false;       // 单实例锁
  if (/\.tmp$/i.test(name)) return false;           // 临时文件
  if (CHROMIUM_ITEMS.has(name)) return false;
  return true;
}

function migrateUserData(opts) {
  const o = opts || {};
  const appData = o.appData;
  const newUserData = o.newUserData;
  const legacyNames = o.legacyNames || LEGACY_DIR_NAMES;
  const res = {
    ok: false, migrated: false, appData: appData || null, newUserData: newUserData || null,
    sources: [], copied: [], skipped: [], error: null,
  };
  if (!appData || !newUserData) { res.error = '缺少 appData / newUserData'; return res; }
  try {
    res.ok = true;
    for (const name of legacyNames) {
      const oldDir = path.join(appData, name);
      if (path.resolve(oldDir) === path.resolve(newUserData)) continue;
      let entries;
      try { entries = fs.readdirSync(oldDir); } catch (_) { continue; }  // 老目录不存在
      res.sources.push(oldDir);
      fs.mkdirSync(newUserData, { recursive: true });
      for (const entry of entries) {
        if (!shouldCopy(entry)) continue;              // Chromium 的东西不搬
        const src = path.join(oldDir, entry);
        const dst = path.join(newUserData, entry);
        if (fs.existsSync(dst)) { res.skipped.push(entry); continue; }  // 只补缺，不覆盖
        fs.cpSync(src, dst, { recursive: true });
        res.copied.push(entry);
      }
    }
    res.migrated = res.copied.length > 0;
  } catch (e) {
    res.ok = false;
    res.error = String((e && e.message) || e);
  }
  return res;
}

module.exports = { migrateUserData, LEGACY_DIR_NAMES, APP_ITEMS, shouldCopy };
