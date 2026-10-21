module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 8000)) { if (fn()) return true; await sleep(60); } return !!fn(); };

  const loaded = await waitFor(() => window.App && App.state.pdfDoc && App.state.numPages >= 1, 15000);
  push('夹具 PDF 已加载（探针前提）', loaded, 'file=' + (window.App ? App.state.fileName : ''));
  if (!loaded) return { checks, stage: 'load' };

  // ---------- 1. 工具带常驻 ----------
  const tools = $$('#notetools .ntool');
  push('工具带常驻一排（≥9 个工具）', tools.length >= 9, 'n=' + tools.length);
  const want = ['select', 'image', 'pen', 'highlight', 'line', 'rect', 'arrow', 'text', 'note', 'eraser'];
  const have = tools.map((b) => b.dataset.tool);
  push('常用工具都在工具带上', want.every((w) => have.indexOf(w) >= 0), have.join(','));
  push('不再有「绘制 ▾」下拉', !$('#draw-btn') && !$('#draw-pop'), 'draw-btn=' + !!$('#draw-btn'));
  push('颜色/粗细直接摆在工具带上', !!$('#note-color') && !!$('#note-width'));

  // ---------- 2. 工具快捷键 ----------
  const key = (k) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  key('p'); await sleep(80);
  push('按 P 切到画笔', document.body.classList.contains('tool-pen'), document.body.className);
  key('h'); await sleep(80);
  push('按 H 切到荧光笔', document.body.classList.contains('tool-highlight'));
  key('v'); await sleep(80);
  push('按 V 切到看图', document.body.classList.contains('tool-image'));
  key('Escape'); await sleep(80);
  push('按 Esc 回到选择', document.body.classList.contains('tool-select'), document.body.className);
  // 点按钮也能切
  const rectBtn = $('#notetools .ntool[data-tool="rect"]');
  if (rectBtn) rectBtn.click();
  await sleep(80);
  push('点工具按钮即切换', document.body.classList.contains('tool-rect'), document.body.className);
  key('Escape'); await sleep(60);

  // ---------- 3. 导入时读 PDF 元数据 ----------
  const p = App.state.filePath;
  const added = await pdfBridge.lib.addPdf(p, { dedupe: true });
  const item = added && added.item;
  push('导入条目带上了 PDF 里的标题', !!(item && item.title && item.title.indexOf('自动识别的标题') >= 0),
    item ? item.title : JSON.stringify(added));
  push('导入条目带上了 PDF 里的作者', !!(item && (item.creators || []).length),
    item ? JSON.stringify(item.creators) : '');

  // ---------- 4. 文档快速切换 ----------
  let lastErr = '';
  window.addEventListener('error', (e) => { lastErr = String((e && e.message) || e); });
  push('DocSwitch 模块已加载', !!window.DocSwitch, 'type=' + typeof window.DocSwitch + ' err=' + lastErr);
  const fn = $('#file-name');
  push('文件名是可点的按钮', !!fn && fn.tagName === 'BUTTON', fn ? fn.tagName : 'null');
  if (fn) fn.click();
  await sleep(500);
  const panel = $('#doc-switch');
  push('点文件名打开切换面板', !!(panel && !panel.hidden), 'hidden=' + (panel ? panel.hidden : 'n/a'));
  const rows = $$('#doc-switch .dsw-row');
  push('面板里有可点的文档行', rows.length >= 1, 'rows=' + rows.length);
  const libRow = $$('#doc-switch .dsw-row').find((r) => r.dataset.kind === 'lib');
  push('面板列出了文献库条目', !!libRow, 'kind=' + (libRow ? libRow.dataset.kind : 'none'));
  // 搜索过滤
  const inp = $('#doc-switch .dsw-search');
  if (inp) {
    inp.value = '不存在的关键词zzz';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(150);
    push('面板能按关键词过滤', $$('#doc-switch .dsw-row').length === 0, 'rows=' + $$('#doc-switch .dsw-row').length);
    inp.value = '';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(150);
  }
  // 点库里的条目 → 直接打开，不用回库
  const row2 = $$('#doc-switch .dsw-row').find((r) => r.dataset.kind === 'lib');
  if (row2) {
    const nameBefore = App.state.fileName;
    row2.click();
    await sleep(1500);
    push('点条目直接打开（不经过文献库）', !!App.state.pdfDoc && document.getElementById('library').hidden,
      'file=' + App.state.fileName + ' (before=' + nameBefore + ')');
    push('切换面板已收起', $('#doc-switch').hidden);
  }

  return { checks };
})()`;
