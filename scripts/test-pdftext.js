'use strict';
/*
 * 中文标注字体（v36）回归：真嵌一次字体。
 *
 * src/pdftext.js 做的是「用系统 CJK 字体 + 子集嵌入」导出带中文的标注副本。
 * 这里验四件事：
 *   1. 系统字体探测结果稳定（有就报路径，没有就明确返回 false，不能抛错）；
 *   2. 子集嵌入后 PDF 能存盘，体积远小于原字体（只打进用到的字形）；
 *   3. 字形覆盖探测：has() 对真有的字返回 true（用「汉」这种一定有的字）；
 *   4. sanitize 把缺字的字符换成 □，measure 不会因为缺字抛错。
 * 没有可用字体时（CI / 精简系统）本脚本跳过嵌入部分并打印原因，不算失败。
 * 运行：node scripts/test-pdftext.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const T = require('../src/pdftext.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.log('  FAIL ' + name + (detail === undefined ? '' : ' :: ' + detail));
}
function eq(name, got, want) {
  ok(name, got === want, 'got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want));
}

(async () => {
  // ---------- 1. 探测 ----------
  console.log('1. 候选字体');
  {
    ok('候选清单非空', Array.isArray(T.CANDIDATES) && T.CANDIDATES.length > 0);
    ok('候选里只有 TrueType（pdf-lib 吃不了 CFF）',
      T.CANDIDATES.every((p) => /\.ttf$/i.test(p) || /\.ttc$/i.test(p)), T.CANDIDATES.join(','));
    let threw = null;
    let hit = null;
    try { hit = T.findFontFile(); } catch (err) { threw = err; }
    eq('探测不抛错', threw, null);
    T.resetCache();
    ok('resetCache 后还能再探测', (() => { try { T.findFontFile(); return true; } catch (_) { return false; } })());
    if (!hit) {
      console.log('  （这台机器没有候选 CJK 字体，跳过嵌入部分）');
      console.log('test-pdftext: ' + pass + ' passed, ' + fail + ' failed (skipped embed)');
      process.exit(fail ? 1 : 0);
    }
    ok('探到一个真实存在的字体文件', fs.existsSync(hit.path), hit.path);
    ok('字体文件够大（不是占位文件）', hit.bytes.length > 1024 * 1024, hit.bytes.length);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-pdftext-'));
  try {
    // ---------- 2. 嵌入 + 子集 ----------
    console.log('2. 子集嵌入');
    const doc = await PDFDocument.create();
    const cjk = await T.embedCjkFont(doc);
    ok('拿到字体对象', !!cjk && !!cjk.font, cjk && cjk.path);
    if (cjk) {
      eq('再次嵌入复用同一套字体（不断言实例相同，只断言能拿到）', !!(await T.embedCjkFont(doc)), true);
      const page = doc.addPage([300, 200]);
      const text = '中文标注测试';
      page.drawText(text, { x: 20, y: 100, size: 14, font: cjk.font });
      const bytes = await doc.save();
      ok('导出字节非空', bytes.length > 800, bytes.length);
      ok('子集体积远小于原字体', bytes.length < 400 * 1024, 'pdf=' + bytes.length + ' font=' + cjk.path + '(' + fs.statSync(cjk.path).size + ')');

      const out = path.join(tmp, 'cjk.pdf');
      fs.writeFileSync(out, bytes);
      ok('落盘的文件头是 PDF', fs.readFileSync(out).slice(0, 5).toString() === '%PDF-');

      // ---------- 3. 字形覆盖 ----------
      console.log('3. 字形覆盖');
      eq('常用汉字有字形', cjk.has('汉'), true);
      eq('拉丁字母有字形', cjk.has('A'), true);
      eq('数字有字形', cjk.has('5'), true);
      // 半角勾选符号常缺（SimHei 就没有），所以只看「不抛错 + 返回布尔」
      ok('生僻符号的判定返回布尔', typeof cjk.has('✓') === 'boolean', cjk.has('✓'));

      // ---------- 4. sanitize / measure ----------
      console.log('4. sanitize / measure');
      eq('有字形的字符原样保留', T.sanitize('中文', cjk.has), '中文');
      const replaced = T.sanitize('中文✓', cjk.has);
      ok('缺字形的字符换成 □', replaced.length === 3 && (cjk.has('✓') ? replaced === '中文✓' : replaced === '中文□'), replaced);
      ok('宽度为正数', T.measure('中文标注', cjk.font, 12) > 0);
      ok('空串宽度为 0', T.measure('', cjk.font, 12) === 0);
      ok('错误字体也不抛错（退回估算）', T.measure('abc', null, 12) > 0);
    }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }

  // ---------- 5. 拉丁字体分支不受影响 ----------
  console.log('5. 兜底');
  {
    const doc = await PDFDocument.create();
    const latin = await doc.embedFont(StandardFonts.Helvetica);
    ok('纯拉丁标注仍可用 Helvetica', latin.widthOfTextAtSize('abc', 12) > 0);
  }

  console.log('test-pdftext: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.log('  FAIL 脚本抛错 :: ' + (err && err.message));
  process.exit(1);
});
