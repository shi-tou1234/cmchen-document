'use strict';
/*
 * 从 PDF 首页文本里找论文标识（DOI / arXiv），供「导入时自动补全题录」使用。
 *
 * 为什么单独成模块：正文抽取、正则判定、清洗规则都能在 Node 里单测，
 * 不需要开 Electron，也不依赖 pdf.js。main.js 只负责「取文本 → 调这里 → 走抓取」。
 *
 * 已知边界：
 *   - 只认首页 / 前两页。参考文献里的 DOI 不会被当成论文自身的 DOI（不扫那么远）。
 *   - 扫描件没有文字层，抽不到文本，自然识别不出来——不做 OCR。
 *   - 同一页出现多个 DOI 时，优先取带 "doi" 标签的那个，否则取第一个；
 *     这不是语义理解，极端排版（页脚广告、版权声明里的 DOI）可能选错。
 */

// DOI 允许的字符集比 URL 窄：字母数字与 -._;()/: 等。结尾标点要剥掉。
const DOI_RE = /10\.\d{4,9}\/[^\s"'<>]+/gi;
// 带标签的 arXiv：arXiv:2401.01234 / arXiv: 2401.01234v2 / arXiv:hep-th/9901001
const ARXIV_LABELED_RE = /\barxiv\s*[:：]?\s*((?:\d{4}\.\d{4,5})|(?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7}))(v\d+)?/i;
// 裸的新式编号（2401.01234）只有在文本里出现过 "arxiv" 时才认，避免把年份区间当编号
const ARXIV_NEW_RE = /\b(\d{4}\.\d{4,5})(v\d+)?\b/;

// 剥掉 DOI 尾巴上的标点与不配对的右括号。
// 例：`10.1016/S0140-6736(00)02020-1).` → `10.1016/S0140-6736(00)02020-1`
function cleanDoi(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  s = s.replace(/^doi\s*[:：]\s*/i, '');
  s = s.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
  s = s.replace(/[.,;:!?'"”’]+$/, '');
  while (s && /[)\]}>,]$/.test(s)) {
    const open = (s.match(/[(\[{]/g) || []).length;
    const close = (s.match(/[)\]}]/g) || []).length;
    if (close > open) s = s.slice(0, -1).replace(/[.,;:!?'"”’]+$/, '');
    else break;
  }
  // DOI 至少要有 10.xxxx/ 且斜杠后还有内容
  return /^10\.\d{4,9}\/\S+$/.test(s) ? s : '';
}

// 判断某个 DOI 前面 40 个字符里有没有 "doi" 标签（用于同页多 DOI 时排序）
function labeledDoi(text, index) {
  const from = Math.max(0, index - 40);
  return /doi\s*[:：]?\s*$/i.test(String(text || '').slice(from, index));
}

function pickDoi(text) {
  const s = String(text || '');
  DOI_RE.lastIndex = 0;
  const found = [];
  let m;
  while ((m = DOI_RE.exec(s))) {
    const value = cleanDoi(m[0]);
    if (!value) continue;
    found.push({ value, index: m.index, labeled: labeledDoi(s, m.index) });
    if (found.length >= 12) break;
  }
  if (!found.length) return '';
  const labeled = found.filter((x) => x.labeled);
  return (labeled.length ? labeled[0] : found[0]).value;
}

function pickArxiv(text) {
  const s = String(text || '');
  const labeled = ARXIV_LABELED_RE.exec(s);
  if (labeled) return labeled[1] + (labeled[2] || '');
  if (/\barxiv\b/i.test(s)) {
    const bare = ARXIV_NEW_RE.exec(s);
    if (bare) return bare[1] + (bare[2] || '');
  }
  return '';
}

/*
 * 从一段文本里抽标识。
 * 返回 { doi, arxivId, identifier, source }：
 *   identifier 是可直接交给 metadata.fetchMetadata 的字符串；
 *   source 是 'doi' / 'arxiv' / ''。
 */
function extractIdentifiers(text) {
  const s = String(text || '');
  const doi = pickDoi(s);
  const arxivId = pickArxiv(s);
  if (doi) return { doi, arxivId, identifier: doi, source: 'doi' };
  if (arxivId) return { doi: '', arxivId, identifier: arxivId, source: 'arxiv' };
  return { doi: '', arxivId: '', identifier: '', source: '' };
}

// 抽取结果是否「看起来可信」：给调用方决定要不要提示用户确认。
// 目前只区分「有标识」和「没有」，保留这个入口是为了以后加置信度。
function isConfident(ids) {
  return !!(ids && ids.identifier);
}

module.exports = { extractIdentifiers, cleanDoi, isConfident };
