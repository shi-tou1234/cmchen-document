'use strict';
/*
 * BibTeX / RIS 导入导出（v12）。
 * 纯字符串解析，不依赖第三方库；只覆盖文献库实际会用到的字段。
 * 解析原则：坏条目跳过不抛错，能救的字段尽量救；绝不因为一条脏数据让整次导入失败。
 */
const ITEM_TYPES = new Set(['journalArticle', 'conferencePaper', 'book', 'thesis', 'report', 'webpage', 'document']);

function s(v) { return v == null ? '' : String(v).replace(/\s+/g, ' ').trim(); }

function cleanTex(v) {
  let out = s(v);
  out = out.replace(/\\&/g, '&').replace(/\\%/g, '%').replace(/\\_/g, '_');
  out = out.replace(/\\[a-zA-Z]+\s*\{([^{}]*)\}/g, '$1');
  out = out.replace(/[{}]/g, '');
  out = out.replace(/~+/g, ' ');
  return out.replace(/\s+/g, ' ').trim();
}

function splitTop(text, sep) {
  const out = [];
  let depth = 0, quote = false, cur = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' && text[i - 1] !== '\\') quote = !quote;
    if (!quote && ch === '{') depth++;
    if (!quote && ch === '}') depth = Math.max(0, depth - 1);
    if (!quote && depth === 0 && ch === sep) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function readBraced(text, start) {
  if (text[start] !== '{') return { value: '', next: start };
  let depth = 1, i = start + 1, out = '';
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') { out += ch + (text[i + 1] || ''); i += 2; continue; }
    if (ch === '{') { depth++; out += ch; i++; continue; }
    if (ch === '}') { depth--; if (depth === 0) return { value: out, next: i + 1 }; out += ch; i++; continue; }
    out += ch; i++;
  }
  return { value: out, next: i };
}

function readQuoted(text, start) {
  if (text[start] !== '"') return { value: '', next: start };
  let i = start + 1, out = '';
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') { out += ch + (text[i + 1] || ''); i += 2; continue; }
    if (ch === '"') return { value: out, next: i + 1 };
    out += ch; i++;
  }
  return { value: out, next: i };
}

function parseBibtex(text) {
  const records = [];
  const re = /@([A-Za-z]+)\s*([{(])/g;
  let m;
  while ((m = re.exec(text))) {
    const type = m[1].toLowerCase();
    const open = m[2], close = open === '{' ? '}' : ')';
    let i = re.lastIndex;
    if (type === 'comment' || type === 'preamble' || type === 'string') {
      // 跳过整个条目：找到与之匹配的右括号
      let depth = 1;
      while (i < text.length && depth > 0) {
        const ch = text[i];
        if (ch === '\\') { i += 2; continue; }
        if (ch === open) depth++;
        else if (ch === close) depth--;
        i++;
      }
      re.lastIndex = i;
      continue;
    }
    // key：到第一个顶层逗号为止（兼容 key 里带花括号的情况）
    let key = '', depth = 0, quote = false;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '"' && text[i - 1] !== '\\') quote = !quote;
      if (!quote && ch === '{') depth++;
      if (!quote && ch === '}') depth = Math.max(0, depth - 1);
      if (!quote && depth === 0 && ch === ',') { i++; break; }
      if (!quote && depth === 0 && ch === close) break;
      key += ch; i++;
    }
    key = key.trim();
    const fields = {};
    while (i < text.length) {
      while (i < text.length && /[\s,]/.test(text[i])) i++;
      if (i >= text.length) break;
      if (text[i] === close) { i++; break; }
      const nm = /^[A-Za-z][A-Za-z0-9_-]*/.exec(text.slice(i));
      if (!nm) { i++; continue; }
      const name = nm[0].toLowerCase(); i += nm[0].length;
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text[i] !== '=') continue;
      i++;
      // value 支持 {..} / ".." / bare，以及 # 拼接
      let value = '', seg = 0;
      while (i < text.length) {
        while (i < text.length && /\s/.test(text[i])) i++;
        let part;
        if (text[i] === '{') { const r = readBraced(text, i); part = r.value; i = r.next; }
        else if (text[i] === '"') { const r = readQuoted(text, i); part = r.value; i = r.next; }
        else {
          let j = i;
          while (j < text.length && !/[,#}\n]/.test(text[j])) j++;
          part = text.slice(i, j); i = j;
        }
        value += part;
        seg++;
        while (i < text.length && /\s/.test(text[i])) i++;
        if (text[i] === '#') { i++; continue; }
        break;
      }
      if (seg) fields[name] = value.trim();
      // 跳过到下一个逗号/结束
      while (i < text.length && text[i] !== ',' && text[i] !== close) i++;
    }
    records.push(bibToRecord(fields, key, type));
    re.lastIndex = i;
  }
  return records;
}

function splitAuthors(v) {
  return String(v || '').split(/\s+and\s+/i)
    .map((x) => cleanTex(x)).filter(Boolean)
    .map((x) => {
      // "Last, First" → "First Last"；"First Last" 原样
      const parts = x.split(',').map((y) => y.trim()).filter(Boolean);
      return parts.length === 2 ? (parts[1] + ' ' + parts[0]).trim() : x;
    });
}

function yearOf(v) {
  const m = /\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/.exec(String(v || ''));
  return m ? m[1] : '';
}

function mapBibType(t, fields) {
  t = String(t || '').toLowerCase();
  if (t === 'article') return 'journalArticle';
  if (t === 'inproceedings' || t === 'conference' || t === 'proceedings') return 'conferencePaper';
  if (t === 'book' || t === 'booklet' || t === 'incollection') return 'book';
  if (t === 'phdthesis' || t === 'mastersthesis' || t === 'thesis') return 'thesis';
  if (t === 'techreport' || t === 'report') return 'report';
  if (t === 'misc' || t === 'online' || t === 'www' || t === 'electronic') return 'webpage';
  return 'document';
}

function bibToRecord(f, key, bibType) {
  const fields = f || {};
  const publication = cleanTex(fields.journal || fields.booktitle || fields.publisher || fields.school || fields.institution || '');
  const type = mapBibType(bibType || '', fields);
  const doi = cleanTex(fields.doi || '').replace(/^https?:\/\/doi\.org\//i, '');
  const tags = splitTop(cleanTex(fields.keywords || ''), ',').map((x) => s(x)).filter(Boolean);
  return {
    itemType: ITEM_TYPES.has(type) ? type : 'document',
    title: cleanTex(fields.title || '') || key || '未命名文献',
    creators: splitAuthors(fields.author || fields.editor || ''),
    year: yearOf(fields.year || fields.date || ''),
    publication,
    volume: cleanTex(fields.volume || ''),
    issue: cleanTex(fields.number || fields.issue || ''),
    pages: cleanTex(fields.pages || ''),
    doi,
    url: cleanTex(fields.url || fields.howpublished || ''),
    abstract: cleanTex(fields.abstract || ''),
    language: cleanTex(fields.language || ''),
    tags,
  };
}

const RIS_TYPES = {
  JOUR: 'journalArticle', JF: 'journalArticle', MAG: 'journalArticle', NEWS: 'journalArticle',
  CONF: 'conferencePaper', CPAPER: 'conferencePaper',
  BOOK: 'book', CHAP: 'book', ECHAP: 'book',
  THES: 'thesis', DISS: 'thesis',
  RPRT: 'report', STAT: 'report',
  ELEC: 'webpage', WEB: 'webpage', BLOG: 'webpage',
  GEN: 'document', COMP: 'document', DATA: 'document',
};

function risToRecord(tags) {
  const get = (...names) => {
    for (const n of names) if (tags[n] && tags[n].length) return tags[n][0];
    return '';
  };
  const getAll = (...names) => {
    const out = [];
    for (const n of names) for (const v of (tags[n] || [])) out.push(s(v));
    return out;
  };
  const sp = get('SP'), ep = get('EP');
  const pages = get('SP') ? (ep ? (sp + '-' + ep) : sp) : '';
  const type = RIS_TYPES[String(get('TY') || '').toUpperCase()] || 'document';
  const keywords = [];
  for (const v of getAll('KW')) for (const k of String(v).split(/[;,]/)) if (s(k)) keywords.push(s(k));
  return {
    itemType: type,
    title: get('TI', 'T1', 'CT') || '未命名文献',
    creators: getAll('AU', 'A1').map((x) => {
      const parts = x.split(',').map((y) => y.trim()).filter(Boolean);
      return parts.length === 2 ? (parts[1] + ' ' + parts[0]) : x;
    }),
    year: yearOf(get('PY', 'Y1', 'DA')),
    publication: get('JO', 'JF', 'T2', 'JA', 'PB'),
    volume: get('VL'),
    issue: get('IS'),
    pages,
    doi: get('DO').replace(/^https?:\/\/doi\.org\//i, ''),
    url: get('UR', 'L2'),
    abstract: get('AB', 'N2'),
    language: get('LA'),
    tags: keywords,
  };
}

function parseRis(text) {
  const records = [];
  let cur = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9])\s*-\s?(.*)$/.exec(line);
    if (!m) continue;
    const tag = m[1], value = m[2].trim();
    if (tag === 'TY') { cur = {}; cur.TY = [value]; continue; }
    if (!cur) continue;
    if (tag === 'ER') { records.push(risToRecord(cur)); cur = null; continue; }
    (cur[tag] = cur[tag] || []).push(value);
  }
  if (cur) records.push(risToRecord(cur));
  return records;
}

function detectFormat(text, filename) {
  const ext = String(filename || '').toLowerCase().replace(/^.*\./, '');
  if (ext === 'bib' || ext === 'bibtex') return 'bibtex';
  if (ext === 'ris') return 'ris';
  if (/^\s*@[A-Za-z]+\s*[{(]/m.test(text)) return 'bibtex';
  if (/^\s*TY\s{1,2}-/m.test(text)) return 'ris';
  return 'bibtex';
}

function parseRefs(text, filename) {
  const format = detectFormat(text, filename);
  return { format, records: format === 'ris' ? parseRis(text) : parseBibtex(text) };
}

const BIB_TYPE = {
  journalArticle: 'article', conferencePaper: 'inproceedings', book: 'book',
  thesis: 'phdthesis', report: 'techreport', webpage: 'misc', document: 'misc',
};
const RIS_TYPE = {
  journalArticle: 'JOUR', conferencePaper: 'CONF', book: 'BOOK', thesis: 'THES',
  report: 'RPRT', webpage: 'ELEC', document: 'GEN',
};

function bibEscape(v) {
  return s(v).replace(/[{}]/g, (c) => '\\' + c);
}

function makeKey(r, used) {
  const first = (r.creators && r.creators[0]) || '';
  const last = first.split(/\s+/).filter(Boolean).pop() || 'item';
  const titleWord = (r.title || 'x').split(/\s+/).find((x) => /[A-Za-z0-9]/.test(x)) || 'x';
  let base = (last + yearOf(r.year) + titleWord).replace(/[^A-Za-z0-9]/g, '').slice(0, 28) || 'item';
  let key = base, n = 1;
  while (used.has(key)) key = base + (++n);
  used.add(key);
  return key;
}

function recordsToBibtex(records) {
  const used = new Set();
  const out = [];
  for (const r of records || []) {
    const type = BIB_TYPE[r.itemType] || 'misc';
    const fields = [];
    const add = (k, v) => { if (s(v)) fields.push('  ' + k + ' = {' + bibEscape(v) + '}'); };
    add('title', r.title);
    add('author', (r.creators || []).join(' and '));
    add('year', yearOf(r.year));
    if (r.itemType === 'journalArticle') add('journal', r.publication);
    else if (r.itemType === 'conferencePaper') add('booktitle', r.publication);
    else if (r.itemType === 'thesis') add('school', r.publication);
    else if (r.itemType === 'report') add('institution', r.publication);
    else add('publisher', r.publication);
    add('volume', r.volume);
    add('number', r.issue);
    add('pages', r.pages);
    add('doi', r.doi);
    add('url', r.url);
    add('abstract', r.abstract);
    add('keywords', (r.tags || []).join(', '));
    add('language', r.language);
    out.push('@' + type + '{' + makeKey(r, used) + ',\n' + fields.join(',\n') + '\n}');
  }
  return out.join('\n\n') + (out.length ? '\n' : '');
}

function recordsToRis(records) {
  const out = [];
  for (const r of records || []) {
    out.push('TY  - ' + (RIS_TYPE[r.itemType] || 'GEN'));
    const add = (tag, v) => { if (s(v)) out.push(tag + '  - ' + s(v)); };
    add('TI', r.title);
    for (const a of (r.creators || [])) add('AU', a);
    add('PY', yearOf(r.year));
    add('JO', r.publication);
    add('VL', r.volume);
    add('IS', r.issue);
    if (s(r.pages)) {
      const parts = String(r.pages).split('-');
      add('SP', parts[0]);
      if (parts[1]) add('EP', parts.slice(1).join('-'));
    }
    add('DO', r.doi);
    add('UR', r.url);
    add('AB', r.abstract);
    add('LA', r.language);
    for (const t of (r.tags || [])) add('KW', t);
    out.push('ER  - ', '');
  }
  return out.join('\n');
}

module.exports = {
  parseBibtex, parseRis, parseRefs, detectFormat,
  recordsToBibtex, recordsToRis,
  _bibToRecord: bibToRecord, _risToRecord: risToRecord, _splitAuthors: splitAuthors,
};
