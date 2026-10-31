'use strict';
/*
 * 回顾面板端到端回归（真实 Electron + 真实 preload）：
 * 空态 → 一键纳入标注 → 卡片默认模糊、评分按钮禁用 → 显示答案（按钮与空格两条路）
 * → 评分写入 recall.json → 一轮走完的汇总 → 没有标注的孤儿卡片被清掉。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runProbe } = require('./probe-runner');

const DAY = 86400000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-recall-ui-'));
try {
  const source = path.join(dir, 'fixture.pdf');
  fs.copyFileSync(path.join(__dirname, '../assets/sample.pdf'), source);
  fs.mkdirSync(path.join(dir, 'ud/annotations'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify({ version: 8, items: [
    { key: 'a', title: 'Recall document', attachment: { path: source } },
  ] }));
  // 文件名要像真实 sidecar（<hex>.json）：恢复备份时会按这个名字校验
  fs.writeFileSync(path.join(dir, 'ud/annotations/a1b2c3d4e5f6a7b8.json'), JSON.stringify({ path: source, saved: 1,
    pages: [{ page: 1, shapes: [
      { id: 'r1', tool: 'mark', text: 'alpha quote one', comment: 'my own note' },
      { id: 'r2', tool: 'mark', text: 'beta quote two' },
      { id: 'r3', tool: 'mark', text: 'gamma quote three' },
    ] }] }));
  // 孤儿卡片：标注已经不存在了，打开回顾时应该被清掉
  fs.writeFileSync(path.join(dir, 'ud/recall.json'), JSON.stringify({ version: 1, cards: {
    zzz: { addedAt: Date.now() - DAY, due: Date.now() - DAY, interval: 0, ease: 2.5, reps: 0, lapses: 0, last: 0, lastRating: 0 },
  } }));

  const code = `(async()=>{
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    const checks=[];const push=(n,v,d)=>checks.push([n,!!v,d===undefined?'':String(d)]);
    const waitFor=async(fn,ms)=>{const t0=Date.now();while(Date.now()-t0<(ms||10000)){if(fn())return true;await sleep(60);}return !!fn();};
    const libReady=await waitFor(()=>window.LibraryUI&&LibraryUI.isOpen()&&document.querySelectorAll('#lib-grid .lib-card').length===1,12000);
    push('文献库已展开且条目就绪',libReady);
    if(!libReady)return {checks};

    const body=()=>document.getElementById('recall-body');
    const modal=document.getElementById('recall-modal');
    document.getElementById('lib-recall').click();
    const opened=await waitFor(()=>modal&&!modal.hidden&&body()&&body().textContent.length>0,8000);
    push('工具栏「回顾」打开面板',opened);
    if(!opened)return {checks};

    // 1) 空态：孤儿卡片已清掉，提示「还没有要复习的标注」
    const empty=await waitFor(()=>body().querySelector('.rv-empty-t'),6000);
    push('空态提示出现',empty&&body().textContent.includes('还没有要复习'),body().textContent.slice(0,40));
    const st0=await pdfBridge.recall.state(30);
    push('没有标注的孤儿卡片被清掉',st0.stats.total===0,JSON.stringify(st0.stats));
    const addBtn=body().querySelector('[data-rv-addall]');
    push('提供「把全部标注加入回顾」且可点',!!addBtn&&!addBtn.disabled,addBtn&&addBtn.textContent);

    // 2) 一键纳入 3 条标注
    addBtn.click();
    const gotCard=await waitFor(()=>body().querySelector('.rv-quote'),8000);
    push('纳入后出现第一张卡片',gotCard);
    if(!gotCard)return {checks};
    const st1=await pdfBridge.recall.state(30);
    push('三张卡都已入库',st1.stats.total===3,JSON.stringify(st1.stats));
    push('新卡立刻到期（本次 3 张）',st1.stats.due===3,st1.stats.due);
    const prog=document.getElementById('recall-progress').textContent;
    push('面板显示本次进度与待复习数',/本次 1\\/3/.test(prog)&&/待复习 3/.test(prog),prog);

    // 3) 默认模糊、评分禁用
    const q=body().querySelector('.rv-quote');
    push('摘录默认是模糊的（先回想）',!q.classList.contains('shown'),q.className);
    const rates=()=>Array.from(body().querySelectorAll('[data-rv-rate]'));
    push('显示答案前评分按钮禁用',rates().length===0||rates().every(b=>b.disabled),rates().map(b=>b.disabled).join(','));
    push('卡片显示出处（文件名 · 页 · 类型）',/fixture\\.pdf/.test(body().querySelector('.rv-src').textContent)&&/第 1 页/.test(body().querySelector('.rv-src').textContent),body().querySelector('.rv-src').textContent);

    // 4) 空格显示答案（键盘路径）
    document.dispatchEvent(new KeyboardEvent('keydown',{key:' ',code:'Space',bubbles:true}));
    const revealed=await waitFor(()=>{const x=body().querySelector('.rv-quote');return x&&x.classList.contains('shown');},4000);
    push('按空格显示答案',revealed);
    push('显示后评分按钮可用',rates().length===4&&rates().every(b=>!b.disabled),rates().map(b=>b.disabled).join(','));
    push('显示批注内容',!!body().querySelector('.rv-note')&&body().querySelector('.rv-note').classList.contains('shown'));

    // 5) 依次评分：记得 / 忘了 / 太简单
    body().querySelector('[data-rv-rate="3"]').click();
    await sleep(300);
    const st2=await pdfBridge.recall.state(30);
    push('评「记得」后今日完成 1 张',st2.stats.todayDone===1,JSON.stringify(st2.stats));
    push('评完自动跳到下一张',!!body().querySelector('.rv-quote')&&!body().querySelector('.rv-quote').classList.contains('shown'));

    body().querySelector('[data-rv-reveal]').click();
    await waitFor(()=>body().querySelector('[data-rv-rate="1"]'),3000);
    body().querySelector('[data-rv-rate="1"]').click();
    await sleep(300);
    body().querySelector('[data-rv-reveal]').click();
    await waitFor(()=>body().querySelector('[data-rv-rate="4"]'),3000);
    body().querySelector('[data-rv-rate="4"]').click();
    const done=await waitFor(()=>body().querySelector('.rv-empty-t'),5000);
    push('一轮走完显示汇总',done&&body().textContent.includes('这一轮走完了'),body().textContent.slice(0,60));
    push('汇总里有记得 / 忘了计数',/记得 2/.test(body().textContent)&&/忘了 1/.test(body().textContent),body().textContent.slice(0,120));

    // 6) Esc 关闭
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    await sleep(120);
    push('Esc 关闭面板',modal.hidden);

    // 6.5) v1.6：大纲页签 + Tab 缩进
    document.getElementById('lib-recall').click();
    // 等重新渲染完成再切页签：面板只是隐藏，body 里还留着上一次的内容，
    // 过早点击会被 openRecall 的后续 rvApply 覆盖回复习视图
    await sleep(900);
    await waitFor(()=>modal&&!modal.hidden&&body().querySelector('.rv-quote'),8000);
    const tabBtn=document.getElementById('recall-tab-outline');
    push('有「大纲」页签',!!tabBtn);
    tabBtn.click();
    const olReady=await waitFor(()=>body().querySelector('.rv-ol-row'),6000);
    push('大纲列出卡片',olReady&&body().querySelectorAll('.rv-ol-row').length===3,
      olReady?body().querySelectorAll('.rv-ol-row').length:0);
    const row=body().querySelector('.rv-ol-row');
    if(row){
      push('大纲行可聚焦（Tab 缩进的前提）',row.getAttribute('tabindex')==='0');
      row.focus();
      const cardId=row.getAttribute('data-rv-card');
      row.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));
      await sleep(500);
      const row2=body().querySelector('[data-rv-card="'+cardId+'"]');
      push('Tab 缩进一层',row2&&row2.style.getPropertyValue('--d')==='1',(row2&&row2.style.getPropertyValue('--d')));
      const stDepth=await pdfBridge.recall.outline();
      const cardDepth=(stDepth.cards.find(c=>c.id===cardId)||{}).depth;
      push('缩进落库',cardDepth===1,cardDepth);
      row2.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}));
      await sleep(500);
      const row3=body().querySelector('[data-rv-card="'+cardId+'"]');
      push('Shift+Tab 收回来',row3&&row3.style.getPropertyValue('--d')==='0',row3&&row3.style.getPropertyValue('--d'));
    }
    push('大纲里没有评分按钮（空格不会误触发）',!body().querySelector('[data-rv-rate]'));
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    await sleep(120);

    // 7) 备份要把复习进度带上，恢复要能换回来（复习进度是状态，不是条目）
    const bk = await pdfBridge.lib.backup(__BACKUP_PATH__);
    push('备份写出成功',!!(bk&&bk.ok),JSON.stringify(bk).slice(0,140));
    const rst = await pdfBridge.lib.restore(__BACKUP_PATH__);
    push('从备份恢复并把回顾记录带回来',!!(rst&&rst.ok)&&rst.recall===3,JSON.stringify(rst).slice(0,180));

    const fin=await pdfBridge.recall.state(30);
    return {checks,stats:fin.stats,cards:fin.cards};})()`;
  const backupPath = path.join(dir, 'roundtrip.json');
  const codeInjected = code.split('__BACKUP_PATH__').join(JSON.stringify(backupPath));
  fs.writeFileSync(path.join(dir, 'probe.cjs'), 'module.exports=' + JSON.stringify(codeInjected));
  const r = runProbe({
    probe: path.join(dir, 'probe.cjs'),
    env: { PDFREADER_LIBRARY: path.join(dir, 'library.json'), PDFREADER_DATA_DIR: dir, PDFREADER_NO_AUTO_INDEX: '1' },
    args: ['--user-data-dir=' + path.join(dir, 'ud')],
    label: 'recall-ui',
    timeout: 180000,
  });
  assert.equal(r.fail, 0, 'UI 检查有失败项');

  // 落盘结果：调度要真的写回 recall.json（不是只在内存里改了改）
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'ud/recall.json'), 'utf8'));
  const ids = Object.keys(saved.cards).sort();
  assert.deepEqual(ids, ['r1', 'r2', 'r3'], '三张卡都要落盘，孤儿卡 zzz 要被清掉');
  const good = saved.cards.r1;   // 第一张评的是「记得」
  assert.strictEqual(good.lastRating, 3, 'r1 应记为「记得」');
  assert.strictEqual(good.reps, 1, 'r1 首次复习 reps=1');
  assert.strictEqual(good.interval, 1, '首次「记得」间隔应为 1 天');
  assert.ok(Math.abs(good.due - (Date.now() + DAY)) < 5 * 60 * 1000, 'r1 到期应约等于 24 小时后：' + new Date(good.due).toISOString());
  const again = saved.cards.r2;  // 第二张评的是「忘了」
  assert.strictEqual(again.lastRating, 1, 'r2 应记为「忘了」');
  assert.strictEqual(again.interval, 0, '「忘了」间隔归零');
  assert.strictEqual(again.lapses, 1, '「忘了」lapses +1');
  assert.ok(again.due - Date.now() < 11 * 60 * 1000, '「忘了」应在 10 分钟后到期');
  const easy = saved.cards.r3;
  assert.strictEqual(easy.interval, 3, '首次「太简单」间隔 3 天');

  // 备份文件里带上了回顾记录，恢复后又写回 recall.json
  const bkFile = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  assert.ok(bkFile.recall && bkFile.recall.cards, '备份里应有 recall 段');
  assert.deepEqual(Object.keys(bkFile.recall.cards).sort(), ['r1', 'r2', 'r3'], '备份里的回顾卡片应与库一致');
  assert.strictEqual(bkFile.recall.cards.r3.interval, 3, '备份里的调度字段应原样保存');
  const afterRestore = JSON.parse(fs.readFileSync(path.join(dir, 'ud/recall.json'), 'utf8'));
  assert.deepEqual(Object.keys(afterRestore.cards).sort(), ['r1', 'r2', 'r3'], '恢复后 recall.json 应仍是这三张');

  console.log('test-recall-ui: ' + (r.total || 0) + ' UI checks + 14 disk checks passed');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
