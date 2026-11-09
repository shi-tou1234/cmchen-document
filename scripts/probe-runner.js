'use strict';
/*
 * Electron 探针运行器：spawn 真实 app（主进程 + IPC + preload），
 * 让探针在渲染进程里跑断言，解析 [probe-result] 并统一输出/退出码。
 * 约定：探针模块导出的是字符串形式的 async IIFE，返回 { checks: [[名称, ok, 详情]] }。
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

// 没显式指定 --user-data-dir 的调用，一律分一个临时目录，避免单个测试忘记传参
// 就启动默认用户配置（会改动真实 session.json / Preferences）。进程退出时统一清掉。
const AUTO_DIRS = [];
process.on('exit', () => {
  for (const d of AUTO_DIRS) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
  }
});

function runProbe(opts) {
  const o = opts || {};
  // 支持注入：probePath + inject（渲染进程没有 process/env，常量直接替换进探针源码）
  let probeFile = o.probe;
  if (o.probePath) {
    const fs = require('fs');
    let src = fs.readFileSync(o.probePath, 'utf8');
    for (const [k, v] of Object.entries(o.inject || {})) {
      src = src.split(k).join(String(v));
    }
    probeFile = o.tmpProbe || (o.tmpDir ? path.join(o.tmpDir, path.basename(o.probePath)) : path.join(os.tmpdir(), 'probe-' + Date.now() + '.js'));
    fs.writeFileSync(probeFile, src);
  }
  const env = Object.assign({}, process.env, o.env || {}, { PDFREADER_PROBE: probeFile });
  delete env.ELECTRON_RUN_AS_NODE;
  const extraArgs = (o.args || []).slice();
  const hasUserData = extraArgs.some((a) => String(a).startsWith('--user-data-dir='));
  let isolated = null;
  if (!hasUserData) {
    isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-probe-'));
    AUTO_DIRS.push(isolated);
    extraArgs.push('--user-data-dir=' + isolated);
    // 显式配置优先：只补调用方没给的那几个目录
    if (!env.PDFREADER_LIBRARY) env.PDFREADER_LIBRARY = path.join(isolated, 'library.json');
    if (!env.PDFREADER_DATA_DIR) env.PDFREADER_DATA_DIR = path.join(isolated, 'data');
  }
  // 隐藏 / 后台窗口会被 Chromium 节流，页块渲染与 rendered.get(1) 可能一直等不到；
  // 这是界面探针偶发超时的环境因素，与被测逻辑无关。
  const args = ['.', '--no-sandbox', '--disable-gpu',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows'].concat(extraArgs);
  let out = '';
  try {
    out = execFileSync(ELECTRON, args, {
      cwd: ROOT, env, encoding: 'utf8', timeout: o.timeout || 180000,
    });
  } catch (err) {
    out = String((err && err.stdout) || '') + '\n' + String((err && err.stderr) || '');
    if (!/\[probe-result\]/.test(out)) {
      throw new Error('Electron 异常退出且没有探针结果：' + ((err && err.message) || err) + '\n' + out.slice(-1200));
    }
  }
  const line = out.split(/\r?\n/).find((l) => l.includes('[probe-result]'));
  if (!line) throw new Error('没有拿到 [probe-result]\n' + out.slice(-1200));
  let res;
  try { res = JSON.parse(line.slice(line.indexOf('{'))); }
  catch (e) { throw new Error('探针结果不是合法 JSON：' + line.slice(0, 300)); }
  if (res.fatal) throw new Error('探针抛错：' + res.fatal);

  const checks = Array.isArray(res.checks) ? res.checks : [];
  let fail = 0;
  for (const [name, okFlag, detail] of checks) {
    if (!okFlag) { fail++; console.log('  FAIL ' + name + (detail ? '  <- ' + detail : '')); }
    else console.log('  ok   ' + name);
  }
  const label = o.label || 'probe';
  console.log('[' + label + '] ' + (fail ? 'FAIL (' + fail + '/' + checks.length + ')' : 'PASS (' + checks.length + ')'));
  return { res, checks, fail, total: checks.length, out };
}

module.exports = { runProbe, ROOT, ELECTRON };
