'use strict';
/*
 * 库界面端到端驱动：种一个含 1 条目/1 收藏集的临时库 → 以探针模式启动真实 app
 * （src/main.js，含全部 lib-* IPC handler）→ 解析主进程打印的 [libui-result] → 断言。
 * 纯 node 运行（内部再 spawn electron）。运行：node scripts/test-library-ui.js
 */
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const SAMPLE = path.join(ROOT, 'assets', 'sample.pdf');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'libui-'));
const libFile = path.join(tmp, 'library.json');
const udd = path.join(tmp, 'ud');
fs.mkdirSync(udd);
// v2 种子：2 条在库 + 1 条在回收站；两个收藏集；摘要/笔记/DOI/页码都覆盖到
fs.writeFileSync(libFile, JSON.stringify({
  version: 2,
  collections: [
    { id: 'col1', name: '论文库', parentId: null },
    { id: 'col2', name: '方法集', parentId: 'col1' },
  ],
  items: [
    { key: 'itA', itemType: 'journalArticle', title: 'Alpha', creators: ['张三'], year: '2020',
      publication: '测试期刊', volume: '12', issue: '3', pages: '45-67', doi: '10.1/x', url: '',
      abstract: 'transformer 摘要', note: '', language: 'zh', tags: ['ML'], collectionIds: ['col1'],
      attachment: { path: SAMPLE, name: 'sample.pdf' }, page: 12, created: 1, updated: 1, deletedAt: 0 },
    { key: 'itB', itemType: 'document', title: 'Beta', creators: ['李四'], year: '2022',
      publication: '', volume: '', issue: '', pages: '', doi: '', url: '',
      abstract: '', note: 'diffusion 笔记', language: '', tags: ['DL'], collectionIds: ['col1', 'col2'],
      attachment: { path: SAMPLE, name: 'sample.pdf' }, page: 0, created: 2, updated: 2, deletedAt: 0 },
    { key: 'itC', itemType: 'thesis', title: 'Gamma', creators: [], year: '2018',
      publication: '', volume: '', issue: '', pages: '', doi: '', url: '',
      abstract: '', note: '', language: '', tags: [], collectionIds: [],
      attachment: { path: SAMPLE, name: 'sample.pdf' }, page: 0, created: 3, updated: 3, deletedAt: 123 },
  ],
}));

try {
  const env = Object.assign({}, process.env, {
    PDFREADER_LIBUI: '1',
    PDFREADER_LIBRARY: libFile,
  });
  delete env.ELECTRON_RUN_AS_NODE;
  const out = execFileSync(ELECTRON, ['.', '--no-sandbox', '--disable-gpu', '--user-data-dir=' + udd],
    { cwd: ROOT, env, encoding: 'utf8', timeout: 120000 });
  const text = String(out);
  const line = text.split(/\r?\n/).find((l) => l.includes('[probe-result]'));
  if (!line) {
    console.log('[lib-ui] FAIL — 没拿到 [probe-result]\n' + text.slice(-800));
    process.exit(2);
  }
  const res = JSON.parse(line.slice(line.indexOf('{')));
  if (res.fatal) { console.log('[lib-ui] FAIL — 探针抛错: ' + res.fatal); process.exit(2); }
  let fail = 0;
  for (const [n, ok, detail] of res.checks) {
    if (!ok) fail++;
    console.log((ok ? '  ok   ' : '  FAIL ') + n + (!ok && detail ? '  <- ' + detail : ''));
  }
  console.log('[lib-ui] ' + (fail ? 'FAIL (' + fail + '/' + res.checks.length + ')' : 'PASS (' + res.checks.length + ')'));
  process.exit(fail ? 2 : 0);
} catch (e) {
  console.error('[lib-ui] ERROR', e && e.message ? e.message : e);
  process.exit(3);
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
}
