'use strict';
/*
 * 引用补齐（v1.6）回归：纯 Node，不启 Electron。
 *
 * 三块新能力，各自守一条「容易被写成看起来对、实际不对」的边界：
 *   1. 作者消歧：同姓不同人时才补首字母；同一个人重复出现、只有一个人姓 Smith 时不许补。
 *   2. 脚注体：各文献类型（期刊 / 图书 / 章节 / 网页）该有的片段要有，不该有的不许留悬空标点。
 *   3. 同上 / 前引：只有「紧接上一次」才是同上；中间隔了一条必须退到前引或短引注；
 *      collapse:'none' 时一条都不许缩写。
 * 另外验证 COinS：字段映射、百分号编码、HTML 属性里的 & 转义。
 */
const assert = require('assert');

const Cite = require('../src/cite.js');
const Bib = require('../src/bib.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.log('  FAIL ' + name + (detail === undefined ? '' : ' :: ' + detail));
}
function eq(name, got, want) {
  ok(name, got === want, 'got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want));
}
function has(name, hay, needle) {
  ok(name, String(hay).indexOf(needle) >= 0, 'missing ' + JSON.stringify(needle) + ' in ' + JSON.stringify(hay));
}
function lacks(name, hay, needle) {
  ok(name, String(hay).indexOf(needle) < 0, 'unexpected ' + JSON.stringify(needle) + ' in ' + JSON.stringify(hay));
}

// ---------- 夹具 ----------
const smithJ = {
  key: 'a1', itemType: 'journalArticle', title: 'Deep Learning', year: '2020',
  publication: 'Nature', volume: '521', issue: '7553', pages: '436-444',
  doi: '10.1038/nature14539',
  creators: [{ firstName: 'John', lastName: 'Smith', creatorType: 'author' }],
};
const smithR = {
  key: 'a2', itemType: 'journalArticle', title: 'Attention Is All You Need', year: '2020',
  publication: 'NeurIPS', creators: [{ firstName: 'Robert', lastName: 'Smith', creatorType: 'author' }],
};
const soloLee = {
  key: 'a3', itemType: 'book', title: 'A Lone Author', year: '2019',
  publication: 'Some Press', creators: [{ firstName: 'Ann', lastName: 'Lee', creatorType: 'author' }],
};
const book = {
  key: 'b1', itemType: 'book', title: 'Thinking, Fast and Slow', year: '2011',
  publication: 'Farrar, Straus and Giroux',
  creators: [{ firstName: 'Daniel', lastName: 'Kahneman', creatorType: 'author' }],
};
const chapter = {
  key: 'b2', itemType: 'bookSection', title: 'A Chapter', year: '2019',
  publication: 'Big Book', pages: '10-30',
  creators: [{ firstName: 'Amy', lastName: 'Lee', creatorType: 'author' }],
};
const webpage = {
  key: 'b3', itemType: 'webpage', title: 'Some Page', year: '2023',
  publication: 'Blog', url: 'https://x.test/a',
  creators: [{ firstName: 'Bo', lastName: 'Ng', creatorType: 'author' }],
};
const cjkAuthor = {
  key: 'b4', itemType: 'journalArticle', title: '中文标题', year: '2021',
  publication: '某学报', creators: [{ firstName: '三', lastName: '张三', creatorType: 'author' }],
};

// ---------- 1. 作者消歧 ----------
{
  const labels = Cite.authorLabels([smithJ, smithR]);
  eq('同姓两人：两条都进消歧表', [labels.has('a1'), labels.has('a2')].join(','), 'true,true');
  ok('同姓两人的姓氏集合只含 smith', labels.get('a1').has('smith') && labels.get('a1').size === 1);
  eq('J. Smith 补首字母', Cite.citeInText(smithJ, { style: 'apa', ambiguous: labels.get('a1') }), '(J. Smith, 2020)');
  eq('R. Smith 补首字母', Cite.citeInText(smithR, { style: 'apa', ambiguous: labels.get('a2') }), '(R. Smith, 2020)');

  const alone = Cite.authorLabels([soloLee]);
  eq('只有一个 Lee：不补首字母', alone.size, 0);
  eq('不补时保持原样', Cite.citeInText(soloLee, { style: 'apa' }), '(Lee, 2019)');

  // 同一个人出现两次（两条都是 John Smith）→ 不算撞车
  const dup = Object.assign({}, smithJ, { key: 'a1b', title: 'Another Paper' });
  const labels2 = Cite.authorLabels([smithJ, dup]);
  eq('同一个人重复出现不算撞车', labels2.size, 0);

  // 中文名没有首字母概念：撞车也不许产出乱码
  const cjk2 = Object.assign({}, cjkAuthor, { key: 'b5', firstName: '四', title: '另一个标题' });
  const labels3 = Cite.authorLabels([cjkAuthor, cjk2]);
  ok('中文同名不产出拉丁首字母', !labels3.size ||
    Array.from(labels3.get('b4') || []).every((s) => !/[a-z]/.test(s)));
  eq('中文作者引注原样', Cite.citeInText(cjkAuthor, { style: 'apa' }), '(张三, 2021)');

  // 传了 ambiguous 但没有这一条：不能崩，也不能乱补
  eq('未命中消歧表时原样', Cite.citeInText(smithJ, { style: 'apa', ambiguous: new Set() }), '(Smith, 2020)');
  eq('没有 ambiguous 参数也原样', Cite.citeInText(smithJ, { style: 'apa' }), '(Smith, 2020)');
  eq('MLA 也不带年份', Cite.citeInText(smithJ, { style: 'mla' }), '(Smith)');
  eq('编号制不受消歧影响', Cite.citeInText(smithJ, { style: 'ieee', num: 7 }), '[7]');
}

// ---------- 2. 脚注体 ----------
{
  const s = Cite.noteCite(smithJ);
  has('期刊：作者姓在前', s, 'Smith, John.');
  has('期刊：题名带引号', s, '“Deep Learning.”');
  has('期刊：刊名斜体', s, '*Nature*');
  has('期刊：卷期年页', s, '521, no. 7553 (2020): 436-444.');
  has('期刊：DOI 变链接', s, 'https://doi.org/10.1038/nature14539');
  lacks('期刊：不留「DOI:」残片', s, 'DOI:');

  const b = Cite.noteCite(book);
  has('图书：书名斜体', b, '*Thinking, Fast and Slow*.');
  has('图书：出版社与年', b, 'Farrar, Straus and Giroux, 2011.');
  lacks('图书：句点不进斜体', b, 'Slow.*');

  const c = Cite.noteCite(chapter);
  has('章节：In + 书名', c, 'In *Big Book*');
  has('章节：页码与年', c, '10-30, 2019.');

  const w = Cite.noteCite(webpage);
  has('网页：题名带引号', w, '“Some Page.”');
  has('网页：URL', w, 'https://x.test/a');

  // 定位符：有就补在末尾，没有就不留空标点
  has('定位符附在末尾', Cite.noteCite(smithJ, { locator: 'p. 12' }), 'p. 12.');
  ok('无定位符不留双句点', !/\.\.\s*$/.test(Cite.noteCite(smithJ)));

  // 无作者 / 无题名不许崩
  ok('无作者不崩', typeof Cite.noteCite({ key: 'x', itemType: 'document', title: 'T' }) === 'string');
  eq('无条目返回空串', Cite.noteCite(null), '');

  // 短引注
  eq('短引注：姓 + 短题名 + 定位符',
    Cite.shortNote(smithJ, { locator: 'p. 5' }), 'Smith, Deep Learning, p. 5.');
  eq('短引注无定位符', Cite.shortNote(book), 'Kahneman, Thinking, Fast and Slow.');
  eq('短引注不重复句点', Cite.shortNote({ key: 'q', title: 'X', creators: [] }), 'X.');
}

// ---------- 3. 同上 / 前引 ----------
{
  const labels = Cite.authorLabels([smithJ, smithR]);
  const seq = Cite.citeSequence([
    { it: smithJ },
    { it: smithJ, locator: 'p. 7' },
    { it: smithR },
    { it: smithJ },
  ], { ambiguous: labels });
  eq('四条都有输出', seq.length, 4);
  eq('第一条完整', seq[0].form, 'full');
  eq('紧接同一条 → 同上', seq[1].form, 'ibid');
  eq('同上带定位符', seq[1].text, 'Ibid., p. 7');
  eq('换一条 → 完整', seq[2].form, 'full');
  eq('隔了一条再回来 → 短引注（不是同上）', seq[3].form, 'short');
  has('短引注带消歧首字母', seq[3].text, 'J. Smith');

  const zh = Cite.citeSequence([{ it: smithJ }, { it: smithJ, locator: '第 3 页' }],
    { ambiguous: labels, locale: 'zh' });
  eq('中文同上', zh[1].text, '同上，第 3 页。');

  const op = Cite.citeSequence([
    { it: smithJ }, { it: smithR }, { it: smithJ, locator: 'p. 9' },
  ], { ambiguous: labels, collapse: 'opcit' });
  eq('opcit：隔一条 → 前引', op[2].form, 'opcit');
  eq('前引英文', op[2].text, 'J. Smith, op. cit., p. 9.');

  const opZh = Cite.citeSequence([{ it: smithJ }, { it: smithR }, { it: smithJ }],
    { ambiguous: labels, collapse: 'opcit', locale: 'zh' });
  eq('前引中文', opZh[2].text, 'J. Smith，前引。');

  const none = Cite.citeSequence([{ it: smithJ }, { it: smithJ }], { collapse: 'none' });
  eq('collapse:none 不出同上', none[1].form, 'full');
  eq('collapse:none 两条完全一致', none[0].text, none[1].text);

  // 坏输入：空数组、null 条目、缺 key
  eq('空序列', Cite.citeSequence([], {}).length, 0);
  eq('非数组当空处理', Cite.citeSequence(null, {}).length, 0);
  const bad = Cite.citeSequence([null, { it: { title: 'NoKey', itemType: 'book' } }], {});
  eq('null 条目给空串而不是崩', bad[0].text, '');
  eq('缺 key 时用标题当身份', bad[1].form, 'full');
}

// ---------- 4. COinS ----------
{
  const one = Bib.build([smithJ], { style: 'apa', format: 'html', includeKeys: true });
  has('HTML 里带 Z3988', one.html, 'class="Z3988"');
  has('COinS 有 ctx_ver', one.html, 'ctx_ver=Z39.88-2004');
  has('COinS 用 journal 的 val_fmt', one.html, 'mtx%3Ajournal');
  has('COinS 有 atitle', one.html, 'rft.atitle=Deep%20Learning');
  has('COinS 有 jtitle', one.html, 'rft.jtitle=Nature');
  has('COinS 有 DOI', one.html, 'rft_id=info%3Adoi%2F10.1038%2Fnature14539');
  has('COinS 的属性用 &amp; 连接', one.html, '&amp;rft.genre');
  lacks('COinS 里不出现裸 &（除 &amp;）', one.html.replace(/&amp;/g, ''), '&');
  has('COinS 拆出 spage', one.html, 'rft.spage=436');
  has('COinS 拆出 epage', one.html, 'rft.epage=444');

  const bk = Bib.coinsFor(book);
  has('图书用 btitle', bk, 'rft.btitle=');
  has('图书 genre=book', bk, 'rft.genre=book');
  const ch = Bib.coinsFor(chapter);
  has('章节 genre=bookitem', ch, 'rft.genre=bookitem');
  has('章节仍带书名', ch, 'rft.btitle=Big%20Book');
  // R-v1.6-08：章节的篇名必须是 atitle，不能也写成 btitle（否则解析器拿书名当篇名查）
  has('章节篇名走 atitle', ch, 'rft.atitle=A%20Chapter');
  ok('章节只有一个 btitle（书名）', (ch.match(/rft\.btitle=/g) || []).length === 1, ch);
  ok('章节的 btitle 是书名不是篇名', decodeURIComponent(ch).indexOf('rft.btitle=Big Book') >= 0, ch);

  // 标识符实际存在 fields 里
  const withIds = Object.assign({}, book, {
    fields: { isbn: '978-1-11-111111-1', issn: '1111-2222', publisher: 'Real Press' },
  });
  const ids = Bib.coinsFor(withIds);
  has('ISBN 从 fields 读', ids, 'rft.isbn=978-1-11-111111-1');
  has('ISSN 从 fields 读', ids, 'rft.issn=1111-2222');
  has('出版社从 fields 读', ids, 'rft.pub=Real%20Press');

  // 纯文本 / Markdown / RTF 不该混进 COinS
  const txt = Bib.build([smithJ], { style: 'apa', format: 'text' });
  lacks('纯文本不带 COinS', txt.text, 'Z3988');
  const rtf = Bib.build([smithJ], { style: 'apa', format: 'rtf' });
  lacks('RTF 不带 COinS', rtf.text, 'Z3988');

  // 缺字段时不产出空键
  const bare = Bib.coinsFor({ key: 'z', itemType: 'document', title: 'Bare' });
  lacks('缺 DOI 时不留 rft_id', bare, 'rft_id');
  lacks('缺页码时不留 rft.pages', bare, 'rft.pages');
}

console.log('test-cite-note: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
