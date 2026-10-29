'use strict';
// Fault injection is confined to this disposable Electron process and its temp data.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { ELECTRON, ROOT } = require('./probe-runner');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-reliability-ui-'));
const data = path.join(dir, 'data'), ud = path.join(dir, 'ud');
fs.mkdirSync(data); fs.mkdirSync(ud);
const oldPath = path.join(dir, 'old.pdf'), newPath = path.join(dir, 'relocated.pdf');
fs.copyFileSync(path.join(ROOT, 'assets/sample.pdf'), newPath);
fs.writeFileSync(path.join(data, 'library.json'), JSON.stringify({ version: 8, items: [
  { key: 'meta', title: 'Metadata only' },
  { key: 'note', title: 'Note', itemType: 'note', notes: [{ id: 'n1', text: 'Original note' }] },
  { key: 'single', title: 'Single download' }, { key: 'batch', title: 'Batch download' },
  { key: 'relink', title: 'Relink', attachment: { path: oldPath } },
] }));
const probe = `(async()=>{
  const checks=[];const push=(n,v,d)=>checks.push([n,!!v,d||'']);const $=s=>document.querySelector(s);
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const wait=async f=>{for(let i=0;i<100;i++){if(await f())return true;await sleep(40);}return false;};
  await wait(()=>$('.lib-card[data-key="meta"]'));
  $('.lib-card[data-key="meta"]').click(); $('#ld-doi').value='10.1234/unsaved';$('#ld-fetch-pdf').click();
  await wait(()=>$('#ld-fetch-status').textContent.includes('TEST_UNSAVED_DOI'));
  push('unsaved DOI reaches fetcher',$('#ld-fetch-status').textContent.includes('TEST_UNSAVED_DOI'),$('#ld-fetch-status').textContent);
  push('fetch error reenables button',!$('#ld-fetch-pdf').disabled);
  $('#ld-title').value='__FAIL_SAVE__';$('#ld-save').click();await wait(()=>$('#ld-status').textContent.includes('失败'));
  push('detail save failure visible',$('#ld-status').textContent.includes('失败'));
  push('detail input retained',$('#ld-title').value==='__FAIL_SAVE__');
  push('failed detail save rolled back',(await pdfBridge.lib.summary()).items.find(i=>i.key==='meta').title==='Metadata only');
  $('.lib-card[data-key="note"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));await wait(()=>!$('#note-view').hidden);
  $('#nv-md').value='__FAIL_SAVE__';$('#nv-save').click();await wait(()=>$('#nv-status').textContent.includes('失败'));
  push('note save failure visible',$('#nv-status').textContent.includes('失败'));
  push('no false saved toast',!($('#toast')&&$('#toast').textContent==='笔记已保存'));
  $('#nv-back').click();await sleep(200);push('failed note stays editable',!$('#note-view').hidden&&$('#nv-md').value==='__FAIL_SAVE__');
  $('#nv-md').value='Recovered note';$('#nv-back').click();await wait(()=>$('#note-view').hidden);
  push('note save retry succeeds',(await pdfBridge.lib.summary()).items.find(i=>i.key==='note').notes[0].text==='Recovered note');
  await pdfBridge.saveAnnos(${JSON.stringify(oldPath)},[{page:1,shapes:[{id:'old',tool:'text',text:'Old annotation'}]}]);
  await pdfBridge.saveAnnos(${JSON.stringify(newPath)},[{page:1,shapes:[{id:'new',tool:'text',text:'Existing annotation'}]}]);
  const relink=await pdfBridge.lib.relinkItem('relink');push('relink succeeds',relink.ok);
  const merged=JSON.stringify(await pdfBridge.loadAnnos(${JSON.stringify(newPath)}));
  push('relink keeps both annotation sets',merged.includes('Old annotation')&&merged.includes('Existing annotation'));
  push('old annotation retained',JSON.stringify(await pdfBridge.loadAnnos(${JSON.stringify(oldPath)})).includes('Old annotation'));
  const base='__BASE__';
  const single=await pdfBridge.lib.fetchPdf('single',base+'/sample.pdf','');push('single download succeeds',single.ok);
  await pdfBridge.lib.updateItem('batch',{url:base+'/sample.pdf'});
  const batch=await pdfBridge.lib.fetchPdfBatch(['batch']);push('batch download succeeds',batch.fetched===1);
  const indexed=await wait(async()=>{const r=await pdfBridge.lib.searchFull('sample');return ['single','batch'].every(k=>r.results.some(x=>x.key===k));});
  push('downloads automatically searchable',indexed);
  const payload=await pdfBridge.lib.openItem('single');App.openDocument(payload);await wait(()=>App.state.pdfDoc&&App.state.rendered.get(1));
  App.state.annos.set(1,[{id:'failed',tool:'text',at:{x:100,y:100},text:'__FAIL_SAVE__',size:14,color:'#000000'}]);
  const saved=await App.flushAnnos();push('annotation save reports failure',saved===false);
  push('annotation save error visible',$('#toast').textContent.includes('尚未保存'));
  const active=App.activeTabId;await App.closeTab(active);push('failed annotation save prevents closing tab',App.activeTabId===active&&App.tabs.some(t=>t.id===active));
  App.state.annos.set(1,[{id:'cjk',tool:'text',at:{x:100,y:100},text:'中文标注',size:14,color:'#000000'}]);
  // v36：中文标注不再一律跳过——有系统 CJK 字体就子集嵌入，没有才退回 Helvetica 并计数。
  // 这两条路都要如实报出来，不能静默丢标注。
  const cjkOut=${JSON.stringify(path.join(dir, 'cjk-copy.pdf'))};
  const cjkRes=await pdfBridge.exportPdf(App.buildExportPayload(cjkOut));
  push('中文标注导出成功',!!(cjkRes&&cjkRes.ok),JSON.stringify(cjkRes).slice(0,160));
  push('中文标注要么子集嵌入、要么明确跳过',!!cjkRes&&(cjkRes.cjk?cjkRes.skipped===0:cjkRes.skipped>=1),
    JSON.stringify({cjk:cjkRes&&cjkRes.cjk,font:cjkRes&&cjkRes.cjkFont,skipped:cjkRes&&cjkRes.skipped}));
  $('#btn-save').click();
  const saidDone=await wait(()=>/已保存副本|未导出|已取消导出/.test($('#toast').textContent));
  push('导出提示与导出结果一致（中文没有被静默吞掉）',
    saidDone&&(cjkRes&&cjkRes.cjk?!/未导出/.test($('#toast').textContent):/未导出/.test($('#toast').textContent)),
    $('#toast').textContent);
  const before=(await pdfBridge.lib.summary()).items.map(i=>i.title).join('|');
  const failedMove=await pdfBridge.lib.chooseDataDir(${JSON.stringify(path.join(dir, 'fail-move'))},'move');
  push('migration commit failure reported',!failedMove.ok);
  push('failed migration keeps active library',(await pdfBridge.lib.summary()).items.map(i=>i.title).join('|')===before);
  const failedRestore=await pdfBridge.lib.restore(${JSON.stringify(path.join(dir, 'failed-restore.json'))});
  push('restore commit failure reported',!failedRestore.ok);
  push('failed restore rolls back library',(await pdfBridge.lib.summary()).items.map(i=>i.title).join('|')===before);
  push('failed restore keeps annotations',JSON.stringify(await pdfBridge.loadAnnos(${JSON.stringify(newPath)})).includes('Old annotation'));
  return {checks};
})()`;
const driver = `
const fs=require('fs'),path=require('path'),http=require('http');const {app,dialog}=require('electron');
app.setPath('userData',${JSON.stringify(ud)});
process.env.PDFREADER_LIBRARY=${JSON.stringify(path.join(data, 'library.json'))};process.env.PDFREADER_DATA_DIR=${JSON.stringify(data)};process.env.PDFREADER_NO_AUTO_INDEX='1';
const fetcher=require(${JSON.stringify(path.join(ROOT, 'src/fetchpdf.js'))});const fetch=fetcher.fetchToFile;
fetcher.fetchToFile=(src,...args)=>src.doi==='10.1234/unsaved'?Promise.resolve({ok:false,error:'TEST_UNSAVED_DOI'}):fetch(src,...args);
const write=fs.writeFileSync;
fs.writeFileSync=function(file,content,...args){if(String(file).startsWith(${JSON.stringify(data)})||String(file).startsWith(${JSON.stringify(ud)})){if(String(content).includes('__FAIL_SAVE__'))throw new Error('injected write failure');}return write.call(this,file,content,...args);};
dialog.showOpenDialog=async()=>({canceled:false,filePaths:[${JSON.stringify(newPath)}]});
dialog.showSaveDialog=async()=>({canceled:false,filePath:${JSON.stringify(path.join(dir, 'partial.pdf'))}});
const rename=fs.renameSync;
fs.renameSync=function(from,to){const text=fs.readFileSync(from,'utf8');if((String(to).endsWith('settings.json')&&text.includes('fail-move'))||text.includes('FAIL_RESTORE_TX'))throw new Error('injected commit failure');return rename(from,to);};
write(${JSON.stringify(path.join(dir, 'failed-restore.json'))},JSON.stringify({app:'trove',format:1,library:{version:8,items:[{key:'changed',title:'Should roll back'}]},annotations:[{name:'aaaaaaaaaaaaaaaaaaaa.json',data:{path:${JSON.stringify(newPath)},pages:[{page:1,shapes:[{id:'bad',tool:'text',text:'FAIL_RESTORE_TX'}]}]}}]}));
const server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'application/pdf'});res.end(fs.readFileSync(${JSON.stringify(path.join(ROOT, 'assets/sample.pdf'))}));});
server.listen(0,'127.0.0.1',()=>{
 const probe=${JSON.stringify(probe)}.replace('__BASE__','http://127.0.0.1:'+server.address().port);
 const file=${JSON.stringify(path.join(dir, 'probe.cjs'))};write(file,'module.exports='+JSON.stringify(probe));process.env.PDFREADER_PROBE=file;
 require(${JSON.stringify(path.join(ROOT, 'src/main.js'))});
});`;
try {
  const file = path.join(dir, 'driver.cjs'); fs.writeFileSync(file, driver);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  let output;
  try { output = execFileSync(ELECTRON, [file, '--no-sandbox', '--disable-gpu'], { cwd: ROOT, env, encoding: 'utf8', timeout: 90000, windowsHide: true }); }
  catch (err) { throw new Error(String(err.stdout) + '\n' + String(err.stderr)); }
  const line = output.split(/\r?\n/).find(l => l.includes('[probe-result]'));
  assert(line, output); const r = JSON.parse(line.slice(line.indexOf('{')));
  assert(!r.fatal, r.fatal);
  for (const [name, pass, detail] of r.checks) console.log((pass ? '  ok   ' : '  FAIL ') + name + (pass ? '' : ' ' + detail));
  assert(r.checks.every(c => c[1]));
  console.log('[reliability-ui] PASS (' + r.checks.length + ')');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
