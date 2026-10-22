'use strict';
/*
 * 笔记 Markdown 渲染探针（v9.6）：博客同款语法在实时预览里全部生效。
 * 覆盖：提示框 / 引用卡 / 剧透点击显示 / 彩虹 / 下划线 / 拼音 / 脚注跳转 /
 *       表格 / 任务列表 / 代码块 / 音乐与 GitHub 卡片 / 侧栏只读预览。
 * 被 test-note-richtext.js 调用。
 */
module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 8000)) { if (fn()) return true; await sleep(80); } return !!fn(); };

  const SAMPLE = [
    '## 渲染测试',
    '',
    ':::tip',
    '提示内容',
    ':::',
    '',
    ':::quote',
    '引用正文',
    '',
    '<right>—— 出处</right>',
    ':::',
    '',
    '++下划线++ 和 !!剧透文!! 和 ==彩虹文== 和 {注音}(zhù|yīn) 和 脚注[^1]',
    '',
    '| A | B |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '- [ ] 待办一',
    '- [x] 已完成',
    '',
    '\\u0060\\u0060\\u0060js',
    'const a = 1;',
    '\\u0060\\u0060\\u0060',
    '',
    '::github{repo="foo/bar"}',
    '',
    '::music{id="42"}',
    '',
    '[^1]: 脚注内容',
  ].join('\\n');

  try {
    const libReady = await waitFor(() => window.LibraryUI && LibraryUI.isOpen(), 10000);
    push('启动后文献库自动展开', libReady);
    push('渲染进程挂载 Md', !!(window.Md && window.Md.render && window.Md.fromHtml));
    if (!libReady) return { checks, stage: 'startup' };

    // 新建笔记 → 全屏编辑器 → 灌入示例
    $('#lib-new-note').click();
    push('新建笔记进全屏编辑器', await waitFor(() => !$('#note-view').hidden, 8000));
    const sum0 = await pdfBridge.lib.summary();
    const noteItem = (sum0.items || []).find((x) => x.itemType === 'note');
    const md = $('#nv-md');
    if (!noteItem || !md) return { checks, stage: 'create' };
    md.focus();
    md.value = SAMPLE;
    md.dispatchEvent(new InputEvent('input', { bubbles: true }));
    push('预览渲染出提示框', await waitFor(() => !!$('#nv-preview .admonition.tip'), 6000));
    push('提示框有标题和正文', ($('#nv-preview .tip .admonition-title') || {}).textContent === 'Tip'
      && ($('#nv-preview .tip .admonition-body') || {}).textContent.indexOf('提示内容') >= 0,
      ($('#nv-preview .tip .admonition-title') || {}).textContent);
    push('引用卡有出处对齐', !!$('#nv-preview .quote') && ($('#nv-preview .quote .q-right') || {}).textContent.indexOf('—— 出处') >= 0,
      ($('#nv-preview .quote') || {}).textContent);
    push('下划线 / 剧透 / 彩虹都渲染',
      !!$('#nv-preview .underline-text') && !!$('#nv-preview .spoiler') && !!$('#nv-preview .rainbow-text'),
      ($('#nv-preview .underline-text') || {}).textContent);
    push('剧透模糊可点击显示', !!$('#nv-preview .spoiler'), '');
    const sp = $('#nv-preview .spoiler');
    if (sp) { sp.click(); await sleep(150); push('点击剧透后 revealed', sp.classList.contains('revealed')); }
    push('拼音注音', !!$('#nv-preview ruby') && ($('#nv-preview ruby rt') || {}).textContent === 'zhù yīn',
      ($('#nv-preview ruby') || {}).textContent);
    push('脚注引用与文末定义', !!$('#nv-preview .md-fnref') && !!$('#nv-preview #fn-1')
      && ($('#nv-preview #fn-1') || {}).textContent.indexOf('脚注内容') >= 0, '');
    push('脚注点击滚动不报错', (() => { const f = $('#nv-preview .md-fnref'); if (f) f.click(); return true; })());
    push('表格渲染', !!$('#nv-preview .md-table') && ($('#nv-preview .md-table td') || {}).textContent === '1', '');
    push('任务列表复选框', $$('#nv-preview .md-task').length === 2
      && !!$('#nv-preview .md-task input[checked]'), $$('#nv-preview .md-task').length);
    push('代码块原样转义', ($('#nv-preview .md-pre code') || {}).textContent === 'const a = 1;', '');
    push('GitHub 卡片', !!$('#nv-preview .card-github')
      && (($('#nv-preview .card-github .gc-repo') || {}).textContent) === 'bar'
      && ($('#nv-preview .card-github') || {}).dataset.mdLink === 'https://github.com/foo/bar',
      ($('#nv-preview .card-github') || {}).dataset.mdLink);
    push('音乐卡片', !!$('#nv-preview .card-music')
      && (($('#nv-preview .card-music') || {}).dataset.mdLink || '').indexOf('music.163.com') >= 0,
      ($('#nv-preview .card-music') || {}).dataset.mdLink);

    // 落库 + 侧栏只读预览
    await sleep(1200);
    $('#nv-back').click();
    await sleep(900);
    const snap = await pdfBridge.lib.summary();
    const it = (snap.items || []).find((x) => x.key === noteItem.key);
    push('Markdown 源码落库（text 字段）', String(((it.notes || [])[0] || {}).text || '').indexOf(':::tip') >= 0, '');
    push('侧栏不再给独立笔记富文本编辑框', !$('#ld-notes .ld-note-rich'), '');
    LibraryUI.openDetail(noteItem.key);
    await sleep(400);
    push('侧栏显示只读 Markdown 预览', !!$('#ld-notes .ld-note-readonly')
      && !!$('#ld-notes .ld-note-readonly .admonition.tip'), '');
    push('侧栏有「去编辑器」按钮', !!$('#ld-notes [data-open-note-editor]'), '');
    LibraryUI.closeDetail();

    // 清理：删掉这条笔记，避免影响其它用例
    await pdfBridge.lib.trashItem(noteItem.key);

    return { checks };
  } catch (e) {
    return { checks, fatal: String((e && e.stack) || e) };
  }
})()`;
