'use strict';
/*
 * CSL 用户样式端到端回归：主进程扫描 <数据目录>/styles → 渲染进程注册 → 下拉 → 预览 → 删除。
 * 运行：node scripts/test-csl-ui.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runProbe } = require('./probe-runner');

const ROOT = path.join(__dirname, '..');
const SAMPLE = path.join(ROOT, 'assets', 'sample.pdf');

const PROBE_STYLE = `<?xml version="1.0" encoding="utf-8"?>
<style xmlns="http://purl.org/net/xbiblio/csl" class="in-text" version="1.0" default-locale="en-US">
  <info>
    <title>Probe Style</title>
    <id>http://example.com/styles/probe-style</id>
  </info>
  <bibliography>
    <layout>
      <group delimiter=" | ">
        <text variable="title" prefix="PROBE:"/>
        <text variable="year"/>
      </group>
    </layout>
  </bibliography>
</style>
`;

let code = 0;
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-csl-'));
  const udd = path.join(tmp, 'ud');
  fs.mkdirSync(udd);
  const libFile = path.join(tmp, 'library.json');
  fs.writeFileSync(libFile, JSON.stringify({
    version: 3, collections: [], searches: [],
    items: [
      {
        key: 'itA', itemType: 'journalArticle', title: 'Attention Is All You Need',
        creators: ['Ashish Vaswani', 'Noam Shazeer'], year: '2017', publication: 'NeurIPS',
        volume: '30', issue: '2', pages: '5998-6008', doi: '10.1000/attn',
        tags: [], collectionIds: [], attachment: { path: SAMPLE, name: 'sample.pdf' },
        page: 1, created: 2, updated: 2,
      },
    ],
  }, null, 2));
  fs.mkdirSync(path.join(tmp, 'styles'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'styles', 'probe-style.csl'), PROBE_STYLE, 'utf8');

  try {
    const { fail } = runProbe({
      probe: path.join(__dirname, 'probe-csl.js'),
      env: {
        PDFREADER_PROBE_PDF: SAMPLE,
        PDFREADER_DATA_DIR: tmp,
        PDFREADER_LIBRARY: libFile,
        PDFREADER_NO_AUTO_INDEX: '1',
      },
      args: ['--user-data-dir=' + udd],
      label: 'csl-ui',
      timeout: 180000,
    });
    code = fail ? 2 : 0;
  } catch (e) {
    console.error('[csl-ui] ERROR', e && e.message ? e.message : e);
    code = 3;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(code);
})();
