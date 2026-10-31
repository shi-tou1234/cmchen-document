'use strict';
/*
 * 笔记图片缩放回归（v1.6）：真实 Electron。
 * 两条持久化路径都验 stone 到存储层：NV 编辑器的 #w= 标记（Markdown 源码），
 * 详情面板截图的 notes[].imageW（结构化字段）。
 * 运行：node scripts/test-note-image.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runProbe } = require('./probe-runner');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-img-'));
const udd = path.join(tmp, 'ud');
fs.mkdirSync(udd);
fs.writeFileSync(path.join(tmp, 'library.json'), JSON.stringify({
  version: 8,
  collections: [],
  searches: [],
  items: [
    {
      key: 'kd1', itemType: 'journalArticle', title: '带对话列表的页面', year: '2024',
      created: 100,
      notes: [{ id: 'nimg', title: '', text: '', image: 'snapshots/x.png', created: 100 }],
    },
  ],
}));

let code = 0;
try {
  const { fail } = runProbe({
    probe: path.join(__dirname, 'probe-note-image.js'),
    env: {
      PDFREADER_DATA_DIR: tmp,
      PDFREADER_LIBRARY: path.join(tmp, 'library.json'),
      PDFREADER_NO_AUTO_INDEX: '1',
    },
    args: ['--user-data-dir=' + udd],
    label: 'note-image',
    timeout: 240000,
  });
  code = fail ? 2 : 0;
} catch (e) {
  console.error('[note-image] ERROR', e && e.message ? e.message : e);
  code = 3;
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
}
process.exit(code);
