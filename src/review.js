'use strict';
/*
 * 批注 → 跨条目综述草稿（2026-10-29）。
 *
 * 输入是「已经汇总好的批注 + 条目」，输出是一份 Markdown 大纲：
 * 按主题（标签）/ 按文献 / 不分组，每条批注带文内引注与页码，末尾附参考文献表。
 *
 * 为什么单独成模块：分组、排序、编号、截断全是纯函数，Node 里能单测；
 * 主进程只负责从磁盘汇总批注（listAllAnnotations）和写文件。
 *
 * 两个刻意的决定：
 *   1. 编号制样式按「草稿里第一次出现的顺序」编号，参考文献表用同一顺序生成，
 *      所以正文 [3] 在表里就是第 3 条，不会错位。
 *   2. 输出刻意保持扁平结构（标题 + 引用块 + 斜体出处），不用嵌套列表——
 *      项目自带的 Markdown 渲染器对嵌套块引用的支持有限，扁平结构在预览与导出里都稳。
 */
const Cite = require('./cite.js');
const Bib = require('./bib.js');

function str(v) { return v == null ? '' : String(v).trim(); }
function oneLine(v) { return str(v).replace(/\s+/g, ' '); }

// 作者排序键：姓优先，没有姓用名；机构作者整串
function authorKey(it) {
  const list = (it && it.creators) || [];
  const c = list.find((x) => x && x.creatorType !== 'editor') || list[0];
  if (!c) return '';
  return str(c.lastName) || str(c.firstName) || str(c.name);
}

// 「Smith 等，2024」这种简短署名，用于小节标题
function shortAuthor(it) {
  const names = ((it && it.creators) || [])
    .filter((c) => c && c.creatorType !== 'editor')
    .map((c) => str(c.lastName) || str(c.firstName))
    .filter(Boolean);
  if (!names.length) return '佚名';
  return names.length > 1 ? names[0] + ' 等' : names[0];
}

function itemHeading(it) {
  const who = shortAuthor(it);
  const year = str(it.year);
  const title = oneLine(it.title) || '(无标题)';
  return (year ? who + '，' + year : who) + ' — ' + title;
}

function tagOf(anno) {
  const tags = (anno && anno.tags) || [];
  for (const t of tags) {
    const v = str(t);
    if (v) return v;
  }
  return '';
}

// 批注按「组 → 文献 → 页」排序；同一页内按 id 保证稳定
function cmpAnno(a, b) {
  const ka = authorKey(a.it), kb = authorKey(b.it);
  if (ka !== kb) return ka.localeCompare(kb, 'zh-Hans-CN');
  const ta = str(a.it.title), tb = str(b.it.title);
  if (ta !== tb) return ta.localeCompare(tb, 'zh-Hans-CN');
  const pa = Number(a.anno.page) || 0, pb = Number(b.anno.page) || 0;
  if (pa !== pb) return pa - pb;
  return str(a.anno.id).localeCompare(str(b.anno.id));
}

/*
 * build({
 *   items, annos, keys, groupBy, style, includeQuotes, includeComments, title
 * })
 *   items：库里未删除的条目（publicItem 或原始条目都行）
 *   annos：[{ id, itemKey, page, text, comment, tags }]
 *   keys：限定条目范围；不传表示全部
 *   groupBy：'tag' | 'item' | 'none'
 * 返回 { markdown, stats:{ annos, items, groups, cited, skipped } }
 */
function build(input) {
  const o = input || {};
  const style = str(o.style) || 'gbt7714';
  const groupBy = ['tag', 'item', 'none'].indexOf(o.groupBy) >= 0 ? o.groupBy : 'tag';
  const includeQuotes = o.includeQuotes !== false;
  const includeComments = o.includeComments !== false;
  // 语义：不传 keys（或传 null）= 全库；传数组（哪怕是空数组）= 明确的范围，
  // 空数组就是「一条都不要」。不能拿 length 判断——否则空收藏集、零匹配查询
  // 会被悄悄放大成全库，生成一份完全不相干的草稿。
  const scope = Array.isArray(o.keys) ? new Set(o.keys.map(str)) : null;

  const items = (Array.isArray(o.items) ? o.items : [])
    .filter((it) => it && it.key && !Number(it.deletedAt));
  const byKey = new Map(items.map((it) => [str(it.key), it]));

  const raw = Array.isArray(o.annos) ? o.annos : [];
  let skipped = 0;
  const usable = [];
  for (const a of raw) {
    if (!a) continue;
    const key = str(a.itemKey);
    const it = key ? byKey.get(key) : null;
    if (!it) { skipped++; continue; }               // 批注没挂到条目上，引不出来
    if (scope && !scope.has(key)) continue;          // 不在本次范围里
    const quote = oneLine(a.text);
    const comment = oneLine(a.comment);
    if (!(includeQuotes && quote) && !(includeComments && comment)) continue;
    usable.push({ anno: a, it, quote, comment });
  }

  const title = str(o.title) || ('综述草稿 · ' + new Date().toISOString().slice(0, 10));
  const lines = [];
  const citedKeys = [];
  const numOf = new Map();
  const numeric = Bib.isNumeric(style);
  let nextNum = 1;

  // 作者-年份制：先把整篇草稿涉及的文献算一遍消歧年份（与参考文献表同一套规则），
  // 正文引注直接带上，避免正文写 (Smith, 2024) 而文献表是 2024a / 2024b 对不上。
  const suffixItems = [];
  const seenForSuffix = new Set();
  for (const row of usable) {
    if (seenForSuffix.has(row.it.key)) continue;
    seenForSuffix.add(row.it.key);
    suffixItems.push(row.it);
  }
  const yearOf = Bib.disambiguatedYears(suffixItems, style);

  function citeOf(it, page) {
    if (!numOf.has(it.key)) {
      numOf.set(it.key, nextNum++);
      citedKeys.push(it.key);
    }
    const p = Number(page) || 0;
    return Cite.citeInText(it, {
      style,
      num: numOf.get(it.key),
      locator: p > 0 ? 'p. ' + p : '',
      year: yearOf.get(it.key) || '',
    });
  }

  // 分组
  const groups = new Map();
  for (const row of usable) {
    const g = groupBy === 'tag' ? (tagOf(row.anno) || '未标注主题')
      : groupBy === 'item' ? str(row.it.key)
        : '';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(row);
  }
  for (const list of groups.values()) list.sort(cmpAnno);

  let ordered = [...groups.entries()];
  if (groupBy === 'tag') {
    ordered.sort((a, b) => (b[1].length - a[1].length) || a[0].localeCompare(b[0], 'zh-Hans-CN'));
  } else if (groupBy === 'item') {
    ordered.sort((a, b) => cmpAnno(a[1][0], b[1][0]));
  }

  const itemCount = new Set(usable.map((r) => r.it.key)).size;

  lines.push('# ' + title, '');
  lines.push('> ' + new Date().toLocaleString('zh-CN', { hour12: false })
    + ' · ' + usable.length + ' 条批注 · ' + itemCount + ' 篇文献'
    + (numeric ? '' : ' · 按姓氏排序'), '');

  if (!usable.length) {
    lines.push('> 没有可用的批注。先在文献里做高亮、写批注，或调整范围与选项。', '');
    return {
      markdown: lines.join('\n'),
      stats: { annos: 0, items: 0, groups: 0, cited: 0, skipped },
    };
  }

  for (const [groupName, list] of ordered) {
    if (groupBy !== 'none' && groupName) {
      lines.push('## ' + (groupBy === 'item' ? itemHeading(list[0].it) : groupName), '');
    }
    let lastItem = '';
    for (const row of list) {
      // 同一篇文献在组内只出现一次小节标题，后面的批注接着排
      if (groupBy !== 'item' && row.it.key !== lastItem) {
        lines.push('### ' + itemHeading(row.it), '');
        lastItem = row.it.key;
      }
      if (includeQuotes && row.quote) {
        const q = row.quote.length > 400 ? row.quote.slice(0, 400) + '…' : row.quote;
        lines.push('> ' + q, '');
      }
      lines.push('*' + citeOf(row.it, row.anno.page) + '*');
      if (includeComments && row.comment) lines.push('', '评论：' + row.comment);
      if (groupBy !== 'tag') {
        const tags = (row.anno.tags || []).map(str).filter(Boolean);
        if (tags.length) lines.push('', '标签：' + tags.join('、'));
      }
      lines.push('');
    }
  }

  // 参考文献：编号制按出现顺序（与正文编号一致），作者-年份制按姓氏
  const citedItems = citedKeys.map((k) => byKey.get(k)).filter(Boolean);
  const refs = Bib.build(citedItems, {
    style,
    format: 'markdown',
    title: '参考文献',
    order: numeric ? 'entry' : 'auto',
  });
  if (refs && refs.text) lines.push(refs.text.trim(), '');

  return {
    markdown: lines.join('\n'),
    stats: {
      annos: usable.length,
      items: itemCount,
      groups: ordered.length,
      cited: refs ? refs.count : 0,
      skipped,
    },
  };
}

module.exports = { build, _internal: { authorKey, shortAuthor, itemHeading, tagOf } };
