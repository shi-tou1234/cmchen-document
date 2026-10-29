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
const docconvert = require('./docconvert.js');
const query = require('./query.js');
const { atomicWrite } = require('./atomic-file');

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

function readEntryFile(f) {
  let st;
  try { st = fs.statSync(f); } catch (_) { entryCache.delete(f); return null; }
  const stamp = st.size + ':' + st.mtimeMs + ':' + st.ctimeMs;
  const hit = entryCache.get(f);
  if (hit && hit.stamp === stamp) { entryCache.delete(f); entryCache.set(f, hit); return hit.entry; }
  entryCache.delete(f);
  try {
    const raw = fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '');
    const entry = JSON.parse(raw);
    if (!entry || entry.version !== VERSION || !Array.isArray(entry.pages)) return null;
    // Bound cache memory; a single unusually large index remains readable without being retained.
    if (st.size <= 32 * 1024 * 1024) {
      entryCache.set(f, { stamp, entry, bytes: st.size });
      let bytes = [...entryCache.values()].reduce((sum, e) => sum + e.bytes, 0);
      while (bytes > 32 * 1024 * 1024) {
        const key = entryCache.keys().next().value;
        bytes -= entryCache.get(key).bytes; entryCache.delete(key);
      }
    }
    return entry;
  } catch (_) { return null; }
}
function readIndex(pdfPath) { return readEntryFile(fileFor(pdfPath)); }

function writeIndex(pdfPath, entry) {
  const f = fileFor(pdfPath);
  atomicWrite(f, JSON.stringify(entry));
  entryCache.delete(f);
}

function isFresh(pdfPath) {
  const st = statOf(pdfPath);
  if (!st) return false;
  const entry = readIndex(pdfPath);
  return !!(entry && entry.size === st.size && entry.mtimeMs === st.mtimeMs && !entry.error);
}

async function extractPages(pdfPath) {
  // v27：非 PDF 交给 docconvert 抽文本；索引结构保持一致（pages:[{page,text}]）
  if (docconvert.extOf(pdfPath) !== 'pdf') {
    const ext = await docconvert.extractText(pdfPath);
    return { pages: ext.pages, chars: ext.chars, numPages: ext.numPages };
  }
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

function search(queryStr) {
  const raw = String(queryStr || '').trim();
  if (!raw) return { ok: true, query: '', results: [], stats: stats() };
  const ast = query.parseQuery(raw);
  const tokens = ast.text;
  const free = (ast.freeTokens && ast.freeTokens.length) ? ast.freeTokens : tokens;
  // 只有字段限定、没有正文词时，全文索引没有可搜的东西；由 main.js 的
  // fulltextResults 走条目级字段过滤，这里直接返回空。
  if (!free.length) return { ok: true, query: raw, results: [], stats: stats(), ast };
  const results = [];
  let files = [];
  try { files = fs.readdirSync(dirPath()).filter((f) => /^[a-f0-9]{24}\.json$/.test(f)); } catch (_) {}
  for (const f of files) {
    const full = path.join(dirPath(), f);
    const entry = readEntryFile(full);
    if (!entry || entry.error || !Array.isArray(entry.pages)) continue;
    for (const pg of entry.pages) {
      const orig = String(pg.text || '');
      if (!orig) continue;
      // fold 一次：小写 + 变音/引号折叠 + 空白归一，词与短语都在这上面匹配
      const hay = query.fold(orig);
      if (!hay) continue;
      if (!query.matchNone(hay, ast.not)) continue;   // 排除词：任一命中即弃
      // 按语法树匹配（支持 OR / 括号 / 取反）；字段词在这一层不参与，交给条目级过滤
      const m = query.evalText(hay, ast);
      if (!m.ok) continue;
      // 评分：命中次数 × 词重（短语 ×3），再加密度加成（同样命中数，短页更相关；
      // 最短按 60 字算，避免极短页权重爆炸）
      let score = 0, totalHits = 0;
      const hitTokens = [];
      for (const [tok, c] of m.hits) {
        totalHits += c;
        hitTokens.push(tok);
        score += c * (tok.phrase ? 3 : 1);
      }
      if (!totalHits) continue;                        // 只满足字段条件、正文没命中：不算这一页
      score += totalHits * 1000 / Math.max(60, hay.length);
      // snippet 锚点：短语优先。位置要在原文上取（fold 会归并空白、长度可能变），
      // 原文锚不上（查询带变音折叠等）才退回 fold 文本
      const origLower = orig.toLowerCase();
      const anchorPool = hitTokens.length ? hitTokens : free;
      let anchorTok = null;
      for (const tok of anchorPool) { if (tok.phrase) { anchorTok = tok; break; } }
      if (!anchorTok) anchorTok = anchorPool[0];
      let at = origLower.indexOf(anchorTok.t);
      let inHay = at < 0;
      if (inHay) at = Math.max(0, query.firstHit(hay, anchorPool));
      const atLen = anchorTok.t.length;
      const start = Math.max(0, at - 46);
      const end = Math.min((inHay ? hay : orig).length, at + atLen + 62);
      let snippet = (inHay ? hay : orig).slice(start, end).replace(/\s+/g, ' ').trim();
      if (start > 0) snippet = '…' + snippet;
      if (end < (inHay ? hay : orig).length) snippet += '…';
      results.push({ path: entry.path, page: pg.page || 0, snippet, count: totalHits, score, phrase: tokens.some((t) => t.phrase) });
    }
  }
  // 相关性优先（报告 3.2：原来按「文件路径+页码」排，命中最多的页反而排在后面）
  results.sort((a, b) => (b.score - a.score) || (a.path.localeCompare(b.path)) || (a.page - b.page));
  return { ok: true, query: raw, results, stats: stats(), ast };
}

function stats() {
  let files = [];
  try { files = fs.readdirSync(dirPath()).filter((f) => /^[a-f0-9]{24}\.json$/.test(f)); } catch (_) {}
  let indexed = 0, pages = 0, chars = 0, failed = 0, bytes = 0;
  for (const f of files) {
    try {
      const full = path.join(dirPath(), f);
      bytes += fs.statSync(full).size;
      const obj = readEntryFile(full);
      if (!obj) continue;
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
    entryCache.delete(f);
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
  removeForPath, clear, isFresh, readIndex, textOfEntry: (p) => {
    const e = readIndex(p);
    return e && Array.isArray(e.pages) ? e.pages.map((x) => String((x && x.text) || '')).join('\n') : '';
  },
  _extractPages: extractPages,
};
