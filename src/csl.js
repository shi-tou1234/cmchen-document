'use strict';
/*
 * CSL（Citation Style Language）子集引擎。
 *
 * 为什么是「子集」：
 *   - 项目坚持零原生依赖、离线可用，不能引 citeproc-js（它需要联网安装，且样式库是另一套 XML）。
 *   - 这里实现 CSL 1.0.2 里参考文献表真正用得到的那部分：macro / group / choose /
 *     names / date / number / label / sort / locale terms / 页码范围 / et-al。
 *   - 不实现：引文定位符、同上/前引、消歧、缩写期刊表、富文本排版（HTML 之外）、
 *     `cs:intext` 之外的笔记体引文、按语言自动切换整份 locale 文件。
 *
 * 支持导入真实的 .csl 样式（Zotero 样式库里的文件），遇到不认识的元素会记进
 * style.warnings，界面可以提示「这个样式用到了未支持的写法」。
 *
 * 这个文件主进程与渲染进程都能用（UMD 风格）：
 *   Node：   require('./csl.js')
 *   浏览器： <script src="../csl.js"></script> → window.Csl
 */
(function (root, factory) {
  const Creators = (root && root.Creators) || (typeof require === 'function' ? require('./creators.js') : null);
  const api = factory(Creators);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Csl = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Creators) {
  const str = (v) => String(v == null ? '' : v).trim();
  const CJK = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/;

  // ---------------------------------------------------------------------------
  // 1. 一个够用的 XML 解析器
  // ---------------------------------------------------------------------------
  // 只做 CSL 需要的事：元素、属性、文本、注释、CDATA、实体。没有命名空间校验，
  // 属性名（含 xml:lang）原样保留。坏 XML 直接抛错，让导入方给出明确提示。
  const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

  function decodeEntities(text) {
    return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
      if (body[0] === '#') {
        const hex = body[1] === 'x' || body[1] === 'X';
        const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
        try { return Number.isFinite(code) ? String.fromCodePoint(code) : m; } catch (_) { return m; }
      }
      return Object.prototype.hasOwnProperty.call(XML_ENTITIES, body) ? XML_ENTITIES[body] : m;
    });
  }

  function findTagEnd(src, from) {
    let quote = '';
    for (let i = from; i < src.length; i++) {
      const c = src[i];
      if (quote) { if (c === quote) quote = ''; continue; }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === '>') return i;
    }
    return -1;
  }

  function parseTagBody(inner) {
    let i = 0;
    while (i < inner.length && !/\s/.test(inner[i])) i++;
    const name = inner.slice(0, i);
    const attrs = {};
    while (i < inner.length) {
      while (i < inner.length && /\s/.test(inner[i])) i++;
      if (i >= inner.length) break;
      let j = i;
      while (j < inner.length && !/[\s=]/.test(inner[j])) j++;
      const key = inner.slice(i, j);
      while (j < inner.length && /\s/.test(inner[j])) j++;
      if (inner[j] !== '=') { attrs[key] = ''; i = j; continue; }
      j++;
      while (j < inner.length && /\s/.test(inner[j])) j++;
      const quote = inner[j];
      let value = '';
      if (quote === '"' || quote === "'") {
        const end = inner.indexOf(quote, j + 1);
        value = inner.slice(j + 1, end < 0 ? inner.length : end);
        j = end < 0 ? inner.length : end + 1;
      } else {
        let k = j;
        while (k < inner.length && !/\s/.test(inner[k])) k++;
        value = inner.slice(j, k);
        j = k;
      }
      attrs[key] = decodeEntities(value);
      i = j;
    }
    return { name, attrs };
  }

  function parseXml(xml) {
    const src = String(xml == null ? '' : xml).replace(/^\uFEFF/, '');
    const stack = [];
    let root = null;
    let i = 0;
    const pushText = (text) => {
      if (!text || !stack.length) return;
      stack[stack.length - 1].children.push(decodeEntities(text));
    };

    while (i < src.length) {
      const lt = src.indexOf('<', i);
      if (lt < 0) { pushText(src.slice(i)); break; }
      if (lt > i) pushText(src.slice(i, lt));

      if (src.startsWith('<!--', lt)) {
        const end = src.indexOf('-->', lt + 4);
        i = end < 0 ? src.length : end + 3;
        continue;
      }
      if (src.startsWith('<![CDATA[', lt)) {
        const end = src.indexOf(']]>', lt + 9);
        if (stack.length) stack[stack.length - 1].children.push(src.slice(lt + 9, end < 0 ? src.length : end));
        i = end < 0 ? src.length : end + 3;
        continue;
      }
      if (src.startsWith('<?', lt) || src.startsWith('<!', lt)) {
        const end = src.indexOf('>', lt + 2);
        i = end < 0 ? src.length : end + 1;
        continue;
      }

      const gt = findTagEnd(src, lt + 1);
      if (gt < 0) throw new Error('XML 标签未闭合');
      let inner = src.slice(lt + 1, gt);
      const selfClose = /\/\s*$/.test(inner);
      if (selfClose) inner = inner.replace(/\/\s*$/, '');
      if (!inner) { i = gt + 1; continue; }

      if (inner[0] === '/') {
        const name = inner.slice(1).trim();
        const top = stack.pop();
        if (!top || top.name !== name) throw new Error('XML 标签不匹配：</' + name + '>');
        i = gt + 1;
        continue;
      }

      const tag = parseTagBody(inner);
      const node = { name: tag.name, attrs: tag.attrs, children: [] };
      if (stack.length) stack[stack.length - 1].children.push(node);
      else if (!root) root = node;
      else throw new Error('XML 存在多个根节点');
      if (!selfClose) stack.push(node);
      i = gt + 1;
    }

    if (!root) throw new Error('XML 为空');
    if (stack.length) throw new Error('XML 标签未闭合：<' + stack[stack.length - 1].name + '>');
    return root;
  }

  const nodes = (node) => (node && Array.isArray(node.children) ? node.children.filter((c) => c && typeof c === 'object') : []);
  const childNodes = (node, name) => nodes(node).filter((c) => !name || c.name === name);
  const firstChild = (node, name) => childNodes(node, name)[0] || null;
  const textOf = (node) => (node ? node.children.filter((c) => typeof c === 'string').join('').trim() : '');

  // ---------------------------------------------------------------------------
  // 2. 内置 locale 词条
  // ---------------------------------------------------------------------------
  // 真实 CSL 的 locale 文件有上千条；这里只收参考文献表常用的。缺词条时返回空串，
  // 不会把样式整体打崩。数组是 [单数, 复数]。
  const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  const MONTHS_EN_SHORT = ['Jan.', 'Feb.', 'Mar.', 'Apr.', 'May', 'Jun.',
    'Jul.', 'Aug.', 'Sep.', 'Oct.', 'Nov.', 'Dec.'];

  const EN_LONG = {
    and: 'and', 'et-al': 'et al.', ibid: 'ibid.', 'no date': 'n.d.',
    anonymous: 'anonymous', accessed: 'accessed', retrieved: 'retrieved',
    from: 'from', 'available at': 'available at', in: 'in', present: 'present',
    forthcoming: 'forthcoming', internet: 'internet', cited: 'cited', circa: 'circa',
    'open-quote': '\u201c', 'close-quote': '\u201d',
    'open-inner-quote': '\u2018', 'close-inner-quote': '\u2019',
    'page-range-delimiter': '\u2013', comma: ',', colon: ':', semicolon: ';',
    page: ['page', 'pages'], volume: ['volume', 'volumes'], issue: ['issue', 'issues'],
    edition: ['edition', 'editions'], editor: ['editor', 'editors'],
    translator: ['translator', 'translators'], author: ['author', 'authors'],
    'collection-editor': ['editor', 'editors'], chapter: ['chapter', 'chapters'],
    section: ['section', 'sections'], paragraph: ['paragraph', 'paragraphs'],
    verse: ['verse', 'verses'], line: ['line', 'lines'], figure: ['figure', 'figures'],
    table: ['table', 'tables'], appendix: ['appendix', 'appendices'],
    part: ['part', 'parts'], number: ['number', 'numbers'],
    'collection-number': ['number', 'numbers'], note: ['note', 'notes'],
    genre: ['genre', 'genres'], medium: ['medium', 'media'],
    ordinal: 'th', 'ordinal-01': 'st', 'ordinal-02': 'nd', 'ordinal-03': 'rd', 'ordinal-04': 'th',
    'long-ordinal-01': 'first', 'long-ordinal-02': 'second', 'long-ordinal-03': 'third',
    'long-ordinal-04': 'fourth', 'long-ordinal-05': 'fifth', 'long-ordinal-06': 'sixth',
    'long-ordinal-07': 'seventh', 'long-ordinal-08': 'eighth', 'long-ordinal-09': 'ninth',
    'long-ordinal-10': 'tenth',
  };
  const EN_SHORT = {
    page: ['p.', 'pp.'], volume: ['vol.', 'vols.'], issue: ['no.', 'nos.'],
    edition: ['ed.', 'eds.'], editor: ['ed.', 'eds.'], translator: ['trans.', 'trans.'],
    author: ['author', 'authors'], chapter: ['chap.', 'chaps.'], section: ['sec.', 'secs.'],
    paragraph: ['para.', 'paras.'], verse: ['v.', 'vv.'], line: ['l.', 'll.'],
    figure: ['fig.', 'figs.'], table: ['tbl.', 'tbls.'], appendix: ['app.', 'apps.'],
    part: ['pt.', 'pts.'], number: ['no.', 'nos.'], 'collection-number': ['no.', 'nos.'],
    note: ['n.', 'nn.'], circa: 'c.', 'no date': 'n.d.',
  };
  const EN_VERB = { editor: 'edited by', translator: 'translated by' };
  const EN_VERB_SHORT = { editor: 'ed.', translator: 'trans.' };
  const EN_SYMBOL = { and: '&' };

  for (let m = 1; m <= 12; m++) {
    const key = 'month-' + String(m).padStart(2, '0');
    EN_LONG[key] = MONTHS_EN[m - 1];
    EN_SHORT[key] = MONTHS_EN_SHORT[m - 1];
  }
  for (let s = 1; s <= 4; s++) {
    EN_LONG['season-' + String(s).padStart(2, '0')] = ['Spring', 'Summer', 'Autumn', 'Winter'][s - 1];
  }

  const ZH_LONG = {
    and: '和', 'et-al': '等', ibid: '同上', 'no date': '无日期', anonymous: '佚名',
    accessed: '访问于', retrieved: '检索自', from: '来自', 'available at': '可从',
    in: '载于', present: '现藏于', forthcoming: '即将出版', internet: '互联网', cited: '引用',
    circa: '约', 'open-quote': '\u201c', 'close-quote': '\u201d',
    'open-inner-quote': '\u2018', 'close-inner-quote': '\u2019',
    'page-range-delimiter': '\u2013', comma: '，', colon: '：', semicolon: '；',
    page: ['页', '页'], volume: ['卷', '卷'], issue: ['期', '期'], edition: ['版', '版'],
    editor: ['编者', '编者'], translator: ['译者', '译者'], author: ['作者', '作者'],
    chapter: ['章', '章'], section: ['节', '节'], paragraph: ['段', '段'],
    number: ['期', '期'], note: ['注', '注'],
    ordinal: '', 'ordinal-01': '', 'ordinal-02': '', 'ordinal-03': '', 'ordinal-04': '',
  };
  const ZH_SHORT = {
    page: ['页', '页'], volume: ['卷', '卷'], issue: ['期', '期'], edition: ['版', '版'],
    editor: ['编', '编'], translator: ['译', '译'], author: ['作者', '作者'],
    chapter: ['章', '章'], number: ['期', '期'], note: ['注', '注'],
    'no date': '无日期',
  };
  for (let m = 1; m <= 12; m++) {
    ZH_LONG['month-' + String(m).padStart(2, '0')] = m + '月';
    ZH_SHORT['month-' + String(m).padStart(2, '0')] = m + '月';
  }

  const LOCALES = {
    en: { long: EN_LONG, short: EN_SHORT, verb: EN_VERB, 'verb-short': EN_VERB_SHORT, symbol: EN_SYMBOL },
    'en-gb': {
      long: Object.assign({}, EN_LONG, {
        'open-quote': '\u2018', 'close-quote': '\u2019',
        'open-inner-quote': '\u201c', 'close-inner-quote': '\u201d',
      }),
      short: EN_SHORT, verb: EN_VERB, 'verb-short': EN_VERB_SHORT, symbol: EN_SYMBOL,
    },
    zh: { long: ZH_LONG, short: ZH_SHORT, verb: {}, 'verb-short': {}, symbol: { and: '和' } },
  };

  function localeTable(locale) {
    const tag = String(locale || 'en').toLowerCase();
    if (tag.startsWith('zh')) return LOCALES.zh;
    if (tag.startsWith('en-gb')) return LOCALES['en-gb'];
    return LOCALES.en;
  }

  // ---------------------------------------------------------------------------
  // 3. 样式解析
  // ---------------------------------------------------------------------------
  const SUPPORTED_TAGS = new Set([
    'style', 'info', 'title', 'id', 'link', 'updated', 'rights', 'author', 'contributor',
    'category', 'issn', 'eissn', 'issnl', 'summary', 'published', 'macro', 'citation',
    'bibliography', 'layout', 'sort', 'key', 'locale', 'terms', 'term', 'single', 'multiple',
    'text', 'group', 'choose', 'if', 'else-if', 'else', 'names', 'name', 'name-part',
    'substitute', 'date', 'date-part', 'number', 'label', 'style-options',
  ]);

  function slugId(value) {
    let s = str(value);
    if (!s) return '';
    s = s.replace(/^.*\//, '').replace(/\.csl$/i, '');
    s = s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
    return s.slice(0, 64);
  }

  function hashText(text) {
    let h = 5381;
    for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }

  function localeScore(lang, want) {
    if (!lang) return 1;                     // 不带 xml:lang 的 locale 对所有人都生效
    const a = String(lang).toLowerCase();
    const b = String(want || '').toLowerCase();
    if (a === b) return 3;
    if (b.startsWith(a + '-')) return 2;
    if (a.startsWith(b + '-')) return 2;
    return 0;
  }

  function parseTermElement(el) {
    const name = str(el.attrs.name);
    if (!name) return null;
    const form = str(el.attrs.form) || 'long';
    const single = firstChild(el, 'single');
    const multiple = firstChild(el, 'multiple');
    if (single || multiple) {
      return { name, form, value: { single: textOf(single), multiple: textOf(multiple) } };
    }
    return { name, form, value: { text: textOf(el) } };
  }

  function parseStyle(xml, meta) {
    const root = parseXml(xml);
    if (root.name !== 'style') throw new Error('不是 CSL 样式（根元素应为 <style>）');
    const info = firstChild(root, 'info');
    const title = textOf(firstChild(info, 'title')) || str(meta && meta.label);
    const infoId = textOf(firstChild(info, 'id'));
    const id = slugId((meta && meta.id) || infoId || title) || ('style-' + hashText(String(xml).slice(0, 2000)));
    const locale = str(root.attrs['default-locale']) || 'en-US';

    const style = {
      id, title: title || id, label: title || id,
      class: str(root.attrs.class) || 'in-text',
      defaultLocale: locale,
      pageRangeFormat: str(root.attrs['page-range-format']),
      rootAttrs: root.attrs || {},
      macros: {},
      citation: firstChild(root, 'citation'),
      bibliography: firstChild(root, 'bibliography'),
      terms: new Map(),
      warnings: [],
      numeric: false,
      source: str(meta && meta.source) || 'builtin',
    };

    for (const macro of childNodes(root, 'macro')) {
      const name = str(macro.attrs.name);
      if (name) style.macros[name] = macro;
    }

    // 未知元素只记一次，导入后能在界面上提示
    const seenWarn = new Set();
    (function scan(node) {
      for (const c of nodes(node)) {
        if (!SUPPORTED_TAGS.has(c.name) && !seenWarn.has(c.name)) {
          seenWarn.add(c.name);
          style.warnings.push(c.name);
        }
        scan(c);
      }
    })(root);

    // 样式内 locale：精确语言 > 语言前缀 > 无语言
    const styleLocales = [];
    for (const loc of childNodes(root, 'locale')) {
      const lang = str(loc.attrs['xml:lang'] || loc.attrs.lang);
      const score = localeScore(lang, locale);
      if (score > 0) styleLocales.push({ score, loc });
    }
    styleLocales.sort((a, b) => a.score - b.score);
    for (const row of styleLocales) {
      const terms = firstChild(row.loc, 'terms');
      if (!terms) continue;
      for (const termEl of childNodes(terms, 'term')) {
        const parsed = parseTermElement(termEl);
        if (!parsed) continue;
        let bucket = style.terms.get(parsed.name);
        if (!bucket) { bucket = {}; style.terms.set(parsed.name, bucket); }
        bucket[parsed.form] = parsed.value;
      }
    }

    if (style.bibliography) {
      const layout = firstChild(style.bibliography, 'layout');
      style.numeric = usesVariable(layout, 'citation-number', style, 0);
      if (!layout) style.warnings.push('bibliography 缺少 layout');
    }
    if (!style.bibliography) style.warnings.push('没有 bibliography（只能用于文内引注）');

    return style;
  }

  // 样式树里是否引用了某个变量（用于判断编号制 + 是否算「真 CSL 样式」）
  function usesVariable(node, name, style, depth) {
    if (!node || depth > 48) return false;
    if (node.name === 'text') {
      if (str(node.attrs.variable) === name) return true;
      const macro = str(node.attrs.macro);
      if (macro && style.macros[macro]) return usesVariable(style.macros[macro], name, style, depth + 1);
    }
    for (const c of nodes(node)) {
      if (usesVariable(c, name, style, depth + 1)) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // 4. 条目 → CSL 变量
  // ---------------------------------------------------------------------------
  // 只映射数据层真的有的字段（library.js 的 item + fields）。缺的保持空串，
  // 由 group / choose 决定要不要省略。
  const TYPE_MAP = {
    journalArticle: 'article-journal',
    magazineArticle: 'article-magazine',
    newspaperArticle: 'article-newspaper',
    conferencePaper: 'paper-conference',
    book: 'book',
    bookSection: 'chapter',
    thesis: 'thesis',
    report: 'report',
    preprint: 'article',
    manuscript: 'manuscript',
    webpage: 'webpage',
    blogPost: 'post-weblog',
    forumPost: 'post',
    encyclopediaArticle: 'entry-encyclopedia',
    dictionaryEntry: 'entry-dictionary',
    letter: 'personal_communication',
    email: 'personal_communication',
    interview: 'interview',
    presentation: 'speech',
    artwork: 'graphic',
    film: 'motion_picture',
    tvBroadcast: 'broadcast',
    podcast: 'broadcast',
    videoRecording: 'motion_picture',
    audioRecording: 'song',
    software: 'software',
    dataset: 'dataset',
    map: 'map',
    patent: 'patent',
    standard: 'standard',
    legislation: 'legislation',
    case: 'legal_case',
    statute: 'legislation',
    hearing: 'hearing',
    document: 'document',
    note: 'document',
    attachment: 'document',
  };

  function parseDate(raw) {
    const s = str(raw);
    if (!s) return null;
    const head = s.match(/^(\d{4})([a-z]?)/i);
    if (!head) return null;
    const rest = s.slice(head[0].length);
    const two = rest.match(/(\d{1,2})[^\d]+(\d{1,2})/);
    const one = rest.match(/[^\d]*(\d{1,2})/);
    const month = two ? +two[1] : (one ? +one[1] : 0);
    const day = two ? +two[2] : 0;
    return {
      yearText: head[1] + (head[2] || ''),
      year: +head[1],
      month: month >= 1 && month <= 12 ? month : 0,
      day: day >= 1 && day <= 31 ? day : 0,
    };
  }

  function adaptItem(it, opts) {
    const raw = it && typeof it === 'object' ? it : {};
    const fields = raw.fields && typeof raw.fields === 'object' ? raw.fields : {};
    const creators = Creators ? Creators.normalizeCreators(raw.creators) : [];
    const pick = (type) => creators
      .filter((c) => (c.creatorType || 'author') === type)
      .map((c) => ({ family: str(c.lastName), given: str(c.firstName) }));
    const o = opts || {};

    return {
      type: TYPE_MAP[raw.itemType] || 'document',
      title: str(raw.title),
      titleShort: str(fields.shortTitle),
      containerTitle: str(raw.publication),
      containerTitleShort: str(raw.publication),
      collectionTitle: str(fields.series),
      volume: str(raw.volume),
      issue: str(raw.issue),
      page: str(raw.pages),
      edition: str(fields.edition),
      publisher: str(fields.publisher),
      publisherPlace: str(fields.place),
      event: str(fields.conference),
      eventPlace: str(fields.place),
      ISBN: str(fields.isbn),
      ISSN: str(fields.issn),
      DOI: str(raw.doi),
      URL: str(raw.url),
      abstract: str(raw.abstract),
      note: str(raw.note),
      language: str(raw.language),
      archive: str(fields.archive),
      archiveLocation: str(fields.archiveLocation),
      callNumber: str(fields.callNumber),
      numberOfPages: '',
      citationKey: str(o.citekey || ''),
      citationNumber: String(o.number || 1),
      issued: parseDate(raw.year),
      accessed: parseDate(fields.accessed),
      author: pick('author'),
      editor: pick('editor'),
      translator: pick('translator'),
      contributor: pick('contributor'),
      containerAuthor: [],
      collectionEditor: [],
      raw,
    };
  }

  // ---------------------------------------------------------------------------
  // 5. 变量 / 词条 / 大小写
  // ---------------------------------------------------------------------------
  function firstPage(page) {
    const m = str(page).match(/\d+/);
    return m ? m[0] : str(page);
  }

  function normalizeDash(value) {
    return str(value).replace(/(\d)\s*[-\u2010-\u2015]\s*(?=\d)/g, '$1\u2013');
  }

  function expandPageRange(a, b, mode) {
    const start = String(a), end = String(b);
    if (!/^\d+$/.test(start) || !/^\d+$/.test(end)) return start + '\u2013' + end;
    if (mode === 'expanded' || end.length < start.length) return start + '\u2013' + end;
    let common = 0;
    while (common < start.length - 1 && common < end.length && start[common] === end[common]) common++;
    const minDigits = mode === 'minimal' ? 1 : 2;
    const keep = Math.max(1, Math.min(end.length, Math.max(minDigits, end.length - common)));
    return start + '\u2013' + end.slice(end.length - keep);
  }

  function formatPageRange(value, mode, delimiter) {
    const sep = delimiter || '\u2013';
    return normalizeDash(value).replace(/(\d+)\u2013(\d+)/g, (m, a, b) => {
      if (!mode) return a + sep + b;
      return expandPageRange(a, b, mode).replace('\u2013', sep);
    });
  }

  function variableValue(ctx, name) {
    const it = ctx.item;
    switch (name) {
      case 'title': return it.title;
      case 'title-short': return it.titleShort;
      case 'container-title': return it.containerTitle;
      case 'container-title-short': return it.containerTitleShort;
      case 'collection-title': return it.collectionTitle;
      case 'volume': return it.volume;
      case 'issue': return it.issue;
      case 'page':
        return ctx.style.pageRangeFormat
          ? formatPageRange(it.page, ctx.style.pageRangeFormat, termValue(ctx, 'page-range-delimiter'))
          : normalizeDash(it.page);
      case 'page-first': return firstPage(it.page);
      case 'number-of-pages': return it.numberOfPages;
      case 'edition': return it.edition;
      case 'publisher': return it.publisher;
      case 'publisher-place': return it.publisherPlace;
      case 'event': case 'event-title': return it.event;
      case 'event-place': return it.eventPlace;
      case 'ISBN': return it.ISBN;
      case 'ISSN': return it.ISSN;
      case 'DOI': return it.DOI;
      case 'URL': return it.URL;
      case 'abstract': return it.abstract;
      case 'note': return it.note;
      case 'language': return it.language;
      case 'archive': return it.archive;
      case 'archive_location': case 'archive-location': return it.archiveLocation;
      case 'call-number': return it.callNumber;
      case 'citation-number': return it.citationNumber;
      case 'citation-key': return it.citationKey;
      case 'year-suffix': return '';
      case 'issued': return it.issued ? it.issued.yearText : '';
      case 'accessed': return it.accessed ? it.accessed.yearText : '';
      default: return '';
    }
  }

  function isVariableNonEmpty(ctx, name) {
    if (Array.isArray(ctx.item[name])) return ctx.item[name].length > 0;
    return !!variableValue(ctx, name);
  }

  function isNumericValue(value) {
    return /^\s*\d+(\s*[-\u2013,&]\s*\d+)*\s*[a-zA-Z]*\s*$/.test(String(value == null ? '' : value));
  }

  function isPluralValue(value) {
    return /(\d)\s*[-\u2013,&]\s*\d/.test(str(value)) || /,/.test(str(value));
  }

  function lookupTerm(ctx, name) {
    const own = ctx.style.terms.get(name);
    if (own) return { own, table: null };
    return { own: null, table: localeTable(ctx.locale) };
  }

  function termValue(ctx, name, form, plural) {
    const wanted = form || 'long';
    const chain = wanted === 'verb-short' ? ['verb-short', 'verb', 'long']
      : wanted === 'symbol' ? ['symbol', 'short', 'long']
        : wanted === 'short' ? ['short', 'long']
          : [wanted];
    if (!chain.includes('long')) chain.push('long');
    const hit = lookupTerm(ctx, name);

    if (hit.own) {
      for (const f of chain) {
        const entry = hit.own[f];
        if (!entry) continue;
        if (entry.single != null || entry.multiple != null) {
          return plural ? (entry.multiple || entry.single || '') : (entry.single || entry.multiple || '');
        }
        if (entry.text != null) return entry.text;
      }
    }
    for (const f of chain) {
      const table = hit.table && hit.table[f];
      if (!table) continue;
      const value = table[name];
      if (value == null) continue;
      if (Array.isArray(value)) return plural ? (value[1] || value[0] || '') : (value[0] || '');
      return value;
    }
    return '';
  }

  const TITLE_STOP = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from',
    'in', 'into', 'nor', 'of', 'on', 'onto', 'or', 'over', 'so', 'the', 'to', 'up',
    'yet', 'with']);

  function applyTextCase(text, mode) {
    const s = String(text);
    switch (mode) {
      case 'lowercase': return s.toLowerCase();
      case 'uppercase': return s.toUpperCase();
      case 'capitalize-first': {
        const i = s.search(/\p{L}/u);
        return i < 0 ? s : s.slice(0, i) + s[i].toUpperCase() + s.slice(i + 1);
      }
      case 'capitalize-all': {
        return s.replace(/\p{L}[\p{L}\p{M}'-]*/gu, (word, offset) => {
          const lower = word.toLowerCase();
          const before = s.slice(0, offset);
          const first = !/\p{L}/u.test(before);
          if (!first && TITLE_STOP.has(lower)) return lower;
          return word[0].toUpperCase() + word.slice(1).toLowerCase();
        });
      }
      case 'sentence': {
        const lower = s.toLowerCase();
        const i = lower.search(/\p{L}/u);
        return i < 0 ? lower : lower.slice(0, i) + lower[i].toUpperCase() + lower.slice(i + 1);
      }
      case 'title': return applyTextCase(s, 'capitalize-all');
      default: return s;
    }
  }

  function applyFormat(text, attrs, ctx) {
    let out = String(text);
    if (!out || !ctx || ctx.markup !== 'html') return out;
    if (attrs['font-style'] === 'italic' || attrs['font-style'] === 'oblique') out = '<i>' + out + '</i>';
    if (attrs['font-weight'] === 'bold') out = '<b>' + out + '</b>';
    if (attrs['text-decoration'] === 'underline') out = '<u>' + out + '</u>';
    if (attrs['vertical-align'] === 'sup') out = '<sup>' + out + '</sup>';
    else if (attrs['vertical-align'] === 'sub') out = '<sub>' + out + '</sub>';
    return out;
  }

  function decorate(text, attrs, ctx) {
    if (text == null || text === '') return '';
    let out = String(text);
    if (attrs['text-case']) out = applyTextCase(out, attrs['text-case']);
    if (attrs['strip-periods'] === 'true') out = out.replace(/\./g, '');
    out = applyFormat(out, attrs, ctx);
    if (attrs.quotes === 'true') {
      out = termValue(ctx, 'open-quote') + out + termValue(ctx, 'close-quote');
    }
    // 与 citeproc 一致：文本已经以标点结尾时，别再把同样的标点叠上去
    // （Nature 的 "Smith, J." + suffix "." 应该是 "Smith, J."，不是 "Smith, J.."）
    let suffix = attrs.suffix || '';
    const last = out ? out[out.length - 1] : '';
    const PUNCT = '.,;:!?';
    if (suffix && PUNCT.includes(suffix[0]) && last) {
      if (suffix[0] === last || (suffix[0] === '.' && (last === '?' || last === '!'))) {
        suffix = suffix.slice(1);
      }
    }
    return (attrs.prefix || '') + out + suffix;
  }

  // ---------------------------------------------------------------------------
  // 6. 名字
  // ---------------------------------------------------------------------------
  const NAME_OPTION_KEYS = ['and', 'delimiter', 'delimiter-precedes-last', 'delimiter-precedes-et-al',
    'et-al-min', 'et-al-use-first', 'et-al-use-last', 'et-al-subsequent-min',
    'et-al-subsequent-use-first', 'initialize', 'initialize-with', 'name-as-sort-order',
    'sort-separator', 'form'];

  function nameOptions(nameEl, namesEl, ctx) {
    const chain = [
      ctx.style.rootAttrs || {},
      (ctx.mode === 'bibliography' ? ctx.style.bibliography && ctx.style.bibliography.attrs : null) || {},
      (namesEl && namesEl.attrs) || {},
      (nameEl && nameEl.attrs) || {},
    ];
    const out = {};
    for (const key of NAME_OPTION_KEYS) {
      for (const attrs of chain) {
        // 注意：initialize-with="" 是有意义的（Vancouver 要 "Smith J"），不能当缺省跳过
        if (attrs[key] != null) out[key] = attrs[key];
      }
    }
    out.__nameEl = nameEl || null;
    out.__namesEl = namesEl || null;
    return out;
  }

  function intOr(value, fallback) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
  }

  function initialsWith(given, sep) {
    const words = str(given).split(/\s+/).filter(Boolean);
    const out = [];
    for (const word of words) {
      const segs = word.split('-').filter(Boolean);
      const letters = [];
      for (const seg of segs) {
        const m = /\p{L}/u.exec(seg);
        if (m) letters.push(m[0].toUpperCase());
      }
      if (!letters.length) continue;
      if (segs.length > 1) {
        // 连字符名：字母之间用 "-" 连，点/空格留在整段末尾（J.-P. 而不是 J. -P.）
        const dot = String(sep).replace(/\s+$/, '');
        const tail = String(sep).slice(dot.length);
        out.push(letters.map((l) => l + dot).join('-') + tail);
      } else {
        out.push(letters[0] + sep);
      }
    }
    return out.join('').replace(/\s+$/, '');
  }

  function givenText(given, opts) {
    const raw = str(given);
    if (!raw) return '';
    let sep = opts['initialize-with'];
    if (sep == null) {
      if (opts.initialize === 'true') sep = '. ';
      else return raw;
    }
    if (opts.initialize === 'false') return raw;
    return initialsWith(raw, String(sep));
  }

  function namePartAttrs(nameEl, which) {
    if (!nameEl) return null;
    for (const part of childNodes(nameEl, 'name-part')) {
      if (str(part.attrs.name) === which) return part.attrs;
    }
    return null;
  }

  function formatOneName(person, opts, index, ctx) {
    const family = str(person.family);
    const given = str(person.given);
    if (!family && !given) return '';
    if (!family) return given;

    const shortForm = opts.form === 'short';
    if (shortForm) {
      const famAttrs = namePartAttrs(opts.__nameEl, 'family');
      return famAttrs ? decorate(family, famAttrs, ctx).replace(/^\s+|\s+$/g, '') : family;
    }

    const invert = opts['name-as-sort-order'] === 'all' ||
      (opts['name-as-sort-order'] === 'first' && index === 0);
    const sortSep = opts['sort-separator'] != null ? String(opts['sort-separator']) : ', ';

    let famOut = family;
    let givenOut = givenText(given, opts);
    const famAttrs = namePartAttrs(opts.__nameEl, 'family');
    const givenAttrs = namePartAttrs(opts.__nameEl, 'given');
    if (famAttrs) famOut = decorate(famOut, famAttrs, ctx);
    if (givenAttrs) givenOut = decorate(givenOut, givenAttrs, ctx);

    if (!givenOut) return famOut;
    if (CJK.test(family) && CJK.test(given)) return famOut + givenOut;
    if (invert) return famOut + sortSep + givenOut;
    return givenOut + ' ' + famOut;
  }

  function joinNameParts(parts, opts, etAl, ctx, inverted) {
    if (!parts.length) return '';
    const delim = opts.delimiter != null ? String(opts.delimiter) : ', ';
    if (etAl) {
      const dpe = opts['delimiter-precedes-et-al'] || 'contextual';
      let sep;
      if (dpe === 'always') sep = delim;
      else if (dpe === 'never') sep = ' ';
      else sep = parts.length === 1 ? ' ' : delim;
      return parts.join(delim) + sep + termValue(ctx, 'et-al');
    }
    if (parts.length === 1) return parts[0];
    const andMode = opts.and || '';
    const dpl = opts['delimiter-precedes-last'] || 'contextual';
    const andTerm = andMode === 'symbol' ? '&' : termValue(ctx, 'and');

    if (!andMode || !andTerm) return parts.join(delim);

    const head = parts.slice(0, -1);
    const last = parts[parts.length - 1];
    let sep;
    if (parts.length === 2) sep = dpl === 'always' ? delim : ' ';
    else sep = dpl === 'never' ? ' ' : delim;
    if (dpl === 'after-inverted-name') {
      sep = inverted && inverted[inverted.length - 2] ? delim : ' ';
    }
    return head.join(delim) + sep + andTerm + ' ' + last;
  }

  function renderNames(node, ctx) {
    const vars = str(node.attrs.variable).split(/\s+/).filter(Boolean);
    const nameEl = firstChild(node, 'name');
    const labelEl = firstChild(node, 'label');
    const subEl = firstChild(node, 'substitute');
    const opts = nameOptions(nameEl, node, ctx);

    const found = [];
    for (const v of vars) {
      ctx.stats.seen++;
      if (isVariableNonEmpty(ctx, v)) { found.push(v); ctx.stats.nonEmpty++; }
    }

    let out = '';
    if (!found.length) {
      if (subEl) {
        for (const child of nodes(subEl)) {
          const text = renderNode(child, ctx);
          if (text) { out = text; break; }
        }
      }
      return decorate(out, node.attrs, ctx);
    }

    const groups = [];
    for (const v of found) {
      const people = ctx.item[v];
      if (!people || !people.length) continue;
      const etAlMin = intOr(opts['et-al-min'], 0);
      const useFirst = intOr(opts['et-al-use-first'], 0);
      let shown = people;
      let etAl = false;
      if (etAlMin > 0 && people.length >= etAlMin && useFirst > 0) {
        shown = people.slice(0, Math.max(1, useFirst));
        etAl = true;
      }
      const parts = [];
      const inverted = [];
      shown.forEach((person, i) => {
        const one = formatOneName(person, opts, i, ctx);
        if (one) {
          parts.push(one);
          inverted.push(opts['name-as-sort-order'] === 'all' ||
            (opts['name-as-sort-order'] === 'first' && i === 0));
        }
      });
      let text = joinNameParts(parts, opts, etAl, ctx, inverted);
      if (labelEl) {
        const labelPlural = String(labelEl.attrs.plural || 'contextual');
        const plural = labelPlural === 'always' ? true : labelPlural === 'never' ? false : people.length > 1;
        const term = termValue(ctx, v, labelEl.attrs.form || 'long', plural);
        if (term) text += decorate(term, labelEl.attrs, ctx);
      }
      if (text) groups.push(text);
    }

    out = groups.join('');
    return decorate(out, node.attrs, ctx);
  }

  // ---------------------------------------------------------------------------
  // 7. 日期 / 数字 / 标签
  // ---------------------------------------------------------------------------
  function pad2(n) { return String(n).padStart(2, '0'); }

  function ordinalSuffix(ctx, n, longForm) {
    if (longForm) {
      const name = 'long-ordinal-' + pad2(n);
      const text = termValue(ctx, name, 'long', false);
      if (text) return text;
    }
    const mod100 = n % 100;
    if (mod100 >= 11 && mod100 <= 13) return String(n) + termValue(ctx, 'ordinal', 'long', false);
    const mod10 = n % 10;
    if (mod10 >= 1 && mod10 <= 3) return String(n) + termValue(ctx, 'ordinal-0' + mod10, 'long', false);
    return String(n) + termValue(ctx, 'ordinal', 'long', false);
  }

  function renderDatePart(part, date, ctx) {
    const name = str(part.attrs.name);
    let out = '';
    if (name === 'year') {
      out = date.yearText;
    } else if (name === 'month') {
      if (!date.month) return '';
      const form = part.attrs.form || 'long';
      if (form === 'numeric') out = String(date.month);
      else if (form === 'numeric-leading-zeros') out = pad2(date.month);
      else out = termValue(ctx, 'month-' + pad2(date.month), form === 'short' ? 'short' : 'long', false);
    } else if (name === 'day') {
      if (!date.day) return '';
      const form = part.attrs.form || 'numeric';
      if (form === 'numeric-leading-zeros') out = pad2(date.day);
      else if (form === 'ordinal') out = ordinalSuffix(ctx, date.day, false);
      else out = String(date.day);
    }
    if (!out) return '';
    return decorate(out, part.attrs, ctx);
  }

  function renderDate(node, ctx) {
    const varName = str(node.attrs.variable);
    const date = ctx.item[varName];
    ctx.stats.seen++;
    if (!date || !date.yearText) return '';
    ctx.stats.nonEmpty++;

    const form = node.attrs.form || 'text';
    const limit = node.attrs['date-parts'] || 'year-month-day';
    const allowed = limit === 'year' ? ['year'] : limit === 'year-month' ? ['year', 'month'] : ['year', 'month', 'day'];

    let pieces = [];
    const partEls = childNodes(node, 'date-part').filter((p) => allowed.includes(str(p.attrs.name)));
    if (partEls.length) {
      pieces = partEls.map((p) => renderDatePart(p, date, ctx)).filter(Boolean);
      const delim = node.attrs.delimiter != null ? String(node.attrs.delimiter) : '';
      return decorate(pieces.join(delim), node.attrs, ctx);
    }

    // 没写 date-part：按 locale 的默认日期格式（我们只覆盖最常见的两种）
    if (form === 'numeric') {
      pieces = [date.yearText];
      if (date.month) pieces.push(pad2(date.month));
      if (date.day) pieces.push(pad2(date.day));
      return decorate(pieces.join('-'), node.attrs, ctx);
    }
    if (date.month) pieces.push(termValue(ctx, 'month-' + pad2(date.month), 'long', false));
    if (date.day) pieces.push(String(date.day));
    if (pieces.length) pieces = [pieces.join(' ') + ', ' + date.yearText];
    else pieces = [date.yearText];
    return decorate(pieces.join(''), node.attrs, ctx);
  }

  function romanNumber(n) {
    if (!Number.isFinite(n) || n <= 0 || n >= 4000) return String(n);
    const table = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
      [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
    let left = n, out = '';
    for (const [value, sym] of table) {
      while (left >= value) { out += sym; left -= value; }
    }
    return out;
  }

  function renderNumber(node, ctx) {
    const varName = str(node.attrs.variable);
    const raw = variableValue(ctx, varName);
    ctx.stats.seen++;
    if (!raw) return '';
    ctx.stats.nonEmpty++;

    const form = node.attrs.form || 'numeric';
    const match = String(raw).match(/\d+/);
    const n = match ? parseInt(match[0], 10) : NaN;
    let out = String(raw);
    if (form === 'ordinal' && Number.isFinite(n)) out = ordinalSuffix(ctx, n, false);
    else if (form === 'long-ordinal' && Number.isFinite(n)) out = ordinalSuffix(ctx, n, true);
    else if (form === 'roman' && Number.isFinite(n)) out = romanNumber(n);
    return decorate(out, node.attrs, ctx);
  }

  function renderLabel(node, ctx) {
    const varName = str(node.attrs.variable);
    const value = variableValue(ctx, varName);
    ctx.stats.seen++;
    if (!value) return '';
    ctx.stats.nonEmpty++;

    const termName = varName === 'locator' ? (ctx.locatorType || 'page') : varName;
    const pluralAttr = node.attrs.plural || 'contextual';
    const plural = pluralAttr === 'always' ? true : pluralAttr === 'never' ? false : isPluralValue(value);
    const text = termValue(ctx, termName, node.attrs.form || 'long', plural);
    if (!text) return '';
    return decorate(text, node.attrs, ctx);
  }

  // ---------------------------------------------------------------------------
  // 8. choose / group / text / macro
  // ---------------------------------------------------------------------------
  function positionTest(attrs, ctx) {
    const wanted = str(attrs.position).split(/\s+/).filter(Boolean);
    if (!wanted.length) return true;
    const current = ctx.position || '';
    return wanted.includes(current);
  }

  function evalCondition(node, ctx) {
    const attrs = node.attrs;
    const tests = [];
    if (attrs.type) {
      for (const t of str(attrs.type).split(/\s+/).filter(Boolean)) tests.push(ctx.item.type === t);
    }
    if (attrs.variable) {
      for (const v of str(attrs.variable).split(/\s+/).filter(Boolean)) tests.push(isVariableNonEmpty(ctx, v));
    }
    if (attrs['is-numeric']) {
      for (const v of str(attrs['is-numeric']).split(/\s+/).filter(Boolean)) {
        tests.push(isNumericValue(variableValue(ctx, v)));
      }
    }
    if (attrs['is-uncertain-date']) tests.push(false);
    if (attrs.position) tests.push(positionTest(attrs, ctx));
    if (attrs.locator) tests.push(!!(ctx.locatorType && str(attrs.locator).split(/\s+/).includes(ctx.locatorType)));
    if (attrs.disambiguate) tests.push(false);
    if (!tests.length) return true;
    const match = attrs.match || 'all';
    if (match === 'any') return tests.some(Boolean);
    if (match === 'none') return tests.every((x) => !x);
    return tests.every(Boolean);
  }

  function renderChoose(node, ctx) {
    for (const branch of nodes(node)) {
      if (branch.name === 'else') return renderChildren(branch, ctx);
      if (branch.name === 'if' || branch.name === 'else-if') {
        if (evalCondition(branch, ctx)) return renderChildren(branch, ctx);
      }
    }
    return '';
  }

  function renderGroup(node, ctx) {
    const seenBefore = ctx.stats.seen;
    const nonEmptyBefore = ctx.stats.nonEmpty;
    const parts = [];
    for (const child of nodes(node)) {
      const text = renderNode(child, ctx);
      if (text) parts.push(text);
    }
    // CSL 的 group 是隐式条件：只要组里调用了变量、而调用的变量全为空，整组消失。
    // 这样 "Vol. " 之类的词条不会在 volume 缺失时留下孤儿。
    if (ctx.stats.seen > seenBefore && ctx.stats.nonEmpty === nonEmptyBefore) return '';
    const text = parts.join(node.attrs.delimiter || '');
    if (!text) return '';
    return decorate(text, node.attrs, ctx);
  }

  function renderChildren(node, ctx) {
    let out = '';
    for (const child of nodes(node)) out += renderNode(child, ctx);
    return out;
  }

  function renderText(node, ctx) {
    const attrs = node.attrs;
    if (attrs.macro) {
      const macro = ctx.style.macros[attrs.macro];
      if (!macro) return '';
      if (ctx.depth > 48) return '';
      ctx.depth++;
      const text = renderChildren(macro, ctx);
      ctx.depth--;
      return decorate(text, attrs, ctx);
    }
    if (attrs.term) {
      const text = termValue(ctx, attrs.term, attrs.form || 'long', attrs.plural === 'true');
      if (!text) return '';
      return decorate(text, attrs, ctx);
    }
    if (attrs.value != null) return decorate(String(attrs.value), attrs, ctx);
    if (attrs.variable) {
      const name = attrs.variable;
      let value = variableValue(ctx, name);
      if (attrs.form === 'short' && name === 'title') value = ctx.item.titleShort || value;
      ctx.stats.seen++;
      if (!value) return '';
      ctx.stats.nonEmpty++;
      return decorate(value, attrs, ctx);
    }
    return '';
  }

  function renderNode(node, ctx) {
    if (!node) return '';
    switch (node.name) {
      case 'text': return renderText(node, ctx);
      case 'group': return renderGroup(node, ctx);
      case 'choose': return renderChoose(node, ctx);
      case 'names': return renderNames(node, ctx);
      case 'date': return renderDate(node, ctx);
      case 'number': return renderNumber(node, ctx);
      case 'label': return renderLabel(node, ctx);
      case 'layout': return renderLayout(node, ctx);
      case 'else': return renderChildren(node, ctx);
      case 'if': case 'else-if': return evalCondition(node, ctx) ? renderChildren(node, ctx) : '';
      default: return '';
    }
  }

  function renderLayout(node, ctx) {
    const text = renderChildren(node, ctx);
    if (!text) return '';
    return decorate(text, node.attrs, ctx);
  }

  function cleanup(text) {
    return String(text)
      .replace(/[ \t]+/g, ' ')
      .replace(/\s+([,.;:!?])/g, '$1')
      .trim();
  }

  // ---------------------------------------------------------------------------
  // 9. 注册表 + 对外渲染接口
  // ---------------------------------------------------------------------------
  const registry = new Map();

  function register(xml, meta) {
    const style = parseStyle(xml, meta);
    if (!style.bibliography) throw new Error('样式没有 bibliography，无法用于参考文献表');
    registry.set(style.id, style);
    return style;
  }

  function registerMany(list, source) {
    const out = [];
    for (const row of Array.isArray(list) ? list : []) {
      try {
        const style = register(row.xml, {
          id: row.id,
          label: row.label,
          source: row.source || source || 'builtin',
        });
        out.push(style);
      } catch (err) {
        // 单个坏样式不能拖垮整份内置列表
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[csl] 跳过样式', (row && (row.id || row.label)) || '?', err && err.message);
        }
      }
    }
    return out;
  }

  function clearUserStyles() {
    for (const [key, style] of [...registry]) {
      if (style.source === 'user') registry.delete(key);
    }
  }

  function setUserStyles(list) {
    clearUserStyles();
    return registerMany(list, 'user');
  }

  function list() {
    return [...registry.values()].map((style) => ({
      key: style.id,
      id: 'csl:' + style.id,
      label: style.label,
      source: style.source,
      kind: style.source,
      numeric: !!style.numeric,
      class: style.class,
      warnings: style.warnings.slice(),
    }));
  }

  function resolve(idOrStyle) {
    if (idOrStyle && typeof idOrStyle === 'object') return idOrStyle;
    const id = str(idOrStyle);
    if (!id) return null;
    if (id.startsWith('csl:')) return registry.get(id.slice(4)) || null;
    return registry.get(id) || null;
  }

  function isCslStyle(id) {
    const s = str(id);
    return s.startsWith('csl:') && registry.has(s.slice(4));
  }

  function isNumeric(id) {
    const style = resolve(id);
    return !!(style && style.numeric);
  }

  function makeContext(style, cslItem, opts) {
    const o = opts || {};
    return {
      style,
      item: cslItem,
      locale: o.locale || style.defaultLocale,
      mode: o.mode || 'bibliography',
      citationNumber: o.number || 1,
      position: o.position || '',
      locatorType: o.locatorType || '',
      markup: o.markup || 'none',
      stats: { seen: 0, nonEmpty: 0 },
      depth: 0,
    };
  }

  function render(idOrStyle, item, opts) {
    const style = resolve(idOrStyle);
    if (!style || !style.bibliography) return '';
    const layout = firstChild(style.bibliography, 'layout');
    if (!layout) return '';
    const o = opts || {};
    const cslItem = adaptItem(item, o);
    const ctx = makeContext(style, cslItem, o);
    return cleanup(renderLayout(layout, ctx));
  }

  function sortItems(idOrStyle, items) {
    const style = resolve(idOrStyle);
    if (!style || !style.bibliography) return null;
    const sortEl = firstChild(style.bibliography, 'sort');
    if (!sortEl) return null;
    const keys = childNodes(sortEl, 'key');
    if (!keys.length) return null;
    const collator = (() => {
      try { return new Intl.Collator(style.defaultLocale || 'en', { numeric: true, sensitivity: 'base' }); }
      catch (_) { return null; }
    })();

    const decorated = (Array.isArray(items) ? items : []).map((item, index) => {
      const ctx = makeContext(style, adaptItem(item, {}), { markup: 'none' });
      const values = keys.map((key) => {
        if (key.attrs.macro && style.macros[key.attrs.macro]) {
          return cleanup(renderChildren(style.macros[key.attrs.macro], ctx));
        }
        if (key.attrs.variable) {
          const name = key.attrs.variable;
          if (Array.isArray(ctx.item[name])) return ctx.item[name].map((p) => p.family || p.given || '').join(' ');
          return variableValue(ctx, name);
        }
        return '';
      });
      return { item, index, values, desc: keys.map((k) => k.attrs.sort === 'descending') };
    });

    decorated.sort((a, b) => {
      for (let i = 0; i < keys.length; i++) {
        const x = str(a.values[i]), y = str(b.values[i]);
        if (!x && !y) continue;
        if (!x) return 1;
        if (!y) return -1;
        const c = collator ? collator.compare(x, y) : (x < y ? -1 : x > y ? 1 : 0);
        if (c) return a.desc[i] ? -c : c;
      }
      return a.index - b.index;
    });
    return decorated.map((row) => row.item);
  }

  return {
    parseXml, parseStyle, register, registerMany, setUserStyles, clearUserStyles,
    list, resolve, isCslStyle, isNumeric, render, sortItems,
    formatPageRange, adaptItem,
    // 测试与调试用
    _terms: { termValue },
  };
});
