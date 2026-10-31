'use strict';
/*
 * 文内引注（in-text citation with locator）回归：
 *   Node 侧：cite.js 的 citeInText——编号制 [n] / [n, p. X]（定位符在括号内）、
 *            作者-年份 (Surname, 2020, p. X)、两作者 A & B、三作者 et al.、
 *            无作者用标题、无年份 n.d.、MLA 特殊格式、CSL 数字样式、中文作者。
 *   Electron 侧：详情面板「文内引注…」展开定位符行，输入定位符预览联动，
 *            复制到剪贴板；编号取当前可见列表位次。
 * 运行：node scripts/test-atc-citation.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Cite = require('../src/cite.js');
const { runProbe } = require('./probe-runner');

// ---------- A. Node 纯逻辑 ----------
(function nodePart() {
  const one = { itemType: 'journalArticle', title: 'Solo Work', year: '2019', creators: [{ lastName: 'Smith', firstName: 'John', creatorType: 'author' }] };
  const two = { itemType: 'journalArticle', title: 'Duo', year: '2020', creators: [{ lastName: 'Smith', firstName: 'J', creatorType: 'author' }, { lastName: 'Lee', firstName: 'A', creatorType: 'author' }] };
  const three = { itemType: 'journalArticle', title: 'Trio', year: '2021', creators: [{ lastName: 'Smith', firstName: 'J', creatorType: 'author' }, { lastName: 'Lee', firstName: 'A', creatorType: 'author' }, { lastName: 'Wang', firstName: 'W', creatorType: 'author' }] };
  const noAuthor = { itemType: 'document', title: 'Anonymous Report', year: '', creators: [] };
  const cjk = { itemType: 'journalArticle', title: '中文', year: '2022', creators: [{ lastName: '王', firstName: '小明', creatorType: 'author' }] };

  assert.equal(Cite.citeInText(one, { style: 'gbt7714', num: 3 }), '[3]', '编号制无定位符');
  assert.equal(Cite.citeInText(one, { style: 'gbt7714', num: 3, locator: 'p. 5' }), '[3, p. 5]', '编号制定位符进括号');
  assert.equal(Cite.citeInText(one, { style: 'ieee', num: 12, locator: 'p. 5' }), '[12, p. 5]', 'IEEE 同规则');
  assert.equal(Cite.citeInText(one, { style: 'apa', locator: 'p. 5' }), '(Smith, 2019, p. 5)', 'APA 作者-年份+定位符');
  assert.equal(Cite.citeInText(one, { style: 'apa' }), '(Smith, 2019)', 'APA 无定位符');
  assert.equal(Cite.citeInText(two, { style: 'apa' }), '(Smith & Lee, 2020)', '两作者 A & B');
  assert.equal(Cite.citeInText(three, { style: 'chicago', locator: 'ch. 2' }), '(Smith et al., 2021, ch. 2)', '三作者 et al.');
  assert.equal(Cite.citeInText(noAuthor, { style: 'apa' }), '(Anonymous Report, n.d.)', '无作者用标题 + n.d.');
  assert.equal(Cite.citeInText(cjk, { style: 'apa' }), '(王, 2022)', '中文作者原样');
  assert.equal(Cite.citeInText(one, { style: 'mla', locator: 'p. 5' }), '(Smith p. 5)', 'MLA 无年份逗号');
  // CSL 数字样式走同一编号规则
  const info = Cite.styleList().find((x) => x.id.startsWith('csl:') && x.numeric);
  if (info) assert.equal(Cite.citeInText(one, { style: info.id, num: 7 }), '[7]', 'CSL 数字样式');
  // 非作者角色（editor）不进文内引注
  const ed = { itemType: 'book', title: 'Edited Vol', year: '2000', creators: [{ lastName: 'Editor', firstName: 'Ed', creatorType: 'editor' }, { lastName: 'Writer', firstName: 'W', creatorType: 'author' }] };
  assert.equal(Cite.citeInText(ed, { style: 'apa' }), '(Writer, 2000)', 'editor 不算正文作者');
  console.log('[atc-node] PASS');
})();

// ---------- B. Electron UI ----------
let code = 0;
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-atc-'));
  const ud = path.join(tmp, 'ud');
  fs.mkdirSync(ud);
  try {
    fs.writeFileSync(path.join(tmp, 'library.json'), JSON.stringify({ version: 8, items: [
      { key: 'a', itemType: 'journalArticle', title: 'First Paper', year: '2024', publication: 'Nature', volume: '12', pages: '1-9', created: 100, creators: [{ firstName: 'John', lastName: 'Smith', creatorType: 'author' }] },
      { key: 'b', itemType: 'journalArticle', title: 'Second Paper', year: '2023', created: 200, creators: [{ firstName: 'Lei', lastName: 'Wang', creatorType: 'author' }] },
    ] }));
    const probe = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 10000)) { if (await fn()) return true; await sleep(60); } return !!(await fn()); };
  const libReady = await waitFor(() => window.LibraryUI && LibraryUI.isOpen() && document.querySelectorAll('#lib-grid .lib-card').length === 2, 10000);
  push('文献库就绪', libReady);
  push('Cite.citeInText 挂载', !!(window.Cite && Cite.citeInText));
  if (!libReady) return { checks };
  // 打开第一条（列表第 1 位 → 编号 1）
  LibraryUI.openDetail('a');
  await waitFor(() => { const p = document.getElementById('ld-cite-preview'); return p && p.textContent.includes('Smith'); }, 8000);
  push('详情打开且引用预览有值', !!(document.getElementById('ld-cite-preview').textContent));
  // 展开定位符行（默认样式 GB/T 7714 是数字制）
  document.getElementById('ld-atc-btn').click();
  push('定位符行展开', document.getElementById('ld-atc-row').hidden === false);
  const inp = document.getElementById('ld-atc-locator');
  inp.value = 'p. 12';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(150);
  const pv = document.getElementById('ld-atc-preview');
  // （探针是模板字符串：正则的反斜杠会被吃掉，这里用普通字符串判断）
  const tAtc = pv.textContent;
  push('数字制定位符进括号', tAtc.startsWith('[') && tAtc.endsWith(']') && tAtc.indexOf('p. 12') >= 0, JSON.stringify(tAtc));
  const numA = pv.textContent.slice(1, pv.textContent.indexOf(','));
  // 切到 APA：作者-年份 + 定位符
  const styleSel = document.getElementById('ld-cite-style');
  styleSel.value = 'apa';
  styleSel.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(150);
  push('APA 作者-年份+定位符', document.getElementById('ld-atc-preview').textContent === '(Smith, 2024, p. 12)', document.getElementById('ld-atc-preview').textContent);
  // 引注体：脚注体（完整）与同上 / 前引（没有上次引用时退到完整）
  const formSel = document.getElementById('ld-atc-form');
  push('引注体下拉存在且默认文内', !!formSel && formSel.value === 'intext');
  formSel.value = 'note';
  formSel.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(150);
  const noteText = document.getElementById('ld-atc-preview').textContent;
  push('脚注体预览含题名与斜体刊名',
    noteText.indexOf('“First Paper.”') >= 0 && noteText.indexOf('*') >= 0, noteText);
  formSel.value = 'ibid';
  formSel.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(150);
  const ibidText = document.getElementById('ld-atc-preview').textContent;
  push('没有上次引注时同上退到完整引注', ibidText === noteText, ibidText);
  formSel.value = 'intext';
  formSel.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(150);
  // 复制（剪贴板在无头环境可能不可用：不强制断言成功，按钮可点即可）
  document.getElementById('ld-atc-copy').click();
  await sleep(200);
  push('复制按钮可点', !!document.getElementById('ld-atc-copy'));

  // v1.6：前引要认「之前引过没有」，不能只记上一条（R-v1.6-06）
  // 先把剪贴板换成可用的桩，复制链路才走得通
  try {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => {} }, configurable: true });
  } catch (_) {}
  formSel.value = 'ibid';
  formSel.dispatchEvent(new Event('change', { bubbles: true }));
  const pv2 = () => document.getElementById('ld-atc-preview').textContent;
  await sleep(120);
  // A：历史为空 → 完整引注
  push('A 首次是完整引注', /^Smith, John\\./.test(pv2()), pv2());
  document.getElementById('ld-atc-copy').click();
  await sleep(250);
  // B：没引过 → 完整引注
  LibraryUI.openDetail('b');
  await waitFor(() => { const p = document.getElementById('ld-atc-preview'); return p && p.textContent.includes('Wang'); }, 8000);
  formSel.value = 'ibid';
  formSel.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(200);
  push('B 首次也是完整引注', /^Wang, Lei\\./.test(pv2()), pv2());
  document.getElementById('ld-atc-copy').click();
  await sleep(250);
  // A 再来一次：A → B → A，应该是「前引」而不是完整引注
  LibraryUI.openDetail('a');
  await waitFor(() => { const p = document.getElementById('ld-atc-preview'); return p && p.textContent.includes('Smith'); }, 8000);
  formSel.value = 'ibid';
  formSel.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(200);
  const back = pv2();
  push('A → B → A 出前引', back.indexOf('op. cit.') >= 0, back);
  push('前引不是完整引注', back.indexOf('“First Paper.”') < 0, back);
  document.getElementById('ld-atc-copy').click();
  await sleep(250);
  // 紧接同一条：同上
  formSel.value = 'ibid';
  formSel.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(200);
  push('紧接着再来一次是同上', pv2().indexOf('Ibid.') === 0, pv2());

  formSel.value = 'intext';
  formSel.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(150);
  // 换第二条：编号随列表位次变化（不管排序方向，两条的编号必须不同且一致）
  LibraryUI.openDetail('b');
  await waitFor(() => { const p = document.getElementById('ld-cite-preview'); return p && p.textContent.includes('Wang'); }, 8000);
  await sleep(200);
  styleSel.value = 'ieee';
  styleSel.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(150);
  const numB = document.getElementById('ld-atc-preview').textContent.slice(1, document.getElementById('ld-atc-preview').textContent.indexOf(','));
  push('两条编号不同且为正整数', numA !== numB && +numA >= 1 && +numB >= 1, numA + ' vs ' + numB);
  return { checks };
})()`;
    const probeFile = path.join(tmp, 'probe.cjs');
    fs.writeFileSync(probeFile, 'module.exports=' + JSON.stringify(probe));
    const r = runProbe({
      probe: probeFile,
      env: { PDFREADER_LIBRARY: path.join(tmp, 'library.json'), PDFREADER_DATA_DIR: tmp, PDFREADER_NO_AUTO_INDEX: '1' },
      args: ['--user-data-dir=' + ud],
      label: 'atc',
      timeout: 240000,
    });
    assert.equal(r.fail, 0);
    code = 0;
  } catch (e) {
    console.error('[atc] ERROR', e && e.message ? e.message : e);
    code = 3;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(code);
})();
