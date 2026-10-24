'use strict';
/*
 * v33 标注视图筛选回归：按类型 / 颜色多选过滤，命中任一即可；清除筛选复位；
 * 空结果提示与「还没有标注」区分；行内显示标注颜色圆点。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { runProbe } = require('./probe-runner');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-anno-filter-'));
try {
  const source = path.join(dir, 'fixture.pdf');
  fs.copyFileSync(path.join(__dirname, '../assets/sample.pdf'), source);
  fs.mkdirSync(path.join(dir, 'ud/annotations'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify({ version: 8, items: [
    { key: 'a', title: 'Filter document', attachment: { path: source } },
  ] }));
  const hash = crypto.createHash('sha1').update(source).digest('hex');
  // 六条不同类型 / 颜色的标注：高亮 / 批注 / 摘录 / 下划线 / 文字 / 便签
  fs.writeFileSync(path.join(dir, 'ud/annotations', hash.slice(0, 20) + '.json'), JSON.stringify({ path: source, saved: 1,
    pages: [{ page: 1, shapes: [
      { id: 's1', tool: 'mark', text: 'alpha one', color: '#ffd54f' },
      { id: 's2', tool: 'mark', text: 'alpha two', comment: 'note two', color: '#ffd54f' },
      { id: 's3', tool: 'mark', kind: 'quote', text: 'alpha three', color: '#ab47bc' },
      { id: 's4', tool: 'mark', kind: 'underline', text: 'alpha four', color: '#e05a4f' },
      { id: 's5', tool: 'text', text: 'alpha five', color: '#e53935' },
      { id: 's6', tool: 'note', text: 'alpha six', color: '#ffe082' },
    ] }] }));

  const code = `(async()=>{
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    const checks=[];const push=(n,v,d)=>checks.push([n,!!v,d===undefined?'':String(d)]);
    const waitFor=async(fn,ms)=>{const t0=Date.now();while(Date.now()-t0<(ms||10000)){if(fn())return true;await sleep(60);}return !!fn();};
    const libReady=await waitFor(()=>window.LibraryUI&&LibraryUI.isOpen()&&document.querySelectorAll('.lib-anno').length===0&&document.querySelectorAll('#lib-grid .lib-card').length===1,10000);
    push('文献库已展开且条目就绪',libReady);
    if(!libReady)return {checks};
    document.querySelector('[data-scope="annotations"]').click();
    const shown=await waitFor(()=>document.querySelectorAll('.lib-anno').length===6,6000);
    push('标注视图列出 6 条',shown,String(document.querySelectorAll('.lib-anno').length));
    if(!shown)return {checks};
    const bar=document.getElementById('lib-anno-filter');
    push('筛选条可见',bar&&!bar.hidden);
    const kinds=Array.from(bar.querySelectorAll('.af-chip')).map(x=>x.dataset.annoKind);
    push('类型片含六类',['高亮','批注','摘录','下划线','文字','便签'].every(k=>kinds.includes(k)),kinds.join('|'));
    const dots=Array.from(bar.querySelectorAll('.af-dot'));
    push('颜色片按数量排序',dots.length===5&&dots[0].dataset.annoColor==='#ffd54f',dots.map(x=>x.dataset.annoColor+':'+x.textContent.trim()).join(' '));
    push('未选筛选时无清除按钮',!bar.querySelector('[data-anno-clear]'));
    // 1) 类型筛选：高亮 → 只剩 s1
    bar.querySelector('.af-chip[data-anno-kind="高亮"]').click();
    await sleep(80);
    const rows=()=>document.querySelectorAll('.lib-anno');
    push('高亮筛选剩 1 条',rows().length===1,String(rows().length));
    push('行来源标注类型',rows()[0].querySelector('.lcmeta').textContent.includes('高亮'),rows()[0].querySelector('.lcmeta').textContent);
    push('清除按钮出现',!!bar.querySelector('[data-anno-clear]'));
    // 2) 再点一次取消 → 回到 6
    bar.querySelector('.af-chip[data-anno-kind="高亮"]').click();
    await sleep(80);
    push('取消类型筛选回到 6 条',rows().length===6,String(rows().length));
    // 3) 颜色筛选：#ffd54f → s1+s2
    bar.querySelector('.af-dot[data-anno-color="#ffd54f"]').click();
    await sleep(80);
    push('颜色筛选剩 2 条',rows().length===2,String(rows().length));
    bar.querySelector('.af-dot[data-anno-color="#ffd54f"]').click();
    await sleep(80);
    // 4) 多选：高亮 + 摘录 → 2 条
    bar.querySelector('.af-chip[data-anno-kind="高亮"]').click();
    bar.querySelector('.af-chip[data-anno-kind="摘录"]').click();
    await sleep(80);
    push('类型多选命中任一',rows().length===2,String(rows().length));
    // 5) 类型 + 颜色同时：高亮 + #ffd54f → 只剩 s1
    bar.querySelector('.af-dot[data-anno-color="#ffd54f"]').click();
    await sleep(80);
    push('类型颜色同时生效',rows().length===1,String(rows().length));
    // 6) 清除筛选
    bar.querySelector('[data-anno-clear]').click();
    await sleep(80);
    push('清除筛选回到 6 条',rows().length===6&&!bar.querySelector('[data-anno-clear]'),String(rows().length));
    // 7) 行内颜色圆点
    push('行内显示颜色圆点',!!rows()[0].querySelector('.lctype .af-dotc'));
    // 8) 筛选空结果提示：便签(#ffe082) ∩ 颜色 #ffd54f → 空
    bar.querySelector('.af-chip[data-anno-kind="便签"]').click();
    bar.querySelector('.af-dot[data-anno-color="#ffd54f"]').click();
    await sleep(80);
    const emptyMsg=document.getElementById('lib-empty');
    push('筛选空提示区分于无标注',rows().length===0&&!emptyMsg.hidden&&emptyMsg.textContent.includes('筛选'),emptyMsg.textContent);
    return {checks};})()`;
  fs.writeFileSync(path.join(dir, 'probe.cjs'), 'module.exports=' + JSON.stringify(code));
  const r = runProbe({
    probe: path.join(dir, 'probe.cjs'),
    env: { PDFREADER_LIBRARY: path.join(dir, 'library.json'), PDFREADER_DATA_DIR: dir, PDFREADER_NO_AUTO_INDEX: '1' },
    args: ['--user-data-dir=' + path.join(dir, 'ud')],
    label: 'anno-filter',
  });
  assert.equal(r.fail, 0);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
