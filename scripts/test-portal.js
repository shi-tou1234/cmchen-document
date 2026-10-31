'use strict';
/*
 * 跨文档 Portal（v36）回归：纯 Node。
 *
 * src/portal.js 要回答两件事：「这条参考文献是库里哪一篇」和「它从第几页开始」。
 * 这里把两件事的最坏情况都钉住：
 *   1. 命中路径：DOI 精确 > 标题词比例 + 年份 + 姓氏；
 *   2. 不命中：达不到阈值不猜（跳错一篇比不跳更让人困惑）、没有附件的条目不参与；
 *   3. 起点页：先标题整串、再标题词、最后 DOI，都找不到返回 0；
 *   4. 条目跨行拼接：遇到下一条编号 / 作者-年份开头就停。
 * IPC 那一层（真库 + 真索引）在 scripts/test-portal-ui.js 里验。
 */
const P = require('../src/portal.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.log('  FAIL ' + name + (detail === undefined ? '' : ' :: ' + detail));
}
function eq(name, got, want) {
  ok(name, got === want, 'got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want));
}

const ITEMS = [
  {
    key: 'k1', title: 'Deep learning for document analysis', year: '2020',
    doi: '10.1109/TPAMI.2019.1234',
    creators: [{ firstName: 'John', lastName: 'Smith', creatorType: 'author' }],
    attachment: { path: '/lib/deep.pdf' },
  },
  {
    key: 'k2', title: 'Reading interfaces for scholars', year: '2021', doi: '',
    creators: [{ firstName: 'Mei', lastName: 'Zhang', creatorType: 'author' }],
    attachment: { path: '/lib/reading.pdf' },
  },
  {
    key: 'k3', title: 'No file attached but same title', year: '2020', doi: '10.1109/TPAMI.2019.1234',
    creators: [], attachment: null,
  },
  {
    key: 'k4', title: 'Deep learning for document analysis', year: '2020', doi: '',
    creators: [{ firstName: 'John', lastName: 'Smith' }], attachment: { path: '/lib/trashed.pdf' }, deletedAt: 123,
  },
];

// ---------- 1. DOI ----------
console.log('1. DOI 命中');
{
  eq('DOI 归一：去前缀', P.normDoi('https://doi.org/10.1109/TPAMI.2019.1234'), '10.1109/tpami.2019.1234');
  eq('DOI 归一：去 doi: 前缀', P.normDoi('doi: 10.1109/TPAMI.2019.1234'), '10.1109/tpami.2019.1234');
  eq('条目里抽 DOI（去尾标点）', P.doiInEntry('J. Smith, "Deep learning," IEEE, 2020. doi:10.1109/TPAMI.2019.1234.'), '10.1109/tpami.2019.1234');
  eq('没有 DOI', P.doiInEntry('no identifier here, 2020'), '');

  const hit = P.matchEntry('J. Smith, "Deep learning for document analysis," IEEE Trans, 2020. https://doi.org/10.1109/TPAMI.2019.1234', ITEMS);
  ok('DOI 精确命中', hit && hit.item.key === 'k1', hit && hit.item.key);
  eq('DOI 命中的置信度是满分', hit.score, 1);
  eq('DOI 命中写明原因', hit.why, 'DOI');
}

// ---------- 2. 标题匹配 ----------
console.log('2. 标题 / 年份 / 姓氏');
{
  const hit = P.matchEntry('M. Zhang, "Reading interfaces for scholars," Digital Scholarship, 2021, pp. 33-51.', ITEMS);
  ok('标题词 + 年份 + 姓氏命中', hit && hit.item.key === 'k2', hit && JSON.stringify({ key: hit.item.key, score: hit.score, why: hit.why }));
  ok('标题全中也拿满分，但不是靠 DOI', hit.score === 1 && hit.why !== 'DOI', hit.score + ' ' + hit.why);

  // 标题全中但没有年份、没有姓氏：应该还过得去（0.75）
  const noYear = P.matchEntry('Some author, "Reading interfaces for scholars," Unknown Venue.', ITEMS);
  ok('只有标题也够 0.62 阈值', noYear && noYear.item.key === 'k2', noYear && noYear.score);

  eq('完全无关的条目返回 null', P.matchEntry('M. Lee, "Cooking with cast iron," Kitchen Press, 2018.', ITEMS), null);
  eq('空条目返回 null', P.matchEntry('', ITEMS), null);
  eq('空库返回 null', P.matchEntry('anything at all 2020', []), null);

  // 只看标题一半 + 年份错：不够
  eq('年份对不上、标题只沾一半', P.matchEntry('Something about document analysis, 1999.', ITEMS), null);
}

// ---------- 3. 候选过滤 ----------
console.log('3. 候选过滤');
{
  // k3 与 k1 同 DOI 但没有附件：不能把它当成目标（打开时会没有文件）
  const hit = P.matchEntry('J. Smith, 2020. https://doi.org/10.1109/TPAMI.2019.1234', ITEMS);
  ok('没有附件的条目被跳过', hit && hit.item.key === 'k1', hit && hit.item.attachment);

  // 回收站里的 k4 与 k1 同标题同年：只能命中 k1
  const t = P.matchEntry('J. Smith, "Deep learning for document analysis," 2020.', ITEMS);
  eq('回收站里的条目不参与匹配', t.item.key, 'k1');

  const none = P.matchEntry('J. Smith, "Deep learning for document analysis," 2020.', [ITEMS[2], ITEMS[3]]);
  eq('只剩没附件 / 回收站的条目时返回 null', none, null);
}

// ---------- 4. 起点页 ----------
console.log('4. 起点页');
{
  const index = {
    pages: [
      { page: 1, text: 'Journal of Something. Deep Learning for Document Analysis. J. Smith. Abstract…' },
      { page: 2, text: 'more body text' },
      { page: 5, text: 'References [1] J. Smith… 10.1109/TPAMI.2019.1234' },
    ],
  };
  eq('按标题整串找到第 1 页', P.findStartPage(index, { title: 'Deep learning for document analysis' }), 1);
  eq('按 DOI 找到第 5 页', P.findStartPage(index, { title: '', doi: '10.1109/TPAMI.2019.1234' }), 5);
  eq('找不到返回 0', P.findStartPage(index, { title: 'nothing like this', doi: '10.9999/none' }), 0);
  eq('空索引返回 0', P.findStartPage(null, { title: 'x' }), 0);

  // 整串匹配不上时退到「标题词命中 60%」
  const wrapped = { pages: [{ page: 3, text: 'Deep learning for document analysis with extra words inserted between the title tokens here' }] };
  eq('标题被插字后仍能找到', P.findStartPage(wrapped, { title: 'Deep learning for document analysis' }), 3);
}

// ---------- 5. 条目跨行拼接 ----------
console.log('5. entryAt');
{
  const lines = [
    { text: 'References' },
    { text: '[1] J. Smith and A. Lee, "Deep learning for' },
    { text: 'document analysis," IEEE Trans, 2020.' },
    { text: '[2] M. Zhang, "Reading interfaces," 2021.' },
    { text: 'Smith, J. (2019). A survey. Journal, 5(2), 1-10.' },
  ];
  eq('跨行条目拼完整', P.entryAt(lines, 1),
    '[1] J. Smith and A. Lee, "Deep learning for document analysis," IEEE Trans, 2020.');
  ok('遇到下一条编号就停', P.entryAt(lines, 1).indexOf('Reading interfaces') < 0);
  ok('遇到作者-年份开头也停', P.entryAt(lines, 3).indexOf('A survey') < 0, P.entryAt(lines, 3));
  eq('单行条目就是自己', P.entryAt(lines, 3), '[2] M. Zhang, "Reading interfaces," 2021.');
  eq('越界返回空串', P.entryAt(lines, 99), '');
  eq('负下标返回空串', P.entryAt(lines, -1), '');
  eq('空行结束条目', P.entryAt([{ text: 'abc' }, { text: '' }, { text: 'def' }], 0), 'abc');

  // maxLines 上限：极端情况下不能把整节吃进来
  const long = [{ text: 'entry starts' }];
  for (let i = 0; i < 20; i++) long.push({ text: 'continuation ' + i });
  const capped = P.entryAt(long, 0, { maxLines: 4 });
  eq('行数上限生效', capped.split(' ').filter((x) => x === 'continuation').length, 3);
}

// ---------- 6. Overview 候选排序 ----------
// rankCandidates 与 matchEntry 共用 scoreEntry：两者一旦漂移，就会出现
// 「自动跳了的那篇不在候选列表第一位」这种说不通的现象，这条不变量必须钉住。
console.log('6. 候选排序（Overview）');
{
  eq('空条目没有候选', P.rankCandidates('', ITEMS).length, 0);
  eq('空库没有候选', P.rankCandidates('anything', []).length, 0);

  const strong = P.rankCandidates('M. Zhang, "Reading interfaces for scholars," Digital Scholarship, 2021, pp. 33-51.', ITEMS);
  ok('有把握时第一篇就是它', strong.length > 0 && strong[0].item.key === 'k2', strong.length && strong[0].item.key);
  ok('候选按分数降序', strong.every((c, i) => i === 0 || strong[i - 1].score >= c.score),
    JSON.stringify(strong.map((c) => c.score)));

  // 两条不变量：最佳匹配必须与候选首位同一种算法结果；弱于 match 阈值也要留在列表里
  const hit = P.matchEntry('J. Smith, "Deep learning for document analysis," 2020.', ITEMS);
  const cand = P.rankCandidates('J. Smith, "Deep learning for document analysis," 2020.', ITEMS);
  ok('matchEntry 的结果就是候选第一名', hit && cand.length && hit.item.key === cand[0].item.key,
    (hit && hit.item.key) + ' vs ' + (cand[0] && cand[0].item.key));
  ok('两者分数一致（算法没漂移）', hit && cand.length && Math.abs(hit.score - cand[0].score) < 1e-12,
    (hit && hit.score) + ' vs ' + (cand[0] && cand[0].score));

  // Overview 存在的理由：自动不敢跳的，人还能从候选里挑出来
  // 完全相同的标题词组顺序换来的一定是高分；这里要的是「沾了一半、且没有年份」的中间地带
  const weakEntry = 'A short note touching document analysis, unpublished draft.';
  const weakScore = P.rankCandidates(weakEntry, ITEMS)[0];
  ok('弱匹配分数落在 match 阈值之下', weakScore && weakScore.score < P.THRESHOLD.match, weakScore && weakScore.score);
  ok('弱匹配但高于候选地板（算得出来才有得挑）', weakScore && weakScore.score >= P.THRESHOLD.candidate, weakScore && weakScore.score);
  const weakHit = P.matchEntry(weakEntry, ITEMS);
  const weakCand = P.rankCandidates(weakEntry, ITEMS);
  ok('弱匹配：matchEntry 不敢下结论', weakHit === null, weakHit && weakHit.score);
  ok('弱匹配但候选里还留着（Overview 的落脚点）', weakCand.length > 0 && weakCand[0].item.key === 'k1',
    JSON.stringify(weakCand.map((c) => [c.item.key, c.score])));

  // 噪声必须被挡住：完全不相干的条目不该占候选位
  eq('完全不相干没有候选', P.rankCandidates('Cooking with cast iron, Kitchen Press, 2018.', ITEMS).length, 0);

  // 上限与地板参数
  const many = [];
  for (let i = 0; i < 12; i++) {
    many.push({
      key: 'm' + i, title: 'Deep learning for document analysis part ' + i, year: '2020', doi: '',
      creators: [], attachment: { path: '/lib/m' + i + '.pdf' },
    });
  }
  eq('limit 生效', P.rankCandidates('Deep learning for document analysis, 2020.', many, { limit: 4 }).length, 4);
  eq('floor 可调高', P.rankCandidates('Deep learning for document analysis, 2020.', many, { floor: 0.9 }).length, 0);

  // 回收站里的条目：main 会先过滤，这里再加一层保险，避免历史 lists 漏过滤
  const withTrash = P.rankCandidates('Deep learning for document analysis, 2020.', [ITEMS[3]]);
  eq('回收站条目不进候选', withTrash.length, 0);
}

console.log('test-portal: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
