'use strict';
/*
 * 笔记公式渲染（KaTeX）回归：
 *   Node 侧：markdown.js 输出带 data-md-math 的占位；katex 模块可渲染；TroveMath 在
 *            无 window.katex 时安全跳过（对应"没拷资源"的降级路径）。
 *   Electron 侧：独立笔记编辑器预览出现 .katex 排版结果；删掉 window.katex 再渲染
 *            退回源码占位；库详情只读预览同链路；HTML 导出带公式排版 + .files/katex
 *            字体资源；Markdown 导出保留 LaTeX 源；无公式导出不携带 katex。
 * 运行：node scripts/test-math.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Md = require('../src/markdown.js');
const { runProbe } = require('./probe-runner');

// ---------- A. Node 侧 ----------
(function nodePart() {
  const katex = require('katex/dist/katex.min.js');
  assert.ok(typeof katex.renderToString === 'function', 'katex 模块可用');

  const inline = Md.render('能量 $E=mc^2$ 守恒');
  assert.ok(inline.includes('<span class="md-math" data-md-math="E=mc^2">'), '行内公式占位带源码：' + inline);
  assert.ok(inline.includes('$E=mc^2$</span>'), '行内公式保留等宽源码');

  const inlineD = Md.render('前 $$x+y$$ 后');
  assert.ok(inlineD.includes('data-md-display="1"'), '行内 $$ 标记 display');

  const block = Md.render('$$\n\\int_0^1 x^2 dx\n$$');
  assert.ok(block.includes('class="md-math-block" data-md-math="'), '块级公式占位带源码：' + block);
  assert.ok(block.includes('\\int_0^1'), '块级公式源码保留');

  // 转义源码：尖括号不能变成标签
  const evil = Md.render('$a < b > c$');
  assert.ok(evil.includes('data-md-math="a &lt; b &gt; c"'), '公式源码转义：' + evil);
  assert.ok(!/<b>/i.test(evil), '公式不注入标签');

  // TroveMath 模块文件存在且不依赖 katex 也能 require（Node 里只是拿不到 window 逻辑）
  assert.ok(fs.existsSync(path.join(__dirname, '../src/renderer/math.js')), 'renderer/math.js 存在');
  // katex 资源已被 copy 脚本拷到渲染进程目录
  const kd = path.join(__dirname, '../src/renderer/katex');
  assert.ok(fs.existsSync(path.join(kd, 'katex.min.css')), '渲染进程 katex.min.css 已拷');
  assert.ok(fs.existsSync(path.join(kd, 'katex.min.js')), '渲染进程 katex.min.js 已拷');
  assert.ok(fs.readdirSync(path.join(kd, 'fonts')).filter((f) => f.endsWith('.woff2')).length >= 10, 'woff2 字体已拷');

  console.log('[math-node] PASS');
})();

// ---------- B. Electron 侧 ----------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-math-'));
try {
  fs.mkdirSync(path.join(dir, 'ud'), { recursive: true });
  const noteText = [
    '## 公式笔记',
    '',
    '质能方程 $E=mc^2$ 很有名。',
    '',
    '$$',
    '\\int_0^1 x^2 \\, dx = \\frac{1}{3}',
    '$$',
    '',
    '错误公式 $\\notacommand{xx}$ 不应把预览弄崩。',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify({ version: 8, items: [
    { key: 'n1', itemType: 'note', title: '公式笔记', notes: [{ id: 'na', title: '', text: noteText }] },
    { key: 'n2', itemType: 'note', title: '普通笔记', notes: [{ id: 'nb', title: '', text: '没有公式的一段话。' }] },
  ] }));
  const fwd = dir.replace(/\\/g, '/');

  const code = `(async()=>{
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    const checks=[];const push=(n,v,d)=>checks.push([n,!!v,d===undefined?'':String(d)]);
    const waitFor=async(fn,ms)=>{const t0=Date.now();while(Date.now()-t0<(ms||8000)){if(fn())return true;await sleep(60);}return !!fn();};
    const libReady=await waitFor(()=>window.LibraryUI&&LibraryUI.isOpen()&&document.querySelectorAll('#lib-grid .lib-card').length===2,10000);
    push('文献库就绪',libReady);
    push('TroveMath 挂载',!!(window.TroveMath&&TroveMath.enhance));
    push('window.katex 存在',!!(window.katex&&katex.renderToString));
    if(!libReady)return {checks};
    // 1) 打开笔记编辑器，预览出现 KaTeX 排版
    document.querySelector('[data-open-note="n1"]').click();
    await waitFor(()=>document.getElementById('nv-preview').querySelector('.katex'),8000);
    const pv=document.getElementById('nv-preview');
    push('行内公式渲染成 katex',!!pv.querySelector('p .katex:not(.katex-display)'),pv.innerHTML.slice(0,80));
    push('块级公式渲染成 katex-display',!!pv.querySelector('.md-math-block .katex-display'));
    push('渲染后占位属性清除',pv.querySelector('[data-md-math]')===null);
    push('渲染计数可用',TroveMath.enhance(pv)===0);
    // 2) 删掉 katex 再触发预览：退回源码占位，不报错。之后必须还原原文，否则自动保存会
    //    把公式笔记覆盖成这一句，后面导出就对不上了。
    const ta=document.getElementById('nv-md');
    const origText=ta.value;
    const keep=window.katex;
    try{ delete window.katex; }catch(_){ window.katex=undefined; }
    ta.value='退级 $a+b$ 测试';
    ta.dispatchEvent(new Event('input',{bubbles:true}));
    await sleep(600);
    const pv2=document.getElementById('nv-preview');
    push('无 katex 时保留源码占位',!!pv2.querySelector('[data-md-math]')&&pv2.querySelector('.katex')===null);
    push('无 katex 时 enhance 安全',TroveMath.enhance(pv2)===0);
    window.katex=keep;
    ta.value=origText;
    ta.dispatchEvent(new Event('input',{bubbles:true}));
    await sleep(900);   // 等 700ms 保存去抖落盘
    // 3) 保存并关闭，回文献库
    document.getElementById('nv-back').click();
    const closed=await waitFor(()=>document.getElementById('note-view').hidden===true,5000);
    push('编辑器已关闭',closed);
    await sleep(800);   // 等列表重建结束，避免点到将被替换的卡片
    // 4) 库详情只读预览（独立笔记条目）也走公式渲染。
    //    笔记卡片单击只选中不展开详情（v9.5 约定），所以走 openDetail 入口。
    const opened = LibraryUI.openDetail('n1');
    const ldOk = await waitFor(() => {
      const n = document.getElementById('ld-notes');
      return !!(n && n.querySelector('.ld-note-md .katex'));
    }, 8000);
    const ld = document.getElementById('ld-notes');
    push('详情只读预览渲染公式', ldOk, (ld ? ld.innerHTML.slice(0, 150) : '') + '|openDetail=' + JSON.stringify(opened));
    // 5) 导出 HTML：公式进排版 + katex 资源落盘
    const r1=await pdfBridge.exportNoteBundle({key:'n1',noteId:'na',fmt:'html',title:'公式导出',outPath:'${fwd}/math-export.html'});
    push('HTML 导出成功',r1&&r1.ok===true,JSON.stringify(r1));
    push('导出报告公式数',r1&&r1.math>=3,JSON.stringify(r1));
    // 6) 无公式条目导出不带 katex
    const r2=await pdfBridge.exportNoteBundle({key:'n2',noteId:'nb',fmt:'html',title:'普通导出',outPath:'${fwd}/plain-export.html'});
    push('普通导出成功且公式数 0',r2&&r2.ok===true&&r2.math===0,JSON.stringify(r2));
    // 7) Markdown 导出保留源码
    const r3=await pdfBridge.exportNoteBundle({key:'n1',noteId:'na',fmt:'md',title:'公式MD',outPath:'${fwd}/math-export.md'});
    push('MD 导出成功',r3&&r3.ok===true,JSON.stringify(r3));
    return {checks};})()`;
  fs.writeFileSync(path.join(dir, 'probe.cjs'), 'module.exports=' + JSON.stringify(code));
  const r = runProbe({
    probe: path.join(dir, 'probe.cjs'),
    env: { PDFREADER_LIBRARY: path.join(dir, 'library.json'), PDFREADER_DATA_DIR: dir, PDFREADER_NO_AUTO_INDEX: '1' },
    args: ['--user-data-dir=' + path.join(dir, 'ud')],
    label: 'math-ui',
  });
  assert.equal(r.fail, 0);

  // ---- Node 侧核对导出产物 ----
  const html = fs.readFileSync(path.join(dir, 'math-export.html'), 'utf8');
  assert.ok(/class="katex"/.test(html), '导出 HTML 含 KaTeX 排版结果');
  assert.ok(html.includes('katex-display'), '导出 HTML 含块级公式');
  assert.ok(!html.includes('data-md-math'), '导出 HTML 不残留占位属性');
  assert.ok(html.includes('math-export.files/katex/katex.min.css'), '导出 HTML 引用携带的 katex 样式：' + (html.match(/<link[^>]*>/g) || []).join('|'));
  const kd = path.join(dir, 'math-export.files', 'katex');
  assert.ok(fs.existsSync(path.join(kd, 'katex.min.css')), 'katex css 落盘');
  const woff = fs.readdirSync(path.join(kd, 'fonts')).filter((f) => f.endsWith('.woff2'));
  assert.ok(woff.length >= 10, 'woff2 字体落盘（' + woff.length + ' 个）');

  const plain = fs.readFileSync(path.join(dir, 'plain-export.html'), 'utf8');
  assert.ok(!plain.includes('katex.min.css'), '无公式导出不引用 katex 样式');
  assert.ok(!fs.existsSync(path.join(dir, 'plain-export.files', 'katex')), '无公式导出不拷字体');

  const md = fs.readFileSync(path.join(dir, 'math-export.md'), 'utf8');
  assert.ok(md.includes('$E=mc^2$'), 'MD 导出保留行内 LaTeX 源');
  assert.ok(md.includes('\\int_0^1'), 'MD 导出保留块级 LaTeX 源');
  console.log('[math-export] PASS');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
