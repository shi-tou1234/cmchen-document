'use strict';
/*
 * RSS / Atom 订阅源解析（Zotero Feeds 的本地化实现）。
 *
 * 纯字符串解析（项目约定不引 XML 库、Node 可测）：
 *   - RSS 2.0：<rss><channel><item><title>/<link>/<description>/<pubDate>
 *   - Atom：  <feed><entry><title>/<link href>/<summary|content>/<updated>
 *   - RDF (RSS 1.0)：按 RSS 2.0 的 item 分支兜底（结构相同）
 *
 * 口径：坏源不抛错——返回 { title:'', entries:[] }；单条缺标题跳过；
 * 条目上限 200（订阅源只做「发现新文章」，不做归档）。
 * UMD：Node 里 require 可测，浏览器里挂 window.FeedParse。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FeedParse = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const MAX_ENTRIES = 200;

  function decodeXml(t) {
    const s = String(t == null ? '' : t);
    return s
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(+n))
      .replace(/&amp;/g, '&');
  }
  function flat(v) { return decodeXml(v).replace(/\s+/g, ' ').trim(); }
  function stripTags(v) { return flat(String(v || '').replace(/<[^>]+>/g, ' ')); }

  function one(block, tag) {
    const m = new RegExp('<' + tag + '\\b[^>]*(?:\\/>|>([\\s\\S]*?)<\\/' + tag + '>)', 'i').exec(block);
    if (!m) return '';
    return flat(m[1] != null ? m[1] : '');
  }

  // 取属性值：XML 允许单引号或双引号（Atom 导出里两种都见得到），
  // 标签名可能带命名空间前缀（atom:link）。属性名按词边界匹配，避免 data-href 之类误命中。
  function attrOf(attrs, name) {
    const re = new RegExp('(?:^|\\s)' + name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')', 'i');
    const m = re.exec(attrs || '');
    if (!m) return '';
    return m[2] != null ? m[2] : (m[3] != null ? m[3] : '');
  }

  // Atom 的链接在 href 属性里，且可能有多个（alternate / self / enclosure）；
  // 优先 alternate / 无 rel，其次任意带 href 的链接（self / enclosure 兜底）。
  function atomLink(block) {
    let best = '';
    const re = /<(?:[\w.-]+:)?link\b([^>]*?)\/?>(?:<\/[\w.-]+:link>)?/gi;
    let m;
    while ((m = re.exec(block))) {
      const attrs = m[1] || '';
      const href = attrOf(attrs, 'href');
      if (!href) continue;
      const rel = attrOf(attrs, 'rel').toLowerCase();
      if (rel === 'alternate' || !rel) return flat(href);
      if (!best) best = flat(href);
    }
    return best;
  }

  // id 只当「非 URL 时的兜底」：urn:uuid / tag: 之类不是可访问地址，
  // 但保留它比留空更有助于去重与回溯。
  function isUrl(v) { return /^https?:\/\//i.test(String(v || '')); }

  function dateOf(v) {
    const s = flat(v);
    if (!s) return 0;
    const t = Date.parse(s);
    return isFinite(t) ? t : 0;
  }

  // RSS <item> / RDF <item> → 条目
  function rssItem(block) {
    const title = stripTags(one(block, 'title'));
    if (!title) return null;
    const link = flat(one(block, 'link')) || atomLink(block);
    const desc = stripTags(one(block, 'description') || one(block, 'content:encoded'));
    const authors = [];
    for (const a of allOf(block, 'author').concat(allOf(block, 'dc:creator'))) {
      const v = stripTags(a);
      if (v && !authors.includes(v)) authors.push(v);
    }
    return {
      title,
      url: link,
      summary: desc.slice(0, 500),
      date: dateOf(one(block, 'pubDate') || one(block, 'dc:date')),
      authors,
    };
  }

  // Atom <entry> → 条目
  function atomEntry(block) {
    const title = stripTags(one(block, 'title'));
    if (!title) return null;
    const authors = [];
    // 作者可能带 <name> 子标签，先按整块抓 author 再剥 name
    for (const ab of allOf(block, 'author')) {
      const name = one(ab, 'name') || stripTags(ab);
      if (name && !authors.includes(name)) authors.push(name);
    }
    const id = flat(one(block, 'id'));
    const href = atomLink(block);
    return {
      title,
      url: href || id,
      id,                        // 原始 id：可能不是可访问地址（urn:uuid / tag:），调用方自行区分
      hasLink: !!href,
      summary: stripTags(one(block, 'summary') || one(block, 'content')).slice(0, 500),
      date: dateOf(one(block, 'updated') || one(block, 'published')),
      authors,
    };
  }

  function allOf(block, tag) {
    const out = [];
    const re = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'gi');
    let m;
    while ((m = re.exec(block))) out.push(m[1]);
    return out;
  }

  // 命名空间前缀（atom:feed / atom:entry / atom:title）在合法 Atom 源里很常见。
  // 统一剥掉前缀再走同一套标签查找，比给每个标签都写一遍可选前缀稳。
  function stripNs(xml) {
    return String(xml || '').replace(/<(\/?)([A-Za-z_][\w.-]*):([A-Za-z_][\w.-]*)/g, '<$1$3');
  }

  // 解析订阅源文本。返回 { kind, title, link, entries }
  function parseFeed(text) {
    const raw = String(text == null ? '' : text);
    const kind = /<(?:[\w.-]+:)?feed[\s>]/i.test(raw) && !/<rss[\s>]/i.test(raw) ? 'atom'
      : (/<rss[\s>]/i.test(raw) ? 'rss' : (/<rdf:RDF[\s>]/i.test(raw) ? 'rdf' : ''));
    // Atom 才剥前缀：RSS 里的 <atom:link> 是自闭合的自我引用，不能被当成 <link> 正文
    const xml = kind === 'atom' ? stripNs(raw) : raw;

    // 频道/源标题：channel>title（RSS/RDF）或 feed>title（Atom）
    let head = /<channel\b[\s\S]*?<\/channel>/i.exec(xml);
    let headBlock = head ? head[0] : '';
    if (!headBlock && kind === 'atom') {
      // Atom 没有外层包裹，feed>title 会和 entry>title 混在一起：
      // 先摘掉所有 entry 再找 title
      headBlock = xml.replace(/<entry\b[\s\S]*?<\/entry>/gi, '');
    }
    if (!headBlock && kind === 'rdf') {
      headBlock = xml.replace(/<item\b[\s\S]*?<\/item>/gi, '');
    }
    const title = stripTags(one(headBlock, 'title'));
    const link = kind === 'atom' ? atomLink(headBlock) : flat(one(headBlock, 'link'));

    const blocks = kind === 'atom'
      ? (xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || [])
      : (xml.match(/<item\b[\s\S]*?<\/item>/gi) || []);
    const entries = [];
    for (const b of blocks) {
      const e = kind === 'atom' ? atomEntry(b) : rssItem(b);
      if (e && !entries.some((x) => x.title === e.title && x.url === e.url)) entries.push(e);
      if (entries.length >= MAX_ENTRIES) break;
    }
    return { kind, title, link, entries };
  }

  // 条目 → 文献库记录（webpage 条目，url 去重靠调用方）
  function entryToRecord(entry, feedTitle) {
    const e = entry || {};
    const authors = (e.authors || []).map((n) => {
      // 环境里没有 Creators（渲染进程有），这里只做最朴素的拆分
      const parts = String(n || '').split(',').map((x) => x.trim());
      return parts.length === 2
        ? { lastName: parts[0], firstName: parts[1], creatorType: 'author' }
        : { lastName: n, firstName: '', creatorType: 'author' };
    });
    return {
      itemType: 'webpage',
      title: String(e.title || '未命名条目'),
      creators: authors,
      year: e.date ? String(new Date(e.date).getFullYear()) : '',
      url: String(e.url || ''),
      abstract: String(e.summary || ''),
      publication: String(feedTitle || ''),
      tags: [],
      fields: {},
    };
  }

  return { parseFeed, entryToRecord, _decodeXml: decodeXml };
});
