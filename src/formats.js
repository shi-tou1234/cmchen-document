'use strict';
/*
 * BibTeX / RIS 导入导出（v12）。
 * 纯字符串解析，不依赖第三方库；只覆盖文献库实际会用到的字段。
 * 解析原则：坏条目跳过不抛错，能救的字段尽量救；绝不因为一条脏数据让整次导入失败。
 */
const ITEM_TYPES = new Set(['journalArticle', 'conferencePaper', 'book', 'thesis', 'report', 'webpage', 'document']);
const Creators = require('./creators.js');

function s(v) { return v == null ? '' : String(v).replace(/\s+/g, ' ').trim(); }

function cleanTex(v) {
  let out = s(v);
  out = out.replace(/\\&/g, '&').replace(/\\%/g, '%').replace(/\\_/g, '_');
  out = out.replace(/\\[a-zA-Z]+\s*\{([^{}]*)\}/g, '$1');
  out = out.replace(/\\([{}])/g, '$1'); // 导出时转义的花括号还原，避免留下孤立反斜杠
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

// BibTeX 的多个作者用 " and " 分隔；大括号包住的名字内部不该被切开
function splitBibNames(v) {
  const text = String(v == null ? '' : v);
  const out = [];
  let depth = 0, cur = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    if (depth === 0) {
      const m = /^\s+and\s+/i.exec(text.slice(i));
      if (m) {
        if (cur.trim()) out.push(cur.trim());
        cur = '';
        i += m[0].length - 1;
        continue;
      }
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// BibTeX 作者 → 结构化作者。{...} 是 BibTeX 的「原样显示」约定，多半是机构名。
function splitAuthors(v, creatorType) {
  return splitBibNames(v).map((x) => {
    const literal = /^\{[\s\S]*\}$/.test(x);
    const p = literal
      ? { firstName: '', lastName: cleanTex(x.slice(1, -1)) }
      : Creators.parseName(cleanTex(x));
    return { firstName: p.firstName, lastName: p.lastName, creatorType: creatorType || 'author' };
  }).filter((c) => c.firstName || c.lastName);
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
  // 关键词既可能用逗号也可能用分号分隔，两种都切开
  const tags = splitTop(cleanTex(fields.keywords || ''), ',')
    .flatMap((x) => x.split(/;/))
    .map((x) => s(x)).filter(Boolean);
  return {
    itemType: ITEM_TYPES.has(type) ? type : 'document',
    title: cleanTex(fields.title || '') || key || '未命名文献',
    creators: [
      ...splitAuthors(fields.author, 'author'),
      ...splitAuthors(fields.editor, 'editor'),
      ...splitAuthors(fields.translator, 'translator'),
    ],
    year: yearOf(fields.year || fields.date || ''),
    publication,
    volume: cleanTex(fields.volume || ''),
    issue: cleanTex(fields.number || fields.issue || ''),
    // BibTeX 页码惯例是 45--67，统一成 45-67，导出 RIS 时才能正确拆 SP/EP
    pages: cleanTex(fields.pages || '').replace(/--+/g, '-'),
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
  // RIS 的作者标签：AU 作者 / ED 编者 / TR 译者 / A2、A3 其它贡献者
  const risNames = (names, type) => names.map((x) => {
    const p = Creators.parseName(x);
    return { firstName: p.firstName, lastName: p.lastName, creatorType: type };
  }).filter((c) => c.firstName || c.lastName);
  return {
    itemType: type,
    title: get('TI', 'T1', 'CT') || '未命名文献',
    creators: [
      ...risNames(getAll('AU', 'A1'), 'author'),
      ...risNames(getAll('ED'), 'editor'),
      ...risNames(getAll('TR'), 'translator'),
      ...risNames(getAll('A2', 'A3'), 'contributor'),
    ],
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

// ---------- EndNote（.enw，%0 标签） ----------
const ENW_TYPES = {
  'journal article': 'journalArticle', 'book': 'book', 'book section': 'bookSection',
  'conference paper': 'conferencePaper', 'conference proceedings': 'conferencePaper',
  'thesis': 'thesis', 'report': 'report', 'web page': 'webpage',
  'edited book': 'book', 'magazine article': 'journalArticle', 'newspaper article': 'journalArticle',
};

function parseEndNote(text) {
  const records = [];
  let cur = null;
  const flush = () => {
    if (!cur) return;
    if (cur['%0'] || cur['%T']) records.push(enwToRecord(cur));
    cur = null;
  };
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^%([0-9A-Za-z@!?$&()*+]) (.*)$/.exec(line);
    if (!m) {
      // 空行 = 一条结束（EndNote 导出常在记录之间留空行）
      if (!String(line).trim()) flush();
      continue;
    }
    if (m[1] === '0' && cur && (cur['%0'] || cur['%T'])) flush();
    if (!cur) cur = {};
    (cur['%' + m[1]] = cur['%' + m[1]] || []).push(m[2].trim());
  }
  flush();
  return records;
}

function enwToRecord(tags) {
  const get = (...names) => {
    for (const n of names) if (tags[n] && tags[n].length) return tags[n][0];
    return '';
  };
  const getAll = (...names) => {
    const out = [];
    for (const n of names) for (const v of (tags[n] || [])) out.push(s(v));
    return out;
  };
  const names = (list, type) => list.map((x) => {
    const p = Creators.parseName(x);
    return { firstName: p.firstName, lastName: p.lastName, creatorType: type };
  }).filter((c) => c.firstName || c.lastName);
  const keywords = [];
  for (const v of getAll('%K')) for (const k of String(v).split(/[;,]/)) if (s(k)) keywords.push(s(k));
  const pagesRaw = get('%P');
  return {
    itemType: ENW_TYPES[String(get('%0') || '').toLowerCase()] || 'document',
    title: get('%T') || '未命名文献',
    creators: [
      ...names(getAll('%A'), 'author'),
      ...names(getAll('%E'), 'editor'),
    ],
    year: yearOf(get('%D', '%8')),
    publication: get('%J', '%B', '%I'),
    volume: get('%V'),
    issue: get('%N'),
    pages: pagesRaw,
    doi: get('%R').replace(/^https?:\/\/doi\.org\//i, ''),
    url: get('%U'),
    abstract: get('%X'),
    language: get('%G'),
    tags: keywords,
    fields: {
      isbn: /^\d[\d-]{8,}$/.test(get('%@')) ? get('%@') : '',
      issn: get('%@'),
      publisher: get('%I'),
    },
  };
}

// ---------- RefWorks（tagged 格式，两位标签） ----------
const RW_TYPES = {
  journal: 'journalArticle', 'journal article': 'journalArticle', book: 'book',
  'book, section': 'bookSection', 'book section': 'bookSection',
  'conference proceeding': 'conferencePaper', 'dissertation/thesis': 'thesis',
  report: 'report', 'web page': 'webpage',
};

function parseRefWorks(text) {
  const records = [];
  let cur = null;
  const flush = () => {
    if (!cur) return;
    if (cur.T1 || cur.RT) records.push(rwToRecord(cur));
    cur = null;
  };
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!String(line).trim()) { flush(); continue; }
    if (/^ER\b/.test(line)) { flush(); continue; }
    const m = /^([A-Z][A-Z0-9])\s+(.*)$/.exec(line);
    if (!m) continue;
    if (!cur) cur = {};
    (cur[m[1]] = cur[m[1]] || []).push(m[2].trim());
  }
  flush();
  return records;
}

function rwToRecord(tags) {
  const get = (...names) => {
    for (const n of names) if (tags[n] && tags[n].length) return tags[n][0];
    return '';
  };
  const getAll = (...names) => {
    const out = [];
    for (const n of names) for (const v of (tags[n] || [])) out.push(s(v));
    return out;
  };
  const names = (list, type) => list.map((x) => {
    const p = Creators.parseName(x);
    return { firstName: p.firstName, lastName: p.lastName, creatorType: type };
  }).filter((c) => c.firstName || c.lastName);
  const keywords = [];
  for (const v of getAll('K1')) for (const k of String(v).split(/[;,]/)) if (s(k)) keywords.push(s(k));
  const sp = get('SP'), op = get('OP');
  return {
    itemType: RW_TYPES[String(get('RT') || '').toLowerCase()] || 'document',
    title: get('T1') || '未命名文献',
    creators: [
      ...names(getAll('A1'), 'author'),
      ...names(getAll('A2'), 'editor'),
      ...names(getAll('A3', 'A4'), 'contributor'),
    ],
    year: yearOf(get('YR', 'FD')),
    publication: get('JF', 'JO', 'T2', 'PB'),
    volume: get('VO'),
    issue: get('IS'),
    pages: sp ? (op ? sp + '-' + op : sp) : '',
    doi: get('DO').replace(/^https?:\/\/doi\.org\//i, ''),
    url: get('UL'),
    abstract: get('AB'),
    language: get('LA'),
    tags: keywords,
    fields: { issn: get('SN'), isbn: '', publisher: get('PB') },
  };
}

// ---------- EndNote XML（.xml，EndNote「输出样式 → XML」导出的 <records> 结构） ----------
// 只用正则做解析（项目约定不引 XML 库）：坏条目跳过、字段救得到就救。
// 实际的 EndNote XML 是固定结构：<record> 里一层层命名标签，正则按标签名取值够用；
// 反嵌套的 CDATA / 实体先解码，标签内不再允许出现 <（EndNote 导出会转义）。
const ENW_XML_TYPES = {
  'journal article': 'journalArticle', 'book': 'book', 'book section': 'bookSection',
  'conference paper': 'conferencePaper', 'conference proceedings': 'conferencePaper',
  'thesis': 'thesis', 'report': 'report', 'web page': 'webpage',
  'electronic article': 'journalArticle', 'magazine article': 'magazineArticle',
  'newspaper article': 'newspaperArticle', 'edited book': 'book',
};

// 只解码、不 trim：字段可能由多段拼成，边界空白由 xmlText 在整段上统一处理（R03）
function xmlDecode(v) {
  return String(v == null ? '' : v)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => {
      const n = parseInt(h, 16);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
    })
    .replace(/&#(\d+);/g, (m, d) => (+d > 0 && +d < 65536 ? String.fromCharCode(+d) : ''))
    .replace(/&amp;/g, '&');
}

// 字段值的「文本内容」：EndNote 会把一段文字包进 <style face="..."> / <i> 之类的内联标签，
// 这些标签不是正文。先剥内联标签（不插空格，避免把单词拆开），其余标签按空白处理，
// 再解码实体 —— 顺序很关键：先剥标签再解码，才不会被 &lt;b&gt; 这类合法文本误剥。
//
// 注意（R03）：这里不能 trim。字段可能由「普通文本 + CDATA + 普通文本」多段拼成，
// `Before <![CDATA[Middle]]> After` 逐段 trim 会粘成 `BeforeMiddleAfter`。
// 各段按原样拼接，最后对整段做一次空白规范化：这样 `pre<![CDATA[fix]]>` 仍是 `prefix`，
// 而 `Alpha <![CDATA[<Beta>]]> Gamma` 仍是 `Alpha <Beta> Gamma`。
const INLINE_XML_TAG = /<\/?(?:style|i|b|u|em|strong|sup|sub|span|font|small|big)\b[^>]*>/gi;
function xmlPlainText(inner) {
  return String(inner || '')
    .replace(INLINE_XML_TAG, '')
    .replace(/<[^>]*>/g, ' ');
}
// CDATA 段原样保留（段内不解实体），其余片段剥标签并解实体；拼完再统一规范化空白
function xmlText(inner) {
  const s0 = String(inner || '');
  let out = '', i = 0;
  while (i < s0.length) {
    const start = s0.indexOf('<![CDATA[', i);
    if (start < 0) { out += xmlDecode(xmlPlainText(s0.slice(i))); break; }
    out += xmlDecode(xmlPlainText(s0.slice(i, start)));
    const end = s0.indexOf(']]>', start + 9);
    if (end < 0) { out += s0.slice(start + 9); break; }
    out += s0.slice(start + 9, end);
    i = end + 3;
  }
  return s(out.replace(/\s+/g, ' '));
}

// 抓「标签对」里的原始内容（保留内层标签）——只给需要继续按标签下钻的结构用
function xmlRaw(block, tag) {
  const m = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'i').exec(block);
  return m ? m[1] : '';
}

// 抓「标签对」里的内容（不跨条目边界；内容里的转义标签不会干扰）
function xmlTag(block, tag) {
  const m = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'i').exec(block);
  return m ? xmlText(m[1]) : '';
}

function xmlTagAll(block, tag) {
  const out = [];
  const re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'gi');
  let m;
  while ((m = re.exec(block))) out.push(xmlText(m[1]));
  return out;
}

function parseEndNoteXml(text) {
  const records = [];
  // 记录边界用「自闭合或成对的 <record>」；EndNote 的 record 不会嵌套
  const blocks = String(text || '').split(/<record[\s>]/i).slice(1);
  for (const raw of blocks) {
    const block = raw.replace(/<\/record>[\s\S]*$/i, '');
    const title = xmlTag(block, 'title');
    if (!title && !/<ref-type/i.test(block)) continue;   // 空壳跳过
    const refTypeMatch = /<ref-type[^>]*\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(block);
    const refTypeName = refTypeMatch ? (refTypeMatch[1] != null ? refTypeMatch[1] : refTypeMatch[2]) : '';
    const names = (list, type) => list.map((x) => {
      const p = Creators.parseName(x);
      return { firstName: p.firstName, lastName: p.lastName, creatorType: type };
    }).filter((c) => c.firstName || c.lastName);
    const keywords = [];
    for (const k of xmlTagAll(block, 'keyword')) for (const part of k.split(/[;,]/)) if (s(part)) keywords.push(s(part));
    const doi = xmlTag(block, 'electronic-resource-num') || xmlTag(block, 'doi');
    const url = xmlTagAll(block, 'url')[0] || '';
    const pages = xmlTag(block, 'pages');
    const year = yearOf(xmlTag(block, 'year') || xmlTag(block, 'date'));
    const contributors = xmlRaw(block, 'contributors') || block;
    records.push({
      itemType: ENW_XML_TYPES[String(refTypeName).toLowerCase()] || 'document',
      title: title || '未命名文献',
      creators: [
        ...names(xmlTagAll(contributors, 'author'), 'author'),
        ...names(xmlTagAll(contributors, 'editor'), 'editor'),
      ],
      year,
      publication: xmlTag(block, 'secondary-title')
        || xmlTag(xmlRaw(block, 'periodical'), 'full-title')
        || xmlTag(block, 'full-title'),
      volume: xmlTag(block, 'volume'),
      issue: xmlTag(block, 'number'),
      pages,
      doi: doi.replace(/^https?:\/\/doi\.org\//i, ''),
      url,
      abstract: xmlTag(block, 'abstract'),
      language: xmlTag(block, 'language'),
      tags: keywords.slice(0, 20),
      fields: { issn: xmlTag(block, 'issn'), isbn: xmlTag(block, 'isbn'), publisher: xmlTag(block, 'publisher') },
    });
  }
  return records;
}

function detectFormat(text, filename) {
  const ext = String(filename || '').toLowerCase().replace(/^.*\./, '');
  if (ext === 'bib' || ext === 'bibtex') return 'bibtex';
  if (ext === 'ris') return 'ris';
  if (ext === 'json') return 'csljson';
  if (ext === 'enw' || ext === 'enlp') return 'endnote';
  if (ext === 'refworks' || ext === 'rw') return 'refworks';
  if (ext === 'xml' || ext === 'endnotexml') return 'endnotexml';
  if (/^\s*%0\s/m.test(text)) return 'endnote';
  if (/^\s*RT\s+\S/m.test(text) && /^\s*A1\s/m.test(text)) return 'refworks';
  if (/^\s*@[A-Za-z]+\s*[{(]/m.test(text)) return 'bibtex';
  if (/^\s*TY\s{1,2}-/m.test(text)) return 'ris';
  if (/^\s*[\[{]/.test(text) && /"type"\s*:/.test(text)) return 'csljson';
  if (/<records?[\s>]/i.test(text) && /<\/record>/i.test(text)) return 'endnotexml';
  return 'bibtex';
}

function parseRefs(text, filename) {
  const format = detectFormat(text, filename);
  if (format === 'ris') return { format, records: parseRis(text) };
  if (format === 'endnote') return { format, records: parseEndNote(text) };
  if (format === 'refworks') return { format, records: parseRefWorks(text) };
  if (format === 'endnotexml') {
    try { return { format, records: parseEndNoteXml(text) }; }
    catch (err) { return { format, records: [], error: String(err && err.message || err) }; }
  }
  if (format === 'csljson') {
    try { return { format, records: parseCslJson(text) }; }
    catch (err) { return { format, records: [], error: String(err && err.message || err) }; }
  }
  return { format, records: parseBibtex(text) };
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
  const list = Creators.normalizeCreators(r.creators);
  const first = list[0] || null;
  const last = (first ? (first.lastName || first.firstName) : '').split(/\s+/).filter(Boolean).pop() || 'item';
  const titleWord = (r.title || 'x').split(/\s+/).find((x) => /[A-Za-z0-9]/.test(x)) || 'x';
  let base = (last + yearOf(r.year) + titleWord).replace(/[^A-Za-z0-9]/g, '').slice(0, 28) || 'item';
  let key = base, n = 1;
  while (used.has(key)) key = base + (++n);
  used.add(key);
  return key;
}

// BibTeX 作者写法：有名字的写 "Last, First"；整体一个字段的名字（机构名）用花括号包住
function bibNames(list) {
  return Creators.normalizeCreators(list).map((c) => {
    const last = bibEscape(c.lastName), first = bibEscape(c.firstName);
    if (!last) return '';
    if (first) return last + ', ' + first;
    return /\s/.test(c.lastName) ? '{' + last + '}' : last;
  }).filter(Boolean).join(' and ');
}

function recordsToBibtex(records) {
  const used = new Set();
  const out = [];
  for (const r of records || []) {
    const type = BIB_TYPE[r.itemType] || 'misc';
    const fields = [];
    const add = (k, v) => { if (s(v)) fields.push('  ' + k + ' = {' + bibEscape(v) + '}'); };
    // 作者字段自己带花括号（机构名要原样显示），不能再被 bibEscape 转义一次
    const addRaw = (k, v) => { if (s(v)) fields.push('  ' + k + ' = {' + v + '}'); };
    const ofType = (t) => Creators.normalizeCreators(r.creators).filter((c) => c.creatorType === t);
    add('title', r.title);
    addRaw('author', bibNames(ofType('author')));
    addRaw('editor', bibNames(ofType('editor')));
    addRaw('translator', bibNames(ofType('translator')));
    addRaw('contributor', bibNames(ofType('contributor')));
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
    // RIS 的作者标签：AU 作者 / ED 编者 / TR 译者 / A2 其它贡献者
    const RIS_TAG = { author: 'AU', editor: 'ED', translator: 'TR', contributor: 'A2' };
    for (const c of Creators.normalizeCreators(r.creators)) {
      const name = c.firstName ? (c.lastName + ', ' + c.firstName) : c.lastName;
      add(RIS_TAG[c.creatorType] || 'AU', name);
    }
    add('TI', r.title);
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

// ---------- CSL-JSON（citeproc 的标准数据格式，Zotero 也能导出） ----------
// 与 BibTeX/RIS 的区别：字段是结构化的（作者分 family/given、日期是 date-parts）。
// v6 起作者本身就是结构化的，这里直接对上：有名有姓的写 {family, given}，
// 整体一个字段的名字（机构名、中文名）写 {literal}。
const CSL_TYPE = {
  journalArticle: 'article-journal', conferencePaper: 'paper-conference', book: 'book',
  thesis: 'thesis', report: 'report', webpage: 'webpage', document: 'document',
};
const CSL_TYPE_BACK = {
  'article-journal': 'journalArticle', 'article-magazine': 'journalArticle',
  'paper-conference': 'conferencePaper', proceedings: 'conferencePaper',
  book: 'book', thesis: 'thesis', report: 'report', webpage: 'webpage',
  manuscript: 'document', document: 'document', article: 'document', paper: 'document',
};

function cslToRecord(o) {
  if (!o || typeof o !== 'object') return null;
  const rec = {
    itemType: CSL_TYPE_BACK[String(o.type || '').toLowerCase()] || 'document',
    title: s(o.title),
    creators: [],
    year: '',
    publication: s(o['container-title'] || o['event-title'] || o.publisher || o['publisher-place'] || o.genre),
    volume: s(o.volume), issue: s(o.issue), pages: s(o.page),
    doi: s(o.DOI), url: s(o.URL), abstract: s(o.abstract), note: s(o.note),
    language: s(o.language), tags: [],
  };
  // CSL-JSON 的作者本来就有 family / given 结构，v6 起直接对上，
  // 不用再假装 {"literal": "整串姓名"}（Zotero / citeproc 读不懂就丢结构）
  const pushCsl = (arr, type) => {
    for (const a of (Array.isArray(arr) ? arr : (arr ? [arr] : []))) {
      if (!a || typeof a !== 'object') continue;
      if (a.literal) {
        const lit = s(a.literal);
        if (lit) rec.creators.push({ firstName: '', lastName: lit, creatorType: type });
        continue;
      }
      const fam = s(a.family), giv = s(a.given);
      if (fam || giv) rec.creators.push({ firstName: giv, lastName: fam, creatorType: type });
    }
  };
  pushCsl(o.author, 'author');
  pushCsl(o.editor, 'editor');
  pushCsl(o.translator, 'translator');
  pushCsl(o.contributor, 'contributor');
  const parts = o.issued && o.issued['date-parts'] && o.issued['date-parts'][0];
  if (parts && parts.length) rec.year = String(parts[0]);
  if (Array.isArray(o.keyword)) rec.tags = o.keyword.map(s).filter(Boolean);
  else if (o.keyword) rec.tags = String(o.keyword).split(/[,;]/).map((x) => x.trim()).filter(Boolean);
  return (rec.title || rec.creators.length) ? rec : null;
}

function parseCslJson(text) {
  const data = JSON.parse(String(text || '').replace(/^﻿/, ''));
  const arr = Array.isArray(data) ? data : (data && Array.isArray(data.items) ? data.items : [data]);
  return arr.map(cslToRecord).filter(Boolean);
}

function recordsToCslJson(records) {
  const out = (records || []).map((r) => {
    const o = { id: r.key, type: CSL_TYPE[r.itemType] || 'document', title: s(r.title) };
    const list = Creators.normalizeCreators(r.creators);
    const cslName = (c) => (c.firstName
      ? { family: c.lastName, given: c.firstName }
      : { literal: c.lastName });
    const authors = list.filter((c) => c.creatorType === 'author');
    const editors = list.filter((c) => c.creatorType === 'editor');
    const translators = list.filter((c) => c.creatorType === 'translator');
    const others = list.filter((c) => c.creatorType === 'contributor');
    if (authors.length) o.author = authors.map(cslName);
    if (editors.length) o.editor = editors.map(cslName);
    if (translators.length) o.translator = translators.map(cslName);
    if (others.length) o.contributor = others.map(cslName);
    const y = yearOf(r.year);
    if (y) o.issued = { 'date-parts': [[Number(y) || y]] };
    if (s(r.publication)) o['container-title'] = s(r.publication);
    if (s(r.volume)) o.volume = s(r.volume);
    if (s(r.issue)) o.issue = s(r.issue);
    if (s(r.pages)) o.page = s(r.pages);
    if (s(r.doi)) o.DOI = s(r.doi);
    if (s(r.url)) o.URL = s(r.url);
    if (s(r.abstract)) o.abstract = s(r.abstract);
    if (s(r.note)) o.note = s(r.note);
    if (s(r.language)) o.language = s(r.language);
    if ((r.tags || []).length) o.keyword = r.tags.slice();
    return o;
  });
  return JSON.stringify(out, null, 2);
}

module.exports = {
  parseBibtex, parseRis, parseEndNote, parseRefWorks, parseEndNoteXml, parseRefs, detectFormat,
  recordsToBibtex, recordsToRis, parseCslJson, recordsToCslJson,
  _bibToRecord: bibToRecord, _risToRecord: risToRecord, _splitAuthors: splitAuthors,
  _cslToRecord: cslToRecord,
};
