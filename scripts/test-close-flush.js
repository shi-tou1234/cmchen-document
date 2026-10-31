'use strict';
/*
 * 关窗前保存（v1.6d）回归：真实 Electron + 真实关窗。
 *
 * 场景：改完标注**立刻**关窗。标注是 600ms 防抖保存的，不拦这一下，最后那批改动会丢。
 * 修法是主进程拦 close → 通知渲染层 flush → 回报结果 → 再真正关闭。
 * 所以断言必须看**磁盘**：探针只管制造「内存有、磁盘还没有」的状态然后关窗，
 * 进程退出后由 Node 侧读 sidecar 判断到底存没存下来。
 *
 * 运行：node scripts/test-close-flush.js
 */
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runProbe } = require('./probe-runner');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-close-flush-'));
const udd = path.join(tmp, 'ud');
fs.mkdirSync(path.join(udd, 'annotations'), { recursive: true });
const pdf = path.join(tmp, 'close.pdf');
fs.copyFileSync(path.join(__dirname, '../assets/sample.pdf'), pdf);
fs.writeFileSync(path.join(tmp, 'library.json'), JSON.stringify({
  version: 8,
  items: [{
    key: 'c1', title: '关窗前保存', attachment: { path: pdf },
    notes: [{ id: 'n1', title: '', text: '旧正文', html: '<p>旧正文</p>' }],
  }],
}));
const annoFile = path.join(udd, 'annotations',
  crypto.createHash('sha1').update(path.resolve(pdf)).digest('hex').slice(0, 20) + '.json');

let code = 0;
try {
  // 探针是「导出模板字符串」的模块：这里把 PDF 路径替换进去再落成一个临时模块，
  // 与 test-main-race 同一套做法（渲染进程没有 process/env，常量只能提前注入）
  const src = require('./probe-close-flush.js').split('__PDF__').join(JSON.stringify(pdf));
  const probeFile = path.join(tmp, 'probe.cjs');
  fs.writeFileSync(probeFile, 'module.exports=' + JSON.stringify(src));
  let probeErr = '';
  let fail = 0;
  try {
    const r = runProbe({
      probe: probeFile,
      env: {
        PDFREADER_LIBRARY: path.join(tmp, 'library.json'),
        PDFREADER_DATA_DIR: tmp,
        PDFREADER_NO_AUTO_INDEX: '1',
      },
      args: ['--user-data-dir=' + udd],
      label: 'close-flush',
      timeout: 120000,
    });
    fail = r.fail || 0;
  } catch (e) {
    probeErr = String((e && e.message) || e);
  }

  // 进程已经退出：磁盘上到底有没有那条「关窗前最后一刻」的标注？
  const exists = fs.existsSync(annoFile);
  assert.ok(exists, '关窗后应该写出标注文件：' + annoFile + (probeErr ? '（探针：' + probeErr.slice(0, 160) + '）' : ''));
  const data = JSON.parse(fs.readFileSync(annoFile, 'utf8'));
  const shapes = (data.pages || []).flatMap((p) => p.shapes || []);
  const hit = shapes.find((s) => s.id === 'close-1');
  assert.ok(hit, '关窗前刚加的那条标注必须落盘，实际：' + JSON.stringify(shapes.map((s) => s.id)));
  assert.strictEqual(hit.text, '关窗前最后一条', '标注文字要原样保存');
  code = (fail || probeErr) ? 2 : 0;
  if (probeErr) console.error('[close-flush] 探针异常：' + probeErr.slice(0, 200));

  // ---- 超时提示的约束（纯 Node，不需要 Electron）：Esc 永远不等于「放弃」 ----
  const CloseDlg = require('../src/closedlg.js');
  for (const rounds of [1, 2, 3, 5, 20]) {
    const p = CloseDlg.waitPrompt(rounds);
    assert.ok(p.buttons.indexOf('继续等待') === 0, '第 ' + rounds + ' 轮也要保留「继续等待」：' + p.buttons);
    assert.strictEqual(p.cancelId, 0, '第 ' + rounds + ' 轮的 Esc 必须等于继续等待');
    assert.strictEqual(p.defaultId, 0, '第 ' + rounds + ' 轮的默认按钮必须等于继续等待');
    assert.ok(p.buttons.length === 2, '第 ' + rounds + ' 轮按钮数：' + p.buttons.length);
  }
  const failed = CloseDlg.saveFailedPrompt('磁盘满');
  assert.strictEqual(failed.buttons[failed.cancelId], '返回处理', '保存失败的 Esc 必须是「返回处理」');
  assert.ok(failed.detail.indexOf('磁盘满') >= 0, '失败原因要带进提示');
} catch (e) {
  console.error('[close-flush] FAIL', e && e.message ? e.message : e);
  code = code || 3;
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
}
if (!code) console.log('[close-flush] PASS');
process.exit(code);
