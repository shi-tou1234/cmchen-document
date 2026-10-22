'use strict';
/*
 * 笔记富文本的清洗与纯文本提取（v9）。
 *
 * 背景：笔记改成「像 Word 一样」所见即所得编辑后，正文存 HTML（notes[].html）。
 * HTML 会被塞进 innerHTML，所以必须在**写入库之前**和**渲染之前**都过一遍白名单，
 * 否则从 Word / 网页粘贴进来的一段 onerror / script 就是任意代码执行。
 *
 * 这里用正则做白名单清洗（不引 DOM 解析库，Node 里也能跑、可单测）：
 *   - 整段删掉 script / style / iframe / object / embed / link / meta / form
 *   - 去掉所有 on* 事件属性
 *   - href/src 里的 javascript: 与 data:（除图片）改成 #
 *   - 不在白名单里的标签直接去掉（保留里面的文字）
 *
 * toText：给搜索 / 摘要 / 导出用的纯文本。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RichText = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const ALLOWED = /^(b|strong|i|em|u|ins|s|strike|del|br|p|div|span|h[1-6]|ul|ol|li|blockquote|a|img|code|pre|hr|table|thead|tbody|tr|th|td|sub|sup|mark)$/i;
  const DANGEROUS_BLOCK = /<\s*(script|style|iframe|object|embed|link|meta|form|input|button|textarea|select|video|audio|canvas|svg)\b[\s\S]*?<\s*\/\s*\1\s*>/gi;
  const DANGEROUS_SELF = /<\s*(script|style|iframe|object|embed|link|meta|form|input|button|textarea|select|video|audio|canvas|svg)\b[^>]*\/?\s*>/gi;

  function sanitize(html) {
    let s = String(html == null ? '' : html);
    if (!s) return '';
    s = s.replace(DANGEROUS_BLOCK, '');
    s = s.replace(DANGEROUS_SELF, '');
    // 事件属性（三种引号形态）
    s = s.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '');
    s = s.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '');
    s = s.replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '');
    // javascript: / vbscript: / 非图片的 data:
    s = s.replace(/(href|src)\s*=\s*(["'])\s*(javascript|vbscript)\s*:[^"']*\2/gi, '$1="#"');
    s = s.replace(/(href|src)\s*=\s*(["'])\s*data:(?!image\/)[^"']*\2/gi, '$1="#"');
    // 标签白名单：不认识的开闭标签去掉（文字留下）
    s = s.replace(/<\/?([a-z0-9-]+)((?:[^>"']|"[^"]*"|'[^']*')*)>/gi, (m, tag) => (ALLOWED.test(tag) ? m : ''));
    // style 里带 expression / url(javascript) 的一律去掉
    s = s.replace(/\sstyle\s*=\s*"([^"]*)"/gi, (m, css) => (/expression|javascript:/i.test(css) ? '' : m));
    return s;
  }

  function decodeEntities(s) {
    return String(s || '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#0*39;/g, "'")
      .replace(/&#(\d+);/g, (m, d) => {
        const n = Number(d);
        return n > 0 && n < 65536 ? String.fromCharCode(n) : '';
      })
      .replace(/&amp;/gi, '&');
  }

  function toText(html) {
    const s = String(html == null ? '' : html)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|blockquote|tr|pre)>/gi, '\n')
      .replace(/<\/(td|th)>/gi, '\t')
      .replace(/<hr[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, '');
    return decodeEntities(s)
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // 输入框里显示用的初始 HTML：优先用已存的富文本，老 Markdown 笔记交给调用方渲染
  function initial(view, markdownHtml) {
    const saved = sanitize(view && view.html);
    if (saved) return saved;
    // 旧笔记：text 里是 Markdown / 纯文本
    const text = String((view && view.text) || '');
    if (!text.trim()) return '';
    return markdownHtml ? markdownHtml : '<p>' + sanitize(text.replace(/\n/g, '<br>')) + '</p>';
  }

  return { sanitize, toText, initial, ALLOWED };
});
