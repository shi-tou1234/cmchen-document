module.exports = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const checks = [];
  const push = (n, ok, d) => checks.push([n, !!ok, d === undefined ? '' : String(d)]);
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 8000)) { if (fn()) return true; await sleep(60); } return !!fn(); };

  const loaded = await waitFor(() => window.App && App.state.pdfDoc && App.state.rendered.get(1), 20000);
  push('夹具 PDF 已加载（探针前提）', loaded);
  if (!loaded) return { checks, stage: 'load' };

  // 定位夹具里的内嵌位图（新行为：看图模式只认位图，必须拿它的矩形来点）
  const p1 = await App.state.pdfDoc.getPage(1);
  const imgs = await PdfImages.collect(p1);
  push('夹具 PDF 里有内嵌位图（探针前提）', imgs.length > 0, 'count=' + imgs.length);
  if (!imgs.length) return { checks, stage: 'images' };
  const rect = imgs[0];

  const el = App.pageEl(1);
  const r = el.getBoundingClientRect();
  const s = App.state.scale || 1;
  const clickAt = (ux, uy) => el.dispatchEvent(new MouseEvent('click', {
    clientX: r.left + ux * s, clientY: r.top + uy * s, bubbles: true, cancelable: true,
  }));
  const imgCx = rect.x + rect.w / 2, imgCy = rect.y + rect.h / 2;

  // 找一个确定不在任何位图里的角落点（点空白用的）
  let blank = { x: 12, y: 12 };
  for (const cand of [{ x: 12, y: 12 }, { x: 588, y: 12 }, { x: 12, y: 780 }, { x: 588, y: 780 }]) {
    if (!PdfImages.findAt(imgs, cand.x, cand.y)) { blank = cand; break; }
  }
  push('找到了不在位图里的空白点', !PdfImages.findAt(imgs, blank.x, blank.y), blank.x + ',' + blank.y);

  const selBtn = document.querySelector('.ntool[data-tool="select"]');
  const imgBtn = document.querySelector('.ntool[data-tool="image"]');

  // ================= 1. 阅读模式绝不弹灯箱 =================
  if (selBtn) selBtn.click();
  await sleep(120);
  push('当前是阅读模式（select）', document.body.classList.contains('tool-select'));
  clickAt(imgCx, imgCy);
  await sleep(2000);   // 抽图是异步的，给足时间：如果竞态没堵住，灯箱这时已经弹出来了
  push('阅读模式点图片不弹灯箱', window.Lightbox ? !Lightbox.isOpen() : true,
    'isOpen=' + (window.Lightbox ? Lightbox.isOpen() : 'n/a'));

  // ================= 2. 看图模式点图片 → 灯箱原图（原样，不被反色波及） =================
  document.body.classList.add('theme-dark', 'invert-pages');
  await sleep(150);
  const pageCanvas = document.querySelector('.page canvas');
  push('页面已反色（模式本身没被破坏）', pageCanvas ? /invert/.test(getComputedStyle(pageCanvas).filter) : false,
    pageCanvas ? getComputedStyle(pageCanvas).filter : 'no canvas');

  if (imgBtn) imgBtn.click();
  await sleep(120);
  push('已进入看图模式', document.body.classList.contains('tool-image'));
  clickAt(imgCx, imgCy);
  const opened = await waitFor(() => window.Lightbox && Lightbox.isOpen(), 12000);
  push('看图模式点图片打开灯箱', opened);
  const pv = document.querySelector('#pdf-image-lightbox .lb-preview');
  if (pv) {
    const cs = getComputedStyle(pv);
    // 2026-10-21 定稿：反色默认跟随「深色反色页面」，◐ 按钮一键切回原色
    push('灯箱默认跟随页面反色（夜里不刺眼）', /invert/.test(cs.filter || ''), cs.filter || '(none)');
    const invBtn = document.querySelector('#pdf-image-lightbox [data-lb-invert]');
    if (invBtn) {
      invBtn.click();
      await sleep(120);
      push('◐ 一键切回原色（filter=none）', (getComputedStyle(pv).filter || 'none') === 'none', getComputedStyle(pv).filter);
      invBtn.click();
      await sleep(120);
      push('再点 ◐ 恢复反色', /invert/.test(getComputedStyle(pv).filter || ''), getComputedStyle(pv).filter);
    } else {
      push('◐ 一键切回原色（filter=none）', false, 'no invert button');
    }
    const bg = cs.backgroundColor || '';
    push('灯箱预览底色是纸白（不是透明）', bg === 'rgb(255, 255, 255)', bg);
  } else {
    push('灯箱默认跟随页面反色（夜里不刺眼）', false, 'no preview');
    push('◐ 一键切回原色（filter=none）', false, 'no preview');
    push('灯箱预览底色是纸白（不是透明）', false, 'no preview');
  }
  document.body.classList.remove('theme-dark', 'invert-pages');
  await sleep(100);

  // ================= 3. 关闭按钮两条路径都能关 =================
  if (!opened || !pv) return { checks, stage: 'lightbox' };

  const root = document.getElementById('pdf-image-lightbox');
  const closeBtn = root && root.querySelector('button[data-lb-close]');
  push('关闭按钮存在且 els 选中的是按钮（不是背景层）',
    !!closeBtn && closeBtn.getAttribute('aria-label') === '关闭',
    closeBtn ? closeBtn.getAttribute('aria-label') : '(no button)');

  const icon = closeBtn ? closeBtn.querySelector('svg') : null;
  push('关闭按钮里是 svg 图标', !!icon);
  if (icon) {
    icon.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const closedByIcon = await waitFor(() => !Lightbox.isOpen(), 4000);
    push('点 ✕ 图标能关闭灯箱', closedByIcon);
  }

  if (imgBtn) imgBtn.click();
  await sleep(100);
  clickAt(imgCx, imgCy);
  const reopened = await waitFor(() => Lightbox.isOpen(), 8000);
  push('灯箱能重新打开', reopened);
  if (reopened) {
    const btn2 = document.querySelector('#pdf-image-lightbox button[data-lb-close]');
    btn2.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const closedByBtn = await waitFor(() => !Lightbox.isOpen(), 4000);
    push('点按钮本体能关闭灯箱', closedByBtn);
  }

  // ================= 4. 看图模式点空白不再弹「局部放大」 =================
  if (imgBtn) imgBtn.click();
  await sleep(100);
  clickAt(blank.x, blank.y);
  await sleep(1500);
  push('看图模式点空白不弹灯箱（提示代替局部放大）', !Lightbox.isOpen(),
    'isOpen=' + (window.Lightbox ? Lightbox.isOpen() : 'n/a'));

  // ================= 5. 右键菜单同款「放大看这一块」任何模式可用 =================
  await App.openRegionLightbox(el, blank.x, blank.y);
  const regionOpened = await waitFor(() => Lightbox.isOpen(), 12000);
  push('「放大看这一块」能进灯箱', regionOpened);
  if (regionOpened) {
    const cap = document.querySelector('#pdf-image-lightbox .lb-caption');
    push('局部放大有说明文字', !!cap && /局部放大/.test(cap.textContent || ''), cap ? cap.textContent : 'null');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await sleep(200);
    push('Esc 能关闭局部放大灯箱', !Lightbox.isOpen());
  }

  // ================= 6. 重叠多层图自动合成（白板导出：底色层+笔迹层） =================
  if (App.scrollToPage) App.scrollToPage(2);
  const loaded2 = await waitFor(() => App.state.rendered.get(2), 15000);
  push('翻到第 2 页并渲染完成', loaded2);
  if (!loaded2) return { checks, stage: 'page2' };
  const el2 = App.pageEl(2);
  const p2 = await App.state.pdfDoc.getPage(2);
  const imgs2 = await PdfImages.collect(p2);
  push('第 2 页有两层叠加位图', imgs2.length === 2, 'count=' + imgs2.length);
  if (imgs2.length !== 2) return { checks, stage: 'layers' };
  if (imgBtn) imgBtn.click();
  await sleep(120);
  const r2 = el2.getBoundingClientRect();
  const s2 = App.state.scale || 1;
  const layer = imgs2[0];
  el2.dispatchEvent(new MouseEvent('click', {
    clientX: r2.left + (layer.x + layer.w / 2) * s2,
    clientY: r2.top + (layer.y + layer.h / 2) * s2,
    bubbles: true, cancelable: true,
  }));
  const opened2 = await waitFor(() => Lightbox.isOpen(), 12000);
  push('点叠加图打开灯箱', opened2);
  if (!opened2) return { checks, stage: 'layer-lightbox' };
  const cap2 = document.querySelector('#pdf-image-lightbox .lb-caption');
  const counter2 = document.querySelector('#pdf-image-lightbox .lb-counter');
  push('两层合成一条目（caption 标明已合成）', !!cap2 && /已合成/.test(cap2.textContent || ''), cap2 ? cap2.textContent : 'null');
  push('不再拆成 图1/图2（计数 1/1）', !!counter2 && /1\\s*\\/\\s*1/.test(counter2.textContent || ''), counter2 ? counter2.textContent : 'null');

  // 合成内容像不像：红方块应叠在蓝底上（PDF 夹具：底 #2a4d8f，笔迹中央红 #e62828）
  const pv2 = document.querySelector('#pdf-image-lightbox .lb-preview');
  try {
    const cw = pv2.width, ch = pv2.height;
    // 画布对应两层的 union 矩形（collect 返回的就是 scale=1 视口坐标，y 向下）
    const ux0 = Math.min(imgs2[0].x, imgs2[1].x), uy0 = Math.min(imgs2[0].y, imgs2[1].y);
    const uw = Math.max(imgs2[0].x + imgs2[0].w, imgs2[1].x + imgs2[1].w) - ux0;
    const uh = Math.max(imgs2[0].y + imgs2[0].h, imgs2[1].y + imgs2[1].h) - uy0;
    const toX = (ux) => Math.max(0, Math.min(cw - 1, Math.round((ux - ux0) / uw * (cw - 1))));
    const toY = (uy) => Math.max(0, Math.min(ch - 1, Math.round((uy - uy0) / uh * (ch - 1))));
    const ctx2 = pv2.getContext('2d');
    // 笔迹层是 100×100 的红方块画在 250×250：视口里方块 ≈ x 225..325, y 367..467，中心 (275, 417)
    const inkPx = ctx2.getImageData(toX(275), toY(417), 1, 1).data;    // 红方块中心
    const bgPx = ctx2.getImageData(toX(ux0 + uw * 0.06), toY(uy0 + uh * 0.06), 1, 1).data;   // 只有底色的角落
    const near = (d, r, g, b) => Math.abs(d[0] - r) < 45 && Math.abs(d[1] - g) < 45 && Math.abs(d[2] - b) < 45;
    push('合成图里能看到笔迹（中心≈红）', near(inkPx, 230, 40, 40), 'rgb=' + [inkPx[0], inkPx[1], inkPx[2]].join(','));
    push('合成图里能看到底色（角落≈蓝）', near(bgPx, 42, 77, 143), 'rgb=' + [bgPx[0], bgPx[1], bgPx[2]].join(','));
  } catch (e) {
    push('合成图里能看到笔迹（中心≈红）', false, String(e && e.message || e));
    push('合成图里能看到底色（角落≈蓝）', false, String(e && e.message || e));
  }
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await sleep(200);

  return { checks };
})()`;
