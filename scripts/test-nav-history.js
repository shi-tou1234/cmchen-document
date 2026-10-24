'use strict';
/*
 * v33 阅读导航历史回归：显式跳转（页码输入）入栈，Alt+←/→ 后退前进，
 * 纯滚动漂移在后退时补记（前进能回到漂移位置），新跳转截断前进分支，
 * 库覆盖层打开时不响应，栈底/栈顶有明确反馈。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runProbe } = require('./probe-runner');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-nav-history-'));
try {
  const source = path.join(dir, 'fixture.pdf');
  fs.copyFileSync(path.join(__dirname, '../assets/sample.pdf'), source);
  fs.mkdirSync(path.join(dir, 'ud'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify({ version: 8, items: [
    { key: 'a', title: 'Nav document', attachment: { path: source } },
  ] }));

  const code = `(async()=>{
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    const checks=[];const push=(n,v,d)=>checks.push([n,!!v,d===undefined?'':String(d)]);
    const waitFor=async(fn,ms)=>{const t0=Date.now();while(Date.now()-t0<(ms||8000)){if(fn())return true;await sleep(60);}return !!fn();};
    // 打开文档并收起库覆盖层（库开着时阅读快捷键不响应，与真实阅读一致）。
    // 探针窗口是隐藏的：rAF 被限到 ~1Hz，平滑滚动不会真正发生，迟到的
    // IntersectionObserver 会把页码纠正回实际可见页——切到单页翻页模式，
    // 跳页不走 scrollIntoView，断言才是确定性的（真实可见窗口两种模式都正常）。
    const p=await pdfBridge.lib.openItem('a',1);
    push('文档打开',p&&p.ok,(p&&p.error)||'');
    await window.__libOpen(p);
    App.setViewMode('page');
    LibraryUI.hide();
    await sleep(400);
    const cur=()=>App.state.currentPage;
    const nav=()=>App.navState();
    const altKey=(key)=>document.dispatchEvent(new KeyboardEvent('keydown',{key,altKey:true,bubbles:true,cancelable:true}));
    const jumpTo=(n)=>{const box=document.getElementById('page-input');box.value=String(n);box.dispatchEvent(new Event('change',{bubbles:true}));};
    await waitFor(()=>cur()===1,5000);
    push('初始落页不入历史',nav()===null,JSON.stringify(nav()));
    // 1 → 2 → 3 两次显式跳转
    jumpTo(2);
    await waitFor(()=>cur()===2,4000);
    push('跳到第 2 页',cur()===2,String(cur()));
    push('历史记录跳转',[1,2].every((x,i)=>nav().stack[i]===x)&&nav().idx===1,JSON.stringify(nav()));
    jumpTo(3);
    await waitFor(()=>cur()===3,4000);
    push('历史 [1,2,3]',nav().stack.join(',')==='1,2,3'&&nav().idx===2,JSON.stringify(nav()));
    // 后退两次 → 2 → 1
    altKey('ArrowLeft');
    await waitFor(()=>cur()===2,4000);
    push('Alt+← 后退到第 2 页',cur()===2&&nav().idx===1,cur()+'/'+JSON.stringify(nav()));
    altKey('ArrowLeft');
    await waitFor(()=>cur()===1,4000);
    push('Alt+← 再退到第 1 页',cur()===1&&nav().idx===0,String(cur()));
    // 栈底再退：不动 + 状态反馈
    altKey('ArrowLeft');
    await sleep(250);
    push('栈底再退不越界',cur()===1&&nav().idx===0,String(cur()));
    // 前进两次 → 2 → 3
    altKey('ArrowRight');
    await waitFor(()=>cur()===2,4000);
    push('Alt+→ 前进到第 2 页',cur()===2,String(cur()));
    altKey('ArrowRight');
    await waitFor(()=>cur()===3,4000);
    push('Alt+→ 前进到第 3 页',cur()===3,String(cur()));
    altKey('ArrowRight');
    await sleep(250);
    push('栈顶再进不越界',cur()===3,String(cur()));
    // 漚移：不经记录直接滚回第 1 页，后退应补记当前位置并回到 3，前进再回 1
    App.scrollToPage(1,true);
    await waitFor(()=>cur()===1,4000);
    push('漂移不入栈',nav().stack.length===3,JSON.stringify(nav()));
    altKey('ArrowLeft');
    await waitFor(()=>cur()===3,4000);
    push('后退回到漂移前的栈顶',cur()===3&&nav().stack.length===4,cur()+'/'+JSON.stringify(nav()));
    altKey('ArrowRight');
    await waitFor(()=>cur()===1,4000);
    push('前进回到漂移后的位置',cur()===1,String(cur()));
    // 新跳转截断前进分支
    jumpTo(2);
    await waitFor(()=>cur()===2,4000);
    push('新跳转后无前进',nav().idx===nav().stack.length-1,JSON.stringify(nav()));
    // 库覆盖层打开时不响应（点 Alt+← 不该动后台文档）
    LibraryUI.show();
    await sleep(250);
    altKey('ArrowLeft');
    await sleep(250);
    push('库打开时不响应',cur()===2,String(cur()));
    return {checks};})()`;
  fs.writeFileSync(path.join(dir, 'probe.cjs'), 'module.exports=' + JSON.stringify(code));
  const r = runProbe({
    probe: path.join(dir, 'probe.cjs'),
    env: { PDFREADER_LIBRARY: path.join(dir, 'library.json'), PDFREADER_DATA_DIR: dir, PDFREADER_NO_AUTO_INDEX: '1' },
    args: ['--user-data-dir=' + path.join(dir, 'ud')],
    label: 'nav-history',
  });
  assert.equal(r.fail, 0);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
