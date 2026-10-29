'use strict';
/*
 * 跨文档「Portal」（借鉴 Sioyek 的 Portal）：读到 [12] 时，除了跳到本文的参考文献表，
 * 还能把那条文献本身在对照栏打开到对应页。
 *
 * 难点不在跳，而在「这条参考文献说的是库里哪一篇」——参考文献是自由文本，
 * 没有 DOI 的占多数。这里的判定只有两级：
 *   1) 条目里有 DOI，且与库里某条的 DOI 相同 → 直接命中（最可靠）
 *   2) 否则比标题词：库里的标题词有多少出现在条目文本里 + 年份/姓氏是否同时出现
 * 达不到阈值就不猜——「跳错一篇」比「不跳」更让人困惑。
 *
 * 纯函数、无 IO；主进程负责读库和索引。
 */

// UMD：主进程 require 得到同一份逻辑，渲染层用它把「条目跨行」拼完整
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Portal = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

function fold(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^0-9a-z\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normDoi(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
    .replace(/^doi:\s*/, '')
    .replace(/[\s.,;]+$/, '')
    .trim();
}

// 标题里「有信息量」的词：拉丁词 ≥ 4 字母；中文取 2 字以上的连续段
function titleTokens(title) {
  const out = new Set();
  const s = String(title || '');
  const latin = s.match(/[A-Za-z][A-Za-z0-9'-]{3,}/g) || [];
  for (const w of latin) {
    const t = w.toLowerCase();
    if (['this', 'that', 'with', 'from', 'using', 'based', 'toward', 'towards', 'into', 'their'].indexOf(t) >= 0) continue;
    out.add(t);
  }
  const cjk = s.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]{2,}/g) || [];
  for (const run of cjk) {
    // 太长的中文标题整段匹配不现实，按 4 字窗口切片；短的就整段
    if (run.length <= 6) out.add(run);
    else for (let i = 0; i + 4 <= run.length; i += 2) out.add(run.slice(i, i + 4));
  }
  return [...out];
}

/**
 * 在条目文本里找 DOI。参考文献里的 DOI 常带句点结尾，这里去掉尾标点。
 */
function doiInEntry(entry) {
  const m = /10\.\d{4,9}\/[-._;()/:a-z0-9]+/i.exec(String(entry || ''));
  return m ? normDoi(m[0]) : '';
}

/**
 * 条目文本 → 与库里条目的最佳匹配。
 * @param {string} entry 参考文献条目的正文（可跨行）
 * @param {Array} items 库条目 [{key,title,year,doi,creators,attachment}]
 * @returns {{item, score, why}|null}
 */
function matchEntry(entry, items) {
  const text = String(entry || '');
  const folded = fold(text);
  if (!folded) return null;
  const doi = doiInEntry(text);
  const list = (items || []).filter((it) => it && !it.deletedAt && it.attachment && it.attachment.path);

  if (doi) {
    for (const it of list) if (normDoi(it.doi) === doi) return { item: it, score: 1, why: 'DOI' };
  }

  let best = null;
  for (const it of list) {
    const tokens = titleTokens(it.title);
    if (!tokens.length) continue;
    let hit = 0;
    for (const t of tokens) if (folded.indexOf(t) >= 0) hit++;
    const ratio = hit / tokens.length;
    // 标题太短（1–2 个词）时 ratio 很容易满分，所以再要求「年份也在」
    const year = String(it.year || '').trim();
    const yearOk = year ? text.indexOf(year) >= 0 : false;
    const surname = String(((it.creators || [])[0] || {}).lastName || '').trim();
    const nameOk = surname ? folded.indexOf(fold(surname)) >= 0 : false;
    let score = ratio * 0.75 + (yearOk ? 0.15 : 0) + (nameOk ? 0.1 : 0);
    if (tokens.length <= 2 && !yearOk) score *= 0.6;      // 短标题：没有年份就大幅降权
    if (!best || score > best.score) best = { item: it, score, why: ratio >= 0.999 ? '标题完整出现' : '标题词 ' + hit + '/' + tokens.length };
  }
  if (!best || best.score < 0.62) return null;
  return best;
}

/**
 * 在目标文档的全文索引里找「这一篇」开始的页。
 * 先用标题（几乎一定出现在首页），再用 DOI；都没有就把条目里最长的词当线索。
 * @param {{pages:[{page,text}]}} index
 * @param {{title,doi}} item
 * @returns {number} 页码，找不到返回 0
 */
function findStartPage(index, item) {
  const pages = (index && Array.isArray(index.pages)) ? index.pages : [];
  if (!pages.length) return 0;
  const title = fold(item && item.title);
  const doi = normDoi(item && item.doi);
  // 标题整串能在某页找到：最理想
  if (title && title.length >= 8) {
    for (const pg of pages) {
      if (fold(pg.text).indexOf(title) >= 0) return Number(pg.page) || 0;
    }
    // 整串找不到（断词 / 分栏 / 页眉拆开）：退一步用标题前 6 个词的任意 3 个
    const toks = title.split(' ').filter((x) => x.length >= 3);
    if (toks.length >= 4) {
      for (const pg of pages) {
        const hay = fold(pg.text);
        let hit = 0;
        for (const t of toks) if (hay.indexOf(t) >= 0) hit++;
        if (hit >= Math.max(3, Math.ceil(toks.length * 0.6))) return Number(pg.page) || 0;
      }
    }
  }
  if (doi) {
    // 两边都要 fold：normDoi 保留点与斜杠，而 fold 会把它们变成空格，
    // 直接拿 raw DOI 去 fold 过的页面文本里找永远找不到。
    const needle = fold(doi);
    if (needle) for (const pg of pages) if (fold(pg.text).indexOf(needle) >= 0) return Number(pg.page) || 0;
  }
  return 0;
}

/**
 * 从「参考文献表」的整篇行数组里取出第 idx 行所属的完整条目（可能跨行）。
 * 结束条件：遇到下一条编号 / 作者-年份开头，或行数上限。
 */
function entryAt(lines, idx, opts) {
  const o = opts || {};
  const maxLines = Math.max(1, Number(o.maxLines) || 6);
  const list = Array.isArray(lines) ? lines : [];
  if (idx < 0 || idx >= list.length) return '';
  const out = [String(list[idx].text || '')];
  const NUM_START = /^\s*[\[（(]?\d{1,3}[\]）).]?\s+/;
  const AY_START = /^\s*[A-Z][A-Za-z'’\-]+,\s/;
  for (let i = idx + 1; i < list.length && out.length < maxLines; i++) {
    const t = String(list[i].text || '');
    if (!t.trim()) break;
    if (NUM_START.test(t) || AY_START.test(t)) break;
    out.push(t);
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

return { matchEntry, findStartPage, entryAt, titleTokens, doiInEntry, fold, normDoi, CJK };
});
