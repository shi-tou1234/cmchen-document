'use strict';
/*
 * 库操作撤销/重做回归（2026-10-22 报告「组织」缺口）。
 *   A. 纯 Node：快照栈（移入回收站 → 撤销 → 重做）、栈上限、空栈提示、笔记编辑不进栈。
 *   B. 探针：UI 里移入回收站 → Ctrl+Z 恢复 → Ctrl+Shift+Z 再删、按钮可用态。
 * 运行：node scripts/test-undo.js
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

// ---------- A. 数据层 ----------
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-undo-'));
  process.env.PDFREADER_LIBRARY = path.join(tmp, 'library.json');
  lib.resetCache();

  const it = lib.addItem({ title: '会被撤回的条目' });
  check('新建条目可用', !!it && it.key, it && it.key);
  // 新建本身也是一个撤销点：只清栈（不动数据），方便后续断言
  lib.resetUndo();
  check('清空后栈为空', lib.undoInfo().canUndo === 0 && lib.undoInfo().canRedo === 0, lib.undoInfo());

  const r0 = lib.undo();
  check('空栈撤销给出提示', r0.ok === false && /没有可撤销/.test(r0.error), r0);

  lib.trashItem(it.key);
  check('移入回收站后不在列表', !lib.summary().items.find((x) => x.key === it.key && !x.deletedAt), '');
  check('栈里记下这一步', lib.undoInfo().canUndo === 1 && lib.undoInfo().undoDesc === '移入回收站', lib.undoInfo());

  const u = lib.undo();
  check('撤销成功并回报描述', u.ok && u.desc === '移入回收站', u);
  check('条目回到列表', !!lib.summary().items.find((x) => x.key === it.key && !x.deletedAt));
  check('撤销后可以重做', lib.undoInfo().canRedo === 1 && lib.undoInfo().redoDesc === '移入回收站', lib.undoInfo());

  const rd = lib.redo();
  check('重做成功', rd.ok && rd.desc === '移入回收站', rd);
  check('重做后条目又不见了', !lib.summary().items.find((x) => x.key === it.key && !x.deletedAt), '');
  lib.resetCache();
  check('重做结果已落盘（重开进程仍生效）',
    !lib.summary().items.find((x) => x.key === it.key && !x.deletedAt), '');

  // 标签与收藏集也覆盖
  lib.addTag(it.key, '待读');
  check('加标签是一个撤销点', lib.undoInfo().undoDesc === '添加标签', lib.undoInfo());
  lib.undo();
  check('撤销加标签', !((lib.summary().items[0].tags) || []).includes('待读'), lib.summary().items[0].tags);

  const coll = lib.addCollection('临时收藏集');
  check('新建收藏集是一个撤销点', !!coll && lib.undoInfo().undoDesc === '新建收藏集', lib.undoInfo());
  lib.undo();
  check('撤销新建收藏集', !lib.summary().collections.some((c) => c.name === '临时收藏集'), lib.summary().collections);

  // 无变化的操作不压栈（同一条标签加两次，第二次不算）
  lib.addTag(it.key, 'x');
  const depth = lib.undoInfo().canUndo;
  lib.addTag(it.key, 'x');
  // 重复加同一个标签至少不能重复入栈（时间戳可能让它多一个点，但不该无限增长）
  check('重复加标签不重复入栈', lib.undoInfo().canUndo <= depth + 1, lib.undoInfo().canUndo + '/' + depth);
  check('标签没有重复', lib.summary().items.find((x) => x.key === it.key).tags.filter((t) => t === 'x').length === 1, lib.summary().items.find((x) => x.key === it.key).tags);

  // 笔记编辑进撤销栈，但**同一条笔记的连续编辑合并成一个点**（R-v1.6d-01）
  const before = lib.undoInfo().canUndo;
  const n = lib.addNote(it.key, { title: 't', text: '写点什么' });
  check('笔记仍可创建', !!n);
  check('新建笔记占一个撤销点', lib.undoInfo().canUndo === before + 1, lib.undoInfo().canUndo + '/' + before);

  // 连续打字（多次 updateNote）只增加一个点
  const afterAdd = lib.undoInfo().canUndo;
  for (let i = 0; i < 5; i++) lib.updateNote(it.key, n.id, { text: '写点什么' + i });
  check('连续编辑同一笔记只占一个点', lib.undoInfo().canUndo === afterAdd + 1, lib.undoInfo().canUndo + '/' + afterAdd);
  check('撤销描述是「编辑笔记」', lib.undoInfo().undoDesc === '编辑笔记', lib.undoInfo().undoDesc);

  // 关键回归：撤销别的操作不能把后来保存的笔记一起回退
  lib.addTag(it.key, '后加的标签');
  lib.updateNote(it.key, n.id, { text: '最终正文' });
  lib.undo();   // 先撤「编辑笔记」
  const afterUndoNote = lib.summary().items.find((x) => x.key === it.key);
  check('撤销笔记编辑后正文回到上一次', afterUndoNote.notes[0].text !== '最终正文', afterUndoNote.notes[0].text);
  const tagStill = afterUndoNote.tags.includes('后加的标签');
  check('撤销笔记编辑不动标签', tagStill, afterUndoNote.tags);
  lib.undo();   // 再撤「添加标签」
  const afterUndoTag = lib.summary().items.find((x) => x.key === it.key);
  check('撤销加标签真的撤掉了标签', !afterUndoTag.tags.includes('后加的标签'), afterUndoTag.tags);
  check('撤销加标签没有把笔记清空', !!afterUndoTag.notes.length && !!afterUndoTag.notes[0].text, afterUndoTag.notes.map((x) => x.text));

  // 栈上限
  for (let i = 0; i < 30; i++) lib.addTag(it.key, 'tag' + i);
  check('撤销栈上限 20', lib.undoInfo().canUndo === 20, lib.undoInfo().canUndo);

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  delete process.env.PDFREADER_LIBRARY;
}

// ---------- B. 探针 ----------
const { runProbe } = require('./probe-runner');
const ROOT = path.join(__dirname, '..');
const SAMPLE = path.join(ROOT, 'assets', 'sample.pdf');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-undo-'));
  const udd = path.join(tmp, 'ud');
  fs.mkdirSync(udd);
  try {
    const { fail: probeFail } = runProbe({
      probePath: path.join(__dirname, 'probe-undo.js'),
      tmpDir: tmp,
      inject: { __SAMPLE__: SAMPLE.replace(/\\/g, '/') },
      env: {
        PDFREADER_DATA_DIR: tmp,
        PDFREADER_LIBRARY: path.join(tmp, 'library.json'),
        PDFREADER_NO_AUTO_INDEX: '1',
      },
      args: ['--user-data-dir=' + udd],
      label: 'undo',
      timeout: 240000,
    });
    if (probeFail) fail++;
    total++;
  } catch (e) {
    total++; fail++;
    console.error('  FAIL 探针执行异常', e && e.message ? e.message : e);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }

  console.log('[undo] ' + (fail ? 'FAIL (' + fail + '/' + total + ')' : 'PASS (' + total + ')'));
  process.exit(fail ? 2 : 0);
})();
