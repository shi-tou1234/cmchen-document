'use strict';
/*
 * 参考文献表批量入库（v36）。
 *
 * 场景：读到一篇综述，末尾 100 条参考文献里一半是你想要的，现在只能一条条搜 DOI 建条目。
 * 这里把「参考文献表 → 库条目」这条链自动化：
 *   1) splitEntries：把参考文献区的行拆成一条条（编号制 / 作者-年份制 / GB/T 7714）
 *   2) parseEntry：从一条里尽力抽出 DOI、arXiv、年份、标题、作者、刊名、卷期页、类型
 *   3) plan：跟现有库比对（DOI → 标题+年份），标出「新增 / 已有 / 认不出」
 *   4) toRecord：转成 library.importItems 要的记录
 *
 * 三件事必须说清楚：
 *   - 这是**启发式**解析。有 DOI 的条目会被 Crossref 全量覆盖，准不准无所谓；
 *     没 DOI 的只能靠「作者. 题名. 刊名, 年」的形态猜，所以每条都标了 confidence，
 *     界面上逐条给用户过目、逐条可取消，而不是闷头入库。
 *   - 解析器不联网、不读库、不写盘（纯函数），方便单测，也方便换实现。
 *   - 一行拆错不会毁掉整批：拆错的后果只是多了/少了几个条目，用户能取消。
 */

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

const MAX_ENTRIES = 400;
const MAX_ENTRY_CHARS = 1600;

// 参考文献区的标题行（与 smartjump 的 isBibHeading 保持一致的判定范围）
const HEADING_RE = /^(references|bibliography|works cited|reference list|literature cited|references and notes|参考文献|參考文獻|参考文献表|引用文献|主要参考文献)$/i;

function normSpace(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

function isHeading(text) {
  const t = normSpace(text).replace(/^[—–\-\s]+|[—–\-\s:.。]+$/g, '');
  return HEADING_RE.test(t);
}

// 纯页码行（"12" / "- 12 -" / "12 / 340"）：参考文献区里到处都是，不能当条目也不能当续行
function isPageNumber(text) {
  const t = normSpace(text);
  return /^[-–—\s]*(?:\d{1,4})(?:\s*\/\s*\d{1,4})?[-–—\s]*$/.test(t);
}

function normDoi(d) {
  return String(d == null ? '' : d)
    .toLowerCase()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '')
    .replace(/^doi:\s*/, '')
    .trim();
}

// 与 library.normTitle 同一口径（去空白与标点、小写），两边算出来的键才对得上
function foldTitle(t) {
  return String(t == null ? '' : t).toLowerCase().replace(/[\s\-_.,:;!?()[\]{}'"“”‘’·]+/g, '');
}

function titleKey(title, year) {
  const t = foldTitle(title);
  return t ? t + '|' + normSpace(year) : '';
}

// ---------- DOI / arXiv ----------

// 参考文献里的 DOI 常带句点或右括号结尾（"…10.1000/xyz.123." 、"…(2019))."）。
// 右括号只在明显不成对时才去：DOI 本身合法地含括号，如 10.1016/0002-9610(86)90192-2
function doiIn(text) {
  const m = /10\.\d{4,9}\/[-._;()/:a-z0-9]+/i.exec(String(text || ''));
  if (!m) return '';
  let d = m[0].replace(/[.,;:]+$/, '');
  const open = (d.match(/\(/g) || []).length;
  const close = (d.match(/\)/g) || []).length;
  if (close > open) d = d.replace(/\)+$/, '');
  return normDoi(d).replace(/[.,;:]+$/, '');
}

function arxivIn(text) {
  const s = String(text || '');
  const m = /arxiv[:.\s/]*((?:\d{4}\.\d{4,5})|(?:[a-z][a-z-]*(?:\.[A-Za-z]{2})?\/\d{7}))(?:v\d+)?/i.exec(s);
  return m ? m[1] : '';
}

// ---------- 年份 ----------

function guessYear(text) {
  const s = String(text || '');
  // ① 括号里的年份最可靠：APA 的 "(2020)."、GB/T 的 "（2020）"
  const paren = /[(（]\s*((?:1[5-9]|20|21)\d{2})[a-z]?\s*[)）]/.exec(s);
  if (paren) return paren[1];
  // ② 结尾的年份："…, pp. 1-10, 2020."
  const tail = /((?:1[5-9]|20|21)\d{2})[a-z]?\s*[.)]?\s*$/.exec(s);
  if (tail) return tail[1];
  // ③ 否则取最后一个看起来像年份的四位数（标题里出现年份时可能猜错，标注里会体现）
  const all = s.match(/\b(?:1[5-9]|20|21)\d{2}\b/g);
  return all && all.length ? all[all.length - 1] : '';
}

// ---------- 条目切分 ----------

const NUM_MARK = /^\s*(?:\[\s*(\d{1,3})\s*\]|[(（]\s*(\d{1,3})\s*[)）]|(\d{1,3})\s*[.)、]\s)/;
const BULLET_MARK = /^\s*[·•▪◦‣*]\s+/;
// 作者-年份制开头："Smith, J. A." / "Smith, J." / "J. A. Smith," / "SMITH J,"
const AY_MARK = /^\s*(?:[A-Z][A-Za-z'’\-]{1,}\s*,\s*(?:[A-Z]\.\s*)|(?:[A-Z]\.\s*){1,4}[A-Z][A-Za-z'’\-]{1,}\s*[,.]|[A-Z][A-Z'’\-]{1,}\s+[A-Z]{1,3}[,.]|[\u4e00-\u9fff·]{2,6}\s*[.．,，])/;

function numberAt(text) {
  const m = NUM_MARK.exec(String(text || ''));
  if (!m) return 0;
  return parseInt(m[1] || m[2] || m[3] || '0', 10) || 0;
}

// 这一行是不是一条新条目的开头。返回 { kind, num } 或 null。
function entryStart(text) {
  const t = String(text || '');
  const num = numberAt(t);
  if (num) return { kind: 'number', num };
  if (BULLET_MARK.test(t)) return { kind: 'bullet', num: 0 };
  if (AY_MARK.test(t)) return { kind: 'author', num: 0 };
  return null;
}

/*
 * 行数组 → 条目文本数组。
 *
 * 判定规则（宁可少拆一次，也不要一次拆成两条）：
 *   - 编号 / 项目符号开头：一定算新条目（编号制最常见，也最不会误判）
 *   - 作者-年份开头：只在当前条目已经有内容（>60 字）时才算新条目，
 *     否则 "Smith, J." 这样的行内续行会被误当成新条目
 *   - 什么都没匹配上：算续行（参考文献普遍跨行）
 */
function splitEntries(lines) {
  const list = (Array.isArray(lines) ? lines : [])
    .map((x) => normSpace(typeof x === 'string' ? x : (x && x.text) || ''))
    .filter(Boolean);
  const out = [];
  let cur = '';
  let overflow = false;
  const flush = () => {
    const t = normSpace(cur);
    if (t) out.push(t);
    cur = '';
  };
  for (const text of list) {
    const start = entryStart(text);
    // 作者-年份开头算不算新条目：当前这条已经有内容（够长，或已经收尾在年份上）
    // 才算，否则 "Smith, J." 这种行内续行会把一条文献切成两半。
    const hasBody = cur.length >= 40 || /(?:1[5-9]|20|21)\d{2}[a-z]?[.,;]?\s*$/.test(cur);
    const brk = !!start && !!cur && (start.kind !== 'author' || hasBody);
    if (brk) { flush(); overflow = false; }
    if (!cur) {
      cur = text;
    } else if (overflow) {
      // 一条长得离谱（多半是没识别出边界）：硬切，别让一条吃掉整节
      flush(); cur = text; overflow = false;
    } else {
      cur += ' ' + text;
    }
    if (cur.length > MAX_ENTRY_CHARS) overflow = true;
  }
  flush();
  return out;
}

/*
 * 兜底：整节只拆出一条、但行数不少时，说明没有编号也没有作者标记。
 * 退化成「上一行以句点收尾 + 当前行以大写/中文开头 + 上一行够长」切段。
 */
function splitBySentence(lines) {
  const list = (Array.isArray(lines) ? lines : []).map((x) => normSpace(x)).filter(Boolean);
  const out = [];
  let cur = '';
  for (const text of list) {
    const prevEnded = /[.。]$/.test(cur);
    const looksNew = /^[A-Z0-9“"《(\u4e00-\u9fff]/.test(text);
    if (cur && prevEnded && looksNew && cur.length >= 50) { out.push(normSpace(cur)); cur = text; }
    else cur = cur ? cur + ' ' + text : text;
  }
  if (normSpace(cur)) out.push(normSpace(cur));
  return out;
}

// ---------- 作者 ----------

function dedupeCreators(list) {
  const seen = new Set();
  const out = [];
  for (const c of list) {
    const k = foldTitle(String(c.lastName || '') + ' ' + String(c.firstName || ''));
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

// 作者块 → [{firstName,lastName,creatorType}]
function parseAuthors(block) {
  let b = normSpace(block)
    .replace(/^\s*(?:\[\s*\d{1,3}\s*\]|[(（]\s*\d{1,3}\s*[)）]|\d{1,3}\s*[.)、])\s*/, '')
    .replace(/\bet\s+al\.?/gi, '')
    .replace(/\s+and\s+/gi, ', ')
    .replace(/&/g, ',')
    .replace(/[\s,;，、]+$/, '');
  b = normSpace(b);
  if (!b) return [];
  const out = [];

  if (CJK.test(b)) {
    for (const p of b.split(/[,，、;；]+/)) {
      const n = normSpace(p.replace(/^[\[（(][^\]）)]*[\]）)]/, '')).replace(/[.。]+$/, '');
      if (!n || n.length > 40) continue;
      out.push({ firstName: '', lastName: n, creatorType: 'author' });
    }
    return dedupeCreators(out).slice(0, 30);
  }

  // 名字在前的形态决定用哪套正则：不先判断的话，"J. Smith, A. Lee" 会被
  // 「姓, 缩写」的规则错配成 Smith + A.（把下一个人的缩写算到前一个人头上）
  const initialsFirst = /^\s*(?:[A-Z]\.\s*){1,4}[A-Z][A-Za-z'’\-]/.test(b);
  const SF = /([A-Z][A-Za-z'’\-]+)\s*,\s*((?:[A-Z]\.\s*){1,4})/g;      // Smith, J. A.
  const IF = /((?:[A-Z]\.\s*){1,4})([A-Z][A-Za-z'’\-]{1,})/g;           // J. A. Smith
  const SF2 = /([A-Z][A-Za-z'’\-]+)\s+([A-Z]{1,3})(?=\s*(?:,|$))/g;     // SMITH J, LEE A
  const use = initialsFirst ? IF : SF;
  let m;
  use.lastIndex = 0;
  while ((m = use.exec(b)) && out.length < 40) {
    if (initialsFirst) out.push({ firstName: normSpace(m[1]), lastName: m[2], creatorType: 'author' });
    else out.push({ firstName: normSpace(m[2]), lastName: m[1], creatorType: 'author' });
  }
  if (!out.length) {
    SF2.lastIndex = 0;
    while ((m = SF2.exec(b)) && out.length < 40) {
      out.push({ firstName: '', lastName: m[1], creatorType: 'author' });
    }
  }
  if (!out.length) {
    for (const p of b.split(/\s*,\s*/)) {
      const n = normSpace(p);
      if (!n || n.length > 60) continue;
      const sp = n.split(/\s+/);
      if (sp.length >= 2) out.push({ firstName: sp.slice(0, -1).join(' '), lastName: sp[sp.length - 1], creatorType: 'author' });
      else out.push({ firstName: '', lastName: n, creatorType: 'author' });
    }
  }
  return dedupeCreators(out).slice(0, 30);
}

// ---------- 标题 / 刊名 ----------

const VENUE_RE = /^(?:in\s|proc|proceedings|journal|j\.|nature|science|ieee|acm|natl|nat\.|rev\.|vol|no|pp|p\.|arxiv|doi|https?:|available|retrieved|press|university|springer|elsevier|wiley|routledge|出版|学报|杂志|出版社|大学)/i;
// 名字里的一片：全名（Lee / McDonald）或缩写（J / J. / J.A.）
const NAME_TOKEN = /^(?:[A-Z]\.?|[A-Z]\.(?:[A-Z]\.)+|(?:(?:[A-Z]\.\s*){0,4})[A-Z][A-Za-z'’\-]+)$/;

function isNameChunk(chunk) {
  const c = normSpace(chunk).replace(/^\d+\s*/, '');
  if (!c || c.length > 40) return false;
  if (CJK.test(c)) return c.length <= 6 && !/[0-9]/.test(c);
  const words = c.split(/\s+/);
  if (words.length > 4) return false;
  if (!words.every((w) => NAME_TOKEN.test(w) || /^(?:and|&|van|von|de|der|da|del|la|le)$/i.test(w))) return false;
  if (words.length === 1) return true;
  // 多词时要求里面至少有一个缩写或全大写姓氏：
  // 否则 "Deep Learning"、"Pattern Recognition" 这类两词标题会被当成作者，
  // 整条题名就丢了 —— 宁可留个 "John Smith, 题名" 的脏标题，也别把标题吃掉。
  return words.some((w) => /^[A-Z]\.?$/.test(w) || /^[A-Z][A-Z'’\-]{1,}$/.test(w));
}

// 整行像不像「一串作者」：逗号/分号/and 分开后每片都是名字
function looksLikeAuthorLine(text) {
  const t = normSpace(text);
  if (!t || t.length > 140) return false;
  if (/[?!;:]$/.test(t)) return false;
  if (/^[\u4e00-\u9fff·\s,，、]+$/.test(t)) return t.replace(/[^\u4e00-\u9fff]/g, '').length >= 2;
  const parts = t.split(/\s*[,;]\s*|\s+and\s+|&/).map(normSpace).filter(Boolean);
  if (!parts.length || parts.length > 12) return false;
  return parts.every(isNameChunk);
}

function looksLikeVenue(chunk) {
  const c = normSpace(chunk);
  if (!c) return false;
  if (VENUE_RE.test(c)) return true;
  if (/^\d{4}\b/.test(c)) return true;                 // "2020;5(2):1-10"
  if (/^(?:1[5-9]|20|21)\d{2}$/.test(c)) return true;
  return false;
}

function cleanTitle(t) {
  return normSpace(t)
    .replace(/^[,.;:，、。\s]+/, '')
    .replace(/[,.;:，、。\s]+$/, '')
    .replace(/\s+/g, ' ');
}

// 从「作者后面剩下的部分」里取刊名/年/卷期页
function parseTail(rest) {
  // URL / DOI 链接先摘掉：它们带逗号、句点，会把后面的片段切坏
  const cleaned = normSpace(rest).replace(/\s*<?https?:\/\/\S+>?/gi, '').replace(/\s+doi:\s*\S+$/i, '');
  const segs = cleaned.split(/\s*,\s*/).map(normSpace).filter(Boolean);
  const pub = [];
  let volume = '', issue = '', pages = '';
  const cleanRange = (s) => normSpace(s).replace(/^p{1,2}\.?\s*/i, '').replace(/[.,;，、]+$/, '');
  for (const seg of segs) {
    if (/^(?:vol\.?|volume)\s*/i.test(seg)) { volume = cleanRange(seg.replace(/^(?:vol\.?|volume)\s*/i, '')); continue; }
    if (/^(?:no\.?|issue)\s*/i.test(seg)) { issue = cleanRange(seg.replace(/^(?:no\.?|issue)\s*/i, '')); continue; }
    if (/^(?:pp?\.?|pages?)\s*/i.test(seg)) { pages = cleanRange(seg.replace(/^(?:pp?\.?|pages?)\s*/i, '')); continue; }
    if (/^(?:doi|https?:|available|retrieved)\b/i.test(seg)) continue;
    // APA："75(3)" 是卷(期)，"456-478" 是页码
    const vi = /^(\d{1,4})\s*[(（](\d{1,4})[)）]$/.exec(seg);
    if (vi) { if (!volume) volume = vi[1]; if (!issue) issue = vi[2]; continue; }
    const pr = /^(\d{1,5}\s*[-–—]\s*\d{1,5})\b/.exec(seg);
    if (pr) { if (!pages) pages = cleanRange(pr[1]); continue; }
    if (/^(?:1[5-9]|20|21)\d{2}$/.test(seg.replace(/[^0-9]/g, ''))) continue;
    if (pub.length < 2) pub.push(seg.replace(/^(?:in|In)\s+/, ''));
  }
  // 形如 "2020;12(3):45-67" 的挤压写法
  const joined = segs.join(', ');
  const vip = /(\d{1,4})\s*(?:[(（](\d{1,4})[)）])?\s*[:：]\s*([0-9A-Za-z]+(?:\s*[-–—]\s*[0-9A-Za-z]+)?)/.exec(joined);
  if (vip) {
    if (!volume) volume = vip[1];
    if (!issue) issue = vip[2] || '';
    if (!pages) pages = cleanRange(vip[3]);
  }
  if (!pages) {
    const pr = /\bpp?\.?\s*(\d{1,5}\s*[-–—]\s*\d{1,5})\b/i.exec(joined);
    if (pr) pages = cleanRange(pr[1]);
  }
  return { publication: normSpace(pub.join(', ')).slice(0, 160), volume, issue, pages };
}

const GBT_MARK = /\[((?:EB|DB|J|M|C|D|R|S|N|P|G|Z|A)(?:\/OL)?)\]/;
const GBT_TYPE = {
  J: 'journalArticle', M: 'book', C: 'conferencePaper', D: 'thesis', R: 'report',
  S: 'report', N: 'newspaperArticle', P: 'document', G: 'book', Z: 'document',
  A: 'bookSection', 'EB/OL': 'webpage', 'DB/OL': 'webpage',
};

/*
 * GB/T 7714：作者. 题名[J]. 刊名, 年, 卷(期): 页码.
 * 国内期刊的参考文献几乎都是这个形态，[J]/[M]/[C] 这个标记非常可靠，
 * 有它就按它切，不用去猜「哪一段是标题」。
 */
function parseGbt(raw) {
  const m = GBT_MARK.exec(raw);
  if (!m || !CJK.test(raw)) return null;
  const before = raw.slice(0, m.index);
  const after = raw.slice(m.index + m[0].length);
  // 题名 = 标记前面最后一个句点之后的部分
  const cut = Math.max(before.lastIndexOf('. '), before.lastIndexOf('．'), before.lastIndexOf('。'));
  const title = cleanTitle(cut >= 0 ? before.slice(cut + 1) : before.replace(/^[^.]*?\.\s*/, ''));
  const authorsRaw = cut >= 0 ? before.slice(0, cut) : '';
  const tail = after.replace(/^[.．]\s*/, '');
  const year = (/((?:1[5-9]|20|21)\d{2})/.exec(tail) || [])[1] || '';
  const tailInfo = parseTail(tail.replace(/^[.．,，\s]+/, ''));
  let publication = tailInfo.publication;
  // GB/T 的刊名后面直接跟 ", 年, 卷(期): 页"，第一段就是刊名
  const firstSeg = normSpace(tail.split(/[,，]/)[0]).replace(/^[.．\s]+/, '');
  if (firstSeg && firstSeg.length <= 60 && !/^\d/.test(firstSeg)) publication = firstSeg;
  return {
    title,
    creators: parseAuthors(authorsRaw),
    year,
    publication,
    volume: tailInfo.volume,
    issue: tailInfo.issue,
    pages: tailInfo.pages,
    itemType: GBT_TYPE[m[1].toUpperCase()] || 'journalArticle',
    confidence: title ? 'parsed' : 'weak',
  };
}

// 从条目正文里抽「标题 + 作者 + 尾部（刊名/卷期页）」
function guessTitleAndAuthors(raw) {
  const body = raw
    .replace(/^\s*(?:\[\s*\d{1,3}\s*\]|[(（]\s*\d{1,3}\s*[)）]|\d{1,3}\s*[.)、]|[·•▪◦‣*])\s*/, '')
    .trim();

  // ① 引号里的标题最明确："Title," in Proc. …
  const q = /[“"《]([^”"》]{6,300})[”"》]/.exec(body);
  if (q) {
    const title = cleanTitle(q[1]);
    const authors = parseAuthors(body.slice(0, q.index));
    return { title, creators: authors, tail: body.slice(q.index + q[0].length) };
  }

  // ② APA 式：作者 (年份). 题名. 刊名, 卷(期), 页码.
  //    括号年份是这个风格最稳的锚点：题名一定在 "(年)." 之后、第一个句点之前。
  const apa = /[(（]\s*((?:1[5-9]|20|21)\d{2})[a-z]?\s*[)）]\s*[.．]?\s*([^.．]{8,300})[.．]/.exec(body);
  if (apa) {
    return {
      title: cleanTitle(apa[2]),
      creators: parseAuthors(body.slice(0, apa.index)),
      tail: body.slice(apa.index + apa[0].length),
    };
  }

  // ② 句点切片：作者. 题名. 刊名…（Vancouver / 国内期刊常见）
  //    缩写点会把作者段切碎（"C. M. Bishop" → "C" / "M" / "Bishop…"），
  //    所以先按「以缩写结尾且不含逗号」把碎片拼回去，再判断作者段到哪结束。
  const rawSentences = body.split(/\.\s+/).map((x) => normSpace(x)).filter(Boolean);
  const sentences = [];
  for (const s of rawSentences) {
    const prev = sentences.length ? sentences[sentences.length - 1] : '';
    const prevOpen = prev && /(?:^|[\s,])[A-Z]\.?$/.test(prev);
    if (prev && (prevOpen || /^[A-Z]\.?$/.test(s))) sentences[sentences.length - 1] = prev + (prev.endsWith('.') ? ' ' : '. ') + s;
    else sentences.push(s);
  }
  if (sentences.length >= 2) {
    const head = sentences[0];
    // head 至少得像一串人：太短（"A" 这种被缩写点切出来的碎片）不算
    const isAuthorHead = head.length >= 3 && (looksLikeAuthorLine(head)
      || (head.length <= 120 && /,\s*(?:[A-Z]\.|[\u4e00-\u9fff])/.test(head)));
    if (isAuthorHead && sentences[1] && sentences[1].length >= 8) {
      return {
        title: cleanTitle(sentences[1]),
        creators: parseAuthors(head),
        tail: sentences.slice(2).join('. '),
      };
    }
  }

  // ③ 逗号切片：作者, 作者, 题名, 刊名, vol. 5, no. 2, pp. 1-10, 2020.
  const chunks = body.split(/\s*[,，]\s*/).map((x) => normSpace(x)).filter(Boolean);
  let ai = 0;
  while (ai < chunks.length && ai < 8 && isNameChunk(chunks[ai])) ai++;
  const authors = ai ? parseAuthors(chunks.slice(0, ai).join(', ')) : [];
  const rest = chunks.slice(ai);
  // 题名 = 从第一个「不像刊名」的片段开始，到第一个像刊名的片段为止
  let ti = 0;
  while (ti < rest.length && looksLikeVenue(rest[ti])) ti++;
  let tj = ti;
  const titleParts = [];
  let tailFrom = '';
  while (tj < rest.length && !looksLikeVenue(rest[tj])) {
    // 片段里夹了句点（"题名. 出版社"）就只取前半段，后半段还给 tail
    const cut = rest[tj].split(/\.\s+/);
    const head = cut[0];
    if (head) titleParts.push(head);
    if (cut.length > 1) { tailFrom = cut.slice(1).join('. '); tj++; break; }
    tj++;
    if (titleParts.join(', ').length >= 20) break;
  }
  const tail = (rest.slice(tj).join(', ') + (tailFrom ? ', ' + tailFrom : '')).replace(/^,\s*/, '');
  return {
    title: cleanTitle(titleParts.join(', ')),
    creators: authors,
    tail,
  };
}

function guessType(raw, tail) {
  const s = String(raw || '') + ' ' + String(tail || '');
  if (/arxiv/i.test(s)) return 'preprint';
  // "in Proc. of X" / "In: Proceedings…" —— 题名之后紧跟 "in " 的几乎都是会议/文集
  if (/\b(?:in\s+proceedings|proc\.|proceedings of|conference|workshop|symposium)\b/i.test(s)) return 'conferencePaper';
  if (/^\s*,?\s*(?:in|In)\s+[A-Z]/.test(String(tail || ''))) return 'conferencePaper';
  if (/\b(?:ph\.?d\.?\s+(?:thesis|dissertation)|doctoral|master'?s thesis|学位论文)\b/i.test(s)) return 'thesis';
  if (/\b(?:tech\.?\s*rep\.?|technical report|report no)\b/i.test(s)) return 'report';
  if (/\b(?:ed\.|eds\.|edited by|press|publisher|isbn|springer|elsevier|wiley|routledge|o'reilly)\b/i.test(s)) return 'book';
  if (/\bhttps?:\/\//.test(s) && !/\bdoi\b/i.test(s)) return 'webpage';
  return 'journalArticle';
}

/**
 * 一条参考文献 → 结构化字段。
 * @returns {{rawText,doi,arxiv,year,title,creators,publication,volume,issue,pages,itemType,confidence}}
 */
function parseEntry(text) {
  const raw = normSpace(text).slice(0, MAX_ENTRY_CHARS);
  const out = {
    rawText: raw, doi: '', arxiv: '', year: '', title: '', creators: [],
    publication: '', volume: '', issue: '', pages: '', itemType: 'journalArticle',
    confidence: 'weak',
  };
  if (!raw) return out;
  out.doi = doiIn(raw);
  out.arxiv = arxivIn(raw);
  out.year = guessYear(raw);

  let got = null;
  try { got = parseGbt(raw); } catch (_) { got = null; }
  if (!got) {
    try { got = guessTitleAndAuthors(raw); } catch (_) { got = null; }
  }
  if (got) {
    out.title = got.title || '';
    out.creators = Array.isArray(got.creators) ? got.creators : [];
    if (got.publication != null) {
      out.publication = got.publication;
      out.volume = got.volume || '';
      out.issue = got.issue || '';
      out.pages = got.pages || '';
    } else {
      const tail = parseTail(got.tail || '');
      out.publication = tail.publication;
      out.volume = tail.volume;
      out.issue = tail.issue;
      out.pages = tail.pages;
    }
    out.itemType = got.itemType || guessType(raw, got.tail || '');
    out.year = out.year || guessYear(got.tail || '');
    // confidence 只在真拿到了「结构」时才算解析成功：DOI/arXiv > 年份/作者/刊名 > 只有一段文字。
    // 最后一种留在 weak，界面上默认不勾 —— 一条连年份都没有的残句，多半是切分切错了。
    if (out.title && out.title.length >= 3) {
      if (out.doi || out.arxiv) out.confidence = 'id';
      else if (out.year || out.creators.length || out.publication) out.confidence = 'parsed';
      else out.confidence = 'weak';
    }
  }
  // 标题兜底：刮掉开头的编号后整段就是标题（没法再细分时至少留下东西）
  if (!out.title) {
    const fallback = cleanTitle(raw.replace(/^\s*(?:\[\s*\d{1,3}\s*\]|\d{1,3}\s*[.)、])\s*/, ''));
    if (fallback.length >= 3) out.title = fallback.slice(0, 240);
  }
  if (!out.title) out.confidence = 'weak';
  return out;
}

/**
 * 参考文献区的行 → 条目数组。
 * @param {string[]|{text:string}[]} lines 从标题行开始（含）到文末的行
 */
function parseSection(lines, opts) {
  const o = opts || {};
  const raw = (Array.isArray(lines) ? lines : [])
    .map((x) => normSpace(typeof x === 'string' ? x : (x && x.text) || ''))
    .filter(Boolean);
  let heading = false;
  let from = 0;
  // 标题行可能在前几行（中间夹着页眉/页码）
  for (let i = 0; i < Math.min(raw.length, 10); i++) {
    if (isHeading(raw[i])) { heading = true; from = i + 1; break; }
  }
  const body = raw.slice(from).filter((t) => !isHeading(t) && !isPageNumber(t));
  let chunks = splitEntries(body);
  if (chunks.length <= 1 && body.length >= 4) {
    const alt = splitBySentence(body);
    if (alt.length > chunks.length) chunks = alt;
  }
  const cap = Math.max(1, Math.min(MAX_ENTRIES, Number(o.max) || MAX_ENTRIES));
  const entries = chunks.slice(0, cap).map((t, i) => {
    const e = parseEntry(t);
    e.entryNo = i + 1;
    return e;
  });
  return { entries, heading, lines: body.length, truncated: chunks.length > cap };
}

/**
 * 与现有库比对，给每条标状态。
 * @param {Array} entries parseSection 的结果
 * @param {Array} items 库条目
 * @returns {Array} 每条加上 { status:'new'|'dup'|'weak', why, dupWith }
 */
function plan(entries, items) {
  const lib = (Array.isArray(items) ? items : []).filter((x) => x && !x.deletedAt);
  const byDoi = new Map();
  const byTitle = new Map();
  for (const it of lib) {
    const d = normDoi(it.doi);
    if (d && !byDoi.has(d)) byDoi.set(d, it);
    const k = titleKey(it.title, it.year);
    if (k && !byTitle.has(k)) byTitle.set(k, it);
  }
  const seenDoi = new Set();
  const seenTitle = new Set();
  return (Array.isArray(entries) ? entries : []).map((e) => {
    const d = normDoi(e && e.doi);
    const k = titleKey(e && e.title, e && e.year);
    let status = 'new';
    let why = '';
    let dupWith = null;
    if (!e || !e.title || e.title.length < 3) {
      status = 'weak'; why = '没认出标题';
    } else if (d && byDoi.has(d)) {
      status = 'dup'; why = '库里已有同一 DOI'; dupWith = byDoi.get(d);
    } else if (k && byTitle.has(k)) {
      status = 'dup'; why = '库里已有同一标题和年份'; dupWith = byTitle.get(k);
    } else if (d && seenDoi.has(d)) {
      status = 'dup'; why = '这张表里重复';
    } else if (k && seenTitle.has(k)) {
      status = 'dup'; why = '这张表里重复';
    }
    if (d) seenDoi.add(d);
    if (k) seenTitle.add(k);
    return Object.assign({}, e, {
      status,
      why,
      dupWith: dupWith ? { key: dupWith.key, title: dupWith.title || '' } : null,
    });
  });
}

/**
 * 抓回来的题录覆盖本地猜测（Crossref 比启发式可靠）。
 */
function mergeMeta(parsed, meta) {
  if (!meta) return parsed;
  const pick = (a, b) => (a && String(a).trim() ? a : b);
  const creators = (meta.creators && meta.creators.length) ? meta.creators : parsed.creators;
  return Object.assign({}, parsed, {
    title: pick(meta.title, parsed.title),
    creators,
    year: pick(meta.year, parsed.year),
    publication: pick(meta.publication, parsed.publication),
    volume: pick(meta.volume, parsed.volume),
    issue: pick(meta.issue, parsed.issue),
    pages: pick(meta.pages, parsed.pages),
    doi: pick(meta.doi, parsed.doi),
    url: pick(meta.url, parsed.url || ''),
    abstract: pick(meta.abstract, parsed.abstract || ''),
    language: pick(meta.language, parsed.language || ''),
    tags: Array.isArray(meta.tags) ? meta.tags : (parsed.tags || []),
    itemType: pick(meta.itemType, parsed.itemType),
    confidence: 'meta',
  });
}

/**
 * 解析结果 → library.importItems 的记录。
 * 认不出标题的条目没有原文可看，所以把原始文本塞进 note——将来想核对「这条是从哪来的」时有据可查。
 */
function toRecord(parsed) {
  const e = parsed || {};
  const rec = {
    itemType: e.itemType || 'journalArticle',
    title: e.title || '',
    creators: Array.isArray(e.creators) ? e.creators : [],
    year: e.year || '',
    publication: e.publication || '',
    volume: e.volume || '',
    issue: e.issue || '',
    pages: e.pages || '',
    doi: e.doi || '',
    url: e.url || '',
  };
  if (e.abstract) rec.abstract = e.abstract;
  if (e.language) rec.language = e.language;
  if (Array.isArray(e.tags) && e.tags.length) rec.tags = e.tags.slice(0, 12);
  if (e.confidence !== 'meta' && e.rawText) {
    // 没抓到官方题录：把原文留在笔记里，标题是猜的，用户能一眼看出出处
    rec.note = '引自参考文献：' + String(e.rawText).slice(0, 800);
  }
  return rec;
}

module.exports = {
  parseSection, splitEntries, splitBySentence, parseEntry, plan, mergeMeta, toRecord,
  isHeading, isPageNumber, doiIn, arxivIn, guessYear, parseAuthors, foldTitle, titleKey,
  normDoi, entryStart,
  MAX_ENTRIES,
};
