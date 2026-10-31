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
    // v1.6：带宽度标记的图片。`#w=420` 是渲染层的标记，不是文件名的一部分——
    // 导出时必须先剥掉再找文件，否则图片会被算成缺失（R-v1.6-02）
    { key: 'n3', itemType: 'note', title: '带宽度笔记', notes: [{ id: 'nc', title: '', text: '宽图：\n\n![](snapshots/pic-one.png#w=420)\n\n结尾' }] },
    // R-v1.6b-01：带标题的图片（`![图](a.png "说明")`）也要能被复制
    { key: 'n4', itemType: 'note', title: '带标题图片', notes: [{ id: 'nd', title: '', text: '标题图：\n\n![图](snapshots/pic-one.png "说明")\n\n结尾' }] },
    // R-v1.6b-02：纯截图笔记的 imageW 要带进导出文件
    { key: 'n5', itemType: 'note', title: '纯截图笔记', notes: [{ id: 'ne', title: '', text: '', image: 'snapshots/pic-one.png', imageW: 420 }] },
  ] }));
  const fwd = dir.replace(/\\/g, '/');

  const code = `(async()=>{
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    const checks=[];const push=(n,v,d)=>checks.push([n,!!v,d===undefined?'':String(d)]);
    const waitFor=async(fn,ms)=>{const t0=Date.now();while(Date.now()-t0<(ms||8000)){if(fn())return true;await sleep(60);}return !!fn();};
    const libReady=await waitFor(()=>window.LibraryUI&&LibraryUI.isOpen()&&document.querySelectorAll('#lib-grid .lib-card').length===5,10000);
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
    // 8) 带 #w= 宽度标记的图片也要被复制（不能把标记当文件名）
    const r4=await pdfBridge.exportNoteBundle({key:'n3',noteId:'nc',fmt:'html',title:'宽图测试',outPath:'${fwd}/wide.html'});
    push('带宽度标记的图片能导出',r4&&r4.ok===true&&r4.images===1&&r4.skipped===0,JSON.stringify(r4));
    const r5=await pdfBridge.exportNoteBundle({key:'n3',noteId:'nc',fmt:'md',title:'宽图测试',outPath:'${fwd}/wide.md'});
    push('MD 也复制了那张图',r5&&r5.ok===true&&r5.images===1&&r5.skipped===0,JSON.stringify(r5));
    // 9) 带标题的图片：要复制、不能算缺失
    const r6=await pdfBridge.exportNoteBundle({key:'n4',noteId:'nd',fmt:'html',title:'标题图测试',outPath:'${fwd}/titled.html'});
    push('带标题的图片能导出',r6&&r6.ok===true&&r6.images===1&&r6.skipped===0,JSON.stringify(r6));
    // 10) 纯截图笔记：imageW 要带进导出
    const r7=await pdfBridge.exportNoteBundle({key:'n5',noteId:'ne',fmt:'html',title:'截图宽度',outPath:'${fwd}/shot.html'});
    push('纯截图笔记能导出',r7&&r7.ok===true&&r7.images===1,JSON.stringify(r7));
    const r8=await pdfBridge.exportNoteBundle({key:'n5',noteId:'ne',fmt:'md',title:'截图宽度',outPath:'${fwd}/shot.md'});
    push('纯截图笔记 MD 也能导出',r8&&r8.ok===true&&r8.images===1,JSON.stringify(r8));
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
  // 带 #w= 的图片：复制到 .files，引用里的宽度标记保留（HTML 侧会变成 width 属性）
  const wide = fs.readFileSync(path.join(dir, 'wide.html'), 'utf8');
  assert.ok(wide.includes('src="wide.files/pic-one.png"'), '宽图改写成相对路径：' + wide.match(/src="[^"]*"/g));
  assert.ok(/width="420"/.test(wide), '宽度进了 width 属性');
  assert.ok(fs.existsSync(path.join(dir, 'wide.files', 'pic-one.png')), '宽图真的复制了');
  const wideMd = fs.readFileSync(path.join(dir, 'wide.md'), 'utf8');
  assert.ok(wideMd.includes('![](wide.files/pic-one.png#w=420)'), 'MD 保留宽度标记：' + wideMd.slice(0, 80));

  // 带标题的图片：引用被改写，标题原样保留（不能把 "说明" 吞掉）
  const titled = fs.readFileSync(path.join(dir, 'titled.html'), 'utf8');
  assert.ok(titled.includes('src="titled.files/pic-one.png"'), '带标题的图被改写：' + titled.match(/src="[^"]*"/g));
  assert.ok(fs.existsSync(path.join(dir, 'titled.files', 'pic-one.png')), '带标题的图真的复制了');

  // 纯截图笔记：imageW 要进 HTML 的宽度属性与 Markdown 的 #w= 标记
  const shotHtml = fs.readFileSync(path.join(dir, 'shot.html'), 'utf8');
  assert.ok(shotHtml.includes('src="shot.files/pic-one.png"'), '截图改写成相对路径：' + shotHtml.match(/src="[^"]*"/g));
  assert.ok(/width="420"/.test(shotHtml), '截图宽度进了 width 属性');
  const shotMd = fs.readFileSync(path.join(dir, 'shot.md'), 'utf8');
  assert.ok(shotMd.includes('](shot.files/pic-one.png#w=420)'), '截图的 #w= 标记写进了 MD：' + shotMd.slice(0, 80));
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
