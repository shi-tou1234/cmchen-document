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
 *     脚注体的同上 / 前引与同姓消歧由本文件的 citeSequence / authorLabels 提供，
 *     只覆盖内置的 note 体写法，不参与 CSL 渲染。
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
  // v35：从「固定规则」改成可配置模板（JabRef / Better BibTeX 的做法）。
  // 默认模板与旧算法逐字符等价，所以老用户已经贴进文稿的键不会变。
  //
  // 模板语法：[字段] 或 [字段:修饰符:修饰符]，其余字符按字面量拼进键里。
  //   字段（不区分大小写）
  //     auth            第一作者的姓
  //     authEtAl        第一作者姓 + EtAl（多于一位作者时）
  //     authIni         全部作者的姓首字母（Vaswani, Shazeer → VS）
  //     authN           前 N 位作者的姓（N=1..9，如 [auth3]）
  //     authors         全部作者的姓
  //     authorsN        前 N 位
  //     year            四位年份（缺失时为 nd）
  //     shortyear       年份后两位
  //     title           标题全部实词，驼峰拼接
  //     shorttitle      前 3 个实词
  //     veryshorttitle  第 1 个实词
  //     fulltitle       标题原文（只去标点）
  //     journal         期刊 / 会议名
  //     journalabbr     期刊缩写（没有缩写字段时退回全名）
  //     volume / pages / firstpage / lastpage / doi / itemtype / key
  //   修饰符
  //     lower / upper / capitalize  大小写
  //     abbr                        每个词取首字母（期刊类优先用缩写字段）
  //     数字                        截断到 N 个字符（如 [auth:3]）
  // 未识别的字段展开为空；整个模板展开为空时退回 item+条目 key 前缀，
  // 保证键永远非空、且同一篇每次一致。
  //
  // 中文作者没有拼音库时无法可靠转写：第一作者是 CJK 时 [auth] 展开成 item+条目 key 前缀
  // （与旧 citekey() 一致，绝不改用第二作者）；后面位置的作者转写不出就在该位留空，
  // 不让后来者往前挤——「谁排第一谁就是第一作者」是兼容性的一部分，不是排版细节。
  const TITLE_STOP = new Set(['the', 'a', 'an', 'on', 'of', 'for', 'and', 'to', 'in', 'with', 'from', 'by', 'at', 'as']);
  const DEFAULT_KEY_TEMPLATE = '[auth:lower][year][veryshorttitle:lower]';
  const KEY_TOKEN = /\[([^\]]*)\]/g;

  function slug(s, max) {
    return String(s == null ? '' : s)
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Za-z0-9]+/g, '')
      .toLowerCase()
      .slice(0, max || 28);
  }

  // 键里允许出现的字符：字母数字 + _ : . + -（Pandoc / BibTeX 都认这套）
  function keyClean(s) {
    return String(s == null ? '' : s)
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Za-z0-9_:.+-]+/g, '')
      .slice(0, 64);
  }

  // 作者字段的清洗比通用 keyClean 更严：只留字母数字。
  // 旧算法用 slug() 生成作者段（"Smith-Jones" → "smithjones"），如果这里保留连字符，
  // 默认模板就会算出 "smith-jones2024study"，与用户文稿里已有的 [@smithjones2024study] 对不上。
  // 大小写不在这里动：那是 :lower / :upper 的活。
  function authClean(s) {
    return String(s == null ? '' : s)
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Za-z0-9]+/g, '')
      .slice(0, 28);
  }

  // 作者系字段：auth / authN / authors / authorsN / authEtAl / authIni
  const AUTH_FIELD = /^(auth|authors|authetal|authini|authors\d|auth\d)$/;
  // veryshorttitle 的旧口径是「首个实词的前 12 个字符」（slug(w, 12)）
  const VERY_SHORT_TITLE_MAX = 12;

  // 标题取词：默认按「至少 3 个字符 + 跳过虚词」取实词，与旧算法取词口径一致，
  // 这样默认模板产出的键不会变；[title] 要完整标题，所以给它 minLen=1 且不跳虚词。
  function titleWords(title, opts) {
    const o = opts || {};
    const min = o.minLen == null ? 3 : o.minLen;
    const words = String(title || '').match(/[A-Za-z][A-Za-z0-9]*/g) || [];
    const out = [];
    for (const w of words) {
      if (w.length < min) continue;
      if (o.skipStop !== false && TITLE_STOP.has(w.toLowerCase())) continue;
      out.push(w);
      if (o.limit && out.length >= o.limit) break;
    }
    return out;
  }

  function titleWord(title) {
    const w = titleWords(title, { limit: 1 })[0];
    return w ? slug(w, 12) : '';
  }

  function yearOf(it) {
    return (String((it && it.year) || '').match(/\d{4}/) || [''])[0] || '';
  }

  function lastNameOf(c) {
    if (!c) return '';
    const last = str(c.lastName) || str(c.firstName);
    // CJK 姓不做转写（没有拼音库），留给兜底，别产出乱码键
    if (!last || CJK.test(last)) return '';
    return last;
  }

  const ITEMTYPE_KEY = {
    journalArticle: 'article', magazineArticle: 'article', newspaperArticle: 'article',
    book: 'book', bookSection: 'incollection', conferencePaper: 'inproceedings',
    thesis: 'phdthesis', report: 'techreport', manuscript: 'unpublished', webpage: 'misc',
  };

  // 单个字段展开。返回**保留词间空格**的原始值（修饰符要靠空格认词边界，
  // 例如 :abbr 取每词首字母）；最终由 expandKeyTemplate 统一 keyClean 去掉分隔符。
  function keyField(name, it) {
    const low = String(name || '').toLowerCase();
    const authors = authorsOf(it);
    // 旧 citekey() 的语义是「**只看第一作者**」：姓能转写就用，不能转写（中文 / 空）
    // 就退回 `item + 条目 key 前缀`，**不会改用第二作者**。
    // 所以这里不能 `map(lastNameOf).filter(Boolean)` 之后再取 [0]——那等于把中文第一作者
    // 从队伍里删掉、让第二作者顶上来，于是「中文第一作者 + 英文合作者」的条目在升级后
    // 换了键（R5-04）。正确做法：位置数组保留空位，只把第 1 位换成兜底写法。
    const fallback = 'item' + slug(it && it.key, 4);
    const who = authors.map(lastNameOf);
    if (!who.length) who.push(fallback);
    else if (!who[0]) who[0] = fallback;
    const named = who.filter(Boolean);   // 能转写的作者（含第一作者位的兜底项）
    const m = low.match(/^(auth|authors)(\d)$/);
    if (m) {
      const n = Math.max(1, Math.min(9, Number(m[2]) || 1));
      // 前 n 个作者，按位置取；某位不可转写就跳过，不让后面的人往前挤
      return who.slice(0, n).filter(Boolean).join(' ');
    }
    switch (low) {
      case 'auth': return who[0];
      case 'authetal': return who.length > 1 ? (who[0] + ' EtAl') : who[0];
      case 'authini': return named.map((x) => x.charAt(0)).join('').toUpperCase();
      case 'authors': return named.join(' ');
      case 'year': return yearOf(it) || 'nd';
      case 'shortyear': {
        const y = yearOf(it);
        return y ? y.slice(2) : 'nd';
      }
      case 'title': return titleWords(it && it.title, { minLen: 1, skipStop: false }).join(' ');
      case 'shorttitle': return titleWords(it && it.title, { limit: 3 }).join(' ');
      case 'veryshorttitle': return titleWords(it && it.title, { limit: 1 }).join(' ');
      case 'fulltitle': return str(it && it.title);
      case 'journal': return str(it && (it.publication || it.journal || it.bookTitle));
      case 'journalabbr': return str(it && (it.journalAbbreviation || it.publication || it.journal));
      case 'volume': return str(it && it.volume);
      case 'issue': return str(it && it.issue);
      case 'pages': return str(it && it.pages);
      case 'firstpage': return String((it && it.pages) || '').split(/[-,–]/)[0];
      case 'lastpage': {
        const parts = String((it && it.pages) || '').split(/[-,–]/);
        return parts.length > 1 ? parts[parts.length - 1] : '';
      }
      case 'doi': return str(it && it.doi);
      case 'itemtype': {
        const t = str(it && it.itemType);
        return ITEMTYPE_KEY[t] || t;
      }
      case 'key': return str(it && it.key).slice(0, 8);
      default: return '';
    }
  }

  function initialsOf(val) {
    // abbr：把每个词的首字母拼起来（"Attention All You" → "AAY"）
    return String(val).split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w.charAt(0)).join('').toUpperCase();
  }

  // 修饰符：大小写 / 缩写 / 截断。未知修饰符忽略（模板可以写注释般的修饰而不炸）。
  function keyModifier(val, mod, field) {
    const m = String(mod || '').trim().toLowerCase();
    if (!m) return val;
    if (m === 'lower') return val.toLowerCase();
    if (m === 'upper') return val.toUpperCase();
    if (m === 'capitalize' || m === 'cap') return val.charAt(0).toUpperCase() + val.slice(1).toLowerCase();
    if (m === 'abbr') return initialsOf(val);
    if (/^\d+$/.test(m)) return val.slice(0, Number(m));
    void field;
    return val;
  }

  // 模板规范化：空 / 没有 [ 的模板视为无效，退回默认值（避免把整串字面量当键）。
  function normalizeKeyTemplate(tpl) {
    const t = String(tpl == null ? '' : tpl).trim();
    if (!t || t.length > 200 || !/\[[^\]]*\]/.test(t)) return DEFAULT_KEY_TEMPLATE;
    return t;
  }

  function expandKeyTemplate(it, template) {
    if (!it) return '';
    const tpl = normalizeKeyTemplate(template);
    let out = '';
    let last = 0;
    let m;
    KEY_TOKEN.lastIndex = 0;
    while ((m = KEY_TOKEN.exec(tpl))) {
      out += keyClean(tpl.slice(last, m.index));
      last = m.index + m[0].length;
      const parts = String(m[1]).split(':').map((x) => x.trim()).filter((x) => x !== '');
      if (!parts.length) continue;
      const field = parts[0].toLowerCase();
      let val = keyField(parts[0], it);
      for (let i = 1; i < parts.length; i++) val = keyModifier(val, parts[i], parts[0]);
      // 字段各按旧算法的清洗与截断口径收尾，默认模板才能与改造前逐字符一致：
      // 作者段只留字母数字（slug），veryshorttitle 截 12 字符（旧 titleWord 的 slug(w, 12)）。
      if (AUTH_FIELD.test(field)) out += authClean(val);
      else if (field === 'veryshorttitle') out += keyClean(val).slice(0, VERY_SHORT_TITLE_MAX);
      else out += keyClean(val);
    }
    out += keyClean(tpl.slice(last));
    return out;
  }

  function citekey(it, opts) {
    if (!it) return '';
    const o = typeof opts === 'string' ? { template: opts } : (opts || {});
    const year = yearOf(it) || 'nd';
    // 40 字符上限沿用旧实现：老键不因为这次改造被截成别的样子
    const base = expandKeyTemplate(it, o.template).slice(0, 40);
    // 模板里的字段全空（比如写了个不存在的字段）：退到确定性的可读兜底。
    // 注意：只有「完全为空」才兜底——只写 [year] 得到 '2017' 是合法的，不该被改写。
    if (base) return base;
    return ('item' + slug(it.key || '', 4) + year).slice(0, 40) || ('item' + year);
  }

  // 一批条目统一分配引用键：先按条目 key 排序再消重，结果与列表顺序无关。
  // 返回 Map<item.key, citekey>。
  function citekeys(items, opts) {
    const rows = (Array.isArray(items) ? items : []).map((it) => ({ it, base: citekey(it, opts) }))
      .sort((a, b) => String(a.it && a.it.key).localeCompare(String(b.it && b.it.key)));
    const used = new Set();
    const nextSuffix = new Map();
    const out = new Map();
    for (const row of rows) {
      const key = row.it && row.it.key;
      if (!key) continue;
      let k = row.base, i = nextSuffix.get(row.base) || 2;
      while (used.has(k)) k = row.base + '-' + i++;
      nextSuffix.set(row.base, i);
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

  // ---------- 作者消歧 ----------
  // 文内引注只写姓，两位 Smith 撞在一起时读者分不清是谁。规则与 APA 一致：
  // 姓氏撞车时给**所有**撞车的条目补名字首字母（J. Smith / R. Smith）。
  // 只给其中一条补会让另一条看起来像「唯一的 Smith」，反而更乱。
  function surnameKey(c) {
    return (str(c.lastName) || str(c.firstName)).toLowerCase();
  }

  function givenInitial(c) {
    const first = str(c.firstName);
    // 中文名没有「首字母」这个概念，硬造一个只会产出无意义的拉丁字母
    if (!first || CJK.test(first)) return '';
    return Creators.initials(first, true);
  }

  // 返回 Map<item.key, Set<小写姓氏>>：这条目里哪些姓需要补首字母。
  // items 传「同一篇文稿里可能被引用的全部条目」——消歧是集合性质，
  // 只看单条永远判断不出「还有别人也姓 Smith」。
  function authorLabels(items) {
    const list = Array.isArray(items) ? items.filter(Boolean) : [];
    const seen = new Map();   // 姓氏 -> Set(首字母)
    for (const it of list) {
      for (const c of authorsOf(it)) {
        const sn = surnameKey(c);
        if (!sn) continue;
        if (!seen.has(sn)) seen.set(sn, new Set());
        seen.get(sn).add(givenInitial(c));
      }
    }
    const out = new Map();
    for (const it of list) {
      const hit = new Set();
      for (const c of authorsOf(it)) {
        const sn = surnameKey(c);
        if (!sn) continue;
        const set = seen.get(sn);
        // 两个以上**不同**的首字母才算撞车；同一个人出现两次不算
        if (set && Array.from(set).filter(Boolean).length > 1) hit.add(sn);
      }
      if (hit.size && it.key) out.set(it.key, hit);
    }
    return out;
  }

  // 文内引注里的作者部分（不含年份与定位符）。
  // opts.ambiguous：authorLabels() 里对应本条的 Set；有值且命中的姓补首字母。
  function inTextWho(it, opts) {
    const o = opts || {};
    const amb = o.ambiguous || null;
    const list = authorsOf(it).filter((c) => c.creatorType !== 'editor');
    const nameOf = (c) => {
      const last = str(c.lastName) || str(c.firstName);
      if (!last) return '';
      if (!amb || !amb.has(surnameKey(c))) return last;
      const ini = givenInitial(c);
      return ini ? ini + ' ' + last : last;
    };
    // 1 位姓；2 位 A & B；3 位以上 A et al.（中文名 / 机构名按原文）
    const names = list.map(nameOf).filter(Boolean);
    if (!names.length) return str(it && it.title).slice(0, 40) || '佚名';
    if (names.length === 1) return names[0];
    if (names.length === 2) return names[0] + ' & ' + names[1];
    return names[0] + ' et al.';
  }

  // ---------- 文内引注（in-text citation with locator） ----------
  // 差距报告里「文内引注定位符」的简化落地：编号制出 [n, p. X]，作者-年份制出
  // (Surname, 2020, p. X)。定位符由用户填（页码 / 章节 / 图号），可空。
  // opts.ambiguous 传 authorLabels() 的结果时，同姓作者会补上名字首字母。
  function citeInText(it, opts) {
    const o = opts || {};
    const style = str(o.style) || 'gbt7714';
    const locator = str(o.locator).replace(/^\s*,\s*/, '');
    // year：调用方可以传「消歧后的完整年份」（如 2024a / 2024a-10），
    // 与参考文献表共用同一套结果；不传就用条目自己的年份。
    const year = str(o.year) || str(it && it.year) || 'n.d.';
    const num = Math.max(1, Math.floor(+o.num || 1));
    if (isNumericStyle(style) || (Csl && Csl.isCslStyle(style) && style.numeric)) {
      // 编号制：定位符进方括号 —— [12, p. 5]
      return '[' + num + (locator ? ', ' + locator : '') + ']';
    }
    const withLoc = (base) => base + (locator ? ', ' + locator : '');
    const who = inTextWho(it, { ambiguous: o.ambiguous });
    if (style === 'mla') {
      // MLA 9：正文引注不带年份，页码紧跟姓，无逗号
      return '(' + who + (locator ? ' ' + locator : '') + ')';
    }
    return '(' + withLoc(who + ', ' + year) + ')';
  }

  // ---------- 脚注体引注与「同上 / 前引」 ----------
  // 同上（ibid.）只在脚注体里有意义：作者-年份制重复引用必须重复写全，
  // 编号制靠编号指回表里。所以这组函数独立存在，不去改 citeInText 的语义。
  function shortTitle(t, n) {
    const s = str(t);
    if (!s) return '';
    if (CJK.test(s)) return s.length > 14 ? s.slice(0, 14) + '…' : s;
    const words = s.split(/\s+/).filter(Boolean);
    const k = Math.max(2, n || 4);
    return words.length <= k ? s : words.slice(0, k).join(' ') + '…';
  }

  // 完整脚注引注（Chicago 17 的 note 体，简化为纯文本 + Markdown 强调标记）：
  //   期刊   Who. “题名.” *刊名* 卷, no. 期 (年): 页.
  //   图书   Who. *书名*. 出版社, 年.
  //   章节   Who. “题名.” In *书名*, 页. 年.
  // 强调用 *…* 是因为它最终多半粘进 Markdown 笔记；纯文本里星号也读得懂。
  function noteCite(it, opts) {
    const o = opts || {};
    const list = authorsOf(it).filter((c) => c.creatorType !== 'editor');
    const names = list.map((c) => invertedName(c, true)).filter(Boolean);
    let who = '';
    if (names.length === 1) who = names[0];
    else if (names.length === 2) who = names[0] + ', and ' + names[1];
    else if (names.length > 2) who = names[0] + ', et al.';
    const year = str(o.year) || yearOf(it);
    const title = str(it && it.title);
    const pub = str(it && it.publication);
    const vol = str(it && it.volume);
    const issue = str(it && it.issue);
    const pages = str(it && it.pages);
    const type = str(it && it.itemType) || 'document';
    // 裸 DOI（doiTail 是给「 DOI:…」这种尾巴用的，这里要拼成可点的链接）
    const doi = str(it && it.doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^DOI:\s*/i, '');
    const url = str(it && it.url);
    const loc = str(o.locator);
    const quoted = ['journalArticle', 'magazineArticle', 'newspaperArticle', 'bookSection',
      'conferencePaper', 'webpage', 'blogPost', 'thesis', 'report', 'preprint'].indexOf(type) >= 0;

    const parts = [];
    if (who) parts.push(/[.。!?]$/.test(who) ? who : who + '.');
    if (title) parts.push(quoted ? '“' + title + '.”' : '*' + title + '*.');
    if (type === 'journalArticle' || type === 'magazineArticle' || type === 'newspaperArticle') {
      let tail = pub ? '*' + pub + '*' : '';
      if (vol) tail += (tail ? ' ' : '') + vol;
      if (issue) tail += (tail ? ', ' : '') + 'no. ' + issue;
      if (year) tail += (tail ? ' ' : '') + '(' + year + ')';
      if (pages) tail += (tail ? ': ' : '') + pages;
      if (tail) parts.push(tail + '.');
    } else if (type === 'bookSection' || type === 'conferencePaper') {
      let tail = pub ? 'In *' + pub + '*' : '';
      if (pages) tail += (tail ? ', ' : '') + pages;
      if (tail) parts.push(tail + (year ? ', ' + year : '') + '.');
      else if (year) parts.push(year + '.');
    } else {
      let tail = pub;
      if (year) tail += (tail ? ', ' : '') + year;
      if (tail) parts.push(tail + '.');
    }
    if (doi) parts.push('https://doi.org/' + doi);
    else if (url) parts.push(url);
    if (loc) parts.push(loc + '.');
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  // 短引注（Chicago 17 的 short note）：姓 + 短题名 + 定位符。
  // 无作者条目不重复写题名——inTextWho 的兜底本来就是标题，再拼一次会得到「X, X.」。
  function shortNote(it, opts) {
    const o = opts || {};
    const hasAuthor = authorsOf(it).some((c) => c.creatorType !== 'editor');
    const who = hasAuthor ? inTextWho(it, { ambiguous: o.ambiguous }) : '';
    const t = shortTitle(it && it.title);
    const loc = str(o.locator);
    const head = [who, t].filter(Boolean).join(', ');
    return head + (loc ? ', ' + loc : '') + '.';
  }

  // 前引（op. cit.）：只在已经完整引用过一次之后才成立，所以调用方必须传位置。
  function opCit(it, opts) {
    const o = opts || {};
    const who = inTextWho(it, { ambiguous: o.ambiguous });
    const loc = str(o.locator);
    if (o.locale === 'zh') return who + '，前引' + (loc ? '，' + loc : '') + '。';
    return who + ', op. cit.' + (loc ? ', ' + loc : '') + '.';
  }

  /*
   * 给一串引注（按正文出现顺序）生成脚注体文本，并处理同上 / 前引。
   * entries: [{ it, locator }]
   * opts:
   *   collapse  'ibid'（默认，连续用同上、非连续用短引注）
   *             'opcit'（连续用同上、非连续用前引）
   *             'none'（一律完整引注）
   *   locale    'zh' | 'en'
   *   ambiguous authorLabels() 的结果
   * 返回 [{ text, form, key }]，form: 'full' | 'ibid' | 'short' | 'opcit'
   */
  function citeSequence(entries, opts) {
    const o = opts || {};
    const zh = o.locale === 'zh';
    const collapse = ['ibid', 'opcit', 'none'].indexOf(o.collapse) >= 0 ? o.collapse : 'ibid';
    const list = Array.isArray(entries) ? entries : [];
    const out = [];
    let prevKey = '';
    for (const e of list) {
      const it = e && e.it;
      if (!it) { out.push({ text: '', form: 'full', key: '' }); continue; }
      const key = str(it.key) || str(it.title);
      const loc = str(e.locator);
      // 之前出现过（不含本次）才谈得上「前引」
      const seenBefore = out.some((x) => x.key && x.key === key);
      const amb = o.ambiguous instanceof Map ? o.ambiguous.get(key) : null;
      let text, form;
      if (collapse !== 'none' && prevKey && prevKey === key) {
        form = 'ibid';
        text = zh ? ('同上' + (loc ? '，' + loc : '') + '。') : ('Ibid.' + (loc ? ', ' + loc : ''));
      } else if (collapse === 'opcit' && seenBefore) {
        form = 'opcit';
        text = opCit(it, { ambiguous: amb, locator: loc, locale: o.locale });
      } else if (collapse === 'ibid' && seenBefore) {
        form = 'short';
        text = shortNote(it, { ambiguous: amb, locator: loc });
      } else {
        form = 'full';
        text = noteCite(it, { year: o.year instanceof Map ? o.year.get(key) : o.year, locator: loc });
      }
      out.push({ text, form, key });
      prevKey = key;
    }
    return out;
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
    citekey, citekeys, atCitation, citeInText,
    authorLabels, inTextWho, noteCite, shortNote, opCit, citeSequence, shortTitle,
    styleList, isNumericStyle, isCslStyle, registerCslStyles, cslStyleInfo, cslSort,
    STYLES, TYPE_CODE, TYPE_NAME,
  };
});
