'use strict';
/*
 * 富文本笔记探针：新建笔记 → 写 Markdown → 切换预览 → 断言渲染结果 → 再切回编辑。
 * 被 test-markdown.js 调用。
 */
module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 8000)) { if (fn()) return true; await sleep(80); } return !!fn(); };

  try {
    const libReady = await waitFor(() => window.LibraryUI && LibraryUI.isOpen(), 10000);
    push('启动后文献库自动展开', libReady);
    push('渲染进程挂载 window.Md', !!(window.Md && window.Md.render));
    if (!libReady) return { checks, stage: 'startup' };

    // 新建独立笔记（复用 v9 的入口）
    $('#lib-new-note').click();
    await waitFor(() => $('#ld-notes [data-note-field="text"]'), 8000);
    const ta = $('#ld-notes [data-note-field="text"]');
    push('新建笔记后正文可编辑', !!ta, '');
    if (!ta) return { checks, stage: 'note' };

    const md = [
      '## 实验记录',
      '',
      '学习率 **3e-4** 最好，参见 [论文](https://example.org/paper)。',
      '',
      '| 参数 | 值 |',
      '|---|---|',
      '| lr | 3e-4 |',
      '',
      '- 跑三次取平均',
      '- 固定随机种子',
      '',
      '\`\`\`',
      'loss = 0.42',
      '\`\`\`',
    ].join('\\n');
    ta.value = md;
    ta.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(800);

    // 预览按钮出现 → 点击
    const pv = await waitFor(() => $('#ld-notes [data-note-preview]'), 6000)
      ? $('#ld-notes [data-note-preview]') : null;
    push('有内容后出现「预览」按钮', !!pv, pv ? pv.textContent : '');
    if (!pv) return { checks, stage: 'preview-btn' };
    pv.click();
    await sleep(250);

    const box = $('#ld-notes .ld-note-md');
    push('预览容器显示', !!box && !box.hidden, '');
    push('预览里渲染出二级标题', !!(box && box.querySelector('h2.md-h')), box ? box.innerHTML.slice(0, 60) : '');
    push('预览里渲染出表格', !!(box && box.querySelector('table.md-table')), '');
    push('预览里渲染出列表与代码块', !!(box && box.querySelector('.md-list')) && !!(box && box.querySelector('.md-pre')), '');
    push('预览里链接成了可点元素', !!(box && box.querySelector('[data-md-link="https://example.org/paper"]')), '');
    const taNow = $('#ld-notes .ld-note-text');
    push('编辑框切到隐藏', !!taNow && taNow.hidden, '');
    push('按钮变成「编辑」', pv.textContent === '编辑', pv.textContent);

    // 切回编辑
    pv.click();
    await sleep(150);
    const taBack = $('#ld-notes .ld-note-text');
    push('切回编辑态', !!taBack && !taBack.hidden && $('#ld-notes .ld-note-md').hidden, '');

    return { checks };
  } catch (e) {
    return { checks, fatal: String((e && e.stack) || e) };
  }
})()`;
