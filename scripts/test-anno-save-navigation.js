'use strict';

// A failed annotation write must keep the current document and its unsaved edits.
// Use a real read-only destination on Windows, without replacing the save IPC.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { runProbe } = require('./probe-runner');

if (process.platform !== 'win32') {
  console.log('test-anno-save-navigation: skipped (Windows read-only destination)');
  process.exit(0);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-save-navigation-'));
const ud = path.join(dir, 'ud');
const a = path.join(dir, 'a.pdf');
const b = path.join(dir, 'b.pdf');
const sidecar = path.join(ud, 'annotations',
  crypto.createHash('sha1').update(path.resolve(a)).digest('hex').slice(0, 20) + '.json');

function probe(readonly) {
  const file = path.join(dir, readonly ? 'readonly.cjs' : 'writable.cjs');
  const code = `(async () => {
    const checks = [];
    const push = (name, ok, detail) => checks.push([name, !!ok, JSON.stringify(detail)]);
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const wait = async fn => {
      for (let i = 0; i < 300; i++) { if (fn()) return true; await sleep(40); }
      return false;
    };
    await wait(() => window.LibraryUI && LibraryUI.isOpen());
    LibraryUI.hide();
    window.__libOpen(await pdfBridge.lib.openItem('a', 1));
    const loaded = await wait(() => App.state.filePath === ${JSON.stringify(a)} &&
      App.state.annoState.status === 'ok');
    push('A annotations loaded', loaded, App.state.annoState);
    if (!loaded) return { checks };
    const shapes = App.state.annos.get(1) || [];
    shapes.push({ id: 'unsaved-edit', tool: 'text', text: 'UNSAVED_EDIT',
      at: { x: 80, y: 90 }, size: 14, color: '#111111' });
    App.state.annos.set(1, shapes);
    const flushed = await App.flushAnnos();
    push('real save result matches destination permissions', flushed === ${!readonly}, flushed);
    window.__libOpen(await pdfBridge.lib.openItem('b', 1));
    if (${readonly}) {
      await sleep(700);
      push('write failure blocks navigation', App.state.filePath === ${JSON.stringify(a)}, App.state.filePath);
      push('unsaved edit remains in memory', (App.state.annos.get(1) || [])
        .some(sh => sh.id === 'unsaved-edit'), App.state.fileName);
    } else {
      push('successful save permits navigation', await wait(() =>
        App.state.filePath === ${JSON.stringify(b)} && App.state.annoState.status !== 'unknown'), App.state.filePath);
    }
    return { checks };
  })()`;
  fs.writeFileSync(file, 'module.exports=' + JSON.stringify(code));
  const result = runProbe({
    probe: file,
    env: { PDFREADER_LIBRARY: path.join(dir, 'library.json'), PDFREADER_DATA_DIR: dir,
      PDFREADER_NO_AUTO_INDEX: '1' },
    args: ['--user-data-dir=' + ud],
    timeout: 45000,
    label: readonly ? 'anno-navigation-readonly' : 'anno-navigation-writable',
  });
  assert.equal(result.fail, 0, 'navigation probe failed');
}

try {
  fs.mkdirSync(path.dirname(sidecar), { recursive: true });
  for (const p of [a, b]) fs.copyFileSync(path.join(__dirname, '../assets/sample.pdf'), p);
  fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify({ version: 8, items: [
    { key: 'a', title: 'A', attachment: { path: a } },
    { key: 'b', title: 'B', attachment: { path: b } },
  ] }));
  const original = JSON.stringify({ path: a, pages: [{ page: 1, shapes: [
    { id: 'original', tool: 'text', text: 'ORIGINAL', at: { x: 20, y: 30 }, size: 14 },
  ] }] });
  fs.writeFileSync(sidecar, original);
  fs.chmodSync(sidecar, 0o444);
  probe(true);
  assert.equal(fs.readFileSync(sidecar, 'utf8'), original, 'failed write changed the saved file');
  fs.chmodSync(sidecar, 0o666);
  probe(false);
  assert(fs.readFileSync(sidecar, 'utf8').includes('UNSAVED_EDIT'), 'successful write lost the new edit');
  console.log('test-anno-save-navigation: PASS');
} finally {
  if (fs.existsSync(sidecar)) fs.chmodSync(sidecar, 0o666);
  if (dir.startsWith(path.join(os.tmpdir(), 'trove-save-navigation-'))) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
