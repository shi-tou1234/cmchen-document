'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const R = require('../src/data-resources');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-resources-'));
function write(p, s) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); }
try {
  const a = path.join(dir, 'a'), b = path.join(dir, 'b');
  write(path.join(a, 'snapshots/note.png'), 'old picture');
  write(path.join(a, 'snapshots/web.mhtml'), 'MIME-Version: 1.0');
  write(path.join(a, 'styles/custom.csl'), '<style/>');
  write(path.join(a, 'attachments/paper.pdf'), '%PDF-test');
  write(path.join(b, 'snapshots/note.png'), 'target picture');
  const tx = new R.FileTransaction();
  const map = R.installResources(tx, b, a);
  const store = R.remapStore({ items: [{
    attachment: { path: path.join(a, 'attachments/paper.pdf') },
    snapshot: { path: path.join(a, 'snapshots/web.mhtml'), png: path.join(a, 'snapshots/note.png') },
    notes: [{ image: 'snapshots/note.png', text: '![img](snapshots/note.png)', html: '<img src="snapshots/note.png">' }],
  }, { attachment: { path: path.join(dir, 'external.pdf') } }] }, a, b, map);
  tx.commit(); tx.dispose();
  assert.equal(fs.readFileSync(path.join(b, 'snapshots/note.png'), 'utf8'), 'target picture');
  const note = store.items[0].notes[0];
  assert.notEqual(note.image, 'snapshots/note.png');
  assert.equal(fs.readFileSync(path.join(b, note.image), 'utf8'), 'old picture');
  assert(note.text.includes(note.image) && note.html.includes(note.image));
  assert.equal(store.items[0].attachment.path, path.join(b, 'attachments/paper.pdf'));
  assert.equal(store.items[1].attachment.path, path.join(dir, 'external.pdf'));
  assert(fs.existsSync(store.items[0].snapshot.path));
  const bundle = R.readBundle(a);
  assert.equal(Object.keys(bundle).length, 4);
  const large = new R.FileTransaction();
  try {
    const big = Buffer.alloc(10 * 1024 * 1024, 65);
    R.installResources(large, b, null, { 'attachments/large.pdf': big.toString('base64') });
    large.commit();
    assert.equal(fs.statSync(path.join(b, 'attachments/large.pdf')).size, big.length, 'large base64 resource restores without regex stack overflow');
  } finally { large.dispose(); }
  assert.throws(() => R.readBundle(a, 1), /备份上限/);
  const collision = new R.FileTransaction();
  try {
    const suffix = crypto.createHash('sha256').update('source').digest('hex').slice(0, 12);
    write(path.join(b, 'snapshots/collision.png'), 'target');
    const files = { 'snapshots/collision.png': Buffer.from('source').toString('base64'), ['snapshots/collision-' + suffix + '.png']: Buffer.from('different').toString('base64') };
    const mapping = R.installResources(collision, b, null, files); collision.commit();
    for (const [name, contents] of Object.entries(files)) assert.equal(fs.readFileSync(path.join(b, mapping.get(name))).toString('base64'), contents, 'staged destinations do not overwrite one another');
  } finally { collision.dispose(); }
  for (const bad of ['../bad', 'snapshots/../../bad', 'snapshots/C:/bad', 'styles/./bad']) assert.throws(() => R.safeName(bad));
  const invalid = new R.FileTransaction();
  try { assert.throws(() => R.installResources(invalid, b, null, { 'snapshots/bad.png': '!!!' }), /编码/); }
  finally { invalid.dispose(); }
  // Fail after publishing one write: all old content must remain usable.
  const first = path.join(b, 'first.json'), second = path.join(b, 'second.json');
  write(first, 'before'); write(second, 'before2');
  const rollback = new R.FileTransaction();
  rollback.add(first, 'after'); rollback.add(second, 'after2');
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (to === second) throw new Error('injected failure'); return rename(from, to); };
  try { assert.throws(() => rollback.commit(), /injected failure/); }
  finally { fs.renameSync = rename; rollback.dispose(); }
  assert.equal(fs.readFileSync(first, 'utf8'), 'before'); assert.equal(fs.readFileSync(second, 'utf8'), 'before2');
  console.log('[data-resources] PASS');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
