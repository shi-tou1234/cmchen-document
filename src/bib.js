'use strict';
/*
 * 参考文献表：把一批条目排成能直接粘进论文 / Markdown 的列表。
 *
 * 与 cite.js 的分工：
 *   cite.js —— 单条格式化（5 种样式、citekey）；
 *   bib.js  —— 排序、编号、同年后缀、Markdown / 纯文本包装。
 *
 * 排序规则（只做“够用”的确定版，不冒充 CSL）：
 *   - GB/T 7714 / IEEE 是编号制，默认保持传入顺序（通常是列表当前顺序）；
 *   - APA / Chicago / MLA 默认按第一作者姓氏排，同作者再按年份、标题；
 *   - 无作者条目用标题参与排序（APA 的通行做法）；
 *   - APA / Chicago / MLA 同一作者同一年出现多条时，年份自动补 a / b / c。
 *
 * 纯函数，主进程与渲染进程都能用（UMD 风格）：
 *   Node：   require('./bib.js')
 *   浏览器： <script src="../bib.js"></script> → window.Bib
 */
(function (root, factory) {
  const Cite = (root && root.Cite) || (typeof require === 'function' ? require('./cite.js') : null);
  const api = factory(Cite);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Bib = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Cite) {
  if (!Cite) throw new Error('bib.js 依赖 cite.js');

  const NUMERIC_STYLES = new Set(['gbt7714', 'ieee']);
  const str = (v) => String(v == null ? '' : v).trim();

  const escHtml = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // 参考文献表的 HTML：编号制用 <ol>，作者-年份制用 <ul>。
  // 存在的意义是省掉「粘进 Word 再排版」这一步 —— 存成 .doc 时 Word 直接按 HTML 解析，
  // 编号、缩进、引用键都能保留。
  function toHtml(title, rows, numeric) {
    // 空表不输出空壳：和 markdown / text 一致地返回空串，让主进程按「没有可保存的内容」拦掉，
    // 免得导出一个只有 <ol></ol> 的空文件。
    if (!rows.length) return '';
    let out = '';
    if (title) out += '<h2>' + escHtml(title) + '</h2>\n';
    const tag = numeric ? 'ol' : 'ul';
    out += '<' + tag + ' class="references">\n';
    for (const r of rows) {
      let body = escHtml(r.body);
      if (r.key) body += ' <code>[@' + escHtml(r.key) + ']</code>';
      out += '  <li>' + body + '</li>\n';
    }
    return out + '</' + tag + '>\n';
  }

  // Word 打开 .doc 时按 HTML 解析，给它一个最小但够用的外壳（字体、行距、缩进）。
  // 不塞复杂样式：不同 Word 版本对 CSS 的支持差别大，越简单越稳。
  function wrapHtmlDoc(inner, title) {
    return '<!DOCTYPE html>\n<html><head><meta charset="utf-8">\n' +
      '<title>' + escHtml(title || '参考文献') + '</title>\n' +
      '<style>' +
      'body{font-family:"Times New Roman","SimSun",serif;font-size:12pt;line-height:1.5;margin:2em}' +
      'h2{font-size:14pt}' +
      'ol.references,ul.references{padding-left:2em}' +
      'li{margin:0 0 6pt}' +
      'code{font-family:Consolas,monospace;font-size:10pt;color:#555}' +
      '</style>\n</head><body>\n' + inner + '</body></html>\n';
  }

  // ---------------- RTF ----------------
  // Zotero 的「粘进 Word」主力格式就是 RTF。相比 HTML，Word / LibreOffice / WPS 对 RTF
  // 的解释更一致，粘过去不会被目标软件的清洗规则改掉行距和缩进。
  // RTF 是 7-bit 安全格式：非 ASCII 一律写成 \uN?（N = UTF-16 码元的有符号十进制），
  // 反斜杠 / 大括号必须转义，否则会把文档结构弄坏。
  function rtfEscape(v) {
    const s = String(v == null ? '' : v);
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      const code = s.charCodeAt(i);
      if (ch === '\\') out += '\\\\';
      else if (ch === '{') out += '\\{';
      else if (ch === '}') out += '\\}';
      else if (ch === '\n') out += '\\par\n';
      else if (ch === '\r') continue;
      else if (ch === '\t') out += '\\tab ';
      else if (code < 32) continue;
      else if (code < 128) out += ch;
      // 代理对会拆成两个 \u（RTF 没有 32 位码点），Word 能按 UTF-16 拼回去
      else out += '\\u' + (code > 32767 ? code - 65536 : code) + '?';
    }
    return out;
  }

  function toRtf(title, rows) {
    if (!rows.length) return '';
    let out = '{\\rtf1\\ansi\\ansicpg936\\deff0\\uc1\n' +
      '{\\fonttbl{\\f0\\fnil\\fcharset134 SimSun;}}\n' +
      '\\viewkind4\\pard\\sa200\\sl276\\slmult1\\f0\\fs24\n';
    if (title) out += '\\pard\\b\\fs28 ' + rtfEscape(title) + '\\b0\\fs24\\par\\par\n';
    for (const r of rows) {
      let line = r.body;
      if (r.key) line += '  [@' + r.key + ']';
      // 形如「[3] 正文」的编号制条目拆出编号，用悬挂缩进排：首行顶格，折行缩进 0.25 英寸
      const m = /^\[(\d+)\]\s+/.exec(line);
      out += m
        ? '\\pard\\fi-360\\li360\\sa120 [' + m[1] + ']\\tab ' + rtfEscape(line.slice(m[0].length)) + '\\par\n'
        : '\\pard\\sa120 ' + rtfEscape(line) + '\\par\n';
    }
    return out + '}\n';
  }

  // 样式列表里有 CSL 用户样式（渲染进程启动后才注册），所以不能在建模块时拍死一份 id 集合。
  function isKnownStyle(id) {
    const s = str(id);
    if (!s) return false;
    if (typeof Cite.isCslStyle === 'function' && Cite.isCslStyle(s)) return true;
    if ((Cite.STYLES || []).some((x) => x.id === s)) return true;
    const list = typeof Cite.styleList === 'function' ? Cite.styleList() : [];
    return list.some((x) => x.id === s);
  }

  function normalizeStyle(style) {
    const s = str(style);
    return isKnownStyle(s) ? s : 'gbt7714';
  }

  let collator = null;
  try {
    collator = new Intl.Collator('zh-Hans-CN', { sensitivity: 'base', numeric: true });
  } catch (_) { collator = null; }

  // zh 排序器会把汉字排在拉丁字母前（ICU 的默认行为），混排文献表看起来会很怪。
  // 先按“拉丁 → 汉字 → 其它”分组，组内再按本地化排序；汉字之间仍是拼音序。
  function scriptRank(s) {
    const t = str(s);
    if (!t) return 3;
    if (/^[A-Za-z]/.test(t)) return 0;
    if (/[\u3400-\u9fff]/.test(t)) return 1;
    return 2;
  }

  function cmpText(a, b) {
    const x = str(a), y = str(b);
    const rx = scriptRank(x), ry = scriptRank(y);
    if (rx !== ry) return rx - ry;
    if (collator) return collator.compare(x, y);
    return x.localeCompare(y);
  }

  function isNumeric(style) {
    const s = normalizeStyle(style);
    if (typeof Cite.isNumericStyle === 'function') return Cite.isNumericStyle(s);
    return NUMERIC_STYLES.has(s);
  }

  function defaultOrder(style) {
    return isNumeric(style) ? 'entry' : 'author';
  }

  // v6：作者已结构化，直接取姓（v5 的字符串作者由 creators.js 拆好再进来）
  function creatorKey(it) {
    const list = Cite.authorsOf(it);
    if (!list.length) return '';
    return list.map((c) => (c.lastName || c.firstName || '')).join(' ');
  }

  // 无作者时用标题排序，避免整批无作者条目全挤在一起。
  function authorSortKey(it) {
    return creatorKey(it) || str(it.title);
  }

  function yearNumber(it) {
    const hit = String(it && it.year != null ? it.year : '').match(/\d{4}/);
    return hit ? Number(hit[0]) : 0;
  }

  function uniqueByKey(items) {
    const seen = new Set();
    const out = [];
    for (const it of items) {
      if (!it || typeof it !== 'object') continue;
      const key = str(it.key);
      if (key) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      out.push(it);
    }
    return out;
  }

  function sortItems(items, style, order, auto) {
    const list = (Array.isArray(items) ? items : []).slice();
    const mode = (order === 'entry' || order === 'author') ? order : defaultOrder(style);
    if (mode === 'entry') return list;
    // CSL 样式自带 <sort> 时优先按它排；用户显式选了「当前条目顺序」时上面已经返回，
    // 显式选「作者字母序」也尊重用户，不再让样式的 sort 覆盖。
    if (auto && typeof Cite.cslSort === 'function') {
      const cslSorted = Cite.cslSort(style, list);
      if (cslSorted) return cslSorted;
    }
    list.sort((a, b) => {
      const byAuthor = cmpText(authorSortKey(a), authorSortKey(b));
      if (byAuthor) return byAuthor;
      const ya = yearNumber(a), yb = yearNumber(b);
      if (ya !== yb) return ya - yb;
      const byTitle = cmpText(a.title, b.title);
      if (byTitle) return byTitle;
      return cmpText(a.key, b.key);
    });
    return list;
  }

  function suffixAt(index) {
    let i = index + 1, out = '';
    while (i > 0) {
      i -= 1;
      out = String.fromCharCode(97 + (i % 26)) + out;
      i = Math.floor(i / 26);
    }
    return out;
  }

  // 同一组作者 + 同一年 → 2020a / 2020b。只对作者-年份制生效。
  function withYearSuffixes(items, style) {
    if (isNumeric(style) || !items.length) return items;
    const groups = new Map();
    for (const it of items) {
      const year = str(it.year);
      if (!/^\d{4}/.test(year)) continue;
      if (/^\d{4}[a-z]$/i.test(year)) continue;   // 已经带过后缀，不再叠一层
      const groupKey = creatorKey(it) + '|' + year.slice(0, 4);
      if (!groups.has(groupKey)) groups.set(groupKey, []);
      groups.get(groupKey).push(it);
    }
    const clones = new Map();
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      list.forEach((it, i) => {
        const year = str(it.year);
        clones.set(it, Object.assign({}, it, {
          year: year.replace(/^(\d{4})/, '$1' + suffixAt(i)),
        }));
      });
    }
    return items.map((it) => clones.get(it) || it);
  }

  /*
   * 生成参考文献表。
   * opts:
   *   style       'gbt7714' | 'apa' | 'chicago' | 'ieee' | 'mla'
   *   order       'entry' | 'author'；省略时按样式取默认值
   *   markdown    是否输出 Markdown（标题用 ##，条目间空行）；与 format 二选一，
   *                format 优先（老调用方传 markdown 仍然有效）
   *   format      'text' | 'markdown' | 'html' | 'word' | 'rtf'
   *               html —— 片段（<h2> + <ol>/<ul>），用来塞进别的页面
   *               word —— 同上但带 HTML 外壳，存成 .doc 给 Word 直接打开
   *               rtf  —— RTF 源码，Word / LibreOffice / WPS 都能直接打开或粘贴
   *   includeKeys 每条附 `[@citekey]`（Markdown 用反引号，HTML 用 <code>）
   *   title       标题；空串 = 不加标题
   *   citekeys    Map<item.key, citekey>；不给则按本次条目现算（可能和整库不一致）
   * 返回 { text, html, rtf, entries, count, skipped, style, styleLabel, order, numeric, format }
   */
  function build(items, opts) {
    const o = opts || {};
    const style = normalizeStyle(o.style);
    const numeric = isNumeric(style);
    const order = (o.order === 'entry' || o.order === 'author') ? o.order : defaultOrder(style);
    const autoOrder = o.order !== 'entry' && o.order !== 'author';
    const format = ['text', 'markdown', 'html', 'word', 'rtf'].indexOf(o.format) >= 0
      ? o.format : (o.markdown ? 'markdown' : 'text');
    const markdown = format === 'markdown';

    let skipped = 0;
    let list = uniqueByKey(Array.isArray(items) ? items : []).filter((it) => {
      if (!str(it.title) || (Number(it.deletedAt) || 0) > 0) { skipped++; return false; }
      return true;
    });
    list = sortItems(list, style, order, autoOrder);
    if (!numeric) list = withYearSuffixes(list, style);

    const keys = (o.citekeys instanceof Map) ? o.citekeys : Cite.citekeys(list);
    // 先算「正文 + 引用键」两件套，再按目标格式包装：
    // 四种格式只是外衣不同，正文与排序逻辑共用一份，不会出现改了 HTML 忘了改 Markdown 的情况。
    const rows = list.map((it, i) => {
      const n = i + 1;
      let body = Cite.format(it, style, n);
      // CSL 样式自己决定编号怎么写（citation-number），别再套一层 [n]
      if (numeric && style !== 'ieee' && !(typeof Cite.isCslStyle === 'function' && Cite.isCslStyle(style))) {
        body = '[' + n + '] ' + body;
      }
      return { body, key: o.includeKeys ? (keys.get(it.key) || Cite.citekey(it)) : '' };
    });

    const title = str(o.title);
    const htmlBody = toHtml(title, rows, numeric);
    // 没条目时连外壳也不给（否则 Word 会打开一个空文档）
    const html = (!rows.length) ? '' : (format === 'word' ? wrapHtmlDoc(htmlBody, title || '参考文献') : htmlBody);
    const rtf = toRtf(title, rows);

    // entries 始终是纯文本版（UI 用它显示条数、做复制兜底）；HTML / RTF 走各自字段
    const entries = rows.map((r) => {
      if (!r.key) return r.body;
      return r.body + (markdown ? ' `[@' + r.key + ']`' : '  [@' + r.key + ']');
    });

    let text;
    if (format === 'html' || format === 'word') {
      text = html;                       // 一份就够，别让 text 和 html 两处各转义一次
    } else if (format === 'rtf') {
      text = rtf;
    } else {
      text = '';
      if (entries.length) {
        if (title) {
          text += (markdown ? (/^#{1,6}\s/.test(title) ? title : '## ' + title) : title) + '\n\n';
        }
        text += entries.join(markdown ? '\n\n' : '\n') + '\n';
      }
    }

    return {
      text, html, rtf, entries, count: entries.length, skipped,
      style, styleLabel: Cite.styleLabel(style), order, numeric, format,
    };
  }

  return {
    build, sortItems, isNumeric, defaultOrder, toHtml, wrapHtmlDoc, toRtf, rtfEscape,
    STYLES: Cite.STYLES,
  };
});
