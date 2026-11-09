'use strict';
/*
 * 1.6.3「界面精简与帮助改进」回归（无头 Electron 探针）：
 *   1) 主栏收敛：阅读顶栏单行、笔记主栏 ≤10 且 31 种旧格式都还在、文献库主操作约 5–6 个；
 *   2) 收起仍可达：分组菜单能开、Esc 能关、帮助「在界面定位」自动展开父菜单并聚焦；
 *   3) 参数随场景：浏览时隐藏色板/粗细，绘制时出现，六色与分工具记忆不丢；
 *   4) 衔接修复：标注「更多」选完收起、筛选单入口保留两种查询能力、条件标签可单独移除；
 *   5) 帮助任务化、详情/设置分组、保存状态与空态三步。
 * 运行：node scripts/test-v163-ui.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runProbe } = require('./probe-runner');

let code = 0;
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-v163-'));
  const ud = path.join(tmp, 'ud');
  fs.mkdirSync(ud);
  fs.writeFileSync(path.join(tmp, 'library.json'), JSON.stringify({
    version: 3, collections: [], searches: [], items: [],
  }, null, 2));

  const probe = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const key = (k) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

  // ---------- 1. 分组底座与主栏密度 ----------
  push('分组菜单模块已加载', !!window.GroupMenus && typeof GroupMenus.reveal === 'function');
  push('阅读顶栏有页面排列按钮与导出分组', !!$('#btn-vm-scroll') && !!$('#btn-vm-page') && !!$('#btn-spread') && !!$('#tb-output-btn'));
  push('低频按钮搬进分组但 id 都还在',
    ['btn-spread', 'btn-rotate-left', 'btn-split', 'btn-reflow', 'btn-ruler', 'btn-print', 'btn-save', 'btn-archive', 'btn-refimport']
      .every((id) => !!document.getElementById(id)));
  const tb = $('#toolbar');
  // 等工具栏拿到真实宽度：did-finish-load 之后可能还要一两帧才完成布局，
  // 那时 clientWidth 是 0，下面的窄窗模拟会量成「怎么都放不下」。
  for (let i = 0; i < 80 && tb.clientWidth < 200; i++) await sleep(50);
  const h1180 = tb.getBoundingClientRect().height;
  push('1180px 下阅读顶栏不换行', h1180 < 50, '高度 ' + Math.round(h1180) + 'px');
  const tbBtns = $$('#toolbar > button').filter((b) => !b.hidden).length;
  push('阅读顶栏常驻按钮明显减少', tbBtns <= 14, tbBtns + ' 个');

  // 窄窗口折叠：把 innerWidth 临时改小，触发 resize，看低频分组是否被搬进「⋯」
  // 两条边界都要对：能靠收起省出一行时才收；窄到收了也不够，就别多出这个「更多」。
  let overflowOk = false, overflowDetail = 'unsupported';
  let pointlessOk = false, pointlessDetail = 'unsupported';
  try {
    const desc = Object.getOwnPropertyDescriptor(window, 'innerWidth');
    const fake = (w) => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, get: () => w });
      window.dispatchEvent(new Event('resize'));
    };
    // 页面排列改成常驻小按钮后，能搬进「更多」的只剩导出这一组：
    // 只有「收起它刚好省出一行」的那一小段宽度才会出现更多按钮。
    fake(1105);
    overflowOk = !$('#tb-overflow-wrap').hidden &&
      $('#tb-output-wrap').parentElement === $('#tb-overflow-pop');
    const hNarrow = tb.getBoundingClientRect().height;
    push('窄窗口（1105px）下主栏仍单行', hNarrow < 50, '高度 ' + Math.round(hNarrow) + 'px');
    overflowDetail = 'output@' + $('#tb-output-wrap').parentElement.id;
    fake(900);
    const h900 = tb.getBoundingClientRect().height;
    push('900px 下主栏仍单行', h900 < 50, '高度 ' + Math.round(h900) + 'px');
    fake(760);
    pointlessOk = $('#tb-overflow-wrap').hidden &&
      $('#tb-output-wrap').parentElement === $('#toolbar');
    pointlessDetail = 'hidden=' + $('#tb-overflow-wrap').hidden + ' parent=' + $('#tb-output-wrap').parentElement.id;
    fake(1180);
    if (desc && desc.get) Object.defineProperty(window, 'innerWidth', desc);
    window.dispatchEvent(new Event('resize'));
  } catch (e) { overflowDetail = String(e && e.message); }
  push('窄窗口时导出收进「更多」', overflowOk, overflowDetail);
  push('收了也省不出一行时不多出「更多」', pointlessOk, pointlessDetail);
  push('宽窗口时分组回到主栏', $('#tb-output-wrap').parentElement === $('#toolbar') &&
    $('#tb-overflow-wrap').hidden);

  // 通用菜单行为：点开 / 点外部 / Esc
  $('#tb-output-btn').click();
  push('分组按钮能展开', !$('#tb-output-pop').hidden && $('#tb-output-btn').getAttribute('aria-expanded') === 'true');
  key('Escape');
  push('Esc 关闭分组菜单', $('#tb-output-pop').hidden);

  // ---------- 2. 笔记格式栏：主栏 ≤10，旧格式一个不删 ----------
  const nvMain = $$('#nv-toolbar > .toolbar-btn, #nv-toolbar > .dd-wrap').length;
  push('笔记主栏入口 ≤ 10', nvMain <= 10, nvMain + ' 个');
  const acts = $$('#nv-toolbar [data-action]').map((b) => b.dataset.action);
  push('31 种旧格式全部保留', new Set(acts).size === 31, new Set(acts).size + ' 种');
  push('公式仍有直达入口', !!$('#nv-formula-btn'));
  $('#nv-extra-btn').click();
  push('扩展格式菜单能打开', !$('#nv-extra-pop').hidden);
  push('扩展里能找到彩虹 / 拼音 / 音乐 / GH',
    ['rainbow', 'ruby', 'music-card', 'github-card'].every((a) => !!$('#nv-extra-pop [data-action="' + a + '"]')));
  key('Escape');

  // ---------- 3. 文献库主栏与筛选单入口 ----------
  const libMain = $$('.lib-head-actions > .dd-wrap, .lib-head-actions > button')
    .filter((b) => !b.hidden && !['lib-undo', 'lib-redo', 'lib-help', 'lib-settings', 'lib-empty-trash'].includes(b.id)).length;
  push('文献库主操作 5–6 个', libMain >= 5 && libMain <= 7, libMain + ' 个');
  push('添加 / 输出 / 资料 / 更多分组都在',
    !!$('#lib-add-btn') && !!$('#lib-output-btn') && !!$('#lib-study-btn') && !!$('#lib-more-btn'));
  push('查重和综述草稿仍在「更多」里', !!$('#lib-more-pop #lib-dup') && !!$('#lib-more-pop #lib-review'));
  push('筛选只留一个入口', !!$('#lib-filter-btn') &&
    $('#lib-query-btn').closest('#lib-filter-pop') === $('#lib-filter-pop') &&
    $('#lib-adv-btn').closest('#lib-filter-pop') === $('#lib-filter-pop'));
  push('两种查询能力都还在', !!$('#lib-query-btn') && !!$('#lib-adv-btn') && !!$('#adv-modal'));

  // ---------- 4. 绘制参数按场景出现 ----------
  Anno.setTool('select');
  push('浏览状态收起绘制参数', $('#note-params').hidden);
  Anno.setTool('highlight');
  push('荧光笔显示六色点', !$('#note-params').hidden && $$('#note-swatches .sw').length === 6);
  push('荧光笔显示粗细', !$('#note-width-wrap').hidden);
  Anno.setTool('image');
  push('看图状态又收起', $('#note-params').hidden);
  Anno.setTool('pen');
  const red = Anno.state.color.toLowerCase();
  $$('#note-swatches .sw')[1].click();
  const green = Anno.state.color.toLowerCase();
  Anno.setTool('highlight');
  const backToHl = Anno.state.color.toLowerCase();
  Anno.setTool('pen');
  push('分工具记色仍生效', red === '#e53935' && green === '#a5d6a7' && Anno.state.color.toLowerCase() === green,
    [red, green, backToHl].join(' / '));
  Anno.setTool('select');

  // ---------- 5. 标注工具全部平铺，阅读界面不留「更多」 ----------
  push('标注栏没有「更多」按钮', !$('#more-btn') && !$('#more-pop'));
  const inlineShapes = ['line', 'rect', 'arrow', 'ellipse', 'triangle', 'smart', 'eraser']
    .filter((t) => $('#notetools .ntool[data-tool="' + t + '"]'));
  push('形状工具与一笔成型都在主栏', inlineShapes.length === 7, inlineShapes.join(','));
  push('印章按钮已从工具栏退役', !$('#notetools .ntool[data-tool="stamp"]'));
  $('#notetools .ntool[data-tool="rect"]').click();
  push('点形状按钮直接切工具', Anno.state.tool === 'rect', 'tool=' + Anno.state.tool);
  key('Escape');
  push('Esc 回到选择、标注不受影响', Anno.state.tool === 'select', 'tool=' + Anno.state.tool);
  Anno.setTool('select');

  // ---------- 6. 帮助定位：真的看得见（P101） ----------
  Help.openTopic('dup');
  const loc = $('#help-article [data-locate="#lib-dup"]');
  push('查重一节有定位按钮', !!loc);
  if (loc) { loc.click(); await sleep(480); }
  push('定位会切到文献库', $('#help-modal').hidden && !$('#library').hidden);
  push('定位展开了「更多」菜单', !$('#lib-more-pop').hidden, 'pop.hidden=' + $('#lib-more-pop').hidden);
  push('查重按钮现在真的可见', $('#lib-dup').getClientRects().length > 0 && !$('#lib-more-pop').hidden);
  push('焦点落在查重按钮', document.activeElement === $('#lib-dup'));
  push('目标闪了一下', $('#lib-dup').classList.contains('help-flash'));
  // 没打开文档时定位阅读控件：不再闪一个点不动的按钮，留在指南里说明
  Help.open('read-zoom');
  await sleep(80);
  const loc2 = $('#help-article [data-locate="#scale-select"]');
  if (loc2) { loc2.click(); await sleep(480); }
  push('无文档时定位阅读控件留在指南里说明', !$('#help-modal').hidden && !!$('#help-article .help-notice'),
    'open=' + !$('#help-modal').hidden + ' notice=' + !!$('#help-article .help-notice'));
  Help.close();

  // ---------- 7. 帮助首页与文章 ----------
  Help.goHome();
  push('首页 6 张任务卡', $$('#help-article .help-task-card').length === 6);
  push('首页有搜索框 / 全部功能 / 快捷键', !!$('#help-search') &&
    $('#help-article').textContent.indexOf('全部功能') >= 0 &&
    $('#help-article').textContent.indexOf('快捷键') >= 0);
  push('首页保留关键警示', $('#help-article').textContent.indexOf('备份不包含原文档') >= 0);
  Help.openTopic('quickstart');
  push('必要步骤一步不少（quickstart 3 步）', $$('#help-article > ol.help-steps > li').length === 3);
  push('细节按需展开', $$('#help-article details.help-more').length >= 1);
  Help.openTopic('read-views');
  push('多步任务整段显示、不再截断', $$('#help-article > ol.help-steps > li').length === 5);
  push('不再出现「还有 N 步」折叠', !/还有 \d+ 步/.test($('#help-article').textContent));
  push('有适用条件与完成后结果', !!$('#help-article > .help-need') && !!$('#help-article > .help-done'));
  Help.openTopic('backup');
  push('关键警示不折叠', !!$('#help-article > .help-limits'));
  Help.close();

  // ---------- 8. 详情 / 设置分组 ----------
  push('详情有 3 个分组页', $$('#ld-body .ld-pane[data-pane]').length === 3);
  const titleInput = $('#ld-title');
  titleInput.value = '未保存的草稿标题';
  $('#ld-tabs [data-pane-btn="cite"]').click();
  push('切到引用分组', $('#ld-body .ld-pane[data-pane="info"]').hidden && !$('#ld-body .ld-pane[data-pane="cite"]').hidden);
  $('#ld-tabs [data-pane-btn="info"]').click();
  push('切分组不丢未保存的值', titleInput.value === '未保存的草稿标题' && !titleInput.hidden);
  titleInput.value = '';
  push('设置分 4 类', $$('#set-tabs [data-set-pane]').length === 4);
  push('默认只显示「阅读与外观」', !$('#set-theme').closest('[data-pane]').hidden &&
    $('#set-citekey').closest('[data-pane]').hidden);

  // ---------- 9. 保存状态与文案 ----------
  push('状态栏有真实保存状态', !!$('#anno-save-state') && typeof App.setAnnoSaveState === 'function');
  App.setAnnoSaveState('saving');
  push('正在保存可见', /正在保存/.test($('#anno-save-state').textContent));
  App.setAnnoSaveState('error', '测试用失败');
  push('失败持续可见且能重试', $('#anno-save-state').dataset.retry === '1' && /重试/.test($('#anno-save-state').textContent));
  App.setAnnoSaveState('ok');
  push('成功后回到已保存', /已保存/.test($('#anno-save-state').textContent) && !$('#anno-save-state').dataset.retry);
  push('导出名称区分对象', /导出带标注 PDF/.test($('#btn-save').textContent) &&
    /导出可编辑批注包/.test($('#btn-archive').textContent) &&
    /备份文献库/.test($('#set-backup').textContent));
  push('空态是真三步、不承诺时长', $$('#empty-hint .empty-steps li').length === 3 &&
    $('#empty-hint').textContent.indexOf('五分钟') < 0);
  push('旧术语「绘制 ▾」已清掉', !/绘制 ▾/.test(document.body.textContent.slice(0, 20000)));

  return { checks };
})()`;

  try {
    const probeFile = path.join(tmp, 'probe.cjs');
    fs.writeFileSync(probeFile, 'module.exports=' + JSON.stringify(probe));
    const r = runProbe({
      probe: probeFile,
      env: {
        PDFREADER_DATA_DIR: tmp,
        PDFREADER_LIBRARY: path.join(tmp, 'library.json'),
        PDFREADER_NO_AUTO_INDEX: '1',
      },
      args: ['--user-data-dir=' + ud],
      label: 'v163-ui',
      timeout: 240000,
    });
    if (r.fail) code = 2;
  } catch (e) {
    console.error('[v163-ui] ERROR', e && e.message ? e.message : e);
    code = 3;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(code);
})();
