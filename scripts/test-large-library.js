'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Cite = require('../src/cite');
const { runProbe, ROOT } = require('./probe-runner');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-large-library-'));
try {
  // Identical citation bases exercise the previous quadratic collision loop.
  const identical = Array.from({ length: 10000 }, (_, i) => ({ key: 'k' + String(i).padStart(5, '0'), creators: ['John Smith'], year: '2026', title: 'Same title' }));
  const start = performance.now(), keys = Cite.citekeys(identical);
  assert.equal(new Set(keys.values()).size, 10000);
  assert.equal(keys.get('k09999'), Cite.citekey(identical[0]) + '-10000');
  assert.deepEqual([...Cite.citekeys(identical.slice().reverse())], [...keys]);
  console.log('[citekey-collisions] 10000 items in ' + Math.round(performance.now() - start) + ' ms');
  const sample = path.join(ROOT, 'assets/sample.pdf');
  const items = Array.from({ length: 1000 }, (_, i) => ({ key: 'row' + i, title: 'Document ' + i, tags: [i % 2 ? 'odd' : 'even'], created: i,
    attachment: i === 0 ? { path: sample } : (i % 3 === 0 ? { path: path.join(dir, 'missing-' + i + '.pdf') } : null) }));
  fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify({ version: 8, items }));
  const code = `(async()=>{
    const checks=[];const push=(n,v,d)=>checks.push([n,!!v,d||'']);const $=s=>document.querySelector(s);const $$=s=>Array.from(document.querySelectorAll(s));
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));const wait=async f=>{for(let i=0;i<100;i++){if(f())return true;await sleep(40);}return false;};
    await wait(()=>$('.lib-card[data-key="row999"]'));await sleep(100);
    push('all items counted',$('#lib-count').textContent.includes('1000'));
    push('bounded live DOM',$$('#lib-grid .lib-card').length<400,$$('#lib-grid .lib-card').length);
    $('.lib-card[data-key="row999"]').click();document.activeElement.blur();
    for(let i=0;i<85;i++)document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
    push('keyboard selection crosses chunk boundary',!!$('.lib-card.selected[data-key="row914"]'));
    const cb=$('.lib-card.selected [data-select-key]');cb.checked=true;cb.dispatchEvent(new Event('change',{bubbles:true}));await sleep(100);
    const grid=$('#lib-grid');grid.scrollTop=grid.scrollHeight;await wait(()=>$('.lib-card[data-key="row0"]'));await sleep(100);
    push('last item appears after scrolling',!!$('.lib-card[data-key="row0"]'));
    push('offscreen rows released',$$('#lib-grid .lib-card').length<400,$$('#lib-grid .lib-card').length);
    grid.scrollTop=0;await wait(()=>$('.lib-card[data-key="row999"]'));
    document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
    push('checkbox selection survives unmounting',$('.lib-card[data-key="row914"] [data-select-key]').checked);
    for(let i=0;i<86;i++)document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}));
    grid.scrollTop=grid.scrollHeight;await wait(()=>$('.lib-card[data-key="row0"]'));
    const count=$('#lib-grid .lib-card').length;
    $('.lib-card[data-key="row0"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
    push('double click still opens PDF',await wait(()=>App.state.filePath===${JSON.stringify(sample)}&&App.state.pdfDoc));
    return {checks,rows:count};
  })()`;
  fs.writeFileSync(path.join(dir, 'probe.cjs'), 'module.exports=' + JSON.stringify(code));
  const r = runProbe({ probe: path.join(dir, 'probe.cjs'), env: { PDFREADER_LIBRARY: path.join(dir, 'library.json'), PDFREADER_DATA_DIR: dir, PDFREADER_NO_AUTO_INDEX: '1' }, args: ['--user-data-dir=' + path.join(dir, 'ud')], label: 'large-library' });
  assert.equal(r.fail, 0);
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
