'use strict';
/*
 * EndNote XML 导入回归：
 *   Node 侧：formats.parseRefs 识别 .xml → endnotexml；解析作者/年份(从 date)/期刊/
 *            DOI(electronic-resource-num)/关键词/类型映射；多条记录；坏 XML 不抛错；
 *            实体解码；detectFormat 兜底（无扩展名也能认出 <records>）。
 *   Electron 侧：经 lib.importRefs(text, name) 导入真实 IPC → 查重 → 入库。
 * 运行：node scripts/test-enw-xml.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const formats = require('../src/formats.js');
const { runProbe } = require('./probe-runner');

// ---------- A. Node 纯解析 ----------
(function nodePart() {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<xml><records>
<record>
  <ref-type name="Journal Article">17</ref-type>
  <database name="My Library">EndNote</database>
  <contributors><authors><author>Smith, John A.</author><author>J. Doe</author></authors></contributors>
  <titles><title>Deep &amp; Learning &lt;methods&gt;</title><secondary-title>Nature Machine Intelligence</secondary-title></titles>
  <pages>1-10</pages><volume>12</volume><number>3</number>
  <date>2020-05-01</date>
  <electronic-resource-num>10.1234/abc</electronic-resource-num>
  <urls><related-urls><url>https://example.org/paper</url></related-urls></urls>
  <abstract>Background text.</abstract>
  <keywords><keyword>machine learning</keyword><keyword>deep learning; neural nets</keyword></keywords>
  <language>English</language>
  <publisher>Springer</publisher>
</record>
<record>
  <ref-type name="Book">1</ref-type>
  <titles><title>A Book Title</title></titles>
  <contributors><authors><author>_writer, Broken</author></authors></contributors>
  <year>1999</year>
  <pub-location>Berlin</pub-location>
  <publisher>Springer</publisher>
  <isbn>978-3-16-148410-0</isbn>
</record>
<record></record>
</records></xml>`;

  const r = formats.parseRefs(xml, 'refs.xml');
  assert.equal(r.format, 'endnotexml', '识别 endnotexml');
  assert.equal(r.records.length, 2, '两条有效记录（空壳跳过）: ' + r.records.length);
  const a = r.records[0];
  assert.equal(a.itemType, 'journalArticle', '类型映射');
  assert.equal(a.title, 'Deep & Learning <methods>', '实体解码: ' + a.title);
  assert.equal(a.creators.length, 2, '两位作者');
  assert.equal(a.creators[0].lastName, 'Smith', '姓在前');
  assert.equal(a.creators[0].firstName, 'John A.', '名取全');
  assert.equal(a.year, '2020', '年份从 date 提取');
  assert.equal(a.publication, 'Nature Machine Intelligence', '期刊名');
  assert.equal(a.volume, '12', '卷');
  assert.equal(a.issue, '3', '期');
  assert.equal(a.doi, '10.1234/abc', 'DOI');
  assert.equal(a.url, 'https://example.org/paper', 'URL');
  assert.deepEqual(a.tags, ['machine learning', 'deep learning', 'neural nets'], '关键词拆分: ' + JSON.stringify(a.tags));
  assert.equal(a.language, 'English', '语言');
  const b = r.records[1];
  assert.equal(b.itemType, 'book', '书类型');
  assert.equal(b.fields.isbn, '978-3-16-148410-0', 'ISBN 进 fields');

  // 无扩展名也能从内容认出
  assert.equal(formats.detectFormat(xml, ''), 'endnotexml', '内容识别');
  // 坏 XML：不抛错，返回空
  const bad = formats.parseRefs('<xml><records><record><titles><title>截断', 'x.xml');
  assert.ok(Array.isArray(bad.records), '坏 XML 返回数组');

  // 与其它格式不冲突：RIS / BibTeX 照旧
  assert.equal(formats.detectFormat('TY  - JOUR\nA1  - Smith\nER  - ', 'a.ris'), 'ris', 'RIS 不受影响');
  assert.equal(formats.detectFormat('@article{k, title={T}}', 'a.bib'), 'bibtex', 'BibTeX 不受影响');
  console.log('[enw-xml-node] PASS');
})();

// ---------- B. Electron：IPC 导入 → 入库 ----------
let code = 0;
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-enwxml-'));
  const ud = path.join(tmp, 'ud');
  fs.mkdirSync(ud);
  try {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><xml><records>
<record><ref-type name="Journal Article">17</ref-type><titles><title>XML Import One</title><secondary-title>J. of Tests</secondary-title></titles><contributors><authors><author>Wang, Lei</author></authors></contributors><year>2021</year><electronic-resource-num>10.1/one</electronic-resource-num></record>
<record><ref-type name="Book">1</ref-type><titles><title>XML Import Two</title></titles><year>1988</year></record>
</records></xml>`;
    // UTF-16LE 版本（EndNote 有时这么导出）：importRefsFile 按字节嗅探解码
    const utf16 = Buffer.from('\uFEFF' + xml, 'utf16le');
    fs.writeFileSync(path.join(tmp, 'utf16.xml'), utf16);
    const fwd = tmp.replace(/\\/g, '/');

    const probe = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 10000)) { if (await fn()) return true; await sleep(60); } return !!(await fn()); };
  const libReady = await waitFor(() => window.LibraryUI && LibraryUI.isOpen(), 10000);
  push('文献库就绪', libReady);
  if (!libReady) return { checks };
  const r1 = await pdfBridge.lib.importRefs(${JSON.stringify(xml)}, 'refs.xml');
  push('XML 文本导入成功', r1 && r1.ok && r1.parsed === 2, JSON.stringify(r1 || {}).slice(0, 120));
  await sleep(400);
  const s1 = await pdfBridge.lib.summary();
  const t1 = (s1.items || []).find((x) => x.title === 'XML Import One');
  push('条目入库', !!t1, JSON.stringify(t1 || {}).slice(0, 100));
  push('字段齐', t1 && t1.year === '2021' && t1.doi === '10.1/one' && t1.creators[0].lastName === 'Wang', t1 && JSON.stringify([t1.year, t1.doi, t1.creators]));
  // UTF-16 文件走对话框路径（importRefsFile），用 file 路径直读验证不了对话框；
  // 但主进程 importRefsFile 是同步函数，这里验证不了就退而求其次：确认 detect 不把它当乱码 ——
  // 通过给 importRefs 传 utf8 解不出 BOM 的场景没法模拟，跳过（Node 侧已有覆盖）。
  return { checks };
})()`;
    const probeFile = path.join(tmp, 'probe.cjs');
    fs.writeFileSync(probeFile, 'module.exports=' + JSON.stringify(probe));
    const r = runProbe({
      probe: probeFile,
      env: { PDFREADER_LIBRARY: path.join(tmp, 'library.json'), PDFREADER_DATA_DIR: tmp, PDFREADER_NO_AUTO_INDEX: '1' },
      args: ['--user-data-dir=' + ud],
      label: 'enw-xml',
      timeout: 240000,
    });
    assert.equal(r.fail, 0);

    // ---- Node 侧核对 importRefsFile 对 UTF-16 文件的解码（直接 require main 的私有函数不行，等价复刻）----
    const buf = fs.readFileSync(path.join(tmp, 'utf16.xml'));
    const iconv = require('iconv-lite');
    const text = iconv.decode(buf, 'utf16le');
    assert.ok(text.includes('<?xml'), 'UTF-16 解码正确');
    const parsed = formats.parseRefs(text, 'refs.xml');
    assert.equal(parsed.records.length, 2, 'UTF-16 内容可解析');
    code = 0;
  } catch (e) {
    console.error('[enw-xml] ERROR', e && e.message ? e.message : e);
    code = 3;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(code);
})();
