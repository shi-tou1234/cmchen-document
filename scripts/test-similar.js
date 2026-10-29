'use strict';
/*
 * 相似文献（v36）回归：纯 Node。
 *
 * src/similar.js 是 tf-idf + 余弦，没有模型也没有网络。这里测的是「它凭什么算得对」：
 *   1. 分词口径：虚词/套话丢掉、拉丁词≥3、中文二元组；
 *   2. 词频与向量上限；
 *   3. idf 来自语料（越普通的词越轻），余弦打分自反=1；
 *   4. 排序、无交集不上榜、shared 能解释「为什么像」。
 * 主进程那层（读索引、按 stamp 缓存、IPC）在 scripts/test-similar-ui.js 里验。
 */
const S = require('../src/similar.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.log('  FAIL ' + name + (detail === undefined ? '' : ' :: ' + detail));
}
function eq(name, got, want) {
  ok(name, got === want, 'got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want));
}

// ---------- 1. 分词 ----------
console.log('1. 分词');
{
  eq('虚词被丢掉', S.tokenize('the deep learning model').join(','), 'deep,learning,model');
  eq('参考文献套话被丢掉', S.tokenize('references et al pp 12 doi').join(','), '');
  eq('短词被丢掉', S.tokenize('a to of it is').join(','), '');
  eq('词内连字符保留', S.tokenize('state-of-the-art').join(','), 'state-of-the-art');
  eq('相邻两词分开', S.tokenize('pdfreader').join(','), 'pdfreader');
  eq('中文切二元组', S.tokenize('深度学习').join(','), '深度,度学,学习');
  eq('中文标点断段', S.tokenize('深度学习，模型').join(','), '深度,度学,学习,模型');
  eq('单个汉字保留', S.tokenize('书').join(','), '书');
  eq('中英混排各自切（孤立汉字保留）', S.tokenize('用 PDF 阅读').join(','), 'pdf,用,阅读');
  eq('空串', S.tokenize('').length, 0);
  ok('isStop 认得出虚词', S.isStop('the') && !S.isStop('learning'));
}

// ---------- 2. 词频与向量 ----------
console.log('2. 向量');
{
  const v = S.vectorOf('deep deep learning neural neural neural');
  eq('词频统计', v.get('deep'), 2);
  eq('词频统计（三次）', v.get('neural'), 3);
  eq('不同词数量', v.size, 3);

  // 上限：单篇最多 4000 个不同词
  const parts = [];
  for (let i = 0; i < 4500; i++) parts.push('term' + i);
  const big = S.vectorOf(parts.join(' '));
  eq('单篇词数封顶', big.size, S.MAX_TERMS_PER_DOC);

  eq('空文本向量为空', S.vectorOf('').size, 0);
  eq('纯虚词向量为空', S.vectorOf('the and of').size, 0);
}

// ---------- 3. 语料与打分 ----------
console.log('3. 语料 / 打分');
{
  const docs = [
    { path: '/a.pdf', title: 'A', vector: S.vectorOf('deep learning neural network training') },
    { path: '/b.pdf', title: 'B', vector: S.vectorOf('deep learning model compression') },
    { path: '/c.pdf', title: 'C', vector: S.vectorOf('cooking recipe for bread') },
  ];
  const corpus = S.buildCorpus(docs);
  eq('语料收录三篇', corpus.n, 3);
  ok('只在两篇里出现的词 idf 更高',
    corpus.idf.get('deep') < corpus.idf.get('cooking'),
    'deep=' + corpus.idf.get('deep') + ' cooking=' + corpus.idf.get('cooking'));
  ok('只在一篇里出现的词 idf 更高',
    corpus.idf.get('network') > corpus.idf.get('deep'),
    'network=' + corpus.idf.get('network') + ' deep=' + corpus.idf.get('deep'));

  const ranked = S.rank(docs[0].vector, corpus, { limit: 8 });
  const a = ranked.find((r) => r.path === '/a.pdf');
  const b = ranked.find((r) => r.path === '/b.pdf');
  ok('自己排第一', ranked[0].path === '/a.pdf', ranked.map((r) => r.path + ':' + r.score.toFixed(3)).join(' '));
  ok('自反相似度为 1', a && Math.abs(a.score - 1) < 1e-9, a && a.score);
  ok('同主题的另一篇得分在 0~1 之间', b && b.score > 0 && b.score < 1, b && b.score);
  ok('毫无交集的文档不上榜', !ranked.some((r) => r.path === '/c.pdf'), ranked.map((r) => r.path).join(','));
  ok('shared 能解释为什么像', a && a.shared.length > 0 && a.shared[0].term, a && JSON.stringify(a.shared.slice(0, 2)));

  eq('limit 生效', S.rank(docs[0].vector, corpus, { limit: 1 }).length, 1);
  eq('空向量不上榜', S.rank(new Map(), corpus).length, 0);
  eq('空语料不上榜', S.rank(docs[0].vector, { docs: [], idf: new Map(), n: 0 }).length, 0);
  eq('空向量文档被语料过滤掉', S.buildCorpus([{ path: 'x', vector: new Map() }]).n, 0);
}

// ---------- 4. 索引与展示 ----------
console.log('4. 索引 / 展示');
{
  const entry = { pages: [{ page: 1, text: 'hello' }, { page: 2, text: 'world' }] };
  eq('索引拼成纯文本', S.textOfEntry(entry), 'hello\nworld');
  eq('坏索引返回空串', S.textOfEntry(null), '');
  eq('缺 pages 返回空串', S.textOfEntry({ foo: 1 }), '');

  const shared = [{ term: 'deep', weight: 2 }, { term: 'learning', weight: 1.5 }, { term: 'model', weight: 1 }];
  eq('sharedLabel 默认取 4 个', S.sharedLabel(shared), 'deep · learning · model');
  eq('sharedLabel 可限个数', S.sharedLabel(shared, 2), 'deep · learning');
  eq('sharedLabel 空', S.sharedLabel([]), '');
}

console.log('test-similar: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
