'use strict';
/*
 * v33 阅读会话恢复回归（restoreTabs）：
 *   第一次启动：开三个标签（A 第 2 页 / B / C），切回 A，开启设置，等会话落盘后退出；
 *   两次启动之间删掉 C 的文件 —— 恢复应跳过失联文件；
 *   第二次启动（同一 userData + 同一库）：自动恢复 A、B 两个标签，激活 A，A 停在第 2 页。
 * 同时在 Node 侧核对 session.json 的内容形状（路径 / 激活项 / 上限）。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runProbe } = require('./probe-runner');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-session-restore-'));
const ud = path.join(dir, 'ud');
try {
  const pdfA = path.join(dir, 'alpha.pdf');
  const pdfB = path.join(dir, 'beta.pdf');
  const pdfC = path.join(dir, 'gamma.pdf');
  for (const p of [pdfA, pdfB, pdfC]) fs.copyFileSync(path.join(__dirname, '../assets/sample.pdf'), p);
  fs.mkdirSync(path.join(ud), { recursive: true });
  fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify({ version: 8, items: [
    { key: 'a', title: 'Alpha doc', attachment: { path: pdfA } },
    { key: 'b', title: 'Beta doc', attachment: { path: pdfB } },
    { key: 'c', title: 'Gamma doc', attachment: { path: pdfC } },
  ] }));
  const env = { PDFREADER_LIBRARY: path.join(dir, 'library.json'), PDFREADER_DATA_DIR: dir, PDFREADER_NO_AUTO_INDEX: '1' };
  const args = ['--user-data-dir=' + ud];
  // Windows 路径反斜杠嵌进探针源码会被当转义吃掉，统一用正斜杠版本比较
  const pdfA_fwd = pdfA.replace(/\\/g, '/');

  // ---- 第一次启动：打开三个标签，切回 A，开启恢复设置 ----
  const probe1 = `(async()=>{
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    const checks=[];const push=(n,v,d)=>checks.push([n,!!v,d===undefined?'':String(d)]);
    const waitFor=async(fn,ms)=>{const t0=Date.now();while(Date.now()-t0<(ms||8000)){if(fn())return true;await sleep(60);}return !!fn();};
    const open=async(key,page)=>{const p=await pdfBridge.lib.openItem(key,page);push('打开 '+key+' 成功',p&&p.ok,(p&&p.error)||'');if(p&&p.ok)await window.__libOpen(p);};
    await open('a',2);
    await open('b',1);
    await open('c',1);
    await waitFor(()=>document.querySelectorAll('#tabs .tab').length===3,6000);
    push('三个标签就位',document.querySelectorAll('#tabs .tab').length===3,String(document.querySelectorAll('#tabs .tab').length));
    // 切回 A（按 title 里的路径找标签，路径统一成正斜杠再比）
    for(const el of document.querySelectorAll('#tabs .tab')){
      if((el.getAttribute('title')||'').replace(/\\\\/g,'/')==='${pdfA_fwd}'){el.click();break;}
    }
    await sleep(300);
    const setR=await pdfBridge.setSettings({restoreTabs:true});
    push('开启恢复设置',setR&&setR.ok!==false,(setR&&setR.error)||'');
    await sleep(1000);   // 会话去抖 600ms + 页码上报 500ms
    const sess=await pdfBridge.getSession();
    push('会话记录三个标签',sess&&sess.tabs&&sess.tabs.length===3,String(sess&&sess.tabs&&sess.tabs.length));
    push('会话激活项是 A',sess&&String(sess.active||'').replace(/\\\\/g,'/')==='${pdfA_fwd}',sess&&sess.active);
    return {checks};})()`;
  fs.writeFileSync(path.join(dir, 'probe1.cjs'), 'module.exports=' + JSON.stringify(probe1));
  const r1 = runProbe({ probe: path.join(dir, 'probe1.cjs'), env, args, label: 'session-restore-open' });
  assert.equal(r1.fail, 0);

  // Node 侧核对 session.json 形状
  const sessFile = path.join(ud, 'session.json');
  assert.ok(fs.existsSync(sessFile), 'session.json 应已写入');
  const sess = JSON.parse(fs.readFileSync(sessFile, 'utf8'));
  assert.equal(sess.tabs.length, 3, 'session.json 记录 3 个标签');
  assert.ok(sess.tabs.every((t) => t.path && t.page >= 1 && (t.kind === 'pdf' || t.kind === 'rich')), '标签字段形状正确');
  const active = sess.active.replace(/\\/g, '/');
  assert.ok(active.endsWith('alpha.pdf'), '激活项是 alpha：' + active);

  // ---- 两次启动之间：删掉 C 的文件 ----
  fs.rmSync(pdfC);

  // ---- 第二次启动：应自动恢复 A、B（C 跳过），激活 A，A 停在第 2 页 ----
  const probe2 = `(async()=>{
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    const checks=[];const push=(n,v,d)=>checks.push([n,!!v,d===undefined?'':String(d)]);
    const waitFor=async(fn,ms)=>{const t0=Date.now();while(Date.now()-t0<(ms||10000)){if(fn())return true;await sleep(80);}return !!fn();};
    const tabs=()=>document.querySelectorAll('#tabs .tab');
    const restored=await waitFor(()=>tabs().length===2,12000);
    push('恢复 A、B 两个标签',restored,String(tabs().length));
    if(!restored)return {checks};
    const titles=Array.from(tabs()).map(x=>x.textContent);
    push('标签是 alpha 与 beta',titles.some(t=>t.includes('alpha'))&&titles.some(t=>t.includes('beta')),titles.join('|'));
    const cur=window.App.tabs.find(t=>t.id===window.App.activeTabId);
    push('激活标签是 alpha',cur&&/alpha/.test(cur.filePath||''),cur&&cur.filePath);
    const tabA=window.App.tabs.find(t=>/alpha/.test(t.filePath||''));
    push('A 标签记住第 2 页',tabA&&tabA.page===2,String(tabA&&tabA.page));
    const onA=await waitFor(()=>window.App.state.currentPage===2,6000);
    push('A 滚回第 2 页',onA,String(window.App.state.currentPage));
    return {checks};})()`;
  fs.writeFileSync(path.join(dir, 'probe2.cjs'), 'module.exports=' + JSON.stringify(probe2));
  const r2 = runProbe({ probe: path.join(dir, 'probe2.cjs'), env, args, label: 'session-restore-back' });
  assert.equal(r2.fail, 0);

  // ---- 第三次检查：关掉恢复设置后，会话不再自动打开（同一会话文件仍在） ----
  fs.rmSync(path.join(dir, 'probe1.cjs'));
  fs.rmSync(path.join(dir, 'probe2.cjs'));
  const probe3 = `(async()=>{
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    const checks=[];const push=(n,v,d)=>checks.push([n,!!v,d===undefined?'':String(d)]);
    await sleep(1500);   // 给可能的恢复事件留足时间
    push('关闭设置后不恢复',document.querySelectorAll('#tabs .tab').length===0,String(document.querySelectorAll('#tabs .tab').length));
    return {checks};})()`;
  fs.writeFileSync(path.join(dir, 'probe3.cjs'), 'module.exports=' + JSON.stringify(probe3));
  const env3 = Object.assign({}, env);
  const args3 = ['--user-data-dir=' + path.join(dir, 'ud-off')];
  fs.mkdirSync(path.join(dir, 'ud-off'), { recursive: true });
  fs.copyFileSync(path.join(ud, 'settings.json'), path.join(dir, 'ud-off', 'settings.json'));
  fs.copyFileSync(sessFile, path.join(dir, 'ud-off', 'session.json'));
  // 把设置里的 restoreTabs 改回 false，会话文件保留
  const offSettings = JSON.parse(fs.readFileSync(path.join(dir, 'ud-off', 'settings.json'), 'utf8'));
  offSettings.restoreTabs = false;
  fs.writeFileSync(path.join(dir, 'ud-off', 'settings.json'), JSON.stringify(offSettings));
  const r3 = runProbe({ probe: path.join(dir, 'probe3.cjs'), env: env3, args: args3, label: 'session-restore-off' });
  assert.equal(r3.fail, 0);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
