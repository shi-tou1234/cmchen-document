'use strict';
/*
 * 引用格式化：把文献库条目排成能直接粘进论文的引用串。
 * 支持 5 种内置样式（gbt7714 / apa / chicago / ieee / mla），以及 csl.js
 * 的 CSL 子集样式（`csl:` 前缀，含 3 份内置 CSL 与用户导入的 .csl）。
 *
 * 已知边界（写在这里以免被当成完整 CSL 实现）：
 *   - 作者结构化（v6）后能做姓 / 名 / 角色拆分，APA 能出 "Smith, J."、
 *     GB/T 能出 "SMITH J"。
 *   - CSL 只渲染参考文献表布局，没有文内引注的定位符 / 同上 / 消歧；
 *     完整 CSL 能力仍需 citeproc-js + 官方样式库。
 *   - 后缀（Jr. / III）没有单独字段，会并进名字里。
 *   - 出版地、机构、出版日期这些字段本项目的数据模型里没有，只能省略。
 *
 * 这个文件主进程与渲染进程都能用（UMD 风格）：
 *   Node：   require('./cite.js')
 *   浏览器： <script src="../cite.js"></script> → window.Cite
 */
(function (root, factory) {
  const Creators = (root && root.Creators) || (typeof require === 'function' ? require('./creators.js') : null);
  const Csl = (root && root.Csl) || (typeof require === 'function' ? require('./csl.js') : null);
  const CslStyles = (root && root.CslStyles) || (typeof require === 'function' ? require('./csl-styles.js') : null);
  const api = factory(Creators, Csl, CslStyles);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Cite = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Creators, Csl, CslStyles) {
  // GB/T 7714-2015 的文献类型标识码。
  // v27：补齐文献库 v5 的 37 类条目，避免新类型全被排成 [Z]。
  const TYPE_CODE = {
    journalArticle: 'J',
    magazineArticle: 'J',
    newspaperArticle: 'N',
    conferencePaper: 'C',
    book: 'M',
    bookSection: 'M',
    thesis: 'D',
    report: 'R',
    preprint: 'Z',
    manuscript: 'Z',
    webpage: 'EB/OL',
    blogPost: 'EB/OL',
    forumPost: 'EB/OL',
    encyclopediaArticle: 'M',
    dictionaryEntry: 'M',
    letter: 'Z',
    email: 'Z',
    interview: 'Z',
    presentation: 'C',
    artwork: 'Z',
    film: 'V',
    tvBroadcast: 'V',
    podcast: 'Z',
    videoRecording: 'V',
    audioRecording: 'Z',
    software: 'CP',
    dataset: 'DS',
    map: 'CM',
    patent: 'P',
    standard: 'S',
    legislation: 'Z',
    case: 'Z',
    statute: 'Z',
    hearing: 'Z',
    document: 'Z',
    note: 'Z',
    attachment: 'Z',
  };

  const TYPE_NAME = {
    journalArticle: '期刊文章',
    magazineArticle: '杂志文章',
    newspaperArticle: '报纸文章',
    conferencePaper: '会议论文',
    book: '图书',
    bookSection: '图书章节',
    thesis: '学位论文',
    report: '报告',
    preprint: '预印本',
    manuscript: '手稿',
    webpage: '网页',
    blogPost: '博客文章',
    forumPost: '论坛帖子',
    encyclopediaArticle: '百科条目',
    dictionaryEntry: '词典条目',
    letter: '信件',
    email: '电子邮件',
    interview: '访谈',
    presentation: '演示文稿',
    artwork: '艺术作品',
    film: '电影',
    tvBroadcast: '电视节目',
    podcast: '播客',
    videoRecording: '视频',
    audioRecording: '音频',
    software: '软件',
    dataset: '数据集',
    map: '地图',
    patent: '专利',
    standard: '标准',
    legislation: '法律',
    case: '判例',
    statute: '法规',
    hearing: '听证会',
    document: '文档',
    note: '笔记',
    attachment: '附件',
  };

  const STYLES = [
    { id: 'gbt7714', label: 'GB/T 7714-2015' },
    { id: 'apa', label: 'APA 7' },
    { id: 'chicago', label: 'Chicago 17（作者-年份）' },
    { id: 'ieee', label: 'IEEE' },
    { id: 'mla', label: 'MLA 9' },
  ];

  // v32：CSL 子集引擎。内置三份手写样式在这里注册一次，渲染层引入 csl.js /
  // csl-styles.js 后即可直接用；用户导入的样式由主进程扫描后调用 registerCslStyles。
  if (Csl && CslStyles) {
    try { Csl.registerMany(CslStyles.styles); } catch (_) { /* 单份坏样式不应拖垮引用功能 */ }
  }

  const str = (v) => String(v == null ? '' : v).trim();
  const CJK = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/;

  // v6：作者一律按结构化对象处理（v5 的字符串会在 creators.js 里被拆好）
  function authorsOf(it) {
    if (!it) return [];
    return Creators.normalizeCreators(it.creators);
  }

  // 兼容老接口：摊平成字符串数组（界面展示用）
  function authorNames(it) {
    return Creators.strings(authorsOf(it));
  }

  // GB/T 7714：外文作者姓全大写、名用不带点的首字母（"SMITH J"）；中文名与机构名原样
  function gbtName(c) {
    const last = str(c.lastName), first = str(c.firstName);
    if (!last) return first;
    if (!first) return last;
    if (CJK.test(last)) return last;
    return last.toUpperCase() + ' ' + Creators.initials(first, false);
  }

  // GB/T 7714：作者超过 3 个只列前 3 个再加「等」
  function gbtAuthors(list) {
    if (!list.length) return '';
    const names = list.map(gbtName).filter(Boolean);
    if (!names.length) return '';
    if (names.length > 3) return names.slice(0, 3).join(', ') + ', 等';
    return names.join(', ');
  }

  // APA：姓在前 + 名字缩写（"Smith, J."）
  function apaName(c) {
    const last = str(c.lastName), first = str(c.firstName);
    if (!last) return first;
    if (!first) return last;
    return last + ', ' + Creators.initials(first);
  }

  // APA 7：3 位以内全列，超过 20 位才截断
  function apaAuthors(list) {
    if (!list.length) return '';
    const names = list.map(apaName).filter(Boolean);
    if (!names.length) return '';
    if (names.length === 1) return names[0];
    if (names.length === 2) return names[0] + ', & ' + names[1];
    if (names.length <= 20) return names.slice(0, -1).join(', ') + ', & ' + names[names.length - 1];
    return names.slice(0, 19).join(', ') + ', ... ' + names[names.length - 1];
  }

  // Chicago / MLA：第一位作者姓在前，其余按「名 姓」
  function invertedName(c, first) {
    const last = str(c.lastName), given = str(c.firstName);
    if (!last) return given;
    if (!given) return last;
    return first ? last + ', ' + given : given + ' ' + last;
  }

  // Chicago 17：参考文献表里最多列 10 位，再多就前 7 位 + et al.
  function chicagoAuthors(list) {
    if (!list.length) return '';
    const names = list.map((c, i) => invertedName(c, i === 0)).filter(Boolean);
    if (!names.length) return '';
    if (names.length === 1) return names[0];
    if (names.length === 2) return names[0] + ', and ' + names[1];
    if (names.length <= 10) return names.slice(0, -1).join(', ') + ', and ' + names[names.length - 1];
    return names.slice(0, 7).join(', ') + ', et al.';
  }

  // IEEE：名在前（首字母）+ 姓；超过 6 位作者用 et al.
  function ieeeName(c) {
    const last = str(c.lastName), first = str(c.firstName);
    if (!last) return first;
    if (!first) return last;
    return Creators.initials(first) + ' ' + last;
  }

  function ieeeAuthors(list) {
    if (!list.length) return '';
    const names = list.map(ieeeName).filter(Boolean);
    if (!names.length) return '';
    if (names.length === 1) return names[0];
    if (names.length === 2) return names[0] + ' and ' + names[1];
    if (names.length <= 6) return names.slice(0, -1).join(', ') + ', and ' + names[names.length - 1];
    return names[0] + ' et al.';
  }

  // MLA 9：两位全列，三位以上用 et al.
  function mlaAuthors(list) {
    if (!list.length) return '';
    const names = list.map((c, i) => invertedName(c, i === 0)).filter(Boolean);
    if (!names.length) return '';
    if (names.length === 1) return names[0];
    if (names.length === 2) return names[0] + ', and ' + names[1];
    return names[0] + ', et al.';
  }

  function doiTail(it) {
    const doi = str(it && it.doi);
    return doi ? ' DOI:' + doi + '.' : '';
  }

  // 把「刊名, 年, 卷(期)」这类片段拼起来，缺项就不留悬空的逗号
  function seg(parts) {
    return parts.filter(Boolean).join(', ');
  }

  // ---------- GB/T 7714-2015 ----------
  function gbt(it) {
    if (!it) return '';
    const t = str(it.title);
    if (!t) return '';
    const a = gbtAuthors(authorsOf(it));
    const type = str(it.itemType) || 'document';
    const code = TYPE_CODE[type] || 'Z';
    const pub = str(it.publication);
    const y = str(it.year);
    const vol = str(it.volume);
    const iss = str(it.issue);
    const pg = str(it.pages);
    const url = str(it.url);
    let out = a ? a + '. ' : '';
    switch (type) {
      case 'journalArticle':
      case 'magazineArticle': {
        out += t + '[J].';
        const head = seg([pub, y, vol ? vol + (iss ? '(' + iss + ')' : '') : '']);
        if (head) {
          out += ' ' + head;
          if (pg) out += ': ' + pg;
          out += '.';
        } else if (pg) out += ' ' + pg + '.';
        else out += '.';
        break;
      }
      case 'newspaperArticle': {
        // 报纸用 [N]，与期刊的 [J] 区分（TYPE_CODE 里也标的是 N）
        out += t + '[N].';
        const headN = seg([pub, y]);
        if (headN) {
          out += ' ' + headN;
          if (pg) out += ': ' + pg;
          out += '.';
        } else if (pg) out += ' ' + pg + '.';
        else out += '.';
        break;
      }
      case 'conferencePaper':
      case 'presentation':
        out += t + '[C]//' + (pub || '会议论文集') + '.';
        if (y) {
          out += ' ' + y;
          if (pg) out += ': ' + pg;
          out += '.';
        } else if (pg) out += ' ' + pg + '.';
        break;
      case 'bookSection':
        out += t + '[M]//' + (pub || '论文集') + '.';
        if (y) {
          out += ' ' + y;
          if (pg) out += ': ' + pg;
          out += '.';
        } else if (pg) out += ' ' + pg + '.';
        break;
      case 'book':
      case 'encyclopediaArticle':
      case 'dictionaryEntry': {
        out += t + '[M].';
        const head2 = seg([pub, y]);
        if (head2) out += ' ' + head2 + '.';
        break;
      }
      case 'thesis':
        out += t + '[D].';
        if (y) out += ' ' + y + '.';
        break;
      case 'report': {
        out += t + '[R].';
        const head3 = seg([pub, y]);
        if (head3) out += ' ' + head3 + '.';
        break;
      }
      case 'preprint': {
        // 预印本按 TYPE_CODE 的 [Z]，避免和正式报告的 [R] 混在一起
        out += t + '[Z].';
        const headP = seg([pub, y]);
        if (headP) out += ' ' + headP + '.';
        if (url) out += ' ' + url + '.';
        break;
      }
      case 'webpage':
      case 'blogPost':
      case 'forumPost':
        out += t + '[EB/OL].';
        if (pub) out += ' ' + pub + '.';
        if (url) out += ' ' + url + '.';
        break;
      case 'standard':
      case 'patent':
      case 'dataset':
      case 'software':
      case 'map': {
        out += t + '[' + code + '].';
        const head4 = seg([pub, y]);
        if (head4) out += ' ' + head4 + '.';
        if (url) out += ' ' + url + '.';
        break;
      }
      default:
        out += t + '[' + code + '].';
        out += y ? ' ' + y + '.' : '';
        if (pub) out += ' ' + pub + '.';
        if (url) out += ' ' + url + '.';
    }
    return out + doiTail(it);
  }

  // ---------- APA 7th ----------
  function apa(it) {
    if (!it) return '';
    const t = str(it.title);
    if (!t) return '';
    const a = apaAuthors(authorsOf(it));
    const type = str(it.itemType) || 'document';
    const pub = str(it.publication);
    const y = str(it.year) || 'n.d.';
    const vol = str(it.volume);
    const iss = str(it.issue);
    const pg = str(it.pages);
    const doi = str(it.doi);
    const url = str(it.url);
    let out = a ? a + ' ' : '';
    out += '(' + y + '). ' + t + '.';
    switch (type) {
      case 'journalArticle':
      case 'magazineArticle':
      case 'newspaperArticle':
        if (pub) out += ' ' + pub + ',';
        if (vol) {
          out += ' ' + vol;
          if (iss) out += '(' + iss + ')';
        }
        if (pg) out += ', ' + pg;
        out += '.';
        break;
      case 'conferencePaper':
      case 'presentation':
        if (pub) out += ' In ' + pub + '.';
        if (pg) out += ' (pp. ' + pg + ').';
        break;
      case 'bookSection':
        if (pub) out += ' In ' + pub;
        if (pg) out += ' (pp. ' + pg + ')';
        out += '.';
        break;
      case 'book':
      case 'encyclopediaArticle':
      case 'dictionaryEntry':
        if (pub) out += ' ' + pub + '.';
        break;
      case 'thesis':
        out += ' [Doctoral dissertation].';
        break;
      case 'report':
      case 'preprint':
        if (pub) out += ' ' + pub + '.';
        break;
      case 'webpage':
      case 'blogPost':
      case 'forumPost':
        if (pub) out += ' ' + pub + '.';
        if (url) out += ' ' + url;
        break;
      default:
        if (pub) out += ' ' + pub + '.';
        if (url && !doi) out += ' ' + url;
    }
    if (doi) out += ' https://doi.org/' + doi;
    else if (type === 'webpage' && url && !/\.$/.test(out)) out += '.';
    return out.replace(/\.\.+$/, '.');
  }

  // ---------- Chicago 17（作者-年份） ----------
  function chicago(it) {
    if (!it) return '';
    const t = str(it.title);
    if (!t) return '';
    const a = chicagoAuthors(authorsOf(it));
    const y = str(it.year) || 'n.d.';
    const pub = str(it.publication);
    const vol = str(it.volume);
    const iss = str(it.issue);
    const pg = str(it.pages);
    let out = a ? a + '. ' : '';
    out += y + '. ';
    out += '"' + t + '."';
    if (pub) out += ' ' + pub;
    if (vol) {
      out += ' ' + vol;
      if (iss) out += ' (' + iss + ')';
    }
    if (pg) out += ': ' + pg;
    out += '.';
    const doi = str(it.doi);
    if (doi) out += ' https://doi.org/' + doi + '.';
    return out;
  }

  // ---------- IEEE（编号制；单条默认 [1]，参考文献表可传入实际序号） ----------
  function ieee(it, num) {
    if (!it) return '';
    const t = str(it.title);
    if (!t) return '';
    const a = ieeeAuthors(authorsOf(it));
    const pub = str(it.publication);
    const vol = str(it.volume);
    const iss = str(it.issue);
    const pg = str(it.pages);
    const y = str(it.year);
    const seq = Number.isFinite(+num) && +num > 0 ? Math.floor(+num) : 1;
    let out = '[' + seq + '] ';
    if (a) out += a + ', ';
    out += '"' + t + ',"';
    if (pub) out += ' ' + pub + ',';
    if (vol) out += ' vol. ' + vol + ',';
    if (iss) out += ' no. ' + iss + ',';
    if (pg) {
      const parts = String(pg).split('-');
      out += ' pp. ' + (parts.length > 1 ? parts[0] + '-' + parts[1] : parts[0]) + ',';
    }
    if (y) out += ' ' + y + '.';
    const doi = str(it.doi);
    if (doi) out += ' doi: ' + doi + '.';
    return out;
  }

  // ---------- MLA 9 ----------
  function mla(it) {
    if (!it) return '';
    const t = str(it.title);
    if (!t) return '';
    const a = mlaAuthors(authorsOf(it));
    const pub = str(it.publication);
    const vol = str(it.volume);
    const iss = str(it.issue);
    const pg = str(it.pages);
    const y = str(it.year);
    let out = a ? a + '. ' : '';
    out += '"' + t + '."';
    if (pub) out += ' ' + pub + ',';
    if (vol) {
      out += ' vol. ' + vol + ',';
      if (iss) out += ' no. ' + iss + ',';
    }
    if (y) out += ' ' + y + ',';
    if (pg) out += ' pp. ' + pg + '.';
    else out += '.';
    const doi = str(it.doi);
    if (doi) out += ' https://doi.org/' + doi + '.';
    return out;
  }

  // ---------- 引用键（citekey） ----------
  // 目标：同一篇条目每次都得到同一个键，方便在 Markdown / Obsidian / Pandoc 里写 [@key]。
  // 规则接近 Better BibTeX 的默认值：第一作者姓 + 年份 + 标题首个实词，全小写 ASCII。
  // 中文作者没有拼音库时无法可靠转写，退化为 item+条目 key 前缀（仍然确定性、可读性差一点）。
  const TITLE_STOP = new Set(['the', 'a', 'an', 'on', 'of', 'for', 'and', 'to', 'in', 'with', 'from', 'by', 'at', 'as']);

  function slug(s, max) {
    return String(s == null ? '' : s)
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Za-z0-9]+/g, '')
      .toLowerCase()
      .slice(0, max || 28);
  }

  function titleWord(title) {
    const words = String(title || '').match(/[A-Za-z][A-Za-z0-9]{2,}/g) || [];
    for (const w of words) {
      if (!TITLE_STOP.has(w.toLowerCase())) return slug(w, 12);
    }
    return '';
  }

  function citekey(it) {
    if (!it) return '';
    const authors = authorsOf(it);
    const first = authors[0] || null;
    // 结构化之后直接取姓，不用再从 "Brown, John" 里猜
    let who = slug(first ? (first.lastName || first.firstName) : '');
    const year = (String(it.year || '').match(/\d{4}/) || [''])[0] || 'nd';
    if (!who) who = 'item' + slug(it.key || '', 4);
    const base = (who + year + titleWord(it.title)).slice(0, 40);
    return base || ('item' + year);
  }

  // 一批条目统一分配引用键：先按条目 key 排序再消重，结果与列表顺序无关。
  // 返回 Map<item.key, citekey>。
  function citekeys(items) {
    const rows = (Array.isArray(items) ? items : []).map((it) => ({ it, base: citekey(it) }))
      .sort((a, b) => String(a.it && a.it.key).localeCompare(String(b.it && b.it.key)));
    const used = new Set();
    const out = new Map();
    for (const row of rows) {
      const key = row.it && row.it.key;
      if (!key) continue;
      let k = row.base, i = 2;
      while (used.has(k)) k = row.base + '-' + i++;
      used.add(k);
      out.set(key, k);
    }
    return out;
  }

  // Pandoc / Obsidian 的行内引用写法
  function atCitation(key) {
    const k = str(key);
    return k ? '[@' + k + ']' : '';
  }

  // 统一入口：先看是不是 CSL 样式（csl: 前缀），否则走 5 种内置样式。
  // num 只影响编号制样式（IEEE 的 [n]、CSL 的 citation-number）。
  function format(it, style, num) {
    if (!it) return '';
    if (Csl && Csl.isCslStyle(style)) {
      return Csl.render(style, it, { number: num, citekey: citekey(it) });
    }
    if (style === 'apa') return apa(it);
    if (style === 'chicago') return chicago(it);
    if (style === 'ieee') return ieee(it, num);
    if (style === 'mla') return mla(it);
    return gbt(it);
  }

  // 样式下拉的数据源：5 种内置 + 已注册的 CSL 样式（含用户导入）。
  function styleList() {
    const out = STYLES.map((s) => ({
      id: s.id, label: s.label, group: '内置样式',
      numeric: s.id === 'gbt7714' || s.id === 'ieee', kind: 'builtin',
    }));
    if (Csl) {
      for (const s of Csl.list()) {
        out.push({
          id: s.id, label: s.label,
          group: s.source === 'user' ? '导入的 CSL 样式' : 'CSL 样式（内置）',
          numeric: !!s.numeric, kind: s.source, warnings: s.warnings,
        });
      }
    }
    return out;
  }

  function isNumericStyle(id) {
    if (Csl && Csl.isCslStyle(id)) return Csl.isNumeric(id);
    return id === 'gbt7714' || id === 'ieee';
  }

  function isCslStyle(id) {
    return !!(Csl && Csl.isCslStyle(id));
  }

  // 主进程把 <dataDir>/styles 下的用户样式整批发过来：先清掉旧的用户样式再注册，
  // 避免删了文件后下拉里还留着幽灵条目。
  function registerCslStyles(list) {
    if (!Csl) return [];
    return Csl.setUserStyles(Array.isArray(list) ? list : []);
  }

  function cslStyleInfo(id) {
    if (!isCslStyle(id)) return null;
    const style = Csl.resolve(id);
    if (!style) return null;
    return { id: style.id, label: style.label, source: style.source, warnings: style.warnings.slice() };
  }

  // 参考文献表排序：样式自带 <sort> 时交给引擎，返回 null 表示「按老规则排」。
  function cslSort(style, items) {
    if (!isCslStyle(style)) return null;
    try { return Csl.sortItems(style, items); } catch (_) { return null; }
  }

  function styleLabel(id) {
    const hit = STYLES.find((x) => x.id === id);
    if (hit) return hit.label;
    if (isCslStyle(id)) {
      const style = Csl.resolve(id);
      if (style) return style.label;
    }
    return id || '';
  }

  function typeLabel(it) {
    return TYPE_NAME[str(it && it.itemType) || 'document'] || '文档';
  }

  return {
    format, gbt, apa, chicago, ieee, mla, authorsOf, authorNames, styleLabel, typeLabel,
    citekey, citekeys, atCitation,
    styleList, isNumericStyle, isCslStyle, registerCslStyles, cslStyleInfo, cslSort,
    STYLES, TYPE_CODE, TYPE_NAME,
  };
});
