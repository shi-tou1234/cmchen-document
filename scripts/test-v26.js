'use strict';
/*
 * v26 回归：去掉顶部原生菜单栏（文件 / 视图 / 系统）。
 * 注：v27 起用户要求统一全软件字体，标签页标题已从衬线体改回统一无衬线栈，
 *     本测试相应改为断言「不再出现 Georgia / Times New Roman」。
 *
 * 菜单里的功能并没有丢，各自挪到了：
 *   打开 PDF      → 工具栏「打开」/ 标签栏「＋」/ Ctrl+O
 *   最近打开      → 文档快速切换面板（还多了「清空」）
 *   专注阅读模式  → F11 / 页面右键菜单
 *   导出当前页    → 页面右键菜单 / Ctrl+Shift+P
 *   导出全部批注  → 批注面板导出条上的「全部」
 *   导入/导出文献 → 文献库工具栏
 *   备份/恢复/设置→ 文献库「设置」面板
 *   默认阅读器/开发者工具 → 设置面板「其他」
 *
 * 运行：node scripts/test-v26.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runProbe } = require('./probe-runner');

const ROOT = path.join(__dirname, '..');
const SAMPLE = path.join(ROOT, 'assets', 'sample.pdf');

let code = 0;
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-v26-'));
  const udd = path.join(tmp, 'ud');
  fs.mkdirSync(udd);
  try {
    const { fail } = runProbe({
      probe: path.join(__dirname, 'probe-v26.js'),
      env: {
        PDFREADER_PROBE_PDF: SAMPLE,
        PDFREADER_DATA_DIR: tmp,
        PDFREADER_LIBRARY: path.join(tmp, 'library.json'),
        PDFREADER_NO_AUTO_INDEX: '1',
      },
      args: ['--user-data-dir=' + udd],
      label: 'v26',
      timeout: 240000,
    });
    code = fail ? 2 : 0;
  } catch (e) {
    console.error('[v26] ERROR', e && e.message ? e.message : e);
    code = 3;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(code);
})();
