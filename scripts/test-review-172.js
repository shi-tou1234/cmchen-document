'use strict';
/*
 * 1.7.0 复查问题回归（真实窗口尺寸）：
 *   01 窄窗「更多」里的子菜单要能打开、逐级 Esc、选完关闭整条链；
 *   02 帮助跨 860px 断点后，目录与正文同步（不出现「点左边」但左边没了）；
 *   03 定位要落到「能继续操作」的状态：印章 / 文字先切工具，无文档时留在指南解释；
 *   04 命令面板「快捷键速查」要真的打开帮助；
 *   05 640×400 下帮助与设置面板不超出视口，关闭按钮可见；
 *   06 悬停提示：按下即取消（含还没到点的），键盘聚焦也能看到。
 *
 * 与 test-v163-ui 的区别：这里用真实 BrowserWindow 尺寸（非最大化 + window.resizeTo），
 * 不再重写 innerWidth 来模拟。
 * 运行：node scripts/test-review-172.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runProbe } = require('./probe-runner');

const WITH_DOC = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const key = (k, opts) => document.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, opts || {})));
  const waitDoc = async () => { const t0 = Date.now(); while (Date.now() - t0 < 15000) { if (App.state.mode === 'pdf' && App.state.rendered.get(1)) return true; await sleep(100); } return false; };
  if (!await waitDoc()) return { checks: [['样本 PDF 已加载', false, 'timeout']] };
  await sleep(500);

  // ---------- 01 页面排列常驻、不再有下拉 ----------
  window.resizeTo(920, 780);
  await sleep(600);
  const ov = document.getElementById('tb-overflow-wrap');
  const ovPop = document.getElementById('tb-overflow-pop');
  const outPop = document.getElementById('tb-output-pop');
  const vis = (id) => { const b = document.getElementById(id); return !!b && b.getClientRects().length > 0; };
  push('顶栏已没有页面布局下拉', !document.getElementById('tb-view-btn') && !document.getElementById('tb-view-pop'));
  push('三个排列按钮常驻可见', ['btn-vm-scroll', 'btn-vm-page', 'btn-spread'].every(vis));
  push('分屏按钮也常驻可见', vis('btn-split'));
  document.getElementById('btn-vm-page').click();
  await sleep(250);
  push('点「单页」真的切换', App.state.viewMode === 'page' && document.getElementById('btn-vm-page').classList.contains('active'),
    'mode=' + App.state.viewMode);
  push('当前排列按钮 aria-pressed=true', document.getElementById('btn-vm-page').getAttribute('aria-pressed') === 'true');
  document.getElementById('btn-spread').click();
  await sleep(250);
  push('点「双页」切换并放出独立缩放', App.state.viewMode === 'spread' && vis('btn-spread-zoom'));
  document.getElementById('btn-vm-scroll').click();
  await sleep(250);
  push('回到连续滚动、独立缩放收起', App.state.viewMode === 'scroll' && document.getElementById('btn-spread-zoom').hidden);

  // 窄窗里导出仍在主栏（能搬的只有这一组，收起也省不出一行时就不多出「更多」）
  // 直接开导出菜单：展开、Esc 关闭这条基础链路要保持可用
  document.getElementById('tb-output-btn').click();
  await sleep(180);
  const outVisible = !outPop.hidden && outPop.getClientRects().length > 0;
  push('导出菜单能直接展开', outVisible, 'parent=' + document.getElementById('tb-output-wrap').parentElement.id);
  key('Escape');
  await sleep(150);
  push('Esc 关闭导出菜单', outPop.hidden);
  push('收不起一行时不多出无用的「更多」', ov.hidden, 'inner=' + innerWidth);

  // 连续缩放：不能出现「顶栏既显示『更多』、又还是两行」这种自相矛盾的状态
  const seq = [1180, 960, 940, 920, 900, 880, 920, 1180];
  const rowLog = [];
  let badWidth = 0;
  for (const w of seq) {
    window.resizeTo(w, 780);
    await sleep(320);
    const ovShown = !document.getElementById('tb-overflow-wrap').hidden;
    const h = document.getElementById('toolbar').getBoundingClientRect().height;
    rowLog.push(w + (ovShown ? '·更多' : '') + '/' + Math.round(h));
    if (ovShown && h > 55) badWidth = w;
  }
  push('连续缩放下「更多」只在能省出一行时出现', !badWidth,
    badWidth ? ('异常宽度 ' + badWidth + '（' + rowLog.join(' ') + '）') : rowLog.join(' '));

  // ---------- 01b 矮窗口：菜单不能画到屏幕外 ----------
  window.resizeTo(920, 400);
  await sleep(700);
  const ovShownShort = !document.getElementById('tb-overflow-wrap').hidden;
  if (ovShownShort) {
    document.getElementById('tb-overflow-btn').click();
    await sleep(150);
  }
  document.getElementById('tb-output-btn').click();
  await sleep(300);
  const shortPop = ovShownShort ? ovPop : outPop;
  const shortR = shortPop.getBoundingClientRect();
  push('920×400 菜单不越出视口底部', shortR.bottom <= innerHeight + 1,
    Math.round(shortR.bottom) + '/' + innerHeight + ' vp=' + innerWidth + 'x' + innerHeight);
  const lastItem = document.getElementById('btn-print');
  lastItem.focus();
  await sleep(180);
  const lastR = lastItem.getBoundingClientRect();
  push('920×400 末项完整可见', lastR.top >= 0 && lastR.bottom <= innerHeight + 1,
    Math.round(lastR.top) + '..' + Math.round(lastR.bottom));
  const hitLast = document.elementFromPoint(
    Math.round(lastR.left + lastR.width / 2), Math.round(lastR.top + lastR.height / 2));
  push('920×400 末项点得到', !!hitLast && (hitLast === lastItem || lastItem.contains(hitLast)),
    hitLast ? (hitLast.id || hitLast.tagName) : 'none');
  push('菜单不推动阅读界面', window.scrollY === 0, 'scrollY=' + window.scrollY);
  key('Escape');
  await sleep(150);
  if (ovShownShort) { key('Escape'); await sleep(120); }
  window.resizeTo(1180, 780);
  await sleep(600);
  push('回到宽窗后菜单限制被清掉', outPop.style.maxHeight === '',
    'maxH=' + outPop.style.maxHeight);

  // ---------- 02 帮助跨断点 ----------
  window.resizeTo(1180, 780);
  await sleep(500);
  Help.open();
  await sleep(250);
  const browseBtn = $('#help-article [data-home-link="browse"]');
  if (browseBtn) browseBtn.click();
  await sleep(300);
  const wideNav = $$('#help-nav .help-nav-item').length;
  const wideList = $$('.help-browse-all').length;
  push('宽窗「全部功能」左侧有目录', wideNav > 20, 'navItems=' + wideNav);
  // 手动多展开一组、收起默认组：缩窗再放宽要按这份集合还原，而不是只剩默认那组
  const openGroups = () => $$('#help-nav details.help-fold[open]').map((d) => d.dataset.group).join(',');
  const webSum = $('#help-nav details[data-group="web"] summary');
  const startSum = $('#help-nav details[data-group="start"] summary');
  if (webSum) webSum.click();
  await sleep(150);
  if (startSum) startSum.click();
  await sleep(250);
  push('目录能同时记住手动展开的组', openGroups() === 'web', 'open=' + openGroups());
  window.resizeTo(800, 700);
  await sleep(700);
  const narrowNavVisible = $('#help-nav').getClientRects().length > 0;
  const narrowList = $$('#help-article .help-browse-all .help-nav-item').length;
  const summaryText = $('#help-article .help-summary') ? $('#help-article .help-summary').textContent : '';
  push('缩窄后左侧目录收起（符合设计）', !narrowNavVisible);
  push('缩窄后正文补出全部主题', narrowList > 20, 'items=' + narrowList);
  push('缩窄后文案不再指向左边', summaryText.indexOf('左边') < 0, summaryText.slice(0, 40));
  window.resizeTo(1180, 780);
  await sleep(700);
  const backNavVisible = $('#help-nav').getClientRects().length > 0;
  const backList = $$('#help-article .help-browse-all').length;
  push('放宽后目录回来、正文折叠列表撤掉', backNavVisible && backList === 0, 'nav=' + backNavVisible + ' list=' + backList);
  push('缩窗再放宽后展开组仍保留', openGroups() === 'web', 'open=' + openGroups());
  // 仍能直接选主题
  const t = $('#help-nav .help-nav-item[data-topic]');
  if (t) { t.click(); await sleep(250); }
  push('断点来回后仍能直接选主题', !!$('#help-article .help-title') && !$('#help-modal').hidden);

  // 搜索中跨断点：结果正文不能被换回上一篇文章
  Help.open();
  await sleep(200);
  const si = document.getElementById('help-search');
  si.value = '导出';
  si.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(250);
  window.resizeTo(800, 700);
  await sleep(600);
  const hitsNarrow = document.querySelectorAll('#help-article .help-result-row').length;
  push('搜索中缩窄仍能看到结果', hitsNarrow > 0, 'rows=' + hitsNarrow);
  window.resizeTo(1180, 780);
  await sleep(500);

  // ---------- 04 命令面板 → 快捷键速查 ----------
  Help.close();
  await sleep(150);
  key('k', { ctrlKey: true });
  await sleep(250);
  const ci = document.getElementById('cmd-input');
  ci.value = '快捷键速查';
  ci.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(150);
  const row = $('#cmd-list .cmd-row');
  if (row) row.click();
  await sleep(500);
  const helpOpen = !document.getElementById('help-modal').hidden;
  const title = $('#help-article .help-title') ? $('#help-article .help-title').textContent : '';
  push('命令「快捷键速查」打开帮助', helpOpen, 'open=' + helpOpen);
  push('打开的是快捷键那一节', /快捷键/.test(title), title.slice(0, 24));

  // ---------- 03 定位前置条件 ----------
  Help.open('shapes');
  await sleep(300);
  const shapeLoc = $('#help-article [data-locate="#smart-hint"]');
  if (shapeLoc) shapeLoc.click();
  await sleep(800);
  const smartHint = document.getElementById('smart-hint');
  push('图形教程定位切到一笔成型', Anno.state.tool === 'smart', 'tool=' + Anno.state.tool);
  push('定位后提示条真的可见', !smartHint.hidden && smartHint.getClientRects().length > 0);
  push('定位把帮助关掉（用户能继续操作）', document.getElementById('help-modal').hidden);

  Help.open('text-note');
  await sleep(300);
  const textLoc = $('#help-article [data-locate="#text-editor"]');
  if (textLoc) textLoc.click();
  await sleep(800);
  push('文字定位先切到文字工具（不是闪隐藏编辑器）', Anno.state.tool === 'text', 'tool=' + Anno.state.tool);
  push('文字定位后文字编辑器仍隐藏（等用户点页面）', document.getElementById('text-editor') === null || document.getElementById('text-editor').hidden);
  Anno.setTool('select');

  // ---------- 06 悬停提示 ----------
  const pen = $('#notetools .ntool[data-tool="pen"]');
  const tip = document.getElementById('tip-layer');
  pen.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, clientX: 10, clientY: 10 }));
  await sleep(120);   // 还没到 300ms
  pen.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10 }));
  await sleep(500);
  push('按下后不会再补弹过期提示', !tip || tip.hidden, tip ? 'hidden=' + tip.hidden : 'no-layer');
  await sleep(700);
  // 先把焦点清掉，确保这次 focus 一定产生 focusin（否则同元素重复聚焦不触发）
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  await sleep(60);
  pen.focus();
  await sleep(250);
  const tipAfterFocus = document.getElementById('tip-layer');
  push('键盘聚焦也能看到提示', !!tipAfterFocus && !tipAfterFocus.hidden, tipAfterFocus ? tipAfterFocus.textContent : 'no-layer');
  pen.blur();
  await sleep(100);

  // ---------- 05 最小窗口下的面板 ----------
  window.resizeTo(640, 400);
  await sleep(800);
  Help.open('open-file');
  await sleep(400);
  const card = $('#help-modal .help-card').getBoundingClientRect();
  const x = document.getElementById('help-x').getBoundingClientRect();
  const foot = $('#help-modal .help-foot').getBoundingClientRect();
  const inside = (r) => r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight + 1 && r.right <= innerWidth + 1;
  push('640×400 帮助面板不越出视口', inside(card), Math.round(card.top) + '..' + Math.round(card.bottom) + ' / ' + innerHeight);
  push('640×400 关闭按钮完整可见', inside(x), Math.round(x.top) + '..' + Math.round(x.bottom));
  push('640×400 页脚可见', inside(foot), Math.round(foot.top) + '..' + Math.round(foot.bottom));
  const scroller = $('#help-article');
  push('正文区域可滚动', scroller.scrollHeight >= scroller.clientHeight);
  Help.close();
  await sleep(150);
  document.getElementById('settings-modal').hidden = false;
  await sleep(300);
  const sc = $('#settings-modal .modal-card').getBoundingClientRect();
  const scx = document.getElementById('settings-close').getBoundingClientRect();
  push('640×400 设置面板不越出视口', inside(sc), Math.round(sc.top) + '..' + Math.round(sc.bottom));
  push('640×400 设置关闭按钮可见', inside(scx));
  document.getElementById('settings-modal').hidden = true;

  return { checks };
})()`;

const NO_DOC = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const t0 = Date.now();
  while (Date.now() - t0 < 10000) { if (window.App && App.state && App.state.mode !== undefined) break; await sleep(100); }
  await sleep(700);

  Help.open('read-views');
  await sleep(300);
  const loc = $('#help-article [data-locate="#btn-vm-scroll"]');
  if (loc) loc.click();
  await sleep(500);
  const notice = $('#help-article .help-notice');
  push('空文档定位顶栏控件留在指南里解释', !document.getElementById('help-modal').hidden && !!notice,
    notice ? notice.textContent.slice(0, 30) : 'no-notice');
  push('解释里给出「先去完成它」', !!$('#help-article .help-notice [data-locate="#btn-open"]'));

  Help.open();
  await sleep(300);
  const cardGo = $('#help-article .help-task-go[data-locate="#sel-bar"]');
  if (cardGo) cardGo.click();
  await sleep(500);
  const homeNotice = $('#help-article .help-notice');
  push('首页任务卡的定位提示也能看见', !!homeNotice, homeNotice ? homeNotice.textContent.slice(0, 30) : 'no-notice');
  return { checks };
})()`;

let code = 0;
(function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trove-review172-'));
  const ud = path.join(tmp, 'ud');
  fs.mkdirSync(ud);
  // 非最大化 + 固定初始尺寸：探针才能用 window.resizeTo 改真实窗口大小
  fs.writeFileSync(path.join(ud, 'window-state.json'), JSON.stringify({
    width: 1180, height: 780, x: 120, y: 90, maximized: false,
  }));

  const probeA = path.join(tmp, 'probe-with-doc.js');
  fs.writeFileSync(probeA, 'module.exports = `' + WITH_DOC + '`;');
  const probeB = path.join(tmp, 'probe-no-doc.js');
  fs.writeFileSync(probeB, 'module.exports = `' + NO_DOC + '`;');

  const run = (label, probe, withPdf) => {
    const env = { PDFREADER_PROBE_VISIBLE: '1' };
    if (withPdf) env.PDFREADER_PROBE_PDF = path.join(__dirname, '..', 'assets', 'sample.pdf');
    console.log('--- ' + label + ' ---');
    try {
      const r = runProbe({
        probePath: probe, env, args: ['--user-data-dir=' + ud], timeout: 240000, label,
      });
      if (r.fail) code = 1;
    } catch (e) {
      code = 1;
      console.log('  FAIL ' + label + ' 抛错：' + ((e && e.message) || e));
    }
  };

  run('review-172 有文档', probeA, true);
  run('review-172 无文档', probeB, false);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  process.exit(code);
})();
