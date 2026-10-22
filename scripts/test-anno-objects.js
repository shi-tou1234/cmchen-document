'use strict';
/*
 * 标注条目化第二阶段回归（2026-10-22，报告优先级第 2 项）：
 *   A. 数据层 v8：稳定 id 迁移、标签键重映射、标注对象编辑、条目双向关联、笔记带图。
 *   B. 探针：真实 app 里验证「标注可编辑 + 详情面板标注区块 + 生成带图笔记」端到端。
 * 运行：node scripts/test-anno-objects.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('../src/library.js');

let fail = 0, total = 0;
function check(name, ok, detail) {
  total++;
  if (!ok) { fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  <- ' + JSON.stringify(detail) : '')); }
  else console.log('  ok   ' + name);
}

// ---------- A1. v7 → v8 迁移 + 标签并入对象层 ----------
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-anno8-'));
  const store = path.join(tmp, 'library.json');
  fs.writeFileSync(store, JSON.stringify({
    version: 7, collections: [], searches: [], tagColors: {},
    annoTags: { 'abc:1:0': ['方法'], 'abc:2:1': ['待读', '方法'] },
    items: [{ key: 'itA', title: '旧条目', itemType: 'document', creators: [], tags: [], collectionIds: [] }],
  }));
  process.env.PDFREADER_LIBRARY = store;
  lib.resetCache();
  let sum = lib.summary();
  check('v7 库升到 v8', sum.version === 8, sum.version);
  check('旧标签并入标注对象', ((sum.annoMeta['abc:1:0'] || {}).tags || []).join(',') === '方法', sum.annoMeta);
  check('多条标签不丢', ((sum.annoMeta['abc:2:1'] || {}).tags || []).length === 2, sum.annoMeta['abc:2:1']);

  // 稳定 id 重映射（老位置式 id → 新 id）
  const r = lib.remapAnnoTags({ 'abc:1:0': 'aNEW1', 'abc:2:1': 'aNEW2' });
  sum = lib.summary();
  check('标签键重映射到新 id', r.remapped === 2
    && ((sum.annoMeta.aNEW1 || {}).tags || []).includes('方法')
    && !sum.annoMeta['abc:1:0'], JSON.stringify(r));
  check('旧 annoTags 位置被清掉', !Object.keys(sum.annoTags || {}).length, sum.annoTags);

  // 编辑标注对象
  const u = lib.updateAnno('aNEW1', { text: '新的文字', comment: '新的批注' });
  sum = lib.summary();
  check('编辑标注文字/批注', u.ok && sum.annoMeta.aNEW1.text === '新的文字' && sum.annoMeta.aNEW1.comment === '新的批注', u);
  check('编辑会盖时间戳', sum.annoMeta.aNEW1.updated > 0, sum.annoMeta.aNEW1.updated);

  // 双向关联
  const l = lib.linkAnnoToItem('aNEW1', 'itA');
  sum = lib.summary();
  check('标注 → 条目（itemKey）', l.ok && sum.annoMeta.aNEW1.itemKey === 'itA', l);
  check('条目 → 标注（annoIds）', (sum.items.find((x) => x.key === 'itA').annoIds || []).includes('aNEW1'), sum.items[0].annoIds);
  const ul = lib.unlinkAnno('aNEW1');
  sum = lib.summary();
  check('解除关联两边都清', ul.ok && !sum.annoMeta.aNEW1.itemKey
    && !(sum.items.find((x) => x.key === 'itA').annoIds || []).includes('aNEW1'), ul);

  // 笔记带图 + 标注记 noteId
  const n = lib.addNote('itA', { title: '标注 · 第 1 页', text: '摘录', image: 'snapshots/x.png', annoIds: ['aNEW1'] });
  sum = lib.summary();
  const note = (sum.items.find((x) => x.key === 'itA').notes || [])[0];
  check('笔记带截图路径', !!note && note.image === 'snapshots/x.png', note);
  check('笔记记下来源标注', !!note && note.annoIds.includes('aNEW1'), note && note.annoIds);
  lib.updateAnno('aNEW1', { noteIds: [n.id] });
  check('标注记下生成的笔记', ((lib.annoMetaOf('aNEW1') || {}).noteIds || []).includes(n.id), lib.annoMetaOf('aNEW1'));

  // 重开进程（读盘）后对象层还在
  lib.resetCache();
  const again = lib.summary();
  check('重开进程后标注对象还在', ((again.annoMeta.aNEW2 || {}).tags || []).includes('待读'), again.annoMeta.aNEW2);

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  delete process.env.PDFREADER_LIBRARY;
}

// ---------- B. 探针：真实 app 端到端 ----------
const { runProbe } = require('./probe-runner');
const ROOT = path.join(__dirname, '..');
const SAMPLE = path.join(ROOT, 'assets', 'sample.pdf');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-anno8-'));
  const udd = path.join(tmp, 'ud');
  fs.mkdirSync(udd);
  try {
    const { fail: probeFail } = runProbe({
      probePath: path.join(__dirname, 'probe-anno-objects.js'),
      tmpDir: tmp,
      inject: { __SAMPLE__: SAMPLE.replace(/\\/g, '/') },
      env: {
        PDFREADER_DATA_DIR: tmp,
        PDFREADER_LIBRARY: path.join(tmp, 'library.json'),
        PDFREADER_NO_AUTO_INDEX: '1',
      },
      args: ['--user-data-dir=' + udd],
      label: 'anno-objects',
      timeout: 300000,
    });
    if (probeFail) fail++;
    total++;
  } catch (e) {
    total++; fail++;
    console.error('  FAIL 探针执行异常', e && e.message ? e.message : e);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }

  console.log('[anno-objects] ' + (fail ? 'FAIL (' + fail + '/' + total + ')' : 'PASS (' + total + ')'));
  process.exit(fail ? 2 : 0);
})();
