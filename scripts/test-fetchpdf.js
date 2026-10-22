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
      if (u.pathname === '/notfound') { res.writeHead(404); return res.end('nope'); }
      res.writeHead(500); res.end('err');
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
      endpoints: { doiResolver: () => base + '/html' },
    });
    check('全失败时报出网页不是 PDF', f3.ok === false && /网页/.test(f3.error), f3);
    check('全失败时带每个来源的尝试记录', Array.isArray(f3.tried) && f3.tried.length >= 1, f3.tried);

    check('没有标识时不发起请求', (await fetchpdf.fetchToFile({}, path.join(tmp, 'y.pdf'), { endpoints })).ok === false);
  } finally {
    server.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }

  console.log('[fetchpdf] ' + (fail ? 'FAIL (' + fail + '/' + total + ')' : 'PASS (' + total + ')'));
  process.exit(fail ? 2 : 0);
})();
