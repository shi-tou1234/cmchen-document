'use strict';
/*
 * 库级全文索引（v11）。
 * - 用 pdfjs-dist 在主进程直接抽取文本，不依赖渲染窗口，也不引入 SQLite/原生模块。
 * - 每个 PDF 一个 JSON：<dataDir>/fulltext/<sha1(path)>.json，按 mtime+size 判断是否需要重建。
 * - 搜索只读索引，不碰原 PDF；索引丢了可以重建，因此备份不包含索引。
 * - 大文档限制单页/总字符数，避免一个 2000 页扫描件把内存吃穿。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VERSION = 1;
const MAX_CHARS_PER_PAGE = 200000;
const MAX_CHARS_TOTAL = 12 * 1024 * 1024;

let DIR = null;
let busy = Promise.resolve();
let running = false;
const entryCache = new Map(); // filePath -> { stamp, entry }

function init(dataDir) {
  const base = dataDir || require('os').tmpdir();
  DIR = path.join(base, 'fulltext');
  try { fs.mkdirSync(DIR, { recursive: true }); } catch (_) {}
  entryCache.clear();
  return DIR;
}

function dirPath() { return DIR || init(null); }

function fileFor(pdfPath) {
  const h = crypto.createHash('sha1').update(path.resolve(pdfPath)).digest('hex').slice(0, 24);
  return path.join(dirPath(), h + '.json');
}

function statOf(p) {
  try {
    const st = fs.statSync(p);
    return { size: st.size, mtimeMs: Math.round(st.mtimeMs) };
  } catch (_) { return null; }
}

function readIndex(pdfPath) {
  const f = fileFor(pdfPath);
  let st;
  try { st = fs.statSync(f); } catch (_) { return null; }
  const stamp = st.size + ':' + Math.round(st.mtimeMs);
  const hit = entryCache.get(pdfPath);
  if (hit && hit.stamp === stamp) return hit.entry;
  try {
    let raw = fs.readFileSync(f, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    const entry = JSON.parse(raw);
    if (!entry || entry.version !== VERSION || !Array.isArray(entry.pages)) throw new Error('bad index');
    entryCache.set(pdfPath, { stamp, entry });
    return entry;
  } catch (_) {
    return null;
  }
}

function writeIndex(pdfPath, entry) {
  const f = fileFor(pdfPath);
  const tmp = f + '.tmp';
  const json = JSON.stringify(entry);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(tmp, json);
  try {
    if (fs.existsSync(f)) fs.unlinkSync(f);
    fs.renameSync(tmp, f);
  } catch (_) {
    fs.writeFileSync(f, json);
  }
  try { fs.unlinkSync(tmp); } catch (_) {}
  entryCache.delete(pdfPath);
}

function isFresh(pdfPath) {
  const st = statOf(pdfPath);
  if (!st) return false;
  const entry = readIndex(pdfPath);
  return !!(entry && entry.size === st.size && entry.mtimeMs === st.mtimeMs && !entry.error);
}

async function extractPages(pdfPath) {
  const pdfjs = require('pdfjs-dist/build/pdf.js');
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjs.getDocument({
    data,
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  }).promise;
  const pages = [];
  let total = 0;
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      if (total >= MAX_CHARS_TOTAL) break;
      const page = await doc.getPage(n);
      let text = '';
      try {
        const tc = await page.getTextContent();
        text = (tc.items || []).map((it) => (it && it.str) || '').join(' ');
      } catch (_) { text = ''; }
      text = text.replace(/\s+/g, ' ').trim();
      if (text.length > MAX_CHARS_PER_PAGE) text = text.slice(0, MAX_CHARS_PER_PAGE);
      total += text.length;
      if (text) pages.push({ page: n, text });
    }
  } finally {
    try { await doc.destroy(); } catch (_) {}
  }
  return { pages, chars: total, numPages: doc.numPages };
}

async function indexFile(pdfPath, opts) {
  if (typeof pdfPath !== 'string' || !pdfPath.trim()) {
    return { ok: false, path: '', error: '条目没有附件' };
  }
  const abs = path.resolve(pdfPath);
  const force = !!(opts && opts.force);
  const st = statOf(abs);
  if (!st) return { ok: false, path: abs, error: '文件不存在' };
  if (!force && isFresh(abs)) {
    const hit = readIndex(abs);
    return { ok: true, path: abs, skipped: true, pages: hit.pages.length, chars: hit.chars || 0 };
  }
  const started = Date.now();
  try {
    const ext = await extractPages(abs);
    const entry = {
      version: VERSION, path: abs, size: st.size, mtimeMs: st.mtimeMs,
      indexedAt: Date.now(), numPages: ext.numPages, pages: ext.pages, chars: ext.chars,
    };
    writeIndex(abs, entry);
    return { ok: true, path: abs, pages: ext.pages.length, numPages: ext.numPages, chars: ext.chars, ms: Date.now() - started };
  } catch (err) {
    const message = String(err && err.message ? err.message : err);
    try {
      writeIndex(abs, {
        version: VERSION, path: abs, size: st.size, mtimeMs: st.mtimeMs,
        indexedAt: Date.now(), error: message, pages: [], chars: 0,
      });
    } catch (_) {}
    return { ok: false, path: abs, error: message };
  }
}

function enqueue(fn) {
  const p = busy.then(fn, fn);
  busy = p.catch(() => {});
  return p;
}

function indexOne(item, opts) {
  // 兼容三种入参：条目对象 / 路径字符串 / 带 attachment 的对象。
  // 没有附件的条目必须在这里拦住，否则对象会被当成路径传给 path.resolve 并抛错。
  const raw = item && typeof item === 'object'
    ? (item.attachment ? item.attachment.path : item.path)
    : item;
  const p = typeof raw === 'string' ? raw.trim() : '';
  if (!p) return Promise.resolve({ ok: false, error: '条目没有附件' });
  return enqueue(() => indexFile(p, opts));
}

function indexAll(items, opts) {
  const list = (items || []).filter((it) => it && !it.deletedAt && it.attachment && it.attachment.path);
  return enqueue(async () => {
    running = true;
    let done = 0, skipped = 0, failed = 0, chars = 0;
    const errors = [];
    try {
      for (const it of list) {
        const r = await indexFile(it.attachment.path, { force: opts && opts.force });
        done++;
        if (r.ok && r.skipped) skipped++;
        else if (!r.ok) { failed++; if (errors.length < 8) errors.push({ path: it.attachment.path, error: r.error }); }
        else chars += r.chars || 0;
      }
      return { ok: true, total: list.length, done, skipped, failed, chars, errors };
    } finally {
      running = false;
    }
  });
}

function search(query) {
  const raw = String(query || '').trim();
  if (!raw) return { ok: true, query: '', results: [], stats: stats() };
  const terms = raw.toLowerCase().split(/\s+/).filter(Boolean);
  const phrase = raw.toLowerCase();
  const results = [];
  let files = [];
  try { files = fs.readdirSync(dirPath()).filter((f) => /^[a-f0-9]{24}\.json$/.test(f)); } catch (_) {}
  for (const f of files) {
    const full = path.join(dirPath(), f);
    let entry = null;
    try {
      // 索引文件很小；按需读盘最稳，避免用 mtime 猜缓存导致串条目
      let text = fs.readFileSync(full, 'utf8');
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
      entry = JSON.parse(text);
    } catch (_) { continue; }
    if (!entry || entry.error || !Array.isArray(entry.pages)) continue;
    for (const pg of entry.pages) {
      const hay = String(pg.text || '').toLowerCase();
      if (!hay) continue;
      let hit = true;
      for (const term of terms) { if (hay.indexOf(term) < 0) { hit = false; break; } }
      if (!hit) continue;
      const at = hay.indexOf(terms[0]);
      const start = Math.max(0, at - 46);
      const end = Math.min(hay.length, at + terms[0].length + 62);
      let snippet = String(pg.text || '').slice(start, end).replace(/\s+/g, ' ').trim();
      if (start > 0) snippet = '…' + snippet;
      if (end < hay.length) snippet += '…';
      let count = 0, idx = at;
      while (idx >= 0 && count < 99) { count++; idx = hay.indexOf(terms[0], idx + terms[0].length); }
      results.push({ path: entry.path, page: pg.page || 0, snippet, count, phrase: phrase.length > 1 });
    }
  }
  results.sort((a, b) => (a.path.localeCompare(b.path)) || (a.page - b.page));
  return { ok: true, query: raw, results, stats: stats() };
}

function stats() {
  let files = [];
  try { files = fs.readdirSync(dirPath()).filter((f) => /^[a-f0-9]{24}\.json$/.test(f)); } catch (_) {}
  let indexed = 0, pages = 0, chars = 0, failed = 0, bytes = 0;
  for (const f of files) {
    try {
      const full = path.join(dirPath(), f);
      bytes += fs.statSync(full).size;
      let text = fs.readFileSync(full, 'utf8');
      const obj = JSON.parse(text);
      if (obj.error) failed++;
      else {
        indexed++;
        pages += (obj.pages || []).length;
        chars += obj.chars || 0;
      }
    } catch (_) {}
  }
  return { dir: dirPath(), indexed, failed, pages, chars, bytes, running };
}

function removeForPath(pdfPath) {
  try {
    const f = fileFor(pdfPath);
    if (fs.existsSync(f)) fs.unlinkSync(f);
    entryCache.delete(path.resolve(pdfPath));
    return true;
  } catch (_) { return false; }
}

function clear() {
  let n = 0;
  try {
    for (const f of fs.readdirSync(dirPath())) {
      if (!/\.json$/i.test(f)) continue;
      try { fs.unlinkSync(path.join(dirPath(), f)); n++; } catch (_) {}
    }
  } catch (_) {}
  entryCache.clear();
  return n;
}

module.exports = {
  init, dirPath, fileFor, indexFile, indexOne, indexAll, search, stats,
  removeForPath, clear, isFresh,
  _extractPages: extractPages,
};
