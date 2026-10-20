'use strict';
/*
 * DOI / arXiv 元数据抓取回归（v12）。纯 Node + 注入 fake fetch，默认不联网。
 * 覆盖：标识符识别、Crossref 字段映射、arXiv Atom 解析、HTTP/JSON/网络/超时错误分支。
 * 可选联网：PDFREADER_LIVE=1 node scripts/test-metadata.js
 * 运行：node scripts/test-metadata.js
 */
const path = require('path');
const metadata = require(path.join(__dirname, '..', 'src', 'metadata.js'));

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  <- ' + detail : '')); }
}

// ---------- 标识符识别 ----------
const cases = [
  ['10.1000/xyz.123', 'doi', '10.1000/xyz.123'],
  ['https://doi.org/10.1000/xyz', 'doi', '10.1000/xyz'],
  ['doi:10.1000/abc', 'doi', '10.1000/abc'],
  ['  10.1016/j.test.2020.01.001  ', 'doi', '10.1016/j.test.2020.01.001'],
  ['arXiv:2101.00001', 'arxiv', '2101.00001'],
  ['2101.00001v2', 'arxiv', '2101.00001'],
  ['https://arxiv.org/abs/2101.00001', 'arxiv', '2101.00001'],
  ['arXiv:cs/0701001v1', 'arxiv', 'cs/0701001'],
];
for (const [input, type, id] of cases) {
  const p = metadata.parseIdentifier(input);
  ok('识别 ' + input.trim(), !!p && p.type === type && p.id === id, JSON.stringify(p));
}
ok('无效输入返回 null', metadata.parseIdentifier('hello world') === null);
ok('空输入返回 null', metadata.parseIdentifier('') === null && metadata.parseIdentifier(null) === null);

// ---------- Crossref ----------
const crossrefMsg = {
  message: {
    type: 'journal-article',
    title: ['A Study of PDF Reading'],
    author: [{ given: 'Ada', family: 'Lovelace' }, { family: 'Turing' }, { name: 'Anonymous Group' }],
    issued: { 'date-parts': [[2021, 5, 3]] },
    'container-title': ['Journal of Documents'],
    publisher: 'Test Press',
    volume: '3', issue: '2', page: '1-9',
    DOI: '10.1000/abc', URL: 'https://doi.org/10.1000/abc',
    abstract: '<jats:p>Hello <b>world</b> &amp; more</jats:p>',
    language: 'en',
    subject: ['Computer Science', 'PDF'],
  },
};
function jsonFetch(obj, status) {
  return async () => ({ ok: (status || 200) < 400, status: status || 200, text: async () => JSON.stringify(obj) });
}

(async () => {
  const doiRes = await metadata.fetchMetadata('10.1000/abc', { fetchImpl: jsonFetch(crossrefMsg) });
  ok('Crossref 抓取成功', doiRes.ok === true, JSON.stringify(doiRes).slice(0, 200));
  const m = doiRes.metadata || {};
  ok('Crossref 标题', m.title === 'A Study of PDF Reading', m.title);
  ok('Crossref 作者映射', JSON.stringify(m.creators) === JSON.stringify(['Ada Lovelace', 'Turing', 'Anonymous Group']), JSON.stringify(m.creators));
  ok('Crossref 年份', m.year === '2021', m.year);
  ok('Crossref 期刊', m.publication === 'Journal of Documents', m.publication);
  ok('Crossref 卷期页', m.volume === '3' && m.issue === '2' && m.pages === '1-9', JSON.stringify([m.volume, m.issue, m.pages]));
  ok('Crossref DOI/URL', m.doi === '10.1000/abc' && m.url === 'https://doi.org/10.1000/abc');
  ok('Crossref 摘要去 HTML 标签并解实体', m.abstract === 'Hello world & more', m.abstract);
  ok('Crossref 主题作为标签', JSON.stringify(m.tags) === JSON.stringify(['Computer Science', 'PDF']), JSON.stringify(m.tags));
  ok('Crossref 类型映射', m.itemType === 'journalArticle', m.itemType);
  ok('抓取结果带 source/id', doiRes.source === 'doi' && doiRes.id === '10.1000/abc');

  // 类型映射分支
  const typeCases = [
    ['proceedings-article', 'conferencePaper'], ['book', 'book'], ['dissertation', 'thesis'],
    ['report', 'report'], ['posted-content', 'webpage'], ['dataset', 'document'], ['unknown-type', 'journalArticle'],
  ];
  for (const [src, want] of typeCases) {
    const res = await metadata.fetchMetadata('10.1000/t', {
      fetchImpl: jsonFetch({ message: { type: src, title: ['T'], author: [] } }),
    });
    ok('Crossref 类型 ' + src + ' → ' + want, res.ok && res.metadata.itemType === want, res.ok ? res.metadata.itemType : res.error);
  }

  // 缺标题 / 空 message
  let r = await metadata.fetchMetadata('10.1000/none', { fetchImpl: jsonFetch({ message: {} }) });
  ok('Crossref 无标题时报错', r.ok === false && /没有找到/.test(r.error), JSON.stringify(r));
  r = await metadata.fetchMetadata('10.1000/none', { fetchImpl: jsonFetch({}) });
  ok('Crossref 空响应不崩', r.ok === false, JSON.stringify(r));

  // HTTP 错误 / 非 JSON
  r = await metadata.fetchMetadata('10.1000/x', { fetchImpl: jsonFetch({}, 500) });
  ok('HTTP 500 返回可读错误', r.ok === false && /HTTP 500/.test(r.error), r.error);
  r = await metadata.fetchMetadata('10.1000/x', { fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html>not json</html>' }) });
  ok('非 JSON 返回可读错误', r.ok === false && /不是 JSON/.test(r.error), r.error);

  // 网络异常
  r = await metadata.fetchMetadata('10.1000/x', { fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  ok('网络异常不抛出、带原因', r.ok === false && /ECONNRESET/.test(r.error), r.error);

  // 超时：fake fetch 只等 abort
  const slow = (_url, opts) => new Promise((_resolve, reject) => {
    if (opts && opts.signal) opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const t0 = Date.now();
  r = await metadata.fetchMetadata('10.1000/slow', { fetchImpl: slow, timeout: 40 });
  ok('超时会中止请求', r.ok === false && Date.now() - t0 < 3000, r.error);

  // ---------- arXiv ----------
  const arxivXml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2101.00001v1</id>
    <updated>2021-02-01T00:00:00Z</updated>
    <published>2021-01-01T00:00:00Z</published>
    <title>Deep PDF Reading</title>
    <summary>A short abstract &amp; more.</summary>
    <author><name>Ada Lovelace</name></author>
    <author><name>Alan Turing</name></author>
    <arxiv:doi>10.1000/ax</arxiv:doi>
    <arxiv:journal_ref>Journal of arXiv</arxiv:journal_ref>
    <category term="cs.CL"/>
    <category term="cs.IR"/>
  </entry>
</feed>`;
  const axRes = await metadata.fetchMetadata('arXiv:2101.00001', {
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => arxivXml }),
  });
  ok('arXiv 抓取成功', axRes.ok === true, JSON.stringify(axRes).slice(0, 200));
  const am = axRes.metadata || {};
  ok('arXiv 标题', am.title === 'Deep PDF Reading', am.title);
  ok('arXiv 作者', JSON.stringify(am.creators) === JSON.stringify(['Ada Lovelace', 'Alan Turing']), JSON.stringify(am.creators));
  ok('arXiv 年份取 published', am.year === '2021', am.year);
  ok('arXiv DOI', am.doi === '10.1000/ax', am.doi);
  ok('arXiv 有 journal_ref 时作为出版物', am.publication === 'Journal of arXiv', am.publication);
  ok('arXiv 分类作为标签', JSON.stringify(am.tags) === JSON.stringify(['cs.CL', 'cs.IR']), JSON.stringify(am.tags));
  ok('arXiv 摘要解实体', am.abstract === 'A short abstract & more.', am.abstract);
  ok('arXiv 有期刊时判为期刊文章', am.itemType === 'journalArticle', am.itemType);
  ok('arXiv 结果带 source/id', axRes.source === 'arxiv' && axRes.id === '2101.00001');

  const axNoJournal = arxivXml.replace(/<arxiv:journal_ref>[\s\S]*?<\/arxiv:journal_ref>/, '');
  const ax2 = await metadata.fetchMetadata('2101.00001', { fetchImpl: async () => ({ ok: true, status: 200, text: async () => axNoJournal }) });
  ok('arXiv 无期刊时判为文档', ax2.ok && ax2.metadata.itemType === 'document' && ax2.metadata.publication === 'arXiv', JSON.stringify(ax2.metadata && [ax2.metadata.itemType, ax2.metadata.publication]));

  const axEmpty = await metadata.fetchMetadata('2101.00001', { fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<feed></feed>' }) });
  ok('arXiv 空 feed 报错', axEmpty.ok === false && /没有找到/.test(axEmpty.error), axEmpty.error);

  // 无效标识符不联网
  let called = false;
  const guard = async () => { called = true; return { ok: true, text: async () => '{}' }; };
  r = await metadata.fetchMetadata('not-an-id', { fetchImpl: guard });
  ok('无效标识符不发请求', r.ok === false && called === false && /无法识别/.test(r.error), JSON.stringify(r));

  // ---------- 可选：真实网络 ----------
  if (process.env.PDFREADER_LIVE === '1') {
    console.log('  ...  联网测试（PDFREADER_LIVE=1）');
    const liveDoi = await metadata.fetchMetadata('10.1038/nature12373');
    ok('真实 Crossref 抓取', liveDoi.ok === true && !!liveDoi.metadata.title, JSON.stringify(liveDoi).slice(0, 300));
    const liveAx = await metadata.fetchMetadata('1706.03762');
    ok('真实 arXiv 抓取', liveAx.ok === true && /Attention/i.test(liveAx.metadata.title), JSON.stringify(liveAx).slice(0, 300));
  } else {
    console.log('  skip 真实网络测试（设 PDFREADER_LIVE=1 启用）');
  }

  console.log('[metadata] ' + (fail ? 'FAIL (' + fail + '/' + (pass + fail) + ')' : 'PASS (' + pass + ')'));
  process.exit(fail ? 2 : 0);
})().catch((e) => {
  console.error('[metadata] ERROR', e && e.stack ? e.stack : e);
  process.exit(3);
});
