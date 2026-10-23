'use strict';
/*
 * 参考文献表回归。纯 Node，不启 Electron。
 * 覆盖：编号 / 排序 / 同年 a-b 后缀 / Markdown 与纯文本 / 引用键 / 缺字段容错。
 * 运行：node scripts/test-bib.js
 */
const path = require('path');
const Cite = require(path.join(__dirname, '..', 'src', 'cite.js'));
const Bib = require(path.join(__dirname, '..', 'src', 'bib.js'));

let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) console.log('  ok   ' + name);
  else { fail++; console.log('  FAIL ' + name + (detail ? '  <- ' + detail : '')); }
};

const journal = {
  key: 'j1', itemType: 'journalArticle', title: '深度学习综述',
  creators: ['张三', '李四'], year: '2020', publication: '计算机学报',
  volume: '43', issue: '2', pages: '100-110', doi: '10.1000/a',
};
const book = {
  key: 'b1', itemType: 'book', title: 'Alpha Book',
  creators: ['Brown, John'], year: '2019', publication: 'Press',
};
const thesis = {
  key: 't1', itemType: 'thesis', title: 'Gamma Thesis',
  creators: ['Adams, Amy'], year: '2021',
};
const items = [journal, book, thesis];

// ---------- GB/T：编号 + 保持传入顺序 ----------
let r = Bib.build(items, { style: 'gbt7714', title: '参考文献' });
ok('GB/T 默认按传入顺序', r.entries[0].startsWith('[1] 张三'), r.entries[0]);
ok('第二条编号递增', r.entries[1].startsWith('[2] BROWN J'), r.entries[1]);
ok('count 等于条目数', r.count === 3, String(r.count));
ok('numeric 标记为真', r.numeric === true);
ok('默认排序为 entry', r.order === 'entry', r.order);
ok('纯文本标题 + 空行', r.text.startsWith('参考文献\n\n[1] '), JSON.stringify(r.text.slice(0, 30)));
ok('纯文本条目之间单换行', r.text.indexOf('[1]') < r.text.indexOf('[2]') && !/\n\n\[2\]/.test(r.text));

// Markdown
r = Bib.build(items, { style: 'gbt7714', title: '参考文献', markdown: true });
ok('Markdown 标题用 ##', r.text.startsWith('## 参考文献\n\n[1] '), JSON.stringify(r.text.slice(0, 30)));
ok('Markdown 条目之间空行', /\n\n\[2\]/.test(r.text), JSON.stringify(r.text.slice(0, 120)));
ok('标题已带 # 时不重复加', Bib.build(items, { style: 'gbt7714', markdown: true, title: '# 引用' })
  .text.startsWith('# 引用\n\n'), 'title');

// ---------- APA：作者字母序 + 同年后缀 ----------
r = Bib.build(items, { style: 'apa', title: '' });
ok('APA 默认按作者字母序（Adams 在前）', /^Adams, A\./.test(r.entries[0]), r.entries[0]);
ok('APA 第二作者 Brown', /^Brown, J\./.test(r.entries[1]), r.entries[1]);
ok('APA 条目不带编号', !/^\[\d+\]/.test(r.entries[0]), r.entries[0]);
ok('APA 默认排序为 author', r.order === 'author', r.order);
ok('汉字作者按拼音排序（李在张前）', (() => {
  const zh = Bib.build([
    { key: 'zz', itemType: 'journalArticle', title: 'Z', creators: ['张三'], year: '2020' },
    { key: 'll', itemType: 'journalArticle', title: 'L', creators: ['李四'], year: '2020' },
  ], { style: 'apa' });
  return zh.entries[0].indexOf('李四') === 0;
})());

const sameYear = [
  { key: 's2', itemType: 'journalArticle', title: 'Beta Study', creators: ['Smith, John'], year: '2020', publication: 'J' },
  { key: 's1', itemType: 'journalArticle', title: 'Alpha Study', creators: ['Smith, John'], year: '2020', publication: 'J' },
];
r = Bib.build(sameYear, { style: 'apa', order: 'author' });
ok('同作者同年按标题排并补 a/b', r.entries[0].indexOf('(2020a)') > 0 && r.entries[1].indexOf('(2020b)') > 0,
  r.entries.join(' | '));
ok('同年后缀按标题顺序，不是输入顺序', r.entries[0].indexOf('Alpha Study') > 0, r.entries[0]);

// ---------- IEEE：按列表序号重编号 ----------
ok('IEEE 单条默认仍是 [1]', Cite.ieee(journal).startsWith('[1] '), Cite.ieee(journal).slice(0, 20));
ok('IEEE 可指定序号', Cite.format(journal, 'ieee', 7).startsWith('[7] '), Cite.format(journal, 'ieee', 7).slice(0, 20));
r = Bib.build(items, { style: 'ieee' });
ok('IEEE 参考文献表从 [1] 连续编号', r.entries[0].startsWith('[1] ') && r.entries[1].startsWith('[2] '),
  r.entries[0].slice(0, 20) + ' / ' + r.entries[1].slice(0, 20));

// ---------- 引用键 ----------
r = Bib.build(items, { style: 'gbt7714', includeKeys: true });
ok('纯文本附引用键', /\[@[a-z0-9-]+\]/.test(r.entries[0]), r.entries[0]);
ok('引用键来自整库 Map', Bib.build(items, {
  style: 'gbt7714', includeKeys: true,
  citekeys: new Map([['j1', 'zhang2020deep']]),
}).entries[0].indexOf('[@zhang2020deep]') > 0);
r = Bib.build(items, { style: 'gbt7714', includeKeys: true, markdown: true });
ok('Markdown 引用键用反引号包住', r.entries[0].indexOf('`[@') > 0, r.entries[0]);

// ---------- 显式排序覆盖 ----------
r = Bib.build(items, { style: 'apa', order: 'entry' });
ok('作者-年份样式也能按条目顺序输出', /^张三/.test(r.entries[0]), r.entries[0]);
r = Bib.build(items, { style: 'gbt7714', order: 'author' });
ok('编号样式也能显式按作者排序', /^\[1\] ADAMS A/.test(r.entries[0]), r.entries[0]);

// ---------- 过滤 / 容错 ----------
r = Bib.build([
  { key: 'x1', title: '', creators: ['A'], year: '2020' },
  { key: 'x2', title: '在回收站', deletedAt: 1 },
  { key: 'x3', title: '正常' },
  { key: 'x3', title: '重复 key 只保留一条' },
], { style: 'gbt7714' });
ok('跳过无标题与已删除条目', r.count === 1 && r.skipped === 2, 'count=' + r.count + ' skipped=' + r.skipped);
ok('按 key 去重', r.entries.length === 1 && r.entries[0].indexOf('正常') > 0, r.entries[0]);
r = Bib.build([], { style: 'gbt7714', title: '参考文献' });
ok('空列表返回空文本', r.text === '' && r.count === 0, JSON.stringify(r.text));
r = Bib.build([{ title: '只有标题' }], { style: 'gbt7714', title: '' });
ok('缺作者/年份也能排', r.count === 1 && r.entries[0].indexOf('只有标题') > 0, r.entries[0]);
ok('未知样式退回 GB/T', Bib.build([journal], { style: 'nope' }).entries[0].startsWith('[1] '));

// ---------- HTML / Word 导出 ----------
// 目的：省掉「粘进 Word 再排版」这一步。编号制用 <ol>，作者-年份制用 <ul>。
r = Bib.build(items, { style: 'gbt7714', format: 'html', title: '参考文献' });
ok('html：编号制用有序列表', r.text.indexOf('<ol class="references">') >= 0, r.text.slice(0, 120));
ok('html：标题是 h2', r.text.indexOf('<h2>参考文献</h2>') === 0, r.text.slice(0, 40));
ok('html：每条一个 li', (r.text.match(/<li>/g) || []).length === 3, r.text);
ok('html：条数不变', r.count === 3, 'count=' + r.count);
ok('html：正文不带 Markdown 的 ## 标题', r.text.indexOf('##') < 0, r.text.slice(0, 80));
ok('html：entries 仍是纯文本（给 UI 显示用）', !/<li>/.test(r.entries[0]), r.entries[0]);

r = Bib.build(items, { style: 'apa', format: 'html', title: '' });
ok('作者-年份制用无序列表', r.text.indexOf('<ul class="references">') >= 0 && r.text.indexOf('<ol') < 0, r.text.slice(0, 80));
ok('不加标题时没有 h2', r.text.indexOf('<h2') < 0, r.text.slice(0, 60));

r = Bib.build([journal], { style: 'gbt7714', format: 'html', includeKeys: true });
ok('html：引用键用 <code> 包住', /<code>\[@[^\]]+\]<\/code>/.test(r.text), r.text.slice(-160));

// 转义：正文里出现 < & > 时不能把结构破坏掉
const tricky = { key: 'z1', title: 'A < B & C > D', creators: ['E'], year: '2022' };
r = Bib.build([tricky], { style: 'gbt7714', format: 'html' });
ok('html：转义 & 与尖括号', r.text.indexOf('&amp;') > 0 && r.text.indexOf('&lt;') > 0 && r.text.indexOf('B &amp; C') > 0,
  r.text.slice(0, 200));
ok('html：转义后仍是 1 个 li', (r.text.match(/<li>/g) || []).length === 1, r.text);

r = Bib.build(items, { style: 'gbt7714', format: 'word', title: '参考文献' });
ok('word：有 HTML 外壳', /^<!DOCTYPE html>/.test(r.text) && r.text.indexOf('</html>') > 0, r.text.slice(0, 40));
ok('word：声明 utf-8（中文不乱码的前提）', r.text.indexOf('charset="utf-8"') > 0);
ok('word：正文里带着条目', r.text.indexOf('<ol class="references">') > 0 && r.text.indexOf('<li>') > 0);
ok('word：标题进了 <title>', r.text.indexOf('<title>参考文献</title>') > 0);
ok('word：带排版样式（字体 / 缩进）', /padding-left:2em/.test(r.text) && /font-size:12pt/.test(r.text));

// ---------- RTF 导出 ----------
// 目的：给「粘进 Word」提供最稳的一条路。RTF 必须是 7-bit 安全 + 结构正确，
// 否则 Word 打开会报「文件已损坏」或者中文全变问号。
r = Bib.build(items, { style: 'gbt7714', format: 'rtf', title: '参考文献' });
ok('rtf：有 RTF 头与结尾', /^\{\\rtf1/.test(r.text) && r.text.trim().endsWith('}'), r.text.slice(0, 40));
ok('rtf：声明了中文字体（fcharset134）', r.text.indexOf('\\fcharset134') > 0);
ok('rtf：中文写成 \\uN? 转义', /\\u-?\d+\?/.test(r.text));
ok('rtf：编号条目用悬挂缩进', r.text.indexOf('\\fi-360') > 0 && r.text.indexOf('\\tab') > 0);
ok('rtf：每条一行（li 数量对应 \\par）', (r.text.match(/\]\\tab /g) || []).length === 3, r.text);
ok('rtf：返回结构带 rtf 字段', typeof r.rtf === 'string' && r.rtf === r.text);
ok('rtf：includeKeys 也带上引用键', /\[@/.test(Bib.build(items, { style: 'gbt7714', format: 'rtf', includeKeys: true }).text));

// 转义：反斜杠和大括号不转义会直接把 RTF 结构弄坏
r = Bib.build([{ key: 'r1', title: 'A {B} \\ C', creators: ['E'], year: '2022' }], { style: 'gbt7714', format: 'rtf' });
ok('rtf：大括号与反斜杠被转义',
  r.text.indexOf('\\{') > 0 && r.text.indexOf('\\}') > 0 && r.text.indexOf('\\\\') > 0);
// 结构是否配平：把转义过的 \{ \} 去掉后再数，必须一一对应，否则 Word 会报文件损坏
const bare = r.text.replace(/\\[{}]/g, '');
ok('rtf：结构大括号配平',
  (bare.match(/\{/g) || []).length === (bare.match(/\}/g) || []).length, bare);

ok('rtfEscape 对普通 ASCII 原样输出', Bib.rtfEscape('abc 123') === 'abc 123');
ok('rtfEscape 把换行换成 \\par', Bib.rtfEscape('a\nb').indexOf('\\par') > 0);
ok('空表 rtf 返回空串', Bib.build([], { style: 'gbt7714', format: 'rtf' }).text === '');
ok('format=rtf 优先于 markdown',
  Bib.build(items, { style: 'gbt7714', markdown: true, format: 'rtf' }).text.indexOf('## ') < 0);

// 老调用方传 markdown: true 仍然有效
ok('老参数 markdown:true 仍然走 Markdown',
  Bib.build(items, { style: 'gbt7714', markdown: true, title: '参考文献' }).text.indexOf('## 参考文献') === 0);
ok('format 优先于 markdown',
  Bib.build(items, { style: 'gbt7714', markdown: true, format: 'text', title: '参考文献' }).text.indexOf('## ') < 0);
ok('返回结构带 format 字段', Bib.build(items, { style: 'gbt7714', format: 'word' }).format === 'word');
// 空表：不该导出空壳（主进程靠 text 为空来拦「没有可保存的内容」）
ok('空表 html 返回空串', Bib.build([], { style: 'gbt7714', format: 'html' }).text === '');
ok('空表 word 也不给外壳', Bib.build([], { style: 'gbt7714', format: 'word' }).text === '');
ok('只有删除标记的条目也算空表',
  Bib.build([{ key: 'd1', title: 'x', deletedAt: 1 }], { style: 'gbt7714', format: 'html' }).text === '');

ok('isNumeric 认识编号制', Bib.isNumeric('gbt7714') && Bib.isNumeric('ieee') && !Bib.isNumeric('apa'));
ok('defaultOrder 编号制为 entry', Bib.defaultOrder('ieee') === 'entry' && Bib.defaultOrder('apa') === 'author');
ok('STYLES 与 Cite 共用一份', Bib.STYLES === Cite.STYLES && Bib.STYLES.length === 5);

console.log('[bib] ' + (fail ? 'FAIL (' + fail + ')' : 'PASS'));
process.exit(fail ? 2 : 0);
