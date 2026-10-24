'use strict';
/*
 * 二次核查回归（2026-10-24）：
 *   N02 富文本子笔记导出以 html 为源（标题 / 加粗 / 来源链接保真，不用检索纯文本）；
 *   N03 截图字段缺失时正文出现可见「[图片缺失：…]」，纯截图全缺失不再是无提示空白页；
 *   N04 链接查询参数单次转义（markdown.js 渲染层 + 导出 href）。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runProbe } = require('./probe-runner');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-n02-n04-'));
  try {
    const ud = path.join(dir, 'ud');
    fs.mkdirSync(ud, { recursive: true });
    fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify({ version: 8, items: [
      // N02：富文本子笔记——html 有结构，text 是检索纯文本（旧逻辑会用 text 导出丢结构）
      { key: 'd2', title: 'N02 rich note', notes: [{ id: 'nr', title: '研究笔记', html: '<h2>研究方法</h2><p><strong>重要结论</strong> 见 <a href="https://example.org/source">来源</a></p>', text: '研究方法 重要结论 见 来源' }] },
      // N03：纯截图笔记，截图文件缺失
      { key: 'd3', title: 'N03 pure missing', notes: [{ id: 'np', title: '', text: '', image: 'snapshots/deleted.png' }] },
      // N03：有正文 + 缺失截图字段
      { key: 'd4', title: 'N04 text missing shot', notes: [{ id: 'nm', title: '', text: '有正文的笔记', image: 'snapshots/also-deleted.png' }] },
      // N04：带查询参数的链接
      { key: 'd5', title: 'N05 query link', notes: [{ id: 'nq', title: '', text: '[source](https://example.org/?a=1&b=2)' }] },
    ] }));
    const fwd = dir.replace(/\\/g, '/');
    const code = `(async()=>{
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    const checks=[];const push=(n,v,d)=>checks.push([n,!!v,d===undefined?'':String(d)]);
    const waitFor=async(fn,ms)=>{const t0=Date.now();while(Date.now()-t0<(ms||8000)){if(fn())return true;await sleep(60);}return !!fn();};
    const libReady=await waitFor(()=>window.LibraryUI&&LibraryUI.isOpen()&&document.querySelectorAll('#lib-grid .lib-card').length===4,10000);
    push('文献库就绪',libReady);
    if(!libReady)return {checks};
    // N04：渲染层——data-md-link 解码后必须是真实 URL（b=2，不是 amp;b）
    const linkHtml=window.Md.render('[source](https://example.org/?a=1&b=2)');
    const m=/data-md-link="([^"]*)"/.exec(linkHtml);
    const decoded=m?m[1].replace(/&amp;/g,'&'):'';
    push('渲染层链接单次转义',decoded==='https://example.org/?a=1&b=2',decoded);
    push('渲染层参数可解析',decoded.split('?')[1]&&new URLSearchParams(decoded.split('?')[1]).get('b')==='2',decoded);
    // N02：富文本 html 源导出（outPath 旁路对话框）
    const r2md=await pdfBridge.exportNoteBundle({key:'d2',noteId:'nr',fmt:'md',outPath:'${fwd}/rich.md'});
    push('N02 MD 导出成功',r2md&&r2md.ok===true,JSON.stringify(r2md));
    const r2html=await pdfBridge.exportNoteBundle({key:'d2',noteId:'nr',fmt:'html',outPath:'${fwd}/rich.html'});
    push('N02 HTML 导出成功',r2html&&r2html.ok===true,JSON.stringify(r2html));
    // N03：缺失截图
    const r3=await pdfBridge.exportNoteBundle({key:'d3',noteId:'np',fmt:'html',outPath:'${fwd}/pure-missing.html'});
    push('N03 纯截图缺失仍导出且计数',r3&&r3.ok===true&&r3.images===0&&r3.skipped===1,JSON.stringify(r3));
    const r3md=await pdfBridge.exportNoteBundle({key:'d3',noteId:'np',fmt:'md',outPath:'${fwd}/pure-missing.md'});
    push('N03 MD 保留缺失引用',r3md&&r3md.ok===true&&r3md.skipped===1,JSON.stringify(r3md));
    const r4=await pdfBridge.exportNoteBundle({key:'d4',noteId:'nm',fmt:'html',outPath:'${fwd}/text-missing.html'});
    push('N03 有正文+缺失截图',r4&&r4.ok===true&&r4.skipped===1,JSON.stringify(r4));
    // N04：导出 href
    const r5=await pdfBridge.exportNoteBundle({key:'d5',noteId:'nq',fmt:'html',outPath:'${fwd}/query.html'});
    push('N04 导出成功',r5&&r5.ok===true,JSON.stringify(r5));
    return {checks};})()`;
    fs.writeFileSync(path.join(dir, 'probe.cjs'), 'module.exports=' + JSON.stringify(code));
    const r = runProbe({
      probe: path.join(dir, 'probe.cjs'),
      env: { PDFREADER_LIBRARY: path.join(dir, 'library.json'), PDFREADER_DATA_DIR: dir, PDFREADER_NO_AUTO_INDEX: '1' },
      args: ['--user-data-dir=' + ud],
      label: 'n02-n04-note-content',
    });
    assert.equal(r.fail, 0);

    // ---------- Node 侧产物核对 ----------
    // N02：结构与链接保真（不用检索纯文本）
    const md = fs.readFileSync(path.join(dir, 'rich.md'), 'utf8');
    assert.ok(md.includes('## 研究方法'), 'N02 MD 保留标题');
    assert.ok(md.includes('**重要结论**'), 'N02 MD 保留加粗');
    assert.ok(md.includes('](https://example.org/source)'), 'N02 MD 保留来源链接');
    const html = fs.readFileSync(path.join(dir, 'rich.html'), 'utf8');
    assert.ok(/<h2/.test(html), 'N02 HTML 保留标题标签');
    assert.ok(/<strong>/.test(html), 'N02 HTML 保留加粗标签');
    assert.ok(html.includes('href="https://example.org/source"'), 'N02 HTML 链接可点');
    // N03：可见缺失标注，不是空白页
    const pureHtml = fs.readFileSync(path.join(dir, 'pure-missing.html'), 'utf8');
    assert.ok(pureHtml.includes('[图片缺失：snapshots/deleted.png]'), 'N03 纯截图缺失有可见占位');
    const pureMd = fs.readFileSync(path.join(dir, 'pure-missing.md'), 'utf8');
    assert.ok(pureMd.includes('](snapshots/deleted.png)'), 'N03 MD 保留缺失截图引用');
    const textHtml = fs.readFileSync(path.join(dir, 'text-missing.html'), 'utf8');
    assert.ok(textHtml.includes('有正文的笔记') && textHtml.includes('[图片缺失：snapshots/also-deleted.png]'), 'N03 正文与缺失标注共存');
    // N04：href 单次转义，参数可解析
    const queryHtml = fs.readFileSync(path.join(dir, 'query.html'), 'utf8');
    assert.ok(queryHtml.includes('href="https://example.org/?a=1&amp;b=2"'), 'N04 href 单次转义');
    assert.ok(!queryHtml.includes('amp;amp'), 'N04 无双重转义');
    const decoded = queryHtml.match(/href="([^"]*)"/)[1].replace(/&amp;/g, '&');
    assert.equal(new URLSearchParams(decoded.split('?')[1]).get('b'), '2', 'N04 解码后 b=2');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(3); });
