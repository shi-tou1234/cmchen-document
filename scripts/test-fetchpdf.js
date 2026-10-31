'use strict';
/*
 * 抓取 PDF 全文回归（2026-10-22，报告「抓取」缺口）：
 * 用本地 HTTP 服务模拟 arXiv / Unpaywall / 直链 / 重定向 / 非 PDF / 超大文件，
 * 验证解析顺序与下载校验，不依赖外网。
 * 运行：node scripts/test-fetchpdf.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const fetchpdf = require('../src/fetchpdf.js');

let fail = 0, total = 0;
function check(name, ok, detail) {
  total++;
  if (!ok) { fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  <- ' + JSON.stringify(detail) : '')); }
  else console.log('  ok   ' + name);
}

const PDF_BYTES = Buffer.concat([
  Buffer.from('%PDF-1.4\n'),
  Buffer.from('%\u00e2\u00e3\u00cf\u00d3\n'),
  Buffer.from('1 0 obj\n<< /Type /Catalog >>\nendobj\n'),
  Buffer.from('trailer\n<< /Root 1 0 R >>\n%%EOF\n'),
]);

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname === '/paper.pdf') {
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': PDF_BYTES.length });
        return res.end(PDF_BYTES);
      }
      if (u.pathname === '/redirect') {
        res.writeHead(302, { Location: '/paper.pdf' });
        return res.end();
      }
      if (u.pathname === '/html') {
        const html = '<!DOCTYPE html><html><body>请先登录机构账号</body></html>';
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html);
      }
      if (u.pathname === '/huge') {
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': String(120 * 1024 * 1024) });
        return res.end();
      }
      if (u.pathname.startsWith('/unpaywall/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          best_oa_location: { url_for_pdf: 'http://127.0.0.1:' + server.address().port + '/paper.pdf', host_type: 'repository' },
          oa_locations: [],
        }));
      }
      // v1.6：三路开放获取索引，形状各自不同（真实 API 就是这样）
      if (u.pathname.startsWith('/openalex/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          best_oa_location: { pdf_url: 'http://127.0.0.1:' + server.address().port + '/paper.pdf?src=openalex' },
          locations: [],
        }));
      }
      if (u.pathname.startsWith('/s2/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          openAccessPdf: { url: 'http://127.0.0.1:' + server.address().port + '/paper.pdf?src=s2' },
        }));
      }
      if (u.pathname.startsWith('/epmc/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          resultList: {
            result: [{
              fullTextUrlList: {
                fullTextUrl: [
                  { availabilityCode: 'S', documentStyle: 'html', url: 'http://127.0.0.1:' + server.address().port + '/html' },
                  { availabilityCode: 'OA', documentStyle: 'pdf', url: 'http://127.0.0.1:' + server.address().port + '/paper.pdf?src=epmc' },
                ],
              },
            }],
          },
        }));
      }
      // v1.6：慢速 OA 查询——用来证明「有直链时不必等它」
      if (u.pathname === '/slow-oa') {
        setTimeout(() => {
          try {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ best_oa_location: null, locations: [] }));
          } catch (_) {}
        }, 3000);
        return undefined;
      }
      // v1.6b：慢速落地页——普通文章页不该挡住 OA 已经拿到的 PDF
      if (u.pathname === '/landing') {
        setTimeout(() => {
          try {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<!DOCTYPE html><html><body>请先登录</body></html>');
          } catch (_) {}
        }, 2000);
        return undefined;
      }
      if (u.pathname === '/notfound') { res.writeHead(404); return res.end('nope'); }      res.writeHead(500); res.end('err');
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

(async () => {
  const server = await startServer();
  const port = server.address().port;
  const base = 'http://127.0.0.1:' + port;
  const endpoints = {
    arxivPdf: (id) => base + '/paper.pdf?arxiv=' + encodeURIComponent(id),
    unpaywall: (doi, email) => base + '/unpaywall/' + encodeURIComponent(doi) + '?email=' + encodeURIComponent(email),
    doiResolver: (doi) => base + '/html?doi=' + encodeURIComponent(doi),
    // 三路 OA 索引也指到本地：不打真实网络，测试才稳定
    openalex: (doi) => base + '/openalex/' + encodeURIComponent(doi),
    semanticscholar: (doi) => base + '/s2/' + encodeURIComponent(doi),
    europepmc: (doi) => base + '/epmc/' + encodeURIComponent(doi),
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-fetch-'));

  try {
    // ---------- arXiv id 解析 ----------
    check('解析新式 arXiv id', fetchpdf.arxivIdFromUrl('2401.12345v2') === '2401.12345', fetchpdf.arxivIdFromUrl('2401.12345v2'));
    check('解析 abs 链接', fetchpdf.arxivIdFromUrl('https://arxiv.org/abs/2401.12345') === '2401.12345');
    check('解析 pdf 链接（带版本）', fetchpdf.arxivIdFromUrl('https://arxiv.org/pdf/2401.12345v3') === '2401.12345');
    check('解析老式 id', fetchpdf.arxivIdFromUrl('https://arxiv.org/abs/hep-th/9901001') === 'hep-th/9901001', fetchpdf.arxivIdFromUrl('https://arxiv.org/abs/hep-th/9901001'));
    check('普通链接不误判', fetchpdf.arxivIdFromUrl('https://example.org/a.pdf') === '', fetchpdf.arxivIdFromUrl('https://example.org/a.pdf'));

    // ---------- 候选顺序 ----------
    const c1 = await fetchpdf.resolveCandidates({ doi: '10.1/x', arxivId: '2401.1', url: '', email: '' }, endpoints);
    check('arXiv 候选排第一', c1[0] && c1[0].source === 'arxiv', c1.map((x) => x.source));
    check('无邮箱时跳过 Unpaywall', !c1.some((x) => x.source === 'unpaywall'), c1.map((x) => x.source));
    check('DOI 兜底排在末尾', c1[c1.length - 1].source === 'doi', c1.map((x) => x.source));

    const c2 = await fetchpdf.resolveCandidates({ doi: '10.1/x', email: 'me@example.org' }, endpoints);
    check('有邮箱时 Unpaywall 候选可用', c2.some((x) => x.source === 'unpaywall' && /paper\.pdf/.test(x.url)), c2);

    const c3 = await fetchpdf.resolveCandidates({ url: 'https://example.org/open.pdf' }, endpoints);
    check('直接链接进候选', c3.some((x) => x.source === 'direct'), c3.map((x) => x.source));

    const c4 = await fetchpdf.resolveCandidates({}, endpoints);
    check('什么都没有时无候选', c4.length === 0, c4.length);

    // ---------- 下载 ----------
    const p1 = path.join(tmp, 'a.pdf');
    const d1 = await fetchpdf.downloadPdf(base + '/paper.pdf', p1);
    check('直链下载成功', d1.ok && d1.bytes > 20, d1);
    check('落盘且是 PDF', fs.existsSync(p1) && fs.readFileSync(p1).slice(0, 5).toString() === '%PDF-');
    check('不留 .part 临时文件', !fs.existsSync(p1 + '.part'));

    const p2 = path.join(tmp, 'b.pdf');
    const d2 = await fetchpdf.downloadPdf(base + '/redirect', p2);
    check('跟随 302 重定向', d2.ok && fs.existsSync(p2), d2);

    const d3 = await fetchpdf.downloadPdf(base + '/html', path.join(tmp, 'c.pdf'));
    check('网页不冒充 PDF', d3.ok === false && /网页/.test(d3.error), d3);

    const d4 = await fetchpdf.downloadPdf(base + '/huge', path.join(tmp, 'd.pdf'));
    check('Content-Length 超限被拒', d4.ok === false && /太大/.test(d4.error), d4);

    const d5 = await fetchpdf.downloadPdf(base + '/notfound', path.join(tmp, 'e.pdf'));
    check('404 报 HTTP 错误', d5.ok === false && /HTTP 404/.test(d5.error), d5);

    // ---------- 整体流程：Unpaywall 命中 ----------
    const p6 = path.join(tmp, 'unpaywall.pdf');
    const f1 = await fetchpdf.fetchToFile({ doi: '10.1/x', email: 'me@example.org' }, p6, { endpoints });
    check('整条流程经 Unpaywall 抓到 PDF', f1.ok && f1.source === 'unpaywall' && fs.existsSync(p6), f1);

    // ---------- 整体流程：首选失败后降级 ----------
    // arXiv 端点故意指到 404，直链可用 → 应降级成功
    const p7 = path.join(tmp, 'fallback.pdf');
    const f2 = await fetchpdf.fetchToFile({ arxivId: '2401.1', url: base + '/paper.pdf' }, p7, {
      endpoints: { arxivPdf: () => base + '/notfound' },
    });
    check('首选失败会降级到下一个来源', f2.ok && f2.source === 'direct', f2);

    // ---------- 全失败要有可读原因 ----------
    const f3 = await fetchpdf.fetchToFile({ doi: '10.1/x' }, path.join(tmp, 'x.pdf'), {
      endpoints: {
        doiResolver: () => base + '/html',
        // OA 三路也指到失败，否则会从 OpenAlex 拿到 PDF，测不到「全失败」
        openalex: () => base + '/notfound',
        semanticscholar: () => base + '/notfound',
        europepmc: () => base + '/notfound',
      },
    });
    check('全失败时报出网页不是 PDF', f3.ok === false && /网页/.test(f3.error), f3);
    check('全失败时带每个来源的尝试记录', Array.isArray(f3.tried) && f3.tried.length >= 1, f3.tried);

    check('没有标识时不发起请求', (await fetchpdf.fetchToFile({}, path.join(tmp, 'y.pdf'), { endpoints })).ok === false);

    // ---------- v1.6：多源聚合 ----------
    const c5 = await fetchpdf.resolveCandidates({ doi: '10.1/x' }, endpoints);
    const sources5 = c5.map((x) => x.source);
    check('无邮箱也能从 OpenAlex 拿到候选', sources5.includes('openalex'), sources5);
    check('Semantic Scholar 进候选', sources5.includes('semanticscholar'), sources5);
    check('Europe PMC 进候选', sources5.includes('europepmc'), sources5);
    check('Europe PMC 优先取 PDF 而不是 HTML',
      (c5.find((x) => x.source === 'europepmc') || {}).url.indexOf('/paper.pdf') > 0,
      c5.find((x) => x.source === 'europepmc'));
    check('聚合来源排在 DOI 兜底之前', sources5.indexOf('openalex') < sources5.indexOf('doi'), sources5);

    const p8 = path.join(tmp, 'openalex.pdf');
    const f4 = await fetchpdf.fetchToFile({ doi: '10.1/x' }, p8, { endpoints });
    check('整条流程经 OpenAlex 抓到 PDF', f4.ok && f4.source === 'openalex' && fs.existsSync(p8), f4);

    // ---------- v1.6：机构代理 ----------
    check('前缀式代理：拼 url=',
      fetchpdf.applyProxy('https://doi.org/10.1/x', 'https://proxy.univ.edu/login?url=')
      === 'https://proxy.univ.edu/login?url=' + encodeURIComponent('https://doi.org/10.1/x'));
    check('前缀式代理：自动补 ?url=',
      fetchpdf.applyProxy('https://doi.org/10.1/x', 'https://proxy.univ.edu/login')
      === 'https://proxy.univ.edu/login?url=' + encodeURIComponent('https://doi.org/10.1/x'));
    check('域名式代理：主机名点号变横线',
      fetchpdf.applyProxy('https://doi.org/10.1/x?q=1', 'proxy.univ.edu')
      === 'https://doi-org.proxy.univ.edu/10.1/x?q=1',
      fetchpdf.applyProxy('https://doi.org/10.1/x?q=1', 'proxy.univ.edu'));
    check('没配代理时返回空串', fetchpdf.applyProxy('https://doi.org/10.1/x', '') === '');
    check('非 http 目标不代理', fetchpdf.applyProxy('ftp://x/y', 'https://p/login?url=') === '');
    check('奇怪的代理写法不硬拼', fetchpdf.applyProxy('https://doi.org/10.1/x', '有 空格 的') === '');

    const c6 = await fetchpdf.resolveCandidates({ doi: '10.1/x', proxy: 'https://proxy.univ.edu/login?url=' }, endpoints);
    const proxyC = c6.find((x) => x.source === 'proxy');
    check('配了代理就多一个代理候选', !!proxyC, c6.map((x) => x.source));
    check('代理候选包着 DOI 解析地址',
      proxyC && decodeURIComponent(proxyC.url).indexOf('/html?doi=') > 0, proxyC);
    check('代理排在直连之后（最后一站前）',
      c6.map((x) => x.source).indexOf('proxy') > c6.map((x) => x.source).indexOf('doi'), c6.map((x) => x.source));

    // ---------- v1.6：OpenURL ----------
    const ou = fetchpdf.openUrlFor('https://resolver.univ.edu/openurl', {
      doi: '10.1/x', title: 'A Title', publication: 'Nature', year: '2020-03',
      volume: '5', issue: '2', pages: '10-20',
    });
    check('OpenURL 带 ctx_ver', ou.indexOf('ctx_ver=Z39.88-2004') > 0, ou);
    check('OpenURL 带 DOI', ou.indexOf('rft_id=' + encodeURIComponent('info:doi/10.1/x')) > 0, ou);
    check('OpenURL 带题名', ou.indexOf('rft.atitle=A%20Title') > 0, ou);
    check('OpenURL 年份只取四位', ou.indexOf('rft.date=2020') > 0, ou);
    check('OpenURL 拆出起始页', ou.indexOf('rft.spage=10') > 0, ou);
    check('OpenURL 基址已有查询串时用 &',
      fetchpdf.openUrlFor('https://r/univ?x=1', { doi: '10.1/y' }).indexOf('?x=1&ctx_ver=') > 0);
    check('OpenURL 基址不合法时返回空串', fetchpdf.openUrlFor('', { doi: 'x' }) === '');

    const c7 = await fetchpdf.resolveCandidates({ doi: '10.1/x', openurl: 'https://resolver.univ.edu/openurl' }, endpoints);
    check('OpenURL 是最后一站', c7[c7.length - 1].source === 'openurl', c7.map((x) => x.source));

    // ---------- v1.6：有直链时不等 OA 查询 ----------
    // 以前要等四路 OA 全部返回才开始下载，最坏白等十几秒；现在直链先跑。
    const slowEp = Object.assign({}, endpoints, {
      openalex: () => base + '/slow-oa',
      semanticscholar: () => base + '/slow-oa',
      europepmc: () => base + '/slow-oa',
    });
    const p9 = path.join(tmp, 'nowait.pdf');
    const t0 = Date.now();
    const f5 = await fetchpdf.fetchToFile({ doi: '10.1/x', url: base + '/paper.pdf' }, p9, { endpoints: slowEp });
    const dt = Date.now() - t0;
    check('有直链时直接用直链', f5.ok && f5.source === 'direct', f5);
    check('没有等慢速 OA 查询', dt < 1500, dt + 'ms');
    check('直链的 PDF 已落盘', fs.existsSync(p9));

    // ---------- v1.6b：落地页不该挡住 OA ----------
    // 条目里的 url 常常是文章页（HTML），慢的时候要几十秒。OA 已经给出 PDF 时不能干等它。
    check('普通文章页不算「像 PDF」', fetchpdf.looksLikePdf(base + '/landing') === false);
    check('.pdf 链接算「像 PDF」', fetchpdf.looksLikePdf('https://x.test/a/b.pdf') === true);
    check('/pdf/ 路径算「像 PDF」', fetchpdf.looksLikePdf('https://x.test/pdf/12345') === true);
    check('arXiv pdf 链接算「像 PDF」', fetchpdf.looksLikePdf('https://arxiv.org/pdf/2401.12345') === true);

    const p10 = path.join(tmp, 'landing.pdf');
    const t1 = Date.now();
    const f6 = await fetchpdf.fetchToFile({ doi: '10.1/x', url: base + '/landing' }, p10, { endpoints });
    const dt1 = Date.now() - t1;
    check('落地页 + OA 时走 OA', f6.ok && f6.source === 'openalex', f6);
    check('没有等落地页返回', dt1 < 1500, dt1 + 'ms');
  } finally {
    server.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }

  console.log('[fetchpdf] ' + (fail ? 'FAIL (' + fail + '/' + total + ')' : 'PASS (' + total + ')'));
  process.exit(fail ? 2 : 0);
})();
