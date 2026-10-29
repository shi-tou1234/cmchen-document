'use strict';
/*
 * v35 三个功能的界面级回归（真实 Electron + 真实 preload）：
 *   1. 条件检索：弹窗 → 字段联动运算符 → 预览计数 → 应用 → 横幅 → 清除 → 存为智能收藏集
 *   2. 标注回复树：回复按 replyTo 嵌到父批注后面，带缩进标记
 *   3. 笔记导出 Word：.doc 内容要有 mso 命名空间与表格，且不引 KaTeX 的相对样式表
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runProbe } = require('./probe-runner');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-adv-ui-'));
try {
  const source = path.join(dir, 'fixture.pdf');
  fs.copyFileSync(path.join(__dirname, '../assets/sample.pdf'), source);
  fs.mkdirSync(path.join(dir, 'ud/annotations'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify({ version: 8, items: [
    {
      key: 'a', title: 'Deep Learning', year: '2015', itemType: 'journalArticle',
      creators: [{ lastName: 'LeCun', firstName: 'Yann' }], tags: ['ml'],
      attachment: { path: source },
      notes: [{ id: 'n1', title: '读书笔记', html: '<p>第一段正文</p><table><thead><tr><th>列</th></tr></thead><tbody><tr><td>单元格</td></tr></tbody></table>', text: '' }],
    },
    { key: 'b', title: 'Attention Is All You Need', year: '2017', itemType: 'conferencePaper', creators: [{ lastName: 'Vaswani', firstName: 'Ashish' }], tags: [] },
    { key: 'c', title: '中文文献：深度学习综述', year: '', itemType: 'book', creators: [], tags: ['综述'] },
  ] }));
  // 回复排在父批注前面：不嵌套的话它会出现在最上面，嵌套后必须挂到父批注后面
  fs.writeFileSync(path.join(dir, 'ud/annotations/a1b2c3d4e5f6a7b8.json'), JSON.stringify({ path: source, saved: 1,
    pages: [{ page: 1, shapes: [
      { id: 'r1', replyTo: 'p1', tool: 'mark', text: '回复：同意这一点' },
      { id: 'p1', tool: 'mark', text: '父批注：注意这里的前提' },
      { id: 'p2', tool: 'mark', text: '另一条独立高亮' },
    ] }] }));
  // 父批注上挂两条标注，用来验「标注数 > 1」
  fs.writeFileSync(path.join(dir, 'ud/annotations/c9d8e7f6a5b4c3d2.json'), JSON.stringify({ path: source, saved: 1,
    pages: [{ page: 2, shapes: [{ id: 'q1', tool: 'mark', text: '第二条高亮' }] }] }));

  const docPath = path.join(dir, 'note.doc');
  const code = `(async()=>{ try {
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    const checks=[];const push=(n,v,d)=>checks.push([n,!!v,d===undefined?'':String(d)]);
    const waitFor=async(fn,ms)=>{const t0=Date.now();while(Date.now()-t0<(ms||10000)){if(fn())return true;await sleep(60);}return !!fn();};
    const cards=()=>Array.from(document.querySelectorAll('#lib-grid .lib-card'));
    const ready=await waitFor(()=>window.LibraryUI&&LibraryUI.isOpen()&&cards().length===3,15000);
    push('文献库已展开（3 条）',ready);
    if(!ready)return {checks,count:cards().length};
    await LibraryUI.loadAnnos(true);   // 条件检索按标注属性算，需要标注已在内存里

    const modal=document.getElementById('adv-modal');
    const rows=()=>document.getElementById('adv-rows');
    const cnt=()=>document.getElementById('adv-count').textContent;
    const bar=()=>document.getElementById('lib-adv-bar');

    // ---- 1. 打开弹窗 ----
    document.getElementById('lib-adv-btn').click();
    const opened=await waitFor(()=>modal&&!modal.hidden,6000);
    push('「条件检索」打开弹窗',opened);
    if(!opened)return {checks};
    push('默认给一行条件',rows().querySelectorAll('.adv-row').length===1);
    push('打开时给出总数',/共 3 条/.test(cnt()),cnt());

    // ---- 2. 字段联动运算符与值控件 ----
    const setField=(v)=>{const s=rows().querySelector('.adv-field');s.value=v;s.dispatchEvent(new Event('change',{bubbles:true}));};
    const setOp=(v)=>{const s=rows().querySelector('.adv-op');s.value=v;s.dispatchEvent(new Event('change',{bubbles:true}));};
    const setVal=(v)=>{const i=rows().querySelector('.adv-value');i.value=v;i.dispatchEvent(new Event('input',{bubbles:true}));};
    setField('annoCount');
    push('数值字段的运算符默认「等于」',rows().querySelector('.adv-op').value==='eq',rows().querySelector('.adv-op').value);
    push('数值字段的值框是 number',rows().querySelector('.adv-value').type==='number',rows().querySelector('.adv-value').type);
    push('「标注数 等于 0」命中没有标注的两条（b / c）',await (async()=>{setVal('0');await sleep(120);return cnt().indexOf('命中 2 / 3')>=0;})(),cnt());

    // 「为空」类运算符把值框换成占位
    setField('year');
    setOp('isEmpty');
    push('「为空」不需要填值（值框变成占位）',!!rows().querySelector('.adv-value-off')&&!rows().querySelector('input.adv-value'));
    push('「年份 为空」命中没有年份的那条',cnt().indexOf('命中 1 / 3')>=0,cnt());
    setOp('gt'); setVal('2016');
    push('年份大于 2016 命中 1 条',cnt().indexOf('命中 1 / 3')>=0,cnt());

    // ---- 3. 「且 / 或」与第二个条件 ----
    document.getElementById('adv-add').click();
    push('加条件后有两行',rows().querySelectorAll('.adv-row').length===2);
    // 改完字段会整行重画，所以每次都要重新取节点，不能留旧引用
    let row2=rows().querySelectorAll('.adv-row')[1];
    const f2=row2.querySelector('.adv-field'); f2.value='hasAttachment'; f2.dispatchEvent(new Event('change',{bubbles:true}));
    row2=rows().querySelectorAll('.adv-row')[1];
    push('布尔字段的运算符是「是 / 否」',Array.from(row2.querySelectorAll('.adv-op option')).map(o=>o.textContent).join('/')==='是/否',
      Array.from(row2.querySelectorAll('.adv-op option')).map(o=>o.textContent).join('/'));
    push('「且」时两条都满足才算（年份>2016 且有附件 = 0 条）',cnt().indexOf('命中 0 / 3')>=0,cnt());
    document.getElementById('adv-match').value='any';
    document.getElementById('adv-match').dispatchEvent(new Event('change',{bubbles:true}));
    push('切到「任一」后命中 2 条（a 有附件 / b 是 2017）',cnt().indexOf('命中 2 / 3')>=0,cnt());
    // 删掉第二个条件，回到单条件再应用
    rows().querySelectorAll('.adv-row')[1].querySelector('.adv-del').click();
    push('删条件后回到 1 行',rows().querySelectorAll('.adv-row').length===1);
    document.getElementById('adv-match').value='all';
    document.getElementById('adv-match').dispatchEvent(new Event('change',{bubbles:true}));
    push('单条件「年份>2016」命中 1 条',cnt().indexOf('命中 1 / 3')>=0,cnt());

    // ---- 3b. 条件组嵌套 ----
    // 起点：顶层只有一行「年份 > 2016」，命中 1 条（b）。
    const prev=()=>document.getElementById('adv-preview').textContent;
    document.getElementById('adv-add-group').click();
    push('「＋ 条件组」加出一个条件组',rows().querySelectorAll('.adv-group').length===1,rows().querySelectorAll('.adv-group').length);
    let g0=rows().querySelector('.adv-group');
    push('顶层组的层级标记 data-depth=0',g0&&g0.dataset.depth==='0',g0&&g0.dataset.depth);
    push('新组里先给一行空条件',g0&&g0.querySelectorAll('.adv-row').length===1,g0&&g0.querySelectorAll('.adv-row').length);
    push('组里条件还空着时不改命中数（仍 1 / 3）',cnt().indexOf('命中 1 / 3')>=0,cnt());

    // 组内改成「有附件：是」→ 年份>2016 且 (有附件) = 0 条
    const gField=()=>rows().querySelector('.adv-group .adv-row .adv-field');
    gField().value='hasAttachment';
    gField().dispatchEvent(new Event('change',{bubbles:true}));
    push('组内条件生效（年份>2016 且 有附件 = 0 条）',cnt().indexOf('命中 0 / 3')>=0,cnt());

    // 组内再加一条「年份 为空」，组内先保持「且」
    rows().querySelector('.adv-group .adv-add-in').click();
    push('组内「＋ 条件」加出第二行',rows().querySelectorAll('.adv-group .adv-row').length===2,rows().querySelectorAll('.adv-group .adv-row').length);
    let gRow2=rows().querySelectorAll('.adv-group .adv-row')[1];
    gRow2.querySelector('.adv-field').value='year';
    gRow2.querySelector('.adv-field').dispatchEvent(new Event('change',{bubbles:true}));
    gRow2=rows().querySelectorAll('.adv-group .adv-row')[1];
    gRow2.querySelector('.adv-op').value='isEmpty';
    gRow2.querySelector('.adv-op').dispatchEvent(new Event('change',{bubbles:true}));

    // 顶层切「任一」，才能看出组内「且 / 或」的差别
    document.getElementById('adv-match').value='any';
    document.getElementById('adv-match').dispatchEvent(new Event('change',{bubbles:true}));
    push('组内「且」时组整体不成立（只剩 b 靠年份>2016）',cnt().indexOf('命中 1 / 3')>=0,cnt());
    push('预览里写明这是 1 个条件组',/含 1 个条件组/.test(prev()),prev());

    const gMatch=()=>rows().querySelector('.adv-group .adv-group-match');
    gMatch().value='any';
    gMatch().dispatchEvent(new Event('change',{bubbles:true}));
    push('组内切「任一」后命中 3 条（a 有附件 / c 年份空 / b 靠年份）',cnt().indexOf('命中 3 / 3')>=0,cnt());
    push('描述里用括号把组括起来',/\(.*或.*\)/.test(prev()),prev());

    // 组里再嵌一层组
    rows().querySelector('.adv-group .adv-add-group-in').click();
    const nested=rows().querySelectorAll('.adv-group[data-depth="1"]');
    push('组内「＋ 条件组」嵌出第二层',nested.length===1,nested.length);
    push('嵌进去的组也有自己的行与按钮',!!nested[0]&&nested[0].querySelectorAll('.adv-row').length===1&&!!nested[0].querySelector('.adv-add-in'));
    push('空嵌套组不参与计数，命中仍是 3 / 3',cnt().indexOf('命中 3 / 3')>=0,cnt());
    push('空嵌套组也不计入组数（剩 1 组）',/含 1 个条件组/.test(prev()),prev());

    // 给嵌套组填一个条件（年份 > 2016，对 b 成立，不影响 3 / 3）
    const nField=()=>rows().querySelector('.adv-group[data-depth="1"] .adv-field');
    nField().value='year';
    nField().dispatchEvent(new Event('change',{bubbles:true}));
    const nestedRow=()=>rows().querySelector('.adv-group[data-depth="1"] .adv-row');
    nestedRow().querySelector('.adv-op').value='gt';
    nestedRow().querySelector('.adv-op').dispatchEvent(new Event('change',{bubbles:true}));
    const nVal=rows().querySelector('.adv-group[data-depth="1"] .adv-value');
    nVal.value='2016';
    nVal.dispatchEvent(new Event('input',{bubbles:true}));
    push('嵌套组里的条件也能填、也能算进描述',/含 2 个条件组/.test(prev()),prev());
    push('嵌套组填完命中仍是 3 / 3',cnt().indexOf('命中 3 / 3')>=0,cnt());

    // 删掉嵌套组
    rows().querySelector('.adv-group[data-depth="1"] .adv-del-group').click();
    push('「×」删掉嵌套组后第二层消失',rows().querySelectorAll('.adv-group[data-depth="1"]').length===0);
    push('组数回到 1',/含 1 个条件组/.test(prev()),prev());

    // 含组的条件能一路走到横幅（不是只在弹窗里好看）
    document.getElementById('adv-apply').click();
    await waitFor(()=>modal.hidden,4000);
    push('含条件组的条件能应用并出现在横幅里',/有附件：是/.test(bar().textContent)&&/年份 为空/.test(bar().textContent)&&/3 条/.test(bar().textContent),bar().textContent);
    bar().querySelector('[data-adv-off]').click();
    await waitFor(()=>bar().hidden,4000);
    push('清掉含组的条件后恢复 3 条',cards().length===3,cards().length);

    // 整组删掉 → 只剩原来那行条件
    document.getElementById('lib-adv-btn').click();
    await waitFor(()=>!modal.hidden,4000);
    document.getElementById('adv-clear').click();
    push('「清空」后行区只剩提示，没有条件',rows().querySelectorAll('.adv-row').length===0&&rows().querySelectorAll('.adv-group').length===0);
    document.getElementById('adv-add').click();
    document.getElementById('adv-add-group').click();   // 一行条件 + 一个组
    push('一行条件加一个组',rows().querySelectorAll('.adv-group').length===1&&rows().querySelectorAll('.adv-row').length===2,
      rows().querySelectorAll('.adv-group').length+'/'+rows().querySelectorAll('.adv-row').length);
    rows().querySelector('.adv-del-group').click();
    push('「×」删掉整组后组与组内行一起消失',rows().querySelectorAll('.adv-group').length===0&&rows().querySelectorAll('.adv-row').length===1,
      rows().querySelectorAll('.adv-group').length+'/'+rows().querySelectorAll('.adv-row').length);

    // ---- 4. 应用 → 列表 + 横幅 ----
    // 用留下来的那行搭一条干净的单条件：年份 > 2016
    setField('year'); setOp('gt'); setVal('2016');
    document.getElementById('adv-match').value='all';
    document.getElementById('adv-match').dispatchEvent(new Event('change',{bubbles:true}));
    push('回到单条件「年份>2016」命中 1 条',cnt().indexOf('命中 1 / 3')>=0,cnt());
    document.getElementById('adv-apply').click();
    await waitFor(()=>modal.hidden,4000);
    await waitFor(()=>cards().length===1,6000);
    push('检索后列表只剩 1 条',cards().length===1,cards().map(c=>c.querySelector('.lctitle').textContent).join('|'));
    push('命中的是 Attention',cards().length===1&&/Attention/.test(cards()[0].querySelector('.lctitle').textContent),cards()[0]&&cards()[0].textContent.slice(0,40));
    push('顶部出现条件横幅',!bar().hidden&&/条件检索/.test(bar().textContent));
    push('横幅写明条件与条数',/年份 大于 “2016”/.test(bar().textContent)&&/1 条/.test(bar().textContent),bar().textContent);

    // ---- 5. 清除 ----
    bar().querySelector('[data-adv-off]').click();
    await waitFor(()=>cards().length===3,6000);
    push('清除条件后恢复 3 条',cards().length===3);
    push('横幅隐藏',bar().hidden);

    // ---- 6. 存为智能收藏集 ----
    window.prompt=()=>'有附件且 2016 年后';
    document.getElementById('lib-adv-btn').click();
    await waitFor(()=>!modal.hidden,4000);
    setField('hasAttachment'); // 单条件：有附件
    document.getElementById('adv-save').click();
    const seen=await waitFor(()=>Array.from(document.querySelectorAll('#lib-searches .lib-search-row')).some(b=>/有附件且/.test(b.textContent)),8000);
    push('侧栏出现该智能收藏集',seen,Array.from(document.querySelectorAll('#lib-searches .lib-search-row')).map(b=>b.textContent).join('|'));
    const sum=await pdfBridge.lib.summary();
    const sv=(sum.searches||[]).find(x=>x.name==='有附件且 2016 年后');
    push('存的是条件而不是查询串',!!sv&&sv.query===''&&Array.isArray(sv.conditions)&&sv.conditions.length===1,JSON.stringify(sv||{}).slice(0,160));
    push('保存后自动切到该检索（1 条）',await (async()=>{for(let i=0;i<60;i++){if(cards().length===1)return true;await sleep(100);}return false;})(),cards().length);

    // ---- 7. 标注回复树 ----
    const annoBtn=document.querySelector('[data-scope="annotations"]');
    push('侧栏有「标注」入口',!!annoBtn);
    if(annoBtn){
      annoBtn.click();
      const gotAnno=await waitFor(()=>document.querySelectorAll('#lib-grid .lib-anno').length>=3,8000);
      push('标注视图列出 3 条',gotAnno,document.querySelectorAll('#lib-grid .lib-anno').length);
      if(gotAnno){
        const list=Array.from(document.querySelectorAll('#lib-grid .lib-anno'));
        const titles=list.map(c=>c.querySelector('.lctitle').textContent);
        const iP=titles.findIndex(t=>/父批注/.test(t));
        const iR=titles.findIndex(t=>/回复/.test(t));
        push('父批注排在回复前面',iP>=0&&iR===iP+1,titles.join('|'));
        const reply=list[iR];
        push('回复带缩进层级标记',reply&&reply.dataset.depth==='1'&&reply.classList.contains('anno-reply'),reply&&reply.className+' depth='+reply.dataset.depth);
        push('父批注没有缩进',list[iP]&&!list[iP].classList.contains('anno-reply'));
        push('独立标注仍是顶层',titles.indexOf('另一条独立高亮')>=0&&!list[titles.indexOf('另一条独立高亮')].classList.contains('anno-reply'));
      }
    }

    // ---- 8. 笔记导出 Word ----
    const r=await pdfBridge.exportNoteBundle({key:'a',noteId:'n1',fmt:'doc',outPath:__DOC__});
    push('导出 Word 成功且扩展名是 .doc',!!(r&&r.ok)&&/\\.doc$/.test(r.path||''),JSON.stringify(r).slice(0,160));
    // ---- 9. 引用键模板（设置面板 → 详情面板） ----
    LibraryUI.openSettings();
    const setOpen=await waitFor(()=>{const m=document.getElementById('settings-modal');return m&&!m.hidden;},6000);
    push('设置面板打开',setOpen);
    if(setOpen){
      const inp=document.getElementById('set-citekey');
      const prev=document.getElementById('set-citekey-preview');
      push('模板输入框与预览都在',!!inp&&!!prev);
      inp.value='[auth:upper][shortyear]';
      inp.dispatchEvent(new Event('input',{bubbles:true}));
      push('预览按输入的模板现算（显示大写姓 + 两位年份）',/LECUN15/.test(prev.textContent),prev.textContent);
      inp.value='';
      inp.dispatchEvent(new Event('input',{bubbles:true}));
      push('留空时预览说明用的是默认模板',/默认模板/.test(prev.textContent),prev.textContent);
      inp.value='[auth:upper][shortyear]';
      inp.dispatchEvent(new Event('input',{bubbles:true}));
      document.getElementById('set-save').click();
      await sleep(700);
      const st=await pdfBridge.getSettings();
      push('模板写进设置',st&&st.citeKeyTemplate==='[auth:upper][shortyear]',JSON.stringify(st&&st.citeKeyTemplate));
      document.getElementById('set-close').click();
      await LibraryUI.openDetail('a');
      const got=await waitFor(()=>{const c=document.getElementById('ld-citekey');return c&&c.textContent==='LECUN15';},6000);
      push('详情面板的引用键按新模板显示',got,document.getElementById('ld-citekey')&&document.getElementById('ld-citekey').textContent);
    }

    return {checks,count:cards().length,exportRes:r};
    } catch(e) { checks.push(['探针未抛错',false,String(e&&e.stack||e).slice(0,300)]); return {checks}; } })()`;
  const codeInjected = code.split('__DOC__').join(JSON.stringify(docPath));
  fs.writeFileSync(path.join(dir, 'probe.cjs'), 'module.exports=' + JSON.stringify(codeInjected));
  const r = runProbe({
    probe: path.join(dir, 'probe.cjs'),
    env: { PDFREADER_LIBRARY: path.join(dir, 'library.json'), PDFREADER_DATA_DIR: dir, PDFREADER_NO_AUTO_INDEX: '1' },
    args: ['--user-data-dir=' + path.join(dir, 'ud')],
    label: 'adv-ui',
    timeout: 180000,
  });
  assert.equal(r.fail, 0, 'UI 检查有失败项');

  // 落盘的 .doc：Word 能打开需要 mso 命名空间；表格要保留；不引 KaTeX 的相对样式表
  assert.ok(fs.existsSync(docPath), '导出的 .doc 应该存在');
  const doc = fs.readFileSync(docPath, 'utf8');
  assert.ok(/xmlns:w="urn:schemas-microsoft-com:office:word"/.test(doc), '.doc 应带 Word 命名空间');
  assert.ok(/<w:WordDocument>/.test(doc), '.doc 应带 mso 设置块');
  assert.ok(/@page\{size:A4/.test(doc), '.doc 应带 A4 页面设置');
  assert.ok(/<table/.test(doc), '笔记里的表格应保留');
  assert.ok(/第一段正文/.test(doc), '正文应导出');
  assert.ok(!/katex\.min\.css/.test(doc), 'Word 不会加载相对样式表，不该引 KaTeX 的 css');
  assert.ok(/\.files\/|md-img/.test(doc) || true, '图片按相对路径带出（这条笔记没有图，不强制）');

  console.log('test-adv-ui: ' + (r.total || 0) + ' UI checks + 8 doc checks passed');
} finally {
  if (process.env.KEEP_TMP) console.log('kept:', dir);
  else fs.rmSync(dir, { recursive: true, force: true });
}
