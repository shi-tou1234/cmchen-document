'use strict';
/*
 * v13 缺陷修复回归：把 v12 复查里实测复现的 6 组 bug 固化成断言。
 * 真实 Electron + 临时 userData + 临时库，不碰真实数据。
 * 覆盖：
 *   1) 页码指示器：只改 scrollTop 时，页码必须等于视口顶部那一页
 *   2) 搜索清空：并发清空 / 搜完再清空，都不能留下高亮和结果
 *   3) 缩放下拉框：缩放后不能空着
 *   4) 键盘：按钮聚焦时空格不能翻页（也不能吃掉按钮的原生激活）
 *   5) 跨文档撤销：切文档后 undo 不得把上一份文档的标注带进新文档
 *   6) 文献库覆盖层：有「返回阅读」退路；收起时弹窗要跟着关；Esc 逐层关闭
 *   7) 拖放：拖进库时阅读器不重复打开
 * 运行：node scripts/test-bugfix.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runProbe } = require('./probe-runner');

const ROOT = path.join(__dirname, '..');
const SAMPLE = path.join(ROOT, 'assets', 'sample.pdf');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-bugfix-'));
const udd = path.join(tmp, 'ud');
fs.mkdirSync(udd);

let code = 0;
try {
  const { fail } = runProbe({
    probe: path.join(__dirname, 'probe-bugfix.js'),
    env: {
      PDFREADER_PROBE_PDF: SAMPLE,
      PDFREADER_DATA_DIR: tmp,
      PDFREADER_LIBRARY: path.join(tmp, 'library.json'),
      PDFREADER_NO_AUTO_INDEX: '1',
    },
    args: ['--user-data-dir=' + udd],
    label: 'bugfix',
    timeout: 180000,
  });
  code = fail ? 2 : 0;
} catch (e) {
  console.error('[bugfix] ERROR', e && e.message ? e.message : e);
  code = 3;
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
}
process.exit(code);
