'use strict';
/*
 * 批量抓取 + 网页快照回归（v31，报告「抓取」遗留项）。
 * 本地 HTTP 服务提供假 PDF / HTML，全程不碰外网；在真实 app 里跑探针。
 *
 * 注意：probe-runner 用 execFileSync 启动 Electron，会阻塞本进程的事件循环，
 * 所以假服务器必须放独立子进程，否则请求永远等不到响应。
 *
 * 运行：node scripts/test-batch-fetch.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { runProbe } = require('./probe-runner');

const ROOT = path.join(__dirname, '..');
const SAMPLE = path.join(ROOT, 'assets', 'sample.pdf');

// fetchpdf 只校验前 5 个字节是 %PDF-，所以一份最小 PDF 头就够
const PDF_BYTES = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n'
  + '2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';

const HTML = '<!doctype html><html><head><meta charset="utf-8"><title>Snapshot Test Page</title></head>'
  + '<body><h1>Snapshot Test Page</h1><p>这是一段用于网页快照回归的正文。</p></body></html>';

function startServer() {
  const code = `
    const http = require('http');
    const pdf = Buffer.from(${JSON.stringify(PDF_BYTES)}, 'latin1');
    const html = ${JSON.stringify(HTML)};
    const srv = http.createServer((req, res) => {
      const u = String(req.url || '');
      if (u.indexOf('/a.pdf') === 0 || u.indexOf('/c.pdf') === 0) {
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': pdf.length });
        res.end(pdf);
        return;
      }
      if (u.indexOf('/page') === 0) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    });
    srv.listen(0, '127.0.0.1', () => process.stdout.write('PORT ' + srv.address().port + '\\n'));
    process.on('message', (m) => { if (m === 'stop') process.exit(0); });
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => reject(new Error('假服务器启动超时')), 10000);
    child.stdout.on('data', (d) => {
      out += String(d);
      const m = /^PORT (\d+)$/m.exec(out);
      if (m) { clearTimeout(timer); resolve({ port: +m[1], child }); }
    });
    child.stderr.on('data', (d) => { err += String(d); });
    child.on('exit', (c) => { clearTimeout(timer); reject(new Error('假服务器退出（' + c + '）：' + err)); });
  });
}

let code = 0;
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-batch-'));
  const udd = path.join(tmp, 'ud');
  fs.mkdirSync(udd);
  const { port, child } = await startServer();
  const base = 'http://127.0.0.1:' + port;
  const now = Date.now();
  const item = (key, title, extra) => Object.assign({
    key, itemType: 'journalArticle', title, creators: [{ firstName: 'A', lastName: 'B', creatorType: 'author' }],
    year: '2024', publication: 'Test Journal', volume: '', issue: '', pages: '', doi: '', url: '',
    abstract: '', note: '', language: '', tags: [], collectionIds: [], attachment: null, page: 0,
    created: now, updated: now, deletedAt: 0,
  }, extra || {});

  const store = {
    version: 1,
    collections: [], searches: [], tagColors: {}, annoTags: {}, annoMeta: {},
    items: [
      item('BATCHA0001', '可抓的条目', { url: base + '/a.pdf' }),
      item('BATCHB0002', '会 404 的条目', { url: base + '/b.pdf' }),
      item('BATCHC0003', '没有来源的条目', {}),
      item('BATCHD0004', '已经有附件的条目', { url: base + '/c.pdf', attachment: { path: SAMPLE, name: 'sample.pdf' } }),
    ],
  };
  fs.writeFileSync(path.join(tmp, 'library.json'), JSON.stringify(store, null, 2), 'utf8');

  try {
    const { fail } = runProbe({
      probePath: path.join(__dirname, 'probe-batch-fetch.js'),
      tmpDir: tmp,
      inject: {
        __KEYS__: JSON.stringify(['BATCHA0001', 'BATCHB0002', 'BATCHC0003', 'BATCHD0004']),
        __PAGE_URL__: base,
      },
      env: {
        PDFREADER_DATA_DIR: tmp,
        PDFREADER_LIBRARY: path.join(tmp, 'library.json'),
        PDFREADER_NO_AUTO_INDEX: '1',
      },
      args: ['--user-data-dir=' + udd],
      label: 'batch-fetch',
      timeout: 240000,
    });
    code = fail ? 2 : 0;
  } catch (e) {
    console.error('[batch-fetch] 探针执行异常：' + (e && e.message ? e.message : e));
    code = 2;
  } finally {
    try { child.kill(); } catch (_) {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(code);
})();
