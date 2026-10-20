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
  // GB/T 7714-2015 的文献类型标识码
  const TYPE_CODE = {
    journalArticle: 'J',
    conferencePaper: 'C',
    book: 'M',
    thesis: 'D',
    report: 'R',
    webpage: 'EB/OL',
    document: 'Z',
  };

  const TYPE_NAME = {
    journalArticle: '期刊文章',
    conferencePaper: '会议论文',
    book: '图书',
    thesis: '学位论文',
    report: '报告',
    webpage: '网页',
    document: '文档',
  };

  const STYLES = [
    { id: 'gbt7714', label: 'GB/T 7714-2015' },
    { id: 'apa', label: 'APA 7' },
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
      case 'journalArticle': {
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
      case 'conferencePaper':
        out += t + '[C]//' + (pub || '会议论文集') + '.';
        if (y) out += ' ' + y + '.';
        if (pg) out += ': ' + pg + '.';
        break;
      case 'book': {
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
      case 'webpage':
        out += t + '[EB/OL].';
        if (pub) out += ' ' + pub + '.';
        if (url) out += ' ' + url + '.';
        break;
      default:
        out += t + '[' + code + '].';
        out += y ? ' ' + y + '.' : '';
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
        if (pub) out += ' ' + pub + ',';
        if (vol) {
          out += ' ' + vol;
          if (iss) out += '(' + iss + ')';
        }
        if (pg) out += ', ' + pg;
        out += '.';
        break;
      case 'conferencePaper':
        if (pub) out += ' In ' + pub + '.';
        if (pg) out += ' (pp. ' + pg + ').';
        break;
      case 'book':
        if (pub) out += ' ' + pub + '.';
        break;
      case 'thesis':
        out += ' [Doctoral dissertation].';
        break;
      case 'report':
        if (pub) out += ' ' + pub + '.';
        break;
      case 'webpage':
        if (pub) out += ' ' + pub + '.';
        if (url) out += ' ' + url;
        break;
      default:
        if (pub) out += ' ' + pub + '.';
    }
    if (doi) out += ' https://doi.org/' + doi;
    else if (type === 'webpage' && url && !/\.$/.test(out)) out += '.';
    return out;
  }

  // 统一入口：style 走 gbt7714 / apa，其它一律按 GB/T 处理
  function format(it, style) {
    if (!it) return '';
    if (style === 'apa') return apa(it);
    return gbt(it);
  }

  function styleLabel(id) {
    const hit = STYLES.find((x) => x.id === id);
    return hit ? hit.label : (id || '');
  }

  function typeLabel(it) {
    return TYPE_NAME[str(it && it.itemType) || 'document'] || '文档';
  }

  return { format, gbt, apa, authorsOf, styleLabel, typeLabel, STYLES, TYPE_CODE, TYPE_NAME };
});
