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
  const STYLE_IDS = new Set((Cite.STYLES || []).map((s) => s.id));
  const str = (v) => String(v == null ? '' : v).trim();

  function normalizeStyle(style) {
    const s = str(style);
    return STYLE_IDS.has(s) ? s : 'gbt7714';
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
    return NUMERIC_STYLES.has(normalizeStyle(style));
  }

  function defaultOrder(style) {
    return isNumeric(style) ? 'entry' : 'author';
  }

  // 「Smith, John」取 Smith；「John Smith」取 Smith；中文名原样返回。
  function lastName(name) {
    const s = str(name);
    if (!s) return '';
    if (s.includes(',')) return s.split(',')[0].trim();
    const parts = s.split(/\s+/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
  }

  function creatorKey(it) {
    const list = Cite.authorsOf(it);
    if (!list.length) return '';
    return list.map(lastName).join(' ');
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

  function sortItems(items, style, order) {
    const list = (Array.isArray(items) ? items : []).slice();
    const mode = (order === 'entry' || order === 'author') ? order : defaultOrder(style);
    if (mode === 'entry') return list;
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
   *   markdown    是否输出 Markdown（标题用 ##，条目间空行）
   *   includeKeys 每条附 `[@citekey]`（Markdown 用反引号包住）
   *   title       标题；空串 = 不加标题
   *   citekeys    Map<item.key, citekey>；不给则按本次条目现算（可能和整库不一致）
   * 返回 { text, entries, count, skipped, style, styleLabel, order, numeric }
   */
  function build(items, opts) {
    const o = opts || {};
    const style = normalizeStyle(o.style);
    const numeric = isNumeric(style);
    const order = (o.order === 'entry' || o.order === 'author') ? o.order : defaultOrder(style);
    const markdown = !!o.markdown;

    let skipped = 0;
    let list = uniqueByKey(Array.isArray(items) ? items : []).filter((it) => {
      if (!str(it.title) || (Number(it.deletedAt) || 0) > 0) { skipped++; return false; }
      return true;
    });
    list = sortItems(list, style, order);
    if (!numeric) list = withYearSuffixes(list, style);

    const keys = (o.citekeys instanceof Map) ? o.citekeys : Cite.citekeys(list);
    const entries = list.map((it, i) => {
      const n = i + 1;
      let body = Cite.format(it, style, n);
      if (numeric && style !== 'ieee') body = '[' + n + '] ' + body;
      if (o.includeKeys) {
        const key = keys.get(it.key) || Cite.citekey(it);
        if (key) body += markdown ? ' `[@' + key + ']`' : '  [@' + key + ']';
      }
      return body;
    });

    const title = str(o.title);
    let text = '';
    if (entries.length) {
      if (title) text += (markdown ? (/^#{1,6}\s/.test(title) ? title : '## ' + title) : title) + '\n\n';
      text += entries.join(markdown ? '\n\n' : '\n') + '\n';
    }

    return {
      text, entries, count: entries.length, skipped,
      style, styleLabel: Cite.styleLabel(style), order, numeric,
    };
  }

  return {
    build, sortItems, isNumeric, defaultOrder,
    STYLES: Cite.STYLES,
  };
});
