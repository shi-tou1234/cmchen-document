'use strict';
/*
 * 导出带标注副本时的字体：Helvetica 只认 WinAnsi，中文（以及大部分非拉丁字符）
 * 在 pdf-lib 里会直接抛「WinAnsi cannot encode」。这里给它配一套系统 CJK 字体，
 * 用 fontkit 做子集嵌入——只把用到的字形打进去，一份标注副本多出来的体积通常只有几 KB。
 *
 * 不打包字体文件：CJK 字体动辄十几 MB，塞进安装包对「本地小工具」不划算。
 * 系统里没有可用字体时返回 null，导出照旧走 Helvetica（中文标注会记一条「未导出」）。
 */
const fs = require('fs');
const path = require('path');

// 各平台常见的「一定能显示中文」的字体，按优先级排。
// 只收 TrueType（.ttf）：pdf-lib 的嵌入器吃不了 .ttc 字体集合，也不吃 CFF 的 .otf。
const CANDIDATES = [
  // Windows
  'C:/Windows/Fonts/simhei.ttf',        // 黑体
  'C:/Windows/Fonts/msyh.ttf',          // 少数精简版系统里存在
  'C:/Windows/Fonts/simkai.ttf',        // 楷体
  'C:/Windows/Fonts/simfang.ttf',       // 仿宋
  'C:/Windows/Fonts/Deng.ttf',          // 等线
  'C:/Windows/Fonts/simsun.ttc',        // 宋体（TTC，通常加载失败，放在最后兜底尝试）
  // macOS
  '/System/Library/Fonts/Supplemental/Songti.ttc',
  '/Library/Fonts/Arial Unicode.ttf',
  '/System/Library/Fonts/Hiragino Sans GB.ttc',
  // Linux
  '/usr/share/fonts/truetype/arphic/uming.ttf',
  '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
];

let cached = null;      // { path, bytes } | false（false = 找过了，没有）

function findFontFile() {
  if (cached !== null) return cached;
  for (const p of CANDIDATES) {
    try {
      if (fs.existsSync(p)) {
        const st = fs.statSync(p);
        // 0 字节 / 异常的巨型文件都跳过：真读进 pdf-lib 也会抛
        if (st.isFile() && st.size > 1024 * 1024) { cached = { path: p, bytes: fs.readFileSync(p) }; return cached; }
      }
    } catch (_) {}
  }
  cached = false;
  return cached;
}

function resetCache() { cached = null; }

/**
 * 给 PDFDocument 装一套 CJK 字体（惰性嵌入、只嵌子集）。
 * @returns {Promise<{font, path, has:(ch)=>boolean}|null>}
 */
async function embedCjkFont(doc) {
  const hit = findFontFile();
  if (!hit) return null;
  try {
    const fontkit = require('@pdf-lib/fontkit');
    if (!doc.__fontkitRegistered) {
      doc.registerFontkit(fontkit);
      doc.__fontkitRegistered = true;
    }
    const font = await doc.embedFont(hit.bytes, { subset: true });
    // 用同一份字节再建一个 fontkit 对象查字形覆盖：pdf-lib 的 PDFFont 不暴露字符集，
    // 而「这个字有没有」决定了要不要退回画路径（比如 ✓ 在 SimHei 里就没有）。
    let probe = null;
    try { probe = fontkit.create(hit.bytes); } catch (_) { probe = null; }
    const has = (ch) => {
      if (!probe) return true;
      try {
        const g = probe.glyphsForString(String(ch))[0];
        return !!(g && g.id > 0);
      } catch (_) { return false; }
    };
    return { font, path: hit.path, has };
  } catch (_) {
    return null;
  }
}

// 一个字符串在给定字体下的宽度；字体缺字时按「半角」估，避免整条标注被跳过
function measure(text, font, size) {
  const s = String(text || '');
  if (!s) return 0;
  try { return font.widthOfTextAtSize(s, size); } catch (_) { return s.length * size * 0.5; }
}

// 逐字符过滤掉缺字形的字符（用于「有字总比整条丢掉好」的场合）
function sanitize(text, has) {
  let out = '';
  for (const ch of String(text || '')) out += (has && !has(ch)) ? '□' : ch;
  return out;
}

module.exports = { embedCjkFont, findFontFile, measure, sanitize, resetCache, CANDIDATES };
