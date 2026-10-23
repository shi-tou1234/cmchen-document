'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { runProbe } = require('./probe-runner');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-search-boundary-'));
try {
  const source = path.join(dir, 'fixture.pdf'); fs.copyFileSync(path.join(__dirname, '../assets/sample.pdf'), source);
  fs.mkdirSync(path.join(dir, 'ud/annotations'), { recursive: true }); fs.mkdirSync(path.join(dir, 'fulltext'));
  fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify({ version: 8, items: [
    { key: 'a', title: 'Body document', attachment: { path: source }, notes: [{ id: 'n1', text: 'needle' }] },
    { key: 'n', title: 'Standalone', itemType: 'note', notes: [{ id: 'n2', text: 'uniquenote' }] },
    { key: 'm', title: 'Metadata only', itemType: 'journalArticle' },
    { key: 'missing', title: 'Missing file', attachment: { path: path.join(dir, 'missing.pdf') } },
  ] }));
  const hash = crypto.createHash('sha1').update(source).digest('hex');
  fs.writeFileSync(path.join(dir, 'fulltext', hash.slice(0, 24) + '.json'), JSON.stringify({ version: 1, path: source,
    pages: Array.from({ length: 121 }, (_, i) => ({ page: i + 1, text: 'needle '.repeat(20) + 'body' })), chars: 16000 }));
  fs.writeFileSync(path.join(dir, 'ud/annotations', hash.slice(0, 20) + '.json'), JSON.stringify({ path: source,
    pages: [{ page: 1, shapes: [{ id: 'a1', tool: 'text', text: 'needle annotation' }] }] }));
  const code = `(async()=>{const checks=[];const push=(n,v)=>checks.push([n,!!v]);
    const r=await pdfBridge.lib.searchFull('needle');
    push('bounded result count',r.results.length===120);
    for(const type of ['fulltext','note','annotation'])push('saturated search retains '+type,r.results.some(x=>x.type===type));
    push('merged relevance order',r.results.every((x,i)=>!i||r.results[i-1].score>=x.score));
    const note=await pdfBridge.lib.searchFull('title:Standalone uniquenote');
    push('field-limited standalone note found',note.results.some(x=>x.key==='n'&&x.type==='note'));
    push('metadata-only item is not missing',!document.querySelector('.lib-card[data-key="m"]').classList.contains('missing'));
    push('broken attachment remains marked missing',document.querySelector('.lib-card[data-key="missing"]').classList.contains('missing'));
    return {checks};})()`;
  // The document fixture exists, and the standalone note has no attachment.
  fs.writeFileSync(path.join(dir, 'probe.cjs'), 'module.exports=' + JSON.stringify(code));
  const r = runProbe({ probe: path.join(dir, 'probe.cjs'), env: { PDFREADER_LIBRARY: path.join(dir, 'library.json'), PDFREADER_DATA_DIR: dir, PDFREADER_NO_AUTO_INDEX: '1' }, args: ['--user-data-dir=' + path.join(dir, 'ud')], label: 'search-boundaries' });
  assert.equal(r.fail, 0);
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
