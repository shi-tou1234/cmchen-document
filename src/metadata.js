'use strict';
/*
 * DOI / arXiv 元数据抓取（v12）。
 * 只依赖 Node 自带 fetch，不引入请求库。网络失败时返回可读错误，调用方保留原有元数据。
 */
const DOI_RE = /10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i;
const ARXIV_NEW_RE = /(?:arxiv[:.\s/]*)?(\d{4}\.\d{4,5})(?:v\d+)?/i;
const ARXIV_OLD_RE = /(?:arxiv[:.\s/]*)?([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?/i;
const Creators = require('./creators.js');

function decodeXml(t) {
  return String(t == null ? '' : t)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(+n))
    .replace(/&amp;/g, '&');
}
function flat(v) { return decodeXml(v).replace(/\s+/g, ' ').trim(); }
function stripTags(v) { return flat(String(v || '').replace(/<[^>]+>/g, ' ')); }

function parseIdentifier(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const doi = DOI_RE.exec(raw);
  if (doi) return { type: 'doi', id: doi[0].replace(/[.,;]+$/, '') };
  const arx = ARXIV_NEW_RE.exec(raw) || ARXIV_OLD_RE.exec(raw);
  if (arx) return { type: 'arxiv', id: arx[1] };
  return null;
}

function yearOf(v) {
  const m = /\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/.exec(String(v || ''));
  return m ? m[1] : '';
}

const CROSSREF_TYPE = {
  'journal-article': 'journalArticle', 'proceedings-article': 'conferencePaper',
  'book-chapter': 'book', 'book': 'book', 'monograph': 'book', 'edited-book': 'book',
  'dissertation': 'thesis', 'report': 'report', 'posted-content': 'webpage',
  'webpage': 'webpage', 'dataset': 'document',
};

function crossrefToMeta(msg) {
  if (!msg) return null;
  // Crossref 本来就给 given / family，直接落成结构化作者
  const authors = (msg.author || []).map((a) => {
    const g = String(a.given || '').trim(), f = String(a.family || '').trim();
    if (g || f) return { firstName: g, lastName: f, creatorType: 'author' };
    const name = String(a.name || '').trim();
    if (!name) return null;
    const p = Creators.parseName(name);
    return { firstName: p.firstName, lastName: p.lastName, creatorType: 'author' };
  }).filter(Boolean);
  const issued = (msg.issued && msg.issued['date-parts'] && msg.issued['date-parts'][0])
    || (msg['published-print'] && msg['published-print']['date-parts'] && msg['published-print']['date-parts'][0])
    || (msg['published-online'] && msg['published-online']['date-parts'] && msg['published-online']['date-parts'][0])
    || [];
  const year = issued && issued[0] ? String(issued[0]) : '';
  let title = Array.isArray(msg.title) ? msg.title[0] : msg.title;
  if (!title && Array.isArray(msg['short-title'])) title = msg['short-title'][0];
  const container = Array.isArray(msg['container-title']) ? msg['container-title'][0] : msg['container-title'];
  return {
    itemType: CROSSREF_TYPE[msg.type] || 'journalArticle',
    title: flat(title),
    creators: authors,
    year,
    publication: flat(container || msg.publisher || ''),
    volume: flat(msg.volume || ''),
    issue: flat(msg.issue || ''),
    pages: flat(msg.page || ''),
    doi: flat(msg.DOI || ''),
    url: flat(msg.URL || ''),
    abstract: stripTags(msg.abstract || ''),
    language: flat(msg.language || ''),
    tags: Array.isArray(msg.subject) ? msg.subject.map(flat).filter(Boolean) : [],
  };
}

function arxivEntry(xml) {
  const entry = /<entry\b[\s\S]*?<\/entry>/i.exec(xml);
  if (!entry) return null;
  const e = entry[0];
  const one = (tag) => {
    const m = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i').exec(e);
    return m ? flat(m[1]) : '';
  };
  const all = (tag) => {
    const out = [];
    const re = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'gi');
    let m;
    while ((m = re.exec(e))) out.push(flat(m[1]));
    return out;
  };
  // arXiv 的 <name> 是 "Last, First" 写法
  const authors = all('name').map((n) => {
    const p = Creators.parseName(n);
    return { firstName: p.firstName, lastName: p.lastName, creatorType: 'author' };
  }).filter((c) => c.firstName || c.lastName);
  const id = one('id');
  const doi = one('arxiv:doi');
  const journal = one('arxiv:journal_ref');
  const title = one('title').replace(/^arXiv:\s*\S+\s*/i, '');
  // arXiv 的分类是自闭合标签 <category term="cs.CL"/>，不能按 <category>…</category> 取
  const tags = [];
  const catRe = /<category\b[^>]*\bterm\s*=\s*"([^"]*)"[^>]*\/?>/gi;
  let cm;
  while ((cm = catRe.exec(e))) {
    const t = flat(cm[1]);
    if (t && !tags.includes(t)) tags.push(t);
  }
  if (!tags.length) for (const t of all('category')) if (t && !tags.includes(t)) tags.push(t);
  return {
    itemType: journal ? 'journalArticle' : 'document',
    title,
    creators: authors,
    year: yearOf(one('published') || one('updated')),
    publication: journal || 'arXiv',
    volume: '', issue: '', pages: '',
    doi,
    url: id || '',
    abstract: one('summary'),
    language: '',
    tags,
  };
}

async function getText(url, fetchImpl, timeout) {
  const f = fetchImpl || globalThis.fetch;
  if (typeof f !== 'function') throw new Error('当前运行环境没有 fetch');
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeout || 15000) : null;
  try {
    const res = await f(url, {
      headers: { 'User-Agent': 'Trove/1.0 (local literature library)' },
      signal: ctrl ? ctrl.signal : undefined,
    });
    if (!res || res.ok === false) throw new Error('HTTP ' + ((res && res.status) || 'error'));
    return await res.text();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchByDoi(doi, opts) {
  const id = String(doi || '').replace(/^https?:\/\/doi\.org\//i, '').trim();
  if (!id) throw new Error('DOI 为空');
  const url = 'https://api.crossref.org/works/' + encodeURIComponent(id);
  const text = await getText(url, opts && opts.fetchImpl, opts && opts.timeout);
  let json;
  try { json = JSON.parse(text); } catch (_) { throw new Error('Crossref 返回的不是 JSON'); }
  const meta = crossrefToMeta(json && json.message);
  if (!meta || !meta.title) throw new Error('Crossref 没有找到该 DOI');
  return { source: 'doi', id, metadata: meta, raw: json };
}

async function fetchByArxiv(arxivId, opts) {
  const id = String(arxivId || '').replace(/^arxiv[:.\s/]*/i, '').trim();
  if (!id) throw new Error('arXiv id 为空');
  const url = 'https://export.arxiv.org/api/query?id_list=' + encodeURIComponent(id);
  const xml = await getText(url, opts && opts.fetchImpl, opts && opts.timeout);
  const meta = arxivEntry(xml);
  if (!meta || !meta.title) throw new Error('arXiv 没有找到该条目');
  return { source: 'arxiv', id, metadata: meta, raw: xml };
}

async function fetchMetadata(input, opts) {
  const parsed = parseIdentifier(input);
  if (!parsed) return { ok: false, error: '无法识别 DOI 或 arXiv id' };
  try {
    const r = parsed.type === 'doi'
      ? await fetchByDoi(parsed.id, opts)
      : await fetchByArxiv(parsed.id, opts);
    return Object.assign({ ok: true }, r);
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err), source: parsed.type, id: parsed.id };
  }
}

module.exports = {
  parseIdentifier, fetchMetadata, fetchByDoi, fetchByArxiv,
  _crossrefToMeta: crossrefToMeta, _arxivEntry: arxivEntry,
};
