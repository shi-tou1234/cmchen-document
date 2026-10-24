'use strict';
/*
 * R01 回归（2026-10-24 复核）：扫描 A 的原生批注期间切到 B，绝不能把 A 的批注
 * 写进 B 的内存标注或 B 的 sidecar——导入必须在归属失效时取消。
 *
 * 门控方式：包装 A 的 pdfDoc 实例的 getPage，让页面对象的 getAnnotations 在拿到
 * 真实结果后停在 gate 上（数据已捕获，release 后扫描仍能拿到 A 的形状，
 * 与"切文档后扫描才返回"的复现时序一致）。切文档走真实打开链路。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PDFDocument, PDFName, PDFHexString } = require('pdf-lib');
const { runProbe } = require('./probe-runner');

async function makePdf(file, withAnno) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  page.drawText('Hello page.', { x: 72, y: 700, size: 14 });
  if (withAnno) {
    const ctx = doc.context;
    const d = ctx.obj({});
    d.set(PDFName.of('Type'), PDFName.of('Annot'));
    d.set(PDFName.of('Subtype'), PDFName.of('Text'));
    d.set(PDFName.of('Rect'), ctx.obj([320, 688, 342, 710]));
    d.set(PDFName.of('Contents'), PDFHexString.fromText('ONLY A NATIVE NOTE'));
    d.set(PDFName.of('NM'), PDFHexString.fromText('a-note-1'));
    d.set(PDFName.of('F'), ctx.obj(4));
    d.set(PDFName.of('P'), page.ref);
    page.node.set(PDFName.of('Annots'), ctx.obj([ctx.register(d)]));
  }
  fs.writeFileSync(file, await doc.save());
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-r01-race-'));
  try {
    const pdfA = path.join(dir, 'alpha-native.pdf');
    const pdfB = path.join(dir, 'beta-clean.pdf');
    const ud = path.join(dir, 'ud');
    fs.mkdirSync(ud, { recursive: true });
    await makePdf(pdfA, true);
    await makePdf(pdfB, false);
    fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify({ version: 8, items: [
      { key: 'a', title: 'Alpha native', attachment: { path: pdfA } },
      { key: 'b', title: 'Beta clean', attachment: { path: pdfB } },
    ] }));
    const fwdA = pdfA.replace(/\\/g, '/');
    const code = `(async()=>{
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    const checks=[];const push=(n,v,d)=>checks.push([n,!!v,d===undefined?'':String(d)]);
    const waitFor=async(fn,ms)=>{const t0=Date.now();while(Date.now()-t0<(ms||8000)){if(fn())return true;await sleep(60);}return !!fn();};
    const norm=(p)=>String(p||'').replace(/\\\\/g,'/');
    // 打开 A（真实链路）
    const pa=await pdfBridge.lib.openItem('a',1);
    push('A 打开',pa&&pa.ok,(pa&&pa.error)||'');
    await window.__libOpen(pa);
    await waitFor(()=>norm(App.state.filePath)==='${fwdA}',8000);
    await sleep(500);   // 等 hint / restoreAnnos 走完
    // 门控：getPage 返回的页面对象，getAnnotations 先取真实数据再停在 gate
    const doc=App.state.pdfDoc;
    const origGetPage=doc.getPage.bind(doc);
    let release;const gate=new Promise(r=>{release=r;});
    doc.getPage=async(n)=>{
      const page=await origGetPage(n);
      if(!page.__gatePatched){
        page.__gatePatched=true;
        const origGA=page.getAnnotations.bind(page);
        page.getAnnotations=async(o)=>{const res=await origGA(o);await gate;return res;};
      }
      return page;
    };
    // 发起导入（不等待），等它停在 gate 上
    const importPromise=window.NativeAnnos.import();
    await sleep(500);
    // 切到 B（真实链路），等 B 就位
    const pb=await pdfBridge.lib.openItem('b',1);
    await window.__libOpen(pb);
    const bReady=await waitFor(()=>norm(App.state.filePath).endsWith('beta-clean.pdf'),10000);
    push('已切到 B',bReady,norm(App.state.filePath));
    await sleep(400);
    const bBefore=JSON.stringify(Array.from(App.state.annos.entries()));
    // 放行 A 的扫描：修复后必须取消，不能把结果并进 B
    release();
    const res=await importPromise;
    push('导入在切文档后取消',res&&res.ok===false&&res.canceled===true,JSON.stringify(res));
    await sleep(700);
    const bAfter=JSON.stringify(Array.from(App.state.annos.entries()));
    push('B 内存标注未混入',bAfter===bBefore&&!bAfter.includes('ONLY A NATIVE NOTE'),bAfter.slice(0,80));
    const all=await pdfBridge.listAnnotations();
    push('落盘 sidecar 未混入',(all||[]).every(x=>!(x.text||'').includes('ONLY A NATIVE NOTE')),JSON.stringify((all||[]).map(x=>x.text)));
    push('落盘标注为空',(all||[]).length===0,String((all||[]).length));
    // 正常路径不受影响：回到 A 重新导入成功
    const pa2=await pdfBridge.lib.openItem('a',1);
    await window.__libOpen(pa2);
    await waitFor(()=>norm(App.state.filePath)==='${fwdA}',8000);
    await sleep(500);
    const res2=await window.NativeAnnos.import();
    push('回到 A 正常导入',res2&&res2.ok===true&&res2.added===1,JSON.stringify(res2));
    await sleep(900);   // 自动保存落盘
    const all2=await pdfBridge.listAnnotations();
    push('A 的便签正常落盘',(all2||[]).some(x=>(x.text||'').includes('ONLY A NATIVE NOTE')),JSON.stringify((all2||[]).map(x=>x.text)));
    return {checks};})()`;
    fs.writeFileSync(path.join(dir, 'probe.cjs'), 'module.exports=' + JSON.stringify(code));
    const r = runProbe({
      probe: path.join(dir, 'probe.cjs'),
      env: { PDFREADER_LIBRARY: path.join(dir, 'library.json'), PDFREADER_DATA_DIR: path.join(dir, 'data'), PDFREADER_NO_AUTO_INDEX: '1' },
      args: ['--user-data-dir=' + ud],
      label: 'r01-anno-race',
      timeout: 180000,
    });
    assert.equal(r.fail, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(3); });
