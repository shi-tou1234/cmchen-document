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

  function imageTag(alt, rawUrl) {
    // N04：rawUrl 来自 inline() 转义过的整行——直接再 esc 会双重编码（& → &amp;amp;），
    // 应用内点击与导出链接的查询参数都会坏。先还原成原始 URL，只转义一次。
    const u = decode(String(rawUrl || '').trim());
    if (/^https?:\/\//i.test(u)) {
      return '<img class="md-img" src="' + esc(u) + '" alt="' + esc(alt) + '" loading="lazy" />';
    }
    // 数据目录内的相对路径（snapshots/xxx.png）：由 UI 通过 IPC 读成 dataURL 再填 src，
    // 渲染层不直接碰 file://
    return '<img class="md-img" data-md-img="' + esc(u) + '" alt="' + esc(alt) + '" />';
  }

  function linkTag(text, rawUrl) {
    const href = safeHref(decode(rawUrl));   // N04：同 imageTag，只转义一次
    if (!href) return '<span class="md-plain-link">' + text + '</span>';
    return '<a class="md-link" data-md-link="' + esc(href) + '" href="javascript:void(0)">' + text + '</a>';
  }

  function inline(s) {
    let out = esc(s);
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
    // 必须排在图片/普通链接之前，否则 [x](y) 的正则会先吃掉一层括号。
    out = out.replace(/\[\[([^\[\]\n]+)\]\]/g, (_, t) =>
      '<span class="md-wikilink" data-wikilink="' + t + '" title="跳到笔记：' + t + '">' + t + '</span>');
    // 图片必须在链接之前（![x](y) 里也含 [x](y)）
    out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, alt, url) => imageTag(alt, url));
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
    return out;
  }

  function renderTable(lines, start) {
    const head = lines[start].trim();
    const sep = lines[start + 1].trim();
    // 注意字符类里 '-' 必须放最后，写成 [\s:-|] 会被解析成 : 到 | 的范围
    if (!/^\|?[\s:|-]+\|?$/.test(sep) || sep.indexOf('-') < 0) return null;
    // 单元格里的 \| 是转义竖线，不能当分隔符（先按「未被反斜杠转义」的竖线切）
    const cells = (row) => row
      .replace(/^\||\|$/g, '')
      .split(/(?<!\\)\|/)
      .map((c) => c.trim().replace(/\\\|/g, '|'));
    const aligns = cells(sep).map((c) => {
      const l = c.startsWith(':'), r = c.endsWith(':');
      return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
    });
    const th = cells(head).map((c, i) => '<th' + (aligns[i] ? ' class="md-al-' + aligns[i] + '"' : '') + '>' + inline(c) + '</th>').join('');
    const rows = [];
    let i = start + 2;
    while (i < lines.length && /^\s*\|/.test(lines[i])) {
      const tds = cells(lines[i].trim()).map((c, j) => '<td' + (aligns[j] ? ' class="md-al-' + aligns[j] + '"' : '') + '>' + inline(c) + '</td>').join('');
      rows.push('<tr>' + tds + '</tr>');
      i++;
    }
    return { html: '<table class="md-table"><thead><tr>' + th + '</tr></thead><tbody>' + rows.join('') + '</tbody></table>', next: i };
  }

  // :::类型[标题] … ::: 容器（提示框 / 推导 / 引用卡）
  function renderContainer(lines, start) {
    const head = /^:::([\w-]+)(?:\[([^\]]*)\])?\s*$/.exec(lines[start].trim());
    if (!head) return null;
    const type = head[1].toLowerCase();
    const title = head[2] || '';
    const buf = [];
    let i = start + 1;
    while (i < lines.length && !/^:::\s*$/.test(lines[i].trim())) { buf.push(lines[i]); i++; }
    if (i < lines.length) i++;   // 吃掉收尾 :::
    let inner = render(buf.join('\n'));
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

  function render(text) {
    const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
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
        const c = renderContainer(lines, i);
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
        let defText = fn[2];
        i++;
        while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|>\s?|```|:::|\[\^\d+\]:)/.test(lines[i].trim())) {
          defText += ' ' + lines[i].trim();
          i++;
        }
        footnotes.push({ n, text: defText });
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
        out.push('<h' + lv + ' class="md-h">' + inline(h[2]) + '</h' + lv + '>');
        i++;
        continue;
      }

      // 表格
      if (/^\|/.test(trimmed) && i + 1 < lines.length) {
        const t = renderTable(lines, i);
        if (t) { out.push(t.html); i = t.next; continue; }
      }

      // 引用
      if (/^>\s?/.test(trimmed)) {
        const buf = [];
        while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
          buf.push(lines[i].trim().replace(/^>\s?/, ''));
          i++;
        }
        out.push('<blockquote class="md-quote">' + buf.map((b) => (b.trim() ? '<p>' + inline(b) + '</p>' : '')).join('') + '</blockquote>');
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
          const tm = /^\[( |x|X)\]\s+(.*)$/.exec(m[1]);
          if (tm && !ordered) {
            const done = tm[1].toLowerCase() === 'x';
            items.push('<li class="md-task"><input type="checkbox" disabled' + (done ? ' checked' : '') + ' />'
              + '<span' + (done ? ' class="md-task-done"' : '') + '>' + inline(tm[2]) + '</span></li>');
          } else {
            items.push('<li>' + inline(m[1]) + '</li>');
          }
          i++;
        }
        out.push((ordered ? '<ol class="md-list">' : '<ul class="md-list md-ul">') + items.join('') + (ordered ? '</ol>' : '</ul>'));
        continue;
      }

      // 段落：连续非空行，行内换行保留为 <br>
      const buf = [trimmed];
      i++;
      while (i < lines.length && lines[i].trim()
        && !/^(#{1,6}\s|>\s?|```|\$\$|:::|::(github|music)\{|-{3,}$|\[\^\d+\]:|\|)/.test(lines[i].trim())
        && !/^([-*+])\s+/.test(lines[i].trim()) && !/^\d+[.)]\s+/.test(lines[i].trim())) {
        buf.push(lines[i].trim());
        i++;
      }
      out.push('<p class="md-p">' + buf.map(inline).join('<br />') + '</p>');
    }
    // 文末脚注区
    if (footnotes.length) {
      out.push('<hr class="md-fn-hr" /><section class="md-footnotes">'
        + footnotes.map((f) => '<div class="md-fn" id="fn-' + esc(f.n) + '">'
          + '<span class="md-fn-index">[' + esc(f.n) + ']</span> ' + inline(f.text) + '</div>').join('')
        + '</section>');
    }
    return out.join('\n');
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
      slots.img.push('![' + (alt ? alt[1] : '') + '](' + (src ? src[1] : '') + ')');
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

  return { render, inline, plain, esc, safeHref, fromHtml };
});
