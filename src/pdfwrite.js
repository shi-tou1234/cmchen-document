'use strict';
/*
 * 把题录写进 PDF 自身（v1.6）。
 *
 * 为什么要有这个：sidecar 只在 Trove 里有效，PDF 一旦发给别人、或换到 Zotero /
 * JabRef / calibre，题录就丢了。写进 PDF 之后，文件自己带着 Title / Author /
 * Subject / Keywords，多数阅读器和文献工具都能直接读出来。
 *
 * 两条刻意保守的决定：
 *   1. **默认另存副本，不改原文件**。写 PDF 二进制不是无损操作（对象重排、交叉引用表重建），
 *      一次失败就可能让原文档打不开——这和「删除只改索引、绝不删原始文档」是同一条原则。
 *   2. 同时写 Info 字典与 XMP。Info 是 90 年代的老机制但兼容面最广；XMP 是新工具看的。
 *      只写一边总会有一半软件读不到。
 *
 * 不写的东西：书签、注释、附件、加密状态。只动题录相关的几个字段。
 */
const fs = require('fs');
const path = require('path');
const { PDFDocument, PDFName } = require('pdf-lib');

function s(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); }

function xmlEsc(v) {
  return s(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function authorsOf(it) {
  const list = Array.isArray(it && it.creators) ? it.creators : [];
  return list.filter((c) => c && c.creatorType !== 'editor')
    .map((c) => s([c.lastName, c.firstName].filter(Boolean).join(', ')))
    .filter(Boolean);
}

function keywordsOf(it) {
  return (Array.isArray(it && it.tags) ? it.tags : []).map(s).filter(Boolean);
}

// XMP 包：dc 用 rdf:Alt / rdf:Seq，pdf 命名空间放 Producer / Keywords。
// 结构照 Adobe 的 XMP 规范最小可用形态写，不引 xmptk 之类的额外依赖。
function buildXmp(it) {
  const title = s(it && it.title);
  const authors = authorsOf(it);
  const subjects = keywordsOf(it);
  const desc = s(it && it.abstract).slice(0, 1200);
  const year = (s(it && it.year).match(/\d{4}/) || [''])[0];
  const doi = s(it && it.doi);
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const li = (tag, list) => list.length
    ? '   <' + tag + '><rdf:Seq>' + list.map((x) => '<rdf:li>' + xmlEsc(x) + '</rdf:li>').join('') + '</rdf:Seq></' + tag + '>\n'
    : '';
  return '<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>\n' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Trove">\n' +
    ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n' +
    '  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"' +
    '   xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">\n' +
    (title ? '   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">' + xmlEsc(title) + '</rdf:li></rdf:Alt></dc:title>\n' : '') +
    li('dc:creator', authors) +
    (desc ? '   <dc:description><rdf:Alt><rdf:li xml:lang="x-default">' + xmlEsc(desc) + '</rdf:li></rdf:Alt></dc:description>\n' : '') +
    li('dc:subject', subjects) +
    (doi ? '   <dc:identifier>info:doi/' + xmlEsc(doi) + '</dc:identifier>\n' : '') +
    (year ? '   <dc:date>' + year + '</dc:date>\n' : '') +
    '   <xmp:CreatorTool>Trove</xmp:CreatorTool>\n' +
    '   <xmp:ModifyDate>' + stamp + '</xmp:ModifyDate>\n' +
    '   <pdf:Producer>Trove</pdf:Producer>\n' +
    (subjects.length ? '   <pdf:Keywords>' + xmlEsc(subjects.join('; ')) + '</pdf:Keywords>\n' : '') +
    '  </rdf:Description>\n' +
    ' </rdf:RDF>\n' +
    '</x:xmpmeta>\n' +
    '<?xpacket end="w"?>';
}

// 默认输出路径：与原文件同目录、同名 + 后缀，不覆盖已有文件（重名再加序号）
function defaultOutPath(srcPath, suffix) {
  const dir = path.dirname(srcPath);
  const base = path.basename(srcPath).replace(/\.pdf$/i, '');
  const tail = suffix || '-元数据.pdf';
  let out = path.join(dir, base + tail);
  let n = 2;
  while (fs.existsSync(out) && n < 100) {
    out = path.join(dir, base + '-' + n + tail);
    n++;
  }
  return out;
}

/*
 * 把条目题录写进一份 PDF 副本。
 * 返回 { ok, path, bytes, fields } 或 { ok:false, error }。
 * 不抛异常：调用方只需要判断 ok。
 */
async function writeToCopy(item, srcPath, outPath) {
  const it = item || {};
  const src = s(srcPath);
  if (!src) return { ok: false, error: '这条条目没有附件' };
  if (!/\.pdf$/i.test(src)) return { ok: false, error: '只支持 PDF 附件' };
  let bytes;
  try { bytes = fs.readFileSync(src); }
  catch (err) { return { ok: false, error: '读不到原文件：' + (err && err.message ? err.message : err) }; }

  let doc;
  try { doc = await PDFDocument.load(bytes, { ignoreEncryption: true }); }
  catch (err) { return { ok: false, error: '这份 PDF 解析不了：' + (err && err.message ? err.message : err) }; }

  const fields = {};
  const setIf = (name, value, fn) => {
    const v = s(value);
    if (!v) return;
    try { fn(v); fields[name] = v; } catch (_) { /* 单个字段写不进去不该让整次失败 */ }
  };
  const title = s(it.title);
  const authors = authorsOf(it);
  const subjects = keywordsOf(it);
  setIf('title', title, (v) => doc.setTitle(v));
  if (authors.length) { try { doc.setAuthor(authors.join('; ')); fields.author = authors.join('; '); } catch (_) {} }
  setIf('subject', s(it.abstract).slice(0, 500), (v) => doc.setSubject(v));
  if (subjects.length) { try { doc.setKeywords(subjects); fields.keywords = subjects.join('; '); } catch (_) {} }
  try { doc.setCreator('Trove'); fields.creator = 'Trove'; } catch (_) {}
  // 不设 Producer：pdf-lib 在序列化时会把 /Producer 改写成它自己的字符串，
  // setProducer 写了也留不住（实测）。真正的「谁生成的」写在 XMP 的 pdf:Producer 里，
  // 那份是我们自己的流，不会被覆盖。
  try { doc.setModificationDate(new Date()); } catch (_) {}

  // XMP：写进 catalog 的 /Metadata。失败只影响「新工具能不能读到」，Info 那套还在。
  // 必须传 Buffer 而不是字符串：pdf-lib 对字符串按单字节（latin1）落盘，
  // 中文会被截成乱码——Info 字典那边走的是 PDFHexString，所以看不出问题，
  // 只有真的打开 Metadata 流才看得见（R-v1.6-03）。
  try {
    const xmp = buildXmp(it);
    const stream = doc.context.stream(Buffer.from(xmp, 'utf8'), { Type: 'Metadata', Subtype: 'XML' });
    doc.catalog.set(PDFName.of('Metadata'), doc.context.register(stream));
    fields.xmp = true;
  } catch (_) { fields.xmp = false; }

  let outBytes;
  try { outBytes = Buffer.from(await doc.save()); }
  catch (err) { return { ok: false, error: '写回失败：' + (err && err.message ? err.message : err) }; }

  const target = s(outPath) || defaultOutPath(src);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, outBytes);
  } catch (err) {
    return { ok: false, error: '保存失败：' + (err && err.message ? err.message : err) };
  }
  return { ok: true, path: target, bytes: outBytes.length, fields, source: src };
}

module.exports = { writeToCopy, buildXmp, defaultOutPath, _authorsOf: authorsOf };
