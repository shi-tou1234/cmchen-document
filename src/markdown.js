'use strict';
/*
 * 笔记用的轻量 Markdown 渲染（v9.6：语法与样式整体对齐用户博客的后台编辑器）。
 *
 * 为什么自己写而不引库：项目约定零前端框架 / 零额外依赖；
 * 关键要求是**先转义再拼标签**，绝不把用户文本当 HTML 插进 DOM。
 *
 * v9.6 新增（对齐博客 D:/项目/博客站点 的 markdown.css / PostToolbar）：
 *   :::tip / :::note / :::important / :::warning / :::caution / :::tip[自定义标题]
 *   :::derivation（推导容器）、:::quote（引用卡片，支持 <right>/<left> 对齐与「—— 出处」）
 *   ++下划线++   !!剧透(模糊)!!   ==彩虹文字==   {汉字}(hàn|zì) 拼音   [^1] 脚注
 *   ::music{id="网易云ID"}   ::github{repo="用户/仓库"}
 *   - [ ] / - [x] 任务列表
 *   fromHtml()：旧富文本笔记（html）一次性转成 Markdown，迁移用。
 *
 * 公式：$...$ / $$...$$ 输出带 data-md-math 属性的占位元素，正文仍是等宽源码；
 *   渲染进程的 TroveMath（renderer/math.js）在有 KaTeX 时把它换成真正的排版结果，
 *   没有就保持源码显示。Node 导出走主进程的同一套渲染。
 *
 * UMD：Node 里 require 可测，浏览器里挂 window.Md。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Md = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]); }
  function decode(s) {
    return String(s == null ? '' : s)
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  }

  // 只在明确的白名单协议下生成可点链接，其它（javascript:、file: 等）当纯文本
  function safeHref(raw) {
    const u = String(raw || '').trim();
    if (/^https?:\/\//i.test(u)) return u;
    if (/^mailto:/i.test(u)) return u;
    return '';
  }

  /*
   * 图片宽度：写在 URL 末尾的 #w=NNN。
   * 为什么是「标记」而不是独立语法：宽度是这张图自身的属性，跟着图片走才能在
   * 导出 / 富文本互转 / 复制粘贴时不丢；Markdown 的 URL 里不能有空格，所以只能挂在片段位置。
   */
  const WIDTH_MARK = /#w=(\d{1,6})$/;   // 位数放宽、由 clampWidth 收敛：写歪的值不该留在 URL 里

  /*
   * 图片语法：**渲染、缩放、导出三处必须共用这一份**。
   * 之前三处各写一条正则，结果只有渲染认得 `![图](a.png "说明")` 的标题，
   * 缩放会跳过它去改下一张图，导出会漏掉这张图（而且 skipped 还是 0）——R-v1.6b-01。
   * 允许的形态：`![alt](url)` / `![alt](url "title")`，url 里可带 `#w=NNN`。
   * 标题在渲染前已经被 esc 成 &quot;，所以两种写法都要认。
   */
  const IMAGE_RE_SRC = '!\\[([^\\]]*)\\]\\(([^)\\s]+)(?:\\s+(?:"[^"]*"|&quot;[^&]*&quot;))?\\)';

  // 标出源码里「代码」占据的位置：围栏代码块 + 行内代码。
  // 渲染器会先把行内代码抽成占位符、代码块整段不交给 inline()，所以这两处的 ![](...)
  // 根本不会变成 <img>；数下标 / 收集引用时必须按同样的口径跳过。
  function codeMask(text) {
    const src = String(text || '');
    const mask = new Uint8Array(src.length);
    const lines = src.split('\n');
    let off = 0, inFence = false;
    for (const line of lines) {
      const start = off, end = off + line.length;
      off = end + 1;
      const trimmed = line.trim();
      if (inFence) {
        mask.fill(1, start, end);
        if (trimmed === '```') inFence = false;
        continue;
      }
      if (trimmed.indexOf('```') === 0) { mask.fill(1, start, end); inFence = true; continue; }
      let k = 0;
      while (k < line.length) {
        if (line[k] === '`') {
          let runLen = 1;
          while (line[k + runLen] === '`') runLen++;
          const run = '`'.repeat(runLen);
          const close = line.indexOf(run, k + runLen);
          if (close >= 0) {
            mask.fill(1, start + k, start + close + runLen);
            k = close + runLen;
            continue;
          }
          k += runLen;
          continue;
        }
        k++;
      }
    }
    return mask;
  }

  /*
   * 扫出所有图片，带绝对偏移，方便调用方就地改写而不必重拼整行。
   * opts.skipCode = true 时跳过代码块 / 行内代码里的示例图（与渲染结果对齐）。
   * 返回 [{ start, end, alt, url, urlStart, urlEnd, base, frag, width }]
   */
  function scanImages(text, opts) {
    const src = String(text || '');
    const mask = (opts && opts.skipCode) ? codeMask(src) : null;
    const re = new RegExp(IMAGE_RE_SRC, 'g');
    const out = [];
    let m;
    while ((m = re.exec(src))) {
      if (mask && mask[m.index]) continue;
      const alt = m[1] || '';
      const url = m[2] || '';
      // '![' + alt + '](' 的前缀长度 → URL 的绝对起点
      const urlStart = m.index + 2 + alt.length + 2;
      const parts = splitImageUrl(url);
      out.push({
        start: m.index,
        end: m.index + m[0].length,
        alt, url,
        urlStart, urlEnd: urlStart + url.length,
        base: parts.url,
        width: parts.width,
        frag: url.slice(parts.url.length),
      });
    }
    return out;
  }

  function clampWidth(v) {
    const n = Math.round(Number(v) || 0);
    if (!n) return 0;
    return Math.max(40, Math.min(2400, n));
  }

  function splitImageUrl(rawUrl) {
    const u = decode(String(rawUrl || '').trim());
    const m = WIDTH_MARK.exec(u);
    if (!m) return { url: u, width: 0 };
    const w = clampWidth(m[1]);
    return { url: w ? u.slice(0, m.index) : u, width: w };
  }

  // width 属性与 style 一起给：前者在富文本清洗后也容易保住，后者才是真正生效的那个。
  // data-md-w 是给 fromHtml 回读用的（机器可读），不依赖 CSS 是否被 strip。
  function imgWidthAttrs(width) {
    if (!width) return '';
    return ' width="' + width + '" data-md-w="' + width
      + '" style="width:' + width + 'px;max-width:100%;height:auto;"';
  }

  // srcOffset：这张图在**源码里的绝对偏移**（由调用方一路传下来，不做反推）。
  // 缩放靠它定位；给不出来就不写这个属性，调用方退回按序号。
  function imageTag(alt, rawUrl, srcOffset) {
    // N04：rawUrl 来自 inline() 转义过的整行——直接再 esc 会双重编码（& → &amp;amp;），
    // 应用内点击与导出链接的查询参数都会坏。先还原成原始 URL，只转义一次。
    const parts = splitImageUrl(rawUrl);
    const u = parts.url;
    const wa = imgWidthAttrs(parts.width);
    const sa = (typeof srcOffset === 'number' && srcOffset >= 0) ? ' data-md-img-src="' + srcOffset + '"' : '';
    if (/^https?:\/\//i.test(u)) {
      return '<img class="md-img" src="' + esc(u) + '" alt="' + esc(alt) + '" loading="lazy"' + wa + sa + ' />';
    }
    // 数据目录内的相对路径（snapshots/xxx.png）：由 UI 通过 IPC 读成 dataURL 再填 src，
    // 渲染层不直接碰 file://
    return '<img class="md-img" data-md-img="' + esc(u) + '" alt="' + esc(alt) + '"' + wa + sa + ' />';
  }

  function linkTag(text, rawUrl) {
    const href = safeHref(decode(rawUrl));   // N04：同 imageTag，只转义一次
    if (!href) return '<span class="md-plain-link">' + text + '</span>';
    return '<a class="md-link" data-md-link="' + esc(href) + '" href="javascript:void(0)">' + text + '</a>';
  }

  /*
   * ctx 说明「这段文字在源码里的位置」，用来给图片标出真实偏移：
   *   { base }    这段文字就是源码从 base 开始的一段（普通段落 / 标题 / 列表项）
   *   { offsets } 已知每张图的绝对偏移（脚注正文是重拼出来的，位置对不上，只能直接给）
   * 两种都给不出来就不标，调用方退回按序号——宁可退回，也不按 URL 反推（R-v1.6e-03）。
   */
  function inline(s, ctx) {
    const raw = String(s == null ? '' : s);
    const imgs = scanImages(raw, { skipCode: true });
    const knownOffsets = (ctx && Array.isArray(ctx.offsets)) ? ctx.offsets : null;
    const base = (ctx && typeof ctx.base === 'number') ? ctx.base : null;
    const srcOf = (i) => {
      if (knownOffsets) return knownOffsets[i];
      if (base != null) return base + imgs[i].start;
      return null;
    };
    let prepared = raw;
    if (imgs.length) {
      // 从后往前替换，前面那些图的偏移不会被带偏
      for (let i = imgs.length - 1; i >= 0; i--) {
        const im = imgs[i];
        prepared = prepared.slice(0, im.start) + '\u0003' + i + '\u0003' + prepared.slice(im.end);
      }
    }
    let out = esc(prepared);
    // 表格里的 `\|` 表示一个真正的竖线。转义放在这里（而不是在切单元格时做），
    // 是为了让图片的源码偏移始终按原始文本算——先缩短文本再算位置会差一格。
    out = out.replace(/\\\|/g, '|');
    // 行内代码先抽出来，别让里面的 * _ ~ + = ! 被当成强调
    const codes = [];
    out = out.replace(/`([^`\n]+)`/g, (_, c) => {
      codes.push('<code>' + c + '</code>');
      return '\u0001' + (codes.length - 1) + '\u0001';
    });
    // 公式：$$…$$ 或 $…$ 先输出等宽源码占位；data-md-math 存 LaTeX 源（此处的文本已转义，
    // 属性里直接复用是安全的），data-md-display 标记块级。TroveMath / 导出管线负责换真排版。
    const maths = [];
    out = out.replace(/\$\$([^$]+)\$\$/g, (_, m) => {
      maths.push('<span class="md-math" data-md-display="1" data-md-math="' + m + '">$$' + m + '$$</span>');
      return '\u0002' + (maths.length - 1) + '\u0002';
    });
    out = out.replace(/(^|[^\\$])\$([^$\n]+)\$/g, (m, pre, body) => {
      maths.push('<span class="md-math" data-md-math="' + body + '">$' + body + '$</span>');
      return pre + '\u0002' + (maths.length - 1) + '\u0002';
    });
    // 双向链接 [[笔记标题]]：只输出占位，点击跳转由笔记编辑器的委托处理（按标题找独立笔记）。
    out = out.replace(/\[\[([^\[\]\n]+)\]\]/g, (_, t) =>
      '<span class="md-wikilink" data-wikilink="' + t + '" title="跳到笔记：' + t + '">' + t + '</span>');
    // 图片已在开头抽成占位符，这里只处理普通链接（不会再出现 ![x](y) 抢括号的问题）
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, t, url) => linkTag(t, url));
    out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    out = out.replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>');
    out = out.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    // ===== 博客扩展语法（++下划线 / !!剧透 / ==彩虹 / 拼音 / 脚注）=====
    out = out.replace(/\+\+([^+\n]+)\+\+/g, '<span class="underline-text">$1</span>');
    out = out.replace(/!!([^!\n]+)!!/g, '<span class="spoiler" data-spoiler title="点击显示">$1</span>');
    out = out.replace(/==([^=\n]+)==/g, '<span class="rainbow-text">$1</span>');
    out = out.replace(/\{([^{}\n]+)\}\(([^()\n]+)\)/g, (_, zi, yin) => {
      const rt = yin.split('|').join(' ');
      return '<ruby>' + zi + '<rt>' + rt + '</rt></ruby>';
    });
    out = out.replace(/\[\^(\d+)\]/g, '<sup class="md-fnref" data-fnjump="fn-$1">$1</sup>');
    out = out.replace(/\u0001(\d+)\u0001/g, (_, i) => codes[+i] || '');
    out = out.replace(/\u0002(\d+)\u0002/g, (_, i) => maths[+i] || '');
    // 图片最后换回来：imageTag 自己会 esc，所以必须等正文的 esc 走完再拼
    if (imgs.length) out = out.replace(/\u0003(\d+)\u0003/g, (_, i) => {
      const im = imgs[+i];
      return im ? imageTag(im.alt, im.url, srcOf(+i)) : '';
    });
    return out;
  }

  // 每个单元格「去掉前后空白后的正文」在原始行里的起点。
  // 表格里的图片也要能定位到源码，所以不能只返回文字（R-v1.6f-03）。
  function cellStarts(row) {
    const s = String(row == null ? '' : row);
    const out = [];
    const from = s.startsWith('|') ? 1 : 0;
    const to = s.endsWith('|') ? s.length - 1 : s.length;
    let segStart = from;
    for (let i = from; i <= to; i++) {
      const isBar = s[i] === '|' && s[i - 1] !== '\\';
      if (i < to && !isBar) continue;
      const raw = s.slice(segStart, i);
      const lead = raw.length - raw.replace(/^\s+/, '').length;
      out.push(segStart + lead);
      segStart = i + 1;
    }
    return out;
  }

  function renderTable(lines, start, lineBase) {
    const headRaw = lines[start];
    const head = headRaw.trim();
    const sep = lines[start + 1].trim();
    // 注意字符类里 '-' 必须放最后，写成 [\s:-|] 会被解析成 : 到 | 的范围
    if (!/^\|?[\s:|-]+\|?$/.test(sep) || sep.indexOf('-') < 0) return null;
    // 单元格里的 \| 是转义竖线，不能当分隔符（先按「未被反斜杠转义」的竖线切）
    // 单元格里的 `\|` 是转义竖线。**这里不解转义**：解了文本会短一个字符，
    // 后面图片的源码偏移就全少算（R-v1.6g-01）。交给 inline() 在转义之后再换成 `|`，
    // 这样偏移始终按原始文本算。
    const cells = (row) => row
      .replace(/^\||\|$/g, '')
      .split(/(?<!\\)\|/)
      .map((c) => c.trim());
    const padOf = (raw, trimmed) => Math.max(0, String(raw).indexOf(trimmed));
    const base = (typeof lineBase === 'function') ? lineBase : () => 0;
    const aligns = cells(sep).map((c) => {
      const l = c.startsWith(':'), r = c.endsWith(':');
      return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
    });
    const headStarts = cellStarts(headRaw);
    const headPad = padOf(headRaw, head);
    const th = cells(head).map((c, i) => '<th' + (aligns[i] ? ' class="md-al-' + aligns[i] + '"' : '') + '>'
      + inline(c, { base: base(start) + headPad + (headStarts[i] || 0) }) + '</th>').join('');
    const rows = [];
    let i = start + 2;
    while (i < lines.length && /^\s*\|/.test(lines[i])) {
      const raw = lines[i];
      const trim = raw.trim();
      const starts = cellStarts(raw);
      const pad = padOf(raw, trim);
      const tds = cells(trim).map((c, j) => '<td' + (aligns[j] ? ' class="md-al-' + aligns[j] + '"' : '') + '>'
        + inline(c, { base: base(i) + pad + (starts[j] || 0) }) + '</td>').join('');
      rows.push('<tr>' + tds + '</tr>');
      i++;
    }
    return { html: '<table class="md-table"><thead><tr>' + th + '</tr></thead><tbody>' + rows.join('') + '</tbody></table>', next: i };
  }

  // :::类型[标题] … ::: 容器（提示框 / 推导 / 引用卡）
  function renderContainer(lines, start, innerBase) {
    const head = /^:::([\w-]+)(?:\[([^\]]*)\])?\s*$/.exec(lines[start].trim());
    if (!head) return null;
    const type = head[1].toLowerCase();
    const title = head[2] || '';
    const buf = [];
    let i = start + 1;
    while (i < lines.length && !/^:::\s*$/.test(lines[i].trim())) { buf.push(lines[i]); i++; }
    if (i < lines.length) i++;   // 吃掉收尾 :::
    // 容器正文是源码里连续的一段，偏移可以直接接着算下去
    let inner = render(buf.join('\n'), innerBase);
    if (type === 'quote') {
      // <right>/<left> 是博客的对齐标记（我们的管线会把 HTML 转义），换成对齐容器；
      // <br> 是博客引卡模板里的换行，一并接住
      inner = inner
        .replace(/&lt;br\s*\/?&gt;/g, '<br />')
        .replace(/&lt;right&gt;/g, '</div><div class="q-right">')
        .replace(/&lt;\/right&gt;/g, '</div><div class="q-body">')
        .replace(/&lt;left&gt;/g, '</div><div class="q-left">')
        .replace(/&lt;\/left&gt;/g, '</div><div class="q-body">');
      // 「—— 出处」行靠右
      inner = inner.replace(/<p class="md-p">(——[^<]*)<\/p>/g, '<div class="q-from">$1</div>');
      return { html: '<div class="quote"><div class="q-body">' + inner + '</div></div>', next: i };
    }
    if (type === 'derivation') {
      return {
        html: '<div class="admonition derivation"><div class="admonition-title">推导过程</div>'
          + '<div class="admonition-body">' + inner + '</div></div>',
        next: i,
      };
    }
    const known = ['tip', 'note', 'important', 'warning', 'caution'];
    const cls = known.includes(type) ? type : 'tip';
    const label = title || ({ tip: 'Tip', note: 'Note', important: 'Important', warning: 'Warning', caution: 'Caution' }[cls] || type);
    return {
      html: '<div class="admonition ' + cls + '"><div class="admonition-title">' + esc(label) + '</div>'
        + '<div class="admonition-body">' + inner + '</div></div>',
      next: i,
    };
  }

  // ::github{repo="user/repo"} / ::music{id="网易云ID"}
  function renderCardLine(trimmed) {
    const gh = /^::github\{(.*)\}\s*$/.exec(trimmed);
    if (gh) {
      const repo = (/repo\s*=\s*"([^"]*)"/.exec(gh[1]) || [])[1] || '';
      const owner = repo.split('/')[0] || '';
      const name = repo.split('/')[1] || repo;
      if (!repo) return '';
      return '<a class="card-github no-styling" data-md-link="https://github.com/' + esc(repo) + '" href="javascript:void(0)">'
        + '<div class="gc-titlebar"><div class="gc-titlebar-left"><span class="gc-owner">'
        + '<span class="gc-avatar"></span><span class="gc-user">' + esc(owner) + '</span></span>'
        + '<span class="gc-divider">/</span><span class="gc-repo">' + esc(name) + '</span></div>'
        + '<span class="github-logo"></span></div>'
        + '<div class="gc-infobar"><span class="gc-stars">GitHub 仓库</span></div></a>';
    }
    const mu = /^::music\{(.*)\}\s*$/.exec(trimmed);
    if (mu) {
      const id = (/id\s*=\s*"([^"]*)"/.exec(mu[1]) || [])[1] || '';
      const name = (/name\s*=\s*"([^"]*)"/.exec(mu[1]) || [])[1] || '';
      const artist = (/artist\s*=\s*"([^"]*)"/.exec(mu[1]) || [])[1] || '';
      if (!id) return '';
      return '<a class="card-music no-styling" data-md-link="https://music.163.com/#/song?id=' + encodeURIComponent(id) + '" href="javascript:void(0)">'
        + '<div class="music-card"><div class="music-cover-wrapper"><div class="music-cover"></div></div>'
        + '<div class="music-info"><div class="music-header">'
        + '<div class="music-title">' + esc(name || ('网易云歌曲 ' + id)) + '</div>'
        + '<div class="music-artist">' + esc(artist || '点击在浏览器里打开') + '</div>'
        + '</div></div></div></a>';
    }
    return '';
  }

  function renderBlocks(text, baseOffset) {
    const src = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    const lines = src.split('\n');
    // 每一行在源码里的绝对起点：图片的 data-md-img-src 靠它算，不靠事后按 URL 反推
    const base = (typeof baseOffset === 'number') ? baseOffset : 0;
    const lineOffsets = [];
    { let off = 0; for (const l of lines) { lineOffsets.push(off); off += l.length + 1; } }
    const at = (i) => base + (lineOffsets[i] || 0);
    // 从某一行里切出来的片段（标题正文、列表项正文）：找得到就给出它的绝对位置
    const offIn = (i, sub) => {
      const k = String(lines[i] == null ? '' : lines[i]).indexOf(sub);
      return k >= 0 ? at(i) + k : null;
    };
    const out = [];
    const footnotes = [];   // [ { n, text } ]
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();

      // 代码块
      const fence = /^```([\w+-]*)\s*$/.exec(trimmed);
      if (fence) {
        const buf = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i].trim())) { buf.push(lines[i]); i++; }
        i++;   // 跳过收尾 ```
        out.push('<pre class="md-pre"><code' + (fence[1] ? ' data-lang="' + esc(fence[1]) + '"' : '') + '>'
          + esc(buf.join('\n')) + '</code></pre>');
        continue;
      }

      // ::: 容器（提示框 / 推导 / 引用卡）
      if (/^:::[\w-]/.test(trimmed)) {
        const c = renderContainer(lines, i, at(i + 1));
        if (c) { out.push(c.html); i = c.next; continue; }
      }

      // ::github / ::music 卡片
      if (/^::(github|music)\{/.test(trimmed)) {
        const card = renderCardLine(trimmed);
        if (card) { out.push(card); i++; continue; }
      }

      // 脚注定义：[^1]: 内容（收集到最后统一渲染）
      const fn = /^\[\^(\d+)\]:\s*(.*)$/.exec(trimmed);
      if (fn) {
        const n = fn[1];
        const fnStart = i;
        let defText = fn[2];
        i++;
        while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|>\s?|```|:::|\[\^\d+\]:)/.test(lines[i].trim())) {
          defText += ' ' + lines[i].trim();
          i++;
        }
        // 脚注正文是「重拼」出来的（各行 trim 后接空格），偏移对不上原文，
        // 所以在这里直接从**定义所在的源码切片**扫出图片的绝对位置，渲染时按顺序发下去。
        const defSrc = lines.slice(fnStart, i).join('\n');
        const defImgs = scanImages(defSrc, { skipCode: true });
        footnotes.push({ n, text: defText, offsets: defImgs.map((im) => at(fnStart) + im.start) });
        continue;
      }

      // 块级公式 $$
      if (/^\$\$/.test(trimmed)) {
        const buf = [];
        let first = trimmed.replace(/^\$\$/, '');
        if (/\$\$$/.test(first) && first.length >= 2) {
          const src = esc(first.slice(0, -2));
          out.push('<div class="md-math-block" data-md-math="' + src + '">$$' + src + '$$</div>');
          i++;
          continue;
        }
        buf.push(first);
        i++;
        while (i < lines.length && !/\$\$\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        if (i < lines.length) { buf.push(lines[i].replace(/\$\$\s*$/, '')); i++; }
        const src = esc(buf.join('\n'));
        out.push('<div class="md-math-block" data-md-math="' + src + '">$$' + src + '$$</div>');
        continue;
      }

      // 空行
      if (!trimmed) { i++; continue; }

      // 分割线
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { out.push('<hr />'); i++; continue; }

      // 标题
      const h = /^(#{1,6})\s+(.*)$/.exec(trimmed);
      if (h) {
        const lv = h[1].length;
        out.push('<h' + lv + ' class="md-h">' + inline(h[2], { base: offIn(i, h[2]) }) + '</h' + lv + '>');
        i++;
        continue;
      }

      // 表格
      if (/^\|/.test(trimmed) && i + 1 < lines.length) {
        const t = renderTable(lines, i, at);
        if (t) { out.push(t.html); i = t.next; continue; }
      }

      // 引用
      if (/^>\s?/.test(trimmed)) {
        const buf = [];
        const startQ = i;
        while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
          buf.push(lines[i].trim().replace(/^>\s?/, ''));
          i++;
        }
        out.push('<blockquote class="md-quote">' + buf.map((b, k) => (b.trim()
          ? '<p>' + inline(b, { base: offIn(startQ + k, b) }) + '</p>' : '')).join('') + '</blockquote>');
        continue;
      }

      // 列表（无序 / 有序 / 任务）
      if (/^([-*+])\s+/.test(trimmed) || /^\d+[.)]\s+/.test(trimmed)) {
        const ordered = /^\d+[.)]\s+/.test(trimmed);
        const items = [];
        while (i < lines.length) {
          const t = lines[i].trim();
          const m = ordered ? /^\d+[.)]\s+(.*)$/.exec(t) : /^[-*+]\s+(.*)$/.exec(t);
          if (!m) break;
          const li = i;
          const tm = /^\[( |x|X)\]\s+(.*)$/.exec(m[1]);
          if (tm && !ordered) {
            const done = tm[1].toLowerCase() === 'x';
            items.push('<li class="md-task"><input type="checkbox" disabled' + (done ? ' checked' : '') + ' />'
              + '<span' + (done ? ' class="md-task-done"' : '') + '>' + inline(tm[2], { base: offIn(li, tm[2]) }) + '</span></li>');
          } else {
            items.push('<li>' + inline(m[1], { base: offIn(li, m[1]) }) + '</li>');
          }
          i++;
        }
        out.push((ordered ? '<ol class="md-list">' : '<ul class="md-list md-ul">') + items.join('') + (ordered ? '</ol>' : '</ul>'));
        continue;
      }

      // 段落：连续非空行，行内换行保留为 <br>
      const startP = i;
      const buf = [trimmed];
      i++;
      while (i < lines.length && lines[i].trim()
        && !/^(#{1,6}\s|>\s?|```|\$\$|:::|::(github|music)\{|-{3,}$|\[\^\d+\]:|\|)/.test(lines[i].trim())
        && !/^([-*+])\s+/.test(lines[i].trim()) && !/^\d+[.)]\s+/.test(lines[i].trim())) {
        buf.push(lines[i].trim());
        i++;
      }
      out.push('<p class="md-p">' + buf.map((b, k) => inline(b, { base: offIn(startP + k, b) })).join('<br />') + '</p>');
    }
    // 文末脚注区
    if (footnotes.length) {
      out.push('<hr class="md-fn-hr" /><section class="md-footnotes">'
        + footnotes.map((f) => '<div class="md-fn" id="fn-' + esc(f.n) + '">'
          + '<span class="md-fn-index">[' + esc(f.n) + ']</span> ' + inline(f.text, { offsets: f.offsets }) + '</div>').join('')
        + '</section>');
    }
    return out.join('\n');
  }

  // 源码位置是一路传下去的（renderBlocks → inline → imageTag），不再事后按 URL 反推。
  // 反推分不清「同一张图在正文和脚注各引用一次」——那正是 R-v1.6e-03 的场景。
  function render(text, baseOffset) {
    return renderBlocks(text, baseOffset);
  }

  // 纯文本摘要（卡片 / 搜索结果用）：去掉标记但不额外加空格
  function plain(text, max) {
    const s = String(text == null ? '' : text)
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/\[\[([^\[\]\n]+)\]\]/g, '$1')   // [[双向链接]] 摘要里只留标题
      .replace(/:::[\w-]*(\[[^\]]*)?[\s\S]*?(:::\s*$|[\n\r])/gm, ' ')
      .replace(/::(github|music)\{[^}]*\}/g, ' ')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\[\^\d+\]/g, ' ')
      .replace(/\[\^\d+\]:/g, ' ')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^>\s?/gm, '')
      .replace(/\{([^{}]+)\}\(([^()]+)\)/g, '$1')
      .replace(/[*_~`+=!]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const n = max || 90;
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  // ---------- 旧富文本笔记 → Markdown（一次性迁移，正则版，Node / 浏览器都能跑） ----------
  function stripTags(s) {
    return decode(String(s == null ? '' : s).replace(/<[^>]+>/g, ''));
  }

  function fromHtml(html) {
    let s = String(html || '');
    if (!s.trim()) return '';
    const slots = { pre: [], img: [], a: [] };
    // 1. 整块结构先抽走，避免内部标记被二次处理
    s = s.replace(/<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi, (_, c) => {
      slots.pre.push('```\n' + stripTags(c) + '\n```');
      return '\u0003P' + (slots.pre.length - 1) + '\u0003';
    });
    s = s.replace(/<img[^>]*>/gi, (tag) => {
      const src = /(?:data-md-img|src)\s*=\s*"([^"]*)"/i.exec(tag);
      const alt = /alt\s*=\s*"([^"]*)"/i.exec(tag);
      // 宽度：data-md-w（渲染层写下的）优先，其次退化到 width 属性 / style。
      // 三者都试是因为 HTML 来源不止一条：我们渲染的、旧富文本编辑器留下的、粘贴进来的。
      const wRaw = (/data-md-w\s*=\s*"(\d{1,6})"/i.exec(tag) || [])[1]
        || (/\bwidth\s*=\s*"(\d{1,6})"/i.exec(tag) || [])[1]
        || (/style\s*=\s*"[^"]*width:\s*(\d{1,6})px/i.exec(tag) || [])[1];
      const w = clampWidth(wRaw);
      const base = String(src ? src[1] : '').replace(WIDTH_MARK, '');
      slots.img.push('![' + (alt ? alt[1] : '') + '](' + base + (w ? '#w=' + w : '') + ')');
      return '\u0003I' + (slots.img.length - 1) + '\u0003';
    });
    s = s.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (whole, attrs, txt) => {
      // M01：应用内占位链接（data-md-link + href="javascript:void(0)"，经富文本清洗
      // 后 href 变成 "#"）——真实 URL 在 data-md-link 里。优先取它并过协议白名单，
      // 没有再退回 href；都不可用就降级成纯文本，与 linkTag 的行为一致。
      const mdAttr = /data-md-link\s*=\s*"([^"]*)"/i.exec(attrs);
      const hrefAttr = /href\s*=\s*"([^"]*)"/i.exec(attrs);
      let url = mdAttr ? decode(mdAttr[1]) : '';
      if (!safeHref(url)) url = hrefAttr ? decode(hrefAttr[1]) : '';
      if (!safeHref(url)) return stripTags(txt).trim();
      slots.a.push('[' + stripTags(txt).trim() + '](' + url + ')');
      return '\u0003A' + (slots.a.length - 1) + '\u0003';
    });
    // 2. 行内样式
    s = s.replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, '**$2**');
    s = s.replace(/<(em|i)>([\s\S]*?)<\/\1>/gi, '*$2*');
    s = s.replace(/<(u|ins)>([\s\S]*?)<\/\1>/gi, '++$2++');
    s = s.replace(/<(del|s|strike)>([\s\S]*?)<\/\1>/gi, '~~$2~~');
    s = s.replace(/<code>([\s\S]*?)<\/code>/gi, '`$1`');
    s = s.replace(/\*\*(?=[*_~+=!`])/g, '** ');   // 相邻标记隔开：**粗***斜* → **粗** *斜*
    // 3. 块级结构
    s = s.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n\n# $1\n\n');
    s = s.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n\n## $1\n\n');
    s = s.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n\n### $1\n\n');
    s = s.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n\n#### $1\n\n');
    s = s.replace(/<h[56][^>]*>([\s\S]*?)<\/h[56]>/gi, '\n\n##### $1\n\n');
    s = s.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi,
      (_, c) => '\n\n' + stripTags(c).split('\n').map((l) => '> ' + l.trim()).filter((l) => l.trim() !== '>').join('\n') + '\n\n');
    // 表格要整块转成 Markdown 表格，否则下面的 </tr> → 换行会把整张表拍成几行文字
    // （Word / HTML / Markdown 三种导出都吃这一份 fromHtml，所以这里一改三处都对）
    s = s.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_, body) => {
      const rows = [];
      const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
      let rm;
      while ((rm = rowRe.exec(body))) {
        const cells = [];
        const cellRe = /<(th|td)[^>]*>([\s\S]*?)<\/\1>/gi;
        let cm;
        while ((cm = cellRe.exec(rm[1]))) {
          cells.push(stripTags(cm[2]).replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|'));
        }
        if (cells.length) rows.push(cells);
      }
      if (!rows.length) return '\n\n';
      const width = rows.reduce((n, r) => Math.max(n, r.length), 0);
      const pad = (r) => { const c = r.slice(); while (c.length < width) c.push(''); return c; };
      const head = pad(rows[0]);
      const lines = ['| ' + head.join(' | ') + ' |', '| ' + head.map(() => '---').join(' | ') + ' |'];
      for (const r of rows.slice(1)) lines.push('| ' + pad(r).join(' | ') + ' |');
      return '\n\n' + lines.join('\n') + '\n\n';
    });
    s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1');
    s = s.replace(/<\/(p|div|h[1-6]|ul|ol|li|blockquote|pre|table|tr)>/gi, '\n');
    s = s.replace(/<br\s*\/?>/gi, '\n');
    s = s.replace(/<[^>]+>/g, '');
    // 4. 实体 + 占位符还原
    s = decode(s);
    s = s.replace(/\u0003([PIA])(\d+)\u0003/g, (_, k, n) => (slots[{ P: 'pre', I: 'img', A: 'a' }[k]] || [])[+n] || '');
    // 5. 收尾：清单项顶格、空行收敛
    s = s.split('\n').map((l) => l.replace(/^\s*[-*]\s+\*\*/, '- **')).join('\n');
    s = s.replace(/[ \t]+\n/g, '\n');
    s = s.replace(/\n{3,}/g, '\n\n');
    return s.trim();
  }

  return { render, inline, plain, esc, safeHref, fromHtml, scanImages, codeMask, splitImageUrl, clampWidth, IMAGE_RE_SRC };
});
