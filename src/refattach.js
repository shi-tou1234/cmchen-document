'use strict';
/*
 * EndNote XML 的附件路径还原。
 *
 * EndNote 导出的 XML 里，附件不是普通路径，而是「库内位置」：
 *   <urls><pdf-urls><url>internal-pdf://2295834576/Smith - 2020 - Title.pdf</url>
 * 那串数字是 EndNote 库 `.Data/PDF/` 下的分桶目录名，只有配上 .enl 库目录才有意义。
 * 用户通常只把 XML 拷出来，所以这里按「XML 所在目录」试几个常见落点，命中就接上。
 *
 * 试不到就安静放弃：「有题录没附件」是可接受的降级；编一个不存在的路径会让条目
 * 一打开就报「文件不见了」，比没有附件更烦。
 *
 * 单独成模块（而不是塞在 main.js 里）是为了能在 Node 里直接回归——主进程文件一
 * require 就会拉起 Electron。
 */
const fs = require('fs');
const path = require('path');

function candidatesFor(hint, baseDir, stem) {
  const rel = String(hint || '').replace(/^internal-pdf:\/\//i, '');
  if (!rel) return [];
  let decoded = rel;
  try { decoded = decodeURIComponent(rel); } catch (_) { decoded = rel; }
  const slash = decoded.indexOf('/');
  const host = slash > 0 ? decoded.slice(0, slash) : '';
  const rest = slash > 0 ? decoded.slice(slash + 1) : decoded;
  const out = [];
  if (host && rest) {
    out.push(path.join(baseDir, stem + '.Data', 'PDF', host, rest));
    out.push(path.join(baseDir, stem + '.Data', 'PDF', rest));
  }
  out.push(path.join(baseDir, stem + '.Data', 'PDF', decoded));
  out.push(path.join(baseDir, 'PDF', decoded));
  out.push(path.join(baseDir, decoded));
  return out;
}

/*
 * 就地改写 records：命中候选路径的条目补上 attachment，并删掉 attachmentHint。
 * 返回接上的数量。sourceFile 为空时只做清理，不找文件。
 */
function resolve(records, sourceFile) {
  const list = Array.isArray(records) ? records : [];
  const baseDir = sourceFile ? path.dirname(String(sourceFile)) : '';
  const stem = sourceFile ? path.basename(String(sourceFile)).replace(/\.[^.]+$/, '') : '';
  let linked = 0;
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const hint = r.attachmentHint;
    delete r.attachmentHint;   // 内部字段不进库
    if (!hint || !baseDir) continue;
    for (const c of candidatesFor(hint, baseDir, stem)) {
      try {
        if (fs.existsSync(c) && fs.statSync(c).isFile()) {
          r.attachment = { path: c };
          linked++;
          break;
        }
      } catch (_) { /* 单个候选不可读就试下一个 */ }
    }
  }
  return linked;
}

module.exports = { resolve, candidatesFor };
