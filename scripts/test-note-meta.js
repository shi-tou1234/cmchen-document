'use strict';
/*
 * 笔记元数据与标题样式回归（v1.6）。
 *   Node 侧：normalizeNoteMeta 的规范化、addNote / updateNote 的落库、publicItem 的字段完整性。
 *   Electron 侧：面板开关、字数、状态与标签跨存储层往返、标题倍率真的改到预览字号。
 * 运行：node scripts/test-note-meta.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Library = require('../src/library.js');
const { runProbe } = require('./probe-runner');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  console.log('  FAIL ' + name + (detail === undefined ? '' : ' :: ' + detail));
}
function eq(name, got, want) {
  ok(name, got === want, 'got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want));
}

// ---------- A. 纯 Node：规范化与落库 ----------
(function nodePart() {
  const n1 = Library.normalizeNoteMeta(null);
  eq('空值给默认', JSON.stringify(n1), '{"tags":[],"status":""}');
  const n2 = Library.normalizeNoteMeta({ tags: ['  a  ', '', 'b', 3], status: 'draft' });
  eq('标签去空白与空项', JSON.stringify(n2.tags), '["a","b","3"]');
  eq('状态保留', n2.status, 'draft');
  eq('未知状态丢弃', Library.normalizeNoteMeta({ status: 'nope' }).status, '');
  const many = Library.normalizeNoteMeta({ tags: Array.from({ length: 30 }, (_, i) => 't' + i) });
  eq('标签最多 20 个', many.tags.length, 20);
  eq('单个标签截到 40 字', Library.normalizeNoteMeta({ tags: ['x'.repeat(100)] }).tags[0].length, 40);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-nmeta-'));
  try {
    Library.init(dir);
    const added = Library.addItem({ title: '带笔记的条目', itemType: 'book' });
    const key = added.key;
    const note = Library.addNote(key, { title: '笔记一', text: '正文' });
    eq('新笔记默认元数据为空', JSON.stringify(note.meta), '{"tags":[],"status":""}');

    const upd = Library.updateNote(key, note.id, { meta: { tags: ['方法'], status: 'final' } });
    eq('updateNote 写入 meta', JSON.stringify(upd.meta), '{"tags":["方法"],"status":"final"}');

    // publicItem 漏字段是这一块最容易犯的错（存得进、读不回），所以从 summary 读
    const s = Library.summary();
    const it = s.items.find((x) => x.key === key);
    ok('summary 里能拿到这条条目', !!it);
    ok('notes[].meta 出现在返回里', !!it.notes[0].meta);
    eq('读回的标签', (it.notes[0].meta.tags || []).join(','), '方法');
    eq('读回的状态', it.notes[0].meta.status, 'final');

    // 老笔记（没有 meta 字段）读出来要补默认，不能是 undefined
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'library.json'), 'utf8'));
    const rawItem = raw.items.find((x) => x.key === key);
    delete rawItem.notes[0].meta;
    fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify(raw));
    Library.resetCache();
    const s2 = Library.summary();
    const it2 = s2.items.find((x) => x.key === key);
    eq('老笔记补默认元数据', JSON.stringify(it2.notes[0].meta), '{"tags":[],"status":""}');

    // ---- R-v1.6-01：重启后 meta / imageW 不能丢 ----
    // 这条是「读盘规范化漏字段」的典型症状：保存时对、重启后变空，再保存就覆盖磁盘原值。
    Library.updateNote(key, note.id, { meta: { tags: ['重启'], status: 'draft' }, imageW: 360 });
    Library.resetCache();
    const s3 = Library.summary();
    const it3 = s3.items.find((x) => x.key === key);
    eq('重启后标签还在', (it3.notes[0].meta.tags || []).join(','), '重启');
    eq('重启后状态还在', it3.notes[0].meta.status, 'draft');
    eq('重启后截图宽度还在', it3.notes[0].imageW, 360);

    // 再存一次别的东西（比如正文），不能让上面几项被空值覆盖
    Library.updateNote(key, note.id, { text: '改一下正文' });
    Library.resetCache();
    const it4 = Library.summary().items.find((x) => x.key === key);
    eq('改正文后标签没被清空', (it4.notes[0].meta.tags || []).join(','), '重启');
    eq('改正文后宽度没被清零', it4.notes[0].imageW, 360);

    // imageW：0 是「原尺寸」的合法值，不能被夹到 40
    eq('imageW 0 保持 0', Library.normalizeImageW(0), 0);
    eq('imageW 空值保持 0', Library.normalizeImageW(null), 0);
    eq('imageW 正数下限 40', Library.normalizeImageW(3), 40);
    eq('imageW 上限 2400', Library.normalizeImageW(99999), 2400);
    eq('imageW 取整', Library.normalizeImageW(360.6), 361);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('[note-meta-node] PASS');
})();

// ---------- B. Electron 端到端 ----------
let code = 0;
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-nmeta-'));
  const ud = path.join(tmp, 'ud');
  fs.mkdirSync(path.join(ud, 'annotations'), { recursive: true });
  try {
    // 造一份带标注的文档 + 一张回顾卡片：自动链接只认「在回顾里」的卡片
    const src = path.join(tmp, 'fixture.pdf');
    fs.copyFileSync(path.join(__dirname, '../assets/sample.pdf'), src);
    fs.writeFileSync(path.join(tmp, 'library.json'), JSON.stringify({
      version: 8,
      items: [{ key: 'autolink-doc', title: '带标注的文档', attachment: { path: src } }],
    }));
    fs.writeFileSync(path.join(ud, 'annotations', 'a1b2c3d4e5f6a7b8.json'), JSON.stringify({
      path: src, saved: 1,
      pages: [{ page: 1, shapes: [
        { id: 'lnk1', tool: 'mark', text: '自动链接测试句子' },
        { id: 'lnk2', tool: 'mark', text: '短句' },
      ] }],
    }));
    fs.writeFileSync(path.join(ud, 'recall.json'), JSON.stringify({
      version: 1,
      cards: {
        lnk1: { addedAt: Date.now() - 1000, due: Date.now() - 1000, interval: 0, ease: 2.5, reps: 0, lapses: 0, last: 0, lastRating: 0 },
      },
    }));
    const { fail: probeFail } = runProbe({
      probe: path.join(__dirname, 'probe-note-meta.js'),
      env: {
        PDFREADER_LIBRARY: path.join(tmp, 'library.json'),
        PDFREADER_DATA_DIR: tmp,
        PDFREADER_NO_AUTO_INDEX: '1',
      },
      args: ['--user-data-dir=' + ud],
      label: 'note-meta',
      timeout: 240000,
    });
    code = probeFail ? 2 : 0;
    assert.equal(probeFail, 0);
  } catch (e) {
    console.error('[note-meta] ERROR', e && e.message ? e.message : e);
    code = 3;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  if (!code) console.log('test-note-meta: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(code || (fail ? 1 : 0));
})();
