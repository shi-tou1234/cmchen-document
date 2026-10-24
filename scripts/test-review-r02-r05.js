'use strict';
/*
 * 复核修复回归（2026-10-24）：R02 模板追加 / R03 特殊文件名导出 / R04 note.image
 * 进正文与子笔记导出入口 / R05 独立 HTML 真实链接。
 * 探针覆盖 UI 行为与 IPC 返回；导出产物由 Node 侧逐字节核对。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runProbe } = require('./probe-runner');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-review-fix-'));
  try {
    const ud = path.join(dir, 'ud');
    fs.mkdirSync(path.join(ud), { recursive: true });
    fs.mkdirSync(path.join(dir, 'snapshots'));
    const png = path.join(dir, 'snapshots', 'pic-one.png');
    const shot = path.join(dir, 'snapshots', 'shot-lead.png');
    const pure = path.join(dir, 'snapshots', 'pic-pure.png');
    fs.copyFileSync(path.join(__dirname, '../assets/icon-256.png'), png);
    fs.copyFileSync(path.join(__dirname, '../assets/icon-256.png'), shot);
    fs.copyFileSync(path.join(__dirname, '../assets/icon-256.png'), pure);
    fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify({ version: 8, items: [
      // R04：截图在 image 字段、正文没有引用；正文已引用同一张图的去重场景单独一条
      { key: 'n1', itemType: 'note', title: '带图笔记', notes: [{ id: 'na', title: '', text: '正文开头\n\n![](snapshots/pic-one.png)\n\n[论文链接](https://example.org/paper)\n\n::github{repo="user/repo"}\n\n[危险链接](javascript:alert(1))', image: 'snapshots/shot-lead.png' }] },
      // R04：纯截图笔记
      { key: 'n2', itemType: 'note', title: '纯截图', notes: [{ id: 'nb', title: '', text: '', image: 'snapshots/pic-pure.png' }] },
      // R04：正文已引用 image 字段同一张图，不应重复插图
      { key: 'n4', itemType: 'note', title: '去重插图', notes: [{ id: 'nd', title: '', text: '已有\n\n![](snapshots/pic-one.png)', image: 'snapshots/pic-one.png' }] },
      // R02：模板追加用
      { key: 'n3', itemType: 'note', title: '模板笔记', notes: [{ id: 'nc', title: '', text: '' }] },
      // 文献条目 + 子笔记（带截图），R04 的详情面板入口用
      { key: 'd1', title: 'Doc with subnote', notes: [{ id: 'nsub', title: '子笔记', text: '子笔记正文', image: 'snapshots/pic-one.png' }] },
    ] }));
    const fwd = dir.replace(/\\/g, '/');
    const code = `(async()=>{
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    const checks=[];const push=(n,v,d)=>checks.push([n,!!v,d===undefined?'':String(d)]);
    const waitFor=async(fn,ms)=>{const t0=Date.now();while(Date.now()-t0<(ms||8000)){if(fn())return true;await sleep(60);}return !!fn();};
    const sel=(id,v)=>{const s=document.getElementById(id);s.value=v;s.dispatchEvent(new Event('change',{bubbles:true}));};
    const libReady=await waitFor(()=>window.LibraryUI&&LibraryUI.isOpen()&&document.querySelectorAll('#lib-grid .lib-card').length===5,10000);
    push('文献库就绪',libReady);
    if(!libReady)return {checks};
    // ---------- R02：模板真正追加到末尾，选区不被吃掉 ----------
    document.querySelector('[data-open-note="n3"]').click();
    await waitFor(()=>document.getElementById('note-view').hidden===false,5000);
    const ta=document.getElementById('nv-md');
    ta.value='开始 middle 结束';
    ta.focus();
    ta.setSelectionRange(0,2);   // 选中「开始」——修复前模板会把这段替换掉
    sel('nv-template','course');
    push('选区正文逐字保留',ta.value.startsWith('开始 middle 结束'),JSON.stringify(ta.value.slice(0,20)));
    push('模板追加在末尾',ta.value.indexOf('课程笔记：课程主题')>ta.value.indexOf('结束'),ta.value.slice(0,40));
    // 光标在中间且无选区：同样只追加
    ta.setSelectionRange(8,8);
    sel('nv-template','excerpt');
    push('光标在中间也只追加',ta.value.startsWith('开始 middle 结束')&&ta.value.indexOf('摘录汇总：主题')>ta.value.indexOf('课程笔记'),ta.value.slice(0,50));
    document.getElementById('nv-save').click();
    await sleep(600);
    const s1=await pdfBridge.lib.summary();
    const it3=s1.items.find(x=>x.key==='n3');
    push('保存后正文完整',(it3.notes[0].text||'').startsWith('开始 middle 结束'),(it3.notes[0].text||'').slice(0,30));
    document.getElementById('nv-back').click();
    await sleep(300);
    // ---------- R04：image 字段进正文；R03：特殊文件名；R05：真实链接 ----------
    // 文件名带空格 / 中文 / & / # / 括号
    const special='${fwd}/My Note & 测试 (#1).html';
    const r1=await pdfBridge.exportNoteBundle({key:'n1',noteId:'na',fmt:'html',title:'R03 导出',outPath:special});
    push('特殊文件名 HTML 导出',r1&&r1.ok===true&&r1.images===2&&r1.skipped===0,JSON.stringify(r1));
    const r1md=await pdfBridge.exportNoteBundle({key:'n1',noteId:'na',fmt:'md',title:'R03 导出',outPath:'${fwd}/My Note & 测试 (#1).md'});
    push('特殊文件名 MD 导出',r1md&&r1md.ok===true&&r1md.images===2,JSON.stringify(r1md));
    // 纯截图笔记
    const r2=await pdfBridge.exportNoteBundle({key:'n2',noteId:'nb',fmt:'html',outPath:'${fwd}/pure.html'});
    push('纯截图笔记可导出',r2&&r2.ok===true&&r2.images===1,JSON.stringify(r2));
    // 去重插图
    const r4=await pdfBridge.exportNoteBundle({key:'n4',noteId:'nd',fmt:'html',outPath:'${fwd}/dedupe.html'});
    push('同图不重复插图',r4&&r4.ok===true&&r4.images===1,JSON.stringify(r4));
    // R04：文献条目子笔记的导出入口（详情面板每条笔记一个下拉）
    document.querySelector('.lib-card[data-key="d1"] [data-detail="d1"], .lib-card[data-key="d1"]').click();
    await sleep(300);
    const expSel=document.querySelector('#ld-notes .ld-note-export');
    push('子笔记导出入口存在',!!expSel&&!!expSel.querySelector('option[value="html"]'),String(!!expSel));
    return {checks};})()`;
    fs.writeFileSync(path.join(dir, 'probe.cjs'), 'module.exports=' + JSON.stringify(code));
    const r = runProbe({
      probe: path.join(dir, 'probe.cjs'),
      env: { PDFREADER_LIBRARY: path.join(dir, 'library.json'), PDFREADER_DATA_DIR: dir, PDFREADER_NO_AUTO_INDEX: '1' },
      args: ['--user-data-dir=' + ud],
      label: 'review-r02-r05',
    });
    assert.equal(r.fail, 0);

    // ---------- Node 侧产物核对 ----------
    // R03：资源目录名已清洗，引用里没有空格 / # / & / 括号 / %
    const html = fs.readFileSync(path.join(dir, 'My Note & 测试 (#1).html'), 'utf8');
    const dirName = fs.readdirSync(dir).find((x) => x.endsWith('.files') && x.includes('My'));
    assert.ok(dirName, '清洗后的 .files 目录存在：' + fs.readdirSync(dir).join(','));
    assert.ok(!/[\s#%&()]/.test(dirName.replace('.files', '')), '目录名无特殊字符：' + dirName);
    assert.ok(html.includes('src="' + dirName + '/shot-lead.png"'), 'R04 截图进了正文：' + html.match(/src="[^"]*"/g));
    assert.ok(html.includes('src="' + dirName + '/pic-one.png"'), '正文图片改写正常');
    assert.ok(html.includes('href="https://example.org/paper" target="_blank"'), 'R05 普通链接为真实 href');
    assert.ok(html.includes('href="https://github.com/user/repo" target="_blank"'), 'R05 GitHub 卡片链接真实');
    assert.ok(!html.includes('javascript:alert'), 'R05 非法协议被拒');
    assert.ok(!html.includes('href="javascript:void(0)"'), 'R05 无残留占位链接');
    assert.ok(html.includes('md-plain-link') && html.includes('危险链接'), '非法协议降级为纯文本');
    const copied = path.join(dir, dirName, 'shot-lead.png');
    assert.ok(fs.existsSync(copied) && fs.readFileSync(copied).equals(fs.readFileSync(shot)), '截图字节一致');
    // R03 MD：目标不含空白
    const md = fs.readFileSync(path.join(dir, 'My Note & 测试 (#1).md'), 'utf8');
    assert.ok(md.includes('![批注截图](' + dirName + '/shot-lead.png)'), 'MD 截图引用带出');
    assert.ok(!/\]\([^)\s]*\s[^)]*\)/.test(md), 'MD 图片目标无空白');
    // R04 纯截图
    const pureHtml = fs.readFileSync(path.join(dir, 'pure.html'), 'utf8');
    const pureDir = fs.readdirSync(dir).find((x) => x.startsWith('pure.'));
    assert.ok(pureHtml.includes('src="pure.files/pic-pure.png"'), '纯截图进正文');
    assert.ok(fs.existsSync(path.join(dir, 'pure.files', 'pic-pure.png')), '纯截图文件已复制');
    // R04 去重：恰好一张
    const dd = fs.readFileSync(path.join(dir, 'dedupe.html'), 'utf8');
    assert.equal((dd.match(/<img /g) || []).length, 1, '同图只插一次');
    // 移到独立位置仍可解析（相对路径成立）
    const moved = path.join(dir, 'moved');
    fs.mkdirSync(moved);
    fs.renameSync(path.join(dir, dirName), path.join(moved, dirName));
    fs.renameSync(path.join(dir, 'My Note & 测试 (#1).html'), path.join(moved, 'out.html'));
    assert.ok(fs.existsSync(path.join(moved, dirName, 'pic-one.png')), '整包搬移后图片仍在');
    // R02：库里正文逐字保留（探针已断言前缀，这里核结构）
    const lib = JSON.parse(fs.readFileSync(path.join(dir, 'library.json'), 'utf8'));
    const n3 = lib.items.find((x) => x.key === 'n3').notes[0].text;
    assert.ok(n3.startsWith('开始 middle 结束') && n3.includes('课程笔记') && n3.includes('摘录汇总'), '模板两次追加均保留原文');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(3); });
