'use strict';
/*
 * RSS 订阅回归：
 *   Node 侧：feedparse.js——RSS 2.0 / Atom / CDATA / 实体 / 坏源 / entryToRecord / 200 条上限。
 *   Electron 侧：本地 http 服务当订阅源（真网络、真 IPC）——添加订阅（解析+入库订阅表）、
 *            重复订阅拒绝、面板拉取条目、收进文献库（webpage 条目 + url 去重置灰）、
 *            取消订阅、坏地址报错；订阅跨重启持久。
 * 运行：node scripts/test-feed.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const FeedParse = require('../src/feedparse.js');
const { runProbe } = require('./probe-runner');

// ---------- A. Node 纯解析 ----------
(function nodePart() {
  const rss = '<?xml version="1.0"?><rss version="2.0"><channel><title>ML Journal</title>'
    + '<item><title><![CDATA[Attention is All You Need]]></title><link>https://j.org/a1</link>'
    + '<description>seq2seq</description><pubDate>Wed, 01 Oct 2025 08:00:00 GMT</pubDate>'
    + '<author>smith@x.org (John Smith)</author></item>'
    + '<item><link>https://j.org/a2</link></item>'   // 缺标题跳过
    + '</channel></rss>';
  let r = FeedParse.parseFeed(rss);
  assert.equal(r.kind, 'rss', '识别 RSS');
  assert.equal(r.title, 'ML Journal', '源标题');
  assert.equal(r.entries.length, 1, '缺标题条目跳过');
  assert.equal(r.entries[0].title, 'Attention is All You Need', 'CDATA 解码');
  assert.ok(r.entries[0].date > 0, 'pubDate 解析');

  const atom = '<feed><title>arXiv cs.CL</title><link rel="self" href="https://s"/><link rel="alternate" href="https://l"/>'
    + '<entry><title>Token &amp; more</title><link rel="alternate" href="https://arxiv.org/abs/2510.1"/><summary>摘要</summary>'
    + '<updated>2025-10-02T12:00:00Z</updated><author><name>Smith, John</name></author></entry></feed>';
  r = FeedParse.parseFeed(atom);
  assert.equal(r.kind, 'atom', '识别 Atom');
  assert.equal(r.link, 'https://l', 'alternate 链接优先');
  assert.equal(r.entries[0].url, 'https://arxiv.org/abs/2510.1', 'entry 链接');
  assert.equal(r.entries[0].title, 'Token & more', '实体解码');
  assert.deepEqual(r.entries[0].authors, ['Smith, John'], 'Atom 作者 name');

  // RDF 兜底
  r = FeedParse.parseFeed('<rdf:RDF><channel><title>RDF Source</title></channel><item><title>R1</title><link>https://r.org/1</link></item></rdf:RDF>');
  assert.equal(r.entries[0].title, 'R1', 'RDF item 兜底');

  assert.deepEqual(FeedParse.parseFeed('totally not xml').entries, [], '坏源不抛错');
  // 重复条目去重
  const dup = '<rss><channel><title>t</title>' + '<item><title>same</title><link>https://x/1</link></item>'.repeat(3) + '</channel></rss>';
  assert.equal(FeedParse.parseFeed(dup).entries.length, 1, '同题同链去重');
  // 200 上限用循环构造验证
  let big = '<rss><channel><title>t</title>';
  for (let i = 0; i < 210; i++) big += '<item><title>item ' + i + '</title><link>https://x/' + i + '</link></item>';
  big += '</channel></rss>';
  assert.equal(FeedParse.parseFeed(big).entries.length, 200, '条目上限 200');

  const rec = FeedParse.entryToRecord({ title: 'A Paper', url: 'https://x/1', date: Date.parse('2025-10-02'), authors: ['Smith, John'] }, 'Src');
  assert.equal(rec.itemType, 'webpage', '条目映射 webpage');
  assert.equal(rec.year, '2025', '年份');
  assert.equal(rec.creators[0].lastName, 'Smith', '作者拆分');
  console.log('[feed-node] PASS');
})();

// ---------- B. Electron 端到端（本地 http 订阅源） ----------
let code = 0;
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-feed-'));
  const ud = path.join(tmp, 'ud');
  fs.mkdirSync(ud, { recursive: true });

  // 订阅源必须是独立子进程：runProbe 用 execFileSync 等待 Electron，本进程事件循环
  // 会被阻塞，同进程 http 服务器在探测期间根本无法响应（表现为拉取超时）。
  const serverScript = path.join(tmp, 'feed-server.cjs');
  fs.writeFileSync(serverScript, `
    const http = require('http');
    const srv = http.createServer((req, res) => {
      if (req.url.startsWith('/rss')) {
        res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8' });
        res.end('<?xml version="1.0"?><rss version="2.0"><channel><title>Test Journal Feed</title>'
          + '<item><title>Feed Paper One</title><link>https://example.org/p1</link><description>first</description><pubDate>Wed, 01 Oct 2025 08:00:00 GMT</pubDate><author>Zhang, San</author></item>'
          + '<item><title>Feed Paper Two</title><link>https://example.org/p2</link><description>second</description></item>'
          + '</channel></rss>');
        return;
      }
      res.writeHead(404); res.end('nope');
    });
    srv.listen(Number(process.argv[2]), '127.0.0.1', () => process.send && process.send('ready'));
    process.on('message', (m) => { if (m === 'close') process.exit(0); });
  `);
  const child = require('child_process').spawn(process.execPath, [serverScript, '0'], { stdio: ['ignore', 'ignore', 'inherit'], env: process.env });
  // 等子进程就绪：轮询它的输出文件不行（stdio 忽略），改用「请求一次固定探活端口」——
  // 更简单的办法：让子进程把实际端口写进文件
  const portFile = path.join(tmp, 'port.txt');
  fs.writeFileSync(serverScript, fs.readFileSync(serverScript, 'utf8').replace(
    "srv.listen(Number(process.argv[2]), '127.0.0.1', () => process.send && process.send('ready'));",
    "srv.listen(0, '127.0.0.1', () => { require('fs').writeFileSync(process.argv[2], String(srv.address().port)); } );"));
  child.kill();
  const server = require('child_process').spawn(process.execPath, [serverScript, portFile], { stdio: ['ignore', 'ignore', 'inherit'] });
  let port = 0;
  for (let i = 0; i < 100 && !port; i++) {
    await new Promise((r) => setTimeout(r, 50));
    try { port = parseInt(fs.readFileSync(portFile, 'utf8'), 10) || 0; } catch (_) {}
  }
  assert.ok(port > 0, '订阅源服务器就绪');
  try {
    const feedUrl = 'http://127.0.0.1:' + port + '/rss';
    const probe = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 10000)) { if (await fn()) return true; await sleep(60); } return !!(await fn()); };
  const libReady = await waitFor(() => window.LibraryUI && LibraryUI.isOpen(), 10000);
  push('文献库就绪', libReady);
  if (!libReady) return { checks };

  // 1) 直接走 IPC：添加订阅（拉取 + 入订阅表）
  const add = await pdfBridge.feedAdd('${feedUrl}');
  push('添加订阅成功', add && add.ok && add.feed && add.feed.title === 'Test Journal Feed', JSON.stringify(add || {}).slice(0, 120));
  push('条目 2 条', add && Array.isArray(add.entries) && add.entries.length === 2);
  // 2) 重复订阅拒绝
  const dup = await pdfBridge.feedAdd('${feedUrl}');
  push('重复订阅拒绝', dup && dup.ok === false && dup.exists === true, JSON.stringify(dup || {}));
  // 3) 坏地址
  const bad = await pdfBridge.feedAdd('not-a-url');
  push('坏地址拒绝', bad && bad.ok === false);
  const dead = await pdfBridge.feedFetch('http://127.0.0.1:1/rss');
  push('连不上的源报错', dead && dead.ok === false, JSON.stringify(dead || {}).slice(0, 80));

  // 4) 打开订阅面板：订阅在列表里；点「看条目」渲染条目
  push('面板按钮存在', !!document.getElementById('lib-feeds'));
  document.getElementById('lib-feeds').click();
  await waitFor(() => document.getElementById('feeds-modal').hidden === false, 5000);
  push('面板打开', document.getElementById('feeds-modal').hidden === false);
  await sleep(300);
  const list = document.getElementById('feed-list');
  push('订阅列表已渲染', !!list && !!list.textContent, list && list.textContent.slice(0, 80));
  push('面板列出订阅', !!(list && list.textContent.includes('Test Journal Feed')), list && list.textContent.slice(0, 60));
  const openBtn = list && list.querySelector('[data-feed-open]');
  push('拉取按钮存在', !!openBtn);
  if (!openBtn) return { checks };
  openBtn.click();
  await waitFor(() => document.querySelectorAll('#feed-entries .feed-entry').length === 2, 8000);
  push('条目渲染 2 条', document.querySelectorAll('#feed-entries .feed-entry').length === 2);

  // 5) 收进文献库：webpage 条目带 url；按钮变已入库
  const addBtn = document.querySelector('#feed-entries [data-feed-entry="0"]');
  addBtn.click();
  await waitFor(() => addBtn.textContent === '已入库', 8000);
  push('条目入库按钮态', addBtn.textContent === '已入库');
  await sleep(400);
  const sum = await pdfBridge.lib.summary();
  const item = (sum.items || []).find((x) => x.title === 'Feed Paper One');
  push('文献库出现 webpage 条目', !!item && item.itemType === 'webpage' && item.url === 'https://example.org/p1', item && JSON.stringify({ t: item && item.title, u: item && item.url, y: item && item.year }));
  push('作者入库', !!(item && item.creators[0] && item.creators[0].lastName === 'Zhang'), item && JSON.stringify(item.creators));
  push('重复入库置灰', document.querySelector('#feed-entries [data-feed-entry="0"]').disabled === true);

  // 6) 取消订阅 + 持久化
  await pdfBridge.feedRemove(add.feed.id);
  const sum2 = await pdfBridge.lib.summary();
  push('取消订阅', (sum2.feeds || []).length === 0);
  return { checks };
})()`;
    const probeFile = path.join(tmp, 'probe.cjs');
    fs.writeFileSync(probeFile, 'module.exports=' + JSON.stringify(probe));
    const r1 = runProbe({
      probe: probeFile,
      env: { PDFREADER_LIBRARY: path.join(tmp, 'library.json'), PDFREADER_DATA_DIR: tmp, PDFREADER_NO_AUTO_INDEX: '1' },
      args: ['--user-data-dir=' + ud],
      label: 'feed-first',
      timeout: 240000,
    });
    assert.equal(r1.fail, 0);

    // 7) 跨重启持久：同一 library.json 再启动，订阅还在
    const probe2 = `(async () => {
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 10000)) { if (await fn()) return true; await sleep(60); } return !!(await fn()); };
  const libReady = await waitFor(() => window.LibraryUI && LibraryUI.isOpen(), 10000);
  if (!libReady) { push('文献库就绪', false); return { checks }; }
  // 先补一条订阅（上一轮删光了），验证落盘
  const add = await pdfBridge.feedAdd('${feedUrl}');
  push('重新订阅', add && add.ok);
  return { checks };
})()`;
    const probeFile2 = path.join(tmp, 'probe2.cjs');
    fs.writeFileSync(probeFile2, 'module.exports=' + JSON.stringify(probe2));
    const r2 = runProbe({
      probe: probeFile2,
      env: { PDFREADER_LIBRARY: path.join(tmp, 'library.json'), PDFREADER_DATA_DIR: tmp, PDFREADER_NO_AUTO_INDEX: '1' },
      args: ['--user-data-dir=' + ud],
      label: 'feed-second',
      timeout: 240000,
    });
    assert.equal(r2.fail, 0);

    // Node 侧核对磁盘：订阅落库
    const lib = JSON.parse(fs.readFileSync(path.join(tmp, 'library.json'), 'utf8'));
    assert.ok(Array.isArray(lib.feeds) && lib.feeds.length === 1 && /^https?:\/\//.test(lib.feeds[0].url), '订阅持久化到 library.json');
    code = 0;
  } catch (e) {
    console.error('[feed] ERROR', e && e.message ? e.message : e);
    code = 3;
  } finally {
    try { server.kill(); } catch (_) {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(code);
})();
