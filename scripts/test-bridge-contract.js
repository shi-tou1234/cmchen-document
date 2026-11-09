'use strict';
/*
 * 桥接契约检查（I01 / I03 的根因防线）。
 *
 * preload 把接口挂在 pdfBridge 与 pdfBridge.lib 两层。渲染层以前有 3 处写错层级，
 * 外面套了 if (pdfBridge.onX) 就静默跳过，功能整段失效却没有任何报错：
 *   · renderer.js 用 pdfBridge.onFilesRenamed（实际在 lib 下）→ 改名通知收不到；
 *   · library-ui.js 用 pdfBridge.onFtIndexChanged / onFtIndexIdle（实际在 lib 下）
 *     → 索引完成后不重跑当前查询。
 *
 * 这个测试做两件事：
 *   1. 静态提取 src/renderer/*.js 里引用的所有 pdfBridge 路径（跳过注释行）；
 *   2. 在真实 preload 里逐个确认存在，任何一个不存在就失败——不再让错层级的
 *      「可选能力」判断把必需功能藏起来。
 *
 * 运行：node scripts/test-bridge-contract.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runProbe } = require('./probe-runner');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'src/renderer');

let fail = 0;
let total = 0;
function check(name, ok, detail) {
  total++;
  if (!ok) { fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  <- ' + JSON.stringify(detail) : '')); }
  else console.log('  ok   ' + name);
}

function extractBridgeRefs() {
  const found = new Map();
  const files = fs.readdirSync(RENDERER).filter((f) => f.endsWith('.js'));
  for (const f of files) {
    const lines = fs.readFileSync(path.join(RENDERER, f), 'utf8').split(/\r?\n/);
    let inBlock = false;
    lines.forEach((line, i) => {
      const t = line.trim();
      if (inBlock) { if (t.includes('*/')) inBlock = false; return; }
      if (t.startsWith('/*')) { if (!t.includes('*/')) inBlock = true; return; }
      if (t.startsWith('//') || t.startsWith('*')) return;
      const re = /pdfBridge(\.lib)?\.([A-Za-z_$][\w$]*)/g;
      let m;
      while ((m = re.exec(line))) {
        const key = (m[1] ? 'lib.' : '') + m[2];
        if (key === 'lib') continue;      // pdfBridge.lib 本身不是接口
        if (!found.has(key)) found.set(key, []);
        if (found.get(key).length < 3) found.get(key).push(f + ':' + (i + 1));
      }
    });
  }
  return found;
}

const PROBE = `(async () => {
  const b = window.pdfBridge || {};
  const lib = b.lib || {};
  const types = {};
  for (const k of ['onFilesRenamed', 'onFtIndexChanged', 'onFtIndexIdle']) types[k] = typeof lib[k];
  return { root: Object.keys(b), lib: Object.keys(lib), types };
})()`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-bridge-contract-'));
try {
  const probeFile = path.join(tmp, 'probe.cjs');
  fs.writeFileSync(probeFile, 'module.exports=' + JSON.stringify(PROBE));
  const r = runProbe({
    probe: probeFile,
    env: { PDFREADER_NO_AUTO_INDEX: '1' },
    label: 'bridge-probe',
    timeout: 60000,
  });
  const api = r.res || {};
  const root = new Set(api.root || []);
  const lib = new Set(api.lib || []);
  check('桥接探针拿到了 pdfBridge 与 pdfBridge.lib', root.size > 0 && lib.size > 0, { root: root.size, lib: lib.size });

  const refs = extractBridgeRefs();
  check('渲染层确实引用了桥接接口', refs.size > 20, refs.size);
  const missing = [];
  for (const [key, where] of refs) {
    const isLib = key.startsWith('lib.');
    const name = isLib ? key.slice(4) : key;
    const set = isLib ? lib : root;
    if (!set.has(name)) missing.push({ key, where });
  }
  check('渲染层引用的桥接接口全部存在', missing.length === 0, missing);

  check('I01 改名通知订阅在 lib 下', api.types && api.types.onFilesRenamed === 'function', api.types);
  check('I03 索引 change 订阅在 lib 下', api.types && api.types.onFtIndexChanged === 'function', api.types);
  check('I03 索引 idle 订阅在 lib 下', api.types && api.types.onFtIndexIdle === 'function', api.types);
} finally {
  if (tmp.startsWith(path.join(os.tmpdir(), 'trove-bridge-contract-'))) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
}

console.log('[bridge-contract] ' + (fail ? 'FAIL ' : 'PASS ') + '(' + total + ')');
process.exitCode = fail ? 1 : 0;
