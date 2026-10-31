'use strict';
/*
 * 主文档加载与对照销毁的竞态回归（2026-10-29 第三轮审核 P2）
 *
 * 场景（审核清单第 1 项）：
 *   1. 打开 main.pdf（3 页）并挂上对照文献 other.pdf（5 页）；
 *   2. 打开 other.pdf 作为新的主文档，进入「销毁旧对照」的等待；
 *   3. 等待期间再打开 third.pdf（2 页）并让它加载完成；
 *   4. 释放 2 的等待 —— 旧调用恢复时不能再把已经显示的 third 换回 other，
 *      更不能把 third 所在标签的路径改成 other.pdf。
 *
 * 只在运行时延迟对照实例的第一次 destroy()（不改源码），用来稳定制造交叠窗口。
 * 断言同时覆盖「常规顺序切换仍然正常」，避免修过头。
 * 运行：node scripts/test-main-race.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { runProbe } = require('./probe-runner');

const ROOT = path.join(__dirname, '..');
const SAMPLE = path.join(ROOT, 'assets', 'sample.pdf');

async function makePdf(file, pages, label) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) {
    const page = doc.addPage([595, 842]);
    page.drawText(label + ' - PAGE ' + i, { x: 60, y: 760, size: 16, font });
  }
  fs.writeFileSync(file, await doc.save());
  return file;
}

let code = 0;
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfreader-mainrace-'));
  const ud = path.join(tmp, 'ud');
  fs.mkdirSync(ud);
  try {
    const mainPdf = path.join(tmp, 'main.pdf');
    fs.copyFileSync(SAMPLE, mainPdf);
    const otherPdf = await makePdf(path.join(tmp, 'other.pdf'), 5, 'OTHER DOCUMENT');
    const thirdPdf = await makePdf(path.join(tmp, 'third.pdf'), 2, 'THIRD DOCUMENT');

    const probe = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 10000)) { if (await fn()) return true; await sleep(60); } return !!(await fn()); };
  const base = (p) => String(p || '').split(/[\\\\/]/).pop();
  const openPath = async (p) => {
    const payload = await pdfBridge.openDocPath({ path: p });
    if (!payload || !payload.ok) throw new Error('打不开 ' + p + '：' + ((payload && payload.error) || ''));
    App.openDocument(payload);   // 不 await：调用方要自己控制交叠时序
    return payload;
  };

  // 主文档 A（3 页）
  await openPath(${JSON.stringify(mainPdf)});
  const a = await waitFor(() => App.state.rendered.get(1) && App.state.numPages === 3, 25000);
  push('主文档 A 加载完成（3 页）', a, App.state.numPages);
  if (!a) return { checks };

  // 挂上对照文献 other.pdf（5 页）
  App.setSplitView(true);
  await waitFor(() => !$('#ref-pane').hidden, 5000);
  const refOk = await App.loadRefDoc(${JSON.stringify(otherPdf)}, 'other.pdf', { page: 1 });
  const refLoaded = await waitFor(() => App.splitState().refPages === 5, 20000);
  push('对照文献 other.pdf 挂上（5 页）', refOk && refLoaded, JSON.stringify(App.splitState()));
  if (!refLoaded) return { checks };

  // 只延迟这个对照实例的第一次 destroy()，之后调用立即返回，避免把 C 也一起卡住
  const stalled = App.state.refDoc;
  let enterDestroy = false, releaseRef = null, destroyCalls = 0;
  const gate = new Promise((res) => { releaseRef = res; });
  const origDestroy = stalled.destroy.bind(stalled);
  stalled.destroy = () => {
    destroyCalls++;
    try { origDestroy(); } catch (_) {}
    if (destroyCalls === 1) { enterDestroy = true; return gate; }
    return Promise.resolve();
  };

  // 打开 B（other.pdf）作为新的主文档：它会先销毁 A，再销毁旧对照 —— 卡在第二步
  await openPath(${JSON.stringify(otherPdf)});
  const entered = await waitFor(() => enterDestroy, 20000);
  push('打开 B 时进入旧对照销毁等待', entered, destroyCalls);

  // 等待期间打开 C（third.pdf），并让它完整加载
  await openPath(${JSON.stringify(thirdPdf)});
  const c = await waitFor(() => base(App.state.filePath) === 'third.pdf' && App.state.rendered.get(1), 30000);
  push('C 在等待期间加载完成（2 页）', c && App.state.numPages === 2,
    JSON.stringify({ path: base(App.state.filePath), pages: App.state.numPages }));

  // 释放较早的销毁等待：B 那次加载恢复执行
  releaseRef();
  await sleep(1500);

  const shown = base(App.state.filePath);
  push('旧加载恢复后画面仍是 C', shown === 'third.pdf', shown);
  push('旧加载恢复后页数仍是 2', App.state.numPages === 2, App.state.numPages);

  const tab = App.tabs.find((t) => t.id === App.activeTabId);
  push('活动标签路径仍是 third.pdf', !!tab && base(tab.filePath) === 'third.pdf', tab && tab.filePath);
  push('活动标签仍指向 C 的第 1 页', !!tab && tab.page === 1, tab && tab.page);

  const sess = await pdfBridge.getSession();
  const tabsInSess = (sess && sess.tabs) || [];
  const rec = tabsInSess.find((t) => base(t.path) === 'third.pdf') || tabsInSess[0];
  push('会话里的活动文档是 third.pdf', !!rec && base(rec.path) === 'third.pdf', rec && rec.path);

  // 页面容器只能有 C 的 2 个页块：不能混进 B 的 3～5 页
  const pages = document.querySelectorAll('#pages .page');
  push('页面容器只有 C 的 2 个页块', pages.length === 2, pages.length);
  push('没有残留的 B 文档页块', !document.querySelector('#page-3'), document.querySelector('#page-3') ? 'page-3 存在' : '');
  push('文档标题是 third.pdf', String($('#file-name').textContent || '').includes('third'), $('#file-name').textContent);

  // 常规顺序切换不能被这次修复影响：重新打开 other.pdf 应正常变成 5 页
  await openPath(${JSON.stringify(otherPdf)});
  const back = await waitFor(() => base(App.state.filePath) === 'other.pdf' && App.state.numPages === 5 && App.state.rendered.get(1), 25000);
  push('顺序切换到 other.pdf 正常（5 页）', back, base(App.state.filePath) + ' / ' + App.state.numPages);
  const pages2 = document.querySelectorAll('#pages .page');
  push('顺序切换后页块数量正确', pages2.length === 5, pages2.length);

  // ===== 关闭最后一个标签时，在途的加载必须作废（R-v1.6d-03） =====
  // 场景：打开 B 卡在「销毁旧对照」的等待里 → 关掉最后一个标签 → 释放等待。
  // 旧行为：标签没了，B 的正文/页数/标题又冒出来；修好后 B 在下一个检查点自行退出。
  await openPath(${JSON.stringify(mainPdf)});
  await waitFor(() => base(App.state.filePath) === 'main.pdf' && App.state.numPages === 3 && App.state.rendered.get(1), 25000);
  App.setSplitView(true);
  await waitFor(() => !$('#ref-pane').hidden, 5000);
  await App.loadRefDoc(${JSON.stringify(otherPdf)}, 'other.pdf', { page: 1 });
  const refLoaded2 = await waitFor(() => App.splitState().refPages === 5, 20000);
  push('第二次挂对照文献成功', refLoaded2, JSON.stringify(App.splitState()));

  const stalled2 = App.state.refDoc;
  let release2 = null, calls2 = 0;
  const gate2 = new Promise((res) => { release2 = res; });
  const origDestroy2 = stalled2.destroy.bind(stalled2);
  stalled2.destroy = () => {
    calls2++;
    try { origDestroy2(); } catch (_) {}
    if (calls2 === 1) return gate2;
    return Promise.resolve();
  };

  await openPath(${JSON.stringify(otherPdf)});          // 打开 B，卡在销毁等待
  const entered2 = await waitFor(() => calls2 >= 1, 20000);
  push('第二次进入销毁等待', entered2, calls2);

  // 关掉最后一个标签（探针里此时只有这一个标签）
  App.closeTab(App.activeTabId);
  const closedAll = await waitFor(() => App.tabs.length === 0, 15000);
  push('标签全部关闭', closedAll, App.tabs.length);

  release2();
  await sleep(1500);
  push('关闭后没有文档重新出现', App.state.numPages === 0, App.state.numPages);
  push('关闭后文件路径是空的', !App.state.filePath, App.state.filePath);
  push('关闭后页面容器是空的', document.querySelectorAll('#pages .page').length === 0,
    document.querySelectorAll('#pages .page').length);
  push('关闭后标签数仍是 0', App.tabs.length === 0, App.tabs.length);

  return { checks };
})()`;

    const probeFile = path.join(tmp, 'probe.cjs');
    fs.writeFileSync(probeFile, 'module.exports=' + JSON.stringify(probe));
    const r = runProbe({
      probe: probeFile,
      env: { PDFREADER_LIBRARY: path.join(tmp, 'library.json'), PDFREADER_DATA_DIR: tmp, PDFREADER_NO_AUTO_INDEX: '1' },
      args: ['--user-data-dir=' + ud],
      label: 'main-race',
      timeout: 300000,
    });
    assert.equal(r.fail, 0);
    code = 0;
  } catch (e) {
    console.error('[main-race] ERROR', e && e.message ? e.message : e);
    code = 3;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(code);
})();
