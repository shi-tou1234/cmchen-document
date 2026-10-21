module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 8000)) { if (fn()) return true; await sleep(60); } return !!fn(); };

  const loaded = await waitFor(() => window.App && App.state.pdfDoc && App.state.rendered.get(1), 20000);
  push('夹具 PDF 已加载（探针前提）', loaded);
  if (!loaded) return { checks, stage: 'load' };

  // ================= 1. 灯箱里的图是「原样」 =================
  // v28 起用户明确要求：灯箱不做任何处理（v27 的「跟着页面反色」会把
  // 深底白板图反成整张发白，已回退）。这里改为断言 filter=none。
  document.body.classList.add('theme-dark', 'invert-pages');
  await sleep(150);
  const pageCanvas = document.querySelector('.page canvas');
  const pageFilter = pageCanvas ? getComputedStyle(pageCanvas).filter : '';
  push('页面已反色', /invert/.test(pageFilter), pageFilter);

  // 打开灯箱（点内嵌位图中心 —— 2026-10-21 起看图模式只认位图，点空白不再弹灯箱）
  const el = App.pageEl(1);
  const r = el.getBoundingClientRect();
  const s = App.state.scale || 1;
  const p1 = await App.state.pdfDoc.getPage(1);
  const imgs1 = await PdfImages.collect(p1);
  if (!imgs1.length) { push('夹具 PDF 里有内嵌位图（探针前提）', false, 'count=0'); return { checks, stage: 'images' }; }
  const rect1 = imgs1[0];
  const toolBtn = document.querySelector('.ntool[data-tool="image"]');
  if (toolBtn) toolBtn.click();
  await sleep(120);
  el.dispatchEvent(new MouseEvent('click', {
    clientX: r.left + (rect1.x + rect1.w / 2) * s,
    clientY: r.top + (rect1.y + rect1.h / 2) * s,
    bubbles: true, cancelable: true,
  }));
  const opened = await waitFor(() => window.Lightbox && Lightbox.isOpen(), 12000);
  push('灯箱已打开', opened);
  const pv = document.querySelector('#pdf-image-lightbox .lb-preview');
  if (pv) {
    const cs = getComputedStyle(pv);
    // 2026-10-21 定稿：反色默认跟随「深色反色页面」，◐ 按钮一键切回原色
    push('灯箱默认跟随页面反色', /invert/.test(cs.filter || ''), cs.filter || '(none)');
    const invBtn = document.querySelector('#pdf-image-lightbox [data-lb-invert]');
    if (invBtn) {
      invBtn.click();
      await sleep(120);
      push('◐ 一键切回原色（filter=none）', (getComputedStyle(pv).filter || 'none') === 'none', getComputedStyle(pv).filter);
      invBtn.click();
      await sleep(120);
    }
    const bg = cs.backgroundColor || '';
    push('灯箱预览底色是纸白（不是透明）', bg === 'rgb(255, 255, 255)', bg);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await sleep(150);
  } else {
    push('灯箱默认跟随页面反色', false, 'no preview');
    push('灯箱预览底色是纸白（不是透明）', false, 'no preview');
  }
  document.body.classList.remove('theme-dark', 'invert-pages');
  await sleep(100);

  // ================= 2. 便签保存后还能点开改 =================
  Anno.setTool('note');
  await sleep(120);
  const pageEl = App.pageEl(1);
  const svg = pageEl.querySelector('svg.anno');
  if (!svg) return { checks, stage: 'svg' };
  const rect = pageEl.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;

  // 新建一个便签
  svg.dispatchEvent(new PointerEvent('pointerdown', {
    clientX: cx, clientY: cy, bubbles: true, cancelable: true, button: 0, pointerId: 1, isPrimary: true,
  }));
  await sleep(200);
  const ed = document.getElementById('text-editor');
  push('点页面能打开便签编辑器', !!ed && !ed.hidden);
  if (!ed) return { checks, stage: 'editor' };
  ed.value = '第一条便签';
  ed.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await sleep(250);
  const notes = () => (App.state.annos.get(1) || []).filter((x) => x.tool === 'note');
  push('回车后便签已保存', notes().length === 1, 'n=' + notes().length);

  // 再点那张便签 → 编辑器应该打开并带上原文
  const sh = notes()[0];
  if (sh) {
    const m = svg.getScreenCTM();
    const pt = new DOMPoint(sh.at.x + 4, sh.at.y + 4).matrixTransform(m);
    svg.dispatchEvent(new PointerEvent('pointerdown', {
      clientX: pt.x, clientY: pt.y, bubbles: true, cancelable: true, button: 0, pointerId: 2, isPrimary: true,
    }));
    await sleep(250);
    const ed2 = document.getElementById('text-editor');
    const opened2 = !!ed2 && !ed2.hidden;
    push('点便签能重新打开编辑器', opened2);
    push('编辑器里带的是原来的内容', opened2 && ed2.value === '第一条便签', opened2 ? ed2.value : '(no editor)');
    if (opened2) {
      ed2.value = '改过的便签';
      ed2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await sleep(250);
      push('回车后是「改」不是「再加一条」', notes().length === 1, 'n=' + notes().length);
      push('便签内容已更新', notes().length === 1 && notes()[0].text === '改过的便签',
        notes().length ? notes()[0].text : '(none)');
    }
  } else {
    push('点便签能重新打开编辑器', false, 'no note shape');
  }

  return { checks };
})()`;
