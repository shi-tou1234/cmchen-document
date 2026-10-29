'use strict';
/*
 * 相似文献（借鉴 Paperless-ngx 的「相似文档」）。
 *
 * 不引入向量模型，也不联网：用库里已有的全文索引做 tf-idf + 余弦相似度。
 * 对「找同一主题的另一篇」这件事，词袋已经够用；代价是抓不到同义改写，
 * 但换来的是零依赖、离线、几百篇的库在一秒内出结果。
 *
 * 分词口径：
 *   - 拉丁：小写词，长度 ≥ 3，去掉虚词与常见期刊套话（references / et al 之类）
 *   - 中文：二元组（bigram）。中文没有空格，单字太泛（「的」「研」），
 *     二字组在「深度学习」这类术语上召回与精度都够。
 *
 * 纯函数、无 IO：主进程负责读索引，这里只负责算。
 */
const STOP = new Set(('the and for with that this from are was were will would can could shall should may might ' +
  'have has had not but its their our your his her they them we you it is are been being into than then there ' +
  'these those such more most other some any all each also between within using used use based show shows shown ' +
  'study studies paper papers article articles results result method methods approach approaches data ' +
  'however therefore thus furthermore moreover moreover although while where which who whom whose what when ' +
  'about above after again against among because before below during before under over only own same very ' +
  'references reference et al fig figure table eq equation section vol no pp doi http https www ' +
  '我们 本文 研究 方法 结果 问题 分析 一个 一种 一些 以及 但是 因此 所以 如果 可以 进行 通过 对于 关于 这些 那些 这个 那个').split(/\s+/).filter(Boolean));

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const MAX_TERMS_PER_DOC = 4000;      // 单篇最多保留多少个不同词（超长书也只取高频部分）

function isStop(w) { return STOP.has(w); }

// 文本 → 词数组（保留重复，供词频统计）
function tokenize(text) {
  const s = String(text || '').toLowerCase();
  if (!s) return [];
  const out = [];
  // 拉丁词：允许词内连字符与撇号，统一按「词」处理
  const latin = s.match(/[a-z][a-z0-9'’\-]{1,}/g) || [];
  for (const w of latin) {
    const t = w.replace(/^['’\-]+|['’\-]+$/g, '');
    if (t.length < 3) continue;
    if (isStop(t)) continue;
    out.push(t);
  }
  // 中文二元组：连续 CJK 段内切；标点/空格自然断段
  const cjkRuns = s.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g) || [];
  for (const run of cjkRuns) {
    if (run.length === 1) { out.push(run); continue; }
    for (let i = 0; i < run.length - 1; i++) {
      const bg = run.slice(i, i + 2);
      if (isStop(bg)) continue;
      out.push(bg);
    }
  }
  return out;
}

function termCounts(tokens) {
  const m = new Map();
  for (const t of tokens) m.set(t, (m.get(t) || 0) + 1);
  return m;
}

// 单篇 → 稀疏向量（保留 tf，idf 在语料层再加）
function vectorOf(text) {
  const counts = termCounts(tokenize(text));
  if (counts.size > MAX_TERMS_PER_DOC) {
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_TERMS_PER_DOC);
    return new Map(top);
  }
  return counts;
}

function docFrequency(vectors) {
  const df = new Map();
  for (const v of vectors) for (const t of v.keys()) df.set(t, (df.get(t) || 0) + 1);
  return df;
}

// 语料：docs = [{ path, title, vector }]，已建好向量的那批。
// 返回可直接复用的结构；主进程按索引文件的 stamp 缓存它。
function buildCorpus(docs) {
  const list = (docs || []).filter((d) => d && d.vector && d.vector.size);
  const df = docFrequency(list.map((d) => d.vector));
  const n = list.length;
  const idf = new Map();
  for (const [t, c] of df) idf.set(t, Math.log((n + 1) / (c + 1)) + 1);
  return { docs: list, idf, n };
}

// 亚线性 tf：出现 10 次不该比出现 1 次重要 10 倍。idf 来自语料（越普通的词越轻）
function weight(tf, idf) {
  return (1 + Math.log(tf)) * (idf || 1);
}

function vecNorm(vector, idf) {
  let sum = 0;
  for (const [t, c] of vector) { const w = weight(c, idf.get(t)); sum += w * w; }
  return Math.sqrt(sum) || 0;
}

/**
 * 找与 target 最像的文档。
 * @param {Map} targetVector 目标文档词频
 * @param {object} corpus buildCorpus 的结果
 * @param {object} opts { limit=8 }
 * @returns [{ path, title, score, shared:[{term,weight}] }]
 */
function rank(targetVector, corpus, opts) {
  const o = opts || {};
  const limit = Math.max(1, Math.min(50, Number(o.limit) || 8));
  const idf = (corpus && corpus.idf) || new Map();
  const docs = (corpus && corpus.docs) || [];
  if (!targetVector || !targetVector.size || !docs.length) return [];
  const targetNorm = vecNorm(targetVector, idf);
  if (!targetNorm) return [];

  const out = [];
  for (const d of docs) {
    if (!d.vector || !d.vector.size) continue;
    let dot = 0;
    const shared = [];
    for (const [t, tc] of targetVector) {
      const dc = d.vector.get(t);
      if (!dc) continue;
      const w = weight(tc, idf.get(t)) * weight(dc, idf.get(t));
      dot += w;
      shared.push({ term: t, weight: w });
    }
    if (!dot) continue;
    const norm = vecNorm(d.vector, idf);
    if (!norm) continue;
    shared.sort((a, b) => b.weight - a.weight);
    out.push({ path: d.path, title: d.title || '', score: dot / (targetNorm * norm), shared: shared.slice(0, 6) });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

// 索引条目 → 纯文本（fulltext 的 { pages:[{page,text}] }）
function textOfEntry(entry) {
  if (!entry || !Array.isArray(entry.pages)) return '';
  return entry.pages.map((p) => String((p && p.text) || '')).join('\n');
}

// 给界面用的一句话：为什么像它
function sharedLabel(shared, max) {
  const n = Math.max(1, Number(max) || 4);
  return (shared || []).slice(0, n).map((x) => x.term).join(' · ');
}

module.exports = {
  tokenize, termCounts, vectorOf, buildCorpus, rank,
  textOfEntry, sharedLabel, isStop, MAX_TERMS_PER_DOC, CJK,
};
