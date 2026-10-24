'use strict';
/*
 * v33 笔记模板与自包含导出回归：
 *   模板：空笔记套用「论文卡片」直接铺开；已有内容时「课程笔记」接在末尾不打断正文；
 *         保存后库里的正文真的带上了模板；摘录汇总同链路。
 *   导出：HTML 自带图片（引用改写成 <文件名>.files/、缺失图片可见标注、字节一致）；
 *         Markdown 带相对图片目录；缺失图片计数返回。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runProbe } = require('./probe-runner');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-note-tpl-'));
try {
  fs.mkdirSync(path.join(dir, 'ud'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'snapshots'));
  const png = path.join(dir, 'snapshots', 'pic-one.png');
  fs.copyFileSync(path.join(__dirname, '../assets/icon-256.png'), png);
  fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify({ version: 8, items: [
    { key: 'n1', itemType: 'note', title: '带图笔记', notes: [{ id: 'na', title: '', text: '正文开头\n\n![](snapshots/pic-one.png)\n\n![](snapshots/pic-missing.png)\n\n结尾' }] },
    { key: 'n2', itemType: 'note', title: '空笔记', notes: [{ id: 'nb', title: '', text: '' }] },
  ] }));
  const fwd = dir.replace(/\\/g, '/');

  const code = `(async()=>{
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    const checks=[];const push=(n,v,d)=>checks.push([n,!!v,d===undefined?'':String(d)]);
    const waitFor=async(fn,ms)=>{const t0=Date.now();while(Date.now()-t0<(ms||8000)){if(fn())return true;await sleep(60);}return !!fn();};
    const libReady=await waitFor(()=>window.LibraryUI&&LibraryUI.isOpen()&&document.querySelectorAll('#lib-grid .lib-card').length===2,10000);
    push('文献库就绪',libReady);
    if(!libReady)return {checks};
    const sel=(id,v)=>{const s=document.getElementById(id);s.value=v;s.dispatchEvent(new Event('change',{bubbles:true}));};
    // 1) 空笔记套「论文卡片」：直接铺开
    document.querySelector('[data-open-note="n2"]').click();
    await waitFor(()=>document.getElementById('note-view').hidden===false,5000);
    sel('nv-template','paper');
    const ta=document.getElementById('nv-md');
    push('论文卡片铺开',ta.value.startsWith('## 论文卡片')&&ta.value.includes('研究问题'),ta.value.slice(0,30));
    await sleep(600);   // 预览去抖 350ms
    const pv=document.getElementById('nv-preview');
    push('模板实时预览',pv.innerHTML.includes('论文卡片')&&pv.innerHTML.includes('quote'),pv.innerHTML.slice(0,60));
    // 2) 保存后库里正文带上模板
    document.getElementById('nv-save').click();
    await sleep(600);
    const s1=await pdfBridge.lib.summary();
    const it2=s1.items.find(x=>x.key==='n2');
    push('保存进库',(it2.notes[0].text||'').includes('论文卡片'),(it2.notes[0].text||'').slice(0,30));
    // 3) 已有内容套「课程笔记」：接在末尾，原正文保留
    document.querySelector('[data-open-note="n1"]').click();
    await sleep(400);
    sel('nv-template','course');
    const ta1=document.getElementById('nv-md');
    push('课程笔记接在末尾',ta1.value.includes('正文开头')&&ta1.value.includes('课程笔记：课程主题')&&ta1.value.includes('推导过程'),ta1.value.slice(0,40));
    // 4) 摘录汇总同链路（n2 已有内容 → 追加）
    document.querySelector('[data-open-note="n2"]').click();
    await sleep(400);
    sel('nv-template','excerpt');
    push('摘录汇总可追加',document.getElementById('nv-md').value.includes('摘录汇总：主题')&&document.getElementById('nv-md').value.includes('论文卡片'),document.getElementById('nv-md').value.slice(0,40));
    // 5) 导出 HTML（outPath 旁路对话框）
    const r1=await pdfBridge.exportNoteBundle({key:'n1',noteId:'na',fmt:'html',title:'导出测试',outPath:'${fwd}/bundle-test.html'});
    push('HTML 导出成功',r1&&r1.ok===true&&r1.images===1&&r1.skipped===1,JSON.stringify(r1));
    // 6) 导出 Markdown
    const r2=await pdfBridge.exportNoteBundle({key:'n1',noteId:'na',fmt:'md',title:'导出测试',outPath:'${fwd}/bundle-md.md'});
    push('MD 导出成功',r2&&r2.ok===true&&r2.images===1&&r2.skipped===1,JSON.stringify(r2));
    // 7) 空内容 / 找不到条目
    const r3=await pdfBridge.exportNoteBundle({key:'zzz',fmt:'html',outPath:'${fwd}/none.html'});
    push('条目不存在报错',r3&&r3.ok===false&&!!r3.error,JSON.stringify(r3));
    return {checks};})()`;
  fs.writeFileSync(path.join(dir, 'probe.cjs'), 'module.exports=' + JSON.stringify(code));
  const r = runProbe({
    probe: path.join(dir, 'probe.cjs'),
    env: { PDFREADER_LIBRARY: path.join(dir, 'library.json'), PDFREADER_DATA_DIR: dir, PDFREADER_NO_AUTO_INDEX: '1' },
    args: ['--user-data-dir=' + path.join(dir, 'ud')],
    label: 'note-templates-export',
  });
  assert.equal(r.fail, 0);

  // ---- Node 侧核对导出产物 ----
  const html = fs.readFileSync(path.join(dir, 'bundle-test.html'), 'utf8');
  assert.ok(/^<!doctype html>/i.test(html), 'HTML 有独立外壳');
  assert.ok(html.includes('<title>导出测试</title>'), '标题进了外壳');
  assert.ok(html.includes('src="bundle-test.files/pic-one.png"'), '图片改写为相对路径：' + html.match(/src="[^"]*"/g));
  assert.ok(html.includes('[图片缺失：snapshots/pic-missing.png]'), '缺失图片可见标注');
  const copied = path.join(dir, 'bundle-test.files', 'pic-one.png');
  assert.ok(fs.existsSync(copied), '图片包已复制');
  assert.deepEqual(fs.readFileSync(copied), fs.readFileSync(png), '图片字节一致');
  const md = fs.readFileSync(path.join(dir, 'bundle-md.md'), 'utf8');
  assert.ok(md.includes('![](bundle-md.files/pic-one.png)'), 'MD 引用改写为相对目录');
  assert.ok(md.includes('snapshots/pic-missing.png'), '缺失图片保留原引用');
  assert.ok(fs.existsSync(path.join(dir, 'bundle-md.files', 'pic-one.png')), 'MD 图片目录已复制');
  assert.ok(!fs.existsSync(path.join(dir, 'none.html')), '失败时不落文件');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
