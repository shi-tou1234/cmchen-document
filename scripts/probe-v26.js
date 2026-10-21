module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 8000)) { if (fn()) return true; await sleep(60); } return !!fn(); };

  // ---------- 1. 顶部菜单栏（文件 / 视图 / 系统）没了 ----------
  let info = null;
  try { info = await window.pdfBridge.appInfo(); } catch (e) { info = { err: String(e && e.message || e) }; }
  push('原生菜单栏已移除', info && info.hasMenu === false, JSON.stringify(info));

  // ---------- 2. 标签页文档名使用统一无衬线字体（v27 字体统一） ----------
  const loaded = await waitFor(() => window.App && App.state.pdfDoc && App.state.rendered.get(1), 20000);
  push('夹具 PDF 已加载（探针前提）', loaded);
  const tab = document.querySelector('.tab .tab-title') || document.querySelector('.tab');
  if (tab) {
    const ff = getComputedStyle(tab).fontFamily || '';
    push('标签页标题使用统一无衬线栈', /Segoe UI/i.test(ff) && !/Georgia|Times New Roman/i.test(ff), ff);
  } else {
    push('标签页标题使用统一无衬线栈', false, 'no tab');
  }

  // ---------- 3. 设置面板里有「设为默认 PDF 阅读器」「开发者工具」 ----------
  const modal = document.getElementById('settings-modal');
  if (modal) {
    modal.hidden = false;
    await sleep(120);
    push('设置里有「设为默认 PDF 阅读器」', !!document.getElementById('set-default-pdf'));
    push('设置里有「开发者工具」', !!document.getElementById('set-devtools'));
    modal.hidden = true;
  } else {
    push('设置里有「设为默认 PDF 阅读器」', false, 'no modal');
  }

  // ---------- 4. 批注面板多了一个「全部」导出按钮 ----------
  const sb = document.getElementById('sidebar');
  if (sb && sb.hidden) { const btn = document.getElementById('btn-sidebar'); if (btn) btn.click(); }
  await sleep(150);
  const annoTab = document.querySelector('.sb-tab[data-tab="annos"]');
  if (annoTab) { annoTab.click(); await sleep(350); }
  const allBtn = document.querySelector('[data-note-fmt="all"]');
  push('批注面板有「全部」导出（汇总所有文档）', !!allBtn);

  // ---------- 5. 页面右键菜单里有「专注阅读模式」 ----------
  const el = window.App && App.pageEl ? App.pageEl(1) : null;
  if (el) {
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', {
      clientX: r.left + 40, clientY: r.top + 40, bubbles: true, cancelable: true,
    }));
    await sleep(250);
    const menu = document.querySelector('.ctx-menu');
    const txt = menu ? menu.textContent : '';
    push('页面右键菜单有「专注阅读模式」', /专注阅读模式/.test(txt), txt.slice(0, 80));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await sleep(120);
  } else {
    push('页面右键菜单有「专注阅读模式」', false, 'no page');
  }

  return { checks };
})()`;
