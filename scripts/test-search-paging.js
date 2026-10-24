'use strict';
/*
 * v33 搜索分页与结果类型计数回归：
 *  - 主进程：默认 120 条 + total/counts；offset/limit 翻页不丢不重；字段限定分支同样可翻页。
 *  - 界面：类型切换片（全部/正文/批注/笔记）、「展开更多」先放行已载入、再按 offset 续拉。
 * 夹具：150 页正文命中 + 1 条批注 + 1 条笔记（饱和），另造 130 条 title:zq 元数据条目。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { runProbe } = require('./probe-runner');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-search-paging-'));
try {
  const source = path.join(dir, 'fixture.pdf');
  fs.copyFileSync(path.join(__dirname, '../assets/sample.pdf'), source);
  fs.mkdirSync(path.join(dir, 'ud/annotations'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'fulltext'));
  const items = [
    { key: 'a', title: 'Body document', attachment: { path: source }, notes: [{ id: 'n1', text: 'needle note' }] },
    { key: 'z-missing', title: 'Missing file', attachment: { path: path.join(dir, 'missing.pdf') } },
  ];
  // 字段限定分支的分页夹具：130 条只有元数据的条目
  for (let i = 0; i < 130; i++) items.push({ key: 'zq' + i, title: 'Zq paper ' + i, itemType: 'journalArticle' });
  fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify({ version: 8, items }));

  const hash = crypto.createHash('sha1').update(source).digest('hex');
  fs.writeFileSync(path.join(dir, 'fulltext', hash.slice(0, 24) + '.json'), JSON.stringify({ version: 1, path: source,
    pages: Array.from({ length: 150 }, (_, i) => ({ page: i + 1, text: 'needle '.repeat(20) + 'body' })), chars: 20000 }));
  fs.writeFileSync(path.join(dir, 'ud/annotations', hash.slice(0, 20) + '.json'), JSON.stringify({ path: source,
    pages: [{ page: 1, shapes: [{ id: 'a1', tool: 'text', text: 'needle annotation' }] }] }));

  const code = `(async()=>{
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    const checks=[];const push=(n,v,d)=>checks.push([n,!!v,d===undefined?'':String(d)]);
    const waitFor=async(fn,ms)=>{const t0=Date.now();while(Date.now()-t0<(ms||10000)){if(fn())return true;await sleep(60);}return !!fn();};
    // ---------- 主进程：分页语义 ----------
    const r1=await pdfBridge.lib.searchFull('needle');
    push('默认页仍是 120 条',r1.results.length===120,String(r1.results.length));
    push('total 覆盖全部命中',r1.total===152,String(r1.total));
    push('counts 按类型计数',(r1.counts.fulltext===150&&r1.counts.annotation===1&&r1.counts.note===1),JSON.stringify(r1.counts));
    for(const t of ['fulltext','note','annotation'])push('第一页保留 '+t,r1.results.some(x=>x.type===t));
    push('第一页相关性单调',r1.results.every((x,i)=>!i||r1.results[i-1].score>=x.score));
    const r2=await pdfBridge.lib.searchFull('needle',{offset:120});
    push('第二页返回余量',r2.results.length===32,String(r2.results.length));
    const idOf=(r)=>r.type+':'+r.page+':'+(r.noteId||String(r.snippet||'').slice(0,16));
    const ids=new Set([...r1.results,...r2.results].map(idOf));
    push('两页合并不丢不重',ids.size===152,String(ids.size));
    const r3=await pdfBridge.lib.searchFull('needle',{offset:9999});
    push('offset 超界返回空',r3.results.length===0,String(r3.results.length));
    const r4=await pdfBridge.lib.searchFull('needle',{limit:10});
    push('limit 收窄本页',r4.results.length===10&&r4.total===152,r4.results.length+'/'+r4.total);
    // ---------- 主进程：字段限定分支（title:）的分页 ----------
    const f1=await pdfBridge.lib.searchFull('title:zq');
    push('字段限定默认 120 条',f1.results.length===120,String(f1.results.length));
    push('字段限定 total=130',f1.total===130&&f1.counts.item===130,f1.total+'/'+(f1.counts.item||0));
    const f2=await pdfBridge.lib.searchFull('title:zq',{offset:120});
    push('字段限定第二页 10 条',f2.results.length===10,String(f2.results.length));
    // ---------- 界面：类型切换 + 展开更多 ----------
    const libReady=await waitFor(()=>window.LibraryUI&&LibraryUI.isOpen(),10000);
    push('文献库已展开',libReady);
    if(!libReady)return {checks};
    const box=document.getElementById('lib-search');
    box.value='needle';
    box.dispatchEvent(new Event('input',{bubbles:true}));
    const shown=await waitFor(()=>document.querySelectorAll('#lib-ft .lib-ft-row').length>0,10000);
    push('搜索结果面板出现',shown);
    if(!shown)return {checks};
    const rows=()=>document.querySelectorAll('#lib-ft .lib-ft-row');
    const chips=()=>document.querySelectorAll('#lib-ft .lib-ft-chip');
    push('首屏只显示 20 条',rows().length===20,String(rows().length));
    push('类型切换片=全部/正文/批注/笔记',chips().length===4,Array.from(chips()).map(c=>c.textContent).join('|'));
    const more=document.querySelector('#lib-ft [data-ft-more]');
    push('展开更多可见且标注总数',!!more&&more.textContent.includes('152'),more&&more.textContent);
    document.querySelector('#lib-ft [data-ft-type="fulltext"]').click();
    push('切到正文后行都是全文',rows().length===20&&Array.from(rows()).every(x=>x.querySelector('.lib-ft-type.fulltext')),String(rows().length));
    // 面板 innerHTML 每次重渲染都会重建，必须重新查询按钮，不能复用旧引用
    document.querySelector('#lib-ft [data-ft-more]').click();
    await sleep(120);
    push('展开更多放行到 40 条',rows().length===40,String(rows().length));
    document.querySelector('#lib-ft [data-ft-type="annotation"]').click();
    await sleep(60);
    push('切到批注只剩 1 条',rows().length===1&&!!rows()[0].querySelector('.lib-ft-type.annotation'),String(rows().length));
    document.querySelector('#lib-ft [data-ft-type="all"]').click();
    await sleep(60);
    push('切回全部恢复列表',rows().length===40,String(rows().length));
    box.value='';box.dispatchEvent(new Event('input',{bubbles:true}));
    await sleep(500);
    push('清空搜索收起面板',document.getElementById('lib-ft').hidden===true);
    return {checks};})()`;
  fs.writeFileSync(path.join(dir, 'probe.cjs'), 'module.exports=' + JSON.stringify(code));
  const r = runProbe({
    probe: path.join(dir, 'probe.cjs'),
    env: { PDFREADER_LIBRARY: path.join(dir, 'library.json'), PDFREADER_DATA_DIR: dir, PDFREADER_NO_AUTO_INDEX: '1' },
    args: ['--user-data-dir=' + path.join(dir, 'ud')],
    label: 'search-paging',
  });
  assert.equal(r.fail, 0);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
