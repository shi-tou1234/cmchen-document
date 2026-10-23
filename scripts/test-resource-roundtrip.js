'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { runProbe } = require('./probe-runner');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-roundtrip-'));
const a = path.join(dir, 'old'), b = path.join(dir, 'new'), c = path.join(dir, 'restored');
function write(file, data) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); }
function probe(name, code, dataDir, extraEnv = {}) {
  const file = path.join(dir, name + '.cjs'); write(file, 'module.exports=' + JSON.stringify(code));
  const r = runProbe({ probe: file, env: { PDFREADER_NO_AUTO_INDEX: '1', ...extraEnv }, args: ['--user-data-dir=' + dataDir], label: name });
  assert.equal(r.fail, 0); return r.res;
}
try {
  const managed = path.join(a, 'attachments/paper.pdf');
  write(managed, fs.readFileSync(path.join(__dirname, '../assets/sample.pdf')));
  write(path.join(a, 'snapshots/note.png'), fs.readFileSync(path.join(__dirname, '../assets/icon-16.png')));
  write(path.join(a, 'snapshots/web.mhtml'), 'MIME-Version: 1.0\r\n\r\nSaved web page');
  write(path.join(a, 'styles/custom.csl'), '<style><info><title>Custom</title></info></style>');
  const store = { version: 8, items: [{ key: 'a', title: 'Original', attachment: { path: managed },
    notes: [{ id: 'n', text: '![image](snapshots/note.png)', image: 'snapshots/note.png' }],
    snapshot: { path: path.join(a, 'snapshots/web.mhtml'), png: path.join(a, 'snapshots/note.png') },
  }] };
  store.items.push({ key: 'a2', title: 'Shared document', attachment: { path: managed } }, { key: 'dup', title: 'Source collision', attachment: { path: managed } });
  write(path.join(a, 'library.json'), JSON.stringify(store));
  const hash = crypto.createHash('sha1').update(managed).digest('hex').slice(0, 20);
  write(path.join(a, 'annotations', hash + '.json'), JSON.stringify({ path: managed, pages: [{ page: 1, shapes: [{ id: 'anno1', tool: 'text', text: 'Retained annotation' }] }] }));
  const targetDoc = path.join(dir, 'target.pdf'); fs.copyFileSync(managed, targetDoc);
  const targetHash = crypto.createHash('sha1').update(targetDoc).digest('hex').slice(0, 20);
  write(path.join(a, 'annotations', targetHash + '.json'), JSON.stringify({ path: targetDoc, pages: [{ page: 1, shapes: [{ id: 'target', tool: 'text', text: 'Target annotation' }] }] }));
  write(path.join(b, 'library.json'), JSON.stringify({ version: 8, items: [{ key: 'b', title: 'Target' }, { key: 'dup', title: 'Target collision', attachment: { path: targetDoc } }] }));
  write(path.join(b, 'snapshots/note.png'), 'Target picture stays intact');
  const backup = path.join(dir, 'backup.json');
  probe('migrate-resources', `(async()=>{
    const checks=[]; const push=(n,v)=>checks.push([n,!!v]);
    const backup=await pdfBridge.lib.backup(${JSON.stringify(backup)}); push('backup succeeds',backup.ok);
    const r=await pdfBridge.lib.chooseDataDir(${JSON.stringify(b)},'merge'); push('migration succeeds',r.ok);
    const sum=await pdfBridge.lib.summary(); const item=sum.items.find(it=>it.key==='a');
    push('both libraries retained',sum.items.length===4);
    push('same key preserves target annotation',JSON.stringify(await pdfBridge.loadAnnos(sum.items.find(it=>it.key==='dup').attachment.path)).includes('Target annotation'));
    const image=await pdfBridge.noteImage(item.notes[0].image); push('note image readable after migration',image.ok);
    const annos=await pdfBridge.loadAnnos(item.attachment.path); push('managed attachment annotation retained',JSON.stringify(annos).includes('Retained annotation'));
    return {checks}; })()`, a);
  const moved = JSON.parse(fs.readFileSync(path.join(b, 'library.json'), 'utf8')).items.find(it => it.key === 'a');
  assert.equal(fs.readFileSync(path.join(b, 'snapshots/note.png'), 'utf8'), 'Target picture stays intact');
  assert(moved.attachment.path.startsWith(b) && fs.existsSync(moved.attachment.path));
  assert(moved.snapshot.path.startsWith(b) && fs.existsSync(moved.snapshot.path));
  assert(fs.existsSync(path.join(b, 'styles/custom.csl')));
  assert(moved.notes[0].text.includes(moved.notes[0].image));
  const payload = JSON.parse(fs.readFileSync(backup, 'utf8'));
  assert(Object.keys(payload.resources).includes('snapshots/web.mhtml'));
  assert(Object.keys(payload.resources).includes('styles/custom.csl'));
  assert(Object.keys(payload.resources).includes('attachments/paper.pdf'));
  fs.mkdirSync(c);
  probe('restore-resources', `(async()=>{
    const checks=[];const push=(n,v)=>checks.push([n,!!v]);
    const r=await pdfBridge.lib.restore(${JSON.stringify(backup)});push('restore succeeds',r.ok);
    const item=(await pdfBridge.lib.summary()).items[0];
    push('restored image readable',(await pdfBridge.noteImage(item.notes[0].image)).ok);
    push('restored annotations readable',JSON.stringify(await pdfBridge.loadAnnos(item.attachment.path)).includes('Retained annotation'));
    return {checks}; })()`, c);
  const restored = JSON.parse(fs.readFileSync(path.join(c, 'library.json'), 'utf8')).items[0];
  assert(restored.attachment.path.startsWith(c) && fs.existsSync(restored.attachment.path));
  assert(restored.snapshot.path.startsWith(c) && fs.existsSync(restored.snapshot.path));
  assert(fs.existsSync(path.join(c, 'styles/custom.csl')));
  console.log('[resource-roundtrip] PASS');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
