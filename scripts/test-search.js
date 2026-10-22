'use strict';
/*
 * 检索补强回归（2026-10-22，报告优先级第 1 项）：短语 / 排除 / 字段限定 / CJK /
 * 变音折叠 / 相关性排序。两层：
 *   A. 纯 Node 单测：query.js 解析与匹配、fulltext.search 的评分排序（真实索引文件）。
 *   B. 探针：真实 app 里跑 window.Query 库内筛选 + lib.searchFull 端到端。
 * 运行：node scripts/test-search.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Q = require('../src/query.js');
const fulltext = require('../src/fulltext.js');

let fail = 0, total = 0;
function check(name, ok, detail) {
  total++;
  if (!ok) { fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  <- ' + JSON.stringify(detail) : '')); }
  else console.log('  ok   ' + name);
}

// ---------- A1. 解析器 ----------
{
  const ast = Q.parseQuery('机器学习 "deep learning" -综述 title:survey author:"John Smith" tag:方法');
  check('CJK 串解析为短语 token', ast.text.length === 2 && ast.text[0].t === '机器学习' && ast.text[0].phrase === true, ast.text);
  check('引号短语解析', ast.text[1].t === 'deep learning' && ast.text[1].phrase === true, ast.text[1]);
  check('排除 token 进 not', ast.not.length === 1 && ast.not[0].t === '综述', ast.not);
  check('字段限定进 fields', ast.fields.title && ast.fields.title[0].t === 'survey'
    && ast.fields.author && ast.fields.author[0].t === 'john smith'
    && ast.fields.tag && ast.fields.tag[0].t === '方法', ast.fields);

  const alias = Q.parseQuery('creator:张三 notes:摘要 itemtype:book attachment:a.pdf journal:Nature');
  check('字段别名（creator/notes/itemtype/attachment/journal）',
    !!alias.fields.author && !!alias.fields.note && !!alias.fields.type && !!alias.fields.file && !!alias.fields.publication, alias.fields);

  const dash = Q.parseQuery('foo-bar -x end-');
  check('词中减号不算排除', dash.text.length === 2 && dash.text[0].t === 'foo-bar', dash.text);
  check('排除 token 命中 not', dash.not.length === 1 && dash.not[0].t === 'x', dash.not);

  const zhq = Q.parseQuery('“深度学习” -“文献综述”');
  check('中文引号短语与排除', zhq.text[0].t === '深度学习' && zhq.not[0].t === '文献综述', zhq);

  check('空查询', Q.parseQuery('   ').text.length === 0 && Object.keys(Q.parseQuery('  ').fields).length === 0);

  // fold：变音 / 弯引号 / 空白归一；韩文等非拉丁扩展不做 NFD（长度不变）
  check('fold 变音折叠', Q.fold('Café naïve') === 'cafe naive', Q.fold('Café naïve'));
  check('fold 弯引号', Q.fold('can’t “ok”') === "can't \"ok\"", Q.fold('can’t “ok”'));
  check('fold 空白归一', Q.fold('a  b\n\tc') === 'a b c', Q.fold('a  b\n\tc'));
  check('fold 韩文长度不变', Q.fold('한국어').length === 3, Q.fold('한국어'));
}

// ---------- A2. 条目匹配 ----------
{
  const it = {
    title: 'Deep Learning for NLP', itemType: 'journalArticle',
    creators: [{ firstName: 'John', lastName: 'Smith', creatorType: 'author' }, '张三'],
    year: 2024, publication: 'Nature Machine Intelligence', tags: ['方法', 'survey'],
    abstract: 'We study café models.', notes: [{ id: 'n1', title: '读后感', text: '值得复读的深度学习综述' }],
    attachment: { path: 'C:/x/dl.pdf', name: 'dl-nlp-2024.pdf' },
  };
  check('普通词命中', Q.matchLibraryItem(it, Q.parseQuery('learning')) === true);
  check('多词 AND', Q.matchLibraryItem(it, Q.parseQuery('deep nlp')) === true);
  check('多词 AND 不中的', Q.matchLibraryItem(it, Q.parseQuery('deep quantum')) === false);
  check('排除生效', Q.matchLibraryItem(it, Q.parseQuery('learning -nature')) === false);
  check('排除不命中则通过', Q.matchLibraryItem(it, Q.parseQuery('learning -quantum')) === true);
  check('title: 字段限定', Q.matchLibraryItem(it, Q.parseQuery('title:learning')) === true);
  check('title: 不查全文', Q.matchLibraryItem(it, Q.parseQuery('title:nature')) === false);
  check('author: 结构化姓名', Q.matchLibraryItem(it, Q.parseQuery('author:smith')) === true);
  check('author: 中文作者', Q.matchLibraryItem(it, Q.parseQuery('author:张三')) === true);
  check('tag: 标签', Q.matchLibraryItem(it, Q.parseQuery('tag:方法')) === true);
  check('note: 阅读笔记', Q.matchLibraryItem(it, Q.parseQuery('note:读后感')) === true);
  check('file: 附件名', Q.matchLibraryItem(it, Q.parseQuery('file:dl-nlp')) === true);
  check('year: 年份', Q.matchLibraryItem(it, Q.parseQuery('year:2024')) === true);
  check('type: 条目类型', Q.matchLibraryItem(it, Q.parseQuery('type:journalarticle')) === true);
  check('变音折叠命中（cafe→café）', Q.matchLibraryItem(it, Q.parseQuery('cafe')) === true);
  check('组合多个字段+词', Q.matchLibraryItem(it, Q.parseQuery('deep tag:survey year:2024 -quantum')) === true);
  check('matchFields 字段不中则 false', Q.matchFields(it, Q.parseQuery('title:quantum')) === false);
  check('matchFields 字段中则 true', Q.matchFields(it, Q.parseQuery('title:deep')) === true);
  check('matchNone 排除语义', Q.matchNone('has methods here', [{ t: 'methods', phrase: false }]) === false
    && Q.matchNone('clean text', [{ t: 'methods', phrase: false }]) === true);
}

// ---------- A3. fulltext.search 评分排序（真实索引文件） ----------
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-search-'));
  fulltext.init(tmp);
  const mk = (name, pages) => {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, 'x');
    return p;
  };
  // 路径故意让「低频命中」排前面：若仍按路径排序，低频的 a.pdf 会排第一
  const pHigh = mk('z-high.pdf', null);
  const pLow = mk('a-low.pdf', null);
  const write = (p, pages) => {
    const f = fulltext.fileFor(p);
    fs.writeFileSync(f, JSON.stringify({
      version: 1, path: p, size: 1, mtimeMs: 1, indexedAt: 1, numPages: pages.length, chars: 1,
      pages: pages.map((text, i) => ({ page: i + 1, text })),
    }));
  };
  write(pHigh, [
    'deep learning appears once here',
    'deep learning deep learning deep learning methods for text',
  ]);
  write(pLow, [
    'deep learning mentioned briefly once',
  ]);

  const r1 = fulltext.search('deep learning');
  check('全文检索命中三页', r1.results.length === 3, r1.results.length);
  check('排序按相关性（高频页第一）', r1.results[0].path === pHigh && r1.results[0].page === 2, r1.results.slice(0, 2).map((r) => r.path + ':' + r.page));
  check('低频文档不因路径靠前而排第一', r1.results[0].path !== pLow, r1.results.map((r) => r.path));
  check('多词命中 count 为总次数', r1.results[0].count === 6, r1.results[0].count);

  const r2 = fulltext.search('"deep learning methods"');
  check('引号短语只命中短语所在页', r2.results.length === 1 && r2.results[0].page === 2, r2.results);
  check('短语结果标记 phrase', r2.results[0].phrase === true);

  const r3 = fulltext.search('deep -methods');
  check('排除词把含 methods 的页滤掉', r3.results.length === 2 && r3.results.every((r) => r.path === pLow || r.page === 1), r3.results);

  const pFold = mk('f-fold.pdf', null);
  write(pFold, ['a nice cafe in paris']);
  const r4b = fulltext.search('café');
  check('变音折叠命中（café→cafe）', r4b.results.some((r) => r.path === pFold), r4b.results.map((r) => r.path));

  const r5 = fulltext.search('title:whatever');
  check('只有字段限定时全文索引返回空（条目级在 main 层过滤）', r5.results.length === 0, r5.results.length);

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
}

// ---------- B. 探针：真实 app 端到端 ----------
const { runProbe } = require('./probe-runner');
const ROOT = path.join(__dirname, '..');
const SAMPLE = path.join(ROOT, 'assets', 'sample.pdf');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-search-'));
  const udd = path.join(tmp, 'ud');
  fs.mkdirSync(udd);
  // 两份同内容不同路径的 PDF：一个标题带 machine learning，一个不带
  const lib1 = path.join(tmp, 'ml-survey.pdf');
  const lib2 = path.join(tmp, 'other.pdf');
  fs.copyFileSync(SAMPLE, lib1);
  fs.copyFileSync(SAMPLE, lib2);
  try {
    const { fail: probeFail } = runProbe({
      probePath: path.join(__dirname, 'probe-search.js'),
      tmpDir: tmp,
      inject: {
        __PDF1__: lib1.replace(/\\/g, '/'),
        __PDF2__: lib2.replace(/\\/g, '/'),
      },
      env: {
        PDFREADER_DATA_DIR: tmp,
        PDFREADER_LIBRARY: path.join(tmp, 'library.json'),
        PDFREADER_NO_AUTO_INDEX: '1',
      },
      args: ['--user-data-dir=' + udd],
      label: 'search-probe',
      timeout: 240000,
    });
    if (probeFail) fail++;
    total++;
  } catch (e) {
    total++;
    fail++;
    console.error('  FAIL 探针执行异常', e && e.message ? e.message : e);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }

  console.log('[search] ' + (fail ? 'FAIL (' + fail + '/' + total + ')' : 'PASS (' + total + ')'));
  process.exit(fail ? 2 : 0);
})();
