'use strict';
/*
 * 文档格式转换（v27）。
 *
 * 目标：阅读器不再只认 PDF。主进程把常见文档转成「安全 HTML」，渲染层用富文档模式显示；
 * PDF 仍然走 PDF.js，不经过这里。
 *
 * 设计约束：
 * - 纯 JS、零原生模块（Electron 31 内置 Node 20）。
 * - 所有转换结果统一经过 sanitize-html，脚本 / 事件属性 / 危险 URL 一律丢弃。
 * - 图片统一内联成 data URL，符合 index.html 的 CSP（img-src 'self' data:）。
 * - 不修改、不复制用户原文件；转换只在内存里发生。
 * - 单文档有大小/页数上限，避免一个超大表格或幻灯片把 IPC 撑爆。
 */
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const sanitizeHtml = require('sanitize-html');
const iconv = require('iconv-lite');

const MAX_PAGES = 400;
const MAX_HTML_PER_PAGE = 4 * 1024 * 1024;
const MAX_HTML_TOTAL = 12 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_CHARS = 4 * 1024 * 1024;
const MAX_SHEET_ROWS = 2000;
const MAX_SHEET_COLS = 80;

const EXT_LABELS = {
  pdf: 'PDF',
  docx: 'Word 文档', doc: 'Word 97-2003 文档', rtf: 'RTF 文档', odt: 'OpenDocument 文本',
  pptx: 'PowerPoint 演示文稿', odp: 'OpenDocument 演示文稿',
  xlsx: 'Excel 工作簿', xls: 'Excel 97-2003 工作簿', ods: 'OpenDocument 表格', csv: 'CSV 表格',
  md: 'Markdown', markdown: 'Markdown', html: '网页', htm: '网页',
  epub: 'EPUB 电子书',
  png: '图片', jpg: '图片', jpeg: '图片', gif: '图片', webp: '图片', bmp: '图片', svg: '图片', avif: '图片',
  txt: '文本', log: '日志', json: 'JSON', xml: 'XML', yaml: 'YAML', yml: 'YAML',
  ini: '配置', toml: '配置', cfg: '配置', conf: '配置', properties: '配置',
  js: '代码', ts: '代码', jsx: '代码', tsx: '代码', css: '代码', scss: '代码', less: '代码',
  py: '代码', java: '代码', c: '代码', h: '代码', cpp: '代码', hpp: '代码', cs: '代码',
  go: '代码', rs: '代码', rb: '代码', php: '代码', sh: '脚本', bat: '脚本', ps1: '脚本',
  sql: 'SQL', tex: 'LaTeX', r: '代码', swift: '代码', kt: '代码', gradle: '配置',
  srt: '字幕', vtt: '字幕',
};

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif']);
const PLAIN_EXTS = new Set([
  'txt', 'log', 'json', 'xml', 'yaml', 'yml', 'ini', 'toml', 'cfg', 'conf', 'properties',
  'js', 'ts', 'jsx', 'tsx', 'css', 'scss', 'less', 'py', 'java', 'c', 'h', 'cpp', 'hpp',
  'cs', 'go', 'rs', 'rb', 'php', 'sh', 'bat', 'ps1', 'sql', 'tex', 'r', 'swift', 'kt',
  'gradle', 'srt', 'vtt',
]);
const ZIP_EXTS = new Set(['docx', 'pptx', 'xlsx', 'odt', 'odp', 'ods', 'epub']);
const SUPPORTED_EXTS = new Set([
  'pdf', 'docx', 'doc', 'rtf', 'odt', 'pptx', 'ppt', 'odp', 'xlsx', 'xls', 'ods', 'csv',
  'md', 'markdown', 'html', 'htm', 'epub', ...IMAGE_EXTS, ...PLAIN_EXTS,
]);

const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', avif: 'image/avif',
};

function extOf(p) {
  return String(path.extname(p || '')).replace(/^\./, '').toLowerCase();
}
function isSupported(p) {
  return SUPPORTED_EXTS.has(extOf(p));
}
function labelFor(p) {
  return EXT_LABELS[extOf(p)] || '文档';
}
function titleFromPath(p) {
  const base = path.basename(String(p || '')).replace(/\.[A-Za-z0-9]{1,8}$/, '');
  return base.replace(/^[\s\-_0-9]+/, '').replace(/_+/g, ' ').trim() || base;
}

// ---------- 通用工具 ----------
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function decodeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

function parseAttrs(tag) {
  const out = {};
  const re = /([A-Za-z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(tag))) out[m[1]] = decodeXml(m[3] != null ? m[3] : m[4]);
  return out;
}

// 读文本：先按 BOM / UTF-8 判断，坏了再按 GB18030 兜底（中文 CSV/TXT 很常见）
function readTextBuffer(buf) {
  if (!buf || !buf.length) return '';
  if (buf[0] === 0xFF && buf[1] === 0xFE) return buf.slice(2).toString('utf16le');
  if (buf[0] === 0xFE && buf[1] === 0xFF) {
    const swapped = Buffer.from(buf.slice(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return buf.slice(3).toString('utf8');
  const utf8 = buf.toString('utf8');
  if (utf8.indexOf('\uFFFD') < 0) return utf8;
  try { return iconv.decode(buf, 'gb18030'); } catch (_) { return utf8; }
}

const SANITIZE_OPTS = {
  allowedTags: [
    'a', 'abbr', 'article', 'aside', 'b', 'blockquote', 'br', 'caption', 'cite', 'code',
    'col', 'colgroup', 'dd', 'del', 'details', 'dfn', 'div', 'dl', 'dt', 'em', 'figcaption',
    'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'i', 'img',
    'ins', 'kbd', 'li', 'main', 'mark', 'nav', 'ol', 'p', 'pre', 'q', 's', 'section',
    'small', 'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot',
    'th', 'thead', 'time', 'tr', 'u', 'ul',
  ],
  allowedAttributes: {
    a: ['href', 'title', 'name', 'id'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    th: ['colspan', 'rowspan', 'align'],
    td: ['colspan', 'rowspan', 'align'],
    col: ['span'],
    colgroup: ['span'],
    '*': ['id', 'class', 'title', 'lang', 'dir'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['data'] },
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'iframe', 'object', 'embed'],
};

function clean(html) {
  return sanitizeHtml(String(html == null ? '' : html), SANITIZE_OPTS);
}

function htmlToText(html) {
  const withBreaks = String(html == null ? '' : html)
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|table|blockquote|pre)\s*>/gi, '\n');
  return sanitizeHtml(withBreaks, { allowedTags: [], allowedAttributes: {}, disallowedTagsMode: 'discard' })
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function dataUrl(buf, ext) {
  const mime = MIME_BY_EXT[ext] || 'application/octet-stream';
  return 'data:' + mime + ';base64,' + buf.toString('base64');
}

// 把 Markdown / HTML / EPUB 里指向磁盘的相对图片内联成 data URL。
// 只允许指向文档所在目录内部的路径，防止构造 ../.. 读取任意文件。
function inlineLocalImages(html, baseDir) {
  if (!html || !baseDir) return html;
  return String(html).replace(/(<img\b[^>]*?\bsrc\s*=\s*)(["'])(.*?)\2/gi, (all, head, quote, src) => {
    const s = String(src || '').trim();
    if (!s || /^(data:|https?:|mailto:|#|\/\/)/i.test(s)) return all;
    let rel;
    try { rel = decodeURIComponent(s.split(/[?#]/)[0]); } catch (_) { rel = s.split(/[?#]/)[0]; }
    if (!rel) return all;
    const abs = path.resolve(baseDir, rel);
    const root = path.resolve(baseDir) + path.sep;
    if (abs !== path.resolve(baseDir) && !abs.startsWith(root)) return all;
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > MAX_IMAGE_BYTES) return all;
      return head + quote + dataUrl(fs.readFileSync(abs), extOf(abs)) + quote;
    } catch (_) { return all; }
  });
}

// 页数与总大小双上限：宁可截断，也不让主进程/渲染进程被一个巨型文档拖死
function capPages(pages) {
  const out = [];
  let total = 0;
  for (let i = 0; i < pages.length && out.length < MAX_PAGES; i++) {
    const p = pages[i] || {};
    let html = String(p.html == null ? '' : p.html);
    if (html.length > MAX_HTML_PER_PAGE) {
      html = html.slice(0, MAX_HTML_PER_PAGE) + '<p class="doc-truncated">（本页内容过长，已截断）</p>';
    }
    if (total + html.length > MAX_HTML_TOTAL) {
      out.push({ title: '提示', html: '<p class="doc-truncated">（文档内容超过显示上限，后续内容已省略）</p>', text: '' });
      break;
    }
    total += html.length;
    out.push({ title: String(p.title || ''), html, text: p.text != null ? String(p.text) : htmlToText(html) });
  }
  if (!out.length) out.push({ title: '空文档', html: '<p class="doc-empty">这个文档没有可显示的内容。</p>', text: '' });
  return out;
}

function textPages(items) {
  return capPages((items || []).map((x, i) => ({
    title: x.title || ('第 ' + (i + 1) + ' 页'),
    html: '<pre class="doc-plain">' + escapeHtml(x.text || '') + '</pre>',
    text: x.text || '',
  })));
}

// ---------- OOXML / ODF 元数据 ----------
async function readZipCoreMeta(filePath) {
  const ext = extOf(filePath);
  if (!ZIP_EXTS.has(ext)) return { title: '', author: '' };
  try {
    const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
    let core = null;
    for (const name of ['docProps/core.xml', 'meta.xml']) {
      const f = zip.file(name);
      if (f) { core = await f.async('string'); break; }
    }
    if (!core) return { title: '', author: '' };
    const pick = (tag) => {
      const m = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + tag + '>', 'i').exec(core);
      return m ? decodeXml(m[1]).replace(/\s+/g, ' ').trim() : '';
    };
    return { title: pick('dc:title'), author: pick('dc:creator') };
  } catch (_) { return { title: '', author: '' }; }
}

// ---------- 各格式转换 ----------
async function convertDocx(buf) {
  const mammoth = require('mammoth');
  const res = await mammoth.convertToHtml({ buffer: buf });
  const html = clean(res.value || '');
  const text = htmlToText(html);
  return capPages([{ title: '正文', html, text }]);
}

async function convertDoc(buf) {
  const WordExtractor = require('word-extractor');
  const extractor = new WordExtractor();
  const doc = await extractor.extract(buf);
  const text = String(doc.getBody() || '').replace(/\r\n/g, '\n').trim();
  return textPages([{ title: '正文', text }]);
}

async function convertRtf(buf) {
  const rtfToHtml = require('@iarna/rtf-to-html');
  const html = await new Promise((resolve, reject) => {
    rtfToHtml.fromString(readTextBuffer(buf), (err, out) => (err ? reject(err) : resolve(out)));
  });
  const safe = clean(html);
  return capPages([{ title: '正文', html: safe, text: htmlToText(safe) }]);
}

function convertXlsx(buf, ext) {
  const XLSX = require('xlsx');
  let wb;
  if (ext === 'csv') wb = XLSX.read(readTextBuffer(buf), { type: 'string', raw: false });
  else wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
  const pages = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    let rows = [];
    try {
      rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '', blankrows: false });
    } catch (_) { rows = []; }
    const clipped = rows.slice(0, MAX_SHEET_ROWS).map((r) => (Array.isArray(r) ? r.slice(0, MAX_SHEET_COLS) : []));
    const truncated = rows.length > MAX_SHEET_ROWS;
    const table = ['<table class="doc-sheet"><tbody>'];
    clipped.forEach((row, ri) => {
      const tag = ri === 0 ? 'th' : 'td';
      table.push('<tr>' + row.map((cell) => '<' + tag + '>' +
        escapeHtml(cell == null ? '' : String(cell)).replace(/\n/g, '<br>') + '</' + tag + '>').join('') + '</tr>');
    });
    table.push('</tbody></table>');
    if (truncated) table.push('<p class="doc-truncated">（表格超过 ' + MAX_SHEET_ROWS + ' 行，已截断）</p>');
    if (!clipped.length) table.push('<p class="doc-empty">（空工作表）</p>');
    const html = clean('<h2>' + escapeHtml(name) + '</h2>' + table.join(''));
    const text = clipped.map((r) => r.map((c) => String(c == null ? '' : c)).join('\t')).join('\n');
    pages.push({ title: name, html, text });
  }
  return capPages(pages);
}

function slideNumber(name) {
  const m = /(\d+)\.xml$/.exec(name);
  return m ? parseInt(m[1], 10) : 0;
}

async function convertPptx(buf) {
  const zip = await JSZip.loadAsync(buf);
  const names = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
  names.sort((a, b) => slideNumber(a) - slideNumber(b));
  if (!names.length) throw new Error('这个 PPTX 里没有找到幻灯片');
  const mediaCache = new Map();
  let mediaBytes = 0;
  const pages = [];

  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const xml = await zip.file(name).async('string');
    const lines = [];
    const pRe = /<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/g;
    let pm;
    while ((pm = pRe.exec(xml))) {
      const runs = [];
      const tRe = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g;
      let tm;
      while ((tm = tRe.exec(pm[1]))) runs.push(decodeXml(tm[1]));
      const line = runs.join('').replace(/\s+/g, ' ').trim();
      if (line) lines.push(line);
    }
    if (!lines.length) {
      const tRe = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g;
      let tm;
      while ((tm = tRe.exec(xml))) {
        const line = decodeXml(tm[1]).replace(/\s+/g, ' ').trim();
        if (line) lines.push(line);
      }
    }

    // 该页引用的图片（ppt/slides/_rels/slideN.xml.rels → ../media/xxx）
    const imgs = [];
    try {
      const relFile = zip.file('ppt/slides/_rels/slide' + (i + 1) + '.xml.rels');
      const relXml = relFile ? await relFile.async('string') : '';
      const rels = {};
      const rRe = /<Relationship\b[^>]*>/g;
      let rm;
      while ((rm = rRe.exec(relXml))) {
        const a = parseAttrs(rm[0]);
        if (a.Id && a.Target) rels[a.Id] = a.Target;
      }
      const seen = new Set();
      const bRe = /<a:blip\b[^>]*r:embed="([^"]+)"/g;
      let bm;
      while ((bm = bRe.exec(xml))) {
        const target = rels[bm[1]];
        if (!target || seen.has(target)) continue;
        seen.add(target);
        if (/^https?:/i.test(target)) continue;
        const mediaPath = path.posix.normalize(path.posix.join('ppt/slides', target));
        if (!zip.file(mediaPath) || mediaBytes >= 32 * 1024 * 1024) continue;
        let du = mediaCache.get(mediaPath);
        if (!du) {
          const mb = await zip.file(mediaPath).async('nodebuffer');
          if (mb.length > MAX_IMAGE_BYTES) continue;
          mediaBytes += mb.length;
          du = dataUrl(mb, extOf(mediaPath));
          mediaCache.set(mediaPath, du);
        }
        imgs.push(du);
      }
    } catch (_) { /* 图片缺失不影响文字阅读 */ }

    const title = (lines[0] || ('幻灯片 ' + (i + 1))).slice(0, 120);
    const body = lines.map((ln, idx) => idx === 0
      ? '<h2>' + escapeHtml(ln) + '</h2>'
      : '<p>' + escapeHtml(ln) + '</p>').join('');
    const figs = imgs.map((src) => '<figure><img src="' + src + '" alt="幻灯片插图"></figure>').join('');
    const html = clean('<section class="doc-slide">' + body + figs + '</section>');
    pages.push({ title, html, text: lines.join('\n') });
  }
  return capPages(pages);
}

function odfToHtml(xml) {
  let s = String(xml || '');
  s = s.replace(/<office:(automatic-styles|font-face-decls|scripts)[\s\S]*?<\/office:\1>/gi, '');
  s = s.replace(/<table:table\b[^>]*>/gi, '<table>').replace(/<\/table:table>/gi, '</table>');
  s = s.replace(/<table:table-row\b[^>]*>/gi, '<tr>').replace(/<\/table:table-row>/gi, '</tr>');
  s = s.replace(/<table:table-header-rows\b[^>]*>/gi, '<thead>').replace(/<\/table:table-header-rows>/gi, '</thead>');
  s = s.replace(/<table:table-row-group\b[^>]*>/gi, '<tbody>').replace(/<\/table:table-row-group>/gi, '</tbody>');
  s = s.replace(/<table:table-cell\b[^>]*>/gi, '<td>').replace(/<\/table:table-cell>/gi, '</td>');
  s = s.replace(/<table:covered-table-cell\b[^>]*\/?>/gi, '<td></td>');
  // 标题：先按 outline-level 成对替换，再兜底剩下没有级别的 text:h
  s = s.replace(/<text:h\b[^>]*outline-level="(\d)"[^>]*>([\s\S]*?)<\/text:h>/gi, (_, n, inner) => {
    const lv = Math.min(6, Math.max(1, +n));
    return '<h' + lv + '>' + inner + '</h' + lv + '>';
  });
  s = s.replace(/<text:h\b[^>]*>([\s\S]*?)<\/text:h>/gi, '<h2>$1</h2>');
  s = s.replace(/<text:p\b[^>]*>/gi, '<p>').replace(/<\/text:p>/gi, '</p>');
  s = s.replace(/<text:list\b[^>]*>/gi, '<ul>').replace(/<\/text:list>/gi, '</ul>');
  s = s.replace(/<text:list-item\b[^>]*>/gi, '<li>').replace(/<\/text:list-item>/gi, '</li>');
  s = s.replace(/<text:span\b[^>]*>/gi, '<span>').replace(/<\/text:span>/gi, '</span>');
  s = s.replace(/<text:line-break\s*\/>/gi, '<br>');
  s = s.replace(/<text:tab\s*\/>/gi, '\t');
  s = s.replace(/<text:s\b[^>]*\/>/gi, ' ');
  s = s.replace(/<text:a\b([^>]*)>/gi, (all, attrs) => {
    const a = parseAttrs(attrs);
    const href = a['xlink:href'] || a.href || '';
    return href ? '<a href="' + escapeHtml(href) + '">' : '<a>';
  }).replace(/<\/text:a>/gi, '</a>');
  s = s.replace(/<(draw|office|style|number|fo|svg|meta|config|presentation|anim):[^>]*\/?>/gi, '');
  s = s.replace(/<\/?(draw|office|style|number|fo|svg|meta|config|presentation|anim):[^>]*>/gi, '');
  return s;
}

async function convertOdf(buf, ext) {
  const zip = await JSZip.loadAsync(buf);
  const f = zip.file('content.xml');
  if (!f) throw new Error('这个 OpenDocument 文件缺少 content.xml');
  let xml = await f.async('string');
  const bodyM = /<office:body[^>]*>([\s\S]*?)<\/office:body>/i.exec(xml);
  if (bodyM) xml = bodyM[1];
  if (ext === 'odp') {
    const pages = [];
    const parts = xml.split(/(?=<draw:page\b)/i).filter((x) => /<draw:page\b/i.test(x));
    parts.forEach((part, i) => {
      const html = clean(odfToHtml(part));
      const text = htmlToText(html);
      const first = text.split('\n').map((x) => x.trim()).filter(Boolean)[0] || ('幻灯片 ' + (i + 1));
      pages.push({ title: first.slice(0, 120), html, text });
    });
    return capPages(pages);
  }
  const html = clean(odfToHtml(xml));
  // ODT 没有固定页：按一级标题切章，找不到就整篇一页
  const parts = html.split(/(?=<h1[ >])/i).filter((x) => x.trim());
  if (parts.length > 1) {
    const pages = parts.map((part, i) => {
      const text = htmlToText(part);
      return { title: (text.split('\n')[0] || ('第 ' + (i + 1) + ' 节')).slice(0, 120), html: part, text };
    });
    return capPages(pages);
  }
  return capPages([{ title: '正文', html, text: htmlToText(html) }]);
}

async function readZipText(zip, name) {
  const f = zip.file(name);
  return f ? f.async('string') : '';
}

async function convertEpub(buf) {
  const zip = await JSZip.loadAsync(buf);
  const container = await readZipText(zip, 'META-INF/container.xml');
  let opfPath = '';
  const rootM = /<rootfile\b[^>]*>/.exec(container);
  if (rootM) opfPath = parseAttrs(rootM[0])['full-path'] || '';
  if (!opfPath) {
    const found = Object.keys(zip.files).find((f) => /\.opf$/i.test(f));
    if (found) opfPath = found;
  }
  if (!opfPath) throw new Error('这个 EPUB 缺少 OPF 清单');
  const opf = await readZipText(zip, opfPath);
  const opfDir = path.posix.dirname(opfPath);

  const manifest = {};
  const itemRe = /<item\b[^>]*>/g;
  let im;
  while ((im = itemRe.exec(opf))) {
    const a = parseAttrs(im[0]);
    if (a.id && a.href) manifest[a.id] = { href: a.href, type: a['media-type'] || '' };
  }
  const spine = [];
  const refRe = /<itemref\b[^>]*>/g;
  let rm;
  while ((rm = refRe.exec(opf))) {
    const id = parseAttrs(rm[0]).idref;
    if (id && manifest[id]) spine.push(manifest[id]);
  }
  let docs = spine;
  if (!docs.length) {
    docs = Object.keys(zip.files)
      .filter((f) => /\.(x?html?|htm)$/i.test(f))
      .sort()
      .map((f) => ({ href: path.posix.relative(opfDir, f) || f, type: 'application/xhtml+xml' }));
  }

  const pages = [];
  for (let i = 0; i < docs.length && pages.length < MAX_PAGES; i++) {
    const href = String(docs[i].href || '').split('#')[0];
    if (!href) continue;
    const file = path.posix.normalize(path.posix.join(opfDir, href));
    const raw = await readZipText(zip, file);
    if (!raw) continue;
    const bodyM = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(raw);
    let inner = bodyM ? bodyM[1] : raw;
    inner = inlineZipImages(inner, zip, path.posix.dirname(file));
    const html = clean(inner);
    const text = htmlToText(html);
    if (!text && !/<img\b/i.test(html)) continue;
    let title = '';
    const hM = /<h[1-2]\b[^>]*>([\s\S]*?)<\/h[1-2]>/i.exec(inner);
    if (hM) title = htmlToText(hM[1]);
    if (!title) title = (text.split('\n').map((x) => x.trim()).filter(Boolean)[0] || ('第 ' + (i + 1) + ' 章')).slice(0, 120);
    pages.push({ title, html, text });
  }
  if (!pages.length) throw new Error('这个 EPUB 没有可显示的正文章节');
  return capPages(pages);
}

// EPUB 内部图片：路径相对当前章节，读 zip 并内联
function inlineZipImages(html, zip, baseDir) {
  return String(html).replace(/(<img\b[^>]*?\bsrc\s*=\s*)(["'])(.*?)\2/gi, (all, head, quote, src) => {
    const s = String(src || '').trim();
    if (!s || /^(data:|https?:|#|\/\/)/i.test(s)) return all;
    let rel;
    try { rel = decodeURIComponent(s.split(/[?#]/)[0]); } catch (_) { rel = s.split(/[?#]/)[0]; }
    const file = path.posix.normalize(path.posix.join(baseDir, rel));
    if (!zip.file(file)) return all;
    return head + quote + '__EPUBIMG:' + file + quote;
  });
}

// 上面的占位符在异步阶段替换（正则回调不能 await）
async function materializeEpubImages(html, zip) {
  const re = /__EPUBIMG:([^"']+)/g;
  const seen = {};
  let m;
  while ((m = re.exec(html))) seen[m[1]] = true;
  for (const file of Object.keys(seen)) {
    try {
      const b = await zip.file(file).async('nodebuffer');
      if (b.length <= MAX_IMAGE_BYTES) {
        html = html.split('__EPUBIMG:' + file).join(dataUrl(b, extOf(file)));
      }
    } catch (_) {}
  }
  return html;
}

async function convertMarkdown(buf, filePath) {
  const marked = require('marked');
  const src = readTextBuffer(buf);
  let html = marked.parse(src, { gfm: true, breaks: false, headerIds: false, mangle: false });
  html = inlineLocalImages(html, path.dirname(filePath));
  html = clean(html);
  const parts = html.split(/(?=<h1[ >])/i).filter((x) => x.trim());
  if (parts.length > 1) {
    const pages = parts.map((part, i) => {
      const text = htmlToText(part);
      return { title: (text.split('\n')[0] || ('第 ' + (i + 1) + ' 节')).slice(0, 120), html: part, text };
    });
    return capPages(pages);
  }
  return capPages([{ title: '正文', html, text: htmlToText(html) }]);
}

function convertHtml(buf, filePath) {
  const raw = readTextBuffer(buf);
  const titleM = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw);
  const title = titleM ? decodeXml(titleM[1]).replace(/\s+/g, ' ').trim() : '';
  const bodyM = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(raw);
  let inner = bodyM ? bodyM[1] : raw;
  inner = inlineLocalImages(inner, path.dirname(filePath));
  inner = clean(inner);
  return capPages([{ title: title || '正文', html: inner, text: htmlToText(inner) }]);
}

function convertPlain(buf, ext) {
  let text = readTextBuffer(buf);
  if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS) + '\n\n（内容过长，已截断）';
  if (ext === 'json') {
    try { text = JSON.stringify(JSON.parse(text), null, 2); } catch (_) {}
  }
  const pages = textPages([{ title: labelFor('x.' + ext) || '文本', text }]);
  return pages;
}

function convertImage(buf, ext, fileName) {
  if (buf.length > MAX_IMAGE_BYTES) {
    return capPages([{ title: fileName, html: '<p class="doc-truncated">图片超过 8 MB，暂不预览。</p>', text: '' }]);
  }
  const html = '<figure class="doc-image"><img src="' + dataUrl(buf, ext) + '" alt="' + escapeHtml(fileName) + '"></figure>';
  return capPages([{ title: fileName, html, text: '' }]);
}

// ---------- 对外主入口 ----------
async function readDocument(filePath, opts) {
  const o = opts || {};
  const abs = path.resolve(String(filePath || ''));
  const ext = extOf(abs);
  if (!SUPPORTED_EXTS.has(ext)) {
    return { ok: false, filePath: abs, error: '暂不支持 .' + ext + ' 格式' };
  }
  if (ext === 'pdf') {
    // PDF 仍由主进程读字节、渲染层走 PDF.js，这里只做统一分派
    return { ok: true, kind: 'pdf', filePath: abs, fileName: path.basename(abs), ext };
  }
  const st = fs.statSync(abs);
  if (!st.isFile()) return { ok: false, filePath: abs, error: '不是文件' };
  const buf = fs.readFileSync(abs);
  let pages;
  if (ext === 'docx') pages = await convertDocx(buf);
  else if (ext === 'doc') pages = await convertDoc(buf);
  else if (ext === 'rtf') pages = await convertRtf(buf);
  else if (ext === 'xlsx' || ext === 'xls' || ext === 'ods' || ext === 'csv') pages = convertXlsx(buf, ext);
  else if (ext === 'pptx') pages = await convertPptx(buf);
  else if (ext === 'odt' || ext === 'odp') pages = await convertOdf(buf, ext);
  else if (ext === 'epub') {
    // EPUB 图片占位符需要异步替换，转换函数内部已拆成两步
    pages = await convertEpubAsync(buf);
  } else if (ext === 'md' || ext === 'markdown') pages = await convertMarkdown(buf, abs);
  else if (ext === 'html' || ext === 'htm') pages = convertHtml(buf, abs);
  else if (IMAGE_EXTS.has(ext)) pages = convertImage(buf, ext, path.basename(abs));
  else if (PLAIN_EXTS.has(ext)) pages = convertPlain(buf, ext);
  else if (ext === 'ppt') {
    return {
      ok: false, filePath: abs,
      error: '旧版 .ppt 二进制格式暂不支持，请用 PowerPoint / WPS 另存为 .pptx 后再打开。',
    };
  } else {
    return { ok: false, filePath: abs, error: '暂不支持 .' + ext + ' 格式' };
  }
  const startPage = Math.min(pages.length, Math.max(1, Math.floor(+o.startPage || 1)));
  return {
    ok: true, kind: 'rich', filePath: abs, fileName: path.basename(abs),
    ext, format: labelFor(abs), pages, startPage,
    title: titleFromPath(abs),
  };
}

// EPUB 的图片占位符替换需要 zip 句柄，包一层保持 readDocument 简洁
async function convertEpubAsync(buf) {
  const zip = await JSZip.loadAsync(buf);
  const pages = await convertEpub(buf);
  for (const p of pages) p.html = await materializeEpubImages(p.html, zip);
  return pages;
}

// 全文索引用：只抽文本，不生成 HTML（比完整转换省内存）。
// 返回结构与 PDF 抽取保持一致：{ pages:[{page,text}], chars, numPages }
async function extractText(filePath) {
  const abs = path.resolve(String(filePath || ''));
  const ext = extOf(abs);
  const buf = fs.readFileSync(abs);
  let items = [];
  if (ext === 'docx') {
    const mammoth = require('mammoth');
    const r = await mammoth.extractRawText({ buffer: buf });
    items = [{ title: '正文', text: r.value || '' }];
  } else if (ext === 'doc') {
    const WordExtractor = require('word-extractor');
    const doc = await new WordExtractor().extract(buf);
    items = [{ title: '正文', text: doc.getBody() || '' }];
  } else if (ext === 'pptx') {
    const zip = await JSZip.loadAsync(buf);
    const names = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
    names.sort((a, b) => slideNumber(a) - slideNumber(b));
    for (let i = 0; i < names.length; i++) {
      const xml = await zip.file(names[i]).async('string');
      const lines = [];
      const pRe = /<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/g;
      let pm;
      while ((pm = pRe.exec(xml))) {
        const runs = [];
        const tRe = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g;
        let tm;
        while ((tm = tRe.exec(pm[1]))) runs.push(decodeXml(tm[1]));
        const line = runs.join('').trim();
        if (line) lines.push(line);
      }
      items.push({ title: '幻灯片 ' + (i + 1), text: lines.join('\n') });
    }
  } else if (ext === 'xlsx' || ext === 'xls' || ext === 'ods' || ext === 'csv') {
    const XLSX = require('xlsx');
    const wb = ext === 'csv' ? XLSX.read(readTextBuffer(buf), { type: 'string' }) : XLSX.read(buf, { type: 'buffer' });
    for (const name of wb.SheetNames) {
      let csv = '';
      try { csv = XLSX.utils.sheet_to_csv(wb.Sheets[name], { blankrows: false }); } catch (_) {}
      items.push({ title: name, text: csv });
    }
  } else if (ext === 'odt' || ext === 'odp') {
    const zip = await JSZip.loadAsync(buf);
    const xml = await readZipText(zip, 'content.xml');
    const html = clean(odfToHtml(xml));
    const text = htmlToText(html);
    if (ext === 'odp') {
      const parts = String(xml).split(/(?=<draw:page\b)/i).filter((x) => /<draw:page\b/i.test(x));
      items = parts.map((part, i) => ({ title: '幻灯片 ' + (i + 1), text: htmlToText(clean(odfToHtml(part))) }));
    } else items = [{ title: '正文', text }];
  } else if (ext === 'epub') {
    const zip = await JSZip.loadAsync(buf);
    const container = await readZipText(zip, 'META-INF/container.xml');
    let opfPath = '';
    const rootM = /<rootfile\b[^>]*>/.exec(container);
    if (rootM) opfPath = parseAttrs(rootM[0])['full-path'] || '';
    if (!opfPath) {
      const found = Object.keys(zip.files).find((f) => /\.opf$/i.test(f));
      if (found) opfPath = found;
    }
    if (!opfPath) throw new Error('EPUB 缺少 OPF');
    const opf = await readZipText(zip, opfPath);
    const opfDir = path.posix.dirname(opfPath);
    const manifest = {};
    const itemRe = /<item\b[^>]*>/g;
    let im;
    while ((im = itemRe.exec(opf))) {
      const a = parseAttrs(im[0]);
      if (a.id && a.href) manifest[a.id] = a.href;
    }
    const files = [];
    const refRe = /<itemref\b[^>]*>/g;
    let rm;
    while ((rm = refRe.exec(opf))) {
      const id = parseAttrs(rm[0]).idref;
      if (id && manifest[id]) files.push(path.posix.normalize(path.posix.join(opfDir, manifest[id].split('#')[0])));
    }
    if (!files.length) files.push(...Object.keys(zip.files).filter((f) => /\.x?html?$/i.test(f)).sort());
    for (let i = 0; i < files.length; i++) {
      const raw = await readZipText(zip, files[i]);
      if (!raw) continue;
      const bodyM = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(raw);
      const text = htmlToText(clean(bodyM ? bodyM[1] : raw));
      if (text) items.push({ title: '第 ' + (i + 1) + ' 章', text });
    }
  } else if (ext === 'md' || ext === 'markdown') {
    const marked = require('marked');
    const html = marked.parse(readTextBuffer(buf), { gfm: true, headerIds: false, mangle: false });
    items = [{ title: '正文', text: htmlToText(clean(html)) }];
  } else if (ext === 'html' || ext === 'htm') {
    const raw = readTextBuffer(buf);
    const bodyM = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(raw);
    items = [{ title: '正文', text: htmlToText(clean(bodyM ? bodyM[1] : raw)) }];
  } else if (ext === 'rtf') {
    const rtfToHtml = require('@iarna/rtf-to-html');
    const html = await new Promise((resolve, reject) => {
      rtfToHtml.fromString(readTextBuffer(buf), (err, out) => (err ? reject(err) : resolve(out)));
    });
    items = [{ title: '正文', text: htmlToText(clean(html)) }];
  } else if (IMAGE_EXTS.has(ext)) {
    items = [];
  } else if (PLAIN_EXTS.has(ext)) {
    items = [{ title: '正文', text: readTextBuffer(buf) }];
  } else {
    throw new Error('暂不支持 .' + ext + ' 格式');
  }

  let chars = 0;
  const pages = [];
  for (let i = 0; i < items.length && pages.length < MAX_PAGES; i++) {
    let text = String(items[i].text || '').replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    if (text.length > 200000) text = text.slice(0, 200000);
    chars += text.length;
    if (text) pages.push({ page: i + 1, text });
    if (chars >= MAX_TEXT_CHARS) break;
  }
  return { pages, chars, numPages: items.length || 1 };
}

module.exports = {
  readDocument, extractText, readZipCoreMeta,
  isSupported, extOf, labelFor, titleFromPath,
  SUPPORTED_EXTS, IMAGE_EXTS, ZIP_EXTS,
  _htmlToText: htmlToText, _clean: clean,
};
