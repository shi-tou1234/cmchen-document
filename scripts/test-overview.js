'use strict';
/*
 * Overview 候选弹窗回归（v1.6）：真实 Electron + 真库（含占位 PDF 文件）。
 * 命中判定 / 候选排序的纯逻辑在 test-portal.js；这里验的是「IPC 通不通、界面接不接得住」。
 * 运行：node scripts/test-overview.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runProbe } = require('./probe-runner');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-ov-'));
const udd = path.join(tmp, 'ud');
fs.mkdirSync(udd);
// portal-candidates 会先过滤「附件文件还在」，所以这里要真的放几个文件。
// 内容不重要：候选排序只读标题 / 年份 / 作者，不解析 PDF。
const papers = {
  p1: 'Reading interfaces for scholars.pdf',
  p2: 'Deep learning for document analysis.pdf',
  p3: 'Cooking with cast iron.pdf',
  pcur: '正在读的这篇.pdf',
};
const mk = (name) => { const p = path.join(tmp, name); fs.writeFileSync(p, '%PDF-1.4\n%%EOF\n'); return p; };
const paths = Object.keys(papers).reduce((acc, k) => { acc[k] = mk(papers[k]); return acc; }, {});

fs.writeFileSync(path.join(tmp, 'library.json'), JSON.stringify({
  version: 8,
  collections: [],
  searches: [],
  items: [
    {
      key: 'k2', itemType: 'journalArticle', title: 'Reading interfaces for scholars', year: '2021',
      creators: [{ firstName: 'Mei', lastName: 'Zhang', creatorType: 'author' }],
      attachment: { path: paths.p1, name: papers.p1 },
    },
    {
      key: 'k1', itemType: 'journalArticle', title: 'Deep learning for document analysis', year: '2020',
      creators: [{ firstName: 'John', lastName: 'Smith', creatorType: 'author' }],
      attachment: { path: paths.p2, name: papers.p2 },
    },
    {
      key: 'k3', itemType: 'book', title: 'Cooking with cast iron', year: '2018',
      creators: [{ firstName: 'Lee', lastName: 'Kim', creatorType: 'author' }],
      attachment: { path: paths.p3, name: papers.p3 },
    },
    {
      key: 'kcur', itemType: 'journalArticle', title: 'Some survey this article cites', year: '2019',
      attachment: { path: paths.pcur, name: papers.pcur },
    },
  ],
}));

let code = 0;
try {
  const { fail } = runProbe({
    probePath: path.join(__dirname, 'probe-overview.js'),
    tmpDir: tmp,
    env: {
      PDFREADER_DATA_DIR: tmp,
      PDFREADER_LIBRARY: path.join(tmp, 'library.json'),
      PDFREADER_NO_AUTO_INDEX: '1',
    },
    args: ['--user-data-dir=' + udd],
    label: 'overview',
    timeout: 240000,
  });
  code = fail ? 2 : 0;
} catch (e) {
  console.error('[overview] ERROR', e && e.message ? e.message : e);
  code = 3;
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
}
process.exit(code);
