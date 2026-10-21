'use strict';
/*
 * 读 PDF 自带元数据（Title / Author / Subject / Keywords）。
 * 导入文献库时用得上：很多 PDF（尤其是从笔记软件、LaTeX、出版商导出的）
 * 元数据里就有真标题和作者，比从文件名猜靠谱得多。
 *
 * 已知边界：
 *   - PDF 元数据质量参差不齐（LaTeX 常写成 "LaTeX with hyperref"、
 *     Word 会写 "Microsoft Word - 文档1.doc"），所以这里只负责「取出来」，
 *     好不好用由调用方判断（本项目按 usableTitle / usableAuthor 过滤）。
 *   - 只读文档目录与信息字典，不渲染页面，100~300ms 量级。
 */
const fs = require('fs');
const path = require('path');

let pdfjs = null;
function lib() {
  if (!pdfjs) {
    // 与主进程全文索引同一套构建（main 进程里没有 DOM，pdf.js 走 fake worker）
    pdfjs = require('pdfjs-dist/build/pdf.js');
  }
  return pdfjs;
}

function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve(null); } }, ms || 6000);
    promise.then(
      (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } },
      () => { if (!done) { done = true; clearTimeout(t); resolve(null); } },
    );
  });
}

// 读一份 PDF 的元数据；任何异常都吞掉，返回 {}
async function readMeta(filePath) {
  let doc = null;
  try {
    if (!filePath || !fs.existsSync(filePath)) return {};
    const p = lib();
    const data = new Uint8Array(fs.readFileSync(filePath));
    const task = p.getDocument({
      data,
      useWorkerFetch: false,
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      verbosity: 0,
    });
    doc = await withTimeout(task.promise, 8000);
    if (!doc) return {};
    const meta = await withTimeout(doc.getMetadata(), 4000);
    const info = (meta && meta.info) || {};
    const out = {
      title: String(info.Title || '').trim(),
      author: String(info.Author || '').trim(),
      subject: String(info.Subject || '').trim(),
      keywords: String(info.Keywords || '').trim(),
    };
    return out;
  } catch (_) {
    return {};
  } finally {
    try { if (doc) await doc.destroy(); } catch (_) {}
  }
}

// 元数据里的标题能不能用：太长的、还是文件名的、占位符的，一律不要
function usableTitle(t) {
  const s = String(t || '').trim();
  if (!s || s.length > 200) return '';
  if (/^(untitled|unknown|document\s*\d*|microsoft\s+word.*|print|打印输出|文档\d*)$/i.test(s)) return '';
  if (/^[\w一-龥\s.\-–_]+\.(pdf|docx?|tex|dvi|indd|md)$/i.test(s)) return '';   // 还是文件名
  if (/\\/.test(s)) return '';                                                 // 路径
  if (/^(latex|beamer|article|book|elsarticle|revtex4)/i.test(s)) return '';    // 模板名
  return s;
}

// 作者字段能不能用
function usableAuthor(a) {
  const s = String(a || '').trim();
  if (!s || s.length > 120) return '';
  if (/[{}\\]/.test(s)) return '';         // LaTeX 宏残留
  if (/^(unknown|user|admin|author)$/i.test(s)) return '';
  return s;
}

module.exports = { readMeta, usableTitle, usableAuthor, basename: path.basename };
