'use strict';
/*
 * 识别结果 → 条目字段的合并规则（2026-10-29）。
 *
 * 单独成模块的原因：这里是「谁的字段说了算」的唯一裁决处，最容易出微妙的覆盖问题，
 * 必须能在 Node 里直接测。main.js 只负责取文本、调抓取，不再自己写一套合并判断。
 *
 * 优先级（高 → 低）：调用方显式传入 > 识别结果 > PDF 内嵌元数据 > 文件名。
 * 判断方式是「当前值是否为空」，所以调用方必须把所有显式字段都传进来（current），
 * 少传一个，那个字段就会被识别结果盖掉。
 */

function str(v) { return v == null ? '' : String(v).trim(); }

// 识别到的标题能不能用：太长、还是模板名的不要（与 pdfmeta.usableTitle 的边界一致）
function usableTitle(t) {
  const s = str(t);
  if (!s || s.length > 200) return '';
  if (/^(untitled|unknown|document\s*\d*|microsoft\s+word.*|print|打印输出|文档\d*)$/i.test(s)) return '';
  if (/\\/.test(s)) return '';
  if (/^(latex|beamer|article|book|elsarticle|revtex4)/i.test(s)) return '';
  return s;
}

// current 里所有「可以被识别结果补全」的字段都要参与空值判断。
// 注意 itemType 的特例：空 或 'document' 都算「没有明确类型」，允许被识别结果替换；
// 用户明确选了 book / thesis 之类则不动。
function fieldsFromMetadata(m, current) {
  const meta = m || {};
  const cur = current || {};
  const out = {};

  if (!str(cur.title) && usableTitle(meta.title)) out.title = str(meta.title);
  if (!(Array.isArray(cur.creators) && cur.creators.length) && Array.isArray(meta.creators) && meta.creators.length) {
    out.creators = meta.creators;
  }
  if (!str(cur.year) && str(meta.year)) out.year = str(meta.year);
  if (!str(cur.publication) && str(meta.publication)) out.publication = str(meta.publication);
  if (!str(cur.volume) && str(meta.volume)) out.volume = str(meta.volume);
  if (!str(cur.issue) && str(meta.issue)) out.issue = str(meta.issue);
  if (!str(cur.pages) && str(meta.pages)) out.pages = str(meta.pages);
  if (!str(cur.doi) && str(meta.doi)) out.doi = str(meta.doi);
  if (!str(cur.url) && str(meta.url)) out.url = str(meta.url);
  if (!str(cur.abstract) && str(meta.abstract)) out.abstract = str(meta.abstract);
  if (!str(cur.language) && str(meta.language)) out.language = str(meta.language);
  if (!(Array.isArray(cur.tags) && cur.tags.length) && Array.isArray(meta.tags) && meta.tags.length) {
    out.tags = meta.tags.slice(0, 20);
  }
  const type = str(cur.itemType);
  if ((!type || type === 'document') && str(meta.itemType) && str(meta.itemType) !== 'document') {
    out.itemType = str(meta.itemType);
  }
  return out;
}

module.exports = { fieldsFromMetadata, usableTitle };
