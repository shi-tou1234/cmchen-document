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

// ---------- A2. G04：迁移要把反向引用（条目 / 笔记）一起搬 ----------
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-anno-refs-'));
  const store = path.join(tmp, 'library.json');
  fs.writeFileSync(store, JSON.stringify({
    version: 8, collections: [], searches: [], tagColors: {}, feeds: [], noteAliases: {},
    annoTags: {}, annoMeta: {},
    items: [
      { key: 'itA', title: '甲', itemType: 'document', creators: [], tags: [], collectionIds: [], annoIds: [] },
      { key: 'itB', title: '乙', itemType: 'document', creators: [], tags: [], collectionIds: [], annoIds: [] },
    ],
  }));
  process.env.PDFREADER_LIBRARY = store;
  lib.init(store); lib.resetCache(); lib.resetUndo();

  const OLD = 'abc:1:0';
  const NEW = 'aSTABLE001';
  lib.setAnnoTags(OLD, ['方法']);
  lib.linkAnnoToItem(OLD, 'itA');                 // 条目 → 标注
  const nt = lib.addNote('itA', { title: '笔记', text: '来自标注', annoIds: [OLD] });

  const r = lib.remapAnnoTags({ [OLD]: NEW });
  check('G04 迁移报告成功', r.ok && r.remapped === 1, r);
  let sum = lib.summary();
  const a = sum.items.find((x) => x.key === 'itA');
  check('G04 条目 annoIds 指向新 ID', (a.annoIds || []).join(',') === NEW, a.annoIds);
  check('G04 条目里没有旧 ID', !(a.annoIds || []).includes(OLD), a.annoIds);
  const note = (a.notes || []).find((x) => x.id === nt.id);
  check('G04 笔记 annoIds 指向新 ID', !!note && note.annoIds.join(',') === NEW, note && note.annoIds);

  // 统计口径：迁移后仍然只算一个条目有标注
  const LibStats = require('../src/libstats.js');
  check('G04 迁移后统计仍为 1 个条目带标注', LibStats.compute(sum.items).withAnnos === 1, LibStats.compute(sum.items).withAnnos);

  // 解除关联：旧条目不能残留旧 ID
  lib.unlinkAnno(NEW);
  sum = lib.summary();
  const a2 = sum.items.find((x) => x.key === 'itA');
  check('G04 解除关联后条目 annoIds 为空', (a2.annoIds || []).length === 0, a2.annoIds);
  check('G04 解除关联后统计归零', LibStats.compute(sum.items).withAnnos === 0, LibStats.compute(sum.items).withAnnos);

  // 重新关联到另一个条目：只算一个归属
  lib.linkAnnoToItem(NEW, 'itB');
  sum = lib.summary();
  check('G04 重新关联后只有新条目带标注', LibStats.compute(sum.items).withAnnos === 1, LibStats.compute(sum.items).withAnnos);
  check('G04 旧条目仍为空', (sum.items.find((x) => x.key === 'itA').annoIds || []).length === 0, sum.items.find((x) => x.key === 'itA').annoIds);

  // 重放：不重复、不新增
  const r2 = lib.remapAnnoTags({ [OLD]: NEW });
  sum = lib.summary();
  check('G04 重复迁移是空操作', r2.ok && r2.remapped === 0, r2);
  check('G04 重放后 annoIds 不重复', (sum.items.find((x) => x.key === 'itB').annoIds || []).join(',') === NEW,
    sum.items.find((x) => x.key === 'itB').annoIds);

  // 「旧 meta 键早就没了、只剩旧引用」也要能补（以前会整条跳过）
  const s2 = lib.load();
  s2.items.find((x) => x.key === 'itB').annoIds = [OLD];
  lib.save();
  const r3 = lib.remapAnnoTags({ [OLD]: NEW });
  sum = lib.summary();
  check('G04 只剩旧引用时也能补齐', r3.ok && (sum.items.find((x) => x.key === 'itB').annoIds || []).join(',') === NEW,
    sum.items.find((x) => x.key === 'itB').annoIds);

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
