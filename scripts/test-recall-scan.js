'use strict';
/*
 * 回顾 × 标注扫描完整性（第四轮审核 R4-01）。
 *
 * 旧行为：listAllAnnotations() 遇到单个标注文件读失败就跳过，调用方无法分辨「这次扫描完整吗」，
 * 把结果交给 recall.prune() 后，读失败文件里的卡片会被当成「标注已删除」永久移除。
 *
 * 这个脚本跑两趟真实 Electron（同一数据目录）：
 *   第一趟：两个 sidecar，其中一个是不完整 JSON。卡片有三张（s1 / s2 / ghost），
 *           s2 就在坏文件里。扫描不完整 → 一张都不许删；
 *   第二趟：把坏文件修好（内容合法、含 s2），扫描完整了 → 只有真的没有标注的 ghost 被清掉。
 * 这样既证明「读失败不清进度」，也证明「正常情况仍然会清孤儿卡」。
 *
 * 运行：node scripts/test-recall-scan.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runProbe } = require('./probe-runner');

const DAY = 86400000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-recall-scan-'));

const PROBE = `(async()=>{
  const checks=[];const push=(n,v,d)=>checks.push([n,!!v,d===undefined?'':String(d)]);
  const st=await pdfBridge.recall.state(30);
  const ids=Object.keys(st.cards||{}).sort();
  push('回顾状态接口可读',!!st&&st.ok===true);
  push('卡片：'+ids.join(','),ids.length>0);
  push('pruned='+st.pruned+' · scanIncomplete='+st.scanIncomplete,true);
  return {checks,state:st,ids};
})()`;

function probeOnce(label) {
  const probeFile = path.join(dir, 'probe-' + label + '.cjs');
  fs.writeFileSync(probeFile, 'module.exports=' + JSON.stringify(PROBE));
  return runProbe({
    probe: probeFile,
    env: { PDFREADER_LIBRARY: path.join(dir, 'library.json'), PDFREADER_DATA_DIR: dir, PDFREADER_NO_AUTO_INDEX: '1' },
    args: ['--user-data-dir=' + path.join(dir, 'ud')],
    label: label,
    timeout: 120000,
  });
}

try {
  const source = path.join(dir, 'fixture.pdf');
  fs.copyFileSync(path.join(__dirname, '../assets/sample.pdf'), source);
  fs.mkdirSync(path.join(dir, 'ud/annotations'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify({ version: 8, items: [
    { key: 'a', title: 'Scan document', attachment: { path: source } },
  ] }));

  const annoDir = path.join(dir, 'ud/annotations');
  const goodFile = path.join(annoDir, 'aa11bb22cc33dd44.json');
  const badFile = path.join(annoDir, 'ee55ff66aa77bb88.json');
  // 好文件：一条标注 s1
  fs.writeFileSync(goodFile, JSON.stringify({ path: source, saved: 1, pages: [{ page: 1, shapes: [
    { id: 's1', tool: 'mark', text: 'visible annotation' },
  ] }] }));
  // 坏文件：JSON 截断（模拟写入中断 / 磁盘临时读失败）
  fs.writeFileSync(badFile, '{"path":"' + source.replace(/\\/g, '\\\\') + '","pages":[{"page":2,"shapes":[{"id":"s2"');

  // 三张卡：s1 正常、s2 在坏文件里（有 7 次历史）、ghost 根本没有对应标注
  const card = (reps) => ({ addedAt: Date.now() - DAY * 30, due: Date.now() - DAY, interval: 4, ease: 2.6, reps, lapses: 0, last: Date.now() - DAY * 4, lastRating: 3 });
  fs.writeFileSync(path.join(dir, 'ud/recall.json'), JSON.stringify({ version: 1, cards: {
    s1: card(2), s2: card(7), ghost: card(1),
  } }));

  // 第一趟：扫描不完整，一张都不许删
  const r1 = probeOnce('recall-scan-incomplete');
  assert.equal(r1.fail, 0, '第一趟有失败项');
  const st1 = r1.res.state || {};
  const ids1 = Object.keys(st1.cards || {}).sort();
  assert.equal(ids1.length, 3, '扫描不完整时三张卡都该在，实际：' + JSON.stringify(ids1));
  assert.ok(ids1.indexOf('s2') >= 0, '坏文件里的卡片被误删了');
  assert.equal(st1.pruned, 0, '扫描不完整时不该清理任何卡片，实际 pruned=' + st1.pruned);
  assert.equal(st1.scanIncomplete, true, '接口应标出「这次扫描不完整」');
  assert.equal(st1.stats.total, 3, '统计里的总数也该是 3');
  const disk1 = JSON.parse(fs.readFileSync(path.join(dir, 'ud/recall.json'), 'utf8'));
  assert.equal(Object.keys(disk1.cards).length, 3, '磁盘上不该少卡片');
  assert.equal(disk1.cards.s2.reps, 7, 's2 的复习历史必须原样保留');

  // 第二趟：把坏文件修好（含 s2），扫描完整 → 只清掉 ghost
  fs.writeFileSync(badFile, JSON.stringify({ path: source, saved: 1, pages: [{ page: 2, shapes: [
    { id: 's2', tool: 'mark', text: 'annotation from the repaired file' },
  ] }] }));
  const r2 = probeOnce('recall-scan-complete');
  assert.equal(r2.fail, 0, '第二趟有失败项');
  const st2 = r2.res.state || {};
  const ids2 = Object.keys(st2.cards || {}).sort();
  assert.deepEqual(ids2, ['s1', 's2'], '扫描完整时只该清掉孤儿卡片，实际：' + JSON.stringify(ids2));
  assert.equal(st2.pruned, 1, '孤儿卡片应被清掉 1 张，实际 pruned=' + st2.pruned);
  assert.equal(st2.scanIncomplete, false, '扫描完整时不该标 incomplete');

  console.log('test-recall-scan: 第一趟 ' + (r1.total || 0) + ' + 落盘 8 项、第二趟 ' + (r2.total || 0) + ' + 落盘 3 项，全部通过');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
