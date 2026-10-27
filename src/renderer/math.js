'use strict';
/*
 * 笔记公式的 KaTeX 渲染增强（window.TroveMath）。
 *
 * markdown.js 把 $...$ / $$...$$ 输出成带 data-md-math 属性的等宽源码占位；
 * 本模块在预览挂进 DOM 后把这些占位替换成真正的排版结果。
 *
 * KaTeX 资源由 scripts/copy-pdfjs.js 拷到 renderer/katex/（katex.min.css + js + woff2 字体），
 * index.html 直接引用。文件没拷、加载失败时 window.katex 不存在：
 * enhance() 返回 0、DOM 原样保留——公式继续按源码显示，不报错也不破坏预览。
 *
 * 富文本子笔记不走这里：contenteditable 里的 KaTeX 结构会被编辑和清洗打散。
 */
(function (root) {
  function available() { return !!(root.katex && root.katex.renderToString); }

  // 把一个占位元素替换成 KaTeX 渲染结果；失败时保留源码占位并标记错误
  function renderOne(el, katex) {
    const src = el.getAttribute('data-md-math') || '';
    if (!src.trim()) return false;
    const display = el.getAttribute('data-md-display') === '1' || el.classList.contains('md-math-block');
    try {
      const html = katex.renderToString(src, {
        displayMode: display,
        throwOnError: false,
        strict: false,
        output: 'htmlAndMathml',
      });
      el.innerHTML = html;
      el.classList.add('md-math-done');
      el.removeAttribute('data-md-math');   // 已渲染，避免重复处理与再导出误读
      return true;
    } catch (_) {
      el.classList.add('md-math-error');
      return false;
    }
  }

  // 处理 rootEl 内所有未渲染的公式占位，返回成功渲染的数量
  function enhance(rootEl) {
    if (!available() || !rootEl || !rootEl.querySelectorAll) return 0;
    const nodes = rootEl.querySelectorAll('[data-md-math]');
    let done = 0;
    for (const el of nodes) {
      if (el.classList.contains('md-math-done')) continue;
      if (renderOne(el, root.katex)) done++;
    }
    return done;
  }

  root.TroveMath = { available, enhance };
})(typeof window !== 'undefined' ? window : globalThis);
