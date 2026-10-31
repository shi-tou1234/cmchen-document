module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const errs = [];
  window.addEventListener('error', (e) => errs.push(String(e.message || e.error)));
  const key = (k) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  const text = (s) => { const el = $(s); return el ? (el.textContent || '') : ''; };
  let stage = 'load';
  try {

  // ---- 1. 加载 ----
  push('help 模块已挂到 window', !!window.Help && typeof Help.open === 'function');
  push('指南数据已加载（≥70 节）', !!(window.HELP_GUIDE && Help.topics.length >= 70), Help.topics.length);
  push('版本号写进标题栏', text('#help-ver').trim() === 'v' + HELP_GUIDE.version, text('#help-ver'));

  // ---- 2. 从工具栏打开 ----
  stage = 'open';
  $('#btn-help').click();
  await sleep(150);
  push('工具栏问号能打开指南', !$('#help-modal').hidden);
  push('左侧目录条目数 = 节数', $$('#help-nav .help-nav-item').length === Help.topics.length,
    $$('#help-nav .help-nav-item').length + '/' + Help.topics.length);
  push('默认显示第一节', !!$('#help-article .help-title'));

  // ---- 3. 每一节都能渲染，且有步骤 / 摘要 ----
  stage = 'render-all';
  const bad = [];
  for (const t of Help.topics) {
    try {
      Help.openTopic(t.id);
      const title = $('#help-article .help-title');
      const steps = $$('#help-article .help-steps > li');
      const summary = $('#help-article .help-summary');
      if (!title || !title.textContent.trim()) bad.push(t.id + ':无标题');
      if (!summary || !summary.textContent.trim()) bad.push(t.id + ':无摘要');
      if (!steps.length) bad.push(t.id + ':无步骤');
    } catch (e) { bad.push(t.id + ':' + (e && e.message)); }
  }
  push('全部 ' + Help.topics.length + ' 节都能渲染（标题 + 摘要 + 步骤）', bad.length === 0, bad.join(' , '));

  // ---- 4. 搜索 ----
  stage = 'search';
  Help.openTopic('quickstart');
  const inp = $('#help-search');
  inp.value = '导出';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(60);
  const hits = $$('#help-nav .help-nav-item').length;
  push('搜索「导出」有结果', hits > 0, hits);
  inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await sleep(80);
  push('回车打开搜索结果', text('#help-article .help-kicker').indexOf('搜索') < 0, text('#help-article .help-kicker'));

  // 搜一个必然没有的词
  inp.value = 'zzzz-不存在的词';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(50);
  push('无结果时有提示', $('#help-nav').textContent.indexOf('没有匹配') >= 0 || $('#help-article').textContent.indexOf('没有匹配') >= 0);
  inp.value = '';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(30);

  // ---- 5. Esc 关闭 / F1 开关 ----
  stage = 'esc-f1';
  key('Escape');
  await sleep(60);
  push('Esc 关闭指南', $('#help-modal').hidden);
  key('F1');
  await sleep(80);
  push('F1 打开指南', !$('#help-modal').hidden);
  key('F1');
  await sleep(60);
  push('F1 再按一次关闭', $('#help-modal').hidden);

  // ---- 6. 在界面定位 ----
  stage = 'locate';
  Help.openTopic('read-zoom');
  await sleep(60);
  const loc = $('#help-article [data-locate]');
  push('有「在界面定位」按钮', !!loc, loc && loc.dataset.locate);
  if (loc) {
    loc.click();
    await sleep(420);
    const flashed = $('#scale-select').classList.contains('help-flash');
    push('定位会关掉指南并闪一下目标控件', $('#help-modal').hidden && flashed,
      'hidden=' + $('#help-modal').hidden + ' flash=' + flashed);
  }

  // ---- 7. 从说明直接打开功能（条件检索） ----
  stage = 'action';
  Help.openTopic('adv');
  await sleep(60);
  const run = $('#help-article [data-run]');
  push('条件检索一节有直达按钮', !!run && run.dataset.run === 'adv', run && run.dataset.run);
  if (run) {
    run.click();
    await sleep(900);
    push('直达按钮进入文献库并打开条件检索',
      !$('#library').hidden && !$('#adv-modal').hidden,
      'library=' + !$('#library').hidden + ' adv=' + !$('#adv-modal').hidden);
    // 收尾，别把弹窗留在页面上
    const c = $('#adv-cancel'); if (c) c.click();
    await sleep(120);
  }
  if (!$('#help-modal').hidden) key('Escape');

  // ---- 8. 其它入口 ----
  stage = 'entries';
  push('文献库有「? 帮助」按钮', !!$('#lib-help'));
  push('设置里有「使用指南…」按钮', !!$('#set-help'));
  push('空态有指南入口', !!$('#empty-help-btn'));


  // ---- 10. 记住上次看的那节 ----
  stage = 'remember';
  Help.openTopic('wikilink');
  key('Escape');
  await sleep(80);
  key('F1');
  await sleep(120);
  push('重开时回到上次看的那节', text('#help-article .help-title').indexOf('笔记互链') >= 0, text('#help-article .help-title'));
  key('Escape');
  await sleep(60);

  // ---- 11. 空态里的入口 ----
  stage = 'empty-state';
  const back = $('#lib-back');
  if (back) back.click();
  await sleep(260);
  push('空态可见（此时没有打开文档）', !$('#empty-hint').hidden || getComputedStyle($('#empty-hint')).display !== 'none');
  $('#empty-help-btn').click();
  await sleep(180);
  push('空态链接能打开指南', !$('#help-modal').hidden);
  key('Escape');
  await sleep(60);

  // ---- 12. 设置里打开指南（指南要压在设置上面） ----
  stage = 'from-settings';
  $('#btn-library').click();
  await sleep(220);
  window.LibraryUI.openSettings();
  await sleep(280);
  push('设置面板已打开', !$('#settings-modal').hidden);
  $('#set-help').click();
  await sleep(200);
  push('设置里「使用指南…」能打开指南', !$('#help-modal').hidden);
  push('指南压在设置上面（两个都在）', !$('#help-modal').hidden && !$('#settings-modal').hidden);
  key('Escape');
  await sleep(90);
  push('关掉指南后设置还在', $('#help-modal').hidden && !$('#settings-modal').hidden);
  $('#set-close').click();
  await sleep(150);

  // ---- 13. 定位文献库里的控件：先切回文献库再闪 ----
  stage = 'locate-lib';
  $('#lib-back').click();
  await sleep(240);
  Help.openTopic('lib-queue');
  await sleep(80);
  const locLib = $('#help-article [data-locate]');
  push('队列一节有可定位控件', !!locLib, locLib && locLib.dataset.locate);
  if (locLib) {
    locLib.click();
    await sleep(520);
    push('定位文献库控件会先切回文献库', $('#help-modal').hidden && !$('#library').hidden,
      'hidden=' + $('#help-modal').hidden + ' lib=' + !$('#library').hidden);
  }

  // ---- 9. 命令面板里有帮助命令 ----
  stage = 'palette';
  if (typeof window.openCmd === 'function') {
    window.openCmd();
    await sleep(120);
    // 面板空 query 时只显示前 14 条（新加命令会挤位置），所以像用户一样搜：
    // 这里验的是「搜得到、点了管用」，不是「它恰好排在首页」。
    const cmdInp = $('#cmd-input');
    cmdInp.value = '指南';
    cmdInp.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(160);
    const txt = text('#cmd-list');
    push('命令面板能搜到使用指南', txt.indexOf('使用指南') >= 0, txt.slice(0, 120));
    // 直接执行「使用指南」这条命令，确认 wiring 打通
    const row = $$('#cmd-list .cmd-row').find((b) => b.textContent.indexOf('使用指南') >= 0);
    if (row) {
      row.click();
      await sleep(220);
      push('命令面板能直接打开指南', !$('#help-modal').hidden);
      key('Escape');
      await sleep(60);
    } else {
      push('命令面板能直接打开指南', false, '找不到命令行');
    }
    if (typeof window.closeCmd === 'function') window.closeCmd();
    await sleep(60);
  } else {
    push('命令面板函数可调用', false, 'openCmd 不在全局');
  }

  push('交互过程无脚本错误', errs.length === 0, errs.join(' | '));
  return { checks };
  } catch (e) {
    return { fatal: stage + ': ' + ((e && e.message) || e), checks };
  }
})()`;
