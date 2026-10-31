'use strict';
/*
 * PDF 元数据写回（v1.6）回归：纯 Node，不启 Electron。
 *
 * 要守的三件事：
 *   1. **原文件一个字节都不动**——写 PDF 二进制不是无损操作，拿原文件冒险没有道理；
 *   2. 写进去的东西真的读得回来（Info 字典走 pdf-lib 的 getter，XMP 走原始字节）；
 *   3. 缺字段时不写空值、不抛异常；默认输出路径不覆盖已有文件。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

const W = require('../src/pdfwrite.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.log('  FAIL ' + name + (detail === undefined ? '' : ' :: ' + detail));
}
function eq(name, got, want) {
  ok(name, got === want, 'got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want));
}

const ITEM = {
  key: 'k1',
  title: 'Deep Learning',
  year: '2020',
  doi: '10.1038/nature14539',
  abstract: 'A long abstract about representation learning.',
  tags: ['ml', 'ai'],
  creators: [
    { firstName: 'John', lastName: 'Smith', creatorType: 'author' },
    { firstName: 'Ann', lastName: 'Lee', creatorType: 'author' },
    { firstName: 'Ed', lastName: 'Editor', creatorType: 'editor' },
  ],
};

async function makePdf(file) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 300]);
  page.drawText('hello', { x: 20, y: 200, size: 12 });
  fs.writeFileSync(file, await doc.save());
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-pdfmeta-'));
  try {
    const src = path.join(dir, 'paper.pdf');
    await makePdf(src);
    const before = fs.readFileSync(src);
    const beforeHash = require('crypto').createHash('sha1').update(before).digest('hex');

    // ---------- 1. 基本写入 ----------
    const r = await W.writeToCopy(ITEM, src);
    ok('写入成功', r.ok, JSON.stringify(r));
    ok('默认另存为副本', r.ok && r.path !== src, r.path);
    ok('副本文件名带后缀', /-元数据\.pdf$/.test(r.path), r.path);
    eq('原文件字节未变', require('crypto').createHash('sha1').update(fs.readFileSync(src)).digest('hex'), beforeHash);
    ok('副本比原文件大（多了元数据）', fs.statSync(r.path).size > before.length);

    const back = await PDFDocument.load(fs.readFileSync(r.path));
    eq('标题读得回', back.getTitle(), 'Deep Learning');
    eq('作者不含编辑', back.getAuthor(), 'Smith, John; Lee, Ann');
    eq('摘要进 Subject', back.getSubject(), 'A long abstract about representation learning.');
    eq('关键词进 Keywords', (back.getKeywords() || '').replace(/\s+/g, ' '), 'ml ai');
    eq('Creator 是 Trove', back.getCreator(), 'Trove');
    // pdf-lib 在序列化时会把 /Producer 改写成它自己的串，setProducer 留不住——
    // 所以「谁生成的」只写在 XMP 的 pdf:Producer 里（下面按原始字节验）。
    ok('写了 XMP', r.fields.xmp === true);

    const raw = fs.readFileSync(r.path).toString('latin1');
    ok('XMP 包在文件里', raw.indexOf('x:xmpmeta') >= 0);
    ok('XMP 有 dc:title', raw.indexOf('Deep Learning') >= 0);
    ok('XMP 有 DOI 标识', raw.indexOf('info:doi/10.1038/nature14539') >= 0);
    ok('XMP 有 ModifyDate', raw.indexOf('xmp:ModifyDate') >= 0);
    ok('XMP 记了生成工具', raw.indexOf('<pdf:Producer>Trove</pdf:Producer>') >= 0);

    // ---------- 2. 缺字段 ----------
    const bare = await W.writeToCopy({ key: 'k2', title: 'Only Title' }, src);
    ok('只有标题也能写', bare.ok, JSON.stringify(bare));
    const bareBack = await PDFDocument.load(fs.readFileSync(bare.path));
    eq('只有标题时作者为空', bareBack.getAuthor(), undefined);
    eq('只有标题时关键词为空', bareBack.getKeywords(), undefined);

    // ---------- 3. 默认输出不覆盖已有文件 ----------
    const again = await W.writeToCopy(ITEM, src);
    ok('第二次另存不覆盖第一份', again.ok && again.path !== r.path, again.path);
    ok('第二次文件名带序号', /-\d+-元数据\.pdf$/.test(again.path), again.path);
    ok('第一份还在', fs.existsSync(r.path));

    // ---------- 4. 指定输出路径 ----------
    const custom = path.join(dir, 'sub', 'out.pdf');
    const r3 = await W.writeToCopy(ITEM, src, custom);
    ok('指定路径会建目录并写入', r3.ok && fs.existsSync(custom), JSON.stringify(r3));

    // ---------- 5. 坏输入不抛 ----------
    const noPath = await W.writeToCopy(ITEM, '');
    ok('没有源文件 → ok:false', noPath.ok === false);
    const notPdf = path.join(dir, 'note.txt');
    fs.writeFileSync(notPdf, 'hello');
    const r4 = await W.writeToCopy(ITEM, notPdf);
    ok('非 PDF 后缀被拒', r4.ok === false && /PDF/.test(r4.error), r4.error);
    const broken = path.join(dir, 'broken.pdf');
    fs.writeFileSync(broken, 'not a pdf at all');
    const r5 = await W.writeToCopy(ITEM, broken);
    ok('坏 PDF 给可读错误', r5.ok === false && /解析不了/.test(r5.error), r5.error);
    const missing = await W.writeToCopy(ITEM, path.join(dir, 'nope.pdf'));
    ok('文件不存在给可读错误', missing.ok === false && /读不到/.test(missing.error), missing.error);

    // ---------- 5.5 中文 XMP 不能乱码（R-v1.6-03） ----------
    // 症状很隐蔽：Info 字典走 PDFHexString 一直是对的，只有真的打开 Metadata 流才看得见。
    {
      const cjk = await W.writeToCopy({
        key: 'k-cjk', title: '中文标题的实验', abstract: '这是一段中文摘要',
        tags: ['机器学习', '神经网络'],
        creators: [{ firstName: '小明', lastName: '王', creatorType: 'author' }],
      }, src);
      ok('中文条目也能写', cjk.ok, JSON.stringify(cjk));
      const utf8 = fs.readFileSync(cjk.path).toString('utf8');
      ok('XMP 里的中文标题没乱码', utf8.indexOf('>中文标题的实验<') >= 0,
        (utf8.match(/<dc:title>[\s\S]{0,120}/) || [''])[0]);
      ok('XMP 里的中文摘要没乱码', utf8.indexOf('这是一段中文摘要') >= 0);
      ok('XMP 里的中文关键词没乱码', utf8.indexOf('机器学习') >= 0 && utf8.indexOf('神经网络') >= 0);
      ok('XMP 里的中文作者没乱码', utf8.indexOf('王, 小明') >= 0);
      // Info 那边也照旧
      const cjkBack = await PDFDocument.load(fs.readFileSync(cjk.path));
      eq('Info 里的中文标题正常', cjkBack.getTitle(), '中文标题的实验');
      eq('Info 里的中文作者正常', cjkBack.getAuthor(), '王, 小明');
    }

    // ---------- 6. XMP 转义 ----------
    const tricky = await W.writeToCopy({
      key: 'k3', title: 'A & B <C> "D"', tags: ['x&y'], creators: [{ firstName: "O'Neil", lastName: 'Zed', creatorType: 'author' }],
    }, src);
    ok('特殊字符能写', tricky.ok, JSON.stringify(tricky));
    const tRaw = fs.readFileSync(tricky.path).toString('latin1');
    ok('标题里的 & 被转义', tRaw.indexOf('A &amp; B &lt;C&gt;') >= 0);
    ok('没有裸的 <C> 进 XMP', tRaw.indexOf('<C>') < 0);
    const tBack = await PDFDocument.load(fs.readFileSync(tricky.path));
    eq('Info 里的标题还原成原文', tBack.getTitle(), 'A & B <C> "D"');

    // ---------- 7. defaultOutPath ----------
    const p1 = W.defaultOutPath(path.join(dir, 'x.pdf'));
    ok('默认路径用同目录同名前缀', p1.indexOf('-元数据.pdf') > 0 && path.dirname(p1) === dir, p1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('test-pdf-meta: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e && e.stack || e); process.exit(3); });
