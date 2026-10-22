'use strict';
/*
 * 标注视图端到端：种一份带批注的文档（annotations/<hash>.json）+ 一个引用它的条目，
 * 以探针模式启动真实 app，检查「标注」入口 / 列表 / 选中 / 打标签 / 导出排版。
 * 纯 node 运行（内部再 spawn electron）。运行：node scripts/test-anno-items.js
 */
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const SAMPLE = path.join(ROOT, 'assets', 'sample.pdf');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'annoitems-'));
const libFile = path.join(tmp, 'library.json');
const udd = path.join(tmp, 'ud');
fs.mkdirSync(udd);
// 标注文件按文件路径的 sha1 命名（和主进程一致）
const hash = crypto.createHash('sha1').update(path.resolve(SAMPLE)).digest('hex').slice(0, 20);
const annoDir = path.join(udd, 'annotations');
fs.mkdirSync(annoDir);
fs.writeFileSync(path.join(annoDir, hash + '.json'), JSON.stringify({
  path: SAMPLE, saved: Date.now(),
  pages: [{ page: 2, shapes: [
    { tool: 'mark', color: '#ffd84d', text: '关键结论：结构化作者是引用格式的地基', rects: [{ x: 10, y: 10, w: 100, h: 12 }] },
    { tool: 'pen', color: '#e53935', rects: [{ x: 20, y: 40, w: 40, h: 20 }] },
  ] }],
}));
fs.writeFileSync(libFile, JSON.stringify({
  version: 6, collections: [], searches: [], tagColors: {},
  items: [{
    key: 'itA', itemType: 'journalArticle', title: '被批注的论文', creators: ['张三'],
    year: '2020', publication: '测试期刊', tags: [], collectionIds: [],
    attachment: { path: SAMPLE, name: 'sample.pdf' },
    page: 1, created: 1, updated: 1, deletedAt: 0,
  }],
}));

try {
  const env = Object.assign({}, process.env, {
    PDFREADER_LIBRARY: libFile,
    PDFREADER_PROBE: path.join(__dirname, 'probe-anno.js'),
  });
  delete env.ELECTRON_RUN_AS_NODE;
  const out = execFileSync(ELECTRON, ['.', '--no-sandbox', '--disable-gpu', '--user-data-dir=' + udd],
    { cwd: ROOT, env, encoding: 'utf8', timeout: 120000 });
  const text = String(out);
  const line = text.split(/\r?\n/).find((l) => l.includes('[probe-result]'));
  if (!line) {
    console.log('[anno-items] FAIL — 没拿到 [probe-result]\n' + text.slice(-800));
    process.exit(2);
  }
  const res = JSON.parse(line.slice(line.indexOf('{')));
  if (res.fatal) { console.log('[anno-items] FAIL — 探针抛错: ' + res.fatal); process.exit(2); }
  let fail = 0;
  for (const [n, ok, detail] of res.checks) {
    if (!ok) fail++;
    console.log((ok ? '  ok   ' : '  FAIL ') + n + (!ok && detail ? '  <- ' + detail : ''));
  }
  console.log('[anno-items] ' + (fail ? 'FAIL (' + fail + '/' + res.checks.length + ')' : 'PASS (' + res.checks.length + ')'));
  process.exit(fail ? 2 : 0);
} catch (e) {
  console.error('[anno-items] ERROR', e && e.message ? e.message : e);
  process.exit(3);
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
}
