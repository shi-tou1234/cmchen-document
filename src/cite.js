'use strict';
/*
 * 引用格式化：把文献库条目排成能直接粘进论文的引用串。
 * 支持两种样式：
 *   gbt7714 —— GB/T 7714-2015（中文论文最常用）
 *   apa     —— APA 7th
 *
 * 已知边界（写在这里以免被当成完整 CSL 实现）：
 *   - 作者是逗号分隔的纯字符串，没有「姓 / 名 / 角色」的结构化信息，
 *     所以 APA 不做 "Smith, J." 的姓名拆分，GB/T 也不区分个人作者与机构；
 *   - 没有引文数据库：页码定位符、语言本地化、样式自定义都做不了；
 *     要完整 CSL 能力得引 citeproc-js + 样式库，那是另一个量级的改动；
 *   - 出版地、机构、出版日期这些字段本项目的数据模型里没有，只能省略。
 *
 * 这个文件主进程与渲染进程都能用（UMD 风格）：
 *   Node：   require('./cite.js')
 *   浏览器： <script src="../cite.js"></script> → window.Cite
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Cite = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
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

  const str = (v) => String(v == null ? '' : v).trim();

  function authorsOf(it) {
    if (!it || !Array.isArray(it.creators)) return [];
    return it.creators.map(str).filter(Boolean);
  }

  // GB/T 7714：作者超过 3 个只列前 3 个再加「等」
  function gbtAuthors(list) {
    if (!list.length) return '';
    if (list.length > 3) return list.slice(0, 3).join(', ') + ', 等';
    return list.join(', ');
  }

  // APA：3 个及以上用 et al.
  function apaAuthors(list) {
    if (!list.length) return '';
    if (list.length > 2) return list[0] + ', et al.';
    if (list.length === 2) return list[0] + ', & ' + list[1];
    return list[0];
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
    const list = authorsOf(it);
    const a = list.length > 3 ? list.slice(0, 3).join(', ') + ', et al.' : list.join(' and ');
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
    const list = authorsOf(it);
    const a = list.length ? list.join(', ') : '';
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
    const list = authorsOf(it);
    const a = list.length > 2 ? list[0] + ', et al.' : (list.length === 2 ? list[0] + ', and ' + list[1] : (list[0] || ''));
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

  function lastName(name) {
    const s = str(name);
    if (!s) return '';
    if (s.includes(',')) return s.split(',')[0].trim();
    const parts = s.split(/\s+/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
  }

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
    let who = slug(lastName(authors[0] || ''));
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

  // 统一入口：style 走对应样式，其它一律按 GB/T 处理。
  // num 只影响 IEEE 的序号；单条引用不传时保持 [1]。
  function format(it, style, num) {
    if (!it) return '';
    if (style === 'apa') return apa(it);
    if (style === 'chicago') return chicago(it);
    if (style === 'ieee') return ieee(it, num);
    if (style === 'mla') return mla(it);
    return gbt(it);
  }

  function styleLabel(id) {
    const hit = STYLES.find((x) => x.id === id);
    return hit ? hit.label : (id || '');
  }

  function typeLabel(it) {
    return TYPE_NAME[str(it && it.itemType) || 'document'] || '文档';
  }

  return {
    format, gbt, apa, chicago, ieee, mla, authorsOf, styleLabel, typeLabel,
    citekey, citekeys, atCitation,
    STYLES, TYPE_CODE, TYPE_NAME,
  };
});
