'use strict';
/*
 * 笔记元数据与标题样式探针（v1.6）：被 test-note-meta.js 调用。
 *
 * 要验的是「点一下就存住」，不是「界面上显示出来了」：
 * 元数据改动走的是 updateNote → publicItem 这条链路，任何一端漏字段都会表现成
 * 「关掉再打开就没了」。所以每一步都回到 summary() 从存储层读回来看。
 */
module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 8000)) { if (fn()) return true; await sleep(80); } return !!fn(); };
  const errs = [];
  window.addEventListener('error', (e) => errs.push(String(e.message || e.error)));
  let stage = 'load';
  try {

  const libReady = await waitFor(() => window.LibraryUI && LibraryUI.isOpen(), 12000);
  push('文献库已打开', libReady);
  if (!libReady) return { checks, stage };

  stage = 'new-note';
  $('#lib-new-note').click();
  push('笔记编辑器已打开', await waitFor(() => $('#note-view') && !$('#note-view').hidden, 8000));
  const md = $('#nv-md');
  if (!md) return { checks, stage: 'no-md' };

  // 写一点正文，字数才有东西可数
  md.value = '第一段正文。\\n\\n# 一个标题\\n\\n第二段，带 English words here.';
  md.dispatchEvent(new InputEvent('input', { bubbles: true }));
  await sleep(300);

  // ===== 1. 元数据面板开关 =====
  stage = 'meta-toggle';
  const panel = $('#nv-meta');
  push('元数据面板默认收起', panel && panel.hidden === true);
  $('#nv-meta-toggle').click();
  await sleep(120);
  push('点一下展开', panel && panel.hidden === false);
  push('按钮 aria-pressed 跟着变', $('#nv-meta-toggle').getAttribute('aria-pressed') === 'true');

  // ===== 2. 字数 =====
  stage = 'count';
  const countText = ($('#nv-meta-count') || {}).textContent || '';
  // 中文 13 字 + 英文 3 词，至少不该是 0 或占位符
  push('字数不是占位符', /\\d/.test(countText), countText);
  const n1 = parseInt(countText.replace(/[^0-9]/g, ''), 10) || 0;
  push('字数大于 10', n1 > 10, n1);
  md.value = md.value + '\\n\\n又加了五个汉字。';
  md.dispatchEvent(new InputEvent('input', { bubbles: true }));
  await sleep(400);
  const n2 = parseInt((($('#nv-meta-count') || {}).textContent || '0').replace(/[^0-9]/g, ''), 10) || 0;
  push('继续输入后字数变大', n2 > n1, n1 + ' -> ' + n2);

  // ===== 3. 状态写回存储层 =====
  stage = 'status';
  const stSel = $('#nv-meta-status');
  stSel.value = 'draft';
  stSel.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(700);
  const readMeta = async () => {
    const s = await window.pdfBridge.lib.summary();
    for (const it of s.items || []) {
      for (const n of it.notes || []) if (n.meta && (n.meta.status || (n.meta.tags || []).length)) return { key: it.key, meta: n.meta };
    }
    // 没有任何元数据时，退到「编辑器当前这条笔记」
    for (const it of s.items || []) {
      if ((it.notes || []).length) return { key: it.key, meta: (it.notes[0].meta || { tags: [], status: '' }) };
    }
    return null;
  };
  const m1 = await readMeta();
  push('状态落库', m1 && m1.meta.status === 'draft', JSON.stringify(m1 && m1.meta));

  // ===== 4. 标签增删 =====
  stage = 'tags';
  const tagInput = $('#nv-meta-tag-input');
  tagInput.value = '方法论';
  tagInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await sleep(700);
  tagInput.value = '待核实';
  tagInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await sleep(700);
  const m2 = await readMeta();
  push('两个标签落库', m2 && (m2.meta.tags || []).join(',') === '方法论,待核实', JSON.stringify(m2 && m2.meta.tags));
  push('标签区渲染出两个 chip', document.querySelectorAll('#nv-meta-tags .nv-meta-tag').length === 2);

  const x = document.querySelector('#nv-meta-tags .nv-meta-tag-x');
  if (x) x.click();
  await sleep(700);
  const m3 = await readMeta();
  push('删掉一个标签后只剩一个', m3 && (m3.meta.tags || []).join(',') === '待核实', JSON.stringify(m3 && m3.meta.tags));

  // ===== 5. 来源 =====
  stage = 'source';
  push('来源标签不是空的', (($('#nv-meta-source-label') || {}).textContent || '').length > 0,
    ($('#nv-meta-source-label') || {}).textContent);

  // ===== 6. 标题样式：设置里的倍率要真的改到预览 =====
  stage = 'heading';
  const h1 = $('#nv-preview h1');
  push('预览里渲染出 h1', !!h1);
  const sizeBefore = h1 ? parseFloat(getComputedStyle(h1).fontSize) : 0;
  $('#lib-settings').click();
  await waitFor(() => $('#settings-modal') && !$('#settings-modal').hidden, 6000);
  const range = $('#set-note-hscale');
  push('设置里有字号倍率滑杆', !!range);
  range.value = '1.5';
  range.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(250);
  const scaleVar = getComputedStyle(document.documentElement).getPropertyValue('--md-h-scale').trim();
  push('倍率写进 CSS 变量', Math.abs(parseFloat(scaleVar) - 1.5) < 0.001, scaleVar);
  const sizeAfter = h1 ? parseFloat(getComputedStyle(h1).fontSize) : 0;
  push('h1 实际字号变大', sizeAfter > sizeBefore * 1.2, sizeBefore + ' -> ' + sizeAfter);
  push('滑杆旁的数字跟着变', (($('#set-note-hscale-val') || {}).textContent || '').indexOf('1.50') >= 0,
    ($('#set-note-hscale-val') || {}).textContent);

  const weight = $('#set-note-hweight');
  weight.value = 'normal';
  weight.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(200);
  const wVar = getComputedStyle(document.documentElement).getPropertyValue('--md-h-weight').trim();
  push('字重写进 CSS 变量', wVar === '400', wVar);
  const h1Weight = h1 ? getComputedStyle(h1).fontWeight : '';
  push('h1 实际字重变常规', h1Weight === '400', h1Weight);

  // 关掉设置，别挡住后面的检查
  const setClose = $('#settings-close');
  if (setClose) setClose.click();
  await sleep(150);

  // ===== 7. 卡片标题自动链接 =====
  stage = 'autolink';
  md.value = '读到「自动链接测试句子」这句时应该自动亮起来。\\n\\n还有短句这种两三个字的不该亮。\\n\\n\\u0060自动链接测试句子\\u0060 在行内代码里也不该亮。';
  md.dispatchEvent(new InputEvent('input', { bubbles: true }));
  await sleep(600);
  const links = Array.from(document.querySelectorAll('#nv-preview .rv-autolink'));
  push('正文里出现卡片标题 → 自动变成链接', links.length === 1, links.length);
  push('链接文字就是那句摘录', links[0] && links[0].textContent === '自动链接测试句子', links[0] && links[0].textContent);
  push('链接指向那条标注', links[0] && links[0].getAttribute('data-rv-link') === 'lnk1', links[0] && links[0].getAttribute('data-rv-link'));
  push('行内代码里的同一句不被改', document.querySelectorAll('#nv-preview code .rv-autolink').length === 0);
  push('不到 4 个字的标题不参与', !Array.from(document.querySelectorAll('#nv-preview .rv-autolink')).some((n) => n.textContent === '短句'));

  // ===== 8. 重开编辑器后元数据还在（跨一次真实读盘） =====
  stage = 'reopen';
  $('#nv-back').click();
  await waitFor(() => $('#note-view').hidden, 8000);
  await sleep(500);
  const items = await window.pdfBridge.lib.summary();
  const hit = (items.items || []).find((it) => (it.notes || []).some((n) => (n.meta || {}).tags && n.meta.tags.length));
  push('库里能找到带标签的笔记', !!hit);
  if (hit) {
    LibraryUI.openNoteEditor(hit.key);
    await waitFor(() => !$('#note-view').hidden, 8000);
    await sleep(300);
    $('#nv-meta-toggle').click();
    await sleep(200);
    const st2 = ($('#nv-meta-status') || {}).value;
    push('重开后状态还在', st2 === 'draft', st2);
    const chips = Array.from(document.querySelectorAll('#nv-meta-tags .nv-meta-tag')).map((n) => n.textContent.replace('×', '').trim());
    push('重开后标签还在', chips.join(',') === '待核实', chips.join(','));
  }

  push('全程无脚本错误', errs.length === 0, errs.slice(0, 3).join(' | '));
  return { checks, stage };
  } catch (e) {
    push('探针异常：' + (e && e.message ? e.message : e), false);
    return { checks, stage, error: String(e && e.stack || e) };
  }
})()`;
