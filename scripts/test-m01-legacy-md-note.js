'use strict';
/*
 * M01 回归（2026-10-24 三次核查）：旧 Markdown 子笔记（html 空）经详情面板导出，
 * 来源链接不能丢。
 *
 * 复现链路：详情面板把 Markdown 正文渲染成应用占位链接（data-md-link +
 * href="javascript:void(0)"）→ 导出前保存经富文本清洗把 href 改成 "#" →
 * fromHtml 只读 href 就丢了 URL。修复后 fromHtml 优先读 data-md-link。
 *
 * 覆盖验收的三条路径：不编辑直接导出 / 自动保存后导出 / 编辑后导出，
 * 以及非法协议降级；对话框按 driver 注入顺序返回编号哨兵路径。
 */
const assert = require('assert');
const execFileSync = require('child_process').execFileSync;
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-m01-legacy-'));
  try {
    const ud = path.join(dir, 'ud');
    const data = path.join(dir, 'data');
    fs.mkdirSync(ud, { recursive: true });
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(data, 'library.json'), JSON.stringify({ version: 8, items: [
      { key: 'd6', title: 'M01 legacy md subnote', notes: [{ id: 'nl', title: '阅读记录', text: '## 阅读笔记\n\n[论文来源](https://example.org/paper?a=1&b=2)', html: '' }] },
      { key: 'd7', title: 'M01 legacy bad proto', notes: [{ id: 'nb2', title: '', text: '[危险](javascript:alert(1))', html: '' }] },
    ] }));

    const probe = `(async()=>{
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    const checks=[];const push=(n,v,d)=>checks.push([n,!!v,d===undefined?'':String(d)]);
    const waitFor=async(fn,ms)=>{const t0=Date.now();while(Date.now()-t0<(ms||8000)){if(fn())return true;await sleep(60);}return !!fn();};
    const libReady=await waitFor(()=>window.LibraryUI&&LibraryUI.isOpen()&&document.querySelectorAll('#lib-grid .lib-card').length===2,10000);
    push('文献库就绪',libReady);
    if(!libReady)return {checks};
    // 复现前置：详情面板把旧 Markdown 渲染成应用占位链接
    document.querySelector('.lib-card[data-key="d6"]').click();
    await sleep(400);
    const box6=document.querySelector('#ld-notes [data-note-id="nl"]');
    push('子笔记编辑区就绪',!!box6);
    if(!box6)return {checks};
    const rich6=box6.querySelector('.ld-note-rich');
    push('编辑器初始为占位链接',rich6.innerHTML.includes('data-md-link')&&rich6.innerHTML.includes('href="javascript:void(0)"'),rich6.innerHTML.slice(0,90));
    const sel6=box6.querySelector('.ld-note-export');
    push('导出入口存在',!!sel6);
    // 路径 1：不编辑直接导出 HTML（保存把 href 清洗成 #，URL 只剩 data-md-link）
    sel6.value='html';
    sel6.dispatchEvent(new Event('change',{bubbles:true}));
    await sleep(1600);
    // 路径 2：输入事件触发自动保存，再导出 Markdown
    rich6.innerHTML+='<p>自动保存的补充</p>';
    rich6.dispatchEvent(new Event('input',{bubbles:true}));
    await sleep(1200);   // 自动保存去抖 700ms
    sel6.value='md';
    sel6.dispatchEvent(new Event('change',{bubbles:true}));
    await sleep(1600);
    // 路径 3：手动编辑后导出 HTML
    rich6.innerHTML+='<p>手动编辑的补充</p>';
    sel6.value='html';
    sel6.dispatchEvent(new Event('change',{bubbles:true}));
    await sleep(1600);
    // 非法协议子笔记：同链路导出
    document.querySelector('.lib-card[data-key="d7"]').click();
    await sleep(400);
    const sel7=document.querySelector('#ld-notes [data-note-id="nb2"] .ld-note-export');
    sel7.value='html';
    sel7.dispatchEvent(new Event('change',{bubbles:true}));
    await sleep(1600);
    return {checks};})()`;

    const driver = `
const fs=require('fs'),path=require('path'),{app,dialog}=require('electron');
app.setPath('userData',${JSON.stringify(ud)});
process.env.PDFREADER_LIBRARY=${JSON.stringify(path.join(data, 'library.json'))};
process.env.PDFREADER_DATA_DIR=${JSON.stringify(data)};
process.env.PDFREADER_NO_AUTO_INDEX='1';
let saveCalls=0;
dialog.showSaveDialog=async()=>{saveCalls++;return {canceled:false,filePath:${JSON.stringify(path.join(dir, 'exp'))}+'-'+saveCalls+'.out'};};
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
      output = execFileSync(ELECTRON, [driverFile, '--no-sandbox', '--disable-gpu'], { cwd: ROOT, env, encoding: 'utf8', timeout: 150000, windowsHide: true });
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

    // ---------- Node 侧：按调用序核对四次导出产物 ----------
    const read = (n) => fs.readFileSync(path.join(dir, 'exp-' + n + '.out'), 'utf8');
    // 路径 1：不编辑直接导出的 HTML——URL 完整、链接可点
    const p1 = read(1);
    assert.ok(p1.includes('阅读笔记'), '路径 1 保留标题');
    assert.ok(/href="https:\/\/example\.org\/paper\?a=1&amp;b=2"/.test(p1), '路径 1 来源链接真实（单次转义）：' + (p1.match(/href="[^"]*"/g) || []).join(' '));
    assert.ok(!p1.includes('md-plain-link'), '路径 1 链接未降级');
    // 路径 2：自动保存后导出的 MD——链接与补充内容都在
    const p2 = read(2);
    assert.ok(p2.startsWith('## 阅读笔记'), '路径 2 保留标题');
    assert.ok(p2.includes('](https://example.org/paper?a=1&b=2)'), '路径 2 MD 链接真实且参数完整');
    assert.ok(p2.includes('自动保存的补充'), '路径 2 自动保存内容在');
    // 路径 3：编辑后导出的 HTML
    const p3 = read(3);
    assert.ok(p3.includes('手动编辑的补充'), '路径 3 手动编辑内容在');
    assert.ok(/href="https:\/\/example\.org\/paper\?a=1&amp;b=2"/.test(p3), '路径 3 来源链接仍真实');
    // 非法协议：不产生任何可点形态（往返后是惰性文本，无 anchor、无 data-md-link）
    const p4 = read(4);
    assert.ok(p4.includes('危险'), '非法协议产物存在');
    assert.ok(!/<a\s/.test(p4) && !p4.includes('data-md-link'), '非法协议无任何可点链接形态');
    // 库内存的 html 保留真实 URL 属性（URL 未丢，只是占位 href）
    const lib = JSON.parse(fs.readFileSync(path.join(data, 'library.json'), 'utf8'));
    const d6note = lib.items.find((x) => x.key === 'd6').notes[0];
    assert.ok((d6note.html || '').includes('data-md-link="https://example.org/paper'), '库内 html 保留真实 URL 属性');
    console.log('[m01-legacy-md-note] PASS');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(3); });
