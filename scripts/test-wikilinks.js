'use strict';
/*
 * 独立笔记双向链接回归：
 *   Node 侧：markdown.js 把 [[标题]] 渲染成 data-wikilink 占位；[[x]](y) 不被普通链接
 *            正则先吃掉；plain 摘要只留标题。
 *   Electron 侧：三条独立笔记（A 引 [[B]] 和 [[不存在的笔记]]；B 无链接；C 引 [[A]]）——
 *            A 的预览有两个 wikilink 占位；A 的预览末尾出现「反向链接 · C」；
 *            点 [[B]] 编辑器切到 B；B 的预览末尾出现反向链接 A；点反链回到 A；
 *            点不存在的链接留在当前笔记并提示。
 * 运行：node scripts/test-wikilinks.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Md = require('../src/markdown.js');
const { runProbe } = require('./probe-runner');

// ---------- A. Node 纯解析 ----------
(function nodePart() {
  const h = Md.render('见 [[深度学习笔记]] 和 [[B]]。');
  assert.ok(h.includes('class="md-wikilink" data-wikilink="深度学习笔记"'), 'wikilink 占位: ' + h);
  assert.ok(!h.includes('md-link"'), '不被普通链接正则吃掉');
  // 普通链接与 wikilink 并存
  const mix = Md.render('[外链](https://a.b) 和 [[笔记]]');
  assert.ok(mix.includes('data-md-link="https://a.b"') && mix.includes('data-wikilink="笔记"'), '两种链接并存');
  // 未配对的单括号不受影响
  const single = Md.render('这是 [普通方括号] 不是链接');
  assert.ok(!single.includes('md-wikilink'), '单括号不误判');
  assert.equal(Md.plain('见 [[笔记A]] 完成', 50), '见 笔记A 完成', 'plain 只留标题');
  console.log('[wikilinks-node] PASS');
})();

// ---------- B. Electron 端到端 ----------
let code = 0;
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-wiki-'));
  const ud = path.join(tmp, 'ud');
  fs.mkdirSync(ud);
  try {
    fs.writeFileSync(path.join(tmp, 'library.json'), JSON.stringify({ version: 8, items: [
      { key: 'nA', itemType: 'note', title: '笔记A', notes: [{ id: 'na', title: '', text: '读到了 [[笔记B]] 这一章，另外参见 [[不存在的笔记]]。' }] },
      { key: 'nB', itemType: 'note', title: '笔记B', notes: [{ id: 'nb', title: '', text: '这章讲方法，没有外链。' }] },
      { key: 'nC', itemType: 'note', title: '笔记C', notes: [{ id: 'nc', title: '', text: '背景见 [[笔记A]]。' }] },
      { key: 'nD', itemType: 'journalArticle', title: '普通条目（有附件，不是独立笔记）', notes: [{ id: 'nd', title: '', text: '正文提到 [[笔记A]] 但这是子笔记不算。' }], attachment: { path: 'C:/x/a.pdf', name: 'a.pdf' } },
    ] }));
    const probe = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 10000)) { if (await fn()) return true; await sleep(60); } return !!(await fn()); };
  const libReady = await waitFor(() => window.LibraryUI && LibraryUI.isOpen() && document.querySelectorAll('#lib-grid .lib-card').length >= 3, 10000);
  push('文献库就绪', libReady);
  if (!libReady) return { checks };

  const open = async (sel) => {
    document.querySelector(sel).click();
    await waitFor(() => !document.getElementById('note-view').hidden, 6000);
    await sleep(500);   // 预览去抖 350ms
  };
  const curTitle = () => document.getElementById('nv-title').value;
  const pv = () => document.getElementById('nv-preview');

  // 1) 打开笔记A：预览有 2 个 wikilink 占位，末尾有反向链接（笔记C）
  await open('[data-open-note="nA"]');
  push('A 打开', curTitle() === '笔记A', curTitle());
  push('A 预览 2 个 wikilink', pv().querySelectorAll('.md-wikilink').length === 2, pv().querySelectorAll('.md-wikilink').length);
  const bl = pv().querySelector('.nv-backlinks');
  push('A 有反向链接区', !!bl);
  push('反向链接指向笔记C', !!(bl && bl.querySelector('[data-bl-open="nC"]')), bl && bl.textContent);

  // 2) 点 [[笔记B]] → 编辑器切到 B
  const wls = Array.from(pv().querySelectorAll('.md-wikilink'));
  wls.find((x) => x.dataset.wikilink === '笔记B').click();
  await waitFor(() => curTitle() === '笔记B', 5000);
  push('点 wikilink 切到 B', curTitle() === '笔记B', curTitle());
  // 3) B 的正文没有链到别人；反向链接区应列出 A（A 引了 B）
  push('B 的反向链接是 A', !!(pv().querySelector('.nv-backlinks') && pv().querySelector('[data-bl-open="nA"]')), pv().querySelector('.nv-backlinks') && pv().querySelector('.nv-backlinks').textContent);

  // 4) 点反链回到 A
  const blBtn = pv().querySelector('[data-bl-open="nA"]');
  blBtn.click();
  await waitFor(() => curTitle() === '笔记A', 5000);
  push('点反链回到 A', curTitle() === '笔记A', curTitle());

  // 5) 点不存在的笔记：留在 A，弹出提示
  const bad = Array.from(pv().querySelectorAll('.md-wikilink')).find((x) => x.dataset.wikilink === '不存在的笔记');
  bad.click();
  await sleep(600);
  push('不存在的链接留在 A', curTitle() === '笔记A', curTitle());
  const toast = document.querySelector('.toast, #toast');
  push('有提示', !!toast && toast.textContent.includes('不存在的笔记'), toast && toast.textContent);
  return { checks };
})()`;
    const probeFile = path.join(tmp, 'probe.cjs');
    fs.writeFileSync(probeFile, 'module.exports=' + JSON.stringify(probe));
    const r = runProbe({
      probe: probeFile,
      env: { PDFREADER_LIBRARY: path.join(tmp, 'library.json'), PDFREADER_DATA_DIR: tmp, PDFREADER_NO_AUTO_INDEX: '1' },
      args: ['--user-data-dir=' + ud],
      label: 'wikilinks',
      timeout: 240000,
    });
    assert.equal(r.fail, 0);
    code = 0;
  } catch (e) {
    console.error('[wikilinks] ERROR', e && e.message ? e.message : e);
    code = 3;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(code);
})();
