'use strict';
/*
 * 标注视图探针：在真实渲染进程里点一遍「标注」入口，检查列表 / 选中 / 打标签 / 导出排版。
 * 被 test-anno-items.js 调用。
 */
module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 6000)) { if (fn()) return true; await sleep(50); } return !!fn(); };

  await sleep(1200);
  const s0 = await pdfBridge.getSettings();
  const list = await pdfBridge.listAnnotations();
  push('标注 IPC 能读到标注', Array.isArray(list) && list.length === 1, JSON.stringify({ userData: s0.userData, list }));

  // 侧栏「标注」入口
  const annoBtn = $('[data-scope="annotations"]');
  push('侧栏有「标注」入口', !!annoBtn, annoBtn ? annoBtn.textContent : 'none');
  push('标注入口显示条数', annoBtn && /1/.test(annoBtn.textContent), annoBtn ? annoBtn.textContent : '');
  if (!annoBtn) return { checks };
  annoBtn.click();
  await waitFor(() => $('#lib-scope-title').textContent === '标注', 5000);
  await sleep(300);
  push('切到标注视图', $('#lib-scope-title').textContent === '标注', $('#lib-scope-title').textContent);
  push('计数显示「条标注」', /条标注/.test($('#lib-count').textContent), $('#lib-count').textContent);

  const rows = $$('#lib-grid .lib-anno');
  push('标注视图列出标注', rows.length === 1, 'rows=' + rows.length);
  const rowText = rows[0] ? rows[0].textContent : '';
  push('标注文字显示出来', rowText.indexOf('关键结论') >= 0, rowText.slice(0, 80));
  push('显示出处（文献名 · 页码）', rowText.indexOf('第 2 页') > 0, rowText.slice(0, 80));
  push('标注视图隐藏条目列头', $('#lib-main .lib-columns').hidden === true, '');

  // 选中 → 批量栏换成标注工具
  const cb = $('#lib-grid .lib-anno .lc-check input');
  if (cb) cb.click();
  await sleep(250);
  push('选中后出现标注批量工具', !!$('#lib-anno-tools') && !$('#lib-anno-tools').hidden, '');
  push('条目批量按钮在标注视图隐藏', $('#lib-bulk-trash').hidden === true, '');

  // 加标签
  const input = $('#lib-anno-tag-input');
  input.value = '方法';
  $('#lib-anno-tag-add').click();
  await sleep(600);
  const sum = await pdfBridge.lib.summary();
  // v8：标签存进标注对象层 annoMeta[id].tags（旧的 annoTags 位置上不再写）
  const annoId = Object.keys(sum.annoMeta || {})[0] || '';
  push('标签写进库数据（标注对象层）', !!(sum.annoMeta && sum.annoMeta[annoId]
    && (sum.annoMeta[annoId].tags || []).indexOf('方法') >= 0), JSON.stringify(sum.annoMeta));
  const tagText = ($('#lib-grid .lib-anno .lctag') || {}).textContent || '';
  push('卡片上出现标签', tagText.indexOf('方法') >= 0, tagText);

  // 导出 Markdown 的排版
  const md = window.LibraryUI.annoMarkdown([{ id: 'x', text: '关键结论', fileName: 'demo.pdf', page: 2 }]);
  push('标注导出为 Markdown 引用块', md.indexOf('> 关键结论') === 0 && md.indexOf('demo.pdf · 第 2 页') > 0, JSON.stringify(md));

  return { checks };
})()`;
