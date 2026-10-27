'use strict';
/*
 * v35 朗读探针：跨页连续、句级高亮、暂停/恢复、位置记忆。
 * 用可注入的假语音驱动逐句推进，不依赖机器上有没有语音引擎。
 * 被 test-reader-speech.js 调用两次（第二次用同一 userData 验证跨启动记忆）。
 */
module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 10000)) { if (fn()) return true; await sleep(60); } return !!fn(); };
  const mode = '__MODE__';

  try {
    // 假语音驱动：speak 时把当前 utterance 暴露出来，由探针手动调用 __endSpeech 推进
    const calls = { speak: 0, cancel: 0, pause: 0, resume: 0 };
    let cur = null;
    App._setSpeechDriver({
      speak(u) { calls.speak++; cur = u; window.__curSpeech = u; window.__endSpeech = () => { const f = u.onend; u.onend = null; if (f) f(); }; },
      cancel() { calls.cancel++; cur = null; window.__endSpeech = null; },
      pause() { calls.pause++; },
      resume() { calls.resume++; },
    });

    await waitFor(() => window.LibraryUI && LibraryUI.isOpen(), 10000);
    const add = await pdfBridge.lib.addPdf('__PDF__', { dedupe: true });
    const res = await pdfBridge.lib.openItem(add.item.key, 1);
    LibraryUI.hide();
    window.__libOpen(res);
    const loaded = await waitFor(() => App.state.pdfDoc && App.state.rendered.get(1), 25000);
    push('测试 PDF 加载到第 1 页', loaded);
    if (!loaded) return { checks, stage: 'load' };
    await waitFor(() => $('#page-1 .textlayer span'), 8000);

    if (mode === 'first') {
      await App.speakToggle();
      await waitFor(() => App.speechState().status === 'speaking', 5000);
      let st = App.speechState();
      push('开始朗读后状态为 speaking', st.status === 'speaking', st.status);
      push('从第 1 页第 1 句开始', st.page === 1 && st.index === 0, st.page + '/' + st.index);
      push('第 1 页识别出 3 句', st.total === 3, st.total);
      push('第一句文本正确', /First sentence/.test(st.text), st.text);
      push('句级高亮已画出', st.highlighted > 0 && !!$('#page-1 .speech-hl'), st.highlighted);
      push('utterance 语言为 en-US', cur && cur.lang === 'en-US', cur && cur.lang);

      // 朗读中 H / U 标注当前句
      const beforeH = (App.state.annos.get(1) || []).length;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', bubbles: true, cancelable: true }));
      await sleep(250);
      const arrH = App.state.annos.get(1) || [];
      const lastH = arrH[arrH.length - 1];
      push('朗读中按 H 高亮当前句',
        arrH.length === beforeH + 1 && lastH && lastH.tool === 'mark' && /First sentence/.test(lastH.text || ''),
        lastH && lastH.text);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'u', bubbles: true, cancelable: true }));
      await sleep(250);
      const arrU = App.state.annos.get(1) || [];
      push('朗读中按 U 给当前句加下划线',
        arrU.some((sh) => sh && sh.kind === 'underline' && /First sentence/.test(sh.text || '')),
        arrU.filter((sh) => sh.kind === 'underline').length);

      // 旋转状态下换句：高亮必须按旋转后的文字框重新算
      App.rotateView(90);
      await sleep(200);
      window.__endSpeech();
      await waitFor(() => App.speechState().index === 1, 3000);
      st = App.speechState();
      push('读完一句自动进入第二句', st.index === 1 && /Second sentence/.test(st.text), st.index + ':' + st.text);
      push('高亮跟着换到第二句', st.highlighted > 0, st.highlighted);
      push('旋转 90° 时句级高亮仍能画出', !!$('#page-1 .speech-hl') && st.highlighted > 0, st.highlighted);
      App.rotateView(-90);
      await sleep(200);

      App.speakStop();
      await sleep(120);
      st = App.speechState();
      push('停止后回到 idle 且高亮清空', st.status === 'idle' && st.highlighted === 0, st.status + '/' + st.highlighted);
      push('停止调用语音驱动 cancel', calls.cancel >= 1, calls.cancel);

      // 同一页重新开始：应从记住的第 2 句续读
      await App.speakToggle();
      await waitFor(() => App.speechState().status === 'speaking', 5000);
      st = App.speechState();
      push('同页重新开始时从记住的句子续读', st.page === 1 && st.index === 1, st.page + '/' + st.index);
      App.speakStop();
      await sleep(120);
      return { checks };
    }

    // 第二次启动：localStorage 里的位置应还在
    await App.speakToggle();
    await waitFor(() => App.speechState().status === 'speaking', 6000);
    let st = App.speechState();
    push('跨启动恢复上次句序', st.page === 1 && st.index === 1, st.page + '/' + st.index);
    push('恢复后高亮仍在', st.highlighted > 0, st.highlighted);

    // 第 2 句 → 第 3 句 → 第 2 页为空 → 跳到第 3 页
    window.__endSpeech();
    await waitFor(() => App.speechState().index === 2, 3000);
    push('继续读到第 3 句', App.speechState().index === 2, App.speechState().index);
    window.__endSpeech();
    const jumped = await waitFor(() => App.speechState().page === 3, 8000);
    st = App.speechState();
    push('跨页跳过空白第 2 页到第 3 页', jumped && st.index === 0, st.page + '/' + st.index);
    push('第 3 页文本正确', /Last page/.test(st.text), st.text);
    push('正文当前页跟随到第 3 页', App.state.currentPage === 3, App.state.currentPage);
    push('高亮移动到第 3 页', !!$('#page-3 .speech-hl') && st.highlighted > 0, st.highlighted);
    const hl = $('#page-3 .speech-hl');
    push('高亮坐标是有效数值', hl && !Number.isNaN(parseFloat(hl.style.left)) && parseFloat(hl.style.width) > 0,
      hl && (hl.style.left + '/' + hl.style.width));

    // 暂停 / 恢复
    await App.speakToggle();
    await sleep(100);
    st = App.speechState();
    push('再点一次进入 paused', st.status === 'paused' && calls.pause >= 1, st.status + '/' + calls.pause);
    await App.speakToggle();
    await sleep(100);
    st = App.speechState();
    push('恢复后回到 speaking', st.status === 'speaking' && calls.resume >= 1, st.status + '/' + calls.resume);

    // 读到末尾：结束并清高亮
    window.__endSpeech();
    const ended = await waitFor(() => App.speechState().status === 'idle', 8000);
    st = App.speechState();
    push('读到文档末尾自动结束', ended && st.status === 'idle', st.status);
    push('结束后高亮清空', st.highlighted === 0, st.highlighted);

    return { checks };
  } catch (e) {
    return { checks, fatal: String((e && e.stack) || e) };
  }
})()`;
