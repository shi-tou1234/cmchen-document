'use strict';
/*
 * v34 阅读器回归：页面旋转 + 只读分屏参考视图。
 * 运行：node scripts/test-reader-rotate-split.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runProbe } = require('./probe-runner');

const ROOT = path.join(__dirname, '..');
const SAMPLE = path.join(ROOT, 'assets', 'sample.pdf');

let code = 0;
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-rot-split-'));
  const udd = path.join(tmp, 'ud');
  fs.mkdirSync(udd);
  try {
    // 两个不同路径的副本：第二个标签用来验证旋转按标签独立保存
    const a = path.join(tmp, 'sample.pdf');
    const b = path.join(tmp, 'sample2.pdf');
    fs.copyFileSync(SAMPLE, a);
    fs.copyFileSync(SAMPLE, b);

    const { fail } = runProbe({
      probePath: path.join(__dirname, 'probe-reader-rotate-split.js'),
      tmpDir: tmp,
      inject: {
        __SAMPLE__: a.replace(/\\/g, '/'),
        __SAMPLE2__: b.replace(/\\/g, '/'),
      },
      env: {
        PDFREADER_DATA_DIR: tmp,
        PDFREADER_LIBRARY: path.join(tmp, 'library.json'),
        PDFREADER_NO_AUTO_INDEX: '1',
      },
      args: ['--user-data-dir=' + udd],
      label: 'reader-rotate-split',
      timeout: 300000,
    });
    code = fail ? 2 : 0;
    if (fail) throw new Error('旋转 / 分屏回归失败');

    // 第二次启动：会话里预置 rotation=180 + refPage=2，恢复后必须原样回来
    const ud2 = path.join(tmp, 'ud-restore');
    fs.mkdirSync(ud2, { recursive: true });
    fs.writeFileSync(path.join(ud2, 'settings.json'), JSON.stringify({ restoreTabs: true, splitView: true }));
    fs.writeFileSync(path.join(ud2, 'session.json'), JSON.stringify({
      saved: Date.now(),
      active: a.replace(/\\/g, '/'),
      tabs: [{ path: a.replace(/\\/g, '/'), name: 'sample.pdf', kind: 'pdf', itemKey: '', page: 2, rotation: 180, refPage: 2 }],
    }));
    const probe2 = `(async()=>{
      const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
      const checks=[];const push=(n,v,d)=>checks.push([n,!!v,d===undefined?'':String(d)]);
      const waitFor=async(fn,ms)=>{const t0=Date.now();while(Date.now()-t0<(ms||20000)){if(fn())return true;await sleep(100);}return !!fn();};
      const ready=await waitFor(()=>window.App&&App.tabs.length===1&&App.state.pdfDoc&&App.state.currentPage===2,25000);
      push('会话恢复出标签',ready,String(window.App&&App.tabs.length));
      if(!ready)return {checks};
      push('恢复旋转角 180°',App.viewRotation()===180,String(App.viewRotation()));
      const rotEl=document.querySelector('#page-2 .page-rot');
      push('页面按 180° 渲染',!!rotEl&&/rotate\\(180deg\\)/.test(rotEl.style.transform||''),rotEl&&rotEl.style.transform);
      const paneShown=await waitFor(()=>!document.querySelector('#ref-pane').hidden,5000);
      push('恢复分屏偏好',paneShown);
      push('恢复参考页 2',App.splitState().page===2,String(App.splitState().page));
      await sleep(1200);
      const sess=await pdfBridge.getSession();
      const rec=sess&&sess.tabs&&sess.tabs[0];
      push('恢复后会话仍记录 180°',rec&&rec.rotation===180,rec&&rec.rotation);
      return {checks};})()`;
    fs.writeFileSync(path.join(tmp, 'probe-restore.cjs'), 'module.exports=' + JSON.stringify(probe2));
    const r2 = runProbe({
      probe: path.join(tmp, 'probe-restore.cjs'),
      env: {
        PDFREADER_DATA_DIR: tmp,
        PDFREADER_LIBRARY: path.join(tmp, 'library.json'),
        PDFREADER_NO_AUTO_INDEX: '1',
      },
      args: ['--user-data-dir=' + ud2],
      label: 'reader-rotate-restore',
      timeout: 180000,
    });
    if (r2.fail) throw new Error('旋转 / 分屏会话恢复失败');
  } catch (e) {
    console.error('[reader-rotate-split] ERROR', e && e.message ? e.message : e);
    code = 3;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(code);
})();
