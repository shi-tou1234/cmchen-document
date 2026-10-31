'use strict';
/*
 * 使用指南回归（v1.6）：真实 Electron + 空库。
 * 覆盖：入口（工具栏 / F1 / 命令面板 / 库 / 设置 / 空态）、78 节逐节渲染、
 *       搜索与回车打开、Esc 关闭、「在界面定位」、从说明直达功能、无脚本错误。
 * 运行：node scripts/test-help.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runProbe } = require('./probe-runner');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-help-'));
const udd = path.join(tmp, 'ud');
fs.mkdirSync(udd);
const libFile = path.join(tmp, 'library.json');
fs.writeFileSync(libFile, JSON.stringify({
  version: 3,
  collections: [],
  searches: [],
  items: [],
}, null, 2));

let code = 0;
try {
  const { fail } = runProbe({
    probe: path.join(__dirname, 'probe-help.js'),
    env: {
      PDFREADER_LIBRARY: libFile,
      PDFREADER_DATA_DIR: tmp,
      PDFREADER_NO_AUTO_INDEX: '1',
    },
    args: ['--user-data-dir=' + udd],
    label: 'help',
    timeout: 180000,
  });
  code = fail ? 2 : 0;
} catch (e) {
  console.error('[help] ERROR', e && e.message ? e.message : e);
  code = 3;
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
}
process.exit(code);
