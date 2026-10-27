'use strict';
/*
 * 统一检索语法解析（对标 Zotero 10 检索补强 + 2026-10-22 报告遗留项）。
 *
 * 语法：
 *   机器学习            普通词；连续 CJK 串天然按短语整体匹配（不再有子串误命中的歧义）
 *   "deep learning"     引号短语（直引号 / 中文引号都认）
 *   -综述  -"书评"      排除（减号开头；-紧跟词或引号才算，词中间的 foo-bar 不算）
 *   title:xxx           字段限定；value 可以是裸词或引号短语
 *   author: 相当于 creator:；file: 相当于 attachment:
 *   a OR b  a | b       「或」；OR 要大写，避免把英文单词 or 当运算符
 *   (a OR b) c          括号分组 + 隐式 AND
 *   -(a OR b)           整组排除
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

// ---------- 词法 ----------
// token 形态：{k:'('} / {k:')'} / {k:'OR'} / {k:'NOT'} / {k:'TERM', tok:{t,phrase,cjk,field}}
function makeTerm(raw, phrase, field) {
  const t = fold(raw);
  if (!t) return null;
  return { t, phrase: !!phrase || hasCJK(raw), cjk: hasCJK(raw), field: field || null };
}

function tokenize(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '(' || ch === ')') { out.push({ k: ch }); i++; continue; }
    // OR 运算符：|| / | / 大写 OR（小写 or 仍当普通词，英文摘要里太常见）
    if (ch === '|') { i += s[i + 1] === '|' ? 2 : 1; out.push({ k: 'OR' }); continue; }
    // 排除前缀：- 必须紧跟内容（词 / 引号 / 括号），词中间的 foo-bar 不算
    if (ch === '-' && i + 1 < s.length && !/\s/.test(s[i + 1])) {
      out.push({ k: 'NOT' });
      i++;
      continue;
    }
    // 字段前缀 field:（只认已知别名，未知的当普通词，保持老行为）
    let field = null;
    const fm = /^[A-Za-z_]+:/.exec(s.slice(i, i + 24));
    if (fm) {
      const name = FIELD_ALIASES[fm[0].slice(0, -1).toLowerCase()];
      if (name) { field = name; i += fm[0].length; }
    }
    // 引号短语（内部连续两个引号表示字面引号，供条件构建器无损往返）
    const q = s[i];
    if (q && CLOSE_QUOTE[q]) {
      const close = CLOSE_QUOTE[q];
      let j = i + 1, raw = '';
      while (j < s.length) {
        if (s[j] === close) {
          if (close === '"' && s[j + 1] === '"') { raw += '"'; j += 2; continue; }
          break;
        }
        raw += s[j++];
      }
      i = j < s.length ? j + 1 : s.length;
      const tok = makeTerm(raw, true, field);
      if (tok) out.push({ k: 'TERM', tok });
      continue;
    }
    // 裸词：读到空白或括号
    let j = i;
    while (j < s.length && !/[\s()]/.test(s[j])) j++;
    const raw = s.slice(i, j);
    i = j;
    if (!raw) continue;
    if (!field && raw === 'OR') { out.push({ k: 'OR' }); continue; }
    if (!field && raw === 'AND') { out.push({ k: 'AND' }); continue; }
    if (!field && raw === '-') continue;   // 孤立减号
    const tok = makeTerm(raw, false, field);
    if (tok) out.push({ k: 'TERM', tok });
  }
  return out;
}

// ---------- 语法 ----------
// expr := and (OR and)*
// and  := unary+            （隐式 AND；遇到 OR / ) / 结束就停）
// unary:= NOT unary | '(' expr ')' | TERM
function parseTree(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];

  function parseOr() {
    const parts = [parseAnd()];
    while (peek() && peek().k === 'OR') { pos++; parts.push(parseAnd()); }
    // 去掉落单的 OR 产生的空分支（`a OR` / `OR b` 应该按 `a` / `b` 处理，而不是恒真）
    const real = parts.filter((p) => p && p.type !== 'true');
    if (!real.length) return { type: 'true' };
    return real.length === 1 ? real[0] : { type: 'or', children: real };
  }
  function parseAnd() {
    const parts = [];
    while (peek() && peek().k !== 'OR' && peek().k !== ')') {
      if (peek().k === 'AND') { pos++; continue; }   // 显式 AND 只是分隔符，AND 本来就是默认
      const before = pos;
      parts.push(parseUnary());
      if (pos === before) pos++;   // 兜底：绝不原地打转
    }
    if (!parts.length) return { type: 'true' };
    return parts.length === 1 ? parts[0] : { type: 'and', children: parts };
  }
  function parseUnary() {
    const t = peek();
    if (!t) return { type: 'true' };
    if (t.k === 'NOT') { pos++; return { type: 'not', child: parseUnary() }; }
    if (t.k === '(') {
      pos++;
      const n = parseOr();
      if (peek() && peek().k === ')') pos++;
      return n;
    }
    if (t.k === 'TERM') { pos++; return { type: 'term', tok: t.tok }; }
    pos++;                       // 落单的 ')' 之类，忽略
    return { type: 'true' };
  }

  return parseOr();
}

function parseQuery(input) {
  const raw = String(input == null ? '' : input).trim();
  const tree = parseTree(tokenize(raw));
  const ast = {
    raw, tree,
    text: [],       // 自由词（非字段），排序 / 摘要锚点用
    not: [],        // 被排除的自由词（兼容老接口 matchFieldsNot）
    fields: {},     // 纯 AND 上下文的字段条件（兼容老接口）
    freeTokens: [], // 树里全部自由词（含 OR 分支）
    fieldTokens: [],// 树里全部字段词（含 OR 分支）
    hasOr: false,
    hasParens: /[()]/.test(raw),
  };

  (function collect(n, negated, underOr) {
    if (!n) return;
    if (n.type === 'term') {
      const tok = n.tok;
      if (tok.field) {
        ast.fieldTokens.push(tok);
        // 只有「顶层 AND 里的字段条件」才进 fields：OR 分支整体求值，不能当成硬性约束
        if (!negated && !underOr) {
          if (!ast.fields[tok.field]) ast.fields[tok.field] = [];
          ast.fields[tok.field].push(tok);
        }
      } else {
        ast.freeTokens.push(tok);
        if (negated) {
          if (!ast.not.some((x) => x.t === tok.t)) ast.not.push(tok);
        } else {
          ast.text.push(tok);
        }
      }
      return;
    }
    if (n.type === 'or') ast.hasOr = true;
    if (n.type === 'not') { collect(n.child, !negated, underOr); return; }
    for (const c of n.children || []) collect(c, negated, underOr || n.type === 'or');
  })(tree, false, false);

  return ast;
}

// ---------- 求值 ----------
// 布尔求值：test(tok) → true / false
function evalNode(node, test) {
  if (!node) return true;
  switch (node.type) {
    case 'term': return !!test(node.tok);
    case 'not': return !evalNode(node.child, test);
    case 'and': return node.children.every((c) => evalNode(c, test));
    case 'or': return node.children.some((c) => evalNode(c, test));
    default: return true;
  }
}

// 三值求值：true / false / null（null = 这一段交给别的层判断）
// 用来做「只过滤字段」和「只过滤正文」两种局部匹配。
function eval3(node, test) {
  if (!node) return true;
  switch (node.type) {
    case 'term': {
      const v = test(node.tok);
      return v === undefined ? true : v;
    }
    case 'not': {
      const v = eval3(node.child, test);
      return v === null ? null : !v;
    }
    case 'and': {
      let sawNull = false;
      for (const c of node.children) {
        const v = eval3(c, test);
        if (v === false) return false;
        if (v === null) sawNull = true;
      }
      return sawNull ? null : true;
    }
    case 'or': {
      let sawNull = false;
      for (const c of node.children) {
        const v = eval3(c, test);
        if (v === true) return true;
        if (v === null) sawNull = true;
      }
      return sawNull ? null : false;
    }
    default: return true;
  }
}

// ---------- 基础匹配 ----------
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

// 正文 / 摘录 / 批注 / 笔记这些纯文本的匹配：字段条件视为「不归我管」（null）
function matchText(hay, ast) {
  if (!ast || !ast.tree) return matchTokens(hay, ast && ast.text);
  return eval3(ast.tree, (tok) => (tok.field ? null : hay.indexOf(tok.t) >= 0)) !== false;
}

// 全文检索用：返回 { ok, hits: Map<token, 次数> }，命中次数拿去算相关性
function evalText(hay, ast) {
  const hits = new Map();
  if (!ast || !ast.tree) {
    const toks = (ast && ast.text) || [];
    for (const tok of toks) {
      const n = countToken(hay, tok.t);
      if (!n) return { ok: false, hits };
      hits.set(tok, n);
    }
    return { ok: true, hits };
  }
  // 否定分支里的词只参与判定，不算命中：否则 `(a -b) OR c` 会把 b 也记进评分/摘要锚点
  const negated = new Set();
  (function walk(n, neg) {
    if (!n) return;
    if (n.type === 'term') { if (neg) negated.add(n.tok.t); return; }
    if (n.type === 'not') { walk(n.child, !neg); return; }
    for (const c of n.children || []) walk(c, neg);
  })(ast.tree, false);

  const ok = eval3(ast.tree, (tok) => {
    if (tok.field) return null;
    const n = countToken(hay, tok.t);
    if (n && !negated.has(tok.t)) hits.set(tok, n);
    return n > 0;
  }) !== false;
  return { ok, hits };
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

// 只做字段限定匹配（字段条件全中；自由词不参与）——合并检索结果过滤用
// 自由词在 OR 里可能让整组为真，这时返回 null（不拦截），由正文命中决定。
function matchFields(it, ast) {
  if (!ast) return true;
  if (!ast.tree) {
    const fields = (ast.fields) || {};
    for (const name of Object.keys(fields)) {
      const vals = fieldValues(it, name).map(fold).join(' \n ');
      if (!matchTokens(vals, fields[name])) return false;
    }
    return true;
  }
  const cache = {};
  const v = eval3(ast.tree, (tok) => {
    if (!tok.field) return null;
    if (!(tok.field in cache)) cache[tok.field] = fieldValues(it, tok.field).map(fold).join(' \n ');
    return cache[tok.field].indexOf(tok.t) >= 0;
  });
  return v !== false;
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
  if (!ast) return true;
  // 没有 OR 时保持老语义：字段全中 + 排除词在整个条目里都不出现
  if (!ast.hasOr) {
    if (!matchFields(it, ast)) return false;
    return matchNone(itemHaystack(it), ast.not);
  }
  // 有 OR 时按整棵树在条目层求值：字段条件照常，「自由词在条目里没出现」记 null
  // （归正文层判断），否则 OR 分支里的否定词会把本该保留的结果误杀。
  const hay = itemHaystack(it);
  const cache = {};
  const v = eval3(ast.tree, (tok) => {
    if (!tok.field) return hay.indexOf(tok.t) >= 0 ? true : null;
    if (!(tok.field in cache)) cache[tok.field] = fieldValues(it, tok.field).map(fold).join(' \n ');
    return cache[tok.field].indexOf(tok.t) >= 0;
  });
  return v !== false;
}

// 库内条目匹配：按语法树求值（字段词查对应字段，自由词查整条 haystack）
function matchLibraryItem(it, ast) {
  if (!ast) return true;
  if (!ast.tree) {
    if (!matchFields(it, ast)) return false;
    const hay0 = itemHaystack(it);
    if (!matchTokens(hay0, ast.text)) return false;
    for (const tok of ast.not) {
      if (hay0.indexOf(tok.t) >= 0) return false;
    }
    return true;
  }
  const hay = itemHaystack(it);
  const cache = {};
  return evalNode(ast.tree, (tok) => {
    if (!tok.field) return hay.indexOf(tok.t) >= 0;
    if (!(tok.field in cache)) cache[tok.field] = fieldValues(it, tok.field).map(fold).join(' \n ');
    return cache[tok.field].indexOf(tok.t) >= 0;
  });
}

// All search sources use the same occurrence, phrase and density weights.
function scoreText(hay, ast) {
  const m = evalText(hay, ast);
  let score = 0, count = 0;
  if (m.ok) for (const [tok, n] of m.hits) { count += n; score += n * (tok.phrase ? 3 : 1); }
  return { count, score: score + count * 1000 / Math.max(60, hay.length) };
}

// ---------- 可视化条件构建器（检索 UI 的纯逻辑部分，Node 可测） ----------
// 行模型：{ field: 'title'|'author'|...|''（全文）, op: 'contains'|'exclude', value, raw? }
// 只生成查询语言里已有的语法：field:词 / -field:词 / 引号短语，多条件 AND。
//
// 往返约定（B05）：能被「AND + 字段限定 + 排除 + 短语」表达的查询，拆成行再拼回来语义等价；
// 表达不了（OR / 括号 / 未闭合引号 / 裸引号）的整串保留成一行 raw，buildQuery 原样返回，
// 绝不把 `author:Smith year:2024` 这种隐式 AND 拼成 `author:"Smith year:2024"`。
function quoteValue(v) {
  // 短语内的双引号用 "" 表示；tokenize 按同样规则还原
  return '"' + String(v).replace(/"/g, '""') + '"';
}

function needsQuote(v) {
  const s0 = String(v);
  return /\s/.test(s0) || /^[-+]/.test(s0) || /["\u201c\u201d()|]/.test(s0)
    || s0 === 'AND' || s0 === 'OR' || /^[A-Za-z_]+:/.test(s0);
}

function buildQuery(rows) {
  const list = Array.isArray(rows) ? rows : [];
  // 原串行：整条查询原样返回（用户在面板里直接改这段语法也照原样用）
  if (list.length === 1 && list[0] && list[0].raw) return String(list[0].value || '').trim();
  const parts = [];
  for (const r of list) {
    const v = String((r && r.value) || '').trim();
    if (!v) continue;
    const f = String((r && r.field) || '').trim().toLowerCase();
    const field = (f && FIELD_ALIASES[f]) ? f + ':' : '';
    parts.push((r.op === 'exclude' ? '-' : '') + field + (needsQuote(v) ? quoteValue(v) : v));
  }
  return parts.join(' AND ');
}

// 把查询串按「隐式 AND / 显式 AND / 字段限定 / 排除 / 引号短语」切成行。
// 返回 { ok:false } 表示这段语法无法无损拆行（OR、括号、管道、未闭合或裸引号）。
function scanQueryRows(q) {
  const rows = [];
  const n = q.length;
  let i = 0;
  while (i < n) {
    while (i < n && /\s/.test(q[i])) i++;
    if (i >= n) break;
    const ch = q[i];
    if (ch === '(' || ch === ')' || ch === '|') return { ok: false };
    let exclude = false;
    if (ch === '-' && i + 1 < n && !/\s/.test(q[i + 1])) { exclude = true; i++; }
    let field = '';
    const fm = /^([A-Za-z_]+):/.exec(q.slice(i, i + 32));
    if (fm && FIELD_ALIASES[fm[1].toLowerCase()]) { field = FIELD_ALIASES[fm[1].toLowerCase()]; i += fm[0].length; }
    if (i >= n) return { ok: false };
    let value = '';
    let phrase = false;
    const qch = q[i];
    if (CLOSE_QUOTE[qch]) {
      const close = CLOSE_QUOTE[qch];
      let j = i + 1, buf = '', closed = false;
      while (j < n) {
        if (q[j] === close) {
          if (close === '"' && q[j + 1] === '"') { buf += '"'; j += 2; continue; }
          closed = true; j++; break;
        }
        buf += q[j++];
      }
      if (!closed) return { ok: false };   // 引号没闭合：别猜用户想说什么
      value = buf; phrase = true; i = j;
    } else {
      let j = i;
      while (j < n && !/[\s()]/.test(q[j])) j++;
      value = q.slice(i, j); i = j;
      if (/["\u201c\u201d]/.test(value)) return { ok: false };   // 词中间的裸引号
    }
    if (!field && !phrase && value === 'AND') continue;   // 显式 AND 只是分隔符
    if (!field && !phrase && value === 'OR') return { ok: false };
    if (!field && value === '-') continue;                // 孤立减号
    if (!value) return { ok: false };
    rows.push({ field, op: exclude ? 'exclude' : 'contains', value });
  }
  return { ok: true, rows };
}

// 把查询串反向拆成行。空串返回空数组；无法无损表达的整串保留为 raw 行。
function parseQueryToRows(query) {
  const q = String(query || '').trim();
  if (!q) return [];
  const scan = scanQueryRows(q);
  if (!scan.ok || !scan.rows.length) return [{ field: '', op: 'contains', value: q, raw: true }];
  return scan.rows;
}

return {
  fold, hasCJK, parseQuery,
  matchTokens, matchNone, anyToken, countToken, firstHit,
  matchText, evalText, evalNode, eval3, scoreText,
  creatorsText, fieldValues, matchFields, matchFieldsNot, itemHaystack, matchLibraryItem,
  buildQuery, parseQueryToRows,
  CJK_RE,
};
});
