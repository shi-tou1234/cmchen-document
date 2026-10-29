'use strict';
/*
 * 重排阅读（Reading Mode / reflow）。
 *
 * 目标不是「把 PDF 变成 EPUB」——那要排版引擎，工程量和风险都不成比例。
 * 这里做的是：把一页的文字按坐标还原成「行 → 段落」，去掉断词连字符、
 * 按栏切分，重排成可调宽度与字号的连续文本。图表、公式、双栏里的跨栏大图
 * 会留在原位（不重排），这也是它跟真排版引擎的差距。
 *
 * 输入是渲染层归一化后的文本项 [{str,x,y,w,fh}]（scale=1 视口坐标，y 向下增大），
 * 与搜索高亮、智能跳转同一套坐标系，所以不用再管旋转 / CropBox。
 *
 * 纯函数、无 IO，Node 可单测。
 */
// UMD：主进程 require 得到同一份逻辑（脚本回归用），渲染层挂 window.Reflow。
// 少了这层包装，浏览器里 `module is not defined` 会让整个文件加载失败，
// 重排阅读就会在运行时才报「Reflow is not defined」。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Reflow = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/;
const BULLET = /^[ \t]*(?:[•·▪◦●○◆◇■□‣∙]|[-–—](?=\s)|\d{1,2}[.)](?=\s)|[(（]\d{1,2}[)）](?=\s))[ \t]*/;

function median(list) {
  const a = (list || []).filter((x) => isFinite(x)).slice().sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function isCJKChar(ch) {
  return !!ch && CJK.test(ch);
}

// 两行拼一段：中文之间不加空格；拉丁词之间加一个；行尾连字符（断词）直接接上。
function joinText(a, b) {
  const left = String(a == null ? '' : a).replace(/\s+$/, '');
  const right = String(b == null ? '' : b).replace(/^\s+/, '');
  if (!left) return right;
  if (!right) return left;
  // 英文断词：行尾 "-" 且前面是字母，且下一行以小写字母开头 —— 这才是被切开的词。
  // 「well-\nknown」这种本来就带连字符的复合词不会被误合并（下一行首大写不算）。
  if (/[A-Za-z]-$/.test(left) && /^[a-z]/.test(right)) return left.slice(0, -1) + right;
  if (isCJKChar(left.slice(-1)) || isCJKChar(right[0])) return left + right;
  return left + ' ' + right;
}

// 把文本项按基线聚成行（与 smartjump 的 buildLines 同口径，但这里不关心行内字符下标，
// 只要「行文本 + 行框」，所以实现更简单，也不依赖 items 的原始顺序）。
function groupLines(items) {
  const list = (items || []).filter((it) => it && String(it.str || '').trim() && isFinite(it.x) && isFinite(it.y));
  if (!list.length) return [];
  const rows = [];
  const sorted = list.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));
  for (const it of sorted) {
    const fh = it.fh || 10;
    const last = rows[rows.length - 1];
    if (last && Math.abs(last.y - it.y) <= Math.max(last.h, fh) * 0.5) {
      last.parts.push(it);
      last.x = Math.min(last.x, it.x);
      last.x2 = Math.max(last.x2, it.x + (it.w || 0));
      last.h = Math.max(last.h, fh);
    } else {
      rows.push({ y: it.y, h: fh, x: it.x, x2: it.x + (it.w || 0), parts: [it] });
    }
  }
  const out = [];
  for (const r of rows) {
    r.parts.sort((a, b) => a.x - b.x);
    // 同一行里文本项之间的水平间隙可能是一个词距，也可能是两栏的接缝：
    // 用平均字高的一半做阈值，超过就补一个空格，避免「DeepLearning」。
    let text = '';
    let prevEnd = null;
    for (const p of r.parts) {
      const s = String(p.str);
      if (prevEnd != null && p.x - prevEnd > r.h * 0.28 && !/\s$/.test(text) && !/^\s/.test(s)) {
        if (!(isCJKChar(text.slice(-1)) || isCJKChar(s[0]))) text += ' ';
      }
      text += s;
      prevEnd = p.x + (p.w || 0);
    }
    text = text.replace(/[ \t\u00a0]+/g, ' ').trim();
    if (!text) continue;
    out.push({ text, x: r.x, x2: r.x2, y: r.y, h: r.h });
  }
  out.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  return out;
}

// 栏检测：只有「中间几乎没人跨过、左右各有一批居中的文字」才算两栏。
// 误判的代价很大（把单栏切成两半，段落全乱），所以阈值取得保守。
function detectColumns(items, width) {
  const w = Number(width) || 0;
  if (!w || !items || items.length < 20) return [{ x0: 0, x1: Infinity }];
  const mid = w / 2;
  let crossing = 0, left = 0, right = 0;
  for (const it of items) {
    const x0 = it.x, x1 = it.x + (it.w || 0);
    if (x0 < mid * 0.92 && x1 > mid * 1.08) crossing++;
    else if (x1 <= mid * 1.04) left++;
    else if (x0 >= mid * 0.96) right++;
  }
  const n = items.length;
  if (crossing / n <= 0.04 && left / n >= 0.25 && right / n >= 0.25) {
    return [{ x0: 0, x1: mid }, { x0: mid, x1: w }];
  }
  return [{ x0: 0, x1: Infinity }];
}

// 行 → 段落。三条断段依据（按可靠性排序）：
//   1) 垂直间距明显大于本栏的常规行距（> 1.45 倍中位间距）
//   2) 本行左端明显缩进（相对本栏最常见左边界）
//   3) 上一行以句末标点结尾、且本行首字像是新段落（大写/中文），间距也略大（> 1.2 倍）
function buildParagraphs(lines) {
  if (!lines.length) return [];
  const lefts = lines.map((l) => Math.round(l.x));
  const freq = new Map();
  for (const x of lefts) freq.set(x, (freq.get(x) || 0) + 1);
  let colLeft = lefts[0], bestN = -1;
  for (const [x, c] of freq) if (c > bestN || (c === bestN && x < colLeft)) { bestN = c; colLeft = x; }
  const gaps = [];
  for (let i = 1; i < lines.length; i++) gaps.push(lines[i].y - lines[i - 1].y);
  const medGap = median(gaps) || median(lines.map((l) => l.h)) * 1.2 || 0;

  const paras = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const prev = lines[i - 1];
    const gap = prev ? ln.y - prev.y : Infinity;
    const indent = ln.x - colLeft;
    const bigGap = prev && medGap > 0 && gap > medGap * 1.45;
    const indented = indent > (ln.h || 10) * 0.9;
    const afterStop = prev && /[.。！？!?；;:：]$/.test(prev.text) && gap > medGap * 1.18 && Math.abs(indent) < (ln.h || 10) * 0.9;
    const heading = ln.h >= (median(lines.map((l) => l.h)) || 10) * 1.45;
    // 列表项一律另起一段：两条 bullet 行距和正文一样，只靠间距是分不开的
    const bullet = BULLET.test(ln.text);
    const brk = !prev || bigGap || (indented && !heading) || afterStop || heading || prev.heading || bullet;
    if (brk) {
      if (cur) paras.push(cur);
      cur = { lines: [ln], heading, size: ln.h };
    } else {
      cur.lines.push(ln);
      cur.size = Math.max(cur.size, ln.h);
    }
    ln.heading = heading;
  }
  if (cur) paras.push(cur);
  return paras;
}

function blockType(para, baseH) {
  if (para.heading) {
    if (para.size >= baseH * 1.75) return 'h2';
    if (para.size >= baseH * 1.3) return 'h3';
  }
  return 'p';
}

/**
 * 一页 → 块数组。
 * @param {Array} items [{str,x,y,w,fh}]
 * @param {object} opts { width, dropRunning }
 * @returns [{ type:'h2'|'h3'|'p'|'li', text, size }]
 */
function reflowPage(items, opts) {
  const o = opts || {};
  const list = (items || []).filter((it) => it && String(it.str || '').trim() && isFinite(it.x) && isFinite(it.y));
  if (!list.length) return [];
  const width = Number(o.width) || 0;
  const cols = detectColumns(list, width);
  const blocks = [];
  const heights = [];
  for (const col of cols) {
    const inCol = list.filter((it) => {
      const cx = it.x + (it.w || 0) / 2;
      return cx >= col.x0 && cx < col.x1;
    });
    const lines = groupLines(inCol);
    for (const ln of lines) heights.push(ln.h);
  }
  const baseH = median(heights) || 10;

  for (const col of cols) {
    const inCol = list.filter((it) => {
      const cx = it.x + (it.w || 0) / 2;
      return cx >= col.x0 && cx < col.x1;
    });
    let lines = groupLines(inCol);
    if (!lines.length) continue;
    // 页眉页脚：只在该页顶端/底端、且是纯数字或很短的「第 x 页」时丢掉
    if (o.dropRunning !== false) {
      const top = Math.min(...lines.map((l) => l.y));
      const bottom = Math.max(...lines.map((l) => l.y));
      const span = Math.max(1, bottom - top);
      lines = lines.filter((l) => {
        const nearEdge = l.y - top < span * 0.03 || bottom - l.y < span * 0.03;
        if (!nearEdge) return true;
        return !(/^[-–—\s]*\d{1,4}[-–—\s]*$/.test(l.text) || /^(page|第)\s*\d{1,4}\s*(页|of\s*\d+)?$/i.test(l.text));
      });
      if (!lines.length) continue;
    }
    const paras = buildParagraphs(lines);
    for (const p of paras) {
      let text = '';
      for (const ln of p.lines) text = joinText(text, ln.text);
      text = text.replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const bullet = BULLET.exec(text);
      let type = blockType(p, baseH);
      if (type === 'p' && bullet) type = 'li';
      const body = type === 'li' ? text.replace(BULLET, '').trim() : text;
      if (!body) continue;
      // 目录行（「标题 …… 12」）会被当成正文，这是已知取舍：识别它要用前导点与对齐，
      // 在只有文字的场合很容易把正常句子误判成目录。
      blocks.push({ type, text: body, size: Math.round(p.size * 10) / 10 });
    }
  }
  return blocks;
}

// 多页 → [{ page, blocks }]，顺手把跨页断开的同一段接起来：
// 上一页最后一段没有句末标点、下一页第一段也不是标题 / 列表，就当同一段继续。
function reflowDoc(pages, opts) {
  const out = [];
  for (const pg of (pages || [])) {
    const blocks = reflowPage(pg.items, Object.assign({ width: pg.width }, opts));
    if (!blocks.length) continue;
    const prev = out[out.length - 1];
    if (prev && prev.blocks.length && blocks.length) {
      const last = prev.blocks[prev.blocks.length - 1];
      const first = blocks[0];
      const canMerge = last.type === 'p' && first.type === 'p'
        && !/[.。！？!?：:；;”"』」]$/.test(last.text)
        && last.text.length > 40;
      if (canMerge) {
        last.text = joinText(last.text, first.text);
        blocks.shift();
      }
    }
    if (blocks.length) out.push({ page: pg.page, blocks });
    else if (prev) { /* 整页只有图表：不产出空页 */ }
  }
  return out;
}

return { reflowPage, reflowDoc, groupLines, detectColumns, buildParagraphs, joinText, median };
});
