'use strict';
/*
 * 笔记用的轻量 Markdown 渲染（v9，报告「笔记」缺口：纯文本 → 富文本预览）。
 *
 * 为什么自己写而不引库：项目约定零前端框架 / 零额外依赖，而笔记只需要
 * 标题、粗斜体、链接、图片、列表、引用、代码块、表格这一小撮语法；
 * 关键要求是**先转义再拼标签**，绝不把用户文本当 HTML 插进 DOM。
 *
 * 公式：项目里没有数学排版引擎，$...$ / $$...$$ 按等宽原样显示（保留 LaTeX 源码），
 * 需要排版时把公式贴到外部工具。这一点在预览区有提示，不假装支持。
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

  // 只在明确的白名单协议下生成可点链接，其它（javascript:、file: 等）当纯文本
  function safeHref(raw) {
    const u = String(raw || '').trim();
    if (/^https?:\/\//i.test(u)) return u;
    if (/^mailto:/i.test(u)) return u;
    return '';
  }

  function imageTag(alt, rawUrl) {
    const u = String(rawUrl || '').trim();
    if (/^https?:\/\//i.test(u)) {
      return '<img class="md-img" src="' + esc(u) + '" alt="' + esc(alt) + '" loading="lazy" />';
    }
    // 数据目录内的相对路径（snapshots/xxx.png）：由 UI 通过 IPC 读成 dataURL 再填 src，
    // 渲染层不直接碰 file://
    return '<img class="md-img" data-md-img="' + esc(u) + '" alt="' + esc(alt) + '" />';
  }

  function linkTag(text, rawUrl) {
    const href = safeHref(rawUrl);
    if (!href) return '<span class="md-plain-link">' + text + '</span>';
    return '<a class="md-link" data-md-link="' + esc(href) + '" href="javascript:void(0)">' + text + '</a>';
  }

  function inline(s) {
    let out = esc(s);
    // 行内代码先抽出来，别让里面的 * _ 被当成强调
    const codes = [];
    out = out.replace(/`([^`\n]+)`/g, (_, c) => {
      codes.push('<code>' + c + '</code>');
      return '\u0001' + (codes.length - 1) + '\u0001';
    });
    // 公式：$$…$$ 或 $…$ 原样等宽（没有数学渲染器）
    const maths = [];
    out = out.replace(/\$\$([^$]+)\$\$/g, (_, m) => {
      maths.push('<span class="md-math">$$' + m + '$$</span>');
      return '\u0002' + (maths.length - 1) + '\u0002';
    });
    out = out.replace(/(^|[^\\$])\$([^$\n]+)\$/g, (m, pre, body) => {
      maths.push('<span class="md-math">$' + body + '$</span>');
      return pre + '\u0002' + (maths.length - 1) + '\u0002';
    });
    // 图片必须在链接之前（![x](y) 里也含 [x](y)）
    out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, alt, url) => imageTag(alt, url));
    out = out.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, t, url) => linkTag(t, url));
    out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    out = out.replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>');
    out = out.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
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

  function render(text) {
    const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
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

      // 块级公式 $$
      if (/^\$\$/.test(trimmed)) {
        const buf = [];
        let first = trimmed.replace(/^\$\$/, '');
        if (/\$\$$/.test(first) && first.length >= 2) {
          out.push('<div class="md-math-block">$$' + esc(first.slice(0, -2)) + '$$</div>');
          i++;
          continue;
        }
        buf.push(first);
        i++;
        while (i < lines.length && !/\$\$\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        if (i < lines.length) { buf.push(lines[i].replace(/\$\$\s*$/, '')); i++; }
        out.push('<div class="md-math-block">$$' + esc(buf.join('\n')) + '$$</div>');
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

      // 列表（无序 / 有序）
      if (/^([-*+])\s+/.test(trimmed) || /^\d+[.)]\s+/.test(trimmed)) {
        const ordered = /^\d+[.)]\s+/.test(trimmed);
        const items = [];
        while (i < lines.length) {
          const t = lines[i].trim();
          const m = ordered ? /^\d+[.)]\s+(.*)$/.exec(t) : /^[-*+]\s+(.*)$/.exec(t);
          if (!m) break;
          items.push('<li>' + inline(m[1]) + '</li>');
          i++;
        }
        out.push((ordered ? '<ol class="md-list">' : '<ul class="md-list">') + items.join('') + (ordered ? '</ol>' : '</ul>'));
        continue;
      }

      // 段落：连续非空行，行内换行保留为 <br>
      const buf = [trimmed];
      i++;
      while (i < lines.length && lines[i].trim()
        && !/^(#{1,6}\s|>\s?|```|\$\$|-{3,}$|\|)/.test(lines[i].trim())
        && !/^([-*+])\s+/.test(lines[i].trim()) && !/^\d+[.)]\s+/.test(lines[i].trim())) {
        buf.push(lines[i].trim());
        i++;
      }
      out.push('<p class="md-p">' + buf.map(inline).join('<br />') + '</p>');
    }
    return out.join('\n');
  }

  // 纯文本摘要（卡片 / 搜索结果用）：去掉标记但不额外加空格
  function plain(text, max) {
    const s = String(text == null ? '' : text)
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^>\s?/gm, '')
      .replace(/[*_~`]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const n = max || 90;
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  return { render, inline, plain, esc, safeHref };
});
