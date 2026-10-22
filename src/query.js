'use strict';
/*
 * 统一检索语法解析（对标 Zotero 10 检索补强，2026-10-22 报告优先级第 1 项）。
 *
 * 语法：
 *   机器学习            普通词；连续 CJK 串天然按短语整体匹配（不再有子串误命中的歧义）
 *   "deep learning"     引号短语（直引号 / 中文引号都认）
 *   -综述  -"书评"      排除（减号开头；-紧跟词或引号才算，词中间的 foo-bar 不算）
 *   title:xxx           字段限定；value 可以是裸词或引号短语
 *   author: 相当于 creator:；file: 相当于 attachment:
 *
 * 全部匹配都走 fold()：小写 + 拉丁变音折叠（cafe 命中 café）+ 弯引号折叠 + 空白归一。
 * UMD 风格，主进程（fulltext / main）与渲染进程（library-ui）共用一份实现：
 *   Node：   require('./query.js')
 *   浏览器： <script src="../query.js"></script> → window.Query
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Query = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

// 拉丁扩展区逐字符折叠，绝不整串 NFD——整串 NFD 会把韩文拆成 jamo、把长度改得和原文对不上
function fold(s) {
  let out = String(s == null ? '' : s).toLowerCase();
  if (/[\u00c0-\u024f]/.test(out)) {
    out = out.replace(/[\u00c0-\u024f]/g, (c) => c.normalize('NFD').replace(/[\u0300-\u036f]/g, ''));
  }
  return out
    .replace(/[\u0300-\u036f]/g, '')                    // 孤立组合符（NFD 形态的 café）
    .replace(/[\u2018\u2019\u02bc\u2032]/g, "'")        // 弯单引号 → '
    .replace(/[\u201c\u201d\u201e\u2033]/g, '"')        // 弯双引号 → "
    .replace(/[\u00a0\u2007\u202f\u3000]/g, ' ')        // 各类空格 → 普通空格
    .replace(/\s+/g, ' ')
    .trim();
}

function hasCJK(s) { return CJK_RE.test(String(s || '')); }

const FIELD_ALIASES = {
  title: 'title',
  author: 'author',
  creator: 'author',
  year: 'year',
  publication: 'publication',
  journal: 'publication',
  tag: 'tag',
  tags: 'tag',
  note: 'note',
  notes: 'note',
  abstract: 'abstract',
  type: 'type',
  itemtype: 'type',
  file: 'file',
  attachment: 'file',
  doi: 'doi',
  url: 'url',
  volume: 'volume',
  issue: 'issue',
  pages: 'pages',
  language: 'language',
};

const CLOSE_QUOTE = { '"': '"', '\u201c': '\u201d', '\u2018': '\u2019' };

// token: { t: 折叠后的文本, phrase: 是否短语匹配, cjk: 是否含 CJK }
function parseQuery(input) {
  const ast = { raw: String(input == null ? '' : input).trim(), text: [], not: [], fields: {} };
  const s = ast.raw;
  let i = 0;
  const emit = (raw, phrase, field, negate) => {
    const t = fold(raw);
    if (!t) return;
    const tok = { t, phrase: !!phrase || hasCJK(raw), cjk: hasCJK(raw) };
    if (field) {
      if (!ast.fields[field]) ast.fields[field] = [];
      ast.fields[field].push(tok);
    } else {
      (negate ? ast.not : ast.text).push(tok);
    }
  };
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i++; continue; }
    // 排除前缀：- 必须紧跟内容（词或引号），且在 token 边界上
    let negate = false;
    if (ch === '-' && i + 1 < s.length && s[i + 1] !== ' ') {
      negate = true;
      i++;
    }
    // 字段前缀 field:
    let field = null;
    const fm = /^[A-Za-z_]+:/.exec(s.slice(i, i + 24));
    if (fm) {
      const name = FIELD_ALIASES[fm[0].slice(0, -1).toLowerCase()];
      if (name) { field = name; i += fm[0].length; }
    }
    // 引号短语
    const q = s[i];
    if (q && CLOSE_QUOTE[q]) {
      const end = s.indexOf(CLOSE_QUOTE[q], i + 1);
      const raw = end < 0 ? s.slice(i + 1) : s.slice(i + 1, end);
      i = end < 0 ? s.length : end + 1;
      emit(raw, true, field, negate);
      continue;
    }
    // 裸词：读到下一个空白
    let j = i;
    while (j < s.length && !/\s/.test(s[j])) j++;
    const raw = s.slice(i, j);
    i = j;
    if (field && !raw) continue;          // field: 后面没跟内容
    if (!field && raw === '-') continue;  // 孤立的减号
    emit(raw, false, field, negate);
  }
  return ast;
}

// tokens 全部命中（hay 必须已 fold）
function matchTokens(hay, tokens) {
  if (!tokens || !tokens.length) return true;
  for (const tok of tokens) {
    if (hay.indexOf(tok.t) < 0) return false;
  }
  return true;
}

// 任一 token 都不命中（排除用）：命中即 false
function matchNone(hay, tokens) {
  if (!tokens || !tokens.length) return true;
  for (const tok of tokens) {
    if (hay.indexOf(tok.t) >= 0) return false;
  }
  return true;
}

// 任一 token 命中即 true（用于轻量场景；主路径用 matchTokens）
function anyToken(hay, tokens) {
  if (!tokens || !tokens.length) return false;
  for (const tok of tokens) {
    if (hay.indexOf(tok.t) >= 0) return true;
  }
  return false;
}

// token 在 hay 里出现的次数
function countToken(hay, t) {
  let n = 0, idx = hay.indexOf(t);
  while (idx >= 0) { n++; idx = hay.indexOf(t, idx + t.length); }
  return n;
}

// token 在 hay 里的锚点：短语命中优先，其次最早出现的词（snippet 定位用）
function firstHit(hay, tokens) {
  if (!tokens || !tokens.length) return -1;
  let best = -1;
  for (const tok of tokens) {
    if (!tok.phrase) continue;
    const at = hay.indexOf(tok.t);
    if (at >= 0 && (best < 0 || at < best)) best = at;
  }
  if (best >= 0) return best;
  for (const tok of tokens) {
    const at = hay.indexOf(tok.t);
    if (at >= 0 && (best < 0 || at < best)) best = at;
  }
  return best;
}

// creators 兼容两种形态：结构化 [{firstName, lastName, creatorType}] / 旧数据字符串数组
function creatorsText(creators) {
  if (!Array.isArray(creators)) return '';
  return creators.map((c) => {
    if (c && typeof c === 'object') return [c.lastName, c.firstName].filter(Boolean).join(' ');
    return String(c || '');
  }).filter(Boolean).join(' ');
}

// 条目各字段的取值（matchFields / matchLibraryItem 共用）
function fieldValues(it, field) {
  switch (field) {
    case 'title': return [it.title];
    case 'author': return [creatorsText(it.creators)];
    case 'year': return [it.year == null ? '' : String(it.year)];
    case 'publication': return [it.publication];
    case 'tag': return [(it.tags || []).join(' ')];
    case 'note': return [(it.notes || []).map((n) => [n.title, n.text].filter(Boolean).join(' ')).join(' \n ')];
    case 'abstract': return [it.abstract];
    case 'type': return [it.itemType];
    case 'file': return [(it.attachment && it.attachment.name) || ''];
    case 'doi': return [it.doi];
    case 'url': return [it.url];
    case 'volume': return [it.volume];
    case 'issue': return [it.issue];
    case 'pages': return [it.pages];
    case 'language': return [it.language];
    default: return [''];
  }
}

// 只做字段限定匹配（字段条件全中；text/not 不参与）——合并检索结果过滤用
function matchFields(it, ast) {
  const fields = (ast && ast.fields) || {};
  for (const name of Object.keys(fields)) {
    const vals = fieldValues(it, name).map(fold).join(' \n ');
    if (!matchTokens(vals, fields[name])) return false;
  }
  return true;
}

// 条目全部可搜索文本（fold 过）：库内筛选的 must / not 都作用在这上面
function itemHaystack(it) {
  const parts = [
    it.title, creatorsText(it.creators),
    it.year == null ? '' : String(it.year),
    it.publication, it.volume, it.issue, it.pages,
    it.doi, it.url, it.abstract, it.note, it.language,
    (it.tags || []).join(' '),
    (it.attachment && it.attachment.name) || '',
    (it.notes || []).map((n) => [n.title, n.text].filter(Boolean).join(' ')).join(' \n '),
  ];
  return fold(parts.filter(Boolean).join(' \n '));
}

// 字段限定 + 排除（不含正文 must）——合并检索结果按条目过滤用
function matchFieldsNot(it, ast) {
  if (!matchFields(it, ast)) return false;
  return matchNone(itemHaystack(it), ast.not);
}

// 库内条目匹配：字段限定（全中）+ 文本 must（全中）+ not（全不中）
function matchLibraryItem(it, ast) {
  if (!ast) return true;
  if (!matchFields(it, ast)) return false;
  const hay = itemHaystack(it);
  if (!matchTokens(hay, ast.text)) return false;
  for (const tok of ast.not) {
    if (hay.indexOf(tok.t) >= 0) return false;
  }
  return true;
}

return {
  fold, hasCJK, parseQuery,
  matchTokens, matchNone, anyToken, countToken, firstHit,
  creatorsText, fieldValues, matchFields, matchFieldsNot, itemHaystack, matchLibraryItem,
  CJK_RE,
};
});
