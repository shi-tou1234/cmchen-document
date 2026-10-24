'use strict';
/*
 * N01 回归（2026-10-24 二次核查）：子笔记保存失败后必须终止导出——
 * 不能拿着库里的旧内容导出还提示成功。
 *
 * 注入方式沿用 test-reliability-ui：driver 在主进程包装 fs.writeFileSync，
 * 内容含 __FAIL_SAVE__ 标记即抛错；dialog.showSaveDialog 按调用次序返回
 * 两个不同哨兵路径——第一次导出（保存失败）应被取消（哨兵 A 不存在），
 * 修复内容后第二次导出成功（哨兵 B 存在且含最新正文）。
 */
const assert = require('assert');
const execFileSync = require('child_process').execFileSync;
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-n01-export-'));
  try {
    const ud = path.join(dir, 'ud');
    const data = path.join(dir, 'data');
    fs.mkdirSync(ud, { recursive: true });
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(data, 'library.json'), JSON.stringify({ version: 8, items: [
      { key: 'd1', title: 'N01 doc', notes: [{ id: 'nsub', title: '子笔记', html: '<p>旧正文</p>', text: '旧正文' }] },
    ] }));
    const sentinelA = path.join(dir, 'out-failed.html').replace(/\\/g, '/');
    const sentinelB = path.join(dir, 'out-ok.html').replace(/\\/g, '/');



    const probe = `(async()=>{
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    const checks=[];const push=(n,v,d)=>checks.push([n,!!v,d===undefined?'':String(d)]);
    const waitFor=async(fn,ms)=>{const t0=Date.now();while(Date.now()-t0<(ms||8000)){if(fn())return true;await sleep(60);}return !!fn();};
    const libReady=await waitFor(()=>window.LibraryUI&&LibraryUI.isOpen()&&document.querySelectorAll('#lib-grid .lib-card').length===1,10000);
    push('文献库就绪',libReady);
    if(!libReady)return {checks};
    document.querySelector('.lib-card[data-key="d1"]').click();
    await sleep(400);
    const box=document.querySelector('#ld-notes [data-note-id="nsub"]');
    push('子笔记编辑区就绪',!!box);
    if(!box)return {checks};
    const rich=box.querySelector('.ld-note-rich');
    // 1) 保存必失败的编辑（内容带注入标记），走真实导出下拉
    rich.innerHTML='<p>__FAIL_SAVE__ 最新修改</p>';
    const sel=box.querySelector('.ld-note-export');
    push('导出入口存在',!!sel);
    sel.value='html';
    sel.dispatchEvent(new Event('change',{bubbles:true}));
    await sleep(1500);
    push('保存失败后编辑器内容保留',rich.innerHTML.includes('最新修改'),rich.innerHTML.slice(0,60));
    const s1=await pdfBridge.lib.summary();
    const libText=(s1.items.find(x=>x.key==='d1').notes[0].text)||'';
    push('失败后库内容回滚为旧正文',libText.includes('旧正文')&&!libText.includes('最新修改'),libText);
    push('失败提示可见',document.getElementById('toast').textContent.includes('保存失败'),document.getElementById('toast').textContent);
    // 2) 修好内容再导出：保存成功，导出携带最新正文
    rich.innerHTML='<p>最新修改</p>';
    sel.value='html';
    sel.dispatchEvent(new Event('change',{bubbles:true}));
    await sleep(1500);
    const s2=await pdfBridge.lib.summary();
    const libText2=(s2.items.find(x=>x.key==='d1').notes[0].text)||'';
    push('重试后库内容为最新',libText2.includes('最新修改'),libText2);
    return {checks};})()`;

    const driver = `
const fs=require('fs'),path=require('path'),{app,dialog}=require('electron');
app.setPath('userData',${JSON.stringify(ud)});
process.env.PDFREADER_LIBRARY=${JSON.stringify(path.join(data, 'library.json'))};
process.env.PDFREADER_DATA_DIR=${JSON.stringify(data)};
process.env.PDFREADER_NO_AUTO_INDEX='1';
let saveCalls=0;
dialog.showSaveDialog=async()=>{saveCalls++;return {canceled:false,filePath:saveCalls===1?${JSON.stringify(sentinelA)}:${JSON.stringify(sentinelB)}};};
const write=fs.writeFileSync;
fs.writeFileSync=function(file,content,...args){
  // 用原生反斜杠路径做前缀匹配（fwd 版本永远匹配不上 Windows 的 file 参数）
  if((String(file).startsWith(${JSON.stringify(data)})||String(file).startsWith(${JSON.stringify(ud)}))&&String(content).includes('__FAIL_SAVE__'))throw new Error('injected write failure');
  return write.call(this,file,content,...args);
};
const probe=${JSON.stringify(probe)};
const file=${JSON.stringify(path.join(dir, 'probe.cjs'))};
fs.writeFileSync(file,'module.exports='+JSON.stringify(probe));
process.env.PDFREADER_PROBE=file;
require(${JSON.stringify(path.join(ROOT, 'src/main.js'))});`;

    const driverFile = path.join(dir, 'driver.cjs');
    fs.writeFileSync(driverFile, driver);
    const env = Object.assign({}, process.env);
    delete env.ELECTRON_RUN_AS_NODE;
    let output = '';
    try {
      output = execFileSync(ELECTRON, [driverFile, '--no-sandbox', '--disable-gpu'], { cwd: ROOT, env, encoding: 'utf8', timeout: 120000, windowsHide: true });
    } catch (err) {
      output = String((err && err.stdout) || '') + '\n' + String((err && err.stderr) || '');
      if (!output.includes('[probe-result]')) throw new Error('Electron 异常退出：' + output.slice(-800));
    }
    const line = output.split(/\r?\n/).find((l) => l.includes('[probe-result]'));
    assert(line, '没有探针结果\n' + output.slice(-800));
    const res = JSON.parse(line.slice(line.indexOf('{')));
    assert(!res.fatal, '探针抛错：' + res.fatal);
    for (const [name, ok, detail] of res.checks) console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok ? '' : '  <- ' + detail));
    assert.equal(res.checks.filter((c) => !c[1]).length, 0, '探针有失败项');

    // Node 侧：被取消的导出不开对话框，所以只有重试那一次落盘——
    // 恰好一个哨兵存在、内容为最新正文。（带旧 bug 时会落两个文件且其一含旧正文）
    const aExists = fs.existsSync(path.join(dir, 'out-failed.html'));
    const bExists = fs.existsSync(path.join(dir, 'out-ok.html'));
    assert.ok(aExists !== bExists, '应恰好落盘一次导出（失败那次不开对话框）');
    const exported = fs.readFileSync(path.join(dir, aExists ? 'out-failed.html' : 'out-ok.html'), 'utf8');
    assert.ok(exported.includes('最新修改'), '导出文件包含最新正文');
    assert.ok(!exported.includes('旧正文') && !exported.includes('__FAIL_SAVE__'), '导出文件不含旧内容或注入标记');
    console.log('[n01-note-export-save] PASS');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(3); });
