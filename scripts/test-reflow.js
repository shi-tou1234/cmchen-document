'use strict';
/*
 * 重排阅读（v36）回归：纯 Node。
 *
 * src/reflow.js 只做「文本项 → 行 → 段落 → 块」，不碰 DOM。这里按它内部的四步分别测：
 *   1. joinText：断词连字符、中文不加空格
 *   2. groupLines：同基线合并、词间补空格
 *   3. detectColumns：双栏要认出来，单栏绝不能切错
 *   4. buildParagraphs / reflowPage：间距、缩进、标题字号、列表、页码页眉
 *   5. reflowDoc：跨页断段接续
 * 渲染层（重排覆盖层、字号栏宽）在 Electron 端由 scripts/test-reflow-ui.js 验。
 */
const R = require('../src/reflow.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.log('  FAIL ' + name + (detail === undefined ? '' : ' :: ' + detail));
}
function eq(name, got, want) {
  ok(name, got === want, 'got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want));
}

// 造文本项：一行一个 item（w 按字符数估）
function item(str, x, y, fh, w) {
  return { str, x, y, w: w === undefined ? str.length * fh * 0.5 : w, fh };
}

// ---------- 1. 拼接 ----------
console.log('1. joinText');
{
  eq('英文断词接上', R.joinText('inter-', 'national'), 'international');
  eq('已有连字符的复合词不合并（下一行大写）', R.joinText('well-', 'Known'), 'well- Known');
  eq('拉丁词之间加空格', R.joinText('hello', 'world'), 'hello world');
  eq('中文之间不加空格', R.joinText('深度', '学习'), '深度学习');
  eq('中文接英文也不加空格', R.joinText('用', 'PDF'), '用PDF');
  eq('空串不产生多余空格', R.joinText('', 'x'), 'x');
  eq('行尾空白先去掉', R.joinText('abc  ', 'def'), 'abc def');
}

// ---------- 2. 聚行 ----------
console.log('2. groupLines');
{
  const lines = R.groupLines([
    item('Hello', 10, 100, 10), item('world', 45, 100, 10),
    item('second line', 10, 120, 10),
  ]);
  eq('同行合并成一行', lines.length, 2);
  eq('同一行文本项按 x 排序并补空格', lines[0].text, 'Hello world');
  eq('行高记录', lines[0].h, 10);
  eq('行序按 y 排', lines[1].text, 'second line');

  const cjk = R.groupLines([item('深度', 10, 100, 10), item('学习', 30, 100, 10)]);
  eq('同行的中文不补空格', cjk[0].text, '深度学习');

  const tight = R.groupLines([item('ab', 10, 100, 10), item('cd', 21, 100, 10)]);
  eq('紧挨着的两段不补空格', tight[0].text, 'abcd');
  const spaced = R.groupLines([item('ab', 10, 100, 10), item('cd', 26, 100, 10)]);
  eq('明显是一个词距时补空格', spaced[0].text, 'ab cd');

  eq('空输入', R.groupLines([]).length, 0);
  eq('丢弃空白项', R.groupLines([item('   ', 0, 0, 10)]).length, 0);
}

// ---------- 3. 分栏 ----------
console.log('3. detectColumns');
{
  // 单栏：整行横跨中间
  const one = [];
  for (let i = 0; i < 24; i++) one.push(item('x'.repeat(70), 40, 100 + i * 12, 10, 380));
  eq('整行横跨中间 → 单栏', R.detectColumns(one, 500).length, 1);

  // 双栏：左右各 12 行，互不越界
  const two = [];
  for (let i = 0; i < 12; i++) two.push(item('left col line', 40, 100 + i * 12, 10, 180));
  for (let i = 0; i < 12; i++) two.push(item('right col line', 270, 100 + i * 12, 10, 180));
  const cols = R.detectColumns(two, 500);
  eq('左右各一批 → 两栏', cols.length, 2);
  eq('左栏右边界在中线', cols[0].x1, 250);
  eq('右栏从中间开始', cols[1].x0, 250);

  // 文字太少时不下判断（宁可当单栏）
  eq('样本太少不分栏', R.detectColumns(two.slice(0, 4), 500).length, 1);
  eq('没有宽度信息不分栏', R.detectColumns(two, 0).length, 1);
}

// ---------- 4. 段落与块 ----------
console.log('4. reflowPage');
{
  const items = [
    // 页眉页码：要被丢掉
    item('12', 250, 20, 8),
    // 标题：字号明显大
    item('1 Introduction', 40, 60, 18),
    // 三段正文：行距 12，段间距 24
    item('This is the first paragraph of the paper', 40, 100, 10),
    item('and it continues on the next line here.', 40, 112, 10),
    item('Second paragraph starts after a bigger gap', 40, 136, 10),
    item('and also has a second line.', 40, 148, 10),
    // 列表
    item('• first bullet point', 40, 176, 10),
    item('• second bullet point', 40, 188, 10),
  ];
  const blocks = R.reflowPage(items, { width: 500 });
  const texts = blocks.map((b) => b.type + ':' + b.text);
  ok('页码被当成页眉丢掉', !blocks.some((b) => b.text === '12'), texts.join(' | '));
  eq('标题块', blocks[0].type, 'h2');
  eq('标题文本', blocks[0].text, '1 Introduction');
  eq('第一段把跨行接起来', blocks[1].text, 'This is the first paragraph of the paper and it continues on the next line here.');
  eq('段间距断段', blocks[2].text, 'Second paragraph starts after a bigger gap and also has a second line.');
  eq('列表项去掉项目符号', blocks[3].text, 'first bullet point');
  eq('列表类型', blocks[3].type, 'li');
  eq('两行相邻列表项不会被并成一段', blocks[4].text, 'second bullet point');

  // 缩进断段：首行缩进 20pt
  const indented = [
    item('first paragraph line one', 40, 100, 10),
    item('first paragraph line two', 40, 112, 10),
    item('    indented new paragraph', 60, 136, 10),
  ];
  const ib = R.reflowPage(indented, { width: 500 });
  eq('缩进开新段', ib.length, 2);
  eq('缩进段的正文去掉缩进', ib[1].text, 'indented new paragraph');

  // 单栏长文：不能因为分栏误判被拆开
  const single = [];
  for (let i = 0; i < 20; i++) single.push(item('line number ' + i + ' of a single column body', 40, 100 + i * 12, 10, 360));
  const sb = R.reflowPage(single, { width: 500 });
  eq('单栏长文仍然是一大段', sb.length, 1);
  ok('单栏长文内容完整', sb[0].text.indexOf('line number 0') >= 0 && sb[0].text.indexOf('line number 19') >= 0, sb[0].text.slice(0, 60));
}

// ---------- 5. 跨页 ----------
console.log('5. reflowDoc');
{
  const p1 = { page: 1, width: 500, items: [
    item('A paragraph that ends without any punctuation so it', 40, 100, 10),
    item('keeps going across the page break', 40, 112, 10),
  ] };
  const p2 = { page: 2, width: 500, items: [
    item('and finishes on the next page.', 40, 60, 10),
  ] };
  const doc = R.reflowDoc([p1, p2]);
  eq('跨页段落被接起来', doc[0].blocks[0].text,
    'A paragraph that ends without any punctuation so it keeps going across the page break and finishes on the next page.');
  // 第二页唯一的一段已经并进第一页，不该再产出一个空页
  eq('并完只剩一页', doc.length, 1);

  // 上一页以句号收尾：不接
  const q1 = { page: 1, width: 500, items: [item('A paragraph that ends with a full stop after enough words to pass.', 40, 100, 10)] };
  const q2 = { page: 2, width: 500, items: [item('Unrelated new page text.', 40, 60, 10)] };
  const doc2 = R.reflowDoc([q1, q2]);
  ok('句末标点收尾不接续', doc2[0].blocks[0].text.indexOf('Unrelated') < 0, doc2[0].blocks[0].text);
  eq('第二页保留自己的段落', doc2[1].blocks[0].text, 'Unrelated new page text.');

  eq('空文档', R.reflowDoc([]).length, 0);
  eq('单页只有空白项', R.reflowDoc([{ page: 1, width: 500, items: [item('  ', 0, 0, 10)] }]).length, 0);
}

console.log('test-reflow: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
