'use strict';
/*
 * v11 界面流程回归：库级全文检索 / 智能收藏集 / 批量编辑 / 设置 / 备份。
 * 真实 Electron（含全部 lib-* IPC），临时库与临时数据目录隔离。
 * 运行：node scripts/test-ui-v11.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runProbe } = require('./probe-runner');

const ROOT = path.join(__dirname, '..');
const SAMPLE = path.join(ROOT, 'assets', 'sample.pdf');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-v11-'));
const udd = path.join(tmp, 'ud');
fs.mkdirSync(udd);
const libFile = path.join(tmp, 'library.json');
fs.writeFileSync(libFile, JSON.stringify({
  version: 3,
  collections: [{ id: 'col1', name: '论文库', parentId: null }],
  searches: [],
  items: [
    { key: 'itA', itemType: 'journalArticle', title: 'Alpha', creators: ['张三'], year: '2020', publication: '测试期刊', doi: '10.1000/a', tags: [], collectionIds: ['col1'], attachment: { path: SAMPLE, name: 'sample.pdf' }, page: 2, created: 2, updated: 2 },
    { key: 'itB', itemType: 'journalArticle', title: 'Beta', creators: ['李四'], year: '2022', publication: '测试期刊', doi: '10.1000/b', tags: [], collectionIds: [], attachment: { path: SAMPLE, name: 'sample.pdf' }, created: 1, updated: 1 },
  ],
}, null, 2));

let code = 0;
try {
  const { fail, res } = runProbe({
    probe: path.join(__dirname, 'probe-ui-v11.js'),
    env: { PDFREADER_LIBRARY: libFile, PDFREADER_DATA_DIR: tmp, PDFREADER_NO_AUTO_INDEX: '1' },
    args: ['--user-data-dir=' + udd],
    label: 'ui-v11',
    timeout: 180000,
  });
  let extraFail = 0;
  const extra = (name, ok, detail) => {
    if (!ok) { extraFail++; console.log('  FAIL ' + name + (detail ? '  <- ' + detail : '')); }
    else console.log('  ok   ' + name);
  };

  // 备份文件内容：库、设置、标注、说明都要在，且索引不在备份里
  const bakPath = res && res.bakPath;
  extra('备份文件落在数据目录', !!bakPath && fs.existsSync(bakPath), String(bakPath));
  if (bakPath && fs.existsSync(bakPath)) {
    let bak = null;
    try { bak = JSON.parse(fs.readFileSync(bakPath, 'utf8')); } catch (_) {}
    extra('备份是合法 JSON', !!bak);
    extra('备份带 app/format 标记', !!bak && bak.app === 'pdf-reader' && bak.format === 1, JSON.stringify(bak && [bak.app, bak.format]));
    extra('备份含 2 条条目', !!bak && bak.library.items.length === 2, String(bak && bak.library.items.length));
    extra('备份含设置', !!bak && bak.settings && bak.settings.theme === 'dark', JSON.stringify(bak && bak.settings));
    extra('备份含标注集合', !!bak && Array.isArray(bak.annotations));
    extra('备份不含全文索引', !!bak && !('fulltext' in bak) && /全文索引不包含在备份内/.test(bak.note || ''), bak && bak.note);
  }

  const failTotal = fail + extraFail;
  console.log('[ui-v11] ' + (failTotal ? 'FAIL (' + failTotal + ')' : 'PASS'));
  code = failTotal ? 2 : 0;
} catch (e) {
  console.error('[ui-v11] ERROR', e && e.message ? e.message : e);
  code = 3;
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
}
process.exit(code);
