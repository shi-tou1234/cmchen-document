'use strict';
/*
 * 阅读器体验探针：朗读（协议层 / 按钮 / 状态机）与打印（dry-run IPC）。
 * 环境里不一定有语音引擎：speak 之后只断言「不抛错、状态机自洽」，不断言真的出声。
 * 被 test-reader-extras.js 调用。
 */
module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 8000)) { if (fn()) return true; await sleep(80); } return !!fn(); };

  try {
    // 0. 无文档时的行为
    push('工具栏有朗读按钮', !!$('#btn-speak'));
    push('工具栏有停止按钮', !!$('#btn-speak-stop'));
    push('工具栏有打印按钮', !!$('#btn-print'));
    push('停止按钮初始禁用', $('#btn-speak-stop').disabled, '');
    push('暴露 speakStatus', typeof App.speakStatus === 'function', typeof App.speakStatus);

    // 没有文档：朗读/打印都应该给出提示而不是抛错
    App.speakToggle();
    await sleep(200);
    push('无文档朗读不抛错', App.speakStatus() === 'idle', App.speakStatus());
    const pr0 = await pdfBridge.printFile('');
    push('无文档打印返回错误', pr0 && pr0.ok === false, JSON.stringify(pr0));

    // 1. 打开文档
    const libReady = await waitFor(() => window.LibraryUI && LibraryUI.isOpen(), 10000);
    push('启动后文献库自动展开', libReady);
    const add = await pdfBridge.lib.addPdf('__SAMPLE__', { dedupe: true });
    const res = await pdfBridge.lib.openItem(add.item.key, 1);
    LibraryUI.hide();
    window.__libOpen(res);
    const loaded = await waitFor(() => App.state.pdfDoc && App.state.rendered.get(1), 25000);
    push('文档加载到第 1 页', loaded);
    if (!loaded) return { checks, stage: 'load' };

    // 2. 打印（dry-run）
    const pr1 = await pdfBridge.printFile(App.state.filePath);
    push('打印 IPC 成功（dry-run）', !!(pr1 && pr1.ok && pr1.dry), JSON.stringify(pr1));
    App.printCurrent();
    await sleep(300);
    push('点打印按钮不抛错', true);

    // 3. 朗读：开始 → 状态机 → 停止
    const hasTts = ('speechSynthesis' in window) && typeof SpeechSynthesisUtterance === 'function';
    push('环境支持 speechSynthesis', hasTts, hasTts ? '' : '没有语音引擎会跳过实际朗读');
    if (hasTts) {
      await App.speakToggle();
      await sleep(400);
      const st = App.speakStatus();
      push('开始朗读后状态是 speaking 或已结束', st === 'speaking' || st === 'idle', st);
      if (st === 'speaking') {
        push('朗读中停止按钮可用', !$('#btn-speak-stop').disabled, '');
        await App.speakToggle();   // 第二次点击 = 暂停
        await sleep(200);
        push('再点一下进入 paused 或已结束', App.speakStatus() === 'paused' || App.speakStatus() === 'idle', App.speakStatus());
        if (App.speakStatus() === 'paused') {
          await App.speakToggle(); // 继续
          await sleep(200);
          push('暂停后再点恢复 speaking', App.speakStatus() === 'speaking', App.speakStatus());
        }
      }
      App.speakStop();
      await sleep(150);
      push('停止后回到 idle', App.speakStatus() === 'idle', App.speakStatus());
      push('停止后停止按钮禁用', $('#btn-speak-stop').disabled, '');
    }

    // 4. 关闭文档会停朗读（切到同一文件的另一个标签不会重新加载，测关闭这条真实路径）
    if (hasTts) {
      await App.speakToggle();
      await sleep(200);
      const before = App.speakStatus();
      App.closeDocument && App.closeDocument();
      await sleep(300);
      push('关闭文档后朗读停止', App.speakStatus() === 'idle', 'before=' + before + ' after=' + App.speakStatus());
    }

    return { checks };
  } catch (e) {
    return { checks, fatal: String((e && e.stack) || e) };
  }
})()`;
