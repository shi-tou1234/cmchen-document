'use strict';
/*
 * v35 多集合并集回归：Ctrl / Cmd + 点击收藏集取并集，普通点击单选，取消后回到全部。
 * 运行：node scripts/test-library-multi-collection.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runProbe } = require('./probe-runner');

let code = 0;
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-multi-coll-'));
  const ud = path.join(dir, 'ud');
  fs.mkdirSync(ud);
  try {
    const item = (key, title, colls) => ({
      key, itemType: 'journalArticle', title, creators: [], year: '2024',
      publication: '', tags: [], collectionIds: colls, attachment: null, page: 0,
      created: 1, updated: 1,
    });
    fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify({
      version: 8,
      collections: [
        { id: 'c1', name: '论文', parentId: null },
        { id: 'c2', name: '书', parentId: null },
        { id: 'c3', name: '笔记', parentId: null },
      ],
      searches: [],
      tagColors: {},
      annoMeta: {},
      items: [
        item('a', 'Alpha', ['c1']),
        item('b', 'Beta', ['c1', 'c2']),
        item('c', 'Gamma', ['c2']),
        item('d', 'Delta', ['c3']),
        item('e', 'Epsilon', []),
      ],
    }, null, 2));

    const { fail } = runProbe({
      probePath: path.join(__dirname, 'probe-library-multi-collection.js'),
      tmpDir: dir,
      env: {
        PDFREADER_DATA_DIR: dir,
        PDFREADER_LIBRARY: path.join(dir, 'library.json'),
        PDFREADER_NO_AUTO_INDEX: '1',
      },
      args: ['--user-data-dir=' + ud],
      label: 'library-multi-collection',
      timeout: 180000,
    });
    code = fail ? 2 : 0;
  } catch (e) {
    console.error('[library-multi-collection] ERROR', e && e.message ? e.message : e);
    code = 3;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(code);
})();
