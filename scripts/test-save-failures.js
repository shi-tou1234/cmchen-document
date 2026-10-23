'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const lib = require('../src/library');
const settings = require('../src/settings');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-save-fail-'));
const write = fs.writeFileSync, rename = fs.renameSync;
function fault(method, action) {
  const original = fs[method];
  fs[method] = (...args) => {
    if (String(args[0]).startsWith(dir)) throw Object.assign(new Error('test disk failure'), { code: 'ENOSPC' });
    return original(...args);
  };
  try { action(); } finally { fs[method] = original; }
}
try {
  lib.init(dir); lib.resetCache();
  const item = lib.addItem({ title: 'Before' });
  const note = lib.addNote(item.key, { text: 'Original note' });
  lib.resetUndo();
  const disk = fs.readFileSync(lib.filePath(), 'utf8');
  for (const method of ['writeFileSync', 'renameSync']) {
    fault(method, () => {
      assert.throws(() => lib.updateItem(item.key, { title: 'Unsaved' }), /保存失败/);
      assert.equal(lib.findItem(item.key).title, 'Before', 'cache rolled back');
      assert.equal(fs.readFileSync(lib.filePath(), 'utf8'), disk, 'last good file preserved');
      assert.equal(lib.undoInfo().canUndo, 0, 'failed mutation adds no undo entry');
      assert.throws(() => lib.updateNote(item.key, note.id, { text: 'Unsaved note' }), /保存失败/);
      assert.equal(lib.findItem(item.key).notes[0].text, 'Original note');
    });
  }
  lib.updateItem(item.key, { title: 'After' });
  fault('renameSync', () => {
    assert.equal(lib.undo().ok, false);
    assert.equal(lib.findItem(item.key).title, 'After');
    assert.equal(lib.undoInfo().canUndo, 1, 'failed undo stays retryable');
  });
  assert.equal(lib.undo().ok, true);
  fault('writeFileSync', () => {
    assert.equal(lib.redo().ok, false);
    assert.equal(lib.findItem(item.key).title, 'Before');
    assert.equal(lib.undoInfo().canRedo, 1);
  });
  assert.equal(lib.redo().ok, true);
  settings.init(dir); assert.equal(settings.set({ theme: 'dark' }).ok, true);
  const previous = fs.readFileSync(settings.filePath(), 'utf8');
  fault('renameSync', () => {
    const r = settings.set({ theme: 'light' });
    assert.equal(r.ok, false); assert.equal(r.settings.theme, 'dark');
    assert.equal(settings.get().theme, 'dark');
    assert.equal(fs.readFileSync(settings.filePath(), 'utf8'), previous);
  });
  assert.equal(fs.readdirSync(dir).some(f => f.endsWith('.tmp')), false, 'temporary writes cleaned');
  console.log('[save-failures] PASS');
} finally {
  fs.writeFileSync = write; fs.renameSync = rename;
  fs.rmSync(dir, { recursive: true, force: true });
}
